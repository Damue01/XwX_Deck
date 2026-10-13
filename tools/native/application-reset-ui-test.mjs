import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {nativeTestBinary} from './test-support.mjs';
const parent=await mkdtemp(join(await realpath(tmpdir()),'xwxdeck-reset-webview-')),root=join(parent,'data');
const env={...process.env,XWX_DECK_TEST_SECURE_STORE:'1',XWX_SYSTEM_LANGUAGE_TEST:'zh-CN'};
let child,cleanup=false,report,completed=false,failure,nativeStderr='';
try{
  child=spawn(nativeTestBinary,['--rpc','--pilot-root',root],{env});
  const lines=createInterface({input:child.stdout});child.stderr.resume();
  const response=once(lines,'line');child.stdin.write(JSON.stringify({method:'getState',args:[]})+'\n');assert.equal(JSON.parse((await response)[0]).ok,true);
  const ended=once(child,'exit');child.stdin.end();assert.equal((await ended)[0],0);
  await mkdir(join(root,'codex/sessions'),{recursive:true});await writeFile(join(root,'codex/sessions/fixture.jsonl'),'opaque preserved history\n');
  child=spawn(nativeTestBinary,['--pilot-root',root,'--pilot-webview-persistent','--smoke','--smoke-application-reset','--smoke-exit'],{env,stdio:['ignore','ignore','pipe']});
  child.stderr.on('data',bytes=>{nativeStderr=(nativeStderr+bytes).slice(-8192);if(process.env.XWX_DECK_RESET_DIAGNOSTICS==='1')process.stderr.write(bytes);});
  // The first process exits and its independent worker relaunches. Wait for the
  // second process's report, not merely the first successful exit code.
  for(let n=0;n<600;n++){
    report=await readFile(join(root,'native-smoke.json'),'utf8').then(JSON.parse,()=>null);if(report)break;
    const resetState=await readFile(join(root,'application-reset-result.json'),'utf8').then(JSON.parse,()=>null);
    assert.notEqual(resetState?.status,'failed',JSON.stringify(resetState));
    assert.ok(child.exitCode===null||child.exitCode===0,`Native startup failed (${child.exitCode}): ${nativeStderr}`);
    assert.equal(child.signalCode,null,`Native startup terminated (${child.signalCode}): ${nativeStderr}`);
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(report?.passed,true,JSON.stringify(report??{error:'Native reset report timed out',nativeStderr}));
  const reset=JSON.parse(await readFile(join(root,'application-reset-result.json'),'utf8'));assert.equal(reset.status,'completed');
  const before=JSON.parse(await readFile(join(reset.backupPath,'data/native-smoke-progress.json'),'utf8'));assert.ok(before.checks.length>=4);
  assert.equal(await readFile(join(root,'codex/sessions/fixture.jsonl'),'utf8'),'opaque preserved history\n');
  report={...report,checks:[...before.checks,...report.checks,'client history remains byte-identical after full browser reset and automatic relaunch'],binarySha256:createHash('sha256').update(await readFile(nativeTestBinary)).digest('hex'),automaticNativeRelaunch:true};
  completed=true;
}catch(error){failure=error;}finally{
  if(child?.exitCode===null&&child?.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}
  // Smoke report closes the relaunched window asynchronously. Wait for its
  // Pilot lease before starting the store-removal process.
  await new Promise(resolve=>setTimeout(resolve,700));
  if(completed){
  const removal=spawn(nativeTestBinary,['--pilot-root',root,'--pilot-remove-webview-store'],{env});
  let output='';removal.stdout.on('data',data=>{output+=data;});removal.stderr.on('data',data=>{output+=data;});
  const timer=setTimeout(()=>removal.kill('SIGKILL'),20000);
  try{assert.equal((await once(removal,'exit'))[0],0,output);assert.match(output,/isolated WebView store removed/);cleanup=true;}catch(error){failure=error;}finally{clearTimeout(timer);}
  }
  if(completed&&cleanup){
    await writeFile('test-results/native-application-reset-webview-summary.json',JSON.stringify({...report,ownPersistentStoreRemoved:true},null,2)+'\n');
    console.log('PASS actual persistent WebView reset: '+report.checks.length+' checks; independent worker automatically relaunched native app; own store removed');
    await rm(parent,{recursive:true,force:true});
  }else {
    const progress=await readFile(join(root,'native-smoke-progress.json'),'utf8').then(JSON.parse,()=>null);
    await mkdir('test-results',{recursive:true});
    await writeFile('test-results/native-application-reset-webview-summary.json',JSON.stringify({passed:false,error:String(failure??'Persistent store cleanup did not complete'),binarySha256:createHash('sha256').update(await readFile(nativeTestBinary)).digest('hex'),progress,retainedFixtures:parent,ownPersistentStoreRemoved:cleanup},null,2)+'\n');
    console.error('Synthetic WebView reset recovery retained at '+parent);
  }
}
if(failure)throw failure;
