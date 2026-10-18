// Actual native Viewer APIs with isolated synthetic records. No paid provider calls.
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {startNativeRpc} from './rpc-test-session.mjs';
import {trackWindowsFolderWindows} from './windows-folder-windows.mjs';
const root=await mkdtemp(join(await realpath(tmpdir()),'deck-dashboard-api-'));
let app=startNativeRpc(root);await app.rpc('getState');await app.stop();
const folderWindows=await trackWindowsFolderWindows(root);
const traceRoot=join(root,'traces');await mkdir(traceRoot,{recursive:true});
const file=join(traceRoot,'large.jsonl'),tiny=join(traceRoot,'small.jsonl');
const record=n=>({id:'request-'+n,sessionId:'large',source:'codex-cli',startedAt:new Date(1791800000000+n*1000).toISOString(),request:{model:'fixture',body:{input:'x'.repeat(9*1024*1024)}},response:{statusCode:200},usage:{totalTokens:1}});
await writeFile(file,Array.from({length:5},(_,i)=>JSON.stringify(record(i+1))).join('\n'));
await writeFile(tiny,JSON.stringify({id:'small-request',sessionId:'small',source:'codex-cli',startedAt:'2026-10-13T00:00:00Z',request:{model:'fixture',body:{input:'small fixture'}},usage:{totalTokens:1}})+'\n');
await writeFile(join(traceRoot,'index.json'),JSON.stringify({version:1,sessions:[{id:'large',jsonlPath:file,source:'codex-cli',traceCount:5,captureClassificationVersion:1},{id:'small',jsonlPath:tiny,source:'codex-cli',traceCount:1,captureClassificationVersion:1}]}));
const hashes=await Promise.all([file,tiny,join(traceRoot,'index.json')].map(async p=>createHash('sha256').update(await readFile(p)).digest('hex')));
app=startNativeRpc(root);let passed=false;const checks=[];
try{
 const url=await app.rpc('getDashboardUrl');
 const fonts=resolve('test-results/native-assets/fonts');
 for(const name of await readdir(fonts)){
  const response=await fetch(url+'fonts/'+name);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'font/woff2');
  assert.match(response.headers.get('cache-control'),/immutable/);
  const bytes=Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.equals(await readFile(join(fonts,name))));
  assert.equal(createHash('sha256').update(bytes).digest('hex')+'.woff2',name);
 }
 assert.equal((await fetch(url+'fonts/unknown.woff2')).status,404);
 checks.push('all shared offline fonts are served byte for byte with font MIME and immutable caching; unknown resources return 404');
 const get=async path=>{const r=await fetch(url+path);assert.equal(r.status,200);return r.json()};
 const tail=await get('api/session/large?limit=200');assert.equal(tail.offset,3);assert.deepEqual(tail.traces.map(t=>t.turn),[4,5]);
 const previous=await get('api/session/large?limit=200&before='+tail.offset);assert.equal(previous.offset,1);assert.deepEqual(previous.traces.map(t=>t.turn),[2,3]);
 const first=await get('api/session/large?limit=200&before='+previous.offset);assert.deepEqual(first.traces.map(t=>t.turn),[1]);
 const forward=await get('api/session/large?limit=200&offset=1');assert.equal(forward.offset,1);assert.deepEqual(forward.traces.map(t=>t.turn),[2,3]);
 checks.push('actual native HTTP pages retain newest records and contiguous ordinals across the 24 MiB budget in both directions');
 for(const language of ['en','zh-TW','ja','ko','fr','de','es','pt-BR','zh-CN']){
  assert.equal((await app.rpc('setLanguage',language)).language,language);
  assert.equal((await get('api/state')).language,language);
  assert.equal((await get('api/theme')).language,language);
 }
 checks.push('all nine saved application languages reach state and lightweight Viewer preference APIs');
 await app.stop();app=startNativeRpc(root);const restartedUrl=await app.rpc('getDashboardUrl');
 assert.equal((await(await fetch(restartedUrl+'api/theme')).json()).language,'zh-CN');checks.push('Viewer language follows saved application settings after native process restart');
 const headers={origin:new URL(restartedUrl).origin};
 const refused=await fetch(restartedUrl+'api/session/small/reveal',{method:'POST'});assert.equal(refused.status,403);
 const bad=await fetch(restartedUrl+'api/session/not-a-session/reveal',{method:'POST',headers});assert.equal(bad.status,404);checks.push('reveal rejects unknown sessions without accepting an arbitrary filesystem path');
 if(process.argv.includes('--reveal')){const r=await fetch(restartedUrl+'api/session/small/reveal',{method:'POST',headers});assert.equal(r.status,200);assert.equal((await r.json()).ok,true);checks.push('OS reveal command accepted the isolated session file; physical Finder selection is a separate check')}
 assert.deepEqual(await Promise.all([file,tiny,join(traceRoot,'index.json')].map(async p=>createHash('sha256').update(await readFile(p)).digest('hex'))),hashes);
 checks.push('paging, language synchronization and revealing leave the raw trace and index bytes unchanged');
 const report={passed:true,checks,syntheticRecords:true,normalDataModified:false,boundary:'Programmatic actual native HTTP/storage/settings; no new real upstream request',binarySha256:createHash('sha256').update(await readFile(process.env.XWX_NATIVE_TEST_BINARY||resolve('test-results/native-target/release/xwx-deck-native'))).digest('hex')};
 await mkdir(resolve('test-results'),{recursive:true});await writeFile(resolve('test-results/trace-dashboard-api-summary.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));passed=true;
}finally{
 try{await app.stop();}finally{
  const cleanup=await folderWindows.close();
  if(cleanup.passed===false)passed=false;
  const reportPath=resolve('test-results/trace-dashboard-api-summary.json');
  const report=await readFile(reportPath,'utf8').then(JSON.parse,()=>({passed:false}));
  await writeFile(reportPath,JSON.stringify({...report,passed:passed&&report.passed,folderWindows:cleanup},null,2)+'\n');
  if(cleanup.passed===false)throw Error('Test folder windows remain open');
 }
 if(passed)await rm(root,{recursive:true,force:true});else console.log('Retained failed synthetic fixture: '+root);
}
