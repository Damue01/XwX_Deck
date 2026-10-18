// Windows-only native popup acceptance; all routes and credentials are synthetic.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {sourceFingerprint,verifyCandidate} from './source-fingerprint.mjs';
if(process.platform!=='win32'){console.log('SKIP Windows application tray popup: Windows native host required');process.exit(0);}
const binary=resolve(process.env.XWX_NATIVE_TEST_BINARY??'test-results/native-package/XwX Deck.exe');
const provenance=process.env.XWX_NATIVE_TEST_BUILD_REPORT
  ?await verifyCandidate({root:resolve('.'),report:JSON.parse(await readFile(process.env.XWX_NATIVE_TEST_BUILD_REPORT,'utf8')),binary,allowManualAcceptance:true})
  :{sourceFingerprint:(await sourceFingerprint(resolve('.'))).sha256,binarySha256:createHash('sha256').update(await readFile(binary)).digest('hex'),developmentCandidate:true};
const temporaryBase=process.platform==='win32'?resolve('test-results/native-ui-temp'):await realpath(tmpdir());
await mkdir(temporaryBase,{recursive:true});
const root=await mkdtemp(join(temporaryBase,'xwx-tray-native-'));
await writeFile(join(root,'.xwx-rust-pilot'),'isolated-rust-pilot-v1\n');
const installations=join(root,'installations');await mkdir(join(installations,'.local/bin'),{recursive:true});
for(const name of['codex','claude'])await writeFile(join(installations,'.local/bin',name+'.cmd'),'isolated installed-client fixture');
let requests=0,child,passed=false;
const upstream=createServer(async(req,res)=>{
 if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end('{"data":[{"id":"pilot-model"}]}');return;}
 for await(const _ of req){}requests++;
 res.writeHead(200,{'content-type':'text/event-stream'});
 res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"tray acceptance"}\n\n');
 res.end('event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:{id:'tray-'+requests,object:'response',status:'completed',model:'pilot-model',output:[],usage:{input_tokens:20,output_tokens:4,total_tokens:24}}})+'\n\n');
});
upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
const base='http://127.0.0.1:'+upstream.address().port+'/v1';
const env={...process.env,XWX_SYSTEM_LANGUAGE_TEST:'zh-CN',XWX_CLIENT_INSTALLATIONS_TEST_HOME:installations};
const keepOpen=process.argv.includes('--keep-open');
try{
 for(const[method,args]of[
  ['saveProvider',[{displayName:'Tray_Fixture',baseUrl:base,bearerToken:'isolated-test-key',adapter:'responses',codexModel:'pilot-model'}]],
  ['switchClientProvider',[{client:'codex',providerId:'Tray_Fixture'}]]
 ]){const result=spawnSync(binary,['--rpc','--pilot-root',root],{input:JSON.stringify({method,args})+'\n',env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout.trim()).ok,true,result.stdout);}
 child=spawn(binary,['--pilot-root',root,'--smoke','--smoke-tray','--smoke-upstream',base,...(keepOpen?['--smoke-physical']:['--smoke-exit'])],{env,stdio:['ignore','ignore','pipe']});
 let stderr='';child.stderr.on('data',b=>stderr=(stderr+b).slice(-12000));
 let report;
 for(let n=0;n<1200;n++){
  report=await readFile(join(root,'native-smoke.json'),'utf8').then(JSON.parse,()=>null);if(report)break;
  if(child.exitCode!==null)throw Error('Native tray candidate exited: '+stderr);
  await new Promise(r=>setTimeout(r,100));
 }
 assert.equal(report?.suite,'windows-tray-menu',JSON.stringify({report,stderr,root}));
 const result={...report,...provenance,actualLocalRequests:requests,platform:process.platform};
 await writeFile('test-results/native-tray-menu-summary.json',JSON.stringify(result,null,2)+'\n');
 assert.equal(report.passed,true,JSON.stringify(result));assert.equal(requests,2,'both initial and cancelled-exit requests must reach local upstream');
 passed=true;console.log(JSON.stringify({...result,root,pid:child.pid},null,2));
 if(keepOpen){console.log('Physical tray acceptance ready; the manager has an isolated Open tray button.');await once(child,'exit');}
 else if(child.exitCode===null){const timer=setTimeout(()=>child.kill(),15000);try{assert.equal((await once(child,'exit'))[0],0,'closing an idle manager must exit even after a hidden tray window was created');}finally{clearTimeout(timer);}}
}finally{
 if(child?.exitCode===null&&child?.signalCode===null){child.kill();await once(child,'exit');}
 upstream.closeAllConnections();await new Promise(r=>upstream.close(r));
 if(passed)await rm(root,{recursive:true,force:true,maxRetries:30,retryDelay:100});
 else console.error('Failed synthetic tray fixture retained: '+root);
}
