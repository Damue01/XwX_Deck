import assert from 'node:assert/strict';
import {readFile,writeFile,copyFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildWindowsSetup} from './windows-nsis.mjs';
import {standardWindowsArtifact} from './windows-execution-level.mjs';
import {assertPublicBinary} from './public-binary-boundary.mjs';
import {sourceFingerprint} from './source-fingerprint.mjs';

assert.equal(process.platform,'win32');
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const root=process.cwd(),original=await read('build-evidence/release/native-build-report.json');
const previous=await read('build-evidence/test-results/native-backend-summary.json');
const failed=previous.results.filter(result=>result.code!==0||result.error);
assert.match(original.commit,/^[a-f0-9]{40}$/);assert.ok(!previous.cleanupError);
assert.equal(original.dirty,false);assert.equal(original.version,JSON.parse(await readFile('package.json')).version);
assert.equal(previous.binarySha256,original.candidate.binarySha256);
assert.equal(failed.length,1);assert.equal(failed[0].suite,'credential-private-files-test.mjs');
assert.ok(previous.results.every(result=>result.code===0||result===failed[0]));
// Recovery may alter independent test drivers, never any compiled source,
// embedded smoke scripts, resources or installer implementation.
execFileSync('git',['diff','--exit-code',original.commit,'HEAD','--','src','src-native','assets','package.json','package-lock.json','release-contract.json','tools/build',':(glob)tools/native/*.js','tools/native/windows-nsis.mjs','tools/native/windows-setup.nsi','tools/native/windows-setup-skin.cpp','tools/native/windows-execution-level.mjs'],{stdio:'inherit'});
if(process.argv.includes('--aggregate')){
  const report=await read('release/native-build-report.json'),rounds=[];
  for(let round=1;round<=3;round++){
    const result=await read(`test-results/private-files-round-${round}.json`);
    assert.equal(result.binarySha256,previous.binarySha256);assert.equal(result.passed,true);
    assert.equal(result.results.length,1);assert.equal(result.results[0].suite,failed[0].suite);
    assert.equal(result.results[0].code,0);rounds.push(result);
  }
  assert.equal(report.candidate.binarySha256,previous.binarySha256);
  const results=previous.results.map(result=>result.suite===failed[0].suite?{...rounds.at(-1).results[0],priorFailure:result,recoveryRounds:3}:result);
  await writeFile('test-results/native-backend-aggregate.json',JSON.stringify({passed:true,binarySha256:previous.binarySha256,priorRun:process.env.XWX_PRIOR_NATIVE_RUN,priorFullRunPassed:false,method:'Identical executable; retain successful full-run suites and resolve its sole failed ACL inspection with three successful repetitions',results,rounds},null,2)+'\n');
  process.exit(0);
}
const cached=resolve('test-results/native-target/release/xwx-deck-native.exe');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(await readFile(cached)),original.candidate.binarySha256,'Cached executable differs from the previously tested exact binary');
await assertPublicBinary(cached,root);await mkdir('release',{recursive:true});
const binary=resolve('release/XwX Deck.exe');await copyFile(cached,binary);await standardWindowsArtifact(binary);
const installer=await buildWindowsSetup({root,binary,output:resolve('release/XwX Deck Setup.exe'),version:original.version});
const packagingCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const report={...original,candidate:{...original.candidate,binary},installer,reusedNativeBinary:true,packagedAt:new Date().toISOString(),packagingCommit,packagingSourceFingerprint:(await sourceFingerprint(root)).sha256,priorNativeRun:process.env.XWX_PRIOR_NATIVE_RUN};
await writeFile('release/native-build-report.json',JSON.stringify(report,null,2)+'\n');
await writeFile('test-results/prior-native-backend-summary.json',JSON.stringify(previous,null,2)+'\n');
console.log(JSON.stringify({binarySha256:report.candidate.binarySha256,installerSha256:installer.sha256,priorFailedSuite:failed[0].suite,productSourcesUnchanged:true}));
