import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
export const nativeTestBinary = process.env.XWX_NATIVE_TEST_BINARY ?? resolve(import.meta.dirname, '../../test-results/native-target/release/xwx-deck-native' + (process.platform === 'win32' ? '.exe' : ''));
// Fixed test CLI arguments only, never user commands.
export async function writeCliFixture(path, body) {
  if (process.platform !== 'win32') { await writeFile(path, `#!${process.execPath}\n${body}`, { mode: 0o700 }); return path; }
  const script = path + '.cjs'; await writeFile(script, body);
  const quote = value => { if (/["%\r\n]/.test(value)) throw new Error('Unsupported test fixture path'); return `"${value}"`; };
  await writeFile(path + '.cmd', `@echo off\r\n${quote(process.execPath)} ${quote(script)} %*\r\n`);
  return path + '.cmd';
}
