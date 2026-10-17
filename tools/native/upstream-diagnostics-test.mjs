// Actual Rust Gateway and faulting local upstream; no normal config or real credentials.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, realpath, readFile, writeFile, mkdir, rm, stat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeTestBinary } from './test-support.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'deck-upstream-diagnostics-'));
let mode = 'reset', requests = 0, child;
const server = createServer(async (req, res) => {
  for await (const chunk of req) { void chunk; }
  requests++;
  if (mode === 'reset') { req.socket.destroy(); return; }
  if (mode === 'http-error') {
    res.writeHead(503, { 'content-type': 'application/json', 'x-oai-request-id': 'official-request-fixture', 'cf-ray': 'ray-fixture', 'set-cookie': 'private-response-cookie' });
    res.end('{"error":{"message":"upstream-original-fixture"}}'); return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end('data: {"type":"response.completed","response":{"id":"response-fixture","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const endpoint = `http://127.0.0.1:${server.address().port}`;
const pending = new Map(); let sequence = 0;
const call = (method, ...args) => new Promise((resolve, reject) => {
  const requestId = ++sequence;
  const timer = setTimeout(() => reject(Error(method + ' timeout')), 15000);
  pending.set(requestId, v => { clearTimeout(timer); resolve(v); });
  child.stdin.write(JSON.stringify({ requestId, method, args }) + '\n');
});
const rpc = async (method, ...args) => { const v = await call(method, ...args); assert.equal(v.ok, true, v.error); return v.result; };
const logPath = join(root, 'logs/upstream-errors.jsonl');
function launch() {
  child = spawn(nativeTestBinary, ['--rpc', '--pilot-root', root], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } });
  createInterface({ input: child.stdout }).on('line', line => { const v = JSON.parse(line); pending.get(v.requestId)?.(v); pending.delete(v.requestId); });
}
async function stop() {
  const ended = once(child, 'exit'); child.stdin.end(); assert.equal((await ended)[0], 0);
}
async function records(count) {
  for (let i = 0; i < 100; i++) {
    const rows = await readFile(logPath, 'utf8').then(v => v.trim().split('\n').map(JSON.parse)).catch(() => []);
    if (rows.length >= count) return rows;
    await new Promise(r => setTimeout(r, 20));
  }
  throw Error('diagnostic did not arrive');
}
try {
  launch(); await rpc('getState'); await stop();
  await mkdir(join(root, 'codex'), { recursive: true });
  const originalAuth = JSON.stringify({ tokens: { access_token: 'official-private-token', refresh_token: 'official-private-refresh', account_id: 'official-private-account' } });
  const originalConfig = `model_provider = "openai"\nmodel = "fixture-model"\nopenai_base_url = "${endpoint}/backend-api"\n`;
  await writeFile(join(root, 'codex/auth.json'), originalAuth);
  await writeFile(join(root, 'codex/config.toml'), originalConfig);
  launch();
  const state = await rpc('toggleTracing', true);
  const send = () => fetch(state.localBaseUrl + '/responses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer official-private-token', 'chatgpt-account-id': 'official-private-account' }, body: JSON.stringify({ model: 'fixture-model', input: 'private-conversation-fixture', stream: true }) });
  const reset = await send(); assert.equal(reset.status, 502);
  const resetText = await reset.text();
  assert.ok(resetText, 'transport failure body must be readable: ' + JSON.stringify(Object.fromEntries(reset.headers)));
  const body = JSON.parse(resetText); assert.equal(body.error.type, 'upstream_connection_error'); assert.match(body.error.message, /upstream service.*try again/i); assert.doesNotMatch(JSON.stringify(body), /Rust|pilot|Deck|official-private|connection reset/i);
  let rows = await records(1); assert.equal(rows[0].event, 'upstream_transport_error'); assert.equal(rows[0].httpResponseReceived, false);
  assert.equal(rows[0].official, true); assert.equal(rows[0].oauth, true); assert.ok(rows[0].errorChain.length > 1, 'underlying cause must survive'); assert.equal(requests, 1, 'must not replay an ambiguous generation');
  assert.equal((await rpc('getProviders')).selected.codex, null);
  console.log('PASS failed official-route transport retains cause, neutral JSON, one request and explicit provider');
  mode = 'http-error'; const remote = await send(); assert.equal(remote.status, 503); assert.equal(await remote.text(), '{"error":{"message":"upstream-original-fixture"}}');
  rows = await records(2); assert.equal(rows[1].event, 'upstream_http_error'); assert.equal(rows[1].status, 503); assert.equal(rows[1].httpResponseReceived, true); assert.equal(rows[1]['x-oai-request-id'], 'official-request-fixture'); assert.equal(rows[1]['cf-ray'], 'ray-fixture');
  console.log('PASS actual upstream 503 remains unchanged and has a distinct diagnostic with upstream request ID');
  mode = 'success'; const ok = await send(); assert.equal(ok.status, 200); assert.match(await ok.text(), /response.completed/);
  await new Promise(r => setTimeout(r, 100)); assert.equal((await records(2)).length, 2); assert.equal(requests, 3);
  const logs = await readFile(logPath, 'utf8');
  for (const secret of ['official-private-token', 'official-private-refresh', 'official-private-account', 'private-conversation-fixture', 'private-response-cookie', 'upstream-original-fixture']) assert.ok(!logs.includes(secret), secret);
  if (process.platform !== 'win32') assert.equal((await stat(logPath)).mode & 0o777, 0o600);
  await rename(logPath, logPath + '.saved'); await mkdir(logPath);
  mode = 'reset'; const withoutLog = await send(); assert.equal(withoutLog.status, 502); assert.equal((await withoutLog.json()).error.type, 'upstream_connection_error');
  await new Promise(r => setTimeout(r, 100)); assert.equal((await rpc('getState')).localBaseUrl, state.localBaseUrl);
  await rm(logPath, { recursive: true }); await rename(logPath + '.saved', logPath);
  assert.equal((await records(2)).length, 2);
  console.log('PASS diagnostic write failure does not interrupt the Gateway or replace the original user error');
  await rpc('toggleTracing', false);
  assert.equal(await readFile(join(root, 'codex/auth.json'), 'utf8'), originalAuth);
  assert.equal(await readFile(join(root, 'codex/config.toml'), 'utf8'), originalConfig);
  await stop();
  console.log('PASS next request succeeds, successful traffic is not logged, secrets absent and config/auth restored');
} finally {
  if (child && child.exitCode === null) child.kill();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
