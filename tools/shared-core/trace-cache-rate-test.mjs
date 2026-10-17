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
vm.runInNewContext(await readFile(resolve(root, 'src/shared/trace-usage.browser.js'), 'utf8'), { window });
const usageCases = JSON.parse(await readFile(resolve(root, 'tools/shared-core/trace-usage-cases.json'), 'utf8'));
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

const partial = session(model(40, 60, 0, { incompleteFields:['input','cacheRead'], inputTotalComplete:false }), {
  traceCount:2, cacheHitUsage:{inputTokens:100,cacheReadTokens:60,knownRequests:1,excludedRequests:1}
});
assert.equal(rate([partial]), .6, 'same-model unknown requests cannot poison the known pair');
assert.equal(rate([partial, session(model(900,0))]), .06, 'known pairs remain token-weighted');
assert.equal(rate.details([partial]).excludedRequests,1);
assert.equal(rate([session(model(40,60)), {traceCount:1}]),.6, 'a separate unknown session is excluded');
assert.equal(rate([session(model(40,60)), session(model(20,NaN))]),.6, 'invalid pairs are excluded whole');
const known = rate.accumulate(undefined, {inputTotalTokens:100,inputIncludesCache:true,cacheReadTokens:60});
const excluded = rate.accumulate(known, {incompleteFields:['input','cacheRead','cacheWrite']});
assert.equal(excluded.knownRequests,1);assert.equal(excluded.excludedRequests,1);assert.equal(excluded.inputTokens,100);assert.equal(excluded.cacheReadTokens,60);

const compiled = await esbuild.build({ entryPoints: [resolve(root, 'src/renderer/trace/viewerHtml.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [rawTextPlugin] });
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(resolve(root, 'package.json')), mod, mod.exports);
const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => errors.push(error.message));
const records = [partial, session(model(20, 60, 20), { id: 'claude', source: 'claude-cli', client: 'claude-cli', startedAt: '2026-10-10T00:00:00Z' }), session(model(100, 0), { id: 'codex', source: 'codex-cli', client: 'codex-cli', startedAt: '2026-10-10T00:00:00Z' })];
const html = mod.exports.renderTapViewerHtml({ state: { active: false, rootPath: '/synthetic', sessions: records, traces: [] }, mode: 'static' });
const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole, beforeParse(w) { w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} }); w.ResizeObserver = class { observe() {} disconnect() {} }; w.CSS = { escape: value => value }; } });
try {
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(errors, [], 'production Viewer scripts execute without errors');
  for (const item of usageCases) {
    for (const [name, normalize] of [['shared browser', window.XwXNormalizeTraceUsage], ['actual Viewer', dom.window.XwXNormalizeTraceUsage]]) {
      const normalized = JSON.parse(JSON.stringify(normalize(item.raw, item.wire, undefined, item.request)));
      for (const [field, expected] of Object.entries(item.expected)) {
        assert.deepEqual(normalized[field], expected, `${item.name}: ${name}/${field}`);
      }
    }
  }
  const value = () => dom.window.document.querySelector('[data-cache-hit-rate] .dash-hs-val')?.textContent;
  assert.equal(value(), '40.0%', 'actual dashboard uses the shared weighted calculation');
  assert.equal(dom.window.document.querySelector('[data-cache-hit-rate] .dash-hs-label').textContent, '缓存命中率');
  assert.doesNotMatch(dom.window.document.querySelector('[data-cache-hit-rate]').title,/已排除|缺项|未计价/);
  assert.ok(!dom.window.document.querySelector('.dash-hero-side').textContent.includes('错误率'));
  dom.window.document.querySelector('[data-sfilter="claude-cli"]').click();
  assert.equal(value(), '60.0%', 'source filter recomputes from only selected sessions');
  dom.window.document.querySelector('[data-sfilter="codex-cli"]').click();
  assert.equal(value(), '0.0%', 'known zero remains distinct from unknown');
  const allUnknown = { id:'legacy-cache', source:'codex-cli', client:'codex-cli', traceCount:3, totalTokens:0,
    startedAt:'2026-10-14T00:00:00Z', usageByModel:{} };
  dom.window.eval('state.sessions = '+JSON.stringify([allUnknown])+';state.dashSourceFilter="all";renderDashboard();');
  assert.equal(value(),'—');
  assert.deepEqual(JSON.parse(dom.window.eval('JSON.stringify(window.XwXTraceCacheRate.details(state.sessions))')).excludedRequests,3);
  const continued = {id:'known-after-legacy',sessionId:'legacy-cache',turn:4,source:'codex-cli',
    startedAt:'2026-10-14T00:00:01Z',completedAt:'2026-10-14T00:00:02Z',
    request:{model:'fixture',apiType:'responses',body:{input:'synthetic'}},
    usage:{inputTotalTokens:100,inputIncludesCache:true,inputTokens:100,inputUncachedTokens:40,
      cacheReadTokens:60,cacheCreationTokens:0,outputTokens:5,totalTokens:105}};
  dom.window.mergeTrace(continued);dom.window.renderDashboard();
  assert.equal(value(),'60.0%');
  assert.equal(JSON.parse(dom.window.eval('JSON.stringify(window.XwXTraceCacheRate.details(state.sessions))')).excludedRequests,3, 'SSE continuation cannot lose the old summary exclusion count');
  assert.deepEqual(JSON.parse(dom.window.eval('JSON.stringify(state.sessions[0].cacheHitUsage)')),
    {inputTokens:100,cacheReadTokens:60,knownRequests:1,excludedRequests:3});
  dom.window.mergeTrace(continued);dom.window.renderDashboard();
  assert.equal(JSON.parse(dom.window.eval('JSON.stringify(window.XwXTraceCacheRate.details(state.sessions))')).excludedRequests,3, 'duplicate delivery must not accumulate pairs or exclusions twice');
  const reportedZero = {request:{model:'coverage-fixture'},usage:{version:2,inputUncachedTokens:0,inputTotalTokens:100,inputIncludesCache:true,cacheReadTokens:100,cacheCreationTokens:0,outputTokens:0,totalTokens:100}};
  const missingFields = {request:{model:'coverage-fixture'},usage:{version:2,incompleteFields:['input','output','cacheRead','cacheWrite','total']}};
  let coverage = dom.window.accumUsageByModel(undefined,reportedZero);
  coverage = dom.window.accumUsageByModel(coverage,missingFields);
  const matrix = dom.window.document.createElement('div');
  matrix.innerHTML = dom.window.renderTokenMatrix([{usageByModel:coverage}]);
  assert.deepEqual([...matrix.querySelector('tbody tr').querySelectorAll('td')].slice(1,6).map(e=>e.textContent),['0','100','0','0','100'],
    'missing usage preserves known zero and positive counters without stars');
  assert.equal(matrix.querySelector('tbody tr td:nth-child(5) span'),null);
  matrix.innerHTML = dom.window.renderTokenMatrix([{usageByModel:dom.window.accumUsageByModel(undefined,missingFields)}]);
  assert.deepEqual([...matrix.querySelector('tbody tr').querySelectorAll('td')].slice(1,6).map(e=>e.textContent),['—','—','—','—','—'],
    'completely unknown counters remain unavailable');
  assert.equal(dom.window.tokenCountHtml(0,true,true),'0');
  assert.equal(dom.window.tokenCountHtml(100,true,true).includes('*'),false);
  console.log('PASS shared cache contract: weighted protocols, missing/legacy/invalid data, actual Viewer render and source-filter clicks');
} finally { dom.window.close(); }
