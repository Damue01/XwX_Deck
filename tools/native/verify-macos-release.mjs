import assert from 'node:assert/strict';
import { readFile, mkdtemp, realpath, rm, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { appleTool, appleReleaseConfig } from './macos-signing.mjs';
import { sourceFingerprint } from './source-fingerprint.mjs';
import { assertPublicBinary } from './public-binary-boundary.mjs';

export async function verifyMacRelease(root = resolve('.')) {
  assert.equal(process.platform, 'darwin');
  const output = resolve(root, 'release-native');
  const report = JSON.parse(await readFile(join(output, 'native-build-report.json'), 'utf8'));
  const apple = await appleReleaseConfig(root);
  const { app, dmg, binary } = report.candidate;
  await assertPublicBinary(binary, root);
  await assertPublicBinary(join(app, 'Contents/Helpers/update-helper'), root);
  const checks = [];
  const check = (name, value) => { assert.ok(value, name); checks.push(name); };
  const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
  const plist = (directory, key) => appleTool('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, join(directory, 'Contents/Info.plist')]);
  const verifyApp = async directory => {
    await appleTool('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', `=anchor apple generic and identifier "app.xwxdeck.desktop" and certificate leaf[subject.OU] = "${apple.teamId}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`, directory]);
    assert.equal(await plist(directory, 'CFBundleShortVersionString'), report.version);
    await appleTool('/usr/bin/xcrun', ['stapler', 'validate', directory]);
    await appleTool('/usr/sbin/spctl', ['--assess', '--type', 'execute', directory]);
  };
  check('candidate is signed, notarized and local only', report.signed === 'developer-id' && report.notarized && !report.published && !report.installed && !report.dirty);
  check('source fingerprint matches current checkout', report.sourceFingerprint === (await sourceFingerprint(root)).sha256);
  check('app and DMG Apple submissions accepted', report.notarization.app.status === 'Accepted' && report.notarization.dmg.status === 'Accepted');
  check('binary and final stapled DMG match build hashes', await sha(binary) === report.candidate.binarySha256 && await sha(dmg) === report.candidate.dmgSha256);
  check('hardened runtime recorded', /flags=.*runtime/.test(report.candidate.signature));
  await verifyApp(app); checks.push('Developer ID team, bundle, app version, stapled ticket and Gatekeeper verified');
  await appleTool('/usr/bin/codesign', ['--verify', '--strict', '-R', `=anchor apple generic and certificate leaf[subject.OU] = "${apple.teamId}"`, dmg]);
  await appleTool('/usr/bin/xcrun', ['stapler', 'validate', dmg]);
  await appleTool('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', dmg]);
  await appleTool('/usr/bin/hdiutil', ['verify', dmg]); checks.push('DMG signature, stapled ticket, Gatekeeper and image integrity verified');
  const mount = await mkdtemp(join(await realpath(tmpdir()), 'xwx-signed-mount-'));
  let attached = false;
  try {
    await appleTool('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]); attached = true;
    const apps = (await readdir(mount)).filter(name => name.endsWith('.app')); assert.equal(apps.length, 1);
    const mounted = join(mount, apps[0]); await verifyApp(mounted);
    for (const file of report.candidate.appManifest) assert.equal(await sha(join(mounted, file.path)), file.sha256, file.path);
    checks.push('mounted payload matches signed app file manifest');
  } finally {
    if (attached) await appleTool('/usr/bin/hdiutil', ['detach', mount]);
    await rm(mount, { recursive: true, force: true });
  }
  const result = { passed: true, commit: report.commit, version: report.version, dmgSha256: report.candidate.dmgSha256, checks, published: false, normalInstallationModified: false };
  await writeFile(join(output, 'macos-signing-verification.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1] === import.meta.filename) console.log(JSON.stringify(await verifyMacRelease(), null, 2));
