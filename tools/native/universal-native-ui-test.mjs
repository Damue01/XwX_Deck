import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {nativeTestBinary,writeCliFixture} from './test-support.mjs';
const root=await mkdtemp(join(await realpath(tmpdir()),'xwx-universal-native-ui-'));
const initialized=spawnSync(nativeTestBinary,['--rpc','--pilot-root',root],{input:JSON.stringify({method:'getProviders',args:[]})+'\n',encoding:'utf8'});
assert.equal(initialized.status,0,initialized.stderr);assert.equal(JSON.parse(initialized.stdout).result.connections.length,0);
const home=join(root,'client-home');const config=join(home,'.config/opencode/opencode.json');
await mkdir(resolve(config,'..'),{recursive:true});await writeFile(config,'{"theme":"system"}\n');
await mkdir(join(home,'.local/bin'),{recursive:true});await writeCliFixture(join(home,'.local/bin/opencode'),'process.exit(0);');
const requests=[];const server=createServer(async(req,res)=>{
  if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'gpt-4.1'}]}));return;}
  let body='';for await(const part of req)body+=part;requests.push({path:req.url,body:JSON.parse(body),authorization:req.headers.authorization});
  const response={id:'native-universal-fixture',object:'response',model:'gpt-4.1',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'fixture reply'}]}],usage:{input_tokens:13,output_tokens:7,total_tokens:20,input_tokens_details:{cached_tokens:4}}};
  res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: response.output_text.delta\ndata: '+JSON.stringify({type:'response.output_text.delta',delta:'fixture reply'})+'\n\n');setTimeout(()=>res.end('event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response})+'\n\n'),100);
});server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}/v1`;
const child=spawn(nativeTestBinary,['--pilot-root',root,'--smoke','--smoke-universal','--smoke-upstream',base,'--smoke-exit'],{env:{...process.env,XWX_SYSTEM_LANGUAGE_TEST:'zh-CN',XWX_CLIENT_INSTALLATIONS_TEST_HOME:home},stdio:['ignore','inherit','inherit']});
try{
  let report;for(let i=0;i<1800;i++){try{report=JSON.parse(await readFile(join(root,'native-smoke.json'),'utf8'));break;}catch{}if(child.exitCode!==null||child.signalCode!==null)throw Error('Native UI exited before reporting');await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(report,'Native GUI test timed out: '+root);assert.equal(report.passed,true,JSON.stringify(report));
  assert.equal(requests.length,1);assert.equal(requests[0].path,'/v1/responses');assert.equal(requests[0].authorization,'Bearer fixture-key');assert.equal(requests[0].body.model,'gpt-4.1');
  assert.equal(await readFile(config,'utf8'),'{"theme":"system"}\n');
  console.log(JSON.stringify({...report,sandbox:root,nativeHttpRequests:requests.length},null,2));
  if(child.exitCode===null){const[code]=await once(child,'exit');assert.equal(code,0);}
}finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
