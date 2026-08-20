import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifestPath = path.join(root, 'design', 'windows-icon-assets.json');
const writeMode = process.argv.includes('--write');

const source = { path: 'assets/icon.svg' };
const rasterMaster = { path: 'design/icon-master-black.png' };
const outputs = [
  { path: 'assets/icon.ico' },
  { path: 'assets/icon.png' },
  { path: 'assets/tray.png' }
];

if (writeMode) {
  if (process.platform !== 'win32') {
    throw new Error('The Windows icon manifest may only be regenerated on Windows.');
  }
  const manifest = {
    schemaVersion: 1,
    source: await withHash(source, true),
    rasterMaster: await withHash(rasterMaster),
    outputs: await Promise.all(outputs.map(item => withHash(item)))
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log('[windows-icons] wrote deterministic asset manifest');
} else {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  expect(manifest.schemaVersion === 1, 'manifest schemaVersion must be 1');
  await verifyEntry(manifest.source, source.path, true);
  await verifyEntry(manifest.rasterMaster, rasterMaster.path);
  expect(Array.isArray(manifest.outputs), 'manifest outputs must be an array');
  for (const expected of outputs) {
    const matches = manifest.outputs.filter(item => item?.path === expected.path);
    expect(matches.length === 1, `manifest must contain exactly one ${expected.path}`);
    await verifyEntry(matches[0], expected.path);
  }
  console.log('PASS committed Windows icon assets match their source-locked manifest');
}

async function verifyEntry(entry, expectedPath, normalizeText = false) {
  expect(entry?.path === expectedPath, `manifest entry path must be ${expectedPath}`);
  expect(/^[0-9a-f]{64}$/i.test(String(entry?.sha256 || '')), `${expectedPath} manifest SHA-256 is invalid`);
  const actual = await hashFile(expectedPath, normalizeText);
  expect(actual === entry.sha256.toLowerCase(), `${expectedPath} does not match design/windows-icon-assets.json`);
}

async function withHash(entry, normalizeText = false) {
  return { ...entry, sha256: await hashFile(entry.path, normalizeText) };
}

async function hashFile(relativePath, normalizeText = false) {
  let bytes = await readFile(path.join(root, relativePath));
  if (normalizeText) {
    bytes = Buffer.from(bytes.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
  }
  return createHash('sha256').update(bytes).digest('hex');
}

function expect(condition, message) {
  if (!condition) throw new Error(`[windows-icons] ${message}`);
}
