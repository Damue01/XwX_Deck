import { cp, mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import esbuild from 'esbuild';
import { mergeOfficialModels } from '../build/official-models.mjs';

const pilot = import.meta.dirname;
const root = resolve(pilot, '../..');
const frontend = resolve(root, 'test-results/native-frontend');
await rm(frontend,{recursive:true,force:true});
await mkdir(frontend, { recursive: true });
await cp(resolve(root, 'dist/renderer'), frontend, { recursive: true });
const assets = resolve(root, 'test-results/native-assets');
await mkdir(assets, { recursive: true });
await rm(resolve(assets, 'fonts'), { recursive: true, force: true });
await cp(resolve(frontend, 'fonts'), resolve(assets, 'fonts'), { recursive: true });
await rm(resolve(frontend, 'fonts'), { recursive: true });
const fontOrigin = process.platform === 'win32'
  ? 'http://xwx-font.localhost' : 'xwx-font://localhost';
const css = await readFile(resolve(frontend, 'app.css'), 'utf8');
await writeFile(resolve(frontend, 'app.css'), css.replaceAll('/fonts/', fontOrigin + '/fonts/'));
const html = await readFile(resolve(root, 'dist/renderer/index.html'), 'utf8');
await writeFile(resolve(frontend, 'index.html'), html.replace('<script type="module"', '<script src="./pilot-bridge.js"></script>\n    <script type="module"'));
await esbuild.build({
  entryPoints: [resolve(pilot, 'bridge.ts')],
  outfile: resolve(frontend, 'pilot-bridge.js'),
  define: { __NATIVE_ARCH__: JSON.stringify(process.arch) }, bundle: true, platform: 'browser', format: 'iife', target: ['safari15', 'chrome120'], minify: true
});
console.log('Prepared the production renderer, shared native fonts and a separate Rust bridge.');

// Render-only TypeScript runs during compilation; the shipped backend is Rust.
const { createRawTextPlugin } = await import('../../tools/build/raw-text-plugin.mjs');
const { tmpdir } = await import('node:os');
const { pathToFileURL } = await import('node:url');
const temporary = await mkdtemp(resolve(tmpdir(), 'xwx-native-assets-'));
const moduleFile = resolve(temporary, 'render.mjs');
await mkdir(assets, { recursive: true });
await cp(resolve(root,'assets/models-dev-capabilities.json'),resolve(assets,'models-dev-capabilities.json'));
try {
  await esbuild.build({ entryPoints: [resolve(root, 'tools/build/native-assets.ts')], outfile: moduleFile, bundle: true, platform: 'node', format: 'esm', plugins: [createRawTextPlugin({ sharedFonts: true })] });
  const { normalizeCache, setCatalogPriceRules, renderTapViewerHtml, getPriceRules, OFFICIAL_MODEL_REGISTRY, setupWebsitesFor, CLIENT_DOWNLOADS } = await import(pathToFileURL(moduleFile).href);
  // Never read normal user data during a build. Embed the checked repository
  // catalog so native offline pricing is the same as the retained backend.
  const priceCache = normalizeCache(JSON.parse(await readFile(resolve(root, 'assets/models-dev-pricing.json'), 'utf8')));
  if (!priceCache) throw Error('Bundled model prices are missing or invalid.');
  setCatalogPriceRules(priceCache.rules);
  let viewer=renderTapViewerHtml({ state: { active: false, rootPath: '', sessions: [], traces: [] }, mode: 'live' });
  const blocks=[...viewer.matchAll(/<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>/gi)].reverse();
  for(const block of blocks){if(block[1]==='script'&&/application\/json/.test(block[2]))continue;const transformed=await esbuild.transform(block[3],{loader:block[1]==='script'?'js':'css',minify:true,legalComments:'inline',target:['safari15','chrome120']});viewer=viewer.slice(0,block.index)+`<${block[1]}${block[2]}>${transformed.code}</${block[1]}>`+viewer.slice(block.index+block[0].length);}
  await writeFile(resolve(assets, 'viewer.html'), viewer);
  await writeFile(resolve(assets, 'clients.json'), JSON.stringify(CLIENT_DOWNLOADS));
  await writeFile(resolve(assets, 'prices.json'), JSON.stringify(getPriceRules()));
  // Retired capability tables must not remain in the embedded resource set.
  for (const retired of ['builtin-models.json', 'probed-models.json']) await rm(resolve(assets, retired), { force: true });
  const protocolTable = JSON.parse(await readFile(resolve(root, 'assets/model-protocols.json'), 'utf8'));
  await writeFile(resolve(assets, 'official-models.json'), JSON.stringify(mergeOfficialModels(OFFICIAL_MODEL_REGISTRY, protocolTable)));
  await writeFile(resolve(assets, 'setup-websites.json'), JSON.stringify(Object.fromEntries(['darwin','win32','linux'].map(platform=>[platform,Object.fromEntries(['arm64','x64'].map(arch=>[arch,setupWebsitesFor(platform,arch)]))]))));
} finally { await rm(temporary, { recursive: true }); }
