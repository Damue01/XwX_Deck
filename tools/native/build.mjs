import { cp, mkdir, writeFile, symlink, readFile, lstat, readdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const pilot = import.meta.dirname;
const requiredArch = process.argv.find(a=>a.startsWith("--require-arch="))?.split("=")[1];
if (requiredArch && process.arch !== requiredArch) throw new Error(`Build requires a native ${requiredArch} host.`);
const isolated = process.argv.includes('--pilot');
const productName = isolated ? 'XwX Deck Rust Pilot' : 'XwX Deck';
const appId = isolated ? 'app.xwxdeck.rustpilot' : 'app.xwxdeck.desktop';
const root = resolve(pilot, '../..');
const packageJson=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
const version=packageJson.version;
const localTools = resolve(root, 'test-results/rust-toolchain');
const localCargo = resolve(localTools, 'cargo/bin/cargo');
const env = { ...process.env };
env.XWX_NATIVE_PILOT = isolated ? '1' : '0';
env.CARGO_TARGET_DIR = resolve(root, 'test-results/native-target');
env.TAURI_CONFIG = JSON.stringify({ productName, version, identifier: appId, app: { windows: [{ label:'main', title:'XwX Deck', width:1040, height:560, minWidth:780, minHeight:480, decorations: process.platform === 'darwin', backgroundColor:'#f5f5f7', ...(process.platform === 'darwin' ? { titleBarStyle:'Visible' } : {}) }] } });
if (existsSync(localCargo) && !env.RUSTUP_HOME && !env.CARGO_HOME) {
  env.RUSTUP_HOME = resolve(localTools, 'rustup');
  env.CARGO_HOME = resolve(localTools, 'cargo');
}
const cargo = existsSync(localCargo) && env.CARGO_HOME === resolve(localTools, 'cargo') ? localCargo : 'cargo';
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status) process.exit(result.status);
}
run(process.execPath, [resolve(pilot, 'prepare.mjs')]);
const metadataRun=spawnSync(cargo,['metadata','--locked','--format-version','1','--filter-platform',process.platform==='win32'?'x86_64-pc-windows-msvc':process.arch==='arm64'?'aarch64-apple-darwin':'x86_64-apple-darwin','--manifest-path',resolve(root,'src-native/Cargo.toml')],{cwd:root,env,encoding:'utf8',maxBuffer:32*1024*1024});
if(metadataRun.status) throw new Error(metadataRun.stderr);
const metadata=JSON.parse(metadataRun.stdout);const resolved=new Set(metadata.resolve.nodes.map(n=>n.id));const licenseTexts=await Promise.all(['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','docs/licenses/magpie-MIT.txt','docs/licenses/magpie-community-MIT.txt'].map(name=>readFile(resolve(root,name),'utf8')));
const notices=[];
for(const pkg of metadata.packages.filter(p=>resolved.has(p.id)&&p.source)){
  notices.push(`${pkg.name} ${pkg.version} — ${pkg.license??'see license file'} — ${pkg.repository??''}`);
  const directory=resolve(pkg.manifest_path,'..');const names=await readdir(directory);
  for(const name of names.filter(n=>/^(LICENSE|LICENCE|COPYING|NOTICE)([._-]|$)/i.test(n))){const source=join(directory,name);if((await lstat(source)).isFile()) licenseTexts.push(`\n===== ${pkg.name} ${pkg.version} / ${name} =====\n`+await readFile(source,'utf8'));}
}
const frontendPackages=new Set();const pending=['react','react-dom','lucide-react','@base-ui/react','clsx','tailwind-merge','class-variance-authority','@fontsource-variable/geist-mono','tailwindcss'];
while(pending.length){const name=pending.pop();if(frontendPackages.has(name))continue;frontendPackages.add(name);const directory=resolve(root,'node_modules',name);if(!existsSync(join(directory,'package.json')))continue;const pkg=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));notices.push(`${pkg.name} ${pkg.version} — ${typeof pkg.license==='string'?pkg.license:JSON.stringify(pkg.license??'see license file')}`);pending.push(...Object.keys(pkg.dependencies??{}));for(const name of (await readdir(directory)).filter(n=>/^(LICENSE|LICENCE|COPYING|NOTICE|OFL)([._-]|$)/i.test(n))){const file=join(directory,name);if((await lstat(file)).isFile())licenseTexts.push(`\n===== ${pkg.name} ${pkg.version} / ${name} =====\n`+await readFile(file,'utf8'));}}
const licenseBody=(notices.sort().join('\n')+'\n\n'+licenseTexts.join('\n')).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
await writeFile(resolve(root,'test-results/native-frontend/licenses.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>XwX Deck 开源许可证</title><style>body{font:14px system-ui;margin:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5}</style><h1>开源许可证</h1><pre>'+licenseBody+'</pre></html>');
run(cargo, ['build', '--locked', '--release', '--manifest-path', resolve(root, 'src-native/Cargo.toml')]);
if (process.platform !== 'darwin') {
  if (process.platform === 'win32') {
    const destination = resolve(root, isolated ? 'test-results/native-package' : 'release', 'XwX Deck.exe');
    await mkdir(resolve(destination, '..'), { recursive:true });
    await cp(resolve(env.CARGO_TARGET_DIR, 'release/xwx-deck-native.exe'), destination);
    console.log(`Native portable executable: ${destination}`);
  } else console.log('Rust binary compiled.');
  process.exit(0);
}
const output = resolve(root, isolated ? 'test-results/rust-pilot-package' : 'release-native');
const app = resolve(output, `${productName}.app`);
await rm(app,{recursive:true,force:true});
await mkdir(resolve(app, 'Contents/MacOS'), { recursive: true });
await mkdir(resolve(app, 'Contents/Resources'), { recursive: true });
await cp(resolve(env.CARGO_TARGET_DIR, 'release/xwx-deck-native'), resolve(app, 'Contents/MacOS/xwx-deck-native'));
await cp(resolve(root, 'assets/icon.icns'), resolve(app, 'Contents/Resources/icon.icns'));
await writeFile(resolve(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>xwx-deck-native</string>
<key>CFBundleIdentifier</key><string>${appId}</string>
<key>CFBundleName</key><string>${productName}</string>
<key>CFBundleDisplayName</key><string>${productName}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>`);
await writeFile(resolve(app,'Contents/Resources/RUST_DEPENDENCIES.txt'),notices.sort().join('\n')+'\n');
for (const name of ['LICENSE','NOTICE','THIRD_PARTY_NOTICES.md']) await cp(resolve(root,name),resolve(app,'Contents/Resources',name));
run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
const dmg = resolve(output, isolated ? 'XwX-Deck-Rust-Pilot-arm64.dmg' : `XwX-Deck-mac-${process.arch}.dmg`);
const compressionDirectory = await mkdtemp(join(await realpath(tmpdir()), 'xwx-rust-pilot-compression-'));
const staging=join(compressionDirectory,'volume');await mkdir(staging);await cp(app,join(staging,`${productName}.app`),{recursive:true});await symlink('/Applications',join(staging,'Applications'));await cp(resolve(root,'assets/macos/首次打开说明.txt'),join(staging,'首次打开说明.txt'));
const compression = [];
for (const format of ['UDZO', 'UDBZ', 'ULFO']) {
  const path = join(compressionDirectory, `${format}.dmg`);
  const args = ['create', '-ov', '-format', format, '-volname', productName, '-srcfolder', staging, path];
  if (format === 'UDZO') args.push('-imagekey', 'zlib-level=9');
  const result = spawnSync('/usr/bin/hdiutil', args, { stdio: 'pipe', encoding: 'utf8' });
  if (result.status === 0) compression.push({ format, path, bytes: (await lstat(path)).size });
  else console.warn(`Compression ${format} unavailable: ${result.stderr.trim()}`);
}
compression.sort((a, b) => a.bytes - b.bytes);
if (!compression.length) throw new Error('No DMG compression format succeeded.');
await cp(compression[0].path, dmg);
await rm(compressionDirectory, { recursive: true });
run('/usr/bin/hdiutil', ['verify', dmg]);
async function size(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  let bytes = 0;
  for (const name of await readdir(path)) bytes += await size(join(path, name));
  return bytes;
}
const baselineApp = resolve(root, 'release/mac-arm64/XwX Deck.app');
const baselineDmg = resolve(root, 'release/XwX-Deck-mac-arm64.dmg');
const measurements = {
  pilot: { app, dmg, appBytes: await size(app), dmgBytes: await size(dmg), containsNode: false, containsChromium: false },
  baseline: existsSync(baselineApp) && existsSync(baselineDmg) ? { appBytes: await size(baselineApp), dmgBytes: await size(baselineDmg) } : null,
  scope: 'Rust native host and backend with the retained React pages; local candidate, independent from installed sessions.',
  compression: compression.map(({ format, bytes }) => ({ format, bytes })),
  signed: 'adhoc', notarized: false, installed: false, published: false,
};
await writeFile(resolve(output,'native-build-report.json'),JSON.stringify(measurements,null,2)+'\n');
console.log(JSON.stringify(measurements, null, 2));
