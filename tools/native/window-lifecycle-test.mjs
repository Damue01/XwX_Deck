import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { verifyCandidate } from './source-fingerprint.mjs';

const binary = resolve(process.env.XWX_NATIVE_TEST_BINARY ?? 'test-results/rust-pilot-package/XwXDeck Rust Validation.app/Contents/MacOS/xwx-deck-native');
const build = JSON.parse(await readFile(resolve(process.env.XWX_NATIVE_TEST_BUILD_REPORT ?? 'test-results/rust-pilot-package/native-build-report.json'), 'utf8'));
const provenance = await verifyCandidate({ root: resolve('.'), report: build, binary, allowManualAcceptance: Boolean(process.env.XWX_NATIVE_TEST_BINARY && process.env.XWX_NATIVE_TEST_BUILD_REPORT) });
const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-window-lifecycle-'));
let child;
try {
  // An isolated, uncontacted loopback provider permits Trace lifecycle checks.
  for (const [method, args] of [
    ['saveProvider', [{ displayName: 'Window_Fixture', baseUrl: 'http://127.0.0.1:9/v1', bearerToken: 'isolated-window-key', adapter: 'responses', codexModel: 'window-model' }]],
    ['switchClientProvider', [{ client: 'codex', providerId: 'Window_Fixture' }]]
  ]) {
    const result = spawnSync(binary, ['--rpc', '--pilot-root', root], { input: JSON.stringify({ method, args }) + '\n', encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const reply = JSON.parse(result.stdout.trim());
    assert.ok(reply.ok, JSON.stringify(reply));
  }
  child = spawn(binary, ['--pilot-root', root, '--smoke', '--smoke-window-lifecycle', '--smoke-exit'], {
    env: { ...process.env, XWX_SYSTEM_LANGUAGE_TEST: 'zh-CN', XWX_CLIENT_INSTALLATIONS_TEST_HOME: join(root, 'installations') },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  let report;
  for (let i = 0; i < 900; i++) {
    report = await readFile(join(root, 'native-smoke.json'), 'utf8').then(JSON.parse, () => undefined);
    if (report) break;
    if (child.exitCode !== null || child.signalCode !== null) throw Error('Native host exited before reporting');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(report, 'Native window lifecycle test timed out');
  const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  const result = { ...report, ...provenance, binarySha256 };
  if (process.env.XWX_WINDOW_TEST_REPORT) await writeFile(process.env.XWX_WINDOW_TEST_REPORT, JSON.stringify(result, null, 2) + '\n');
  assert.equal(report.passed, true, JSON.stringify(report));
  if (child.exitCode === null) {
    const ended = once(child, 'exit');
    const timeout = setTimeout(() => child.kill('SIGTERM'), 10_000);
    const [code] = await ended;
    clearTimeout(timeout);
    assert.equal(code, 0, 'Native host must exit cleanly after stopping Trace');
  }
  const restarted = spawnSync(binary, ['--rpc', '--pilot-root', root], { input: JSON.stringify({ method: 'getModelClients', args: [] }) + '\n', encoding: 'utf8' });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(JSON.parse(restarted.stdout.trim()).result, ['codex']);
  result.checks.push('removed Claude remains absent after native process restart');
  if (process.env.XWX_WINDOW_TEST_REPORT) await writeFile(process.env.XWX_WINDOW_TEST_REPORT, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  await rm(root, { recursive: true, force: true });
}
