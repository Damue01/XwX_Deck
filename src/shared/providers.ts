import { providerProfile, type ProviderPresetId } from './providerProfiles';

/** User-owned connection registry. A fresh installation has no API connections. */
export type ProviderAdapter = 'auto' | 'responses' | 'chat-completions' | 'anthropic-messages';
export type ProviderClient = 'codex' | 'claude';
export interface ProviderConnection {
  readonly id: string;
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
  readonly connections: readonly ProviderConnection[];
  readonly selected: Readonly<Record<ProviderClient, string | null>>;
}
export interface ProviderSnapshot extends ProviderRegistry {
  readonly active: Readonly<Record<ProviderClient, string | null>>;
}
export type ProviderInput = Pick<ProviderConnection, 'displayName' | 'baseUrl' | 'bearerToken' | 'adapter'> & {
  readonly id?: string;
  readonly providerPreset?: ProviderPresetId;
  readonly codexModel?: string;
};
export function supportsProviderClient(provider: ProviderConnection, client: ProviderClient): boolean {
  return client === 'codex' || provider.adapter === 'anthropic-messages'
    || provider.adapter === 'auto' && providerProfile(provider.providerPreset).supportsClaude;
}
