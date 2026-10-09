import type { ProviderSnapshot, ProviderInput, ProviderClient, ProviderValidationResult } from '../../shared/providers';
import type { SetupWebsite, SetupWebsites } from '../../shared/setupWebsites';
// Shared data shapes for the window.xwxDeck bridge surface.
// All types are plain serialisable objects; nothing from Electron is imported here.
import type { ProviderPresetId } from '../../shared/providerProfiles';
export interface TraceIndexRepairCandidate {
  readonly id: string;
  readonly jsonlPath: string;
  readonly validRecords: number;
  readonly malformedRecords: number;
}

export interface TraceIndexRepairPlan {
  readonly rootPath: string;
  readonly indexPath: string;
  readonly indexStatus: 'valid' | 'missing' | 'invalid';
  readonly indexSha256: string;
  readonly indexedSessions: number;
  readonly needsRepair?: boolean;
  readonly unindexedFiles?: readonly string[];
  readonly staleIndexedFiles?: readonly string[];
  readonly jsonlFiles: number;
  readonly missingIndexedFiles: readonly string[];
  readonly candidates: readonly TraceIndexRepairCandidate[];
}

export interface AppliedTraceIndexRepair extends TraceIndexRepairPlan {
  readonly applied: true;
  readonly backupIndexPath?: string;
  readonly recoveredSessions: number;
}

export type ClientId = 'claude-cli' | 'codex-cli';

// ---- Update ----------------------------------------------------------------

export type UpdateStatus =
  | 'idle' | 'checking' | 'up-to-date' | 'available'
  | 'downloading' | 'ready' | 'installing' | 'error' | 'portable';

export interface XwXDeckUpdateState {
  readonly background?: boolean;
  readonly status: UpdateStatus;
  readonly currentVersion: string;
  readonly targetVersion?: string;
  readonly channel: 'release';
  readonly portable: boolean;
  readonly installMode: 'automatic' | 'manual-dmg';
  readonly supported: boolean;
  readonly updateAvailable: boolean;
  readonly releaseNotes?: string;
  readonly releaseDate?: string;
  readonly size?: number;
  readonly percent?: number;
  readonly transferred?: number;
  readonly total?: number;
  readonly bytesPerSecond?: number;
  readonly error?: string;
}

// ---- Startup ---------------------------------------------------------------

export type AppTheme = 'day' | 'night';
export type TraceSkin = 'classic' | 'clean' | 'custom';
export type TraceBackgroundFit = 'cover' | 'contain';

export interface TraceAppearanceSnapshot {
  readonly skin: TraceSkin;
  readonly showThroughput: boolean;
  readonly customImageFile: string;
  readonly customImageUrl?: string;
  readonly customImageFit: TraceBackgroundFit;
  readonly customImageOverlay: number;
}

export interface StartupSettingsSnapshot {
  readonly enabled: boolean;
  readonly desiredEnabled?: boolean;
  readonly warning?: string;
  readonly supported: boolean;
  readonly launchHidden: boolean;
  readonly executableWillLaunchAtLogin?: boolean;
}

// ---- Runtime state ---------------------------------------------------------

export interface ClientStateRow {
  readonly id: ClientId | import("../../shared/clientDownloads").DownloadClientId;
  readonly label: string;
  readonly enabled: boolean;
  readonly status: 'idle' | 'taken' | 'skipped' | 'off';
  readonly statusText: string;
  readonly detail: string;
}

export type StartupPhase =
  | 'idle'
  | 'proxy-listening'
  | 'routes-ready'
  | 'config-ready'
  | 'ready'
  | 'degraded';

export interface TraceRuntimeReadiness {
  readonly startupPhase: StartupPhase;
  readonly proxyListening: boolean;
  readonly recordingEnabled: boolean;
  readonly claudeConfigReady: boolean;
  readonly claudeRouteReady: boolean;
  readonly codexConfigReady: boolean;
  readonly codexRouteReady: boolean;
  readonly codexGatewayEnabled: boolean;
}

export interface XwXDeckRuntimeState {
  readonly missingCodexHistoryProviders?: readonly string[];
  readonly connectionNotice?: import('../../shared/lifecycleNotice').LifecycleNotice;
  readonly traceTransition?: 'starting' | 'stopping';
  readonly lifecycleNotice?: import('../../shared/lifecycleNotice').LifecycleNotice;
  readonly tracingEnabled: boolean;
  readonly readiness: TraceRuntimeReadiness;
  readonly role?: 'owner' | 'follower';
  readonly localBaseUrl?: string;
  readonly traceRoot: string;
  readonly logRoot: string;
  readonly claudeConfigDir: string;
  readonly claudeConfigPath: string;
  readonly dashboardUrl?: string;
  readonly backgroundGatewayActive: boolean;
  readonly backgroundGatewayAction?: 'close' | 'open';
  readonly chatGptRestartRecommended: boolean;
  /** Claude Desktop must restart to use (`local`) or leave (`direct`) Deck's Gateway. */
  readonly claudeDesktopRestart?: 'local' | 'direct';
  readonly externalTracePort?: number;
  readonly sessions: number;
  readonly traces: number;
  readonly storageText: string;
  readonly traceStorageBytes: number;
  readonly traceWarningGB: number;
  readonly traceAutoCleanup: boolean;
  readonly traceStorageNotice?: string;
  readonly clients: readonly ClientStateRow[];
  readonly lastError?: string;
  readonly theme: AppTheme;
  readonly automaticUpdates?: boolean;
  readonly language?: import('@/lib/i18n').Language | null;
  readonly traceAppearance: TraceAppearanceSnapshot;
  readonly startup?: StartupSettingsSnapshot;
  readonly update?: XwXDeckUpdateState;
}

export type AppNotice = import('../../shared/lifecycleNotice').LifecycleNotice;

// ---- Trace stats -----------------------------------------------------------

export interface TraceStatsPeriod {
  readonly tokens: number;
  readonly costUsd: number;
  readonly costComplete: boolean;
}

export interface TraceStatsPoint {
  readonly at: string;
  readonly tokens: number;
  readonly tokPerSec?: number;
}

export interface ManagerTraceStats {
  readonly total: TraceStatsPeriod;
  readonly today: TraceStatsPeriod;
  readonly week: TraceStatsPeriod;
  readonly series: readonly TraceStatsPoint[];
}

// ---- Model services --------------------------------------------------------

export interface ModelServiceSnapshot {
  readonly claude: boolean;
  readonly codex: boolean;
  readonly claudeStatus: {
    readonly enabled: boolean;
    readonly configPath: string;
    readonly status: 'disabled' | 'active' | 'drifted' | 'invalid' | 'path-mismatch';
    readonly expectedBaseUrl?: string;
    readonly actualBaseUrl?: string;
    readonly detail?: string;
    readonly traceManaged: boolean;
    readonly liveBaseUrl?: string;
  };
}

export interface ClaudeEnvironmentOverride {
  readonly name: string;
  readonly scopes: readonly ('process' | 'user' | 'machine')[];
  readonly canRemoveAutomatically: boolean;
}

export interface ClaudeEnvironmentOverrideSnapshot {
  readonly platform: 'windows' | 'other';
  readonly overrides: readonly ClaudeEnvironmentOverride[];
  readonly canRemoveAutomatically: boolean;
}

export interface ClaudeEnvironmentCleanupResult extends ClaudeEnvironmentOverrideSnapshot {
  readonly backupPath?: string;
}

// ---- Codex config ----------------------------------------------------------

export type CodexConfigMode = 'official' | 'compatible';
export type CodexAuthMode = 'chatgpt' | 'api-key' | 'unknown';

export interface CodexConfigSnapshot {
  readonly warning?: string;
  readonly configPath: string;
  readonly authPath: string;
  readonly exists: boolean;
  readonly mode: CodexConfigMode;
  readonly authMode: CodexAuthMode;
  readonly activeProvider: string;
  readonly activeBaseUrl: string;
  readonly officialModel: string;
  readonly modelCatalogSource: 'none' | 'xwx' | 'external';
  /** Authoritative verdict from the main process; absent means "not evaluated". */
  readonly configOwnership?: 'deck' | 'external';
  readonly modelContextWindow?: number;
  readonly compatible: {
    readonly provider: string;
    readonly model: string;
    readonly baseUrl: string;
    readonly bearerToken: string;
  };
}

export interface CodexEnhancementsSnapshot {
  readonly preserveOfficialLogin: boolean;
  readonly authMode: CodexAuthMode;
  readonly unifySessionHistory: boolean;
  readonly historyRestorePending: boolean;
  readonly hasHistoryBackup: boolean;
  readonly history?: {
    readonly migratedJsonlFiles: number;
    readonly migratedStateRows: number;
    readonly restoredJsonlFiles: number;
    readonly restoredStateRows: number;
    readonly skippedLockedJsonlFiles: number;
    readonly skippedLockedStateDbs: number;
    readonly skippedReason?: 'no_matching_history' | 'no_backup_ledger' | 'nothing_to_restore' | 'locked_history' | 'live_not_target' | 'restore_deferred';
  };
}

// ---- 兼容服务 config -------------------------------------------------------

export interface CompatibleServiceConfigSnapshot {
  readonly displayName: string;
  readonly providerPreset: ProviderPresetId;
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly codexApiFormat: 'responses' | 'chat-completions' | 'anthropic-messages';
}

// ---- Claude models ---------------------------------------------------------

export interface ClaudeModelSettings {
  readonly fable: string;
  readonly opus: string;
  readonly sonnet: string;
  readonly haiku: string;
}

export interface ClaudeDesktopSyncSnapshot {
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly active: boolean;
  readonly modelCount: number;
  readonly configPath?: string;
  readonly detail?: string;
}

// ---- Model catalog ---------------------------------------------------------

export type ModelProtocol =
  | 'anthropic-messages' | 'openai-responses' | 'chat-completions' | 'gemini';
export type ModelClient = 'claude' | 'codex';
export type ModelCapabilitySource = 'compatible' | 'official' | 'models.dev' | 'litellm' | 'builtin' | 'fallback';
export type ModelCapabilityField =
  | 'contextWindow'
  | 'maxOutputTokens'
  | 'inputModalities'
  | 'vision'
  | 'reasoning'
  | 'toolCalling'
  | 'structuredOutput'
  | 'interleavedThinking';

export interface ModelCatalogEntry {
  readonly id: string;
  readonly vendor: string;
  readonly protocols: readonly ModelProtocol[];
  readonly protocolsDeclared?: boolean;
  readonly catalogEndpoints?: readonly ('openai' | 'anthropic' | 'gemini')[];
  readonly officialProtocols?: readonly ModelProtocol[];
  readonly vision?: boolean;
  readonly clients: readonly ModelClient[];
  readonly reasoningLevels?: readonly string[];
  readonly defaultReasoningLevel?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly inputModalities?: readonly string[];
  readonly reasoning?: boolean;
  readonly toolCalling?: boolean;
  readonly structuredOutput?: boolean;
  readonly interleavedThinking?: boolean;
  readonly capabilitySources?: Partial<Record<ModelCapabilityField, ModelCapabilitySource>>;
  readonly missingCapabilities?: readonly ModelCapabilityField[];
}

// ---- Window state ----------------------------------------------------------

export interface WindowState {
  readonly fullscreen: boolean;
  readonly maximized: boolean;
  readonly nativeFrame: boolean;
}

export interface TraceRetentionRepairResult {
  readonly legacyLimitsFound: boolean;
  readonly persistedSettingsChanged: boolean;
  readonly settings: {
    readonly maxSessions: 0;
    readonly maxStorageMB: 0;
  };
  readonly helper:
    | {
        readonly state: 'verified';
        readonly maxSessions: 0;
        readonly maxStorageBytes: number;
      }
    | { readonly state: 'not-running' }
    | { readonly state: 'unverified'; readonly reason: string };
}


// ---- XwXDeck API surface -------------------------------------------------

export interface GatewayClientRoute {
  readonly client: string;
  readonly providerId: string | null;
  readonly model: string;
  readonly enabled: boolean;
  readonly automatic: boolean;
  readonly baseUrl: string | null;
  readonly configDigest: string;
  readonly requiresTakeover: boolean;
  readonly configPaths: readonly string[];
}

export interface XwXDeckApi {
  getClientRoute?(client: string): Promise<GatewayClientRoute>;
  setClientRoute?(input: { client: string; providerId: string; model: string; configDigest: string; takeoverConfirmed?: boolean }): Promise<GatewayClientRoute>;
  toggleGatewayClient?(client: string): Promise<XwXDeckRuntimeState>;
  previewConfigurationImport?(input?: import('../../shared/configImport').ConfigurationImportInput): Promise<import('../../shared/configImport').ConfigurationImportPreview>;
  importConfigurations?(input: import('../../shared/configImport').ConfigurationImportInput & { targetDigest: string; fingerprints: readonly string[] }): Promise<import('../../shared/configImport').AppliedConfigurationImport>;
  chooseConfigurationImportFile?(): Promise<string | null>;
  detectClientInstallations?(): Promise<import('../../shared/clientDownloads').ClientInstallationSnapshot>;
  getModelClients?(): Promise<readonly import('../../shared/clientDownloads').DownloadClientId[]>;
  addModelClient?(id: import('../../shared/clientDownloads').DownloadClientId): Promise<readonly import('../../shared/clientDownloads').DownloadClientId[]>;
  removeModelClient?(id: import('../../shared/clientDownloads').DownloadClientId): Promise<readonly import('../../shared/clientDownloads').DownloadClientId[]>;
  setSubscriptionRouting?(input: { platform: import('../../shared/subscriptionAccounts').SubscriptionPlatform; policy: import('../../shared/subscriptionAccounts').SubscriptionRoutingPolicy }): Promise<import('../../shared/subscriptionAccounts').SubscriptionAccountsSnapshot>;
  refreshSubscriptionUsage?(input: { platform: import('../../shared/subscriptionAccounts').SubscriptionPlatform }): Promise<import('../../shared/subscriptionAccounts').SubscriptionAccountsSnapshot>;
  getSubscriptionAccounts?(): Promise<import('../../shared/subscriptionAccounts').SubscriptionAccountsSnapshot>;
  beginSubscriptionSignIn?(input: { accountId?: string; platform?: 'chatgpt' | 'grok' | 'copilot' | 'claude' | 'cursor' }): Promise<import('../../shared/subscriptionAccounts').SubscriptionAccountsSnapshot>;
  renameSubscriptionAccount?(input: { accountId: string; label: string }): Promise<ProviderSnapshot>;
  cancelSubscriptionSignIn?(): Promise<import('../../shared/subscriptionAccounts').SubscriptionAccountsSnapshot>;
  connectSubscriptionAccount?(id: string): Promise<ProviderSnapshot>;
  signOutSubscriptionAccount?(id: string): Promise<{ revoked: boolean; warning?: string }>;
  openSubscriptionUsage?(platform?: 'chatgpt' | 'grok' | 'copilot' | 'claude' | 'cursor'): Promise<void>;
  readonly setupWebsites: SetupWebsites;
  openSetupWebsite(site: SetupWebsite): Promise<void>;
  getProviders(): Promise<ProviderSnapshot>;
  saveProvider(input: ProviderInput): Promise<ProviderSnapshot>;
  deleteProvider(id: string): Promise<ProviderSnapshot>;
  switchClientProvider(input: {
    client: ProviderClient;
    providerId: string | null;
    takeOverExternalConfig?: boolean;
  }): Promise<ProviderSnapshot>;
  fetchProviderModels(input: { providerId: string; refresh?: boolean }): Promise<readonly ModelCatalogEntry[]>;
  getClaudeEnvironmentOverrides(): Promise<ClaudeEnvironmentOverrideSnapshot>;
  clearClaudeEnvironmentOverrides(input: { names: readonly string[] }): Promise<ClaudeEnvironmentCleanupResult>;
  // State
  getState(): Promise<XwXDeckRuntimeState>;
  getTraceStats(): Promise<ManagerTraceStats>;
  getUpdateState(): Promise<XwXDeckUpdateState>;
  checkForUpdates(): Promise<XwXDeckUpdateState>;
  downloadUpdate(): Promise<XwXDeckUpdateState>;
  restartAndInstall(): Promise<XwXDeckUpdateState>;
  cancelUpdate(): Promise<XwXDeckUpdateState>;
  setStartupEnabled(enabled: boolean): Promise<XwXDeckRuntimeState>;
  setAutomaticUpdates?(enabled: boolean): Promise<XwXDeckRuntimeState>;
  setLanguage?(language: import('@/lib/i18n').Language): Promise<XwXDeckRuntimeState>;
  setTheme(theme: AppTheme): Promise<XwXDeckRuntimeState>;
  setTraceAppearance(payload: Partial<Omit<TraceAppearanceSnapshot, 'customImageUrl'>>): Promise<XwXDeckRuntimeState>;
  chooseTraceBackground(): Promise<XwXDeckRuntimeState | undefined>;
  clearTraceBackground(): Promise<XwXDeckRuntimeState>;
  repairApplication(): Promise<{
    removedCachePaths: number;
    removedBytes: number;
    chromiumCacheCleared: boolean;
    refreshedModels?: number;
    traceRetention: TraceRetentionRepairResult;
  }>;
  repairUnreadableSettings(): Promise<{ backupPath: string; lostProviderSettings: boolean }>;
  repairInvalidCodexConfiguration(): Promise<{
    backupPath: string;
    mode: 'official' | 'compatible';
    conflicts: readonly string[];
  }>;
  repairClientProviderSwitch(input: { client: 'claude' | 'codex'; providerId: string | null }): Promise<ProviderSnapshot>;
  resetApplication(payload: { resetClientConfigs: boolean }): Promise<void>;
  toggleTracing(enabled?: boolean, force?: boolean): Promise<XwXDeckRuntimeState>;
  toggleClient(client: ClientId): Promise<XwXDeckRuntimeState>;

  // Codex / ChatGPT
  getCodexConfig(): Promise<CodexConfigSnapshot>;
  isChatGptRunning(): Promise<boolean>;
  getCodexEnhancements(): Promise<CodexEnhancementsSnapshot>;
  updateCodexEnhancements(payload: Record<string, unknown>): Promise<CodexEnhancementsSnapshot>;
  updateCodexConfig(payload: Record<string, unknown>): Promise<CodexConfigSnapshot>;
  copyText(value: string): Promise<void>;

  // 兼容服务
  getProviders(): Promise<ProviderSnapshot>;
  saveProvider(input: ProviderInput): Promise<ProviderSnapshot>;
  deleteProvider(id: string): Promise<ProviderSnapshot>;
  switchClientProvider(input: { client: ProviderClient; providerId: string | null }): Promise<ProviderSnapshot>;
  fetchProviderModels(input: { providerId: string; refresh?: boolean }): Promise<readonly ModelCatalogEntry[]>;
  validateProvider(input: { providerId: string; model?: string }): Promise<ProviderValidationResult>;
  getCompatibleServiceConfig(): Promise<CompatibleServiceConfigSnapshot>;
  updateCompatibleServiceConfig(payload: Record<string, unknown>): Promise<CompatibleServiceConfigSnapshot>;

  // Models
  getModelServices(): Promise<ModelServiceSnapshot>;
  setModelService(payload: { client: 'claude' | 'codex'; enabled: boolean }): Promise<ModelServiceSnapshot>;
  getClaudeModels(): Promise<ClaudeModelSettings>;
  updateClaudeModels(payload: Partial<ClaudeModelSettings> & { expectedProviderId?: string | null }): Promise<ClaudeModelSettings>;
  getClaudeDesktopSync(): Promise<ClaudeDesktopSyncSnapshot>;
  updateClaudeDesktopSync(enabled: boolean): Promise<ClaudeDesktopSyncSnapshot>;
  fetchModels(payload?: {
    source?: 'compatible' | 'active';
    refresh?: boolean;
    expectedProviderId?: string | null;
  }): Promise<readonly ModelCatalogEntry[]>;

  chooseDirectory(payload?: { kind?: 'trace' | 'logs' | 'claude' }): Promise<string | undefined>;
  updateTraceDirectories(payload: Record<string, unknown>): Promise<XwXDeckRuntimeState>;

  // Shell
  openDashboard(): Promise<void>;
  openDataFolder(): Promise<void>;
  openLogFolder(): Promise<void>;
  clearHistory(): Promise<XwXDeckRuntimeState>;
  setTraceStoragePolicy(input: { limitGB?: number; autoCleanup?: boolean }): Promise<XwXDeckRuntimeState>;
  inspectTraceIndexRepair(): Promise<TraceIndexRepairPlan>;
  applyTraceIndexRepair(expectedIndexSha256?: string): Promise<AppliedTraceIndexRepair>;
  /** True when stopping tracing would break the active ChatGPT (chat-completions bridge) model. */
  disableBreaksCodex(): Promise<boolean>;
  refresh(): Promise<XwXDeckRuntimeState>;

  // Window controls
  minimizeWindow(): Promise<void>;
  toggleFullscreen(): Promise<{ fullscreen: boolean }>;
  toggleMaximize(): Promise<{ maximized: boolean; fullscreen: boolean }>;
  setManagerView(view: 'home' | 'settings'): Promise<boolean>;
  closeWindow(): Promise<void>;
  moveWindowStart(payload: { screenX: number; screenY: number }): void;
  moveWindow(payload: { screenX: number; screenY: number }): void;
  moveWindowEnd(): void;
  resizeWindowStart(payload: { edge: string; screenX: number; screenY: number }): void;
  resizeWindowMove(payload: { screenX: number; screenY: number }): void;
  resizeWindowEnd(): void;

  // Event subscriptions (return unsubscribe function)
  onState(listener: (state: XwXDeckRuntimeState) => void): () => void;
  onWindowState(listener: (state: WindowState) => void): () => void;
  onUpdateState(listener: (state: XwXDeckUpdateState) => void): () => void;
  onShowUpdateDetails(listener: () => void): () => void;
  onNotice(listener: (notice: AppNotice) => void): () => void;
}
