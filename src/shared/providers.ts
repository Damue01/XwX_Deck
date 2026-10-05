import { type ProviderPresetId } from './providerProfiles';

/** User-owned connection registry. A fresh installation has no API connections. */
export type ProviderAdapter = 'auto' | 'responses' | 'chat-completions' | 'anthropic-messages';
export type ProviderClient = 'codex' | 'claude';
export interface ProviderConnection {
  readonly id: string;
  readonly codexProviderId?: string;
  readonly displayName: string;
  readonly providerPreset: ProviderPresetId;
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly adapter: ProviderAdapter;
  readonly codexApiFormat: 'responses' | 'chat-completions' | 'anthropic-messages';
  readonly codexModel: string;
  readonly codexContextWindow: number;
  readonly claudeModels: { readonly fable: string; readonly opus: string; readonly sonnet: string; readonly haiku: string };
}
export interface ProviderRegistry {
  readonly version: 1;
  readonly identityVersion?: 2;
  readonly connections: readonly ProviderConnection[];
  readonly selected: Readonly<Record<ProviderClient, string | null>>;
}
export interface ProviderSnapshot extends ProviderRegistry {
  readonly warning?: string;
  readonly active: Readonly<Record<ProviderClient, string | null>>;
}
export type ProviderValidationStatus =
  | 'valid'
  | 'suggestion'
  | 'authentication-error'
  | 'model-error'
  | 'reachable'
  | 'unavailable'
  | 'stale';
export interface ProviderValidationResult {
  readonly status: ProviderValidationStatus;
  readonly providerId: string;
  readonly providerName: string;
  readonly suggestedBaseUrl?: string;
  readonly suggestedAdapter?: Exclude<ProviderAdapter, 'auto'>;
  readonly suggestionReason?: 'base-url' | 'protocol';
}
export type ProviderInput = Pick<ProviderConnection, 'displayName' | 'baseUrl' | 'bearerToken' | 'adapter'> & {
  readonly id?: string;
  readonly providerPreset?: ProviderPresetId;
  readonly codexModel?: string;
};
export function supportsProviderClient(provider: ProviderConnection, client: ProviderClient): boolean {
  return client === 'codex' || ['auto', 'anthropic-messages', 'responses', 'chat-completions'].includes(provider.adapter);
}

export function providerNameError(name: string, previousName?: string): string | undefined {
  if (name === previousName && name.length > 0) return undefined;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) return '名称只能包含英文字母、数字、下划线和连字符，长度为 1–80 个字符。';
  if (['openai', 'xwx_deck'].includes(name.toLowerCase())) return '此名称由官方订阅或会话归并使用，请换一个名称。';
  return undefined;
}

/** Existing identities survive upgrades; only newly added/renamed connections use their name. */
export function providerCodexId(provider: Pick<ProviderConnection, 'displayName' | 'codexProviderId'>, unified = false): string {
  if (unified) return 'xwx_deck';
  return provider.codexProviderId || 'xwx_deck';
}

export function providerDirectConnections(providers: readonly ProviderConnection[] = []) {
  return providers.filter(provider => !!provider.baseUrl && !!provider.bearerToken).map(provider => ({
    providerId: providerCodexId(provider),
    providerName: provider.displayName,
    baseUrl: provider.baseUrl,
    bearerToken: provider.bearerToken,
    providerAdapter: provider.adapter
  }));
}
