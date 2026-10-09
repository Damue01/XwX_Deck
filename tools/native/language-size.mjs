import fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import esbuild from 'esbuild';

const dictionaries = [];
for (const language of ['en']) {
  const source = await fs.readFile(resolve(`src/renderer/lib/locales/${language}.ts`), 'utf8');
  const values = JSON.parse(source.slice(source.indexOf('=') + 1).trim().replace(/;$/, ''));
  const bytes = Buffer.from(JSON.stringify(values));
  dictionaries.push({ language, entries: Object.keys(values).length, utf8Bytes: bytes.length, gzipBytes: gzipSync(bytes, { level: 9 }).length });
}
const options = {
  entryPoints: ['src/renderer/main.tsx'], bundle: true, write: false, platform: 'browser',
  target: ['safari15', 'chrome120'], format: 'esm', jsx: 'automatic', minify: true,
  alias: { '@': resolve('src/renderer') }, loader: { '.css': 'empty' }, logLevel: 'silent'
};
// Identical UI with Chinese UI without translations versus the Chinese/English UI.
// This removes text resources only; both builds retain the same controls and logic.
const withoutExtra = { name: 'language-baseline', setup(build) {
  build.onLoad({ filter: /\/locales\/en\.ts$/ }, args => ({ contents: 'export const english = {};', loader: 'ts' }));
} };
const full = (await esbuild.build(options)).outputFiles[0].contents;
const baseline = (await esbuild.build({ ...options, plugins: [withoutExtra] })).outputFiles[0].contents;
const report = {
  languages: 2, dictionaries,
  renderer: { allBytes: full.length, baselineBytes: baseline.length, addedBytes: full.length - baseline.length,
    allGzipBytes: gzipSync(full, { level: 9 }).length, baselineGzipBytes: gzipSync(baseline, { level: 9 }).length,
    addedGzipBytes: gzipSync(full, { level: 9 }).length - gzipSync(baseline, { level: 9 }).length },
  note: 'Gzip describes text compression, not an exact DMG delta. No converter or additional fonts are shipped.'
};
await fs.mkdir('test-results', { recursive: true });
await fs.writeFile('test-results/language-size.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
