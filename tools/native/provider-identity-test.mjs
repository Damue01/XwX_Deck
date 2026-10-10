import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { nativeTestBinary } from './test-support.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-provider-identity-'));
const requests = [];
const server = createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk;
  const body = JSON.parse(text);
  requests.push({ model: body.model, key: req.headers.authorization });
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: 'fixture-response', object: 'response', model: body.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture' }] }], usage: { input_tokens: 1, output_tokens: 1 } }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
let child; let queue = [];
function start() {
  child = spawn(nativeTestBinary, ['--rpc', '--pilot-root', root]); queue = [];
  createInterface({ input: child.stdout }).on('line', line => queue.shift()?.(JSON.parse(line)));
  child.stderr.on('data', data => process.stderr.write(data));
}
function rpc(method, ...args) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`RPC timeout: ${method}`)), 15000);
    queue.push(value => { clearTimeout(timer); value.ok ? resolve(value.result) : reject(Error(value.error)); });
    child.stdin.write(JSON.stringify({ method, args }) + '\n');
  });
}
async function stop() { const exited = once(child, 'exit'); child.stdin.end(); assert.equal((await exited)[0], 0); }
const input = (name, type, key) => ({ displayName: name, providerPreset: type, baseUrl, bearerToken: key, adapter: 'responses', codexModel: `model-${key}` });
try {
  start();
  for (const [name, type, key] of [['Custom', 'custom', 'custom-a'], ['Custom-2', 'custom', 'custom-b'], ['DeepSeek', 'deepseek', 'deepseek-a'], ['DeepSeek-2', 'deepseek', 'deepseek-b']]) await rpc('saveProvider', input(name, type, key));
  const original = await rpc('getProviders');
  assert.equal(new Set(original.connections.map(p => p.id)).size, 4);
  const first = original.connections.find(p => p.displayName === 'Custom');
  const renamed = await rpc('saveProvider', { ...first, displayName: 'Relay', adapter: first.adapter });
  assert.equal(renamed.connections.find(p => p.displayName === 'Relay').id, first.id);
  assert.deepEqual(renamed.connections.map(p => p.id), original.connections.map(p => p.id));
  const reused = await rpc('saveProvider', input('Custom', 'custom', 'custom-c'));
  const replacement = reused.connections.find(p => p.displayName === 'Custom');
  assert.equal(reused.connections.length, 5);
  assert.notEqual(replacement.id, first.id);
  assert.deepEqual(reused.connections.find(p => p.id === first.id), renamed.connections.find(p => p.id === first.id));
  assert.deepEqual(reused.connections.find(p => p.displayName === 'Custom-2'), original.connections.find(p => p.displayName === 'Custom-2'));
  const sameName = await rpc('saveProvider', input('DeepSeek', 'deepseek', 'same-name'));
  assert.equal(sameName.connections.length, 6);
  assert.equal(new Set(sameName.connections.filter(p=>p.displayName==='DeepSeek').map(p=>p.id)).size, 2);
  assert.deepEqual(sameName.connections.slice(0,5),reused.connections);
  await rpc('saveProvider',input('中文连接 名称','custom','unicode'));
  assert.ok((await rpc('getProviders')).connections.some(p=>p.displayName==='中文连接 名称'));
  for (const provider of sameName.connections) {
    await rpc('switchClientProvider', { client: 'codex', providerId: provider.id });
    assert.equal((await rpc('getProviders')).selected.codex, provider.id);
    assert.equal((await rpc('validateProvider', { providerId: provider.id })).status, 'valid');
    assert.equal(requests.at(-1).model, provider.codexModel);
    assert.equal(requests.at(-1).key, `Bearer ${provider.bearerToken}`);
  }
  const persisted = await rpc('getProviders'); await stop(); start();
  assert.deepEqual(await rpc('getProviders'), persisted, 'identities, names and selection survive restart');
  await stop();
  console.log('PASS multiple Custom/DeepSeek configurations, live identities across rename, old-name reuse, same-name and Unicode names, six actual requests and restart persistence');
} finally {
  if (child?.exitCode === null) child.kill('SIGKILL');
  await new Promise(resolve => server.close(resolve));
}
