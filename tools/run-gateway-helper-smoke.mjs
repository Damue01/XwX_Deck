import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const temp = await mkdtemp(path.join(os.tmpdir(), 'xwx-gateway-smoke-'));
const userData = path.join(temp, 'user-data');
const traceRoot = path.join(temp, 'trace');
const controlDir = path.join(userData, 'gateway');
const token = randomBytes(32).toString('hex');
let upstream;
let forwardProxy;
let runtime;
let forwardProxyHits = 0;
let releaseForcedResponse;
let markForcedRequestReached;
const forcedRequestReached = new Promise(resolve => { markForcedRequestReached = resolve; });
const forcedResponseReleased = new Promise(resolve => { releaseForcedResponse = resolve; });

try {
  await mkdir(controlDir, { recursive: true });
  await mkdir(traceRoot, { recursive: true });
  await writeFile(path.join(controlDir, 'control.token'), `${token}\n`, { mode: 0o600 });
  await seedTraceHistory(traceRoot);

  upstream = http.createServer(async (req, res) => {
    const body = await readRequest(req);
    if (body.input === 'force-abort') {
      markForcedRequestReached?.();
      await forcedResponseReleased;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, model: body.model, parentExited: true }));
  });
  const upstreamPort = await listen(upstream);
  forwardProxy = http.createServer((req, res) => {
    forwardProxyHits += 1;
    const target = new URL(req.url);
    const forwarded = http.request(target, {
      method: req.method,
      headers: { ...req.headers, host: target.host }
    }, upstreamResponse => {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    });
    forwarded.on('error', error => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(error.message);
    });
    req.pipe(forwarded);
  });
  const forwardProxyPort = await listen(forwardProxy);

  // The short-lived launcher exits immediately after unref. The helper must
  // remain alive and own the data plane independently of that launcher.
  const launcher = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, [${JSON.stringify(path.join(root, 'dist', 'gateway-helper.js'))}], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env,
        XwX_GATEWAY_USER_DATA: ${JSON.stringify(userData)},
        XwX_GATEWAY_TRACE_ROOT: ${JSON.stringify(traceRoot)},
        XwX_GATEWAY_LISTEN_PORTS: '0'
      }
    });
    child.unref();
  `], { stdio: 'ignore' });
  await exited(launcher);

  runtime = await waitForRuntime(path.join(controlDir, 'runtime.json'));
  assert.equal(runtime.helperProtocolVersion, 13);
  assert.ok(runtime.pid > 0);
  assert.ok(runtime.gatewayPort > 0);
  assert.ok(runtime.controlPort > 0);
  const writerLeasePath = path.join(traceRoot, 'trace-writer.lock');
  const writerLease = JSON.parse(await readFile(writerLeasePath, 'utf8'));
  assert.equal(writerLease.pid, runtime.pid, 'the live helper must own the Trace writer lease');

  const contenderUserData = path.join(temp, 'contender-user-data');
  const contenderControlDir = path.join(contenderUserData, 'gateway');
  const contenderToken = randomBytes(32).toString('hex');
  await mkdir(contenderControlDir, { recursive: true });
  await writeFile(path.join(contenderControlDir, 'control.token'), `${contenderToken}\n`, { mode: 0o600 });
  const contender = spawn(process.execPath, [path.join(root, 'dist', 'gateway-helper.js')], {
    stdio: 'ignore',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      XwX_GATEWAY_USER_DATA: contenderUserData,
      XwX_GATEWAY_TRACE_ROOT: traceRoot,
      XwX_GATEWAY_LISTEN_PORTS: '0'
    }
  });
  assert.equal(await exitCode(contender), 1,
    'a second helper targeting the same Trace root must fail before it can write');
  await assert.rejects(readFile(path.join(contenderControlDir, 'runtime.json'), 'utf8'), /ENOENT/);
  assert.equal((await request(runtime.gatewayPort, '/xwx-trace/ping', undefined, 'GET')).status, 200,
    'rejecting the second writer must not disturb the existing data plane');

  const unauthorized = await request(runtime.controlPort, '/control/status', undefined, 'GET');
  assert.equal(unauthorized.status, 401, 'control plane must reject requests without its capability token');
  const initialStatus = await control(runtime.controlPort, token, '/control/status', undefined, 'GET');
  assert.deepEqual(initialStatus.traceRetention, { maxSessions: 0, maxStorageBytes: 0 },
    'a helper without an explicit retention policy must keep all Trace history');
  await delay(100);
  const initialState = await waitForGatewayState(runtime.gatewayPort, state => state.sessions?.length === 2);
  assert.equal(initialState.storage.maxBytes, undefined,
    'the default helper policy must not publish a storage budget');

  const route = {
    source: 'codex-cli',
    path: '/v1/responses',
    apiType: 'responses',
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    upstreamProxyUrl: `http://127.0.0.1:${forwardProxyPort}`,
    modelProtocols: {
      'gpt-xwx-smoke': 'responses',
      'codex-auto-review': 'responses'
    },
    capture: false
  };
  const configured = await control(runtime.controlPort, token, '/control/configure', {
    generation: 1,
    routes: [],
    clientRoutes: [route],
    recording: false,
    traceRetention: { maxSessions: 50, maxStorageBytes: 1024 }
  });
  assert.equal(configured.generation, 1);
  assert.deepEqual(configured.traceRetention, { maxSessions: 0, maxStorageBytes: 0 },
    'the helper must reject attempts to enable automatic Trace cleanup');
  assert.deepEqual(configured.capturedClients, []);
  const configuredState = await waitForGatewayState(runtime.gatewayPort, state => state.sessions?.length === 2);
  assert.equal(configuredState.storage.maxBytes, undefined,
    'unsupported retention settings must not publish a storage budget');
  assert.deepEqual(configuredState.pricingModelIds, ['codex-auto-review', 'gpt-xwx-smoke'],
    'the helper viewer must publish exact model IDs from the active route catalog');

  const first = await gateway(runtime.gatewayPort, { model: 'gpt-xwx-smoke', input: [] });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true, model: 'gpt-xwx-smoke', parentExited: true });
  assert.equal(forwardProxyHits, 1, 'serialized helper routes must forward through their configured system proxy');

  // Simulate a freshly opened manager attaching and reading status. It must not
  // overwrite the helper's live generation with empty constructor defaults.
  const attached = await control(runtime.controlPort, token, '/control/status', undefined, 'GET');
  assert.equal(attached.helperProtocolVersion, 13);
  assert.equal(attached.generation, 1);
  const afterAttach = await gateway(runtime.gatewayPort, { model: 'gpt-xwx-after-attach', input: [] });
  assert.equal(afterAttach.status, 200);
  assert.equal(afterAttach.body.model, 'gpt-xwx-after-attach');

  // An older control-plane generation cannot roll back a newer route table.
  const stale = await control(runtime.controlPort, token, '/control/configure', {
    generation: 0,
    routes: [],
    clientRoutes: [],
    recording: false
  });
  assert.equal(stale.generation, 1);
  assert.equal((await gateway(runtime.gatewayPort, { model: 'gpt-xwx-stale', input: [] })).status, 200);

  const captureRoute = { ...route, capture: true };
  const recording = await control(runtime.controlPort, token, '/control/configure', {
    generation: 2,
    routes: [],
    clientRoutes: [captureRoute],
    recording: true,
    traceRetention: { maxSessions: 1, maxStorageBytes: 0 }
  });
  assert.equal(recording.recording, true);
  assert.deepEqual(recording.traceRetention, { maxSessions: 0, maxStorageBytes: 0 });
  assert.deepEqual(recording.capturedClients, []);
  await gateway(
    runtime.gatewayPort,
    { model: 'gpt-xwx-capture-a', input: 'captured A' },
    { 'session-id': 'retention-a' }
  );
  const captured = await waitForControlStatus(
    runtime.controlPort,
    token,
    status => status.capturedClients?.includes('codex-cli')
  );
  assert.deepEqual(captured.capturedClients, ['codex-cli'],
    'a real helper append must report the captured client to the manager');
  await gateway(
    runtime.gatewayPort,
    { model: 'gpt-xwx-capture-b', input: 'captured B' },
    { 'session-id': 'retention-b' }
  );
  const retainedState = await waitForGatewayState(runtime.gatewayPort, state => state.sessions?.length === 4);
  assert.deepEqual(
    retainedState.sessions
      .map(session => session.clientConversationKey)
      .filter(Boolean)
      .sort(),
    ['codex-cli:retention-a', 'codex-cli:retention-b'],
    'the helper must retain both newly captured Sessions despite an unsupported positive budget'
  );

  const stoppedRecording = await control(runtime.controlPort, token, '/control/configure', {
    generation: 3,
    routes: [],
    clientRoutes: [route],
    recording: false,
    traceRetention: { maxSessions: 1, maxStorageBytes: 0 }
  });
  assert.deepEqual(stoppedRecording.capturedClients, [],
    'turning Trace off must reset the current capture epoch');
  const indexPath = path.join(traceRoot, 'index.json');
  const healthyIndexBytes = await readFile(indexPath);
  const invalidIndexBytes = Buffer.from('{"version":1,"sessions":[', 'utf8');
  await writeFile(indexPath, invalidIndexBytes);
  await assert.rejects(
    control(runtime.controlPort, token, '/control/configure', {
      generation: 4,
      routes: [],
      clientRoutes: [route],
      recording: true,
      traceRetention: { maxSessions: 1, maxStorageBytes: 0 }
    }),
    /returned 500:.*Trace 索引不可用/,
    'the helper must reject recording before mutating routes or generation when the index is unreadable'
  );
  const rejectedRecording = await control(runtime.controlPort, token, '/control/status', undefined, 'GET');
  assert.equal(rejectedRecording.generation, 3);
  assert.equal(rejectedRecording.recording, false);
  assert.deepEqual(await readFile(indexPath), invalidIndexBytes,
    'helper recording preflight must preserve invalid index bytes');
  assert.equal((await gateway(runtime.gatewayPort, { model: 'gpt-index-guard', input: [] })).status, 200,
    'a rejected recording configuration must leave the existing Gateway route usable');
  await writeFile(indexPath, healthyIndexBytes);
  const nonCapturing = await control(runtime.controlPort, token, '/control/configure', {
    generation: 4,
    routes: [],
    clientRoutes: [route],
    recording: true,
    traceRetention: { maxSessions: 1, maxStorageBytes: 0 }
  });
  assert.deepEqual(nonCapturing.capturedClients, []);
  await gateway(runtime.gatewayPort, { model: 'gpt-xwx-no-capture', input: 'capture disabled route' });
  assert.deepEqual(
    (await control(runtime.controlPort, token, '/control/status', undefined, 'GET')).capturedClients,
    [],
    'capture:false routes must not report a client as tracing'
  );
  await control(runtime.controlPort, token, '/control/clear-history', {});
  const leaseAfterClear = JSON.parse(await readFile(writerLeasePath, 'utf8'));
  assert.equal(leaseAfterClear.leaseId, writerLease.leaseId,
    'clearing Trace history must preserve the live writer lease');

  const interrupted = gateway(runtime.gatewayPort, { model: 'gpt-xwx-force', input: 'force-abort' })
    .catch(error => error);
  await forcedRequestReached;
  const active = await control(runtime.controlPort, token, '/control/status', undefined, 'GET');
  assert.equal(active.activeRequests, 1);
  await control(runtime.controlPort, token, '/control/force-prepare-shutdown', {});
  const gated = await gateway(runtime.gatewayPort, { model: 'gpt-xwx-gated', input: [] });
  assert.equal(gated.status, 503, 'force shutdown must gate new helper requests before final stop');
  assert.equal(gated.body.error.type, 'xwx_deck_shutting_down');
  releaseForcedResponse?.();
  await interrupted;
  await control(runtime.controlPort, token, '/control/cancel-shutdown', {});
  assert.equal((await gateway(runtime.gatewayPort, { model: 'gpt-xwx-resumed', input: [] })).status, 200,
    'cancelling cleanup after a force-abort must reopen the helper');

  await control(runtime.controlPort, token, '/control/stop', {});
  await waitForClosed(runtime.controlPort);
  console.log('PASS background Gateway preserves routes, rejects automatic Trace cleanup, reports captures and stops cleanly');
} finally {
  releaseForcedResponse?.();
  if (runtime?.controlPort) {
    await control(runtime.controlPort, token, '/control/stop', {}).catch(() => undefined);
  }
  if (upstream) await close(upstream);
  if (forwardProxy) await close(forwardProxy);
  await rm(temp, { recursive: true, force: true });
}

async function gateway(port, body, headers = {}) {
  const result = await request(port, '/v1/responses', body, 'POST', {
    'user-agent': 'codex-tui/xwx-smoke',
    originator: 'codex-tui',
    ...headers
  });
  return { ...result, body: JSON.parse(result.text) };
}

async function control(port, tokenValue, pathname, body, method = 'POST') {
  const result = await request(port, pathname, body, method, { authorization: `Bearer ${tokenValue}` });
  if (result.status >= 400) throw new Error(`${pathname} returned ${result.status}: ${result.text}`);
  return result.text ? JSON.parse(result.text) : {};
}

function request(port, pathname, body, method, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, timeout: 3_000,
      headers: {
        ...headers,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`request timed out: ${pathname}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('server has no TCP port'));
      else resolve(address.port);
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

function exited(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`launcher exited ${code}`)));
  });
}

function exitCode(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
}

async function waitForRuntime(file) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch {}
    await delay(50);
  }
  throw new Error('Gateway helper did not publish runtime.json');
}

async function waitForClosed(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { await request(port, '/control/status', undefined, 'GET'); }
    catch { return; }
    await delay(50);
  }
  throw new Error('Gateway helper did not stop');
}

async function waitForGatewayState(port, predicate) {
  const deadline = Date.now() + 5_000;
  let lastState;
  while (Date.now() < deadline) {
    const result = await request(port, '/api/state', undefined, 'GET', { accept: 'application/json' });
    assert.equal(result.status, 200);
    lastState = JSON.parse(result.text);
    if (predicate(lastState)) return lastState;
    await delay(50);
  }
  throw new Error(`Gateway state did not reach the expected condition: ${JSON.stringify(lastState)}`);
}

async function waitForControlStatus(port, tokenValue, predicate) {
  const deadline = Date.now() + 5_000;
  let lastStatus;
  while (Date.now() < deadline) {
    lastStatus = await control(port, tokenValue, '/control/status', undefined, 'GET');
    if (predicate(lastStatus)) return lastStatus;
    await delay(50);
  }
  throw new Error(`Gateway control status did not reach the expected condition: ${JSON.stringify(lastStatus)}`);
}

async function seedTraceHistory(rootDir) {
  const sessions = [
    { id: 'old-a', startedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' },
    { id: 'old-b', startedAt: '2020-01-02T00:00:00.000Z', updatedAt: '2020-01-02T00:00:00.000Z' }
  ].map(item => ({
    ...item,
    traceCount: 1,
    jsonlPath: path.join(rootDir, `${item.id}.jsonl`)
  }));
  for (const session of sessions) {
    await writeFile(session.jsonlPath, `${JSON.stringify({ id: session.id, payload: 'x'.repeat(2048) })}\n`);
  }
  await writeFile(path.join(rootDir, 'index.json'), JSON.stringify({ version: 1, sessions }));
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
