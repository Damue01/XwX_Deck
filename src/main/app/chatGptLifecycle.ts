import { execFile } from 'child_process';

type SupportedPlatform = NodeJS.Platform;

function execFileText(command: string, args: string[], timeout = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', timeout }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
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

export const __test = {
  processListContainsChatGptMainProcess,
  macChatGptMainProcessIds,
  windowsChatGptMainProcessIds,
  macClaudeMainProcessIds,
  windowsClaudeMainProcessIds
};
