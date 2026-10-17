import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { nativeTestBinary } from './test-support.mjs';
const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-client-trace-defaults-'));
let child, pending = [];
const calls = [];
const upstream = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  calls.push({ path: req.url, auth: req.headers.authorization, key: req.headers['x-api-key'], body: JSON.parse(raw) });
  res.setHeader('content-type', 'application/json');
  res.end(req.url.endsWith('/messages')
    ? JSON.stringify({ id: 'fixture-message', type: 'message', role: 'assistant', model: 'client-model', content: [{type:'text',text:'fixture'}], stop_reason:'end_turn', usage:{input_tokens:3,output_tokens:1} })
    : JSON.stringify({ id: 'fixture-response', object: 'response', status: 'completed', model: 'client-model', output: [], usage: {input_tokens:3,output_tokens:1,total_tokens:4} }));
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const base = `http://127.0.0.1:${upstream.address().port}`;
function start() {
  child = spawn(nativeTestBinary, ['--rpc','--pilot-root',root], {stdio:['pipe','pipe','inherit']});
  createInterface({input:child.stdout}).on('line',line=>pending.shift()?.(JSON.parse(line)));
}
async function rpc(method,...args) {
  const out = await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(method+' timed out')),15000);pending.push(r=>{clearTimeout(timer);resolve(r)});child.stdin.write(JSON.stringify({method,args})+'\n')});
  assert.equal(out.ok,true,out.error);return out.result;
}
async function stop() {const exited=once(child,'exit');child.stdin.end();assert.equal((await exited)[0],0);}
const enabled = (state,id)=>state.clients.find(c=>c.id===id+'-cli').enabled;
let passed = false;
try {
  start();let state=await rpc('getState');const providers=await rpc('getProviders');
  assert.deepEqual(await rpc('getModelClients'),[]);assert.equal(state.tracingEnabled,false);
  assert.equal(enabled(state,'codex'),false);assert.equal(enabled(state,'claude'),false);
  await writeFile(join(root,'codex/config.toml'),'');await writeFile(join(root,'codex/auth.json'),'{}');await writeFile(join(root,'claude/settings.json'),'{}');
  state=await rpc('getState');assert.equal(enabled(state,'codex'),false);assert.equal(enabled(state,'claude'),false);
  await mkdir(join(root,'installations/.local/bin'),{recursive:true});
  await writeFile(join(root,'installations/.local/bin',process.platform==='win32'?'claude.cmd':'claude'),'fixture',{mode:0o755});
  assert.deepEqual(await rpc('getModelClients'),['claude']);assert.equal(enabled(await rpc('getState'),'claude'),false);
  console.log('PASS blank install has no fabricated clients; empty files and installed-only clients stay off');
  const codex=`model_provider = "external_fixture"\nmodel = "client-model"\n[model_providers.external_fixture]\nname = "External fixture"\nbase_url = "${base}/v1"\nwire_api = "responses"\nexperimental_bearer_token = "client-only-key"\n[model_providers.inactive_fixture]\nbase_url = "https://inactive.invalid/v1"\n`;
  await writeFile(join(root,'codex/config.toml'),codex);
  await writeFile(join(root,'codex/auth.json'),JSON.stringify({tokens:{access_token:'never-borrow-official-token'}}));
  assert.equal(enabled(await rpc('getState'),'codex'),true);
  assert.deepEqual(await rpc('getModelClients'),['claude','codex']);
  state=await rpc('toggleTracing',true);assert.equal(state.tracingEnabled,true);
  assert.ok(Number(new URL(state.localBaseUrl).port)>0);assert.ok(!Array.from({length:10},(_,i)=>45233+i).includes(Number(new URL(state.localBaseUrl).port)),'isolated Gateway must not bind normal client ports');
  const managed=await readFile(join(root,'codex/config.toml'),'utf8');assert.match(managed,/model_provider = "external_fixture"/);assert.match(managed,/inactive\.invalid/);
  await fetch(state.localBaseUrl+'/v1/responses',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer client-only-key'},body:JSON.stringify({model:'client-model',input:'isolated external route'})}).then(r=>r.json());
  assert.equal(calls.at(-1).path,'/v1/responses');assert.equal(calls.at(-1).auth,'Bearer client-only-key');
  await rpc('toggleTracing',false);assert.equal(await readFile(join(root,'codex/config.toml'),'utf8'),codex);
  assert.deepEqual(await rpc('getProviders'),providers);
  console.log('PASS existing external Codex works with empty Deck registry; identity, auth, inactive provider and exact direct config survive stop');
  const claude=JSON.stringify({env:{ANTHROPIC_BASE_URL:base,ANTHROPIC_AUTH_TOKEN:'claude-client-key',ANTHROPIC_DEFAULT_SONNET_MODEL:'client-model'},permissions:{allow:[]}});
  await writeFile(join(root,'claude/settings.json'),claude);state=await rpc('toggleTracing',true);
  await fetch(state.localBaseUrl+'/v1/messages',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer claude-client-key'},body:JSON.stringify({model:'client-model',max_tokens:16,messages:[{role:'user',content:'fixture'}]})}).then(r=>r.json());
  assert.equal(calls.at(-1).path,'/v1/messages');assert.equal(calls.at(-1).auth,'Bearer claude-client-key');
  const during=JSON.parse(await readFile(join(root,'claude/settings.json'),'utf8'));during.permissions.allow=['Read'];await writeFile(join(root,'claude/settings.json'),JSON.stringify(during));
  await rpc('toggleTracing',false);const restored=JSON.parse(await readFile(join(root,'claude/settings.json'),'utf8'));assert.equal(restored.env.ANTHROPIC_BASE_URL,base);assert.deepEqual(restored.permissions.allow,['Read']);
  await rpc('toggleClient','codex-cli');await rpc('toggleClient','claude-cli');await stop();start();state=await rpc('getState');assert.equal(enabled(state,'codex'),false);assert.equal(enabled(state,'claude'),false);
  assert.deepEqual(await rpc('getProviders'),providers);
  console.log('PASS Claude external config routes without import, preserves unrelated edits, and explicit off survives restart');
  await stop();passed=true;
} finally {if(child?.exitCode===null)child.kill();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));if(passed)await rm(root,{recursive:true,force:true});else console.error('retained fixture:',root);}
