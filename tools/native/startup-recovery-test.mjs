import assert from 'node:assert/strict';import{mkdtemp,mkdir,readFile,writeFile,rm}from'node:fs/promises';import{join,resolve}from'node:path';import{spawn}from'node:child_process';import{once}from'node:events';import{createHash}from'node:crypto';import{verifyCandidate,sourceFingerprint}from'./source-fingerprint.mjs';
if(process.platform!=='win32'){console.log('SKIP Windows startup recovery surface');process.exit(0);}
const binary=resolve(process.env.XWX_NATIVE_TEST_BINARY??'test-results/native-package/XwX Deck.exe');
const provenance=process.env.XWX_NATIVE_TEST_BUILD_REPORT?await verifyCandidate({root:resolve('.'),report:JSON.parse(await readFile(process.env.XWX_NATIVE_TEST_BUILD_REPORT,'utf8')),binary,allowManualAcceptance:true}):{sourceFingerprint:(await sourceFingerprint(resolve('.'))).sha256,binarySha256:createHash('sha256').update(await readFile(binary)).digest('hex'),developmentCandidate:true};
await mkdir('test-results/native-ui-temp',{recursive:true});const root=await mkdtemp(resolve('test-results/native-ui-temp/xwx-recovery-'));await writeFile(join(root,'.xwx-rust-pilot'),'isolated-rust-pilot-v1\n');
await writeFile(join(root,'settings.json'),'synthetic original data must remain unchanged');let child,passed=false;
try{
 child=spawn(binary,['--pilot-root',root,'--smoke-recovery',...process.argv.includes('--keep-open')?['--smoke-physical']:[]],{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-8192));const ended=once(child,'exit');let report;
 for(let n=0;n<500;n++){report=await readFile(join(root,'recovery-smoke.json'),'utf8').then(JSON.parse,()=>null);if(report)break;if(child.exitCode!==null)throw Error('Recovery exited before report: '+stderr);await new Promise(r=>setTimeout(r,100));}
 assert.equal(report?.passed,true,JSON.stringify({report,stderr,root}));console.log(JSON.stringify({...report,root,pid:child.pid}));
 if(process.argv.includes('--keep-open'))await ended;else{const timer=setTimeout(()=>child.kill(),10000);try{assert.equal((await ended)[0],2,stderr);}finally{clearTimeout(timer);}}
 assert.equal(await readFile(join(root,'settings.json'),'utf8'),'synthetic original data must remain unchanged');assert.equal(await readFile(join(root,'native-credential-storage.json'),'utf8').then(()=>true,()=>false),false);
 const summary={...report,...provenance,originalDataPreserved:true,noPilotOpened:true,platform:process.platform};await writeFile('test-results/native-startup-recovery-summary.json',JSON.stringify(summary,null,2)+'\n');passed=true;
}finally{if(child?.exitCode===null&&child?.signalCode===null){child.kill();await once(child,'exit');}if(passed)await rm(root,{recursive:true,force:true,maxRetries:30,retryDelay:100});else console.error('Failed recovery fixture retained: '+root);}
