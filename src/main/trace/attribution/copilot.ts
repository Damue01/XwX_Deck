import { TapClientIdentity } from '../types';
import { headerValue, type HeaderBag } from '../protocolBody';

export function identifyCopilot(headers: HeaderBag): TapClientIdentity | undefined {
  const ua = headerValue(headers, 'user-agent').toLowerCase();
  const onBehalf = headerValue(headers, 'x-onbehalf-extension-id').toLowerCase();
  const evidence: string[] = [];

  if (ua.includes('githubcopilotchat')) evidence.push('header:user-agent=GitHubCopilotChat');
  if (onBehalf.includes('github.copilot-chat')) evidence.push('header:x-onbehalf-extension-id=github.copilot-chat');
  if (evidence.length === 0 && ua.includes('copilot')) evidence.push('header:user-agent~copilot');
  if (evidence.length === 0) return undefined;

  return {
    family: 'copilot',
    surface: 'vscode',
    source: 'copilot',
    client: 'Copilot',
    confidence: evidence.some(item => item.includes('GitHubCopilotChat') || item.includes('x-onbehalf-extension-id'))
      ? 'strong'
      : 'medium',
    evidence
  };
}
