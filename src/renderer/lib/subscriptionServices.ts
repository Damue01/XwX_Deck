import type { ProviderConnection } from '../../shared/providers';
import type { SubscriptionPlatform } from '../../shared/subscriptionAccounts';

export const subscriptionServiceNames: Record<SubscriptionPlatform, string> = {
  chatgpt: 'ChatGPT 订阅', claude: 'Claude 订阅', copilot: 'GitHub Copilot 订阅',
  grok: 'Grok 订阅', cursor: 'Cursor 订阅'
};

export function subscriptionPlatformForAccount(id: string): SubscriptionPlatform {
  return id.startsWith('cursor-') ? 'cursor' : id.startsWith('claude-subscription-') ? 'claude'
    : id.startsWith('copilot-') ? 'copilot' : id.startsWith('grok-') ? 'grok' : 'chatgpt';
}

export function subscriptionServiceIcon(id: string) {
  const platform = subscriptionPlatformForAccount(id);
  return platform === 'grok' ? 'xai' : platform;
}

/** Keep account IDs intact; grouping affects navigation only. */
export function groupSubscriptionConnections(connections: readonly ProviderConnection[], selectedId?: string, splitChatgptAuth = false): readonly ProviderConnection[] {
  const selected = connections.find(item => item.id === selectedId && item.subscriptionAccountId);
  const groupFor = (id: string) => splitChatgptAuth && id.startsWith('official-chatgpt') ? 'chatgpt-official' : subscriptionPlatformForAccount(id);
  const selectedPlatform = selected?.subscriptionAccountId ? groupFor(selected.subscriptionAccountId) : null;
  const seen = new Set<string>();
  const grouped: ProviderConnection[] = [];
  for (const item of connections) {
    if (!item.subscriptionAccountId) { grouped.push(item); continue; }
    const platform = groupFor(item.subscriptionAccountId);
    if (seen.has(platform)) continue;
    seen.add(platform);
    grouped.push(selectedPlatform === platform && selected ? selected : item);
  }
  return grouped;
}
