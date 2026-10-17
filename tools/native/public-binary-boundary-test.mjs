import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { createIdentifierMatcher } from '../checks/privacy-identifiers.mjs';
import { resolve } from 'node:path';
import { inspectPublicBinary } from './public-binary-boundary.mjs';

const root = resolve('public-fixture');
assert.deepEqual(inspectPublicBinary(Buffer.from('Public binary /src /cargo'), root), []);
const names = ['fixtureprivatevendor', 'fixtureprivateclient'];
const matcher = createIdentifierMatcher(names.map(name => ({ length: name.length, sha256: createHash('sha256').update(name).digest('hex') })));
assert.equal(matcher('safe fixture'), false);
assert.ok(matcher('prefix' + names[0] + 'suffix'));
for (const value of [homedir(), root, ...names]) {
  for (const encoding of ['utf8', 'utf16le']) {
    const bytes = Buffer.from(value.toUpperCase(), encoding);
    assert.ok(inspectPublicBinary(bytes, root, matcher).length);
    assert.ok(inspectPublicBinary(Buffer.concat([Buffer.from([1]), bytes]), root, matcher).length);
  }
}
console.log('PASS native binary boundary: names and private build paths in UTF8 and aligned or unaligned UTF16');
