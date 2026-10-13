// Actual local HTTP wire bytes, Rust RPC and disposable homes; no platform login.
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeTestBinary } from './test-support.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'xwxdeck-client-evidence-'));
const secret = 'local-evidence-fixture-credential';
const attempts = [];
const upstream = createServer(async (req, res) => {
  let data = ''; for await (const chunk of req) data += chunk;
  const body = JSON.parse(data);
  const marker = data.match(/case-([a-z-]+)/)?.[1] ?? 'normal';
  const call = { path: req.url, marker, raw: '' }; attempts.push(call);
  const send = bytes => { call.raw += bytes; res.write(bytes); };
  if (marker === 'http-error') { res.writeHead(429, { 'content-type': 'application/json' }); send('{"error":{"message":"fixture refused"}}'); res.end(); return; }
  const chat = req.url.endsWith('/chat/completions');
  const value = chat
    ? { id: 'chat-evidence', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'visible fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 } }
    : { id: 'msg-evidence', type: 'message', model: body.model, role: 'assistant', content: [{ type: 'text', text: 'visible fixture' }], stop_reason: 'end_turn', usage: { input_tokens: 13, output_tokens: 7 } };
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); send(marker === 'invalid-json' ? '{broken fixture' : JSON.stringify(value)); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (chat) send('data: ' + JSON.stringify({ id: value.id, model: body.model, choices: [{ index: 0, delta: { content: 'visible fixture' }, finish_reason: null }] }) + '\n\n');
  else for (const event of [{ type: 'message_start', message: { ...value, content: [] } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'visible fixture' } }]) send(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  if (marker === 'held') { await once(res, 'close'); return; }
  await delay(70);
  if (res.destroyed) return;
  if (marker === 'socket-close') { res.destroy(); return; }
  if (marker === 'truncated') { res.end(); return; }
  if (marker === 'stream-error') { send('event: error\ndata: {"type":"error","error":{"message":"fixture stream failure"}}\n\n'); res.end(); return; }
  if (chat) send('data: ' + JSON.stringify({ id: value.id, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: value.usage }) + '\n\ndata: [DONE]\n\n');
  else for (const event of [{ type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: value.usage }, { type: 'message_stop' }]) send(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
const child = spawn(nativeTestBinary, ['--rpc', '--pilot-root', root], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = []; createInterface({ input: child.stdout }).on('line', line => pending.shift()?.(JSON.parse(line)));
async function rpc(method, ...args) {
  const value = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(`RPC timeout: ${method}`)), 20000); pending.push(value => { clearTimeout(timer); resolve(value); }); child.stdin.write(JSON.stringify({ method, args }) + '\n'); });
  assert.equal(value.ok, true, value.error); return value.result;
}
let state; let serial = 0;
const checks = [];
async function records() {
  const url = await rpc('getDashboardUrl'); const view = await (await fetch(url + 'api/state')).json();
  return (await Promise.all(view.sessions.map(s => fetch(url + 'api/session/' + s.id).then(r => r.json())))).flatMap(s => s.traces);
}
async function recordFor(session) {
  for (let n = 0; n < 60; n++) { const found = (await records()).filter(r => r.clientConversationKey.endsWith(':' + session)); if (found.length) { assert.equal(found.length, 1, 'one capture per request'); return found[0]; } await delay(20); }
  assert.fail('request evidence did not persist');
}
async function select(adapter, client) {
  if (state) await rpc('toggleTracing', false);
  const name = 'Evidence_' + adapter.replaceAll('-', '_');
  const existing = (await rpc('getProviders')).connections.find(p => p.displayName === name);
  await rpc('saveProvider', { ...(existing ? { id: existing.id } : {}), displayName: name, baseUrl, bearerToken: secret, adapter, codexModel: 'fixture-model' });
  const provider = (await rpc('getProviders')).connections.find(p => p.displayName === name);
  await rpc('switchClientProvider', { client, providerId: provider.id });
  if (client === 'claude') await rpc('updateClaudeModels', { sonnet: 'fixture-model' });
  state = await rpc('toggleTracing', true);
}
async function run(api, mode, streaming = true, passthrough = false) {
  const session = `evidence-${++serial}`; const prompt = `case-${mode}`;
  const path = { responses: '/v1/responses', messages: '/v1/messages', chat: '/v1/chat/completions', gemini: `/v1beta/models/fixture-model:${streaming ? 'streamGenerateContent' : 'generateContent'}` }[api];
  const body = api === 'gemini' ? { contents: [{ role: 'user', parts: [{ text: prompt }] }] }
    : api === 'responses' ? { model: 'fixture-model', input: prompt, stream: streaming }
    : { model: api === 'messages' ? 'sonnet' : 'fixture-model', messages: [{ role: 'user', content: prompt }], max_tokens: 32, stream: streaming };
  const before = attempts.length;
  const response = await fetch(state.localBaseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-id': session }, body: JSON.stringify(body) });
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let raw = ''; let streamFailed = false;
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; raw += decoder.decode(chunk.value, { stream: true }); } } catch { streamFailed = true; }
  raw += decoder.decode();
  const record = await recordFor(session);
  assert.equal(attempts.length, before + 1, 'no replay after client output');
  assert.equal(record.response.statusCode, response.status, `${api}/${mode}: actual client HTTP status`);
  assert.equal(record.response.rawBody, raw, `${api}/${mode}: final client wire bytes`);
  assert.equal(record.upstream.rawBody, attempts.at(-1).raw, `${api}/${mode}: separate upstream wire bytes`);
  assert.equal(record.response.headers['content-type'], response.headers.get('content-type'));
  assert.ok(!JSON.stringify(record).includes(secret), 'credential excluded');
  if (mode === 'normal') { assert.equal(record.usage.totalTokens, 20); assert.equal(record.error, undefined); }
  else if (streaming && mode !== 'http-error') {
    if (passthrough && mode === 'socket-close') assert.equal(streamFailed, true);
    else if (!passthrough || mode === 'stream-error') assert.match(raw, /error|failed|未完成|中断/);
    assert.ok(record.error, 'incomplete stream remains explicit');
  }
  checks.push(`${api}/${mode}/${streaming ? 'SSE' : 'JSON'}${passthrough ? '/native' : ''}`); console.log('PASS ' + checks.at(-1));
}
async function interrupted(stopGateway) {
  const session = `evidence-${++serial}`; const before = attempts.length;
  const response = await fetch(state.localBaseUrl + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-id': session }, body: JSON.stringify({ model: 'fixture-model', input: 'case-held', stream: true }) });
  const reader = response.body.getReader(); let raw = '';
  while (!raw.includes('visible fixture')) { const chunk = await reader.read(); assert.equal(chunk.done, false); raw += new TextDecoder().decode(chunk.value); }
  if (stopGateway) {
    const remaining = (async () => { for (;;) { const chunk = await reader.read(); if (chunk.done) break; raw += new TextDecoder().decode(chunk.value); } })();
    await rpc('toggleTracing', false, true); await remaining;
    assert.match(raw, /Gateway 已停止/);
    assert.equal((await rpc('getState')).backgroundGatewayActive, false);
    assert.doesNotMatch(await readFile(join(root, 'codex/config.toml'), 'utf8'), /127\.0\.0\.1:4423[3-9]|127\.0\.0\.1:4424[0-2]/);
  } else await reader.cancel();
  const record = await recordFor(session);
  assert.equal(attempts.length, before + 1);
  assert.ok(record.response.rawBody.startsWith(raw), 'Gateway output contains the client-consumed prefix');
  if (stopGateway) assert.equal(record.response.rawBody, raw);
  else assert.equal(record.response.bodyEnded, false);
  assert.equal(record.response.captureBoundary, 'gateway-http-body');
  assert.ok(record.error); assert.equal(record.usage.totalTokens, undefined);
  checks.push(stopGateway ? 'Trace stop captures final cancellation and restores direct route' : 'client cancel preserves output prefix without replay');
  console.log('PASS ' + checks.at(-1));
}
try {
  await select('chat-completions', 'codex');
  await run('responses', 'stream-error'); // Baseline reproducer: converted error currently substitutes upstream bytes.
  for (const mode of ['normal', 'truncated', 'socket-close', 'http-error']) await run('responses', mode);
  await run('responses', 'normal', false); await run('responses', 'invalid-json', false);
  await select('chat-completions', 'claude');
  for (const mode of ['normal', 'stream-error', 'truncated', 'socket-close']) await run('messages', mode);
  await run('messages', 'normal', false);
  await select('anthropic-messages', 'codex');
  for (const api of ['chat', 'gemini']) { for (const mode of ['normal', 'stream-error', 'truncated', 'socket-close']) await run(api, mode); await run(api, 'normal', false); }
  await select('anthropic-messages', 'claude');
  for (const mode of ['normal', 'stream-error', 'truncated', 'socket-close']) await run('messages', mode, true, true);
  await run('messages', 'normal', false, true); await run('messages', 'invalid-json', false, true);
  await select('chat-completions', 'codex');
  await interrupted(false); await interrupted(true);
  await rpc('toggleTracing', false);
  const index = JSON.parse(await readFile(join(root, 'traces/index.json'), 'utf8'));
  assert.equal(index.sessions.reduce((n, s) => n + s.traceCount, 0), checks.length);
  assert.equal(index.sessions.reduce((n, s) => n + s.totalTokens, 0), 10 * 20, 'usage counted once for complete and upstream-declared usage only');
  child.stdin.end(); const [code] = await once(child, 'exit'); assert.equal(code, 0);
  console.log(JSON.stringify({ passed: true, checks, requests: attempts.length, isolatedFixtures: true }));
} finally {
  if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  await rm(root, { recursive: true, force: true });
}
