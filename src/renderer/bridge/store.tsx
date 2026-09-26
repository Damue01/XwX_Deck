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
import { operationError } from '@/lib/errors';

export interface BridgeState {
  readonly providers: ProviderSnapshot | null;
  readonly api: ReturnType<typeof getApi>;
  readonly runtime: XwXDeckRuntimeState | null;
  readonly traceStats: ManagerTraceStats | null;
  readonly updateState: XwXDeckUpdateState | null;
  readonly claudeModels: ClaudeModelSettings | null;
  readonly claudeDesktopSync: ClaudeDesktopSyncSnapshot | null;
  readonly codexConfig: CodexConfigSnapshot | null;
  readonly codexEnhancements: CodexEnhancementsSnapshot | null;
  readonly compatibleServiceConfig: CompatibleServiceConfigSnapshot | null;
  readonly modelServices: ModelServiceSnapshot | null;
  readonly modelCatalog: readonly ModelCatalogEntry[];
  readonly loadIssues: readonly string[];
  readonly booted: boolean;
  /** Publish committed API results so every page observes one coherent snapshot. */
  readonly patch: (partial: BridgePatch) => void;
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
    providers: null,
    runtime: null,
    traceStats: null,
    updateState: null,
    claudeModels: null,
    claudeDesktopSync: null,
    codexConfig: null,
    codexEnhancements: null,
    compatibleServiceConfig: null,
    modelServices: null,
    modelCatalog: [],
    loadIssues: [],
    booted: false,
  });
  const stateIssuesRef = React.useRef<readonly string[]>([]);
  stateIssuesRef.current = state.loadIssues;
  const retryInitialDataRef = React.useRef<() => void>(() => undefined);
  const retryInitialData = React.useCallback(() => retryInitialDataRef.current(), []);

  const patch = React.useCallback((partial: BridgePatch) => {
    setState(previous => ({ ...previous, ...partial }));
  }, []);

  React.useEffect(() => {
    let alive = true;
    let lastStatsKey = '';
    const update = (partial: Partial<BridgeData>) => {
      if (alive) setState(prev => ({ ...prev, ...partial }));
    };

    // A slow client IPC must not hold back data already available from the
    // other clients. Each result updates its own slice as soon as it arrives.
    const jobs = new Map<string, () => void>();
    const generations = new Map<string, number>();
    const setIssue = (label: string, issue: string | null) => {
      if (!alive) return;
      setState(previous => ({
        ...previous,
        loadIssues: issue
          ? [...previous.loadIssues.filter(item => !item.startsWith(`${label}：`)), `${label}：${issue}`]
          : previous.loadIssues.filter(item => !item.startsWith(`${label}：`))
      }));
    };
    const load = <T,>(request: () => Promise<T>, label: string, apply: (value: T) => void) => {
      const run = () => {
        const generation = (generations.get(label) ?? 0) + 1;
        generations.set(label, generation);
        setIssue(label, null);
        const timer = setTimeout(() => {
          if (generations.get(label) === generation) setIssue(label, '仍在加载，可继续使用其他功能或重试');
        }, BOOT_REQUEST_TIMEOUT_MS);
        void request().then(value => {
          if (alive && generations.get(label) === generation) {
            apply(value);
            setIssue(label, null);
          }
        }).catch(error => {
          if (generations.get(label) !== generation) return;
          setIssue(label, '加载失败，可重试');
          if (label === '加载应用状态') showLifecycleNotice(lifecycleFailure(error, label));
        }).finally(() => clearTimeout(timer));
      };
      jobs.set(label, run);
      run();
    };
    retryInitialDataRef.current = () => {
      for (const issue of stateIssuesRef.current) jobs.get(issue.split('：', 1)[0])?.();
    };
    update({ booted: true });
    load(() => api.getState(), '加载应用状态', runtime => update({ runtime }));
    load(() => api.getTraceStats(), '加载 Trace 统计', traceStats => update({ traceStats }));
    load(() => api.getUpdateState(), '加载更新状态', updateState => update({ updateState }));
    load(() => api.getClaudeModels(), '加载 Claude 模型', claudeModels => update({ claudeModels }));
    load(() => api.getClaudeDesktopSync(), '加载 Claude Desktop 设置', claudeDesktopSync => update({ claudeDesktopSync }));
    load(() => api.getCodexConfig(), '加载 ChatGPT 配置', codexConfig => update({ codexConfig }));
    load(() => api.getCodexEnhancements(), '加载 ChatGPT 增强设置', codexEnhancements => update({ codexEnhancements }));
    load(() => api.getCompatibleServiceConfig(), '加载模型服务配置', compatibleServiceConfig => update({ compatibleServiceConfig }));
    load(() => api.getModelServices(), '加载模型服务', modelServices => update({ modelServices }));
    load(() => api.getProviders(), '加载模型服务列表', providers => update({ providers }));

    // Subscriptions
    const unsubState = api.onState(async (incoming) => {
      update({ runtime: incoming });
      // Theme, updater and configuration notices do not change Trace totals.
      // Avoid a full statistics IPC for every unrelated state notification.
      const statsKey = `${incoming.traceRoot}:${incoming.sessions}:${incoming.traces}:${incoming.tracingEnabled}`;
      if (statsKey === lastStatsKey) return;
      lastStatsKey = statsKey;
      const stats = await api.getTraceStats().catch(() => null);
      if (stats && statsKey === lastStatsKey) update({ traceStats: stats });
    });
    const unsubUpdate = api.onUpdateState((incoming) => {
      update({ updateState: incoming });
    });

    const unsubShowUpdate = api.onShowUpdateDetails(() => {
      // Handled via custom event so the shell can react without prop drilling.
      window.dispatchEvent(new CustomEvent('xwxdeck:show-update-details'));
    });

    // Mark runtime on body for smoke tests.
    document.body.dataset.runtime = isDesktop() ? 'desktop' : 'preview';

    return () => {
      alive = false;
      retryInitialDataRef.current = () => undefined;
      unsubState();
      unsubUpdate();
      unsubShowUpdate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const refreshStats = React.useCallback(async () => {
    try {
      const stats = await api.getTraceStats();
      setState(prev => ({ ...prev, traceStats: stats }));
    } catch { /* silent */ }
  }, [api]);

  // Trace stop can restore a different direct provider; keep the model page
  // consistent with the configuration that actually committed.
  const tracingEnabled = state.runtime?.tracingEnabled;
  React.useEffect(() => {
    if (tracingEnabled === undefined) return;
    let alive = true;
    void api.getCodexConfig().then(codexConfig => { if (alive) patch({ codexConfig }); }).catch(() => undefined);
    void api.getModelServices().then(modelServices => { if (alive) patch({ modelServices }); }).catch(() => undefined);
    void api.getProviders().then(providers => { if (alive) patch({ providers }); }).catch(() => undefined);
    return () => { alive = false; };
  }, [api, patch, tracingEnabled]);

  const value = React.useMemo(
    (): BridgeState => ({ api, ...state, patch, refreshStats, retryInitialData }),
    [api, state, patch, refreshStats, retryInitialData],
  );

  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}
