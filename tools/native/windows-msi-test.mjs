// Explicit Windows installation acceptance. Never uninstall a pre-existing product.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, writeFile, access, copyFile, unlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { buildWindowsMsi } from './windows-msi.mjs';
import { standardWindowsArtifact } from './windows-execution-level.mjs';

if(process.platform!=='win32')throw Error('Windows MSI acceptance requires Windows.');
const repo=resolve(import.meta.dirname,'../..');
const arg=name=>process.argv.find(value=>value.startsWith(name+'='))?.slice(name.length+1);
const oldInput=resolve(arg('--old-binary')||'test-results/msi-old-debug.exe');
const newInput=resolve(arg('--new-binary')||'test-results/msi-new-debug.exe');
const oldVersion=arg('--old-version')||'0.9.9',newVersion=arg('--new-version')||JSON.parse(await readFile(join(repo,'package.json'),'utf8')).version;
const work=await mkdtemp(join(repo,'test-results/windows-msi-acceptance-'));
await standardWindowsArtifact(work);
await writeFile(join(work,'.xwx-msi-test'),'isolated-msi-test\n');
const oldBinary=join(work,'old.exe'),newBinary=join(work,'new.exe');
await copyFile(oldInput,oldBinary);await copyFile(newInput,newBinary);
const data=join(work,'existing-data'),install=process.argv.includes('--system-drive')
 ?join(process.env.LOCALAPPDATA,'Programs','Deck 回归 '+work.split(/[\\/]/).at(-1)):join(work,'用户 程序');
await mkdir(data);await writeFile(join(data,'.xwx-rust-pilot'),'isolated-rust-pilot-v1\n');
const msiexec=join(process.env.WINDIR,'System32/msiexec.exe');
function registration(){
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',String.raw`[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $p=Get-ItemProperty -LiteralPath 'HKCU:\Software\XwX Deck\Installation' -ErrorAction SilentlyContinue; if($p){@{Path=$p.Path;ProductCode=$p.ProductCode;Version=$p.Version;UpgradeCode=$p.UpgradeCode}|ConvertTo-Json -Compress}; exit 0`],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);return result.stdout.trim()?JSON.parse(result.stdout):null;
}
assert.equal(registration(),null,'An MSI already exists; do not replace another installation.');
const shortcut=join(process.env.APPDATA,'Microsoft/Windows/Start Menu/Programs/XwX Deck.lnk');
const previousShortcut=await readFile(shortcut).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
async function msi(args,name,fullUi=false){
  console.log('Windows Installer: '+name);
  const command=[...args,...(fullUi?[]:['/qn']),'/norestart','REBOOT=ReallySuppress','/L*v',join(work,name+'.log')].map(arg=>arg.startsWith('INSTALLDIR=')?'INSTALLDIR="'+arg.slice(11)+'"':/\s/.test(arg)?'"'+arg+'"':arg);
  // No inherited output pipes: a detached service must not keep this driver waiting after a timeout.
  const result=spawnSync(msiexec,command,{windowsVerbatimArguments:true,windowsHide:!fullUi,timeout:90000,stdio:'ignore'});
  if(result.error)throw result.error;
  return result.status;
}
const checks=[];const pass=name=>{checks.push(name);console.log('PASS '+name);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function rpcSession(binary,task){
 const child=spawn(binary,['--rpc','--pilot-root',data],{windowsHide:true,env:{...process.env,XWX_DECK_UPDATE_SERVER_URL:base},stdio:['pipe','pipe','pipe']});
 const queue=[];let errors='';createInterface({input:child.stdout}).on('line',line=>queue.shift()?.(JSON.parse(line)));child.stderr.on('data',d=>errors+=d);
 const rpc=(method,...args)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('RPC timeout '+method+' '+errors)),25000);queue.push(value=>{clearTimeout(timer);value.ok?resolve(value.result):reject(Error(value.error));});child.stdin.write(JSON.stringify({method,args})+'\n');});
 try{return await task(rpc,child);}finally{if(child.exitCode===null){const exited=once(child,'exit');child.stdin.end();const [code]=await exited;assert.equal(code,0,errors);}}
}
let artifacts,modelRequests=0;
const server=createServer(async(req,res)=>{
 if(req.url==='/release.json'){res.setHeader('content-type','application/json');res.end(JSON.stringify({schemaVersion:1,channel:'release',releaseSeries:'native-v1',version:newVersion,tag:'v'+newVersion,files:[
  {platform:'windows',arch:'x64',name:'fixture.exe',url:base+'/portable',size:3,sha256:hash(Buffer.from('exe'))},
  {platform:'windows',arch:'x64',name:'fixture.msi',url:base+'/installer',size:artifacts.new.size,sha256:artifacts.new.sha256}
 ]}));return;}
 if(req.url==='/installer'){res.end(await readFile(artifacts.new.path));return;}
 if(req.url==='/portable'){res.end('exe');return;}
 if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fixture-model'}]}));return;}
 if(req.url==='/v1/responses'){for await(const _ of req){}if(req.headers.authorization!=='Bearer synthetic-msi-key'){res.writeHead(401);res.end('Synthetic credential was not preserved');return;}modelRequests++;res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'msi-fixture',object:'response',status:'completed',output:[],usage:{input_tokens:2,output_tokens:1,total_tokens:3}}));return;}
 res.writeHead(404);res.end();
});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
const executable=join(install,'XwX Deck.exe');let installed=false,ui,ownedInstall=install,fullUi;
const wait=async(test,label,limit=1200)=>{for(let n=0;n<limit;n++){if(await test())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error(label);};
let settingsBefore,providersBefore,traceFile,traceBefore;
try{
 let next;
 if(arg('--new-msi')){
  const path=resolve(arg('--new-msi')),report=JSON.parse(await readFile(join(dirname(path),'native-build-report.json'),'utf8'));
  assert.equal(report.dirty,false);assert.equal(report.version,newVersion);
  assert.equal(report.candidate.binarySha256,hash(await readFile(newBinary)));
  assert.equal(report.installer.sha256,hash(await readFile(path)));
  next={...report.installer,path};
 }else next=await buildWindowsMsi({root:repo,binary:newBinary,output:join(work,'new.msi'),version:newVersion});
 artifacts={old:await buildWindowsMsi({root:repo,binary:oldBinary,output:join(work,'old.msi'),version:oldVersion}),new:next};
 assert.ok(artifacts.old.iceValidated && artifacts.new.iceValidated);
 console.log('Built MSI fixtures: '+work);
 const uiFixture=join(work,'installer.ui-test.msi');
 const request=Buffer.from(JSON.stringify({source:artifacts.new.path,target:uiFixture})).toString('base64');
 const prepared=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',join(repo,'tools/native/windows-msi-ui-fixture.ps1'),'-Request',request],{encoding:'utf8',windowsHide:true});
 assert.equal(prepared.status,0,prepared.stderr);
 ownedInstall=join(process.env.LOCALAPPDATA,'Programs','Deck 验收 '+work.split(/[\\/]/).at(-1));
 const began=Date.now();assert.equal(await msi(['/i',uiFixture,'INSTALLDIR='+ownedInstall],'full-ui-install',true),0);installed=true;
 const uiLog=await readFile(join(work,'full-ui-install.log'),'utf16le');
 assert.ok(uiLog.includes('DeckProgress'),'Full MSI UI must enter its branded progress dialog');
 assert.ok(!uiLog.includes('Calling SRSetRestorePoint API'),'Per-user setup must not wait for a machine restore checkpoint');
 assert.equal(registration().Path.replace(/[\\/]$/,''),ownedInstall);
 assert.equal(hash(await readFile(join(ownedInstall,'XwX Deck.exe'))),hash(await readFile(newBinary)));
 fullUi={elapsedMs:Date.now()-began,restoreCheckpointRequested:false,customPath:true,scope:'full UI progress and engine; entry/finish gates bypassed in an isolated copy; no mouse-interaction claim'};
 pass('full UI progress completes without a system restore checkpoint and installs exact files to the chosen C-drive Unicode path');
 assert.equal(await msi(['/x',registration().ProductCode],'uninstall-full-ui'),0);installed=false;ownedInstall=install;
 await rpcSession(newBinary,async rpc=>{
  assert.deepEqual((await rpc('getProviders')).connections,[]);
  const p=await rpc('saveProvider',{id:'msi-preserved',displayName:'MSI fixture',baseUrl:base+'/v1',bearerToken:'synthetic-msi-key',adapter:'responses',codexModel:'fixture-model'});
  await rpc('switchClientProvider',{client:'codex',providerId:p.connections[0].id});
  const state=await rpc('toggleTracing',true);
  const response=await fetch(state.localBaseUrl+'/responses',{method:'POST',headers:{'content-type':'application/json','x-session-id':'msi-preserved-session'},body:JSON.stringify({model:'fixture-model',input:'Synthetic MSI preserved history'})});assert.equal(response.status,200);await response.json();await rpc('toggleTracing',false);
  providersBefore=await rpc('getProviders');
 });
 // Own fixture files only: never inspect real user conversation data.
 const {readdir}=await import('node:fs/promises');
 async function files(path){let result=[];for(const entry of await readdir(path,{withFileTypes:true})){const p=join(path,entry.name);result.push(...entry.isDirectory()?await files(p):[p]);}return result;}
 traceFile=(await files(data)).find(path=>path.endsWith('.jsonl') && path.includes('traces'));
 assert.ok(traceFile,'Synthetic trace file was persisted');traceBefore=hash(await readFile(traceFile));
 settingsBefore=hash(await readFile(join(data,'settings.json')));
 assert.equal(await msi(['/i',artifacts.old.path,'INSTALLDIR='+install],'install-old'),0);installed=true;
 assert.equal(registration().Version,oldVersion);assert.equal(hash(await readFile(executable)),hash(await readFile(oldBinary)));
 await access(shortcut);
 assert.equal(hash(await readFile(join(data,'settings.json'))),settingsBefore);assert.equal(hash(await readFile(traceFile)),traceBefore);
 pass('per-user installation succeeds in a Unicode path and preserves existing configuration and trace');
 await rpcSession(executable,async(rpc)=>{const state=await rpc('getUpdateState');assert.equal(state.currentVersion,oldVersion);assert.equal(state.portable,false);assert.deepEqual(await rpc('getProviders'),providersBefore);});
 pass('installed old application recognizes MSI ownership and restores the existing provider');
 const rollbackFixture=join(work,'rollback.ui-test.msi');
 const rollbackRequest=Buffer.from(JSON.stringify({source:artifacts.new.path,target:rollbackFixture,mode:'rollback'})).toString('base64');
 const rollbackPrepared=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',join(repo,'tools/native/windows-msi-ui-fixture.ps1'),'-Request',rollbackRequest],{encoding:'utf8',windowsHide:true});
 assert.equal(rollbackPrepared.status,0,rollbackPrepared.stderr);
 const beforeRollback=registration();
 assert.equal(await msi(['/i',rollbackFixture],'rollback-upgrade'),1603);
 assert.deepEqual(registration(),beforeRollback);
 assert.equal(hash(await readFile(executable)),hash(await readFile(oldBinary)));
 await access(shortcut);
 assert.equal(hash(await readFile(join(data,'settings.json'))),settingsBefore);
 assert.equal(hash(await readFile(traceFile)),traceBefore);
 pass('a failure after replacing files and removing the old product rolls back the program, registration and shortcut while retaining data');
 const unwantedMove=join(work,'must-not-relocate');
 assert.equal(await msi(['/i',uiFixture,'INSTALLDIR='+unwantedMove],'full-ui-upgrade',true),0);
 const upgradeLog=await readFile(join(work,'full-ui-upgrade.log'),'utf16le');
 assert.ok(!/Setting File Security failed|Error 28\d\d:/.test(upgradeLog),'Full UI upgrade must not pass with file-security or dialog errors');
 assert.equal(registration().Path.replace(/[\\/]$/,''),install);
 assert.equal(registration().Version,newVersion);
 await assert.rejects(access(join(unwantedMove,'XwX Deck.exe')));
 assert.equal(hash(await readFile(executable)),hash(await readFile(newBinary)));
 pass('full UI major upgrade retains the registered installation path even when a different path is supplied');
 await unlink(executable);
 assert.equal(await msi(['/famus',registration().ProductCode],'repair-missing-file'),0);
 assert.equal(hash(await readFile(executable)),hash(await readFile(newBinary)));
 await access(shortcut);
 assert.equal(hash(await readFile(join(data,'settings.json'))),settingsBefore);
 assert.equal(hash(await readFile(traceFile)),traceBefore);
 pass('repair restores a missing installed executable and the start-menu entry without changing retained data');
 assert.equal(await msi(['/x',registration().ProductCode],'uninstall-before-update-fixture'),0);installed=false;
 assert.equal(await msi(['/i',artifacts.old.path,'INSTALLDIR='+install],'restore-old-update-fixture'),0);installed=true;
 await rpcSession(executable,async(rpc)=>{await rpc('getState');assert.notEqual(await msi(['/x',registration().ProductCode],'busy-uninstall'),0);assert.ok(registration());await access(executable);});
 pass('uninstall refuses a running installed application without terminating it or removing files');
 let installerPath,finishedPid;
 await rpcSession(executable,async(rpc,child)=>{
  finishedPid=child.pid;assert.equal((await rpc('checkForAutomaticUpdates')).status,'available');await rpc('downloadAutomaticUpdate');
  await wait(async()=>{const state=await rpc('getUpdateState');if(state.status==='error')throw Error(state.error);if(state.status==='ready'){installerPath=state.downloadPath;return true;}return false;},'MSI fixture did not download');
  const bytes=await readFile(installerPath);await writeFile(installerPath,'modified fixture');
  await assert.rejects(rpc('restartAndInstall'),/已被修改/);await writeFile(installerPath,bytes);
  assert.equal((await rpc('restartAndInstall')).path,installerPath);
 });
 pass('automatic check/download selects the actual MSI over a portable artifact and rejects modified bytes before preparing installation');
 const failedHelper=join(data,'updates/xwx-msi-update-failure.exe');await copyFile(executable,failedHelper);
 const failed=spawn(failedHelper,['--install-msi-update',installerPath,'--replace-executable',executable,'--expected-sha256','0'.repeat(64),'--expected-version',newVersion,'--parent-pid',String(finishedPid),'--pilot-root',data,'--smoke-msi-restart'],{windowsHide:true,stdio:'ignore'});
 assert.equal((await once(failed,'exit'))[0],1);
 const failure=JSON.parse(await readFile(failedHelper.replace(/\.exe$/,'.result.json'),'utf8'));assert.equal(failure.status,'error');assert.match(failure.error,/已被修改/);assert.ok(failure.recoveryPid);
 await wait(async()=>{try{const report=JSON.parse(await readFile(join(data,'native-smoke.json'),'utf8'));assert.ok(report.passed,report.error);return report.stage==='restarted' && report.version===oldVersion;}catch(error){if(error.code==='ENOENT')return false;throw error;}},'Original app did not restart after rejected MSI');
 await wait(()=>{const r=spawnSync('tasklist.exe',['/FI','PID eq '+failure.recoveryPid,'/FO','CSV','/NH'],{encoding:'utf8',windowsHide:true});return !r.stdout.includes('"'+failure.recoveryPid+'"');},'Recovery test app did not exit');
 assert.equal(registration().Version,oldVersion);assert.equal(hash(await readFile(traceFile)),traceBefore);
 pass('detached worker rejects tampering, reports failure and renders the unchanged old application again');
 ui=spawn(executable,['--pilot-root',data,'--smoke','--smoke-msi-update','--smoke-msi-restart'],{windowsHide:true,env:{...process.env,XWX_DECK_UPDATE_SERVER_URL:base,XWX_SYSTEM_LANGUAGE_TEST:'zh-CN'},stdio:['ignore','ignore','ignore']});
 await wait(async()=>{try{const report=JSON.parse(await readFile(join(data,'native-smoke.json'),'utf8'));if(!report.passed)throw Error(report.error);return report.stage==='downloaded';}catch(error){if(error.code==='ENOENT')return false;throw error;}},'MSI update did not download');
 await wait(()=>ui.exitCode!==null,'Old app did not exit for MSI update');assert.equal(ui.exitCode,0);
 await wait(async()=>{try{const report=JSON.parse(await readFile(join(data,'native-smoke.json'),'utf8'));if(!report.passed)throw Error(report.error);return report.stage==='restarted' && report.version===newVersion;}catch(error){if(error.code==='ENOENT')return false;throw error;}},'New app did not render after MSI upgrade');
 const results=(await readdir(join(data,'updates'))).filter(name=>name.endsWith('.result.json'));
 const reports=await Promise.all(results.map(async name=>JSON.parse(await readFile(join(data,'updates',name),'utf8'))));
 const result=reports.find(report=>report.status==='installed');assert.ok(result,JSON.stringify(reports));
 await wait(()=>{const r=spawnSync('tasklist.exe',['/FI','PID eq '+result.restartPid,'/FO','CSV','/NH'],{encoding:'utf8',windowsHide:true});return !r.stdout.includes('"'+result.restartPid+'"');},'Restarted test app did not exit');
 assert.equal(registration().Version,newVersion);assert.equal(hash(await readFile(executable)),hash(await readFile(newBinary)));
 assert.equal(hash(await readFile(join(data,'settings.json'))),settingsBefore);assert.equal(hash(await readFile(traceFile)),traceBefore);
 pass('native rendered updater selects MSI, verifies/downloads it, upgrades the old version and renders the real new executable');
 await rpcSession(executable,async rpc=>{assert.equal((await rpc('getUpdateState')).currentVersion,newVersion);assert.deepEqual(await rpc('getProviders'),providersBefore);const state=await rpc('toggleTracing',true);const response=await fetch(state.localBaseUrl+'/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fixture-model',input:'Synthetic post-upgrade request'})});assert.equal(response.status,200);await response.json();await rpc('toggleTracing',false);});
 pass('preserved provider completes an actual local model request after the MSI upgrade');
 assert.equal(await msi(['/x',registration().ProductCode],'uninstall-new'),0);installed=false;assert.equal(registration(),null);await assert.rejects(access(executable));await assert.rejects(access(shortcut));
 assert.equal(hash(await readFile(join(data,'settings.json'))),settingsBefore);assert.equal(hash(await readFile(traceFile)),traceBefore);
 pass('uninstall removes installed program and registration while retaining configuration and trace data');
 assert.equal(await msi(['/i',artifacts.new.path,'INSTALLDIR='+install],'reinstall-new'),0);installed=true;
 await rpcSession(executable,async rpc=>{assert.deepEqual(await rpc('getProviders'),providersBefore);});
 assert.equal(await msi(['/x',registration().ProductCode],'uninstall-reinstalled'),0);installed=false;
 pass('reinstall opens the retained configuration and a second uninstall cleans the installation');
 await writeFile(join(work,'summary.json'),JSON.stringify({passed:true,checks,artifacts,fullUi,modelRequests,work,scope:'isolated local MSI installation, upgrade, rendered restart and uninstall; no real user data'},null,2)+'\n');console.log(JSON.stringify({passed:true,checks:checks.length,work}));
}finally{
 if(ui?.exitCode===null){const ended=once(ui,'exit');ui.kill();await ended;}
 if(installed){const current=registration();if(current?.Path.replace(/[\\/]$/,'')===ownedInstall){const code=await msi(['/x',current.ProductCode],'cleanup-owned-installation');if(code)console.error('Owned MSI cleanup failed; inspect logs:',current.ProductCode,code);}}
 if(previousShortcut && !registration())await writeFile(shortcut,previousShortcut);
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
