// Shared data shapes for the window.xwxDeck bridge surface.
// All types are plain serialisable objects; nothing from Electron is imported here.
import type { ProviderPresetId } from '../../shared/providerProfiles';
import type { CodexConversationHealthReport } from '../../shared/codexConversationHealth';
export type {
  CodexConversationDatabaseHealth,
  CodexConversationHealthReport,
  CodexConversationHealthRow,
  CodexConversationHealthStatus,
  CodexConversationIssue,
  CodexConversationIssueCode,
  CodexRolloutLocation
} from '../../shared/codexConversationHealth';

export type ClientId = 'claude-cli' | 'codex-cli';

// ---- Update ----------------------------------------------------------------

export type UpdateStatus =
  | 'idle' | 'checking' | 'up-to-date' | 'available'
  | 'downloading' | 'ready' | 'installing' | 'error' | 'portable';

export interface XwXDeckUpdateState {
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
  readonly supported: boolean;
  readonly launchHidden: boolean;
  readonly executableWillLaunchAtLogin?: boolean;
}

// ---- Runtime state ---------------------------------------------------------

export interface ClientStateRow {
  readonly id: ClientId;
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
  readonly externalTracePort?: number;
  readonly sessions: number;
  readonly traces: number;
  readonly storageText: string;
  readonly clients: readonly ClientStateRow[];
  readonly lastError?: string;
  readonly theme: AppTheme;
  readonly traceAppearance: TraceAppearanceSnapshot;
  readonly startup?: StartupSettingsSnapshot;
  readonly update?: XwXDeckUpdateState;
}

export interface AppNotice {
  readonly message: string;
  readonly type?: 'success' | 'error' | 'info';
}

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

// ---- Codex config ----------------------------------------------------------

export type CodexConfigMode = 'official' | 'compatible';
export type CodexAuthMode = 'chatgpt' | 'api-key' | 'unknown';

export interface CodexConfigSnapshot {
  readonly configPath: string;
  readonly authPath: string;
  readonly exists: boolean;
  readonly mode: CodexConfigMode;
  readonly authMode: CodexAuthMode;
  readonly activeProvider: string;
  readonly activeBaseUrl: string;
  readonly officialModel: string;
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

// ---- XwX Deck API surface -------------------------------------------------

export interface XwXDeckApi {
  // State
  getState(): Promise<XwXDeckRuntimeState>;
  getTraceStats(): Promise<ManagerTraceStats>;
  getUpdateState(): Promise<XwXDeckUpdateState>;
  checkForUpdates(): Promise<XwXDeckUpdateState>;
  downloadUpdate(): Promise<XwXDeckUpdateState>;
  restartAndInstall(): Promise<XwXDeckUpdateState>;
  setStartupEnabled(enabled: boolean): Promise<XwXDeckRuntimeState>;
  setTheme(theme: AppTheme): Promise<XwXDeckRuntimeState>;
  setTraceAppearance(payload: Partial<Omit<TraceAppearanceSnapshot, 'customImageUrl'>>): Promise<XwXDeckRuntimeState>;
  chooseTraceBackground(): Promise<XwXDeckRuntimeState | undefined>;
  clearTraceBackground(): Promise<XwXDeckRuntimeState>;
  repairApplication(): Promise<{ removedCachePaths: number; removedBytes: number; refreshedModels?: number }>;
  resetApplication(payload: { resetClientConfigs: boolean }): Promise<void>;
  toggleTracing(): Promise<XwXDeckRuntimeState>;
  toggleClient(client: ClientId): Promise<XwXDeckRuntimeState>;

  // Codex / ChatGPT
  getCodexConfig(): Promise<CodexConfigSnapshot>;
  isChatGptRunning(): Promise<boolean>;
  getCodexEnhancements(): Promise<CodexEnhancementsSnapshot>;
  updateCodexEnhancements(payload: Record<string, unknown>): Promise<CodexEnhancementsSnapshot>;
  updateCodexConfig(payload: Record<string, unknown>): Promise<CodexConfigSnapshot>;
  diagnoseCodexConversations(): Promise<CodexConversationHealthReport>;
  openCodexConversationPath(filePath: string): Promise<void>;
  copyText(value: string): Promise<void>;

  // 兼容服务
  getCompatibleServiceConfig(): Promise<CompatibleServiceConfigSnapshot>;
  updateCompatibleServiceConfig(payload: Record<string, unknown>): Promise<CompatibleServiceConfigSnapshot>;

  // Models
  getModelServices(): Promise<ModelServiceSnapshot>;
  setModelService(payload: { client: 'claude' | 'codex'; enabled: boolean }): Promise<ModelServiceSnapshot>;
  getClaudeModels(): Promise<ClaudeModelSettings>;
  updateClaudeModels(payload: Record<string, string>): Promise<ClaudeModelSettings>;
  fetchModels(payload?: {
    source?: 'compatible' | 'active';
    refresh?: boolean;
  }): Promise<readonly ModelCatalogEntry[]>;

  chooseDirectory(payload?: { kind?: 'trace' | 'logs' | 'claude' }): Promise<string | undefined>;
  updateTraceDirectories(payload: Record<string, unknown>): Promise<XwXDeckRuntimeState>;

  // Shell
  openDashboard(): Promise<void>;
  openDataFolder(): Promise<void>;
  openLogFolder(): Promise<void>;
  clearHistory(): Promise<XwXDeckRuntimeState>;
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
