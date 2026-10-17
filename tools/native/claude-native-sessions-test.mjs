// Synthetic regression for native Claude IDs observed in Claude CLI 2.1.212.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNativeRpc } from './rpc-test-session.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'deck-claude-sessions-'));
const server = createServer(async (req, res) => {
  for await (const _ of req) { /* consume the synthetic request */ }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: 'fixture-reply', type: 'message', role: 'assistant', model: 'fixture-model', content: [{ type: 'text', text: 'fixture reply' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const app = startNativeRpc(root);
try {
  for (const id of ['claude-a', 'claude-b']) {
    await app.rpc('saveProvider', { id, displayName: id, adapter: 'anthropic-messages', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, bearerToken: 'SYNTHETIC', codexModel: 'fixture-model' });
  }
  await app.rpc('switchClientProvider', { client: 'claude', providerId: 'claude-a' });
  const gateway = (await app.rpc('toggleTracing', true)).localBaseUrl;
  const send = async (id, header = true) => {
    const response = await fetch(gateway + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', ...(header ? { 'x-claude-code-session-id': id } : {}) }, body: JSON.stringify({ model: 'fixture-model', max_tokens: 32, messages: [{ role: 'user', content: 'same first prompt' }], metadata: { user_id: JSON.stringify({ device_id: 'shared-device', account_uuid: '', session_id: id }) } }) });
    assert.equal(response.status, 200);
    await response.json();
  };
  await send('claude-thread-one');
  await send('claude-thread-one', false);
  await app.rpc('switchClientProvider', { client: 'claude', providerId: 'claude-b' });
  await send('claude-thread-one');
  await send('claude-thread-two');
  const url = await app.rpc('getDashboardUrl');
  const state = await (await fetch(url + 'api/state')).json();
  assert.equal(state.sessions.length, 2, 'same prompt does not merge different native IDs');
  const main = state.sessions.find(s => s.clientConversationKey === 'claude-cli:claude-thread-one');
  assert.equal(main.traceCount, 3, 'header, JSON metadata and provider switch retain one thread');
  const traces = (await (await fetch(url + 'api/session/' + main.id)).json()).traces;
  assert.deepEqual(traces.map(t => t.provider.id), ['claude-a', 'claude-a', 'claude-b']);
  assert.equal(traces[1].request.body.metadata.user_id, JSON.stringify({ device_id: 'shared-device', account_uuid: '', session_id: 'claude-thread-one' }), 'original metadata remains intact');
  await app.rpc('toggleTracing', false);
  console.log('PASS Claude native header/JSON metadata, provider switch and equal-prompt separation');
} finally {
  await app.stop();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
