import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { rawTextPlugin } from '../build/raw-text-plugin.mjs';
const root = resolve(import.meta.dirname, '../..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
for (const name of ['electron', 'electron-builder', 'electron-updater', 'app-builder-lib']) {
  assert.ok(!pkg.dependencies?.[name] && !pkg.devDependencies?.[name], `${name} must remain outside the native project`);
}
assert.ok(!pkg.main && !pkg.build && !pkg.scripts.postinstall, 'Native project must not install or launch an Electron app');
assert.ok(!Object.keys(pkg.scripts).some(name => name.endsWith(':electron') || name.startsWith('ship:')), 'Retired app builds must not be root product commands');
assert.ok(!pkg.scripts.compile.includes('--legacy'), 'Default compile must exclude legacy fixtures');
const entries = [
  { label: 'React frontend', entryPoints: [resolve(root, 'src/renderer/main.tsx')], platform: 'browser', alias: { '@': resolve(root, 'src/renderer') }, loader: { '.css': 'empty' }, jsx: 'automatic' },
  { label: 'Native resources', entryPoints: [resolve(root, 'tools/build/native-assets.ts')], platform: 'node', plugins: [rawTextPlugin] },
];
for (const { label, ...options } of entries) {
  const result = await build({ ...options, absWorkingDir: root, bundle: true, format: 'esm', write: false, metafile: true, logLevel: 'silent' });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(!inputs.some(path => /^tools\/legacy\//.test(path)), `${label} imports legacy backend code`);
  assert.ok(!inputs.some(path => /node_modules\/(?:electron(?:-builder|-updater)?|app-builder-lib)\//.test(path)), `${label} includes another desktop runtime`);
  console.log(`PASS ${label}: ${inputs.length} inputs, no legacy backend or Electron`);
}
