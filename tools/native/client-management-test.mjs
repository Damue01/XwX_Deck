import { nativeTestBinary } from './test-support.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-client-management-'));
const home = join(root, 'installations');
const binary = nativeTestBinary;
let child;
let pending = [];
function start() {
  child = spawn(binary, ['--rpc', '--pilot-root', root], { env: { ...process.env, XWX_CLIENT_INSTALLATIONS_TEST_HOME: home } });
  createInterface({ input: child.stdout }).on('line', line => pending.shift()?.(JSON.parse(line)));
  child.stderr.on('data', data => process.stderr.write(data));
}
async function call(method, ...args) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`Timed out: ${method}`)), 15000);
    pending.push(result => { clearTimeout(timer); resolve(result); });
    child.stdin.write(JSON.stringify({ method, args }) + '\n');
  });
}
async function rpc(method, ...args) { const result = await call(method, ...args); assert.equal(result.ok, true, result.error); return result.result; }
async function stop() { const exit = once(child, 'exit'); child.stdin.end(); assert.equal((await exit)[0], 0); }
async function file(relative, runnable = false) {
  const path = join(home, relative);
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, 'local discovery fixture');
  if (runnable) await chmod(path, 0o755);
}
start();
try {
  await rpc('getState');
  await mkdir(join(root, 'codex'), { recursive: true });
  await mkdir(join(root, 'claude'), { recursive: true });
  const codexConfig = 'model = "preserved-client-model"\n';
  const claudeConfig = '{"env":{"ANTHROPIC_MODEL":"preserved-client-model"}}';
  await writeFile(join(root, 'codex/config.toml'), codexConfig);
  await writeFile(join(root, 'claude/settings.json'), claudeConfig);
  const providers = await rpc('getProviders');
  assert.deepEqual(await rpc('getModelClients'), []);
  const snapshot = await rpc('detectClientInstallations');
  assert.equal(snapshot.available, true);
  assert.ok(snapshot.clients.every(client => client.installed === false));
  assert.equal((await call('addModelClient', 'cursor')).ok, false);
  assert.deepEqual(await rpc('getModelClients'), []);
  console.log('PASS missing installations cannot create tabs');

  await file(process.platform === 'win32' ? '.local/bin/claude.cmd' : '.local/bin/claude', true);
  await file(process.platform === 'win32' ? '.local/bin/codex.cmd' : '.local/bin/codex', true);
  await file(process.platform === 'win32' ? 'Applications/Cursor/resources/app/package.json' : 'Applications/Cursor.app/Contents/Info.plist');
  assert.equal((await call('addModelClient', 'cursor')).ok, false);
  await file(process.platform === 'win32' ? 'Applications/Cursor/Cursor.exe' : 'Applications/Cursor.app/Contents/MacOS/Cursor', true);
  assert.equal((await rpc('detectClientInstallations')).clients.find(client => client.id === 'cursor').installed, true);
  assert.deepEqual(await rpc('getModelClients'), []);
  assert.deepEqual(await rpc('addModelClient', 'claude-code'), ['claude']);
  assert.deepEqual(await rpc('addModelClient', 'codex-cli'), ['claude', 'codex']);
  assert.deepEqual(await rpc('addModelClient', 'cursor'), ['claude', 'codex', 'cursor']);
  assert.deepEqual(await rpc('addModelClient', 'cursor'), ['claude', 'codex', 'cursor']);
  console.log('PASS recheck discovers existing apps and addition is idempotent');

  await file(process.platform === 'win32' ? '.local/bin/codex.cmd' : '.local/bin/codex', true);
  await rpc('removeModelClient', 'codex');
  assert.deepEqual(await rpc('addModelClient', 'codex-cli'), ['claude', 'cursor', 'codex']);
  assert.deepEqual(await rpc('removeModelClient', 'codex-cli'), ['claude', 'cursor']);
  assert.deepEqual(await rpc('getProviders'), providers);
  assert.equal(await readFile(join(root, 'codex/config.toml'), 'utf8'), codexConfig);
  assert.equal(await readFile(join(root, 'claude/settings.json'), 'utf8'), claudeConfig);
  await stop(); start();
  assert.deepEqual(await rpc('getModelClients'), ['claude', 'cursor']);
  assert.deepEqual(await rpc('removeModelClient', 'claude'), ['cursor']);
  assert.deepEqual(await rpc('removeModelClient', 'cursor'), []);
  await stop(); start();
  assert.deepEqual(await rpc('getModelClients'), []);
  console.log('PASS removal preserves sources, merges CLI aliases and persists an empty tab list');

  await stop();
  const settingsPath = join(root, 'settings.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  delete settings.modelClientsVersion;
  settings.modelClients = ['codex-cli', 'claude-code', 'cursor'];
  await writeFile(settingsPath, JSON.stringify(settings));
  start();
  assert.deepEqual(await rpc('getModelClients'), ['codex', 'claude', 'cursor']);
  await stop();
  console.log('PASS saved selections retain order and canonicalize CLI aliases without implicit enrollment');
  start();
  for (const id of ['codex', 'claude', 'cursor']) await rpc('removeModelClient', id);
  const source = join(root, 'enrollment-source.json');
  await writeFile(source, JSON.stringify({ providers: [{ name: 'Enrollment fixture', responses: 'https://example.test/v1', key: 'isolated-import-key' }] }));
  const sources = [{ source: 'magpie', path: source }];
  const preview = await rpc('previewConfigurationImport', { sources });
  const input = { sources, targetDigest: preview.targetDigest, fingerprints: [preview.sources[0].items[0].fingerprint], clients: ['codex-cli', 'codex', 'claude-code'] };
  const before = await readFile(settingsPath, 'utf8');
  assert.equal((await call('importConfigurations', { ...input, clients: ['codex', 'missing-client'] })).ok, false);
  assert.equal((await call('importConfigurations', { ...input, clients: ['codex', 'qwen-code'] })).ok, false);
  assert.equal(await readFile(settingsPath, 'utf8'), before);
  assert.deepEqual(await rpc('getModelClients'), []);
  assert.deepEqual(await rpc('getProviders'), providers);
  console.log('PASS unknown or no-longer-installed enrollment prevents all import and registry writes');
  await writeFile(settingsPath, before + '\n');
  assert.equal((await call('importConfigurations', input)).ok, false);
  assert.equal(await readFile(settingsPath, 'utf8'), before + '\n');
  assert.deepEqual(await rpc('getModelClients'), []);
  console.log('PASS external settings drift blocks enrollment and preserves the external file');
  await stop(); start();
  const refreshed = await rpc('previewConfigurationImport', { sources });
  const imported = await rpc('importConfigurations', { ...input, targetDigest: refreshed.targetDigest });
  assert.deepEqual(imported.addedClients, ['codex', 'claude']);
  assert.deepEqual(imported.modelClients, ['codex', 'claude']);
  assert.equal(imported.added.length, 1);
  assert.deepEqual(imported.providers.selected, providers.selected);
  assert.equal((await rpc('getState')).tracingEnabled, false);
  assert.equal(await readFile(join(root, 'codex/config.toml'), 'utf8'), codexConfig);
  assert.equal(await readFile(join(root, 'claude/settings.json'), 'utf8'), claudeConfig);
  console.log('PASS import and selected CLI/Desktop families save together without enabling Trace or editing client configuration');
  await rpc('removeModelClient', 'codex');
  const clientOnlyPreview = await rpc('previewConfigurationImport', { sources: [] });
  const clientOnly = await rpc('importConfigurations', { sources: [], targetDigest: clientOnlyPreview.targetDigest, fingerprints: [], clients: ['codex-cli', 'claude'] });
  assert.deepEqual(clientOnly.added, []);
  assert.deepEqual(clientOnly.addedClients, ['codex']);
  assert.deepEqual(clientOnly.modelClients, ['claude', 'codex']);
  await stop(); start();
  assert.deepEqual(await rpc('getModelClients'), ['claude', 'codex']);
  assert.equal((await rpc('getProviders')).connections.length, providers.connections.length + 1);
  await stop();
  console.log('PASS client-only confirmation preserves existing management and survives restart');
  console.log(JSON.stringify({ passed: true, root }));
} finally { if (child?.exitCode === null) child.kill('SIGTERM'); }
