import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import esbuild from 'esbuild';
import {JSDOM} from 'jsdom';
const require=createRequire(import.meta.url),base=resolve(import.meta.dirname,'../..');
const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'http://localhost'});
for(const name of ['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','MutationObserver','DocumentFragment'])Object.defineProperty(globalThis,name,{value:dom.window[name],configurable:true});
globalThis.getComputedStyle=dom.window.getComputedStyle.bind(dom.window);globalThis.requestAnimationFrame=callback=>setTimeout(callback,0);globalThis.cancelAnimationFrame=clearTimeout;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;globalThis.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
dom.window.HTMLElement.prototype.scrollIntoView=function(){};dom.window.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
const React=require('react'),{act}=React,{createRoot}=require('react-dom/client');
const opened=[],notices=[];let openFailure=false;
globalThis.__providerDialogFixture={api:{openSetupWebsite:async value=>{opened.push(value);if(openFailure)throw Error('Synthetic link opener unavailable')}},modelClients:[],patch(){},notices};
const entry=resolve(base,'src/renderer/features/settings/AddConfigurationDialog.tsx');
const result=await esbuild.build({stdin:{contents:"export {AddConfigurationDialog} from './src/renderer/features/settings/AddConfigurationDialog';export {setupWebsitesFor} from './src/shared/setupWebsites';",resolveDir:base},bundle:true,platform:'node',format:'cjs',write:false,alias:{'@':resolve(base,'src/renderer')},external:['react','react/*','react-dom','react-dom/*'],plugins:[{name:'dialog-fixture',setup(build){
 build.onResolve({filter:/^@\/(bridge\/store|lib\/i18n|lib\/toast)$/},args=>({path:args.path,namespace:'fixture'}));
 build.onResolve({filter:/^\.\/(EnhancementsPanel|SubscriptionAccountsPanel|ImportConfigurations)$/},args=>args.importer===entry?{path:args.path,namespace:'fixture'}:undefined);
 build.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path.endsWith('store')?'export const useBridge=()=>globalThis.__providerDialogFixture':args.path.endsWith('i18n')?'export const t=(s,...args)=>s.replace(/\\{(\\d+)\\}/g,(_,n)=>args[n]??_);export const useLanguage=()=>{}':args.path.endsWith('toast')?'export const showToast=(...v)=>globalThis.__providerDialogFixture.notices.push(["success",...v]);export const showErrorToast=(...v)=>globalThis.__providerDialogFixture.notices.push(["error",...v]);':`import React from 'react';export const ${args.path.slice(2)}=()=>React.createElement('div',{'data-fixture-panel':'${args.path.slice(2)}'},'${args.path.slice(2)}');`}));
}}]});
const mod={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(require,mod,mod.exports);const {AddConfigurationDialog,setupWebsitesFor}=mod.exports;
globalThis.__providerDialogFixture.api.setupWebsites=setupWebsitesFor('darwin','arm64');
let state;function Harness({initial='services'}){const [open,setOpen]=React.useState(true),[tab,setTab]=React.useState(initial),[selected,setSelected]=React.useState(null);state={setOpen,setTab};return React.createElement(AddConfigurationDialog,{open,busy:false,selected,onOpenChange:setOpen,onSelect:id=>{setSelected(id);if(id==='custom')setTab('saved');},onBack:()=>setSelected(null),editor:React.createElement('form',{id:'custom-editor'},...['name','url','key'].map(id=>React.createElement('input',{id:'custom-'+id,key:id}))),finalFocus:{current:null},initialTab:initial,activeTab:tab,onTabChange:setTab,managementOpen:tab==='saved',onStartAdding:()=>{setSelected(null);setTab('services');}});}
let root=createRoot(document.getElementById('root'));const checks=['custom service selection shows the editor after entering My configurations','explicit enhancements remains available','new configuration from enhancements returns to the editor','default My configurations starts at enhancements without hiding a later custom choice'];const click=async selector=>{const el=document.querySelector(selector);assert.ok(el,selector);await act(async()=>el.click());};const flush=async()=>act(async()=>new Promise(resolve=>setTimeout(resolve,40)));
try{
 await act(async()=>root.render(React.createElement(AddConfigurationDialog,{open:true,busy:false,selected:null,onOpenChange(){},onSelect(){},onBack(){},editor:null,finalFocus:{current:null},initialTab:'saved'})));await flush();
 const savedTab=document.querySelector('#configuration-saved-tab'),savedPanel=document.getElementById(savedTab.getAttribute('aria-controls'));assert.ok(savedPanel);assert.equal(savedPanel.hidden,false);assert.equal(savedPanel.getAttribute('aria-labelledby'),savedTab.id);
 checks.push('standalone My configurations tab labels its own visible panel without requiring management mode');
 await act(async()=>root.unmount());root=createRoot(document.getElementById('root'));
 await act(async()=>root.render(React.createElement(Harness)));await flush();
 await click('[data-service="custom"]');assert.ok(document.querySelector('#custom-editor'));assert.equal(document.querySelectorAll('#custom-editor input').length,3);assert.equal(document.querySelector('[data-fixture-panel="EnhancementsPanel"]'),null);
 await click('.configuration-choice:not([data-service]):not([data-saved-provider])');assert.ok(document.querySelector('[data-fixture-panel="EnhancementsPanel"]'));
 await click('.configuration-management-actions button');await click('[data-service="custom"]');assert.ok(document.querySelector('#custom-editor'));assert.equal(document.querySelector('[data-fixture-panel="EnhancementsPanel"]'),null);
 await act(async()=>root.unmount());root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(Harness,{initial:'saved'})));await flush();assert.ok(document.querySelector('[data-fixture-panel="EnhancementsPanel"]'));await click('.configuration-management-actions button');await click('[data-service="custom"]');assert.ok(document.querySelector('#custom-editor'));
 await click('#configuration-clients-tab');await click('[data-client-download="codex"]');
 const link=label=>document.querySelector(`#configuration-clients [aria-label="${label}"]`);
 assert.ok(link('ChatGPT Desktop 官网入口'));assert.equal(link('ChatGPT Desktop 官网入口').href,'https://learn.chatgpt.com/docs/app');
 assert.ok([...document.querySelectorAll('#configuration-clients details')].every(item=>!item.open));
 for(const [platform,arch,site]of [['Windows','x64','chatgpt-windows-x64-mirror'],['Windows','ARM64','chatgpt-windows-arm64-mirror'],['Mac','Apple Silicon','chatgpt-mac-arm64-mirror'],['Mac','Intel','chatgpt-mac-x64-mirror']]){const name=`${platform} ${arch} 国内镜像下载（第三方）`;assert.equal(link(name).href,globalThis.__providerDialogFixture.api.setupWebsites[site]);await click(`#configuration-clients [aria-label="${name}"]`);assert.equal(opened.at(-1),site);}
 await click('#configuration-clients [aria-label="ChatGPT Desktop 官网入口"]');assert.equal(opened.at(-1),'codex');await click('#configuration-clients [aria-label="Codex CLI 安装说明"]');assert.equal(opened.at(-1),'download-codex-cli');
 checks.push('current ChatGPT Desktop and Codex CLI keep distinct official and installation entries with explicit third-party mirror architectures');
 for(const [client,label,site]of [['pi','Pi CLI','download-pi'],['qoder','Qoder CLI','download-qoder'],['workbuddy','WorkBuddy Desktop','download-workbuddy']]){
  await click(`[data-client-download="${client}"]`);const intent=client==='workbuddy'?'官网入口':'安装说明';assert.equal(link(`${label} ${intent}`).href,globalThis.__providerDialogFixture.api.setupWebsites[site]);await click(`#configuration-clients [aria-label="${label} ${intent}"]`);assert.equal(opened.at(-1),site);assert.equal(document.querySelectorAll('#add-configuration-dialog').length,1);
 }
 checks.push('Pi and Qoder installation documentation and WorkBuddy website dispatch exact approved link keys in the same configuration card');
 for(const id of ['minimax-code','vscode','trae','cline','t3-code'])assert.equal(document.querySelector(`[data-client-download="${id}"]`),null,'unverified clients do not promise model management');
 for(const [client,label,site,url]of [['goose','Goose','download-goose','https://goose-docs.ai/docs/getting-started/installation']]){await click(`[data-client-download="${client}"]`);assert.equal(link(`${label} 官网入口`).href,new URL(url).href);await click(`#configuration-clients [aria-label="${label} 官网入口"]`);assert.equal(opened.at(-1),site);}
 checks.push('unverified clients stay outside management while Goose retains its official installation instructions');
 await click('[data-client-download="qwen-code"]');assert.equal(document.querySelectorAll('#configuration-clients .setup-card-download-groups').length,1);assert.equal(link('Qwen Code CLI 安装说明').href,'https://qwen.ai/qwencode');assert.equal(document.querySelector('#configuration-clients h4').textContent,'Qwen Code CLI');await click('#configuration-clients [aria-label="Qwen Code CLI 安装说明"]');assert.equal(opened.at(-1),'download-qwen-code');
 checks.push('Qwen Code exposes a single real terminal installation entry without inventing a Desktop app');
 await click('[data-client-download="opencode"]');
 for(const [platform,arch,site]of [['Windows','x64','opencode-windows-x64-download'],['Windows','ARM64','opencode-windows-arm64-download'],['Mac','Apple Silicon','opencode-mac-arm64-download'],['Mac','Intel','opencode-mac-x64-download']]){
  const label=`${platform} ${arch} Desktop 官方下载`;assert.equal(link(label).href,globalThis.__providerDialogFixture.api.setupWebsites[site]);await click(`#configuration-clients [aria-label="${label}"]`);assert.equal(opened.at(-1),site);
 }
 assert.equal(link('Mac Apple Silicon Desktop 官方下载').href.endsWith('-arm64.dmg'),true);assert.equal(link('Mac Intel Desktop 官方下载').href.endsWith('-x64.dmg'),true);
 checks.push('actual binary links label Windows/Mac and x64/ARM64/Apple Silicon/Intel before dispatch without substituting host architecture');
 openFailure=true;await click('#configuration-clients [aria-label="Mac Intel Desktop 官方下载"]');assert.equal(notices.at(-1)[1],'打开下载入口失败');await click('[data-client-download="pi"]');await click('#configuration-clients [aria-label="Pi CLI 安装说明"]');assert.equal(notices.at(-1)[1],'打开官方页面失败');openFailure=false;
 checks.push('rejected page and binary open operations are handled with distinct accurate failure feedback');
 await act(async()=>root.unmount());
 console.log(JSON.stringify({passed:true,checks,scope:'actual React AddConfigurationDialog, ClientDownloads and Base UI; approved production URL map with synthetic open dispatcher; no network downloads or installed-client consumption'}));
}finally{if(document.getElementById('root').childNodes.length)await act(async()=>root.unmount());dom.window.close();}
