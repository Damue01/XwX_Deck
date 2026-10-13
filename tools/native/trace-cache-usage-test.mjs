import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { once } from 'node:events';
import vm from 'node:vm';
import { nativeTestBinary } from './test-support.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'xwxdeck-cache-usage-'));
const window = {};
vm.runInNewContext(await readFile(resolve(import.meta.dirname, '../../src/shared/trace-cache-rate.browser.js'), 'utf8'), { window });
const rate = window.XwXTraceCacheRate;
let mode = 'cached', requests = 0, child, rpc;
const server = createServer(async (req, res) => {
  let raw = ''; for await (const bytes of req) raw += bytes;
  const body = JSON.parse(raw); requests++;
  const messages = req.url.endsWith('/messages');
  const usage = messages ? { ...(mode === 'unknown' ? {} : {input_tokens:mode === 'cached' ? 20 : 100}), output_tokens: 5, ...(['unknown','optional'].includes(mode) ? {} : { cache_read_input_tokens: mode === 'cached' ? 60 : 0, cache_creation_input_tokens: mode === 'cached' ? 20 : 0 }) }
    : { ...(mode === 'unknown' ? {} : {prompt_tokens:100}), completion_tokens: 5, ...(['unknown','optional'].includes(mode) ? {} : { prompt_tokens_details: { cached_tokens: mode === 'cached' ? 60 : 0 } }) };
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(messages ? { id: 'cache-' + requests, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'local cache fixture' }], stop_reason: 'end_turn', usage }
    : { id: 'cache-' + requests, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'local cache fixture' }, finish_reason: 'stop' }], usage }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
function start() {
  child = spawn(nativeTestBinary, ['--rpc', '--pilot-root', root], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = [];
  createInterface({ input: child.stdout }).on('line', line => pending.shift()?.(JSON.parse(line)));
  rpc = async (method, ...args) => {
    const reply = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('RPC timeout ' + method)), 20000); pending.push(value => { clearTimeout(timer); resolve(value); }); child.stdin.write(JSON.stringify({ method, args }) + '\n'); });
    assert.equal(reply.ok, true, reply.error); return reply.result;
  };
}
async function stop() { const done = once(child, 'exit'); child.stdin.end(); await done; }
async function sessions() { const url = await rpc('getDashboardUrl'); return (await (await fetch(url + 'api/state')).json()).sessions; }
async function send(state, client, id, expectedCount) {
  const response = await fetch(state.localBaseUrl + (client === 'claude' ? '/v1/messages' : '/v1/responses'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-id': id }, body: JSON.stringify(client === 'claude' ? { model: 'sonnet', max_tokens: 32, messages: [{ role: 'user', content: 'synthetic ' + id }] } : { model: 'cache-model', input: 'synthetic ' + id }) });
  assert.equal(response.status, 200); await response.json();
  for (let n = 0; n < 100; n++) { const values = await sessions(); if (values.reduce((sum, s) => sum + s.traceCount, 0) === expectedCount) return values; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('capture not persisted');
}
try {
  start(); let count = 0;
  for (const [client, adapter] of [['codex', 'chat-completions'], ['claude', 'anthropic-messages']]) {
    const id = 'cache-' + client;
    await rpc('saveProvider', { id, displayName: id, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, bearerToken: 'synthetic-local-only', adapter, codexModel: 'cache-model' });
    await rpc('switchClientProvider', { client, providerId: id });
    if (client === 'claude') await rpc('updateClaudeModels', { sonnet: 'cache-model' });
    const state = await rpc('toggleTracing', true);
    const before = await sessions();
    mode = 'cached'; let values = await send(state, client, client + '-cached', ++count);
    const captured = values.filter(s => !before.some(p => p.id === s.id));
    assert.equal(rate(captured), .6, adapter + ' actual upstream usage reaches the dashboard denominator');
    mode = 'unknown'; values = await send(state, client, client + '-unknown', ++count);
    const unknown = values.find(s => s.clientConversationKey.endsWith(':' + client + '-unknown'));
    assert.ok(unknown); assert.equal(rate([unknown]), null);
    mode = 'zero'; values = await send(state, client, client + '-unknown', ++count);
    const retainedUnknown = values.find(s => s.id === unknown.id);
    assert.equal(retainedUnknown.traceCount, 2); assert.equal(rate([retainedUnknown]), null, 'later complete usage cannot erase earlier missing fields');
    const priorIds = values.map(s => s.id);
    values = await send(state, client, client + '-zero', ++count);
    assert.equal(rate(values.filter(s => !priorIds.includes(s.id))), 0, 'explicit no-cache usage is known zero');
    mode='optional';values=await send(state,client,client+'-optional',++count);
    assert.equal(rate(values.filter(s=>s.clientConversationKey.endsWith(':'+client+'-optional'))),0,'documented optional cache breakdown omission is a normal no-cache response');
    await rpc('toggleTracing', false);
  }
  const before = await sessions(); await stop(); start();
  const after = await sessions();
  assert.deepEqual(after.map(s => [s.id, s.usageByModel]).sort(), before.map(s => [s.id, s.usageByModel]).sort(), 'restart preserves missing provenance and normalized buckets');
  assert.equal(requests, 10, 'one upstream request per capture, no usage replay');
  console.log('PASS 10 actual local requests: Chat/Responses conversion and Messages cache usage, optional breakdown defaults, explicit zero, genuine missing input union and process restart');
} finally { if (child?.exitCode === null) await stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
