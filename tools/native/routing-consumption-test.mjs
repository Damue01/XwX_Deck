// Observe committed settings, client files, live transport and Trace together.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { startNativeRpc } from './rpc-test-session.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-routing-consumption-'));
const calls = [], checks = [], failures = [];
let counter = 0, activeReply, catalogProtocol;
const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'routing fixture' }] }];
const response = body => ({ id: 'routing-' + ++counter, object: 'response', status: 'completed', model: body.model, output, usage: { input_tokens: 2, output_tokens: 1 } });
const server = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method === 'GET') { res.end(JSON.stringify({ data: ['launch-model', 'new-model'].map(id => ({ id, ...catalogProtocol ? { supported_endpoints: [catalogProtocol] } : {} })) })); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); calls.push({ path: req.url, body, auth: req.headers.authorization });
  if (body.input === 'image denied upstream') { res.statusCode = 422; res.end(JSON.stringify({ error: { message: 'upstream fixture image unavailable' } })); return; }
  res.end(JSON.stringify(req.url.endsWith('/chat/completions')
    ? { id: 'chat-' + ++counter, model: body.model, choices: [{ message: { role: 'assistant', content: 'routing fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }
    : response(body)));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}/v1`;
const wss = new WebSocketServer({ server });
wss.on('connection', (socket, req) => socket.on('message', raw => {
  const body = JSON.parse(raw); calls.push({ transport: 'ws', path: req.url, auth: req.headers.authorization, body });
  if (body.input === 'held response') {
    socket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'routing ' }));
    activeReply = () => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'response.completed', response: response(body) })); };
  } else socket.send(JSON.stringify({ type: 'response.completed', response: response(body) }));
}));
const sockets = new Set();
async function open(state, session, path = '/v1/responses') {
  const ws = new WebSocket(state.localBaseUrl.replace('http:', 'ws:') + path, { headers: { 'x-codex-thread-id': session } });
  sockets.add(ws); ws.on('error', () => {}); await once(ws, 'open'); return ws;
}
async function close(ws) { if (ws.readyState === WebSocket.CLOSED) return; const done = once(ws, 'close'); ws.close(); await done; }
function closedWithin(ws, ms = 1500) {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve(true);
  return new Promise(resolve => { const timer = setTimeout(() => { ws.off('close', finish); resolve(false); }, ms); const finish = () => { clearTimeout(timer); resolve(true); }; ws.once('close', finish); });
}
async function send(ws, body) {
  const reply = once(ws, 'message'); ws.send(JSON.stringify({ type: 'response.create', ...body }));
  return JSON.parse((await reply)[0].toString());
}
async function test(name, run) {
  if (process.env.XWX_ROUTING_CASE && process.env.XWX_ROUTING_CASE !== name) return;
  const app = startNativeRpc(join(root, name));
  try { await app.rpc('getState'); await run(app); checks.push(name); console.log('PASS ' + name); }
  catch (error) { failures.push({ name, error: error.message }); console.error('FAIL ' + name + ': ' + error.message); }
  finally { for (const ws of sockets) await close(ws); sockets.clear(); await app.stop(); }
}
async function select(app, adapter = 'responses', extra = {}) {
  await app.rpc('saveProvider', { id: 'route', displayName: 'Route fixture', adapter, codexApiFormat: 'responses', baseUrl: base, bearerToken: 'synthetic-route-key', codexModel: 'launch-model', ...extra });
  await app.rpc('switchClientProvider', { client: 'codex', providerId: 'route' });
  return app.rpc('toggleTracing', true);
}
async function post(app, state, input, previous, model = 'launch-model', extra = {}) {
  const result = await fetch(state.localBaseUrl + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', 'x-codex-thread-id': 'same-thread' }, body: JSON.stringify({ model, input, ...previous ? { previous_response_id: previous } : {}, ...extra }) });
  assert.equal(result.status, 200, await result.clone().text()); return result.json();
}
try {
  await test('model-change-active-websocket', async app => {
    const state = await select(app), ws = await open(state, 'model-thread');
    await send(ws, { model: 'launch-model', input: 'record launch default' });
    const delta = await send(ws, { model: 'launch-model', input: 'held response' });
    assert.equal(delta.type, 'response.output_text.delta');
    await app.rpc('updateCodexConfig', { compatibleModel: 'new-model', expectedProviderId: 'route' });
    const config = await readFile(join(root, 'model-change-active-websocket/codex/config.toml'), 'utf8');
    assert.match(config, /model = "new-model"/);
    assert.equal(ws.readyState, WebSocket.OPEN, 'accepted reply must finish on its original transport');
    const done = once(ws, 'message'); activeReply(); const completed = JSON.parse((await done)[0]);
    assert.equal(completed.response.model, 'launch-model');
    assert.ok(await closedWithin(ws), 'updated model must invalidate the cached idle WebSocket provider');
    const next = await open(state, 'model-thread');
    await send(next, { model: 'launch-model', previous_response_id: completed.response.id, input: 'continue' });
    assert.equal(calls.at(-1).body.model, 'new-model');
    assert.match(JSON.stringify(calls.at(-1).body), /held response/);
    assert.equal(calls.at(-1).body.previous_response_id, undefined);
    assert.equal((await app.rpc('getState')).localBaseUrl, state.localBaseUrl);
    assert.equal(calls.filter(c => c.body.input === 'held response').length, 1, 'no replay');
    await app.rpc('toggleTracing', false);
  });
  await test('protocol-change-idle-websocket', async app => {
    const state = await select(app, 'auto'), ws = await open(state, 'protocol-thread');
    await send(ws, { model: 'launch-model', input: 'before protocol change' });
    await app.rpc('saveProvider', { id: 'route', displayName: 'Route fixture', adapter: 'auto', codexApiFormat: 'chat-completions', baseUrl: base, bearerToken: 'synthetic-route-key', codexModel: 'launch-model' });
    assert.ok(await closedWithin(ws), 'explicit protocol update must invalidate the cached idle WebSocket');
    const continued = await post(app, state, 'continue with conversion'); assert.equal(continued.status, 'completed');
    assert.equal(calls.at(-1).path, '/v1/chat/completions');
    await app.rpc('toggleTracing', false);
  });
  await test('chat-websocket-negotiation', async app => {
    const state = await select(app, 'auto', { codexApiFormat: 'chat-completions' });
    const count = calls.length, upstreamCount = wss.clients.size;
    const ws = new WebSocket(state.localBaseUrl.replace('http:', 'ws:') + '/v1/responses'); sockets.add(ws); ws.on('error', () => {});
    const result = await new Promise(resolve => { ws.once('open', () => resolve(101)); ws.once('unexpected-response', (_req, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); }); });
    assert.equal(result, 426, 'declared Chat route must negotiate HTTP before accepting any task');
    assert.equal(wss.clients.size, upstreamCount); assert.equal(calls.length, count);
    await app.rpc('toggleTracing', false);
  });
  await test('full-endpoint-websocket', async app => {
    const state = await select(app, 'responses', { baseUrl: base + '/responses' });
    const ws = await open(state, 'endpoint-thread');
    await send(ws, { model: 'launch-model', input: 'full configured endpoint' });
    assert.equal(calls.at(-1).path, '/v1/responses', 'WS and HTTP must normalize the same configured endpoint');
    await close(ws); await app.rpc('toggleTracing', false);
  });
  await test('catalog-protocol-consumer', async app => {
    catalogProtocol = '/responses';
    try {
      const state = await select(app, 'auto'); await app.rpc('fetchProviderModels', { providerId: 'route', refresh: true });
      const ws = await open(state, 'catalog-thread');
      await send(ws, { model: 'launch-model', input: 'before catalog update' });
      const count = calls.length;
      catalogProtocol = '/chat/completions'; await app.rpc('fetchProviderModels', { providerId: 'route', refresh: true });
      const rejected = await send(ws, { model: 'launch-model', input: 'must renegotiate transport' });
      assert.equal(rejected.type, 'error'); assert.equal(calls.length, count, 'updated catalog must prevent forwarding over stale WS protocol');
      assert.ok(await closedWithin(ws));
      await post(app, state, 'HTTP after catalog update'); assert.equal(calls.at(-1).path, '/v1/chat/completions');
      await app.rpc('toggleTracing', false);
    } finally { catalogProtocol = undefined; }
  });
  async function clientRoute(app, providerId, model = 'launch-model') {
    const snapshot = await app.rpc('getClientRoute', 'cherry-studio');
    return app.rpc('setClientRoute', { client: 'cherry-studio', providerId, model, configDigest: snapshot.configDigest, takeoverConfirmed: true });
  }
  await test('scoped-websocket-provider', async app => {
    const state = await select(app); await clientRoute(app, 'route');
    const ws = await open(state, 'scoped-thread', '/clients/cherry-studio/v1/responses');
    await send(ws, { model: 'launch-model', input: 'scoped service marker' });
    await app.rpc('saveProvider', { id: 'second', displayName: 'Second fixture', adapter: 'responses', baseUrl: base, bearerToken: 'second-synthetic-key', codexModel: 'new-model' });
    await clientRoute(app, 'second', 'new-model');
    assert.ok(await closedWithin(ws), 'scoped WebSocket must observe its own updated client route');
    const next = await open(state, 'scoped-thread', '/clients/cherry-studio/v1/responses');
    await send(next, { model: 'launch-model', input: 'after scoped switch' });
    assert.equal(calls.at(-1).auth, 'Bearer second-synthetic-key'); assert.equal(calls.at(-1).body.model, 'new-model');
    assert.equal((await app.rpc('getProviders')).selected.codex, 'route', 'scoped changes must preserve the Codex selection');
    await close(next); await app.rpc('toggleTracing', false);
  });
  await test('scoped-http-websocket-session', async app => {
    const state = await select(app); await clientRoute(app, 'route');
    const first = await post(app, state, 'separate Codex context');
    const http = await fetch(state.localBaseUrl + '/clients/cherry-studio/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', 'x-codex-thread-id': 'same-thread' }, body: JSON.stringify({ model: 'launch-model', input: 'scoped HTTP context' }) });
    assert.equal(http.status, 200); const previous = await http.json();
    const ws = await open(state, 'same-thread', '/clients/cherry-studio/v1/responses');
    await send(ws, { model: 'launch-model', input: 'scoped WS continuation', previous_response_id: previous.id });
    assert.equal(calls.at(-1).body.previous_response_id, previous.id, 'same-service HTTP and WS retain native continuation within the client scope');
    assert.ok(!JSON.stringify(calls.at(-1).body).includes('separate Codex context'));
    const dashboard = await app.rpc('getDashboardUrl'), summary = await (await fetch(dashboard + 'api/state')).json();
    const scoped = summary.sessions.filter(s => s.clientConversationKey === 'cherry-studio:same-thread');
    assert.equal(scoped.length, 1); assert.equal(summary.sessions.filter(s => s.clientConversationKey === 'codex-cli:same-thread').length, 1);
    const detail = await (await fetch(dashboard + 'api/session/' + scoped[0].id)).json();
    assert.equal(detail.traces.length, 2); assert.ok(detail.traces.every(t => t.source === 'cherry-studio'));
    assert.ok(detail.traces.some(t => t.request.method === 'WS'));
    assert.equal(detail.traces.find(t => t.request.method === 'WS').request.path, '/clients/cherry-studio/v1/responses');
    assert.ok(first.id); await close(ws); await app.rpc('toggleTracing', false);
  });
  await test('trace-provider-restart-image-chain', async app => {
    await writeFile(join(root, 'trace-provider-restart-image-chain/codex/config.toml'), '[features]\nimage_generation = true # user choice\n');
    let state = await select(app, 'auto', { codexApiFormat: 'responses' });
    const first = await post(app, state, 'original session marker');
    const tools = [{ type: 'image_generation', quality: 'low' }, { type: 'namespace', name: 'image_gen', tools: [{ type: 'function', name: 'render', parameters: { type: 'object' } }] }];
    await post(app, state, 'image requested', first.id, 'launch-model', { tools });
    assert.deepEqual(calls.at(-1).body.tools, tools, 'native GPT image tools must reach the selected upstream');
    const denied = await fetch(state.localBaseUrl + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', 'x-codex-thread-id': 'same-thread' }, body: JSON.stringify({ model: 'launch-model', input: 'image denied upstream', tools }) });
    assert.equal(denied.status, 422); assert.match(await denied.text(), /upstream fixture image unavailable/);
    await app.rpc('saveProvider', { id: 'route', displayName: 'Route fixture', adapter: 'auto', codexApiFormat: 'chat-completions', baseUrl: base, bearerToken: 'synthetic-route-key', codexModel: 'launch-model' });
    await post(app, state, 'client image namespace', undefined, 'launch-model', { tools: [tools[1]] });
    assert.equal(calls.at(-1).body.tools[0].function.name, 'image_gen__render', 'client image namespace survives conversion without provider filtering');
    assert.match(await readFile(join(root, 'trace-provider-restart-image-chain/codex/config.toml'), 'utf8'), /image_generation = true # user choice/);
    await app.rpc('saveProvider', { id: 'second', displayName: 'Second fixture', adapter: 'responses', baseUrl: base, bearerToken: 'second-synthetic-key', codexModel: 'new-model' });
    await app.rpc('switchClientProvider', { client: 'codex', providerId: 'second' });
    const second = await post(app, state, 'same thread on second', first.id);
    assert.equal(calls.at(-1).auth, 'Bearer second-synthetic-key'); assert.equal(calls.at(-1).body.model, 'new-model');
    assert.match(JSON.stringify(calls.at(-1).body), /original session marker/);
    const url = state.localBaseUrl;
    await app.rpc('toggleTracing', false);
    assert.equal((await app.rpc('getProviders')).selected.codex, 'second');
    const direct = await readFile(join(root, 'trace-provider-restart-image-chain/codex/config.toml'), 'utf8');
    assert.ok(!direct.includes(url)); assert.ok(direct.includes(base)); assert.ok(direct.includes('new-model'));
    await assert.rejects(readFile(join(root, 'trace-provider-restart-image-chain/gateway-recovery.json')), { code: 'ENOENT' });
    await assert.rejects(fetch(url + '/v1/responses'), 'listener must be closed');
    await app.stop(); app = startNativeRpc(join(root, 'trace-provider-restart-image-chain'));
    try {
      assert.equal((await app.rpc('getProviders')).selected.codex, 'second');
      assert.equal((await app.rpc('getState')).tracingEnabled, false);
      state = await app.rpc('toggleTracing', true);
      await post(app, state, 'same thread after restart', second.id);
      assert.equal(calls.at(-1).body.model, 'new-model'); assert.equal(calls.at(-1).body.previous_response_id, second.id, 'same-service restart retains native continuation');
      const dashboard = await app.rpc('getDashboardUrl'), summary = await (await fetch(dashboard + 'api/state')).json();
      const same = summary.sessions.filter(s => s.clientConversationKey === 'codex-cli:same-thread');
      assert.equal(same.length, 1, 'same native thread must remain one Trace session across provider and process changes');
      const detail = await (await fetch(dashboard + 'api/session/' + same[0].id)).json();
      assert.ok(detail.traces.some(t => t.provider.id === 'route')); assert.ok(detail.traces.some(t => t.provider.id === 'second'));
      assert.ok(detail.traces.some(t => t.response.statusCode === 422));
      await app.rpc('toggleTracing', false);
    } finally { await app.stop(); }
  });
  console.log(JSON.stringify({ passed: failures.length === 0, checks, failures, scope: 'P: committed config, native Gateway HTTP/WS, synthetic upstream and native session identity; no production credentials or installed Desktop', fixture: failures.length ? root : undefined }));
  if (failures.length) process.exitCode = 1;
} finally {
  for (const ws of sockets) ws.terminate(); for (const ws of wss.clients) ws.terminate();
  await new Promise(resolve => wss.close(resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (!failures.length) await rm(root, { recursive: true, force: true });
}
