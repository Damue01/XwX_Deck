import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNativeRpc } from './rpc-test-session.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'xwxdeck-price-catalog-'));
const fixtures = [
  { provider: 'deepseek', model: 'catalog-low-ratio-fixture', read: .03, policy: 'input', cost: .0000518 },
  { provider: 'anthropic', model: 'catalog-high-ratio-fixture', read: .8, write: 1.25, cost: .000103 },
  { provider: 'google', model: 'catalog-storage-fixture', read: .1, policy: 'storage', cost: null, known: .000036 },
  { provider: 'minimax', model: 'catalog-old-free-fixture', read: .1, cost: null, known: .000036 },
];
const catalog = Object.fromEntries(fixtures.map(item => [item.provider, { models: {
  [item.model]: { cost: { input: 1, output: 2, cache_read: item.read, ...(item.write === undefined ? {} : { cache_write: item.write }) } },
} }]));
let offline = false, requests = 0, app;
const streams = new Set();
const server = createServer(async (req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\n\n');
    streams.add(res); res.on('close', () => streams.delete(res)); return;
  }
  if (req.url === '/models-dev') {
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(offline ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(offline ? {} : catalog)); return;
  }
  if (req.url.endsWith('/models')) { res.setHeader('content-type','application/json'); res.end(JSON.stringify({data:fixtures.map(item=>({id:item.model}))})); return; }
  let source = ''; for await (const chunk of req) source += chunk;
  const body = JSON.parse(source); requests++;
  assert.equal(req.url, '/v1/responses');
  assert.equal(req.headers.authorization, 'Bearer synthetic-only');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: `catalog-${requests}`, object: 'response', status: 'completed', model: body.model,
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'synthetic answer' }] }],
    usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 60, cache_write_tokens: 20, cache_write_5m_tokens: 20, cache_write_1h_tokens: 0 } } }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const start = () => startNativeRpc(root, ['--metadata-test-endpoint', origin]);
const pricesPath = join(root, 'pricing-cache/models-dev-pricing.json');
try {
  app = start(); await app.rpc('getState');
  await app.stop();
  await mkdir(join(root, 'pricing-cache'), { recursive: true });
  await writeFile(pricesPath, JSON.stringify({ version: 2, fetchedAt: new Date().toISOString(), rules: fixtures.slice(2).map(item => ({
    match: 'exact', tokens: [item.model], modelId: item.model, providerId: item.provider, source: 'models.dev', protocol: 'openai', input: 1, output: 2, cacheRead: item.read,
    cacheWritePolicy: item.provider === 'google' ? 'unknown' : 'free',
  })) }));
  app = start();
  assert.equal((await app.rpc('refreshMetadata', { topics: ['pricing'], reason: 'local-contract' })).status, 'ready');
  const bytes = await readFile(pricesPath, 'utf8');
  const rules = JSON.parse(bytes).rules;
  for (const item of fixtures) {
    const rule = rules.find(row => row.modelId === item.model);
    assert.equal(rule.cacheRead, item.read);
    assert.equal(rule.cacheWritePolicy, item.policy);
    assert.equal(rule.cacheWritePolicySource, item.policy ? 'official' : undefined);
  }
  offline = true;
  assert.equal((await app.rpc('refreshMetadata', { topics: ['pricing'], reason: 'offline-contract' })).status, 'partial');
  assert.equal(await readFile(pricesPath, 'utf8'), bytes, 'network failure preserves the last source values');
  await app.stop(); app = start();
  for (const item of fixtures) {
    await app.rpc('saveProvider', { id: item.model, displayName: item.model, adapter: 'responses', baseUrl: origin + '/v1', bearerToken: 'synthetic-only', codexModel: item.model });
    await app.rpc('switchClientProvider', { client: 'codex', providerId: item.model });
    const state = await app.rpc('toggleTracing', true);
    const response = await fetch(state.localBaseUrl + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-id': item.model }, body: JSON.stringify({ model: item.model, input: 'synthetic catalog request' }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).usage.input_tokens_details.cached_tokens, 60);
    const dashboard = await app.rpc('getDashboardUrl');
    let session;
    for (let i = 0; i < 100; i++) {
      session = (await (await fetch(dashboard + 'api/state')).json()).sessions.find(row => row.clientConversationKey.endsWith(':' + item.model));
      if (session) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(session);
    const point = session.nativeUsage[0];
    if (item.cost === null) assert.equal(point.costUsd, null);
    else assert.ok(Math.abs(point.costUsd - item.cost) < 1e-12, `${item.model} cost ${point.costUsd}`);
    assert.ok(Math.abs(point.knownCostUsd - (item.known ?? item.cost)) < 1e-12);
    assert.equal(point.costComplete, item.cost !== null);
    await app.rpc('toggleTracing', false);
  }
  assert.equal(requests, 4);
  console.log('PASS legacy inferred policies → source refresh → cache → failed refresh → restart → four Gateway requests → exact or partial Trace charges; synthetic upstream only');
} finally {
  await app?.stop();
  for (const stream of streams) stream.destroy();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
