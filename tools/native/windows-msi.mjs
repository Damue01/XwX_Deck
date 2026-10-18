import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { windowsWix } from './windows-wix.mjs';
import { standardWindowsArtifact } from './windows-execution-level.mjs';
import { windowsMsiUi } from './windows-msi-ui.mjs';

const contract = JSON.parse(await readFile(new URL('../../release-contract.json', import.meta.url), 'utf8'));
export const MSI_UPGRADE_CODE = contract.platforms.windows.upgradeCode;
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Package the existing embedded Rust/Tauri executable; no second runtime. */
export async function buildWindowsMsi({ root, binary, output, version }) {
  if (process.platform !== 'win32') throw Error('MSI packaging requires Windows.');
  root = resolve(root); binary = resolve(binary); output = resolve(output);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('MSI version must have three numeric parts.');
  const wix = await windowsWix(root);
  if (!existsSync(join(wix, 'candle.exe'))) throw Error('WiX v3.14.1 is required; set XWX_WIX_HOME to its portable binaries directory.');
  const work = join(root, 'test-results/windows-msi', version);
  await mkdir(work, { recursive: true });
  await mkdir(dirname(output), { recursive: true });
  const source = join(work, 'installer.wxs');
  const object = join(work, 'installer.wixobj');
  await writeFile(source, `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
 <Product Id="*" Name="XwX Deck" Language="2052" Codepage="936" Version="${xml(version)}" Manufacturer="XwX Deck" UpgradeCode="${MSI_UPGRADE_CODE}">
  <Package InstallerVersion="500" Compressed="yes" InstallScope="perUser" InstallPrivileges="limited" Platform="x64" />
  <MajorUpgrade Schedule="afterInstallInitialize" AllowSameVersionUpgrades="yes" DowngradeErrorMessage="已安装更新版本的 XwX Deck。请使用已安装的版本。" />
  <MediaTemplate EmbedCab="yes" />
  <Property Id="MSIRESTARTMANAGERCONTROL" Value="DisableShutdown" />
  <!-- Per-user files and HKCU only: retain MSI rollback, skip a machine restore checkpoint. -->
  <Property Id="MSIFASTINSTALL" Value="1" />
  <Property Id="MsiLogging" Value="voicewarmup" />
  <Property Id="WIXUI_INSTALLDIR" Value="INSTALLDIR" />
  <Property Id="PREVIOUSINSTALLDIR"><RegistrySearch Id="PreviousInstallLocation" Root="HKCU" Key="Software\\XwX Deck\\Installation" Name="Path" Type="raw" /></Property>
  <!-- A major upgrade replaces files in place; moving a shared component is not an upgrade. -->
  <SetProperty Id="INSTALLDIR" Value="[PREVIOUSINSTALLDIR]" After="AppSearch">PREVIOUSINSTALLDIR AND (Installed OR WIX_UPGRADE_DETECTED)</SetProperty>
  <SetProperty Id="ARPINSTALLLOCATION" Value="[INSTALLDIR]" After="CostFinalize" />
  <Icon Id="DeckIcon" SourceFile="${xml(join(root, 'assets/icon.ico'))}" />
  <Property Id="ARPPRODUCTICON" Value="DeckIcon" />
  <Condition Message="XwX Deck requires 64-bit Windows.">Installed OR VersionNT64</Condition>
  <Directory Id="TARGETDIR" Name="SourceDir">
   <Directory Id="LocalAppDataFolder"><Directory Id="UserPrograms" Name="Programs"><Directory Id="INSTALLDIR" Name="XwX Deck">
    <Component Id="DeckApplication" Guid="2394B705-CBAE-43D9-8831-B9FB34AE4F24" Win64="yes">
     <File Id="DeckExecutable" Source="${xml(binary)}" Name="XwX Deck.exe" />
     <Shortcut Id="StartMenuShortcut" Directory="ProgramMenuFolder" Name="XwX Deck" Target="[#DeckExecutable]" WorkingDirectory="INSTALLDIR" Icon="DeckIcon" />
     <RemoveFolder Id="RemoveEmptyInstallFolder" On="uninstall" />
     <RemoveFolder Id="RemoveEmptyUserPrograms" Directory="UserPrograms" On="uninstall" />
     <RegistryKey Root="HKCU" Key="Software\\XwX Deck\\Installation">
      <RegistryValue Name="Installed" Type="integer" Value="1" KeyPath="yes" />
      <RegistryValue Name="Path" Type="string" Value="[INSTALLDIR]" />
      <RegistryValue Name="ProductCode" Type="string" Value="[ProductCode]" />
      <RegistryValue Name="UpgradeCode" Type="string" Value="${MSI_UPGRADE_CODE}" />
      <RegistryValue Name="Version" Type="string" Value="[ProductVersion]" />
     </RegistryKey>
    </Component>
   </Directory></Directory></Directory>
   <Directory Id="ProgramMenuFolder" />
  </Directory>
  <Feature Id="Application" Title="XwX Deck" Level="1"><ComponentRef Id="DeckApplication" /></Feature>
  <CustomAction Id="PrepareSafeUninstall" FileKey="DeckExecutable" ExeCommand="--prepare-msi-uninstall [WIX_UPGRADE_DETECTED]" Execute="immediate" Return="check" Impersonate="yes" />
  <InstallExecuteSequence><Custom Action="PrepareSafeUninstall" Before="InstallValidate">(REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE) OR WIX_UPGRADE_DETECTED</Custom></InstallExecuteSequence>
  ${windowsMsiUi(root)}
 </Product>
</Wix>`);
  const env = { ...process.env, TEMP: work, TMP: work };
  for (const [tool, args] of [['candle.exe', ['-nologo', '-arch', 'x64', '-out', object, source]], ['light.exe', ['-nologo', '-out', output, object]]]) {
    const result = spawnSync(join(wix, tool), args, { cwd: work, env, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    await writeFile(join(work, tool+'.log'), (result.stdout || '')+(result.stderr || ''));
    if (result.error || result.status) throw Error(`${tool}: ${result.error?.message || result.stdout || result.stderr}`);
  }
  await standardWindowsArtifact(output);
  const bytes = await readFile(output), sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(output+'.sha256', sha256+'  '+output.split(/[\\/]/).at(-1)+'\n');
  return { path: output, size: bytes.length, sha256, upgradeCode: MSI_UPGRADE_CODE, version, scope: 'per-user', integrityLabel: 'medium', iceValidated: true };
}
