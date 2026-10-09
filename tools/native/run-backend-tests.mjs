import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Every suite gets its own process, configuration root and local test service.
// Keep checking after a failure so a platform run reports all blocking issues.
const suites = [
  "regressions.mjs",
  "provider-presets-test.mjs",
  "config-import-test.mjs",
  "subscriptions-test.mjs",
  "subscription-routing-test.mjs",
  "subscription-usage-test.mjs",
  "grok-subscriptions-test.mjs",
  "copilot-subscriptions-test.mjs",
  "claude-subscriptions-test.mjs",
  "cursor-subscriptions-test.mjs",
  "official-test.mjs",
  "protocol-test.mjs",
  "trace-index-repair-test.mjs",
  "portability-test.mjs",
  "preferences-test.mjs",
  "update-test.mjs",
  "migration-test.mjs",
  "reasoning-test.mjs",
  "client-management-test.mjs",
  "language-test.mjs",
  "portable-update-test.mjs"
];
const results = [];
for (const suite of suites) {
  console.log(`\nNative suite: ${suite}`);
  const started = Date.now();
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, suite)], { stdio: 'inherit', timeout: 180_000 });
  results.push({ suite, code: result.status, signal: result.signal, error: result.error?.message,
    skipped: suite === 'portable-update-test.mjs' && process.platform !== 'win32', elapsedMs: Date.now() - started });
}
const failed = results.filter(result => result.code !== 0 || result.error);
await mkdir('test-results', { recursive: true });
await writeFile('test-results/native-backend-summary.json', JSON.stringify({ platform: process.platform, passed: failed.length === 0, results }, null, 2) + '\n');
console.log(`Native backend: ${results.length - failed.length}/${results.length} suites returned successfully; ${results.filter(result => result.skipped).length} platform-specific skips`);
if (failed.length) { console.error('Failed suites:', failed.map(result => result.suite).join(', ')); process.exitCode = 1; }
