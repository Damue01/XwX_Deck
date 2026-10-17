// Real Rust persistence and local fixtures; no normal client or upstream data.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeTestBinary,clearFreshCompatibleFixture} from './test-support.mjs';

const root=await mkdtemp(join(await realpath(tmpdir()),'deck-configuration-removal-'));
const requests=[];
const server=createServer((req,res)=>{requests.push(req.url);res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fixture-model'}]}));});
server.listen(0,'127.0.0.1');await once(server,'listening');
const base='http://127.0.0.1:'+server.address().port+'/v1';
let child,seq=0;const pending=new Map();
function start(){child=spawn(nativeTestBinary,['--rpc','--pilot-root',root,'--subscription-test-endpoint',base.replace(/\/v1$/,'')],{stdio:['pipe','pipe','inherit']});createInterface({input:child.stdout}).on('line',line=>{const v=JSON.parse(line);pending.get(v.requestId)?.(v);pending.delete(v.requestId);});}
const rpc=(method,...args)=>new Promise((resolve,reject)=>{const requestId=++seq,timer=setTimeout(()=>reject(Error(method+' timeout')),30000);pending.set(requestId,v=>{clearTimeout(timer);v.ok?resolve(v.result):reject(Error(v.error));});child.stdin.write(JSON.stringify({requestId,method,args})+'\n');});
async function stop(){const done=once(child,'exit');child.stdin.end();assert.equal((await done)[0],0);}
const checks=[];const pass=text=>{checks.push(text);console.log('PASS '+text);};
const jwt=email=>'e30.'+Buffer.from(JSON.stringify({sub:email,email,name:email,exp:2000000000,'https://api.openai.com/auth':{chatgpt_account_id:'workspace-'+email}})).toString('base64url')+'.fixture';
const file=join(root,'import-sources/.config/magpie/logins.json');
const source=JSON.stringify([{id:'official',agent:'codex',user:'official@example.test',on:true,auth:{tokens:{access_token:jwt('official@example.test'),refresh_token:'SOURCE-REFRESH-PRESERVED',id_token:jwt('official@example.test'),account_id:'workspace-official@example.test'}}},{id:'api',agent:'chatgpt-api',user:'api@example.test',on:true,auth:{clientId:'fixture-client',sub:'api@example.test',email:'api@example.test',idToken:jwt('api@example.test'),access:jwt('api@example.test'),refresh:'SOURCE-API-PRESERVED',expires:'2033-05-18T03:33:20Z',scopes:['chatgpt.tokens.use.direct']}}]);
async function importAccounts(){const preview=await rpc('previewConfigurationImport');const items=preview.sources.flatMap(s=>s.items).filter(i=>i.accountKind&&i.status==='new');assert.equal(items.length,2);return rpc('importConfigurations',{sources:preview.sources.map(({source,path})=>({source,path})),targetDigest:preview.targetDigest,fingerprints:items.map(i=>i.fingerprint)});}
try {
 start();await clearFreshCompatibleFixture(rpc);await stop();
 await mkdir(join(root,'import-sources/.config/magpie'),{recursive:true});await writeFile(file,source);start();
 await importAccounts();let accounts=(await rpc('getSubscriptionAccounts')).accounts;
 const ids=accounts.map(a=>a.id),apiId=accounts.find(a=>a.authKind==='api').id;
 const provider=(await rpc('getProviders')).connections.find(p=>p.subscriptionAccountId===apiId);
 await rpc('switchClientProvider',{client:'codex',providerId:provider.id});
 assert.deepEqual(await rpc('getConfigurationRemovalImpact',{providerIds:[],accountIds:[apiId]}),['ChatGPT / Codex']);
 const before=await readFile(join(root,'settings.json'),'utf8');await assert.rejects(rpc('removeSubscriptionAccounts',ids),/ChatGPT/);assert.equal(await readFile(join(root,'settings.json'),'utf8'),before);
 pass('selected subscription pool blocks the whole atomic removal without changing settings');
 const live=await rpc('saveProvider',{displayName:'RemovalLive',baseUrl:base,bearerToken:'local-fixture',adapter:'responses',codexModel:'fixture-model'});
 const liveId=live.connections.find(p=>p.displayName==='RemovalLive').id;
 await rpc('switchClientProvider',{client:'codex',providerId:liveId});await rpc('updateCodexConfig',{expectedProviderId:liveId,compatibleModel:'fixture-model'});
 const unused=await rpc('saveProvider',{displayName:'RemovalUnused',baseUrl:base,bearerToken:'unused-fixture',adapter:'responses'});const unusedId=unused.connections.find(p=>p.displayName==='RemovalUnused').id;
 const runtime=await rpc('toggleTracing',true);assert.equal(runtime.tracingEnabled,true);
 await rpc('setServiceSwitching',{client:'codex',policy:{enabled:true,providerIds:[liveId,unusedId,provider.id]}});
 await rpc('deleteProvider',unusedId);assert.equal((await rpc('getState')).tracingEnabled,true);assert.equal((await rpc('getProviders')).selected.codex,liveId);
 assert.deepEqual((await rpc('getServiceSwitching')).codex.providerIds,[liveId,provider.id]);
 await assert.rejects(rpc('deleteProvider',liveId),/ChatGPT/);
 pass('Trace stays enabled while an unused API connection is removed; selected service remains protected');
 await mkdir(join(root,'settings.pilot-tmp'));await assert.rejects(rpc('removeSubscriptionAccounts',ids));await rm(join(root,'settings.pilot-tmp'),{recursive:true});assert.equal((await rpc('getSubscriptionAccounts')).accounts.length,2);assert.ok((await rpc('getProviders')).connections.some(p=>p.subscriptionAccountId===apiId));
 pass('failed persistence restores every account registration and provider connection');
 const requestCount=requests.length;await rpc('removeSubscriptionAccounts',ids);
 assert.deepEqual((await rpc('getServiceSwitching')).codex.providerIds,[liveId]);
 assert.equal((await rpc('getSubscriptionAccounts')).accounts.length,0);assert.ok(!(await rpc('getProviders')).connections.some(p=>ids.includes(p.subscriptionAccountId)));assert.equal(await readFile(file,'utf8'),source);assert.equal(requests.length,requestCount);assert.equal((await rpc('getState')).tracingEnabled,true);
 await assert.rejects(rpc('connectSubscriptionAccount',apiId),/已从 Deck 移除/);
 pass('removal unlinks all selected registrations without source writes, revocation or unrelated Trace shutdown');
 await rpc('toggleTracing',false);await stop();start();
 assert.equal((await rpc('getSubscriptionAccounts')).accounts.length,0);assert.equal(await readFile(file,'utf8'),source);
 await importAccounts();assert.equal((await rpc('getSubscriptionAccounts')).accounts.length,2);assert.ok((await rpc('getProviders')).connections.some(p=>p.subscriptionAccountId===apiId));assert.equal(await readFile(file,'utf8'),source);
 pass('restart does not resurrect removed accounts; explicit source import restores both accounts and connections');
 await stop();console.log(JSON.stringify({passed:true,checks,scope:'isolated Rust RPC, local source files and synthetic local model catalog; no normal login or real upstream modified'}));
} finally {if(child?.exitCode===null)child.kill('SIGTERM');server.close();await rm(root,{recursive:true,force:true});}
