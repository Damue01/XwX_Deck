import { isCodexUpstreamKind } from './trace/codexConversationPortability';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { writeFileAtomic } from './shared/fsx';
import { initLogger, log } from './shared/logger';
import { TapProxy } from './trace/tapProxy';
import { deleteLock, parseTapListenPorts, writeLock } from './trace/tapPortLock';
import { TraceStore } from './trace/traceStore';
import { GATEWAY_HELPER_BUILD_ID, GATEWAY_HELPER_PROTOCOL_VERSION } from './trace/gatewayProtocol';
import type { GatewayCapturedClient, GatewayTraceRetention } from './trace/gatewayProtocol';
import type { TapClientRoute, TapRoute, TapTraceSource } from './trace/types';
import { acquireTraceWriterLease } from './trace/traceWriterLease';
import { renderTapViewerHtml } from './trace/webview/viewerHtml';
import { assetPath } from './shared/assets';
import { loadModelsDevPricingCache, refreshModelsDevPricingCache } from './trace/modelsDevPricing';
import { MetadataInvalidationSubscriber } from './update/metadataInvalidationSubscriber';
import { metadataPushUrl } from './update/updateServer';

const userDataDir = requiredEnv('XwX_GATEWAY_USER_DATA');
const traceRoot = requiredEnv('XwX_GATEWAY_TRACE_ROOT');
const listenPorts = parseTapListenPorts(process.env.XwX_GATEWAY_LISTEN_PORTS);
const controlDir = path.join(userDataDir, 'gateway');
const tokenFile = path.join(controlDir, 'control.token');
const runtimeFile = path.join(controlDir, 'runtime.json');
const bootstrapFile = path.join(controlDir, 'bootstrap.json');
const portabilityFile = path.join(userDataDir, 'codex-portability', 'opaque-origins.json');

void run().catch(error => {
  console.error('[gateway-helper] fatal', error);
  process.exit(1);
});

async function run(): Promise<void> {
  initLogger(userDataDir);
  const pricingOptions = { userDataDir, bundledCachePath: assetPath('models-dev-pricing.json') };
  await loadModelsDevPricingCache(pricingOptions);
  const metadataUrl = metadataPushUrl();
  const metadataSubscriber = metadataUrl
    ? new MetadataInvalidationSubscriber(metadataUrl, async event => {
        if (!event.topics.includes('pricing')) return;
        const result = await refreshModelsDevPricingCache(pricingOptions);
        log(`[metadata] helper pricing ${result.status}: ${result.ruleCount} rules (${event.reason})`);
      }, { logger: log })
    : undefined;
  metadataSubscriber?.start();
  const token = (await fs.promises.readFile(tokenFile, 'utf8')).trim();
  if (!token) throw new Error('missing Gateway control token');
  const writerLease = await acquireTraceWriterLease(traceRoot);
  const bootstrap = await readBootstrap(bootstrapFile);
  let traceRetention = normalizeTraceRetention(bootstrap?.traceRetention);
  const store = new TraceStore(
    traceRoot,
    () => traceRetention.maxSessions,
    () => traceRetention.maxStorageBytes > 0 ? traceRetention.maxStorageBytes : undefined
  );
  const proxy = new TapProxy(store, listenPorts, portabilityFile);
  let generation = bootstrap?.generation ?? -1;
  let pricingModelIds = modelIdsFromRoutes(bootstrap?.routes ?? [], bootstrap?.clientRoutes ?? []);
  let stopping = false;
  const capturedClients = new Set<GatewayCapturedClient>();
  let retentionCleanupScheduled = false;

  const setRecordingEnabled = (enabled: boolean): void => {
    const changed = proxy.isRecordingEnabled() !== enabled;
    proxy.setRecordingEnabled(enabled);
    if (changed) capturedClients.clear();
  };

  const scheduleRetentionCleanup = (): void => {
    if (retentionCleanupScheduled) return;
    retentionCleanupScheduled = true;
    setImmediate(() => {
      retentionCleanupScheduled = false;
      void store.cleanup().catch(error => {
        log.warn(`[gateway-helper] Trace retention cleanup failed: ${(error as Error).message}`);
      });
    });
  };

  if (bootstrap) {
    if (bootstrap.recording) await store.assertIndexReadable();
    proxy.setRoutes(bootstrap.routes, bootstrap.fallbackBaseUrl, bootstrap.fallbackProxyUrl);
    proxy.setClientRoutes(bootstrap.clientRoutes);
    setRecordingEnabled(bootstrap.recording);
  }

  const snapshot = async (sessionId?: string) => {
    const sessions = await store.listSessions();
    const currentSessionId = sessionId ?? store.currentSessionIdValue() ?? sessions[0]?.id;
    return {
      active: proxy.isRecordingEnabled(),
      localBaseUrl: proxy.localBaseUrl(),
      rootPath: traceRoot,
      storage: await store.storageStats(),
      generatedAt: new Date().toISOString(),
      pricingModelIds,
      sessions,
      traces: [],
      currentSessionId
    };
  };
  proxy.setViewerHandler({
    html: async () => renderTapViewerHtml({ state: await snapshot(), mode: 'live' }),
    state: () => snapshot(),
    sessionTraces: async (id, page) => {
      const sessions = await store.listSessions();
      return sessions.some(session => session.id === id) ? store.readConversationPage(id, page) : undefined;
    },
    deleteSession: id => store.deleteSession(id)
  });
  store.onDidAppend(trace => {
    const capturedClient = capturedClientForSource(trace.source);
    if (capturedClient) capturedClients.add(capturedClient);
    proxy.broadcastTrace(trace);
  });

  const baseUrl = await proxy.start();
  const gatewayPort = Number(new URL(baseUrl).port);
  await deleteLock(traceRoot);
  await writeLock(traceRoot, gatewayPort);

  const control = http.createServer((req, res) => {
    void handleControl(req, res).catch(error => respond(res, 500, { error: (error as Error).message }));
  });
  const controlPort = await listenControl(control);
  await fs.promises.mkdir(controlDir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(runtimeFile, `${JSON.stringify({
    version: 1,
    helperProtocolVersion: GATEWAY_HELPER_PROTOCOL_VERSION,
    helperBuildId: GATEWAY_HELPER_BUILD_ID,
    pid: process.pid,
    gatewayPort,
    controlPort,
    traceRoot,
    startedAt: new Date().toISOString()
  })}\n`);
  await fs.promises.chmod(runtimeFile, 0o600).catch(() => undefined);
  log(`[gateway-helper] ready gateway=:${gatewayPort} control=:${controlPort}`);
  scheduleRetentionCleanup();

  const status = () => ({
    helperProtocolVersion: GATEWAY_HELPER_PROTOCOL_VERSION,
    helperBuildId: GATEWAY_HELPER_BUILD_ID,
    gatewayPort,
    activeRequests: proxy.activeRequestCount(),
    pendingContinuations: proxy.pendingContinuationCount(),
    recording: proxy.isRecordingEnabled(),
    generation,
    traceRetention,
    capturedClients: [...capturedClients].sort()
  });

  async function handleControl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${token}`) {
      respond(res, 401, { error: 'unauthorized' });
      return;
    }
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && pathname === '/control/status') {
      respond(res, 200, status());
      return;
    }
    if (req.method !== 'POST') {
      respond(res, 405, { error: 'method not allowed' });
      return;
    }
    const body = await readBody(req);
    if (pathname === '/control/configure') {
      const nextGeneration = integer(body.generation);
      if (nextGeneration >= generation) {
        if (body.recording === true) await store.assertIndexReadable();
        const nextRetention = normalizeTraceRetention(body.traceRetention);
        const retentionChanged = nextRetention.maxSessions !== traceRetention.maxSessions
          || nextRetention.maxStorageBytes !== traceRetention.maxStorageBytes;
        const nextRoutes = array<TapRoute>(body.routes);
        const nextClientRoutes = array<TapClientRoute>(body.clientRoutes);
        proxy.setRoutes(nextRoutes, string(body.fallbackBaseUrl), string(body.fallbackProxyUrl));
        proxy.setClientRoutes(nextClientRoutes);
        pricingModelIds = modelIdsFromRoutes(nextRoutes, nextClientRoutes);
        traceRetention = nextRetention;
        setRecordingEnabled(body.recording === true);
        generation = nextGeneration;
        if (retentionChanged) scheduleRetentionCleanup();
      }
      respond(res, 200, status());
      return;
    }
    if (pathname === '/control/prepare-shutdown') {
      const prepared = await proxy.prepareForShutdown({
        timeoutMs: optionalNumber(body.timeoutMs),
        quietPeriodMs: optionalNumber(body.quietPeriodMs)
      });
      respond(res, 200, { prepared, status: status() });
      return;
    }
    if (pathname === '/control/force-prepare-shutdown') {
      await proxy.forcePrepareForShutdown();
      respond(res, 200, { status: status() });
      return;
    }
    if (pathname === '/control/cancel-shutdown') {
      proxy.cancelPreparedShutdown();
      respond(res, 200, status());
      return;
    }
    if (pathname === '/control/abandon-continuations') {
      proxy.abandonCodexContinuations();
      respond(res, 200, status());
      return;
    }
    if (pathname === '/control/clear-history') {
      await store.clearAll();
      proxy.broadcastReset();
      respond(res, 200, {});
      return;
    }
    if (pathname === '/control/portability/mark-transition') {
      await proxy.markCodexProviderTransition(provider(body.source), provider(body.target));
      respond(res, 200, {});
      return;
    }
    if (pathname === '/control/portability/adopt') {
      respond(res, 200, { adopted: await proxy.adoptCodexProviderOnStartup(provider(body.target)) });
      return;
    }
    if (pathname === '/control/portability/repair') {
      respond(res, 200, await proxy.repairCodexHistoryForProvider(provider(body.target)));
      return;
    }
    if (pathname === '/control/portability/restore-legacy') {
      respond(res, 200, await proxy.restoreLegacyOfficialHistory());
      return;
    }
    if (pathname === '/control/stop') {
      respond(res, 200, {});
      if (!stopping) {
        stopping = true;
        setImmediate(() => void shutdown(0));
      }
      return;
    }
    respond(res, 404, { error: 'not found' });
  }

  async function shutdown(code: number): Promise<void> {
    metadataSubscriber?.stop();
    await new Promise<void>(resolve => control.close(() => resolve()));
    await proxy.stop().catch(() => undefined);
    await writerLease.release();
    await deleteLock(traceRoot);
    await fs.promises.rm(runtimeFile, { force: true }).catch(() => undefined);
    process.exit(code);
  }

  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));
}

function modelIdsFromRoutes(routes: readonly TapRoute[], clientRoutes: readonly TapClientRoute[]): string[] {
  const ids = new Set<string>();
  for (const route of routes) {
    if (route.modelId) ids.add(route.modelId);
  }
  for (const route of clientRoutes) {
    for (const id of Object.keys(route.modelProtocols ?? {})) ids.add(id);
    for (const id of Object.keys(route.modelMaxOutputTokens ?? {})) ids.add(id);
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function respond(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBootstrap(file: string): Promise<{
  generation: number;
  routes: TapRoute[];
  clientRoutes: TapClientRoute[];
  fallbackBaseUrl?: string;
  fallbackProxyUrl?: string;
  recording: boolean;
  traceRetention: GatewayTraceRetention;
} | undefined> {
  try {
    const body = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Record<string, unknown>;
    const generation = integer(body.generation);
    return {
      generation,
      routes: array<TapRoute>(body.routes),
      clientRoutes: array<TapClientRoute>(body.clientRoutes),
      fallbackBaseUrl: string(body.fallbackBaseUrl),
      fallbackProxyUrl: string(body.fallbackProxyUrl),
      recording: body.recording === true,
      traceRetention: normalizeTraceRetention(body.traceRetention)
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`[gateway-helper] ignored invalid bootstrap: ${(error as Error).message}`);
    }
    return undefined;
  } finally {
    await fs.promises.rm(file, { force: true }).catch(() => undefined);
  }
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.from(chunk);
    size += part.length;
    if (size > 4 * 1024 * 1024) throw new Error('control payload too large');
    chunks.push(part);
  }
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid control payload');
  return parsed as Record<string, unknown>;
}

function listenControl(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('control server has no TCP port'));
      else resolve(address.port);
    });
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return path.resolve(value);
}

function integer(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error('generation must be a non-negative integer');
  return value as number;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function array<T>(value: unknown): T[] {
  if (!Array.isArray(value)) throw new Error('route list must be an array');
  return value as T[];
}

function provider(value: unknown): 'official' | 'compatible' | `provider:${string}` {
  if (!isCodexUpstreamKind(value)) throw new Error('invalid provider');
  return value;
}

function normalizeTraceRetention(value: unknown): GatewayTraceRetention {
  void value;
  return { maxSessions: 0, maxStorageBytes: 0 };
}

function capturedClientForSource(source: TapTraceSource | undefined): GatewayCapturedClient | undefined {
  if (source === 'claude-cli' || source === 'claude-vscode') return 'claude-cli';
  if (source === 'codex-cli' || source === 'codex-vscode') return 'codex-cli';
  return undefined;
}
