import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm, mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { verifyCandidate } from './source-fingerprint.mjs';

const binary = resolve(process.env.XWX_NATIVE_TEST_BINARY ?? (process.platform === 'win32' ? 'test-results/native-package/XwX Deck.exe' : 'test-results/rust-pilot-package/XwXDeck Rust Validation.app/Contents/MacOS/xwx-deck-native'));
const build = JSON.parse(await readFile(resolve(process.env.XWX_NATIVE_TEST_BUILD_REPORT ?? (process.platform === 'win32' ? 'test-results/native-package/native-build-report.json' : 'test-results/rust-pilot-package/native-build-report.json')), 'utf8'));
const provenance = await verifyCandidate({ root: resolve('.'), report: build, binary, allowManualAcceptance: Boolean(process.env.XWX_NATIVE_TEST_BINARY && process.env.XWX_NATIVE_TEST_BUILD_REPORT) });
const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-theme-native-'));
async function removeFixture(path) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await rm(path, {recursive: true, force: true});
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code) || attempt === 19) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}
// A real sparse file exercises the settings path above 10 GB without allocating disk data.
const initialized = spawnSync(binary, ['--rpc', '--pilot-root', root], { input: '{"method":"getState","args":[]}\n', encoding: 'utf8' });
assert.equal(initialized.status, 0, initialized.stderr);
const fixture = await open(join(root, 'traces/storage-size-fixture.bin'), 'w');
await fixture.truncate(15 * 1024 ** 3); await fixture.close();
const child = spawn(binary, ['--pilot-root', root, '--smoke', '--smoke-theme', '--smoke-exit'], {
  env: { ...process.env, XWX_SYSTEM_LANGUAGE_TEST: 'zh-CN', XWX_CLIENT_INSTALLATIONS_TEST_HOME: join(root, 'installations') },
  stdio: ['ignore', 'ignore', 'inherit']
});
let passed = false;
try {
  let report;
  for (let i = 0; i < 700; i++) {
    report = await readFile(join(root, 'native-smoke.json'), 'utf8').then(JSON.parse, () => undefined);
    if (report) break;
    if (child.exitCode !== null || child.signalCode !== null) throw Error(`Native host exited: ${child.exitCode ?? child.signalCode}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(report, 'Native theme smoke timed out');
  const viewer = await readFile(join(root, 'traces/native-viewer-smoke.json'), 'utf8').then(JSON.parse, () => undefined);
  await mkdir(resolve('test-results'), { recursive: true });
  await writeFile(resolve('test-results/native-theme-summary.json'), JSON.stringify({ ...report, viewer, ...provenance }, null, 2) + '\n');
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.deepEqual(viewer.themes, ['night', 'day', 'system']);
  assert.equal((await readFile(join(root, 'settings.json'), 'utf8').then(JSON.parse)).theme, 'system');
  if (child.exitCode === null) assert.equal((await once(child, 'exit'))[0], 0);
  console.log(JSON.stringify({ ...report, viewer, ...provenance }, null, 2));
  passed = true;
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM'); await once(child, 'exit');
  }
  if (passed) await removeFixture(root);
  else console.error('Failed isolated theme fixture retained:', root);
}
