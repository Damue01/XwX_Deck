import { nativeTestBinary, writeCliFixture } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdtemp, realpath, writeFile, mkdir, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const fixture=await mkdtemp(join(await realpath(tmpdir()),'xwx-subscription-usage-')), root=join(fixture,'pilot');
const calls=[];let malformed=false;
const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;calls.push({path:req.url,auth:req.headers.authorization});res.setHeader('content-type','application/json');if(malformed){res.end('{}');return;}
 const reset=new Date(Date.now()+3600000).toISOString();
 if(req.url==='/copilot_internal/user'){assert.equal(req.headers.authorization,'token fixture-github');res.end(JSON.stringify({quota_reset_date_utc:reset,quota_snapshots:{premium_interactions:{percent_remaining:72,entitlement:300,quota_remaining:216}}}));}
 else if(req.url==='/api/oauth/usage'){assert.equal(req.headers.authorization,'Bearer fixture-claude');assert.equal(req.headers['anthropic-beta'],'oauth-2025-04-20');res.end(JSON.stringify({five_hour:{utilization:20,resets_at:reset},seven_day:{utilization:40,resets_at:reset}}));}
 else if(req.url==='/aiserver.v1.DashboardService/GetCurrentPeriodUsage'){assert.equal(req.headers.authorization,'Bearer fixture-cursor');assert.equal(req.headers['connect-protocol-version'],'1');res.end(JSON.stringify({planUsage:{totalPercentUsed:35,autoPercentUsed:5,apiPercentUsed:30},billingCycleEnd:String(Date.now()+3600000)}));}
 else if(req.url==='/grok/v1/billing?format=credits'){assert.equal(req.headers.authorization,'Bearer fixture-grok');assert.equal(req.headers['x-xai-token-auth'],'xai-grok-cli');res.end(JSON.stringify({config:{creditUsagePercent:45,currentPeriod:{type:'USAGE_PERIOD_TYPE_MONTHLY',end:reset}}}));}
 else {res.writeHead(404);res.end('{}');}
});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
let child,queue=[];const cli=await writeCliFixture(join(fixture,'grok-fixture'), 'console.log("Grok Build 1.2.3");');
const start=()=>{child=spawn(nativeTestBinary,['--rpc','--pilot-root',root,'--subscription-test-endpoint',base,'--subscription-test-grok-cli',cli],{stdio:['pipe','pipe','inherit']});createInterface({input:child.stdout}).on('line',line=>queue.shift()?.(JSON.parse(line)));};
const rpc=(method,...args)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('RPC timeout '+method)),20000);queue.push(r=>{clearTimeout(timer);r.ok?resolve(r.result):reject(new Error(r.error));});child.stdin.write(JSON.stringify({method,args})+'\n');});
const stop=async()=>{const done=once(child,'exit');child.stdin.end();assert.equal((await done)[0],0);};
try{
 // The CLI is a sibling of the empty pilot directory.
 start();await rpc('getState');await stop();
 await writeFile(join(root,'copilot-accounts.json'),JSON.stringify([{id:'copilot-fixture',label:'Copilot fixture',subject:'fixture',login:'fixture',github:'fixture-github',access:'fixture-inference',expires:Math.floor(Date.now()/1000)+3600,api:base+'/v1',needs_login:false}]));
 await writeFile(join(root,'cursor-accounts.json'),JSON.stringify([{id:'cursor-fixture',label:'Cursor fixture',email:'fixture@example.test',token:'fixture-cursor',expires:Date.now()+3600000,signed_out:false}]));
 await writeFile(join(root,'claude-subscription-accounts.json'),JSON.stringify([{id:'claude-subscription-fixture',label:'Claude fixture',email:'fixture@example.test',directory:'claude-fixture',signed_out:false}]));
 const claude=join(root,'claude-subscription-homes/claude-fixture');await mkdir(claude,{recursive:true});await writeFile(join(claude,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'fixture-claude',refreshToken:'fixture-refresh',expiresAt:Date.now()+3600000}}));
 const grokId='grok-'+ 'a'.repeat(36),grok=join(root,'grok-accounts',grokId);await mkdir(grok,{recursive:true});await writeFile(join(root,'grok-accounts/accounts.json'),JSON.stringify([{id:grokId,label:'Grok fixture',email:'fixture@example.test'}]));await writeFile(join(grok,'auth.json'),JSON.stringify({fixture:{key:'fixture-grok',expires_at:new Date(Date.now()+3600000).toISOString()}}));
 start();let checks=0;
 for(const [platform,remaining] of [['copilot',72],['claude',60],['cursor',65],['grok',55]]){const snapshot=await rpc('refreshSubscriptionUsage',{platform});const account=snapshot.accounts.find(a=>a.platform===platform);assert.equal(account.quota.remainingPercent,remaining);assert.ok(account.quota.resetsAt>Date.now()/1000);checks++;console.log('PASS '+platform+' reads verified percentage/reset using its own credential and official request shape');}
 const at=calls.length;for(let i=0;i<10;i++)await rpc('getSubscriptionAccounts');assert.equal(calls.length,at);checks++;console.log('PASS account metadata polling does not issue quota network requests');
 await assert.rejects(rpc('refreshSubscriptionUsage',{platform:'chatgpt'}),/暂未提供/);assert.equal(calls.length,at);checks++;console.log('PASS ChatGPT OSS login never sends its token to an unverified Codex usage endpoint');
 malformed=true;await assert.rejects(rpc('refreshSubscriptionUsage',{platform:'copilot'}),/没有可确认/);assert.equal((await rpc('getSubscriptionAccounts')).accounts.find(a=>a.platform==='copilot').quota.remainingPercent,72);checks++;console.log('PASS malformed quota does not overwrite the last verified reading with zero or unlimited');
 assert.ok(!JSON.stringify(await rpc('getSubscriptionAccounts')).includes('fixture-github'));assert.ok(!String(await readFile(join(root,'subscription-routing.json')).catch(()=>'' )).includes('fixture-github'));
 await stop();console.log(JSON.stringify({ok:true,checks,httpRequests:calls.length,root}));
}finally{if(child?.exitCode===null)child.kill('SIGTERM');server.closeAllConnections();server.close();}
