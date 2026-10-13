import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { nativeTestBinary } from './test-support.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'xwxdeck-billing-'));
const rules = [
  { modelId: 'fixture-ttl', protocol: 'anthropic', cacheWrite: 1.25, cacheWrite1h: 2 },
  { modelId: 'fixture-input', protocol: 'openai', cacheWrite: 1 },
  { modelId: 'fixture-premium', protocol: 'openai', cacheWrite: 1.25 },
  { modelId: 'fixture-uniform', protocol: 'openai', cacheRead: 1, cacheWrite: 1 },
  { modelId: 'gpt-5.6-billing-fixture', protocol: 'openai', providerId: 'openai', source: 'models.dev', cacheWritePolicy: 'input', cacheWritePolicySource: 'official' }
].map(r => ({ match: 'exact', source: 'models.dev', referenceOnly:true, tokens: [r.modelId], input: 1, output: 2, cacheRead: .1, ...r }));
rules.push({ modelId: 'fixture-unknown-read', tokens: ['fixture-unknown-read'], match: 'exact', source: 'models.dev', referenceOnly:true, protocol: 'openai', input: 1, output: 2, cacheWrite: 1 });
rules.push({ modelId: 'fixture-fraction', tokens: ['fixture-fraction'], match: 'exact', source: 'models.dev', referenceOnly:true, protocol: 'openai', input: .128, output: 1.25, cacheRead: 0, cacheWrite: 0 });
const cached = { cached_tokens: 60, cache_write_tokens: 20 };
const cases = [
  { name: 'fractional-cost-roundtrip', adapter: 'responses', model: 'fixture-fraction', raw: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }, cost: .00001905, write: 0, input: 100 },
  { name: 'unknown-read-price', adapter: 'responses', model: 'fixture-unknown-read', raw: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 60, cache_write_tokens: 20 } }, cost: null, partial: .00005, input: 100, write: 20 },
  { name: 'compatible-additive', adapter: 'chat-completions', model: 'fixture-ttl', raw: { input_tokens: 0, prompt_tokens: 20, completion_tokens: 5, cache_read_input_tokens: 60, cache_creation_input_tokens: 20, prompt_tokens_details: { cached_tokens: 60 }, claude_cache_creation_5_m_tokens: 8, claude_cache_creation_1_h_tokens: 12 }, cost: .00007, write: 20, input: 100 },
  { name: 'compatible-inclusive', adapter: 'chat-completions', model: 'fixture-ttl', raw: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 60 }, claude_cache_creation_5_m_tokens: 8, claude_cache_creation_1_h_tokens: 12 }, cost: .00007, write: 20, input: 100 },
  { name: 'messages-nested-sse', adapter: 'anthropic-messages', model: 'fixture-ttl', stream: true, raw: { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 60, cache_creation_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 8, ephemeral_1h_input_tokens: 12 } }, cost: .00007, write: 20, input: 100 },
  { name: 'responses-write', adapter: 'responses', model: 'fixture-premium', raw: { input_tokens: 100, output_tokens: 5, input_tokens_details: cached, output_tokens_details: { reasoning_tokens: 3 } }, cost: .000061, write: 20, input: 100 },
  { name: 'deepseek-alias', adapter: 'chat-completions', model: 'fixture-premium', raw: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, prompt_cache_hit_tokens: 60 }, cost: .000056, write: 0, input: 100 },
  { name: 'missing-write-input-rate', adapter: 'responses', model: 'fixture-input', raw: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 60 } }, cost: .000056, input: 100 },
  { name: 'missing-write-premium', adapter: 'responses', model: 'fixture-premium', raw: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 60 } }, cost: null, partial: .000016, input: 100 },
  { name: 'missing-read-uniform', adapter: 'responses', model: 'fixture-uniform', raw: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cache_write_tokens: 0 } }, cost: .00011, write: 0, input: 100 },
  { name: 'stale-openai-cache-policy', adapter: 'responses', model: 'gpt-5.6-billing-fixture', raw: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 60 } }, cost: null, partial: .000016, input: 100 }
];
let current, count = 0, child, rpc;
const server = createServer(async (req, res) => {
  let raw = ''; for await (const bytes of req) raw += bytes;
  const body = JSON.parse(raw); count++;
  assert.equal(body.model, current.model);
  if (current.stream) {
    res.setHeader('content-type', 'text/event-stream');
    const frame = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
    res.end(frame('message_start', { message: { id: current.name, model: body.model, type: 'message', role: 'assistant', content: [], usage: current.raw } })
      + frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      + frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'one synthetic answer' } })
      + frame('content_block_stop', { index: 0 })
      + frame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 12 } } })
      + frame('message_stop', {}));
    return;
  }
  res.setHeader('content-type', 'application/json');
  const answer = current.adapter === 'responses'
    ? { id: current.name, object: 'response', status: 'completed', model: body.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'one synthetic answer' }] }], usage: current.raw }
    : { id: current.name, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'one synthetic answer' }, finish_reason: 'stop' }], usage: current.raw };
  res.end(JSON.stringify(answer));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
function start() {
  child = spawn(nativeTestBinary, ['--rpc', '--pilot-root', root], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = [];
  createInterface({ input: child.stdout }).on('line', line => pending.shift()?.(JSON.parse(line)));
  rpc = async (method, ...args) => {
    const value = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('RPC timeout ' + method)), 20000); pending.push(reply => { clearTimeout(timer); resolve(reply); }); child.stdin.write(JSON.stringify({ method, args }) + '\n'); });
    assert.equal(value.ok, true, value.error); return value.result;
  };
}
async function stop() { const done = once(child, 'exit'); child.stdin.end(); await done; }
async function sessions() { return (await (await fetch((await rpc('getDashboardUrl')) + 'api/state')).json()).sessions; }
try {
  start(); await rpc('getState'); await stop();
  await mkdir(join(root, 'pricing-cache'));
  await writeFile(join(root, 'pricing-cache/models-dev-pricing.json'), JSON.stringify({ version: 2, rules }));
  start();
  for (current of cases) {
    await rpc('saveProvider', { id: current.name, displayName: current.name, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, bearerToken: 'synthetic-local-only', adapter: current.adapter, codexModel: current.model });
    await rpc('switchClientProvider', { client: 'codex', providerId: current.name });
    const state = await rpc('toggleTracing', true);
    const response = await fetch(state.localBaseUrl + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-id': current.name }, body: JSON.stringify({ model: current.model, input: 'synthetic ' + current.name, stream: !!current.stream }) });
    assert.equal(response.status, 200);
    const raw = await response.text();
    const client = current.stream ? raw.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).find(event => event.type === 'response.completed').response : JSON.parse(raw);
    assert.equal(client.usage.input_tokens, current.input, current.name + ' final client input includes cache exactly once');
    if (current.write !== undefined) assert.equal(client.usage.input_tokens_details.cache_write_tokens, current.write, current.name + ' final consumer sees writes');
    if (current.model === 'fixture-ttl') assert.equal(client.usage.input_tokens_details.cache_write_1h_tokens, 12);
    let session;
    for (let n = 0; n < 100; n++) { session = (await sessions()).find(s => s.clientConversationKey.endsWith(':' + current.name)); if (session) break; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.ok(session, 'actual capture persisted');
    assert.equal(session.traceCount, 1);
    const cost = session.nativeUsage[0].costUsd;
    if (current.cost === null) assert.equal(cost, null); else assert.ok(Math.abs(cost - current.cost) < 1e-12, `${current.name}: ${cost} != ${current.cost}`);
    assert.equal(session.nativeUsage[0].costComplete, current.cost !== null);
    assert.ok(Math.abs(session.nativeUsage[0].knownCostUsd - (current.partial ?? current.cost)) < 1e-12, current.name + ' known parts remain priced');
    const trace = JSON.parse((await readFile(session.jsonlPath, 'utf8')).trim());
    assert.deepEqual(trace.costSnapshot, session.nativeUsage[0], 'LIVE evidence and persisted monetary point agree');
    assert.equal(session.costSnapshotVersion, 1);
    assert.equal(session.usageByModel[current.model].capturedCost.complete, current.cost !== null);
    assert.equal(session.usageByModel[current.model].capturedCost.cost, session.nativeUsage[0].knownCostUsd);
    if (!current.stream) assert.deepEqual(trace.usageEvidence.upstream.raw, current.raw, 'upstream evidence is not the converted client defaults');
    else { assert.equal(trace.usage.cacheCreation5mTokens, 8); assert.equal(trace.usage.outputTokens, 5, 'cumulative SSE output is not summed twice'); }
    assert.equal(trace.usage.inputTotalTokens, 100);
    await rpc('toggleTracing', false);
  }
  const stats = await rpc('getTraceStats');
  assert.equal(stats.total.costComplete, false);
  assert.ok(Math.abs(stats.total.costUsd - cases.reduce((sum, item) => sum + (item.partial ?? item.cost), 0)) < 1e-12, 'partial totals include known components exactly once');
  const oldSession = (await sessions()).find(s => s.clientConversationKey.endsWith(':compatible-additive'));
  const oldRecord = JSON.parse((await readFile(oldSession.jsonlPath, 'utf8')).trim());
  oldRecord.usage = { inputTokens: 0, inputUncachedTokens: 0, inputTotalTokens: 0, outputTokens: 5, totalTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 };
  delete oldRecord.costSnapshot;
  const retainedEvidence = JSON.stringify(oldRecord) + '\n';
  await writeFile(oldSession.jsonlPath, retainedEvidence);
  const indexPath = join(root, 'traces/index.json');
  const oldIndex = JSON.parse(await readFile(indexPath, 'utf8'));
  const oldSummary = oldIndex.sessions.find(s => s.id === oldSession.id);
  oldSummary.usageNormalizationVersion = 1; oldSummary.totalTokens = 5; oldSummary.usageByModel = {}; oldSummary.nativeUsage[0].costUsd = null;
  const beforeRepair = JSON.stringify(oldIndex);
  await writeFile(indexPath, beforeRepair);
  const plan = await rpc('inspectTraceIndexRepair');
  assert.equal(plan.needsRepair, true); assert.ok(plan.usageRefreshFiles.includes(oldSession.jsonlPath));
  const repaired = await rpc('applyTraceIndexRepair', plan.indexSha256);
  assert.equal(await readFile(repaired.backupIndexPath, 'utf8'), beforeRepair, 'the old index is backed up before recalculation');
  assert.equal(await readFile(oldSession.jsonlPath, 'utf8'), retainedEvidence, 'repair does not rewrite or delete original trace evidence');
  const rebuilt = (await sessions()).find(s => s.id === oldSession.id);
  assert.equal(rebuilt.totalTokens, 105);
  assert.equal(rebuilt.usageByModel['fixture-ttl'].cacheRead, 60);
  assert.equal(rebuilt.usageByModel['fixture-ttl'].cacheCreation1h, 12);
  assert.ok(Math.abs(rebuilt.usageByModel['fixture-ttl'].capturedCost.cost - .00007) < 1e-12);
  assert.ok(Math.abs(rebuilt.nativeUsage[0].costUsd - .00007) < 1e-12);
  assert.equal((await rpc('inspectTraceIndexRepair')).needsRepair, false, 'recalculation is repeatable without perpetual repair prompts');
  const before = await sessions(); await stop(); start();
  assert.deepEqual((await sessions()).map(s => [s.id, s.usageByModel, s.nativeUsage]).sort(), before.map(s => [s.id, s.usageByModel, s.nativeUsage]).sort());
  assert.equal(count, cases.length, 'exactly one upstream call per request, no accounting replay');
  console.log(`PASS ${cases.length} actual local billing requests: compatible both shapes/TTL, nested SSE, Responses writes, provider aliases, price applicability, backed-up historical recalculation and restart`);
} finally { if (child?.exitCode === null) await stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
