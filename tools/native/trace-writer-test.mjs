import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { nativeTestBinary } from './test-support.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'xwxdeck-shared-writer-'));
const second = join(root, 'second'), shared = join(second, 'shared-traces');
let requests = 0;
const upstream = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests++;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: 'writer-' + requests, object: 'response', status: 'completed', model: body.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'shared writer reply' }] }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } }));
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const base = `http://127.0.0.1:${upstream.address().port}/v1`;
const checks = [], clients = [];
const pass = label => { checks.push(label); console.log('PASS ' + label); };
function client(directory) {
  const child = spawn(nativeTestBinary, ['--rpc', '--pilot-root', directory]);
  const queue = []; let stderr = '';
  createInterface({ input: child.stdout }).on('line', line => queue.shift()?.(JSON.parse(line)));
  child.stderr.on('data', bytes => { stderr += bytes; });
  const rpc = (method, ...args) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(method + ' timeout: ' + stderr)), 15000);
    queue.push(value => { clearTimeout(timer); value.ok ? resolve(value.result) : reject(Error(value.error)); });
    child.stdin.write(JSON.stringify({ method, args }) + '\n');
  });
  const result = { child, rpc, directory }; clients.push(result); return result;
}
const leasePath = join(shared, 'trace-writer.lock'), indexPath = join(shared, 'index.json');
async function snapshot() {
  const files = (await readdir(shared)).filter(name => name === 'index.json' || name.endsWith('.jsonl')).sort();
  return Object.fromEntries(await Promise.all(files.map(async name => [name, await readFile(join(shared, name), 'utf8')])));
}
async function request(state, thread, input = thread) {
  const response = await fetch(state.localBaseUrl + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', 'x-codex-thread-id': thread }, body: JSON.stringify({ model: 'writer-model', input }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).output[0].content[0].text, 'shared writer reply');
}
async function count(expected) {
  for (let i = 0; i < 100; i++) {
    const value = JSON.parse(await readFile(indexPath, 'utf8'));
    if (value.sessions.reduce((sum, s) => sum + s.traceCount, 0) === expected) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Trace count did not reach ' + expected);
}
try {
  const a = client(root); await a.rpc('getState');
  await mkdir(second); const b = client(second); await b.rpc('getState');
  await mkdir(shared);
  for (const c of [a, b]) {
    await c.rpc('getState');
    await c.rpc('updateTraceDirectories', { traceRoot: shared });
    await c.rpc('saveProvider', { id: 'writer-fixture', displayName: 'Fixture_7f0511dc', baseUrl: base, bearerToken: 'SYNTHETIC-WRITER-KEY', adapter: 'responses', codexModel: 'writer-model' });
    await c.rpc('switchClientProvider', { client: 'codex', providerId: 'writer-fixture' });
  }
  let live = await a.rpc('toggleTracing', true);
  const lease = await readFile(leasePath, 'utf8'); assert.equal(JSON.parse(lease).pid, a.child.pid);
  const bConfig = await readFile(join(second, 'codex/config.toml'), 'utf8');
  await assert.rejects(b.rpc('toggleTracing', true), /写入者|写入进程/);
  assert.equal(await readFile(join(second, 'codex/config.toml'), 'utf8'), bConfig);
  await assert.rejects(b.rpc('clearHistory'), /写入者|写入进程/);
  const plan = await b.rpc('inspectTraceIndexRepair');
  await assert.rejects(b.rpc('applyTraceIndexRepair', plan.indexSha256), /写入者|写入进程/);
  assert.equal(await readFile(leasePath, 'utf8'), lease);
  await request(live, 'writer-a'); await count(1);
  const aBytes = await snapshot();
  pass('a second native process cannot start, delete or repair the active writer’s shared history or modify its client configuration');
  await a.rpc('updateTraceDirectories', { logRoot: join(root, 'other-logs') });
  assert.equal((await a.rpc('getState')).tracingEnabled, true);
  assert.equal(await readFile(leasePath, 'utf8'), lease);
  await request(live, 'writer-a'); await count(2);
  await a.rpc('updateTraceDirectories', { traceRoot: shared });
  assert.equal((await a.rpc('getState')).localBaseUrl, live.localBaseUrl);
  assert.equal(await readFile(leasePath, 'utf8'), lease);
  await assert.rejects(a.rpc('updateTraceDirectories', { traceRoot: join(root, 'different-traces') }), /先停止 Trace/);
  pass('changing only the log directory preserves the active listener and writer lease; changing Trace data waits for an explicit stop');
  await a.rpc('toggleTracing', false); await assert.rejects(readFile(leasePath), { code: 'ENOENT' });
  live = await b.rpc('toggleTracing', true); await request(live, 'writer-b'); await count(3);
  for (const [name, bytes] of Object.entries(aBytes)) if (name.endsWith('.jsonl')) assert.ok((await readFile(join(shared, name), 'utf8')).startsWith(bytes));
  await b.rpc('toggleTracing', false);
  pass('ownership handoff reloads the completed index and preserves the former writer’s JSONL records');
  const raced = await Promise.allSettled([a.rpc('toggleTracing', true), b.rpc('toggleTracing', true)]);
  assert.equal(raced.filter(value => value.status === 'fulfilled').length, 1);
  const winner = raced[0].status === 'fulfilled' ? a : b;
  await winner.rpc('toggleTracing', false);
  pass('simultaneous starts elect exactly one writer across processes');
  const before = await snapshot();
  const mockLease = pid => JSON.stringify({ version: 1, pid, leaseId: 'synthetic-legacy-lease', startedAt: '2026-10-10T00:00:00Z' });
  await writeFile(leasePath, mockLease(process.pid));
  await assert.rejects(a.rpc('toggleTracing', true), /写入进程|身份无法确认/);
  assert.equal(await readFile(leasePath, 'utf8'), mockLease(process.pid));
  await writeFile(leasePath, '{initializing');
  await assert.rejects(a.rpc('toggleTracing', true), /初始化或损坏/);
  assert.equal(await readFile(leasePath, 'utf8'), '{initializing'); assert.deepEqual(await snapshot(), before);
  await writeFile(leasePath, mockLease(2147483647));
  live = await a.rpc('toggleTracing', true);
  assert.equal(JSON.parse(await readFile(leasePath, 'utf8')).pid, a.child.pid);
  pass('live or malformed legacy leases remain untouched; only a verifiably dead lease can be recovered');
  const foreignLease = mockLease(process.pid);
  await writeFile(leasePath, foreignLease); await request(live, 'tampered-lease');
  for (let i = 0; i < 100 && !(await a.rpc('getState')).lastError; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match((await a.rpc('getState')).lastError, /租约已被外部修改/);
  assert.deepEqual(await snapshot(), before);
  await a.rpc('toggleTracing', false);
  assert.equal(await readFile(leasePath, 'utf8'), foreignLease);
  assert.ok(!(await readFile(join(root, 'codex/config.toml'), 'utf8')).includes(live.localBaseUrl));
  await rm(leasePath); // This file was created by this fixture, never a real writer.
  pass('lease tampering stops recording with an actionable error, restores direct routing, and leaves foreign ownership and every history byte intact');
  live = await a.rpc('toggleTracing', true);
  const editedIndex = await readFile(indexPath, 'utf8') + '\n'; await writeFile(indexPath, editedIndex);
  await request(live, 'external-index');
  for (let i = 0; i < 100 && !(await a.rpc('getState')).lastError; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match((await a.rpc('getState')).lastError, /索引已被外部修改/);
  assert.equal(await readFile(indexPath, 'utf8'), editedIndex);
  await a.rpc('toggleTracing', false);
  const repair = await a.rpc('inspectTraceIndexRepair');
  const repaired = await a.rpc('applyTraceIndexRepair', repair.indexSha256);
  assert.equal(await readFile(repaired.backupIndexPath, 'utf8'), editedIndex);
  assert.equal((await a.rpc('getState')).lastError, null);
  live = await a.rpc('toggleTracing', true); await request(live, 'after-repair'); await count(4); await a.rpc('toggleTracing', false);
  pass('external index changes are not overwritten; an explicit backed-up repair clears the warning and recording resumes without losing earlier history');

  // Real local requests, repeated history, process restart and the actual Viewer
  // detail endpoint. Compare expanded evidence with the complete physical pair.
  const context = Array.from({length:2000}, (_, i) => createHash('sha256').update('writer-context-' + i).digest('hex')).join('');
  const history = [{role:'system',content:context}];
  let active = a, expandedBytes = 0, session;
  const inputs = [];
  for (let turn = 0; turn < 8; turn++) {
    if (turn === 4) {
      await active.rpc('toggleTracing', false);
      const done = once(active.child, 'exit'); active.child.stdin.end(); assert.equal((await done)[0], 0);
      active = client(root); await active.rpc('getState');
    }
    if (turn === 0 || turn === 4) live = await active.rpc('toggleTracing', true);
    history.push({role:'user',content:'storage round ' + turn});
    inputs.push(structuredClone(history));
    await request(live, 'compressed-thread', history);
    const index = await count(5 + turn);
    session = index.sessions.find(s => s.clientConversationKey.endsWith(':compressed-thread'));
    assert.ok(session);
    const dashboard = await active.rpc('getDashboardUrl');
    const response = await fetch(dashboard + 'api/session/' + session.id);
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.traces.length, turn + 1);
    for (let i = 0; i <= turn; i++) {
      assert.deepEqual(page.traces[i].request.body.input, inputs[i]);
      assert.deepEqual(page.traces[i].upstream.requestBody.input, inputs[i]);
      assert.equal(page.traces[i]._traceContent, undefined);
    }
    expandedBytes += Buffer.byteLength(JSON.stringify(page.traces.at(-1)));
  }
  await active.rpc('toggleTracing', false);
  const contentPath = session.jsonlPath.replace(/\.jsonl$/, '.content.sqlite');
  const physicalBytes = (await stat(session.jsonlPath)).size + (await stat(contentPath)).size;
  assert.ok(physicalBytes * 10 < expandedBytes, 'repeated history is stored once instead of per request and side');
  const storedRows = (await readFile(session.jsonlPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const refs = storedRows.map(row => row._traceContent.refs['/request/body/input/0']);
  assert.ok(refs[0] && refs.every(hash => hash === refs[0]));
  const filesBefore = await Promise.all([session.jsonlPath, contentPath].map(path => readFile(path)));
  const contentPlan = await active.rpc('inspectTraceIndexRepair');
  assert.deepEqual(contentPlan.contentErrors, []);
  await active.rpc('applyTraceIndexRepair', contentPlan.indexSha256);
  assert.deepEqual(await Promise.all([session.jsonlPath, contentPath].map(path => readFile(path))), filesBefore);
  pass('compressed history is exact on both request sides across process restart; backed-up repair leaves both files byte-identical');
  console.log(JSON.stringify({traceContentFixture:{expandedBytes,physicalBytes,reductionPercent:100*(1-physicalBytes/expandedBytes)}}));
  const tokensBefore = (await active.rpc('getTraceStats')).total.tokens;
  await active.rpc('setTraceStoragePolicy', {limitGB:0,autoCleanup:true});
  assert.equal((await active.rpc('getTraceStats')).total.tokens,tokensBefore);
  assert.equal((await readdir(shared)).filter(name => /\.(jsonl|sqlite)(-journal|-wal|-shm)?$/.test(name)).length,0);
  pass('0 GB clears every completed log and content database while retaining accumulated usage');
  for (const c of clients) if (c.child.exitCode === null) { const done = once(c.child, 'exit'); c.child.stdin.end(); assert.equal((await done)[0], 0); }
  console.log(JSON.stringify({ passed: true, checks, upstreamRequests: requests, scope: 'two actual Rust processes, isolated configuration and shared history, local upstream; no normal clients or accounts' }));
} finally {
  for (const c of clients) if (c.child.exitCode === null) { c.child.kill('SIGKILL'); await once(c.child, 'exit'); }
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await rm(root, { recursive: true, force: true });
}
