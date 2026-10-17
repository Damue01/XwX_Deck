import { clearFreshCompatibleFixture } from './test-support.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { nativeTestBinary } from './test-support.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'xwxdeck-stop-admission-'));
const held = []; let requests = 0; const checks = [];
const upstream = createServer(async (req, res) => {
  if (req.url.endsWith('/models')) { res.end('{"data":[]}'); return; }
  for await (const _ of req) {} requests++;
  res.writeHead(200, { 'content-type':'text/event-stream' });
  res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"accepted"}\n\n');
  held.push(res);
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
const child = spawn(nativeTestBinary, ['--rpc', '--pilot-root', root], { stdio:['pipe','pipe','inherit'] });
const queue = [];
createInterface({input:child.stdout}).on('line', line => queue.shift()?.(JSON.parse(line)));
async function call(method, ...args) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('RPC timeout: '+method)), 20000);
    queue.push(result => { clearTimeout(timer); resolve(result); });
    child.stdin.write(JSON.stringify({method,args})+'\n');
  });
}
async function rpc(method,...args) { const result = await call(method,...args); assert.equal(result.ok,true,result.error); return result.result; }
const pass = name => {checks.push(name);console.log('PASS '+name);};
const wait = async predicate => {for(let n=0;n<150;n++){if(await predicate())return;await delay(20);}throw Error('activity timeout');};
let state;
async function request() {
  const response = await fetch(state.localBaseUrl+'/v1/responses', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fixture',input:'synthetic stop acceptance',stream:true})});
  assert.equal(response.status,200); const reader=response.body.getReader(); const first=await reader.read(); assert.match(new TextDecoder().decode(first.value),/accepted/);
  return reader;
}
try {
  const initial=await rpc('getState');assert.equal((await rpc('getState')).revision,initial.revision);
  await clearFreshCompatibleFixture(rpc);
  await rpc('saveProvider',{displayName:'Fixture_5466a9e2',baseUrl,bearerToken:'synthetic-key',adapter:'responses',codexModel:'fixture'});
  const id=(await rpc('getProviders')).connections[0].id;
  await rpc('switchClientProvider',{client:'codex',providerId:id});
  state=await rpc('toggleTracing',true);assert.ok(state.revision>initial.revision);
  const first=await request(); const before=await readFile(join(root,'codex/config.toml'),'utf8');
  const rejected=await call('toggleTracing',false);assert.equal(rejected.ok,false);assert.match(rejected.error,/1 个回复正在生成/);
  assert.equal((await rpc('getState')).tracingEnabled,true);assert.equal(await readFile(join(root,'codex/config.toml'),'utf8'),before);
  const second=await request();assert.equal((await rpc('getState')).activeRequests,2);
  pass('normal busy stop retains listener, managed files and admission; two accepted streams are not interrupted');
  for(const res of held.splice(0))res.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"fixture","status":"completed","output":[]}}\n\n');
  for(const reader of [first,second])while(!(await reader.read()).done){}
  await wait(async()=> (await rpc('getState')).activeRequests===0);
  const completed=await rpc('toggleTracing',false);assert.equal(completed.tracingEnabled,false);
  assert.ok(!(await readFile(join(root,'codex/config.toml'),'utf8')).includes(new URL(state.localBaseUrl).host));
  assert.ok(completed.revision>state.revision);assert.equal((await rpc('getState')).revision,completed.revision);
  assert.equal((await rpc('getCodexConfig')).activeBaseUrl,baseUrl);
  await assert.rejects(readFile(join(root,'gateway-recovery.json')),{code:'ENOENT'});
  await assert.rejects(fetch(state.localBaseUrl+'/v1/responses',{method:'POST',headers:{'content-type':'application/json'},body:'{"model":"fixture","input":"listener must be closed"}'}));
  pass('EOF releases leases; idle stop restores actual direct endpoint, clears recovery ledger and closes listener; unchanged reads retain revision');
  state=await rpc('toggleTracing',true);
  const cancelled=await request();await cancelled.cancel();await wait(async()=>(await rpc('getState')).activeRequests===0);
  pass('client body cancellation releases the active request lease');
  const liveConfig=await readFile(join(root,'codex/config.toml'),'utf8');
  const external = liveConfig.replace(new URL(state.localBaseUrl).host, '127.0.0.1:1');
  assert.notEqual(external, liveConfig);
  await writeFile(join(root,'codex/config.toml'), external);
  const conflict=await call('toggleTracing',false);assert.equal(conflict.ok,false);assert.match(conflict.error,/外部.*变化/);
  assert.equal((await rpc('getState')).tracingEnabled,true);
  const afterConflict=await request();
  await writeFile(join(root,'codex/config.toml'),liveConfig);
  const forced=await rpc('toggleTracing',false,true);assert.equal(forced.tracingEnabled,false);
  while(!(await afterConflict.read()).done){}
  assert.equal((await rpc('getCodexConfig')).activeBaseUrl,baseUrl);
  await assert.rejects(readFile(join(root,'gateway-recovery.json')),{code:'ENOENT'});
  await assert.rejects(fetch(state.localBaseUrl+'/v1/responses',{method:'POST',headers:{'content-type':'application/json'},body:'{"model":"fixture","input":"forced listener must be closed"}'}));
  pass('restore conflict reopens admission; explicit forced stop cancels only after consent and restores direct endpoint, clears ledger and closes listener');
  assert.equal(requests,4,'no replay during stop, cancellation or conflict');
  await rpc('repairClientProviderSwitch',{client:'codex'});
  assert.equal((await rpc('getProviders')).selected.codex,id,'omitted repair target uses latest saved intent');
  pass('repair without a target retains the latest provider rather than switching to official');
  const report={passed:true,checks,localHttpRequests:requests,isolatedFixtures:true,binarySha256:createHash('sha256').update(await readFile(nativeTestBinary)).digest('hex'),realPlatformAuthorization:false};
  await writeFile(resolve('test-results/native-trace-stop-admission-summary.json'),JSON.stringify(report,null,2)+'\n');
} finally {
  if(child.exitCode===null){await call('toggleTracing',false,true).catch(()=>{});child.stdin.end();await once(child,'exit');}
  upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));await rm(root,{recursive:true,force:true});
}
