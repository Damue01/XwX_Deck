// Real Rust RPC + local HTTP upstream. Fixtures are client config formats, not actual CLI binaries.
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {nativeTestBinary,writeCliFixture} from './test-support.mjs';
const root=await mkdtemp(join(await realpath(tmpdir()),'xwx-expanded-clients-'));const home=join(root,'client-home');
const config={
 pi:[['.pi/agent/models.json','{"providers":{"old":{"baseUrl":"https://old.invalid/v1"}},"custom":true}'],['.pi/agent/settings.json','{"defaultProvider":"old","defaultModel":"old-model","enabledModels":["old/old-model"],"theme":"dark"}']],
 'mimo-code':[['.config/mimocode/mimocode.jsonc','{\n// keep comment\n"model":"old/old-model","theme":"dark"\n}']],
 crush:[['.config/crush/crush.json','{"providers":{"old":{"type":"openai","base_url":"https://old.invalid/v1"}},"theme":"dark"}'],['.local/share/crush/crush.json','{"models":{"large":{"provider":"old","model":"old-model","max_tokens":100},"small":{"provider":"old","model":"old-small"}},"other":true}']],
 qoder:[['.qoder/settings.json','{"model":{"name":"old/old-model","preferences":{"old/old-model":{"reasoning":{"effort":"high"}}}},"ui":{"theme":"dark"}}']],
 droid:[['.factory/settings.json','{"customModels":[{"id":"custom:old","model":"old-model","apiKey":"old-key"}],"sessionDefaultSettings":{"model":"custom:old","reasoningEffort":"high"},"theme":"dark"}']],
 'codebuddy-code':[['.codebuddy/models.json','{"models":[{"id":"old-model","vendor":"old"}],"availableModels":["old-model"],"theme":"dark"}'],['.codebuddy/settings.json','{"model":"old-model","ui":true}']],
 workbuddy:[['.workbuddy/models.json','[{"id":"old-model","vendor":"old","url":"https://old.invalid/v1/chat/completions"}]']]
};
const binaries={pi:'pi','oh-my-pi':'omp',crush:'crush',qoder:'qodercli',droid:'droid','copilot-cli':'copilot','cursor-cli':'cursor-agent','mimo-code':'mimocode',workbuddy:'workbuddy','codebuddy-code':'codebuddy','hermes-agent':'hermes','antigravity-cli':'agy',openchamber:'openchamber','t3-code':'t3code'};
const all=Object.keys(binaries);const calls=[];const upstream=createServer(async(req,res)=>{let source='';for await(const chunk of req)source+=chunk;const body=source?JSON.parse(source):{};res.setHeader('content-type','application/json');if(req.url==='/v1/models'){res.end('{"data":[{"id":"gpt-4.1"}]}');return;}calls.push({path:req.url,body,auth:req.headers.authorization});res.end(JSON.stringify({id:'resp-'+calls.length,object:'response',status:'completed',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'fixture reply'}]}],usage:{input_tokens:13,output_tokens:7,total_tokens:20,input_tokens_details:{cached_tokens:4}}}));});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
const child=spawn(nativeTestBinary,['--rpc','--pilot-root',root],{env:{...process.env,XWX_CLIENT_INSTALLATIONS_TEST_HOME:home},stdio:['pipe','pipe','inherit']});let pending=[];createInterface({input:child.stdout}).on('line',line=>pending.shift()?.(JSON.parse(line)));
async function raw(method,...args){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(method+' timeout')),20000);pending.push(v=>{clearTimeout(timer);resolve(v)});child.stdin.write(JSON.stringify({method,args})+'\n')});}
async function rpc(method,...args){const r=await raw(method,...args);assert.equal(r.ok,true,r.error);return r.result;}
const cleanJson=s=>JSON.parse(s.replace(/\/\/[^\n]*\n/g,'\n'));
try{
 assert.equal((await rpc('getProviders')).connections.length,0);
 for(const pairs of Object.values(config))for(const[path,source]of pairs){await mkdir(dirname(join(home,path)),{recursive:true});await writeFile(join(home,path),source);}
 let installations=await rpc('detectClientInstallations');for(const client of all)assert.equal(installations.clients.find(x=>x.id===client).installed,false,'Config alone must not imply installed: '+client);
 await mkdir(join(home,'.local/bin'),{recursive:true});for(const command of Object.values(binaries))await writeCliFixture(join(home,'.local/bin',command),'process.exit(0);');
 installations=await rpc('detectClientInstallations');for(const client of all)assert.equal(installations.clients.find(x=>x.id===client).installed,true,client);
 for(const client of all)await rpc('addModelClient',client);const shown=await rpc('getModelClients');assert.ok(shown.includes('cursor'));assert.ok(!shown.includes('cursor-cli'));assert.equal(new Set(shown).size,shown.length);
 await rpc('saveProvider',{id:'fixture',displayName:'fixture',baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,bearerToken:'fixture-secret',adapter:'responses',codexModel:'gpt-4.1'});
 const provider=(await rpc('getProviders')).connections[0].id;
 async function select(client,model='gpt-4.1'){const snapshot=await rpc('getClientRoute',client);return rpc('setClientRoute',{client,providerId:provider,model,configDigest:snapshot.configDigest,takeoverConfirmed:true});}
 for(const client of all.filter(x=>x!=='cursor-cli')){const snapshot=await rpc('getClientRoute',client);assert.equal(snapshot.automatic,!!config[client],client);await select(client);}
 const crushBefore=(await rpc('getClientRoute','crush')).model;
 for(const model of ['$(touch /tmp/never-executed)','`not-a-command`','$SHELL','model\nother']){
  const snapshot=await rpc('getClientRoute','crush');
  const rejected=await raw('setClientRoute',{client:'crush',providerId:provider,model,configDigest:snapshot.configDigest,takeoverConfirmed:true});
  assert.equal(rejected.ok,false,'Unsafe expanded config must be rejected');
  assert.equal((await rpc('getClientRoute','crush')).model,crushBefore);
  for(const[path,source]of config.crush)assert.equal(await readFile(join(home,path),'utf8'),source);
 }
 let state=await rpc('toggleTracing',true);assert.equal(state.tracingEnabled,true);
 const pi=JSON.parse(await readFile(join(home,config.pi[1][0]),'utf8'));assert.equal(pi.defaultProvider,'xwx_deck');assert.deepEqual(pi.enabledModels,['old/old-model','xwx_deck/gpt-4.1']);
 const crush=JSON.parse(await readFile(join(home,config.crush[1][0]),'utf8'));assert.deepEqual(crush.models.large,{provider:'xwx_deck',model:'gpt-4.1'});assert.deepEqual(crush.models.small,{provider:'xwx_deck',model:'gpt-4.1'});
 for(const client of Object.keys(config))for(const[path]of config[client]){const source=await readFile(join(home,path),'utf8');assert.ok(source.includes('xwx_deck'));assert.ok(!source.includes('fixture-secret'));}
 assert.ok((await readFile(join(home,config['mimo-code'][0][0]),'utf8')).includes('// keep comment'));
 const work=JSON.parse(await readFile(join(home,config.workbuddy[0][0]),'utf8'));assert.equal(work.length,2);assert.equal(work[0].id,'old-model');assert.equal(work[1].vendor,'xwx_deck');
 let expected=0;
 for(const client of all.filter(x=>x!=='cursor-cli')){
  const endpoint=state.localBaseUrl+`/clients/${client}`;
  const gemini=client==='antigravity-cli';const path=gemini?'/v1beta/models/gpt-4.1:generateContent':'/v1/chat/completions';
  const body=gemini?{contents:[{role:'user',parts:[{text:'actual '+client}]}]}:{model:'gpt-4.1',messages:[{role:'user',content:'actual '+client}]};
  const r=await fetch(endpoint+path,{method:'POST',headers:{'content-type':'application/json','x-session-id':'one-session-'+client},body:JSON.stringify(body)});assert.equal(r.status,200,await r.clone().text());const v=await r.json();assert.equal(gemini?v.usageMetadata.totalTokenCount:v.usage.total_tokens,20);expected+=20;
 }
 assert.equal((await rpc('getTraceStats')).total.tokens,expected);
 const url=await rpc('getDashboardUrl');const overview=await(await fetch(url+'api/state')).json();const sessions=await Promise.all(overview.sessions.map(s=>fetch(url+'api/session/'+s.id).then(r=>r.json())));const rows=sessions.flatMap(s=>s.traces);assert.equal(rows.length,13);assert.equal(new Set(rows.map(r=>r.source)).size,13);
 for(const row of rows){assert.equal(row.usage.totalTokens,20);assert.equal(row.request.path.startsWith('/clients/'+row.source+'/'),true);assert.ok(JSON.stringify(row.request.body).includes('actual '+row.source));assert.ok(row.upstream.requestBody);assert.ok(!JSON.stringify(row).includes('fixture-secret'));}
 assert.equal(calls.filter(c=>c.path==='/v1/responses').length,13);assert.ok(calls.every(c=>c.auth==='Bearer fixture-secret'));
 await select('pi','new-explicit-model');assert.equal((await rpc('getClientRoute','pi')).model,'new-explicit-model');assert.equal((await rpc('getClientRoute','qoder')).model,'gpt-4.1');
 await rpc('toggleTracing',false);for(const pairs of Object.values(config))for(const[path,source]of pairs)assert.equal(await readFile(join(home,path),'utf8'),source,'Exact original restore: '+path);
 await assert.rejects(fetch(state.localBaseUrl+'/clients/pi/v1/models'),'Stopped Gateway must close its listener');
 // Preserving unrelated edits and refusing owned-field conflicts are meaningful restoration contracts.
 await rpc('toggleTracing',true);const qpath=join(home,config.qoder[0][0]);const q=JSON.parse(await readFile(qpath,'utf8'));q.ui.theme='external-theme';await writeFile(qpath,JSON.stringify(q));await rpc('toggleTracing',false);const restored=JSON.parse(await readFile(qpath,'utf8'));assert.equal(restored.ui.theme,'external-theme');assert.equal(restored.model.name,'old/old-model');
 // Refresh the digest after this deliberately external mutation.
 await select('qoder');await rpc('toggleTracing',true);const wpath=join(home,config.workbuddy[0][0]);const w=JSON.parse(await readFile(wpath,'utf8'));w.push({id:'external-model',vendor:'external'});await writeFile(wpath,JSON.stringify(w));const stopped=await raw('toggleTracing',false);assert.equal(stopped.ok,false);assert.ok((await rpc('getState')).tracingEnabled);assert.equal(JSON.parse(await readFile(wpath,'utf8')).at(-1).id,'external-model');w.pop();await writeFile(wpath,JSON.stringify(w));await rpc('toggleTracing',false);
 console.log(JSON.stringify({passed:true,clients:14,automaticAdapters:7,actualRequests:13,tokens:expected,checks:['no config-only installation detection','all new executables detected','Cursor aliases share one tab','Crush expansion rejected before files or selections change','pre-existing provider/model/scope preserved','independent client model switch','actual HTTP Chat and Gemini requests through Responses upstream','Trace original/upstream/source/token/secret boundaries','exact stop restore','unrelated edits preserved','owned array conflict keeps listener and evidence']},null,2));
}finally{await raw('toggleTracing',false).catch(()=>{});child.stdin.end();await once(child,'exit');upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));}
