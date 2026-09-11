import { parse as parseToml } from 'smol-toml';
import { ClientFallbackStore, type ClientFallbackState } from '../trace/clientFallbackStore';
import { restoreCodexPreferredDirectConfiguration } from './codexDirectConfiguration';
import { createHash, randomUUID } from 'crypto';
import { supportsProviderClient, type ProviderConnection, type ProviderClient, type ProviderInput, type ProviderSnapshot } from '../../shared/providers';
import { selectedProvider } from './settings';
import { fetchProviderCatalog } from './providerCatalog';
import { readCodexOfficialModelCatalog } from './codexOfficialModelCatalog';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { EventEmitter } from 'events';
import { ClientBackupStore } from '../trace/clientBackupStore';
import {
  baseUrlHasV1Suffix,
  CODEX_CHATGPT_OAUTH_PROVIDER_TARGET,
  CODEX_DEFAULT_TARGET,
  detectClaudeUpstream,
  isXwXManagedProvider,
  isLoopbackUrl,
  resolveClientPaths
} from '../trace/clientConfig';
import { ClientConfigOrchestrator, ClientTakeoverResult } from '../trace/clientConfigOrchestrator';
import { ClientConfigWriter, ClientRestoreResult } from '../trace/clientConfigWriter';
import { ClaudeConfigManager, ClaudeCompatibleServiceSnapshot } from '../trace/claudeConfigManager';
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
import { CodexModelCatalogManager } from '../trace/codexModelCatalogManager';
import { CodexThreadTitleReader } from '../trace/codexThreadTitles';
import { CodexConversationDoctor } from './codexConversationDoctor';
import { CodexConversationWorkerClient } from './codexConversationWorkerClient';
import type {
  CodexConversationDetailRequest,
  CodexConversationHealthReport,
  CodexConversationHealthRow,
  CodexConversationPageRequest,
  CodexConversationPageResponse
} from '../../shared/codexConversationHealth';
import { TapProxy } from '../trace/tapProxy';
import { GatewayProcessClient } from '../trace/gatewayProcessClient';
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
import {
  applyTraceIndexRepair,
  inspectTraceIndexRepair,
  type AppliedTraceIndexRepair,
  type TraceIndexRepairPlan
} from '../trace/traceIndexRepair';
import { TapClientRoute, TapModelUsage, TapSessionTracePage } from '../trace/types';
import { estimateCostUsd, findModelPriceForUsage } from '../trace/pricing';
import { renderTapViewerHtml, TapViewerState } from '../trace/webview/viewerHtml';
import { log, setLogDirectory } from '../shared/logger';
import {
  detectProviderPreset,
  normalizeProviderPreset,
  providerProfile
} from '../../shared/providerProfiles';
import { parsePort } from '../shared/url';
import type { XwXDeckUpdateState } from '../update/xwxDeckUpdater';
import {
  fetchCompatibleServiceModelCatalog,
  ModelCatalogEntry,
  readCompatibleServiceModelCatalogCache,
  writeCompatibleServiceModelCatalogCache
} from './modelCatalog';
import {
  CodexProtocol,
  isKnownNonConversationalModel,
  isOfficialCodexModelId,
  resolveCatalogCodexProtocol,
  resolveCompatibleServiceCodexProtocol
} from './codexProtocolPolicy';
import { findOfficialModelRecord } from './officialModelRegistry';
import { findBuiltInModelCapability } from './builtInModelCapabilityRegistry';
import { codexContextVariants } from '../../shared/codexContextVariants';
import {
  ClaudeModelSettings,
  XwXDeckSettings,
  XwXDeckSettingsStore,
  CompatibleServiceSettings,
  AppTheme,
  TraceAppearanceSettings
} from './settings';
import type { StartupSettingsSnapshot } from './startup';
import { isChatGptRunning } from './chatGptLifecycle';

type Role = 'owner' | 'follower';
export type ClientId = 'claude-cli' | 'codex-cli';
type ChatGptConnectionIssue = 'failed' | 'unsupported';

export interface XwXDeckRuntimeState {
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
  readonly externalTracePort?: number;
  readonly sessions: number;
  readonly traces: number;
  readonly storageText: string;
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
  /** Resolve the OS proxy for each upstream before publishing a client route. */
  readonly resolveUpstreamProxyUrl?: (url: string) => Promise<string | undefined>;
}

export interface XwXDeckShutdownOptions {
  /** User explicitly accepted interrupting in-flight model requests. */
  readonly force?: boolean;
  /** Per-attempt drain budget; the interactive runtime may prompt again. */
  readonly drainTimeoutMs?: number;
  /** ChatGPT may still own live rollout files; defer the provider repair. */
  readonly skipCodexHistoryRepair?: boolean;
}

export interface XwXDeckForceExitResult {
  readonly helperStopped: boolean;
  readonly dependentClients: readonly ClientId[];
}

export class ShutdownDrainTimeoutError extends Error {
  constructor(
    readonly activeRequests: number,
    readonly pendingContinuations: number
  ) {
    const activity = activeRequests > 0
      ? `仍有 ${activeRequests} 个 AI 请求通过 XwX Deck 传输。`
      : 'AI 对话仍在等待工具调用继续。';
    super(`${activity}为避免 ChatGPT 或 Claude 出现 502，本次关闭代理已取消。`);
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

export class XwXDeckController {
  private readonly events = new EventEmitter();
  private traceStore!: TraceStore;
  private proxy!: TraceProxy;
  private readonly settingsStore: XwXDeckSettingsStore;
  private readonly clientFallbackStore: ClientFallbackStore;
  private readonly clientBackup: ClientBackupStore;
  private readonly clientOrchestrator: ClientConfigOrchestrator;
  private readonly claudeConfig: ClaudeConfigManager;
  private readonly codexConfig: CodexConfigManager;
  private readonly codexHistory: CodexHistoryManager;
  private readonly codexLocalProxy: CodexLocalProxyCoordinator;
  private readonly codexOfficialAuth: CodexOfficialAuthManager;
  private readonly codexCatalog: CodexModelCatalogManager;
  private readonly codexThreadTitles: CodexThreadTitleReader;
  private readonly conversationWorker = new CodexConversationWorkerClient();
  private compatibleServiceCatalog: readonly ModelCatalogEntry[] = [];
  private compatibleServiceCatalogRefresh: {
    readonly connection: string;
    readonly forceCapabilityRefresh: boolean;
    readonly promise: Promise<readonly ModelCatalogEntry[]>;
  } | undefined;
  private compatibleServiceCatalogGeneration = 0;
  private compatibleServiceCatalogRefreshedAt = 0;
  private codexGatewayEnabled = false;
  private codexProviderIdentity: 'official' | 'compatible' | `provider:${string}` | undefined;
  private codexGatewayMode: 'official' | 'compatible' | undefined;
  private codexOfficialAuthMode: CodexAuthMode | undefined;
  private codexOfficialBearerToken: string | undefined;
  private codexOfficialUpstreamBaseUrl: string | undefined;
  private settings: XwXDeckSettings | undefined;
  private active = false;
  private readonly clientsSeenSinceEnable = new Set<ClientId>();
  private startupPhase: StartupPhase = 'idle';
  private role: Role | undefined;
  private followerPort: number | undefined;
  private lockWatcher: fs.FSWatcher | undefined;
  private clientTakeovers: ClientTakeoverResult[] = [];
  private clientFallbacks: ClientTakeoverResult[] = [];
  private lastProxyRouteSummary = '';
  private lastError: string | undefined;
  private chatGptConnectionIssue: ChatGptConnectionIssue | undefined;
  private chatGptRestartRecommended = false;
  private codexHistoryTimer: NodeJS.Timeout | undefined;
  private codexHistoryDeferredOperation: string | undefined;
  private codexHistoryDeferredAttempts = 0;
  private readonly clientOperations: Record<ClientId, Promise<void>> = {
    'claude-cli': Promise.resolve(),
    'codex-cli': Promise.resolve()
  };
  private mutationOperation: Promise<void> = Promise.resolve();
  private shutdownRequested = false;

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
    this.clientFallbackStore = new ClientFallbackStore(userDataDir);
    this.clientBackup = new ClientBackupStore(userDataDir);
    this.clientOrchestrator = new ClientConfigOrchestrator(
      this.clientBackup,
      new ClientConfigWriter({ backup: this.clientBackup }),
      clientPaths
    );
    this.claudeConfig = new ClaudeConfigManager(userDataDir, clientPaths);
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
    return this.serializeMutation(() => this.startUnlocked());
  }

  private async startUnlocked(): Promise<void> {
    this.settings = await this.settingsStore.read();
    const settingsProblem = this.settingsStore.readProblem();
    if (settingsProblem) { this.lastError = settingsProblem.message; this.setStartupPhase('degraded'); this.fireChange(); return; }
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
    await this.clientOrchestrator.recoverOnStartup(port => probeTapPort(port));
    const fallbacks = await this.readLiveClientFallbackState();
    const startupCodex = await this.codexConfig.read().catch(() => undefined);
    const startupGatewayPort = startupCodex && isLoopbackUrl(startupCodex.activeBaseUrl)
      ? parsePort(startupCodex.activeBaseUrl)
      : undefined;
    const managedGatewayWasLive = startupGatewayPort !== undefined
      && await probeTapPort(startupGatewayPort).catch(() => false);
    const needsProxy = !this.proxy.background
      || !this.settings.gatewayPaused && (
        this.settings.tracingEnabled
        || !!fallbacks
        || this.settings.codexPreferredMode === 'compatible'
        || startupCodex?.mode === 'compatible' && isXwXManagedProvider(startupCodex.activeProvider)
        || !!startupCodex?.activeBaseUrl && isLoopbackUrl(startupCodex.activeBaseUrl)
      );
    const chatGptWasRunningBeforeGateway = needsProxy
      ? await this.chatGptRunningForRestartNotice()
      : false;
    if (needsProxy) {
      await this.startProxyUnlocked('startup');
      this.setStartupPhase('proxy-listening');
    }
    if (!this.settings.tracingEnabled) {
      const restored = await this.codexLocalProxy.restore();
      if (restored.conflict) log.warn(`[xwxdeck] ChatGPT connection recovery preserved external change: ${restored.conflict}`);
    }
    this.codexGatewayEnabled = false;
    this.codexGatewayMode = undefined;
    this.codexOfficialAuthMode = undefined;
    this.codexOfficialBearerToken = undefined;
    this.codexOfficialUpstreamBaseUrl = undefined;
    if (!this.settings.gatewayPaused) { await this.restoreCodexGatewayOnStartup(); await this.restoreClientFallbacksOnStartup(fallbacks); }
    await this.refreshProxyRoutes();
    await this.proxy.synchronize?.();
    if (this.proxy.background && !this.settings.tracingEnabled && !this.codexGatewayEnabled && !this.clientFallbacks.length && this.proxy.isListening()) {
      await this.proxy.stop();
      this.stopLockWatcher();
      this.role = undefined;
      this.followerPort = undefined;
      this.setStartupPhase('idle');
    }
    if (this.codexGatewayEnabled) this.setStartupPhase('routes-ready');
    try {
      const currentCodex = await this.codexConfig.read();
      // A disabled preservation switch deliberately leaves the 兼容服务 key in
      // auth.json while 兼容服务 remains selected, including across restarts.
      if (this.settings.codexEnhancements.preserveOfficialLogin || currentCodex.mode === 'official') {
        await this.codexOfficialAuth.restoreOfficialLogin();
      }
    } catch (error) {
      this.lastError = (error as Error).message;
      log.warn(`[xwxdeck] Codex official login recovery skipped: ${this.lastError}`);
    }
    try {
      await this.ensureCodexEnhancementConfig();
    } catch (error) {
      log.warn(`[xwxdeck] Codex enhancement config recovery skipped: ${(error as Error).message}`);
    }
    if (this.settings.tracingEnabled && !this.settings.gatewayPaused) {
      try {
        await this.enableUnlocked('startup-restore');
      } catch (err) {
        this.lastError = (err as Error).message;
        log.warn(`[xwxdeck] startup restore skipped: ${this.lastError}`);
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
      await this.syncCodexCatalogIfCompatibleServiceActive(this.compatibleServiceCatalog).catch(error => {
        log.warn(`[xwxdeck] cached 兼容服务 catalog repair skipped: ${(error as Error).message}`);
      });
    }
    this.fireChange();
    this.scheduleCodexHistoryWork('startup');
    this.scheduleCompatibleServiceModelRefresh('startup');
  }

  async toggle(): Promise<void> {
    return this.serializeMutation(async () => {
      if (this.active) await this.disableUnlocked();
      else await this.enableUnlocked('toggle');
    });
  }

  async enable(reason: string): Promise<void> {
    return this.serializeMutation(() => this.enableUnlocked(reason));
  }

  private async enableUnlocked(reason: string): Promise<void> {
    const settings = this.settings ?? await this.settingsStore.read();
    const snapshot: EnableRollbackSnapshot = {
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
    try {
      await this.enableTransactionUnlocked(reason);
    } catch (error) {
      await this.rollbackFailedEnable(snapshot, error);
      throw error;
    }
  }

  private async enableTransactionUnlocked(reason: string): Promise<void> {
    let currentSettings = this.settings ?? await this.settingsStore.read();
    const chatGptWasRunningBeforeTakeover = currentSettings.clientEnabled.codex
      && !this.codexGatewayEnabled
      && await this.chatGptRunningForRestartNotice();
    if (currentSettings.gatewayPaused) {
      currentSettings = await this.settingsStore.update({ gatewayPaused: false });
      this.settings = currentSettings;
      log(`[xwxdeck] gatewayPaused cleared: Trace enabled (${reason})`);
    }
    let coordinatedExternalPort: number | undefined;
    if (currentSettings.clientEnabled.codex && !this.codexGatewayEnabled) {
      coordinatedExternalPort = await this.prepareChatGptConnection();
      try {
        if (!this.chatGptConnectionIssue) await this.ensureCodexStableProvider(true);
      } catch (error) {
        await this.codexLocalProxy.restore();
        throw error;
      }
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
      log(`[xwxdeck] preflight ${name}: ${summary}${conflicts}`);
    }
    await this.startProxyUnlocked(`enable:${reason}`);
    const external = await this.findExternalTracePort(coordinatedExternalPort);
    if (external !== undefined) {
      const message = `端口 ${external} 上已有另一个 Trace/XwX Deck 代理在运行。关闭它后再启动 Trace。`;
      this.lastError = message;
      await this.codexLocalProxy.restore();
      this.fireChange();
      throw new Error(message);
    }
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
      await this.codexLocalProxy.restore().catch(() => undefined);
      this.clientTakeovers = previousTakeovers;
      await this.refreshProxyRoutesBestEffort('Trace enable rollback');
      throw error;
    }
    this.fireChange();
    this.scheduleCodexHistoryWork(`trace enabled:${reason}`);
  }

  private async rollbackFailedEnable(snapshot: EnableRollbackSnapshot, error: unknown): Promise<void> {
    this.active = snapshot.active;
    this.proxy.setRecordingEnabled(snapshot.recording);
    this.clientTakeovers = snapshot.clientTakeovers.map(takeover => ({ ...takeover }));
    this.clientFallbacks = snapshot.clientFallbacks.map(fallback => ({ ...fallback }));
    await this.persistClientFallbacks();
    this.clientsSeenSinceEnable.clear();
    for (const client of snapshot.clientsSeen) this.clientsSeenSinceEnable.add(client);
    this.chatGptConnectionIssue = snapshot.chatGptConnectionIssue;
    this.chatGptRestartRecommended = snapshot.chatGptRestartRecommended;
    this.lastError = snapshot.lastError;
    this.setStartupPhase(snapshot.startupPhase);

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
      log.warn(`[xwxdeck] failed to persist Trace enable rollback: ${(settingsError as Error).message}`);
    }

    const newlyStartedOwner = !snapshot.listening
      && this.role === 'owner'
      && this.proxy.isListening()
      && !this.hasManagedBackgroundDataPlane();
    if (newlyStartedOwner) {
      this.stopLockWatcher();
      await deleteLock(this.traceStore.rootPath()).catch(() => undefined);
      await this.proxy.stop().catch(stopError => {
        log.warn(`[xwxdeck] failed to stop the rolled-back Trace helper: ${(stopError as Error).message}`);
      });
      this.role = snapshot.role;
      this.followerPort = snapshot.followerPort;
    } else if (this.role === 'owner') {
      await this.refreshProxyRoutesBestEffort('Trace enable rollback state');
      await this.proxy.synchronize?.().catch(syncError => {
        log.warn(`[xwxdeck] failed to synchronize Trace enable rollback: ${(syncError as Error).message}`);
      });
    }
    log.warn(`[xwxdeck] Trace enable rolled back completely: ${(error as Error).message}`);
    this.fireChange();
  }

  /** True only while the helper is forwarding a live request or retaining a
   * tool-call continuation. A running ChatGPT process by itself is idle. */
  async disableBreaksCodex(): Promise<boolean> {
    if (!this.active) return false;
    const activity = await this.shutdownActivity();
    return activity.activeRequests > 0 || activity.pendingContinuations > 0;
  }

  async disable(): Promise<void> {
    return this.serializeMutation(() => this.disableUnlocked());
  }

  private async disableUnlocked(): Promise<void> {
    if (this.codexHistoryTimer) clearTimeout(this.codexHistoryTimer);
    this.codexHistoryTimer = undefined;
    if (this.role === 'owner') {
      const localBaseUrl = this.localBaseUrl();
      const codexTakeover = this.clientTakeovers.find(result => (
        result.client === 'codex-cli' && result.status === 'taken'
      ));
      let retainOfficialGateway = this.proxy.background
        && !!this.localBaseUrl()
        && this.settings?.clientEnabled.codex !== false
        && this.codexGatewayEnabled
        && this.codexGatewayMode === 'official';
      let officialConfig: CodexConfigSnapshot | undefined;
      if (!retainOfficialGateway && codexTakeover) {
        officialConfig = await this.readUnderlyingCodexConfig().catch(() => undefined);
        retainOfficialGateway = officialConfig?.mode === 'official';
      }
      if (retainOfficialGateway && await this.codexLocalProxy.hasPendingOriginalRestore()) {
        // Trace temporarily yielded a different healthy XwX endpoint. Restore
        // that owner instead of pinning this helper as the cached fallback.
        retainOfficialGateway = false;
      }
      const retainedTakeovers = this.clientTakeovers.filter(takeover => (
        takeover.status === 'taken'
        && !(retainOfficialGateway && takeover.client === 'codex-cli')
        && !(this.codexGatewayEnabled && takeover.client === 'codex-cli')
      ));
      const nextFallbacks = mergeClientFallbacks(this.clientFallbacks, retainedTakeovers)
        .filter(fallback => !(retainOfficialGateway && fallback.client === 'codex-cli'))
        .filter(fallback => !(this.codexGatewayEnabled && fallback.client === 'codex-cli'));
      if (localBaseUrl) {
        await this.clientFallbackStore.write(localBaseUrl, nextFallbacks);
      } else if (nextFallbacks.length > 0) {
        throw new Error('本地 Gateway 地址不可用，已取消停止 Trace。');
      } else {
        await this.clientFallbackStore.clear();
      }
      const restored = retainOfficialGateway
        ? [await this.clientOrchestrator.restoreOne('claude-cli')].filter((result): result is ClientRestoreResult => !!result)
        : await this.clientOrchestrator.restoreAll();
      this.lastError = restoreConflictNotice(restored);
      const connection = await this.codexLocalProxy.restore();
      if (connection.conflict) this.lastError = [this.lastError, connection.conflict].filter(Boolean).join('；');
      this.clientTakeovers = [];
      this.clientFallbacks = nextFallbacks;
      if (retainOfficialGateway) {
        officialConfig ??= await this.readUnderlyingCodexConfig().catch(() => undefined);
        this.codexGatewayEnabled = true;
        this.codexGatewayMode = 'official';
        this.codexOfficialAuthMode = officialConfig?.authMode;
        this.codexOfficialBearerToken = await this.codexOfficialAuth.readCurrentBearerToken();
        this.codexOfficialUpstreamBaseUrl = officialConfig
          ? officialGatewayUpstreamFromSnapshot(officialConfig)
          : await this.codexConfig.readOfficialBaseUrl();
      }
    }
    this.settings = await this.settingsStore.update({ tracingEnabled: false });
    this.active = false;
    this.clientsSeenSinceEnable.clear();
    this.chatGptConnectionIssue = undefined;
    if (!this.codexGatewayEnabled) this.chatGptRestartRecommended = false;
    this.proxy.setRecordingEnabled(false);
    if (this.role === 'owner') {
      await this.refreshProxyRoutes();
      await this.proxy.synchronize?.();
    }
    if (this.settings.codexEnhancements.pendingHistoryRestore) {
      await this.restorePendingCodexHistory('trace disabled');
    } else if (this.settings.codexEnhancements.unifySessionHistory) {
      await this.mergeCodexHistoryBestEffort('trace disabled');
    }
    this.setStartupPhase('ready');
    this.fireChange();
  }

  async shutdown(options: XwXDeckShutdownOptions = {}): Promise<void> {
    return this.serializeLifecycleMutation(() => this.shutdownUnlocked(options));
  }

  async forceExit(): Promise<XwXDeckForceExitResult> {
    return this.serializeLifecycleMutation(async () => {
      this.shutdownRequested = true;
      if (this.codexHistoryTimer) clearTimeout(this.codexHistoryTimer);
      this.codexHistoryTimer = undefined;
      this.active = false;
      this.clientsSeenSinceEnable.clear();
      this.proxy.setRecordingEnabled(false);
      this.stopLockWatcher();
      const localBaseUrl = this.localBaseUrl();
      if (this.role === 'owner' && this.proxy.isListening() && localBaseUrl) {
        await withTimeout(
          this.restoreClientConnectionsBeforeForcedStop(),
          4_000,
          '强制退出前恢复客户端配置超时'
        );
      }
      const dependentClients = localBaseUrl
        ? this.clientOrchestrator.clientsPointingAt(localBaseUrl)
        : [];
      if (dependentClients.length > 0) throw new Error(`客户端仍依赖本地 Gateway，已取消强制退出：${dependentClients.join('、')}`);
      await deleteLock(this.traceStore.rootPath()).catch(() => undefined);
      await this.proxy.forceStop();
      this.clientFallbacks = [];
      await this.clientFallbackStore.clear();
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
    });
  }

  /**
   * Close the mutation gate only after every provider/Trace transaction already
   * queued by the UI has finished. Later mutations fail instead of slipping
   * between the ChatGPT exit check and the actual helper shutdown.
   */
  async beginShutdown(): Promise<void> {
    return this.serializeLifecycleMutation(async () => {
      this.shutdownRequested = true;
    });
  }

  /** Re-open the mutation gate when an interactive shutdown is cancelled. */
  async cancelShutdown(): Promise<void> {
    return this.serializeLifecycleMutation(async () => {
      this.shutdownRequested = false;
    });
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
   * The manager is only the control plane. When the independently owned data
   * plane is serving 兼容服务 or Trace, quitting the manager must not restore
   * client configuration or close model connections.
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

  async backgroundGatewayAction(): Promise<'close' | 'open' | undefined> {
    // A viewer-only helper is an implementation detail of the Dashboard, not
    // a ChatGPT/Claude proxy. Do not offer a misleading "关闭代理" action for
    // it; closing the manager safely stops that helper instead.
    if (this.backgroundGatewayActive()) {
      return this.hasManagedBackgroundDataPlane() ? 'close' : undefined;
    }
    const settings = this.settings ?? await this.settingsStore.read();
    if (!settings.gatewayPaused) return undefined;
    if (settings.tracingEnabled) return 'open';
    if (settings.codexPreferredMode === 'compatible' && selectedProvider(settings, 'codex')) return 'open';
    const services = await this.readModelServices();
    // Claude 兼容服务 writes its upstream directly and does not need this
    // Gateway. Only ChatGPT 兼容服务 or a paused Trace intent can restore it.
    return services.codex ? 'open' : undefined;
  }

  async startBackgroundGateway(): Promise<void> {
    return this.serializeMutation(async () => {
      if (!this.proxy.background || this.proxy.isListening()) return;
      this.settings = await this.settingsStore.update({ gatewayPaused: false });
      log('[xwxdeck] gatewayPaused cleared: manual Gateway start');
      await this.startProxyUnlocked('manual start');
      await this.restoreCodexGatewayOnStartup();
      await this.refreshProxyRoutes();
      await this.proxy.synchronize?.();
      this.setStartupPhase(this.codexGatewayEnabled ? 'routes-ready' : 'ready');
      this.fireChange();
    });
  }

  async setBackgroundGatewayPaused(paused: boolean, reason: string): Promise<void> {
    return this.serializeMutation(async () => {
      const previous = this.settings ?? await this.settingsStore.read();
      this.settings = await this.settingsStore.update({ gatewayPaused: paused });
      if (previous.gatewayPaused && !paused) {
        log(`[xwxdeck] gatewayPaused cleared: ${reason}`);
      }
      this.fireChange();
    });
  }

  async backgroundGatewayPaused(): Promise<boolean> {
    return (this.settings ?? await this.settingsStore.read()).gatewayPaused;
  }

  private hasManagedBackgroundDataPlane(): boolean {
    if (this.codexGatewayEnabled) return true;
    return [...this.clientTakeovers, ...this.clientFallbacks].some(takeover => takeover.status === 'taken');
  }

  requiresCodexClientExitBeforeShutdown(): boolean {
    if (this.codexGatewayEnabled) return true;
    // Explicitly closing the proxy also tears down a temporary official Trace
    // overlay. Even with no request currently in flight, a running ChatGPT
    // process may keep the localhost provider cached and issue its next turn
    // there. Ordinary XwX Deck quit never reaches this guard while the helper
    // is active (it detaches the manager above); only the separate "关闭代理"
    // flow asks ChatGPT to exit before restoring config and stopping the port.
    return [...this.clientTakeovers, ...this.clientFallbacks].some(takeover => (
      takeover.client === 'codex-cli' && takeover.status === 'taken'
    ));
  }

  requiresClaudeClientExitBeforeShutdown(): boolean {
    return [...this.clientTakeovers, ...this.clientFallbacks].some(item => item.client === 'claude-cli' && item.status === 'taken');
  }

  async shutdownActivity(): Promise<{ activeRequests: number; pendingContinuations: number }> {
    await this.proxy.refreshShutdownActivity();
    return this.shutdownActivitySnapshot();
  }

  shutdownActivitySnapshot(): { activeRequests: number; pendingContinuations: number } {
    return {
      activeRequests: this.proxy.activeRequestCount(),
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
        log(`[xwxdeck] restored ${restored.changedFiles} Codex history file(s), recovered ${restored.restoredItems} official opaque item(s); backup=${restored.backupRoot}`);
      }
    });
  }

  private async shutdownUnlocked(options: XwXDeckShutdownOptions = {}): Promise<void> {
    let proxyPreparedForShutdown = false;
    if (this.role === 'owner') {
      const activeRequests = this.proxy.activeRequestCount();
      if (activeRequests > 0) {
        log(`[xwxdeck] waiting for ${activeRequests} active proxied request(s) before shutdown`);
      }
      if (options.force) {
        await this.proxy.forcePrepareForShutdown();
        proxyPreparedForShutdown = true;
      } else {
        proxyPreparedForShutdown = await this.proxy.prepareForShutdown({
          timeoutMs: options.drainTimeoutMs ?? this.options.shutdownDrainTimeoutMs,
          quietPeriodMs: this.options.shutdownQuietPeriodMs
        });
      }
      if (!proxyPreparedForShutdown) {
        throw new ShutdownDrainTimeoutError(
          this.proxy.activeRequestCount(),
          this.proxy.pendingContinuationCount()
        );
      }
    }
    try {
    if (this.role === 'owner') {
      const restored = await this.clientOrchestrator.restoreAll();
      this.lastError = restoreConflictNotice(restored);
      const connection = await this.codexLocalProxy.restore();
      if (connection.conflict) this.lastError = [this.lastError, connection.conflict].filter(Boolean).join('；');
    }
    if (this.codexGatewayEnabled && !options.skipCodexHistoryRepair) await this.proxy.repairCodexHistoryForProvider(this.codexGatewayMode ?? 'official');
    else if (options.skipCodexHistoryRepair) log('[xwxdeck] deferred ChatGPT provider history repair because ChatGPT may still be running');
    const direct = await restoreCodexPreferredDirectConfiguration(this.userDataDir);
    if (direct.conflicts.length) this.lastError = [this.lastError, ...direct.conflicts].filter(Boolean).join('；');
    await this.options.beforeShutdownConfigVerification?.();
    await this.assertCodexDetachedFromLocalProxy();
    const local = this.localBaseUrl();
    if (local && this.clientOrchestrator.clientsPointingAt(local).length) throw new Error('客户端仍依赖本地 Gateway，已保留代理和恢复记录。');

    if (this.codexHistoryTimer) clearTimeout(this.codexHistoryTimer);
    this.codexHistoryTimer = undefined;
    this.active = false;
    this.clientsSeenSinceEnable.clear();
    this.proxy.setRecordingEnabled(false);
    if (this.settings?.codexEnhancements.pendingHistoryRestore) {
      await this.restorePendingCodexHistory('shutdown');
    } else if (this.settings?.codexEnhancements.unifySessionHistory) {
      await this.mergeCodexHistoryBestEffort('shutdown');
    }
    if (this.codexGatewayEnabled) {
      this.codexGatewayEnabled = false;
      this.codexGatewayMode = undefined;
      this.codexOfficialAuthMode = undefined;
      this.codexOfficialBearerToken = undefined;
      this.codexOfficialUpstreamBaseUrl = undefined;
      await this.refreshProxyRoutes();
    }
    this.clientFallbacks = [];
    await this.clientFallbackStore.clear();
    this.stopLockWatcher();
    if (this.role === 'owner') {
      await deleteLock(this.traceStore.rootPath()).catch(() => undefined);
      await this.proxy.stop();
    }
    this.role = undefined;
    this.followerPort = undefined;
    this.setStartupPhase('idle');
    } catch (error) {
      if (proxyPreparedForShutdown) this.proxy.cancelPreparedShutdown();
      throw error;
    }
  }

  /**
   * Emergency exit skips history repair, but it must still restore every live
   * client connection before the local data plane is killed. The detached exit
   * guardian snapshots the same backups first and owns the final recovery if
   * this bounded in-process attempt cannot finish.
   */
  private async restoreClientConnectionsBeforeForcedStop(): Promise<void> {
    if (this.role !== 'owner') return;
    const restored = await this.clientOrchestrator.restoreAll();
    this.lastError = restoreConflictNotice(restored);
    const connection = await this.codexLocalProxy.restore();
    if (connection.conflict) {
      this.lastError = [this.lastError, connection.conflict].filter(Boolean).join('；');
    }
    const result = await restoreCodexPreferredDirectConfiguration(this.userDataDir);
    if (result.conflicts.length) this.lastError = [this.lastError, ...result.conflicts].filter(Boolean).join('；');
    await this.assertCodexDetachedFromLocalProxy();
    const local = this.localBaseUrl();
    if (local && this.clientOrchestrator.clientsPointingAt(local).length) throw new Error('客户端仍依赖本地 Gateway，已保留代理和恢复记录。');
  }

  private async assertCodexDetachedFromLocalProxy(): Promise<void> {
    const localPort = parsePort(this.localBaseUrl());
    if (localPort === undefined) return;
    const current = await this.codexConfig.read();
    const text = await fs.promises.readFile(current.configPath, 'utf8').catch(() => '');
    const parsed = parseToml(text) as any;
    const candidates = [current.activeBaseUrl, parsed.model_providers?.xwx_deck?.base_url];
    if (!candidates.some(url => typeof url === 'string' && isLoopbackUrl(url) && parsePort(url) === localPort)) return;
    throw new Error(
      'ChatGPT 配置仍指向本次即将关闭的 XwX Model Gateway。'
      + '为避免产生 502，本次关闭代理已取消。'
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
          if (result.status === 'taken') { this.clientFallbacks = this.clientFallbacks.filter(fallback => fallback.client !== client); await this.persistClientFallbacks(); }
          if (chatGptWasRunningBeforeTakeover && result.status === 'taken') {
            this.markChatGptRestartRecommended('ChatGPT Trace capture was enabled while ChatGPT was already running');
          }
          this.lastError = takeoverNotice([result]);
        } else if (!nextEnabled) {
          clientMutationStarted = true;
          const takeover = this.clientTakeovers.find(item => item.client === client && item.status === 'taken');
          if (takeover && baseUrl) { this.clientFallbacks = mergeClientFallbacks(this.clientFallbacks, [takeover]); await this.persistClientFallbacks(); }
          const restored = await this.clientOrchestrator.restoreOne(client);
          this.lastError = restoreConflictNotice(restored ? [restored] : []);
          if (client === 'codex-cli') {
            const connection = await this.codexLocalProxy.restore();
            if (connection.conflict) this.lastError = [this.lastError, connection.conflict].filter(Boolean).join('；');
            this.chatGptConnectionIssue = undefined;
            if (!this.codexGatewayEnabled) this.chatGptRestartRecommended = false;
          }
          this.clientTakeovers = this.clientTakeovers.filter(t => t.client !== client);
        }
        await this.refreshProxyRoutes();
        if (client === 'codex-cli' && !nextEnabled) {
          if (this.settings.codexEnhancements.pendingHistoryRestore) {
            await this.restorePendingCodexHistory('ChatGPT Trace takeover disabled');
          } else if (this.settings.codexEnhancements.unifySessionHistory) {
            await this.mergeCodexHistoryBestEffort('ChatGPT Trace takeover disabled');
          }
        }
      }
    } catch (error) {
      await this.rollbackFailedClientToggle(client, snapshot, clientMutationStarted, error);
      throw error;
    }
    this.fireChange();
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
      log.warn(`[xwxdeck] failed to persist client toggle rollback: ${(settingsError as Error).message}`);
    }
    this.clientTakeovers = snapshot.clientTakeovers.map(takeover => ({ ...takeover }));
    this.clientFallbacks = snapshot.clientFallbacks.map(fallback => ({ ...fallback }));
    await this.persistClientFallbacks();
    this.chatGptConnectionIssue = snapshot.chatGptConnectionIssue;
    this.chatGptRestartRecommended = snapshot.chatGptRestartRecommended;
    this.lastError = snapshot.lastError;

    if (clientMutationStarted && this.role === 'owner' && this.active) {
      await this.clientOrchestrator.restoreOne(client).catch(restoreError => {
        log.warn(`[xwxdeck] failed to clear partial client toggle state: ${(restoreError as Error).message}`);
      });
      if (client === 'codex-cli') {
        await this.codexLocalProxy.restore().catch(restoreError => {
          log.warn(`[xwxdeck] failed to clear partial ChatGPT proxy state: ${(restoreError as Error).message}`);
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
          log.error(`[xwxdeck] failed to reapply client after toggle rollback: ${(reapplyError as Error).message}`);
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
        log.warn(`[xwxdeck] failed to synchronize client toggle rollback: ${(syncError as Error).message}`);
      });
    }
    log.warn(`[xwxdeck] client toggle rolled back (${client}): ${(error as Error).message}`);
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
    return preferredWindow > 0
      ? { ...config, modelContextWindow: preferredWindow }
      : config;
  }

  async readCompatibleServiceConfig(client: ProviderClient = 'codex', expectedId?: string | null): Promise<CompatibleServiceSettings> {
    const settings = await this.settingsStore.read();
    if (expectedId !== undefined && expectedId !== settings.providers?.selected[client]) throw new Error('服务连接已变化，请刷新后重试。');
    return selectedProvider(settings, client) ?? { displayName: '兼容服务', providerPreset: 'auto', baseUrl: '', bearerToken: '', codexApiFormat: 'responses' };
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
      this.readUnderlyingClaudeService(),
      this.readUnderlyingCodexConfig()
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
        : registry.selected.claude
    } };
  }

  async saveProvider(input: ProviderInput): Promise<ProviderSnapshot> {
    return this.serializeMutation(async () => {
      if (!input || typeof input !== 'object') throw new Error('无效的连接配置。');
      const previous = await this.settingsStore.read();
      const registry = previous.providers!;
      const existing = input.id ? registry.connections.find(p => p.id === input.id) : undefined;
      if (input.id && !existing) throw new Error('连接已删除，请刷新后重试。');
      const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
      if (!displayName) throw new Error('请填写服务名称。');
      if (!['auto', 'responses', 'chat-completions', 'anthropic-messages'].includes(input.adapter)) throw new Error('不支持的服务类型。');
      const adapter = input.adapter;
      const baseUrl = adapter === 'auto' ? normalizeCompatibleServiceBaseUrl(input.baseUrl) : normalizeProviderApiRoot(input.baseUrl);
      const url = new URL(baseUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入不含认证、查询参数的 HTTP(S) API 地址。');
      const bearerToken = typeof input.bearerToken === 'string' ? input.bearerToken.trim() : '';
      if (!bearerToken) throw new Error('请填写访问密钥。');
      const provider: ProviderConnection = { id: existing?.id ?? randomUUID(), displayName: displayName.slice(0, 80),
        providerPreset: input.providerPreset === undefined ? existing?.providerPreset ?? detectProviderPreset(baseUrl) : normalizeProviderPreset(input.providerPreset),
        baseUrl, bearerToken, adapter,
        codexApiFormat: adapter === 'auto' ? existing?.codexApiFormat ?? 'responses' : adapter,
        codexModel: typeof input.codexModel === 'string' ? input.codexModel.trim() : existing?.codexModel ?? '',
        codexContextWindow: existing?.codexContextWindow ?? 0,
        claudeModels: existing?.claudeModels ?? { fable: '', opus: '', sonnet: '', haiku: '' } };
      const activity = await this.readProviders();
      const services = { codex: !!activity.active.codex, claude: !!activity.active.claude };
      const changed = !existing || existing.displayName !== provider.displayName || existing.baseUrl !== baseUrl || existing.bearerToken !== bearerToken
        || existing.adapter !== provider.adapter || existing.providerPreset !== provider.providerPreset || existing.codexModel !== provider.codexModel;
      const affected = (['codex', 'claude'] as const).filter(c => existing && registry.selected[c] === existing.id && services[c]);
      for (const client of affected) if (!supportsProviderClient(provider, client)) throw new Error('该连接正在被客户端使用，请先切换服务再修改类型。');
      if (affected.includes('claude') && provider.adapter === 'anthropic-messages' && !/\/v1\/?$/.test(provider.baseUrl)) throw new Error('Claude 直连需要以 /v1 结尾的完整 API 地址。');
      try {
        this.settings = await this.settingsStore.update({ providers: { ...registry,
          connections: existing ? registry.connections.map(p => p.id === provider.id ? provider : p) : [...registry.connections, provider] } });
        if (changed && registry.selected.codex === provider.id) this.invalidateProviderCatalog();
        for (const client of changed ? affected : []) {
          await this.options.beforeCompatibleServiceServiceReapply?.(client);
          await this.setModelServiceUnlocked(client, true, true);
        }
      } catch (error) {
        this.settings = await this.settingsStore.update(previous);
        this.invalidateProviderCatalog();
        for (const client of affected) await this.setModelServiceUnlocked(client, true);
        throw error;
      }
      this.fireChange();
      return this.readProviders();
    });
  }

  async deleteProvider(id: string): Promise<ProviderSnapshot> {
    return this.serializeMutation(async () => {
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

  async switchClientProvider(client: ProviderClient, id: string | null): Promise<ProviderSnapshot> {
    return this.serializeMutation(async () => {
      if (!['codex', 'claude'].includes(client)) throw new Error('不支持的客户端。');
      const previous = await this.settingsStore.read();
      const registry = previous.providers!;
      const provider = id ? registry.connections.find(p => p.id === id) : undefined;
      if (id && !provider) throw new Error('连接不存在，请刷新后重试。');
      if (provider?.adapter === 'anthropic-messages' && client === 'claude' && !/\/v1\/?$/.test(provider.baseUrl)) throw new Error('Claude 直连需要以 /v1 结尾的完整 API 地址。');
      if (provider && !supportsProviderClient(provider, client)) throw new Error('此服务类型不支持当前客户端。');
      if (provider && (!provider.baseUrl || !provider.bearerToken)) throw new Error('请先保存服务地址和密钥。');
      const services = await this.readModelServices();
      try {
        let nextRegistry = registry;
        if (client === 'codex' && provider && !provider.codexModel) {
          const catalog = await this.fetchProviderModels(provider.id);
          const model = catalog.find(entry => entry.clients.includes('codex') && !isKnownNonConversationalModel(entry.id));
          if (!model) throw new Error('服务未提供模型目录，请先编辑连接并填写模型 ID。');
          nextRegistry = { ...registry, connections: registry.connections.map(connection => connection.id === provider.id ? { ...connection, codexModel: model.id } : connection) };
        }
        if (id) this.settings = await this.settingsStore.update({ providers: { ...nextRegistry, selected: { ...nextRegistry.selected, [client]: id } } });
        if (client === 'codex' && id !== registry.selected.codex) this.invalidateProviderCatalog();
        await this.setModelServiceUnlocked(client, !!id, true);
      } catch (error) {
        this.settings = await this.settingsStore.update(previous);
        this.invalidateProviderCatalog();
        await this.setModelServiceUnlocked(client, services[client], true);
        throw error;
      }
      this.fireChange();
      return this.readProviders();
    });
  }

  private invalidateProviderCatalog(): void {
    this.compatibleServiceCatalog = [];
    this.compatibleServiceCatalogGeneration += 1;
    this.compatibleServiceCatalogRefreshedAt = 0;
  }

  async fetchProviderModels(id: string, refresh = false): Promise<readonly ModelCatalogEntry[]> {
    const settings = await this.settingsStore.read();
    const provider = settings.providers!.connections.find(p => p.id === id);
    if (!provider) throw new Error('服务连接不存在。');
    const file = path.join(this.userDataDir, `provider-${id}-${provider.adapter}-models.json`);
    const cached = await readCompatibleServiceModelCatalogCache(file, provider.baseUrl, provider.bearerToken, provider.providerPreset);
    if (!refresh && cached.length) return cached;
    const catalog = await fetchProviderCatalog(provider, path.join(this.userDataDir, 'model-capabilities-cache.json'));
    await writeCompatibleServiceModelCatalogCache(file, provider.baseUrl, provider.bearerToken, catalog, provider.providerPreset);
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
    // Model metadata is authoritative for normal routing. This connection-level
    // value is only a hidden fallback for services that expose no model catalog.
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
    const services = await this.readModelServices();
    try {
      this.settings = await this.settingsStore.update({
        compatible: { displayName, providerPreset, baseUrl, bearerToken, codexApiFormat }
      });
      // Capabilities, including the 1M context limit, belong to this exact
      // connection. Never reuse metadata fetched from the previous endpoint.
      this.compatibleServiceCatalog = [];
      this.compatibleServiceCatalogGeneration += 1;
      this.compatibleServiceCatalogRefreshedAt = 0;
      if (services.codex) {
        await this.options.beforeCompatibleServiceServiceReapply?.('codex');
        await this.setModelServiceUnlocked('codex', true);
      } else {
        await this.codexConfig.updateCompatibleServiceConnection({ baseUrl, bearerToken });
      }
      if ((services.claude || services.claudeStatus.status === 'drifted') && previousSettings.providers?.selected.claude === previousSettings.providers?.selected.codex) {
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
        log.error(`[xwxdeck] 兼容服务 connection rollback could not be persisted: ${(settingsError as Error).message}`);
      }
      if (services.codex) {
        await this.setModelServiceUnlocked('codex', true).catch(rollbackError => {
          log.error(`[xwxdeck] ChatGPT 兼容服务 connection rollback failed: ${(rollbackError as Error).message}`);
        });
      } else {
        await this.codexConfig.updateCompatibleServiceConnection({
          baseUrl: previousSettings.compatible.baseUrl,
          bearerToken: previousSettings.compatible.bearerToken
        }).catch(rollbackError => {
          log.error(`[xwxdeck] stored ChatGPT 兼容服务 connection rollback failed: ${(rollbackError as Error).message}`);
        });
      }
      if ((services.claude || services.claudeStatus.status === 'drifted') && previousSettings.providers?.selected.claude === previousSettings.providers?.selected.codex) {
        await this.setModelServiceUnlocked('claude', true).catch(rollbackError => {
          log.error(`[xwxdeck] Claude 兼容服务 connection rollback failed: ${(rollbackError as Error).message}`);
        });
      }
      if (this.active && this.role === 'owner') {
        await this.refreshProxyRoutesBestEffort('兼容服务 connection rollback');
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

  async setModelService(client: 'claude' | 'codex', enabled: boolean): Promise<ModelServiceSnapshot> {
    return this.serializeMutation(() => this.setModelServiceUnlocked(client, enabled));
  }

  private async setModelServiceUnlocked(client: 'claude' | 'codex', enabled: boolean, useSavedSelection = false): Promise<ModelServiceSnapshot> {
    const connection = await this.readCompatibleServiceConfig(client);
    if (enabled && (!connection.baseUrl || !connection.bearerToken)) {
      throw new Error(`请先在设置中填写并保存 ${connection.displayName} 地址和密钥。`);
    }
    const settings = await this.settingsStore.read();
    if (client === 'claude') {
      if (enabled && selectedProvider(settings, 'claude')?.adapter !== 'anthropic-messages' && !providerProfile(connection.providerPreset).supportsClaude) {
        const discovered = await this.loadClaudeCompatibleServiceCatalog();
        if (!discovered.some(model => model.protocols.includes('anthropic-messages'))) {
          throw new Error(`${connection.displayName} 没有检测到 Claude Messages 兼容入口。`);
        }
      }
      const catalog = enabled ? await this.loadClaudeCompatibleServiceCatalog() : this.compatibleServiceCatalog;
      await this.withUnderlyingClient('claude-cli', () => this.claudeConfig.update({
        nativeAnthropic: selectedProvider(settings, 'claude')?.adapter === 'anthropic-messages',
        enabled,
        baseUrl: connection.baseUrl,
        bearerToken: connection.bearerToken,
        models: settings.claudeModels,
        catalog
      }));
    } else {
      await this.withUnderlyingClient('codex-cli', async () => {
        const current = await this.codexConfig.read();
        const activeOfficialModel = current.mode === 'official'
          ? current.officialModel
          : settings.codexModels.official;
        const activeCompatibleServiceModel = !useSavedSelection && current.mode === 'compatible'
          ? current.compatible.model
          : settings.codexModels.compatible || current.compatible.model;
        await this.applyCodexConfigAndAuth({
          mode: enabled ? 'compatible' : 'official',
          officialModel: activeOfficialModel,
          compatibleModel: activeCompatibleServiceModel,
          compatibleBaseUrl: connection.baseUrl,
          compatibleBearerToken: connection.bearerToken,
          modelContextWindow: enabled
            ? settings.codexModels.compatibleContextWindow || null
            : settings.codexModels.officialContextWindow || null,
          preserveOfficialLogin: settings.codexEnhancements.preserveOfficialLogin,
          unifySessionHistory: settings.codexEnhancements.unifySessionHistory
        });
        this.settings = await this.settingsStore.update({
          codexPreferredMode: enabled ? 'compatible' : 'official',
          codexModels: {
            official: activeOfficialModel,
            compatible: activeCompatibleServiceModel
          }
        });
      });
    }
    this.fireChange();
    return this.readModelServices();
  }

  async readClaudeModels(): Promise<ClaudeModelSettings> {
    const settings = await this.settingsStore.read();
    return settings.claudeModels;
  }

  /** 保存 Claude 模型映射；仅在 Claude 兼容服务 代理启用时写入客户端配置。 */
  async updateClaudeModels(input: Partial<ClaudeModelSettings> & { expectedProviderId?: string | null }): Promise<ClaudeModelSettings> {
    return this.serializeMutation(() => this.updateClaudeModelsUnlocked(input));
  }

  private async updateClaudeModelsUnlocked(input: Partial<ClaudeModelSettings> & { expectedProviderId?: string | null }): Promise<ClaudeModelSettings> {
    const previous = await this.settingsStore.read();
    const activeService = await this.readUnderlyingClaudeService();
    if (input.expectedProviderId !== undefined && input.expectedProviderId !== (activeService.enabled ? previous.providers?.selected.claude : null)) throw new Error('服务连接已变化，请刷新后重试。');
    try {
    this.settings = await this.settingsStore.update({ claudeModels: input as ClaudeModelSettings });
    const connection = await this.readCompatibleServiceConfig('claude');
    const currentService = await this.readUnderlyingClaudeService();
    const catalog = currentService.enabled
      ? await this.loadClaudeCompatibleServiceCatalog()
      : this.compatibleServiceCatalog;
    await this.withUnderlyingClient('claude-cli', async () => {
      // withUnderlyingClient has restored the long-lived config at this point.
      // Read inside the per-client queue so a concurrent service toggle cannot
      // make a stale pre-queue snapshot re-enable 兼容服务 after it was closed.
      const service = await this.claudeConfig.read();
      if (service.enabled) {
        await this.claudeConfig.update({
          nativeAnthropic: selectedProvider(this.settings!, 'claude')?.adapter === 'anthropic-messages',
          enabled: true,
          baseUrl: connection.baseUrl,
          bearerToken: connection.bearerToken,
          models: this.settings?.claudeModels,
          catalog
        });
      }
    });
    this.fireChange();
    return this.settings.claudeModels;
    } catch (error) {
      this.settings = await this.settingsStore.update(previous);
      throw error;
    }
  }

  async updateCodexConfig(input: CodexConfigUpdate): Promise<CodexConfigSnapshot> {
    return this.serializeMutation(() => this.updateCodexConfigUnlocked(input));
  }

  private async updateCodexConfigUnlocked(input: CodexConfigUpdate): Promise<CodexConfigSnapshot> {
    const settings = await this.settingsStore.read();
    const config = await this.readUnderlyingCodexConfig();
    if (input.expectedProviderId !== undefined && input.expectedProviderId !== (config.mode === 'compatible' ? settings.providers?.selected.codex : null)) throw new Error('服务连接已变化，请刷新后重试。');
    const selected = selectedProvider(settings, 'codex');
    const next = await this.withUnderlyingClient('codex-cli', () => this.applyCodexConfigAndAuth({
      ...input,
      ...(input.expectedProviderId && selected ? { compatibleBaseUrl: selected.baseUrl, compatibleBearerToken: selected.bearerToken } : {}),
      preserveOfficialLogin: settings.codexEnhancements.preserveOfficialLogin,
      unifySessionHistory: settings.codexEnhancements.unifySessionHistory
    }));
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
    return next;
  }

  async readCodexEnhancements(history?: CodexHistoryMigrationOutcome): Promise<CodexEnhancementsSnapshot> {
    const [settings, config, hasHistoryBackup] = await Promise.all([
      this.settingsStore.read(),
      this.codexConfig.read(),
      this.codexHistory.hasMigrationBackup()
    ]);
    return {
      preserveOfficialLogin: settings.codexEnhancements.preserveOfficialLogin,
      authMode: config.authMode,
      unifySessionHistory: settings.codexEnhancements.unifySessionHistory,
      historyRestorePending: settings.codexEnhancements.pendingHistoryRestore,
      hasHistoryBackup,
      ...(history ? { history } : {})
    };
  }

  async updateCodexEnhancements(input: CodexEnhancementsUpdate): Promise<CodexEnhancementsSnapshot> {
    return this.serializeMutation(() => this.updateCodexEnhancementsUnlocked(input));
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
            modelContextWindow: previousSettings.codexModels.compatibleContextWindow || null,
            preserveOfficialLogin,
            unifySessionHistory
          });
        } else {
          // Turning preservation off while using the official service records
          // the preference only. The user's OAuth/API key remains live until
          // they actually switch to 兼容服务.
          await this.codexOfficialAuth.restoreOfficialLogin();
        }
      });
    }

    if (hasHistoryUpdate && unifySessionHistory && input.migrateExisting === true) {
      await this.ensureCodexStableProvider(true);
    }
    this.settings = await this.settingsStore.update({
      codexEnhancements: {
        preserveOfficialLogin,
        unifySessionHistory,
        pendingHistoryRestore: false
      }
    });

    let history: CodexHistoryMigrationOutcome | undefined;
    if (hasHistoryUpdate && unifySessionHistory && input.migrateExisting === true) {
      history = await this.mergeCodexHistory();
      if (history.skippedReason === 'restore_deferred') {
        this.scheduleCodexHistoryWork('retry history migration after ChatGPT exit', 30_000);
      } else if (history.skippedLockedJsonlFiles + history.skippedLockedStateDbs > 0) {
        this.scheduleCodexHistoryWork('retry locked history migration');
      }
    } else if (hasHistoryUpdate && !unifySessionHistory && input.restoreExisting === true) {
      history = await this.codexHistory.restoreSeparatedHistory();
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
      }
    }
    this.fireChange();
    return this.readCodexEnhancements(history);
  }

  async fetchModels(
    source: 'active' | 'compatible' = 'active',
    refresh = false
  ): Promise<readonly ModelCatalogEntry[]> {
    const generation = this.compatibleServiceCatalogGeneration;
    const [config, connection] = await Promise.all([this.codexConfig.read(), this.readCompatibleServiceConfig()]);
    if (source === 'active' && config.mode === 'official') return readCodexOfficialModelCatalog(config.officialModel);
    const baseUrl = connection.baseUrl.trim().replace(/\/+$/, '');
    const token = connection.bearerToken.trim();
    if (!baseUrl) throw new Error('请先填写并保存服务商地址。');
    if (!token) throw new Error('请先填写并保存服务商密钥。');
    const profile = providerProfile(connection.providerPreset);
    if (profile.modelCatalogMode === 'manual') {
      const model = config.compatible.model.trim();
      return model ? [{
        id: model,
        vendor: connection.displayName,
        protocols: [connection.codexApiFormat === 'responses'
          ? 'openai-responses'
          : connection.codexApiFormat],
        clients: ['codex']
      }] : [];
    }
    if (!refresh && this.compatibleServiceCatalog.length) {
      await this.syncCodexCatalogIfCompatibleServiceActive(this.compatibleServiceCatalog);
      return this.compatibleServiceCatalog;
    }
    if (!refresh) {
      const cached = await readCompatibleServiceModelCatalogCache(
        this.compatibleServiceModelCatalogCachePath(),
        baseUrl,
        token,
        connection.providerPreset
      );
      if (cached.length) {
        this.compatibleServiceCatalog = cached;
        await this.syncCodexCatalogIfCompatibleServiceActive(cached);
        return cached;
      }
    }
    const catalog = await this.refreshCompatibleServiceModelCatalog(baseUrl, token, refresh);
    if (generation !== this.compatibleServiceCatalogGeneration) throw new Error('服务连接已变化，请刷新模型目录。');
    await this.syncCodexCatalogIfCompatibleServiceActive(catalog);
    return catalog;
  }

  /** Refresh data-only model metadata without changing the selected provider. */
  async refreshModelMetadata(): Promise<number> {
    const connection = await this.readCompatibleServiceConfig();
    const baseUrl = connection.baseUrl.trim().replace(/\/+$/, '');
    const token = connection.bearerToken.trim();
    if (!baseUrl || !token || providerProfile(connection.providerPreset).modelCatalogMode === 'manual') return 0;
    const catalog = await this.refreshCompatibleServiceModelCatalog(baseUrl, token, true);
    await this.syncCodexCatalogIfCompatibleServiceActive(catalog);
    await this.refreshProxyRoutes();
    this.fireChange();
    return catalog.length;
  }

  async xwxDeckFolder(): Promise<void> {
    await fs.promises.mkdir(this.traceStore.rootPath(), { recursive: true });
    const { shell } = await import('electron');
    await shell.openPath(this.traceStore.rootPath());
  }

  async diagnoseCodexConversations(): Promise<CodexConversationHealthReport> {
    return new CodexConversationDoctor().diagnose();
  }

  async queryCodexConversations(request: CodexConversationPageRequest): Promise<CodexConversationPageResponse> {
    return this.conversationWorker.query(request);
  }

  async detailCodexConversation(request: CodexConversationDetailRequest): Promise<CodexConversationHealthRow> {
    return this.conversationWorker.detail(request);
  }

  cancelCodexConversationScan(requestId: string): boolean {
    return this.conversationWorker.cancel(requestId);
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
      throw new Error('请先在 XwX Deck 菜单中关闭代理，再修改 Trace 数据目录。');
    }
    if (hasClaudeConfigDir) {
      if (this.active) throw new Error('请先停止 Trace，再修改 Claude 配置目录。');
      const service = await this.claudeConfig.read();
      if (service.status !== 'disabled') {
        throw new Error('请先关闭 Claude 兼容服务 代理并恢复原配置，再修改 Claude 配置目录。');
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
      await this.startProxyUnlocked('trace-directory-change');
    }
    this.fireChange();
    return this.runtimeState();
  }

  async clearHistory(): Promise<void> {
    if (this.proxy.clearHistory) await this.proxy.clearHistory();
    else await this.traceStore.clearAll();
    this.proxy.broadcastReset();
    this.fireChange();
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

  /** 持久化夜间/白天主题;渲染进程通过状态下发得到权威值,不再依赖 file:// 源的 localStorage。 */
  async setTheme(theme: AppTheme): Promise<XwXDeckRuntimeState> {
    this.settings = await this.settingsStore.update({ theme });
    this.fireChange();
    return this.runtimeState();
  }

  async setTraceAppearance(input: Partial<TraceAppearanceSettings>): Promise<XwXDeckRuntimeState> {
    this.settings = await this.settingsStore.update({ traceAppearance: input });
    this.fireChange();
    return this.runtimeState();
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

    for (const session of sessions) {
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

  async runtimeState(): Promise<XwXDeckRuntimeState> {
    await this.refreshBackgroundCaptureState();
    const sessions = await this.traceStore.listSessions();
    const storage = await this.traceStore.storageStats();
    const external = await this.findExternalTracePort().catch(() => undefined);
    const traceCount = sessions.reduce((sum, session) => sum + (session.traceCount || 0), 0);
    const clientPaths = resolveClientPaths(process.env, undefined, {
      claudeConfigDir: this.settings?.claudeConfigDir
    });
    const readiness = await this.traceRuntimeReadiness();
    const backgroundGatewayAction = await this.backgroundGatewayAction();
    return {
      tracingEnabled: this.active,
      readiness,
      role: this.role,
      localBaseUrl: this.localBaseUrl(),
      dashboardUrl: this.dashboardUrl(),
      backgroundGatewayActive: this.backgroundGatewayActive(),
      backgroundGatewayAction,
      chatGptRestartRecommended: this.chatGptRestartRecommended,
      traceRoot: this.traceStore.rootPath(),
      logRoot: this.logRootPath(),
      claudeConfigDir: path.dirname(clientPaths.claudeSettingsPath),
      claudeConfigPath: clientPaths.claudeSettingsPath,
      externalTracePort: external,
      sessions: sessions.length,
      traces: traceCount,
      storageText: storage.maxBytes
        ? `${formatBytes(storage.totalBytes)} / ${formatBytes(storage.maxBytes)}`
        : formatBytes(storage.totalBytes),
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
      log(`[xwxdeck] attached background Gateway at ${baseUrl} (${reason})`);
      return;
    }
    const decision = await decideRoleOnEnable(lockDir);
    if (decision.role === 'follower' && decision.port !== undefined) {
      this.role = 'follower';
      this.followerPort = decision.port;
      this.startLockWatcher(lockDir);
      log(`[xwxdeck] proxy follower on :${decision.port} (${reason})`);
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
    log(`[xwxdeck] proxy owner at ${baseUrl} (${reason})`);
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
      log.warn(`[xwxdeck] ChatGPT connection adjustment failed: ${(error as Error).message}`);
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
          log.warn(`[xwxdeck] lock watcher update failed: ${(error as Error).message}`);
        });
      });
    } catch (err) {
      log.warn(`[xwxdeck] lock watcher failed: ${(err as Error).message}`);
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
    const codex = takeovers.find(takeover => takeover.client === 'codex-cli' && takeover.status === 'taken');
    if (codex && this.proxy.background) {
      await assertGatewayUpstreamReachable(
        localBaseUrl,
        codex.codexRouteKind === 'chatgpt-oauth'
          ? '/backend-api/codex/models?client_version=xwx-preflight'
          : '/v1/models'
      );
    }
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
    if (this.proxy.background) {
      await assertGatewayUpstreamReachable(
        localBaseUrl,
        this.codexGatewayMode === 'official'
          ? '/backend-api/codex/models?client_version=xwx-preflight'
          : '/v1/models'
      );
    }
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
      log(`[xwxdeck] 兼容服务 model directory refreshed in background (${reason}, ${count} models).`);
    }).catch(error => {
      log.warn(`[xwxdeck] 兼容服务 background model refresh skipped (${reason}): ${(error as Error).message}`);
    });
  }

  /**
   * 兼容服务 discovery is also the refresh trigger for Codex's startup-only
   * catalog. The old guard used `codexGatewayEnabled`, which is only true
   * during the config publication transaction; normal model-page refreshes
   * therefore updated XwX's in-memory/cache directory but left Codex's JSON
   * catalog stale.
   */
  private async syncCodexCatalogIfCompatibleServiceActive(
    catalog: readonly ModelCatalogEntry[]
  ): Promise<void> {
    const config = await this.codexConfig.read();
    if (config.mode !== 'compatible') return;
    const result = await this.codexCatalog.syncIfXwXOwned(catalog, this.settings?.compatible.providerPreset === 'compatible');
    if (!result) {
      log('[xwxdeck] Skipped Codex catalog refresh because model_catalog_json is user-owned.');
      return;
    }
    if (result.changed) {
      await this.refreshProxyRoutes();
      log(`[xwxdeck] Codex 兼容服务 model catalog synchronized: ${result.path}`);
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
        ? `${normalizedLocalBaseUrl}/backend-api/codex`
        : codexTakeover?.codexRouteKind === 'chatgpt-oauth'
          ? `${normalizedLocalBaseUrl}/backend-api/codex`
          : codexTakeover
            ? `${normalizedLocalBaseUrl}/v1`
            : undefined;
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
    try {
      await this.proxy.refreshShutdownActivity();
    } catch {
      // Keep the last confirmed state. GatewayProcessClient preserves the live
      // data plane and logs one warning for the uncertain control episode.
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
    await this.ensureCodexStableProvider(false);
  }

  private async ensureCodexStableProvider(force: boolean): Promise<void> {
    if (!force && !this.settings?.codexEnhancements.unifySessionHistory) return;
    const authPath = resolveClientPaths().codexAuthPath;
    const current = await this.codexConfig.read();
    if (this.settings?.codexEnhancements.preserveOfficialLogin || current.mode === 'official') {
      await this.codexOfficialAuth.restoreOfficialLogin();
    }
    const authBefore = await readOptionalBuffer(authPath);
    const connection = await this.readCompatibleServiceConfig();
    if (connection.baseUrl && connection.bearerToken) {
      this.settings = await this.settingsStore.update({ compatible: connection });
    }
    const stable = await this.withUnderlyingClient('codex-cli', () => (
      this.codexConfig.ensureStableProvider({
        baseUrl: connection.baseUrl,
        bearerToken: connection.bearerToken
      })
    ));
    if (stable.activeProvider !== 'xwx_deck') {
      throw new Error('当前 ChatGPT 自定义 provider 缺少可保留的地址或认证，无法安全切换到 xwx_deck。');
    }
    const authAfter = await readOptionalBuffer(authPath);
    if (!optionalBuffersEqual(authBefore, authAfter)) {
      throw new Error('切换到 xwx_deck 时 auth.json 发生了变化。');
    }
  }

  private async handleLockChange(rootDir: string, filename?: string): Promise<void> {
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

  private deferCodexHistoryWork(operation: string, reason: string, retryReason: string): void {
    if (this.codexHistoryDeferredOperation !== operation) {
      this.codexHistoryDeferredOperation = operation;
      this.codexHistoryDeferredAttempts = 0;
      log(`[xwxdeck] deferred ${operation} while ChatGPT is running (${reason})`);
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
        log.warn(`[xwxdeck] Codex history merge skipped ${skipped} locked resource(s) (${reason}); it will be retried later.`);
        this.scheduleCodexHistoryWork('retry after locked merge');
      } else {
        this.clearCodexHistoryDeferral('Codex history merge');
      }
      return outcome;
    } catch (error) {
      // History classification is an enhancement. It must never block xwxDeck
      // startup or a provider switch while Codex owns its live session files.
      log.warn(`[xwxdeck] Codex history merge skipped (${reason}): ${(error as Error).message}`);
      return undefined;
    }
  }

  private async mergeCodexHistory(): Promise<CodexHistoryMigrationOutcome> {
    return this.codexHistory.mergeIntoXwXDeckHistory();
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
      const outcome = await this.codexHistory.restoreSeparatedHistory();
      const locked = outcome.skippedLockedJsonlFiles + outcome.skippedLockedStateDbs;
      if (outcome.skippedReason === 'restore_deferred') {
        this.deferCodexHistoryWork('Codex history restore', reason, 'retry restore after ChatGPT exit');
      } else if (locked > 0) {
        this.clearCodexHistoryDeferral('Codex history restore');
        log.warn(`[xwxdeck] Codex history restore skipped ${locked} locked resource(s) (${reason}); it will be retried later.`);
        this.scheduleCodexHistoryWork('retry after locked restore');
      } else {
        this.clearCodexHistoryDeferral('Codex history restore');
        this.settings = await this.settingsStore.update({
          codexEnhancements: { pendingHistoryRestore: false }
        });
      }
      return outcome;
    } catch (error) {
      log.warn(`[xwxdeck] Codex history restore skipped (${reason}): ${(error as Error).message}`);
      this.scheduleCodexHistoryWork('retry after restore error');
      return undefined;
    }
  }

  private async codexHistoryMutationIsSafe(): Promise<boolean> {
    if (process.env.XWX_DECK_SMOKE_IGNORE_EXTERNAL === '1') return true;
    try {
      return !await isChatGptRunning();
    } catch (error) {
      log.warn(`[xwxdeck] could not verify ChatGPT exit for history mutation: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * A hard kill (task manager / power loss) skips the shutdown handler, so the
   * persisted Codex config can still point at the local XwX Model Gateway while
   * the in-memory gateway state resets to false on the next launch. Without
   * this, ChatGPT 兼容服务 silently stops forwarding until the user re-saves
   * 兼容服务. Re-derive the gateway from the saved config and rebuild the
   * routes so an auto-started/relaunched app reconnects 兼容服务 itself.
   */
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

  private async restoreCodexGatewayOnStartup(): Promise<void> {
    if (this.role !== 'owner') return;
    const localBaseUrl = this.localBaseUrl();
    if (!localBaseUrl) return;
    let snapshot: CodexConfigSnapshot;
    try {
      snapshot = await this.readUnderlyingCodexConfig();
    } catch (error) {
      log.warn(`[xwxdeck] ChatGPT 兼容服务 gateway probe skipped: ${(error as Error).message}`);
      return;
    }
    const settings = this.settings ?? await this.settingsStore.read();
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
      this.codexOfficialUpstreamBaseUrl = await this.codexConfig.readOfficialBaseUrl();
      log(`[xwxdeck] restored official ChatGPT fallback on ${localBaseUrl} (recording=${settings.tracingEnabled})`);
      return;
    }
    const identity = snapshot.mode === 'official' ? 'official' : providerUpstreamKind(settings);
    this.codexProviderIdentity = identity;
    const migratedLegacyTransition = await this.proxy.adoptCodexProviderOnStartup(identity);
    if (migratedLegacyTransition) {
      log(`[xwxdeck] prepared one-time legacy Codex history cleanup for ${snapshot.mode} startup`);
    }
    if (snapshot.mode === 'compatible' && !isXwXManagedProvider(snapshot.activeProvider)) return;
    const resumeSelected = settings.codexPreferredMode === 'compatible' && !!selectedProvider(settings, 'codex');
    if (snapshot.mode === 'official' && !resumeSelected) {
      if (isLoopbackUrl(snapshot.activeBaseUrl)) {
        const configuredPort = parsePort(snapshot.activeBaseUrl);
        const ownPort = parsePort(localBaseUrl);
        if (configuredPort !== undefined && configuredPort === ownPort) {
          // 兼容服务 -> official intentionally keeps the same helper endpoint
          // for a running ChatGPT process that may cache its provider URL. A
          // new manager must rehydrate that official route instead of treating
          // the healthy endpoint as stale and creating a 502 on the next turn.
          this.codexGatewayEnabled = true;
          this.codexGatewayMode = 'official';
          this.codexOfficialAuthMode = snapshot.authMode;
          this.codexOfficialBearerToken = await this.codexOfficialAuth.readCurrentBearerToken();
          this.codexOfficialUpstreamBaseUrl = await this.codexConfig.readOfficialBaseUrl();
          await this.codexConfig.recordGatewayEndpoint(snapshot.activeBaseUrl);
          log(`[xwxdeck] restored official ChatGPT Gateway on ${localBaseUrl}`);
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
        const restored = await this.codexConfig.restoreCompatibleServiceGateway({
          upstreamBaseUrl: await this.codexConfig.readOfficialBaseUrl(),
          gatewayBaseUrl: snapshot.activeBaseUrl
        });
        if (restored.conflicts.length) {
          this.lastError = restored.conflicts.join('；');
          log.warn(`[xwxdeck] stale official Gateway recovery preserved external change: ${this.lastError}`);
        } else if (restored.restoredFields > 0) {
          log(`[xwxdeck] detached official ChatGPT from stale local Gateway (${restored.restoredFields} field(s) restored)`);
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
      const xwxLoopbackResidue = isXwXManagedProvider(snapshot.activeProvider)
        && isLoopbackUrl(snapshot.activeBaseUrl)
        && configuredPort !== undefined
        && (configuredPort === ownPort
          || !await probeLocalTcpPort(configuredPort).catch(() => false));
      if (xwxLoopbackResidue) {
        // Reinstalling or resetting only XwX Deck userData can remove the
        // 兼容服务 credential while Codex still points at an old managed
        // localhost provider. An empty helper cannot serve that route. Repair
        // only a self-owned/dead endpoint; a live foreign loopback is
        // deliberately preserved.
        const restored = await this.codexConfig.restoreCompatibleServiceGateway({
          upstreamBaseUrl: await this.codexConfig.readOfficialBaseUrl(),
          gatewayBaseUrl: snapshot.activeBaseUrl
        });
        if (restored.conflicts.length) {
          this.lastError = `ChatGPT 旧代理恢复冲突：${restored.conflicts.join('；')}`;
          this.setStartupPhase('degraded');
          log.warn(`[xwxdeck] ${this.lastError}`);
        } else if (restored.restoredFields > 0) {
          log(`[xwxdeck] restored ChatGPT from an unusable 兼容服务 Gateway to the official service (${restored.restoredFields} field(s))`);
        }
      } else {
        log.warn('[xwxdeck] ChatGPT 兼容服务 gateway not restored on startup: missing a valid upstream connection.');
      }
      return;
    }
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
      this.settings = await this.settingsStore.update({ codexPreferredMode: 'compatible' });
    } catch (error) {
      this.lastError = (error as Error).message;
      this.setStartupPhase('degraded');
      log.warn(`[xwxdeck] ChatGPT 兼容服务 gateway restore skipped: ${this.lastError}`);
    }
  }

  private async applyCodexConfigAndAuth(
    input: CodexConfigUpdate,
    options: { readonly backgroundRefresh?: boolean } = {}
  ): Promise<CodexConfigSnapshot> {
    const mode = input.mode;
    if (mode !== 'official' && mode !== 'compatible') throw new Error('Unsupported ChatGPT config mode.');
    const preserveOfficialLogin = input.preserveOfficialLogin !== false;
    const previousConfig = await this.codexConfig.read();
    const previousMode = this.codexGatewayMode ?? previousConfig.mode;
    const previousIdentity = this.codexProviderIdentity ?? (previousMode === 'official' ? 'official' : providerUpstreamKind(this.settings ?? await this.settingsStore.read()));
    const targetIdentity = mode === 'official' ? 'official' : providerUpstreamKind(this.settings ?? await this.settingsStore.read());
    const chatGptWasRunningBeforeUpdate = mode === 'compatible'
      && !isLoopbackUrl(previousConfig.activeBaseUrl)
      && await this.chatGptRunningForRestartNotice();
    let managedInput: CodexConfigUpdate = { ...input, preserveOfficialLogin };
    if (Object.prototype.hasOwnProperty.call(input, 'modelContextWindow')) {
      const selectedModel = mode === 'compatible'
        ? typeof input.compatibleModel === 'string' ? input.compatibleModel.trim() : ''
        : typeof input.officialModel === 'string' ? input.officialModel.trim() : '';
      managedInput = {
        ...managedInput,
        modelContextWindow: this.validateCodexContextWindow(selectedModel, input.modelContextWindow)
      };
    }

    if (mode === 'official') {
      const selectedModel = typeof input.officialModel === 'string' ? input.officialModel.trim() : '';
      if (selectedModel && !isOfficialCodexModelId(selectedModel)) {
        throw new Error(`模型 ${selectedModel} 不是可用于官方 ChatGPT/OpenAI 服务的模型。`);
      }
    }

    if (mode === 'compatible') {
      if ((this.settings ?? await this.settingsStore.read()).gatewayPaused) {
        this.settings = await this.settingsStore.update({ gatewayPaused: false });
        log('[xwxdeck] gatewayPaused cleared: ChatGPT 兼容服务 enabled');
      }
      await this.startProxyUnlocked('ChatGPT 兼容服务 enabled');
      const localBaseUrl = this.localBaseUrl();
      if (!localBaseUrl) throw new Error('XwX Model Gateway 尚未启动。');
      const upstreamBaseUrl = typeof input.compatibleBaseUrl === 'string' ? input.compatibleBaseUrl.trim() : '';
      const upstreamToken = typeof input.compatibleBearerToken === 'string' ? input.compatibleBearerToken.trim() : '';
      const selectedModel = typeof input.compatibleModel === 'string' ? input.compatibleModel.trim() : '';
      if (isKnownNonConversationalModel(selectedModel)) {
        throw new Error(`模型 ${selectedModel} 不是可用于 ChatGPT 的对话模型。`);
      }
      if (!upstreamBaseUrl || isLoopbackUrl(upstreamBaseUrl)) {
        throw new Error('兼容服务 上游地址无效，不能指向 XwX 本地 Gateway。');
      }

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
        if (previousIdentity !== targetIdentity) await this.proxy.markCodexProviderTransition(previousIdentity, targetIdentity);
        const modelCatalogPath = await this.ensureCompatibleServiceModelCatalog(
          typeof input.compatibleModel === 'string' ? input.compatibleModel : undefined
        );
        managedInput = {
          ...managedInput,
          gatewayBaseUrl: `${localBaseUrl.replace(/\/+$/, '')}/backend-api/codex`,
          modelCatalogPath,
          disableImageGeneration: providerProfile(
            this.settings.compatible.providerPreset
          ).imageGenerationPolicy === 'block',
          preserveOfficialLogin
        };

        // Route publication is the prepare phase. ChatGPT's config is not
        // allowed to point at the local Gateway until this phase is complete.
        this.codexGatewayEnabled = true;
        this.codexGatewayMode = 'compatible';
        this.codexOfficialAuthMode = undefined;
        this.codexOfficialBearerToken = undefined;
        this.codexOfficialUpstreamBaseUrl = undefined;
        await this.refreshProxyRoutes();
        await this.assertCodexGatewayRoute();
        this.setStartupPhase('routes-ready');

        if (preserveOfficialLogin) {
          await this.codexOfficialAuth.restoreOfficialLogin();
        } else {
          await this.codexOfficialAuth.useCompatibleServiceKey(upstreamToken);
          projectedCompatibleServiceAuth = true;
        }

        const next = await this.codexConfig.update(managedInput);
        if (chatGptWasRunningBeforeUpdate
          && isLoopbackUrl(next.activeBaseUrl)
          && !sameHttpEndpoint(previousConfig.activeBaseUrl, next.activeBaseUrl)) {
          this.markChatGptRestartRecommended('ChatGPT was running when its service switched to the local Gateway');
        }
        this.codexProviderIdentity = providerUpstreamKind(this.settings!);
        this.setStartupPhase('config-ready');
        if (options.backgroundRefresh) this.scheduleCompatibleServiceModelRefresh('gateway configured');
        return next;
      } catch (error) {
        if (projectedCompatibleServiceAuth) {
          await this.codexOfficialAuth.restoreOfficialLogin().catch(restoreError => {
            log.warn(`[xwxdeck] ChatGPT auth rollback failed: ${(restoreError as Error).message}`);
          });
        }
        this.codexGatewayEnabled = previousGatewayEnabled;
        this.codexGatewayMode = previousGatewayMode;
        this.codexOfficialAuthMode = previousOfficialAuthMode;
        this.codexOfficialBearerToken = previousOfficialBearerToken;
        this.codexOfficialUpstreamBaseUrl = previousOfficialUpstreamBaseUrl;
        this.settings = previousSettings;
        await this.settingsStore.update({ compatible: previousSettings.compatible }).catch(settingsError => {
          log.warn(`[xwxdeck] 兼容服务 settings rollback failed: ${(settingsError as Error).message}`);
        });
        await this.refreshProxyRoutesBestEffort('兼容服务 Gateway rollback');
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
      if (previousIdentity !== targetIdentity) await this.proxy.markCodexProviderTransition(previousIdentity, targetIdentity);
      await this.codexOfficialAuth.restoreOfficialLogin();
      const officialConfig = await this.codexConfig.read();
      this.codexOfficialAuthMode = officialConfig.authMode;
      this.codexOfficialBearerToken = await this.codexOfficialAuth.readCurrentBearerToken();
      this.codexOfficialUpstreamBaseUrl = await this.codexConfig.readOfficialBaseUrl();
      const localBaseUrl = this.localBaseUrl();
      // Keep the stable endpoint when switching away from 兼容服务. A running
      // ChatGPT app-server may cache its old localhost provider and does not
      // reliably hot-reload external config.toml edits. The independent helper
      // can safely outlive the manager and route that cached endpoint official.
      const requiresGateway = this.proxy.background && previousGatewayEnabled
        || this.active && this.settings?.clientEnabled.codex !== false;
      if (requiresGateway && localBaseUrl && this.role === 'owner') {
        this.codexGatewayEnabled = true;
        this.codexGatewayMode = 'official';
        await this.refreshProxyRoutes();
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
      }
      const next = await this.codexConfig.update(managedInput);
      this.codexProviderIdentity = 'official';
      if (!isLoopbackUrl(next.activeBaseUrl)) this.chatGptRestartRecommended = false;
      return next;
    } catch (error) {
      if (previousGatewayMode === 'compatible' && !preserveOfficialLogin && previousSettings.compatible.bearerToken) {
        await this.codexOfficialAuth.useCompatibleServiceKey(previousSettings.compatible.bearerToken).catch(authError => {
          log.warn(`[xwxdeck] ChatGPT 兼容服务 auth rollback failed: ${(authError as Error).message}`);
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
    if (this.compatibleServiceCatalog.length) return this.codexCatalog.sync(this.compatibleServiceCatalog, this.settings?.compatible.providerPreset === 'compatible');

    const model = fallbackModel?.trim();
    if (!model) throw new Error('兼容服务 模型目录尚未缓存，请刷新模型列表后重试。');
    const connection = await this.readCompatibleServiceConfig();
    const protocol = findOfficialModelRecord(model)?.codexRecommendedProtocol
      ?? (connection.providerPreset === 'volcengine-ark'
        || providerProfile(connection.providerPreset).modelCatalogMode === 'manual'
        ? connection.codexApiFormat
        : resolveCompatibleServiceCodexProtocol(model));
    if (protocol === 'anthropic-messages') {
      throw new Error(`无法验证 ${model} 的 Messages 端点、工具调用和输出上限，未生成不可靠的 ChatGPT 模型目录。`);
    }
    this.compatibleServiceCatalog = [{
      id: model,
      vendor: connection.displayName,
      protocols: [protocol === 'responses' ? 'openai-responses' : 'chat-completions'],
      clients: ['codex']
    }];
    return this.codexCatalog.sync(this.compatibleServiceCatalog, this.settings?.compatible.providerPreset === 'compatible');
  }

  private validateCodexContextWindow(modelId: string, raw: unknown): number | null {
    if (raw === null || raw === undefined || raw === 0) return null;
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
      throw new Error('ChatGPT 上下文窗口无效。');
    }
    const catalogEntry = this.compatibleServiceCatalog.find(entry => entry.id === modelId);
    const builtin = catalogEntry?.contextWindow !== undefined ? undefined : findBuiltInModelCapability(modelId);
    const variants = codexContextVariants(catalogEntry?.contextWindow !== undefined ? catalogEntry : {
      id: modelId,
      contextWindow: builtin?.contextWindow,
      capabilitySources: builtin?.contextWindow !== undefined ? { contextWindow: 'builtin' } : undefined
    });
    if (!variants.some(variant => variant.contextWindow === raw)) {
      throw new Error(`模型 ${modelId || '（未选择）'} 不支持 ${raw.toLocaleString('en-US')} token 上下文配置。`);
    }
    return raw;
  }

  private async chatGptRunningForRestartNotice(): Promise<boolean> {
    try {
      return await (this.options.chatGptRunning ?? isChatGptRunning)();
    } catch (error) {
      log.warn(`[xwxdeck] could not determine whether ChatGPT needs a restart notice: ${(error as Error).message}`);
      return false;
    }
  }

  private markChatGptRestartRecommended(reason: string): void {
    if (this.chatGptRestartRecommended) return;
    this.chatGptRestartRecommended = true;
    log(`[xwxdeck] ChatGPT restart recommended: ${reason}`);
  }

  private async refreshCompatibleServiceModelCatalog(
    baseUrl: string,
    bearerToken: string,
    forceCapabilityRefresh = false
  ): Promise<readonly ModelCatalogEntry[]> {
    const providerPreset = (await this.readCompatibleServiceConfig()).providerPreset;
    const profile = providerProfile(providerPreset);
    const connection = `${providerPreset}\0${baseUrl}\0${bearerToken}`;
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
      const provider = selectedProvider(this.settings ?? await this.settingsStore.read(), 'codex');
      const catalog = provider && provider.adapter !== 'auto'
        ? await this.fetchProviderModels(provider.id, forceCapabilityRefresh)
        : await fetchCompatibleServiceModelCatalog(baseUrl, bearerToken, fetch,
          path.join(this.userDataDir, 'model-capabilities-cache.json'), this.compatibleServiceCatalog,
          { forceCapabilityRefresh, catalogMode: profile.modelCatalogMode });
      if (generation === this.compatibleServiceCatalogGeneration) {
        this.compatibleServiceCatalog = catalog;
        this.compatibleServiceCatalogRefreshedAt = Date.now();
        await writeCompatibleServiceModelCatalogCache(
          this.compatibleServiceModelCatalogCachePath(),
          baseUrl,
          bearerToken,
          catalog,
          providerPreset
        ).catch(error => {
          log.warn(`[xwxdeck] 兼容服务 model directory cache write failed: ${(error as Error).message}`);
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
    return path.join(this.userDataDir, provider ? `provider-${provider.id}-${provider.adapter}-models.json` : 'compatible-model-catalog-cache.json');
  }

  private async loadClaudeCompatibleServiceCatalog(): Promise<readonly ModelCatalogEntry[]> {
    const provider = selectedProvider(this.settings ?? await this.settingsStore.read(), 'claude');
    if (!provider) return [];
    return this.fetchProviderModels(provider.id).catch(error => {
      log.warn(`[xwxdeck] Claude model directory unavailable: ${(error as Error).message}`);
      return [];
    });
  }

  private async refreshProxyRoutes(): Promise<void> {
    const transient = buildClientRoutes(mergeClientFallbacks(this.clientFallbacks, this.clientTakeovers).filter(item => !(this.codexGatewayEnabled && item.client === 'codex-cli')),  this.settings?.compatible.codexApiFormat ?? 'responses', client => this.active && this.clientTakeovers.some(item => item.client === client && item.status === 'taken'));
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
    const routes = [...gateway, ...transient];
    const resolver = this.options.resolveUpstreamProxyUrl;
    if (!resolver || routes.length === 0) {
      this.logProxyRouteSummary(routes);
      this.proxy.setClientRoutes(routes);
      return;
    }
    const proxyByUpstream = new Map<string, string | undefined>();
    await Promise.all([...new Set(routes.map(route => route.upstreamBaseUrl))].map(async upstream => {
      proxyByUpstream.set(upstream, await resolver(upstream));
    }));
    const resolvedRoutes = routes.map(route => {
      const upstreamProxyUrl = proxyByUpstream.get(route.upstreamBaseUrl);
      return upstreamProxyUrl ? { ...route, upstreamProxyUrl } : route;
    });
    this.logProxyRouteSummary(resolvedRoutes);
    this.proxy.setClientRoutes(resolvedRoutes);
  }

  private logProxyRouteSummary(routes: readonly TapClientRoute[]): void {
    const summary = routes.map(route => {
      const upstream = hostOf(route.upstreamBaseUrl);
      const proxy = route.upstreamProxyUrl ? hostOf(route.upstreamProxyUrl) : 'DIRECT';
      return `${route.source}:${route.path}->${upstream} via ${proxy}`;
    }).sort().join(' | ');
    if (summary === this.lastProxyRouteSummary) return;
    this.lastProxyRouteSummary = summary;
    log(`[xwxdeck] Gateway routes synchronized: ${summary || 'none'}`);
  }

  private async refreshProxyRoutesBestEffort(reason: string): Promise<void> {
    await this.refreshProxyRoutes().catch(error => {
      log.warn(`[xwxdeck] ${reason} preserved the last synchronized routes: ${(error as Error).message}`);
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

  private async withUnderlyingClient<T>(client: ClientId, action: () => Promise<T>): Promise<T> {
    return this.serializeClientOperation(client, () => this.withUnderlyingClientUnlocked(client, action));
  }

  private async withUnderlyingClientUnlocked<T>(client: ClientId, action: () => Promise<T>): Promise<T> {
    const settingsKey = client === 'claude-cli' ? 'claude' : 'codex';
    const localBaseUrl = this.proxy.localBaseUrl();
    const traceManagedBefore = this.shouldTraceManageClient(client, settingsKey, localBaseUrl);
    const fallbackBefore = this.clientFallbacks.find(fallback => (
      fallback.client === client && fallback.status === 'taken'
    ));
    if (traceManagedBefore) {
      const restored = await this.clientOrchestrator.restoreOne(client);
      this.lastError = restoreConflictNotice(restored ? [restored] : []);
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
    }
    try {
      const result = await action();
      if (client === 'codex-cli' && traceManagedBefore) await this.codexLocalProxy.discard();
      return result;
    } finally {
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
    const store = new TraceStore(
      rootDir,
      () => 0,
      () => undefined,
      sessions => this.codexThreadTitles.overlay(sessions)
    );
    const proxy: TraceProxy = this.options.backgroundGateway
      ? new GatewayProcessClient(
        this.userDataDir,
        rootDir,
        this.options.proxyListenPorts,
        async () => !await isChatGptRunning(),
        {
          traceRetention: () => ({ maxSessions: 0, maxStorageBytes: 0 })
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
          proxy.broadcastReset();
          this.fireChange();
        }
        return ok;
      }
    });
    store.onDidAppend(trace => {
      if (trace.source === 'claude-cli' || trace.source === 'claude-vscode') {
        this.clientsSeenSinceEnable.add('claude-cli');
      } else if (trace.source === 'codex-cli' || trace.source === 'codex-vscode') {
        this.clientsSeenSinceEnable.add('codex-cli');
      }
      proxy.broadcastTrace(trace);
      this.fireChange();
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

async function readOptionalBuffer(file: string): Promise<Buffer | undefined> {
  try { return await fs.promises.readFile(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function optionalBuffersEqual(left: Buffer | undefined, right: Buffer | undefined): boolean {
  if (!left || !right) return left === right;
  return left.equals(right);
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

function restoreConflictNotice(
  results: readonly { readonly client: 'claude' | 'codex'; readonly conflicts: readonly string[] }[]
): string | undefined {
  const conflicts = results.flatMap(result => result.conflicts.map(conflict => ({ client: result.client, conflict })));
  if (conflicts.length === 0) return undefined;
  return `已保留 Trace 期间的外部配置修改：${conflicts.map(item => `${item.client === 'claude' ? 'Claude' : 'ChatGPT'} ${item.conflict}`).join('；')}`;
}

async function assertGatewayUpstreamReachable(baseUrl: string, routePath: string): Promise<void> {
  const target = new URL(routePath, `${baseUrl.replace(/\/+$/, '')}/`);
  let statusCode: number;
  try {
    statusCode = await new Promise<number>((resolve, reject) => {
      const req = http.get(target, {
        headers: { 'user-agent': 'xwx-deck-route-preflight' }
      }, res => {
        const status = res.statusCode ?? 502;
        res.resume();
        res.once('end', () => resolve(status));
      });
      req.setTimeout(15_000, () => req.destroy(new Error('upstream preflight timed out')));
      req.once('error', reject);
    });
  } catch (error) {
    log.warn(`[xwxdeck] ChatGPT upstream preflight failed: ${(error as Error).message}`);
    throw new Error('ChatGPT 上游不可用，原配置未更改。');
  }
  // Authentication failures (401/403), unsupported catalogs (404/405), and
  // rate limits (429) all prove that the configured network path reached its
  // destination. A local/upstream 5xx is the condition that would otherwise
  // turn the newly written localhost endpoint into the user's visible 502.
  if (statusCode >= 500) {
    log.warn(`[xwxdeck] ChatGPT upstream preflight returned HTTP ${statusCode}`);
    throw new Error('ChatGPT 上游不可用，原配置未更改。');
  }
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
          capture
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

/**
 * Long-lived 兼容服务 forwarding. These routes exist independently from Trace;
 * `capture` only decides whether the already-forwarded request is persisted.
 */
function buildCodexGatewayRoutes(
  settings: XwXDeckSettings,
  catalog: readonly ModelCatalogEntry[] = []
): TapClientRoute[] {
  const provider = selectedProvider(settings, 'codex');
  const adapter = provider?.adapter ?? 'auto';
  const upstreamBaseUrl = settings.compatible.baseUrl.trim().replace(/\/+$/, '');
  if (!upstreamBaseUrl) return [];
  const stripPathPrefix = baseUrlHasV1Suffix(upstreamBaseUrl) ? '/v1' as const : undefined;
  const capture = settings.clientEnabled.codex !== false;
  const modelProtocols: Record<string, 'responses' | 'chat-completions' | 'anthropic-messages'> = {};
  const modelMaxOutputTokens: Record<string, number> = {};
  const modelSupportsCompact: Record<string, boolean> = {};
  const excludedToolNamespaces = providerProfile(
    settings.compatible.providerPreset
  ).imageGenerationPolicy === 'block'
    ? ['image_gen'] as const
    : undefined;
  for (const entry of catalog) {
    modelProtocols[entry.id] = resolveCatalogCodexProtocol(entry);
    if (entry.maxOutputTokens) modelMaxOutputTokens[entry.id] = entry.maxOutputTokens;
    if (entry.responsesCompact !== undefined) modelSupportsCompact[entry.id] = entry.responsesCompact;
  }

  return [
    // Accept both Codex provider path shapes once the client has connected to
    // this Gateway. This does not reroute a process that still uses a cached
    // direct official URL; the UI asks that client to restart after an
    // official-to-兼容服务 switch.
    {
      source: 'codex-cli',
      path: '/backend-api/codex/models',
      apiType: 'responses',
      upstreamBaseUrl,
      stripPathPrefix: '/backend-api/codex',
      providerId: provider ? providerConnectionIdentity(provider) : undefined,
      providerName: provider?.displayName,
      providerAdapter: adapter,
      defaultProtocol: provider?.codexApiFormat ?? settings.compatible.codexApiFormat,
      compatibleServiceGateway: !provider || provider.providerPreset === 'compatible',
      capture: false,
      upstreamBearerToken: settings.compatible.bearerToken
    },
    {
      source: 'codex-cli',
      path: '/v1/models',
      apiType: 'responses',
      upstreamBaseUrl,
      stripPathPrefix,
      providerId: provider ? providerConnectionIdentity(provider) : undefined,
      providerName: provider?.displayName,
      providerAdapter: adapter,
      defaultProtocol: provider?.codexApiFormat ?? settings.compatible.codexApiFormat,
      compatibleServiceGateway: !provider || provider.providerPreset === 'compatible',
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
      modelProtocols,
      modelMaxOutputTokens,
      modelSupportsCompact,
      providerId: provider ? providerConnectionIdentity(provider) : undefined,
      providerName: provider?.displayName,
      providerAdapter: adapter,
      defaultProtocol: provider?.codexApiFormat ?? settings.compatible.codexApiFormat,
      compatibleServiceGateway: !provider || provider.providerPreset === 'compatible',
      ...(excludedToolNamespaces ? { excludedToolNamespaces } : {}),
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
      modelProtocols,
      modelMaxOutputTokens,
      providerId: provider ? providerConnectionIdentity(provider) : undefined,
      providerName: provider?.displayName,
      providerAdapter: adapter,
      defaultProtocol: provider?.codexApiFormat ?? settings.compatible.codexApiFormat,
      compatibleServiceGateway: !provider || provider.providerPreset === 'compatible',
      ...(excludedToolNamespaces ? { excludedToolNamespaces } : {}),
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
      modelProtocols,
      modelMaxOutputTokens,
      modelSupportsCompact,
      providerId: provider ? providerConnectionIdentity(provider) : undefined,
      providerName: provider?.displayName,
      providerAdapter: adapter,
      defaultProtocol: provider?.codexApiFormat ?? settings.compatible.codexApiFormat,
      compatibleServiceGateway: !provider || provider.providerPreset === 'compatible',
      ...(excludedToolNamespaces ? { excludedToolNamespaces } : {}),
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
      modelProtocols,
      modelMaxOutputTokens,
      providerId: provider ? providerConnectionIdentity(provider) : undefined,
      providerName: provider?.displayName,
      providerAdapter: adapter,
      defaultProtocol: provider?.codexApiFormat ?? settings.compatible.codexApiFormat,
      compatibleServiceGateway: !provider || provider.providerPreset === 'compatible',
      ...(excludedToolNamespaces ? { excludedToolNamespaces } : {}),
      capture,
      upstreamBearerToken: settings.compatible.bearerToken
    },
    {
      source: 'codex-cli',
      path: '/v1/chat/completions',
      apiType: 'chat-completions',
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
  return [
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
    // 兼容服务 mode uses /v1. Retain it as an alias after switching official so
    // an already-running Codex process never falls into a local 502 gap.
    {
      source: 'codex-cli',
      path: '/v1/responses/compact',
      apiType: 'responses',
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
      upstreamBaseUrl: canonicalUpstreamBaseUrl,
      stripPathPrefix: '/backend-api/codex',
      defaultProtocol: 'responses',
      webSocket: 'official-responses',
      blockedBearerToken: settings.compatible.bearerToken,
      replacementBearerToken,
      capture
    }
  ];
}

function officialCodexUpstream(authMode: CodexAuthMode | undefined): string {
  return authMode === 'api-key' ? `${CODEX_DEFAULT_TARGET}/v1` : CODEX_CHATGPT_OAUTH_PROVIDER_TARGET;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function chatGptConnectionIssueText(issue: ChatGptConnectionIssue): string {
  return issue === 'failed'
    ? 'ChatGPT 接入失败，请重启 Trace 后重试。'
    : 'ChatGPT 暂未接入，XwX Deck 当前的连接方式无法与 Trace 同时使用。请先重启 XwX Deck，再重启 Trace 后重试。';
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

export const __test = {
  buildCodexOfficialGatewayRoutes,
  buildCodexGatewayRoutes,
  officialCodexUpstream,
  codexHistoryRetryDelayMs
};

function normalizeProviderApiRoot(value: string): string {
  const url = new URL(value.trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入不含认证、查询参数的 HTTP(S) API 地址。');
  url.pathname = url.pathname.replace(/\/(?:responses(?:\/compact)?|chat\/completions|messages|models)\/?$/i, '').replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}

function providerConnectionIdentity(provider: ProviderConnection): string {
  const revision = createHash('sha256').update(JSON.stringify([provider.baseUrl, provider.bearerToken, provider.adapter, provider.providerPreset, provider.codexApiFormat])).digest('hex').slice(0, 16);
  return `${provider.id}_${revision}`;
}

function providerUpstreamKind(settings: XwXDeckSettings): 'compatible' | `provider:${string}` {
  const provider = selectedProvider(settings, 'codex');
  return provider ? `provider:${providerConnectionIdentity(provider)}` : 'compatible';
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


function officialGatewayUpstreamFromSnapshot(snapshot: CodexConfigSnapshot): string {
  if (isLoopbackUrl(snapshot.activeBaseUrl)) return officialCodexUpstream(snapshot.authMode);
  const baseUrl = snapshot.activeBaseUrl.replace(/\/+$/, '');
  if (snapshot.authMode !== 'chatgpt' || /\/codex$/i.test(baseUrl)) return baseUrl;
  return `${baseUrl}/codex`;
}
