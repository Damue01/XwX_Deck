import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const tempDir = resolve(root, '.tmp-cap-probe');
const output = resolve(tempDir, 'capability-probe.mjs');
await rm(tempDir, { recursive: true, force: true });
await mkdir(tempDir, { recursive: true });
try {
  await build({
    entryPoints: [resolve(root, 'tools', 'capability-probe.ts')],
    outfile: output, bundle: true, platform: 'node', format: 'esm',
    target: 'node20', packages: 'external', logLevel: 'silent'
  });
  const code = await new Promise((res, rej) => {
    const child = spawn(process.execPath, [output], { cwd: root, stdio: 'inherit' });
    child.on('error', rej); child.on('exit', c => res(c ?? 1));
  });
  if (code !== 0) process.exitCode = code;
} finally { await rm(tempDir, { recursive: true, force: true }); }
