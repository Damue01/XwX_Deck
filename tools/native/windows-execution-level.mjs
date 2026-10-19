import { spawnSync } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

// Generated artifacts use the normal filesystem label. Forcing an explicit
// Medium label changes startup when an elevated build launches WebView2.
// Never call this for user data or existing client installations.
export async function standardWindowsArtifact(path) {
  if(process.platform!=='win32')return;
  const info=await lstat(path);
  if(info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))throw Error('Execution label requires a generated ordinary file or directory.');
  const script=String.raw`Add-Type -TypeDefinition '
using System;
using System.Runtime.InteropServices;
public static class ArtifactLabel {
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode)]
 public static extern uint SetNamedSecurityInfo(string path,int kind,uint info,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
}
'; $result=[ArtifactLabel]::SetNamedSecurityInfo($env:XWX_ARTIFACT_SECURITY_PATH,1,16,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero); if($result -ne 0){throw "Cannot restore generated artifact label: $result"}`;
  const result=spawnSync(join(process.env.WINDIR,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,encoding:'utf8',env:{...process.env,XWX_ARTIFACT_SECURITY_PATH:path}});
  if(result.error || result.status)throw Error('Cannot restore the normal artifact label: '+(result.error?.message||result.stderr||result.stdout));
}
