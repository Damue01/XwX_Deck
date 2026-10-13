// Build a local site preview from the public renderer. All generated assets stay
// in test-results; the website source contains no compiled renderer or fonts.
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'test-results/site-preview');
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
const bytes = (await readFile(resolve(output, 'app-preview.js'))).length + (await readFile(resolve(output, 'app.css'))).length;
console.log(`[site] test-results/site-preview (${Math.round(bytes / 1024)} KB of generated renderer/style assets; no deployment)`);
