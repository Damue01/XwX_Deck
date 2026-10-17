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
await fs.copyFile('assets/icon-runtime.png', 'dist/renderer/icon-runtime.png');
console.log('[renderer] copied index.html and window icon');
console.log('[native] React frontend compiled; backend is Rust.');
