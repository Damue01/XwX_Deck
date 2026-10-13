import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNativeRpc } from './rpc-test-session.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'xwxdeck-desktop-models-'));
const hash = id => BigInt('0x' + createHash('sha256').update(id).digest('hex').slice(0, 32)).toString();
const collision = 'claude-sonnet-4-6-v' + hash('chat-fixture');
const native = ['claude-sonnet-primary', 'claude-sonnet-secondary', collision];
const bridged = ['chat-fixture', 'responses-fixture', 'claude-sonnet-mimo-fixture', 'claude-sonnet-chat-fixture'];
const excluded = ['text-embedding-fixture', 'gpt-image-fixture', 'qwen-vl-ocr', 'gemini-only-fixture', 'retired-text-fixture', 'alias-embedding', 'alias-video'];
const requests = [], checks = [];
let failure = false;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const sse = (event, body) => `event: ${event}\ndata: ${JSON.stringify(body)}\n\n`;
const upstream = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method === 'GET') {
    res.end(JSON.stringify({ data: [...native, ...bridged, ...excluded.slice(0, 3), ...excluded.slice(4)].map(id => ({ id, status: id === excluded[4] ? 'Shutdown' : undefined, task_type: id === 'alias-embedding' ? ['TextEmbedding'] : undefined, output_modalities: id === 'alias-video' ? ['video'] : undefined, supported_endpoint_types: [id === 'responses-fixture' ? 'openai-responses' : ['chat-fixture', 'claude-sonnet-chat-fixture'].includes(id) ? 'chat-completions' : 'anthropic-messages'] })) }));
    return;
  }
  let source = ''; for await (const bytes of req) source += bytes;
  const body = JSON.parse(source); requests.push({ path: req.url, body, key: req.headers['x-api-key'], authorization: req.headers.authorization });
  if (req.url.endsWith('/messages/count_tokens')) { res.end(JSON.stringify({ input_tokens: 23 })); return; }
  if (failure) { res.writeHead(429); res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Synthetic upstream limit' } })); return; }
  if (req.url.endsWith('/messages')) {
    const answer = { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: '4' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } };
    if (body.stream) {
      res.setHeader('content-type', 'text/event-stream');
      res.end(sse('message_start', { type: 'message_start', message: { ...answer, content: [] } }) + sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '4' } }) + sse('content_block_stop', { type: 'content_block_stop', index: 0 }) + sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) + sse('message_stop', { type: 'message_stop' }));
    } else res.end(JSON.stringify(answer));
  } else if (req.url.endsWith('/chat/completions')) {
    if (body.stream) {
      res.setHeader('content-type', 'text/event-stream');
      res.end('data: ' + JSON.stringify({ id: 'chat_fixture', model: body.model, choices: [{ index: 0, delta: { content: '4' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n');
    } else res.end(JSON.stringify({ id: 'chat_fixture', model: body.model, choices: [{ message: { role: 'assistant', content: '4' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
  } else {
    const answer = { id: 'resp_fixture', object: 'response', status: 'completed', model: body.model, output: [{ id: 'item_fixture', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '4' }] }], usage: { input_tokens: 3, output_tokens: 1 } };
    if (body.stream) { res.setHeader('content-type', 'text/event-stream'); res.end(sse('response.completed', { type: 'response.completed', response: answer })); }
    else res.end(JSON.stringify(answer));
  }
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const base = `http://127.0.0.1:${upstream.address().port}`;
let app = startNativeRpc(root), passed = false;
const profile = async () => JSON.parse(await readFile((await app.rpc('getClaudeDesktopSync')).configPath, 'utf8'));
async function send(config, model, stream = false) {
  const response = await fetch(config.inferenceGatewayBaseUrl + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': config.inferenceGatewayApiKey }, body: JSON.stringify({ model, max_tokens: 256, stream, messages: [{ role: 'user', content: 'What is 2 + 2?' }] }) });
  const source = await response.text(); assert.equal(response.status, failure ? 429 : 200, source);
  if (!failure) { if (stream) assert.match(source, /"text":"4"/); else assert.equal(JSON.parse(source).content[0].text, '4'); }
  return source;
}
try {
  await app.rpc('getState');
  const registry = await app.rpc('saveProvider', { id: 'Desktop_Routing', displayName: 'Fixture_3d4682b3', adapter: 'auto', baseUrl: base + '/v1', bearerToken: 'SYNTHETIC-DESKTOP-KEY', codexApiFormat: 'chat-completions', codexModel: native[0] });
  const provider = registry.connections.find(p => p.id === 'Desktop_Routing');
  await app.rpc('fetchProviderModels', { providerId: provider.id, refresh: true });
  const cachePath = join(root, 'provider-' + createHash('sha256').update(provider.id).digest('hex').slice(0, 24) + '-models.json');
  const cache = JSON.parse(await readFile(cachePath));
  cache.entries.find(row => row.id === native[1]).contextWindow = 1_000_000;
  await writeFile(cachePath, JSON.stringify(cache));
  await app.rpc('switchClientProvider', { client: 'claude', providerId: provider.id });
  await app.rpc('updateClaudeModels', { expectedProviderId: provider.id, sonnet: native[0] });
  await app.rpc('updateClaudeDesktopSync', true);
  let config = await profile();
  assert.deepEqual(config.inferenceModels.map(m => m.labelOverride).sort(), [...native].sort(), 'direct profile contains only native Messages models');
  assert.equal(config.inferenceModels.find(m => m.name === native[1]).supports1m, true);
  await send(config, native[1]); assert.equal(requests.at(-1).body.model, native[1]);
  pass('direct profile filters bridges/non-conversational models, retains context capability and reaches its actual Messages endpoint');
  const running = await app.rpc('toggleTracing', true); config = await profile();
  assert.ok(config.inferenceGatewayBaseUrl.endsWith('/claude-desktop'));
  assert.deepEqual(config.inferenceModels.map(m => m.labelOverride).sort(), [...native, ...bridged].sort());
  for (const id of [...native, ...bridged]) {
    const entry = config.inferenceModels.find(m => m.labelOverride === id);
    for (const stream of [false, true]) {
      await send(config, entry.name, stream);
      assert.equal(requests.at(-1).body.model, id, 'Desktop selection must reach that exact model');
      const path = id === 'responses-fixture' ? '/v1/responses' : ['chat-fixture', 'claude-sonnet-chat-fixture'].includes(id) ? '/v1/chat/completions' : '/v1/messages';
      assert.equal(requests.at(-1).path, path);
      assert.ok(requests.at(-1).key === 'SYNTHETIC-DESKTOP-KEY' || requests.at(-1).authorization === 'Bearer SYNTHETIC-DESKTOP-KEY');
    }
  }
  pass('seven final profile models reach the exact upstream model and declared protocol through JSON and SSE');
  for (const id of [native[1], 'claude-sonnet-mimo-fixture']) {
    const entry = config.inferenceModels.find(m => m.labelOverride === id);
    const count = await fetch(config.inferenceGatewayBaseUrl + '/v1/messages/count_tokens', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': config.inferenceGatewayApiKey }, body: JSON.stringify({ model: entry.name + '[1m]', messages: [{ role: 'user', content: 'Count this' }] }) });
    assert.equal(count.status, 200); assert.equal((await count.json()).input_tokens, 23);
    assert.equal(requests.at(-1).path, '/v1/messages/count_tokens'); assert.equal(requests.at(-1).body.model, id);
  }
  const beforeCount = requests.length;
  const unsupportedCount = await fetch(config.inferenceGatewayBaseUrl + '/v1/messages/count_tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: config.inferenceModels.find(m => m.labelOverride === 'chat-fixture').name, messages: [] }) });
  assert.equal(unsupportedCount.status, 501); assert.equal(requests.length, beforeCount, 'no fake count or generation for a bridged count request');
  pass('native token counting uses the exact model route and alias; converted routes report unavailable counts without inventing usage');
  const chat = config.inferenceModels.find(m => m.labelOverride === 'chat-fixture');
  assert.equal(chat.name, collision + ':2', 'actual upstream model retains its colliding published ID');
  for (const alias of [chat.name, collision.replace('-v', '-')]) {
    await send(config, alias + '[1m]'); assert.equal(requests.at(-1).body.model, 'chat-fixture');
  }
  await send({ ...config, inferenceGatewayBaseUrl: running.localBaseUrl }, native[1]);
  assert.equal(requests.at(-1).body.model, native[1], 'cached old Desktop URL still preserves a published native model');
  pass('numeric alias collisions, legacy aliases, 1m suffixes and cached Desktop URLs preserve the chosen model');
  failure = true; const before = requests.length;
  assert.match(await send(config, native[1]), /rate_limit_error/); assert.equal(requests.length, before + 1); failure = false;
  pass('upstream quota errors remain failures without switching models or replaying the request');
  await app.rpc('toggleTracing', false); config = await profile();
  assert.deepEqual(config.inferenceModels.map(m => m.name).sort(), [...native].sort());
  await send(config, native[1]); assert.equal(requests.at(-1).body.model, native[1]);
  await app.stop(); app = startNativeRpc(root); await app.rpc('getState');
  config = await profile(); await send(config, native[1]);
  await app.rpc('toggleTracing', true); config = await profile(); await send(config, chat.name); assert.equal(requests.at(-1).body.model, 'chat-fixture');
  await app.rpc('toggleTracing', false);
  const modePath = join(root, 'desktop/Claude/claude_desktop_config.json');
  const mode = JSON.parse(await readFile(modePath)); await writeFile(modePath, JSON.stringify({ ...mode, deploymentMode: '1p' }));
  assert.equal((await app.rpc('getClaudeDesktopSync')).active, false, 'external deployment mode changes cannot be reported active');
  await writeFile(modePath, JSON.stringify(mode)); await app.rpc('updateClaudeDesktopSync', false);
  pass('stop, direct request, restart, re-enable and disable preserve routing and detect external deployment changes');
  passed = true;
  const evidence = { passed, checks, requests: requests.length, scope: 'generated Desktop files consumed by isolated HTTP/SSE client; no installed Claude Desktop process or live platform authorization', binarySha256: createHash('sha256').update(await readFile((await import('./test-support.mjs')).nativeTestBinary)).digest('hex') };
  await writeFile('test-results/native-desktop-model-routing-summary.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await app.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  if (passed) await rm(root, { recursive: true, force: true });
  else console.error('Retained isolated Desktop failure fixture: ' + root);
}
