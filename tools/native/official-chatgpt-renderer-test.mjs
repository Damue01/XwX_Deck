// Actual subscription page, official allowance and account selection interactions.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import esbuild from 'esbuild';
import {JSDOM} from 'jsdom';
const base=resolve(import.meta.dirname,'../..');
const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://deck.test/'});
for(const name of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLButtonElement','Element','Node','DocumentFragment','ShadowRoot','MutationObserver','Event','CustomEvent','MouseEvent','localStorage'])Object.defineProperty(globalThis,name,{configurable:true,value:name==='window'?dom.window:dom.window[name]});
globalThis.getComputedStyle=dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame=dom.window.requestAnimationFrame=cb=>setTimeout(()=>cb(performance.now()),0);
globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame=clearTimeout;
globalThis.ResizeObserver=dom.window.ResizeObserver=class{observe(){} unobserve(){} disconnect(){}};
dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
globalThis.PointerEvent=dom.window.PointerEvent=dom.window.MouseEvent;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
const require=createRequire(resolve(base,'package.json'));
const React=require('react'),{act}=React,{createRoot}=require('react-dom/client');
const notices=[],switches=[],usageRequests=[],policyWrites=[],redemptions=[],signouts=[],confirmations=[],websiteOpens=[];
const removals=[];let removalImpact=[],removalFails=false;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
const official=(id,label)=>({id,label,email:label+'@example.test',platform:'chatgpt',authKind:'official',accountKey:'identity-'+id,externalLogin:id==='official-chatgpt',status:'connected',quota:{remainingPercent:77,resetsAt:2000000000,checkedAt:1},quotaDetails:{source:'chatgpt-wham',httpStatus:200,checkedAt:1,availableResetCredits:1,windows:[{limitId:'codex',window:'primary_window',remainingPercent:77,usedPercent:23,windowSeconds:18000,resetsAt:2000000000}]}});
let snapshot={supported:true,officialLoginInstalled:true,accounts:[official('official-chatgpt','林青'),official('official-chatgpt-chen','陈雨'),...['work','personal'].map(id=>({id,label:id,email:id+'@example.test',platform:'chatgpt',authKind:'api',status:'connected',quota:{remainingPercent:33},quotaError:'API HTTP 401'}))],routing:{chatgpt:{strategy:'fixed',fixedAccountId:'work',accountOrder:['work','personal'],excludedAccountIds:[]}}};
let snapshotHold=null,usageHold=null,readFail=false,renameFail=false;
let fail=false,hold=null,resetFail=true,confirmAllowed=false;
const bridge={providers:{active:{codex:null,claude:null},connections:[]},patch:value=>Object.assign(bridge,value),api:{
 getOfficialChatgptAccount:async()=>structuredClone(snapshot.accounts[0]),
 getSubscriptionAccounts:async()=>{if(readFail)throw Error('账号读取失败');if(snapshotHold)await snapshotHold.promise;return structuredClone(snapshot)},getProviders:async()=>bridge.providers,
 refreshSubscriptionUsage:async input=>{usageRequests.push(input.platform);if(usageHold)await usageHold.promise;return structuredClone(snapshot)},
 setSubscriptionRouting:async input=>{policyWrites.push(structuredClone(input));if(hold){const pending=hold;hold=null;await pending.promise}if(fail)throw Error('保存失败，原文件保留');snapshot={...snapshot,routing:{...snapshot.routing,[input.platform]:structuredClone(input.policy)}};return structuredClone(snapshot)},
 getOfficialChatgptResetCredits:async id=>({...structuredClone(snapshot.accounts.find(a=>a.id===id)),quotaDetails:{...snapshot.accounts[0].quotaDetails,resetCredits:[{id:'opaque-do-not-display',expiresAt:2000004000,status:'available',title:'额度重置卡'}]}}),
 consumeOfficialChatgptResetCredit:async input=>{redemptions.push(input);if(resetFail)throw Error('响应中断，请重试');return{outcome:'alreadyRedeemed'}},
 signOutSubscriptionAccount:async input=>{signouts.push(input);return{revoked:false}},
 getConfigurationRemovalImpact:async()=>removalImpact,
 renameSubscriptionAccount:async({accountId,label})=>{if(renameFail)throw Error('账号改名失败');snapshot={...snapshot,accounts:snapshot.accounts.map(account=>account.id===accountId?{...account,label}:account)};return bridge.providers},
 setupWebsites:{},openSetupWebsite:async site=>{websiteOpens.push(site)},
}};
globalThis.__codexModelFixture={bridge,notices,confirm:async args=>{confirmations.push(args);return confirmAllowed}};
const entry=resolve(base,'src/renderer/features/settings/SubscriptionAccountsPanel.tsx');
const result=await esbuild.build({entryPoints:[entry],bundle:true,platform:'node',format:'cjs',write:false,alias:{'@':resolve(base,'src/renderer')},external:['react','react/*','react-dom','react-dom/*'],plugins:[{name:'fixtures',setup(build){
 build.onResolve({filter:/^\.\/confirm-dialog$/},()=>({path:'@/components/ui/confirm-dialog',namespace:'fixture'}));
 build.onResolve({filter:/^\.\/(CodexEnhancements|ClaudeEnhancements|GatewayClientModels|compatibleQuota)$/},args=>({path:args.path.slice(2),namespace:'empty'}));
 build.onLoad({filter:/.*/,namespace:'empty'},args=>({contents:`export const ${args.path}=()=>null;`}));
 build.onResolve({filter:/^@\/(bridge\/store|lib\/i18n|lib\/toast|components\/ui\/confirm-dialog)$/},args=>({path:args.path,namespace:'fixture'}));
 build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.endsWith('i18n')?'export const t=(s,...args)=>s.replace(/\\{(\\d+)\\}/g,(_,n)=>args[n]??_);export const useLanguage=()=>{};export const getLanguage=()=>"zh-CN";':args.path.endsWith('store')?'export const useBridge=()=>globalThis.__codexModelFixture.bridge;':args.path.endsWith('confirm-dialog')?'export const useConfirm=()=>globalThis.__codexModelFixture.confirm;':`export const showToast=(...v)=>globalThis.__codexModelFixture.notices.push(['toast',...v]);export const showErrorToast=(...v)=>globalThis.__codexModelFixture.notices.push(['error',...v]);export const showLifecycleNotice=(...v)=>globalThis.__codexModelFixture.notices.push(['lifecycle',...v]);export const clearLifecycleNotice=()=>{};export const closeToast=()=>{};export const openConfiguration=()=>{};export const openProviderSettings=()=>{};export const runNoticeAction=()=>{};export const REPAIR_CODEX_CONFIG_EVENT='repair';export const RESTORE_CLIENT_CONFIG_EVENT='restore';`}));
}}]});
const mod={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(require,mod,mod.exports);
window.addEventListener('restore',async event=>{const providers=await bridge.api.switchClientProvider({client:event.detail.client,providerId:null});bridge.patch({providers});event.detail.onComplete?.()});
const root=createRoot(document.getElementById('root'));
const render=visible=>act(async()=>root.render(React.createElement(mod.exports.SubscriptionAccountsPanel,{visible,open:true,initialPlatform:'chatgpt',embedded:true})));
async function wait(test,label){for(let n=0;n<100;n++){await act(async()=>new Promise(r=>setTimeout(r,10)));if(test())return}throw Error(label+' '+document.body.textContent)}
const rows=()=>[...document.querySelectorAll('.chatgpt-account')].map(row=>row.dataset.accountId);
const tab=name=>act(async()=>document.querySelector(`[role="tab"][data-slot="tabs-tab"][value="${name}"]`)?.click());
async function switchTab(name){await act(async()=>[...document.querySelectorAll('[role="tab"]')].find(el=>el.textContent===name).click());}
async function choosePolicy(name){await act(async()=>document.querySelector('.chatgpt-policy button').click());await wait(()=>[...document.querySelectorAll('[role="option"]')].some(el=>el.textContent.includes(name)),'open strategy');await act(async()=>{const option=[...document.querySelectorAll('[role="option"]')].find(el=>el.textContent.includes(name));const down=new MouseEvent('pointerdown',{bubbles:true,button:0,buttons:1});Object.defineProperty(down,'pointerType',{value:'mouse'});option.dispatchEvent(down);option.click()});}
const key=(id,key)=>act(async()=>document.querySelector(`[data-account-id="${id}"] .account-drag-handle`).dispatchEvent(new dom.window.KeyboardEvent('keydown',{bubbles:true,key})));
try{
 await render(true);await wait(()=>rows().length===2,'official accounts');assert.deepEqual(rows(),['official-chatgpt','official-chatgpt-chen']);assert.equal(document.querySelectorAll('[role="meter"]').length,0);assert.ok([...document.querySelectorAll('.account-disclosure')].every(button=>button.getAttribute('aria-expanded')==='false'));await act(async()=>document.querySelector('[data-account-id="official-chatgpt"] .account-disclosure').click());assert.equal(document.querySelectorAll('[role="meter"]').length,1);assert.ok(document.body.textContent.includes('重置'));assert.ok(!document.body.textContent.includes('当前账号'));assert.ok(!document.body.textContent.includes('使用中'));assert.ok(!document.body.textContent.includes('查看套餐用量'));assert.ok(!document.body.textContent.includes('API HTTP 401'));assert.equal(document.querySelectorAll('input[type="checkbox"]').length,0);
 console.log('PASS official names, compact allowance and reset dates; no avatars, plan labels, usage link or participation controls');
 const savedOfficial=structuredClone(snapshot.accounts[0]);
 const weekly={limitId:'codex',window:'secondary',remainingPercent:60,usedPercent:40,windowSeconds:604800,resetsAt:2000004000};
 const short={limitId:'codex',window:'primary',remainingPercent:80,usedPercent:20,windowSeconds:18000,resetsAt:2000001000};
 async function refreshWindows(plan,windows){
  snapshot.accounts[0]={...savedOfficial,quotaDetails:{...savedOfficial.quotaDetails,planType:plan,windows}};
  await act(async()=>document.querySelector('button[aria-label="刷新额度"]').click());
  await wait(()=>!document.querySelector('button[aria-label="刷新额度"]').disabled,'window refresh');
 }
 for(const plan of ['plus','pro','future-plan']){
  await refreshWindows(plan,[short,weekly]);assert.equal(document.querySelectorAll('[role="meter"]').length,2);assert.ok(document.querySelector('.account-quota').textContent.includes('5h 限额'));assert.ok(document.querySelector('.account-quota').textContent.includes('每周限额'));
  await refreshWindows(plan,[weekly]);assert.equal(document.querySelectorAll('[role="meter"]').length,1);assert.ok(!document.querySelector('.account-quota').textContent.includes('5h 限额'));assert.equal(document.querySelector('.account-quota').dataset.windowCount,'1');
  assert.ok(!document.body.textContent.includes(plan));
 }
 await refreshWindows(null,[{...short,windowSeconds:900},{...weekly,limitId:'special',limitName:'Special model',windowSeconds:3600}, {...short,remainingPercent:null}]);
 assert.equal(document.querySelectorAll('[role="meter"]').length,2);assert.ok(document.querySelector('.account-quota').textContent.includes('15 分钟'));assert.ok(document.querySelector('.account-quota').textContent.includes('Special model 1 小时'));assert.ok(!document.querySelector('.account-quota').textContent.includes('5h 限额'));
 await refreshWindows(null,[]);assert.equal(document.querySelectorAll('[role="meter"]').length,0);assert.equal(document.querySelectorAll('.subscription-quota-empty').length,1);assert.equal(document.querySelector('.subscription-quota-empty').textContent,'额度未知');
 snapshot.accounts[0]=savedOfficial;await act(async()=>document.querySelector('button[aria-label="刷新额度"]').click());
 console.log('PASS same Plus/Pro/future plan gains and loses windows on refresh; no stale 5h, invented plan labels or invalid bars; minutes and named buckets adapt');

 await act(async()=>root.render(null));snapshotHold=deferred();usageHold=deferred();
 await render(true);assert.equal(document.querySelectorAll('[role="meter"]').length,0);assert.equal(rows().length,2);await act(async()=>document.querySelector('[data-account-id="official-chatgpt"] .account-disclosure').click());assert.equal(document.querySelectorAll('[role="meter"]').length,1);
 await act(async()=>snapshotHold.resolve());snapshotHold=null;assert.equal(document.querySelectorAll('[role="meter"]').length,1);
 await act(async()=>usageHold.resolve());usageHold=null;await wait(()=>!document.querySelector('button[aria-label="刷新额度"]').disabled,'remount refresh');
 console.log('PASS account dialog remount keeps its last account/quota snapshot visible throughout slow local and upstream refresh');
 await key('official-chatgpt-chen','ArrowUp');await wait(()=>policyWrites.length>=2,'official order save');assert.deepEqual(rows(),['official-chatgpt-chen','official-chatgpt']);assert.deepEqual(policyWrites.at(-1).policy.accountOrder,rows());assert.equal(document.querySelector('[data-account-id="official-chatgpt"] .account-disclosure').getAttribute('aria-expanded'),'true');
 console.log('PASS keyboard sorting persists actual account order and preserves the expanded account by identity');
 await switchTab('API 授权');assert.deepEqual(rows(),['work','personal']);assert.equal(document.querySelectorAll('[role="meter"]').length,0);assert.equal([...document.querySelectorAll('button')].filter(el=>el.getAttribute('aria-label')==='刷新额度').length,0);assert.ok(!document.body.textContent.includes('额度未知'));assert.ok(!document.body.textContent.includes('API HTTP 401'));assert.ok(usageRequests.every(group=>group==='chatgpt-official'));
 await key('personal','ArrowUp');await wait(()=>policyWrites.at(-1).platform==='chatgpt','API order');assert.deepEqual(rows(),['personal','work']);assert.deepEqual(policyWrites.at(-1).policy.excludedAccountIds,[]);
 assert.equal(snapshot.routing.chatgpt.strategy,'fixed','entering and sorting retain a saved legacy policy');
 assert.equal(document.querySelectorAll('input[type="radio"]').length,2,'saved fixed policy keeps its account controls');
 await act(async()=>document.querySelector('.chatgpt-policy button').click());
 await wait(()=>document.querySelector('[role="option"]'),'open API strategy');
 assert.ok([...document.querySelectorAll('[role="option"]')].some(el=>el.textContent.includes('用完再换')));
 assert.ok(![...document.querySelectorAll('[role="option"]')].some(el=>/平衡使用|固定账号|最早重置/.test(el.textContent)));
 await act(async()=>document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
 console.log('PASS API uses the same sorting/automatic participation and strategy hints without quota probes or borrowed official allowance');
 fail=true;await key('work','ArrowUp');await wait(()=>document.body.textContent.includes('重试保存'),'failed order');assert.deepEqual(rows(),['work','personal']);await switchTab('官方账号登录');await switchTab('API 授权');assert.deepEqual(rows(),['work','personal']);await act(async()=>root.render(null));await render(true);await switchTab('API 授权');assert.deepEqual(rows(),['work','personal']);assert.ok(document.body.textContent.includes('重试保存'));fail=false;await act(async()=>[...document.querySelectorAll('button')].find(el=>el.textContent==='重试保存').click());await wait(()=>!document.body.textContent.includes('重试保存'),'retry save');assert.deepEqual(snapshot.routing.chatgpt.accountOrder,['work','personal']);
 console.log('PASS failed order remains across tabs and full dialog remount; Retry writes the retained choice');
 hold=deferred();const held=hold;await key('personal','ArrowUp');await key('work','ArrowUp');assert.deepEqual(rows(),['work','personal']);await act(async()=>held.resolve());await wait(()=>snapshot.routing.chatgpt.accountOrder[0]==='work','queued order');assert.deepEqual(rows(),['work','personal']);
 console.log('PASS a late earlier save cannot overwrite the latest sort; writes serialize to the latest desired order');
 await switchTab('官方账号登录');await act(async()=>document.querySelector('[data-account-id="official-chatgpt-chen"] .account-disclosure').click());await act(async()=>[...document.querySelectorAll('.reset-entry')][0].click());await wait(()=>document.body.textContent.includes('选择重置卡'),'credit list');assert.ok(document.body.textContent.includes('失效'));assert.ok(!document.body.textContent.includes('opaque-do-not-display'));await act(async()=>document.querySelector('input[name="chatgpt-reset-credit"]').click());await act(async()=>[...document.querySelectorAll('button')].find(el=>el.textContent==='继续').click());assert.ok(document.body.textContent.includes('确认使用重置卡'));assert.ok(document.body.textContent.includes('陈雨'));await act(async()=>[...document.querySelectorAll('button')].find(el=>el.textContent==='确认使用').click());await wait(()=>document.body.textContent.includes('响应中断'),'failed reset');resetFail=false;await act(async()=>[...document.querySelectorAll('button')].find(el=>el.textContent==='确认使用').click());await wait(()=>!document.body.textContent.includes('确认使用重置卡'),'reset retried');assert.equal(redemptions.length,2);assert.equal(redemptions[0].creditId,'opaque-do-not-display');assert.equal(redemptions[0].idempotencyKey,redemptions[1].idempotencyKey);
 console.log('PASS exact reset card/account confirmation shows expiry without ID; ambiguous retry retains the same redemption key, synthetic only');
 await act(async()=>document.querySelector('[data-account-id="official-chatgpt"] .provider-menu-trigger').click());await wait(()=>[...document.querySelectorAll('[role="menuitem"]')].some(el=>el.textContent==='退出登录'),'shared login exit menu');await act(async()=>[...document.querySelectorAll('[role="menuitem"]')].find(el=>el.textContent==='退出登录').click());assert.equal(signouts.length,0);assert.ok(confirmations.at(-1).body.includes('共享'));confirmAllowed=true;
 await act(async()=>document.querySelector('[data-account-id="official-chatgpt"] .provider-menu-trigger').click());await wait(()=>document.querySelector('[role="menuitem"]'),'exit menu');await act(async()=>document.querySelector('[role="menuitem"]').click());await wait(()=>signouts.length===1,'confirmed exit');assert.deepEqual(signouts[0],{accountId:'official-chatgpt',accountKey:'identity-official-chatgpt'});
 console.log('PASS default official login has an exit action with shared-login impact, cancellation and identity-bound confirmation');
 snapshot.accounts.push({id:'chatgpt-api-import-fixture',label:'来源账号',email:'source@example.test',platform:'chatgpt',authKind:'api',status:'signed-out',importedLogin:true,sourceError:'来源授权已过期，请在原应用刷新登录后重新检测'});
 await act(async()=>root.render(null));await render(true);await switchTab('API 授权');await wait(()=>document.body.textContent.includes('来源授权已过期'),'imported source error');assert.ok([...document.querySelectorAll('button')].some(el=>el.textContent==='重新检测'));assert.equal([...document.querySelectorAll('[data-account-id="chatgpt-api-import-fixture"] button')].filter(el=>el.textContent==='登录').length,0);
 await act(async()=>document.querySelector('[data-account-id="chatgpt-api-import-fixture"] .provider-menu-trigger').click());await wait(()=>[...document.querySelectorAll('[role="menuitem"]')].some(el=>el.textContent==='移除账号'),'unlink menu');await act(async()=>[...document.querySelectorAll('[role="menuitem"]')].find(el=>el.textContent==='移除账号').click());assert.equal(signouts.at(-1),'chatgpt-api-import-fixture');assert.ok(confirmations.at(-1).body.includes('原应用的登录不受影响'));assert.equal(confirmations.at(-1).confirmText,'移除账号');
 console.log('PASS imported API account has source-login recovery and an unlink confirmation that preserves the original application login');

 // Every non-ChatGPT service must use the production shared strategy/list/save components.
 const renderService=async (platform,embedded=true)=>{await act(async()=>root.render(null));await act(async()=>root.render(React.createElement(mod.exports.SubscriptionAccountsPanel,{visible:true,open:true,initialPlatform:platform,embedded})));await wait(()=>rows().length===2,platform+' accounts')};
 for(const platform of ['cursor','claude','grok','copilot']){
  snapshot.accounts.push(...['a','b'].map(id=>({id:platform+'-'+id,label:platform+' '+id,email:id+'@example.test',platform,status:'connected',...(platform==='cursor'?{}:{quota:{remainingPercent:60,resetsAt:2000000000,checkedAt:1}})})));
  snapshot.routing[platform]={strategy:'fixed',fixedAccountId:platform+'-a',excludedAccountIds:platform==='cursor'?[platform+'-a']:[],accountOrder:[platform+'-b',platform+'-a']};
  await renderService(platform);
  assert.deepEqual(rows(),[platform+'-b',platform+'-a']);assert.ok(document.querySelector('.chatgpt-policy .xwx-choice-trigger'));assert.equal(document.querySelectorAll('.subscription-strategy').length,0);assert.ok(document.querySelector('#subscription-order-help').textContent.includes('排序不影响使用'));assert.equal(snapshot.routing[platform].strategy,'fixed');
  assert.equal(document.querySelectorAll('.account-drag-handle').length,2);
  await wait(()=>!document.querySelector('[aria-label="刷新额度"]').disabled,'quota refresh settled');
  assert.equal(document.querySelector('.subscription-rename-trigger'),null);assert.equal(document.querySelector('[data-account-id="'+platform+'-b"] .account-disclosure').getAttribute('aria-expanded'),'false');assert.equal(document.querySelectorAll('[role="meter"]').length,0);await act(async()=>document.querySelector('[data-account-id="'+platform+'-b"] .account-disclosure').click());assert.equal(document.querySelector('[data-account-id="'+platform+'-b"] .account-disclosure').getAttribute('aria-expanded'),'true');
  if(platform!=='cursor'){
   assert.equal(document.querySelectorAll('[role="meter"]').length,1);assert.equal(document.querySelector('[role="meter"]').getAttribute('aria-valuenow'),'60');assert.ok(document.querySelector('.quota-reset').textContent.includes('重置'));assert.ok(!document.body.textContent.includes('剩余 60%'));assert.ok(!document.body.textContent.includes('使用中'));
  }

  assert.equal(!!document.querySelector('.subscription-usage-link'),platform==='cursor');
  if(platform==='cursor'){await act(async()=>document.querySelector('.subscription-usage-link').click());assert.equal(websiteOpens.at(-1),'subscription-cursor-usage');}
  await act(async()=>document.querySelector('.chatgpt-policy button').click());await wait(()=>document.querySelectorAll('[role="option"]').length===2,'shared options');
  const quotaOptions=[...document.querySelectorAll('[role="option"]')].filter(el=>el.textContent.trim()==='剩余额度最多');
  assert.equal(quotaOptions.length,1);assert.ok(quotaOptions.every(el=>(el.getAttribute('aria-disabled')==='true')===(platform==='cursor')));
  await act(async()=>document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  assert.equal(document.querySelectorAll('input[type="radio"]').length,2);
  await act(async()=>document.querySelector(`[aria-label="固定使用 ${platform} b"]`).click());
  await wait(()=>snapshot.routing[platform].fixedAccountId===platform+'-b','existing fixed selection');
  await choosePolicy('用完再换');await wait(()=>snapshot.routing[platform].strategy==='exhaust','supported strategy saved');
  await key(platform+'-a','Home');await wait(()=>snapshot.routing[platform].accountOrder[0]===platform+'-a','ordered save');assert.deepEqual(rows(),[platform+'-a',platform+'-b']);
  assert.equal(document.querySelector('[data-account-id="'+platform+'-b"] .account-disclosure').getAttribute('aria-expanded'),'true');
  if(platform==='cursor'){
   assert.deepEqual(snapshot.routing.cursor.excludedAccountIds,['cursor-a']);assert.ok(document.body.textContent.includes('恢复使用'));
   await act(async()=>[...document.querySelectorAll('button')].find(el=>el.textContent==='恢复使用').click());await wait(()=>snapshot.routing.cursor.excludedAccountIds.length===0,'explicit legacy resume');
  }
  console.log('PASS '+platform+' shares strategy selector, hints, ordered list and fixed radios; quota choices follow actual data and existing policy is retained');
 }
 // A real allowance response removes the fallback; per-account errors restore it.
 const cursorAccounts=snapshot.accounts.filter(account=>account.platform==='cursor');
 snapshot.accounts=snapshot.accounts.map(account=>account.platform==='cursor'?{...account,quota:{remainingPercent:45,resetsAt:2000000000,checkedAt:1}}:account);
 await renderService('cursor');await wait(()=>!document.querySelector('[aria-label="刷新额度"]').disabled,'Cursor allowance ready');assert.equal(document.querySelector('.subscription-usage-link'),null);
 snapshot.accounts=snapshot.accounts.map(account=>account.id==='cursor-a'?{...account,quotaError:'额度读取失败'}:account);
 await act(async()=>document.querySelector('[aria-label="刷新额度"]').click());await wait(()=>!!document.querySelector('.subscription-usage-link'),'usage error fallback');assert.ok(!document.querySelector('.configuration-detail-heading .subscription-usage-link'));
 snapshot.accounts=snapshot.accounts.map(account=>account.platform==='cursor'?cursorAccounts.find(original=>original.id===account.id):account);
 console.log('PASS usage website is absent with displayed allowance, returns only for missing/error allowance, and opens the correct service website');
 snapshot.accounts=snapshot.accounts.map(account=>account.platform==='cursor'?{...account,quota:{remainingPercent:45,resetsAt:2000000000,checkedAt:1}}:account);
 await renderService('cursor');await wait(()=>!document.querySelector('[aria-label="刷新额度"]').disabled,'current Cursor quota');
 fail=true;await choosePolicy('剩余额度最多');await wait(()=>document.body.textContent.includes('重试保存'),'Cursor save failure');
 await renderService('claude');assert.equal(document.querySelector('.xwx-choice-value').textContent,'用完再换');await renderService('cursor');assert.equal(document.querySelector('.xwx-choice-value').textContent,'剩余额度最多');assert.ok(document.body.textContent.includes('重试保存'));
 fail=false;await act(async()=>[...document.querySelectorAll('button')].find(el=>el.textContent==='重试保存').click());await wait(()=>snapshot.routing.cursor.strategy==='most-remaining','Cursor retry');
 hold=deferred();const genericHold=hold;await key('cursor-b','Home');await choosePolicy('用完再换');await act(async()=>genericHold.resolve());await wait(()=>snapshot.routing.cursor.strategy==='exhaust','queued latest strategy');assert.deepEqual(snapshot.routing.cursor.accountOrder,['cursor-b','cursor-a']);assert.equal(snapshot.routing.cursor.fixedAccountId,'cursor-b');
 console.log('PASS supported strategy changes preserve failure drafts, latest order and the stored legacy fixed identity across services');

 const beforeWindows=structuredClone(snapshot.accounts);
 snapshot.accounts=snapshot.accounts.map(account=>account.platform==='cursor'?{...account,quota:undefined,quotaDetails:{source:'fixture',httpStatus:200,checkedAt:1,windows:[{limitId:'premium',limitName:'Premium',window:'actual',remainingPercent:25,usedPercent:75,windowSeconds:3600,resetsAt:2000005000}]}}:account);
 await renderService('cursor');await act(async()=>document.querySelector('.account-disclosure').click());await wait(()=>!document.querySelector('[aria-label="刷新额度"]').disabled,'actual windows');assert.equal(document.querySelector('.subscription-usage-link'),null);assert.equal(document.querySelector('.subscription-quota-empty'),null);assert.equal(document.querySelectorAll('[role="meter"]').length,1);assert.ok(document.querySelector('.account-quota').textContent.includes('Premium 1 小时'));
 snapshot.accounts=snapshot.accounts.map(account=>account.platform==='cursor'?{...account,quota:{remainingPercent:NaN,resetsAt:0},quotaDetails:undefined}:account);await renderService('cursor');await act(async()=>document.querySelector('.account-disclosure').click());await wait(()=>document.querySelector('.subscription-usage-link'),'invalid quota fallback');assert.equal(document.querySelector('[role="meter"]'),null);assert.ok(document.querySelector('.subscription-quota-empty'));
 snapshot.accounts=beforeWindows;
 console.log('PASS actual quota windows take precedence over summaries; invalid or absent data never creates a quota bar or invented reset period');
 for(const platform of ['cursor','claude','grok','copilot']){
  const before=snapshot.accounts.filter(account=>account.platform===platform);
  snapshot.accounts=snapshot.accounts.map(account=>account.platform===platform?{...account,quota:undefined,quotaError:'官方额度读取失败'}:account);
  await renderService(platform);assert.equal(document.querySelector('.account-quota'),null);await act(async()=>document.querySelector('.account-disclosure').click());await wait(()=>document.querySelector('.subscription-usage-link'),'failure fallback');
  assert.equal(document.querySelectorAll('[role="meter"]').length,0);assert.equal(document.querySelectorAll('.subscription-usage-link').length,1);assert.ok(document.querySelector('.account-quota').textContent.includes('官方额度读取失败'));
  await act(async()=>document.querySelector('.account-disclosure[aria-expanded="true"]').click());assert.equal(document.querySelector('.account-quota'),null);
  await act(async()=>document.querySelector('.account-disclosure').click());assert.ok(document.querySelector('.account-quota').textContent.includes('官方额度读取失败'));
  snapshot.accounts=snapshot.accounts.map(account=>account.platform===platform?{...account,status:'signed-out'}:account);
  await renderService(platform);assert.equal(document.querySelector('[aria-label="刷新额度"]'),null);assert.equal(document.querySelector('.subscription-usage-link'),null);assert.equal(document.querySelector('.account-disclosure'),null);assert.equal([...document.querySelectorAll('.subscription-service-account button')].filter(button=>button.textContent==='登录').length,2);assert.ok(!document.body.textContent.includes('需登录'));
  snapshot.accounts=snapshot.accounts.map(account=>account.platform===platform?before.find(original=>original.id===account.id):account);
  console.log('PASS '+platform+' quota details expose failures without duplicate website links; signed-out rows keep one login action and no dead quota controls');
 }
 await renderService('claude');
 await act(async()=>document.querySelector('[aria-label="claude a 的更多操作"]').click());await wait(()=>document.querySelector('[role="menuitem"]'),'rename menu');
 await act(async()=>[...document.querySelectorAll('[role="menuitem"]')].find(item=>item.textContent==='重命名 claude a').click());await wait(()=>document.querySelector('[aria-label="账号名称"]'),'rename form');
 const renameInput=document.querySelector('[aria-label="账号名称"]');
 await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(renameInput,'新名称');renameInput.dispatchEvent(new Event('input',{bubbles:true}))});
 renameFail=true;await act(async()=>document.querySelector('[aria-label="保存账号名称"]').click());await wait(()=>notices.some(notice=>notice[0]==='error'&&String(notice[2]).includes('账号改名失败')),'rename failure');assert.equal(document.querySelector('[aria-label="账号名称"]').value,'新名称');
 renameFail=false;await act(async()=>document.querySelector('[aria-label="保存账号名称"]').click());await wait(()=>!document.querySelector('[aria-label="账号名称"]'),'rename saved');assert.equal(snapshot.accounts.find(account=>account.id==='claude-a').label,'新名称');
 console.log('PASS rename lives in More actions, failure retains the edited name and saving again updates the same account');
 snapshot.flow={id:'other-service',platform:'grok',authKind:'api',status:'waiting',userCode:'do-not-leak'};
 await renderService('cursor');assert.equal(document.querySelector('.subscription-login-progress'),null);assert.equal(document.querySelector('.subscription-device-code'),null);assert.ok(document.querySelector('.subscription-login-button').disabled);
 await act(async()=>root.render(null));await render(true);await switchTab('API 授权');assert.equal(document.querySelector('.subscription-login-progress'),null);assert.ok(document.querySelector('.subscription-login-button').disabled);
 await renderService('grok',false);assert.ok(document.querySelector('.subscription-login-progress'));assert.ok(document.querySelector('.subscription-device-code').textContent.includes('do-not-leak'));assert.ok([...document.querySelectorAll('[data-subscription-service]')].every(button=>!button.disabled));await act(async()=>document.querySelector('[data-subscription-service="cursor"]').click());assert.equal(document.querySelector('.subscription-login-progress'),null);assert.ok(document.querySelector('.subscription-login-button').disabled);await act(async()=>document.querySelector('[data-subscription-service="grok"]').click());assert.ok(document.querySelector('.subscription-login-progress'));snapshot.flow=null;
 console.log('PASS login progress and authorization code only appear in their service; another service cannot start a competing login');
 readFail=true;await renderService('copilot');await wait(()=>document.body.textContent.includes('重试读取'),'snapshot retry action');readFail=false;await act(async()=>[...document.querySelectorAll('button')].find(button=>button.textContent==='重试读取').click());await wait(()=>!document.body.textContent.includes('重试读取'),'snapshot retry success');
 console.log('PASS other subscription cards retain their account list on read failure and offer an inline retry');

 bridge.api.removeSubscriptionAccounts=async ids=>{if(removalFails)throw Error('移除失败');removals.push([...ids]);snapshot={...snapshot,accounts:snapshot.accounts.filter(a=>!ids.includes(a.id))};return {...bridge.providers,connections:bridge.providers.connections.filter(p=>!ids.includes(p.subscriptionAccountId))}};
 snapshot.flow=null;snapshot.accounts=[official('official-chatgpt','林青'),{id:'api-removal',label:'API',platform:'chatgpt',authKind:'api',status:'connected'},...['cursor-a','cursor-b'].map(id=>({id,label:id,platform:'cursor',status:'connected'}))];
 bridge.providers={...bridge.providers,connections:snapshot.accounts.map(a=>({id:'provider-'+a.id,subscriptionAccountId:a.id}))};
 await renderService('cursor');
 const removalButton=()=>document.querySelector('.prov-save-bar .configuration-destructive');
 assert.equal(removalButton().textContent,'移除订阅');assert.ok(removalButton().compareDocumentPosition(document.querySelector('.prov-save-bar .subscription-login-button'))&Node.DOCUMENT_POSITION_FOLLOWING);
 confirmAllowed=false;await act(async()=>removalButton().click());assert.equal(removals.length,0);
 confirmAllowed=true;removalImpact=['Claude'];let navigated=0;const navigation=event=>{if(event.detail==='models')navigated++};window.addEventListener('xwxdeck:navigate',navigation);
 await act(async()=>removalButton().click());assert.equal(removals.length,0);assert.equal(navigated,1);assert.equal(confirmations.at(-1).confirmText,'前往模型页');
 removalImpact=[];removalFails=true;await act(async()=>removalButton().click());assert.equal(removals.length,0);assert.equal(document.querySelectorAll('[data-account-id]').length,2);
 removalFails=false;const signoutsBefore=signouts.length;await act(async()=>removalButton().click());assert.deepEqual(removals.at(-1),['cursor-a','cursor-b']);assert.equal(removalButton(),null);assert.equal(signouts.length,signoutsBefore);assert.ok(!bridge.providers.connections.some(p=>p.subscriptionAccountId.startsWith('cursor')));
 await act(async()=>root.render(null));await render(true);
 await act(async()=>document.querySelector('[aria-label="林青 的更多操作"]').click());await wait(()=>[...document.querySelectorAll('[role="menuitem"]')].some(el=>el.textContent==='移除账号'),'account removal action');
 assert.ok([...document.querySelectorAll('[role="menuitem"]')].some(el=>el.textContent==='退出登录'));
 await act(async()=>[...document.querySelectorAll('[role="menuitem"]')].find(el=>el.textContent==='移除账号').click());assert.deepEqual(removals.at(-1),['official-chatgpt']);assert.equal(signouts.length,signoutsBefore);assert.ok(snapshot.accounts.some(a=>a.id==='api-removal'));
 await act(async()=>removalButton().click());assert.deepEqual(removals.at(-1),['api-removal']);assert.equal(removalButton(),null);
 window.removeEventListener('xwxdeck:navigate',navigation);
 console.log('PASS shared footer removal supports cancellation, failure retention, dependency navigation, whole-subscription and individual-account unlink without source sign-out');

}finally{await act(async()=>root.unmount());dom.window.close();delete globalThis.__codexModelFixture;}
