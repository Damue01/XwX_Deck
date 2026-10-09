import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const tag = process.env.RELEASE_TAG;
assert.match(tag ?? '', /^v\d+\.\d+\.\d+$/);
const repository = process.env.GITHUB_REPOSITORY ?? 'Damue01/XwX_Deck';
assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
const root = await mkdtemp(join(tmpdir(), 'xwx-published-native-'));
const base = `https://github.com/${repository}/releases/download/${tag}`;
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  assert.equal(response.status, 200, `Anonymous download failed: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
const metadataBytes = await get(`${base}/release.json`);
const metadata = JSON.parse(metadataBytes);
const latest = JSON.parse(await get(`https://github.com/${repository}/releases/latest/download/release.json`));
assert.equal(metadata.version, tag.slice(1)); assert.equal(metadata.tag, tag); assert.equal(latest.tag, tag, 'Only the latest published release feeds production updates');
const platform = process.platform === 'win32' ? 'windows' : 'darwin';
const artifact = metadata.files.find(file => file.platform === platform && file.arch === process.arch);
assert.ok(artifact, 'Missing matching native artifact');
const requiredName = platform === 'windows' ? 'XwX-Deck-windows-x64.exe' : 'XwX-Deck-mac-arm64.dmg';
assert.equal(artifact.name, requiredName); assert.equal(artifact.url, `${base}/${requiredName}`);
assert.match(artifact.sha256, /^[a-f0-9]{64}$/); assert.ok(artifact.size > 0 && artifact.size <= 512 * 1024 ** 2);
const data = await get(artifact.url); assert.equal(data.length, artifact.size);
assert.equal(createHash('sha256').update(data).digest('hex'), artifact.sha256);
const sidecar = (await get(`${base}/${requiredName}.sha256`)).toString('utf8');
assert.equal(sidecar.trim(), `${artifact.sha256}  ${requiredName}`);
const downloaded = join(root, requiredName); await writeFile(downloaded, data);
function command(file, args, env = process.env) {
  const result = spawnSync(file, args, { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${file} failed`);
}
let binary;
if (platform === 'windows') {
  binary = join(root, 'Deck.exe'); await copyFile(downloaded, binary);
} else {
  command('/usr/bin/hdiutil', ['verify', downloaded]);
  const mount = join(root, 'mounted'); await mkdir(mount);
  command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, downloaded]);
  try {
    const app = join(root, 'XwX Deck.app'); await cp(join(mount, 'XwX Deck.app'), app, { recursive: true });
    binary = join(app, 'Contents/MacOS/xwx-deck-native');
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    command('/usr/bin/lipo', ['-verify_arch', 'arm64', binary]);
    assert.ok((await readFile(join(app, 'Contents/Info.plist'), 'utf8')).includes('app.xwxdeck.desktop'));
  } finally { command('/usr/bin/hdiutil', ['detach', mount]); }
}
const env = { ...process.env, XWX_NATIVE_TEST_BINARY: binary };
command(process.execPath, [resolve(import.meta.dirname, 'native-test.mjs')], env);
command(process.execPath, [resolve(import.meta.dirname, 'language-test.mjs')], env);
if (platform === 'windows') command(process.execPath, [resolve(import.meta.dirname, 'portable-update-test.mjs')], env);
const evidence = { passed: true, tag, root, artifact, verification: 'anonymous metadata, SHA-256, real isolated native UI, preference restart, Windows physical replacement or macOS DMG mount and copied app' };
await mkdir('test-results', { recursive: true });
await writeFile(`test-results/published-native-${platform}.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
