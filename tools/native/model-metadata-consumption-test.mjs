// Verify metadata at its consumers, with a failed provider directory and closed UI.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {once} from 'node:events';
import {mkdtemp,realpath,readFile,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {startNativeRpc} from './rpc-test-session.mjs';
const root=await mkdtemp(join(await realpath(tmpdir()),'xwx-consumption-'));
let stage=0,failDirectory=false;const directoryCalls=[],checks=[];
const server=createServer((req,res)=>{
 res.setHeader('content-type','application/json');
 if(req.url==='/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': fixture\n\n');return;}
 if(req.url==='/models-dev'){res.end(JSON.stringify({openai:{models:{'gpt-audit':{reasoning:true,limit:{context:1050000}}}},deepseek:{models:{'audit-model':{limit:{context:stage?768000:1000000},modalities:{input:stage?['text']:['text','image']}}}}}));return;}
 if(req.url==='/litellm'){res.end('{}');return;}
 directoryCalls.push(req.url);res.statusCode=failDirectory?503:200;res.end(JSON.stringify({data:[{id:'gpt-audit'},{id:'audit-model'}]}));
});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
const app=startNativeRpc(root,['--metadata-test-endpoint',base]);let passed=false;
try{
 await app.rpc('getState');
 const native={models:[{slug:'gpt-audit',context_window:500000,supported_reasoning_levels:[{effort:'low'},{effort:'high'}],default_reasoning_level:'high',default_reasoning_summary:'auto',base_instructions:'Synthetic audit instructions.'}]};
 await writeFile(join(root,'codex/models_cache.json'),JSON.stringify(native));
 await app.rpc('saveProvider',{id:'audit',displayName:'Audit fixture',adapter:'responses',baseUrl:base+'/v1',bearerToken:'synthetic-only',codexModel:'gpt-audit'});await app.rpc('switchClientProvider',{client:'codex',providerId:'audit'});
 await app.rpc('refreshMetadata',{topics:['capabilities'],revision:100});await app.rpc('fetchProviderModels',{providerId:'audit',refresh:true});
 const file=join(root,'codex/xwx-deck-model-catalog.json');const menu=async()=>JSON.parse(await readFile(file,'utf8')).models;
 let models=await menu(),gpt=models.find(m=>m.slug==='gpt-audit');
 assert.deepEqual(gpt.supported_reasoning_levels,native.models[0].supported_reasoning_levels,'reasoning=true with no declared levels must preserve exact native choices');assert.equal(gpt.default_reasoning_level,'high');checks.push('unspecified reasoning levels preserve current native options; a boolean is not an empty effort list');
 stage=1;failDirectory=true;const result=await app.rpc('refreshMetadata',{topics:['capabilities'],revision:101});models=await menu();
 assert.equal(models.find(m=>m.slug==='audit-model').context_window,768000,'new source data must reach the generated client catalog even when provider enumeration fails');assert.deepEqual(models.find(m=>m.slug==='audit-model').input_modalities,['text']);assert.equal(result.status,'partial');assert.ok(result.errors.some(e=>e.includes('503')));checks.push('with the model page closed, source refresh updates an existing validated catalog while preserving the provider-directory error');
 assert.equal((await app.rpc('getProviders')).connections.find(p=>p.id==='audit').codexModel,'gpt-audit');checks.push('source refresh preserves the selected model and provider');passed=true;
 console.log(JSON.stringify({passed,checks,directoryCalls,scope:'isolated native RPC and synthetic sources; no real credentials or generation'}));
}finally{await app.stop();server.closeAllConnections();await new Promise(r=>server.close(r));if(passed)await rm(root,{recursive:true,force:true});else console.error('Retained failed fixture: '+root)}
