// Real configuration cards with synthetic metadata; no credentials or client files are written.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import esbuild from 'esbuild';
import {JSDOM} from 'jsdom';

const base=resolve(import.meta.dirname,'../..'),require=createRequire(resolve(base,'package.json'));
const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://deck.test/'});
for(const name of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLButtonElement','Element','Node','DocumentFragment','ShadowRoot','MutationObserver','Event','CustomEvent','MouseEvent','localStorage'])Object.defineProperty(globalThis,name,{configurable:true,value:dom.window[name]});
globalThis.getComputedStyle=dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame=dom.window.requestAnimationFrame=callback=>setTimeout(callback,0);
globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame=clearTimeout;
globalThis.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
dom.window.HTMLElement.prototype.scrollIntoView=()=>{};
dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react'),{act}=React,{createRoot}=require('react-dom/client');
let installation={available:true,clients:[{id:'codex',installed:true},{id:'claude',installed:false}]};
let snapshot={supported:true,accounts:[
  {id:'official-chatgpt',platform:'chatgpt',status:'connected',quotaError:'读取额度失败'},
  {id:'grok-test',platform:'grok',status:'signed-out'},
  {id:'claude-test',platform:'claude',status:'signed-out',sourceError:'来源暂时不可读'}
]},readFailure=false;
const fixture={api:{setupWebsites:{},detectClientInstallations:async()=>installation,previewConfigurationImport:async()=>({sources:[]}),getSubscriptionAccounts:async()=>{if(readFailure)throw Error('读取暂时失败');return structuredClone(snapshot)}},modelClients:[],providers:{connections:[],active:{}},patch(){}};
globalThis.__configurationStateFixture=fixture;
const entry=resolve(base,'src/renderer/features/settings/AddConfigurationDialog.tsx');
const bundled=await esbuild.build({stdin:{contents:"export {AddConfigurationDialog} from './src/renderer/features/settings/AddConfigurationDialog';export {SubscriptionAccountsPanel} from './src/renderer/features/settings/SubscriptionAccountsPanel';",resolveDir:base},bundle:true,platform:'node',format:'cjs',write:false,alias:{'@':resolve(base,'src/renderer')},external:['react','react/*','react-dom','react-dom/*'],plugins:[{name:'metadata-fixture',setup(build){
  build.onResolve({filter:/^@\/(bridge\/store|lib\/i18n|lib\/toast|components\/ui\/confirm-dialog)$/},args=>({path:args.path,namespace:'fixture'}));
  build.onResolve({filter:/^\.\/(EnhancementsPanel|ImportConfigurations)$/},args=>args.importer===entry?{path:args.path,namespace:'empty'}:undefined);
  build.onLoad({filter:/.*/,namespace:'empty'},args=>({contents:`export const ${args.path.slice(2)}=()=>null;`}));
  build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.endsWith('store')?'export const useBridge=()=>globalThis.__configurationStateFixture':args.path.endsWith('i18n')?'export const t=s=>s;export const useLanguage=()=>{}':args.path.endsWith('confirm-dialog')?'export const useConfirm=()=>async()=>false':'export const showToast=()=>{};export const showErrorToast=()=>{};'}));
}}]});
const mod={exports:{}};new Function('require','module','exports',bundled.outputFiles[0].text)(require,mod,mod.exports);
const {AddConfigurationDialog,SubscriptionAccountsPanel}=mod.exports;
const connection=(id,baseUrl,extra={})=>({id,displayName:id,baseUrl,bearerToken:'',adapter:'auto',codexApiFormat:'responses',codexModel:'',codexContextWindow:0,claudeModels:{},...extra});
const connections=[connection('renamed-service','https://api.deepseek.com/v1'),connection('local','http://localhost:23456/v1',{providerPreset:'local-ollama'}),connection('plan','https://open.bigmodel.cn/api/v1',{providerPreset:'zhipu-coding-plan'}),connection('subscription','https://api.openai.com/v1',{subscriptionAccountId:'official-chatgpt'})];
let root=createRoot(document.getElementById('root'));
const flush=()=>act(async()=>new Promise(resolve=>setTimeout(resolve,25)));
const click=async selector=>{const button=document.querySelector(selector);assert.ok(button,selector);assert.equal(button.disabled,false);await act(async()=>button.click());};
const muted=selector=>document.querySelector(selector)?.getAttribute('data-unconfigured')==='true';
function Harness({saved=connections}){
  const [selected,setSelected]=React.useState(null),[tab,setTab]=React.useState('services');
  return React.createElement(AddConfigurationDialog,{open:true,busy:false,manageClients:true,selected,savedConnections:saved,onSelect:setSelected,onBack:()=>setSelected(null),onOpenChange(){},finalFocus:{current:null},editor:React.createElement('div',{'data-editor':true}),activeTab:tab,onTabChange:setTab});
}
try{
  await act(async()=>root.render(React.createElement(Harness)));await flush();
  assert.equal(muted('[data-service="deepseek"]'),false);
  assert.equal(muted('[data-service="ollama"]'),false,'saved local service needs no API Key');
  assert.equal(muted('[data-service="zhipu-coding"]'),false);
  assert.equal(muted('[data-service="zhipu"]'),true,'Coding Plan does not configure ordinary API');
  assert.equal(muted('[data-service="openai-api"]'),true,'subscription is not an API configuration');
  assert.equal(muted('[data-service="custom"]'),false);
  assert.equal(muted('.configuration-import-entry'),false);
  assert.equal(document.querySelector('.configuration-import-entry').textContent,'导入配置');
  await click('[data-service="zhipu"]');assert.equal(document.querySelector('[data-service="zhipu"]').getAttribute('aria-pressed'),'true');assert.ok(document.querySelector('[data-editor]'));
  await act(async()=>root.render(React.createElement(Harness,{saved:[]})));assert.equal(muted('[data-service="deepseek"]'),true);
  await act(async()=>root.render(React.createElement(Harness,{saved:connections})));assert.equal(muted('[data-service="deepseek"]'),false);
  await click('.configuration-import-entry');assert.equal(document.querySelector('.configuration-header h2').textContent,'导入配置');
  await act(async()=>root.unmount());root=createRoot(document.getElementById('root'));
  await act(async()=>root.render(React.createElement(AddConfigurationDialog,{open:true,busy:false,selected:null,onSelect(){},onBack(){},onOpenChange(){},finalFocus:{current:null},editor:null,manageClients:true})));await flush();
  assert.equal(muted('[data-service="deepseek"]'),false,'unknown registry is not empty');
  await click('#configuration-clients-tab');await flush();
  assert.equal(muted('[data-client-download="codex"]'),true,'installed does not imply managed');
  assert.equal(muted('[data-client-download="claude"]'),true);
  await click('[data-client-download="claude"]');assert.equal(document.querySelector('[data-client-download="claude"]').getAttribute('aria-pressed'),'true');
  fixture.modelClients=['codex-cli'];await act(async()=>root.render(React.createElement(AddConfigurationDialog,{open:true,busy:false,selected:null,onSelect(){},onBack(){},onOpenChange(){},finalFocus:{current:null},editor:null,manageClients:true})));assert.equal(muted('[data-client-download="codex"]'),false,'saved CLI enrollment owns Desktop family color');
  assert.equal(document.querySelector('[data-client-download="trae"]'),null);assert.equal(document.querySelector('[data-client-download="vscode"]'),null);
  installation={available:false,clients:[]};await act(async()=>window.dispatchEvent(new Event('focus')));await flush();assert.equal(muted('[data-client-download="claude"]'),true,'detection failure cannot enroll a client');assert.equal(muted('[data-client-download="codex"]'),false,'detection failure cannot revoke saved enrollment');
  console.log('PASS API/local/Coding Plan/subscription isolation; live save/remove; custom/import exemptions and name; client colors follow saved enrollment independently of discovery; unknown API registry stays neutral');

  await act(async()=>root.unmount());root=createRoot(document.getElementById('root'));
  const renderPanel=async visible=>{await act(async()=>root.render(React.createElement(SubscriptionAccountsPanel,{visible,open:true})));await flush();};
  await renderPanel(false);assert.equal(muted('[data-subscription-service="grok"]'),false,'unread snapshot is unknown');
  await renderPanel(true);
  assert.equal(muted('[data-subscription-service="chatgpt"]'),false,'quota error is not sign-out');
  assert.equal(muted('[data-subscription-service="grok"]'),true);
  assert.equal(muted('[data-subscription-service="claude"]'),false,'source read failure is unknown');
  assert.equal(muted('[data-subscription-service="cursor"]'),true);
  await click('[data-subscription-service="grok"]');assert.equal(document.querySelector('[data-subscription-service="grok"]').getAttribute('aria-pressed'),'true');
  snapshot={supported:true,accounts:[{id:'cursor-test',platform:'cursor',status:'connected'}]};await renderPanel(false);await renderPanel(true);
  assert.equal(muted('[data-subscription-service="chatgpt"]'),true);assert.equal(muted('[data-subscription-service="cursor"]'),false);
  readFailure=true;await renderPanel(false);await renderPanel(true);assert.equal(muted('[data-subscription-service="cursor"]'),false,'temporary read failure preserves saved snapshot');
  readFailure=false;snapshot={supported:false,accounts:[]};await renderPanel(false);await renderPanel(true);assert.equal(muted('[data-subscription-service="cursor"]'),false,'unsupported snapshot is unknown');
  snapshot={accounts:[]};await renderPanel(false);await renderPanel(true);
  assert.equal(muted('[data-subscription-service="chatgpt"]'),true,'successful native snapshot omits the optional supported field');
  console.log('PASS actual native snapshot shape without optional supported metadata remains authoritative; explicit unsupported and unread failures stay neutral');
  console.log('PASS subscription unknown/connected/signed-out/read-failure states; login and sign-out update cards without merging services; muted subscription stays selectable');
  const imported={id:'official-chatgpt-import-expiry',platform:'chatgpt',importedLogin:true,status:'signed-out',sourceLogin:'unauthenticated',sourceError:'来源授权已过期，请在原应用刷新登录后重新检测'};
  snapshot={supported:true,accounts:[imported]};await renderPanel(false);await renderPanel(true);
  assert.equal(muted('[data-subscription-service="chatgpt"]'),true,'confirmed expired source login is not unknown');
  await click('[data-subscription-service="chatgpt"]');assert.equal(document.querySelector('[data-subscription-service="chatgpt"]').getAttribute('aria-pressed'),'true');
  snapshot={supported:true,accounts:[{...imported,sourceLogin:'unknown',sourceError:'來源檔案暫時無法讀取'}]};await renderPanel(false);await renderPanel(true);
  assert.equal(muted('[data-subscription-service="chatgpt"]'),false,'source read failure remains neutral independently of localized error text');
  snapshot={supported:true,accounts:[{...imported,sourceLogin:'unknown'}]};await renderPanel(false);await renderPanel(true);
  assert.equal(muted('[data-subscription-service="chatgpt"]'),false,'typed source state takes precedence over an expired-looking display message');
  snapshot={supported:true,accounts:[{...imported,status:'connected',sourceLogin:'authenticated',sourceError:null}]};await renderPanel(false);await renderPanel(true);
  assert.equal(muted('[data-subscription-service="chatgpt"]'),false,'source recovery restores normal style for the same imported identity');
  snapshot={supported:true,accounts:[imported,{id:'another-official',platform:'chatgpt',status:'connected'}]};await renderPanel(false);await renderPanel(true);
  assert.equal(muted('[data-subscription-service="chatgpt"]'),false,'another connected account keeps its service configured');
  console.log('PASS typed imported source expiry, read failure and recovery; localized source messages do not decide readiness and confirmed expired cards stay selectable');
}finally{await act(async()=>root.unmount());dom.window.close();delete globalThis.__configurationStateFixture;}
