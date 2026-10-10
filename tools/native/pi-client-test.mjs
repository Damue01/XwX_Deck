// Opt-in real Pi CLI, generated native configuration, synthetic local upstream only.
import assert from 'node:assert/strict';
import {mkdtemp, realpath, mkdir, readFile, writeFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {nativeTestBinary} from './test-support.mjs';

const entry = process.env.XWX_INSTALLED_PI;
if (!entry) throw Error('Set XWX_INSTALLED_PI to the official Pi JavaScript CLI entry; no global installation is required.');
await readFile(entry);
const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-real-pi-'));
const home = join(root, 'deck/client-home'), workspace = join(root, 'workspace'), agent = join(home, '.pi/agent');
await mkdir(workspace);
const calls = [], checks = [];
let passed = false, child, pending = [];
const upstream = createServer(async (req, res) => {
  if (!req.url.startsWith('/a/v1/') && !req.url.startsWith('/b/v1/')) { res.writeHead(403); res.end('External requests rejected'); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({data:[{id:'fixture-a'},{id:'fixture-b'}]})); return; }
  calls.push({path:req.url, model:body.model, auth:req.headers.authorization});
  const id = 'local-' + calls.length, answer = 'isolated Pi ' + body.model;
  res.writeHead(200, {'content-type':'text/event-stream'});
  if (req.url.endsWith('/responses')) {
    const message = {id:'msg-' + id, type:'message', status:'completed', role:'assistant', content:[{type:'output_text', text:answer, annotations:[]}]};
    const response = {id, object:'response', status:'completed', model:body.model, output:[message], usage:{input_tokens:10,output_tokens:4,total_tokens:14}};
    const emit = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    emit({type:'response.created',response:{...response,status:'in_progress',output:[]}});
    emit({type:'response.output_item.added',output_index:0,item:{...message,status:'in_progress',content:[]}});
    emit({type:'response.content_part.added',output_index:0,content_index:0,item_id:message.id,part:{type:'output_text',text:'',annotations:[]}});
    emit({type:'response.output_text.delta',output_index:0,content_index:0,item_id:message.id,delta:answer});
    emit({type:'response.output_item.done',output_index:0,item:message});
    emit({type:'response.completed',response}); res.end();
  } else {
    const emit = chunk => res.write('data: ' + JSON.stringify({id,object:'chat.completion.chunk',created:1,model:body.model,...chunk}) + '\n\n');
    emit({choices:[{index:0,delta:{role:'assistant',content:answer},finish_reason:null}]});
    emit({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}});
    res.end('data: [DONE]\n\n');
  }
});
upstream.on('connect', (_req,socket) => { socket.on('error', () => {}); socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
upstream.listen(0,'127.0.0.1'); await once(upstream,'listening');
const base = `http://127.0.0.1:${upstream.address().port}`;
// Allowlist environment: no normal credentials, extension discovery or account directories.
const env = Object.fromEntries(['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','TMPDIR','TMP','TEMP'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
Object.assign(env,{HOME:home,USERPROFILE:home,APPDATA:join(home,'AppData/Roaming'),LOCALAPPDATA:join(home,'AppData/Local'),XDG_CONFIG_HOME:join(home,'.config'),XDG_DATA_HOME:join(home,'.local/share'),PI_CODING_AGENT_DIR:agent,PI_OFFLINE:'1',PI_TELEMETRY:'0',HTTP_PROXY:base,HTTPS_PROXY:base,ALL_PROXY:base,http_proxy:base,https_proxy:base,all_proxy:base,NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'});
async function cli(args) {
  const cliProcess = spawn(process.execPath,[resolve(entry),...args],{cwd:workspace,env,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr=''; cliProcess.stdout.on('data',bytes=>stdout+=bytes);cliProcess.stderr.on('data',bytes=>stderr+=bytes);
  const timer=setTimeout(()=>cliProcess.kill('SIGKILL'),30000);
  try { const [code]=await once(cliProcess,'exit');assert.equal(code,0,stderr+stdout);return stdout; }
  finally {clearTimeout(timer);if(cliProcess.exitCode===null)cliProcess.kill('SIGKILL');}
}
function start() {
  child=spawn(nativeTestBinary,['--rpc','--pilot-root',join(root,'deck')],{env:{...process.env,XWX_CLIENT_INSTALLATIONS_TEST_HOME:home},stdio:['pipe','pipe','inherit']});pending=[];
  createInterface({input:child.stdout}).on('line',line=>pending.shift()?.(JSON.parse(line)));
}
function rpc(method,...args) {return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(method+' timeout')),20000);pending.push(result=>{clearTimeout(timer);result.ok?resolve(result.result):reject(Error(result.error));});child.stdin.write(JSON.stringify({method,args})+'\n');});}
async function stop() {if(child.exitCode!==null){child=null;return;}const exited=once(child,'exit');child.stdin.end();assert.equal((await exited)[0],0);child=null;}
const pass = label => {checks.push(label);console.log('PASS '+label);};
const args=['--offline','--no-session','--no-tools','--no-mcp','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-approve','-p','Return one short response.'];
let version;
try {
  start();await rpc('getState');
  await Promise.all([mkdir(agent, {recursive:true}),mkdir(join(home,'.local/bin'),{recursive:true})]);
  version=(await cli(['--version'])).trim();
  const originalModels=JSON.stringify({providers:{original:{baseUrl:base+'/a/v1',api:'openai-completions',apiKey:'SYNTHETIC-DIRECT',models:[{id:'direct-model',name:'direct-model'}]}}});
  const originalSettings=JSON.stringify({defaultProvider:'original',defaultModel:'direct-model',enabledModels:['original/direct-model'],quietStartup:true});
  await writeFile(join(agent,'models.json'),originalModels);await writeFile(join(agent,'settings.json'),originalSettings);
  assert.match(await cli(args),/isolated Pi direct-model/);assert.equal(calls.at(-1).auth,'Bearer SYNTHETIC-DIRECT');
  pass('official Pi reads the seeded direct configuration and completes a local SSE request');
  // Detection sees the real official CLI entry, not a no-op installation fixture.
  if (process.platform==='win32') await writeFile(join(home,'.local/bin/pi.cmd'),`@echo off\r\n"${process.execPath}" "${resolve(entry)}" %*\r\n`);
  else await symlink(resolve(entry),join(home,'.local/bin/pi'));
  await rpc('addModelClient','pi');
  for (const [id,adapter] of [['a','chat-completions'],['b','responses']]) await rpc('saveProvider',{id,displayName:'Pi fixture '+id,baseUrl:base+'/'+id+'/v1',bearerToken:'SYNTHETIC-'+id,adapter,codexApiFormat:adapter,codexModel:'fixture-'+id});
  async function choose(id,model) {const route=await rpc('getClientRoute','pi');await rpc('setClientRoute',{client:'pi',providerId:id,model,configDigest:route.configDigest,takeoverConfirmed:true});}
  await choose('a','fixture-a');const state=await rpc('toggleTracing',true);
  assert.match(await cli(args),/isolated Pi fixture-a/);assert.equal(calls.at(-1).path,'/a/v1/chat/completions');assert.equal(calls.at(-1).auth,'Bearer SYNTHETIC-a');
  const generated=JSON.parse(await readFile(join(agent,'models.json'),'utf8'));
  assert.equal(generated.providers.xwx_deck.api,'openai-completions');assert.ok(generated.providers.xwx_deck.baseUrl.includes('/clients/pi/'));
  pass('official Pi consumes native generated models/settings and calls the selected Gateway route');
  await choose('b','fixture-b');assert.match(await cli(args),/isolated Pi fixture-b/);assert.equal(calls.at(-1).path,'/b/v1/responses');assert.equal(calls.at(-1).auth,'Bearer SYNTHETIC-b');
  await choose('b','second-explicit-model');assert.match(await cli(args),/isolated Pi second-explicit-model/);assert.equal(calls.at(-1).model,'second-explicit-model');
  assert.equal((await rpc('getTraceStats')).total.tokens,42);
  pass('provider and model switches use the latest selection, including Chat to Responses conversion with single-counted usage');
  await rpc('toggleTracing',false);assert.equal(await readFile(join(agent,'models.json'),'utf8'),originalModels);assert.equal(await readFile(join(agent,'settings.json'),'utf8'),originalSettings);
  await assert.rejects(fetch(state.localBaseUrl+'/clients/pi/v1/models'));assert.match(await cli(args),/isolated Pi direct-model/);
  pass('Trace stop restores exact original files, closes the Gateway and Pi can immediately call direct again');
  await stop();start();assert.equal((await rpc('getClientRoute','pi')).model,'second-explicit-model');
  await rpc('toggleTracing',true);const settings=JSON.parse(await readFile(join(agent,'settings.json'),'utf8'));settings.quietStartup=false;await writeFile(join(agent,'settings.json'),JSON.stringify(settings));await rpc('toggleTracing',false);
  const restored=JSON.parse(await readFile(join(agent,'settings.json'),'utf8'));assert.equal(restored.defaultProvider,'original');assert.equal(restored.quietStartup,false);
  pass('restart retains the chosen model while stop preserves an unrelated external settings edit');
  passed=true;
} finally {
  if(child){await rpc('toggleTracing',false).catch(()=>{});await stop();}
  upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));
  const report={passed,version,checks,actualRequests:calls.length,requests:calls.map(({path,model})=>({path,model})),binarySha256:createHash('sha256').update(await readFile(nativeTestBinary)).digest('hex'),scope:'Official Pi executable with generated native files and synthetic local credentials; no real platform inference or running interactive-session reload claim'};
  await mkdir('test-results',{recursive:true});await writeFile('test-results/native-pi-client.json',JSON.stringify(report,null,2)+'\n');
  if(passed)await rm(root,{recursive:true,force:true});else console.error('Retained isolated Pi fixture:',root);
}
