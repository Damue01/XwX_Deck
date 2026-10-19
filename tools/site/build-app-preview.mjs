// Build a local site preview from the public renderer. All generated assets stay
// in test-results; font sources are shared with the packaged application.
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { rawTextPlugin } from '../build/raw-text-plugin.mjs';
import { validateRealExamples } from './real-example-contract.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(process.env.XWX_SITE_OUTPUT_DIR ?? resolve(root, 'test-results/site-preview'));
assert.ok(output.startsWith(resolve(root, 'test-results') + sep), 'Site output must stay in test-results');
const assetVersion = async name => createHash('sha256').update(await readFile(resolve(output, name))).digest('hex').slice(0, 12);
const examples = JSON.parse(await readFile(resolve(root, 'web/site/dashboard-examples.json'), 'utf8'));
validateRealExamples(examples);
const sampleTraces = examples.state.traces;
const sampleBytes = Buffer.byteLength(JSON.stringify(sampleTraces));
const period = rows => ({ tokens: rows.reduce((sum, t) => sum + t.usage.totalTokens, 0), costUsd: rows.reduce((sum, t) => sum + (t.costSnapshot?.knownCostUsd ?? 0), 0), costComplete: rows.every(t => t.costSnapshot?.costComplete === true), knownCostRequests: rows.filter(t => t.costSnapshot?.costComplete === true).length });
const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
const weekStart = new Date(dayStart); weekStart.setDate(weekStart.getDate() - (weekStart.getDay() + 6) % 7);
const sampleStats = { total: period(sampleTraces), today: period(sampleTraces.filter(t => t.startedAtMs >= +dayStart)), week: period(sampleTraces.filter(t => t.startedAtMs >= +weekStart)), series: [] };
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await esbuild.build({
  entryPoints: [resolve(root, 'web/site/app-entry.tsx')],
  outfile: resolve(output, 'app-preview.js'),
  bundle: true, platform: 'browser', target: ['safari15', 'chrome120'],
  format: 'iife', jsx: 'automatic', minify: true,
  alias: { '@': resolve(root, 'src/renderer') }, loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"' }, supported: { 'template-literal': false }, logLevel: 'warning',
  plugins: [{ name: 'website-demo-defaults', setup(build) {
    build.onLoad({ filter: /(?:ModelsPage\.tsx|previewApi\.ts|app-entry\.tsx)$/ }, async ({ path }) => {
      const sourcePath = path.replaceAll('\\', '/');
      let contents = await readFile(path, 'utf8');
      const replace = (from, to) => { assert.ok(contents.includes(from), `Website demo entry changed: ${from}`); contents = contents.replace(from, to); };
      if (sourcePath.endsWith('/ModelsPage.tsx')) replace("React.useState<DownloadClientId>('claude')", "React.useState<DownloadClientId>('codex')");
      if (sourcePath.endsWith('/previewApi.ts')) {
        replace('showThroughput: true,', 'showThroughput: false,');
        const start = contents.indexOf('  const previewTraceStats =');
        const end = contents.indexOf('  const hasUpdate =', start);
        assert.ok(start >= 0 && end > start, 'Website statistics entry changed');
        contents = contents.slice(0, start) + `  const previewTraceStats = (): ManagerTraceStats => (${JSON.stringify(sampleStats)});\n\n` + contents.slice(end);
      }
      if (sourcePath.endsWith('/site/app-entry.tsx')) replace('traceStorageBytes: 612 * 1024 ** 2, storageText: `612 MB / ${state.traceWarningGB ?? 1} GB`', `traceStorageBytes: ${sampleBytes}, sessions: ${examples.state.sessions.length}, traces: ${sampleTraces.length}, storageText: '${Math.round(sampleBytes / 1024 ** 2)} MB 脱敏示例'`);
      return { contents, loader: path.endsWith('tsx') ? 'tsx' : 'ts' };
    });
  } }],
});
const css = spawnSync(process.execPath, [resolve(root, 'tools/build/build-renderer-css.mjs'), '--minify'], { cwd: root, stdio: 'inherit' });
if (css.status !== 0) throw Error(`Renderer styles failed to build (${css.status ?? css.signal})`);
await cp(resolve(root, 'dist/renderer/app.css'), resolve(output, 'app.css'));
await cp(resolve(root, 'web/site/index.html'), resolve(output, 'index.html'));
for (const name of ['site.css', 'fonts.css', 'language.js']) await cp(resolve(root, 'web/site', name), resolve(output, name));
await cp(resolve(root, 'assets/fonts'), resolve(output, 'fonts'), { recursive: true });
// The renderer emits content-addressed font files referenced by app.css.
await cp(resolve(root, 'dist/renderer/fonts'), resolve(output, 'fonts'), { recursive: true });
await esbuild.build({
  entryPoints: [resolve(root, 'web/site/hero-field.tsx')], outfile: resolve(output, 'hero-field.js'),
  bundle: true, platform: 'browser', target: ['safari15', 'chrome120'], format: 'iife', jsx: 'automatic', minify: true,
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning',
  plugins: [{ name: 'website-field-no-native-bridge', setup(build) {
    build.onResolve({ filter: /^@\/bridge\/api$/ }, () => ({ path: 'website-platform', namespace: 'website-field' }));
    build.onLoad({ filter: /.*/, namespace: 'website-field' }, () => ({ contents: 'export const isDesktop = true;', loader: 'js' }));
  } }],
});
await writeFile(resolve(output, 'app.html'), `<!doctype html>
<html lang="zh-CN" data-theme="day">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>XwX Deck 示例预览</title>
<link rel="stylesheet" href="./app.css?v=${await assetVersion('app.css')}"></head>
<body><div id="root"></div><script src="./app-preview.js?v=${await assetVersion('app-preview.js')}"></script></body></html>
`);
// Curated real requests are reviewed and sanitized before entering the repo.
// This offline build never reads local logs, accounts or credentials.
const viewerModule = await esbuild.build({
  stdin: { contents: "export { renderTapViewerHtml } from './src/renderer/trace/viewerHtml';", resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false, plugins: [rawTextPlugin], logLevel: 'silent'
});
const { renderTapViewerHtml } = await import('data:text/javascript;base64,' + Buffer.from(viewerModule.outputFiles[0].text).toString('base64'));
let viewer = renderTapViewerHtml({ mode: 'static', state: examples.state });
assert.ok(viewer.includes('let explicitRailMode;'), 'Viewer rail preference entry changed');
viewer = viewer.replace('let explicitRailMode;', "let explicitRailMode = 'mini';");
viewer = viewer.replace('<title>Trace 模型请求追踪</title>', '<title>XwX Deck 仪表盘：真实请求脱敏示例</title>');
const capturedDate = new Date(examples.provenance.capturedAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
const capturedEnglishDate = new Date(examples.provenance.capturedAt).toLocaleDateString('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'short', day: 'numeric' });
viewer = viewer.replace('<div class="top-actions">', '<div class="top-actions"><span class="site-example-label" style="font-size:12px;color:var(--muted)">真实请求，已脱敏　采集于 '+capturedDate+'</span>');
// Website-only language bridge; real conversation contents retain their source language.
viewer = viewer.replace('</body>', `<script>
function applySiteLanguage(language) {
  if (language !== 'zh-CN' && language !== 'en') return;
  applyViewerPreferences({ language });
  document.title = language === 'en' ? 'XwX Deck dashboard: real requests, private information removed' : 'XwX Deck 仪表盘：真实请求脱敏示例';
  document.querySelector('.site-example-label').textContent = language === 'en'
    ? 'Real requests, private information removed · Captured ${capturedEnglishDate}'
    : '真实请求，已脱敏　采集于 ${capturedDate}';
}
applySiteLanguage(new URLSearchParams(location.search).get('lang'));
addEventListener('message', event => {
  if (event.source === window.parent && event.origin === location.origin) applySiteLanguage(event.data?.deckLanguage);
});
</script></body>`);
await writeFile(resolve(output, 'view.html'), viewer);
await writeFile(resolve(output, 'viewer.html'), viewer); // Keep existing preview links working.
// Keep cached entry documents from combining old demo scripts with a new site.
let indexHtml = await readFile(resolve(output, 'index.html'), 'utf8');
for (const name of ['fonts.css', 'site.css', 'hero-field.js', 'language.js']) {
  indexHtml = indexHtml.replaceAll('./' + name, './' + name + '?v=' + await assetVersion(name));
}
indexHtml = indexHtml.replace('app.html?trace-live=1', 'app.html?v=' + await assetVersion('app.html') + '&amp;trace-live=1');
indexHtml = indexHtml.replace("'view.html'", "'view.html?v=" + await assetVersion('view.html') + "'");
await writeFile(resolve(output, 'index.html'), indexHtml);
await writeFile(resolve(output, 'CNAME'), 'xwxdeck.com\n');
await writeFile(resolve(output, '.nojekyll'), '');
const bytes = (await readFile(resolve(output, 'app-preview.js'))).length + (await readFile(resolve(output, 'app.css'))).length;
console.log(`[site] ${output} (${Math.round(bytes / 1024)} KB of generated renderer/style assets; no deployment)`);
