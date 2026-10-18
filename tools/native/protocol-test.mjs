import { nativeTestBinary, stopUnexecutedToolFixtures } from './test-support.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import{join,resolve}from'node:path';import{spawn}from'node:child_process';import{createServer}from'node:http';import{createInterface}from'node:readline';import{once}from'node:events';
const root=await mkdtemp(join(await realpath(tmpdir()),'xwx-rust-protocol-'));
const calls=[];const content='本地 protocol fixture';
const upstream=createServer(async(req,res)=>{
 if(req.url.endsWith('/models')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'gpt-7-future'},{id:'kimi-k3-future'},{id:'qwen3.8-max-future'},{id:'gpt-7-chat-only',native_endpoints:['chat-completions']},{id:'private-future',native_endpoints:['responses']},{id:'unknown-future'}]}));return;}
 let data='';for await(const b of req)data+=b;const body=JSON.parse(data);calls.push({path:req.url,auth:req.headers.authorization,body});
 const callName=body.tools?.[0]?.function?.name??body.tools?.[0]?.name??'lookup';
 let response;
 if(req.url==='/v1/chat/completions')response={id:'chat-1',model:body.model,choices:[{message:{role:'assistant',content,tool_calls:body.tools?[{id:'call-1',type:'function',function:{name:callName,arguments:JSON.stringify(callName==='rawtool'?{input:'echo fixture'}:{q:'fixture'})}}]:[]},finish_reason:'tool_calls'}],usage:{prompt_tokens:13,completion_tokens:7,total_tokens:20,prompt_tokens_details:{cached_tokens:4}}};
 else if(req.url==='/v1/messages')response={id:'msg-1',type:'message',model:body.model,role:'assistant',content:[{type:'text',text:content},{type:'tool_use',id:'call-1',name:callName,input:{q:'fixture'}}],stop_reason:'tool_use',usage:{input_tokens:9,cache_read_input_tokens:4,cache_creation_input_tokens:2,output_tokens:7}};
 else if(req.url==='/v1/responses')response={id:'resp-1',object:'response',status:'completed',model:body.model,output:[{id:'msg-1',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:content,annotations:[]}]}],usage:{input_tokens:13,output_tokens:7,total_tokens:20,input_tokens_details:{cached_tokens:4}}};
 else {res.writeHead(404);res.end('{}');return;}
 if(!body.stream){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(response));return;}
 res.writeHead(200,{'content-type':'text/event-stream'});
 if(req.url==='/v1/chat/completions'){
   res.write('data: '+JSON.stringify({id:'chat-1',model:body.model,choices:[{delta:{role:'assistant',content:'本地 '},finish_reason:null}]})+'\n\n');
   setTimeout(()=>{
     const tools=response.choices[0].message.tool_calls;
     const chunk=(delta,finish=null,usage)=>'data: '+JSON.stringify({id:'chat-1',model:body.model,choices:[{delta,finish_reason:finish}],usage})+'\n\n';
     res.write(chunk({content:'protocol fixture',tool_calls:tools.map((call,index)=>({index,...call,function:{...call.function,arguments:call.function.arguments.slice(0,2)}}))}));
     res.write(chunk({tool_calls:tools.map((call,index)=>({index,id:call.id,function:{name:'',arguments:call.function.arguments.slice(2)}}))}));
     res.write(chunk({tool_calls:tools.map((_,index)=>({index,id:'',function:{arguments:null}}))},'tool_calls',response.usage));
     res.end('data: [DONE]\n\n');
   },60);
 }else if(req.url==='/v1/responses'){
   res.write('event: response.output_text.delta\ndata: '+JSON.stringify({type:'response.output_text.delta',delta:'本地 '})+'\n\n');setTimeout(()=>res.end('event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response})+'\n\n'),60);
 }else{
  const events=[{type:'message_start',message:{...response,content:[]}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:content}},{type:'content_block_stop',index:0},{type:'content_block_start',index:1,content_block:response.content[1]},{type:'content_block_stop',index:1},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:response.usage},{type:'message_stop'}];res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
 }
});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const base=`http://127.0.0.1:${upstream.address().port}/v1`;
const child=spawn(nativeTestBinary,['--rpc','--pilot-root',root],{stdio:['pipe','pipe','inherit']});const queue=[];createInterface({input:child.stdout}).on('line',line=>queue.shift()?.(JSON.parse(line)));
async function rpc(method,...args){const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`timeout ${method}`)),20000);queue.push(v=>{clearTimeout(timer);resolve(v)});child.stdin.write(JSON.stringify({method,args})+'\n')});assert.equal(result.ok,true,result.error);return result.result;}
const checks=[];const pass=name=>{checks.push(name);console.log('PASS '+name)};
async function select(adapter,client){const id='Protocol_'+adapter.replaceAll('-','_');const existing=(await rpc('getProviders')).connections.find(p=>p.displayName===id);await rpc('saveProvider',{...(existing?{id:existing.id}:{}),displayName:id,baseUrl:base,bearerToken:'key-'+adapter,adapter,codexModel:'fixture-model'});await rpc('switchClientProvider',{client,providerId:id});if(client==='claude')await rpc('updateClaudeModels',{sonnet:'fixture-model'});return rpc('toggleTracing',true);}
const tool={type:'function',name:'lookup',parameters:{type:'object',properties:{q:{type:'string'}},required:['q']}};
async function post(state,client,body){const r=await fetch(state.localBaseUrl+(client==='claude'?'/v1/messages':'/v1/responses'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await r.text();assert.equal(r.status,200,value);return body.stream?value:JSON.parse(value);}
try{
 let state=await select('chat-completions','codex');
 let value=await post(state,'codex',{model:'fixture-model',instructions:'fixture system',input:[{role:'developer',content:'second system'},{role:'user',content:[{type:'input_text',text:'fixture'}]}],tools:[tool]});
 assert.equal(value.object,'response');assert.equal(value.output[0].content[0].text,content);assert.equal(value.output[1].type,'function_call');assert.equal(value.output[1].name,'lookup');assert.equal(value.usage.input_tokens,13);assert.equal(value.usage.input_tokens_details.cached_tokens,4);assert.equal(calls.at(-1).body.messages[0].content,'fixture system\n\nsecond system');pass('Responses → Chat JSON text, function tools, cache usage and merged system instructions');
 value=await post(state,'codex',{model:'fixture-model',input:'fixture',tools:[{type:'namespace',name:'fixture',tools:[tool]}],stream:true});assert.match(value,/response.completed/);assert.match(value,/"namespace":"fixture"/);assert.equal(calls.at(-1).body.tools[0].function.name,'fixture__lookup');assert.equal(calls.at(-1).body.stream_options.include_usage,true);
 const streamed=value.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
 const completedTool=streamed.find(e=>e.type==='response.completed').response.output.find(item=>item.type==='function_call');
 assert.equal(completedTool.call_id,'call-1');
 assert.deepEqual(JSON.parse(completedTool.arguments),{q:'fixture'});
 assert.ok(streamed.filter(e=>e.type==='response.function_call_arguments.delta').every(e=>e.item_id===completedTool.id));
 pass('Chat SSE repeated full tool IDs retain one call and stable argument delta identity');
 value=await post(state,'codex',{model:'fixture-model',input:'fixture',tools:[{type:'custom',name:'rawtool',description:'fixture shell'}]});assert.equal(value.output[1].type,'custom_tool_call');assert.equal(value.output[1].input,'echo fixture');pass('custom tool raw input survives request and response conversion');
 await stopUnexecutedToolFixtures(rpc,3);state=await select('anthropic-messages','codex');
 value=await post(state,'codex',{model:'fixture-model',input:[{role:'user',content:'fixture'},{type:'function_call',call_id:'old-call',name:'lookup',arguments:'{"q":"old"}'},{type:'function_call_output',call_id:'old-call',output:'old-result'}],tools:[tool],max_output_tokens:64});assert.equal(value.output[1].name,'lookup');assert.equal(value.usage.input_tokens,15);assert.equal(value.usage.input_tokens_details.cache_write_tokens,2);assert.equal(calls.at(-1).body.messages[1].content[0].type,'tool_use');assert.equal(calls.at(-1).body.messages[2].content[0].type,'tool_result');assert.equal(calls.at(-1).body.max_tokens,64);pass('Responses → Messages preserves tool call/results, token ceiling and separate cache buckets');
 value=await post(state,'codex',{model:'fixture-model',input:'fixture',tools:[tool],stream:true});assert.match(value,/response.function_call_arguments.done/);assert.match(value,/response.completed/);pass('Messages SSE → Responses text and tool completion events');
 await stopUnexecutedToolFixtures(rpc,2);state=await select('chat-completions','claude');
 value=await post(state,'claude',{model:'sonnet',system:[{type:'text',text:'fixture system'}],messages:[{role:'user',content:'fixture'}],tools:[{name:'lookup',input_schema:tool.parameters}],max_tokens:32});assert.equal(value.type,'message');assert.equal(value.content[0].text,content);assert.equal(value.content[1].type,'tool_use');assert.equal(value.stop_reason,'tool_use');assert.equal(value.usage.input_tokens,9);assert.equal(calls.at(-1).body.model,'fixture-model');pass('Claude Messages → Chat → Messages with actual alias, tools and uncached input usage');
 value=await post(state,'claude',{model:'sonnet',messages:[{role:'user',content:'fixture'}],max_tokens:32,stream:true});assert.match(value,/event: message_start/);assert.match(value,/event: message_stop/);pass('Chat SSE → Claude native message event sequence');
 await stopUnexecutedToolFixtures(rpc,1);state=await select('responses','claude');
 value=await post(state,'claude',{model:'sonnet',messages:[{role:'user',content:'fixture'}],max_tokens:32,stream:true});assert.match(value,/event: message_delta/);assert.match(value,/protocol fixture/);assert.equal(calls.at(-1).path,'/v1/responses');pass('Claude → Responses → Claude SSE actual upstream path and text');
 await rpc('toggleTracing',false);
 for(const call of calls)assert.match(call.auth,/^Bearer key-/);pass('every conversion injects the selected upstream credential');
 const stats=await rpc('getTraceStats');assert.equal(stats.total.tokens,6*20+2*22);assert.equal(stats.total.costComplete,false);assert.equal(stats.series.length,8);pass('real upstream usage persists with honest missing-price status');
 const dashboard=await rpc('getDashboardUrl');const dashboardState=await(await fetch(dashboard+'api/state')).json();const eventStream=await fetch(dashboard+'events');assert.equal(eventStream.headers.get('content-type'),'text/event-stream');const eventReader=eventStream.body.getReader();assert.match(new TextDecoder().decode((await eventReader.read()).value),/connected/);await eventReader.cancel();pass('native viewer SSE opens a real event stream without reconnect errors');assert.equal(dashboardState.sessions.length,8);assert.match(await(await fetch(dashboard)).text(),/Trace 模型请求追踪/);
 const session=dashboardState.sessions[0];const page=await(await fetch(dashboard+'api/session/'+session.id)).json();assert.equal(page.traces.length,1);assert.equal(page.traces[0].request.body.model,'fixture-model');assert.ok(!JSON.stringify(page).includes('key-chat-completions'));assert.equal(page.traces[0].usage.inputUncachedTokens,9);pass('existing Trace viewer is served by Rust, lazily reads actual JSONL and excludes credentials');
 const denied=await fetch(dashboard+'api/session/'+session.id,{method:'DELETE',headers:{origin:'https://invalid.example'}});assert.equal(denied.status,403);assert.equal((await(await fetch(dashboard+'api/state')).json()).sessions.length,8);pass('foreign-origin dashboard deletion is rejected');
 const indexPath=join(root,'traces/index.json');const before=await readFile(indexPath,'utf8');const plan=await rpc('inspectTraceIndexRepair');assert.equal(plan.indexStatus,'valid');assert.equal(plan.candidates.length,8);await writeFile(indexPath,before+'\n');
 const failed=await new Promise(resolve=>{queue.push(resolve);child.stdin.write(JSON.stringify({method:'applyTraceIndexRepair',args:[plan.indexSha256]})+'\n')});assert.equal(failed.ok,false);assert.match(failed.error,/外部修改/);
 const current=await rpc('inspectTraceIndexRepair');const repaired=await rpc('applyTraceIndexRepair',current.indexSha256);assert.equal(repaired.applied,true);assert.equal(repaired.recoveredSessions,8);assert.ok(await readFile(repaired.backupIndexPath,'utf8'));assert.equal((await rpc('getTraceStats')).total.tokens,6*20+2*22);pass('manual index repair checks the current hash, backs up evidence and preserves true usage');
 const removed=await fetch(dashboard+'api/session/'+session.id,{method:'DELETE',headers:{origin:new URL(dashboard).origin}});assert.equal(removed.status,200);assert.equal((await(await fetch(dashboard+'api/state')).json()).sessions.length,7);await rpc('clearHistory');assert.equal((await rpc('getState')).traces,0);pass('explicit local deletion and clearing remove only indexed Trace sessions');
 state=await select('chat-completions','codex');
 const previous=await post(state,'codex',{model:'fixture-model',input:'first uniquely retained turn'});
 const next=await post(state,'codex',{model:'fixture-model',previous_response_id:previous.id,input:'second turn'});
 assert.ok(calls.at(-1).body.messages.some(m=>m.content==='first uniquely retained turn'));assert.ok(calls.at(-1).body.messages.some(m=>m.role==='assistant'));assert.equal(calls.at(-1).body.messages.at(-1).content,'second turn');pass('previous_response_id preserves earlier user, assistant and tool context');
 const missing=await fetch(state.localBaseUrl+'/v1/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fixture-model',previous_response_id:'missing-response',input:'must not lose history'})});assert.equal(missing.status,400);pass('missing continuation returns an explicit error instead of losing context');
 const compact=await fetch(state.localBaseUrl+'/v1/responses/compact',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fixture-model',input:'context to compact',tools:[tool]})});assert.equal(compact.status,200,await compact.clone().text());const compactValue=await compact.json();assert.equal(compactValue.object,'response.compaction');assert.match(compactValue.output[0].encrypted_content,/^xwxc1:/);assert.equal(calls.at(-1).path,'/v1/chat/completions');assert.equal(calls.at(-1).body.tools,undefined);
 await post(state,'codex',{model:'fixture-model',input:[compactValue.output[0],{role:'user',content:'resume checkpoint'}]});assert.match(calls.at(-1).body.messages[0].content,/context checkpoint/);assert.match(calls.at(-1).body.messages[0].content,/protocol fixture/);pass('synthetic compaction calls the real selected model and restores its checkpoint');
 await rpc('updateCodexConfig',{expectedProviderId:'Protocol_chat_completions',compatibleModel:'active-change',modelContextWindow:64000});assert.equal((await rpc('getState')).backgroundGatewayActive,true);assert.equal((await rpc('getCodexConfig')).compatible.model,'active-change');await post(await rpc('getState'),'codex',{model:'active-change',input:'active change fixture'});assert.equal(calls.at(-1).body.model,'active-change');pass('active model writes restart the native route and retain explicit context window');
 const toolImageUrl='data:image/png;base64,fixture';
 await post(await rpc('getState'),'codex',{model:'active-change',input:[
  {type:'function_call',call_id:'call-image',name:'read_image',arguments:'{}'},
  {type:'function_call_output',call_id:'call-image',output:[{type:'input_text',text:'tool image result'},...['low','high','auto',undefined].map(detail=>({type:'input_image',image_url:toolImageUrl,...detail===undefined?{}:{detail}}))]}
 ]});
 const imageMessages=calls.at(-1).body.messages;
 assert.equal(imageMessages[1].tool_call_id,'call-image');assert.equal(imageMessages[1].content,'tool image result');
 assert.deepEqual(imageMessages[2].content.map(part=>part.image_url),['low','high','auto','auto'].map(detail=>({url:toolImageUrl,detail})));
 pass('tool-result image payload and explicit low/high/auto detail survive the actual Chat route; omitted detail defaults to auto');
 await rpc('toggleTracing',false);
 const auto='Protocol_auto';await rpc('saveProvider',{id:auto,displayName:auto,baseUrl:base,bearerToken:'key-auto',adapter:'auto',codexApiFormat:'chat-completions',codexModel:'gpt-7-future'});
 await rpc('switchClientProvider',{client:'codex',providerId:auto});
 await rpc('switchClientProvider',{client:'claude',providerId:auto});
 const catalog=await rpc('fetchProviderModels',{providerId:auto,refresh:true});
 assert.ok(catalog.find(m=>m.id==='gpt-7-future').officialProtocols.includes('openai-responses'));
 state=await rpc('toggleTracing',true);
 for(const id of ['gpt-7-future','kimi-k3-future','qwen3.8-max-future','private-future']){
   await post(state,'codex',{model:id,input:'native route fixture'});assert.equal(calls.at(-1).path,'/v1/responses',id);assert.equal(calls.at(-1).body.input,'native route fixture');assert.equal(calls.at(-1).body.messages,undefined);
 }
 await post(state,'codex',{model:'gpt-7-chat-only',input:'declared chat'});assert.equal(calls.at(-1).path,'/v1/chat/completions');
 await post(state,'codex',{model:'unknown-future',input:'connection default'});assert.equal(calls.at(-1).path,'/v1/chat/completions');
 await rpc('updateClaudeModels',{sonnet:'kimi-k3-future'});
 await post(state,'claude',{model:'sonnet',messages:[{role:'user',content:'native messages fixture'}],max_tokens:32});assert.equal(calls.at(-1).path,'/v1/messages');assert.equal(calls.at(-1).body.model,'kimi-k3-future');
 await stopUnexecutedToolFixtures(rpc,1);
 pass('live new GPT/Kimi/Qwen models use native Responses; Claude uses native Messages; explicit service Chat and unknown connection defaults win without probing or retry');
 child.stdin.end();const[code]=await once(child,'exit');assert.equal(code,0);console.log(JSON.stringify({passed:true,checks,sandbox:root,requests:calls.length}));
}finally{if(child.exitCode===null)child.kill();await new Promise(resolve=>upstream.close(resolve));}
