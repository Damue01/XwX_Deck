import type { ProviderSnapshot } from './providers';
export type ConfigurationImportSource = 'magpie' | 'cc-switch' | 'claude' | 'codex';
export interface ConfigurationImportSpec { readonly source: ConfigurationImportSource; readonly path: string; }
export interface ConfigurationImportItem {
  readonly fingerprint: string; readonly name: string; readonly baseUrl: string; readonly adapter: string;
  readonly status: 'new' | 'paused' | 'existing' | 'unsupported'; readonly reason: string;
}
export interface ConfigurationImportPreview {
  readonly targetDigest: string;
  readonly sources: readonly (ConfigurationImportSpec & { readonly name: string; readonly found: boolean; readonly error: string; readonly items: readonly ConfigurationImportItem[] })[];
}
export interface ConfigurationImportInput { readonly sources?: readonly ConfigurationImportSpec[]; }
export interface AppliedConfigurationImport { readonly providers: ProviderSnapshot; readonly added: readonly string[]; }
