// P evidence only: isolated Rust process and synthetic upstreams, no real credentials.
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { nativeTestBinary } from './test-support.mjs';
const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-forwarding-'));
const requests = [], sockets = new Set(), checks = [];
let streamClosed = false;
const servers = [0,1].map(service => {
  const server = createServer(async (req,res) => {
    let body;
    try { const chunks=[]; for await (const b of req) chunks.push(b); body=Buffer.concat(chunks); } catch { return; }
    const entry={service,path:req.url,method:req.method,headers:req.headers,sha256:createHash('sha256').update(body).digest('hex'),length:body.length};
    requests.push(entry);
    if(req.url.endsWith('/stream')) { res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: first\n\n');res.on('close',()=>{streamClosed=true});return; }
    if(req.url.split('?')[0].endsWith('/empty-502')) {res.writeHead(502);res.end();return;}
    if(req.url.endsWith('/disconnect')) {req.socket.destroy();return;}
    if(req.url.endsWith('/broken-body')) {res.writeHead(200,{'content-length':100});res.write('partial');setTimeout(()=>res.destroy(),30);return;}
    if(req.url.endsWith('/reject')) {res.writeHead(429,{'content-type':'application/json'});res.end('{"error":{"code":"insufficient_quota"}}');return;}
    if(req.url.endsWith('/redirect')) {res.writeHead(307,{location:'/never-follow'});res.end('redirect');return;}
    if(req.url.endsWith('/binary')) {res.writeHead(206,{'content-type':'application/octet-stream','set-cookie':['a=1; HttpOnly','b=2'],'content-length':4,'content-range':'bytes 0-3/4'});res.end(Buffer.from([0,255,1,128]));return;}
    if(req.url.endsWith('/messages') && req.headers['content-type']==='application/json') {res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'message-fixture',type:'message',role:'assistant',model:'claude-sonnet',content:[{type:'text',text:'OK'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}));return;}
    if(req.url.endsWith('/responses') && req.headers['content-type']==='application/json') {
      const payload=JSON.parse(body);res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'response-fixture',status:'completed',model:payload.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}));return;
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify(entry));
  });
  server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s))});
  return server;
});
const wss=new WebSocketServer({noServer:true,handleProtocols: protocols => protocols.has('fixture.raw')?'fixture.raw':false});
servers[0].on('upgrade',(req,socket,head)=>{
  requests.push({service:0,path:req.url,headers:req.headers,ws:true});
  if(req.url.endsWith('/denied')) {socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 6\r\nContent-Type: text/plain\r\n\r\ndenied');return;}
  wss.handleUpgrade(req,socket,head,ws=>ws.on('message',(bytes,binary)=>ws.send(bytes,{binary})));
});
for(const server of servers) {server.listen(0,'127.0.0.1');await once(server,'listening');}
const bases=servers.map(s=>`http://127.0.0.1:${s.address().port}`);
const child=spawn(nativeTestBinary,['--rpc','--pilot-root',root],{env:{...process.env,NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'},stdio:['pipe','pipe','inherit']});
const queue=[];createInterface({input:child.stdout}).on('line',line=>queue.shift()?.(JSON.parse(line)));
async function rpc(method,...args){const value=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`RPC timeout ${method}`)),20000);queue.push(v=>{clearTimeout(timer);resolve(v)});child.stdin.write(JSON.stringify({method,args})+'\n')});assert.equal(value.ok,true,value.error);return value.result;}
const pass = name => {checks.push(name);console.log('PASS '+name)};
function raw(url,{method='GET',headers={},body}={}) {return new Promise((resolve,reject)=>{const req=httpRequest(url,{method,headers,path:url.slice(new URL(url).origin.length)},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('aborted',()=>reject(Error('response aborted')));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));res.on('error',reject)});req.on('error',reject);req.end(body)})}
try {
  await rpc('getState');
  const config=join(root,'codex/config.toml');
  const direct=`model_provider="source"\nmodel="fixture-model"\n[model_providers.source]\nbase_url="${bases[0]}/origin/api"\nwire_api="responses"\nexperimental_bearer_token="original-key"\n`;
  await writeFile(config,direct);
  await writeFile(join(root,'claude/settings.json'),JSON.stringify({env:{ANTHROPIC_BASE_URL:bases[1]+'/claude-root',ANTHROPIC_API_KEY:'claude-key',KEEP:'keep'}}));
  const state=await rpc('toggleTracing',true), url=state.localBaseUrl;
  let initial=(await rpc('getState')).traces;
  for(const method of ['GET','HEAD','OPTIONS','DELETE','PATCH','PUT','POST']) {
    const body=['GET','HEAD'].includes(method)?undefined:Buffer.from([0,255,128,13,10]);
    const res=await raw(url+'/v1/opaque%2Bid%2Fchild?x=1&x=2&empty=&q=%2F',{method,headers:{authorization:'Bearer original-key','content-type':'application/octet-stream',...(body?{'content-length':body.length}:{})},body});
    assert.equal(res.status,200);const actual=requests.at(-1);assert.equal(actual.method,method);assert.equal(actual.path,'/origin/api/opaque%2Bid%2Fchild?x=1&x=2&empty=&q=%2F');assert.equal(actual.length,body?.length??0);if(body)assert.equal(actual.sha256,createHash('sha256').update(body).digest('hex'));
  }
  pass('arbitrary methods, exact bytes, original prefix, encoded path and duplicate queries');
  const large=Buffer.alloc(17*1024*1024,197);
  let res=await raw(url+'/v1/images/edits',{method:'POST',headers:{'content-type':'multipart/form-data; boundary=fixture','content-encoding':'gzip','content-length':large.length,connection:'x-private-hop','x-private-hop':'remove','x-end-to-end':'keep'},body:large});
  assert.equal(res.status,200);assert.equal(requests.at(-1).length,large.length);assert.equal(requests.at(-1).sha256,createHash('sha256').update(large).digest('hex'));assert.equal(requests.at(-1).headers['content-encoding'],'gzip');assert.equal(requests.at(-1).headers['x-private-hop'],undefined);assert.equal(requests.at(-1).headers['x-end-to-end'],'keep');
  pass('uploads exceed Trace limits, retain encoding and remove connection-specific headers');
  res=await raw(url+'/v1/binary');assert.equal(res.status,206);assert.deepEqual(res.body,Buffer.from([0,255,1,128]));assert.deepEqual(res.headers['set-cookie'],['a=1; HttpOnly','b=2']);assert.equal(res.headers['content-range'],'bytes 0-3/4');
  res=await raw(url+'/v1/redirect');assert.equal(res.status,307);assert.equal(res.headers.location,'/never-follow');assert.equal(res.body.toString(),'redirect');
  res=await raw(url+'/other/responses',{method:'POST',body:Buffer.from('not JSON')});assert.equal(res.status,200);assert.equal(requests.at(-1).path,'/origin/api/other/responses');
  assert.equal((await rpc('getState')).traces,initial);pass('binary, cookies, redirect and unrecognized namespaces bypass conversation parsing and Trace');
  const claudeConfig=JSON.parse(await readFile(join(root,'claude/settings.json'),'utf8'));
  assert.equal(claudeConfig.env.ANTHROPIC_BASE_URL,url+'/_xwx/claude');
  res=await raw(claudeConfig.env.ANTHROPIC_BASE_URL+'/v1/files',{headers:{'x-api-key':'claude-key'}});
  assert.equal(res.status,200);assert.equal(requests.at(-1).service,1);assert.equal(requests.at(-1).path,'/claude-root/v1/files');assert.equal(requests.at(-1).headers['x-api-key'],'claude-key');
  pass('Claude unknown interfaces retain a separate client source');
  res=await raw(claudeConfig.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':'claude-key'},body:Buffer.from('{"model":"claude-sonnet","messages":[],"max_tokens":1}')});
  assert.equal(res.status,200);assert.equal(requests.at(-1).service,1);assert.equal(requests.at(-1).path,'/claude-root/v1/messages');assert.equal(requests.at(-1).headers['x-api-key'],'claude-key');
  res=await raw(claudeConfig.env.ANTHROPIC_BASE_URL+'/v1/models',{headers:{'x-api-key':'claude-key'}});assert.equal(res.status,200);assert.equal(requests.at(-1).service,1);
  initial=(await rpc('getState')).traces;pass('the managed Claude model URL still reaches the original model pipeline');
  await rpc('saveProvider',{displayName:'model-service',baseUrl:bases[1]+'/v1',bearerToken:'different-key',adapter:'responses',codexModel:'model-b'});
  const provider=(await rpc('getProviders')).connections.find(p=>p.displayName==='model-service');assert.ok(provider);
  await rpc('switchClientProvider',{client:'codex',providerId:provider.id,takeOverExternalConfig:true});
  res=await raw(url+'/v1/images/generations',{method:'POST',headers:{authorization:'Bearer different-key',cookie:'other-account=secret','chatgpt-account-id':'other-account'},body:Buffer.from('opaque')});
  assert.equal(res.status,200);assert.equal(requests.at(-1).service,0);assert.equal(requests.at(-1).path,'/origin/api/images/generations');assert.equal(requests.at(-1).headers.authorization,'Bearer original-key');assert.equal(requests.at(-1).headers.cookie,undefined);assert.equal(requests.at(-1).headers['chatgpt-account-id'],undefined);
  const rejectedAt=requests.length;
  res=await raw(url+'/v1/files?key=different-key');assert.equal(res.status,401);
  res=await raw(url+'/v1/%2e%2e/escaped');assert.equal(res.status,502);assert.equal(requests.length,rejectedAt);
  pass('foreign query credentials and escaping paths fail before any upstream send');
  const before=requests.length;await rpc('setServiceSwitching',{client:'codex',policy:{enabled:true,strategy:'exhaust',providerIds:[provider.id]}});
  res=await raw(url+'/v1/reject');assert.equal(res.status,429);assert.equal(requests.length,before+1);assert.equal(requests.at(-1).service,0);assert.equal((await rpc('getState')).traces,initial);
  pass('model switching cannot move opaque traffic, mix credentials, trigger retries or create traces');
  res=await raw(url+'/v1/responses',{method:'POST',headers:{'content-type':'application/json'},body:Buffer.from('{"model":"model-b","input":"fixture"}')});
  assert.equal(res.status,200);assert.equal(requests.at(-1).service,1);assert.equal(requests.at(-1).path,'/v1/responses');assert.equal((await rpc('getState')).traces,initial+1);pass('known model requests retain their normal routing and Trace');
  const ws=new WebSocket(url.replace('http:','ws:')+'/v1/realtime?x=1&x=2',['fixture.raw'],{headers:{authorization:'Bearer different-key'}});
  await once(ws,'open');assert.equal(ws.protocol,'fixture.raw');assert.equal(requests.at(-1).path,'/origin/api/realtime?x=1&x=2');assert.equal(requests.at(-1).headers.authorization,'Bearer original-key');
  let echoed=once(ws,'message');ws.send('not JSON');let [bytes,isBinary]=await echoed;assert.equal(bytes.toString(),'not JSON');assert.equal(isBinary,false);
  echoed=once(ws,'message');ws.send(Buffer.from([0,255,128]));[bytes,isBinary]=await echoed;assert.deepEqual(bytes,Buffer.from([0,255,128]));assert.equal(isBinary,true);
  await assert.rejects(rpc('toggleTracing',false),/回复正在生成/);
  const close=once(ws,'close');ws.close(4001,'preserve close');const [code,reason]=await close;assert.equal(code,4001);assert.equal(reason.toString(),'preserve close');
  const denied=new WebSocket(url.replace('http:','ws:')+'/v1/denied');const refused=await new Promise((resolve,reject)=>{denied.once('unexpected-response',(_,r)=>{const chunks=[];r.on('data',b=>chunks.push(b));r.on('end',()=>{denied.terminate();resolve({status:r.statusCode,body:Buffer.concat(chunks).toString()})})});denied.on('error',()=>{});setTimeout(()=>reject(Error('denied handshake timeout')),5000).unref()});assert.deepEqual(refused,{status:401,body:'denied'});
  pass('opaque WebSocket text, binary, subprotocol, close status and upstream handshake refusal');
  const abort=new AbortController();const streaming=await fetch(url+'/v1/stream',{signal:abort.signal});const reader=streaming.body.getReader();assert.equal(new TextDecoder().decode((await reader.read()).value),'data: first\n\n');await assert.rejects(rpc('toggleTracing',false),/回复正在生成/);abort.abort();
  for(let i=0;i<100&&!streamClosed;i++)await new Promise(r=>setTimeout(r,10));assert.equal(streamClosed,true);
  // A second stream proves force-stop cancellation reaches the original source.
  streamClosed=false;const streaming2=await fetch(url+'/v1/stream');const reader2=streaming2.body.getReader();await reader2.read();await rpc('toggleTracing',false,true);await assert.rejects(reader2.read());for(let i=0;i<100&&!streamClosed;i++)await new Promise(r=>setTimeout(r,10));assert.equal(streamClosed,true);
  assert.equal(JSON.parse(await readFile(join(root,'claude/settings.json'),'utf8')).env.KEEP,'keep');assert.equal(JSON.parse(await readFile(join(root,'claude/settings.json'),'utf8')).env.ANTHROPIC_BASE_URL,bases[1]+'/claude-root');
  pass('SSE arrives incrementally, client cancellation and force stop close upstream, source config restores');
  const restarted=await rpc('toggleTracing',true);
  res=await raw(restarted.localBaseUrl+'/v1/images/generations',{headers:{authorization:'Bearer different-key'}});
  assert.equal(res.status,200);assert.equal(requests.at(-1).service,0);assert.equal(requests.at(-1).path,'/origin/api/images/generations');assert.equal(requests.at(-1).headers.authorization,'Bearer original-key');
  await rpc('toggleTracing',false);pass('a restarted Gateway recovers the original source from the existing ownership ledger');
  await rpc('switchClientProvider',{client:'codex',providerId:null});
  await writeFile(config,`model_provider="openai"\nmodel="fixture-model"\nopenai_base_url="${bases[0]}/model-root"\nchatgpt_base_url="${bases[1]}/account-root"\n`);
  await writeFile(join(root,'codex/auth.json'),'{"tokens":{"access_token":"original-official-token"}}');
  const official=await rpc('toggleTracing',true);
  res=await raw(official.localBaseUrl+'/backend-api/wham/usage',{headers:{authorization:'Bearer original-official-token'}});
  assert.equal(res.status,200);assert.equal(requests.at(-1).service,1);assert.equal(requests.at(-1).path,'/account-root/wham/usage');
  res=await raw(official.localBaseUrl+'/backend-api/new-interface',{method:'PATCH',headers:{authorization:'Bearer original-official-token'},body:Buffer.from('opaque')});assert.equal(res.status,200);assert.equal(requests.at(-1).service,1);assert.equal(requests.at(-1).path,'/account-root/new-interface');
  res=await raw(official.localBaseUrl+'/backend-api/codex/images/generations',{method:'POST',headers:{authorization:'Bearer original-official-token'},body:Buffer.from('opaque')});
  assert.equal(res.status,200);assert.equal(requests.at(-1).service,0);assert.equal(requests.at(-1).path,'/model-root/images/generations');
  res=await raw(official.localBaseUrl+'/v1/images/generations',{method:'POST',headers:{authorization:'Bearer refreshed-official-token'},body:Buffer.from('opaque')});
  assert.equal(res.status,200);assert.equal(requests.at(-1).service,0);assert.equal(requests.at(-1).path,'/model-root/images/generations');
  await rpc('toggleTracing',false);pass('official account and model roots remain independent with their original prefixes');
  // Missing source credentials must never borrow a selected model key.
  await writeFile(config,`model_provider="external"\nmodel="fixture-model"\n[model_providers.external]\nbase_url="${bases[0]}/unresolved"\nwire_api="responses"\n`);
  const noAuth=await rpc('toggleTracing',true);
  await rpc('switchClientProvider',{client:'codex',providerId:provider.id,takeOverExternalConfig:true});
  const noAuthAt=requests.length;
  res=await raw(noAuth.localBaseUrl+'/v1/files',{headers:{authorization:'Bearer different-key'}});assert.equal(res.status,401);assert.equal(requests.length,noAuthAt);
  await rpc('toggleTracing',false);pass('an unavailable original credential produces an actionable error without leaking or borrowing an account');
  await rpc('switchClientProvider',{client:'codex',providerId:null});
  // Same client/provider, no fallback: preserve upstream errors, diagnose their layer.
  await writeFile(config,`model_provider="external"\n[model_providers.external]\nbase_url="${bases[0]}/diagnostic"\nexperimental_bearer_token="diagnostic-secret"\n`);
  const diagnostic=await rpc('toggleTracing',true);
  const diagnosticStart=requests.length;
  res=await raw(diagnostic.localBaseUrl+'/v1/empty-502?token=query-secret',{headers:{authorization:'Bearer diagnostic-secret',cookie:'private-cookie'}});
  assert.equal(res.status,502);assert.equal(res.body.length,0);
  res=await raw(diagnostic.localBaseUrl+'/v1/disconnect',{headers:{authorization:'Bearer diagnostic-secret'}});assert.equal(res.status,502);
  await assert.rejects(raw(diagnostic.localBaseUrl+'/v1/broken-body'));
  await rpc('toggleTracing',false);
  let diagnosticText='';
  for(let i=0;i<100;i++){
    try {diagnosticText=await readFile(join(root,'logs/upstream-errors.jsonl'),'utf8');}catch{}
    if(diagnosticText.includes('response-body'))break;
    await new Promise(r=>setTimeout(r,10));
  }
  const diagnosticRecords=diagnosticText.trim().split('\n').filter(Boolean).map(JSON.parse).filter(r=>r.protocol==='forwarding');
  assert.ok(diagnosticRecords.some(r=>r.event==='forwarding_http_error'&&r.status===502&&r.httpResponseReceived===true));
  assert.ok(diagnosticRecords.some(r=>r.event==='forwarding_transport_error'&&r.phase==='request'&&r.httpResponseReceived===false));
  assert.ok(diagnosticRecords.some(r=>r.event==='forwarding_transport_error'&&r.phase==='response-body'&&r.httpResponseReceived===true));
  assert.ok(diagnosticRecords.every(r=>r.connectTimeoutMs===8000&&r.readTimeoutMs===null));
  for(const secret of ['diagnostic-secret','query-secret','private-cookie','/empty-502','/broken-body']) assert.ok(!diagnosticText.includes(secret));
  assert.equal(requests.length,diagnosticStart+3);
  pass('opaque empty HTTP 502, connection failure and broken response are distinguished without bodies, paths, credentials or retries');
  const exited=once(child,'exit');child.stdin.end();assert.equal((await exited)[0],0);
  console.log(JSON.stringify({ok:true,evidence:'P',checks,binarySha256:createHash('sha256').update(await readFile(nativeTestBinary)).digest('hex')}));
} finally {
  if(child.exitCode===null)child.kill('SIGKILL');for(const ws of wss.clients)ws.terminate();wss.close();for(const socket of sockets)socket.destroy();for(const server of servers)server.close();await rm(root,{recursive:true,force:true});
}
