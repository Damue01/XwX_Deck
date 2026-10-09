import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { nativeTestBinary } from './test-support.mjs';

if (process.platform !== 'win32') { console.log('SKIP physical Windows EXE replacement: requires native Windows; Mac updates use manual DMG'); process.exit(0); }
const root = await mkdtemp(join(tmpdir(), 'xwx-physical-update-'));
const fixture = resolve(import.meta.dirname, 'portable-update-fixture.rs');
const original = join(root, 'old.exe'), newer = join(root, 'new.exe');
execFileSync('rustc', ['--edition=2021', '-O', fixture, '-o', original]);
execFileSync('rustc', ['--edition=2021', '-O', '--cfg', 'fixture_new', fixture, '-o', newer]);
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const oldHash = await hash(original), newHash = await hash(newer);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const absent = async path => { try { await access(path); return false; } catch { return true; } };
const checks = [];
async function test(name, run) {
  const folder = join(root, name), updates = join(folder, 'updates'); await mkdir(updates, { recursive: true });
  const target = join(folder, 'Deck.exe'), source = join(updates, 'download.exe'), worker = join(updates, 'worker.exe'), receipt = join(folder, 'receipt.json');
  await copyFile(original, target); await copyFile(newer, source); await copyFile(nativeTestBinary, worker);
  const env = { ...process.env, XWX_UPDATE_TEST_RECEIPT: receipt };
  let old;
  const startOld = async () => {
    old = spawn(target, [], { env, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    for (let i = 0; i < 100; i++) { if (!(await absent(receipt))) return; await delay(50); }
    throw Error('Old fixture did not start');
  };
  const stopOld = async () => { const ended = once(old, 'exit'); old.stdin.end(); assert.equal((await ended)[0], 0); };
  const runWorker = (expected = newHash) => {
    const child = spawn(worker, ['--install-update', source, '--replace-executable', target, '--expected-sha256', expected, '--parent-pid', String(old?.pid ?? process.pid)], { env, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), 65000);
    return once(child, 'exit').then(([code]) => { clearTimeout(timer); return code; });
  };
  const backup = target.replace(/\.exe$/, `.exe.previous-${oldHash.slice(0, 16)}`);
  try { await run({ target, source, receipt, worker, backup, startOld, stopOld, runWorker }); checks.push(name); console.log('PASS physical update ' + name); }
  finally { if (old?.exitCode === null) old.kill(); }
}
await test('wait-replace-restart', async f => {
  await f.startOld(); const result = f.runWorker(); await delay(1500);
  assert.equal(await hash(f.target), oldHash, 'Old executable must stay unchanged while its process runs');
  assert.equal(await absent(f.backup), true);
  await f.stopOld(); assert.equal(await result, 0);
  for (let i = 0; i < 100; i++) { if (JSON.parse(await readFile(f.receipt, 'utf8')).version === 'fixture-new') break; await delay(50); }
  assert.equal(JSON.parse(await readFile(f.receipt, 'utf8')).version, 'fixture-new');
  assert.equal(await hash(f.target), newHash); assert.equal(await hash(f.backup), oldHash);
});
await test('reject-wrong-hash', async f => {
  assert.equal(await f.runWorker('0'.repeat(64)), 1); assert.equal(await hash(f.target), oldHash); assert.equal(await absent(f.backup), true);
});
await test('reject-changed-download', async f => {
  await f.startOld(); const result = f.runWorker(); await delay(1500);
  await writeFile(f.source, 'Changed during parent exit wait'); await f.stopOld();
  assert.equal(await result, 1); assert.equal(await hash(f.target), oldHash); assert.equal(await absent(f.backup), true);
});
await test('keep-new-file-and-backup-on-launch-failure', async f => {
  await writeFile(f.source, 'Not a Windows executable'); const invalidHash = await hash(f.source);
  await f.startOld(); await f.stopOld(); assert.equal(await f.runWorker(invalidHash), 1);
  assert.equal(await hash(f.target), invalidHash); assert.equal(await hash(f.backup), oldHash);
  assert.equal(JSON.parse(await readFile(f.receipt, 'utf8')).version, 'fixture-old', 'Do not silently relaunch the old version');
  assert.match(await readFile(f.worker.replace(/\.exe$/, '.error.txt'), 'utf8'), /手动打开.*恢复备份/);
});
await writeFile(join(root, 'verification.json'), JSON.stringify({ root, checks, oldHash, newHash }, null, 2));
console.log(JSON.stringify({ root, checks, oldHash, newHash }, null, 2));
