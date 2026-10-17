import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {nativeTestBinary} from './test-support.mjs';
const root=await mkdtemp(join(await realpath(tmpdir()),'xwxdeck-legacy-codex-'));
const config=join(root,'codex/config.toml'),suspension=join(root,'codex-local-proxy-suspension.json'),image=join(root,'compatible-image-gen.json');
const checks=[];let child,queue=[];const server=createServer(socket=>socket.end());
function start(){queue=[];child=spawn(nativeTestBinary,['--rpc','--pilot-root',root],{env:{...process.env,XWX_DECK_TEST_SECURE_STORE:'1'}});createInterface({input:child.stdout}).on('line',line=>queue.shift()?.(JSON.parse(line)));child.stderr.on('data',b=>process.stderr.write(b));}
function rpc(method,...args){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(method+' timeout')),10000);queue.push(r=>{clearTimeout(timer);r.ok?resolve(r.result):reject(Error(r.error));});child.stdin.write(JSON.stringify({method,args})+'\n');});}
async function stop(){const exit=once(child,'exit');child.stdin.end();assert.equal((await exit)[0],0);}
const pass=s=>{checks.push(s);console.log('PASS '+s);};
async function state(){start();const state=await rpc('getState');await stop();return state;}
async function record(path,body){await writeFile(path,JSON.stringify({version:1,configPath:config,...body}));}
try{
 start();await rpc('getState');await stop();
 // Probe a free product port, rather than killing or modifying another app.
 let port;for(let candidate=45233;candidate<=45242;candidate++){const probe=createServer();try{await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(candidate,'127.0.0.1',resolve);});port=candidate;await new Promise(r=>probe.close(r));break;}catch{if(probe.listening)await new Promise(r=>probe.close(r));}}
 assert.ok(port,'No free owned test port');const local=`http://127.0.0.1:${port}`,remote='https://api.fixture.example/v1';
 const suspended={originalBaseUrl:local+'/v1',directBaseUrl:remote,restoreOriginal:true,writtenAt:'isolated-fixture'};
 let current=`model = "kept-explicit"\n[model_providers.xwx_deck]\nbase_url = "${remote}" # user comment\nforeign = true\n`;
 await writeFile(config,current);await record(suspension,suspended);assert.equal((await state()).lastError,null);assert.equal(await readFile(config,'utf8'),current);await assert.rejects(readFile(suspension),{code:'ENOENT'});pass('v1 already bypassed configuration stays direct; migration never revives original localhost');
 current=`model = "kept-explicit"\n[model_providers."custom.provider"]\nbase_url = "${local}/v1" # endpoint\nforeign = true\n`;
 await writeFile(config,current);await record(suspension,{...suspended,version:2,preparedProvider:'custom.provider'});assert.equal((await state()).lastError,null);let restored=await readFile(config,'utf8');assert.ok(restored.includes(remote+'" # endpoint'));assert.ok(restored.includes('kept-explicit'));assert.ok(restored.includes('foreign = true'));pass('v2 quoted provider alias restores the recorded direct endpoint and preserves model, comments and foreign fields');
 await writeFile(config,`chatgpt_base_url = "${local}" # official override\nopenai_base_url = "https://another.fixture/v1"\n`);await record(suspension,{...suspended,version:3,preparedProvider:'openai',fieldLocation:'chatgpt-base-url',originalBaseUrl:local,directBaseUrl:'https://chatgpt.com/backend-api'});assert.equal((await state()).lastError,null);restored=await readFile(config,'utf8');assert.ok(restored.includes('https://chatgpt.com/backend-api" # official override'));assert.ok(restored.includes('https://another.fixture/v1'));pass('v3 official account root is restored without mixing it with the model endpoint');
 current='openai_base_url = "https://external.fixture/v1"\n';await writeFile(config,current);await record(suspension,{...suspended,version:3,fieldLocation:'openai-base-url'});assert.equal((await state()).lastError,null);assert.equal(await readFile(config,'utf8'),current);pass('a later external remote endpoint remains authoritative and the archived suspension is consumed');
 current=`openai_base_url = "${local}/changed"\n`;await writeFile(config,current);await record(suspension,{...suspended,version:3,fieldLocation:'openai-base-url'});assert.match((await state()).lastError,/外部修改/);assert.equal(await readFile(config,'utf8'),current);assert.equal(JSON.parse(await readFile(suspension,'utf8')).nativeEncryptedDocument,1);await rm(suspension);pass('external changes to the owned local route block takeover and preserve encrypted recovery evidence');
 server.listen(port,'127.0.0.1');await once(server,'listening');await writeFile(config,`[model_providers.xwx_deck]\nbase_url = "${remote}"\n`);await record(suspension,suspended);const liveRecord=await readFile(suspension,'utf8');start();assert.notEqual((await once(child,'exit'))[0],0);assert.equal(await readFile(suspension,'utf8'),liveRecord);assert.ok(server.listening);await new Promise(r=>server.close(r));assert.equal((await state()).lastError,null);pass('a live former product proxy is preserved until stopped; later recovery completes without terminating a process');
 await writeFile(config,'[features]\nimage_gen = false # old overlay\njs_repl = true\n');await record(image,{previous:{present:true,value:true},writtenValue:false});assert.equal((await state()).lastError,null);restored=await readFile(config,'utf8');assert.ok(restored.includes('image_gen = true # old overlay'));assert.ok(restored.includes('js_repl = true'));pass('compatible image policy restores an explicit original value and keeps foreign feature choices and comments');
 await writeFile(config,'# user header\n[features]\nimage_gen = false\n');await record(image,{previous:{present:false},writtenValue:false});assert.equal((await state()).lastError,null);restored=await readFile(config,'utf8');assert.ok(!restored.includes('image_gen'));assert.ok(!restored.includes('[features]'));assert.ok(restored.includes('# user header'));pass('compatible policy introduced alone is removed together with its empty table while unrelated comments remain');
 current='[features]\nimage_gen = true # latest user choice\n';await writeFile(config,current);await record(image,{previous:{present:false},writtenValue:false});assert.equal((await state()).lastError,null);assert.equal(await readFile(config,'utf8'),current);pass('a newer explicit image policy wins over the old overlay');
 const count=(await readdir(root)).filter(n=>n.startsWith('legacy-recovery-')).length;assert.equal((await state()).lastError,null);assert.equal((await readdir(root)).filter(n=>n.startsWith('legacy-recovery-')).length,count);pass('encrypted migration archives are repeatable and restart does not duplicate recovery');
 await record(image,{configPath:join(root,'unowned.toml'),previous:{present:false},writtenValue:false});assert.match((await state()).lastError,/路径不匹配/);assert.equal(await readFile(config,'utf8'),current);await rm(image);pass('a journal cannot authorize writes to an unrelated config path');
 console.log(JSON.stringify({passed:true,checks,scope:'actual v1/v2/v3 suspension and compatible image policy journals; synthetic keys and isolated configs only'}));
}finally{if(child?.exitCode===null){child.kill('SIGKILL');await once(child,'exit');}if(server.listening)await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
