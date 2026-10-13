import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const base = resolve(import.meta.dirname, '../..');
const dom = new JSDOM('<div id="root"></div>', { url: 'https://deck.test/' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'MutationObserver', 'localStorage']) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 0);
globalThis.cancelAnimationFrame = clearTimeout;
const require = createRequire(resolve(base, 'package.json'));
const React = require('react'), { act } = React, { createRoot } = require('react-dom/client');
const bridge = { booted: true, modelClients: ['claude', 'codex'], api: {}, patch() {}, refreshStats: async () => {}, runtime: { tracingEnabled: true, clients: [
  { id: 'claude-cli', label: 'Claude', enabled: true, status: 'taken', statusText: '追踪中', detail: '' },
  { id: 'codex-cli', label: 'ChatGPT', enabled: true, status: 'taken', statusText: '追踪中', detail: '' },
  { id: 'pi', label: 'Pi', enabled: true, status: 'taken', statusText: '追踪中', detail: '' }
] } };
globalThis.__traceClientsFixture = bridge;
const bundle = await esbuild.build({ stdin: { contents: "export { SignalPage } from './src/renderer/features/trace/SignalPage';", resolveDir: base }, bundle: true, platform: 'node', format: 'cjs', write: false, alias: { '@': resolve(base, 'src/renderer') }, external: ['react', 'react/*', 'react-dom', 'react-dom/*'], plugins: [{ name: 'fixture', setup(build) {
  build.onResolve({ filter: /^@\/(bridge\/store|lib\/i18n|lib\/toast|components\/ui\/confirm-dialog)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
  build.onResolve({ filter: /^\.\/(ParticleField|ThroughputChart|AppearanceDrawer|ReadoutDigits)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
  build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents:
    args.path.endsWith('store') ? 'export const useBridge=()=>globalThis.__traceClientsFixture;' :
    args.path.endsWith('i18n') ? 'export const t=s=>s;export const useLanguage=()=>{};export const getLanguage=()=>"zh-CN";' :
    args.path.endsWith('toast') ? 'export const clearLifecycleNotice=()=>{};export const showLifecycleNotice=()=>{};export const showToast=()=>{};' :
    args.path.endsWith('confirm-dialog') ? 'export const useConfirm=()=>async()=>false;' :
    args.path.endsWith('ParticleField') ? 'export const ParticleField=()=>null;export const emitFieldRipple=()=>{};' :
    args.path.endsWith('AppearanceDrawer') ? 'export const AppearanceButton=()=>null;export const AppearanceDrawer=()=>null;export const customBackgroundStyle=()=>({});' :
    args.path.endsWith('ThroughputChart') ? 'export const ThroughputChart=()=>null;' : 'export const ReadoutDigits=()=>null;'
  }));
} }] });
const module = { exports: {} }; new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, module, module.exports);
const root = createRoot(document.getElementById('root'));
const render = active => act(async () => root.render(React.createElement(module.exports.SignalPage, { active })));
const sources = variant => [...document.querySelectorAll(`.${variant === 'idle' ? 'idle-state' : 'live-layout'} [data-client]`)].map(node => node.dataset.client);
try {
  await render(true);
  assert.deepEqual(sources('live'), ['claude-live', 'codex-live']);
  bridge.modelClients = ['codex']; await render(true);
  assert.deepEqual(sources('idle'), ['codex-idle']); assert.deepEqual(sources('live'), ['codex-live']);
  bridge.runtime = { ...bridge.runtime, tracingEnabled: false }; await render(true);
  assert.deepEqual(sources('idle'), ['codex-idle']);
  await render(false); bridge.runtime = { ...bridge.runtime, tracingEnabled: true }; await render(true);
  assert.deepEqual(sources('live'), ['codex-live']);
  bridge.modelClients = ['claude-code', 'codex-cli', 'pi']; await render(true);
  assert.deepEqual(sources('live'), ['claude-live', 'codex-live', 'pi-live']);
  bridge.modelClients = []; await render(true);
  assert.deepEqual(sources('idle'), []); assert.deepEqual(sources('live'), []);
  console.log('PASS real Trace component: removal in idle/live, enabled stale runtime, navigation, alias restoration, generic clients, empty list');
} finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.__traceClientsFixture; }
