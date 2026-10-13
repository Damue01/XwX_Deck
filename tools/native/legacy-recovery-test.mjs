import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,writeFile,mkdir,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {nativeTestBinary} from './test-support.mjs';

async function vacantLegacyPort() {
  for (let port = 44233; port <= 44242; port++) {
    const probes = [];
    try {
      // macOS can accept the IPv6 bind while an IPv4-specific listener owns
      // the same port. Reserve both loopback addresses before choosing it.
      for (const host of ['127.0.0.1', '::1']) {
        const probe = createServer();
        await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen({port, host, ipv6Only: true}, resolve); });
        probes.push(probe);
      }
      return port;
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
    finally { for (const probe of probes) await new Promise(resolve => probe.close(resolve)); }
  }
  throw Error('No unused legacy product port for this isolated fixture');
}
const legacyPort = await vacantLegacyPort();
const root=await mkdtemp(join(await realpath(tmpdir()),'xwxdeck-legacy-recovery-'));
const env={...process.env,XWX_DECK_TEST_SECURE_STORE:'1'};
let child,queue=[];let passed=0;
function start(){queue=[];child=spawn(nativeTestBinary,['--rpc','--pilot-root',root],{env});createInterface({input:child.stdout}).on('line',line=>queue.shift()?.(JSON.parse(line)));child.stderr.on('data',d=>process.stderr.write(d));}
function call(method,...args){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`Timeout ${method}`)),10000);queue.push(v=>{clearTimeout(timer);v.ok?resolve(v.result):reject(Error(v.error));});child.stdin.write(JSON.stringify({method,args})+'\n');});}
async function end(){const done=once(child,'exit');child.stdin.end();assert.equal((await done)[0],0);}
const journals=join(root,'trace-client-backups'),codex=join(root,'codex/config.toml'),claude=join(root,'claude/settings.json');
const field=(key,previous,writtenValue,sectionHeader)=>({format:'toml-string',key,previous:{present:previous!==undefined,value:previous},writtenValue,sectionHeader});
async function journal(client,record){await writeFile(join(journals,`${client}.json`),JSON.stringify({version:2,client,configPath:client==='codex'?codex:claude,fileExisted:true,writtenLocalUrl:`http://127.0.0.1:${legacyPort}`,...record}));}
const server=createServer(socket=>socket.end());
try{
  start();await call('getState');await end();await mkdir(journals);
  const original='model_provider = "compatible"\nmodel = "explicit-model"\n[model_providers.compatible]\nbase_url = "https://compatible.example/v1"\nwire_api = "responses"\n';
  const written=original.replace('https://compatible.example/v1',`http://127.0.0.1:${legacyPort}/v1`);
  const external=written+'external = "user-choice" # keep\n';
  await writeFile(codex,external);await journal('codex',{originalContent:original,writtenContent:written,fields:[field('base_url','https://compatible.example/v1',`http://127.0.0.1:${legacyPort}/v1`,'[model_providers.compatible]')]});
  start();let state=await call('getState');assert.equal(state.lastError,null);await end();
  let current=await readFile(codex,'utf8');assert.ok(current.includes('https://compatible.example/v1'));assert.ok(current.includes('explicit-model'));assert.ok(current.includes('external = "user-choice" # keep'));assert.deepEqual(await readdir(journals),[]);
  const archive=(await readdir(root)).find(n=>n.startsWith('legacy-recovery-codex-'));assert.ok(archive);assert.equal(JSON.parse(await readFile(join(root,archive),'utf8')).nativeEncryptedDocument,1);passed++;
  start();await call('getState');await end();assert.equal(await readFile(codex,'utf8'),current);assert.equal((await readdir(root)).filter(n=>n.startsWith('legacy-recovery-codex-')).length,1);passed++;
  await writeFile(claude,JSON.stringify({env:{ANTHROPIC_BASE_URL:`http://127.0.0.1:${legacyPort}`,ANTHROPIC_AUTH_TOKEN:'synthetic-external'},permissions:{allow:['Read']}}));
  await journal('claude',{version:1,originalContent:JSON.stringify({env:{ANTHROPIC_BASE_URL:'https://compatible.example/anthropic'}})});
  start();state=await call('getState');assert.equal(state.lastError,null);await end();let json=JSON.parse(await readFile(claude,'utf8'));assert.equal(json.env.ANTHROPIC_BASE_URL,'https://compatible.example/anthropic');assert.equal(json.env.ANTHROPIC_AUTH_TOKEN,'synthetic-external');assert.equal(json.permissions.allow[0],'Read');passed++;
  await writeFile(codex,`openai_base_url = "http://127.0.0.1:${legacyPort}/user-edited"\n`);await journal('codex',{fields:[field('openai_base_url','https://api.example/v1',`http://127.0.0.1:${legacyPort}/v1`)]});
  start();state=await call('getState');assert.match(state.lastError,/尚未恢复/);await assert.rejects(call('toggleTracing',true),/尚未恢复/);await end();assert.ok((await readFile(codex,'utf8')).includes('user-edited'));assert.equal(JSON.parse(await readFile(join(journals,'codex.json'),'utf8')).nativeEncryptedDocument,1);passed++;
  await writeFile(codex,'openai_base_url = "https://external.example/v1"\n');start();state=await call('getState');assert.equal(state.lastError,null);await end();assert.ok((await readFile(codex,'utf8')).includes('https://external.example/v1'));assert.deepEqual(await readdir(journals),[]);passed++;
  // The source path in a journal is never permission to write arbitrary files.
  const outside=join(root,'unowned.txt');await writeFile(outside,'unchanged');await journal('codex',{configPath:outside,fields:[]});
  start();state=await call('getState');assert.match(state.lastError,/路径.*不匹配/);await end();assert.equal(await readFile(outside,'utf8'),'unchanged');await rm(join(journals,'codex.json'));passed++;
  server.listen(0,'127.0.0.1');await once(server,'listening');const live=`http://127.0.0.1:${server.address().port}`;
  await writeFile(codex,`openai_base_url = "${live}/v1"\n`);await journal('codex',{writtenLocalUrl:live,fields:[field('openai_base_url','https://api.example/v1',`${live}/v1`)]});
  const liveRecord=await readFile(join(journals,'codex.json'),'utf8');start();assert.notEqual((await once(child,'exit'))[0],0);assert.ok((await readFile(codex,'utf8')).includes(live));assert.equal(await readFile(join(journals,'codex.json'),'utf8'),liveRecord);assert.ok(server.listening);passed++;
  await new Promise(r=>server.close(r));start();state=await call('getState');assert.equal(state.lastError,null);await end();assert.ok((await readFile(codex,'utf8')).includes('https://api.example/v1'));passed++;
  // A file created solely by old Trace is removed after proving exact ownership.
  await writeFile(codex,written);await journal('codex',{fileExisted:false,writtenContent:written,fields:[field('base_url',undefined,`http://127.0.0.1:${legacyPort}/v1`,'[model_providers.compatible]')]});
  start();await call('getState');await end();await assert.rejects(readFile(codex),{code:'ENOENT'});passed++;
  console.log(JSON.stringify({passed,isolatedFixtures:true,scope:'actual old v1/v2 journals, encrypted archives, external changes, idempotence, unsafe paths, live proxy preservation, exact created-file removal'}));
}finally{if(child?.exitCode===null){child.kill('SIGKILL');await once(child,'exit');}if(server.listening)await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
