import type { ProviderSnapshot } from '../../shared/providers';
import * as React from 'react';
import { getApi, isDesktop } from './api';
import type {
  ClaudeModelSettings,
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
  readonly providers: ProviderSnapshot | null;
  readonly api: ReturnType<typeof getApi>;
  readonly runtime: XwXDeckRuntimeState | null;
  readonly traceStats: ManagerTraceStats | null;
  readonly updateState: XwXDeckUpdateState | null;
  readonly claudeModels: ClaudeModelSettings | null;
  readonly codexConfig: CodexConfigSnapshot | null;
  readonly codexEnhancements: CodexEnhancementsSnapshot | null;
  readonly compatibleServiceConfig: CompatibleServiceConfigSnapshot | null;
  readonly modelServices: ModelServiceSnapshot | null;
  readonly modelCatalog: readonly ModelCatalogEntry[];
  readonly booted: boolean;
  /** Publish committed API results so every page observes one coherent snapshot. */
  readonly patch: (partial: BridgePatch) => void;
  /** Fetch fresh trace stats and push them into the store. */
  readonly refreshStats: () => Promise<void>;
}

type BridgeData = Omit<BridgeState, 'api' | 'patch' | 'refreshStats'>;
export type BridgePatch = Partial<Omit<BridgeData, 'booted'>>;

const BridgeContext = React.createContext<BridgeState | null>(null);

export function useBridge(): BridgeState {
  const ctx = React.useContext(BridgeContext);
  if (!ctx) throw new Error('useBridge must be used inside BridgeProvider');
  return ctx;
}

interface Props {
  readonly children: React.ReactNode;
  readonly showToast: (msg: string) => void;
}

export function BridgeProvider({ children, showToast }: Props): React.ReactElement {
  const api = React.useMemo(() => getApi(), []);
  const [state, setState] = React.useState<BridgeData>({
    providers: null,
    runtime: null,
    traceStats: null,
    updateState: null,
    claudeModels: null,
    codexConfig: null,
    codexEnhancements: null,
    compatibleServiceConfig: null,
    modelServices: null,
    modelCatalog: [],
    booted: false,
  });

  const patch = React.useCallback((partial: BridgePatch) => {
    setState(previous => ({ ...previous, ...partial }));
  }, []);

  React.useEffect(() => {
    let alive = true;
    const update = (partial: Partial<BridgeData>) => {
      if (alive) setState(prev => ({ ...prev, ...partial }));
    };

    const boot = async () => {
      const results = await Promise.allSettled([
        api.getState(),
        api.getTraceStats(),
        api.getUpdateState(),
        api.getClaudeModels(),
        api.getCodexConfig(),
        api.getCodexEnhancements(),
        api.getCompatibleServiceConfig(),
        api.getModelServices(),
        api.getProviders(),
      ]);

      const [runtimeR, statsR, updateR, claudeR, codexR, enhanR, paperR, servicesR, providersR] = results;
      type MutablePatch = { -readonly [K in keyof BridgeData]?: BridgeData[K] };
      const patch: MutablePatch = { booted: true };
      if (runtimeR.status === 'fulfilled') patch.runtime = runtimeR.value;
      else showToast(`状态加载失败: ${(runtimeR.reason as Error).message}`);
      if (statsR.status === 'fulfilled') patch.traceStats = statsR.value;
      if (updateR.status === 'fulfilled') patch.updateState = updateR.value;
      if (claudeR.status === 'fulfilled') patch.claudeModels = claudeR.value;
      if (codexR.status === 'fulfilled') patch.codexConfig = codexR.value;
      if (enhanR.status === 'fulfilled') patch.codexEnhancements = enhanR.value;
      if (paperR.status === 'fulfilled') patch.compatibleServiceConfig = paperR.value;
      if (servicesR.status === 'fulfilled') patch.modelServices = servicesR.value;
      if (providersR.status === 'fulfilled') patch.providers = providersR.value;
      update(patch);
    };

    void boot();

    // Subscriptions
    const unsubState = api.onState(async (incoming) => {
      update({ runtime: incoming });
      const stats = await api.getTraceStats().catch(() => null);
      if (stats) update({ traceStats: stats });
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

  const value = React.useMemo(
    (): BridgeState => ({ api, ...state, patch, refreshStats }),
    [api, state, patch, refreshStats],
  );

  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}
