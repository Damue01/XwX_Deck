import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const tempDir = resolve(root, '.tmp-trace-index-repair');
const output = resolve(tempDir, 'trace-index-repair.mjs');

await rm(tempDir, { recursive: true, force: true });
await mkdir(tempDir, { recursive: true });
try {
  await build({
    entryPoints: [resolve(root, 'tools', 'trace-index-repair-cli.ts')],
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
    const child = spawn(process.execPath, [output, ...process.argv.slice(2)], {
      cwd: root,
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('exit', code => resolveExit(code ?? 1));
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
