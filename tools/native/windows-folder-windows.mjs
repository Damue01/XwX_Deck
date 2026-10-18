// Shell's folder-window API only; never terminate Explorer or close by title.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import { win32, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const normalize = value => win32.resolve(value).toLowerCase();
export function ownedFolderWindows(windows, baseline, root) {
  const before = new Set(baseline.map(window => String(window.id)));
  const base = normalize(root), groups = new Map();
  for (const window of windows) {
    const id = String(window.id);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(window);
  }
  return [...groups.values()].filter(group => !before.has(String(group[0].id)) && group.every(window => {
    if (!win32.isAbsolute(window.path || '')) return false;
    const path = normalize(window.path);
    return path === base || path.startsWith(base + '\\');
  })).flat();
}
async function shell(operation, windows = []) {
  const request = Buffer.from(JSON.stringify({ operation, windows })).toString('base64');
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-File',
    fileURLToPath(new URL('./windows-folder-windows.ps1', import.meta.url)), '-Request', request],
  { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
}
export async function trackWindowsFolderWindows(root, backend = { snapshot: () => shell('snapshot'), close: windows => shell('close', windows) }) {
  if (process.platform !== 'win32') return { async close() { return { applicable: false }; } };
  if (!isAbsolute(root) || await readFile(join(root, '.xwx-rust-pilot'), 'utf8') !== 'isolated-rust-pilot-v1\n') throw Error('Folder cleanup requires a marked absolute pilot root');
  root = await realpath(root);
  const baseline = await backend.snapshot();
  return {
    async hasOpened() { return ownedFolderWindows(await backend.snapshot(), baseline, root).length > 0; },
    async close() {
      const closed = new Set();
      // The application must exit first. Allow Shell's pending opens to settle.
      let quiet = 0, remaining = [];
      for (let attempt = 0; attempt < 12 && quiet < 3; attempt++) {
        remaining = ownedFolderWindows(await backend.snapshot(), baseline, root);
        if (remaining.length) {
          quiet = 0;
          const result = await backend.close(remaining);
          for (const id of result.closed) closed.add(String(id));
        } else quiet++;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      remaining = ownedFolderWindows(await backend.snapshot(), baseline, root);
      return { applicable: true, passed: remaining.length === 0, closed: [...closed], remaining,
        preexistingWindowsProtected: new Set(baseline.map(window => String(window.id))).size };
    }
  };
}
