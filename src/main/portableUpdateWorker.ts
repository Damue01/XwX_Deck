import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { applicationRelaunchEnvironment } from './app/applicationReset';
import { readPortableUpdateRequest, runPortableUpdateMode } from './update/portableUpdate';

async function main(): Promise<void> {
  const request = readPortableUpdateRequest();
  if (!request) throw new Error('缺少便携更新任务。');
  // All bundled code is loaded before the old portable wrapper may clean up.
  process.send?.({ type: 'ready' });
  process.disconnect?.();
  try {
    await runPortableUpdateMode(request);
    await fs.promises.rm(`${request.targetPath}.update-error.txt`, { force: true }).catch(() => undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const noticePath = `${request.targetPath}.update-error.txt`;
    await fs.promises.writeFile(noticePath, message, 'utf8').catch(() => undefined);
    // Node mode deliberately has no Chromium or Electron dialog dependency.
    // Keep a visible manual-open instruction even when the new app cannot start.
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const notice = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($env:XWX_UPDATE_ERROR, 'XwX Deck 更新未完成') | Out-Null"
    ], {
      detached: true,
      cwd: path.dirname(request.targetPath),
      stdio: 'ignore',
      windowsHide: true,
      env: { ...applicationRelaunchEnvironment(), XWX_UPDATE_ERROR: message }
    });
    notice.on('error', () => { /* The adjacent text file remains the fallback. */ });
    notice.unref();
    throw error;
  }
}

void main().catch(error => {
  console.error('[updater] portable update worker failed', error);
  process.exitCode = 1;
});
