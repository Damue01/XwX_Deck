// Explicit per-user Setup acceptance. Never replace a pre-existing installation.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
function forgetOwnedRegistration(path) {
 assert.equal(registration()?.Path,path);assert.ok([install,cInstall].includes(path));
 const script=String.raw`$p=Get-ItemProperty -LiteralPath 'HKCU:\Software\XwX Deck\Installation';if($p.Path -ne $env:XWX_SETUP_OWNED_PATH -or $p.AppId -ne 'app.xwxdeck.desktop' -or $p.InstallerType -ne 'nsis-v1'){throw 'Unrelated installation'};Remove-Item -LiteralPath 'HKCU:\Software\XwX Deck\Installation';Remove-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\XwX Deck'`;
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,XWX_SETUP_OWNED_PATH:path},encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);assert.equal(registration(),null);
}
async function legacyMsi() {
 const wix=join(repo,'test-results/wix314'),archive=join(repo,'test-results/wix314-binaries.zip');
 const expected='6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31';
 if(!existsSync(archive)){
  const response=await fetch('https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip');assert.ok(response.ok);
  const bytes=Buffer.from(await response.arrayBuffer());assert.equal(hash(bytes),expected);await writeFile(archive,bytes);
 }
 assert.equal(hash(await readFile(archive)),expected);
 if(!existsSync(join(wix,'light.exe'))){
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Expand-Archive -LiteralPath $env:XWX_TEST_WIX_ARCHIVE -DestinationPath $env:XWX_TEST_WIX_DIRECTORY -Force'],{env:{...process.env,XWX_TEST_WIX_ARCHIVE:archive,XWX_TEST_WIX_DIRECTORY:wix},windowsHide:true,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 }
 const product='{'+randomUUID().toUpperCase()+'}',upgrade='{'+randomUUID().toUpperCase()+'}',component='{'+randomUUID().toUpperCase()+'}';
 const xml=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
 const source=join(work,'legacy.wxs'),object=join(work,'legacy.wixobj'),msi=join(work,'legacy.msi');
 // Real per-user MSI with the historical registration schema; no custom uninstall action.
 await writeFile(source,`<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi"><Product Id="${product}" Name="XwX Deck" Language="1033" Version="0.9.9" Manufacturer="XwX Deck" UpgradeCode="${upgrade}">
 <Package InstallerVersion="500" Compressed="yes" InstallScope="perUser" InstallPrivileges="limited" Platform="x64"/><MediaTemplate EmbedCab="yes"/>
 <SetProperty Id="ARPINSTALLLOCATION" Value="[INSTALLDIR]" After="CostFinalize"/>
 <Directory Id="TARGETDIR" Name="SourceDir"><Directory Id="LocalAppDataFolder"><Directory Id="INSTALLDIR" Name="Deck Legacy Fixture">
 <Component Id="Application" Guid="${component}" Win64="yes"><File Id="Executable" Name="XwX Deck.exe" Source="${xml(oldBinary)}"/><RemoveFolder Id="EmptyInstallDirectory" On="uninstall"/>
 <RegistryKey Root="HKCU" Key="Software\\XwX Deck\\Installation"><RegistryValue Name="Path" Value="[INSTALLDIR]" Type="string" KeyPath="yes"/><RegistryValue Name="ProductCode" Value="[ProductCode]" Type="string"/><RegistryValue Name="UpgradeCode" Value="${upgrade}" Type="string"/><RegistryValue Name="Version" Value="[ProductVersion]" Type="string"/></RegistryKey>
 </Component></Directory></Directory></Directory><Feature Id="Main" Level="1"><ComponentRef Id="Application"/></Feature></Product></Wix>`);
 for(const[tool,args]of[['candle.exe',['-nologo','-arch','x64','-out',object,source]],['light.exe',['-nologo','-out',msi,object]]]){
  const result=spawnSync(join(wix,tool),args,{encoding:'utf8',windowsHide:true});await writeFile(join(work,tool+'-legacy.log'),result.stdout+result.stderr);assert.equal(result.status,0,result.stdout+result.stderr);
 }
 const permissions=spawnSync('icacls.exe',[msi,'/grant','*S-1-5-18:(R)'],{encoding:'utf8',windowsHide:true});assert.equal(permissions.status,0,permissions.stderr);
 return {product,msi};
}
function windowsInstaller(args){
 const command=args.map(value=>value.startsWith('INSTALLDIR=')?'INSTALLDIR="'+value.slice(11)+'"':/\s/.test(value)?'"'+value+'"':value);
 const result=spawnSync(join(process.env.WINDIR,'System32/msiexec.exe'),command,{windowsVerbatimArguments:true,windowsHide:true,timeout:60000,stdio:'ignore'});if(result.error)throw result.error;return result.status;
}
function legacyRegistration(product,remove=false){
 const script=remove
  ?"$p=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\XwX Deck\\Installation' -ErrorAction SilentlyContinue;if($p.ProductCode -eq $env:XWX_TEST_MSI_PRODUCT -and $p.Path.TrimEnd('\\') -eq $env:XWX_TEST_MSI_PATH){Remove-Item -LiteralPath 'HKCU:\\Software\\XwX Deck\\Installation'}"
  :"$p=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\XwX Deck\\Installation' -ErrorAction SilentlyContinue;if($p){if($p.ProductCode -ne $env:XWX_TEST_MSI_PRODUCT -or $p.Path.TrimEnd('\\') -ne $env:XWX_TEST_MSI_PATH){throw 'Unrelated installation'}}else{New-Item -Path 'HKCU:\\Software\\XwX Deck\\Installation' -Force|Out-Null;Set-ItemProperty -LiteralPath 'HKCU:\\Software\\XwX Deck\\Installation' -Name Path -Value $env:XWX_TEST_MSI_PATH;Set-ItemProperty -LiteralPath 'HKCU:\\Software\\XwX Deck\\Installation' -Name ProductCode -Value $env:XWX_TEST_MSI_PRODUCT;Set-ItemProperty -LiteralPath 'HKCU:\\Software\\XwX Deck\\Installation' -Name Version -Value '0.9.9'}";
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script+'; exit 0'],{env:{...process.env,XWX_TEST_MSI_PRODUCT:product,XWX_TEST_MSI_PATH:cInstall},windowsHide:true,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
}
async function rpcSession(binary,task,options={}) {
 const child=spawn(binary,(options.args??['--rpc','--pilot-root',data]),{windowsHide:true,env:{...process.env,...options.env,XWX_DECK_UPDATE_SERVER_URL:base},stdio:['pipe','pipe','pipe']});
 const queue=[];let errors='';createInterface({input:child.stdout}).on('line',line=>queue.shift()?.(JSON.parse(line)));child.stderr.on('data',d=>errors+=d);
 child.once('exit',code=>{while(queue.length)queue.shift()({ok:false,error:errors||'RPC process exited: '+code});});
 const rpc=(method,...args)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('RPC timeout '+method+' '+errors)),25000);queue.push(value=>{clearTimeout(timer);value.ok?resolve(value.result):reject(Error(value.error));});child.stdin.write(JSON.stringify({method,args})+'\n');});
 try{return await task(rpc,child);}finally{if(child.exitCode===null){const exited=once(child,'exit');child.stdin.end();const [code]=await exited;assert.equal(code,0,errors);}}
}
let artifacts,modelRequests=0,legacyFixture;
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
 legacyFixture=await legacyMsi();
 assert.equal(windowsInstaller(['/i',legacyFixture.msi,'/qn','/norestart','INSTALLDIR='+cInstall,'/l*v',join(work,'legacy-install.log')]),0);
 // Explicit historical HKCU input fixture; the guard independently verifies the real MSI registration.
 legacyRegistration(legacyFixture.product);
 assert.equal(registration().InstallerType,null);assert.equal(hash(await readFile(join(cInstall,'XwX Deck.exe'))),hash(await readFile(oldBinary)));
 const legacyNote=join(data,'legacy-retained.txt');await writeFile(legacyNote,'synthetic retained configuration');
 const blocker=join(cInstall,'.xwx-deck-old.exe');await writeFile(blocker,'foreign recovery bytes');
 assert.equal(setup(artifacts.new.path,[],'legacy-staging-conflict'),2);assert.equal(registration().InstallerType,null);assert.equal(await readFile(blocker,'utf8'),'foreign recovery bytes');await unlink(blocker);
 assert.equal(setup(artifacts.new.path,[],'legacy-msi-upgrade'),0);assert.equal(registration().InstallerType,'nsis-v1');assert.equal(registration().Path,cInstall);assert.equal(hash(await readFile(join(cInstall,'XwX Deck.exe'))),hash(await readFile(newBinary)));assert.equal(await readFile(legacyNote,'utf8'),'synthetic retained configuration');
 assert.equal(windowsInstaller(['/x',legacyFixture.product,'/qn','/norestart']),1605,'the old MSI must already be removed, not left to remove the new executable later');
 assert.equal(await uninstall('legacy-upgraded-uninstall'),0);assert.equal(registration(),null);legacyFixture=null;
 pass('a real legacy per-user MSI upgrades in place to Setup without manual path discovery; recovery conflicts retain the old MSI and data');
 const unrelatedShortcut=previousShortcut||foreignShortcutMarker;
 if(!previousShortcut)await writeFile(shortcut,unrelatedShortcut);
 assert.equal(setup(artifacts.new.path,['/D='+cInstall],'c-drive-install'),0);
 assert.deepEqual(await readFile(shortcut),unrelatedShortcut,'installation preserves an unrelated named shortcut');
 assert.equal(registration().Path,cInstall);assert.equal(hash(await readFile(join(cInstall,'XwX Deck.exe'))),hash(await readFile(newBinary)));
 assert.equal(await uninstall('c-drive-uninstall'),0);assert.equal(registration(),null);
 assert.deepEqual(await readFile(shortcut),unrelatedShortcut,'uninstall preserves an unrelated named shortcut');
 if(!previousShortcut)await unlink(shortcut);
 pass('per-user Setup installs exact files in a Unicode C-drive path and uninstalls without Windows Installer');
 const foreign=join(work,'同名 其他程序');await mkdir(foreign);
 for(const name of ['XwX Deck.exe','uninstall.exe']){
  const file=join(foreign,name);await writeFile(file,'foreign executable bytes');
  assert.equal(setup(artifacts.new.path,['/D='+foreign],'foreign-'+name),2);
  assert.equal(await readFile(file,'utf8'),'foreign executable bytes');assert.equal(registration(),null);
  const log=new TextDecoder('gb18030').decode(await readFile(join(work,'foreign-'+name+'.log')));
  assert.ok(log.includes('无法确认')&&log.includes(name));assert.ok(!log.includes('仍在运行'));
  await unlink(file);
 }
 pass('unrelated same-name applications and uninstallers are retained with a precise ownership error');
 assert.equal(setup(artifacts.old.path,['/D='+cInstall],'orphan-old-install'),0);
 const orphanApp=hash(await readFile(join(cInstall,'XwX Deck.exe'))),orphanUninstall=hash(await readFile(join(cInstall,'uninstall.exe')));
 const orphanData=join(cInstall,'retained-user-data.txt');await writeFile(orphanData,'orphan fixture data');forgetOwnedRegistration(cInstall);
 await rpcSession(join(cInstall,'XwX Deck.exe'),async()=>{
  assert.equal(setup(artifacts.new.path,['/D='+cInstall],'orphan-running'),2);assert.equal(registration(),null);assert.equal(hash(await readFile(join(cInstall,'XwX Deck.exe'))),orphanApp);
  const log=new TextDecoder('gb18030').decode(await readFile(join(work,'orphan-running.log')));assert.ok(log.includes('仍在运行'));assert.ok(!log.includes('无法确认'));
 });
 pass('a running unregistered old app is retained with a precise exit-and-retry message');
 assert.equal(setup(lateFailure.path,['/D='+cInstall],'orphan-failed-repair'),3);
 assert.equal(registration(),null);assert.equal(hash(await readFile(join(cInstall,'XwX Deck.exe'))),orphanApp);assert.equal(hash(await readFile(join(cInstall,'uninstall.exe'))),orphanUninstall);assert.equal(await readFile(orphanData,'utf8'),'orphan fixture data');
 pass('repairing lost registration rolls back exact original files and leaves registration absent on injected failure');
 assert.equal(setup(artifacts.new.path,['/D='+cInstall],'orphan-repair'),0);
 assert.equal(registration().Path,cInstall);assert.equal(registration().InstallerType,'nsis-v1');assert.equal(hash(await readFile(join(cInstall,'XwX Deck.exe'))),hash(await readFile(newBinary)));assert.equal(await readFile(orphanData,'utf8'),'orphan fixture data');
 forgetOwnedRegistration(cInstall);await unlink(join(cInstall,'XwX Deck.exe'));
 assert.equal(setup(artifacts.new.path,['/D='+cInstall],'orphan-missing-executable'),0);assert.equal(registration().Path,cInstall);assert.equal(hash(await readFile(join(cInstall,'XwX Deck.exe'))),hash(await readFile(newBinary)));
 pass('a verified orphan uninstaller permits repair when the application executable is missing');
 assert.equal(await uninstall('orphan-repaired-uninstall'),0);assert.equal(registration(),null);assert.equal(await readFile(orphanData,'utf8'),'orphan fixture data');
 pass('verified old files without installation registration upgrade in place and regain working uninstall ownership while retaining user files');
 await rpcSession(newBinary,async rpc=>{
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
 await rpcSession(executable,async(rpc,child)=>{finishedPid=child.pid;assert.equal((await rpc('checkForAutomaticUpdates')).status,'available');await rpc('downloadAutomaticUpdate');await wait(async()=>{const s=await rpc('getUpdateState');if(s.status==='error')throw Error(s.error);if(s.status==='ready'){installerPath=s.downloadPath;return true;}return false;},'Setup download failed');assert.ok(installerPath.endsWith('-setup.exe'));const bytes=await readFile(installerPath);assert.equal(hash(bytes),artifacts.new.sha256,'updates must use the current isolated candidate');await writeFile(installerPath,'modified fixture');await assert.rejects(rpc('restartAndInstall'),/已被修改/);await writeFile(installerPath,bytes);});
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
 const policyHome=await mkdtemp(join(process.env.LOCALAPPDATA,'Deck-storage-acceptance-'));
 assert.notEqual(policyHome.slice(0,2).toLowerCase(),install.slice(0,2).toLowerCase(),'Storage policy acceptance requires different source and installation volumes');
 await writeFile(join(work,'storage-policy-fixture.json'),JSON.stringify({profileHome:policyHome,installation:install},null,2)+'\n');
 const policyEnv={APPDATA:join(policyHome,'appdata'),HOME:policyHome,USERPROFILE:policyHome,CODEX_HOME:join(policyHome,'codex'),CLAUDE_CONFIG_DIR:join(policyHome,'claude')};
 for(const path of Object.values(policyEnv))await mkdir(path,{recursive:true});
 const normalOptions={args:['--acceptance-rpc'],env:policyEnv};
 const bulkFile=join(install,'XwXTrace/traces/policy-fixture.bin');
 await rpcSession(executable,async rpc=>{
  const before=await rpc('getState');assert.ok(before.traceRoot.startsWith(policyHome));assert.ok(before.logRoot.startsWith(policyHome));
  await writeFile(join(before.traceRoot,'policy-fixture.bin'),'verified cross-volume storage fixture');
  await writeFile(join(before.logRoot,'policy-fixture.log'),'verified runtime log');
  const plan=await rpc('inspectStorageMigration');assert.equal(plan.destination,join(install,'XwXTrace'));
  const state=await rpc('migrateStorage');assert.equal(state.traceRoot,join(install,'XwXTrace/traces'));assert.equal(state.logRoot,join(install,'XwXTrace/logs'));assert.equal(state.migrationProgress.at(-1).percent,100);
  assert.equal(await readFile(bulkFile,'utf8'),'verified cross-volume storage fixture');await assert.rejects(access(join(before.traceRoot,'policy-fixture.bin')));
 },normalOptions);
 await rpcSession(executable,async rpc=>{assert.equal((await rpc('getState')).traceRoot,join(install,'XwXTrace/traces'));assert.equal(await rpc('inspectStorageMigration'),null);},normalOptions);
 pass('registered installation migrates an isolated normal profile across volumes into XwXTrace and reopens without another migration');
 const retained=join(install,'keep.txt');await writeFile(retained,'user-owned fixture');
 assert.equal(await uninstall('uninstall-new'),0);assert.equal(registration(),null);await assert.rejects(access(executable));if(previousShortcut)assert.deepEqual(await readFile(shortcut),previousShortcut);else await assert.rejects(access(shortcut));assert.equal(await readFile(retained,'utf8'),'user-owned fixture');
 assert.equal(hash(await readFile(join(data,'settings.json'))),settingsBefore);assert.equal(hash(await readFile(traceFile)),traceBefore);
 pass('uninstall removes owned application files and registration, retaining user files, configuration and Trace');
 assert.equal(await readFile(bulkFile,'utf8'),'verified cross-volume storage fixture');assert.equal(await readFile(join(install,'XwXTrace/logs/policy-fixture.log'),'utf8'),'verified runtime log');
 pass('uninstall preserves the installation XwXTrace folder and all migrated bulk bytes');
 assert.equal(setup(artifacts.new.path,['/D='+install],'reinstall'),0);await rpcSession(executable,async rpc=>{assert.deepEqual(await rpc('getProviders'),providersBefore);});assert.equal(await uninstall('uninstall-reinstalled'),0);
 pass('reinstallation restores the retained choices and a second uninstall succeeds');
 await writeFile(join(work,'summary.json'),JSON.stringify({passed:true,checks,artifacts,modelRequests,work,binarySha256:hash(await readFile(newBinary)),scope:'isolated real per-user MSI migration, Setup system and work-drive installation, recovery, repair, native rendered update, uninstall and retention; loopback requests'},null,2)+'\n');console.log(JSON.stringify({passed:true,checks:checks.length,work}));
}catch(error){await writeFile(join(work,'summary.json'),JSON.stringify({passed:false,checks,work,error:String(error)},null,2)+'\n');throw error;}
finally {
 if(ui?.exitCode===null){const ended=once(ui,'exit');ui.kill();await ended;}
 if(legacyFixture){const code=windowsInstaller(['/x',legacyFixture.product,'/qn','/norestart']);assert.ok([0,1605].includes(code));legacyRegistration(legacyFixture.product,true);}
 const current=registration();if(current&&[install,cInstall].includes(current.Path)){assert.equal(setup(artifacts.new.path,[],'cleanup-repair'),0,'Owned Setup recovery failed');const code=await uninstall('cleanup-owned-installation');assert.equal(code,0,'Owned Setup cleanup failed');}
 if(!previousShortcut&&!registration()&&(await readFile(shortcut).catch(()=>null))?.equals(foreignShortcutMarker))await unlink(shortcut);
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
