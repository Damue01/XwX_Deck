import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await mkdtemp(path.join(tmpdir(), 'xwx-mac-installer-cleanup-'));
const realRequire = createRequire(import.meta.url);
const userData = path.join(fixture, 'user-data');
const downloads = path.join(fixture, 'Downloads');
const mountedAt = path.join(fixture, 'mounted');
const downloadedDmg = path.join(downloads, 'XwX-Deck-mac-arm64.dmg');
const updateDmg = path.join(userData, 'updates', 'XwX-Deck-mac-arm64.dmg');
const localDmg = path.join(fixture, 'release', 'XwX-Deck-mac-arm64.dmg');
const installedAsar = path.join(fixture, 'Applications', 'XwX Deck.app', 'Contents', 'Resources', 'app.asar');
const mountedAsar = path.join(mountedAt, 'XwX Deck.app', 'Contents', 'Resources', 'app.asar');
let mountedImage = downloadedDmg;
let reportedMount = mountedAt;
let detached = [];
let trashed = [];
let mountedVersion = '1.2.3';

function fakeExecFile(command, args, options, callback) {
  if (command !== '/usr/bin/plutil') throw new Error(`Unexpected direct command: ${command}`);
  queueMicrotask(() => callback(null, JSON.stringify({ images: [{
    'image-path': mountedImage,
    'system-entities': [{ 'mount-point': reportedMount }]
  }] }), ''));
  return { stdin: { end() {} } };
}
fakeExecFile[promisify.custom] = async (command, args) => {
  if (command === '/usr/bin/hdiutil' && args[0] === 'info') return { stdout: 'fixture plist', stderr: '' };
  if (command === '/usr/bin/hdiutil' && args[0] === 'detach') {
    detached.push(args[1]);
    return { stdout: '', stderr: '' };
  }
  if (command === '/usr/libexec/PlistBuddy') {
    return { stdout: args[1].includes('CFBundleIdentifier')
      ? 'app.xwxdeck.desktop\n' : `${mountedVersion}\n`, stderr: '' };
  }
  throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
};

const output = await build({
  entryPoints: [path.join(root, 'src/main/update/macInstallerCleanup.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['electron']
});
const module = { exports: {} };
const fakeProcess = {
  platform: 'darwin', arch: 'arm64', pid: 1234,
  execPath: path.join(fixture, 'Applications', 'XwX Deck.app', 'Contents', 'MacOS', 'XwX Deck')
};
const fakeElectron = {
  app: {
    isPackaged: true,
    getVersion: () => '1.2.3',
    getPath: name => ({ downloads, home: fixture })[name]
  },
  shell: { trashItem: async file => { trashed.push(file); } }
};
const requireFake = name => {
  if (name === 'electron') return fakeElectron;
  if (name === 'child_process') return { execFile: fakeExecFile };
  return realRequire(name);
};
new Function('require', 'module', 'exports', 'process', output.outputFiles[0].text)(
  requireFake, module, module.exports, fakeProcess
);
const { cleanupMacInstallerAfterLaunch, rememberOpenedMacDmg, runningMacInstallerMount } = module.exports;

try {
  await mkdir(downloads);
  await mkdir(path.dirname(installedAsar), { recursive: true });
  await mkdir(path.dirname(mountedAsar), { recursive: true });
  await writeFile(installedAsar, 'matching-app');
  await writeFile(mountedAsar, 'matching-app');
  const mountedExecutable = path.join(mountedAt, 'XwX Deck.app', 'Contents', 'MacOS', 'XwX Deck');
  await mkdir(path.dirname(mountedExecutable), { recursive: true });
  await writeFile(mountedExecutable, 'fixture-executable');
  assert.equal(await runningMacInstallerMount(), undefined, 'installed copy must not look like a DMG process');
  fakeProcess.execPath = mountedExecutable;
  reportedMount = await realpath(mountedAt);
  assert.equal(await runningMacInstallerMount(), reportedMount,
    'running from DMG must be detected even when hdiutil canonicalizes /var to /private/var');
  reportedMount = mountedAt;
  fakeProcess.execPath = path.join(fixture, 'Applications', 'XwX Deck.app', 'Contents', 'MacOS', 'XwX Deck');
  await writeFile(downloadedDmg, 'first-install');
  await cleanupMacInstallerAfterLaunch(userData);
  assert.deepEqual(detached, [mountedAt]);
  assert.deepEqual(trashed, [downloadedDmg]);

  detached = [];
  trashed = [];
  mountedImage = localDmg;
  await mkdir(path.dirname(localDmg));
  await writeFile(localDmg, 'local-build');
  await cleanupMacInstallerAfterLaunch(userData);
  assert.deepEqual(detached, [mountedAt], 'a same-version local build should eject when its app matches');
  assert.deepEqual(trashed, [], 'a local build artifact must stay in release');

  detached = [];
  await writeFile(mountedAsar, 'different-app');
  await cleanupMacInstallerAfterLaunch(userData);
  assert.deepEqual(detached, [], 'a different same-version build must not be ejected');
  await writeFile(mountedAsar, 'matching-app');

  mountedImage = updateDmg;
  await mkdir(path.dirname(updateDmg), { recursive: true });
  await writeFile(updateDmg, 'verified-update');
  const artifact = {
    name: path.basename(updateDmg), size: Buffer.byteLength('verified-update'),
    sha256: createHash('sha256').update('verified-update').digest('hex')
  };
  await rememberOpenedMacDmg(userData, '1.2.3', artifact);
  await cleanupMacInstallerAfterLaunch(userData);
  assert.deepEqual(detached, [mountedAt]);
  assert.deepEqual(trashed, [updateDmg]);

  detached = [];
  trashed = [];
  await rememberOpenedMacDmg(userData, '1.2.4', artifact);
  await cleanupMacInstallerAfterLaunch(userData);
  assert.deepEqual(detached, [], 'an older installed app must leave the newer mounted update alone');
  assert.deepEqual(trashed, [], 'an older installed app must not clean a newer update');
  await rememberOpenedMacDmg(userData, '1.2.3', { ...artifact, sha256: '0'.repeat(64) });
  await cleanupMacInstallerAfterLaunch(userData);
  assert.deepEqual(detached, [mountedAt], 'a matching installed copy may be ejected without trusting the marker');
  assert.deepEqual(trashed, [], 'an unverified installer must not be trashed');
  console.log('PASS macOS DMG cleanup: Downloads, same-version local build, payload mismatch and verified update');
} finally {
  await rm(fixture, { recursive: true, force: true });
}
