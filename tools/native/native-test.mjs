import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';


const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-rust-pilot-native-'));
const installations=join(root,'installations');
let binary = process.env.XWX_NATIVE_TEST_BINARY ? resolve(process.env.XWX_NATIVE_TEST_BINARY) : resolve(import.meta.dirname, process.platform==='darwin'?'../../test-results/rust-pilot-package/XwXDeck Rust Validation.app/Contents/MacOS/xwx-deck-native':'../../test-results/native-target/release/xwx-deck-native.exe');
const binarySha256=createHash('sha256').update(await readFile(binary)).digest('hex');
let stagedAppDirectory;
if (process.platform === 'darwin' && binary.includes('.app/Contents/MacOS/')) {
  stagedAppDirectory = await mkdtemp(join(await realpath(tmpdir()), 'xwx-webview-bundle-'));
  const bundle = binary.slice(0, binary.indexOf('.app/Contents/MacOS/') + 4);
  const staged = join(stagedAppDirectory, 'XwX Deck.app');
  const copy = spawnSync('/usr/bin/ditto', [bundle, staged], { encoding: 'utf8' });
  assert.equal(copy.status, 0, copy.stderr);
  binary = staged + binary.slice(bundle.length);
}
const requests = [];
const currentVersion=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8')).version;
const updateParts=currentVersion.split('.').map(Number);
const fixtureUpdateVersion=`${updateParts[0]}.${updateParts[1]}.${updateParts[2]+1}`;
const updatePayload=Buffer.from('isolated update download fixture');let updateDownloads=0;
const upstream = createServer(async (req, res) => {
  if(req.url==='/release.json'){res.setHeader('content-type','application/json');res.end(JSON.stringify({schemaVersion:1,channel:'release',releaseSeries:'native-v1',version:fixtureUpdateVersion,tag:'v'+fixtureUpdateVersion,changelog:'Isolated update notification',files:[{platform:process.platform==='darwin'?'darwin':'windows',arch:process.arch,name:process.platform==='darwin'?'fixture.dmg':'fixture.exe',url:base.replace('/v1','')+'/update-fixture',size:updatePayload.length,sha256:createHash('sha256').update(updatePayload).digest('hex')}]}));return;}
  if(req.url==='/update-fixture'){updateDownloads++;res.end(updatePayload);return;}
  if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'pilot-model' }] })); return; }
  let body = ''; for await (const part of req) body += part;
  requests.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('event: response.output_text.delta\ndata: {"delta":"native"}\n\n');
  setTimeout(() => res.end('event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:{id:'native-public-smoke',object:'response',status:'completed',model:'pilot-model',output:[],usage:{input_tokens:100,output_tokens:5,total_tokens:105,input_tokens_details:{cached_tokens:60,cache_write_tokens:20}}}})+'\n\n'), 150);
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const base = `http://127.0.0.1:${upstream.address().port}/v1`;
const keepOpen = process.argv.includes('--keep-open');
await writeFile(join(root, '.xwx-rust-pilot'), 'isolated-rust-pilot-v1\n');
for (const name of ['claude', 'codex']) {
  const path = join(installations, '.local/bin', process.platform === 'win32' ? name + '.cmd' : name);
  await mkdir(resolve(path, '..'), {recursive:true});
  await writeFile(path, 'isolated installed-client fixture', {mode:0o755});
}
const child = spawn(binary, ['--pilot-root', root, '--smoke', '--smoke-upstream', base, ...(!keepOpen ? ['--smoke-exit'] : [])], { env: {...process.env, XWX_DECK_UPDATE_SERVER_URL:base.replace('/v1',''), XWX_SYSTEM_LANGUAGE_TEST:'zh-CN', XWX_CLIENT_INSTALLATIONS_TEST_HOME:installations}, stdio: ['ignore', 'inherit', 'inherit'] });
try {
  // The fresh isolated root is validated before installing test-only discovery fixtures.
  for(let i=0;i<100;i++){try{await readFile(join(root,'.xwx-rust-pilot'));break;}catch{await new Promise(resolve=>setTimeout(resolve,50));}}
  for (const name of ['Cursor.app/Contents/MacOS/Cursor', 'OpenCode.app/Contents/MacOS/OpenCode']) { const path=join(installations,'Applications',name); await mkdir(resolve(path,'..'),{recursive:true}); await writeFile(path,'isolated discovery fixture'); await chmod(path,0o755); }
  if(process.platform==='darwin' && process.env.XWX_NATIVE_TEST_ACTIVATE==='1') {
    // Activate only the exact child created above; never search by an app name.
    let activated=false, activationError='';
    for(let attempt=0;attempt<100;attempt++) {
      if(child.exitCode!==null || child.signalCode!==null) throw Error('Candidate exited before registration: '+(child.exitCode??child.signalCode));
      const result=spawnSync('/usr/bin/osascript',['-l','JavaScript','-e',`ObjC.import('AppKit'); const candidate=$.NSRunningApplication.runningApplicationWithProcessIdentifier(${child.pid}); if(typeof candidate?.activateWithOptions!=='function') throw Error('Candidate PID not registered yet'); candidate.activateWithOptions(3);`],{encoding:'utf8',timeout:1000});
      if(result.status===0){activated=true;break;}
      activationError=result.stderr||result.error?.message||'Candidate not registered';
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(activated,true,activationError);
  }
  let report;
  for (let i = 0; i < 1800; i++) {
    try { report = JSON.parse(await readFile(join(root, 'native-smoke.json'), 'utf8')); break; } catch { /* Native WebKit is still rendering. */ }
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Native host exited: ${child.exitCode ?? child.signalCode}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if(!report) { const progress=await readFile(join(root,'native-smoke-progress.json'),'utf8').then(JSON.parse).catch(()=>({checks:[]})); report={...progress,passed:false,error:'Native smoke timed out'}; }
  await mkdir(resolve('test-results'),{recursive:true});
  await writeFile(resolve('test-results/native-webview-summary.json'),JSON.stringify({...report,binarySha256,nativeHttpRequests:requests.length,controlledActivation:process.env.XWX_NATIVE_TEST_ACTIVATE==='1',syntheticUpstream:true},null,2)+'\n');
  assert.ok(report, `Native smoke timed out; sandbox ${root}`);
  assert.equal(report.passed, true, JSON.stringify({ ...report, sandbox: root }));
  assert.equal(requests.length, 2);
  const viewer=JSON.parse(await readFile(join(root,'traces/native-viewer-smoke.json'),'utf8'));
  assert.equal(viewer.passed,true,JSON.stringify(viewer));
  await writeFile(resolve('test-results/native-viewer-summary.json'),JSON.stringify({...viewer,binarySha256},null,2)+'\n');
  assert.equal(updateDownloads,0,'notification checks must not automatically download an installer');
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
  if (stagedAppDirectory) await rm(stagedAppDirectory, {recursive:true, force:true});
  upstream.closeAllConnections();
  if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
}
