import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const development = process.argv.includes('--development') || process.env.NODE_ENV === 'development';

// A clean output directory is part of the build contract. The packaged app
// includes dist/**/*, so stale renderer files would otherwise silently ship.
await fs.rm('dist', { recursive: true, force: true });

// Renderer (browser/ESM).
await esbuild.build({
  entryPoints: { app: 'src/renderer/main.tsx' },
  bundle: true,
  platform: 'browser',
  target: ['safari15', 'chrome120'],
  format: 'esm',
  outdir: 'dist/renderer',
  jsx: 'automatic',
  alias: { '@': path.resolve('src/renderer') },
  loader: { '.css': 'empty' },
  minify: !development,
  sourcemap: development,
  sourcesContent: false,
  logLevel: 'info'
});

// Renderer CSS (Tailwind v4).
const cssArgs = ['tools/build/build-renderer-css.mjs', ...(!development ? ['--minify'] : [])];
const css = spawnSync(process.execPath, cssArgs, { stdio: 'inherit' });
if (css.status !== 0) process.exit(css.status ?? 1);

// Copy host document.
await fs.mkdir('dist/renderer', { recursive: true });
await fs.copyFile('src/renderer/index.html', 'dist/renderer/index.html');
const edition=await esbuild.build({stdin:{contents:"export {storageKeys} from './src/shared/edition.ts'",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {storageKeys}=await import('data:text/javascript;base64,'+Buffer.from(edition.outputFiles[0].text).toString('base64'));
await fs.writeFile('dist/renderer/edition-bootstrap.js','window.__XWX_EDITION_STORAGE__='+JSON.stringify(storageKeys)+';');
const trayHtml = (await fs.readFile('src/renderer/index.html', 'utf8'))
  .replace('<html lang="zh-CN"', '<html data-surface="tray" lang="zh-CN"')
  .replace('<title>XwX Deck</title>', '<title>XwX Deck 托盘菜单</title>');
await fs.writeFile('dist/renderer/tray.html', trayHtml);
const recoveryHtml = (await fs.readFile('src/renderer/index.html', 'utf8'))
  .replace('<html lang="zh-CN"', '<html data-surface="recovery" lang="zh-CN"')
  .replace('<title>XwX Deck</title>', '<title>XwX Deck 无法启动</title>');
await fs.writeFile('dist/renderer/recovery.html', recoveryHtml);
await fs.copyFile('assets/icon-runtime.png', 'dist/renderer/icon-runtime.png');
console.log('[renderer] copied index.html and window icon');
console.log('[native] React frontend compiled; backend is Rust.');
