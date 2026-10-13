import type { ProviderSnapshot } from '../../shared/providers';
import * as React from 'react';
import { getApi, isDesktop } from './api';
import { showLifecycleNotice } from '@/lib/toast';
import { lifecycleFailure } from '../../shared/lifecycleNotice';
import type {
  ClaudeModelSettings,
  ClaudeDesktopSyncSnapshot,
  CodexConfigSnapshot,
  CodexEnhancementsSnapshot,
  ManagerTraceStats,
  ModelCatalogEntry,
  ModelServiceSnapshot,
  XwXDeckRuntimeState,
  XwXDeckUpdateState,
  CompatibleServiceConfigSnapshot,
} from './types';

export interface BridgeState {
  readonly modelClients: readonly import('../../shared/clientDownloads').DownloadClientId[];
  readonly compatibleServiceConfig: CompatibleServiceConfigSnapshot | null;
  readonly providers: ProviderSnapshot | null;
  readonly api: ReturnType<typeof getApi>;
  readonly runtime: XwXDeckRuntimeState | null;
  readonly traceStats: ManagerTraceStats | null;
  readonly updateState: XwXDeckUpdateState | null;
  readonly claudeModels: ClaudeModelSettings | null;
  readonly claudeDesktopSync: ClaudeDesktopSyncSnapshot | null;
  readonly codexConfig: CodexConfigSnapshot | null;
  readonly codexEnhancements: CodexEnhancementsSnapshot | null;
  readonly modelServices: ModelServiceSnapshot | null;
  readonly modelCatalog: readonly ModelCatalogEntry[];
  readonly loadIssues: readonly string[];
  readonly booted: boolean;
  /** Publish committed API results so every page observes one coherent snapshot. */
  readonly patch: (partial: BridgePatch) => boolean;
  /** Fetch fresh trace stats and push them into the store. */
  readonly refreshStats: () => Promise<void>;
  readonly retryInitialData: () => void;
}

type BridgeData = Omit<BridgeState, 'api' | 'patch' | 'refreshStats' | 'retryInitialData'>;
export type BridgePatch = Partial<Omit<BridgeData, 'booted' | 'loadIssues'>>;

const BridgeContext = React.createContext<BridgeState | null>(null);

export function useBridge(): BridgeState {
  const ctx = React.useContext(BridgeContext);
  if (!ctx) throw new Error('useBridge must be used inside BridgeProvider');
  return ctx;
}

interface Props {
  readonly children: React.ReactNode;
}

const BOOT_REQUEST_TIMEOUT_MS = 8_000;

export function BridgeProvider({ children }: Props): React.ReactElement {
  const api = React.useMemo(() => getApi(), []);
  const [state, setState] = React.useState<BridgeData>({
    modelClients: ["claude", "codex"],
    compatibleServiceConfig: null,
    providers: null,
    runtime: null,
    traceStats: null,
    updateState: null,
    claudeModels: null,
    claudeDesktopSync: null,
    codexConfig: null,
    codexEnhancements: null,
    modelServices: null,
    modelCatalog: [],
    loadIssues: [],
    booted: false,
  });
  const stateRef = React.useRef(state);
  const stateIssuesRef = React.useRef<readonly string[]>([]);
  stateIssuesRef.current = state.loadIssues;
  const retryInitialDataRef = React.useRef<() => void>(() => undefined);
  const retryInitialData = React.useCallback(() => retryInitialDataRef.current(), []);
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const revisionRef = React.useRef(0);
  const fieldRevisionsRef = React.useRef(new Map<string, number>());
  const commit = React.useCallback((partial: Partial<BridgeData>, startedAt?: number) => {
    if (!mountedRef.current) return false;
    const incoming = partial.runtime;
    const current = stateRef.current.runtime;
    const staleRuntime = !!(incoming && current && (incoming.revision ?? 0) < (current.revision ?? 0));
    const accepted = Object.fromEntries(Object.entries(partial).filter(([key]) => (
      (startedAt === undefined || (fieldRevisionsRef.current.get(key) ?? 0) <= startedAt)
      && (key !== 'runtime' || !staleRuntime)
    ))) as Partial<BridgeData>;
    // A newer push of the same completed action may precede its IPC result.
    // Preserve that notice, but suppress results of an obsolete action.
    const noticeCurrent = !incoming || !!accepted.runtime || !!(current
      && incoming.tracingEnabled === current.tracingEnabled
      && incoming.traceTransition === current.traceTransition
      && incoming.lastError === current.lastError
      && JSON.stringify(incoming.connectionNotice) === JSON.stringify(current.connectionNotice));
    const keys = Object.keys(accepted);
    if (!keys.length) return noticeCurrent;
    // Reads keep their start order, so an earlier read finishing first cannot
    // suppress a later one. Explicit patches/push events advance that order.
    const revision = startedAt ?? ++revisionRef.current;
    for (const key of keys) fieldRevisionsRef.current.set(key, revision);
    stateRef.current = { ...stateRef.current, ...accepted };
    setState(previous => ({ ...previous, ...accepted }));
    return noticeCurrent;
  }, []);

  const patch = React.useCallback((partial: BridgePatch) => {
    return commit(partial);
  }, [commit]);

  React.useEffect(() => {
    let alive = true;
    let lastStatsKey = '';
    const update = (partial: Partial<BridgeData>, startedAt?: number) => {
      if (alive) commit(partial, startedAt);
    };

    // A slow client IPC must not hold back data already available from the
    // other clients. Each result updates its own slice as soon as it arrives.
    const jobs = new Map<string, () => void>();
    const generations = new Map<string, number>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const setIssue = (label: string, issue: string | null) => {
      if (!alive) return;
      setState(previous => ({
        ...previous,
        loadIssues: issue
          ? [...previous.loadIssues.filter(item => !item.startsWith(`${label}：`)), `${label}：${issue}`]
          : previous.loadIssues.filter(item => !item.startsWith(`${label}：`))
      }));
    };
    const load = <T,>(request: () => Promise<T>, label: string, project: (value: T) => Partial<BridgeData>) => {
      const run = () => {
        const startedAt = ++revisionRef.current;
        const generation = (generations.get(label) ?? 0) + 1;
        generations.set(label, generation);
        setIssue(label, null);
        const timer = setTimeout(() => {
          if (generations.get(label) === generation) setIssue(label, '仍在加载，可继续使用其他功能或重试');
        }, BOOT_REQUEST_TIMEOUT_MS);
        timers.add(timer);
        void request().then(value => {
          if (alive && generations.get(label) === generation) {
            update(project(value), startedAt);
            setIssue(label, null);
          }
        }).catch(error => {
          if (generations.get(label) !== generation) return;
          setIssue(label, '加载失败，可重试');
          if (label === '加载应用状态') showLifecycleNotice(lifecycleFailure(error, label));
        }).finally(() => { clearTimeout(timer); timers.delete(timer); });
      };
      jobs.set(label, run);
      run();
    };
    retryInitialDataRef.current = () => {
      for (const issue of stateIssuesRef.current) jobs.get(issue.split('：', 1)[0])?.();
    };
    update({ booted: true });
    load(() => api.getState(), '加载应用状态', runtime => ({ runtime }));
    load(() => api.getTraceStats(), '加载 Trace 统计', traceStats => ({ traceStats }));
    load(() => api.getUpdateState(), '加载更新状态', updateState => ({ updateState }));
    load(() => api.getClaudeModels(), '加载 Claude 模型', claudeModels => ({ claudeModels }));
    load(() => api.getClaudeDesktopSync(), '加载 Claude Desktop 设置', claudeDesktopSync => ({ claudeDesktopSync }));
    load(() => api.getCodexConfig(), '加载 ChatGPT 配置', codexConfig => ({ codexConfig }));
    load(() => api.getCodexEnhancements(), '加载 ChatGPT 增强设置', codexEnhancements => ({ codexEnhancements }));
    load(() => api.getCompatibleServiceConfig(), '加载模型服务配置', compatibleServiceConfig => ({ compatibleServiceConfig }));
    load(() => api.getModelServices(), '加载模型服务', modelServices => ({ modelServices }));
    if (api.getModelClients) load(() => api.getModelClients!(), "加载客户端", modelClients => ({ modelClients }));
    load(() => api.getProviders(), '加载模型服务列表', providers => ({ providers }));

    // Subscriptions
    const unsubState = api.onState(async (incoming) => {
      update({ runtime: incoming });
      // Theme, updater and configuration notices do not change Trace totals.
      // Avoid a full statistics IPC for every unrelated state notification.
      const statsKey = `${incoming.traceRoot}:${incoming.sessions}:${incoming.traces}:${incoming.tracingEnabled}`;
      if (statsKey === lastStatsKey) return;
      lastStatsKey = statsKey;
      const startedAt = ++revisionRef.current;
      const stats = await api.getTraceStats().catch(() => null);
      if (stats && statsKey === lastStatsKey) update({ traceStats: stats }, startedAt);
    });
    const unsubUpdate = api.onUpdateState((incoming) => {
      update({ updateState: incoming });
    });

    const unsubShowUpdate = api.onShowUpdateDetails(() => {
      // Handled via custom event so the shell can react without prop drilling.
      window.dispatchEvent(new CustomEvent('xwxdeck:show-update-details'));
    });

    const metadataChanged = () => {
      for (const label of ['加载 Claude 模型', '加载 ChatGPT 配置', '加载模型服务配置', '加载模型服务列表']) jobs.get(label)?.();
    };
    window.addEventListener('xwxdeck:metadata-changed', metadataChanged);

    // Mark runtime on body for smoke tests.
    document.body.dataset.runtime = isDesktop() ? 'desktop' : 'preview';

    return () => {
      alive = false;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      retryInitialDataRef.current = () => undefined;
      unsubState();
      unsubUpdate();
      unsubShowUpdate();
      window.removeEventListener('xwxdeck:metadata-changed', metadataChanged);
    };
  }, [api, commit]);

  const refreshStats = React.useCallback(async () => {
    const startedAt = ++revisionRef.current;
    try {
      const stats = await api.getTraceStats();
      commit({ traceStats: stats }, startedAt);
    } catch { /* silent */ }
  }, [api, commit]);

  // Trace stop can restore a different direct provider; keep the model page
  // consistent with the configuration that actually committed.
  const tracingEnabled = state.runtime?.tracingEnabled;
  React.useEffect(() => {
    if (tracingEnabled === undefined) return;
    let alive = true;
    const startedAt = ++revisionRef.current;
    void api.getCodexConfig().then(codexConfig => { if (alive) commit({ codexConfig }, startedAt); }).catch(() => undefined);
    void api.getModelServices().then(modelServices => { if (alive) commit({ modelServices }, startedAt); }).catch(() => undefined);
    void api.getProviders().then(providers => { if (alive) commit({ providers }, startedAt); }).catch(() => undefined);
    return () => { alive = false; };
  }, [api, commit, tracingEnabled]);

  const value = React.useMemo(
    (): BridgeState => ({ api, ...state, patch, refreshStats, retryInitialData }),
    [api, state, patch, refreshStats, retryInitialData],
  );

  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}
