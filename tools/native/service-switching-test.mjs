import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {mkdtemp,realpath,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {clearFreshCompatibleFixture,nativeTestBinary} from './test-support.mjs';
const root=await mkdtemp(join(await realpath(tmpdir()),'xwx-service-switching-'));
const attempts=[],checks=[];let modes={},child,queue=[],held;
const server=createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 if(req.url.endsWith('/models')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'model-a'},{id:'model-b'},{id:'model-c'}]}));return;}
 const id=(req.headers.authorization??req.headers['x-api-key']??'').replace('Bearer fixture-','').replace('fixture-','');
 const body=raw?JSON.parse(raw):null;attempts.push({id,body,path:req.url,session:req.headers['x-session-id']});
 const mode=modes[id]??'ok';
 if(mode==='held-quota'){await new Promise(resolve=>{held=resolve;});}
 if(mode==='quota'||mode==='held-quota'){res.writeHead(429,{'content-type':'application/json','retry-after':'120'});res.end(JSON.stringify({error:{code:'insufficient_quota',message:'quota exhausted'}}));return;}
 if(mode==='rate'||mode==='auth'||mode==='server'){res.writeHead(mode==='auth'?401:mode==='server'?503:429,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:mode==='rate'?'rate_limit_exceeded':'temporary_error'}}));return;}
 if(mode==='partial'||mode==='stream-quota') {res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"accepted"}\n\n');res.end(mode==='stream-quota'?'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"insufficient_quota"}}}\n\n':'');return;}
 const response={id:`resp-${attempts.length}`,object:'response',status:'completed',model:body.model,output:[{id:`msg-${attempts.length}`,type:'message',role:'assistant',content:[{type:'output_text',text:`reply-${id}`}]}],usage:{input_tokens:3,output_tokens:2,total_tokens:5}};
 res.setHeader('content-type','application/json');res.end(JSON.stringify(response));
});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}/v1`;
function start(){child=spawn(nativeTestBinary,['--rpc','--pilot-root',root],{stdio:['pipe','pipe','pipe']});queue=[];createInterface({input:child.stdout}).on('line',line=>queue.shift()?.(JSON.parse(line)));child.stderr.on('data',data=>process.stderr.write(data));}
function call(method,...args){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`RPC timeout ${method}`)),25000);queue.push(value=>{clearTimeout(timer);resolve(value);});child.stdin.write(JSON.stringify({method,args})+'\n');});}
async function rpc(method,...args){const result=await call(method,...args);assert.equal(result.ok,true,result.error);return result.result;}
async function stop(){const done=once(child,'exit');child.stdin.end();assert.equal((await done)[0],0);}
const pass=name=>{checks.push(name);console.log('PASS '+name);};
start();
try {
 await clearFreshCompatibleFixture(rpc);
 for(const id of ['a','b','c'])await rpc('saveProvider',{displayName:id,baseUrl:base,bearerToken:'fixture-'+id,adapter:'responses',codexModel:'model-'+id});
 await rpc('switchClientProvider',{client:'codex',providerId:'a'});
 await rpc('switchClientProvider',{client:'claude',providerId:'a'});
 for(const id of ['a','b','c'])await rpc('updateProviderClientModel',{providerId:id,client:'claude',role:'sonnet',model:'model-'+id});
 let policy={enabled:false,providerIds:['a','b','c']};
 const save=async(next)=>{policy=next;return rpc('setServiceSwitching',{client:'codex',policy});};
 await save(policy);let runtime=await rpc('toggleTracing',true);
 const send=(session,input='fixture',extra={})=>fetch(runtime.localBaseUrl+'/v1/responses',{method:'POST',headers:{'content-type':'application/json','x-session-id':session},body:JSON.stringify({model:'model-a',input,...extra})});
 modes={a:'quota'};let at=attempts.length;let response=await send('disabled');assert.equal(response.status,429);await response.text();assert.deepEqual(attempts.slice(at).map(a=>a.id),['a']);pass('disabled policy preserves list and never changes provider');
 await save({...policy,enabled:true});modes={a:'rate'};at=attempts.length;response=await send('rate');assert.equal(response.status,429);await response.text();assert.equal(attempts.length,at+1);pass('ordinary rate limiting never switches service');
 modes={a:'auth'};at=attempts.length;response=await send('auth');assert.equal(response.status,401);await response.text();assert.equal(attempts.length,at+1);modes={a:'server'};at=attempts.length;response=await send('server');assert.equal(response.status,503);await response.text();assert.equal(attempts.length,at+1);pass('authentication and ambiguous server errors never replay across providers');
 modes={a:'partial'};at=attempts.length;response=await send('partial','fixture',{stream:true});await response.text();assert.equal(attempts.length,at+1);pass('partial successful stream is never replayed');
 modes={};let seed=await (await send('continuation','remember TEST-CONTEXT')).json();modes={a:'quota'};at=attempts.length;response=await send('continuation','continue TEST-CONTEXT',{previous_response_id:seed.id});assert.equal(response.status,200);assert.equal((await response.json()).model,'model-b');assert.deepEqual(attempts.slice(at).map(a=>a.id),['a','b']);assert.equal(attempts.at(-1).body.previous_response_id,undefined);assert.match(JSON.stringify(attempts.at(-1).body.input),/remember TEST-CONTEXT/);pass('definite quota refusal continues the same session on the next service with saved model and restored context');
 modes={};at=attempts.length;await(await send('continuation','tool result')).text();assert.deepEqual(attempts.slice(at).map(a=>a.id),['b']);assert.equal((await rpc('getProviders')).selected.codex,'a');assert.ok((await rpc('getSubscriptionNotices')).some(n=>n.message.includes('b')));pass('replacement provider affinity and notice preserve explicit client provider choice');
 await save({...policy,enabled:false});at=attempts.length;await(await send('continuation')).text();assert.deepEqual(attempts.slice(at).map(a=>a.id),['a']);assert.deepEqual((await rpc('getServiceSwitching')).codex.providerIds,['a','b','c']);pass('turning off stops sticky routing immediately without clearing order');
 await save({...policy,enabled:true});modes={b:'quota'};at=attempts.length;response=await send('continuation');assert.equal(response.status,200);assert.equal((await response.json()).model,'model-c');assert.deepEqual(attempts.slice(at).map(a=>a.id),['b','c']);pass('exhausted replacement advances forward without cycling to earlier services');
 await rpc('updateProviderClientModel',{providerId:'c',client:'codex',model:'new-model-c'});modes={};response=await send('continuation');assert.equal((await response.json()).model,'new-model-c');assert.equal((await rpc('getProviders')).connections.find(p=>p.id==='c').codexModel,'new-model-c');pass('backup model writes share the model page source and affect the next turn');
 await rpc('setServiceSwitching',{client:'claude',policy:{enabled:true,providerIds:['a','b','c']}});modes={a:'quota'};at=attempts.length;response=await fetch(runtime.localBaseUrl+'/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-session-id':'claude-session'},body:JSON.stringify({model:'model-a',max_tokens:20,messages:[{role:'user',content:'hello'}]})});assert.equal(response.status,200);await response.text();assert.equal(attempts.at(-1).body.model,'model-c');pass('Claude uses its independent order and matching saved role model');
 let rejected=await call('setServiceSwitching',{client:'codex',policy:{enabled:true,providerIds:['missing']}});assert.equal(rejected.ok,false);assert.deepEqual((await rpc('getServiceSwitching')).codex.providerIds,['a','b','c']);pass('invalid provider choice cannot overwrite saved configuration');
 const dashboard=await rpc('getDashboardUrl');const state=await(await fetch(dashboard+'api/state')).json();const session=state.sessions.find(s=>s.clientConversationKey.endsWith(':continuation'));assert.ok(session);const records=(await(await fetch(dashboard+'api/session/'+session.id)).json()).traces;assert.ok(records.some(r=>r.contextChanges?.serviceSwitch?.providerId==='b'));assert.ok(records.some(r=>r.request.clientModel==='model-a'&&r.upstream.model==='model-b'));pass('Trace retains original client model, actual provider model and service switch evidence');
 await rpc('toggleTracing',false);await stop();start();assert.equal((await rpc('getServiceSwitching')).codex.enabled,true);assert.equal((await rpc('getServiceSwitching')).claude.enabled,true);runtime=await rpc('toggleTracing',true);modes={};at=attempts.length;await(await send('continuation')).text();assert.equal(attempts.at(-1).id,'c');pass('restart restores policy, order and conversation affinity');
 for(const id of ['stream-service','last-a','last-b'])await rpc('saveProvider',{displayName:id,baseUrl:base,bearerToken:'fixture-'+id,adapter:'responses',codexModel:'model-'+id});
 await rpc('switchClientProvider',{client:'codex',providerId:'stream-service'});await save({enabled:true,providerIds:['stream-service','c']});modes={'stream-service':'stream-quota'};at=attempts.length;response=await send('stream-failure','fixture',{stream:true});assert.match(await response.text(),/accepted/);assert.deepEqual(attempts.slice(at).map(a=>a.id),['stream-service']);at=attempts.length;response=await send('stream-failure');await response.text();assert.deepEqual(attempts.slice(at).map(a=>a.id),['c']);pass('quota failure inside a successful stream never replays that turn and switches only the next request');
 await rpc('switchClientProvider',{client:'codex',providerId:'last-a'});await save({enabled:true,providerIds:['last-a','last-b']});modes={'last-a':'quota','last-b':'quota'};at=attempts.length;response=await send('all-spent');assert.equal(response.status,429);await response.text();assert.deepEqual(attempts.slice(at).map(a=>a.id),['last-a','last-b']);pass('all exhausted services terminate once without a retry loop');
 await save({...policy,enabled:false});await save({...policy,enabled:true,providerIds:['a']});
 // New provider identity avoids earlier cooldowns for the policy-change race.
 await rpc('saveProvider',{displayName:'race',baseUrl:base,bearerToken:'fixture-race',adapter:'responses',codexModel:'model-race'});await rpc('switchClientProvider',{client:'codex',providerId:'race'});await save({enabled:true,providerIds:['race','b']});modes={race:'held-quota'};at=attempts.length;const pending=send('race');for(let i=0;i<100&&!held;i++)await new Promise(r=>setTimeout(r,10));assert.ok(held);await save({...policy,enabled:false});held();response=await pending;assert.equal(response.status,429);await response.text();assert.deepEqual(attempts.slice(at).map(a=>a.id),['race']);pass('disabling during an in-flight refusal prevents fallback');
 await rpc('toggleTracing',false);await stop();console.log(JSON.stringify({ok:true,checks,httpRequests:attempts.length,root}));
} finally {if(child?.exitCode===null)child.kill('SIGTERM');server.closeAllConnections();server.close();}
