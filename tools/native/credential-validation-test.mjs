// Guard checks always run. Real OS vault access uses a fresh synthetic validation identity only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, readFile, writeFile, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { nativeTestBinary } from './test-support.mjs';
const parent = await mkdtemp(join(await realpath(tmpdir()), 'xwxdeck-validation-vault-'));
const root = join(parent, 'data'), checks = [];
const real = process.argv.includes('--real') || process.env.XWX_DECK_TEST_OS_CREDENTIAL_STORE === '1';
const service = 'app.xwxdeck.validation.credentials';
function deleteSyntheticKey(id) {
  assert.match(id, /^[a-f0-9]{32}$/);
  return process.platform === 'win32'
    ? spawnSync('cmdkey.exe', ['/delete:' + service + '/' + id], {encoding:'utf8', windowsHide:true})
    : spawnSync('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', id], {encoding:'utf8'});
}
const env = { ...process.env }; delete env.XWX_DECK_TEST_SECURE_STORE;
const invoke = (args, requests = [], overrides = {}) => spawnSync(nativeTestBinary, args, { input: requests.map(value => JSON.stringify(value)).join('\n') + '\n', encoding: 'utf8', timeout: 30000, env: { ...env, ...overrides } });
const rpcArgs = ['--rpc', '--pilot-root', root, '--pilot-os-credentials'];
const request = (method, ...args) => ({ method, args });
const decode = result => { assert.equal(result.status, 0, result.stderr || 'native process failed'); return result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); };
const pass = name => { checks.push(name); console.log('PASS ' + name); };
let id, cleaned = false, report = { passed: false, realOSCredentialStore: false, syntheticOnly: true, existingAccountsAccessed: false, checks };
try {
  const absent = invoke(['--rpc', '--pilot-os-credentials']); assert.equal(absent.status, 2); assert.match(absent.stderr, /隔离目录/);
  const mixed = invoke(rpcArgs, [request('getState')], { XWX_DECK_TEST_SECURE_STORE: '1' }); assert.equal(mixed.status, 2); assert.match(mixed.stderr, /模拟密钥/);
  await assert.rejects(stat(join(root, 'native-credential-vault.json')));
  pass('OS validation requires an explicit isolated root and refuses mock-key combinations before any vault entry is created');
  if (!real || !['darwin', 'win32'].includes(process.platform)) {
    report = { ...report, passed: true, realOSCredentialStoreSkipped: true };
    console.log('SKIP validation OS-vault roundtrip: macOS or Windows with explicit --real or XWX_DECK_TEST_OS_CREDENTIAL_STORE=1 required');
  } else {
    const secret = 'SYNTHETIC-OS-VALIDATION-' + createHash('sha256').update(parent).digest('hex');
    const first = decode(invoke(rpcArgs, [request('saveProvider', { displayName: 'Fixture_d80e623b', providerPreset: 'custom', baseUrl: 'http://127.0.0.1:12345/v1', adapter: 'responses', bearerToken: secret, codexModel: 'explicit-model' })]));
    assert.equal(first[0].ok, true);
    const metadataBytes = await readFile(join(root, 'native-credential-vault.json'));
    const metadata = JSON.parse(metadataBytes); id = metadata.id;
    assert.match(id, /^[a-f0-9]{32}$/); assert.equal(metadata.mode, 'isolated-platform'); assert.equal(metadata.service, service);
    await assert.rejects(stat(join(root, 'native-test-vault-key.bin')));
    let settings = await readFile(join(root, 'settings.json'));
    assert.ok(!settings.includes(Buffer.from(secret))); assert.equal(JSON.parse(settings).nativeEncryptedDocument, 1);
    if (process.platform !== 'win32') assert.equal((await stat(join(root, 'settings.json'))).mode & 0o777, 0o600);
    pass('a unique OS validation namespace seals provider credentials on disk with no file-based master key');
    const restarted = decode(invoke(rpcArgs, [request('getProviders')]));
    assert.equal(restarted[0].ok, true); assert.ok(restarted[0].result.connections.some(value => value.bearerToken === secret && value.codexModel === 'explicit-model'));
    settings = await readFile(join(root, 'settings.json'));
    for (const [args, override] of [ [rpcArgs.filter(arg => arg !== '--pilot-os-credentials'), {}], [rpcArgs, { XWX_DECK_TEST_SECURE_STORE: '1' }] ]) {
      const refused = invoke(args, [request('getProviders')], override); assert.equal(refused.status, 2); assert.equal(refused.stdout, ''); assert.ok((await readFile(join(root, 'settings.json'))).equals(settings));
    }
    pass('new-process reads retain credentials and model choices; omitted mode and mock-key downgrade leave the encrypted document unchanged');
    await writeFile(join(root, 'native-credential-vault.json'), JSON.stringify({ ...metadata, mode: 'platform', service: 'app.xwxdeck.desktop.credentials' }));
    const namespace = invoke(rpcArgs, [request('getProviders')]); assert.equal(namespace.status, 2); assert.match(namespace.stderr, /拒绝降级/);
    await writeFile(join(root, 'native-credential-vault.json'), metadataBytes);
    pass('a production-vault record cannot be reused as a validation vault');
    const exported = join(parent, 'exported');
    const result = invoke(['--export-credential-backup', root, '--export-destination', exported, '--export-isolated-test', '--pilot-os-credentials']);
    assert.equal(result.status, 0, result.stderr); assert.ok(!result.stdout.includes(secret));
    assert.ok(JSON.parse(await readFile(join(exported, 'settings.json'))).connections.some(value => value.bearerToken === secret));
    pass('explicit exited-app backup export uses the same validation namespace and keeps secrets out of diagnostic output');
    const deletion = deleteSyntheticKey(id); assert.equal(deletion.status, 0, 'synthetic validation key cleanup failed'); cleaned = true;
    if (process.platform === 'darwin') { const missing = spawnSync('/usr/bin/security', ['find-generic-password', '-s', service, '-a', id], { encoding: 'utf8' }); assert.notEqual(missing.status, 0); }
    const failed = invoke(rpcArgs, [request('getProviders')]); assert.equal(failed.status, 2); assert.match(failed.stderr, /钥匙串|凭据管理器|安全存储/); assert.ok((await readFile(join(root, 'settings.json'))).equals(settings));
    pass('deleting this synthetic key is verified, and a missing OS key fails closed without replacing it or overwriting encrypted data');
    report = { ...report, passed: true, realOSCredentialStore: true, keyDeleted: true, namespace: service };
  }
} finally {
  if (id && !cleaned) {
    const result = deleteSyntheticKey(id);
    cleaned = result.status === 0;
  }
  report.syntheticValidationKeyCleaned = !id || cleaned;
  report.binarySha256 = createHash('sha256').update(await readFile(nativeTestBinary)).digest('hex');
  await mkdir('test-results', { recursive: true });
  await writeFile(`test-results/native-validation-vault-${real ? 'os' : 'guards'}-summary.json`, JSON.stringify(report, null, 2) + '\n');
  if (!id || cleaned) await rm(parent, { recursive: true, force: true });
  else console.error('Synthetic validation cleanup needs retry; isolated recovery directory retained: ' + parent);
}
