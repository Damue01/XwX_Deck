// P only: real native HTTP/WS and Viewer API, disposable data and local upstream.
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { startNativeRpc } from './rpc-test-session.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-trace-compaction-'));
const prompt = 'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.';
const requests = [];
let serial = 0, app;
const reply = body => ({ id: `compact-fixture-${++serial}`, object: 'response', status: 'completed', model: body.model,
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture handoff summary' }] }],
  usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } });
const server = createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part;
  const body = JSON.parse(raw); requests.push(body);
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply(body)));
});
const wss = new WebSocketServer({ server });
wss.on('connection', ws => ws.on('message', raw => {
  const body = JSON.parse(raw); requests.push(body);
  ws.send(JSON.stringify({ type: 'response.completed', response: reply(body) }));
}));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const checks = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
try {
  app = startNativeRpc(root);
  await app.rpc('saveProvider', { id: 'compact-local', displayName: 'compact-local', adapter: 'responses', codexApiFormat: 'responses',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, bearerToken: 'SYNTHETIC-COMPACT', codexModel: 'fixture-model' });
  await app.rpc('switchClientProvider', { client: 'codex', providerId: 'compact-local' });
  const gateway = (await app.rpc('toggleTracing', true)).localBaseUrl;
  const submitted = [];
  const post = async input => {
    const body = { model: 'fixture-model', input }; submitted.push(body);
    const response = await fetch(gateway + '/v1/responses', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-codex-thread-id': 'compact-thread',
    }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); await response.json();
  };
  await post([{ role: 'user', content: 'first request' }, { role: 'user', content: [{ type: 'input_text', text: prompt }] }]);
  await post([{ role: 'user', content: prompt }, { role: 'assistant', content: 'summary one' }, { role: 'user', content: 'continue one' }]);
  await post([{ role: 'assistant', content: 'summary one' }, { role: 'user', content: prompt }]);
  await post([{ role: 'user', content: prompt }, { role: 'assistant', content: 'summary two' }, { role: 'user', content: 'continue two' }]);
  await post([{ role: 'user', content: 'Explain this prompt: ' + prompt }]);
  const ws = new WebSocket(gateway.replace('http:', 'ws:') + '/v1/responses', { headers: { 'x-codex-thread-id': 'compact-thread' } });
  await once(ws, 'open');
  const received = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'response.create', model: 'fixture-model', input: [{ role: 'user', content: prompt }] }));
  await received; const closed = once(ws, 'close'); ws.close(); await closed;
  let url = await app.rpc('getDashboardUrl');
  const sessions = (await (await fetch(url + 'api/state')).json()).sessions;
  const session = sessions.find(s => s.clientConversationKey === 'codex-cli:compact-thread'); assert.ok(session);
  const detail = await (await fetch(url + 'api/session/' + session.id)).json();
  assert.equal(detail.traces.length, 6);
  assert.deepEqual(detail.traces.map(t => t.compact === true), [true, false, true, false, false, true]);
  assert.ok(detail.traces.filter(t => t.compact).every(t => t.contextChanges.compactionMode === 'client-summary'));
  pass('two HTTP compactions and one WS compaction are marked; reuse and quoted prompts are not');
  for (let i = 0; i < submitted.length; i++) assert.deepEqual(detail.traces[i].request.body, submitted[i]);
  assert.equal(requests.length, 6, 'classification does not send extra requests');
  pass('classification preserves original client bodies and sends no additional generation');
  await app.rpc('toggleTracing', false); await app.stop(); app = null;
  const file = join(root, 'traces', session.id + '.jsonl');
  const original = await readFile(file, 'utf8');
  const historical = original.trimEnd().split('\n').map(line => {
    const row = JSON.parse(line); delete row.compact;
    if (row.contextChanges) delete row.contextChanges.compactionMode;
    return JSON.stringify(row);
  }).join('\n') + '\n';
  await writeFile(file, historical); // Synthetic old-version fixture only.
  app = startNativeRpc(root); url = await app.rpc('getDashboardUrl');
  const reread = await (await fetch(url + 'api/session/' + session.id)).json();
  assert.deepEqual(reread.traces.map(t => t.compact === true), [true, false, true, false, false, true]);
  assert.equal(await readFile(file, 'utf8'), historical);
  pass('old missing markers are restored in the read view without rewriting historical JSONL');
  console.log(JSON.stringify({ evidenceLevel: 'P', checks: checks.length, passed: checks, realCompaction: 'pending' }));
} finally {
  await app?.stop(); for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
}
