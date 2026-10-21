import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement']) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react'), { act } = React, { createRoot } = require('react-dom/client');
const detected = { available: true, clients: [{ id: 'codex', installed: true }] };
let detect = async () => detected, calls = 0, state;
globalThis.__installationFixture = { api: { detectClientInstallations: () => { calls++; return detect(); } } };
const compiled = await build({
  entryPoints: [resolve('src/renderer/features/models/useClientInstallations.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'],
  plugins: [{ name: 'fixture', setup(builder) {
    builder.onResolve({ filter: /^@\/(bridge\/store|lib\/i18n)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path.endsWith('store') ? 'export const useBridge=()=>globalThis.__installationFixture;' : 'export const t=s=>s;' }));
  } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
function Probe({ visible }) { state = mod.exports.useClientInstallations(visible); return null; }
const root = createRoot(document.getElementById('root'));
const render = visible => act(async () => root.render(React.createElement(Probe, { visible })));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const failures = [];
function check(label, verify) { try { verify(); console.log('PASS', label); } catch (error) { failures.push(label + ': ' + error.message); } }
try {
  await render(true);
  assert.deepEqual(state.snapshot, detected);
  detect = async () => { throw new Error('offline'); };
  await act(async () => { await state.refresh(); });
  check('failed detection retains the last successful snapshot and exposes retry error', () => { assert.deepEqual(state.snapshot, detected); assert.equal(state.error, 'offline'); assert.equal(state.checking, false); });
  const pending = deferred(); detect = () => pending.promise;
  const before = calls;
  let first, second;
  await act(async () => { first = state.refresh(); second = state.refresh(); window.dispatchEvent(new dom.window.Event('focus')); });
  check('button and focus refreshes share one in-flight detection', () => { assert.equal(calls - before, 1); assert.equal(state.checking, true); });
  await render(false);
  check('leaving the page clears its busy state', () => assert.equal(state.checking, false));
  const replacement = { available: true, clients: [{ id: 'codex', installed: false }] };
  detect = async () => replacement;
  await render(true);
  await act(async () => { pending.resolve(detected); await Promise.all([first, second]); });
  check('old detection cannot overwrite a newer page result', () => { assert.deepEqual(state.snapshot, replacement); assert.equal(state.checking, false); assert.equal(state.error, ''); });
  await act(async () => { await state.refresh(); });
  check('completed refresh releases the lock for the next detection', () => assert.deepEqual(state.snapshot, replacement));
  detect = () => { throw new Error('bridge unavailable'); };
  await act(async () => { await state.refresh(); });
  detect = async () => replacement;
  await act(async () => { await state.refresh(); });
  check('synchronous bridge failure also releases the lock', () => { assert.equal(state.error, ''); assert.deepEqual(state.snapshot, replacement); });
  const schedule = globalThis.setTimeout, late = deferred();
  detect = () => late.promise;
  globalThis.setTimeout = (callback, delay, ...args) => schedule(callback, delay === 8000 ? 5 : delay, ...args);
  try { await act(async () => { await state.refresh(); }); }
  finally { globalThis.setTimeout = schedule; }
  await act(async () => { late.resolve(detected); });
  check('a delayed current native detection recovers automatically after timeout', () => { assert.deepEqual(state.snapshot, detected); assert.equal(state.error, ''); });
  const stalled = deferred();
  detect = () => stalled.promise;
  globalThis.setTimeout = (callback, delay, ...args) => schedule(callback, delay === 8000 ? 5 : delay, ...args);
  try { await act(async () => { await state.refresh(); }); }
  finally { globalThis.setTimeout = schedule; }
  check('slow discovery retains clients, reports background work without a false error and restores retry', () => { assert.equal(state.error, ''); assert.equal(state.slow, true); assert.deepEqual(state.snapshot, detected); assert.equal(state.checking, false); });
  detect = async () => replacement;
  await act(async () => { await state.refresh(); stalled.resolve(detected); });
  check('timed-out bridge response cannot replace a successful retry', () => { assert.deepEqual(state.snapshot, replacement); assert.equal(state.error, ''); });
  assert.deepEqual(failures, []);
} finally { await act(async () => root.unmount()); dom.window.close(); delete globalThis.__installationFixture; }
