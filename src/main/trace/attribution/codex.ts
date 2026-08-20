import { TapClientIdentity } from '../types';
import { headerValue, type HeaderBag } from '../protocolBody';

export function identifyCodex(headers: HeaderBag, body: unknown): TapClientIdentity | undefined {
  const originator = headerValue(headers, 'originator').toLowerCase();
  const ua = headerValue(headers, 'user-agent').toLowerCase();
  const metadata = headerValue(headers, 'x-codex-turn-metadata');
  const windowId = headerValue(headers, 'x-codex-window-id') || codexClientMetadata(body, 'x-codex-window-id');
  const haystack = `${originator} ${ua} ${metadata}`.toLowerCase();
  const evidence: string[] = [];

  if (/codex[_-]vscode/.test(originator)) evidence.push('header:originator=codex_vscode');
  if (/codex[_-]vscode/.test(ua)) evidence.push('header:user-agent~codex_vscode');
  if (/codex\s+desktop/.test(originator)) evidence.push('header:originator=Codex Desktop');
  if (/codex\s+desktop|codex_chatgpt_ios_remote/.test(ua)) evidence.push('header:user-agent~codex-desktop');
  if (/codex[-_]?tui/.test(originator)) evidence.push('header:originator=codex-tui');
  if (/codex[-_]?tui/.test(ua)) evidence.push('header:user-agent~codex-tui');
  if (/codex_cli_rs/.test(ua)) evidence.push('header:user-agent~codex_cli_rs');
  if (metadata) evidence.push('header:x-codex-turn-metadata');
  if (windowId) evidence.push('header/body:x-codex-window-id');

  if (evidence.length === 0 && !/codex/.test(haystack)) return undefined;
  if (evidence.length === 0) evidence.push('header~codex');

  const desktop = evidence.some(item => item.includes('Codex Desktop') || item.includes('codex-desktop'));
  const vscode = desktop || evidence.some(item => item.includes('codex_vscode') || item.includes('x-codex-window-id'));
  const source = vscode ? 'codex-vscode' : 'codex-cli';
  return {
    family: 'codex',
    surface: desktop ? 'desktop' : (vscode ? 'vscode' : 'cli'),
    source,
    client: 'ChatGPT',
    confidence: evidence.some(item => item.includes('originator') || item.includes('x-codex-turn-metadata') || item.includes('x-codex-window-id'))
      ? 'strong'
      : 'medium',
    evidence
  };
}

export function refineCodexSource(headers: HeaderBag): 'codex-cli' | 'codex-vscode' {
  return identifyCodex(headers, undefined)?.source === 'codex-vscode' ? 'codex-vscode' : 'codex-cli';
}

function codexClientMetadata(body: unknown, key: string): string {
  if (!body || typeof body !== 'object') return '';
  const metadata = (body as Record<string, unknown>).client_metadata;
  if (!metadata || typeof metadata !== 'object') return '';
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}
