import { nativeTestBinary } from './test-support.mjs';
import assert from 'node:assert/strict';
import {parse as parseToml} from 'smol-toml';
import {mkdtemp,realpath,readFile,writeFile,mkdir,truncate} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import {once} from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
const binary=nativeTestBinary;
const root=await mkdtemp(join(await realpath(tmpdir()),'xwx-rust-official-'));
let completeWebSocket;
const requests=[];const server=createServer(async(req,res)=>{
 let body='';for await(const b of req)body+=b;
 requests.push({path:req.url,headers:req.headers,body:body?JSON.parse(body):null});
 res.setHeader('content-type','application/json');
 res.end(JSON.stringify(req.url.includes('wham')?{account:'local fixture'}:req.url.includes('models')?{data:[{id:'fixture-model'}]}:{id:'official-fixture',object:'response',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}],usage:{input_tokens:2,output_tokens:3,total_tokens:5}}));
});
const wss=new WebSocketServer({noServer:true});server.on('upgrade',(req,socket,head)=>{requests.push({path:req.url,headers:req.headers,ws:true});wss.handleUpgrade(req,socket,head,ws=>{ws.on('message',raw=>{const body=JSON.parse(raw.toString());requests.push({path:req.url,headers:req.headers,body,wsMessage:true});ws.send(JSON.stringify({type:'response.created',response:{id:'ws-fixture'}}));ws.send(JSON.stringify({type:'response.output_text.delta',delta:'websocket OK'}));completeWebSocket=()=>ws.send(JSON.stringify({type:'response.completed',response:{id:'ws-fixture',status:'completed',model:body.model,usage:{input_tokens:2,output_tokens:3,total_tokens:5},output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'websocket OK'}]}]}}));});});});
server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
let child,queue=[];function start(){child=spawn(binary,['--rpc','--pilot-root',root,'--subscription-test-endpoint',base]);createInterface({input:child.stdout}).on('line',line=>queue.shift()?.(JSON.parse(line)));child.stderr.on('data',data=>process.stderr.write(data));}
async function call(method,...args){const value=await new Promise((res,rej)=>{const timer=setTimeout(()=>rej(Error(`timeout ${method}`)),20000);queue.push(v=>{clearTimeout(timer);res(v)});child.stdin.write(JSON.stringify({method,args})+'\n')});assert.equal(value.ok,true,value.error);return value.result;}
async function end(){const exited=once(child,'exit');child.stdin.end();assert.equal((await exited)[0],0);}
const checks=[];const pass=name=>{checks.push(name);console.log(`PASS ${name}`)};
start();
try {
 await call('getState');const config=join(root,'codex/config.toml'),auth=join(root,'codex/auth.json'),claude=join(root,'claude/settings.json');
 const oauth=JSON.stringify({tokens:{access_token:'old-local-oauth-token',refresh_token:'preserve-refresh'},account_id:'fixture-account'});
 await writeFile(config,`model="fixture-model"\nopenai_base_url="${base}/backend-api"\nchatgpt_base_url="${base}/backend-api"\nunrelated="keep"\n`);await writeFile(auth,oauth);
 const state=await call('toggleTracing',true);const url=state.localBaseUrl;
 assert.equal((await call('getCodexConfig')).authMode,'chatgpt');
 const runningConfig=await readFile(config,'utf8');assert.equal(runningConfig.match(/openai_base_url\s*=\s*"([^"]+)"/)[1],url);assert.ok(runningConfig.includes(base+'/backend-api'));
 const response=await fetch(url+'/responses?x=1',{method:'POST',headers:{'content-type':'application/json',version:'0.147.0','user-agent':'fixture-codex/0.147.0',authorization:'Bearer refreshed-local-token','chatgpt-account-id':'fixture-account'},body:JSON.stringify({model:'fixture-model',input:'local only'})});assert.equal(response.status,200);await response.json();
 assert.equal(requests.at(-1).path,'/backend-api/codex/responses?x=1');assert.equal(requests.at(-1).headers.authorization,'Bearer refreshed-local-token');assert.equal(requests.at(-1).headers.version,'0.147.0');assert.equal(requests.at(-1).headers['user-agent'],'fixture-codex/0.147.0');assert.equal(requests.at(-1).headers['chatgpt-account-id'],'fixture-account');pass('OAuth model URL, incoming refreshed credential and account header');
 const count=(await call('getState')).traces;
 const quota=await fetch(url+'/backend-api/wham/usage',{headers:{authorization:'Bearer account-local-token'}});assert.equal(quota.status,200);await quota.json();assert.equal(requests.at(-1).path,'/backend-api/wham/usage');assert.equal((await call('getState')).traces,count);
 const models=await fetch(url+'/models?client_version=1');assert.equal(models.status,200);await models.json();assert.equal(requests.at(-1).path,'/backend-api/codex/models?client_version=1');assert.equal((await call('getState')).traces,count);pass('account and catalog routes bypass Trace capture');
 const ws=new WebSocket(url.replace('http:','ws:')+'/responses?wire=1',{headers:{authorization:'Bearer refreshed-ws-token','x-codex-thread-id':'ws-session','chatgpt-account-id':'fixture-account'}});await once(ws,'open');const messages=[];const completed=new Promise(res=>ws.on('message',data=>{const message=JSON.parse(data.toString());messages.push(message);if(message.type==='response.completed')res()}));ws.send(JSON.stringify({type:'response.create',model:'fixture-model',input:'local WS fixture'}));for(let n=0;n<100&&!messages.some(m=>m.delta);n++)await new Promise(r=>setTimeout(r,20));assert.ok(messages.some(m=>m.delta));await assert.rejects(call('toggleTracing',false),/1 个回复正在生成/);assert.equal((await call('getState')).tracingEnabled,true);completeWebSocket();await completed;assert.ok(messages.some(m=>m.delta==='websocket OK'));assert.equal(requests.at(-1).path,'/backend-api/codex/responses?wire=1');assert.equal(requests.at(-1).headers.authorization,'Bearer refreshed-ws-token');
 await new Promise(res=>setTimeout(res,60));assert.equal((await call('getState')).traces,count+1);pass('real official WebSocket frame round trip and usage capture');
 const closed=once(ws,'close');await call('toggleTracing',false);await closed;
 const restored=await readFile(config,'utf8');assert.ok(restored.includes(base+'/backend-api'));assert.ok(restored.includes('unrelated="keep"'));assert.equal(await readFile(auth,'utf8'),oauth);await assert.rejects(fetch(url+'/responses',{method:'POST',body:'{}'}));pass('stop closes WebSocket and local port, restores routes and preserves login file');
 const inactiveConfig=`model_provider="openai"\nmodel="fixture-model"\nchatgpt_base_url="${base}/backend-api"\n[model_providers.xwx_deck]\nbase_url="${base}/inactive-compatible/v1"\n`;
 await writeFile(config,inactiveConfig);
 const inactive=await call('toggleTracing',true);
 const inactiveResponse=await fetch(inactive.localBaseUrl+'/responses',{method:'POST',headers:{'content-type':'application/json'},body:'{"input":"official login with inactive provider"}'});
 assert.equal(inactiveResponse.status,200);await inactiveResponse.json();
 assert.equal(requests.at(-1).path,'/backend-api/codex/responses','inactive xwx_deck must not become the official upstream');
 await call('toggleTracing',false);assert.equal(await readFile(config,'utf8'),inactiveConfig);assert.equal(await readFile(auth,'utf8'),oauth);
 pass('official OAuth uses its configured account root and ignores inactive compatible after provider switching');
 await call('switchClientProvider',{client:'codex',providerId:null,takeOverExternalConfig:true});
 await call('updateCodexEnhancements',{unifySessionHistory:true});
 const unifiedConfig=await readFile(config,'utf8');assert.match(unifiedConfig,/model_provider\s*=\s*"xwx_deck"/);
 const unified=await call('toggleTracing',true);
 const unifiedResponse=await fetch(unified.localBaseUrl+'/responses',{method:'POST',headers:{'content-type':'application/json'},body:'{"input":"active unified provider"}'});
 assert.equal(unifiedResponse.status,200,await unifiedResponse.clone().text());await unifiedResponse.json();assert.equal(requests.at(-1).path,'/backend-api/codex/responses');
 await call('toggleTracing',false);assert.equal(await readFile(config,'utf8'),unifiedConfig);assert.equal(await readFile(auth,'utf8'),oauth);
 await call('updateCodexEnhancements',{unifySessionHistory:false});pass('active unified-history provider keeps its explicit model endpoint');
 // A different app left an inactive provider table at its own local port.
 // The same native thread must follow the approved current route after reload.
 await end();start();await call('getState');
 const stale=`model_provider="openai"\nmodel="fixture-model"\nchatgpt_base_url="${base}/backend-api"\nkeep="external"\n[model_providers.xwx_deck]\nname="previous manager"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\nexperimental_bearer_token="OLD-UNRELATED-KEY"\nenv_key="OLD_UNRELATED_ENV"\nforeign="preserve"\n`;
 await writeFile(config,stale);await writeFile(auth,oauth);
 assert.equal((await call('getCodexConfig')).configOwnership,'external');
 await assert.rejects(call('switchClientProvider',{client:'codex',providerId:null}),/外部|旧会话/);
 assert.equal(await readFile(config,'utf8'),stale);
 const adopted=await call('switchClientProvider',{client:'codex',providerId:null,takeOverExternalConfig:true});
 assert.match(adopted.warning,/重启 Codex/);
 let adoptedConfig=await readFile(config,'utf8');
 assert.match(adoptedConfig,/model_provider\s*=\s*"openai"/);
 assert.ok(adoptedConfig.includes(base+'/backend-api/codex'));
 assert.ok(adoptedConfig.includes('foreign="preserve"'));
 assert.ok(!adoptedConfig.includes('OLD-UNRELATED-KEY')&&!adoptedConfig.includes('OLD_UNRELATED_ENV'));
 const thread='old-native-official-thread',history=join(root,'codex/sessions/resume-routing.jsonl');
 await mkdir(join(root,'codex/sessions'),{recursive:true});
 await writeFile(history,JSON.stringify({type:'session_meta',payload:{id:thread,model_provider:'xwx_deck'}})+'\n');
 await truncate(history,72*1024*1024); // Invalid private body must never be read for provenance.
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(root,'codex/state_resume.sqlite'));
 db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT)');db.prepare('INSERT INTO threads VALUES (?,?)').run(thread,history);db.close();
 const current=await call('toggleTracing',true);
 adoptedConfig=await readFile(config,'utf8');assert.ok(!adoptedConfig.includes('127.0.0.1:9/'));
 const aliasUrl=parseToml(adoptedConfig).model_providers.xwx_deck.base_url;assert.ok(aliasUrl.startsWith(current.localBaseUrl));
 const nativeBody={model:'fixture-model',input:[{type:'compaction',encrypted_content:'same-official-native-seal'},{role:'user',content:'continue same native thread'}]};
 const resumed=await fetch(aliasUrl+'/responses',{method:'POST',headers:{'content-type':'application/json','x-codex-thread-id':thread,authorization:'Bearer refreshed-local-token'},body:JSON.stringify(nativeBody)});
 assert.equal(resumed.status,200,await resumed.text());
 assert.equal(requests.at(-1).body.input[0].encrypted_content,'same-official-native-seal');
 assert.equal(requests.at(-1).headers.authorization,'Bearer refreshed-local-token');
 const resumedSocket=new WebSocket(aliasUrl.replace('http:','ws:')+'/responses',{headers:{'x-codex-thread-id':thread,authorization:'Bearer refreshed-local-token'}});
 await once(resumedSocket,'open');let resumedDelta=false;
 const socketDone=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('resumed WS timeout')),10000);resumedSocket.on('message',raw=>{const message=JSON.parse(raw.toString());if(message.type==='response.output_text.delta'){resumedDelta=true;completeWebSocket();}if(message.type==='response.completed'){clearTimeout(timer);resolve();}});});
 resumedSocket.send(JSON.stringify({type:'response.create',...nativeBody}));await socketDone;assert.equal(resumedDelta,true);
 assert.equal(requests.at(-1).body.input[0].encrypted_content,'same-official-native-seal');
 const socketClosed=once(resumedSocket,'close');resumedSocket.close();await socketClosed;
 await call('toggleTracing',false);adoptedConfig=await readFile(config,'utf8');assert.ok(adoptedConfig.includes(base+'/backend-api/codex'));assert.ok(!adoptedConfig.includes(current.localBaseUrl));
 assert.equal(await readFile(auth,'utf8'),oauth);
 await end();start();assert.equal((await call('getCodexConfig')).configOwnership,'deck');
 const reentered=await call('toggleTracing',true);const reenteredConfig=await readFile(config,'utf8');assert.ok(reenteredConfig.includes(reentered.localBaseUrl));await call('toggleTracing',false);
 pass('approved cross-manager alias takeover preserves official login and external fields, resumes the same large native thread, restores direct access and survives restart');
 await writeFile(config,stale.replace('model_provider="openai"','model_provider="xwx_deck"').replace('keep="external"','openai_base_url="http://127.0.0.1:9"\nkeep="external"'));
 const connected=await call('connectSubscriptionAccount','official-chatgpt');
 const officialConnection=connected.connections.find(p=>p.subscriptionAccountId==='official-chatgpt');assert.ok(officialConnection);
 await call('switchClientProvider',{client:'codex',providerId:officialConnection.id,takeOverExternalConfig:true});
 const subscriptionDirect=parseToml(await readFile(config,'utf8'));
 assert.equal(subscriptionDirect.openai_base_url,undefined);assert.equal(subscriptionDirect.chatgpt_base_url,base+'/backend-api');
 assert.equal(subscriptionDirect.model_providers.xwx_deck.env_key,undefined);
 assert.equal(subscriptionDirect.model_providers.xwx_deck.experimental_bearer_token,undefined);
 await call('updateCodexConfig',{expectedProviderId:officialConnection.id,compatibleModel:'fixture-model'});
 const subscriptionRuntime=await call('toggleTracing',true);
 const subscriptionAlias=parseToml(await readFile(config,'utf8')).model_providers.xwx_deck.base_url;
 assert.ok(subscriptionAlias.startsWith(subscriptionRuntime.localBaseUrl));
 const subscriptionResponse=await fetch(subscriptionAlias+'/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fixture-model',input:'configured official subscription resume'})});
 assert.equal(subscriptionResponse.status,200,await subscriptionResponse.text());assert.equal(requests.at(-1).path,'/backend-api/codex/responses');
 await call('toggleTracing',false);
 const subscriptionRestored=parseToml(await readFile(config,'utf8'));
 assert.equal(subscriptionRestored.openai_base_url,undefined);assert.equal(subscriptionRestored.model_providers.xwx_deck.base_url,base+'/backend-api/codex');
 assert.equal(await readFile(auth,'utf8'),oauth);assert.equal(subscriptionRestored.keep,'external');
 await call('switchClientProvider',{client:'codex',providerId:null});
 assert.equal(parseToml(await readFile(config,'utf8')).openai_base_url,undefined,'later official switches must not resurrect the dead root override');
 pass('configured official subscription takeover clears matching dead root overrides and stale credential selectors, then stops to a working direct alias while preserving independent account endpoints');

 // API takeover must clear the same root override as official takeover.
 // Then reproduce a mixed configuration left by the earlier API branch.
 const oldRoot='http://127.0.0.1:9';
 const apiTakeoverSource=stale.replace('keep="external"',`openai_base_url="${oldRoot}"\nkeep="external"`);
 await writeFile(config,apiTakeoverSource);
 await call('saveProvider',{id:'takeover-api',displayName:'Takeover API',baseUrl:base+'/v1',bearerToken:'synthetic-takeover-api',adapter:'responses',codexModel:'fixture-model'});
 await call('switchClientProvider',{client:'codex',providerId:'takeover-api',takeOverExternalConfig:true});
 let apiTakeover=await readFile(config,'utf8');
 assert.equal(parseToml(apiTakeover).openai_base_url,undefined);
 assert.equal(parseToml(apiTakeover).model_providers.xwx_deck.base_url,base+'/v1');
 assert.equal(parseToml(apiTakeover).chatgpt_base_url,base+'/backend-api');
 await writeFile(config,`openai_base_url="${oldRoot}"\n`+apiTakeover);
 assert.equal((await call('getCodexConfig')).configOwnership,'external','mixed roots must expose the existing takeover entry');
 await assert.rejects(call('switchClientProvider',{client:'codex',providerId:'takeover-api'}),/外部|接管/);
 assert.equal(parseToml(await readFile(config,'utf8')).openai_base_url,oldRoot,'unconfirmed root changes stay untouched');
 await call('switchClientProvider',{client:'codex',providerId:'takeover-api',takeOverExternalConfig:true});
 apiTakeover=await readFile(config,'utf8');
 assert.equal(parseToml(apiTakeover).openai_base_url,undefined,'saved alias origin repairs the mixed configuration');
 const apiTakeoverRuntime=await call('toggleTracing',true);
 const apiTakeoverResponse=await fetch(apiTakeoverRuntime.localBaseUrl+'/v1/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fixture-model',input:'API takeover local round trip'})});
 assert.equal(apiTakeoverResponse.status,200);await apiTakeoverResponse.json();
 assert.equal(requests.at(-1).path,'/v1/responses');assert.equal(requests.at(-1).headers.authorization,'Bearer synthetic-takeover-api');
 await call('toggleTracing',false);await end();start();await call('getState');
 assert.equal(parseToml(await readFile(config,'utf8')).openai_base_url,undefined);
 await call('switchClientProvider',{client:'codex',providerId:null});
 assert.equal(parseToml(await readFile(config,'utf8')).openai_base_url,undefined,'later official restore must not resurrect API takeover roots');
 assert.equal(await readFile(auth,'utf8'),oauth);
 // A custom path or a different loopback origin is not proven to be the alias.
 for(const rootOverride of [oldRoot+'/custom',base+'/v1']){
  await writeFile(config,apiTakeoverSource.replace(`openai_base_url="${oldRoot}"`,`openai_base_url="${rootOverride}"`));
  await call('switchClientProvider',{client:'codex',providerId:'takeover-api',takeOverExternalConfig:true});
  assert.equal(parseToml(await readFile(config,'utf8')).openai_base_url,rootOverride);
  if(rootOverride===base+'/v1'){
   const independentRuntime=await call('toggleTracing',true);
   assert.equal((await call('getCodexConfig')).configOwnership,'deck','an independent local API root is not a stale proxy after Trace rewrites the alias');
   const independentResponse=await fetch(independentRuntime.localBaseUrl+'/v1/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fixture-model',input:'independent local root retained'})});
   assert.equal(independentResponse.status,200);await independentResponse.json();
   await call('toggleTracing',false);
   assert.equal(parseToml(await readFile(config,'utf8')).openai_base_url,rootOverride);
  }
 }
 await call('switchClientProvider',{client:'codex',providerId:null});
 pass('API takeover clears proven stale roots, repairs mixed aliases, preserves independent overrides and login, completes a request and stays clean after stop/restart/official restore');

 await writeFile(config,`openai_base_url="${base}/v1"\nchatgpt_base_url="${base}/unused-account-root"\n[model_providers.xwx_deck]\nbase_url="${base}/inactive-compatible/v1"\n`);await writeFile(auth,JSON.stringify({OPENAI_API_KEY:'file-local-key'}));
 const api=await call('toggleTracing',true);const apiResponse=await fetch(api.localBaseUrl+'/v1/responses',{method:'POST',headers:{'content-type':'application/json'},body:'{"input":"API fixture"}'});assert.equal(apiResponse.status,200);await apiResponse.json();assert.equal(requests.at(-1).path,'/v1/responses');assert.equal(requests.at(-1).headers.authorization,'Bearer file-local-key');await call('toggleTracing',false);pass('API-key official route works with missing TOML model/provider fields');
 await call('toggleClient','codex-cli');await writeFile(claude,JSON.stringify({env:{ANTHROPIC_BASE_URL:base,OTHER:'preserve'},preferences:{theme:'dark'}}));
 const officialClaude=await call('toggleTracing',true);const claudeResponse=await fetch(officialClaude.localBaseUrl+'/v1/messages',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer claude-oauth','x-api-key':'claude-api-key','anthropic-beta':'oauth-fixture'},body:'{"model":"claude-sonnet","messages":[],"max_tokens":1}'});assert.equal(claudeResponse.status,200);await claudeResponse.json();assert.equal(requests.at(-1).headers.authorization,'Bearer claude-oauth');assert.equal(requests.at(-1).headers['x-api-key'],'claude-api-key');assert.equal(requests.at(-1).headers['anthropic-beta'],'oauth-fixture');await call('toggleTracing',false);assert.equal(JSON.parse(await readFile(claude,'utf8')).env.ANTHROPIC_BASE_URL,base);pass('official Claude incoming auth/beta headers and field-safe restoration');
 await end();console.log(JSON.stringify({root,passed:true,checks}));
} finally {if(child?.exitCode===null)child.kill('SIGKILL');for(const ws of wss.clients)ws.terminate();await new Promise(res=>server.close(res));wss.close();}
