import {editionBuild} from './edition/build.mjs';
import {writeInstallGuide} from './edition/install-guide.mjs';
import { cp, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dmgBuildTool } from './dmg-tool.mjs';

// Reuse the existing build-time DMG tool and Finder layout. Nothing from this
// toolchain is included in the application or needed after installation.
export async function buildMacDmg({ root, app, dmg, productName, isolated, acceptance = false, signed = false, config }) {
  const vendor = await dmgBuildTool();
  const temporary = await mkdtemp(join(await realpath(tmpdir()), 'xwxdeck-dmg-'));
  function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error(`${command}: ${result.stderr || result.stdout}`);
  }
  try {
    const backgrounds = join(temporary, 'backgrounds');
    await mkdir(backgrounds);
    run('/usr/bin/swift', [resolve(root, editionBuild.backgroundScript), '--output-directory', backgrounds]);
    const background = join(temporary, 'background.tiff');
    run('/usr/bin/tiffutil', ['-cathidpicheck', join(backgrounds, 'dmg-background.png'), join(backgrounds, 'dmg-background@2x.png'), '-out', background]);
    const guide = join(temporary, isolated ? '验证说明.txt' : '首次打开说明.txt');
    await writeInstallGuide({root,guide,isolated,acceptance,signed});
    const contents = config.contents.filter(item => !signed || item.type === 'link' || !item.path).map(item => item.type === 'link'
      ? { ...item }
      : item.path
        ? { ...item, path: guide, name: isolated ? '验证说明.txt' : item.name }
        : { ...item, path: app, name: basename(app), type: 'file' });
    const layout = {
      title: productName, format: 'UDRW', filesystem: 'HFS+',
      background, icon: resolve(root, 'assets/icon.icns'),
      'icon-size': config.iconSize, 'text-size': config.iconTextSize,
      window: { position: { x: 180, y: 160 }, size: config.window }, contents,
    };
    const settings = join(temporary, 'settings.json');
    await writeFile(settings, JSON.stringify(layout));
    const image = join(temporary, 'layout.dmg');
    run(join(vendor, 'dmgbuild'), ['-s', settings, productName, image]);
    // Finder metadata must not contaminate the signed bundle during DMG copy.
    const mount = join(temporary, 'verify');
    await mkdir(mount);
    run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, image]);
    try {
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(mount, basename(app))]);
    } finally { run('/usr/bin/hdiutil', ['detach', mount]); }
    const compression = [];
    for (const format of ['UDZO', 'UDBZ', 'ULFO']) {
      const path = join(temporary, `${format}.dmg`);
      const args = ['convert', image, '-format', format, '-o', path];
      if (format === 'UDZO') args.push('-imagekey', 'zlib-level=9');
      try {
        run('/usr/bin/hdiutil', args);
        compression.push({ format, path, bytes: (await lstat(path)).size });
      } catch (error) { console.warn(`Compression ${format} unavailable: ${error.message}`); }
    }
    compression.sort((a, b) => a.bytes - b.bytes);
    if (!compression.length) throw Error('No DMG compression format succeeded.');
    run('/usr/bin/hdiutil', ['verify', compression[0].path]);
    await cp(compression[0].path, dmg);
    return {
      compression: compression.map(({ format, bytes }) => ({ format, bytes })),
      layout: { width: config.window.width, height: config.window.height, iconSize: config.iconSize, retinaBackground: true, contents: contents.map(({ path, ...item }) => ({ ...item, target: item.type === 'link' ? path : undefined })) },
    };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
