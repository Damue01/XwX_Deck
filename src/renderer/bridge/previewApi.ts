import type { ProviderSnapshot, ProviderConnection } from '../../shared/providers';
import type {
  ClientId,
  ClaudeModelSettings,
  CodexConversationDetailRequest,
  CodexConversationHealthReport,
  CodexConversationPageRequest,
  CodexConversationPageResponse,
  CodexAuthMode,
  CodexConfigSnapshot,
  CodexEnhancementsSnapshot,
  ManagerTraceStats,
  ModelCatalogEntry,
  ModelServiceSnapshot,
  XwXDeckApi,
  XwXDeckRuntimeState,
  XwXDeckUpdateState,
  CompatibleServiceConfigSnapshot,
  WindowState,
} from './types';
import { detectProviderPreset } from '../../shared/providerProfiles';

function previewCustomBackground(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#263746"/><stop offset="1" stop-color="#7b8a91"/></linearGradient></defs>
    <rect width="1600" height="1000" fill="url(#g)"/><circle cx="1180" cy="230" r="190" fill="#d6d9d5" opacity=".18"/>
    <path d="M0 760 350 480l250 210 280-330 420 400 300-210v450H0Z" fill="#10191f" opacity=".42"/>
    <path d="M0 840 420 610l280 190 280-260 320 230 300-130v360H0Z" fill="#e7e8e4" opacity=".12"/>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function expandConversationPreview(
  rows: CodexConversationHealthReport['conversations'],
  count: number
): CodexConversationHealthReport['conversations'] {
  if (count <= rows.length) return rows;
  return Array.from({ length: count }, (_, index) => {
    const source = rows[index % rows.length]!;
    if (index < rows.length) return source;
    return {
      ...source,
      threadId: `${source.threadId}-preview-${String(index + 1).padStart(3, '0')}`,
      title: `${source.title || '未命名任务'} 样例 ${index + 1}`,
      updatedAt: new Date(Date.now() - index * 60_000).toISOString()
    };
  });
}

export function createPreviewApi(): XwXDeckApi {
  const previewQuery = typeof location !== 'undefined' ? new URLSearchParams(location.search) : undefined;
  const hasTraceSkipped = previewQuery?.get('trace-skipped') === '1';
  const hasTraceLive = previewQuery?.get('trace-live') === '1' || previewQuery?.get('appearance') === '1';
  const chatGptRestartRecommended = previewQuery?.get('chatgpt-restart') === '1';
  const conversationHealthPreview = (): CodexConversationHealthReport => {
    const now = new Date().toISOString();
    const databasePath = 'C:\\Users\\demo\\.codex\\state_5.sqlite';
    const activePath = 'C:\\Users\\demo\\.codex\\sessions\\2026\\08\\26\\rollout-active.jsonl';
    const missingPath = 'C:\\Users\\demo\\.codex\\sessions\\2026\\08\\25\\rollout-missing.jsonl';
    const candidatePath = 'C:\\Users\\demo\\.codex\\archived_sessions\\rollout-recovered.jsonl';
    return {
      generatedAt: now,
      codexHome: 'C:\\Users\\demo\\.codex',
      configPath: 'C:\\Users\\demo\\.codex\\config.toml',
      activeProvider: 'xwx_deck',
      configuredProviders: ['openai', 'xwx_deck'],
      databases: [{
        path: databasePath,
        exists: true,
        readable: true,
        quickCheck: 'ok',
        threadCount: 24,
        walPresent: true,
        walBytes: 524_288
      }],
      scanScope: 'index-and-session-meta',
      scanComplete: true,
      scanIssues: [],
      truncated: false,
      summary: {
        indexedThreads: 24,
        discoveredRollouts: 25,
        healthy: 23,
        warnings: 0,
        errors: 1,
        orphanRollouts: 0,
        missingRollouts: 1
      },
      conversations: [{
        threadId: '11111111-1111-4111-8111-111111111111',
        title: '检查模型配置',
        preview: '',
        workspaceKind: 'project',
        workspaceName: 'XwX Deck',
        projectId: 'project-xwx-deck',
        projectName: 'XwX Deck',
        projectRoots: ['D:\\Work\\XwX_Deck'],
        cwd: 'D:\\Work\\XwX_Deck',
        indexed: true,
        databasePaths: [databasePath],
        rolloutPath: activePath,
        resolvedPath: activePath,
        candidatePaths: [activePath],
        fileExists: true,
        fileSize: 287_420,
        fileModifiedAt: now,
        location: 'sessions',
        archived: false,
        sqliteProvider: 'xwx_deck',
        sessionProvider: 'xwx_deck',
        sessionId: '11111111-1111-4111-8111-111111111111',
        sqliteFields: [
          { key: 'id', value: '11111111-1111-4111-8111-111111111111' },
          { key: 'rollout_path', value: activePath },
          { key: 'model_provider', value: 'xwx_deck' },
          { key: 'project_id', value: 'project-xwx-deck' }
        ],
        sessionFields: [
          { key: 'id', value: '11111111-1111-4111-8111-111111111111' },
          { key: 'model_provider', value: 'xwx_deck' },
          { key: 'source', value: 'vscode' }
        ],
        status: 'healthy',
        issues: []
      }, {
        threadId: '22222222-2222-4222-8222-222222222222',
        title: '恢复缺失的会话索引',
        preview: '',
        workspaceKind: 'directory',
        workspaceName: 'Workspace',
        projectRoots: [],
        cwd: 'D:\\Work\\Workspace',
        indexed: true,
        databasePaths: [databasePath],
        rolloutPath: missingPath,
        resolvedPath: candidatePath,
        candidatePaths: [candidatePath],
        fileExists: true,
        fileSize: 91_844,
        fileModifiedAt: new Date(Date.now() - 3_600_000).toISOString(),
        location: 'archived_sessions',
        archived: false,
        sqliteProvider: 'xwx_deck',
        sessionProvider: 'xwx_deck',
        sessionId: '22222222-2222-4222-8222-222222222222',
        sqliteFields: [
          { key: 'id', value: '22222222-2222-4222-8222-222222222222' },
          { key: 'rollout_path', value: missingPath },
          { key: 'model_provider', value: 'xwx_deck' }
        ],
        sessionFields: [
          { key: 'id', value: '22222222-2222-4222-8222-222222222222' },
          { key: 'model_provider', value: 'xwx_deck' }
        ],
        status: 'error',
        issues: [{
          code: 'rollout_file_missing',
          severity: 'error',
          title: '索引指向的文件不存在',
          detail: missingPath
        }, {
          code: 'recovery_candidate',
          severity: 'warning',
          title: '发现可恢复文件',
          detail: candidatePath
        }]
      }]
    };
  };
  const state: {
    tracingEnabled: boolean;
    theme: 'day' | 'night';
    traceAppearance: {
      skin: 'classic' | 'clean' | 'custom';
      showThroughput: boolean;
      customImageFile: string;
      customImageUrl?: string;
      customImageFit: 'cover' | 'contain';
      customImageOverlay: number;
    };
    traceRoot: string;
    logRoot: string;
    claudeConfigDir: string;
    claudeConfigPath: string;
    startup: { enabled: boolean; supported: boolean; launchHidden: boolean };
    sessions: number;
    traces: number;
    storageText: string;
    clients: Array<{
      id: ClientId; label: string; enabled: boolean;
      status: 'idle' | 'taken' | 'skipped' | 'off'; statusText: string; detail: string;
    }>;
  } = {
    tracingEnabled: hasTraceSkipped || hasTraceLive,
    theme: 'day',
    traceAppearance: {
      skin: 'classic',
      showThroughput: true,
      customImageFile: '',
      customImageFit: 'cover',
      customImageOverlay: 42
    },
    traceRoot: 'D:\\XwX Deck\\Trace',
    logRoot: 'D:\\XwX Deck\\Logs',
    claudeConfigDir: 'C:\\Users\\Preview\\.claude',
    claudeConfigPath: 'C:\\Users\\Preview\\.claude\\settings.json',
    startup: { enabled: false, supported: true, launchHidden: true },
    sessions: 0,
    traces: 0,
    storageText: '0 B',
    clients: [
      { id: 'claude-cli', label: 'Claude', enabled: true, status: 'idle', statusText: '待命', detail: '追踪未开启' },
      { id: 'codex-cli', label: 'ChatGPT', enabled: true, status: 'idle', statusText: '待命', detail: '追踪未开启' }
    ]
  };
  if (hasTraceSkipped || hasTraceLive) {
    const claudeClient = state.clients.find(client => client.id === 'claude-cli');
    const codexClient = state.clients.find(client => client.id === 'codex-cli');
    if (claudeClient) {
      claudeClient.status = 'taken';
      claudeClient.statusText = '追踪中';
      claudeClient.detail = 'api.anthropic.com';
    }
    if (codexClient && hasTraceSkipped) {
      codexClient.status = 'skipped';
      codexClient.statusText = '未接入';
      codexClient.detail = 'ChatGPT 暂未接入，XwX Deck 当前的连接方式无法与 Trace 同时使用。请先重启 XwX Deck，再重启 Trace 后重试。';
    } else if (codexClient) {
      codexClient.status = 'taken';
      codexClient.statusText = '追踪中';
      codexClient.detail = 'api.openai.com';
    }
  }

  const previewStartedAt = Date.now();

  const buildState = (): XwXDeckRuntimeState => ({
    ...state,
    traceStorageBytes: 0, traceWarningGB: 2, traceAutoCleanup: false,
    backgroundGatewayActive: state.tracingEnabled,
    backgroundGatewayAction: state.tracingEnabled ? 'close' : undefined,
    chatGptRestartRecommended,
    readiness: {
      startupPhase: 'ready',
      proxyListening: state.tracingEnabled,
      recordingEnabled: state.tracingEnabled,
      claudeConfigReady: state.tracingEnabled,
      claudeRouteReady: state.tracingEnabled,
      codexConfigReady: state.tracingEnabled && !hasTraceSkipped,
      codexRouteReady: state.tracingEnabled && !hasTraceSkipped,
      codexGatewayEnabled: false
    },
    clients: state.clients.map(c => ({ ...c })),
    update
  });
  const stateListeners = new Set<(snapshot: XwXDeckRuntimeState) => void>();
  const emitState = (): XwXDeckRuntimeState => {
    const snapshot = buildState();
    for (const listener of stateListeners) listener(snapshot);
    return snapshot;
  };

  const previewTraceStats = (): ManagerTraceStats => {
    if (!state.tracingEnabled) {
      return { total: { tokens: 0, costUsd: 0, costComplete: true }, today: { tokens: 0, costUsd: 0, costComplete: true }, week: { tokens: 0, costUsd: 0, costComplete: true }, series: [] };
    }
    const now = Date.now();
    const bucketMs = 4000;
    const lastBucket = Math.floor(now / bucketMs) * bucketMs;
    const series = Array.from({ length: 32 }, (_, i) => {
      const at = lastBucket - (31 - i) * bucketMs;
      const phase = Math.floor(at / bucketMs);
      const wave = 18 + Math.sin(phase * .72) * 7 + Math.sin(phase * .19 + 1.4) * 5;
      return { at: new Date(at).toISOString(), tokens: Math.round(Math.max(2, wave) * 3.2), tokPerSec: Math.round(Math.max(2, wave) * 10) / 10 };
    });
    const generated = Math.max(0, Math.floor((now - previewStartedAt) / 320));
    const tokens = 15578642 + generated;
    return {
      // costComplete was hardcoded true everywhere, so the preview could never show
      // the partial or unavailable cost states and they could only be checked by
      // building the app. Today is partial (something priced, something did not)
      // and this week has nothing priceable, which is the case that must render a
      // dash rather than $0.00.
      total: { tokens, costUsd: 42.18 + generated / 100000, costComplete: true },
      today: { tokens: 286420 + generated, costUsd: 1.24 + generated / 100000, costComplete: false },
      week: { tokens: 1728640 + generated, costUsd: 0, costComplete: false },
      series
    };
  };

  const hasUpdate = previewQuery?.get('update') === '1';
  const hasMacUpdate = previewQuery?.get('mac-update') === '1';
  let update: XwXDeckUpdateState = hasUpdate
    ? {
        status: previewQuery?.get('update-ready') === '1' ? 'ready' : 'available',
        background: previewQuery?.get('update-background') === '1', currentVersion: '1.0.0', targetVersion: '1.0.1', channel: 'release',
        portable: false, installMode: hasMacUpdate ? 'manual-dmg' : 'automatic', supported: true, updateAvailable: true,
        releaseNotes: '新增右下角版本更新提醒\n展示本次更新内容并支持立即下载\n优化 Windows 原地更新体验'
      }
    : { status: 'idle', currentVersion: '浏览器预览', channel: 'release', portable: false, installMode: 'automatic', supported: false, updateAvailable: false };

  let claude: ClaudeModelSettings = { fable: '', opus: '', sonnet: '', haiku: '' };
  let codex: CodexConfigSnapshot = {
    configPath: '', authPath: '', exists: false,
    modelCatalogSource: 'none',
    mode: 'official', officialModel: 'gpt-5.6-sol', authMode: 'unknown' as CodexAuthMode,
    activeProvider: 'openai', activeBaseUrl: 'https://api.openai.com/v1',
    compatible: { provider: 'compatible', model: 'gpt-5.6-sol', baseUrl: '', bearerToken: '' }
  };
  let codexEnhancements: CodexEnhancementsSnapshot = {
    preserveOfficialLogin: true, authMode: 'unknown', unifySessionHistory: false,
    historyRestorePending: false, hasHistoryBackup: false
  };
  let compatible: CompatibleServiceConfigSnapshot = {
    displayName: '兼容服务',
    providerPreset: 'auto',
    baseUrl: 'https://gateway.example.com/v1',
    bearerToken: '',
    codexApiFormat: 'responses'
  };
  let services: ModelServiceSnapshot = {
    claude: false,
    codex: false,
    claudeStatus: {
      enabled: false,
      status: 'disabled',
      configPath: state.claudeConfigPath,
      traceManaged: false
    }
  };
  let providers: ProviderSnapshot = { version: 1, connections: [], selected: { codex: null, claude: null }, active: { codex: null, claude: null } };
  return {
    getState: async () => buildState(),
    setStartupEnabled: async (enabled) => {
      state.startup = { ...state.startup, enabled };
      return buildState();
    },
    setTheme: async (theme) => {
      state.theme = theme;
      return emitState();
    },
    setTraceAppearance: async (input) => {
      state.traceAppearance = { ...state.traceAppearance, ...input };
      return emitState();
    },
    chooseTraceBackground: async () => {
      state.traceAppearance = {
        ...state.traceAppearance,
        skin: 'custom',
        customImageFile: 'preview-background.webp',
        customImageUrl: previewCustomBackground()
      };
      return emitState();
    },
    clearTraceBackground: async () => {
      state.traceAppearance = {
        ...state.traceAppearance,
        skin: 'classic',
        customImageFile: '',
        customImageUrl: undefined
      };
      return emitState();
    },
    getTraceStats: async () => previewTraceStats(),
    getUpdateState: async () => update,
    checkForUpdates: async () => update,
    downloadUpdate: async () => { update = { ...update, status: 'ready', percent: 100 }; return update; },
    restartAndInstall: async () => update,
    cancelUpdate: async () => { update = { ...update, status: 'available', percent: undefined }; return update; },
    repairApplication: async () => ({ removedCachePaths: 0, removedBytes: 0, chromiumCacheCleared: true, traceRetention: { legacyLimitsFound: false, persistedSettingsChanged: false, settings: { maxSessions: 0, maxStorageMB: 0 }, helper: { state: 'not-running' } } }),
    resetApplication: async () => undefined,
    toggleTracing: async () => {
      state.tracingEnabled = !state.tracingEnabled;
      for (const c of state.clients) {
        c.status = state.tracingEnabled && c.enabled
          ? hasTraceSkipped && c.id === 'codex-cli' ? 'skipped' : 'taken'
          : c.enabled ? 'idle' : 'off';
      }
      return emitState();
    },
    toggleClient: async (id) => {
      const c = state.clients.find(x => x.id === id);
      if (c) {
        c.enabled = !c.enabled;
        c.status = c.enabled ? state.tracingEnabled ? 'taken' : 'idle' : 'off';
      }
      return emitState();
    },
    getClaudeModels: async () => ({ ...claude }),
    updateClaudeModels: async (value) => { claude = { ...claude, ...(value as Partial<ClaudeModelSettings>) }; return claude; },
    repairUnreadableSettings: async () => ({ backupPath: 'preview/settings.backup.json', lostProviderSettings: false }),
    repairInvalidCodexConfiguration: async () => ({ backupPath: 'preview/config.backup.toml', mode: codex.mode, conflicts: [] }),
    repairClientProviderSwitch: async () => structuredClone(providers),
    getClaudeEnvironmentOverrides: async () => ({ platform: 'other', overrides: [], canRemoveAutomatically: false }),
    clearClaudeEnvironmentOverrides: async () => ({ platform: 'other', overrides: [], canRemoveAutomatically: false }),
    getClaudeDesktopSync: async () => ({ enabled: false, supported: false, active: false, configPath: '', modelCount: 0 }),
    updateClaudeDesktopSync: async (enabled) => ({ enabled, supported: false, active: false, configPath: '', modelCount: 0 }),
    getCodexConfig: async () => structuredClone(codex),
    isChatGptRunning: async () => new URLSearchParams(location.search).get('chatgptRunning') === '1',
    getCodexEnhancements: async () => structuredClone(codexEnhancements),
    updateCodexEnhancements: async (value) => {
      codexEnhancements = {
        ...codexEnhancements,
        preserveOfficialLogin: typeof value.preserveOfficialLogin === 'boolean'
          ? value.preserveOfficialLogin
          : codexEnhancements.preserveOfficialLogin,
        unifySessionHistory: typeof value.unifySessionHistory === 'boolean' ? value.unifySessionHistory : codexEnhancements.unifySessionHistory,
        historyRestorePending: false,
        hasHistoryBackup: codexEnhancements.hasHistoryBackup || value.migrateExisting === true,
        history: value.migrateExisting === true
          ? {
              migratedJsonlFiles: 2, migratedStateRows: 2, restoredJsonlFiles: 0, restoredStateRows: 0,
              skippedLockedJsonlFiles: 0, skippedLockedStateDbs: 0
            }
          : value.restoreExisting === true
            ? {
                migratedJsonlFiles: 0, migratedStateRows: 0, restoredJsonlFiles: 2, restoredStateRows: 2,
                skippedLockedJsonlFiles: 0, skippedLockedStateDbs: 0
              }
            : undefined
      };
      return structuredClone(codexEnhancements);
    },
    updateCodexConfig: async (value) => {
      const mode = value.mode === 'compatible' ? 'compatible' as const : 'official' as const;
      if (mode === 'compatible' && (!(value.compatibleBaseUrl as string)?.trim() || !(value.compatibleBearerToken as string)?.trim())) {
        throw new Error(`先在设置中填写 ${compatible.displayName} 地址和密钥。`);
      }
      codex = {
        ...codex, mode,
        officialModel: (value.officialModel as string) || codex.officialModel,
        modelContextWindow: typeof value.modelContextWindow === 'number'
          ? value.modelContextWindow
          : value.modelContextWindow === null ? undefined : codex.modelContextWindow,
        activeProvider: mode === 'compatible' ? 'compatible' : 'openai',
        compatible: {
          ...codex.compatible,
          model: (value.compatibleModel as string) || codex.compatible.model,
          baseUrl: (value.compatibleBaseUrl as string) ?? codex.compatible.baseUrl,
          bearerToken: (value.compatibleBearerToken as string) ?? codex.compatible.bearerToken
        }
      };
      return structuredClone(codex);
    },
    diagnoseCodexConversations: async () => conversationHealthPreview(),
    queryCodexConversations: async (request: CodexConversationPageRequest): Promise<CodexConversationPageResponse> => {
      const report = conversationHealthPreview();
      const needle = request.query.trim().toLocaleLowerCase();
      const filtered = report.conversations.filter(row => (
        (request.filter !== 'issues' || row.status !== 'healthy')
        && (request.filter !== 'healthy' || row.status === 'healthy')
        && (!needle || [row.threadId, row.title, row.cwd, row.rolloutPath]
          .some(value => String(value || '').toLocaleLowerCase().includes(needle)))
      ));
      const pageSize = Math.max(20, Math.min(200, Math.floor(request.pageSize) || 120));
      const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
      const page = Math.max(0, Math.min(pageCount - 1, Math.floor(request.page) || 0));
      return {
        requestId: request.requestId,
        snapshotId: `${report.generatedAt}:preview`,
        generatedAt: report.generatedAt,
        codexHome: report.codexHome,
        configPath: report.configPath,
        activeProvider: report.activeProvider,
        configuredProviders: report.configuredProviders,
        databases: report.databases,
        scanScope: report.scanScope,
        scanComplete: report.scanComplete,
        scanIssues: report.scanIssues,
        truncated: report.truncated,
        summary: report.summary,
        page,
        pageSize,
        total: filtered.length,
        rows: filtered.slice(page * pageSize, (page + 1) * pageSize).map(row => ({
          threadId: row.threadId,
          title: row.title,
          status: row.status,
          primaryIssueTitle: row.issues[0]?.title || '一致',
          issueCount: row.issues.length,
          ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
          ...(row.fileModifiedAt ? { fileModifiedAt: row.fileModifiedAt } : {})
        })),
        performance: { durationMs: 0, reusedRollouts: 0, inspectedRollouts: 0, reusedDatabases: 0, inspectedDatabases: 0 }
      };
    },
    detailCodexConversation: async (request: CodexConversationDetailRequest) => {
      const row = conversationHealthPreview().conversations.find(item => item.threadId === request.threadId);
      if (!row) throw new Error('未找到该对话的诊断详情。');
      return row;
    },
    setCodexConversationDiagnosticsActive: async () => undefined,
    cancelCodexConversationScan: async () => false,
    openCodexConversationPath: async () => undefined,
    copyText: async value => {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    },
    getProviders: async () => structuredClone(providers),
    saveProvider: async input => {
      const existing = providers.connections.find(p => p.id === input.id);
      const provider: ProviderConnection = { id: existing?.id ?? crypto.randomUUID(), displayName: input.displayName, baseUrl: input.baseUrl, bearerToken: input.bearerToken, adapter: input.adapter,
        providerPreset: input.providerPreset ?? 'auto', codexApiFormat: input.adapter === 'auto' ? 'responses' : input.adapter,
        codexModel: input.codexModel ?? existing?.codexModel ?? '', codexContextWindow: existing?.codexContextWindow ?? 0,
        claudeModels: existing?.claudeModels ?? { fable: '', opus: '', sonnet: '', haiku: '' } };
      providers = { ...providers, connections: existing ? providers.connections.map(p => p.id === provider.id ? provider : p) : [...providers.connections, provider] };
      return structuredClone(providers);
    },
    deleteProvider: async id => {
      if (Object.values(providers.active).includes(id)) throw new Error('请先切换正在使用此连接的客户端。');
      providers = { ...providers, connections: providers.connections.filter(p => p.id !== id), selected: { codex: providers.selected.codex === id ? null : providers.selected.codex, claude: providers.selected.claude === id ? null : providers.selected.claude } };
      return structuredClone(providers);
    },
    switchClientProvider: async ({ client, providerId }) => {
      const provider = providers.connections.find(p => p.id === providerId);
      if (providerId && !provider) throw new Error('连接不存在。');
      providers = { ...providers, selected: providerId ? { ...providers.selected, [client]: providerId } : providers.selected, active: { ...providers.active, [client]: providerId } };
      services = { ...services, [client]: !!providerId };
      if (client === 'codex') {
        if (provider) compatible = { ...provider };
        codex = { ...codex, mode: provider ? 'compatible' : 'official', activeProvider: provider ? 'xwx_deck' : 'openai', compatible: { ...codex.compatible, model: provider?.codexModel || codex.compatible.model } };
      } else if (provider) claude = { ...provider.claudeModels };
      return structuredClone(providers);
    },
    fetchProviderModels: async () => [],
    validateProvider: async ({ providerId }) => {
      const provider = providers.connections.find(item => item.id === providerId);
      if (!provider) throw new Error('服务连接不存在。');
      const match = provider.baseUrl.match(/^(.*)\/(responses|chat\/completions|messages)(?:\/v1)?\/?$/i);
      if (match) {
        return {
          status: 'suggestion',
          providerId,
          providerName: provider.displayName,
          suggestedBaseUrl: match[1],
          suggestedAdapter: match[2].toLowerCase() === 'chat/completions'
            ? 'chat-completions'
            : match[2].toLowerCase() === 'messages' ? 'anthropic-messages' : 'responses'
        };
      }
      return { status: 'valid', providerId, providerName: provider.displayName };
    },
    getCompatibleServiceConfig: async () => ({ ...compatible }),
    updateCompatibleServiceConfig: async (value) => {
      compatible = {
        providerPreset: typeof value.baseUrl === 'string'
          ? detectProviderPreset(value.baseUrl)
          : compatible.providerPreset,
        displayName: typeof value.displayName === 'string'
          ? value.displayName.trim().replace(/\s+/g, ' ').slice(0, 80) || compatible.displayName
          : compatible.displayName,
        baseUrl: (value.baseUrl as string) ?? compatible.baseUrl,
        bearerToken: (value.bearerToken as string) ?? compatible.bearerToken,
        codexApiFormat: value.codexApiFormat === 'chat-completions' || value.codexApiFormat === 'anthropic-messages'
          ? value.codexApiFormat
          : compatible.codexApiFormat,
      };
      return { ...compatible };
    },
    getModelServices: async () => ({ ...services }),
    setModelService: async (value) => {
      if (value.enabled && (!compatible.baseUrl?.trim() || !compatible.bearerToken?.trim())) {
        throw new Error(`请先在设置中填写并保存 ${compatible.displayName} 地址和密钥。`);
      }
      services = { ...services, [value.client]: value.enabled };
      if (value.client === 'claude') {
        services = {
          ...services,
          claudeStatus: {
            enabled: value.enabled,
            status: value.enabled ? 'active' : 'disabled',
            configPath: state.claudeConfigPath,
            expectedBaseUrl: value.enabled ? `${compatible.baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')}/anthropic` : undefined,
            actualBaseUrl: value.enabled ? `${compatible.baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')}/anthropic` : undefined,
            traceManaged: state.tracingEnabled
          }
        };
      }
      if (value.client === 'codex') {
        codex = { ...codex, mode: value.enabled ? 'compatible' : 'official', activeProvider: value.enabled ? 'compatible' : 'openai' };
      }
      return { ...services };
    },
    fetchModels: async () => {
      const openAiModels: ModelCatalogEntry[] = [
        {
          id: 'gpt-5.6-sol',
          vendor: 'OpenAI',
          protocols: ['openai-responses', 'chat-completions'],
          vision: true,
          clients: ['codex'],
          contextWindow: 1_050_000,
          capabilitySources: { contextWindow: 'builtin' }
        },
        {
          id: 'gpt-5.5',
          vendor: 'OpenAI',
          protocols: ['openai-responses', 'chat-completions'],
          vision: true,
          clients: ['codex'],
          contextWindow: 262_144,
          capabilitySources: { contextWindow: 'models.dev' }
        }
      ];
      const multiProtocol = compatible.providerPreset === 'compatible'
        || new URLSearchParams(location.search).get('multi-provider') === '1';
      if (!multiProtocol) return openAiModels;
      return [
        ...openAiModels,
        {
          id: 'claude-sonnet-4-5',
          vendor: 'Anthropic',
          protocols: ['anthropic-messages', 'openai-responses'],
          clients: ['claude', 'codex'],
          vision: true,
          contextWindow: 200_000,
          maxOutputTokens: 64_000,
          reasoning: true,
          toolCalling: true,
          interleavedThinking: true
        },
        {
          id: 'deepseek-v3.2',
          vendor: 'DeepSeek',
          protocols: ['anthropic-messages', 'chat-completions'],
          clients: ['claude']
        }
      ];
    },
    chooseDirectory: async (input) => {
      if (input?.kind === 'logs') return 'D:\\XwX Deck\\Custom Logs';
      if (input?.kind === 'trace') return 'D:\\XwX Deck\\Custom Trace';
      if (input?.kind === 'claude') return 'C:\\Users\\Preview\\CustomClaude';
      return undefined;
    },
    updateTraceDirectories: async (value) => {
      if (typeof value?.traceRoot === 'string') state.traceRoot = value.traceRoot;
      if (typeof value?.logRoot === 'string') state.logRoot = value.logRoot;
      if (typeof value?.claudeConfigDir === 'string') {
        state.claudeConfigDir = value.claudeConfigDir;
        state.claudeConfigPath = `${value.claudeConfigDir}\\settings.json`;
        services = {
          ...services,
          claudeStatus: { ...services.claudeStatus, configPath: state.claudeConfigPath }
        };
      }
      return buildState();
    },
    openDashboard: async () => undefined,
    openDataFolder: async () => undefined,
    openLogFolder: async () => undefined,
    clearHistory: async () => buildState(),
    inspectTraceIndexRepair: async () => ({
      rootPath: state.traceRoot,
      indexPath: `${state.traceRoot}\\index.json`,
      indexStatus: 'valid' as const,
      indexSha256: 'preview-index',
      indexedSessions: state.sessions,
      jsonlFiles: state.sessions,
      missingIndexedFiles: [],
      candidates: []
    }),
    applyTraceIndexRepair: async () => ({
      rootPath: state.traceRoot,
      indexPath: `${state.traceRoot}\\index.json`,
      indexStatus: 'valid' as const,
      indexSha256: 'preview-index',
      indexedSessions: state.sessions,
      jsonlFiles: state.sessions,
      missingIndexedFiles: [],
      candidates: [],
      applied: true as const,
      recoveredSessions: 0
    }),
    disableBreaksCodex: async () => false,
    refresh: async () => buildState(),
    minimizeWindow: async () => undefined,
    toggleFullscreen: async () => ({ fullscreen: false }),
    toggleMaximize: async () => ({ maximized: false, fullscreen: false }),
    setManagerView: async () => true,
    closeWindow: async () => undefined,
    moveWindowStart: () => undefined,
    moveWindow: () => undefined,
    moveWindowEnd: () => undefined,
    resizeWindowStart: () => undefined,
    resizeWindowMove: () => undefined,
    resizeWindowEnd: () => undefined,
    onState: (listener: (state: XwXDeckRuntimeState) => void) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onWindowState: (_listener: (state: WindowState) => void) => () => undefined,
    onUpdateState: (_listener: (state: XwXDeckUpdateState) => void) => () => undefined,
    onShowUpdateDetails: (_listener: () => void) => () => undefined,
    onNotice: (_listener) => () => undefined,
  };
}
