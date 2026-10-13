import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';import {once} from 'node:events';
import {nativeTestBinary} from './test-support.mjs';import {createServer} from 'node:http';
const fixture=await mkdtemp(join(await realpath(tmpdir()),'xwxdeck-desktop-lifecycle-'));
const ID='00000000-0000-4000-8000-000000157220';let root,child,queue=[],passed=0;
function start(){queue=[];child=spawn(nativeTestBinary,['--rpc','--pilot-root',root],{env:{...process.env,XWX_DECK_TEST_SECURE_STORE:''}});createInterface({input:child.stdout}).on('line',line=>queue.shift()?.(JSON.parse(line)));child.stderr.on('data',d=>process.stderr.write(d));}
function rpc(method,...args){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`Timeout ${method}`)),10000);queue.push(v=>{clearTimeout(timer);v.ok?resolve(v.result):reject(Error(v.error));});child.stdin.write(JSON.stringify({method,args})+'\n');});}
async function stop(){const done=once(child,'exit');child.stdin.end();assert.equal((await done)[0],0);}
async function fresh(name){root=join(fixture,name);start();await rpc('getState');await stop();}
async function put(path,data){await mkdir(join(path,'..'),{recursive:true});await writeFile(path,typeof data==='string'?data:JSON.stringify(data));}
function paths(){const dir=join(root,'desktop','Claude-3p'),configs=[join(root,'desktop','Claude','claude_desktop_config.json'),join(dir,'claude_desktop_config.json')];return {dir,configs,meta:join(dir,'configLibrary','_meta.json'),profile:join(dir,'configLibrary',ID+'.json')};}
async function old(mode='local',fallback=true){const p=paths();const profile=JSON.stringify({inferenceGatewayBaseUrl:mode==='direct'?'https://compatible.example/anthropic':'http://127.0.0.1:45239',inferenceGatewayApiKey:'synthetic-desktop-key',inferenceModels:[{name:'claude-sonnet-4-6-v123',labelOverride:'provider-model',anthropicFamilyTier:'sonnet'}]});
 for(const path of p.configs)await put(path,{deploymentMode:mode==='official'?'1p':'3p',external:'preserve'});
 await put(p.meta,{appliedId:mode==='official'?'external-profile':ID,entries:[{id:'external-profile',name:'External'},{id:ID,name:'XwX Deck'}],external:7});await put(p.profile,profile);
 const state={version:1,mode,root:p.dir,configFiles:p.configs.map(path=>({path,fileExisted:true,previousDeploymentMode:{present:true,value:mode==='official'?'3p':'1p'}})),metaPath:p.meta,metaFileExisted:true,previousAppliedId:{present:true,value:'external-profile'},previousEntry:{present:false},profilePath:p.profile,previousProfileContent:'{"original":"profile"}',writtenProfileContent:mode==='official'?'':profile,...(mode==='local'&&fallback?{directFallbackProfileContent:profile.replace('http://127.0.0.1:45239','https://compatible.example/anthropic')}:{})};
 await put(join(root,'claude-desktop-sync-state.json'),state);const settings=JSON.parse(await readFile(join(root,'settings.json'),'utf8'));settings.claudeDesktop={syncEnabled:true};await put(join(root,'settings.json'),settings);return {...p,state,profileText:profile};}
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const requests=[];const server=createServer(async(req,res)=>{if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'claude-sonnet-fixture',supported_endpoint_types:['anthropic-messages']}]}));return;}let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);requests.push({path:req.url,key:req.headers['x-api-key'],body});res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'msg-fixture',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'Desktop fixture'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:2}}));});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
try{
 await fresh('fallback');let p=await old();start();assert.equal((await rpc('getState')).lastError,null);assert.equal((await rpc('getClaudeDesktopSync')).active,true);assert.ok((await readFile(p.profile,'utf8')).includes('https://compatible.example/anthropic'));let ledger=await json(join(root,'desktop-ledger.json'));assert.equal(ledger.local,false);assert.equal(ledger.aliases['claude-sonnet-4-6-v123'],'provider-model');await assert.rejects(readFile(join(root,'claude-desktop-sync-state.json')),{code:'ENOENT'});await stop();passed++;
 start();await rpc('getState');await rpc('updateClaudeDesktopSync',false);await stop();for(const path of p.configs){const v=await json(path);assert.equal(v.deploymentMode,'1p');assert.equal(v.external,'preserve');}assert.equal((await json(p.meta)).appliedId,'external-profile');assert.equal((await json(p.meta)).external,7);assert.equal(await readFile(p.profile,'utf8'),p.state.previousProfileContent);await assert.rejects(readFile(join(root,'desktop-recovery.json')),{code:'ENOENT'});passed++;
 await fresh('without-fallback');p=await old('local',false);start();assert.equal((await rpc('getState')).lastError,null);await stop();assert.equal((await json(p.configs[0])).deploymentMode,'1p');assert.equal(await readFile(p.profile,'utf8'),p.state.previousProfileContent);passed++;
 await fresh('direct');p=await old('direct');start();assert.equal((await rpc('getState')).lastError,null);await stop();assert.equal(await readFile(p.profile,'utf8'),p.profileText);start();assert.equal((await rpc('getState')).lastError,null);await stop();assert.equal(await readFile(p.profile,'utf8'),p.profileText);passed++;
 await fresh('official');p=await old('official');const officialMeta=await readFile(p.meta,'utf8');start();assert.equal((await rpc('getState')).lastError,null);assert.equal((await rpc('getClaudeDesktopSync')).official,true);assert.equal((await rpc('getClaudeDesktopSync')).active,true);await rpc('updateClaudeDesktopSync',false);await stop();assert.equal((await json(p.configs[0])).deploymentMode,'3p');assert.equal(await readFile(p.meta,'utf8'),officialMeta);assert.equal(await readFile(p.profile,'utf8'),p.profileText);passed++;
 await fresh('external-edit');p=await old();await put(p.profile,'{"externallyEdited":true}');const before=await Promise.all([...p.configs,p.meta,p.profile].map(path=>readFile(path,'utf8')));start();assert.match((await rpc('getState')).lastError,/外部修改/);await stop();assert.deepEqual(await Promise.all([...p.configs,p.meta,p.profile].map(path=>readFile(path,'utf8'))),before);assert.ok(await readFile(join(root,'claude-desktop-sync-state.json')));passed++;
 await fresh('interrupted-transaction');p=paths();const a='{"deploymentMode":"1p","external":7}',b='{"deploymentMode":"3p","external":7}';await put(p.configs[0],b);await put(p.configs[1],a);await put(join(root,'desktop-recovery.json'),{version:1,changes:p.configs.map(path=>({path,before:a,after:b}))});start();assert.equal((await rpc('getState')).lastError,null);await stop();assert.equal(await readFile(p.configs[0],'utf8'),a);assert.equal(await readFile(p.configs[1],'utf8'),a);await assert.rejects(readFile(join(root,'desktop-recovery.json')),{code:'ENOENT'});passed++;
 await fresh('transaction-conflict');p=paths();await put(p.configs[0],b);await put(p.configs[1],'{"external":"new-edit"}');await put(join(root,'desktop-recovery.json'),{version:1,changes:p.configs.map(path=>({path,before:a,after:b}))});start();assert.match((await rpc('getState')).lastError,/外部修改/);await stop();assert.equal(await readFile(p.configs[0],'utf8'),b);assert.equal((await json(p.configs[1])).external,'new-edit');assert.ok(await readFile(join(root,'desktop-recovery.json')));passed++;
 await fresh('unsafe-transaction');const unowned=join(root,'unowned.json');await put(unowned,'{"user":"keep"}');await put(join(root,'desktop-recovery.json'),{version:1,changes:[{path:unowned,before:null,after:'{"user":"keep"}'}]});start();assert.match((await rpc('getState')).lastError,/路径不匹配/);await stop();assert.equal((await json(unowned)).user,'keep');passed++;
 await fresh('completed-transaction');p=paths();await put(p.configs[0],b);await put(p.configs[1],b);await put(join(root,'desktop-recovery.json'),{version:1,changes:p.configs.map(path=>({path,before:a,after:b}))});start();assert.equal((await rpc('getState')).lastError,null);await stop();assert.equal(await readFile(p.configs[0],'utf8'),b);assert.equal(await readFile(p.configs[1],'utf8'),b);await assert.rejects(readFile(join(root,'desktop-recovery.json')),{code:'ENOENT'});passed++;
 for(const adapter of ['anthropic-messages','auto']){
  await fresh('native-'+adapter);p=paths();await put(p.configs[0],{deploymentMode:'1p',foreign:'keep'});start();await rpc('saveProvider',{id:'desktop-fixture',displayName:'Fixture_7ae38163',adapter,codexApiFormat:'anthropic-messages',baseUrl:base+'/v1',bearerToken:'SYNTHETIC-DESKTOP-KEY',codexModel:'claude-sonnet-fixture'});await rpc('switchClientProvider',{client:'claude',providerId:'desktop-fixture'});await rpc('updateClaudeModels',{sonnet:'claude-sonnet-fixture'});if(adapter==='auto')await rpc('fetchProviderModels',{providerId:'desktop-fixture'});const snapshot=await rpc('updateClaudeDesktopSync',true);assert.equal(snapshot.active,true);assert.equal(snapshot.warning,undefined);
  async function request(){const profile=await json(p.profile);assert.equal(profile.inferenceGatewayAuthScheme,'x-api-key');const model=profile.inferenceModels[0].name;const response=await fetch(profile.inferenceGatewayBaseUrl+'/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':profile.inferenceGatewayApiKey,'anthropic-version':'2023-06-01'},body:JSON.stringify({model,max_tokens:32,messages:[{role:'user',content:'isolated request'}]})});assert.equal(response.status,200);assert.equal((await response.json()).content[0].text,'Desktop fixture');}
  await request();await rpc('toggleTracing',true);await request();await rpc('toggleTracing',false);await request();for(const request of requests.slice(-3)){assert.equal(request.path,'/v1/messages');assert.equal(request.key,'SYNTHETIC-DESKTOP-KEY');assert.equal(request.body.model,'claude-sonnet-fixture');}
  const savedProfile=await readFile(p.profile,'utf8');await put(p.profile,'{"foreign":"new profile"}');const disabled=await rpc('updateClaudeDesktopSync',false);assert.equal(disabled.enabled,false);assert.match(disabled.warning,/外部.*profile/);assert.equal((await json(p.profile)).foreign,'new profile');assert.equal((await json(join(root,'settings.json'))).claudeDesktop.syncEnabled,false);await stop();start();await rpc('getState');assert.equal((await rpc('getClaudeDesktopSync')).enabled,false);assert.match((await rpc('getClaudeDesktopSync')).warning,/外部.*profile/);assert.match((await rpc('getState')).lastError,/外部.*profile/);await put(p.profile,savedProfile);const done=await rpc('updateClaudeDesktopSync',false);assert.equal(done.warning,undefined);assert.equal((await json(p.configs[0])).deploymentMode,'1p');assert.equal((await json(p.configs[0])).foreign,'keep');await stop();passed++;
 }
 await fresh('already-restored-fields');p=await old('direct');start();await rpc('getState');await stop();await put(p.configs[0],{deploymentMode:'1p',external:'latest'});await put(p.profile,p.state.previousProfileContent);await put(p.meta,{appliedId:'external-profile',entries:[{id:'external-profile',name:'External'}],external:'latest'});start();const restored=await rpc('updateClaudeDesktopSync',false);assert.equal(restored.warning,undefined);await stop();assert.equal((await json(p.configs[0])).external,'latest');assert.equal((await json(p.meta)).external,'latest');assert.equal(await readFile(p.profile,'utf8'),p.state.previousProfileContent);passed++;
 for (const alias of ['xwx-deck', 'xwx-deck-deepseek']) {
  await fresh('alias-' + alias); p = await old();
  const aliasPath = join(p.dir, 'configLibrary', alias + '.json');
  await rm(p.profile); await put(aliasPath, p.profileText);
  const previous = '{"previousAlias":"user-owned","inferenceGatewayBaseUrl":"https://original.fixture"}';
  const state = { ...p.state, profilePath: aliasPath, previousProfileContent: previous, previousAppliedId: { present: true, value: alias }, previousEntry: { present: true, value: { id: alias, name: 'Original user profile', extra: 9 } } };
  await put(join(root, 'claude-desktop-sync-state.json'), state);
  await put(p.meta, { appliedId: alias, entries: [{ id: 'foreign', name: 'Foreign' }, { id: alias, name: 'XwX Deck' }], foreign: 17 });
  start(); assert.equal((await rpc('getState')).lastError, null);
  assert.equal((await rpc('getClaudeDesktopSync')).active, true);
  assert.equal((await json(p.meta)).appliedId, ID);
  assert.equal((await json(p.meta)).entries.find(e => e.id === alias).name, 'Original user profile');
  assert.equal(await readFile(aliasPath, 'utf8'), previous);
  assert.ok((await readFile(p.profile, 'utf8')).includes('https://compatible.example/anthropic'));
  await stop(); start(); assert.equal((await rpc('getState')).lastError, null);
  await rpc('updateClaudeDesktopSync', false); await stop();
  assert.equal((await json(p.meta)).appliedId, alias); assert.equal((await json(p.meta)).foreign, 17);
  assert.equal(await readFile(aliasPath, 'utf8'), previous); await assert.rejects(readFile(p.profile), { code: 'ENOENT' });
  passed++;
 }
 await fresh('alias-canonical-conflict'); p = await old('direct');
 const aliasPath = join(p.dir, 'configLibrary/xwx-deck.json'); await put(aliasPath, p.profileText);
 await put(p.profile, '{"foreignCanonical":"keep"}');
 await put(p.meta, { appliedId: 'xwx-deck', entries: [{ id: 'xwx-deck', name: 'XwX Deck' }, { id: ID, name: 'Foreign UUID' }] });
 await put(join(root, 'claude-desktop-sync-state.json'), { ...p.state, profilePath: aliasPath });
 const conflictsBefore = await Promise.all([...p.configs, p.meta, p.profile, aliasPath].map(path => readFile(path, 'utf8')));
 start(); assert.match((await rpc('getState')).lastError, /UUID profile/); await stop();
 assert.deepEqual(await Promise.all([...p.configs, p.meta, p.profile, aliasPath].map(path => readFile(path, 'utf8'))), conflictsBefore);
 assert.ok(await readFile(join(root, 'claude-desktop-sync-state.json'))); passed++;

 await fresh('official-current-library-baseline'); p = paths();
 for (const path of p.configs) await put(path, { deploymentMode: '3p', foreign: 'original' });
 await put(p.meta, { appliedId: 'user-old', entries: [{ id: 'user-old', name: 'User old' }], foreign: 'original' });
 await put(p.profile, '{"originalUuid":"keep"}');
 start(); let synced = await rpc('updateClaudeDesktopSync', true);
 assert.equal(synced.official, true); assert.equal(synced.active, true);
 assert.equal((await json(p.configs[0])).deploymentMode, '1p');
 const laterMeta = { appliedId: 'user-latest', entries: [{ id: 'user-latest', name: 'Latest user profile' }], foreign: 'latest' };
 const laterProfile = '{"laterUuid":"preserve"}'; await put(p.meta, laterMeta); await put(p.profile, laterProfile);
 await rpc('saveProvider', { id: 'official-transition', displayName: 'Fixture_b46f2ffb', adapter: 'anthropic-messages', baseUrl: base, bearerToken: 'SYNTHETIC-DESKTOP-KEY', codexModel: 'claude-sonnet-fixture' });
 await rpc('switchClientProvider', { client: 'claude', providerId: 'official-transition' });
 await rpc('updateClaudeModels', { sonnet: 'claude-sonnet-fixture' });
 assert.equal((await rpc('getClaudeDesktopSync')).active, true); assert.equal((await json(p.meta)).appliedId, ID);
 await rpc('switchClientProvider', { client: 'claude', providerId: null });
 assert.equal((await rpc('getClaudeDesktopSync')).official, true); assert.equal((await json(p.configs[0])).deploymentMode, '1p');
 assert.deepEqual(await json(p.meta), laterMeta); assert.equal(await readFile(p.profile, 'utf8'), laterProfile);
 await stop(); start(); assert.equal((await rpc('getClaudeDesktopSync')).official, true);
 await rpc('updateClaudeDesktopSync', false); await stop();
 assert.equal((await json(p.configs[0])).deploymentMode, '3p');
 assert.deepEqual(await json(p.meta), laterMeta); assert.equal(await readFile(p.profile, 'utf8'), laterProfile); passed++;
 console.log(JSON.stringify({passed,isolatedFixtures:true,requests:requests.length,scope:'legacy Desktop lifecycles and aliases, current official-mode library baselines, direct compatible and explicit Messages final profile requests, conflict-preserved toggle intent and retry; no installed Desktop process used'}));
}finally{if(child?.exitCode===null){child.kill('SIGKILL');await once(child,'exit');}server.closeAllConnections();await new Promise(r=>server.close(r));await rm(fixture,{recursive:true,force:true});}
