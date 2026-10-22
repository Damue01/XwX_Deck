import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { verifyCandidate } from './source-fingerprint.mjs';

const binary = resolve(process.env.XWX_NATIVE_TEST_BINARY ?? 'test-results/native-target/debug/xwxdeck-native.exe');
const directory = await mkdtemp(join(tmpdir(), 'xwx-storage-migration-'));
const checks = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let provenance;
if (process.env.XWX_NATIVE_TEST_BUILD_REPORT) provenance = await verifyCandidate({ root: resolve('.'), report: JSON.parse(await readFile(process.env.XWX_NATIVE_TEST_BUILD_REPORT, 'utf8')), binary, allowManualAcceptance: true });
const server = createServer(async (req, res) => {
  for await (const _ of req) { /* drain the isolated fixture request */ }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: 'storage-response', object: 'response', status: 'completed', model: 'fixture', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'storage payload '.repeat(4000) }] }], usage: { input_tokens: 2, output_tokens: 3 } }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let processHandle;
async function start(root) {
  await mkdir(root, { recursive: true });
  processHandle = spawn(binary, ['--rpc', '--pilot-root', root], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = [];
  let stderr = '';
  processHandle.stderr.on('data', value => { stderr += value; });
  createInterface({ input: processHandle.stdout }).on('line', line => pending.shift()?.(JSON.parse(line)));
  processHandle.once('exit', code => { if (code && pending.length) pending.shift()({ ok: false, error: stderr }); });
  return async (method, ...args) => {
    const value = await new Promise((resolveValue, reject) => {
      const timer = setTimeout(() => reject(Error('RPC timeout: ' + method + '\n' + stderr)), 30000);
      pending.push(result => { clearTimeout(timer); resolveValue(result); });
      processHandle.stdin.write(JSON.stringify({ method, args }) + '\n');
    });
    if (!value.ok) throw Error(value.error);
    return value.result;
  };
}
async function stop() {
  const child = processHandle; processHandle = undefined;
  const exited = once(child, 'exit'); child.stdin.end(); await exited;
}
try {
  const root = join(directory, 'complete');
  let rpc = await start(root);
  await rpc('getState');
  const providers = await rpc('saveProvider', { displayName: 'Storage fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, bearerToken: 'fixture-key', adapter: 'responses', codexModel: 'fixture' });
  await rpc('switchClientProvider', { client: 'codex', providerId: providers.connections.at(-1).id });
  const state = await rpc('toggleTracing', true);
  const response = await fetch(state.localBaseUrl + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-id': 'storage-fixture' }, body: JSON.stringify({ model: 'fixture', input: 'fixture request '.repeat(3000) }) });
  assert.equal(response.status, 200); await response.json();
  await rpc('toggleTracing', false);
  const oldIndex = JSON.parse(await readFile(join(root, 'traces/index.json'), 'utf8'));
  assert.ok(oldIndex.sessions.length > 0);
  const before = new Map();
  for (const file of await readdir(join(root, 'traces'))) if (file !== 'index.json') before.set(file, hash(await readFile(join(root, 'traces', file))));
  check('real local Gateway produced a compressed SQLite sidecar', [...before.keys()].some(name => name.endsWith('.content.sqlite')));
  await writeFile(join(root, 'logs/runtime.log'), 'owned runtime log');
  await mkdir(join(root, 'legacy-data-backup'), { recursive: true });
  const backup = Buffer.from('{"sessions":[],"keep":"original bytes and spacing"}\n');
  await writeFile(join(root, 'legacy-data-backup/index.json'), backup);
  const beforeSettings = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'));
  const target = join(root, 'installation/XwXTrace');
  const migrated = await rpc('smokeStorageMigration', { destination: target });
  const events = migrated.migrationProgress;
  check('migration reports intermediate progress and ends at 100 percent', events.some(v => v.percent > 0 && v.percent < 100) && events.at(-1).percent === 100);
  check('progress never decreases', events.every((value, index) => index === 0 || value.percent >= events[index - 1].percent));
  for (const [file, digest] of before) assert.equal(hash(await readFile(join(target, 'traces', file))), digest);
  check('all JSONL and SQLite payload bytes survive migration', true);
  assert.deepEqual(await readFile(join(target, 'legacy-data-backup/index.json')), backup);
  check('old backup is moved without rewriting its evidence', true);
  check('runtime log moves to installation storage', await readFile(join(target, 'logs/runtime.log'), 'utf8') === 'owned runtime log');
  const index = JSON.parse(await readFile(join(target, 'traces/index.json'), 'utf8'));
  check('session index points to the migrated files', index.sessions.every(session => session.jsonlPath.startsWith(join(target, 'traces'))));
  const afterSettings = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'));
  check('connections and selected providers stay unchanged', JSON.stringify(afterSettings.connections) === JSON.stringify(beforeSettings.connections) && JSON.stringify(afterSettings.selected) === JSON.stringify(beforeSettings.selected));
  check('verified original bulk files are removed', !(await readdir(root)).some(name => ['traces', 'logs', 'legacy-data-backup'].includes(name)));
  await stop();
  rpc = await start(root);
  const reopened = await rpc('getState');
  check('restart reads the new directories directly', reopened.traceRoot === join(target, 'traces') && reopened.logRoot === join(target, 'logs'));
  const dashboard = await rpc('getDashboardUrl');
  const detailResponse = await fetch(dashboard + 'api/session/' + encodeURIComponent(index.sessions[0].id));
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.text();
  check('migrated compressed history can be decoded after restart', detail.includes('storage payload') && detail.includes('fixture request'));
  const nextTarget = join(root, 'different-installation/XwXTrace');
  const movedAgain = await rpc('smokeStorageMigration', { destination: nextTarget });
  check('a changed installation location relocates managed bulk storage again', movedAgain.traceRoot === join(nextTarget, 'traces') && await readFile(join(nextTarget, 'logs/runtime.log'), 'utf8') === 'owned runtime log');
  assert.deepEqual(await readFile(join(nextTarget, 'legacy-data-backup/index.json')), backup);
  check('managed backup follows the new installation', true);
  await stop();

  const conflictRoot = join(directory, 'conflict');
  rpc = await start(conflictRoot); await rpc('getState');
  await writeFile(join(conflictRoot, 'traces/payload.bin'), 'original');
  const conflictTarget = join(conflictRoot, 'installation/XwXTrace');
  await mkdir(join(conflictTarget, 'traces'), { recursive: true });
  await writeFile(join(conflictTarget, 'traces/payload.bin'), 'conflict');
  const settings = await readFile(join(conflictRoot, 'settings.json'));
  await assert.rejects(rpc('smokeStorageMigration', { destination: conflictTarget }), /同名不同/);
  check('conflict retains original payload and settings', await readFile(join(conflictRoot, 'traces/payload.bin'), 'utf8') === 'original' && (await readFile(join(conflictRoot, 'settings.json'))).equals(settings));
  await assert.rejects(rpc('smokeStorageMigration', { destination: join(conflictRoot, 'traces/nested') }), /互相包含/);
  await assert.rejects(rpc('smokeStorageMigration', { destination: join(directory, 'outside') }), /隔离根目录/);
  check('overlapping and out-of-scope destinations are rejected', true);
  await unlink(join(conflictTarget, 'traces/payload.bin'));
  await rpc('smokeStorageMigration', { destination: conflictTarget });
  check('retry after removing the isolated conflict completes without losing data', await readFile(join(conflictTarget, 'traces/payload.bin'), 'utf8') === 'original');
  await stop();

  const customRoot = join(directory, 'custom');
  rpc = await start(customRoot); await rpc('getState');
  const customTrace = join(customRoot, 'user-trace'); const customLog = join(customRoot, 'user-log');
  await rpc('updateTraceDirectories', { traceRoot: customTrace, logRoot: customLog });
  await writeFile(join(customTrace, 'user.bin'), 'keep custom');
  const custom = await rpc('smokeStorageMigration', { destination: join(customRoot, 'installation/XwXTrace') });
  check('explicit user directories and files remain unchanged', custom.traceRoot === customTrace && custom.logRoot === customLog && await readFile(join(customTrace, 'user.bin'), 'utf8') === 'keep custom');
  await stop();
  const summary = { passed: true, binary, binarySha256: hash(await readFile(binary)), provenance, root: directory, checks, scope: 'Isolated local Gateway, actual compressed history and disk migration; no real vendor or user installation was modified.' };
  await writeFile('test-results/data-storage-summary.json', JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
} catch (error) {
  await writeFile('test-results/data-storage-summary.json', JSON.stringify({ passed: false, error: String(error), binary, root: directory, checks }, null, 2) + '\n');
  throw error;
} finally { if (processHandle) await stop(); server.close(); }
