// Render the actual NSIS pages without installing, launching Deck, or changing registration.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {buildWindowsSetup} from './windows-nsis.mjs';

if(process.platform!=='win32')throw Error('Windows Setup presentation requires Windows.');
const root=resolve(import.meta.dirname,'../..');
const work=await mkdtemp(join(root,'test-results/setup-presentation-'));
await writeFile(join(work,'.xwx-setup-ui-test'),'presentation-only; no installation\n');
const version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
const binary=join(root,'release/XwX Deck.exe');
const template=await readFile(join(root,'tools/native/windows-setup.nsi'),'utf8');
const skin=await readFile(join(root,'tools/native/windows-setup-skin.cpp'),'utf8');
function replaceOnce(source,pattern,replacement){assert.equal([...source.matchAll(new RegExp(pattern.source,'g'))].length,1);return source.replace(pattern,replacement);}
let preview=replaceOnce(template,/Function \.onInit\r?\n[\s\S]*?FunctionEnd/,String.raw`Function .onInit
  SetAutoClose true
  InitPluginsDir
  StrCpy $Stage 9
  StrCpy $OperationName "安装"
  StrCpy $INSTDIR "$EXEDIR\unused-preview-only"
  File /oname=$PLUGINSDIR\XwXSetupSkin.dll "@@SKIN@@"
FunctionEnd`);
preview=replaceOnce(preview,/Function InstallLeave\r?\n[\s\S]*?FunctionEnd/,'Function InstallLeave\nFunctionEnd');
preview=replaceOnce(preview,/Function FinishLeave\r?\n[\s\S]*?FunctionEnd/,'Function FinishLeave\nFunctionEnd');
preview=replaceOnce(preview,/Section "XwX Deck"\r?\n[\s\S]*?\r?\nSectionEnd/,'Section "Presentation only"\n  Sleep 800\nSectionEnd');
const harness=String.raw`
$ErrorActionPreference='Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public static class SetupPresentation {
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;}
 delegate bool EnumProc(IntPtr w,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr w,EnumProc f,IntPtr p);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr w,out uint p);
 [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr w);
 [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr w,int id);
 [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr w);
 [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr w,int id);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr w,out Rect r);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr w);
 [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr w);
 [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr w,uint m,IntPtr a,IntPtr b);
 [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr w,IntPtr dc,uint flags);
 [DllImport("user32.dll")] static extern bool PostMessage(IntPtr w,uint m,IntPtr a,IntPtr b);
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 static int scale;
 static readonly List<string> checks=new List<string>();
 static int Px(int n){return (n*scale+48)/96;}
 static void Check(bool value,string name){if(!value)throw new Exception(name);checks.Add(name);}
 static IntPtr Packed(int x,int y){return new IntPtr((y<<16)|(x&65535));}
 static Rect Bounds(IntPtr w){Rect r;GetWindowRect(w,out r);return r;}
 static IntPtr Page(IntPtr w){IntPtr found=IntPtr.Zero;EnumChildWindows(w,(c,p)=>{if(GetDlgCtrlID(c)==60002&&IsWindowVisible(c))found=GetParent(c);return true;},IntPtr.Zero);return found;}
 static void Wait(Func<bool> f,string name){for(int i=0;i<200;i++){if(f())return;Thread.Sleep(25);}throw new Exception(name);}
 static Bitmap Capture(IntPtr w,string path){Rect r=Bounds(w);var b=new Bitmap(r.Right-r.Left,r.Bottom-r.Top);using(var g=Graphics.FromImage(b)){g.Clear(Color.White);IntPtr dc=g.GetHdc();bool ok=PrintWindow(w,dc,2);g.ReleaseHdc(dc);if(!ok)throw new Exception("PrintWindow failed");}b.Save(path,ImageFormat.Png);return b;}
 static void Layout(IntPtr w){IntPtr page=Page(w);Rect a=Bounds(w),b=Bounds(page);Check(b.Left==a.Left&&b.Top==a.Top&&b.Right-b.Left==Px(620)&&b.Bottom-b.Top==Px(180),"page stays aligned with the borderless host");bool clean=true;EnumChildWindows(w,(c,p)=>{int id=GetDlgCtrlID(c);if(GetParent(c)==w&&IsWindowVisible(c)&&c!=page&&id!=1&&id!=2&&id!=60001&&id!=60003)clean=false;return true;},IntPtr.Zero);Check(clean,"native headers and separator controls stay hidden");}
 static void Drag(IntPtr w){
  IntPtr page=Page(w),close=GetDlgItem(w,60001);Rect r=Bounds(w),c=Bounds(close);int x=r.Left+Px(290),y=r.Top+Px(25);
  Check(SendMessage(w,0x84,IntPtr.Zero,Packed(x,y)).ToInt64()==2,"host top area is a Windows caption");
  Check(SendMessage(page,0x84,IntPtr.Zero,Packed(x,y)).ToInt64()==-1,"page forwards top-area hit testing");
  Check(SendMessage(w,0x84,IntPtr.Zero,Packed((c.Left+c.Right)/2,(c.Top+c.Bottom)/2)).ToInt64()==1,"close button is excluded from dragging");
  PostMessage(w,0x112,new IntPtr(0xf010),IntPtr.Zero);Thread.Sleep(80);
  PostMessage(w,0x100,new IntPtr(0x27),IntPtr.Zero);Thread.Sleep(50);
  PostMessage(w,0x100,new IntPtr(0x27),IntPtr.Zero);Thread.Sleep(50);
  PostMessage(w,0x100,new IntPtr(0x28),IntPtr.Zero);Thread.Sleep(50);
  PostMessage(w,0x100,new IntPtr(0x0d),IntPtr.Zero);Thread.Sleep(80);
  Rect moved=Bounds(w);Check(moved.Left!=r.Left||moved.Top!=r.Top,"Windows can move the owned borderless installer");
 }
 public static void Run(string executable,string directory,int dpi){
  SetThreadDpiAwarenessContext(new IntPtr(-4));scale=dpi;checks.Clear();
  var process=Process.Start(new ProcessStartInfo(executable){UseShellExecute=false});IntPtr w=IntPtr.Zero;
  try{
   Wait(()=>{EnumWindows((c,p)=>{uint pid;GetWindowThreadProcessId(c,out pid);if(pid==process.Id&&IsWindowVisible(c))w=c;return true;},IntPtr.Zero);return w!=IntPtr.Zero&&Page(w)!=IntPtr.Zero;},"fixture did not render");
   Thread.Sleep(100);Layout(w);Drag(w);using(var b=Capture(w,Path.Combine(directory,"install.png"))){}
   SendMessage(GetDlgItem(w,1),0xf5,IntPtr.Zero,IntPtr.Zero);Thread.Sleep(100);
   Check(!IsWindowEnabled(GetDlgItem(w,60001)),"close is disabled while installation progresses");using(var b=Capture(w,Path.Combine(directory,"progress.png"))){}
   Wait(()=>IsWindowEnabled(GetDlgItem(w,60001))&&Page(w)!=IntPtr.Zero,"finish page did not render");Thread.Sleep(100);Layout(w);Drag(w);
   IntPtr next=GetDlgItem(w,1);SendMessage(next,0xf4,new IntPtr(1),new IntPtr(1));
   Check((GetWindowLong(next,-16)&15)==11,"default-button changes retain owner drawing");
   SendMessage(w,0x127,new IntPtr((1<<16)|1),IntPtr.Zero);SendMessage(GetDlgItem(w,60001),0x2a3,IntPtr.Zero,IntPtr.Zero);
   using(var bitmap=Capture(w,Path.Combine(directory,"finish.png"))){
    Rect a=Bounds(w),b=Bounds(next);int bright=0;for(int x=b.Left-a.Left+Px(8);x<b.Right-a.Left-Px(8);x++){Color color=bitmap.GetPixel(x,b.Top-a.Top+Px(3));if(color.R>210&&color.G>210&&color.B>210)bright++;}
    Check(bright==0,"primary button has no white focus stripe");
    Rect c=Bounds(GetDlgItem(w,60001));int left=bitmap.Width,top=bitmap.Height,right=0,bottom=0,min=255;
    for(int y=c.Top-a.Top+Px(10);y<c.Bottom-a.Top-Px(10);y++)for(int x=c.Left-a.Left+Px(10);x<c.Right-a.Left-Px(10);x++){Color color=bitmap.GetPixel(x,y);if(color.R<210){left=Math.Min(left,x);right=Math.Max(right,x);top=Math.Min(top,y);bottom=Math.Max(bottom,y);min=Math.Min(min,color.R);}}
    Check(right>=left&&right-left+1<=Px(11)&&bottom-top+1<=Px(11)&&min>=110,"close glyph is compact, light and antialiased");
   }
   SendMessage(w,0x127,new IntPtr((1<<16)|2),IntPtr.Zero);using(var b=Capture(w,Path.Combine(directory,"keyboard-focus.png"))){}
   IntPtr checkbox=IntPtr.Zero;EnumChildWindows(Page(w),(c,p)=>{if((GetWindowLong(c,-16)&15)==3)checkbox=c;return true;},IntPtr.Zero);
   Check(checkbox!=IntPtr.Zero&&SendMessage(checkbox,0xf0,IntPtr.Zero,IntPtr.Zero).ToInt64()==1,"launch checkbox starts checked");SendMessage(checkbox,0xf5,IntPtr.Zero,IntPtr.Zero);Check(SendMessage(checkbox,0xf0,IntPtr.Zero,IntPtr.Zero).ToInt64()==0,"launch checkbox still toggles");
   SendMessage(GetDlgItem(w,60001),0xf5,IntPtr.Zero,IntPtr.Zero);Check(process.WaitForExit(5000),"finish close action exits the owned fixture");
   File.WriteAllLines(Path.Combine(directory,"checks.txt"),checks);Console.WriteLine("PASS "+checks.Count+" presentation checks at "+dpi+" logical DPI");
  }finally{if(!process.HasExited)process.Kill();process.Dispose();}
 }
}
'@
[SetupPresentation]::Run($env:XWX_SETUP_UI_BINARY,$env:XWX_SETUP_UI_OUTPUT,[int]$env:XWX_SETUP_UI_DPI)
`;
await writeFile(join(work,'presentation.ps1'),harness);
const results=[];
for(const dpi of [96,120,144]){
 const fixture=join(work,String(dpi));await mkdir(join(fixture,'tools/native'),{recursive:true});await mkdir(join(fixture,'assets'));
 await writeFile(join(fixture,'tools/native/windows-setup.nsi'),preview);
 await writeFile(join(fixture,'tools/native/windows-setup-skin.cpp'),replaceOnce(skin,/dpi=GetDpiForWindow\(parent\)/,'dpi='+dpi));
 await copyFile(join(root,'assets/icon.ico'),join(fixture,'assets/icon.ico'));
 const artifact=await buildWindowsSetup({root:fixture,binary,output:join(fixture,'presentation.exe'),version});
 const result=spawnSync(join(process.env.WINDIR,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-File',join(work,'presentation.ps1')],{env:{...process.env,XWX_SETUP_UI_BINARY:artifact.path,XWX_SETUP_UI_OUTPUT:fixture,XWX_SETUP_UI_DPI:String(dpi)},windowsHide:true,encoding:'utf8',timeout:30000});
 await writeFile(join(fixture,'test.log'),result.stdout+result.stderr);assert.ifError(result.error);assert.equal(result.status,0,result.stdout+result.stderr);
 results.push({dpi,checks:(await readFile(join(fixture,'checks.txt'),'utf8')).trim().split(/\r?\n/),directory:fixture});console.log(result.stdout.trim());
}
await writeFile(join(work,'summary.json'),JSON.stringify({passed:true,results,scope:'Actual NSIS pages with program, launch and registration operations removed; injected logical scales, not physical Windows display changes'},null,2)+'\n');
console.log(work);
