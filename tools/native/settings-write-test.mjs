import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNativeRpc } from './rpc-test-session.mjs';

const fixture = await mkdtemp(join(await realpath(tmpdir()), 'xwxdeck-settings-write-'));
const root = join(fixture, 'data'), path = join(root, 'settings.json');
let app;
const initial = { nativeMigrationVersion: 1, theme: 'day', connections: [], selected: { codex: null, claude: null }, traceWarningGB: 1, traceAutoCleanup: true, externalPreference: 'keep' };
try {
  await mkdir(root);
  app = startNativeRpc(root); await app.rpc('getState'); await app.stop();
  await writeFile(path, JSON.stringify(initial));
  app = startNativeRpc(root); await app.rpc('getState');
  await app.rpc('setTheme', 'night'); await app.rpc('setLanguage', 'zh-CN');
  assert.equal((await app.rpc('getState')).theme, 'night');
  const ownBytes = await readFile(path);
  const external = JSON.stringify({ ...initial, traceWarningGB: 7, traceAutoCleanup: false, externalPreference: 'newer' });
  await writeFile(path, external);
  const client = join(root, 'codex/config.toml');
  await writeFile(client, '# external client sentinel\nmodel = "keep"\n');
  for (const [method, args] of [
    ['setTheme', ['day']], ['setLanguage', ['en']],
    ['setTraceStoragePolicy', [{ limitGB: 2, autoCleanup: true }]],
    ['saveProvider', [{ displayName: 'Fixture_caa68dbd', baseUrl: 'http://127.0.0.1:9/v1', bearerToken: 'synthetic-only', adapter: 'responses' }]],
    ['updateCodexConfig', [{ officialModel: 'different-model' }]],
  ]) {
    await assert.rejects(app.rpc(method, ...args), /外部修改/);
    assert.equal(await readFile(path, 'utf8'), external, `${method} keeps the external document`);
    assert.equal(await readFile(client, 'utf8'), '# external client sentinel\nmodel = "keep"\n');
    assert.equal((await app.rpc('getState')).theme, 'night', 'failed preflight does not publish a false committed state');
  }
  await assert.rejects(app.rpc('setTheme', 'day'), /外部修改/, 'repeated retry cannot overwrite the conflict');
  await writeFile(path, ownBytes);
  await app.rpc('setTheme', 'day');
  await writeFile(path, external);
  await app.stop(); app = startNativeRpc(root);
  assert.equal((await app.rpc('getState')).traceWarningGB, 7);
  await app.rpc('setTheme', 'night'); await app.stop();
  app = startNativeRpc(root);
  assert.equal((await app.rpc('getState')).traceWarningGB, 7);
  assert.equal((await app.rpc('getState')).traceAutoCleanup, false);
  assert.equal((await app.rpc('getState')).theme, 'night');
  await app.rpc('saveProvider', { id: 'stop-conflict', displayName: 'Fixture_a5a6e1e9', baseUrl: 'http://127.0.0.1:9/v1', bearerToken: 'synthetic-only', adapter: 'responses', codexModel: 'synthetic-model' });
  await app.rpc('switchClientProvider', { client: 'codex', providerId: 'stop-conflict' });
  const direct = await readFile(client, 'utf8');
  const running = await app.rpc('toggleTracing', true);
  const activeBytes = await readFile(path);
  await writeFile(path, external);
  await assert.rejects(app.rpc('toggleTracing', false), /外部修改/);
  assert.equal((await app.rpc('getState')).tracingEnabled, false, 'settings conflicts cannot prevent a safety stop');
  assert.equal(await readFile(client, 'utf8'), direct, 'stop restores the direct configuration before reporting the settings conflict');
  assert.equal(await readFile(path, 'utf8'), external);
  await assert.rejects(fetch(running.localBaseUrl + '/v1/responses'), /fetch failed/);
  await writeFile(path, activeBytes);
  await app.rpc('toggleTracing', true); await app.rpc('toggleTracing', false);
  assert.equal((await app.rpc('getState')).tracingEnabled, false, 'a conflict does not leave the toggle locked');
  await app.rpc('setTraceStoragePolicy', { limitGB: 2048, autoCleanup: false });
  await app.stop(); app = startNativeRpc(root);
  assert.equal((await app.rpc('getState')).traceWarningGB, 2048, 'an explicit capacity above 1 TB survives save and restart');
  assert.equal((await app.rpc('getState')).traceAutoCleanup, false);
  await app.stop();
  // Explicit repair uses the current broken document, backs it up, and does not
  // turn an ordinary conflict into a destructive repair.
  await writeFile(path, '{broken-synthetic'); app = startNativeRpc(root);
  await assert.rejects(app.rpc('setTheme', 'night'), /设置文件损坏/);
  const repair = await app.rpc('repairUnreadableSettings');
  assert.ok(repair.backupPath);
  await app.rpc('setTheme', 'night');
  assert.equal((await app.rpc('getState')).theme, 'night');
  console.log('PASS settings conflicts preserve external bytes, client files and committed state; retry, restart, safe Trace stop, unlocked restart and explicit backed-up repair');
} finally { await app?.stop(); await rm(fixture, { recursive: true, force: true }); }
