import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { standardWindowsArtifact } from './windows-execution-level.mjs';

const SHA256 = '6ac824e1642d6f7277d0ed7ea09411a508f6116ba6fae0aa5f2c7daa2ff43d31';
export async function windowsWix(root) {
  const home = resolve(process.env.XWX_WIX_HOME || join(root, 'test-results/wix314'));
  if (process.env.XWX_WIX_HOME) {
    if (!existsSync(join(home, 'candle.exe')) || !existsSync(join(home, 'light.exe'))) throw Error('XWX_WIX_HOME must contain WiX 3.14.1 binaries.');
    return home;
  }
  const archive = join(root, 'test-results/wix314-binaries.zip');
  await mkdir(join(root, 'test-results'), { recursive: true });
  if (!existsSync(archive)) {
    const response = await fetch('https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip', { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw Error('Cannot download WiX: HTTP '+response.status);
    const bytes=Buffer.from(await response.arrayBuffer());
    if(createHash('sha256').update(bytes).digest('hex')!==SHA256) throw Error('WiX SHA-256 mismatch.');
    await writeFile(archive,bytes);
  }
  if(createHash('sha256').update(await readFile(archive)).digest('hex')!==SHA256) throw Error('Cached WiX SHA-256 mismatch.');
  if (!existsSync(join(home, 'light.exe'))) {
    const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Expand-Archive -LiteralPath $env:XWX_WIX_ARCHIVE -DestinationPath $env:XWX_WIX_DESTINATION -Force'], {env:{...process.env,XWX_WIX_ARCHIVE:archive,XWX_WIX_DESTINATION:home},windowsHide:true,encoding:'utf8'});
    if(result.error||result.status) throw Error(result.error?.message||result.stderr);
  }
  for(const executable of ['candle.exe','light.exe'])await standardWindowsArtifact(join(home,executable));
  return home;
}
