import { nativeTestBinary } from './test-support.mjs';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, readFile, readdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';
const root=await mkdtemp(join(await realpath(tmpdir()),'xwx-portability-regression-'));
const calls=[];let counter=0;
const checks=[];const pass=name=>{checks.push(name);console.log('PASS '+name)};
const upstream=createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 const body=JSON.parse(raw);calls.push({path:req.url,body,auth:req.headers.authorization});
 const id='fixture-'+(++counter);const send=v=>'data: '+JSON.stringify(v)+'\n\n';
 if(req.url.endsWith('/chat/completions')){
  const tool=body.tools?.[0]?.function?.name;
  const message={role:'assistant',content:'first second',...(tool?{reasoning_content:'thought',tool_calls:[{id:'call-'+id,type:'function',function:{name:tool,arguments:'{"q":"value"}'}}]}:{})};
  if(body.stream){
   res.writeHead(200,{'content-type':'text/event-stream'});
   res.write(send({id,model:body.model,choices:[{delta:{content:'first ',...(tool?{reasoning_content:'thought',tool_calls:[{index:0,id:'call-'+id,type:'function',function:{name:tool,arguments:'{"q":'}}]}:{})},finish_reason:null}]}));
   setTimeout(()=>{
    if(body.model==='cut'){res.end();return;}
    res.end(send({id,model:body.model,choices:[{delta:{content:'second',...(tool?{tool_calls:[{index:0,function:{arguments:body.model==='bad-tool'?'':'"value"}'}}]}:{})},finish_reason:body.model==='bad-tool'?'length':tool?'tool_calls':'stop'}]})+'data: [DONE]\n\n');
   },350);
  }else{res.setHeader('content-type','application/json');res.end(JSON.stringify({id,model:body.model,choices:[{message,finish_reason:tool?'tool_calls':'stop'}]}));}
 }else if(req.url.endsWith('/messages')){
  res.writeHead(200,{'content-type':'text/event-stream'});
  const events=[{type:'message_start',message:{id,model:body.model,usage:{input_tokens:1}}},{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}},{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'thought'}},{type:'content_block_stop',index:0},{type:'content_block_start',index:1,content_block:{type:'text',text:''}},{type:'content_block_delta',index:1,delta:{type:'text_delta',text:'first second'}},{type:'content_block_stop',index:1},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},...(body.model==='cut'?[]:[{type:'message_stop'}])];res.end(events.map(send).join(''));
 }else{
  const output=body.model==='sealed'?[{id:'rs-'+id,type:'reasoning',encrypted_content:'private-seal-'+id,summary:[{type:'summary_text',text:'visible thought'}]},{type:'compaction',encrypted_content:'compact-seal-'+id}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'first second'}]}];
  const response={id,object:req.url.endsWith('/compact')?'response.compaction':'response',status:'completed',model:body.model,output};
  res.setHeader('content-type','text/event-stream');res.end('event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response})+'\n\n');
 }
});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const base=`http://127.0.0.1:${upstream.address().port}/v1`;
const wsUpstream=new WebSocketServer({server:upstream});
wsUpstream.on('connection',(socket,req)=>socket.on('message',raw=>{
 const body=JSON.parse(raw.toString());calls.push({path:req.url,body,auth:req.headers.authorization,transport:'ws'});const id='ws-fixture-'+(++counter);
 socket.send(JSON.stringify({type:'response.output_text.delta',delta:'first '}));
 setTimeout(()=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'response.completed',response:{id,object:'response',status:'completed',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'first second'}]}]}}))},350);
}));
async function openSocket(state){const socket=new WebSocket(state.localBaseUrl.replace('http:','ws:')+'/v1/responses',{headers:{'x-codex-thread-id':'ws-thread'}});socket.on('error',()=>{});await once(socket,'open');return socket;}
async function wsReply(socket,body,afterDelta){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('WS reply timeout')),3000);const listen=raw=>{const value=JSON.parse(raw.toString());if(value.type==='response.output_text.delta'&&afterDelta){const action=afterDelta;afterDelta=null;void action().catch(reject)}if(value.type==='response.completed'){clearTimeout(timer);socket.off('message',listen);resolve(value.response)}if(value.type==='error'){clearTimeout(timer);reject(Error(JSON.stringify(value)))}};socket.on('message',listen);socket.send(JSON.stringify({type:'response.create',...body}));});}
const child=spawn(nativeTestBinary,['--rpc','--pilot-root',root],{stdio:['pipe','pipe','inherit']});
const pending=[];createInterface({input:child.stdout}).on('line',line=>pending.shift()?.(JSON.parse(line)));
async function rpc(method,...args){const v=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('RPC timeout '+method)),20000);pending.push(v=>{clearTimeout(timer);resolve(v)});child.stdin.write(JSON.stringify({method,args})+'\n')});assert.equal(v.ok,true,v.error);return v.result;}
async function add(id,adapter='chat-completions'){const existing=(await rpc('getProviders')).connections.find(p=>p.displayName===id);await rpc('saveProvider',{...(existing?{id:existing.id}:{}),displayName:id,baseUrl:base,bearerToken:'fixture-'+id,adapter,codexModel:'model'});}
async function select(id,client='codex'){await rpc('switchClientProvider',{client,providerId:id});if(client==='claude')await rpc('updateClaudeModels',{sonnet:'model'});return rpc('getState');}
async function post(state,body,client='codex',session='fixture-thread',path){return fetch(state.localBaseUrl+(path??(client==='codex'?'/v1/responses':'/v1/messages')),{method:'POST',headers:{'content-type':'application/json','x-codex-thread-id':session},body:JSON.stringify(body)});}
async function json(state,body,...rest){const r=await post(state,body,...rest);assert.equal(r.status,200,await r.clone().text());const raw=await r.text();if(raw.startsWith('event:'))return JSON.parse(raw.split('\n').find(v=>v.startsWith('data: ')).slice(6)).response;return JSON.parse(raw);}
const tool={type:'function',name:'lookup',parameters:{type:'object',properties:{q:{type:'string'}}}};
try{
 await add('A');await add('B');await add('Native','responses');await add('Messages','anthropic-messages');await select('A');let state=await rpc('toggleTracing',true);const originalBase=state.localBaseUrl;
 const first=await json(state,{model:'model',input:'retained history'});
 await select('B');state=await rpc('getState');assert.equal(state.localBaseUrl,originalBase);
 await json(state,{model:'different-model',previous_response_id:first.id,input:'next turn'});assert.ok(calls.at(-1).body.messages.some(v=>v.content==='retained history'));assert.equal(calls.at(-1).auth,'Bearer fixture-B');pass('provider and model changes retain session history on the same listener');
 for(const client of ['codex','claude']){
  await select('A',client);const body=client==='codex'?{model:'model',input:'slow',stream:true,tools:[tool]}:{model:'sonnet',max_tokens:32,messages:[{role:'user',content:'slow'}],stream:true};
  const started=Date.now();const r=await post(state,body,client);const reader=r.body.getReader();let stream='',textAt;
  while(!stream.includes(client==='codex'?'response.output_text.delta':'text_delta')){const p=await reader.read();assert.equal(p.done,false);stream+=new TextDecoder().decode(p.value)}textAt=Date.now()-started;
  await select('B',client);await add('Unused');await rpc('setTraceStoragePolicy',{maxBytes:1024*1024*1024,autoCleanup:true});
  for(;;){const p=await reader.read();if(p.done)break;stream+=new TextDecoder().decode(p.value)}
  assert.ok(textAt<280,`text took ${textAt}ms`);assert.match(stream,client==='codex'?/response.completed/:/message_stop/);assert.ok(!stream.includes('Gateway 已停止'));assert.equal((await rpc('getState')).localBaseUrl,originalBase);
  if(client==='codex'){assert.match(stream,/response.function_call_arguments.delta/);assert.match(stream,/response.function_call_arguments.done/);const events=stream.split('\n\n').map(v=>v.split('\n').find(v=>v.startsWith('data: '))).filter(Boolean).map(v=>JSON.parse(v.slice(6)));assert.deepEqual(events.map(v=>v.sequence_number),events.map((_,i)=>i));}
  pass(`${client}: early text and complete active reply survive provider, unrelated config and storage changes`);
 }
 await select('B');state=await rpc('getState');
 for(const model of ['cut','bad-tool']){const raw=await(await post(state,{model,input:'must not replay',stream:true,...(model==='bad-tool'?{tools:[tool]}:{})})).text();assert.match(raw,/response.failed/);assert.ok(!raw.includes('response.completed'));assert.ok(!raw.includes('response.function_call_arguments.done'));}pass('truncated streams and partial tool arguments never become successful completed calls');
 const count=calls.length;const r=await post(state,{model:'model',input:'explicit stop',stream:true});const reader=r.body.getReader();await reader.read();await rpc('toggleTracing',false);let stopped='';for(;;){const p=await reader.read();if(p.done)break;stopped+=new TextDecoder().decode(p.value)}assert.match(stopped,/response.failed/);assert.equal(calls.length,count+1);pass('explicit stop interrupts once without replaying the request');state=await rpc('toggleTracing',true);
 await json(state,{model:'model',input:[{type:'reasoning',content:[{type:'reasoning_text',text:'required reasoning'}]},{type:'function_call',call_id:'old',name:'lookup',arguments:'{}'},{type:'function_call_output',call_id:'old',output:'result'}],tools:[tool]});assert.ok(calls.at(-1).body.messages.some(v=>v.role==='assistant'&&v.reasoning_content==='required reasoning'));pass('tool continuation carries visible reasoning to Chat');
 await select('B','claude');await json(state,{model:'sonnet',max_tokens:32,messages:[{role:'assistant',content:[{type:'tool_use',id:'image-tool',name:'lookup',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'image-tool',content:[{type:'text',text:'screenshot'},{type:'image',source:{type:'base64',media_type:'image/png',data:'image-marker'}}]}]}]},'claude');assert.ok(JSON.stringify(calls.at(-1).body).includes('data:image/png;base64,image-marker'));pass('tool-result image and text survive Claude to Chat conversion');
 const priorCount=calls.length;const bad=await post(state,{model:'sonnet',max_tokens:32,messages:[{role:'user',content:[{type:'document',source:{type:'text',data:'critical'}}]}]},'claude');assert.equal(bad.status,400);assert.equal(calls.length,priorCount);pass('unsupported documents fail visibly before forwarding rather than losing content');
 await select('Messages');const thinking=await(await post(state,{model:'model',input:'thinking',stream:true})).text();assert.match(thinking,/reasoning_summary_text.delta/);assert.match(thinking,/response.completed/);const cut=await(await post(state,{model:'cut',input:'cut',stream:true})).text();assert.match(cut,/response.failed/);assert.ok(!cut.includes('response.completed'));pass('Messages thinking survives streaming conversion and missing message_stop fails');
 await select('B');const compact=await json(state,{model:'model',input:'compact original history'},'codex','fixture-thread','/v1/responses/compact');await select('Native');await json(state,{model:'model',input:[compact.output[0],{role:'user',content:'resume'}]});assert.ok(!JSON.stringify(calls.at(-1).body).includes('xwxc1:'));assert.match(JSON.stringify(calls.at(-1).body),/context checkpoint/);pass('converted compaction checkpoint becomes plaintext on native Responses route');
 await json(state,{model:'model',input:'native string'},'codex','native-format');assert.equal(calls.at(-1).body.input,'native string');pass('native Responses preserves original input representation');
 const sealed=await json(state,{model:'sealed',input:'recover full precompact context'},'codex','seal-thread');await select('A');await add('NativeB','responses');await select('NativeB');await json(state,{model:'model',input:[...sealed.output,{role:'user',content:'continue'}]},'codex','seal-thread');const forwarded=JSON.stringify(calls.at(-1).body);assert.ok(!forwarded.includes('private-seal-'));assert.ok(!forwarded.includes('compact-seal-'));assert.match(forwarded,/recover full precompact context/);pass('known foreign ciphertext is replaced only with recoverable session history');
 await select('Native');
 const unknown=await post(state,{model:'model',input:[{type:'compaction',encrypted_content:'unrecoverable-state'}]},'codex','seal-thread');assert.equal(unknown.status,400);pass('unrecoverable foreign compaction asks for original context without silent stripping');
 const nativeFirst=await json(state,{model:'model',input:'native cache before terminal'},'codex','native-cache');await select('B');await json(state,{model:'model',previous_response_id:nativeFirst.id,input:'immediate next'},'codex','native-cache');assert.match(JSON.stringify(calls.at(-1).body),/native cache before terminal/);pass('native terminal response publishes continuation before immediate next turn');
 async function files(path){let out=[];for(const name of await readdir(path,{withFileTypes:true})){const p=join(path,name.name);out.push(...(name.isDirectory()?await files(p):[p]))}return out}
 const cached=(await Promise.all((await files(join(root,'continuations'))).map(p=>readFile(p,'utf8')))).join('\n');assert.ok(!cached.includes('private-seal-'));assert.ok(!cached.includes('compact-seal-'));assert.ok(!cached.includes('fixture-A'));pass('continuation records keep no credentials or raw ciphertext');
 await select('Native');const ws1=await openSocket(state);const closing=once(ws1,'close');const wsFirst=await wsReply(ws1,{model:'model',input:'retained websocket history'},()=>select('NativeB'));await closing;assert.equal(wsFirst.status,'completed');assert.equal(calls.at(-1).auth,'Bearer fixture-Native');
 const ws2=await openSocket(state);await wsReply(ws2,{model:'model',previous_response_id:wsFirst.id,input:'new websocket turn'});assert.equal(calls.at(-1).auth,'Bearer fixture-NativeB');assert.match(JSON.stringify(calls.at(-1).body),/retained websocket history/);assert.equal(calls.at(-1).body.previous_response_id,undefined);const closed=once(ws2,'close');ws2.close();await closed;pass('native WebSocket completes old reply, reconnects to new service and restores next-turn history');
 const dashboard=await rpc('getDashboardUrl');const viewer=await(await fetch(dashboard+'api/state')).json();const traces=[];for(const entry of viewer.sessions){traces.push(...(await(await fetch(dashboard+'api/session/'+entry.id)).json()).traces)}
 const restored=traces.find(t=>t.request.body.previous_response_id===first.id);assert.ok(restored);assert.equal(restored.request.body.input,'next turn');assert.equal(restored.contextChanges.historyRestored,true);assert.equal(restored.contextChanges.transformed,true);
 assert.ok(!JSON.stringify(restored.request.body).includes('retained history'));assert.match(JSON.stringify(restored.upstream.requestBody),/retained history/);
 const compactTrace=traces.find(t=>t.compact&&t.request.body.input==='compact original history');assert.ok(compactTrace);assert.equal(compactTrace.contextChanges.compactionMode,'gateway-summary');assert.match(JSON.stringify(compactTrace.upstream.requestBody),/CONTEXT CHECKPOINT COMPACTION/);assert.equal(compactTrace.response.body.output[0].encrypted_content,compact.output[0].encrypted_content);
 const resumedCompact=traces.find(t=>t.request.body.input?.[0]?.encrypted_content===compact.output[0].encrypted_content);assert.ok(resumedCompact);assert.ok(!JSON.stringify(resumedCompact.upstream.requestBody).includes('xwxc1:'));assert.match(JSON.stringify(resumedCompact.upstream.requestBody),/context checkpoint/);
 const socketTrace=traces.find(t=>t.request.method==='WS'&&t.request.body.previous_response_id);assert.ok(socketTrace);assert.ok(socketTrace.upstream.requestBody);assert.ok(!socketTrace.upstream.requestBody.previous_response_id);assert.match(JSON.stringify(socketTrace.upstream.requestBody),/retained websocket history/);
 pass('compaction, HTTP and WebSocket capture separate original client input from restored upstream context');
 const imageTrace=traces.find(t=>JSON.stringify(t.request.body).includes('image-marker'));assert.ok(imageTrace);assert.match(JSON.stringify(imageTrace.request.body),/tool_result/);assert.ok(traces.some(t=>t.error&&t.request.body.model==='cut'));pass('Trace retains original requests and marks restored context and interrupted evidence separately');
 await rpc('toggleTracing',false);child.stdin.end();const[code]=await once(child,'exit');assert.equal(code,0);const report={passed:true,checks,sandbox:root,requests:calls.length};await writeFile(resolve(import.meta.dirname,'../../test-results/protocol-portability-regression.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{if(child.exitCode===null)child.kill();for(const socket of wsUpstream.clients)socket.terminate();await new Promise(resolve=>wsUpstream.close(resolve));upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));}
