import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {mkdtemp,realpath,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {nativeTestBinary} from './test-support.mjs';
const root=await mkdtemp(join(await realpath(tmpdir()),'xwxdeck-chatgpt-usage-'));
const checks=[],requests=[];let child,sequence=0,mode='ok',passed=false,releaseCatalog,enteredCatalog;
const pending=new Map();
const now=Math.floor(Date.now()/1000);
const server=createServer(async(req,res)=>{
 let raw='';for await(const c of req)raw+=c;
 requests.push({path:req.url,account:req.headers['chatgpt-account-id']??null});
 assert.ok(['Bearer fixture-access','Bearer fixture-legacy'].includes(req.headers.authorization));assert.equal(req.headers.cookie,undefined);assert.equal(req.headers['x-api-key'],undefined);
 res.setHeader('content-type','application/json');
 if(req.url==='/backend-api/wham/usage'){
  if(req.headers.authorization==='Bearer fixture-legacy'){assert.equal(req.headers['chatgpt-account-id'],undefined);res.statusCode=403;res.end('{}');return;}
  assert.equal(req.headers['chatgpt-account-id'],'fixture-workspace');
  if(mode==='denied'||mode==='unauthorized'){res.statusCode=mode==='unauthorized'?401:403;res.end('{"private":"never-expose-upstream-secret"}');return;}
  if(mode==='malformed'){res.end('private-response-is-not-json');return;}
  const window=(used,seconds,reset)=>({used_percent:used,limit_window_seconds:seconds,reset_at:reset});
  res.end(JSON.stringify({plan_type:'plus',rate_limit:{allowed:true,primary_window:window(mode==='missing'?null:20,18000,now+3600),secondary_window:window(70,604800,now+604800)},additional_rate_limits:[{limit_name:'model-specific',rate_limit:{primary_window:window(99,3600,now+3600)}}],private:'never-copy-raw-body'}));return;
 }
 assert.equal(req.headers['chatgpt-account-id'],undefined,'SiWC public API must not receive Codex account routing headers');
 if(req.url==='/v1/models'){const body=JSON.stringify({models:[{slug:'first-model',visibility:'list'},{slug:'latest-model',display_name:'Latest model',visibility:'list'},{slug:'hidden',visibility:'hide'}]});if(mode==='held-models'){releaseCatalog=()=>res.end(body);enteredCatalog();return;}res.end(body);return;}
 if(req.url==='/v1/responses'){const body=JSON.parse(raw);assert.equal(body.model,'latest-model');assert.equal(body.store,false);assert.equal(body.stream,true);res.setHeader('content-type','text/event-stream');res.end('event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:{id:'test-response',object:'response',status:'completed',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'4'}]}],usage:{input_tokens:2,output_tokens:1,total_tokens:3}}})+'\n\n');return;}
 res.statusCode=404;res.end('{}');
});
server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
function start(){child=spawn(nativeTestBinary,['--rpc','--pilot-root',root,'--subscription-test-endpoint',base],{stdio:['pipe','pipe','pipe']});child.stderr.on('data',b=>process.stderr.write(b));createInterface({input:child.stdout}).on('line',line=>{const v=JSON.parse(line);pending.get(v.requestId)?.(v);pending.delete(v.requestId)});}
const call=(method,...args)=>new Promise((resolve,reject)=>{const requestId=++sequence,timer=setTimeout(()=>reject(Error(method+' timeout')),15000);pending.set(requestId,v=>{clearTimeout(timer);resolve(v)});child.stdin.write(JSON.stringify({requestId,method,args})+'\n');});
const rpc=async(method,...args)=>{const v=await call(method,...args);assert.equal(v.ok,true,v.error);return v.result;};
const stop=async()=>{const done=once(child,'exit');child.stdin.end();assert.equal((await done)[0],0);};
const pass=name=>{checks.push(name);console.log('PASS '+name);};
try{
 start();await rpc('getState');await stop();
 await mkdir(join(root,'codex'),{recursive:true});await writeFile(join(root,'codex/config.toml'),'model_provider = \"openai\"\nmodel = \"deepseek-v4-pro\"\n');
 await writeFile(join(root,'subscription-accounts.json'),JSON.stringify({hostId:'urn:uuid:local-fixture',accounts:[{id:'test-account',subject:'fixture',label:'Test account',email:'fixture@example.test',clientId:'fixture-client',access:'fixture-access',refresh:'fixture-refresh',idToken:'',scopes:['resource.invoke','chatgpt.tokens.use.direct'],expires:now+3600,chatgptAccountId:'fixture-workspace'}]}));
 start();const providers=await rpc('connectSubscriptionAccount','test-account');const provider=providers.connections.find(p=>p.subscriptionAccountId==='test-account');assert.ok(provider);
 let snapshot=await rpc('refreshSubscriptionUsage',{platform:'chatgpt'});let account=snapshot.accounts[0];assert.equal(account.quota.remainingPercent,30);assert.equal(account.quota.resetsAt,now+604800);assert.equal(account.quotaDetails.windows.length,3);assert.equal(account.quotaDetails.windows[0].windowSeconds,18000);assert.equal(account.quotaDetails.httpStatus,200);assert.ok(!JSON.stringify(snapshot).includes('never-copy'));
 pass('ChatGPT reads actual WHAM endpoint with account header and preserves every window/reset without applying model-specific quota to all models');
 const switched=await rpc('switchClientProvider',{client:'codex',providerId:provider.id});assert.ok(!switched.warning?.includes('需要开启 Trace'));assert.equal((await rpc('getState')).backgroundGatewayActive,false);mode='denied';let failure=await call('refreshSubscriptionUsage',{platform:'chatgpt'});assert.equal(failure.ok,false);assert.match(failure.error,/HTTP 403/);assert.ok(!JSON.stringify(failure).includes('never-expose'));
 snapshot=await rpc('getSubscriptionAccounts');account=snapshot.accounts[0];assert.equal(account.quota,undefined);assert.equal(account.quotaDetails.httpStatus,403);assert.match(account.quotaError,/HTTP 403/);
 let config=await rpc('getCodexConfig');assert.equal(config.mode,'compatible','native subscription publishes a direct authenticated route while Trace is stopped');
 const stoppedSource=await readFile(join(root,'codex/config.toml'),'utf8');
 config=await rpc('updateCodexConfig',{expectedProviderId:provider.id,mode:'compatible',officialModel:config.officialModel,compatibleModel:'latest-model',modelContextWindow:64000});
 assert.equal(config.compatible.model,'latest-model');assert.equal(config.modelContextWindow,64000);assert.equal(config.warning,undefined);
 const updatedSource=await readFile(join(root,'codex/config.toml'),'utf8');assert.notEqual(updatedSource,stoppedSource);assert.ok(updatedSource.includes('--native-auth-token'));assert.ok(!/fixture-access|fixture-refresh/.test(updatedSource));
 config=await rpc('updateCodexConfig',{expectedProviderId:provider.id,compatibleModel:'latest-model',modelContextWindow:null});assert.equal(config.modelContextWindow,null);
 assert.equal((await rpc('getProviders')).selected.codex,provider.id);assert.equal((await rpc('getCodexConfig')).compatible.model,'latest-model');
 assert.deepEqual((await rpc('fetchModels',{expectedProviderId:provider.id,refresh:true})).map(m=>m.id),['first-model','latest-model']);
 pass('quota HTTP failure stays actionable and secret-free, clears stale success and does not block latest model save or authenticated account catalog');
 mode='unauthorized';failure=await call('refreshSubscriptionUsage',{platform:'chatgpt'});assert.equal(failure.ok,false);assert.match(failure.error,/HTTP 401/);
 snapshot=await rpc('getSubscriptionAccounts');assert.equal(snapshot.accounts[0].quota,undefined);assert.equal(snapshot.accounts[0].quotaDetails.httpStatus,401);assert.equal(snapshot.accounts[0].status,'connected');
 assert.equal((await rpc('getCodexConfig')).compatible.model,'latest-model');assert.equal((await rpc('fetchModels',{expectedProviderId:provider.id,refresh:true})).length,2);
 pass('WHAM 401 remains a real failure, never becomes zero quota or signed-out status, and does not invalidate independently successful model discovery');

 mode='missing';failure=await call('refreshSubscriptionUsage',{platform:'chatgpt'});assert.equal(failure.ok,false);snapshot=await rpc('getSubscriptionAccounts');assert.equal(snapshot.accounts[0].quota,undefined);assert.equal(snapshot.accounts[0].quotaDetails.windows[0].remainingPercent,null);
 mode='malformed';failure=await call('refreshSubscriptionUsage',{platform:'chatgpt'});assert.equal(failure.ok,false);assert.ok(!JSON.stringify(failure).includes('private-response'));assert.equal((await rpc('getProviders')).selected.codex,provider.id);
 pass('missing percentages and malformed body remain unknown instead of zero and never replace account/model selection');
 mode='ok';snapshot=await rpc('refreshSubscriptionUsage',{platform:'chatgpt'});assert.equal(snapshot.accounts[0].quotaError,undefined);
 const state=await rpc('toggleTracing',true);config=await rpc('updateCodexConfig',{expectedProviderId:provider.id,compatibleModel:'latest-model',modelContextWindow:null});assert.equal(config.mode,'compatible');assert.equal(config.warning,undefined);const response=await fetch(state.localBaseUrl+'/v1/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'latest-model',input:[{role:'user',content:'What is 2 + 2?'}]})});assert.equal(response.status,200);assert.match(await response.text(),/latest-model/);await rpc('toggleTracing',false);
 assert.equal((await rpc('getCodexConfig')).compatible.model,'latest-model');pass('usage recovery clears failure and selected model reaches the public Responses route without WHAM account headers');
 mode='held-models';const entered=new Promise(resolve=>{enteredCatalog=resolve});
 const delayed=call('fetchModels',{refresh:true,expectedProviderId:provider.id});await entered;
 let responsivenessTimer;
 try{await Promise.race([rpc('getState'),new Promise((_,reject)=>{responsivenessTimer=setTimeout(()=>reject(Error('subscription catalog blocked application state')),1500)})]);}finally{clearTimeout(responsivenessTimer);}
 await rpc('updateCodexConfig',{expectedProviderId:provider.id,compatibleModel:'first-model'});
 await rpc('switchClientProvider',{client:'codex',providerId:null});
 releaseCatalog();releaseCatalog=null;const late=await delayed;assert.equal(late.ok,false);assert.match(late.error,/连接已更改/);
 let latestProviders=await rpc('getProviders');assert.equal(latestProviders.selected.codex,null);assert.equal(latestProviders.connections.find(p=>p.id===provider.id).codexModel,'first-model');
 mode='ok';await rpc('switchClientProvider',{client:'codex',providerId:provider.id});await rpc('updateCodexConfig',{expectedProviderId:provider.id,compatibleModel:'latest-model'});
 pass('held owned-account catalog leaves state/model/service operations responsive and rejects stale result after latest selection');
 await stop();
 const vault=JSON.parse(await readFile(join(root,'subscription-accounts.json'),'utf8'));
 vault.accounts.push({...vault.accounts[0],id:'legacy-account',subject:'legacy-fixture',access:'fixture-legacy',idToken:'retained-unverified-id-token'});
 delete vault.accounts[1].chatgptAccountId;
 await writeFile(join(root,'subscription-accounts.json'),JSON.stringify(vault));start();
 failure=await call('refreshSubscriptionUsage',{platform:'chatgpt'});assert.equal(failure.ok,false);assert.match(failure.error,/HTTP 403/);
 snapshot=await rpc('getSubscriptionAccounts');const legacy=snapshot.accounts.find(a=>a.id==='legacy-account');
 assert.equal(legacy.status,'connected');assert.equal(legacy.quota,undefined);assert.match(legacy.quotaError,/HTTP 403/);
 const legacyProviders=await rpc('connectSubscriptionAccount','legacy-account');const legacyProvider=legacyProviders.connections.find(p=>p.subscriptionAccountId==='legacy-account');
 assert.equal((await rpc('fetchProviderModels',{providerId:legacyProvider.id}))[1].id,'latest-model');
 assert.equal((await rpc('getProviders')).selected.codex,provider.id);
 pass('old signed-in account without verified workspace ID keeps its own credential, skips guessed account headers and remains usable after WHAM denial without forced login');
 passed=true;
}finally{
 releaseCatalog?.();
 if(child?.exitCode===null){try{await rpc('toggleTracing',false);await stop();}catch{child.kill();}}
 server.closeAllConnections();await new Promise(r=>server.close(r));
 await writeFile('test-results/native-chatgpt-usage-summary.json',JSON.stringify({passed,checks,binarySha256:createHash('sha256').update(await readFile(nativeTestBinary)).digest('hex'),requests,scope:'Synthetic OAuth credentials and loopback HTTP; no real authorization claim'},null,2)+'\n');
 if(passed)await rm(root,{recursive:true,force:true});else console.error('Retained fixture: '+root);
}
