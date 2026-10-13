import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
const require=createRequire(import.meta.url),rootPath=resolve(import.meta.dirname,'../..');
const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost'});
for(const key of ['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','MutationObserver','DocumentFragment'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
globalThis.getComputedStyle=dom.window.getComputedStyle.bind(dom.window);globalThis.requestAnimationFrame=cb=>setTimeout(cb,0);globalThis.cancelAnimationFrame=clearTimeout;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
globalThis.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};globalThis.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
dom.window.HTMLElement.prototype.scrollIntoView=function(){};dom.window.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
const React=require('react'),{act}=React,{createRoot}=require('react-dom/client');
const connections=[['official-provider','official-chatgpt'],['api-first','chatgpt-api-a'],['api-second','chatgpt-api-b']].map(([id,subscriptionAccountId])=>({id,subscriptionAccountId,displayName:'Fixture_e740eed2',bearerToken:'synthetic',codexModel:'fixture',claudeModels:{fable:'fixture',opus:'fixture',sonnet:'fixture',haiku:'fixture'}}));
const writes=[];let policy={enabled:true,providerIds:[]};
const bridge={providers:{connections},runtime:{tracingEnabled:true},patch(){},api:{getServiceSwitching:async()=>({codex:policy}),setServiceSwitching:async value=>{writes.push(structuredClone(value));policy=value.policy;}}};
globalThis.__enhancementsChoiceFixture={bridge};
const compiled=await build({entryPoints:[resolve(rootPath,'src/renderer/features/settings/EnhancementsPanel.tsx')],bundle:true,platform:'node',format:'cjs',write:false,alias:{'@':resolve(rootPath,'src/renderer')},external:['react','react/*','react-dom','react-dom/*'],plugins:[{name:'fixtures',setup(build){
 build.onResolve({filter:/^@\/(bridge\/store|lib\/i18n|lib\/useRememberedExpansion|components\/ui\/confirm-dialog)$/},args=>({path:args.path,namespace:'fixture'}));
 build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.endsWith('store')?'export const useBridge=()=>globalThis.__enhancementsChoiceFixture.bridge;':args.path.endsWith('useRememberedExpansion')?'export const useRememberedExpansion=()=>[true,()=>{}];':args.path.endsWith('confirm-dialog')?'export const useConfirm=()=>async()=>true;':'export const t=(s)=>s;export const useLanguage=()=>{};export const getLanguage=()=>"zh-CN";'}));
 build.onResolve({filter:/^\.\/useProviderModelDraft$/},()=>({path:'model-draft',namespace:'draft'}));
 build.onLoad({filter:/.*/,namespace:'draft'},()=>({contents:'export const useProviderModelDraft=()=>({draft:{},error:"",saving:false,save(){},retry(){}});'}));
}}]});
const mod={exports:{}};new Function('require','module','exports',compiled.outputFiles[0].text)(require,mod,mod.exports);
const root=createRoot(document.getElementById('root'));
const wait=async(test,label)=>{for(let n=0;n<100;n++){await act(async()=>new Promise(r=>setTimeout(r,10)));if(test())return;}throw Error(label+' '+document.body.textContent);};
async function open(){await act(async()=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes('添加服务')).click());await act(async()=>document.querySelector('[aria-label="添加服务"]').click());await wait(()=>document.querySelector('[role="option"]'),'choices open');}
async function choose(label){await act(async()=>{const option=[...document.querySelectorAll('[role="option"]')].find(el=>el.textContent===label);assert.ok(option,label);const down=new MouseEvent('pointerdown',{bubbles:true,button:0,buttons:1});Object.defineProperty(down,'pointerType',{value:'mouse'});option.dispatchEvent(down);option.click();});}
try{
 await act(async()=>root.render(React.createElement(mod.exports.EnhancementsPanel)));await wait(()=>document.querySelector('[aria-label="额度用尽时自动切换"]')?.disabled===false,'policy loaded');
 await open();assert.deepEqual([...document.querySelectorAll('[role="option"]')].map(el=>el.textContent),['ChatGPT 订阅（官方登录）','ChatGPT 订阅（API 授权）']);
 await choose('ChatGPT 订阅（API 授权）');await wait(()=>writes.length===1,'API choice persisted');assert.deepEqual(writes[0].policy.providerIds,['api-first']);
 await open();assert.deepEqual([...document.querySelectorAll('[role="option"]')].map(el=>el.textContent),['ChatGPT 订阅（官方登录）']);
 await choose('ChatGPT 订阅（官方登录）');await wait(()=>writes.length===2,'official choice persisted');assert.deepEqual(writes[1].policy.providerIds,['api-first','official-provider']);
 assert.equal([...document.querySelectorAll('button')].find(b=>b.textContent.includes('添加服务')).disabled,true);
 assert.ok(document.body.textContent.includes('ChatGPT 订阅（API 授权）')&&document.body.textContent.includes('ChatGPT 订阅（官方登录）'));
 console.log(JSON.stringify({passed:true,checks:['official and API ChatGPT choices have distinct labels','choosing API persists its exact provider ID','an additional API account does not produce a duplicate service entry','official remains independently selectable; both explicit provider IDs are retained'],scope:'actual React EnhancementsPanel and Base UI selection with isolated synthetic bridge; no account login or live service'}));
}finally{await act(async()=>root.unmount());dom.window.close();}
