// Opt-in local preview. The public site build does not include this experiment.
import { access, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import esbuild from 'esbuild';
import assert from 'node:assert/strict';
import { rawTextPlugin } from '../build/raw-text-plugin.mjs';
const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'test-results/site-preview');
await access(resolve(output, 'app.html')); // Run npm run build:site first.
for (const [source, target] of [['index.html', 'design-lab.html'], ['design-lab.css', 'design-lab.css'], ['design-lab.js', 'design-lab.js'], ['app-typography.css', 'app-typography.css'], ['app-typography.js', 'app-typography.js']]) {
  await cp(resolve(root, 'web/design-lab', source), resolve(output, target));
}
await cp(resolve(root, 'web/design-lab/fonts'), resolve(output, 'design-lab-fonts'), { recursive: true });
const confirmedDesign = JSON.parse(await readFile(resolve(root, 'web/design-lab/confirmed-design-2026-10-17.json'), 'utf8'));
const landingPath = resolve(output, 'design-lab.html');
const landingHtml = await readFile(landingPath, 'utf8');
await writeFile(landingPath, landingHtml.replace('<!-- CONFIRMED_DESIGN -->', `<script id="confirmed-design" type="application/json">${JSON.stringify(confirmedDesign).replaceAll('<', '\\u003c')}</script>`));
await esbuild.build({
  entryPoints: [resolve(root, 'web/design-lab/hero-field.tsx')],
  outfile: resolve(output, 'hero-field.js'),
  bundle: true, platform: 'browser', target: ['safari15', 'chrome120'],
  format: 'iife', jsx: 'automatic', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'preview-field-no-native-bridge', setup(build) {
    build.onResolve({ filter: /^@\/bridge\/api$/ }, () => ({ path: 'preview-platform', namespace: 'preview-field' }));
    // The product's crisp Canvas2D field avoids a second GPU context beside the demo.
    build.onLoad({ filter: /.*/, namespace: 'preview-field' }, () => ({ contents: 'export const isDesktop = true;', loader: 'js' }));
  } }],
  logLevel: 'warning',
});
const exampleArg = process.argv.indexOf('--examples');
const examplePath = exampleArg < 0 ? resolve(root, 'web/site/dashboard-examples.json') : resolve(process.argv[exampleArg + 1]);
const examples = JSON.parse(await readFile(examplePath, 'utf8'));
if (exampleArg >= 0) {
  assert.ok(examplePath.includes('/test-results/'), 'Local conversation fixtures cannot enter public source');
  assert.equal(examples.provenance.localOnly, true);
  assert.equal(examples.provenance.kind, 'sanitized-real-conversation');
  assert.equal(examples.provenance.requestCount, examples.state.traces.length);
  for (const trace of examples.state.traces) {
    const proof = examples.provenance.evidence.find(row => row.requestId === trace.id);
    assert.ok(proof && proof.totalTokens === trace.usage.totalTokens && proof.durationMs === trace.durationMs);
    assert.equal(trace.costSnapshot.knownCostUsd, proof.referenceCostUsd);
  }
}
const sampleTraces = examples.state.traces;
const sampleBytes = Buffer.byteLength(JSON.stringify(sampleTraces));
const period = rows => ({ tokens: rows.reduce((sum, t) => sum + t.usage.totalTokens, 0), costUsd: rows.reduce((sum, t) => sum + (t.costSnapshot?.knownCostUsd ?? 0), 0), costComplete: rows.every(t => t.costSnapshot?.costComplete === true), knownCostRequests: rows.filter(t => t.costSnapshot?.costComplete === true).length });
const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
const weekStart = new Date(dayStart); weekStart.setDate(weekStart.getDate() - (weekStart.getDay() + 6) % 7);
const sampleStats = { total: period(sampleTraces), today: period(sampleTraces.filter(t => t.startedAtMs >= +dayStart)), week: period(sampleTraces.filter(t => t.startedAtMs >= +weekStart)), series: [] };
// Compile scoped demo defaults without changing desktop or public-site behavior.
await esbuild.build({
  entryPoints: [resolve(root, 'web/design-lab/app-entry.ts')],
  outfile: resolve(output, 'design-lab-app.js'),
  bundle: true, platform: 'browser', target: ['safari15', 'chrome120'],
  format: 'iife', jsx: 'automatic', minify: true,
  alias: { '@': resolve(root, 'src/renderer') }, loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"' }, supported: { 'template-literal': false }, logLevel: 'warning',
  plugins: [{ name: 'design-lab-defaults', setup(build) {
    build.onLoad({ filter: /(?:ModelsPage\.tsx|previewApi\.ts|app-entry\.tsx)$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8');
      const replace = (from, to) => { assert.ok(contents.includes(from), `Preview default changed: ${from}`); contents = contents.replace(from, to); };
      if (path.endsWith('/ModelsPage.tsx')) replace("React.useState<DownloadClientId>('claude')", "React.useState<DownloadClientId>('codex')");
      if (path.endsWith('/previewApi.ts')) {
        replace('showThroughput: true,', 'showThroughput: false,');
        const start = contents.indexOf('  const previewTraceStats =');
        const end = contents.indexOf('  const hasUpdate =', start);
        assert.ok(start >= 0 && end > start, 'Preview statistics entry changed');
        contents = contents.slice(0, start) + `  const previewTraceStats = (): ManagerTraceStats => (${JSON.stringify(sampleStats)});\n\n` + contents.slice(end);
      }
      // Reflect this isolated sample rather than the unrelated public demo totals.
      if (path.endsWith('/site/app-entry.tsx')) replace('traceStorageBytes: 612 * 1024 ** 2, storageText: `612 MB / ${state.traceWarningGB ?? 1} GB`', `traceStorageBytes: ${sampleBytes}, sessions: ${examples.state.sessions.length}, traces: ${sampleTraces.length}, storageText: '${Math.round(sampleBytes / 1024 ** 2)} MB 脱敏示例'`);
      return { contents, loader: path.endsWith('tsx') ? 'tsx' : 'ts' };
    });
  } }],
});
let appHtml = await readFile(resolve(output, 'app.html'), 'utf8');
const previewTypography = '<link rel="stylesheet" href="./design-lab-fonts/fonts.css"><link rel="stylesheet" href="./app-typography.css"><script src="./app-typography.js"></script>';
await writeFile(resolve(output, 'design-lab-app.html'), appHtml.replace('app-preview.js', 'design-lab-app.js').replace('</head>', `${previewTypography}</head>`));
const viewerModule = await esbuild.build({
  stdin: { contents: "export { renderTapViewerHtml } from './src/renderer/trace/viewerHtml';", resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false, plugins: [rawTextPlugin], logLevel: 'silent'
});
const { renderTapViewerHtml } = await import('data:text/javascript;base64,' + Buffer.from(viewerModule.outputFiles[0].text).toString('base64'));
let viewer = renderTapViewerHtml({ mode: 'static', state: examples.state });
assert.ok(viewer.includes('let explicitRailMode;'), 'Viewer rail preference entry changed');
viewer = viewer.replace('let explicitRailMode;', "let explicitRailMode = 'mini';");
viewer = viewer.replace('<title>Trace 模型请求追踪</title>', '<title>XwX Deck 仪表盘：真实对话脱敏预览</title>');
viewer = viewer.replace('<div class="top-actions">', '<div class="top-actions"><span style="font-size:12px;color:var(--muted)">真实请求，已脱敏。Token、耗时与参考费用保留采集值。</span>');
await writeFile(resolve(output, 'design-lab-view.html'), viewer.replace('</head>', `${previewTypography}</head>`));
console.log(`[design-lab] /design-lab.html: ${examples.state.traces.length} real requests; local preview only, no deployment`);
