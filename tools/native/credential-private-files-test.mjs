import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,writeFile,rm,stat,mkdir,cp,symlink,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {nativeTestBinary} from './test-support.mjs';
const parent=await mkdtemp(join(await realpath(tmpdir()),'deck-private-store-'));
const plainEnv={...process.env};
for(const key of ['XWX_DECK_TEST_SECURE_STORE','XWX_DECK_TEST_PRIVATE_STORE','XWX_DECK_TEST_MIGRATE_PRIVATE_STORE'])delete plainEnv[key];
const legacyEnv={...plainEnv,XWX_DECK_TEST_SECURE_STORE:'1'};
const migrationEnv={...legacyEnv,XWX_DECK_TEST_MIGRATE_PRIVATE_STORE:'1'};
const checks=[],secret='SYNTHETIC-PRIVATE-FILE-KEY';
const request=(method,...args)=>({method,args});
function invoke(root,requests=[request('getProviders')],env=plainEnv){return spawnSync(nativeTestBinary,['--rpc','--pilot-root',root],{env,input:requests.map(v=>JSON.stringify(v)).join('\n')+'\n',encoding:'utf8',timeout:30000});}
function ok(result){assert.equal(result.status,0,result.stderr);const replies=result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);assert.ok(replies.every(r=>r.ok),JSON.stringify(replies));return replies.map(r=>r.result);}
const pass=s=>{checks.push(s);console.log('PASS '+s);};
function windowsAcl(path){
 const script='$ErrorActionPreference="Stop"; $acl=Get-Acl -LiteralPath $env:XWX_TEST_PRIVATE_PATH; $rules=@($acl.Access | ForEach-Object { @{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; rights=[int]$_.FileSystemRights; type=[int]$_.AccessControlType} }); @{protected=$acl.AreAccessRulesProtected; rules=$rules; sddl=$acl.Sddl; owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; currentUser=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value} | ConvertTo-Json -Compress -Depth 5';
 const env={...plainEnv,XWX_TEST_PRIVATE_PATH:path};
 // Windows PowerShell must load its own modules when launched from PowerShell 7.
 delete env.PSModulePath;
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env,encoding:'utf8',windowsHide:true,timeout:30000});
 assert.equal(result.status,0,result.stderr||`private ACL inspection failed: ${result.error?.code??result.signal??'no diagnostic'}`);return JSON.parse(result.stdout);
}
async function privateMode(path,directory=false){
 if(process.platform!=='win32'){assert.equal((await stat(path)).mode&0o777,directory?0o700:0o600);return;}
 const acl=windowsAcl(path);assert.equal(acl.protected,true);assert.equal(acl.owner,acl.currentUser,'private paths must belong to the account, not an elevated parent group');assert.equal(acl.rules.length,1);assert.equal(acl.rules[0].sid,acl.currentUser);assert.equal(acl.rules[0].rights,2032127);assert.equal(acl.rules[0].type,0);
}
try{
 const fresh=join(parent,'fresh');await mkdir(fresh);ok(invoke(fresh,[request('getState'),request('saveProvider',{displayName:'Fixture_84ea73a2',providerPreset:'custom',baseUrl:'https://example.test/v1',adapter:'responses',bearerToken:secret,codexModel:'explicit-model'})]));
 assert.equal(JSON.parse(await readFile(join(fresh,'native-credential-storage.json'))).mode,'private-files');
 await assert.rejects(stat(join(fresh,'native-credential-vault.json')));await assert.rejects(stat(join(fresh,'native-test-vault-key.bin')));
 assert.ok((await readFile(join(fresh,'settings.json'),'utf8')).includes(secret));await privateMode(fresh,true);await privateMode(join(fresh,'settings.json'));
 const providers=ok(invoke(fresh))[0];assert.ok(providers.connections.some(p=>p.bearerToken===secret&&p.codexModel==='explicit-model'));
 pass('fresh private files and restart preserve API keys and explicit models without creating any vault or master key');
 const blocked=invoke(fresh,undefined,legacyEnv);assert.notEqual(blocked.status,0);assert.match(blocked.stderr,/私有文件/);
 const exported=join(parent,'fresh-export');const exportResult=spawnSync(nativeTestBinary,['--export-credential-backup',fresh,'--export-destination',exported,'--export-isolated-test'],{env:plainEnv,encoding:'utf8'});assert.equal(exportResult.status,0,exportResult.stderr);assert.ok((await readFile(join(exported,'settings.json'),'utf8')).includes(secret));await privateMode(exported,true);await privateMode(join(exported,'settings.json'));
 pass('private-file backup export works without vault metadata and old encryption cannot accidentally be re-enabled');
 const legacy=join(parent,'legacy');await mkdir(legacy);ok(invoke(legacy,[request('getState')],legacyEnv));
 const settings=JSON.stringify({nativeMigrationVersion:1,connections:[{id:'private-api',displayName:'API',adapter:'responses',baseUrl:'https://example.test/v1',bearerToken:secret,codexModel:'last-choice'}],selected:{codex:'private-api',claude:null},customExtension:{preserve:true}});
 const documents={'settings.json':settings,'official-chatgpt-accounts.json':JSON.stringify([{id:'official-chatgpt-fixture',auth:{auth_mode:'chatgpt',tokens:{access_token:'synthetic-access',refresh_token:'synthetic-refresh',account_id:'fixture'}}}]),'grok-accounts/grok-fixture/auth.json':JSON.stringify({token:'synthetic-grok'}),'claude-subscription-homes/claude-fixture/.credentials.json':JSON.stringify({claudeAiOauth:{accessToken:'synthetic-claude'}})};
 for(const [name,value] of Object.entries(documents)){await mkdir(dirname(join(legacy,name)),{recursive:true});await writeFile(join(legacy,name),value);}
 const officialSource='{"tokens":{"access_token":"official-source-keep","refresh_token":"source-refresh-keep"}}';await writeFile(join(legacy,'codex/auth.json'),officialSource);
 const quota='{"version":1,"cached":"synthetic-ordinary-cache"}';await writeFile(join(legacy,'official-chatgpt-usage-cache.json'),quota);
 ok(invoke(legacy,undefined,legacyEnv));
 const encrypted={};for(const name of Object.keys(documents)){encrypted[name]=await readFile(join(legacy,name),'utf8');assert.equal(JSON.parse(encrypted[name]).nativeEncryptedDocument,1);}
 const bad=join(parent,'bad');await cp(legacy,bad,{recursive:true});const corrupt=JSON.parse(await readFile(join(bad,'settings.json')));corrupt.ciphertext='AAAAAAAAAAAAAAAAAAAAAAAA';await writeFile(join(bad,'settings.json'),JSON.stringify(corrupt));
 const beforeBad=await readFile(join(bad,'official-chatgpt-accounts.json'),'utf8');const denied=invoke(bad,undefined,migrationEnv);assert.notEqual(denied.status,0);assert.equal(await readFile(join(bad,'official-chatgpt-accounts.json'),'utf8'),beforeBad);await assert.rejects(stat(join(bad,'native-credential-storage.json')));
 pass('all legacy documents authenticate before migration writes; corruption leaves other credentials and completion marker untouched');
 const missing=join(parent,'missing-key');await cp(legacy,missing,{recursive:true});await rm(join(missing,'native-test-vault-key.bin'));const failed=invoke(missing,undefined,migrationEnv);assert.notEqual(failed.status,0);assert.equal(await readFile(join(missing,'settings.json'),'utf8'),encrypted['settings.json']);await assert.rejects(stat(join(missing,'native-test-vault-key.bin')));
 pass('a missing original master key never creates a replacement or overwrites encrypted data');
 const resumed=join(parent,'resumed');await cp(legacy,resumed,{recursive:true});await writeFile(join(resumed,'settings.pilot-tmp'),'foreign-staging');const interrupted=invoke(resumed,undefined,migrationEnv);assert.notEqual(interrupted.status,0);assert.match(interrupted.stderr,/临时文件已存在/);assert.equal(await readFile(join(resumed,'settings.pilot-tmp'),'utf8'),'foreign-staging');for(const name of Object.keys(documents))assert.equal(await readFile(join(resumed,name),'utf8'),encrypted[name],'staging conflict must preserve every encrypted source');await assert.rejects(stat(join(resumed,'native-credential-storage.json')));await rm(join(resumed,'settings.pilot-tmp'));ok(invoke(resumed,undefined,migrationEnv));
 for(const [name,value] of Object.entries(documents)){const current=await readFile(join(resumed,name),'utf8');assert.equal(JSON.parse(current).nativeEncryptedDocument,undefined);if(name!=='settings.json')assert.equal(current,value);await privateMode(join(resumed,name));assert.equal(await readFile(join(resumed,'credential-private-migration-originals',name),'utf8'),encrypted[name]);await privateMode(join(resumed,'credential-private-migration-originals',name));}
 assert.equal(await readFile(join(resumed,'credential-migration-backups/settings.json'),'utf8'),settings);
 assert.equal(await readFile(join(resumed,'codex/auth.json'),'utf8'),officialSource);assert.equal(await readFile(join(resumed,'official-chatgpt-usage-cache.json'),'utf8'),quota);
 pass('interrupted migration resumes, keeps exact ciphertext and original plaintext backups, preserves official source login and ordinary quota cache');
 await rm(join(resumed,'native-test-vault-key.bin'));await rm(join(resumed,'native-credential-vault.json'));let restored=ok(invoke(resumed))[0];assert.equal(restored.selected.codex,'private-api');assert.equal(restored.connections[0].bearerToken,secret);assert.equal(restored.connections[0].codexModel,'last-choice');
 ok(invoke(resumed,[request('updateCodexConfig',{compatibleModel:'newest-choice'})]));restored=ok(invoke(resumed))[0];assert.equal(restored.connections[0].codexModel,'newest-choice');assert.equal(await readFile(join(resumed,'codex/auth.json'),'utf8'),officialSource);
 pass('completed migration reads, updates and restarts with the old key and vault metadata removed');
 await writeFile(join(resumed,'settings.json'),encrypted['settings.json']);const returned=invoke(resumed);assert.notEqual(returned.status,0);assert.match(returned.stderr,/已迁移目录/);assert.equal(await readFile(join(resumed,'settings.json'),'utf8'),encrypted['settings.json']);
 pass('unexpected old ciphertext after completion is preserved and never causes silent key regeneration or Keychain access');
 if(process.platform!=='win32'){
  const linked=join(parent,'linked');await mkdir(linked);ok(invoke(linked));const foreign=join(parent,'foreign');await mkdir(foreign);await writeFile(join(foreign,'auth.json'),'untouched');const mode=(await stat(foreign)).mode&0o777;await symlink(foreign,join(linked,'grok-accounts'));const result=invoke(linked);assert.notEqual(result.status,0);assert.equal(await readFile(join(foreign,'auth.json'),'utf8'),'untouched');assert.equal((await stat(foreign)).mode&0o777,mode);
  pass('credential directory symlinks cannot redirect migration or change external directory permissions');
 }else{
  for(const kind of ['grok-accounts','credential-private-migration-originals']){
   const owned=join(parent,'junction-'+kind),foreign=join(parent,'outside-'+kind);await mkdir(foreign);await writeFile(join(foreign,'auth.json'),'external-keep');const beforeAcl=windowsAcl(foreign).sddl;
   if(kind==='grok-accounts'){await mkdir(owned);ok(invoke(owned));}else{await cp(legacy,owned,{recursive:true});}
   await symlink(foreign,join(owned,kind),'junction');
   const denied=invoke(owned,undefined,kind==='grok-accounts'?plainEnv:migrationEnv);assert.notEqual(denied.status,0);
   assert.equal(await readFile(join(foreign,'auth.json'),'utf8'),'external-keep');assert.equal(windowsAcl(foreign).sddl,beforeAcl);
   if(kind==='credential-private-migration-originals'){assert.equal(await readFile(join(owned,'settings.json'),'utf8'),encrypted['settings.json']);await assert.rejects(stat(join(owned,'native-credential-storage.json')));}
   pass('Windows '+kind+' junction rejects credential access or migration writes, preserving external bytes/ACL and original ciphertext');
  }
 }
 assert.ok(!(await readdir(fresh)).some(n=>n.endsWith('pilot-tmp')));
 console.log(JSON.stringify({passed:true,checks,scope:'real native RPC with synthetic credentials and a synthetic legacy vault; no existing account or OS credential touched'}));
}finally{await rm(parent,{recursive:true,force:true});}
