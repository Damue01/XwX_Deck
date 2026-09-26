import { build } from 'esbuild';
import { mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, relative } from 'node:path';
import { rawTextPlugin } from './raw-text-plugin.mjs';
import { sanitizeClientEnv } from './sanitized-client-env.mjs';

const root = resolve(import.meta.dirname, '..');
const temp = resolve(root, '.tmp-provider-selection');
if (relative(root, temp) !== '.tmp-provider-selection') throw new Error('Invalid test output directory');
const output = resolve(temp, 'run.mjs');
await mkdir(temp, { recursive: true });
try {
  await build({
    stdin: { contents: `
      import { testServiceSyncRegressions } from './tools/service-regressions';
      import { testProviderSelections } from './tools/provider-selection-regressions';
      import { mkdtemp, rm } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join, dirname, resolve } from 'node:path';
      const root = await mkdtemp(join(tmpdir(), 'xwx-provider-selection-'));
      try { await testProviderSelections(root); await testServiceSyncRegressions(root); }
      finally {
        if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error('Invalid fixture directory');
        await rm(root, { recursive: true, force: true });
      }
    `, loader: 'ts', resolveDir: root },
    outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    packages: 'external', plugins: [rawTextPlugin], logLevel: 'silent'
  });
  const electron = createRequire(import.meta.url)('electron');
  process.exitCode = await new Promise((done, reject) => {
    const child = spawn(electron, [output], { cwd: root, stdio: 'inherit', env: { ...sanitizeClientEnv(), ELECTRON_RUN_AS_NODE: '1' } });
    child.on('error', reject);
    child.on('exit', code => done(code ?? 1));
  });
} finally {
  await rm(temp, { recursive: true, force: true });
}
