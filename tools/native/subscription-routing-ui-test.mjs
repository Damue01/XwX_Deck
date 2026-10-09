import assert from 'node:assert/strict';import {createServer}from'node:http';import{spawn}from'node:child_process';import{createInterface}from'node:readline';import{once}from'node:events';import{mkdtemp,realpath,writeFile,readFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join,resolve}from'node:path';
const root=await mkdtemp(join(await realpath(tmpdir()),'xwx-routing-native-ui-'));const binary=process.env.XWX_NATIVE_TEST_BINARY?resolve(process.env.XWX_NATIVE_TEST_BINARY):resolve('test-results/rust-pilot-package/XwX Deck Rust Pilot.app/Contents/MacOS/xwx-deck-native');
const server=createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/v1/models')res.end(JSON.stringify({models:[{slug:'model',visibility:'list'}]}));else{res.writeHead(404);res.end('{}');}});server.listen(0,'127.0.0.1');await once(server,'listening');const endpoint=`http://127.0.0.1:${server.address().port}`;
let child,queue=[];
const rpc=(method,...args)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('RPC timeout')),20000);queue.push(r=>{clearTimeout(timer);r.ok?resolve(r.result):reject(Error(r.error));});child.stdin.write(JSON.stringify({method,args})+'\n');});
const startRpc=()=>{child=spawn(binary,['--rpc','--pilot-root',root,'--subscription-test-endpoint',endpoint],{stdio:['pipe','pipe','inherit']});createInterface({input:child.stdout}).on('line',line=>queue.shift()?.(JSON.parse(line)));};
const stop=async()=>{const done=once(child,'exit');child.stdin.end();assert.equal((await done)[0],0);};
try{
 startRpc();await rpc('getState');await stop();
 await writeFile(join(root,'subscription-accounts.json'),JSON.stringify({hostId:'fixture',accounts:['a','b'].map(id=>({id,label:`Fixture ${id.toUpperCase()}`,subject:id,email:id+'@example.test',clientId:'fixture',access:'fixture-'+id,refresh:'fixture-refresh',idToken:'fixture',scopes:['chatgpt.tokens.use.direct'],expires:Math.floor(Date.now()/1000)+3600}))}));
 startRpc();for(const id of ['a','b'])await rpc('connectSubscriptionAccount',id);await stop();
 child=spawn(binary,['--pilot-root',root,'--subscription-test-endpoint',endpoint,'--smoke','--smoke-routing','--smoke-exit'],{env:{...process.env,XWX_SYSTEM_LANGUAGE_TEST:'zh-CN'},stdio:['ignore','inherit','inherit']});
 let report;for(let i=0;i<900;i++){try{report=JSON.parse(await readFile(join(root,'native-smoke.json'),'utf8'));break;}catch{}if(child.exitCode!==null||child.signalCode!==null)throw Error('Native app exited before UI report');await new Promise(r=>setTimeout(r,100));}
 assert.ok(report,'Native UI timed out: '+root);assert.equal(report.passed,true,JSON.stringify(report));assert.deepEqual(report.rendererErrors,[]);console.log(JSON.stringify({...report,root},null,2));
}finally{if(child?.exitCode===null&&child?.signalCode===null)child.kill('SIGTERM');server.closeAllConnections();server.close();}
