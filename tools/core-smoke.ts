import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as nodeFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import Database from '../src/main/shared/sqlite';
import { writeFileAtomic } from '../src/main/shared/fsx';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { XwXDeckSettingsStore } from '../src/main/app/settings';
import {
  applicationResetRelaunchArgs,
  parseApplicationResetRequest,
  performApplicationRepair,
  performApplicationResetAtStartup
} from '../src/main/app/applicationReset';
import {
  CodexConversationDoctor,
  isPathInsideCodexHome
} from '../src/main/app/codexConversationDoctor';
import {
  CODEX_EXTENDED_CONTEXT_WINDOW,
  CODEX_STANDARD_LONG_CONTEXT_WINDOW,
  codexContextVariants
} from '../src/shared/codexContextVariants';
import { gatewayMenuActionMatches } from '../src/main/app/gatewayMenuAction';
import { XwXDeckController, __test as controllerTest } from '../src/main/app/xwxDeckController';
import { buildTrayQuitPrompt } from '../src/main/app/shutdownPrompt';
import { __test as chatGptLifecycleTest } from '../src/main/app/chatGptLifecycle';
import { runExitRecovery } from '../src/main/exitRecovery';
import {
  startupRegistrationMatches,
  waitForStartupRegistration
} from '../src/main/app/startupRegistration';
import { claudeCompatibleServiceModelEnv } from '../src/main/app/claudeModelPolicy';
import {
  isKnownNonConversationalModel,
  resolveCatalogCodexProtocol,
  resolveCompatibleServiceCodexProtocol
} from '../src/main/app/codexProtocolPolicy';
import {
  fetchCompatibleServiceModelCatalog,
  normalizeModelCatalog,
  readCompatibleServiceModelCatalogCache,
  writeCompatibleServiceModelCatalogCache,
  type ModelCatalogEntry
} from '../src/main/app/modelCatalog';
import { enrichModelCatalog } from '../src/main/app/modelCapabilities';
import { findOfficialModelRecord, OFFICIAL_MODEL_REGISTRY } from '../src/main/app/officialModelRegistry';
import {
  loadModelsDevPricingCache,
  modelsDevPricingCachePath,
  parseModelsDevPricingCatalog,
  refreshModelsDevPricingCache
} from '../src/main/trace/modelsDevPricing';
import { estimateCostUsd, findModelPrice, findModelPriceForUsage, isOffPeakAt, isShortOutput, resolvePriceTierIndex, setCatalogPriceRules } from '../src/main/trace/pricing';
import { ClientBackupStore } from '../src/main/trace/clientBackupStore';
import { ClientConfigOrchestrator } from '../src/main/trace/clientConfigOrchestrator';
import {
  baseUrlHasV1Suffix,
  detectCodexUpstream,
  resolveClientPaths
} from '../src/main/trace/clientConfig';
import { ClientConfigWriter } from '../src/main/trace/clientConfigWriter';
import { ClaudeConfigManager, claudeCompatibleServiceBaseUrl } from '../src/main/trace/claudeConfigManager';
import { CodexConfigManager, normalizeCompatibleServiceBaseUrl } from '../src/main/trace/codexConfigManager';
import { CodexHistoryManager } from '../src/main/trace/codexHistoryManager';
import { CodexOfficialAuthManager } from '../src/main/trace/codexOfficialAuthManager';
import { CodexModelCatalogManager } from '../src/main/trace/codexModelCatalogManager';
import { CodexThreadTitleReader } from '../src/main/trace/codexThreadTitles';
import {
  cleanupPortableUpdateFiles,
  replacePortableExecutable,
  restorePortableExecutable,
  safePortableCleanupPaths
} from '../src/main/update/portableUpdate';
import { normalizeReleaseNotes, releaseNotesFromManifest } from '../src/main/update/releaseNotes';
import { isVersionNewer, resolveManualMacRelease } from '../src/main/update/manualMacUpdate';
import { MetadataInvalidationSubscriber } from '../src/main/update/metadataInvalidationSubscriber';
import { TapProxy, __test as tapProxyTest } from '../src/main/trace/tapProxy';
import { buildCodexToolContext, chatCompletionToResponse, chatErrorToResponseError, chatSseToCompletion, errorAsResponsesSse, responseAsSse, responsesToChatCompletions } from '../src/main/trace/codexChatBridge';
import { resolveCompatibleServiceReasoningProfile } from '../src/main/trace/compatibleServiceReasoningProfiles';
import { findProbedModelCapability } from '../src/main/app/probedModelCapabilityRegistry';
import {
  AnthropicResponsesStream,
  anthropicMessageToResponse,
  decodeAnthropicThinkingEnvelope,
  encodeAnthropicThinkingEnvelope,
  responsesToAnthropicMessages
} from '../src/main/trace/codexAnthropicBridge';
import {
  buildRemoteCompactionResponse,
  buildStandaloneCompactionResponse,
  buildSyntheticCompactionRequest,
  compactionItemToChatText,
  decodeCompactionSummary,
  encodeCompactionSummary,
  isCompactionTriggerRequest,
  XwX_COMPACTION_SUMMARY_PREFIX
} from '../src/main/trace/codexCompaction';
import {
  codexUpstreamIdentity,
  CodexConversationPortability
} from '../src/main/trace/codexConversationPortability';
import { ResponsesContinuationStore } from '../src/main/trace/responsesContinuationStore';
import { snapshotFromJson, SSEReassembler } from '../src/main/trace/sseReassembler';
import { normalizeUsage, mergeUsage, contextWindowTokens, billableTotalTokens } from '../src/main/trace/normalizeUsage';
import {
  classifyAuxiliaryTrace,
  findRecentEditedPromptSession,
  findSessionByClientConversationKey,
  findSessionByPendingSubagentRoot,
  findSessionByRootHash,
  isCodexStructuredUtilityTrace
} from '../src/main/trace/sessionRouter';
import {
  extractAnthropicTitleRootHash,
  extractCodexThreadAncestry,
  extractFingerprint,
  subagentInvocations
} from '../src/main/trace/sessionBoundary';
import {
  LOCAL_COMMAND_CAVEAT_TAG,
  LOCAL_COMMAND_CAVEAT_TEXT
} from '../src/main/trace/clientSignatures';
import { TraceStore } from '../src/main/trace/traceStore';
import { parseTapListenPorts } from '../src/main/trace/tapPortLock';
import { selectSystemProxy } from '../src/main/trace/systemProxy';
import type { TapSessionSummary, TapTraceRecord } from '../src/main/trace/types';
import { renderTapViewerHtml } from '../src/main/trace/webview/viewerHtml';
import { detectProviderPreset, providerProfile } from '../src/shared/providerProfiles';
import {
  buildProviderModelUrlCandidates,
  PROVIDER_COMPATIBILITY_DIMENSIONS
} from '../src/main/app/providerDiscovery';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xwx_deck-smoke-'));
const completed: string[] = [];

assert.equal(parseTapListenPorts(undefined), undefined);
assert.equal(parseTapListenPorts(''), undefined);
assert.equal(parseTapListenPorts('   '), undefined,
  'a blank production override must use the fixed XwX Trace port range instead of becoming port 0');
assert.deepEqual(parseTapListenPorts('0'), [0], 'isolated smoke tests may explicitly request an OS-assigned port');
assert.deepEqual(parseTapListenPorts('44233, 44234'), [44233, 44234]);
assert.deepEqual(selectSystemProxy('DIRECT'), { kind: 'direct' });
assert.deepEqual(selectSystemProxy('PROXY 127.0.0.1:7897'), {
  kind: 'proxy',
  url: 'http://127.0.0.1:7897/'
});
assert.deepEqual(selectSystemProxy('HTTPS proxy.internal:8443; DIRECT'), {
  kind: 'proxy',
  url: 'https://proxy.internal:8443/'
});
assert.deepEqual(selectSystemProxy('SOCKS5 127.0.0.1:1080'), {
  kind: 'unsupported',
  rule: 'SOCKS5 127.0.0.1:1080'
});
assert.equal(gatewayMenuActionMatches('close', 'close'), true);
assert.equal(gatewayMenuActionMatches('close', 'open'), false,
  'a stale close item must never reopen the Gateway');
assert.equal(gatewayMenuActionMatches('open', undefined), false,
  'a stale open item must not start a now-hidden Gateway');
assert.deepEqual(
  [0, 1, 2, 3, 4, 5, 6].map(controllerTest.codexHistoryRetryDelayMs),
  [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000],
  'deferred history work must back off to ten minutes instead of logging every 30 seconds forever'
);
const idleTrayQuitPrompt = buildTrayQuitPrompt({
  activeRequests: 0,
  pendingContinuations: 0,
  chatGptMayBeRunning: true
});
assert.deepEqual(idleTrayQuitPrompt.buttons, ['取消', '确认']);
assert.equal(idleTrayQuitPrompt.defaultId, 0);
assert.equal(idleTrayQuitPrompt.message, 'ChatGPT 正在使用后台代理。');
assert.equal(idleTrayQuitPrompt.detail, '若对话无法继续，请重新打开 XwX Deck。');
const activeTrayQuitPrompt = buildTrayQuitPrompt({
  activeRequests: 2,
  pendingContinuations: 1,
  chatGptMayBeRunning: true
});
assert.equal(activeTrayQuitPrompt.message, '2 个请求进行中，1 个工具调用未完成。');
assert.equal(activeTrayQuitPrompt.detail, '退出会中断回复，并可能丢失工具结果。');
const requestOnlyTrayQuitPrompt = buildTrayQuitPrompt({
  activeRequests: 1,
  pendingContinuations: 0,
  chatGptMayBeRunning: false
});
assert.equal(requestOnlyTrayQuitPrompt.message, '1 个请求正在进行。');
assert.equal(requestOnlyTrayQuitPrompt.detail, '退出会中断正在生成的回复。');
const continuationOnlyTrayQuitPrompt = buildTrayQuitPrompt({
  activeRequests: 0,
  pendingContinuations: 2,
  chatGptMayBeRunning: false
});
assert.equal(continuationOnlyTrayQuitPrompt.message, '2 个工具调用尚未完成。');
assert.equal(continuationOnlyTrayQuitPrompt.detail, '退出可能丢失工具结果。');

try {
  await testApplicationReset();
  await testExitRecovery();
  await testSettings();
  await testCodexConversationDoctor();
  await testTraceDeletionTransactions();
  await testChatGptLifecycle();
  await testControllerColdStartTransactions();
  await testAtomicFileWriteRetries();
  await testCodexChatBridge();
  await testCodexAnthropicBridge();
  await testCodexConversationPortability();
  await testResponsesContinuationStore();
  await testCodexConversationPortabilityGateway();
  await testCodexGatewayTransitionMatrix();
  await testProxyShutdownDrain();
  await testResponsesSnapshotReassembly();
  await testCodexProtocolPolicy();

  await testClientTakeover();
  await testClientPreflight();
  await testCodexOfficialAndCustomTakeover();
  await testClaudeProviderSwitch();
  await testCodexProviderSwitch();
  await testCodexModelCatalogGateway();
  await testCodexOfficialAuthPolicy();
  await testCodexEnhancements();
  await testCodexHistoryMutationGate();
  await testCodexCustomHistoryProviders();
  await testModelCatalogMetadata();
  await testModelsDevPricing();
  await testMetadataPushInvalidation();

  await testProxyCapture();
  await testProxyPassthroughBackpressure();
  await testTraceIntegrityDoctor();
  await testSessionRouting();
  await testReleaseNotes();

  await testPortableUpdateReplacement();
  await testManagerIpcContract();
  await testViewerMessageContract();
  await testViewerDiffAlignment();
  await testUsageProtocolSemantics();
  await testViewerReadViewFidelity();
  await testClientPresentationParity();
  for (const name of completed) console.log(`PASS ${name}`);
  console.log(`PASS ${completed.length} core smoke tests`);
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

async function testExitRecovery(): Promise<void> {
  const base = path.join(root, 'exit-recovery');
  const userData = path.join(base, 'user-data');
  const paths = resolveClientPaths({}, path.join(base, 'home'));
  await fs.mkdir(path.dirname(paths.claudeSettingsPath), { recursive: true });
  await fs.mkdir(path.dirname(paths.codexConfigPath), { recursive: true });
  await fs.writeFile(paths.claudeSettingsPath, `${JSON.stringify({
    env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', KEEP: 'yes' }
  }, null, 2)}\n`);
  await fs.writeFile(paths.codexConfigPath, [
    'model_provider = "compatible"',
    '',
    '[model_providers.compatible]',
    'base_url = "https://compatible.example/v1"',
    ''
  ].join('\n'));
  const backup = new ClientBackupStore(userData);
  const orchestrator = new ClientConfigOrchestrator(
    backup,
    new ClientConfigWriter({ backup }),
    paths,
    {}
  );
  await orchestrator.apply('http://127.0.0.1:44995');
  const claudeLive = JSON.parse(await fs.readFile(paths.claudeSettingsPath, 'utf8'));
  claudeLive.env.ANTHROPIC_BASE_URL = 'http://localhost:44995';
  await fs.writeFile(paths.claudeSettingsPath, `${JSON.stringify(claudeLive, null, 2)}\n`);
  await fs.mkdir(path.join(userData, 'gateway'), { recursive: true });
  await fs.writeFile(path.join(userData, 'gateway', 'runtime.json'), JSON.stringify({
    version: 1,
    pid: 99101,
    gatewayPort: 44995,
    controlPort: 44996,
    traceRoot: path.join(userData, 'xwx-trace')
  }));
  const terminated: number[] = [];
  const previousClientHome = process.env.XWX_DECK_CLIENT_HOME;
  process.env.XWX_DECK_CLIENT_HOME = path.join(base, 'home');
  let result;
  try {
    result = await runExitRecovery({
      userDataDir: userData,
      managerPid: 99102,
      terminateProcess: async pid => { terminated.push(pid); }
    });
  } finally {
    if (previousClientHome === undefined) delete process.env.XWX_DECK_CLIENT_HOME;
    else process.env.XWX_DECK_CLIENT_HOME = previousClientHome;
  }
  assert.deepEqual(terminated, [99101, 99102]);
  assert.ok(result.emergencyRestoredClients.includes('claude'));
  assert.doesNotMatch(await fs.readFile(paths.claudeSettingsPath, 'utf8'), /localhost:44995|127\.0\.0\.1:44995/);
  assert.doesNotMatch(await fs.readFile(paths.codexConfigPath, 'utf8'), /localhost:44995|127\.0\.0\.1:44995/);
  await assert.rejects(fs.stat(path.join(userData, 'gateway', 'runtime.json')), /ENOENT/);
  completed.push('detached exit recovery restores clients before terminating Gateway and manager');
}

async function testApplicationReset(): Promise<void> {
  assert.deepEqual(parseApplicationResetRequest(['XwX Deck.exe', '--xwxdeck-reset=app']), {
    resetClientConfigs: false
  });
  assert.deepEqual(parseApplicationResetRequest(['XwX Deck.exe', '--xwxdeck-reset=clients']), {
    resetClientConfigs: true
  });
  assert.equal(parseApplicationResetRequest(['XwX Deck.exe']), undefined);
  assert.throws(
    () => parseApplicationResetRequest(['XwX Deck.exe', '--xwxdeck-reset=unknown']),
    /无效的 XwX Deck 重置参数/
  );
  assert.deepEqual(
    applicationResetRelaunchArgs(
      ['electron.exe', 'dist/main/runtime.js', '--xwxdeck-reset=app', '--inspect=0'],
      { resetClientConfigs: true }
    ),
    ['dist/main/runtime.js', '--inspect=0', '--xwxdeck-reset=clients']
  );

  const resetRoot = path.join(root, 'application-reset');
  const appDataDir = path.join(resetRoot, 'roaming');
  const userDataDir = path.join(appDataDir, 'xwxdeck');
  const homeDir = path.join(resetRoot, 'home');
  const claudeDir = path.join(homeDir, 'custom-claude');
  const codexDir = path.join(homeDir, '.codex');
  await Promise.all([
    fs.mkdir(path.join(userDataDir, 'logs'), { recursive: true }),
    fs.mkdir(path.join(claudeDir, 'skills'), { recursive: true }),
    fs.mkdir(path.join(codexDir, 'sessions'), { recursive: true })
  ]);
  await Promise.all([
    fs.writeFile(path.join(userDataDir, 'settings.json'), JSON.stringify({ claudeConfigDir: claudeDir })),
    fs.writeFile(path.join(userDataDir, 'logs', 'xwxdeck.log'), 'reset me'),
    fs.writeFile(path.join(claudeDir, 'settings.json'), '{"env":{}}'),
    fs.writeFile(path.join(claudeDir, 'claude.json'), '{"legacy":true}'),
    fs.writeFile(path.join(claudeDir, 'skills', 'keep.md'), 'keep'),
    fs.writeFile(path.join(codexDir, 'config.toml'), 'model = "gpt-test"'),
    fs.writeFile(path.join(codexDir, 'auth.json'), '{"tokens":{}}'),
    fs.writeFile(path.join(codexDir, 'sessions', 'keep.jsonl'), '{}')
  ]);

  const reset = performApplicationResetAtStartup(
    userDataDir,
    { resetClientConfigs: true },
    {
      allowedParentDir: appDataDir,
      env: { CODEX_HOME: codexDir },
      homeDir
    }
  );
  assert.equal(reset.removedClientFiles.length, 4);
  assert.deepEqual(await fs.readdir(userDataDir), []);
  await assert.rejects(fs.stat(path.join(claudeDir, 'settings.json')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(claudeDir, 'claude.json')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(codexDir, 'config.toml')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(codexDir, 'auth.json')), /ENOENT/);
  assert.equal(await fs.readFile(path.join(claudeDir, 'skills', 'keep.md'), 'utf8'), 'keep');
  assert.equal(await fs.readFile(path.join(codexDir, 'sessions', 'keep.jsonl'), 'utf8'), '{}');
  assert.throws(
    () => performApplicationResetAtStartup(
      appDataDir,
      { resetClientConfigs: false },
      { allowedParentDir: appDataDir, homeDir }
    ),
    /不在允许的重置范围/
  );

  const repairRoot = path.join(root, 'application-repair');
  const repairAppData = path.join(repairRoot, 'roaming');
  const repairUserData = path.join(repairAppData, 'xwxdeck');
  await Promise.all([
    fs.mkdir(path.join(repairUserData, 'gateway'), { recursive: true }),
    fs.mkdir(path.join(repairUserData, 'logs'), { recursive: true }),
    fs.mkdir(path.join(repairUserData, 'pricing-cache'), { recursive: true }),
    fs.mkdir(path.join(repairUserData, 'updates'), { recursive: true }),
    fs.mkdir(path.join(repairUserData, 'xwx-trace'), { recursive: true })
  ]);
  await Promise.all([
    fs.writeFile(path.join(repairUserData, 'gateway', 'runtime.json'), '{}'),
    fs.writeFile(path.join(repairUserData, 'logs', 'xwxdeck.log'), 'log'),
    fs.writeFile(path.join(repairUserData, 'pricing-cache', 'models-dev-pricing.json'), '{}'),
    fs.writeFile(path.join(repairUserData, 'updates', 'pending.exe'), 'update'),
    fs.writeFile(path.join(repairUserData, 'model-capabilities-cache.json'), '{}'),
    fs.writeFile(path.join(repairUserData, 'compatible-model-catalog-cache.json'), '{}'),
    fs.writeFile(path.join(repairUserData, 'settings.json'), '{"theme":"night"}'),
    fs.writeFile(path.join(repairUserData, 'config-sync.json'), '{"profiles":[]}'),
    fs.writeFile(path.join(repairUserData, 'xwx-trace', 'index.json'), '{"sessions":[]}')
  ]);
  const repaired = performApplicationRepair(repairUserData, {
    allowedParentDir: repairAppData
  });
  assert.equal(repaired.removedCachePaths.length, 4);
  await assert.rejects(fs.stat(path.join(repairUserData, 'updates')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(repairUserData, 'pricing-cache')), /ENOENT/);
  assert.equal(await fs.readFile(path.join(repairUserData, 'gateway', 'runtime.json'), 'utf8'), '{}');
  assert.equal(await fs.readFile(path.join(repairUserData, 'logs', 'xwxdeck.log'), 'utf8'), 'log');
  assert.equal(await fs.readFile(path.join(repairUserData, 'settings.json'), 'utf8'), '{"theme":"night"}');
  assert.equal(await fs.readFile(path.join(repairUserData, 'config-sync.json'), 'utf8'), '{"profiles":[]}');
  assert.equal(await fs.readFile(path.join(repairUserData, 'xwx-trace', 'index.json'), 'utf8'), '{"sessions":[]}');
  completed.push('application repair clears bounded caches while reset preserves its explicit data boundary');
}

async function testMetadataPushInvalidation(): Promise<void> {
  const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  const requests: RequestInit[] = [];
  const warnings: string[] = [];
  const events: Array<{ topics: readonly string[]; revision?: number; reason: string }> = [];
  const subscriber = new MetadataInvalidationSubscriber(
    'http://metadata.test/events',
    async event => { events.push(event); },
    {
      fetcher: async (_input, init) => {
        requests.push(init ?? {});
        const stream = new ReadableStream<Uint8Array>({
          start(value) { controllers.push(value); }
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        });
      },
      fallbackMs: 60_000,
      reconnectMs: 10,
      logger: {
        info() {},
        warn(message) { warnings.push(message); }
      }
    }
  );
  subscriber.start();
  for (let attempt = 0; controllers.length === 0 && attempt < 40; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  controllers[0]!.enqueue(new TextEncoder().encode(
    'id: 17\nevent: metadata\ndata: {"revision":17,"topics":["models","pricing","invalid"]}\n\n'
  ));
  for (let attempt = 0; events.length === 0 && attempt < 40; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  controllers[0]!.close();
  for (let attempt = 0; controllers.length < 2 && attempt < 40; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(new Headers(requests[1]?.headers).get('last-event-id'), '17',
    'a quiet reconnect must resume from the last received revision');
  subscriber.stop();
  try { controllers[1]?.close(); } catch { /* aborted readers may already be closed */ }
  assert.equal(events.length, 1);
  assert.equal(events[0].revision, 17);
  assert.deepEqual(Array.from(events[0].topics), ['models', 'pricing']);
  assert.equal(events[0].reason, 'push');
  assert.equal(warnings.length, 1, 'one outage must produce one warning instead of reconnect log spam');

  const portProbe = net.createServer();
  await new Promise<void>((resolveListen, reject) => {
    portProbe.once('error', reject);
    portProbe.listen(0, '127.0.0.1', resolveListen);
  });
  const portAddress = portProbe.address();
  assert(portAddress && typeof portAddress !== 'string');
  const port = portAddress.port;
  await new Promise<void>((resolveClose, reject) => portProbe.close(error => error ? reject(error) : resolveClose()));

  const metadataServer = spawn(process.execPath, [path.resolve('tools', 'model-metadata-push-server.mjs')], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      XWX_METADATA_PUSH_HOST: '127.0.0.1',
      XWX_METADATA_PUSH_PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverStderr = '';
  metadataServer.stderr.on('data', chunk => { serverStderr += String(chunk); });
  const serverRoot = `http://127.0.0.1:${port}`;
  try {
    let health: { ok?: boolean; revision?: number } | undefined;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const response = await fetch(`${serverRoot}/health`);
        if (response.ok) {
          health = await response.json() as { ok?: boolean; revision?: number };
          break;
        }
      } catch {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    assert.equal(health?.ok, true, `metadata server did not start: ${serverStderr}`);
    assert.equal(typeof health?.revision, 'number');

    const malformed = await fetch(`${serverRoot}/invalidate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{'
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'invalid JSON body' });

    const oversized = await fetch(`${serverRoot}/invalidate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topics: ['models'], padding: 'x'.repeat(65 * 1024) })
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: 'request too large' });
    assert.equal((await fetch(`${serverRoot}/health`)).status, 200,
      'bad local admin input must not terminate the metadata server');

    const replayAbort = new AbortController();
    const replayTimeout = setTimeout(() => replayAbort.abort(), 2_000);
    const replayResponse = await fetch(`${serverRoot}/events`, {
      headers: { accept: 'text/event-stream', 'last-event-id': String((health?.revision ?? 1) - 1) },
      signal: replayAbort.signal
    });
    assert.equal(replayResponse.status, 200);
    const replayReader = replayResponse.body!.getReader();
    const replayDecoder = new TextDecoder();
    let replayText = '';
    while (!replayText.includes('event: metadata')) {
      const { done, value } = await replayReader.read();
      if (done) break;
      replayText += replayDecoder.decode(value, { stream: true });
    }
    clearTimeout(replayTimeout);
    replayAbort.abort();
    assert.match(replayText, /event: metadata/);
    assert.match(replayText, /"topics":\["models","capabilities","pricing"\]/,
      'a missed revision must trigger one complete metadata refresh after reconnect');
    let disconnectedClients = 1;
    for (let attempt = 0; disconnectedClients !== 0 && attempt < 40; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      const afterDisconnect = await fetch(`${serverRoot}/health`);
      disconnectedClients = Number((await afterDisconnect.json() as { clients?: unknown }).clients);
    }
    assert.equal(disconnectedClients, 0, 'closed SSE responses must be removed from the live client count');
  } finally {
    if (metadataServer.exitCode === null) metadataServer.kill();
    await new Promise<void>(resolveExit => {
      if (metadataServer.exitCode !== null) resolveExit();
      else metadataServer.once('exit', () => resolveExit());
    });
  }
  completed.push('server-sent model metadata invalidation refresh');
}

async function testChatGptLifecycle(): Promise<void> {
  const macMain = '410 S /Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
  const macZombie = '411 Z /Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
  const macHelper = '412 S /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/1/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)';
  const chromeExtension = '413 S /tmp/ChatGPT for Chrome';
  assert.equal(
    chatGptLifecycleTest.processListContainsChatGptMainProcess(`${macHelper}\n${chromeExtension}\n${macMain}\n`, 'darwin'),
    true,
    'macOS detection must recognize the ChatGPT main executable'
  );
  assert.equal(
    chatGptLifecycleTest.processListContainsChatGptMainProcess(`${macHelper}\n${chromeExtension}\n`, 'darwin'),
    false,
    'macOS detection must ignore ChatGPT helpers and the Chrome extension'
  );
  assert.equal(
    chatGptLifecycleTest.processListContainsChatGptMainProcess(`${macHelper}\n${macZombie}\n`, 'darwin'),
    false,
    'macOS detection must ignore a zombie ChatGPT main process'
  );
  assert.deepEqual(
    chatGptLifecycleTest.macChatGptMainProcessIds(`${macHelper}\n${macZombie}\n${macMain}\n`),
    [410],
    'force quit must target only a live ChatGPT main process'
  );
  assert.equal(
    chatGptLifecycleTest.processListContainsChatGptMainProcess('"ChatGPT.exe","4321","Console","1","123,456 K"\n', 'win32'),
    true,
    'Windows detection must recognize the ChatGPT executable row'
  );
  assert.equal(
    chatGptLifecycleTest.processListContainsChatGptMainProcess('"ChatGPTHelper.exe","4321","Console","1","123 K"\n', 'win32'),
    false,
    'Windows detection must not match similarly named helper processes'
  );
  assert.deepEqual(
    chatGptLifecycleTest.windowsClaudeMainProcessIds(
      '"claude.exe","5100","Console","1","50,000 K"\n"ClaudeHelper.exe","5101","Console","1","10,000 K"\n'
    ),
    [5100],
    'Windows reset safety must recognize the Claude executable without matching helpers'
  );
  assert.deepEqual(
    chatGptLifecycleTest.macClaudeMainProcessIds(
      '5200 S /Applications/Claude.app/Contents/MacOS/Claude\n'
      + '5201 S /opt/homebrew/bin/node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js\n'
      + '5202 Z /usr/local/bin/claude\n'
    ),
    [5200, 5201],
    'macOS reset safety must recognize Claude Desktop and Claude Code while ignoring zombies'
  );
  completed.push('ChatGPT and Claude running-state detection targets only live client processes');
}

async function testSettings(): Promise<void> {
  const store = new XwXDeckSettingsStore(path.join(root, 'settings'));
  const initial = await store.read();
  assert.equal(initial.tracingEnabled, false);
  assert.equal(initial.gatewayPaused, false);
  assert.deepEqual(initial.clientEnabled, { claude: true, codex: true });
  assert.equal(initial.codexEnhancements.preserveOfficialLogin, true);
  assert.equal(initial.codexEnhancements.unifySessionHistory, false);
  assert.equal(initial.codexEnhancements.pendingHistoryRestore, false);
  assert.deepEqual(initial.codexModels, {
    official: 'gpt-5.5',
    officialContextWindow: 0,
    compatible: '',
    compatibleContextWindow: 0
  });
  assert.equal(initial.compatible.displayName, '兼容服务');
  assert.equal(initial.compatible.providerPreset, 'auto');
  assert.equal(providerProfile('compatible').supportsClaude, true);
  assert.equal(providerProfile('volcengine-ark').supportsClaude, false);
  assert.equal(detectProviderPreset('https://ark.cn-beijing.volces.com/api/v3'), 'volcengine-ark');
  assert.equal(detectProviderPreset('https://relay.example.com/v1'), 'auto');
  assert.deepEqual(
    buildProviderModelUrlCandidates('https://relay.example.com/v1'),
    ['https://relay.example.com/v1/models']
  );
  assert.deepEqual(
    buildProviderModelUrlCandidates('https://open.bigmodel.cn/api/coding/paas/v4'),
    [
      'https://open.bigmodel.cn/api/coding/paas/v4/models',
      'https://open.bigmodel.cn/api/coding/paas/v4/v1/models'
    ]
  );
  assert.deepEqual(
    buildProviderModelUrlCandidates('https://relay.example.com/v1/chat/completions'),
    ['https://relay.example.com/v1/models']
  );
  assert.ok(PROVIDER_COMPATIBILITY_DIMENSIONS.protocols.includes('anthropic-messages'));
  assert.equal(
    normalizeCompatibleServiceBaseUrl('https://ark.cn-beijing.volces.com/api/v3'),
    'https://ark.cn-beijing.volces.com/api/v3'
  );
  assert.equal(baseUrlHasV1Suffix('https://ark.cn-beijing.volces.com/api/v3'), true);
  const arkRoutes = controllerTest.buildCodexGatewayRoutes({
    ...initial,
    compatible: {
      ...initial.compatible,
      providerPreset: 'volcengine-ark',
      displayName: '火山方舟',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      bearerToken: 'ark-key'
    }
  });
  const arkResponsesRoute = arkRoutes.find(route => route.path === '/v1/responses');
  assert.equal(arkResponsesRoute?.upstreamBaseUrl, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.equal(arkResponsesRoute?.stripPathPrefix, '/v1',
    'Ark /api/v3 is already an API version root and must not receive an extra /v1');
  const imageAllowedRoute = controllerTest.buildCodexGatewayRoutes({
    ...initial,
    compatible: {
      ...initial.compatible,
      providerPreset: 'auto',
      baseUrl: 'https://relay.example.com/v1',
      bearerToken: 'relay-key'
    }
  }).find(route => route.path === '/v1/responses');
  assert.equal(imageAllowedRoute?.excludedToolNamespaces, undefined,
    'unknown and image-capable providers must preserve image_gen by default');
  const knownBlockedRoute = controllerTest.buildCodexGatewayRoutes({
    ...initial,
    compatible: {
      ...initial.compatible,
      providerPreset: 'compatible',
      baseUrl: 'https://compatible.example/v1',
      bearerToken: 'compatible-key'
    }
  }).find(route => route.path === '/v1/responses');
  assert.deepEqual(knownBlockedRoute?.excludedToolNamespaces, ['image_gen'],
    'only a provider profile explicitly known to reject image_gen may remove it');
  assert.equal(initial.compatible.baseUrl, '');
  assert.equal(initial.traceRoot, '');
  assert.equal(initial.logRoot, '');
  assert.equal(initial.maxSessions, 0,
    'Trace Session retention must default to unlimited');
  assert.equal(initial.maxStorageMB, 0,
    'Trace storage retention must default to unlimited');
  const rejectedRetentionPatch = await store.update({ maxSessions: 25, maxStorageMB: 512 });
  assert.deepEqual(
    {
      maxSessions: rejectedRetentionPatch.maxSessions,
      maxStorageMB: rejectedRetentionPatch.maxStorageMB
    },
    { maxSessions: 0, maxStorageMB: 0 },
    'unsupported settings patches must not enable automatic Trace cleanup'
  );
  // Regression: theme and startup intent must persist in settings.json so a
  // portable repackage (which changes the file:// origin / exe path) does not
  // silently reset them the way localStorage / login-item probing did.
  assert.equal(initial.theme, 'day');
  assert.equal(initial.startupEnabled, false);
  assert.deepEqual(initial.traceAppearance, {
    skin: 'classic',
    showThroughput: true,
    customImageFile: '',
    customImageFit: 'cover',
    customImageOverlay: 42
  });
  const themed = await store.update({ theme: 'night', startupEnabled: true });
  assert.equal(themed.theme, 'night');
  assert.equal(themed.startupEnabled, true);
  const reread = await store.read();
  assert.equal(reread.theme, 'night');
  assert.equal(reread.startupEnabled, true);
  await Promise.all([
    store.update({ traceAppearance: { skin: 'clean' } }),
    store.update({ traceAppearance: { showThroughput: false } })
  ]);
  const appearance = await store.read();
  assert.equal(appearance.traceAppearance.skin, 'clean');
  assert.equal(appearance.traceAppearance.showThroughput, false,
    'concurrent settings patches must not overwrite independent appearance fields');
  const normalizedAppearance = await store.update({
    traceAppearance: {
      skin: 'custom',
      customImageFile: '../trace-background.webp',
      customImageFit: 'contain',
      customImageOverlay: 99
    }
  });
  assert.equal(normalizedAppearance.traceAppearance.customImageFile, 'trace-background.webp');
  assert.equal(normalizedAppearance.traceAppearance.customImageFit, 'contain');
  assert.equal(normalizedAppearance.traceAppearance.customImageOverlay, 80);
  assert.equal(isVersionNewer('1.0.9', '1.0.8'), true);
  assert.equal(isVersionNewer('1.1.0', '1.0.9'), true);
  assert.equal(isVersionNewer('1.0.8', '1.0.8'), false);
  assert.equal(isVersionNewer('1.0.7', '1.0.8'), false);
  assert.equal(resolveManualMacRelease({ version: '1.0.8', files: [] }, '1.0.8', 'arm64'), undefined);
  assert.equal(resolveManualMacRelease({
    version: '1.0.9',
    files: [{ name: 'XwX Deck.exe', size: 1, sha256: '0'.repeat(64) }]
  }, '1.0.8', 'arm64'), undefined,
  'a newer Windows-only release must not surface as a broken macOS update');
  assert.throws(() => resolveManualMacRelease({ version: '1.0.9' }, '1.0.8', 'arm64'),
    /artifact list is invalid/,
    'a missing release artifact list must remain a manifest error');
  assert.deepEqual(resolveManualMacRelease({
    version: '1.0.9',
    publishedAt: '2026-08-12T00:00:00.000Z',
    changelog: 'Mac 手动更新',
    files: [{
      name: 'XwX-Deck-mac-arm64.dmg',
      url: 'https://github.com/Damue01/XwX_Deck/releases/download/v1.0.9/XwX-Deck-mac-arm64.dmg',
      size: 123,
      sha256: 'ab'.repeat(32)
    }, {
      name: 'XwX Deck.exe',
      size: 456,
      sha256: 'cd'.repeat(32)
    }]
  }, '1.0.8', 'arm64'), {
    version: '1.0.9',
    publishedAt: '2026-08-12T00:00:00.000Z',
    changelog: 'Mac 手动更新',
    artifact: {
      name: 'XwX-Deck-mac-arm64.dmg',
      url: 'https://github.com/Damue01/XwX_Deck/releases/download/v1.0.9/XwX-Deck-mac-arm64.dmg',
      size: 123,
      sha256: 'ab'.repeat(32)
    }
  });
  assert.throws(() => resolveManualMacRelease({
    version: '1.0.9',
    files: [{
      name: 'XwX-Deck-mac-arm64.dmg',
      url: 'https://github.com/Damue01/XwX_Deck/releases/download/v1.0.9/XwX-Deck-mac-arm64.dmg',
      size: 1,
      sha256: 'invalid'
    }]
  }, '1.0.8', 'arm64'), /valid XwX-Deck-mac-arm64\.dmg/);
  const updated = await store.update({ tracingEnabled: true, clientEnabled: { claude: false, codex: true } });
  assert.equal(updated.tracingEnabled, true);
  assert.equal((await store.update({ gatewayPaused: true })).gatewayPaused, true);
  assert.equal((await store.update({ gatewayPaused: false })).gatewayPaused, false);
  assert.equal((await store.read()).clientEnabled.claude, false);
  const compatible = await store.update({
    compatible: {
      providerPreset: 'compatible',
      displayName: '兼容网关',
      baseUrl: 'https://compatible.example/v1',
      bearerToken: 'qa-key'
    }
  });
  assert.equal(compatible.compatible.displayName, '兼容网关');
  assert.equal(compatible.compatible.providerPreset, 'compatible');
  assert.equal(compatible.compatible.baseUrl, 'https://compatible.example/v1');
  assert.equal(compatible.compatible.bearerToken, 'qa-key');
  assert.equal(compatible.compatible.codexApiFormat, 'responses');
  const codexModels = await store.update({
    codexModels: {
      official: 'gpt-5.6-sol',
      officialContextWindow: CODEX_EXTENDED_CONTEXT_WINDOW,
      compatible: 'deepseek-chat',
      compatibleContextWindow: CODEX_STANDARD_LONG_CONTEXT_WINDOW
    }
  });
  assert.deepEqual(codexModels.codexModels, {
    official: 'gpt-5.6-sol',
    officialContextWindow: CODEX_EXTENDED_CONTEXT_WINDOW,
    compatible: 'deepseek-chat',
    compatibleContextWindow: CODEX_STANDARD_LONG_CONTEXT_WINDOW
  });
  // Regression: codexApiFormat must be able to latch to chat-completions AND back
  // to responses. A controller bug pinned it once it became chat-completions,
  // which then mis-tagged gpt/grok requests and deadlocked disable().
  const toChat = await store.update({ compatible: { baseUrl: 'https://compatible.example/v1', bearerToken: 'qa-key', codexApiFormat: 'chat-completions' } });
  assert.equal(toChat.compatible.codexApiFormat, 'chat-completions');
  const backToResponses = await store.update({ compatible: { baseUrl: 'https://compatible.example/v1', bearerToken: 'qa-key', codexApiFormat: 'responses' } });
  assert.equal(backToResponses.compatible.codexApiFormat, 'responses');
  const authPolicy = await store.update({ codexEnhancements: {
    preserveOfficialLogin: false,
    unifySessionHistory: false,
    pendingHistoryRestore: false
  } });
  assert.equal(authPolicy.codexEnhancements.preserveOfficialLogin, false);
  assert.equal((await store.read()).codexEnhancements.preserveOfficialLogin, false);
  await store.update({ codexEnhancements: { preserveOfficialLogin: true } });
  await store.update({ codexEnhancements: { pendingHistoryRestore: true } });
  assert.equal((await store.read()).codexEnhancements.pendingHistoryRestore, true);
  await store.update({ codexEnhancements: { pendingHistoryRestore: false } });
  const traceRoot = path.join(root, 'custom-trace');
  const logRoot = path.join(root, 'custom-logs');
  const directories = await store.update({ traceRoot, logRoot });
  assert.equal(directories.traceRoot, traceRoot);
  assert.equal(directories.logRoot, logRoot);
  completed.push('settings persistence');
}

async function testCodexConversationDoctor(): Promise<void> {
  const previousHome = process.env.CODEX_HOME;
  const previousSqliteHome = process.env.CODEX_SQLITE_HOME;
  const base = path.join(root, 'codex-conversation-doctor');
  const codexHome = path.join(base, '.codex');
  const sessionDir = path.join(codexHome, 'sessions', '2026', '08', '26');
  const archivedDir = path.join(codexHome, 'archived_sessions');
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SQLITE_HOME;
  const healthyId = '11111111-1111-4111-8111-111111111111';
  const recoverableId = '22222222-2222-4222-8222-222222222222';
  const mismatchId = '33333333-3333-4333-8333-333333333333';
  const orphanId = '44444444-4444-4444-8444-444444444444';
  const duplicateId = '55555555-5555-4555-8555-555555555555';
  const emptyId = '66666666-6666-4666-8666-666666666666';
  const healthyPath = path.join(sessionDir, `rollout-2026-08-26T10-00-00-${healthyId}.jsonl`);
  const missingIndexedPath = path.join(sessionDir, `rollout-2026-08-26T11-00-00-${recoverableId}.jsonl`);
  const recoveryPath = path.join(archivedDir, `rollout-2026-08-26T11-00-00-${recoverableId}.jsonl`);
  const mismatchPath = path.join(sessionDir, `rollout-2026-08-26T12-00-00-${mismatchId}.jsonl`);
  const orphanPath = path.join(archivedDir, `rollout-2026-08-26T13-00-00-${orphanId}.jsonl`);
  const duplicatePath = path.join(sessionDir, `rollout-2026-08-26T14-00-00-${duplicateId}.jsonl`);
  const duplicateArchivedPath = path.join(archivedDir, `rollout-2026-08-26T14-30-00-${duplicateId}.jsonl`);
  const emptyPath = path.join(sessionDir, `rollout-2026-08-26T15-00-00-${emptyId}.jsonl`);
  let db: Database | undefined;
  try {
    await Promise.all([
      fs.mkdir(sessionDir, { recursive: true }),
      fs.mkdir(archivedDir, { recursive: true })
    ]);
    await fs.writeFile(path.join(codexHome, 'config.toml'), [
      'model_provider = "xwx_deck"',
      '',
      '[model_providers.xwx_deck]',
      'name = "XwX Deck"',
      'base_url = "https://chatgpt.com/backend-api/codex"',
      'wire_api = "responses"',
      'requires_openai_auth = true',
      ''
    ].join('\n'));
    const writeMeta = (filePath: string, id: string, provider = 'xwx_deck') => fs.writeFile(
      filePath,
      `${JSON.stringify({ type: 'session_meta', payload: { id, model_provider: provider } })}\n`
    );
    await Promise.all([
      writeMeta(healthyPath, healthyId),
      writeMeta(recoveryPath, recoverableId),
      writeMeta(mismatchPath, mismatchId, 'openai'),
      writeMeta(orphanPath, orphanId, 'openai'),
      writeMeta(duplicatePath, duplicateId),
      writeMeta(duplicateArchivedPath, duplicateId),
      fs.writeFile(emptyPath, '')
    ]);

    const dbPath = path.join(codexHome, 'state_5.sqlite');
    db = new Database(dbPath);
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA wal_autocheckpoint=0;
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT);
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT,
        rollout_path TEXT,
        model_provider TEXT,
        archived INTEGER,
        created_at INTEGER,
        updated_at INTEGER,
        project_id TEXT,
        cwd TEXT
      );
      INSERT INTO projects (id, name) VALUES ('project-xwx', 'XwX Deck');
      INSERT INTO project_roots (project_id, position, path) VALUES
        ('project-xwx', 0, 'D:\\Work\\XwX_Deck'),
        ('project-xwx', 1, 'D:\\Work\\XwX_Deck_Docs');
    `);
    const insert = db.prepare(`
      INSERT INTO threads (
        id, title, rollout_path, model_provider, archived, created_at, updated_at, project_id, cwd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(healthyId, '正常任务', healthyPath, 'xwx_deck', 0, 1_787_280_000, 1_787_280_100, 'project-xwx', 'D:\\Work\\XwX_Deck');
    insert.run(recoverableId, '待恢复任务', missingIndexedPath, 'xwx_deck', 0, 1_787_280_000, 1_787_280_200, null, 'D:\\Work\\Daily');
    insert.run(mismatchId, 'Provider 不一致', mismatchPath, 'xwx_deck', 0, 1_787_280_000, 1_787_280_300, null, null);
    insert.run(duplicateId, '重复文件', duplicatePath, 'xwx_deck', 0, 1_787_280_000, 1_787_280_400, null, null);
    insert.run(emptyId, '空会话文件', emptyPath, 'xwx_deck', 0, 1_787_280_000, 1_787_280_500, null, null);

    const report = await new CodexConversationDoctor().diagnose();
    assert.equal(report.summary.indexedThreads, 5);
    assert.equal(report.summary.discoveredRollouts, 7);
    assert.equal(report.summary.healthy, 1);
    assert.equal(report.summary.warnings, 1);
    assert.equal(report.summary.errors, 4);
    assert.equal(report.summary.orphanRollouts, 1);
    assert.equal(report.summary.missingRollouts, 1);
    assert.equal(report.scanComplete, true);
    assert.deepEqual(report.scanIssues, []);
    assert.equal(report.databases[0].readable, true);
    assert.equal(report.databases[0].quickCheck, 'ok');
    assert.equal(report.databases[0].walPresent, true);

    const healthy = report.conversations.find(row => row.threadId === healthyId);
    assert.equal(healthy?.workspaceKind, 'project');
    assert.equal(healthy?.workspaceName, 'XwX Deck');
    assert.equal(healthy?.projectId, 'project-xwx');
    assert.deepEqual(healthy?.projectRoots, ['D:\\Work\\XwX_Deck', 'D:\\Work\\XwX_Deck_Docs']);
    assert.equal(healthy?.preview, '', 'conversation diagnostics must not query or return message previews');

    const recoverable = report.conversations.find(row => row.threadId === recoverableId);
    assert.equal(recoverable?.status, 'error');
    assert.equal(recoverable?.location, 'archived_sessions');
    assert.equal(recoverable?.resolvedPath, recoveryPath);
    assert.ok(recoverable?.issues.some(issue => issue.code === 'rollout_file_missing'));
    assert.ok(recoverable?.issues.some(issue => issue.code === 'recovery_candidate'));

    const mismatch = report.conversations.find(row => row.threadId === mismatchId);
    assert.ok(mismatch?.issues.some(issue => issue.code === 'provider_mismatch'));
    const orphan = report.conversations.find(row => row.threadId === orphanId);
    assert.equal(orphan?.indexed, false);
    assert.equal(orphan?.status, 'warning');
    assert.ok(orphan?.issues.some(issue => issue.code === 'orphan_rollout'));
    const duplicate = report.conversations.find(row => row.threadId === duplicateId);
    assert.equal(duplicate?.candidatePaths.length, 2);
    assert.ok(duplicate?.issues.some(issue => issue.code === 'multiple_rollout_candidates'));
    const empty = report.conversations.find(row => row.threadId === emptyId);
    assert.ok(empty?.issues.some(issue => issue.code === 'empty_session_file'));

    assert.equal(isPathInsideCodexHome(healthyPath), true);
    assert.equal(isPathInsideCodexHome(path.join(base, 'outside.jsonl')), false);
    if (process.platform !== 'win32') {
      const outside = path.join(base, 'outside-existing.jsonl');
      const linked = path.join(codexHome, 'sessions', 'outside-link.jsonl');
      await fs.writeFile(outside, '{}\n');
      await fs.symlink(outside, linked);
      assert.equal(isPathInsideCodexHome(linked), false, 'a symlink must not escape the Codex home path guard');
    }

    const corruptSqliteHome = path.join(base, 'corrupt-state');
    await fs.mkdir(corruptSqliteHome, { recursive: true });
    await fs.writeFile(path.join(corruptSqliteHome, 'state_5.sqlite'), 'not a sqlite database');
    process.env.CODEX_SQLITE_HOME = corruptSqliteHome;
    const incompleteReport = await new CodexConversationDoctor().diagnose();
    assert.equal(incompleteReport.scanComplete, false);
    assert.ok(incompleteReport.scanIssues.some(issue => issue.code === 'database_unavailable'));
  } finally {
    db?.close();
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    if (previousSqliteHome === undefined) delete process.env.CODEX_SQLITE_HOME;
    else process.env.CODEX_SQLITE_HOME = previousSqliteHome;
  }
  completed.push('ChatGPT conversation diagnosis links SQLite indexes and Session metadata safely');
}

async function testTraceDeletionTransactions(): Promise<void> {
  const makeFixture = async (name: string, ids: readonly string[]): Promise<{
    root: string;
    indexPath: string;
    paths: string[];
  }> => {
    const traceRoot = path.join(root, name);
    await fs.mkdir(traceRoot, { recursive: true });
    const paths = ids.map(id => path.join(traceRoot, `${id}.jsonl`));
    await Promise.all(paths.map((file, index) => fs.writeFile(file, `record-${index}\n`, 'utf8')));
    await fs.writeFile(path.join(traceRoot, 'index.json'), JSON.stringify({
      version: 1,
      sessions: ids.map((id, index) => ({
        id,
        startedAt: `2026-08-21T00:00:0${index}.000Z`,
        updatedAt: `2026-08-21T00:00:0${index}.000Z`,
        traceCount: 1,
        jsonlPath: paths[index],
        source: 'codex-cli',
        clientConversationKey: 'codex-cli:transaction-test'
      }))
    }));
    return { root: traceRoot, indexPath: path.join(traceRoot, 'index.json'), paths };
  };

  {
    const fixture = await makeFixture('trace-delete-index-rollback', ['fragment-a']);
    const originalIndex = await fs.readFile(fixture.indexPath, 'utf8');
    const originalRename = nodeFs.promises.rename;
    nodeFs.promises.rename = async (source, destination) => {
      if (path.resolve(String(destination)) === path.resolve(fixture.indexPath)) {
        throw Object.assign(new Error('injected index replacement failure'), { code: 'EIO' });
      }
      return originalRename(source, destination);
    };
    try {
      await assert.rejects(
        new TraceStore(fixture.root).deleteSession('fragment-a'),
        /injected index replacement failure/
      );
    } finally {
      nodeFs.promises.rename = originalRename;
    }
    assert.equal(await fs.readFile(fixture.indexPath, 'utf8'), originalIndex);
    assert.equal(await fs.readFile(fixture.paths[0], 'utf8'), 'record-0\n');
    assert.equal(
      (await fs.readdir(fixture.root)).some(name => name.includes('.deleting-')),
      false,
      'index failure must restore the staged Session file'
    );
  }

  {
    const fixture = await makeFixture('trace-delete-stage-rollback', ['fragment-a', 'fragment-b']);
    const originalIndex = await fs.readFile(fixture.indexPath, 'utf8');
    const originalRename = nodeFs.promises.rename;
    nodeFs.promises.rename = async (source, destination) => {
      if (
        path.resolve(String(source)) === path.resolve(fixture.paths[1])
        && String(destination).includes('.deleting-')
      ) {
        throw Object.assign(new Error('injected staging failure'), { code: 'EIO' });
      }
      return originalRename(source, destination);
    };
    try {
      await assert.rejects(
        new TraceStore(fixture.root).deleteSession('fragment-a'),
        /injected staging failure/
      );
    } finally {
      nodeFs.promises.rename = originalRename;
    }
    assert.equal(await fs.readFile(fixture.indexPath, 'utf8'), originalIndex);
    assert.equal(await fs.readFile(fixture.paths[0], 'utf8'), 'record-0\n');
    assert.equal(await fs.readFile(fixture.paths[1], 'utf8'), 'record-1\n');
    assert.equal(
      (await fs.readdir(fixture.root)).some(name => name.includes('.deleting-')),
      false,
      'partial staging failure must roll every earlier rename back'
    );
  }
  completed.push('Trace deletion stages files and rolls back every failed transaction');
}

async function testControllerColdStartTransactions(): Promise<void> {
  assert.equal(startupRegistrationMatches({
    enabled: true,
    supported: true,
    launchHidden: true,
    executableWillLaunchAtLogin: true
  }, true), true);
  assert.equal(startupRegistrationMatches({
    enabled: true,
    supported: true,
    launchHidden: true,
    executableWillLaunchAtLogin: false
  }, true), false);
  assert.equal(startupRegistrationMatches({
    enabled: false,
    supported: true,
    launchHidden: true,
    executableWillLaunchAtLogin: false
  }, false), true);
  let startupReads = 0;
  let startupSleeps = 0;
  const settledStartup = await waitForStartupRegistration(() => {
    startupReads += 1;
    return {
      enabled: true,
      supported: true,
      executableWillLaunchAtLogin: startupReads >= 3
    };
  }, true, {
    attempts: 4,
    delayMs: 0,
    sleep: async () => { startupSleeps += 1; }
  });
  assert.equal(startupRegistrationMatches(settledStartup, true), true,
    'startup registration should tolerate delayed Windows state propagation');
  assert.equal(startupReads, 3);
  assert.equal(startupSleeps, 2);

  const previousClientHome = process.env.XWX_DECK_CLIENT_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousClaudeHome = process.env.CLAUDE_CONFIG_DIR;
  const previousIgnoreExternal = process.env.XWX_DECK_SMOKE_IGNORE_EXTERNAL;
  process.env.XWX_DECK_SMOKE_IGNORE_EXTERNAL = '1';
  const setClientEnvironment = (base: string) => {
    process.env.XWX_DECK_CLIENT_HOME = path.join(base, 'client-home');
    process.env.CODEX_HOME = path.join(base, 'client-home', '.codex');
    process.env.CLAUDE_CONFIG_DIR = path.join(base, 'client-home', '.claude');
    return resolveClientPaths(process.env);
  };
  const writeOfficialClients = async (base: string) => {
    const paths = setClientEnvironment(base);
    await fs.mkdir(path.dirname(paths.claudeSettingsPath), { recursive: true });
    await fs.mkdir(path.dirname(paths.codexConfigPath), { recursive: true });
    await fs.writeFile(paths.claudeSettingsPath, `${JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }
    }, null, 2)}\n`);
    await fs.writeFile(paths.codexConfigPath, 'model_provider = "openai"\nmodel = "gpt-5.5"\n');
    await fs.writeFile(paths.codexAuthPath, '{"auth_mode":"chatgpt","tokens":{"access_token":"qa-oauth"}}\n');
    return paths;
  };

  try {
    // If Electron cannot translate the active system proxy rule, route
    // publication must fail before either client is pointed at localhost.
    {
      const base = path.join(root, 'controller-system-proxy-preflight');
      const userData = path.join(base, 'user-data');
      const paths = await writeOfficialClients(base);
      const controller = new XwXDeckController(userData, {
        proxyListenPorts: [0],
        disableBackgroundModelRefresh: true,
        resolveUpstreamProxyUrl: async () => {
          throw new Error('unsupported SOCKS-only system proxy');
        }
      });
      await controller.start();
      await assert.rejects(controller.enable('system-proxy-preflight'), /unsupported SOCKS-only system proxy/);
      const preservedConfig = await fs.readFile(paths.codexConfigPath, 'utf8');
      assert.match(preservedConfig, /base_url = "https:\/\/chatgpt\.com\/backend-api\/codex"/,
        'stable-provider migration may proceed but must keep the official ChatGPT endpoint');
      assert.doesNotMatch(preservedConfig, /127\.0\.0\.1:\d+/,
        'failed proxy resolution must never publish a localhost endpoint to ChatGPT');
      await controller.shutdown();
    }

    // A failure after Trace intent/recording have been published must restore
    // the complete pre-toggle state, including an explicitly paused Gateway.
    {
      const base = path.join(root, 'controller-enable-rollback');
      const userData = path.join(base, 'user-data');
      const paths = await writeOfficialClients(base);
      await new XwXDeckSettingsStore(userData).update({
        tracingEnabled: false,
        gatewayPaused: true
      });
      const controller = new XwXDeckController(userData, {
        proxyListenPorts: [0],
        disableBackgroundModelRefresh: true,
        beforeEnableClientApply: async () => {
          throw new Error('injected client apply failure');
        }
      });
      await controller.start();
      const before = await controller.runtimeState();
      await assert.rejects(controller.enable('rollback-smoke'), /injected client apply failure/);
      const settings = await new XwXDeckSettingsStore(userData).read();
      assert.equal(settings.tracingEnabled, false);
      assert.equal(settings.gatewayPaused, true);
      const state = await controller.runtimeState();
      assert.equal(state.tracingEnabled, false);
      assert.equal(state.readiness.recordingEnabled, false);
      assert.equal(state.readiness.proxyListening, before.readiness.proxyListening);
      assert.equal(state.localBaseUrl, before.localBaseUrl);
      assert.equal(state.role, before.role);
      assert.doesNotMatch(await fs.readFile(paths.codexConfigPath, 'utf8'), /127\.0\.0\.1:\d+/);
      await controller.shutdown();
    }

    // Client intent is authoritative only after the corresponding config
    // transaction succeeds. A failed toggle must not leave settings/UI enabled.
    {
      const base = path.join(root, 'controller-client-toggle-rollback');
      const userData = path.join(base, 'user-data');
      const paths = await writeOfficialClients(base);
      await new XwXDeckSettingsStore(userData).update({
        tracingEnabled: true,
        clientEnabled: { claude: true, codex: false }
      });
      let failClientRoute = false;
      const controller = new XwXDeckController(userData, {
        proxyListenPorts: [0],
        disableBackgroundModelRefresh: true,
        resolveUpstreamProxyUrl: async () => {
          if (failClientRoute) throw new Error('injected client route failure');
          return undefined;
        }
      });
      await controller.start();
      failClientRoute = true;
      await assert.rejects(controller.toggleClient('codex-cli'), /injected client route failure/);
      failClientRoute = false;
      const settings = await new XwXDeckSettingsStore(userData).read();
      assert.equal(settings.clientEnabled.codex, false);
      const state = await controller.runtimeState();
      assert.equal(state.clients.find(client => client.id === 'codex-cli')?.status, 'off');
      assert.doesNotMatch(await fs.readFile(paths.codexConfigPath, 'utf8'), /127\.0\.0\.1:\d+/);
      await controller.shutdown();
    }

    // Official idle start: merely launching XwX Deck must not make ChatGPT
    // depend on a localhost Gateway or route signed historical requests
    // through XwX Deck. A scoped takeover begins only after Trace is enabled.
    {
      const base = path.join(root, 'controller-official-cold-start');
      const userData = path.join(base, 'user-data');
      const paths = await writeOfficialClients(base);
      const idleController = new XwXDeckController(userData, {
        proxyListenPorts: [0],
        disableBackgroundModelRefresh: true
      });
      await idleController.start();
      const idleState = await idleController.runtimeState();
      assert.equal(idleState.tracingEnabled, false);
      assert.deepEqual(
        idleState.clients.filter(client => client.enabled).map(client => client.status),
        ['idle', 'idle'],
        'enabled clients must be idle rather than skipped before Trace starts'
      );
      assert.equal(idleState.readiness.codexGatewayEnabled, false, 'official idle ChatGPT must not depend on XwX Deck');
      assert.equal(idleState.readiness.codexConfigReady, false);
      assert.equal(idleState.readiness.codexRouteReady, false);
      assert.equal(
        await fs.readFile(paths.codexConfigPath, 'utf8'),
        'model_provider = "openai"\nmodel = "gpt-5.5"\n',
        'official idle startup must leave ChatGPT config byte-stable'
      );
      await idleController.shutdown();
      assert.doesNotMatch(await fs.readFile(paths.codexConfigPath, 'utf8'), /127\.0\.0\.1:\d+/);
      await new XwXDeckSettingsStore(userData).update({ tracingEnabled: true });
      const phases: string[] = [];
      let injectShutdownConflict = false;
      let shutdownConflictBaseUrl = '';
      let failCompatibleServiceReapply = false;
      const controller = new XwXDeckController(userData, {
        proxyListenPorts: [0],
        disableBackgroundModelRefresh: true,
        chatGptRunning: async () => true,
        onStartupPhase: phase => phases.push(phase),
        beforeShutdownConfigVerification: async () => {
          if (!injectShutdownConflict) return;
          const liveGateway = (await fs.readFile(paths.codexConfigPath, 'utf8'))
            .replace(/base_url = "https:\/\/chatgpt\.com\/backend-api\/codex"/, (line: string) => (
              line.replace('https://chatgpt.com/backend-api/codex', shutdownConflictBaseUrl)
            ));
          await fs.writeFile(paths.codexConfigPath, liveGateway);
        },
        beforeCompatibleServiceServiceReapply: async client => {
          if (failCompatibleServiceReapply && client === 'codex') {
            throw new Error('injected 兼容服务 reapply failure');
          }
        }
      });
      await controller.start();
      const state = await controller.runtimeState();
      assert.equal(state.readiness.proxyListening, true, 'official startup proxy listener');
      assert.equal(state.readiness.recordingEnabled, true, 'official startup recording');
      assert.equal(state.readiness.claudeRouteReady, true, 'official startup Claude route');
      assert.equal(state.readiness.claudeConfigReady, true, 'official startup Claude config');
      assert.equal(state.readiness.codexRouteReady, true, 'official startup ChatGPT route');
      assert.equal(state.readiness.codexConfigReady, true, 'official startup ChatGPT config');
      assert.equal(state.clients.find(client => client.id === 'claude-cli')?.status, 'taken');
      assert.equal(state.clients.find(client => client.id === 'codex-cli')?.status, 'taken');
      assert.equal(state.clients.find(client => client.id === 'claude-cli')?.statusText, '等待请求');
      assert.equal(state.clients.find(client => client.id === 'codex-cli')?.statusText, '等待请求');
      assert.equal(state.chatGptRestartRecommended, true,
        'a running ChatGPT must receive a restart recommendation after a new Gateway takeover');
      assert.ok(phases.indexOf('proxy-listening') < phases.indexOf('routes-ready'));
      assert.ok(phases.indexOf('routes-ready') < phases.indexOf('config-ready'));
      assert.match(await fs.readFile(paths.codexConfigPath, 'utf8'), /127\.0\.0\.1:\d+\/backend-api\/codex/);
      await controller.updateCompatibleServiceConfig({
        displayName: '研发网关',
        baseUrl: 'https://compatible.example/v1',
        bearerToken: 'qa-key',
        codexApiFormat: 'responses'
      });
      assert.equal((await controller.readCompatibleServiceConfig()).displayName, '研发网关');
      const renamedConnection = await controller.updateCompatibleServiceConfig({ displayName: '备用网关' });
      assert.equal(renamedConnection.displayName, '备用网关');
      assert.equal(renamedConnection.baseUrl, 'https://compatible.example/v1');
      await controller.setModelService('codex', true);
      let switched = await controller.runtimeState();
      assert.equal(switched.readiness.codexGatewayEnabled, true);
      assert.equal(switched.readiness.codexConfigReady, true);
      assert.equal(switched.readiness.codexRouteReady, true);
      failCompatibleServiceReapply = true;
      await assert.rejects(controller.updateCompatibleServiceConfig({
        baseUrl: 'https://replacement-compatible.example/v1',
        bearerToken: 'replacement-key',
        codexApiFormat: 'chat-completions'
      }), /injected 兼容服务 reapply failure/);
      failCompatibleServiceReapply = false;
      const rolledBackConnection = await new XwXDeckSettingsStore(userData).read();
      assert.equal(rolledBackConnection.compatible.baseUrl, 'https://compatible.example/v1');
      assert.equal(rolledBackConnection.compatible.bearerToken, 'qa-key');
      assert.equal(rolledBackConnection.compatible.codexApiFormat, 'responses');
      assert.equal(rolledBackConnection.compatible.displayName, '备用网关');
      assert.equal((await controller.readModelServices()).codex, true,
        'a failed 兼容服务 connection update must restore the active service');
      await controller.updateCodexConfig({
        mode: 'compatible',
        compatibleModel: 'deepseek-chat',
        compatibleBaseUrl: 'https://compatible.example/v1',
        compatibleBearerToken: 'qa-key'
      });
      await controller.setModelService('codex', false);
      // Regression: assert immediately, before another ChatGPT setting action
      // can accidentally reinstall the official Trace overlay and mask this.
      switched = await controller.runtimeState();
      assert.equal(switched.tracingEnabled, true);
      assert.equal(switched.readiness.codexGatewayEnabled, true, 'official mode stays on the stable local Gateway');
      assert.equal(switched.readiness.codexConfigReady, true, 'official Gateway config stays on the stable local endpoint');
      assert.equal(switched.readiness.codexRouteReady, true, 'official Gateway route stays published');
      assert.equal(switched.clients.find(client => client.id === 'codex-cli')?.status, 'taken');
      const officialTraceConfig = await fs.readFile(paths.codexConfigPath, 'utf8');
      assert.match(officialTraceConfig, /base_url = "http:\/\/127\.0\.0\.1:\d+\/backend-api\/codex"/);
      assert.match(officialTraceConfig, /^model = "gpt-5\.5"$/m, 'returning official restores the last official model');
      const rememberedModels = (await new XwXDeckSettingsStore(userData).read()).codexModels;
      assert.deepEqual(rememberedModels, {
        official: 'gpt-5.5',
        officialContextWindow: 0,
        compatible: 'deepseek-chat',
        compatibleContextWindow: 0
      });
      const extendedOfficial = await controller.updateCodexConfig({
        mode: 'official',
        officialModel: 'gpt-5.6-sol',
        modelContextWindow: CODEX_EXTENDED_CONTEXT_WINDOW
      });
      assert.equal(extendedOfficial.officialModel, 'gpt-5.6-sol');
      assert.equal(extendedOfficial.modelContextWindow, CODEX_EXTENDED_CONTEXT_WINDOW);
      const extendedOfficialToml = await fs.readFile(paths.codexConfigPath, 'utf8');
      assert.match(extendedOfficialToml, /^model = "gpt-5\.6-sol"$/m,
        'the display-only [1M] variant must never enter the upstream model id');
      assert.match(extendedOfficialToml, /^model_context_window = 1000000$/m);
      assert.match(extendedOfficialToml, /^model_auto_compact_token_limit = 900000$/m);
      await assert.rejects(controller.updateCodexConfig({
        mode: 'official',
        officialModel: 'gpt-5.5',
        modelContextWindow: CODEX_EXTENDED_CONTEXT_WINDOW
      }), /不支持 1,000,000 token 上下文配置/);
      await assert.rejects(controller.updateCodexConfig({
        mode: 'official',
        officialModel: 'deepseek-chat'
      }), /不是可用于官方 ChatGPT\/OpenAI 服务的模型/);
      switched = await controller.runtimeState();
      assert.equal(switched.readiness.codexConfigReady, true, 'a rejected official model must restore the Trace overlay');
      assert.equal(switched.readiness.codexRouteReady, true);

      // Cross-page mutations share one queue. These calls are deliberately
      // started together; the final state must match their invocation order.
      await Promise.all([
        controller.setModelService('codex', true),
        controller.toggleClient('codex-cli')
      ]);
      switched = await controller.runtimeState();
      assert.equal(switched.readiness.codexGatewayEnabled, true);
      assert.equal(switched.clients.find(client => client.id === 'codex-cli')?.status, 'off');
      await Promise.all([
        controller.setModelService('codex', false),
        controller.toggleClient('codex-cli')
      ]);
      switched = await controller.runtimeState();
      assert.equal(switched.readiness.codexGatewayEnabled, false, 'official Trace uses only the scoped Trace takeover');
      assert.equal(switched.readiness.codexConfigReady, true);
      assert.equal(switched.readiness.codexRouteReady, true);
      assert.equal(switched.clients.find(client => client.id === 'codex-cli')?.status, 'taken');

      // If another writer points config back at this exact Gateway after XwX's
      // restore but before shutdown verification, XwX must stay alive. Closing
      // the proxy in this state is the original user-visible 502 failure.
      injectShutdownConflict = true;
      shutdownConflictBaseUrl = `${switched.localBaseUrl!.replace(/\/+$/, '')}/backend-api/codex`;
      await assert.rejects(
        controller.shutdown(),
        /配置仍指向本次即将关闭的 XwX Model Gateway/
      );
      assert.equal((await controller.runtimeState()).readiness.proxyListening, true, 'cancelled shutdown keeps Gateway listening');
      injectShutdownConflict = false;
      await fs.writeFile(
        paths.codexConfigPath,
        (await fs.readFile(paths.codexConfigPath, 'utf8')).replace(
          shutdownConflictBaseUrl,
          'https://chatgpt.com/backend-api/codex'
        )
      );
      const controllerProxy = (controller as any).proxy;
      const repairHistory = controllerProxy.repairCodexHistoryForProvider.bind(controllerProxy);
      let historyRepairCalls = 0;
      controllerProxy.repairCodexHistoryForProvider = async (...args: unknown[]) => {
        historyRepairCalls += 1;
        return repairHistory(...args);
      };
      await controller.shutdown({ force: true, skipCodexHistoryRepair: true });
      assert.equal(historyRepairCalls, 0,
        'closing the proxy while ChatGPT may still run must not rewrite live rollout history');
      assert.doesNotMatch(await fs.readFile(paths.codexConfigPath, 'utf8'), /127\.0\.0\.1:\d+/);
      assert.equal((await controller.runtimeState()).readiness.proxyListening, false,
        'deferring history repair must not prevent the proxy from stopping');
      await controller.finishShutdown(true);
      assert.equal((await new XwXDeckSettingsStore(userData).read()).gatewayPaused, true,
        'a completed proxy close must persist the closed Gateway state');
      assert.equal(await controller.backgroundGatewayAction(), 'open',
        'a completed proxy close must switch the menu action to reopen the Gateway');
    }

    // Forced termination residue: a stale local port and its backup are
    // restored first, then the new listener/routes take over atomically.
    {
      const base = path.join(root, 'controller-forced-exit');
      const userData = path.join(base, 'user-data');
      const paths = await writeOfficialClients(base);
      await new XwXDeckSettingsStore(userData).update({ tracingEnabled: true });
      const backup = new ClientBackupStore(userData);
      const stale = new ClientConfigOrchestrator(
        backup,
        new ClientConfigWriter({ backup }),
        paths,
        process.env
      );
      await stale.apply('http://127.0.0.1:44991');
      assert.match(await fs.readFile(paths.codexConfigPath, 'utf8'), /127\.0\.0\.1:44991/);
      const controller = new XwXDeckController(userData, {
        proxyListenPorts: [0],
        disableBackgroundModelRefresh: true
      });
      await controller.start();
      const state = await controller.runtimeState();
      assert.equal(state.readiness.codexConfigReady, true);
      assert.equal(state.readiness.codexRouteReady, true);
      assert.doesNotMatch(await fs.readFile(paths.codexConfigPath, 'utf8'), /127\.0\.0\.1:44991/);
      await controller.shutdown();
    }

    // A forced manager exit must restore live client files before stopping the
    // local data plane.
    {
      const base = path.join(root, 'controller-safe-force-exit');
      const userData = path.join(base, 'user-data');
      const paths = await writeOfficialClients(base);
      await new XwXDeckSettingsStore(userData).update({ tracingEnabled: true });
      const controller = new XwXDeckController(userData, {
        proxyListenPorts: [0],
        disableBackgroundModelRefresh: true
      });
      await controller.start();
      assert.match(await fs.readFile(paths.claudeSettingsPath, 'utf8'), /127\.0\.0\.1:\d+/);
      assert.match(await fs.readFile(paths.codexConfigPath, 'utf8'), /127\.0\.0\.1:\d+/);
      const result = await controller.forceExit();
      assert.equal(result.helperStopped, true);
      assert.doesNotMatch(await fs.readFile(paths.claudeSettingsPath, 'utf8'), /127\.0\.0\.1:\d+/);
      assert.doesNotMatch(await fs.readFile(paths.codexConfigPath, 'utf8'), /127\.0\.0\.1:\d+/);
      assert.equal((controller as any).proxy.isListening(), false);
    }

    // The in-process fallback reports unresolved dependencies, while the
    // detached exit guardian owns the final restore-and-kill guarantee.
    {
      const base = path.join(root, 'controller-retained-force-exit');
      const userData = path.join(base, 'user-data');
      const paths = await writeOfficialClients(base);
      await new XwXDeckSettingsStore(userData).update({ tracingEnabled: true });
      const controller = new XwXDeckController(userData, {
        proxyListenPorts: [0],
        disableBackgroundModelRefresh: true
      });
      await controller.start();
      const orchestrator = (controller as any).clientOrchestrator as ClientConfigOrchestrator;
      const restoreAll = orchestrator.restoreAll.bind(orchestrator);
      (orchestrator as any).restoreAll = async () => {
        throw new Error('injected emergency restore failure');
      };
      const result = await controller.forceExit();
      assert.equal(result.helperStopped, true);
      assert.deepEqual(result.dependentClients, ['claude-cli', 'codex-cli']);
      assert.equal((controller as any).proxy.isListening(), false);
      assert.match(await fs.readFile(paths.claudeSettingsPath, 'utf8'), /127\.0\.0\.1:\d+/);
      assert.match(await fs.readFile(paths.codexConfigPath, 'utf8'), /127\.0\.0\.1:\d+/);
      (orchestrator as any).restoreAll = restoreAll;
      await restoreAll();
    }

    // Legacy official-Gateway residue must be repaired to direct official
    // service. Merely launching XwX Deck must not make an idle official
    // ChatGPT process depend on the new listener.
    {
      const base = path.join(root, 'controller-official-gateway-restart');
      const userData = path.join(base, 'user-data');
      const paths = await writeOfficialClients(base);
      await fs.writeFile(paths.codexConfigPath, [
        'model_provider = "xwx_deck"',
        'model = "gpt-5.5"',
        '',
        '[model_providers.xwx_deck]',
        'name = "XwX Deck"',
        'base_url = "http://127.0.0.1:44991/backend-api/codex"',
        'wire_api = "responses"',
        'requires_openai_auth = true',
        'supports_websockets = false',
        ''
      ].join('\n'));
      const controller = new XwXDeckController(userData, {
        proxyListenPorts: [0],
        disableBackgroundModelRefresh: true
      });
      await controller.start();
      const state = await controller.runtimeState();
      assert.equal(state.readiness.codexGatewayEnabled, false);
      assert.equal(state.readiness.codexConfigReady, false);
      assert.equal(state.readiness.codexRouteReady, false);
      const live = await fs.readFile(paths.codexConfigPath, 'utf8');
      assert.doesNotMatch(live, /127\.0\.0\.1:44991/);
      assert.match(live, /base_url = "https:\/\/chatgpt\.com\/backend-api\/codex"/);
      await controller.shutdown();
      assert.doesNotMatch(await fs.readFile(paths.codexConfigPath, 'utf8'), /127\.0\.0\.1:\d+/);
    }

    // 兼容服务 hard-kill residue: config starts on a dead Gateway port. Cached
    // settings rebuild the route on the new listener and only then rewrite TOML.
    {
      const base = path.join(root, 'controller-compatible-cold-start');
      const userData = path.join(base, 'user-data');
      const paths = setClientEnvironment(base);
      await fs.mkdir(path.dirname(paths.codexConfigPath), { recursive: true });
      await fs.writeFile(paths.codexConfigPath, [
        'model_provider = "xwx_deck"',
        'model = "deepseek-chat"',
        '',
        '[model_providers.xwx_deck]',
        'base_url = "http://127.0.0.1:44992/v1"',
        'wire_api = "responses"',
        'experimental_bearer_token = "qa-key"',
        ''
      ].join('\n'));
      await fs.writeFile(paths.codexAuthPath, '{"auth_mode":"chatgpt","tokens":{"access_token":"qa-oauth"}}\n');
      await new XwXDeckSettingsStore(userData).update({
        tracingEnabled: true,
        clientEnabled: { claude: false, codex: true },
        compatible: {
          baseUrl: 'https://compatible.example/v1',
          bearerToken: 'qa-key',
          codexApiFormat: 'chat-completions'
        }
      });
      const phases: string[] = [];
      const controller = new XwXDeckController(userData, {
        proxyListenPorts: [0],
        disableBackgroundModelRefresh: true,
        onStartupPhase: phase => phases.push(phase)
      });
      await controller.start();
      const state = await controller.runtimeState();
      assert.equal(state.readiness.codexGatewayEnabled, true);
      assert.equal(state.readiness.codexRouteReady, true);
      assert.equal(state.readiness.codexConfigReady, true);
      assert.equal(state.clients.find(client => client.id === 'codex-cli')?.status, 'taken');
      assert.ok(phases.indexOf('routes-ready') < phases.indexOf('config-ready'));
      const liveConfig = await fs.readFile(paths.codexConfigPath, 'utf8');
      assert.doesNotMatch(liveConfig, /127\.0\.0\.1:44992/);
      assert.match(liveConfig, /127\.0\.0\.1:\d+\/backend-api\/codex/);
      await controller.shutdown();
      assert.match(await fs.readFile(paths.codexConfigPath, 'utf8'), /base_url = "https:\/\/compatible\.example\/v1"/);
    }

    // Authentication conflict: the route prepare phase may run, but failure
    // must leave config.toml byte-identical and remove the provisional route.
    {
      const base = path.join(root, 'controller-auth-conflict');
      const userData = path.join(base, 'user-data');
      const paths = await writeOfficialClients(base);
      await new XwXDeckSettingsStore(userData).update({
        tracingEnabled: false,
        clientEnabled: { claude: true, codex: false },
        codexEnhancements: { preserveOfficialLogin: false }
      });
      const controller = new XwXDeckController(userData, {
        proxyListenPorts: [0],
        disableBackgroundModelRefresh: true
      });
      await controller.start();
      const auth = new CodexOfficialAuthManager(userData);
      await auth.useCompatibleServiceKey('old-compatible-key');
      await fs.writeFile(paths.codexAuthPath, '{"auth_mode":"chatgpt","external":"changed"}\n');
      const configBefore = await fs.readFile(paths.codexConfigPath, 'utf8');
      await assert.rejects(controller.updateCodexConfig({
        mode: 'compatible',
        compatibleModel: 'deepseek-chat',
        compatibleBaseUrl: 'https://compatible.example/v1',
        compatibleBearerToken: 'new-compatible-key'
      }), /auth\.json/);
      assert.equal(await fs.readFile(paths.codexConfigPath, 'utf8'), configBefore);
      const state = await controller.runtimeState();
      assert.equal(state.readiness.codexGatewayEnabled, false);
      assert.equal(state.readiness.codexRouteReady, false);
      assert.equal(state.readiness.startupPhase, 'degraded');
      assert.equal(
        (await new XwXDeckSettingsStore(userData).read()).compatible.baseUrl,
        ''
      );
      await fs.writeFile(paths.codexAuthPath, '{"OPENAI_API_KEY":"old-compatible-key"}\n');
      await controller.shutdown();
    }

    // A healthy XwX Deck-owned local connection yields to Trace, then receives
    // control back after tracing stops. The original local URL is never used as
    // Trace's upstream, so the route cannot recurse.
    {
      const base = path.join(root, 'controller-xwx_deck-yield');
      const userData = path.join(base, 'user-data');
      const paths = setClientEnvironment(base);
      const externalXwX = http.createServer((req, res) => {
        if (req.url === '/xwx-trace/ping') {
          res.writeHead(200, { 'x-xwx-trace': '1' });
          res.end('{"ok":true}');
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve, reject) => {
        externalXwX.once('error', reject);
        externalXwX.listen(0, '127.0.0.1', () => resolve());
      });
      try {
        const address = externalXwX.address();
        assert.ok(address && typeof address !== 'string');
        const externalBaseUrl = `http://127.0.0.1:${address.port}/backend-api/codex`;
        await fs.mkdir(path.dirname(paths.codexConfigPath), { recursive: true });
        await fs.writeFile(paths.codexConfigPath, [
          'model_provider = "xwx_deck"',
          'model = "gpt-5.5"',
          '',
          '[model_providers.xwx_deck]',
          'name = "XwX Deck"',
          `base_url = "${externalBaseUrl}"`,
          'wire_api = "responses"',
          'requires_openai_auth = true',
          'supports_websockets = false',
          ''
        ].join('\n'));
        await fs.writeFile(paths.codexAuthPath, '{"auth_mode":"chatgpt","tokens":{"access_token":"qa-oauth"}}\n');
        await new XwXDeckSettingsStore(userData).update({
          tracingEnabled: true,
          clientEnabled: { claude: false, codex: true }
        });
        const controller = new XwXDeckController(userData, {
          proxyListenPorts: [0],
          disableBackgroundModelRefresh: true
        });
        await controller.start();
        const state = await controller.runtimeState();
        assert.equal(state.clients.find(client => client.id === 'codex-cli')?.status, 'taken');
        const tracedConfig = await fs.readFile(paths.codexConfigPath, 'utf8');
        assert.doesNotMatch(tracedConfig, new RegExp(`127\\.0\\.0\\.1:${address.port}`));
        assert.match(tracedConfig, /127\.0\.0\.1:\d+\/backend-api\/codex/);
        await controller.disable();
        assert.match(await fs.readFile(paths.codexConfigPath, 'utf8'), new RegExp(`127\\.0\\.0\\.1:${address.port}/backend-api/codex`));
        await controller.shutdown();
      } finally {
        await new Promise<void>(resolve => externalXwX.close(() => resolve()));
      }
    }

    // A live local service without the XwX fingerprint is not rewritten. The
    // UI receives the supported product-language boundary instead of internal
    // loopback/upstream terminology.
    {
      const base = path.join(root, 'controller-unknown-local-proxy');
      const userData = path.join(base, 'user-data');
      const paths = setClientEnvironment(base);
      const unknownProxy = http.createServer((_req, res) => {
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve, reject) => {
        unknownProxy.once('error', reject);
        unknownProxy.listen(0, '127.0.0.1', () => resolve());
      });
      try {
        const address = unknownProxy.address();
        assert.ok(address && typeof address !== 'string');
        const originalConfig = [
          'model_provider = "xwx_deck"',
          '',
          '[model_providers.xwx_deck]',
          `base_url = "http://127.0.0.1:${address.port}/backend-api/codex"`,
          'wire_api = "responses"',
          ''
        ].join('\n');
        await fs.mkdir(path.dirname(paths.codexConfigPath), { recursive: true });
        await fs.writeFile(paths.codexConfigPath, originalConfig);
        await fs.writeFile(paths.codexAuthPath, '{"auth_mode":"chatgpt"}\n');
        await new XwXDeckSettingsStore(userData).update({
          tracingEnabled: true,
          clientEnabled: { claude: false, codex: true }
        });
        const controller = new XwXDeckController(userData, {
          proxyListenPorts: [0],
          disableBackgroundModelRefresh: true
        });
        await controller.start();
        const state = await controller.runtimeState();
        const chatGpt = state.clients.find(client => client.id === 'codex-cli');
        assert.equal(chatGpt?.status, 'skipped');
        assert.equal(chatGpt?.detail, 'ChatGPT 暂未接入，XwX Deck 当前的连接方式无法与 Trace 同时使用。请先重启 XwX Deck，再重启 Trace 后重试。');
        assert.equal(await fs.readFile(paths.codexConfigPath, 'utf8'), originalConfig);
        await controller.shutdown();
      } finally {
        await new Promise<void>(resolve => unknownProxy.close(() => resolve()));
      }
    }

    // A dead XwX Deck address is repaired for the scoped Trace session.
    // Stopping Trace restores official direct service rather than retaining a
    // permanent XwX Deck dependency.
    {
      const base = path.join(root, 'controller-dead-local-proxy');
      const userData = path.join(base, 'user-data');
      const paths = setClientEnvironment(base);
      const reservation = net.createServer();
      await new Promise<void>((resolve, reject) => {
        reservation.once('error', reject);
        reservation.listen(0, '127.0.0.1', () => resolve());
      });
      const reservedAddress = reservation.address();
      assert.ok(reservedAddress && typeof reservedAddress !== 'string');
      const deadPort = reservedAddress.port;
      await new Promise<void>(resolve => reservation.close(() => resolve()));
      await fs.mkdir(path.dirname(paths.codexConfigPath), { recursive: true });
      await fs.writeFile(paths.codexConfigPath, [
        'model_provider = "xwx_deck"',
        '',
        '[model_providers.xwx_deck]',
        `base_url = "http://127.0.0.1:${deadPort}/backend-api/codex"`,
        'wire_api = "responses"',
        ''
      ].join('\n'));
      await fs.writeFile(paths.codexAuthPath, '{"auth_mode":"chatgpt"}\n');
      await new XwXDeckSettingsStore(userData).update({
        tracingEnabled: true,
        clientEnabled: { claude: false, codex: true }
      });
      const controller = new XwXDeckController(userData, {
        proxyListenPorts: [0],
        disableBackgroundModelRefresh: true
      });
      await controller.start();
      const traceState = await controller.runtimeState();
      assert.equal(traceState.clients.find(client => client.id === 'codex-cli')?.status, 'taken');
      await controller.disable();
      const repairedConfig = await fs.readFile(paths.codexConfigPath, 'utf8');
      assert.doesNotMatch(repairedConfig, new RegExp(`127\\.0\\.0\\.1:${deadPort}`));
      assert.ok(repairedConfig.includes(`base_url = "${traceState.localBaseUrl}/backend-api/codex"`),
        'stopping Trace keeps the healthy official fallback for tasks that cached the replacement endpoint');
      await controller.shutdown();
      assert.match(await fs.readFile(paths.codexConfigPath, 'utf8'), /base_url = "https:\/\/chatgpt\.com\/backend-api\/codex"/,
        'fully stopping the proxy restores official direct service');
    }
  } finally {
    if (previousClientHome === undefined) delete process.env.XWX_DECK_CLIENT_HOME;
    else process.env.XWX_DECK_CLIENT_HOME = previousClientHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeHome;
    if (previousIgnoreExternal === undefined) delete process.env.XWX_DECK_SMOKE_IGNORE_EXTERNAL;
    else process.env.XWX_DECK_SMOKE_IGNORE_EXTERNAL = previousIgnoreExternal;
  }
  completed.push('cold-start route-first transactions, crash recovery, auth rollback, and startup registration');
}

async function testCodexChatBridge(): Promise<void> {
  // --- Request: tool projection, param normalization, system collapse ---
  const request = responsesToChatCompletions({
    model: 'deepseek-coder', stream: true, instructions: 'be concise',
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: 'follow rules' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'fix it' }] }
    ],
    tools: [
      { type: 'function', name: 'shell', description: 'run', parameters: null },
      { type: 'local_shell' },
      { type: 'custom', name: 'apply_patch', description: 'edit files', format: { type: 'grammar', syntax: 'lark' } },
      { type: 'web_search' }
    ]
  });
  assert.equal(request.model, 'deepseek-coder');
  assert.equal(request.stream, true);
  assert.deepEqual((request.stream_options as Record<string, unknown>), { include_usage: true }, 'streaming requests must opt into usage');
  const messages = request.messages as Array<Record<string, any>>;
  // instructions + developer both collapse into a single leading system message.
  assert.equal(messages[0].role, 'system');
  assert.equal(messages.filter(m => m.role === 'system').length, 1, 'all system content collapses to head');
  assert.ok(String(messages[0].content).includes('be concise') && String(messages[0].content).includes('follow rules'));
  const tools = request.tools as Array<{ type: string; function: { name: string; parameters: Record<string, unknown> } }>;
  // local_shell / web_search are intentionally dropped; shell (function) + apply_patch (custom) survive.
  assert.deepEqual(tools.map(t => t.function.name), ['shell', 'apply_patch'], 'built-in local_shell/web_search dropped; function+custom kept');
  assert.equal(tools[0].function.parameters.type, 'object', 'null parameters normalized to object');
  // apply_patch is a freeform custom tool → wrapped with a single `input` string param.
  assert.deepEqual((tools[1].function.parameters as any).required, ['input']);
  assert.ok(String((tools[1].function as any).description).startsWith('Original tool definition:'));

  // --- Response: streaming fold accumulates reasoning + text ---
  const folded = chatSseToCompletion(
    'data: {"model":"deepseek-coder","choices":[{"delta":{"reasoning_content":"let me think"}}]}\n\n'
    + 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
    + 'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n'
    + 'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n'
    + 'data: [DONE]\n\n', 'fallback');
  const response = chatCompletionToResponse(folded, 'fallback');
  assert.equal(response.model, 'deepseek-coder');
  const out = response.output as Array<Record<string, any>>;
  assert.equal(out[0].type, 'reasoning', 'accumulated reasoning becomes a reasoning output item');
  assert.equal(out[0].summary[0].text, 'let me think');
  assert.equal(out[1].type, 'message');
  assert.equal(out[1].content[0].text, 'hello world');
  assert.equal((response.usage as any).input_tokens, 10);
  assert.equal((response.usage as any).output_tokens, 5);

  // --- Custom tool round-trip: request builds context, response restores custom_tool_call ---
  const patchReq = {
    model: 'deepseek-coder',
    tools: [{ type: 'custom', name: 'apply_patch', description: 'edit files' }],
    tool_choice: { type: 'custom', name: 'apply_patch' },
    input: 'go'
  };
  const patchChat = responsesToChatCompletions(patchReq);
  assert.equal((patchChat.tool_choice as any).function.name, 'apply_patch', 'custom tool_choice maps to function form');
  const patchContext = buildCodexToolContext(patchReq);
  const patchResponse = chatCompletionToResponse({
    model: 'deepseek-coder',
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch\\n*** End Patch"}' } }
    ] }, finish_reason: 'tool_calls' }]
  }, 'fallback', patchContext);
  const patchItem = (patchResponse.output as Array<Record<string, any>>).find(i => i.type === 'custom_tool_call');
  assert.ok(patchItem, 'custom tool call must be restored as custom_tool_call, not function_call');
  assert.equal(patchItem!.name, 'apply_patch');
  assert.equal(patchItem!.input, '*** Begin Patch\n*** End Patch', 'freeform input unwrapped from the JSON envelope');
  assert.equal(patchItem!.id, 'ctc_call_1');

  // --- MCP namespace + tool_search round-trip ---
  const nsReq = {
    model: 'deepseek-coder',
    tools: [{ type: 'tool_search' }],
    input: [{
      type: 'tool_search_output',
      tools: [{
        type: 'namespace', name: 'mcp__apps__gmail',
        tools: [{ type: 'function', name: '_search', parameters: { type: 'object', properties: { q: { type: 'string' } } } }]
      }]
    }]
  };
  const nsChat = responsesToChatCompletions(nsReq);
  const nsToolNames = (nsChat.tools as Array<any>).map(t => t.function.name);
  assert.ok(nsToolNames.includes('tool_search'));
  assert.ok(nsToolNames.includes('mcp__apps__gmail___search'), 'namespace tool flattened to ns__name');
  const nsContext = buildCodexToolContext(nsReq);
  const nsResponse = chatCompletionToResponse({
    model: 'deepseek-coder',
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'mcp__apps__gmail___search', arguments: '{"q":"hi"}' } }
    ] }, finish_reason: 'tool_calls' }]
  }, 'fallback', nsContext);
  const nsItem = (nsResponse.output as Array<Record<string, any>>).find(i => i.type === 'function_call');
  assert.equal(nsItem!.name, '_search', 'namespace tool name restored');
  assert.equal(nsItem!.namespace, 'mcp__apps__gmail', 'namespace field restored');

  // --- responses-lite (Codex Desktop 0.144+ / ChatGPT backend): tool declarations live in
  // an `input` item `{type:'additional_tools', role:'developer', tools:[...]}` instead of the
  // top-level `tools` field. Shape captured from a real Codex Desktop trace; one tool per variant.
  const liteReq = {
    model: 'gpt-5.6-sol',
    tool_choice: 'auto',
    parallel_tool_calls: true,
    input: [
      {
        type: 'additional_tools',
        role: 'developer',
        tools: [
          { type: 'custom', name: 'apply_patch', description: 'edit files', format: { type: 'grammar', syntax: 'lark', definition: 'start: patch' } },
          { type: 'function', name: 'shell_command', description: 'run a command', strict: false, parameters: { type: 'object', properties: { command: { type: 'string' } } } },
          { type: 'namespace', name: 'image_gen', description: 'image tools', tools: [{ type: 'function', name: 'create_image', description: 'draw', parameters: { type: 'object', properties: { prompt: { type: 'string' } } } }] },
          { type: 'tool_search', execution: 'client', description: 'Search and load tools.', parameters: { type: 'object', properties: { query: { type: 'string' } } } }
        ]
      },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the build' }] }
    ]
  };
  const liteChat = responsesToChatCompletions(liteReq);
  const liteNames = ((liteChat.tools as Array<any>) || []).map(t => t.function.name);
  assert.ok(liteNames.includes('apply_patch'), 'lite: custom tool declared via additional_tools');
  assert.ok(liteNames.includes('shell_command'), 'lite: function tool declared via additional_tools');
  assert.ok(liteNames.includes('image_gen__create_image'), 'lite: namespace tool flattened');
  assert.ok(liteNames.includes('tool_search'), 'lite: tool_search declared without a name field');
  const liteSystem = ((liteChat.messages as Array<any>) || []).filter(m => m.role === 'system');
  assert.ok(
    liteSystem.every(m => typeof m.content === 'string' ? m.content.trim() : (m.content ?? []).length),
    'lite: the additional_tools declaration item must not leak in as an empty system message'
  );
  const liteContext = buildCodexToolContext(liteReq);
  const liteRestored = chatCompletionToResponse({
    model: 'gpt-5.6-sol',
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch\\n*** End Patch"}' } }
    ] }, finish_reason: 'tool_calls' }]
  }, 'fallback', liteContext);
  const liteItem = (liteRestored.output as Array<Record<string, any>>).find(i => i.type === 'custom_tool_call');
  assert.ok(liteItem, 'lite: custom tool kind survives the round-trip through additional_tools');
  assert.equal(liteItem!.name, 'apply_patch');

  // --- Reasoning inference: kimi (thinking), gpt-5 (effort), deepseek (mapped) ---
  const kimi = responsesToChatCompletions({ model: 'kimi-k2', input: 'hi', reasoning: { effort: 'high' } });
  assert.deepEqual(kimi.thinking, { type: 'enabled' }, 'kimi maps reasoning to thinking:{enabled}');
  assert.equal(kimi.reasoning_effort, undefined, 'kimi has no effort param');
  const gpt5 = responsesToChatCompletions({ model: 'gpt-5.4', input: 'hi', reasoning: { effort: 'high' } });
  assert.equal(gpt5.reasoning_effort, 'high', 'gpt-5+ passes effort through (no provider config)');
  const dseek = responsesToChatCompletions({ model: 'deepseek-v3', input: 'hi', reasoning: { effort: 'xhigh' } });
  assert.equal(dseek.reasoning_effort, 'high', 'deepseek remaps xhigh→high per the documented effort table');
  assert.deepEqual(dseek.thinking, { type: 'enabled' });
  assert.equal(responsesToChatCompletions({ model: 'deepseek-v3', input: 'hi', reasoning: { effort: 'low' } }).reasoning_effort, 'low', 'deepseek remaps low→low');
  assert.equal(responsesToChatCompletions({ model: 'deepseek-v3', input: 'hi', reasoning: { effort: 'max' } }).reasoning_effort, 'max', 'deepseek remaps max→max');

  const verifiedDeepseek = responsesToChatCompletions(
    { model: 'DeepSeek_V4.Pro', input: 'hi', reasoning: { effort: 'xhigh' } },
    { useVerifiedCompatibleServiceReasoningProfile: true }
  );
  assert.deepEqual(verifiedDeepseek.thinking, { type: 'enabled' }, 'verified 兼容服务 profile normalizes model identifiers');
  assert.equal(verifiedDeepseek.reasoning_effort, 'xhigh', 'published levels pass through verbatim; folding them locally would recreate duplicate levels');
  const verifiedDeepseekLow = responsesToChatCompletions(
    { model: 'deepseek-v4-pro-0813', input: 'hi', reasoning: { effort: 'low' } },
    { useVerifiedCompatibleServiceReasoningProfile: true }
  );
  assert.deepEqual(verifiedDeepseekLow.thinking, { type: 'enabled' }, 'DeepSeek snapshot id still emits thinking toggle');
  assert.equal(verifiedDeepseekLow.reasoning_effort, 'low', 'DeepSeek snapshot id preserves low effort');
  const verifiedQwen = responsesToChatCompletions(
    { model: 'models/QWEN3_MAX', input: 'hi', reasoning: { effort: 'high' } },
    { useVerifiedCompatibleServiceReasoningProfile: true }
  );
  assert.deepEqual(verifiedQwen.thinking, { type: 'enabled' }, 'Qwen uses the thinking toggle: enable_thinking returns 200 while reasoning continues');
  assert.equal(verifiedQwen.reasoning_effort, 'high', 'Qwen carries the effort level alongside the toggle');
  assert.equal(verifiedQwen.enable_thinking, undefined, 'the silently-ignored field must not be sent');

  // The whole point of the convergence layer: two different levels must never
  // produce the same outbound body. Anything published has to survive this.
  for (const model of ['qwen3.7-max', 'glm-5.2', 'deepseek-v4-pro', 'kimi-k3', 'doubao-seed-2-1-pro', 'grok-4.6']) {
    const bodies = new Map<string, string>();
    const profile = resolveCompatibleServiceReasoningProfile(model);
    for (const level of profile.levels ?? []) {
      const converted = responsesToChatCompletions(
        { model, input: 'hi', reasoning: { effort: level } },
        { useVerifiedCompatibleServiceReasoningProfile: true }
      );
      const shape = JSON.stringify({
        thinking: converted.thinking,
        enable_thinking: converted.enable_thinking,
        reasoning_effort: converted.reasoning_effort
      });
      const clash = [...bodies.entries()].find(([, existing]) => existing === shape);
      assert.equal(clash, undefined, `${model}: levels "${clash?.[0]}" and "${level}" produce an identical request`);
      bodies.set(level, shape);
    }
    assert.ok((profile.levels?.length ?? 0) > 0, `${model} must publish at least one level`);
  }
  const verifiedProfiles = [
    ['openrouter/openai/GPT_5.4_NANO', 'reasoning_effort', 'high'],
    ['models/GLM_5.2', 'thinking', { type: 'enabled' }],
    ['zhipuai/GLM_5p2', 'thinking', { type: 'enabled' }],
    ['compatible/DeepSeek_V4.Pro', 'thinking', { type: 'enabled' }],
    ['KIMI_K2.6', 'thinking', { type: 'enabled' }],
    ['moonshot/KIMI_K2p5', 'thinking', { type: 'enabled' }],
    ['kimi-k3', 'thinking', { type: 'enabled' }],
    ['MiniMax_M3', 'thinking', { type: 'adaptive' }],
    ['doubao.seed.2.1', 'thinking', { type: 'enabled' }],
    ['grok-4.5', 'reasoning_effort', 'high'],
    ['grok-4.6', 'reasoning_effort', 'high']
  ] as const;
  for (const [model, field, expected] of verifiedProfiles) {
    const converted = responsesToChatCompletions(
      { model, input: 'hi', reasoning: { effort: 'high' } },
      { useVerifiedCompatibleServiceReasoningProfile: true }
    );
    assert.deepEqual(converted[field], expected, `${model} must use its verified 兼容服务 reasoning field`);
  }
  // GLM 5.3 always reasons: sending any disable form returns 400 upstream.
  const glm53Off = responsesToChatCompletions(
    { model: 'glm-5.3', input: 'hi', reasoning: { effort: 'none' } },
    { useVerifiedCompatibleServiceReasoningProfile: true }
  );
  assert.equal(glm53Off.thinking, undefined, 'glm-5.3 must never receive a disable toggle');
  assert.equal(glm53Off.enable_thinking, undefined);
  assert.deepEqual(
    resolveCompatibleServiceReasoningProfile('glm-5.3').levels,
    ['low', 'high', 'max'],
    'glm-5.3 rejects none and medium'
  );
  assert.equal(
    resolveCompatibleServiceReasoningProfile('grok-4.6').levels?.includes('none'),
    false,
    'Grok cannot express reasoning off: 4.6 rejects it and 4.5 ignores it'
  );
  for (const model of [
    'qwen3-coder-plus',
    'MiniMax-M2.7',
    'grok-4.20-0309-non-reasoning',
    'grok-4.20-0309-reasoning',
    'private/custom-reasoner'
  ]) {
    const converted = responsesToChatCompletions(
      { model, input: 'hi', reasoning: { effort: 'xhigh' } },
      { upstreamBaseUrl: 'https://deepseek.example/v1', useVerifiedCompatibleServiceReasoningProfile: true }
    );
    assert.equal(converted.thinking, undefined, `${model} must not inherit heuristic thinking`);
    assert.equal(converted.enable_thinking, undefined, `${model} must not inherit heuristic enable_thinking`);
    assert.equal(converted.reasoning_split, undefined, `${model} must not inherit heuristic reasoning_split`);
    assert.equal(converted.reasoning_effort, undefined, `${model} must not inherit heuristic reasoning_effort`);
    assert.equal(converted.reasoning, undefined, `${model} must not inherit nested reasoning effort`);
  }
  const qwenDisabled = responsesToChatCompletions(
    { model: 'qwen3.7-max', input: 'hi', reasoning: { effort: 'none' } },
    { useVerifiedCompatibleServiceReasoningProfile: true }
  );
  assert.deepEqual(qwenDisabled.thinking, { type: 'disabled' }, 'explicit reasoning off must disable Qwen thinking through the toggle');
  assert.equal(qwenDisabled.reasoning_effort, undefined, 'off is expressed by the toggle; DeepSeek and doubao-1.6 reject reasoning_effort:none');
  const nativeResponsesBody = { model: 'gpt-5.4', input: 'hi', reasoning: { effort: 'high' } };
  assert.deepEqual(
    nativeResponsesBody.reasoning,
    { effort: 'high' },
    'native Responses requests retain nested reasoning; only the Chat bridge flattens it'
  );

  // --- think-tag splitting on non-streaming content ---
  const thinkResp = chatCompletionToResponse({
    model: 'glm-4', choices: [{ index: 0, message: { role: 'assistant', content: '<think>pondering</think>final answer' }, finish_reason: 'stop' }]
  }, 'fallback');
  const thinkOut = thinkResp.output as Array<Record<string, any>>;
  assert.equal(thinkOut[0].type, 'reasoning');
  assert.equal(thinkOut[0].summary[0].text, 'pondering');
  assert.equal(thinkOut[1].content[0].text, 'final answer', 'think tags stripped from message text');
  assert.match(thinkOut[1].id, /^msg_xwx_[0-9a-f]{32}$/,
    'Chat Completions assistant messages must use a Responses-compatible msg_ ID');
  assert.doesNotMatch(thinkOut[1].id, /^resp_/);

  // --- finish_reason=length → incomplete ---
  const truncated = chatCompletionToResponse({
    model: 'glm-4', choices: [{ index: 0, message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }]
  }, 'fallback');
  assert.equal(truncated.status, 'incomplete');
  assert.deepEqual(truncated.incomplete_details, { reason: 'max_output_tokens' });

  // --- tool_choice dropped when no tools survive ---
  const noTools = responsesToChatCompletions({
    model: 'deepseek-coder', input: 'hi',
    tools: [{ type: 'local_shell' }], tool_choice: 'auto', parallel_tool_calls: true
  });
  assert.equal(noTools.tools, undefined);
  assert.equal(noTools.tool_choice, undefined, 'tool_choice dropped without a tools array');
  assert.equal(noTools.parallel_tool_calls, undefined);

  // --- SSE render exposes function_call arguments so Codex can execute the tool ---
  const sseOut = responseAsSse(nsResponse);
  assert.ok(sseOut.includes('response.function_call_arguments.done'), 'SSE must emit tool-call argument events');
  assert.ok(sseOut.includes('data: [DONE]'));

  // --- Error normalization: Chat Completions error bodies become Responses errors ---
  const openaiErr = chatErrorToResponseError({ error: { message: 'bad key', type: 'auth_error', code: 'invalid_api_key' } });
  assert.equal((openaiErr.error as any).message, 'bad key');
  assert.equal((openaiErr.error as any).type, 'auth_error');
  // MiniMax non-standard shape maps status_msg/status_code into the Responses error.
  const minimaxErr = chatErrorToResponseError({ base_resp: { status_code: 2013, status_msg: 'invalid params' } });
  assert.equal((minimaxErr.error as any).message, 'invalid params');
  assert.equal((minimaxErr.error as any).code, 2013);
  // Bare string / empty bodies never throw and still yield a Responses error object.
  assert.equal((chatErrorToResponseError('boom').error as any).message, 'boom');
  assert.equal((chatErrorToResponseError(undefined).error as any).type, 'upstream_error');
  // Streaming error render terminates the SSE so Codex stops cleanly.
  const errSse = errorAsResponsesSse(openaiErr);
  assert.ok(errSse.includes('response.failed'));
  assert.ok(errSse.includes('data: [DONE]'));

  // --- Compact codec + v1/v2 response contracts ---
  const compactRequest = {
    model: 'deepseek-chat',
    stream: true,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'keep this request' }] },
      { type: 'compaction_trigger' }
    ],
    tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }]
  };
  assert.equal(isCompactionTriggerRequest(compactRequest), true);
  const synthetic = buildSyntheticCompactionRequest(compactRequest);
  assert.equal(synthetic.stream, false);
  assert.deepEqual(synthetic.tools, []);
  assert.equal((synthetic.input as unknown[]).length, 1);
  assert.match(String(synthetic.instructions), /CONTEXT CHECKPOINT COMPACTION/);
  const envelope = encodeCompactionSummary('finished A; next B');
  assert.equal(decodeCompactionSummary(envelope), 'finished A; next B');
  assert.match(compactionItemToChatText(envelope), /finished A; next B/);
  assert.match(compactionItemToChatText('opaque-openai-value'), /cannot be decoded/);
  const replayChat = responsesToChatCompletions({
    model: 'deepseek-chat',
    input: [{ type: 'compaction', encrypted_content: envelope }]
  });
  assert.match(String((replayChat.messages as Array<any>)[0].content), new RegExp(XwX_COMPACTION_SUMMARY_PREFIX));
  const compactV1 = buildStandaloneCompactionResponse(compactRequest, 'handoff', { input_tokens: 8, output_tokens: 3, total_tokens: 11 });
  assert.equal(compactV1.object, 'response.compaction');
  assert.match(JSON.stringify(compactV1.output), /keep this request/);
  assert.match(JSON.stringify(compactV1.output), /handoff/);
  const compactV2 = buildRemoteCompactionResponse('deepseek-chat', 'handoff', { input_tokens: 8, output_tokens: 3 });
  assert.equal((compactV2.output as Array<any>).length, 1);
  assert.equal((compactV2.output as Array<any>)[0].type, 'compaction');
  assert.equal(decodeCompactionSummary((compactV2.output as Array<any>)[0].encrypted_content), 'handoff');

  completed.push('Codex Responses-to-Chat compatibility bridge');
}

async function testCodexConversationPortability(): Promise<void> {
  const stateFile = path.join(root, 'codex-portability', 'opaque-origins.json');
  const codexHome = path.join(root, 'codex-portability', 'codex-home');
  const portability = new CodexConversationPortability(stateFile, codexHome);
  const official = codexUpstreamIdentity({
    kind: 'official',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    accountId: 'acct-a'
  });
  const compatible = codexUpstreamIdentity({
    kind: 'compatible',
    baseUrl: 'https://compatible.example/v1',
    credential: 'compatible-secret'
  });
  const officialReasoning = 'official-reasoning-ciphertext';
  const officialCompaction = 'official-compaction-ciphertext';

  await portability.observeResponse({
    output: [
      { type: 'reasoning', encrypted_content: officialReasoning },
      { type: 'compaction', encrypted_content: officialCompaction }
    ]
  }, official);

  const sameOfficial = await portability.prepareRequest({
    input: [
      { type: 'reasoning', encrypted_content: officialReasoning },
      { type: 'compaction', encrypted_content: officialCompaction }
    ]
  }, { target: official, wireProtocol: 'responses' });
  assert.equal(sameOfficial.removedReasoning, 0);
  assert.equal(sameOfficial.replacedCompactions, 0);

  const legacyBridgeHistory = {
    input: [
      {
        type: 'message',
        id: 'resp_chatcmpl_xwx_2efb3e36-a7a3-4bd8-9400-70b5f7216a02_msg',
        role: 'assistant',
        content: [{ type: 'output_text', text: '兼容服务 Chat response' }]
      },
      {
        type: 'message',
        id: 'resp_msg_anthropic_answer_msg_2',
        role: 'assistant',
        content: [{ type: 'output_text', text: '兼容服务 Anthropic response' }]
      },
      { type: 'message', id: 'msg_native_official', role: 'assistant', content: 'native official response' },
      { type: 'message', id: 'custom_invalid_id', role: 'user', content: 'leave unknown ids untouched' }
    ]
  };
  const normalizedOfficial = await portability.prepareRequest(legacyBridgeHistory, {
    target: official,
    wireProtocol: 'responses'
  });
  assert.equal(normalizedOfficial.normalizedMessageIds, 2);
  const normalizedOfficialInput = (normalizedOfficial.body as Record<string, any>).input as Array<Record<string, any>>;
  assert.match(normalizedOfficialInput[0].id, /^msg_xwx_[0-9a-f]{32}$/);
  assert.match(normalizedOfficialInput[1].id, /^msg_xwx_[0-9a-f]{32}$/);
  assert.equal(normalizedOfficialInput[2].id, 'msg_native_official');
  assert.equal(normalizedOfficialInput[3].id, 'custom_invalid_id',
    'official portability must only rewrite IDs emitted by the legacy XwX bridges');
  assert.match(JSON.stringify(normalizedOfficial.body), /兼容服务 Chat response/);
  assert.match(JSON.stringify(normalizedOfficial.body), /兼容服务 Anthropic response/);

  const syntheticChatReasoningId = 'rs_resp_chatcmpl_xwx_197a83cc-0dd3-4dd2-bed6-441c11190c64';
  const syntheticChatHistory = {
    store: false,
    input: [
      {
        type: 'reasoning',
        id: syntheticChatReasoningId,
        summary: [{ type: 'summary_text', text: '兼容服务 bridge reasoning summary' }],
        encrypted_content: null
      },
      {
        type: 'message',
        id: 'msg_xwx_652e8500d197fa00b3a80c0edd455ce1',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Keep the 兼容服务 assistant reply' }]
      },
      { type: 'message', role: 'user', content: 'continue on official with store false' }
    ]
  };
  const sanitizedSyntheticChatHistory = await portability.prepareRequest(syntheticChatHistory, {
    target: official,
    wireProtocol: 'responses'
  });
  assert.equal(sanitizedSyntheticChatHistory.removedReasoning, 1);
  assert.doesNotMatch(JSON.stringify(sanitizedSyntheticChatHistory.body), new RegExp(syntheticChatReasoningId));
  assert.match(JSON.stringify(sanitizedSyntheticChatHistory.body), /Keep the 兼容服务 assistant reply/);
  assert.match(JSON.stringify(sanitizedSyntheticChatHistory.body), /continue on official with store false/);

  const sanitizedCompatibleServiceResponsesReasoning = await portability.prepareRequest(syntheticChatHistory, {
    target: compatible,
    wireProtocol: 'responses'
  });
  assert.equal(sanitizedCompatibleServiceResponsesReasoning.removedReasoning, 1);
  assert.doesNotMatch(JSON.stringify(sanitizedCompatibleServiceResponsesReasoning.body), new RegExp(syntheticChatReasoningId));
  assert.match(JSON.stringify(sanitizedCompatibleServiceResponsesReasoning.body), /Keep the 兼容服务 assistant reply/);

  const unchangedCompatibleServiceSyntheticReasoning = await portability.prepareRequest(syntheticChatHistory, {
    target: compatible,
    wireProtocol: 'chat-completions'
  });
  assert.equal(unchangedCompatibleServiceSyntheticReasoning.body, syntheticChatHistory,
    'converted 兼容服务 Chat routes may continue consuming the bridge reasoning summary they created');

  const unchangedCompatibleServiceMessages = await portability.prepareRequest(legacyBridgeHistory, {
    target: compatible,
    wireProtocol: 'chat-completions'
  });
  assert.equal(unchangedCompatibleServiceMessages.body, legacyBridgeHistory,
    'legacy message IDs only need normalization before the strict official Responses API');

  await portability.markProviderTransition('official', 'compatible');
  const stringInputTransition = await portability.prepareRequest({ input: 'continue' }, {
    target: compatible,
    wireProtocol: 'responses'
  });
  assert.deepEqual(stringInputTransition.providerTransition, { source: 'official', target: 'compatible' },
    'provider transition observability must not depend on Responses input using the array form');
  assert.equal(await portability.acknowledgeProviderTransition(compatible), true);

  const compatibleResult = await portability.prepareRequest({
    input: [
      { type: 'reasoning', id: 'rs_official', encrypted_content: officialReasoning },
      { type: 'compaction', encrypted_content: officialCompaction },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] }
    ]
  }, { target: compatible, wireProtocol: 'responses' });
  assert.equal(compatibleResult.removedReasoning, 1);
  assert.equal(compatibleResult.replacedCompactions, 1);
  const compatibleInput = (compatibleResult.body as Record<string, any>).input as Array<Record<string, any>>;
  assert.equal(compatibleInput.some(item => item.type === 'reasoning'), false);
  assert.match(JSON.stringify(compatibleInput[0]), /opaque checkpoint could not be decoded/);
  assert.match(JSON.stringify(compatibleInput.at(-1)), /continue/);

  const threadId = '019ff520-b112-7622-b1d3-b1e202e23dd0';
  const rolloutDir = path.join(codexHome, 'sessions', '2026', '08', '12');
  const rolloutFile = path.join(rolloutDir, `rollout-2026-08-12T16-39-48-${threadId}.jsonl`);
  await fs.mkdir(rolloutDir, { recursive: true });
  await fs.writeFile(rolloutFile, [
    JSON.stringify({
      type: 'compacted',
      payload: {
        message: 'Current Codex plain-text checkpoint',
        replacement_history: []
      }
    }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: 'delta after checkpoint' }
    }),
    ''
  ].join('\n'));
  const recoveredCheckpoint = await portability.prepareRequest({
    input: [{ type: 'compaction', encrypted_content: officialCompaction }]
  }, { target: compatible, wireProtocol: 'responses', threadId });
  assert.equal(recoveredCheckpoint.checkpointSource, 'compacted_message');
  assert.match(JSON.stringify(recoveredCheckpoint.body), /Current Codex plain-text checkpoint/);
  assert.doesNotMatch(
    JSON.stringify(recoveredCheckpoint.body),
    /delta after checkpoint/,
    'foreign compaction replacement uses the summary only because the request already carries its retained tail'
  );
  assert.doesNotMatch(JSON.stringify(recoveredCheckpoint.body), /official-compaction-ciphertext/);
  const checkpointIndex = JSON.parse(await fs.readFile(
    path.join(path.dirname(stateFile), 'portable-checkpoints.json'),
    'utf8'
  )) as Record<string, any>;
  assert.ok(checkpointIndex.entries[threadId].coveredThroughBytes > 0);
  await fs.appendFile(rolloutFile, `${JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: 'new tail only' }
  })}\n`);
  const incrementalCheckpoint = await portability.prepareRequest({
    previous_response_id: 'foreign-response-id',
    input: [{ type: 'message', role: 'user', content: 'current turn' }]
  }, { target: compatible, wireProtocol: 'responses', threadId, recoverContinuation: true });
  assert.match(JSON.stringify(incrementalCheckpoint.body), /delta after checkpoint/);
  assert.match(JSON.stringify(incrementalCheckpoint.body), /new tail only/);

  const replacementThreadId = '019ff520-b112-7622-b1d3-b1e202e23dd1';
  const replacementRollout = path.join(rolloutDir, `rollout-2026-08-12T16-39-49-${replacementThreadId}.jsonl`);
  const replacementSummary = 'Another language model started to solve this problem. Recovered replacement checkpoint.';
  await fs.writeFile(replacementRollout, `${JSON.stringify({
    type: 'compacted',
    payload: {
      message: '',
      replacement_history: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: replacementSummary }]
      }]
    }
  })}\n`);
  const replacementCheckpoint = await portability.prepareRequest({
    input: [{ type: 'compaction', encrypted_content: officialCompaction }]
  }, { target: compatible, wireProtocol: 'responses', threadId: replacementThreadId });
  assert.equal(replacementCheckpoint.checkpointSource, 'replacement_history');
  assert.match(JSON.stringify(replacementCheckpoint.body), /Recovered replacement checkpoint/);

  const xwxSummary = encodeCompactionSummary('portable handoff');
  const xwxResult = await portability.prepareRequest({
    input: [{ type: 'compaction', encrypted_content: xwxSummary }]
  }, { target: official, wireProtocol: 'responses' });
  assert.match(JSON.stringify((xwxResult.body as Record<string, any>).input), /portable handoff/);
  assert.doesNotMatch(JSON.stringify(xwxResult.body), /xwxc1:/);

  const anthropicEnvelope = encodeAnthropicThinkingEnvelope({
    type: 'thinking',
    thinking: 'provider-private state',
    signature: 'signed-by-anthropic'
  });
  assert(anthropicEnvelope);
  const anthropicSame = await portability.prepareRequest({
    input: [{ type: 'reasoning', encrypted_content: anthropicEnvelope }]
  }, { target: compatible, wireProtocol: 'anthropic-messages' });
  assert.equal(anthropicSame.removedReasoning, 0);
  const anthropicForeign = await portability.prepareRequest({
    input: [{ type: 'reasoning', encrypted_content: anthropicEnvelope }]
  }, { target: official, wireProtocol: 'responses' });
  assert.equal(anthropicForeign.removedReasoning, 1);

  const compatibleReasoning = 'compatible-reasoning-ciphertext';
  const compatibleCompaction = 'compatible-compaction-ciphertext';
  await portability.observeResponse({
    output: [
      { type: 'reasoning', encrypted_content: compatibleReasoning },
      { type: 'compaction', encrypted_content: compatibleCompaction }
    ]
  }, compatible);
  const backToOfficial = await portability.prepareRequest({
    input: [
      { type: 'reasoning', encrypted_content: compatibleReasoning },
      { type: 'compaction', encrypted_content: compatibleCompaction },
      { type: 'message', role: 'user', content: 'continue back on official' }
    ]
  }, { target: official, wireProtocol: 'responses' });
  assert.equal(backToOfficial.removedReasoning, 1, '兼容服务 reasoning must not reach official ChatGPT');
  assert.equal(backToOfficial.replacedCompactions, 1, '兼容服务 compaction must become plain text for official ChatGPT');
  assert.doesNotMatch(JSON.stringify(backToOfficial.body), /compatible-(reasoning|compaction)-ciphertext/);
  assert.match(JSON.stringify(backToOfficial.body), /continue back on official/);

  const invalidated = await portability.noteUpstreamFailure(
    compatible,
    'invalid_encrypted_content: encrypted content could not be verified'
  );
  assert.equal(invalidated, 2);
  const afterCompatibleServiceRestart = await portability.prepareRequest({
    input: [
      { type: 'reasoning', encrypted_content: compatibleReasoning },
      { type: 'compaction', encrypted_content: compatibleCompaction }
    ]
  }, { target: compatible, wireProtocol: 'responses' });
  assert.equal(afterCompatibleServiceRestart.removedReasoning, 1);
  assert.equal(afterCompatibleServiceRestart.replacedCompactions, 1);

  const restarted = new CodexConversationPortability(stateFile, codexHome);
  const afterRestart = await restarted.prepareRequest({
    input: [{ type: 'reasoning', encrypted_content: officialReasoning }]
  }, { target: compatible, wireProtocol: 'responses' });
  assert.equal(afterRestart.removedReasoning, 1, 'opaque origin index must survive XwX restart');

  const legacyUnknownReasoning = 'legacy-compatible-reasoning-without-origin-index';
  const legacyUnknownCompaction = 'legacy-compatible-compaction-without-origin-index';
  const legacyRequest = {
    input: [
      { type: 'reasoning', encrypted_content: legacyUnknownReasoning },
      { type: 'compaction', encrypted_content: legacyUnknownCompaction },
      { type: 'message', role: 'user', content: 'continue legacy conversation' }
    ]
  };
  const firstOfficialAttempt = await restarted.prepareRequest(legacyRequest, {
    target: official,
    wireProtocol: 'responses',
    threadId
  });
  assert.equal(firstOfficialAttempt.removedReasoning, 0, 'pre-index official history remains compatible until explicitly rejected');
  assert.equal(await restarted.quarantineRejectedRequest(legacyRequest, official), 2);
  const officialRetry = await restarted.prepareRequest(legacyRequest, {
    target: official,
    wireProtocol: 'responses',
    threadId
  });
  assert.equal(officialRetry.removedReasoning, 1);
  assert.equal(officialRetry.replacedCompactions, 1);
  assert.match(JSON.stringify(officialRetry.body), /Current Codex plain-text checkpoint/);
  assert.doesNotMatch(JSON.stringify(officialRetry.body), /legacy-compatible-(reasoning|compaction)/);

  const rejectedRepairFile = path.join(rolloutDir, 'rollout-portability-rejected-after-restart.jsonl');
  await fs.writeFile(rejectedRepairFile, [
    JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: legacyUnknownReasoning } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'compaction', encrypted_content: legacyUnknownCompaction } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'survives rejected repair' } }),
    ''
  ].join('\n'));
  const restartedAfterRejection = new CodexConversationPortability(stateFile, codexHome);
  const rejectedRepair = await restartedAfterRejection.repairLocalHistory('official');
  assert.equal(rejectedRepair.changedFiles, 1,
    'a target rejection must remain actionable after the Gateway helper restarts');
  assert.equal(rejectedRepair.removedItems, 2);
  const rejectedRepairResult = await fs.readFile(rejectedRepairFile, 'utf8');
  assert.doesNotMatch(rejectedRepairResult, /legacy-compatible-(reasoning|compaction)/);
  assert.match(rejectedRepairResult, /survives rejected repair/);

  const persistentRepairFile = path.join(rolloutDir, 'rollout-portability-persistent-repair.jsonl');
  const persistentRepairSource = [
    JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', id: 'rs_official_keep', encrypted_content: officialReasoning } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', id: 'rs_compatible_remove', encrypted_content: compatibleReasoning } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'compaction', encrypted_content: compatibleCompaction } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'must remain exactly' }] } }),
    ''
  ].join('\n');
  await fs.writeFile(persistentRepairFile, persistentRepairSource);
  const repair = await portability.repairLocalHistory('official');
  assert.equal(repair.changedFiles, 1);
  assert.equal(repair.removedItems, 2);
  assert(repair.backupRoot);
  const persistentRepairResult = await fs.readFile(persistentRepairFile, 'utf8');
  assert.match(persistentRepairResult, /rs_official_keep/);
  assert.match(persistentRepairResult, /must remain exactly/);
  assert.doesNotMatch(persistentRepairResult, /rs_compatible_remove|compatible-compaction-ciphertext/);
  const persistentRepairBackup = await fs.readFile(
    path.join(repair.backupRoot, 'jsonl', path.relative(codexHome, persistentRepairFile)),
    'utf8'
  );
  assert.equal(persistentRepairBackup, persistentRepairSource, 'persistent repair backup must restore the exact original JSONL');
  const repairManifest = JSON.parse(await fs.readFile(path.join(repair.backupRoot, 'manifest.json'), 'utf8')) as any;
  assert.equal(repairManifest.files[0].removedItems, 2);

  const messageIdRepairHome = path.join(root, 'codex-message-id-repair', 'codex-home');
  const messageIdRepairFile = path.join(
    messageIdRepairHome,
    'sessions',
    '2026',
    '08',
    '14',
    'rollout-legacy-message-id.jsonl'
  );
  const legacyRolloutMessageId = 'resp_chatcmpl_xwx_2efb3e36-a7a3-4bd8-9400-70b5f7216a02_msg';
  const syntheticRolloutReasoningId = 'rs_resp_chatcmpl_xwx_197a83cc-0dd3-4dd2-bed6-441c11190c64';
  const messageIdRepairSource = [
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'reasoning',
        id: syntheticRolloutReasoningId,
        summary: [{ type: 'summary_text', text: 'unreplayable local bridge reasoning' }]
      }
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        id: legacyRolloutMessageId,
        role: 'assistant',
        content: [{ type: 'output_text', text: 'preserve this reply after restart' }]
      }
    }),
    ''
  ].join('\n');
  await fs.mkdir(path.dirname(messageIdRepairFile), { recursive: true });
  await fs.writeFile(messageIdRepairFile, messageIdRepairSource);
  const messageIdRepair = new CodexConversationPortability(
    path.join(root, 'codex-message-id-repair', 'opaque-origins.json'),
    messageIdRepairHome
  );
  assert.deepEqual(
    await messageIdRepair.repairLocalHistory('compatible'),
    { changedFiles: 0, removedItems: 0 },
    '兼容服务 history stays untouched because its bridge accepts the legacy IDs'
  );
  const normalizedLocalHistory = await messageIdRepair.repairLocalHistory('official');
  assert.equal(normalizedLocalHistory.changedFiles, 1);
  assert.equal(normalizedLocalHistory.removedItems, 1);
  assert.equal(normalizedLocalHistory.removedUnencryptedReasoningItems, 1);
  assert.equal(normalizedLocalHistory.normalizedMessageIds, 1);
  assert(normalizedLocalHistory.backupRoot);
  const normalizedLocalHistoryText = await fs.readFile(messageIdRepairFile, 'utf8');
  assert.doesNotMatch(normalizedLocalHistoryText, new RegExp(legacyRolloutMessageId));
  assert.doesNotMatch(normalizedLocalHistoryText, new RegExp(syntheticRolloutReasoningId));
  assert.match(normalizedLocalHistoryText, /"id":"msg_xwx_[0-9a-f]{32}"/);
  assert.match(normalizedLocalHistoryText, /preserve this reply after restart/);
  assert.equal(
    await fs.readFile(
      path.join(normalizedLocalHistory.backupRoot, 'jsonl', path.relative(messageIdRepairHome, messageIdRepairFile)),
      'utf8'
    ),
    messageIdRepairSource,
    'message ID history repair must back up the exact original rollout before atomic replacement'
  );
  const messageIdRepairState = JSON.parse(await fs.readFile(
    path.join(root, 'codex-message-id-repair', 'opaque-origins.json'),
    'utf8'
  )) as Record<string, unknown>;
  assert.equal(messageIdRepairState.legacyMessageIdHistoryNormalized, true,
    'the one-time history migration marker must prevent full rollout scans on every later shutdown');
  assert.equal(messageIdRepairState.unreplayableReasoningHistorySanitized, true,
    'the one-time history migration marker must cover unreplayable reasoning rows after helper restart');
  assert.deepEqual(
    await new CodexConversationPortability(
      path.join(root, 'codex-message-id-repair', 'opaque-origins.json'),
      messageIdRepairHome
    ).repairLocalHistory('official'),
    { changedFiles: 0, removedItems: 0 },
    'message ID history repair must remain idempotent after a helper restart'
  );

  const legacyStateFile = path.join(root, 'codex-portability-v1', 'opaque-origins.json');
  await fs.mkdir(path.dirname(legacyStateFile), { recursive: true });
  await fs.writeFile(legacyStateFile, JSON.stringify({
    version: 1,
    entries: {
      [crypto.createHash('sha256').update('known-old-compatible-reasoning').digest('hex')]: {
        upstream: compatible.key,
        kind: 'reasoning',
        seenAt: Date.now()
      }
    }
  }));
  const migratedV1 = new CodexConversationPortability(legacyStateFile, codexHome);
  assert.equal(await migratedV1.adoptProviderOnStartup('official'), false,
    'legacy official startup may classify indexed entries but must not create an unknown-item cleanup window');
  const firstPostInstallCompact = await migratedV1.prepareRequest(legacyRequest, {
    target: official,
    wireProtocol: 'responses',
    threadId
  });
  assert.equal(firstPostInstallCompact.providerTransitionActive, undefined);
  assert.equal(firstPostInstallCompact.removedReasoning, 0,
    'official startup must preserve unknown native OpenAI reasoning');
  assert.equal(firstPostInstallCompact.replacedCompactions, 0,
    'official startup must preserve unknown native OpenAI compaction');
  assert.equal(firstPostInstallCompact.body, legacyRequest,
    'an unknown official history request must remain byte-stable through portability');
  const restartedDuringTransition = new CodexConversationPortability(legacyStateFile, codexHome);
  assert.equal(await restartedDuringTransition.adoptProviderOnStartup('official'), false,
    'official startup must remain free of an aggressive 兼容服务-to-official transition');
  const firstAfterXwXRestart = await restartedDuringTransition.prepareRequest(legacyRequest, {
    target: official,
    wireProtocol: 'responses',
    threadId
  });
  assert.equal(firstAfterXwXRestart.providerTransitionActive, undefined);
  assert.equal(await restartedDuringTransition.acknowledgeProviderTransition(official), false);
  const nativeOfficialAfterSuccess = await restartedDuringTransition.prepareRequest({
    input: [{ type: 'reasoning', encrypted_content: 'unknown-native-official-after-success' }]
  }, { target: official, wireProtocol: 'responses' });
  assert.equal(nativeOfficialAfterSuccess.removedReasoning, 0, 'successful first request must restore legacy official compatibility');
  const staleOfficialTransitionFile = path.join(root, 'codex-portability-stale-official', 'opaque-origins.json');
  await fs.mkdir(path.dirname(staleOfficialTransitionFile), { recursive: true });
  await fs.writeFile(staleOfficialTransitionFile, JSON.stringify({
    version: 3,
    entries: {},
    transition: { source: 'compatible', target: 'official', createdAt: Date.now() }
  }));
  const staleOfficialTransition = new CodexConversationPortability(staleOfficialTransitionFile, codexHome);
  assert.equal(await staleOfficialTransition.adoptProviderOnStartup('official'), false);
  assert.equal(
    (JSON.parse(await fs.readFile(staleOfficialTransitionFile, 'utf8')) as any).transition,
    undefined,
    'startup must remove the exact stale transition left by the broken official cleanup build'
  );
  const legacyRestoreRoot = path.join(root, 'codex-portability-legacy-restore');
  const legacyRestoreState = path.join(legacyRestoreRoot, 'xwxdeck', 'codex-portability', 'opaque-origins.json');
  const legacyRestoreHome = path.join(legacyRestoreRoot, 'codex-home');
  const legacyRestoreRelative = path.join('sessions', '2026', '08', '12', 'rollout-legacy-restore.jsonl');
  const legacyRestoreFile = path.join(legacyRestoreHome, legacyRestoreRelative);
  const legacyRestoreMessageId = 'resp_chatcmpl_xwx_legacy_restore_msg';
  const normalizedLegacyRestoreMessageId = `msg_xwx_${crypto.createHash('sha256').update(legacyRestoreMessageId).digest('hex').slice(0, 32)}`;
  const originalLines = [
    `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'before' } })}\n`,
    `${JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'mistakenly-removed-official' } })}\n`,
    `${JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'confirmed-compatible-remove' } })}\n`,
    `${JSON.stringify({ type: 'response_item', payload: { type: 'message', id: legacyRestoreMessageId, role: 'assistant', content: 'after' } })}\n`
  ];
  const normalizedLegacyRestoreLine = `${JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', id: normalizedLegacyRestoreMessageId, role: 'assistant', content: 'after' }
  })}\n`;
  const appendedLine = `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'appended later' } })}\n`;
  await fs.mkdir(path.dirname(legacyRestoreState), { recursive: true });
  await fs.mkdir(path.dirname(legacyRestoreFile), { recursive: true });
  await fs.writeFile(legacyRestoreState, JSON.stringify({
    version: 3,
    entries: {
      [crypto.createHash('sha256').update('mistakenly-removed-official').digest('hex')]: {
        upstream: 'transition:compatible',
        upstreamKind: 'compatible',
        kind: 'reasoning',
        seenAt: Date.now()
      },
      [crypto.createHash('sha256').update('confirmed-compatible-remove').digest('hex')]: {
        upstream: compatible.key,
        upstreamKind: 'compatible',
        kind: 'reasoning',
        seenAt: Date.now()
      }
    },
    transition: { source: 'compatible', target: 'official', createdAt: Date.now() }
  }));
  await fs.writeFile(legacyRestoreFile, `${originalLines[0]}${normalizedLegacyRestoreLine}${appendedLine}`);
  const mistakenRepairGeneration = path.join(
    legacyRestoreRoot,
    'xwxdeck',
    'backups',
    'codex-portability-repair-v1',
    'broken-generation'
  );
  const mistakenRepairBackup = path.join(mistakenRepairGeneration, 'jsonl', legacyRestoreRelative);
  await fs.mkdir(path.dirname(mistakenRepairBackup), { recursive: true });
  await fs.writeFile(mistakenRepairBackup, originalLines.join(''));
  await fs.writeFile(path.join(mistakenRepairGeneration, 'manifest.json'), JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    codexHome: legacyRestoreHome,
    targetKind: 'official',
    files: [{ relativePath: legacyRestoreRelative, removedItems: 2, normalizedMessageIds: 1 }]
  }));
  const legacyRestore = new CodexConversationPortability(legacyRestoreState, legacyRestoreHome);
  assert.equal(await legacyRestore.adoptProviderOnStartup('official'), false);
  const restoredLegacy = await legacyRestore.restoreLegacyOfficialHistory();
  assert.equal(restoredLegacy.changedFiles, 1);
  assert.equal(restoredLegacy.restoredItems, 1);
  assert.equal(
    await fs.readFile(legacyRestoreFile, 'utf8'),
    `${originalLines[0]}${originalLines[1]}${normalizedLegacyRestoreLine}${appendedLine}`,
    'legacy restore must reinsert only the transition-guessed item, retain normalized messages and later turns, and keep confirmed 兼容服务 state removed'
  );
  assert(restoredLegacy.backupRoot);
  assert.equal(
    await fs.readFile(path.join(restoredLegacy.backupRoot, 'jsonl', legacyRestoreRelative), 'utf8'),
    `${originalLines[0]}${normalizedLegacyRestoreLine}${appendedLine}`,
    'legacy restore must back up the exact current file before changing it'
  );
  assert.deepEqual(await legacyRestore.restoreLegacyOfficialHistory(), { changedFiles: 0, restoredItems: 0 },
    'legacy restore must be one-time and idempotent');
  assert.equal((JSON.parse(await fs.readFile(legacyStateFile, 'utf8')) as any).version, 3);
  const saved = JSON.parse(await fs.readFile(stateFile, 'utf8')) as Record<string, unknown>;
  assert.doesNotMatch(
    JSON.stringify(saved),
    /official-reasoning-ciphertext|compatible-secret|acct-a|compatible\.example|chatgpt\.com/
  );

  completed.push('Codex cross-provider conversation portability');
}

async function testResponsesContinuationStore(): Promise<void> {
  const stateFile = path.join(root, 'responses-continuations', 'cache.json');
  const store = new ResponsesContinuationStore(stateFile);
  const official = codexUpstreamIdentity({
    kind: 'official',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    accountId: 'account-a'
  });
  const compatible = codexUpstreamIdentity({
    kind: 'compatible',
    baseUrl: 'https://compatible.example/v1',
    credential: 'secret-a'
  });
  const firstRequest = {
    model: 'gpt-test',
    input: [{ type: 'message', role: 'user', content: 'inspect the project' }]
  };
  const firstResponse = {
    id: 'resp_first',
    output: [
      { type: 'reasoning', encrypted_content: 'must-not-be-persisted' },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"README.md"}' }
    ]
  };
  assert.equal(await store.recordResponse(firstRequest, firstResponse, official), true);
  const toolRequest = {
    model: 'gpt-test',
    previous_response_id: 'resp_first',
    input: [{ type: 'function_call_output', call_id: 'call_1', output: 'project contents' }]
  };
  const sameProvider = await store.prepareRequest(toolRequest, official, 'responses');
  assert.equal(sameProvider.body, toolRequest, 'native Responses continuation remains byte-stable on the same upstream');

  await store.markProviderTransition('official', 'compatible');
  const switched = await store.prepareRequest(toolRequest, compatible, 'chat-completions');
  assert.equal(switched.droppedPreviousResponseId, true);
  assert.equal(switched.expandedResponses, 1);
  assert.equal((switched.body as Record<string, unknown>).previous_response_id, undefined);
  const switchedInput = (switched.body as Record<string, any>).input as Array<Record<string, any>>;
  assert.equal(switchedInput.filter(item => item.type === 'function_call').length, 1);
  assert.equal(switchedInput.filter(item => item.type === 'function_call_output').length, 1);
  assert.doesNotMatch(JSON.stringify(switched.body), /must-not-be-persisted/);
  assert.equal(await store.acknowledgeProviderTransition(compatible), true);

  await store.markProviderTransition('official', 'compatible');
  const oldUnknown = await store.prepareRequest({
    previous_response_id: 'resp_from_older_version',
    input: [{ type: 'message', role: 'user', content: 'portable current turn' }]
  }, compatible, 'responses');
  assert.equal(oldUnknown.droppedPreviousResponseId, true);
  assert.equal(oldUnknown.unresolvedContinuation, true);
  assert.match(JSON.stringify(oldUnknown.body), /portable current turn/);
  assert.doesNotMatch(JSON.stringify(oldUnknown.body), /resp_from_older_version/);
  assert.equal(await store.acknowledgeProviderTransition(compatible), true);

  await store.markProviderTransition('compatible', 'official');
  const switchBackWithoutContinuationRequest = {
    input: [{ type: 'message', role: 'user', content: 'switch back without previous response id' }]
  };
  const switchedBackWithoutContinuation = await store.prepareRequest(
    switchBackWithoutContinuationRequest,
    official,
    'responses'
  );
  assert.deepEqual(switchedBackWithoutContinuation.providerTransition, {
    source: 'compatible',
    target: 'official'
  }, 'provider transition observability must cover the safe 兼容服务-to-official direction without a continuation id');
  assert.equal(switchedBackWithoutContinuation.body, switchBackWithoutContinuationRequest,
    'observing a switch back to official must keep a request without continuation state byte-stable');
  assert.equal(await store.acknowledgeProviderTransition(official), true);

  const secondResponse = {
    id: 'resp_second',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }]
  };
  assert.equal(await store.recordResponse(toolRequest, secondResponse, official), true);
  const chained = await store.prepareRequest({
    model: 'gpt-test',
    previous_response_id: 'resp_second',
    input: [{ type: 'message', role: 'user', content: 'continue elsewhere' }]
  }, compatible, 'responses');
  assert.equal(chained.expandedResponses, 2);
  assert.match(JSON.stringify(chained.body), /inspect the project/);
  assert.match(JSON.stringify(chained.body), /project contents/);
  assert.match(JSON.stringify(chained.body), /done/);
  assert.match(JSON.stringify(chained.body), /continue elsewhere/);

  const bootstrapStore = new ResponsesContinuationStore();
  const bootstrapRequest = {
    input: [
      {
        type: 'message',
        role: 'developer',
        content: [
          { type: 'input_text', text: '<skills_instructions>old skills</skills_instructions>' },
          { type: 'input_text', text: 'Keep this project-specific developer instruction.' },
          { type: 'input_text', text: '<collaboration_mode>Plan</collaboration_mode>' }
        ]
      },
      { type: 'message', role: 'user', content: 'first turn' }
    ]
  };
  assert.equal(await bootstrapStore.recordResponse(bootstrapRequest, {
    id: 'resp_bootstrap_first',
    output: [{ type: 'message', role: 'assistant', content: 'first answer' }]
  }, official), true);
  const bootstrapSecondRequest = {
    previous_response_id: 'resp_bootstrap_first',
    input: [
      { type: 'message', role: 'developer', content: '<model_switch>continue with the new model</model_switch>' },
      {
        type: 'message',
        role: 'developer',
        content: [
          { type: 'input_text', text: '<skills_instructions>middle skills</skills_instructions>' },
          { type: 'input_text', text: '<collaboration_mode>Default</collaboration_mode>' },
          { type: 'input_text', text: '<plugins_instructions>middle plugins</plugins_instructions>' }
        ]
      },
      { type: 'message', role: 'user', content: 'second turn' }
    ]
  };
  assert.equal(await bootstrapStore.recordResponse(bootstrapSecondRequest, {
    id: 'resp_bootstrap_second',
    output: [{ type: 'message', role: 'assistant', content: 'second answer' }]
  }, official), true);
  await bootstrapStore.markProviderTransition('official', 'compatible');
  const bootstrapSwitched = await bootstrapStore.prepareRequest({
    previous_response_id: 'resp_bootstrap_second',
    input: [
      { type: 'message', role: 'developer', content: '<model_switch>continue with the new model</model_switch>' },
      {
        type: 'message',
        role: 'developer',
        content: [
          { type: 'input_text', text: '<skills_instructions>latest skills</skills_instructions>' },
          { type: 'input_text', text: '<collaboration_mode>Default</collaboration_mode>' },
          { type: 'input_text', text: '<plugins_instructions>latest plugins</plugins_instructions>' }
        ]
      },
      { type: 'message', role: 'user', content: 'third turn' }
    ]
  }, compatible, 'responses');
  const bootstrapJson = JSON.stringify(bootstrapSwitched.body);
  assert.equal((bootstrapJson.match(/<model_switch>/g) ?? []).length, 1,
    'provider expansion keeps only the latest model-switch bootstrap message');
  assert.equal((bootstrapJson.match(/<skills_instructions>/g) ?? []).length, 1,
    'provider expansion keeps only the latest skills bootstrap block');
  assert.equal((bootstrapJson.match(/<collaboration_mode>/g) ?? []).length, 1,
    'provider expansion keeps only the latest collaboration mode block');
  assert.equal((bootstrapJson.match(/<plugins_instructions>/g) ?? []).length, 1,
    'provider expansion keeps only the latest plugin bootstrap block');
  assert.doesNotMatch(bootstrapJson, /old skills|middle skills|middle plugins|>Plan</);
  assert.match(bootstrapJson, /latest skills|latest plugins|>Default</);
  assert.match(bootstrapJson, /Keep this project-specific developer instruction/,
    'provider expansion must preserve ordinary developer instructions');

  const restarted = new ResponsesContinuationStore(stateFile);
  const afterRestart = await restarted.prepareRequest(toolRequest, compatible, 'chat-completions');
  assert.equal(afterRestart.expandedResponses, 1, 'bounded continuation cache survives Gateway helper restart');

  const missing = await restarted.prepareRequest({
    previous_response_id: 'resp_missing',
    input: [{ type: 'function_call_output', call_id: 'call_missing', output: 'unsafe orphan' }]
  }, compatible, 'chat-completions');
  assert.equal(missing.unresolvedToolOutputs, 1, 'orphan tool results must fail closed instead of guessing or re-running a tool');

  const persisted = await fs.readFile(stateFile, 'utf8');
  assert.doesNotMatch(persisted, /must-not-be-persisted|secret-a|compatible\.example|chatgpt\.com|account-a/);
  completed.push('bounded Responses continuation expansion across providers');
}

async function testCodexConversationPortabilityGateway(): Promise<void> {
  const received: Array<{
    path: string;
    body: Record<string, any>;
    rawBody: string;
    attestation: string;
  }> = [];
  const officialReasoning = 'gateway-official-reasoning';
  const officialCompaction = 'gateway-official-compaction';
  const compatibleReasoning = 'gateway-compatible-reasoning';
  const compatibleCompaction = 'gateway-compatible-compaction';
  const upstream = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const body = JSON.parse(rawBody) as Record<string, any>;
    received.push({
      path: request.url ?? '',
      body,
      rawBody,
      attestation: String(request.headers['x-oai-attestation'] ?? '')
    });
    const compatible = (request.url ?? '').startsWith('/compatible/');
    const titleRequest = body?.text?.format?.name === 'codex_output_schema'
      && body?.text?.format?.schema?.properties?.title;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: compatible ? 'resp_compatible' : 'resp_official',
      object: 'response',
      status: 'completed',
      output: titleRequest ? [{
        id: 'msg_title',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{
          type: 'output_text',
          text: JSON.stringify({ title: '兼容服务 provider switch', description: 'QA' })
        }]
      }] : [
        {
          type: 'reasoning',
          encrypted_content: compatible ? compatibleReasoning : officialReasoning
        },
        {
          type: 'compaction',
          encrypted_content: compatible ? compatibleCompaction : officialCompaction
        }
      ]
    }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const portabilityGatewayRoot = path.join(root, 'codex-portability-gateway');
  await fs.mkdir(portabilityGatewayRoot, { recursive: true });
  const store = new TraceStore(path.join(portabilityGatewayRoot, 'trace'));
  const proxy = new TapProxy(
    store,
    [0],
    path.join(portabilityGatewayRoot, 'opaque-origins.json')
  );
  const proxyUrl = await proxy.start();
  const route = (upstreamPath: 'official' | 'compatible') => ({
    source: 'codex-cli' as const,
    path: '/v1/responses',
    apiType: 'responses' as const,
    upstreamBaseUrl: `${baseUrl}/${upstreamPath}`,
    defaultProtocol: 'responses' as const,
    ...(upstreamPath === 'compatible'
      ? { compatibleServiceGateway: true, upstreamBearerToken: 'gateway-compatible-secret' }
      : {})
  });
  const send = async (input: unknown): Promise<void> => {
    const response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({ model: 'gpt-portable', store: false, input })
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
  };
  try {
    proxy.setClientRoutes([route('official')]);
    await send([{ type: 'message', role: 'user', content: 'mint official opaque state' }]);

    await send([
      {
        type: 'message',
        id: 'resp_chatcmpl_xwx_2efb3e36-a7a3-4bd8-9400-70b5f7216a02_msg',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'legacy 兼容服务 assistant reply' }]
      },
      { type: 'message', role: 'user', content: 'retry on official' }
    ]);
    const normalizedLegacyUpstream = received.at(-1)!;
    assert.match(normalizedLegacyUpstream.body.input[0].id, /^msg_xwx_[0-9a-f]{32}$/,
      'the Gateway must normalize legacy XwX bridge message IDs before calling official Responses');
    assert.match(JSON.stringify(normalizedLegacyUpstream.body), /legacy 兼容服务 assistant reply/,
      'message ID normalization must preserve the 兼容服务 conversation text');
    assert.match(JSON.stringify(normalizedLegacyUpstream.body), /retry on official/);

    await send([
      {
        type: 'reasoning',
        id: 'rs_resp_chatcmpl_xwx_197a83cc-0dd3-4dd2-bed6-441c11190c64',
        summary: [{ type: 'summary_text', text: 'synthetic 兼容服务 Chat reasoning' }]
      },
      {
        type: 'message',
        id: 'msg_xwx_652e8500d197fa00b3a80c0edd455ce1',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'preserve bridged answer text' }]
      },
      { type: 'message', role: 'user', content: 'continue with store false' }
    ]);
    const sanitizedSyntheticReasoningUpstream = received.at(-1)!;
    assert.equal(
      sanitizedSyntheticReasoningUpstream.body.input.some((item: Record<string, unknown>) => item.type === 'reasoning'),
      false,
      'official Responses must not receive a bridge reasoning ID that was never persisted'
    );
    assert.match(JSON.stringify(sanitizedSyntheticReasoningUpstream.body), /preserve bridged answer text/);
    assert.match(JSON.stringify(sanitizedSyntheticReasoningUpstream.body), /continue with store false/);

    proxy.setClientRoutes([route('compatible')]);
    await send([
      {
        type: 'reasoning',
        id: 'rs_resp_chatcmpl_xwx_197a83cc-0dd3-4dd2-bed6-441c11190c64',
        summary: [{ type: 'summary_text', text: 'synthetic 兼容服务 Chat reasoning' }],
        encrypted_content: null
      },
      {
        type: 'message',
        id: 'msg_xwx_652e8500d197fa00b3a80c0edd455ce1',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'preserve bridged 兼容服务 answer text' }]
      },
      { type: 'message', role: 'user', content: 'continue on 兼容服务 Responses with store false' }
    ]);
    const sanitizedCompatibleServiceResponsesUpstream = received.at(-1)!;
    assert.match(sanitizedCompatibleServiceResponsesUpstream.path, /^\/compatible\/v1\/responses/);
    assert.equal(
      sanitizedCompatibleServiceResponsesUpstream.body.input.some((item: Record<string, unknown>) => item.type === 'reasoning'),
      false,
      '兼容服务 native Responses must not receive a bridge reasoning ID that was never persisted'
    );
    assert.match(JSON.stringify(sanitizedCompatibleServiceResponsesUpstream.body), /preserve bridged 兼容服务 answer text/);
    assert.match(JSON.stringify(sanitizedCompatibleServiceResponsesUpstream.body), /continue on 兼容服务 Responses with store false/);

    await send([
      { type: 'reasoning', encrypted_content: officialReasoning },
      { type: 'compaction', encrypted_content: officialCompaction },
      { type: 'compaction', encrypted_content: encodeCompactionSummary('portable XwX summary') },
      { type: 'message', role: 'user', content: 'continue on 兼容服务' }
    ]);
    const to兼容服务 = received.at(-1)!;
    assert.match(to兼容服务.path, /^\/compatible\/v1\/responses/);
    assert.doesNotMatch(JSON.stringify(to兼容服务.body), /gateway-official-(reasoning|compaction)/);
    assert.doesNotMatch(JSON.stringify(to兼容服务.body), /xwxc1:/);
    assert.match(JSON.stringify(to兼容服务.body), /portable XwX summary/);
    assert.match(JSON.stringify(to兼容服务.body), /continue on 兼容服务/);

    proxy.setClientRoutes([route('official')]);
    await send([
      { type: 'reasoning', encrypted_content: compatibleReasoning },
      { type: 'compaction', encrypted_content: compatibleCompaction },
      { type: 'message', role: 'user', content: 'continue on official' }
    ]);
    const toOfficial = received.at(-1)!;
    assert.match(toOfficial.path, /^\/official\/v1\/responses/);
    assert.doesNotMatch(JSON.stringify(toOfficial.body), /gateway-compatible-(reasoning|compaction)/);
    assert.match(JSON.stringify(toOfficial.body), /continue on official/);

    // The first request after a provider switch can itself be compact. Unknown
    // pre-index values may be native OpenAI state, so the official route must
    // preserve them exactly. Only origin-indexed 兼容服务 values are removed.
    proxy.setClientRoutes([{
      ...route('official'),
      path: '/backend-api/codex/responses',
      nativeCompact: true
    }]);
    await proxy.markCodexProviderTransition('compatible', 'official');
    const firstCompact = await fetch(`${proxyUrl}/backend-api/codex/responses/compact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({
        model: 'gpt-portable',
        input: [
          { type: 'reasoning', encrypted_content: 'legacy-first-compact-reasoning' },
          { type: 'compaction', encrypted_content: 'legacy-first-compact-checkpoint' },
          { type: 'message', role: 'user', content: 'compact immediately after switch' }
        ]
      })
    });
    assert.equal(firstCompact.status, 200, await firstCompact.text());
    const firstCompactUpstream = received.at(-1)!;
    assert.match(firstCompactUpstream.path, /^\/official\/backend-api\/codex\/responses\/compact/);
    assert.match(JSON.stringify(firstCompactUpstream.body), /legacy-first-compact-reasoning/);
    assert.match(JSON.stringify(firstCompactUpstream.body), /legacy-first-compact-checkpoint/);
    assert.match(JSON.stringify(firstCompactUpstream.body), /compact immediately after switch/);

    const signedOfficialBody = JSON.stringify({
      model: 'gpt-portable',
      stream: true,
      input: [
        { type: 'reasoning', encrypted_content: 'unknown-native-official-signed-reasoning' },
        { type: 'compaction', encrypted_content: 'unknown-native-official-signed-compaction' },
        { type: 'message', role: 'user', content: 'signed old official conversation' }
      ]
    }, null, 2);
    const signedOfficialResponse = await fetch(`${proxyUrl}/backend-api/codex/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'codex-cli/qa',
        'x-oai-attestation': 'signed-request-proof'
      },
      body: signedOfficialBody
    });
    assert.equal(signedOfficialResponse.status, 200, await signedOfficialResponse.text());
    const signedOfficialUpstream = received.at(-1)!;
    assert.equal(signedOfficialUpstream.rawBody, signedOfficialBody,
      'official old-history requests must reach upstream byte-for-byte unchanged');
    assert.equal(signedOfficialUpstream.attestation, 'signed-request-proof',
      'the matching ChatGPT request proof must be forwarded unchanged');

    // A provider-owned previous_response_id is rewritten only for the new
    // upstream. Trace must keep the original client request long enough to
    // route the switch turn back to its existing session, then learn the new
    // provider's response id for the following turn.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const latest = await store.latestTrace();
      if (JSON.stringify(latest?.request.body)?.includes('signed old official conversation')) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await store.clearAll();
    const sendContinuationTurn = async (
      provider: 'official' | 'compatible',
      input: string,
      previousResponseId?: string
    ): Promise<void> => {
      proxy.setClientRoutes([route(provider)]);
      const response = await fetch(`${proxyUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
        body: JSON.stringify({
          model: 'gpt-portable',
          input: [{ type: 'message', role: 'user', content: input }],
          ...(previousResponseId ? { previous_response_id: previousResponseId } : {})
        })
      });
      const responseText = await response.text();
      assert.equal(response.status, 200, responseText);
    };
    const waitForResponseId = async (responseId: string): Promise<TapSessionSummary[]> => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const sessions = await store.listSessions();
        if (sessions.some(session => session.responseIds?.includes(responseId))) return sessions;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return store.listSessions();
    };
    const waitForRequestText = async (text: string): Promise<TapTraceRecord | undefined> => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const latest = await store.latestTrace();
        if (JSON.stringify(latest?.request.body).includes(text)) return latest;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return store.latestTrace();
    };
    const sendTitleTurn = async (provider: 'official' | 'compatible', prompt: string): Promise<void> => {
      proxy.setClientRoutes([route(provider)]);
      const response = await fetch(`${proxyUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
        body: JSON.stringify({
          model: 'gpt-portable',
          input: [{
            type: 'message',
            role: 'user',
            content: [{
              type: 'input_text',
              text: `Generate a concise UI title.\n\nUser prompt:\n${prompt}`
            }]
          }],
          text: {
            format: {
              type: 'json_schema',
              name: 'codex_output_schema',
              schema: {
                type: 'object',
                properties: { title: { type: 'string' }, description: { type: 'string' } },
                required: ['title', 'description']
              }
            }
          }
        })
      });
      const responseText = await response.text();
      assert.equal(response.status, 200, responseText);
    };

    await sendContinuationTurn('official', 'trace provider switch root');
    const beforeSwitchSessions = await waitForResponseId('resp_official');
    assert.equal(beforeSwitchSessions.length, 1);
    const logicalSessionId = beforeSwitchSessions[0].id;

    await proxy.markCodexProviderTransition('official', 'compatible');
    await sendTitleTurn('compatible', 'continue after switching to 兼容服务');
    const transitionTitleTrace = await waitForRequestText('Generate a concise UI title');
    assert.equal(transitionTitleTrace?.auxiliary, 'title');
    assert.equal(transitionTitleTrace && tapProxyTest.isProviderTransitionConsumer(transitionTitleTrace), false,
      'the provider transition consumer classifier must reject title utilities');
    assert.deepEqual(transitionTitleTrace?.providerTransition, {
      source: 'official',
      target: 'compatible'
    }, 'a title request may describe the active provider boundary but must not consume it');
    await sendContinuationTurn('compatible', 'continue after switching to 兼容服务', 'resp_official');
    const switchTrace = await waitForRequestText('previous_response_id');
    assert.deepEqual(switchTrace?.providerTransition, {
      source: 'official',
      target: 'compatible'
    }, 'the first successful main request must retain and consume the provider transition');
    const switchUpstream = received.at(-1)!;
    assert.equal(switchUpstream.body.previous_response_id, undefined,
      'the foreign official previous_response_id must not be sent to 兼容服务');
    const afterSwitchSessions = await waitForResponseId('resp_compatible');
    const afterSwitchMainSession = afterSwitchSessions.find(session => session.id === logicalSessionId);
    assert.ok(afterSwitchMainSession,
      'the provider switch turn must remain in its existing visible Trace session');
    assert.ok(afterSwitchMainSession.responseIds?.includes('resp_official'));
    assert.ok(afterSwitchMainSession.responseIds?.includes('resp_compatible'));

    await sendContinuationTurn('compatible', 'continue with the new provider id', 'resp_compatible');
    const sameProviderUpstream = received.at(-1)!;
    assert.equal(sameProviderUpstream.body.previous_response_id, 'resp_compatible',
      'the new provider may keep using its own native continuation id');
    let finalSessions = await store.listSessions();
    for (let attempt = 0; finalSessions.find(session => session.id === logicalSessionId)?.traceCount !== 3 && attempt < 40; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
      finalSessions = await store.listSessions();
    }
    const visibleFinalSessions = finalSessions.filter(session => session.hidden !== true);
    assert.equal(visibleFinalSessions.length, 1);
    assert.equal(visibleFinalSessions[0].id, logicalSessionId);

    const switchPage = await store.readSessionPage(logicalSessionId, { limit: 10 });
    const switchedMainTrace = switchPage?.traces.find(trace => JSON.stringify(trace.request.body).includes('continue after switching to 兼容服务') && trace.auxiliary !== 'title');
    const continuedMainTrace = switchPage?.traces.find(trace => JSON.stringify(trace.request.body).includes('continue with the new provider id'));
    assert.equal(switchedMainTrace?.routedBy, 'prevResponseId');
    assert.equal(continuedMainTrace?.routedBy, 'prevResponseId');
    assert.equal(
      (switchedMainTrace?.request.body as Record<string, unknown>)?.previous_response_id,
      'resp_official',
      'Trace must preserve the original switch request even though the forwarded body was sanitized'
    );
    assert.equal(transitionTitleTrace?.routedBy, 'provisionalTitle');
    assert.deepEqual(switchedMainTrace?.providerTransition, {
      source: 'official',
      target: 'compatible'
    }, 'the switch request must retain explicit provider transition metadata for the Trace UI');
    assert.equal(continuedMainTrace?.providerTransition, undefined,
      'the provider-switch label must clear after the target acknowledges its first successful request');

    await proxy.markCodexProviderTransition('compatible', 'official');
    await sendTitleTurn('official', 'title after switching back to official');
    const reverseTransitionTitleTrace = await waitForRequestText('title after switching back to official');
    assert.deepEqual(reverseTransitionTitleTrace?.providerTransition, {
      source: 'compatible',
      target: 'official'
    }, 'an official-bound title request must display the pending reverse transition without consuming it');
    await sendContinuationTurn('official', 'continue after switching back to official');
    const reverseSwitchTrace = await waitForRequestText('continue after switching back to official');
    assert.deepEqual(reverseSwitchTrace?.providerTransition, {
      source: 'compatible',
      target: 'official'
    }, 'the first official main request must retain reverse provider transition metadata for the Trace UI');
    await sendContinuationTurn('official', 'continue on official after transition');
    const continuedOfficialTrace = await waitForRequestText('continue on official after transition');
    assert.equal(continuedOfficialTrace?.providerTransition, undefined,
      'the reverse provider-switch label must clear after the first successful official main request');
  } finally {
    await proxy.stop();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }

  completed.push('Codex portability gateway strips both foreign opaque item types bidirectionally');
}

async function testCodexGatewayTransitionMatrix(): Promise<void> {
  type Seen = { provider: 'official' | 'compatible'; path: string; authorization: string; body: Record<string, any> };
  const seen: Seen[] = [];
  let releaseSlow: (() => void) | undefined;
  let markSlowReached: (() => void) | undefined;
  const slowReached = new Promise<void>(resolve => { markSlowReached = resolve; });
  const slowReleased = new Promise<void>(resolve => { releaseSlow = resolve; });
  const startUpstream = async (provider: Seen['provider']): Promise<http.Server> => {
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const body = bodyText ? JSON.parse(bodyText) as Record<string, any> : {};
      seen.push({
        provider,
        path: request.url ?? '',
        authorization: String(request.headers.authorization ?? ''),
        body
      });
      if (body.input === 'slow-compatible') {
        markSlowReached?.();
        await slowReleased;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      if ((request.url ?? '').includes('/chat/completions')) {
        response.end(JSON.stringify({
          id: `chat_${provider}`,
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: provider }, finish_reason: 'stop' }]
        }));
        return;
      }
      if ((request.url ?? '').includes('/messages')) {
        response.end(JSON.stringify({
          id: `msg_${provider}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: provider }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 }
        }));
        return;
      }
      response.end(JSON.stringify({
        id: `resp_${provider}`,
        object: 'response',
        status: 'completed',
        output: [{
          id: `msg_${provider}`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: provider }]
        }]
      }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return server;
  };
  const officialServer = await startUpstream('official');
  const compatibleServer = await startUpstream('compatible');
  const serverUrl = (server: http.Server): string => {
    const address = server.address();
    assert(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
  };
  const settings = await new XwXDeckSettingsStore(path.join(root, 'gateway-transition-settings')).read();
  const localOfficialRoutes = controllerTest.buildCodexOfficialGatewayRoutes(
    { ...settings, compatible: { ...settings.compatible, bearerToken: 'compatible-secret' } },
    'chatgpt',
    'official-oauth'
  ).map(route => ({ ...route, upstreamBaseUrl: `${serverUrl(officialServer)}/official`, stripPathPrefix: undefined, capture: false }));
  const officialModelsRoute = controllerTest.buildCodexOfficialGatewayRoutes(settings, 'chatgpt')
    .find(route => route.path === '/backend-api/codex/models');
  assert(officialModelsRoute, 'official ChatGPT Gateway must publish the current Codex model-directory route');
  assert.equal(officialModelsRoute.capture, false, 'model-directory utility calls must not create conversation traces');
  assert.equal(
    tapProxyTest.buildUpstreamUrl(
      officialModelsRoute.upstreamBaseUrl,
      new URL('http://127.0.0.1:44233/backend-api/codex/models?client_version=qa'),
      officialModelsRoute.stripPathPrefix
    ).toString(),
    'https://chatgpt.com/backend-api/codex/models?client_version=qa'
  );
  assert.equal(
    localOfficialRoutes.find(route => route.path === '/backend-api/codex/responses')?.webSocket,
    'official-responses',
    'official Responses routes must explicitly opt into WebSocket proxying'
  );
  assert.equal(
    localOfficialRoutes.find(route => route.path === '/backend-api/codex/responses/compact')?.webSocket,
    undefined,
    'compact remains an HTTP endpoint'
  );
  const catalog = [
    { id: 'responses-model', vendor: 'OpenAI', protocols: ['openai-responses'] as const, clients: ['codex'] as const },
    { id: 'chat-model', vendor: '兼容服务', protocols: ['chat-completions'] as const, clients: ['codex'] as const },
    { id: 'anthropic-model', vendor: 'Anthropic', protocols: ['anthropic-messages'] as const, clients: ['codex'] as const, maxOutputTokens: 4096 }
  ];
  const localCompatibleServiceRoutes = controllerTest.buildCodexGatewayRoutes(
    {
      ...settings,
      compatible: {
        ...settings.compatible,
        baseUrl: `${serverUrl(compatibleServer)}/compatible/v1`,
        bearerToken: 'compatible-secret'
      }
    },
    catalog as any
  ).map(route => ({ ...route, capture: false }));
  assert.ok(localCompatibleServiceRoutes.every(route => route.webSocket === undefined),
    '兼容服务 routes must remain HTTP/SSE even when a model advertises Responses');
  const transitionRoot = path.join(root, 'gateway-transition-matrix');
  await fs.mkdir(transitionRoot, { recursive: true });
  const proxy = new TapProxy(new TraceStore(path.join(transitionRoot, 'trace')), [0]);
  const proxyUrl = await proxy.start();
  const send = async (input: unknown, model = 'responses-model', requestPath = '/backend-api/codex/responses') => {
    const response = await fetch(`${proxyUrl}${requestPath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'codex-cli/qa',
        authorization: 'Bearer compatible-secret'
      },
      body: JSON.stringify({ model, input })
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, `${model} ${requestPath}: ${responseText}`);
  };
  try {
    // 兼容服务 -> official while the old stream is in flight. Route snapshots
    // keep the accepted request on 兼容服务; the next request uses official.
    proxy.setClientRoutes(localCompatibleServiceRoutes);
    const slow = send('slow-compatible');
    await slowReached;
    proxy.setClientRoutes(localOfficialRoutes);
    const modelsResponse = await fetch(`${proxyUrl}/backend-api/codex/models?client_version=qa`, {
      method: 'GET',
      headers: {
        'user-agent': 'codex-cli/qa',
        authorization: 'Bearer official-oauth'
      }
    });
    assert.equal(modelsResponse.status, 200, 'current Codex model-directory request must pass through the Gateway');
    await send('after-switch-official');
    releaseSlow?.();
    await slow;
    const switchedTurns = seen.filter(item => item.body.input === 'slow-compatible' || item.body.input === 'after-switch-official');
    assert.deepEqual(switchedTurns.map(item => item.provider).sort(), ['compatible', 'official']);
    const officialSeen = seen.find(item => item.body.input === 'after-switch-official')!;
    assert.equal(officialSeen.authorization, 'Bearer official-oauth', '兼容服务 key must be replaced on official route');

    // Official -> 兼容服务. All three model protocols share the unchanged
    // local Gateway endpoint and receive only the 兼容服务 edge credential.
    proxy.setClientRoutes(localCompatibleServiceRoutes);
    await send('native responses', 'responses-model');
    await send('chat bridge', 'chat-model');
    await send('anthropic bridge', 'anthropic-model');
    const protocolTurns = seen.slice(-3);
    assert.deepEqual(protocolTurns.map(item => item.provider), ['compatible', 'compatible', 'compatible']);
    assert.ok(protocolTurns.every(item => item.authorization === 'Bearer compatible-secret'));
    assert.match(protocolTurns[0].path, /\/compatible\/v1\/responses$/);
    assert.match(protocolTurns[1].path, /\/compatible\/v1\/chat\/completions$/);
    assert.match(protocolTurns[2].path, /\/compatible\/anthropic\/v1\/messages$/);

    const apiKeyRoutes = controllerTest.buildCodexOfficialGatewayRoutes(settings, 'api-key', 'openai-api-key');
    const apiCanonical = apiKeyRoutes.find(route => route.path === '/backend-api/codex/responses')!;
    const apiAlias = apiKeyRoutes.find(route => route.path === '/v1/responses')!;
    assert.equal(apiCanonical.upstreamBaseUrl, 'https://api.openai.com/v1');
    assert.equal(apiCanonical.stripPathPrefix, '/backend-api/codex');
    assert.equal(apiAlias.upstreamBaseUrl, 'https://api.openai.com');
    assert.equal(apiAlias.stripPathPrefix, undefined);
  } finally {
    releaseSlow?.();
    await proxy.stop();
    await Promise.all([
      new Promise<void>(resolve => officialServer.close(() => resolve())),
      new Promise<void>(resolve => compatibleServer.close(() => resolve()))
    ]);
  }
  completed.push('stable Gateway transition matrix across providers, streams, credentials, and protocols');
}

async function testProxyShutdownDrain(): Promise<void> {
  const blocked = tapProxyTest.buildForwardHeaders(
    { authorization: 'Bearer compatible-secret', 'chatgpt-account-id': 'acct-qa' },
    'chatgpt.com',
    12,
    undefined,
    'compatible-secret',
    'official-oauth'
  );
  assert.equal(blocked.authorization, 'Bearer official-oauth', 'a cached 兼容服务 key must be replaced before official ChatGPT');
  assert.equal(blocked['chatgpt-account-id'], 'acct-qa');
  const injected = tapProxyTest.buildForwardHeaders(
    { authorization: 'Bearer official-oauth' },
    'compatible.example',
    12,
    'compatible-secret'
  );
  assert.equal(injected.authorization, 'Bearer compatible-secret', '兼容服务 auth must be injected only at the Gateway edge');

  let releaseSlowResponse: (() => void) | undefined;
  let markSlowRequestReached: (() => void) | undefined;
  const slowRequestReached = new Promise<void>(resolve => { markSlowRequestReached = resolve; });
  const slowResponseReleased = new Promise<void>(resolve => { releaseSlowResponse = resolve; });
  let releaseAbruptResponse: (() => void) | undefined;
  let markAbruptResponseStarted: (() => void) | undefined;
  const abruptResponseStarted = new Promise<void>(resolve => { markAbruptResponseStarted = resolve; });
  const abruptResponseReleased = new Promise<void>(resolve => { releaseAbruptResponse = resolve; });
  let releaseTerminalResponse: (() => void) | undefined;
  let markTerminalResponseStarted: (() => void) | undefined;
  const terminalResponseStarted = new Promise<void>(resolve => { markTerminalResponseStarted = resolve; });
  const terminalResponseReleased = new Promise<void>(resolve => { releaseTerminalResponse = resolve; });
  const upstream = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input?: string; model?: string };
    if (body.input === 'slow shutdown request') {
      markSlowRequestReached?.();
      await slowResponseReleased;
    }
    if (body.input === 'abrupt upstream response') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '128'
      });
      response.write('{"partial":"upstream');
      markAbruptResponseStarted?.();
      await abruptResponseReleased;
      response.destroy();
      return;
    }
    if (body.input === 'terminal stream then client close') {
      const completed = {
        type: 'response.completed',
        response: {
          id: 'resp_terminal_close',
          object: 'response',
          status: 'completed',
          model: body.model,
          output: [{
            id: 'msg_terminal_close',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'complete before close' }]
          }]
        }
      };
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.write(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`);
      markTerminalResponseStarted?.();
      await terminalResponseReleased;
      if (!response.destroyed) response.end();
      return;
    }
    if (body.input === 'semantic failed response') {
      const failed = {
        type: 'response.failed',
        response: {
          id: 'resp_semantic_failure',
          object: 'response',
          status: 'failed',
          model: body.model,
          output: [{
            id: 'call_semantic_failure',
            call_id: 'call_semantic_failure',
            type: 'function_call',
            name: 'shell',
            arguments: '{}'
          }],
          error: { type: 'server_error', message: 'semantic failure' }
        }
      };
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      response.end(`event: response.failed\ndata: ${JSON.stringify(failed)}\n\n`);
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body.input === 'tool-turn' ? {
      id: 'resp_shutdown_tool',
      object: 'response',
      status: 'completed',
      model: body.model,
      output: [{ id: 'call_shutdown', call_id: 'call_shutdown', type: 'function_call', name: 'shell', arguments: '{}' }]
    } : {
      id: 'resp_shutdown_drain',
      object: 'response',
      status: 'completed',
      model: body.model,
      output: [{
        id: 'msg_shutdown_drain',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'drained safely' }]
      }]
    }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert(address && typeof address === 'object');
  const shutdownRoot = path.join(root, 'shutdown-drain');
  const portabilityStateFile = path.join(shutdownRoot, 'opaque-origins.json');
  const shutdownStore = new TraceStore(path.join(shutdownRoot, 'trace'));
  const proxy = new TapProxy(shutdownStore, [0], portabilityStateFile);
  proxy.setRoutes([], `http://127.0.0.1:${address.port}`);
  proxy.setClientRoutes([{
    source: 'codex-cli',
    path: '/v1/responses',
    apiType: 'responses',
    upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
    compatibleServiceGateway: true,
    capture: true
  }]);
  const proxyUrl = await proxy.start();
  try {
    const slowFetch = fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({ model: 'gpt-drain', input: 'slow shutdown request' })
    });
    await slowRequestReached;
    assert.equal(proxy.activeRequestCount(), 1);
    assert.equal(
      await proxy.prepareForShutdown({ timeoutMs: 25, quietPeriodMs: 0 }),
      false,
      'shutdown must be cancellable instead of severing an active model stream'
    );
    assert.equal(proxy.activeRequestCount(), 1);

    releaseSlowResponse?.();
    const slowResponse = await slowFetch;
    assert.equal(slowResponse.status, 200);
    assert.match(await slowResponse.text(), /drained safely/);
    for (let attempt = 0; attempt < 100 && proxy.activeRequestCount() !== 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(proxy.activeRequestCount(), 0);

    await proxy.markCodexProviderTransition('official', 'compatible');
    const abruptBody = JSON.stringify({ model: 'gpt-drain', input: 'abrupt upstream response' });
    let markPartialResponseReceived: (() => void) | undefined;
    const partialResponseReceived = new Promise<void>(resolve => { markPartialResponseReceived = resolve; });
    const abruptClientResult = new Promise<{ aborted: boolean; complete: boolean }>((resolve, reject) => {
      const request = http.request(`${proxyUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(abruptBody),
          'user-agent': 'codex-tui/qa',
          originator: 'codex-tui'
        }
      }, response => {
        response.once('data', () => markPartialResponseReceived?.());
        response.once('aborted', () => resolve({ aborted: true, complete: response.complete }));
        response.once('error', () => resolve({ aborted: true, complete: response.complete }));
        response.once('end', () => resolve({ aborted: false, complete: response.complete }));
      });
      request.once('error', reject);
      request.end(abruptBody);
    });
    await abruptResponseStarted;
    await partialResponseReceived;
    assert.equal(proxy.activeRequestCount(), 1, 'a partially delivered upstream response must remain active until it aborts');
    releaseAbruptResponse?.();
    let abruptTimeout: NodeJS.Timeout | undefined;
    const abruptResult = await Promise.race([
      abruptClientResult,
      new Promise<never>((_, reject) => {
        abruptTimeout = setTimeout(() => reject(new Error('aborted upstream response left the client connection open')), 1_000);
      })
    ]).finally(() => {
      if (abruptTimeout) clearTimeout(abruptTimeout);
    });
    assert.equal(abruptResult.aborted, true, 'a truncated upstream response must destroy the downstream response');
    assert.equal(abruptResult.complete, false);
    for (let attempt = 0; attempt < 100 && proxy.activeRequestCount() !== 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(proxy.activeRequestCount(), 0, 'an aborted upstream response must release the active request');
    const transitionAfterAbort = (
      JSON.parse(await fs.readFile(portabilityStateFile, 'utf8')) as {
        transition?: { source?: string; target?: string; createdAt?: number };
      }
    ).transition;
    assert.equal(transitionAfterAbort?.source, 'official');
    assert.equal(transitionAfterAbort?.target, 'compatible',
      'an aborted 2xx response must not acknowledge the provider transition');
    assert.equal(typeof transitionAfterAbort?.createdAt, 'number');

    const terminalBody = JSON.stringify({
      model: 'gpt-drain',
      stream: true,
      input: 'terminal stream then client close'
    });
    const terminalClientResult = new Promise<'closed' | 'ended'>((resolve, reject) => {
      const request = http.request(`${proxyUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(terminalBody),
          'user-agent': 'codex-tui/qa',
          originator: 'codex-tui'
        }
      }, response => {
        let received = '';
        response.on('data', chunk => {
          received += String(chunk);
          if (!received.includes('response.completed')) return;
          response.destroy();
          resolve('closed');
        });
        response.once('error', () => resolve('closed'));
        response.once('end', () => resolve('ended'));
      });
      request.once('error', reject);
      request.end(terminalBody);
    });
    await terminalResponseStarted;
    let terminalTimeout: NodeJS.Timeout | undefined;
    const terminalResult = await Promise.race([
      terminalClientResult,
      new Promise<never>((_, reject) => {
        terminalTimeout = setTimeout(() => reject(new Error('terminal SSE client did not close promptly')), 1_000);
      })
    ]).finally(() => {
      if (terminalTimeout) clearTimeout(terminalTimeout);
    });
    assert.equal(terminalResult, 'closed', 'the client fixture must close before upstream EOF');
    for (let attempt = 0; attempt < 100 && proxy.activeRequestCount() !== 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(proxy.activeRequestCount(), 0, 'terminal client close must settle the active request');
    const terminalTrace = await shutdownStore.latestTrace();
    assert.equal(terminalTrace?.response.statusCode, 200);
    assert.equal(terminalTrace?.response.snapshot?.stopReason, 'completed');
    assert.equal(terminalTrace?.error, undefined,
      'a client close after the terminal SSE event must not overwrite success with an upstream abort');
    const transitionAfterTerminal = (
      JSON.parse(await fs.readFile(portabilityStateFile, 'utf8')) as {
        transition?: { source?: string; target?: string; createdAt?: number };
      }
    ).transition;
    assert.equal(transitionAfterTerminal, undefined,
      'a completed terminal SSE event must acknowledge the provider transition exactly once');
    releaseTerminalResponse?.();

    await proxy.markCodexProviderTransition('official', 'compatible');
    const failedResponse = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'codex-tui/qa',
        'x-codex-turn-metadata': JSON.stringify({ thread_id: 'shutdown-failed-thread' })
      },
      body: JSON.stringify({ model: 'gpt-drain', stream: true, input: 'semantic failed response' })
    });
    assert.equal(failedResponse.status, 200);
    assert.match(await failedResponse.text(), /response\.failed/);
    for (let attempt = 0; attempt < 100 && proxy.activeRequestCount() !== 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const failedTrace = await shutdownStore.latestTrace();
    assert.equal(failedTrace?.response.snapshot?.stopReason, 'failed');
    assert.equal(proxy.pendingContinuationCount(), 0,
      'a response.failed event must not create a pending tool continuation');
    const transitionAfterSemanticFailure = (
      JSON.parse(await fs.readFile(portabilityStateFile, 'utf8')) as {
        transition?: { source?: string; target?: string; createdAt?: number };
      }
    ).transition;
    assert.equal(transitionAfterSemanticFailure?.source, 'official');
    assert.equal(transitionAfterSemanticFailure?.target, 'compatible',
      'a 2xx response.failed event must not acknowledge the provider transition');

    const toolResponse = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'codex-cli/qa',
        'x-codex-turn-metadata': JSON.stringify({ thread_id: 'shutdown-tool-thread' })
      },
      body: JSON.stringify({ model: 'gpt-drain', input: 'tool-turn' })
    });
    assert.equal(toolResponse.status, 200);
    await toolResponse.text();
    assert.equal(proxy.pendingContinuationCount(), 1);
    assert.equal(
      await proxy.prepareForShutdown({ timeoutMs: 25, quietPeriodMs: 0 }),
      false,
      'shutdown must remain blocked between a tool call and its continuation request'
    );
    const continuationResponse = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'codex-cli/qa',
        'x-codex-turn-metadata': JSON.stringify({ thread_id: 'shutdown-tool-thread' })
      },
      body: JSON.stringify({ model: 'gpt-drain', input: 'tool-result' })
    });
    assert.equal(continuationResponse.status, 200);
    await continuationResponse.text();
    assert.equal(proxy.pendingContinuationCount(), 0);

    const partialUrl = new URL(proxyUrl);
    const partialSocket = net.createConnection(Number(partialUrl.port), partialUrl.hostname);
    partialSocket.on('error', () => undefined);
    await new Promise<void>((resolve, reject) => {
      partialSocket.once('connect', resolve);
      partialSocket.once('error', reject);
    });
    partialSocket.write([
      'POST /v1/responses HTTP/1.1',
      `Host: ${partialUrl.host}`,
      'Content-Type: application/json',
      'Content-Length: 256',
      'Connection: keep-alive',
      '',
      '{"model":"gpt-drain","input":"unfinished'
    ].join('\r\n'));
    for (let attempt = 0; attempt < 100 && proxy.activeRequestCount() !== 1; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(proxy.activeRequestCount(), 1, 'an incomplete upload must be visible as an active request');
    await proxy.forcePrepareForShutdown();
    for (let attempt = 0; attempt < 100 && proxy.activeRequestCount() !== 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    partialSocket.destroy();
    assert.equal(proxy.activeRequestCount(), 0, 'force shutdown must release an incomplete request body');
    const rejectedAfterForce = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({ model: 'gpt-drain', input: 'late after force' })
    });
    assert.equal(rejectedAfterForce.status, 503, 'force shutdown must gate new requests before cleanup');
    proxy.cancelPreparedShutdown();

    assert.equal(await proxy.prepareForShutdown({ timeoutMs: 1_000, quietPeriodMs: 10 }), true);
    const rejectedDuringFinalCleanup = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({ model: 'gpt-drain', input: 'late request' })
    });
    assert.equal(rejectedDuringFinalCleanup.status, 503);
    assert.match(await rejectedDuringFinalCleanup.text(), /xwx_deck_shutting_down/);

    proxy.cancelPreparedShutdown();
    const resumed = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({ model: 'gpt-drain', input: 'resume after cancelled exit' })
    });
    assert.equal(resumed.status, 200, 'a cancelled shutdown must leave the gateway usable');
  } finally {
    releaseSlowResponse?.();
    releaseAbruptResponse?.();
    releaseTerminalResponse?.();
    await proxy.stop();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
  completed.push('safe shutdown drains active proxy requests and cancels without a 502');
}

async function testCodexAnthropicBridge(): Promise<void> {
  const signedThinking = {
    type: 'thinking',
    thinking: 'signed prior thought',
    signature: 'AbCdEf1234567890signature=='
  };
  const thinkingEnvelope = encodeAnthropicThinkingEnvelope(signedThinking);
  assert.ok(thinkingEnvelope?.startsWith('xwxa1:'));
  assert.deepEqual(decodeAnthropicThinkingEnvelope(thinkingEnvelope), signedThinking);
  assert.equal(decodeAnthropicThinkingEnvelope('native-openai-ciphertext'), undefined);

  const converted = responsesToAnthropicMessages({
    model: 'claude-sonnet-4-5',
    stream: true,
    instructions: 'top-level instructions',
    reasoning: { effort: 'high' },
    max_output_tokens: 20_000,
    stop: 'END',
    metadata: { user_id: 'codex-user', unsupported_key: 'must-not-pass' },
    parallel_tool_calls: false,
    tools: [
      { type: 'function', name: 'shell', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { type: 'custom', name: 'apply_patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } },
      {
        type: 'namespace',
        name: 'multi_agent',
        tools: [{ type: 'function', name: 'spawn', parameters: { type: 'object', properties: { task: { type: 'string' } } } }]
      },
      { type: 'tool_search' }
    ],
    input: [
      { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'system history' }] },
      { type: 'message', role: 'developer', content: 'developer history' },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'inspect these inputs' },
          { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' },
          { type: 'input_file', filename: 'spec.pdf', file_data: 'data:application/pdf;base64,cGRm' }
        ]
      },
      { type: 'reasoning', encrypted_content: thinkingEnvelope, summary: [{ type: 'summary_text', text: 'signed prior thought' }] },
      { type: 'function_call', call_id: 'call_spawn', namespace: 'multi_agent', name: 'spawn', arguments: '{"task":"review"}' },
      {
        type: 'function_call_output',
        call_id: 'call_spawn',
        output: [{ type: 'input_text', text: 'worker failed' }],
        is_error: true
      },
      { type: 'custom_tool_call', call_id: 'call_patch', name: 'apply_patch', input: '*** Begin Patch' },
      { type: 'custom_tool_call_output', call_id: 'call_patch', output: { ok: true } },
      { type: 'tool_search_call', call_id: 'call_search', arguments: { query: 'calendar' } },
      { type: 'tool_search_output', call_id: 'call_search', output: [{ type: 'input_text', text: 'loaded' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] }
    ]
  });

  const anthropicBody = converted.body as any;
  assert.equal(anthropicBody.model, 'claude-sonnet-4-5');
  assert.equal(anthropicBody.max_tokens, 20_000);
  assert.deepEqual(anthropicBody.stop_sequences, ['END']);
  assert.deepEqual(anthropicBody.metadata, { user_id: 'codex-user' });
  assert.deepEqual(anthropicBody.thinking, { type: 'enabled', budget_tokens: 10_000 });
  assert.equal(anthropicBody.tool_choice.disable_parallel_tool_use, true);
  assert.match(JSON.stringify(anthropicBody.system), /top-level instructions/);
  assert.match(JSON.stringify(anthropicBody.system), /system history/);
  assert.match(JSON.stringify(anthropicBody.system), /developer history/);
  assert.match(JSON.stringify(anthropicBody.messages), /\"type\":\"image\"/);
  assert.match(JSON.stringify(anthropicBody.messages), /\"type\":\"document\"/);
  assert.match(JSON.stringify(anthropicBody.messages), /\"type\":\"thinking\"/);
  assert.match(JSON.stringify(anthropicBody.messages), /\"signature\":\"AbCdEf1234567890signature==\"/);
  assert.match(JSON.stringify(anthropicBody.messages), /\"is_error\":true/);
  assert.equal(anthropicBody.tools.length, 4);
  const cacheBreakpoints = (JSON.stringify(anthropicBody).match(/"cache_control"/g) ?? []).length;
  assert.equal(cacheBreakpoints, 4);
  assert.equal((JSON.stringify(anthropicBody).match(/"ttl":"5m"/g) ?? []).length, 4);
  const compactReplay = responsesToAnthropicMessages({
    model: 'claude-sonnet-4-5',
    input: [{ type: 'compaction', encrypted_content: encodeCompactionSummary('Claude handoff state') }]
  }).body as any;
  assert.match(JSON.stringify(compactReplay.messages), /Continue from this summary/);
  assert.match(JSON.stringify(compactReplay.messages), /Claude handoff state/);

  const adaptive = responsesToAnthropicMessages({
    model: 'claude-opus-4-8',
    reasoning: { effort: 'xhigh' },
    input: 'think adaptively'
  }).body as any;
  assert.deepEqual(adaptive.thinking, { type: 'adaptive' });
  assert.deepEqual(adaptive.output_config, { effort: 'xhigh' });
  const nativeEffortWithoutAdaptiveThinking = responsesToAnthropicMessages({
    model: 'claude-sonnet-4-6',
    reasoning: { effort: 'max' },
    input: 'use native effort without adaptive thinking'
  }).body as any;
  assert.equal(nativeEffortWithoutAdaptiveThinking.thinking, undefined);
  assert.deepEqual(nativeEffortWithoutAdaptiveThinking.output_config, { effort: 'max' });
  // Dotted and hyphenated generation spellings must resolve to the same model,
  // otherwise `claude-opus-4.7` loses adaptive thinking and leaks temperature.
  for (const model of ['claude-opus-4-7', 'claude-opus-4.7']) {
    const dotted = responsesToAnthropicMessages({
      model,
      reasoning: { effort: 'high' },
      temperature: 0.4,
      input: 'generation spellings agree'
    }).body as any;
    assert.deepEqual(dotted.thinking, { type: 'adaptive' }, `${model} uses adaptive thinking`);
    assert.deepEqual(dotted.output_config, { effort: 'high' }, `${model} keeps native effort`);
    assert.equal(dotted.temperature, undefined, `${model} drops temperature while thinking`);
  }
  const unknownLimit = responsesToAnthropicMessages({
    model: 'uncatalogued-messages-model',
    input: 'use the safe output fallback'
  }).body as any;
  assert.equal(unknownLimit.max_tokens, 8192);
  const forcedTool = responsesToAnthropicMessages({
    model: 'claude-sonnet-4-5',
    reasoning: { effort: 'high' },
    tool_choice: 'required',
    tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
    input: 'must call the tool'
  }).body as any;
  assert.equal(forcedTool.tool_choice.type, 'any');
  assert.equal(forcedTool.thinking, undefined, 'forced Anthropic tool choice is incompatible with thinking');

  const toolNames = anthropicBody.tools.map((tool: any) => tool.name);
  const namespaceWireName = toolNames.find((name: string) => name.includes('spawn'))!;
  const customWireName = toolNames.find((name: string) => name === 'apply_patch')!;
  const nonStreaming = anthropicMessageToResponse({
    id: 'msg_answer',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-5',
    content: [
      signedThinking,
      { type: 'redacted_thinking', data: 'opaque-redacted-data' },
      { type: 'text', text: 'done' },
      { type: 'tool_use', id: 'call_a', name: namespaceWireName, input: { task: 'audit' } },
      { type: 'tool_use', id: 'call_b', name: customWireName, input: { input: 'patch body' } }
    ],
    stop_reason: 'tool_use',
    usage: {
      input_tokens: 12,
      output_tokens: 7,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 5
    }
  }, 'claude-fallback', converted.toolContext) as any;
  assert.equal(nonStreaming.status, 'completed');
  assert.equal(nonStreaming.usage.input_tokens, 117);
  assert.equal(nonStreaming.usage.input_tokens_details.cached_tokens, 100);
  assert.equal(nonStreaming.usage.input_tokens_details.cache_write_tokens, 5);
  assert.equal(nonStreaming.usage.cache_read_input_tokens, undefined,
    'Responses output must not retain an Anthropic top-level cache-read field');
  assert.equal(nonStreaming.usage.cache_creation_input_tokens, undefined,
    'Responses output must not retain an Anthropic top-level cache-write field');
  assert.equal(nonStreaming.output[0].type, 'reasoning');
  assert.deepEqual(decodeAnthropicThinkingEnvelope(nonStreaming.output[0].encrypted_content), signedThinking);
  assert.deepEqual(
    decodeAnthropicThinkingEnvelope(nonStreaming.output[1].encrypted_content),
    { type: 'redacted_thinking', data: 'opaque-redacted-data' }
  );
  assert.equal(nonStreaming.output[3].type, 'function_call');
  assert.equal(nonStreaming.output[3].namespace, 'multi_agent');
  assert.equal(nonStreaming.output[4].type, 'custom_tool_call');
  assert.equal(nonStreaming.output[4].input, 'patch body');
  const anthropicTextItem = nonStreaming.output.find((item: Record<string, any>) => item.type === 'message');
  assert.match(anthropicTextItem.id, /^msg_xwx_[0-9a-f]{32}$/,
    'Anthropic assistant messages must use a Responses-compatible msg_ ID');
  assert.doesNotMatch(anthropicTextItem.id, /^resp_/);

  const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const streamSource = [
    sse('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_stream',
        model: 'claude-sonnet-4-5',
        content: [],
        usage: { input_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, output_tokens: 0 }
      }
    }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'consider' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'StreamSignature123456789==' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hello ' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'world' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 1 }),
    sse('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_parallel_a', name: namespaceWireName, input: {} } }),
    sse('content_block_start', { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'call_parallel_b', name: customWireName, input: {} } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"task":' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"input":"patch"}' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"stream"}' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 3 }),
    sse('content_block_stop', { type: 'content_block_stop', index: 2 }),
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 9 }
    }),
    // Deliberately omit the trailing newline: the decoder must still accept message_stop.
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}`
  ].join('');
  const stream = new AnthropicResponsesStream('fallback', converted.toolContext);
  let responsesSse = '';
  for (let i = 0; i < streamSource.length; i += 17) {
    responsesSse += stream.feed(Buffer.from(streamSource.slice(i, i + 17)));
  }
  responsesSse += stream.finish();
  assert.match(responsesSse, /response\.reasoning_summary_text\.delta/);
  assert.match(responsesSse, /response\.output_text\.delta/);
  assert.match(responsesSse, /response\.function_call_arguments\.delta/);
  assert.match(responsesSse, /response\.custom_tool_call_input\.delta/);
  assert.match(responsesSse, /response\.completed/);
  assert.doesNotMatch(responsesSse, /response\.failed/);
  const streamedResponse = stream.response() as any;
  assert.equal(streamedResponse.output.length, 4);
  assert.equal(streamedResponse.output[2].namespace, 'multi_agent');
  assert.equal(streamedResponse.output[2].arguments, '{"task":"stream"}');
  assert.equal(streamedResponse.output[3].type, 'custom_tool_call');
  assert.equal(streamedResponse.output[3].input, 'patch');
  assert.equal(streamedResponse.usage.input_tokens, 9);
  assert.equal(streamedResponse.usage.output_tokens, 9);
  assert.deepEqual(
    decodeAnthropicThinkingEnvelope(streamedResponse.output[0].encrypted_content),
    { type: 'thinking', thinking: 'consider', signature: 'StreamSignature123456789==' }
  );

  const truncated = new AnthropicResponsesStream('claude-test', converted.toolContext);
  const truncatedOutput = truncated.feed(
    sse('message_start', { type: 'message_start', message: { id: 'msg_cut', model: 'claude-test', usage: {} } })
    + sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_cut', name: namespaceWireName, input: {} } })
    + sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"task":' } })
  ) + truncated.finish();
  assert.match(truncatedOutput, /response\.failed/);
  assert.match(truncatedOutput, /upstream_stream_truncated/);
  assert.equal((truncated.response() as any).output[0].status, 'incomplete');

  const broken = new AnthropicResponsesStream('claude-test');
  const brokenOutput = broken.feed('event: content_block_delta\ndata: {"type":') + broken.finish();
  assert.match(brokenOutput, /invalid_sse_event/);
  assert.match(brokenOutput, /response\.failed/);

  const eventError = new AnthropicResponsesStream('claude-test');
  const eventErrorOutput = eventError.feed(sse('error', {
    type: 'error',
    error: { type: 'overloaded_error', message: 'busy' }
  }));
  assert.match(eventErrorOutput, /response\.failed/);
  assert.match(eventErrorOutput, /overloaded_error/);

  completed.push('Codex Responses-to-Anthropic compatibility bridge');
}

async function testResponsesSnapshotReassembly(): Promise<void> {
  const customItem = {
    id: 'ctc_1', type: 'custom_tool_call', status: 'completed',
    call_id: 'call_1', name: 'exec', input: 'const answer = 42;'
  };
  const builtinItem = {
    id: 'ws_1', type: 'web_search_call', status: 'completed',
    action: { type: 'search', query: 'xwx trace' }
  };
  const completedResponse = {
    id: 'resp_1', model: 'gpt-test', status: 'completed',
    output: [
      { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Inspect the trace.' }] },
      customItem,
      builtinItem
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
  };
  const sse = [
    ['response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', delta: 'Inspect the trace.' }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 1, item: { ...customItem, status: 'in_progress', input: '' } }],
    ['response.custom_tool_call_input.delta', { type: 'response.custom_tool_call_input.delta', item_id: 'ctc_1', delta: 'const answer = ' }],
    ['response.custom_tool_call_input.done', { type: 'response.custom_tool_call_input.done', item_id: 'ctc_1', input: 'const answer = 42;' }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 1, item: customItem }],
    ['response.completed', { type: 'response.completed', response: completedResponse }]
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  const reassembler = new SSEReassembler('responses');
  const bytes = Buffer.from(sse, 'utf8');
  reassembler.feed(bytes.subarray(0, 37), 10);
  reassembler.feed(bytes.subarray(37), 20);
  reassembler.finish(30);
  const snapshot = reassembler.snapshot();
  assert.deepEqual(snapshot.content.map(block => block.type), ['thinking', 'tool_use', 'tool_use']);
  assert.equal(snapshot.content[0].thinking, 'Inspect the trace.');
  assert.equal(snapshot.content[1].name, 'exec');
  assert.equal(snapshot.content[1].rawInput, 'const answer = 42;');
  assert.equal(snapshot.content[2].name, 'web_search');
  assert.deepEqual(snapshot.content[2].input, builtinItem.action);
  assert.equal(reassembler.timing().firstToolMs, 20);

  const partial = new SSEReassembler('responses');
  const partialSse = [
    ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'Working on it.' }],
    ['response.completed', { type: 'response.completed', response: {
      id: 'resp_2', model: 'gpt-test', status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Working on it.' }] },
        customItem
      ]
    } }]
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  partial.feed(partialSse, 5);
  partial.finish(6);
  assert.deepEqual(partial.snapshot().content.map(block => block.type), ['text', 'tool_use'], 'completed response must backfill tools into a partial text snapshot');

  const nonStreaming = snapshotFromJson('responses', completedResponse);
  assert.deepEqual(nonStreaming.content.map(block => block.type), ['thinking', 'tool_use', 'tool_use']);
  assert.equal(nonStreaming.content[1].name, 'exec');
  assert.equal(nonStreaming.content[2].name, 'web_search');

  const bridgeReplay = new SSEReassembler('responses');
  const bridgeSse = responseAsSse({
    id: 'resp_bridge', model: 'gpt-test', status: 'completed',
    output: [{ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Only once.' }] }]
  });
  bridgeReplay.feed(bridgeSse, 7);
  bridgeReplay.finish(8);
  assert.equal(bridgeReplay.snapshot().content.find(block => block.type === 'text')?.text, 'Only once.', 'full output_item payload plus text delta must not duplicate text');

  const failedReplay = new SSEReassembler('responses');
  failedReplay.feed(errorAsResponsesSse(chatErrorToResponseError({ error: { message: 'rate limited', type: 'rate_limit_error' } })), 9);
  failedReplay.finish(10);
  assert.equal(failedReplay.snapshot().stopReason, 'failed');
  assert.equal(failedReplay.snapshot().content.some(block => block.type === 'json'), true, 'failed Responses streams must retain their error instead of falling back to raw SSE');

  const doneOnly = new SSEReassembler('responses');
  doneOnly.feed('event: response.output_text.done\ndata: {"type":"response.output_text.done","text":"done-only text"}\n\n', 11);
  doneOnly.feed('event: response.reasoning_summary_text.done\ndata: {"type":"response.reasoning_summary_text.done","text":"done-only reasoning"}\n\n', 12);
  doneOnly.finish(13);
  assert.equal(doneOnly.snapshot().content.find(block => block.type === 'text')?.text, 'done-only text');
  assert.equal(doneOnly.snapshot().content.find(block => block.type === 'thinking')?.thinking, 'done-only reasoning');

  // Anthropic keeps adding content block types. Server/MCP tool blocks and their results
  // arrive COMPLETE in content_block_start with no follow-up deltas, so anything the
  // reassembler drops here is lost for good — it never reaches the viewer at all.
  const anthropicBlocks = new SSEReassembler('messages');
  const anthropicSse = [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-5', role: 'assistant' } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'xwxdeck' } } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', title: 'XwX Deck', url: 'https://example.test' }] } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'redacted_thinking', data: 'ENCRYPTED_BLOB' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 2 }],
    ['content_block_start', { type: 'content_block_start', index: 3, content_block: { type: 'mcp_tool_result', tool_use_id: 'mcptoolu_1', content: [{ type: 'text', text: 'mcp output' }] } }],
    ['content_block_stop', { type: 'content_block_stop', index: 3 }]
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  anthropicBlocks.feed(Buffer.from(anthropicSse, 'utf8'), 10);
  anthropicBlocks.finish(20);
  const anthropicContent = anthropicBlocks.snapshot().content;
  assert.equal(anthropicContent.length, 4, 'every Anthropic content block must survive reassembly');
  assert.ok(
    anthropicContent.every(block => JSON.stringify(block).length > 24),
    'no block may collapse into an empty text placeholder'
  );
  const serverTool = anthropicContent[0];
  assert.equal(serverTool.type, 'tool_use', 'server_tool_use maps onto the tool_use vocabulary');
  assert.equal(serverTool.name, 'web_search', 'server_tool_use must keep its name');
  assert.equal(serverTool.id, 'srvtoolu_1', 'server_tool_use must keep its id');
  const searchResult = anthropicContent[1];
  assert.equal(searchResult.type, 'tool_result', 'web_search_tool_result maps onto tool_result');
  assert.match(JSON.stringify(searchResult.content), /web_search_result/, 'search results must be preserved verbatim');
  assert.equal(anthropicContent[2].type, 'thinking', 'redacted_thinking stays a thinking block');
  assert.equal(anthropicContent[2].signature, 'ENCRYPTED_BLOB', 'redacted_thinking keeps its encrypted payload');
  assert.match(JSON.stringify(anthropicContent[3].content), /mcp output/, 'mcp_tool_result output must be preserved');
  // 下面这些字段只经由快照序列化的白名单落盘。白名单漏掉它们就是永久数据丢失，而 viewer
  // 早就在读了：没有 tool_use_id 无法把结果和调用配对，没有 wireType 分不清内置工具与客户端工具。
  assert.equal(serverTool.wireType, 'server_tool_use',
    'an Anthropic-executed tool call must stay distinguishable from a client tool_use');
  assert.equal(searchResult.tool_use_id, 'srvtoolu_1', 'tool_result must keep the id that pairs it with its call');
  assert.equal(searchResult.wireType, 'web_search_tool_result',
    'a server tool result must not be indistinguishable from a client tool result');
  assert.equal(anthropicContent[3].wireType, 'mcp_tool_result');
  assert.equal(anthropicContent[3].tool_use_id, 'mcptoolu_1');
  // citations_delta 不开新块：web_search 回答的来源出处只能挂回归属的那个 text 块
  const citing = new SSEReassembler('messages');
  citing.feed(Buffer.from([
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'plain' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '', citations: [] } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '78F in NYC' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', title: 'Weather Underground', url: 'https://example.test/a', cited_text: '78 F' } } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', title: 'AccuWeather', url: 'https://example.test/b', cited_text: 'high 89' } } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }]
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), 'utf8'), 10);
  citing.finish(20);
  const citingContent = citing.snapshot().content;
  assert.equal(citingContent.length, 2, 'citations_delta must not open a block of its own');
  assert.equal(citingContent[1].text, '78F in NYC', 'citations_delta must not disturb text accumulation');
  assert.equal(
    (citingContent[1].citations ?? []).map(entry => (entry as { url?: string }).url).join(','),
    'https://example.test/a,https://example.test/b',
    'every citations_delta must land on its owning text block, in order'
  );
  assert.ok(!('citations' in citingContent[0]), 'an uncited text block must not gain an empty citations array');
  // 非流式 body 走同一个映射：早期各写一份，这条路径把 server_tool_use 退化成裸 json 并丢掉引用
  const nonStream = snapshotFromJson('messages', {
    content: [
      { type: 'text', text: 'cited answer', citations: [{ type: 'web_search_result_location', url: 'https://example.test/c' }] },
      { type: 'server_tool_use', id: 'srvtoolu_9', name: 'web_search', input: { query: 'x' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_9', content: [{ type: 'web_search_result', title: 'T' }] }
    ]
  });
  const nonStreamBlocks = nonStream?.content ?? [];
  assert.equal(nonStreamBlocks[1]?.type, 'tool_use',
    'a non-streamed server_tool_use must not degrade to an opaque json block');
  assert.equal(nonStreamBlocks[1]?.wireType, 'server_tool_use');
  assert.equal(nonStreamBlocks[2]?.tool_use_id, 'srvtoolu_9',
    'the non-streaming path must keep the pairing id too');
  assert.equal(
    (nonStreamBlocks[0]?.citations ?? []).map(entry => (entry as { url?: string }).url).join(','),
    'https://example.test/c',
    'a non-streamed cited answer must keep its sources'
  );

  const semanticResponse = snapshotFromJson('responses', {
    id: 'resp_semantic',
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{
      type: 'message', role: 'assistant', content: [
        { type: 'output_text', text: 'Cited text', annotations: [{ type: 'url_citation', title: 'XwX Deck', url: 'https://example.test/xwxdeck' }] },
        { type: 'refusal', refusal: 'Policy refusal' }
      ]
    }]
  });
  assert.equal(semanticResponse.incompleteReason, 'max_output_tokens',
    'Responses incomplete_details must survive normalization for the Read status notice');
  assert.equal(semanticResponse.content[0]?.type, 'text');
  assert.equal((semanticResponse.content[0]?.citations ?? []).length, 1,
    'Responses output_text annotations must survive as readable citations');
  assert.equal(semanticResponse.content[1]?.type, 'refusal',
    'a refusal must remain distinguishable from ordinary assistant text');

  const responseAnnotations = new SSEReassembler('responses');
  responseAnnotations.feed([
    ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'Streaming citation' }],
    ['response.output_text.annotation.added', { type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', title: 'Source', url: 'https://example.test/source' } }],
    ['response.incomplete', { type: 'response.incomplete', response: { id: 'resp_cut', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] } }]
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), 10);
  responseAnnotations.finish(20);
  assert.equal(responseAnnotations.snapshot().incompleteReason, 'max_output_tokens');
  assert.equal((responseAnnotations.snapshot().content[0]?.citations ?? []).length, 1,
    'streamed response annotations must remain attached to the output text');

  const refusedStream = new SSEReassembler('responses');
  refusedStream.feed('event: response.refusal.done\ndata: {"type":"response.refusal.done","refusal":"No"}\n\n', 11);
  refusedStream.finish(12);
  assert.equal(refusedStream.snapshot().content[0]?.type, 'refusal');

  const choices = snapshotFromJson('chat-completions', {
    id: 'chat_multi',
    choices: [
      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'A' } },
      { index: 1, finish_reason: 'stop', message: { role: 'assistant', content: 'B' } }
    ]
  });
  assert.deepEqual(choices.content.map(block => block.choiceIndex), [0, 1],
    'multiple Chat Completions choices must keep their visual grouping boundary');
  completed.push('Responses custom tool and built-in output reassembly');
}

async function testAtomicFileWriteRetries(): Promise<void> {
  const base = path.join(root, 'atomic-write-retry');
  const target = path.join(base, 'index.json');
  await fs.mkdir(base, { recursive: true });
  await fs.writeFile(target, 'old', 'utf8');

  const originalRename = nodeFs.promises.rename;
  let attempts = 0;
  nodeFs.promises.rename = async (source, destination) => {
    attempts += 1;
    if (attempts < 3) {
      throw Object.assign(new Error('simulated Windows destination lock'), { code: 'EPERM' });
    }
    return originalRename(source, destination);
  };
  try {
    await writeFileAtomic(target, 'new');
  } finally {
    nodeFs.promises.rename = originalRename;
  }

  assert.equal(attempts, 3);
  assert.equal(await fs.readFile(target, 'utf8'), 'new');
  assert.deepEqual((await fs.readdir(base)).filter(name => name.endsWith('.tmp')), []);
  completed.push('atomic file writes retry transient Windows destination locks');
}

async function testCodexProtocolPolicy(): Promise<void> {
  assert.equal(OFFICIAL_MODEL_REGISTRY.length, 9);
  const maintenanceDoc = await fs.readFile(path.resolve('docs/model-capability-maintenance.md'), 'utf8');
  for (const record of OFFICIAL_MODEL_REGISTRY) {
    assert.match(record.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(record.sources.length > 0);
    assert.ok(record.protocols.length > 0);
    if (record.capability.contextWindow !== undefined) {
      assert.ok(record.capability.contextWindow > 0);
    }
    if (record.capability.toolCalling !== undefined) {
      assert.equal(record.capability.toolCalling, true);
    }
    assert.ok(maintenanceDoc.includes(record.modelId));
    for (const source of record.sources) {
      assert.match(source.url, /^https:\/\/(?:api-docs\.deepseek\.com|docs\.z\.ai|platform\.kimi\.com|www\.volcengine\.com)\//);
      assert.ok(maintenanceDoc.includes(source.url));
    }
  }
  assert.deepEqual(findOfficialModelRecord('provider/GLM_5.2')?.claudeOneMillionRoles, ['opus', 'sonnet']);
  assert.deepEqual(findOfficialModelRecord('models/kimi-k3')?.claudeOneMillionRoles, ['fable', 'opus', 'sonnet', 'haiku']);
  assert.equal(findOfficialModelRecord('deepseek-v4-pro')?.capability.maxOutputTokens, 393_216);
  assert.equal(findOfficialModelRecord('deepseek-v4-flash-260425')?.codexRecommendedProtocol, 'chat-completions',
    'dated DeepSeek V4 snapshots share the base model protocol contract');
  assert.equal(findOfficialModelRecord('doubao-seed-2-1-turbo-260628')?.codexRecommendedProtocol, 'chat-completions');
  assert.equal(resolveCatalogCodexProtocol({
    id: 'deepseek-v4-flash-260425',
    vendor: '火山方舟',
    protocols: ['openai-responses', 'chat-completions'],
    clients: ['codex']
  }), 'chat-completions');
  assert.equal(resolveCatalogCodexProtocol({
    id: 'doubao-seed-2-1-turbo-260628',
    vendor: '火山方舟',
    protocols: ['openai-responses', 'chat-completions'],
    clients: ['codex']
  }), 'chat-completions');
  assert.equal(resolveCompatibleServiceCodexProtocol('gpt-5.6-terra'), 'responses');
  assert.equal(resolveCompatibleServiceCodexProtocol('GROK-4'), 'chat-completions');
  assert.equal(resolveCompatibleServiceCodexProtocol('deepseek-v3.2'), 'chat-completions');
  assert.equal(resolveCompatibleServiceCodexProtocol('qwen3-coder'), 'chat-completions');
  assert.equal(resolveCompatibleServiceCodexProtocol('custom-model'), 'chat-completions');
  assert.equal(resolveCompatibleServiceCodexProtocol('claude-sonnet-4-5'), 'anthropic-messages');
  assert.equal(resolveCompatibleServiceCodexProtocol('codex-auto-review'), 'responses');
  const claudeEntry = (patch: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry => ({
    id: 'claude-sonnet-4-5',
    vendor: 'Anthropic',
    protocols: ['anthropic-messages'],
    clients: ['codex'],
    toolCalling: true,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    capabilitySources: {},
    ...patch
  });
  assert.equal(resolveCatalogCodexProtocol(claudeEntry()), 'anthropic-messages');
  assert.equal(resolveCatalogCodexProtocol(claudeEntry({
    protocols: ['openai-responses'],
    vendor: '兼容服务'
  })), 'responses', 'explicit server protocol overrides Claude name inference');
  for (const id of ['kimi-k3', 'glm-5.2', 'deepseek-v4-pro', 'qwen3-coder']) {
    assert.equal(resolveCatalogCodexProtocol(claudeEntry({
      id,
      vendor: '兼容服务',
      protocols: ['openai-responses', 'chat-completions', 'anthropic-messages']
    })), 'chat-completions', `${id} must prefer the Chat bridge when 兼容服务 exposes several protocols`);
  }
  assert.equal(resolveCatalogCodexProtocol(claudeEntry({
    id: 'gpt-5.6',
    vendor: 'OpenAI',
    protocols: ['openai-responses', 'chat-completions', 'anthropic-messages']
  })), 'responses');
  assert.equal(resolveCatalogCodexProtocol(claudeEntry({
    id: 'codex-auto-review',
    vendor: '兼容服务',
    protocols: ['openai-responses', 'chat-completions']
  })), 'responses');
  assert.equal(isKnownNonConversationalModel('text-embedding-v4'), true);
  assert.equal(isKnownNonConversationalModel('gpt-image-2'), true);
  assert.equal(isKnownNonConversationalModel('qwen-vl-ocr'), true);
  assert.equal(isKnownNonConversationalModel('qwen3-vl-plus'), false);
  assert.equal(isKnownNonConversationalModel('gui-plus'), false);
  assert.equal(tapProxyTest.protocolForResolvedRoute({
    apiType: 'messages',
    wireProtocol: 'chat-completions'
  }), 'anthropic-messages', 'a native Claude Messages route must not inherit a Codex gateway default');
  assert.equal(tapProxyTest.protocolForResolvedRoute({
    apiType: 'responses',
    wireProtocol: 'chat-completions',
    transform: 'responses-to-chat'
  }), 'openai-chat-completions', 'an actual Responses-to-Chat bridge must report its upstream wire protocol');
  assert.equal(tapProxyTest.protocolForResolvedRoute({
    apiType: 'responses',
    wireProtocol: 'anthropic-messages',
    transform: 'responses-to-anthropic'
  }), 'anthropic-messages', 'an actual Responses-to-Anthropic bridge must report its upstream wire protocol');
  completed.push('兼容服务 ChatGPT protocol policy');
}

async function testClaudeProviderSwitch(): Promise<void> {
  const previousHome = process.env.XWX_DECK_CLIENT_HOME;
  const base = path.join(root, 'claude-provider');
  process.env.XWX_DECK_CLIENT_HOME = path.join(base, 'home');
  try {
    const paths = resolveClientPaths();
    await fs.mkdir(path.dirname(paths.claudeSettingsPath), { recursive: true });
    await fs.writeFile(paths.claudeSettingsPath, `${JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://previous.example',
        ANTHROPIC_API_KEY: 'previous-api-key',
        ANTHROPIC_MODEL: 'stale-pinned-model',
        ANTHROPIC_FAST_MODEL: 'stale-fast-model',
        ANTHROPIC_REASONING_MODEL: 'previous-reasoning',
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'previous-fable',
        ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'Previous Fable',
        ANTHROPIC_SMALL_FAST_MODEL: 'previous-fast',
        CLAUDE_CODE_SUBAGENT_MODEL: 'previous-subagent',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: 'previous-window',
        KEEP: 'before'
      },
      model: 'haiku',
      permissions: { allow: ['Read'] }
    }, null, 2)}\n`);
    const manager = new ClaudeConfigManager(path.join(base, 'user-data'));
    const enabled = await manager.update({
      enabled: true,
      baseUrl: 'https://compatible.example/v1',
      bearerToken: 'qa-claude-key',
      models: {
        fable: 'deepseek-v4-pro',
        opus: 'deepseek-v4-pro',
        sonnet: 'deepseek-v4-pro',
        haiku: 'deepseek-v4-flash'
      },
      catalog: [
        {
          id: 'deepseek-v4-pro',
          vendor: 'DeepSeek',
          protocols: ['anthropic-messages'],
          clients: ['claude'],
          contextWindow: 1_000_000
        },
        {
          id: 'deepseek-v4-flash',
          vendor: 'DeepSeek',
          protocols: ['anthropic-messages'],
          clients: ['claude'],
          contextWindow: 1_000_000
        }
      ]
    });
    assert.equal(enabled.enabled, true);
    const applied = JSON.parse(await fs.readFile(paths.claudeSettingsPath, 'utf8'));
    assert.equal(applied.env.ANTHROPIC_BASE_URL, 'https://compatible.example/anthropic');
    assert.equal(applied.env.ANTHROPIC_AUTH_TOKEN, 'qa-claude-key');
    assert.equal(applied.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(applied.env.ANTHROPIC_MODEL, undefined, '兼容服务 must clear a stale session-wide model pin');
    assert.equal(applied.env.ANTHROPIC_FAST_MODEL, undefined, '兼容服务 must clear a stale fast-model pin');
    assert.equal(applied.env.ANTHROPIC_REASONING_MODEL, undefined);
    assert.equal(applied.env.ANTHROPIC_SMALL_FAST_MODEL, undefined);
    assert.equal(applied.env.CLAUDE_CODE_SUBAGENT_MODEL, undefined);
    assert.equal(applied.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1000000');
    assert.equal(applied.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'deepseek-v4-pro');
    assert.equal(applied.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME, 'deepseek-v4-pro');
    assert.equal(applied.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-v4-pro[1m]');
    assert.equal(applied.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'deepseek-v4-pro[1m]');
    assert.equal(applied.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, 'deepseek-v4-pro[1m]');
    assert.equal(applied.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-v4-flash');
    assert.equal(applied.model, 'haiku', '兼容服务 takeover must preserve the user-owned default role');

    const oneMillionRoleMappings = claudeCompatibleServiceModelEnv(
      {
        fable: 'kimi-k3',
        opus: 'glm-5.2',
        sonnet: 'kimi-k3',
        haiku: 'kimi-k3'
      },
      [
        {
          id: 'glm-5.2',
          vendor: '智谱',
          protocols: ['anthropic-messages'],
          clients: ['claude'],
          contextWindow: 1_000_000
        },
        {
          id: 'kimi-k3',
          vendor: 'Kimi',
          protocols: ['anthropic-messages'],
          clients: ['claude'],
          contextWindow: 1_048_576
        }
      ],
      'fable'
    );
    assert.equal(oneMillionRoleMappings.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.2[1m]');
    assert.equal(oneMillionRoleMappings.ANTHROPIC_DEFAULT_SONNET_MODEL, 'kimi-k3[1m]');
    assert.equal(oneMillionRoleMappings.ANTHROPIC_DEFAULT_FABLE_MODEL, 'kimi-k3[1m]');
    assert.equal(oneMillionRoleMappings.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'kimi-k3[1m]');
    assert.equal(oneMillionRoleMappings.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1048576');

    const officialRoleBoundaries = claudeCompatibleServiceModelEnv(
      {
        fable: 'deepseek-v4-pro[1m]',
        opus: 'deepseek-v4-flash[1m]',
        sonnet: 'glm-5.2',
        haiku: 'deepseek-v4-flash[1m]'
      },
      [
        {
          id: 'deepseek-v4-pro',
          vendor: 'DeepSeek',
          protocols: ['anthropic-messages'],
          clients: ['claude'],
          contextWindow: 1_000_000
        },
        {
          id: 'deepseek-v4-flash',
          vendor: 'DeepSeek',
          protocols: ['anthropic-messages'],
          clients: ['claude'],
          contextWindow: 1_000_000
        },
        {
          id: 'glm-5.2',
          vendor: '智谱',
          protocols: ['anthropic-messages'],
          clients: ['claude'],
          contextWindow: 1_000_000
        }
      ]
    );
    assert.equal(officialRoleBoundaries.ANTHROPIC_DEFAULT_FABLE_MODEL, 'deepseek-v4-pro');
    assert.equal(officialRoleBoundaries.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-v4-flash');
    assert.equal(officialRoleBoundaries.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm-5.2[1m]');
    assert.equal(officialRoleBoundaries.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-v4-flash');

    applied.env.KEEP = 'changed-externally';
    await fs.writeFile(paths.claudeSettingsPath, `${JSON.stringify(applied, null, 2)}\n`);
    const disabled = await manager.update({ enabled: false });
    assert.equal(disabled.enabled, false);
    const restored = JSON.parse(await fs.readFile(paths.claudeSettingsPath, 'utf8'));
    assert.equal(restored.env.ANTHROPIC_BASE_URL, 'https://previous.example');
    assert.equal(restored.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(restored.env.ANTHROPIC_API_KEY, 'previous-api-key');
    assert.equal(restored.env.ANTHROPIC_MODEL, 'stale-pinned-model');
    assert.equal(restored.env.ANTHROPIC_FAST_MODEL, 'stale-fast-model');
    assert.equal(restored.env.ANTHROPIC_REASONING_MODEL, 'previous-reasoning');
    assert.equal(restored.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'previous-fable');
    assert.equal(restored.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME, 'Previous Fable');
    assert.equal(restored.env.ANTHROPIC_SMALL_FAST_MODEL, 'previous-fast');
    assert.equal(restored.env.CLAUDE_CODE_SUBAGENT_MODEL, 'previous-subagent');
    assert.equal(restored.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, 'previous-window');
    assert.equal(restored.env.KEEP, 'changed-externally');
    assert.deepEqual(restored.permissions, { allow: ['Read'] });

    await manager.update({
      enabled: true,
      baseUrl: 'https://compatible.example/v1',
      bearerToken: 'qa-claude-key',
      models: { fable: '', opus: 'opus-qa', sonnet: 'sonnet-qa', haiku: 'haiku-qa' }
    });
    const externallyChanged = JSON.parse(await fs.readFile(paths.claudeSettingsPath, 'utf8'));
    externallyChanged.env.ANTHROPIC_MODEL = 'external-model-change';
    await fs.writeFile(paths.claudeSettingsPath, `${JSON.stringify(externallyChanged, null, 2)}\n`);
    await manager.update({ enabled: false });
    const externalPreserved = JSON.parse(await fs.readFile(paths.claudeSettingsPath, 'utf8'));
    assert.equal(externalPreserved.env.ANTHROPIC_MODEL, 'external-model-change');

    assert.equal(claudeCompatibleServiceBaseUrl('https://compatible.example/v1'), 'https://compatible.example/anthropic');
    assert.equal(claudeCompatibleServiceBaseUrl('https://compatible.example/anthropic'), 'https://compatible.example/anthropic');
    assert.equal(claudeCompatibleServiceBaseUrl('https://compatible.example/anthropic/v1/'), 'https://compatible.example/anthropic');

    await manager.update({
      enabled: true,
      baseUrl: 'https://compatible.example/anthropic/v1',
      bearerToken: 'qa-claude-key',
      models: { fable: 'fable-qa', opus: 'opus-qa', sonnet: 'sonnet-qa', haiku: 'haiku-qa' }
    });
    const healthy = await manager.read();
    assert.equal(healthy.enabled, true);
    assert.equal(healthy.status, 'active');
    const driftedSettings = JSON.parse(await fs.readFile(paths.claudeSettingsPath, 'utf8'));
    delete driftedSettings.env.ANTHROPIC_BASE_URL;
    await fs.writeFile(paths.claudeSettingsPath, `${JSON.stringify(driftedSettings, null, 2)}\n`);
    const drifted = await manager.read();
    assert.equal(drifted.enabled, false);
    assert.equal(drifted.status, 'drifted');
    assert.match(drifted.detail || '', /ANTHROPIC_BASE_URL/);

    await Promise.all([
      manager.update({
        enabled: true,
        baseUrl: 'https://compatible.example/v1',
        bearerToken: 'qa-claude-key',
        models: { fable: 'fable-a', opus: 'opus-a', sonnet: 'sonnet-a', haiku: 'haiku-a' }
      }),
      manager.update({
        enabled: true,
        baseUrl: 'https://compatible.example/v1',
        bearerToken: 'qa-claude-key',
        models: { fable: 'fable-b', opus: 'opus-b', sonnet: 'sonnet-b', haiku: 'haiku-b' }
      })
    ]);
    const serialized = JSON.parse(await fs.readFile(paths.claudeSettingsPath, 'utf8'));
    assert.equal(serialized.env.ANTHROPIC_BASE_URL, 'https://compatible.example/anthropic');
    assert.equal(serialized.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'fable-b');
    assert.equal((await manager.read()).enabled, true);
    await manager.update({ enabled: false });

    const envOverrideBefore = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = 'https://shell-override.example';
    try {
      await assert.rejects(
        () => manager.update({
          enabled: true,
          baseUrl: 'https://compatible.example/v1',
          bearerToken: 'qa-claude-key',
          models: { fable: '', opus: '', sonnet: '', haiku: '' }
        }),
        (error: unknown) => error instanceof Error
          && error.message === 'Claude 接入失败：检测到环境变量 ANTHROPIC_BASE_URL，本地配置已失效，请移除相关环境变量后重试。'
      );
    } finally {
      if (envOverrideBefore === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = envOverrideBefore;
    }

    const providerModeSettings = JSON.parse(await fs.readFile(paths.claudeSettingsPath, 'utf8'));
    providerModeSettings.env.CLAUDE_CODE_USE_VERTEX = true;
    await fs.writeFile(paths.claudeSettingsPath, `${JSON.stringify(providerModeSettings, null, 2)}\n`);
    await assert.rejects(() => manager.update({
      enabled: true,
      baseUrl: 'https://compatible.example/v1',
      bearerToken: 'qa-claude-key',
      models: { fable: '', opus: '', sonnet: '', haiku: '' }
    }), /CLAUDE_CODE_USE_VERTEX/);
    delete providerModeSettings.env.CLAUDE_CODE_USE_VERTEX;
    await fs.writeFile(paths.claudeSettingsPath, `${JSON.stringify(providerModeSettings, null, 2)}\n`);

    const deletedConfigPath = path.join(base, 'deleted-live', 'settings.json');
    await fs.mkdir(path.dirname(deletedConfigPath), { recursive: true });
    await fs.writeFile(deletedConfigPath, '{}\n');
    const deletedManager = new ClaudeConfigManager(path.join(base, 'deleted-live-state'), {
      ...paths,
      claudeSettingsPath: deletedConfigPath
    });
    await deletedManager.update({
      enabled: true,
      baseUrl: 'https://compatible.example/v1',
      bearerToken: 'qa-claude-key',
      models: { fable: '', opus: '', sonnet: '', haiku: '' }
    });
    await fs.rm(deletedConfigPath);
    assert.equal((await deletedManager.read()).status, 'drifted');
    await assert.rejects(
      () => deletedManager.update({ enabled: false }),
      /配置文件已被外部删除；恢复状态已保留/
    );
    assert.equal((await deletedManager.read()).status, 'drifted', 'failed disable must retain recovery state');
    await deletedManager.update({
      enabled: true,
      baseUrl: 'https://compatible.example/v1',
      bearerToken: 'qa-claude-key',
      models: { fable: '', opus: '', sonnet: '', haiku: '' }
    });
    await deletedManager.update({ enabled: false });

    const corruptStateDir = path.join(base, 'corrupt-state');
    await fs.mkdir(corruptStateDir, { recursive: true });
    await fs.writeFile(path.join(corruptStateDir, 'claude-compatible-state.json'), '{broken');
    const corruptStateManager = new ClaudeConfigManager(corruptStateDir, paths);
    await assert.rejects(() => corruptStateManager.read(), /恢复状态已损坏/);

    const legacyHome = path.join(base, 'legacy-home');
    const legacyDir = path.join(legacyHome, '.claude');
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, 'claude.json'), '{}\n');
    assert.equal(resolveClientPaths({}, legacyHome).claudeSettingsPath, path.join(legacyDir, 'claude.json'));
    const customDir = path.join(base, 'custom-claude');
    assert.equal(
      resolveClientPaths({}, legacyHome, { claudeConfigDir: customDir }).claudeSettingsPath,
      path.join(customDir, 'settings.json')
    );
    const environmentDir = path.join(base, 'environment-claude');
    assert.equal(
      resolveClientPaths({ CLAUDE_CONFIG_DIR: environmentDir }, legacyHome, { claudeConfigDir: customDir }).claudeSettingsPath,
      path.join(environmentDir, 'settings.json'),
      'Claude CLI environment override must win over the persisted UI fallback'
    );
  } finally {
    if (previousHome === undefined) delete process.env.XWX_DECK_CLIENT_HOME;
    else process.env.XWX_DECK_CLIENT_HOME = previousHome;
  }
  completed.push('Claude 兼容服务 path resolution, serialized verified writes, drift detection, and field-safe restore');
}

async function testModelCatalogMetadata(): Promise<void> {
  const autoRequests: string[] = [];
  const autoCatalog = await fetchCompatibleServiceModelCatalog(
    'https://multi.example/v1',
    'auto-key',
    async input => {
      const url = String(input);
      autoRequests.push(url);
      if (url.endsWith('/anthropic/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'claude-auto' }] }), { status: 200 });
      }
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          data: [{
            id: 'gpt-auto',
            supported_protocols: ['openai-responses']
          }]
        }), { status: 200 });
      }
      if (url === 'https://models.dev/api.json' || url.includes('litellm')) {
        return new Response('{}', { status: 200 });
      }
      return new Response('{}', { status: 404 });
    },
    undefined,
    [],
    { catalogMode: 'auto' }
  );
  assert.ok(autoRequests.includes('https://multi.example/v1/models'));
  assert.ok(autoRequests.includes('https://multi.example/anthropic/v1/models'));
  assert.deepEqual(
    autoCatalog.find(model => model.id === 'gpt-auto')?.protocols,
    ['openai-responses'],
    'explicit per-model protocol metadata must override an ambiguous endpoint default'
  );
  assert.ok(autoCatalog.find(model => model.id === 'claude-auto')?.protocols.includes('anthropic-messages'));

  const openAiCompatibleRequests: string[] = [];
  const openAiCompatible = await fetchCompatibleServiceModelCatalog(
    'https://ark.cn-beijing.volces.com/api/v3',
    'ark-key',
    async input => {
      openAiCompatibleRequests.push(String(input));
      return new Response(JSON.stringify({ data: [{ id: 'ep-ark-demo' }] }), { status: 200 });
    },
    undefined,
    [],
    { catalogMode: 'openai' }
  );
  assert.deepEqual(
    openAiCompatibleRequests.filter(url => url.includes('volces.com')),
    [
      'https://ark.cn-beijing.volces.com/api/v3/models',
      'https://ark.cn-beijing.volces.com/api/v3/v1/models'
    ]
  );
  assert.equal(openAiCompatible[0]?.id, 'ep-ark-demo');
  await assert.rejects(
    () => fetchCompatibleServiceModelCatalog(
      'https://ark.cn-beijing.volces.com/api/v3',
      'ark-key',
      fetch,
      undefined,
      [],
      { catalogMode: 'manual' }
    ),
    /手动填写模型或 Endpoint ID/
  );

  const catalog = normalizeModelCatalog({ data: [
    {
      id: 'multi-model',
      vendor: 'Vendor A',
      protocols: ['anthropic_messages', 'openai-responses'],
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }],
      default_reasoning_level: 'xhigh',
      capabilities: { input_modalities: ['text', 'image'], supports_responses_compact: true }
    },
    { id: 'multi-model', supported_protocols: ['chat/completions'], compatible_clients: ['spreadsheet'] },
    { id: 'plain-model', owned_by: 'paper-llm-hub' }
  ] });
  assert.equal(catalog.length, 2);
  assert.deepEqual(catalog[0].protocols, ['anthropic-messages', 'openai-responses', 'chat-completions']);
  assert.equal(catalog[0].vision, true);
  assert.equal(catalog[0].responsesCompact, true);
  assert.deepEqual(catalog[0].reasoningLevels, ['low', 'xhigh']);
  assert.equal(catalog[0].defaultReasoningLevel, 'xhigh');
  assert.deepEqual(catalog[0].clients, []);
  assert.equal(catalog[1].vendor, '兼容服务');
  assert.deepEqual(catalog[1].protocols, []);

  const requested: string[] = [];
  const discovered = await fetchCompatibleServiceModelCatalog('https://compatible.example/v1', 'qa-token', async (input, init) => {
    const url = String(input);
    requested.push(url);
    if (url === 'https://models.dev/api.json' || url.includes('litellm')) {
      return new Response('{}', { status: 200 });
    }
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer qa-token');
    const payload = url.endsWith('/anthropic/v1/models')
      ? { data: [{ id: 'shared-model' }, { id: 'claude-opus-4-7', owned_by: 'anthropic' }] }
      : url.endsWith('/gemini/v1beta/models')
        ? { models: [{ name: 'models/gemini-3-pro' }] }
        : {
          data: [
            { id: 'shared-model' },
            {
              id: 'gpt-5.5',
              owned_by: 'openai',
              vision: false,
              input_modalities: ['text'],
              context_window: 1_234,
              supports_tool_calling: false
            }
          ]
        };
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  assert.deepEqual(requested.sort(), [
    'https://compatible.example/anthropic/v1/models',
    'https://compatible.example/gemini/v1beta/models',
    'https://compatible.example/v1/models',
    'https://models.dev/api.json',
    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
  ]);
  assert.deepEqual(discovered.map(item => item.id), ['claude-opus-4-7', 'gemini-3-pro', 'gpt-5.5', 'shared-model']);
  const discoveredGpt = discovered.find(item => item.id === 'gpt-5.5')!;
  assert.equal(discoveredGpt.vision, true, '兼容服务 per-model capability fields must be ignored');
  assert.deepEqual(discoveredGpt.inputModalities, ['text', 'image', 'pdf']);
  assert.equal(discoveredGpt.contextWindow, 262_144, '兼容服务 context metadata must not override maintained sources');
  assert.equal(discoveredGpt.toolCalling, true, '兼容服务 tool metadata must not override maintained sources');
  assert.equal(discoveredGpt.capabilitySources?.vision, 'builtin');
  const shared = discovered.find(item => item.id === 'shared-model');
  assert.deepEqual(shared?.protocols, ['openai-responses', 'chat-completions', 'anthropic-messages']);
  assert.deepEqual(shared?.clients, ['codex', 'claude']);
  const partialRefresh = await fetchCompatibleServiceModelCatalog(
    'https://compatible.example/v1',
    'qa-token',
    async input => {
      const url = String(input);
      if (url === 'https://models.dev/api.json' || url.includes('litellm')) {
        return new Response('{}', { status: 200 });
      }
      if (url.endsWith('/anthropic/v1/models')) return new Response('{}', { status: 503 });
      if (url.endsWith('/gemini/v1beta/models')) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: 'fresh-openai-model' }] }), { status: 200 });
    },
    undefined,
    normalizeModelCatalog([
      {
        id: 'cached-claude-model',
        protocols: ['anthropic-messages'],
        clients: ['claude', 'codex']
      },
      {
        id: 'removed-openai-model',
        protocols: ['openai-responses', 'chat-completions'],
        clients: ['codex']
      }
    ])
  );
  assert.ok(partialRefresh.some(item => item.id === 'cached-claude-model'));
  assert.ok(partialRefresh.some(item => item.id === 'fresh-openai-model'));
  assert.ok(
    !partialRefresh.some(item => item.id === 'removed-openai-model'),
    'a successful endpoint must not retain models removed from its fresh response'
  );
  const enriched = await enrichModelCatalog(
    normalizeModelCatalog([
      { id: 'gpt-5.4', clients: ['codex'], protocols: ['openai-responses'] },
      { id: 'GLM_5.2', clients: ['codex'], protocols: ['chat-completions'] },
      { id: 'deepseek-v4-pro', clients: ['codex'], protocols: ['chat-completions'] },
      { id: 'deepseek-v4-flash', clients: ['codex'], protocols: ['chat-completions'] },
      { id: 'kimi-k3', clients: ['codex'], protocols: ['chat-completions'] },
      { id: 'kimi-k2.7-code', clients: ['codex'], protocols: ['chat-completions'] },
      { id: 'kimi-k2.6', clients: ['codex'], protocols: ['chat-completions'] },
      { id: 'kimi-k2.5', clients: ['codex'], protocols: ['chat-completions'] },
      { id: 'AMBIGUOUS MODEL', clients: ['codex'], protocols: ['chat-completions'] },
      { id: 'litellm-only', clients: ['codex'], protocols: ['chat-completions'] },
      { id: 'custom-internal', clients: ['codex'], protocols: ['chat-completions'] },
      { id: 'doubao-seed-1-6-flash', clients: ['codex'], protocols: ['chat-completions'] },
      { id: 'gui-plus', clients: ['codex'], protocols: ['chat-completions'] }
    ]),
    async (input) => {
      const url = String(input);
      if (url.includes('litellm')) {
        return new Response(JSON.stringify({
          'gpt-5.4': { supports_reasoning: true, supports_xhigh_reasoning_effort: true, max_input_tokens: 128000 },
          'zhipu/glm-5.2': { max_input_tokens: 256000, max_output_tokens: 65536, supports_function_calling: false },
          'litellm-only': { max_input_tokens: 32768 }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        openai: { models: {
          'gpt-5.4': { limit: { context: 200000, output: 64000 }, reasoning: true }
        } },
        // The directory claims this one cannot reason; the gateway probe
        // observed reasoning tokens, so the probe must win.
        volcengine: { models: {
          'doubao-seed-1-6-flash': { reasoning: false }
        } },
        zhipuai: { models: {
          'glm-5.2': {
            limit: { context: 1000000, output: 131072 },
            modalities: { input: ['text'], output: ['text'] },
            reasoning: true,
            tool_call: true,
            interleaved: true
          }
        } },
        reseller: { models: {
          'glm-5.2': {
            limit: { context: 128000, output: 8192 },
            tool_call: false,
            structured_output: true
          }
        } },
        another_reseller: { models: {
          'glm_5_2': { structured_output: true }
        } },
        provider_a: { models: {
          'ambiguous-model': { limit: { context: 65536 } }
        } },
        provider_b: { models: {
          'ambiguous_model': { limit: { context: 131072 } }
        } }
      }), { status: 200 });
    }
  );
  const gpt = enriched.find(item => item.id === 'gpt-5.4')!;
  // models.dev reports `reasoning: false` for this id in the fixture above; the
  // gateway probe observed reasoning tokens and must outrank the directory,
  // otherwise the model ships with an empty Codex effort picker.
  const probedFlash = enriched.find(item => item.id === 'doubao-seed-1-6-flash')!;
  assert.equal(probedFlash.reasoning, true, 'a directory claiming non-reasoning must not veto a gateway measurement');
  assert.equal(probedFlash.capabilitySources?.reasoning, 'probed');
  const glm = enriched.find(item => item.id === 'GLM_5.2')!;
  const deepseekPro = enriched.find(item => item.id === 'deepseek-v4-pro')!;
  const deepseekFlash = enriched.find(item => item.id === 'deepseek-v4-flash')!;
  const kimiK3 = enriched.find(item => item.id === 'kimi-k3')!;
  const kimiK27 = enriched.find(item => item.id === 'kimi-k2.7-code')!;
  const kimiK26 = enriched.find(item => item.id === 'kimi-k2.6')!;
  const kimiK25 = enriched.find(item => item.id === 'kimi-k2.5')!;
  const ambiguous = enriched.find(item => item.id === 'AMBIGUOUS MODEL')!;
  const liteOnly = enriched.find(item => item.id === 'litellm-only')!;
  const custom = enriched.find(item => item.id === 'custom-internal')!;
  const guiPlus = enriched.find(item => item.id === 'gui-plus')!;
  assert.deepEqual(gpt.reasoningLevels, ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(gpt.defaultReasoningLevel, 'medium');
  assert.equal(gpt.contextWindow, 200000, 'models.dev must win over LiteLLM per capability field');
  assert.equal(gpt.capabilitySources?.contextWindow, 'models.dev');
  assert.equal(glm.contextWindow, 1000000, 'punctuation/case variants must resolve when unique');
  assert.equal(glm.maxOutputTokens, 131072);
  assert.equal(glm.toolCalling, true);
  assert.equal(glm.structuredOutput, true);
  assert.equal(glm.interleavedThinking, true);
  assert.equal(glm.capabilitySources?.contextWindow, 'official');
  assert.equal(glm.capabilitySources?.toolCalling, 'official');
  assert.equal(deepseekPro.contextWindow, 1_000_000);
  assert.equal(deepseekPro.maxOutputTokens, 393_216);
  assert.equal(deepseekPro.toolCalling, true);
  assert.equal(deepseekPro.structuredOutput, true);
  assert.equal(deepseekPro.capabilitySources?.contextWindow, 'official');
  assert.deepEqual(deepseekPro.reasoningLevels, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(deepseekPro.defaultReasoningLevel, 'high');
  assert.equal(deepseekPro.capabilitySources?.reasoning, 'official');
  assert.equal(deepseekFlash.contextWindow, 1_000_000);
  assert.equal(deepseekFlash.maxOutputTokens, 393_216);
  assert.deepEqual(deepseekFlash.reasoningLevels, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(deepseekFlash.defaultReasoningLevel, 'high');
  assert.equal(kimiK3.contextWindow, 1_048_576);
  assert.deepEqual(kimiK3.inputModalities, ['text', 'image', 'video']);
  assert.equal(kimiK3.toolCalling, true);
  assert.equal(kimiK3.capabilitySources?.contextWindow, 'official');
  assert.equal(kimiK27.contextWindow, 262_144);
  assert.equal(kimiK26.contextWindow, 262_144);
  assert.equal(kimiK25.contextWindow, 262_144);
  assert.equal(kimiK26.vision, true);
  assert.equal(ambiguous.contextWindow, 65_536, 'conflicting exact aliases must use the smallest safe limit');
  assert.equal(ambiguous.reasoning, false, 'unknown reasoning must use the conservative operational fallback');
  assert.equal(ambiguous.capabilitySources?.contextWindow, 'models.dev');
  assert.equal(liteOnly.contextWindow, 32768, 'LiteLLM must fill fields models.dev does not publish');
  assert.equal(liteOnly.capabilitySources?.contextWindow, 'litellm');
  assert.equal(custom.reasoningLevels, undefined);
  assert.equal(custom.contextWindow, 262_144);
  assert.equal(custom.maxOutputTokens, 8_192);
  assert.equal(custom.toolCalling, true);
  assert.equal(custom.reasoning, false);
  assert.equal(custom.capabilitySources?.contextWindow, 'fallback');
  assert.ok(custom.missingCapabilities?.includes('contextWindow'));
  assert.equal(guiPlus.toolCalling, true);
  assert.equal(guiPlus.capabilitySources?.toolCalling, 'builtin');
  const compatibleServiceWins = (await enrichModelCatalog(
    normalizeModelCatalog([{
      id: 'kimi-k3',
      context_window: 900_000,
      clients: ['codex'],
      protocols: ['chat-completions']
    }]),
    async () => new Response('{}', { status: 200 })
  ))[0];
  assert.equal(compatibleServiceWins.contextWindow, 900_000, '兼容服务 metadata must override the official overlay');
  assert.equal(compatibleServiceWins.capabilitySources?.contextWindow, 'compatible');

  const capabilityCacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xwx-capability-cache-'));
  try {
    const capabilityCachePath = path.join(capabilityCacheRoot, 'model-capabilities-cache.json');
    const cachedInput = normalizeModelCatalog([{
      id: 'cached-model',
      clients: ['codex'],
      protocols: ['chat-completions']
    }]);
    const warm = await enrichModelCatalog(cachedInput, async input => (
      String(input).includes('litellm')
        ? new Response('{}', { status: 200 })
        : new Response(JSON.stringify({
          owner: { models: {
            'cached-model': {
              limit: { context: 777_777, output: 33_333 },
              tool_call: true
            }
          } }
        }), { status: 200 })
    ), capabilityCachePath);
    assert.equal(warm[0].contextWindow, 777_777);
    assert.equal(JSON.parse(await fs.readFile(capabilityCachePath, 'utf8')).version, 1);
    const offline = await enrichModelCatalog(
      cachedInput,
      async () => { throw new Error('offline'); },
      capabilityCachePath
    );
    assert.equal(offline[0].contextWindow, 777_777, 'offline refresh must reuse the last valid capability cache');
    assert.equal(offline[0].maxOutputTokens, 33_333);

    const never = new Promise<Response>(() => undefined);
    const cacheFirstRequest = fetchCompatibleServiceModelCatalog(
      'https://compatible.example/v1',
      'cache-first-token',
      async input => {
        const url = String(input);
        if (url === 'https://models.dev/api.json' || url.includes('litellm')) return never;
        const payload = url.endsWith('/v1/models')
          ? { data: [{ id: 'cached-model' }] }
          : url.endsWith('/anthropic/v1/models')
            ? { data: [] }
            : { models: [] };
        return new Response(JSON.stringify(payload), { status: 200 });
      },
      capabilityCachePath
    );
    let timeout: NodeJS.Timeout | undefined;
    const cacheFirstOutcome = await Promise.race([
      cacheFirstRequest.then(models => ({ models })),
      new Promise<{ timeout: true }>(resolve => {
        timeout = setTimeout(() => resolve({ timeout: true }), 500);
      })
    ]);
    if (timeout) clearTimeout(timeout);
    assert.ok('models' in cacheFirstOutcome, 'external capability refresh must not block 兼容服务 model discovery');
    if ('models' in cacheFirstOutcome) {
      assert.equal(cacheFirstOutcome.models[0].contextWindow, 777_777);
    }

    const directoryCachePath = path.join(capabilityCacheRoot, 'compatible-model-catalog-cache.json');
    await writeCompatibleServiceModelCatalogCache(
      directoryCachePath,
      'https://compatible.example/v1',
      'directory-token',
      warm
    );
    const firstDirectoryCache = await fs.readFile(directoryCachePath, 'utf8');
    assert.equal(
      JSON.parse(firstDirectoryCache).version,
      2,
      'the v2 directory cache preserves capability provenance and invalidates poisoned v1 snapshots'
    );
    const legacyDirectoryCachePath = path.join(capabilityCacheRoot, 'compatible-model-catalog-cache-v1.json');
    const legacyDirectoryCache = JSON.parse(firstDirectoryCache);
    legacyDirectoryCache.version = 1;
    legacyDirectoryCache.models[0].vision = false;
    legacyDirectoryCache.models[0].input_modalities = ['text'];
    await fs.writeFile(legacyDirectoryCachePath, JSON.stringify(legacyDirectoryCache));
    const migratedLegacyDirectory = await readCompatibleServiceModelCatalogCache(
      legacyDirectoryCachePath,
      'https://compatible.example/v1',
      'directory-token'
    );
    assert.equal(migratedLegacyDirectory.length, 1);
    assert.equal(migratedLegacyDirectory[0].contextWindow, 777_777);
    assert.equal(migratedLegacyDirectory[0].capabilitySources?.contextWindow, 'models.dev');
    assert.equal(
      JSON.parse(await fs.readFile(legacyDirectoryCachePath, 'utf8')).version,
      2,
      'v1 snapshots must retain model existence but rebuild untrusted capability fields into v2'
    );
    await writeCompatibleServiceModelCatalogCache(
      directoryCachePath,
      'https://compatible.example/v1',
      'directory-token',
      warm
    );
    assert.equal(
      await fs.readFile(directoryCachePath, 'utf8'),
      firstDirectoryCache,
      'an unchanged 兼容服务 directory cache must not be rewritten'
    );
    const restoredDirectory = await readCompatibleServiceModelCatalogCache(
      directoryCachePath,
      'https://compatible.example',
      'directory-token'
    );
    assert.equal(restoredDirectory.length, 1);
    assert.equal(restoredDirectory[0].id, 'cached-model');
    assert.equal(restoredDirectory[0].contextWindow, 777_777);
    assert.equal(restoredDirectory[0].maxOutputTokens, 33_333);
    assert.equal(restoredDirectory[0].toolCalling, true);
    assert.deepEqual(
      await readCompatibleServiceModelCatalogCache(directoryCachePath, 'https://compatible.example', 'different-token'),
      [],
      'a model directory cache must be scoped to the exact connection'
    );
    assert.doesNotMatch(
      await fs.readFile(directoryCachePath, 'utf8'),
      /directory-token/,
      'the 兼容服务 bearer token must not be stored in the directory cache'
    );

    const seededGpt56 = (await enrichModelCatalog(
      normalizeModelCatalog([{
        id: 'gpt-5.6-sol',
        clients: ['codex'],
        protocols: ['openai-responses']
      }]),
      async () => new Response('{}', { status: 200 })
    ))[0];
    assert.equal(seededGpt56.vision, true, 'the release seed must keep GPT-5.6 visual on a clean offline install');
    assert.deepEqual(seededGpt56.inputModalities, ['text', 'image', 'pdf']);
    assert.equal(seededGpt56.contextWindow, 1_050_000);
    assert.equal(seededGpt56.maxOutputTokens, 128_000);
    assert.equal(seededGpt56.capabilitySources?.vision, 'builtin');
    const offlineVisualSeeds = await enrichModelCatalog(
      normalizeModelCatalog([
        { id: 'claude-opus-4-8', clients: ['codex'], protocols: ['anthropic-messages'] },
        { id: 'doubao-seed-2-0-pro', clients: ['codex'], protocols: ['chat-completions'] },
        { id: 'doubao-seed-character', clients: ['codex'], protocols: ['chat-completions'] },
        { id: 'glm-5v-turbo', clients: ['codex'], protocols: ['chat-completions'] },
        { id: 'gpt-5.4', clients: ['codex'], protocols: ['openai-responses'] },
        { id: 'grok-4.6', clients: ['codex'], protocols: ['chat-completions'] },
        { id: 'MiniMax-M3', clients: ['codex'], protocols: ['chat-completions'] },
        { id: 'qwen3.8-max', clients: ['codex'], protocols: ['chat-completions'] }
      ]),
      async () => new Response('{}', { status: 200 })
    );
    for (const model of offlineVisualSeeds) {
      assert.equal(model.vision, true, `${model.id} must remain visual on a clean offline install`);
      assert.ok(model.inputModalities?.includes('image'), `${model.id} must publish image input`);
      assert.equal(model.capabilitySources?.vision, 'builtin');
    }
    assert.equal(
      offlineVisualSeeds.find(model => model.id === 'gpt-5.4')?.reasoning,
      true,
      'the visual seed must compose with the existing GPT reasoning seed'
    );
    for (const model of offlineVisualSeeds.filter(model => model.vision === true)) {
      assert.ok(
        model.inputModalities?.includes('image'),
        `${model.id} vision=true must imply image input`
      );
    }

    const fallbackDirectoryPath = path.join(capabilityCacheRoot, 'compatible-fallback-catalog-cache.json');
    const fallbackModel = (await enrichModelCatalog(
      normalizeModelCatalog([{
        id: 'custom-vision-later',
        clients: ['codex'],
        protocols: ['openai-responses']
      }]),
      async () => new Response('{}', { status: 200 })
    ))[0];
    assert.equal(fallbackModel.vision, false);
    assert.deepEqual(fallbackModel.inputModalities, ['text']);
    assert.equal(fallbackModel.capabilitySources?.vision, 'fallback');
    assert.equal(fallbackModel.capabilitySources?.inputModalities, 'fallback');
    await writeCompatibleServiceModelCatalogCache(
      fallbackDirectoryPath,
      'https://compatible.example/v1',
      'fallback-token',
      [fallbackModel]
    );
    const serializedFallback = JSON.parse(await fs.readFile(fallbackDirectoryPath, 'utf8'));
    const serializedFallbackModel = serializedFallback.models[0] as Record<string, unknown>;
    assert.equal('vision' in serializedFallbackModel, false, 'fallback false must not be persisted as a 兼容服务 declaration');
    assert.equal('input_modalities' in serializedFallbackModel, false, 'fallback text-only modalities must remain unknown on disk');
    assert.equal(
      (serializedFallbackModel._xwx_capability_sources as Record<string, string>).vision,
      'fallback'
    );
    const restoredFallback = await readCompatibleServiceModelCatalogCache(
      fallbackDirectoryPath,
      'https://compatible.example',
      'fallback-token'
    );
    assert.equal(restoredFallback[0].vision, undefined);
    assert.equal(restoredFallback[0].inputModalities, undefined);
    assert.equal(restoredFallback[0].capabilitySources?.vision, 'fallback');
    const correctedFallback = (await enrichModelCatalog(
      restoredFallback,
      async input => (
        String(input).includes('litellm')
          ? new Response('{}', { status: 200 })
          : new Response(JSON.stringify({
            openai: { models: {
              'custom-vision-later': {
                modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
              }
            } }
          }), { status: 200 })
      )
    ))[0];
    assert.equal(correctedFallback.vision, true, 'a later successful capability refresh must replace fallback false');
    assert.deepEqual(correctedFallback.inputModalities, ['text', 'image', 'pdf']);
    assert.equal(correctedFallback.capabilitySources?.vision, 'models.dev');
    assert.equal(correctedFallback.capabilitySources?.inputModalities, 'models.dev');

    const visionOnlyCachePath = path.join(capabilityCacheRoot, 'vision-only-capabilities-cache.json');
    await fs.writeFile(visionOnlyCachePath, JSON.stringify({
      version: 1,
      savedAt: '2026-08-18T00:00:00.000Z',
      modelsDev: [{
        modelId: 'vision-only-model',
        sourceId: 'owner/vision-only-model',
        providerId: 'owner',
        capability: { vision: true }
      }],
      litellm: []
    }));
    const visionOnly = (await enrichModelCatalog(
      normalizeModelCatalog([{
        id: 'vision-only-model',
        clients: ['codex'],
        protocols: ['chat-completions']
      }]),
      async () => { throw new Error('offline'); },
      visionOnlyCachePath
    ))[0];
    assert.equal(visionOnly.vision, true);
    assert.deepEqual(
      visionOnly.inputModalities,
      ['text', 'image'],
      'vision=true without explicit modalities must normalize to text+image'
    );
    assert.equal(
      visionOnly.capabilitySources?.inputModalities,
      'models.dev',
      'the inferred image modality must retain the source that established vision'
    );
  } finally {
    await fs.rm(capabilityCacheRoot, { recursive: true, force: true });
  }
  completed.push('model catalog merges OpenAI, Anthropic and Gemini endpoints');
}

async function testReleaseNotes(): Promise<void> {
  assert.equal(normalizeReleaseNotes('  修复更新提示  '), '修复更新提示');
  assert.equal(normalizeReleaseNotes([{ note: '新增右下角通知' }, { note: '  支持立即下载  ' }]), '新增右下角通知\n支持立即下载');
  assert.equal(releaseNotesFromManifest({ version: '1.0.1', changelog: '更新内容' }, '1.0.1'), '更新内容');
  assert.equal(releaseNotesFromManifest({ version: '1.0.0', changelog: '旧内容' }, '1.0.1'), undefined);
  completed.push('release notes normalization and version matching');
}

async function testModelsDevPricing(): Promise<void> {
  const payload = {
    openai: { models: {
      'gpt-5.4': { cost: { input: 2.5, output: 15, cache_read: 0.25 } },
      'gpt-5.4-pro': { cost: { input: 30, output: 180 } }
    } },
    anthropic: { models: {
      'claude-sonnet-5': { cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 } }
    } },
    untrusted: { models: {
      'gpt-5.4-pro': { cost: { input: 0, output: 0 } }
    } }
  };
  const rules = parseModelsDevPricingCatalog(payload);
  assert.equal(rules.length, 3);
  assert.equal(rules.find(rule => rule.modelId === 'gpt-5.4-pro')?.cacheRead, undefined,
    'a missing cache-read price must stay unknown instead of silently becoming the input price');
  assert.equal(rules.find(rule => rule.modelId === 'gpt-5.4-pro')?.cacheWritePolicy, 'input',
    'OpenAI models without an itemized write price use the documented normal-input rate');
  setCatalogPriceRules(rules);
  assert.equal(findModelPrice('openai/gpt-5.4-pro')?.input, 30, 'exact pro price must beat family fallback');
  assert.equal(findModelPrice('gpt-5.4')?.input, 2.5);
  assert.equal(findModelPrice('gpt-5.4-preview'), undefined, 'unknown aliases must not use approximate family prices while the exact catalog is active');
  assert.equal(findModelPrice('qwen3.8-max')?.source, 'official');
  assert.equal(findModelPrice('qwen3.8-max')?.input, 2);
  assert.equal(findModelPrice('qwen3.8-max')?.output, 6);
  assert.equal(findModelPrice('gpt-5.2-codex')?.input, 1.75);
  assert.equal(findModelPrice('claude-sonnet-4.5')?.protocol, 'anthropic');
  assert.equal(findModelPrice('claude-sonnet-4.5')?.output, 15);
  const qwenRules = parseModelsDevPricingCatalog({
    alibaba: { models: {
      'qwen3.8-max': { cost: { input: 2.1, output: 6.1, cache_read: 0.21, cache_write: 2.625 } }
    } }
  });
  assert.equal(qwenRules[0]?.cacheWrite, 2.625, 'an upstream cache-write price must survive catalog parsing');
  setCatalogPriceRules([...rules, ...qwenRules]);
  assert.equal(
    findModelPrice('qwen3.8-max')?.source,
    'models.dev',
    'models.dev must automatically supersede the temporary official override'
  );
  const pricingHtml = renderTapViewerHtml({
    mode: 'static',
    state: { active: false, rootPath: 'qa', pricingModelIds: ['qwen3.8-max'], sessions: [], traces: [] }
  });
  const pricingScript = [...pricingHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .at(-1) ?? '';
  const pricingBody = { innerHTML: '' };
  const pricingVm: Record<string, unknown> = {
    PRICE_RULES: qwenRules,
    document: { activeElement: null },
    pricingReturnFocus: null,
    state: { pricingModelIds: ['qwen3.8-max'], sessions: [], traces: [] },
    L: (zh: string) => zh,
    esc: (value: unknown) => String(value),
    priceSourceSummary: () => 'models.dev / alibaba / qwen3.8-max',
    currentPricingModelIds: () => ['qwen3.8-max'],
    findModelPrice: () => qwenRules[0],
    cacheWriteDisplay: () => '$2.625',
    pricingStatus: () => '已核验',
    // The row now carries a provenance tooltip and marks a banded rate as being
    // only its first band, so both helpers have to exist in this sandbox.
    priceRuleSummary: () => 'rule summary',
    rateCell: (price: Record<string, number> | undefined, field: string) => (
      price && price[field] != null ? `$${price[field]}` : '—'
    ),
    el: (id: string) => id === 'pricingBody'
      ? pricingBody
      : { classList: { add() {} }, focus() {} }
  };
  vm.runInNewContext(
    `${extractViewerFunction(pricingScript, 'openPricing')}\nopenPricing();`,
    pricingVm
  );
  assert.match(pricingBody.innerHTML, /<td>qwen3\.8-max<\/td>/,
    'the pricing table must display the exact model ID');
  assert.doesNotMatch(pricingBody.innerHTML, /claude \+ fable/,
    'substring fallback tokens must never be presented as model names');
  assert.match(pricingBody.innerHTML, /<td>\$2\.625<\/td>/,
    'the pricing table must display a fetched cache-write price for OpenAI-compatible models');
  assert.match(pricingBody.innerHTML, /<tr title="rule summary">/,
    'every pricing row must expose the matched rule, its source and its bands on hover');
  const pricingNote = pricingHtml.slice(pricingHtml.indexOf('pricing-note'));
  assert.match(pricingNote, /取价优先级/,
    'the pricing table must state how a rate was sourced and corroborated');
  assert.match(pricingNote, /标「起」的费率只是第一档/,
    'the pricing table must warn that a banded rate shows only its first band');
  setCatalogPriceRules(rules);

  const base = path.join(root, 'models-dev-pricing');
  const bundled = path.join(base, 'bundled.json');
  await fs.mkdir(base, { recursive: true });
  await fs.writeFile(bundled, JSON.stringify({
    version: 2,
    sourceUrl: 'https://models.dev/api.json',
    fetchedAt: '2026-07-22T00:00:00.000Z',
    rules
  }));
  assert.equal(await loadModelsDevPricingCache({ userDataDir: base, bundledCachePath: bundled }), 3);
  const refresh = await refreshModelsDevPricingCache(
    { userDataDir: base, bundledCachePath: bundled },
    async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { etag: 'pricing-test-v2', 'content-type': 'application/json' }
    })
  );
  assert.equal(refresh.status, 'updated');
  assert.equal(refresh.ruleCount, 3);
  assert.equal(JSON.parse(await fs.readFile(modelsDevPricingCachePath(base), 'utf8')).etag, 'pricing-test-v2');
  setCatalogPriceRules([]);
  completed.push('models.dev exact pricing cache load and refresh');
}

async function testClientTakeover(): Promise<void> {
  const base = path.join(root, 'takeover');
  const home = path.join(base, 'home');
  const paths = resolveClientPaths({}, home);
  const claudeOriginal = `${JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: 'http://compatible.local/v1',
    ANTHROPIC_MODEL: 'user-model-pin',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'user-sonnet-map',
    KEEP: 'yes'
  } }, null, 2)}\n`;
  const codexOriginal = 'model_provider = "compatible"\n\n[model_providers.compatible]\nbase_url = "http://compatible.local/v1"\n';
  await fs.mkdir(path.dirname(paths.claudeSettingsPath), { recursive: true });
  await fs.mkdir(path.dirname(paths.codexConfigPath), { recursive: true });
  await fs.writeFile(paths.claudeSettingsPath, claudeOriginal);
  await fs.writeFile(paths.codexConfigPath, codexOriginal);
  const backup = new ClientBackupStore(path.join(base, 'user-data'));
  const writer = new ClientConfigWriter({ backup });
  const orchestrator = new ClientConfigOrchestrator(backup, writer, paths);
  const results = await orchestrator.apply('http://127.0.0.1:44999', new Date('2026-07-16T00:00:00Z'));
  assert.deepEqual(results.map(item => item.status), ['taken', 'taken']);
  assert.deepEqual(
    orchestrator.clientsPointingAt('http://127.0.0.1:44999'),
    ['claude-cli', 'codex-cli'],
    'forced-exit safety must detect every client that still depends on the local Gateway'
  );
  assert.match(await fs.readFile(paths.claudeSettingsPath, 'utf8'), /127\.0\.0\.1:44999/);
  assert.match(await fs.readFile(paths.codexConfigPath, 'utf8'), /127\.0\.0\.1:44999\/v1/);
  assert.equal((await backup.listAll()).length, 2);

  const claudeDuringTrace = JSON.parse(await fs.readFile(paths.claudeSettingsPath, 'utf8'));
  assert.equal(claudeDuringTrace.env.ANTHROPIC_MODEL, 'user-model-pin', 'Trace must not manage model selection');
  assert.equal(claudeDuringTrace.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'user-sonnet-map');
  claudeDuringTrace.env.KEEP = 'changed-during-trace';
  claudeDuringTrace.permissions = { allow: ['Read', 'WebFetch'] };
  await fs.writeFile(paths.claudeSettingsPath, `${JSON.stringify(claudeDuringTrace, null, 2)}\n`);
  await fs.appendFile(paths.codexConfigPath, '\nsandbox_mode = "read-only"\n');
  const restored = await orchestrator.restoreAll();
  assert.equal(restored.flatMap(item => item.conflicts).length, 0);
  const claudeAfterRestore = JSON.parse(await fs.readFile(paths.claudeSettingsPath, 'utf8'));
  assert.equal(claudeAfterRestore.env.ANTHROPIC_BASE_URL, 'http://compatible.local/v1');
  assert.equal(claudeAfterRestore.env.ANTHROPIC_MODEL, 'user-model-pin');
  assert.equal(claudeAfterRestore.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'user-sonnet-map');
  assert.equal(claudeAfterRestore.env.KEEP, 'changed-during-trace');
  assert.deepEqual(claudeAfterRestore.permissions, { allow: ['Read', 'WebFetch'] });
  const codexAfterRestore = await fs.readFile(paths.codexConfigPath, 'utf8');
  assert.match(codexAfterRestore, /base_url = "http:\/\/compatible\.local\/v1"/);
  assert.match(codexAfterRestore, /sandbox_mode = "read-only"/);
  assert.deepEqual(orchestrator.clientsPointingAt('http://127.0.0.1:44999'), []);
  assert.equal((await backup.listAll()).length, 0);

  await orchestrator.apply('http://127.0.0.1:44999');
  const externallyChanged = JSON.parse(await fs.readFile(paths.claudeSettingsPath, 'utf8'));
  externallyChanged.env.ANTHROPIC_BASE_URL = 'https://external.example/v1';
  await fs.writeFile(paths.claudeSettingsPath, `${JSON.stringify(externallyChanged, null, 2)}\n`);
  const conflicted = await orchestrator.restoreAll();
  assert.ok(conflicted.find(item => item.client === 'claude')?.conflicts.length);
  assert.equal(JSON.parse(await fs.readFile(paths.claudeSettingsPath, 'utf8')).env.ANTHROPIC_BASE_URL, 'https://external.example/v1');
  assert.deepEqual(
    orchestrator.clientsPointingAt('http://127.0.0.1:44999'),
    [],
    'an external connection preserved during restore is safe even when the restore reports a conflict'
  );

  await orchestrator.apply('http://127.0.0.1:44999');
  await orchestrator.recoverOnStartup(async () => false);
  assert.equal(JSON.parse(await fs.readFile(paths.claudeSettingsPath, 'utf8')).env.ANTHROPIC_BASE_URL, 'https://external.example/v1');
  assert.doesNotMatch(await fs.readFile(paths.codexConfigPath, 'utf8'), /127\.0\.0\.1:44999/);
  assert.equal((await backup.listAll()).length, 0);
  completed.push('Claude and ChatGPT field-safe takeover, conflict preservation, and crash recovery');
}

async function testClientPreflight(): Promise<void> {
  const base = path.join(root, 'client-preflight');
  const home = path.join(base, 'home');
  const claudeHome = path.join(base, 'custom-claude');
  const codexHome = path.join(base, 'custom-codex');
  const env = {
    ...process.env,
    XWX_DECK_CLIENT_HOME: home,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: codexHome,
  };
  const paths = resolveClientPaths(env, home);
  assert.equal(paths.claudeSettingsPath, path.join(claudeHome, 'settings.json'));
  assert.equal(paths.codexConfigPath, path.join(codexHome, 'config.toml'));
  await fs.mkdir(path.dirname(paths.claudeSettingsPath), { recursive: true });
  await fs.mkdir(path.dirname(paths.codexConfigPath), { recursive: true });
  const claudeConfig = `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://claude.example/v1' } }, null, 2)}\n`;
  const codexConfig = 'model_provider = "compatible"\n[model_providers.compatible]\nbase_url = "https://codex.example/v1"\n';
  await fs.writeFile(paths.claudeSettingsPath, claudeConfig);
  await fs.writeFile(paths.codexConfigPath, codexConfig);

  const backup = new ClientBackupStore(path.join(base, 'backup'));
  const orchestrator = new ClientConfigOrchestrator(backup, new ClientConfigWriter({ backup }), paths, env);
  const ready = orchestrator.preflight();
  assert.deepEqual(ready.map(item => item.status), ['ready', 'ready']);
  assert.equal(ready[0].source, 'settings');
  assert.equal(ready[0].upstreamBaseUrl, 'https://claude.example/v1');
  assert.equal(ready[1].source, 'provider');
  assert.equal(await fs.readFile(paths.claudeSettingsPath, 'utf8'), claudeConfig);
  assert.equal(await fs.readFile(paths.codexConfigPath, 'utf8'), codexConfig);

  const overrideEnv = { ...env, ANTHROPIC_BASE_URL: 'https://shell-override.example/v1' };
  const override = new ClientConfigOrchestrator(backup, new ClientConfigWriter({ backup }), paths, overrideEnv);
  const [claude] = override.preflight({ codex: false });
  assert.equal(claude.status, 'skipped');
  assert.equal(claude.source, 'environment');
  assert.equal(claude.skipReason, 'environment-override');
  assert.ok(claude.conflicts.some(item => item.includes('ANTHROPIC_BASE_URL')));
  const applied = await override.applyOne('claude-cli', 'http://127.0.0.1:44233');
  assert.equal(applied.status, 'skipped');
  assert.equal(applied.skipReason, 'environment-override');
  assert.equal(await fs.readFile(paths.claudeSettingsPath, 'utf8'), claudeConfig);
  completed.push('read-only client preflight and environment override guard');
}

async function testCodexOfficialAndCustomTakeover(): Promise<void> {
  const base = path.join(root, 'codex-routing');
  const paths = resolveClientPaths({}, path.join(base, 'home'));
  await fs.mkdir(path.dirname(paths.codexConfigPath), { recursive: true });
  const officialAuth = Buffer.from('{\r\n  "auth_mode": "chatgpt",\r\n  "tokens": { "access_token": "oauth-must-not-change" }\r\n}\r\n');
  await fs.writeFile(paths.codexAuthPath, officialAuth);
  const officialOriginal = [
    'model_provider = "openai"',
    '',
    '[model_providers.compatible]',
    'base_url = "https://compatible.example/v1"',
    'wire_api = "responses"',
    ''
  ].join('\n');
  await fs.writeFile(paths.codexConfigPath, officialOriginal);
  const officialDetection = detectCodexUpstream(paths);
  assert.ok(!('reason' in officialDetection));
  assert.equal(officialDetection.provider, 'openai');
  assert.equal(officialDetection.routeKind, 'chatgpt-oauth');
  assert.equal(officialDetection.fieldLocation, 'chatgpt-base-url');
  assert.equal(officialDetection.baseUrl, 'https://chatgpt.com/backend-api');

  const backup = new ClientBackupStore(path.join(base, 'user-data'));
  const orchestrator = new ClientConfigOrchestrator(backup, new ClientConfigWriter({ backup }), paths);
  const officialTakeover = (await orchestrator.apply('http://127.0.0.1:44998'))
    .find(result => result.client === 'codex-cli');
  assert.equal(officialTakeover.codexRouteKind, 'chatgpt-oauth');
  const officialDuringTrace = await fs.readFile(paths.codexConfigPath, 'utf8');
  assert.match(officialDuringTrace, /^model_provider = "xwx_deck"$/m);
  assert.match(officialDuringTrace, /\[model_providers\.xwx_deck\][\s\S]*base_url = "http:\/\/127\.0\.0\.1:44998\/backend-api\/codex"/);
  assert.match(officialDuringTrace, /\[model_providers\.xwx_deck\][\s\S]*requires_openai_auth = true/);
  assert.match(officialDuringTrace, /\[model_providers\.xwx_deck\][\s\S]*supports_websockets = true/);
  assert.match(officialDuringTrace, /\[model_providers\.compatible\][\s\S]*base_url = "https:\/\/compatible\.example\/v1"/);
  assert.equal((await new CodexConfigManager(path.join(root, 'codex-detection-user-data')).readFromContent(officialOriginal, paths)).mode, 'official');
  const parsedOfficialDuringTrace = parseToml(officialDuringTrace) as {
    model_provider?: unknown;
    model_providers?: Record<string, Record<string, unknown>>;
  };
  assert.equal(parsedOfficialDuringTrace.model_provider, 'xwx_deck');
  assert.equal(parsedOfficialDuringTrace.model_providers?.xwx_deck?.requires_openai_auth, true);
  assert.equal(parsedOfficialDuringTrace.model_providers?.xwx_deck?.supports_websockets, true);
  assert.deepEqual(await fs.readFile(paths.codexAuthPath), officialAuth);
  await orchestrator.restoreAll();
  assert.equal(await fs.readFile(paths.codexConfigPath, 'utf8'), officialOriginal);
  assert.deepEqual(await fs.readFile(paths.codexAuthPath), officialAuth);

  const customOriginal = [
    'model_provider = "compatible"',
    '',
    '[model_providers.compatible]',
    'base_url = "https://compatible.example/v1"',
    'wire_api = "responses"',
    ''
  ].join('\n');
  await fs.writeFile(paths.codexConfigPath, customOriginal);
  const customDetection = detectCodexUpstream(paths);
  assert.ok(!('reason' in customDetection));
  assert.equal(customDetection.routeKind, 'custom-provider');
  assert.equal(customDetection.fieldLocation, 'provider-section');
  assert.equal(customDetection.baseUrl, 'https://compatible.example/v1');
  const customTakeover = (await orchestrator.apply('http://127.0.0.1:44998'))
    .find(result => result.client === 'codex-cli');
  assert.equal(customTakeover.codexRouteKind, 'custom-provider');
  const customDuringTrace = await fs.readFile(paths.codexConfigPath, 'utf8');
  assert.match(customDuringTrace, /\[model_providers\.compatible\][\s\S]*base_url = "http:\/\/127\.0\.0\.1:44998\/v1"/);
  assert.doesNotMatch(customDuringTrace, /^chatgpt_base_url\s*=/m);
  assert.equal((await new CodexConfigManager(path.join(root, 'codex-detection-user-data')).readFromContent(customOriginal, paths)).mode, 'compatible');
  await orchestrator.restoreAll();
  assert.equal(await fs.readFile(paths.codexConfigPath, 'utf8'), customOriginal);
  completed.push('ChatGPT OAuth and custom Codex provider takeover stay isolated');
}

async function testCodexProviderSwitch(): Promise<void> {
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(root, 'codex-provider', '.codex');
  try {
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    const invalidHome = path.join(root, 'codex-provider-invalid', '.codex');
    process.env.CODEX_HOME = invalidHome;
    await fs.mkdir(invalidHome, { recursive: true });
    const invalidConfig = 'model_provider = "openai"\nbroken = [\n';
    await fs.writeFile(path.join(invalidHome, 'config.toml'), invalidConfig);
    await fs.writeFile(path.join(invalidHome, 'auth.json'), '{"auth_mode":"chatgpt"}\n');
    await assert.rejects(
      new CodexConfigManager(path.join(root, 'codex-provider-invalid-user-data')).update({
        mode: 'official',
        officialModel: 'gpt-5.5'
      }),
      /config\.toml 格式错误，未修改配置/
    );
    assert.equal(await fs.readFile(path.join(invalidHome, 'config.toml'), 'utf8'), invalidConfig);

    process.env.CODEX_HOME = path.join(root, 'codex-provider', '.codex');
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    const apiKeyAuth = '{"auth_mode":"api-key","OPENAI_API_KEY":"qa-openai-key"}\n';
    await fs.writeFile(path.join(process.env.CODEX_HOME, 'auth.json'), apiKeyAuth);
    await fs.writeFile(path.join(process.env.CODEX_HOME, 'config.toml'), [
      'model_provider = "xwx_deck"',
      'model = "gpt-5.5"',
      '',
      '[model_providers.xwx_deck]',
      'name = "XwX Deck"',
      'base_url = "https://api.openai.com/v1"',
      'wire_api = "responses"',
      'requires_openai_auth = true',
      'supports_websockets = false',
      'request_max_retries = 7',
      ''
    ].join('\n'));
    const stableProvider = await new CodexConfigManager(
      path.join(root, 'codex-provider-rename-user-data')
    ).ensureStableProvider();
    assert.equal(stableProvider.activeProvider, 'xwx_deck');
    const stableProviderToml = await fs.readFile(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
    assert.match(stableProviderToml, /\[model_providers\.xwx_deck\]/);
    assert.match(
      stableProviderToml,
      /^request_max_retries = 7$/m,
      'refreshing the stable provider must preserve user-added provider fields'
    );

    await fs.writeFile(path.join(process.env.CODEX_HOME, 'config.toml'), [
      '[windows]',
      'model_provider = "openai"',
      'service_tier = "default"',
      '',
      '[features]',
      'js_repl = true',
      'image_gen = true',
      'image_generation = true',
      'imagegenext = true',
      'web_search = true',
      ''
    ].join('\n'));
    const manager = new CodexConfigManager(path.join(root, 'codex-provider-user-data'));
    const compatible = await manager.update({
      mode: 'compatible',
      compatibleModel: 'qa-compatible-model',
      compatibleBaseUrl: 'http://compatible.local',
      compatibleBearerToken: 'qa-bearer',
      modelContextWindow: CODEX_EXTENDED_CONTEXT_WINDOW
    });
    assert.equal(compatible.mode, 'compatible');
    assert.equal(compatible.compatible.baseUrl, 'http://compatible.local/v1');
    assert.equal(compatible.compatible.bearerToken, 'qa-bearer');
    assert.equal(compatible.activeProvider, 'xwx_deck');
    assert.equal(compatible.modelContextWindow, CODEX_EXTENDED_CONTEXT_WINDOW);
    const compatibleToml = await fs.readFile(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
    assert.match(compatibleToml, /^model_provider = "xwx_deck"$/m);
    assert.match(compatibleToml, /^service_tier = "default"$/m);
    assert.match(compatibleToml, /^model_context_window = 1000000$/m);
    assert.match(compatibleToml, /^model_auto_compact_token_limit = 900000$/m);
    assert.ok(compatibleToml.indexOf('model_provider = "xwx_deck"') < compatibleToml.indexOf('[windows]'));
    assert.match(compatibleToml, /\[windows\]\nmodel_provider = "openai"\nservice_tier = "default"/);
    assert.match(compatibleToml, /\[model_providers\.xwx_deck\][\s\S]*name = "XwX Deck"/);
    assert.match(compatibleToml, /\[model_providers\.xwx_deck\][\s\S]*wire_api = "responses"/);
    assert.match(compatibleToml, /\[model_providers\.xwx_deck\][\s\S]*supports_websockets = false/);
    assert.match(compatibleToml, /\[features\][\s\S]*js_repl = false/);
    assert.match(compatibleToml, /^image_gen = true$/m,
      'an unknown provider must preserve the user image namespace by default');
    assert.doesNotMatch(compatibleToml, /^\s*image_generation\s*=/m);
    // imagegenext is deprecated: a pre-existing key must be cleaned up, never re-written.
    assert.doesNotMatch(compatibleToml, /^\s*imagegenext\s*=/m);
    assert.match(compatibleToml, /\[features\][\s\S]*web_search = true/);
    const detected = detectCodexUpstream(resolveClientPaths());
    assert.ok(!('reason' in detected));
    assert.equal(detected.provider, 'xwx_deck');
    assert.equal(detected.baseUrl, 'http://compatible.local/v1');
    await manager.update({
      mode: 'compatible',
      compatibleModel: 'qa-compatible-model',
      compatibleBaseUrl: 'http://compatible.local',
      compatibleBearerToken: 'qa-bearer',
      disableImageGeneration: true
    });
    const incompatibleProviderToml = await fs.readFile(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
    assert.match(incompatibleProviderToml, /^image_gen = false$/m,
      'a provider explicitly known to reject image_gen must disable it temporarily');
    // The managed-field record is persisted, so restoring after an application
    // restart still returns the user's original setting.
    const official = await new CodexConfigManager(path.join(root, 'codex-provider-user-data')).update({
      mode: 'official',
      officialModel: 'qa-official-model',
      modelContextWindow: CODEX_STANDARD_LONG_CONTEXT_WINDOW
    });
    assert.equal(official.mode, 'official');
    assert.equal(official.officialModel, 'qa-official-model');
    assert.equal(official.activeProvider, 'xwx_deck');
    assert.equal(official.modelContextWindow, CODEX_STANDARD_LONG_CONTEXT_WINDOW);
    const officialToml = await fs.readFile(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
    assert.ok(officialToml.indexOf('model_provider = "xwx_deck"') < officialToml.indexOf('[windows]'));
    assert.match(officialToml, /\[model_providers\.xwx_deck\][\s\S]*base_url = "https:\/\/api\.openai\.com\/v1"/);
    assert.match(officialToml, /\[model_providers\.xwx_deck\][\s\S]*supports_websockets = true/);
    assert.match(officialToml, /^model_context_window = 272000$/m);
    assert.match(officialToml, /^model_auto_compact_token_limit = 244800$/m);
    assert.match(officialToml, /^image_gen = true$/m, 'returning to official restores the prior image setting');
    assert.doesNotMatch(officialToml, /^\s*image_generation\s*=/m);
    assert.doesNotMatch(officialToml, /^\s*imagegenext\s*=/m);
    assert.match(officialToml, /\[features\][\s\S]*js_repl = false/);
    assert.match(officialToml, /\[features\][\s\S]*web_search = true/);
    assert.equal(await fs.readFile(path.join(process.env.CODEX_HOME, 'auth.json'), 'utf8'), apiKeyAuth);

    assert.equal(official.compatible.model, 'qa-official-model', 'inactive 兼容服务 snapshot must preserve the active model');
    const toggled兼容服务 = await manager.update({
      mode: 'compatible',
      compatibleModel: official.compatible.model,
      compatibleBaseUrl: 'http://compatible.local/v1',
      compatibleBearerToken: 'qa-bearer',
      modelContextWindow: null
    });
    assert.equal(toggled兼容服务.compatible.model, 'qa-official-model', 'enabling 兼容服务 must preserve the selected model');
    assert.equal(toggled兼容服务.officialModel, 'qa-official-model');
    assert.equal(toggled兼容服务.modelContextWindow, undefined);
    const clearedContextToml = await fs.readFile(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
    assert.doesNotMatch(clearedContextToml, /^model_context_window\s*=/m);
    assert.doesNotMatch(clearedContextToml, /^model_auto_compact_token_limit\s*=/m);
    const toggledOfficial = await manager.update({
      mode: 'official',
      officialModel: toggled兼容服务.officialModel
    });
    assert.equal(toggledOfficial.officialModel, 'qa-official-model', 'disabling 兼容服务 must preserve the selected model');

    await fs.writeFile(path.join(process.env.CODEX_HOME, 'config.toml'), [
      'model_provider = "openai"',
      '',
      '[features]',
      'image_gen = true',
      ''
    ].join('\n'));
    await manager.update({
      mode: 'compatible',
      compatibleModel: 'qa-compatible-model',
      compatibleBaseUrl: 'http://compatible.local',
      compatibleBearerToken: 'qa-bearer',
      disableImageGeneration: true
    });
    await manager.update({
      mode: 'compatible',
      compatibleModel: 'qa-compatible-model',
      compatibleBaseUrl: 'http://image-capable.local',
      compatibleBearerToken: 'qa-bearer',
      disableImageGeneration: false
    });
    const imageCapableToml = await fs.readFile(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
    assert.match(imageCapableToml, /^image_gen = true$/m,
      'switching to an image-capable provider must restore the previous image setting without requiring official mode');

    // An external feature edit made while 兼容服务 is active must win over the
    // saved pre-兼容服务 value when switching back.
    await fs.writeFile(path.join(process.env.CODEX_HOME, 'config.toml'), [
      'model_provider = "openai"',
      '',
      '[features]',
      'image_gen = false',
      ''
    ].join('\n'));
    await manager.update({
      mode: 'compatible',
      compatibleModel: 'qa-compatible-model',
      compatibleBaseUrl: 'http://compatible.local',
      compatibleBearerToken: 'qa-bearer',
      disableImageGeneration: true
    });
    const externallyEdited = (await fs.readFile(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8'))
      .replace(/^image_gen = false$/m, 'image_gen = true');
    await fs.writeFile(path.join(process.env.CODEX_HOME, 'config.toml'), externallyEdited);
    await manager.update({ mode: 'official', officialModel: 'qa-official-model' });
    const conflictSafeToml = await fs.readFile(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
    assert.match(conflictSafeToml, /^image_gen = true$/m, 'an external image_gen edit must not be overwritten');

    // If the user had no explicit setting, switching back removes only XwX's
    // temporary field rather than leaving an unexpected feature override.
    await fs.writeFile(path.join(process.env.CODEX_HOME, 'config.toml'), [
      'model_provider = "openai"',
      '',
      '[features]',
      'web_search = true',
      ''
    ].join('\n'));
    await manager.update({
      mode: 'compatible',
      compatibleModel: 'qa-compatible-model',
      compatibleBaseUrl: 'http://compatible.local',
      compatibleBearerToken: 'qa-bearer',
      disableImageGeneration: true
    });
    await manager.update({ mode: 'official', officialModel: 'qa-official-model' });
    const absentRestoredToml = await fs.readFile(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
    assert.doesNotMatch(absentRestoredToml, /^image_gen\s*=/m, 'the temporary image_gen field must be removed when it was originally absent');
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
  completed.push('ChatGPT official/兼容服务 provider switch');
}

async function testCodexModelCatalogGateway(): Promise<void> {
  assert.deepEqual(codexContextVariants({
    id: 'gpt-5.6-sol',
    contextWindow: 1_050_000,
    capabilitySources: { contextWindow: 'builtin' }
  }), [
    {
      modelId: 'gpt-5.6-sol',
      label: 'gpt-5.6-sol[272K]',
      contextWindow: CODEX_STANDARD_LONG_CONTEXT_WINDOW
    },
    {
      modelId: 'gpt-5.6-sol',
      label: 'gpt-5.6-sol[1M]',
      contextWindow: CODEX_EXTENDED_CONTEXT_WINDOW
    }
  ], 'verified GPT 1M capability must become two display-only model choices');
  assert.deepEqual(codexContextVariants({
    id: 'gpt-5.5',
    contextWindow: 262_144,
    capabilitySources: { contextWindow: 'models.dev' }
  }), [{ modelId: 'gpt-5.5', label: 'gpt-5.5[256K]', contextWindow: null }]);
  assert.deepEqual(codexContextVariants({
    id: 'gpt-custom',
    contextWindow: 262_144,
    capabilitySources: { contextWindow: 'fallback' }
  }), [{ modelId: 'gpt-custom', label: 'gpt-custom', contextWindow: null }],
  'fallback context data must not be displayed as a verified model variant');

  const previousHome = process.env.CODEX_HOME;
  const codexHome = path.join(root, 'codex-model-gateway', '.codex');
  process.env.CODEX_HOME = codexHome;
  try {
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(path.join(codexHome, 'models_cache.json'), JSON.stringify({
      fetched_at: '2026-07-27T00:00:00.000Z',
      models: [
        {
          slug: 'native-template',
          display_name: 'Native template',
          visibility: 'list',
          base_instructions: 'Native Codex instructions',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
          additional_speed_tiers: ['fast'],
          service_tiers: [{ id: 'priority' }],
          supports_search_tool: true,
          web_search_tool_type: 'text_and_image'
        },
        {
          slug: 'gpt-5.6-sol',
          display_name: 'GPT-5.6-Sol',
          base_instructions: 'Native Codex instructions',
          input_modalities: ['text', 'image'],
          supports_image_detail_original: true,
          default_reasoning_level: 'low',
          supported_reasoning_levels: [
            { effort: 'low' },
            { effort: 'medium' },
            { effort: 'high' },
            { effort: 'xhigh' },
            { effort: 'max' },
            { effort: 'ultra' }
          ]
        }
      ]
    }));
    await fs.writeFile(path.join(codexHome, 'config.toml'), 'model_provider = "openai"\n');

    const catalogManager = new CodexModelCatalogManager();
    const catalogPath = await catalogManager.sync([
      {
        id: 'gpt-compatible',
        vendor: 'OpenAI',
        protocols: ['openai-responses'],
        clients: ['codex'],
        reasoningLevels: ['low', 'xhigh', 'turbo'],
        defaultReasoningLevel: 'xhigh',
        inputModalities: ['text', 'image', 'video'],
        contextWindow: 1_000_000,
        maxOutputTokens: 131_072,
        capabilitySources: { contextWindow: 'models.dev', maxOutputTokens: 'models.dev' }
      },
      { id: 'deepseek-chat', vendor: 'DeepSeek', protocols: ['chat-completions'], clients: ['codex'], vision: true },
      {
        id: 'claude-sonnet-4-5',
        vendor: 'Anthropic',
        protocols: ['anthropic-messages'],
        clients: ['codex'],
        toolCalling: true,
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        vision: true,
        reasoning: true,
        capabilitySources: { contextWindow: 'compatible', maxOutputTokens: 'compatible' }
      },
      {
        id: 'claude-unknown-limits',
        vendor: 'Anthropic',
        protocols: ['anthropic-messages'],
        clients: ['codex'],
        toolCalling: true
      },
      {
        id: 'text-embedding-v4',
        vendor: '兼容服务',
        protocols: ['chat-completions'],
        clients: ['codex']
      },
      {
        id: 'qwen-vl-ocr',
        vendor: '兼容服务',
        protocols: ['chat-completions'],
        clients: ['codex']
      },
      {
        // Current Codex supports `max` and audio, while pdf remains outside
        // the model-catalog modality enum.
        id: 'claude-opus-4-8',
        vendor: 'Anthropic',
        protocols: ['anthropic-messages'],
        clients: ['codex'],
        reasoning: true,
        reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningLevel: 'max',
        inputModalities: ['text', 'image', 'audio', 'pdf'],
        vision: true
      },
      {
        // The generic capability fallback is stale for this exact model. The
        // native Codex catalog must supply max/ultra and the low default.
        id: 'gpt-5.6-sol',
        vendor: 'OpenAI',
        protocols: ['openai-responses'],
        clients: ['codex'],
        reasoning: true,
        reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningLevel: 'medium',
        vision: false,
        inputModalities: ['text'],
        capabilitySources: {
          reasoning: 'builtin',
          vision: 'fallback',
          inputModalities: 'fallback'
        }
      },
      {
        // A non-reasoning model must still emit the required
        // supported_reasoning_levels field (empty), never omit it.
        id: 'doubao-seed-nonreasoning',
        vendor: '兼容服务',
        protocols: ['chat-completions'],
        clients: ['codex'],
        inputModalities: ['text', 'image', 'audio', 'video']
      },
      {
        id: 'qwen3.7-max',
        vendor: 'Alibaba',
        protocols: ['chat-completions'],
        clients: ['codex'],
        reasoning: true,
        reasoningLevels: ['low', 'medium', 'high'],
        defaultReasoningLevel: 'medium'
      },
      {
        id: 'doubao-seed-2-0-pro',
        vendor: 'Volcengine',
        protocols: ['chat-completions'],
        clients: ['codex'],
        reasoning: true,
        reasoningLevels: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningLevel: 'medium'
      },
      {
        id: 'grok-4.6',
        vendor: 'xAI',
        protocols: ['chat-completions'],
        clients: ['codex'],
        reasoning: true,
        reasoningLevels: ['low', 'medium', 'high'],
        defaultReasoningLevel: 'medium'
      },
      {
        id: 'grok-4.20-0309-reasoning',
        vendor: 'xAI',
        protocols: ['chat-completions'],
        clients: ['codex'],
        reasoning: true,
        reasoningLevels: ['low', 'medium', 'high'],
        defaultReasoningLevel: 'medium'
      },
      {
        id: 'gpt-5.4',
        vendor: 'OpenAI',
        protocols: ['openai-responses'],
        clients: ['codex'],
        reasoning: true,
        reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningLevel: 'none'
      },
      {
        // Reaches the chat-completions branch because 兼容服务 also lists it on
        // /v1/models. Its profile takes an effort field but declares no ladder,
        // so the sourced levels must survive.
        id: 'gpt-5.6-nova',
        vendor: 'OpenAI',
        protocols: ['openai-responses', 'chat-completions'],
        clients: ['codex'],
        reasoning: true,
        reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
        defaultReasoningLevel: 'medium'
      },
      {
        // The capability layer marks this one as reasoning from the built-in
        // registry (probe-measured), so the profile ladder must supply the
        // levels even though no aggregator sourced any.
        id: 'doubao-seed-2-1-turbo',
        vendor: 'Volcengine',
        protocols: ['chat-completions'],
        clients: ['codex'],
        reasoning: true
      }
    ]);
    const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8')) as { models: Array<Record<string, unknown>> };
    assert.deepEqual(
      catalog.models.map(row => row.slug),
      [
        'gpt-compatible',
        'deepseek-chat',
        'claude-sonnet-4-5',
        'claude-unknown-limits',
        'claude-opus-4-8',
        'gpt-5.6-sol',
        'doubao-seed-nonreasoning',
        'qwen3.7-max',
        'doubao-seed-2-0-pro',
        'grok-4.6',
        'grok-4.20-0309-reasoning',
        'gpt-5.4',
        'gpt-5.6-nova',
        'doubao-seed-2-1-turbo'
      ]
    );
    assert.equal(catalog.models[0].base_instructions, 'Native Codex instructions');
    assert.deepEqual(catalog.models[0].supported_reasoning_levels, [
      { effort: 'low', description: 'low reasoning effort' },
      { effort: 'xhigh', description: 'xhigh reasoning effort' }
    ]);
    assert.equal(catalog.models[0].default_reasoning_level, 'xhigh');
    assert.equal(catalog.models[0].context_window, 272_000, 'verified GPT 1M models must default to the standard Codex window');
    assert.equal(catalog.models[0].max_context_window, 1_000_000);
    assert.equal(catalog.models[0].auto_compact_token_limit, 244_800);
    assert.equal(catalog.models[1].description, 'DeepSeek · 兼容服务');
    assert.deepEqual(catalog.models[1].input_modalities, ['text', 'image']);
    assert.equal(catalog.models[2].context_window, 200_000);
    assert.equal('max_output_tokens' in catalog.models[2], false, 'max_output_tokens is not part of the Codex model schema');
    assert.deepEqual(catalog.models[2].input_modalities, ['text', 'image']);
    assert.equal(catalog.models[2].supports_reasoning_summary_parameter, true);
    assert.equal('supports_reasoning_summaries' in catalog.models[2], false, 'the misspelled summary field must not be emitted');
    assert.equal('supports_websockets' in catalog.models[2], false, 'websocket support is a provider field, not a model field');
    assert.equal(catalog.models[3].context_window, 262_144);
    assert.equal(catalog.models[3].max_context_window, 262_144);
    assert.equal(catalog.models[3].supports_parallel_tool_calls, false);
    assert.equal('service_tiers' in catalog.models[0], false, 'routed models must not inherit OpenAI Fast tiers');
    assert.equal(catalog.models[0].supports_search_tool, false, 'routed models must not advertise hosted search');

    // Codex 把 catalog 反序列化成严格 Rust 枚举，未知变体会整份文件被拒、启动直接失败——
    // 但这只适用于封闭枚举（shell_type / visibility / input_modalities / truncation_policy.mode）。
    // ReasoningEffort 已带 Custom(String) 分支，任何拼写都会被原样转发，所以档位白名单是
    // 我们自己的护栏：挡住聚合目录臆造的档位。`ultra` 会被 Codex 改写成 `max`，一并排除。
    //   本机实测 codex 0.148.0-alpha.9：InputModality = text|image|audio
    // 上面的 gpt-compatible 夹具刻意喂入非法的 'turbo' / 'video'，若 clamp 失效这里必然报警——
    // 曾经夹具只喂合法值，导致这些断言对 clamp 完全空转。
    const CODEX_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    const CODEX_MODALITIES = new Set(['text', 'image', 'audio']);
    for (const row of catalog.models) {
      assert.equal('comp_hash' in row, false, `${row.slug} must not force compaction when switching providers`);
      const levels = (row.supported_reasoning_levels as Array<{ effort: string }> | undefined) ?? null;
      assert.ok(Array.isArray(levels), `${row.slug} must always emit supported_reasoning_levels (required field)`);
      for (const level of levels!) {
        assert.ok(CODEX_EFFORTS.has(level.effort), `${row.slug} leaked invalid reasoning effort "${level.effort}" into the Codex catalog`);
      }
      const def = row.default_reasoning_level as string | undefined;
      if (def !== undefined) assert.ok(CODEX_EFFORTS.has(def), `${row.slug} default_reasoning_level "${def}" is not a Codex effort`);
      for (const modality of (row.input_modalities as string[])) {
        assert.ok(CODEX_MODALITIES.has(modality), `${row.slug} leaked invalid input modality "${modality}" into the Codex catalog`);
      }
    }
    const opus = catalog.models.find(row => row.slug === 'claude-opus-4-8')!;
    assert.deepEqual(
      (opus.supported_reasoning_levels as Array<{ effort: string }>).map(l => l.effort),
      ['low', 'medium', 'high', 'xhigh', 'max']
    );
    assert.equal(opus.default_reasoning_level, 'high');
    assert.deepEqual(opus.input_modalities, ['text', 'image', 'audio'], 'pdf must be dropped from Codex modalities');
    const sol = catalog.models.find(row => row.slug === 'gpt-5.6-sol')!;
    assert.deepEqual(
      (sol.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort),
      ['low', 'medium', 'high', 'xhigh', 'max'],
      'exact native model metadata must beat stale generic capability efforts, minus the ultra alias Codex rewrites to max'
    );
    assert.equal(sol.default_reasoning_level, 'low');
    assert.deepEqual(
      sol.input_modalities,
      ['text', 'image'],
      'an exact native Codex model must fill image support while 兼容服务 capability metadata is still fallback'
    );
    assert.equal(sol.supports_image_detail_original, true);
    const nonReasoning = catalog.models.find(row => row.slug === 'doubao-seed-nonreasoning')!;
    assert.deepEqual(nonReasoning.supported_reasoning_levels, [], 'non-reasoning models keep the required field as an empty array');
    assert.equal('default_reasoning_level' in nonReasoning, false, 'no default effort without supported levels');
    assert.deepEqual(nonReasoning.input_modalities, ['text', 'image', 'audio'], 'video must be dropped from Codex modalities');
    // Toggle-plus-effort families publish the probed ladder, not a synthetic
    // low/medium/high that would collapse into one identical request.
    const qwenRow = catalog.models.find(row => row.slug === 'qwen3.7-max')!;
    assert.deepEqual(
      (qwenRow.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort),
      ['none', 'low', 'medium', 'high', 'xhigh'],
      'qwen caps at xhigh: the gateway rejects reasoning_effort max'
    );
    assert.equal(qwenRow.default_reasoning_level, 'high');
    const doubaoRow = catalog.models.find(row => row.slug === 'doubao-seed-2-0-pro')!;
    assert.deepEqual(
      (doubaoRow.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort),
      ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      'doubao-seed 2.x accepts the full ladder'
    );
    assert.equal(doubaoRow.default_reasoning_level, 'high');
    // MiniMax M3 has no usable effort field, so it keeps the two-entry toggle
    // list — and `high` must come first. On an in-session model switch Codex
    // ignores `default_reasoning_level` and takes index `(len - 1) / 2`, which
    // is index 0 for two entries (`turn_context.rs` `with_model`), so a
    // `['none', ...]` order would silently land the user on thinking-off.
    assert.deepEqual(resolveCompatibleServiceReasoningProfile('MiniMax-M3').levels, ['high', 'none']);
    const grok46 = catalog.models.find(row => row.slug === 'grok-4.6')!;
    assert.deepEqual(
      (grok46.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort),
      ['low', 'medium', 'high', 'xhigh'],
      'only 4.6 honours xhigh, and xAI never allows disabling reasoning'
    );
    assert.equal(grok46.default_reasoning_level, 'high');
    const grok420 = catalog.models.find(row => row.slug === 'grok-4.20-0309-reasoning')!;
    assert.deepEqual(grok420.supported_reasoning_levels, []);
    assert.equal('default_reasoning_level' in grok420, false);
    const gpt54 = catalog.models.find(row => row.slug === 'gpt-5.4')!;
    assert.deepEqual(
      (gpt54.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort),
      ['none', 'low', 'medium', 'high', 'xhigh'],
      'gpt-5.x keeps every sourced level selectable'
    );
    assert.equal(gpt54.default_reasoning_level, 'medium', 'a sourced `none` default must not become the Codex default');
    // Regression: a chat-completions-listed GPT keeps its sourced ladder. The
    // convergence layer must not treat "no ladder in the profile" as "no levels".
    const gptNova = catalog.models.find(row => row.slug === 'gpt-5.6-nova')!;
    assert.deepEqual(
      (gptNova.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort),
      ['none', 'low', 'medium', 'high', 'xhigh'],
      'a GPT listed on /v1/models must keep its effort picker'
    );
    // Regression: a measured ladder publishes once the registry says the model
    // reasons — the aggregators carry no `reasoning` flag for these ids.
    const doubaoTurbo = catalog.models.find(row => row.slug === 'doubao-seed-2-1-turbo')!;
    assert.deepEqual(
      (doubaoTurbo.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort),
      ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      'the probed ladder must supply levels when no aggregator sourced any'
    );
    assert.equal(doubaoTurbo.supports_reasoning_summary_parameter, true, 'summary support must follow the same conclusion');
    // The probe outranks the aggregators for this field; a cited model-owner
    // page still outranks the probe.
    for (const id of ['doubao-seed-2-1-pro', 'doubao-seed-2-1-turbo', 'doubao-seed-1-6-flash', 'doubao-seed-1-6-vision', 'kimi-k3-external']) {
      assert.equal(
        findProbedModelCapability(id)?.reasoning,
        true,
        `${id} emitted reasoning tokens when probed and must be marked as reasoning`
      );
    }
    assert.equal(
      findProbedModelCapability('doubao-seed-character'),
      undefined,
      'doubao-seed-character accepted every control parameter but never reasoned'
    );

    const config = new CodexConfigManager(path.join(root, 'codex-model-gateway-user-data'));
    const gateway = await config.update({
      mode: 'compatible',
      compatibleModel: 'deepseek-chat',
      compatibleBaseUrl: 'https://compatible.example/v1',
      compatibleBearerToken: 'qa-key',
      gatewayBaseUrl: 'http://127.0.0.1:34117/v1',
      modelCatalogPath: catalogPath
    });
    assert.equal(gateway.compatible.baseUrl, 'http://127.0.0.1:34117/v1');
    const gatewayToml = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(gatewayToml, /^model_catalog_json = ".*xwx-compatible-catalog\.json"$/m);
    assert.match(gatewayToml, /\[model_providers\.xwx_deck\][\s\S]*base_url = "http:\/\/127\.0\.0\.1:34117\/v1"/);
    assert.doesNotMatch(
      gatewayToml,
      /experimental_bearer_token/,
      'the local Gateway must inject 兼容服务 auth without exposing it to the live Codex process'
    );

    const officialGateway = await config.update({
      mode: 'official',
      officialModel: 'gpt-official',
      gatewayBaseUrl: 'http://127.0.0.1:34117/backend-api/codex'
    });
    assert.equal(officialGateway.mode, 'official');
    assert.equal(officialGateway.activeBaseUrl, 'http://127.0.0.1:34117/backend-api/codex');

    await catalogManager.syncIfXwXOwned([
      {
        id: 'opus5',
        vendor: 'Anthropic',
        protocols: ['anthropic-messages'],
        clients: ['codex'],
        contextWindow: 1_000_000
      }
    ]);
    const refreshedCatalog = JSON.parse(await fs.readFile(catalogPath, 'utf8')) as {
      models: Array<Record<string, unknown>>
    };
    assert.deepEqual(
      refreshedCatalog.models.map(row => row.slug),
      ['opus5'],
      'a 兼容服务 catalog refresh must update the XwX-owned Codex catalog'
    );
    const unchangedRefresh = await catalogManager.syncIfXwXOwned([
      {
        id: 'opus5',
        vendor: 'Anthropic',
        protocols: ['anthropic-messages'],
        clients: ['codex'],
        contextWindow: 1_000_000
      }
    ]);
    assert.equal(unchangedRefresh?.changed, false, 'an unchanged catalog must not be rewritten');

    await config.update({
      mode: 'compatible',
      compatibleModel: 'deepseek-chat',
      compatibleBaseUrl: 'https://compatible.example/v1',
      compatibleBearerToken: 'qa-key',
      gatewayBaseUrl: 'http://127.0.0.1:34117/v1',
      modelCatalogPath: catalogPath,
      preserveOfficialLogin: false
    });
    const projectedGatewayToml = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.doesNotMatch(
      projectedGatewayToml,
      /experimental_bearer_token/,
      'auth.json owns the 兼容服务 credential when login preservation is disabled'
    );

    const detached = await config.restoreCompatibleServiceGateway({
      upstreamBaseUrl: 'https://compatible.example/v1',
      gatewayBaseUrl: 'http://127.0.0.1:34117/v1'
    });
    assert.equal(detached.restoredFields, 2);
    const detachedToml = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(detachedToml, /\[model_providers\.xwx_deck\][\s\S]*base_url = "https:\/\/compatible\.example\/v1"/);
    assert.doesNotMatch(detachedToml, /^model_catalog_json\s*=/m, 'clean shutdown must not leave a dead Gateway pointer');

    await config.update({ mode: 'official', officialModel: 'gpt-official' });
    const officialToml = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.doesNotMatch(officialToml, /^model_catalog_json\s*=/m, 'returning official removes only the XwX catalog pointer');

    await fs.writeFile(path.join(codexHome, 'config.toml'), 'model_catalog_json = "C:/user/catalog.json"\n');
    await config.update({
      mode: 'compatible',
      compatibleModel: 'deepseek-chat',
      compatibleBaseUrl: 'https://compatible.example/v1',
      compatibleBearerToken: 'qa-key',
      gatewayBaseUrl: 'http://127.0.0.1:34117/v1',
      modelCatalogPath: catalogPath
    });
    const userCatalogToml = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(userCatalogToml, /^model_catalog_json = "C:\/user\/catalog\.json"$/m, 'a user-owned catalog pointer must be preserved');
    const userCatalogResult = await catalogManager.syncIfXwXOwned([
      {
        id: 'should-not-overwrite-user-catalog',
        vendor: '兼容服务',
        protocols: ['chat-completions'],
        clients: ['codex']
      }
    ]);
    assert.equal(userCatalogResult, undefined, 'a user-owned Codex catalog must not be overwritten');
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
  completed.push('Codex Desktop 兼容服务 catalog and persistent Gateway config');
}

async function testCodexOfficialAuthPolicy(): Promise<void> {
  const previousHome = process.env.CODEX_HOME;
  const base = path.join(root, 'codex-official-auth');
  const codexHome = path.join(base, '.codex');
  process.env.CODEX_HOME = codexHome;
  try {
    await fs.mkdir(codexHome, { recursive: true });
    const authPath = path.join(codexHome, 'auth.json');
    const officialBytes = Buffer.from('{\r\n  "auth_mode": "chatgpt",\r\n  "tokens": { "access_token": "qa-oauth-secret" }\r\n}\r\n');
    const projectedBytes = Buffer.from('{"OPENAI_API_KEY":"qa-compatible-key"}\n');
    await fs.writeFile(authPath, projectedBytes);
    const userData = path.join(base, 'user-data');
    await fs.mkdir(userData, { recursive: true });
    await fs.writeFile(path.join(userData, 'codex-official-auth-state.json'), JSON.stringify({
      version: 1,
      authPath,
      originalExisted: true,
      originalContentBase64: officialBytes.toString('base64'),
      writtenContentBase64: projectedBytes.toString('base64')
    }));

    const manager = new CodexOfficialAuthManager(userData);
    const restored = await manager.restoreOfficialLogin();
    assert.equal(restored.changed, true);
    assert.deepEqual(await fs.readFile(authPath), officialBytes);

    const projected = await manager.useCompatibleServiceKey('qa-compatible-key');
    assert.equal(projected.changed, true);
    assert.equal(projected.managed, true);
    assert.deepEqual(
      JSON.parse(await fs.readFile(authPath, 'utf8')),
      { OPENAI_API_KEY: 'qa-compatible-key' }
    );
    await manager.restoreOfficialLogin();
    assert.deepEqual(await fs.readFile(authPath), officialBytes);

    const apiKeyBytes = Buffer.from('{\r\n  "auth_mode": "api-key",\r\n  "OPENAI_API_KEY": "sk-openai-user"\r\n}\r\n');
    await fs.writeFile(authPath, apiKeyBytes);
    await manager.useCompatibleServiceKey('qa-compatible-key');
    await manager.restoreOfficialLogin();
    assert.deepEqual(
      await fs.readFile(authPath),
      apiKeyBytes,
      'OpenAI API-key login must restore byte-for-byte after leaving Gateway credential mode'
    );

    await fs.writeFile(authPath, projectedBytes);
    await fs.writeFile(path.join(userData, 'codex-official-auth-state.json'), JSON.stringify({
      version: 1,
      authPath,
      originalExisted: true,
      originalContentBase64: officialBytes.toString('base64'),
      writtenContentBase64: projectedBytes.toString('base64')
    }));
    const externalBytes = Buffer.from('{"auth_mode":"chatgpt","external":"changed"}\n');
    await fs.writeFile(authPath, externalBytes);
    await assert.rejects(manager.restoreOfficialLogin(), /其他软件修改/);
    assert.deepEqual(await fs.readFile(authPath), externalBytes);

    const missingBase = path.join(root, 'codex-official-auth-missing');
    process.env.CODEX_HOME = path.join(missingBase, '.codex');
    const missingAuthPath = path.join(process.env.CODEX_HOME, 'auth.json');
    const missingUserData = path.join(missingBase, 'user-data');
    await fs.mkdir(path.dirname(missingAuthPath), { recursive: true });
    await fs.mkdir(missingUserData, { recursive: true });
    await fs.writeFile(missingAuthPath, projectedBytes);
    await fs.writeFile(path.join(missingUserData, 'codex-official-auth-state.json'), JSON.stringify({
      version: 1,
      authPath: missingAuthPath,
      originalExisted: false,
      originalContentBase64: '',
      writtenContentBase64: projectedBytes.toString('base64')
    }));
    const missingManager = new CodexOfficialAuthManager(missingUserData);
    await missingManager.restoreOfficialLogin();
    await assert.rejects(fs.access(missingAuthPath));
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
  completed.push('legacy ChatGPT auth projection recovery with byte-safe conflict protection');
}

async function testCodexEnhancements(): Promise<void> {
  const previousHome = process.env.CODEX_HOME;
  const previousSqliteHome = process.env.CODEX_SQLITE_HOME;
  const base = path.join(root, 'codex-enhancements');
  const codexHome = path.join(base, '.codex');
  const sqliteHome = path.join(base, 'sqlite-home');
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_SQLITE_HOME = sqliteHome;
  try {
    const sessionDir = path.join(codexHome, 'sessions', '2026', '07', '17');
    const archivedDir = path.join(codexHome, 'archived_sessions');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.mkdir(archivedDir, { recursive: true });
    await fs.mkdir(sqliteHome, { recursive: true });
    const authBytes = Buffer.from('{\r\n  "auth_mode": "chatgpt",\r\n  "tokens": { "access_token": "qa-oauth-secret" }\r\n}\r\n', 'utf8');
    await fs.writeFile(path.join(codexHome, 'auth.json'), authBytes);
    await fs.writeFile(path.join(codexHome, 'config.toml'), [
      'model_provider = "openai"',
      'model = "gpt-5.5"',
      '',
      '[model_providers.compatible]',
      'name = "兼容服务"',
      'base_url = "https://compatible.example/v1"',
      'wire_api = "responses"',
      'requires_openai_auth = true',
      'experimental_bearer_token = "qa-compatible-key"',
      ''
    ].join('\n'));
    const officialPath = path.join(sessionDir, 'official.jsonl');
    const largeHistoryContent = 'x'.repeat(2 * 1024 * 1024);
    const officialBody = '{"type":"session_meta","payload":{"id":"official-session","model_provider":"openai","cwd":"C:/qa"}}\n'
      + `{"type":"response_item","payload":{"role":"user","content":"must stay byte-for-byte:${largeHistoryContent}"}}\n`;
    const compatibleBody = '{"type":"session_meta","payload":{"id":"compatible-session","model_provider":"compatible"}}\n';
    await fs.writeFile(officialPath, officialBody);
    await fs.writeFile(path.join(archivedDir, 'compatible.jsonl'), compatibleBody);

    for (const dbPath of [path.join(codexHome, 'state_5.sqlite'), path.join(sqliteHome, 'state_5.sqlite')]) {
      const db = new Database(dbPath);
      db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL); INSERT INTO threads VALUES ('official-thread', 'openai'), ('compatible-thread', 'compatible');");
      db.close();
    }

    const config = new CodexConfigManager(path.join(base, 'user-data'));
    const unified = await config.update({
      mode: 'official',
      officialModel: 'gpt-5.5',
      compatibleBaseUrl: 'https://compatible.example/v1',
      compatibleBearerToken: 'qa-compatible-key',
      unifySessionHistory: true
    });
    assert.equal(unified.mode, 'official');
    assert.equal(unified.activeProvider, 'xwx_deck');
    assert.deepEqual(await fs.readFile(path.join(codexHome, 'auth.json')), authBytes);
    const unifiedToml = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(unifiedToml, /^model_provider = "xwx_deck"$/m);
    assert.match(unifiedToml, /\[model_providers\.xwx_deck\][\s\S]*name = "XwX Deck"/);
    assert.match(unifiedToml, /\[model_providers\.xwx_deck\][\s\S]*base_url = "https:\/\/chatgpt\.com\/backend-api\/codex"/);
    assert.match(unifiedToml, /\[model_providers\.compatible\][\s\S]*name = "兼容服务"/);
    assert.match(unifiedToml, /qa-compatible-key|compatible\.example/);
    const stableOauth = detectCodexUpstream(resolveClientPaths());
    assert.ok(!('reason' in stableOauth));
    assert.equal(stableOauth.provider, 'xwx_deck');
    assert.equal(stableOauth.routeKind, 'chatgpt-oauth');
    assert.equal(stableOauth.baseUrl, 'https://chatgpt.com/backend-api');

    const history = new CodexHistoryManager(path.join(base, 'user-data'));
    let expectedMigratedJsonlFiles = 2;
    let expectedMigratedStateRows = 4;
    if (process.platform === 'win32') {
      const releaseLock = await holdWindowsReadLock(path.join(archivedDir, 'compatible.jsonl'));
      try {
        const lockedAttempt = await history.mergeIntoXwXDeckHistory();
        assert.equal(lockedAttempt.migratedJsonlFiles, 1);
        assert.equal(lockedAttempt.migratedStateRows, 4);
        assert.equal(lockedAttempt.skippedLockedJsonlFiles, 1);
        assert.equal(await fs.readFile(path.join(archivedDir, 'compatible.jsonl'), 'utf8'), compatibleBody);
        assert.deepEqual((await fs.readdir(archivedDir)).filter(name => name.endsWith('.tmp')), []);
        expectedMigratedJsonlFiles = 1;
        expectedMigratedStateRows = 0;
      } finally {
        await releaseLock();
      }
    }
    const migrated = await history.mergeIntoXwXDeckHistory();
    assert.equal(migrated.migratedJsonlFiles, expectedMigratedJsonlFiles);
    assert.equal(migrated.migratedStateRows, expectedMigratedStateRows);
    assert.equal(migrated.skippedLockedJsonlFiles, 0);
    assert.equal(await history.hasMigrationBackup(), true);
    assert.match(await fs.readFile(officialPath, 'utf8'), /"id":"official-session","model_provider":"xwx_deck"/);
    const migratedBody = await fs.readFile(path.join(archivedDir, 'compatible.jsonl'), 'utf8');
    assert.match(migratedBody, /"id":"compatible-session","model_provider":"xwx_deck"/);

    for (const dbPath of [path.join(codexHome, 'state_5.sqlite'), path.join(sqliteHome, 'state_5.sqlite')]) {
      const db = new Database(dbPath, { readonly: true });
      assert.equal((db.prepare("SELECT model_provider FROM threads WHERE id = 'official-thread'").get() as { model_provider: string }).model_provider, 'xwx_deck');
      assert.equal((db.prepare("SELECT model_provider FROM threads WHERE id = 'compatible-thread'").get() as { model_provider: string }).model_provider, 'xwx_deck');
      db.close();
    }

    const restoredConfig = await config.update({
      mode: 'official',
      officialModel: 'gpt-5.5',
      compatibleBaseUrl: 'https://compatible.example/v1',
      compatibleBearerToken: 'qa-compatible-key',
      unifySessionHistory: false
    });
    assert.equal(restoredConfig.activeProvider, 'xwx_deck');
    assert.equal(restoredConfig.compatible.baseUrl, 'https://compatible.example/v1');
    const restored = await history.restoreSeparatedHistory();
    assert.equal(restored.restoredJsonlFiles, 2);
    assert.equal(restored.restoredStateRows, 4);
    const firstRestoredOfficial = await fs.readFile(officialPath, 'utf8');
    assert.match(firstRestoredOfficial, /"id":"official-session","model_provider":"openai"/);
    assert.ok(firstRestoredOfficial.endsWith(officialBody.slice(officialBody.indexOf('\n') + 1)));
    assert.equal(await fs.readFile(path.join(archivedDir, 'compatible.jsonl'), 'utf8'), compatibleBody);
    assert.deepEqual(await fs.readFile(path.join(codexHome, 'auth.json')), authBytes);
    const rerun = await history.restoreSeparatedHistory();
    assert.equal(rerun.skippedReason, 'nothing_to_restore');

    const active兼容服务 = await config.update({
      mode: 'compatible',
      officialModel: 'gpt-5.5',
      compatibleModel: 'gpt-5.5',
      compatibleBaseUrl: 'https://compatible.example/v1',
      compatibleBearerToken: 'qa-compatible-key',
      unifySessionHistory: true
    });
    assert.equal(active兼容服务.activeProvider, 'xwx_deck');
    const activeMerge = await history.mergeIntoActiveHistory();
    assert.equal(activeMerge.migratedJsonlFiles, 2);
    assert.equal(activeMerge.migratedStateRows, 4);
    assert.match(await fs.readFile(officialPath, 'utf8'), /"id":"official-session","model_provider":"xwx_deck"/);
    assert.match(await fs.readFile(path.join(archivedDir, 'compatible.jsonl'), 'utf8'), /"id":"compatible-session","model_provider":"xwx_deck"/);
    for (const dbPath of [path.join(codexHome, 'state_5.sqlite'), path.join(sqliteHome, 'state_5.sqlite')]) {
      const db = new Database(dbPath, { readonly: true });
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM threads WHERE model_provider = 'xwx_deck'").get() as { count: number }).count, 2);
      db.close();
    }
    const activeNoop = await history.mergeIntoActiveHistory();
    assert.equal(activeNoop.skippedReason, 'no_matching_history');
    assert.equal(activeNoop.migratedJsonlFiles, 0);
    assert.equal(activeNoop.migratedStateRows, 0);

    const unifiedOfficialSize = (await fs.stat(officialPath)).size;
    const activeRestored = await history.restoreSeparatedHistory();
    assert.equal(activeRestored.restoredJsonlFiles, 2);
    assert.equal(activeRestored.restoredStateRows, 4);
    const optimizedRestoredBody = await fs.readFile(officialPath, 'utf8');
    const originalHistoryTail = officialBody.slice(officialBody.indexOf('\n') + 1);
    assert.match(optimizedRestoredBody, /"id":"official-session","model_provider":"openai"/);
    assert.ok(optimizedRestoredBody.endsWith(originalHistoryTail), 'streaming history rewrite changed the rollout body');
    assert.equal((await fs.stat(officialPath)).size, unifiedOfficialSize);
    assert.equal(await fs.readFile(path.join(archivedDir, 'compatible.jsonl'), 'utf8'), compatibleBody);

    const activeMergeAgain = await history.mergeIntoActiveHistory();
    assert.equal(activeMergeAgain.migratedJsonlFiles, 2);
    assert.equal((await fs.stat(officialPath)).size, unifiedOfficialSize);
    const activeRestoredAgain = await history.restoreSeparatedHistory();
    assert.equal(activeRestoredAgain.restoredJsonlFiles, 2);
    assert.equal((await fs.stat(officialPath)).size, unifiedOfficialSize);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    if (previousSqliteHome === undefined) delete process.env.CODEX_SQLITE_HOME;
    else process.env.CODEX_SQLITE_HOME = previousSqliteHome;
  }
  completed.push('ChatGPT auth preservation and active-provider JSONL/SQLite history merge');
}

async function testCodexHistoryMutationGate(): Promise<void> {
  const previousHome = process.env.CODEX_HOME;
  const previousSqliteHome = process.env.CODEX_SQLITE_HOME;
  const base = path.join(root, 'codex-history-mutation-gate');
  const codexHome = path.join(base, '.codex');
  const userData = path.join(base, 'user-data');
  const sessionDir = path.join(codexHome, 'sessions', '2026', '08', '13');
  const officialSession = path.join(sessionDir, 'official.jsonl');
  const dbPath = path.join(codexHome, 'state_5.sqlite');
  let chatGptRunning = true;

  const controllerSource = await fs.readFile(path.resolve('src', 'main', 'app', 'xwxDeckController.ts'), 'utf8');
  assert.doesNotMatch(controllerSource, /scheduleCodexHistoryWork\(`retry[^`]*\$\{reason\}/,
    'history retries must use stable labels instead of recursively growing the previous reason');

  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SQLITE_HOME;
  try {
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(codexHome, 'config.toml'), [
      'model_provider = "xwx_deck"',
      '',
      '[model_providers.xwx_deck]',
      'name = "XwX Deck"',
      'base_url = "https://chatgpt.com/backend-api/codex"',
      ''
    ].join('\n'));
    const db = new Database(dbPath);
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL);");
    db.close();

    const history = new CodexHistoryManager(userData, async () => !chatGptRunning);
    const officialBody = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: 'official-session', model_provider: 'openai' }
    })}\n`;
    await fs.writeFile(officialSession, officialBody);
    {
      const writableDb = new Database(dbPath);
      writableDb.prepare('INSERT INTO threads (id, model_provider) VALUES (?, ?)').run('official-thread', 'openai');
      writableDb.close();
    }

    chatGptRunning = true;
    const deferredMerge = await history.mergeIntoXwXDeckHistory();
    assert.equal(deferredMerge.skippedReason, 'restore_deferred');
    assert.equal(await fs.readFile(officialSession, 'utf8'), officialBody);
    {
      const liveDb = new Database(dbPath, { readonly: true });
      assert.equal(
        (liveDb.prepare("SELECT model_provider FROM threads WHERE id = 'official-thread'").get() as { model_provider: string }).model_provider,
        'openai'
      );
      liveDb.close();
    }

    chatGptRunning = false;
    const merged = await history.mergeIntoXwXDeckHistory();
    assert.equal(merged.migratedJsonlFiles, 1);
    assert.equal(merged.migratedStateRows, 1);

    chatGptRunning = true;
    const deferredRestore = await history.restoreSeparatedHistory();
    assert.equal(deferredRestore.skippedReason, 'restore_deferred');
    assert.match(await fs.readFile(officialSession, 'utf8'), /"model_provider":"xwx_deck"/);
    {
      const liveDb = new Database(dbPath, { readonly: true });
      assert.equal(
        (liveDb.prepare("SELECT model_provider FROM threads WHERE id = 'official-thread'").get() as { model_provider: string }).model_provider,
        'xwx_deck'
      );
      liveDb.close();
    }

    chatGptRunning = false;
    const restored = await history.restoreSeparatedHistory();
    assert.equal(restored.restoredJsonlFiles, 1);
    assert.equal(restored.restoredStateRows, 1);
    assert.match(await fs.readFile(officialSession, 'utf8'), /"model_provider":"openai"/);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    if (previousSqliteHome === undefined) delete process.env.CODEX_SQLITE_HOME;
    else process.env.CODEX_SQLITE_HOME = previousSqliteHome;
  }
  completed.push('running ChatGPT defers POSIX JSONL and SQLite history mutations');
}

async function testCodexCustomHistoryProviders(): Promise<void> {
  const previousHome = process.env.CODEX_HOME;
  const previousSqliteHome = process.env.CODEX_SQLITE_HOME;
  const base = path.join(root, 'codex-custom-history-providers');
  const codexHome = path.join(base, '.codex');
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SQLITE_HOME;
  try {
    const sessionDir = path.join(codexHome, 'sessions', '2026', '07', '24');
    await fs.mkdir(sessionDir, { recursive: true });
    // The stable provider remains active while Trace is running.
    await fs.writeFile(path.join(codexHome, 'config.toml'), [
      'model_provider = "xwx_deck"',
      '',
      '[model_providers.xwx_deck]',
      'base_url = "http://127.0.0.1:34117/backend-api/codex"',
      ''
    ].join('\n'));

    const originalProviders = new Map([
      ['official-session', 'openai'],
      ['compatible-session', 'compatible'],
      ['custom-session', 'custom-gateway'],
      ['secondary-session', 'secondary-gateway']
    ]);
    for (const [id, provider] of originalProviders) {
      await fs.writeFile(
        path.join(sessionDir, `${id}.jsonl`),
        `${JSON.stringify({ type: 'session_meta', payload: { id, model_provider: provider } })}\n`
      );
    }

    const dbPath = path.join(codexHome, 'state_5.sqlite');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO threads (id, model_provider) VALUES (?, ?)');
    for (const [id, provider] of originalProviders) insert.run(id, provider);
    db.close();

    const history = new CodexHistoryManager(path.join(base, 'user-data'));
    const merged = await history.mergeIntoActiveHistory();
    assert.equal(merged.migratedJsonlFiles, 4);
    assert.equal(merged.migratedStateRows, 4);
    for (const id of originalProviders.keys()) {
      const content = await fs.readFile(path.join(sessionDir, `${id}.jsonl`), 'utf8');
      assert.match(content, /"model_provider":"xwx_deck"/);
    }
    {
      const mergedDb = new Database(dbPath, { readonly: true });
      assert.equal((mergedDb.prepare("SELECT COUNT(*) AS count FROM threads WHERE model_provider = 'xwx_deck'").get() as { count: number }).count, 4);
      mergedDb.close();
    }

    const restored = await history.restoreSeparatedHistory();
    assert.equal(restored.restoredJsonlFiles, 4);
    assert.equal(restored.restoredStateRows, 4);
    for (const [id, provider] of originalProviders) {
      const content = await fs.readFile(path.join(sessionDir, `${id}.jsonl`), 'utf8');
      assert.match(content, new RegExp(`"model_provider":"${provider}"`));
    }

    await fs.writeFile(path.join(codexHome, 'config.toml'), [
      'model_provider = "legacy-compatible-alias"',
      '',
      '[model_providers.legacy-compatible-alias]',
      'base_url = "https://compatible.example/v1"',
      ''
    ].join('\n'));
    const legacyDeferred = await history.mergeIntoActiveHistory();
    assert.equal(legacyDeferred.skippedReason, 'live_not_target');

    await fs.writeFile(path.join(codexHome, 'config.toml'), [
      'model_provider = "xwx_deck"',
      '',
      '[model_providers.xwx_deck]',
      'base_url = "https://compatible.example/v1"',
      ''
    ].join('\n'));
    const compatibleMerged = await history.mergeIntoProviderHistory('xwx_deck');
    assert.equal(compatibleMerged.migratedJsonlFiles, 4);
    assert.equal(compatibleMerged.migratedStateRows, 4);
    for (const id of originalProviders.keys()) {
      const content = await fs.readFile(path.join(sessionDir, `${id}.jsonl`), 'utf8');
      assert.match(content, /"model_provider":"xwx_deck"/);
    }

    const v3Generation = path.join(
      base,
      'user-data',
      'backups',
      'codex-active-history-unify-v3',
      '20260724-v3-compat'
    );
    await fs.mkdir(path.join(v3Generation, 'jsonl', 'sessions', '2026', '07', '24'), { recursive: true });
    await fs.writeFile(path.join(v3Generation, 'meta.json'), JSON.stringify({
      version: 3,
      codexHome,
      sourceProvider: 'legacy-custom-provider',
      targetProvider: 'openai'
    }));
    await fs.writeFile(
      path.join(v3Generation, 'jsonl', 'sessions', '2026', '07', '24', 'legacy-v3.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'legacy-v3', model_provider: 'legacy-custom-provider' } })}\n`
    );
    const liveV3Path = path.join(sessionDir, 'legacy-v3.jsonl');
    await fs.writeFile(
      liveV3Path,
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'legacy-v3', model_provider: 'xwx_deck' } })}\n`
    );
    const restoredV3 = await history.restoreSeparatedHistory();
    assert.equal(restoredV3.restoredJsonlFiles, 5);
    assert.match(await fs.readFile(liveV3Path, 'utf8'), /"model_provider":"compatible"/);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    if (previousSqliteHome === undefined) delete process.env.CODEX_SQLITE_HOME;
    else process.env.CODEX_SQLITE_HOME = previousSqliteHome;
  }
  completed.push('ChatGPT stable-provider history migration and exact v5 restore');
}

async function holdWindowsReadLock(file: string): Promise<() => Promise<void>> {
  const script = [
    '$stream = [System.IO.File]::Open($env:XWX_DECK_LOCK_FILE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)',
    '[Console]::Out.WriteLine("LOCKED")',
    '[Console]::Out.Flush()',
    '$null = [Console]::In.ReadLine()',
    '$stream.Dispose()'
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, XWX_DECK_LOCK_FILE: file },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out acquiring the Windows rollout lock.')), 5000);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.stdout.on('data', chunk => {
      if (!String(chunk).includes('LOCKED')) return;
      clearTimeout(timer);
      resolve();
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Windows rollout lock helper exited with ${code}: ${stderr}`));
    });
  });
  return async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.stdin.end('\n');
    await exited;
  };
}

async function testProxyCapture(): Promise<void> {
  let upstreamHits = 0;
  let canceledAnthropicStreams = 0;
  const upstreamPaths: string[] = [];
  const upstreamBodies: Array<Record<string, any>> = [];
  const upstreamAuthorizations: Array<string | undefined> = [];
  const upstreamAnthropicVersions: Array<string | undefined> = [];
  const upstreamWebSocketFrames: Array<Record<string, any>> = [];
  const upstreamWebSocketServer = new WebSocketServer({ noServer: true });
  upstreamWebSocketServer.on('headers', headers => {
    headers.push('x-codex-turn-state: qa-turn-state');
    headers.push('x-reasoning-included: true');
    headers.push('openai-model: gpt-native-routed');
  });
  const upstream = http.createServer(async (request, response) => {
    upstreamHits += 1;
    upstreamPaths.push(request.url || '');
    upstreamAuthorizations.push(typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined);
    upstreamAnthropicVersions.push(typeof request.headers['anthropic-version'] === 'string' ? request.headers['anthropic-version'] : undefined);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    try { upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { upstreamBodies.push({}); }
    const body = upstreamBodies.at(-1) ?? {};
    if (((request.url || '').split('?')[0]).endsWith('/anthropic/v1/messages')) {
      const event = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
      if (JSON.stringify(body.messages).includes('2xx error envelope')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', message: '兼容服务 envelope failure' }
        }));
        return;
      }
      if (body.stream === true) {
        const cancellationCase = JSON.stringify(body.messages).includes('cancel Claude stream');
        if (cancellationCase) {
          response.on('close', () => {
            if (!response.writableEnded) canceledAnthropicStreams += 1;
          });
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(event('message_start', {
          type: 'message_start',
          message: { id: 'msg_gateway', model: body.model, content: [], usage: { input_tokens: 2, cache_read_input_tokens: 8, output_tokens: 0 } }
        }));
        response.write(event('content_block_start', {
          type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' }
        }));
        response.write(event('content_block_delta', {
          type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'claude gateway ok' }
        }));
        if (JSON.stringify(body.messages).includes('force abrupt stream')) {
          setTimeout(() => response.destroy(new Error('forced upstream disconnect')), 10);
          return;
        }
        // Keep the cancellation fixture open long enough that the client's
        // AbortController, rather than the normal 25 ms completion timer, is
        // what closes the upstream response. On a busy Windows runner fetch()
        // can otherwise observe the first buffered chunk only after the short
        // timer has already completed the stream, making this cancellation
        // assertion race with a healthy response.
        setTimeout(() => {
          if (response.destroyed) return;
          response.write(event('content_block_stop', { type: 'content_block_stop', index: 0 }));
          response.write(event('message_delta', {
            type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 }
          }));
          response.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}`);
        }, cancellationCase ? 1_000 : 25);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'msg_gateway',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: 'claude gateway ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 2, output_tokens: 4 }
      }));
      return;
    }
    if (body.input === 'headerless official title stream') {
      const titleText = '{"title":"修复 Trace 标题回复","description":"无 Content-Type 的官方 Responses 流"}';
      const event = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
      response.writeHead(200);
      response.end(
        event('response.output_text.done', {
          type: 'response.output_text.done',
          text: titleText
        })
        + event('response.completed', {
          type: 'response.completed',
          response: {
            id: 'resp_headerless_title',
            object: 'response',
            status: 'completed',
            model: body.model,
            output: [],
            usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 }
          }
        })
      );
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    if ((request.url || '').endsWith('/v1/responses') && String(body.instructions).includes('CONTEXT CHECKPOINT COMPACTION')) {
      response.end(JSON.stringify({
        id: 'resp_qa', object: 'response', status: 'completed', model: body.model,
        output: [{ id: 'msg_qa', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'responses summary' }] }],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }
      }));
      return;
    }
    response.end(JSON.stringify({ id: 'qa', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
  });
  upstream.on('upgrade', (request, socket, head) => {
    if (request.url !== '/official/v1/responses') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    upstreamWebSocketServer.handleUpgrade(request, socket, head, webSocket => {
      upstreamWebSocketServer.emit('connection', webSocket, request);
    });
  });
  upstreamWebSocketServer.on('connection', webSocket => {
    webSocket.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, any>;
      upstreamWebSocketFrames.push(frame);
      const responseIndex = upstreamWebSocketFrames.length;
      const responseId = `resp_ws_${responseIndex}`;
      const outputItem = responseIndex === 1
        ? {
            id: 'fc_ws_1',
            type: 'function_call',
            call_id: 'call_ws_incremental',
            name: 'shell',
            arguments: '{"command":"pwd"}',
            status: 'completed'
          }
        : {
            id: `msg_${responseId}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: `websocket reply ${responseIndex}` }]
          };
      webSocket.send(JSON.stringify({
        type: 'response.created',
        response: {
          id: responseId,
          object: 'response',
          status: 'in_progress',
          model: frame.model,
          output: []
        }
      }));
      webSocket.send(JSON.stringify({
        type: 'response.output_item.done',
        output_index: 0,
        item: outputItem
      }));
      webSocket.send(JSON.stringify({
        type: 'response.completed',
        response: {
          id: responseId,
          object: 'response',
          status: 'completed',
          model: frame.model,
          output: [outputItem],
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 }
        }
      }));
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert(address && typeof address === 'object');
  const store = new TraceStore(path.join(root, 'trace'));
  const proxy = new TapProxy(store, [0]);
  proxy.setRoutes([], `http://127.0.0.1:${address.port}`);
  const proxyUrl = await proxy.start();
  try {
    const proxyAddress = new URL(proxyUrl);
    const upgradeResponse = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(Number(proxyAddress.port), proxyAddress.hostname);
      let received = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => {
        socket.write([
          'GET /v1/responses HTTP/1.1',
          `Host: ${proxyAddress.host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          '',
          ''
        ].join('\r\n'));
      });
      socket.on('data', chunk => { received += chunk; });
      socket.on('end', () => resolve(received));
      socket.on('error', reject);
    });
    assert.match(upgradeResponse, /^HTTP\/1\.1 426 Upgrade Required/m);
    assert.match(upgradeResponse, /HTTP\/SSE/);

    proxy.setClientRoutes([{
      source: 'codex-cli',
      path: '/v1/responses',
      apiType: 'responses',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/official`,
      defaultProtocol: 'responses',
      webSocket: 'official-responses'
    }]);
    const proxyWebSocketUrl = `${proxyUrl.replace(/^http/, 'ws')}/v1/responses`;
    let clientWebSocketUpgradeHeaders: http.IncomingHttpHeaders = {};
    const clientWebSocket = await new Promise<WebSocket>((resolve, reject) => {
      const webSocket = new WebSocket(proxyWebSocketUrl, {
        headers: {
          'user-agent': 'codex-cli/qa',
          originator: 'codex-tui',
          'content-type': 'application/json'
        }
      });
      webSocket.once('upgrade', response => {
        clientWebSocketUpgradeHeaders = response.headers;
      });
      webSocket.once('open', () => resolve(webSocket));
      webSocket.once('error', reject);
    });
    assert.equal(clientWebSocketUpgradeHeaders['x-codex-turn-state'], 'qa-turn-state');
    assert.equal(clientWebSocketUpgradeHeaders['x-reasoning-included'], 'true');
    assert.equal(clientWebSocketUpgradeHeaders['openai-model'], 'gpt-native-routed');
    const receiveWebSocketResponse = (): Promise<Record<string, any>[]> => new Promise((resolve, reject) => {
      const events: Record<string, any>[] = [];
      const onMessage = (data: RawData) => {
        const event = JSON.parse(data.toString()) as Record<string, any>;
        events.push(event);
        if (event.type === 'response.completed') {
          cleanup();
          resolve(events);
        }
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clientWebSocket.off('message', onMessage);
        clientWebSocket.off('error', onError);
      };
      clientWebSocket.on('message', onMessage);
      clientWebSocket.on('error', onError);
    });
    const firstWebSocketResponse = receiveWebSocketResponse();
    clientWebSocket.send(JSON.stringify({
      type: 'response.create',
      model: 'gpt-native',
      instructions: 'official websocket',
      input: [{ type: 'message', role: 'user', content: 'full websocket request' }],
      tools: [],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: { effort: 'medium' },
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content']
    }));
    const firstWebSocketEvents = await firstWebSocketResponse;
    assert.equal(firstWebSocketEvents.at(-1)?.response?.id, 'resp_ws_1');

    const secondWebSocketResponse = receiveWebSocketResponse();
    clientWebSocket.send(JSON.stringify({
      type: 'response.create',
      model: 'gpt-native',
      instructions: 'official websocket',
      previous_response_id: 'resp_ws_1',
      input: [{
        type: 'function_call_output',
        call_id: 'call_ws_incremental',
        output: 'incremental tool result'
      }],
      tools: [],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: { effort: 'medium' },
      store: false,
      stream: true,
      include: ['reasoning.encrypted_content']
    }));
    const secondWebSocketEvents = await secondWebSocketResponse;
    assert.equal(secondWebSocketEvents.at(-1)?.response?.id, 'resp_ws_2');
    assert.equal(upstreamWebSocketFrames.length, 2);
    assert.equal(upstreamWebSocketFrames[1]?.previous_response_id, 'resp_ws_1');
    assert.equal(upstreamWebSocketFrames[1]?.input?.length, 1,
      'official WebSocket continuation must preserve Codex incremental input');
    assert.equal(upstreamWebSocketFrames[1]?.input?.[0]?.type, 'function_call_output');
    clientWebSocket.close();

    let latestWebSocketTrace = await store.latestTrace();
    for (let attempt = 0;
      (latestWebSocketTrace?.request.method !== 'WS'
        || (latestWebSocketTrace?.request.body as any)?.previous_response_id !== 'resp_ws_1')
        && attempt < 80;
      attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
      latestWebSocketTrace = await store.latestTrace();
    }
    assert.equal(latestWebSocketTrace?.request.method, 'WS');
    assert.equal((latestWebSocketTrace?.request.body as any)?.previous_response_id, 'resp_ws_1');
    assert.equal((latestWebSocketTrace?.request.body as any)?.input?.length, 1);
    assert.match(JSON.stringify(latestWebSocketTrace?.sse.snapshot?.content), /websocket reply 2/);

    await proxy.markCodexProviderTransition('official', 'compatible');
    proxy.setClientRoutes([{
      source: 'codex-cli',
      path: '/v1/responses',
      apiType: 'responses',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      transform: 'responses-to-chat-auto',
      modelProtocols: { 'deepseek-chat': 'chat-completions' },
      compatibleServiceGateway: true
    }]);
    const switchedCompatibleServiceResponse = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        previous_response_id: 'resp_ws_2',
        input: [{ type: 'message', role: 'user', content: 'continue after official websocket' }]
      })
    });
    assert.equal(switchedCompatibleServiceResponse.status, 200);
    await switchedCompatibleServiceResponse.text();
    const switchedCompatibleServiceBody = upstreamBodies.at(-1);
    const switchedCompatibleServiceMessages = JSON.stringify(switchedCompatibleServiceBody?.messages);
    assert.doesNotMatch(JSON.stringify(switchedCompatibleServiceBody), /previous_response_id/);
    assert.match(switchedCompatibleServiceMessages, /full websocket request/);
    assert.match(switchedCompatibleServiceMessages, /call_ws_incremental/);
    assert.match(switchedCompatibleServiceMessages, /incremental tool result/);
    assert.match(switchedCompatibleServiceMessages, /websocket reply 2/);
    assert.match(switchedCompatibleServiceMessages, /continue after official websocket/);

    const compatibleServiceUpgradeStatus = await new Promise<number>((resolve, reject) => {
      const webSocket = new WebSocket(proxyWebSocketUrl, {
        headers: { 'user-agent': 'codex-cli/qa', originator: 'codex-tui' }
      });
      webSocket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
      webSocket.once('open', () => reject(new Error('兼容服务 WebSocket route must not open')));
      webSocket.once('error', error => {
        if ((error as Error).message.includes('Unexpected server response')) return;
        reject(error);
      });
    });
    assert.equal(compatibleServiceUpgradeStatus, 426);
    await store.clearAll();
    upstreamHits = 0;
    upstreamPaths.length = 0;
    upstreamBodies.length = 0;
    upstreamAuthorizations.length = 0;
    upstreamAnthropicVersions.length = 0;

    proxy.setClientRoutes([{
      source: 'codex-cli',
      path: '/v1/responses',
      apiType: 'responses',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/api/v3`,
      stripPathPrefix: '/v1',
      defaultProtocol: 'responses',
      compatibleServiceGateway: true,
      capture: false,
      upstreamBearerToken: 'ark-placeholder-key'
    }]);
    const arkResponses = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/ark-qa' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-260425',
        stream: true,
        tools: [{ type: 'web_search', max_keyword: 3 }],
        input: [{
          role: 'user',
          content: [{ type: 'input_text', text: '今天有什么热点新闻' }]
        }]
      })
    });
    assert.equal(arkResponses.status, 200);
    await arkResponses.text();
    assert.equal(upstreamPaths.at(-1), '/api/v3/responses');
    assert.equal(upstreamAuthorizations.at(-1), 'Bearer ark-placeholder-key');
    assert.deepEqual(upstreamBodies.at(-1)?.tools, [{ type: 'web_search', max_keyword: 3 }],
      'Ark Responses web_search declaration must pass through unchanged');
    assert.equal(upstreamBodies.at(-1)?.stream, true);

    proxy.setClientRoutes([{
      source: 'codex-cli',
      path: '/v1/responses',
      apiType: 'responses',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/api/v3`,
      stripPathPrefix: '/v1',
      transform: 'responses-to-chat-auto',
      modelProtocols: { 'doubao-seed-2-1-turbo-260628': 'chat-completions' },
      compatibleServiceGateway: true,
      capture: false,
      upstreamBearerToken: 'ark-placeholder-key'
    }]);
    const arkChat = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/ark-qa' },
      body: JSON.stringify({
        model: 'doubao-seed-2-1-turbo-260628',
        stream: false,
        input: [{
          role: 'user',
          content: [{
            type: 'input_image',
            image_url: 'https://ark-project.example.test/images/view.jpeg'
          }, {
            type: 'input_text',
            text: '图片主要讲了什么?'
          }]
        }]
      })
    });
    assert.equal(arkChat.status, 200);
    await arkChat.text();
    assert.equal(upstreamPaths.at(-1), '/api/v3/chat/completions');
    assert.deepEqual(upstreamBodies.at(-1)?.messages?.[0]?.content, [{
      type: 'image_url',
      image_url: { url: 'https://ark-project.example.test/images/view.jpeg' }
    }, {
      type: 'text',
      text: '图片主要讲了什么?'
    }], 'Ark Chat Completions multimodal content must retain image_url and text parts');

    proxy.setClientRoutes([{
      source: 'codex-cli',
      path: '/v1/chat/completions',
      apiType: 'chat-completions',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/api/v3`,
      stripPathPrefix: '/v1',
      compatibleServiceGateway: true,
      capture: false,
      upstreamBearerToken: 'ark-placeholder-key'
    }]);
    const directArkChatBody = {
      model: 'doubao-seed-2-1-turbo-260628',
      messages: [{
        content: [{
          image_url: { url: 'https://ark-project.example.test/images/view.jpeg' },
          type: 'image_url'
        }, {
          text: '图片主要讲了什么?',
          type: 'text'
        }],
        role: 'user'
      }]
    };
    const directArkChat = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/ark-qa' },
      body: JSON.stringify(directArkChatBody)
    });
    assert.equal(directArkChat.status, 200);
    await directArkChat.text();
    assert.equal(upstreamPaths.at(-1), '/api/v3/chat/completions');
    assert.deepEqual(upstreamBodies.at(-1), directArkChatBody,
      'an existing Chat Completions request must pass through to Ark without shape changes');

    proxy.setClientRoutes([]);
    upstreamHits = 0;
    upstreamPaths.length = 0;
    upstreamBodies.length = 0;
    upstreamAuthorizations.length = 0;
    upstreamAnthropicVersions.length = 0;

    const denied = await fetch(`${proxyUrl}/not-allowed`, { method: 'POST' });
    assert.equal(denied.status, 404);
    const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer qa-secret', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({ model: 'qa-model', messages: [{ role: 'user', content: 'hello' }] })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { choices: unknown[] }).choices.length, 1);
    assert.equal(upstreamHits, 1);
    proxy.setClientRoutes([{
      source: 'codex-cli',
      path: '/backend-api/codex/responses',
      apiType: 'responses',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/backend-api`,
      stripPathPrefix: '/backend-api'
    }]);
    const chatgptResponse = await fetch(`${proxyUrl}/backend-api/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer qa-secret', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({
        model: 'qa-model',
        input: 'hello',
        tools: [{ type: 'namespace', name: 'image_gen', tools: [] }]
      })
    });
    assert.equal(chatgptResponse.status, 200);
    assert.equal(upstreamPaths.at(-1), '/backend-api/codex/responses');
    assert.equal(upstreamBodies.at(-1)?.tools?.[0]?.name, 'image_gen', 'routes without an exclusion must preserve the namespace');
    assert.equal(upstreamHits, 2);

    const headerlessTitleResponse = await fetch(`${proxyUrl}/backend-api/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer qa-secret', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({
        model: 'gpt-headerless-title',
        stream: true,
        input: 'headerless official title stream',
        text: {
          format: {
            type: 'json_schema',
            name: 'codex_output_schema',
            schema: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                description: { type: 'string' }
              }
            }
          }
        }
      })
    });
    const headerlessTitleText = await headerlessTitleResponse.text();
    assert.equal(
      headerlessTitleResponse.status,
      200,
      `headerless title status=${headerlessTitleResponse.status} body=${headerlessTitleText}`
    );
    assert.match(headerlessTitleText, /修复 Trace 标题回复/);

    let storedHeaderlessTitle: TapTraceRecord | undefined;
    for (let attempt = 0; !storedHeaderlessTitle && attempt < 40; attempt += 1) {
      const summaries = await store.listSessions();
      for (const summary of summaries) {
        const lines = (await fs.readFile(summary.jsonlPath, 'utf8')).trim().split(/\r?\n/);
        storedHeaderlessTitle = lines
          .map(line => JSON.parse(line) as TapTraceRecord)
          .find(trace => trace.request.model === 'gpt-headerless-title');
        if (storedHeaderlessTitle) break;
      }
      if (!storedHeaderlessTitle) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert(storedHeaderlessTitle);
    assert.equal(storedHeaderlessTitle.auxiliary, 'title');
    assert.ok(storedHeaderlessTitle.sse.events.length > 0, 'headerless official SSE must be captured as events');
    assert.match(
      storedHeaderlessTitle.sse.snapshot?.content.find(block => block.type === 'text')?.text ?? '',
      /修复 Trace 标题回复/
    );

    const legacyStore = new TraceStore(path.join(root, 'trace-headerless-legacy'));
    await legacyStore.appendTrace({
      ...storedHeaderlessTitle,
      id: 'legacy-headerless-title',
      sessionId: undefined,
      turn: undefined,
      response: {
        ...storedHeaderlessTitle.response,
        snapshot: { apiType: 'responses', content: [] }
      },
      sse: { events: [] },
      usage: undefined
    });
    const hydratedLegacyPage = await legacyStore.readSessionPage();
    assert.match(
      hydratedLegacyPage?.traces[0]?.sse.snapshot?.content.find(block => block.type === 'text')?.text ?? '',
      /修复 Trace 标题回复/,
      'viewer reads must reconstruct already-saved headerless SSE without rewriting JSONL'
    );
    const repairedLegacySummary = (await legacyStore.listSessions())[0];
    assert.match(
      repairedLegacySummary?.title ?? '',
      /Trace/,
      'legacy SSE title recovery must backfill the session summary used by the dashboard'
    );

    const oversizedTraceRoot = path.join(root, 'trace-byte-aware-pages');
    const oversizedStore = new TraceStore(oversizedTraceRoot);
    const oversizedPayload = 'x'.repeat(12 * 1024 * 1024);
    for (let index = 0; index < 5; index += 1) {
      await oversizedStore.appendTrace({
        ...storedHeaderlessTitle,
        id: `oversized-${index}`,
        sessionId: undefined,
        turn: undefined,
        request: {
          ...storedHeaderlessTitle.request,
          body: { payload: oversizedPayload, index }
        }
      });
    }
    const oversizedTailPage = await oversizedStore.readSessionPage(undefined, { limit: 160 });
    assert(oversizedTailPage);
    assert.equal(oversizedTailPage.limit, 1, 'large trace pages must be reduced by the byte budget');
    assert.equal(oversizedTailPage.traces.length, 1);
    assert.equal(oversizedTailPage.offset, 4, 'the first large-history page must still open at the newest trace');
    assert.equal(oversizedTailPage.hasMoreBefore, true);
    const oversizedPreviousPage = await oversizedStore.readSessionPage(undefined, { offset: 3, limit: 160 });
    assert.equal(oversizedPreviousPage?.limit, 1);
    assert.equal(oversizedPreviousPage?.traces[0]?.id, 'oversized-3', 'backward paging must return the adjacent trace');

    proxy.setClientRoutes([{
      source: 'codex-cli',
      path: '/v1/responses',
      apiType: 'responses',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      transform: 'responses-to-chat'
    }]);
    const bridged = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer qa-secret', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({ model: 'qa-model', instructions: 'be useful', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] })
    });
    assert.equal(bridged.status, 200);
    const bridgedBody = await bridged.json() as { object: string; output: Array<{ content: Array<{ text: string }> }> };
    assert.equal(bridgedBody.object, 'response');
    assert.equal(bridgedBody.output[0].content[0].text, 'ok');
    assert.equal(upstreamPaths.at(-1), '/v1/chat/completions');
    assert.equal(upstreamHits, 4);
    proxy.setClientRoutes([{
      source: 'codex-cli',
      path: '/v1/responses',
      apiType: 'responses',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      transform: 'responses-to-chat-auto',
      capture: false
    }]);
    const autoChat = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({ model: 'deepseek-chat', input: 'auto bridge' })
    });
    assert.equal(autoChat.status, 200);
    await autoChat.text();
    assert.equal(upstreamPaths.at(-1), '/v1/chat/completions', 'non-GPT models use the Completion bridge per request');
    proxy.setClientRoutes([{
      source: 'codex-cli',
      path: '/v1/responses',
      apiType: 'responses',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      transform: 'responses-to-chat-auto',
      excludedToolNamespaces: ['image_gen']
    }]);
    const autoResponses = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        input: 'responses passthrough',
        tools: [
          { type: 'namespace', name: 'image_gen', tools: [{ type: 'function', name: 'generate', parameters: { type: 'object' } }] },
          { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object' } }] },
          { type: 'function', name: 'imagegen', parameters: { type: 'object' } }
        ]
      })
    });
    assert.equal(autoResponses.status, 200);
    await autoResponses.text();
    assert.equal(upstreamPaths.at(-1), '/v1/responses', 'GPT models stay on Responses without changing XwX settings');
    assert.deepEqual(
      upstreamBodies.at(-1)?.tools?.map((tool: Record<string, unknown>) => `${tool.type}:${tool.name}`),
      ['namespace:multi_agent_v1', 'function:imagegen'],
      'Responses forwarding removes only the configured colliding namespace'
    );
    let namespaceTrace = await store.latestTrace();
    for (let attempt = 0; namespaceTrace?.request.model !== 'gpt-5.5' && attempt < 40; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
      namespaceTrace = await store.latestTrace();
    }
    const tracedTools = ((namespaceTrace?.request.body as Record<string, any> | undefined)?.tools ?? []) as Array<Record<string, unknown>>;
    assert.ok(
      tracedTools.some(tool => tool.type === 'namespace' && tool.name === 'image_gen'),
      'Trace keeps the original client request for diagnostics'
    );
    assert.equal(upstreamHits, 6);

    proxy.setClientRoutes([{
      source: 'codex-cli',
      path: '/v1/responses/compact',
      apiType: 'responses',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      transform: 'responses-compact-auto',
      modelProtocols: { 'deepseek-chat': 'chat-completions' }
    }, {
      source: 'codex-cli',
      path: '/v1/responses',
      apiType: 'responses',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      transform: 'responses-to-chat-auto',
      modelProtocols: { 'deepseek-chat': 'chat-completions' },
      capture: false
    }]);
    const compactV1Response = await fetch(`${proxyUrl}/v1/responses/compact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'compact me' }] }]
      })
    });
    assert.equal(compactV1Response.status, 200);
    const compactV1Body = await compactV1Response.json() as { object: string; output: unknown[] };
    assert.equal(compactV1Body.object, 'response.compaction');
    assert.match(JSON.stringify(compactV1Body.output), /compact me/);
    assert.match(JSON.stringify(compactV1Body.output), /ok/);
    assert.equal(upstreamPaths.at(-1), '/v1/chat/completions');
    assert.equal(upstreamBodies.at(-1)?.stream, false);
    assert.equal(upstreamBodies.at(-1)?.tools, undefined);
    assert.match(JSON.stringify(upstreamBodies.at(-1)?.messages), /CONTEXT CHECKPOINT COMPACTION/);
    let compactTrace = await store.latestTrace();
    for (let attempt = 0; compactTrace?.request.path !== '/v1/responses/compact' && attempt < 40; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
      compactTrace = await store.latestTrace();
    }
    assert.equal(compactTrace?.request.path, '/v1/responses/compact');
    assert.equal(compactTrace?.compact, true);
    const compactMissingHistory = await fetch(`${proxyUrl}/v1/responses/compact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({ model: 'deepseek-chat', previous_response_id: 'resp_missing', input: [] })
    });
    assert.equal(compactMissingHistory.status, 400);
    assert.match(await compactMissingHistory.text(), /cannot resolve previous_response_id/);
    assert.equal(upstreamHits, 7, 'invalid Chat-only compact must fail before contacting upstream');

    proxy.setClientRoutes([{
      source: 'codex-cli',
      path: '/v1/responses/compact',
      apiType: 'responses',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      transform: 'responses-compact-auto',
      modelProtocols: { 'gpt-routed': 'responses', 'deepseek-chat': 'chat-completions' },
      capture: false
    }, {
      source: 'codex-cli',
      path: '/v1/responses',
      apiType: 'responses',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      transform: 'responses-to-chat-auto',
      modelProtocols: { 'deepseek-chat': 'chat-completions' },
      capture: false
    }]);
    const responsesCompact = await fetch(`${proxyUrl}/v1/responses/compact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({ model: 'gpt-routed', input: 'compact through responses' })
    });
    assert.equal(responsesCompact.status, 200);
    const responsesCompactBody = await responsesCompact.json() as { output: unknown[] };
    assert.match(JSON.stringify(responsesCompactBody.output), /responses summary/);
    assert.equal(upstreamPaths.at(-1), '/v1/responses', 'Responses model without native compact uses a normal summarizer turn');

    const compactV2Response = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        stream: true,
        input: [{ type: 'message', role: 'user', content: 'long task' }, { type: 'compaction_trigger' }]
      })
    });
    assert.equal(compactV2Response.status, 200);
    const compactV2Text = await compactV2Response.text();
    const completedFrame = compactV2Text.split(/\r?\n\r?\n/).find(block => block.startsWith('event: response.completed'));
    assert(completedFrame);
    const completedData = JSON.parse(completedFrame.split(/\r?\n/).find(line => line.startsWith('data: '))!.slice(6));
    assert.equal(completedData.response.output.length, 1, 'remote compact must produce exactly one output item');
    assert.equal(completedData.response.output[0].type, 'compaction');
    const compactEnvelope = completedData.response.output[0].encrypted_content as string;
    assert.equal(decodeCompactionSummary(compactEnvelope), 'ok');

    const replayResponse = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({ model: 'deepseek-chat', input: [{ type: 'compaction', encrypted_content: compactEnvelope }] })
    });
    assert.equal(replayResponse.status, 200);
    await replayResponse.text();
    assert.match(JSON.stringify(upstreamBodies.at(-1)?.messages), /Continue from this summary/);

    proxy.setClientRoutes([{
      source: 'codex-cli',
      path: '/v1/responses/compact',
      apiType: 'responses',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      transform: 'responses-compact-auto',
      modelProtocols: { 'gpt-native': 'responses' },
      modelSupportsCompact: { 'gpt-native': true },
      excludedToolNamespaces: ['image_gen'],
      capture: false
    }]);
    const nativeCompact = await fetch(`${proxyUrl}/v1/responses/compact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({
        model: 'gpt-native',
        input: 'native compact',
        tools: [
          { type: 'namespace', name: 'image_gen', tools: [] },
          { type: 'namespace', name: 'multi_agent_v1', tools: [] }
        ]
      })
    });
    assert.equal(nativeCompact.status, 200);
    await nativeCompact.text();
    assert.equal(upstreamPaths.at(-1), '/v1/responses/compact', 'native compact is only passed through when explicitly advertised');
    assert.deepEqual(
      upstreamBodies.at(-1)?.tools?.map((tool: Record<string, unknown>) => tool.name),
      ['multi_agent_v1'],
      'native compact applies the same Responses namespace exclusion'
    );
    assert.equal(upstreamHits, 11);

    proxy.setClientRoutes([{
      source: 'codex-cli',
      path: '/v1/responses',
      apiType: 'responses',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/old`
    }]);
    const slowBody = JSON.stringify({ model: 'qa-model', input: 'slow upload' });
    const slowResponse = new Promise<number>((resolve, reject) => {
      const request = http.request(`${proxyUrl}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(slowBody),
          'user-agent': 'codex-cli/qa'
        }
      }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      });
      request.on('error', reject);
      request.write(slowBody.slice(0, 8));
      setTimeout(() => {
        proxy.setClientRoutes([{
          source: 'codex-cli',
          path: '/v1/responses',
          apiType: 'responses',
          upstreamBaseUrl: `http://127.0.0.1:${address.port}/new`
        }]);
        request.end(slowBody.slice(8));
      }, 30);
    });
    assert.equal(await slowResponse, 200);
    assert.equal(upstreamPaths.at(-1), '/old/v1/responses', 'an accepted request must stay on its original upstream');
    assert.equal(upstreamHits, 12);
    let latest = await store.latestTrace();
    for (let attempt = 0; latest?.request.model !== 'qa-model' && attempt < 40; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
      latest = await store.latestTrace();
    }
    assert(latest);
    assert.equal(latest.request.model, 'qa-model');
    assert.equal(latest.response.statusCode, 200);
    assert.equal(typeof latest.xwxContext?.estimatedTokens, 'number');
    assert.equal(Object.prototype.hasOwnProperty.call(latest, 'context'), false);
    assert.equal(JSON.stringify(latest).includes('qa-secret'), false);
    const summaries = await store.listSessions();
    assert.ok(summaries.every(summary => summary.dailyUsageComplete === true));
    const dailyTokens = summaries.reduce(
      (total, summary) => total + Object.values(summary.dailyUsage || {}).reduce((sum, day) => sum + day.tokens, 0),
      0
    );
    assert.equal(dailyTokens, 42);
    assert.ok(summaries.some(summary => summary.recentRatePoints?.at(-1)?.tokens === 5));

    proxy.setClientRoutes([{
      source: 'codex-cli',
      path: '/v1/responses',
      apiType: 'responses',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      transform: 'responses-to-chat-auto',
      modelProtocols: { 'claude-sonnet-4-5': 'anthropic-messages' },
      modelMaxOutputTokens: { 'claude-sonnet-4-5': 32_000 },
      upstreamBearerToken: 'compatible-gateway-key'
    }]);
    const claudeGateway = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer client-login-must-not-leak',
        'user-agent': 'codex-cli/qa'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        stream: true,
        instructions: 'gateway instructions',
        reasoning: { effort: 'medium' },
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'use Claude' }] }],
        tools: [{ type: 'function', name: 'shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } }]
      })
    });
    assert.equal(claudeGateway.status, 200);
    assert.match(claudeGateway.headers.get('content-type') ?? '', /text\/event-stream/);
    const claudeReader = claudeGateway.body!.getReader();
    const firstClaudeChunk = await claudeReader.read();
    assert.equal(firstClaudeChunk.done, false);
    const decoder = new TextDecoder();
    let claudeGatewayText = decoder.decode(firstClaudeChunk.value, { stream: true });
    assert.match(claudeGatewayText, /response\.created/, 'Anthropic SSE must reach Codex before message_stop');
    while (true) {
      const chunk = await claudeReader.read();
      if (chunk.done) break;
      claudeGatewayText += decoder.decode(chunk.value, { stream: true });
    }
    claudeGatewayText += decoder.decode();
    assert.match(claudeGatewayText, /claude gateway ok/);
    assert.match(claudeGatewayText, /response\.completed/);
    assert.equal(upstreamPaths.at(-1), '/anthropic/v1/messages');
    assert.equal(upstreamAuthorizations.at(-1), 'Bearer compatible-gateway-key');
    assert.equal(upstreamAnthropicVersions.at(-1), '2023-06-01');
    assert.equal(upstreamBodies.at(-1)?.model, 'claude-sonnet-4-5');
    assert.equal(upstreamBodies.at(-1)?.max_tokens, 32_000);
    assert.deepEqual(upstreamBodies.at(-1)?.thinking, { type: 'enabled', budget_tokens: 8_192 });
    assert.ok((JSON.stringify(upstreamBodies.at(-1)).match(/"cache_control"/g) ?? []).length <= 4);
    let claudeTrace = await store.latestTrace();
    for (let attempt = 0; claudeTrace?.request.model !== 'claude-sonnet-4-5' && attempt < 40; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
      claudeTrace = await store.latestTrace();
    }
    assert.equal(claudeTrace?.protocol, 'anthropic-messages');
    assert.match(JSON.stringify(claudeTrace?.response.snapshot?.content), /claude gateway ok/);
    assert.equal(
      claudeTrace?.request.headers.authorization,
      '<redacted>',
      'persisted Trace headers must not retain any bearer-token prefix'
    );
    assert.doesNotMatch(
      JSON.stringify(claudeTrace),
      /client-login-must-not-leak|Bearer client-/,
      'persisted Trace data must not contain the original client credential'
    );

    const switchRoute = {
      source: 'codex-cli' as const,
      path: '/v1/responses',
      apiType: 'responses' as const,
      upstreamBaseUrl: `http://127.0.0.1:${address.port}`,
      transform: 'responses-to-chat-auto' as const,
      modelProtocols: {
        'gpt-native': 'responses' as const,
        'deepseek-chat': 'chat-completions' as const,
        'claude-sonnet-4-5': 'anthropic-messages' as const
      },
      modelMaxOutputTokens: { 'claude-sonnet-4-5': 32_000 },
      upstreamBearerToken: 'compatible-gateway-key'
    };
    proxy.setClientRoutes([switchRoute]);
    for (const [switchModel, expectedPath] of [
      ['gpt-native', '/v1/responses'],
      ['claude-sonnet-4-5', '/anthropic/v1/messages'],
      ['deepseek-chat', '/v1/chat/completions'],
      ['claude-sonnet-4-5', '/anthropic/v1/messages']
    ] as const) {
      const switched = await fetch(`${proxyUrl}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
        body: JSON.stringify({ model: switchModel, input: `hot switch ${switchModel}` })
      });
      assert.equal(switched.status, 200);
      await switched.text();
      assert.equal(upstreamPaths.at(-1), expectedPath);
    }

    const beforeInvalidTool = upstreamHits;
    const invalidTool = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        input: [{ type: 'function_call', call_id: 'call_broken', name: 'shell', arguments: '{"command":' }],
        tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }]
      })
    });
    assert.equal(invalidTool.status, 400);
    assert.match(await invalidTool.text(), /complete JSON object/);
    assert.equal(upstreamHits, beforeInvalidTool, 'invalid request tool JSON must fail before upstream');

    const errorEnvelope = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', input: '2xx error envelope' })
    });
    assert.equal(errorEnvelope.status, 502);
    assert.match(await errorEnvelope.text(), /兼容服务 envelope failure/);

    const cancellation = new AbortController();
    const cancelResponse = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', stream: true, input: 'cancel Claude stream' }),
      signal: cancellation.signal
    });
    const cancelReader = cancelResponse.body!.getReader();
    const cancelFirst = await cancelReader.read();
    assert.equal(cancelFirst.done, false);
    cancellation.abort();
    await assert.rejects(cancelReader.read(), /abort/i);
    for (let attempt = 0; canceledAnthropicStreams === 0 && attempt < 40; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(canceledAnthropicStreams, 1, 'client cancellation must close the Anthropic upstream stream');

    proxy.setClientRoutes([{
      source: 'codex-cli',
      path: '/v1/responses/compact',
      apiType: 'responses',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      transform: 'responses-compact-auto',
      modelProtocols: { 'claude-sonnet-4-5': 'anthropic-messages' },
      modelMaxOutputTokens: { 'claude-sonnet-4-5': 32_000 },
      upstreamBearerToken: 'compatible-gateway-key'
    }, {
      source: 'codex-cli',
      path: '/v1/responses',
      apiType: 'responses',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      transform: 'responses-to-chat-auto',
      modelProtocols: { 'claude-sonnet-4-5': 'anthropic-messages' },
      modelMaxOutputTokens: { 'claude-sonnet-4-5': 32_000 },
      upstreamBearerToken: 'compatible-gateway-key'
    }]);
    const claudeCompactResponse = await fetch(`${proxyUrl}/v1/responses/compact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', input: 'compact Claude history' })
    });
    assert.equal(claudeCompactResponse.status, 200);
    const claudeCompact = await claudeCompactResponse.json() as any;
    assert.equal(claudeCompact.object, 'response.compaction');
    assert.equal(upstreamPaths.at(-1), '/anthropic/v1/messages');
    assert.match(JSON.stringify(upstreamBodies.at(-1)?.system), /CONTEXT CHECKPOINT COMPACTION/);
    const claudeReplayResponse = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        input: claudeCompact.output
      })
    });
    assert.equal(claudeReplayResponse.status, 200);
    await claudeReplayResponse.text();
    assert.match(JSON.stringify(upstreamBodies.at(-1)?.messages), /Continue from this summary/);

    const abruptClaude = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        stream: true,
        input: 'force abrupt stream'
      })
    });
    assert.equal(abruptClaude.status, 200);
    const abruptClaudeText = await abruptClaude.text();
    assert.match(abruptClaudeText, /response\.failed/);
    assert.match(abruptClaudeText, /upstream_stream_truncated/);

    const summariesBeforeDisable = await store.listSessions();
    const traceCountBeforeDisable = summariesBeforeDisable.reduce((total, summary) => total + summary.traceCount, 0);
    proxy.setRecordingEnabled(false);
    const upstreamHitsBeforeDisable = upstreamHits;
    const unrecordedForward = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({ model: 'qa-model', input: 'forward without trace capture' })
    });
    assert.equal(unrecordedForward.status, 200);
    await unrecordedForward.text();
    assert.equal(upstreamHits, upstreamHitsBeforeDisable + 1, 'disabling Trace must not stop Gateway forwarding');

    proxy.setClientRoutes([]);
    proxy.setRoutes([], undefined);
    const unrecordedMissingRoute = await fetch(`${proxyUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({ model: 'qa-model', input: 'missing route without trace capture' })
    });
    assert.equal(unrecordedMissingRoute.status, 502);
    assert.match(await unrecordedMissingRoute.text(), /no upstream route/);
    assert.equal(upstreamHits, upstreamHitsBeforeDisable + 1, 'missing routes must fail locally without contacting upstream');
    const traceCountAfterDisable = (await store.listSessions())
      .reduce((total, summary) => total + summary.traceCount, 0);
    assert.equal(
      traceCountAfterDisable,
      traceCountBeforeDisable,
      'disabling Trace must suppress both successful and missing-route error capture'
    );
    proxy.setRecordingEnabled(true);
    await store.clearAll();
    assert.equal((await store.listSessions()).length, 0);

    // Native Claude Code hits `/v1/messages` (no `/anthropic` prefix) while the
    // gateway mounts Anthropic at `<root>/anthropic`. The upstream URL must keep
    // the `/anthropic` mount instead of collapsing to `<root>/v1/messages`, which
    // previously 404'd every native Claude turn.
    proxy.setClientRoutes([{
      source: 'claude-cli',
      path: '/v1/messages',
      apiType: 'messages',
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/anthropic`,
      upstreamBearerToken: 'compatible-gateway-key'
    }]);
    const nativeClaude = await fetch(`${proxyUrl}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'claude-cli/1.0' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'native claude ping' }]
      })
    });
    assert.equal(nativeClaude.status, 200, 'native Claude /v1/messages must not 404 through the gateway');
    assert.match(await nativeClaude.text(), /claude gateway ok/);
    assert.equal(upstreamPaths.at(-1), '/anthropic/v1/messages?beta=true');

    // A normally completed stream must stay error-free. The earlier shutdown
    // fixture separately covers a client closing before upstream EOF.
    const completedStream = await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'claude-cli/1.0' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'stream then close' }]
      })
    });
    assert.equal(completedStream.status, 200);
    assert.match(await completedStream.text(), /message_stop/);
    let completedTrace = await store.latestTrace();
    for (let attempt = 0; !completedTrace?.response.snapshot?.stopReason && attempt < 40; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
      completedTrace = await store.latestTrace();
    }
    assert.equal(completedTrace?.response.statusCode, 200);
    assert.equal(completedTrace?.error, undefined, 'a completed stream must not record an error');
    proxy.setClientRoutes([]);
    await store.clearAll();
    assert.equal((await store.listSessions()).length, 0);
  } finally {
    await proxy.stop();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
  completed.push('proxy forwarding, allowlist, capture and redaction');
}

async function testProxyPassthroughBackpressure(): Promise<void> {
  const chunk = Buffer.alloc(64 * 1024, 0x78);
  const totalChunks = 192;
  const streams = new Map<string, {
    produced: number;
    backpressure: number;
    finished: boolean;
    closedEarly: boolean;
  }>();
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain request body */ }
    const key = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('case') || 'unknown';
    const metric = { produced: 0, backpressure: 0, finished: false, closedEarly: false };
    streams.set(key, metric);
    res.on('close', () => {
      if (!res.writableEnded) metric.closedEarly = true;
    });
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(chunk.length * totalChunks)
    });
    const pump = (): void => {
      while (!res.destroyed && metric.produced < totalChunks) {
        metric.produced += 1;
        if (!res.write(chunk)) {
          metric.backpressure += 1;
          res.once('drain', pump);
          return;
        }
      }
      if (res.destroyed || metric.produced < totalChunks) return;
      metric.finished = true;
      res.end();
    };
    pump();
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', () => resolve());
  });
  const upstreamAddress = upstream.address();
  assert(upstreamAddress && typeof upstreamAddress === 'object');
  const proxy = new TapProxy(new TraceStore(path.join(root, 'trace-backpressure')), [0]);
  proxy.setRecordingEnabled(false);
  proxy.setClientRoutes([{
    source: 'codex-cli',
    path: '/v1/responses',
    apiType: 'responses',
    upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
    capture: false
  }]);
  const proxyUrl = await proxy.start();

  const openPausedResponse = (caseName: string): Promise<http.IncomingMessage> => new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'backpressure-smoke', input: caseName });
    const request = http.request(`${proxyUrl}/v1/responses?case=${caseName}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'user-agent': 'codex-cli/backpressure-smoke'
      }
    }, response => {
      response.pause();
      resolve(response);
    });
    request.once('error', reject);
    request.end(body);
  });

  const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };

  try {
    const completedResponse = await openPausedResponse('complete');
    const completedMetric = () => streams.get('complete');
    await waitFor(() => (completedMetric()?.backpressure ?? 0) > 0, 'upstream backpressure');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(completedMetric()?.finished, false,
      'a paused downstream must stop the passthrough branch from draining the full upstream body');
    let receivedBytes = 0;
    const completedBody = new Promise<void>((resolve, reject) => {
      completedResponse.on('data', part => { receivedBytes += Buffer.byteLength(part); });
      completedResponse.once('end', resolve);
      completedResponse.once('error', reject);
    });
    completedResponse.resume();
    await completedBody;
    assert.equal(receivedBytes, chunk.length * totalChunks,
      'resuming the downstream must deliver the upstream response byte-for-byte');
    assert.equal(completedMetric()?.finished, true);

    const disconnectedResponse = await openPausedResponse('disconnect');
    const disconnectedMetric = () => streams.get('disconnect');
    await waitFor(() => (disconnectedMetric()?.backpressure ?? 0) > 0, 'disconnect backpressure');
    disconnectedResponse.destroy();
    await waitFor(() => disconnectedMetric()?.closedEarly === true, 'upstream cancellation');
    await waitFor(() => proxy.activeRequestCount() === 0, 'proxy activity cleanup');
    assert.ok((disconnectedMetric()?.produced ?? totalChunks) < totalChunks,
      'disconnecting a paused downstream must stop the upstream before the full body is produced');
  } finally {
    await proxy.stop();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
  completed.push('passthrough backpressure pauses upstream reads and cancels on disconnect');
}

async function testTraceIntegrityDoctor(): Promise<void> {
  const auditRoot = path.join(root, 'trace-integrity-doctor');
  await fs.mkdir(auditRoot, { recursive: true });
  const cleanPath = path.join(auditRoot, 'clean.jsonl');
  const corruptPath = path.join(auditRoot, 'corrupt.jsonl');
  const cleanBody = [
    JSON.stringify({
      id: 'clean-1', turn: 1, sessionId: 'clean', source: 'codex-cli',
      clientConversationKey: 'codex-cli:clean', routedBy: 'clientConversationKey'
    }),
    JSON.stringify({
      id: 'clean-2', turn: 2, sessionId: 'clean', source: 'codex-cli',
      clientConversationKey: 'codex-cli:clean', routedBy: 'clientConversationKey'
    })
  ].join('\n') + '\n';
  const corruptBody = [
    JSON.stringify({
      id: 'corrupt-1', turn: 1, sessionId: 'corrupt', source: 'codex-cli',
      clientConversationKey: 'codex-cli:corrupt', routedBy: 'clientConversationKey'
    }),
    '{"id":"broken"',
    JSON.stringify({
      id: 'corrupt-3a', turn: 3, sessionId: 'corrupt', source: 'codex-cli',
      clientConversationKey: 'codex-cli:corrupt', routedBy: 'clientConversationKey'
    }),
    JSON.stringify({
      id: 'corrupt-3b', turn: 3, sessionId: 'corrupt', source: 'codex-cli',
      clientConversationKey: 'codex-cli:other', routedBy: 'clientConversationKey'
    })
  ].join('\n') + '\n';
  await fs.writeFile(cleanPath, cleanBody);
  await fs.writeFile(corruptPath, corruptBody);
  await fs.writeFile(path.join(auditRoot, 'index.json'), JSON.stringify({
    version: 1,
    sessions: [{
      id: 'clean',
      startedAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:01:00.000Z',
      traceCount: 2,
      jsonlPath: cleanPath,
      source: 'codex-cli',
      clientConversationKey: 'codex-cli:clean'
    }, {
      id: 'corrupt',
      startedAt: '2026-08-15T01:00:00.000Z',
      updatedAt: '2026-08-15T01:01:00.000Z',
      traceCount: 3,
      jsonlPath: corruptPath,
      source: 'codex-cli',
      clientConversationKey: 'codex-cli:corrupt'
    }]
  }));

  const result = await runChild(
    process.execPath,
    [path.join(process.cwd(), 'tools', 'trace-integrity.mjs'), auditRoot]
  );
  assert.equal(result.code, 2, result.stderr);
  const report = JSON.parse(result.stdout) as {
    readonly readOnly: boolean;
    readonly summary: { readonly sessions: number; readonly errorSessions: number };
    readonly sessions: Array<{
      readonly id: string;
      readonly severity: string;
      readonly malformedRecords: number;
      readonly duplicateTurns: Array<{ turn: number; count: number }>;
      readonly missingTurns: number[];
      readonly strongConversationKeyMismatches: number[];
    }>;
  };
  assert.equal(report.readOnly, true);
  assert.equal(report.summary.sessions, 2);
  assert.equal(report.summary.errorSessions, 1);
  assert.equal(report.sessions.find(session => session.id === 'clean')?.severity, 'ok');
  const corrupt = report.sessions.find(session => session.id === 'corrupt');
  assert.equal(corrupt?.severity, 'error');
  assert.equal(corrupt?.malformedRecords, 1);
  assert.deepEqual(corrupt?.duplicateTurns, [{ turn: 3, count: 2 }]);
  assert.deepEqual(corrupt?.missingTurns, [2]);
  assert.deepEqual(corrupt?.strongConversationKeyMismatches, [3]);
  assert.equal(await fs.readFile(cleanPath, 'utf8'), cleanBody);
  assert.equal(await fs.readFile(corruptPath, 'utf8'), corruptBody,
    'the doctor must never rewrite Trace JSONL');
  completed.push('read-only Trace integrity doctor detects malformed JSONL and routing drift');
}

function runChild(command: string, args: readonly string[]): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, stdout, stderr }));
  });
}

async function testSessionRouting(): Promise<void> {
  const now = new Date('2026-07-17T08:00:00.000Z');
  const session: TapSessionSummary = {
    id: 'session-a',
    startedAt: '2026-07-17T07:58:00.000Z',
    updatedAt: '2026-07-17T07:59:30.000Z',
    traceCount: 2,
    jsonlPath: 'session-a.jsonl',
    source: 'copilot',
    firstPrompt: 'Refactor the trace session routing implementation and preserve all existing behavior.',
    lastChain: ['root-a']
  };
  assert.equal(findSessionByRootHash([session], 'root-a', 'copilot', now)?.id, session.id);
  assert.equal(findSessionByRootHash([session], 'root-a', 'claude-cli', now), undefined);
  assert.equal(findRecentEditedPromptSession([session], now, 'copilot', {
    chainHashes: ['edited-root'],
    firstPrompt: 'Refactor the trace session routing implementation while preserving all existing behavior.'
  })?.id, session.id);

  const countTrace = {
    source: 'claude-cli',
    request: { path: '/v1/messages/count_tokens' }
  } as TapTraceRecord;
  assert.equal(classifyAuxiliaryTrace(countTrace), 'count');

  const codexTitle = {
    source: 'codex-cli',
    request: { body: { text: { format: { type: 'json_schema', schema: { properties: { title: {} } } } } } }
  } as TapTraceRecord;
  const codexUtility = {
    source: 'codex-vscode',
    request: { body: { text: { format: { name: 'codex_output_schema', schema: { properties: { answer: {} } } } } } }
  } as TapTraceRecord;
  assert.equal(classifyAuxiliaryTrace(codexTitle), 'title');
  assert.equal(isCodexStructuredUtilityTrace(codexTitle), false);
  assert.equal(isCodexStructuredUtilityTrace(codexUtility), true);
  const memoryTrace = {
    source: 'codex-vscode',
    request: {
      body: {
        input: [{
          role: 'user',
          content: [{
            type: 'input_text',
            text: 'Analyze this rollout and produce JSON with `raw_memory`, `rollout_summary`, and `rollout_slug` (use empty string when unknown).'
          }]
        }],
        text: { format: { type: 'json_schema', schema: { properties: { raw_memory: {} } } } }
      }
    }
  } as TapTraceRecord;
  assert.equal(classifyAuxiliaryTrace(memoryTrace), 'memory');
  assert.equal(isCodexStructuredUtilityTrace(memoryTrace), true);
  const visibleThread: TapSessionSummary = {
    ...session,
    id: 'visible-thread',
    source: 'codex-vscode',
    clientConversationKey: 'codex-vscode:stable-thread'
  };
  const hiddenThread: TapSessionSummary = {
    ...visibleThread,
    id: 'hidden-thread',
    hidden: true,
    auxiliary: 'utility',
    updatedAt: '2026-07-17T08:01:00.000Z'
  };
  assert.equal(
    findSessionByClientConversationKey(
      [visibleThread, hiddenThread],
      'codex-vscode:stable-thread',
      'codex-vscode'
    )?.id,
    visibleThread.id,
    'a newer hidden utility bucket must not steal a native conversation key from its visible owner'
  );

  const titleRoutingRoot = path.join(root, 'trace-codex-title-routing');
  const titleRoutingStore = new TraceStore(titleRoutingRoot);
  const makeRoutingTrace = (options: {
    id: string;
    at: string;
    clientConversationKey: string;
    input: unknown[];
    title?: string;
  }): TapTraceRecord => ({
    id: options.id,
    startedAt: options.at,
    completedAt: new Date(Date.parse(options.at) + 100).toISOString(),
    durationMs: 100,
    client: 'ChatGPT',
    clientConversationKey: options.clientConversationKey,
    source: 'codex-vscode',
    protocol: 'openai-responses',
    request: {
      method: 'POST',
      path: '/backend-api/codex/responses',
      url: 'http://127.0.0.1/backend-api/codex/responses',
      headers: {},
      body: {
        model: 'gpt-test',
        input: options.input,
        ...(options.title ? {
          text: {
            format: {
              name: 'codex_output_schema',
              type: 'json_schema',
              schema: { properties: { title: {}, description: {} } }
            }
          }
        } : {})
      },
      model: 'gpt-test',
      apiType: 'responses'
    },
    upstream: { baseUrl: 'https://chatgpt.com/backend-api', url: 'https://chatgpt.com/backend-api/codex/responses' },
    response: {
      statusCode: 200,
      headers: {},
      snapshot: {
        apiType: 'responses',
        content: options.title ? [{ type: 'text', text: JSON.stringify({ title: options.title, description: 'QA' }) }] : []
      }
    },
    sse: { events: [] },
    timings: {}
  });
  const oldPrompt = '修复游戏能量等级上限';
  const nextPrompt = '修复 Trace 侧边栏排序';
  const userMessage = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] });
  const oldRecord = await titleRoutingStore.appendTrace(makeRoutingTrace({
    id: 'old-main',
    at: '2026-08-03T07:00:00.000Z',
    clientConversationKey: 'codex-vscode:old-thread',
    input: [userMessage(oldPrompt)]
  }));
  const malformedTitle = await titleRoutingStore.appendTrace(makeRoutingTrace({
    id: 'malformed-title',
    at: '2026-08-03T07:00:30.000Z',
    clientConversationKey: 'codex-vscode:utility-malformed',
    input: [userMessage('<recommended_plugins>injected context only</recommended_plugins>')],
    title: 'Must stay hidden'
  }));
  assert.equal(malformedTitle.routedBy, 'unknownUtility');
  assert.notEqual(malformedTitle.sessionId, oldRecord.sessionId,
    'a malformed Codex title must not attach to the most recent visible task');

  const titleTemplate = [
    'You are a helpful assistant. Generate a concise UI title.',
    '',
    'User prompt:',
    nextPrompt
  ].join('\n');
  const validTitle = await titleRoutingStore.appendTrace(makeRoutingTrace({
    id: 'valid-title',
    at: '2026-08-03T07:01:00.000Z',
    clientConversationKey: 'codex-vscode:utility-title',
    input: [
      userMessage('<recommended_plugins>injected context</recommended_plugins>\n# AGENTS.md instructions for demo'),
      userMessage(titleTemplate)
    ],
    title: '修复 Trace 侧边栏排序'
  }));
  assert.equal(validTitle.routedBy, 'provisionalTitle',
    'a title arriving before its main turn must use the embedded prompt root despite injected user context');
  assert.notEqual(validTitle.sessionId, oldRecord.sessionId);

  const nextRecord = await titleRoutingStore.appendTrace(makeRoutingTrace({
    id: 'next-main',
    at: '2026-08-03T07:01:02.000Z',
    clientConversationKey: 'codex-vscode:next-thread',
    input: [userMessage(nextPrompt)]
  }));
  assert.equal(nextRecord.routedBy, 'absorbHidden');
  assert.equal(nextRecord.sessionId, validTitle.sessionId,
    'the main turn must absorb the exact-root provisional title session');
  const routedSessions = await titleRoutingStore.listSessions();
  const oldSession = routedSessions.find(item => item.clientConversationKey === 'codex-vscode:old-thread');
  const nextSession = routedSessions.find(item => item.clientConversationKey === 'codex-vscode:next-thread');
  assert.equal(oldSession?.title, undefined);
  assert.equal(oldSession?.firstPrompt, oldPrompt);
  assert.equal(nextSession?.title, '修复 Trace 侧边栏排序');
  assert.equal(nextSession?.firstPrompt, nextPrompt);

  const attachmentWrappedPrompt = [
    '# Files mentioned by the user:',
    '- compatible-switch.png',
    '',
    '## My request:',
    '检查 兼容服务 切回 ChatGPT',
    '',
    '<image name="compatible-switch.png">preview</image>'
  ].join('\n');
  const attachmentTitle = await titleRoutingStore.appendTrace(makeRoutingTrace({
    id: 'attachment-title',
    at: '2026-08-03T07:01:02.500Z',
    clientConversationKey: 'codex-vscode:utility-attachment-title',
    input: [userMessage([
      'You are a helpful assistant. Generate a concise UI title.',
      '',
      'User prompt:',
      attachmentWrappedPrompt
    ].join('\n'))],
    title: '检查 兼容服务 切回 ChatGPT'
  }));
  assert.equal(attachmentTitle.routedBy, 'provisionalTitle');
  const attachmentMain = await titleRoutingStore.appendTrace(makeRoutingTrace({
    id: 'attachment-main',
    at: '2026-08-03T07:01:03.000Z',
    clientConversationKey: 'codex-vscode:attachment-main',
    input: [userMessage(attachmentWrappedPrompt)]
  }));
  assert.equal(attachmentMain.routedBy, 'absorbHidden');
  assert.equal(attachmentMain.sessionId, attachmentTitle.sessionId,
    'a title generated from the current `## My request:` attachment wrapper must merge into its main session');
  const attachmentSessions = await titleRoutingStore.listSessions();
  const attachmentSession = attachmentSessions.find(item => item.clientConversationKey === 'codex-vscode:attachment-main');
  assert.equal(attachmentSession?.title, '检查 兼容服务 切回 ChatGPT');
  assert.match(attachmentSession?.firstPrompt ?? '', /^检查 兼容服务 切回 ChatGPT/);
  assert.doesNotMatch(attachmentSession?.firstPrompt ?? '', /^# Files mentioned by the user:/,
    'the attachment preamble must not replace the real first prompt');

  const memoryRecord = await titleRoutingStore.appendTrace(makeRoutingTrace({
    id: 'memory-maintenance',
    at: '2026-08-03T07:01:04.000Z',
    clientConversationKey: 'codex-vscode:next-thread',
    input: [userMessage(
      '## Memory Writing Agent: Phase 1 (Single Rollout)\n'
      + 'Analyze this rollout and produce JSON with `raw_memory`, `rollout_summary`, and `rollout_slug`.'
    )]
  }));
  assert.equal(memoryRecord.auxiliary, 'memory');
  assert.equal(memoryRecord.sessionId, nextRecord.sessionId);
  const secondMemoryRecord = await titleRoutingStore.appendTrace(makeRoutingTrace({
    id: 'memory-maintenance-2',
    at: '2026-08-03T07:01:05.000Z',
    clientConversationKey: 'codex-vscode:next-thread',
    input: [userMessage(
      '## Memory Writing Agent: Phase 2 (Global Consolidation)\n'
      + 'Analyze this rollout and produce JSON with `raw_memory`, `rollout_summary`, and `rollout_slug`.'
    )]
  }));
  assert.equal(secondMemoryRecord.sessionId, nextRecord.sessionId);
  const afterMemory = (await titleRoutingStore.listSessions())
    .find(item => item.id === nextRecord.sessionId);
  assert.equal(afterMemory?.firstPrompt, nextPrompt,
    'memory maintenance must not replace the visible user prompt');
  assert.equal(afterMemory?.auxiliaryCounts?.memory, 2,
    'auxiliary request counts must survive index reads instead of restarting at one');
  assert.equal(afterMemory?.startedAt, '2026-08-03T07:01:00.000Z');
  assert.equal(afterMemory?.lastRequestAt, '2026-08-03T07:01:05.000Z');
  assert.equal(afterMemory?.durationMs, 5_000,
    'session duration must span the first and last request starts, not the last completion or current time');
  const lateCompletedFirst = await titleRoutingStore.appendTrace(makeRoutingTrace({
    id: 'duration-late-completed-first',
    at: '2026-08-03T08:03:00.000Z',
    clientConversationKey: 'codex-vscode:duration-order',
    input: [userMessage('later request')]
  }));
  const earlyCompletedLast = await titleRoutingStore.appendTrace(makeRoutingTrace({
    id: 'duration-early-completed-last',
    at: '2026-08-03T08:02:00.000Z',
    clientConversationKey: 'codex-vscode:duration-order',
    input: [userMessage('earlier request')]
  }));
  assert.equal(earlyCompletedLast.sessionId, lateCompletedFirst.sessionId);
  const reorderedDurationSession = (await titleRoutingStore.listSessions())
    .find(item => item.id === lateCompletedFirst.sessionId);
  assert.equal(reorderedDurationSession?.startedAt, '2026-08-03T08:02:00.000Z');
  assert.equal(reorderedDurationSession?.lastRequestAt, '2026-08-03T08:03:00.000Z');
  assert.equal(reorderedDurationSession?.durationMs, 60_000,
    'out-of-order completions must still preserve the earliest and latest request starts');

  const orphanMemoryRoot = path.join(root, 'trace-orphan-memory');
  const firstOrphanMemory = await new TraceStore(orphanMemoryRoot).appendTrace(makeRoutingTrace({
    id: 'orphan-memory-one',
    at: '2026-08-03T07:02:00.000Z',
    input: [userMessage('## Memory Writing Agent: Phase 1 (Single Rollout)')]
  }));
  const secondOrphanMemory = await new TraceStore(orphanMemoryRoot).appendTrace(makeRoutingTrace({
    id: 'orphan-memory-two',
    at: '2026-08-03T07:03:00.000Z',
    input: [userMessage('## Memory Writing Agent: Phase 2 (Global Consolidation)')]
  }));
  assert.equal(secondOrphanMemory.sessionId, firstOrphanMemory.sessionId,
    'a restarted TraceStore must reuse the same hidden daily memory bucket');

  const conversationPageRoot = path.join(root, 'trace-conversation-page');
  await fs.mkdir(conversationPageRoot, { recursive: true });
  const conversationKey = 'codex-vscode:fragmented-thread';
  const fragmentOne = {
    ...makeRoutingTrace({
      id: 'fragment-one-trace',
      at: '2026-08-03T08:00:00.000Z',
      clientConversationKey: conversationKey,
      input: [userMessage('first physical fragment')]
    }),
    sessionId: 'fragment-one',
    turn: 1
  };
  const fragmentTwo = {
    ...makeRoutingTrace({
      id: 'fragment-two-trace',
      at: '2026-08-03T08:05:00.000Z',
      clientConversationKey: conversationKey,
      input: [userMessage('second physical fragment')]
    }),
    sessionId: 'fragment-two',
    turn: 1
  };
  const hiddenProviderSwitchFragment = {
    ...makeRoutingTrace({
      id: 'fragment-provider-switch-trace',
      at: '2026-08-03T08:07:00.000Z',
      clientConversationKey: conversationKey,
      input: [userMessage('provider transition maintenance')]
    }),
    auxiliary: 'memory' as const,
    sessionId: 'fragment-provider-switch',
    turn: 1
  };
  await fs.writeFile(path.join(conversationPageRoot, 'fragment-one.jsonl'), `${JSON.stringify(fragmentOne)}\n`, 'utf8');
  await fs.writeFile(path.join(conversationPageRoot, 'fragment-two.jsonl'), `${JSON.stringify(fragmentTwo)}\n`, 'utf8');
  await fs.writeFile(
    path.join(conversationPageRoot, 'fragment-provider-switch.jsonl'),
    `${JSON.stringify(hiddenProviderSwitchFragment)}\n`,
    'utf8'
  );
  await fs.writeFile(path.join(conversationPageRoot, 'index.json'), `${JSON.stringify({
    version: 1,
    sessions: [{
      id: 'fragment-one',
      startedAt: fragmentOne.startedAt,
      updatedAt: fragmentOne.completedAt,
      traceCount: 1,
      jsonlPath: path.join(conversationPageRoot, 'fragment-one.jsonl'),
      source: 'codex-vscode',
      clientConversationKey: conversationKey,
      firstPrompt: 'first physical fragment'
    }, {
      id: 'fragment-two',
      startedAt: fragmentTwo.startedAt,
      updatedAt: fragmentTwo.completedAt,
      traceCount: 1,
      jsonlPath: path.join(conversationPageRoot, 'fragment-two.jsonl'),
      source: 'codex-vscode',
      clientConversationKey: conversationKey,
      firstPrompt: 'second physical fragment'
    }, {
      id: 'fragment-provider-switch',
      startedAt: hiddenProviderSwitchFragment.startedAt,
      updatedAt: hiddenProviderSwitchFragment.completedAt,
      traceCount: 1,
      jsonlPath: path.join(conversationPageRoot, 'fragment-provider-switch.jsonl'),
      source: 'codex-vscode',
      clientConversationKey: conversationKey,
      hidden: true,
      auxiliary: 'memory'
    }]
  })}\n`, 'utf8');
  const conversationStore = new TraceStore(conversationPageRoot);
  const conversationPage = await conversationStore.readConversationPage('fragment-two');
  assert.deepEqual(
    conversationPage?.traces.map(trace => trace.id),
    ['fragment-one-trace', 'fragment-two-trace', 'fragment-provider-switch-trace'],
    'the detail timeline must merge visible and hidden physical fragments of one native conversation'
  );
  assert.deepEqual(
    conversationPage?.traces.map(trace => trace.logicalTurn),
    [1, 2, 3],
    'provider-transition fragments must receive one stable logical conversation ordinal'
  );
  assert.deepEqual(
    conversationPage?.traces.map(trace => trace.turn),
    [1, 1, 1],
    'logical conversation ordinals must not rewrite the immutable physical-session turns'
  );
  assert.equal(conversationPage?.total, 3);
  const conversationTailPage = await conversationStore.readConversationPage(
    'fragment-two',
    { offset: 1, limit: 1 }
  );
  assert.deepEqual(conversationTailPage?.traces.map(trace => trace.logicalTurn), [2],
    'a tail page must retain the logical conversation ordinal from its global offset');
  const conversationDefaultTail = await conversationStore.readConversationPage(
    'fragment-two',
    { limit: 1 }
  );
  assert.deepEqual(conversationDefaultTail?.traces.map(trace => trace.id), ['fragment-provider-switch-trace'],
    'the default detail page must include the newest hidden provider-transition fragment');
  assert.deepEqual(conversationDefaultTail?.traces.map(trace => trace.logicalTurn), [3],
    'the newest default page must retain its global logical conversation ordinal');
  assert.equal(conversationDefaultTail?.offset, 2);
  assert.equal(conversationDefaultTail?.hasMoreAfter, false);

  const totalBeforeConcurrentAppend = conversationDefaultTail?.total ?? 0;
  const inFlightConversationRead = conversationStore.readConversationPage(
    'fragment-two',
    { offset: 0, limit: 10 }
  );
  const inFlightConversationAppend = conversationStore.appendTrace(makeRoutingTrace({
    id: 'fragment-concurrent-trace',
    at: '2026-08-03T08:10:00.000Z',
    clientConversationKey: conversationKey,
    input: [userMessage('concurrent append after the captured index snapshot')]
  }));
  let concurrentSnapshotTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [stableSnapshotPage, appendedTrace] = await Promise.race([
      Promise.all([inFlightConversationRead, inFlightConversationAppend]),
      new Promise<never>((_resolve, reject) => {
        concurrentSnapshotTimer = setTimeout(
          () => reject(new Error('logical conversation snapshot read deadlocked with appendTrace')),
          2_000
        );
      })
    ]);
    assert.equal(stableSnapshotPage?.total, totalBeforeConcurrentAppend,
      'an in-flight logical page must finish entirely from the index snapshot captured before appendTrace');
    assert.equal(stableSnapshotPage?.traces.every(trace =>
      typeof trace.logicalTurn === 'number' && trace.logicalTurn <= (stableSnapshotPage.total || 0)), true,
    'a snapshot page must never expose a logical turn beyond its own total');
    assert.equal(appendedTrace.id, 'fragment-concurrent-trace');
  } finally {
    if (concurrentSnapshotTimer) clearTimeout(concurrentSnapshotTimer);
  }

  const conversationAfterAppend = await conversationStore.readConversationPage(
    'fragment-two',
    { offset: 0, limit: 10 }
  );
  assert.equal(conversationAfterAppend?.total, totalBeforeConcurrentAppend + 1,
    'the next logical page must observe the completed append exactly once');
  assert.deepEqual(conversationAfterAppend?.traces.map(trace => trace.logicalTurn), [1, 2, 3, 4],
    'logical turns must remain contiguous after a concurrent append/read boundary');
  assert.equal(await conversationStore.deleteSession('fragment-two'), true);
  assert.equal(
    (await conversationStore.listSessions()).some(session => session.clientConversationKey === conversationKey),
    false,
    'deleting a logical Conversation must remove every physical fragment instead of letting the row reappear'
  );
  await assert.rejects(fs.stat(path.join(conversationPageRoot, 'fragment-one.jsonl')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(conversationPageRoot, 'fragment-two.jsonl')), /ENOENT/);
  await assert.rejects(fs.stat(path.join(conversationPageRoot, 'fragment-provider-switch.jsonl')), /ENOENT/);

  const claudeTitleRoot = path.join(root, 'trace-claude-title-routing');
  const claudeTitleStore = new TraceStore(claudeTitleRoot);
  const makeClaudeRoutingTrace = (options: {
    id: string;
    at: string;
    prompt: string;
    clientConversationKey?: string;
    title?: string;
    wrappedSession?: boolean;
  }): TapTraceRecord => ({
    id: options.id,
    startedAt: options.at,
    completedAt: new Date(Date.parse(options.at) + 100).toISOString(),
    durationMs: 100,
    client: 'Claude',
    clientConversationKey: options.clientConversationKey,
    source: 'claude-cli',
    protocol: 'anthropic-messages',
    request: {
      method: 'POST',
      path: '/v1/messages',
      url: 'http://127.0.0.1/v1/messages',
      headers: {},
      body: {
        model: 'claude-test',
        messages: [{
          role: 'user',
          content: options.wrappedSession
            ? `<session>\n${options.prompt}\n</session>\n\nWrite the title.`
            : options.prompt
        }],
        ...(options.title ? {
          system: 'Generate a concise, sentence-case title. The session content is provided inside <session> tags.'
        } : {})
      },
      model: 'claude-test',
      apiType: 'messages'
    },
    upstream: { baseUrl: 'https://example.test', url: 'https://example.test/v1/messages' },
    response: {
      statusCode: 200,
      headers: {},
      snapshot: {
        apiType: 'messages',
        content: options.title
          ? [{ type: 'text', text: JSON.stringify({ title: options.title }) }]
          : []
      }
    },
    sse: { events: [] },
    timings: {}
  });
  const oldClaudeMain = await claudeTitleStore.appendTrace(makeClaudeRoutingTrace({
    id: 'claude-old-main',
    at: '2026-08-05T06:20:00.000Z',
    prompt: '旧 Claude 会话',
    clientConversationKey: 'claude-cli:old-session'
  }));
  const lateOldTitle = await claudeTitleStore.appendTrace(makeClaudeRoutingTrace({
    id: 'claude-old-title',
    at: '2026-08-05T06:20:01.000Z',
    prompt: '旧 Claude 会话',
    clientConversationKey: 'claude-cli:old-session',
    title: '旧 Claude 标题',
    wrappedSession: true
  }));
  assert.equal(lateOldTitle.sessionId, oldClaudeMain.sessionId);
  assert.equal(lateOldTitle.routedBy, 'clientConversationKey');

  const futureClaudePrompt = '优化 xwxtrace 阅读页面展开交互引导';
  const earlyClaudeTitle = await claudeTitleStore.appendTrace(makeClaudeRoutingTrace({
    id: 'claude-early-title',
    at: '2026-08-05T06:29:47.498Z',
    prompt: futureClaudePrompt,
    clientConversationKey: 'claude-cli:future-session',
    title: '优化 xwxtrace 展开引导',
    wrappedSession: true
  }));
  assert.equal(earlyClaudeTitle.routedBy, 'provisionalTitle');
  assert.notEqual(earlyClaudeTitle.sessionId, oldClaudeMain.sessionId);
  const futureClaudeMain = await claudeTitleStore.appendTrace(makeClaudeRoutingTrace({
    id: 'claude-future-main',
    at: '2026-08-05T06:29:47.527Z',
    prompt: futureClaudePrompt,
    clientConversationKey: 'claude-cli:future-session'
  }));
  assert.equal(futureClaudeMain.routedBy, 'absorbHidden');
  assert.equal(futureClaudeMain.sessionId, earlyClaudeTitle.sessionId);
  const futureClaudeSession = (await claudeTitleStore.listSessions())
    .find(item => item.clientConversationKey === 'claude-cli:future-session');
  assert.equal(futureClaudeSession?.title, '优化 xwxtrace 展开引导');
  assert.equal(futureClaudeSession?.firstPrompt, futureClaudePrompt);
  assert.equal(futureClaudeSession?.pendingUtilityClientKeys, undefined);

  const malformedClaudeTitle = await claudeTitleStore.appendTrace(makeClaudeRoutingTrace({
    id: 'claude-malformed-title',
    at: '2026-08-05T06:30:00.000Z',
    prompt: 'future format without a session wrapper',
    title: 'Must stay hidden'
  }));
  assert.equal(malformedClaudeTitle.routedBy, 'unknownUtility');
  assert.notEqual(malformedClaudeTitle.sessionId, futureClaudeMain.sessionId);

  const rootOnlyPrompt = 'Claude title root fallback without a native key';
  const rootOnlyTitle = await claudeTitleStore.appendTrace(makeClaudeRoutingTrace({
    id: 'claude-root-title',
    at: '2026-08-05T06:31:00.000Z',
    prompt: rootOnlyPrompt,
    title: 'Claude root fallback',
    wrappedSession: true
  }));
  assert.equal(rootOnlyTitle.routedBy, 'provisionalTitle');
  const rootOnlyMain = await claudeTitleStore.appendTrace(makeClaudeRoutingTrace({
    id: 'claude-root-main',
    at: '2026-08-05T06:31:00.100Z',
    prompt: rootOnlyPrompt
  }));
  assert.equal(rootOnlyMain.routedBy, 'absorbHidden');
  assert.equal(rootOnlyMain.sessionId, rootOnlyTitle.sessionId);

  const actualPrompt = '修复 xwxtrace 标题兜底';
  const injectedPrompt = [
    '<recommended_plugins>',
    'Here is a list of plugins that are available but not installed.',
    '- Figma (figma@openai-curated-remote)',
    '</recommended_plugins>',
    '# AGENTS.md instructions for E:\\Ai2Work\\XwX Deck',
    '',
    '',
    actualPrompt
  ].join('\n');
  const promptTrace = (text: string) => ({
    source: 'codex-vscode',
    request: {
      body: {
        input: [{ role: 'user', content: [{ type: 'input_text', text }] }]
      }
    }
  } as TapTraceRecord);
  const injectedFingerprint = extractFingerprint(promptTrace(injectedPrompt));
  const cleanFingerprint = extractFingerprint(promptTrace(actualPrompt));
  assert.equal(injectedFingerprint.firstPrompt, actualPrompt);
  assert.deepEqual(
    injectedFingerprint.chainHashes,
    cleanFingerprint.chainHashes,
    'client plugin/repository context must not affect the conversation root hash'
  );
  assert.equal(
    extractFingerprint(promptTrace(`请解释下面的字面文本：\n# AGENTS.md instructions for demo`)).firstPrompt,
    '请解释下面的字面文本：\n# AGENTS.md instructions for demo',
    'non-leading user-authored AGENTS text must remain intact'
  );

  const localCommandCaveat = `<${LOCAL_COMMAND_CAVEAT_TAG}>${LOCAL_COMMAND_CAVEAT_TEXT}</${LOCAL_COMMAND_CAVEAT_TAG}>`;
  {
    // Claude Code 的 spawn 工具实测叫 `Agent`（参数 description / subagent_type / prompt），
    // 不是 `Task`。曾因正则只认 ^Task$ 而一条都提取不到，249 条子 agent trace 全部兜底成
    // "Subagent"（真实抓样 2026-08-05T06-29-47）。这里用真实形状钉住。
    const claudeAgentSpawn = {
      source: 'claude-cli',
      sse: {
        snapshot: {
          content: [{
            type: 'tool_use',
            id: 'toolu_bdrk_01JtDez',
            name: 'Agent',
            input: {
              description: 'Angle A line-by-line scan',
              subagent_type: 'general-purpose',
              prompt: 'You are reviewing a commit. Report findings as JSON.'
            }
          }]
        }
      }
    } as unknown as TapTraceRecord;
    const claudeInvocations = subagentInvocations(claudeAgentSpawn);
    assert.equal(claudeInvocations.length, 1, 'the Claude `Agent` spawn tool must be recognized, not only `Task`');
    assert.equal(claudeInvocations[0].displayName, 'Angle A line-by-line scan');
    assert.equal(claudeInvocations[0].agentType, 'general-purpose');

    // Codex 子 agent 的父子链只能靠 transport header：spawn_agent 用 fork_context，子 agent 继承
    // 父对话全文，其首条 user 消息永远不等于 spawn message，hash 路径结构性失效
    // （真实抓样：Codex 会话 60 条子 agent trace、0 条靠 hash 盖章成功）。
    const codexChild = {
      source: 'codex-vscode',
      request: {
        headers: {
          'x-openai-subagent': 'collab_spawn',
          'x-codex-parent-thread-id': '019fd199-5828-7ff0-8d5f-65b01b366435',
          'thread-id': '019fd19a-28ba-7f72-8e16-9eb7aaa7a71d'
        }
      }
    } as unknown as TapTraceRecord;
    const ancestry = extractCodexThreadAncestry(codexChild);
    assert.ok(ancestry, 'a Codex subagent request must yield header-based ancestry');
    assert.equal(ancestry!.invocationId, '019fd19a-28ba-7f72-8e16-9eb7aaa7a71d');
    assert.equal(ancestry!.parentInvocationId, '019fd199-5828-7ff0-8d5f-65b01b366435');
    assert.ok(!('shortId' in ancestry!),
      'the thread-id suffix must not ride in ancestry any more: the viewer derives a short id from '
      + 'invocationId for every client, so it no longer squats in the real agentType slot');
    assert.equal(
      extractCodexThreadAncestry({ source: 'claude-cli', request: { headers: {} } } as unknown as TapTraceRecord),
      undefined,
      'the Codex header path must not fire for other clients'
    );

    // 自定义 Codex agent：spawn_agent 带 agent_type / nickname（实测 codex.exe 的 serde 字段串
    // `fork_context agent_id nickname id` 与 `agent_type reasoning_effort fork_context`）。
    // 注意字段是裸 `nickname`，不是 agent_nickname——只读后者会漏掉自定义 agent 的名字。
    const codexCustomSpawn = {
      id: 'codex-parent',
      source: 'codex-vscode',
      sse: {
        snapshot: {
          content: [{
            type: 'tool_use',
            id: 'call_custom_1',
            name: 'spawn_agent',
            input: {
              fork_context: false,
              message: 'Run the automated test suite for the current branch.',
              agent_type: 'auto-test',
              nickname: 'AutoTest'
            }
          }]
        }
      }
    } as unknown as TapTraceRecord;
    const customInvocations = subagentInvocations(codexCustomSpawn);
    assert.equal(customInvocations.length, 1, 'a Codex custom-agent spawn must be recorded');
    assert.equal(customInvocations[0].displayName, 'AutoTest', 'the bare `nickname` field must feed the display name');
    assert.equal(customInvocations[0].agentType, 'auto-test', 'the custom agent id must land in agentType');
  }
  const claudePrompt = '哈喽，检查 Claude 会话标题归类。';
  const claudeLocalCommandTrace = {
    source: 'claude-cli',
    request: {
      body: {
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: localCommandCaveat },
            { type: 'text', text: '<command-name>/model</command-name>' },
            { type: 'text', text: '<local-command-stdout>Set model</local-command-stdout>' },
            { type: 'text', text: claudePrompt }
          ]
        }]
      }
    }
  } as TapTraceRecord;
  const claudeLocalFingerprint = extractFingerprint(claudeLocalCommandTrace);
  const cleanClaudeFingerprint = extractFingerprint({
    source: 'claude-cli',
    request: {
      body: { messages: [{ role: 'user', content: claudePrompt }] }
    }
  } as TapTraceRecord);
  assert.equal(claudeLocalFingerprint.firstPrompt, claudePrompt);
  assert.deepEqual(
    claudeLocalFingerprint.chainHashes,
    cleanClaudeFingerprint.chainHashes,
    'a standalone local-command caveat part must not become a shared Claude root'
  );
  const quotedCaveatPrompt = `查看下面引用的原始标签，不要删除：\n\n${localCommandCaveat}\n\n这是用户正文。`;
  assert.equal(
    extractFingerprint(promptTrace(quotedCaveatPrompt)).firstPrompt,
    quotedCaveatPrompt,
    'a local-command caveat quoted inside user-authored prose must remain intact'
  );
  assert.equal(
    extractAnthropicTitleRootHash(`<session>\n${claudePrompt}\n</session>\n\nWrite the title.`),
    cleanClaudeFingerprint.chainHashes[0],
    'Claude title session wrappers must reproduce the main prompt root'
  );
  // 回归防线：主回合的退化路径会 stripKnownPromptNoise 并截断到 200 字，标题侧必须走同一条
  // 取哈希逻辑。曾因两侧算法不同，任何超过 200 字或含噪音标签的首条 prompt 都路由不到会话，
  // 而唯一的断言样本只有 15 字，恰好落在安全区。
  for (const [label, longPrompt] of [
    ['201 chars', 'A'.repeat(201)],
    ['500 chars', 'A'.repeat(500)],
    ['300 CJK chars', '请帮我重构这个模块。'.repeat(30)],
    ['noise tag + long body', `<system-reminder>ignore</system-reminder>\n${'B'.repeat(250)}`]
  ] as const) {
    assert.equal(
      extractAnthropicTitleRootHash(`<session>\n${longPrompt}\n</session>\n\nWrite the title.`),
      extractFingerprint({
        source: 'claude-cli',
        request: { body: { messages: [{ role: 'user', content: longPrompt }] } }
      } as TapTraceRecord).chainHashes[0],
      `Claude title root must match the main prompt root for ${label}`
    );
  }

  const subagentRoot = path.join(root, 'trace-subagent-labels');
  const subagentStore = new TraceStore(subagentRoot);
  const makeSubagentTrace = (options: {
    id: string;
    at: string;
    source: TapTraceRecord['source'];
    system?: string;
    userText: string;
    clientConversationKey?: string;
    headers?: Record<string, string>;
    responseContent?: NonNullable<TapTraceRecord['response']['snapshot']>['content'];
  }): TapTraceRecord => ({
    id: options.id,
    startedAt: options.at,
    completedAt: new Date(Date.parse(options.at) + 100).toISOString(),
    durationMs: 100,
    client: options.source?.startsWith('claude') ? 'Claude' : 'ChatGPT',
    clientConversationKey: options.clientConversationKey,
    source: options.source,
    protocol: options.source?.startsWith('claude') ? 'anthropic-messages' : 'openai-responses',
    request: {
      method: 'POST',
      path: options.source?.startsWith('claude') ? '/v1/messages' : '/v1/responses',
      url: options.source?.startsWith('claude')
        ? 'http://127.0.0.1/v1/messages'
        : 'http://127.0.0.1/v1/responses',
      headers: options.headers || {},
      body: {
        model: 'subagent-test',
        ...(options.system ? { system: options.system } : {}),
        ...(options.source?.startsWith('claude')
          ? { messages: [{ role: 'user', content: options.userText }] }
          : { input: [{ role: 'user', content: [{ type: 'input_text', text: options.userText }] }] })
      },
      model: 'subagent-test',
      apiType: options.source?.startsWith('claude') ? 'messages' : 'responses'
    },
    upstream: { baseUrl: 'https://example.test', url: 'https://example.test/v1' },
    response: {
      statusCode: 200,
      headers: {},
      snapshot: {
        apiType: options.source?.startsWith('claude') ? 'messages' : 'responses',
        content: options.responseContent || []
      }
    },
    sse: { events: [] },
    timings: {}
  });

  const claudeTaskPrompt = 'Inspect the trace routing implementation and report the exact data flow.';
  const claudeMain = await subagentStore.appendTrace(makeSubagentTrace({
    id: 'claude-main',
    at: '2026-08-04T10:00:00.000Z',
    source: 'claude-cli',
    system: 'You are Claude Code, Anthropic official CLI.',
    userText: 'Use an agent to inspect trace routing.',
    clientConversationKey: 'claude-cli:parent-thread',
    responseContent: [{
      type: 'tool_use',
      id: 'tool-agent-1',
      name: 'Agent',
      input: {
        description: 'Trace routing investigator',
        subagent_type: 'general-purpose',
        prompt: claudeTaskPrompt
      }
    }]
  }));
  const nestedClaudePrompt = 'Verify the nested SubAgent ancestry without changing any files.';
  const claudeChild = await subagentStore.appendTrace(makeSubagentTrace({
    id: 'claude-child',
    at: '2026-08-04T10:00:01.000Z',
    source: 'claude-cli',
    system: 'x-anthropic-billing-header: cc_is_subagent=true; You are a Claude agent, built on the Claude Agent SDK.',
    userText: claudeTaskPrompt,
    clientConversationKey: 'claude-cli:parent-thread',
    responseContent: [{
      type: 'tool_use',
      id: 'tool-agent-1-child',
      name: 'Agent',
      input: {
        description: 'Nested ancestry verifier',
        subagent_type: 'explorer',
        prompt: nestedClaudePrompt
      }
    }]
  }));
  assert.equal(claudeChild.sessionId, claudeMain.sessionId);
  assert.equal(claudeChild.routedBy, 'clientConversationKey');
  assert.equal(
    claudeChild.subagent,
    'Trace routing investigator',
    'Claude Agent.description must replace the generic AgentSDK/Subagent label'
  );
  assert.deepEqual(claudeChild.subagentInfo, {
    invocationId: 'tool-agent-1',
    depth: 1,
    agentType: 'general-purpose'
  });
  const claudeGrandchild = await subagentStore.appendTrace(makeSubagentTrace({
    id: 'claude-grandchild',
    at: '2026-08-04T10:00:02.000Z',
    source: 'claude-cli',
    system: 'x-anthropic-billing-header: cc_is_subagent=true; You are a Claude agent, built on the Claude Agent SDK.',
    userText: nestedClaudePrompt,
    clientConversationKey: 'claude-cli:parent-thread'
  }));
  assert.equal(claudeGrandchild.sessionId, claudeMain.sessionId);
  assert.equal(claudeGrandchild.subagent, 'Nested ancestry verifier');
  assert.deepEqual(claudeGrandchild.subagentInfo, {
    invocationId: 'tool-agent-1-child',
    parentInvocationId: 'tool-agent-1',
    depth: 2,
    agentType: 'explorer'
  });
  const claudeSession = (await subagentStore.listSessions()).find(item => item.id === claudeMain.sessionId);
  assert.equal(claudeSession?.pendingSubagents?.[0]?.displayName, 'Trace routing investigator');
  assert.equal(claudeSession?.pendingSubagents?.[0]?.agentType, 'general-purpose');
  assert.equal(claudeSession?.pendingSubagents?.[1]?.parentId, 'tool-agent-1');
  assert.equal(claudeSession?.pendingSubagents?.[1]?.depth, 2);
  assert.ok((claudeSession?.pendingSubagentRoots?.length || 0) > 0);

  const copilotTaskPrompt = 'Inspect only the renderer grouping behavior.';
  const copilotMain = await subagentStore.appendTrace(makeSubagentTrace({
    id: 'copilot-main',
    at: '2026-08-04T10:01:00.000Z',
    source: 'copilot',
    userText: 'Delegate renderer inspection.',
    responseContent: [{
      type: 'tool_use',
      id: 'tool-agent-2',
      name: 'runSubagent',
      input: {
        agentName: 'Explore',
        prompt: copilotTaskPrompt
      }
    }]
  }));
  const copilotChild = await subagentStore.appendTrace(makeSubagentTrace({
    id: 'copilot-child',
    at: '2026-08-04T10:01:01.000Z',
    source: 'copilot',
    system: '<modeInstructions>You are running in "Explore" mode.</modeInstructions>',
    userText: copilotTaskPrompt
  }));
  assert.equal(copilotChild.sessionId, copilotMain.sessionId);
  assert.equal(copilotChild.routedBy, 'pendingSubagentRoot');
  assert.equal(copilotChild.subagent, 'Explore');
  assert.deepEqual(copilotChild.subagentInfo, {
    invocationId: 'tool-agent-2',
    depth: 1
  });

  const codexTaskPrompt = 'Inspect the Codex trace metadata flow.';
  const codexMain = await subagentStore.appendTrace(makeSubagentTrace({
    id: 'codex-main',
    at: '2026-08-04T10:02:00.000Z',
    source: 'codex-vscode',
    userText: 'Delegate Codex metadata inspection.',
    headers: {
      'x-codex-turn-metadata': JSON.stringify({
        thread_id: 'parent-codex-thread',
        thread_source: 'user'
      })
    },
    responseContent: [{
      type: 'tool_use',
      id: 'tool-agent-3',
      name: 'spawn_agent',
      input: {
        agent_type: 'explorer',
        message: codexTaskPrompt
      }
    }]
  }));
  const codexStandardChild = await subagentStore.appendTrace(makeSubagentTrace({
    id: 'codex-standard-child',
    at: '2026-08-04T10:02:01.000Z',
    source: 'codex-vscode',
    userText: codexTaskPrompt,
    headers: {
      'x-codex-turn-metadata': JSON.stringify({
        thread_id: 'child-codex-thread',
        parent_thread_id: 'parent-codex-thread',
        thread_source: 'subagent',
        subagent_kind: 'thread_spawn'
      })
    }
  }));
  assert.equal(codexStandardChild.sessionId, codexMain.sessionId);
  assert.equal(codexStandardChild.subagent, 'explorer');
  assert.deepEqual(codexStandardChild.subagentInfo, {
    invocationId: 'tool-agent-3',
    depth: 1,
    agentType: 'explorer'
  });

  const codexMetadata = JSON.stringify({
    thread_source: 'subagent',
    subagent_kind: 'thread_spawn',
    parent_thread_id: 'other-parent-codex-thread',
    agent_nickname: 'Sagan',
    agent_path: '/root/trace_router'
  });
  const codexChild = await subagentStore.appendTrace(makeSubagentTrace({
    id: 'codex-child',
    at: '2026-08-04T10:02:30.000Z',
    source: 'codex-vscode',
    userText: 'Inspect Codex trace metadata.',
    headers: { 'x-codex-turn-metadata': codexMetadata }
  }));
  assert.equal(
    codexChild.subagent,
    'Sagan',
    'Codex transport metadata should use an explicit nickname when the client provides one'
  );

  const legacyPendingSession: TapSessionSummary = {
    id: 'legacy-pending',
    startedAt: '2026-08-04T10:03:00.000Z',
    updatedAt: '2026-08-04T10:03:10.000Z',
    traceCount: 1,
    jsonlPath: 'legacy-pending.jsonl',
    source: 'copilot',
    pendingSubagentRoots: ['legacy-root']
  };
  const legacyPendingHit = findSessionByPendingSubagentRoot(
    [legacyPendingSession],
    new Date('2026-08-04T10:03:30.000Z'),
    ['legacy-root'],
    'copilot'
  );
  assert.equal(legacyPendingHit?.session.id, 'legacy-pending');
  assert.equal(legacyPendingHit?.invocation, undefined);

  const legacyPromptRoot = path.join(root, 'trace-legacy-prompt-title');
  const legacyPromptStore = new TraceStore(legacyPromptRoot);
  const legacySessionPath = path.join(legacyPromptRoot, 'legacy-session.jsonl');
  await fs.mkdir(legacyPromptRoot, { recursive: true });
  await fs.writeFile(legacySessionPath, '');
  await fs.writeFile(legacyPromptStore.indexPath(), JSON.stringify({
    version: 1,
    sessions: [{
      id: 'legacy-session',
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      traceCount: 0,
      jsonlPath: legacySessionPath,
      firstPrompt: injectedPrompt,
      source: 'codex-vscode'
    }, {
      id: 'legacy-leading-caveat',
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      traceCount: 0,
      jsonlPath: legacySessionPath,
      firstPrompt: `${localCommandCaveat}\n\n${claudePrompt}`,
      source: 'claude-cli'
    }, {
      id: 'legacy-literal-caveat',
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      traceCount: 0,
      jsonlPath: legacySessionPath,
      firstPrompt: quotedCaveatPrompt,
      source: 'codex-vscode'
    }]
  }));
  const repairedLegacySessions = await legacyPromptStore.listSessions();
  assert.equal(repairedLegacySessions.find(item => item.id === 'legacy-session')?.firstPrompt, actualPrompt);
  assert.equal(repairedLegacySessions.find(item => item.id === 'legacy-leading-caveat')?.firstPrompt, claudePrompt);
  assert.equal(
    repairedLegacySessions.find(item => item.id === 'legacy-literal-caveat')?.firstPrompt,
    quotedCaveatPrompt
  );
  const persistedLegacyIndex = JSON.parse(await fs.readFile(legacyPromptStore.indexPath(), 'utf8')) as {
    sessions: Array<{ id: string; firstPrompt?: string }>;
  };
  assert.equal(persistedLegacyIndex.sessions.find(item => item.id === 'legacy-session')?.firstPrompt, actualPrompt);
  assert.equal(
    persistedLegacyIndex.sessions.find(item => item.id === 'legacy-leading-caveat')?.firstPrompt,
    claudePrompt
  );
  assert.equal(
    persistedLegacyIndex.sessions.find(item => item.id === 'legacy-literal-caveat')?.firstPrompt,
    quotedCaveatPrompt
  );

  const legacyClaudeTitleRoot = path.join(root, 'trace-legacy-claude-title-route');
  const legacyClaudeTitleStore = new TraceStore(legacyClaudeTitleRoot);
  const legacyWrongPath = path.join(legacyClaudeTitleRoot, 'wrong.jsonl');
  const legacyTargetPath = path.join(legacyClaudeTitleRoot, 'target.jsonl');
  await fs.mkdir(legacyClaudeTitleRoot, { recursive: true });
  const legacyMisroutedTitle = {
    ...makeClaudeRoutingTrace({
      id: 'legacy-misrouted-title',
      at: '2026-08-05T06:29:47.498Z',
      prompt: futureClaudePrompt,
      clientConversationKey: 'claude-cli:legacy-target',
      title: '优化 xwxtrace 展开引导',
      wrappedSession: true
    }),
    auxiliary: 'title',
    routedBy: 'auxSource'
  } as TapTraceRecord;
  const legacyTargetMain = makeClaudeRoutingTrace({
    id: 'legacy-target-main',
    at: '2026-08-05T06:29:47.527Z',
    prompt: futureClaudePrompt,
    clientConversationKey: 'claude-cli:legacy-target'
  });
  const legacyWrongRaw = JSON.stringify(legacyMisroutedTitle) + '\n';
  const legacyTargetRaw = JSON.stringify(legacyTargetMain) + '\n';
  await fs.writeFile(legacyWrongPath, legacyWrongRaw);
  await fs.writeFile(legacyTargetPath, legacyTargetRaw);
  await fs.writeFile(legacyClaudeTitleStore.indexPath(), JSON.stringify({
    version: 1,
    sessions: [{
      id: 'legacy-wrong-host',
      startedAt: '2026-08-05T06:20:00.000Z',
      updatedAt: '2026-08-05T06:29:50.000Z',
      traceCount: 1,
      jsonlPath: legacyWrongPath,
      firstPrompt: '哈喽',
      title: '优化 xwxtrace 展开引导',
      source: 'claude-cli',
      clientConversationKey: 'claude-cli:legacy-old'
    }, {
      id: 'legacy-correct-target',
      startedAt: '2026-08-05T06:29:47.527Z',
      updatedAt: '2026-08-05T06:30:00.000Z',
      traceCount: 1,
      jsonlPath: legacyTargetPath,
      firstPrompt: futureClaudePrompt,
      source: 'claude-cli',
      clientConversationKey: 'claude-cli:legacy-target'
    }]
  }));
  const repairedClaudeTitles = await legacyClaudeTitleStore.listSessions();
  assert.equal(repairedClaudeTitles.find(item => item.id === 'legacy-wrong-host')?.title, undefined);
  assert.equal(
    repairedClaudeTitles.find(item => item.id === 'legacy-correct-target')?.title,
    '优化 xwxtrace 展开引导'
  );
  assert.equal(await fs.readFile(legacyWrongPath, 'utf8'), legacyWrongRaw,
    'historical title repair must not rewrite or delete the original misrouted request');
  assert.equal(await fs.readFile(legacyTargetPath, 'utf8'), legacyTargetRaw,
    'historical title repair must leave the target raw request untouched');

  const nativeTitleRoot = path.join(root, 'codex-native-thread-titles');
  const nativeCodexHome = path.join(nativeTitleRoot, '.codex');
  const nativeConfigPath = path.join(nativeCodexHome, 'config.toml');
  const nativeDbPath = path.join(nativeCodexHome, 'state_5.sqlite');
  await fs.mkdir(nativeCodexHome, { recursive: true });
  await fs.writeFile(nativeConfigPath, 'model_provider = "xwx_deck"\n');
  const nativeDb = new Database(nativeDbPath);
  nativeDb.exec([
    'CREATE TABLE threads (',
    'id TEXT PRIMARY KEY,',
    'title TEXT NOT NULL,',
    'name TEXT,',
    'first_user_message TEXT,',
    'updated_at INTEGER NOT NULL,',
    'model_provider TEXT NOT NULL',
    ')'
  ].join(' '));
  const insertNativeThread = nativeDb.prepare(
    'INSERT INTO threads (id,title,name,first_user_message,updated_at,model_provider) VALUES (?,?,?,?,?,?)'
  );
  insertNativeThread.run(
    'thread-fallback',
    '原始首条问题',
    null,
    '原始首条问题',
    1,
    'xwx_deck'
  );
  insertNativeThread.run(
    'thread-native-title',
    'Codex 原生精简标题',
    null,
    '这是很长的原始首条问题',
    2,
    'xwx_deck'
  );
  insertNativeThread.run(
    'thread-explicit-name',
    '模型生成标题',
    '用户命名的会话',
    '另一条原始问题',
    3,
    'third-party-provider'
  );
  nativeDb.close();

  const nativeTitleReader = new CodexThreadTitleReader(
    () => nativeConfigPath,
    () => ({})
  );
  const nativeTitleSessions: TapSessionSummary[] = [
    {
      id: 'fallback-session',
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      traceCount: 0,
      jsonlPath: path.join(nativeTitleRoot, 'fallback.jsonl'),
      source: 'codex-vscode',
      clientConversationKey: 'codex-vscode:thread-fallback'
    },
    {
      id: 'native-title-session',
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      traceCount: 0,
      jsonlPath: path.join(nativeTitleRoot, 'native.jsonl'),
      source: 'codex-vscode',
      clientConversationKey: 'codex-vscode:thread-native-title'
    },
    {
      id: 'explicit-name-session',
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      traceCount: 0,
      jsonlPath: path.join(nativeTitleRoot, 'name.jsonl'),
      source: 'codex-cli',
      clientConversationKey: 'codex-cli:thread-explicit-name'
    }
  ];
  const nativeOverlay = await nativeTitleReader.overlay(nativeTitleSessions);
  assert.equal(nativeOverlay.get('fallback-session'), undefined,
    'Codex title equal to first_user_message is only a fallback and must not override XwX titles');
  assert.equal(nativeOverlay.get('native-title-session'), 'Codex 原生精简标题');
  assert.equal(nativeOverlay.get('explicit-name-session'), '用户命名的会话',
    'an explicit Codex thread name must outrank the generated title regardless of model provider');

  const nativeOverlayTraceRoot = path.join(nativeTitleRoot, 'xwx-trace');
  const nativeOverlayStore = new TraceStore(
    nativeOverlayTraceRoot,
    () => 50,
    () => undefined,
    sessions => nativeTitleReader.overlay(sessions)
  );
  await fs.mkdir(nativeOverlayTraceRoot, { recursive: true });
  const nativeOverlayJsonl = path.join(nativeOverlayTraceRoot, 'native.jsonl');
  await fs.writeFile(nativeOverlayJsonl, '');
  await fs.writeFile(nativeOverlayStore.indexPath(), JSON.stringify({
    version: 1,
    sessions: [{
      ...nativeTitleSessions[1],
      jsonlPath: nativeOverlayJsonl,
      title: 'XwX 网络兜底标题'
    }]
  }));
  assert.equal((await nativeOverlayStore.listSessions())[0]?.title, 'Codex 原生精简标题');
  const nativePersistedIndex = JSON.parse(
    await fs.readFile(nativeOverlayStore.indexPath(), 'utf8')
  ) as { sessions: Array<{ title?: string }> };
  assert.equal(nativePersistedIndex.sessions[0]?.title, 'XwX 网络兜底标题',
    'native Codex titles must remain a display-only overlay and never rewrite the XwX index');
  completed.push('session routing source guards and auxiliary classification');
}

async function testPortableUpdateReplacement(): Promise<void> {
  const updateRoot = path.join(root, 'portable-update');
  const source = path.join(updateRoot, 'XwX Deck-1.0.1.exe');
  const target = path.join(updateRoot, 'XwX Deck.exe');
  const oldBytes = Buffer.from('MZ-old-portable-build', 'utf8');
  const newBytes = Buffer.from('MZ-new-portable-build', 'utf8');
  await fs.mkdir(updateRoot, { recursive: true });
  await fs.writeFile(source, newBytes);
  await fs.writeFile(target, oldBytes);

  const replaced = await replacePortableExecutable(source, target);
  assert.deepEqual(await fs.readFile(target), newBytes);
  assert.deepEqual(await fs.readFile(replaced.backupPath), oldBytes);
  await assert.rejects(fs.access(replaced.pendingPath));
  assert.deepEqual(
    safePortableCleanupPaths([
      source,
      replaced.backupPath,
      replaced.pendingPath,
      `${target}.rollback`,
      path.join(updateRoot, 'unrelated.exe'),
      path.join(updateRoot, 'pending', 'XwX Deck-1.0.1.exe')
    ], target),
    [replaced.backupPath, replaced.pendingPath, `${target}.rollback`, path.join(updateRoot, 'pending', 'XwX Deck-1.0.1.exe')]
  );

  await restorePortableExecutable(replaced.backupPath, target);
  assert.deepEqual(await fs.readFile(target), oldBytes,
    'portable rollback must restore the previous executable without removing its backup');

  await fs.writeFile(source, newBytes);
  await fs.writeFile(target, oldBytes);
  await assert.rejects(
    replacePortableExecutable(source, target, {
      beforeInstall: async () => {
        assert.deepEqual(await fs.readFile(target), oldBytes,
          'the current executable must remain at its public path until the final replacement');
        throw new Error('injected pre-install failure');
      }
    }),
    /injected pre-install failure/
  );
  assert.deepEqual(await fs.readFile(target), oldBytes,
    'a pre-install failure must leave the current executable untouched');
  await assert.rejects(fs.access(`${target}.updating`));

  await fs.writeFile(source, newBytes);
  await fs.writeFile(target, oldBytes);
  await assert.rejects(
    replacePortableExecutable(source, target, {
      afterInstall: async () => {
        assert.deepEqual(await fs.readFile(target), newBytes);
        throw new Error('injected post-install failure');
      }
    }),
    /injected post-install failure/
  );
  assert.deepEqual(await fs.readFile(target), oldBytes,
    'a failure after replacement must atomically restore the previous executable');
  assert.deepEqual(await fs.readFile(`${target}.previous`), oldBytes);

  await cleanupPortableUpdateFiles([
    source,
    replaced.backupPath,
    replaced.pendingPath,
    `${target}.rollback`
  ]);
  await assert.rejects(fs.access(source));
  await assert.rejects(fs.access(replaced.backupPath));
  assert.deepEqual(await fs.readFile(target), oldBytes);
  completed.push('portable update atomic replacement, failure rollback, backup and cleanup');
}

async function testManagerIpcContract(): Promise<void> {
  // Manager UI is now a React SPA — read all renderer source files as the contract surface.
  const updateNotification = await fs.readFile(path.resolve('src/renderer/features/shell/UpdateNotification.tsx'), 'utf8');
  const settingsPage = await fs.readFile(path.resolve('src/renderer/features/settings/SettingsPage.tsx'), 'utf8');
  const repairCenter = await fs.readFile(path.resolve('src/renderer/features/settings/RepairCenterSheet.tsx'), 'utf8');
  const modelsPage = await fs.readFile(path.resolve('src/renderer/features/models/ModelsPage.tsx'), 'utf8');
  const toolsPage = await fs.readFile(path.resolve('src/renderer/features/tools/ToolsPage.tsx'), 'utf8');
  const onboardingTour = await fs.readFile(path.resolve('src/renderer/features/onboarding/OnboardingTour.tsx'), 'utf8');
  const combobox = await fs.readFile(path.resolve('src/renderer/components/ui/combobox.tsx'), 'utf8');
  const rendererStyles = await fs.readFile(path.resolve('src/renderer/styles.css'), 'utf8');
  const xwxDeckController = await fs.readFile(path.resolve('src/main/app/xwxDeckController.ts'), 'utf8');
  const rendererSrc = (await Promise.all([
    'src/renderer/App.tsx',
    'src/renderer/bridge/api.ts',
    'src/renderer/bridge/types.ts',
    'src/renderer/bridge/previewApi.ts',
    'src/renderer/features/shell/Titlebar.tsx',
    'src/renderer/features/shell/Rail.tsx',
    'src/renderer/features/shell/Toggle.tsx',
    'src/renderer/features/trace/SignalPage.tsx',
    'src/renderer/features/trace/ParticleField.tsx',
    'src/renderer/features/models/ModelsPage.tsx',
    'src/renderer/features/models/ModelPicker.tsx',
    'src/renderer/features/models/CodexEnhancements.tsx',
    'src/renderer/features/tools/ToolsPage.tsx',
    'src/renderer/features/settings/SettingsPage.tsx',
    'src/renderer/features/settings/RepairCenterSheet.tsx',
  ].map(f => fs.readFile(path.resolve(f), 'utf8')))).join('\n');
  const indexHtml = await fs.readFile(path.resolve('dist', 'renderer', 'index.html'), 'utf8');
  const preload = await fs.readFile(path.resolve('src', 'main', 'preload.ts'), 'utf8');
  const bootstrap = await fs.readFile(path.resolve('src', 'main', 'main.ts'), 'utf8');
  const runtime = await fs.readFile(path.resolve('src', 'main', 'runtime.ts'), 'utf8');
  const exitRecovery = await fs.readFile(path.resolve('src', 'main', 'exitRecovery.ts'), 'utf8');
  const chatGptLifecycle = await fs.readFile(path.resolve('src', 'main', 'app', 'chatGptLifecycle.ts'), 'utf8');
  const main = `${bootstrap}\n${runtime}`;
  const ipcHandlers = await fs.readFile(path.resolve('src', 'main', 'ipc', 'registerHandlers.ts'), 'utf8');
  const startup = await fs.readFile(path.resolve('src', 'main', 'app', 'startup.ts'), 'utf8');
  const updater = await fs.readFile(path.resolve('src', 'main', 'update', 'xwxDeckUpdater.ts'), 'utf8');
  const tray = await fs.readFile(path.resolve('src', 'main', 'tray.ts'), 'utf8');
  const managerWindow = await fs.readFile(path.resolve('src', 'main', 'window', 'managerWindow.ts'), 'utf8');
  const mainProcess = `${main}\n${ipcHandlers}\n${managerWindow}\n${startup}`;
  const expected = [
    'getState', 'getTraceStats', 'getUpdateState', 'checkForUpdates', 'downloadUpdate', 'restartAndInstall',
    'setStartupEnabled', 'setTheme', 'toggleTracing', 'toggleClient', 'getCodexConfig', 'isChatGptRunning', 'getCodexEnhancements', 'updateCodexEnhancements',
    'diagnoseCodexConversations', 'openCodexConversationPath', 'copyText',
    'getCompatibleServiceConfig', 'updateCompatibleServiceConfig',
    'getModelServices', 'setModelService', 'getClaudeModels', 'updateClaudeModels',
    'updateCodexConfig', 'fetchModels', 'chooseDirectory', 'updateTraceDirectories', 'setTraceAppearance',
    'chooseTraceBackground', 'clearTraceBackground', 'repairApplication', 'resetApplication',
    'openDashboard', 'openDataFolder',
    'openLogFolder', 'clearHistory', 'disableBreaksCodex', 'refresh', 'minimizeWindow', 'toggleMaximize', 'setManagerView', 'closeWindow', 'onNotice'
  ];
  for (const method of expected) assert.match(preload, new RegExp(`\\b${method}:`), `preload must expose ${method}`);
  assert.match(rendererSrc, /window\.xwxDeck/);
  assert.match(indexHtml, /<title>XwX Deck<\/title>/);
  assert.match(runtime, /path\.join\(app\.getPath\('appData'\), 'xwx-deck'\)[\s\S]*app\.setName\('XwX Deck'\);[\s\S]*app\.setPath\('userData', standaloneUserDataDir\);/,
    'the standalone edition must use an isolated user-data directory');
  assert.match(runtime, /app\.setAppUserModelId\('app\.xwxdeck\.desktop'\)/,
    'the standalone edition must use an isolated Windows application identity');
  assert.match(rendererSrc, /ChatGPT/);
  assert.match(combobox, /top:\s*41/, 'model menus must stay below the Electron draggable titlebar');
  assert.match(combobox, /collisionPadding=\{collisionPadding\}/,
    'the titlebar collision padding must reach the popup positioner');
  assert.match(onboardingTour, /getBoundingClientRect\(\)/,
    'onboarding highlights must measure the real target element');
  assert.match(onboardingTour, /ResizeObserver/,
    'onboarding highlights must follow target and layout size changes');
  assert.match(onboardingTour, /getComputedStyle\(page\)\.transform === 'none'/,
    'onboarding must wait for page transitions before accepting a target position');
  assert.doesNotMatch(onboardingTour, /setRect\(null\)/,
    'onboarding steps must retain the previous spotlight instead of flashing a full-screen backdrop');
  assert.match(onboardingTour, /document\.body\.dataset\.tourActive = 'true'/,
    'onboarding must expose its active state so underlying page transitions can be suppressed');
  assert.match(rendererStyles, /body\[data-tour-active="true"\] \.page\s*\{\s*transition:\s*none;/,
    'onboarding navigation must not animate the whole page underneath the spotlight');
  assert.doesNotMatch(onboardingTour, /tour-kicker|\{index \+ 1\}\s*\/\s*\{STEPS\.length\}/,
    'onboarding must not duplicate the bottom progress indicator with a top fraction');
  assert.match(rendererStyles, /\.tour-bubble\s*\{[\s\S]*?padding:\s*14px 22px 12px/,
    'the onboarding card must keep the compact top spacing verified in the rendered UI');
  assert.match(rendererSrc, /Trace 已开启；当前任务未生效时，请手动重启 ChatGPT。/,
    'enabling Trace must use one concise bottom-right toast');
  assert.match(rendererSrc, /ChatGPT 接入失败，请重启 Trace 后重试。/);
  assert.match(rendererSrc, /ChatGPT 暂未接入，XwX Deck 当前的连接方式无法与 Trace 同时使用。请先重启 XwX Deck，再重启 Trace 后重试。/);
  assert.match(
    rendererSrc,
    /showToast\('请重启 ChatGPT', 'info', CHATGPT_RESTART_TOAST_ID,[\s\S]*?timeout: 12_000/,
    'a running ChatGPT must receive a visible restart notice after Gateway takeover'
  );
  assert.match(
    rendererSrc,
    /if \(!bridge\.runtime\?\.chatGptRestartRecommended\) \{[\s\S]*?shownChatGptRestartRef\.current = false;/,
    'the restart notice must reset after returning to a direct connection'
  );
  assert.match(runtime, /if \(PACKAGED_SMOKE_TEST\)/,
    'isolated packaged smoke must never inspect the user\'s real ChatGPT process');
  assert.doesNotMatch(runtime, /forceQuitChatGpt|requestChatGptQuit|launchChatGpt/,
    'runtime must never close, force-quit, or launch ChatGPT');
  assert.doesNotMatch(chatGptLifecycle, /forceQuitChatGpt|requestChatGptQuit|launchChatGpt|taskkill\.exe|osascript|SIGKILL/,
    'the ChatGPT lifecycle boundary must expose detection only, not process control');
  assert.doesNotMatch(runtime, /showExitModeDialog/,
    'ordinary exit must not offer a multi-choice proxy mode dialog');
  assert.match(runtime.slice(runtime.indexOf("app.on('before-quit'"), runtime.indexOf('class ShutdownCancelledError')), /controller\?\.detachManager\(\)/,
    'ordinary exit must detach from an active model data plane');
  assert.match(runtime, /quit: requestFullShutdownFromTray/,
    'the tray Exit action must request a full shutdown instead of silently detaching the manager');
  assert.match(runtime, /function requestFullShutdownFromTray\(\)[\s\S]*?fullShutdownRequested = true;[\s\S]*?app\.quit\(\)/,
    'tray Exit must mark the full-shutdown intent before Electron enters before-quit');
  assert.match(runtime, /fullShutdownRequested[\s\S]*?await prepareSafeShutdown\(confirmContext\)/,
    'tray Exit must inspect live helper activity and confirm risky shutdowns');
  assert.match(runtime, /confirmContext === 'tray-quit'[\s\S]*?shutdownActivitySnapshot\(\)[\s\S]*?showTrayQuitConfirm\(initial\)[\s\S]*?hideFullShutdownUi\(\)[\s\S]*?startExitRecoveryGuardian\(\)/,
    'tray Exit must confirm from the cached snapshot, hide immediately, and move live inspection behind the visual exit');
  assert.match(runtime, /prepareSafeShutdown\(confirmContext\)[\s\S]*?armFullShutdownWatchdog\(\)/,
    'confirmed tray Exit must arm an independent deadline before lifecycle shutdown work');
  assert.match(runtime, /fullShutdownRequested[\s\S]*?controller\?\.forceExit\(\)[\s\S]*?app\.exit\(0\)/,
    'confirmed tray Exit must force a final process exit when graceful shutdown fails');
  assert.match(runtime, /startExitRecoveryGuardian\(\)[\s\S]*?armFullShutdownWatchdog\(\)/,
    'confirmed tray Exit must arm a detached recovery process before relying on in-process cleanup');
  assert.match(runtime, /hideFullShutdownUi\(\);[\s\S]*?await startExitRecoveryGuardian\(\)/,
    'the visible manager and tray must disappear immediately after confirmation, before background cleanup');
  assert.match(runtime, /fullShutdownUiHidden \|\| !controller \|\| !managerWindow/,
    'a second-instance event must not reopen the manager after visual shutdown is committed');
  assert.match(tray, /dispose\(\)[\s\S]*?this\.tray\?\.destroy\(\)/,
    'visual shutdown must remove the tray icon instead of leaving an apparently running app');
  assert.match(runtime, /exit-recovery\.ready[\s\S]*?退出恢复守护进程未能在时限内保存恢复快照/,
    'the manager must wait for the detached guardian to snapshot runtime and client backups before shutdown continues');
  assert.match(runtime, /triggerExitRecoveryNow\(\)/,
    'a graceful shutdown failure must wake the detached recovery guardian immediately');
  assert.match(runtime, /full-shutdown watchdog expired[\s\S]*?detached recovery guardian finishes client restore and process cleanup[\s\S]*?app\.exit\(1\)/,
    'the manager watchdog must leave final client recovery and process-tree cleanup to the detached guardian');
  assert.match(exitRecovery, /writeReadyMarker[\s\S]*?forceRestoreOriginal[\s\S]*?replaceOwnedLoopbackReferences[\s\S]*?terminateProcess\(runtime\.pid\)[\s\S]*?terminateProcess\(options\.managerPid\)/,
    'the detached guardian must restore owned localhost references before terminating Gateway and manager');
  assert.match(xwxDeckController, /restoreClientConnectionsBeforeForcedStop\(\)[\s\S]*?clientsPointingAt\(localBaseUrl\)[\s\S]*?this\.proxy\.forceStop\(\)/,
    'the in-process fallback must still attempt bounded recovery before forcing the Gateway down');
  assert.match(tray, /state\.backgroundGatewayAction === 'close' \? '关闭代理' : '开启代理'/,
    'the menu-bar proxy action must use the concise demand-driven labels');
  assert.match(tray, /toggleGateway\(state\.backgroundGatewayAction!\)/,
    'each proxy menu item must retain the action that was visible when the menu snapshot was built');
  assert.match(tray, /\{ label: '退出', click: this\.actions\.quit \}/,
    'the tray full-exit action must keep the concise native-style label');
  assert.match(tray, /app\.dock\.setMenu\(this\.buildDockMenu\(state\)\)/,
    'the Dock menu must expose the same proxy toggle alongside macOS native Quit');
  assert.match(tray, /private buildDockMenu[\s\S]*?state\.backgroundGatewayAction === 'close' \? '关闭代理' : '开启代理'/,
    'the Dock proxy toggle must match the menu-bar wording');
  assert.doesNotMatch(tray, /label: '打开管理器'|label: '打开'/,
    'clicking the menu-bar or Dock icon must replace redundant open menu items');
  assert.doesNotMatch(tray, /追踪已暂停|继续追踪/,
    'the internal paused intent must remain visually identical to ordinary disabled tracing');
  const gatewayToggleRuntime = runtime.slice(
    runtime.indexOf('async function toggleBackgroundGatewayOnce'),
    runtime.indexOf('async function toggleTracingOnce')
  );
  assert.doesNotMatch(gatewayToggleRuntime, /dialog\.|showImmediateShutdownConfirm|showSystemConfirm/,
    'tray proxy actions must use manager toasts instead of native dialogs');
  assert.match(gatewayToggleRuntime, /drainTimeoutMs: 1_000[\s\S]*?error instanceof ShutdownDrainTimeoutError[\s\S]*?showManagerNotice/,
    'tray proxy close must drain once and defer with a toast instead of forcing an active request closed');
  assert.match(gatewayToggleRuntime, /showManagerNotice\('代理已关闭。', 'success'\)/,
    'the successful proxy-close notice must stay concise');
  assert.match(runtime, /controller\.startBackgroundGateway\(\)/,
    'the same proxy action must support reopening a stopped Gateway');
  const traceToggleRuntime = runtime.slice(
    runtime.indexOf('async function toggleTracingOnce'),
    runtime.indexOf('async function toggleTracingFromTray')
  );
  assert.doesNotMatch(traceToggleRuntime, /confirmChatGptMayNeedRestart|showSystemConfirm/,
    'enabling Trace from the manager must not show a system notification');
  assert.doesNotMatch(rendererSrc, /void bridge\.api\.toggleTracing\(\)/,
    'the Space shortcut must not bypass the page toggle guard');
  assert.match(rendererSrc, /window\.dispatchEvent\(new Event\(TRACE_TOGGLE_REQUEST_EVENT\)\)/,
    'the Space shortcut must share the button Toast and confirmation flow');
  assert.match(runtime, /gatewayMenuActionMatches\(expectedAction, action\)/,
    'a stale proxy menu click must refresh instead of executing the opposite current action');
  assert.match(runtime, /requiresChatGptExit = controller\.requiresCodexClientExitBeforeShutdown\(\)/,
    'official direct shutdown must bypass unnecessary ChatGPT running-state detection');
  assert.match(xwxDeckController, /requiresCodexClientExitBeforeShutdown[\s\S]*?this\.codexGatewayEnabled[\s\S]*?this\.active[\s\S]*?takeover\.client === 'codex-cli'[\s\S]*?takeover\.status === 'taken'/,
    'explicit proxy shutdown must detect whether ChatGPT may own live rollout files');
  assert.doesNotMatch(runtime, /重新检测并退出/,
    'shutdown must not offer a retry loop that performs no action');
  assert.doesNotMatch(runtime, /requestChatGptQuit|showChatGptForceQuitDialog|等待完成后关闭|SHUTDOWN_WAIT_SLICE_MS/,
    'confirmed shutdown must not expose or enter a separate waiting flow');
  assert.match(xwxDeckController, /!options\.skipCodexHistoryRepair[\s\S]*?deferred ChatGPT provider history repair because ChatGPT may still be running/,
    'shutdown must defer live rollout repair while ChatGPT may still be running');
  assert.match(xwxDeckController, /async shutdownActivity[\s\S]*?await this\.proxy\.refreshShutdownActivity\(\)/,
    'the shutdown prompt must refresh helper activity instead of displaying a stale cached count');
  assert.match(xwxDeckController, /async disableBreaksCodex[\s\S]*?await this\.shutdownActivity\(\)[\s\S]*?activeRequests > 0 \|\| activity\.pendingContinuations > 0/,
    'stopping Trace must warn only for live helper activity, not a ChatGPT process');
  assert.match(rendererSrc, /title: '停止 Trace'[\s\S]*?当前仍有对话正在进行。[\s\S]*?confirmText: '确认停止'/,
    'the live Trace stop warning must stay inside the styled manager dialog');
  const updateInstall = runtime.slice(runtime.indexOf('async function restartAndInstall'));
  assert.match(updateInstall, /await prepareSafeShutdown\(\);[\s\S]*?await shutdownControllerWithConfirmation\(shutdown\.forceShutdown, shutdown\.chatGptMayBeRunning\);/,
    'automatic update must share the interactive shutdown guard');
  assert.match(settingsPage, /showToast\(operationError\(error, manual \? '无法打开安装包' : '无法重启并完成更新'\), 'error'\)/,
    'update failures must preserve the actionable shutdown reason');
  assert.match(
    xwxDeckController,
    /Claude 接入失败：检测到环境变量 ANTHROPIC_BASE_URL，本地配置已失效，请移除相关环境变量后重试/,
    'Claude environment overrides must use a direct actionable warning'
  );
  assert.match(
    rendererSrc,
    /showToast\(environmentIssue, 'error', ENVIRONMENT_OVERRIDE_TOAST_ID\)/,
    'Trace must actively surface the Claude environment override'
  );
  assert.match(
    rendererSrc,
    /showToast\(e instanceof Error && e\.message \? e\.message : '客户端接入失败', 'error'\)/,
    'client toggles must preserve actionable backend errors'
  );
  assert.match(
    modelsPage,
    /message\.startsWith\('Claude 接入失败：检测到环境变量'\)\) return message/,
    'model service errors must not prefix the concise environment warning'
  );
  assert.match(xwxDeckController, /等待请求/);
  assert.match(xwxDeckController, /若客户端已在运行，请重启客户端后发送请求/);
  assert.match(xwxDeckController, /const capture = settings\.tracingEnabled && settings\.clientEnabled\.codex !== false/,
    'the retained official fallback must stop recording when Trace is off');
  assert.doesNotMatch(rendererSrc, /切换为直连上游/);
  assert.match(rendererSrc, /data-client-tab="codex"/);
  assert.match(rendererSrc, />模型配置<\/h1>/);
  assert.match(rendererSrc, /data-page=\{id\}/);
  assert.match(rendererSrc, /id="page-tools"/);
  assert.match(toolsPage, /id="conversationDoctor"/);
  assert.match(toolsPage, /diagnoseCodexConversations/);
  assert.match(toolsPage, /SQLite · threads/);
  assert.match(toolsPage, /JSONL · session_meta/);
  assert.doesNotMatch(toolsPage, /Excel 转 Markdown|excelDropzone|convertExcelFiles/,
    'the standalone tools page must contain only conversation diagnosis');
  assert.match(rendererSrc, /data-model-service|setModelService/);
  assert.match(rendererSrc, /id="codexAuthToggle"/);
  assert.match(rendererSrc, /id="codexHistoryToggle"/);
  assert.match(rendererSrc, /保留官方登录/);
  assert.match(rendererSrc, /管理会话历史/);
  assert.doesNotMatch(rendererSrc, /id="codexHistoryMigrate"|id="codexHistoryRestore"/);
  assert.match(
    rendererSrc,
    /id="codexAuthToggle"[\s\S]*?checked=\{enhancements\.preserveOfficialLogin === true\}[\s\S]*?onToggle=\{handleAuth\}/,
    'official login preservation must remain an interactive preference'
  );
  assert.match(rendererSrc, /已有会话将归入 xwx_deck，切换服务后仍可见。操作前会备份/);
  assert.match(rendererSrc, /停止后不再自动迁移。可同时恢复迁移前分类/);
  assert.match(rendererSrc, /checkboxLabel: '恢复迁移前分类'/);
  assert.doesNotMatch(rendererSrc, /data-codex-mode=|data-client-config-toggle|codexActiveProvider|configure兼容服务|id="addProvider"/);
  assert.match(settingsPage, /aria-label="服务商名称"/);
  assert.match(settingsPage, /aria-label="地址"/);
  assert.match(settingsPage, /aria-label="密钥"/);
  assert.doesNotMatch(settingsPage, /服务商类型|ChatGPT 上游协议|PROVIDER_PROFILES/,
    'provider settings must expose only name, URL and key');
  assert.match(rendererStyles, /\.prov-save-bar\s*\{[\s\S]*?justify-content:\s*flex-end/,
    'provider cancel/save actions must stay right-aligned');
  assert.match(modelsPage, /const serviceName = providerDisplayName\(bridge\.compatibleServiceConfig\)/,
    'model configuration must use the saved provider display name');

  const claudeHandler = modelsPage.slice(
    modelsPage.indexOf('const handleClaudeService'),
    modelsPage.indexOf('const handleCodexService')
  );
  assert.match(claudeHandler, /if \(enabled && !guard兼容服务\(\)\) return;/);
  assert.ok(claudeHandler.indexOf('guard兼容服务()') < claudeHandler.indexOf('setBusyClaude(true)'));
  assert.ok(claudeHandler.indexOf('guard兼容服务()') < claudeHandler.indexOf('setModelService'));
  assert.doesNotMatch(claudeHandler, /await confirm\(/, 'enabling Claude 兼容服务 must not require a second confirmation');

  const codexHandler = modelsPage.slice(
    modelsPage.indexOf('const handleCodexService'),
    modelsPage.indexOf('const handleCodexModelChange')
  );
  assert.match(codexHandler, /if \(enabled && !guard兼容服务\(\)\) return;/);
  assert.ok(codexHandler.indexOf('guard兼容服务()') < codexHandler.indexOf('setServices({ ...previous, codex: enabled })'));
  assert.ok(codexHandler.indexOf('guard兼容服务()') < codexHandler.indexOf('setBusyCodex(true)'));
  assert.ok(codexHandler.indexOf('guard兼容服务()') < codexHandler.indexOf('setModelService'));
  assert.doesNotMatch(codexHandler, /await confirm\(/, 'enabling ChatGPT 兼容服务 must not require a second confirmation');
  assert.doesNotMatch(codexHandler, /isChatGptRunning/,
    'provider switching must not add a process-detection dependency to a valid configuration write');
  assert.match(codexHandler, /当前任务未生效时，请重新打开 ChatGPT/,
    'provider switching must give one conditional manual-restart instruction');

  assert.doesNotMatch(xwxDeckController, /ensureCodexGatewayForCurrentService/);
  const startSection = xwxDeckController.slice(
    xwxDeckController.indexOf('async start()'),
    xwxDeckController.indexOf('async toggle()')
  );
  assert.match(startSection, /this\.codexGatewayEnabled = false/);
  assert.doesNotMatch(startSection, /setModelService|updateCodexConfig|ensureCodexGatewayForCurrentService/);
  assert.match(rendererSrc, /updateTraceDirectories/);
  assert.match(rendererSrc, /id="traceDataPath"/);
  assert.match(rendererSrc, /id="traceLogPath"/);
  assert.match(rendererSrc, /id="changeDataFolder"/);
  assert.match(settingsPage, /aria-disabled=\{tracing \|\| undefined\}/,
    'the Trace directory action must remain present and focusable while Trace is active');
  assert.match(rendererStyles, /\.trace-row-action\[aria-disabled="true"\] svg \{ opacity: 0; transform: scale\(\.82\); \}/,
    'the active Trace directory icon must stay hidden until the row is hovered or focused');
  assert.match(rendererStyles, /\.trace-row:hover \.trace-row-action\[aria-disabled="true"\] svg,[\s\S]*?opacity: 1; transform: scale\(1\); \}/,
    'hovering or focusing the active Trace directory row must match the log-directory icon strength');
  assert.match(rendererStyles, /\.trace-row-action:hover:not\(:disabled\) \{ background: var\(--surface\); color: var\(--ink\); box-shadow: var\(--shadow-soft\); \}/,
    'the active Trace and log directory actions must share the same button hover feedback');
  assert.doesNotMatch(rendererStyles, /\.trace-row-action:hover[^{]*aria-disabled/,
    'the Trace directory aria-disabled explanation state must not suppress hover feedback');
  assert.match(settingsPage, /请先停止 Trace，再修改数据目录/,
    'the active Trace directory action must explain why the path cannot change yet');
  assert.match(rendererSrc, /id="clearHistory"/);
  assert.match(repairCenter, /id="repairCenterTrigger"/);
  assert.match(repairCenter, /id="quickRepairApplication"/);
  assert.match(repairCenter, /id="resetApplication"/);
  assert.match(repairCenter, /<Dialog\.Title>诊断与修复<\/Dialog\.Title>/);
  assert.match(repairCenter, /删除 XwX Deck 缓存（含模型目录）和更新残留/);
  assert.match(settingsPage, /Claude settings\.json \/ claude\.json 和 ChatGPT config\.toml \/ auth\.json/);
  assert.match(settingsPage, /checkboxLabel: '同时删除 Claude 与 ChatGPT 的核心配置'/);
  assert.match(settingsPage, /核心配置由客户端下次启动时自行生成/,
    'reset must leave client regeneration to Claude and ChatGPT');
  assert.doesNotMatch(rendererSrc, /openStorageFolder/);
  assert.match(rendererSrc, />开机启动</);
  assert.match(rendererSrc, /id="startupToggle"/);
  assert.match(rendererSrc, /setStartupEnabled/);
  assert.match(rendererSrc, /id="versionUpdateCue"/);
  assert.doesNotMatch(rendererSrc, /启用 XwX Trace 以使用该模型|启用 XwX Trace 以切换模型|开启 XwX Trace 后即可使用/);
  assert.match(rendererSrc, /已切换至 \$\{serviceName\}。当前任务未生效时，请重新打开 ChatGPT。/,
    'provider switching must explain the loaded-task boundary without forcing a restart');
  assert.match(rendererSrc, /已切回官方服务。/);
  assert.match(rendererSrc, /已选择 \$\{choice\.label\}；协议由 XwX Deck 自动适配。/);
  assert.match(rendererSrc, /modelContextWindow: choice\.contextWindow/,
    'the selected display variant must persist its numeric window separately from the model id');
  assert.match(rendererSrc, /协议由 XwX Deck 自动适配/);
  assert.doesNotMatch(settingsPage, /showToast\(`发现新版本 \$\{next\.targetVersion\}`, 'success'\)/, 'the actionable update toast must be the sole new-version notification');
  assert.match(rendererSrc, /恢复迁移前分类/);
  assert.match(updateNotification, /timeout:\s*5_000/, 'new-version toast must close after five seconds');
  assert.doesNotMatch(updateNotification, /timeout:\s*15_000/);
  const restartConfirmation = settingsPage.slice(
    settingsPage.indexOf('const confirmReadyUpdate'),
    settingsPage.indexOf('const handleUpdateClick')
  );
  assert.match(restartConfirmation, /await confirm\(/, 'ready update action must ask for confirmation');
  assert.match(restartConfirmation, /if \(!proceed\) return;/);
  assert.match(restartConfirmation, /await bridge\.api\.restartAndInstall\(\)/);
  assert.match(restartConfirmation, /manual \? '打开安装包' : '重启更新'/);
  const updateClickHandler = settingsPage.slice(
    settingsPage.indexOf('const handleUpdateClick'),
    settingsPage.indexOf('React.useEffect(() => {', settingsPage.indexOf('const handleUpdateClick'))
  );
  assert.match(updateClickHandler, /confirmReadyUpdate\(updateState\.targetVersion/);
  assert.doesNotMatch(updateClickHandler, /restartAndInstall\(\)/, 'ready-state clicks must not quit without confirmation');
  assert.match(rendererSrc, /className="brand">XwX Deck</);
  assert.doesNotMatch(rendererSrc, /id="updateStatus"|id="checkUpdate"/);
  assert.doesNotMatch(rendererSrc, /keepOpenAiLogin|gptProxy/);
  assert.match(ipcHandlers, /const handlers:\s*Record<string, InvokeHandler>/);
  assert.match(ipcHandlers, /const requireController/);
  assert.match(ipcHandlers, /xwxdeck:set-startup-enabled/);
  assert.match(startup, /setLoginItemSettings/);
  assert.match(startup, /STARTUP_HIDDEN_ARG/, 'startup must expose the hidden-launch argument');
  // The literal lives in the electron-free startupRegistration module so the
  // reset path can filter it out of relaunch args without importing `app`.
  {
    const startupRegistration = await fs.readFile(
      path.resolve('src', 'main', 'app', 'startupRegistration.ts'),
      'utf8'
    );
    assert.match(startupRegistration, /STARTUP_HIDDEN_ARG = '--hidden'/);
    const applicationReset = await fs.readFile(
      path.resolve('src', 'main', 'app', 'applicationReset.ts'),
      'utf8'
    );
    assert.doesNotMatch(applicationReset, /from '\.\/startup'/,
      'the reset path must stay importable without Electron');
    assert.match(applicationReset, /STARTUP_HIDDEN_ARG/,
      'reset relaunch args must drop the hidden-launch flag so onboarding is visible');
  }
  assert.match(startup, /process\.platform === 'darwin'/, 'packaged macOS builds must support login items');
  assert.match(main, /isStartupHiddenLaunch/);
  assert.match(runtime, /app\.on\('activate'/, 'macOS Dock activation must re-open the manager');
  assert.match(tray, /trayTemplate\.png/, 'macOS must use a transparent menu-bar template icon');
  assert.match(tray, /setTemplateImage\(template\)/);
  assert.doesNotMatch(tray, /createFromDataURL/, 'tray fallback must not depend on Electron SVG decoding');
  assert.match(updater, /process\.platform === 'darwin'/, 'packaged macOS builds must support manual DMG update checks');
  assert.match(updater, /installMode:\s*this\.manualMac \? 'manual-dmg' : 'automatic'/);
  assert.doesNotMatch(updater, /MacUpdater/, 'unsigned macOS builds must not use automatic MacUpdater replacement');
  assert.doesNotMatch(bootstrap, /disable-gpu|disableHardwareAcceleration/);
  assert.match(runtime, /child-process-gone/);
  assert.doesNotMatch(rendererSrc, /setUpdateChannel|data-update-channel|stage 提前体验/);
  assert.doesNotMatch(preload, /set-update-channel|setUpdateChannel/);
  assert.doesNotMatch(mainProcess, /set-update-channel|setUpdateChannel/);
  assert.match(managerWindow, /transparent:\s*false/);
  assert.match(managerWindow, /DEFAULT_WIDTH\s*=\s*1040/);
  assert.match(managerWindow, /DEFAULT_HEIGHT\s*=\s*560/);
  assert.match(managerWindow, /useContentSize:\s*true/);
  assert.match(managerWindow, /fitContentSize\(win, targetContentWidth, targetContentHeight\)/);
  assert.match(managerWindow, /creating a fresh manager window after renderer exit/);
  assert.doesNotMatch(managerWindow, /reloadIgnoringCache/);
  assert.match(managerWindow, /win\.hide\(\)/);
  assert.match(rendererSrc, /isDesktop\(\) \? null : canvas\.getContext\('webgl'/);
  assert.doesNotMatch(rendererSrc, /SyncPage|page-sync|配置同步|Excel 转 Markdown/);
  assert.doesNotMatch(preload, /config-sync|excel-progress|convertExcel|chooseExcel|openExcel|readExcel/);
  assert.doesNotMatch(ipcHandlers, /config-sync|excel-progress|convert-excel|choose-excel|open-excel|read-excel/);
  assert.doesNotMatch(runtime, /ConfigSyncService/);
  completed.push('public manager IPC and release-only contract');
}

async function testViewerMessageContract(): Promise<void> {
  const html = renderTapViewerHtml({
    mode: 'static',
    state: { active: false, rootPath: 'qa', sessions: [], traces: [] }
  });
  assert.match(html, /class="msg-role"/);
  assert.match(html, /BODY\.SYSTEM/);
  assert.match(html, /messageRoleLabel\('MESSAGES'/,
    'message carrier labels must be derived by the shared exact-carrier helper');
  assert.match(html, /class="pill '\+entry\.roleClass/);
  assert.doesNotMatch(html, /section\('system',L\('System Prompt'/);
  assert.match(html, /role === 'developer'/);
  assert.match(html, /m\.text \?\? m\.input_text \?\? m\.output_text/);
  assert.match(html, /block\.text \?\? block\.content \?\? block\.input_text \?\? block\.output_text/);
  assert.match(html, /filter\(x => x !== undefined && x !== null\)/);
  assert.match(html, /function forwardedEndpoint\(t\)/);
  assert.match(html, /function requestEndpoint\(t\)/);
  assert.match(html, /new URL\(String\(raw\)\)/, 'trace header must retain the exact forwarded upstream endpoint');
  assert.match(html, /u\.host \+ u\.pathname \+ u\.search/, 'trace header must show the final upstream host and path');
  assert.doesNotMatch(html, /route-arrow|upstream-tag upstream-/,
    'the trace header should show only the final upstream endpoint, without proxy routing chrome');
  assert.match(html, /section\('system','System',renderSystem\(t\),true/,
    'an original System field must be expanded by default in the reading view');
  assert.match(html, /if\(p === 'openai-chat-completions'\) return '\/v1\/chat\/completions'/);
  assert.match(html, /if\(p === 'anthropic-messages'\) return '\/v1\/messages'/);
  assert.doesNotMatch(html, /openai · responses/, 'trace header must not repeat the protocol as a redundant vendor label');
  assert.match(html, /recommended_plugins/);
  assert.match(html, /AGENTS\\\.md instructions for/);
  assert.match(html, /本次模型请求以工具调用结束/);
  assert.match(html, /原始事件仍在下方 SSE Events 与“日志”中/,
    'the Read view must keep pointing readers to both the preserved SSE section and Log');
  assert.match(html, /function deferredLogProjection\(value, entries, basePath, deferSelf\)/,
    'Log formats must project high-volume fields into lightweight markers before rendering');
  assert.match(html, /'request\.body'[\s\S]*?'response\.body'[\s\S]*?'response\.snapshot'[\s\S]*?'sse\.events'[\s\S]*?'sse\.snapshot'/,
    'request/response bodies, snapshots and SSE events must share one default-fold policy');
  assert.match(html, /LOG_LONG_STRING_LIMIT = 16384/,
    'unexpected long strings must also be protected by the generic lazy-fold threshold');
  assert.match(html, /LOG_OPAQUE_KEYS = new Set/,
    'opaque encrypted, binary and attachment fields must use the same lazy-fold path');
  assert.match(html, /LOG_NESTED_CONTAINER_KEYS = new Set/,
    'structured request/response payloads must split into independently expandable child fields');
  assert.match(html, /'contents',[\s\S]*?'content',[\s\S]*?'functions'/,
    'item content must stay lazy instead of mounting its child blocks when the item opens');
  assert.match(html, /LOG_ITEM_ARRAY_KEYS = new Set\(\['messages','input','tools','contents','functions'\]\)/,
    'conversation and tool arrays must use item-level disclosure instead of expanding the whole history');
  assert.match(html, /LOG_DEFAULT_CLOSED_KEYS = new Set\(\['content'\]\)/,
    'message content containers must remain collapsed when an item opens');
  assert.match(html, /function logNativeItemSummary\(value\)/,
    'item summaries must be derived from native type, role, name and call identifiers');
  assert.match(html, /function logItemPresentation\(value\)/,
    'Log items must receive presentation-only roles without changing their native data');
  assert.match(html, /type === 'message'\) return \{ itemClass:'log-item-message log-item-message-'\+role/,
    'native messages must receive stronger role-aware visual emphasis');
  assert.match(html, /\/\(\?:\^\|_\)call\$\/[\s\S]*?linkRole:'CALL'/,
    'tool calls must receive a compact CALL marker while retaining their call_id summary');
  assert.match(html, /_call_output\|tool_result\|function_response\|tool_search_output[\s\S]*?linkRole:'RESULT'/,
    'tool results must receive a compact RESULT marker while retaining their call_id summary');
  assert.match(html, /\.log-item-message>summary \.log-item-summary\{font-weight:750;color:var\(--text\)\}/,
    'message rows must stand out without introducing a new card or reordering layer');
  assert.match(html, /\.log-item-reasoning>summary \.log-item-summary\{color:var\(--amber\);font-weight:500\}/,
    'reasoning rows must match the Read view thinking color while retaining lighter weight');
  assert.match(html, /\.log-item-tool-result>summary \.log-item-summary\{color:var\(--amber\);font-weight:550\}/,
    'tool results must match the Read view tool-result color in JSON and PRETTY');
  assert.match(html, /const itemClass = marker\.itemClass \? ' '\+esc\(marker\.itemClass\) : ''/,
    'JSON and PRETTY folds must apply the same presentation classes');
  assert.match(html, /function logConversationActivityStart\(items\)/,
    'conversation arrays must identify the current user/tool-result tail');
  assert.match(html, /openStart >= 0 && index >= openStart/,
    'only the current activity tail should default open');
  assert.doesNotMatch(html, /\['yaml','YAML'\]|yamlTree|yaml-node|yaml-log-field/,
    'the redundant YAML log format and its private rendering system must be removed');
  assert.match(html, /toPretty\(projected\.value\)/,
    'PRETTY must render the lightweight projection instead of full high-volume fields');
  assert.match(html, /\.pp-log-field>\.log-field-content\{[^}]*border:0[^}]*background:transparent/,
    'PRETTY lazy expansion must remain a flat continuation of the existing grid');
  assert.match(html, /format === 'pretty'\) content\.innerHTML = toPretty\(projected,entry\.path\)/,
    'PRETTY hydration must not add a nested trace-pretty card');
  assert.match(html, /traceToCurl\(t\)/,
    'cURL must remain the explicit full-wire request view');
  assert.match(html, /rawBody \|\| \(parsedBody !== undefined \? JSON\.stringify\(parsedBody\) : ''\)/,
    'cURL must prefer the captured raw body over a re-serialized parsed object');
  assert.match(html, /class="trace-curl"/,
    'cURL must retain its dedicated full-wire text panel');
  assert.doesNotMatch(html, /deferredLogAppendix/,
    'folded fields must stay at their original hierarchy location instead of moving to a bottom appendix');
  assert.doesNotMatch(html, /请求正文|响应正文|默认折叠字段|Collapsed by default/,
    'Log folds must use original field names instead of assistant-authored semantic labels');
  assert.match(html, /<details class="log-field-fold /,
    'deferred Log fields must render as closed details elements');
  assert.match(html, /<div class="log-field-content"><\/div>/,
    'deferred field content must not be embedded into initial Log HTML');
  assert.match(html, /deferredLogProjection\(entry\.value, logFieldCache\.entries, entry\.path, false\)/,
    'opening a deferred container must project its children for structured nested rendering');
  assert.match(html, /const pathKey = logFieldPath\(path\)/,
    'every lazy Log fold must carry a stable native JSON path');
  assert.match(html, /const pathKey = String\(marker\.pathKey \|\| '\$'\);/,
    'lazy folds must resolve their stable path from the marker before rendering');
  assert.match(html, /data-log-fold-path="'\+esc\(pathKey\)\+'"/,
    'rendered lazy folds must expose their stable path independently of transient marker indexes');
  assert.match(html, /logFolds: Object\.fromEntries\(Array\.from\(root\.querySelectorAll\('details\[data-log-fold-path\]'\)\)/,
    'detail redraws must capture every native-path Log fold, including hydrated deep nodes');
  assert.match(html, /logFolds: Object\.assign\(\{\},previous\.logFolds \|\| \{\},snapshot\.logFolds \|\| \{\}\)/,
    'lazy Log state must merge across partial hydration and JSON/PRETTY format switches');
  assert.match(html, /function logFoldOpen\(format,pathKey,defaultOpen\)[\s\S]*?Object\.prototype\.hasOwnProperty\.call\(cachedFolds,foldKey\)/,
    'all Log nodes must restore state from their stable path after a live redraw');
  assert.match(html, /rememberDetailUiState\(trace\.id,\{[\s\S]*?logFolds:/,
    'opening or closing any Log fold must persist immediately instead of waiting for the next redraw');
  assert.match(html, /format === 'pretty'[\s\S]*?toPretty\(projected,entry\.path\)[\s\S]*?jsonTreeRows\(projected,1,entry\.path\)/,
    'hydration must preserve JSON or PRETTY structure instead of dumping one raw JSON string');
  assert.match(html, /function jsonTreeRows\(value,depth,path\)/,
    'expanded deferred JSON containers must continue with their children instead of duplicating the same root path');
  assert.match(html, /details:not\(\[data-log-fold-path\]\)/,
    'generic label-and-ordinal fold restoration must not override native-path Log state');
  // Every fold now builds its attributes through one helper, so the invariant is
  // that the helper emits path + format + default, and that the JSON tree uses it.
  assert.match(html, /function logFoldAttrs\(format,pathKey,defaultOpen\)/,
    'all Log folds must share one attribute builder so path, format and default cannot drift apart');
  assert.match(html, /data-log-fold-path="'\+esc\(pathKey\)\+'" data-log-format="'\+esc\(format\)\+'"/,
    'ordinary JSON containers must expose their native path, not only deferred fields');
  assert.match(html, /data-log-fold-default="'\+\(isDefaultOpen \? '1' : '0'\)\+'"/,
    'a fold must publish its default so the redraw snapshot can store only user changes');
  assert.match(html, /logFoldAttrs\('json',pathKey,/,
    'the JSON tree must go through the shared attribute builder');
  assert.match(html, /logFoldAttrs\('pretty',pathKey,/,
    'ordinary PRETTY containers must expose their native path through the same builder');
  assert.match(html, /\.json-log-field>\.log-field-content\{[^}]*padding:0[^}]*border:0[^}]*background:transparent/,
    'JSON lazy expansion must remain a flat hierarchy without nested card surfaces');
  assert.match(html, /depth < 2 && !LOG_DEFAULT_CLOSED_KEYS\.has\(String\(key \|\| ''\)\)/,
    'JSON content nodes must override the generic depth-based open default');
  assert.match(html, /depth < 2 && !LOG_DEFAULT_CLOSED_KEYS\.has\(String\(k\)\)/,
    'PRETTY content nodes must override the generic depth-based open default');
  assert.match(html, /if\(logFold\)\{[\s\S]*?if\(logFold\.open && logFold\.classList\.contains\('log-field-fold'\)\) hydrateDeferredLogFold\(logFold\)/,
    'every Log fold must persist on toggle while only deferred fields trigger hydration');
  assert.match(html, /content\.querySelectorAll\('details\.log-field-fold\[open\]'\)\.forEach\(hydrateDeferredLogFold\)/,
    'default-open activity items must hydrate recursively after their parent array opens');
  assert.match(html, /\.log-field-fold\[open\]>summary::before/,
    'the deferred-field disclosure caret must visibly track the expanded state');
  assert.match(html, /Claude 或 ChatGPT/);
  assert.doesNotMatch(html, /Claude 或 Codex/);
  assert.match(html, /dashHead\('duration', L\('耗时','Duration'\), 'num'\)/);
  assert.match(html, /function sessionDurationMs/);
  assert.match(html, /function sessionDurationText/);
  assert.match(html, /dash-dur/);
  assert.doesNotMatch(html, /sess\.updatedAt\s*=\s*\(typeof payload\.ts/,
    'a LIVE touch must never replace the persisted last request/completion time');
  assert.match(html, /sess\.liveAt\s*=\s*\(typeof payload\.ts/,
    'a LIVE touch must use a separate transient activity timestamp');
  assert.match(html, /\.sagroup\.nested\{/,
    'nested SubAgents must remain compact inset cards in the left rail');
  assert.match(html, /\.sagroup\.nested\{[^}]*border:0/,
    'nested SubAgent cards must drop their border; depth is fill + indent per the fill-tier convention');
  assert.match(html, /\.sagroup\.tier1\{background:var\(--rail-bg\)\}/,
    'tier1 must use the full sunk token; a near-white mix leaves borderless nesting indistinguishable');
  assert.doesNotMatch(html, /\.sagroup[^{]*\{[^}]*#[0-9a-fA-F]{3,6}[;}]/,
    'rail cards must use surface tokens instead of hardcoded white');
  assert.match(html, /\.sagroup:not\(\.open\)>\.sahead \.gkind\{display:none\}/,
    'collapsed cards must drop the role first so a long agent name is not truncated for the token summary');
  assert.match(html, /\.sagroup\.open>\.sahead \.gsum\{display:none\}/,
    'expanded SubAgent cards must hide redundant request/token summaries');
  assert.match(html, /\.metrics \.tw\{font-size:10px;color:var\(--faint\)/,
    'the metrics bar caret must reuse the leading .tw affordance shared by sec/tool heads');
  assert.match(html, /\.metrics\.open \.tw\{transform:rotate\(90deg\)\}/,
    'the metrics caret must rotate like sec/tool carets instead of swapping glyphs');
  assert.doesNotMatch(html, /mtw/,
    'the far-right absolutely positioned metrics caret must be gone');
  assert.match(html, /\.metrics-detail\{[^}]*padding-left:25px/,
    'metrics detail must inset with the head so both column rules stay on one line');
  assert.match(html, /xwxTraceMetricsOpen/,
    'metrics expand state must persist like sectionState');
  assert.match(html, /cw\.classList\.toggle\('open', metricsOpen\)/,
    'collapsing must clear .metrics-cw.open, otherwise max-height:none keeps the detail visible');
  // 模板字符串会把 \. 塌成 . ——曾让 compactRailNumber 的 /\.0$/ 变成 /.0$/，把 100k 显示成 1k。
  assert.doesNotMatch(html, /\.replace\(\/\.0\$\//,
    'an unescaped /.0$/ in the injected script eats real digits; escape it or use common.compactNumber');
  assert.doesNotMatch(html, /compactRailNumber/,
    'rail token totals must reuse common.compactNumber instead of a second compact-number ladder');
  assert.match(html, /dashHead\('status', L\('状态','Status'\), 'col-status'\)/);
  assert.match(html, /dashHead\('actions', L\('操作','Actions'\), 'col-del'\)/);
  assert.match(html, /\.dash\{max-width:1200px;margin:0 auto;padding:8px 24px 32px\}/,
    'the dashboard page must stay a centered column with side inset');
  assert.match(html, /\.dash-table thead th:nth-child\(2\),.dash-table tbody td\.dash-first\{width:158px;max-width:158px\}/,
    'the first-message column must keep its fixed default width');
  assert.match(html, /\.dash-first\{color:var\(--text\);font-size:13\.5px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/,
    'the first-message text must clip inside the current column width');
  assert.match(html, /const DASH_COL_DEFAULTS = \{ started:202, first:158, source:80, model:252, duration:88, requests:60, tokens:96, cost:82, status:56, actions:76 \}/,
    'dashboard columns must start from fixed default widths that fit the centered page');
  // The default widths have to survive a round trip through clampDashColWidth,
  // otherwise the first persisted resize silently rewrites them and the table
  // outgrows its container. Reproduced as a 2px overflow when first was 158
  // against a 160 minimum.
  {
    const defaults = html.match(/const DASH_COL_DEFAULTS = \{([^}]+)\}/)?.[1] ?? '';
    const mins = html.match(/const DASH_COL_MIN = \{([^}]+)\}/)?.[1] ?? '';
    const parse = (text: string): Record<string, number> => Object.fromEntries(
      text.split(',').map(part => {
        const [key, value] = part.split(':');
        return [key.trim(), Number(value)];
      })
    );
    const defaultWidths = parse(defaults);
    const minWidths = parse(mins);
    assert.ok(Object.keys(defaultWidths).length === 10, 'dashboard default widths must cover all ten columns');
    for (const [id, width] of Object.entries(defaultWidths)) {
      assert.ok(
        width >= minWidths[id],
        `dashboard default width for ${id} (${width}px) must not be below its ${minWidths[id]}px minimum`
      );
    }
  }
  assert.match(html, /data-col-resize/,
    'dashboard headers must expose a column-resize handle');
  assert.match(html, /xwxTraceDashCols/,
    'resized dashboard columns must persist independently of table rerenders');
  assert.match(html, /\.dash-table thead th\.col-del,.dash-table tbody td\.dash-del\{width:4\.75rem;min-width:4\.75rem;text-align:center;padding:10px 16px 10px 10px\}/,
    'the actions column must keep enough width and right inset so Windows Chrome does not clip 操作');
  assert.match(html, /\.dash-table thead th\.col-status,.dash-table tbody td\.col-status\{text-align:center\}/);
  assert.match(html, /\.dash-table tbody td\.col-status\{position:relative\}/);
  assert.match(html, /\.dash-status\{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding-bottom:1px/);
  const commonScript = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(commonScript, 'viewer must embed its common browser helper');
  const browserWindow: Record<string, unknown> = {};
  vm.runInNewContext(commonScript, { window: browserWindow });
  assert.equal(
    typeof (browserWindow.XwXWebview as { byId?: unknown } | undefined)?.byId,
    'function',
    'embedded browser helper must execute without main-bundle globals'
  );
  const scripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), match => match[1]);
  const viewerScript = scripts.at(-1) ?? '';
  new vm.Script(viewerScript, { filename: 'xwx-trace-viewer-inline.js' });
  const logFoldContext: Record<string, unknown> = {};
  // esc() is deliberately not extracted: its body contains the regex literal
  // /[&<>"']/g, and extractViewerFunction's brace scanner does not understand
  // regex literals, so the quote characters inside it desynchronise the scan and
  // it swallows the following declarations (including LOG_DEFAULT_CLOSED_KEYS).
  const logFoldFunctionNames = [
    'logPathPart',
    'logFieldPath',
    'logFoldPath',
    'logFoldOpen',
    'logFoldAttrs',
    'ppScalar',
    'ppKeyCell',
    'ppNestRow',
    'ppRows',
    'toPretty',
    'jsonTreeRows',
    'jsonTree'
  ];
  vm.runInNewContext(
    `const LOG_DEFAULT_CLOSED_KEYS=new Set(['content']);
     const detailUiCache=new Map([['trace-1',{logFolds:{
       'json|request.body.outer':true,
       'json|request.body.outer.inner':true,
       'json|request.body.outer.inner.deeper':true,
       'pretty|request.body.outer':true,
       'pretty|request.body.outer.inner':true,
       'pretty|request.body.outer.inner.deeper':true
     }}]]);
     function currentTrace(){return {id:'trace-1'};}
     function isDeferredLogMarker(){return false;}
     function deferredLogFoldHtml(){return '';}
     function esc(v){return String(v == null ? '' : v);}
     ${logFoldFunctionNames.map(name => extractViewerFunction(viewerScript, name)).join('\n')}
     this.api={jsonTree,toPretty};`,
    logFoldContext
  );
  const logFoldApi = logFoldContext.api as {
    jsonTree: (value: unknown, key?: string, depth?: number, path?: Array<string | number>) => string;
    toPretty: (value: unknown, path?: Array<string | number>) => string;
  };
  // Third level on purpose. Both renderers open the first two levels by default,
  // so an assertion on 'outer' or 'outer.inner' passes with an empty cache and
  // proves nothing about restoration.
  const redrawnLogValue = {
    insertedBefore: { changing: true },
    outer: { inner: { deeper: { leaf: 1 } } }
  };
  const openAttr = (format: string, path: string): RegExp => new RegExp(
    `data-log-fold-path="${path.replace(/[.\\[\]]/g, ch => `\\${ch}`)}" data-log-format="${format}"[^>]*\\bopen`
  );
  const redrawnJson = logFoldApi.jsonTree(redrawnLogValue, undefined, 0, ['request', 'body']);
  assert.match(redrawnJson, openAttr('json', 'request.body.outer'),
    'JSON redraws must reopen a deep branch by native path even when a sibling was inserted');
  assert.match(redrawnJson, openAttr('json', 'request.body.outer.inner'),
    'JSON redraws must preserve multiple expanded levels independently');
  assert.match(redrawnJson, openAttr('json', 'request.body.outer.inner.deeper'),
    'a third level is past both renderers default-open depth, so only a restored state can open it');
  const redrawnPretty = logFoldApi.toPretty(redrawnLogValue, ['request', 'body']);
  assert.match(redrawnPretty, openAttr('pretty', 'request.body.outer'),
    'PRETTY redraws must reopen a deep branch by native path even when a sibling was inserted');
  assert.match(redrawnPretty, openAttr('pretty', 'request.body.outer.inner'),
    'PRETTY redraws must preserve multiple expanded levels independently');
  assert.match(redrawnPretty, openAttr('pretty', 'request.body.outer.inner.deeper'),
    'PRETTY must restore past its own default depth too, which the two-level case could not show');

  // Format isolation: a cache holding only json keys must leave PRETTY closed at
  // the level json had open. Without the format prefix this passed either way.
  const isolatedContext: Record<string, unknown> = {};
  vm.runInNewContext(
    `const LOG_DEFAULT_CLOSED_KEYS=new Set(['content']);
     const detailUiCache=new Map([['trace-1',{logFolds:{'json|request.body.outer.inner.deeper':true}}]]);
     function currentTrace(){return {id:'trace-1'};}
     function isDeferredLogMarker(){return false;}
     function deferredLogFoldHtml(){return '';}
     function esc(v){return String(v == null ? '' : v);}
     ${logFoldFunctionNames.map(name => extractViewerFunction(viewerScript, name)).join('\n')}
     this.api={jsonTree,toPretty};`,
    isolatedContext
  );
  const isolated = isolatedContext.api as typeof logFoldApi;
  assert.match(
    isolated.jsonTree(redrawnLogValue, undefined, 0, ['request', 'body']),
    openAttr('json', 'request.body.outer.inner.deeper'),
    'the json-prefixed entry must open the json tree'
  );
  assert.doesNotMatch(
    isolated.toPretty(redrawnLogValue, ['request', 'body']),
    openAttr('pretty', 'request.body.outer.inner.deeper'),
    'a json-only cache must not open the same path in PRETTY; the format prefix is what keeps them apart'
  );

  // A key containing the separator must not collide with real nesting: {"a.b":…}
  // and {"a":{"b":…}} used to produce the identical fold key, so expanding one
  // expanded the other. Only the dotted key is cached here.
  const collisionContext: Record<string, unknown> = {};
  vm.runInNewContext(
    `const LOG_DEFAULT_CLOSED_KEYS=new Set(['content']);
     const detailUiCache=new Map([['trace-1',{logFolds:{'json|root.a%2Eb':true}}]]);
     function currentTrace(){return {id:'trace-1'};}
     function isDeferredLogMarker(){return false;}
     function deferredLogFoldHtml(){return '';}
     function esc(v){return String(v == null ? '' : v);}
     ${logFoldFunctionNames.map(name => extractViewerFunction(viewerScript, name)).join('\n')}
     this.api={jsonTree,toPretty};`,
    collisionContext
  );
  const collision = collisionContext.api as typeof logFoldApi;
  const collisionHtml = collision.jsonTree(
    { 'a.b': { dotted: 1 }, a: { b: { nested: 1 } } },
    undefined,
    2,
    ['root']
  );
  assert.match(collisionHtml, openAttr('json', 'root.a%2Eb'),
    'the dotted key must own its own encoded fold path');
  assert.doesNotMatch(collisionHtml, openAttr('json', 'root.a.b'),
    'nesting a then b must not inherit the dotted key state');
  const logicalConversationSessionsMatch = /^function logicalConversationSessions\s*\([\s\S]*?\n\}/m.exec(viewerScript);
  assert.ok(logicalConversationSessionsMatch,
    'the dashboard must expose its logical Conversation grouping for provider-transition regression coverage');
  const logicalConversationContext: Record<string, unknown> = {};
  vm.runInNewContext(
    `function sessionSource(session){return session && session.source;}
     function isInternalMaintenancePrompt(value){return /^internal:/i.test(String(value || ''));}
     function mergeModelUsage(target){return target || {};}
     function mergeAuxiliaryCounts(target){return target || {};}
     ${logicalConversationSessionsMatch![0]};
     this.logicalConversationSessions=logicalConversationSessions;`,
    logicalConversationContext
  );
  const logicalConversationSessions = logicalConversationContext.logicalConversationSessions as (
    sessions: Array<Record<string, any>>
  ) => Array<Record<string, any>>;
  const groupedProviderSwitch = logicalConversationSessions([{
    id: 'visible-provider-fragment',
    source: 'codex-vscode',
    clientConversationKey: 'provider-thread',
    startedAt: '2026-08-03T08:00:00.000Z',
    updatedAt: '2026-08-03T08:01:00.000Z',
    lastRequestAt: '2026-08-03T08:00:45.000Z',
    durationMs: 45_000,
    traceCount: 2,
    firstPrompt: 'visible user request',
    lastTurnError: false
  }, {
    id: 'hidden-provider-fragment',
    source: 'codex-vscode',
    clientConversationKey: 'provider-thread',
    startedAt: '2026-08-03T08:02:00.000Z',
    updatedAt: '2026-08-03T08:03:00.000Z',
    lastRequestAt: '2026-08-03T08:02:30.000Z',
    durationMs: 30_000,
    traceCount: 1,
    hidden: true,
    auxiliary: 'memory',
    firstPrompt: 'internal: provider transition'
  }, {
    id: 'pure-hidden-maintenance',
    source: 'codex-vscode',
    clientConversationKey: 'maintenance-only',
    startedAt: '2026-08-03T08:04:00.000Z',
    updatedAt: '2026-08-03T08:05:00.000Z',
    traceCount: 1,
    hidden: true,
    auxiliary: 'memory',
    firstPrompt: 'internal: maintenance only'
  }]);
  assert.equal(groupedProviderSwitch.length, 1,
    'a pure hidden group must stay hidden while a hidden sibling of a visible Conversation is retained');
  assert.equal(groupedProviderSwitch[0]?.id, 'hidden-provider-fragment',
    'the newest physical fragment remains the logical representative even when it is hidden');
  assert.equal(groupedProviderSwitch[0]?.traceCount, 3,
    'dashboard totals must include provider-transition fragments from the same native Conversation');
  assert.equal(groupedProviderSwitch[0]?.lastTurnError, false,
    'a newer hidden auxiliary fragment must not replace the last visible main-turn status');
  assert.equal(groupedProviderSwitch[0]?.lastRequestAt, '2026-08-03T08:02:30.000Z');
  assert.equal(groupedProviderSwitch[0]?.durationMs, 150_000,
    'logical Conversation duration must use its first and last request starts instead of summing fragments');
  assert.deepEqual(
    Array.from(groupedProviderSwitch[0]?.fragmentIds || []),
    ['visible-provider-fragment', 'hidden-provider-fragment']
  );
  const deleteTargetCountMatch = /^function deleteTargetFragmentCount\s*\([\s\S]*?\n\}/m.exec(viewerScript);
  assert.ok(deleteTargetCountMatch,
    'the delete confirmation must expose a target count independent from visible dashboard grouping');
  const deleteTargetCountContext: Record<string, unknown> = {};
  vm.runInNewContext(
    `${deleteTargetCountMatch![0]};this.deleteTargetFragmentCount=deleteTargetFragmentCount;`,
    deleteTargetCountContext
  );
  const deleteTargetFragmentCount = deleteTargetCountContext.deleteTargetFragmentCount as (
    sessions: Array<Record<string, unknown>>,
    id: string
  ) => number;
  const deleteCountSessions = [{
    id: 'visible-a', source: 'codex-vscode', clientConversationKey: 'thread-delete'
  }, {
    id: 'visible-b', source: 'codex-vscode', clientConversationKey: 'thread-delete'
  }, {
    id: 'hidden-maintenance', source: 'codex-vscode', clientConversationKey: 'thread-delete', hidden: true
  }, {
    id: 'other-source', source: 'claude-vscode', clientConversationKey: 'thread-delete', hidden: true
  }, {
    id: 'other-thread', source: 'codex-vscode', clientConversationKey: 'thread-other', hidden: true
  }];
  assert.equal(deleteTargetFragmentCount(deleteCountSessions, 'visible-a'), 3,
    'delete confirmation must count hidden same-source fragments that TraceStore will also remove');
  assert.equal(deleteTargetFragmentCount(deleteCountSessions, 'other-source'), 1,
    'same conversation keys from another source must not inflate the delete target count');
  assert.match(viewerScript, /const fragments = deleteTargetFragmentCount\(state\.sessions \|\| \[\], sid\)/,
    'the confirmation copy must use the exact backend deletion target count');
  assert.match(viewerScript, /subParentGroupKey:parentGroupKey/,
    'sidebar metadata must retain the parent SubAgent card segment');
  assert.match(viewerScript, /for\(const key in lastSub\) delete lastSub\[key\]/,
    'a non-subagent request (including auxiliary probes) must close open SubAgent segments so the rail stays in chronological order');
  assert.match(viewerScript, /if\(parentKey && groupMeta\[parentKey\]\) ensureGroup\(parentKey\)\.entries\.push\(group\)/,
    'a resumed nested SubAgent must rebuild its missing ancestor chain as continuation cards, not surface as a top-level peer');
  assert.match(viewerScript, /groupKey: seq > 1 \? key \+ '#c' \+ seq : key/,
    'continuation cards need a distinct key or collapsing one would collapse its origin card too');
  assert.match(viewerScript, /L\('续接','cont\.'\)/,
    'continued SubAgent cards must use the approved branch-continuation copy');
  assert.match(html, /\.sahead \.gcont::before\{content:"↳"/,
    'continued SubAgent cards must use the approved branch arrow');
  const continuationStyle = /\.sahead \.gcont\{([^}]*)\}/.exec(html)?.[1] ?? '';
  assert.doesNotMatch(continuationStyle, /\bborder(?:-radius)?\s*:/,
    'the continuation marker must not regress to the boxed badge');
  const lineageMatch = /^function railGroupLineage\s*\([\s\S]*?\n\}/m.exec(viewerScript);
  const syncBranchMatch = /^function syncRailOpenBranch\s*\([\s\S]*?\n\}/m.exec(viewerScript);
  assert.ok(lineageMatch && syncBranchMatch,
    'the SubAgent rail must expose a branch switch helper that preserves chronological order');
  const branchFunctions: Record<string, unknown> = {};
  vm.runInNewContext(
    `${lineageMatch![0]};${syncBranchMatch![0]};this.syncRailOpenBranch=syncRailOpenBranch;`,
    branchFunctions
  );
  const syncRailOpenBranch = branchFunctions.syncRailOpenBranch as (
    key: string,
    meta: Record<string, { parentKey?: string }>,
    open: Record<string, unknown>,
    active: string[]
  ) => string[];
  const openRailBranches: Record<string, unknown> = { parentA: {}, childA: {} };
  let activeRailBranch = syncRailOpenBranch(
    'topB',
    { parentA: {}, childA: { parentKey: 'parentA' }, topB: {} },
    openRailBranches,
    ['parentA', 'childA']
  );
  assert.equal(activeRailBranch.join(','), 'topB');
  assert.deepEqual(Object.keys(openRailBranches), [],
    'switching to another top-level SubAgent must close the earlier branch instead of appending future requests above it');
  openRailBranches.topB = {};
  activeRailBranch = syncRailOpenBranch(
    'childA',
    { parentA: {}, childA: { parentKey: 'parentA' }, topB: {} },
    openRailBranches,
    activeRailBranch
  );
  assert.equal(activeRailBranch.join(','), 'parentA,childA');
  assert.deepEqual(Object.keys(openRailBranches), [],
    'returning to an earlier branch must force a continuation card at the current timeline position');
  const buildRailGroupsMatch = /^function buildRailGroups\s*\([\s\S]*?\n\}/m.exec(viewerScript);
  const collectRailGroupsMatch = /^function collectRailGroupsInOrder\s*\([\s\S]*?\n\}/m.exec(viewerScript);
  assert.ok(buildRailGroupsMatch && collectRailGroupsMatch,
    'the SubAgent rail grouping implementation must be available for an order-preserving regression');
  const railGroupingFunctions: Record<string, unknown> = {};
  vm.runInNewContext(
    `function logicalInfo(trace){return trace.info || {}};
     function subagentName(trace){return trace.subagent || 'Subagent'};
     function shortAgentId(value){return String(value || '').slice(-6)};
     function isPlaceholderAgentName(value){return !value || value === 'Subagent'};
     ${lineageMatch![0]};${syncBranchMatch![0]};${buildRailGroupsMatch![0]};${collectRailGroupsMatch![0]};
     this.buildRailGroups=buildRailGroups;`,
    railGroupingFunctions
  );
  const buildRailGroups = railGroupingFunctions.buildRailGroups as (
    list: Array<Record<string, any>>
  ) => Array<Record<string, any>>;
  const flattenRailTraceIds = (entries: Array<Record<string, any>>): string[] => entries.flatMap(entry =>
    entry.kind === 'sagroup'
      ? flattenRailTraceIds(entry.entries || [])
      : [String(entry.trace?.id || '')]
  );
  const interleavedRail = buildRailGroups([
    { id: '1', subagent: 'Subagent', info: { subGroupKey: 'parent-a', subIdentity: 'agent-a' } },
    { id: '2', subagent: 'Subagent', info: { subGroupKey: 'child-a', subParentGroupKey: 'parent-a', subIdentity: 'agent-a-child' } },
    { id: '3', subagent: 'Subagent', info: { subGroupKey: 'agent-b', subIdentity: 'agent-b' } },
    { id: '4', subagent: 'Subagent', info: { subGroupKey: 'child-a', subParentGroupKey: 'parent-a', subIdentity: 'agent-a-child' } },
    { id: '5' }
  ]);
  assert.equal(
    flattenRailTraceIds(interleavedRail).join(','),
    '1,2,3,4,5',
    'nested and interleaved SubAgent cards must never render a later request before an earlier request'
  );
  {
    // 默认侧栏宽度在 CSS（--rail-live-w 初始值）和 JS（railWidth 初值）里各写一份，必须相等，
    // 否则首屏 DOM 宽度与 JS 状态不符，第一次拖拽会跳一下。
    const cssWidth = /--rail-live-w:(\d+)px/.exec(html)?.[1];
    const jsWidth = /railWidth = (\d+)/.exec(viewerScript)?.[1];
    assert.ok(cssWidth && jsWidth, 'both the CSS and JS default rail widths must be present');
    assert.equal(jsWidth, cssWidth, 'the JS railWidth default must match the --rail-live-w CSS default');
  }
  assert.match(viewerScript, /railGroupHtml\(entry, \(Number\(depth\) \|\| 0\) \+ 1\)/,
    'nested SubAgent cards must recurse with an incrementing depth, not a nested boolean');
  assert.match(viewerScript, /' tier'\+\(d % 2\)/,
    'card depth must drive an alternating fill tier so any depth stays distinguishable');
  assert.doesNotMatch(viewerScript, /groupLabel\s*\+\s*['"]\.S/,
    'the simplified sidebar must not expose S1/S1.1 hierarchy numbers');
  const ordinalMatch = /^function stableTraceOrdinal\s*\([\s\S]*?\n\}/m.exec(viewerScript);
  assert.ok(ordinalMatch, 'viewer must keep a pagination-independent trace ordinal helper');
  const orderMatch = /^function compareTraceDisplayOrder\s*\([\s\S]*?\n\}/m.exec(viewerScript);
  assert.ok(orderMatch, 'viewer must keep display order independent from logical grouping');
  const ordinalFunctions: Record<string, unknown> = {};
  vm.runInNewContext(`${ordinalMatch![0]};${orderMatch![0]};function compareTraceStart(){return 0};this.stableTraceOrdinal=stableTraceOrdinal;this.compareTraceDisplayOrder=compareTraceDisplayOrder;`, ordinalFunctions);
  const stableTraceOrdinal = ordinalFunctions.stableTraceOrdinal as (trace: { logicalTurn?: number; turn?: number }, fallback: number) => number;
  const compareTraceDisplayOrder = ordinalFunctions.compareTraceDisplayOrder as (a: { turn?: number }, b: { turn?: number }) => number;
  assert.equal(stableTraceOrdinal({ turn: 161 }, 1), 161, 'a tail-page trace must retain its persisted turn');
  assert.equal(stableTraceOrdinal({ logicalTurn: 162, turn: 1 }, 1), 162,
    'a merged conversation must prefer its cross-fragment logical ordinal over the repeated physical turn');
  assert.equal(stableTraceOrdinal({}, 7), 7, 'legacy traces without a turn retain a deterministic fallback');
  assert.equal(
    [{ turn: 18 }, { turn: 20 }, { turn: 19 }].sort(compareTraceDisplayOrder).map(trace => trace.turn).join(','),
    '18,19,20',
    'logical grouping must not reorder persisted trace turns'
  );
  const liveBucketMatch = /^function liveTraceBucketSessionId\s*\([\s\S]*?\n\}/m.exec(viewerScript);
  const mergeTraceMatch = /^function mergeTrace\s*\([\s\S]*?\n\}/m.exec(viewerScript);
  const mergeLiveTraceMatch = /^function mergeLiveTrace\s*\([\s\S]*?\n\}/m.exec(viewerScript);
  assert.ok(liveBucketMatch && mergeTraceMatch && mergeLiveTraceMatch,
    'viewer live merging must expose testable logical-bucket and physical-summary behavior');
  const liveConversationState = {
    currentSessionId: 'physical-a',
    sessions: [{
      id: 'physical-a',
      startedAt: '2026-08-03T08:00:00.000Z',
      updatedAt: '2026-08-03T08:00:01.000Z',
      traceCount: 1,
      jsonlPath: '',
      source: 'codex-vscode',
      clientConversationKey: 'conversation-live-key',
      totalTokens: 0,
      errorCount: 0
    }],
    sessionTraces: {
      'physical-a': [{
        id: 'physical-a-1529',
        sessionId: 'physical-a',
        turn: 1,
        logicalTurn: 1529,
        startedAt: '2026-08-03T08:00:00.000Z',
        completedAt: '2026-08-03T08:00:01.000Z',
        source: 'codex-vscode',
        clientConversationKey: 'conversation-live-key'
      }]
    }
  };
  const liveConversationMeta = {
    'physical-a': {
      offset: 1528,
      limit: 160,
      total: 1529,
      hasMoreBefore: true,
      hasMoreAfter: false
    }
  };
  const liveMergeContext: Record<string, any> = {
    state: liveConversationState,
    sessionTraceMeta: liveConversationMeta,
    routeReplaceCount: 0
  };
  vm.runInNewContext(
    `let state=this.state;
     let sessionTraceMeta=this.sessionTraceMeta;
     let view='session';
     let selectedSessionId='physical-a';
     let selectedId='physical-a-1529';
     let followLatest=true;
     function sessionSource(session){return session && session.source;}
     function totalTokens(){return 0;}
     function traceIsError(){return false;}
     function firstUserPrompt(){return 'live request';}
     function accumUsageByModel(previous){return previous;}
     function generatedTitleOf(){return '';}
     function compareTraceStart(a,b){return String(a&&a.startedAt||'').localeCompare(String(b&&b.startedAt||''));}
     function replaceSessionRouteContext(){this.routeReplaceCount+=1;this.selectedId=selectedId;}
     ${ordinalMatch![0]};${orderMatch![0]};${liveBucketMatch![0]};${mergeTraceMatch![0]};${mergeLiveTraceMatch![0]};
     this.mergeLiveTrace=mergeLiveTrace;
     this.getSelectedId=()=>selectedId;`,
    liveMergeContext
  );
  const mergeLiveTrace = liveMergeContext.mergeLiveTrace as (
    trace: Record<string, any>,
    wasAtNewest: boolean
  ) => string;
  const makeLivePhysicalTrace = (
    id: string,
    turn: number,
    startedAt: string,
    source = 'codex-vscode',
    clientConversationKey = 'conversation-live-key',
    sessionId = 'physical-b'
  ): Record<string, any> => ({
    id,
    sessionId,
    turn,
    startedAt,
    completedAt: new Date(Date.parse(startedAt) + 100).toISOString(),
    source,
    clientConversationKey,
    client: 'ChatGPT',
    request: { model: 'gpt-test' },
    response: { statusCode: 200 }
  });
  assert.equal(
    mergeLiveTrace(makeLivePhysicalTrace('physical-b-1', 1, '2026-08-03T08:03:00.000Z'), true),
    'physical-a',
    'a new physical Session with the same source/key must merge into the open logical Conversation'
  );
  assert.equal(
    mergeLiveTrace(makeLivePhysicalTrace('physical-b-2', 2, '2026-08-03T08:02:00.000Z'), true),
    'physical-a'
  );
  assert.deepEqual(
    liveConversationState.sessionTraces['physical-a'].map(trace => trace.logicalTurn),
    [1529, 1530, 1531],
    'reversed completion timestamps must not render logical turns as 1529, 1531, 1530'
  );
  assert.equal(liveMergeContext.getSelectedId(), 'physical-b-2',
    'follow-latest must select a same-Conversation trace even when it belongs to a new physical Session');
  assert.equal(liveConversationState.sessions.find(session => session.id === 'physical-a')?.traceCount, 1,
    'merging the logical bucket must not inflate the selected physical Session summary');
  assert.equal(liveConversationState.sessions.find(session => session.id === 'physical-b')?.traceCount, 2,
    'the new physical Session must retain its own independently updated summary');
  assert.equal(
    liveConversationState.sessions.find(session => session.id === 'physical-b')?.startedAt,
    '2026-08-03T08:02:00.000Z'
  );
  assert.equal(
    liveConversationState.sessions.find(session => session.id === 'physical-b')?.lastRequestAt,
    '2026-08-03T08:03:00.000Z'
  );
  assert.equal(
    liveConversationState.sessions.find(session => session.id === 'physical-b')?.durationMs,
    60_000,
    'live summaries must calculate request span independently of completion arrival order'
  );

  const selectedBucketLength = liveConversationState.sessionTraces['physical-a'].length;
  assert.equal(
    mergeLiveTrace(makeLivePhysicalTrace(
      'different-source', 1, '2026-08-03T08:04:00.000Z', 'claude-vscode',
      'conversation-live-key', 'physical-c'
    ), true),
    'physical-c',
    'matching keys from different sources must remain separate'
  );
  assert.equal(
    mergeLiveTrace(makeLivePhysicalTrace(
      'different-key', 1, '2026-08-03T08:05:00.000Z', 'codex-vscode',
      'another-conversation-key', 'physical-d'
    ), true),
    'physical-d',
    'matching sources with different client conversation keys must remain separate'
  );
  assert.equal(liveConversationState.sessionTraces['physical-a'].length, selectedBucketLength,
    'unrelated live traces must not enter the open logical Conversation bucket');
  const timelineChoiceMatch = /^function timelineDiffChoices\s*\([\s\S]*?\n\}/m.exec(viewerScript);
  assert.ok(timelineChoiceMatch, 'viewer must expose every earlier persisted turn as a compare candidate');
  const timelineChoiceFunctions: Record<string, unknown> = {};
  vm.runInNewContext(
    `const LIVE_MODE=true;${ordinalMatch![0]};function requestLabel(value){return 'Request '+value};${timelineChoiceMatch![0]};this.timelineDiffChoices=timelineDiffChoices;`,
    timelineChoiceFunctions
  );
  const timelineDiffChoices = timelineChoiceFunctions.timelineDiffChoices as (
    list: Array<{ id: string; turn: number; auxiliary?: string; subagent?: string }>,
    current: { id: string; turn: number }
  ) => Array<{ id?: string; turn: number; label: string }>;
  const allTypeChoices = timelineDiffChoices([
    { id: 'title-1', turn: 1, auxiliary: 'title' },
    { id: 'subagent-2', turn: 2, subagent: 'explorer' },
    { id: 'tail-168', turn: 168 }
  ], { id: 'current-170', turn: 170 });
  assert.equal(allTypeChoices.length, 169, 'compare timeline must include unloaded turns instead of only the current page');
  assert.equal(allTypeChoices[0]?.id, 'title-1', 'title requests must remain selectable in compare mode');
  assert.equal(allTypeChoices[1]?.id, 'subagent-2', 'Subagent requests must remain selectable in compare mode');
  assert.equal(allTypeChoices[2]?.turn, 3, 'unloaded requests must keep a synthetic turn candidate');
  assert.equal(allTypeChoices[2]?.id, undefined, 'unloaded requests must not pretend to have a loaded trace id');
  assert.equal(allTypeChoices[167]?.id, 'tail-168', 'loaded tail-page requests must retain their real trace id');
  const diffLoadStart = viewerScript.indexOf('async function loadDiffTrace');
  const diffLoadEnd = viewerScript.indexOf('function timelineDiffChoices', diffLoadStart);
  assert.ok(diffLoadStart >= 0 && diffLoadEnd > diffLoadStart, 'viewer must define lazy compare trace loading');
  const diffLoadSource = viewerScript.slice(diffLoadStart, diffLoadEnd);
  assert.match(diffLoadSource, /fetchSessionPage\(sid, turn - 1, 1\)/,
    'selecting an unloaded compare candidate must fetch only that persisted request');
  assert.doesNotMatch(diffLoadSource, /mergeSessionPage\(/,
    'lazy compare loading must not corrupt the contiguous sidebar pagination window');
  assert.match(viewerScript, /for\(const item of timelineDiffChoices\(list, current\)\) addItem\(groups\[4\], item\)/,
    'all request types must flow through the unfiltered compare timeline');
  assert.match(viewerScript, /function renderDiffSection\(key, headerHtml, bodyHtml\)/,
    'compare sections must share a collapsible section renderer');
  assert.match(viewerScript, /<details class="diff-section" data-diff-section=/,
    'compare sections with bodies must render as native keyboard-accessible details');
  assert.match(viewerScript, /messagesHtml = renderDiffSection\('messages'/,
    'Messages comparison must be collapsible');
  assert.match(viewerScript, /paramsHtml = renderDiffSection\(/,
    'request-parameter comparison must be collapsible');
  assert.match(viewerScript, /systemHtml = renderDiffSection\(/,
    'System comparison must be collapsible');
  assert.match(viewerScript, /toolsHtml = renderDiffSection\(/,
    'Tools comparison must be collapsible');
  assert.match(viewerScript, /document\.addEventListener\('toggle',[\s\S]*diffSectionState\[section\.dataset\.diffSection\]/,
    'compare section collapse state must survive comparison rerenders');
  const semanticDiffNames = ['canonicalizeDiffValue', 'diffValueText', 'diffValueEqual'];
  let semanticDiffSource = '';
  for (const name of semanticDiffNames) {
    const match = new RegExp(`^function ${name}\\s*\\([\\s\\S]*?\\n\\}`, 'm').exec(viewerScript);
    assert.ok(match, `viewer must define ${name}`);
    semanticDiffSource += `${match![0]}\n`;
  }
  const semanticDiffFunctions: Record<string, unknown> = {};
  vm.runInNewContext(
    `function j(value){return JSON.stringify(value,null,2)};${semanticDiffSource};this.api={${semanticDiffNames.join(',')}};`,
    semanticDiffFunctions
  );
  const semanticDiffApi = semanticDiffFunctions.api as {
    canonicalizeDiffValue: (value: unknown) => any;
    diffValueEqual: (a: unknown, b: unknown) => boolean;
  };
  assert.equal(
    semanticDiffApi.diffValueEqual(
      { z: 1, nested: { b: 2, a: 1 }, rows: [{ y: 2, x: 1 }] },
      { rows: [{ x: 1, y: 2 }], nested: { a: 1, b: 2 }, z: 1 }
    ),
    true,
    'request parameter comparison must ignore object key order recursively'
  );
  assert.equal(
    semanticDiffApi.diffValueEqual({ rows: ['first', 'second'] }, { rows: ['second', 'first'] }),
    false,
    'request parameter comparison must preserve array order'
  );
  const canonical = semanticDiffApi.canonicalizeDiffValue({ z: 1, a: { y: 2, b: 1 } });
  assert.equal(Object.keys(canonical).join(','), 'a,z', 'compare preview must sort top-level object keys');
  assert.equal(Object.keys(canonical.a).join(','), 'b,y', 'compare preview must sort nested object keys');
  assert.match(viewerScript, /if\(!diffValueEqual\(oldB\[k\], newB\[k\]\)\) fieldChanges\.push/,
    'request parameter change detection must use semantic JSON equality');
  assert.match(viewerScript, /return j\(canonicalizeDiffValue\(v\)\)/,
    'changed request parameters must render with stable object-key order');
  assert.match(viewerScript, /const list = Array\.from\(byId\.values\(\)\)\.sort\(compareTraceDisplayOrder\)/,
    'page merges must use the same stable order as rendered traces');
  const providerInferenceFunctions: Record<string, unknown> = {};
  const providerInferenceNames = [
    'isCompactTrace',
    'codexTraceProviderKind',
    'providerTransitionDisplayConsumer',
    'inferProviderTransitions',
    'displayProviderTransition'
  ];
  vm.runInNewContext(
    `let inferredProviderTransitions={};${providerInferenceNames.map(name => extractViewerFunction(viewerScript, name)).join('\n')};`
      + 'this.api={inferProviderTransitions,displayProviderTransition};',
    providerInferenceFunctions
  );
  const providerInferenceApi = providerInferenceFunctions.api as {
    inferProviderTransitions: (traces: any[]) => void;
    displayProviderTransition: (trace: any) => { source: string; target: string } | undefined;
  };
  const historicalProviderSwitches = [
    { id:'title', source:'codex-vscode', auxiliary:'title', upstream:{ baseUrl:'https://chatgpt.com/backend-api/codex' } },
    { id:'official-1', source:'codex-vscode', upstream:{ baseUrl:'https://chatgpt.com/backend-api/codex' } },
    {
      id:'compatible-1',
      source:'codex-vscode',
      upstream:{ baseUrl:'https://compatible.example/v1' },
      providerTransition:{ source:'official', target:'compatible' }
    },
    { id:'official-2', source:'codex-vscode', upstream:{ baseUrl:'https://chatgpt.com/backend-api/codex' } },
    { id:'official-3', source:'codex-vscode', upstream:{ baseUrl:'https://chatgpt.com/backend-api/codex' } }
  ];
  providerInferenceApi.inferProviderTransitions(historicalProviderSwitches);
  assert.equal(
    JSON.stringify(providerInferenceApi.displayProviderTransition(historicalProviderSwitches[3])),
    JSON.stringify({ source:'compatible', target:'official' }),
    'the sidebar must recover a missing historical 兼容服务-to-official transition from adjacent Codex upstreams'
  );
  assert.equal(providerInferenceApi.displayProviderTransition(historicalProviderSwitches[4]), undefined,
    'historical transition inference must stop after the first visible main request on the new provider');
  const auxiliaryBoundary = [
    { id:'official', source:'codex-cli', upstream:{ baseUrl:'https://api.openai.com/v1' } },
    { id:'compatible-title', source:'codex-cli', auxiliary:'title', upstream:{ baseUrl:'https://compatible.example/v1' } },
    { id:'compatible-main', source:'codex-cli', upstream:{ baseUrl:'https://compatible.example/v1' } }
  ];
  providerInferenceApi.inferProviderTransitions(auxiliaryBoundary);
  assert.equal(JSON.stringify(providerInferenceApi.displayProviderTransition(auxiliaryBoundary[1])),
    JSON.stringify({ source:'official', target:'compatible' }),
    'an inferred boundary title must display the switch without consuming it');
  assert.equal(JSON.stringify(providerInferenceApi.displayProviderTransition(auxiliaryBoundary[2])),
    JSON.stringify({ source:'official', target:'compatible' }),
    'the main request after an inferred boundary title must still display the switch');
  assert.match(viewerScript, /const semantic = semanticRailLabel\(t\)/,
    'the sidebar must classify request semantics independently from provider transition state');
  assert.match(viewerScript, /return \[semantic, transition\]\.filter\(Boolean\)\.join\(' · '\)/,
    'a boundary utility request must display both its semantic type and the provider transition');
  assert.ok(
    viewerScript.indexOf("isCompactTrace(t)) return L('上下文压缩','compact')")
      < viewerScript.indexOf("if(displayProviderTransition(t)) return 'var(--violet)'"),
    'compact and auxiliary semantic colors must outrank the secondary provider-transition color'
  );
  assert.match(html, /\.row::before\{display:none\}/,
    'full-width request selection must not use the generic leading highlight bar');
  assert.match(html, /\.row\.on\{[^}]*box-shadow:var\(--shadow-soft\),inset 0 0 0 1px var\(--focus-line\)[^}]*transform:translateY\(-1px\)/,
    'a selected top-level request must use the soft raised-card treatment');
  assert.match(html, /\.sabody \.row\{margin:3px 6px;[^}]*border-radius:7px\}/,
    'SubAgent requests must leave enough internal space for the shared soft raised selection treatment');
  assert.doesNotMatch(html, /\.sabody \.row\.on\{/,
    'SubAgent request selection must inherit the same raised-card treatment as top-level requests');
  assert.match(html, /\.sagroup\.tier0>\.sabody>\.sabody-inner>\.row\.on\{background:var\(--pressed\)\}/,
    'white SubAgent groups must use the stronger neutral pressed surface for their raised selection card');
  for(const mode of ['mini','spine','ticks','summary']){
    assert.match(html, new RegExp(`\\.app\\[data-rail="${mode}"\\] \\.row,[^}]*transform:none`),
      `${mode} rail requests must suppress full-width selection lift`);
  }
  assert.match(viewerScript, /if\(LIVE_MODE && !restoringHistory\)[\s\S]*delete state\.sessionTraces\[sid\][\s\S]*delete sessionTraceMeta\[sid\]/,
    'opening a session normally must discard a stale middle-page cache before requesting the newest page');
  assert.match(viewerScript, /loadSessionTraces\(sid, \{ replace: true, selectLatest: true \}\)/,
    'a fresh session navigation must explicitly replace its cache with the newest page and select its last request');
  assert.match(viewerScript, /const merged = opts\.replace === false[\s\S]*mergeSessionPage\(sid, data\)[\s\S]*replaceSessionPage\(sid, data\)/,
    'the initial tail page must replace rather than merge a potentially non-contiguous cached window');
  const sessionPageStateStart = viewerScript.indexOf('function mergeSessionPage');
  const sessionPageStateEnd = viewerScript.indexOf('function revealRailSelection', sessionPageStateStart);
  assert.ok(sessionPageStateStart >= 0 && sessionPageStateEnd > sessionPageStateStart,
    'viewer must define its contiguous session-page state helpers');
  const sessionPageStateSource = viewerScript.slice(sessionPageStateStart, sessionPageStateEnd);
  assert.doesNotMatch(sessionPageStateSource, /sess\.traceCount\s*=/,
    'a logical Conversation page total must not overwrite one physical Session count and get summed twice on the dashboard');
  assert.match(viewerScript, /selectedId = list\[list\.length - 1\]\.id;[\s\S]*revealRailSelection\(opts\.selectLatest !== false\)/,
    'after the newest page loads, the latest request must be selected and revealed in the rail viewport');
  assert.match(viewerScript, /const keepLatestVisible = wasAtNewest && followLatest && selectedSessionId === mergedSessionId;[\s\S]*render\(\);[\s\S]*if\(keepLatestVisible\) revealRailSelection\(true\)/,
    'a live follow-latest update must keep the newest sidebar row visible after rendering it');
  assert.match(viewerScript, /const isAuxTrace = !!trace\.auxiliary;/,
    'live viewer updates must treat memory, utility and patch as auxiliary instead of only the legacy three kinds');
  assert.doesNotMatch(viewerScript.slice(viewerScript.indexOf('function bootstrapTraceRoute'), viewerScript.indexOf("window.addEventListener('popstate'")), /requestId: current\.requestId/,
    'a hard-opened session URL must default to the latest request instead of restoring a stale history-state request');
  // 进度行刻意与请求气泡**不同口径**：气泡显示落盘的全局 turn 号，进度行显示本会话局部位序。
  // 两者混用曾产生「请求 18 / 7」（分子是全局号、分母是局部条数）。分子必须是局部位序。
  assert.match(viewerScript, /progressCur'\)\.textContent = selectedId \? String\(offset \+ idx \+ 1\)/,
    'the progress numerator must be the session-local position so it can never exceed the total');
  assert.doesNotMatch(viewerScript, /progressCur'\)\.textContent = selectedId \? String\(stableTraceOrdinal/,
    'the progress numerator must not be the global turn number divided by a local count');
  assert.match(viewerScript, /railWinStart = beforeStart;[\s\S]*railWinEnd = beforeEnd \+ merged\.addedBefore;/,
    'prepending a fetched page must expose its rows instead of hiding them behind the load placeholder');
  const groupTraceCountMatch = /^function railGroupTraceCount\s*\([\s\S]*?\n\}/m.exec(viewerScript);
  const groupsTraceCountMatch = /^function railGroupsTraceCount\s*\([\s\S]*?\n\}/m.exec(viewerScript);
  assert.ok(groupTraceCountMatch && groupsTraceCountMatch, 'viewer must count hidden request rows instead of collapsed groups');
  const groupCountFunctions: Record<string, unknown> = {};
  vm.runInNewContext(
    `${groupTraceCountMatch![0]};${groupsTraceCountMatch![0]};this.railGroupsTraceCount=railGroupsTraceCount;`,
    groupCountFunctions
  );
  const railGroupsTraceCount = groupCountFunctions.railGroupsTraceCount as (
    groups: Array<{ kind: string; entries?: unknown[] }>, start: number, end: number
  ) => number;
  assert.equal(
    railGroupsTraceCount([{
      kind: 'main'
    }, {
      kind: 'sagroup',
      entries: [
        { kind: 'main', trace: {} },
        {
          kind: 'sagroup',
          entries: [
            { kind: 'main', trace: {} },
            { kind: 'main', trace: {} }
          ]
        }
      ]
    }], 0, 2),
    4,
    'a collapsed nested Subagent group contributes every descendant request to the load hint'
  );
  assert.match(viewerScript, /const count = beforeWindow \+ beforePage;/,
    'the upper load hint must include both hidden loaded rows and unloaded page rows');
  const railGroupKeyMatch = /^function railGroupKey\s*\([\s\S]*?\n\}/m.exec(viewerScript);
  assert.ok(railGroupKeyMatch, 'viewer must keep a stable Subagent collapse key helper');
  assert.doesNotMatch(railGroupKeyMatch![0], /traceLabel\(/,
    'Subagent collapse keys must not depend on localized request labels');
  const railKeyFunctions: Record<string, unknown> = {};
  vm.runInNewContext(`${ordinalMatch![0]};${railGroupKeyMatch![0]};this.railGroupKey=railGroupKey;`, railKeyFunctions);
  const railGroupKey = railKeyFunctions.railGroupKey as (group: Record<string, any>) => string;
  assert.equal(
    railGroupKey({ groupKey: 'orphan|S140', items: [{ id: 'sub-140', turn: 140 }] }),
    'orphan|S140',
    'language changes must not reopen an already collapsed Subagent group'
  );
  const foldLabelStart = viewerScript.indexOf('function syncFoldAllLabel');
  const foldLabelEnd = viewerScript.indexOf('function isCompactTrace', foldLabelStart);
  assert.ok(foldLabelStart >= 0 && foldLabelEnd > foldLabelStart);
  const foldLabelSource = viewerScript.slice(foldLabelStart, foldLabelEnd);
  assert.match(foldLabelSource, /railSubagentGroups\(railGroupsCache\)/,
    'fold-all label and action must inspect every nested logical Subagent group');
  assert.doesNotMatch(foldLabelSource, /querySelectorAll\('\.sagroup'\)/,
    'fold-all state must not be derived from only the virtualized DOM window');
  const chromeTextStart = viewerScript.indexOf('function renderChromeText');
  const chromeTextEnd = viewerScript.indexOf('function esc', chromeTextStart);
  assert.ok(chromeTextStart >= 0 && chromeTextEnd > chromeTextStart);
  const chromeTextSource = viewerScript.slice(chromeTextStart, chromeTextEnd);
  assert.match(chromeTextSource, /confirmDeleteTitle/,
    'language refresh must include the delete confirmation dialog');
  assert.match(viewerScript, /confirmDeleteReturnFocus = document\.activeElement;[\s\S]*confirmDeleteCancel'\)\.focus\(\)/,
    'delete confirmation must move focus into the dialog');
  assert.match(viewerScript, /function trapModalTab\(/,
    'Trace dialogs must keep keyboard focus inside the active modal');
  assert.match(viewerScript, /trapModalTab\(searchOpen \? 'searchOv' : 'pricingOv', e\)/,
    'search and pricing dialogs must share the modal focus trap');
  assert.match(viewerScript, /dashControl\.matches\('\[data-act="delete"\]'\)[\s\S]*dashControl\.click\(\)/,
    'delete buttons must have a deterministic keyboard activation path');
  assert.match(viewerScript, /dashRow && !dashControl && \(e\.key === 'Enter' \|\| e\.key === ' '\)/,
    'dashboard row keyboard navigation must exclude nested controls');
  const stripStart = viewerScript.indexOf('function stripNoiseTags');
  const stripEnd = viewerScript.indexOf('function contentToParts', stripStart);
  assert.ok(stripStart >= 0 && stripEnd > stripStart);
  const viewerFunctions: Record<string, unknown> = {};
  vm.runInNewContext(
    `${viewerScript.slice(stripStart, stripEnd)};this.api={stripNoiseTags,stripLeadingNoiseTags};`,
    viewerFunctions
  );
  const viewerNoiseApi = viewerFunctions.api as {
    stripNoiseTags: (text: string) => string;
    stripLeadingNoiseTags: (text: string) => string;
  };
  const stripNoiseTags = viewerNoiseApi.stripNoiseTags;
  assert.equal(stripNoiseTags([
    '<recommended_plugins>plugins</recommended_plugins>',
    '# AGENTS.md instructions for E:\\Ai2Work\\XwX Deck',
    '',
    '',
    '真实用户问题'
  ].join('\n')), '真实用户问题');
  const viewerCaveat = `<${LOCAL_COMMAND_CAVEAT_TAG}>${LOCAL_COMMAND_CAVEAT_TEXT}</${LOCAL_COMMAND_CAVEAT_TAG}>`;
  assert.equal(stripNoiseTags(viewerCaveat), '');
  assert.equal(
    stripNoiseTags(`用户引用：\n${viewerCaveat}\n保留正文`),
    `用户引用：\n${viewerCaveat}\n保留正文`
  );
  assert.equal(
    viewerNoiseApi.stripLeadingNoiseTags(`${viewerCaveat}\n\n真实用户问题`),
    '真实用户问题'
  );
  // Codex Desktop 0.144+ "responses-lite": tool declarations ride inside `input` as an
  // `additional_tools` item, and the turn history uses reasoning / custom_tool_call /
  // tool_search_* items. Every one of these used to render as a blank bubble, and the
  // Tools section read "No tools in this request" for the whole session.
  const liteHelpers: Record<string, unknown> = { atob, TextDecoder, Buffer };
  const liteNames = ['bodyOf', 'declaredToolList', 'normalizeToolDecl', 'searchLoadedTools', 'tools',
    'toolsCount', 'callableToolCount', 'reasoningItemText', 'b64Utf8', 'normalizeMessage', 'getMessages',
    'parseJsonMaybe', 'geminiMessage', 'toolDeclDisplayName', 'toolDeclKind', 'qualifiedToolName',
    'isSystemRole', 'msgsToText', 'j'];
  let liteSource = '';
  for (const name of liteNames) {
    const match = new RegExp(`^function ${name}\\s*\\([\\s\\S]*?\\n\\}`, 'm').exec(viewerScript);
    assert.ok(match, `viewer must define ${name}`);
    liteSource += `${match![0]}\n`;
  }
  vm.runInNewContext(`${liteSource};this.api={${liteNames.join(',')}};`, liteHelpers);
  const viewerApi = liteHelpers.api as Record<string, any>;
  const liteTrace = { request: { body: {
    model: 'gpt-5.6-sol',
    input: [
      { type: 'additional_tools', role: 'developer', tools: [
        { type: 'custom', name: 'apply_patch', description: 'edit files', format: { type: 'grammar' } },
        { type: 'function', name: 'shell_command', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
        { type: 'namespace', name: 'image_gen', description: 'images', tools: [{ type: 'function', name: 'create_image', parameters: {} }] },
        { type: 'tool_search', execution: 'client', description: 'load tools', parameters: { type: 'object', properties: { query: { type: 'string' } } } }
      ] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: '**Planning**' }], encrypted_content: 'gAAA' },
      { type: 'custom_tool_call', call_id: 'call_a', name: 'apply_patch', input: '*** Begin Patch' },
      { type: 'custom_tool_call_output', call_id: 'call_a', output: [{ type: 'input_text', text: 'done' }] },
      { type: 'tool_search_call', call_id: 'call_b', execution: 'client', arguments: { query: 'browser' } },
      { type: 'tool_search_output', call_id: 'call_b', execution: 'client', tools: [{ type: 'namespace', name: 'mcp__node_repl', tools: [] }] }
    ]
  } } };
  assert.equal(viewerApi.toolsCount(liteTrace), 4, 'responses-lite tools must come from the additional_tools item');
  // The vm realm has its own Array/Object prototypes, so compare by value, not deepEqual.
  assert.equal(
    viewerApi.tools(liteTrace).map((tool: unknown) => viewerApi.toolDeclDisplayName(tool)).join(','),
    'apply_patch,shell_command,image_gen,tool_search',
    'tool_search declares no name; the type supplies it'
  );
  const liteMessages = Array.from(viewerApi.getMessages(liteTrace) as Array<Record<string, any>>);
  assert.ok(
    liteMessages.every(message => Array.isArray(message.content) && message.content.length),
    'no responses-lite input item may render as an empty bubble'
  );
  const liteBlocks = liteMessages.flatMap(message => Array.from(message.content as Array<Record<string, any>>));
  assert.equal(liteBlocks.filter(block => block.type === 'thinking').length, 1, 'reasoning item becomes a thinking block');
  assert.equal(liteBlocks.find(block => block.type === 'thinking')!.thinking, '**Planning**');
  const liteToolUse = liteBlocks.filter(block => block.type === 'tool_use');
  assert.equal(liteToolUse.map(block => block.name).join(','), 'apply_patch,tool_search', 'freeform and tool_search calls both surface');
  assert.equal(liteToolUse[0].input.input, '*** Begin Patch', 'custom_tool_call payload lives in input, not arguments');
  assert.equal(JSON.stringify(liteToolUse[1].input), '{"query":"browser"}', 'tool_search_call arguments arrive as an object');
  assert.equal(liteBlocks.filter(block => block.type === 'tool_result').length, 2, 'both output item shapes render');
  // Codex compaction items carry no role and no content; without a branch they render as a
  // blank `unknown` bubble even though they hold the entire compacted context.
  const compactTrace = { request: { body: { input: [
    { id: 'cmp_1', type: 'compaction', encrypted_content: 'xwxc1:' + Buffer.from('前情提要：已完成 A、B', 'utf8').toString('base64') },
    { id: 'cmp_2', type: 'compaction', encrypted_content: 'OPAQUE_UPSTREAM_BLOB' },
    { type: 'compaction_trigger' }
  ] } } };
  const compactMessages = Array.from(viewerApi.getMessages(compactTrace) as Array<Record<string, any>>);
  assert.ok(
    compactMessages.every(message => Array.isArray(message.content) && message.content.length),
    'compaction items must not render as empty bubbles'
  );
  assert.equal(compactMessages[0].content[0].text, '前情提要：已完成 A、B', 'XwX compaction summaries decode back to UTF-8 text');
  assert.match(compactMessages[1].content[0].text, /无法解码/, 'opaque upstream compaction says so instead of showing blank');
  assert.match(compactMessages[2].content[0].text, /压缩触发点/, 'compaction_trigger is labelled');
  completed.push('Trace role labels and lossless message fallbacks');
}

// 对比视图的对齐口径。回归的是一整类真实缺陷：Codex 子 Agent 派生那一轮的 client_metadata
// 在中间插入了 x-codex-parent-thread-id，旧实现（削公共前后缀 + 按位置 zip）会把后面每一行
// 整体错位——连内容完全相同的 x-codex-installation-id 也标成改动，还把 turn-metadata 和
// parent-thread-id 这两个毫不相干的字段并排逐行 diff。
// viewer 的 inline JS 里既有多行函数也有一行写完的函数，`^function x[\s\S]*?\n\}` 那种正则
// 对后者会一路吞到下一个函数的收尾括号，把中间的顶层 const 一起吞进去（于是 vm 里重复声明）。
// 这里改成数括号，取到函数真正的边界。
function extractViewerFunction(source: string, name: string): string {
  const start = new RegExp(`^function ${name}\\s*\\(`, 'm').exec(source);
  assert.ok(start, `viewer must define ${name}`);
  const from = start!.index;
  const bodyStart = source.indexOf('{', from + start![0].length - 1);
  assert.ok(bodyStart > from, `viewer function ${name} must have a body`);
  let depth = 0;
  let quote = '';
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    // 括号计数必须跳过字符串字面量：parseEmbeddedJson 里就有 '{' / '}' 这样的字面量
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting viewer function ${name}`);
}

async function testViewerDiffAlignment(): Promise<void> {
  const html = renderTapViewerHtml({
    mode: 'static',
    state: { active: false, rootPath: 'qa', sessions: [], traces: [] }
  });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  const viewerScript = scripts.at(-1) ?? '';
  const diffNames = ['diffLcsOps', 'lineDiffPairs', 'diffHunkRows', 'structuredLeafChanges',
    'collectLeafChanges', 'parseEmbeddedJson', 'isPlainObject', 'diffValueText', 'diffValueEqual',
    'canonicalizeDiffValue', 'diffMsgRows', 'pairMsgHunk', 'msgDiffKey', 'diffTextSimilarity',
    'msgsToText', 'parseJsonMaybe', 'j'];
  let diffSource = '';
  for (const name of diffNames) {
    diffSource += `${extractViewerFunction(viewerScript, name)}\n`;
  }
  const constMatch = /const DIFF_CTX_LINES[\s\S]*?const DIFF_LCS_MAX_D = \d+;/.exec(viewerScript);
  assert.ok(constMatch, 'viewer must declare the diff hunk-context and Myers bound constants');
  const simMatch = /const DIFF_SIM_SAMPLE = \d+;/.exec(viewerScript);
  const leafMatch = /const DIFF_LEAF_LIMIT = \d+;[\s\S]*?const DIFF_LEAF_DEPTH = \d+;/.exec(viewerScript);
  assert.ok(simMatch && leafMatch, 'viewer must declare the similarity and leaf-diff bounds');
  const diffCtx: Record<string, unknown> = {};
  vm.runInNewContext(
    `${constMatch![0]}\n${simMatch![0]}\n${leafMatch![0]}\n${diffSource};this.api={${diffNames.join(',')}};`,
    diffCtx
  );
  const api = diffCtx.api as Record<string, any>;

  // ── 行 diff：内容相同的行必须留在 ctx，不能被上方插入的 key 顶成改动 ──
  const oldMeta = {
    session_id: '019fd4ee-db8e-7e12-8dbe-d62ed2ca7160',
    thread_id: '019fd4ee-db8e-7e12-8dbe-d62ed2ca7160',
    'x-codex-installation-id': '6bb8660a-dbaa-4432-9871-ba9d76968988',
    'x-codex-window-id': '019fd4ee-db8e-7e12-8dbe-d62ed2ca7160:0'
  };
  const newMeta = {
    session_id: '019fd4ee-db8e-7e12-8dbe-d62ed2ca7160',
    thread_id: '019fd4ef-4547-7822-b437-36f2592d66a0',
    'x-codex-installation-id': '6bb8660a-dbaa-4432-9871-ba9d76968988',
    'x-codex-parent-thread-id': '019fd4ee-db8e-7e12-8dbe-d62ed2ca7160',
    'x-codex-window-id': '019fd4ef-4547-7822-b437-36f2592d66a0:0'
  };
  const rows = api.lineDiffPairs(JSON.stringify(oldMeta, null, 2), JSON.stringify(newMeta, null, 2));
  const installRow = rows.find((row: Record<string, any>) =>
    String(row.text ?? row.oldText ?? '').includes('x-codex-installation-id'));
  assert.ok(installRow, 'the installation-id line must appear in the diff');
  assert.equal(installRow.type, 'ctx',
    'a byte-identical line must never read as changed just because a key was inserted above it');
  // 行 diff 到此为止：JSON 里末尾插一个 key 会改上一行的尾逗号，LCS 因此锚不住那一行，
  // hunk 内仍会按位置配对。这正是 JSON 值必须走结构化 diff 的原因——见下面 renderParamChange。
  assert.match(viewerScript, /const leaves = structuredLeafChanges\(f\.oldVal, f\.newVal\);/,
    'a changed request param must try the structural diff before falling back to the line diff');
  assert.ok(api.structuredLeafChanges(oldMeta, newMeta),
    'client_metadata is an object, so it must take the structural path, not the line path');

  // ── 多 hunk：3000 行 prompt 改两个词，不能把整段渲染成改动 ──
  const base = Array.from({ length: 3000 }, (_, i) => `system prompt line ${i} with stable content`);
  const edited = base.slice();
  edited[10] = edited[10].replace('stable', 'CHANGED');
  edited[2990] = edited[2990].replace('stable', 'CHANGED');
  const bigRows = api.lineDiffPairs(base.join('\n'), edited.join('\n')) as Array<Record<string, any>>;
  assert.equal(bigRows.filter(row => row.type === 'change').length, 2,
    'only the two edited lines may render as changes');
  assert.equal(bigRows.filter(row => row.type === 'fold').length, 3,
    'the unchanged runs before, between and after the two edits must each fold');
  assert.ok(bigRows.length < 30,
    `a two-word edit must not paint the whole prompt; got ${bigRows.length} rows`);
  const ctxRow = bigRows.find(row => row.type === 'ctx')!;
  assert.ok(typeof ctxRow.oldLine === 'number' && typeof ctxRow.newLine === 'number',
    'diff rows must carry real line numbers so a change is locatable in a long prompt');

  // ── 结构化 JSON diff：按 key 路径比对，并下钻进「JSON 字符串套在 JSON 里」 ──
  const oldTurn = {
    thread_id: 'A', turn_id: 'B',
    'x-codex-installation-id': 'INSTALL',
    'x-codex-turn-metadata': JSON.stringify({ thread_source: 'user', sandbox: 'windows_elevated', thread_id: 'A' })
  };
  const newTurn = {
    thread_id: 'A2', turn_id: 'B2',
    'x-codex-installation-id': 'INSTALL',
    'x-codex-parent-thread-id': 'A',
    'x-codex-turn-metadata': JSON.stringify({ thread_source: 'subagent', sandbox: 'windows_elevated', thread_id: 'A2', subagent_kind: 'thread_spawn' })
  };
  const leaves = api.structuredLeafChanges(oldTurn, newTurn) as Array<Record<string, any>>;
  assert.ok(leaves, 'two JSON objects must diff structurally rather than by line');
  const byPath = new Map(leaves.map(leaf => [leaf.path, leaf]));
  assert.ok(!byPath.has('x-codex-installation-id'),
    'an unchanged key must not appear in a structural diff at all');
  assert.ok(!byPath.has('x-codex-turn-metadata.sandbox'),
    'an unchanged key inside an embedded JSON string must not appear either');
  assert.equal(byPath.get('x-codex-turn-metadata.thread_source')?.newVal, 'subagent',
    'the diff must drill into a JSON-string value instead of reporting one giant changed line');
  assert.equal(byPath.get('x-codex-turn-metadata.subagent_kind')?.added, true);
  assert.equal(byPath.get('x-codex-parent-thread-id')?.added, true);
  // vm realm 有自己的 Array 原型，按值比而不是 deepEqual
  assert.equal(
    leaves.map(leaf => leaf.path).sort().join(','),
    ['thread_id', 'turn_id', 'x-codex-parent-thread-id', 'x-codex-turn-metadata.subagent_kind',
      'x-codex-turn-metadata.thread_id', 'x-codex-turn-metadata.thread_source'].join(','),
    'exactly the real leaf changes, no positional noise'
  );
  const arrLeaves = api.structuredLeafChanges(
    { edits: [{ type: 'a' }, { type: 'c' }] },
    { edits: [{ type: 'a' }, { type: 'b' }, { type: 'c' }] }
  ) as Array<Record<string, any>>;
  assert.equal(arrLeaves.length, 1, 'inserting one array element is one change, not a cascade');
  assert.equal(arrLeaves[0].added, true);
  assert.equal(api.structuredLeafChanges('plain text', 'other text'), null,
    'plain strings must fall back to the line diff');

  // ── 消息 diff：中间插入一轮工具循环，最终回答必须和最终回答配对 ──
  const msg = (role: string, text: string) => ({ role, content: [{ type: 'text', text }] });
  const before = [msg('user', 'q1'), msg('assistant', 'a1'), msg('user', 'tool result 1'),
    msg('assistant', 'FINAL ANSWER: the weather in NYC is warm')];
  const after = [msg('user', 'q1'), msg('assistant', 'a1'), msg('user', 'tool result 1'),
    msg('assistant', 'a2 totally different intermediate step'), msg('user', 'tool result 2'),
    msg('assistant', 'FINAL ANSWER: the weather in NYC is hot')];
  const msgRows = api.diffMsgRows(before, after) as Array<Record<string, any>>;
  assert.equal(msgRows[0].type, 'same');
  assert.equal(msgRows[0].count, 3, 'the shared prefix must collapse into one unchanged bar');
  const changeRows = msgRows.filter(row => row.type === 'change');
  assert.equal(changeRows.length, 1, 'exactly one message was edited');
  assert.match(changeRows[0].old.content[0].text, /^FINAL ANSWER/,
    'the edited final answer must not be paired against an unrelated inserted message');
  assert.match(changeRows[0].next.content[0].text, /^FINAL ANSWER/);
  assert.equal(msgRows.filter(row => row.type === 'add').length, 2, 'the inserted tool loop is 2 additions');
  assert.equal(msgRows.filter(row => row.type === 'del').length, 0, 'nothing was deleted');
  const roleRows = api.diffMsgRows([msg('assistant', 'x')], [msg('user', 'y')]) as Array<Record<string, any>>;
  assert.equal(roleRows.filter(row => row.type === 'change').length, 0,
    'a user message must never be diffed against an assistant message');
  const midRows = api.diffMsgRows(
    [msg('user', 'A'), msg('user', 'MID'), msg('user', 'Z-old')],
    [msg('user', 'A'), msg('user', 'MID'), msg('user', 'Z-new')]
  ) as Array<Record<string, any>>;
  assert.equal(midRows[0].count, 2, 'unchanged messages stay grouped where they occur');
  assert.equal(midRows[1].type, 'change');
  completed.push('Trace diff aligns on LCS and diffs JSON by key path');
}

// 缓存计数放在哪里就是协议判别式：Anthropic 放顶层、与 input_tokens 独立加和；OpenAI 放在
// *_tokens_details 里、是 input_tokens 的子集。不区分这一点，Codex 每一轮的「上下文窗口」
// 都会把缓存重复计一遍（实测 input=49910/cached=49682 被显示成 99592）。
async function testUsageProtocolSemantics(): Promise<void> {
  // ── Responses：缓存是 input_tokens 的子集 ──
  const responses = normalizeUsage({
    input_tokens: 49910,
    input_tokens_details: { cached_tokens: 49682, cache_write_tokens: 225 },
    output_tokens: 142,
    output_tokens_details: { reasoning_tokens: 12 },
    total_tokens: 50052
  }, 'openai-responses')!;
  assert.equal(responses.inputIncludesCache, true, 'details-nested cache counts mean input already includes them');
  assert.equal(responses.cacheReadTokens, 49682);
  assert.equal(responses.cacheCreationTokens, 225,
    'Responses reports cache writes as cache_write_tokens; dropping it shows 缓存写 as —');
  assert.equal(responses.inputTotalTokens, 49910);
  assert.equal(responses.inputUncachedTokens, 3,
    'Responses uncached input must subtract both cached reads and cache writes');
  assert.equal(contextWindowTokens(responses), 49910,
    'the context window is input_tokens itself, not input + cache read + cache write');
  assert.equal(billableTotalTokens(responses), 50052);
  // 首轮：全部是缓存写，cached_tokens 为 0
  const firstTurn = normalizeUsage({
    input_tokens: 49685,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 49682 },
    output_tokens: 188
  }, 'openai-responses')!;
  assert.equal(contextWindowTokens(firstTurn), 49685, 'a cache-write-only turn must not double either');
  assert.equal(billableTotalTokens(firstTurn), 49685 + 188,
    'without an explicit total, the fallback must not re-add the cache subset');
  const responsesPrice = {
    tokens: ['gpt-5.6-sol'],
    protocol: 'openai',
    input: 5,
    output: 30,
    cacheRead: 0.5,
    cacheWrite: 6.25
  } as const;
  const responsesAggregate = {
    version: 2,
    input: 8262,
    output: 753,
    cacheRead: 0,
    cacheCreation: 46542,
    total: 55557,
    apiType: 'responses'
  } as const;
  const responsesExpected = (8262 * 5 + 46542 * 6.25 + 753 * 30) / 1_000_000;
  assert.equal(estimateCostUsd(responsesAggregate, responsesPrice), responsesExpected,
    'Responses cache writes must use the fetched cache-write price instead of the normal input price');

  // ── Anthropic：三个桶互斥，必须相加 ──
  const anthropic = normalizeUsage({
    input_tokens: 2,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 35958,
    cache_creation: {
      ephemeral_5m_input_tokens: 30000,
      ephemeral_1h_input_tokens: 5958
    },
    output_tokens: 2
  }, 'anthropic-messages')!;
  assert.equal(anthropic.inputIncludesCache, false,
    'top-level cache counts are independent of input_tokens');
  assert.equal(anthropic.inputUncachedTokens, 2);
  assert.equal(anthropic.inputTotalTokens, 35960);
  assert.equal(contextWindowTokens(anthropic), 2 + 0 + 35958,
    'Anthropic context window stays the sum of the three independent buckets');
  assert.equal(billableTotalTokens(anthropic), 2 + 0 + 35958 + 2);
  assert.equal(anthropic.cacheCreation5mTokens, 30000);
  assert.equal(anthropic.cacheCreation1hTokens, 5958);
  const anthropicTieredPrice = {
    tokens: ['claude-sonnet-5'],
    protocol: 'anthropic',
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5
  } as const;
  const anthropicTieredAggregate = {
    version: 2,
    input: 2,
    output: 2,
    cacheRead: 0,
    cacheCreation: 35958,
    cacheCreation5m: 30000,
    cacheCreation1h: 5958,
    total: 35962,
    apiType: 'messages'
  } as const;
  const anthropicTieredExpected = (2 * 2 + 30000 * 2.5 + 5958 * 4 + 2 * 10) / 1_000_000;
  assert.equal(estimateCostUsd(anthropicTieredAggregate, anthropicTieredPrice), anthropicTieredExpected,
    'Anthropic 5-minute and 1-hour cache writes must use separate prices');
  const anthropicRead = normalizeUsage({
    input_tokens: 253,
    cache_read_input_tokens: 23552,
    output_tokens: 7
  }, 'anthropic-messages')!;
  assert.equal(contextWindowTokens(anthropicRead), 253 + 23552);
  const bridgedMessagesPrice = {
    tokens: ['glm-5.2'],
    protocol: 'openai',
    input: 1.4,
    output: 4.4,
    cacheRead: 0.26,
    cacheWrite: 0
  } as const;
  const bridgedMessagesAggregate = {
    version: 2,
    input: 253,
    output: 7,
    cacheRead: 23552,
    cacheCreation: 0,
    total: 23812,
    apiType: 'messages'
  } as const;
  const bridgedMessagesExpected = (253 * 1.4 + 23552 * 0.26 + 7 * 4.4) / 1_000_000;
  assert.equal(estimateCostUsd(bridgedMessagesAggregate, bridgedMessagesPrice), bridgedMessagesExpected,
    'Messages input must remain billable even when the model price rule uses the OpenAI protocol');
  assert.equal(
    estimateCostUsd(
      { input: 100, output: 1, cacheRead: 50, cacheCreation: 0, total: 101, apiType: 'responses' },
      { tokens: ['unknown-cache-read'], protocol: 'openai', input: 1, output: 1 }
    ),
    undefined,
    'a used cache-read bucket with no verified price must make the estimate unavailable'
  );
  assert.equal(
    estimateCostUsd(
      { input: 100, output: 1, cacheRead: 0, cacheCreation: 50, total: 101, apiType: 'responses' },
      { tokens: ['gemini-storage'], protocol: 'openai', providerId: 'google', input: 1, output: 1, cacheWritePolicy: 'storage' }
    ),
    undefined,
    'duration-based cache storage cannot be represented as a token-only estimate'
  );

  // ── 混合形状：payload 形状必须压过声明协议 ──
  // 取自真实抓包（qwen3.8-max 经 兼容服务，客户端问 Messages、上游答 Chat
  // Completions）。响应同时带 Anthropic 顶层计数和一份只镜像了读取量的
  // prompt_tokens_details。按声明的上游协议读会把缓存写判为未知、并把 35,226
  // token 的一轮压成 838。
  const bridgedHybrid = normalizeUsage({
    cache_creation: { ephemeral_5m_input_tokens: 10396 },
    cache_creation_input_tokens: 10396,
    cache_read_input_tokens: 23992,
    input_tokens: 6,
    output_tokens: 832,
    prompt_tokens_details: { cached_tokens: 23992 }
  }, 'openai-chat-completions')!;
  assert.equal(bridgedHybrid.inputIncludesCache, false,
    'top-level cache creation marks the additive Anthropic shape whatever the route declared');
  assert.equal(bridgedHybrid.inputUncachedTokens, 6);
  assert.equal(bridgedHybrid.cacheReadTokens, 23992,
    'the top-level read count and its prompt_tokens_details mirror must not be added together');
  assert.equal(bridgedHybrid.cacheCreationTokens, 10396,
    'a reported cache-write count must never be dropped because the mirror lacks the field');
  assert.equal(bridgedHybrid.cacheCreation5mTokens, 10396);
  assert.equal(bridgedHybrid.totalTokens, 6 + 23992 + 10396 + 832,
    'the additive shape must not collapse a 35k-token turn to input_tokens + output');
  assert.equal(bridgedHybrid.incompleteFields, undefined,
    'nothing is missing here, so the model must stay billable');
  assert.ok(
    (bridgedHybrid.cacheCreation5mTokens ?? 0) <= (bridgedHybrid.cacheCreationTokens ?? 0),
    'a TTL sub-bucket can never exceed its parent cache-write total'
  );

  // ── 按输入长度分档 / 峰谷计价：必须按落盘时记下的 band 逐段计价 ──
  // 档位由「单次请求」的输入长度决定，会话总量是跨请求求和的，事后套单一档位
  // 就是公开目录那种 2x-6x 少算。
  const tieredPrice = {
    tokens: ['qwen3-max'],
    match: 'exact',
    protocol: 'openai',
    input: 1.2,
    output: 6,
    cacheRead: 0.24,
    tiers: [
      { fromInputTokens: 0, input: 1.2, output: 6, cacheRead: 0.24 },
      { fromInputTokens: 32001, input: 2.4, output: 12, cacheRead: 0.48 },
      { fromInputTokens: 128001, input: 3, output: 15, cacheRead: 0.6 }
    ]
  } as const;
  assert.equal(resolvePriceTierIndex(tieredPrice, 0), 0);
  assert.equal(resolvePriceTierIndex(tieredPrice, 32000), 0);
  assert.equal(resolvePriceTierIndex(tieredPrice, 32001), 1);
  assert.equal(resolvePriceTierIndex(tieredPrice, 900000), 2,
    'the last band whose lower bound is reached must win');
  const tieredUsage = {
    version: 2,
    input: 30000,
    output: 1000,
    cacheRead: 0,
    cacheCreation: 0,
    total: 31000,
    apiType: 'responses',
    bands: [
      { tier: 0, offPeak: false, input: 10000, output: 400, cacheRead: 0, cacheCreation: 0 },
      { tier: 2, offPeak: false, input: 20000, output: 600, cacheRead: 0, cacheCreation: 0 }
    ]
  } as const;
  const tieredExpected = (10000 * 1.2 + 400 * 6 + 20000 * 3 + 600 * 15) / 1_000_000;
  assert.equal(estimateCostUsd(tieredUsage, tieredPrice), tieredExpected,
    'each captured band must be charged at its own tier, not at one blended rate');
  assert.notEqual(
    estimateCostUsd(tieredUsage, tieredPrice),
    (30000 * 1.2 + 1000 * 6) / 1_000_000,
    'flattening a tiered model to its cheapest band is the under-report this guards against'
  );
  assert.equal(
    estimateCostUsd(
      { version: 2, input: 30000, output: 1000, cacheRead: 0, cacheCreation: 0, total: 31000, apiType: 'responses' },
      tieredPrice
    ),
    undefined,
    'a tiered rule with no captured bands must report no cost instead of guessing a band'
  );

  // DeepSeek halves every bucket outside its published UTC peak windows.
  const peakPrice = {
    tokens: ['deepseek-v4-pro'],
    match: 'exact',
    protocol: 'openai',
    input: 0.66,
    output: 1.98,
    cacheRead: 0.022,
    cacheWritePolicy: 'input',
    peak: { peakWindowsUtc: [[1, 4], [6, 10]], offPeakMultiplier: 0.5 }
  } as const;
  assert.equal(isOffPeakAt(peakPrice, Date.parse('2026-08-18T02:30:00Z')), false);
  assert.equal(isOffPeakAt(peakPrice, Date.parse('2026-08-18T04:30:00Z')), true);
  assert.equal(isOffPeakAt(peakPrice, Date.parse('2026-08-18T09:59:00Z')), false);
  assert.equal(isOffPeakAt(peakPrice, Date.parse('2026-08-18T10:00:00Z')), true);
  const peakUsage = {
    version: 2,
    input: 1000,
    output: 100,
    cacheRead: 0,
    cacheCreation: 0,
    total: 1100,
    apiType: 'messages',
    bands: [
      { tier: 0, offPeak: false, input: 600, output: 60, cacheRead: 0, cacheCreation: 0 },
      { tier: 0, offPeak: true, input: 400, output: 40, cacheRead: 0, cacheCreation: 0 }
    ]
  } as const;
  const peakExpected = (600 * 0.66 + 60 * 1.98 + 400 * 0.33 + 40 * 0.99) / 1_000_000;
  assert.equal(estimateCostUsd(peakUsage, peakPrice), peakExpected,
    'off-peak requests must be charged at the discounted rate for every bucket');

  // ── 分桶必须真的被落盘：这条链路断了，分档计价就永远算不出金额 ──
  // estimateCostUsd refuses a banded rule without usage.bands, and only
  // TraceStore records them, in the Gateway helper process. If accumulation ever
  // stops resolving the price rule there, every tiered model silently reports no
  // cost forever and the unit assertions above would still pass.
  {
    const bandRoot = path.join(root, 'usage-bands');
    // TraceStore resolves the price rule through the global catalogue to learn
    // whether a model is banded at all, so the catalogue has to be loaded here
    // exactly as the Gateway helper loads it before serving.
    setCatalogPriceRules([{
      tokens: ['gpt-5.6-sol'],
      match: 'exact',
      protocol: 'openai',
      input: 5,
      output: 30,
      cacheRead: 0.5,
      cacheWrite: 6.25,
      tiers: [
        { fromInputTokens: 0, input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
        { fromInputTokens: 272001, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 }
      ],
      source: 'models.dev',
      providerId: 'openai',
      modelId: 'gpt-5.6-sol'
    }]);
    const bandStore = new TraceStore(bandRoot);
    const tieredTrace = (id: string, inputTokens: number, at: string): TapTraceRecord => ({
      id,
      startedAt: at,
      completedAt: at,
      durationMs: 100,
      request: { model: 'gpt-5.6-sol', apiType: 'responses', body: {} },
      response: {
        statusCode: 200,
        snapshot: { apiType: 'responses', model: 'gpt-5.6-sol', content: [], raw: {} }
      },
      usage: normalizeUsage({
        input_tokens: inputTokens,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 1000,
        total_tokens: inputTokens + 1000
      }, 'openai-responses'),
      timings: {}
    } as unknown as TapTraceRecord);
    // One turn below the 272k step and one above it, so the two land in
    // different bands and a flattened rate cannot reproduce the total.
    await bandStore.appendTrace(tieredTrace('band-low', 100_000, '2026-08-19T03:00:00.000Z'));
    await bandStore.appendTrace(tieredTrace('band-high', 400_000, '2026-08-19T03:01:00.000Z'));
    const bandSessions = await bandStore.listSessions();
    const banded = bandSessions[0]?.usageByModel?.['gpt-5.6-sol'];
    assert.ok(banded, 'a captured tiered model must land in usageByModel');
    assert.equal(banded!.bands?.length, 2,
      'each captured request must be accumulated into the band its prompt length resolves to');
    const bandedPrice = findModelPrice('gpt-5.6-sol');
    assert.ok(bandedPrice?.tiers?.length, 'gpt-5.6-sol must carry its published long-context band');
    assert.equal(
      estimateCostUsd(banded!, bandedPrice!),
      (100_000 * 5 + 1000 * 30 + 400_000 * 10 + 1000 * 45) / 1_000_000,
      'a tiered model must be charged per band end to end, not at one blended rate'
    );
    setCatalogPriceRules([]);
  }

  // ── 输出长度是第三个维度：短回复走优惠输出价 ──
  // Volcengine charges doubao-seed-1.6 output at CNY 2 per 1M instead of 8 when a
  // reply is at most 200 tokens. Reply length is per request like prompt length, so
  // it has to be split at capture time or every tool-call turn is billed at the
  // long-reply rate - a 4x over-report of their output.
  {
    const shortOutputPrice = {
      tokens: ['doubao-seed-1-6'],
      match: 'exact',
      protocol: 'openai',
      input: 0.1187,
      output: 1.187,
      cacheRead: 0.02373,
      tiers: [
        {
          fromInputTokens: 0,
          input: 0.1187,
          output: 1.187,
          cacheRead: 0.02373,
          shortOutput: { atMostTokens: 200, output: 0.2966 }
        },
        { fromInputTokens: 32001, input: 0.178, output: 2.373, cacheRead: 0.02373 }
      ]
    } as const;
    assert.equal(isShortOutput(shortOutputPrice, 0, 200), true, 'the bound is inclusive');
    assert.equal(isShortOutput(shortOutputPrice, 0, 201), false);
    assert.equal(isShortOutput(shortOutputPrice, 1, 10), false,
      'only the band that publishes the discount may apply it');

    const mixed = {
      version: 2,
      input: 20_000,
      output: 1_150,
      cacheRead: 0,
      cacheCreation: 0,
      total: 21_150,
      apiType: 'responses',
      bands: [
        { tier: 0, offPeak: false, shortOutput: true, input: 8_000, output: 150, cacheRead: 0, cacheCreation: 0 },
        { tier: 0, offPeak: false, input: 12_000, output: 1_000, cacheRead: 0, cacheCreation: 0 }
      ]
    } as const;
    assert.equal(
      estimateCostUsd(mixed, shortOutputPrice),
      (8_000 * 0.1187 + 150 * 0.2966 + 12_000 * 0.1187 + 1_000 * 1.187) / 1_000_000,
      'a short reply and a long one in the same input band must be charged at their own output rates'
    );
    assert.notEqual(
      estimateCostUsd(mixed, shortOutputPrice),
      (20_000 * 0.1187 + 1_150 * 1.187) / 1_000_000,
      'billing every reply at the long-reply rate is the over-report this guards against'
    );

    // End to end: two captured turns, one short reply and one long, must land in
    // separate bands purely from their own output counts.
    const shortRoot = path.join(root, 'short-output-bands');
    setCatalogPriceRules([{ ...shortOutputPrice, source: 'official', providerId: 'volcengine', modelId: 'doubao-seed-1-6' }]);
    const shortStore = new TraceStore(shortRoot);
    const reply = (id: string, outputTokens: number): TapTraceRecord => ({
      id,
      startedAt: '2026-08-19T05:00:00.000Z',
      completedAt: '2026-08-19T05:00:01.000Z',
      durationMs: 1000,
      request: { model: 'doubao-seed-1-6', apiType: 'responses', body: {} },
      response: {
        statusCode: 200,
        snapshot: { apiType: 'responses', model: 'doubao-seed-1-6', content: [], raw: {} }
      },
      usage: normalizeUsage({
        input_tokens: 8000,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: outputTokens,
        total_tokens: 8000 + outputTokens
      }, 'openai-responses'),
      timings: {}
    } as unknown as TapTraceRecord);
    await shortStore.appendTrace(reply('short-reply', 150));
    await shortStore.appendTrace(reply('long-reply', 900));
    const shortSessions = await shortStore.listSessions();
    const shortBands = shortSessions[0]?.usageByModel?.['doubao-seed-1-6']?.bands ?? [];
    assert.equal(shortBands.length, 2,
      'reply length must split the band even when both turns share an input band');
    assert.equal(shortBands.filter(band => band.shortOutput === true).length, 1);
    assert.equal(
      estimateCostUsd(shortSessions[0]!.usageByModel!['doubao-seed-1-6']!, findModelPrice('doubao-seed-1-6')!),
      (8_000 * 0.1187 + 150 * 0.2966 + 8_000 * 0.1187 + 900 * 1.187) / 1_000_000,
      'the discount must reach the bill from a real capture, not only from a hand-built band'
    );
    setCatalogPriceRules([]);
  }

  // ── 别名报 0 不等于用量是 0 ──
  // 兼容服务's /v1/chat/completions usage carries BOTH naming schemes and
  // zero-fills the one it does not use: input_tokens: 0 sits next to
  // prompt_tokens: 109331. Taking the first defined alias zeroed input and output
  // for every model bridged over the chat wire (grok-4.6 in the field) while
  // total_tokens stayed correct, so the Tokens column looked plausible and only
  // the input/output columns read 0. Payload copied verbatim from
  // usageEvidence.upstream.raw of a captured trace.
  {
    const compatibleServiceChatUsage = {
      claude_cache_creation_1_h_tokens: 0,
      claude_cache_creation_5_m_tokens: 0,
      completion_tokens: 537,
      completion_tokens_details: { audio_tokens: 0, image_tokens: 0, reasoning_tokens: 480, text_tokens: 0 },
      cost: 2215960000,
      input_tokens: 0,
      input_tokens_details: null,
      output_tokens: 0,
      prompt_tokens: 109331,
      prompt_tokens_details: { audio_tokens: 0, cached_tokens: 192, image_tokens: 0, text_tokens: 109331 },
      total_tokens: 109868
    };
    const bridged = normalizeUsage(compatibleServiceChatUsage, 'openai-chat-completions');
    assert.equal(bridged?.inputTokens, 109331,
      'a zero-filled alias must not shadow the scheme the payload actually uses');
    assert.equal(bridged?.outputTokens, 537);
    assert.equal(bridged?.inputUncachedTokens, 109139, 'chat semantics: prompt_tokens already includes the cache read');
    assert.equal(bridged?.inputTotalTokens, 109331);
    assert.equal(bridged?.cacheReadTokens, 192);
    assert.equal(bridged?.totalTokens, 109868);
    // The counts have to reconcile, which is what made the old behaviour visible:
    // 0 + 0 could never add up to a total_tokens of 109,868.
    assert.equal(bridged!.inputTotalTokens! + bridged!.outputTokens!, bridged!.totalTokens,
      'input + output must account for the reported total');
    // 兼容服务 publishes the write buckets under its own names, including the TTL
    // split. Ignoring them left cacheWrite unknown, which blocks billing entirely.
    assert.equal(bridged?.cacheCreationTokens, 0);
    assert.equal(bridged?.incompleteFields, undefined,
      'a fully reported turn must not be marked incomplete and lose its cost');
    // The client-facing Responses view of the same turn must agree field for field.
    const clientView = normalizeUsage({
      input_tokens: 109331,
      output_tokens: 537,
      total_tokens: 109868,
      input_tokens_details: { cached_tokens: 192, cache_write_tokens: 0 },
      output_tokens_details: { audio_tokens: 0, image_tokens: 0, reasoning_tokens: 480, text_tokens: 0 }
    }, 'openai-responses');
    for (const field of ['inputTokens', 'inputUncachedTokens', 'inputTotalTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const) {
      assert.equal(bridged?.[field], clientView?.[field],
        `the bridged upstream and the client view must report the same ${field}`);
    }

    // A genuine zero still has to survive: it is only skipped when a sibling
    // alias carries a real count.
    const emptyReply = normalizeUsage(
      { prompt_tokens: 40, completion_tokens: 0, total_tokens: 40 },
      'openai-chat-completions'
    );
    assert.equal(emptyReply?.outputTokens, 0, 'a real zero output must stay zero, not become unknown');
    assert.equal(emptyReply?.incompleteFields?.includes('output'), false,
      'a reported zero is a measurement, so output is not missing');
    // And a nonzero alias must not be invented where the payload has none.
    const noOutput = normalizeUsage({ prompt_tokens: 40, total_tokens: 40 }, 'openai-chat-completions');
    assert.equal(noOutput?.outputTokens, undefined);
    assert.deepEqual(noOutput?.incompleteFields, ['cacheRead', 'cacheWrite', 'output'],
      'a field the payload never reported stays unknown');
  }

  // ── 聚合用量必须把分桶一起带上，否则分档模型永远显示 — ──
  // The viewer merges every session in a logical conversation into one usage
  // object, and the dashboard usage matrix merges across sessions again. Both
  // rebuilt the aggregate field by field and dropped `bands`, so every banded
  // model - which is now most of them, Claude included - showed no cost at all in
  // the Trace dashboard even though capture had recorded the split correctly.
  {
    const mergeScript = [...renderTapViewerHtml({
      mode: 'static',
      state: { active: false, rootPath: 'qa', sessions: [], traces: [] }
    }).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).at(-1) ?? '';
    const mergeVm: Record<string, unknown> = {};
    vm.runInNewContext(
      [
        extractViewerFunction(mergeScript, 'mergeUsageBands'),
        extractViewerFunction(mergeScript, 'mergeModelUsage'),
        extractViewerFunction(mergeScript, 'estimateCostUsd'),
        'globalThis.mergeModelUsage = mergeModelUsage;',
        'globalThis.viewerCost = estimateCostUsd;'
      ].join('\n'),
      mergeVm
    );
    const mergeModelUsage = mergeVm.mergeModelUsage as (target: unknown, source: unknown) => Record<string, TapModelUsage>;
    const viewerCost = mergeVm.viewerCost as (usage: unknown, price: unknown) => number | undefined;
    const bandedRule = {
      tokens: ['gpt-5.6-sol'], match: 'exact', protocol: 'openai', providerId: 'openai',
      input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25,
      tiers: [
        { fromInputTokens: 0, input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
        { fromInputTokens: 272001, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 }
      ]
    };
    const sessionUsage = (inputTokens: number, tier: number): Record<string, TapModelUsage> => ({
      'gpt-5.6-sol': {
        version: 2, input: inputTokens, output: 1_000, cacheRead: 0, cacheCreation: 0,
        total: inputTokens + 1_000, apiType: 'responses',
        bands: [{ tier, offPeak: false, input: inputTokens, output: 1_000, cacheRead: 0, cacheCreation: 0 }]
      } as unknown as TapModelUsage
    });
    let merged: Record<string, TapModelUsage> = {};
    merged = mergeModelUsage(merged, sessionUsage(100_000, 0));
    merged = mergeModelUsage(merged, sessionUsage(400_000, 1));
    const mergedUsage = merged['gpt-5.6-sol']!;
    assert.equal(mergedUsage.bands?.length, 2,
      'merging two sessions of one conversation must keep both captured bands');
    const mergedExpected = (100_000 * 5 + 1_000 * 30 + 400_000 * 10 + 1_000 * 45) / 1_000_000;
    assert.equal(viewerCost(mergedUsage, bandedRule), mergedExpected,
      'a banded model must still show a cost after the viewer merges sessions');
    assert.equal(estimateCostUsd(mergedUsage, bandedRule as never), mergedExpected,
      'the merged aggregate must price identically in the main process');
    // Same tier twice collapses into one band rather than accumulating duplicates.
    const sameTier = mergeModelUsage(mergeModelUsage({}, sessionUsage(1_000, 0)), sessionUsage(2_000, 0))['gpt-5.6-sol']!;
    assert.equal(sameTier.bands?.length, 1);
    assert.equal(sameTier.bands?.[0]?.input, 3_000);

    // A pre-banding session merged with a banded one leaves bands covering only
    // part of the tokens. Charging that part would present a silent undercount as
    // the total, so the aggregate has to report no cost instead.
    const partial = {
      version: 2, input: 500_000, output: 2_000, cacheRead: 0, cacheCreation: 0,
      total: 502_000, apiType: 'responses',
      bands: [{ tier: 0, offPeak: false, input: 100_000, output: 1_000, cacheRead: 0, cacheCreation: 0 }]
    } as unknown as TapModelUsage;
    assert.equal(estimateCostUsd(partial, bandedRule as never), undefined,
      'bands that do not account for the usage must not be billed as if they did');
    assert.equal(viewerCost(partial, bandedRule), undefined,
      'the viewer must refuse the same partial split');

    // The matrix aggregator used to pre-zero the cache-write TTL buckets, which
    // makes "no TTL split captured" indistinguishable from "the split is zero" and
    // bills 1h writes at the 5m rate. Merging must not invent those fields.
    const anthropicRule = {
      tokens: ['claude-sonnet-4.5'], match: 'exact', protocol: 'anthropic', providerId: 'anthropic',
      input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6
    };
    const noTtl = mergeModelUsage({}, {
      'claude-sonnet-4.5': {
        version: 2, input: 1_000, output: 200, cacheRead: 0, cacheCreation: 2_000,
        total: 3_200, apiType: 'messages'
      }
    })['claude-sonnet-4.5']!;
    assert.equal('cacheCreation5m' in noTtl, false,
      'merging must not fabricate a TTL split that was never captured');
    assert.equal(viewerCost(noTtl, anthropicRule), undefined,
      'an Anthropic cache write with no captured TTL split must not be billed at the 5m rate');
    assert.equal(estimateCostUsd(noTtl, anthropicRule as never), undefined,
      'the main process must refuse it too');
    const withTtl = mergeModelUsage({}, {
      'claude-sonnet-4.5': {
        version: 2, input: 1_000, output: 200, cacheRead: 0, cacheCreation: 2_000,
        cacheCreation5m: 1_500, cacheCreation1h: 500, total: 3_200, apiType: 'messages'
      }
    })['claude-sonnet-4.5']!;
    assert.equal(
      viewerCost(withTtl, anthropicRule),
      (1_000 * 3 + 200 * 15 + 1_500 * 3.75 + 500 * 6) / 1_000_000,
      'a captured TTL split must survive the merge and charge 1h writes at the 1h rate'
    );
  }

  // ── 一次请求两个模型名：以请求名归集，取价两个都试 ──
  // DeepSeek answers a request for deepseek-v4-pro-0813 with its internal build
  // name deepseek-v4-pro-ga-260813. Keying usage on the reported name attributed
  // the tokens to a name no public catalogue lists, so a model that does have an
  // official price showed no cost at all, and the usage matrix disagreed with the
  // session row about what the model was even called.
  {
    setCatalogPriceRules([
      {
        tokens: ['deepseek-v4-pro-0813'], match: 'exact', protocol: 'openai', providerId: 'deepseek',
        modelId: 'deepseek-v4-pro-0813', input: 1.32, output: 3.96, cacheRead: 0.044,
        cacheWritePolicy: 'input', source: 'official'
      },
      // The reverse direction: a client asking for an alias the catalogue does not
      // list, answered by a concrete model that it does.
      {
        tokens: ['gpt-5.4'], match: 'exact', protocol: 'openai', providerId: 'openai',
        modelId: 'gpt-5.4', input: 2.5, output: 15, cacheRead: 0.25, source: 'models.dev'
      }
    ]);
    assert.equal(findModelPriceForUsage('deepseek-v4-pro-ga-260813', undefined), undefined,
      'the internal build name alone must stay unpriced rather than match something near it');
    assert.equal(
      findModelPriceForUsage('deepseek-v4-pro-0813', 'deepseek-v4-pro-ga-260813')?.modelId,
      'deepseek-v4-pro-0813',
      'the requested name is what the catalogue lists and what the user chose'
    );
    assert.equal(findModelPriceForUsage('gpt-5.4-latest', 'gpt-5.4')?.modelId, 'gpt-5.4',
      'when only the served name is listed, it is the fallback');

    const renameRoot = path.join(root, 'model-rename');
    const store = new TraceStore(renameRoot);
    const renamed: TapTraceRecord = {
      id: 'renamed-by-upstream',
      startedAt: '2026-08-19T06:56:20.000Z',
      completedAt: '2026-08-19T06:56:22.000Z',
      durationMs: 2000,
      request: { model: 'deepseek-v4-pro-0813', apiType: 'chat-completions', body: {} },
      response: {
        statusCode: 200,
        // Exactly what the upstream reported in the field.
        snapshot: { apiType: 'chat-completions', model: 'deepseek-v4-pro-ga-260813', content: [], raw: {} }
      },
      usage: normalizeUsage({
        prompt_tokens: 50_000,
        prompt_tokens_details: { cached_tokens: 10_000 },
        completion_tokens: 1_000,
        total_tokens: 51_000
      }, 'openai-chat-completions'),
      timings: {}
    } as unknown as TapTraceRecord;
    await store.appendTrace(renamed);
    const sessions = await store.listSessions();
    const usage = sessions[0]?.usageByModel;
    assert.deepEqual(Object.keys(usage ?? {}), ['deepseek-v4-pro-0813'],
      'usage must be keyed on the name the client asked for, matching the session row');
    const entry = usage!['deepseek-v4-pro-0813']!;
    assert.equal(entry.servedModel, 'deepseek-v4-pro-ga-260813',
      'the name the upstream reported is evidence and must be kept, not discarded');
    const price = findModelPriceForUsage('deepseek-v4-pro-0813', entry.servedModel);
    assert.ok(price, 'the renamed turn must resolve to the official price');
    assert.equal(
      estimateCostUsd(entry, price!),
      (40_000 * 1.32 + 10_000 * 0.044 + 1_000 * 3.96) / 1_000_000,
      'a turn the upstream renamed must still be billed at its published rate'
    );
    setCatalogPriceRules([]);
  }

  // ── 用量矩阵：星号只留给真丢了的数据 ──
  // renderTokenMatrix had no coverage at all, which is how it kept its own copy of
  // the aggregation (dropping bands) and marked every unreported cache bucket as
  // "cannot be derived reliably" while billing that same absence as zero.
  {
    const matrixScript = [...renderTapViewerHtml({
      mode: 'static',
      state: { active: false, rootPath: 'qa', sessions: [], traces: [] }
    }).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).at(-1) ?? '';
    const PRICES: Record<string, unknown> = {
      // Reports its writes, and absence would mean lost data.
      'claude-sonnet-4.5': {
        tokens: ['claude-sonnet-4.5'], match: 'exact', protocol: 'anthropic', providerId: 'anthropic',
        input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6, modelId: 'claude-sonnet-4.5'
      },
      // Never itemises cache writes; absence is a definite zero.
      'grok-4.6': {
        tokens: ['grok-4.6'], match: 'exact', protocol: 'openai', providerId: 'xai',
        input: 2, output: 6, cacheRead: 0.5, modelId: 'grok-4.6',
        tiers: [
          { fromInputTokens: 0, input: 2, output: 6, cacheRead: 0.5 },
          { fromInputTokens: 200001, input: 4, output: 12, cacheRead: 1 }
        ]
      }
    };
    const matrixVm: Record<string, unknown> = {
      L: (zh: string) => zh,
      esc: (value: unknown) => String(value),
      num: (value: number) => value.toLocaleString('en-US'),
      fmtCost: (value: number) => '$' + value.toFixed(4),
      priceRuleSummary: () => 'rule',
      findModelPrice: (model: string) => PRICES[model],
      tokenMatrixOpen: true
    };
    vm.runInNewContext(
      [
        extractViewerFunction(matrixScript, 'mergeUsageBands'),
        extractViewerFunction(matrixScript, 'mergeModelUsage'),
        extractViewerFunction(matrixScript, 'findModelPriceForUsage'),
        extractViewerFunction(matrixScript, 'estimateCostUsd'),
        extractViewerFunction(matrixScript, 'renderTokenMatrix'),
        'globalThis.renderTokenMatrix = renderTokenMatrix;'
      ].join('\n'),
      matrixVm
    );
    const renderMatrix = matrixVm.renderTokenMatrix as (sessions: unknown[]) => string;

    const html = renderMatrix([{
      totalTokens: 1_000,
      usageByModel: {
        // A banded model whose writes were never reported.
        'grok-4.6': {
          version: 2, input: 100_000, output: 500, cacheRead: 1_000, cacheCreation: 0,
          total: 101_500, apiType: 'responses', incompleteFields: ['cacheWrite'],
          bands: [{ tier: 0, offPeak: false, input: 100_000, output: 500, cacheRead: 1_000, cacheCreation: 0 }]
        },
        // Anthropic lost its cache-read count: that absence really is missing data.
        'claude-sonnet-4.5': {
          version: 2, input: 2_000, output: 300, cacheRead: 0, cacheCreation: 4_000,
          cacheCreation5m: 4_000, cacheCreation1h: 0, total: 6_300, apiType: 'messages',
          incompleteFields: ['cacheRead']
        }
      }
    }]);

    const grokRow = html.slice(html.indexOf('grok-4.6'), html.indexOf('claude-sonnet-4.5'));
    assert.doesNotMatch(grokRow, /—\*/,
      'a bucket the service never itemises must not be flagged as unreliable while we bill it as zero');
    assert.match(grokRow, /该服务不单独返回这一项/,
      'the calm tooltip has to say why the cell is empty');
    assert.match(grokRow, /\$0\.2035/,
      'the banded model must still be priced from the bands the merge preserved');

    const claudeRow = html.slice(html.indexOf('claude-sonnet-4.5'));
    assert.match(claudeRow, /—\*/,
      'Anthropic itemises every cache bucket, so a missing one is lost data and keeps the marker');
    assert.match(claudeRow, /云端未返回且无法可靠推导/);

    // The footer must not hide a real sum because one model does not report the
    // bucket: the models that never report it count as zero.
    const footer = html.slice(html.indexOf('<tfoot>'));
    assert.match(footer, /4,000/, 'the cache-write total must show the tokens that were reported');
    // Exactly one marker survives, and it is the cache-read column the Anthropic
    // model really lost - the benign cache-write absence must not blank its total.
    assert.equal((footer.match(/—\*/g) ?? []).length, 1);
    assert.match(footer, /<td>4,000<\/td>/,
      'a benign absence must not blank the whole column total');
  }

  // ── viewer 镜像必须和主进程算出同一个数 ──
  // The viewer reimplements estimateCostUsd in the emitted JS because it runs
  // without the main-process modules. Two implementations of one billing contract
  // drift silently: a dimension added on one side just gets ignored on the other,
  // and the user sees two different prices for the same session.
  {
    const mirrorScript = [...renderTapViewerHtml({
      mode: 'static',
      state: { active: false, rootPath: 'qa', sessions: [], traces: [] }
    }).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).at(-1) ?? '';
    const mirrorVm: Record<string, unknown> = {};
    vm.runInNewContext(
      `${extractViewerFunction(mirrorScript, 'estimateCostUsd')}\nglobalThis.viewerCost = estimateCostUsd;`,
      mirrorVm
    );
    const viewerCost = mirrorVm.viewerCost as (usage: unknown, price: unknown) => number | undefined;
    const shortOutputPrice = {
      tokens: ['doubao-seed-1-6'], match: 'exact', protocol: 'openai', providerId: 'volcengine',
      input: 0.1187, output: 1.187, cacheRead: 0.02373,
      tiers: [
        { fromInputTokens: 0, input: 0.1187, output: 1.187, cacheRead: 0.02373, shortOutput: { atMostTokens: 200, output: 0.2966 } },
        { fromInputTokens: 32001, input: 0.178, output: 2.373, cacheRead: 0.02373 }
      ]
    };
    const mirrorCases: readonly { readonly name: string; readonly usage: unknown; readonly price: unknown }[] = [
      {
        name: '短输出优惠档',
        usage: {
          version: 2, input: 20_000, output: 1_150, cacheRead: 0, cacheCreation: 0,
          total: 21_150, apiType: 'responses',
          bands: [
            { tier: 0, offPeak: false, shortOutput: true, input: 8_000, output: 150, cacheRead: 0, cacheCreation: 0 },
            { tier: 0, offPeak: false, input: 12_000, output: 1_000, cacheRead: 0, cacheCreation: 0 }
          ]
        },
        price: shortOutputPrice
      },
      { name: '长度分档', usage: tieredUsage, price: tieredPrice },
      { name: '分时段', usage: peakUsage, price: peakPrice },
      {
        name: '分桶只覆盖部分用量',
        usage: {
          version: 2, input: 30_000, output: 1_000, cacheRead: 0, cacheCreation: 0, total: 31_000,
          apiType: 'responses',
          bands: [{ tier: 0, offPeak: false, input: 10_000, output: 400, cacheRead: 0, cacheCreation: 0 }]
        },
        price: tieredPrice
      },
      {
        name: '分档但缺分桶',
        usage: { version: 2, input: 30_000, output: 1_000, cacheRead: 0, cacheCreation: 0, total: 31_000, apiType: 'responses' },
        price: tieredPrice
      },
      {
        name: 'Anthropic 缓存写 TTL',
        usage: {
          version: 2, input: 1_000, output: 200, cacheRead: 5_000, cacheCreation: 2_000,
          cacheCreation5m: 1_500, cacheCreation1h: 500, total: 8_200, apiType: 'messages'
        },
        price: {
          tokens: ['claude-sonnet-4.5'], match: 'exact', protocol: 'anthropic', providerId: 'anthropic',
          input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6
        }
      },
      {
        name: 'Anthropic 缓存写缺 TTL 拆分',
        usage: {
          version: 2, input: 1_000, output: 200, cacheRead: 0, cacheCreation: 2_000,
          total: 3_200, apiType: 'messages'
        },
        price: {
          tokens: ['claude-sonnet-4.5'], match: 'exact', protocol: 'anthropic', providerId: 'anthropic',
          input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6
        }
      },
      {
        name: 'v1 Responses 无独立输入桶',
        usage: { version: 1, input: 10_000, output: 500, cacheRead: 0, cacheCreation: 0, total: 10_500, apiType: 'responses' },
        price: { tokens: ['gpt-5.4'], match: 'exact', protocol: 'openai', providerId: 'openai', input: 2.5, output: 20, cacheRead: 0.25 }
      },
      {
        name: '按 token-hour 计存储',
        usage: { version: 2, input: 1_000, output: 100, cacheRead: 0, cacheCreation: 500, total: 1_600, apiType: 'responses' },
        price: {
          tokens: ['gemini-3.5-pro'], match: 'exact', protocol: 'openai', providerId: 'google',
          input: 1.25, output: 10, cacheRead: 0.31, cacheStoragePerHour: 4.5
        }
      },
      {
        name: '缺输入用量',
        usage: {
          version: 2, input: 0, output: 100, cacheRead: 0, cacheCreation: 0, total: 100,
          apiType: 'responses', incompleteFields: ['input']
        },
        price: { tokens: ['gpt-5.4'], match: 'exact', protocol: 'openai', providerId: 'openai', input: 2.5, output: 20, cacheRead: 0.25 }
      }
    ];
    for (const item of mirrorCases) {
      const expected = estimateCostUsd(item.usage as never, item.price as never);
      assert.equal(viewerCost(item.usage, item.price), expected,
        `viewer 与主进程对「${item.name}」必须给出同一个结果`);
    }
    assert.ok(
      mirrorCases.some(item => estimateCostUsd(item.usage as never, item.price as never) !== undefined),
      'a mirror comparison where every case is unpriceable would pass vacuously'
    );
  }

  // Token-hour cache storage stays unpriceable rather than being billed as a write.
  assert.equal(
    estimateCostUsd(
      { version: 2, input: 100, output: 10, cacheRead: 0, cacheCreation: 5000, total: 5110, apiType: 'responses' },
      { tokens: ['doubao-seed-2-0-pro'], protocol: 'openai', input: 0.47, output: 2.37, cacheRead: 0.09, cacheStoragePerHour: 0.0025 }
    ),
    undefined,
    'cache billed per token-hour cannot be derived from token counts alone'
  );

  // ── chat-completions 也是子集语义 ──
  const chat = normalizeUsage({
    prompt_tokens: 1200,
    prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 0 },
    completion_tokens: 50
  }, 'openai-chat-completions')!;
  assert.equal(chat.inputIncludesCache, true);
  assert.equal(chat.inputUncachedTokens, 200);
  assert.equal(contextWindowTokens(chat), 1200, 'prompt_tokens already includes cached_tokens');

  // ── 没有任何缓存信息时，两种口径同解，不能凭空打标 ──
  const bare = normalizeUsage({ input_tokens: 100, output_tokens: 10 }, 'unknown')!;
  assert.equal(bare.inputIncludesCache, undefined, 'no cache numbers means no protocol claim');
  assert.equal(contextWindowTokens(bare), 100);

  // ── mergeUsage 必须把判别式带过去，否则 SSE 分片合并后又会翻倍 ──
  const merged = mergeUsage(
    normalizeUsage({ input_tokens: 49910, input_tokens_details: { cached_tokens: 49682, cache_write_tokens: 0 } }, 'openai-responses'),
    normalizeUsage({ output_tokens: 142 }, 'openai-responses')
  )!;
  assert.equal(merged.inputIncludesCache, true, 'the protocol discriminator must survive a merge');
  assert.equal(contextWindowTokens(merged), 49910);
  assert.equal(billableTotalTokens(merged), 49910 + 142,
    'the merged total fallback must not re-add the cache subset either');
  const observedGpt = normalizeUsage({
    input_tokens: 461469,
    input_tokens_details: { cached_tokens: 456996, cache_write_tokens: 1202 },
    output_tokens: 1473,
    total_tokens: 462942
  }, 'openai-responses')!;
  assert.equal(observedGpt.inputUncachedTokens, 3271);
  assert.equal(observedGpt.cacheReadTokens, 456996);
  assert.equal(observedGpt.cacheCreationTokens, 1202);
  assert.equal(observedGpt.outputTokens, 1473);
  assert.equal(observedGpt.totalTokens, 462942);
  const observedClaude = normalizeUsage({
    input_tokens: 9,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 163393,
    output_tokens: 438
  }, 'anthropic-messages')!;
  assert.equal(observedClaude.inputUncachedTokens, 9);
  assert.equal(observedClaude.cacheReadTokens, 0);
  assert.equal(observedClaude.cacheCreationTokens, 163393);
  assert.equal(observedClaude.outputTokens, 438);
  assert.equal(observedClaude.totalTokens, 163840);

  // ── viewer 里的镜像实现必须逐字同口径 ──
  const html = renderTapViewerHtml({
    mode: 'static',
    state: { active: false, rootPath: 'qa', sessions: [], traces: [] }
  });
  const viewerScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).at(-1) ?? '';
  const mirror: Record<string, unknown> = {};
  vm.runInNewContext(
    `${extractViewerFunction(viewerScript, 'contextWindowTokens')}\n`
    + `${extractViewerFunction(viewerScript, 'billableTotalTokens')}\n`
    + `${extractViewerFunction(viewerScript, 'estimateCostUsd')}\n`
    + `${extractViewerFunction(viewerScript, 'usageOf')}\n`
    + `${extractViewerFunction(viewerScript, 'rawUsageOf')}\n`
    + `${extractViewerFunction(viewerScript, 'firstNum')}\n`
    + 'this.api={contextWindowTokens,billableTotalTokens,estimateCostUsd,usageOf};',
    mirror
  );
  const mirrorApi = mirror.api as {
    contextWindowTokens: (u: unknown) => number;
    billableTotalTokens: (u: unknown) => number;
    estimateCostUsd: (u: unknown, price: unknown) => number;
    usageOf: (t: unknown) => Record<string, number | boolean | undefined>;
  };
  for (const usage of [responses, firstTurn, anthropic, anthropicRead, chat, bare, merged]) {
    assert.equal(mirrorApi.contextWindowTokens(usage), contextWindowTokens(usage),
      `viewer contextWindowTokens must mirror normalizeUsage for ${JSON.stringify(usage)}`);
    assert.equal(mirrorApi.billableTotalTokens(usage), billableTotalTokens(usage),
      `viewer billableTotalTokens must mirror normalizeUsage for ${JSON.stringify(usage)}`);
  }
  assert.equal(
    mirrorApi.estimateCostUsd(responsesAggregate, responsesPrice),
    estimateCostUsd(responsesAggregate, responsesPrice),
    'viewer pricing must use the fetched Responses cache-write price'
  );
  assert.equal(
    mirrorApi.estimateCostUsd(bridgedMessagesAggregate, bridgedMessagesPrice),
    estimateCostUsd(bridgedMessagesAggregate, bridgedMessagesPrice),
    'viewer pricing must preserve additive Messages input after protocol bridging'
  );
  assert.equal(
    mirrorApi.estimateCostUsd(anthropicTieredAggregate, anthropicTieredPrice),
    estimateCostUsd(anthropicTieredAggregate, anthropicTieredPrice),
    'viewer pricing must preserve Anthropic cache-write TTL tiers'
  );
  for (const [usage, price, label] of [
    [tieredUsage, tieredPrice, 'input-length tiers'],
    [peakUsage, peakPrice, 'off-peak discounts']
  ] as const) {
    assert.equal(
      mirrorApi.estimateCostUsd(usage, price),
      estimateCostUsd(usage, price),
      `viewer pricing must mirror the main process for ${label}`
    );
  }
  assert.equal(
    mirrorApi.estimateCostUsd(
      { version: 2, input: 30000, output: 1000, cacheRead: 0, cacheCreation: 0, total: 31000, apiType: 'responses' },
      tieredPrice
    ),
    undefined,
    'the viewer must also refuse to price a tiered model with no captured bands'
  );

  // ── 已经落盘的历史 trace 必须回填 ──
  // 它们是旧版 normalizeUsage 写的：没有 inputIncludesCache，也没有 cacheCreationTokens。
  // 不回填的话，改完只有新抓的请求正确，一整屏历史请求仍然显示翻倍的上下文窗口、缓存写仍是 —。
  const legacyCodex = {
    usage: { inputTokens: 51056, outputTokens: 152, totalTokens: 51208, cacheReadTokens: 50734 },
    response: { snapshot: { raw: { usage: {
      input_tokens: 51056,
      input_tokens_details: { cached_tokens: 50734, cache_write_tokens: 319 },
      output_tokens: 152, total_tokens: 51208
    } } } }
  };
  const healed = mirrorApi.usageOf(legacyCodex);
  assert.equal(healed.inputIncludesCache, true,
    'a stored Responses trace must be recognised from its raw usage shape');
  assert.equal(healed.cacheCreationTokens, 319,
    'cache_write_tokens must be recovered for traces captured before it was mapped');
  assert.equal(healed.inputUncachedTokens, 3,
    'historical Responses input must be recovered as a mutually exclusive uncached bucket');
  assert.equal(mirrorApi.contextWindowTokens(healed), 51056,
    'a historical Codex turn must stop reporting a doubled context window');
  // Anthropic 历史 trace 不能被误判成子集语义
  const legacyClaude = {
    usage: { inputTokens: 2, outputTokens: 209, cacheReadTokens: 21747, cacheCreationTokens: 2225 },
    response: { snapshot: { raw: { usage: {
      input_tokens: 2, cache_read_input_tokens: 21747, cache_creation_input_tokens: 2225, output_tokens: 209
      , cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 225 }
    } } } }
  };
  const claudeHealed = mirrorApi.usageOf(legacyClaude);
  assert.equal(claudeHealed.inputIncludesCache, false,
    'top-level cache counts must never be mistaken for the subset shape');
  assert.equal(claudeHealed.inputUncachedTokens, 2);
  assert.equal(mirrorApi.contextWindowTokens(claudeHealed), 2 + 21747 + 2225,
    'a historical Anthropic turn keeps its additive context window');
  assert.equal(claudeHealed.cacheCreation5mTokens, 2000);
  assert.equal(claudeHealed.cacheCreation1hTokens, 225);
  // 没有 raw usage 可依据时不猜
  assert.equal(mirrorApi.usageOf({ usage: { inputTokens: 10 } }).inputIncludesCache, undefined,
    'without raw usage the viewer must not invent a protocol');
  assert.equal(mirrorApi.usageOf({}).inputIncludesCache, undefined);
  const metricsSource = extractViewerFunction(viewerScript, 'renderMetrics');
  // After the mutually-exclusive refactor there is no protocol branch left to
  // take: normalizeUsage/usageOf already reduce both shapes to disjoint buckets,
  // so the token matrix must read the exclusive fields rather than the
  // provider-native inputTokens, and an unreported bucket must render as — and
  // never as 0.
  assert.match(metricsSource, /usage\.inputUncachedTokens/,
    'the token matrix must show the mutually exclusive uncached input bucket');
  assert.doesNotMatch(metricsSource, /tkm\(L\('未缓存输入','Uncached Input'\), usage\.inputTokens/,
    'the token matrix must not fall back to the provider-native input field');
  assert.doesNotMatch(metricsSource, /tkm\(L\('总 Token','Total Tokens'\)/,
    'the expanded token breakdown must not repeat the total already shown in the summary');
  assert.match(metricsSource, /typeof v === 'number' \? num\(v\) : '—'/,
    'a bucket the upstream never reported must render as — instead of a fabricated 0');
  assert.match(metricsSource, /5m '\+num\(usage\.cacheCreation5mTokens\)/,
    'Anthropic cache-write TTL tiers must be visible in the tooltip');
  assert.match(metricsSource, /1h '\+num\(usage\.cacheCreation1hTokens\)/);
  completed.push('Token accounting respects per-protocol cache semantics');
}

// 阅读视角的字段保真度。这里回归的都是「渲染器把上游真给了的信息读丢或读糊」的缺陷。
async function testViewerReadViewFidelity(): Promise<void> {
  const html = renderTapViewerHtml({
    mode: 'static',
    state: { active: false, rootPath: 'qa', sessions: [], traces: [] }
  });
  const viewerScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).at(-1) ?? '';
  const names = ['toolResultText', 'structuredResultLine', 'coalesceTextBlocks', 'textBlockValue', 'compactText',
    'renderCitations', 'safeCitationUrl', 'rawBlockValue', 'esc', 'j', 'L'];
  const ctx: Record<string, unknown> = { num: (n: number) => String(n), URL };
  vm.runInNewContext(
    `const uiLang='zh';${names.map(name => extractViewerFunction(viewerScript, name)).join('\n')}`
    + `;this.api={${names.join(',')}};`,
    ctx
  );
  const api = ctx.api as Record<string, any>;
  assert.equal(api.compactText('Sure! What else\nquestions just', 180), 'Sure! What else questions just',
    'SSE summaries must collapse whitespace without deleting the letter s');

  // System PRETTY 是人类阅读视图：Markdown 与 XML 折叠同时生效，同时保留 MD / RAW。
  const markdownCtx: Record<string, unknown> = {};
  const markdownStart = viewerScript.indexOf('function renderMarkdown');
  const markdownEnd = viewerScript.indexOf('function getMessages', markdownStart);
  const richStart = viewerScript.indexOf('function xmlElements');
  const richEnd = viewerScript.indexOf('function renderImageBlock', richStart);
  assert.ok(markdownStart >= 0 && markdownEnd > markdownStart, 'viewer must keep the Markdown renderer');
  assert.ok(richStart >= 0 && richEnd > richStart, 'viewer must keep the combined PRETTY renderer');
  vm.runInNewContext(
    `const uiLang='zh';\n`
    + `${extractViewerFunction(viewerScript, 'L')}\n`
    + `${extractViewerFunction(viewerScript, 'esc')}\n`
    + `${viewerScript.slice(markdownStart, markdownEnd)}\n`
    + `${viewerScript.slice(richStart, richEnd)}\n`
    + ';this.api={esc,renderMarkdown,renderTextRich};',
    markdownCtx
  );
  const markdownApi = markdownCtx.api as Record<string, any>;
  const nestedMarkdown = markdownApi.renderMarkdown([
    '## Parent',
    '- First',
    '  - Child',
    '    1. Ordered child',
    '  - Second child',
    '- Last',
    '<script>alert(1)</script>'
  ].join('\n')) as string;
  assert.match(nestedMarkdown, /<h2 class="md-h">Parent<\/h2>/,
    'Markdown headings must render in the reading view');
  assert.match(nestedMarkdown, /<ul class="md-list md-ul"><li><span class="md-li-text">First<\/span><ul class="md-list md-ul">/,
    'indented bullet lists must remain nested instead of being flattened');
  assert.match(nestedMarkdown, /<ol class="md-list md-ol"><li><span class="md-li-text">Ordered child<\/span>/,
    'ordered sublists must preserve their list type');
  assert.equal((nestedMarkdown.match(/<li>/g) || []).length, 5,
    'every Markdown list item must survive the renderer');
  assert.doesNotMatch(nestedMarkdown, /<script>/,
    'upstream Markdown must never execute embedded HTML');
  assert.match(nestedMarkdown, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/,
    'escaped source text remains visible instead of being discarded');
  const mixedPretty = markdownApi.renderTextRich([
    '## Context',
    '<environment_context>',
    '- Root',
    '  - Child',
    '</environment_context>'
  ].join('\n')) as string;
  assert.match(mixedPretty, /<h2 class="md-h">Context<\/h2>/,
    'PRETTY must render Markdown outside folded XML blocks');
  assert.match(mixedPretty, /<details class="xml-fold" open>/,
    'PRETTY must retain collapsible XML structures');
  assert.match(mixedPretty, /<ul class="md-list md-ul">[\s\S]*<ul class="md-list md-ul">/,
    'Markdown inside a folded XML block must retain its hierarchy');
  const environmentPretty = markdownApi.renderTextRich([
    '<environment_context>',
    '  <cwd>/Users/example</cwd>',
    '  <shell>zsh</shell>',
    '  <current_date>2026-08-11</current_date>',
    '  <timezone>Asia/Shanghai</timezone>',
    '  <filesystem><workspace_roots><root>/Users/example</root></workspace_roots><permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry><entry access="write"><path>/Users/example</path></entry></file_system></permission_profile></filesystem>',
    '</environment_context>'
  ].join('\n')) as string;
  assert.match(environmentPretty, /class="xml-fold env-context"/,
    'known environment context must use the semantic PRETTY surface');
  assert.match(environmentPretty, /环境上下文/,
    'the semantic PRETTY heading must use a readable label instead of protocol punctuation');
  assert.doesNotMatch(environmentPretty, /&lt;environment_context&gt;/,
    'the recognized outer tag belongs in RAW, not in the semantic PRETTY heading');
  assert.match(environmentPretty, /工作目录[\s\S]*\/Users\/example[\s\S]*当前日期[\s\S]*2026-08-11/,
    'common environment fields must become compact readable facts');
  assert.match(environmentPretty, /class="env-file"/,
    'filesystem detail must remain independently collapsible');
  assert.doesNotMatch(environmentPretty, /<details class="env-file" open/,
    'verbose filesystem permissions must start collapsed');
  assert.match(environmentPretty, /1 个工作区 · managed · restricted · 2 条权限/,
    'the collapsed filesystem row must summarize workspace, mode and rule count');
  assert.match(environmentPretty, /<span class="env-file-label">读取<\/span>[\s\S]*:root/,
    'permission rows must retain access and target details');
  assert.doesNotMatch(environmentPretty, /&lt;cwd&gt;|&lt;filesystem&gt;/,
    'PRETTY must not expose XML punctuation for a fully recognized environment payload');
  const unknownEnvironment = markdownApi.renderTextRich('<environment_context>\n  <extra>keep me</extra>\n</environment_context>') as string;
  assert.match(unknownEnvironment, /&lt;extra&gt;keep me&lt;\/extra&gt;/,
    'an unknown environment shape must fall back to the lossless generic renderer');
  const nestedUnknownEnvironment = markdownApi.renderTextRich('<environment_context>\n  <cwd><secret>keep nested</secret></cwd>\n</environment_context>') as string;
  assert.match(nestedUnknownEnvironment, /&lt;cwd&gt;&lt;secret&gt;keep nested&lt;\/secret&gt;&lt;\/cwd&gt;/,
    'unknown content nested inside a known field must also trigger the lossless fallback');
  const attributedUnknownEnvironment = markdownApi.renderTextRich('<environment_context>\n  <cwd source="future">/Users/example</cwd>\n</environment_context>') as string;
  assert.match(attributedUnknownEnvironment, /source=&quot;future&quot;/,
    'unknown attributes on known fields must remain visible through the generic fallback');
  const systemRenderer = extractViewerFunction(viewerScript, 'renderSystem');
  assert.match(systemRenderer, /data-sysfmt-pane="text"[\s\S]*renderTextRich\(text\)/,
    'System PRETTY must use the combined Markdown and XML renderer');
  assert.match(systemRenderer, /data-sysfmt-pane="markdown"[\s\S]*renderMarkdown\(text\)/,
    'the separate pure Markdown view must remain available');
  assert.match(systemRenderer, /data-sysfmt-pane="raw"[\s\S]*esc\(text\)/,
    'RAW must continue to expose the escaped original text');

  // ── web_search_tool_result：结果项没有 text/output 字段，裸 j() 会把每条 2KB 的
  //    encrypted_content 全倒出来，标题和 URL 被埋在密文后面（实测 10 条 = 20KB，18KB 是密文）。
  const searchResults = [
    { type: 'web_search_result', title: 'NYC Weather', url: 'https://wunderground.test/nyc', page_age: '2 weeks ago', encrypted_content: 'A'.repeat(2540) },
    { type: 'web_search_result', title: 'ABC7 Radar', url: 'https://abc7ny.test/weather', encrypted_content: 'B'.repeat(2712) }
  ];
  const rendered = api.toolResultText(searchResults) as string;
  assert.ok(rendered.length < 400, `search results must not dump ciphertext, got ${rendered.length} chars`);
  assert.doesNotMatch(rendered, /A{200}|B{200}/, 'encrypted_content must never be inlined');
  assert.match(rendered, /NYC Weather — https:\/\/wunderground\.test\/nyc/, 'title and URL are what the reader needs');
  assert.match(rendered, /2 weeks ago/, 'page_age is short and worth keeping');
  assert.match(rendered, /2540/, 'the ciphertext is reported as a length instead of inlined');
  // tool_reference 同样既没 text 也没 output
  assert.equal(
    api.toolResultText([{ type: 'tool_reference', tool_name: 'WebSearch' }, { type: 'tool_reference', tool_name: 'WebFetch' }]),
    'WebSearch\nWebFetch',
    'tool_reference blocks must read as names, not raw JSON'
  );
  // 识别不了的形状仍然无损回退到 JSON
  assert.match(api.toolResultText([{ type: 'brand_new_shape', payload: { a: 1 } }]), /brand_new_shape/,
    'an unrecognised item must still fall back to lossless JSON');
  assert.equal(api.toolResultText([{ type: 'text', text: 'plain' }]), 'plain', 'text items are untouched');

  // ── 相邻 text 块必须并回一段：Anthropic 把带引用的回答切成交替块，实测一次回答 22 个块里
  //    20 个是 text，有的只是半句话、有的只是一个空格；每块一个段落会切出 20 个断句段落。
  const shredded = [
    { type: 'text', text: 'Additional conditions included a dew point of 76°F' },
    { type: 'text', text: ' — quite humid.', citations: [{ type: 'web_search_result_location', url: 'https://a.test', title: 'A' }] },
    { type: 'text', text: ' ' },
    { type: 'text', text: 'Tonight: showers.', citations: [{ type: 'web_search_result_location', url: 'https://b.test', title: 'B' }] },
    { type: 'tool_use', id: 't1', name: 'web_search', input: {} },
    { type: 'text', text: 'after the tool call' }
  ];
  const coalesced = api.coalesceTextBlocks(shredded) as Array<Record<string, any>>;
  assert.equal(coalesced.length, 3, 'the four leading fragments become one paragraph; the tool call splits the run');
  assert.equal(
    api.textBlockValue(coalesced[0]),
    'Additional conditions included a dew point of 76°F — quite humid. Tonight: showers.',
    'fragments must rejoin exactly, healing the mid-sentence seam'
  );
  assert.equal((coalesced[0].citations ?? []).length, 2, 'citations from every merged fragment must survive');
  assert.equal(coalesced[1].type, 'tool_use', 'a non-text block must not be absorbed');
  assert.equal(api.textBlockValue(coalesced[2]), 'after the tool call',
    'text after a tool call stays its own paragraph');
  // 不同类型不合并，短列表原样返回
  assert.equal((api.coalesceTextBlocks([{ type: 'text', text: 'a' }, { type: 'output_text', text: 'b' }]) as unknown[]).length, 2,
    'text and output_text belong to different protocols and must not merge');
  assert.equal((api.coalesceTextBlocks([]) as unknown[]).length, 0);
  assert.equal((api.coalesceTextBlocks(undefined) as unknown[]).length, 0, 'a missing content array must not throw');

  // ── citations 渲染：encrypted_index 不透明，不能渲染出来 ──
  const citeHtml = api.renderCitations([
    { type: 'web_search_result_location', title: 'Weather Underground', url: 'https://wu.test/a', cited_text: '78 F', encrypted_index: 'IDX_SECRET' }
  ]) as string;
  assert.match(citeHtml, /href="https:\/\/wu\.test\/a"/, 'a citation must link to its source');
  assert.match(citeHtml, /\[1\] Weather Underground/, 'citations are numbered footnotes');
  assert.match(citeHtml, /title="78 F"/, 'the cited snippet belongs in the tooltip');
  assert.doesNotMatch(citeHtml, /IDX_SECRET/, 'the opaque encrypted_index must not be rendered');
  assert.match(citeHtml, /rel="noopener noreferrer"/, 'external citations must isolate their opener');
  const unsafeCite = api.renderCitations([
    { title: 'Do not execute', url: 'javascript:alert(document.domain)' }
  ]) as string;
  assert.doesNotMatch(unsafeCite, /<a\b|href=/,
    'model-provided citation URLs must not make non-HTTP schemes clickable');
  assert.match(unsafeCite, /<span class="citation"/, 'an unsafe URL keeps its readable label without a link');
  assert.equal(api.safeCitationUrl('https://example.test/a'), 'https://example.test/a');
  assert.equal(api.safeCitationUrl('data:text/html,pwned'), '');
  assert.equal(api.renderCitations([]), '', 'no citations renders nothing at all');
  assert.equal(api.renderCitations(undefined), '', 'a block without citations is byte-identical to before');
  // 正文与响应两条路径都必须挂上引用条
  assert.match(viewerScript, /renderTextRich\(textBlockValue\(b\)\)\+'<\/div>'\+renderCitations\(b\.citations\)/,
    'message text blocks must render their citations');
  assert.match(viewerScript, /renderTextRich\(b\.text \|\| ''\)\+'<\/div>'\+renderCitations\(b\.citations\)/,
    'response text blocks must render their citations too');

  // ── namespace / 工具计数 / System 去重 / 对比参数 ──
  const p1Names = ['bodyOf', 'declaredToolList', 'normalizeToolDecl', 'searchLoadedTools', 'tools',
    'toolsCount', 'callableToolCount', 'normalizeMessage', 'getMessages', 'parseJsonMaybe',
    'geminiMessage', 'qualifiedToolName', 'isSystemRole', 'messageRoleLabel', 'systemEntries', 'msgsToText', 'reasoningItemText',
    'b64Utf8', 'j'];
  const p1Ctx: Record<string, unknown> = { atob, TextDecoder, Buffer };
  vm.runInNewContext(
    `${p1Names.map(name => extractViewerFunction(viewerScript, name)).join('\n')};this.api={${p1Names.join(',')}};`,
    p1Ctx
  );
  const p1 = p1Ctx.api as Record<string, any>;

  // namespace 是调用归属的唯一线索：MCP 子工具名形如 _fetch_pr，丢了就认不出属于哪个 server
  assert.equal(p1.qualifiedToolName('multi_agent_v1', 'spawn_agent'), 'multi_agent_v1.spawn_agent');
  assert.equal(p1.qualifiedToolName('mcp__codex_apps__github', '_fetch_pr'), 'mcp__codex_apps__github._fetch_pr');
  assert.equal(p1.qualifiedToolName(undefined, 'shell'), 'shell', 'a plain call keeps its bare name');
  assert.equal(p1.qualifiedToolName('ns', undefined), 'ns');
  const nsCall = p1.normalizeMessage({ type: 'function_call', call_id: 'call_1', namespace: 'multi_agent_v1', name: 'spawn_agent', arguments: '{}' });
  assert.equal(nsCall.content[0].name, 'multi_agent_v1.spawn_agent',
    'a namespaced call must render qualified, not as a bare spawn_agent');

  // 工具计数按可调用数算：namespace 在声明列表里只占一项，却挂着 N 个真正能调的子工具
  const nsTrace = { request: { body: { tools: [
    { type: 'function', name: 'shell' },
    { type: 'namespace', name: 'mcp__codex_apps__github', tools: [{ name: '_fetch_pr' }, { name: '_create_issue' }, { name: '_search' }] },
    { type: 'namespace', name: 'multi_agent_v1', tools: [{ name: 'spawn_agent' }, { name: 'wait_agent' }] },
    { type: 'namespace', name: 'mcp__not_yet_loaded', tools: [] }
  ] } } };
  assert.equal(p1.tools(nsTrace).length, 4, 'the declaration list itself still has 4 entries');
  assert.equal(p1.toolsCount(nsTrace), 1 + 3 + 2 + 1,
    'the header count must reflect callable tools, since that is what makes the prompt heavy');
  assert.equal(p1.callableToolCount({ type: 'namespace', name: 'empty', tools: [] }), 1,
    'a namespace whose children are not loaded yet still counts as one entry');

  // System 去重：messages/input 里的 system|developer 项已经在 System 区展示过
  const dupTrace = { request: { body: {
    system: [{ type: 'text', text: 'TOP LEVEL SYSTEM' }],
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'INJECTED SYSTEM '.repeat(200) }] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] }
    ]
  } } };
  const dupMsgs = Array.from(p1.getMessages(dupTrace) as Array<Record<string, any>>);
  assert.equal(dupMsgs[0].systemEcho, true,
    'a system message must be marked as already shown in the System section');
  assert.ok(dupMsgs[0].systemEchoLen > 3000, 'the stub must state how much text it stands in for');
  assert.equal(dupMsgs[0].systemEchoOrigin, 'body.messages[0].content',
    'the stub must point at the exact protocol path');
  assert.equal(dupMsgs[0].systemEchoLabel, 'MESSAGES.SYSTEM',
    'the Messages stub must reuse the exact carrier label shown in the System section');
  assert.equal(dupMsgs[1].systemEcho, undefined, 'a user message is not a system echo');
  const inputWithTools = { request: { body: { input: [
    { type: 'additional_tools', role: 'developer', tools: [{ name: 'shell' }] },
    { role: 'developer', content: [{ type: 'text', text: 'SYSTEM AFTER TOOLS' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'hello' }] }
  ] } } };
  const filteredInput = Array.from(p1.getMessages(inputWithTools) as Array<Record<string, any>>);
  assert.equal(filteredInput.length, 2, 'additional_tools is a declaration, not a conversation message');
  assert.equal(filteredInput[0].systemEchoOrigin, 'body.input[1].content',
    'filtering additional_tools must preserve the original input array index in the System pointer');
  assert.equal(filteredInput[0].systemEchoLabel, 'INPUT.DEVELOPER',
    'a Responses developer stub must use the exact INPUT.DEVELOPER carrier label');
  const filteredSystemEntries = Array.from(p1.systemEntries(inputWithTools) as Array<Record<string, any>>);
  assert.equal(filteredSystemEntries[0].label, filteredInput[0].systemEchoLabel,
    'the upper System entry and Messages stub must use the same derived label');
  const geminiSystemEntries = Array.from(p1.systemEntries({ request: { body: {
    systemInstruction: { parts: [{ text: 'Gemini system text' }] }
  } } }) as Array<Record<string, any>>);
  assert.equal(geminiSystemEntries[0]?.text, 'Gemini system text',
    'Gemini systemInstruction.parts text must not disappear from System');
  assert.match(viewerScript, /m\.systemEcho\s*\n?\s*\?\s*'<div class="msg-echo">'/,
    'renderMessages must render the stub instead of the full text');
  assert.match(viewerScript, /m\.systemEchoLabel \|\| m\.role/,
    'renderMessages must use the System-section carrier label for a deduplicated message');
  // 角色和位置仍在，去掉的只是重复的正文
  assert.equal(dupMsgs[0].role, 'system', 'the role stays so the conversation shape is intact');
  assert.equal(dupMsgs.length, 2, 'no message is dropped');

  const readViewSource = extractViewerFunction(viewerScript, 'renderReadView');
  assert.doesNotMatch(readViewSource, /请求参数|Request Params|section\('params'/,
    'the reading view must not expose raw request parameters');
  assert.match(readViewSource, /section\('sse'/,
    'SSE Events must remain a first-class section in the reading view');
  assert.match(viewerScript, /const skip = new Set\(PARAM_DIFF_SKIP\)/,
    'request parameter changes remain available only in Compare');

  const schemaNames = ['normalizeToolDecl', 'flattenSchemaRows', 'renderSchemaRow', 'schemaTypeName', 'schemaTypeLabel',
    'schemaHelp', 'renderParams', 'embeddedToolEntries', 'renderEmbeddedTools', 'toolDescriptionIntro',
    'esc', 'j', 'L'];
  const schemaCtx: Record<string, unknown> = {};
  vm.runInNewContext(
    `const uiLang='zh';${schemaNames.map(name => extractViewerFunction(viewerScript, name)).join('\n')}`
    + `;this.api={${schemaNames.join(',')}};`,
    schemaCtx
  );
  const schemaApi = schemaCtx.api as Record<string, any>;
  const originalTool = {
    type: 'function',
    function: {
      name: 'inspect', description: 'Inspect nested input', parameters: {
        type: 'object', additionalProperties: false, required: ['items'], properties: {
          items: { type: 'array', encrypted: true, items: { type: 'object', properties: {
            mode: { type: 'string', enum: ['fast', 'full'], default: 'full' }
          } } }
        }
      }
    }
  };
  const normalizedTool = schemaApi.normalizeToolDecl(originalTool);
  assert.equal(normalizedTool.rawDeclaration, undefined,
    'Read-mode normalization must not carry a second raw declaration into the pretty renderer');
  const schemaRows = schemaApi.flattenSchemaRows(normalizedTool.input_schema, '', false, 0) as Array<Record<string, unknown>>;
  assert.deepEqual(Array.from(schemaRows, row => ({ name: row.name, depth: row.depth })), [
    { name: 'items', depth: 0 },
    { name: 'mode', depth: 1 }
  ], 'nested schema fields must use visual depth instead of programmer-facing JSON paths');
  const questionRows = schemaApi.flattenSchemaRows({ type: 'object', properties: {
    options: { type: 'array', items: { type: 'object', properties: {
      label: { type: 'string' }, description: { type: 'string' }
    } } },
    question: { type: 'string' }
  } }, '', false, 0) as Array<Record<string, unknown>>;
  assert.deepEqual(Array.from(questionRows, row => ({ name: row.name, depth: row.depth })), [
    { name: 'question', depth: 0 },
    { name: 'options', depth: 1 },
    { name: 'label', depth: 2 },
    { name: 'description', depth: 2 }
  ], 'human reading order must place options under question instead of presenting them as peers');
  const schemaHtml = schemaApi.renderParams(normalizedTool.input_schema, normalizedTool) as string;
  for (const expected of ['items', 'mode', '对象列表', '可选值：fast, full', '默认：full']) {
    assert.match(schemaHtml, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `flat tool schema must surface ${expected}`);
  }
  assert.doesNotMatch(schemaHtml, /items\[\]|items\.mode|\[items\]|additionalProperties|encrypted|schema-node/,
    'Read mode must avoid programmer-facing paths, transport internals and recursive card markup');
  const claudeSchema = {
    type: 'object', properties: {
      status: { description: 'New status for the task', anyOf: [
        { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
        { type: 'string', const: 'deleted' }
      ] },
      runId: { type: 'string', pattern: '^wf_[a-z0-9-]{6,}$' },
      width: { type: 'integer', exclusiveMinimum: 0, maximum: 9007199254740991 },
      metadata: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: {} }
    }
  };
  const claudeRows = schemaApi.flattenSchemaRows(claudeSchema, '', false, 0) as Array<Record<string, unknown>>;
  const statusRow = claudeRows.find(row => row.name === 'status');
  assert.match(String(statusRow?.help), /可选值：pending, in_progress, completed, deleted/,
    'enum and const values nested in Claude anyOf branches must remain visible');
  assert.match(String(claudeRows.find(row => row.name === 'runId')?.help), /模式：\^wf_/,
    'Claude string patterns must not disappear from the human-readable schema');
  assert.match(String(claudeRows.find(row => row.name === 'width')?.help), /大于 0[\s\S]*最大 9007199254740991/,
    'exclusive and inclusive numeric bounds must keep their exact meaning without open-ended dash placeholders');
  assert.match(String(claudeRows.find(row => row.name === 'metadata')?.help), /键名：文本/,
    'map key constraints must remain visible on the owning field');
  const anyKey = claudeRows.find(row => row.name === '任意键');
  assert.equal(anyKey?.type, '任意值', 'an unconstrained map value should read as any value, not unspecified');
  const claudeSchemaHtml = schemaApi.renderParams(claudeSchema, { type: 'function' }) as string;
  assert.match(claudeSchemaHtml, /class="schema-head"/,
    'field, type and required state must share one readable heading line');
  assert.doesNotMatch(claudeSchemaHtml, /question\[\]|\.status|完整定义|additionalProperties/,
    'the reading surface must remain a human view rather than a raw schema dump');

  const execDescription = `Run JavaScript code to orchestrate tool calls.

### \`exec_command\`
Runs a command in a PTY, returning output or a session ID.

exec tool declaration:
\`\`\`ts
declare const tools: { exec_command(args: unknown): Promise<unknown> };
\`\`\`

### \`update_plan\`
Updates the task plan.

exec tool declaration:
\`\`\`ts
declare const tools: { update_plan(args: unknown): Promise<unknown> };
\`\`\``;
  const embedded = schemaApi.embeddedToolEntries(execDescription) as Array<Record<string, string>>;
  assert.deepEqual(Array.from(embedded, entry => ({ ...entry })), [
    { name: 'exec_command', summary: 'Runs a command in a PTY, returning output or a session ID.' },
    { name: 'update_plan', summary: 'Updates the task plan.' }
  ], 'exec Markdown must become a human-readable internal-operation list');
  const embeddedHtml = schemaApi.renderEmbeddedTools(embedded, execDescription, 'exec') as string;
  assert.match(embeddedHtml, /exec 提供的工具/,
    'the nested list title must explain which tool exposes these callable tools');
  assert.match(embeddedHtml, /exec_command/);
  assert.match(embeddedHtml, /Runs a command in a PTY/);
  assert.doesNotMatch(embeddedHtml, /declare const|exec tool declaration|```/,
    'TypeScript declarations must stay out of the Read view');
  assert.doesNotMatch(viewerScript, /renderToolRaw|完整定义|Complete definition|class="tool-raw"|class="tool-grammar"/,
    'the tool declaration area must not expose raw definitions in Read mode');
  assert.doesNotMatch(viewerScript, /内部操作|Internal operations/,
    'generic internal-operation wording does not explain the nested tool relationship');

  assert.doesNotMatch(viewerScript, /renderResponseMeta|RESPONSE ID|CACHE READ|CACHE WRITE/,
    'Response reading cards must not repeat provider ids or usage already available in Log, SSE and the header metrics');
  assert.match(viewerScript, /class="msg-phase"/,
    'message phase belongs beside the role instead of taking a separate row');
  assert.match(viewerScript, /CALL ID/,
    'tool calls and callbacks must expose their correlation id');
  assert.match(viewerScript, /callNames\[callId\]/,
    'a tool callback should resolve its paired tool name when the call is in message history');
  assert.match(extractViewerFunction(viewerScript, 'renderSubtools'), /<details class="tool-child">/,
    'namespace children must stay individually collapsible so complete schemas do not flood the page');
  completed.push('Read view keeps web-search results, citations and whole answers');
}

// Claude 与 ChatGPT 的呈现统一。同一段系统提示不该因为承载它的协议字段不同就换个颜色，
// 同名并行子 Agent 也不该只有 Codex 有区分标记。
async function testClientPresentationParity(): Promise<void> {
  const html = renderTapViewerHtml({
    mode: 'static',
    state: { active: false, rootPath: 'qa', sessions: [], traces: [] }
  });
  const viewerScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).at(-1) ?? '';

  // ── System 类 pill 全部统一到 developer 的紫色 ──
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(
    `${extractViewerFunction(viewerScript, 'roleClass')};this.roleClass=roleClass;`,
    ctx
  );
  const roleClass = ctx.roleClass as (role: string) => string;
  assert.equal(roleClass('system'), 'developer',
    'Anthropic system and OpenAI developer are the same concept and must share one pill colour');
  assert.equal(roleClass('developer'), 'developer');
  assert.equal(roleClass('user'), 'user', 'unrelated roles keep their own colours');
  assert.equal(roleClass('assistant'), 'assistant');
  assert.equal(roleClass('tool'), 'tool');
  assert.equal(roleClass('nonsense'), 'unknown');
  // systemEntries 的四个顶层载体也必须同色
  const entriesSource = extractViewerFunction(viewerScript, 'systemEntries');
  const carriers: Array<[string, RegExp]> = [
    ['BODY.SYSTEM', /add\(b\.system,'BODY\.SYSTEM','developer'/],
    ['BODY.INSTRUCTIONS', /add\(b\.instructions,'BODY\.INSTRUCTIONS','developer'/],
    ['BODY.SYSTEMINSTRUCTION', /add\(b\.systemInstruction,'BODY\.SYSTEMINSTRUCTION','developer'/],
    ['MESSAGES.*', /messageRoleLabel\('MESSAGES',m\.role\),'developer'/],
    ['INPUT.*', /messageRoleLabel\('INPUT',m\.role\),'developer'/]
  ];
  for (const [label, pattern] of carriers) {
    assert.match(entriesSource, pattern,
      `${label} carries the same system prompt, so it must get the same pill colour`);
  }
  assert.doesNotMatch(entriesSource, /m\.role === 'developer' \? 'developer' : 'system'/,
    'the per-protocol colour split must be gone');
  assert.match(html, /\.pill\.system,\.pill\.developer\{color:var\(--violet\)\}/,
    'both pill classes must resolve to the same violet');
  // 标签文字仍要区分协议位置——统一的是颜色，不是信息
  const labelSource = extractViewerFunction(viewerScript, 'messageRoleLabel');
  assert.match(labelSource, /carrier\+'\.'\+String\(role/,
    'developer labels must preserve the real INPUT or MESSAGES carrier without inferred suffixes');
  assert.doesNotMatch(labelSource, /FRAMEWORK|CONVERSATION/,
    'developer labels must not infer framework or conversation semantics from position');

  // ── 子 Agent 短 id 徽标：与客户端无关，从 invocationId 派生 ──
  const idCtx: Record<string, unknown> = {};
  vm.runInNewContext(
    `${extractViewerFunction(viewerScript, 'shortAgentId')};this.shortAgentId=shortAgentId;`,
    idCtx
  );
  const shortAgentId = idCtx.shortAgentId as (id: unknown) => string;
  // Codex：thread id（等价于旧的 threadId.replace(/-/g,'').slice(-6)）
  assert.equal(shortAgentId('019fd19a-28ba-7f72-8e16-9eb7aaa7a71d'), 'a7a71d',
    'a Codex thread id must yield the same short id the old ancestry field produced');
  // Claude：Task 的 tool_use id —— 以前完全没有徽标
  assert.equal(shortAgentId('toolu_bdrk_011gSiVEWKjMyhn2JKpZt3SL'), 'pZt3SL',
    'a Claude Task invocation must produce a short id too, not stay unmarked');
  assert.equal(shortAgentId(''), '', 'no invocation id means no badge');
  assert.equal(shortAgentId(undefined), '');
  assert.equal(shortAgentId('ab'), 'ab', 'a short id shorter than 6 chars is used as-is');
  assert.match(viewerScript, /shared\.shortId = shortAgentId\(info\.subInvocationId\) \|\| shortAgentId\(info\.subAgentId\)/,
    'the rail must derive the badge from invocationId for every client, falling back to the agent header id');
  assert.match(viewerScript, /class="gid"/, 'the rail must render a dedicated short-id badge');
  // 折叠时 gkind 被隐藏，短 id 徽标不能跟着消失——折叠态它往往是唯一区分标记
  assert.match(html, /\.sagroup:not\(\.open\)>\.sahead \.gkind\{display:none\}/,
    'the agent-type slot still hides when collapsed');
  assert.doesNotMatch(html, /\.sagroup:not\(\.open\)>\.sahead \.gid\{display:none\}/,
    'the short-id badge must survive collapse');
  assert.match(html, /\.sahead \.gid\{flex:0 0 auto/,
    'the badge must not compete with the name for truncation');
  // agentType 槽位不再被 hex 短 id 占用（extractCodexThreadAncestry 已不再返回 shortId，
  // 见 testCodexEnhancements），subagentColor 才能重新看到真名
  const colourCtx: Record<string, unknown> = {};
  vm.runInNewContext(
    `${extractViewerFunction(viewerScript, 'subagentColor')};this.subagentColor=subagentColor;`,
    colourCtx
  );
  const subagentColor = colourCtx.subagentColor as (name: string) => string[];
  assert.equal(subagentColor('Explore')[0], 'var(--violet)',
    'with agentType freed, a Codex Explore agent finally gets its accent colour');

  // ── 一个子 Agent 只能是一张卡 ──
  // Claude 的 prompt hash 只在子 agent 首条请求盖得上章，进入工具循环后就再也匹配不上。
  // 实测会话 02-43-59：一个子 agent 的 13 条请求全带同一个 x-claude-code-agent-id，
  // 但只有 6 条盖上章，仅按盖章结果归组会被切成 3 张卡（查询纽约天气 / Subagent / WebSearch）。
  const groupCtx: Record<string, unknown> = {};
  vm.runInNewContext(
    `${extractViewerFunction(viewerScript, 'traceAgentId')}\n`
    + `${extractViewerFunction(viewerScript, 'isPlaceholderAgentName')}\n`
    + 'this.api={traceAgentId,isPlaceholderAgentName};',
    groupCtx
  );
  const groupApi = groupCtx.api as {
    traceAgentId: (t: unknown, structured: unknown) => string;
    isPlaceholderAgentName: (name: unknown) => boolean;
  };
  const AGENT_ID = 'a91fb5cc7152599c7';
  // 新抓的 trace：落盘的 subagentInfo.agentId 直接可用
  assert.equal(groupApi.traceAgentId({}, { agentId: AGENT_ID }), AGENT_ID);
  // 历史 trace：字段还没有，必须回读 header，否则老会话里仍然是三张卡
  assert.equal(
    groupApi.traceAgentId({ request: { headers: { 'x-claude-code-agent-id': AGENT_ID } } }, {}),
    AGENT_ID,
    'a trace captured before agentId existed must still group, by reading the header'
  );
  assert.equal(
    groupApi.traceAgentId({ request: { headers: { 'X-Claude-Code-Agent-Id': [AGENT_ID] } } }, {}),
    AGENT_ID,
    'header lookup must be case-insensitive and tolerate array values'
  );
  assert.equal(groupApi.traceAgentId({ request: { headers: {} } }, {}), '',
    'no header and no field means no agent id — do not invent one');
  assert.equal(groupApi.traceAgentId({}, undefined), '');
  // 归组键必须优先 agentId，否则盖章与未盖章的请求仍会分家
  assert.match(viewerScript, /const identity = agentId \? 'agent:'\+agentId : \(invocationId \? 'id:'\+invocationId : 'name:'\+agent\)/,
    'the rail identity must prefer the per-agent header id over the parent invocation id');
  assert.match(viewerScript, /subagentInfo&&t\.subagentInfo\.agentId/,
    'logicalTraceView cache invalidation must include the agent id that changes grouping');
  // 占位名不能因为先到就赢：真名一到就顶掉
  assert.equal(groupApi.isPlaceholderAgentName('Subagent'), true);
  assert.equal(groupApi.isPlaceholderAgentName('AgentSDK'), true);
  assert.equal(groupApi.isPlaceholderAgentName(''), true);
  assert.equal(groupApi.isPlaceholderAgentName('查询纽约天气'), false);
  assert.equal(groupApi.isPlaceholderAgentName('WebSearch'), false,
    'a real tool name is not a placeholder');
  assert.match(viewerScript, /if\(isPlaceholderAgentName\(shared\.agent\) && !isPlaceholderAgentName\(agent\)\) shared\.agent = agent;/,
    'a later real name must be allowed to replace a placeholder, but not the reverse');
  // 同一个子 Agent 被主回合切成多段时，每段共享同一份身份元数据；否则后面几段退回裸 "Subagent"
  assert.match(viewerScript, /const shared = identityMeta\[identity\] \|\| \(identityMeta\[identity\] = /,
    'segments of one agent must share name/type/badge, since only the hash-stamped request carries them');
  assert.match(viewerScript, /if\(seenIdentity\[identity\]\) group\.continuation = true;/,
    'once every segment shows the same name, all but the first must be marked as continuations');

  // ── 「没有明文」的两种情况文案要分开，密文要折叠 ──
  const thinkCtx: Record<string, unknown> = { num: (n: number) => String(n) };
  vm.runInNewContext(
    `const uiLang='zh';${extractViewerFunction(viewerScript, 'hiddenThinkingNote')}\n`
    + `${extractViewerFunction(viewerScript, 'collapsedBlob')}\n`
    + `${extractViewerFunction(viewerScript, 'L')}\n`
    + `${extractViewerFunction(viewerScript, 'esc')}\n`
    + 'this.api={hiddenThinkingNote,collapsedBlob};',
    thinkCtx
  );
  const thinkApi = thinkCtx.api as {
    hiddenThinkingNote: (b: unknown, sig: string) => string;
    collapsedBlob: (label: string, value: string) => string;
  };
  // Responses reasoning：请求自己要了 include:['reasoning.encrypted_content'] 且 summary:'auto'
  // 这一步没产出摘要，说成「上游已加密隐藏」是把两件事混了
  const reasoningNote = thinkApi.hiddenThinkingNote({ sigOrigin: 'reasoning' }, 'x'.repeat(952));
  assert.match(reasoningNote, /没有下发思考摘要/, 'a Responses reasoning item states that no summary was produced');
  assert.doesNotMatch(reasoningNote, /上游已加密/,
    'it must not blame upstream encryption: the request itself asked for the encrypted payload');
  // Anthropic signature-only：这才是上游真的隐去了明文
  const sigNote = thinkApi.hiddenThinkingNote({}, 'y'.repeat(120));
  assert.match(sigNote, /上游已加密/, 'a signature-only Anthropic thinking block really is withheld upstream');
  assert.match(sigNote, /120/, 'the note reports the payload length');
  // 1KB base64 不能直接铺在气泡里
  const blob = thinkApi.collapsedBlob('加密载荷', 'z'.repeat(952));
  assert.match(blob, /^<details class="think-blob">/, 'the ciphertext must be collapsed by default');
  assert.match(blob, /952/, 'the summary line reports the length');
  assert.equal(thinkApi.collapsedBlob('加密载荷', ''), '', 'nothing to collapse means no markup');

  // ── 声明里改变行为的字段不能被丢掉 ──
  const flagCtx: Record<string, unknown> = {};
  vm.runInNewContext(
    `const uiLang='zh';${extractViewerFunction(viewerScript, 'toolDeclFlags')}\n`
    + `${extractViewerFunction(viewerScript, 'L')}\n`
    + `${extractViewerFunction(viewerScript, 'esc')}\n`
    + 'this.toolDeclFlags=toolDeclFlags;',
    flagCtx
  );
  const toolDeclFlags = flagCtx.toolDeclFlags as (tool: unknown) => string;
  assert.match(toolDeclFlags({ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }), /8/,
    'max_uses caps how often the model may call the tool and must be visible');
  const offFlags = toolDeclFlags({ type: 'web_search', external_web_access: false });
  assert.match(offFlags, /关闭/, 'external_web_access:false says web access is OFF — the most important flag to show');
  assert.match(toolDeclFlags({ type: 'web_search', external_web_access: true }), /开启/);
  assert.match(toolDeclFlags({ name: 'DeferredToolPlaceholder', defer_loading: true }), /tool_search/,
    'a deferred placeholder must say its real definition arrives later');
  assert.equal(toolDeclFlags({ name: 'plain', description: 'x' }), '',
    'a plain declaration adds no flag row at all');
  assert.equal(toolDeclFlags(undefined), '');
  // custom 工具的 grammar 是机器输入格式；阅读页只保留 syntax 名称，定义本体去日志页看。
  assert.doesNotMatch(viewerScript, /tool\.format\.definition/,
    'a freeform tool must not dump its raw grammar definition into Read mode');
  completed.push('Claude and ChatGPT share one system pill and one sub-agent badge');
}
