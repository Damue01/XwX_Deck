// Consumer configuration contracts + real Gateway requests. Actual installed
// desktop consumers are verified separately, never inferred from these fixtures.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,chmod,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';import {tmpdir} from 'node:os';
import {createServer} from 'node:http';import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';import {once} from 'node:events';
import {parse as yaml} from 'yaml';import {parse as toml} from 'smol-toml';
import ts from 'typescript';
import {nativeTestBinary,writeCliFixture} from './test-support.mjs';
const root=await mkdtemp(join(await realpath(tmpdir()),'xwx-managed-adapters-')),home=join(root,'client-home');
await writeFile(join(root,'.xwx-rust-pilot'),'isolated-rust-pilot-v1\n');
const calls=[],checks=[];const check=(label,ok)=>{assert.ok(ok,label);checks.push(label);};
const upstream=createServer(async(req,res)=>{let source='';for await(const chunk of req)source+=chunk;const body=source?JSON.parse(source):{};res.setHeader('content-type','application/json');if(req.url.endsWith('/models')){res.end(JSON.stringify({data:[{id:'model-a',context_window:500000},{id:'model-b',context_window:256000}]}));return;}calls.push({path:req.url,model:body.model,auth:req.headers.authorization});res.end(JSON.stringify({id:'response-local',object:'response',status:'completed',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'adapter reply'}]}],usage:{input_tokens:3,output_tokens:2,total_tokens:5}}));});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
const files={
 '.dsh/profiles/desktop/cordis.patch.yml':'# desktop preference\n- id: custom-tools\n  config:\n    enabled: true\n- id: llm-pi-ai\n  config:\n    providers:\n      personal:\n        baseURL: https://personal.invalid\n- id: agent-default-model\n  config:\n    provider: personal\n    model: original\n',
 '.dsh/profiles/web/cordis.patch.yml':'# web preference\n[]\n',
 '.dsh/.credentials.yaml':'version: 1\n# private personal fixture\nrefs:\n  PERSONAL_KEY: synthetic-personal-key\nrecords: {}\n',
 '.cline/data/settings/providers.json':'{"version":1,"lastUsedProvider":"personal","providers":{"personal":{"settings":{"model":"original"}}},"theme":"day"}',
 '.cline/data/settings/models.json':'{}',
 '.cline/data/globalState.json':'{"actModeApiProvider":"anthropic","planModeApiProvider":"anthropic","theme":"day"}',
 '.cline/data/secrets.json':'{"personalKey":"synthetic-private"}',
 'AppData/Roaming/Code/User/chatLanguageModels.json':'// personal catalog\n[{"name":"Personal","vendor":"customendpoint","models":[]},]\n',
 'AppData/Roaming/Code/User/settings.json':'{\n// personal editor preference\n"chat.defaultModel":"original","editor.fontSize":16\n}',
 '.kimi-code/config.toml':'# personal kimi\ndefault_model="original"\n[ui]\ntheme="day"\n[models.original]\nmodel="personal-model"\nprovider="personal"\n[providers.personal]\ntype="kimi"\nbase_url="https://personal.invalid/v1"\napi_key="synthetic-personal"\n',
 '.factory/settings.json':'{"sessionDefaultSettings":{"model":"custom:personal"},"customModels":[{"id":"custom:personal","model":"personal-model","baseUrl":"https://personal.invalid/v1","apiKey":"synthetic-personal","provider":"generic-chat-completion-api"}],"theme":"day"}',
 '.grok/config.toml':'# personal grok\n[models]\ndefault="original"\n[ui]\ntheme="day"\n',
};
if(process.platform!=='win32'){const codeDir=process.platform==='darwin'?'Library/Application Support/Code/User':'.config/Code/User';files[codeDir+'/chatLanguageModels.json']=files['AppData/Roaming/Code/User/chatLanguageModels.json'];files[codeDir+'/settings.json']=files['AppData/Roaming/Code/User/settings.json'];delete files['AppData/Roaming/Code/User/chatLanguageModels.json'];delete files['AppData/Roaming/Code/User/settings.json'];}
for(const [path,source] of Object.entries(files)){await mkdir(dirname(join(home,path)),{recursive:true});await writeFile(join(home,path),source);}
await mkdir(join(home,'.local/bin'),{recursive:true});for(const command of ['dsh','cline','kimi','grok','droid'])await writeCliFixture(join(home,'.local/bin',command),'process.exit(0);');
const app=process.platform==='win32'?'Applications/Microsoft VS Code':'Applications/Visual Studio Code.app/Contents';
await mkdir(join(home,app,process.platform==='win32'?'resources/app':'Resources/app'),{recursive:true});await writeFile(join(home,app,process.platform==='win32'?'resources/app/package.json':'Resources/app/package.json'),'{"version":"1.126.0"}');
await writeFile(join(home,app,process.platform==='win32'?'resources/app/product.json':'Resources/app/product.json'),'{"applicationName":"code","nameShort":"Visual Studio Code"}');
await writeFile(join(home,app,process.platform==='win32'?'Code.exe':'MacOS/Electron'),'installed fixture').catch(async()=>{await mkdir(join(home,app,'MacOS'),{recursive:true});await writeFile(join(home,app,'MacOS/Electron'),'installed fixture');});
if(process.platform!=='win32')await chmod(join(home,app,'MacOS/Electron'),0o700);
let child,queue=[];function start(){child=spawn(nativeTestBinary,['--rpc','--pilot-root',root],{env:{...process.env,XWX_CLIENT_INSTALLATIONS_TEST_HOME:home},stdio:['pipe','pipe','inherit']});createInterface({input:child.stdout}).on('line',line=>queue.shift()?.(JSON.parse(line)));}
function raw(method,...args){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(method+' timeout')),20000);queue.push(v=>{clearTimeout(timer);resolve(v);});child.stdin.write(JSON.stringify({method,args})+'\n');});}
async function rpc(method,...args){const value=await raw(method,...args);assert.equal(value.ok,true,value.error);return value.result;}
async function close(){const exited=once(child,'exit');child.stdin.end();assert.equal((await exited)[0],0);}
const clients=['deepseek-harness','cline','vscode','kimi-code','grok-build','droid'];
start();
try{
 assert.deepEqual((await rpc('getProviders')).connections,[],'a marked isolated fixture still starts without any default connections');
 const installed=await rpc('detectClientInstallations');for(const id of clients){check(id+' detected and manageable',installed.clients.find(row=>row.id===id)?.installed&&installed.clients.find(row=>row.id===id)?.modelManagement);await rpc('addModelClient',id);}
 await rpc('saveProvider',{displayName:'local adapters',baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,bearerToken:'synthetic-upstream-key',adapter:'responses'});const provider=(await rpc('getProviders')).connections[0].id;
 await rpc('fetchProviderModels',{providerId:provider});
 async function select(id,model){const state=await rpc('getClientRoute',id);assert.equal(state.automatic,true);await rpc('setClientRoute',{client:id,providerId:provider,model,configDigest:state.configDigest,takeoverConfirmed:true});}
 for(const id of clients)await select(id,'model-a');
 let state=await rpc('toggleTracing',true);check('Trace starts with all configuration adapters',state.tracingEnabled);
 const read=async path=>readFile(join(home,path),'utf8');
 const dshRows=yaml(await read('.dsh/profiles/desktop/cordis.patch.yml'));const pick=dshRows.filter(row=>row.id==='agent-default-model').at(-1).config;const route=dshRows.filter(row=>row.id==='llm-pi-ai').at(-1).config.providers[pick.provider];check('DSH profile selects a stable owned Responses catalog ID',pick.model==='xwx_deck/default'&&route.models[0].id===pick.model&&route.models[0].name==='model-a'&&route.api==='openai-responses');check('DSH desktop reads its credential store',yaml(await read('.dsh/.credentials.yaml')).refs[route.apiKeyEnv]==='xwx-deck');check('DSH keeps personal provider and comments',dshRows.filter(row=>row.id==='llm-pi-ai').at(-1).config.providers.personal.baseURL==='https://personal.invalid'&&(await read('.dsh/profiles/desktop/cordis.patch.yml')).includes('# desktop preference'));
 const cline=JSON.parse(await read('.cline/data/globalState.json'));check('Cline Plan and Act both select saved model',cline.actModeOpenAiModelId==='model-a'&&cline.planModeOpenAiModelId==='model-a');
 // Actual Cline startup migrates credentials and refreshes model metadata.
 const providersPath=join(home,'.cline/data/settings/providers.json'),modelsPath=join(home,'.cline/data/settings/models.json');
 const migrated=JSON.parse(await readFile(providersPath,'utf8'));migrated.providers['openai-compatible'].tokenSource='migration';await writeFile(providersPath,JSON.stringify(migrated));
 const refreshed=JSON.parse(await readFile(modelsPath,'utf8'));refreshed.providers['openai-compatible'].models['model-a'].capabilities=['streaming','tools','images'];refreshed.providers['openai-compatible'].models['model-a'].contextWindow=128000;await writeFile(modelsPath,JSON.stringify(refreshed));
 await select('cline','model-b');await select('cline','model-a');
 check('Cline metadata refresh permits switching and retains CLI-owned fields',JSON.parse(await readFile(providersPath,'utf8')).providers['openai-compatible'].tokenSource==='migration'&&JSON.parse(await readFile(modelsPath,'utf8')).providers['openai-compatible'].models['model-a'].contextWindow===128000);
 const external=JSON.parse(await readFile(providersPath,'utf8'));external.providers['openai-compatible'].settings.baseUrl='https://external.invalid';await writeFile(providersPath,JSON.stringify(external));
 const rejected=await raw('toggleTracing',false);check('Cline external endpoint still blocks destructive restore',!rejected.ok&&(await readFile(providersPath,'utf8')).includes('https://external.invalid'));external.providers['openai-compatible'].settings.baseUrl=migrated.providers['openai-compatible'].settings.baseUrl;await writeFile(providersPath,JSON.stringify(external));
 const codePath=Object.keys(files).find(p=>p.endsWith('chatLanguageModels.json'));const codeGroups=ts.parseConfigFileTextToJson(codePath,'{"rows":'+await read(codePath)+'}').config.rows;const codeModel=codeGroups.find(g=>g.name==='XwX Deck').models[0];check('VS Code keeps user group and comments',codeGroups.some(g=>g.name==='Personal')&&(await read(codePath)).includes('// personal catalog'));
 const kimi=toml(await read('.kimi-code/config.toml'));check('Kimi default resolves to configured provider model',kimi.models[kimi.default_model].model==='model-a'&&kimi.providers.xwx_deck.base_url.includes('/clients/kimi-code/'));
 const droid=JSON.parse(await read('.factory/settings.json'));const droidSessionModel=droid.sessionDefaultSettings.model;
 const originalGrok=toml(await read('.grok/config.toml'));const grokSessionModel=originalGrok.models.default;
 for(const model of ['model-b','model-a']){
   await select('kimi-code',model);const nextKimi=toml(await read('.kimi-code/config.toml'));check('Kimi resumed session alias remains valid for '+model,nextKimi.default_model===kimi.default_model&&nextKimi.models[kimi.default_model].model===model);check('Kimi personal model stays explicit for '+model,nextKimi.models.original.model==='personal-model'&&nextKimi.providers.personal.base_url==='https://personal.invalid/v1');
   await select('droid',model);const nextDroid=JSON.parse(await read('.factory/settings.json'));check('Droid resumed session alias remains valid for '+model,nextDroid.sessionDefaultSettings.model===droidSessionModel&&nextDroid.customModels.find(row=>row.id===droidSessionModel)?.model===model);check('Droid personal model stays explicit for '+model,nextDroid.customModels.find(row=>row.id==='custom:personal')?.model==='personal-model');
   await select('grok-build',model);const nextGrok=toml(await read('.grok/config.toml'));check('Grok native session catalog key remains valid for '+model,nextGrok.models.default===grokSessionModel&&nextGrok.model[grokSessionModel].model===model);
 }
 for(const [id,path]of [['kimi-code','.kimi-code/config.toml'],['grok-build','.grok/config.toml'],['droid','.factory/settings.json']]){
   const original=await read(path),changed=id!=='droid'?original.replace('model = "model-a"','model = "external-choice"'):JSON.stringify({...JSON.parse(original),customModels:JSON.parse(original).customModels.map(row=>row.id===droidSessionModel?{...row,model:'external-choice'}:row)});
   assert.notEqual(changed,original,'fixture changes an owned model field');await writeFile(join(home,path),changed);await assert.rejects(select(id,'model-b'));check(id+' external owned model edit is rejected and kept byte-exact',await read(path)===changed);await writeFile(join(home,path),original);
 }
 const grok=toml(await read('.grok/config.toml'));check('Grok default resolves to configured model',grok.model[grok.models.default].model==='model-a');
 const requests=[['deepseek-harness',route.baseURL+'/responses',{model:pick.model,input:'fixture'}],['cline',cline.openAiBaseUrl+'/chat/completions',{model:cline.actModeOpenAiModelId,messages:[{role:'user',content:'fixture'}]}],['vscode',codeModel.url,{model:codeModel.id,input:'fixture'}],['kimi-code',kimi.providers.xwx_deck.base_url+'/chat/completions',{model:kimi.models[kimi.default_model].model,messages:[{role:'user',content:'fixture'}]}],['grok-build',grok.model[grok.models.default].base_url+'/chat/completions',{model:grok.model[grok.models.default].model,messages:[{role:'user',content:'fixture'}]}]];
 for(const [id,url,body]of requests){const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer xwx-deck'},body:JSON.stringify(body)});check(id+' real local request completes',response.ok&&(await response.text()).includes('adapter reply'));}
 check('all upstream requests use intended model and provider credentials',calls.length===5&&calls.every(call=>call.model==='model-a'&&call.auth==='Bearer synthetic-upstream-key'));
 const dashboard=await rpc('getDashboardUrl'),traceState=await(await fetch(dashboard+'api/state')).json();
 for(const [id]of requests){const session=traceState.sessions.find(row=>row.source===id);assert.ok(session,id+' session keeps its actual source');const records=await(await fetch(dashboard+'api/session/'+encodeURIComponent(session.id))).json();assert.ok(records.traces.some(row=>row.source===id),id+' request keeps its actual source');}
 check('Trace sessions and request records preserve each managed client source',true);
 for(const id of clients)await select(id,'model-b');const switchedCatalog=yaml(await read('.dsh/profiles/desktop/cordis.patch.yml'));check('DSH switch retains the native session catalog ID without duplicate managed blocks',(await read('.dsh/profiles/desktop/cordis.patch.yml')).match(/XwX Deck managed models begin/g).length===1&&switchedCatalog.at(-1).config.model===pick.model&&switchedCatalog.filter(row=>row.id==='llm-pi-ai').at(-1).config.providers['xwx-deck'].models[0].name==='model-b');
 state=await rpc('toggleTracing',false);check('Trace stops and restores configuration while preserving CLI metadata',!state.tracingEnabled);for(const[path,source]of Object.entries(files)){if(path==='.cline/data/settings/providers.json'){const restored=JSON.parse(await read(path));assert.equal(restored.providers['openai-compatible'].tokenSource,'migration');delete restored.providers['openai-compatible'];assert.deepEqual(restored,JSON.parse(source));}else if(path==='.cline/data/settings/models.json'){const restored=JSON.parse(await read(path));assert.equal(restored.providers['openai-compatible'].models['model-a'].contextWindow,128000);assert.deepEqual(restored.providers['openai-compatible'].provider,{});}else assert.equal(await read(path),source,path);}
 await close();start();for(const id of clients)check(id+' saved selection survives restart',(await rpc('getClientRoute',id)).model==='model-b');
 await rpc('toggleTracing',true);const dshPath=join(home,'.dsh/profiles/desktop/cordis.patch.yml'),ownedYaml=await readFile(dshPath,'utf8'),externallyChanged=ownedYaml.replace('model: '+pick.model,'model: external-choice');assert.notEqual(externallyChanged,ownedYaml);await writeFile(dshPath,externallyChanged);const stopped=await raw('toggleTracing',false);check('external model choice prevents destructive restore',!stopped.ok&&(await readFile(dshPath,'utf8'))===externallyChanged);await writeFile(dshPath,ownedYaml);await rpc('toggleTracing',false);
 // The real Harness rewrites refs as an empty flow map while adding its browser grant.
 const credentials=join(home,'.dsh/.credentials.yaml'),browserGrant='version: 1\nrefs: {} # browser-owned store\nrecords:\n  client-connection/browser-session:\n    kind: plain\n    payload:\n      version: 1\n      secret: synthetic-browser-grant\n';
 await writeFile(credentials,browserGrant);await select('deepseek-harness','model-a');await rpc('toggleTracing',true);
 await writeFile(credentials,browserGrant);
 const secondSaved=await rpc('saveProvider',{displayName:'local adapters second',baseUrl:`http://127.0.0.1:${upstream.address().port}/alternate/v1`,bearerToken:'synthetic-upstream-second',adapter:'responses'}),secondProvider=secondSaved.connections.find(p=>p.displayName==='local adapters second').id;
 await rpc('fetchProviderModels',{providerId:secondProvider});const beforeSwitch=await rpc('getClientRoute','deepseek-harness');
 await rpc('setClientRoute',{client:'deepseek-harness',providerId:secondProvider,model:'model-b',configDigest:beforeSwitch.configDigest,takeoverConfirmed:true});
 const switchedRows=yaml(await read('.dsh/profiles/desktop/cordis.patch.yml')),switchedPick=switchedRows.filter(row=>row.id==='agent-default-model').at(-1).config,switchedRoute=switchedRows.filter(row=>row.id==='llm-pi-ai').at(-1).config.providers[switchedPick.provider];
 const switchedResponse=await fetch(switchedRoute.baseURL+'/responses',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer xwx-deck'},body:JSON.stringify({model:switchedPick.model,input:'Harness browser-grant switch fixture'})});
 check('Harness native empty refs and browser grant permit a real provider/model switch',switchedResponse.ok&&(await switchedResponse.text()).includes('adapter reply')&&calls.at(-1).path==='/alternate/v1/responses'&&calls.at(-1).model==='model-b'&&calls.at(-1).auth==='Bearer synthetic-upstream-second');
 await rpc('toggleTracing',false);check('Harness switch and stop retain the exact external browser grant and empty refs bytes',(await readFile(credentials,'utf8'))===browserGrant);
 {
   const paths=(await rpc('getClientRoute','vscode')).configPaths;
   const saved=await Promise.all(paths.map(path=>readFile(path,'utf8')));
   for(const path of paths)await rm(path);
   const absent=await rpc('getClientRoute','vscode');
   for(const path of paths)await writeFile(path,path.endsWith('chatLanguageModels.json')?'[]':'{}');
   assert.equal((await rpc('getClientRoute','vscode')).configDigest,absent.configDigest);
   await rpc('setClientRoute',{client:'vscode',providerId:provider,model:'model-a',configDigest:absent.configDigest,takeoverConfirmed:true});
   await rpc('toggleTracing',true);await select('vscode','model-b');await rpc('toggleTracing',false);
   assert.deepEqual(await Promise.all(paths.map(path=>readFile(path,'utf8'))),['[]','{}']);
   check('VS Code empty watcher initialization permits switch and remains preserved',true);
   const empty=await rpc('getClientRoute','vscode');
   await writeFile(paths[1],'{"editor.fontSize":19}');
   assert.notEqual((await rpc('getClientRoute','vscode')).configDigest,empty.configDigest);
   const refused=await raw('setClientRoute',{client:'vscode',providerId:provider,model:'model-a',configDigest:empty.configDigest,takeoverConfirmed:true});
   check('VS Code meaningful external settings still reject a stale switch and retain bytes',!refused.ok&&(await readFile(paths[1],'utf8'))==='{"editor.fontSize":19}');
   for(let i=0;i<paths.length;i++)await writeFile(paths[i],saved[i]);
   // The preceding deliberate external edit invalidated the saved ownership
   // baseline. Reconfirm the restored fixture before the independent test.
   await select('vscode','model-b');
 }
 if(process.platform==='win32'){
   const portable=join(root,'custom Code'),portableUser=join(portable,'data/user-data/User');
   await mkdir(join(portable,'resources/app'),{recursive:true});await mkdir(portableUser,{recursive:true});
   await writeFile(join(portable,'Code.exe'),'isolated portable fixture');await writeFile(join(portable,'resources/app/package.json'),'{"version":"1.126.0"}');await writeFile(join(portable,'resources/app/product.json'),'{"applicationName":"code","nameShort":"Code"}');
   const original='{"editor.fontSize":18,"chat.defaultModel":"portable-original"}';await writeFile(join(portableUser,'settings.json'),original);
   const inspected=await rpc('inspectClientInstallation',{client:'vscode',location:portable});
   await rpc('toggleTracing',true);const settingsBefore=await readFile(join(root,'settings.json'),'utf8');check('active client installation cannot be rebound before restore',!(await raw('addModelClient','vscode',inspected.location)).ok&&(await readFile(join(root,'settings.json'),'utf8'))===settingsBefore);check('active client cannot restore automatic detection before route recovery',!(await raw('addModelClient','vscode',null)).ok&&(await readFile(join(root,'settings.json'),'utf8'))===settingsBefore);await rpc('toggleTracing',false);
   await rpc('addModelClient','vscode',inspected.location);
   await select('vscode','model-a');await rpc('toggleTracing',true);
   const portableGroups=JSON.parse(await readFile(join(portableUser,'chatLanguageModels.json'),'utf8')),model=portableGroups.find(g=>g.name==='XwX Deck').models[0];
   const response=await fetch(model.url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer xwx-deck'},body:JSON.stringify({model:model.id,input:'portable fixture'})});check('manual portable Code configuration completes actual local request',response.ok&&(await response.text()).includes('adapter reply'));
   await rpc('toggleTracing',false);check('manual portable Code restores exact personal settings',(await readFile(join(portableUser,'settings.json'),'utf8'))===original);check('portable selection never rewrites normal Code preferences',(await read('AppData/Roaming/Code/User/settings.json'))===files['AppData/Roaming/Code/User/settings.json']);
   await writeFile(join(portable,'resources/app/package.json'),'{"version":"1.100.0"}');
 }

 const oldPackage=join(home,app,process.platform==='win32'?'resources/app/package.json':'Resources/app/package.json');await writeFile(oldPackage,'{"version":"1.100.0"}');check('old VS Code does not advertise management',(await rpc('detectClientInstallations')).clients.find(row=>row.id==='vscode').modelManagement===false);
 console.log(JSON.stringify({passed:true,checks,actualRequests:calls.length,scope:'isolated consumer formats and loopback HTTP; actual installed consumer consumption is separate'},null,2));
}catch(error){console.error(error);throw error;}finally{if(child?.exitCode===null)await close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));}
