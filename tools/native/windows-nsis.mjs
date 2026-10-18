import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { standardWindowsArtifact } from './windows-execution-level.mjs';
import { assertPublicBinary } from './public-binary-boundary.mjs';

// NSIS distribution used by Tauri 2.11.4; verified against its published digest.
const TOOL_SHA256 = 'c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1';
const quote = value => String(value).replaceAll('$', '$$').replaceAll('"', '$\\"');
export async function windowsNsis(root) {
  if (process.env.XWX_NSIS_HOME) {
    const home = resolve(process.env.XWX_NSIS_HOME);
    if (!existsSync(join(home, 'makensis.exe'))) throw Error('XWX_NSIS_HOME must contain NSIS 3.11.');
    return home;
  }
  const archive = join(root, 'test-results/nsis-3.11.zip');
  const destination = join(root, 'test-results/nsis-toolchain');
  const home = join(destination, 'nsis-3.11');
  await mkdir(dirname(archive), { recursive: true });
  if (!existsSync(archive)) {
    const response = await fetch('https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip', { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw Error(`NSIS download returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== TOOL_SHA256) throw Error('NSIS tool checksum mismatch');
    await writeFile(archive, bytes);
  }
  if (createHash('sha256').update(await readFile(archive)).digest('hex') !== TOOL_SHA256) throw Error('Cached NSIS tool checksum mismatch');
  if (!existsSync(join(home, 'makensis.exe'))) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:XWX_NSIS_ARCHIVE -DestinationPath $env:XWX_NSIS_DESTINATION -Force'], { windowsHide: true, encoding: 'utf8', env: { ...process.env, XWX_NSIS_ARCHIVE: archive, XWX_NSIS_DESTINATION: destination } });
    if (result.error || result.status) throw Error(result.error?.message || result.stderr);
  }
  await standardWindowsArtifact(home);
  for (const exe of ['makensis.exe', 'Bin/makensis.exe']) await standardWindowsArtifact(join(home, exe));
  return home;
}

/** Package only the existing Rust/Tauri app. NSIS is the Windows installation engine. */
export async function buildWindowsSetup({ root, binary, output, version, failureFixture = false }) {
  if (process.platform !== 'win32') throw Error('Windows Setup requires a Windows host.');
  root = resolve(root); binary = resolve(binary); output = resolve(output);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Windows Setup requires a numeric version.');
  const home = await windowsNsis(root);
  const work = join(root, 'test-results/windows-setup-build', version + (failureFixture ? '-failure-' + String(failureFixture) : ''));
  await mkdir(work, { recursive: true }); await mkdir(dirname(output), { recursive: true });
  const skin = join(work, 'XwXSetupSkin.dll');
  // This small Win32 skin belongs to the NSIS installer, never the application runtime.
  const vswhere = join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
  const installation = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true });
  if (installation.status || !installation.stdout.trim()) throw Error('Windows Setup requires the MSVC x86 build tools.');
  const vcvars = join(installation.stdout.trim(), 'VC/Auxiliary/Build/vcvars32.bat');
  if (/[&|<>^%]/.test(vcvars)) throw Error('Unsupported MSVC tool path.');
  const configured = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${vcvars}" >nul && set"`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
  if (configured.status) throw Error('Cannot initialize the MSVC x86 compiler.');
  const compilerEnv = { ...process.env };
  for (const line of configured.stdout.split(/\r?\n/)) { const at = line.indexOf('='); if (at > 0) compilerEnv[line.slice(0, at)] = line.slice(at + 1); }
  await writeFile(join(work, 'skin.def'), 'LIBRARY XwXSetupSkin\nEXPORTS\nSkin=_Skin@16\nField=_Field@8\n');
  const compiled = spawnSync('cl.exe', ['/nologo', '/LD', '/MT', '/O2', '/std:c++17', '/utf-8', '/Brepro', '/experimental:deterministic', `/pathmap:${root}=/src`, join(root, 'tools/native/windows-setup-skin.cpp'), `/Fo${join(work, 'skin.obj')}`, `/Fe${skin}`, '/link', `/DEF:${join(work, 'skin.def')}`, 'user32.lib', 'gdi32.lib', 'comctl32.lib', 'uxtheme.lib', 'gdiplus.lib'], { cwd: work, env: compilerEnv, encoding: 'utf8', windowsHide: true });
  await writeFile(join(work, 'skin-build.log'), (compiled.stdout || '') + (compiled.stderr || ''));
  if (compiled.error || compiled.status) throw Error(compiled.error?.message || compiled.stdout + compiled.stderr);
  await assertPublicBinary(skin, root);
  let template = await readFile(join(root, 'tools/native/windows-setup.nsi'), 'utf8');
  const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  for (const [key, value] of Object.entries({ OUTPUT: output, BINARY: binary, SKIN: skin, ICON: join(root, 'assets/icon.ico'), VERSION: version, BINARY_SHA256: binarySha256, FAILURE_FIXTURE: failureFixture === 'registered' ? '2' : failureFixture ? '1' : '0' })) template = template.replaceAll(`@@${key}@@`, quote(value));
  const source = join(work, 'installer.nsi'); await writeFile(source, template);
  const result = spawnSync(join(home, 'makensis.exe'), ['/INPUTCHARSET', 'UTF8', '/V3', source], { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  await writeFile(join(work, 'build.log'), (result.stdout || '') + (result.stderr || ''));
  if (result.error || result.status) throw Error(result.error?.message || (result.stdout || '') + (result.stderr || ''));
  await standardWindowsArtifact(output);
  await assertPublicBinary(output, root);
  const bytes = await readFile(output), sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(output + '.sha256', sha256 + '  ' + output.split(/[\\/]/).at(-1) + '\n');
  return { path: output, size: bytes.length, sha256, version, scope: 'per-user', installerType: 'nsis-v1', integrityLabel: 'medium', binarySha256, failureFixture };
}
