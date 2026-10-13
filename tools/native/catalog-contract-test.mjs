import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,realpath,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startNativeRpc} from './rpc-test-session.mjs';

const root=await mkdtemp(join(await realpath(tmpdir()),'xwx-catalog-contract-'));
let code=200,error={code:'ModelDeprecated'},price=2,incomplete=false;
const requests=[],checks=[];
const rows=()=>[
 {id:'alias-native',native_endpoints:['/v1/messages/'],supported_endpoints:['/responses'],supported_reasoning_levels:[{effort:'high'},{effort:'low'},{effort:'high'},{}],default_reasoning_level:'low'},
 {id:'alias-path',supported_endpoints:['/v1/responses','/chat/completions','garbage']},
 {id:'alias-target',type_target:'anthropic'},
 {id:'alias-gemini-target',type_target:'gemini'},
 {id:'alias-unknown',supported_endpoints:['unknown'],type_target:'unknown'},
 {id:'contract-model',supported_endpoints:['/responses'],magpie_price:{input:price,output:4,cache_read:0}},
 {id:'partial-price',pricing:{currency:'USD',unit:'per_token',input:0}},
 {id:'invalid-price',pricing:{currency:'CNY',unit:'per_million_tokens',input:1,output:2}},
 {id:'invalid-effort',supported_reasoning_levels:[{invalid:'high'}]},
 {id:'no-effort',reasoning:true,supported_reasoning_levels:[]},
];
const server=createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');
 if(req.url.endsWith('/models')){res.end(JSON.stringify({data:rows()}));return;}
 let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests.push({path:req.url,model:body.model});
 res.statusCode=code;
 res.end(JSON.stringify(code===200?{id:'contract-response',object:'response',status:incomplete?'incomplete':'completed',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'4'}]}],usage:{input_tokens:100,output_tokens:10,input_tokens_details:{cached_tokens:20,cache_write_tokens:0,cache_write_5m_tokens:0,cache_write_1h_tokens:0}}}:{error}));
});
server.listen(0,'127.0.0.1');await once(server,'listening');
let app=startNativeRpc(root);
const base=`http://127.0.0.1:${server.address().port}/v1`;
const provider=id=>({id,displayName:id,baseUrl:base,adapter:'responses',bearerToken:'SYNTHETIC-CATALOG-KEY',codexModel:'contract-model'});
const fetchModels=(id='one',refresh=true)=>app.rpc('fetchProviderModels',{providerId:id,refresh});
const menu=()=>readFile(join(root,'codex/xwx-deck-model-catalog.json'),'utf8').then(JSON.parse);
const pass=s=>{checks.push(s);console.log('PASS '+s);};
try{
 await app.rpc('saveProvider',provider('one'));await app.rpc('switchClientProvider',{client:'codex',providerId:'one'});
 let models=await fetchModels();const find=id=>models.find(r=>r.id===id);
 assert.deepEqual(find('alias-native').protocols,['anthropic-messages']);
 assert.deepEqual(find('alias-native').reasoningLevels,['high','low']);assert.equal(find('alias-native').defaultReasoningLevel,'low');
 assert.deepEqual(find('alias-path').protocols,['openai-responses','chat-completions']);
 assert.deepEqual(find('alias-target').protocols,['anthropic-messages']);assert.deepEqual(find('alias-gemini-target').protocols,['chat-completions']);
 assert.equal(find('alias-unknown').protocolsDeclared,false);assert.equal(find('invalid-effort').reasoningLevels,undefined);assert.deepEqual(find('no-effort').reasoningLevels,[]);
 assert.equal(find('contract-model').providerPrice.input,2);assert.equal(find('contract-model').providerPrice.cacheRead,0);
 assert.equal(find('partial-price').providerPrice.input,0);assert.equal(find('invalid-price').providerPrice,undefined);
 pass('native endpoints take priority; supported paths/targets and object effort normalize without inventing unknown declarations, prices retain zero and reject unknown currency');
 let native=await menu();assert.deepEqual(native.models.find(r=>r.slug==='alias-native').supported_reasoning_levels.map(r=>r.effort),['high','low']);
 code=404;await app.rpc('validateProvider',{providerId:'one',model:'contract-model'});models=await fetchModels();assert.equal(find('contract-model').runtimeRetired,true);assert.ok(!(await menu()).models.some(r=>r.slug==='contract-model'));
 assert.equal((await app.rpc('getProviders')).connections.find(p=>p.id==='one').codexModel,'contract-model');
 pass('definite retired validation remains hidden after successful refresh without replacing the saved model');
 await app.stop();app=startNativeRpc(root);assert.equal((await fetchModels('one',false)).find(r=>r.id==='contract-model').runtimeRetired,true);
 await app.rpc('saveProvider',provider('two'));assert.equal((await fetchModels('two')).find(r=>r.id==='contract-model').runtimeRetired,undefined);
 await app.rpc('saveProvider',{...provider('one'),bearerToken:'DIFFERENT-SYNTHETIC-KEY'});assert.equal((await fetchModels()).find(r=>r.id==='contract-model').runtimeRetired,undefined);
 await app.rpc('saveProvider',provider('one'));assert.equal((await fetchModels()).find(r=>r.id==='contract-model').runtimeRetired,true);
 pass('retirement persists on restart and is isolated by provider and connection credentials');
 code=200;incomplete=true;assert.notEqual((await app.rpc('validateProvider',{providerId:'one',model:'contract-model'})).status,'valid');assert.equal((await fetchModels()).find(r=>r.id==='contract-model').runtimeRetired,true);incomplete=false;
 code=200;assert.equal((await app.rpc('validateProvider',{providerId:'one',model:'contract-model'})).status,'valid');assert.equal((await fetchModels()).find(r=>r.id==='contract-model').runtimeRetired,undefined);
 for(const item of [{code:404,error:{message:'Model not exist.'}},{code:401,error:{code:'ModelDeprecated'}},{code:503,error:{message:'No available upstream channel was found'}},{code:400,error:{code:'ModelDeprecated',message:'Insufficient quota'}}]){
  ({code,error}=item);await app.rpc('validateProvider',{providerId:'one',model:'contract-model'});assert.equal((await fetchModels()).find(r=>r.id==='contract-model').runtimeRetired,undefined);
 }
 code=410;error={message:'The model is retired.'};await app.rpc('validateProvider',{providerId:'one',model:'contract-model'});
 const file=join(root,'retired-models.json'),state=JSON.parse(await readFile(file,'utf8'));for(const row of Object.values(state.entries))row.expiresAt=1;await writeFile(file,JSON.stringify(state));assert.equal((await fetchModels()).find(r=>r.id==='contract-model').runtimeRetired,undefined);
 pass('valid request and expiry restore availability; generic not-found, authentication, quota and temporary channel failures never retire');
 code=404;error={code:'model_deprecated'};
 const active=await app.rpc('toggleTracing',true);
 const call=async()=>{const r=await fetch(active.localBaseUrl+'/v1/responses',{method:'POST',headers:{'content-type':'application/json','x-session-id':'contract-pricing'},body:JSON.stringify({model:'contract-model',input:'test'})});await r.text();return r.status;};
 assert.equal(await call(),404);
 for(let i=0;i<100;i++){if((await fetchModels()).find(r=>r.id==='contract-model').runtimeRetired)break;await new Promise(r=>setTimeout(r,20));}
 assert.equal((await fetchModels()).find(r=>r.id==='contract-model').runtimeRetired,true);
 code=200;assert.equal(await call(),200);
 const dashboard=await app.rpc('getDashboardUrl');let session;
 for(let i=0;i<100;i++){session=(await(await fetch(dashboard+'api/state')).json()).sessions.find(r=>r.clientConversationKey.endsWith(':contract-pricing'));if(session?.traceCount===2)break;await new Promise(r=>setTimeout(r,20));}
 assert.ok(session);const point=session.nativeUsage[1];assert.ok(Math.abs(point.costUsd-0.0002)<1e-12,JSON.stringify(point));
 assert.equal((await fetchModels()).find(r=>r.id==='contract-model').runtimeRetired,undefined);
 price=10;await fetchModels();
 const after=(await(await fetch(dashboard+'api/state')).json()).sessions.find(r=>r.id===session.id);assert.deepEqual(after.nativeUsage[1],point);
 await app.rpc('toggleTracing',false);await app.stop();app=startNativeRpc(root);
 const reopened=await app.rpc('getDashboardUrl');const persisted=(await(await fetch(reopened+'api/state')).json()).sessions.find(r=>r.id===session.id);assert.deepEqual(persisted.nativeUsage[1],point);
 pass('actual Gateway errors/success update retirement; connection-scoped provider price calculates Trace cost and remains stable after directory repricing and restart');
 const stored=await readFile(file,'utf8');assert.ok(!stored.includes('SYNTHETIC'));assert.ok(!stored.includes('ModelDeprecated'));
 console.log(JSON.stringify({passed:true,checks,requests,scope:'actual native RPC and Gateway; synthetic service, no production credentials'}));
}finally{await app.stop();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
