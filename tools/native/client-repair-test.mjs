import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { nativeTestBinary } from './test-support.mjs';
const root = await mkdtemp(join(await realpath(tmpdir()), 'xwxdeck-client-repair-'));
const env = { ...process.env, XWX_DECK_TEST_SECURE_STORE:'1' }, checks = [], held = [];
let child, queue = [], requestCount = 0, lastModel;
const server = createServer(async (req,res) => {
  if (req.url.endsWith('/models')) { res.end('{"data":[{"id":"latest-codex-model"}]}'); return; }
  let text = ''; for await (const chunk of req) text += chunk; const body = JSON.parse(text); requestCount++; lastModel = body.model;
  if (body.input === 'held') { res.writeHead(200,{'content-type':'text/event-stream'}); res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"accepted"}\n\n'); held.push(res); return; }
  res.setHeader('content-type','application/json'); res.end(JSON.stringify({id:'fixture',object:'response',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'direct'}]}],usage:{input_tokens:1,output_tokens:1}}));
});
server.listen(0,'127.0.0.1'); await once(server,'listening'); const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const codexPath = join(root,'codex/config.toml'), claudePath = join(root,'claude/settings.json');
function start() { queue=[]; child=spawn(nativeTestBinary,['--rpc','--pilot-root',root],{env,stdio:['pipe','pipe','pipe']}); createInterface({input:child.stdout}).on('line',line=>queue.shift()?.(JSON.parse(line))); child.stderr.resume(); }
async function call(method,...args) { return new Promise((resolve,reject)=>{ const timer=setTimeout(()=>reject(Error(method+' timed out')),20000);queue.push(value=>{clearTimeout(timer);resolve(value)});child.stdin.write(JSON.stringify({method,args})+'\n'); }); }
async function rpc(method,...args) { const result=await call(method,...args);assert.equal(result.ok,true,result.error);return result.result; }
async function stop() { const exit=once(child,'exit');child.stdin.end();assert.equal((await exit)[0],0); }
const pass=name=>{checks.push(name);console.log('PASS '+name)};
let report={passed:false,checks,isolatedFixtures:true};
try {
  start(); await rpc('getState');
  await writeFile(codexPath,"# keep top\nmodel='initial' # preserve model comment\nuser_flag=true\n[model_providers.other]\nbase_url='https://other.invalid'\n");
  await writeFile(claudePath,JSON.stringify({permissions:{allow:['Read']},env:{MY_VAR:'keep'}}));
  await rpc('saveProvider',{id:'codex-api',displayName:'Fixture_8526ade3',providerPreset:'custom',baseUrl,bearerToken:'synthetic-codex',adapter:'responses',codexModel:'latest-codex-model'});
  await rpc('saveProvider',{id:'claude-api',displayName:'Fixture_8526ade3',providerPreset:'custom',baseUrl,bearerToken:'synthetic-claude',adapter:'anthropic-messages',claudeModels:{sonnet:'latest-claude-model'}});
  await rpc('switchClientProvider',{client:'codex',providerId:'codex-api'});
  await rpc('switchClientProvider',{client:'claude',providerId:'claude-api'});
  await rpc('updateClaudeModels',{sonnet:'latest-claude-model'});
  const active=await rpc('toggleTracing',true), gateway=active.localBaseUrl;
  const accepted=await fetch(gateway+'/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'latest-codex-model',input:'held',stream:true})});
  assert.equal(accepted.status,200);
  let outsideCodex=(await readFile(codexPath,'utf8')).replaceAll(gateway,'https://external.invalid').replace(/model\s*=\s*['"]latest-codex-model['"]/,'model="external-model"')+'\n# latest external note\n';
  const outsideClaude=JSON.stringify({permissions:{allow:['Read','Glob']},custom:{keep:true},env:{MY_VAR:'new-value',ANTHROPIC_BASE_URL:'https://external.invalid',ANTHROPIC_AUTH_TOKEN:'OUTSIDE-SYNTHETIC-SECRET',ANTHROPIC_DEFAULT_SONNET_MODEL:'external-model'}},null,2);
  await writeFile(codexPath,outsideCodex); await writeFile(claudePath,outsideClaude);
  const beforeBackups=(await readdir(root)).filter(name=>name.startsWith('client-repair-'));
  const invalid=await call('repairClientProviderSwitch',{client:'codex',providerId:'missing'});assert.equal(invalid.ok,false);assert.equal(await readFile(codexPath,'utf8'),outsideCodex);assert.deepEqual((await readdir(root)).filter(name=>name.startsWith('client-repair-')),beforeBackups);
  pass('an invalid repair target cannot overwrite external fields or create a misleading repair backup');
  const stopped=await call('toggleTracing',false,true);assert.equal(stopped.ok,false);assert.equal(await readFile(codexPath,'utf8'),outsideCodex);assert.equal(await readFile(claudePath,'utf8'),outsideClaude);
  await rpc('repairClientProviderSwitch',{client:'codex'});
  const codex=await readFile(codexPath,'utf8');assert.match(codex,/latest-codex-model/);assert.ok(codex.includes('# preserve model comment')&&codex.includes('# latest external note'));assert.ok(codex.includes('https://other.invalid'));assert.equal(await readFile(claudePath,'utf8'),outsideClaude);
  assert.equal((await rpc('getState')).localBaseUrl,gateway);assert.equal(requestCount,1);
  pass('confirmed Codex repair uses the latest saved model, retains comments and foreign providers, and leaves the separately conflicting Claude file and in-flight request untouched');
  await rpc('repairClientProviderSwitch',{client:'claude'});
  const claude=JSON.parse(await readFile(claudePath,'utf8'));assert.equal(claude.env.ANTHROPIC_DEFAULT_SONNET_MODEL,'latest-claude-model');assert.equal(claude.env.MY_VAR,'new-value');assert.deepEqual(claude.permissions.allow,['Read','Glob']);assert.equal(claude.custom.keep,true);assert.equal((await rpc('getState')).activeRequests,1);assert.equal(requestCount,1);
  const busy=await call('toggleTracing',false);assert.equal(busy.ok,false);assert.match(busy.error,/回复.*生成|连接仍在使用/);
  held[0].end('event: response.completed\ndata: {"type":"response.completed"}\n\n');assert.match(await accepted.text(),/accepted/);
  await rpc('toggleTracing',false);
  assert.ok(!(await readFile(codexPath,'utf8')).includes(gateway));assert.ok(!(await readFile(claudePath,'utf8')).includes(gateway));
  pass('both conflicted clients can be repaired sequentially while Trace runs; accepted output is not replayed, and normal stop restores both direct routes after completion');
  const rawBackups=(await readdir(root)).filter(name=>name.startsWith('client-repair-'));assert.ok(rawBackups.length>=2);
  for(const name of rawBackups){const text=await readFile(join(root,name),'utf8');assert.equal(JSON.parse(text).nativeEncryptedDocument,1);assert.ok(!text.includes('OUTSIDE-SYNTHETIC-SECRET'));}
  const drift=JSON.parse(await readFile(claudePath,'utf8'));drift.env.ANTHROPIC_BASE_URL='https://new-external.invalid';drift.env.MY_VAR='newer';await writeFile(claudePath,JSON.stringify(drift));
  await rpc('repairClientProviderSwitch',{client:'claude'});const directClaude=JSON.parse(await readFile(claudePath,'utf8'));assert.equal(directClaude.env.MY_VAR,'newer');assert.ok(directClaude.env.ANTHROPIC_BASE_URL.includes('127.0.0.1'));
  pass('confirmed direct Claude repair accepts drift for a regular API configuration and preserves unrelated fields');
  const directCodex=await readFile(codexPath,'utf8');await rpc('toggleTracing',true);await writeFile(codexPath,directCodex);
  const exit=once(child,'exit');child.kill('SIGKILL');await exit;start();const recovered=await rpc('getState');assert.equal(recovered.tracingEnabled,false);assert.ok(!(await readFile(codexPath,'utf8')).includes(gateway));assert.ok(!(await readFile(claudePath,'utf8')).includes('44233'));await stop();
  pass('restart recovers a partially restored gateway idempotently without overwriting already-direct fields');
  start(); await rpc('switchClientProvider',{client:'codex',providerId:null});
  await writeFile(join(root,'codex/auth.json'),JSON.stringify({OPENAI_API_KEY:'SYNTHETIC-OFFICIAL-ONLY'}));
  await writeFile(codexPath,'openai_base_url = '+JSON.stringify(baseUrl)+'\n'+await readFile(codexPath,'utf8'));
  await rpc('updateCodexConfig',{officialModel:'official-saved',modelContextWindow:64000});
  const official=await rpc('toggleTracing',true);
  await writeFile(codexPath,(await readFile(codexPath,'utf8')).replaceAll(official.localBaseUrl,'https://external-official.invalid').replace(/model\s*=\s*['"]official-saved['"]/,'model="outside-model"'));
  await rpc('repairClientProviderSwitch',{client:'codex'});
  const officialConfig=await readFile(codexPath,'utf8');assert.match(officialConfig,/model\s*=\s*['"]official-saved['"]/);assert.match(officialConfig,/model_context_window\s*=\s*64000/);
  const officialResponse=await fetch(official.localBaseUrl+'/v1/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'official-saved',input:'official local fixture'})});assert.equal(officialResponse.status,200);await officialResponse.json();assert.equal(lastModel,'official-saved');
  await rpc('toggleTracing',false);assert.ok((await readFile(codexPath,'utf8')).includes(baseUrl));await stop();
  pass('official-mode repair retains the explicitly saved model and context window and completes a real request through the repaired Gateway');

  const destination=join(root,'..','export-'+createHash('sha256').update(root).digest('hex').slice(0,12));
  try {
    const result=spawnSync(nativeTestBinary,['--export-credential-backup',root,'--export-destination',destination,'--export-isolated-test'],{env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
    const backups=await Promise.all(rawBackups.map(async name=>JSON.parse(await readFile(join(destination,name),'utf8'))));
    assert.ok(backups.some(value=>value.client==='codex'&&value.before===outsideCodex));assert.ok(backups.some(value=>value.client==='claude'&&value.before===outsideClaude));
    for(const value of backups)assert.equal(value.sha256,createHash('sha256').update(value.before).digest('hex'));
    pass('sealed repair backups export the exact pre-repair bytes and matching hashes for both clients');
  } finally { await rm(destination,{recursive:true,force:true}); }
  report={...report,passed:true,requests:requestCount,scope:'actual native RPC, held local HTTP response, encrypted synthetic vault, file changes and process crash; no user clients or real credentials'};
} finally {
  if(child?.exitCode===null && child?.signalCode===null){child.kill('SIGKILL');await once(child,'exit').catch(()=>{});}
  for(const response of held)response.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  report.binarySha256=createHash('sha256').update(await readFile(nativeTestBinary)).digest('hex');await mkdir('test-results',{recursive:true});await writeFile('test-results/native-client-repair-summary.json',JSON.stringify(report,null,2)+'\n');await rm(root,{recursive:true,force:true});
}
