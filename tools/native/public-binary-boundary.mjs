import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { containsPrivateIdentifier } from '../checks/privacy-identifiers.mjs';

export function inspectPublicBinary(bytes, root, matcher = containsPrivateIdentifier) {
  const strings = [bytes.toString('utf8'), bytes.toString('utf16le'), bytes.subarray(1).toString('utf16le')].map(text => text.toLowerCase());
  const privateValues = [homedir(), resolve(root)].flatMap(value => [value, value.replaceAll('\\', '/')]);
  return [...new Set(privateValues.map(value => value.toLowerCase()))].filter(value => strings.some(text => text.includes(value)))
    .concat(strings.some(text => matcher(text, { includeShort: false })) ? ['private-identifier-fingerprint'] : []);
}

export async function assertPublicBinary(path, root) {
  if (inspectPublicBinary(await readFile(path), root).length) {
    throw Error('Public binary contains an internal name or private build path; publication is blocked.');
  }
}
