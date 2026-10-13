// Real native store/Gateway, synthetic upstream. No normal history or credentials.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,realpath,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {startNativeRpc} from './rpc-test-session.mjs';
import {nativeTestBinary} from './test-support.mjs';
const root=await mkdtemp(join(await realpath(tmpdir()),'deck-session-title-'));
let strayRequests=0;
const previousGateway=createServer((req,res)=>{strayRequests++;res.writeHead(503);res.end('Previous Gateway address must not be reused');});
let releaseHeld,heldStarted;const began=new Promise(r=>heldStarted=r);
const server=createServer(async(req,res)=>{
 let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);
 const title=body.input==='You are a helpful assistant. short title for a task\nUser prompt:\nActual question';
 const reply=()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'fixture-'+Date.now(),status:'completed',model:body.model,output:[{role:'assistant',type:'message',content:[{type:'output_text',text:title?'\u007b"title":"Actual title"\u007d':'fixture answer'}]}],usage:{input_tokens:5,output_tokens:2,total_tokens:7}}));};
 if(body.input==='held'){releaseHeld=reply;heldStarted();}else reply();
});
server.listen(0,'127.0.0.1');await once(server,'listening');let app=startNativeRpc(root);
const hashes=async index=>Promise.all(index.sessions.map(async s=>[s.id,createHash('sha256').update(await readFile(s.jsonlPath)).digest('hex')]));
try{
 await app.rpc('saveProvider',{id:'a',displayName:'a',adapter:'responses',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,bearerToken:'SYNTHETIC',codexModel:'model-a'});
 await app.rpc('switchClientProvider',{client:'codex',providerId:'a'});let base=(await app.rpc('toggleTracing',true)).localBaseUrl;let url=await app.rpc('getDashboardUrl');
 const post=async(thread,input,kind='user',model='model-a')=>{const response=await fetch(base+'/v1/responses',{method:'POST',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json','x-codex-turn-metadata':JSON.stringify({thread_id:thread,thread_source:kind})},body:JSON.stringify({model,input})});assert.equal(response.status,200);await response.json();};
 await post('helper','You are a helpful assistant. short title for a task\nUser prompt:\nActual question','thread_title');
 const input=[{role:'user',content:'# AGENTS.md instructions for /fixture\n<INSTRUCTIONS>fixture</INSTRUCTIONS>'},{role:'user',content:'<environment_context>fixture</environment_context>'},{role:'user',content:'<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>'},{role:'user',content:'Actual question'}];
 await post('main',input);await post('main',[...input,{role:'assistant',content:'answer'},{role:'user',content:'continue'}],'user','model-b');
 await post('prediction',input,'composer_predictions');
 const state=await(await fetch(url+'api/state')).json();const main=state.sessions.find(s=>s.clientConversationKey==='codex-cli:main'&&s.hidden!==true);
 assert.equal(main.firstPrompt,'Actual question');assert.equal(main.title,'Actual title');
 assert.equal(state.sessions.find(s=>s.id!==main.id&&s.clientConversationKey==='codex-cli:main').hidden,true);
 assert.equal(state.sessions.filter(s=>s.hidden!==true).length,1);
 const page=await(await fetch(url+'api/session/'+main.id)).json();assert.equal(page.total,3);assert.deepEqual(page.traces.map(t=>t.turn),[1,2,3]);assert.equal(page.traces[0].auxiliary,'title');assert.equal(page.traces[2].request.body.model,'model-b');
 const summaries=await(await fetch(url+'api/session/'+main.id+'?offset=0&limit=200&summary=1')).json();assert.equal(summaries.traces.length,3);assert.ok(summaries.traces.every(t=>t.summaryOnly&&!t.request.body));assert.equal(summaries.traces[1].mainOrdinal,1);assert.equal(summaries.traces[2].mainOrdinal,2);
 const requested=await(await fetch(url+'api/session/'+main.id+'?requestId='+encodeURIComponent(page.traces[2].id))).json();assert.equal(requested.traces.length,1);assert.equal(requested.traces[0].id,page.traces[2].id);assert.equal(requested.traces[0].request.body.model,'model-b');
 console.log('PASS title-before-main, context noise, prediction hiding, model changes, metadata pagination and exact request detail');
 await app.rpc('toggleTracing',false);await app.stop();
 previousGateway.listen(Number(new URL(base).port),'127.0.0.1');await once(previousGateway,'listening');
 const indexPath=join(root,'traces/index.json'),index=JSON.parse(await readFile(indexPath,'utf8'));
 for(const row of index.sessions){delete row.captureClassificationVersion;delete row.hidden;delete row.title;delete row.titlePromptHash;delete row.hasMainTurn;row.firstPrompt='<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>';}
 await writeFile(indexPath,JSON.stringify(index));const original=await readFile(indexPath),before=await hashes(index);
 app=startNativeRpc(root);url=await app.rpc('getDashboardUrl');const legacy=await(await fetch(url+'api/state')).json();assert.equal(legacy.sessions.find(s=>s.id===main.id).title,'Actual title');assert.equal(legacy.sessions.find(s=>s.id===main.id).firstPrompt,'Actual question');assert.deepEqual(await readFile(indexPath),original);assert.deepEqual(await hashes(index),before);
 console.log('PASS legacy projection reads correct classification without rewriting index or raw JSONL');
 // A restarted Gateway may select another free port. Never reuse its old address.
 const previousBase=base;base=(await app.rpc('toggleTracing',true)).localBaseUrl;assert.notEqual(base,previousBase);const held=post('main','held');await Promise.race([began,held.then(()=>{throw new Error('Held request did not reach this suite’s upstream');})]);
 await app.rpc('setTraceStoragePolicy',{limitGB:0,clearUsage:true});assert.equal((await app.rpc('getTraceStats')).total.tokens,0);releaseHeld();releaseHeld=undefined;await held;assert.equal((await app.rpc('getTraceStats')).total.tokens,0);
 await new Promise(r=>setTimeout(r,10));await post('new','new request');assert.equal((await app.rpc('getTraceStats')).total.tokens,7);
 await assert.rejects(app.rpc('setTraceStoragePolicy',{limitGB:1,clearUsage:true}),/0 GB/);await assert.rejects(app.rpc('setTraceStoragePolicy',{limitGB:0,clearUsage:'true'}),/无效/);
 await app.rpc('toggleTracing',false);await app.stop();app=startNativeRpc(root);assert.equal((await app.rpc('getTraceStats')).total.tokens,7);
 console.log('PASS explicit 0 GB reset, in-flight cutoff, new usage, restart and invalid-scope rejection');
 assert.equal(strayRequests,0);console.log(JSON.stringify({passed:true,checks:4,binarySha256:createHash('sha256').update(await readFile(nativeTestBinary)).digest('hex'),restartAddressRefreshed:true,previousGatewayRequests:strayRequests,syntheticUpstream:true}));
}finally{releaseHeld?.();await app.stop();previousGateway.closeAllConnections();if(previousGateway.listening)await new Promise(r=>previousGateway.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
