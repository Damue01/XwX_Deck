import { nativeTestBinary } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdtemp, realpath, readFile, writeFile, rename, mkdir, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root=await mkdtemp(join(await realpath(tmpdir()),'xwx-account-routing-'));
const attempts=[];let base, mode='ok';
const server=createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 const id=(req.headers.authorization??'').replace('Bearer fixture-','');
 attempts.push({id,path:req.url,body:raw?JSON.parse(raw):null});
 if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({models:[{slug:'model',visibility:'list'}]}));return;}
 if(mode==='quota'&&id==='a'||mode==='fixed-quota'){res.writeHead(429,{'content-type':'application/json','retry-after':'120'});res.end(JSON.stringify({error:{code:'usage_limit_reached',message:'quota exhausted'}}));return;}
 if(mode==='auth'&&id==='a'){res.writeHead(401,{'content-type':'application/json'});res.end('{"error":{"message":"invalid token"}}');return;}
 if(mode==='model-error'&&id==='a'){res.writeHead(403,{'content-type':'application/json'});res.end('{"error":{"code":"model_not_supported"}}');return;}
 if(mode==='server-error'){res.writeHead(503);res.end('{"error":{"message":"temporary upstream failure"}}');return;}
 const response={id:`response-${attempts.length}`,object:'response',status:'completed',model:'model',output:[{type:'message',id:'message',role:'assistant',content:[{type:'output_text',text:id}]}]};
 res.writeHead(200,{'content-type':'text/event-stream'});
 res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({type:'response.output_text.delta',output_index:0,content_index:0,delta:id})}\n\n`);
 if(mode==='partial'){res.end();return;}
 setTimeout(()=>res.end(`event: response.completed\ndata: ${JSON.stringify({type:'response.completed',response})}\n\n`),mode==='held'?300:10);
});server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
let child,queue=[];
const start=()=>{child=spawn(nativeTestBinary,['--rpc','--pilot-root',root,'--subscription-test-endpoint',base],{stdio:['pipe','pipe','inherit']});createInterface({input:child.stdout}).on('line',line=>queue.shift()?.(JSON.parse(line)));};
const rpc=(method,...args)=>new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error(`Timeout ${method}`)),20000);queue.push(result=>{clearTimeout(timeout);result.ok?resolve(result.result):reject(new Error(result.error));});child.stdin.write(JSON.stringify({method,args})+'\n');});
const stop=async()=>{const done=once(child,'exit');child.stdin.end();assert.equal((await done)[0],0);};
let checks=0;const pass=label=>{checks++;console.log('PASS '+label);};
const policy=(strategy='exhaust',fixedAccountId='',excludedAccountIds=[])=>rpc('setSubscriptionRouting',{platform:'chatgpt',policy:{strategy,fixedAccountId,excludedAccountIds}});
try{
 start();assert.deepEqual((await rpc('getProviders')).connections,[]);await stop();
 await writeFile(join(root,'subscription-accounts.json'),JSON.stringify({hostId:'fixture-host',accounts:['a','b','c'].map(id=>({id,label:id,subject:id,email:id+'@example.test',clientId:'fixture',access:'fixture-'+id,refresh:'fixture-refresh',idToken:'fixture',scopes:['chatgpt.tokens.use.direct'],expires:Math.floor(Date.now()/1000)+3600}))}));
 start();for(const id of ['a','b','c'])await rpc('connectSubscriptionAccount',id);
 const providers=await rpc('getProviders'),a=providers.connections.find(p=>p.subscriptionAccountId==='a');
 await rpc('switchClientProvider',{client:'codex',providerId:a.id});await rpc('updateCodexConfig',{expectedProviderId:a.id,compatibleModel:'model'});await rpc('toggleClient','claude-cli');
 const runtime=await rpc('toggleTracing',true);const send=(session,input='fixture',stream=false)=>fetch(runtime.localBaseUrl+'/v1/responses',{method:'POST',headers:{'content-type':'application/json',...(session?{'x-session-id':session}:{})},body:JSON.stringify({model:'model',input,stream})});
 mode='quota';let response=await send('conversation-1');assert.equal(response.status,200);assert.equal((await response.json()).output[0].content[0].text,'b');assert.deepEqual(attempts.filter(a=>a.body).map(a=>a.id),['a','b']);assert.ok((await rpc('getSubscriptionNotices')).some(notice=>notice.message.includes('b')));pass('quota rejection retries the unchanged model on the next account before any client output and queues an informational notice');
 mode='ok';let at=attempts.length;response=await send('conversation-1','tool result');await response.text();assert.equal(attempts[at].id,'b');assert.equal((await rpc('getProviders')).selected.codex,a.id);assert.equal((await rpc('getProviders')).connections.find(p=>p.id===a.id).codexModel,'model');pass('same conversation/tool continuation stays on the replacement account without rewriting service/model choices');
 let snapshot=await rpc('getSubscriptionAccounts');assert.equal(snapshot.accounts.find(a=>a.id==='a').routingStatus,'额度已用完');assert.ok(snapshot.accounts.every(a=>!a.quota));pass('real quota rejection has a distinct cooldown; unknown quota never becomes a fictional percentage');
 await policy('fixed','a');at=attempts.length;response=await send('fixed');assert.equal(response.status,503);await response.text();assert.equal(attempts.length,at);await rpc('connectSubscriptionAccount','a');mode='fixed-quota';at=attempts.length;response=await send('fixed2');assert.equal(response.status,429);await response.text();assert.equal(attempts.length,at+1);pass('fixed account never falls through to another account even when quota is spent');
 await rpc('connectSubscriptionAccount','a');await policy();mode='ok';at=attempts.length;response=await send('new-after-cooldown');await response.text();assert.equal(attempts[at].id,'b');pass('exhaust strategy stays on the replacement account after the original account recovers');
 await policy('balanced');mode='held';at=attempts.length;const replies=await Promise.all(['new-1','new-2','new-3'].map(s=>send(s,'fixture',true)));await Promise.all(replies.map(r=>r.text()));assert.deepEqual(new Set(attempts.slice(at).map(a=>a.id)),new Set(['a','b','c']));pass('concurrent new conversations reserve separate accounts while replies stream');
 await policy('fixed','a');mode='partial';at=attempts.length;response=await send('partial');assert.equal(response.status,502);await response.text();assert.equal(attempts.length,at+1);pass('partial successful stream is never replayed on another account');
 await policy();mode='server-error';at=attempts.length;response=await send('network');assert.equal(response.status,503);await response.text();assert.equal(attempts.length,at+1);pass('ambiguous server failure does not repeat a possibly accepted task');
 await policy('fixed','a');mode='ok';await (await send('seed-auth-account')).text();await policy();mode='auth';at=attempts.length;response=await send('auth');assert.equal(response.status,200);await response.text();assert.deepEqual(attempts.slice(at).map(a=>a.id),['a','b']);pass('definite authentication rejection excludes the failed account before fallback');
 await rpc('connectSubscriptionAccount','a');await policy('fixed','a');mode='ok';await (await send('seed-model-account')).text();await policy();mode='model-error';at=attempts.length;response=await send('model-capability');assert.equal(response.status,200);await response.text();assert.deepEqual(attempts.slice(at).map(a=>a.id),['a','b']);pass('explicit unsupported-model rejection tries another account without changing the requested model');
 await rpc('connectSubscriptionAccount','a');await policy('fixed','b');mode='ok';response=await send('');const previousId=(await response.json()).id;
 await policy('balanced');at=attempts.length;response=await send('',[{role:'user',content:'continue'}]);await response.text();
 at=attempts.length;response=await fetch(runtime.localBaseUrl+'/v1/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'model',previous_response_id:previousId,input:'continued'})});assert.equal(response.status,200);await response.text();assert.equal(attempts[at].id,'b');pass('previous_response_id keeps account affinity without a client session header');
 await rpc('connectSubscriptionAccount','a');await policy('exhaust','',['a','b']);mode='ok';at=attempts.length;response=await send('excluded');await response.text();assert.equal(attempts[at].id,'c');pass('participation toggles exclude accounts without signing out or changing their credentials');
 await policy('fixed','a',['a','b']);at=attempts.length;response=await send('fixed-overrides-participation');assert.equal(response.status,200);await response.text();assert.equal(attempts[at].id,'a');pass('explicit fixed account selection overrides its previous rotation participation setting');
 await policy('exhaust','',['a','b']);
 await assert.rejects(policy('fixed','foreign-account'));assert.equal((await rpc('getSubscriptionAccounts')).routing.chatgpt.strategy,'exhaust');pass('invalid cross-category/fixed account choice cannot overwrite saved policy');
 await policy();await rpc('signOutSubscriptionAccount','a');const afterLogout=await rpc('getState');assert.equal(afterLogout.tracingEnabled,true);assert.equal(afterLogout.localBaseUrl,runtime.localBaseUrl);at=attempts.length;response=await send('after-account-logout');assert.equal(response.status,200);await response.text();assert.equal(attempts[at].id,'b');assert.equal((await rpc('getProviders')).selected.codex,a.id);pass('signing out one pool member keeps Gateway running and routes new requests to an eligible account');
 await policy('exhaust','',['a','b']);
 await rpc('toggleTracing',false);await stop();start();assert.deepEqual((await rpc('getSubscriptionAccounts')).routing.chatgpt.excludedAccountIds,['a','b']);assert.equal((await rpc('getProviders')).selected.codex,a.id);pass('restart retains category policy and explicit model service selection');
 const beforePolicy=(await rpc('getSubscriptionAccounts')).routing.chatgpt;
 const policyPath=join(root,'subscription-routing.json'),backup=policyPath+'.fixture-backup';await rename(policyPath,backup);await mkdir(policyPath);
 await assert.rejects(policy('balanced'));assert.deepEqual((await rpc('getSubscriptionAccounts')).routing.chatgpt,beforePolicy);await rmdir(policyPath);await rename(backup,policyPath);pass('failed policy persistence keeps the previous routing choice and original file');
 const savedText=await readFile(policyPath,'utf8'),external=JSON.parse(savedText);external.chatgpt.strategy='balanced';external.chatgpt.externalMetadata='preserve-external';const externalText=JSON.stringify(external);await writeFile(policyPath,externalText);
 await assert.rejects(policy('fixed','b'),/外部修改/);assert.equal(await readFile(policyPath,'utf8'),externalText);assert.deepEqual((await rpc('getSubscriptionAccounts')).routing.chatgpt,beforePolicy);await writeFile(policyPath,savedText);pass('external policy edits are preserved and require reloading instead of being silently overwritten');
 await writeFile(policyPath,externalText);await stop();start();assert.equal((await rpc('getSubscriptionAccounts')).routing.chatgpt.strategy,'balanced');await policy('fixed','b');assert.equal(JSON.parse(await readFile(policyPath,'utf8')).chatgpt.externalMetadata,'preserve-external');pass('reloading adopts external policy and later changes preserve unknown metadata');
 await stop();console.log(JSON.stringify({ok:true,checks,httpRequests:attempts.length,root}));
}finally{if(child?.exitCode===null)child.kill('SIGTERM');server.closeAllConnections();server.close();}
