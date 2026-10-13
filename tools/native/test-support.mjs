import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const suffix = process.platform === 'win32' ? '.exe' : '';
const releaseBinary = resolve(import.meta.dirname, '../../test-results/native-target/release/xwx-deck-native' + suffix);
const debugBinary = resolve(import.meta.dirname, '../../test-results/native-target/debug/xwx-deck-native' + suffix);
export const nativeTestBinary = process.env.XWX_NATIVE_TEST_BINARY ?? (existsSync(releaseBinary) ? releaseBinary : debugBinary);
// Public fixtures start with an empty registry; no default service is created.
export async function clearFreshCompatibleFixture(rpc) {
  assertFreshCompatible(await rpc('getProviders'));
}
export function assertFreshCompatible(registry) {
  assert.deepEqual(registry.connections, []);
  assert.equal(registry.selected.codex, null);
  assert.equal(registry.selected.claude, null);
}
// Protocol fixtures inspect calls without executing them. Assert the exact
// outstanding set before explicitly abandoning it; never use in real-client tests.
export async function stopUnexecutedToolFixtures(rpc, expectedCount) {
  assert.ok(expectedCount > 0);
  assert.equal((await rpc('getState')).waitingTools, expectedCount);
  await assert.rejects(rpc('toggleTracing', false), /工具调用仍在等待/);
  return rpc('toggleTracing', false, true);
}
// Fixed test CLI arguments only, never user commands.
export async function writeCliFixture(path, body) {
  if (process.platform !== 'win32') { await writeFile(path, `#!${process.execPath}\n${body}`, { mode: 0o700 }); return path; }
  const script = path + '.cjs'; await writeFile(script, body);
  const quote = value => { if (/["%\r\n]/.test(value)) throw new Error('Unsupported test fixture path'); return `"${value}"`; };
  await writeFile(path + '.cmd', `@echo off\r\n${quote(process.execPath)} ${quote(script)} %*\r\n`);
  return path + '.cmd';
}
