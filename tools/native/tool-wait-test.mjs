import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { nativeTestBinary } from './test-support.mjs';

const root=await mkdtemp(join(await realpath(tmpdir()),'xwxdeck-tool-wait-'));
const checks=[], requests=[];let serial=0,releaseHeld;
const task={role:'user',content:'isolated tool task'};
const call={type:'function_call',call_id:'reused-call',name:'lookup',arguments:'{"q":1}'};
const result={type:'function_call_output',call_id:call.call_id,output:'read-only result'};
const frame=v=>'data: '+JSON.stringify(v)+'\n\n';
function response(body,wire) {
  const tools=['tool','cut','two-tools'].includes(body.model), id='tool-fixture-'+(++serial);
  if(wire==='messages')return{id,type:'message',role:'assistant',model:body.model,content:tools?[{type:'tool_use',id:call.call_id,name:call.name,input:{q:1}}]:[{type:'text',text:'accepted once'}],stop_reason:tools?'tool_use':'end_turn',usage:{input_tokens:2,output_tokens:1}};
  if(wire==='chat')return{id,object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:tools?null:'accepted once',...(tools?{tool_calls:[{id:call.call_id,type:'function',function:{name:call.name,arguments:call.arguments}}]}:{})},finish_reason:tools?'tool_calls':'stop'}],usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}};
  return{id,object:'response',status:'completed',model:body.model,output:tools?[{...call,id:'item-'+id,status:'completed'},...(body.model==='two-tools'?[{...call,call_id:'second-call',id:'second-item-'+id,status:'completed'}]:[])]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'accepted once'}]}],usage:{input_tokens:2,output_tokens:1,total_tokens:3}};
}
const upstream=createServer(async(req,res)=>{
  if(req.url.endsWith('/models')){res.end('{"data":[]}');return;}
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests.push({path:req.url,model:body.model,transport:'http'});
  if(body.model==='refused'){res.writeHead(400,{'content-type':'application/json'});res.end('{"error":{"message":"synthetic rejection"}}');return;}
  if(body.model==='disconnect'){req.socket.destroy();return;}
  if(body.model==='hold'){await new Promise(resolve=>releaseHeld=resolve);}
  const wire=req.url.endsWith('/messages')?'messages':req.url.endsWith('/chat/completions')?'chat':'responses';const value=response(body,wire);
  if(!body.stream){res.setHeader('content-type','application/json');res.end(JSON.stringify(value)+(body.model==='trailing'?'invalid trailing bytes':''));return;}
  res.writeHead(200,{'content-type':'text/event-stream'});
  if(body.model==='failed-stream'){res.end(frame({type:'response.failed',response:{id:value.id,status:'failed',error:{message:'synthetic stream failure'}}}));return;}
  let events;
  if(wire==='messages')events=[{type:'message_start',message:{...value,content:[],stop_reason:null}},{type:'content_block_start',index:0,content_block:{type:'tool_use',id:call.call_id,name:call.name,input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:call.arguments}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:1}},{type:'message_stop'}];
  else if(wire==='chat')events=[{id:value.id,model:body.model,choices:[{index:0,delta:{tool_calls:[{index:0,id:call.call_id,type:'function',function:{name:call.name,arguments:call.arguments}}]},finish_reason:null}]},{id:value.id,model:body.model,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]}];
  else events=[{type:'response.output_item.added',item:value.output[0]},{type:'response.completed',response:value}];
  if(body.model==='cut')events=events.slice(0,1);
  // Split inside JSON and CRLF boundaries; a terminal arrives before the body lease ends.
  const text=events.map(frame).join('').replaceAll('\n','\r\n');const cut=Math.floor(text.length/2);res.write(text.slice(0,cut));setTimeout(()=>res.end(text.slice(cut)),10);
});
upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const base=`http://127.0.0.1:${upstream.address().port}/v1`;
const wss=new WebSocketServer({server:upstream});wss.on('connection',socket=>socket.on('message',raw=>{const body=JSON.parse(raw.toString());requests.push({path:'/v1/responses',model:body.model,transport:'websocket'});const value=response(body,'responses');if(body.model==='refused'){socket.send(JSON.stringify({type:'response.failed',response:{id:value.id,status:'failed',error:{message:'synthetic WS failure'}}}));return;}if(body.model==='tool')socket.send(JSON.stringify({type:'response.output_item.added',item:value.output[0]}));socket.send(JSON.stringify({type:'response.completed',response:value}));}));
const child=spawn(nativeTestBinary,['--rpc','--pilot-root',root],{stdio:['pipe','pipe','inherit']});const pending=new Map();let sequence=0;
createInterface({input:child.stdout}).on('line',line=>{const v=JSON.parse(line),p=pending.get(v.requestId);if(p){clearTimeout(p.timer);pending.delete(v.requestId);v.ok?p.resolve(v.result):p.reject(Error(v.error));}});
const rpc=(method,...args)=>new Promise((resolve,reject)=>{const requestId=++sequence,timer=setTimeout(()=>{pending.delete(requestId);reject(Error(method+' timeout'));},20000);pending.set(requestId,{resolve,reject,timer});child.stdin.write(JSON.stringify({requestId,method,args})+'\n');});
const pass=name=>{checks.push(name);console.log('PASS '+name);};
const wait=async(fn)=>{for(let n=0;n<100;n++){if(await fn())return;await delay(20);}throw Error('state wait timed out');};
let state;
async function select(adapter,client='codex',name=adapter){const registry=await rpc('saveProvider',{displayName:name,baseUrl:base,bearerToken:'SYNTHETIC-TOOL-WAIT',adapter,codexModel:'fixture'});const id=registry.connections.at(-1).id;await rpc('switchClientProvider',{client,providerId:id});state=await rpc('toggleTracing',true);return id;}
async function post(input,{model='accept',session='tool-session',stream=false,path='/v1/responses',messages}={}){const body=messages?{model,messages,max_tokens:64,stream}:{model,input,stream};const r=await fetch(state.localBaseUrl+path,{method:'POST',headers:{'content-type':'application/json','x-session-id':session},body:JSON.stringify(body)});const text=await r.text();return{status:r.status,text,json:()=>JSON.parse(text)};}
async function waiting(n){await wait(async()=>{const s=await rpc('getState');return s.activeRequests===0&&s.waitingTools===n;});}
async function busy(){const bytes=await readFile(join(root,'codex/config.toml'),'utf8');await assert.rejects(rpc('toggleTracing',false),/工具调用仍在等待/);assert.equal((await rpc('getState')).tracingEnabled,true);assert.equal(await readFile(join(root,'codex/config.toml'),'utf8'),bytes);}
try{
 await rpc('getState');await select('responses');const first=await post([task],{model:'tool'});assert.equal(first.status,200);await waiting(1);await busy();pass('JSON tool completion releases HTTP activity but ordinary stop retains Gateway and client configuration');
 await post([task,call,result],{session:'other-session'});await waiting(1);
 await post([result]);await waiting(1);
 await post([task,{...call,arguments:'{"q":2}'},result]);await waiting(1);
 await post([{...task,content:'different task'},call,result]);await waiting(1);
 assert.equal((await post([task],{model:'refused'})).status,400);await waiting(1);
 await post([task,call,call,result]);await waiting(1);pass('foreign session, ID-only result, changed arguments/context and duplicate call history cannot release the wait');
 assert.equal((await post([task,call,result],{model:'refused'})).status,400);await waiting(0);pass('verified returned tool result clears its wait even when the next generation is rejected');
 await post([task],{model:'tool'});await waiting(1);
 await post([task,call,result],{model:'trailing'});await waiting(0);pass('verified returned tool result clears its wait even when the next response body is malformed');
 for(const [model,stream]of[['disconnect',false],['failed-stream',true]]){
   await post([task],{model:'tool'});await waiting(1);
   const next=await post([task,call,result],{model,stream});assert.equal(next.status,model==='disconnect'?502:200);await waiting(0);
   await rpc('toggleTracing',false);state=await rpc('toggleTracing',true);pass(`returned result permits ordinary stop after ${model} without restarting Gateway`);
 }
 await post([task],{model:'tool'});await waiting(1);
 // Gateway admission can precede the upstream handler. Observe rejection now,
 // then assert success after releasing the explicitly ready upstream fixture.
 const held=post([task,call,result],{model:'hold'}).then(value=>({value}),error=>({error}));
 await wait(async()=>{const s=await rpc('getState');return s.activeRequests===1&&s.waitingTools===0&&typeof releaseHeld==='function';});
 await assert.rejects(rpc('toggleTracing',false),/回复正在生成|连接仍在使用/);releaseHeld();
 const completedHeld=await held;if(completedHeld.error)throw completedHeld.error;assert.equal(completedHeld.value.status,200);await waiting(0);pass('returned tools retire during a slow next reply while active HTTP generation still blocks ordinary stop');
 await post([task],{model:'two-tools'});await waiting(2);
 assert.equal((await post([task,call,result],{model:'refused'})).status,400);await waiting(1);await busy();
 await post([task,call,result,{...call,call_id:'second-call'},{...result,call_id:'second-call'}]);await waiting(0);pass('a failed next reply retires only the returned subset and preserves the tool that still has no result');
 await post([task],{model:'tool'});await waiting(1);
 await post([task,call,result]);await waiting(0);await rpc('toggleTracing',false);pass('matching accepted tool result permits ordinary stop and restores direct routing');
 state=await rpc('toggleTracing',true);await post([task],{model:'tool',stream:true});await waiting(1);await select('responses','codex','Second_Same_Type_Provider');await post([task,call,result]);await waiting(0);await rpc('toggleTracing',false);pass('complete same-session tool lineage continues across explicit provider handoff without replay');
 state=await rpc('toggleTracing',true);await post([task],{model:'tool'});await waiting(1);await post([task,call,result]);await waiting(0);
 const next=[task,call,result,{role:'assistant',content:'accepted once'},{role:'user',content:'next tool task'}];await post(next,{model:'tool'});await waiting(1);await post([task,call,result]);await waiting(1);await post([...next,call,result]);await waiting(0);await rpc('toggleTracing',false);pass('a reused tool ID belongs to its new context; replaying an older completed history does not discharge it');
 for(const [adapter,client,path,stream]of[['anthropic-messages','claude','/v1/messages',false],['anthropic-messages','claude','/v1/messages',true],['chat-completions','codex','/v1/chat/completions',false],['chat-completions','codex','/v1/chat/completions',true],['chat-completions','codex','/v1/responses',true],['responses','claude','/v1/messages',false]]){
   await select(adapter,client,'wire-'+checks.length+'-'+stream);const messages=path.endsWith('/messages')?[{role:'user',content:task.content}]:path.endsWith('/chat/completions')?[task]:undefined;
   await post([task],{model:'tool',path,stream,messages});await waiting(1);await busy();
   const follow=path.endsWith('/messages')?[...messages,{role:'assistant',content:[{type:'tool_use',id:call.call_id,name:call.name,input:{q:1}}]},{role:'user',content:[{type:'tool_result',tool_use_id:call.call_id,content:result.output}]}]:messages?[...messages,{role:'assistant',content:null,tool_calls:[{id:call.call_id,type:'function',function:{name:call.name,arguments:call.arguments}}]},{role:'tool',tool_call_id:call.call_id,content:result.output}]:undefined;
   await post([task,call,result],{path,messages:follow});await waiting(0);await rpc('toggleTracing',false);pass(`${adapter} → ${path} ${stream?'SSE':'JSON'} tracks actual client tool identity and accepted result`);
 }
 await select('responses');await post([task],{model:'cut',stream:true});await waiting(1);await busy();const before=requests.length;await rpc('toggleTracing',false,true);assert.equal(requests.length,before);await assert.rejects(fetch(state.localBaseUrl+'/v1/responses'));assert.doesNotMatch(await readFile(join(root,'codex/config.toml'),'utf8'),/127\.0\.0\.1:452(?:3[3-9]|4[0-2])/);pass('truncated emitted tool keeps an actionable wait; explicit force restores direct and never repeats the request');
 state=await rpc('toggleTracing',true);const ws=new WebSocket(state.localBaseUrl.replace('http:','ws:')+'/v1/responses',{headers:{'x-codex-thread-id':'ws-tool-session'}});await once(ws,'open');
 const turn=body=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('WebSocket timeout')),5000);const handler=raw=>{const v=JSON.parse(raw.toString());if(['response.completed','response.failed'].includes(v.type)){clearTimeout(timer);ws.off('message',handler);resolve(v.response);}};ws.on('message',handler);ws.send(JSON.stringify({type:'response.create',...body}));});
 const initial=await turn({model:'tool',input:[task]});await waiting(1);await busy();await turn({model:'accept',previous_response_id:initial.id,input:[result]});await waiting(0);pass('WebSocket terminal protects tool waiting; verified previous_response_id result restores lineage');
 const wsTool=await turn({model:'tool',input:[{...task,content:'WS failure test'}]});await waiting(1);assert.equal((await turn({model:'refused',previous_response_id:wsTool.id,input:[result]})).status,'failed');await waiting(0);
 const closed=once(ws,'close');ws.close();await closed;await rpc('toggleTracing',false);pass('WebSocket returned result permits ordinary stop even when the next generation fails');
 const report={passed:true,checks,requests,binarySha256:createHash('sha256').update(await readFile(nativeTestBinary)).digest('hex'),isolatedFixtures:true,realPlatformAuthorization:false};await writeFile('test-results/native-tool-wait-summary.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{
 releaseHeld?.();
 if(child.exitCode===null){await rpc('toggleTracing',false,true).catch(()=>{});child.stdin.end();await once(child,'exit');}
 for(const socket of wss.clients)socket.terminate();await new Promise(r=>wss.close(r));upstream.closeAllConnections();await new Promise(r=>upstream.close(r));await rm(root,{recursive:true,force:true});
}
