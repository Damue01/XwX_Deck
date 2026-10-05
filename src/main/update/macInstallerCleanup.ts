import { app, shell } from 'electron';
import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { log } from '../shared/logger';
import { errorMessage } from '../shared/error';
import { isVersionNewer, type PublishedArtifact } from './manualMacUpdate';

const runFile = promisify(execFile);
const MARKER_NAME = 'pending-mac-dmg.json';

interface PendingMacDmg {
  version: string;
  artifact: PublishedArtifact;
}

interface MountedImage {
  'image-path'?: string;
  'system-entities'?: Array<{ 'mount-point'?: string }>;
}

export async function rememberOpenedMacDmg(userDataDir: string, version: string,
                                            artifact: PublishedArtifact): Promise<void> {
  if (process.platform !== 'darwin') return;
  const marker = markerPath(userDataDir);
  const temporary = `${marker}.${process.pid}.tmp`;
  await fs.promises.mkdir(path.dirname(marker), { recursive: true });
  await fs.promises.writeFile(temporary, JSON.stringify({ version, artifact } satisfies PendingMacDmg), 'utf8');
  await fs.promises.rename(temporary, marker);
}

/** A running App inside a DMG keeps that volume busy until this process exits. */
export async function runningMacInstallerMount(): Promise<string | undefined> {
  if (process.platform !== 'darwin' || !app.isPackaged) return undefined;
  const suffix = path.join('XwX Deck.app', 'Contents', 'MacOS', 'XwX Deck');
  const images = await mountedImages();
  const runningExecutable = await fs.promises.realpath(process.execPath).catch(() => process.execPath);
  for (const image of images) {
    for (const entity of image['system-entities'] ?? []) {
      const mount = entity['mount-point'];
      if (typeof mount !== 'string') continue;
      const mountedExecutable = path.join(mount, suffix);
      const canonicalExecutable = await fs.promises.realpath(mountedExecutable).catch(() => mountedExecutable);
      if (runningExecutable === canonicalExecutable) return mount;
    }
  }
  return undefined;
}

/**
 * A DMG has no Finder copy-complete callback. This separate system process
 * waits for a changed, fully copied Applications bundle before ejecting; it
 * does not keep the image busy while the mounted app exits.
 */
export function ejectMacInstallerAfterFinderCopy(mount: string): void {
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  const source = path.join(mount, 'XwX Deck.app');
  const targets = [
    path.join('/Applications', 'XwX Deck.app'),
    path.join(app.getPath('home'), 'Applications', 'XwX Deck.app')
  ];
  const script = `
source=$1; mount=$2; parent_pid=$3; shift 3
fingerprint() {
  /usr/bin/stat -f '%i:%c' "$1" 2>/dev/null || true
  /usr/bin/stat -f '%i:%c' "$1/Contents/Resources/app.asar" 2>/dev/null || true
}
before_one=$(fingerprint "$1")
before_two=$(fingerprint "$2")
for ((attempt=0; attempt<300; attempt++)); do
  /bin/kill -0 "$parent_pid" 2>/dev/null && { /bin/sleep 1; continue; }
  index=0
  for target in "$@"; do
    index=$((index+1))
    before=$before_one
    [ "$index" -eq 2 ] && before=$before_two
    now=$(fingerprint "$target")
    [ -n "$now" ] && [ "$now" != "$before" ] && \
      /usr/bin/cmp -s "$source/Contents/Resources/app.asar" "$target/Contents/Resources/app.asar" && \
      /usr/bin/codesign --verify --deep --strict "$target" >/dev/null 2>&1 || continue
    /bin/sleep 2
    [ "$(fingerprint "$target")" = "$now" ] && \
      /usr/bin/codesign --verify --deep --strict "$target" >/dev/null 2>&1 || continue
    /usr/bin/hdiutil detach "$mount" >/dev/null 2>&1 && exit 0
  done
  /bin/sleep 1
done
exit 1
`;
  const child = spawn('/bin/bash', ['-c', script, 'mac-installer-eject', source, mount,
    String(process.pid), ...targets], {
    detached: true,
    cwd: os.tmpdir(),
    stdio: 'ignore'
  });
  child.on('error', error => log.warn(`[mac-install] could not start eject watcher: ${errorMessage(error)}`));
  child.unref();
  log.info(`[mac-install] watching Finder copy before ejecting ${mount}`);
}

/** A launched installed copy provides a second, independent cleanup path. */
export async function cleanupMacInstallerAfterLaunch(userDataDir: string): Promise<void> {
  if (process.platform !== 'darwin' || !app.isPackaged || !isInstalledApp(process.execPath)) return;
  const marker = markerPath(userDataDir);
  const pending = await readPending(marker);
  const mounts = await mountedImages();
  const candidates: Array<{ imagePath: string; mounts: string[]; pending: boolean }> = [];
  if (pending && !isVersionNewer(pending.version, app.getVersion())) {
    const imagePath = path.join(userDataDir, 'updates', pending.artifact.name);
    if (await fileMatches(imagePath, pending.artifact)) {
      const matchingMounts = await matchingInstalledMounts(mountsFor(mounts, imagePath));
      if (matchingMounts.length) candidates.push({ imagePath, mounts: matchingMounts, pending: true });
    } else if (!await exists(imagePath)) {
      await fs.promises.rm(marker, { force: true });
    }
  }

  // Finder can open the same image from Downloads, a renamed file, or a local
  // build directory. Eject only when its actual app payload matches the copy
  // now running from Applications; trash only the standard Downloads image.
  const downloadImage = path.join(app.getPath('downloads'), `XwX-Deck-mac-${process.arch}.dmg`);
  for (const image of mounts) {
    const imagePath = image?.['image-path'];
    if (typeof imagePath !== 'string' || candidates.some(candidate => candidate.imagePath === imagePath)) continue;
    if (pending && isVersionNewer(pending.version, app.getVersion())
        && imagePath === path.join(userDataDir, 'updates', pending.artifact.name)) continue;
    const matchingMounts = await matchingInstalledMounts(mountsFor(mounts, imagePath));
    if (matchingMounts.length) {
      candidates.push({ imagePath, mounts: matchingMounts, pending: false });
    }
  }

  for (const candidate of candidates) {
    try {
      for (const mount of candidate.mounts) {
        await runFile('/usr/bin/hdiutil', ['detach', mount], { timeout: 15_000 });
      }
      if ((candidate.pending || candidate.imagePath === downloadImage)
          && await exists(candidate.imagePath)) {
        await shell.trashItem(candidate.imagePath);
        log.info(`[mac-install] moved installed DMG to Trash: ${candidate.imagePath}`);
      }
      if (candidate.pending) await fs.promises.rm(marker, { force: true });
    } catch (error) {
      log.warn(`[mac-install] could not clean installer ${candidate.imagePath}: ${errorMessage(error)}`);
    }
  }
}

function isInstalledApp(executable: string): boolean {
  const suffix = path.join('XwX Deck.app', 'Contents', 'MacOS', 'XwX Deck');
  return executable === path.join('/Applications', suffix)
    || executable === path.join(app.getPath('home'), 'Applications', suffix);
}

function markerPath(userDataDir: string): string {
  return path.join(userDataDir, 'updates', MARKER_NAME);
}

async function readPending(marker: string): Promise<PendingMacDmg | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.promises.readFile(marker, 'utf8'));
    if (!value || typeof value !== 'object') return undefined;
    const pending = value as Partial<PendingMacDmg>;
    const artifact = pending.artifact;
    if (typeof pending.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pending.version)
        || !artifact || artifact.name !== `XwX-Deck-mac-${process.arch}.dmg`
        || !Number.isSafeInteger(artifact.size) || artifact.size < 1
        || !/^[0-9a-f]{64}$/i.test(artifact.sha256)) return undefined;
    return pending as PendingMacDmg;
  } catch {
    return undefined;
  }
}

async function mountedImages(): Promise<MountedImage[]> {
  const { stdout } = await runFile('/usr/bin/hdiutil', ['info', '-plist'],
    { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  const converted = await new Promise<string>((resolve, reject) => {
    const child = execFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'],
      { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (error, json) => {
        if (error) reject(error);
        else resolve(json);
      });
    child.stdin?.end(stdout);
  });
  const value: unknown = JSON.parse(converted);
  if (!value || typeof value !== 'object') throw new Error('Invalid mounted disk image list.');
  const images = (value as { images?: unknown }).images;
  if (!Array.isArray(images)) throw new Error('Mounted disk image list is missing images.');
  return images as MountedImage[];
}

function mountsFor(images: MountedImage[], imagePath: string): string[] {
  return images.filter(image => image?.['image-path'] === imagePath)
    .flatMap(image => image['system-entities'] ?? [])
    .map(entity => entity['mount-point'])
    .filter((mount): mount is string => typeof mount === 'string' && mount.startsWith('/'));
}

async function matchingInstalledMounts(mounts: string[]): Promise<string[]> {
  const matches: string[] = [];
  for (const mount of mounts) {
    if (await mountedCopyMatches(mount, app.getVersion())) matches.push(mount);
  }
  return matches;
}

async function mountedCopyMatches(mount: string, version: string): Promise<boolean> {
  try {
    const plist = path.join(mount, 'XwX Deck.app', 'Contents', 'Info.plist');
    const [bundleId, bundleVersion] = await Promise.all([
      runFile('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist], { timeout: 5_000 }),
      runFile('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], { timeout: 5_000 })
    ]);
    if (bundleId.stdout.trim() !== 'app.xwxdeck.desktop'
        || bundleVersion.stdout.trim() !== version) return false;
    const installedAsar = path.join(path.dirname(process.execPath), '..', 'Resources', 'app.asar');
    const mountedAsar = path.join(mount, 'XwX Deck.app', 'Contents', 'Resources', 'app.asar');
    return await sameFileContents(installedAsar, mountedAsar);
  } catch {
    return false;
  }
}

async function sameFileContents(left: string, right: string): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([fs.promises.stat(left), fs.promises.stat(right)]);
  if (!leftStat.isFile() || !rightStat.isFile() || leftStat.size !== rightStat.size) return false;
  const digest = async (filePath: string): Promise<string> => {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex');
  };
  return await digest(left) === await digest(right);
}

async function fileMatches(filePath: string, artifact: PublishedArtifact): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size !== artifact.size) return false;
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex') === artifact.sha256.toLowerCase();
  } catch {
    return false;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}
