import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { nativeTestBinary } from './test-support.mjs';

for (const [system, expected] of [['zh-Hant-TW', 'zh-CN'], ['en-GB', 'en'], ['ja-JP', 'en']]) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-native-language-'));
  let child, pending = [];
  const start = () => {
    child = spawn(nativeTestBinary, ['--rpc', '--pilot-root', root], { env: { ...process.env, XWX_SYSTEM_LANGUAGE_TEST: system } });
    createInterface({ input: child.stdout }).on('line', line => pending.shift()?.(JSON.parse(line)));
  };
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`Timeout: ${method}`)), 15000);
    pending.push(value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(JSON.stringify({ method, args }) + '\n');
  });
  const rpc = async (method, ...args) => { const value = await call(method, ...args); assert.equal(value.ok, true, value.error); return value.result; };
  const stop = async () => { const ended = once(child, 'exit'); child.stdin.end(); assert.equal((await ended)[0], 0); };
  try {
    start(); assert.equal((await rpc('getState')).language, expected);
    const before = await rpc('getProviders');
    assert.equal((await rpc('setLanguage', 'en')).language, 'en');
    assert.equal((await call('setLanguage', 'system')).ok, false);
    assert.equal((await call('setLanguage', 'de')).ok, false);
    assert.equal((await rpc('getState')).language, 'en');
    await stop(); start(); assert.equal((await rpc('getState')).language, 'en');
    assert.deepEqual(await rpc('getProviders'), before);
    await rpc('setLanguage', 'zh-CN'); await stop(); start();
    assert.equal((await rpc('getState')).language, 'zh-CN');
    // Preference updates are committed to disk, not just returned from an RPC.
    const settings = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'));
    assert.equal(settings.language, 'zh-CN');
    await stop();
    console.log(`PASS OS language ${system} -> ${expected}; explicit choices persist, invalid choices rejected, providers unchanged`);
  } finally { if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL'); }
}
