import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { nativeTestBinary } from './test-support.mjs';

const policy = JSON.parse(await readFile(resolve(import.meta.dirname, '../../public-release-policy.json'), 'utf8'));
const removedService = ['Paper', 'Hub'].join('');
const forbiddenMethods = [...policy.forbiddenRpcMethods, ...['get', 'update'].map(prefix => prefix + removedService + 'Config'), ...['get', 'login'].map(prefix => prefix + removedService + 'Quota')];
const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-public-boundary-'));
const child = spawn(nativeTestBinary, ['--rpc', '--pilot-root', root], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, XWX_DECK_METADATA_PUSH_URL: '', XWX_DECK_TEST_PRIVATE_STORE: '1' },
});
const queue = [];
let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk; });
const rejectPending = error => { for (const pending of queue.splice(0)) { clearTimeout(pending.timer); pending.reject(error); } };
child.on('error', rejectPending);
child.on('exit', (code, signal) => rejectPending(Error(`Native exit ${code ?? signal}: ${stderr}`)));
createInterface({ input: child.stdout }).on('line', line => {
  const pending = queue.shift();
  if (!pending) return;
  clearTimeout(pending.timer);
  try { pending.resolve(JSON.parse(line)); } catch (error) { pending.reject(error); }
});
const call = (method, ...args) => new Promise((resolve, reject) => {
  const pending = { resolve, reject, timer: null };
  pending.timer = setTimeout(() => {
    const index = queue.indexOf(pending);
    if (index !== -1) queue.splice(index, 1);
    reject(Error(`RPC timeout ${method}: ${stderr}`));
  }, 20_000);
  queue.push(pending);
  child.stdin.write(JSON.stringify({ method, args }) + '\n');
});
const rpc = async (method, ...args) => { const response = await call(method, ...args); assert.equal(response.ok, true, response.error); return response.result; };
const snapshot = async directory => {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) for (const nested of await snapshot(file)) entries.push([`${entry.name}/${nested[0]}`, nested[1]]);
    else if (entry.isFile() && !entry.name.endsWith('.lock')) entries.push([entry.name, (await readFile(file)).toString('base64')]);
  }
  return entries.sort(([a], [b]) => a.localeCompare(b));
};
try {
  const providers = await rpc('getProviders');
  assert.deepEqual(providers.connections, []);
  assert.deepEqual(providers.selected, { codex: null, claude: null });
  const state = await rpc('getState');
  assert.equal(state.traceWarningGB, 1);
  assert.equal(state.traceAutoCleanup, true);
  assert.equal(state.backgroundGatewayActive, false);
  const before = await snapshot(root);
  for (const method of forbiddenMethods) {
    const response = await call(method);
    assert.equal(response.ok, false, `${method} must not be exposed`);
    assert.match(response.error, /不支持操作|unknown.*(?:method|operation)|unsupported.*(?:method|operation)/iu, `${method} must reject as unsupported, rather than run a removed feature`);
  }
  assert.deepEqual(await snapshot(root), before, 'rejected feature calls must not change isolated state or create artifacts');
  const desktop = await rpc('getClaudeDesktopSync');
  assert.equal(desktop.enabled, false);
  assert.equal(desktop.active, false);
  const saved = await rpc('updateClaudeDesktopSync', false);
  assert.equal(saved.enabled, false);
  assert.deepEqual((await rpc('getProviders')).connections, []);
  assert.deepEqual((await rpc('getProviders')).selected, { codex: null, claude: null });
  const exited = once(child, 'exit');
  child.stdin.end();
  assert.equal((await exited)[0], 0, stderr);
  console.log(`PASS public runtime boundary: empty choices, 1 GB cleanup, ${forbiddenMethods.length} removed operations rejected without writes, Desktop model integration retained`);
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}
