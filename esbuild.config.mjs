import esbuild from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeGatewayBuildId } from './tools/gateway-build-id.mjs';
import { rawTextPlugin } from './tools/raw-text-plugin.mjs';

const development = process.argv.includes('--development') || process.env.NODE_ENV === 'development';
const gatewayBuildId = await computeGatewayBuildId(path.resolve('.'));

// A clean output directory is part of the build contract. The packaged app
// includes dist/**/*, so stale renderer files would otherwise silently ship.
await fs.rm('dist', { recursive: true, force: true });

await esbuild.build({
  entryPoints: {
    main: 'src/main/main.ts',
    preload: 'src/main/preload.ts',
    'gateway-helper': 'src/main/gatewayHelper.ts',
    'exit-recovery': 'src/main/exitRecovery.ts',
    'portable-update-worker': 'src/main/portableUpdateWorker.ts',
    'application-reset-worker': 'src/main/applicationResetWorker.ts'
  },
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outdir: 'dist',
  external: ['electron', 'electron-updater'],
  define: { __XWX_GATEWAY_BUILD_ID__: JSON.stringify(gatewayBuildId) },
  plugins: [rawTextPlugin],
  minify: !development,
  keepNames: true,
  sourcemap: development,
  sourcesContent: false,
  logLevel: 'info'
});

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
const cssArgs = ['tools/build-renderer-css.mjs', ...(!development ? ['--minify'] : [])];
const css = spawnSync(process.execPath, cssArgs, { stdio: 'inherit' });
if (css.status !== 0) process.exit(css.status ?? 1);

// Copy host document.
await fs.mkdir('dist/renderer', { recursive: true });
await fs.copyFile('src/renderer/index.html', 'dist/renderer/index.html');
await fs.copyFile('assets/icon-runtime.png', 'dist/renderer/icon-runtime.png');
console.log('[renderer] copied index.html and window icon');
console.log(`[gateway] build identity ${gatewayBuildId.slice(0, 12)}`);
