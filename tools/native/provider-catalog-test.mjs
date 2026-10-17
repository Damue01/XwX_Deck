import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';import {once} from 'node:events';
import {mkdtemp,realpath,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {startNativeRpc} from './rpc-test-session.mjs';
const root=await mkdtemp(join(await realpath(tmpdir()),'xwx-provider-catalog-'));
let stage=0,status=200,onlyRetired=false;const requests=[],checks=[];
const models=()=>({data:[
 {id:'deepseek-r1-250120',name:'deepseek-r1',version:'250120',status:'Shutdown',token_limits:{context_window:98304,max_input_token_length:65536,max_output_token_length:16384,max_reasoning_token_length:32768},modalities:{input_modalities:['text'],output_modalities:['text']},features:{tools:{function_calling:true},structured_outputs:{json_schema:false,json_object:false},cache:{prefix_cache:true}}},
 ...onlyRetired?[]:[{id:'gpt-5-provider-fixture',name:'Service display name',version:'1',status:'Published',created:1738595139,token_limits:{context_window:stage?64000:128000,max_input_token_length:64000,max_output_token_length:4096},modalities:{input_modalities:stage?['text']:['text','image'],output_modalities:['text']},features:{tools:{function_calling:false},structured_outputs:{json_schema:false,json_object:true}},reasoning:false,temperature:false,reasoning_levels:[]},
 {id:'provider-missing-fields',status:'Retiring',context_window:-5,vision:null,tool_calling:'true',max_output_tokens:0},
 {id:'gpt-5-provider-effort',reasoning_levels:['high'],default_reasoning_level:'high'},
 {id:'gpt-5-provider-no-effort',reasoning:true,reasoning_levels:[]},
 {id:'status-unknown'},
 {id:'alias-embedding',task_type:['TextEmbedding','ImageEmbedding']},
 {id:'alias-video',modalities:{output_modalities:['video']}},
 {id:'alias-image',task_type:['ImageToImage','TextToImage']},
 {id:'gpt-image-2'},
 {id:'private-artist',kind:'image'},
 {id:'vision-chat',modalities:{input_modalities:['text','image'],output_modalities:['text']},task_type:['VisualQuestionAnswering','TextGeneration']}]
]});
const server=createServer(async(req,res)=>{
 if(req.url.endsWith('/models')){requests.push(req.url);res.setHeader('content-type','application/json');if(status!==200){res.statusCode=status;res.end('{"error":"SYNTHETIC-SECRET"}');return;}res.end(JSON.stringify(models()));return;}
 let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests.push({path:req.url,model:body.model});res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'4'}}]}));
});server.listen(0,'127.0.0.1');await once(server,'listening');
let app=startNativeRpc(root);const pass=s=>{checks.push(s);console.log('PASS '+s)};
try{
 const base=`http://127.0.0.1:${server.address().port}`;
 await app.rpc('saveProvider',{id:'catalog-service',displayName:'Service',baseUrl:base+'/api/v3',adapter:'chat-completions',bearerToken:'SYNTHETIC-KEY',codexModel:'deepseek-r1-250120'});
 await writeFile(join(root,'model-capabilities-cache.json'),JSON.stringify({version:1,modelsDev:[{modelId:'gpt-5-provider-fixture',sourceId:'owner/gpt-5-provider-fixture',providerId:'owner',canonicalModelId:'owner/gpt-5-provider-fixture',aliases:['gpt-5-provider-fixture'],referencePriority:0,capability:{contextWindow:999999,vision:false,reasoning:true,toolCalling:true,structuredOutput:true}},{modelId:'provider-missing-fields',sourceId:'owner/provider-missing-fields',providerId:'owner',canonicalModelId:'owner/provider-missing-fields',aliases:['provider-missing-fields'],referencePriority:0,capability:{contextWindow:333000,maxOutputTokens:8192,vision:true,inputModalities:['text','image'],toolCalling:true,reasoning:false}}]}));
 let entries=await app.rpc('fetchProviderModels',{providerId:'catalog-service',refresh:true});
 const old=entries.find(m=>m.id==='deepseek-r1-250120'),live=entries.find(m=>m.id==='gpt-5-provider-fixture');
 assert.equal(old.lifecycleStatus,'Shutdown');assert.equal(old.contextWindow,98304);assert.equal(old.maxInputTokens,65536);assert.equal(old.maxReasoningTokens,32768);assert.equal(old.providerFeatures.cache.prefix_cache,true);
 assert.equal(live.displayName,'Service display name');assert.equal(live.contextWindow,128000);assert.equal(live.vision,true);assert.equal(live.reasoning,false);assert.equal(live.toolCalling,false);assert.equal(live.structuredOutput,false);assert.equal(live.temperature,false);assert.deepEqual(live.outputModalities,['text']);assert.equal(live.capabilitySources.contextWindow,'provider');assert.equal(live.capabilitySources.toolCalling,'provider');assert.equal(live.reasoningLevels,undefined);
 const missing=entries.find(m=>m.id==='provider-missing-fields');assert.equal(missing.contextWindow,333000);assert.equal(missing.vision,true);assert.equal(missing.toolCalling,true);assert.equal(missing.capabilitySources.contextWindow,'models.dev');assert.equal(missing.lifecycleStatus,'Retiring');assert.equal(entries.find(m=>m.id==='status-unknown').lifecycleStatus,undefined);
 assert.deepEqual(entries.find(m=>m.id==='gpt-5-provider-effort').reasoningLevels,['high']);assert.equal(entries.find(m=>m.id==='gpt-5-provider-effort').defaultReasoningLevel,'high');assert.deepEqual(entries.find(m=>m.id==='gpt-5-provider-no-effort').reasoningLevels,[]);
 pass('Ark raw fields and explicit false win; invalid/missing fields use original per-field enrichment, lifecycle unknown is not invented');
 await app.rpc('switchClientProvider',{client:'codex',providerId:'catalog-service'});
 const generated=()=>readFile(join(root,'codex/xwx-deck-model-catalog.json'),'utf8').then(JSON.parse);
 let native=await generated();assert.ok(!native.models.some(m=>m.slug==='deepseek-r1-250120'));assert.equal(native.models.find(m=>m.slug===live.id).context_window,128000);assert.deepEqual(native.models.find(m=>m.slug===live.id).input_modalities,['text','image']);assert.equal((await app.rpc('getProviders')).connections.find(p=>p.id==='catalog-service').codexModel,'deepseek-r1-250120');
 pass('client menu removes Shutdown, publishes service image/context facts, preserves the saved model without substituting');
 for(const id of ['alias-embedding','alias-video','alias-image','gpt-image-2','private-artist'])assert.ok(!native.models.some(m=>m.slug===id),id);
 assert.ok(native.models.some(m=>m.slug==='vision-chat'));
 await app.rpc('saveProvider',{id:'catalog-service',displayName:'Service',baseUrl:base+'/api/v3',adapter:'chat-completions',bearerToken:'SYNTHETIC-KEY',codexModel:'alias-embedding'});
 assert.ok(!(await generated()).models.some(m=>m.slug==='alias-embedding'));
 assert.equal((await app.rpc('getProviders')).connections.find(p=>p.id==='catalog-service').codexModel,'alias-embedding');
 pass('tasks/output modalities and sparse Sub2API-style IDs exclude non-chat models without removing vision chat or rewriting the saved model');
 await app.rpc('saveProvider',{id:'catalog-service',displayName:'Service',baseUrl:base+'/api/v3',adapter:'chat-completions',bearerToken:'SYNTHETIC-KEY',codexModel:'deepseek-r1-250120'});
 const cacheName=(await readdir(root)).find(n=>/^provider-.*-models.json$/.test(n));const cachePath=join(root,cacheName),before=await readFile(cachePath,'utf8'),beforeClient=await readFile(join(root,'codex/xwx-deck-model-catalog.json'),'utf8');
 for(const code of [401,404,503]){status=code;await assert.rejects(app.rpc('fetchProviderModels',{providerId:'catalog-service',refresh:true}),new RegExp('HTTP '+code));assert.equal(await readFile(cachePath,'utf8'),before);assert.equal(await readFile(join(root,'codex/xwx-deck-model-catalog.json'),'utf8'),beforeClient);}
 const count=requests.length;assert.equal((await app.rpc('fetchProviderModels',{providerId:'catalog-service',refresh:false})).find(m=>m.id===live.id).contextWindow,128000);assert.equal(requests.length,count);
 pass('401/404/503 refresh rejects without writing cache or generated client catalog; explicit offline read remains available');
 status=200;stage=1;entries=await app.rpc('fetchProviderModels',{providerId:'catalog-service',refresh:true});assert.equal(entries.find(m=>m.id===live.id).contextWindow,64000);assert.equal(entries.find(m=>m.id===live.id).vision,false);
 await app.stop();app=startNativeRpc(root);entries=await app.rpc('fetchProviderModels',{providerId:'catalog-service'});assert.equal(entries.find(m=>m.id===live.id).capabilitySources.contextWindow,'provider');assert.equal(entries.find(m=>m.id===live.id).vision,false);pass('fresh service facts replace old values and retain priority after restart');
 const validation=await app.rpc('validateProvider',{providerId:'catalog-service',model:live.id});assert.equal(validation.status,'valid');assert.deepEqual(requests.at(-1),{path:'/api/v3/chat/completions',model:live.id});pass('native validation sends exact model and version-root Chat URL');
 await app.rpc('saveProvider',{id:'auto-catalog',displayName:'Auto_Catalog',baseUrl:base+'/v1',adapter:'auto',codexApiFormat:'responses',bearerToken:'SYNTHETIC-KEY'});
 const automatic = await app.rpc('fetchProviderModels',{providerId:'auto-catalog',refresh:true});
 const autoCachePath=join(root,`provider-${createHash('sha256').update('auto-catalog').digest('hex').slice(0,24)}-models.json`);
 const autoCache=await readFile(autoCachePath,'utf8');
 for(const failure of [404,503]){status=failure;await assert.rejects(app.rpc('fetchProviderModels',{providerId:'auto-catalog',refresh:true}),new RegExp('HTTP '+failure));assert.equal(await readFile(autoCachePath,'utf8'),autoCache);}
 status=200;
 assert.deepEqual(await app.rpc('fetchProviderModels',{providerId:'auto-catalog',refresh:false}),automatic);
 pass('generic auto catalog uses the configured models endpoint; 404/503 cannot masquerade as success or discard a last successful snapshot');
 onlyRetired=true;entries=await app.rpc('fetchProviderModels',{providerId:'catalog-service',refresh:true});assert.equal(entries.length,1);assert.deepEqual((await generated()).models,[]);pass('all-retired directory succeeds as an empty client menu and does not resurrect an older live model');
 console.log(JSON.stringify({passed:true,checks,networkRequests:requests.length,scope:'synthetic service + actual native RPC/client publication'}));
}finally{await app.stop();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
