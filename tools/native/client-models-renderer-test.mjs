// Runs the real selectors and client model panel against delayed bridge operations.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import esbuild from 'esbuild';
import {JSDOM} from 'jsdom';
const base=resolve(process.argv[2]??resolve(import.meta.dirname,'../..'));
const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://deck.test/'});
for(const name of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLButtonElement','Element','Node','DocumentFragment','ShadowRoot','MutationObserver','Event','CustomEvent','MouseEvent','localStorage'])Object.defineProperty(globalThis,name,{configurable:true,value:name==='window'?dom.window:dom.window[name]});
globalThis.getComputedStyle=dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame=dom.window.requestAnimationFrame=callback=>setTimeout(()=>callback(performance.now()),0);
globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame=clearTimeout;
globalThis.ResizeObserver=dom.window.ResizeObserver=class{observe(){} unobserve(){} disconnect(){}};
globalThis.PointerEvent=dom.window.PointerEvent=dom.window.MouseEvent;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
const requireTarget=createRequire(resolve(base,'package.json'));
const React=requireTarget('react'),{act}=React,{createRoot}=requireTarget('react-dom/client');
const notices=[],patches=[],writes=[],readQueue=[],catalogQueue=new Map();let saved={client:'pi',providerId:'a',model:'a-old',automatic:true,configDigest:'digest-1'},writeFailure=false,writeHold=null,confirmResult=true,runtimeHold=null,reads=0;
const catalog=id=>[{id:id+'-old',vendor:'custom',protocols:['chat-completions'],clients:['codex']},{id:id+'-new',vendor:'custom',protocols:['chat-completions'],clients:['codex']}];
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
const bridge={runtime:{tracingEnabled:true},providers:{connections:['a','b'].map(id=>({id,displayName:id,baseUrl:'https://example.invalid/v1',adapter:'chat-completions',codexApiFormat:'chat-completions',claudeModels:{}})),active:{codex:null,claude:null}},patch:value=>patches.push(value),api:{
 getClientRoute:async()=>{reads++;return readQueue.length?await readQueue.shift():{...saved}},
 fetchProviderModels:async({providerId})=>catalogQueue.has(providerId)?await catalogQueue.get(providerId):catalog(providerId),
 setClientRoute:async value=>{writes.push(value);if(writeFailure)throw Error('External config changed');if(writeHold)await writeHold.promise;saved={...saved,...value};return{...saved}},
 getState:async()=>runtimeHold?await runtimeHold.promise:{tracingEnabled:true},setupWebsites:{},copyText:async()=>{},openSetupWebsite:async()=>{}
}};
globalThis.__clientModelsFixture={bridge,notices,confirm:async()=>confirmResult};
const result=await esbuild.build({stdin:{contents:"export {GatewayClientModels} from './src/renderer/features/models/GatewayClientModels';export * from './src/shared/clientDownloads';",resolveDir:base},bundle:true,platform:'node',format:'cjs',write:false,alias:{'@':resolve(base,'src/renderer')},external:['react','react/*','react-dom','react-dom/*'],plugins:[{name:'fixtures',setup(build){
 build.onResolve({filter:/^@\/(bridge\/store|lib\/i18n|lib\/toast|components\/ui\/confirm-dialog)$/},args=>({path:args.path,namespace:'fixture'}));
 build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.endsWith('i18n')?'export const t=(s,...args)=>s.replace(/\\{(\\d+)\\}/g,(_,n)=>args[n]??_);export const useLanguage=()=>{};export const getLanguage=()=>"zh-CN";':args.path.endsWith('store')?'export const useBridge=()=>globalThis.__clientModelsFixture.bridge;':args.path.endsWith('confirm-dialog')?'export const useConfirm=()=>globalThis.__clientModelsFixture.confirm;':'export const showToast=(...v)=>globalThis.__clientModelsFixture.notices.push(["success",...v]);export const showErrorToast=(...v)=>globalThis.__clientModelsFixture.notices.push(["error",...v]);'}));
}}]});
const mod={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(createRequire(resolve(base,'package.json')),mod,mod.exports);
const {GatewayClientModels,supportsModelManagement,supportsManagedModels,canonicalModelClient,CLIENT_DOWNLOADS}=mod.exports;
const root=createRoot(document.getElementById('root'));const checks=[];
const pass=name=>{checks.push(name);console.log('PASS '+name)};
const render=async active=>act(async()=>root.render(React.createElement(GatewayClientModels,{client:'pi',active})));
const providerButton=()=>document.querySelector('[aria-label="Pi 使用的模型服务"]');
const modelButton=()=>document.querySelector('[aria-label="选择模型"]');
async function wait(test,label){for(let n=0;n<100;n++){await act(async()=>{await new Promise(r=>setTimeout(r,10))});if(test())return}throw Error(label+' '+document.body.textContent)}
async function choose(button,label){await act(async()=>button.click());await wait(()=>[...document.querySelectorAll('[role="option"]')].some(e=>e.textContent===label),'open '+label);await act(async()=>{const option=[...document.querySelectorAll('[role="option"]')].find(e=>e.textContent===label);const down=new MouseEvent('pointerdown',{bubbles:true,button:0,buttons:1});Object.defineProperty(down,'pointerType',{value:'mouse'});option.dispatchEvent(down);option.click();});}
try{
 for(const id of ['pi','oh-my-pi','crush','gemini-cli','copilot-cli','goose','zed','hermes-agent'])assert.equal(supportsModelManagement(id),true,id);
 assert.equal(supportsManagedModels('oh-my-pi'),false);assert.notEqual(canonicalModelClient('pi'),canonicalModelClient('oh-my-pi'));
 assert.equal(canonicalModelClient('codex-cli'),'codex');assert.equal(canonicalModelClient('claude-code'),'claude');assert.equal(supportsModelManagement('deepseek-harness'),false);
 assert.equal(CLIENT_DOWNLOADS.find(c=>c.id==='workbuddy').url,'https://www.workbuddy.cn/');pass('independent CLI products retain management, manual setup stays distinct and WorkBuddy uses the desktop website');
 await render(true);await wait(()=>!providerButton()?.disabled&&modelButton()?.textContent.includes('a-old'),'initial route');
 const oldRead=deferred();readQueue.push(oldRead.promise);await render(false);await render(true);
 writeHold=deferred();runtimeHold=deferred();await choose(modelButton(),'a-new');assert.ok(modelButton().textContent.includes('a-new'),JSON.stringify({button:modelButton().outerHTML,writes,notices}));assert.equal(modelButton().disabled,true);
 await act(async()=>writeHold.resolve());writeHold=null;await wait(()=>!modelButton().disabled,'write releases selectors');assert.ok(modelButton().textContent.includes('a-new'));
 await act(async()=>oldRead.resolve({client:'pi',providerId:'a',model:'a-old',automatic:true,configDigest:'stale'}));assert.ok(modelButton().textContent.includes('a-new'));
 pass('a stale route read cannot overwrite the visible saved model and a slow runtime refresh does not lock selectors');
 writeFailure=true;await choose(modelButton(),'a-old');await wait(()=>notices.some(n=>n[0]==='error'&&n[1]==='模型配置保存失败'),'save failure');assert.ok(modelButton().textContent.includes('a-old'));
 const readsBefore=reads;await render(false);await render(true);assert.ok(modelButton().textContent.includes('a-old'));assert.equal(reads,readsBefore);
 writeFailure=false;const failed=notices.findLast(n=>n[0]==='error'&&n[1]==='模型配置保存失败');await act(async()=>failed[4].actionProps.onClick());await wait(()=>saved.model==='a-old'&&!modelButton().disabled,'retry latest model');
 pass('external-change failure retains the user choice across navigation and Retry saves that exact choice');
 const oldCatalog=deferred();catalogQueue.set('a',oldCatalog.promise);await render(false);await render(true);
 await choose(providerButton(),'b');await wait(()=>!providerButton().disabled&&providerButton().textContent.includes('b'),'provider b saved');
 await act(async()=>oldCatalog.resolve(catalog('a')));catalogQueue.delete('a');await choose(modelButton(),'b-new');await wait(()=>saved.model==='b-new','new provider catalog');
 pass('late catalog from another provider cannot replace the current list or reset an explicitly retained model');
 writeHold=deferred();await choose(modelButton(),'b-old');await render(false);await act(async()=>writeHold.resolve());writeHold=null;await render(true);await wait(()=>!modelButton().disabled&&saved.model==='b-old','finish while away');assert.ok(modelButton().textContent.includes('b-old'));
 pass('navigation during a save preserves completion and returns to the committed client model');
 const denied=deferred();catalogQueue.set('a',denied.promise);await choose(providerButton(),'a');await act(async()=>denied.reject(Error('Offline')));catalogQueue.delete('a');
 await wait(()=>notices.some(n=>n[0]==='error'&&n[1]==='模型列表读取失败'),'catalog error');assert.ok(modelButton().textContent.includes('b-old'));
 const catalogFailure=notices.findLast(n=>n[0]==='error'&&n[1]==='模型列表读取失败');await act(async()=>catalogFailure[4].actionProps.onClick());await choose(modelButton(),'a-new');await wait(()=>saved.model==='a-new','catalog retry');
 pass('offline catalog is actionable and does not erase the current model; retry restores selectable models');
 const patchCount=patches.length;bridge.runtime={tracingEnabled:false};await render(true);await act(async()=>runtimeHold.resolve({tracingEnabled:true}));assert.equal(patches.length,patchCount);
 pass('a newer global Trace state is not overwritten by a delayed client save refresh');
 runtimeHold=deferred();await choose(modelButton(),'a-old');await wait(()=>saved.model==='a-old'&&!modelButton().disabled,'last save');
 await act(async()=>root.unmount());await act(async()=>runtimeHold.resolve({tracingEnabled:true}));assert.equal(patches.length,patchCount);
 pass('late runtime responses after unmount cannot patch global state');
 console.log(JSON.stringify({passed:true,checks,scope:'Actual React and Base UI selectors, delayed synthetic bridge; native client configuration/request regressions are separate',target:base}));
}finally{if(document.getElementById('root')?.firstChild)await act(async()=>root.unmount());dom.window.close();delete globalThis.__clientModelsFixture;}
