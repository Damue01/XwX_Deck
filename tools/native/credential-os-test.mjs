// Explicit opt-in for a synthetic random OS credential, never a user's vault.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { nativeTestBinary } from './test-support.mjs';
const invoke = (...args) => spawnSync(nativeTestBinary, ['--credential-store-diagnostic', ...args], { encoding: 'utf8', timeout: 20000 });
const checks = [];
const realRequested = process.argv.includes('--real') || process.env.XWX_DECK_TEST_OS_CREDENTIAL_STORE === '1';
let report = { passed: false, realOSCredentialStore: false, existingAccountsAccessed: false, syntheticOnly: true, checks };
let probeId;
try {
  for (const args of [ ['probe', '--probe-id', 'existing-vault-fixture', '--probe-challenge', '0'.repeat(64)], ['cleanup', '--probe-id', 'existing-vault-fixture'] ]) {
    const invalid = invoke(...args); assert.equal(invalid.status, 2); assert.ok(!invalid.stdout);
    assert.match(invalid.stderr, /只允许|当前平台真实凭据存储自检尚未验证/);
    checks.push('ordinary vault identity rejected before credential access');
  }
  if (!realRequested) {
    console.log('SKIP real OS storage: explicit XWX_DECK_TEST_OS_CREDENTIAL_STORE=1 is required; argument guards passed');
    report = { ...report, passed: true, realOSCredentialStoreSkipped: true };
  } else {
    assert.equal(process.platform, 'darwin', 'real Windows credential diagnostic remains unverified');
    const result = invoke('self-test');
    const lines = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    probeId = lines.find(line => line.event === 'credential-probe')?.probeId;
    assert.match(probeId, /^self-test-[a-f0-9]{32}$/);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const verification = lines.at(-1);
    assert.equal(verification.passed, true); assert.equal(verification.existingAccountsAccessed, false);
    for (const field of ['write', 'crossProcessRead', 'delete', 'missingAfterDelete']) assert.equal(verification[field], true);
    const cleaned = invoke('cleanup', '--probe-id', probeId); assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(JSON.parse(cleaned.stdout).missingAfterDelete, true);
    checks.push('actual macOS Keychain write, new-process read proof, delete and missing-after-delete');
    report = { ...report, passed: true, realOSCredentialStore: true, verification };
    console.log('PASS actual macOS Keychain with a unique synthetic entry; existing accounts not accessed');
  }
} catch (error) { report.error = error.message; throw error; }
finally {
  if (probeId) { const cleanup = invoke('cleanup', '--probe-id', probeId); report.probeCleaned = cleanup.status === 0; }
  await mkdir('test-results', { recursive: true });
  report.binarySha256 = createHash('sha256').update(await readFile(nativeTestBinary)).digest('hex');
  await writeFile(`test-results/native-os-credential-${realRequested ? 'summary' : 'guards-summary'}.json`, JSON.stringify(report, null, 2) + '\n');
}
