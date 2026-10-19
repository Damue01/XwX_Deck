// Diagnostic copy only. Never modify or replace the frozen release executable.
import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {rustToolchain} from './toolchain.mjs';
assert.equal(process.platform,'win32');assert.equal(process.env.GITHUB_ACTIONS,'true');
const root=process.cwd(),original=resolve(process.env.XWX_NATIVE_TEST_BINARY),report={diagnosticOnly:true,originalSha256:createHash('sha256').update(await readFile(original)).digest('hex'),runs:[]};
const temporary=await realpath(tmpdir());
async function probe(binary,args,label,extra={}){
  const home=await mkdtemp(join(temporary,'xwx-window-probe-'));
  const data=join(home,'deck-data');await mkdir(data);
  await writeFile(join(data,'.xwx-rust-pilot'),'isolated-rust-pilot-v1\n');
  const env={...process.env,HOME:home,USERPROFILE:home,APPDATA:join(home,'roaming'),LOCALAPPDATA:join(home,'local'),XWX_DECK_UPDATE_SERVER_URL:'http://127.0.0.1:1',HTTP_PROXY:'http://127.0.0.1:1',HTTPS_PROXY:'http://127.0.0.1:1',ALL_PROXY:'http://127.0.0.1:1',XWX_CLIENT_INSTALLATIONS_TEST_HOME:home,...extra};
  await mkdir(env.APPDATA,{recursive:true});await mkdir(env.LOCALAPPDATA,{recursive:true});
  const child=spawn(binary,args(data),{env,stdio:['ignore','pipe','pipe'],windowsHide:false});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const ended=once(child,'exit');await Promise.race([ended,new Promise(r=>setTimeout(r,10000))]);
  let window;
  if(child.exitCode===null){
    const state=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p=Get-Process -Id ${child.pid}; @{id=$p.Id;handle=$p.MainWindowHandle.ToInt64();title=$p.MainWindowTitle;session=$p.SessionId}|ConvertTo-Json -Compress`],{encoding:'utf8',timeout:30000});
    window={status:state.status,stdout:state.stdout,stderr:state.stderr};child.kill();await ended;
  }
  const result={label,stdout,stderr,window,exitCode:child.exitCode,signal:child.signalCode,home,data};report.runs.push(result);console.log(JSON.stringify(result));
  await writeFile('test-results/windows-window-probe.json',JSON.stringify(report,null,2)+'\n');
}
await probe(original,home=>['--data-root',home],'original executable, ordinary window, disposable app data');
const profile=await mkdtemp(join(temporary,'xwx-browser-probe-'));
await probe(original,home=>['--pilot-root',home,'--smoke','--smoke-provider-switch','--smoke-physical','--smoke-upstream','http://127.0.0.1:1'],'original executable, isolated window, separate disposable browser profile',{WEBVIEW2_USER_DATA_FOLDER:profile});
const fixture=await mkdtemp(join(root,'test-results/window-probe-source-'));
for(const path of ['src-native','src/shared','tools/native','assets','test-results/native-assets','test-results/native-frontend'])await cp(join(root,path),join(fixture,path),{recursive:true});
const file=join(fixture,'src-native/src/isolated_webview.rs');let source=await readFile(file,'utf8');
assert.ok(source.includes('.map_err(|_| "无法创建隔离窗口")?'));
source=source.replace('.map_err(|_| "无法创建隔离窗口")?','.map_err(|error| format!("无法创建隔离窗口: {error:?}"))?');await writeFile(file,source);
const {cargo,env}=rustToolchain(root);env.TAURI_CONFIG=JSON.stringify({app:{windows:[{label:'main',title:'XwX Deck',width:1040,height:560,minWidth:780,minHeight:480,decorations:false,backgroundColor:'#f5f5f7'}]}});
// This copy never ships. Reuse the unit-test debug dependencies; the frozen
// release binary retains its original path remapping and exact bytes.
delete env.CARGO_ENCODED_RUSTFLAGS;delete env.RUSTFLAGS;
const built=spawn(cargo,['build','--locked','--features','manual-acceptance','--manifest-path',join(fixture,'src-native/Cargo.toml')],{env,stdio:'inherit'});assert.equal((await once(built,'exit'))[0],0);
await probe(resolve(env.CARGO_TARGET_DIR,'debug/xwx-deck-native.exe'),home=>['--pilot-root',home,'--smoke','--smoke-provider-switch','--smoke-physical','--smoke-upstream','http://127.0.0.1:1'],'diagnostic copy, isolated window with original initialization error');
assert.equal(createHash('sha256').update(await readFile(original)).digest('hex'),report.originalSha256);
