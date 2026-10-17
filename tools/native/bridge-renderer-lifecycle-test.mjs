import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://xwxdeck.test/' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { default: React, act } = await import('react'), { createRoot } = await import('react-dom/client');
const jobs = new Map(), subscriptions = { state: new Set(), update: new Set(), details: new Set() }, checks = [];
const deferredMethods = ['getState', 'getProviders', 'getCodexConfig', 'getClaudeModels', 'getCompatibleServiceConfig', 'getTraceStats', 'getModelServices'];
const api = {};
for (const method of deferredMethods) {
  jobs.set(method, []);
  api[method] = () => {
    let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const job = { resolve, reject, promise }; jobs.get(method).push(job); return promise;
  };
}
for (const method of ['getUpdateState', 'getClaudeDesktopSync', 'getCodexEnhancements']) api[method] = async () => ({});
api.getModelClients = async () => ['claude', 'codex'];
for (const [method, kind] of [['onState', 'state'], ['onUpdateState', 'update'], ['onShowUpdateDetails', 'details']]) api[method] = callback => {
  subscriptions[kind].add(callback); return () => subscriptions[kind].delete(callback);
};
globalThis.__bridgeFixture = { api, notices: [] };
const rootPath = resolve(import.meta.dirname, '../..'), entry = resolve(rootPath, 'src/renderer/bridge/store.tsx');
const bundle = await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react/*'], plugins: [{ name: 'deferred-native-bridge', setup(build) {
    build.onResolve({ filter: /^\.\/api$/ }, args => args.importer === entry ? { path: 'api', namespace: 'fixture' } : undefined);
    build.onResolve({ filter: /^@\/lib\/toast$/ }, () => ({ path: 'toast', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'api'
      ? 'export const getApi=()=>globalThis.__bridgeFixture.api;export const isDesktop=()=>true;'
      : 'export const showLifecycleNotice=n=>globalThis.__bridgeFixture.notices.push(n);export const recordDiagnosticNotice=n=>globalThis.__bridgeFixture.notices.push(n);' }));
  } }],
});
const compiled = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(resolve(rootPath, 'package.json')), compiled, compiled.exports);
const { BridgeProvider, useBridge } = compiled.exports;
let latest; function Consumer() { latest = useBridge(); return React.createElement('output', null, latest.booted ? 'ready' : 'loading'); }
const root = createRoot(document.getElementById('root'));
const last = method => jobs.get(method).at(-1), pass = name => { checks.push(name); console.log('PASS ' + name); };
const provider = marker => ({ marker, version: 1, connections: [], selected: {}, active: {} });
const publish = runtime => { for (const callback of subscriptions.state) void callback(runtime); };
try {
  await act(async () => { root.render(React.createElement(React.StrictMode, null, React.createElement(BridgeProvider, null, React.createElement(Consumer)))); });
  assert.equal(latest.booted, true); assert.deepEqual(latest.modelClients, ['claude', 'codex']); assert.equal(latest.providers, null);
  // Release the first StrictMode mount's stale requests; they must be inert.
  await act(async () => { for (const list of jobs.values()) for (const job of list.slice(0, -1)) job.reject(Error('late StrictMode startup rejection')); });
  assert.equal(globalThis.__bridgeFixture.notices.length,0,'unmounted StrictMode reads must not write global failure history');
  await act(async () => { latest.patch({ providers: provider('saved'), codexConfig: { marker: 'saved-codex' } }); });
  await act(async () => { last('getProviders').resolve(provider('old-boot')); last('getCodexConfig').resolve({ marker: 'old-codex' }); last('getClaudeModels').resolve({ marker: 'independent-claude' }); });
  assert.equal(latest.providers.marker, 'saved'); assert.equal(latest.codexConfig.marker, 'saved-codex'); assert.equal(latest.claudeModels.marker, 'independent-claude');
  pass('slow boot reads cannot overwrite committed provider/model choices, while unrelated slices load without waiting');
  const initialState = last('getState'), initialStats = last('getTraceStats');
  await act(async () => { publish({ tracingEnabled: true, traceRoot: '/new', sessions: 1, traces: 1 }); });
  const eventStats = last('getTraceStats');
  await act(async () => { initialState.resolve({ tracingEnabled: false, traceRoot: '/old' }); eventStats.resolve({ marker: 'current-stats' }); initialStats.resolve({ marker: 'old-stats' }); });
  assert.equal(latest.runtime.tracingEnabled, true); assert.equal(latest.traceStats.marker, 'current-stats');
  pass('new runtime broadcasts and their statistics survive older startup responses');
  const traceProviders = last('getProviders'), traceCodex = last('getCodexConfig');
  await act(async () => { latest.patch({ providers: provider('explicit-after-start'), codexConfig: { marker: 'explicit-after-start' } }); });
  await act(async () => { traceProviders.resolve(provider('stale-trace-refresh')); traceCodex.resolve({ marker: 'stale-trace-refresh' }); });
  assert.equal(latest.providers.marker, 'explicit-after-start'); assert.equal(latest.codexConfig.marker, 'explicit-after-start');
  await act(async () => { publish({ tracingEnabled: false, traceRoot: '/new', sessions: 1, traces: 1 }); });
  await act(async () => { last('getProviders').resolve(provider('verified-direct')); last('getCodexConfig').resolve({ marker: 'verified-direct' }); });
  assert.equal(latest.providers.marker, 'verified-direct'); assert.equal(latest.codexConfig.marker, 'verified-direct');
  pass('Trace refreshes cannot undo a later choice, but a subsequent stop can publish its newly restored direct snapshot');
  let earlier, later;
  await act(async () => { void latest.refreshStats(); earlier = last('getTraceStats'); void latest.refreshStats(); later = last('getTraceStats'); });
  await act(async () => { earlier.resolve({ marker: 'earlier-first' }); });
  await act(async () => { later.resolve({ marker: 'later-last' }); });
  assert.equal(latest.traceStats.marker, 'later-last');
  await act(async () => { void latest.refreshStats(); earlier = last('getTraceStats'); void latest.refreshStats(); later = last('getTraceStats'); });
  await act(async () => { later.resolve({ marker: 'later-first' }); earlier.resolve({ marker: 'earlier-last' }); });
  assert.equal(latest.traceStats.marker, 'later-first');
  pass('read order is stable in both completion orders; an earlier read finishing first does not suppress a newer result');
  await act(async () => { window.dispatchEvent(new Event('xwxdeck:metadata-changed')); });
  await act(async () => { latest.patch({ providers: provider('saved-during-refresh') }); last('getProviders').resolve(provider('old-metadata')); last('getClaudeModels').resolve({ marker: 'refreshed-claude' }); });
  assert.equal(latest.providers.marker, 'saved-during-refresh'); assert.equal(latest.claudeModels.marker, 'refreshed-claude');
  pass('metadata refresh retains a newly saved provider while still accepting independent model data');
  await act(async () => { window.dispatchEvent(new Event('xwxdeck:metadata-changed')); last('getProviders').reject(Error('isolated catalog failure')); });
  assert.ok(latest.loadIssues.some(issue => issue.startsWith('加载模型服务列表：加载失败')));
  assert.equal(globalThis.__bridgeFixture.notices.length,1,'active non-runtime load failure is retained without a blocking toast');
  assert.equal(globalThis.__bridgeFixture.notices[0].message,'加载模型服务列表失败');
  await act(async () => { latest.retryInitialData(); });
  await act(async () => { last('getProviders').resolve(provider('successful-retry')); });
  assert.equal(latest.providers.marker, 'successful-retry'); assert.ok(!latest.loadIssues.some(issue => issue.startsWith('加载模型服务列表：')));
  pass('failed refresh remains actionable and a successful retry publishes fresh data and clears its issue');
  await act(async () => { window.dispatchEvent(new Event('xwxdeck:metadata-changed')); });
  const lateFailure=last('getProviders'),noticeCount=globalThis.__bridgeFixture.notices.length;
  const patch = latest.patch;
  await act(async () => { root.unmount(); patch({ providers: provider('after-unmount') }); });
  assert.equal(subscriptions.state.size + subscriptions.update.size + subscriptions.details.size, 0);
  await act(async () => { lateFailure.reject(Error('late rejection after final unmount')); for (const list of jobs.values()) for (const job of list) job.resolve({}); });
  assert.equal(globalThis.__bridgeFixture.notices.length,noticeCount,'late failures after unmount cannot replace a newer diagnostic record');
  pass('StrictMode and final unmount remove subscriptions/timers and make late callbacks inert');
  console.log(JSON.stringify({ passed: true, checks, scope: 'actual React BridgeProvider under StrictMode with deferred IPC reads and push events; background ordering only, no native WebView or platform claim' }));
} finally { await act(async () => { root.unmount(); }); dom.window.close(); delete globalThis.__bridgeFixture; }
