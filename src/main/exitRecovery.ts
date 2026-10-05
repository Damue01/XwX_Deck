import { providerRequiresTrace } from './app/codexProtocolPolicy';
import { readCompatibleServiceModelCatalogCache } from './app/modelCatalog';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ClientBackupStore } from './trace/clientBackupStore';
import { resolveClientPaths } from './trace/clientConfig';
import { ClientConfigOrchestrator } from './trace/clientConfigOrchestrator';
import { ClientConfigWriter } from './trace/clientConfigWriter';
import { CodexConfigManager } from './trace/codexConfigManager';
import { CodexLocalProxyCoordinator } from './trace/codexLocalProxyCoordinator';
import {
  restoreClaudeDesktopConfiguration
} from './trace/claudeDesktopConfigManager';
import { restoreCodexPreferredDirectConfiguration } from './trace/codexPreferredDirect';
import { writeFileAtomic } from './shared/fsx';
import { finishExitRecoveryReport } from './app/exitRecoveryReport';
import { initLogger, log } from './shared/logger';
import {
  providerCodexId,
  providerDirectConnections
} from '../shared/providers';

interface GatewayRuntimeRecord {
  readonly pid: number;
  readonly gatewayPort: number;
  readonly controlPort: number;
}

export interface ExitRecoveryOptions {
  readonly userDataDir: string;
  readonly managerPid: number;
  readonly delayMs?: number;
  readonly recoveryId?: string;
  readonly terminateProcess?: (pid: number) => Promise<void>;
}

export interface ExitRecoveryResult {
  readonly restoredClients: readonly string[];
  readonly emergencyRestoredClients: readonly string[];
  readonly gatewayPid?: number;
  readonly gatewayStopped: boolean;
  readonly managerStopped: boolean;
}

export async function runExitRecovery(options: ExitRecoveryOptions): Promise<ExitRecoveryResult> {
  const terminateProcess = options.terminateProcess ?? terminateProcessByPid;
  const controlSnapshot = await snapshotGatewayControl(options.userDataDir);
  const runtimeFile = controlSnapshot.runtime.file;
  const runtime = parseRuntime(controlSnapshot.runtime.contents);
  const recoveryId = options.recoveryId?.trim() || randomUUID();
  const settings = await readSettings(options.userDataDir);
  const clientPaths = resolveClientPaths(process.env, undefined, {
    claudeConfigDir: settings.claudeConfigDir
  });
  const backup = new ClientBackupStore(options.userDataDir);
  const records = await backup.listAll();
  const writer = new ClientConfigWriter({ backup });
  const orchestrator = new ClientConfigOrchestrator(backup, writer, clientPaths, process.env);
  const restoredClients: string[] = [];
  const emergencyRestoredClients: string[] = [];
  const readyMarkerContents = await writeReadyMarker(options.userDataDir, recoveryId);
  if (options.delayMs && options.delayMs > 0) {
    const takeover = await waitForTakeover(options.userDataDir, options.managerPid, options.delayMs, recoveryId);
    if (takeover === 'cancelled') {
      await cleanupCancelledRecovery(options.userDataDir, options.managerPid, readyMarkerContents, recoveryId);
      return {
        restoredClients: [],
        emergencyRestoredClients: [],
        gatewayStopped: false,
        managerStopped: false
      };
    }
  }

  let recoveryError: unknown;
  let recoveryHadWarnings = false;
  let stopUnconfirmed = false;
  try {
    for (const record of records) {
      try {
        const restored = await writer.restore(record);
        if (restored.outcome === 'unresolved-local') {
          recoveryHadWarnings = true;
          log.warn(
            `[exit-recovery] ${record.client} still references the local Gateway after field-safe restore: `
            + restored.unresolvedLocalReferences.join(', ')
          );
        } else {
          for (const conflict of restored.conflicts) {
            log(`[exit-recovery] preserved external ${record.client} config change: ${conflict}`);
          }
          restoredClients.push(record.client);
        }
      } catch (error) {
        recoveryHadWarnings = true;
        log.warn(`[exit-recovery] field-safe ${record.client} restore failed: ${(error as Error).message}`);
      }
    }
    await new CodexLocalProxyCoordinator(options.userDataDir).restore().catch(error => {
      recoveryHadWarnings = true;
      log.warn(`[exit-recovery] Codex local-proxy restore failed: ${(error as Error).message}`);
    });
    await restoreClaudeDesktopConfiguration(options.userDataDir).catch(async error => {
      recoveryHadWarnings = true;
      log.warn(`[exit-recovery] field-safe Claude Desktop restore failed: ${(error as Error).message}`);
      throw error;
    });
    if (!await restorePreferredCodexDirect(options.userDataDir, settings)) recoveryHadWarnings = true;

    if (runtime) {
      const dependent = await clientsPointingAt(orchestrator, options.userDataDir, runtime.gatewayPort);
      if (dependent.length) {
        throw new Error(`退出恢复后仍有客户端依赖本地 Gateway：${dependent.join(', ')}`);
      }
    }
  } catch (error) {
    recoveryError = error;
    log.error(`[exit-recovery] configuration recovery failed; local Gateway retained: ${(error as Error).message}`);
  }
  if (recoveryError) {
    await finishExitRecoveryReport(options.userDataDir, options.managerPid, true, 'configuration').catch(() => undefined);
    throw recoveryError;
  }
  {
    try {
      if (runtime && await gatewayStillMatches(runtimeFile, runtime)) {
        await terminateProcess(runtime.pid);
      }
      await cleanupGatewayRuntime(options.userDataDir, controlSnapshot, readyMarkerContents, recoveryId);
      if (runtime && processAlive(runtime.pid)) {
        stopUnconfirmed = true;
      }
    } catch (error) {
      await finishExitRecoveryReport(options.userDataDir, options.managerPid, true, 'gateway-stop').catch(() => undefined);
      throw error;
    }
    await finishExitRecoveryReport(options.userDataDir, options.managerPid, !!recoveryError || recoveryHadWarnings || stopUnconfirmed,
      stopUnconfirmed ? 'gateway-stop' : 'configuration').catch(error => {
      log.warn(`[exit-recovery] could not save recovery outcome: ${(error as Error).message}`);
    });
    await terminateProcess(options.managerPid);
  }
  return {
    restoredClients,
    emergencyRestoredClients,
    gatewayPid: runtime?.pid,
    gatewayStopped: runtime ? !processAlive(runtime.pid) : true,
    managerStopped: !processAlive(options.managerPid)
  };
}

async function waitForTakeover(
  userDataDir: string,
  managerPid: number,
  timeoutMs: number,
  recoveryId: string
): Promise<'takeover' | 'cancelled'> {
  const marker = path.join(userDataDir, 'gateway', 'exit-recovery-now');
  const cancelMarker = path.join(userDataDir, 'gateway', 'exit-recovery-cancel');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processAlive(managerPid)) {
    const cancelId = await fs.promises.readFile(cancelMarker, 'utf8').then(value => value.trim(), () => '');
    if (cancelId === recoveryId) return 'cancelled';
    const markerId = await fs.promises.readFile(marker, 'utf8').then(value => value.trim(), () => '');
    if (markerId === recoveryId) break;
    await delay(100);
  }
  await removeFileIfUnchanged(marker, Buffer.from(`${recoveryId}\n`));
  return 'takeover';
}

async function cleanupCancelledRecovery(
  userDataDir: string,
  managerPid: number,
  readyMarkerContents: Buffer,
  recoveryId: string
): Promise<void> {
  const root = path.join(userDataDir, 'gateway');
  await Promise.all([
    removeFileIfUnchanged(path.join(root, 'exit-recovery.ready'), readyMarkerContents),
    removeFileIfUnchanged(path.join(root, 'exit-recovery-now'), Buffer.from(`${recoveryId}\n`)),
    removeFileIfUnchanged(path.join(root, 'exit-recovery-cancel'), Buffer.from(`${recoveryId}\n`))
  ]);
  await finishExitRecoveryReport(userDataDir, managerPid, false).catch(() => undefined);
}

async function writeReadyMarker(userDataDir: string, recoveryId: string): Promise<Buffer> {
  const marker = path.join(userDataDir, 'gateway', 'exit-recovery.ready');
  const contents = Buffer.from(`${JSON.stringify({ recoveryId, pid: process.pid })}\n`);
  await fs.promises.mkdir(path.dirname(marker), { recursive: true });
  await writeFileAtomic(marker, contents);
  return contents;
}

async function restorePreferredCodexDirect(
  userDataDir: string,
  settings: Awaited<ReturnType<typeof readSettings>>
): Promise<boolean> {
  return restoreCodexPreferredDirectConfiguration(userDataDir, settings).then(result => {
    for (const conflict of result.conflicts) {
      log(`[exit-recovery] preserved external ChatGPT direct configuration: ${conflict}`);
    }
    return true;
  }).catch(error => {
    log.warn(`[exit-recovery] preferred direct Codex configuration restore failed: ${(error as Error).message}`);
    return false;
  });
}

async function clientsPointingAt(
  orchestrator: ClientConfigOrchestrator,
  userDataDir: string,
  gatewayPort: number
): Promise<readonly string[]> {
  const localBaseUrl = `http://127.0.0.1:${gatewayPort}`;
  const dependent = [...orchestrator.clientsPointingAt(localBaseUrl)];
  if (!dependent.includes('codex-cli')
    && await new CodexConfigManager(userDataDir).referencesLocalGateway(localBaseUrl)) {
    dependent.push('codex-cli');
  }
  return dependent;
}

async function readRuntime(file: string): Promise<GatewayRuntimeRecord | undefined> {
  try {
    return parseRuntime(await fs.promises.readFile(file));
  } catch {
    return undefined;
  }
}

function parseRuntime(contents: Buffer | undefined): GatewayRuntimeRecord | undefined {
  if (!contents) return undefined;
  try {
    const value = JSON.parse(contents.toString('utf8')) as Partial<GatewayRuntimeRecord>;
    if (!Number.isInteger(value.pid)
      || !Number.isInteger(value.gatewayPort)
      || !Number.isInteger(value.controlPort)) return undefined;
    return value as GatewayRuntimeRecord;
  } catch {
    return undefined;
  }
}

/**
 * Decide whether `runtime.pid` may be terminated.
 *
 * Re-reading the runtime file only proves nobody cleaned it up; it says nothing
 * about whether that PID is still our helper. A stale runtime.json left behind
 * by a hard kill plus an OS-recycled PID would otherwise make us SIGKILL an
 * unrelated process. Two independent signals are accepted:
 *
 *  - one of the recorded ports is open, which only a live Gateway can do; or
 *  - the process started before the runtime file was written, which a process
 *    that later inherited the PID cannot have done.
 *
 * When neither can be established the PID is left alone.
 */
async function gatewayStillMatches(file: string, runtime: GatewayRuntimeRecord): Promise<boolean> {
  const current = await readRuntime(file);
  if (!current
    || current.pid !== runtime.pid
    || current.gatewayPort !== runtime.gatewayPort
    || current.controlPort !== runtime.controlPort) return false;
  // A PID nobody is using cannot be misidentified and terminating it is a
  // no-op, so the identity gate below only needs to protect live processes.
  if (!processAlive(runtime.pid)) return true;
  const [gatewayOpen, controlOpen] = await Promise.all([
    probeTcpPort(runtime.gatewayPort),
    probeTcpPort(runtime.controlPort)
  ]);
  if (gatewayOpen || controlOpen) return true;
  const startedBefore = await processStartedBefore(runtime.pid, file);
  if (startedBefore === undefined) {
    log.warn(
      `[exit-recovery] cannot confirm pid ${runtime.pid} is the recorded Gateway `
      + '(ports closed, process start time unavailable); leaving it running'
    );
    return false;
  }
  if (!startedBefore) {
    log.warn(
      `[exit-recovery] pid ${runtime.pid} started after runtime.json was written; `
      + 'treating it as an unrelated process that inherited a recycled PID'
    );
  }
  return startedBefore;
}

/**
 * True when the process started before `file` was last written, false when it
 * started after, undefined when the platform cannot answer.
 */
async function processStartedBefore(pid: number, file: string): Promise<boolean | undefined> {
  const writtenAt = await fs.promises.stat(file).then(s => s.mtimeMs, () => undefined);
  if (writtenAt === undefined) return undefined;
  const startedAt = await processStartTimeMs(pid);
  if (startedAt === undefined) return undefined;
  // Clock granularity between the process table and the filesystem differs, so
  // allow a small window rather than demanding a strict ordering.
  return startedAt <= writtenAt + 2_000;
}

async function processStartTimeMs(pid: number): Promise<number | undefined> {
  const { execFile } = await import('child_process');
  const run = (command: string, args: readonly string[]): Promise<string | undefined> => (
    new Promise(resolve => {
      execFile(command, [...args], { timeout: 4_000, windowsHide: true }, (error, stdout) => {
        resolve(error ? undefined : stdout);
      });
    })
  );
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
    ]);
    const parsed = Date.parse((out ?? '').trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const out = await run('ps', ['-o', 'lstart=', '-p', String(pid)]);
    const parsed = Date.parse((out ?? '').trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

async function probeTcpPort(port: number): Promise<boolean> {
  const net = await import('net');
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(150);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function readSettings(userDataDir: string): Promise<import('./trace/codexPreferredDirect').CodexPreferredDirectInput & { claudeConfigDir: string }> {
  try {
    const value = JSON.parse(await fs.promises.readFile(path.join(userDataDir, 'settings.json'), 'utf8')) as import('./app/settings').XwXDeckSettings;
    const provider = value.providers?.connections?.find(item => item.id === value.providers?.selected?.codex);
    const unified = value.codexEnhancements?.unifySessionHistory === true;
    const catalogFile = provider && provider.id !== 'initial-provider' && /^[a-zA-Z0-9_-]+$/.test(provider.id)
      && ['auto', 'compatible', 'responses', 'chat-completions', 'anthropic-messages'].includes(provider.adapter)
      ? 'provider-' + provider.id + '-' + provider.adapter + '-models.json' : 'compatible-model-catalog-cache.json';
    const baseUrl = provider?.baseUrl ?? value.compatible?.baseUrl ?? '';
    const bearerToken = provider?.bearerToken ?? value.compatible?.bearerToken ?? '';
    const catalog = await readCompatibleServiceModelCatalogCache(path.join(userDataDir, catalogFile), baseUrl, bearerToken, provider?.providerPreset ?? 'auto', true);
    return {
      claudeConfigDir: value.claudeConfigDir ?? '',
      providerAdapter: provider?.adapter,
      providerId: provider ? providerCodexId(provider, unified) : undefined,
      providerName: provider?.displayName,
      preserveOfficialLogin: value.codexEnhancements?.preserveOfficialLogin !== false,
      unifySessionHistory: unified,
      directProviders: providerDirectConnections(value.providers?.connections),
      requiresGateway: providerRequiresTrace(provider ?? value.compatible, provider?.codexModel || value.codexModels?.compatible || '', catalog),
      preferredMode: value.codexPreferredMode === 'official' || value.codexPreferredMode === 'compatible' ? value.codexPreferredMode : 'auto',
      officialModel: value.codexModels?.official ?? '',
      compatibleModel: provider?.codexModel || value.codexModels?.compatible || '',
      compatibleContextWindow: provider?.codexContextWindow ?? value.codexModels?.compatibleContextWindow ?? 0,
      compatibleBaseUrl: baseUrl, compatibleBearerToken: bearerToken
    };
  } catch {
    return { claudeConfigDir: '', preferredMode: 'auto', officialModel: '', compatibleModel: '', compatibleContextWindow: 0, compatibleBaseUrl: '', compatibleBearerToken: '' };
  }
}

interface FileSnapshot {
  readonly file: string;
  readonly contents?: Buffer;
}

interface GatewayControlSnapshot {
  readonly runtime: FileSnapshot;
  readonly token: FileSnapshot;
  readonly bootstrap: FileSnapshot;
}

async function snapshotGatewayControl(userDataDir: string): Promise<GatewayControlSnapshot> {
  const root = path.join(userDataDir, 'gateway');
  const snapshot = async (name: string): Promise<FileSnapshot> => {
    const file = path.join(root, name);
    return {
      file,
      contents: await fs.promises.readFile(file).catch(() => undefined)
    };
  };
  const [runtime, token, bootstrap] = await Promise.all([
    snapshot('runtime.json'),
    snapshot('control.token'),
    snapshot('bootstrap.json')
  ]);
  return { runtime, token, bootstrap };
}

async function cleanupGatewayRuntime(
  userDataDir: string,
  snapshot: GatewayControlSnapshot,
  readyMarkerContents: Buffer,
  recoveryId: string
): Promise<void> {
  const current = await Promise.all([
    fs.promises.readFile(snapshot.runtime.file).catch(() => undefined),
    fs.promises.readFile(snapshot.token.file).catch(() => undefined),
    fs.promises.readFile(snapshot.bootstrap.file).catch(() => undefined)
  ]);
  const controlWasReplaced = [snapshot.runtime, snapshot.token, snapshot.bootstrap]
    .some((original, index) => current[index] !== undefined
      && (original.contents === undefined || !current[index]!.equals(original.contents)));
  if (controlWasReplaced) {
    log.info('[exit-recovery] a newer Gateway generation replaced shared control state; preserving its files');
  } else {
    await Promise.all([
      removeSnapshotFile(snapshot.runtime),
      removeSnapshotFile(snapshot.token),
      removeSnapshotFile(snapshot.bootstrap)
    ]);
  }
  const root = path.join(userDataDir, 'gateway');
  await Promise.all([
    removeFileIfUnchanged(path.join(root, 'exit-recovery.ready'), readyMarkerContents),
    removeFileIfUnchanged(path.join(root, 'exit-recovery-now'), Buffer.from(`${recoveryId}\n`)),
    removeFileIfUnchanged(path.join(root, 'exit-recovery-cancel'), Buffer.from(`${recoveryId}\n`))
  ]);
}

async function removeSnapshotFile(snapshot: FileSnapshot): Promise<void> {
  if (!snapshot.contents) return;
  await removeFileIfUnchanged(snapshot.file, snapshot.contents);
}

async function removeFileIfUnchanged(file: string, expected: Buffer): Promise<void> {
  const current = await fs.promises.readFile(file).catch(() => undefined);
  if (!current?.equals(expected)) return;
  await fs.promises.rm(file, { force: true }).catch(() => undefined);
}

async function terminateProcessByPid(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !processAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  await waitForExit(pid, 750);
  if (!processAlive(pid)) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  await waitForExit(pid, 1_000);
}

function endpointUsesPort(value: string | undefined, gatewayPort: number): boolean {
  try {
    const url = new URL(value ?? '');
    return (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
      && Number(url.port) === gatewayPort;
  } catch {
    return false;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processAlive(pid)) await delay(50);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const userDataDir = process.env.XWX_EXIT_RECOVERY_USER_DATA;
  const managerPid = Number(process.env.XWX_EXIT_RECOVERY_MANAGER_PID);
  const delayMs = Number(process.env.XWX_EXIT_RECOVERY_DELAY_MS || '6000');
  const recoveryId = process.env.XWX_EXIT_RECOVERY_ID?.trim();
  if (!userDataDir || !Number.isInteger(managerPid) || managerPid <= 0 || !recoveryId) {
    process.exit(2);
    return;
  }
  initLogger(userDataDir);
  try {
    await runExitRecovery({ userDataDir, managerPid, delayMs, recoveryId });
    process.exit(0);
  } catch (error) {
    log.error(`[exit-recovery] fatal recovery failure: ${(error as Error).stack ?? (error as Error).message}`);
    process.exit(1);
  }
}

if (process.env.XWX_EXIT_RECOVERY === '1') {
  void main();
}
