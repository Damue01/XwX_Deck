// Explicit per-user Setup acceptance. Never replace a pre-existing installation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, writeFile, access, copyFile, unlink, readdir, open } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { buildWindowsSetup } from './windows-nsis.mjs';
import { standardWindowsArtifact } from './windows-execution-level.mjs';

if (process.platform !== 'win32') throw Error('Windows Setup acceptance requires Windows.');
const repo=resolve(import.meta.dirname,'../..');
const arg=name=>process.argv.find(value=>value.startsWith(name+'='))?.slice(name.length+1);
const oldInput=resolve(arg('--old-binary')||'test-results/setup-old-debug.exe');
const newInput=resolve(arg('--new-binary')||'test-results/setup-new-debug.exe');
const oldVersion=arg('--old-version')||'0.9.9',newVersion=JSON.parse(await readFile(join(repo,'package.json'),'utf8')).version;
function registration() {
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',String.raw`[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $p=Get-ItemProperty -LiteralPath 'HKCU:\Software\XwX Deck\Installation' -ErrorAction SilentlyContinue; if($p){@{Path=$p.Path;Version=$p.Version;InstallerType=$p.InstallerType;AppId=$p.AppId;BinarySha256=$p.BinarySha256}|ConvertTo-Json -Compress}; exit 0`],{encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0,result.stderr);return result.stdout.trim()?JSON.parse(result.stdout):null;
}
assert.equal(registration(),null,'An installation already exists; never replace it for acceptance.');
const work=await mkdtemp(join(repo,'test-results/windows-setup-acceptance-'));
await standardWindowsArtifact(work);await writeFile(join(work,'.xwx-setup-test'),'isolated-setup-test\n');
const oldBinary=join(work,'old.exe'),newBinary=join(work,'new.exe');
await copyFile(oldInput,oldBinary);await copyFile(newInput,newBinary);
const data=join(work,'existing-data'),install=join(work,'用户 程序');
await mkdir(data);await writeFile(join(data,'.xwx-rust-pilot'),'isolated-rust-pilot-v1\n');
const shortcut=join(process.env.APPDATA,'Microsoft/Windows/Start Menu/Programs/XwX Deck.lnk');
const previousShortcut=await readFile(shortcut).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
const foreignShortcutMarker=Buffer.from('unrelated shortcut fixture');
if(previousShortcut)await writeFile(join(work,'previous-shortcut.lnk'),previousShortcut);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const checks=[];const pass=name=>{checks.push(name);console.log('PASS '+name);};
const wait=async(test,label,limit=1200)=>{for(let n=0;n<limit;n++){if(await test())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error(label);};
function setup(binary,args,name) {
 console.log('Setup: '+name);
 const command=['/S',`"/LOG=${join(work,name+'.log')}"`,...args];
 const result=spawnSync(binary,command,{windowsVerbatimArguments:true,windowsHide:true,timeout:60000,stdio:'ignore'});
 if(result.error)throw result.error;
 assert.ok(existsSync(join(work,name+'.log')),'Setup must honor the explicit quoted log argument');
 return result.status;
}
async function uninstall(name) {
 const current=registration();assert.ok(current);
 assert.equal(current.InstallerType,'nsis-v1');assert.equal(current.AppId,'app.xwxdeck.desktop');
 assert.ok([install,cInstall].includes(current.Path),'Only owned installation directories may be removed');
 const runner=join(work,name+'-uninstall.exe');await copyFile(join(current.Path,'uninstall.exe'),runner);await standardWindowsArtifact(runner);
 const result=spawnSync(runner,['/S','_?='+current.Path],{windowsVerbatimArguments:true,windowsHide:true,timeout:60000,stdio:'ignore'});
 if(result.error)throw result.error;return result.status;
}
async function rpcSession(binary,task) {
 const child=spawn(binary,['--rpc','--pilot-root',data],{windowsHide:true,env:{...process.env,XWX_DECK_UPDATE_SERVER_URL:base},stdio:['pipe','pipe','pipe']});
 const queue=[];let errors='';createInterface({input:child.stdout}).on('line',line=>queue.shift()?.(JSON.parse(line)));child.stderr.on('data',d=>errors+=d);
 const rpc=(method,...args)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('RPC timeout '+method+' '+errors)),25000);queue.push(value=>{clearTimeout(timer);value.ok?resolve(value.result):reject(Error(value.error));});child.stdin.write(JSON.stringify({method,args})+'\n');});
 try{return await task(rpc,child);}finally{if(child.exitCode===null){const exited=once(child,'exit');child.stdin.end();const [code]=await exited;assert.equal(code,0,errors);}}
}
let artifacts,modelRequests=0;
const server=createServer(async(req,res)=>{
 if(req.url==='/release.json'){res.setHeader('content-type','application/json');res.end(JSON.stringify({schemaVersion:1,channel:'release',releaseSeries:'native-v1',version:newVersion,tag:'v'+newVersion,files:[
  {platform:'windows',arch:'x64',name:'fixture.exe',kind:'portable',url:base+'/portable',size:3,sha256:hash(Buffer.from('exe'))},
  {platform:'windows',arch:'x64',name:'fixture-setup.exe',kind:'installer',url:base+'/installer',size:artifacts.new.size,sha256:artifacts.new.sha256}
 ]}));return;}
 if(req.url==='/installer'){res.end(await readFile(artifacts.new.path));return;}
 if(req.url==='/portable'){res.end('exe');return;}
 if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fixture-model'}]}));return;}
 if(req.url==='/v1/responses'){for await(const _ of req){}if(req.headers.authorization!=='Bearer synthetic-setup-key'){res.writeHead(401);res.end('Synthetic credential mismatch');return;}modelRequests++;res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'setup-fixture',object:'response',status:'completed',output:[],usage:{input_tokens:2,output_tokens:1,total_tokens:3}}));return;}
 res.writeHead(404);res.end();
});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
const cInstall=join(process.env.LOCALAPPDATA,'Programs','Deck 验收 '+work.split(/[\\/]/).at(-1));
const executable=join(install,'XwX Deck.exe');let ui;
let settingsBefore,providersBefore,traceFile,traceBefore;
try {
 let next;
 if(arg('--new-setup')){
  const path=resolve(arg('--new-setup')),report=JSON.parse(await readFile(join(dirname(path),'native-build-report.json'),'utf8'));
  assert.equal(report.dirty,false);assert.equal(report.version,newVersion);assert.equal(report.installer.installerType,'nsis-v1');assert.equal(report.installer.failureFixture,false);
  assert.equal(report.candidate.binarySha256,hash(await readFile(newBinary)));assert.equal(report.installer.sha256,hash(await readFile(path)));
  next={...report.installer,path};
 }else next=await buildWindowsSetup({root:repo,binary:newBinary,output:join(work,'new-setup.exe'),version:newVersion});
 artifacts={old:await buildWindowsSetup({root:repo,binary:oldBinary,output:join(work,'old-setup.exe'),version:oldVersion}),new:next};
 const failed=await buildWindowsSetup({root:repo,binary:newBinary,output:join(work,'failure-setup.exe'),version:newVersion,failureFixture:true});
 const lateFailure=await buildWindowsSetup({root:repo,binary:newBinary,output:join(work,'late-failure-setup.exe'),version:newVersion,failureFixture:'registered'});
 const uninstallFailure=await buildWindowsSetup({root:repo,binary:newBinary,output:join(work,'uninstall-failure-setup.exe'),version:newVersion,failureFixture:'uninstall'});
 for(const name of ['.xwx-deck-new.exe','.xwx-deck-old.exe','.xwx-deck-old-uninstall.exe']){
  const target=join(work,'暂存 冲突 '+name),marker=join(target,name);await mkdir(target);await writeFile(marker,'unrelated existing bytes');
  assert.equal(setup(artifacts.new.path,['/D='+target],'stage-collision-'+name),3);
  assert.equal(await readFile(marker,'utf8'),'unrelated existing bytes');assert.equal(registration(),null);await assert.rejects(access(join(target,'XwX Deck.exe')));
 }
 pass('pre-existing staging and recovery files refuse installation and remain byte-for-byte intact');
 const unrelatedShortcut=previousShortcut||foreignShortcutMarker;
 if(!previousShortcut)await writeFile(shortcut,unrelatedShortcut);
 assert.equal(setup(artifacts.new.path,['/D='+cInstall],'c-drive-install'),0);
 assert.deepEqual(await readFile(shortcut),unrelatedShortcut,'installation preserves an unrelated named shortcut');
 assert.equal(registration().Path,cInstall);assert.equal(hash(await readFile(join(cInstall,'XwX Deck.exe'))),hash(await readFile(newBinary)));
 assert.equal(await uninstall('c-drive-uninstall'),0);assert.equal(registration(),null);
 assert.deepEqual(await readFile(shortcut),unrelatedShortcut,'uninstall preserves an unrelated named shortcut');
 if(!previousShortcut)await unlink(shortcut);
 pass('per-user Setup installs exact files in a Unicode C-drive path and uninstalls without Windows Installer');
 await rpcSession(newBinary,async rpc=>{
  assert.deepEqual((await rpc('getProviders')).connections,[]);
  const p=await rpc('saveProvider',{id:'setup-preserved',displayName:'Setup fixture',baseUrl:base+'/v1',bearerToken:'synthetic-setup-key',adapter:'responses',codexModel:'fixture-model'});
  await rpc('switchClientProvider',{client:'codex',providerId:p.connections[0].id});
  const state=await rpc('toggleTracing',true);const response=await fetch(state.localBaseUrl+'/responses',{method:'POST',headers:{'content-type':'application/json','x-session-id':'setup-preserved-session'},body:JSON.stringify({model:'fixture-model',input:'Synthetic preserved history'})});assert.equal(response.status,200);await response.json();await rpc('toggleTracing',false);providersBefore=await rpc('getProviders');
 });
 async function files(path){let result=[];for(const entry of await readdir(path,{withFileTypes:true})){const p=join(path,entry.name);result.push(...entry.isDirectory()?await files(p):[p]);}return result;}
 traceFile=(await files(data)).find(path=>path.endsWith('.jsonl')&&path.includes('traces'));assert.ok(traceFile);traceBefore=hash(await readFile(traceFile));settingsBefore=hash(await readFile(join(data,'settings.json')));
 assert.equal(setup(artifacts.old.path,['/D='+install],'e-drive-install'),0);
 assert.equal(registration().Path,install);assert.equal(registration().Version,oldVersion);assert.equal(hash(await readFile(executable)),hash(await readFile(oldBinary)));await access(shortcut);
 await rpcSession(executable,async rpc=>{assert.equal((await rpc('getUpdateState')).portable,false);assert.deepEqual(await rpc('getProviders'),providersBefore);});
 pass('Unicode E-drive installation retains data and the installed application recognizes its ownership');
 await rpcSession(executable,async rpc=>{await rpc('getState');assert.equal(setup(artifacts.new.path,[],'busy-upgrade'),2);assert.equal(await uninstall('busy-uninstall'),2);assert.equal(hash(await readFile(executable)),hash(await readFile(oldBinary)));});
 pass('installation and uninstall refuse a running app without terminating it or changing its files');
 const beforeRollback=registration(),oldUninstaller=hash(await readFile(join(install,'uninstall.exe'))),oldShortcut=hash(await readFile(shortcut));
 assert.equal(setup(failed.path,[],'failed-upgrade'),3);assert.deepEqual(registration(),beforeRollback);
 assert.equal(hash(await readFile(executable)),hash(await readFile(oldBinary)));assert.equal(hash(await readFile(join(install,'uninstall.exe'))),oldUninstaller);assert.equal(hash(await readFile(shortcut)),oldShortcut);
 await rpcSession(executable,async rpc=>{assert.equal((await rpc('getUpdateState')).portable,false);});
 pass('an injected failure after replacement restores files, uninstall program, shortcut and working installation ownership');
 assert.equal(setup(lateFailure.path,[],'late-failed-upgrade'),3);assert.deepEqual(registration(),beforeRollback);
 assert.equal(hash(await readFile(executable)),hash(await readFile(oldBinary)));assert.equal(hash(await readFile(join(install,'uninstall.exe'))),oldUninstaller);assert.equal(hash(await readFile(shortcut)),oldShortcut);
 pass('failure after shortcut and registration writes restores the original executable, uninstall entry and metadata');
 const lockedRunner=join(work,'locked-uninstall.exe');await copyFile(join(install,'uninstall.exe'),lockedRunner);await standardWindowsArtifact(lockedRunner);
 const locked=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',String.raw`$f=[System.IO.File]::Open($env:XWX_SETUP_LOCK,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::None);[Console]::Out.WriteLine('locked');[Console]::ReadLine()|Out-Null;$f.Dispose()`],{env:{...process.env,XWX_SETUP_LOCK:join(install,'uninstall.exe')},windowsHide:true,stdio:['pipe','pipe','pipe']});
 try{await once(locked.stdout,'data');assert.equal(spawnSync(lockedRunner,['/S','_?='+install],{windowsVerbatimArguments:true,windowsHide:true,timeout:60000,stdio:'ignore'}).status,3);assert.deepEqual(registration(),beforeRollback);assert.equal(hash(await readFile(executable)),hash(await readFile(oldBinary)));}
 finally{const ended=once(locked,'exit');locked.stdin.end('\n');await ended;}
 await access(join(install,'uninstall.exe'));pass('failed uninstall keeps the working application and original uninstall recovery entry');
 assert.equal(setup(artifacts.new.path,['/D='+join(work,'must-not-relocate')],'manual-upgrade'),0);
 assert.equal(registration().Path,install);assert.equal(registration().Version,newVersion);assert.equal(hash(await readFile(executable)),hash(await readFile(newBinary)));
 await assert.rejects(access(join(work,'must-not-relocate','XwX Deck.exe')));
 pass('manual E-drive upgrade retains the registered path, ignoring a conflicting destination');
 await unlink(executable);assert.equal(setup(artifacts.new.path,[],'repair-missing-file'),0);assert.equal(hash(await readFile(executable)),hash(await readFile(newBinary)));
 assert.equal(hash(await readFile(join(data,'settings.json'))),settingsBefore);assert.equal(hash(await readFile(traceFile)),traceBefore);
 pass('same-version repair restores missing files and retains configuration and Trace');
 assert.equal(await uninstall('reset-update-fixture'),0);assert.equal(setup(artifacts.old.path,['/D='+install],'restore-old'),0);
 let installerPath,finishedPid;
 await rpcSession(executable,async(rpc,child)=>{finishedPid=child.pid;assert.equal((await rpc('checkForAutomaticUpdates')).status,'available');await rpc('downloadAutomaticUpdate');await wait(async()=>{const s=await rpc('getUpdateState');if(s.status==='error')throw Error(s.error);if(s.status==='ready'){installerPath=s.downloadPath;return true;}return false;},'Setup download failed');assert.ok(installerPath.endsWith('-setup.exe'));const bytes=await readFile(installerPath);await writeFile(installerPath,'modified fixture');await assert.rejects(rpc('restartAndInstall'),/已被修改/);await writeFile(installerPath,bytes);});
 pass('automatic update selects Setup over portable EXE and rejects modified bytes');
 const helper=join(data,'updates/xwx-setup-update-failure.exe');await copyFile(executable,helper);await standardWindowsArtifact(helper);
 const recoveryLog=await open(join(work,'recovery-startup.log'),'a');
 const child=spawn(helper,['--install-setup-update',installerPath,'--replace-executable',executable,'--expected-sha256','0'.repeat(64),'--expected-version',newVersion,'--parent-pid',String(finishedPid),'--pilot-root',data,'--smoke-setup-restart'],{windowsHide:true,stdio:['ignore',recoveryLog.fd,recoveryLog.fd]});
 assert.equal((await once(child,'exit'))[0],1);const failure=JSON.parse(await readFile(helper.replace(/\.exe$/,'.result.json'),'utf8'));assert.equal(failure.status,'error');assert.ok(failure.recoveryPid);
 try {
  await wait(async()=>{try{const r=JSON.parse(await readFile(join(data,'native-smoke.json'),'utf8'));assert.ok(r.passed,r.error);return r.stage==='restarted'&&r.version===oldVersion;}catch(e){if(e.code==='ENOENT')return false;throw e;}},'Old app recovery did not render');
 }catch(error){
  const state=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p=Get-Process -Id ${failure.recoveryPid} -ErrorAction SilentlyContinue; if($p){@{id=$p.Id;handle=$p.MainWindowHandle.ToInt64();title=$p.MainWindowTitle;session=$p.SessionId}|ConvertTo-Json -Compress}`],{encoding:'utf8',windowsHide:true,timeout:30000});
  await writeFile(join(work,'recovery-diagnostics.json'),JSON.stringify({failure,process:state.stdout,processError:state.stderr,rootFiles:await readdir(data),startup:await readFile(join(work,'recovery-startup.log'),'utf8')},null,2)+'\n');
  console.error(await readFile(join(work,'recovery-diagnostics.json'),'utf8'));throw error;
 }finally{await recoveryLog.close();}
 await wait(()=>!spawnSync('tasklist.exe',['/FI','PID eq '+failure.recoveryPid,'/FO','CSV','/NH'],{encoding:'utf8',windowsHide:true}).stdout.includes('"'+failure.recoveryPid+'"'),'Recovered test app did not exit');
 pass('detached update helper rejects tampering and renders the unchanged old application again');
 ui=spawn(executable,['--pilot-root',data,'--smoke','--smoke-setup-update','--smoke-setup-restart'],{windowsHide:true,env:{...process.env,XWX_DECK_UPDATE_SERVER_URL:base,XWX_SYSTEM_LANGUAGE_TEST:'zh-CN'},stdio:'ignore'});
 await wait(async()=>{try{const r=JSON.parse(await readFile(join(data,'native-smoke.json'),'utf8'));if(!r.passed)throw Error(r.error);return r.stage==='downloaded';}catch(e){if(e.code==='ENOENT')return false;throw e;}},'Rendered updater did not download');
 await wait(()=>ui.exitCode!==null,'Old app did not exit');assert.equal(ui.exitCode,0);
 await wait(async()=>{try{const r=JSON.parse(await readFile(join(data,'native-smoke.json'),'utf8'));if(!r.passed)throw Error(r.error);return r.stage==='restarted'&&r.version===newVersion;}catch(e){if(e.code==='ENOENT')return false;throw e;}},'Updated app did not render');
 const reports=await Promise.all((await readdir(join(data,'updates'))).filter(n=>n.endsWith('.result.json')).map(async n=>JSON.parse(await readFile(join(data,'updates',n),'utf8'))));const installed=reports.find(r=>r.status==='installed');assert.ok(installed);
 await wait(()=>!spawnSync('tasklist.exe',['/FI','PID eq '+installed.restartPid,'/FO','CSV','/NH'],{encoding:'utf8',windowsHide:true}).stdout.includes('"'+installed.restartPid+'"'),'Updated test app did not exit');
 assert.equal(registration().Version,newVersion);assert.equal(hash(await readFile(executable)),hash(await readFile(newBinary)));
 pass('actual local Setup download upgrades the installed app and renders the new executable at the same data root');
 await rpcSession(executable,async rpc=>{assert.deepEqual(await rpc('getProviders'),providersBefore);const s=await rpc('toggleTracing',true);const response=await fetch(s.localBaseUrl+'/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'fixture-model',input:'Synthetic post-upgrade request'})});assert.equal(response.status,200);await response.json();await rpc('toggleTracing',false);});
 pass('retained provider performs an actual authenticated local request after update');
 assert.equal(setup(uninstallFailure.path,[],'prepare-uninstall-recovery'),0);
 const beforeUninstallFailure=registration(),recoveryUninstaller=hash(await readFile(join(install,'uninstall.exe'))),recoveryShortcut=hash(await readFile(shortcut));
 assert.equal(await uninstall('failure-after-metadata-removal'),3);
 assert.deepEqual(registration(),beforeUninstallFailure);assert.equal(hash(await readFile(executable)),hash(await readFile(newBinary)));assert.equal(hash(await readFile(join(install,'uninstall.exe'))),recoveryUninstaller);assert.equal(hash(await readFile(shortcut)),recoveryShortcut);
 await rpcSession(executable,async rpc=>{assert.equal((await rpc('getUpdateState')).portable,false);});
 assert.equal(setup(artifacts.new.path,[],'repair-uninstall-recovery'),0);
 pass('uninstall failure after registration deletion restores the app, exact uninstall entry, shortcut and working registered recovery');
 const retained=join(install,'keep.txt');await writeFile(retained,'user-owned fixture');
 assert.equal(await uninstall('uninstall-new'),0);assert.equal(registration(),null);await assert.rejects(access(executable));if(previousShortcut)assert.deepEqual(await readFile(shortcut),previousShortcut);else await assert.rejects(access(shortcut));assert.equal(await readFile(retained,'utf8'),'user-owned fixture');
 assert.equal(hash(await readFile(join(data,'settings.json'))),settingsBefore);assert.equal(hash(await readFile(traceFile)),traceBefore);
 pass('uninstall removes owned application files and registration, retaining user files, configuration and Trace');
 assert.equal(setup(artifacts.new.path,['/D='+install],'reinstall'),0);await rpcSession(executable,async rpc=>{assert.deepEqual(await rpc('getProviders'),providersBefore);});assert.equal(await uninstall('uninstall-reinstalled'),0);
 pass('reinstallation restores the retained choices and a second uninstall succeeds');
 await writeFile(join(work,'summary.json'),JSON.stringify({passed:true,checks,artifacts,modelRequests,work,binarySha256:hash(await readFile(newBinary)),scope:'isolated per-user system and work-drive installation, recovery, repair, native rendered update, uninstall and retention; loopback requests; no MSI engine'},null,2)+'\n');console.log(JSON.stringify({passed:true,checks:checks.length,work}));
}catch(error){await writeFile(join(work,'summary.json'),JSON.stringify({passed:false,checks,work,error:String(error)},null,2)+'\n');throw error;}
finally {
 if(ui?.exitCode===null){const ended=once(ui,'exit');ui.kill();await ended;}
 const current=registration();if(current&&[install,cInstall].includes(current.Path)){assert.equal(setup(artifacts.new.path,[],'cleanup-repair'),0,'Owned Setup recovery failed');const code=await uninstall('cleanup-owned-installation');assert.equal(code,0,'Owned Setup cleanup failed');}
 if(!previousShortcut&&!registration()&&(await readFile(shortcut).catch(()=>null))?.equals(foreignShortcutMarker))await unlink(shortcut);
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
