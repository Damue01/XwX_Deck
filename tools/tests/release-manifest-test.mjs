import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '../..');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
// Synthetic byte payloads validate manifest generation, not executable validity.
const targets = [
  ['XwX-Deck-windows-x64.msi', 'windows', 'x64'],
  ['XwX-Deck-windows-x64.exe', 'windows', 'x64'],
  ['XwX-Deck-mac-arm64.dmg', 'darwin', 'arm64'],
  ['XwX-Deck-mac-x64.dmg', 'darwin', 'x64']
];
const temporary = await mkdtemp(join(tmpdir(), 'deck-release-manifest-'));
function generate(directory, tag = `v${version}`) {
  return spawnSync(process.execPath, [join(root, 'tools/release/write-release-manifest.mjs'), directory], {
    cwd: temporary, encoding: 'utf8',
    env: { ...process.env, RELEASE_VERSION: version, RELEASE_TAG: tag, GITHUB_REPOSITORY: 'example/deck' }
  });
}
try {
  const payloads = new Map();
  for (const [name] of targets) {
    const data = Buffer.from(`synthetic fixture for ${name}\n`);
    payloads.set(name, data);
    await writeFile(join(temporary, name), data);
  }
  const result = generate(temporary);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(join(temporary, 'release.json'), 'utf8'));
  assert.equal(manifest.version, version);
  assert.equal(manifest.tag, `v${version}`);
  assert.equal(manifest.channel, 'release');
  assert.equal(manifest.files.length, targets.length);
  assert.ok(manifest.changelog.startsWith(`## [${version}]`));
  const checksums = [];
  for (const [name, platform, arch] of targets) {
    const data = payloads.get(name);
    const sha256 = createHash('sha256').update(data).digest('hex');
    const file = manifest.files.find(item => item.name === name);
    assert.deepEqual(file, { platform, arch, name, url: `https://github.com/example/deck/releases/download/v${version}/${name}`, size: data.length, sha256 });
    const checksum = `${sha256}  ${name}\n`;
    assert.equal(await readFile(join(temporary, `${name}.sha256`), 'utf8'), checksum);
    checksums.push(checksum);
  }
  assert.equal(await readFile(join(temporary, 'checksums.txt'), 'utf8'), checksums.join(''));
  const windows = parse(await readFile(join(temporary, 'latest.yml'), 'utf8'));
  assert.equal(windows.version, version);
  assert.equal(windows.path, manifest.files[0].url);
  assert.equal(windows.files[0].size, payloads.get(targets[0][0]).length);
  assert.equal(windows.files[0].sha512, createHash('sha512').update(payloads.get(targets[0][0])).digest('base64'));
  assert.equal(windows.sha512, windows.files[0].sha512);
  const notes = await readFile(join(temporary, 'release-notes.md'), 'utf8');
  for (const [name] of targets) assert.ok(notes.includes(name));
  assert.notEqual(generate(temporary, 'v0.0.0-invalid').status, 0);
  for (const [missing] of targets) {
    const directory = await mkdtemp(join(temporary, 'incomplete-'));
    for (const [name, data] of payloads) if (name !== missing) await writeFile(join(directory, name), data);
    const failure = generate(directory);
    assert.notEqual(failure.status, 0);
    assert.ok(failure.stderr.includes(`Missing release artifact: ${missing}`));
    for (const name of ['release.json', 'latest.yml', 'checksums.txt']) await assert.rejects(access(join(directory, name)));
  }
  console.log('PASS release manifest: three architectures, MSI/portable separation, immutable URLs, hashes, notes, unrelated cwd and missing-artifact rejection (synthetic payloads)');
} finally { await rm(temporary, { recursive: true, force: true }); }
