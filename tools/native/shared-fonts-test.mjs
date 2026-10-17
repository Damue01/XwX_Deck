import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { sharedFontCss, inlineFontCss } from '../build/inline-font-css.mjs';

const root = resolve(import.meta.dirname, '../..');
const cssPath = resolve(root, 'src/renderer/typography.css');
const source = await readFile(cssPath, 'utf8');
const shared = await sharedFontCss(source, cssPath);
const inline = await inlineFontCss(source, cssPath);
assert.ok(inline.includes('data:font/woff2;base64,'), 'standalone HTML retains offline fonts');
assert.ok(!shared.includes('data:font/'), 'native CSS does not duplicate font bytes');
const sourceRefs = [...source.matchAll(/url\(([^)]+\.woff2)\)/g)];
for (const [, ref] of sourceRefs) {
  const bytes = await readFile(resolve(cssPath, '..', ref.replace(/^['"]|['"]$/g, '')));
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.ok(shared.includes('/fonts/' + hash + '.woff2'));
  assert.ok(bytes.equals(await readFile(resolve(root, 'test-results/native-assets/fonts', hash + '.woff2'))));
}
const frontend = resolve(root, 'test-results/native-frontend');
const renderer = await readFile(resolve(frontend, 'app.css'), 'utf8');
const viewer = await readFile(resolve(root, 'test-results/native-assets/viewer.html'), 'utf8');
for (const css of [renderer, viewer]) {
  assert.ok(!css.includes('data:font/woff2'), 'packaged surfaces contain no inline WOFF2');
  for (const [, name] of css.matchAll(/\/fonts\/([a-f0-9]{64}\.woff2)/g)) {
    const bytes = await readFile(resolve(root, 'test-results/native-assets/fonts', name));
    assert.equal(createHash('sha256').update(bytes).digest('hex') + '.woff2', name);
  }
}
assert.ok(renderer.includes(process.platform === 'win32' ? 'http://xwx-font.localhost/fonts/' : 'xwx-font://localhost/fonts/'));
assert.ok(!((await readdir(frontend)).includes('fonts')), 'Tauri does not embed a second font directory');
for (const [, name] of shared.matchAll(/\/fonts\/([a-f0-9]{64}\.woff2)/g)) {
  assert.ok(renderer.includes(name) && viewer.includes(name), 'both surfaces reference the same font resource');
}
console.log(`PASS shared fonts: ${sourceRefs.length} typography resources retain exact bytes, native windows share fonts, standalone HTML stays offline`);
