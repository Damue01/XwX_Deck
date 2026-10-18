// Conditional native UI acceptance: five actual processes share one disposable WebView store.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,realpath,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {nativeTestBinary} from './test-support.mjs';
const root=await mkdtemp(join(await realpath(tmpdir()),'xwx-onboarding-restart-'));
const env={...process.env,XWX_SYSTEM_LANGUAGE_TEST:'zh-CN'};
const reports=[];let child,passed=false,removed=false;
try {
  for(const stage of [5,6,7,8,9]) {
    await rm(join(root,'native-smoke.json'),{force:true});
    child=spawn(nativeTestBinary,['--pilot-root',root,'--pilot-webview-persistent','--smoke','--smoke-renderer-restart',String(stage),'--smoke-exit'],{env,stdio:['ignore','ignore','pipe']});
    child.stderr.resume();
    const ended=once(child,'exit');const timer=setTimeout(()=>child.kill(),45000);
    try { assert.equal((await ended)[0],0,'native guide stage '+stage); } finally { clearTimeout(timer); }
    const report=JSON.parse(await readFile(join(root,'native-smoke.json'),'utf8'));
    assert.equal(report.passed,true,JSON.stringify(report));reports.push(report);
    console.log('PASS native onboarding restart stage '+stage);
  }
  passed=true;
} finally {
  if(child?.exitCode===null && child?.signalCode===null){child.kill();await once(child,'exit');}
  const cleanup=spawn(nativeTestBinary,['--pilot-root',root,'--pilot-remove-webview-store'],{env,stdio:['ignore','pipe','pipe']});
  let output='';cleanup.stdout.on('data',b=>output+=b);cleanup.stderr.resume();
  const timer=setTimeout(()=>cleanup.kill(),15000);
  try {removed=(await once(cleanup,'exit'))[0]===0 && output.includes('isolated WebView store removed');} finally {clearTimeout(timer);}
  await writeFile('test-results/native-onboarding-restart-summary.json',JSON.stringify({passed:passed&&removed,isolated:true,nativeProcesses:reports.length,checks:reports.flatMap(r=>r.checks),ownPersistentStoreRemoved:removed,binarySha256:createHash('sha256').update(await readFile(nativeTestBinary)).digest('hex')},null,2)+'\n');
  if(removed) await rm(root,{recursive:true,force:true});
}
assert.ok(passed&&removed,'onboarding restart acceptance and isolated store cleanup must pass');
