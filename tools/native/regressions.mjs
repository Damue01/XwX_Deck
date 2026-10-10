import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { once } from 'node:events';

import {nativeTestBinary as binary} from './test-support.mjs';
// macOS tmpdir can be /var, whose physical path is /private/var.
const { realpath } = await import('node:fs/promises');
const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-rust-pilot-regression-'));
const checks = [];
const requests = [];
let catalogOnline = true;
const upstream = createServer(async (req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(catalogOnline ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(catalogOnline ? { data: [{ id: 'pilot-model' }] } : { error: 'offline' })); return;
  }
  let body = ''; for await (const chunk of req) body += chunk;
  requests.push({ path: req.url, auth: req.headers.authorization, clientHeader: req.headers['x-client-test'], apiKey: req.headers['x-api-key'], body: JSON.parse(body) });
  if (JSON.parse(body).stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream-test': 'native-rust' });
    res.write('event: response.output_text.delta\ndata: {"delta":"first"}\n\n');
    setTimeout(() => { res.write('event: response.completed\ndata: {"type":"response.completed"}\n\n'); res.end(); }, 180);
  } else {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'resp-pilot', output: 'native Rust response' }));
  }
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const base = `http://127.0.0.1:${upstream.address().port}/v1`;
let child, queue;
function start() {
  child = spawn(binary, ['--rpc', '--pilot-root', root], { stdio: ['pipe', 'pipe', 'pipe'] });
  queue = [];
  createInterface({ input: child.stdout }).on('line', line => { const next = queue.shift(); if (next) next(JSON.parse(line)); });
  child.stderr.on('data', data => process.stderr.write(data));
}
function call(method, ...args) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC timeout ${method}`)), 20_000);
    queue.push(value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(JSON.stringify({ method, args }) + '\n');
  });
}
async function rpc(method, ...args) { const value = await call(method, ...args); assert.equal(value.ok, true, value.error); return value.result; }
async function stopProcess() { const finished = once(child, 'exit'); child.stdin.end(); const [code] = await finished; assert.equal(code, 0); }
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
start();
try {
  assert.deepEqual((await rpc('getProviders')).connections, []);
  const initial = await rpc('getState'); assert.equal(initial.traceWarningGB, 1); assert.equal(initial.traceAutoCleanup, true); pass('empty registry and 1 GB automatic cleanup defaults');
  await rpc('saveProvider', { displayName: 'Local_Test', baseUrl: base, bearerToken: 'pilot-test-key', adapter: 'responses', codexModel: 'pilot-model' });
  await rpc('switchClientProvider', { client: 'codex', providerId: 'Local_Test' });
  const configPath = join(root, 'codex/config.toml');
  const original = await readFile(configPath, 'utf8');
  assert.ok(original.includes(base)); assert.ok(!original.includes('127.0.0.1:452')); pass('real isolated direct client configuration');
  assert.equal((await rpc('fetchProviderModels', { providerId: 'Local_Test' }))[0].id, 'pilot-model');
  catalogOnline = false;
  const failedCatalog = await call('fetchProviderModels', { providerId: 'Local_Test' }); assert.equal(failedCatalog.ok, true); assert.equal(failedCatalog.result[0].id, 'pilot-model');
  await rpc('updateCodexConfig', { expectedProviderId: 'Local_Test', compatibleModel: 'retained-not-in-catalog' });
  assert.equal((await rpc('getCodexConfig')).compatible.model, 'retained-not-in-catalog');
  assert.equal((await rpc('getProviders')).selected.codex, 'Local_Test'); pass('offline catalog does not block local model choice or replace it');
  await rpc('setTheme', 'night'); await rpc('setTraceStoragePolicy', { limitGB: 0.25, autoCleanup: false });
  await stopProcess(); start();
  assert.equal((await rpc('getState')).theme, 'night'); assert.equal((await rpc('getState')).traceWarningGB, 0.25); assert.equal((await rpc('getState')).traceAutoCleanup, false);
  assert.equal((await rpc('getCodexConfig')).compatible.model, 'retained-not-in-catalog'); pass('restart preserves explicit model, theme and storage policy');
  const running = await rpc('toggleTracing', true); const url = running.localBaseUrl;
  assert.ok((await readFile(configPath, 'utf8')).includes(url));
  const request = { model: 'retained-not-in-catalog', input: 'local fixture only' };
  const response = await fetch(url + '/v1/responses?test=1', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-downstream-key', 'x-client-test': 'kept' }, body: JSON.stringify(request) });
  assert.equal(response.status, 200); assert.equal((await response.json()).id, 'resp-pilot');
  assert.equal(requests[0].path, '/v1/responses?test=1'); assert.equal(requests[0].auth, 'Bearer pilot-test-key'); assert.equal(requests[0].clientHeader, 'kept'); assert.deepEqual(requests[0].body, request); pass('real POST round trip with correct upstream URL, auth and payload');
  const sse = await fetch(url + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request, stream: true }) });
  assert.equal(sse.headers.get('content-type'), 'text/event-stream'); assert.equal(sse.headers.get('x-upstream-test'), 'native-rust');
  const reader = sse.body.getReader(); const startAt = Date.now();
  const first = await reader.read(); assert.ok(new TextDecoder().decode(first.value).includes('first')); assert.ok(Date.now() - startAt < 150, 'SSE must arrive before upstream completion');
  let rest='';for (;;) { const part=await reader.read();if(part.done)break;rest+=new TextDecoder().decode(part.value); } assert.ok(rest.includes('response.completed')); pass('SSE streams incrementally without buffering the full response');
  assert.equal((await rpc('getState')).traces, 2); pass('native request metadata count');
  const managed = await readFile(configPath, 'utf8');
  await writeFile(configPath, 'unrelated_user_setting = "keep-me"\n' + managed);
  const stopped = await rpc('toggleTracing', false); assert.equal(stopped.backgroundGatewayActive, false);
  const restored = await readFile(configPath, 'utf8'); assert.ok(restored.includes(base)); assert.ok(restored.includes('keep-me')); assert.ok(!restored.includes(url));
  await assert.rejects(fetch(url + '/v1/responses', { method: 'POST', body: '{}' })); pass('stop preserves unrelated external edits, restores direct route and closes local port');
  const restarted = await rpc('toggleTracing', true);
  const current = await readFile(configPath, 'utf8');
  await writeFile(configPath, current.replace('model_provider = "xwx_deck"', 'model_provider = "external_user_choice"'));
  const conflict = await call('toggleTracing', false); assert.equal(conflict.ok, false); assert.ok(conflict.error.includes('外部配置变化'));
  assert.equal((await rpc('getState')).backgroundGatewayActive, true); assert.ok((await readFile(configPath, 'utf8')).includes('external_user_choice')); pass('conflicting external edits are preserved and keep Gateway alive');
  await writeFile(configPath, current); await rpc('toggleTracing', false);
  await rpc('saveProvider', { displayName: 'Claude_Test', baseUrl: base, bearerToken: 'claude-test-key', adapter: 'anthropic-messages' });
  await rpc('switchClientProvider', { client: 'claude', providerId: 'Claude_Test' });
  await rpc('updateClaudeModels', { expectedProviderId: 'Claude_Test', sonnet: 'claude-test-model', opus: 'retained-offline' });
  assert.equal((await rpc('getProviders')).selected.codex,'Local_Test');
  assert.equal((await rpc('getProviders')).selected.claude,'Claude_Test');
  const claudePath=join(root,'claude/settings.json');
  const directClaude=JSON.parse(await readFile(claudePath,'utf8'));assert.equal(directClaude.env.ANTHROPIC_DEFAULT_SONNET_MODEL,'claude-test-model');
  pass('independent Claude and Codex selections, persistent Claude model mapping');
  const both=await rpc('toggleTracing',true);
  const claudeResponse=await fetch(both.localBaseUrl+'/v1/messages?beta=1',{method:'POST',headers:{'content-type':'application/json','x-api-key':'wrong-downstream-key','anthropic-version':'2023-06-01'},body:JSON.stringify({model:'sonnet',messages:[{role:'user',content:'local fixture'}],max_tokens:8})});
  assert.equal(claudeResponse.status,200);await claudeResponse.json();
  const claudeRequest=requests.at(-1);assert.equal(claudeRequest.auth,'Bearer claude-test-key');assert.equal(claudeRequest.apiKey,'claude-test-key');assert.equal(claudeRequest.path,'/v1/messages?beta=1');assert.equal(claudeRequest.body.model,'claude-test-model');
  pass('real Claude Messages request, model alias and isolated upstream credentials');
  const managedClaude=JSON.parse(await readFile(claudePath,'utf8'));managedClaude.unrelated='preserved';
  await writeFile(claudePath,JSON.stringify(managedClaude));
  await rpc('toggleTracing',false);const restoredClaude=JSON.parse(await readFile(claudePath,'utf8'));assert.equal(restoredClaude.unrelated,'preserved');assert.equal(restoredClaude.env.ANTHROPIC_BASE_URL,directClaude.env.ANTHROPIC_BASE_URL);
  pass('two-client stop restores both direct routes and retains external Claude fields');
  await rpc('toggleTracing',true);const goodClaude=await readFile(claudePath,'utf8');const conflictClaude=JSON.parse(goodClaude);conflictClaude.env.ANTHROPIC_AUTH_TOKEN='external-choice';await writeFile(claudePath,JSON.stringify(conflictClaude));
  assert.equal((await call('toggleTracing',false)).ok,false);assert.equal((await rpc('getState')).backgroundGatewayActive,true);assert.equal(JSON.parse(await readFile(claudePath,'utf8')).env.ANTHROPIC_AUTH_TOKEN,'external-choice');
  await writeFile(claudePath,goodClaude);await rpc('toggleTracing',false);pass('Claude managed-field conflict keeps both Gateway and external changes');
  await rpc('switchClientProvider',{client:'codex',providerId:null});await rpc('toggleClient','codex-cli');const officialBefore=await readFile(configPath,'utf8');const claudeOnly=await rpc('toggleTracing',true);assert.equal(await readFile(configPath,'utf8'),officialBefore);await rpc('toggleTracing',false);assert.equal(await readFile(configPath,'utf8'),officialBefore);pass('Claude-only capture never modifies the disabled Codex configuration');await rpc('toggleClient','codex-cli');
  await rpc('switchClientProvider',{client:'claude',providerId:null});assert.equal((await rpc('getModelServices')).claude,false);assert.equal(JSON.parse(await readFile(claudePath,'utf8')).env?.ANTHROPIC_BASE_URL,undefined);pass('switching Claude back to official restores the original managed fields');
  await rpc('switchClientProvider',{client:'codex',providerId:'Local_Test'});const crash=await rpc('toggleTracing',true);const exited=once(child,'exit');child.kill('SIGKILL');await exited;start();assert.equal((await rpc('getState')).backgroundGatewayActive,false);assert.ok((await readFile(configPath,'utf8')).includes(base));assert.ok(!(await readFile(configPath,'utf8')).includes(crash.localBaseUrl));pass('process crash releases OS lock; reopening restores direct config from durable journal');
  assert.equal((await call('downloadUpdate')).ok, false); assert.equal((await call('queryCodexConversations', {})).ok, false); pass('unmigrated operations and removed tools report errors');
  await stopProcess();
  console.log(JSON.stringify({ passed: true, checks, sandbox: root, upstreamRequestCount: requests.length }));
} finally {
  if (child && child.exitCode === null) { child.stdin.end(); child.kill(); }
  await new Promise(resolve => upstream.close(resolve));
}
