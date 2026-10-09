import { nativeTestBinary, writeCliFixture } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, realpath, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const fixtureRoot = await mkdtemp(join(await realpath(tmpdir()), 'xwx-grok-subscriptions-'));
const root=join(fixtureRoot,'pilot');
const homes = new Map(), requests = []; let origin, serial = 0, nextEmail, refreshes = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, origin); res.setHeader('content-type', 'application/json');
  if (url.pathname === '/grok-auth/start') { const home = url.searchParams.get('home'); const ticket = String(++serial); homes.set(ticket, { home, approved: false, email: nextEmail ?? `user-${serial}@example.test` }); res.end(JSON.stringify({ ticket, url: `${origin}/grok-auth/approve?ticket=${ticket}` })); return; }
  if (url.pathname === '/grok-auth/approve') { homes.get(url.searchParams.get('ticket')).approved = true; res.end('{}'); return; }
  if (url.pathname === '/grok-auth/poll') { const account = homes.get(url.searchParams.get('ticket')); res.end(JSON.stringify(account.approved ? { key: `grok-secret-${url.searchParams.get('ticket')}`, email: account.email, expires_at: new Date(Date.now() + 3600000).toISOString(), oidc_issuer: origin } : null)); return; }
  if (url.pathname === '/grok-auth/refresh') { refreshes++; res.end('{}'); return; }
  if (url.pathname.startsWith('/grok/v1/')) {
    let raw=''; for await (const chunk of req) raw+=chunk;
    const body=raw ? JSON.parse(raw) : undefined; requests.push({path:url.pathname,headers:req.headers,body});
    assert.match(req.headers.authorization, /^Bearer grok-secret-/);
    assert.equal(req.headers['x-grok-client-version'],'1.0.41');
    assert.equal(req.headers['x-xai-token-auth'],'xai-grok-cli');
    assert.equal(req.headers['x-grok-client-identifier'],'grok-shell');
    assert.ok(!req.headers.cookie); assert.ok(!req.headers['x-api-key']);
    if (url.pathname.endsWith('/models')) { res.end(JSON.stringify({data:[{id:'grok-fixture',name:'Grok fixture'}]})); return; }
    assert.equal(body.model, 'grok-fixture'); assert.equal(body.stream,true); assert.equal(body.store,false);
    assert.equal(req.headers['x-grok-model-override'],'grok-fixture');
    if(body.tools){assert.ok(body.tools.every(t=>t.type==='function'));assert.ok(body.tools.some(t=>t.name==='apply_patch'));assert.ok(body.tools.some(t=>t.name==='workspace__read_file'));}
    const response={id:'grok-response-fixture',object:'response',status:'completed',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'grok account fixture'}]}],usage:{input_tokens:2,output_tokens:3,total_tokens:5}};
    if(body.tools)response.output=[{type:'function_call',call_id:'patch-call',name:'apply_patch',arguments:JSON.stringify({input:'fixture patch'})},{type:'function_call',call_id:'read-call',name:'workspace__read_file',arguments:JSON.stringify({path:'fixture.txt'})}];
    res.setHeader('content-type','text/event-stream'); res.end(`event: response.completed\ndata: ${JSON.stringify({type:'response.completed',response})}\n\n`); return;
  }
  res.statusCode=404; res.end('{}');
});
server.listen(0,'127.0.0.1'); await once(server,'listening'); origin=`http://127.0.0.1:${server.address().port}`;
const cli=await writeCliFixture(join(fixtureRoot,'grok-fixture'), `
const fs=require('node:fs/promises'),path=require('node:path');
const origin=${JSON.stringify(origin)},home=process.env.GROK_HOME;
(async()=>{
 if(process.argv[2]==='version'){console.log('Grok Build 1.0.41');return;}
 if(process.argv[2]==='models'){const p=path.join(home,'auth.json'),a=JSON.parse(await fs.readFile(p,'utf8'));a.grok.key+='-refreshed';a.grok.expires_at=new Date(Date.now()+3600000).toISOString();await fetch(origin+'/grok-auth/refresh');await fs.writeFile(p,JSON.stringify(a),{mode:0o600});return;}
 if(process.argv[2]!=='login'||process.argv[3]!=='--device-auth')throw new Error('unexpected CLI arguments');
 const start=await(await fetch(origin+'/grok-auth/start?home='+encodeURIComponent(home))).json();console.log(start.url);
 for(let i=0;i<600;i++){await new Promise(r=>setTimeout(r,50));const auth=await(await fetch(origin+'/grok-auth/poll?ticket='+start.ticket)).json();if(auth){await fs.writeFile(path.join(home,'auth.json'),JSON.stringify({grok:auth}),{mode:0o600});return;}}
 process.exitCode=1;
})().catch(()=>{process.exitCode=1});
`);
const binary=nativeTestBinary; let child,queue=[];
const start=()=>{child=spawn(binary,['--rpc','--pilot-root',root,'--subscription-test-endpoint',origin,'--subscription-test-grok-cli',cli],{stdio:['pipe','pipe','inherit']});createInterface({input:child.stdout}).on('line',line=>queue.shift()?.(JSON.parse(line)));};
const call=(method,...args)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`RPC timeout: ${method}`)),35000);queue.push(r=>{clearTimeout(timer);resolve(r)});child.stdin.write(JSON.stringify({method,args})+'\n');});
const rpc=async(method,...args)=>{const r=await call(method,...args);assert.equal(r.ok,true,r.error);return r.result;};
const stop=async()=>{child.stdin.end();await once(child,'exit');};
const complete=async(id)=>{await rpc('beginSubscriptionSignIn',{platform:'grok',accountId:id}); const link=await rpc('subscriptionTestAuthorizationUrl');assert.ok(link.startsWith(origin+'/grok-auth/approve'));await fetch(link); for(let i=0;i<100;i++){const s=await rpc('getSubscriptionAccounts');if(s.flow.status!=='waiting')return s;await new Promise(r=>setTimeout(r,30));}throw new Error('Grok flow did not complete');};
const pass=label=>console.log('PASS '+label);
start();
try {
 assert.deepEqual((await rpc('getSubscriptionAccounts')).accounts,[]);
 const first=await complete();assert.equal(first.flow.status,'complete');const a=first.accounts[0];assert.equal(a.platform,'grok');assert.equal(a.status,'connected');
 const second=await complete();assert.equal(second.accounts.length,2);const b=second.accounts.find(x=>x.id!==a.id);assert.notEqual(a.id,b.id);
 pass('official CLI device flow uses separate owned homes for multiple Grok accounts');
 const pa=(await rpc('connectSubscriptionAccount',a.id)).connections[0], pb=(await rpc('connectSubscriptionAccount',b.id)).connections[1];
 await rpc('switchClientProvider',{client:'codex',providerId:pa.id}); await rpc('updateCodexConfig',{expectedProviderId:pa.id,compatibleModel:'grok-fixture'});
 await rpc('switchClientProvider',{client:'claude',providerId:pb.id});await rpc('updateClaudeModels',{fable:'grok-fixture',opus:'grok-fixture',sonnet:'grok-fixture',haiku:'grok-fixture'});
 const choices=(await rpc('getProviders')).selected;await rpc('renameSubscriptionAccount',{accountId:a.id,label:'Grok 工作'});assert.deepEqual((await rpc('getProviders')).selected,choices);
 assert.equal((await rpc('fetchProviderModels',{providerId:pa.id}))[0].id,'grok-fixture');
 pass('model discovery and rename keep both clients on their explicit account');
 const codex=join(root,'codex/config.toml'),claude=join(root,'claude/settings.json');await writeFile(codex,'model = "original-model"\n');await writeFile(claude,'{"env":{"ORIGINAL":"kept"}}');const beforeCodex=await readFile(codex,'utf8'),beforeClaude=await readFile(claude,'utf8');
 const running=await rpc('toggleTracing',true);
 const headers={'content-type':'application/json',authorization:'Bearer downstream-key',cookie:'private', 'x-grok-client-version':'999.0.0','x-grok-model-override':'wrong-model'};
 const responses=await fetch(running.localBaseUrl+'/v1/responses',{method:'POST',headers,body:JSON.stringify({model:'grok-fixture',input:'fixture',stream:false})});assert.equal(responses.status,200,await responses.clone().text());assert.equal((await responses.json()).output[0].content[0].text,'grok account fixture');
 const messages=await fetch(running.localBaseUrl+'/v1/messages',{method:'POST',headers,body:JSON.stringify({model:'sonnet',max_tokens:16,messages:[{role:'user',content:'fixture'}]})});assert.equal(messages.status,200,await messages.clone().text());assert.equal((await messages.json()).content[0].text,'grok account fixture');
 const routed=requests.filter(r=>r.body);assert.notEqual(routed[0].headers.authorization,routed[1].headers.authorization);
 assert.ok(!JSON.stringify(await rpc('getSubscriptionAccounts')).includes('grok-secret'));assert.ok(!(await readFile(codex,'utf8')).includes('grok-secret'));assert.ok(!(await readFile(claude,'utf8')).includes('grok-secret'));
 const tools=[{type:'custom',name:'apply_patch',format:{type:'text'}},{type:'namespace',name:'workspace',tools:[{type:'function',name:'read_file',parameters:{type:'object',properties:{path:{type:'string'}}}}]}];
 const toolReply=await fetch(running.localBaseUrl+'/v1/responses',{method:'POST',headers,body:JSON.stringify({model:'grok-fixture',input:[{type:'custom_tool_call',call_id:'previous',name:'apply_patch',input:'previous patch'}],tools,stream:false})});assert.equal(toolReply.status,200,await toolReply.clone().text());const toolBody=await toolReply.json();assert.equal(toolBody.output[0].type,'custom_tool_call');assert.equal(toolBody.output[0].input,'fixture patch');assert.equal(toolBody.output[1].name,'read_file');assert.equal(toolBody.output[1].namespace,'workspace');assert.equal(JSON.parse(requests.at(-1).body.input[0].arguments).input,'previous patch');
 const toolStream=await fetch(running.localBaseUrl+'/v1/responses',{method:'POST',headers,body:JSON.stringify({model:'grok-fixture',input:'fixture',tools,stream:true})});assert.equal(toolStream.status,200);assert.match(await toolStream.text(),/custom_tool_call/);pass('Codex namespace and custom tools round-trip through flat Grok functions in JSON and SSE');
 await rpc('toggleTracing',false);assert.equal(await readFile(codex,'utf8'),beforeCodex);assert.deepEqual(JSON.parse(await readFile(claude,'utf8')),JSON.parse(beforeClaude));await assert.rejects(fetch(running.localBaseUrl+'/v1/responses'));
 pass('Responses and Claude Messages reach each account; secret/header isolation and Trace restoration hold');
 nextEmail='wrong@example.test';const wrong=await complete(a.id);assert.equal(wrong.flow.status,'failed');assert.match(wrong.flow.error,/不一致/);assert.equal(wrong.accounts.length,2);assert.equal(wrong.accounts.find(x=>x.id===a.id).label,'Grok 工作');nextEmail=undefined;
 pass('wrong-account re-login preserves prior identity and credentials');
 await rpc('beginSubscriptionSignIn',{platform:'grok'});await rpc('cancelSubscriptionSignIn');await new Promise(r=>setTimeout(r,150));assert.equal((await rpc('getSubscriptionAccounts')).accounts.length,2);assert.equal((await readdir(join(root,'grok-accounts'))).filter(n=>n.startsWith('grok-')).length,2);
 pass('cancelling device authorization removes only the staged home');
 await stop();const authPath=join(root,'grok-accounts',a.id,'auth.json');const auth=JSON.parse(await readFile(authPath,'utf8'));auth.grok.expires_at=new Date(0).toISOString();await writeFile(authPath,JSON.stringify(auth));start();await rpc('fetchProviderModels',{providerId:pa.id});assert.equal(refreshes,1);if(process.platform!=='win32')assert.equal((await stat(authPath)).mode&0o777,0o600);
 assert.equal((await rpc('getProviders')).selected.codex,pa.id);assert.equal((await rpc('getSubscriptionAccounts')).accounts.find(x=>x.id===a.id).label,'Grok 工作');
 await rpc('signOutSubscriptionAccount',a.id);const signedOut=await rpc('getSubscriptionAccounts');assert.equal(signedOut.accounts.find(x=>x.id===a.id).status,'signed-out');assert.equal(signedOut.accounts.find(x=>x.id===b.id).status,'connected');assert.equal((await rpc('getProviders')).selected.codex,pa.id);
 pass('restart, CLI refresh, private permissions and single-account logout retain explicit choices');
 await stop();console.log(JSON.stringify({ok:true,root}));
} finally {if(child.exitCode===null)child.kill('SIGTERM');server.close();}
