import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { rawTextPlugin } from './raw-text-plugin.mjs';
import { sanitizeClientEnv } from './sanitized-client-env.mjs';

const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(join(root, '.tmp-desktop-effort-'));
try {
  const output = join(temp, 'run.mjs');
  await build({
    stdin: { contents: `
      import { testNightlyUpdates } from './tools/nightly-update-regressions';
      import { testClaudeMessagesBridgeRegressions } from './tools/claude-messages-bridge-regressions';
      import { testUpgradeSettings } from './tools/upgrade-settings-regressions';
      import { testSettingsActions } from './tools/settings-action-regressions';
      import { testPortableRestartFailures } from './tools/portable-restart-regressions';
      import { testClaudeDesktopEffortRegressions } from './tools/claude-desktop-effort-regressions';
      import { mkdtemp, rm } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join, dirname, resolve } from 'node:path';
      const fixtures = await mkdtemp(join(tmpdir(), 'xwx-desktop-effort-'));
      try { await testNightlyUpdates(fixtures); await testClaudeMessagesBridgeRegressions(); await testClaudeDesktopEffortRegressions(fixtures); await testSettingsActions(fixtures); await testUpgradeSettings(fixtures); await testPortableRestartFailures(fixtures); }
      finally {
        if (dirname(resolve(fixtures)) !== resolve(tmpdir())) throw new Error('Invalid fixture directory');
        await rm(fixtures, { recursive: true, force: true });
      }
    `, loader: 'ts', resolveDir: root },
    outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    packages: 'external', plugins: [rawTextPlugin], logLevel: 'silent'
  });
  const electron = createRequire(import.meta.url)('electron');
  process.exitCode = await new Promise((done, reject) => {
    const child = spawn(electron, [output], {
      cwd: root, stdio: 'inherit', env: { ...sanitizeClientEnv(), ELECTRON_RUN_AS_NODE: '1' }
    });
    child.on('error', reject);
    child.on('exit', code => done(code ?? 1));
  });
} finally {
  if (dirname(temp) !== root) throw new Error('Invalid test output directory');
  await rm(temp, { recursive: true, force: true });
}
