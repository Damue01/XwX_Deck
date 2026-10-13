import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { nativeTestBinary, writeCliFixture } from './test-support.mjs';

// Unix inherited file-description leases are exercised with a real official-CLI
// substitute. Windows handle inheritance still requires its own OS validation.
if (process.platform === 'win32') {
  console.log('SKIP Unix CLI home leases: Windows startup retains uncertain homes');
  process.exit(0);
}
const fixture = await mkdtemp(join(await realpath(tmpdir()), 'xwxdeck-cli-lifecycle-'));
const root = join(fixture, 'pilot'), marker = join(fixture, 'refresh.json'), release = join(fixture, 'release');
const id = 'grok-' + '1'.repeat(36), secret = 'SYNTHETIC-CLI-LEASE-CREDENTIAL';
const owner = createHash('sha256').update(root).digest('hex'), checks = [], extraHomes = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pass = name => { checks.push(name); console.log('PASS ' + name); };
let child, sequence = 0, stderr = '', activeCli;
const pending = new Map();
const server = createServer((req, res) => { assert.equal(req.url, '/grok/v1/models'); res.end(JSON.stringify({ data: [{ id: 'lease-model' }] })); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
const cli = await writeCliFixture(join(fixture, 'grok'), `
const fs=require('node:fs/promises'),path=require('node:path');
(async()=>{
 if(process.argv[2]==='version'){console.log('Grok Build 1.0.41');return;}
 if(process.argv[2]!=='models')throw Error('Unexpected fixture command');
 const home=process.env.GROK_HOME;
 await fs.writeFile(${JSON.stringify(marker)},JSON.stringify({home,pid:process.pid}));
 for(let i=0;i<1000;i++){
  try{await fs.stat(${JSON.stringify(release)});break;}catch{}
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 const source=JSON.parse(await fs.readFile(path.join(home,'auth.json'),'utf8'));
 source.grok.expires_at=new Date(Date.now()+3600000).toISOString();
 await fs.writeFile(path.join(home,'auth.json'),JSON.stringify(source),{mode:0o600});
})().catch(()=>{process.exitCode=1});
`);
function start(timeout = 30000) {
  stderr = '';
  child = spawn(nativeTestBinary, ['--rpc', '--pilot-root', root, '--subscription-test-endpoint', origin, '--subscription-test-grok-cli', cli],
    { env: { ...process.env, XWX_DECK_TEST_SECURE_STORE: '1', XWX_DECK_CLI_TEST_TIMEOUT_MS: String(timeout) } });
  child.stderr.on('data', bytes => { stderr += bytes; });
  createInterface({ input: child.stdout }).on('line', line => {
    const value = JSON.parse(line), handle = pending.get(value.requestId); pending.delete(value.requestId); handle?.(value);
  });
  child.on('exit', () => { for (const handle of pending.values()) handle({ ok: false, error: 'fixture manager exited: ' + stderr }); pending.clear(); });
}
function rpc(method, ...args) {
  return new Promise((resolve, reject) => {
    const requestId = String(++sequence), timer = setTimeout(() => { pending.delete(requestId); reject(Error(method + ' timeout ' + stderr)); }, 10000);
    pending.set(requestId, value => { clearTimeout(timer); value.ok ? resolve(value.result) : reject(Error(value.error)); });
    child.stdin.write(JSON.stringify({ requestId, method, args }) + '\n');
  });
}
async function stop() { const ended = once(child, 'exit'); child.stdin.end(); assert.equal((await ended)[0], 0, stderr); }
async function refreshStarted() {
  for (let i = 0; i < 150; i++) { try { const value = JSON.parse(await readFile(marker, 'utf8')); activeCli = value.pid; return value; } catch { await delay(20); } }
  throw Error('refresh CLI never started: ' + stderr);
}
const ledger = () => readFile(join(root, 'native-cli-work.json'), 'utf8').then(JSON.parse);
async function seed() {
  await mkdir(join(root, 'grok-accounts', id), { recursive: true });
  await writeFile(join(root, 'grok-accounts/accounts.json'), JSON.stringify([{ id, label: 'Saved account', email: 'lease@example.test' }]));
  await writeFile(join(root, 'grok-accounts', id, 'auth.json'), JSON.stringify({ grok: { key: secret, email: 'lease@example.test', expires_at: new Date(0).toISOString() } }));
}
async function fakeHome(hasLease) {
  const home = join(await realpath(tmpdir()), 'xwxdeck-cli-' + randomBytes(16).toString('hex'));
  extraHomes.push(home); await mkdir(home, { mode: 0o700 });
  await writeFile(join(home, '.xwxdeck-cli-owner'), owner); await writeFile(join(home, 'auth.json'), secret);
  if (hasLease) await writeFile(join(home, '.xwxdeck-cli-lease'), '');
  return home;
}
try {
  start(); await rpc('getState'); await stop();
  await seed(); start(); await rpc('getState');
  const providers = await rpc('connectSubscriptionAccount', id);
  const providerId = providers.connections.find(provider => provider.subscriptionAccountId === id)?.id;
  assert.ok(providerId, 'connected Grok account has its own provider alongside the default compatible');
  const before = await readFile(join(root, 'grok-accounts', id, 'auth.json')); assert.ok(!before.includes(secret));
  const pendingRefresh = rpc('fetchProviderModels', { providerId }).catch(error => error.message);
  const work = await refreshStarted(); assert.deepEqual(await ledger(), [work.home]);
  assert.equal((await stat(work.home)).mode & 0o777, 0o700);
  assert.equal((await stat(join(work.home, 'auth.json'))).mode & 0o777, 0o600);
  const died = once(child, 'exit'); child.kill('SIGKILL'); await died; assert.match(await pendingRefresh, /exited/);
  start(); await rpc('getState'); assert.deepEqual(await ledger(), [work.home]);
  assert.ok((await readFile(join(work.home, 'auth.json'), 'utf8')).includes(secret));
  assert.deepEqual(await readFile(join(root, 'grok-accounts', id, 'auth.json')), before);
  pass('SIGKILL of the manager leaves a real running CLI lease intact; restart preserves its private home and original sealed account');
  await writeFile(release, '');
  for (let i = 0; i < 150; i++) { if ((await readFile(join(work.home, 'auth.json'), 'utf8')).includes('1970-')) { await delay(20); continue; } break; }
  await delay(100); await stop(); start(); await rpc('getState');
  await assert.rejects(stat(work.home)); assert.deepEqual(await ledger(), []);
  assert.deepEqual(await readFile(join(root, 'grok-accounts', id, 'auth.json')), before);
  pass('once the orphan CLI exits, restart removes the exactly owned home without importing its uncommitted refresh or rewriting the original account');
  await stop(); await rm(marker); await rm(release); start(300); await rpc('getState');
  const timeout = rpc('fetchProviderModels', { providerId }).then(() => 'unexpected success', error => error.message);
  const timed = await refreshStarted(); assert.match(await timeout, /刷新超时/); await delay(100);
  await stop(); start(); await rpc('getState'); await assert.rejects(stat(timed.home)); assert.deepEqual(await ledger(), []);
  assert.deepEqual(await readFile(join(root, 'grok-accounts', id, 'auth.json')), before);
  pass('timed-out refresh terminates its owned CLI, releases the lease and keeps the sealed original credentials unchanged');
  await stop();
  const valid = await fakeHome(true), legacy = await fakeHome(false);
  const prior = JSON.stringify([valid, legacy]); await writeFile(join(root, 'native-cli-work.json'), prior);
  start(); const exit = await once(child, 'exit'); assert.notEqual(exit[0], 0); assert.match(stderr, /缺少进程租约/);
  assert.equal(await readFile(join(root, 'native-cli-work.json'), 'utf8'), prior);
  assert.equal(await readFile(join(valid, 'auth.json'), 'utf8'), secret); assert.equal(await readFile(join(legacy, 'auth.json'), 'utf8'), secret);
  pass('an older home with no process lease fails closed before any directory in the batch is removed; exact records remain actionable');
  console.log(JSON.stringify({ passed: true, checks, scope: 'Unix inherited lease, actual subprocess SIGKILL/timeout/restart; isolated synthetic credentials only; official Grok and Windows process trees unverified' }));
} finally {
  if (child?.exitCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; }
  // Only the PID supplied by this private fixture is eligible for cleanup.
  if (activeCli) { try {
    const command = execFileSync('/bin/ps', ['-p', String(activeCli), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (command === `${process.execPath} ${cli} models`) process.kill(activeCli, 'SIGKILL');
  } catch {} }
  await new Promise(resolve => server.close(resolve));
  for (const home of [...extraHomes, ...await ledger().catch(() => [])]) await rm(home, { recursive: true, force: true });
  await rm(fixture, { recursive: true, force: true });
}
