// Schema contracts inspected at yetone/magpie 9b04c4e and farion1231/cc-switch 5de6feb.
// Real native discovery/import; synthetic credentials and files, no live upstream.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { nativeTestBinary } from './test-support.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-import-contract-'));
const home = join(root, 'import-sources'), clients = join(root, 'client-home');
const checks = [];
let child, queue = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log('PASS '+name); };
async function file(path, value) { await mkdir(dirname(path), {recursive:true}); await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), {mode:0o600}); return path; }
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
function start() {
  child = spawn(nativeTestBinary, ['--rpc', '--pilot-root', root]);
  createInterface({input:child.stdout}).on('line', line => queue.shift()?.(JSON.parse(line)));
  child.stderr.on('data', data => process.stderr.write(data));
}
async function call(method, ...args) {
  return new Promise((resolve,reject) => {
    const timer = setTimeout(()=>reject(Error(method+' timed out')),20000);
    queue.push(result => {clearTimeout(timer);resolve(result);});
    child.stdin.write(JSON.stringify({method,args})+'\n');
  });
}
async function rpc(method,...args) { const result=await call(method,...args); assert.equal(result.ok,true,result.error); return result.result; }
async function stop() { const done=once(child,'exit'); child.stdin.end(); assert.equal((await done)[0],0); }
try {
  start(); await rpc('getState');
  const magpie=await file(join(home,'.config/magpie/providers.json'),{providers:[
    {id:'relay',name:'Magpie Relay',responses:'https://relay.example/v1',anthropic:'https://relay.example/anthropic',key:'fixture-primary',keyProtocol:'responses',models:['model/one'],keys:[{name:'Messages key',key:'fixture-secondary',protocol:'anthropic',off:true}]},
    {id:'body',name:'Body overrides',chat:'https://body.example/v1',key:'fixture-body',extraBody:{'!model':'override'}},
    {id:'loop',name:'Managed loop',chat:'http://127.0.0.1:3499/v1',key:'fixture-loop'}
    ,{id:'many',name:'Many models',chat:'https://many.example/v1',key:'fixture-many',models:Array.from({length:1001},(_,i)=>'model-'+i)}
  ]});
  await file(join(home,'.config/magpie/settings.json'),{port:3499});
  await file(join(home,'.config/magpie/logins.json'),[{agent:'codex',user:'removed@example.test',auth:{},hidden:'removed-source-login'}]);
  const cc=join(home,'moved-cc'); await mkdir(cc,{recursive:true});
  await file(join(home,'app-data/com.ccswitch.desktop/app_paths.json'),{app_config_dir_override:cc});
  const db=new DatabaseSync(join(cc,'cc-switch.db'));
  db.exec('CREATE TABLE providers(id TEXT,app_type TEXT,name TEXT,settings_config TEXT,meta TEXT);CREATE TABLE proxy_config(listen_port INTEGER);INSERT INTO proxy_config VALUES(15888)');
  const insert=db.prepare('INSERT INTO providers VALUES(?,?,?,?,?)');
  insert.run('v2','opencode','CC v2',JSON.stringify({package:'@opencode/ai/providers/openai-compatible',settings:{baseURL:'https://cc.example/v1',apiKey:'fixture-cc'},models:{'cc-model':{}}}),'{}');
  insert.run('v2-responses','opencode','CC v2 Responses',JSON.stringify({package:'@opencode/ai/providers/openai',settings:{baseURL:'https://cc-responses.example/v1',apiKey:'fixture-cc-responses'},models:{'cc-responses-model':{}}}),'{}');
  const grokConfig='[models]\ndefault="relay"\n[model.relay]\nname="Relay"\nmodel="grok-exact"\nbase_url="https://grok-relay.example/v1"\napi_key="fixture-grok"\napi_backend="responses"\ncontext_window=500000\n';
  insert.run('grok','grokbuild','CC Grok Build',JSON.stringify({config:grokConfig}),'{}');
  insert.run('grok-env','grokbuild','CC Grok environment',JSON.stringify({config:grokConfig.replace('api_key="fixture-grok"','env_key="XAI_SECRET_ENV"')}),'{}');
  insert.run('claude-env','claude','Claude credential reference',JSON.stringify({env:{ANTHROPIC_BASE_URL:'https://claude-env.example',ANTHROPIC_API_KEY:'$SECRET_API_KEY'}}),'{}');
  insert.run('merged-window','codex','Many models Codex',JSON.stringify({config:'model_provider="relay"\nmodel="model-0"\nmodel_context_window=200000\n[model_providers.relay]\nbase_url="https://many.example/v1"\nexperimental_bearer_token="fixture-many"\nwire_api="chat"\n'}),'{}');
  insert.run('pi-env','pi','Pi environment',JSON.stringify({baseUrl:'https://pi-env.example/v1',api:'openai-completions',apiKey:'PI_SECRET_ENV'}),'{}');
  insert.run('copilot','codex','Managed login',JSON.stringify({auth:{},config:''}),JSON.stringify({authBinding:{kind:'managed_account'}}));
  db.close();
  const ccClaude=join(home,'cc-claude');
  await file(join(cc,'settings.json'),{claudeConfigDir:ccClaude});
  const alternate=await file(join(ccClaude,'claude.json'),{env:{ANTHROPIC_BASE_URL:'https://alternate.example',ANTHROPIC_API_KEY:'fixture-alternate',ANTHROPIC_DEFAULT_OPUS_MODEL:'exact-opus'}});
  const legacy=await file(join(root,'claude/claude.json'),{env:{ANTHROPIC_BASE_URL:'https://legacy.example',ANTHROPIC_API_KEY:'fixture-legacy',ANTHROPIC_DEFAULT_SONNET_MODEL:'exact-sonnet'}});
  const open=await file(join(clients,'.config/opencode/opencode.jsonc'),'// real JSONC layout\n{"provider":{"relay":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"https://open.example/v1","apiKey":"fixture-open"},"models":{"open-exact":{}}}},}');
  const pi=await file(join(clients,'.pi/agent/models.json'),{providers:{relay:{baseUrl:'https://pi.example/v1',api:'openai-responses',apiKey:'fixture-pi',models:[{id:'pi-exact'}]}}});
  const droid=await file(join(clients,'.factory/settings.json'),{customModels:['droid-one','droid-two'].map(model=>({id:model,model,displayName:model,baseUrl:'https://droid.example/v1',apiKey:'fixture-droid',provider:'generic-chat-completion-api'}))});
  await file(join(clients,'.workbuddy/models.json'),{models:[{id:'work-model',name:'Work model',url:'https://work.example/v1/chat/completions',apiKey:'fixture-work'}]});
  await file(join(clients,'.qwen/settings.json'),{providerProtocol:{relay:'openai'},env:{QWEN_KEY:'fixture-qwen'},modelProviders:{relay:[{id:'qwen-model',baseUrl:'https://qwen.example/v1',envKey:'QWEN_KEY',wireApi:'responses'}]}});
  const originals=[magpie,join(cc,'cc-switch.db'),legacy,alternate,open,pi,droid];
  const before=await Promise.all(originals.map(hash));
  let preview=await rpc('previewConfigurationImport');
  check('moved CC Switch database is discovered through its actual Tauri app_paths store',preview.sources.find(s=>s.source==='cc-switch').path===join(cc,'cc-switch.db'));
  check('Claude active legacy filename and CC Switch client-directory overrides are both discovered',preview.sources.some(s=>s.path===legacy&&s.items[0].status==='new')&&preview.sources.some(s=>s.path===alternate&&s.items[0].status==='new'));
  check('model setup and import share OpenCode JSONC and managed-client paths',preview.sources.some(s=>resolve(s.path)===resolve(open)&&!s.error)&&['pi','droid','workbuddy','qwen-code'].every(id=>preview.sources.some(s=>s.source===id&&s.found&&!s.error)));
  const mag=preview.sources.find(s=>s.source==='magpie').items;
  check('Magpie key protocol and paused spare key preserve their endpoints',mag.filter(i=>i.status==='new'&&i.name.startsWith('Magpie Relay')).length===1&&mag.filter(i=>i.status==='paused').length===1&&mag.some(i=>i.adapter==='responses')&&mag.some(i=>i.adapter==='anthropic-messages'));
  check('Magpie body overrides and its configured local proxy are explicit skips',mag.filter(i=>i.status==='unsupported').length===2);
  check('Magpie logins explicitly removed in the source are not offered again',preview.sources.find(s=>s.source==='magpie-accounts').items.length===0);
  const ccItems=preview.sources.find(s=>s.source==='cc-switch').items;
  check('CC Switch OpenCode v2 package/settings preserve Chat and Responses protocols',ccItems.find(i=>i.name==='CC v2').adapter==='chat-completions'&&ccItems.find(i=>i.name==='CC v2 Responses').adapter==='responses');
  check('CC Switch Grok Build reads the selected model TOML instead of treating it as generic JSON',ccItems.find(i=>i.name==='CC Grok Build').status==='new'&&ccItems.find(i=>i.name==='CC Grok Build').adapter==='responses');
  check('environment references and managed logins are never imported as literal API keys',ccItems.filter(i=>i.status==='unsupported').length===4);
  check('previews contain neither literal API keys nor environment credential values',!JSON.stringify(preview).includes('fixture-')&&!JSON.stringify(preview).includes('PI_SECRET_ENV'));
  const manual=await rpc('previewConfigurationImport',{sources:[{source:'auto',path:open}]});
  check('manual JSONC file selection detects OpenCode without a source dropdown',manual.sources[0].source==='opencode'&&manual.sources[0].items[0].status==='new');
  const selected=preview.sources.flatMap(s=>s.items).filter(i=>i.status==='new').map(i=>i.fingerprint);
  const args=()=>({sources:preview.sources.map(({source,path})=>({source,path})),targetDigest:preview.targetDigest,fingerprints:selected});
  await file(droid,{customModels:[{model:'changed-model',baseUrl:'https://droid.example/v1',apiKey:'fixture-droid',provider:'generic-chat-completion-api'}]});
  check('changes in any merged model invalidate the selected import before writing',!(await call('importConfigurations',args())).ok);
  await file(droid,{customModels:['droid-one','droid-two'].map(model=>({id:model,model,displayName:model,baseUrl:'https://droid.example/v1',apiKey:'fixture-droid',provider:'generic-chat-completion-api'}))});
  const originalSelection=(await rpc('getProviders')).selected;
  const imported=await rpc('importConfigurations',args());
  const disk=JSON.parse(await readFile(join(root,'settings.json'),'utf8'));
  const provider=imported.providers.connections.find(p=>p.baseUrl==='https://droid.example/v1');
  check('deduplicated connections keep all Droid models rather than dropping later entries',JSON.stringify(disk.importedProviderModels[provider.id])===JSON.stringify(['droid-one','droid-two']));
  check('large source model lists are not silently truncated at one thousand',disk.importedProviderModels[imported.providers.connections.find(p=>p.baseUrl==='https://many.example/v1').id].length===1001);
  const merged=imported.providers.connections.find(p=>p.baseUrl==='https://many.example/v1');
  check('merging a later Codex choice retains its model and explicit context window together',merged.codexModel==='model-0'&&merged.codexContextWindow===200000);
  check('import retains exact Claude role mappings and current service selection',imported.providers.connections.some(p=>p.claudeModels.opus==='exact-opus')&&imported.providers.connections.some(p=>p.claudeModels.sonnet==='exact-sonnet')&&JSON.stringify(originalSelection)===JSON.stringify(imported.providers.selected));
  check('all native source files and source databases remain byte identical',JSON.stringify(before)===JSON.stringify(await Promise.all(originals.map(hash))));
  check('expanded discovery can be submitted explicitly without the old eight-source rejection',imported.added.length>=8);
  await stop();start(); preview=await rpc('previewConfigurationImport');
  check('imported sources remain existing after a native process restart',preview.sources.flatMap(s=>s.items).filter(i=>i.status==='existing').length>=8);
  await file(join(home,'app-data/com.ccswitch.desktop/app_paths.json'),{app_config_dir_override:dirname(root)});
  check('custom manager directory cannot escape an isolated acceptance root',!(await call('previewConfigurationImport')).ok);
  await stop();console.log(JSON.stringify({passed:true,checks,scope:'native RPC, upstream-source schema fixtures, isolated imports; no live account or upstream'}));
} finally {if(child?.exitCode===null)child.kill();await rm(root,{recursive:true,force:true});}
