import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') {
  throw new Error('generate-macos-app-icon.mjs must run on macOS because it uses sips and iconutil.');
}

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'assets', 'icon.svg');
const temp = await mkdtemp(path.join(os.tmpdir(), 'xwx_deck-app-icon-'));
const base = path.join(temp, 'icon-1024.png');
const runtimeSvg = path.join(temp, 'icon-runtime.svg');
const runtimeBase = path.join(temp, 'icon-runtime-1024.png');
const traySvg = path.join(temp, 'icon-tray.svg');
const trayBase = path.join(temp, 'icon-tray-1024.png');
const iconset = path.join(temp, 'XwX Deck.iconset');

try {
  run('/usr/bin/sips', ['-s', 'format', 'png', source, '--out', base]);
  const sourceSvg = await readFile(source, 'utf8');
  const roundedSvg = sourceSvg.replace(
    '<rect x="24" y="24" width="976" height="976" rx="176" fill="#000000"/>',
    '<rect x="96" y="96" width="832" height="832" rx="184" fill="#000000"/>'
  ).replace(
    '<g fill="none" stroke="#ffffff" stroke-linecap="round" stroke-linejoin="round">',
    '<g transform="translate(92.16 92.16) scale(0.82)" fill="none" stroke="#ffffff" stroke-linecap="round" stroke-linejoin="round">'
  );
  if (!roundedSvg.includes('transform="translate(92.16 92.16) scale(0.82)"')) {
    throw new Error('Unable to create the optically sized macOS icon from assets/icon.svg.');
  }
  const mark = sourceSvg.match(/<g fill="none"[\s\S]*?<\/g>/)?.[0];
  if (!mark) throw new Error('Unable to extract the XwX mark from assets/icon.svg.');
  const trayMark = mark
    .replace('stroke="#ffffff"', 'stroke="#000000"')
    .replaceAll('stroke-width="30"', 'stroke-width="52"')
    .replace('stroke-width="27"', 'stroke-width="48"');
  const trayArtwork = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="130 300 764 424">',
    trayMark,
    '</svg>',
    ''
  ].join('\n');
  await writeFile(runtimeSvg, roundedSvg, 'utf8');
  await writeFile(traySvg, trayArtwork, 'utf8');
  run('/usr/bin/sips', ['-s', 'format', 'png', runtimeSvg, '--out', runtimeBase]);
  run('/usr/bin/sips', ['-s', 'format', 'png', traySvg, '--out', trayBase]);
  await mkdir(iconset, { recursive: true });
  const frames = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024]
  ];
  for (const [name, size] of frames) {
    run('/usr/bin/sips', ['-z', String(size), String(size), runtimeBase, '--out', path.join(iconset, name)]);
  }
  run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(root, 'assets', 'icon.icns')]);
  run('/usr/bin/sips', ['-z', '256', '256', base, '--out', path.join(root, 'assets', 'icon.png')]);
  run('/usr/bin/sips', ['-z', '256', '256', runtimeBase, '--out', path.join(root, 'assets', 'icon-runtime.png')]);
  run('/usr/bin/sips', ['-z', '18', '18', trayBase, '--out', path.join(root, 'assets', 'trayTemplate.png')]);
  run('/usr/bin/sips', ['-z', '36', '36', trayBase, '--out', path.join(root, 'assets', 'trayTemplate@2x.png')]);
  run('/usr/bin/sips', ['-z', '1254', '1254', base, '--out', path.join(root, 'design', 'icon-master-black.png')]);
  run('/usr/bin/sips', ['-z', '32', '32', runtimeBase, '--out', path.join(root, 'design', 'icon-preview-32.png')]);
  const sourceSha256 = createHash('sha256').update(normalizeTextForHash(sourceSvg)).digest('hex');
  await writeFile(
    path.join(root, 'design', 'icon-master-black.source.sha256'),
    `${sourceSha256}  assets/icon.svg\n`,
    'utf8'
  );
  console.log('[app-icon] generated Dock, runtime and menu-bar icons from the same XwX assets/icon.svg mark');
} finally {
  await rm(temp, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
}

function normalizeTextForHash(value) {
  return value.replace(/\r\n?/g, '\n');
}
