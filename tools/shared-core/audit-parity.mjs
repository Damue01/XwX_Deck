import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {assertRuntimeInventory,isEditionPath} from './inventory.mjs';
const root=resolve(import.meta.dirname,'../..');
const manifest=JSON.parse(await readFile(resolve(root,'docs/shared-core-sync.json'),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes.toString().replaceAll('\r\n','\n')).digest('hex');
const configuredPeer=process.env.XWX_SHARED_CORE_PEER ?? await readFile(resolve(root,'.shared-core-peer'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
const peer=process.argv.find(a=>a.startsWith('--peer='))?.slice(7) || configuredPeer.trim();
const report={schemaVersion:manifest.schemaVersion,comparedFiles:0,identical:0,fullyIdentical:false,peerVerified:!!peer,unreviewed:[],differences:[]};
if(manifest.schemaVersion!==2)report.unreviewed.push('Common manifest version 2 is required');
if(peer){const other=await readFile(resolve(peer,'docs/shared-core-sync.json'),'utf8').catch(()=>null);if(!other||JSON.stringify(JSON.parse(other))!==JSON.stringify(manifest))report.unreviewed.push('Counterpart common manifest differs');}
if(manifest.schemaVersion===2){
 if((manifest.importOnly?.length??0)||(manifest.mixed?.length??0)||(manifest.reviewedDifferences?.length??0))report.unreviewed.push('Common source cannot have variant exceptions');
 for(const repo of [root,...(peer?[resolve(peer)]:[])])try{await assertRuntimeInventory(repo,manifest.shared);}catch(e){report.unreviewed.push(e.message);}
}
for(const entry of manifest.shared){
 report.comparedFiles++;
 try {
  if(isEditionPath(entry.path))throw Error('Edition module registered as common source');
  const bytes=await readFile(resolve(root,entry.path));const current=hash(bytes);const expected=entry.sha256;
  if(entry.baselineGzip&&hash(gunzipSync(Buffer.from(entry.baselineGzip,'base64'),{maxOutputLength:16*1024*1024}))!==expected)throw Error('Corrupt common baseline');
  const remote=peer?hash(await readFile(resolve(peer,entry.path))):expected;
  if(current===expected&&remote===expected)report.identical++;
  else {report.differences.push({path:entry.path,baseline:expected,current,peer:remote});report.unreviewed.push(entry.path);}
 } catch(e){report.unreviewed.push(entry.path+': '+e.message);}
}
report.fullyIdentical=report.identical===report.comparedFiles&&!report.unreviewed.length;
const out=process.argv.find(a=>a.startsWith('--output='))?.slice(9);if(out)await writeFile(resolve(out),JSON.stringify(report,null,2)+'\n');
console.log(process.argv.includes('--quiet')?`Common source: ${report.identical}/${report.comparedFiles} identical; ${report.unreviewed.length} failures; peer verified: ${report.peerVerified}.`:JSON.stringify(report,null,2));
if(!report.fullyIdentical)process.exitCode=1;
