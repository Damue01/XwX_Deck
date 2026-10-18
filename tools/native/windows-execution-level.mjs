import { spawnSync } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

// Generated executables must run at the ordinary user's Medium level.
// Test/build directories can inherit Low, which also lowers child processes.
// Never call this for user data or existing client installations.
export async function standardWindowsArtifact(path) {
  if(process.platform!=='win32')return;
  const info=await lstat(path);
  if(info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))throw Error('Execution label requires a generated ordinary file or directory.');
  const result=spawnSync(join(process.env.WINDIR,'System32/icacls.exe'),[path,'/setintegritylevel',info.isDirectory()?'(OI)(CI)M':'M'],{windowsHide:true,encoding:'utf8'});
  if(result.error || result.status)throw Error('Cannot assign the standard-user execution level: '+(result.error?.message||result.stderr||result.stdout));
}
