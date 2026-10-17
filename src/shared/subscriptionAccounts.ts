/** OAuth secrets are held by the native host; this is deliberately metadata only. */
export const SUBSCRIPTION_USAGE_WEBSITES = {
  'subscription-chatgpt-usage': 'https://chatgpt.com/settings/usage',
  'subscription-grok-usage': 'https://grok.com/settings',
  'subscription-copilot-usage': 'https://github.com/settings/copilot',
  'subscription-claude-usage': 'https://claude.ai/settings/usage',
  'subscription-cursor-usage': 'https://cursor.com/dashboard'
} as const;

export type SubscriptionPlatform = 'chatgpt' | 'grok' | 'copilot' | 'claude' | 'cursor';
export type SubscriptionRoutingGroup = SubscriptionPlatform | 'chatgpt-official';
export type SubscriptionStrategy = 'exhaust' | 'most-remaining' | 'reset-soon' | 'balanced' | 'fixed';
export interface SubscriptionRoutingPolicy {
  readonly strategy: SubscriptionStrategy;
  readonly fixedAccountId: string;
  readonly excludedAccountIds: readonly string[];
  readonly accountOrder?: readonly string[];
}
export interface SubscriptionAccount {
  readonly id: string;
  readonly label: string;
  readonly email: string;
  readonly status: 'connected' | 'signed-out';
  readonly authKind?: 'official' | 'api';
  readonly externalLogin?: boolean;
  readonly importedLogin?: boolean;
  /** Bound source-login state; unreadable metadata is distinct from confirmed expiry. */
  readonly sourceLogin?: 'authenticated' | 'unauthenticated' | 'unknown';
  readonly sourceError?: string | null;
  readonly accountKey?: string;
  readonly quota?: { remainingPercent: number; resetsAt: number; checkedAt: number };
  readonly quotaError?: string;
  /** Display-only last read; never a routing-policy aggregate. */
  readonly quotaCached?: boolean;
  readonly quotaDetails?: {
    readonly source: string;
    readonly httpStatus: number | null;
    readonly checkedAt: number;
    readonly planType?: string | null;
    readonly ordinaryUsageAllowed?: boolean | null;
    readonly availableResetCredits?: number | null;
    readonly resetCredits?: readonly { readonly id: string; readonly expiresAt: number | null; readonly title: string; readonly status: string }[];
    readonly windows: readonly {
      readonly limitId: string;
      readonly limitName?: string | null;
      readonly planType?: string | null;
      readonly normalModelSlug?: string | null;
      readonly window: string;
      readonly usedPercent: number | null;
      readonly remainingPercent: number | null;
      readonly resetsAt: number | null;
      readonly windowSeconds: number | null;
      readonly allowed?: boolean | null;
      readonly limitReached?: boolean | null;
    }[];
  };
  readonly activeRequests?: number;
  readonly cooldownUntil?: number;
  readonly routingStatus?: string;
  readonly platform?: 'chatgpt' | 'grok' | 'copilot' | 'claude' | 'cursor';
}
export interface SubscriptionAccountsSnapshot {
  readonly supported?: boolean;
  readonly routing?: Partial<Record<SubscriptionRoutingGroup, SubscriptionRoutingPolicy>>;
  readonly officialLoginInstalled?: boolean;
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
    readonly authKind?: 'official' | 'api';
  } | null;
}
