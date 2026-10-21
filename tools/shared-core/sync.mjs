import {createIdentifierMatcher} from './privacy-identifiers.mjs';
import {isEditionPath,assertRuntimeInventory} from './inventory.mjs';
import { readFile, writeFile, mkdir, realpath, lstat, rename, rm, mkdtemp, link } from 'node:fs/promises';
import { resolve, join, dirname, basename, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, path) => { const rel=relative(root,path); return rel && !rel.startsWith('..') && !isAbsolute(rel); };
function git(root, args, options={}) {
  const result=spawnSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:8*1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'},...options});
  if(result.status!==0)throw Error(`Git operation failed: ${args[0]}`);
  return options.encoding===null?result.stdout:result.stdout.trim();
}
function validPath(path) {
  if(typeof path!=='string'||/[\\\x00-\x1f]/.test(path)||path.split('/').some(p=>!p||p==='.'||p==='..')||isAbsolute(path))throw Error('Unsafe shared path');
}
async function safeRead(root,path) {
  validPath(path);
  const parts=path.split('/');let next=root;
  for(let n=0;n<parts.length;n++) {
    next=join(next,parts[n]);
    let stat;
    try {stat=await lstat(next);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    if(stat.isSymbolicLink()||(n<parts.length-1?!stat.isDirectory():!stat.isFile()))throw Error(`Shared path is not a regular file: ${path}`);
    if(n===parts.length-1&&stat.size>16*1024*1024)throw Error(`Shared file exceeds 16 MiB: ${path}`);
  }
  const bytes=await readFile(next);
  if(!Buffer.from(bytes.toString('utf8')).equals(bytes))throw Error(`Shared file is not UTF-8: ${path}`);
  return bytes;
}
function snapshot(root) {return {branch:git(root,['branch','--show-current']),commit:git(root,['rev-parse','HEAD']),status:git(root,['status','--porcelain'])};}
async function merge(root,base,target,source) {
  // Git checkouts on Windows may use CRLF while embedded baselines use LF.
  // Compare content before merging so line endings cannot disguise whole-file conflicts.
  const originalTarget=target;
  const lf=bytes=>Buffer.from(bytes.toString('utf8').replace(/\r\n/g,'\n'));
  base=lf(base);target=lf(target);source=lf(source);
  if(target.equals(source)||source.equals(base))return {bytes:originalTarget,conflict:false};
  if(target.equals(base))return {bytes:source,conflict:false};
  const temp=await mkdtemp(join(await realpath(tmpdir()),'xwxdeck-shared-merge-'));
  try {
    for(const [name,bytes] of [['base',base],['target',target],['source',source]])await writeFile(join(temp,name),bytes,{mode:0o600});
    const result=spawnSync('git',['-C',root,'merge-file','-p','--diff3','-L','target','-L','baseline','-L','source',join(temp,'target'),join(temp,'base'),join(temp,'source')],{maxBuffer:8*1024*1024});
    if(result.status===null||result.status<0||result.status>127)throw Error('Three-way merge failed');
    return {bytes:result.stdout,conflict:result.status!==0};
  }finally{await rm(temp,{recursive:true,force:true});}
}
function boundaryPatterns(policy) {
  return [...(policy.forbiddenPackagedPatterns??[]), 'gitlab\\.papegames\\.com', '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', '\\bsk-[A-Za-z0-9_-]{24,}']
    .map(pattern=>new RegExp(pattern,'iu')).concat([{test:createIdentifierMatcher(policy.forbiddenIdentifierDigests??[])}]);
}
export async function planSync({root,peer,direction}) {
  if(!['import','export'].includes(direction))throw Error('Direction must be import or export');
  root=await realpath(root);peer=await realpath(peer);if(root===peer)throw Error('Repositories must be different');
  const manifest=JSON.parse(await readFile(join(root,'docs/shared-core-sync.json'),'utf8'));
  if(![1,2].includes(manifest.schemaVersion)||!Array.isArray(manifest.shared))throw Error('Unsupported shared manifest');
  const policy=manifest.schemaVersion===2 ? JSON.parse(await readFile(join(root,'tools/shared-core/export-policy.json'),'utf8')) : JSON.parse(await readFile(join(root,'public-release-policy.json'),'utf8'));
  if(manifest.schemaVersion===2){
    if((manifest.importOnly?.length??0)||(manifest.mixed?.length??0)||(manifest.reviewedDifferences?.length??0))throw Error('Common source cannot contain variant exceptions');
    for(const entry of manifest.shared)if(isEditionPath(entry.path))throw Error('Edition module is outside the common boundary');
    await assertRuntimeInventory(root,manifest.shared);await assertRuntimeInventory(peer,manifest.shared);
    const peerManifest=await safeRead(peer,'docs/shared-core-sync.json');
    if(!peerManifest||peerManifest.toString().replaceAll('\r\n','\n')!==(await readFile(join(root,'docs/shared-core-sync.json'),'utf8')).replaceAll('\r\n','\n'))throw Error('Counterpart common manifest differs; reconcile the baseline first');
  }
  const sourceRoot=direction==='import'?peer:root,targetRoot=direction==='import'?root:peer;
  const entries=[],names=new Set(),sourcePaths=new Map();
  // Public modules with company additions are imported with their own public
  // baseline. They never enter the outbound whitelist.
  const importOnly=manifest.importOnly??[];
  if(!Array.isArray(importOnly))throw Error('Unsupported import-only manifest');
  const records=direction==='import'?[...manifest.shared,...importOnly]:manifest.shared;
  for(const entry of records) {
    const path=entry.path;validPath(path);
    if(entry.peerPath!==undefined){validPath(entry.peerPath);if(!importOnly.includes(entry))throw Error('Path mappings are import-only');}
    const sourcePath=direction==='import'?(entry.peerPath??path):path;
    sourcePaths.set(path,sourcePath);
    if(names.has(path)||!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.baseBlob))throw Error('Invalid or duplicate shared entry');names.add(path);
    if((policy.excludedPaths??[]).some(excluded=>path===excluded||path.startsWith(excluded+'/')))throw Error(`Internal-only path in shared manifest: ${path}`);
    // Mixed public baselines may never have existed as company tree files.
    // Embed their compressed bytes so clones and Git garbage collection retain
    // the baseline without importing another repository's history.
    const base=entry.baselineGzip
      ? gunzipSync(Buffer.from(entry.baselineGzip,'base64'),{maxOutputLength:16*1024*1024})
      : Buffer.from(git(root,['cat-file','blob',entry.baseBlob],{encoding:null}));
    if(entry.baselineGzip&&createHash(entry.baseBlob.length===40?'sha1':'sha256').update(`blob ${base.length}\0`).update(base).digest('hex')!==entry.baseBlob)throw Error(`Shared baseline blob failed: ${path}`);
    // cat-file must preserve trailing newlines and exact bytes.
    if(sha(base)!==entry.sha256)throw Error(`Shared baseline integrity failed: ${path}`);
    if(entry.initiallyAbsent && base.length)throw Error(`New shared module requires an empty baseline: ${path}`);
    const source=await safeRead(sourceRoot,sourcePath),target=await safeRead(targetRoot,path);
    if(entry.initiallyAbsent && !source) {entries.push({path,status:'unchanged',source,target,conflict:false});continue;}
    if(entry.initiallyAbsent && source && !target) {
      const blocked=direction==='export'&&boundaryPatterns(policy).some(pattern=>pattern.test(source.toString('utf8')));
      entries.push({path,source,target,next:source,conflict:blocked,status:blocked?'public-boundary-blocked':'update'});continue;
    }
    if(!source||!target){entries.push({path,status:!source?'source-deletion-review-required':'target-deletion-review-required',source,target,conflict:true});continue;}
    const merged=await merge(root,base,target,source);
    const blocked=direction==='export'&&boundaryPatterns(policy).some(pattern=>pattern.test(merged.bytes.toString('utf8')));
    entries.push({path,source,target,next:merged.bytes,conflict:merged.conflict||blocked,status:blocked?'public-boundary-blocked':merged.conflict?'conflict':merged.bytes.equals(target)?'unchanged':'update'});
  }
  for(const entry of entries)entry.sourcePath=sourcePaths.get(entry.path);
  const variants=[];
  for(const entry of manifest.mixed??[]) {
    if(direction==='import'&&(manifest.importOnly??[]).some(record=>record.path===entry.path))continue;
    const internal=await safeRead(root,entry.path),publicFile=await safeRead(peer,entry.path);
    if(!internal||!publicFile||sha(internal)!==entry.internalSha256||sha(publicFile)!==entry.publicSha256)variants.push(entry.path);
  }
  return {root,peer,direction,sourceRoot,targetRoot,sourceSnapshot:snapshot(sourceRoot),targetSnapshot:snapshot(targetRoot),entries,variants,mixedFiles:manifest.mixed?.length??0,importOnlyFiles:manifest.importOnly?.length??0,internalOnlyFiles:manifest.internalOnly?.length??0};
}
export function summarize(plan) {
  return {direction:plan.direction,source:plan.sourceSnapshot,target:plan.targetSnapshot,sharedFiles:plan.entries.length,
    mappedImportFiles:plan.entries.filter(e=>e.sourcePath!==e.path).map(e=>({path:e.path,peerPath:e.sourcePath})),
    updates:plan.entries.filter(e=>e.status==='update').map(e=>e.path),blocked:plan.entries.filter(e=>e.conflict).map(e=>({path:e.path,status:e.status})),
    mixedFiles:plan.mixedFiles,importOnlyFiles:plan.importOnlyFiles,internalOnlyFilesPreserved:plan.internalOnlyFiles,changedMixedFilesRequiringIntegration:plan.variants,editionOnlyFilesTransferred:false,publicHistoryTransferred:false};
}
async function outputDirectory(plan,output) {
  output=resolve(output);
  const physical=join(await realpath(dirname(output)),basename(output));
  for(const root of [plan.root,plan.peer])if(physical===root||within(root,physical))throw Error('Recovery output must be outside both repositories');
  await mkdir(physical,{recursive:false,mode:0o700});return physical;
}
export async function writePreview(plan,output) {
  const directory=await outputDirectory(plan,output);const temp=await mkdtemp(join(await realpath(tmpdir()),'xwxdeck-shared-diff-'));
  let patch='';
  try {
    for(const entry of plan.entries.filter(e=>e.next&&(!e.target||!e.next.equals(e.target)))) {
      for(const [name,bytes] of [['before',entry.target],['after',entry.next]]) {
        const path=join(temp,name,entry.path);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,bytes??Buffer.alloc(0),{mode:0o600});
      }
      const result=spawnSync('git',['diff','--no-index','--no-ext-diff','--','before/'+entry.path,'after/'+entry.path],{cwd:temp,encoding:'utf8',maxBuffer:8*1024*1024});
      if(![0,1].includes(result.status))throw Error('Review patch generation failed');
      let diff=result.stdout.replaceAll('a/before/','a/').replaceAll('b/after/','b/');
      if(!entry.target)diff=diff.replace(`--- a/${entry.path}`, '--- /dev/null').replace(/^(diff --git[^\n]+\n)/, '$1new file mode 100644\n').replace(/^index [a-f0-9]+\.\.([a-f0-9]+) 100644$/m, 'index 0000000..$1');
      patch+=diff;
    }
    await writeFile(join(directory,'review.patch'),patch,{mode:0o600,flag:'wx'});
    await writeFile(join(directory,'summary.json'),JSON.stringify(summarize(plan),null,2)+'\n',{mode:0o600,flag:'wx'});
    return {reviewDirectory:directory,patchSha256:sha(patch)};
  }finally{await rm(temp,{recursive:true,force:true});}
}
async function verify(plan) {
  for(const entry of plan.entries)for(const [root,path,expected] of [[plan.sourceRoot,entry.sourcePath??entry.path,entry.source],[plan.targetRoot,entry.path,entry.target]]) {
    const current=await safeRead(root,path);
    if((current===null)!==(expected===null)||(current&&sha(current)!==sha(expected)))throw Error(`External change retained; rerun preview: ${entry.path}`);
  }
}
export async function applySync(plan,output,{renameFile=rename,publishNewFile=link}={}) {
  if(plan.entries.some(e=>e.conflict))throw Error('Resolve blocked files before applying any shared change');
  const directory=await outputDirectory(plan,output);
  const changes=plan.entries.filter(e=>e.status==='update');
  const journal={version:1,status:'prepared',direction:plan.direction,files:changes.map(e=>({path:e.path,beforeSha256:e.target?sha(e.target):null,afterSha256:sha(e.next)}))};
  const journalPath=join(directory,'journal.json');
  const staged=[];
  try {
    await verify(plan);
    for(const entry of changes) {
      if(entry.target) {const backup=join(directory,'before',entry.path);await mkdir(dirname(backup),{recursive:true,mode:0o700});await writeFile(backup,entry.target,{mode:0o600,flag:'wx'});}
      const temporary=join(dirname(join(plan.targetRoot,entry.path)),`.shared-sync-${randomUUID()}.tmp`);
      // New modules are allowed only in existing regular directories. safeRead
      // above rejects symlink parents; publishing uses an exclusive hard link.
      const parent=await lstat(dirname(temporary));if(!parent.isDirectory()||parent.isSymbolicLink())throw Error('Shared module parent must be a regular directory');
      const mode=entry.target?(await lstat(join(plan.targetRoot,entry.path))).mode&0o777:0o644;
      await writeFile(temporary,entry.next,{mode,flag:'wx'});staged.push({entry,temporary,mode,applied:false});
    }
    await writeFile(journalPath,JSON.stringify(journal,null,2)+'\n',{mode:0o600,flag:'wx'});
    await verify(plan);
    for(const item of staged) {
      const current=await safeRead(plan.targetRoot,item.entry.path);
      const source=await safeRead(plan.sourceRoot,item.entry.sourcePath??item.entry.path);
      if(!source||sha(source)!==sha(item.entry.source))throw Error(`Source changed; rerun preview: ${item.entry.path}`);
      if(item.entry.target ? !current||sha(current)!==sha(item.entry.target) : current!==null)throw Error(`External change retained: ${item.entry.path}`);
      if(item.entry.target)await renameFile(item.temporary,join(plan.targetRoot,item.entry.path));
      else await publishNewFile(item.temporary,join(plan.targetRoot,item.entry.path));
      item.applied=true;
    }
    journal.status='complete';await writeFile(journalPath,JSON.stringify(journal,null,2)+'\n',{mode:0o600});
    return {applied:changes.length,recoveryDirectory:directory};
  }catch(error){
    // Roll back only bytes that still match our write. External edits survive.
    const retained=[],incomplete=[];
    for(const item of staged.toReversed())if(item.applied) {
      const current=await safeRead(plan.targetRoot,item.entry.path).catch(()=>null);
      if(current&&sha(current)===sha(item.entry.next)) {
        const temp=join(dirname(join(plan.targetRoot,item.entry.path)),`.shared-rollback-${randomUUID()}.tmp`);
        try {
          if(item.entry.target){await writeFile(temp,item.entry.target,{mode:item.mode,flag:'wx'});await renameFile(temp,join(plan.targetRoot,item.entry.path));}
          else await rm(join(plan.targetRoot,item.entry.path));
        }catch{incomplete.push(item.entry.path);}
        finally{await rm(temp,{force:true}).catch(()=>{});}
      } else retained.push(item.entry.path);
    }
    journal.status='failed';journal.externalEditsRetained=retained;journal.rollbackIncomplete=incomplete;
    await writeFile(journalPath,JSON.stringify(journal,null,2)+'\n',{mode:0o600});
    throw Error(`${error.message}; recovery journal: ${journalPath}`);
  }finally{for(const item of staged)await rm(item.temporary,{force:true});}
}
export async function acceptBaseline({root,peer,output}) {
  const plan=await planSync({root,peer,direction:'import'});
  const path='docs/shared-core-sync.json',before=await safeRead(plan.root,path),manifest=JSON.parse(before);
  if(plan.entries.some(e=>!e.source||!e.target||e.source.toString().replaceAll('\r\n','\n')!==e.target.toString().replaceAll('\r\n','\n')))throw Error('Synchronize every common file before accepting a baseline');
  if(manifest.schemaVersion===2)return acceptCommonBaseline(plan,manifest,output);
  const updated=[];
  for(const entry of plan.entries) {
    if(!entry.source||!entry.target||!entry.source.equals(entry.target))continue;
    const hash=sha(entry.target),record=manifest.shared.find(r=>r.path===entry.path);
    if(hash===record.sha256)continue;
    for(const repo of [plan.root,plan.peer]) {
      const committed=git(repo,['show',`HEAD:${entry.path}`],{encoding:null});
      if(!Buffer.from(committed).equals(entry.target))throw Error(`Commit both shared files before accepting baseline: ${entry.path}`);
    }
    if(boundaryPatterns(JSON.parse(await readFile(join(plan.root,manifest.schemaVersion===2?'tools/shared-core/export-policy.json':'public-release-policy.json'),'utf8'))).some(p=>p.test(entry.target.toString('utf8'))))throw Error('Public boundary blocks baseline acceptance');
    const normalized=Buffer.from(entry.target.toString().replaceAll('\r\n','\n'));record.baseBlob=createHash('sha1').update(`blob ${normalized.length}\0`).update(normalized).digest('hex');record.sha256=sha(normalized);record.baselineGzip=gzipSync(normalized,{mtime:0}).toString('base64');delete record.initiallyAbsent;updated.push(entry.path);
  }
  if(!updated.length)return {updated:[]};
  await verify(plan);
  const directory=await outputDirectory(plan,output);
  await writeFile(join(directory,'shared-core-sync-before.json'),before,{mode:0o600,flag:'wx'});
  const current=await safeRead(plan.root,path);if(!current.equals(before))throw Error('Shared manifest changed; original retained');
  const temporary=join(plan.root,'docs',`.shared-baseline-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary,JSON.stringify(manifest,null,2)+'\n',{mode:0o644,flag:'wx'});
    if(!(await safeRead(plan.root,path)).equals(before))throw Error('Shared manifest changed; original retained');
    await rename(temporary,join(plan.root,path));
    if(manifest.schemaVersion===2) await writeFile(join(plan.peer,path),JSON.stringify(manifest,null,2)+'\n');
  }finally{await rm(temporary,{force:true});}
  return {updated,recoveryDirectory:directory};
}

async function acceptCommonBaseline(plan, manifest, output) {
  const path = 'docs/shared-core-sync.json';
  const before = await Promise.all([plan.root, plan.peer].map(root => safeRead(root, path)));
  if (!before[0] || !before[1] || !before[0].equals(before[1])) throw Error('Both common manifests must have the same baseline');
  const policy = JSON.parse(await readFile(join(plan.root, 'tools/shared-core/export-policy.json'), 'utf8'));
  const updated = [];
  for (const entry of plan.entries) {
    const normalized = Buffer.from(entry.source.toString().replaceAll('\r\n', '\n'));
    if (boundaryPatterns(policy).some(pattern => pattern.test(normalized.toString()))) throw Error('Export boundary blocks common baseline');
    for (const root of [plan.root, plan.peer]) {
      const committed = git(root, ['show', 'HEAD:' + entry.path], { encoding: null });
      if (Buffer.from(committed.toString().replaceAll('\r\n', '\n')).compare(normalized)) throw Error('Commit both shared files before accepting baseline: ' + entry.path);
    }
    const record = manifest.shared.find(record => record.path === entry.path);
    if (record.sha256 === sha(normalized)) continue;
    Object.assign(record, {baseBlob: createHash('sha1').update('blob ' + normalized.length + '\0').update(normalized).digest('hex'), sha256: sha(normalized), baselineGzip: gzipSync(normalized).toString('base64')});
    delete record.initiallyAbsent;
    updated.push(entry.path);
  }
  if (!updated.length) return {updated: []};
  const directory = await outputDirectory(plan, output);
  const next = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const staged = [];
  try {
    await verify(plan);
    for (const [index, root] of [plan.root, plan.peer].entries()) {
      await writeFile(join(directory, 'manifest-before-' + index + '.json'), before[index], {flag: 'wx'});
      const temporary = join(root, 'docs', '.shared-baseline-' + randomUUID() + '.tmp');
      await writeFile(temporary, next, {flag: 'wx'});
      staged.push({root, temporary, before: before[index], applied: false});
    }
    for (const item of staged) {
      await verify(plan);
      if (!(await safeRead(item.root, path)).equals(item.before)) throw Error('Manifest changed; original retained');
      await rename(item.temporary, join(item.root, path));
      item.applied = true;
    }
    await writeFile(join(directory, 'baseline-result.json'), JSON.stringify({status:'complete', updated}) + '\n');
    return {updated, recoveryDirectory: directory};
  } catch (error) {
    for (const item of staged.toReversed()) if (item.applied && (await safeRead(item.root, path))?.equals(next)) {
      const temporary = join(item.root, 'docs', '.shared-baseline-rollback-' + randomUUID() + '.tmp');
      await writeFile(temporary, item.before, {flag:'wx'});
      await rename(temporary, join(item.root, path));
    }
    throw error;
  } finally {for (const item of staged) await rm(item.temporary, {force:true});}
}

async function main() {
  const args=process.argv.slice(2),known=new Set(['--peer','--direction','--apply','--accept-baseline','--output']);
  const options={};for(let n=0;n<args.length;n++){if(!known.has(args[n]))throw Error('Unknown argument');options[args[n]]=['--apply','--accept-baseline'].includes(args[n])?true:args[++n];}
  if(options['--accept-baseline']) {
    if(!options['--peer']||!options['--output']||options['--apply'])throw Error('Baseline acceptance requires --peer and a new --output directory');
    console.log(JSON.stringify(await acceptBaseline({root:resolve(import.meta.dirname,'../..'),peer:resolve(options['--peer']),output:options['--output']}),null,2));return;
  }
  if(!options['--peer']||!options['--direction']||(options['--apply']&&!options['--output']))throw Error('Usage: node tools/shared-core/sync.mjs --peer PATH --direction import|export [--apply --output NEW_RECOVERY_DIRECTORY]');
  const plan=await planSync({root:resolve(import.meta.dirname,'../..'),peer:resolve(options['--peer']),direction:options['--direction']});
  const report=summarize(plan);
  if(options['--apply'])report.application=await applySync(plan,options['--output']);
  else if(options['--output'])report.preview=await writePreview(plan,options['--output']);
  console.log(JSON.stringify(report,null,2));
  if(report.blocked.length)process.exitCode=2;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
