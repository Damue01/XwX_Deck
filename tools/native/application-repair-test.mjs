import { clearFreshCompatibleFixture } from './test-support.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, mkdir, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { nativeTestBinary } from './test-support.mjs';

const fixture = await mkdtemp(join(await realpath(tmpdir()), 'xwxdeck-application-repair-'));
const checks = [], children = new Set();
const model = 'qwen-native-repair-fixture', payload = Buffer.from('SYNTHETIC UPDATE FIXTURE');
let failMetadata = false, holdCatalog, catalogStarted, holdMetadata, metadataStarted, holdDownload, releaseDownload;
let base, metadataRequests = 0, catalogRequests = 0, compatibleMode = false;
const upstreamRequests = [];
const server = createServer(async (req, res) => {
  if (req.url === '/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\n\n'); return; }
  if (req.url === '/models-dev' || req.url === '/litellm') {
    metadataRequests++;
    if (req.url === '/models-dev' && holdMetadata) { metadataStarted?.(); await holdMetadata; }
    if (failMetadata) { res.writeHead(503); res.end('{}'); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/models-dev' ? { alibaba: { models: { [model]: { limit: { context: 333000, output: 8192 }, modalities: { input: ['text', 'image'] }, tool_call: true, reasoning: false, cost: { input: 2, output: 3 } } } } } : { [model]: { mode: 'responses', supports_vision: true, supports_function_calling: true } })); return;
  }
  if (req.url.endsWith('/models')) {
    catalogRequests++;
    if (holdCatalog) { const held = holdCatalog; holdCatalog = null; catalogStarted?.(); await held; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(compatibleMode
      ? { data: [{ id: 'anthropic-only-repair', supported_endpoint_types: ['anthropic-messages'] }] }
      : { data: [{ id: model }] })); return;
  }
  if (req.url === '/release.json') {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ schemaVersion: 1, channel: 'release', releaseSeries: 'native-v1', version: '99.0.0', tag: 'v99.0.0', publishedAt: '2026-10-10T00:00:00Z', files: [{ platform: process.platform === 'darwin' ? 'darwin' : 'windows', arch: process.arch, name: 'XwX-Deck-fixture' + (process.platform === 'darwin' ? '.dmg' : '.exe'), url: base + '/installer', size: payload.length, sha256: createHash('sha256').update(payload).digest('hex') }] })); return;
  }
  if (req.url === '/installer') {
    res.writeHead(200, { 'content-length': payload.length });
    if (holdDownload) { res.write(payload.subarray(0, 1)); await holdDownload; res.end(payload.subarray(1)); }
    else res.end(payload); return;
  }
  let input = ''; for await (const part of req) input += part;
  const body = JSON.parse(input);
  upstreamRequests.push({ path: req.url, model: body.model });
  if (req.url === '/v1/messages') {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'repair-message', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'route retained' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 3 } })); return;
  }
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'repair-response', status: 'completed', model: body.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'repaired' }] }], usage: { input_tokens: 8, output_tokens: 4, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;

function start(root, metadata = false) {
  const child = spawn(nativeTestBinary, ['--rpc', '--pilot-root', root, ...(metadata ? ['--metadata-test-endpoint', base] : [])], { env: { ...process.env, XWX_DECK_TEST_SECURE_STORE: '1', XWX_DECK_UPDATE_SERVER_URL: base }, stdio: ['pipe', 'pipe', 'inherit'] });
  children.add(child); const pending = new Map(); let seq = 0;
  createInterface({ input: child.stdout }).on('line', line => { const response = JSON.parse(line), item = pending.get(response.requestId); if (item) { clearTimeout(item.timer); pending.delete(response.requestId); response.ok ? item.resolve(response.result) : item.reject(Error(response.error)); } });
  const rpc = (method, ...args) => new Promise((resolve, reject) => { const requestId = ++seq, timer = setTimeout(() => { pending.delete(requestId); reject(Error(method + ' timed out')); }, 25000); pending.set(requestId, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ requestId, method, args }) + '\n'); });
  const stop = async () => { const exited = once(child, 'exit'); child.stdin.end(); assert.equal((await exited)[0], 0); children.delete(child); for (const item of pending.values()) clearTimeout(item.timer); };
  return { rpc, stop };
}
async function wait(test, label) { for (let n = 0; n < 200; n++) { if (await test()) return; await new Promise(r => setTimeout(r, 20)); } throw Error(label); }
const pass = name => { checks.push(name); console.log('PASS ' + name); };
try {
  const root = join(fixture, 'offline'); let app = start(root); await app.rpc('getState'); await app.stop();
  const settings = { nativeMigrationVersion: 1, connections: [{ id: 'repair-provider', displayName: '同名保留', baseUrl: base, bearerToken: 'synthetic-repair-key', adapter: 'responses', codexApiFormat: 'responses', codexModel: 'manual-unlisted-model' }], selected: { codex: 'repair-provider', claude: null }, traceWarningGB: 2.25, traceAutoCleanup: false, maxSessions: 3, maxStorageMB: 16, unknownSetting: { keep: true } };
  await writeFile(join(root, 'settings.json'), JSON.stringify(settings)); app = start(root); await app.rpc('getState');
  const survivors = ['codex/sessions/opaque.jsonl', 'traces/history-evidence.jsonl', 'user-note.json', 'custom-file.json'];
  for (const file of survivors) { await mkdir(join(root, file, '..'), { recursive: true }); await writeFile(join(root, file), 'SYNTHETIC PRIVATE TEST RECORD\n'); }
  const caches = ['pricing-cache/old.json', 'model-capabilities-cache.json', 'provider-other-models.json', 'provider-obsolete-models.json', 'updates/old.part'];
  for (const file of caches) { await mkdir(join(root, file, '..'), { recursive: true }); await writeFile(join(root, file), 'old-cache'); }
  await writeFile(join(root, 'codex/config.toml'), '# original client comment\nmodel = "manual-unlisted-model"\n');
  const direct = await readFile(join(root, 'codex/config.toml'));
  const repair = await app.rpc('repairApplication'); assert.equal(repair.removedCachePaths, 5); assert.equal(repair.removedBytes, 5 * Buffer.byteLength('old-cache')); assert.equal(repair.metadataRefresh.status, 'skipped'); assert.equal(repair.traceRetention.legacyLimitsFound, true); assert.equal(repair.traceRetention.persistedSettingsChanged, true);
  for (const file of caches) await assert.rejects(stat(join(root, file)), { code: 'ENOENT' });
  for (const file of survivors) assert.equal(await readFile(join(root, file), 'utf8'), 'SYNTHETIC PRIVATE TEST RECORD\n');
  assert.deepEqual(await readFile(join(root, 'codex/config.toml')), direct); let state = await app.rpc('getState'); assert.equal(state.traceWarningGB, 2.25); assert.equal(state.traceAutoCleanup, false); assert.equal((await app.rpc('getProviders')).connections[0].codexModel, 'manual-unlisted-model');
  assert.equal(JSON.parse(await readFile(repair.settingsBackupPath)).nativeEncryptedDocument, 1); pass('offline repair measures and removes only rebuildable caches, seals prior settings and retains explicit models, storage policy, client configuration and opaque history');
  const repeated = await app.rpc('repairApplication'); assert.equal(repeated.removedCachePaths, 0); assert.equal(repeated.traceRetention.persistedSettingsChanged, false); assert.equal(repeated.settingsBackupPath, null); await app.stop();
  const exported = join(fixture, 'export'); const result = spawnSync(nativeTestBinary, ['--export-credential-backup', root, '--export-destination', exported, '--export-isolated-test'], { env: { ...process.env, XWX_DECK_TEST_SECURE_STORE: '1' }, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); const current = JSON.parse(await readFile(join(exported, 'settings.json'))); assert.equal(current.maxSessions, 0); assert.equal(current.maxStorageMB, 0); assert.deepEqual(current.unknownSetting, { keep: true }); const backup = JSON.parse(await readFile(join(exported, basename(repair.settingsBackupPath)))); assert.equal(backup.maxSessions, 3); assert.equal(backup.maxStorageMB, 16); pass('repeated repair is idempotent and encrypted backup exports the original retired limits without changing explicit cleanup policy');
  app = start(root); await app.rpc('getState'); const encrypted = await readFile(join(root, 'settings.json')); await writeFile(join(root, 'settings.json'), JSON.stringify({ ...current, external: true })); await writeFile(join(root, 'provider-keep-models.json'), 'keep'); await assert.rejects(app.rpc('repairApplication'), /外部修改/); assert.equal(await readFile(join(root, 'provider-keep-models.json'), 'utf8'), 'keep'); await writeFile(join(root, 'settings.json'), encrypted); pass('external settings drift rejects repair before cache deletion and preserves the newer document');
  if (process.platform !== 'win32') { const outside = join(fixture, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'external'); await symlink(outside, join(root, 'pricing-cache')); await assert.rejects(app.rpc('repairApplication'), /链接/); assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'external'); assert.equal(await readFile(join(root, 'provider-keep-models.json'), 'utf8'), 'keep'); await rm(join(root, 'pricing-cache')); pass('linked cache targets refuse the whole preflight without following or removing outside files'); }
  await app.stop();

  const networkRoot = join(fixture, 'network'); app = start(networkRoot, true); await app.rpc('getState'); await clearFreshCompatibleFixture(app.rpc); await app.rpc('saveProvider', { displayName: 'Repair_Retained', baseUrl: base, bearerToken: 'synthetic-repair-key', adapter: 'responses', codexModel: model }); const provider = (await app.rpc('getProviders')).connections[0]; await app.rpc('switchClientProvider', { client: 'codex', providerId: provider.id });
  const online = await app.rpc('repairApplication'); assert.equal(online.metadataRefresh.status, 'ready', JSON.stringify(online.metadataRefresh)); let generated = JSON.parse(await readFile(join(networkRoot, 'codex/xwx-deck-model-catalog.json'))).models.find(row => row.slug === model); assert.deepEqual(generated.input_modalities, ['text', 'image']); assert.equal(generated.context_window, 333000); const running = await app.rpc('toggleTracing', true); const response = await fetch(running.localBaseUrl + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, input: 'synthetic repair request' }) }); assert.equal(response.status, 200); await response.json(); assert.ok(JSON.stringify(await app.rpc('getTraceStats')).includes('0.000028')); const activeRepair = await app.rpc('repairApplication'); assert.equal(activeRepair.traceRetention.helper.state, 'verified'); assert.equal((await app.rpc('getState')).localBaseUrl, running.localBaseUrl); await app.rpc('toggleTracing', false); pass('online repair refreshes source-tagged abilities, final client catalog and in-memory prices; active repair keeps Gateway and history');
  let release; holdCatalog = new Promise(r => release = r); const catalogWait = new Promise(r => catalogStarted = r); const delayed = app.rpc('fetchProviderModels', { providerId: provider.id, refresh: true }).then(() => null, error => error); await catalogWait; failMetadata = true; const failedRefresh = await app.rpc('repairApplication'); assert.equal(failedRefresh.metadataRefresh.status, 'partial'); assert.ok(failedRefresh.metadataRefresh.errors.length >= 2); holdCatalog = null; release(); const stale = await delayed; assert.match(stale?.message ?? '', /迟到目录/); assert.equal((await app.rpc('getProviders')).connections[0].codexModel, model); pass('repair reports metadata failures and rejects a late pre-repair catalog instead of silently restoring cleared capability snapshots');
  failMetadata = false; let releaseMetadata; holdMetadata = new Promise(r => releaseMetadata = r); const metadataWait = new Promise(r => metadataStarted = r); const refresh = app.rpc('refreshMetadata', { topics: ['capabilities'], reason: 'held-test' }); await metadataWait; const pendingRepair = app.rpc('repairApplication'); await app.rpc('setTheme', 'night'); await app.rpc('updateCodexConfig', { compatibleModel: 'newer-unlisted-choice' }); holdMetadata = null; releaseMetadata(); await refresh; await pendingRepair; assert.equal((await app.rpc('getProviders')).connections[0].codexModel, 'newer-unlisted-choice'); generated = JSON.parse(await readFile(join(networkRoot, 'codex/xwx-deck-model-catalog.json'))).models; assert.ok(generated.some(row => row.slug === 'newer-unlisted-choice')); pass('repair drains a pending metadata writer without deadlock or blocking later user choices and publishes the latest selected model');
  await app.rpc('checkForUpdates'); holdDownload = new Promise(resolve => releaseDownload = resolve); await app.rpc('downloadUpdate'); await app.rpc('repairApplication'); assert.equal((await app.rpc('getUpdateState')).status, 'downloading'); releaseDownload(); holdDownload = null; await wait(async () => (await app.rpc('getUpdateState')).status === 'ready', 'update download completes'); const update = await app.rpc('getUpdateState'); assert.deepEqual(await readFile(update.downloadPath), payload); await app.rpc('repairApplication'); assert.equal((await app.rpc('getUpdateState')).status, 'ready'); assert.deepEqual(await readFile(update.downloadPath), payload); assert.equal((await app.rpc('restartAndInstall')).path, update.downloadPath); pass('downloading and ready verified installers survive quick repair and remain usable by the updater');
  compatibleMode = true; await app.rpc('saveProvider', { displayName: 'Messages_Route_Repair', baseUrl: base+'/v1', bearerToken: 'synthetic-repair-key', adapter: 'auto', codexApiFormat: 'responses', codexModel: 'anthropic-only-repair' });
  const compatible = (await app.rpc('getProviders')).connections.find(row => row.displayName === 'Messages_Route_Repair'); await app.rpc('fetchProviderModels', { providerId: compatible.id, refresh: true }); await app.rpc('switchClientProvider', { client: 'codex', providerId: compatible.id });
  const compatibleRunning = await app.rpc('toggleTracing', true);
  const requestcompatible = async () => { const response = await fetch(compatibleRunning.localBaseUrl + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'anthropic-only-repair', input: 'synthetic request' }) }); assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.output[0].content[0].text, 'route retained'); assert.equal(upstreamRequests.at(-1).path, '/v1/messages'); };
  await requestcompatible(); let releaseRoute; holdMetadata = new Promise(r => releaseRoute = r); const routeWait = new Promise(r => metadataStarted = r); const routeRepair = app.rpc('repairApplication'); await routeWait; await requestcompatible(); holdMetadata = null; releaseRoute(); const retained = await routeRepair; assert.ok(retained.preservedModelCatalogs >= 1); await app.rpc('toggleTracing', false); pass('active generic auto repair retains explicitly declared Messages routing while metadata is pending and actual new Responses requests continue through the original upstream'); await app.stop();
  const evidence = { passed: true, checks, metadataRequests, catalogRequests, upstreamRequests, binarySha256: createHash('sha256').update(await readFile(nativeTestBinary)).digest('hex'), realPlatformAuthorization: false, isolatedFixtures: true };
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/native-application-repair-summary.json', JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
} finally { releaseDownload?.(); for (const child of children) { if (child.exitCode === null) child.kill('SIGKILL'); } server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(fixture, { recursive: true, force: true }); }
