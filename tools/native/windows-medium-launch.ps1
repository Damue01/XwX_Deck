param([Parameter(Mandatory=$true)][string]$Script)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Medium-token diagnostics are restricted to the disposable runner.' }
$scriptPath = (Resolve-Path $Script).Path
$nodePath = (Get-Command node.exe).Source
$work = Join-Path $env:TEMP ('xwx-medium-startup-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $work | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class MediumLaunch {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 public struct Startup { public int cb; public string reserved; public string desktop; public string title; public int x,y,w,h,cx,cy,fill,flags; public short show,reserved2; public IntPtr reservedPointer,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] public struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr info,int size,out int required);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertSidToStringSid(IntPtr sid,out IntPtr text);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle,uint code);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessWithTokenW(IntPtr token,uint logon,string app,StringBuilder command,uint flags,IntPtr environment,string directory,ref Startup startup,out ProcessInfo process);
 static void Require(bool value,string label) { if(!value) throw new Exception(label+": "+Marshal.GetLastWin32Error()); }
 public static string Integrity(IntPtr token) {
  int size; GetTokenInformation(token,25,IntPtr.Zero,0,out size); var data=Marshal.AllocHGlobal(size);
  try { Require(GetTokenInformation(token,25,data,size,out size),"Read integrity"); IntPtr text; Require(ConvertSidToStringSid(Marshal.ReadIntPtr(data),out text),"Read integrity SID"); try{return Marshal.PtrToStringUni(text);}finally{LocalFree(text);} }
  finally{Marshal.FreeHGlobal(data);}
 }
 public static string[] Run(string node,string script,string directory) {
  IntPtr parent; Require(OpenProcessToken(GetCurrentProcess(),8,out parent),"Open parent token");
  IntPtr linked=IntPtr.Zero; var info=Marshal.AllocHGlobal(IntPtr.Size);
  try {
   int size; Require(GetTokenInformation(parent,19,info,IntPtr.Size,out size),"Read actual linked user token"); linked=Marshal.ReadIntPtr(info);
   var integrity=Integrity(linked); if(integrity!="S-1-16-8192") throw new Exception("Expected ordinary Medium token, got "+integrity);
   var startup=new Startup(); startup.cb=Marshal.SizeOf(startup); startup.desktop="winsta0\\default";
   ProcessInfo process; var command=new StringBuilder("\""+node+"\" \""+script+"\" --matrix-only");
   var variables=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
   foreach(DictionaryEntry item in Environment.GetEnvironmentVariables()) variables[(string)item.Key]=(string)item.Value;
   var environment=new StringBuilder(); foreach(var item in variables) environment.Append(item.Key).Append('=').Append(item.Value).Append('\0'); environment.Append('\0');
   var block=Marshal.StringToHGlobalUni(environment.ToString());
   try { Require(CreateProcessWithTokenW(linked,0,node,command,0x08000400,block,directory,ref startup,out process),"Launch ordinary user process"); }
   finally{Marshal.FreeHGlobal(block);}
   try {
    if(WaitForSingleObject(process.process,240000)!=0) { TerminateProcess(process.process,2); throw new Exception("Ordinary-user diagnostic timed out"); }
    uint code; Require(GetExitCodeProcess(process.process,out code),"Read child exit");
    return new string[]{Integrity(parent),integrity,process.pid.ToString(),code.ToString()};
   } finally{CloseHandle(process.thread);CloseHandle(process.process);}
  } finally{if(linked!=IntPtr.Zero)CloseHandle(linked);Marshal.FreeHGlobal(info);CloseHandle(parent);}
 }
}
'@
try { $result = [MediumLaunch]::Run($nodePath,$scriptPath,$work) }
catch { @{blocked=$true;error=$_.Exception.Message;isolatedWork=$work} | ConvertTo-Json | Set-Content test-results/windows-medium-token.json; throw }
@{ parentIntegrity=$result[0]; childIntegrity=$result[1]; pid=$result[2]; exitCode=$result[3]; isolatedWork=$work; mechanism='actual linked ordinary-user token; same interactive desktop' } | ConvertTo-Json | Set-Content test-results/windows-medium-token.json
if ($result[3] -ne '0') { throw "Ordinary-user diagnostic failed with $($result[3])" }
Copy-Item (Join-Path $work 'test-results/windows-window-probe.json') test-results/windows-startup-matrix-medium.json
