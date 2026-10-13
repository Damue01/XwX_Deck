import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {mkdtemp,realpath,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {nativeTestBinary} from './test-support.mjs';

const root=await mkdtemp(join(await realpath(tmpdir()),'xwxdeck-official-catalog-'));
const checks=[],requests=[];
let child,sequence=0,mode='oauth',passed=false,releaseCatalog,enteredCatalog;
const pending=new Map();
const server=createServer((req,res)=>{
  requests.push({path:req.url,account:req.headers['chatgpt-account-id']??null});
  assert.equal(req.headers.cookie,undefined);
  assert.equal(req.headers['x-api-key'],undefined);
  assert.equal(req.headers.authorization,mode==='api'?'Bearer fixture-api-key':'Bearer fixture-oauth');
  if(mode==='denied'){res.statusCode=403;res.end('never-expose-private-error');return;}
  res.setHeader('content-type','application/json');
  if(mode==='api'){
    assert.equal(req.url,'/v1/models');assert.equal(req.headers['chatgpt-account-id'],undefined);
    res.end(JSON.stringify({data:[{id:'api-current-model'}]}));return;
  }
  assert.equal(req.url,'/backend-api/codex/models?client_version=1.1.0');
  assert.equal(req.headers['chatgpt-account-id'],'fixture-workspace');
  const payload=JSON.stringify({models:[
    {slug:'fresh-model',display_name:'Fresh model',visibility:'list',context_window:400000,input_modalities:['text','image'],supported_reasoning_levels:[{effort:'high'}],default_reasoning_level:'high'},
    {slug:'explicit-api-model',visibility:'list',supported_in_api:true},
    {slug:'hidden-model',visibility:'hide',supported_in_api:true},
    {slug:'unavailable-api-model',visibility:'list',supported_in_api:false}
  ]});
  if(mode==='held'){releaseCatalog=()=>res.end(payload);enteredCatalog();return;}
  res.end(payload);
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`;
const call=(method,...args)=>new Promise((resolve,reject)=>{
  const requestId=++sequence;
  const timer=setTimeout(()=>reject(Error(method+' timeout')),15000);
  pending.set(requestId,v=>{clearTimeout(timer);resolve(v)});
  child.stdin.write(JSON.stringify({requestId,method,args})+'\n');
});
const rpc=async(method,...args)=>{const v=await call(method,...args);assert.equal(v.ok,true,v.error);return v.result;};
const pass=name=>{checks.push(name);console.log('PASS '+name);};
try{
  child=spawn(nativeTestBinary,['--rpc','--pilot-root',root],{stdio:['pipe','pipe','pipe']});
  child.stderr.on('data',b=>process.stderr.write(b));
  createInterface({input:child.stdout}).on('line',line=>{const v=JSON.parse(line);pending.get(v.requestId)?.(v);pending.delete(v.requestId)});
  await rpc('getState');
  const config=join(root,'codex/config.toml'),auth=join(root,'codex/auth.json'),cache=join(root,'codex/models_cache.json');
  const initialAuth=JSON.stringify({tokens:{access_token:'fixture-oauth',refresh_token:'preserve-refresh',account_id:'fixture-workspace'}});
  const initialCache=JSON.stringify({models:[{slug:'stale-model',visibility:'list',supported_in_api:true}]});
  await writeFile(config,`model="chosen-model"\nopenai_base_url="${base}/backend-api"\n`);
  await writeFile(auth,initialAuth);await writeFile(cache,initialCache);
  assert.deepEqual((await rpc('fetchModels')).map(m=>m.id),['stale-model','chosen-model']);assert.equal(requests.length,0);
  let entries=await rpc('fetchModels',{refresh:true,expectedProviderId:null});
  assert.deepEqual(entries.map(m=>m.id),['fresh-model','explicit-api-model','chosen-model']);
  assert.equal(entries[0].displayName,'Fresh model');assert.equal(entries[0].contextWindow,400000);
  assert.deepEqual(entries[0].reasoningLevels,['high']);assert.deepEqual(entries[0].inputModalities,['text','image']);
  assert.equal((await rpc('getCodexConfig')).officialModel,'chosen-model');
  pass('explicit refresh reads authenticated official catalog with account header and declared metadata; initial cache is read-only');
  const state=await rpc('toggleTracing',true);
  assert.ok((await readFile(config,'utf8')).includes(state.localBaseUrl));
  entries=await rpc('fetchModels',{refresh:true,expectedProviderId:null});
  assert.ok(entries.some(m=>m.id==='fresh-model'));
  assert.equal(requests.at(-1).path,'/backend-api/codex/models?client_version=1.1.0');
  await rpc('toggleTracing',false);
  assert.equal(await readFile(auth,'utf8'),initialAuth);assert.equal(await readFile(cache,'utf8'),initialCache);
  pass('active Trace resolves the direct official catalog, restores route and never rewrites client credentials/cache');
  mode='denied';const failure=await call('fetchModels',{refresh:true,expectedProviderId:null});
  assert.equal(failure.ok,false);assert.match(failure.error,/HTTP 403/);assert.ok(!failure.error.includes('private-error'));
  assert.equal((await rpc('getCodexConfig')).officialModel,'chosen-model');
  assert.equal(await readFile(cache,'utf8'),initialCache);
  pass('HTTP failure is visible and leaves latest model and client cache intact');
  mode='held';const entered=new Promise(resolve=>{enteredCatalog=resolve});
  const delayed=call('fetchModels',{refresh:true,expectedProviderId:null});await entered;
  let responsivenessTimer;
  try {
    await Promise.race([rpc('getState'),new Promise((_,reject)=>{responsivenessTimer=setTimeout(()=>reject(Error('official catalog blocked application state')),1500)})]);
  } finally {clearTimeout(responsivenessTimer);}
  await rpc('updateCodexConfig',{expectedProviderId:null,officialModel:'new-choice'});
  releaseCatalog();releaseCatalog=null;
  const late=await delayed;assert.equal(late.ok,false);assert.match(late.error,/已更改/);
  assert.equal((await rpc('getCodexConfig')).officialModel,'new-choice');
  pass('held official HTTP does not lock application state; latest model save succeeds and stale catalog is rejected');
  mode='api';await writeFile(config,`model="chosen-api-model"\nopenai_base_url="${base}/v1"\n`);
  await writeFile(auth,JSON.stringify({OPENAI_API_KEY:'fixture-api-key'}));
  entries=await rpc('fetchModels',{refresh:true,expectedProviderId:null});
  assert.deepEqual(entries.map(m=>m.id),['api-current-model','chosen-api-model']);
  assert.equal(entries[0].protocolsDeclared,false);
  pass('API-key catalog uses public data schema without OAuth account header or false capability claims');
  const exited=once(child,'exit');child.stdin.end();assert.equal((await exited)[0],0);passed=true;
}finally{
  releaseCatalog?.();
  if(child?.exitCode===null){try{await rpc('toggleTracing',false);}finally{child.kill();}}
  server.closeAllConnections();await new Promise(r=>server.close(r));
  await writeFile('test-results/native-official-catalog-summary.json',JSON.stringify({passed,checks,binarySha256:createHash('sha256').update(await readFile(nativeTestBinary)).digest('hex'),requests,scope:'Synthetic OAuth/API credentials and loopback HTTP; no real authorization claim'},null,2)+'\n');
  if(passed)await rm(root,{recursive:true,force:true});else console.error('Retained fixture: '+root);
}
