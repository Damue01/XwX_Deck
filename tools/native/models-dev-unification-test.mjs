import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,realpath,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startNativeRpc} from './rpc-test-session.mjs';
const root=await mkdtemp(join(await realpath(tmpdir()),'xwx-model-unify-'));
const model='deepseek-v4-1-flash-260910';
let rate=2,release,entered,hold=true,offline=false;
const requests=[],unexpected=[];let liteRequests=0;
const streams=new Set();
const server=createServer(async(req,res)=>{
 if(req.url==='/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': connected\n\n');streams.add(res);res.on('close',()=>streams.delete(res));return;}
 if(req.url==='/models-dev'){res.writeHead(offline?503:200,{'content-type':'application/json'});res.end(JSON.stringify({deepseek:{models:{'deepseek-flash':{canonical_model_id:'deepseek/deepseek-v4.1-flash',cost:{input:rate,output:rate*5,cache_read:.1,cache_write:rate},limit:{context:1000000},tool_call:true}}},azure:{models:{'azure-flash':{canonical_model_id:'deepseek/deepseek-v4.1-flash',cost:{input:.01,output:.01}}}},relay:{models:{'custom-flash':{canonical_model_id:'deepseek/deepseek-v4.1-flash',cost:{input:.001,output:.001}}}}}));return;}
 if(req.url==='/litellm'){liteRequests++;res.writeHead(offline?503:200,{'content-type':'application/json'});res.end(JSON.stringify({[model]:{litellm_provider:'deepseek',mode:'responses',supports_function_calling:true,max_input_tokens:1000000,max_output_tokens:100000}}));return;}
 if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:model,pricing:{input:99,output:999,currency:'USD',unit:'per_million_tokens'}}]}));return;}
 if(req.method!=='POST'||req.url!=='/v1/responses'){unexpected.push({method:req.method,path:req.url});res.writeHead(404);res.end('Unexpected isolated fixture route');return;}
 let body='';for await(const chunk of req)body+=chunk;requests.push(JSON.parse(body));assert.equal(requests.at(-1).model,model);
 if(hold){entered?.();await new Promise(resolve=>release=resolve);}
 res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'standard-fixture',object:'response',status:'completed',model,output:[],usage:{input_tokens:100,output_tokens:5,input_tokens_details:{cached_tokens:60,cache_write_tokens:0}}}));
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin=`http://127.0.0.1:${server.address().port}`;
let app=startNativeRpc(root,['--metadata-test-endpoint',origin]);
async function capture(){const url=await app.rpc('getDashboardUrl');for(let n=0;n<100;n++){const s=(await(await fetch(url+'api/state')).json()).sessions.find(s=>s.clientConversationKey.endsWith(':standard-fixture'));if(s?.traceCount===requests.length)return s;await new Promise(r=>setTimeout(r,20));}throw Error('capture timeout');}
try {
 await app.rpc('getState');await app.rpc('refreshMetadata',{topics:['pricing']});
 const priceBeforeCapabilities=await readFile(join(root,'pricing-cache/models-dev-pricing.json'),'utf8');
 await app.rpc('refreshMetadata',{topics:['capabilities']});assert.ok(liteRequests>0,'capability refresh must exercise the bodyless LiteLLM GET endpoint');
 assert.equal(await readFile(join(root,'pricing-cache/models-dev-pricing.json'),'utf8'),priceBeforeCapabilities,'capability-only refresh must preserve captured pricing');
 await app.rpc('saveProvider',{id:'standard-fixture',displayName:'Standard_fixture',adapter:'responses',baseUrl:origin+'/v1',bearerToken:'synthetic-only',codexModel:model});
 await app.rpc('fetchProviderModels',{providerId:'standard-fixture',refresh:true});
 await app.rpc('switchClientProvider',{client:'codex',providerId:'standard-fixture'});
 const tracing=await app.rpc('toggleTracing',true);
 const send=()=>fetch(tracing.localBaseUrl+'/v1/responses',{method:'POST',headers:{'content-type':'application/json','x-session-id':'standard-fixture'},body:JSON.stringify({model,input:'synthetic price capture'})});
 const accepted=new Promise(r=>entered=r),pending=send();await accepted;
 rate=4;await app.rpc('refreshMetadata',{topics:['pricing']});hold=false;release();
 assert.equal((await pending).status,200);const first=await capture();
 assert.ok(Math.abs(first.nativeUsage[0].costUsd-.000136)<1e-12);
 assert.equal(first.nativeUsage[0].priceRule.providerId,'deepseek');
 await send();const second=await capture();assert.ok(Math.abs(second.nativeUsage[1].costUsd-.000266)<1e-12);
 assert.deepEqual(second.nativeUsage[0],first.nativeUsage[0]);
 const record=JSON.parse((await readFile(second.jsonlPath,'utf8')).trim().split('\n')[0]);
 assert.equal(record.request.model,model);assert.equal(record.referencePrice.input,2);
 assert.equal(record.costSnapshot.priceRule.canonicalModelId,'deepseek/deepseek-v4.1-flash');
 offline=true;const before=await readFile(join(root,'pricing-cache/models-dev-pricing.json'),'utf8');
 assert.equal((await app.rpc('refreshMetadata',{topics:['pricing']})).status,'partial');
 assert.equal(await readFile(join(root,'pricing-cache/models-dev-pricing.json'),'utf8'),before);
 await app.rpc('toggleTracing',false);await app.stop();app=startNativeRpc(root);
 const restored=await capture();assert.deepEqual(restored.nativeUsage,second.nativeUsage);
 assert.deepEqual(unexpected,[],'all fixture HTTP routes must be explicitly handled');
 console.log('PASS native Gateway: dated ID unchanged, owner beats cloud/relay, accepted request freezes rates during refresh, next request reprices, offline/restart preserve snapshots; synthetic upstream only');
} finally {release?.();await app.stop();for(const stream of streams)stream.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
