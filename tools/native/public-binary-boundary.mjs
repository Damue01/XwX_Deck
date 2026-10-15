import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export function inspectPublicBinary(bytes, root) {
  const strings = [bytes.toString('utf8'), bytes.toString('utf16le'), bytes.subarray(1).toString('utf16le')].map(text => text.toLowerCase());
  const names = [['paper', 'hub'], ['x', '3', 'client']].map(parts => parts.join(''));
  const privateValues = [homedir(), resolve(root)].flatMap(value => [value, value.replaceAll('\\', '/')]);
  return [...new Set([...names, ...privateValues].map(value => value.toLowerCase()))]
    .filter(value => strings.some(text => text.includes(value)));
}

export async function assertPublicBinary(path, root) {
  if (inspectPublicBinary(await readFile(path), root).length) {
    throw Error('Public binary contains an internal name or private build path; publication is blocked.');
  }
}
