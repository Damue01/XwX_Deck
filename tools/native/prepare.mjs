import { cp, mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import esbuild from 'esbuild';

const pilot = import.meta.dirname;
const root = resolve(pilot, '../..');
const frontend = resolve(root, 'test-results/native-frontend');
await rm(frontend,{recursive:true,force:true});
await mkdir(frontend, { recursive: true });
await cp(resolve(root, 'dist/renderer'), frontend, { recursive: true });
const html = await readFile(resolve(root, 'dist/renderer/index.html'), 'utf8');
await writeFile(resolve(frontend, 'index.html'), html.replace('<script type="module"', '<script src="./pilot-bridge.js"></script>\n    <script type="module"'));
await esbuild.build({
  entryPoints: [resolve(pilot, 'bridge.ts')],
  outfile: resolve(frontend, 'pilot-bridge.js'),
  define: { __NATIVE_ARCH__: JSON.stringify(process.arch) }, bundle: true, platform: 'browser', format: 'iife', target: ['safari15', 'chrome120'], minify: true
});
// app.js/app.css are copied byte-for-byte from the production build.
console.log('Prepared the unchanged production renderer and a separate Rust bridge.');

// Render-only TypeScript runs during compilation; the shipped backend is Rust.
const { rawTextPlugin } = await import('../../tools/raw-text-plugin.mjs');
const { tmpdir } = await import('node:os');
const { pathToFileURL } = await import('node:url');
const temporary = await mkdtemp(resolve(tmpdir(), 'xwx-native-assets-'));
const moduleFile = resolve(temporary, 'render.mjs');
const assets = resolve(root, 'test-results/native-assets');
await mkdir(assets, { recursive: true });
try {
  await esbuild.build({ stdin: { contents: `export { renderTapViewerHtml } from './src/main/trace/webview/viewerHtml'; export { getPriceRules } from './src/main/trace/pricing'; export { OFFICIAL_MODEL_REGISTRY } from './src/main/app/officialModelRegistry'; export { setupWebsitesFor } from './src/shared/setupWebsites'; export { CLIENT_DOWNLOADS } from './src/shared/clientDownloads';`, resolveDir: root, loader: 'ts' }, outfile: moduleFile, bundle: true, platform: 'node', format: 'esm', plugins: [rawTextPlugin] });
  const { renderTapViewerHtml, getPriceRules, OFFICIAL_MODEL_REGISTRY, setupWebsitesFor, CLIENT_DOWNLOADS } = await import(pathToFileURL(moduleFile).href);
  let viewer=renderTapViewerHtml({ state: { active: false, rootPath: '', sessions: [], traces: [] }, mode: 'live' });
  const blocks=[...viewer.matchAll(/<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>/gi)].reverse();
  for(const block of blocks){if(block[1]==='script'&&/application\/json/.test(block[2]))continue;const transformed=await esbuild.transform(block[3],{loader:block[1]==='script'?'js':'css',minify:true,legalComments:'inline',target:['safari15','chrome120']});viewer=viewer.slice(0,block.index)+`<${block[1]}${block[2]}>${transformed.code}</${block[1]}>`+viewer.slice(block.index+block[0].length);}
  await writeFile(resolve(assets, 'viewer.html'), viewer);
  await writeFile(resolve(assets, 'clients.json'), JSON.stringify(CLIENT_DOWNLOADS));
  await writeFile(resolve(assets, 'prices.json'), JSON.stringify(getPriceRules()));
  await writeFile(resolve(assets, 'official-models.json'), JSON.stringify(OFFICIAL_MODEL_REGISTRY));
  await writeFile(resolve(assets, 'setup-websites.json'), JSON.stringify(Object.fromEntries(['darwin','win32','linux'].map(platform=>[platform,Object.fromEntries(['arm64','x64'].map(arch=>[arch,setupWebsitesFor(platform,arch)]))]))));
} finally { await rm(temporary, { recursive: true }); }
