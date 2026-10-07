import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { XwXDeckController } from '../src/main/app/xwxDeckController';
import { XwXDeckSettingsStore } from '../src/main/app/settings';
import { GatewayProcessClient } from '../src/main/trace/gatewayProcessClient';
import {
  GATEWAY_HELPER_BUILD_ID,
  GATEWAY_HELPER_PROTOCOL_VERSION
} from '../src/main/trace/gatewayProtocol';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xwx-gateway-upgrade-'));
const userData = path.join(root, 'user-data');
const traceRoot = path.join(root, 'trace');
const controlDir = path.join(userData, 'gateway');
const stateFile = path.join(root, 'legacy-state.json');
const token = 'legacy-control-token';
let upstream: http.Server | undefined;
let legacy: ReturnType<typeof spawn> | undefined;
let client: GatewayProcessClient | undefined;

try {
  await fs.mkdir(controlDir, { recursive: true });
  await fs.mkdir(traceRoot, { recursive: true });
  await fs.writeFile(path.join(controlDir, 'control.token'), `${token}\n`, 'utf8');
  await writeLegacyState(1, 0);

  upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, model: body.model, upgraded: true }));
  });
  const upstreamPort = await listen(upstream);

  legacy = spawn(process.execPath, ['-e', legacyHelperSource()], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      XwX_LEGACY_CONTROL_DIR: controlDir,
      XwX_LEGACY_TRACE_ROOT: traceRoot,
      XwX_LEGACY_STATE_FILE: stateFile,
      XwX_LEGACY_TOKEN: token,
      XwX_LEGACY_SUPPORTS_ABANDON: '1'
    },
    stdio: 'ignore'
  });
  await waitForRuntime(path.join(controlDir, 'runtime.json'));
  const original = await readRuntime();
  assert.equal(original.helperProtocolVersion, undefined, 'fixture must model a pre-handshake helper');

  let chatGptRunning = true;
  client = new GatewayProcessClient(userData, traceRoot, [0], async () => !chatGptRunning);
  client.setClientRoutes([{
    source: 'codex-cli',
    path: '/v1/responses',
    apiType: 'responses',
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    capture: false
  }]);
  client.setRecordingEnabled(true);
  assert.equal(await client.start(), `http://127.0.0.1:${original.gatewayPort}`);
  assert.equal(await client.adoptCodexProviderOnStartup('compatible'), false,
    'a legacy helper without portability endpoints must defer adoption instead of failing manager startup');
  await client.synchronize();
  await delay(1_200);
  assert.equal((await readRuntime()).pid, original.pid,
    'an active request must keep the legacy data plane alive');

  await writeLegacyState(0, 1);
  await delay(1_300);
  assert.equal((await readRuntime()).pid, original.pid,
    'a pending tool-call continuation must keep the legacy data plane alive');

  chatGptRunning = false;
  // Join the deferred upgrade operation instead of merely observing its
  // runtime file; the test must not stop the replacement helper while the
  // manager is still completing attach/configure.
  await delay(1_100);
  await client.synchronize();
  const upgraded = await waitForProtocol(GATEWAY_HELPER_PROTOCOL_VERSION);
  assert.notEqual(upgraded.pid, original.pid, 'the idle legacy helper must be replaced');
  assert.equal(upgraded.gatewayPort, original.gatewayPort,
    'the replacement must reclaim the cached local endpoint before clients resume');
  const status = await waitForConfiguredStatus(upgraded.controlPort);
  assert.equal(status.helperProtocolVersion, GATEWAY_HELPER_PROTOCOL_VERSION);
  assert.equal(status.helperBuildId, GATEWAY_HELPER_BUILD_ID);
  assert.ok(status.generation >= 2, 'the manager must republish its complete route generation');
  assert.equal(status.recording, true, 'recording state must survive helper replacement');
  assert.equal(
    JSON.parse(await fs.readFile(path.join(userData, 'codex-portability', 'opaque-origins.json'), 'utf8')).version,
    3,
    'the replacement helper must complete the deferred portability adoption'
  );

  const response = await request(upgraded.gatewayPort, '/v1/responses', {
    model: 'xwx-upgrade-smoke', input: []
  }, 'POST', { 'user-agent': 'codex-tui/upgrade-smoke', originator: 'codex-tui' });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(JSON.parse(response.text), { ok: true, model: 'xwx-upgrade-smoke', upgraded: true });

  console.log('PASS legacy helper stays alive for active/continuation work, upgrades when idle, reclaims its endpoint and republishes routes');
} finally {
  if (client) await client.stop().catch(() => undefined);
  if (legacy && legacy.exitCode === null) legacy.kill('SIGTERM');
  if (upstream) await new Promise<void>(resolve => upstream!.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true });
}

await testLegacyHelperWithoutAbandonEndpoint();
await testV5HelperUpgrade();
await testSameProtocolOlderBuildUpgrade();
await testUpgradeRetryKeepsOriginalPort();
await testStopWinsUpgradeReplacementRace();
await testForceStopKillsUnresponsiveHelper();
await testControlRecoveryPreservesLiveDataPlane();
await testControllerStartupAcrossLegacyPortabilityGap();

async function testLegacyHelperWithoutAbandonEndpoint(): Promise<void> {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xwx-gateway-upgrade-no-abandon-'));
  const testUserData = path.join(testRoot, 'user-data');
  const testTraceRoot = path.join(testRoot, 'trace');
  const testControlDir = path.join(testUserData, 'gateway');
  const testStateFile = path.join(testRoot, 'legacy-state.json');
  const testToken = 'legacy-no-abandon-token';
  let testLegacy: ReturnType<typeof spawn> | undefined;
  let testClient: GatewayProcessClient | undefined;
  try {
    await fs.mkdir(testControlDir, { recursive: true });
    await fs.mkdir(testTraceRoot, { recursive: true });
    await fs.writeFile(path.join(testControlDir, 'control.token'), `${testToken}\n`, 'utf8');
    await fs.writeFile(testStateFile, JSON.stringify({ activeRequests: 0, pendingContinuations: 1 }), 'utf8');
    testLegacy = spawn(process.execPath, ['-e', legacyHelperSource()], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        XwX_LEGACY_CONTROL_DIR: testControlDir,
        XwX_LEGACY_TRACE_ROOT: testTraceRoot,
        XwX_LEGACY_STATE_FILE: testStateFile,
        XwX_LEGACY_TOKEN: testToken,
        XwX_LEGACY_SUPPORTS_ABANDON: '0'
      },
      stdio: 'ignore'
    });
    const runtimeFile = path.join(testControlDir, 'runtime.json');
    await waitForRuntime(runtimeFile);
    const original = JSON.parse(await fs.readFile(runtimeFile, 'utf8')) as { pid: number };
    testClient = new GatewayProcessClient(testUserData, testTraceRoot, [0], async () => true);
    await testClient.start();
    await testClient.synchronize();
    const after = JSON.parse(await fs.readFile(runtimeFile, 'utf8')) as { pid: number; helperProtocolVersion?: number };
    assert.equal(after.pid, original.pid,
      'a helper without abandon-continuations must remain serving instead of being killed from an ungated snapshot');
    assert.equal(after.helperProtocolVersion, undefined);
    console.log('PASS legacy helper without abandon endpoint does not fail manager synchronization or interrupt its data plane');
  } finally {
    if (testClient) await testClient.stop().catch(() => undefined);
    if (testLegacy && testLegacy.exitCode === null) testLegacy.kill('SIGTERM');
    await fs.rm(testRoot, { recursive: true, force: true });
  }
}

async function testV5HelperUpgrade(): Promise<void> {
  assert.equal(GATEWAY_HELPER_PROTOCOL_VERSION, 14,
    'this regression verifies replacement of the v5 helper missing current routing and portability behavior');
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xwx-gateway-upgrade-v5-'));
  const testUserData = path.join(testRoot, 'user-data');
  const testTraceRoot = path.join(testRoot, 'trace');
  const testControlDir = path.join(testUserData, 'gateway');
  const testStateFile = path.join(testRoot, 'legacy-state.json');
  const testToken = 'legacy-v5-token';
  let testLegacy: ReturnType<typeof spawn> | undefined;
  let testClient: GatewayProcessClient | undefined;
  try {
    await fs.mkdir(testControlDir, { recursive: true });
    await fs.mkdir(testTraceRoot, { recursive: true });
    await fs.writeFile(path.join(testControlDir, 'control.token'), `${testToken}\n`, 'utf8');
    await fs.writeFile(testStateFile, JSON.stringify({ activeRequests: 0, pendingContinuations: 0 }), 'utf8');
    testLegacy = spawn(process.execPath, ['-e', legacyHelperSource()], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        XwX_LEGACY_CONTROL_DIR: testControlDir,
        XwX_LEGACY_TRACE_ROOT: testTraceRoot,
        XwX_LEGACY_STATE_FILE: testStateFile,
        XwX_LEGACY_TOKEN: testToken,
        XwX_LEGACY_SUPPORTS_ABANDON: '1',
        XwX_LEGACY_PROTOCOL_VERSION: '5'
      },
      stdio: 'ignore'
    });
    const runtimeFile = path.join(testControlDir, 'runtime.json');
    await waitForRuntime(runtimeFile);
    const original = JSON.parse(await fs.readFile(runtimeFile, 'utf8')) as {
      pid: number; gatewayPort: number; helperProtocolVersion?: number;
    };
    assert.equal(original.helperProtocolVersion, 5);
    testClient = new GatewayProcessClient(testUserData, testTraceRoot, [0], async () => false);
    assert.equal(await testClient.start(), `http://127.0.0.1:${original.gatewayPort}`);
    await testClient.synchronize();
    const upgraded = await waitForProtocol(GATEWAY_HELPER_PROTOCOL_VERSION, testControlDir);
    assert.notEqual(upgraded.pid, original.pid);
    assert.equal(upgraded.gatewayPort, original.gatewayPort,
      'the current helper must reclaim the v5 endpoint cached by the running client');
    console.log(`PASS idle v5 Gateway helper upgrades to v${GATEWAY_HELPER_PROTOCOL_VERSION} and reclaims the cached endpoint`);
  } finally {
    if (testClient) await testClient.stop().catch(() => undefined);
    if (testLegacy && testLegacy.exitCode === null) testLegacy.kill('SIGTERM');
    await fs.rm(testRoot, { recursive: true, force: true });
  }
}

async function testSameProtocolOlderBuildUpgrade(): Promise<void> {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xwx-gateway-upgrade-build-id-'));
  const testUserData = path.join(testRoot, 'user-data');
  const testTraceRoot = path.join(testRoot, 'trace');
  const testControlDir = path.join(testUserData, 'gateway');
  const testStateFile = path.join(testRoot, 'legacy-state.json');
  const testToken = 'legacy-build-id-token';
  let testLegacy: ReturnType<typeof spawn> | undefined;
  let testClient: GatewayProcessClient | undefined;
  try {
    await fs.mkdir(testControlDir, { recursive: true });
    await fs.mkdir(testTraceRoot, { recursive: true });
    await fs.writeFile(path.join(testControlDir, 'control.token'), `${testToken}\n`, 'utf8');
    await fs.writeFile(testStateFile, JSON.stringify({ activeRequests: 1, pendingContinuations: 0 }), 'utf8');
    testLegacy = spawn(process.execPath, ['-e', legacyHelperSource()], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        XwX_LEGACY_CONTROL_DIR: testControlDir,
        XwX_LEGACY_TRACE_ROOT: testTraceRoot,
        XwX_LEGACY_STATE_FILE: testStateFile,
        XwX_LEGACY_TOKEN: testToken,
        XwX_LEGACY_SUPPORTS_ABANDON: '1',
        XwX_LEGACY_PROTOCOL_VERSION: String(GATEWAY_HELPER_PROTOCOL_VERSION),
        XwX_LEGACY_BUILD_ID: '0'.repeat(64)
      },
      stdio: 'ignore'
    });
    const runtimeFile = path.join(testControlDir, 'runtime.json');
    await waitForRuntime(runtimeFile);
    const original = JSON.parse(await fs.readFile(runtimeFile, 'utf8')) as {
      pid: number;
      gatewayPort: number;
      helperProtocolVersion?: number;
      helperBuildId?: string;
    };
    assert.equal(original.helperProtocolVersion, GATEWAY_HELPER_PROTOCOL_VERSION);
    assert.equal(original.helperBuildId, '0'.repeat(64));
    testClient = new GatewayProcessClient(testUserData, testTraceRoot, [0], async () => false);
    assert.equal(await testClient.start(), `http://127.0.0.1:${original.gatewayPort}`);
    await testClient.synchronize();
    await delay(1_200);
    assert.equal(
      (JSON.parse(await fs.readFile(runtimeFile, 'utf8')) as { pid: number }).pid,
      original.pid,
      'an active request must keep the same-protocol old-build helper alive'
    );
    await fs.writeFile(testStateFile, JSON.stringify({ activeRequests: 0, pendingContinuations: 0 }), 'utf8');
    await testClient.synchronize();
    const upgraded = await waitForHelperIdentity(
      GATEWAY_HELPER_PROTOCOL_VERSION,
      GATEWAY_HELPER_BUILD_ID,
      testControlDir
    );
    assert.notEqual(upgraded.pid, original.pid,
      'a helper from another build must be replaced even when its protocol version matches');
    assert.equal(upgraded.gatewayPort, original.gatewayPort);
    console.log('PASS same-protocol helper from an older build is replaced on the original endpoint');
  } finally {
    if (testClient) await testClient.stop().catch(() => undefined);
    if (testLegacy && testLegacy.exitCode === null) testLegacy.kill('SIGTERM');
    await fs.rm(testRoot, { recursive: true, force: true });
  }
}

async function testUpgradeRetryKeepsOriginalPort(): Promise<void> {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xwx-gateway-upgrade-port-'));
  const testUserData = path.join(testRoot, 'user-data');
  const testTraceRoot = path.join(testRoot, 'trace');
  const testControlDir = path.join(testUserData, 'gateway');
  const testStateFile = path.join(testRoot, 'legacy-state.json');
  const testToken = 'legacy-port-token';
  let testLegacy: ReturnType<typeof spawn> | undefined;
  let testClient: GatewayProcessClient | undefined;
  let blocker: http.Server | undefined;
  try {
    await fs.mkdir(testControlDir, { recursive: true });
    await fs.mkdir(testTraceRoot, { recursive: true });
    await fs.writeFile(path.join(testControlDir, 'control.token'), `${testToken}\n`, 'utf8');
    await fs.writeFile(testStateFile, JSON.stringify({ activeRequests: 1, pendingContinuations: 0 }), 'utf8');
    testLegacy = spawn(process.execPath, ['-e', legacyHelperSource()], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        XwX_LEGACY_CONTROL_DIR: testControlDir,
        XwX_LEGACY_TRACE_ROOT: testTraceRoot,
        XwX_LEGACY_STATE_FILE: testStateFile,
        XwX_LEGACY_TOKEN: testToken,
        XwX_LEGACY_SUPPORTS_ABANDON: '1'
      },
      stdio: 'ignore'
    });
    const runtimeFile = path.join(testControlDir, 'runtime.json');
    await waitForRuntime(runtimeFile);
    const original = JSON.parse(await fs.readFile(runtimeFile, 'utf8')) as {
      pid: number; gatewayPort: number; controlPort: number;
    };
    testClient = new GatewayProcessClient(testUserData, testTraceRoot, [0], async () => false);
    assert.equal(await testClient.start(), `http://127.0.0.1:${original.gatewayPort}`);

    await control(original.controlPort, testToken, '/control/stop', {});
    await waitForChildExit(testLegacy);
    blocker = http.createServer((_req, res) => { res.writeHead(503); res.end('occupied'); });
    await listenAt(blocker, original.gatewayPort);

    await assert.rejects(
      testClient.start(),
      error => /提前退出|启动超时/.test((error as Error).message),
      'a retry must fail while the original endpoint is occupied instead of silently choosing another port'
    );
    await assert.rejects(fs.stat(runtimeFile), /ENOENT/);

    await closeServer(blocker);
    blocker = undefined;
    assert.equal(await testClient.start(), `http://127.0.0.1:${original.gatewayPort}`,
      'the next retry must reclaim the original client-visible endpoint');
    await testClient.synchronize();
    const replacement = JSON.parse(await fs.readFile(runtimeFile, 'utf8')) as {
      gatewayPort: number; helperProtocolVersion?: number;
    };
    assert.equal(replacement.gatewayPort, original.gatewayPort);
    assert.equal(replacement.helperProtocolVersion, GATEWAY_HELPER_PROTOCOL_VERSION);
    console.log('PASS failed helper replacement keeps the original endpoint requirement across retries');
  } finally {
    if (blocker) await closeServer(blocker).catch(() => undefined);
    if (testClient) await testClient.stop().catch(() => undefined);
    if (testLegacy && testLegacy.exitCode === null) testLegacy.kill('SIGTERM');
    await fs.rm(testRoot, { recursive: true, force: true });
  }
}

async function testStopWinsUpgradeReplacementRace(): Promise<void> {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xwx-gateway-upgrade-stop-race-'));
  const testUserData = path.join(testRoot, 'user-data');
  const testTraceRoot = path.join(testRoot, 'trace');
  const testControlDir = path.join(testUserData, 'gateway');
  const testStateFile = path.join(testRoot, 'legacy-state.json');
  const testToken = 'legacy-stop-race-token';
  let testLegacy: ReturnType<typeof spawn> | undefined;
  let testClient: GatewayProcessClient | undefined;
  let releaseReplacement!: () => void;
  let reachedReplacement!: () => void;
  const replacementGate = new Promise<void>(resolve => { releaseReplacement = resolve; });
  const replacementReached = new Promise<void>(resolve => { reachedReplacement = resolve; });
  try {
    await fs.mkdir(testControlDir, { recursive: true });
    await fs.mkdir(testTraceRoot, { recursive: true });
    await fs.writeFile(path.join(testControlDir, 'control.token'), `${testToken}\n`, 'utf8');
    await fs.writeFile(testStateFile, JSON.stringify({ activeRequests: 0, pendingContinuations: 0 }), 'utf8');
    testLegacy = spawn(process.execPath, ['-e', legacyHelperSource()], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        XwX_LEGACY_CONTROL_DIR: testControlDir,
        XwX_LEGACY_TRACE_ROOT: testTraceRoot,
        XwX_LEGACY_STATE_FILE: testStateFile,
        XwX_LEGACY_TOKEN: testToken,
        XwX_LEGACY_SUPPORTS_ABANDON: '1'
      },
      stdio: 'ignore'
    });
    const runtimeFile = path.join(testControlDir, 'runtime.json');
    await waitForRuntime(runtimeFile);
    const original = JSON.parse(await fs.readFile(runtimeFile, 'utf8')) as { gatewayPort: number };
    testClient = new GatewayProcessClient(
      testUserData,
      testTraceRoot,
      [0],
      async () => false,
      {
        beforeUpgradeReplacement: async () => {
          reachedReplacement();
          await replacementGate;
        }
      }
    );
    await testClient.start();
    const upgrading = testClient.synchronize();
    await replacementReached;
    const stopping = testClient.stop();
    releaseReplacement();
    await Promise.all([upgrading, stopping]);
    await waitForPortClosed(original.gatewayPort);
    await delay(1_200);
    await assert.rejects(fs.stat(runtimeFile), /ENOENT/,
      'a stopped upgrade must not publish a replacement runtime later');
    assert.equal(await tcpPortOpen(original.gatewayPort), false,
      'a stopped upgrade must not resurrect the client-visible Gateway port');
    console.log('PASS explicit stop wins the helper replacement race and the Gateway stays stopped');
  } finally {
    releaseReplacement();
    if (testClient) await testClient.stop().catch(() => undefined);
    if (testLegacy && testLegacy.exitCode === null) testLegacy.kill('SIGTERM');
    await fs.rm(testRoot, { recursive: true, force: true });
  }
}

async function testForceStopKillsUnresponsiveHelper(): Promise<void> {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xwx-gateway-force-stop-'));
  const testUserData = path.join(testRoot, 'user-data');
  const testTraceRoot = path.join(testRoot, 'trace');
  const testControlDir = path.join(testUserData, 'gateway');
  const testStateFile = path.join(testRoot, 'legacy-state.json');
  const testToken = 'force-stop-token';
  let testLegacy: ReturnType<typeof spawn> | undefined;
  let testClient: GatewayProcessClient | undefined;
  try {
    await fs.mkdir(testControlDir, { recursive: true });
    await fs.mkdir(testTraceRoot, { recursive: true });
    await fs.writeFile(path.join(testControlDir, 'control.token'), `${testToken}\n`, 'utf8');
    await fs.writeFile(testStateFile, JSON.stringify({ activeRequests: 0, pendingContinuations: 0 }), 'utf8');
    testLegacy = spawn(process.execPath, ['-e', legacyHelperSource()], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        XwX_LEGACY_CONTROL_DIR: testControlDir,
        XwX_LEGACY_TRACE_ROOT: testTraceRoot,
        XwX_LEGACY_STATE_FILE: testStateFile,
        XwX_LEGACY_TOKEN: testToken,
        XwX_LEGACY_SUPPORTS_ABANDON: '1',
        XwX_LEGACY_STOP_HANG: '1'
      },
      stdio: 'ignore'
    });
    const runtimeFile = path.join(testControlDir, 'runtime.json');
    await waitForRuntime(runtimeFile);
    const runtime = JSON.parse(await fs.readFile(runtimeFile, 'utf8')) as { pid: number; gatewayPort: number };
    testClient = new GatewayProcessClient(testUserData, testTraceRoot, [0], async () => false);
    await testClient.start();
    await testClient.forceStop();
    await waitForPortClosed(runtime.gatewayPort);
    assert.equal(processAliveForTest(runtime.pid), false, 'forceStop must kill an unresponsive helper');
    await assert.rejects(fs.stat(runtimeFile), /ENOENT/);
    console.log('PASS forced exit kills an unresponsive helper and removes stale runtime state');
  } finally {
    if (testClient) await testClient.forceStop().catch(() => undefined);
    if (testLegacy && testLegacy.exitCode === null) testLegacy.kill('SIGKILL');
    await fs.rm(testRoot, { recursive: true, force: true });
  }
}

async function testControlRecoveryPreservesLiveDataPlane(): Promise<void> {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xwx-gateway-control-recovery-'));
  const testUserData = path.join(testRoot, 'user-data');
  const testTraceRoot = path.join(testRoot, 'trace');
  const testControlDir = path.join(testUserData, 'gateway');
  const testStateFile = path.join(testRoot, 'legacy-state.json');
  const testToken = 'control-recovery-token';
  let testLegacy: ReturnType<typeof spawn> | undefined;
  let testClient: GatewayProcessClient | undefined;
  try {
    await fs.mkdir(testControlDir, { recursive: true });
    await fs.mkdir(testTraceRoot, { recursive: true });
    await fs.writeFile(path.join(testControlDir, 'control.token'), `${testToken}\n`, 'utf8');
    await fs.writeFile(testStateFile, JSON.stringify({
      activeRequests: 0,
      pendingContinuations: 0,
      statusFailures: 1
    }), 'utf8');
    testLegacy = spawn(process.execPath, ['-e', legacyHelperSource()], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        XwX_LEGACY_CONTROL_DIR: testControlDir,
        XwX_LEGACY_TRACE_ROOT: testTraceRoot,
        XwX_LEGACY_STATE_FILE: testStateFile,
        XwX_LEGACY_TOKEN: testToken,
        XwX_LEGACY_SUPPORTS_ABANDON: '1',
        XwX_LEGACY_PROTOCOL_VERSION: String(GATEWAY_HELPER_PROTOCOL_VERSION)
      },
      stdio: 'ignore'
    });
    const runtimeFile = path.join(testControlDir, 'runtime.json');
    await waitForRuntime(runtimeFile);
    const original = JSON.parse(await fs.readFile(runtimeFile, 'utf8')) as {
      pid: number;
      gatewayPort: number;
      controlPort: number;
    };
    testClient = new GatewayProcessClient(testUserData, testTraceRoot, [0], async () => false);
    assert.equal(await testClient.start(), `http://127.0.0.1:${original.gatewayPort}`,
      'one reset GET must be retried without replacing the helper');
    assert.equal(
      (JSON.parse(await fs.readFile(runtimeFile, 'utf8')) as { pid: number }).pid,
      original.pid
    );

    await fs.writeFile(testStateFile, JSON.stringify({
      activeRequests: 0,
      pendingContinuations: 0,
      statusFailures: 20
    }), 'utf8');
    await assert.rejects(
      testClient.start(),
      /控制通道暂时不可用/,
      'persistent status failure with a live data plane must stay uncertain'
    );
    assert.equal(
      (JSON.parse(await fs.readFile(runtimeFile, 'utf8')) as { pid: number }).pid,
      original.pid,
      'an uncertain control plane must not spawn a second helper'
    );
    assert.equal(await tcpPortOpen(original.gatewayPort), true,
      'the original data plane must remain available during control uncertainty');

    await fs.writeFile(testStateFile, JSON.stringify({
      activeRequests: 0,
      pendingContinuations: 0,
      statusFailures: 0
    }), 'utf8');
    await fs.writeFile(path.join(testControlDir, 'control.token'), 'wrong-token\n', 'utf8');
    await assert.rejects(
      testClient.start(),
      /控制通道暂时不可用/,
      'a token mismatch with a live helper must not overwrite runtime or token'
    );
    assert.equal((await fs.readFile(path.join(testControlDir, 'control.token'), 'utf8')).trim(), 'wrong-token');
    assert.equal(
      (JSON.parse(await fs.readFile(runtimeFile, 'utf8')) as { pid: number }).pid,
      original.pid
    );
    await fs.writeFile(path.join(testControlDir, 'control.token'), `${testToken}\n`, 'utf8');
    assert.equal(await testClient.start(), `http://127.0.0.1:${original.gatewayPort}`);

    testLegacy.kill('SIGKILL');
    await waitForChildExit(testLegacy);
    testLegacy = undefined;
    await waitForPortClosed(original.gatewayPort);
    assert.equal(await testClient.start(), `http://127.0.0.1:${original.gatewayPort}`,
      'a confirmed-dead helper must be replaced on the original client-visible port');
    const replacement = JSON.parse(await fs.readFile(runtimeFile, 'utf8')) as {
      pid: number;
      gatewayPort: number;
      helperProtocolVersion?: number;
    };
    assert.notEqual(replacement.pid, original.pid);
    assert.equal(replacement.gatewayPort, original.gatewayPort);
    assert.equal(replacement.helperProtocolVersion, GATEWAY_HELPER_PROTOCOL_VERSION);
    console.log('PASS Gateway control recovery retries GET, preserves uncertain helpers and reclaims confirmed-dead endpoints');
  } finally {
    if (testClient) await testClient.stop().catch(() => undefined);
    if (testLegacy && testLegacy.exitCode === null) testLegacy.kill('SIGKILL');
    await fs.rm(testRoot, { recursive: true, force: true });
  }
}

async function testControllerStartupAcrossLegacyPortabilityGap(): Promise<void> {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xwx-controller-legacy-portability-'));
  const testUserData = path.join(testRoot, 'user-data');
  const testTraceRoot = path.join(testUserData, 'xwx-trace');
  const testControlDir = path.join(testUserData, 'gateway');
  const testStateFile = path.join(testRoot, 'legacy-state.json');
  const testCodexHome = path.join(testRoot, '.codex');
  const testClaudeHome = path.join(testRoot, '.claude');
  const testToken = 'legacy-controller-startup-token';
  const previous = {
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    XWX_DECK_CLIENT_HOME: process.env.XWX_DECK_CLIENT_HOME,
    XWX_DECK_SMOKE_IGNORE_EXTERNAL: process.env.XWX_DECK_SMOKE_IGNORE_EXTERNAL
  };
  let testLegacy: ReturnType<typeof spawn> | undefined;
  let testController: XwXDeckController | undefined;
  try {
    process.env.CODEX_HOME = testCodexHome;
    process.env.CLAUDE_CONFIG_DIR = testClaudeHome;
    process.env.XWX_DECK_CLIENT_HOME = testRoot;
    process.env.XWX_DECK_SMOKE_IGNORE_EXTERNAL = '1';
    await fs.mkdir(testControlDir, { recursive: true });
    await fs.mkdir(testTraceRoot, { recursive: true });
    await fs.mkdir(testCodexHome, { recursive: true });
    await fs.mkdir(testClaudeHome, { recursive: true });
    await fs.writeFile(path.join(testControlDir, 'control.token'), `${testToken}\n`, 'utf8');
    await fs.writeFile(testStateFile, JSON.stringify({ activeRequests: 0, pendingContinuations: 0 }), 'utf8');
    await fs.writeFile(path.join(testCodexHome, 'auth.json'),
      '{"auth_mode":"chatgpt","tokens":{"access_token":"legacy-startup-oauth"}}\n', 'utf8');
    await fs.writeFile(path.join(testClaudeHome, 'settings.json'), '{}\n', 'utf8');
    testLegacy = spawn(process.execPath, ['-e', legacyHelperSource()], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        XwX_LEGACY_CONTROL_DIR: testControlDir,
        XwX_LEGACY_TRACE_ROOT: testTraceRoot,
        XwX_LEGACY_STATE_FILE: testStateFile,
        XwX_LEGACY_TOKEN: testToken,
        XwX_LEGACY_SUPPORTS_ABANDON: '1'
      },
      stdio: 'ignore'
    });
    const runtimeFile = path.join(testControlDir, 'runtime.json');
    await waitForRuntime(runtimeFile);
    const original = JSON.parse(await fs.readFile(runtimeFile, 'utf8')) as { gatewayPort: number; pid: number };
    await fs.writeFile(path.join(testCodexHome, 'config.toml'), [
      'model_provider = "xwx_deck"',
      'model = "deepseek-chat"',
      '',
      '[model_providers.xwx_deck]',
      'name = "XwX Deck"',
      `base_url = "http://127.0.0.1:${original.gatewayPort}/backend-api/codex"`,
      'wire_api = "responses"',
      'requires_openai_auth = true',
      ''
    ].join('\n'), 'utf8');
    await new XwXDeckSettingsStore(testUserData).update({
      tracingEnabled: true,
      clientEnabled: { claude: false, codex: true },
      compatible: {
        baseUrl: 'https://compatible.example/v1',
        bearerToken: 'legacy-startup-compatible-key',
        codexApiFormat: 'responses'
      }
    });
    testController = new XwXDeckController(testUserData, {
      backgroundGateway: true,
      proxyListenPorts: [0],
      disableBackgroundModelRefresh: true
    });
    await testController.start();
    const state = await testController.runtimeState();
    assert.equal(state.readiness.codexGatewayEnabled, true,
      'controller startup must survive a legacy helper portability 404 and restore the Codex Gateway');
    assert.equal(state.readiness.codexRouteReady, true);
    assert.equal(state.readiness.codexConfigReady, true);
    const replacement = await waitForProtocol(GATEWAY_HELPER_PROTOCOL_VERSION, testControlDir) as {
      helperProtocolVersion?: number; gatewayPort: number; pid: number;
    };
    assert.equal(replacement.helperProtocolVersion, GATEWAY_HELPER_PROTOCOL_VERSION);
    assert.equal(replacement.gatewayPort, original.gatewayPort,
      'controller startup upgrade must reclaim the already configured Gateway endpoint');
    assert.notEqual(replacement.pid, original.pid);
    await testController.shutdown();
    testController = undefined;
    console.log('PASS controller startup crosses a legacy portability 404, upgrades in place and restores routes');
  } finally {
    if (testController) await testController.shutdown().catch(() => undefined);
    if (testLegacy && testLegacy.exitCode === null) testLegacy.kill('SIGTERM');
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(testRoot, { recursive: true, force: true });
  }
}

async function writeLegacyState(activeRequests: number, pendingContinuations: number): Promise<void> {
  await fs.writeFile(stateFile, JSON.stringify({ activeRequests, pendingContinuations }), 'utf8');
}

async function readRuntime(): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(controlDir, 'runtime.json'), 'utf8'));
}

async function readToken(): Promise<string> {
  return (await fs.readFile(path.join(controlDir, 'control.token'), 'utf8')).trim();
}

async function waitForRuntime(file: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { JSON.parse(await fs.readFile(file, 'utf8')); return; } catch { await delay(50); }
  }
  throw new Error('legacy helper did not publish runtime');
}

async function waitForProtocol(protocol: number, runtimeControlDir = controlDir): Promise<any> {
  const deadline = Date.now() + 15_000;
  let lastSeen = 'runtime missing';
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(path.join(runtimeControlDir, 'runtime.json'), 'utf8');
      lastSeen = raw;
      const runtime = JSON.parse(raw);
      if (runtime.helperProtocolVersion === protocol) return runtime;
    } catch (error) { lastSeen = (error as Error).message; }
    await delay(100);
  }
  throw new Error(`legacy helper was not upgraded after becoming idle (${runtimeControlDir}): ${lastSeen}`);
}

async function waitForHelperIdentity(
  protocol: number,
  buildId: string,
  runtimeControlDir = controlDir
): Promise<any> {
  const deadline = Date.now() + 15_000;
  let lastSeen = 'runtime missing';
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(path.join(runtimeControlDir, 'runtime.json'), 'utf8');
      lastSeen = raw;
      const runtime = JSON.parse(raw);
      if (runtime.helperProtocolVersion === protocol && runtime.helperBuildId === buildId) return runtime;
    } catch (error) { lastSeen = (error as Error).message; }
    await delay(100);
  }
  throw new Error(`helper identity was not upgraded (${runtimeControlDir}): ${lastSeen}`);
}

async function waitForConfiguredStatus(controlPort: number): Promise<any> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = await control(controlPort, await readToken(), '/control/status', undefined, 'GET');
    if (status.generation >= 2 && status.recording === true) return status;
    await delay(50);
  }
  throw new Error('replacement helper did not publish the manager route generation');
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('upstream has no port'));
      else resolve(address.port);
    });
  });
}

function listenAt(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

function waitForChildExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('legacy helper did not exit')), 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForPortClosed(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!await tcpPortOpen(port)) return;
    await delay(50);
  }
  throw new Error(`Gateway port ${port} remained open after stop`);
}

function tcpPortOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/xwx-trace/ping', timeout: 250 }, res => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function control(port: number, tokenValue: string, pathname: string, body?: unknown, method = 'POST'): Promise<any> {
  const result = await request(port, pathname, body, method, { authorization: `Bearer ${tokenValue}` });
  if (result.status >= 400) throw new Error(`${pathname} returned ${result.status}: ${result.text}`);
  return result.text ? JSON.parse(result.text) : {};
}

function request(
  port: number,
  pathname: string,
  body: unknown,
  method: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; text: string }> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, timeout: 5_000,
      headers: {
        ...headers,
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {})
      }
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`request timed out: ${pathname}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function legacyHelperSource(): string {
  return String.raw`
    const fs = require('node:fs');
    const http = require('node:http');
    const path = require('node:path');
    const dir = process.env.XwX_LEGACY_CONTROL_DIR;
    const traceRoot = process.env.XwX_LEGACY_TRACE_ROOT;
    const stateFile = process.env.XwX_LEGACY_STATE_FILE;
    const token = process.env.XwX_LEGACY_TOKEN;
    const supportsAbandon = process.env.XwX_LEGACY_SUPPORTS_ABANDON === '1';
    const stopHangs = process.env.XwX_LEGACY_STOP_HANG === '1';
    const helperProtocolVersion = Number(process.env.XwX_LEGACY_PROTOCOL_VERSION);
    const helperBuildId = process.env.XwX_LEGACY_BUILD_ID || '';
    let generation = 4;
    let recording = false;
    const gateway = http.createServer((req, res) => {
      if (req.url === '/xwx-trace/ping') {
        res.writeHead(200, { 'x-xwx-trace': '1' }); res.end('ok'); return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
    });
    gateway.listen(0, '127.0.0.1', () => {
      const gatewayPort = gateway.address().port;
      const control = http.createServer((req, res) => {
        if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); res.end('{}'); return; }
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
           const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
           const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
           if (req.url === '/control/status' && Number(state.statusFailures) > 0) {
             state.statusFailures -= 1;
             fs.writeFileSync(stateFile, JSON.stringify(state));
             req.socket.destroy();
             return;
           }
           const status = {
             gatewayPort, activeRequests: state.activeRequests, pendingContinuations: state.pendingContinuations,
             recording, generation,
             ...(Number.isSafeInteger(helperProtocolVersion) ? { helperProtocolVersion } : {}),
             ...(helperBuildId ? { helperBuildId } : {})
          };
          if (req.url === '/control/status') { res.end(JSON.stringify(status)); return; }
          if (req.url === '/control/configure') {
            if (body.generation >= generation) generation = body.generation;
            recording = body.recording === true;
            res.end(JSON.stringify({ ...status, generation, recording })); return;
          }
          if (req.url === '/control/prepare-shutdown') {
            res.end(JSON.stringify({ prepared: state.activeRequests === 0 && state.pendingContinuations === 0, status })); return;
          }
          if (supportsAbandon && req.url === '/control/abandon-continuations') {
            const cleared = { activeRequests: state.activeRequests, pendingContinuations: 0 };
            fs.writeFileSync(stateFile, JSON.stringify(cleared));
            res.end(JSON.stringify({ ...status, pendingContinuations: 0 })); return;
          }
          if (req.url === '/control/stop') {
            if (stopHangs) return;
            res.end('{}');
            setImmediate(() => control.close(() => gateway.close(() => {
              try { fs.rmSync(path.join(dir, 'runtime.json')); } catch {}
              process.exit(0);
            })));
            return;
          }
          res.writeHead(404); res.end('{}');
        });
      });
      control.listen(0, '127.0.0.1', () => {
        fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({
           version: 1, pid: process.pid, gatewayPort, controlPort: control.address().port,
           traceRoot, startedAt: new Date().toISOString(),
           ...(Number.isSafeInteger(helperProtocolVersion) ? { helperProtocolVersion } : {}),
           ...(helperBuildId ? { helperBuildId } : {})
        }));
      });
    });
  `;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function processAliveForTest(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
