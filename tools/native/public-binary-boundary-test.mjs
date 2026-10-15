import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { inspectPublicBinary } from './public-binary-boundary.mjs';

const root = resolve('public-fixture');
assert.deepEqual(inspectPublicBinary(Buffer.from('Public binary /src /cargo'), root), []);
const names = [['paper', 'hub'], ['x', '3', 'client']].map(parts => parts.join(''));
for (const value of [homedir(), root, ...names]) {
  for (const encoding of ['utf8', 'utf16le']) {
    const bytes = Buffer.from(value.toUpperCase(), encoding);
    assert.ok(inspectPublicBinary(bytes, root).length);
    assert.ok(inspectPublicBinary(Buffer.concat([Buffer.from([1]), bytes]), root).length);
  }
}
console.log('PASS native binary boundary: names and private build paths in UTF8 and aligned or unaligned UTF16');
