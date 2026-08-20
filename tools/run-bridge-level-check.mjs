/**
 * Bundles and runs tools/bridge-level-check.ts so the check exercises the real
 * bridge module instead of a copy of its rules. Manual diagnostic: it sends
 * live requests and is never wired into `npm test`.
 */
import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const tempDir = resolve(root, '.tmp-bridge-check');
const output = resolve(tempDir, 'bridge-level-check.mjs');

await rm(tempDir, { recursive: true, force: true });
await mkdir(tempDir, { recursive: true });

try {
  await build({
    entryPoints: [resolve(root, 'tools', 'bridge-level-check.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    sourcemap: false,
    logLevel: 'silent'
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [output], { cwd: root, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => resolveExit(code ?? 1));
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
