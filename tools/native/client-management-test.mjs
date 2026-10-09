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
  assert.deepEqual(await rpc('getModelClients'), ['claude', 'codex']);
  const snapshot = await rpc('detectClientInstallations');
  assert.equal(snapshot.available, true);
  assert.ok(snapshot.clients.every(client => client.installed === false));
  assert.equal((await call('addModelClient', 'cursor')).ok, false);
  assert.deepEqual(await rpc('getModelClients'), ['claude', 'codex']);
  console.log('PASS missing installations cannot create tabs');

  await file('Applications/Cursor.app/Contents/Info.plist');
  assert.equal((await call('addModelClient', 'cursor')).ok, false);
  await file('Applications/Cursor.app/Contents/MacOS/Cursor', true);
  assert.equal((await rpc('detectClientInstallations')).clients.find(client => client.id === 'cursor').installed, true);
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
  assert.deepEqual(await rpc('getModelClients'), ['claude', 'codex', 'cursor']);
  await stop();
  console.log('PASS legacy selections migrate without silently removing saved clients');
  console.log(JSON.stringify({ passed: true, root }));
} finally { if (child?.exitCode === null) child.kill('SIGTERM'); }
