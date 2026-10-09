import { nativeTestBinary } from './test-support.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import {once} from 'node:events';
import WebSocket,{WebSocketServer} from 'ws';
const binary=nativeTestBinary;
const root=await mkdtemp(join(await realpath(tmpdir()),'xwx-rust-official-'));
const requests=[];const server=createServer(async(req,res)=>{
 let body='';for await(const b of req)body+=b;
 requests.push({path:req.url,headers:req.headers,body:body?JSON.parse(body):null});
 res.setHeader('content-type','application/json');
 res.end(JSON.stringify(req.url.includes('wham')?{account:'local fixture'}:req.url.includes('models')?{data:[{id:'fixture-model'}]}:{id:'official-fixture',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}],usage:{input_tokens:2,output_tokens:3,total_tokens:5}}));
});
const wss=new WebSocketServer({noServer:true});server.on('upgrade',(req,socket,head)=>{requests.push({path:req.url,headers:req.headers,ws:true});wss.handleUpgrade(req,socket,head,ws=>{ws.on('message',raw=>{const body=JSON.parse(raw.toString());ws.send(JSON.stringify({type:'response.created',response:{id:'ws-fixture'}}));ws.send(JSON.stringify({type:'response.output_text.delta',delta:'websocket OK'}));ws.send(JSON.stringify({type:'response.completed',response:{id:'ws-fixture',status:'completed',model:body.model,usage:{input_tokens:2,output_tokens:3,total_tokens:5},output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'websocket OK'}]}]}}));});});});
server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
let child,queue=[];function start(){child=spawn(binary,['--rpc','--pilot-root',root]);createInterface({input:child.stdout}).on('line',line=>queue.shift()?.(JSON.parse(line)));child.stderr.on('data',data=>process.stderr.write(data));}
async function call(method,...args){const value=await new Promise((res,rej)=>{const timer=setTimeout(()=>rej(Error(`timeout ${method}`)),20000);queue.push(v=>{clearTimeout(timer);res(v)});child.stdin.write(JSON.stringify({method,args})+'\n')});assert.equal(value.ok,true,value.error);return value.result;}
async function end(){const exited=once(child,'exit');child.stdin.end();assert.equal((await exited)[0],0);}
const pass=name=>console.log(`PASS ${name}`);
start();
try {
 await call('getState');const config=join(root,'codex/config.toml'),auth=join(root,'codex/auth.json'),claude=join(root,'claude/settings.json');
 const oauth=JSON.stringify({tokens:{access_token:'old-local-oauth-token',refresh_token:'preserve-refresh'},account_id:'fixture-account'});
 await writeFile(config,`model="fixture-model"\nopenai_base_url="${base}/backend-api"\nchatgpt_base_url="https://chatgpt.com/backend-api"\nunrelated="keep"\n`);await writeFile(auth,oauth);
 const state=await call('toggleTracing',true);const url=state.localBaseUrl;
 assert.equal((await call('getCodexConfig')).authMode,'chatgpt');
 const runningConfig=await readFile(config,'utf8');assert.equal(runningConfig.match(/openai_base_url\s*=\s*"([^"]+)"/)[1],url);assert.ok(runningConfig.includes('https://chatgpt.com/backend-api'));
 const response=await fetch(url+'/responses?x=1',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer refreshed-local-token','chatgpt-account-id':'fixture-account'},body:JSON.stringify({model:'fixture-model',input:'local only'})});assert.equal(response.status,200);await response.json();
 assert.equal(requests.at(-1).path,'/backend-api/codex/responses?x=1');assert.equal(requests.at(-1).headers.authorization,'Bearer refreshed-local-token');assert.equal(requests.at(-1).headers['chatgpt-account-id'],'fixture-account');pass('OAuth model URL, incoming refreshed credential and account header');
 const count=(await call('getState')).traces;
 assert.equal((await fetch(url+'/backend-api/wham/usage',{headers:{authorization:'Bearer account-local-token'}})).status,200);assert.equal(requests.at(-1).path,'/backend-api/wham/usage');assert.equal((await call('getState')).traces,count);
 assert.equal((await fetch(url+'/models?client_version=1')).status,200);assert.equal(requests.at(-1).path,'/backend-api/codex/models?client_version=1');assert.equal((await call('getState')).traces,count);pass('account and catalog routes bypass Trace capture');
 const ws=new WebSocket(url.replace('http:','ws:')+'/responses?wire=1',{headers:{authorization:'Bearer refreshed-ws-token','x-codex-thread-id':'ws-session','chatgpt-account-id':'fixture-account'}});await once(ws,'open');const messages=[];const completed=new Promise(res=>ws.on('message',data=>{const message=JSON.parse(data.toString());messages.push(message);if(message.type==='response.completed')res()}));ws.send(JSON.stringify({type:'response.create',model:'fixture-model',input:'local WS fixture'}));await completed;assert.ok(messages.some(m=>m.delta==='websocket OK'));assert.equal(requests.at(-1).path,'/backend-api/codex/responses?wire=1');assert.equal(requests.at(-1).headers.authorization,'Bearer refreshed-ws-token');
 await new Promise(res=>setTimeout(res,60));assert.equal((await call('getState')).traces,count+1);pass('real official WebSocket frame round trip and usage capture');
 const closed=once(ws,'close');await call('toggleTracing',false);await closed;
 const restored=await readFile(config,'utf8');assert.ok(restored.includes(base+'/backend-api'));assert.ok(restored.includes('unrelated="keep"'));assert.equal(await readFile(auth,'utf8'),oauth);await assert.rejects(fetch(url+'/responses',{method:'POST',body:'{}'}));pass('stop closes WebSocket and local port, restores routes and preserves login file');
 await writeFile(config,`openai_base_url="${base}/v1"\n`);await writeFile(auth,JSON.stringify({OPENAI_API_KEY:'file-local-key'}));
 const api=await call('toggleTracing',true);assert.equal((await fetch(api.localBaseUrl+'/v1/responses',{method:'POST',headers:{'content-type':'application/json'},body:'{"input":"API fixture"}'})).status,200);assert.equal(requests.at(-1).path,'/v1/responses');assert.equal(requests.at(-1).headers.authorization,'Bearer file-local-key');await call('toggleTracing',false);pass('API-key official route works with missing TOML model/provider fields');
 await call('toggleClient','codex-cli');await writeFile(claude,JSON.stringify({env:{ANTHROPIC_BASE_URL:base,OTHER:'preserve'},preferences:{theme:'dark'}}));
 const officialClaude=await call('toggleTracing',true);assert.equal((await fetch(officialClaude.localBaseUrl+'/v1/messages',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer claude-oauth','x-api-key':'claude-api-key','anthropic-beta':'oauth-fixture'},body:'{"model":"claude-sonnet","messages":[],"max_tokens":1}'})).status,200);assert.equal(requests.at(-1).headers.authorization,'Bearer claude-oauth');assert.equal(requests.at(-1).headers['x-api-key'],'claude-api-key');assert.equal(requests.at(-1).headers['anthropic-beta'],'oauth-fixture');await call('toggleTracing',false);assert.equal(JSON.parse(await readFile(claude,'utf8')).env.ANTHROPIC_BASE_URL,base);pass('official Claude incoming auth/beta headers and field-safe restoration');
 await end();console.log(JSON.stringify({root,passed:7}));
} finally {if(child?.exitCode===null)child.kill('SIGKILL');for(const ws of wss.clients)ws.terminate();await new Promise(res=>server.close(res));wss.close();}
