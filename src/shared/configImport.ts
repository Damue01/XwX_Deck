import type { ProviderSnapshot } from './providers';
import type { DownloadClientId } from './clientDownloads';
export type ConfigurationImportSource = 'magpie' | 'magpie-accounts' | 'codex-auth' | 'cc-switch' | 'claude' | 'codex' | 'xwx-deck' | 'auto' | 'opencode' | 'mimo-code' | 'pi' | 'crush' | 'droid' | 'codebuddy-code' | 'workbuddy' | 'qwen-code' | 'gemini-cli';
export interface ConfigurationImportSpec { readonly source: ConfigurationImportSource; readonly path: string; }
export interface ConfigurationImportItem {
  readonly fingerprint: string; readonly name: string; readonly baseUrl: string; readonly adapter: string;
  readonly accountKind?: 'official' | 'api';
  readonly status: 'new' | 'paused' | 'needs-login' | 'existing' | 'unsupported' | 'duplicate'; readonly reason: string;
}
export interface ConfigurationImportPreview {
  readonly targetDigest: string;
  readonly sources: readonly (ConfigurationImportSpec & { readonly name: string; readonly found: boolean; readonly error: string; readonly items: readonly ConfigurationImportItem[] })[];
}
export interface ConfigurationImportInput { readonly sources?: readonly ConfigurationImportSpec[]; }
export interface ConfigurationImportSelection extends ConfigurationImportInput {
  readonly targetDigest: string; readonly fingerprints: readonly string[];
  readonly clients?: readonly DownloadClientId[];
}
export interface AppliedConfigurationImport { readonly providers: ProviderSnapshot; readonly added: readonly string[]; readonly addedAccounts?: readonly string[]; readonly modelClients?: readonly DownloadClientId[]; readonly addedClients?: readonly DownloadClientId[]; }
