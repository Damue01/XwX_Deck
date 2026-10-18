// Consumer configuration contracts + real Gateway requests. Actual installed
// desktop consumers are verified separately, never inferred from these fixtures.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import {join,dirname} from 'node:path';import {tmpdir} from 'node:os';
import {createServer} from 'node:http';import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';import {once} from 'node:events';
import {parse as yaml} from 'yaml';import {parse as toml} from 'smol-toml';
import ts from 'typescript';
import {nativeTestBinary,writeCliFixture} from './test-support.mjs';
const root=await mkdtemp(join(await realpath(tmpdir()),'xwx-managed-adapters-')),home=join(root,'client-home');
await writeFile(join(root,'.xwx-rust-pilot'),'isolated-rust-pilot-v1\n');
const calls=[],checks=[];const check=(label,ok)=>{assert.ok(ok,label);checks.push(label);};
const upstream=createServer(async(req,res)=>{let source='';for await(const chunk of req)source+=chunk;const body=source?JSON.parse(source):{};res.setHeader('content-type','application/json');if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'model-a',context_window:500000},{id:'model-b',context_window:256000}]}));return;}calls.push({path:req.url,model:body.model,auth:req.headers.authorization});res.end(JSON.stringify({id:'response-local',object:'response',status:'completed',model:body.model,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'adapter reply'}]}],usage:{input_tokens:3,output_tokens:2,total_tokens:5}}));});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
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
 '.kimi-code/config.toml':'# personal kimi\ndefault_model="original"\n[ui]\ntheme="day"\n',
 '.grok/config.toml':'# personal grok\n[models]\ndefault="original"\n[ui]\ntheme="day"\n',
};
if(process.platform!=='win32'){const codeDir=process.platform==='darwin'?'Library/Application Support/Code/User':'.config/Code/User';files[codeDir+'/chatLanguageModels.json']=files['AppData/Roaming/Code/User/chatLanguageModels.json'];files[codeDir+'/settings.json']=files['AppData/Roaming/Code/User/settings.json'];delete files['AppData/Roaming/Code/User/chatLanguageModels.json'];delete files['AppData/Roaming/Code/User/settings.json'];}
for(const [path,source] of Object.entries(files)){await mkdir(dirname(join(home,path)),{recursive:true});await writeFile(join(home,path),source);}
await mkdir(join(home,'.local/bin'),{recursive:true});for(const command of ['dsh','cline','kimi','grok'])await writeCliFixture(join(home,'.local/bin',command),'process.exit(0);');
const app=process.platform==='win32'?'Applications/Microsoft VS Code':'Applications/Visual Studio Code.app/Contents';
await mkdir(join(home,app,process.platform==='win32'?'resources/app':'Resources/app'),{recursive:true});await writeFile(join(home,app,process.platform==='win32'?'resources/app/package.json':'Resources/app/package.json'),'{"version":"1.126.0"}');
await writeFile(join(home,app,process.platform==='win32'?'resources/app/product.json':'Resources/app/product.json'),'{"applicationName":"code","nameShort":"Visual Studio Code"}');
await writeFile(join(home,app,process.platform==='win32'?'Code.exe':'MacOS/Electron'),'installed fixture').catch(async()=>{await mkdir(join(home,app,'MacOS'),{recursive:true});await writeFile(join(home,app,'MacOS/Electron'),'installed fixture');});
let child,queue=[];function start(){child=spawn(nativeTestBinary,['--rpc','--pilot-root',root],{env:{...process.env,XWX_CLIENT_INSTALLATIONS_TEST_HOME:home},stdio:['pipe','pipe','inherit']});createInterface({input:child.stdout}).on('line',line=>queue.shift()?.(JSON.parse(line)));}
function raw(method,...args){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(method+' timeout')),20000);queue.push(v=>{clearTimeout(timer);resolve(v);});child.stdin.write(JSON.stringify({method,args})+'\n');});}
async function rpc(method,...args){const value=await raw(method,...args);assert.equal(value.ok,true,value.error);return value.result;}
async function close(){const exited=once(child,'exit');child.stdin.end();assert.equal((await exited)[0],0);}
const clients=['deepseek-harness','cline','vscode','kimi-code','grok-build'];
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
 const dshRows=yaml(await read('.dsh/profiles/desktop/cordis.patch.yml'));const pick=dshRows.filter(row=>row.id==='agent-default-model').at(-1).config;const route=dshRows.filter(row=>row.id==='llm-pi-ai').at(-1).config.providers[pick.provider];check('DSH profile selects actual configured Responses route',pick.model==='model-a'&&route.api==='openai-responses');check('DSH desktop reads its credential store',yaml(await read('.dsh/.credentials.yaml')).refs[route.apiKeyEnv]==='xwx-deck');check('DSH keeps personal provider and comments',dshRows.filter(row=>row.id==='llm-pi-ai').at(-1).config.providers.personal.baseURL==='https://personal.invalid'&&(await read('.dsh/profiles/desktop/cordis.patch.yml')).includes('# desktop preference'));
 const cline=JSON.parse(await read('.cline/data/globalState.json'));check('Cline Plan and Act both select saved model',cline.actModeOpenAiModelId==='model-a'&&cline.planModeOpenAiModelId==='model-a');
 const codePath=Object.keys(files).find(p=>p.endsWith('chatLanguageModels.json'));const codeGroups=ts.parseConfigFileTextToJson(codePath,'{"rows":'+await read(codePath)+'}').config.rows;const codeModel=codeGroups.find(g=>g.name==='XwX Deck').models[0];check('VS Code keeps user group and comments',codeGroups.some(g=>g.name==='Personal')&&(await read(codePath)).includes('// personal catalog'));
 const kimi=toml(await read('.kimi-code/config.toml'));check('Kimi default resolves to configured provider model',kimi.models[kimi.default_model].model==='model-a'&&kimi.providers.xwx_deck.base_url.includes('/clients/kimi-code/'));
 const grok=toml(await read('.grok/config.toml'));check('Grok default resolves to configured model',grok.model[grok.models.default].model==='model-a');
 const requests=[['deepseek-harness',route.baseURL+'/responses',{model:pick.model,input:'fixture'}],['cline',cline.openAiBaseUrl+'/chat/completions',{model:cline.actModeOpenAiModelId,messages:[{role:'user',content:'fixture'}]}],['vscode',codeModel.url,{model:codeModel.id,input:'fixture'}],['kimi-code',kimi.providers.xwx_deck.base_url+'/chat/completions',{model:kimi.models[kimi.default_model].model,messages:[{role:'user',content:'fixture'}]}],['grok-build',grok.model[grok.models.default].base_url+'/chat/completions',{model:grok.model[grok.models.default].model,messages:[{role:'user',content:'fixture'}]}]];
 for(const [id,url,body]of requests){const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer xwx-deck'},body:JSON.stringify(body)});check(id+' real local request completes',response.ok&&(await response.text()).includes('adapter reply'));}
 check('all upstream requests use intended model and provider credentials',calls.length===5&&calls.every(call=>call.model==='model-a'&&call.auth==='Bearer synthetic-upstream-key'));
 for(const id of clients)await select(id,'model-b');check('DSH switch updates default model without duplicate managed blocks',(await read('.dsh/profiles/desktop/cordis.patch.yml')).match(/XwX Deck managed models begin/g).length===1&&yaml(await read('.dsh/profiles/desktop/cordis.patch.yml')).at(-1).config.model==='model-b');
 state=await rpc('toggleTracing',false);check('Trace stops and restores every original byte',!state.tracingEnabled);for(const[path,source]of Object.entries(files))assert.equal(await read(path),source,path);
 await close();start();for(const id of clients)check(id+' saved selection survives restart',(await rpc('getClientRoute',id)).model==='model-b');
 await rpc('toggleTracing',true);const dshPath=join(home,'.dsh/profiles/desktop/cordis.patch.yml');await writeFile(dshPath,(await readFile(dshPath,'utf8')).replace('model: model-b','model: external-choice'));const stopped=await raw('toggleTracing',false);check('external model choice prevents destructive restore',!stopped.ok&&(await readFile(dshPath,'utf8')).includes('external-choice'));await writeFile(dshPath,(await readFile(dshPath,'utf8')).replace('model: external-choice','model: model-b'));await rpc('toggleTracing',false);
 if(process.platform==='win32'){
   const portable=join(root,'custom Code'),portableUser=join(portable,'data/user-data/User');
   await mkdir(join(portable,'resources/app'),{recursive:true});await mkdir(portableUser,{recursive:true});
   await writeFile(join(portable,'Code.exe'),'isolated portable fixture');await writeFile(join(portable,'resources/app/package.json'),'{"version":"1.126.0"}');await writeFile(join(portable,'resources/app/product.json'),'{"applicationName":"code","nameShort":"Code"}');
   const original='{"editor.fontSize":18,"chat.defaultModel":"portable-original"}';await writeFile(join(portableUser,'settings.json'),original);
   const inspected=await rpc('inspectClientInstallation',{client:'vscode',location:portable});
   await rpc('toggleTracing',true);const settingsBefore=await readFile(join(root,'settings.json'),'utf8');check('active client installation cannot be rebound before restore',!(await raw('addModelClient','vscode',inspected.location)).ok&&(await readFile(join(root,'settings.json'),'utf8'))===settingsBefore);await rpc('toggleTracing',false);
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
