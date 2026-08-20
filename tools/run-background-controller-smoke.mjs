import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { rawTextPlugin } from './raw-text-plugin.mjs';
import { sanitizeClientEnv } from './sanitized-client-env.mjs';
import { computeGatewayBuildId } from './gateway-build-id.mjs';

const root = resolve(import.meta.dirname, '..');
const tempDir = resolve(root, '.tmp-background-controller-test');
const output = resolve(tempDir, 'background-controller-smoke.mjs');
const require = createRequire(import.meta.url);
const electronPath = require('electron');
const gatewayBuildId = await computeGatewayBuildId(root);
await rm(tempDir, { recursive: true, force: true });
await mkdir(tempDir, { recursive: true });
try {
  await build({
    entryPoints: [resolve(root, 'tools', 'background-controller-smoke.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    plugins: [rawTextPlugin],
    define: {
      __dirname: JSON.stringify(resolve(root, 'dist')),
      __XWX_GATEWAY_BUILD_ID__: JSON.stringify(gatewayBuildId)
    },
    sourcemap: false,
    logLevel: 'silent'
  });
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(electronPath, [output], {
      cwd: root,
      stdio: 'inherit',
      env: { ...sanitizeClientEnv(), ELECTRON_RUN_AS_NODE: '1' }
    });
    child.once('error', reject);
    child.once('exit', value => resolveExit(value ?? 1));
  });
  if (code !== 0) process.exitCode = code;
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
