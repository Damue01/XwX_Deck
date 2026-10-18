// Actual native credential commands, rotation, direct HTTP and optional installed Codex.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import {mkdtemp,realpath,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {parse} from 'smol-toml';
import {createHash} from 'node:crypto';
import {nativeTestBinary} from './test-support.mjs';
const root=await mkdtemp(join(await realpath(tmpdir()),'xwx-native-auth-'));
await writeFile(join(root,'.xwx-rust-pilot'),'isolated-rust-pilot-v1\n');
await mkdir(join(root,'codex'));await mkdir(join(root,'work'));
const auth=JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'unrelated-original-access',refresh_token:'unrelated-original-refresh'}});
await writeFile(join(root,'codex/auth.json'),auth);
const accounts=['a','b','c','d'].map(id=>({id:'native-'+id,label:'Native '+id,subject:id,email:id+'@example.test',clientId:'client-'+id,access:'expired-'+id,refresh:'refresh-'+id+'-0',idToken:'',scopes:['resource.invoke','chatgpt.tokens.use.direct','offline_access'],expires:0}));
await writeFile(join(root,'subscription-accounts.json'),JSON.stringify({hostId:'native-auth-fixture',accounts}));
const rotations=new Map(),calls=[],checks=[],heldRefreshes=new Map();let lifetime=62,child,lines,base,refreshStarted,refreshRelease;
const server=createServer(async(req,res)=>{
 let raw='';for await(const b of req)raw+=b;
 if(req.url==='/api/accounts/oauth/token'){
  const f=new URLSearchParams(raw),id=f.get('client_id').slice(-1),n=(rotations.get(id)??0)+1;
  assert.equal(f.get('refresh_token'),'refresh-'+id+'-'+(n-1));rotations.set(id,n);
  if(refreshStarted){refreshStarted();refreshStarted=null;await new Promise(resolve=>refreshRelease=resolve);}
  const hold=heldRefreshes.get(id);if(hold){hold.started();await hold.wait;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({access_token:'access-'+id+'-'+n,refresh_token:'refresh-'+id+'-'+n,token_type:'Bearer',expires_in:lifetime,scope:'resource.invoke chatgpt.tokens.use.direct offline_access'}));return;
 }
 if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'native-response-model'}]}));return;}
 if(req.url?.endsWith('/responses')){
  const body=JSON.parse(raw);calls.push({auth:req.headers.authorization,body,path:req.url});
  assert.ok(/^Bearer access-[ab]-\d+$/.test(req.headers.authorization));
  const item={id:'msg-native',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'native-direct-ok',annotations:[]}]};
  const response={id:'resp-native-'+calls.length,object:'response',created_at:Math.floor(Date.now()/1000),model:body.model,status:'completed',output:[item],usage:{input_tokens:5,output_tokens:3,total_tokens:8}};
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const data of [{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},{type:'response.content_part.added',output_index:0,item_id:item.id,content_index:0,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',output_index:0,item_id:item.id,content_index:0,delta:'native-direct-ok'},{type:'response.output_text.done',output_index:0,item_id:item.id,content_index:0,text:'native-direct-ok'},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}])res.write('event: '+data.type+'\ndata: '+JSON.stringify(data)+'\n\n');
  res.end();return;
 }
 res.writeHead(404);res.end('{}');
});server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
const pass=s=>{checks.push(s);console.log('PASS '+s);};
const start=()=>{child=spawn(nativeTestBinary,['--rpc','--pilot-root',root,'--subscription-test-endpoint',base],{stdio:['pipe','pipe','pipe']});child.stderr.resume();lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();};
const rpc=async(method,...args)=>{child.stdin.write(JSON.stringify({method,args})+'\n');const r=JSON.parse((await lines.next()).value);assert.equal(r.ok,true,r.error);return r.result;};
const run=async(exe,args,env=process.env,cwd=root)=>{
 const p=spawn(exe,args,{env,cwd,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);const timer=setTimeout(()=>p.kill(),60000);try{const[code]=await once(p,'exit');return{code,stdout,stderr};}finally{clearTimeout(timer);}
};
const config=async()=>parse(await readFile(join(root,'codex/config.toml'),'utf8'));
const helper=async(snapshot)=>run(snapshot.model_providers[snapshot.model_provider].auth.command,snapshot.model_providers[snapshot.model_provider].auth.args);
const stop=async()=>{const ended=once(child,'exit');child.stdin.end();assert.equal((await ended)[0],0);};
let installedClient=false;
try{
 start();for(const a of accounts)await rpc('connectSubscriptionAccount',a.id);
 const providers=await rpc('getProviders');assert.ok(providers.connections.every(p=>p.codexNativeAuth));
 const a=providers.connections.find(p=>p.subscriptionAccountId==='native-a'),b=providers.connections.find(p=>p.subscriptionAccountId==='native-b');
 await rpc('switchClientProvider',{client:'codex',providerId:a.id});await rpc('updateCodexConfig',{expectedProviderId:a.id,compatibleModel:'native-response-model'});
 const ca=await config();assert.equal(ca.model_providers[ca.model_provider].base_url,base+'/v1');assert.equal(ca.model_providers[ca.model_provider].experimental_bearer_token,undefined);
 assert.ok(!/expired-|refresh-|access-a/.test(await readFile(join(root,'codex/config.toml'),'utf8')));
 let state=await rpc('getState');assert.equal(state.tracingEnabled,false);assert.equal(state.backgroundGatewayActive,false);assert.ok(!state.connectionNotice);
 pass('selecting a native subscription writes a credential command and direct endpoint without Trace or persisted tokens');
 const concurrent=await Promise.all(Array.from({length:4},()=>helper(ca)));assert.ok(concurrent.every(r=>r.code===0&&r.stdout.trim()==='access-a-1'));assert.equal(rotations.get('a'),1);
 pass('concurrent native credential commands share one serialized refresh and return the same account token');
 await new Promise(r=>setTimeout(r,3100));lifetime=3600;const renewed=await helper(ca);assert.equal(renewed.code,0,renewed.stderr);assert.equal(renewed.stdout.trim(),'access-a-2');assert.equal(rotations.get('a'),2);
 pass('expiry refresh rotates access and refresh credentials without activating Trace');
 const cli=process.env.XWX_NATIVE_TEST_CODEX;
 if(cli){
  const env={...process.env,CODEX_HOME:join(root,'codex'),OPENAI_API_KEY:'',CODEX_API_KEY:'',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'127.0.0.1,localhost'};
  const reply=await run(cli,['exec','--skip-git-repo-check','--sandbox','read-only','--json','-C',join(root,'work'),'Reply with the fixture text'],env);
  assert.equal(reply.code,0,reply.stderr);assert.ok(reply.stdout.includes('native-direct-ok'),reply.stdout);assert.equal(calls.at(-1).auth,'Bearer access-a-2');installedClient=true;
  pass('installed Codex executes the configured command and completes a direct Responses turn with the selected subscription');
 }else{
  const direct=await fetch(base+'/v1/responses',{method:'POST',headers:{authorization:'Bearer '+renewed.stdout.trim(),'content-type':'application/json'},body:JSON.stringify({model:'native-response-model',input:'local fixture',store:false,stream:true})});assert.equal(direct.status,200);await direct.text();
  pass('credential command authenticates a direct native Responses stream against the isolated upstream');
 }
 lifetime=62;const switched=await rpc('switchClientProvider',{client:'codex',providerId:b.id});assert.match(switched.warning,/重启 Codex/);assert.ok(!switched.warning.includes('开启 Trace'));await rpc('updateCodexConfig',{expectedProviderId:b.id,compatibleModel:'native-response-model'});
 const cb=await config(),current=await helper(cb),old=await helper(ca);assert.equal(current.stdout.trim(),'access-b-1');assert.equal(old.stdout.trim(),'access-a-2');assert.equal((await rpc('getProviders')).selected.codex,b.id);
 pass('account switch publishes the new binding while an old client snapshot can only retrieve its original account');
 for(const change of [{accountId:'native-b'},{baseUrl:'https://other.example.test/v1'},{headers:{'ChatGPT-Account-Id':'other'}}]){
  const altered=structuredClone(ca),args=altered.model_providers[altered.model_provider].auth.args;args[1]=JSON.stringify({...JSON.parse(args[1]),...change});
  const denied=await helper(altered);assert.notEqual(denied.code,0);assert.equal(denied.stdout,'');
 }
 pass('altered account, endpoint and header bindings fail without returning a token');
 await rpc('toggleTracing',true);let live=await config();assert.equal(live.model_providers.xwx_deck.auth,undefined);await rpc('toggleTracing',false);assert.deepEqual(await config(),cb);
 pass('optional Trace temporarily replaces the credential command and restores the exact native authentication configuration');
 await rpc('signOutSubscriptionAccount',a.subscriptionAccountId);const signedOut=await helper(ca);assert.notEqual(signedOut.code,0);assert.equal(signedOut.stdout,'');assert.equal((await helper(cb)).stdout.trim(),'access-b-1');
 pass('signing out an account rejects its old command without substituting another account or breaking the selected connection');
 await stop();const beforeSettings=await readFile(join(root,'settings.json'),'utf8'),beforeConfig=await readFile(join(root,'codex/config.toml'),'utf8');
 await new Promise(r=>setTimeout(r,3100));lifetime=3600;
 const refreshing=new Promise(resolve=>refreshStarted=resolve),offline=Array.from({length:4},()=>helper(cb));await refreshing;
 start();const reopened=rpc('getState');await new Promise(r=>setTimeout(r,200));refreshRelease();
 for(const result of await Promise.all(offline)){assert.equal(result.code,0,result.stderr);assert.equal(result.stdout.trim(),'access-b-2');}
 await reopened;assert.equal(rotations.get('b'),2);assert.equal(await readFile(join(root,'settings.json'),'utf8'),beforeSettings);assert.equal(await readFile(join(root,'codex/config.toml'),'utf8'),beforeConfig);assert.equal(await readFile(join(root,'codex/auth.json'),'utf8'),auth);
 pass('closed Deck serializes concurrent one-shot refresh; application startup waits without changing client settings or the original login');
 const restarted=await helper(cb);assert.equal(restarted.stdout.trim(),'access-b-2');state=await rpc('getState');assert.equal(state.tracingEnabled,false);assert.equal(state.backgroundGatewayActive,false);
 pass('application restart retains the selected native binding and renews credentials independently of Trace');
 const snapshots=[];for(const id of ['c','d']){const p=providers.connections.find(p=>p.subscriptionAccountId==='native-'+id);await rpc('switchClientProvider',{client:'codex',providerId:p.id});await rpc('updateCodexConfig',{expectedProviderId:p.id,compatibleModel:'native-response-model'});snapshots.push(await config());}
 const held=id=>{let started,release;const entered=new Promise(resolve=>started=resolve),wait=new Promise(resolve=>release=resolve);heldRefreshes.set(id,{started,wait});return{entered,release};};
 const hc=held('c'),hd=held('d'),firstSlow=helper(snapshots[0]);await hc.entered;const timedOut=helper(snapshots[1]);const timer=setTimeout(hc.release,20000);
 await hd.entered;clearTimeout(timer);const expiredCaller=await timedOut;assert.notEqual(expiredCaller.code,0);assert.match(expiredCaller.stderr,/超时/);hd.release();heldRefreshes.clear();
 assert.equal((await firstSlow).stdout.trim(),'access-c-1');const afterTimeout=await helper(snapshots[1]);assert.equal(afterTimeout.code,0,afterTimeout.stderr);assert.equal(afterTimeout.stdout.trim(),'access-d-1');assert.equal(rotations.get('d'),1);
 await rpc('switchClientProvider',{client:'codex',providerId:b.id});assert.deepEqual(await config(),cb);assert.equal((await rpc('getState')).backgroundGatewayActive,false);await stop();
 pass('queued refresh persists its rotated credentials after the requesting command times out, without duplicate rotation or Trace');
 const report={passed:true,binarySha256:createHash('sha256').update(await readFile(nativeTestBinary)).digest('hex'),checks,installedClient,isolatedFixtures:true,requests:calls.length};await writeFile(resolve('test-results/native-auth-summary.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{if(child?.exitCode===null)child.kill();server.closeAllConnections();server.close();}
