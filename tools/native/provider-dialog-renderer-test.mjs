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
globalThis.__providerDialogFixture={api:{},modelClients:[],patch(){}};
const entry=resolve(base,'src/renderer/features/settings/AddConfigurationDialog.tsx');
const result=await esbuild.build({entryPoints:[entry],bundle:true,platform:'node',format:'cjs',write:false,alias:{'@':resolve(base,'src/renderer')},external:['react','react/*','react-dom','react-dom/*'],plugins:[{name:'dialog-fixture',setup(build){
 build.onResolve({filter:/^@\/(bridge\/store|lib\/i18n|lib\/toast)$/},args=>({path:args.path,namespace:'fixture'}));
 build.onResolve({filter:/^\.\/(EnhancementsPanel|SubscriptionAccountsPanel|ImportConfigurations)$/},args=>args.importer===entry?{path:args.path,namespace:'fixture'}:undefined);
 build.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path.endsWith('store')?'export const useBridge=()=>globalThis.__providerDialogFixture':args.path.endsWith('i18n')?'export const t=s=>s;export const useLanguage=()=>{}':args.path.endsWith('toast')?'export const showToast=()=>{};export const showErrorToast=()=>{}':`import React from 'react';export const ${args.path.slice(2)}=()=>React.createElement('div',{'data-fixture-panel':'${args.path.slice(2)}'},'${args.path.slice(2)}');`}));
}}]});
const mod={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(require,mod,mod.exports);const {AddConfigurationDialog}=mod.exports;
let state;function Harness({initial='services'}){const [open,setOpen]=React.useState(true),[tab,setTab]=React.useState(initial),[selected,setSelected]=React.useState(null);state={setOpen,setTab};return React.createElement(AddConfigurationDialog,{open,busy:false,selected,onOpenChange:setOpen,onSelect:id=>{setSelected(id);if(id==='custom')setTab('saved');},onBack:()=>setSelected(null),editor:React.createElement('form',{id:'custom-editor'},...['name','url','key'].map(id=>React.createElement('input',{id:'custom-'+id,key:id}))),finalFocus:{current:null},initialTab:initial,activeTab:tab,onTabChange:setTab,managementOpen:tab==='saved',onStartAdding:()=>{setSelected(null);setTab('services');}});}
const root=createRoot(document.getElementById('root'));const click=async selector=>{const el=document.querySelector(selector);assert.ok(el,selector);await act(async()=>el.click());};const flush=async()=>act(async()=>new Promise(resolve=>setTimeout(resolve,40)));
try{
 await act(async()=>root.render(React.createElement(Harness)));await flush();
 await click('[data-service="custom"]');assert.ok(document.querySelector('#custom-editor'));assert.equal(document.querySelectorAll('#custom-editor input').length,3);assert.equal(document.querySelector('[data-fixture-panel="EnhancementsPanel"]'),null);
 await click('.configuration-choice:not([data-service]):not([data-saved-provider])');assert.ok(document.querySelector('[data-fixture-panel="EnhancementsPanel"]'));
 await click('.configuration-management-actions button');await click('[data-service="custom"]');assert.ok(document.querySelector('#custom-editor'));assert.equal(document.querySelector('[data-fixture-panel="EnhancementsPanel"]'),null);
 await act(async()=>root.unmount());const next=createRoot(document.getElementById('root'));await act(async()=>next.render(React.createElement(Harness,{initial:'saved'})));await flush();assert.ok(document.querySelector('[data-fixture-panel="EnhancementsPanel"]'));await click('.configuration-management-actions button');await click('[data-service="custom"]');assert.ok(document.querySelector('#custom-editor'));await act(async()=>next.unmount());
 console.log(JSON.stringify({passed:true,checks:['custom service selection shows the editor after entering My configurations','explicit enhancements remains available','new configuration from enhancements returns to the editor','default My configurations starts at enhancements without hiding a later custom choice'],scope:'actual React AddConfigurationDialog and Base UI; sibling panels use local fixtures; native WebView is covered by the separate native smoke'}));
}finally{if(document.getElementById('root').childNodes.length)await act(async()=>root.unmount());dom.window.close();}
