import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Finder layout helper only. Its pinned archive is never part of the app.
const checksums = {
  arm64: '793404d0c96687e27d5ee40a668d498c92e36a64d6c2906df511031adb33cbeb',
  x86_64: '1664972f9cc2d6e8fce3b63e42cd30078aff602669c5856939c4519921200433',
};
export async function dmgBuildTool() {
  if (process.platform !== 'darwin') throw Error('DMG layout requires macOS');
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const name = `dmgbuild-bundle-${arch}-75c8a6c.tar.gz`;
  const cache = join(homedir(), 'Library/Caches/xwxdeck-build-tools');
  const destination = join(cache, `dmgbuild-1.2.5-${arch}-${checksums[arch].slice(0, 12)}`);
  const ready = join(destination, '.archive-sha256');
  if (await readFile(ready, 'utf8').catch(() => '') === checksums[arch]) {
    await access(join(destination, 'dmgbuild')); return destination;
  }
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), 'xwx-dmg-tool-'));
  const archive = join(temporary, name);
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw Error(result.error?.message || result.stderr || `${command} failed`);
    return result.stdout;
  };
  try {
    // Reuse a verified archive from the former tool cache during migration.
    const prior = join(homedir(), 'Library/Caches/electron-builder/dmg-builder@1.2.5', name);
    try { await copyFile(prior, archive); }
    catch {
      const url = `https://github.com/electron-userland/electron-builder-binaries/releases/download/dmg-builder@1.2.5/${name}`;
      const args = ['--fail', '--location', '--retry', '2', '--connect-timeout', '20', '--max-time', '180', '--output', archive];
      if (process.env.XWX_BUILD_PROXY) args.push('--proxy', process.env.XWX_BUILD_PROXY);
      run('/usr/bin/curl', [...args, url]);
    }
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
    if (digest !== checksums[arch]) throw Error('DMG layout archive checksum mismatch');
    const entries = run('/usr/bin/tar', ['-tzf', archive]).split('\n').filter(Boolean);
    if (entries.some(entry => entry.startsWith('/') || entry.split('/').includes('..'))) throw Error('Unsafe DMG layout archive entry');
    const extracted = join(temporary, 'tool'); await mkdir(extracted);
    run('/usr/bin/tar', ['-xzf', archive, '-C', extracted]);
    await access(join(extracted, 'dmgbuild'));
    await writeFile(join(extracted, '.archive-sha256'), digest);
    await rm(destination, { recursive: true, force: true });
    await rename(extracted, destination);
    return destination;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
