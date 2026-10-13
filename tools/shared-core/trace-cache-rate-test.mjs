import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import esbuild from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';
import { rawTextPlugin } from '../build/raw-text-plugin.mjs';

// Run the same contract against either edition's actual working tree.
const root = resolve(process.argv[2] || resolve(import.meta.dirname, '../..'));
const window = {};
vm.runInNewContext(await readFile(resolve(root, 'src/shared/trace-cache-rate.browser.js'), 'utf8'), { window });
const rate = window.XwXTraceCacheRate;
const model = (input, cacheRead, cacheCreation = 0, extra = {}) => ({ version: 2, input, cacheRead, cacheCreation, ...extra });
const session = (usage, extra = {}) => ({ id: 'fixture', traceCount: 1, totalTokens: 100, usageByModel: { fixture: usage }, ...extra });
assert.equal(rate([session(model(40, 60))]), .6);
assert.equal(rate([session(model(20, 60, 20))]), .6, 'Messages writes belong in the denominator');
assert.equal(rate([session(model(0, 10)), session(model(90, 0))]), .1, 'weight tokens, never average request percentages');
assert.equal(rate([session(model(100, 0))]), 0, 'explicit zero is known');
for (const values of [[], [session(model(0, 0))], [{ traceCount: 1 }], [session(model(10, 1, 0, { version: 1 }))], [session(model(10, 1, 0, { incompleteFields: ['cacheRead'] }))], [session(model(10, 1, 0, { incompleteFields: ['cacheWrite'] }))], [session(model(-1, 5))], [session(model(10, NaN))], [session(model(10, 5, undefined, { cacheCreation: undefined }))]]) assert.equal(rate(values), null);
assert.equal(rate([session(model(10, 10, 0, { incompleteFields: ['output'] }))]), .5, 'output is unrelated to input cache rate');
assert.equal(rate([session(model(40, 60, 0, { inputTotal: 100, inputTotalComplete: true, incompleteFields: ['cacheWrite'] }))]), .6, 'inclusive total makes unknown writes irrelevant to hit rate');
assert.equal(rate([session(model(40, 60, 0, { inputTotal: 100, inputTotalComplete: false, incompleteFields: ['cacheWrite'] }))]), null, 'partial additive totals stay unknown');

const compiled = await esbuild.build({ entryPoints: [resolve(root, 'src/renderer/trace/viewerHtml.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [rawTextPlugin] });
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(resolve(root, 'package.json')), mod, mod.exports);
const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => errors.push(error.message));
const records = [session(model(20, 60, 20), { id: 'claude', source: 'claude-cli', client: 'claude-cli', startedAt: '2026-10-10T00:00:00Z' }), session(model(100, 0), { id: 'codex', source: 'codex-cli', client: 'codex-cli', startedAt: '2026-10-10T00:00:00Z' })];
const html = mod.exports.renderTapViewerHtml({ state: { active: false, rootPath: '/synthetic', sessions: records, traces: [] }, mode: 'static' });
const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole, beforeParse(w) { w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} }); w.ResizeObserver = class { observe() {} disconnect() {} }; w.CSS = { escape: value => value }; } });
try {
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(errors, [], 'production Viewer scripts execute without errors');
  const value = () => dom.window.document.querySelector('[data-cache-hit-rate] .dash-hs-val')?.textContent;
  assert.equal(value(), '30.0%', 'actual dashboard uses the shared weighted calculation');
  assert.equal(dom.window.document.querySelector('[data-cache-hit-rate] .dash-hs-label').textContent, '缓存命中率');
  assert.ok(!dom.window.document.querySelector('.dash-hero-side').textContent.includes('错误率'));
  dom.window.document.querySelector('[data-sfilter="claude-cli"]').click();
  assert.equal(value(), '60.0%', 'source filter recomputes from only selected sessions');
  dom.window.document.querySelector('[data-sfilter="codex-cli"]').click();
  assert.equal(value(), '0.0%', 'known zero remains distinct from unknown');
  console.log('PASS shared cache contract: weighted protocols, missing/legacy/invalid data, actual Viewer render and source-filter clicks');
} finally { dom.window.close(); }
