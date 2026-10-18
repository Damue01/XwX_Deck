import { cp, mkdir, writeFile, readFile, lstat, readdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {createHash} from 'node:crypto';
import { tmpdir } from 'node:os';
import { sourceFingerprint, directoryFingerprint } from './source-fingerprint.mjs';
import { rustToolchain } from './toolchain.mjs';
import { buildMacDmg } from './macos-dmg.mjs';
import { appleReleaseConfig, appleTool, signMac, notarizeMac, notarizeApp } from './macos-signing.mjs';
import { assertPublicBinary } from './public-binary-boundary.mjs';
import { buildWindowsMsi } from './windows-msi.mjs';
import { standardWindowsArtifact } from './windows-execution-level.mjs';

const pilot = import.meta.dirname;
const requiredPlatform = process.argv.find(a => a.startsWith('--require-platform='))?.split('=')[1];
if (requiredPlatform && process.platform !== requiredPlatform) throw Error(`Build requires a native ${requiredPlatform} host.`);
const requiredArch = process.argv.find(a=>a.startsWith("--require-arch="))?.split("=")[1];
if (requiredArch && process.arch !== requiredArch) throw new Error(`Build requires a native ${requiredArch} host.`);
const isolated = process.argv.includes('--pilot');
const acceptance = process.argv.includes('--acceptance');
const signed = process.argv.includes('--signed');
if (signed && process.platform !== 'darwin') throw Error('--signed requires macOS.');
if (isolated && acceptance) throw Error('隔离验证和正常安装验收是不同的构建模式，不能同时启用。');
const readiness=JSON.parse(await readFile(resolve(pilot,'../../src-native/migration-status.json'),'utf8'));
if (!isolated && !acceptance && !readiness.productionReady) throw new Error('XwXDeck 原生迁移尚未完整验收。正式构建被阻止；用户人工验收使用 build:native:acceptance，自动化隔离验证使用 build:native:isolated。缺口：'+readiness.blockers.join('；'));
const productName = isolated ? 'XwXDeck Rust Validation' : 'XwX Deck';
const appId = isolated ? 'app.xwxdeck.validation' : 'app.xwxdeck.desktop';
const root = resolve(pilot, '../..');
const initialSource = await sourceFingerprint(root);
const initialGit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
if (initialGit.status !== 0) throw Error('无法确定原生构建来源提交。');
if (acceptance) {
  const status = spawnSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' });
  if (status.status !== 0 || status.stdout.trim()) throw Error('正常安装验收包必须从干净提交构建，请先保存当前修改。');
}
const buildMode = isolated ? 'isolated' : acceptance ? 'manual-acceptance' : 'production';
const scope = isolated ? 'Isolated validation candidate; production gate remains closed.' : acceptance
  ? 'User-requested installable manual acceptance candidate; normal application identity and data; real-environment acceptance remains pending.'
  : 'Native release candidate after migration acceptance.';
const packageJson=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
const version=packageJson.version;
const { cargo, env } = rustToolchain(root);
env.XWX_NATIVE_PILOT = isolated ? '1' : '0';
env.CARGO_TARGET_DIR = resolve(root, 'test-results/native-target');
env.TAURI_CONFIG = JSON.stringify({ productName, version, identifier: appId, app: { windows: [{ label:'main', title:'XwX Deck', width:1040, height:560, minWidth:780, minHeight:480, decorations: process.platform === 'darwin', backgroundColor:'#f5f5f7', ...(process.platform === 'darwin' ? { titleBarStyle:'Visible' } : {}) }] } });
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status) process.exit(result.status);
}
run(process.execPath, [resolve(pilot, 'prepare.mjs')]);
run(process.execPath, [resolve(pilot, 'shared-fonts-test.mjs')]);
const metadataRun=spawnSync(cargo,['metadata','--locked','--format-version','1','--filter-platform',process.platform==='win32'?'x86_64-pc-windows-msvc':process.arch==='arm64'?'aarch64-apple-darwin':'x86_64-apple-darwin','--manifest-path',resolve(root,'src-native/Cargo.toml')],{cwd:root,env,encoding:'utf8',maxBuffer:32*1024*1024});
if(metadataRun.status) throw new Error(metadataRun.stderr);
const metadata=JSON.parse(metadataRun.stdout);const resolved=new Set(metadata.resolve.nodes.map(n=>n.id));const licenseTexts=await Promise.all(['LICENSE','NOTICE','docs/licenses/third-party-notices.md','docs/licenses/magpie-MIT.txt','docs/licenses/magpie-community-MIT.txt'].map(name=>readFile(resolve(root,name),'utf8')));
const notices=[];
notices.push('Urbanist and Noto Sans SC — SIL Open Font License 1.1');
for (const name of ['urbanist-OFL.txt', 'notosanssc-OFL.txt']) licenseTexts.push('\n===== ' + name + ' =====\n' + await readFile(resolve(root, 'assets/fonts', name), 'utf8'));
for(const pkg of metadata.packages.filter(p=>resolved.has(p.id)&&p.source)){
  notices.push(`${pkg.name} ${pkg.version} — ${pkg.license??'see license file'} — ${pkg.repository??''}`);
  const directory=resolve(pkg.manifest_path,'..');const names=await readdir(directory);
  for(const name of names.filter(n=>/^(LICENSE|LICENCE|COPYING|NOTICE)([._-]|$)/i.test(n))){const source=join(directory,name);if((await lstat(source)).isFile()) licenseTexts.push(`\n===== ${pkg.name} ${pkg.version} / ${name} =====\n`+await readFile(source,'utf8'));}
}
const frontendPackages=new Set();const pending=['react','react-dom','lucide-react','@base-ui/react','clsx','tailwind-merge','class-variance-authority','@fontsource-variable/geist-mono','tailwindcss'];
while(pending.length){const name=pending.pop();if(frontendPackages.has(name))continue;frontendPackages.add(name);const directory=resolve(root,'node_modules',name);if(!existsSync(join(directory,'package.json')))continue;const pkg=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));notices.push(`${pkg.name} ${pkg.version} — ${typeof pkg.license==='string'?pkg.license:JSON.stringify(pkg.license??'see license file')}`);pending.push(...Object.keys(pkg.dependencies??{}));for(const name of (await readdir(directory)).filter(n=>/^(LICENSE|LICENCE|COPYING|NOTICE|OFL)([._-]|$)/i.test(n))){const file=join(directory,name);if((await lstat(file)).isFile())licenseTexts.push(`\n===== ${pkg.name} ${pkg.version} / ${name} =====\n`+await readFile(file,'utf8'));}}
const licenseBody=(notices.sort().join('\n')+'\n\n'+licenseTexts.join('\n')).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const editMenuSource=await readFile(resolve(root,'src/shared/edit-context-menu.browser.js'),'utf8');
await writeFile(resolve(root,'test-results/native-frontend/licenses.html'),'<!doctype html><html lang="zh-CN" data-theme="day"><meta charset="utf-8"><title>XwX Deck 开源许可证</title><link rel="stylesheet" href="./app.css"><style>body{margin:24px;overflow:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5;font:13px var(--sans)}</style><h1>开源许可证</h1><pre>'+licenseBody+'</pre><script>'+editMenuSource+'</script></html>');
const embeddedFrontendSha256 = await directoryFingerprint(resolve(root, 'test-results/native-frontend'));
const embeddedAssetsSha256 = await directoryFingerprint(resolve(root, 'test-results/native-assets'));
run(cargo, ['build', '--locked', '--release', ...(acceptance ? ['--features', 'manual-acceptance'] : []), '--manifest-path', resolve(root, 'src-native/Cargo.toml')]);
await assertPublicBinary(resolve(env.CARGO_TARGET_DIR, 'release/xwx-deck-native' + (process.platform === 'win32' ? '.exe' : '')), root);
if (embeddedFrontendSha256 !== await directoryFingerprint(resolve(root, 'test-results/native-frontend')) || embeddedAssetsSha256 !== await directoryFingerprint(resolve(root, 'test-results/native-assets'))) throw Error('原生编译期间嵌入资源发生变化，未登记候选；请重新构建。');
if (process.platform !== 'darwin') {
  if (process.platform === 'win32') {
    const destination = resolve(root, isolated ? 'test-results/native-package' : 'release', 'XwX Deck.exe');
    await mkdir(resolve(destination, '..'), { recursive:true });
    await cp(resolve(env.CARGO_TARGET_DIR, 'release/xwx-deck-native.exe'), destination);
    await standardWindowsArtifact(destination);
    const installer = isolated ? null : await buildWindowsMsi({ root, binary: destination, output: resolve(root,'release/XwX Deck.msi'), version });
    const finalSource = await sourceFingerprint(root);
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (commit.status !== 0 || initialSource.sha256 !== finalSource.sha256 || initialGit.stdout.trim() !== commit.stdout.trim()) {
      throw Error('源码在原生构建期间发生变化，未登记 Windows 候选；请重新构建。');
    }
    const branch = spawnSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' });
    const status = spawnSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' });
    if (branch.status !== 0 || status.status !== 0) throw Error('无法核对 Windows 候选来源。');
    const bytes = await readFile(destination);
    const pe = bytes.readUInt32LE(0x3c);
    if (bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0' || bytes.readUInt16LE(pe + 4) !== 0x8664) throw Error('Windows 候选不是原生 x64 PE。');
    const signature = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; (Get-AuthenticodeSignature -LiteralPath $env:XWX_NATIVE_CANDIDATE).Status.ToString()"], {
      cwd: root, env: { ...env, XWX_NATIVE_CANDIDATE: destination }, encoding: 'utf8', windowsHide: true
    });
    if (signature.status !== 0) throw Error('无法核对 Windows 候选签名。');
    const report = {
      version, branch: branch.stdout.trim(), commit: commit.stdout.trim(), dirty: Boolean(status.stdout.trim()), worktree: status.stdout.trim(),
      buildTime: new Date().toISOString(), sourceFingerprint: finalSource.sha256, sourceFileCount: finalSource.fileCount,
      embeddedFrontendSha256, embeddedAssetsSha256,
      candidate: { binary: destination, binaryBytes: bytes.length, binarySha256: createHash('sha256').update(bytes).digest('hex'), architecture: 'x86_64', bundleId: appId,
        signature: signature.stdout.trim(), integrityLabel: 'medium', externalRuntime: 'Microsoft Edge WebView2 (system installed)' },
      installer, buildMode, productionReady: readiness.productionReady, installed: false, published: false, scope
    };
    await writeFile(resolve(destination, '..', 'native-build-report.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(destination + '.sha256', report.candidate.binarySha256 + '  XwX Deck.exe\n');
    console.log(`Native portable executable: ${destination}`);
  } else console.log('Rust binary compiled.');
  process.exit(0);
}
const output = resolve(root, process.argv.find(a => a.startsWith('--output-directory='))?.slice('--output-directory='.length) ?? ( isolated ? 'test-results/rust-pilot-package' : 'release-native'));
const app = resolve(output, `${productName}.app`);
await rm(app,{recursive:true,force:true});
await mkdir(resolve(app, 'Contents/MacOS'), { recursive: true });
await mkdir(resolve(app, 'Contents/Resources'), { recursive: true });
await cp(resolve(env.CARGO_TARGET_DIR, 'release/xwx-deck-native'), resolve(app, 'Contents/MacOS/xwx-deck-native'));
run('/usr/bin/lipo', [resolve(app, 'Contents/MacOS/xwx-deck-native'), '-verify_arch', process.arch === 'arm64' ? 'arm64' : 'x86_64']);
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
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>`);
await writeFile(resolve(app,'Contents/Resources/RUST_DEPENDENCIES.txt'),notices.sort().join('\n')+'\n');
for (const [source, name] of [['LICENSE','LICENSE'],['NOTICE','NOTICE'],['docs/licenses/third-party-notices.md','THIRD_PARTY_NOTICES.md']]) await cp(resolve(root,source),resolve(app,'Contents/Resources',name));
let apple = null, notarization = null;
if (signed) {
  apple = await appleReleaseConfig(root);
  // Sign outside the bundle so the detached updater has no external Info.plist seal.
  const helperDirectory = await mkdtemp(join(await realpath(tmpdir()), 'xwx-update-helper-signing-'));
  try {
    const helper = join(helperDirectory, 'update-helper');
    await cp(resolve(env.CARGO_TARGET_DIR, 'release/xwx-deck-native'), helper);
    await signMac(helper, apple, true, appId + '.update-helper');
    await mkdir(resolve(app, 'Contents/Helpers'), { recursive: true });
    await cp(helper, resolve(app, 'Contents/Helpers/update-helper'));
  } finally { await rm(helperDirectory, {recursive:true, force:true}); }
  await signMac(app, apple, true);
  notarization = { app: await notarizeApp(app, apple, resolve(output, 'app-notarization.json')) };
} else run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
const dmg = resolve(output, isolated ? `XwX-Deck-Rust-Pilot-${process.arch}.dmg` : `XwX-Deck-mac-${process.arch}.dmg`);
const { compression, layout: dmgLayout } = await buildMacDmg({ root, app, dmg, productName, isolated, acceptance, signed, config: packageJson.nativePackaging.dmg });
if (signed) {
  await signMac(dmg, apple);
  notarization.dmg = await notarizeMac(dmg, apple, resolve(output, 'dmg-notarization.json'));
  await appleTool('/usr/bin/xcrun', ['stapler', 'staple', dmg]);
  await appleTool('/usr/bin/xcrun', ['stapler', 'validate', dmg]);
  await appleTool('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg]);
}
run('/usr/bin/hdiutil', ['verify', dmg]);
async function size(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  let bytes = 0;
  for (const name of await readdir(path)) bytes += await size(join(path, name));
  return bytes;
}
async function sha256(path){return createHash('sha256').update(await readFile(path)).digest('hex');}
function inspect(command,args){const result=spawnSync(command,args,{cwd:root,encoding:'utf8'});return {code:result.status,output:(result.stdout+'\n'+result.stderr).trim()};}
async function inventory(path){const entries=[];for(const name of await readdir(path)){const child=join(path,name),info=await lstat(child);if(info.isSymbolicLink())continue;if(info.isDirectory())entries.push(...await inventory(child));else entries.push(child);}return entries;}
const binary=resolve(app,'Contents/MacOS/xwx-deck-native');const files=(await inventory(app)).sort();
const appManifest=await Promise.all(files.map(async path=>({path:path.slice(app.length+1),bytes:(await lstat(path)).size,sha256:await sha256(path)})));
const appSha256=createHash('sha256').update(JSON.stringify(appManifest)).digest('hex');
let baseline=null;
const baselineDmg=resolve(root,'release-native/XwX-Deck-mac-'+process.arch+'.dmg');
if(existsSync(baselineDmg)){
  const mount=await mkdtemp(join(await realpath(tmpdir()),'xwxdeck-baseline-mount-'));
  let attached=false;
  try{
    const result=inspect('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,baselineDmg]);
    if(result.code!==0)throw Error(result.output);attached=true;
    const oldApp=(await readdir(mount)).find(name=>name.endsWith('.app'));if(!oldApp)throw Error('旧 DMG 没有应用目录');
    const directory=join(mount,oldApp),plist=join(directory,'Contents/Info.plist');
    const executable=inspect('/usr/libexec/PlistBuddy',['-c','Print :CFBundleExecutable',plist]).output;
    const oldBinary=join(directory,'Contents/MacOS',executable);
    baseline={dmg:baselineDmg,version:inspect('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',plist]).output,
      binaryBytes:await size(oldBinary),appBytes:await size(directory),dmgBytes:await size(baselineDmg),dmgSha256:await sha256(baselineDmg),architecture:inspect('/usr/bin/lipo',['-archs',oldBinary]).output};
  }catch(error){baseline={dmg:baselineDmg,inspectionError:String(error)};}
  finally{if(attached){const result=inspect('/usr/bin/hdiutil',['detach',mount]);if(result.code!==0)throw Error('旧 DMG 卸载失败：'+result.output);}await rm(mount,{recursive:true});}
}
const git=inspect('git',['rev-parse','HEAD']);const branch=inspect('git',['branch','--show-current']);const worktree=inspect('git',['status','--porcelain=v1']);
const finalSource = await sourceFingerprint(root);
if (initialSource.sha256 !== finalSource.sha256 || initialGit.stdout.trim() !== git.output) throw Error('源码在原生构建期间发生变化，未登记候选。请保留最新改动并重新构建。');
const measurements={version,branch:branch.output,commit:git.output,worktree:worktree.output,dirty:Boolean(worktree.output),buildTime:new Date().toISOString(),
  sourceFingerprint:finalSource.sha256,sourceFileCount:finalSource.fileCount,
  embeddedFrontendSha256,embeddedAssetsSha256,
  candidate:{app,dmg,binary,appSha256,appManifest,binaryBytes:await size(binary),appBytes:await size(app),dmgBytes:await size(dmg),binarySha256:await sha256(binary),dmgSha256:await sha256(dmg),
    architecture:inspect('/usr/bin/lipo',['-archs',binary]).output,bundleId:appId,
    containsNode:files.some(path=>/\/(node|node.exe|libnode[^/]*)$/i.test(path)),containsChromium:files.some(path=>/Electron Framework|Chromium|\.asar$|\.pak$/i.test(path)),
    linkedLibraries:inspect('/usr/bin/otool',['-L',binary]).output,
    signature:inspect('/usr/bin/codesign',['-dv','--verbose=4',app]).output,signatureVerified:inspect('/usr/bin/codesign',['--verify','--deep','--strict',app]).code===0},
  baseline,buildMode,scope,
  productionReady:readiness.productionReady,compression,dmgLayout,signed:signed?'developer-id':'adhoc',notarized:Boolean(notarization),notarization,
  automaticUpdate:signed?{format:'signed-notarized-dmg',teamId:apple.teamId,replacement:'atomic-bundle-swap'}:null,installed:false,published:false
};
if(measurements.candidate.containsNode||measurements.candidate.containsChromium)throw Error('原生交付包含禁止的运行时');
await writeFile(dmg + '.sha256', measurements.candidate.dmgSha256 + '  ' + dmg.split('/').at(-1) + '\n');
await writeFile(resolve(output,'native-build-report.json'),JSON.stringify(measurements,null,2)+'\n');
console.log(JSON.stringify(measurements, null, 2));
