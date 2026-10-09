import { nativeTestBinary } from './test-support.mjs';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdtemp, realpath, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-subscriptions-'));
const binary=nativeTestBinary;
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const otherKeys=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...keys.publicKey.export({format:'jwk'}),kid:'fixture-signing',alg:'RS256',use:'sig'};
const codes=new Map(), registrations=new Map(), refreshes=new Map(), calls=[];
let base, mode='valid', responseOutcome='completed', refreshLifetime=3600, refreshFailure=false, registration=0, revocationOK=true, heldExchange, holdReady;
const jwt=(claims,key=keys.privateKey)=>{const h=Buffer.from(JSON.stringify({alg:'RS256',kid:jwk.kid})).toString('base64url');const b=Buffer.from(JSON.stringify(claims)).toString('base64url');return `${h}.${b}.${sign('RSA-SHA256',Buffer.from(`${h}.${b}`),key).toString('base64url')}`;};
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,base);res.setHeader('content-type','application/json');
 if(url.pathname==='/.well-known/jwks.json'){res.end(JSON.stringify({keys:[jwk]}));return;}
 if(url.pathname==='/.well-known/openid-configuration'){res.end(JSON.stringify({revocation_endpoint:base+'/revoke'}));return;}
 if(url.pathname==='/revoke'){res.statusCode=revocationOK?200:503;res.end();return;}
 if(url.pathname==='/api/accounts/authorize'){
  const q=url.searchParams;let client=q.get('client_id');if(client==='dynamic_agent_client'){client=`oaiapp_fixture_${++registration}`;registrations.set(client,{subject:'same-subject',email:'same@example.test'});}
  assert.equal(q.get('resource'),'https://api.openai.com/v1');assert.equal(q.get('code_challenge_method'),'S256');
  if(q.get('client_id')==='dynamic_agent_client')assert.equal(q.get('agent_name_hint'),'XwX Deck');else assert.equal(q.get('agent_name_hint'),null);
  const code=`code-${codes.size}`;codes.set(code,{q,client,mode});const cb=new URL(q.get('redirect_uri'));cb.searchParams.set('state',q.get('state'));cb.searchParams.set('client_id',client);cb.searchParams.set('code',code);
  res.statusCode=302;res.setHeader('location',cb.href);res.end();return;
 }
 let raw='';for await(const chunk of req)raw+=chunk;
 if(url.pathname==='/api/accounts/oauth/token'){
  const f=new URLSearchParams(raw),client=f.get('client_id');const previous=registrations.get(client);
  assert.ok(previous);assert.equal(f.get('resource'),'https://api.openai.com/v1');
  if(f.get('grant_type')==='refresh_token'){
   if(refreshFailure){res.statusCode=400;res.end(JSON.stringify({error:'invalid_grant'}));return;}
   assert.equal(f.get('refresh_token'),previous.refresh);const number=(refreshes.get(client)??0)+1;refreshes.set(client,number);previous.refresh=`refresh-${client}-${number}`;
   res.end(JSON.stringify({access_token:`access-${client}-${number}`,refresh_token:previous.refresh,token_type:'Bearer',expires_in:refreshLifetime,scope:'resource.invoke chatgpt.tokens.use.direct offline_access'}));return;
  }
  const c=codes.get(f.get('code'));assert.ok(c);assert.equal(createHash('sha256').update(f.get('code_verifier')).digest('base64url'),c.q.get('code_challenge'));assert.equal(f.get('redirect_uri'),c.q.get('redirect_uri'));
  if(c.mode==='token-http-error'){res.statusCode=403;res.end(JSON.stringify({error:{code:'invalid_scope',message:'secret-that-must-not-be-logged'}}));return;}
  if(c.mode==='token-http-non-json'){res.statusCode=502;res.end('<html>private upstream body</html>');return;}
  const claims={iss:base,aud:c.mode==='wrong-audience'?'another-app':client,sub:c.mode==='wrong-account'?'another-subject':previous.subject,email:previous.email,nonce:c.mode==='wrong-nonce'?'wrong':c.q.get('nonce'),exp:Math.floor(Date.now()/1000)+(c.mode==='expired'?-300:3600)};
  const t={access_token:`access-${client}-initial`,refresh_token:`refresh-${client}-initial`,token_type:'Bearer',expires_in:1,scope:c.mode==='identity-only'?'openid email':'resource.invoke chatgpt.tokens.use.direct offline_access',id_token:jwt(claims,c.mode==='wrong-signature'?otherKeys.privateKey:keys.privateKey)};
  previous.refresh=t.refresh_token;
  if(c.mode==='held'){holdReady?.();await new Promise(r=>heldExchange=r);}
  res.end(JSON.stringify(t));return;
 }
 if(url.pathname==='/v1/models'){
  calls.push({path:url.pathname,auth:req.headers.authorization});res.end(JSON.stringify({models:[{slug:'plan-model',display_name:'Plan model',visibility:'list'},{slug:'hidden-model',visibility:'hide'}]}));return;
 }
 if(url.pathname==='/v1/responses'){
  const body=JSON.parse(raw);calls.push({path:url.pathname,auth:req.headers.authorization,body});assert.equal(body.store,false);assert.equal(body.stream,true);assert.ok(!req.headers.cookie);assert.ok(!req.headers['x-api-key']);assert.ok(!req.headers['chatgpt-account-id']);assert.ok(!req.headers['openai-organization']);
  const response={id:'resp-fixture',object:'response',status:responseOutcome,model:body.model,output:[{type:'message',id:'msg-fixture',role:'assistant',content:[{type:'output_text',text:'local subscription reply'}]}],usage:{input_tokens:3,output_tokens:4,total_tokens:7}};
  res.setHeader('content-type','text/event-stream');res.end(`event: response.output_text.delta\ndata: ${JSON.stringify({type:'response.output_text.delta',output_index:0,content_index:0,delta:'local subscription reply'})}\n\nevent: response.completed\ndata: ${JSON.stringify({type:`response.${responseOutcome}`,response})}\n\n`);return;
 }
 res.statusCode=404;res.end('{}');
});
server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
let child,queue=[];
const start=()=>{child=spawn(binary,['--rpc','--pilot-root',root,'--subscription-test-endpoint',base],{stdio:['pipe','pipe','pipe']});createInterface({input:child.stdout}).on('line',line=>queue.shift()?.(JSON.parse(line)));child.stderr.on('data',data=>process.stderr.write(data));};
const call=(method,...args)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`RPC timeout ${method}`)),30000);queue.push(r=>{clearTimeout(timer);resolve(r);});child.stdin.write(JSON.stringify({method,args})+'\n');});
const rpc=async(method,...args)=>{const r=await call(method,...args);assert.equal(r.ok,true,r.error);return r.result;};
const stop=async()=>{const finished=once(child,'exit');child.stdin.end();assert.equal((await finished)[0],0);};
const begin=async(accountId)=>{await rpc('beginSubscriptionSignIn',{accountId});const url=await rpc('subscriptionTestAuthorizationUrl');const r=await fetch(url,{redirect:'manual'});return {url:new URL(url),callback:r.headers.get('location')};};
const signin=async()=>{const flow=await begin();await fetch(flow.callback);return rpc('getSubscriptionAccounts');};
const pass=name=>console.log('PASS '+name);
start();
try{
 assert.deepEqual((await rpc('getSubscriptionAccounts')).accounts,[]);assert.deepEqual((await rpc('getProviders')).connections,[]);pass('fresh install has no subscription accounts or default connection');
 mode='valid';const first=await begin();const bad=new URL(first.callback);bad.searchParams.set('state','wrong-state');assert.equal((await fetch(bad)).status,400);assert.equal((await rpc('getSubscriptionAccounts')).flow.status,'waiting');assert.equal((await fetch(first.callback)).status,200);assert.equal((await fetch(first.callback).catch(()=>({status:400}))).status,400);
 let accounts=(await rpc('getSubscriptionAccounts')).accounts;assert.equal(accounts.length,1);const a=accounts[0];await rpc('connectSubscriptionAccount',a.id);pass('PKCE callback, verified JWT, one-time state and account registration');
 for(mode of ['wrong-signature','wrong-audience','wrong-nonce','expired','identity-only']){const s=await signin();assert.equal(s.flow.status,'failed',mode);assert.equal(s.accounts.length,1,mode);}pass('reject forged, wrong-app, wrong-nonce, expired and identity-only authorization');
 for(mode of ['token-http-error','token-http-non-json']){
  const failure=await begin(),response=await fetch(failure.callback),page=await response.text(),snapshot=await rpc('getSubscriptionAccounts');
  assert.equal(response.status,400);assert.ok(page.includes('交换登录凭证失败'));
  assert.ok(snapshot.flow.error.includes(mode==='token-http-error'?'invalid_scope':'502'));
  assert.ok(!page.includes('secret-that-must-not-be-logged')&&!page.includes('private upstream body')&&!page.includes(failure.url.searchParams.get('state')));
 }
 let diagnostic=JSON.parse(await readFile(join(root,'subscription-accounts.json'),'utf8')).lastLoginFailure;
 assert.ok(diagnostic.error.includes('502'));assert.ok(diagnostic.at>0);
 await stop();start();assert.equal((await rpc('getSubscriptionAccounts')).flow.error,diagnostic.error);assert.equal((await rpc('getSubscriptionAccounts')).accounts.length,1);
 pass('failure page names the failed stage and safe HTTP reason; restart retains the reason without OAuth response bodies or transaction secrets');
 mode='valid';const second=await begin();assert.equal(first.url.searchParams.get('ext_agent_host_id'),second.url.searchParams.get('ext_agent_host_id'));await fetch(second.callback);assert.equal(JSON.parse(await readFile(join(root,'subscription-accounts.json'),'utf8')).lastLoginFailure,undefined);accounts=(await rpc('getSubscriptionAccounts')).accounts;assert.equal(accounts.length,2);const b=accounts[1];assert.equal(a.email,b.email);assert.notEqual(a.id,b.id);await rpc('connectSubscriptionAccount',b.id);pass('same-email registrations remain separate and host ID stays stable');
 let providers=await rpc('getProviders');assert.equal(providers.selected.codex,null);assert.equal(providers.selected.claude,null);
 const pa=providers.connections.find(p=>p.subscriptionAccountId===a.id),pb=providers.connections.find(p=>p.subscriptionAccountId===b.id);
 assert.equal(pa.bearerToken,'');assert.ok(!JSON.stringify(providers).includes('access-'));assert.ok(!JSON.stringify(await rpc('getSubscriptionAccounts')).includes('refresh-'));
 const vault=JSON.parse(await readFile(join(root,'subscription-accounts.json'),'utf8'));if(process.platform!=='win32')assert.equal((await stat(join(root,'subscription-accounts.json'))).mode&0o777,0o600);assert.ok(!String(await readFile(join(root,'settings.json'))).includes('access-'));pass('credentials stay in native 0600 vault and never in public snapshots or settings');
 await rpc('switchClientProvider',{client:'codex',providerId:pa.id});await rpc('switchClientProvider',{client:'claude',providerId:pb.id});await rpc('updateCodexConfig',{expectedProviderId:pa.id,compatibleModel:'retained-plan-model'});await rpc('updateClaudeModels',{sonnet:'plan-model'});
 const catalog=await rpc('fetchProviderModels',{providerId:pa.id});assert.deepEqual(catalog.map(m=>m.id),['plan-model']);assert.equal((await rpc('getProviders')).connections.find(p=>p.id===pa.id).codexModel,'retained-plan-model');pass('account-specific model catalog hides hidden models and preserves explicit model choice');
 const choices=(await rpc('getProviders')).selected;const renamed=await rpc('renameSubscriptionAccount',{accountId:a.id,label:'工作账号'});assert.deepEqual(renamed.selected,choices);assert.equal(renamed.connections.find(p=>p.id===pa.id).displayName,'工作账号');assert.equal((await rpc('getSubscriptionAccounts')).accounts.find(x=>x.id===a.id).label,'工作账号');assert.equal((await call('renameSubscriptionAccount',{accountId:a.id,label:''})).ok,false);pass('account rename updates connection metadata while retaining both client selections and models');
 const config=join(root,'codex/config.toml'),claude=join(root,'claude/settings.json');await writeFile(config,'model = "original-local-model"\n');await writeFile(claude,'{"env":{"ORIGINAL":"kept"}}');const beforeCodex=await readFile(config,'utf8'),beforeClaude=JSON.parse(await readFile(claude,'utf8'));
 const running=await rpc('toggleTracing',true),url=running.localBaseUrl;
 const send=(path,body)=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer downstream-never-forward',cookie:'do-not-forward', 'x-api-key':'do-not-forward','chatgpt-account-id':'wrong-workspace','openai-organization':'wrong-organization'},body:JSON.stringify(body)});
 const [codex,claudeReply]=await Promise.all([send('/v1/responses',{model:'retained-plan-model',input:'local fixture',stream:false,store:true}),send('/v1/messages',{model:'sonnet',max_tokens:32,messages:[{role:'user',content:'local fixture'}]})]);
 assert.equal(codex.status,200);assert.equal((await codex.json()).output[0].content[0].text,'local subscription reply');assert.equal(claudeReply.status,200);assert.equal((await claudeReply.json()).content[0].text,'local subscription reply');
 const routed=calls.filter(c=>c.body);assert.ok(routed.find(c=>c.body.model==='retained-plan-model').auth.includes(vault.accounts.find(x=>x.id===a.id).clientId));assert.ok(routed.find(c=>c.body.model==='plan-model').auth.includes(vault.accounts.find(x=>x.id===b.id).clientId));assert.equal([...refreshes.values()].reduce((n,v)=>n+v,0),2);pass('two clients use their own explicit account and rotating token; real Responses and Messages requests complete');
 const sse=await send('/v1/messages',{model:'sonnet',stream:true,max_tokens:32,messages:[{role:'user',content:'local fixture'}]});const stream=await sse.text();assert.ok(stream.includes('message_stop'));assert.ok(stream.includes('local subscription reply'));pass('subscription Responses stream converts to Claude Messages SSE');
 const compactReply=await send('/v1/responses/compact',{model:'retained-plan-model',input:'subscription history to retain'});assert.equal(compactReply.status,200,await compactReply.clone().text());const checkpoint=await compactReply.json();assert.equal(checkpoint.object,'response.compaction');assert.match(checkpoint.output[0].encrypted_content,/^xwxc1:/);
 const resumed=await send('/v1/responses',{model:'retained-plan-model',input:[checkpoint.output[0],{role:'user',content:'continue after compact'}]});assert.equal(resumed.status,200);await resumed.text();assert.match(JSON.stringify(calls.at(-1).body),/context checkpoint/);assert.ok(!JSON.stringify(calls.at(-1).body).includes('xwxc1:'));pass('subscription compaction uses the selected model and resumes with a portable plaintext checkpoint');
 responseOutcome='incomplete';assert.equal((await send('/v1/responses',{model:'plan-model',input:'local incomplete fixture'})).status,502);responseOutcome='completed';pass('incomplete subscription inference cannot be reported as success');
 assert.ok(!String(await readFile(config)).includes('access-'));assert.ok(!String(await readFile(claude)).includes('access-'));
 await rpc('toggleTracing',false);assert.equal(await readFile(config,'utf8'),beforeCodex);assert.deepEqual(JSON.parse(await readFile(claude,'utf8')),beforeClaude);await assert.rejects(fetch(url+'/v1/responses'));pass('Trace stop restores original client routes and closes Gateway without exporting OAuth tokens');
 await stop();start();assert.equal((await rpc('getSubscriptionAccounts')).accounts.length,2);assert.equal((await rpc('getProviders')).selected.codex,pa.id);pass('restart retains multiple registrations and independent client selections');
 // Force an expiring session in the isolated vault, and poison only the public account URL.
 await rpc('switchClientProvider',{client:'claude',providerId:pa.id});await stop();
 let saved=JSON.parse(await readFile(join(root,'subscription-accounts.json'),'utf8'));saved.accounts.find(x=>x.id===a.id).expires=0;await writeFile(join(root,'subscription-accounts.json'),JSON.stringify(saved));
 const settings=JSON.parse(await readFile(join(root,'settings.json'),'utf8'));settings.connections.find(p=>p.id===pa.id).baseUrl='http://127.0.0.1:9/never-send-oauth-here';await writeFile(join(root,'settings.json'),JSON.stringify(settings));
 refreshLifetime=62;start();const again=await rpc('toggleTracing',true);await new Promise(r=>setTimeout(r,3100));refreshLifetime=3600;
 const clientId=vault.accounts.find(x=>x.id===a.id).clientId,refreshCount=refreshes.get(clientId);
 const both=await Promise.all(['/v1/responses','/v1/messages'].map(path=>fetch(again.localBaseUrl+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(path.endsWith('messages')?{model:'sonnet',max_tokens:16,messages:[{role:'user',content:'local fixture'}]}:{model:'plan-model',input:'local fixture'})})));
 for(const response of both){assert.equal(response.status,200);await response.text();}assert.equal(refreshes.get(clientId),refreshCount+1);pass('concurrent clients share one token rotation and fixed official API root ignores edited public URL');
 // Kill instead of stopping to exercise the persisted recovery journal.
 let exited=once(child,'exit');child.kill('SIGKILL');await exited;start();await rpc('getState');assert.equal(await readFile(config,'utf8'),beforeCodex);assert.deepEqual(JSON.parse(await readFile(claude,'utf8')),beforeClaude);await assert.rejects(fetch(again.localBaseUrl+'/v1/responses'));pass('crash recovery removes subscription Gateway and restores pre-start client configuration');
 mode='wrong-account';const reauth=await begin(a.id);assert.equal(reauth.url.searchParams.get('client_id'),vault.accounts.find(x=>x.id===a.id).clientId);assert.ok(reauth.url.searchParams.get('id_token_hint'));await fetch(reauth.callback);assert.equal((await rpc('getSubscriptionAccounts')).flow.status,'failed');assert.equal((await rpc('getSubscriptionAccounts')).accounts.length,2);pass('reauthorization reuses issued client ID and rejects identity change');
 mode='held';const held=await begin();const ready=new Promise(r=>holdReady=r);const pending=fetch(held.callback);await ready;await rpc('cancelSubscriptionSignIn');heldExchange();await pending;assert.equal((await rpc('getSubscriptionAccounts')).accounts.length,2);assert.equal((await rpc('getSubscriptionAccounts')).flow.status,'cancelled');pass('cancel during token exchange cannot add an account');
 await stop();saved=JSON.parse(await readFile(join(root,'subscription-accounts.json'),'utf8'));saved.accounts.find(x=>x.id===a.id).expires=0;await writeFile(join(root,'subscription-accounts.json'),JSON.stringify(saved));refreshFailure=true;start();
 assert.equal((await call('fetchProviderModels',{providerId:pa.id})).ok,false);assert.equal((await rpc('getSubscriptionAccounts')).accounts.find(x=>x.id===a.id).status,'signed-out');assert.equal((await rpc('getProviders')).selected.codex,pa.id);refreshFailure=false;pass('invalid refresh requires login while retaining explicit account and model selection');
 // Explicit takeover of an external route authorizes only that unchanged pre-start route.
 await writeFile(config,'model_provider = "external_fixture"\nmodel = "external-model"\n');
 await writeFile(claude,JSON.stringify({env:{ANTHROPIC_BASE_URL:base+'/external',ANTHROPIC_AUTH_TOKEN:'external-test-key'}}));
 assert.equal((await call('switchClientProvider',{client:'codex',providerId:pb.id})).ok,false);
 await rpc('switchClientProvider',{client:'codex',providerId:pb.id,takeOverExternalConfig:true});await rpc('switchClientProvider',{client:'claude',providerId:pb.id,takeOverExternalConfig:true});
 await rpc('updateCodexConfig',{expectedProviderId:pb.id,compatibleModel:'plan-model'});
 const externalCodex=await readFile(config,'utf8'),externalClaude=JSON.parse(await readFile(claude,'utf8'));await rpc('toggleTracing',true);await rpc('toggleTracing',false);assert.equal(await readFile(config,'utf8'),externalCodex);assert.deepEqual(JSON.parse(await readFile(claude,'utf8')),externalClaude);
 await rpc('switchClientProvider',{client:'codex',providerId:pa.id});pass('external routes require explicit takeover and are restored after subscription Trace');
 revocationOK=false;const out=await rpc('signOutSubscriptionAccount',a.id);assert.equal(out.revoked,false);assert.ok(out.warning);assert.equal((await rpc('getSubscriptionAccounts')).accounts.find(x=>x.id===a.id).status,'signed-out');assert.equal((await rpc('getSubscriptionAccounts')).accounts.find(x=>x.id===b.id).status,'connected');assert.equal((await rpc('getProviders')).selected.codex,pa.id);pass('sign-out clears only target credentials and reports unconfirmed remote revocation without replacing selection');
 await stop();console.log(JSON.stringify({ok:true,root}));
}finally{if(child.exitCode===null)child.kill('SIGTERM');server.close();}
