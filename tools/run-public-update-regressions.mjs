import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { parse } from 'yaml';

// Real updater state, HTTP downloads and disk integrity. Only Electron UI and
// the Windows NSIS adapter are mocked; no application is installed or launched.
const root = path.resolve(import.meta.dirname, '..');
const fixture = await mkdtemp(path.join(tmpdir(), 'xwx-public-update-'));
const require = createRequire(import.meta.url);
const bundle = await build({ entryPoints: [path.join(root, 'src/main/update/xwxDeckUpdater.ts')],
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' });
const bytes = Buffer.from('MZ-public-update-fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const sha512 = createHash('sha512').update(bytes).digest('base64');
let version = '0.2.0', status = 200, slow = false, tampered = false, artifactReads = 0;
let rootUrl;
const names = ['XwX-Deck-mac-arm64.dmg', 'XwX-Deck-windows-x64.exe'];
const manifest = () => ({ version, files: names.map(name => ({ name, url: `${rootUrl}/${name}`, size: bytes.length, sha256 })) });
const server = createServer((req, res) => {
  if (req.url === '/release.json') { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(manifest())); return; }
  if (req.url === '/latest.yml') { res.end(`version: ${version}\nfiles:\n  - url: ${rootUrl}/${names[1]}\n    sha512: ${sha512}\n    size: ${bytes.length}\n`); return; }
  artifactReads += 1;
  res.writeHead(200);
  const body = tampered ? Buffer.alloc(bytes.length) : bytes;
  if (!slow) { res.end(body); return; }
  res.write(body.subarray(0, 1));
  const timer = setTimeout(() => res.end(body.subarray(1)), 2000);
  res.on('close', () => clearTimeout(timer));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
rootUrl = `http://127.0.0.1:${server.address().port}`;
async function load(platform, userData) {
  await mkdir(userData, { recursive: true });
  const opened = [];
  const environment = { XWX_DECK_UPDATE_SERVER_URL: rootUrl };
  if (platform === 'win32') {
    environment.PORTABLE_EXECUTABLE_FILE = path.join(userData, '我的 Deck.exe');
    await writeFile(environment.PORTABLE_EXECUTABLE_FILE, 'MZ-old');
  }
  class NsisFixture extends EventEmitter {
    constructor() { super(); assert.equal(platform, 'win32', 'Mac must never create an automatic updater'); }
    setFeedURL(value) { this.feed = value.url; }
    async checkForUpdates() {
      const info = parse(await (await fetch(`${this.feed}/latest.yml`)).text());
      this.info = info;
      this.emit('update-available', info);
    }
    async downloadUpdate(token) {
      const abort = new AbortController(); token.onCancel(() => abort.abort());
      const data = Buffer.from(await (await fetch(this.info.files[0].url, { signal: abort.signal })).arrayBuffer());
      assert.equal(createHash('sha512').update(data).digest('base64'), this.info.files[0].sha512);
      const file = path.join(userData, 'download.exe'); await writeFile(file, data);
      this.emit('update-downloaded', { ...this.info, downloadedFile: file });
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, __dirname: path.join(root, 'dist'),
    process: { ...process, platform, arch: 'arm64', env: environment },
    Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout, console,
    require(id) {
      if (id === 'electron') return { app: { isPackaged: true, getVersion: () => '0.1.0', getPath: () => userData },
        net: { fetch }, shell: { openPath: async file => { opened.push(file); return ''; } } };
      if (id === 'electron-updater/out/NsisUpdater') return { NsisUpdater: NsisFixture };
      return require(id);
    }
  });
  const updater = new module.exports.XwXDeckUpdater(); await updater.start();
  return { updater, opened, environment };
}
try {
  for (const platform of ['darwin', 'win32']) {
    const userData = path.join(fixture, platform);
    const { updater, opened, environment } = await load(platform, userData);
    updater.scheduleStartupCheck(30);
    const check = updater.checkForUpdates();
    const initialReads = artifactReads;
    const [downloaded] = await Promise.all([updater.downloadUpdate(), updater.downloadUpdate(), check]);
    assert.equal(artifactReads - initialReads, 1, 'concurrent clicks during a check download once');
    assert.equal(downloaded.status, 'ready');
    await new Promise(resolve => setTimeout(resolve, 45));
    assert.equal(updater.state().status, 'ready', 'startup timer cannot erase a manual download');
    await updater.preflightInstall();
    if (platform === 'darwin') {
      updater.markInstalling(); await updater.quitAndInstall(); assert.equal(opened.length, 1);
      const marker = JSON.parse(await readFile(path.join(userData, 'updates', 'pending-mac-dmg.json'), 'utf8'));
      assert.equal(marker.version, '0.2.0');
      assert.equal(marker.artifact.sha256, sha256, 'opened DMG is recorded for verified post-install cleanup');
    }
    version = '0.3.0'; await assert.rejects(updater.preflightInstall(), /版本已变化/); version = '0.2.0';
    environment.XWX_DECK_UPDATE_SERVER_URL = `${rootUrl}/changed`;
    await assert.rejects(updater.preflightInstall(), /更新源已更改/); environment.XWX_DECK_UPDATE_SERVER_URL = rootUrl;
    const downloadedPath = platform === 'darwin' ? path.join(userData, 'updates', names[0]) : path.join(userData, 'download.exe');
    await writeFile(downloadedPath, 'tamper'); await assert.rejects(updater.preflightInstall(), /SHA-256/);
    await updater.discardDownloadedUpdate();
    assert.equal((await load(platform, userData)).updater.declinedVersion(), '0.2.0', 'decline survives restart');
    await updater.checkForUpdates();
    slow = true; const count = artifactReads; const inFlight = updater.downloadUpdate();
    while (artifactReads === count) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await updater.checkForUpdates()).status, 'downloading', 'checking cannot replace an in-flight download');
    await Promise.all([updater.discardDownloadedUpdate(), updater.discardDownloadedUpdate()]); await inFlight; slow = false;
    assert.equal(updater.state().status, 'available');
    if (platform === 'darwin') assert.ok(!(await readdir(path.join(userData, 'updates'))).some(name => name.includes('.download-')));
    const resumed = await updater.downloadUpdate(); assert.equal(resumed.status, 'ready');
    assert.equal((await load(platform, userData)).updater.declinedVersion(), undefined, 'explicit retry clears decline');
    await updater.discardDownloadedUpdate();
    await updater.checkForUpdates(true, true);
    assert.equal((await updater.downloadUpdate(true)).background, true, 'nightly state stays quiet');
    await updater.discardDownloadedUpdate();
    console.log(`PASS ${platform}: actual HTTP download, integrity/preflight, cancellation, source/version pinning, persistent decline, startup race, background state`);
  }
  const releaseDir = path.join(fixture, 'release'); await mkdir(releaseDir);
  for (const name of names) await writeFile(path.join(releaseDir, name), bytes);
  const releaseVersion = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  execFileSync(process.execPath, ['tools/write-public-release-manifest.mjs', releaseDir], {
    cwd: root, env: { ...process.env, RELEASE_VERSION: releaseVersion, RELEASE_TAG: `v${releaseVersion}`, GITHUB_REPOSITORY: 'Damue01/XwX_Deck' }
  });
  const published = JSON.parse(await readFile(path.join(releaseDir, 'release.json'), 'utf8'));
  const feed = parse(await readFile(path.join(releaseDir, 'latest.yml'), 'utf8'));
  assert.equal(published.files.length, 2);
  assert.equal(feed.files[0].url, `https://github.com/Damue01/XwX_Deck/releases/download/v${releaseVersion}/XwX-Deck-windows-x64.exe`);
  assert.ok(published.changelog.includes(`## [${releaseVersion}]`), 'release uses the actual version changelog');
  assert.equal(feed.files[0].sha512, sha512);
  assert.equal(published.files[0].sha256, sha256);
  assert.ok(!(await readdir(releaseDir)).some(name => /zip$|latest-mac/.test(name)));
  console.log('PASS release manifests: immutable Windows URL, matching hashes, DMG-only Mac distribution');
  const { updater } = await load('darwin', path.join(fixture, 'failure'));
  status = 503; assert.equal((await updater.checkForUpdates()).status, 'error'); status = 200;
  await updater.checkForUpdates(); tampered = true;
  const bad = await updater.downloadUpdate(); assert.equal(bad.status, 'error'); assert.match(bad.error, /完整性校验失败/);
  assert.ok(!(await readdir(path.join(fixture, 'failure', 'updates'))).some(name => name.endsWith('.dmg')));
  console.log('PASS failed checks never report up-to-date; corrupt DMG is discarded');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(fixture, { recursive: true, force: true });
}
