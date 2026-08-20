import { TapClientIdentity, TapTraceSource } from '../types';
import { extractSystemText, headerValue, type HeaderBag } from '../protocolBody';

export function identifyClaude(headers: HeaderBag, body: unknown): TapClientIdentity | undefined {
  const systemEntrypoint = detectClaudeEntrypoint(body);
  if (systemEntrypoint) {
    return claudeIdentity(systemEntrypoint, 'strong', [`body:cc_entrypoint=${systemEntrypoint === 'claude-vscode' ? 'claude-vscode' : 'claude-code'}`]);
  }

  const ua = headerValue(headers, 'user-agent').toLowerCase();
  const xApp = headerValue(headers, 'x-app').toLowerCase();
  const sessionId = headerValue(headers, 'x-claude-code-session-id');
  const evidence: string[] = [];

  if (/\bclaude[-_]vscode\b/.test(ua)) evidence.push('header:user-agent~claude-vscode');
  if (/\bclaude[-_]?cli\b/.test(ua)) evidence.push('header:user-agent~claude-cli');
  if (/\bclaude[-_\s]?code\b/.test(ua)) evidence.push('header:user-agent~claude-code');
  if (/\bclaude_cli_rs\b/.test(ua)) evidence.push('header:user-agent~claude_cli_rs');
  if (/\banthropic[-_]?sdk[-_a-z]*\b/.test(ua)) evidence.push('header:user-agent~anthropic-sdk');
  if (sessionId) evidence.push('header:x-claude-code-session-id');
  if (xApp === 'cli') evidence.push('header:x-app=cli');

  if (evidence.length === 0) return undefined;
  const source: TapTraceSource = evidence.some(item => item.includes('claude-vscode')) ? 'claude-vscode' : 'claude-cli';
  return claudeIdentity(source, evidence.some(item => item.includes('x-claude-code-session-id')) ? 'strong' : 'medium', evidence);
}

export function detectClaudeEntrypoint(body: unknown): 'claude-cli' | 'claude-vscode' | undefined {
  const text = extractSystemText(body);
  if (!text) return undefined;
  if (/\bcc_entrypoint\s*=\s*claude[-_]vscode\b/i.test(text)) return 'claude-vscode';
  if (/\bcc_entrypoint\s*=\s*claude[-_]?code\b/i.test(text)) return 'claude-cli';
  return undefined;
}

export function refineClaudeSource(body: unknown): 'claude-cli' | 'claude-vscode' {
  return detectClaudeEntrypoint(body) === 'claude-vscode' ? 'claude-vscode' : 'claude-cli';
}

function claudeIdentity(
  source: 'claude-cli' | 'claude-vscode',
  confidence: TapClientIdentity['confidence'],
  evidence: readonly string[]
): TapClientIdentity {
  return {
    family: 'claude',
    surface: source === 'claude-vscode' ? 'vscode' : 'cli',
    source,
    client: 'Claude',
    confidence,
    evidence
  };
}
