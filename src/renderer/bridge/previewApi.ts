import { createEditionPreviewApi } from '@/edition/preview';
import { initialConnections, providerClients, automaticAdapters } from '../../shared/edition';
import { formatBytes } from '../../shared/format-bytes.browser.js';
import { setupWebsitesFor, setupWebsiteUrl } from '../../shared/setupWebsites';
import {
  providerCodexId,
  supportsProviderClient,
  type ProviderSnapshot
} from '../../shared/providers';
import type {
  ClientId,
  ClaudeModelSettings,
  ClaudeDesktopSyncSnapshot,
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
import type { SubscriptionAccountsSnapshot, SubscriptionRoutingGroup, SubscriptionRoutingPolicy } from '../../shared/subscriptionAccounts';

function previewCustomBackground(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#263746"/><stop offset="1" stop-color="#7b8a91"/></linearGradient></defs>
    <rect width="1600" height="1000" fill="url(#g)"/><circle cx="1180" cy="230" r="190" fill="#d6d9d5" opacity=".18"/>
    <path d="M0 760 350 480l250 210 280-330 420 400 300-210v450H0Z" fill="#10191f" opacity=".42"/>
    <path d="M0 840 420 610l280 190 280-260 320 230 300-130v360H0Z" fill="#e7e8e4" opacity=".12"/>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

export function createPreviewApi(): XwXDeckApi {
  const previewQuery = typeof location !== 'undefined' ? new URLSearchParams(location.search) : undefined;
  const scenario = previewQuery?.get('scenario');
  const missingHistoryProviderPreview = previewQuery?.get('missing-history-provider');
  const hasTraceSkipped = previewQuery?.get('trace-skipped') === '1' || scenario === 'trace-skipped';
  const hasTraceLive = previewQuery?.get('trace-live') === '1' || previewQuery?.get('appearance') === '1' || scenario === 'trace-active';
  const traceCapacityPreview = scenario === 'trace-capacity-over' ? 'over'
    : scenario === 'trace-capacity-under' ? 'under'
      : null;
  const chatGptRestartRecommended = previewQuery?.get('chatgpt-restart') === '1';
  const hasNoticePreview = previewQuery?.get('notice-preview') === '1';
  const hasExternalCodexCatalog = previewQuery?.get('external-codex-catalog') === '1' || scenario === 'codex-conflict' || scenario === 'codex-permission';
  const hasExternalCodexProvider = previewQuery?.get('external-codex-provider') === '1' || scenario === 'codex-conflict' || scenario === 'codex-permission';
  const codexTakeoverError = previewQuery?.get('codex-takeover-error') ?? (scenario === 'codex-permission' ? 'permission' : null);
  const state: {
    tracingEnabled: boolean;
    theme: 'day' | 'night' | 'system';
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
    startup: { enabled: boolean; supported: boolean; launchHidden: boolean; desiredEnabled?: boolean; warning?: string };
    sessions: number;
    traces: number;
    storageText: string;
    traceStorageBytes: number;
    traceWarningGB: number;
    language: NonNullable<XwXDeckRuntimeState['language']>;
    traceDetailLimitGB: number;
    traceAutoCleanup: boolean;
    traceStorageNotice?: string;
    clients: Array<{
      id: ClientId; label: string; enabled: boolean;
      status: 'idle' | 'taken' | 'skipped' | 'off'; statusText: string; detail: string;
    }>;
  } = {
    tracingEnabled: hasTraceSkipped || hasTraceLive,
    theme: previewQuery?.get('theme') === 'night' ? 'night' : previewQuery?.get('theme') === 'system' ? 'system' : 'day',
    traceAppearance: {
      skin: 'classic',
      showThroughput: false,
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
    traceStorageBytes: 0,
    traceWarningGB: 2,
    language: 'zh-CN',
    traceDetailLimitGB: 2,
    traceAutoCleanup: false,
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
  if (traceCapacityPreview) {
    const usedGB = traceCapacityPreview === 'over' ? 2.4 : 1.2;
    state.traceStorageBytes = Math.round(usedGB * 1024 ** 3);
    state.storageText = formatBytes(state.traceStorageBytes);
    state.sessions = traceCapacityPreview === 'over' ? 138 : 41;
    state.traces = traceCapacityPreview === 'over' ? 8_426 : 1_247;
  }

  const previewStartedAt = Date.now();

  const buildState = (): XwXDeckRuntimeState => ({
    ...state,
    backgroundGatewayActive: state.tracingEnabled,
    backgroundGatewayAction: state.tracingEnabled ? 'close' : undefined,
    chatGptRestartRecommended,
    missingCodexHistoryProviders: missingHistoryProviderPreview ? [missingHistoryProviderPreview] : [],
    lifecycleNotice: hasNoticePreview ? {
      message: '连接提示预览',
      description: '持续性的连接问题显示在页面顶部；临时操作结果显示为右下角 Toast。同一个问题不会同时显示两次。',
      type: 'error',
      persistent: true,
      action: 'repair',
      actionLabel: '查看处理建议'
    } : undefined,
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

  let traceUsageCleared = false;
  const previewTraceStats = (): ManagerTraceStats => {
    if (traceUsageCleared) return { total: { tokens: 0, costUsd: 0, costComplete: true }, today: { tokens: 0, costUsd: 0, costComplete: true }, week: { tokens: 0, costUsd: 0, costComplete: true }, series: [] };
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

  const hasUpdate = previewQuery?.get('update') === '1' || scenario === 'update-failed';
  const hasMacUpdate = previewQuery?.get('mac-update') === '1';
  let update: XwXDeckUpdateState = hasUpdate
    ? {
        status: 'available', currentVersion: '1.0.0', targetVersion: '1.0.1', channel: 'release',
        portable: false, installMode: hasMacUpdate ? 'manual-dmg' : 'automatic', supported: true, updateAvailable: true,
        releaseNotes: '新增右下角版本更新提醒\n展示本次更新内容并支持立即下载\n优化便携版原地更新体验'
      }
    : { status: 'idle', currentVersion: '浏览器预览', channel: 'release', portable: false, installMode: 'automatic', supported: false, updateAvailable: false };

  let claude: ClaudeModelSettings = { fable: '', opus: '', sonnet: '', haiku: '' };
  let claudeDesktopSync: ClaudeDesktopSyncSnapshot = {
    enabled: false, supported: true, active: false, modelCount: 0
  };
  let codex: CodexConfigSnapshot = {
    configPath: missingHistoryProviderPreview ? 'C:\\Users\\demo\\.codex\\config.toml' : '',
    authPath: '', exists: false,
    mode: hasExternalCodexProvider ? 'compatible' : 'official',
    officialModel: 'gpt-5.6-sol', authMode: 'unknown' as CodexAuthMode,
    activeProvider: hasExternalCodexProvider ? 'external_manager' : 'openai',
    activeBaseUrl: hasExternalCodexProvider ? 'https://external-manager.example/v1' : 'https://api.openai.com/v1',
    configuredProviders: ['openai'],
    modelCatalogSource: hasExternalCodexCatalog ? 'external' : 'none',
    configOwnership: hasExternalCodexCatalog || hasExternalCodexProvider ? 'external' : 'deck',
    compatible: { provider: 'compatible', model: 'gpt-5.6-sol', baseUrl: '', bearerToken: '' }
  };
  let codexEnhancements: CodexEnhancementsSnapshot = {
    preserveOfficialLogin: true, authMode: 'unknown', unifySessionHistory: false,
    historyRestorePending: false, hasHistoryBackup: false
  };
  let compatible: CompatibleServiceConfigSnapshot = {
    displayName: '自定义连接',
    baseUrl: '',
    bearerToken: '',
    codexApiFormat: 'responses'
  };
  let services: ModelServiceSnapshot = {
    claude: false,
    codex: hasExternalCodexProvider,
    claudeStatus: {
      enabled: false,
      status: 'disabled',
      configPath: state.claudeConfigPath,
      traceManaged: false
    }
  };

  let providers: ProviderSnapshot = {version:1,connections:initialConnections(),selected:Object.fromEntries(providerClients.map(c=>[c,null])) as Record<import('../../shared/providers').ProviderClient,string|null>,active:Object.fromEntries(providerClients.map(c=>[c,null])) as Record<import('../../shared/providers').ProviderClient,string|null>};
  let firstBootPass = true;
  let firstTraceStop = true;
  // Explicit browser-only UI fixture; never reads local account credentials.
  const subscriptionState = previewQuery?.get('subscription-state');
  let subscriptionPreview: SubscriptionAccountsSnapshot = {
    supported: true, officialLoginInstalled: true,
    accounts: (['chatgpt', 'cursor', 'claude', 'grok', 'copilot'] as const).flatMap(platform => ['林青', '陈雨'].map((label, index) => ({
      id: `${platform}-preview-${index}`, platform, label, email: `${index ? 'chen' : 'lin'}@example.test`, status: subscriptionState === 'signed-out' ? 'signed-out' as const : 'connected' as const,
      ...(platform === 'chatgpt' ? { authKind: 'official' as const } : {}),
      ...(subscriptionState === 'missing' || subscriptionState === 'error' ? {} : { quota: { remainingPercent: index ? 42 : 77, resetsAt: 2000000000, checkedAt: Date.now() / 1000 } }),
      ...(subscriptionState === 'error' ? { quotaError: '样例：官方额度暂时无法读取，请重试' } : {})
    }))), routing: {}
  };
  if (scenario === 'service-switching') {
    providers = { ...providers, connections: [...providers.connections,
      { ...providers.connections[0]!, id: 'fixture-deepseek', displayName: 'DeepSeek', baseUrl: 'https://api.deepseek.com', adapter: 'chat-completions', codexModel: 'deepseek-chat' },
      { ...providers.connections[0]!, id: 'fixture-ark', displayName: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', adapter: 'chat-completions', codexModel: '' }
    ] };
  }
  let serviceSwitching: import('../../shared/serviceSwitching').ServiceSwitchingConfig = scenario === 'service-switching' ? {codex: {enabled:true,providerIds:['initial-provider','fixture-deepseek','fixture-ark']}} : {};
  const api: XwXDeckApi = {
    ...createEditionPreviewApi(previewQuery,()=>api),
    getServiceSwitching: async () => structuredClone(serviceSwitching),
    setServiceSwitching: async ({client, policy}) => {serviceSwitching = {...serviceSwitching, [client]: structuredClone(policy)};return structuredClone(serviceSwitching);},
    updateProviderClientModel: async ({providerId,client,model,role}) => {
      providers = {...providers, connections:providers.connections.map(p=>p.id===providerId?client==='codex'?{...p,codexModel:model}:{...p,claudeModels:{...p.claudeModels,[role!]:model}}:p)};
      if (providers.selected.codex === providerId && client === 'codex') codex = {...codex, compatible:{...codex.compatible,model}};
      if (providers.selected.claude === providerId && client === 'claude') claude = {...claude,[role!]:model};
      return structuredClone(providers);
    },

    ...(scenario === 'subscription-accounts' ? {
      getSubscriptionAccounts: async () => structuredClone(subscriptionPreview),
      renameSubscriptionAccount: async ({ accountId, label }: { accountId: string; label: string }) => {
        subscriptionPreview = { ...subscriptionPreview, accounts: subscriptionPreview.accounts.map(account => account.id === accountId ? { ...account, label } : account) };
        return structuredClone(providers);
      },
      beginSubscriptionSignIn: async (input: { accountId?: string; platform?: SubscriptionRoutingGroup }) => {
        subscriptionPreview = { ...subscriptionPreview, flow: { id: 'preview-login', platform: input.platform === 'chatgpt-official' ? 'chatgpt' : input.platform, authKind: input.platform === 'chatgpt-official' ? 'official' : 'api', accountId: input.accountId, status: 'waiting', ...(input.platform === 'copilot' ? { userCode: 'DEMO-CODE' } : {}) } };
        return structuredClone(subscriptionPreview);
      },
      cancelSubscriptionSignIn: async () => {
        subscriptionPreview = { ...subscriptionPreview, flow: null }; return structuredClone(subscriptionPreview);
      },
      refreshSubscriptionUsage: async () => structuredClone(subscriptionPreview),
      setSubscriptionRouting: async ({ platform, policy }: { platform: SubscriptionRoutingGroup; policy: SubscriptionRoutingPolicy }) => {
        subscriptionPreview = { ...subscriptionPreview, routing: { ...subscriptionPreview.routing, [platform]: structuredClone(policy) } };
        return structuredClone(subscriptionPreview);
      }
    } : {}),
    setupWebsites: setupWebsitesFor(navigator.platform.startsWith('Mac') ? 'darwin' : 'win32', 'arm64'),
    openSetupWebsite: async site => { window.open(setupWebsiteUrl(site,navigator.platform.startsWith('Mac')?'darwin':'win32','arm64'),'_blank','noopener,noreferrer'); },
    validateProvider: async input => ({status:'unavailable', providerId:input.providerId,providerName:providers.connections.find(p=>p.id===input.providerId)?.displayName ?? ''}),
    getCompatibleServiceConfig: async () => compatible,
    updateCompatibleServiceConfig: async input => {compatible={...compatible,...input};return compatible;},
    inspectTraceIndexRepair: async () => { throw Error('请在桌面应用中检查索引'); },
    applyTraceIndexRepair: async () => { throw Error('请在桌面应用中修复索引'); },
    getProviders: async () => structuredClone(providers),
    saveProvider: async input => {
      const existing = providers.connections.find(p => p.id === input.id);
      const p = { ...existing, ...input, providerPreset: input.providerPreset ?? existing?.providerPreset ?? "custom" as const, id: existing?.id ?? crypto.randomUUID(), codexProviderId: existing?.displayName === input.displayName ? existing.codexProviderId : input.displayName, codexApiFormat: automaticAdapters.includes(input.adapter) ? 'responses' as const : input.adapter as import("./types").CompatibleServiceConfigSnapshot["codexApiFormat"],
        codexModel: existing?.codexModel ?? '', codexContextWindow: existing?.codexContextWindow ?? 0,
        claudeModels: existing?.claudeModels ?? { fable: '', opus: '', sonnet: '', haiku: '' } };
      providers = { ...providers, connections: existing ? providers.connections.map(c => c.id === p.id ? p : c) : [...providers.connections, p] };
      return structuredClone(providers);
    },
    deleteProvider: async id => {
      if (providers.active.claude === id || providers.active.codex === id) throw new Error('请先切换正在使用此连接的客户端，再删除。');
      const selected = { ...providers.selected }; const active = { ...providers.active };
      for (const c of providerClients) { if (selected[c] === id) selected[c] = null; if (active[c] === id) active[c] = null; }
      providers = { ...providers, selected, active, connections: providers.connections.filter(p => p.id !== id) };
      serviceSwitching = Object.fromEntries(Object.entries(serviceSwitching).map(([client,policy]) => [client,{...policy,providerIds:policy.providerIds.filter(p=>p!==id)}]));
      return structuredClone(providers);
    },
    getConfigurationRemovalImpact: async ({providerIds}) => Object.entries(providers.selected).filter(([,id]) => id && providerIds.includes(id)).map(([client]) => client === 'codex' ? 'ChatGPT / Codex' : client === 'claude' ? 'Claude' : client),
    removeSubscriptionAccounts: async ids => {
      const removed = providers.connections.filter(p => p.subscriptionAccountId && ids.includes(p.subscriptionAccountId)).map(p => p.id);
      if (Object.values(providers.selected).some(id => id && removed.includes(id))) throw Error('请先在模型页切换使用此配置的客户端');
      providers = {...providers,connections:providers.connections.filter(p => !removed.includes(p.id))};
      serviceSwitching = Object.fromEntries(Object.entries(serviceSwitching).map(([client,policy]) => [client,{...policy,providerIds:policy.providerIds.filter(id=>!removed.includes(id))}]));
      subscriptionPreview = {...subscriptionPreview,accounts:subscriptionPreview.accounts.filter(a => !ids.includes(a.id)),flow:null};
      return structuredClone(providers);
    },
    switchClientProvider: async ({ client, providerId, takeOverExternalConfig }) => {
      const p = providers.connections.find(p => p.id === providerId);
      if (providerId && (!p || !supportsProviderClient(p, client))) throw new Error('模型服务不可用。');
      if ((scenario === 'provider-missing-url' || scenario === 'provider-missing-key')
        && p && (!p.baseUrl || !p.bearerToken)) throw new Error('请先保存服务地址和密钥。');
      if (client === 'codex' && takeOverExternalConfig) {
        if (codexTakeoverError === 'changed') {
          throw new Error('ChatGPT 配置在写入前被其他软件修改，已停止以避免覆盖。');
        }
        if (codexTakeoverError === 'invalid') {
          throw new Error('ChatGPT config.toml 格式错误，未修改配置。');
        }
        if (codexTakeoverError === 'permission') {
          throw new Error('EPERM: ChatGPT config.toml 只读，无法写入。');
        }
      }
      providers = { ...providers, selected: providerId || !(client === 'codex' || client === 'claude') ? { ...providers.selected, [client]: providerId } : providers.selected, active: { ...providers.active, [client]: providerId } };
      if ((client === 'codex' || client === 'claude')) services = { ...services, [client]: !!p };
      if (client === 'claude' && p) claude = { ...p.claudeModels };
      if (client === 'codex') {
        if (p) compatible = { ...p };
        codex = {
          ...codex,
          mode: p ? 'compatible' : 'official',
          activeProvider: p ? providerCodexId(p, codexEnhancements.unifySessionHistory) : codexEnhancements.unifySessionHistory ? 'xwx_deck' : 'openai',
          modelCatalogSource: takeOverExternalConfig ? 'none' : codex.modelCatalogSource,
          configOwnership: takeOverExternalConfig ? 'deck' : codex.configOwnership,
          compatible: p ? { ...codex.compatible, provider: providerCodexId(p, codexEnhancements.unifySessionHistory), baseUrl: p.baseUrl, bearerToken: p.bearerToken, model: p.codexModel || 'gpt-5.6-sol' } : codex.compatible
        };
      }
      return structuredClone(providers);
    },
    getClaudeEnvironmentOverrides: async () => ({
      platform: 'windows',
      overrides: [],
      canRemoveAutomatically: true
    }),
    clearClaudeEnvironmentOverrides: async () => ({
      platform: 'windows',
      overrides: [],
      canRemoveAutomatically: true,
      backupPath: 'C:\\Users\\demo\\AppData\\Roaming\\xwxdeck\\backups\\claude-environment-before-standardization-preview.json'
    }),
    fetchProviderModels: async () => api.fetchModels(),
    getState: async () => {
      if ((scenario === 'boot-slow' || scenario === 'boot-retry') && firstBootPass) {
        window.setTimeout(() => { firstBootPass = false; }, 0);
      }
      if (scenario === 'boot-slow' && firstBootPass) {
        await new Promise<void>(resolve => window.setTimeout(resolve, 9_000));
      }
      if (scenario === 'boot-retry' && firstBootPass) {
        throw new Error('模拟应用状态读取失败');
      }
      return buildState();
    },
    setStartupEnabled: async (enabled) => {
      const pending = scenario === 'settings-pending' && enabled && state.startup.desiredEnabled !== true;
      state.startup = { ...state.startup, enabled: pending ? false : enabled, desiredEnabled: enabled,
        warning: pending ? '模拟系统登录项暂未同步；选择已保存，可重试。' : undefined };
      return buildState();
    },
    setTheme: async (theme) => {
      state.theme = theme;
      return emitState();
    },
    setLanguage: async language => { state.language = language; return emitState(); },
    setTraceStoragePolicy: async (input) => {
      if (input.limitGB !== undefined && (!Number.isSafeInteger(input.limitGB) || input.limitGB < 0)) {
        throw new Error('Trace 存储上限须为非负整数，单位 GB。');
      }
      if (input.limitGB !== undefined) {
        if (input.limitGB > 0) state.traceDetailLimitGB = input.limitGB;
        else if (state.traceWarningGB > 0) state.traceDetailLimitGB = state.traceWarningGB;
        state.traceWarningGB = input.limitGB;
        if (input.limitGB === 0) {
          state.traceStorageBytes = 0;
          state.storageText = '0 B';
        }
      }
      if (input.clearUsage === true && input.limitGB === 0) traceUsageCleared = true;
      if (input.autoCleanup !== undefined) state.traceAutoCleanup = input.autoCleanup;
      if (scenario === 'settings-pending') state.traceStorageNotice = '设置已保存，将自动重试应用：模拟后台暂不可用。';
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
    checkForUpdates: async () => {
      if (scenario === 'update-failed') throw new Error('模拟更新服务器无响应');
      return update;
    },
    downloadUpdate: async () => { update = { ...update, status: 'ready', percent: 100 }; return update; },
    restartAndInstall: async () => update,
    cancelUpdate: async () => {
      update = { ...update, status: update.updateAvailable ? 'available' : 'idle', percent: undefined };
      return update;
    },
    repairApplication: async () => ({
      removedCachePaths: 0,
      removedBytes: 0,
      chromiumCacheCleared: true,
      traceRetention: {
        legacyLimitsFound: false,
        persistedSettingsChanged: false,
        settings: { maxSessions: 0, maxStorageMB: 0 },
        helper: { state: 'verified', maxSessions: 0, maxStorageBytes: state.traceAutoCleanup ? state.traceWarningGB * 1024 ** 3 : 0 }
      }
    }),
    repairUnreadableSettings: async () => ({ backupPath: 'preview-settings-backup.bak', lostProviderSettings: false }),
    repairInvalidCodexConfiguration: async () => ({
      backupPath: 'preview-codex-backup.toml',
      mode: codex.mode,
      conflicts: []
    }),
    repairClientProviderSwitch: async ({ client, providerId }) => {
      if (providerId === undefined) providerId = providers.active[client];
      providers = {
        ...providers,
        selected: { ...providers.selected, [client]: providerId },
        active: { ...providers.active, [client]: providerId }
      };
      return structuredClone(providers);
    },
    resetApplication: async () => undefined,
    toggleTracing: async (enabled) => {
      if (scenario === 'trace-active' && enabled === false && firstTraceStop) {
        firstTraceStop = false;
        throw new Error('1 个回复正在生成。');
      }
      state.tracingEnabled = enabled ?? !state.tracingEnabled;
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
    updateClaudeModels: async ({ expectedProviderId: _expected, ...value }) => { claude = { ...claude, ...value }; return claude; },
    getClaudeDesktopSync: async () => structuredClone(claudeDesktopSync),
    updateClaudeDesktopSync: async enabled => {
      claudeDesktopSync = {
        ...claudeDesktopSync,
        enabled,
        active: enabled && state.tracingEnabled,
        modelCount: enabled ? 72 : 0
      };
      return structuredClone(claudeDesktopSync);
    },
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
    copyText: async (value) => {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
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
      if (scenario === 'catalog-slow') await new Promise(resolve => setTimeout(resolve, 3_000));
      if (scenario === 'catalog-failed') throw new Error('模拟 /models 请求超时，服务选择不受影响');
      return [
      {
        id: 'claude-sonnet-4-5',
        vendor: 'Anthropic',
        protocols: ['anthropic-messages', 'openai-responses'],
        protocolsDeclared: true,
        clients: ['claude', 'codex'],
        vision: true,
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        reasoning: true,
        toolCalling: true,
        interleavedThinking: true
      },
      {
        id: 'claude-incomplete-preview',
        vendor: 'Anthropic',
        protocols: ['anthropic-messages'],
        protocolsDeclared: true,
        clients: ['codex'],
        contextWindow: 200_000,
        toolCalling: true
      },
      {
        id: 'gpt-5.6-sol',
        vendor: 'OpenAI',
        protocols: ['openai-responses', 'chat-completions'],
        protocolsDeclared: true,
        vision: true,
        clients: [...providerClients].filter(c=>c!=='claude'),
        contextWindow: 1_050_000,
        capabilitySources: { contextWindow: 'builtin' }
      },
      {
        id: 'gpt-5.5',
        vendor: 'OpenAI',
        protocols: ['openai-responses', 'chat-completions'],
        protocolsDeclared: true,
        vision: true,
        clients: [...providerClients].filter(c=>c!=='claude'),
        contextWindow: 262_144,
        capabilitySources: { contextWindow: 'models.dev' }
      },
      { id: 'gemini-2.5-pro', vendor: 'Google', protocols: [], vision: true, clients: [] },
      { id: 'deepseek-v3.2', vendor: 'DeepSeek', protocols: ['anthropic-messages', 'chat-completions'], protocolsDeclared: true, clients: ['claude'] }
      ] as ModelCatalogEntry[];
    },
    chooseDirectory: async () => undefined,
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
    openDashboard: async () => {
      if (scenario === 'dashboard-failed') throw new Error('模拟仪表盘端口被占用');
    },
    openDataFolder: async () => undefined,
    openLogFolder: async () => undefined,
    clearHistory: async () => buildState(),
    disableBreaksCodex: async () => false,
    refresh: async () => buildState(),
    minimizeWindow: async () => undefined,
    toggleFullscreen: async () => ({ fullscreen: false }),
    toggleMaximize: async () => ({ maximized: false, fullscreen: false }),
    setManagerView: async () => true,
    closeWindow: async () => undefined,
    confirmApplicationExit: async () => undefined,
    getApplicationResetResult: async () => null,
    acknowledgeApplicationResetResult: async () => undefined,
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
  return api;
}
