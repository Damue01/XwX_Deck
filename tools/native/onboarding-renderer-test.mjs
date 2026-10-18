// Exercise the actual setup dialog and discovery hook without real accounts or client files.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';
const base = resolve(import.meta.dirname, '../..');
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://deck.test/' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'DocumentFragment', 'ShadowRoot', 'MutationObserver', 'Event', 'CustomEvent', 'MouseEvent', 'localStorage', 'location']) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 0);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame = clearTimeout;
globalThis.ResizeObserver = dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.PointerEvent = dom.window.PointerEvent = dom.window.MouseEvent;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const require = createRequire(resolve(base, 'package.json'));
const React = require('react'), { act } = React, { createRoot } = require('react-dom/client');
let snapshot, failure = false, importItems = [], done = 0, imports = 0, detections = 0, previews = 0;
const opened = [];
const { setupWebsitesFor } = await (async () => {
  const result = await esbuild.build({ entryPoints: [resolve(base, 'src/shared/setupWebsites.ts')], bundle: true, platform: 'node', format: 'cjs', write: false });
  const module = { exports: {} }; new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports); return module.exports;
})();
const api = {
  setupWebsites: setupWebsitesFor('darwin', 'arm64'),
  detectClientInstallations: async () => { detections++; if (failure) throw Error('检测失败，请重新检测'); return structuredClone(snapshot); },
  previewConfigurationImport: async () => { previews++; return { targetDigest: 'fixture', sources: [{ source: 'magpie', path: '/isolated/providers.json', name: 'Magpie', found: true, error: '', items: importItems }] }; },
  importConfigurations: async () => { imports++; return { providers: {}, added: [] }; },
  openSetupWebsite: async site => opened.push(site)
};
globalThis.__onboardingFixture = { api, patch() {} };
const result = await esbuild.build({ stdin: { contents: "export { OnboardingSetup } from './src/renderer/features/onboarding/OnboardingSetup'; export { OnboardingTour } from './src/renderer/features/onboarding/OnboardingTour'; export { ClientDownloads } from './src/renderer/features/settings/ProviderSetupShortcuts';", resolveDir: base, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@': resolve(base, 'src/renderer') }, external: ['react', 'react/*', 'react-dom', 'react-dom/*'], plugins: [{ name: 'fixture', setup(build) {
  build.onResolve({ filter: /^@\/(bridge\/store|lib\/i18n|lib\/toast|features\/trace\/ParticleField)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path.endsWith('store') ? 'export const useBridge=()=>globalThis.__onboardingFixture' : args.path.endsWith('i18n') ? 'export const t=(s,...args)=>s.replace(/\\{(\\d+)\\}/g,(_,n)=>args[n]??_); export const useLanguage=()=>{}' : args.path.endsWith('ParticleField') ? 'export const ParticleField=()=>null; export const emitFieldRipple=()=>{}' : 'export const showToast=()=>{}; export const showErrorToast=()=>{}' }));
} }] });
const module = { exports: {} }; new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
const { OnboardingSetup, OnboardingTour, ClientDownloads } = module.exports;
const root = createRoot(document.getElementById('root'));
const current = () => Number(document.querySelector('.onboarding-panel').dataset.step);
const heading = () => document.querySelector('.onboarding-step:not([hidden]) h1').textContent;
const click = async text => { const button = [...document.querySelectorAll('#onboarding-setup button')].find(b => b.textContent === text && !b.closest('[hidden]')); assert.ok(button, text); await act(async () => button.click()); if (text === '开始使用') await act(async () => new Promise(resolve => setTimeout(resolve, 360))); };
let serial = 0;
const render = async installed => {
  snapshot = { available: true, clients: ['codex', 'claude', 'cursor', 'vscode', 'qwen-code'].map(id => ({ id, installed: installed.includes(id) })) };
  await act(async () => root.render(React.createElement(OnboardingSetup, { key: ++serial, onDone: () => done++, onSkip: () => done++ })));
};
try {
  for (const installed of [[], ['codex'], ['claude']]) {
    await render(installed); assert.equal(current(), 0); assert.equal(heading(), '欢迎使用 XwX Deck'); await click('开始使用'); assert.equal(current(), 1);
    assert.equal(heading(), installed.length ? (installed[0] === 'codex' ? '为您推荐 Claude' : '为您推荐 ChatGPT') : '为您推荐 ChatGPT 与 Claude'); assert.ok(!document.body.textContent.includes('可选，不安装也可以继续。'));
    const cards = [...document.querySelectorAll('.onboarding-app h2')].map(e => e.textContent);
    assert.deepEqual(cards, ['codex', 'claude'].filter(id => !installed.includes(id)).map(id => id === 'codex' ? 'ChatGPT / Codex' : 'Claude'));
    await click('继续'); assert.equal(current(), 2); await click('上一步'); assert.equal(current(), 1);
  }
  console.log('PASS only missing recommended clients appear; back preserves the conditional step');
  await render(['codex', 'claude', 'cursor', 'vscode', 'qwen-code']);
  assert.equal(heading(), '欢迎使用 XwX Deck');
  const hello = document.querySelector('.onboarding-step:not([hidden])');
  assert.deepEqual([...hello.children].map(e => e.tagName), ['H1', 'BUTTON']); assert.equal(hello.querySelector('h1').getAttribute('aria-label'), '欢迎使用 XwX Deck');
  assert.equal(document.querySelector('.onboarding-foot'), null);
  assert.equal(document.querySelector('#onboarding-setup .tour-skip').textContent, '跳过');
  console.log('PASS welcome shows only the title and start action while detection runs behind it');
  await click('开始使用'); assert.equal(current(), 2);
  assert.equal(document.querySelectorAll('.tour-dots i').length, 2); assert.equal(heading(), '没有找到之前的配置');
  await click('上一步'); assert.equal(current(), 0);
  console.log('PASS both installed skips recommendations in both directions and shows an honest empty import heading');
  importItems = [{ fingerprint: 'provider', name: 'Fixture', status: 'new', adapter: 'responses', baseUrl: 'https://example.test', reason: '' }];
  await click('开始使用'); assert.equal(heading(), '找到了您之前的配置'); assert.equal(imports, 0);
  console.log('PASS detected import candidates update the heading without importing or modifying configuration');
  const detectedIds = () => [...document.querySelectorAll('[data-detected-client]')].map(client => client.dataset.detectedClient);
  assert.deepEqual(detectedIds(), ['codex', 'claude', 'qwen-code']);
  const beforeRefresh = { detections, previews };
  snapshot.clients = [{ id: 'codex-cli', installed: true }, { id: 'codex', installed: true }, { id: 'opencode', installed: true }];
  await act(async () => document.querySelector('.configuration-import-refresh').click());
  assert.deepEqual(detectedIds(), ['codex', 'opencode']);
  assert.equal(detections, beforeRefresh.detections + 1); assert.equal(previews, beforeRefresh.previews + 1);
  failure = true;
  await act(async () => document.querySelector('.configuration-import-refresh').click());
  assert.deepEqual(detectedIds(), ['codex', 'opencode']);
  assert.ok(document.querySelector('.configuration-import-clients [role=alert]').textContent.includes('可继续导入配置'));
  assert.equal(document.querySelector('.configuration-import-actions .btn.primary').disabled, false);
  assert.equal(heading(), '找到了您之前的配置'); assert.equal(imports, 0);
  failure = false; snapshot = { available: false, clients: [] };
  await act(async () => document.querySelector('.configuration-import-refresh').click());
  assert.equal(detectedIds().length, 0);
  assert.ok(document.querySelector('.configuration-import-clients').textContent.includes('暂不支持客户端检测'));
  assert.ok(!document.querySelector('.configuration-import-clients').textContent.includes('未检测到已安装客户端'));
  console.log('PASS import step refreshes client and configuration discovery together, merges CLI/Desktop, retains known clients on failure and permits configuration import');
  importItems = []; await render(['codex']); await click('开始使用'); assert.equal(current(), 1);
  snapshot.clients = snapshot.clients.map(client => ({ ...client, installed: true }));
  await act(async () => window.dispatchEvent(new Event('focus'))); assert.equal(current(), 2);
  console.log('PASS returning after installing the missing client refreshes discovery and skips the completed recommendation');
  failure = true; await render([]); await click('开始使用'); assert.equal(current(), 1); assert.ok(document.body.textContent.includes('检测失败')); assert.equal(document.querySelectorAll('.onboarding-app').length, 0); await click('继续'); assert.equal(current(), 2);
  assert.equal(imports, 0); assert.equal(done, 0); failure = false;
  console.log('PASS unavailable discovery does not claim software is missing or prevent continuation');
  await act(async () => root.render(React.createElement(ClientDownloads, { client: 'qwen-code' })));
  assert.equal(document.querySelectorAll('details').length, 0); assert.ok(!document.body.textContent.includes('Apple Silicon'));
  const desktop = document.querySelector('a'); assert.equal(desktop.href, 'https://qwen.ai/qwencode');
  await act(async () => desktop.click()); assert.equal(opened.at(-1), 'download-qwen-code');
  assert.ok(!Object.keys(api.setupWebsites).some(key => key.startsWith('qwen-code-mac-')));
  console.log('PASS Qwen Code opens its official site without redundant Mac architecture downloads');
  snapshot={available:true,clients:[{id:'codex',installed:true},{id:'claude',installed:true}]};
  await act(async () => root.render(React.createElement(OnboardingTour)));
  await click('开始使用');
  assert.equal(current(),2);
  await act(async()=>root.render(null));
  await act(async()=>root.render(React.createElement(OnboardingTour)));
  assert.equal(current(),2);
  assert.equal(imports,0);
  console.log('PASS interrupted setup restores the import step and only repeats read-only detection');
  await click('继续');
  const deadline=Date.now()+3000;
  while(!document.querySelector('.tour-root')&&Date.now()<deadline) await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
  const expected=['添加配置','切换模型','按需开启 Trace','在仪表盘查看详情'];
  for(const [index,title]of expected.entries()){
    assert.equal(document.querySelector('.tour-title').textContent,title);
    assert.equal(document.querySelectorAll('.tour-root .tour-dots i').length,4);
    assert.ok(!/[。.]$/.test(document.querySelector('.tour-body').textContent));
    assert.equal(document.querySelector('.tour-root').dataset.tourIndex,String(index));
    if(index===2) assert.ok(document.querySelector('.tour-points').textContent.includes('需 Trace'));
    if(index===1){
      await act(async()=>root.render(null));
      await act(async()=>root.render(React.createElement(OnboardingTour)));
      assert.equal(document.querySelector('.tour-root').dataset.tourIndex,'1');
      await act(async()=>window.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape'})));
      assert.equal(document.querySelector('.tour-root'),null);
      assert.equal(localStorage.getItem('xwx-deck.onboardingSeen'),null);
      await act(async()=>root.render(null));
      await act(async()=>root.render(React.createElement(OnboardingTour)));
      assert.equal(document.querySelector('.tour-root').dataset.tourIndex,'1');
      await act(async()=>document.querySelector('.tour-back').click());
      assert.equal(document.querySelector('.tour-title').textContent,expected[0]);
      await act(async()=>document.querySelector('.tour-next').click());
    }
    if(index===3) assert.equal(document.querySelector('.tour-next').textContent,'完成');
    await act(async()=>document.querySelector('.tour-next').click());
  }
  assert.equal(document.querySelector('.tour-root'),null);
  assert.equal(localStorage.getItem('xwx-deck.onboardingSeen'),'true');
  assert.equal(localStorage.getItem('xwx-deck.onboardingProgress.v1'),null);
  await act(async()=>root.render(null));
  await act(async()=>root.render(React.createElement(OnboardingTour)));
  assert.equal(document.querySelector('[role=dialog]'),null);
  localStorage.removeItem('xwx-deck.onboardingSeen');
  localStorage.setItem('xwx-deck.onboardingProgress.v1','{"preparing":false,"setupStep":2,"index":900}');
  await act(async()=>root.render(null));
  await act(async()=>root.render(React.createElement(OnboardingTour)));
  assert.equal(current(),0);
  await click('跳过');
  await act(async()=>new Promise(resolve=>setTimeout(resolve,450)));
  assert.equal(localStorage.getItem('xwx-deck.onboardingSeen'),'true');
  assert.equal(localStorage.getItem('xwx-deck.onboardingProgress.v1'),null);
  assert.equal(imports,0);
  console.log('PASS four-step real component walkthrough supports back and finish without configuration writes or Trace activation');
  console.log('PASS restart and Escape resume the same tour step; explicit finish/skip clear progress; invalid progress starts safely');
} finally { await act(async () => root.unmount()); dom.window.close(); }
