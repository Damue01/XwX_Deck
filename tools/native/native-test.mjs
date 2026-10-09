import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';

const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-rust-pilot-native-'));
const installations=join(root,'installations');
const binary = process.env.XWX_NATIVE_TEST_BINARY ? resolve(process.env.XWX_NATIVE_TEST_BINARY) : resolve(import.meta.dirname, process.platform==='darwin'?'../../test-results/rust-pilot-package/XwX Deck Rust Pilot.app/Contents/MacOS/xwx-deck-native':'../../test-results/native-target/release/xwx-deck-native.exe');
const requests = [];
const upstream = createServer(async (req, res) => {
  if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'pilot-model' }] })); return; }
  let body = ''; for await (const part of req) body += part;
  requests.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('event: response.output_text.delta\ndata: {"delta":"native"}\n\n');
  setTimeout(() => res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n'), 150);
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const base = `http://127.0.0.1:${upstream.address().port}/v1`;
const keepOpen = process.argv.includes('--keep-open');
const child = spawn(binary, ['--pilot-root', root, '--smoke', '--smoke-upstream', base, ...(!keepOpen ? ['--smoke-exit'] : [])], { env: {...process.env, XWX_SYSTEM_LANGUAGE_TEST:'zh-CN', XWX_CLIENT_INSTALLATIONS_TEST_HOME:installations}, stdio: ['ignore', 'inherit', 'inherit'] });
try {
  // The fresh isolated root is validated before installing test-only discovery fixtures.
  for(let i=0;i<100;i++){try{await readFile(join(root,'.xwx-rust-pilot'));break;}catch{await new Promise(resolve=>setTimeout(resolve,50));}}
  for (const name of ['Cursor.app/Contents/MacOS/Cursor']) { const path=join(installations,'Applications',name); await mkdir(resolve(path,'..'),{recursive:true}); await writeFile(path,'isolated discovery fixture'); await chmod(path,0o755); }
  let report;
  for (let i = 0; i < 1800; i++) {
    try { report = JSON.parse(await readFile(join(root, 'native-smoke.json'), 'utf8')); break; } catch { /* Native WebKit is still rendering. */ }
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Native host exited: ${child.exitCode ?? child.signalCode}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(report, `Native smoke timed out; sandbox ${root}`);
  assert.equal(report.passed, true, JSON.stringify({ ...report, sandbox: root }));
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.authorization, 'Bearer isolated-test-key'); assert.equal(request.path, '/v1/responses'); assert.equal(request.body.model, 'pilot-model');
  }
  assert.ok((await readFile(join(root, 'codex/config.toml'), 'utf8')).includes(base));
  console.log(JSON.stringify({ ...report, sandbox: root, nativeHttpRequests: requests.length }, null, 2));
  if (keepOpen) {
    console.log('Native screenshot session ready. The test service can close; Gateway has already stopped.');
    await new Promise(resolve => upstream.close(resolve));
    await once(child, 'exit');
  } else if (child.exitCode === null) {
    const [code] = await once(child, 'exit'); assert.equal(code, 0);
  }
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  upstream.closeAllConnections();
  if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
}
