import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile,writeFile,mkdtemp,realpath,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {WebSocket,WebSocketServer} from 'ws';
import {startNativeRpc} from './rpc-test-session.mjs';
import {nativeTestBinary} from './test-support.mjs';
const root=await mkdtemp(join(await realpath(tmpdir()),'deck-contract-edges-'));
let price=2,code=200,phase='incomplete',received,release;
const checks=[],failures=[],requests=[];
const rows=()=>[
 {id:'invalid-default',supported_reasoning_levels:[{effort:'low'}],default_reasoning_level:'banana'},
 {id:'unadvertised-default',supported_reasoning_levels:[{effort:'low'}],default_reasoning_level:'high'},
 {id:'empty-default',reasoning:true,supported_reasoning_levels:[],default_reasoning_level:'high'},
 {id:'valid-default',supported_reasoning_levels:[{effort:'low'},{effort:'high'}],default_reasoning_level:'low'},
 {id:'contract-model',supported_endpoints:['/responses'],magpie_price:{input:price,output:4,cache_read:0,cache_write:0}},
];
const response=(model,status='completed')=>({id:'edge-'+requests.length,object:'response',status,model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'4'}]}],usage:{input_tokens:100,output_tokens:10,total_tokens:110,input_tokens_details:{cached_tokens:20,cache_write_tokens:0,cache_write_5m_tokens:0,cache_write_1h_tokens:0}}});
const server=createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.url.endsWith('/models')){res.end(JSON.stringify({data:rows()}));return;}let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push({transport:'HTTP',model:body.model,status:code});res.statusCode=code;res.end(JSON.stringify(code===200?response(body.model):{error:{code:'ModelDeprecated'}}));});
const wss=new WebSocketServer({server});
wss.on('connection',socket=>socket.on('message',raw=>{const body=JSON.parse(raw.toString());requests.push({transport:'WS',model:body.model,phase});socket.send(JSON.stringify({type:'response.created',response:{id:'edge-created'}}));release=()=>socket.send(JSON.stringify({type:phase==='incomplete'?'response.incomplete':'response.completed',response:response(body.model,phase)}));received?.();}));
server.listen(0,'127.0.0.1');await once(server,'listening');
let app=startNativeRpc(root),socket;
const provider={id:'edge-provider',displayName:'Synthetic_edges',adapter:'responses',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,bearerToken:'SYNTHETIC-EDGE-KEY',codexModel:'contract-model'};
const models=()=>app.rpc('fetchProviderModels',{providerId:provider.id,refresh:true});
const pass=name=>{checks.push(name);console.log('PASS '+name);};
async function wait(test,label){const deadline=Date.now()+5000;while(!await test()){if(Date.now()>deadline)throw Error('Timed out: '+label);await new Promise(r=>setTimeout(r,10));}}
async function dashboard(count){let session;await wait(async()=>{const url=await app.rpc('getDashboardUrl');session=(await(await fetch(url+'api/state')).json()).sessions.find(s=>s.clientConversationKey.endsWith(':contract-edges'));return session?.traceCount===count;},'persisted WS traces');return session;}
async function turn(beforeFinish){const accepted=new Promise(resolve=>received=resolve);const completed=new Promise(resolve=>{const onMessage=raw=>{const value=JSON.parse(raw.toString());if(['response.completed','response.incomplete'].includes(value.type)){socket.off('message',onMessage);resolve(value.response);}};socket.on('message',onMessage);});socket.send(JSON.stringify({type:'response.create',model:'contract-model',input:'synthetic arithmetic'}));await accepted;await beforeFinish?.();release();return completed;}
try{
 await app.rpc('saveProvider',provider);await app.rpc('switchClientProvider',{client:'codex',providerId:provider.id});await models();
 const menu=JSON.parse(await readFile(join(root,'codex/xwx-deck-model-catalog.json'),'utf8')).models;
 for(const id of ['invalid-default','unadvertised-default','empty-default']){try{assert.equal(menu.find(m=>m.slug===id).default_reasoning_level,undefined,id);pass(id+' cannot publish an invalid or unadvertised Codex default effort');}catch(error){failures.push(error.message);}}
 assert.equal(menu.find(m=>m.slug==='valid-default').default_reasoning_level,'low');pass('a valid advertised default effort remains unchanged');
 try{
  code=404;await app.rpc('validateProvider',{providerId:provider.id,model:'contract-model'});assert.equal((await models()).find(m=>m.id==='contract-model').runtimeRetired,true);
  code=200;const state=await app.rpc('toggleTracing',true);socket=new WebSocket(state.localBaseUrl.replace('http:','ws:')+'/v1/responses',{headers:{'x-codex-thread-id':'contract-edges'}});await once(socket,'open');
  assert.equal((await turn()).status,'incomplete');await dashboard(1);assert.equal((await models()).find(m=>m.id==='contract-model').runtimeRetired,true);pass('an incomplete WebSocket response cannot clear definite retirement');
  phase='completed';assert.equal((await turn(async()=>{price=10;assert.equal((await models()).find(m=>m.id==='contract-model').runtimeRetired,true);})).status,'completed');
  const first=(await dashboard(2)).nativeUsage[1];assert.ok(Math.abs(first.costUsd-0.0002)<1e-12,JSON.stringify(first));pass('WebSocket cost uses the accepted request price snapshot despite in-flight directory repricing');
  assert.equal((await models()).find(m=>m.id==='contract-model').runtimeRetired,undefined);pass('a complete successful WebSocket response clears only its connection retirement');
  await turn();const session=await dashboard(3),second=session.nativeUsage[2];assert.ok(Math.abs(second.costUsd-0.00084)<1e-12,JSON.stringify(second));pass('the next WebSocket request receives the new provider rate without changing the previous request');
  socket.close();await once(socket,'close');socket=null;
  price=50;await models();await app.rpc('toggleTracing',false);await app.stop();app=startNativeRpc(root);
  const restored=await dashboard(3);assert.deepEqual(restored.nativeUsage[1],first);assert.deepEqual(restored.nativeUsage[2],second);
  const traces=[];for(const name of(await readdir(join(root,'traces'),{recursive:true})).filter(n=>n.endsWith('.jsonl'))){for(const line of(await readFile(join(root,'traces',name),'utf8')).split('\n')){try{traces.push(JSON.parse(line));}catch{}}}
  const snapshots=traces.filter(t=>t.request?.method==='WS').sort((a,b)=>a.startedAtMs-b.startedAtMs).map(t=>t.providerPrice);assert.equal(snapshots.length,3);assert.equal(snapshots[1].input,2);assert.equal(snapshots[2].input,10);assert.equal(snapshots[1].source,'provider');
  pass('WebSocket provider snapshots and costs survive repricing/restart with provider provenance');
 }catch(error){failures.push(error.message);}
}finally{socket?.terminate();await app.stop();for(const client of wss.clients)client.terminate();await new Promise(r=>wss.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
const report={passed:failures.length===0,checks,failures,requests,binarySha256:createHash('sha256').update(await readFile(nativeTestBinary)).digest('hex'),scope:'Actual native RPC/WS with synthetic provider, prices and credentials only; no real platform calls'};
await writeFile(process.env.XWX_EDGE_REPORT??join(process.cwd(),'test-results/native-catalog-edges-summary.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));assert.deepEqual(failures,[]);
