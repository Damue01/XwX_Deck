// Build a local site preview from the public renderer. All generated assets stay
// in test-results; the website source contains no compiled renderer or fonts.
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { rawTextPlugin } from '../build/raw-text-plugin.mjs';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'test-results/site-preview');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await esbuild.build({
  entryPoints: [resolve(root, 'web/site/app-entry.tsx')],
  outfile: resolve(output, 'app-preview.js'),
  bundle: true, platform: 'browser', target: ['safari15', 'chrome120'],
  format: 'iife', jsx: 'automatic', minify: true,
  alias: { '@': resolve(root, 'src/renderer') }, loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"' }, supported: { 'template-literal': false }, logLevel: 'warning',
});
const css = spawnSync(process.execPath, [resolve(root, 'tools/build/build-renderer-css.mjs'), '--minify'], { cwd: root, stdio: 'inherit' });
if (css.status !== 0) throw Error(`Renderer styles failed to build (${css.status ?? css.signal})`);
await cp(resolve(root, 'dist/renderer/app.css'), resolve(output, 'app.css'));
await cp(resolve(root, 'web/site/index.html'), resolve(output, 'index.html'));
await writeFile(resolve(output, 'app.html'), `<!doctype html>
<html lang="zh-CN" data-theme="day">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>XwX Deck 示例预览</title>
<link rel="stylesheet" href="./app.css"></head>
<body><div id="root"></div><script src="./app-preview.js"></script></body></html>
`);
// The dashboard demo uses the same Viewer renderer as the release, with only
// explicitly synthetic sessions. It never calls a local Gateway or reads logs.
const viewerModule = await esbuild.build({
  stdin: { contents: "export { renderTapViewerHtml } from './src/renderer/trace/viewerHtml';", resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false, plugins: [rawTextPlugin], logLevel: 'silent'
});
const { renderTapViewerHtml } = await import('data:text/javascript;base64,' + Buffer.from(viewerModule.outputFiles[0].text).toString('base64'));
const time = '2026-10-15T08:30:00Z';
const environment = '<environment_context>\n<cwd>/demo/project</cwd>\n<shell>zsh</shell>\n<current_date>2026-10-15</current_date>\n<permissions approval_policy="never" />\n</environment_context>';
const examples = [
  { id: 'demo-codex', source: 'codex-cli', title: '整理项目文档', model: 'gpt-6.1-sol', prompt: '检查项目结构，整理一份入门说明。', answer: '已整理运行步骤、目录结构和测试入口。', cost: .014, tokens: 4820 },
  { id: 'demo-claude', source: 'claude-cli', title: '优化设置表单', model: 'claude-sonnet-5-5', prompt: '检查设置表单的键盘操作和焦点恢复。', answer: '已检查表单布局，并保留关闭弹层后的焦点。', cost: .009, tokens: 3260 }
];
const traces = examples.map((e, i) => ({
  id: e.id + '-request', sessionId: e.id, turn: 1, source: e.source, client: e.source,
  startedAt: time, completedAt: time, durationMs: 1800 + i * 400,
  request: { method: 'POST', path: '/v1/responses', model: e.model, apiType: 'responses', body: { model: e.model, input: [{ role: 'user', content: environment }, { role: 'user', content: e.prompt }] } },
  response: { statusCode: 200, body: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: e.answer }] }] } },
  usage: { version: 2, inputUncachedTokens: e.tokens - 120, inputTotalTokens: e.tokens - 120, inputIncludesCache: true, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 120, totalTokens: e.tokens },
  costSnapshot: { version: 1, knownCostUsd: e.cost, costComplete: true }
}));
const sessions = examples.map(e => ({ id: e.id, source: e.source, title: e.title, firstPrompt: e.prompt, firstModel: e.model, startedAt: time, updatedAt: time, traceCount: 1, totalTokens: e.tokens, usageByModel: { [e.model]: { version: 2, input: e.tokens - 120, output: 120, cacheRead: 0, cacheCreation: 0, total: e.tokens, capturedCost: { cost: e.cost, complete: true } } } }));
let viewer = renderTapViewerHtml({ mode: 'static', state: { active: false, rootPath: '示例数据，不读取本机文件', sessions, traces, sessionTraces: Object.fromEntries(examples.map(e => [e.id, traces.filter(t => t.sessionId === e.id)])) } });
viewer = viewer.replace('<title>Trace 模型请求追踪</title>', '<title>XwX Deck 仪表盘示例</title>');
await writeFile(resolve(output, 'viewer.html'), viewer);
await writeFile(resolve(output, 'CNAME'), 'xwxdeck.com\n');
await writeFile(resolve(output, '.nojekyll'), '');
const bytes = (await readFile(resolve(output, 'app-preview.js'))).length + (await readFile(resolve(output, 'app.css'))).length;
console.log(`[site] test-results/site-preview (${Math.round(bytes / 1024)} KB of generated renderer/style assets; no deployment)`);
