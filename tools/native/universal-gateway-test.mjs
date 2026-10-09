// Real Rust RPC, local upstream HTTP and disposable client homes. No user credentials.
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { nativeTestBinary, writeCliFixture } from './test-support.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-universal-gateway-'));
const home = join(root, 'client-home');
const paths = { opencode: join(home, '.config/opencode/opencode.jsonc'), 'gemini-cli': join(home, '.gemini/settings.json'), 'qwen-code': join(home, '.qwen/settings.json') };
const original = {
  opencode: '{\n // preserve this comment\n "model": "old/model",\n "theme": "system", // trailing comma and comment\n}\n',
  'gemini-cli': '{"model":{"name":"old-model"},"security":{"auth":{"selectedType":"oauth-personal"}},"ui":{"theme":"Default"}}\n',
  'qwen-code': '{"model":{"name":"old-model"},"telemetry":{"enabled":false}}\n'
};
const envPath = join(home, '.gemini/.env');
const originalEnv = '# existing env\nGEMINI_API_KEY=old-key\nUNCHANGED=yes\n';
async function installFixtures() {
for (const id of Object.keys(paths)) { await mkdir(resolve(paths[id], '..'), { recursive: true }); await writeFile(paths[id], original[id]); }
await writeFile(envPath, originalEnv);
await mkdir(join(home, '.local/bin'), { recursive: true });
for (const id of ['opencode', 'gemini', 'qwen']) await writeCliFixture(join(home, '.local/bin', id), 'process.exit(0);');
}


const calls = [];
const model = 'gpt-4.1';
const usage = { input_tokens: 13, output_tokens: 7, total_tokens: 20, input_tokens_details: { cached_tokens: 4 } };
const reply = 'fixture reply';
const response = body => ({ id: 'resp-fixture', object: 'response', status: 'completed', model: body.model,
  output: [{ id: 'msg-fixture', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] },
    ...(body.tools?.length ? [{ id: 'tool-fixture', type: 'function_call', call_id: 'call-fixture', name: 'lookup', arguments: '{"q":"fixture"}' }] : [])], usage });
let delayedFinish = 0;
const upstream = createServer(async (req, res) => {
  let data = ''; for await (const b of req) data += b;
  const body = data ? JSON.parse(data) : {};
  calls.push({ path: req.url, body, authorization: req.headers.authorization, apiKey: req.headers['x-api-key'] });
  if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: model }] })); return; }
  if (req.url === '/v1/messages/count_tokens') { res.end('{"input_tokens":13}'); return; }
  const v = response(body); let result;
  if (req.url === '/v1/chat/completions') result = { id: 'chat-fixture', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: reply, ...(body.tools?.length ? { tool_calls: [{ id: 'call-fixture', type: 'function', function: { name: 'lookup', arguments: '{"q":"fixture"}' } }] } : {}) }, finish_reason: body.tools?.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20, prompt_tokens_details: { cached_tokens: 4 } } };
  else if (req.url === '/v1/messages') result = { id: 'msg-fixture', type: 'message', model: body.model, role: 'assistant', content: [{ type: 'text', text: reply }, ...(body.tools?.length ? [{ type: 'tool_use', id: 'call-fixture', name: 'lookup', input: { q: 'fixture' } }] : [])], stop_reason: body.tools?.length ? 'tool_use' : 'end_turn', usage: { input_tokens: 9, cache_read_input_tokens: 4, cache_creation_input_tokens: 2, output_tokens: 7 } };
  else if (req.url === '/v1/responses') result = v;
  else { res.writeHead(404); res.end('{}'); return; }
  if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (req.url === '/v1/chat/completions') {
    res.write('data: ' + JSON.stringify({ id: 'chat-fixture', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture ' }, finish_reason: null }] }) + '\n\n');
    setTimeout(() => { delayedFinish++; res.end('data: ' + JSON.stringify({ id: 'chat-fixture', model: body.model, choices: [{ index: 0, delta: { content: 'reply', ...(body.tools?.length ? { tool_calls: result.choices[0].message.tool_calls.map((call, index) => ({ index, ...call })) } : {}) }, finish_reason: result.choices[0].finish_reason }], usage: result.usage }) + '\n\ndata: [DONE]\n\n'); }, 300);
  } else if (req.url === '/v1/responses') {
    res.write('event: response.created\ndata: ' + JSON.stringify({ type: 'response.created', response: { ...v, output: [], usage: null } }) + '\n\n');
    res.write('event: response.output_text.delta\ndata: ' + JSON.stringify({ type: 'response.output_text.delta', response_id: v.id, delta: 'fixture ' }) + '\n\n');
    // Final-only remainder exercises honest stream assembly without duplicate text or lost tools.
    setTimeout(() => { delayedFinish++; res.end(body.metadata?.truncate ? '' : 'event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: v }) + '\n\n'); }, 300);
  } else {
    const events = [{ type: 'message_start', message: { ...result, content: [] } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } }, { type: 'content_block_stop', index: 0 }, ...(body.tools?.length ? [{ type: 'content_block_start', index: 1, content_block: result.content[1] }, { type: 'content_block_stop', index: 1 }] : []), { type: 'message_delta', delta: { stop_reason: result.stop_reason }, usage: result.usage }, { type: 'message_stop' }];
    res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  }
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const base = `http://127.0.0.1:${upstream.address().port}/v1`;
let child;
let pending = [];
function launch() {
  pending = [];
  child = spawn(nativeTestBinary, ['--rpc', '--pilot-root', root], { env: { ...process.env, XWX_CLIENT_INSTALLATIONS_TEST_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] });
  createInterface({ input: child.stdout }).on('line', line => pending.shift()?.(JSON.parse(line)));
}
async function rawRpc(method, ...args) {
  return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(`RPC timeout: ${method}`)), 20000); pending.push(value => { clearTimeout(timer); resolve(value); }); child.stdin.write(JSON.stringify({ method, args }) + '\n'); });
}
async function rpc(method, ...args) { const value = await rawRpc(method, ...args); assert.equal(value.ok, true, value.error); return value.result; }
const checks = [];
function pass(name) { checks.push(name); console.log('PASS ' + name); }
async function select(client, providerId) { const before = await rpc('getClientRoute', client); return rpc('setClientRoute', { client, providerId, model, configDigest: before.configDigest, takeoverConfirmed: true }); }
const tool = { type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } } };
const chat = (stream = false) => ({ model, messages: [{ role: 'system', content: 'fixture system' }, { role: 'user', content: 'fixture prompt' }], tools: [tool], stream });
const gemini = { generationConfig: { topK: 64, thinkingConfig: {includeThoughts: true} }, systemInstruction: { parts: [{ text: 'fixture system' }] }, contents: [{ role: 'user', parts: [{ text: 'fixture prompt' }] }], tools: [{ functionDeclarations: [{ name: 'lookup', parameters: {type:'OBJECT',properties:{q:{type:'STRING'}}} }] }] };
let state;
async function post(client, path, body) { const res = await fetch(state.localBaseUrl + `/clients/${client}` + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-id': 'same-session-every-client' }, body: JSON.stringify(body) }); return res; }
async function records() { const url = await rpc('getDashboardUrl'); const view = await (await fetch(url + 'api/state')).json(); const sessions = await Promise.all(view.sessions.map(s => fetch(url + 'api/session/' + s.id).then(r => r.json()))); return sessions.flatMap(s => s.traces); }
launch();
let frontend;
try {
  assert.equal((await rpc('getProviders')).connections.length, 0);
  assert.equal((await rpc('resumeTracing')).backgroundGatewayActive, false);
  pass('fresh installation has no default API or automatic client edits');
  await installFixtures();
  for (const adapter of ['responses', 'chat-completions', 'anthropic-messages']) await rpc('saveProvider', { id: adapter, displayName: adapter, baseUrl: base, bearerToken: 'fixture-secret-' + adapter, adapter, codexModel: model });
  const providers = (await rpc('getProviders')).connections;
  const ids = Object.fromEntries(providers.map(p => [p.adapter, p.id]));
  const snapshot = await rpc('getClientRoute', 'opencode');
  assert.equal(snapshot.requiresTakeover, true);
  assert.equal((await rawRpc('setClientRoute', { client: 'opencode', providerId: ids.responses, model, configDigest: snapshot.configDigest })).ok, false);
  for (const client of Object.keys(paths)) { await rpc('addModelClient', client); await select(client, ids.responses); }
  state = await rpc('toggleTracing', true);
  const managed = await readFile(paths.opencode, 'utf8');
  assert.match(managed, /preserve this comment/); assert.match(managed, /trailing comma and comment/); assert.match(managed, /\/clients\/opencode\/v1/);
  assert.equal(JSON.parse(await readFile(paths['qwen-code'], 'utf8')).modelProviders.xwx_deck[0].baseUrl, state.localBaseUrl + '/clients/qwen-code/v1');
  assert.match(await readFile(envPath, 'utf8'), /GOOGLE_GEMINI_BASE_URL=http/);
  pass('explicit client takeover preserves JSONC and writes independent OpenCode, Gemini and Qwen endpoints');
  let expectedTokens = 0; let pricedRequests = 0;
  for (const adapter of Object.keys(ids)) {
    await select('opencode', ids[adapter]);
    for (const stream of [false, true]) {
      const before = delayedFinish;
      const res = await post('opencode', '/v1/chat/completions', chat(stream)); if (res.status !== 200) assert.fail(await res.text());
      if (stream) {
        const reader = res.body.getReader(); const first = await reader.read();
        if (adapter !== 'anthropic-messages') assert.equal(delayedFinish, before, 'first chunk must arrive before upstream completion');
        let text = new TextDecoder().decode(first.value); for (;;) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); }
        assert.match(text, /\[DONE\]/); const events = text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
        assert.equal(events.flatMap(e => e.choices ?? []).map(c => c.delta?.content ?? '').join(''), reply);
        assert.equal(events.flatMap(e => e.choices ?? []).flatMap(c => c.delta?.tool_calls ?? []).filter(c => c.id === 'call-fixture').length, 1);
        assert.equal(events.at(-1).usage.prompt_tokens, adapter === 'anthropic-messages' ? 15 : 13);
      } else { const v = await res.json(); assert.equal(v.object, 'chat.completion'); assert.equal(v.choices[0].message.content, reply); assert.equal(v.choices[0].message.tool_calls[0].function.name, 'lookup'); }
      expectedTokens += adapter === 'anthropic-messages' ? 22 : 20;
      if (adapter !== 'anthropic-messages') pricedRequests++;
    }
    await select('gemini-cli', ids[adapter]);
    for (const stream of [false, true]) {
      const res = await post('gemini-cli', `/v1beta/models/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, gemini); if (res.status !== 200) assert.fail(await res.text());
      const values = stream ? (await res.text()).split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6))) : [await res.json()];
      const parts = values.flatMap(v => v.candidates?.[0]?.content?.parts ?? []);
      assert.equal(parts.map(p => p.text ?? '').join(''), reply); assert.equal(parts.filter(p => p.functionCall?.name === 'lookup').length, 1);
      assert.equal(values.at(-1).usageMetadata.totalTokenCount, adapter === 'anthropic-messages' ? 22 : 20);
      expectedTokens += adapter === 'anthropic-messages' ? 22 : 20;
      if (adapter !== 'anthropic-messages') pricedRequests++;
    }
    pass(`Chat and Gemini JSON/SSE → ${adapter}: text, tools, usage and first-chunk delivery`);
  }
  const rows = await records(); assert.equal(rows.length, 12);
  assert.deepEqual(new Set(rows.map(r => r.source)), new Set(['opencode', 'gemini-cli']));
  assert.equal((await rpc('getTraceStats')).total.tokens, expectedTokens);
  for (const r of rows) {
    assert.equal(r.request.path.startsWith(`/clients/${r.source}/`), true); assert.ok(r.normalizedRequest); assert.ok(r.upstream.requestBody);
    assert.equal(r.usageEvidence.upstream.protocol, r.contextChanges.upstreamProtocol);
    assert.equal(JSON.stringify(r).includes('fixture-secret-'), false);
    assert.equal(r.usage.totalTokens, r.contextChanges.upstreamProtocol === 'anthropic-messages' ? 22 : 20);
    for (const event of r.sse?.events ?? []) {
      assert.equal(r.sse.timingBasis, 'relative-upstream-chunk-receipt');
      assert.ok(event.timestampMs >= 0 && event.timestampMs <= r.durationMs, JSON.stringify(event));
    }
  }
  const delayedResponse = rows.find(r => r.contextChanges.upstreamProtocol === 'responses' && r.sse.events.length > 1);
  assert.ok(delayedResponse.sse.events.at(-1).timestampMs - delayedResponse.sse.events[0].timestampMs >= 200);
  // Current built-in gpt-4.1 rates: uncached 2, cached .5, output 8 USD / million.
  const stats = await rpc('getTraceStats');
  const openaiCost = pricedRequests * (9 * 2 + 4 * .5 + 7 * 8) / 1e6;
  assert.ok(stats.total.costUsd >= openaiCost);
  const index = JSON.parse(await readFile(join(root, 'traces/index.json'), 'utf8'));
  const points = index.sessions.flatMap(s => s.nativeUsage).filter(p => p.tokens === 20);
  for (const p of points) assert.ok(Math.abs(p.costUsd - .000076) < 1e-12, JSON.stringify(p));
  pass('Trace source, original/normalized/upstream bodies, cached tokens and current pricing remain accurate without credential leaks');
  await select('opencode', ids['chat-completions']);
  const native = await post('opencode', '/v1/chat/completions', {...chat(), prediction:{type:'content',content:'fixture'}, messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:'fixture',format:'wav'}}]}]}); assert.equal(native.status,200);await native.text();assert.equal(calls.at(-1).body.messages[0].content[0].type,'input_audio');assert.equal(calls.at(-1).body.prediction.content,'fixture');
  await select('cherry-studio', ids.responses);
  const manual = await post('cherry-studio','/v1/responses',{model,input:'manual fixture'});assert.equal(manual.status,200);await manual.text();assert.equal((await records()).at(-1)?.source==='cherry-studio'||(await records()).some(r=>r.source==='cherry-studio'),true);
  const limit = await post('gemini-cli',`/v1beta/models/${model}:generateContent`,{...gemini,generationConfig:{thinkingConfig:{thinkingBudget:8192}}});assert.equal(limit.status,400);
  pass('native Chat preserves audio/custom parameters; manual API clients have independent identities; non-equivalent thinking budgets fail explicitly');
  await select('opencode', ids.responses);
  const res = await post('opencode', '/v1/chat/completions', { ...chat(true), metadata: { truncate: true } }); const truncated = await res.text(); assert.match(truncated, /响应流未完成/); assert.doesNotMatch(truncated, /\[DONE\]/);
  pass('truncated upstream stream cannot fabricate successful completion');
  await select('qwen-code', ids['anthropic-messages']);
  const beforeCount = (await rpc('getTraceStats')).total.tokens;
  const count = await post('qwen-code', '/v1/messages/count_tokens', { model, messages: [{ role: 'user', content: 'count' }] }); assert.equal(count.status, 200); assert.deepEqual(await count.json(), { input_tokens: 13 }); assert.equal((await rpc('getTraceStats')).total.tokens, beforeCount);
  const unavailable = await post('gemini-cli', `/v1beta/models/${model}:countTokens`, gemini); assert.equal(unavailable.status, 501);
  pass('native token-count forwarding works; unsupported counts are explicit and never added to generated usage');
  await select('opencode', ids.responses);
  const continued = await post('opencode', '/v1/chat/completions', {...chat(), n:1, max_tokens:128, reasoning_effort:'low', stream_options:{include_usage:true}, messages:[...chat().messages,{role:'assistant',content:null,tool_calls:[{id:'call-original',type:'function',function:{name:'lookup',arguments:'{"q":"first"}'}}]},{role:'tool',tool_call_id:'call-original',content:'result-first'}]});
  assert.equal(continued.status,200);await continued.text();
  const forwarded = calls.at(-1).body;
  assert.equal(forwarded.max_output_tokens,128);assert.equal(forwarded.reasoning.effort,'low');
  for(const key of ['max_tokens','reasoning_effort','stream_options','n']) assert.equal(Object.hasOwn(forwarded,key),false);
  assert.ok(forwarded.input.some(p=>p.type==='function_call_output'&&p.call_id==='call-original'&&p.output==='result-first'));
  await select('gemini-cli', ids.responses);
  const history = {...gemini,contents:[gemini.contents[0],{role:'model',parts:[{functionCall:{id:'tool-a',name:'lookup',args:{q:'a'}}}]},{role:'user',parts:[{functionResponse:{id:'tool-a',name:'lookup',response:{result:'a'}}}]},{role:'model',parts:[{functionCall:{name:'lookup',args:{q:'b'}}}]},{role:'user',parts:[{functionResponse:{name:'lookup',response:{result:'b'}}}]}]};
  const continuedGemini = await post('gemini-cli',`/v1beta/models/${model}:generateContent`,history);assert.equal(continuedGemini.status,200);await continuedGemini.text();
  const outputs=calls.at(-1).body.input.filter(p=>p.type==='function_call_output');
  assert.deepEqual(outputs.map(p=>p.call_id),['tool-a','gemini-call-2']);
  const badHistory=structuredClone(history);badHistory.contents[2].parts[0].functionResponse.id='wrong-id';
  assert.equal((await post('gemini-cli',`/v1beta/models/${model}:generateContent`,badHistory)).status,400);
  pass('Chat generation options map once and tool continuations preserve call/result identities in Chat and Gemini');
  const beforeHold = calls.length;
  const held = await post('opencode', '/v1/chat/completions', chat(true));
  await select('opencode', ids['chat-completions']);
  assert.match(await held.text(), /\[DONE\]/); assert.equal(calls[beforeHold].path, '/v1/responses');
  const changed = await post('opencode', '/v1/chat/completions', chat()); await changed.text(); assert.equal(calls.at(-1).path, '/v1/chat/completions');
  pass('provider switching keeps in-flight replies and routes the next request to the new provider');
  const liveConfig = await readFile(paths.opencode, 'utf8');
  await writeFile(paths.opencode, liveConfig.replace('xwx_deck/gpt-4.1', 'external/new-model'));
  const failed = await rawRpc('toggleTracing', false); assert.equal(failed.ok, false); assert.match(failed.error, /外部修改/); assert.equal((await rpc('getState')).backgroundGatewayActive, true);
  await writeFile(paths.opencode, liveConfig.replace('"theme": "system"', '"theme": "dark"'));
  await rpc('toggleTracing', false); assert.match(await readFile(paths.opencode, 'utf8'), /"theme": "dark"/); assert.doesNotMatch(await readFile(paths.opencode, 'utf8'), /xwx_deck/);
  assert.equal(await readFile(envPath, 'utf8'), originalEnv); assert.equal(await readFile(paths['qwen-code'], 'utf8'), original['qwen-code']);
  assert.equal((await rpc('resumeTracing')).backgroundGatewayActive, false);
  pass('stop restores owned connections, preserves unrelated changes, and refuses conflicting external writes');
  await select('opencode', ids['chat-completions']); state = await rpc('toggleTracing', true);
  child.kill('SIGKILL'); await once(child, 'exit'); launch();
  assert.match(await readFile(paths.opencode, 'utf8').catch(() => ''), /model/);
  const route = await rpc('getClientRoute', 'opencode'); assert.equal(route.providerId, ids['chat-completions']);
  assert.doesNotMatch(await readFile(paths.opencode, 'utf8'), /xwx_deck/);
  state = await rpc('resumeTracing'); assert.equal(state.backgroundGatewayActive, true);
  await rpc('toggleClient', 'qwen-code'); assert.equal((await rpc('getClientRoute', 'qwen-code')).enabled, false);
  assert.equal(await readFile(paths['qwen-code'], 'utf8'), original['qwen-code']);
  assert.equal((await post('qwen-code', '/v1/responses', { model, input: 'disabled' })).status, 404);
  pass('crash recovery restores configurations, remembers routes, resumes Trace and independently disables a client');
  await rpc('toggleTracing', false);
  const latest = await rpc('getClientRoute', 'opencode'); await writeFile(paths.opencode, original.opencode);
  assert.equal((await rawRpc('setClientRoute', { client: 'opencode', providerId: ids.responses, model, configDigest: latest.configDigest, takeoverConfirmed: true })).ok, false);
  await writeFile(paths.opencode, '{"model":"a","model":"b"}'); assert.equal((await rawRpc('getClientRoute', 'opencode')).ok, false);
  await writeFile(paths.opencode, original.opencode);
  pass('stale takeover previews and ambiguous duplicate JSON keys are rejected without overwriting files');
  await select('opencode', ids.responses);
  const executable = join(home, '.local/bin/opencode');
  await rename(executable, executable + '.not-installed');
  state = await rpc('toggleTracing', true);
  const skipped = state.clients.find(c => c.id === 'opencode');
  assert.equal(skipped.status, 'skipped'); assert.equal(skipped.statusText, '未接管');
  assert.equal(await readFile(paths.opencode, 'utf8'), original.opencode);
  assert.equal(state.clients.find(c => c.id === 'cherry-studio').statusText, '入口已就绪');
  await rpc('toggleTracing', false); await rename(executable + '.not-installed', executable);
  const v2 = JSON.stringify({$schema:'https://opencode.ai/v2/config.json',providers:{existing:{settings:{baseURL:'https://example.test/v1'}}},model:'existing/old'});
  await writeFile(paths.opencode, v2); await select('opencode', ids.responses);
  state = await rpc('toggleTracing', true);
  const v2Managed = JSON.parse(await readFile(paths.opencode, 'utf8'));
  assert.equal(v2Managed.providers.xwx_deck.package, '@opencode/ai/providers/openai-compatible');
  assert.equal(v2Managed.providers.existing.settings.baseURL, 'https://example.test/v1');
  await rpc('toggleTracing', false); assert.equal(await readFile(paths.opencode, 'utf8'), v2);
  await writeFile(paths.opencode, original.opencode);
  pass('uninstalled clients are not reported as captured; manual endpoints report readiness; OpenCode v2 restores exactly');
  console.log(JSON.stringify({ passed: true, checks, sandbox: root, requests: calls.length }));
  if (process.env.XWX_GATEWAY_QA === '1') {
    await select('opencode', ids.responses); await select('gemini-cli', ids['chat-completions']); state = await rpc('toggleTracing', true);
    const directory = resolve(import.meta.dirname, '../../test-results/native-frontend');
    frontend = createServer(async (req, res) => {
      try {
        if (req.url === '/rpc') { let data = ''; for await (const b of req) data += b; const { method, args } = JSON.parse(data); const value = method === 'getWindowState' ? { ok: true, result: { nativeFrame: true, maximized: false, fullscreen: false } } : await rawRpc(method, ...args); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); return; }
        const path = resolve(directory, '.' + new URL(req.url, 'http://localhost').pathname); if (!path.startsWith(directory + '/') && path !== directory) { res.writeHead(403); res.end(); return; }
        let content = await readFile(path === directory ? join(directory, 'index.html') : path); if (req.url === '/') content = Buffer.from(content.toString().replace('<script src="./pilot-bridge.js">', '<script>window.__TAURI__={core:{invoke:async(_,v)=>{const r=await fetch("/rpc",{method:"POST",body:JSON.stringify(v)});const j=await r.json();if(!j.ok)throw Error(j.error);return j.result}},event:{listen:async()=>()=>{}}};</script><script src="./pilot-bridge.js">'));
        res.setHeader('content-type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' })[extname(path)] ?? (req.url === '/' ? 'text/html' : 'application/octet-stream')); res.end(content);
      } catch (error) { res.writeHead(500); res.end(String(error)); }
    });
    frontend.listen(0, '127.0.0.1'); await once(frontend, 'listening');
    console.log(JSON.stringify({ qaUrl: `http://127.0.0.1:${frontend.address().port}/`, dashboard: await rpc('getDashboardUrl'), sandbox: root }));
    await new Promise(resolve => { process.once('SIGTERM',resolve); process.once('SIGINT',resolve); });
  }
} finally {
  if (child.exitCode === null) { await rawRpc('toggleTracing', false).catch(() => undefined); child.stdin.end(); await once(child, 'exit'); }
  frontend?.close(); await new Promise(resolve => upstream.close(resolve));
}
