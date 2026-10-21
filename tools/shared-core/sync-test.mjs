import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, symlink, stat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { planSync, applySync, summarize, writePreview, acceptBaseline } from './sync.mjs';

const temporary=await mkdtemp(join(await realpath(tmpdir()),'xwxdeck-shared-sync-test-'));
const checks=[];let serial=0;
const sha=value=>createHash('sha256').update(value).digest('hex');
function git(root,args,input) {
  const result=spawnSync('git',['-C',root,...args],{input,encoding:'utf8',env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
  assert.equal(result.status,0,result.stderr);return result.stdout.trim();
}
async function write(root,path,value) {await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),value);}
async function fixture() {
  const parent=join(temporary,String(++serial)),root=join(parent,'internal'),peer=join(parent,'public');
  const files={'src/shared/common.ts':'first\nshared\nlast\n','src/renderer/common.css':'one\ntwo\nthree\n'};
  for(const repo of [root,peer]) {
    await mkdir(repo,{recursive:true});git(repo,['init','-q']);git(repo,['config','user.name','Synthetic test']);git(repo,['config','user.email','test@example.invalid']);
    for(const [path,value] of Object.entries(files))await write(repo,path,value);
    await write(repo,'src-native/src/core.rs',repo===root?'edition preserved\n':'public entry\n');
    await write(repo,'private-preserved.txt','edition-owned\n');
    git(repo,['add','.']);git(repo,['commit','-qm','Synthetic baseline']);
  }
  const manifest={schemaVersion:1,shared:Object.entries(files).map(([path,value])=>({path,baseBlob:git(root,['hash-object','--',path]),sha256:sha(value)})),mixed:[{path:'src-native/src/core.rs',internalSha256:sha('edition preserved\n'),publicSha256:sha('public entry\n')}]};
  await write(root,'docs/shared-core-sync.json',JSON.stringify(manifest));
  await write(root,'public-release-policy.json',JSON.stringify({excludedPaths:['private-preserved.txt'],forbiddenPackagedPatterns:['private-provider\\.invalid']}));
  return {root,peer,parent,manifest};
}
async function test(name,run) {await run();checks.push(name);console.log('PASS '+name);}
try {
  await test('full-file audit catches pre-existing local divergence even when incremental import is empty',async()=>{
    const f=await fixture();f.manifest.derivedFrom={commit:'synthetic'};
    f.manifest.schemaVersion=2;delete f.manifest.mixed;
    for(const repo of [f.root,f.peer]){await mkdir(join(repo,'src-native/src/edition'),{recursive:true});await rename(join(repo,'src-native/src/core.rs'),join(repo,'src-native/src/edition/core.rs'));}
    await write(f.root,'tools/shared-core/export-policy.json',JSON.stringify({excludedPaths:[],forbiddenPackagedPatterns:[]}));
    await write(f.root,'tools/shared-core/inventory.mjs',await readFile(new URL('./inventory.mjs',import.meta.url),'utf8'));
    const tool='tools/shared-core/audit-parity.mjs';await write(f.root,tool,await readFile(new URL('./audit-parity.mjs',import.meta.url),'utf8'));
    await write(f.root,'docs/shared-core-sync.json',JSON.stringify(f.manifest));
    await write(f.peer,'docs/shared-core-sync.json',JSON.stringify(f.manifest));
    const audit=()=>spawnSync(process.execPath,[join(f.root,tool)],{encoding:'utf8'});
    assert.equal(audit().status,0);
    await write(f.root,'src/shared/common.ts','local divergence\nshared\nlast\n');
    assert.equal(summarize(await planSync({...f,direction:'import'})).updates.length,0);
    const result=audit();assert.equal(result.status,1);const report=JSON.parse(result.stdout);
    assert.equal(report.fullyIdentical,false);assert.deepEqual(report.unreviewed,['src/shared/common.ts']);
  });
  await test('Windows CRLF checkouts merge public increments without whole-file conflicts',async()=>{
    const f=await fixture();
    await write(f.root,'src/shared/common.ts','internal first\r\nshared\r\nlast\r\n');
    await write(f.peer,'src/shared/common.ts','first\nshared\npublic last\n');
    const plan=await planSync({...f,direction:'import'});
    assert.equal(summarize(plan).blocked.length,0);
    await applySync(plan,join(f.parent,'line-ending-recovery'));
    assert.equal(await readFile(join(f.root,'src/shared/common.ts'),'utf8'),'internal first\nshared\npublic last\n');
  });
  await test('read-only preview uses uncommitted peer bytes and leaves both files and Git indexes unchanged',async()=>{
    const f=await fixture();await write(f.peer,'src/shared/common.ts','public working tree\nshared\nlast\n');
    const before=await Promise.all([f.root,f.peer].map(r=>readFile(join(r,'.git/index'))));
    const plan=await planSync({...f,direction:'import'});assert.deepEqual(summarize(plan).updates,['src/shared/common.ts']);
    const preview=await writePreview(plan,join(f.parent,'preview'));
    const patch=await readFile(join(preview.reviewDirectory,'review.patch'),'utf8');assert.match(patch,/--- a\/src\/shared\/common.ts/);assert.match(patch,/\+public working tree/);assert.ok(!patch.includes('internal extension'));
    assert.equal((await readFile(join(f.root,'src/shared/common.ts'),'utf8')),'first\nshared\nlast\n');
    for(const [n,r] of [f.root,f.peer].entries())assert.deepEqual(await readFile(join(r,'.git/index')),before[n]);
    const result=await applySync(plan,join(f.parent,'recovery'));assert.equal(result.applied,1);
    assert.equal(await readFile(join(f.root,'src/shared/common.ts'),'utf8'),'public working tree\nshared\nlast\n');
    assert.equal(await readFile(join(f.root,'src-native/src/core.rs'),'utf8'),'edition preserved\n');
    assert.equal(await readFile(join(f.parent,'recovery/before/src/shared/common.ts'),'utf8'),'first\nshared\nlast\n');
    if(process.platform!=='win32')assert.equal((await stat(join(f.parent,'recovery/before/src/shared/common.ts'))).mode&0o777,0o600);
    assert.equal(JSON.parse(await readFile(join(f.parent,'recovery/journal.json'),'utf8')).status,'complete');
  });
  await test('reverse synchronization merges disjoint edits and preserves private edition files',async()=>{
    const f=await fixture();await write(f.root,'src/shared/common.ts','internal shared update\nshared\nlast\n');await write(f.peer,'src/shared/common.ts','first\nshared\npublic local edit\n');
    const plan=await planSync({...f,direction:'export'});await applySync(plan,join(f.parent,'recovery'));
    assert.equal(await readFile(join(f.peer,'src/shared/common.ts'),'utf8'),'internal shared update\nshared\npublic local edit\n');
    assert.equal(await readFile(join(f.peer,'src-native/src/core.rs'),'utf8'),'public entry\n');
  });
  await test('conflicts block the entire batch without overwriting an otherwise clean update',async()=>{
    const f=await fixture();await write(f.root,'src/shared/common.ts','internal conflict\nshared\nlast\n');await write(f.peer,'src/shared/common.ts','public conflict\nshared\nlast\n');await write(f.peer,'src/renderer/common.css','changed\ntwo\nthree\n');
    const plan=await planSync({...f,direction:'import'});assert.ok(summarize(plan).blocked.length);await assert.rejects(applySync(plan,join(f.parent,'recovery')),/blocked/);
    assert.equal(await readFile(join(f.root,'src/renderer/common.css'),'utf8'),'one\ntwo\nthree\n');
  });
  await test('external target or source modifications after preview are retained and require a new preview',async()=>{
    for(const side of ['root','peer']) {
      const f=await fixture();await write(f.peer,'src/shared/common.ts','planned\nshared\nlast\n');const plan=await planSync({...f,direction:'import'});
      await write(f[side],'src/shared/common.ts','external newest choice\n');await assert.rejects(applySync(plan,join(f.parent,'recovery')),/External change retained/);
      assert.equal(await readFile(join(f[side],'src/shared/common.ts'),'utf8'),'external newest choice\n');
    }
  });
  await test('outbound private defaults and private paths fail before any public file is changed',async()=>{
    const f=await fixture();await write(f.root,'src/shared/common.ts','https://private-provider.invalid/v1\n');const plan=await planSync({...f,direction:'export'});
    assert.equal(summarize(plan).blocked[0].status,'public-boundary-blocked');await assert.rejects(applySync(plan,join(f.parent,'recovery')),/blocked/);
    f.manifest.shared.push({path:'private-preserved.txt',baseBlob:git(f.root,['hash-object','--','private-preserved.txt']),sha256:sha('edition-owned\n')});await write(f.root,'docs/shared-core-sync.json',JSON.stringify(f.manifest));
    await assert.rejects(planSync({...f,direction:'export'}),/Internal-only path/);
  });
  await test('deletion on either side is a review item and never silently removes a function',async()=>{
    for(const side of ['root','peer']){const f=await fixture();await rm(join(f[side],'src/shared/common.ts'));const plan=await planSync({...f,direction:'import'});assert.equal(summarize(plan).blocked.length,1);await assert.rejects(applySync(plan,join(f.parent,'recovery')),/blocked/);}
  });
  await test('symlinks, escaped paths and invalid baselines are refused',async()=>{
    const f=await fixture();
    if(process.platform==='win32') {
      // Junctions exercise the same ancestor-link guard without Developer Mode.
      await rm(join(f.peer,'src/shared'),{recursive:true});
      await symlink(join(f.root,'src/shared'),join(f.peer,'src/shared'),'junction');
    } else {
      await rm(join(f.peer,'src/shared/common.ts'));
      await symlink(join(f.root,'src/shared/common.ts'),join(f.peer,'src/shared/common.ts'));
    }
    await assert.rejects(planSync({...f,direction:'import'}),/regular file/);
    f.manifest.shared[0].path='../escape';await write(f.root,'docs/shared-core-sync.json',JSON.stringify(f.manifest));await assert.rejects(planSync({...f,direction:'import'}),/Unsafe shared path/);
    f.manifest.shared[0].path='src/shared/common.ts';f.manifest.shared[0].sha256='wrong';await write(f.root,'docs/shared-core-sync.json',JSON.stringify(f.manifest));await assert.rejects(planSync({...f,direction:'import'}),/baseline integrity/);
  });
  await test('mixed implementation changes are reported without copying either edition over the other',async()=>{
    const f=await fixture();await write(f.peer,'src-native/src/core.rs','public change needing adapter\n');const plan=await planSync({...f,direction:'import'});assert.deepEqual(summarize(plan).changedMixedFilesRequiringIntegration,['src-native/src/core.rs']);assert.equal(summarize(plan).updates.length,0);
    await assert.rejects(applySync(plan,join(f.root,'recovery')),/outside both/);
  });
  await test('a recovery path reached through a directory symlink cannot create files inside either repository',async()=>{
    const f=await fixture();await symlink(f.root,join(f.parent,'alias'),process.platform==='win32'?'junction':'dir');const plan=await planSync({...f,direction:'import'});
    await assert.rejects(writePreview(plan,join(f.parent,'alias','review')),/outside both/);await assert.rejects(stat(join(f.root,'review')),{code:'ENOENT'});
  });
  await test('baseline advances only for identical committed shared files and backs up its manifest',async()=>{
    const f=await fixture();for(const repo of [f.root,f.peer])await write(repo,'src/shared/common.ts','new common baseline\n');
    await assert.rejects(acceptBaseline({...f,output:join(f.parent,'baseline')}),/Commit both/);
    for(const repo of [f.root,f.peer]){git(repo,['add','src/shared/common.ts']);git(repo,['commit','-qm','Synthetic shared update']);}
    const result=await acceptBaseline({...f,output:join(f.parent,'baseline')});assert.deepEqual(result.updated,['src/shared/common.ts']);
    const saved=JSON.parse(await readFile(join(f.root,'docs/shared-core-sync.json'),'utf8'));assert.equal(saved.shared.find(e=>e.path==='src/shared/common.ts').sha256,sha('new common baseline\n'));
    assert.ok(await readFile(join(f.parent,'baseline/shared-core-sync-before.json')));assert.deepEqual((await acceptBaseline({...f,output:join(f.parent,'unused')})).updated,[]);
  });
  await test('a mid-batch I/O failure restores prior writes and leaves private recovery evidence',async()=>{
    for(const external of [false,true]) {
      const f=await fixture();await write(f.peer,'src/shared/common.ts','new first\n');await write(f.peer,'src/renderer/common.css','new second\n');const plan=await planSync({...f,direction:'import'});
      await assert.rejects(applySync(plan,join(f.parent,'recovery'),{renameFile:async(from,to)=>{
        if(to.endsWith('common.css'))throw Error('synthetic filesystem refusal');
        await rename(from,to);if(external&&from.includes('.shared-sync-'))await write(f.root,'src/shared/common.ts','external edit after first write\n');
      }}),/synthetic filesystem refusal/);
      assert.equal(await readFile(join(f.root,'src/shared/common.ts'),'utf8'),external?'external edit after first write\n':'first\nshared\nlast\n');
      assert.equal(await readFile(join(f.root,'src/renderer/common.css'),'utf8'),'one\ntwo\nthree\n');
      const journal=JSON.parse(await readFile(join(f.parent,'recovery/journal.json'),'utf8'));assert.equal(journal.status,'failed');assert.deepEqual(journal.externalEditsRetained,external?['src/shared/common.ts']:[]);assert.deepEqual(journal.rollbackIncomplete,[]);
    }
  });
  const newModule = async f => {
    const path='src/shared/new-neutral.ts';
    f.manifest.shared.unshift({path,baseBlob:git(f.root,['hash-object','-w','--stdin'],''),sha256:sha(''),initiallyAbsent:true});
    await write(f.root,'docs/shared-core-sync.json',JSON.stringify(f.manifest));
    await write(f.root,path,'export const neutral = true;\n');
    return path;
  };
  await test('reviewed new shared modules export exclusively, record prior absence and establish a committed two-edition baseline',async()=>{
    const f=await fixture(),path=await newModule(f),plan=await planSync({...f,direction:'export'});
    assert.deepEqual(summarize(plan).updates,[path]);
    await writePreview(plan,join(f.parent,'preview'));
    assert.match(await readFile(join(f.parent,'preview/review.patch'),'utf8'),/new file mode 100644\n[\s\S]*--- \/dev\/null/);
    git(f.peer,['apply','--check',join(f.parent,'preview/review.patch')]);
    await applySync(plan,join(f.parent,'recovery'));
    assert.equal(await readFile(join(f.peer,path),'utf8'),'export const neutral = true;\n');
    assert.equal(JSON.parse(await readFile(join(f.parent,'recovery/journal.json'),'utf8')).files[0].beforeSha256,null);
    for(const repo of [f.root,f.peer]){git(repo,['add',path]);git(repo,['commit','-qm','New neutral module']);}
    assert.deepEqual((await acceptBaseline({...f,output:join(f.parent,'baseline')})).updated,[path]);
    assert.equal(JSON.parse(await readFile(join(f.root,'docs/shared-core-sync.json'),'utf8')).shared[0].initiallyAbsent,undefined);
    await rm(join(f.peer,path));assert.ok(summarize(await planSync({...f,direction:'import'})).blocked.length,'later deletion remains review-only');
  });
  await test('a new target appearing after preview or during exclusive publication survives without overwrite',async()=>{
    for(const race of ['before','during']) {
      const f=await fixture(),path=await newModule(f),plan=await planSync({...f,direction:'export'});
      if(race==='before')await write(f.peer,path,'external created file\n');
      await assert.rejects(applySync(plan,join(f.parent,'recovery'),{publishNewFile:async(from,to)=>{await writeFile(to,'external created file\n',{flag:'wx'});const {link}=await import('node:fs/promises');await link(from,to);}}));
      assert.equal(await readFile(join(f.peer,path),'utf8'),'external created file\n');
    }
  });
  await test('new-module batch rollback removes only its own addition and preserves later external edits',async()=>{
    for(const external of [false,true]) {
      const f=await fixture(),path=await newModule(f);await write(f.root,'src/renderer/common.css','changed second file\n');
      const plan=await planSync({...f,direction:'export'});
      await assert.rejects(applySync(plan,join(f.parent,'recovery'),{renameFile:async()=>{if(external)await write(f.peer,path,'external after addition\n');throw Error('synthetic second refusal');}}),/synthetic second refusal/);
      if(external)assert.equal(await readFile(join(f.peer,path),'utf8'),'external after addition\n');
      else await assert.rejects(readFile(join(f.peer,path)),{code:'ENOENT'});
    }
  });
  await test('new modules still obey public boundaries and cannot use a nonempty or missing legacy baseline',async()=>{
    const f=await fixture(),path=await newModule(f);await write(f.root,path,'https://private-provider.invalid/v1\n');
    assert.equal(summarize(await planSync({...f,direction:'export'})).blocked[0].status,'public-boundary-blocked');
    f.manifest.shared[0].baseBlob=f.manifest.shared[1].baseBlob;f.manifest.shared[0].sha256=f.manifest.shared[1].sha256;await write(f.root,'docs/shared-core-sync.json',JSON.stringify(f.manifest));
    await assert.rejects(planSync({...f,direction:'export'}),/empty baseline/);
  });
  await test('import-only public modules merge around company additions and never transfer outbound',async()=>{
    const f=await fixture(),path='src-native/src/core.rs';
    const base='public first\nshared middle\npublic last\n';
    const baseBlob=git(f.root,['hash-object','-w','--stdin'],base);
    f.manifest.importOnly=[{path,baseBlob,sha256:sha(base),baselineGzip:gzipSync(base).toString('base64')}];
    await write(f.root,'docs/shared-core-sync.json',JSON.stringify(f.manifest));
    await write(f.root,path,'extension first\nshared middle\npublic last\n');
    await write(f.peer,path,'public first\nshared middle\npublic updated\n');
    const plan=await planSync({...f,direction:'import'});
    assert.deepEqual(summarize(plan).blocked,[]);
    assert.ok(summarize(plan).updates.includes(path));
    await applySync(plan,join(f.parent,'import-recovery'));
    assert.equal(await readFile(join(f.root,path),'utf8'),'extension first\nshared middle\npublic updated\n');
    const outbound=await planSync({...f,direction:'export'});
    assert.ok(!outbound.entries.some(entry=>entry.path===path));
    await applySync(outbound,join(f.parent,'export-recovery'));
    assert.equal(await readFile(join(f.peer,path),'utf8'),'public first\nshared middle\npublic updated\n');
    await write(f.peer,path,'public conflicting\nshared middle\npublic updated\n');
    assert.ok(summarize(await planSync({...f,direction:'import'})).blocked.some(entry=>entry.path===path));
    f.manifest.importOnly[0].sha256='0'.repeat(64);
    await write(f.root,'docs/shared-core-sync.json',JSON.stringify(f.manifest));
    await assert.rejects(planSync({...f,direction:'import'}),/baseline integrity/);
  });
  await test('mapped import-only paths preserve company edits, detect source races and refuse escaped mappings',async()=>{
    const f=await fixture(),path='src-native/src/core.rs',peerPath='tools/build/public-core.mjs';
    const base='public first\nshared middle\npublic last\n';
    const baseBlob=git(f.root,['hash-object','-w','--stdin'],base);
    f.manifest.importOnly=[{path,peerPath,baseBlob,sha256:sha(base)}];
    await write(f.root,'docs/shared-core-sync.json',JSON.stringify(f.manifest));
    await write(f.root,path,'extension first\nshared middle\npublic last\n');
    await write(f.peer,peerPath,'public first\nshared middle\npublic updated\n');
    let plan=await planSync({...f,direction:'import'});
    assert.deepEqual(summarize(plan).mappedImportFiles,[{path,peerPath}]);
    await write(f.peer,peerPath,'external first\nshared middle\npublic updated\n');
    await assert.rejects(applySync(plan,join(f.parent,'raced-recovery')),/External change retained/);
    assert.equal(await readFile(join(f.root,path),'utf8'),'extension first\nshared middle\npublic last\n');
    await write(f.peer,peerPath,'public first\nshared middle\npublic updated\n');
    plan=await planSync({...f,direction:'import'});
    await applySync(plan,join(f.parent,'mapped-recovery'));
    assert.equal(await readFile(join(f.root,path),'utf8'),'extension first\nshared middle\npublic updated\n');
    assert.equal(await readFile(join(f.peer,peerPath),'utf8'),'public first\nshared middle\npublic updated\n');
    assert.ok(!(await planSync({...f,direction:'export'})).entries.some(entry=>entry.path===path));
    f.manifest.importOnly[0].peerPath='../escape';
    await write(f.root,'docs/shared-core-sync.json',JSON.stringify(f.manifest));
    await assert.rejects(planSync({...f,direction:'import'}),/Unsafe shared path/);
  });
  console.log(JSON.stringify({passed:true,checks,isolatedRepositories:true,realProductRepositoriesWritten:false}));
}finally{await rm(temporary,{recursive:true,force:true});}
