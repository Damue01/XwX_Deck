import { CodexConversationDoctor } from './codexConversationDoctor';
import type { CodexConversationHealthReport } from '../../shared/codexConversationHealth';
import { validateProviderConnection } from './providerValidation';
import type { ProviderValidationResult } from '../../shared/providers';
import { applyTraceIndexRepair, inspectTraceIndexRepair, type AppliedTraceIndexRepair, type TraceIndexRepairPlan } from '../trace/traceIndexRepair';
import { providerProfile, normalizeProviderPreset, detectProviderPreset } from '../../shared/providerProfiles';
import { randomUUID, createHash } from 'crypto';
import type { ProviderConnection, ProviderClient, ProviderInput, ProviderSnapshot } from '../../shared/providers';
import type { ClaudeDesktopRestartHint } from '../../shared/lifecycleNotice';
import {
  providerNameError,
  providerCodexId,
  providerDirectConnections,
  supportsProviderClient
} from '../../shared/providers';
import { selectedProvider } from './settings';
import { fetchProviderCatalog } from './providerCatalog';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { EventEmitter } from 'events';
import { ClientBackupStore } from '../trace/clientBackupStore';
import { ClientFallbackStore, type ClientFallbackState } from '../trace/clientFallbackStore';
import {
  baseUrlHasV1Suffix,
  CODEX_CHATGPT_OAUTH_TARGET,
  CODEX_CHATGPT_OAUTH_PROVIDER_TARGET,
  CODEX_DEFAULT_TARGET,
  CODEX_STABLE_PROVIDER,
  detectClaudeUpstream,
  isXwXManagedProvider,
  isLoopbackUrl,
  resolveClientPaths
} from '../trace/clientConfig';
import { ClientConfigOrchestrator, ClientTakeoverResult } from '../trace/clientConfigOrchestrator';
import { ClientConfigWriter, ClientRestoreResult } from '../trace/clientConfigWriter';
import { ClaudeConfigManager, ClaudeCompatibleServiceSnapshot, claudeCompatibleServiceBaseUrl } from '../trace/claudeConfigManager';
import {
  ClaudeDesktopConfigManager,
  type ClaudeDesktopSyncSnapshot
} from '../trace/claudeDesktopConfigManager';
import {
  buildClaudeDesktopModelAliases,
  buildClaudeDesktopModels,
  isClaudeDesktopCompatibleModelId
} from '../trace/claudeDesktopModels';
import {
  CodexConfigManager,
  CodexAuthMode,
  CodexConfigSnapshot,
  CodexConfigUpdate,
  normalizeCompatibleServiceBaseUrl
} from '../trace/codexConfigManager';
import { CodexHistoryManager, CodexHistoryMigrationOutcome } from '../trace/codexHistoryManager';
import { CodexLocalProxyCoordinator } from '../trace/codexLocalProxyCoordinator';
import { CodexConversationPortability } from '../trace/codexConversationPortability';
import { CodexOfficialAuthManager } from '../trace/codexOfficialAuthManager';
import {
  restoreCodexPreferredDirectConfiguration as restorePreferredCodexDirect
} from '../trace/codexPreferredDirect';
import { CodexModelCatalogManager } from '../trace/codexModelCatalogManager';
import { CodexThreadTitleReader } from '../trace/codexThreadTitles';
import { CodexConversationWorkerClient } from './codexConversationWorkerClient';
import type {
  CodexConversationDetailRequest,
  CodexConversationHealthRow,
  CodexConversationPageRequest,
  CodexConversationPageResponse
} from '../../shared/codexConversationHealth';
import {
  CODEX_MAX_CONTEXT_WINDOW,
  CODEX_MIN_CONTEXT_WINDOW,
  CODEX_STANDARD_LONG_CONTEXT_WINDOW,
} from '../../shared/codexContextVariants';
import {
  resolveCodexConfigOwnership,
  type CodexConfigOwnership
} from '../../shared/codexConfigOwnership';
import { TapProxy } from '../trace/tapProxy';
import { GatewayProcessClient } from '../trace/gatewayProcessClient';
import type { GatewayTraceRetention } from '../trace/gatewayProtocol';
import { TraceProxy } from '../trace/traceProxy';
import {
  decideRoleOnEnable,
  deleteLock,
  probeLocalTcpPort,
  probeTapPort,
  readLock,
  tapPortCandidates,
  tryWriteLockExclusive,
  writeLock
} from '../trace/tapPortLock';
import { TraceStore } from '../trace/traceStore';
import { TapClientRoute, TapModelUsage, TapSessionTracePage } from '../trace/types';
import { estimateCostUsd, findModelPriceForUsage } from '../trace/pricing';
import { renderTapViewerHtml, TapViewerState } from '../trace/webview/viewerHtml';
import { log, setLogDirectory } from '../shared/logger';
import { parsePort } from '../shared/url';
import type { XwXDeckUpdateState } from '../update/xwxDeckUpdater';
import {
  fetchCompatibleServiceModelCatalog,
  ModelCatalogEntry,
  readCompatibleServiceModelCatalogCache,
  sameCachedModelCatalog,
  writeCompatibleServiceModelCatalogCache
} from './modelCatalog';
import { findBuiltInModelCapability } from './builtInModelCapabilityRegistry';
import { readCodexOfficialModelCatalog } from './codexOfficialModelCatalog';
import {
  CodexProtocol,
  isKnownNonConversationalModel,
  isOfficialCodexModelId,
  resolveClaudeModelProtocol,
  resolveProviderCodexProtocol,
  providerRequiresTrace
} from './codexProtocolPolicy';
import {
  ClaudeModelSettings,
  XwXDeckSettings,
  XwXDeckSettingsStore,
  CompatibleServiceSettings,
  AppTheme,
  TraceAppearanceSettings
} from './settings';
import type { StartupSettingsSnapshot } from './startup';
import { isChatGptRunning, isClaudeDesktopRunning, isClaudeRunning } from './chatGptLifecycle';

type Role = 'owner' | 'follower';
export type ClientId = 'claude-cli' | 'codex-cli';
type ChatGptConnectionIssue = 'failed' | 'unsupported';

export interface ShutdownModelDependency {
  readonly clientName: 'ChatGPT' | 'Claude';
  readonly model: string;
}

const RECOVERED_OFFICIAL_MODEL = 'gpt-5.6-sol';

export interface XwXDeckRuntimeState {
  readonly connectionNotice?: import('../../shared/lifecycleNotice').LifecycleNotice;
  readonly traceTransition?: 'starting' | 'stopping';
  readonly lifecycleNotice?: import('../../shared/lifecycleNotice').LifecycleNotice;
  readonly tracingEnabled: boolean;
  readonly readiness: TraceRuntimeReadiness;
  readonly role?: Role;
  readonly localBaseUrl?: string;
  readonly traceRoot: string;
  readonly logRoot: string;
  readonly claudeConfigDir: string;
  readonly claudeConfigPath: string;
  readonly dashboardUrl?: string;
  readonly backgroundGatewayActive: boolean;
  readonly backgroundGatewayAction?: 'close' | 'open';
  readonly chatGptRestartRecommended: boolean;
  /** Claude Desktop was running when its profile moved to (`local`) or away
   * from (`direct`) Deck's Gateway; it reads the new address after a restart. */
  readonly claudeDesktopRestart?: ClaudeDesktopRestartHint;
  /** XwX-managed provider sections referenced by history but absent from config.toml. */
  readonly missingCodexHistoryProviders: readonly string[];
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
  /** 持久化的夜间/白天主题；随状态下发给渲染进程作为权威值。 */
  readonly theme: AppTheme;
  readonly traceAppearance: TraceAppearanceSettings & {
    readonly customImageUrl?: string;
  };
  readonly startup?: StartupSettingsSnapshot;
  readonly update?: XwXDeckUpdateState;
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

interface EnableRollbackSnapshot {
  readonly managedDataPlane: boolean;
  readonly codexGatewayEnabled: boolean;
  readonly codexGatewayMode: 'official' | 'compatible' | undefined;
  readonly codexProviderIdentity: string | undefined;
  readonly settings: XwXDeckSettings;
  readonly active: boolean;
  readonly recording: boolean;
  readonly listening: boolean;
  readonly role: Role | undefined;
  readonly followerPort: number | undefined;
  readonly startupPhase: StartupPhase;
  readonly clientTakeovers: readonly ClientTakeoverResult[];
  readonly clientFallbacks: readonly ClientTakeoverResult[];
  readonly clientsSeen: readonly ClientId[];
  readonly chatGptConnectionIssue: ChatGptConnectionIssue | undefined;
  readonly chatGptRestartRecommended: boolean;
  readonly lastError: string | undefined;
}

interface ClientToggleRollbackSnapshot {
  readonly settings: XwXDeckSettings;
  readonly clientTakeovers: readonly ClientTakeoverResult[];
  readonly clientFallbacks: readonly ClientTakeoverResult[];
  readonly chatGptConnectionIssue: ChatGptConnectionIssue | undefined;
  readonly chatGptRestartRecommended: boolean;
  readonly lastError: string | undefined;
}

export interface XwXDeckControllerOptions {
  readonly proxyListenPorts?: readonly number[];
  readonly disableBackgroundModelRefresh?: boolean;
  readonly onStartupPhase?: (phase: StartupPhase) => void;
  readonly shutdownDrainTimeoutMs?: number;
  readonly shutdownQuietPeriodMs?: number;
  /** Test-only synchronization point for deterministic shutdown race coverage. */
  readonly beforeShutdownConfigVerification?: () => Promise<void>;
  /** Test-only failure point after Trace intent is persisted but before client writes. */
  readonly beforeEnableClientApply?: () => Promise<void>;
  /** Test-only failure point while reapplying active services to a saved connection. */
  readonly beforeCompatibleServiceServiceReapply?: (client: 'claude' | 'codex') => Promise<void>;
  /** Production uses a data-plane process that can outlive the manager UI. */
  readonly backgroundGateway?: boolean;
  /** Test hook; production defers JSONL/SQLite rewrites while ChatGPT is live. */
  readonly codexHistoryMutationAllowed?: () => Promise<boolean>;
  /** Test hook for deciding whether a newly published Gateway needs a client restart notice. */
  readonly chatGptRunning?: () => Promise<boolean>;
  /** Test hook for the Claude Desktop restart notice after a profile switch. */
  readonly claudeRunning?: () => Promise<boolean>;
  /** Resolve the OS proxy for each upstream before publishing a client route. */
  readonly resolveUpstreamProxyUrl?: (url: string) => Promise<string | undefined>;
}

export interface XwXDeckShutdownOptions {
  /** Interactive Trace stop commits its intent only after verified recovery. */
  readonly disableTrace?: boolean;
  /** User explicitly accepted interrupting in-flight model requests. */
  readonly force?: boolean;
  /** Per-attempt drain budget; the interactive runtime may prompt again. */
  readonly drainTimeoutMs?: number;
  /** ChatGPT may still own live rollout files; defer the provider repair. */
  readonly skipCodexHistoryRepair?: boolean;
  /** User explicitly requested recovery and stop even when normal field-safe restoration reports conflicts. */
  readonly forceRestoreClients?: boolean;
}

export interface XwXDeckForceExitResult {
  readonly helperStopped: boolean;
  readonly dependentClients: readonly ClientId[];
}

/** A normal stop would interrupt replies the user is waiting for. The
 * message is shown as-is in the single wait / force-stop choice. */
export class ShutdownDrainTimeoutError extends Error {
  constructor(
    readonly activeResponses: number,
    readonly pendingContinuations: number
  ) {
    const parts: string[] = [];
    if (activeResponses > 0) parts.push(`${activeResponses} 个回复正在生成`);
    if (pendingContinuations > 0) parts.push(`${pendingContinuations} 个会话正在等待工具调用继续`);
    super(`${parts.join('，') || '有回复正在生成'}。`);
    this.name = 'ShutdownDrainTimeoutError';
  }

}

export interface ClientStateRow {
  readonly id: ClientId;
  readonly label: string;
  readonly enabled: boolean;
  readonly status: 'idle' | 'taken' | 'skipped' | 'off';
  readonly statusText: string;
  readonly detail: string;
}

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

export interface ModelServiceSnapshot {
  readonly claude: boolean;
  readonly codex: boolean;
  readonly claudeStatus: ClaudeCompatibleServiceSnapshot & {
    readonly traceManaged: boolean;
    readonly liveBaseUrl?: string;
  };
}

export interface CodexEnhancementsSnapshot {
  /** Trace 接管期间始终为 true；此设置控制非接管状态下的供应商切换。 */
  readonly preserveOfficialLogin: boolean;
  readonly authMode: CodexAuthMode;
  readonly unifySessionHistory: boolean;
  readonly historyRestorePending: boolean;
  readonly hasHistoryBackup: boolean;
  readonly history?: CodexHistoryMigrationOutcome;
}

export interface CodexEnhancementsUpdate {
  readonly preserveOfficialLogin?: unknown;
  readonly unifySessionHistory?: unknown;
  readonly migrateExisting?: unknown;
  readonly restoreExisting?: unknown;
}

export interface TraceDirectoryUpdate {
  readonly traceRoot?: unknown;
  readonly logRoot?: unknown;
  readonly claudeConfigDir?: unknown;
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

async function advisoryRead<T>(read: Promise<T>, client: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${client} 配置读取超时`)), 1_500);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class XwXDeckController {
  private readonly events = new EventEmitter();
  private readonly codexConversationWorker = new CodexConversationWorkerClient();
  private traceStore!: TraceStore;
  private proxy!: TraceProxy;
  private readonly settingsStore: XwXDeckSettingsStore;
  private readonly clientBackup: ClientBackupStore;
  private readonly clientFallbackStore: ClientFallbackStore;
  private readonly clientOrchestrator: ClientConfigOrchestrator;
  private readonly claudeConfig: ClaudeConfigManager;
  private readonly claudeDesktopConfig: ClaudeDesktopConfigManager;
  private readonly codexConfig: CodexConfigManager;
  private readonly codexHistory: CodexHistoryManager;
  private readonly codexLocalProxy: CodexLocalProxyCoordinator;
  private readonly codexOfficialAuth: CodexOfficialAuthManager;
  private readonly codexCatalog: CodexModelCatalogManager;
  private readonly codexThreadTitles: CodexThreadTitleReader;
  private codexProviderIdentity: 'official' | 'compatible' | `provider:${string}` | undefined;
  private compatibleServiceCatalog: readonly ModelCatalogEntry[] = [];
  private claudeDesktopCatalog: readonly ModelCatalogEntry[] = [];
  private claudeDesktopGatewayEnabled = false;
  /** With Trace off, the selected service has no model Desktop can use directly. */
  private claudeDesktopRequiresTrace = false;
  private claudeDesktopRestart: ClaudeDesktopRestartHint | undefined;
  private compatibleServiceCatalogRefresh: {
    readonly connection: string;
    readonly forceCapabilityRefresh: boolean;
    readonly promise: Promise<readonly ModelCatalogEntry[]>;
  } | undefined;
  private compatibleServiceCatalogGeneration = 0;
  private compatibleServiceCatalogRefreshedAt = 0;
  private codexGatewayEnabled = false;
  private codexGatewayMode: 'official' | 'compatible' | undefined;
  private codexOfficialAuthMode: CodexAuthMode | undefined;
  private codexOfficialBearerToken: string | undefined;
  private codexOfficialUpstreamBaseUrl: string | undefined;
  private settings: XwXDeckSettings | undefined;
  private active = false;
  private traceTransition: 'starting' | 'stopping' | undefined;
  private readonly clientsSeenSinceEnable = new Set<ClientId>();
  private startupPhase: StartupPhase = 'idle';
  private role: Role | undefined;
  private followerPort: number | undefined;
  private lockWatcher: fs.FSWatcher | undefined;
  private clientTakeovers: ClientTakeoverResult[] = [];
  private clientFallbacks: ClientTakeoverResult[] = [];
  private lastProxyRouteSummary = '';
  private lastPublishedRoutes: readonly TapClientRoute[] = [];
  private lastError: string | undefined;
  private desktopSyncError: string | undefined;
  private selectionWarning: string | undefined;
  private traceStorageNotice: string | undefined;
  private traceStorageRevision = 0;
  private traceStorageSyncPending = false;
  private traceDetailsPurgePending = false;
  private traceStorageSyncTimer: NodeJS.Timeout | undefined;
  private traceStorageSyncOperation: Promise<void> | undefined;
  private desktopSyncGeneration = 0;
  private chatGptConnectionIssue: ChatGptConnectionIssue | undefined;
  private chatGptRestartRecommended = false;
  private codexHistoryTimer: NodeJS.Timeout | undefined;
  private codexHistoryProviderAuditTimer: NodeJS.Timeout | undefined;
  private codexHistoryProviderAuditGeneration = 0;
  private missingCodexHistoryProviders: string[] = [];
  private codexHistoryDeferredOperation: string | undefined;
  private codexHistoryDeferredAttempts = 0;
  private readonly clientOperations: Record<ClientId, Promise<void>> = {
    'claude-cli': Promise.resolve(),
    'codex-cli': Promise.resolve()
  };
  private mutationOperation: Promise<void> = Promise.resolve();
  private shutdownRequested = false;
  private emergencyStopOperation: Promise<void> | undefined;
  private emergencyExitOperation: Promise<XwXDeckForceExitResult> | undefined;
  private externalTracePort?: number;
  private externalTracePortCheckedAt = 0;
  private externalTracePortCheck?: Promise<void>;
  private traceOverview = { sessions: 0, traces: 0, storageText: formatBytes(0), traceStorageBytes: 0 };
  private traceOverviewCheckedAt = 0;
  private traceOverviewCheck?: Promise<void>;
  private traceStorageCheckedAt = 0;
  private traceStorageCheck?: Promise<void>;
  private traceOverviewGeneration = 0;
  private pausedCodexAction?: 'open';
  private pausedCodexActionCheckedAt = 0;
  private pausedCodexActionCheck?: Promise<void>;
  private backgroundCaptureCheckedAt = 0;
  private backgroundCaptureCheck?: Promise<void>;

  constructor(
    private readonly userDataDir: string,
    private readonly options: XwXDeckControllerOptions = {}
  ) {
    this.settingsStore = new XwXDeckSettingsStore(userDataDir);
    const clientPaths = () => resolveClientPaths(process.env, undefined, {
      claudeConfigDir: this.settings?.claudeConfigDir
    });
    this.codexThreadTitles = new CodexThreadTitleReader(
      () => clientPaths().codexConfigPath
    );
    this.createTraceRuntime(path.join(userDataDir, 'xwx-trace'));
    this.clientBackup = new ClientBackupStore(userDataDir);
    this.clientFallbackStore = new ClientFallbackStore(userDataDir);
    this.clientOrchestrator = new ClientConfigOrchestrator(
      this.clientBackup,
      new ClientConfigWriter({ backup: this.clientBackup }),
      clientPaths
    );
    this.claudeConfig = new ClaudeConfigManager(userDataDir, clientPaths);
    this.claudeDesktopConfig = new ClaudeDesktopConfigManager(userDataDir);
    this.codexConfig = new CodexConfigManager(userDataDir);
    this.codexHistory = new CodexHistoryManager(
      userDataDir,
      options.codexHistoryMutationAllowed ?? (() => this.codexHistoryMutationIsSafe())
    );
    this.codexLocalProxy = new CodexLocalProxyCoordinator(userDataDir);
    this.codexOfficialAuth = new CodexOfficialAuthManager(userDataDir);
    this.codexCatalog = new CodexModelCatalogManager();
  }

  onDidChange(listener: () => void): () => void {
    this.events.on('change', listener);
    return () => this.events.off('change', listener);
  }

  async start(): Promise<void> {
    return this.serializeMutation(async () => {
      try {
        await this.startUnlocked();
      } catch (error) {
        // The manager must remain available to retry Trace, edit connections or
        // repair data even when an old helper cannot be attached after restart.
        this.lastError = `启动恢复未完成：${(error as Error).message}。可重试开启 Trace 或在设置中处理。`;
        this.setStartupPhase('degraded');
        log.warn(`[xwx-deck] ${this.lastError}`);
        this.fireChange();
      }
    });
  }

  private async startUnlocked(): Promise<void> {
    this.settings = await this.settingsStore.read();
    const settingsReadProblem = this.settingsStore.readProblem() ?? this.settingsStore.migrationProblem();
    if (settingsReadProblem) {
      this.lastError = settingsReadProblem.message;
      this.setStartupPhase('degraded');
      log.warn(`[xwx-deck] ${settingsReadProblem.message} path=${settingsReadProblem.path}`);
    }
    if (this.settings.compatible.baseUrl && this.settings.compatible.bearerToken) {
      this.compatibleServiceCatalog = await readCompatibleServiceModelCatalogCache(
        this.compatibleServiceModelCatalogCachePath(),
        this.settings.compatible.baseUrl,
        this.settings.compatible.bearerToken,
        this.settings.compatible.providerPreset
      );
    }
    const configuredTraceRoot = resolveRuntimeDirectory(this.settings.traceRoot, path.join(this.userDataDir, 'xwx-trace'));
    if (!sameDirectory(configuredTraceRoot, this.traceStore.rootPath())) this.createTraceRuntime(configuredTraceRoot);
    setLogDirectory(this.logRootPath());
    this.proxy.setRecordingEnabled(this.settings.tracingEnabled);
    // Recover dead takeovers before deciding whether the data plane is needed.
    // A healthy background helper is deliberately preserved by the liveness
    // probe; official direct + Trace off starts no helper at all.
    const startupRecoveryIssues = await this.clientOrchestrator.recoverOnStartup(port => probeTapPort(port));
    if (settingsReadProblem) {
      // Recovery above is still required when a previous process crashed after
      // pointing a client at localhost. Everything below may persist settings,
      // migrate external client configuration, or start a data plane, so keep a
      // damaged settings file or pending migration out of automatic startup
      // writes. Valid settings remain editable while migration is pending.
      this.fireChange();
      return;
    }
    try {
      const migrated = await this.codexConfig.migrateDeprecatedSettings();
      if (migrated.configChanged || migrated.restoreStateChanged) {
        log('[xwx-deck] removed deprecated disable_response_storage from ChatGPT configuration');
      }
    } catch (error) {
      // This obsolete key never controls routing. A locked or malformed Codex
      // config will be reported by the normal configuration path without
      // blocking unrelated startup recovery.
      log.warn(`[xwx-deck] deprecated ChatGPT setting cleanup skipped: ${(error as Error).message}`);
    }
    // Legacy explicit proxy pause takes precedence once, then Trace owns intent.
    if (this.settings.gatewayPaused && this.settings.tracingEnabled) {
      this.settings = await this.settingsStore.update({ tracingEnabled: false });
    }
    if (!this.settings.tracingEnabled) {
      try {
        if (this.settings.claudeDesktop.syncEnabled) {
          // First remove a stale local profile. Remote catalog loading and
          // Desktop synchronization are auxiliary work, not a startup gate.
          await this.claudeDesktopConfig.restoreLocal();
          this.claudeDesktopCatalog = [];
          this.claudeDesktopGatewayEnabled = false;
          this.scheduleClaudeDesktopSync();
        } else {
          await this.claudeDesktopConfig.restore();
          this.claudeDesktopCatalog = [];
          this.claudeDesktopGatewayEnabled = false;
        }
        // Attach only: opening Deck with Trace off must never spawn a helper.
        if (await this.proxy.attachExisting?.()) this.role = 'owner';
        const codex = await this.codexConfig.read();
        const configuredPort = isLoopbackUrl(codex.activeBaseUrl) ? parsePort(codex.activeBaseUrl) : undefined;
        if (configuredPort && await probeLocalTcpPort(configuredPort) && !await probeTapPort(configuredPort)) {
          throw new Error('客户端正在使用其他本地代理，已保留其配置。请检查该代理是否可用，或在模型配置中选择直连服务。');
        }
        const hasRecoveryState = fs.existsSync(path.join(this.userDataDir, 'codex-direct-config-state.json'));
        const restoreStaleGateway = hasRecoveryState
          || isLoopbackUrl(codex.activeBaseUrl)
          || this.proxy.isListening() && !this.claudeDesktopGatewayEnabled;
        if (restoreStaleGateway) {
          await this.disableUnlocked();
        } else {
          const restored = await this.codexLocalProxy.restore();
          if (restored.conflict) log(`[xwx-deck] startup preserved current ChatGPT connection: ${restored.conflict}`);
        }
      } catch (error) {
        this.lastError = `启动时恢复直连未完成：${(error as Error).message}`;
        this.setStartupPhase('degraded');
        log.warn(`[xwx-deck] ${this.lastError}`);
      }
      if (startupRecoveryIssues.length && !this.lastError) {
        this.lastError = `启动恢复时发现配置冲突：${startupRecoveryIssues.join('；')}。请检查配置与文件权限，必要时重试恢复直连配置。`;
        this.setStartupPhase('degraded');
      }
      this.fireChange();
      this.scheduleCompatibleServiceModelRefresh('startup-direct');
      this.scheduleCodexHistoryProviderAudit('startup-direct');
      this.scheduleCodexHistoryWork('startup-direct');
      return;
    }
    const preRenameCodex = await this.codexConfig.read().catch(() => undefined);
    const preRenamePort = preRenameCodex && isLoopbackUrl(preRenameCodex.activeBaseUrl)
      ? parsePort(preRenameCodex.activeBaseUrl)
      : undefined;
    const managedGatewayWasLive = preRenamePort !== undefined
      && await probeTapPort(preRenamePort).catch(() => false);
    // No Codex write occurs between the liveness probe and mode inference.
    const startupCodex = preRenameCodex;
    if (this.settings.codexPreferredMode === 'auto' && startupCodex) {
      this.settings = await this.settingsStore.update({
        codexPreferredMode: startupCodex.mode
      });
    }
    const chatGptWasRunningBeforeGateway = await this.chatGptRunningForRestartNotice();
    const attachedGateway = await this.proxy.attachExisting?.();
    if (attachedGateway) {
      this.role = 'owner';
      await this.proxy.start();
      this.startLockWatcher(this.traceStore.rootPath());
      await this.restoreCodexGatewayOnStartup(true);
      await this.restoreClientFallbacksOnStartup(await this.readLiveClientFallbackState());
      this.clientTakeovers = await this.clientOrchestrator.planFromLiveBackups(this.localBaseUrl()!, {
        claude: this.settings.clientEnabled.claude,
        codex: this.settings.clientEnabled.codex && !this.codexGatewayEnabled
      });

    }
    try {
      const currentCodex = !attachedGateway && startupCodex
        ? startupCodex
        : await this.codexConfig.read();
      // A disabled preservation switch deliberately leaves the CompatibleService key in
      // auth.json while CompatibleService remains selected, including across restarts.
      if (this.settings.codexEnhancements.preserveOfficialLogin || currentCodex.mode === 'official') {
        await this.codexOfficialAuth.restoreOfficialLogin();
      }
    } catch (error) {
      this.lastError = (error as Error).message;
      log.warn(`[xwx-deck] Codex official login recovery skipped: ${this.lastError}`);
    }
    try {
      await this.ensureCodexEnhancementConfig();
    } catch (error) {
      log.warn(`[xwx-deck] Codex enhancement config recovery skipped: ${(error as Error).message}`);
    }
    if (this.settings.tracingEnabled && !this.settings.gatewayPaused) {
      try {
        await this.enableUnlocked('startup-restore');
      } catch (err) {
        this.lastError = (err as Error).message;
        this.setStartupPhase('degraded');
        log.warn(`[xwx-deck] startup restore skipped: ${this.lastError}`);
      }
    }
    if (chatGptWasRunningBeforeGateway && this.codexGatewayEnabled && !managedGatewayWasLive) {
      this.markChatGptRestartRecommended('XwX Deck started the ChatGPT Gateway after ChatGPT was already running');
    }
    const readiness = await this.traceRuntimeReadiness();
    this.setStartupPhase(
      this.startupPhase === 'degraded'
        || this.settings.tracingEnabled && this.clientRows(readiness).some(row => row.enabled && row.status === 'skipped')
        ? 'degraded'
        : 'ready'
    );
    if (this.compatibleServiceCatalog.length) {
      // start() already owns the mutation queue.
      await this.syncCodexCatalogIfCompatibleServiceActive(this.compatibleServiceCatalog).catch(error => {
        log.warn(`[xwx-deck] cached CompatibleService catalog repair skipped: ${(error as Error).message}`);
      });
    }
    this.fireChange();
    this.scheduleCodexHistoryProviderAudit('startup');
    this.scheduleCodexHistoryWork('startup');
    this.scheduleCompatibleServiceModelRefresh('startup');
  }

  async toggle(enabled?: boolean, force = false): Promise<void> {
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new Error('Trace 操作参数无效，请重新操作。');
    }
    // A forced stop is an emergency path with its own single-flight guard: it
    // must not wait behind the mutation currently wedged in the queue.
    if (force && enabled === false) return this.forceDisable();
    return this.serializeMutation(async () => {
      // The target is resolved *inside* the queue. A click that arrives while an
      // earlier toggle is still running has to act on the state that toggle
      // leaves behind, otherwise two quick clicks — or one click plus one tray
      // click — can flip the switch back to where it started.
      const target = enabled ?? !this.active;
      // Only the enable direction is idempotent. Disabling doubles as recovery:
      // an inactive controller can still have clients pointing at a dead local
      // address, so a repeated "关闭 Trace" must be allowed to finish that work.
      if (target && this.active && this.proxy.isListening()) return;
      if (!target) await this.disableUnlocked(force);
      else await this.enableUnlocked('toggle');
    });
  }

  private async forceDisable(): Promise<void> {
    if (this.emergencyStopOperation) return this.emergencyStopOperation;
    this.emergencyStopOperation = (async () => {
      const previousShutdownRequested = this.shutdownRequested;
      this.shutdownRequested = true;
      try {
        await this.disableUnlocked(true);
      } finally {
        this.shutdownRequested = previousShutdownRequested;
        this.emergencyStopOperation = undefined;
      }
    })();
    return this.emergencyStopOperation;
  }

  async enable(reason: string): Promise<void> {
    return this.serializeMutation(() => this.enableUnlocked(reason));
  }

  private async enableUnlocked(reason: string): Promise<void> {
    const settings = this.settings ?? await this.settingsStore.read();
    const snapshot: EnableRollbackSnapshot = {
      managedDataPlane: this.hasManagedBackgroundDataPlane(),
      codexGatewayEnabled: this.codexGatewayEnabled,
      codexGatewayMode: this.codexGatewayMode,
      codexProviderIdentity: this.codexProviderIdentity,
      settings,
      active: this.active,
      recording: this.proxy.isRecordingEnabled(),
      listening: this.proxy.isListening(),
      role: this.role,
      followerPort: this.followerPort,
      startupPhase: this.startupPhase,
      clientTakeovers: this.clientTakeovers.map(takeover => ({ ...takeover })),
      clientFallbacks: this.clientFallbacks.map(fallback => ({ ...fallback })),
      clientsSeen: [...this.clientsSeenSinceEnable],
      chatGptConnectionIssue: this.chatGptConnectionIssue,
      chatGptRestartRecommended: this.chatGptRestartRecommended,
      lastError: this.lastError
    };
    this.traceTransition = 'starting';
    this.claudeDesktopRestart = undefined;
    this.fireChange();
    const startedAt = Date.now();
    try {
      await this.enableTransactionUnlocked(reason);
      log(`[xwx-deck] Trace enable took ${Date.now() - startedAt}ms (${reason})`);
    } catch (error) {
      await this.rollbackFailedEnable(snapshot, error);
      this.lastError = (error as Error).message;
      throw error;
    } finally {
      this.traceTransition = undefined;
      this.fireChange();
    }
  }

  private async enableTransactionUnlocked(reason: string): Promise<void> {
    await this.traceStore.assertIndexReadable();
    let currentSettings = this.settings ?? await this.settingsStore.read();
    const chatGptWasRunningBeforeTakeover = currentSettings.clientEnabled.codex
      && !this.codexGatewayEnabled
      && await this.chatGptRunningForRestartNotice();
    currentSettings = await this.settingsStore.update({ tracingEnabled: true, gatewayPaused: false });
    this.settings = currentSettings;
    await this.startProxyUnlocked(`enable:${reason}`);
    this.setStartupPhase('proxy-listening');
    if (reason === 'startup-restore' && !this.codexGatewayEnabled) {
      await this.restoreCodexGatewayOnStartup();
      if (this.startupPhase === 'degraded' && this.lastError) throw new Error(this.lastError);
    }
    if (!this.clientFallbacks.length) await this.restoreClientFallbacksOnStartup(await this.readLiveClientFallbackState());
    if (currentSettings.codexPreferredMode === 'compatible' && !this.codexGatewayEnabled) {
      await this.withUnderlyingClient('codex-cli', () => this.applyCodexConfigAndAuth({
        mode: 'compatible',
        compatibleModel: currentSettings.codexModels.compatible,
        compatibleBaseUrl: currentSettings.compatible.baseUrl,
        compatibleBearerToken: currentSettings.compatible.bearerToken,
        preserveOfficialLogin: true
      }));
    }
    if (currentSettings.clientEnabled.codex && !this.codexGatewayEnabled) {
      await this.prepareChatGptConnection();
    }
    const preflight = this.clientOrchestrator.preflight({
      claude: currentSettings.clientEnabled.claude,
      codex: currentSettings.clientEnabled.codex && !this.codexGatewayEnabled,
    });
    for (const result of preflight) {
      const name = result.client === 'claude-cli' ? 'Claude' : 'ChatGPT';
      const summary = result.status === 'ready'
        ? `ready via ${result.source} -> ${hostOf(result.upstreamBaseUrl || '')}`
        : `skipped: ${takeoverSkipReason(result.skipReason)}`;
      const conflicts = result.conflicts.length ? ` (${result.conflicts.join('；')})` : '';
      log(`[xwx-deck] preflight ${name}: ${summary}${conflicts}`);
    }
    // Our helper already chose a free port. Another installation's listener
    // does not prevent this one from publishing its own verified routes.
    const clientSelection = {
      claude: currentSettings.clientEnabled.claude,
      codex: currentSettings.clientEnabled.codex && !this.codexGatewayEnabled
    };
    const previousTakeovers = this.clientTakeovers;
    if (this.role === 'owner') {
      try {
        this.clientTakeovers = this.proxy.background && this.proxy.localBaseUrl()
          ? await this.clientOrchestrator.planFromLiveBackups(this.proxy.localBaseUrl()!, clientSelection)
          : this.clientOrchestrator.plan(clientSelection);
        await this.refreshProxyRoutes();
        await this.assertPreparedClientRoutes(this.clientTakeovers);
        this.setStartupPhase('routes-ready');
      } catch (error) {
        this.clientTakeovers = previousTakeovers;
        await this.codexLocalProxy.restore();
        await this.refreshProxyRoutesBestEffort('Trace route preflight rollback');
        throw error;
      }
    }
    try {
      this.settings = await this.settingsStore.update({ tracingEnabled: true });
      this.active = true;
      this.clientsSeenSinceEnable.clear();
      this.lastError = undefined;
      this.proxy.setRecordingEnabled(true);
      if (this.role === 'owner') {
        const baseUrl = this.proxy.localBaseUrl();
        if (baseUrl) {
          await this.options.beforeEnableClientApply?.();
          this.clientTakeovers = this.proxy.background
            ? await this.clientOrchestrator.applyOrResume(baseUrl, new Date(), clientSelection)
            : await this.clientOrchestrator.apply(baseUrl, new Date(), clientSelection);
          const takenClients = new Set(
            this.clientTakeovers
              .filter(takeover => takeover.status === 'taken')
              .map(takeover => takeover.client)
          );
          if (takenClients.size > 0) {
            this.clientFallbacks = this.clientFallbacks.filter(fallback => !takenClients.has(fallback.client));
            await this.persistClientFallbacks();
          }
          await this.refreshProxyRoutes();
          const chatGpt = this.clientTakeovers.find(result => result.client === 'codex-cli');
          if (chatGpt?.status === 'skipped' && chatGpt.skipReason === 'write-failed') {
            this.chatGptConnectionIssue = 'failed';
          }
          if (chatGptWasRunningBeforeTakeover && chatGpt?.status === 'taken') {
            this.markChatGptRestartRecommended('Trace published a new ChatGPT Gateway while ChatGPT was already running');
          }
          this.lastError = this.chatGptConnectionIssue
            ? chatGptConnectionIssueText(this.chatGptConnectionIssue)
            : takeoverNotice(this.clientTakeovers);
          this.setStartupPhase('config-ready');
        }
      }
    } catch (error) {
      if (this.role === 'owner') await this.clientOrchestrator.restoreAll().catch(() => undefined);
      await this.claudeDesktopConfig.restoreLocal().catch(() => undefined);
      this.claudeDesktopCatalog = [];
      this.claudeDesktopGatewayEnabled = false;
      await this.codexLocalProxy.restore().catch(() => undefined);
      this.clientTakeovers = previousTakeovers;
      await this.refreshProxyRoutesBestEffort('Trace enable rollback');
      throw error;
    }
    // Report Trace as on only after Desktop points at the recording Gateway
    // (or is known to need a restart for it).
    await this.syncClaudeDesktopRouteNow();
    this.fireChange();
    this.scheduleCodexHistoryWork(`trace enabled:${reason}`);
    this.scheduleClaudeDesktopSync();
  }

  private async rollbackFailedEnable(snapshot: EnableRollbackSnapshot, error: unknown): Promise<void> {
    let configurationDetached = true;
    if (!snapshot.managedDataPlane && !snapshot.active && this.proxy.isListening()) {
      try {
        const restored = await this.clientOrchestrator.restoreAll();
        const connection = await this.codexLocalProxy.restore();
        const direct = await this.restoreCodexPreferredDirectConfiguration();
        logPreservedDirectChanges(connection.conflict, direct.conflicts);
        await this.assertClientsDetachedFromLocalProxy();
      } catch (restoreError) {
        configurationDetached = false;
        log.warn(`[xwx-deck] failed enable preserved helper for recovery: ${(restoreError as Error).message}`);
      }
    }
    if (configurationDetached) {
      this.codexGatewayEnabled = snapshot.codexGatewayEnabled;
      this.codexGatewayMode = snapshot.codexGatewayMode;
      this.codexProviderIdentity = snapshot.codexProviderIdentity as typeof this.codexProviderIdentity;
    }
    this.active = snapshot.active;
    this.proxy.setRecordingEnabled(snapshot.recording);
    this.clientTakeovers = snapshot.clientTakeovers.map(takeover => ({ ...takeover }));
    this.clientFallbacks = snapshot.clientFallbacks.map(fallback => ({ ...fallback }));
    this.clientsSeenSinceEnable.clear();
    for (const client of snapshot.clientsSeen) this.clientsSeenSinceEnable.add(client);
    this.chatGptConnectionIssue = snapshot.chatGptConnectionIssue;
    this.chatGptRestartRecommended = snapshot.chatGptRestartRecommended;
    this.lastError = snapshot.lastError;
    this.setStartupPhase(snapshot.startupPhase);
    await this.persistClientFallbacks().catch(persistError => {
      log.warn(`[xwx-deck] failed to persist Trace fallback rollback: ${(persistError as Error).message}`);
    });

    try {
      this.settings = await this.settingsStore.update({
        tracingEnabled: snapshot.settings.tracingEnabled,
        gatewayPaused: snapshot.settings.gatewayPaused
      });
    } catch (settingsError) {
      this.settings = {
        ...(this.settings ?? snapshot.settings),
        tracingEnabled: snapshot.settings.tracingEnabled,
        gatewayPaused: snapshot.settings.gatewayPaused
      };
      log.warn(`[xwx-deck] failed to persist Trace enable rollback: ${(settingsError as Error).message}`);
    }

    const newlyStartedOwner = !snapshot.listening
      && this.role === 'owner'
      && this.proxy.isListening()
      && configurationDetached;
    if (newlyStartedOwner) {
      this.stopLockWatcher();
      try {
        await this.proxy.stop();
        await deleteLock(this.traceStore.rootPath()).catch(() => undefined);
        this.role = snapshot.role;
        this.followerPort = snapshot.followerPort;
      } catch (stopError) {
        log.warn(`[xwx-deck] failed to stop the rolled-back Trace helper: ${(stopError as Error).message}`);
        this.startLockWatcher(this.traceStore.rootPath());
        if (error instanceof Error) error.message += '；后台清理未完成。请重试关闭 Trace，仍失败时查看运行日志。';
      }
    } else if (this.role === 'owner' && configurationDetached) {
      await this.refreshProxyRoutesBestEffort('Trace enable rollback state');
      await this.proxy.synchronize?.().catch(syncError => {
        log.warn(`[xwx-deck] failed to synchronize Trace enable rollback: ${(syncError as Error).message}`);
      });
    }
    log.warn(`[xwx-deck] Trace enable rollback finished: ${(error as Error).message}`);
    this.fireChange();
  }

  /** True only while the helper is forwarding a live request or retaining a
   * tool-call continuation. A running ChatGPT process by itself is idle. */
  async disableBreaksCodex(): Promise<boolean> {
    if (!this.active) return false;
    const activity = await this.shutdownActivity();
    return activity.activeUserResponses > 0 || activity.pendingContinuations > 0;
  }

  async disable(): Promise<void> {
    return this.serializeMutation(() => this.disableUnlocked());
  }

  private async disableUnlocked(force = false): Promise<void> {
    this.traceTransition = 'stopping';
    this.claudeDesktopRestart = undefined;
    const previousError = this.lastError;
    this.fireChange();
    const startedAt = Date.now();
    try {
      if (!this.proxy.isListening()) {
        try {
          if (await this.proxy.attachExisting?.()) this.role = 'owner';
        } catch (error) {
          if (!force) throw error;
          log.warn(`[xwx-deck] force stop could not attach Gateway control: ${(error as Error).message}`);
        }
      }
      if (!force) {
        // Only replies the user is waiting for block a normal stop. Model
        // lists, token counts and other auxiliary calls end with the Gateway.
        const activity = await this.shutdownActivity();
        if (activity.activeUserResponses || activity.pendingContinuations) {
          throw new ShutdownDrainTimeoutError(activity.activeUserResponses, activity.pendingContinuations);
        }
      }
      await this.shutdownUnlocked({
        disableTrace: true,
        drainTimeoutMs: 1_000,
        skipCodexHistoryRepair: true,
        force,
        forceRestoreClients: force
      });
      if (!force || !this.lastError) this.lastError = undefined;
      this.chatGptConnectionIssue = undefined;
      this.chatGptRestartRecommended = false;
      this.scheduleClaudeDesktopSync();
      log(`[xwx-deck] Trace disable took ${Date.now() - startedAt}ms${force ? ' (force)' : ''}`);
    } catch (error) {
      if (error instanceof ShutdownDrainTimeoutError) {
        // Waiting is the user's choice, not a failed stop: Trace stays on and
        // no "关闭未完成" banner is left behind.
        this.lastError = previousError;
        throw error;
      }
      this.lastError = `Trace 关闭未完成：${(error as Error).message}`;
      throw new Error(this.lastError);
    } finally {
      this.traceTransition = undefined;
      this.fireChange();
    }
  }

  async shutdown(options: XwXDeckShutdownOptions = {}): Promise<void> {
    // A full exit restores every localhost-dependent client before stopping
    // the Gateway. Desktop's independent remote profile already survives;
    // re-syncing here could start a new local helper after shutdown.
    this.desktopSyncGeneration += 1;
    return this.serializeLifecycleMutation(() => this.shutdownUnlocked(options));
  }

  async forceExit(): Promise<XwXDeckForceExitResult> {
    if (this.emergencyExitOperation) return this.emergencyExitOperation;
    this.shutdownRequested = true;
    const operation = (async () => {
      await this.codexConversationWorker.dispose().catch(() => undefined);
      if (this.codexHistoryTimer) clearTimeout(this.codexHistoryTimer);
      this.codexHistoryTimer = undefined;
      const managedLocalBaseUrls = await this.managedLocalBaseUrls();
      const restoreIssues = await withTimeout(
        this.restoreClientConnectionsBeforeForcedStop(managedLocalBaseUrls),
        4_000,
        '强制退出前恢复客户端配置超时'
      ).catch(error => {
        return [`强制退出前恢复客户端配置超时：${(error as Error).message}`];
      });
      for (const issue of restoreIssues) {
        log.warn(`[xwx-deck] bounded force-exit config recovery failed: ${issue}`);
      }
      if (restoreIssues.length) throw new Error(restoreIssues.join('；'));
      const dependentClients = await this.clientsStillPointingAt(managedLocalBaseUrls);
      if (dependentClients.length > 0) {
        throw new Error(`退出恢复后仍有客户端依赖本地 Gateway：${dependentClients.join(', ')}。已保留 Gateway 与恢复记录。`);
      }
      this.active = false;
      this.clientsSeenSinceEnable.clear();
      this.proxy.setRecordingEnabled(false);
      this.stopLockWatcher();
      await deleteLock(this.traceStore.rootPath()).catch(() => undefined);
      await this.proxy.forceStop();
      this.clientTakeovers = [];
      this.clientFallbacks = [];
      await this.clientFallbackStore.clear().catch(() => undefined);
      this.codexGatewayEnabled = false;
      this.codexGatewayMode = undefined;
      this.codexOfficialAuthMode = undefined;
      this.codexOfficialBearerToken = undefined;
      this.codexOfficialUpstreamBaseUrl = undefined;
      this.role = undefined;
      this.followerPort = undefined;
      this.setStartupPhase('idle');
      return {
        helperStopped: true,
        dependentClients
      };
    })();
    this.emergencyExitOperation = operation;
    try {
      return await operation;
    } finally {
      if (this.emergencyExitOperation === operation) this.emergencyExitOperation = undefined;
    }
  }

  /**
   * Close the mutation gate only after every provider/Trace transaction already
   * queued by the UI has finished. Later mutations fail instead of slipping
   * between the ChatGPT exit check and the actual helper shutdown.
   */
  async beginShutdown(): Promise<void> {
    this.shutdownRequested = true;
  }

  /** Re-open the mutation gate when an interactive shutdown is cancelled. */
  async cancelShutdown(): Promise<void> {
    this.shutdownRequested = false;
  }

  /**
   * Finish an explicit proxy close without exiting the manager. Persisting the
   * paused intent and reopening the gate are one lifecycle transaction.
   */
  async finishShutdown(gatewayPaused?: boolean): Promise<void> {
    return this.serializeLifecycleMutation(async () => {
      if (gatewayPaused !== undefined) {
        this.settings = await this.settingsStore.update({ gatewayPaused });
        this.fireChange();
      }
      this.shutdownRequested = false;
    });
  }

  /**
   * Detach the manager from an independently owned data plane without restoring
   * client configuration. This is reserved for controlled helper handoff and
   * packaged lifecycle smoke coverage; normal application Quit always performs
   * a complete direct-configuration restore.
   */
  async detachManager(): Promise<boolean> {
    return this.serializeMutation(async () => {
      if (!this.proxy.background || !this.proxy.isListening()) return false;
      // Opening the history Dashboard starts the helper only so it can serve
      // the local viewer. With no managed client route, that helper is not a
      // model data plane and has no reason to survive the manager process.
      // Returning false lets the ordinary quit path stop it normally.
      if (!this.hasManagedBackgroundDataPlane()) return false;
      await this.proxy.synchronize?.();
      this.stopLockWatcher();
      if (this.codexHistoryTimer) clearTimeout(this.codexHistoryTimer);
      this.codexHistoryTimer = undefined;
      this.role = undefined;
      this.followerPort = undefined;
      return true;
    });
  }

  backgroundGatewayActive(): boolean {
    return this.proxy.background === true && this.proxy.isListening();
  }

  async backgroundGatewayAction(fast = false): Promise<'close' | 'open' | undefined> {
    // A viewer-only helper is an implementation detail of the Dashboard, not
    // a ChatGPT/Claude proxy. Do not offer a misleading "关闭代理" action for
    // it; closing the manager safely stops that helper instead.
    if (this.backgroundGatewayActive()) {
      // Trace can be off while an unrecorded Gateway remains intentionally
      // available for ChatGPT or Claude Desktop model routing. That is a
      // healthy direct-use state, not an incomplete Trace shutdown.
      return this.active ? 'close' : undefined;
    }
    // Runtime status must remain available even if initialization could not
    // read settings. Do not repeat the failed startup read to open the window.
    const settings = this.settings;
    if (!settings?.gatewayPaused) return undefined;
    if (settings.tracingEnabled) return 'open';
    if (settings.codexPreferredMode === 'compatible'
      && !!settings.compatible.baseUrl
      && !!settings.compatible.bearerToken) return 'open';
    // Claude CompatibleService writes its upstream directly and does not need this
    // Gateway. Only ChatGPT CompatibleService or a paused Trace intent can restore it.
    if (fast) {
      this.checkPausedCodexActionInBackground();
      return this.pausedCodexAction;
    }
    const codex = await advisoryRead(this.readUnderlyingCodexConfig(), 'ChatGPT').catch(() => undefined);
    this.pausedCodexAction = codex?.mode === 'compatible' ? 'open' : undefined;
    this.pausedCodexActionCheckedAt = Date.now();
    return this.pausedCodexAction;
  }

  private checkPausedCodexActionInBackground(): void {
    if (this.pausedCodexActionCheck || Date.now() - this.pausedCodexActionCheckedAt < 30_000) return;
    this.pausedCodexActionCheckedAt = Date.now();
    this.pausedCodexActionCheck = advisoryRead(this.readUnderlyingCodexConfig(), 'ChatGPT')
      .then(codex => {
        const action = codex?.mode === 'compatible' ? 'open' : undefined;
        if (action === this.pausedCodexAction) return;
        this.pausedCodexAction = action;
        this.fireChange();
      })
      .catch(() => undefined)
      .finally(() => { this.pausedCodexActionCheck = undefined; });
  }

  async startBackgroundGateway(): Promise<void> {
    return this.enable('manual start');
  }

  async setBackgroundGatewayPaused(paused: boolean, reason: string): Promise<void> {
    return this.serializeMutation(async () => {
      const previous = this.settings ?? await this.settingsStore.read();
      this.settings = await this.settingsStore.update({ gatewayPaused: paused });
      if (previous.gatewayPaused && !paused) {
        log(`[xwx-deck] gatewayPaused cleared: ${reason}`);
      }
      this.fireChange();
    });
  }

  async backgroundGatewayPaused(): Promise<boolean> {
    return (this.settings ?? await this.settingsStore.read()).gatewayPaused;
  }

  private hasManagedBackgroundDataPlane(): boolean {
    if (this.codexGatewayEnabled || this.claudeDesktopGatewayEnabled) return true;
    return [...this.clientTakeovers, ...this.clientFallbacks]
      .some(takeover => takeover.status === 'taken');
  }

  requiresCodexClientExitBeforeShutdown(): boolean {
    if (this.codexGatewayEnabled) return true;
    // Full quit/update uses process detection to explain cached connections
    // and avoid rewriting live history; ordinary Trace stop checks requests.
    return [...this.clientTakeovers, ...this.clientFallbacks].some(takeover => (
      takeover.client === 'codex-cli' && takeover.status === 'taken'
    ));
  }

  requiresClaudeClientExitBeforeShutdown(): boolean {
    if (this.claudeDesktopGatewayEnabled) return true;
    return [...this.clientTakeovers, ...this.clientFallbacks].some(takeover => (
      takeover.client === 'claude-cli' && takeover.status === 'taken'
    ));
  }

  shutdownModelDependencies(): readonly ShutdownModelDependency[] {
    const settings = this.settings;
    if (!settings || !this.codexGatewayEnabled || this.codexGatewayMode !== 'compatible') return [];
    const model = settings.codexModels.compatible.trim();
    if (!model || !providerRequiresTrace(selectedProvider(settings, 'codex') ?? settings.compatible, model, this.compatibleServiceCatalog)) return [];
    return [{ clientName: 'ChatGPT', model }];
  }

  async shutdownActivity(): Promise<{
    activeRequests: number;
    activeUserResponses: number;
    pendingContinuations: number;
  }> {
    await this.proxy.refreshShutdownActivity();
    return this.shutdownActivitySnapshot();
  }

  shutdownActivitySnapshot(): {
    activeRequests: number;
    activeUserResponses: number;
    pendingContinuations: number;
  } {
    return {
      activeRequests: this.proxy.activeRequestCount(),
      activeUserResponses: this.proxy.activeUserResponseCount(),
      pendingContinuations: this.proxy.pendingContinuationCount()
    };
  }

  abandonCodexContinuations(): void {
    this.proxy.abandonCodexContinuations();
  }

  /**
   * Repair rows removed by the short-lived aggressive official cleanup build.
   * The caller must first prove that the ChatGPT main process has exited; this
   * method can rewrite rollout JSONL files and must never race the live writer.
   */
  async restoreLegacyOfficialHistoryAfterChatGptExit(): Promise<void> {
    return this.serializeLifecycleMutation(async () => {
      let restored;
      if (this.proxy.background && !this.proxy.isListening()) {
        // Official direct mode intentionally has no helper. The caller has
        // already proved that ChatGPT exited, so repair the same portability
        // ledger locally without starting a data plane merely for maintenance.
        const config = await this.codexConfig.read();
        if (config.mode !== 'official') return;
        const paths = resolveClientPaths();
        const portability = new CodexConversationPortability(
          path.join(this.userDataDir, 'codex-portability', 'opaque-origins.json'),
          path.dirname(paths.codexConfigPath)
        );
        await portability.adoptProviderOnStartup('official');
        restored = await portability.restoreLegacyOfficialHistory();
      } else {
        restored = await this.proxy.restoreLegacyOfficialHistory();
      }
      if (restored.changedFiles) {
        log(`[xwx-deck] restored ${restored.changedFiles} Codex history file(s), recovered ${restored.restoredItems} official opaque item(s); backup=${restored.backupRoot}`);
      }
    });
  }

  private async shutdownUnlocked(options: XwXDeckShutdownOptions = {}): Promise<void> {
    await this.codexConversationWorker.dispose().catch(() => undefined);
    const previousSettings = this.settings ?? await this.settingsStore.read();
    const returnToExternalConnection = options.disableTrace && await this.codexLocalProxy.hasPendingOriginalRestore();
    const managedLocalBaseUrls = await this.managedLocalBaseUrls();
    let intentCommitted = false;
    this.lastError = undefined;
    let proxyPreparedForShutdown = false;
    if (this.role === 'owner' && this.proxy.isListening()) {
      const activeRequests = this.proxy.activeRequestCount();
      if (activeRequests > 0) {
        log(`[xwx-deck] waiting for ${activeRequests} active proxied request(s) before shutdown`);
      }
      if (options.force) {
        await this.proxy.forcePrepareForShutdown().catch(error => {
          log.warn(`[xwx-deck] force stop could not close the request gate: ${(error as Error).message}`);
        });
        proxyPreparedForShutdown = true;
      } else {
        proxyPreparedForShutdown = await this.proxy.prepareForShutdown({
          timeoutMs: options.drainTimeoutMs ?? this.options.shutdownDrainTimeoutMs,
          quietPeriodMs: this.options.shutdownQuietPeriodMs
        });
      }
      if (!proxyPreparedForShutdown) {
        await this.proxy.refreshShutdownActivity();
        const activeUserResponses = this.proxy.activeUserResponseCount();
        const pendingContinuations = this.proxy.pendingContinuationCount();
        if (activeUserResponses || pendingContinuations) {
          throw new ShutdownDrainTimeoutError(activeUserResponses, pendingContinuations);
        }
        // Only auxiliary requests remain; they are not conversations.
        log(`[xwx-deck] closing ${this.proxy.activeRequestCount()} auxiliary request(s) with the Gateway`);
        await this.proxy.forcePrepareForShutdown();
        proxyPreparedForShutdown = true;
      }
    }
    try {
      if (!options.forceRestoreClients && (this.role === 'owner' || options.disableTrace || managedLocalBaseUrls.length > 0)) {
        const restored = await this.clientOrchestrator.restoreAll();
        this.lastError = restoreBlockingNotice(restored);
        const connection = await this.codexLocalProxy.restore();
        logPreservedDirectChanges(connection.conflict);
        await this.restoreClaudeDesktopFromLocalGateway();
      }
      if (this.codexGatewayEnabled && this.settings && this.localBaseUrl() && !options.skipCodexHistoryRepair) {
        // Complete shutdown returns Codex to the selected provider's direct
        // service. Repair history for that destination before the Gateway and its
        // portability sidecars disappear.
        const repair = await this.proxy.repairCodexHistoryForProvider(
          await this.preferredCodexDirectMode()
        );
        if (repair.changedFiles) {
          log(`[xwx-deck] repaired ${repair.changedFiles} Codex history file(s), removed ${repair.removedItems} unportable item(s)${repair.removedUnencryptedReasoningItems ? ` (${repair.removedUnencryptedReasoningItems} unencrypted reasoning)` : ''}${repair.normalizedMessageIds ? `, normalized ${repair.normalizedMessageIds} legacy message ID(s)` : ''}; backup=${repair.backupRoot}`);
        }
      } else if (this.codexGatewayEnabled && options.skipCodexHistoryRepair) {
        log('[xwx-deck] deferred ChatGPT provider history repair because ChatGPT may still be running');
      }
      if (options.forceRestoreClients) {
        const restoreIssues = await withTimeout(
          this.restoreClientConnectionsBeforeForcedStop(managedLocalBaseUrls),
          4_000,
          '强制停止前恢复客户端配置超时'
        ).catch(error => {
          return [`强制停止前恢复客户端配置超时：${(error as Error).message}`];
        });
        if (restoreIssues.length) {
          this.lastError = `客户端配置恢复未完成：${restoreIssues.join('；')}`;
          throw new Error(this.lastError);
        }
      } else {
        const direct = returnToExternalConnection
          ? { restoredFields: 0, conflicts: [] }
          : await this.restoreCodexPreferredDirectConfiguration();
        logPreservedDirectChanges(undefined, direct.conflicts);
      }
      if (!options.force) await this.options.beforeShutdownConfigVerification?.();
      if (!options.forceRestoreClients) {
        await this.assertClientsDetachedFromLocalProxy(managedLocalBaseUrls);
      }
      if (options.disableTrace && this.lastError && !options.forceRestoreClients) {
        throw new Error(`配置恢复冲突：${this.lastError}。请检查文件占用或外部修改，再重试恢复直连配置。`);
      }

      if (!options.skipCodexHistoryRepair) {
        if (this.settings?.codexEnhancements.pendingHistoryRestore) {
          await this.restorePendingCodexHistory('shutdown');
        } else if (this.settings?.codexEnhancements.unifySessionHistory) {
          await this.mergeCodexHistoryBestEffort('shutdown');
        }
      }
      if (options.disableTrace) {
        try {
          this.settings = await this.settingsStore.update({ tracingEnabled: false, gatewayPaused: true });
          intentCommitted = true;
        } catch (error) {
          if (!options.force) throw error;
          log.warn(`[xwx-deck] force stop could not persist the stopped Trace intent: ${(error as Error).message}`);
        }
      }
      this.stopLockWatcher();
      if (this.role === 'owner') {
        if (options.force) await this.proxy.forceStop();
        else await this.proxy.stop();
        await deleteLock(this.traceStore.rootPath()).catch(() => undefined);
      }
      if (this.codexHistoryTimer) clearTimeout(this.codexHistoryTimer);
      this.codexHistoryTimer = undefined;
      this.active = false;
      this.clientsSeenSinceEnable.clear();
      this.proxy.setRecordingEnabled(false);
      this.clientTakeovers = [];
      this.clientFallbacks = [];
      await this.clientFallbackStore.clear().catch(error => {
        log.warn(`[xwx-deck] failed to clear stopped client fallback state: ${(error as Error).message}`);
      });
      this.codexGatewayEnabled = false;
      this.codexGatewayMode = undefined;
      this.codexOfficialAuthMode = undefined;
      this.codexOfficialBearerToken = undefined;
      this.codexOfficialUpstreamBaseUrl = undefined;
      this.proxy.setClientRoutes([]);
      this.claudeDesktopCatalog = [];
      this.claudeDesktopGatewayEnabled = false;
      this.role = undefined;
      this.followerPort = undefined;
      this.setStartupPhase('idle');
    } catch (error) {
      if (intentCommitted) {
        this.settings = await this.settingsStore.update({
          tracingEnabled: previousSettings.tracingEnabled,
          gatewayPaused: previousSettings.gatewayPaused
        }).catch(() => previousSettings);
      }
      if (proxyPreparedForShutdown) {
        try {
          await this.proxy.cancelPreparedShutdown();
        } catch (resumeError) {
          log.warn(`[xwx-deck] could not reopen request gate: ${(resumeError as Error).message}`);
          throw new Error(`${(error as Error).message}；后台恢复接单状态未确认。请查看运行日志，稍后重试关闭或重新开启 Trace。`);
        }
      }
      if (this.role === 'owner' && this.proxy.isListening()) {
        this.startLockWatcher(this.traceStore.rootPath());
        if (previousSettings.claudeDesktop.syncEnabled) {
          await this.syncClaudeDesktopIfEnabled(this.claudeDesktopCatalog).catch(syncError => {
            log.warn(`[xwx-deck] could not reapply Claude Desktop after cancelled shutdown: ${(syncError as Error).message}`);
          });
        }
      }
      throw error;
    }
  }

  /**
   * Emergency exit skips history repair, but it must still restore every live
   * client connection before the local data plane is killed. The detached exit
   * guardian snapshots the same backups first and owns the final recovery if
   * this bounded in-process attempt cannot finish.
   */
  private async restoreClientConnectionsBeforeForcedStop(
    managedLocalBaseUrls: readonly string[]
  ): Promise<readonly string[]> {
    const failures: string[] = [];
    try {
      const restored = await this.clientOrchestrator.restoreAll();
      const notice = restoreBlockingNotice(restored);
      if (notice) failures.push(notice);
    } catch (error) {
      failures.push(`客户端配置恢复失败：${(error as Error).message}`);
      // restoreAll is the atomic client-restore pass. If it cannot complete,
      // leave every client dependency for the detached exit guardian instead
      // of partially rewriting only one client here.
      return failures;
    }
    try {
      const connection = await this.codexLocalProxy.restore();
      logPreservedDirectChanges(connection.conflict);
    } catch (error) {
      failures.push(`ChatGPT 直连配置恢复失败：${(error as Error).message}`);
    }
    try {
      await this.restoreClaudeDesktopFromLocalGateway();
    } catch (error) {
      failures.push(`Claude Desktop 配置恢复失败：${(error as Error).message}`);
    }
    this.claudeDesktopCatalog = [];
    this.claudeDesktopGatewayEnabled = false;
    try {
      const direct = await this.restoreCodexPreferredDirectConfiguration(true);
      logPreservedDirectChanges(undefined, direct.conflicts);
    } catch (error) {
      failures.push(`ChatGPT 直连配置恢复失败：${(error as Error).message}`);
    }
    try {
      await this.assertClientsDetachedFromLocalProxy(managedLocalBaseUrls);
    } catch (error) {
      failures.push((error as Error).message);
    }
    return [...new Set(failures)];
  }

  private async preferredCodexDirectMode(): Promise<'official' | 'compatible' | `provider:${string}`> {
    const settings = this.settings ?? await this.settingsStore.read();
    if (settings.codexPreferredMode === 'compatible') {
      return providerUpstreamKind(settings);
    }
    if (settings.codexPreferredMode === 'official') return 'official';
    return (await this.codexConfig.read()).mode;
  }

  private async restoreCodexPreferredDirectConfiguration(
    allowInvalidConfigRecovery = false
  ): Promise<{
    restoredFields: number;
    conflicts: string[];
  }> {
    const settings = this.settings ?? await this.settingsStore.read();
    if (settings.codexPreferredMode === 'auto') {
      const snapshot = await this.readCodexConfig();
      const port = parsePort(snapshot.activeBaseUrl);
      if (snapshot.configOwnership === 'external'
        && (!isLoopbackUrl(snapshot.activeBaseUrl) || port !== undefined && await probeLocalTcpPort(port))) {
        return { restoredFields: 0, conflicts: ['已保留外部 ChatGPT 连接；未接管的连接不参与退出恢复。'] };
      }
    }
    const provider = selectedProvider(settings, 'codex');
    const restored = await restorePreferredCodexDirect(this.userDataDir, {
      providerAdapter: provider?.adapter,
      ...codexProviderToml(provider, settings.codexEnhancements.unifySessionHistory),
      preserveOfficialLogin: settings.codexEnhancements.preserveOfficialLogin,
      unifySessionHistory: settings.codexEnhancements.unifySessionHistory,
      directProviders: providerDirectConnections(settings.providers?.connections),
      requiresGateway: providerRequiresTrace(provider ?? settings.compatible, settings.codexModels.compatible, this.compatibleServiceCatalog),
      preferredMode: settings.codexPreferredMode,
      officialModel: settings.codexModels.official,
      compatibleModel: settings.codexModels.compatible,
      compatibleContextWindow: settings.codexModels.compatibleContextWindow,
      compatibleBaseUrl: settings.compatible.baseUrl,
      compatibleBearerToken: settings.compatible.bearerToken,
      allowInvalidConfigRecovery
    });
    if (restored.fellBackToOfficial) {
      log.warn('[xwx-deck] preferred CompatibleService direct restore fell back to official because the saved connection is incomplete');
    }
    return {
      restoredFields: restored.restoredFields,
      conflicts: [...restored.conflicts]
    };
  }

  /** User-triggered repair; never runs as part of ordinary startup or caching. */
  async repairUnreadableSettings(): Promise<{ backupPath: string; lostProviderSettings: boolean }> {
    return this.serializeMutation(async () => {
      await this.settingsStore.read();
      if (!this.settingsStore.readProblem()) throw new Error('设置文件已可读取，无需修复。');
      const repaired = await this.settingsStore.repairUnreadableSettings();
      this.settings = repaired.settings;
      this.lastError = undefined;
      this.setStartupPhase('idle');
      try {
        await this.startUnlocked();
      } catch (error) {
        this.lastError = `设置已重建，运行状态仍需处理：${(error as Error).message}`;
        this.setStartupPhase('degraded');
        this.fireChange();
      }
      return { backupPath: repaired.backupPath, lostProviderSettings: repaired.lostProviderSettings };
    });
  }

  /** Confirmed repair: back up the live config and restore the saved choice. */
  async repairInvalidCodexConfiguration(): Promise<{
    backupPath: string;
    mode: 'official' | 'compatible';
    conflicts: readonly string[];
  }> {
    return this.serializeMutation(async () => {
      const settings = await this.settingsStore.read();
      if (this.settingsStore.readProblem()) throw new Error('请先修复 XwX Deck 设置，再修复 ChatGPT 配置。');
      let backupPath = '';
      let liveConfig: CodexConfigSnapshot | undefined;
      try {
        liveConfig = await this.codexConfig.read();
        backupPath = await this.codexConfig.backupBeforeConfirmedRepair();
      } catch (error) {
        if (!/config\.toml.*格式错误|TOML.*(?:错误|解析)/i.test((error as Error).message)) throw error;
        backupPath = await this.codexConfig.backupBeforeConfirmedRepair();
      }
      const provider = selectedProvider(settings, 'codex');
      const needsGateway = settings.codexPreferredMode === 'compatible'
        && providerRequiresTrace(provider ?? settings.compatible, settings.codexModels.compatible, this.compatibleServiceCatalog);
      const wasUsingGateway = !!liveConfig && isLoopbackUrl(liveConfig.activeBaseUrl)
        && this.role === 'owner' && this.proxy.isListening();
      const canUsePreferred = !!provider?.baseUrl && !!provider.bearerToken
        && !!settings.codexModels.compatible;
      if (settings.codexPreferredMode === 'compatible' && !canUsePreferred) {
        throw new Error('所选服务配置不完整，请补全地址、密钥和模型后重试；未切回官方。');
      }
      const chosenMode = settings.codexPreferredMode === 'compatible' ? 'compatible' : 'official';
      const conflicts: string[] = [];
      if (needsGateway && (!settings.tracingEnabled || settings.gatewayPaused)) {
        conflicts.push('所选服务和模型已保留；调用此模型需要开启 Trace 进行协议转换。');
      }
      const repairInput: CodexConfigUpdate = {
        mode: chosenMode,
        officialModel: settings.codexModels.official,
        compatibleModel: settings.codexModels.compatible,
        compatibleBaseUrl: provider?.baseUrl ?? settings.compatible.baseUrl,
        compatibleBearerToken: provider?.bearerToken ?? settings.compatible.bearerToken,
        modelContextWindow: chosenMode === 'compatible'
          ? settings.codexModels.compatibleContextWindow || null
          : settings.codexModels.officialContextWindow || null,
        preserveOfficialLogin: settings.codexEnhancements.preserveOfficialLogin,
        unifySessionHistory: settings.codexEnhancements.unifySessionHistory,
        takeOverExternalConfig: true
      };
      if (settings.tracingEnabled && !settings.gatewayPaused && (needsGateway || wasUsingGateway)) {
        await this.startProxyUnlocked('ChatGPT configuration repair');
      }
      await this.codexConfig.forgetInvalidDirectRestoreState();
      await this.applyCodexConfigAndAuth(repairInput, {
        skipRemoteChecks: true, repairInvalid: true
      });
      const config = await this.codexConfig.read();
      if (wasUsingGateway && !needsGateway && !this.codexGatewayEnabled) {
        conflicts.push('原有 Gateway 路由未保留，当前 ChatGPT 进程需要重启');
      }
      const expectedMode = chosenMode;
      const expectedModel = config.mode === 'compatible' ? settings.codexModels.compatible : settings.codexModels.official;
      const actualModel = config.mode === 'compatible' ? config.compatible.model : config.officialModel;
      if (expectedMode !== config.mode) conflicts.push('服务选择未完全恢复，请重新选择模型服务');
      if (expectedModel && expectedModel !== actualModel) {
        conflicts.push('模型选择未完全恢复，请重新选择模型');
      }
      if (config.mode === 'compatible' && needsGateway) {
        await this.assertCodexGatewayRoute();
        if (config.activeBaseUrl !== `${this.localBaseUrl()?.replace(/\/+$/, '')}/backend-api/codex`) {
          throw new Error('ChatGPT 配置复读后没有指向已启动的模型路由。');
        }
      }
      if (config.mode === 'compatible' && this.codexGatewayEnabled
        && isLoopbackUrl(config.activeBaseUrl)) {
        await this.assertCodexGatewayRoute();
      }
      if (config.mode === 'compatible' && isLoopbackUrl(config.activeBaseUrl)
        && !this.codexGatewayEnabled) {
        conflicts.push('ChatGPT 仍指向未就绪的本地模型路由');
      }
      const directBaseUrl = provider?.adapter === 'auto'
        ? normalizeCompatibleServiceBaseUrl(provider.baseUrl)
        : provider?.baseUrl;
      if (config.mode === 'compatible' && !needsGateway && !this.codexGatewayEnabled
        && !sameHttpEndpoint(config.activeBaseUrl, directBaseUrl)) {
        conflicts.push('第三方服务地址未完全恢复，请重新选择模型服务');
      }
      if (config.mode === 'official' && isLoopbackUrl(config.activeBaseUrl)) {
        await this.assertCodexGatewayRoute();
        if (!sameHttpEndpoint(config.activeBaseUrl,
          `${this.localBaseUrl()?.replace(/\/+$/, '')}/backend-api/codex`)) {
          throw new Error('ChatGPT 配置复读后指向的不是当前运行中的 Gateway。');
        }
      }
      if (config.mode === 'official' && this.codexGatewayEnabled
        && !isLoopbackUrl(config.activeBaseUrl)) {
        conflicts.push('ChatGPT 配置与当前 Gateway 路由不一致');
      }
      if (!conflicts.length) this.lastError = undefined;
      this.fireChange();
      return {
        backupPath,
        mode: config.mode,
        conflicts
      };
    });
  }

  private async managedLocalBaseUrls(): Promise<readonly string[]> {
    const localBaseUrls = new Set<string>();
    const live = this.localBaseUrl();
    if (live) localBaseUrls.add(live);
    for (const record of await this.clientBackup.listAll()) {
      if (record.writtenLocalUrl) localBaseUrls.add(record.writtenLocalUrl);
    }
    const fallback = await this.clientFallbackStore.read();
    if (fallback?.localBaseUrl) localBaseUrls.add(fallback.localBaseUrl);
    return [...localBaseUrls];
  }

  private async clientsStillPointingAt(localBaseUrls: readonly string[]): Promise<ClientId[]> {
    const dependentClients = new Set<ClientId>();
    for (const localBaseUrl of localBaseUrls) {
      for (const client of this.clientOrchestrator.clientsPointingAt(localBaseUrl)) {
        dependentClients.add(client);
      }
      if (await this.codexConfig.referencesLocalGateway(localBaseUrl)) {
        dependentClients.add('codex-cli');
      }
    }
    return [...dependentClients];
  }

  private async assertClientsDetachedFromLocalProxy(
    localBaseUrls?: readonly string[]
  ): Promise<void> {
    const dependentClients = await this.clientsStillPointingAt(
      localBaseUrls ?? await this.managedLocalBaseUrls()
    );
    if (!dependentClients.length) return;
    const labels = dependentClients.map(client => client === 'claude-cli' ? 'Claude' : 'ChatGPT');
    throw new Error(
      `${labels.join('、')} 配置仍指向本次即将关闭的 XwX Model Gateway。`
      + '本次关闭已取消。请检查配置中的本地地址或外部修改，再重试关闭 Trace。'
    );
  }

  async toggleClient(client: ClientId): Promise<void> {
    return this.serializeMutation(() => (
      this.serializeClientOperation(client, () => this.toggleClientUnlocked(client))
    ));
  }

  private async toggleClientUnlocked(client: ClientId): Promise<void> {
    const settings = await this.settingsStore.read();
    const snapshot: ClientToggleRollbackSnapshot = {
      settings,
      clientTakeovers: this.clientTakeovers.map(takeover => ({ ...takeover })),
      clientFallbacks: this.clientFallbacks.map(fallback => ({ ...fallback })),
      chatGptConnectionIssue: this.chatGptConnectionIssue,
      chatGptRestartRecommended: this.chatGptRestartRecommended,
      lastError: this.lastError
    };
    const key = client === 'claude-cli' ? 'claude' : 'codex';
    const nextEnabled = !settings.clientEnabled[key];
    const chatGptWasRunningBeforeTakeover = client === 'codex-cli'
      && nextEnabled
      && !this.codexGatewayEnabled
      && await this.chatGptRunningForRestartNotice();
    let clientMutationStarted = false;
    try {
      this.settings = await this.settingsStore.update({
        clientEnabled: {
          ...settings.clientEnabled,
          [key]: nextEnabled
        }
      });
      if (this.role === 'owner' && this.active) {
        const baseUrl = this.proxy.localBaseUrl();
        if (client === 'codex-cli' && this.codexGatewayEnabled) {
          // The service route remains active; this switch controls capture only.
        } else if (nextEnabled && baseUrl) {
          clientMutationStarted = true;
          if (client === 'codex-cli') await this.prepareChatGptConnection();
          const planned = this.clientOrchestrator.plan({
            claude: client === 'claude-cli',
            codex: client === 'codex-cli'
          })[0];
          this.clientTakeovers = [...this.clientTakeovers.filter(t => t.client !== client), planned];
          await this.refreshProxyRoutes();
          await this.assertPreparedClientRoutes([planned]);
          const result = await this.clientOrchestrator.applyOne(client, baseUrl);
          this.clientTakeovers = [...this.clientTakeovers.filter(t => t.client !== client), result];
          if (result.status === 'taken') {
            this.clientFallbacks = this.clientFallbacks.filter(fallback => fallback.client !== client);
            await this.persistClientFallbacks();
          }
          if (chatGptWasRunningBeforeTakeover && result.status === 'taken') {
            this.markChatGptRestartRecommended('ChatGPT Trace capture was enabled while ChatGPT was already running');
          }
          this.lastError = takeoverNotice([result]);
        } else if (!nextEnabled) {
          clientMutationStarted = true;
          const takeover = this.clientTakeovers.find(item => (
            item.client === client && item.status === 'taken'
          ));
          if (takeover && baseUrl) {
            this.clientFallbacks = mergeClientFallbacks(this.clientFallbacks, [takeover]);
            await this.persistClientFallbacks();
          }
          const restored = await this.clientOrchestrator.restoreOne(client);
          this.lastError = restoreBlockingNotice(restored ? [restored] : []);
          if (client === 'codex-cli') {
            const connection = await this.codexLocalProxy.restore();
            logPreservedDirectChanges(connection.conflict);
            this.chatGptConnectionIssue = undefined;
            if (!this.codexGatewayEnabled) this.chatGptRestartRecommended = false;
          }
          this.clientTakeovers = this.clientTakeovers.filter(t => t.client !== client);
        }
        await this.refreshProxyRoutes();
      }
    } catch (error) {
      await this.rollbackFailedClientToggle(client, snapshot, clientMutationStarted, error);
      throw error;
    }
    this.fireChange();
    if (client === 'codex-cli' && !nextEnabled) {
      this.scheduleCodexHistoryWork('ChatGPT Trace takeover disabled');
    }
  }

  private async rollbackFailedClientToggle(
    client: ClientId,
    snapshot: ClientToggleRollbackSnapshot,
    clientMutationStarted: boolean,
    error: unknown
  ): Promise<void> {
    try {
      this.settings = await this.settingsStore.update({
        clientEnabled: snapshot.settings.clientEnabled
      });
    } catch (settingsError) {
      this.settings = {
        ...(this.settings ?? snapshot.settings),
        clientEnabled: snapshot.settings.clientEnabled
      };
      log.warn(`[xwx-deck] failed to persist client toggle rollback: ${(settingsError as Error).message}`);
    }
    this.clientTakeovers = snapshot.clientTakeovers.map(takeover => ({ ...takeover }));
    this.clientFallbacks = snapshot.clientFallbacks.map(fallback => ({ ...fallback }));
    this.chatGptConnectionIssue = snapshot.chatGptConnectionIssue;
    this.chatGptRestartRecommended = snapshot.chatGptRestartRecommended;
    this.lastError = snapshot.lastError;
    await this.persistClientFallbacks().catch(persistError => {
      log.warn(`[xwx-deck] failed to persist client fallback rollback: ${(persistError as Error).message}`);
    });

    if (clientMutationStarted && this.role === 'owner' && this.active) {
      await this.clientOrchestrator.restoreOne(client).catch(restoreError => {
        log.warn(`[xwx-deck] failed to clear partial client toggle state: ${(restoreError as Error).message}`);
      });
      if (client === 'codex-cli') {
        await this.codexLocalProxy.restore().catch(restoreError => {
          log.warn(`[xwx-deck] failed to clear partial ChatGPT proxy state: ${(restoreError as Error).message}`);
        });
      }
      const previous = snapshot.clientTakeovers.find(takeover =>
        takeover.client === client && takeover.status === 'taken'
      );
      const baseUrl = this.proxy.localBaseUrl();
      if (previous && baseUrl && !(client === 'codex-cli' && this.codexGatewayEnabled)) {
        const planned = this.clientOrchestrator.plan({
          claude: client === 'claude-cli',
          codex: client === 'codex-cli'
        })[0];
        this.clientTakeovers = [
          ...snapshot.clientTakeovers.filter(takeover => takeover.client !== client),
          planned
        ];
        await this.refreshProxyRoutesBestEffort('client toggle rollback prepare');
        const reapplied = await this.clientOrchestrator.applyOne(client, baseUrl).catch(reapplyError => {
          log.error(`[xwx-deck] failed to reapply client after toggle rollback: ${(reapplyError as Error).message}`);
          return undefined;
        });
        if (reapplied) {
          this.clientTakeovers = [
            ...snapshot.clientTakeovers.filter(takeover => takeover.client !== client),
            reapplied
          ];
        }
      }
    }
    if (this.role === 'owner') {
      await this.refreshProxyRoutesBestEffort('client toggle rollback');
      await this.proxy.synchronize?.().catch(syncError => {
        log.warn(`[xwx-deck] failed to synchronize client toggle rollback: ${(syncError as Error).message}`);
      });
    }
    log.warn(`[xwx-deck] client toggle rolled back (${client}): ${(error as Error).message}`);
    this.fireChange();
  }

  async readCodexConfig(): Promise<CodexConfigSnapshot> {
    const [config, settings] = await Promise.all([
      this.readUnderlyingCodexConfig(),
      this.settingsStore.read()
    ]);
    const preferredWindow = config.mode === 'compatible'
      ? settings.codexModels.compatibleContextWindow
      : settings.codexModels.officialContextWindow;
    const withWindow = preferredWindow > 0
      ? { ...config, modelContextWindow: preferredWindow }
      : config;
    return { ...withWindow, configOwnership: await this.resolveCodexOwnership(config, settings) };
  }

  /**
   * The renderer used to infer external ownership from its own cached provider
   * snapshot, which goes stale whenever the tray or another window changes the
   * route — that is where the unwanted "接管 ChatGPT 配置？" prompts came from.
   * Only this process knows every provider id and Gateway address Deck itself
   * may have written, so the verdict is produced here and merely consumed there.
   */
  private async resolveCodexOwnership(
    config: CodexConfigSnapshot,
    settings: XwXDeckSettings
  ): Promise<CodexConfigOwnership> {
    return resolveCodexConfigOwnership({
      activeProvider: config.activeProvider,
      activeBaseUrl: config.activeBaseUrl,
      modelCatalogSource: config.modelCatalogSource,
      deckProviderIds: deckOwnedCodexProviderIds(settings),
      managedLocalBaseUrls: await this.managedLocalBaseUrls().catch(() => [])
    });
  }

  async readCompatibleServiceConfig(client: ProviderClient = 'codex', expectedId?: string | null): Promise<CompatibleServiceSettings> {
    const settings = await this.settingsStore.read();
    if (expectedId !== undefined && expectedId !== settings.providers?.selected[client]) throw new Error('服务连接已变化，请刷新后重试。');
    const provider = selectedProvider(settings, client);
    return provider ?? { providerPreset: 'auto', displayName: '服务连接', baseUrl: '', bearerToken: '', codexApiFormat: 'responses' };
  }


  async readProviders(): Promise<ProviderSnapshot> {
    const settings = await this.settingsStore.read();
    const registry = settings.providers!;
    // The provider registry is owned by XwX Deck and must remain editable even
    // when an external Claude/ChatGPT config is temporarily unreadable. Probe
    // the two clients independently and fall back conservatively to the saved
    // selection so an unknown live client still protects its connection from
    // deletion without making the whole provider page unavailable.
    const [claudeStatus, codexStatus] = await Promise.allSettled([
      settings.claudePreferredMode === 'auto'
        ? advisoryRead(this.readUnderlyingClaudeService(), 'Claude')
        : Promise.resolve({ enabled: settings.claudePreferredMode === 'compatible' }),
      settings.codexPreferredMode === 'auto'
        ? advisoryRead(this.readUnderlyingCodexConfig(), 'ChatGPT')
        : Promise.resolve({ mode: settings.codexPreferredMode })
    ]);
    if (claudeStatus.status === 'rejected') {
      log.warn(`[xwx-deck] provider registry could not inspect Claude activity: ${(claudeStatus.reason as Error).message}`);
    }
    if (codexStatus.status === 'rejected') {
      log.warn(`[xwx-deck] provider registry could not inspect ChatGPT activity: ${(codexStatus.reason as Error).message}`);
    }
    return { ...registry, active: {
      codex: codexStatus.status === 'fulfilled'
        ? codexStatus.value.mode === 'compatible' ? registry.selected.codex : null
        : registry.selected.codex,
      claude: claudeStatus.status === 'fulfilled'
        ? claudeStatus.value.enabled ? registry.selected.claude : null
        : registry.selected.claude,
    } };
  }

  async saveProvider(input: ProviderInput): Promise<ProviderSnapshot> {
    return this.serializeMutation(async () => {
      if (!input || typeof input !== 'object') throw new Error('无效的连接配置。');
      const previous = await this.settingsStore.read();
      const registry = previous.providers!;
      const existing = input.id ? registry.connections.find(p => p.id === input.id) : undefined;
      if (input.id && !existing) throw new Error('连接已删除，请刷新后重试。');
      if (input.id) this.cancelProviderValidation(input.id);
      const displayName = typeof input.displayName === 'string' ? input.displayName : '';
      const nameError = providerNameError(displayName, existing?.displayName);
      if (nameError) throw new Error(nameError);
      if ((!existing || existing.displayName !== displayName) && registry.connections.some(p => p.id !== existing?.id && (p.displayName === displayName || p.codexProviderId === displayName))) throw new Error('此名称已被其他连接使用，请换一个名称。');
      if ((!existing || existing.displayName !== displayName) && (await this.codexConfig.read()).configuredProviders.includes(displayName)) throw new Error('Codex 已有同名 provider，请换一个名称以保留原配置。');
      if (!['auto', 'responses', 'chat-completions', 'anthropic-messages'].includes(input.adapter)) throw new Error('不支持的服务类型。');
      const adapter = input.adapter;
      const baseUrl = adapter === 'auto'
          ? normalizeCompatibleServiceBaseUrl(input.baseUrl)
          : normalizeProviderApiRoot(input.baseUrl);
      const url = new URL(baseUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入不含认证、查询参数的 HTTP(S) API 地址。');
      const bearerToken = typeof input.bearerToken === 'string' ? input.bearerToken.trim() : '';
      if (!bearerToken) throw new Error('请填写访问密钥。');
      const provider: ProviderConnection = { ...existing, id: existing?.id ?? randomUUID(),
        providerPreset: input.providerPreset === undefined ? existing?.providerPreset ?? detectProviderPreset(baseUrl) : normalizeProviderPreset(input.providerPreset),
        codexProviderId: existing && existing.displayName === displayName ? providerCodexId(existing) : displayName,
        displayName, baseUrl, bearerToken, adapter,
        codexApiFormat: adapter === 'auto' ? existing?.codexApiFormat ?? 'responses' : adapter,
        codexModel: typeof input.codexModel === 'string' ? input.codexModel.trim() : existing?.codexModel || '',
        codexContextWindow: existing?.codexContextWindow ?? 0,
        claudeModels: existing?.claudeModels ?? { fable: '', opus: '', sonnet: '', haiku: '' } };
      const [codexActive, claudeActive] = await Promise.all([
        existing && registry.selected.codex === existing.id
          ? this.readCodexConfig().then(value => value.mode === 'compatible' && value.configOwnership !== 'external')
          : false,
        existing && registry.selected.claude === existing.id
          ? this.readUnderlyingClaudeService().then(value => value.enabled)
          : false
      ]);
      const changed = !existing || existing.displayName !== displayName || existing.baseUrl !== baseUrl
        || existing.bearerToken !== bearerToken || existing.adapter !== provider.adapter
        || existing.providerPreset !== provider.providerPreset || existing.codexModel !== provider.codexModel;
      const affected = (['codex', 'claude'] as const).filter(c => c === 'codex' ? codexActive : claudeActive);
      for (const client of affected) if (!supportsProviderClient(provider, client)) throw new Error('该连接正在被客户端使用，请先切换服务再修改类型。');
      if (affected.includes('claude') && provider.adapter === 'anthropic-messages' && !/\/v1\/?$/.test(provider.baseUrl)) throw new Error('Claude 直连需要以 /v1 结尾的完整 API 地址。');
      try {
        this.settings = await this.settingsStore.update({ providers: { ...registry,
          connections: existing ? registry.connections.map(p => p.id === provider.id ? provider : p) : [...registry.connections, provider] } });
        if (changed && registry.selected.codex === provider.id) this.invalidateProviderCatalog();
        for (const client of changed ? affected : []) {
          await this.options.beforeCompatibleServiceServiceReapply?.(client);
          await this.setModelServiceUnlocked(client, true, true, { directProviderSwitch: true });
        }
      } catch (error) {
        this.fireChange();
        throw error;
      }
      this.fireChange();
      if (changed && affected.includes('claude')) this.scheduleClaudeDesktopSync();
      const saved = this.settings!;
      return { ...saved.providers!, active: {
        codex: saved.codexPreferredMode === 'official' ? null : saved.providers!.selected.codex,
        claude: saved.claudePreferredMode === 'official' ? null : saved.providers!.selected.claude,
      } };
    });
  }

  async deleteProvider(id: string): Promise<ProviderSnapshot> {
    return this.serializeMutation(async () => {
      this.cancelProviderValidation(id);
      const snapshot = await this.readProviders();
      const settings = await this.settingsStore.read();
      if (!snapshot.connections.some(p => p.id === id)) throw new Error('连接不存在。');
      if (snapshot.active.codex === id || snapshot.active.claude === id
        || settings.codexPreferredMode === 'compatible' && snapshot.selected.codex === id) {
        throw new Error('请先将正在使用此连接的客户端切换到官方或其他服务，再删除连接。');
      }
      const selected = { ...snapshot.selected };
      for (const client of ['codex', 'claude'] as const) if (selected[client] === id) selected[client] = null;
      this.settings = await this.settingsStore.update({ providers: { version: 1, selected, connections: snapshot.connections.filter(p => p.id !== id) } });
      if (snapshot.selected.codex === id) this.invalidateProviderCatalog();
      this.fireChange();
      return this.readProviders();
    });
  }

  async switchClientProvider(
    client: ProviderClient,
    id: string | null,
    options: { readonly takeOverExternalConfig?: boolean } = {}
  ): Promise<ProviderSnapshot> {
    return this.serializeMutation(async () => {
      if (!['codex', 'claude'].includes(client)) throw new Error('不支持的客户端。');
      const previous = await this.settingsStore.read();
      const registry = previous.providers!;
      const provider = id ? registry.connections.find(p => p.id === id) : undefined;
      if (id && !provider) throw new Error('连接不存在，请刷新后重试。');
      if (provider?.adapter === 'anthropic-messages' && client === 'claude' && !/\/v1\/?$/.test(provider.baseUrl)) throw new Error('Claude 直连需要以 /v1 结尾的完整 API 地址。');
      if (provider && !supportsProviderClient(provider, client)) throw new Error('此服务类型不支持当前客户端。');
      if (provider && (!provider.baseUrl || !provider.bearerToken)) throw new Error('请先保存服务地址和密钥。');
      this.selectionWarning = undefined;
      // Save explicit intent first. A failed write or a background read must
      // never choose the previous service on the user's behalf.
      this.settings = await this.settingsStore.update({
        providers: { ...registry, selected: {
          ...registry.selected,
          ...((id || client !== 'codex') ? { [client]: id } : {})
        } },
        ...(client === 'codex' ? { codexPreferredMode: id ? 'compatible' as const : 'official' as const } : {}),
        ...(client === 'claude' ? { claudePreferredMode: id ? 'compatible' as const : 'official' as const } : {})
      });
      try {
        // Selecting a connection is a local configuration action. Do not
        // inspect the other client's config or make a remote /models request
        // just to change the selected link.
        if (client === 'codex' && id !== registry.selected.codex) {
          this.invalidateProviderCatalog();
          if (provider) this.compatibleServiceCatalog = await readCompatibleServiceModelCatalogCache(
            this.compatibleServiceModelCatalogCachePath(), provider.baseUrl, provider.bearerToken,
            provider.providerPreset, true
          ).catch(() => []);
        }
        {
          await this.setModelServiceUnlocked(client, !!id, true, {
            directProviderSwitch: true,
            takeOverExternalConfig: options.takeOverExternalConfig === true,
            officialSelection: client === 'claude' && !id
          });
        }
      } catch (error) {
        this.fireChange();
        throw error;
      }
      this.fireChange();
      // The target config is written. A live read of the unrelated client is
      // not part of the switch and may never finish on a broken installation.
      const saved = this.settings ?? await this.settingsStore.read();
      const selected = saved.providers!.selected;
      return {
        ...saved.providers!,
        warning: this.selectionWarning,
        active: {
          codex: saved.codexPreferredMode === 'compatible' ? selected.codex : null,
          claude: saved.claudePreferredMode === 'official' ? null : selected.claude,
        }
      };
    });
  }

  /** A confirmed switch rebases on the live client file instead of retrying a stale write. */
  async repairClientProviderSwitch(client: ProviderClient, id: string | null): Promise<ProviderSnapshot> {
    return this.serializeMutation(async () => {
      const settings = await this.settingsStore.read();
      if (this.settingsStore.readProblem()) throw new Error('请先修复 XwX Deck 设置。');
      const registry = settings.providers!;
      if (id && !registry.connections.some(provider => provider.id === id && supportsProviderClient(provider, client))) {
        throw new Error('所选模型服务已不存在，请重新选择。');
      }
      let repairInvalidCodex = false;
      if (client === 'codex') {
        await this.codexConfig.backupBeforeConfirmedRepair();
        try {
          await this.codexConfig.read();
        } catch (error) {
          if (!/config\.toml.*格式错误|TOML.*(?:错误|解析)/i.test((error as Error).message)) throw error;
          repairInvalidCodex = true;
        }
      } else {
        await this.claudeConfig.backupBeforeConfirmedRepair();
      }
      if (client === 'codex') await this.codexConfig.forgetInvalidDirectRestoreState();
      this.settings = await this.settingsStore.update({
        providers: { ...registry, selected: { ...registry.selected, ...((id || client !== 'codex') ? { [client]: id } : {}) } },
        ...(client === 'codex' ? { codexPreferredMode: id ? 'compatible' as const : 'official' as const } : {}),
        ...(client === 'claude' ? { claudePreferredMode: id ? 'compatible' as const : 'official' as const } : {})
      });
      try {
        await this.setModelServiceUnlocked(client, !!id, true, {
          directProviderSwitch: true,
          takeOverExternalConfig: client === 'codex',
          repairInvalidCodex,
          confirmedClaudeRepair: client === 'claude',
          officialSelection: client === 'claude' && !id
        });
      } catch (error) {
        // Once the target has reached the client file, rolling back Deck's
        // selection would make the two disagree. Report the incomplete step.
        const targetWritten = client === 'codex'
          ? await this.codexConfig.read().then(config => config.mode === (id ? 'compatible' : 'official'), () => false)
          : await this.claudeConfig.read().then(config => config.enabled === !!id, () => false);
        throw new Error(targetWritten
          ? `目标配置已写入，但后续运行状态未完全更新：${(error as Error).message}`
          : (error as Error).message);
      }
      const saved = await this.settingsStore.read();
      const selected = saved.providers!.selected;
      if (client === 'codex') {
        const config = await this.codexConfig.read();
        if (config.mode !== (id ? 'compatible' : 'official')
          || id && config.compatible.model !== saved.codexModels.compatible
          || !id && config.officialModel !== saved.codexModels.official) {
          throw new Error('ChatGPT 配置复读后服务或模型与所选内容不一致。');
        }
        if (id && isLoopbackUrl(config.activeBaseUrl)
          && providerRequiresTrace(selectedProvider(saved, 'codex') ?? saved.compatible, saved.codexModels.compatible, this.compatibleServiceCatalog)) {
          await this.assertCodexGatewayRoute();
          if (config.activeBaseUrl !== `${this.localBaseUrl()?.replace(/\/+$/, '')}/backend-api/codex`) {
            throw new Error('ChatGPT 配置复读后没有指向已启动的模型路由。');
          }
        } else if (id) {
          const provider = selectedProvider(saved, 'codex');
          const directBaseUrl = provider?.adapter === 'auto'
            ? normalizeCompatibleServiceBaseUrl(provider.baseUrl)
            : provider?.baseUrl;
          if (isLoopbackUrl(config.activeBaseUrl)) {
            await this.assertCodexGatewayRoute();
            if (config.activeBaseUrl !== `${this.localBaseUrl()?.replace(/\/+$/, '')}/backend-api/codex`) {
              throw new Error('ChatGPT 配置复读后没有指向已启动的模型路由。');
            }
          } else if (!sameHttpEndpoint(config.activeBaseUrl, directBaseUrl)) {
            throw new Error('ChatGPT 配置复读后没有指向所选服务。');
          }
        }
        if (!id && isLoopbackUrl(config.activeBaseUrl)) {
          await this.assertCodexGatewayRoute();
          if (!sameHttpEndpoint(config.activeBaseUrl,
            `${this.localBaseUrl()?.replace(/\/+$/, '')}/backend-api/codex`)) {
            throw new Error('ChatGPT 配置复读后指向的不是当前运行中的 Gateway。');
          }
        }
        if (!id && this.codexGatewayEnabled && !isLoopbackUrl(config.activeBaseUrl)) {
          throw new Error('ChatGPT 配置与当前 Gateway 路由不一致。');
        }
      }
      if (client === 'claude') {
        const status = await this.claudeConfig.read();
        if (status.enabled !== !!id) throw new Error('Claude 配置复读后服务与所选服务不一致。');
        if (id) {
          const content = JSON.parse(await fs.promises.readFile(status.configPath, 'utf8')) as {
            env?: { ANTHROPIC_BASE_URL?: string };
          };
          const expectedBaseUrl = status.expectedBaseUrl;
          if (!expectedBaseUrl || content.env?.ANTHROPIC_BASE_URL !== expectedBaseUrl) {
            throw new Error('Claude 配置复读后没有指向所选服务。');
          }
        }
      }
      this.lastError = undefined;
      this.fireChange();
      return {
        ...saved.providers!,
        active: {
          codex: saved.codexPreferredMode === 'compatible' ? selected.codex : null,
          claude: saved.claudePreferredMode === 'official' ? null : selected.claude,
        }
      };
    });
  }

  private invalidateProviderCatalog(): void {
    this.compatibleServiceCatalog = [];
    this.compatibleServiceCatalogGeneration += 1;
    this.compatibleServiceCatalogRefreshedAt = 0;
  }

  async fetchProviderModels(
    id: string,
    refresh = false,
    synchronizeClaudeDesktop = true
  ): Promise<readonly ModelCatalogEntry[]> {
    const settings = await this.settingsStore.read();
    const provider = settings.providers!.connections.find(p => p.id === id);
    if (!provider) throw new Error('服务连接不存在。');
    const file = path.join(this.userDataDir, `provider-${id}-${provider.adapter}-models.json`);
    const cached = await readCompatibleServiceModelCatalogCache(file, provider.baseUrl, provider.bearerToken, provider.providerPreset);
    const catalog = !refresh && cached.length
      ? cached
      : await fetchProviderCatalog(provider, path.join(this.userDataDir, 'model-capabilities-cache.json'), false, cached);
    if (catalog !== cached) {
      await writeCompatibleServiceModelCatalogCache(file, provider.baseUrl, provider.bearerToken, catalog, provider.providerPreset);
      // Claude routes read which models need the Messages bridge from this cache.
      if (settings.providers?.selected?.claude === id && this.active && this.role === 'owner') {
        void this.refreshProxyRoutes('claude-cli').catch(error => {
          log.warn(`[xwx-deck] Claude route refresh after catalog update failed: ${(error as Error).message}`);
        });
      }
    }
    // Catalog discovery is a read. Desktop synchronization is an optional
    // side effect and must not hold up the catalog result or the config queue.
    if (synchronizeClaudeDesktop) this.scheduleClaudeDesktopSync(catalog, id);
    return catalog;
  }

  async updateCompatibleServiceConfig(input: Partial<CompatibleServiceSettings>): Promise<CompatibleServiceSettings> {
    return this.serializeMutation(() => this.updateCompatibleServiceConfigUnlocked(input));
  }

  private async updateCompatibleServiceConfigUnlocked(input: Partial<CompatibleServiceSettings>): Promise<CompatibleServiceSettings> {
    const previousSettings = await this.settingsStore.read();
    this.settings = previousSettings;
    const previousConnection = await this.readCompatibleServiceConfig();
    const previousCatalog = this.compatibleServiceCatalog;
    const previousCatalogGeneration = this.compatibleServiceCatalogGeneration;
    const previousCatalogRefreshedAt = this.compatibleServiceCatalogRefreshedAt;
    const displayName = typeof input.displayName === 'string'
      ? input.displayName.trim().replace(/\s+/g, ' ').slice(0, 80)
      : previousConnection.displayName;
    if (!displayName) throw new Error('服务商名称不能为空。');
    const baseUrl = normalizeCompatibleServiceBaseUrl(
      typeof input.baseUrl === 'string' ? input.baseUrl : previousConnection.baseUrl
    );
    const providerPreset = input.providerPreset !== undefined
      ? normalizeProviderPreset(input.providerPreset)
      : typeof input.baseUrl === 'string'
        ? detectProviderPreset(baseUrl)
        : previousConnection.providerPreset;
    const bearerToken = typeof input.bearerToken === 'string'
      ? input.bearerToken.trim()
      : previousConnection.bearerToken;
    // 前端每次切模型都会显式传 codexApiFormat（gpt 传 'responses'，第三方含 grok 传
    // 'chat-completions'）。必须忠实采用显式值，否则一旦锁存成 chat-completions 就再也
    // 切不回 responses——gpt 会被持续误挂协议转换、disable 也被拦死。仅 undefined 时保留旧值。
    const codexApiFormat = input.codexApiFormat === 'chat-completions'
      || input.codexApiFormat === 'anthropic-messages'
      || input.codexApiFormat === 'responses'
      ? input.codexApiFormat
      : previousConnection.codexApiFormat;
    const connectionChanged = baseUrl !== previousConnection.baseUrl
      || bearerToken !== previousConnection.bearerToken
      || providerPreset !== previousConnection.providerPreset
      || codexApiFormat !== previousConnection.codexApiFormat;
    if (!connectionChanged) {
      this.settings = await this.settingsStore.update({ compatible: { displayName, providerPreset } });
      return { ...previousConnection, displayName, providerPreset };
    }
    if (!baseUrl) throw new Error('服务商地址不能为空。');
    if (!bearerToken) throw new Error('服务商密钥不能为空。');
    const claudeSharesConnection = previousSettings.providers?.selected.claude === previousSettings.providers?.selected.codex;
    const [codex, claudeStatus] = await Promise.all([
      this.readUnderlyingCodexConfig(),
      claudeSharesConnection ? this.readUnderlyingClaudeService() : Promise.resolve(undefined)
    ]);
    const codexActive = codex.mode === 'compatible';
    const claudeActive = claudeStatus?.enabled || claudeStatus?.status === 'drifted';
    try {
      this.settings = await this.settingsStore.update({
        compatible: { displayName, providerPreset, baseUrl, bearerToken, codexApiFormat }
      });
      // Capabilities, including the 1M context limit, belong to this exact
      // connection. Never reuse metadata fetched from the previous endpoint.
      this.compatibleServiceCatalog = [];
      this.compatibleServiceCatalogGeneration += 1;
      this.compatibleServiceCatalogRefreshedAt = 0;
      if (codexActive) {
        await this.options.beforeCompatibleServiceServiceReapply?.('codex');
        await this.setModelServiceUnlocked('codex', true);
      } else {
        await this.codexConfig.updateCompatibleServiceConnection({ baseUrl, bearerToken });
      }
      if (claudeActive) {
        await this.options.beforeCompatibleServiceServiceReapply?.('claude');
        await this.setModelServiceUnlocked('claude', true);
      }
      if (this.active && this.role === 'owner') {
        await this.refreshProxyRoutes();
      }
      return { displayName, providerPreset, baseUrl, bearerToken, codexApiFormat };
    } catch (error) {
      this.compatibleServiceCatalog = previousCatalog;
      this.compatibleServiceCatalogGeneration = previousCatalogGeneration;
      this.compatibleServiceCatalogRefreshedAt = previousCatalogRefreshedAt;
      try {
        this.settings = await this.settingsStore.update({ compatible: previousSettings.compatible });
      } catch (settingsError) {
        this.settings = previousSettings;
        log.error(`[xwx-deck] CompatibleService connection rollback could not be persisted: ${(settingsError as Error).message}`);
      }
      if (codexActive) {
        await this.setModelServiceUnlocked('codex', true).catch(rollbackError => {
          log.error(`[xwx-deck] ChatGPT CompatibleService connection rollback failed: ${(rollbackError as Error).message}`);
        });
      } else {
        await this.codexConfig.updateCompatibleServiceConnection({
          baseUrl: previousSettings.compatible.baseUrl,
          bearerToken: previousSettings.compatible.bearerToken
        }).catch(rollbackError => {
          log.error(`[xwx-deck] stored ChatGPT CompatibleService connection rollback failed: ${(rollbackError as Error).message}`);
        });
      }
      if (claudeActive) {
        await this.setModelServiceUnlocked('claude', true).catch(rollbackError => {
          log.error(`[xwx-deck] Claude CompatibleService connection rollback failed: ${(rollbackError as Error).message}`);
        });
      }
      if (this.active && this.role === 'owner') {
        await this.refreshProxyRoutesBestEffort('CompatibleService connection rollback');
      }
      throw error;
    }
  }

  async readModelServices(): Promise<ModelServiceSnapshot> {
    const [claudeStatus, codex] = await Promise.all([
      this.readUnderlyingClaudeService(),
      this.readUnderlyingCodexConfig()
    ]);
    return { claude: claudeStatus.enabled, codex: codex.mode === 'compatible', claudeStatus };
  }

  async readClaudeEnvironmentOverrides() {
    return this.claudeConfig.readEnvironmentOverrides();
  }

  async clearClaudeEnvironmentOverrides(names: readonly string[]) {
    // Environment cleanup is serialized by ClaudeConfigManager itself. Keep it
    // outside the global provider/Trace queue so an unrelated client operation
    // cannot leave the confirmation flow waiting behind it.
    return this.claudeConfig.clearEnvironmentOverrides(names);
  }

  async setModelService(client: 'claude' | 'codex', enabled: boolean): Promise<ModelServiceSnapshot> {
    return this.serializeMutation(async () => {
      this.settings = await this.settingsStore.update(client === 'codex'
        ? { codexPreferredMode: enabled ? 'compatible' : 'official' }
        : { claudePreferredMode: enabled ? 'compatible' : 'official' });
      await this.setModelServiceUnlocked(client, enabled, false, {
        directProviderSwitch: true,
        officialSelection: client === 'claude' && !enabled
      });
      return this.readModelServices();
    });
  }

  private async setModelServiceUnlocked(
    client: 'claude' | 'codex',
    enabled: boolean,
    restoreSelection = false,
    options: {
      readonly directProviderSwitch?: boolean;
      readonly takeOverExternalConfig?: boolean;
      readonly repairInvalidCodex?: boolean;
      readonly confirmedClaudeRepair?: boolean;
      readonly officialSelection?: boolean;
    } = {}
  ): Promise<void> {
    const connection = await this.readCompatibleServiceConfig(client);
    if (enabled && (!connection.baseUrl || !connection.bearerToken)) {
      throw new Error(`请先在设置中填写并保存 ${connection.displayName} 地址和密钥。`);
    }
    const settings = await this.settingsStore.read();
    if (client === 'claude') {
      // Invalidate any directory refresh queued for the previous service
      // before it can put its Desktop profile back after this switch.
      this.desktopSyncGeneration += 1;
      const catalog = enabled
        ? options.directProviderSwitch ? [] : await this.cachedClaudeCompatibleServiceCatalog(settings)
        : this.compatibleServiceCatalog;
      const update = {
        enabled,
        baseUrl: connection.baseUrl,
        bearerToken: connection.bearerToken,
        nativeAnthropic: selectedProvider(settings, 'claude')?.adapter === 'anthropic-messages',
        models: settings.claudeModels,
        catalog
      };
      await this.withUnderlyingClient('claude-cli', async () => {
        if (options.confirmedClaudeRepair) await this.claudeConfig.repair(update);
        else await this.claudeConfig.update(update);
        if (!enabled && options.officialSelection) await this.claudeConfig.switchToOfficial();
      }, options.directProviderSwitch);
    } else {
      if (enabled && restoreSelection) {
        if (options.directProviderSwitch) {
          // Keep the last selected model (or the connection's remembered
          // model) and let the model picker refresh it separately. Switching
          // the service link must not depend on the new service exposing a
          // /models endpoint.
        } else {
          const catalog = await this.fetchModels('compatible', false, true);
          const chosen = settings.codexModels.compatible;
          if (chosen && !catalog.some(m => m.id === chosen && m.clients.includes('codex'))) {
            const provider = selectedProvider(settings, 'codex');
            if (provider) this.compatibleServiceCatalog = [...catalog, configuredProviderModel({ ...provider, codexModel: chosen })];
          }
          if (!chosen) {
            const first = catalog.find(m => m.clients.includes('codex') && !isKnownNonConversationalModel(m.id));
            if (!first) throw new Error('此服务没有可供 ChatGPT 使用的模型。');
            this.settings = await this.settingsStore.update({ codexModels: { compatible: first.id } });
          }
        }
      }
      await this.withUnderlyingClient('codex-cli', async () => {
        let selectedSettings = await this.settingsStore.read();
        let current: CodexConfigSnapshot;
        try {
          current = await this.codexConfig.read();
        } catch (error) {
          if (!options.repairInvalidCodex
            || !/config\.toml.*格式错误|TOML.*(?:错误|解析)/i.test((error as Error).message)) throw error;
          current = await this.codexConfig.readFromContent(undefined);
        }
        if (enabled && restoreSelection && options.directProviderSwitch && !selectedSettings.codexModels.compatible) {
          const provider = selectedProvider(selectedSettings, 'codex');
          const model = provider?.codexModel?.trim() || current.compatible.model;
          if (model) {
            this.settings = await this.settingsStore.update({ codexModels: { compatible: model } });
            selectedSettings = await this.settingsStore.read();
          }
        }
        const officialSelection = enabled
          ? {
              model: settings.codexModels.official,
              contextWindow: settings.codexModels.officialContextWindow || null,
              repaired: false
            }
          : this.repairRememberedOfficialSelection(
              settings.codexModels.official,
              settings.codexModels.officialContextWindow
            );
        const activeCompatibleServiceModel = restoreSelection
          ? selectedSettings.codexModels.compatible || selectedProvider(selectedSettings, 'codex')?.codexModel || ''
          : current.mode === 'compatible'
          ? current.compatible.model
          : settings.codexModels.compatible || current.compatible.model;
        const update: CodexConfigUpdate = {
          mode: enabled ? 'compatible' : 'official',
          officialModel: officialSelection.model,
          compatibleModel: activeCompatibleServiceModel,
          compatibleBaseUrl: connection.baseUrl,
          compatibleBearerToken: connection.bearerToken,
          modelContextWindow: enabled
            ? settings.codexModels.compatibleContextWindow || null
            : officialSelection.contextWindow,
          preserveOfficialLogin: settings.codexEnhancements.preserveOfficialLogin,
          unifySessionHistory: settings.codexEnhancements.unifySessionHistory,
          takeOverExternalConfig: options.takeOverExternalConfig === true
        };
        if (options.directProviderSwitch) {
          await this.applySelectedCodexConfig(update, options.repairInvalidCodex);
        } else {
          await this.applyCodexConfigAndAuth(update);
        }
        this.settings = await this.settingsStore.update({
          codexPreferredMode: enabled ? 'compatible' : 'official',
          codexModels: enabled
            ? { compatible: activeCompatibleServiceModel }
            : {
                official: officialSelection.model,
                officialContextWindow: officialSelection.contextWindow ?? 0
              }
        });
        if (!enabled && officialSelection.repaired) {
          log(`[xwx-deck] repaired invalid remembered official model selection to ${officialSelection.model}[256K]`);
        }
      }, options.directProviderSwitch);
    }
    if (client === 'claude') try {
      if (enabled && settings.claudeDesktop.syncEnabled) {
        if (options.directProviderSwitch) {
          this.claudeDesktopCatalog = [];
          this.scheduleClaudeDesktopSync(undefined, settings.providers?.selected.claude ?? undefined);
        } else {
          this.scheduleClaudeDesktopSync();
        }
      } else if (!enabled) {
        if (settings.claudeDesktop.syncEnabled) await this.claudeDesktopConfig.restoreOfficial();
        else await this.claudeDesktopConfig.restore();
        this.claudeDesktopCatalog = [];
        this.claudeDesktopGatewayEnabled = false;
        if (this.active && this.role === 'owner') await this.refreshProxyRoutes();
        await this.stopClaudeDesktopGatewayIfUnused();
      }
    } catch (error) {
      if (!options.directProviderSwitch) throw error;
      this.selectionWarning = `服务配置已保存，Claude Desktop 同步未完成：${(error as Error).message}`;
      this.desktopSyncError = (error as Error).message;
    }
    this.fireChange();
    if (client === 'codex') {
      this.scheduleCodexHistoryProviderAudit('service switch');
      this.scheduleCodexHistoryWork('service switch');
    }
  }

  async readClaudeModels(): Promise<ClaudeModelSettings> {
    const settings = await this.settingsStore.read();
    return settings.claudeModels;
  }

  async readClaudeDesktopSync(): Promise<ClaudeDesktopSyncSnapshot> {
    const settings = await this.settingsStore.read();
    const snapshot = await this.claudeDesktopConfig.read();
    return { ...snapshot, enabled: settings.claudeDesktop.syncEnabled };
  }

  async updateClaudeDesktopSync(enabled: boolean): Promise<ClaudeDesktopSyncSnapshot> {
    const snapshot = await this.serializeMutation(async () => {
      if (typeof enabled !== 'boolean') throw new Error('无效的 Claude Desktop 同步设置。');
      if (!enabled) this.desktopSyncGeneration += 1;
      const previous = await this.settingsStore.read();
      try {
        this.settings = await this.settingsStore.update({
          claudeDesktop: { syncEnabled: enabled }
        });
        if (!enabled) {
          this.claudeDesktopCatalog = [];
          this.claudeDesktopGatewayEnabled = false;
          await this.claudeDesktopConfig.restore();
          if (this.active && this.role === 'owner') await this.refreshProxyRoutes();
          await this.stopClaudeDesktopGatewayIfUnused();
        }
      } catch (error) {
        this.settings = await this.settingsStore.update({
          claudeDesktop: { syncEnabled: previous.claudeDesktop.syncEnabled }
        }).catch(() => previous);
        if (!previous.claudeDesktop.syncEnabled) {
          await this.claudeDesktopConfig.restore().catch(() => undefined);
          this.claudeDesktopCatalog = [];
          this.claudeDesktopGatewayEnabled = false;
          if (this.active && this.role === 'owner') await this.refreshProxyRoutesBestEffort('Claude Desktop toggle rollback');
          await this.stopClaudeDesktopGatewayIfUnused().catch(() => undefined);
        }
        throw error;
      }
      this.fireChange();
      return this.readClaudeDesktopSync();
    });
    if (enabled) this.scheduleClaudeDesktopSync();
    return snapshot;
  }

  /** 保存 Claude 模型映射；仅在 Claude CompatibleService 代理启用时写入客户端配置。 */
  async updateClaudeModels(input: Partial<ClaudeModelSettings> & { expectedProviderId?: string | null }): Promise<ClaudeModelSettings> {
    return this.serializeMutation(() => this.updateClaudeModelsUnlocked(input));
  }

  private async updateClaudeModelsUnlocked(input: Partial<ClaudeModelSettings> & { expectedProviderId?: string | null }): Promise<ClaudeModelSettings> {
    const previous = await this.settingsStore.read();
    const currentService = previous.claudePreferredMode === 'auto'
      ? await this.readUnderlyingClaudeService()
      : { enabled: previous.claudePreferredMode === 'compatible' };
    const providerId = currentService.enabled ? previous.providers?.selected.claude : null;
    if (input.expectedProviderId !== undefined && input.expectedProviderId !== providerId) throw new Error('服务已变化，请刷新模型设置后重试。');
    const { expectedProviderId: _expected, ...models } = input;
    this.selectionWarning = undefined;
    try {
      this.settings = await this.settingsStore.update({ claudeModels: models });
      const connection = await this.readCompatibleServiceConfig('claude');
      // Saving a chosen model must not wait for a remote /models request. A
      // matching local catalog supplies context metadata when already known.
      const catalog = currentService.enabled ? await this.cachedClaudeCompatibleServiceCatalog(this.settings) : [];
      await this.withUnderlyingClient('claude-cli', async () => {
        if (currentService.enabled) {
          await this.claudeConfig.update({
            enabled: true,
            baseUrl: connection.baseUrl,
            bearerToken: connection.bearerToken,
            nativeAnthropic: selectedProvider(this.settings!, 'claude')?.adapter === 'anthropic-messages',
            models: this.settings?.claudeModels,
            catalog
          });
        }
      }, true);
    } catch (error) {
      this.fireChange();
      throw error;
    }
    this.fireChange();
    if (this.active && this.role === 'owner') await this.refreshProxyRoutes('claude-cli').catch(error => {
      log.warn(`[xwx-deck] Claude route refresh after model change failed: ${(error as Error).message}`);
    });
    this.scheduleClaudeDesktopSync(undefined, previous.providers?.selected.claude ?? undefined);
    return this.settings.claudeModels;
  }

  async updateCodexConfig(input: CodexConfigUpdate): Promise<CodexConfigSnapshot> {
    return this.serializeMutation(() => this.updateCodexConfigUnlocked(input));
  }

  private async updateCodexConfigUnlocked(input: CodexConfigUpdate): Promise<CodexConfigSnapshot> {
    const settings = await this.settingsStore.read();
    if (input.expectedProviderId !== undefined && input.takeOverExternalConfig !== true
      && (await this.readCodexConfig()).configOwnership === 'external') {
      throw new Error('ChatGPT 正在使用外部配置，请先选择服务连接后再修改模型。');
    }
    if (input.expectedProviderId !== undefined && input.expectedProviderId !== (settings.codexPreferredMode === 'compatible' ? settings.providers?.selected.codex : null)) throw new Error('服务已变化，请刷新模型设置后重试。');
    const provider = selectedProvider(settings, 'codex');
    if (input.expectedProviderId && provider) input = { ...input, compatibleBaseUrl: provider.baseUrl, compatibleBearerToken: provider.bearerToken };
    this.selectionWarning = undefined;
    const mode = input.mode === 'compatible' ? 'compatible' : 'official';
    this.settings = await this.settingsStore.update({
      codexPreferredMode: mode,
      ...(mode === 'compatible' ? { compatible: {
        ...(typeof input.compatibleBaseUrl === 'string' ? { baseUrl: input.compatibleBaseUrl } : {}),
        ...(typeof input.compatibleBearerToken === 'string' ? { bearerToken: input.compatibleBearerToken } : {})
      } } : {}),
      codexModels: mode === 'official'
        ? { official: String(input.officialModel ?? settings.codexModels.official), officialContextWindow: Number(input.modelContextWindow ?? 0) }
        : { compatible: String(input.compatibleModel ?? settings.codexModels.compatible), compatibleContextWindow: Number(input.modelContextWindow ?? 0) }
    });
    const next = await this.withUnderlyingClient('codex-cli', () => this.applySelectedCodexConfig({
      ...input,
      persistOfficialSelection: input.mode === 'official',
      preserveOfficialLogin: settings.codexEnhancements.preserveOfficialLogin,
      unifySessionHistory: settings.codexEnhancements.unifySessionHistory
    }), true);
    this.settings = await this.settingsStore.update({
      codexPreferredMode: next.mode,
      codexModels: next.mode === 'official'
        ? {
            official: next.officialModel,
            officialContextWindow: next.modelContextWindow ?? 0
          }
        : {
            compatible: next.compatible.model,
            compatibleContextWindow: next.modelContextWindow ?? 0
          }
    });
    this.fireChange();
    this.scheduleCodexHistoryProviderAudit('model config update');
    return { ...next, warning: this.selectionWarning };
  }

  async readCodexEnhancements(history?: CodexHistoryMigrationOutcome): Promise<CodexEnhancementsSnapshot> {
    // Enhancement preferences belong to Deck; malformed model TOML must not
    // hide them. Authentication is stored separately in auth.json.
    const [settings, authMode, hasHistoryBackup] = await Promise.all([
      this.settingsStore.read(),
      this.codexConfig.readAuthMode(),
      this.codexHistory.hasMigrationBackup()
    ]);
    return {
      preserveOfficialLogin: settings.codexEnhancements.preserveOfficialLogin,
      authMode,
      unifySessionHistory: settings.codexEnhancements.unifySessionHistory,
      historyRestorePending: settings.codexEnhancements.pendingHistoryRestore,
      hasHistoryBackup,
      ...(history ? { history } : {})
    };
  }

  async updateCodexEnhancements(input: CodexEnhancementsUpdate): Promise<CodexEnhancementsSnapshot> {
    const saved = await this.serializeMutation(() => this.updateCodexEnhancementsUnlocked(input));
    if (input.unifySessionHistory === true && input.migrateExisting === true
      || input.unifySessionHistory === false && input.restoreExisting === true) {
      // History migration can scan gigabytes. The requested toggle still
      // awaits its result, but unrelated configuration writes must not queue
      // behind that scan.
      return this.runExplicitCodexHistoryUpdate(input);
    }
    return saved;
  }

  private async runExplicitCodexHistoryUpdate(input: CodexEnhancementsUpdate): Promise<CodexEnhancementsSnapshot> {
    let history: CodexHistoryMigrationOutcome;
    if (input.unifySessionHistory === true) {
      history = await this.mergeCodexHistory();
      if (history.skippedReason === 'restore_deferred') {
        this.scheduleCodexHistoryWork('retry history migration after ChatGPT exit', 30_000);
      } else if (history.skippedLockedJsonlFiles + history.skippedLockedStateDbs > 0) {
        this.scheduleCodexHistoryWork('retry locked history migration');
      }
    } else {
      try { history = await this.codexHistory.restoreSeparatedHistory(); }
      catch (error) {
        this.scheduleCodexHistoryWork('retry failed history restore');
        this.fireChange();
        throw error;
      }
      const locked = history.skippedLockedJsonlFiles + history.skippedLockedStateDbs;
      if (history.skippedReason === 'restore_deferred' || locked > 0) {
        this.settings = await this.settingsStore.update({
          codexEnhancements: { pendingHistoryRestore: true }
        });
        this.scheduleCodexHistoryWork(
          history.skippedReason === 'restore_deferred'
            ? 'retry history restore after ChatGPT exit'
            : 'restore locked history',
          history.skippedReason === 'restore_deferred' ? 30_000 : 6_000
        );
      } else if (history.skippedReason !== 'no_backup_ledger') {
        this.settings = await this.settingsStore.update({
          codexEnhancements: { pendingHistoryRestore: false }
        });
      }
    }
    this.fireChange();
    return this.readCodexEnhancements(history);
  }

  private async updateCodexEnhancementsUnlocked(input: CodexEnhancementsUpdate): Promise<CodexEnhancementsSnapshot> {
    const hasPreserveUpdate = typeof input.preserveOfficialLogin === 'boolean';
    const hasHistoryUpdate = typeof input.unifySessionHistory === 'boolean';
    if (!hasPreserveUpdate && !hasHistoryUpdate) throw new Error('无效的 ChatGPT 增强设置。');
    if (input.preserveOfficialLogin !== undefined && !hasPreserveUpdate) throw new Error('无效的 ChatGPT 官方登录设置。');
    if (input.unifySessionHistory !== undefined && !hasHistoryUpdate) throw new Error('无效的 ChatGPT 会话历史设置。');

    const previousSettings = await this.settingsStore.read();
    const preserveOfficialLogin = hasPreserveUpdate
      ? input.preserveOfficialLogin as boolean
      : previousSettings.codexEnhancements.preserveOfficialLogin;
    const unifySessionHistory = hasHistoryUpdate
      ? input.unifySessionHistory as boolean
      : previousSettings.codexEnhancements.unifySessionHistory;
    if (hasPreserveUpdate) {
      await this.withUnderlyingClient('codex-cli', async () => {
        const current = await this.codexConfig.read();
        if (current.mode === 'compatible') {
          const connection = await this.readCompatibleServiceConfig();
          await this.applyCodexConfigAndAuth({
            mode: 'compatible',
            officialModel: current.officialModel,
            compatibleModel: current.compatible.model,
            compatibleBaseUrl: connection.baseUrl,
            compatibleBearerToken: connection.bearerToken,
            preserveOfficialLogin,
            unifySessionHistory
          });
        } else {
          // Turning preservation off while using the official service records
          // the preference only. The user's OAuth/API key remains live until
          // they actually switch to CompatibleService.
          await this.codexOfficialAuth.restoreOfficialLogin();
        }
      });
    }

    if (hasHistoryUpdate && unifySessionHistory && input.migrateExisting === true) {
      await this.ensureCodexHistoryPrerequisites(true);
    }
    this.settings = await this.settingsStore.update({
      codexEnhancements: {
        preserveOfficialLogin,
        unifySessionHistory,
        pendingHistoryRestore: hasHistoryUpdate
          ? !unifySessionHistory && input.restoreExisting === true
          : previousSettings.codexEnhancements.pendingHistoryRestore
      }
    });

    if (hasHistoryUpdate) {
      try { await this.alignCodexHistoryIdentity(); }
      catch (error) { this.settings = await this.settingsStore.update(previousSettings); throw error; }
    }
    this.fireChange();
    return this.readCodexEnhancements();
  }

  async fetchModels(
    source: 'active' | 'compatible' = 'active',
    refresh = false,
    insideMutation = false,
    expectedProviderId?: string | null
  ): Promise<readonly ModelCatalogEntry[]> {
    const generation = this.compatibleServiceCatalogGeneration;
    const settings = this.settings ?? await this.settingsStore.read();
    const provider = selectedProvider(settings, 'codex');
    const mode = settings.codexPreferredMode === 'auto'
      ? (await this.codexConfig.read()).mode : settings.codexPreferredMode;
    const activeId = mode === 'compatible' ? provider?.id ?? null : null;
    if (expectedProviderId !== undefined && expectedProviderId !== activeId) throw new Error('服务连接已变化，请重新加载模型。');
    const assertCurrent = () => {
      if (generation !== this.compatibleServiceCatalogGeneration) throw new Error('服务连接已变化，请重新加载模型。');
    };
    if (source === 'active' && mode === 'official') {
      const catalog = await readCodexOfficialModelCatalog(settings.codexModels.official);
      assertCurrent();
      return catalog;
    }
    const connection = provider ?? settings.compatible;
    const baseUrl = connection.baseUrl.trim().replace(/\/+$/, '');
    const token = connection.bearerToken.trim();
    if (!baseUrl) throw new Error('请先填写并保存公司 API 网关。');
    if (!token) throw new Error('请先填写并保存公司 API 密钥。');
    if (!refresh && this.compatibleServiceCatalog.length) {
      const catalog = this.compatibleServiceCatalog;
      assertCurrent();
      await this.syncCatalogAfterFetch(catalog, insideMutation);
      return catalog;
    }
    if (!refresh) {
      const cached = await readCompatibleServiceModelCatalogCache(
        this.compatibleServiceModelCatalogCachePath(),
        baseUrl,
        token,
        provider?.providerPreset ?? settings.compatible.providerPreset
      );
      if (cached.length) {
        assertCurrent();
        this.compatibleServiceCatalog = cached;
        await this.syncCatalogAfterFetch(cached, insideMutation);
        return cached;
      }
    }
    assertCurrent();
    const catalog = await this.refreshCompatibleServiceModelCatalog(baseUrl, token, refresh);
    if (generation !== this.compatibleServiceCatalogGeneration) throw new Error('服务连接已变化，请重新加载模型。');
    await this.syncCatalogAfterFetch(catalog, insideMutation);
    return catalog;
  }

  private async syncCatalogAfterFetch(
    catalog: readonly ModelCatalogEntry[],
    insideMutation: boolean
  ): Promise<void> {
    if (insideMutation) {
      await this.syncCodexCatalogIfCompatibleServiceActive(catalog);
      return;
    }
    // The remote request is already done. Only the local catalog publication
    // joins the config queue, so it cannot race a provider/Trace write.
    void this.serializeMutation(
      () => this.syncCodexCatalogIfCompatibleServiceActive(catalog)
    ).catch(error => {
      log.warn(`[xwx-deck] Codex catalog publication skipped: ${(error as Error).message}`);
    });
  }

  /** Refresh data-only model metadata without changing the selected provider. */
  async refreshModelMetadata(): Promise<number> {
    const settings = this.settings ?? await this.settingsStore.read();
    const claude = this.claudeCatalogTarget(settings);
    // Snapshot first: when Claude and Codex share a connection file, the Codex
    // refresh below rewrites it and the change would otherwise go unnoticed.
    const claudeBefore = claude
      ? await readCompatibleServiceModelCatalogCache(claude.file, claude.provider.baseUrl, claude.provider.bearerToken, claude.provider.providerPreset, true).catch(() => [])
      : [];
    const connection = await this.readCompatibleServiceConfig();
    const baseUrl = connection.baseUrl.trim().replace(/\/+$/, '');
    const token = connection.bearerToken.trim();
    let count = 0;
    let codexRefreshed = false;
    if (baseUrl && token) {
      const catalog = await this.refreshCompatibleServiceModelCatalog(baseUrl, token, true);
      await this.serializeMutation(
        () => this.syncCodexCatalogIfCompatibleServiceActive(catalog)
      );
      count = catalog.length;
      codexRefreshed = true;
    }
    const claudeCatalog = claude ? await this.refreshClaudeCatalogFile(claude, claudeBefore, codexRefreshed) : undefined;
    if (!codexRefreshed && !claude) return 0;
    await this.refreshProxyRoutes();
    if (claude && claudeCatalog) this.scheduleClaudeDesktopSync(claudeCatalog, claude.provider.id);
    this.fireChange();
    return count;
  }

  /** Claude routes and Desktop read the selected Claude connection's own directory cache. */
  private claudeCatalogTarget(settings: XwXDeckSettings): { readonly provider: ProviderConnection; readonly file: string } | undefined {
    const provider = selectedProvider(settings, 'claude');
    // Only a Claude client that is in use (CLI routed, or Desktop synced) needs the refresh.
    if (!settings.clientEnabled.claude && !settings.claudeDesktop.syncEnabled) return undefined;
    if (!provider?.baseUrl.trim() || !provider.bearerToken.trim()) return undefined;
    return { provider, file: path.join(this.userDataDir, `provider-${provider.id}-${provider.adapter}-models.json`) };
  }

  /**
   * Background metadata refresh for Claude's connection. Returns the new
   * catalog only when it differs from `before`, so Desktop is resynchronized
   * for real changes (new models, capabilities or protocols) alone.
   */
  private async refreshClaudeCatalogFile(
    target: { readonly provider: ProviderConnection; readonly file: string },
    before: readonly ModelCatalogEntry[],
    codexRefreshed: boolean
  ): Promise<readonly ModelCatalogEntry[] | undefined> {
    const { provider, file } = target;
    try {
      let after: readonly ModelCatalogEntry[];
      if (codexRefreshed && file === this.compatibleServiceModelCatalogCachePath()) {
        after = await readCompatibleServiceModelCatalogCache(file, provider.baseUrl, provider.bearerToken, provider.providerPreset, true);
      } else {
        // The Codex refresh already reloaded models.dev/LiteLLM in memory;
        // without it this is the only strong refresh of the cycle.
        after = await fetchProviderCatalog(provider, path.join(this.userDataDir, 'model-capabilities-cache.json'), !codexRefreshed, before);
        await writeCompatibleServiceModelCatalogCache(file, provider.baseUrl, provider.bearerToken, after, provider.providerPreset);
      }
      return sameCachedModelCatalog(after, before) ? undefined : after;
    } catch (error) {
      log.warn(`[xwx-deck] Claude 模型目录后台刷新失败：${(error as Error).message}`);
      return undefined;
    }
  }

  async xwxDeckFolder(): Promise<void> {
    await fs.promises.mkdir(this.traceStore.rootPath(), { recursive: true });
    const { shell } = await import('electron');
    await shell.openPath(this.traceStore.rootPath());
  }

  async readCodexConversationDetail(request: CodexConversationDetailRequest): Promise<CodexConversationHealthRow> {
    return this.codexConversationWorker.detail(request);
  }

  cancelCodexConversationScan(requestId: string): boolean {
    return this.codexConversationWorker.cancel(requestId);
  }

  setCodexConversationDiagnosticsActive(active: boolean): boolean {
    this.codexConversationWorker.setActive(active);
    return true;
  }

  async openLogFolder(): Promise<void> {
    const root = this.logRootPath();
    await fs.promises.mkdir(root, { recursive: true });
    const { shell } = await import('electron');
    await shell.openPath(root);
  }

  async updateTraceDirectories(input: TraceDirectoryUpdate): Promise<XwXDeckRuntimeState> {
    return this.serializeMutation(() => this.updateTraceDirectoriesUnlocked(input));
  }

  private async updateTraceDirectoriesUnlocked(input: TraceDirectoryUpdate): Promise<XwXDeckRuntimeState> {
    const hasTraceRoot = input.traceRoot !== undefined;
    const hasLogRoot = input.logRoot !== undefined;
    const hasClaudeConfigDir = input.claudeConfigDir !== undefined;
    if (!hasTraceRoot && !hasLogRoot && !hasClaudeConfigDir) throw new Error('没有需要修改的目录。');

    const current = await this.settingsStore.read();
    const nextTraceRoot = hasTraceRoot
      ? readSelectedDirectory(input.traceRoot, 'Trace 数据目录')
      : resolveRuntimeDirectory(current.traceRoot, path.join(this.userDataDir, 'xwx-trace'));
    const nextLogRoot = hasLogRoot
      ? readSelectedDirectory(input.logRoot, '日志目录')
      : resolveRuntimeDirectory(current.logRoot, path.join(this.userDataDir, 'logs'));
    const nextClaudeConfigDir = hasClaudeConfigDir
      ? readSelectedDirectory(input.claudeConfigDir, 'Claude 配置目录')
      : current.claudeConfigDir;
    const traceChanged = !sameDirectory(nextTraceRoot, this.traceStore.rootPath());

    if (traceChanged && this.active) throw new Error('请先停止 Trace，再修改 Trace 数据目录。');
    if (traceChanged && this.hasManagedBackgroundDataPlane()) {
      throw new Error('Trace 关闭尚未完成。请先恢复直连配置并关闭 Trace，再修改数据目录。');
    }
    if (hasClaudeConfigDir) {
      if (this.active) throw new Error('请先停止 Trace，再修改 Claude 配置目录。');
      const service = await this.claudeConfig.read();
      if (service.status !== 'disabled') {
        throw new Error('请先关闭 Claude CompatibleService 代理并恢复原配置，再修改 Claude 配置目录。');
      }
      const environmentDir = process.env.CLAUDE_CONFIG_DIR?.trim();
      if (environmentDir) {
        if (!path.isAbsolute(environmentDir)) {
          throw new Error('环境变量 CLAUDE_CONFIG_DIR 必须是绝对路径；当前值无法安全匹配 Claude CLI。');
        }
        const effectiveDir = path.dirname(resolveClientPaths(process.env).claudeSettingsPath);
        if (!sameDirectory(nextClaudeConfigDir, effectiveDir)) {
          throw new Error(`环境变量 CLAUDE_CONFIG_DIR 当前优先生效：${effectiveDir}。请先修改或清除该环境变量。`);
        }
      }
    }
    await fs.promises.mkdir(nextTraceRoot, { recursive: true });
    await fs.promises.mkdir(nextLogRoot, { recursive: true });
    if (hasClaudeConfigDir) await fs.promises.mkdir(nextClaudeConfigDir, { recursive: true });

    if (traceChanged) await this.shutdownUnlocked();
    this.settings = await this.settingsStore.update({
      ...(hasTraceRoot ? { traceRoot: nextTraceRoot } : {}),
      ...(hasLogRoot ? { logRoot: nextLogRoot } : {}),
      ...(hasClaudeConfigDir ? { claudeConfigDir: nextClaudeConfigDir } : {})
    });
    setLogDirectory(nextLogRoot);
    if (traceChanged) {
      this.createTraceRuntime(nextTraceRoot);
    }
    this.fireChange();
    return this.runtimeState({ fast: true });
  }

  async clearHistory(): Promise<void> {
    if (this.proxy.clearHistory) await this.proxy.clearHistory();
    else await this.traceStore.clearAll();
    this.traceOverviewCheckedAt = 0;
    this.traceStorageCheckedAt = 0;
    this.proxy.broadcastReset();
    this.fireChange();
  }

  async setTraceStoragePolicy(input: { limitGB?: unknown; autoCleanup?: unknown }): Promise<XwXDeckRuntimeState> {
    return this.serializeMutation(() => this.setTraceStoragePolicyUnlocked(input));
  }

  private async setTraceStoragePolicyUnlocked(input: { limitGB?: unknown; autoCleanup?: unknown }): Promise<XwXDeckRuntimeState> {
    if (input.limitGB === undefined && input.autoCleanup === undefined) throw new Error('没有需要修改的 Trace 存储设置。');
    if (input.limitGB !== undefined && (!Number.isSafeInteger(input.limitGB)
      || (input.limitGB as number) < 0 || (input.limitGB as number) > 1024)) {
      throw new Error('Trace 存储上限须为 0–1024 GB 的整数。');
    }
    if (input.autoCleanup !== undefined && typeof input.autoCleanup !== 'boolean') {
      throw new Error('无效的自动清理设置。');
    }
    const previous = this.settings ?? await this.settingsStore.read();
    const next = await this.settingsStore.update({
      ...(input.limitGB !== undefined ? { traceWarningGB: input.limitGB as number } : {}),
      ...(input.autoCleanup !== undefined ? { traceAutoCleanup: input.autoCleanup as boolean } : {})
    });
    this.settings = next;
    this.traceDetailsPurgePending = next.traceWarningGB === 0
      && (this.traceDetailsPurgePending || previous.traceWarningGB !== 0);
    this.traceStorageRevision += 1;
    this.traceStorageSyncPending = true;
    this.traceStorageNotice = '设置已保存，正在后台应用。';
    if (this.traceStorageSyncTimer) clearTimeout(this.traceStorageSyncTimer);
    this.traceStorageSyncTimer = undefined;
    this.scheduleTraceStorageSync();
    this.traceStorageCheckedAt = 0;
    this.fireChange();
    return this.runtimeState({ fast: true });
  }

  /** Saving a preference never waits for helper IPC, cleanup, or active requests. */
  private scheduleTraceStorageSync(delayMs = 0): void {
    if (!this.traceStorageSyncPending || this.traceStorageSyncTimer
      || this.traceStorageSyncOperation || this.shutdownRequested) return;
    this.traceStorageSyncTimer = setTimeout(() => {
      this.traceStorageSyncTimer = undefined;
      if (this.shutdownRequested) return;
      const revision = this.traceStorageRevision;
      this.traceStorageSyncOperation = this.applyTraceStoragePolicy().then(() => {
        if (revision !== this.traceStorageRevision) return;
        this.traceStorageSyncPending = false;
        this.traceDetailsPurgePending = false;
        this.traceStorageNotice = undefined;
      }).catch(error => {
        if (revision !== this.traceStorageRevision) return;
        this.traceStorageNotice = `设置已保存，将自动重试应用：${(error as Error).message}`;
      }).finally(() => {
        this.traceStorageSyncOperation = undefined;
        this.traceStorageCheckedAt = 0;
        this.fireChange();
        this.scheduleTraceStorageSync(revision === this.traceStorageRevision ? 5_000 : 0);
      });
    }, delayMs);
    this.traceStorageSyncTimer.unref?.();
  }

  private async applyTraceStoragePolicy(): Promise<void> {
    const settings = this.settings!;
    if (this.proxy.background) {
      if (!this.proxy.isListening()) throw new Error('Trace 启动后会应用此设置。');
      const mismatch = traceRetentionMismatch(await this.proxy.enforceTraceRetention?.(), settings);
      if (mismatch) throw new Error(mismatch);
    } else {
      if (this.traceDetailsPurgePending) {
        if (this.proxy.activeRequestCount() > 0) throw new Error('当前请求结束后会清理详细记录。');
        await this.traceStore.clearDetailedHistory();
        this.proxy.broadcastReset();
      }
      if (settings.traceAutoCleanup && settings.traceWarningGB > 0) await this.traceStore.cleanup();
    }
  }

  async repairTraceRetention(): Promise<TraceRetentionRepairResult> {
    const repaired = await this.settingsStore.ensureUnlimitedTraceRetention();
    this.settings = repaired.settings;
    const expectedStorageBytes = expectedTraceStorageBytes(repaired.settings);

    let helper: TraceRetentionRepairResult['helper'];
    if (this.proxy.background && this.proxy.isListening()) {
      try {
        const mismatch = traceRetentionMismatch(await this.proxy.enforceTraceRetention?.(), repaired.settings);
        helper = mismatch
          ? { state: 'unverified', reason: mismatch }
          : { state: 'verified', maxSessions: 0, maxStorageBytes: expectedStorageBytes };
      } catch (error) {
        helper = { state: 'unverified', reason: (error as Error).message };
      }
    } else if (this.proxy.background) {
      helper = { state: 'not-running' };
    } else {
      // The embedded proxy is constructed with fixed unlimited callbacks and
      // is used only by isolated smoke/development runtimes.
      helper = { state: 'verified', maxSessions: 0, maxStorageBytes: expectedStorageBytes };
    }

    log(
      `[xwx-deck] Trace retention repair verified settings=0/0 helper=${helper.state}`
      + ` legacyLimitsFound=${repaired.legacyLimitsFound}`
    );
    return {
      legacyLimitsFound: repaired.legacyLimitsFound,
      persistedSettingsChanged: repaired.persistedSettingsChanged,
      settings: { maxSessions: 0, maxStorageMB: 0 },
      helper
    };
  }

  /** 持久化夜间/白天主题;渲染进程通过状态下发得到权威值,不再依赖 file:// 源的 localStorage。 */
  async setTheme(theme: AppTheme): Promise<XwXDeckRuntimeState> {
    this.settings = await this.settingsStore.update({ theme });
    this.fireChange();
    return this.runtimeState({ fast: true });
  }

  async setTraceAppearance(input: Partial<TraceAppearanceSettings>): Promise<XwXDeckRuntimeState> {
    this.settings = await this.settingsStore.update({ traceAppearance: input });
    this.fireChange();
    return this.runtimeState({ fast: true });
  }

  async installTraceBackgroundImage(sourcePath: string): Promise<XwXDeckRuntimeState> {
    const extension = path.extname(sourcePath).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
      throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
    }
    const stat = await fs.promises.stat(sourcePath);
    if (!stat.isFile()) throw new Error('选择的背景不是有效文件。');
    if (stat.size > 20 * 1024 * 1024) throw new Error('背景图片不能超过 20 MB。');

    const directory = this.traceAppearanceDirectory();
    const fileName = `trace-background${extension}`;
    const destination = path.join(directory, fileName);
    await fs.promises.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.trace-background-${process.pid}-${Date.now()}${extension}`);
    await fs.promises.copyFile(sourcePath, temporary);
    await fs.promises.rm(destination, { force: true });
    await fs.promises.rename(temporary, destination).catch(async error => {
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    });
    await this.removeOtherTraceBackgroundFiles(fileName);
    return this.setTraceAppearance({ skin: 'custom', customImageFile: fileName });
  }

  async clearTraceBackgroundImage(): Promise<XwXDeckRuntimeState> {
    await this.removeOtherTraceBackgroundFiles();
    return this.setTraceAppearance({ skin: 'classic', customImageFile: '' });
  }

  traceAppearanceDirectory(): string {
    return path.join(this.userDataDir, 'appearance');
  }

  /** 读取用户的开机启动意图;便携版启动时据此用当前 exe 路径重新对齐登录项。 */
  async readStartupIntent(): Promise<boolean> {
    const settings = this.settings ?? await this.settingsStore.read();
    const problem = this.settingsStore.readProblem();
    if (problem) throw new Error(problem.message);
    return settings.startupEnabled;
  }

  /** 持久化开机启动意图。实际写入 Windows 登录项由主进程完成。 */
  async setStartupIntent(enabled: boolean): Promise<void> {
    this.settings = await this.settingsStore.update({ startupEnabled: enabled });
  }

  /**
   * 首页统计：Token/费用（总计、今日、本周）+ 近期吞吐序列。
   * 所有值都来自 appendTrace 时写入 index.json 的增量摘要。管理页在追踪时会
   * 每 3 秒轮询这里，因此绝不能为了统计重读可能达到数百 MB 的会话 JSONL。
   */
  async traceStats(): Promise<ManagerTraceStats> {
    const sessions = await this.traceStore.listSessions();
    const usageOnly = await this.traceStore.usageOnlySummary();
    let totalTokens = 0;
    let totalCost = 0;
    let totalCostComplete = true;
    const now = Date.now();
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const weekStart = now - 7 * 24 * 3600 * 1000;
    const todayKey = localDateKey(dayStart);
    const weekKey = localDateKey(new Date(weekStart));

    let todayTokens = 0;
    let todayCost = 0;
    let todayCostComplete = true;
    let weekTokens = 0;
    let weekCost = 0;
    let weekCostComplete = true;
    const points: Array<{ at: number; tokens: number; tokPerSec?: number }> = [];

    for (const session of [
      ...sessions,
      ...(usageOnly ? [{
        startedAt: new Date(0).toISOString(),
        totalTokens: usageOnly.totalTokens,
        usageByModel: usageOnly.usageByModel,
        dailyUsage: usageOnly.dailyUsage,
        dailyUsageComplete: true,
        recentRatePoints: usageOnly.recentRatePoints
      }] : [])
    ]) {
      totalTokens += session.totalTokens || 0;
      const totalSessionCost = costOfUsageByModel(session.usageByModel);
      totalCost += totalSessionCost.cost;
      totalCostComplete &&= totalSessionCost.complete;

      const daily = session.dailyUsage;
      if (session.dailyUsageComplete === true && daily && Object.keys(daily).length > 0) {
        for (const [day, usage] of Object.entries(daily)) {
          if (day >= weekKey) {
            weekTokens += usage.tokens || 0;
            const cost = costOfUsageByModel(usage.usageByModel);
            weekCost += cost.cost;
            weekCostComplete &&= cost.complete;
          }
          if (day === todayKey) {
            todayTokens += usage.tokens || 0;
            const cost = costOfUsageByModel(usage.usageByModel);
            todayCost += cost.cost;
            todayCostComplete &&= cost.complete;
          }
        }
      } else {
        // Backward-compatible fallback for old index entries. A legacy session
        // wholly inside the period can use its exact cumulative summary without
        // opening the historical JSONL. Long-running cross-boundary sessions
        // begin receiving exact daily buckets with their next trace.
        const startedAt = Date.parse(session.startedAt || '');
        if (Number.isFinite(startedAt) && startedAt >= weekStart) {
          weekTokens += session.totalTokens || 0;
          const cost = costOfUsageByModel(session.usageByModel);
          weekCost += cost.cost;
          weekCostComplete &&= cost.complete;
        } else if (daily) {
          for (const [day, usage] of Object.entries(daily)) {
            if (day < weekKey) continue;
            weekTokens += usage.tokens || 0;
            const cost = costOfUsageByModel(usage.usageByModel);
            weekCost += cost.cost;
            weekCostComplete &&= cost.complete;
          }
        }
        if (Number.isFinite(startedAt) && startedAt >= dayStart.getTime()) {
          todayTokens += session.totalTokens || 0;
          const cost = costOfUsageByModel(session.usageByModel);
          todayCost += cost.cost;
          todayCostComplete &&= cost.complete;
        } else if (daily?.[todayKey]) {
          // A legacy long-running session begins recording exact daily buckets
          // after the upgrade, even though older days remain summary-only.
          todayTokens += daily[todayKey].tokens || 0;
          const cost = costOfUsageByModel(daily[todayKey].usageByModel);
          todayCost += cost.cost;
          todayCostComplete &&= cost.complete;
        }
      }

      for (const point of session.recentRatePoints || []) {
        const at = Date.parse(point.at);
        if (!Number.isFinite(at) || at < weekStart || at > now + 1000) continue;
        points.push({ at, tokens: point.tokens, tokPerSec: point.tokPerSec });
      }
    }
    points.sort((a, b) => a.at - b.at);
    const series = points.slice(-240).map(p => ({
      at: new Date(p.at).toISOString(),
      tokens: p.tokens,
      tokPerSec: p.tokPerSec === undefined ? undefined : Math.round(p.tokPerSec * 10) / 10
    }));

    return {
      total: { tokens: totalTokens, costUsd: round2(totalCost), costComplete: totalCostComplete },
      today: { tokens: todayTokens, costUsd: round2(todayCost), costComplete: todayCostComplete },
      week: { tokens: weekTokens, costUsd: round2(weekCost), costComplete: weekCostComplete },
      series
    };
  }

  async runtimeState(options: { fast?: boolean } = {}): Promise<XwXDeckRuntimeState> {
    // UI updates are not shutdown checks. Do not query the helper or scan all
    // possible external ports before returning an unrelated configuration save.
    if (!options.fast) await this.refreshBackgroundCaptureState();
    else {
      this.checkBackgroundCaptureInBackground();
      this.checkExternalTracePortInBackground();
      this.checkTraceOverviewInBackground();
    }
    const [overview, external, readiness, backgroundGatewayAction] = await Promise.all([
      options.fast ? Promise.resolve(this.traceOverview) : this.readTraceOverview(),
      options.fast ? Promise.resolve(this.externalTracePort) : this.findExternalTracePort().catch(() => undefined),
      this.traceRuntimeReadiness(),
      this.backgroundGatewayAction(options.fast)
    ]);
    if (!options.fast) {
      this.traceOverview = overview;
      this.traceOverviewCheckedAt = Date.now();
      this.traceStorageCheckedAt = Date.now();
      this.externalTracePort = external;
      this.externalTracePortCheckedAt = Date.now();
    }
    const clientPaths = resolveClientPaths(process.env, undefined, {
      claudeConfigDir: this.settings?.claudeConfigDir
    });
    return {
      tracingEnabled: this.active,
      connectionNotice: this.desktopSyncError
        ? { message: 'Claude Desktop 同步未完成', description: `${this.desktopSyncError}。Trace 状态不受影响；可稍后在模型配置中重试同步。`, type: 'info' }
        : !this.active && this.claudeDesktopRequiresTrace && this.settings?.claudeDesktop.syncEnabled
        ? { message: 'Claude Desktop 需要开启 Trace', description: '当前服务的模型需要 XwX Deck 转换名称，关闭 Trace 时 Desktop 已恢复原来的连接。', type: 'info', action: 'start-trace', secondaryAction: 'models' }
        : !this.active && this.settings?.codexPreferredMode === 'compatible'
        && providerRequiresTrace(selectedProvider(this.settings, 'codex') ?? this.settings.compatible, this.settings.codexModels.compatible, this.compatibleServiceCatalog)
        ? { message: '所选模型需要开启 Trace', description: '服务和模型选择已保存。调用此模型需要开启 Trace 进行协议转换。', type: 'info', action: 'start-trace', secondaryAction: 'models' }
        : undefined,
      traceTransition: this.traceTransition,
      readiness,
      role: this.role,
      localBaseUrl: this.localBaseUrl(),
      dashboardUrl: this.dashboardUrl(),
      backgroundGatewayActive: this.backgroundGatewayActive(),
      backgroundGatewayAction,
      chatGptRestartRecommended: this.chatGptRestartRecommended,
      ...(this.claudeDesktopRestart ? { claudeDesktopRestart: this.claudeDesktopRestart } : {}),
      missingCodexHistoryProviders: this.missingCodexHistoryProviders,
      traceRoot: this.traceStore.rootPath(),
      logRoot: this.logRootPath(),
      claudeConfigDir: path.dirname(clientPaths.claudeSettingsPath),
      claudeConfigPath: clientPaths.claudeSettingsPath,
      externalTracePort: external,
      sessions: overview.sessions,
      traces: overview.traces,
      storageText: overview.storageText,
      traceStorageBytes: overview.traceStorageBytes,
      traceWarningGB: this.settings?.traceWarningGB ?? 2,
      traceAutoCleanup: this.settings?.traceAutoCleanup ?? false,
      traceStorageNotice: this.traceStorageNotice,
      clients: this.clientRows(readiness),
      theme: this.settings?.theme ?? 'day',
      traceAppearance: {
        ...(this.settings?.traceAppearance ?? {
          skin: 'classic' as const,
          showThroughput: true,
          customImageFile: '',
          customImageFit: 'cover' as const,
          customImageOverlay: 42
        }),
        customImageUrl: this.customTraceBackgroundUrl()
      },
      lastError: this.lastError
    };
  }

  private checkBackgroundCaptureInBackground(): void {
    if (this.role !== 'owner' || !this.proxy.background || !this.proxy.isListening()
      || this.backgroundCaptureCheck || Date.now() - this.backgroundCaptureCheckedAt < 5_000) return;
    this.backgroundCaptureCheckedAt = Date.now();
    const proxy = this.proxy;
    const previousError = this.lastError;
    const previousListening = this.proxy.isListening();
    const previousClients = [...this.clientsSeenSinceEnable].join(',');
    this.backgroundCaptureCheck = this.refreshBackgroundCaptureState()
      .then(() => {
        if (proxy !== this.proxy) return;
        if (previousError !== this.lastError || previousListening !== this.proxy.isListening()
          || previousClients !== [...this.clientsSeenSinceEnable].join(',')) this.fireChange();
      })
      .catch(error => log.warn(`[xwx-deck] background capture refresh skipped: ${(error as Error).message}`))
      .finally(() => {
        if (proxy === this.proxy) this.backgroundCaptureCheck = undefined;
      });
  }

  private async readTraceOverview(): Promise<typeof this.traceOverview> {
    const store = this.traceStore;
    const [counts, storage] = await Promise.all([
      store.summaryCounts(),
      store.storageStats()
    ]);
    return {
      ...counts,
      traceStorageBytes: storage.totalBytes,
      storageText: storage.maxBytes
        ? `${formatBytes(storage.totalBytes)} / ${formatBytes(storage.maxBytes)}`
        : formatBytes(storage.totalBytes)
    };
  }

  private checkTraceOverviewInBackground(): void {
    const generation = this.traceOverviewGeneration;
    const store = this.traceStore;
    if (!this.traceOverviewCheck && Date.now() - this.traceOverviewCheckedAt >= 2_000) {
      this.traceOverviewCheckedAt = Date.now();
      this.traceOverviewCheck = store.summaryCounts()
        .then(counts => {
          if (generation !== this.traceOverviewGeneration
            || (counts.sessions === this.traceOverview.sessions
              && counts.traces === this.traceOverview.traces)) return;
          this.traceOverview = { ...this.traceOverview, ...counts };
          this.fireChange();
        })
        .catch(error => log.warn(`[xwx-deck] Trace counts refresh skipped: ${(error as Error).message}`))
        .finally(() => {
          if (generation === this.traceOverviewGeneration) this.traceOverviewCheck = undefined;
        });
    }
    if (!this.traceStorageCheck && Date.now() - this.traceStorageCheckedAt >= 30_000) {
      this.traceStorageCheckedAt = Date.now();
      this.traceStorageCheck = store.storageStats()
        .then(storage => {
          if (generation !== this.traceOverviewGeneration) return;
          const storageText = storage.maxBytes
            ? `${formatBytes(storage.totalBytes)} / ${formatBytes(storage.maxBytes)}`
            : formatBytes(storage.totalBytes);
          if (storageText === this.traceOverview.storageText
            && storage.totalBytes === this.traceOverview.traceStorageBytes) return;
          this.traceOverview = { ...this.traceOverview, storageText, traceStorageBytes: storage.totalBytes };
          this.fireChange();
        })
        .catch(error => log.warn(`[xwx-deck] Trace storage refresh skipped: ${(error as Error).message}`))
        .finally(() => {
          if (generation === this.traceOverviewGeneration) this.traceStorageCheck = undefined;
        });
    }
  }

  private checkExternalTracePortInBackground(): void {
    if (this.externalTracePortCheck || Date.now() - this.externalTracePortCheckedAt < 30_000) return;
    this.externalTracePortCheckedAt = Date.now();
    this.externalTracePortCheck = this.findExternalTracePort()
      .then(port => {
        if (port === this.externalTracePort) return;
        this.externalTracePort = port;
        this.fireChange();
      })
      .catch(() => undefined)
      .finally(() => { this.externalTracePortCheck = undefined; });
  }

  private customTraceBackgroundUrl(): string | undefined {
    const fileName = this.settings?.traceAppearance.customImageFile;
    if (!fileName) return undefined;
    const filePath = path.join(this.traceAppearanceDirectory(), fileName);
    if (!fs.existsSync(filePath)) return undefined;
    const url = pathToFileURL(filePath);
    try { url.searchParams.set('v', String(fs.statSync(filePath).mtimeMs)); } catch { /* file can still load */ }
    return url.href;
  }

  private async removeOtherTraceBackgroundFiles(keepFileName?: string): Promise<void> {
    const directory = this.traceAppearanceDirectory();
    const names = ['trace-background.png', 'trace-background.jpg', 'trace-background.jpeg', 'trace-background.webp'];
    await Promise.all(names
      .filter(name => name !== keepFileName)
      .map(name => fs.promises.rm(path.join(directory, name), { force: true }).catch(() => undefined)));
  }

  dashboardUrl(): string | undefined {
    const base = this.localBaseUrl();
    return base ? `${base}/` : undefined;
  }

  localBaseUrl(): string | undefined {
    if (this.role === 'owner') return this.proxy.localBaseUrl();
    if (this.role === 'follower' && this.followerPort) return `http://127.0.0.1:${this.followerPort}`;
    return undefined;
  }

  async startProxy(reason: string): Promise<void> {
    return this.serializeMutation(() => this.startProxyUnlocked(reason));
  }

  private async startProxyUnlocked(reason: string): Promise<void> {
    // IPC/second-instance activation can open the Dashboard while controller
    // startup is still queued. Resolve the persisted Trace root before that
    // early request starts a helper; otherwise start() would replace this
    // proxy object with one for the configured root and leave the first helper
    // alive without a controller or valid control token.
    if (!this.settings) {
      this.settings = await this.settingsStore.read();
      const configuredTraceRoot = resolveRuntimeDirectory(
        this.settings.traceRoot,
        path.join(this.userDataDir, 'xwx-trace')
      );
      if (!sameDirectory(configuredTraceRoot, this.traceStore.rootPath())) {
        this.createTraceRuntime(configuredTraceRoot);
      }
      setLogDirectory(this.logRootPath());
      this.proxy.setRecordingEnabled(this.settings.tracingEnabled);
    }
    if (this.localBaseUrl()) return;
    const lockDir = this.traceStore.rootPath();
    if (this.proxy.background) {
      const baseUrl = await this.proxy.start();
      this.role = 'owner';
      this.followerPort = undefined;
      this.startLockWatcher(lockDir);
      log(`[xwx-deck] attached background Gateway at ${baseUrl} (${reason})`);
      return;
    }
    const decision = await decideRoleOnEnable(lockDir);
    if (decision.role === 'follower' && decision.port !== undefined) {
      this.role = 'follower';
      this.followerPort = decision.port;
      this.startLockWatcher(lockDir);
      log(`[xwx-deck] proxy follower on :${decision.port} (${reason})`);
      return;
    }
    const baseUrl = await this.proxy.start();
    const port = parsePort(baseUrl);
    if (port !== undefined) {
      let won = (await tryWriteLockExclusive(lockDir, port)) !== undefined;
      if (!won) {
        const other = await readLock(lockDir);
        if (other && other.port !== port && await probeTapPort(other.port)) {
          await this.proxy.stop();
          this.role = 'follower';
          this.followerPort = other.port;
          this.startLockWatcher(lockDir);
          return;
        }
        await deleteLock(lockDir);
        won = (await tryWriteLockExclusive(lockDir, port)) !== undefined;
        if (!won) await writeLock(lockDir, port);
      }
    }
    this.role = 'owner';
    this.startLockWatcher(lockDir);
    log(`[xwx-deck] proxy owner at ${baseUrl} (${reason})`);
  }

  private async snapshotState(opts?: { sessionId?: string; includeTraces?: boolean }): Promise<TapViewerState> {
    const sessionId = opts?.sessionId;
    const includeTraces = opts?.includeTraces !== false;
    const sessions = await this.traceStore.listSessions();
    const currentSessionId = sessionId
      ?? this.traceStore.currentSessionIdValue()
      ?? sessions[0]?.id;
    const traces = includeTraces && currentSessionId
      ? await this.traceStore.readSession(currentSessionId)
      : [];
    const storage = await this.traceStore.storageStats();
    return {
      active: this.active,
      localBaseUrl: this.localBaseUrl(),
      rootPath: this.traceStore.rootPath(),
      storage,
      generatedAt: new Date().toISOString(),
      pricingModelIds: this.compatibleServiceCatalog.map(model => model.id),
      sessions,
      traces,
      currentSessionId
    };
  }

  private async snapshotSessionTraces(
    sessionId: string,
    page?: { offset?: number; limit?: number }
  ): Promise<TapSessionTracePage | undefined> {
    const sessions = await this.traceStore.listSessions();
    if (!sessions.some(s => s.id === sessionId)) return undefined;
    return this.traceStore.readConversationPage(sessionId, page);
  }

  private async findExternalTracePort(ignoredPort?: number): Promise<number | undefined> {
    if (process.env.XWX_DECK_SMOKE_IGNORE_EXTERNAL === '1') return undefined;
    const own = parsePort(this.localBaseUrl());
    for (const port of tapPortCandidates()) {
      if (port === own || port === ignoredPort) continue;
      if (await probeTapPort(port).catch(() => false)) return port;
    }
    return undefined;
  }

  /**
   * Let a pre-existing XwX Deck-managed local connection yield to Trace. A
   * healthy XwX proxy is restored after Trace stops; a dead self-residue is
   * repaired to the direct official connection and is intentionally not put
   * back. Live non-XwX local proxies remain untouched.
   */
  private async prepareChatGptConnection(): Promise<number | undefined> {
    this.chatGptConnectionIssue = undefined;
    try {
      const snapshot = await this.codexConfig.read();
      const localPort = parsePort(snapshot.activeBaseUrl);
      let restoreOriginal = false;
      let ignoredExternalPort: number | undefined;

      if (isLoopbackUrl(snapshot.activeBaseUrl)) {
        if (localPort === undefined) {
          this.chatGptConnectionIssue = 'unsupported';
          return undefined;
        }
        const ownPort = parsePort(this.localBaseUrl());
        if (localPort === ownPort && this.isCodexTraceManaged()) {
          // Manager reattachment starts the helper before rebuilding `active`.
          // The persisted Trace intent plus matching backup means this is our
          // healthy overlay, not a pre-existing local proxy that must be
          // suspended to api.openai.com. Rewriting it here would make
          // applyOrResume keep a byte-stable backup while ChatGPT silently
          // bypasses Trace.
          return ownPort;
        }
        if (localPort !== ownPort) {
          const xwxDeckAlive = await probeTapPort(localPort).catch(() => false);
          if (xwxDeckAlive) {
            restoreOriginal = true;
            ignoredExternalPort = localPort;
          } else if (await probeLocalTcpPort(localPort).catch(() => false)) {
            this.chatGptConnectionIssue = 'unsupported';
            return undefined;
          }
        }
      }

      const result = await this.codexLocalProxy.prepare(snapshot, restoreOriginal);
      if (result.status === 'unsupported') {
        this.chatGptConnectionIssue = 'unsupported';
        return undefined;
      }
      if (result.status === 'resumed') {
        const originalPort = parsePort(result.localBaseUrl);
        if (originalPort !== undefined && await probeTapPort(originalPort).catch(() => false)) {
          return originalPort;
        }
        // The original XwX Deck disappeared while this app was down. Keep the
        // repaired direct connection instead of restoring a dead local port.
        await this.codexLocalProxy.discard();
      }
      return ignoredExternalPort;
    } catch (error) {
      this.chatGptConnectionIssue = 'failed';
      log.warn(`[xwx-deck] ChatGPT connection adjustment failed: ${(error as Error).message}`);
      return undefined;
    }
  }

  private startLockWatcher(rootDir: string): void {
    this.stopLockWatcher();
    try {
      fs.mkdirSync(rootDir, { recursive: true });
      this.lockWatcher = fs.watch(rootDir, (_event, filename) => {
        void this.handleLockChange(rootDir, filename?.toString()).catch(error => {
          // Async EventEmitter callbacks do not observe rejected promises. Letting
          // one escape here terminates Electron's main process on current Node.
          log.warn(`[xwx-deck] lock watcher update failed: ${(error as Error).message}`);
        });
      });
    } catch (err) {
      log.warn(`[xwx-deck] lock watcher failed: ${(err as Error).message}`);
    }
  }

  private stopLockWatcher(): void {
    try { this.lockWatcher?.close(); } catch { /* ignore */ }
    this.lockWatcher = undefined;
  }

  private setStartupPhase(phase: StartupPhase): void {
    this.startupPhase = phase;
    this.options.onStartupPhase?.(phase);
  }

  private async assertPreparedClientRoutes(takeovers: readonly ClientTakeoverResult[]): Promise<void> {
    const localBaseUrl = this.proxy.localBaseUrl();
    if (this.role !== 'owner' || !this.proxy.isListening() || !localBaseUrl) {
      throw new Error('Trace 本地代理尚未开始监听，已取消客户端配置接管。');
    }
    for (const takeover of takeovers) {
      if (takeover.status !== 'taken') continue;
      const path = takeover.client === 'claude-cli'
        ? '/v1/messages'
        : takeover.codexRouteKind === 'chatgpt-oauth'
          ? '/backend-api/codex/responses'
          : '/v1/responses';
      if (!this.proxy.hasClientRoute(takeover.client, path)) {
        throw new Error(`${takeover.client === 'claude-cli' ? 'Claude' : 'ChatGPT'} 路由尚未准备完成，已取消配置接管。`);
      }
    }
    await this.proxy.synchronize?.();
  }

  private async assertCodexGatewayRoute(): Promise<void> {
    const localBaseUrl = this.proxy.localBaseUrl();
    if (this.role !== 'owner' || !this.proxy.isListening() || !localBaseUrl) {
      throw new Error('XwX Model Gateway 尚未开始监听，已保留原 ChatGPT 配置。');
    }
    const requiredPaths = this.codexGatewayMode === 'official'
      ? ['/backend-api/codex/responses']
      : ['/v1/responses', '/v1/responses/compact'];
    if (requiredPaths.some(routePath => !this.proxy.hasClientRoute('codex-cli', routePath))) {
      throw new Error('XwX Model Gateway 路由尚未准备完成，已保留原 ChatGPT 配置。');
    }
    await this.proxy.synchronize?.();
  }

  private scheduleCompatibleServiceModelRefresh(reason: string): void {
    if (this.options.disableBackgroundModelRefresh) return;
    const settings = this.settings;
    if (!settings?.compatible.baseUrl || !settings.compatible.bearerToken) return;
    // Background work is allowed to wait for models.dev/LiteLLM. The
    // foreground model picker remains cache-first, but a clean installation
    // must eventually replace conservative fallback capabilities and
    // republish the Codex catalog without requiring a restart or manual
    // refresh.
    void this.refreshModelMetadata().then(count => {
      log(`[xwx-deck] CompatibleService model directory refreshed in background (${reason}, ${count} models).`);
    }).catch(error => {
      log.warn(`[xwx-deck] CompatibleService background model refresh skipped (${reason}): ${(error as Error).message}`);
    });
  }

  /**
   * CompatibleService discovery is also the refresh trigger for Codex's startup-only
   * catalog. The old guard used `codexGatewayEnabled`, which is only true
   * during the config publication transaction; normal model-page refreshes
   * therefore updated XwX's in-memory/cache directory but left Codex's JSON
   * catalog stale.
   */
  private async syncCodexCatalogIfCompatibleServiceActive(
    catalog: readonly ModelCatalogEntry[]
  ): Promise<void> {
    const provider = selectedProvider(this.settings!, 'codex');
    const config = await this.codexConfig.read();
    if (config.mode !== 'compatible' || catalog !== this.compatibleServiceCatalog || !catalog.length) return;
    const result = await this.codexCatalog.syncIfXwXOwned(catalog, provider?.adapter === 'auto');
    if (!result) {
      log('[xwx-deck] Skipped Codex catalog refresh because model_catalog_json is user-owned.');
      return;
    }
    const pointerPublished = provider
      ? await this.codexConfig.publishModelCatalogPath(providerCodexId(provider, this.settings?.codexEnhancements.unifySessionHistory), result.path)
      : false;
    if (result.changed || pointerPublished) {
      await this.refreshProxyRoutes();
      log(`[xwx-deck] Codex CompatibleService model catalog synchronized: ${result.path}`);
    }
  }

  private async traceRuntimeReadiness(): Promise<TraceRuntimeReadiness> {
    const localBaseUrl = this.localBaseUrl();
    const proxyListening = this.role === 'owner'
      ? this.proxy.isListening()
      : this.role === 'follower' && this.followerPort !== undefined
        ? await probeTapPort(this.followerPort).catch(() => false)
        : false;
    const claudeTakeover = this.clientTakeovers.find(item => item.client === 'claude-cli' && item.status === 'taken');
    const codexTakeover = this.clientTakeovers.find(item => item.client === 'codex-cli' && item.status === 'taken');
    const claudeRouteReady = this.role === 'owner'
      && proxyListening
      && !!claudeTakeover
      && this.proxy.hasClientRoute('claude-cli', '/v1/messages');
    const codexRoutePath = this.codexGatewayEnabled
      ? this.codexGatewayMode === 'official'
        ? '/backend-api/codex/responses'
        : '/v1/responses'
      : codexTakeover?.codexRouteKind === 'chatgpt-oauth'
        ? '/backend-api/codex/responses'
        : '/v1/responses';
    const codexRouteReady = this.role === 'owner'
      && proxyListening
      && (this.codexGatewayEnabled || !!codexTakeover)
      && this.proxy.hasClientRoute('codex-cli', codexRoutePath);

    let claudeConfigReady = false;
    let codexConfigReady = false;
    if (localBaseUrl) {
      const clientPaths = resolveClientPaths(process.env, undefined, {
        claudeConfigDir: this.settings?.claudeConfigDir
      });
      const claude = detectClaudeUpstream(clientPaths, process.env);
      const claudeBaseUrl = 'reason' in claude ? claude.upstreamBaseUrl : claude.baseUrl;
      const codex = await this.codexConfig.read().catch(() => undefined);
      claudeConfigReady = !!claudeTakeover
        && sameHttpEndpoint(claudeBaseUrl, localBaseUrl);
      const normalizedLocalBaseUrl = localBaseUrl.replace(/\/+$/, '');
      const expectedCodexBaseUrl = this.codexGatewayEnabled
        || codexTakeover?.codexRouteKind === 'chatgpt-oauth'
        ? `${normalizedLocalBaseUrl}/backend-api/codex`
        : codexTakeover ? `${normalizedLocalBaseUrl}/v1` : undefined;
      codexConfigReady = sameHttpEndpoint(codex?.activeBaseUrl, expectedCodexBaseUrl)
        || (
          this.codexGatewayEnabled
          && this.codexGatewayMode === 'official'
          && sameHttpEndpoint(codex?.activeBaseUrl, `${normalizedLocalBaseUrl}/v1`)
        );
    }

    return {
      startupPhase: this.startupPhase,
      proxyListening,
      recordingEnabled: this.role === 'owner' ? this.proxy.isRecordingEnabled() : this.active,
      claudeConfigReady,
      claudeRouteReady,
      codexConfigReady,
      codexRouteReady,
      codexGatewayEnabled: this.codexGatewayEnabled
    };
  }

  private async refreshBackgroundCaptureState(): Promise<void> {
    if (this.role !== 'owner' || !this.proxy.background || !this.proxy.isListening()) return;
    const proxy = this.proxy;
    try {
      await proxy.refreshShutdownActivity();
    } catch {
      if (proxy !== this.proxy) return;
      // Keep the last confirmed state. GatewayProcessClient preserves the live
      // data plane and logs one warning for the uncertain control episode.
      this.lastError ??= '后台控制通道不可用，暂时无法确认连接状态。请稍后重试；若对话连接失败，请查看运行日志并重新打开 Deck。';
      return;
    }
    if (proxy !== this.proxy) return;
    if (this.lastError?.startsWith('后台控制通道不可用')) this.lastError = undefined;
    if (this.active && !this.proxy.isListening()) {
      this.active = false;
      this.lastError = '本地转发服务已停止，客户端可能仍在使用旧的本地连接。请重新开启 Trace，或恢复直连配置后重新打开客户端。';
      return;
    }
    if (!this.active) return;
    for (const client of this.proxy.capturedClientIds()) {
      this.clientsSeenSinceEnable.add(client);
    }
  }

  private clientRows(readiness?: TraceRuntimeReadiness): ClientStateRow[] {
    const settings = this.settings;
    const rows: Array<{ id: ClientId; label: string; enabled: boolean }> = [
      { id: 'claude-cli', label: 'Claude', enabled: settings?.clientEnabled.claude !== false },
      { id: 'codex-cli', label: 'ChatGPT', enabled: settings?.clientEnabled.codex !== false }
    ];
    return rows.map(row => {
      if (!row.enabled) {
        return { ...row, status: 'off' as const, statusText: '关闭', detail: '客户端接管已关闭' };
      }
      const takeover = this.clientTakeovers.find(t => t.client === row.id);
      if (!this.active) {
        return { ...row, status: 'idle' as const, statusText: '待命', detail: '追踪未开启' };
      }
      if (row.id === 'codex-cli' && this.codexGatewayEnabled) {
        if (!readiness?.codexRouteReady || !readiness.codexConfigReady) {
          return {
            ...row,
            status: 'skipped' as const,
            statusText: '未接入',
            detail: !readiness?.codexRouteReady
              ? 'XwX Model Gateway 路由未就绪'
              : 'ChatGPT 配置未指向当前 XwX 代理端口'
          };
        }
        const captured = this.clientsSeenSinceEnable.has(row.id);
        return {
          ...row,
          status: 'taken' as const,
          statusText: captured ? '追踪中' : '等待请求',
          detail: captured
            ? hostOf(this.settings?.compatible.baseUrl || '') || 'XwX Model Gateway'
            : `${row.label} 配置已接管；若客户端已在运行，请重启客户端后发送请求`
        };
      }
      if (row.id === 'codex-cli' && this.chatGptConnectionIssue) {
        return {
          ...row,
          status: 'skipped' as const,
          statusText: '未接入',
          detail: chatGptConnectionIssueText(this.chatGptConnectionIssue)
        };
      }
      if (!takeover) {
        return { ...row, status: 'skipped' as const, statusText: '未检测', detail: '尚未接管' };
      }
      if (takeover.status === 'taken') {
        const routeReady = row.id === 'claude-cli'
          ? readiness?.claudeRouteReady
          : readiness?.codexRouteReady;
        const configReady = row.id === 'claude-cli'
          ? readiness?.claudeConfigReady
          : readiness?.codexConfigReady;
        if (!routeReady || !configReady) {
          return {
            ...row,
            status: 'skipped' as const,
            statusText: '未接入',
            detail: !routeReady
              ? '本地代理路由未就绪'
              : `${row.label} 配置未指向当前 XwX 代理端口`
          };
        }
        const captured = this.clientsSeenSinceEnable.has(row.id);
        return {
          ...row,
          status: 'taken' as const,
          statusText: captured ? '追踪中' : '等待请求',
          detail: captured
            ? takeover.upstreamBaseUrl ? hostOf(takeover.upstreamBaseUrl) : '代理已启用'
            : `${row.label} 配置已接管；若客户端已在运行，请重启客户端后发送请求`
        };
      }
      return {
        ...row,
        status: 'skipped' as const,
        statusText: '已跳过',
        detail: takeoverSkipReason(takeover.skipReason)
      };
    });
  }

  private async ensureCodexEnhancementConfig(): Promise<void> {
    await this.ensureCodexHistoryPrerequisites(false);
  }

  private async ensureCodexHistoryPrerequisites(force: boolean): Promise<void> {
    if (!force && !this.settings?.codexEnhancements.unifySessionHistory) return;
    await this.codexOfficialAuth.restoreOfficialLogin();
  }

  private async handleLockChange(rootDir: string, filename?: string): Promise<void> {
    if (filename && filename !== 'tap.lock') return;
    if (!this.active) return;
    return this.serializeMutation(() => this.handleLockChangeUnlocked(rootDir, filename));
  }

  private async handleLockChangeUnlocked(rootDir: string, filename?: string): Promise<void> {
    if (filename && filename !== 'tap.lock') return;
    if (!this.active) return;
    const lock = await readLock(rootDir);
    if (this.role === 'follower' && !lock) {
      this.role = undefined;
      this.followerPort = undefined;
      await this.startProxyUnlocked('lock-removed');
      if (this.active) await this.enableUnlocked('lock-removed-restore-recording');
    } else if (this.role === 'owner') {
      const myPort = parsePort(this.proxy.localBaseUrl());
      if (myPort !== undefined && (!lock || lock.port !== myPort)) {
        await writeLock(rootDir, myPort);
      }
    }
  }

  private scheduleCodexHistoryWork(reason: string, delayMs = 6_000): void {
    const enhancements = this.settings?.codexEnhancements;
    if (this.codexHistoryTimer) clearTimeout(this.codexHistoryTimer);
    // History alignment is optional and can touch gigabytes of Codex rollout
    // data. Let the window become interactive before starting background IO.
    this.codexHistoryTimer = setTimeout(async () => {
      this.codexHistoryTimer = undefined;
      if (this.settings?.codexEnhancements.pendingHistoryRestore) {
        await this.restorePendingCodexHistory(reason);
      } else if (enhancements?.unifySessionHistory) {
        await this.mergeCodexHistoryBestEffort(reason);
      }
    }, delayMs);
    this.codexHistoryTimer.unref?.();
  }

  private scheduleCodexHistoryProviderAudit(reason: string, delayMs = 0): void {
    if (this.codexHistoryProviderAuditTimer) clearTimeout(this.codexHistoryProviderAuditTimer);
    const generation = ++this.codexHistoryProviderAuditGeneration;
    this.codexHistoryProviderAuditTimer = setTimeout(() => {
      this.codexHistoryProviderAuditTimer = undefined;
      void this.auditMissingCodexHistoryProviders(reason, generation);
    }, delayMs);
    this.codexHistoryProviderAuditTimer.unref?.();
  }

  private async auditMissingCodexHistoryProviders(reason: string, generation: number): Promise<void> {
    try {
      const history = await this.codexHistory.auditReferencedProviders();
      const config = await this.codexConfig.read();
      if (generation !== this.codexHistoryProviderAuditGeneration || this.shutdownRequested) return;
      const missing = missingManagedCodexHistoryProviders(history.providers, config.configuredProviders);
      if (sameStrings(missing, this.missingCodexHistoryProviders)) return;
      this.missingCodexHistoryProviders = missing;
      if (missing.length) {
        log.warn(`[xwx-deck] ChatGPT history references missing provider section(s): ${missing.join(', ')} (${reason}; scan ${history.complete ? 'complete' : 'incomplete'})`);
      } else {
        log(`[xwx-deck] ChatGPT history provider configuration audit passed (${reason}; scan ${history.complete ? 'complete' : 'incomplete'})`);
      }
      this.fireChange();
    } catch (error) {
      // This is guidance only. An unreadable or live-locked history source must
      // never delay startup or replace a more actionable configuration error.
      log.warn(`[xwx-deck] ChatGPT history provider audit skipped (${reason}): ${(error as Error).message}`);
    }
  }

  private deferCodexHistoryWork(operation: string, reason: string, retryReason: string): void {
    if (this.codexHistoryDeferredOperation !== operation) {
      this.codexHistoryDeferredOperation = operation;
      this.codexHistoryDeferredAttempts = 0;
      log(`[xwx-deck] deferred ${operation} while ChatGPT is running (${reason})`);
    }
    const delayMs = codexHistoryRetryDelayMs(this.codexHistoryDeferredAttempts);
    this.codexHistoryDeferredAttempts += 1;
    this.scheduleCodexHistoryWork(retryReason, delayMs);
  }

  private clearCodexHistoryDeferral(operation: string): void {
    if (this.codexHistoryDeferredOperation !== operation) return;
    this.codexHistoryDeferredOperation = undefined;
    this.codexHistoryDeferredAttempts = 0;
  }

  private async mergeCodexHistoryBestEffort(reason: string): Promise<CodexHistoryMigrationOutcome | undefined> {
    try {
      const outcome = await this.mergeCodexHistory();
      const skipped = outcome.skippedLockedJsonlFiles + outcome.skippedLockedStateDbs;
      if (outcome.skippedReason === 'restore_deferred') {
        this.deferCodexHistoryWork('Codex history merge', reason, 'retry merge after ChatGPT exit');
      } else if (skipped > 0) {
        this.clearCodexHistoryDeferral('Codex history merge');
        log.warn(`[xwx-deck] Codex history merge skipped ${skipped} locked resource(s) (${reason}); it will be retried later.`);
        this.scheduleCodexHistoryWork('retry after locked merge');
      } else {
        this.clearCodexHistoryDeferral('Codex history merge');
      }
      return outcome;
    } catch (error) {
      // History classification is an enhancement. It must never block xwxDeck
      // startup or a provider switch while Codex owns its live session files.
      log.warn(`[xwx-deck] Codex history merge skipped (${reason}): ${(error as Error).message}`);
      return undefined;
    }
  }

  private async mergeCodexHistory(): Promise<CodexHistoryMigrationOutcome> {
    if (await this.codexHistoryMutationIsSafe()) await this.alignCodexHistoryIdentity();
    return this.codexHistory.mergeIntoXwXDeckHistory();
  }

  private async alignCodexHistoryIdentity(): Promise<void> {
    const settings = this.settings ?? await this.settingsStore.read();
    const current = await this.codexConfig.read();
    const provider = selectedProvider(settings, 'codex');
    const expected = settings.codexEnhancements.unifySessionHistory ? CODEX_STABLE_PROVIDER
      : current.mode === 'official' ? 'openai' : provider ? providerCodexId(provider) : current.activeProvider;
    if (current.activeProvider === expected) return;
    await this.withUnderlyingClient('codex-cli', () => this.applyCodexConfigAndAuth({
      mode: current.mode, officialModel: current.officialModel, compatibleModel: current.compatible.model,
      compatibleBaseUrl: settings.compatible.baseUrl, compatibleBearerToken: settings.compatible.bearerToken,
      preserveOfficialLogin: settings.codexEnhancements.preserveOfficialLogin
    }));
  }

  private async restorePendingCodexHistory(reason: string): Promise<CodexHistoryMigrationOutcome | undefined> {
    const settings = await this.settingsStore.read();
    this.settings = settings;
    if (!settings.codexEnhancements.pendingHistoryRestore) return undefined;
    if (settings.codexEnhancements.unifySessionHistory) {
      this.settings = await this.settingsStore.update({
        codexEnhancements: { pendingHistoryRestore: false }
      });
      return undefined;
    }

    try {
      if (await this.codexHistoryMutationIsSafe()) await this.alignCodexHistoryIdentity();
      const outcome = await this.codexHistory.restoreSeparatedHistory();
      const locked = outcome.skippedLockedJsonlFiles + outcome.skippedLockedStateDbs;
      if (outcome.skippedReason === 'restore_deferred') {
        this.deferCodexHistoryWork('Codex history restore', reason, 'retry restore after ChatGPT exit');
      } else if (locked > 0) {
        this.clearCodexHistoryDeferral('Codex history restore');
        log.warn(`[xwx-deck] Codex history restore skipped ${locked} locked resource(s) (${reason}); it will be retried later.`);
        this.scheduleCodexHistoryWork('retry after locked restore');
      } else if (outcome.skippedReason !== 'no_backup_ledger') {
        this.clearCodexHistoryDeferral('Codex history restore');
        this.settings = await this.settingsStore.update({
          codexEnhancements: { pendingHistoryRestore: false }
        });
      }
      return outcome;
    } catch (error) {
      log.warn(`[xwx-deck] Codex history restore skipped (${reason}): ${(error as Error).message}`);
      this.scheduleCodexHistoryWork('retry after restore error');
      return undefined;
    }
  }

  private async codexHistoryMutationIsSafe(): Promise<boolean> {
    if (process.env.XWX_DECK_SMOKE_IGNORE_EXTERNAL === '1') return true;
    try {
      return !await isChatGptRunning();
    } catch (error) {
      log.warn(`[xwx-deck] could not verify ChatGPT exit for history mutation: ${(error as Error).message}`);
      return false;
    }
  }

  private async chatGptRunningForRestartNotice(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      // Process detection is advisory; it must not hold a configuration write
      // hostage to a stuck OS process enumeration.
      return await Promise.race([
        (this.options.chatGptRunning ?? isChatGptRunning)(),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), 250); })
      ]);
    } catch (error) {
      log.warn(`[xwx-deck] could not determine whether ChatGPT needs a restart notice: ${(error as Error).message}`);
      return true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private markChatGptRestartRecommended(reason: string): void {
    if (this.chatGptRestartRecommended) return;
    this.chatGptRestartRecommended = true;
    log(`[xwx-deck] ChatGPT restart recommended: ${reason}`);
  }

  private async readLiveClientFallbackState(): Promise<ClientFallbackState | undefined> {
    const state = await this.clientFallbackStore.read();
    if (!state) return undefined;
    const port = parsePort(state.localBaseUrl);
    if (port !== undefined && await probeTapPort(port).catch(() => false)) return state;
    await this.clientFallbackStore.clear().catch(() => undefined);
    log(`[xwx-deck] removed stale non-recording client fallback for ${state.localBaseUrl}`);
    return undefined;
  }

  private async restoreClientFallbacksOnStartup(
    state: ClientFallbackState | undefined
  ): Promise<void> {
    if (!state || this.role !== 'owner') return;
    const localPort = parsePort(this.localBaseUrl());
    const fallbackPort = parsePort(state.localBaseUrl);
    if (localPort === undefined || fallbackPort === undefined || localPort !== fallbackPort) {
      log.warn(
        `[xwx-deck] ignored non-recording client fallback for a different Gateway `
        + `(saved=${state.localBaseUrl}, active=${this.localBaseUrl() ?? 'none'})`
      );
      return;
    }
    this.clientFallbacks = state.takeovers
      .filter(fallback => !(fallback.client === 'codex-cli' && this.codexGatewayEnabled))
      .map(fallback => ({ ...fallback }));
    if (this.clientFallbacks.length > 0) {
      log(
        `[xwx-deck] restored non-recording fallback route(s) on ${state.localBaseUrl}: `
        + this.clientFallbacks.map(fallback => fallback.client).join(', ')
      );
    }
  }

  private async persistClientFallbacks(): Promise<void> {
    if (!this.clientFallbacks.length) {
      await this.clientFallbackStore.clear();
      return;
    }
    const localBaseUrl = this.localBaseUrl();
    if (!localBaseUrl) {
      throw new Error('本地 Gateway 地址不可用，无法保存客户端回退路由。');
    }
    await this.clientFallbackStore.write(localBaseUrl, this.clientFallbacks);
  }

  /**
   * A hard kill (task manager / power loss) skips the shutdown handler, so the
   * persisted Codex config can still point at the local XwX Model Gateway while
   * the in-memory gateway state resets to false on the next launch. Without
   * this, ChatGPT CompatibleService silently stops forwarding until the user re-saves
   * CompatibleService. Re-derive the gateway from the saved config and rebuild the
   * routes so an auto-started/relaunched app reconnects CompatibleService itself.
   */
  private async restoreCodexGatewayOnStartup(preserveExistingConnection = false): Promise<void> {
    if (this.role !== 'owner') return;
    const localBaseUrl = this.localBaseUrl();
    if (!localBaseUrl) return;
    let snapshot: CodexConfigSnapshot;
    try {
      snapshot = await this.readUnderlyingCodexConfig();
    } catch (error) {
      log.warn(`[xwx-deck] ChatGPT CompatibleService gateway probe skipped: ${(error as Error).message}`);
      return;
    }
    const settings = this.settings ?? await this.settingsStore.read();
    if (preserveExistingConnection && snapshot.mode === 'compatible'
      && parsePort(snapshot.activeBaseUrl) === parsePort(localBaseUrl)
      && settings.compatible.baseUrl && settings.compatible.bearerToken) {
      // This is an existing connection, not a service switch. Rehydrate its
      // known route without replacing it with an empty generation when the
      // optional upstream probe is temporarily unavailable during startup.
      this.codexGatewayEnabled = true;
      this.codexGatewayMode = 'compatible';
      this.codexProviderIdentity = providerUpstreamKind(settings);
      await this.proxy.adoptCodexProviderOnStartup(this.codexProviderIdentity);
      return;
    }
    if (settings.codexPreferredMode === 'compatible' && snapshot.mode === 'official') {
      const connection = await this.readCompatibleServiceConfig();
      if (connection.baseUrl && connection.bearerToken && !isLoopbackUrl(connection.baseUrl)) {
        try {
          await this.withUnderlyingClient('codex-cli', () => this.applyCodexConfigAndAuth({
            mode: 'compatible',
            officialModel: snapshot.officialModel,
            compatibleModel: settings.codexModels.compatible || snapshot.compatible.model,
            compatibleBaseUrl: connection.baseUrl,
            compatibleBearerToken: connection.bearerToken,
            modelContextWindow: settings.codexModels.compatibleContextWindow || null,
            preserveOfficialLogin: settings.codexEnhancements.preserveOfficialLogin,
            unifySessionHistory: settings.codexEnhancements.unifySessionHistory
          }, { backgroundRefresh: false }));
          return;
        } catch (error) {
          this.lastError = (error as Error).message;
          this.setStartupPhase('degraded');
          log.warn(`[xwx-deck] preferred ChatGPT CompatibleService restore skipped: ${this.lastError}`);
        }
      }
    }
    const traceBackup = await this.clientBackup.read('codex');
    const backupPort = traceBackup ? parsePort(traceBackup.writtenLocalUrl) : undefined;
    const ownPort = parsePort(localBaseUrl);
    if (traceBackup && backupPort !== undefined && backupPort === ownPort && snapshot.mode === 'official') {
      // Stopping Trace leaves the fixed endpoint forwarding to official with
      // recording disabled. A running ChatGPT task may still cache that URL;
      // rebuild the route after manager restart instead of publishing none.
      this.codexGatewayEnabled = true;
      this.codexGatewayMode = 'official';
      this.codexOfficialAuthMode = snapshot.authMode;
      this.codexOfficialBearerToken = await this.codexOfficialAuth.readCurrentBearerToken();
      this.codexOfficialUpstreamBaseUrl = isLoopbackUrl(snapshot.activeBaseUrl)
        ? await this.codexConfig.readOfficialBaseUrl()
        : officialGatewayUpstreamFromSnapshot(snapshot);
      log(`[xwx-deck] restored official ChatGPT fallback on ${localBaseUrl} (recording=${settings.tracingEnabled})`);
      return;
    }
    const migratedLegacyTransition = await this.proxy.adoptCodexProviderOnStartup(snapshot.mode === 'official' ? 'official' : providerUpstreamKind(settings));
    if (migratedLegacyTransition) {
      log(`[xwx-deck] prepared one-time legacy Codex history cleanup for ${snapshot.mode} startup`);
    }
    if (snapshot.mode === 'official') {
      if (isLoopbackUrl(snapshot.activeBaseUrl)) {
        const configuredPort = parsePort(snapshot.activeBaseUrl);
        const ownPort = parsePort(localBaseUrl);
        if (configuredPort !== undefined && configuredPort === ownPort) {
          // CompatibleService -> official intentionally keeps the same helper endpoint
          // for a running ChatGPT process that may cache its provider URL. A
          // new manager must rehydrate that official route instead of treating
          // the healthy endpoint as stale and creating a 502 on the next turn.
          this.codexGatewayEnabled = true;
          this.codexGatewayMode = 'official';
          this.codexOfficialAuthMode = snapshot.authMode;
          this.codexOfficialBearerToken = await this.codexOfficialAuth.readCurrentBearerToken();
          this.codexOfficialUpstreamBaseUrl = await this.codexConfig.readOfficialBaseUrl();
          log(`[xwx-deck] restored official ChatGPT Gateway on ${localBaseUrl}`);
          return;
        }
        if (configuredPort !== undefined
          && configuredPort !== ownPort
          && await probeLocalTcpPort(configuredPort).catch(() => false)) {
          // A live local service owns this route. Trace's normal coordinator will
          // either yield to a healthy XwX Deck or preserve an unknown proxy; do
          // not steal either configuration during startup recovery.
          return;
        }

        // Older XwX Deck builds kept official ChatGPT on a persistent local
        // Gateway. Reinstalling the application does not rewrite config.toml,
        // so a hard quit could leave that dead endpoint behind indefinitely.
        // Repair only a dead/self-owned loopback URL; a live foreign proxy was
        // deliberately preserved above. The field-level restore also keeps
        // unrelated user TOML edits intact.
        const restored = await this.restoreCodexPreferredDirectConfiguration();
        logPreservedDirectChanges(undefined, restored.conflicts);
        if (await this.codexConfig.referencesLocalGateway(snapshot.activeBaseUrl)) {
          this.lastError = 'ChatGPT 配置仍指向已停止的旧 Gateway';
          this.setStartupPhase('degraded');
          log.warn(`[xwx-deck] ${this.lastError}`);
        } else if (restored.restoredFields > 0) {
          log(`[xwx-deck] detached official ChatGPT from stale local Gateway (${restored.restoredFields} field(s) restored)`);
        }
      }
      // Official ChatGPT must remain independent while Trace is off. Merely
      // launching XwX Deck must not insert a localhost hop, rewrite signed
      // requests, or make an idle ChatGPT process depend on XwX Deck's
      // lifetime. Trace enablement performs a scoped takeover later if the
      // user explicitly asks to record requests.
      return;
    }
    const connection = await this.readCompatibleServiceConfig();
    if (!connection.baseUrl || !connection.bearerToken || isLoopbackUrl(connection.baseUrl)) {
      const configuredPort = parsePort(snapshot.activeBaseUrl);
      const ownPort = parsePort(localBaseUrl);
      const xwxLoopbackResidue = (
        isXwXManagedProvider(snapshot.activeProvider)
      )
        && isLoopbackUrl(snapshot.activeBaseUrl)
        && configuredPort !== undefined
        && (configuredPort === ownPort
          || !await probeLocalTcpPort(configuredPort).catch(() => false));
      if (xwxLoopbackResidue) {
        // Reinstalling or resetting only XwX Deck userData can remove the
        // CompatibleService credential while Codex still points at an old managed
        // localhost provider. An empty helper cannot serve that route. Repair
        // only a self-owned/dead endpoint; a live foreign loopback is
        // deliberately preserved.
        const restored = await this.restoreCodexPreferredDirectConfiguration();
        logPreservedDirectChanges(undefined, restored.conflicts);
        if (await this.codexConfig.referencesLocalGateway(snapshot.activeBaseUrl)) {
          this.lastError = 'ChatGPT 配置仍指向已停止的旧 Gateway';
          this.setStartupPhase('degraded');
          log.warn(`[xwx-deck] ${this.lastError}`);
        } else if (restored.restoredFields > 0) {
          log(`[xwx-deck] restored ChatGPT from an unusable CompatibleService Gateway to the official service (${restored.restoredFields} field(s))`);
        }
      } else {
        log.warn('[xwx-deck] ChatGPT CompatibleService gateway not restored on startup: missing a valid upstream connection.');
      }
      return;
    }
    try {
      await this.withUnderlyingClient('codex-cli', () => this.applyCodexConfigAndAuth({
        mode: 'compatible',
        officialModel: snapshot.officialModel,
        compatibleModel: snapshot.compatible.model,
        compatibleBaseUrl: connection.baseUrl,
        compatibleBearerToken: connection.bearerToken,
        modelContextWindow: settings.codexModels.compatibleContextWindow || null,
        preserveOfficialLogin: settings.codexEnhancements.preserveOfficialLogin,
        unifySessionHistory: settings.codexEnhancements.unifySessionHistory
      }, { backgroundRefresh: false }));
    } catch (error) {
      this.lastError = (error as Error).message;
      this.setStartupPhase('degraded');
      log.warn(`[xwx-deck] ChatGPT CompatibleService gateway restore skipped: ${this.lastError}`);
    }
  }

  /** A user selection commits even when optional Gateway preparation fails. */
  private async applySelectedCodexConfig(input: CodexConfigUpdate, repairInvalid = false): Promise<CodexConfigSnapshot> {
    const settings = this.settings ?? await this.settingsStore.read();
    const provider = selectedProvider(settings, 'codex');
    let next: CodexConfigSnapshot;
    try {
      if (settings.tracingEnabled && !settings.gatewayPaused
        && (this.role !== 'owner' || !this.proxy.isListening())) {
        throw new Error('Trace 尚未就绪，可开启 Trace 后继续使用本地转发。');
      }
      next = await this.applyCodexConfigAndAuth(input, { skipRemoteChecks: true, repairInvalid });
    } catch (error) {
      // File errors need repair or a retry, never a write of the old provider.
      const reason = (error as Error).message;
      if (!/auth\.json/i.test(reason)
        && /config\.toml.*格式错误|TOML.*(?:错误|解析)|EACCES|EPERM|EBUSY|ENOSPC|其他软件修改|外部修改/i.test(reason)) throw error;
      next = await this.codexConfig.update({
        ...input,
        providerAdapter: provider?.adapter,
        disableImageGeneration: providerProfile(provider?.providerPreset).imageGenerationPolicy === 'block',
        ...codexProviderToml(provider, settings.codexEnhancements.unifySessionHistory),
        directProviders: providerDirectConnections(settings.providers?.connections),
        gatewayBaseUrl: undefined,
        preserveOfficialLogin: input.preserveOfficialLogin
      }, repairInvalid);
      this.codexGatewayEnabled = false;
      this.codexGatewayMode = undefined;
      this.codexProviderIdentity = input.mode === 'official' ? 'official' : providerUpstreamKind(settings);
      this.selectionWarning = `所选服务配置已保存；本地路由未就绪：${(error as Error).message}`;
      this.lastError = this.selectionWarning;
      if (await this.chatGptRunningForRestartNotice()) this.markChatGptRestartRecommended('selected provider saved directly after Gateway preparation failed');
    }
    if (input.mode === 'compatible' && (!settings.tracingEnabled || settings.gatewayPaused)
      && providerRequiresTrace(provider ?? settings.compatible, String(input.compatibleModel ?? ''), this.compatibleServiceCatalog)) {
      this.selectionWarning = '服务和模型选择已保存；调用此模型需要开启 Trace 进行协议转换。';
    }
    return { ...next, warning: this.selectionWarning };
  }

  private async applyCodexConfigAndAuth(
    input: CodexConfigUpdate,
    options: {
      readonly backgroundRefresh?: boolean;
      readonly skipRemoteChecks?: boolean;
      readonly repairInvalid?: boolean;
    } = {}
  ): Promise<CodexConfigSnapshot> {
    const settings = this.settings ?? await this.settingsStore.read();
    const selectedConnection = selectedProvider(settings, 'codex');
    const providerToml = codexProviderToml(selectedConnection, settings.codexEnhancements.unifySessionHistory);
    input = {
      ...input,
      providerAdapter: selectedConnection?.adapter,
      disableImageGeneration: providerProfile(selectedConnection?.providerPreset ?? settings.compatible.providerPreset).imageGenerationPolicy === 'block',
      ...providerToml,
      directProviders: providerDirectConnections(settings.providers?.connections),
      unifySessionHistory: settings.codexEnhancements.unifySessionHistory
    };
    const mode = input.mode;
    if (mode !== 'official' && mode !== 'compatible') throw new Error('不支持的 ChatGPT 配置模式，请重新选择服务。');
    const preserveOfficialLogin = input.preserveOfficialLogin !== false;
    let previousConfig: CodexConfigSnapshot;
    try {
      previousConfig = await this.codexConfig.read();
    } catch (error) {
      if (!options.repairInvalid
        || !/config\.toml.*格式错误|TOML.*(?:错误|解析)/i.test((error as Error).message)) {
        throw error;
      }
      previousConfig = await this.codexConfig.readFromContent(undefined);
    }
    const targetIdentity = mode === 'official' ? 'official' : providerUpstreamKind(this.settings ?? await this.settingsStore.read());
    const previousMode = this.codexProviderIdentity
      ?? (previousConfig.mode === 'official' ? 'official' : providerUpstreamKind(settings));
    const chatGptWasRunningBeforeUpdate = await this.chatGptRunningForRestartNotice();
    let managedInput: CodexConfigUpdate = { ...input, preserveOfficialLogin };
    if (Object.prototype.hasOwnProperty.call(input, 'modelContextWindow')) {
      const selectedModel = mode === 'compatible'
        ? typeof input.compatibleModel === 'string' ? input.compatibleModel.trim() : ''
        : typeof input.officialModel === 'string' ? input.officialModel.trim() : '';
      managedInput = {
        ...managedInput,
        modelContextWindow: this.validateCodexContextWindow(selectedModel, input.modelContextWindow, mode)
      };
    }

    if (mode === 'official') {
      const selectedModel = typeof input.officialModel === 'string' ? input.officialModel.trim() : '';
      if (selectedModel && !isOfficialCodexModelId(selectedModel)) {
        throw new Error(`模型 ${selectedModel} 不是可用于官方 ChatGPT/OpenAI 服务的模型。`);
      }
    }

    if (mode === 'compatible') {
      const upstreamBaseUrl = typeof input.compatibleBaseUrl === 'string' ? input.compatibleBaseUrl.trim() : '';
      const upstreamToken = typeof input.compatibleBearerToken === 'string' ? input.compatibleBearerToken.trim() : '';
      const selectedModel = typeof input.compatibleModel === 'string' ? input.compatibleModel.trim() : '';
      if (isKnownNonConversationalModel(selectedModel)) {
        throw new Error(`模型 ${selectedModel} 不是可用于 ChatGPT 的对话模型。`);
      }
      if (!upstreamBaseUrl || isLoopbackUrl(upstreamBaseUrl)) {
        throw new Error('CompatibleService 上游地址无效，不能指向 XwX 本地 Gateway。');
      }
      if (!settings.tracingEnabled || settings.gatewayPaused) {
        // Remote reachability belongs to real requests or explicit checks,
        // not the local configuration transaction.
        const modelCatalogPath = options.skipRemoteChecks || providerToml.publishModelCatalog === false
          ? undefined : await this.ensureCompatibleServiceModelCatalog(selectedModel);
        await this.codexOfficialAuth.restoreOfficialLogin();
        // A running ChatGPT process can keep its old localhost provider.
        // Prepare that route before replacing the on-disk provider.
        const keepCachedGateway = (isLoopbackUrl(previousConfig.activeBaseUrl) || this.codexGatewayEnabled)
          && this.role === 'owner' && this.proxy.isListening();
        if (keepCachedGateway) {
          this.codexGatewayEnabled = true;
          this.codexGatewayMode = 'compatible';
          await this.refreshProxyRoutes('codex-cli');
          await this.assertCodexGatewayRoute();
        }
        const next = await this.codexConfig.update({
          ...managedInput, gatewayBaseUrl: undefined, modelCatalogPath,
          preserveOfficialLogin
        }, options.repairInvalid);
        if (chatGptWasRunningBeforeUpdate && codexConfigRouteChanged(previousConfig, next)) {
          this.markChatGptRestartRecommended(
            'ChatGPT was running when its direct provider configuration changed'
          );
        } else if (!chatGptWasRunningBeforeUpdate) {
          this.chatGptRestartRecommended = false;
        }
        // A running ChatGPT process may still use its cached localhost URL.
        // Keep that endpoint routed until the process restarts.
        if (!keepCachedGateway) {
          this.codexGatewayEnabled = false;
          this.codexGatewayMode = undefined;
          if (this.role === 'owner') await this.refreshProxyRoutes('codex-cli');
        }
        this.codexProviderIdentity = targetIdentity;
        this.lastError = undefined;
        return next;
      }
      await this.startProxyUnlocked('ChatGPT Trace service');
      const localBaseUrl = this.localBaseUrl();
      if (!localBaseUrl) throw new Error('XwX Model Gateway 尚未启动。');

      const previousGatewayEnabled = this.codexGatewayEnabled;
      const previousGatewayMode = this.codexGatewayMode;
      const previousOfficialAuthMode = this.codexOfficialAuthMode;
      const previousOfficialBearerToken = this.codexOfficialBearerToken;
      const previousOfficialUpstreamBaseUrl = this.codexOfficialUpstreamBaseUrl;
      const previousSettings = this.settings ?? await this.settingsStore.read();
      let projectedCompatibleServiceAuth = false;
      this.settings = await this.settingsStore.update({
        compatible: { baseUrl: upstreamBaseUrl, bearerToken: upstreamToken }
      });

      try {
        // Persist the transition before publishing the new route. ChatGPT keeps
        // the same local endpoint during a switch and can issue compact at any
        // instant, including between route publication and config completion.
        if (previousMode !== targetIdentity) await this.proxy.markCodexProviderTransition(previousMode, targetIdentity);
        const modelCatalogPath = options.skipRemoteChecks || providerToml.publishModelCatalog === false
          ? undefined
          : await this.ensureCompatibleServiceModelCatalog(
            typeof input.compatibleModel === 'string' ? input.compatibleModel : undefined
          );
        managedInput = {
          ...input,
          gatewayBaseUrl: `${localBaseUrl.replace(/\/+$/, '')}/backend-api/codex`,
          modelCatalogPath,
          preserveOfficialLogin
        };

        // Route publication is the prepare phase. ChatGPT's config is not
        // allowed to point at the local Gateway until this phase is complete.
        this.codexGatewayEnabled = true;
        this.codexGatewayMode = 'compatible';
        this.codexOfficialAuthMode = undefined;
        this.codexOfficialBearerToken = undefined;
        this.codexOfficialUpstreamBaseUrl = undefined;
        await this.refreshProxyRoutes('codex-cli');
        await this.assertCodexGatewayRoute();
        this.setStartupPhase('routes-ready');

        if (preserveOfficialLogin) {
          await this.codexOfficialAuth.restoreOfficialLogin();
        } else {
          await this.codexOfficialAuth.useCompatibleServiceKey(upstreamToken);
          projectedCompatibleServiceAuth = true;
        }

        const next = await this.codexConfig.update(managedInput, options.repairInvalid);
        if (chatGptWasRunningBeforeUpdate && codexConfigRouteChanged(previousConfig, next)) {
          this.markChatGptRestartRecommended('ChatGPT was running when its service switched to the local Gateway');
        } else if (!chatGptWasRunningBeforeUpdate) {
          this.chatGptRestartRecommended = false;
        }
        this.codexProviderIdentity = targetIdentity;
        this.setStartupPhase('config-ready');
        if (options.backgroundRefresh) this.scheduleCompatibleServiceModelRefresh('gateway configured');
        return next;
      } catch (error) {
        if (projectedCompatibleServiceAuth) {
          await this.codexOfficialAuth.restoreOfficialLogin().catch(restoreError => {
            log.warn(`[xwx-deck] ChatGPT auth rollback failed: ${(restoreError as Error).message}`);
          });
        }
        this.codexGatewayEnabled = previousGatewayEnabled;
        this.codexGatewayMode = previousGatewayMode;
        this.codexOfficialAuthMode = previousOfficialAuthMode;
        this.codexOfficialBearerToken = previousOfficialBearerToken;
        this.codexOfficialUpstreamBaseUrl = previousOfficialUpstreamBaseUrl;
        this.settings = previousSettings;
        await this.settingsStore.update({ compatible: previousSettings.compatible }).catch(settingsError => {
          log.warn(`[xwx-deck] CompatibleService settings rollback failed: ${(settingsError as Error).message}`);
        });
        await this.refreshProxyRoutesBestEffort('CompatibleService Gateway rollback');
        this.setStartupPhase('degraded');
        throw error;
      }
    }

    const previousGatewayEnabled = this.codexGatewayEnabled;
    const previousGatewayMode = this.codexGatewayMode;
    const previousOfficialAuthMode = this.codexOfficialAuthMode;
    const previousOfficialBearerToken = this.codexOfficialBearerToken;
    const previousOfficialUpstreamBaseUrl = this.codexOfficialUpstreamBaseUrl;
    const previousSettings = this.settings ?? await this.settingsStore.read();
    try {
      if (previousMode !== targetIdentity) await this.proxy.markCodexProviderTransition(previousMode, targetIdentity);
      await this.codexOfficialAuth.restoreOfficialLogin();
      let officialConfig: CodexConfigSnapshot;
      try {
        officialConfig = await this.codexConfig.read();
      } catch (error) {
        if (!options.repairInvalid
          || !/config\.toml.*格式错误|TOML.*(?:错误|解析)/i.test((error as Error).message)) throw error;
        officialConfig = await this.codexConfig.readFromContent(undefined);
      }
      this.codexOfficialAuthMode = officialConfig.authMode;
      this.codexOfficialBearerToken = await this.codexOfficialAuth.readCurrentBearerToken();
      this.codexOfficialUpstreamBaseUrl = options.repairInvalid
        ? undefined
        : await this.codexConfig.readOfficialBaseUrl();
      const localBaseUrl = this.localBaseUrl();
      // Keep the stable endpoint when switching away from CompatibleService. A running
      // ChatGPT app-server may cache its old localhost provider and does not
      // reliably hot-reload external config.toml edits. The independent helper
      // can safely outlive the manager and route that cached endpoint official.
      const cachedLocalProvider = !settings.tracingEnabled
        && (isLoopbackUrl(previousConfig.activeBaseUrl) || previousGatewayEnabled)
        && this.role === 'owner' && this.proxy.isListening();
      const requiresGateway = cachedLocalProvider
        || settings.tracingEnabled && !settings.gatewayPaused
          && (this.proxy.background && previousGatewayEnabled || this.active && settings.clientEnabled.codex !== false);
      if (requiresGateway && localBaseUrl && this.role === 'owner') {
        this.codexGatewayEnabled = true;
        this.codexGatewayMode = 'official';
        await this.refreshProxyRoutes('codex-cli');
        managedInput = {
          ...managedInput,
          gatewayBaseUrl: `${localBaseUrl.replace(/\/+$/, '')}/backend-api/codex`
        };
        await this.assertCodexGatewayRoute();
      } else {
        // With Trace off, official service is direct. XwX Deck may be closed
        // independently and never sees or mutates ChatGPT request bodies.
        this.codexGatewayEnabled = false;
        this.codexGatewayMode = undefined;
        this.codexOfficialAuthMode = undefined;
        this.codexOfficialBearerToken = undefined;
        this.codexOfficialUpstreamBaseUrl = undefined;
        if (this.role === 'owner') await this.refreshProxyRoutes('codex-cli');
      }
      const next = await this.codexConfig.update(managedInput, options.repairInvalid);
      this.codexProviderIdentity = targetIdentity;
      if (chatGptWasRunningBeforeUpdate && codexConfigRouteChanged(previousConfig, next)) {
        this.markChatGptRestartRecommended(
          'ChatGPT was running when its official provider configuration changed'
        );
      } else if (!chatGptWasRunningBeforeUpdate) {
        this.chatGptRestartRecommended = false;
      }
      return next;
    } catch (error) {
      if (previousGatewayMode === 'compatible' && !preserveOfficialLogin && previousSettings.compatible.bearerToken) {
        await this.codexOfficialAuth.useCompatibleServiceKey(previousSettings.compatible.bearerToken).catch(authError => {
          log.warn(`[xwx-deck] ChatGPT CompatibleService auth rollback failed: ${(authError as Error).message}`);
        });
      }
      this.codexGatewayEnabled = previousGatewayEnabled;
      this.codexGatewayMode = previousGatewayMode;
      this.codexOfficialAuthMode = previousOfficialAuthMode;
      this.codexOfficialBearerToken = previousOfficialBearerToken;
      this.codexOfficialUpstreamBaseUrl = previousOfficialUpstreamBaseUrl;
      await this.refreshProxyRoutesBestEffort('official Gateway rollback');
      this.setStartupPhase('degraded');
      throw error;
    }
  }

  private async ensureCompatibleServiceModelCatalog(fallbackModel?: string): Promise<string> {
    if (this.compatibleServiceCatalog.length) return this.codexCatalog.sync(this.compatibleServiceCatalog, !this.settings || selectedProvider(this.settings, 'codex')?.adapter === 'auto');
    // A shared downstream file may belong to another provider; regenerate it.

    const model = fallbackModel?.trim();
    if (!model) throw new Error('CompatibleService 模型目录尚未缓存，请刷新模型列表后重试。');
    const provider = this.settings && selectedProvider(this.settings, 'codex');
    const protocol = provider?.codexApiFormat ?? this.settings?.compatible.codexApiFormat ?? 'responses';
    this.compatibleServiceCatalog = [{
      id: model,
      vendor: 'CompatibleService',
      protocols: [protocol === 'responses' ? 'openai-responses' : protocol],
      catalogEndpoints: [],
      clients: ['codex']
    }];
    return this.codexCatalog.sync(this.compatibleServiceCatalog, !this.settings || selectedProvider(this.settings, 'codex')?.adapter === 'auto');
  }

  private validateCodexContextWindow(
    modelId: string,
    raw: unknown,
    mode: 'official' | 'compatible'
  ): number | null {
    if (raw === null || raw === undefined || raw === 0) return null;
    if (
      typeof raw !== 'number'
      || !Number.isSafeInteger(raw)
      || raw < CODEX_MIN_CONTEXT_WINDOW
    ) {
      throw new Error('ChatGPT 上下文窗口无效。');
    }
    const catalogEntry = mode === 'compatible'
      ? this.compatibleServiceCatalog.find(entry => entry.id === modelId)
      : undefined;
    const builtin = mode === 'official' || !catalogEntry
      ? findBuiltInModelCapability(modelId)
      : undefined;
    const knownMaximum = catalogEntry?.capabilitySources?.contextWindow !== 'fallback'
      ? catalogEntry?.contextWindow
      : builtin?.contextWindow;
    const maximum = Math.min(
      CODEX_MAX_CONTEXT_WINDOW,
      Number.isSafeInteger(knownMaximum) && (knownMaximum as number) >= CODEX_MIN_CONTEXT_WINDOW
        ? knownMaximum as number
        : CODEX_MAX_CONTEXT_WINDOW
    );
    if (raw > maximum) {
      log.warn(
        `[xwx-deck] clamped ${modelId || '（未选择）'} context window from ${raw} to ${maximum} tokens`
      );
      return maximum;
    }
    return raw;
  }

  private repairRememberedOfficialSelection(
    modelId: string,
    contextWindow: number
  ): { model: string; contextWindow: number | null; repaired: boolean } {
    const normalizedModel = modelId.trim();
    if (isOfficialCodexModelId(normalizedModel)) {
      try {
        return {
          model: normalizedModel,
          contextWindow: this.validateCodexContextWindow(normalizedModel, contextWindow || null, 'official'),
          repaired: false
        };
      } catch {
        // Remembered state is internal data. Repair an incompatible model/window
        // pair instead of blocking the user from returning to the official service.
      }
    }
    return {
      model: RECOVERED_OFFICIAL_MODEL,
      contextWindow: CODEX_STANDARD_LONG_CONTEXT_WINDOW,
      repaired: true
    };
  }

  private async refreshCompatibleServiceModelCatalog(
    baseUrl: string,
    bearerToken: string,
    forceCapabilityRefresh = false
  ): Promise<readonly ModelCatalogEntry[]> {
    const provider = selectedProvider(this.settings ?? await this.settingsStore.read(), 'codex');
    const connection = `${provider?.id ?? ''}\0${provider?.adapter ?? ''}\0${baseUrl}\0${bearerToken}`;
    const inflight = this.compatibleServiceCatalogRefresh;
    if (inflight?.connection === connection) {
      if (!forceCapabilityRefresh || inflight.forceCapabilityRefresh) {
        return inflight.promise;
      }
      // A strong refresh must never be downgraded by an overlapping
      // cache-first request. Let the weaker request finish, then run the
      // awaited capability refresh even if the first request failed.
      await inflight.promise.catch(() => undefined);
      if (this.compatibleServiceCatalogRefresh === inflight) this.compatibleServiceCatalogRefresh = undefined;
    }
    if (!forceCapabilityRefresh && this.compatibleServiceCatalog.length && Date.now() - this.compatibleServiceCatalogRefreshedAt < 5_000) {
      return this.compatibleServiceCatalog;
    }
    const generation = this.compatibleServiceCatalogGeneration;
    const refresh = (async (): Promise<readonly ModelCatalogEntry[]> => {
      let catalog: readonly ModelCatalogEntry[];
      if (provider) {
        catalog = await fetchProviderCatalog(provider, path.join(this.userDataDir, 'model-capabilities-cache.json'), forceCapabilityRefresh);
      } else {
        catalog = await fetchCompatibleServiceModelCatalog(
          baseUrl,
          bearerToken,
          fetch,
          path.join(this.userDataDir, 'model-capabilities-cache.json'),
          this.compatibleServiceCatalog,
          { forceCapabilityRefresh }
        );
      }
      if (generation === this.compatibleServiceCatalogGeneration) {
        this.compatibleServiceCatalog = catalog;
        this.compatibleServiceCatalogRefreshedAt = Date.now();
        await writeCompatibleServiceModelCatalogCache(
          this.compatibleServiceModelCatalogCachePath(),
          baseUrl,
          bearerToken,
          catalog,
          provider?.providerPreset ?? this.settings?.compatible.providerPreset ?? 'auto'
        ).catch(error => {
          log.warn(`[xwx-deck] CompatibleService model directory cache write failed: ${(error as Error).message}`);
        });
      }
      return catalog;
    })();
    const activeRefresh = { connection, forceCapabilityRefresh, promise: refresh };
    this.compatibleServiceCatalogRefresh = activeRefresh;
    try {
      return await refresh;
    } finally {
      if (this.compatibleServiceCatalogRefresh === activeRefresh) this.compatibleServiceCatalogRefresh = undefined;
    }
  }

  private compatibleServiceModelCatalogCachePath(): string {
    const provider = this.settings && selectedProvider(this.settings, 'codex');
    return path.join(this.userDataDir, provider && provider.id !== 'initial-provider' ? `provider-${provider.id}-${provider.adapter}-models.json` : 'compatible-model-catalog-cache.json');
  }

  private async loadClaudeCompatibleServiceCatalog(): Promise<readonly ModelCatalogEntry[]> {
    const settings = await this.settingsStore.read();
    const id = settings.providers?.selected.claude;
    if (!id) return [];
    try { return await this.fetchProviderModels(id, false, false); }
    catch (error) { log.warn(`[xwx-deck] Claude 模型目录刷新失败：${(error as Error).message}`); return []; }
  }

  private async cachedClaudeCompatibleServiceCatalog(settings: XwXDeckSettings): Promise<readonly ModelCatalogEntry[]> {
    const provider = selectedProvider(settings, 'claude');
    if (!provider) return [];
    return readCompatibleServiceModelCatalogCache(
      path.join(this.userDataDir, `provider-${provider.id}-${provider.adapter}-models.json`),
      provider.baseUrl,
      provider.bearerToken,
      provider.providerPreset,
      true
    );
  }

  private async syncClaudeDesktopIfEnabled(
    catalog?: readonly ModelCatalogEntry[],
    generation?: number
  ): Promise<ClaudeDesktopSyncSnapshot> {
    const settings = this.settings ?? await this.settingsStore.read();
    if (!settings.claudeDesktop.syncEnabled) {
      this.claudeDesktopRequiresTrace = false;
      return this.trackClaudeDesktopRoute(() => this.claudeDesktopConfig.restore());
    }
    // A saved connection can survive from older releases even after Claude
    // returned to its official service. The live Claude selection wins.
    const service = settings.claudePreferredMode === 'auto'
      ? await this.readUnderlyingClaudeService()
      : { enabled: settings.claudePreferredMode === 'compatible' };
    if (generation !== undefined && (generation !== this.desktopSyncGeneration || this.shutdownRequested)) {
      return this.claudeDesktopConfig.read();
    }
    const provider = selectedProvider(settings, 'claude');
    if (!provider || !service.enabled) {
      const result = await this.trackClaudeDesktopRoute(() => this.claudeDesktopConfig.restoreOfficial());
      this.claudeDesktopCatalog = [];
      this.claudeDesktopGatewayEnabled = false;
      this.claudeDesktopRequiresTrace = false;
      if (this.role === 'owner') await this.refreshProxyRoutes();
      await this.stopClaudeDesktopGatewayIfUnused();
      return result;
    }
    const source = catalog ?? await this.loadClaudeCompatibleServiceCatalog();
    if (generation !== undefined && (generation !== this.desktopSyncGeneration || this.shutdownRequested)) {
      return this.claudeDesktopConfig.read();
    }
    // Models without Messages reach Desktop through the Gateway's bridge.
    const available = source.filter(entry => resolveClaudeModelProtocol(provider, entry) !== undefined);
    if (!available.length) throw new Error('当前 Claude 服务没有可同步到 Desktop 的对话模型。');
    this.claudeDesktopCatalog = available;
    // Native Claude IDs connect to the service directly. Deck's Gateway is
    // used only while Trace records; aliased models are listed only then.
    const direct = claudeDesktopDirectGateway(provider);
    const nativeCatalog = available.filter(entry => (
      resolveClaudeModelProtocol(provider, entry) === 'anthropic-messages'
      && isClaudeDesktopCompatibleModelId(entry.id)
    ));
    const directFallback = direct && nativeCatalog.length
      ? { gatewayBaseUrl: direct.baseUrl, gatewayApiKey: provider.bearerToken, gatewayAuthScheme: direct.authScheme }
      : undefined;
    if (!this.active) {
      if (generation !== undefined && (generation !== this.desktopSyncGeneration || this.shutdownRequested)) {
        return this.claudeDesktopConfig.read();
      }
      this.claudeDesktopGatewayEnabled = false;
      this.claudeDesktopRequiresTrace = !directFallback;
      // Without a usable remote profile, return Desktop to its own previous
      // configuration rather than leaving it on a Deck port.
      const result = directFallback
        ? await this.trackClaudeDesktopRoute(() => this.claudeDesktopConfig.apply({
          ...directFallback,
          mode: 'direct',
          catalog: nativeCatalog,
          models: settings.claudeModels
        }))
        : await this.trackClaudeDesktopRoute(() => this.claudeDesktopConfig.restore());
      if (this.role === 'owner') await this.refreshProxyRoutes();
      await this.stopClaudeDesktopGatewayIfUnused();
      return result;
    }

    this.claudeDesktopRequiresTrace = false;
    this.claudeDesktopGatewayEnabled = true;
    if (!this.localBaseUrl()) await this.startProxyUnlocked('Claude Desktop model routing');
    const localBaseUrl = this.localBaseUrl();
    if (this.role !== 'owner' || !localBaseUrl) throw new Error('Claude Desktop 本地路由启动失败。');
    await this.refreshProxyRoutes();
    // The helper is detached from the manager, so wait until its route
    // generation is published before Claude Desktop can send the first request.
    await this.proxy.synchronize?.();
    if (!this.proxy.hasClientRoute('claude-cli', '/claude-desktop/v1/messages')) {
      throw new Error('Claude Desktop 本地路由尚未就绪。');
    }
    if (generation !== undefined && (generation !== this.desktopSyncGeneration || this.shutdownRequested)) {
      return this.claudeDesktopConfig.read();
    }
    return this.trackClaudeDesktopRoute(() => this.claudeDesktopConfig.apply({
      gatewayBaseUrl: `${localBaseUrl}/claude-desktop`,
      gatewayApiKey: 'xwx-deck-local',
      gatewayAuthScheme: 'bearer',
      mode: 'local',
      catalog: available,
      models: settings.claudeModels,
      // Stop and exit switch to this remote profile without network access.
      ...(directFallback ? { directFallback } : {})
    }));
  }

  /** Trace on/off: switch the Desktop profile before reporting the result,
   * using the catalog already known offline. The scheduled sync refreshes it. */
  private async syncClaudeDesktopRouteNow(): Promise<void> {
    const settings = this.settings;
    if (!settings?.claudeDesktop.syncEnabled || this.shutdownRequested) return;
    try {
      const catalog = this.claudeDesktopCatalog.length
        ? this.claudeDesktopCatalog
        : await this.cachedClaudeCompatibleServiceCatalog(settings);
      if (!catalog.length) return;
      await this.syncClaudeDesktopIfEnabled(catalog);
    } catch (error) {
      log.warn(`[xwx-deck] Claude Desktop route switch deferred to background sync: ${(error as Error).message}`);
    }
  }

  /** Stop/exit: detach Desktop from the local Gateway. A local profile with a
   * remote fallback keeps the selected service; otherwise Desktop returns to
   * its pre-sync configuration. */
  private restoreClaudeDesktopFromLocalGateway(): Promise<ClaudeDesktopSyncSnapshot> {
    return this.trackClaudeDesktopRoute(() => this.claudeDesktopConfig.restoreLocal());
  }

  private async trackClaudeDesktopRoute(
    change: () => Promise<ClaudeDesktopSyncSnapshot>
  ): Promise<ClaudeDesktopSyncSnapshot> {
    const before = await this.claudeDesktopConfig.read().catch(() => undefined);
    const result = await change();
    const wasLocal = before?.active === true && (before.mode ?? 'local') === 'local';
    const isLocal = result.active && (result.mode ?? 'local') === 'local';
    if (wasLocal !== isLocal && await this.claudeRunningForRestartNotice()) {
      this.claudeDesktopRestart = isLocal ? 'local' : 'direct';
      log(`[xwx-deck] Claude Desktop restart recommended: profile ${isLocal ? 'moved to' : 'left'} the local Gateway`);
    }
    return result;
  }

  private async claudeRunningForRestartNotice(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      // Advisory only; never hold a Trace transition behind process listing.
      // A restart notice requires positive evidence that Claude is running.
      return await Promise.race([
        (this.options.claudeRunning ?? isClaudeDesktopRunning)(),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 250); })
      ]);
    } catch (error) {
      log.warn(`[xwx-deck] could not determine whether Claude Desktop is running: ${(error as Error).message}`);
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Set when Desktop was running while its profile left or joined the Gateway. */
  claudeDesktopRestartHint(): ClaudeDesktopRestartHint | undefined {
    return this.claudeDesktopRestart;
  }

  private scheduleClaudeDesktopSync(
    catalog?: readonly ModelCatalogEntry[],
    expectedProviderId?: string
  ): void {
    if (!this.settings?.claudeDesktop.syncEnabled) return;
    const generation = ++this.desktopSyncGeneration;
    setTimeout(() => {
      if (this.shutdownRequested || generation !== this.desktopSyncGeneration) return;
      void (async () => {
        // Let the initiating config transaction finish (or roll back) first,
        // without occupying its write queue while catalog/Desktop work runs.
        await this.mutationOperation;
        const latest = await this.settingsStore.read();
        if (this.shutdownRequested || generation !== this.desktopSyncGeneration
          || !latest.claudeDesktop.syncEnabled
          || expectedProviderId && latest.providers?.selected.claude !== expectedProviderId) return;
        await this.syncClaudeDesktopIfEnabled(catalog, generation);
      })().then(() => {
        if (generation !== this.desktopSyncGeneration || this.shutdownRequested) return;
        if (this.desktopSyncError) {
          this.desktopSyncError = undefined;
          this.fireChange();
        }
      }).catch(error => {
        if (generation !== this.desktopSyncGeneration || this.shutdownRequested) return;
        log.warn(`[xwx-deck] Claude Desktop sync failed independently of Trace: ${(error as Error).message}`);
        this.desktopSyncError = (error as Error).message;
        this.fireChange();
      });
    }, 0);
  }

  private async stopClaudeDesktopGatewayIfUnused(): Promise<void> {
    if (this.claudeDesktopGatewayEnabled || this.active || this.codexGatewayEnabled) return;
    if ([...this.clientTakeovers, ...this.clientFallbacks].some(item => item.status === 'taken')) return;
    if (this.role !== 'owner' || !this.proxy.isListening()) return;
    this.proxy.setClientRoutes([]);
    await this.proxy.synchronize?.();
    await this.proxy.stop();
    await deleteLock(this.traceStore.rootPath()).catch(() => undefined);
    this.stopLockWatcher();
    this.role = undefined;
    this.followerPort = undefined;
  }

  private async refreshProxyRoutes(changedClient?: ClientId): Promise<void> {
    const settings = this.settings;
    const transient = buildClientRoutes(
      this.clientTakeovers,
      settings?.compatible.codexApiFormat ?? 'responses',
      client => this.active && (
        client === 'claude-cli'
          ? settings?.clientEnabled.claude !== false
          : settings?.clientEnabled.codex !== false
      )
    );
    const fallbacks = buildClientRoutes(
      this.clientFallbacks,
      settings?.compatible.codexApiFormat ?? 'responses',
      false
    );
    const claudeProvider = settings && selectedProvider(settings, 'claude');
    const hasClaudeRoute = [...transient, ...fallbacks].some(route => route.source === 'claude-cli');
    if (claudeProvider && hasClaudeRoute) {
      const bridge = claudeMessagesBridgeFields(
        claudeProvider,
        await this.cachedClaudeCompatibleServiceCatalog(settings).catch(() => [])
      );
      for (const routes of [transient, fallbacks]) for (let index = 0; index < routes.length; index += 1) {
        const route = routes[index];
        if (route.source !== 'claude-cli') continue;
        routes[index] = { ...route, providerId: providerIdentityId(claudeProvider), providerName: claudeProvider.displayName,
          providerAdapter: claudeProvider.adapter, upstreamBearerToken: claudeProvider.bearerToken,
          defaultProtocol: 'anthropic-messages',
          ...(claudeProvider.adapter === 'anthropic-messages' ? { upstreamBaseUrl: claudeProvider.baseUrl } : {}),
          ...bridge };
      }
    }
    const gateway = this.codexGatewayEnabled && this.settings
      ? this.codexGatewayMode === 'official'
        ? buildCodexOfficialGatewayRoutes(
          this.settings,
          this.codexOfficialAuthMode,
          this.codexOfficialBearerToken,
          this.codexOfficialUpstreamBaseUrl
        )
        : buildCodexGatewayRoutes(this.settings, this.compatibleServiceCatalog)
      : [];
    const desktop = settings?.claudeDesktop.syncEnabled && this.claudeDesktopGatewayEnabled
      ? buildClaudeDesktopRoutes(settings, this.claudeDesktopCatalog)
      : [];
    const routes = [...gateway, ...desktop, ...transient, ...fallbacks];
    const resolver = this.options.resolveUpstreamProxyUrl;
    if (!resolver || routes.length === 0) {
      this.logProxyRouteSummary(routes);
      this.proxy.setClientRoutes(routes);
      this.lastPublishedRoutes = routes;
      return;
    }
    const proxyByUpstream = new Map<string, string | undefined>();
    const previousRoute = (route: TapClientRoute) => this.lastPublishedRoutes.find(previous =>
      previous.source === route.source && previous.path === route.path
      && previous.upstreamBaseUrl === route.upstreamBaseUrl
    );
    const changedUpstreams = new Set(routes.filter(route =>
      !changedClient || route.source === changedClient || !previousRoute(route)
    ).map(route => route.upstreamBaseUrl));
    await Promise.all([...changedUpstreams].map(async upstream => {
      proxyByUpstream.set(upstream, await advisoryRead(resolver(upstream), '系统代理'));
    }));
    const resolvedRoutes = routes.map(route => {
      const upstreamProxyUrl = changedUpstreams.has(route.upstreamBaseUrl)
        ? proxyByUpstream.get(route.upstreamBaseUrl)
        : previousRoute(route)?.upstreamProxyUrl;
      return upstreamProxyUrl ? { ...route, upstreamProxyUrl } : route;
    });
    this.logProxyRouteSummary(resolvedRoutes);
    this.proxy.setClientRoutes(resolvedRoutes);
    this.lastPublishedRoutes = resolvedRoutes;
  }

  private logProxyRouteSummary(routes: readonly TapClientRoute[]): void {
    const summary = routes.map(route => {
      const upstream = hostOf(route.upstreamBaseUrl);
      const proxy = route.upstreamProxyUrl ? hostOf(route.upstreamProxyUrl) : 'DIRECT';
      return `${route.source}:${route.path}->${upstream} via ${proxy}`;
    }).sort().join(' | ');
    if (summary === this.lastProxyRouteSummary) return;
    this.lastProxyRouteSummary = summary;
    log(`[xwx-deck] Gateway routes synchronized: ${summary || 'none'}`);
  }

  private async refreshProxyRoutesBestEffort(reason: string): Promise<void> {
    await this.refreshProxyRoutes().catch(error => {
      log.warn(`[xwx-deck] ${reason} preserved the last synchronized routes: ${(error as Error).message}`);
    });
  }

  private isCodexTraceManaged(): boolean {
    return this.role === 'owner'
      // During manager reattachment `active` is rebuilt by enable() later in
      // startup, but the persisted Trace intent and backup already describe a
      // live helper-owned overlay. Read the backup in that window so startup
      // recovery does not mistake the healthy localhost route for stale data.
      && (this.active || this.settings?.tracingEnabled === true)
      && !this.codexGatewayEnabled
      && this.settings?.clientEnabled.codex !== false
      && !!this.proxy.localBaseUrl();
  }

  private async readUnderlyingClaudeService(): Promise<ModelServiceSnapshot['claudeStatus']> {
    const backup = await this.clientBackup.read('claude');
    const live = await this.claudeConfig.read();
    const underlying = backup
      ? await this.claudeConfig.readFromContent(backup.originalContent)
      : live;
    return {
      ...underlying,
      traceManaged: !!backup,
      liveBaseUrl: live.actualBaseUrl
    };
  }

  private async readUnderlyingCodexConfig(): Promise<CodexConfigSnapshot> {
    const backup = await this.clientBackup.read('codex');
    const localPort = parsePort(this.proxy.localBaseUrl());
    const backupPort = backup ? parsePort(backup.writtenLocalUrl) : undefined;
    const retainedOfficialFallback = this.role === 'owner'
      && localPort !== undefined
      && backupPort === localPort
      && this.settings?.clientEnabled.codex !== false;
    if (backup && (this.isCodexTraceManaged() || retainedOfficialFallback)) {
      return this.codexConfig.readFromContent(backup.originalContent);
    }
    return this.codexConfig.read();
  }

  private async withUnderlyingClient<T>(client: ClientId, action: () => Promise<T>, explicitSelection = false): Promise<T> {
    return this.serializeClientOperation(client, () => this.withUnderlyingClientUnlocked(client, action, explicitSelection));
  }

  private async withUnderlyingClientUnlocked<T>(client: ClientId, action: () => Promise<T>, explicitSelection = false): Promise<T> {
    const settingsKey = client === 'claude-cli' ? 'claude' : 'codex';
    const localBaseUrl = this.proxy.localBaseUrl();
    const traceManagedBefore = this.shouldTraceManageClient(client, settingsKey, localBaseUrl);
    const fallbackBefore = this.clientFallbacks.find(fallback => (
      fallback.client === client && fallback.status === 'taken'
    ));
    if (traceManagedBefore) try {
      const restored = await this.clientOrchestrator.restoreOne(client);
      this.lastError = restoreBlockingNotice(restored ? [restored] : []);
      const unresolved = restored?.unresolvedLocalReferences ?? [];
      const stillDependsOnThisProxy = !!localBaseUrl
        && this.clientOrchestrator.clientsPointingAt(localBaseUrl).includes(client);
      if (unresolved.length > 0 || stillDependsOnThisProxy) {
        const details = unresolved.length > 0 ? `：${unresolved.join('、')}` : '';
        throw new Error(
          `${client === 'codex-cli' ? 'ChatGPT' : 'Claude'} 的原始直连地址无法安全恢复${details}。`
          + '已取消服务切换，并保留当前 Trace 代理和恢复记录。'
        );
      }
      this.clientTakeovers = this.clientTakeovers.filter(item => item.client !== client);
      // Keep the published route table unchanged until the replacement route
      // is ready. Requests already accepted (and requests arriving during the
      // short config transaction) therefore finish on the previous upstream.
    } catch (error) {
      if (!explicitSelection) throw error;
      log.warn(`[xwx-deck] applying explicit selection to current client config: ${(error as Error).message}`);
    }
    let selectionWritten = false;
    try {
      const result = await action();
      selectionWritten = true;
      if (explicitSelection) await this.clientBackup.remove(settingsKey);
      if (client === 'codex-cli' && traceManagedBefore) await this.codexLocalProxy.discard();
      return result;
    } finally {
      if (!explicitSelection || selectionWritten) try {
      // The action can turn the persistent ChatGPT Gateway on or off. Recompute
      // the overlay requirement after it completes instead of reusing the
      // pre-transaction state (CompatibleService -> official must install Trace here).
      const traceManagedAfter = this.shouldTraceManageClient(client, settingsKey, localBaseUrl);
      if (traceManagedAfter && localBaseUrl) {
        const planned = this.clientOrchestrator.plan({
          claude: client === 'claude-cli',
          codex: client === 'codex-cli'
        })[0];
        this.clientTakeovers = [...this.clientTakeovers.filter(item => item.client !== client), planned];
        await this.refreshProxyRoutes();
        await this.assertPreparedClientRoutes([planned]);
        const result = await this.clientOrchestrator.applyOne(client, localBaseUrl);
        this.clientTakeovers = [...this.clientTakeovers.filter(item => item.client !== client), result];
        if (result.status === 'taken') {
          this.clientFallbacks = this.clientFallbacks.filter(fallback => fallback.client !== client);
          await this.persistClientFallbacks();
        }
        await this.refreshProxyRoutes();
        if (result.status === 'skipped') this.lastError = takeoverNotice([result]);
      } else if (fallbackBefore && localBaseUrl && this.role === 'owner') {
        if (client === 'codex-cli' && this.codexGatewayEnabled) {
          this.clientFallbacks = this.clientFallbacks.filter(fallback => fallback.client !== client);
        } else {
          const planned = this.clientOrchestrator.plan({
            claude: client === 'claude-cli',
            codex: client === 'codex-cli'
          })[0];
          if (planned?.status === 'taken') {
            this.clientFallbacks = mergeClientFallbacks(this.clientFallbacks, [planned]);
          }
        }
        await this.persistClientFallbacks();
        await this.refreshProxyRoutes();
      }
      } catch (error) {
        if (!explicitSelection) throw error;
        this.selectionWarning = `所选配置已保存；Trace 路由同步未完成：${(error as Error).message}`;
        this.lastError = this.selectionWarning;
      }
    }
  }

  private shouldTraceManageClient(
    client: ClientId,
    settingsKey: 'claude' | 'codex',
    localBaseUrl: string | undefined
  ): boolean {
    return this.role === 'owner'
      && this.active
      && !(client === 'codex-cli' && this.codexGatewayEnabled)
      && this.settings?.clientEnabled[settingsKey] !== false
      && !!localBaseUrl;
  }

  private serializeClientOperation<T>(client: ClientId, action: () => Promise<T>): Promise<T> {
    const result = this.clientOperations[client].then(action, action);
    this.clientOperations[client] = result.then(() => undefined, () => undefined);
    return result;
  }

  private serializeMutation<T>(action: () => Promise<T>): Promise<T> {
    const guarded = () => {
      if (this.shutdownRequested) {
        throw new Error('XwX Deck 正在关闭代理，新的配置操作已取消。');
      }
      return action();
    };
    const result = this.mutationOperation.then(guarded, guarded);
    this.mutationOperation = result.then(() => undefined, () => undefined);
    return result;
  }

  private serializeLifecycleMutation<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutationOperation.then(action, action);
    this.mutationOperation = result.then(() => undefined, () => undefined);
    return result;
  }

  private fireChange(): void {
    this.events.emit('change');
  }

  private logRootPath(): string {
    return resolveRuntimeDirectory(this.settings?.logRoot, path.join(this.userDataDir, 'logs'));
  }

  private createTraceRuntime(rootDir: string): void {
    this.traceOverviewGeneration += 1;
    this.traceOverview = { sessions: 0, traces: 0, storageText: formatBytes(0), traceStorageBytes: 0 };
    this.traceOverviewCheckedAt = 0;
    this.traceOverviewCheck = undefined;
    this.traceStorageCheckedAt = 0;
    this.traceStorageCheck = undefined;
    this.backgroundCaptureCheckedAt = 0;
    this.backgroundCaptureCheck = undefined;
    const store = new TraceStore(
      rootDir,
      () => 0,
      () => undefined,
      sessions => this.codexThreadTitles.overlay(sessions),
      () => false
    );
    const proxy: TraceProxy = this.options.backgroundGateway
      ? new GatewayProcessClient(
        this.userDataDir,
        rootDir,
        this.options.proxyListenPorts,
        async () => {
          const [chatGptRunning, claudeRunning] = await Promise.all([
            isChatGptRunning(),
            isClaudeRunning()
          ]);
          return !chatGptRunning && !claudeRunning;
        },
        {
          traceRetention: () => {
            return {
              maxSessions: 0,
              maxStorageBytes: 0
            };
          }
        }
      )
      : new TapProxy(
        store,
        this.options.proxyListenPorts,
        path.join(this.userDataDir, 'codex-portability', 'opaque-origins.json')
      );
    this.traceStore = store;
    this.proxy = proxy;
    proxy.setViewerHandler({
      html: async () => renderTapViewerHtml({ state: await this.snapshotState({ includeTraces: false }), mode: 'live' }),
      state: async () => this.snapshotState({ includeTraces: false }),
      sessionTraces: async (id, page) => this.snapshotSessionTraces(id, page),
      deleteSession: async id => {
        const ok = await store.deleteSession(id);
        if (ok) {
          this.traceOverviewCheckedAt = 0;
          this.traceStorageCheckedAt = 0;
          proxy.broadcastReset();
          this.fireChange();
        }
        return ok;
      }
    });
    store.onDidAppend(trace => {
      this.traceOverviewCheckedAt = 0;
      if (trace.source === 'claude-cli' || trace.source === 'claude-vscode') {
        this.clientsSeenSinceEnable.add('claude-cli');
      } else if (trace.source === 'codex-cli' || trace.source === 'codex-vscode') {
        this.clientsSeenSinceEnable.add('codex-cli');
      }
      proxy.broadcastTrace(trace);
      this.fireChange();
    });
  }

  private readonly providerValidationControllers = new Map<string, AbortController>();

  private readonly providerValidationGenerations = new Map<string, number>();

  private providerValidationSequence = 0;


  async validateProvider(id: string): Promise<ProviderValidationResult> {
    const settings = await this.settingsStore.read();
    const provider = settings.providers!.connections.find(connection => connection.id === id);
    if (!provider) throw new Error('服务连接不存在。');
    const fingerprint = providerIdentityId(provider);
    this.providerValidationControllers.get(id)?.abort();
    const controller = new AbortController();
    const generation = ++this.providerValidationSequence;
    this.providerValidationControllers.set(id, controller);
    this.providerValidationGenerations.set(id, generation);
    const timeout = setTimeout(() => controller.abort(), 8_000);
    let result: ProviderValidationResult;
    const catalogRefresh = this.fetchProviderModels(id, true).catch(error => {
      log.warn(`[xwxdeck] provider model directory validation failed (${provider.displayName}): ${(error as Error).message}`);
    });
    try {
      result = await validateProviderConnection(provider, fetch, controller.signal);
      await catalogRefresh;
    } finally {
      clearTimeout(timeout);
      if (this.providerValidationControllers.get(id) === controller) {
        this.providerValidationControllers.delete(id);
      }
    }
    const current = (await this.settingsStore.read()).providers!.connections.find(connection => connection.id === id);
    const latest = this.providerValidationGenerations.get(id) === generation;
    if (latest) this.providerValidationGenerations.delete(id);
    if (!latest || !current || providerIdentityId(current) !== fingerprint) {
      return { status: 'stale', providerId: id, providerName: provider.displayName };
    }
    return result;
  }


  private cancelProviderValidation(id: string): void {
    this.providerValidationControllers.get(id)?.abort();
    this.providerValidationControllers.delete(id);
    this.providerValidationGenerations.set(id, ++this.providerValidationSequence);
  }


  async diagnoseCodexConversations(): Promise<CodexConversationHealthReport> {
    return new CodexConversationDoctor().diagnose();
  }


  async queryCodexConversations(request: CodexConversationPageRequest): Promise<CodexConversationPageResponse> {
    return this.codexConversationWorker.query(request);
  }


  async detailCodexConversation(request: CodexConversationDetailRequest): Promise<CodexConversationHealthRow> {
    return this.codexConversationWorker.detail(request);
  }


  async inspectTraceIndexRepair(): Promise<TraceIndexRepairPlan> {
    return inspectTraceIndexRepair(this.traceStore.rootPath());
  }


  async applyTraceIndexRepair(expectedIndexSha256?: string): Promise<AppliedTraceIndexRepair> {
    return this.serializeMutation(async () => {
      if (this.active || this.proxy.isListening()) {
        throw new Error('请先关闭 Gateway 代理，再修复 Trace 索引。');
      }
      const result = await applyTraceIndexRepair(this.traceStore.rootPath(), expectedIndexSha256);
      this.proxy.broadcastReset();
      this.fireChange();
      return result;
    });
  }
}

function resolveRuntimeDirectory(configured: string | undefined, fallback: string): string {
  return configured && path.isAbsolute(configured) ? path.normalize(configured) : path.normalize(fallback);
}

function readSelectedDirectory(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value.trim())) {
    throw new Error(`${label}必须是绝对路径。`);
  }
  const resolved = path.normalize(value.trim());
  if (sameDirectory(resolved, path.parse(resolved).root)) throw new Error(`${label}不能直接使用磁盘根目录。`);
  return resolved;
}

function sameDirectory(left: string, right: string): boolean {
  const normalize = (value: string): string => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
  return normalize(left) === normalize(right);
}

function takeoverNotice(results: readonly ClientTakeoverResult[]): string | undefined {
  const skipped = results.filter(result => result.status === 'skipped');
  if (skipped.length === 0) return undefined;
  return `已开始追踪；${skipped.map(result => {
    const name = result.client === 'claude-cli' ? 'Claude' : 'ChatGPT';
    return `${name} 未接入：${takeoverSkipReason(result.skipReason)}`;
  }).join('；')}`;
}

function takeoverSkipReason(reason: ClientTakeoverResult['skipReason']): string {
  if (reason === 'no-config') return '未找到客户端配置';
  if (reason === 'bedrock-mode') return '当前使用 Bedrock，暂不支持接管';
  if (reason === 'cloud-provider-mode') return '当前使用 Claude 云厂商模式，暂不支持接管';
  if (reason === 'parse-error') return '配置文件格式错误';
  if (reason === 'write-failed') return '配置写入失败';
  if (reason === 'loopback-residue') return 'XwX Deck 当前的连接方式无法与 Trace 同时使用；请先重启 XwX Deck，再重启 Trace 后重试';
  if (reason === 'missing-provider-base-url') return '当前第三方服务缺少 base_url 配置';
  if (reason === 'environment-override') return 'Claude 接入失败：检测到环境变量 ANTHROPIC_BASE_URL，本地配置已失效，请移除相关环境变量后重试';
  return '未能接管客户端';
}

function restoreBlockingNotice(
  results: readonly ClientRestoreResult[]
): string | undefined {
  const unresolved = results.flatMap(result => (
    result.outcome === 'unresolved-local'
      ? result.unresolvedLocalReferences.map(reference => ({
          client: result.client,
          reference
        }))
      : []
  ));
  if (unresolved.length === 0) return undefined;
  return unresolved
    .map(item => `${item.client === 'claude' ? 'Claude' : 'ChatGPT'} ${item.reference} 仍指向本地 Gateway`)
    .join('；');
}

function logPreservedDirectChanges(
  connectionConflict?: string,
  directConflicts: readonly string[] = []
): void {
  if (connectionConflict) {
    log(`[xwx-deck] preserved current ChatGPT connection: ${connectionConflict}`);
  }
  for (const conflict of directConflicts) {
    log(`[xwx-deck] preserved current ChatGPT direct configuration: ${conflict}`);
  }
}

function mergeClientFallbacks(
  current: readonly ClientTakeoverResult[],
  next: readonly ClientTakeoverResult[]
): ClientTakeoverResult[] {
  const byClient = new Map<ClientId, ClientTakeoverResult>();
  for (const fallback of current) {
    if (fallback.status === 'taken' && fallback.upstreamBaseUrl) {
      byClient.set(fallback.client, { ...fallback });
    }
  }
  for (const fallback of next) {
    if (fallback.status === 'taken' && fallback.upstreamBaseUrl) {
      byClient.set(fallback.client, { ...fallback });
    }
  }
  return [...byClient.values()];
}

function buildClientRoutes(
  takeovers: readonly ClientTakeoverResult[],
  codexProtocol: CodexProtocol = 'responses',
  captureForClient: boolean | ((client: ClientId) => boolean) = true
): TapClientRoute[] {
  const out: TapClientRoute[] = [];
  for (const takeover of takeovers) {
    if (takeover.status !== 'taken' || !takeover.upstreamBaseUrl) continue;
    const capture = typeof captureForClient === 'function'
      ? captureForClient(takeover.client)
      : captureForClient;
    if (takeover.client === 'claude-cli') {
      out.push({
        source: 'claude-cli',
        path: '/v1/messages',
        apiType: 'messages',
        upstreamBaseUrl: takeover.upstreamBaseUrl,
        capture
      });
      out.push({
        source: 'claude-cli',
        path: '/anthropic/v1/messages',
        apiType: 'messages',
        upstreamBaseUrl: takeover.upstreamBaseUrl,
        stripPathPrefix: '/anthropic',
        capture
      });
    } else {
      if (takeover.codexRouteKind === 'chatgpt-oauth') {
        out.push({
          source: 'codex-cli',
          path: '/backend-api/codex/models',
          apiType: 'responses',
          upstreamBaseUrl: takeover.upstreamBaseUrl,
          stripPathPrefix: '/backend-api',
          capture: false
        });
        out.push({
          source: 'codex-cli',
          path: '/backend-api/codex/responses',
          apiType: 'responses',
          upstreamBaseUrl: takeover.upstreamBaseUrl,
          stripPathPrefix: '/backend-api',
          webSocket: 'official-responses',
          capture
        });
        // Retain a non-recording account route for older clients that cached
        // the previous local account root. New configurations keep it direct.
        out.push({
          source: 'codex-cli',
          path: '/backend-api/wham',
          apiType: 'responses',
          upstreamBaseUrl: takeover.upstreamBaseUrl,
          stripPathPrefix: '/backend-api',
          capture: false
        });
        continue;
      }
      const stripPathPrefix = takeover.stripV1 ? '/v1' as const : undefined;
      out.push({
        source: 'codex-cli',
        path: '/v1/models',
        apiType: 'responses',
        upstreamBaseUrl: takeover.upstreamBaseUrl,
        stripPathPrefix,
        capture: false
      });
      out.push({
        source: 'codex-cli',
        path: '/v1/chat/completions',
        apiType: 'chat-completions',
        upstreamBaseUrl: takeover.upstreamBaseUrl,
        stripPathPrefix,
        capture
      });
      out.push({
        source: 'codex-cli',
        path: '/v1/responses/compact',
        apiType: 'responses',
        upstreamBaseUrl: takeover.upstreamBaseUrl,
        stripPathPrefix,
        defaultProtocol: codexProtocol,
        capture,
        ...(codexProtocol !== 'responses' ? { transform: 'responses-compact-auto' as const } : {})
      });
      out.push({
        source: 'codex-cli',
        path: '/v1/responses',
        apiType: 'responses',
        upstreamBaseUrl: takeover.upstreamBaseUrl,
        stripPathPrefix,
        defaultProtocol: codexProtocol,
        capture,
        ...(codexProtocol === 'chat-completions'
          ? { transform: 'responses-to-chat-auto' as const }
          : codexProtocol === 'anthropic-messages'
            ? { transform: 'responses-to-anthropic' as const }
            : {})
     });
   }
 }
 return out;
}

function buildClaudeDesktopRoutes(
  settings: XwXDeckSettings,
  catalog: readonly ModelCatalogEntry[]
): TapClientRoute[] {
  const provider = selectedProvider(settings, 'claude');
  if (!provider || !provider.baseUrl || !provider.bearerToken || catalog.length === 0) return [];
  const upstreamBaseUrl = provider.adapter === 'auto'
    ? claudeCompatibleServiceBaseUrl(provider.baseUrl)
    : provider.baseUrl;
  if (!upstreamBaseUrl) return [];
  return [{
    source: 'claude-cli',
    path: '/claude-desktop/v1/messages',
    apiType: 'messages',
    upstreamBaseUrl,
    stripPathPrefix: '/claude-desktop',
    providerId: providerIdentityId(provider),
    providerName: provider.displayName,
    providerAdapter: provider.adapter,
    defaultProtocol: 'anthropic-messages',
    modelAliases: buildClaudeDesktopModelAliases(buildClaudeDesktopModels(catalog, settings.claudeModels)),
    capture: settings.clientEnabled.claude !== false,
    upstreamBearerToken: provider.bearerToken,
    ...claudeMessagesBridgeFields(provider, catalog)
  }];
}

/** OpenAI-compatible base for Claude models the service publishes without Messages. */
function claudeOpenAiBaseUrl(provider: ProviderConnection): string | undefined {
  if (provider.providerPreset === 'compatible') {
    const anthropic = claudeCompatibleServiceBaseUrl(provider.baseUrl);
    return anthropic ? anthropic.replace(/\/anthropic$/i, '/v1') : undefined;
  }
  if (provider.adapter !== 'anthropic-messages') return provider.baseUrl.trim().replace(/\/+$/, '') || undefined;
  return undefined;
}

/** Per-model Messages → Responses / Chat bridge for a Claude route. */
function claudeMessagesBridgeFields(
  provider: ProviderConnection,
  catalog: readonly ModelCatalogEntry[]
): Pick<TapClientRoute, 'transform' | 'openAiBaseUrl' | 'modelProtocols' | 'modelMaxOutputTokens'> {
  const openAiBaseUrl = claudeOpenAiBaseUrl(provider);
  if (!openAiBaseUrl) return {};
  const modelProtocols: Record<string, 'responses' | 'chat-completions'> = {};
  const modelMaxOutputTokens: Record<string, number> = {};
  for (const entry of catalog) {
    const protocol = resolveClaudeModelProtocol(provider, entry);
    if (protocol !== 'responses' && protocol !== 'chat-completions') continue;
    modelProtocols[entry.id] = protocol;
    if (entry.maxOutputTokens) modelMaxOutputTokens[entry.id] = entry.maxOutputTokens;
  }
  if (!Object.keys(modelProtocols).length) return {};
  return { transform: 'messages-auto', openAiBaseUrl, modelProtocols, modelMaxOutputTokens };
}

function claudeDesktopDirectGateway(
  provider: ProviderConnection
): { baseUrl: string; authScheme: 'bearer' | 'x-api-key' } | undefined {
  if (provider.adapter === 'auto') {
    const baseUrl = claudeCompatibleServiceBaseUrl(provider.baseUrl);
    return baseUrl ? { baseUrl, authScheme: 'bearer' } : undefined;
  }
  if (provider.adapter !== 'anthropic-messages') return undefined;
  const baseUrl = provider.baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  if (!baseUrl) return undefined;
  return {
    baseUrl,
    authScheme: provider.adapter === 'anthropic-messages' ? 'x-api-key' : 'bearer'
  };
}

/** Translate remembered models from other connections, preserving target-catalog models. */
function buildCodexSelectionAliases(
  settings: XwXDeckSettings,
  mode: 'official' | 'compatible',
  catalog: readonly ModelCatalogEntry[] = []
): Record<string, string> {
  const target = (mode === 'official' ? settings.codexModels.official : settings.codexModels.compatible).trim();
  if (!target) return {};
  const supported = new Set(catalog.filter(entry => entry.clients.includes('codex')).map(entry => entry.id));
  supported.add(target);
  const remembered = [settings.codexModels.official, settings.codexModels.compatible,
    ...(settings.providers?.connections.map(provider => provider.codexModel) ?? [])];
  return Object.fromEntries(remembered.filter(model => model && !supported.has(model)
    && (mode !== 'official' || !isOfficialCodexModelId(model))).map(model => [model, target]));
}

/** Provider forwarding with per-client Trace capture controls. */
function buildCodexGatewayRoutes(
  settings: XwXDeckSettings,
  catalog: readonly ModelCatalogEntry[] = []
): TapClientRoute[] {
  const upstreamBaseUrl = settings.compatible.baseUrl.trim().replace(/\/+$/, '');
  if (!upstreamBaseUrl) return [];
  const stripPathPrefix = baseUrlHasV1Suffix(upstreamBaseUrl) ? '/v1' as const : undefined;
  const capture = settings.clientEnabled.codex !== false;
  const modelProtocols: Record<string, 'responses' | 'chat-completions' | 'anthropic-messages'> = {};
  const modelMaxOutputTokens: Record<string, number> = {};
  const modelSupportsCompact: Record<string, boolean> = {};
  const provider = selectedProvider(settings, 'codex');
  const connection = provider ?? settings.compatible;
  const modelAliases = buildCodexSelectionAliases(settings, 'compatible', catalog);
  for (const entry of catalog) {
    modelProtocols[entry.id] = resolveProviderCodexProtocol(connection, entry.id, [entry]);
    if (entry.maxOutputTokens) modelMaxOutputTokens[entry.id] = entry.maxOutputTokens;
    if (entry.responsesCompact !== undefined) modelSupportsCompact[entry.id] = entry.responsesCompact;
  }

  return [
    // Accept both Codex provider path shapes once the client has connected to
    // this Gateway. This does not reroute a process that still uses a cached
    // direct official URL; the UI asks that client to restart after an
    // official-to-CompatibleService switch.
    {
      source: 'codex-cli',
      path: '/backend-api/codex/models',
      apiType: 'responses',
      upstreamBaseUrl,
      stripPathPrefix: '/backend-api/codex',
      compatibleServiceGateway: !provider || provider.adapter === 'auto',
      providerId: provider ? providerIdentityId(provider) : undefined,
      providerName: provider?.displayName,
      providerAdapter: provider?.adapter,
      defaultProtocol: connection.codexApiFormat,
      capture: false,
      upstreamBearerToken: settings.compatible.bearerToken
    },
    {
      source: 'codex-cli',
      path: '/v1/models',
      apiType: 'responses',
      upstreamBaseUrl,
      stripPathPrefix,
      compatibleServiceGateway: !provider || provider.adapter === 'auto',
      providerId: provider ? providerIdentityId(provider) : undefined,
      providerName: provider?.displayName,
      providerAdapter: provider?.adapter,
      defaultProtocol: connection.codexApiFormat,
      capture: false,
      upstreamBearerToken: settings.compatible.bearerToken
    },
    {
      source: 'codex-cli',
      path: '/backend-api/codex/responses/compact',
      apiType: 'responses',
      upstreamBaseUrl,
      stripPathPrefix: '/backend-api/codex',
      transform: 'responses-compact-auto',
      modelAliases,
      modelProtocols,
      modelMaxOutputTokens,
      modelSupportsCompact,
      compatibleServiceGateway: !provider || provider.adapter === 'auto',
      providerId: provider ? providerIdentityId(provider) : undefined,
      providerName: provider?.displayName,
      providerAdapter: provider?.adapter,
      defaultProtocol: connection.codexApiFormat,
      excludedToolNamespaces: providerProfile(provider?.providerPreset ?? settings.compatible.providerPreset).imageGenerationPolicy === 'block' ? ['image_gen'] : undefined,
      capture,
      upstreamBearerToken: settings.compatible.bearerToken
    },
    {
      source: 'codex-cli',
      path: '/backend-api/codex/responses',
      apiType: 'responses',
      upstreamBaseUrl,
      stripPathPrefix: '/backend-api/codex',
      transform: 'responses-to-chat-auto',
      modelAliases,
      modelProtocols,
      modelMaxOutputTokens,
      compatibleServiceGateway: !provider || provider.adapter === 'auto',
      providerId: provider ? providerIdentityId(provider) : undefined,
      providerName: provider?.displayName,
      providerAdapter: provider?.adapter,
      defaultProtocol: connection.codexApiFormat,
      excludedToolNamespaces: providerProfile(provider?.providerPreset ?? settings.compatible.providerPreset).imageGenerationPolicy === 'block' ? ['image_gen'] : undefined,
      capture,
      upstreamBearerToken: settings.compatible.bearerToken
    },
    {
      source: 'codex-cli',
      path: '/v1/responses/compact',
      apiType: 'responses',
      upstreamBaseUrl,
      stripPathPrefix,
      transform: 'responses-compact-auto',
      modelAliases,
      modelProtocols,
      modelMaxOutputTokens,
      modelSupportsCompact,
      compatibleServiceGateway: !provider || provider.adapter === 'auto',
      providerId: provider ? providerIdentityId(provider) : undefined,
      providerName: provider?.displayName,
      providerAdapter: provider?.adapter,
      defaultProtocol: connection.codexApiFormat,
      excludedToolNamespaces: providerProfile(provider?.providerPreset ?? settings.compatible.providerPreset).imageGenerationPolicy === 'block' ? ['image_gen'] : undefined,
      capture,
      upstreamBearerToken: settings.compatible.bearerToken
    },
    {
      source: 'codex-cli',
      path: '/v1/responses',
      apiType: 'responses',
      upstreamBaseUrl,
      stripPathPrefix,
      transform: 'responses-to-chat-auto',
      modelAliases,
      modelProtocols,
      modelMaxOutputTokens,
      compatibleServiceGateway: !provider || provider.adapter === 'auto',
      providerId: provider ? providerIdentityId(provider) : undefined,
      providerName: provider?.displayName,
      providerAdapter: provider?.adapter,
      defaultProtocol: connection.codexApiFormat,
      excludedToolNamespaces: providerProfile(provider?.providerPreset ?? settings.compatible.providerPreset).imageGenerationPolicy === 'block' ? ['image_gen'] : undefined,
      capture,
      upstreamBearerToken: settings.compatible.bearerToken
    },
    {
      source: 'codex-cli',
      path: '/v1/chat/completions',
      apiType: 'chat-completions',
      modelAliases,
      upstreamBaseUrl,
      stripPathPrefix,
      capture,
      upstreamBearerToken: settings.compatible.bearerToken
    }
  ];
}

function buildCodexOfficialGatewayRoutes(
  settings: XwXDeckSettings,
  authMode: CodexAuthMode | undefined,
  replacementBearerToken?: string,
  configuredUpstreamBaseUrl?: string
): TapClientRoute[] {
  const capture = settings.tracingEnabled && settings.clientEnabled.codex !== false;
  const oauth = authMode !== 'api-key';
  const canonicalUpstreamBaseUrl = configuredUpstreamBaseUrl || officialCodexUpstream(authMode);
  const aliasUpstreamBaseUrl = configuredUpstreamBaseUrl
    || (oauth ? CODEX_CHATGPT_OAUTH_PROVIDER_TARGET : CODEX_DEFAULT_TARGET);
  const aliasStripPathPrefix = baseUrlHasV1Suffix(aliasUpstreamBaseUrl) ? '/v1' as const : oauth ? '/v1' as const : undefined;
  const modelAliases = buildCodexSelectionAliases(settings, 'official');
  const routes: TapClientRoute[] = [
    {
      source: 'codex-cli',
      path: '/v1/models',
      apiType: 'responses',
      upstreamBaseUrl: aliasUpstreamBaseUrl,
      stripPathPrefix: aliasStripPathPrefix,
      blockedBearerToken: settings.compatible.bearerToken,
      replacementBearerToken,
      capture: false
    },
    {
      source: 'codex-cli',
      path: '/backend-api/codex/models',
      apiType: 'responses',
      upstreamBaseUrl: canonicalUpstreamBaseUrl,
      stripPathPrefix: '/backend-api/codex',
      blockedBearerToken: settings.compatible.bearerToken,
      replacementBearerToken,
      capture: false
    },
    // CompatibleService mode uses /v1. Retain it as an alias after switching official so
    // an already-running Codex process never falls into a local 502 gap.
    {
      source: 'codex-cli',
      path: '/v1/responses/compact',
      apiType: 'responses',
      modelAliases,
      upstreamBaseUrl: aliasUpstreamBaseUrl,
      stripPathPrefix: aliasStripPathPrefix,
      defaultProtocol: 'responses',
      blockedBearerToken: settings.compatible.bearerToken,
      replacementBearerToken,
      capture
    },
    {
      source: 'codex-cli',
      path: '/v1/responses',
      apiType: 'responses',
      modelAliases,
      upstreamBaseUrl: aliasUpstreamBaseUrl,
      stripPathPrefix: aliasStripPathPrefix,
      defaultProtocol: 'responses',
      webSocket: 'official-responses',
      blockedBearerToken: settings.compatible.bearerToken,
      replacementBearerToken,
      capture
    },
    {
      source: 'codex-cli',
      path: '/backend-api/codex/responses/compact',
      apiType: 'responses',
      modelAliases,
      upstreamBaseUrl: canonicalUpstreamBaseUrl,
      stripPathPrefix: '/backend-api/codex',
      defaultProtocol: 'responses',
      blockedBearerToken: settings.compatible.bearerToken,
      replacementBearerToken,
      capture
    },
    {
      source: 'codex-cli',
      path: '/backend-api/codex/responses',
      apiType: 'responses',
      modelAliases,
      upstreamBaseUrl: canonicalUpstreamBaseUrl,
      stripPathPrefix: '/backend-api/codex',
      defaultProtocol: 'responses',
      webSocket: 'official-responses',
      blockedBearerToken: settings.compatible.bearerToken,
      replacementBearerToken,
      capture
    }
  ];
  if (oauth) {
    // 官方 ChatGPT 账户/工作区接口（account/read、profiles、usage、tasks）使用
    // /wham/* 路径并跟随 chatgpt_base_url 进入本地 Gateway。缺少这条 passthrough
    // 会把 workspace routing discovery 打成 404/502，表现为登录后
    // “workspace routing discovery failed”。这些请求不是模型请求，不落 Trace。
    const whamUpstreamBaseUrl = (configuredUpstreamBaseUrl || CODEX_CHATGPT_OAUTH_TARGET).replace(/\/codex$/i, '');
    routes.push({
      source: 'codex-cli',
      path: '/backend-api/wham',
      apiType: 'responses',
      upstreamBaseUrl: whamUpstreamBaseUrl,
      stripPathPrefix: '/backend-api',
      blockedBearerToken: settings.compatible.bearerToken,
      replacementBearerToken,
      capture: false
    });
  }
  return routes;
}

function officialCodexUpstream(authMode: CodexAuthMode | undefined): string {
  return authMode === 'api-key' ? `${CODEX_DEFAULT_TARGET}/v1` : CODEX_CHATGPT_OAUTH_PROVIDER_TARGET;
}

function officialGatewayUpstreamFromSnapshot(snapshot: CodexConfigSnapshot): string {
  if (isLoopbackUrl(snapshot.activeBaseUrl)) return officialCodexUpstream(snapshot.authMode);
  const baseUrl = snapshot.activeBaseUrl.replace(/\/+$/, '');
  if (snapshot.authMode !== 'chatgpt' || /\/codex$/i.test(baseUrl)) return baseUrl;
  return `${baseUrl}/codex`;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function chatGptConnectionIssueText(issue: ChatGptConnectionIssue): string {
  return issue === 'failed'
    ? 'ChatGPT 配置未能接入 Trace。请检查文件权限或其他软件的配置修改，重试后再重新打开 ChatGPT。'
    : 'ChatGPT 当前连接与 Trace 存在冲突。请重新打开 Deck 并开启 Trace；若仍无法接入，到“模型配置”重新选择服务后重启 ChatGPT。';
}

function sameHttpEndpoint(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  try {
    const left = new URL(actual);
    const right = new URL(expected);
    const normalizePath = (value: string): string => value.replace(/\/+$/, '') || '/';
    return left.protocol.toLowerCase() === right.protocol.toLowerCase()
      && left.hostname.toLowerCase() === right.hostname.toLowerCase()
      && effectivePort(left) === effectivePort(right)
      && normalizePath(left.pathname) === normalizePath(right.pathname);
  } catch {
    return actual.replace(/\/+$/, '') === expected.replace(/\/+$/, '');
  }
}

function codexConfigRouteChanged(
  previous: CodexConfigSnapshot,
  next: CodexConfigSnapshot
): boolean {
  return previous.activeProvider !== next.activeProvider
    || !sameHttpEndpoint(previous.activeBaseUrl, next.activeBaseUrl)
    || (previous.mode === 'official' ? previous.officialModel : previous.compatible.model)
      !== (next.mode === 'official' ? next.officialModel : next.compatible.model);
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '';
}

function costOfUsageByModel(
  usageByModel: Record<string, TapModelUsage> | undefined
): { cost: number; complete: boolean } {
  // No per-model usage at all (count_tokens-only sessions, or traces with no
  // model attribution) contributes nothing to the total and must not mark the
  // aggregate as partially priced — an empty object already returns complete.
  if (!usageByModel) return { cost: 0, complete: true };
  let sum = 0;
  let complete = true;
  for (const [model, usage] of Object.entries(usageByModel)) {
    // 请求名优先、上游回报名兜底：同一次请求的两个名字都是事实，不是近似匹配。
    const price = findModelPriceForUsage(model, usage.servedModel);
    if (!price) {
      complete = false;
      continue;
    }
    const estimated = estimateCostUsd(usage, price);
    if (estimated === undefined) {
      complete = false;
      continue;
    }
    sum += estimated;
  }
  return { cost: sum, complete };
}

function localDateKey(date: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function codexHistoryRetryDelayMs(attempt: number): number {
  return Math.min(10 * 60_000, 30_000 * (2 ** Math.min(Math.max(0, attempt), 5)));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function missingManagedCodexHistoryProviders(
  referenced: ReadonlySet<string>,
  configured: readonly string[]
): string[] {
  const available = new Set(configured);
  return [...referenced].filter(provider => !available.has(provider)).sort();
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export const __test = {
  buildClientRoutes,
  buildCodexOfficialGatewayRoutes,
  buildCodexGatewayRoutes,
  buildClaudeDesktopRoutes,
  claudeDesktopDirectGateway,
  officialCodexUpstream,
  codexHistoryRetryDelayMs,
  missingManagedCodexHistoryProviders
};

function providerIdentityId(provider: ProviderConnection): string {
  const revision = createHash('sha256').update([provider.baseUrl, provider.bearerToken, provider.adapter, provider.providerPreset, provider.codexApiFormat].join('\0')).digest('hex').slice(0, 16);
  return `${provider.id}_${revision}`;
}

function codexProviderToml(
  provider: ProviderConnection | undefined,
  unified = false
): {
  providerId?: string;
  providerName?: string;
  publishModelCatalog?: boolean;
} {
  if (!provider) return {};
  return {
    providerId: providerCodexId(provider, unified),
    providerName: provider.displayName,
    publishModelCatalog: true
  };
}

function configuredProviderModel(provider: ProviderConnection): ModelCatalogEntry {
  const protocol = provider.codexApiFormat;
  return {
    id: provider.codexModel,
    vendor: '已配置',
    catalogEndpoints: [],
    protocols: [
      protocol === 'anthropic-messages'
        ? 'anthropic-messages'
        : protocol === 'chat-completions'
          ? 'chat-completions'
          : 'openai-responses'
    ],
    clients: protocol === 'anthropic-messages'
      ? ['claude', 'codex']
      : protocol === 'chat-completions'
        ? ['codex']
        : ['codex']
  };
}

function providerUpstreamKind(settings: XwXDeckSettings): 'compatible' | `provider:${string}` {
  const provider = selectedProvider(settings, 'codex');
  return provider ? `provider:${providerIdentityId(provider)}` : 'compatible';
}

/**
 * Every `model_provider` value that XwX Deck itself may have written: the stable
 * and legacy Deck identities, the built-in `openai` used for official mode, the
 * id derived from each configured connection. `xwx_deck` covers
 * the unified-history form, so only the per-connection form is added here.
 */
function deckOwnedCodexProviderIds(settings: XwXDeckSettings): readonly string[] {
  const ids = new Set<string>([
    CODEX_STABLE_PROVIDER,
    'openai'
  ]);
  for (const connection of settings.providers?.connections ?? []) {
    ids.add(providerCodexId(connection));
  }
  return [...ids].filter(id => id.trim().length > 0);
}

/** Zero means unlimited, matching `GatewayTraceRetention`. */
function expectedTraceStorageBytes(
  settings: Pick<XwXDeckSettings, 'traceAutoCleanup' | 'traceWarningGB'>
): number {
  return settings.traceAutoCleanup && settings.traceWarningGB > 0
    ? settings.traceWarningGB * 1024 ** 3
    : 0;
}

/**
 * Compare the policy the helper reports back against the persisted settings,
 * and describe the difference. Returns undefined when they agree.
 *
 * `usageOnly` is optional on the wire: the helper only emits it when it is true
 * (normalizeTraceRetention in gatewayHelper.ts) and JSON drops undefined, so the
 * flag must be coerced before comparing. Testing the raw value against a boolean
 * reported a mismatch for every non usage-only policy, which rolled back each
 * storage change and left the auto-cleanup toggle permanently off. Both the
 * policy write and the repair center share this check so the two copies cannot
 * drift apart again.
 */
function traceRetentionMismatch(
  active: GatewayTraceRetention | undefined,
  settings: Pick<XwXDeckSettings, 'traceAutoCleanup' | 'traceWarningGB'>
): string | undefined {
  if (!active) return '后台 Gateway 未返回 Trace 保留策略。';
  const expectedStorageBytes = expectedTraceStorageBytes(settings);
  const expectedUsageOnly = settings.traceWarningGB === 0;
  const activeUsageOnly = active.usageOnly === true;
  if (active.maxSessions === 0 && active.maxStorageBytes === expectedStorageBytes
    && activeUsageOnly === expectedUsageOnly) {
    return undefined;
  }
  const describe = (sessions: number, bytes: number, usageOnly: boolean): string =>
    `${sessions} Sessions / ${bytes} bytes${usageOnly ? ' / 仅用量' : ''}`;
  return '后台 Gateway 清理策略不一致'
    + `（实际 ${describe(active.maxSessions, active.maxStorageBytes, activeUsageOnly)}`
    + `，期望 ${describe(0, expectedStorageBytes, expectedUsageOnly)}）。`;
}

function normalizeProviderApiRoot(value: string): string {
  const url = new URL(value.trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入不含认证、查询参数的 HTTP(S) API 地址。');
  url.pathname = url.pathname.replace(/\/(?:responses(?:\/compact)?|chat\/completions|messages|models)\/?$/i, '').replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}

function restoreConflictNotice(
  results: readonly { readonly client: 'claude' | 'codex'; readonly conflicts: readonly string[] }[]
): string | undefined {
  const conflicts = results.flatMap(result => result.conflicts.map(conflict => ({ client: result.client, conflict })));
  if (conflicts.length === 0) return undefined;
  return `已保留 Trace 期间的外部配置修改：${conflicts.map(item => `${item.client === 'claude' ? 'Claude' : 'ChatGPT'} ${item.conflict}`).join('；')}`;
}
