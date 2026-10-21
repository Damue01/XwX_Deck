import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {planSync,applySync,acceptBaseline} from './sync.mjs';
const directory=await mkdtemp(join(tmpdir(),'xwx-common-contract-'));
const root=join(directory,'a'),peer=join(directory,'b');
const hash=s=>createHash('sha256').update(s).digest('hex');
const git=(cwd,args)=>{const r=spawnSync('git',['-C',cwd,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
const write=async(repo,path,text)=>{await mkdir(join(repo,path,'..'),{recursive:true});await writeFile(join(repo,path),text);};
try {
 const content='export const value = 1;\n',path='src/shared/common.ts';
 const manifest={schemaVersion:2,shared:[{path,sha256:hash(content),baseBlob:createHash('sha1').update('blob '+Buffer.byteLength(content)+'\0').update(content).digest('hex'),baselineGzip:gzipSync(content).toString('base64')}],importOnly:[],mixed:[]};
 for(const repo of [root,peer]) {
  await mkdir(repo);git(repo,['init','-q']);git(repo,['config','user.name','Fixture']);git(repo,['config','user.email','fixture@example.invalid']);
  await write(repo,path,content);await mkdir(join(repo,'src-native/src'),{recursive:true});
  await write(repo,'src/shared/edition.ts',repo===root?'extension A\n':'extension B\n');
  await write(repo,'docs/shared-core-sync.json',JSON.stringify(manifest,null,2)+'\n');
  await cp(new URL('./',import.meta.url),join(repo,'tools/shared-core'),{recursive:true});
  git(repo,['add','.']);git(repo,['commit','-qm','Fixture baseline']);
 }
 const audit=repo=>spawnSync(process.execPath,[join(repo,'tools/shared-core/audit-parity.mjs'),'--peer='+ (repo===root?peer:root)],{encoding:'utf8'});
 assert.equal(audit(root).status,0);assert.equal(audit(peer).status,0);
 const changed='export const value = 2;\n';await write(root,path,changed);
 assert.equal(audit(root).status,1);assert.equal(audit(peer).status,1);
 await applySync(await planSync({root,peer,direction:'export'}),join(directory,'export-recovery'));
 assert.equal(await readFile(join(peer,path),'utf8'),changed);
 git(root,['add','.']);git(root,['commit','-qm','Common repair']);git(peer,['add','.']);git(peer,['commit','-qm','Same repair']);
 await acceptBaseline({root,peer,output:join(directory,'baseline-recovery')});
 assert.equal(audit(root).status,0);assert.equal(audit(peer).status,0);
 await write(peer,'src/shared/new.ts','new module\n');await assert.rejects(planSync({root,peer,direction:'import'}),/not registered/);assert.equal(audit(root).status,1);
 await rm(join(peer,'src/shared/new.ts'));
 const altered=JSON.parse(await readFile(join(root,'docs/shared-core-sync.json'),'utf8'));altered.reviewedDifferences=[{path}];await write(root,'docs/shared-core-sync.json',JSON.stringify(altered));
 await assert.rejects(planSync({root,peer,direction:'export'}),/variant exceptions/);assert.equal(audit(root).status,1);
 altered.reviewedDifferences=[];altered.schemaVersion=1;for(const repo of [root,peer])await write(repo,'docs/shared-core-sync.json',JSON.stringify(altered));assert.equal(audit(root).status,1);assert.equal(audit(peer).status,1);
 console.log('PASS strict common contract: both directions, both gates, edition isolation, baseline integrity, new files and rejected exceptions');
} finally {await rm(directory,{recursive:true,force:true});}
