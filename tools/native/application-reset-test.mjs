import { assertFreshCompatible } from './test-support.mjs';
import { clearFreshCompatibleFixture } from './test-support.mjs';
import assert from 'node:assert/strict';
import { mkdtemp,realpath,mkdir,writeFile,readFile,readdir,rm,access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { spawn,spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { nativeTestBinary } from './test-support.mjs';

const sandbox=await mkdtemp(join(await realpath(tmpdir()),'xwxdeck-reset-'));
const env={...process.env,XWX_DECK_TEST_SECURE_STORE:'1'}, checks=[], children=[];
let child,queue=[];
const exists=async path=>access(path).then(()=>true,()=>false);
async function wait(check,label){for(let i=0;i<200;i++){const result=await check();if(result)return result;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('timeout '+label);}
function start(root,extra=[]){queue=[];child=spawn(nativeTestBinary,['--rpc','--pilot-root',root,'--reset-test-no-relaunch',...extra],{env,stdio:['pipe','pipe','pipe']});children.push(child);createInterface({input:child.stdout}).on('line',line=>queue.shift()?.(JSON.parse(line)));child.stderr.resume();return child;}
async function call(method,...args){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(method+' timed out')),20000);queue.push(value=>{clearTimeout(timer);resolve(value)});child.stdin.write(JSON.stringify({method,args})+'\n');});}
async function rpc(method,...args){const result=await call(method,...args);assert.equal(result.ok,true,result.error);return result.result;}
async function stop(){const exited=once(child,'exit');child.stdin.end();assert.equal((await exited)[0],0);}
async function reset(root,option){const exited=once(child,'exit');const result=await rpc('resetApplication',{resetClientConfigs:option});assert.equal((await exited)[0],0);return result;}
async function result(root){return wait(async()=>{
  const reportPath=join(root,'application-reset-result.json');
  const report=await readFile(reportPath,'utf8').then(JSON.parse,()=>null);if(!report)return null;
  // Publishing a result precedes the final gate/lock cleanup. In no-relaunch
  // mode a startup during that interval recovers and exits before RPC begins.
  const job=JSON.parse(await readFile(join(report.backupPath,'job.json'),'utf8'));
  if(Number.isInteger(job.worker_pid)&&job.worker_pid>0){
    try{process.kill(job.worker_pid,0);return null;}catch(error){if(error.code!=='ESRCH')throw error;}
  }
  return JSON.parse(await readFile(reportPath,'utf8'));
},'reset worker finalization');}
async function seed(root){await mkdir(root);start(root);await rpc('getState');await clearFreshCompatibleFixture(rpc);const workspace='../workspace-'+basename(root);for(const name of ['codex/sessions','codex/skills','claude/projects','claude/agents',workspace+'/source',workspace+'/target/.agents/skills'])await mkdir(join(root,name),{recursive:true});const preserved={'codex/sessions/history.jsonl':'opaque conversation body\n','codex/skills/SKILL.md':'user skill\n','claude/projects/history.jsonl':'opaque Claude history\n','claude/agents/agent.md':'user agent\n',[workspace+'/source/SKILL.md']:'workspace source\n',[workspace+'/target/.agents/skills/SKILL.md']:'workspace target\n'};for(const[name,source]of Object.entries(preserved))await writeFile(join(root,name),source);
  const core={'codex/config.toml':'# original config\nmodel="user-choice"\n','codex/auth.json':'{"OPENAI_API_KEY":"SYNTHETIC-RESET-ONLY"}\n','claude/settings.json':'{"permissions":{"allow":["Read"]}}\n','claude/claude.json':'{"legacySetting":"keep unless explicitly reset"}\n'};for(const[name,source]of Object.entries(core))await writeFile(join(root,name),source);
  await rpc('saveProvider',{id:'reset-fixture',displayName:'Fixture_ff7f6008',baseUrl:'http://127.0.0.1:9/v1',bearerToken:'SYNTHETIC-RESET-KEY',adapter:'responses',codexModel:'user-model'});
  await writeFile(join(root,'logs','fixture.log'),'application log\n');await writeFile(join(root,'traces','fixture-record.json'),'trace fixture\n');await writeFile(join(root,'xwx-deck-model-catalog-cache.json'),'{}\n');
  return {preserved,core};
}
async function exportBackup(backup,destination){const run=spawnSync(nativeTestBinary,['--export-credential-backup',join(backup,'data'),'--export-destination',destination,'--export-isolated-test'],{env,encoding:'utf8'});assert.equal(run.status,0,run.stderr);return JSON.parse(await readFile(join(destination,'settings.json'),'utf8'));}
const pass=label=>{checks.push(label);console.log('PASS '+label);};
let report={passed:false,checks,isolatedFixtures:true};
try{
  const root=join(sandbox,'keep-clients'),{preserved,core}=await seed(root);
  const before=await readFile(join(root,'settings.json'));
  const resetResult=await reset(root,false), completed=await result(root);assert.equal(completed.status,'completed');
  assert.equal(await exists(join(root,'settings.json')),false);assert.equal(await exists(join(root,'logs')),false);assert.equal(await exists(join(root,'traces')),false);assert.equal(await exists(join(root,'xwx-deck-model-catalog-cache.json')),false);
  for(const[name,source]of Object.entries({...preserved,...core}))assert.equal(await readFile(join(root,name),'utf8'),source,name);
  assert.deepEqual(await readFile(join(resetResult.backupPath,'data/settings.json')),before);const settings=await exportBackup(resetResult.backupPath,join(sandbox,'export-keep'));assert.equal(settings.connections[0].displayName,'Fixture_ff7f6008');
  start(root);assertFreshCompatible(await rpc('getProviders'));assert.equal((await rpc('getState')).traceWarningGB,1);await stop();
  pass('exited-manager reset archives settings, caches, Trace and logs; restart restores empty public defaults while client histories, skills, agents and user workspace files remain byte-identical');
  pass('the original credential store and exact settings bytes remain exportable from the reset archive');

  const clients=join(sandbox,'reset-clients'),fixture=await seed(clients);const requested=await reset(clients,true);assert.equal((await result(clients)).status,'completed');
  for(const name of Object.keys(fixture.core))assert.equal(await exists(join(clients,name)),false,name);
  for(const[name,source]of Object.entries(fixture.preserved))assert.equal(await readFile(join(clients,name),'utf8'),source,name);
  await exportBackup(requested.backupPath,join(sandbox,'export-clients'));const backups=(await readdir(join(sandbox,'export-clients'))).filter(name=>name.startsWith('client-repair-'));
  assert.equal(backups.length,4);for(const[name,source]of Object.entries(fixture.core)){const documents=await Promise.all(backups.map(async name=>JSON.parse(await readFile(join(sandbox,'export-clients',name),'utf8'))));assert.ok(documents.some(doc=>doc.before===source&&doc.sha256===createHash('sha256').update(source).digest('hex')),name);}
  pass('explicit core reset removes exactly the four documented files, preserves history/skills/agents and retains private exact recovery copies');

  const clientDrift=join(sandbox,'client-drift');const clientFixture=await seed(clientDrift);await reset(clientDrift,true);
  await writeFile(join(clientDrift,'claude/settings.json'),'{"newerExternalChoice":true}\n');
  const partial=await result(clientDrift);assert.equal(partial.status,'completed');assert.equal(partial.skippedClientFiles.length,1);assert.match(partial.skippedClientFiles[0].path,/settings.json$/);
  assert.equal(await readFile(join(clientDrift,'claude/settings.json'),'utf8'),'{"newerExternalChoice":true}\n');
  for(const[name,source]of Object.entries(clientFixture.preserved))assert.equal(await readFile(join(clientDrift,name),'utf8'),source,name);
  start(clientDrift);assert.equal((await rpc('getApplicationResetResult')).skippedClientFiles.length,1);await stop();
  pass('an externally changed core client file is retained and reported explicitly while application reset and unaffected core files complete');

  const conflict=join(sandbox,'trace-restore-conflict');await seed(conflict);await rpc('switchClientProvider',{client:'codex',providerId:'reset-fixture'});
  const active=await rpc('toggleTracing',true);const activeSource=await readFile(join(conflict,'codex/config.toml'),'utf8');
  assert.ok(activeSource.includes(active.localBaseUrl));await writeFile(join(conflict,'codex/config.toml'),activeSource.replaceAll(active.localBaseUrl,'http://127.0.0.1:9999/v1'));
  const blocked=await call('resetApplication',{resetClientConfigs:false});assert.equal(blocked.ok,false);assert.match(blocked.error,/外部|恢复|冲突/);
  assert.equal((await rpc('getState')).tracingEnabled,true);assert.equal(await exists(join(conflict,'application-reset-result.json')),false);
  await writeFile(join(conflict,'codex/config.toml'),activeSource);await rpc('toggleTracing',false);await stop();
  pass('a Trace restoration conflict rejects reset before manager exit or archiving, preserves the live recovery route and allows an explicit corrected retry');

  const drift=join(sandbox,'external-drift');await seed(drift);const driftReset=await reset(drift,false);
  const source=await readFile(join(drift,'settings.json'),'utf8');await writeFile(join(drift,'settings.json'),source+' ');
  const failed=await result(drift);assert.equal(failed.status,'failed');assert.equal(await readFile(join(drift,'settings.json'),'utf8'),source+' ');assert.equal(await exists(join(driftReset.backupPath,'data/settings.json')),false);
  pass('an external edit after manager exit prevents archiving and preserves the latest source instead of overwriting it with defaults');

  const crash=join(sandbox,'worker-crash');await seed(crash);await stop();start(crash,['--reset-test-pause-after-first-move']);await rpc('getState');const pausedReset=await reset(crash,false);await wait(()=>exists(join(pausedReset.backupPath,'pause-used')),'first archived move');
  const job=JSON.parse(await readFile(join(pausedReset.backupPath,'job.json'),'utf8'));assert.ok(job.worker_pid>0);process.kill(job.worker_pid,'SIGKILL');
  await new Promise(resolve=>setTimeout(resolve,100));
  const recovery=start(crash);assert.equal((await once(recovery,'exit'))[0],0);const recovered=await result(crash);assert.equal(recovered.status,'completed');
  start(crash);assertFreshCompatible(await rpc('getProviders'));assert.equal(await readFile(join(crash,'codex/sessions/history.jsonl'),'utf8'),'opaque conversation body\n');await stop();
  pass('killing the worker after an actual archive move leaves a resumable journal; the next launch completes reset before opening new application state');
  report={...report,passed:true,scope:'actual Rust RPC, manager exit, independent worker, synthetic credential export, external file edit and worker SIGKILL; desktop restart and real platform validation are separate'};
}finally{
  for(const process of children)if(process.exitCode===null&&process.signalCode===null){process.kill('SIGKILL');await once(process,'exit').catch(()=>{});}
  report.binarySha256=createHash('sha256').update(await readFile(nativeTestBinary)).digest('hex');await mkdir('test-results',{recursive:true});await writeFile('test-results/native-application-reset-summary.json',JSON.stringify(report,null,2)+'\n');
  // Only this test's private parent contains its roots and reset archives.
  if(report.passed)await rm(sandbox,{recursive:true,force:true});else console.error('Synthetic reset recovery retained at '+sandbox);
}
