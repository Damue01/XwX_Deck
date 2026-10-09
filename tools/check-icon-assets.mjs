import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const svg = await readFile(path.join(root, 'assets', 'icon.svg'), 'utf8');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const rendererHtml = await readFile(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const buildConfig = await readFile(path.join(root, 'esbuild.config.mjs'), 'utf8');
const runtime = await readFile(path.join(root, 'src', 'main', 'runtime.ts'), 'utf8');
const managerWindow = await readFile(path.join(root, 'src', 'main', 'window', 'managerWindow.ts'), 'utf8');
const viewerHtml = await readFile(path.join(root, 'src', 'main', 'trace', 'webview', 'viewerHtml.ts'), 'utf8');
const macIconGenerator = await readFile(path.join(root, 'tools', 'generate-macos-app-icon.mjs'), 'utf8');
const windowsIconGenerator = await readFile(path.join(root, 'tools', 'generate-icon-assets.ps1'), 'utf8');
const windowsIconManifestTool = await readFile(path.join(root, 'tools', 'windows-icon-assets.mjs'), 'utf8');
const windowsIconManifest = JSON.parse(await readFile(
  path.join(root, 'design', 'windows-icon-assets.json'),
  'utf8'
));
const rasterMasterSourceHash = await readFile(
  path.join(root, 'design', 'icon-master-black.source.sha256'),
  'utf8'
).catch(() => '');
const failures = [];
const sourceSha256 = createHash('sha256').update(normalizeTextForHash(svg)).digest('hex');

check(/<path\b/.test(svg), 'icon.svg must contain geometric paths');
check(!/<text\b/i.test(svg), 'icon.svg must not render XwX through a text element');
check(!/font-family|font-size|@font-face/i.test(svg), 'icon.svg must not depend on a font');
check(!/<image\b/i.test(svg), 'icon.svg must not embed a raster image');
check(/M178 420 L372 610 M372 420 L178 610/.test(svg), 'icon.svg must retain the left geometric X');
check(/M654 420 L850 610 M850 420 L654 610/.test(svg), 'icon.svg must retain the right geometric X');
check(/M439 548 L472 607 L512 554 L552 607 L585 548/.test(svg), 'icon.svg must retain the independent lowercase w');
check(packageJson.build?.win?.icon === 'assets/icon.ico', 'Windows build must use assets/icon.ico');
check(packageJson.build?.mac?.icon === 'assets/icon.icns', 'macOS build must use assets/icon.icns');
check(packageJson.scripts?.['generate:icons:mac'] === 'node tools/generate-macos-app-icon.mjs', 'macOS icon generator script mismatch');
check(packageJson.scripts?.['generate:icons:win'] === 'node tools/windows-icon-assets.mjs',
  'Windows release builds must verify committed icon assets without rewriting the worktree');
check(packageJson.scripts?.['regenerate:icons:win']?.includes('generate-icon-assets.ps1')
  && packageJson.scripts?.['regenerate:icons:win']?.includes('windows-icon-assets.mjs --write'),
  'Windows icon regeneration must explicitly refresh the locked asset manifest');
check(rendererHtml.includes('href="./icon-runtime.png"'), 'renderer favicon must use the rounded packaged geometric icon');
check(viewerHtml.includes("import xwxIconSvg from '../../../../assets/icon.svg?raw'"),
  'Trace viewer favicon must reuse the geometric XwX source');
check(viewerHtml.includes('data:image/svg+xml'), 'Trace viewer must embed its favicon without a missing /favicon.ico request');
check(!rendererHtml.includes('href="data:,"'), 'renderer must not use an empty favicon that creates an initial-letter placeholder');
check(buildConfig.includes("fs.copyFile('assets/icon-runtime.png', 'dist/renderer/icon-runtime.png')"), 'renderer build must copy the rounded window icon');
check(packageJson.scripts?.['build:mac:arm64']?.includes('npm run generate:icons:mac'), 'macOS build must regenerate icons before compile');
check(packageJson.scripts?.['build:win']?.includes('npm run generate:icons:win'),
  'Windows build must verify committed icon assets before compile');
check(runtime.includes("if (app.isPackaged)"), 'packaged macOS builds must preserve the AppKit-managed ICNS icon');
check(runtime.includes('app.dock.setIcon(image)'), 'development macOS runtime must provide an application icon');
check(runtime.includes("nativeImage.createFromPath(assetPath('icon-runtime.png'))"), 'development macOS runtime icon must use the rounded geometric icon');
check(macIconGenerator.includes('<rect x="96" y="96" width="832" height="832" rx="184" fill="#000000"/>'), 'macOS Dock icon must retain its transparent optical margin');
check(macIconGenerator.includes('transform="translate(92.16 92.16) scale(0.82)"'), 'macOS XwX mark must be uniformly scaled around the icon center');
check(macIconGenerator.includes("String(size), runtimeBase, '--out', path.join(iconset, name)"), 'macOS ICNS frames must use the optically sized runtime artwork');
check(macIconGenerator.includes('sourceSvg.match(/<g fill="none"[\\s\\S]*?<\\/g>/)'), 'menu-bar icon must extract the same geometric XwX mark from icon.svg');
check(macIconGenerator.includes("path.join(root, 'assets', 'trayTemplate.png')"), 'macOS icon generator must emit the 18pt menu-bar template');
check(macIconGenerator.includes("path.join(root, 'assets', 'trayTemplate@2x.png')"), 'macOS icon generator must emit the Retina menu-bar template');
check(
  rasterMasterSourceHash.trim() === `${sourceSha256}  assets/icon.svg`,
  'Windows raster master provenance does not match assets/icon.svg; run npm run generate:icons:mac'
);
check(
  windowsIconGenerator.includes('$normalizedVectorSource = $vectorSource.Replace("`r`n", "`n").Replace("`r", "`n")')
    && windowsIconGenerator.includes('[System.Security.Cryptography.SHA256]::Create()'),
  'Windows icon generator must verify the raster master against a line-ending-normalized assets/icon.svg'
);
check(windowsIconManifestTool.includes('PASS committed Windows icon assets match their source-locked manifest'),
  'Windows icon manifest verifier is missing');
check(windowsIconManifest.schemaVersion === 1, 'Windows icon asset manifest schemaVersion must be 1');
check(windowsIconManifest.source?.path === 'assets/icon.svg'
  && windowsIconManifest.source?.sha256 === sourceSha256,
  'Windows icon asset manifest must bind to the normalized geometric source');
const lockedWindowsAssets = [
  windowsIconManifest.rasterMaster,
  ...(Array.isArray(windowsIconManifest.outputs) ? windowsIconManifest.outputs : [])
];
for (const expectedPath of ['assets/icon.ico', 'assets/icon.png', 'assets/tray.png']) {
  const entries = Array.isArray(windowsIconManifest.outputs)
    ? windowsIconManifest.outputs.filter(item => item?.path === expectedPath)
    : [];
  check(entries.length === 1 && /^[0-9a-f]{64}$/.test(String(entries[0]?.sha256 || '')),
    `Windows icon asset manifest must contain ${expectedPath}`);
}
for (const entry of lockedWindowsAssets) {
  const bytes = entry?.path ? await readFile(path.join(root, entry.path)).catch(() => undefined) : undefined;
  const actualSha256 = bytes ? createHash('sha256').update(bytes).digest('hex') : '';
  check(actualSha256 !== '' && actualSha256 === entry?.sha256,
    `${entry?.path || 'Windows icon asset'} does not match design/windows-icon-assets.json`);
}
check(managerWindow.includes("titleBarStyle: 'default'"), 'macOS manager window must use the visible AppKit native title bar');
check(managerWindow.includes("nativeMacWindow\n        ? { frame: true"), 'macOS manager window must retain its native frame');

for (const file of [
  'assets/icon.png',
  'assets/icon-runtime.png',
  'assets/icon.ico',
  'assets/icon.icns',
  'assets/trayTemplate.png',
  'assets/trayTemplate@2x.png',
  'design/icon-master-black.png',
  'design/icon-preview-32.png'
]) {
  const fileStat = await stat(path.join(root, file)).catch(() => undefined);
  check(fileStat?.isFile() && fileStat.size > 100, `missing generated icon asset: ${file}`);
}

if (failures.length) {
  console.error('Icon contract check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('PASS icon contract: one geometric XwX source, no font or embedded raster');

function check(condition, message) {
  if (!condition) failures.push(message);
}

function normalizeTextForHash(value) {
  return value.replace(/\r\n?/g, '\n');
}
