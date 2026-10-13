import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startNativeRpc } from './rpc-test-session.mjs';
import { nativeTestBinary } from './test-support.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'deck-usage-only-'));
const traces = join(root, 'traces');
const checks = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
let releaseHeld, heldStarted;
const began = new Promise(resolve => { heldStarted = resolve; });
const server = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'fixture' }) + '\n\n');
  const finish = () => res.end('data: ' + JSON.stringify({ type: 'response.completed', response: {
    id: 'response-' + body.input, status: 'completed', model: 'usage-fixture',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'private-answer-marker' }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
  } }) + '\n\n');
  if (body.input === 'held-private-marker') { releaseHeld = finish; heldStarted(); } else finish();
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let app = startNativeRpc(root);
const index = async () => JSON.parse(await readFile(join(traces, 'index.json'), 'utf8'));
const files = async () => (await readdir(traces)).filter(name => name.endsWith('.jsonl'));
const wait = async (predicate, label) => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 20)); } throw Error(label); };
const send = (base, thread, input) => fetch(base + '/v1/responses', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-codex-thread-id': thread },
  body: JSON.stringify({ model: 'usage-fixture', input, stream: true })
});
let passed = false;
let failure;
try {
  await app.rpc('saveProvider', { id: 'usage-fixture', displayName: 'usage-fixture', adapter: 'responses',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, bearerToken: 'SYNTHETIC', codexModel: 'usage-fixture' });
  await app.rpc('switchClientProvider', { client: 'codex', providerId: 'usage-fixture' });
  await app.rpc('setTraceStoragePolicy', { autoCleanup: false });
  const state = await app.rpc('toggleTracing', true); const base = state.localBaseUrl;
  for (const id of ['old-a', 'active-b', 'old-c']) assert.match(await (await send(base, id, id + '-private-marker')).text(), /response.completed/);
  await wait(async () => (await index()).sessions.length === 3, 'seed detailed sessions');
  const before = await app.rpc('getTraceStats');
  assert.equal(before.total.tokens, 45);
  const active = (await index()).sessions.find(s => s.clientConversationKey === 'codex-cli:active-b');
  const activeBytes = await readFile(active.jsonlPath);
  await writeFile(join(traces, 'unrelated.bin'), 'unrelated fixture');
  const held = send(base, 'active-b', 'held-private-marker').then(r => r.text());
  await began;
  const saved = await app.rpc('setTraceStoragePolicy', { limitGB: 0 });
  assert.equal(saved.traceWarningGB, 0); assert.equal(saved.traceAutoCleanup, false);
  assert.equal(saved.localBaseUrl, base); assert.equal(saved.tracingEnabled, true);
  assert.equal((await index()).sessions.length, 1);
  assert.deepEqual(await readFile(active.jsonlPath), activeBytes);
  assert.equal((await files()).length, 1);
  assert.match(saved.traceStorageNotice, /正在生成/);
  assert.deepEqual((await app.rpc('getTraceStats')).total, before.total);
  pass('0 GB saves with Trace active and auto-cleanup off, removes ended details immediately and preserves an in-flight conversation and its stats');

  assert.match(await (await send(base, 'new-d', 'new-private-marker')).text(), /response.completed/);
  await wait(async () => (await app.rpc('getTraceStats')).total.tokens === 60, 'usage-only turn is accounted');
  assert.equal((await files()).length, 1);
  assert.ok(!(await readFile(join(traces, 'index.json'), 'utf8')).includes('new-private-marker'));
  pass('new turns keep only usage without writing request/response bodies or creating a detail file');

  releaseHeld(); assert.match(await held, /response.completed/);
  await wait(async () => (await files()).length === 0 && (await app.rpc('getTraceStats')).total.tokens === 75, 'deferred active session purge');
  assert.equal((await index()).sessions.length, 0);
  const summaryText = await readFile(join(traces, 'index.json'), 'utf8');
  assert.ok(!summaryText.includes('private-marker') && !summaryText.includes('private-answer-marker'));
  assert.equal(await readFile(join(traces, 'unrelated.bin'), 'utf8'), 'unrelated fixture');
  const finalStats = await app.rpc('getTraceStats');
  await app.rpc('setTraceStoragePolicy', { limitGB: 0 });
  assert.deepEqual((await app.rpc('getTraceStats')).total, finalStats.total);
  pass('last active completion purges retained details, keeps exact accounting, leaves unrelated files and repeated 0 GB does not double-count');

  await app.rpc('toggleTracing', false); await app.stop(); app = startNativeRpc(root);
  assert.equal((await app.rpc('getState')).traceWarningGB, 0);
  assert.deepEqual(await app.rpc('getTraceStats'), finalStats);
  assert.equal((await files()).length, 0);
  pass('restart preserves usage-only choice and exact token/cost history without resurrecting details');

  await app.rpc('setTraceStoragePolicy', { limitGB: 1 });
  const next = await app.rpc('toggleTracing', true);
  assert.match(await (await send(next.localBaseUrl, 'new-e', 'restored-private-marker')).text(), /response.completed/);
  await wait(async () => (await files()).length === 1, 'restore detail recording');
  const legacyStats = await app.rpc('getTraceStats');
  const oldIndex = await readFile(join(traces, 'index.json'));
  const oldFile = (await index()).sessions[0].jsonlPath;
  const oldDetails = await readFile(oldFile);
  await app.rpc('setTraceStoragePolicy', { limitGB: 0 });
  await app.rpc('toggleTracing', false); await app.stop();
  // Restore a pre-fix detailed index under an actually saved, encrypted 0 GB
  // setting. Editing the credential envelope would not change the preference.
  await writeFile(join(traces, 'index.json'), oldIndex); await writeFile(oldFile, oldDetails);
  app = startNativeRpc(root); await app.rpc('getState');
  assert.equal((await files()).length, 0);
  assert.deepEqual(await app.rpc('getTraceStats'), legacyStats);
  pass('returning to a positive limit records details; an existing saved 0 GB policy also purges pre-fix historical details on startup');
  await app.rpc('clearHistory'); assert.equal((await app.rpc('getTraceStats')).total.tokens, 0);
  pass('explicit clear-history also removes the retained usage ledger');
  passed = true;
} catch (error) {
  failure = String(error); throw error;
} finally {
  releaseHeld?.(); await app.stop(); server.closeAllConnections(); await new Promise(r => server.close(r));
  const binarySha256 = createHash('sha256').update(await readFile(nativeTestBinary)).digest('hex');
  await writeFile(resolve('test-results/native-usage-only-summary.json'), JSON.stringify({ passed, checks, binarySha256,
    error: failure, syntheticUpstream: true, isolatedFixtures: true }, null, 2) + '\n');
  await rm(root, { recursive: true, force: true });
}
