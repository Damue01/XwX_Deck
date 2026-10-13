import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import esbuild from 'esbuild';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://xwxdeck.test/' });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'DocumentFragment', 'ShadowRoot', 'MutationObserver', 'Event', 'CustomEvent', 'MouseEvent', 'localStorage']) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
}
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 0);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame = clearTimeout;
globalThis.ResizeObserver = dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.PointerEvent = dom.window.PointerEvent = dom.window.MouseEvent;
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const rootPath = resolve(import.meta.dirname, '../..');
const bundle = await esbuild.build({ entryPoints: [resolve(rootPath, 'src/renderer/features/shell/Toggle.tsx')], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react/*', 'react-dom', 'react-dom/*'] });
const compiled = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(resolve(rootPath, 'package.json')), compiled, compiled.exports);
const { Toggle } = compiled.exports, root = createRoot(document.getElementById('root'));
const jobs = [], checks = [];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let state, setState;
function Harness() {
  [state, setState] = React.useState({ checked: false, busy: false });
  return React.createElement(Toggle, { id: 'subject', ...state, ariaLabel: '测试开关', onToggle: () => {
    const job = { ...deferred(), intended: !state.checked }; jobs.push(job);
    setState(previous => ({ ...previous, busy: true }));
    return job.promise;
  } });
}
const button = () => document.getElementById('subject');
const expect = (checked, busy) => { assert.equal(button().getAttribute('aria-checked'), String(checked)); assert.equal(button().getAttribute('aria-pressed'), String(checked)); assert.equal(button().disabled, busy); };
const pass = name => { checks.push(name); console.log('PASS ' + name); };
try {
  await act(async () => root.render(React.createElement(Harness)));
  await act(async () => button().click()); expect(true, true);
  await act(async () => setState(previous => ({ ...previous }))); expect(true, true);
  await act(async () => button().click()); assert.equal(jobs.length, 1);
  pass('a deferred save displays the intended state across parent renders and blocks duplicate clicks');
  await act(async () => { setState({ checked: true, busy: false }); jobs[0].resolve(); }); expect(true, false);
  await act(async () => button().click()); expect(false, true);
  await act(async () => { setState(previous => ({ ...previous, busy: false })); jobs[1].reject(Error('synthetic save failure')); }); expect(true, false);
  pass('successful save retains the new state and failed save returns to persisted state with retry enabled');
  await act(async () => button().click()); expect(false, true);
  await act(async () => setState({ checked: false, busy: false })); expect(false, false);
  await act(async () => button().click()); expect(true, true);
  await act(async () => jobs[2].resolve()); expect(true, true);
  await act(async () => { setState({ checked: true, busy: false }); jobs[3].resolve(); }); expect(true, false);
  pass('completion from an earlier operation cannot clear a later busy user intent');
  let checked = false, render;
  render = () => root.render(React.createElement(Toggle, { id: 'subject', checked, onToggle: () => { checked = !checked; render(); } }));
  await act(async () => render()); await act(async () => button().click()); expect(true, false);
  await act(async () => button().click()); expect(false, false);
  pass('synchronous preference controls remain immediately interactive');
  console.log(JSON.stringify({ passed: true, checks, scope: 'actual React Toggle and Base UI Switch with deferred saves; desktop WebView validated separately' }));
} finally { await act(async () => root.unmount()); dom.window.close(); }
