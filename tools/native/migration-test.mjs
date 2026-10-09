import { nativeTestBinary } from './test-support.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,writeFile}from'node:fs/promises';
import{tmpdir}from'node:os';import{join,resolve}from'node:path';import{spawn}from'node:child_process';import{createInterface}from'node:readline';import{once}from'node:events';
const root=await mkdtemp(join(await realpath(tmpdir()),'xwx-native-migration-'));const binary=nativeTestBinary;let child,queue;
function start(){queue=[];child=spawn(binary,['--rpc','--pilot-root',root]);createInterface({input:child.stdout}).on('line',line=>queue.shift()?.(JSON.parse(line)));child.stderr.on('data',d=>process.stderr.write(d));}
function call(method,...args){return new Promise((res,rej)=>{const timer=setTimeout(()=>rej(Error('RPC timeout '+method)),10000);queue.push(v=>{clearTimeout(timer);v.ok?res(v.result):rej(Error(v.error));});child.stdin.write(JSON.stringify({method,args})+'\n');});}
async function end(){const exited=once(child,'exit');child.stdin.end();assert.equal((await exited)[0],0);}
try{
 start();const fresh=await call('getState');await end();
 const date=new Date().toLocaleDateString('sv-SE');
 await writeFile(join(fresh.traceRoot,'index.json'),JSON.stringify({version:1,sessions:[{id:'legacy-fixture',traceCount:1,totalTokens:120,dailyUsage:{[date]:{tokens:120}},recentRatePoints:[{at:new Date().toISOString(),tokens:120}]}],usageOnly:{totalTokens:30,dailyUsage:{[date]:{tokens:30}}}}));
 const settingsPath=join(root,'settings.json');const settings=JSON.parse(await readFile(settingsPath,'utf8'));
 settings.traceWarningGB=3;settings.traceAutoCleanup=false;settings.theme='night';settings.externalPreference={preserve:'yes'};
 settings.providers={version:1,identityVersion:2,connections:[{id:'Retained',codexProviderId:'legacy_alias',displayName:'Retained',providerPreset:'custom',baseUrl:'https://example.invalid/v1',bearerToken:'isolated-fixture',adapter:'responses',codexApiFormat:'responses',codexModel:'retained-model',codexContextWindow:128000,claudeModels:{sonnet:'retained-model'}}],selected:{codex:'Retained',claude:null}};delete settings.connections;delete settings.selected;const original=JSON.stringify(settings);await writeFile(settingsPath,original);
 await writeFile(join(root,'codex/config.toml'),'model_provider = "legacy_alias"\nmodel = "retained-model"\ncustom_external = "keep"\n[model_providers.legacy_alias]\nbase_url = "https://example.invalid/v1"\nwire_api = "responses"\n');
 start();let state=await call('getState');assert.equal(state.traceWarningGB,3);assert.equal(state.traceAutoCleanup,false);assert.equal(state.theme,'night');assert.equal((await call('getProviders')).selected.codex,'Retained');assert.equal(await readFile(join(root,'settings-before-native-migration.json'),'utf8'),original);assert.equal(JSON.parse(await readFile(settingsPath,'utf8')).externalPreference.preserve,'yes');
 const stats=await call('getTraceStats');assert.equal(stats.total.tokens,150);assert.equal(stats.today.tokens,150);assert.equal(stats.week.tokens,150);assert.equal(stats.total.costComplete,false);assert.equal(stats.series[0].tokens,120);
 await call('updateCodexConfig',{compatibleModel:'retained-new-model',expectedProviderId:'Retained'});assert.ok((await readFile(join(root,'codex/config.toml'),'utf8')).includes('custom_external = "keep"'));await call('switchClientProvider',{client:'codex',providerId:null});
 const cache=join(root,'codex/models_cache.json');await writeFile(cache,JSON.stringify({models:[{slug:'official-cache-fixture',visibility:'list',supported_in_api:true,context_window:272000,input_modalities:['text','image'],supported_reasoning_levels:[{effort:'low'},{effort:'high'}]}]}));const catalog=await call('fetchModels');assert.equal(catalog[0].id,'official-cache-fixture');assert.equal(catalog[0].contextWindow,272000);assert.deepEqual(catalog[0].reasoningLevels,['low','high']);assert.ok(catalog.some(e=>e.id==='retained-model'));
 await end();console.log(JSON.stringify({root,passed:6,scope:'legacy settings, explicit retention/model intent, external preferences, legacy provider ownership, read-only official catalog, legacy Trace usage without invented cost'}));
}finally{if(child?.exitCode===null)child.kill('SIGKILL');}
