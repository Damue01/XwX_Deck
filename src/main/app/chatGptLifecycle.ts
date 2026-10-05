import { execFile } from 'child_process';

type SupportedPlatform = NodeJS.Platform;

function execFileText(command: string, args: string[], timeout = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

/** Only stop Deck's recovery worker, never a process identified by PID alone. */
export async function stopStalledExitRecovery(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error('无效的恢复进程号。');
  const commandLine = process.platform === 'win32'
    ? await execFileText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop).CommandLine`])
    : await execFileText('ps', ['-p', String(pid), '-o', 'command=']).catch(() => '');
  if (!commandLine.trim()) {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
    throw new Error(`无法读取旧恢复进程 ${pid} 的身份，请重试。`);
  }
  if (!/[/\\]exit-recovery\.js(?:["'\s]|$)/i.test(commandLine)) {
    return false;
  }
  try { process.kill(pid, 'SIGKILL'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  return true;
}

function macChatGptMainProcessIds(output: string): number[] {
  const ids: number[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const detailed = line.match(/^(\d+)\s+(\S+)\s+([\s\S]+)$/);
    const state = detailed?.[2] ?? '';
    const command = detailed?.[3] ?? line;
    if (/^Z/i.test(state)) continue;
    if (!/(?:^|\s)\/[^\n]*?\/ChatGPT\.app\/Contents\/MacOS\/ChatGPT(?:\s|$)/i.test(command)) continue;
    if (detailed) ids.push(Number(detailed[1]));
  }
  return [...new Set(ids.filter(pid => Number.isSafeInteger(pid) && pid > 0))];
}

function windowsChatGptMainProcessIds(output: string): number[] {
  const ids: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^"ChatGPT\.exe","(\d+)",/i);
    if (match) ids.push(Number(match[1]));
  }
  return [...new Set(ids.filter(pid => Number.isSafeInteger(pid) && pid > 0))];
}

function macClaudeMainProcessIds(output: string): number[] {
  const ids: number[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const detailed = line.match(/^(\d+)\s+(\S+)\s+([\s\S]+)$/);
    const state = detailed?.[2] ?? '';
    const command = detailed?.[3] ?? line;
    if (/^Z/i.test(state)) continue;
    if (!(
      /\/Claude\.app\/Contents\/MacOS\/Claude(?:\s|$)/i.test(command)
      || /(?:^|\s)(?:[^\s/]+\/)?claude(?:\s|$)/i.test(command)
      || /@anthropic-ai\/claude-code/i.test(command)
    )) continue;
    if (detailed) ids.push(Number(detailed[1]));
  }
  return [...new Set(ids.filter(pid => Number.isSafeInteger(pid) && pid > 0))];
}

function windowsClaudeMainProcessIds(output: string): number[] {
  const ids: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^"claude(?: desktop)?\.exe","(\d+)",/i);
    if (match) ids.push(Number(match[1]));
  }
  return [...new Set(ids.filter(pid => Number.isSafeInteger(pid) && pid > 0))];
}

export function processListContainsChatGptMainProcess(output: string, platform: SupportedPlatform): boolean {
  if (platform === 'win32') {
    return windowsChatGptMainProcessIds(output).length > 0;
  }
  if (platform === 'darwin') {
    const hasDetailedRows = output.split(/\r?\n/).some(line => /^\s*\d+\s+\S+\s+/.test(line));
    if (hasDetailedRows) return macChatGptMainProcessIds(output).length > 0;
    return output.split(/\r?\n/).some(line =>
      /(?:^|\s)\/[^\n]*?\/chatgpt\.app\/contents\/macos\/chatgpt(?:\s|$)/i.test(line.trim())
    );
  }
  return false;
}

async function chatGptMainProcessIds(platform: SupportedPlatform = process.platform): Promise<number[]> {
  if (platform === 'win32') {
    return windowsChatGptMainProcessIds(await execFileText('tasklist.exe', ['/FO', 'CSV', '/NH']));
  }
  if (platform === 'darwin') {
    return macChatGptMainProcessIds(await execFileText('ps', ['-axo', 'pid=,state=,command=']));
  }
  return [];
}

export async function isChatGptRunning(platform: SupportedPlatform = process.platform): Promise<boolean> {
  return (await chatGptMainProcessIds(platform)).length > 0;
}

export async function isClaudeRunning(platform: SupportedPlatform = process.platform): Promise<boolean> {
  if (platform === 'win32') {
    return windowsClaudeMainProcessIds(await execFileText('tasklist.exe', ['/FO', 'CSV', '/NH'])).length > 0;
  }
  if (platform === 'darwin') {
    return macClaudeMainProcessIds(await execFileText('ps', ['-axo', 'pid=,state=,command='])).length > 0;
  }
  return false;
}

function windowsClaudeDesktopProcess(output: string): boolean {
  return output.split(/\r?\n/).some(line => {
    const match = line.trim().match(/^([^|]+)\|\d+\|(.*)$/);
    if (!match) return false;
    const [, name, path] = match;
    if (/^Claude Desktop$/i.test(name)) return true;
    return /^Claude$/i.test(name) && /[/\\](?:Claude|Claude Desktop|AnthropicClaude|Claude_[^/\\]+)[/\\](?:app[/\\])?Claude\.exe$/i.test(path);
  });
}

function macClaudeDesktopProcess(output: string): boolean {
  return output.split(/\r?\n/).some(line => {
    const match = line.trim().match(/^\d+\s+(\S+)\s+([\s\S]+)$/);
    return !!match && !/^Z/i.test(match[1])
      && /\/Claude\.app\/Contents\/MacOS\/Claude(?:\s|$)/i.test(match[2]);
  });
}

/** A restart hint concerns the Desktop app, not a running Claude Code CLI. */
export async function isClaudeDesktopRunning(platform: SupportedPlatform = process.platform): Promise<boolean> {
  if (platform === 'win32') {
    const command = `Get-Process -Name Claude,'Claude Desktop' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.ProcessName)|$($_.Id)|$($_.Path)" }`;
    return windowsClaudeDesktopProcess(await execFileText('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', command
    ]));
  }
  if (platform === 'darwin') {
    return macClaudeDesktopProcess(await execFileText('ps', ['-axo', 'pid=,state=,command=']));
  }
  return false;
}

export interface ResetClientProcess {
  readonly pid: number;
  readonly label: string;
  readonly executable: string;
}

/** The same executable name is used by both ChatGPT and Codex on Windows. */
export async function listClientsForReset(platform: SupportedPlatform = process.platform): Promise<ResetClientProcess[]> {
  if (platform === 'darwin') {
    const output = await execFileText('ps', ['-axo', 'pid=,state=,command=']);
    return [
      ...macChatGptMainProcessIds(output).map(pid => ({ pid, label: 'ChatGPT', executable: 'ChatGPT.app' })),
      ...macClaudeMainProcessIds(output).map(pid => ({ pid, label: 'Claude', executable: 'Claude.app/claude' }))
    ];
  }
  if (platform !== 'win32') return [];
  // The Codex Windows package also runs as ChatGPT.exe. tasklist only gives
  // the image name, so it cannot tell the user which application is still open.
  const command = `Get-Process -Name ChatGPT,Codex,Claude,'Claude Desktop' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.ProcessName)|$($_.Id)|$($_.Path)" }`;
  try {
    return windowsResetClientProcesses(await execFileText('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', command
    ]));
  } catch {
    // Process-path inspection can be blocked independently of tasklist/taskkill.
    return windowsTasklistResetProcesses(await execFileText('tasklist.exe', ['/FO', 'CSV', '/NH']));
  }
}

function windowsTasklistResetProcesses(output: string): ResetClientProcess[] {
  const rows = output.split(/\r?\n/).flatMap(line => {
    const row = line.match(/^"(ChatGPT|Codex|Claude|Claude Desktop)\.exe","(\d+)",/i);
    return row ? [`${row[1]}|${row[2]}|${row[1]}.exe`] : [];
  });
  return windowsResetClientProcesses(rows.join('\n'));
}

function windowsResetClientProcesses(output: string): ResetClientProcess[] {
  const processes: ResetClientProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^([^|]+)\|(\d+)\|(.*)$/);
    if (!match) continue;
    const [, name, pidText, executable] = match;
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (/^chatgpt$/i.test(name)) {
      const label = !executable ? 'ChatGPT/Codex（路径无法读取）'
        : /[/\\]OpenAI\.Codex_[^/\\]+[/\\]/i.test(executable) ? 'Codex 桌面版' : 'ChatGPT';
      processes.push({ pid, label, executable });
    } else if (/^codex$/i.test(name)) {
      processes.push({ pid, label: 'Codex', executable });
    } else if (/^claude(?: desktop)?$/i.test(name)) {
      processes.push({ pid, label: 'Claude', executable });
    }
  }
  return processes;
}

export function resetClientLabels(processes: readonly ResetClientProcess[]): string[] {
  const groups = new Map<string, string[]>();
  for (const { label, pid } of processes) {
    groups.set(label, [...(groups.get(label) ?? []), String(pid)]);
  }
  return [...groups].map(([label, pids]) => `${label}（${pids.length} 个进程，例如 PID ${pids[0]}）`);
}

function matchingResetClientProcesses(
  detected: readonly ResetClientProcess[],
  current: readonly ResetClientProcess[]
): ResetClientProcess[] {
  return current.filter(process => detected.some(previous =>
    previous.pid === process.pid && (previous.executable === process.executable
      || previous.executable && process.executable
        && (!/[/\\]/.test(previous.executable) || !/[/\\]/.test(process.executable))
        && previous.executable.split(/[/\\]/).pop()!.toLowerCase() === process.executable.split(/[/\\]/).pop()!.toLowerCase())
  ));
}

export async function forceCloseClientsForReset(
  detected: readonly ResetClientProcess[],
  platform: SupportedPlatform = process.platform
): Promise<void> {
  // Recheck identity after the user responds. A PID that was reused by another
  // executable during the dialog must never be terminated.
  const current = await listClientsForReset(platform);
  const targets = matchingResetClientProcesses(detected, current);
  if (platform === 'win32' && targets.length) {
    const args = targets.flatMap(process => ['/PID', String(process.pid)]);
    await execFileText('taskkill.exe', [...args, '/T', '/F'], 10_000).catch(() => undefined);
  } else if (platform === 'darwin') {
    for (const { pid } of targets) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* Verified below. */ }
    }
  }
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const remaining = await listClientsForReset(platform);
    if (!remaining.length) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const remaining = await listClientsForReset(platform);
  throw new Error(`客户端未能完全关闭：${resetClientLabels(remaining).join('、')}。重置尚未开始。`);
}

function windowsRunningClientLabels(output: string): string[] {
  return resetClientLabels(windowsResetClientProcesses(output));
}

export const __test = {
  processListContainsChatGptMainProcess,
  macChatGptMainProcessIds,
  windowsChatGptMainProcessIds,
  macClaudeMainProcessIds,
  windowsClaudeMainProcessIds,
  windowsClaudeDesktopProcess,
  macClaudeDesktopProcess,
  windowsResetClientProcesses,
  windowsTasklistResetProcesses,
  windowsRunningClientLabels,
  matchingResetClientProcesses
};
