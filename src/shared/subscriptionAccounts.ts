/** OAuth secrets are held by the native host; this is deliberately metadata only. */
export const SUBSCRIPTION_USAGE_WEBSITES = {
  'subscription-chatgpt-usage': 'https://chatgpt.com/settings/usage',
  'subscription-grok-usage': 'https://grok.com/settings',
  'subscription-copilot-usage': 'https://github.com/settings/copilot',
  'subscription-claude-usage': 'https://claude.ai/settings/usage',
  'subscription-cursor-usage': 'https://cursor.com/dashboard'
} as const;

export type SubscriptionPlatform = 'chatgpt' | 'grok' | 'copilot' | 'claude' | 'cursor';
export type SubscriptionStrategy = 'exhaust' | 'most-remaining' | 'reset-soon' | 'balanced' | 'fixed';
export interface SubscriptionRoutingPolicy {
  readonly strategy: SubscriptionStrategy;
  readonly fixedAccountId: string;
  readonly excludedAccountIds: readonly string[];
}
export interface SubscriptionAccount {
  readonly id: string;
  readonly label: string;
  readonly email: string;
  readonly status: 'connected' | 'signed-out';
  readonly quota?: { remainingPercent: number; resetsAt: number; checkedAt: number };
  readonly activeRequests?: number;
  readonly cooldownUntil?: number;
  readonly routingStatus?: string;
  readonly platform?: 'chatgpt' | 'grok' | 'copilot' | 'claude' | 'cursor';
}
export interface SubscriptionAccountsSnapshot {
  readonly supported?: boolean;
  readonly routing?: Partial<Record<SubscriptionPlatform, SubscriptionRoutingPolicy>>;
  readonly accounts: readonly SubscriptionAccount[];
  readonly grokInstalled?: boolean;
  readonly claudeInstalled?: boolean;
  readonly flow?: {
    readonly id: string;
    readonly status: 'waiting' | 'exchanging' | 'complete' | 'cancelled' | 'failed';
    readonly error?: string;
    readonly accountId?: string;
    readonly userCode?: string;
    readonly platform?: 'chatgpt' | 'grok' | 'copilot' | 'claude' | 'cursor';
  } | null;
}
