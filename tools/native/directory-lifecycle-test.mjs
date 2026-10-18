import { clearFreshCompatibleFixture } from './test-support.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { nativeTestBinary } from './test-support.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'xwxdeck-directory-'));
const pending = new Map(), checks = []; let child, serial = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function start() {
  child = spawn(nativeTestBinary, ['--rpc', '--pilot-root', root]);
  child.stderr.on('data', value => process.stderr.write(value));
  createInterface({ input: child.stdout }).on('line', line => {
    const result = JSON.parse(line), handle = pending.get(result.requestId); pending.delete(result.requestId); handle?.(result);
  });
}
function rpc(method, ...args) {
  return new Promise((resolve, reject) => {
    const requestId = String(++serial), timer = setTimeout(() => { pending.delete(requestId); reject(Error(method + ' timeout')); }, 15000);
    pending.set(requestId, value => { clearTimeout(timer); value.ok ? resolve(value.result) : reject(Error(value.error)); });
    child.stdin.write(JSON.stringify({ requestId, method, args }) + '\n');
  });
}
async function stop() { const exit = once(child, 'exit'); child.stdin.end(); assert.equal((await exit)[0], 0); }
const absent = async path => assert.equal(await stat(path).then(() => false, e => e.code === 'ENOENT'), true, path + ' not created');
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const server = createServer(async (req, res) => {
  for await (const _ of req) {} res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: 'directory-fixture', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'record preserved' }] }], usage: { input_tokens: 1, output_tokens: 2 } }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const upstream = `http://127.0.0.1:${server.address().port}/v1`;
async function listenerClosed(url) {
  const port = Number(new URL(url).port);
  for (let i = 0; i < 100; i++) {
    const open = await new Promise(resolve => { const socket = createConnection({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
    if (!open) return; await delay(10);
  }
  assert.fail('old listener still accepts connections');
}
try {
  start(); const initial = await rpc('getState'), settings = join(root, 'settings.json');
  const before = await readFile(settings);
  await assert.rejects(rpc('updateTraceDirectories', { traceRoot: join(root, 'not-created/a'), logRoot: 42 }), /无效目录/);
  await absent(join(root, 'not-created')); assert.deepEqual(await readFile(settings), before);
  assert.equal((await rpc('getState')).traceRoot, initial.traceRoot);
  pass('all input paths validate before creating directories or changing persisted/runtime selection');
  const linked = join(root, 'linked'), destination = join(root, 'destination'); await mkdir(destination); await symlink(destination, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(rpc('updateTraceDirectories', { traceRoot: join(linked, 'never-created') }), /符号链接/);
  await absent(join(destination, 'never-created')); assert.deepEqual(await readFile(settings), before);
  pass('a missing leaf below a symlink is rejected before creating anything in its destination');
  await clearFreshCompatibleFixture(rpc);
  const provider = await rpc('saveProvider', { displayName: 'Fixture_b14fc12a', adapter: 'responses', baseUrl: upstream, bearerToken: 'SYNTHETIC-DIRECTORY-KEY', codexModel: 'fixture' });
  await rpc('switchClientProvider', { client: 'codex', providerId: provider.connections[0].id });
  let state = await rpc('toggleTracing', true);
  let response = await fetch(state.localBaseUrl + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture', input: 'local fixture' }) });
  assert.equal(response.status, 200); await response.json();
  await assert.rejects(rpc('updateTraceDirectories', { traceRoot: join(root, 'blocked-active'), logRoot: join(root, 'also-blocked') }), /停止 Trace/);
  await absent(join(root, 'blocked-active')); await absent(join(root, 'also-blocked'));
  const liveUrl = state.localBaseUrl;
  state = await rpc('updateTraceDirectories', { logRoot: join(root, 'active-log') });
  assert.equal(state.localBaseUrl, liveUrl); assert.equal(state.tracingEnabled, true);
  await rpc('toggleTracing', false);
  pass('data/client directory changes during Trace are rejected together; log-only changes preserve the same active Gateway');
  const messages = await rpc('saveProvider', { displayName: 'Fixture_6ca0e169', adapter: 'anthropic-messages', baseUrl: upstream, bearerToken: 'SYNTHETIC-DIRECTORY-KEY', claudeModels: { sonnet: 'fixture' } });
  await rpc('switchClientProvider', { client: 'claude', providerId: messages.connections.find(p => p.displayName === 'Fixture_6ca0e169').id });
  await assert.rejects(rpc('updateTraceDirectories', { traceRoot: join(root, 'claude-blocked-data'), logRoot: join(root, 'claude-blocked-logs'), claudeConfigDir: join(root, 'new-claude') }), /恢复 Claude 官方/);
  await absent(join(root, 'claude-blocked-data')); await absent(join(root, 'claude-blocked-logs')); await absent(join(root, 'new-claude'));
  assert.equal((await rpc('getState')).traceRoot, initial.traceRoot);
  await rpc('switchClientProvider', { client: 'claude', providerId: null });
  pass('an owned Claude direct ledger blocks the whole directory transaction until its original client configuration is restored');
  const oldDashboard = await rpc('getDashboardUrl'), oldState = await fetch(oldDashboard + 'api/state').then(r => r.json());
  const oldIndex = await readFile(join(initial.traceRoot, 'index.json'));
  assert.ok(oldState.sessions.length >= 1);
  const events = await fetch(oldDashboard + 'events'), reader = events.body.getReader(); await reader.read();
  const nextEvent = reader.read();
  void nextEvent.catch(() => {}); // Observe it below without masking an earlier assertion during cleanup.
  const nextRoot = join(root, 'new-data');
  await writeFile(join(root, 'settings.pilot-tmp'), 'EXTERNAL-TEMPORARY-FILE');
  const failedBytes = await readFile(settings);
  await assert.rejects(rpc('updateTraceDirectories', { traceRoot: nextRoot, logRoot: join(root, 'new-logs/deep') }), /临时文件已存在/);
  await absent(nextRoot); await absent(join(root, 'new-logs')); assert.deepEqual(await readFile(settings), failedBytes);
  assert.equal((await rpc('getState')).traceRoot, initial.traceRoot); assert.equal(await rpc('getDashboardUrl'), oldDashboard);
  assert.ok((await fetch(oldDashboard + 'api/state').then(r => r.json())).sessions.length >= 1);
  await rm(join(root, 'settings.pilot-tmp'));
  pass('a settings write failure rolls back new empty directories and preserves old history and its live dashboard');
  const invalidRoot = join(root, 'unreadable-index'); await mkdir(invalidRoot); await mkdir(join(invalidRoot, 'index.json'));
  await assert.rejects(rpc('updateTraceDirectories', { traceRoot: invalidRoot, logRoot: join(root, 'rolled-back-logs') }));
  await absent(join(root, 'rolled-back-logs')); assert.equal((await rpc('getState')).traceRoot, initial.traceRoot);
  pass('a target store read error leaves all selected paths and the old store unchanged');
  state = await rpc('updateTraceDirectories', { traceRoot: nextRoot, logRoot: join(root, 'new-logs') });
  assert.equal(state.traceRoot, nextRoot);
  const ended = await Promise.race([nextEvent, delay(1500).then(() => { throw Error('old SSE did not finish'); })]);
  assert.equal(ended.done, true); await listenerClosed(oldDashboard);
  const newDashboard = await rpc('getDashboardUrl'); assert.notEqual(newDashboard, oldDashboard);
  assert.equal((await fetch(newDashboard + 'api/state').then(r => r.json())).sessions.length, 0);
  assert.deepEqual(await readFile(join(initial.traceRoot, 'index.json')), oldIndex);
  pass('successful data switching closes the old listener and SSE, opens the new store, and never moves or deletes old history');
  assert.equal(await rpc('getDashboardUrl'), newDashboard);
  await rpc('updateTraceDirectories', { traceRoot: nextRoot }); assert.equal(await rpc('getDashboardUrl'), newDashboard);
  pass('saving an unchanged data path keeps its existing dashboard and subscriptions');
  const external = JSON.parse(await readFile(settings, 'utf8')); external.externalSentinel = 'KEEP'; const externalBytes = Buffer.from(JSON.stringify(external)); await writeFile(settings, externalBytes);
  await assert.rejects(rpc('updateTraceDirectories', { traceRoot: join(root, 'external-blocked') }), /外部修改/);
  await absent(join(root, 'external-blocked')); assert.deepEqual(await readFile(settings), externalBytes);
  assert.equal((await rpc('getState')).traceRoot, nextRoot);
  await stop(); await listenerClosed(newDashboard); start();
  assert.equal((await rpc('getState')).traceRoot, nextRoot); assert.equal(JSON.parse(await readFile(settings, 'utf8')).externalSentinel, 'KEEP');
  pass('external settings changes prevent directory writes; restart reads them without dropping unknown fields and releases the old listener');
  await rpc('updateTraceDirectories', { traceRoot: '', logRoot: '', claudeConfigDir: '' }); state = await rpc('getState');
  assert.equal(state.traceRoot, join(root, 'traces')); assert.equal(state.logRoot, join(root, 'logs'));
  assert.deepEqual(await readFile(join(initial.traceRoot, 'index.json')), oldIndex);
  await stop();
  pass('returning to default directories reopens preserved history without deleting the custom directories');
  console.log(JSON.stringify({ passed: true, checks, scope: 'isolated native processes, real filesystem, loopback HTTP and open SSE; normal client data untouched' }));
} finally {
  if (child?.exitCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
}
