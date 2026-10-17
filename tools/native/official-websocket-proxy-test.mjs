import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { nativeTestBinary } from './test-support.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-official-ws-proxy-'));
const proxy = createServer((req, res) => { res.writeHead(502); res.end(); });
const wss = new WebSocketServer({ noServer: true });
const requests = [];
let invalid = false, child, queue = [];
proxy.on('upgrade', (req, socket, head) => {
  requests.push({ path: req.url, auth: req.headers.authorization });
  if (invalid) {
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: invalid\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => ws.on('message', raw => {
    const body = JSON.parse(raw.toString());
    ws.send(JSON.stringify({ type: 'response.completed', response: { id: 'proxy-fixture', status: 'completed', model: body.model, output: [], usage: { input_tokens: 1, output_tokens: 1 } } }));
  }));
});
proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
const endpoint = `http://127.0.0.1:${proxy.address().port}`;
const rpc = (method, ...args) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error(method + ' timeout')), 15000);
  queue.push(value => { clearTimeout(timer); value.ok ? resolve(value.result) : reject(Error(value.error)); });
  child.stdin.write(JSON.stringify({ method, args }) + '\n');
});
try {
  child = spawn(nativeTestBinary, ['--rpc', '--pilot-root', root], { env: { ...process.env, HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint, ALL_PROXY: endpoint, http_proxy: endpoint, https_proxy: endpoint, all_proxy: endpoint, NO_PROXY: '', no_proxy: '' }, stdio: ['pipe', 'pipe', 'inherit'] });
  createInterface({ input: child.stdout }).on('line', line => queue.shift()?.(JSON.parse(line)));
  await rpc('getState');
  await mkdir(join(root, 'codex'), { recursive: true });
  const config = 'model_provider="openai"\nmodel="proxy-model"\nchatgpt_base_url="http://unresolvable-upstream.invalid/backend-api"\n';
  const auth = JSON.stringify({ tokens: { access_token: 'SYNTHETIC-OLD-OAUTH' } });
  await writeFile(join(root, 'codex/config.toml'), config);
  await writeFile(join(root, 'codex/auth.json'), auth);
  const state = await rpc('toggleTracing', true);
  const url = state.localBaseUrl.replace('http:', 'ws:') + '/responses?proxy=1';
  const ws = new WebSocket(url, { headers: { authorization: 'Bearer SYNTHETIC-REFRESHED-OAUTH' } });
  await once(ws, 'open');
  const complete = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'response.create', model: 'proxy-model', input: 'local proxy fixture' }));
  assert.equal(JSON.parse((await complete)[0].toString()).type, 'response.completed');
  assert.equal(requests[0].path, 'http://unresolvable-upstream.invalid/backend-api/codex/responses?proxy=1');
  assert.equal(requests[0].auth, 'Bearer SYNTHETIC-REFRESHED-OAUTH');
  const closed = once(ws, 'close'); await rpc('toggleTracing', false); await closed;
  assert.equal(await readFile(join(root, 'codex/config.toml'), 'utf8'), config);
  assert.equal(await readFile(join(root, 'codex/auth.json'), 'utf8'), auth);
  console.log('PASS official WebSocket uses the configured HTTP proxy, preserves path/query/refreshed auth, and restores direct configuration');
  invalid = true; await rpc('toggleTracing', true);
  const rejected = new WebSocket((await rpc('getState')).localBaseUrl.replace('http:', 'ws:') + '/responses?proxy=1', {handshakeTimeout:10000});
  const status = await new Promise((resolve, reject) => {
    rejected.once('open', () => reject(Error('Invalid upstream handshake accepted')));
    rejected.once('unexpected-response', (_req, res) => { res.resume(); rejected.terminate(); resolve(res.statusCode); });
    rejected.once('error', reject);
  });
  assert.equal(status, 502); await rpc('toggleTracing', false);
  console.log('PASS invalid upstream WebSocket acceptance key is rejected before client upgrade');
  await writeFile(join(root, 'codex/config.toml'), 'model_provider="openai"\nmodel="proxy-model"\nchatgpt_base_url="https://chatgpt.com/backend-api"\n');
  await rpc('toggleTracing',true); const before=requests.length;
  const subscriptionWs=new WebSocket((await rpc('getState')).localBaseUrl.replace('http:','ws:')+'/responses');
  const negotiation=await new Promise((resolve,reject)=>{subscriptionWs.once('open',()=>reject(Error('Official subscription accepted WS before HTTP negotiation')));subscriptionWs.once('unexpected-response',(_req,res)=>{res.resume();subscriptionWs.terminate();resolve(res.statusCode)});subscriptionWs.on('error',()=>{});});
  assert.equal(negotiation,426);assert.equal(requests.length,before,'no upstream connection or generation before HTTP negotiation');await rpc('toggleTracing',false);
  console.log('PASS official ChatGPT subscription negotiates HTTP before any upstream generation while custom OAuth retains WS');
  const exit = once(child, 'exit'); child.stdin.end(); assert.equal((await exit)[0], 0);
} finally {
  if (child?.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
  for (const ws of wss.clients) ws.terminate();
  await new Promise(resolve => proxy.close(resolve)); wss.close();
  await rm(root, { recursive: true, force: true });
}
