import { t, getLanguage, useLanguage } from '@/lib/i18n';
import { ProviderPicker } from './ProviderPicker';
import { SlidersHorizontal } from 'lucide-react';
import { ManageClientsDialog } from './ManageClientsDialog';
import { ProviderIcon } from '../settings/ProviderIcon';
import { ClientDownloads } from '../settings/ProviderSetupShortcuts';
import { CLIENT_DOWNLOADS, MODEL_CLIENT_ADDED_EVENT, modelClientRoute, normalizeModelClients, type DownloadClientId } from '../../../shared/clientDownloads';
import { Tabs, TabsList, TabsTab, TabsPanel } from '@/components/ui/tabs';
import * as React from 'react';
import type {
  ClaudeModelSettings,
  CodexConfigSnapshot,
  CodexEnhancementsSnapshot,
  ModelCatalogEntry,
} from '@/bridge/types';
import { useBridge } from '@/bridge/store';
import { clearLifecycleNotice, closeToast, openProviderSettings, REPAIR_CODEX_CONFIG_EVENT, RESTORE_CLIENT_CONFIG_EVENT, runNoticeAction, showErrorToast, showLifecycleNotice, showToast } from '@/lib/toast';
import { lifecycleFailure } from '../../../shared/lifecycleNotice';
import { normalizeErrorMessage } from '../../../shared/errors';
import { modelCatalogFailureMessage } from '../../../shared/modelCatalogError';
import { waitForModelCatalog } from '../../../shared/modelCatalogWait';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { ModelPicker, type ModelPickerNote } from './ModelPicker';
import { isClaudeDesktopCompatibleModelId } from '../../../shared/claudeDesktopModelId';
import { CodexEnhancements } from './CodexEnhancements';
import { ClaudeEnhancements } from './ClaudeEnhancements';
import { isKnownNonConversationalModel, isOfficialCodexModelId, providerRequiresTrace, resolveClaudeModelProtocol } from '../../../main/app/codexProtocolPolicy';
import {
  codexContextVariants,
  formatContextWindow,
  type CodexContextVariant
} from '../../../shared/codexContextVariants';

type ClientTab = 'claude' | 'codex';
const CLAUDE_DESKTOP_TRACE_TOAST_ID = 'claude-desktop-needs-trace';
type ClaudeRole = keyof ClaudeModelSettings;

interface Props {
  readonly active: boolean;
}

const CLAUDE_ROLES: Array<{ key: ClaudeRole; label: string }> = [
  { key: 'fable', label: 'Fable' },
  { key: 'opus', label: 'Opus' },
  { key: 'sonnet', label: 'Sonnet' },
  { key: 'haiku', label: 'Haiku' },
];

const EXTERNAL_CODEX_CATALOG_DESCRIPTION = '检测到其他工具留下的模型配置。请确认原工具已经退出，再重新接管。';

function providerFailureAction(error: unknown, providerId: string | null, retryLabel: string, retry: () => void): React.ComponentPropsWithoutRef<'button'> {
  if (providerId && normalizeErrorMessage(error).includes(t('请先保存服务地址和密钥'))) {
    return { type: 'button', children: t('去配置'), onClick: () => openProviderSettings(providerId) };
  }
  return { type: 'button', children: retryLabel, onClick: retry };
}

export function ModelsPage({ active }: Props): React.ReactElement {
  useLanguage();
  const bridge = useBridge();
  const confirm = useConfirm();
  const [selectedClient, setSelectedClient] = React.useState<DownloadClientId>('claude');
  const [managingClients, setManagingClients] = React.useState(false);
  const clientTabsList = React.useRef<HTMLDivElement | null>(null);
  const shownClients = normalizeModelClients(bridge.modelClients);
  const clientRoute = modelClientRoute(selectedClient);
  const activeTab: ClientTab = clientRoute ?? 'claude';
  const clientActive = active && clientRoute !== null && shownClients.includes(selectedClient);
  const addedClients = shownClients.filter(id => modelClientRoute(id) === null);
  React.useEffect(() => {
    if (!shownClients.includes(selectedClient) && shownClients.length) setSelectedClient(shownClients[0]);
  }, [bridge.modelClients, selectedClient]);
  React.useEffect(() => {
    if (!active || !clientTabsList.current) return;
    const reveal = () => document.getElementById(`client-tab-${selectedClient}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    reveal();
    const resize = new ResizeObserver(reveal);
    resize.observe(clientTabsList.current);
    return () => resize.disconnect();
  }, [active, selectedClient, bridge.modelClients]);
  React.useEffect(() => {
    const added = (event: Event) => {
      const id = (event as CustomEvent<DownloadClientId>).detail;
      if (!CLIENT_DOWNLOADS.some(client => client.id === id)) return;
      setSelectedClient(modelClientRoute(id) ?? id);
      window.dispatchEvent(new CustomEvent('xwxdeck:navigate', { detail: 'models' }));
    };
    window.addEventListener(MODEL_CLIENT_ADDED_EVENT, added);
    return () => window.removeEventListener(MODEL_CLIENT_ADDED_EVENT, added);
  }, []);
  const clientManagerTrigger = React.useRef<HTMLButtonElement | null>(null);
  const [claudeModels, setClaudeModels] = React.useState<ClaudeModelSettings | null>(bridge.claudeModels);
  const [codexConfig, setCodexConfig] = React.useState<CodexConfigSnapshot | null>(bridge.codexConfig);
  const [enhancements, setEnhancements] = React.useState<CodexEnhancementsSnapshot | null>(bridge.codexEnhancements);
  const [enhancementsLoadFailed, setEnhancementsLoadFailed] = React.useState(false);
  const [enhancementsRetry, retryEnhancements] = React.useReducer((value: number) => value + 1, 0);
  const [claudeDesktopSync, setClaudeDesktopSync] = React.useState(bridge.claudeDesktopSync);
  const [catalog, setCatalog] = React.useState<readonly ModelCatalogEntry[]>(bridge.modelCatalog);
  const [claudeProviderCatalog, setClaudeProviderCatalog] = React.useState<readonly ModelCatalogEntry[]>([]);
  const claudeOperationRef = React.useRef(false);
  const [busyClaude, setBusyClaude] = React.useState(false);
  const [busyCodex, setBusyCodex] = React.useState(false);
  const codexOperationRef = React.useRef(false);
  const providerSwitchGeneration = React.useRef({ codex: 0, claude: 0 });
  const [providerChoice, setProviderChoice] = React.useState<Partial<Record<ClientTab, string | null>>>({});
  const codexProviderId = providerChoice.codex !== undefined ? providerChoice.codex : bridge.providers?.active.codex ?? null;
  const claudeProviderId = providerChoice.claude !== undefined ? providerChoice.claude : bridge.providers?.active.claude ?? null;
  const claudeCatalogRequest = React.useRef(0);
  const codexCatalogRequest = React.useRef(0);
  const repairingCodexRef = React.useRef(false);
  const visibleClient = React.useRef<ClientTab | null>(null);
  visibleClient.current = clientActive ? activeTab : null;
  const currentProviderIds = React.useRef({ codex: codexProviderId, claude: claudeProviderId });
  currentProviderIds.current = { codex: codexProviderId, claude: claudeProviderId };
  const selectionReadRequest = React.useRef({ codex: 0, claude: 0 });
  const unsavedClaudeModels = React.useRef<Partial<ClaudeModelSettings>>({});
  // Model values use the guarded reads below. Unscoped store/bootstrap reads
  // cannot identify which provider or user action they preceded.
  React.useEffect(() => { if (bridge.codexEnhancements) setEnhancements(bridge.codexEnhancements); }, [bridge.codexEnhancements]);
  React.useEffect(() => { if (bridge.claudeDesktopSync) setClaudeDesktopSync(bridge.claudeDesktopSync); }, [bridge.claudeDesktopSync]);

  // A failed bootstrap read must recover on page entry or after config repair.
  // Keep this independent of provider writes and their foreground wait budget.
  React.useEffect(() => {
    if (!clientActive || activeTab !== 'codex' || enhancements) return;
    let current = true;
    setEnhancementsLoadFailed(false);
    void bridge.api.getCodexEnhancements().then(value => {
      if (!current) return;
      setEnhancements(value);
      bridge.patch({ codexEnhancements: value });
    }).catch(() => { if (current) setEnhancementsLoadFailed(true); });
    return () => { current = false; };
  }, [clientActive, activeTab, enhancements, enhancementsRetry, bridge.api, bridge.patch, bridge.codexConfig]);

  // Re-entering the page reads current settings, without allowing a read that
  // started before a user action to replace that action's result.
  const refreshModelSelection = React.useCallback(async (client: ClientTab, providerId: string | null) => {
    const request = ++selectionReadRequest.current[client];
    const generation = providerSwitchGeneration.current[client];
    const isCurrent = () => generation === providerSwitchGeneration.current[client]
      && request === selectionReadRequest.current[client]
      && currentProviderIds.current[client] === providerId;
    try {
      if (client === 'claude') {
        const models = await bridge.api.getClaudeModels();
        if (isCurrent()) { setClaudeModels({ ...models, ...unsavedClaudeModels.current }); bridge.patch({ claudeModels: models }); }
      } else {
        const config = await bridge.api.getCodexConfig();
        if (isCurrent()) { setCodexConfig(config); bridge.patch({ codexConfig: config }); }
      }
      return isCurrent();
    } catch (error) {
      if (isCurrent() && visibleClient.current === client) showErrorToast(t('模型配置暂未读取，服务选择保留'), error, undefined, {
        actionProps: { type: 'button', children: t('重试'), onClick: () => {
          if (isCurrent()) void refreshModelSelection(client, providerId);
        } }
      });
      return false;
    }
  }, [bridge.api, bridge.patch]);
  React.useEffect(() => {
    const client = activeTab;
    const providerId = client === 'claude' ? claudeProviderId : codexProviderId;
    const writing = client === 'claude' ? claudeOperationRef.current : codexOperationRef.current;
    if (clientActive && !writing && bridge.providers?.active[client] === providerId) {
      void refreshModelSelection(client, providerId);
    }
  }, [clientActive, activeTab, claudeProviderId, codexProviderId, bridge.providers, refreshModelSelection]);

  const repairCodexConfig = React.useCallback(async () => {
    if (repairingCodexRef.current) return;
    const requestedAt = providerSwitchGeneration.current.codex;
    if (!await confirm({
      title: t('修复 ChatGPT 配置？'),
      body: t('会先备份原 config.toml，再根据模型页已保存的服务和模型生成最小可用配置，并验证修复结果。'),
      confirmText: t('备份并修复')
    }) || requestedAt !== providerSwitchGeneration.current.codex) return;
    const generation = ++providerSwitchGeneration.current.codex;
    const isCurrent = () => generation === providerSwitchGeneration.current.codex;
    repairingCodexRef.current = true;
    codexOperationRef.current = true;
    setBusyCodex(true);
    showToast(t('正在修复 ChatGPT 配置…'), 'info');
    let result: Awaited<ReturnType<typeof bridge.api.repairInvalidCodexConfiguration>> | undefined;
    try {
      result = await bridge.api.repairInvalidCodexConfiguration();
      if (!isCurrent()) return;
      const [config, providers, services, runtime] = await Promise.all([
        bridge.api.getCodexConfig(),
        bridge.api.getProviders(),
        bridge.api.getModelServices(),
        bridge.api.getState()
      ]);
      if (!isCurrent()) return;
      setCodexConfig(config);
      bridge.patch({ codexConfig: config, providers, modelServices: services, runtime });
      clearLifecycleNotice();
      if (result.conflicts.length) {
        showToast(t('ChatGPT 配置已修复，部分选择未恢复'), 'warning', undefined, {
          description: result.conflicts.join('；')
        });
      } else {
        showToast(runtime.chatGptRestartRecommended
          ? t('ChatGPT 配置已修复，重启后生效')
          : result.mode === 'compatible' ? t('ChatGPT 配置已修复') : t('ChatGPT 官方配置已修复'), 'success');
      }
    } catch (error) {
      if (!isCurrent()) return;
      if (result) {
        showToast(t('ChatGPT 配置已写入并验证，页面状态暂未刷新'), 'warning', undefined, {
          description: result.conflicts.length
            ? result.conflicts.join('；')
            : t('重新打开模型页查看；正在运行的 ChatGPT 可能需要重启。')
        });
      } else {
        showErrorToast(t('修复 ChatGPT 配置失败'), error, undefined, {
          actionProps: { type: 'button', children: t('修复'), onClick: () => void repairCodexConfig() }
        });
      }
    } finally {
      repairingCodexRef.current = false;
      if (isCurrent()) { codexOperationRef.current = false; setBusyCodex(false); }
    }
  }, [bridge.api, bridge.patch, confirm]);
  const repairProviderSwitch = async (client: ClientTab, providerId: string | null) => {
    const requestedAt = providerSwitchGeneration.current[client];
    if (!await confirm({
      title: t("修复 {0} 服务切换？", client === 'codex' ? 'ChatGPT' : 'Claude'),
      body: t('会备份当前最新配置，保留无关设置，再写入选择的目标服务。'),
      confirmText: t('备份并修复')
    }) || requestedAt !== providerSwitchGeneration.current[client]) return;
    const generation = ++providerSwitchGeneration.current[client];
    const isCurrent = () => generation === providerSwitchGeneration.current[client];
    const startedAt = Date.now();
    const lock = client === 'codex' ? codexOperationRef : claudeOperationRef;
    const setBusy = client === 'codex' ? setBusyCodex : setBusyClaude;
    lock.current = true; setBusy(true);
    currentProviderIds.current[client] = providerId;
    setProviderChoice(previous => ({ ...previous, [client]: providerId }));
    let written = false;
    const timer = setTimeout(() => {
      if (!isCurrent()) return;
      lock.current = false; setBusy(false);
      if (!written) showToast(t('仍在写入，可继续操作'), 'info');
    }, 2_000);
    try {
      const providers = await bridge.api.repairClientProviderSwitch({ client, providerId });
      if (!isCurrent()) return;
      written = true;
      bridge.patch({ providers });
      let modelReadFailed = false;
      void refreshModelSelection(client, providerId).then(ok => { modelReadFailed = !ok; });
      const result = await waitForModelCatalog(client === 'codex'
        ? loadCodexCatalog(false, true, providerId)
        : loadClaudeCatalog(providerId, true), startedAt);
      if (isCurrent() && result !== 'failed' && !modelReadFailed) showToast(t('模型服务配置已修复'), result === 'ready' ? 'success' : 'info', undefined, {
        description: result === 'timeout' ? t('列表仍在加载，服务配置已保存，可继续操作。') : undefined
      });
    } catch (error) {
      if (isCurrent()) showErrorToast(t('目标选择保留，配置修复未完成'), error, undefined, {
        actionProps: providerFailureAction(error, providerId, t('重试'), () => void repairProviderSwitch(client, providerId))
      });
    } finally {
      clearTimeout(timer);
      if (isCurrent()) { lock.current = false; setBusy(false); }
    }
  };
  React.useEffect(() => {
    const handle = () => { void repairCodexConfig(); };
    window.addEventListener(REPAIR_CODEX_CONFIG_EVENT, handle);
    return () => window.removeEventListener(REPAIR_CODEX_CONFIG_EVENT, handle);
  }, [repairCodexConfig]);

  const loadCodexCatalog = React.useCallback(async (refresh: boolean, notify: boolean, providerId = codexProviderId): Promise<boolean> => {
    const request = ++codexCatalogRequest.current;
    const isCurrent = () => request === codexCatalogRequest.current && currentProviderIds.current.codex === providerId;
    const publish = (list: readonly ModelCatalogEntry[]) => {
      if (!isCurrent()) return false;
      setCatalog(list);
      bridge.patch({ modelCatalog: list });
      return true;
    };
    const reportFailure = (error: unknown, background = false) => {
      if (!isCurrent() || /服务连接已变化/.test(normalizeErrorMessage(error))) return;
      if (notify && visibleClient.current === 'codex') showToast(
        background ? t('模型列表刷新失败，已保留原列表') : t('模型列表未加载'), 'warning', undefined, {
          description: modelCatalogFailureMessage(error),
          actionProps: providerFailureAction(error, providerId, t('重试列表'), () => {
            if (!isCurrent()) return;
            closeToast();
            void loadCodexCatalog(true, true, providerId);
          })
        }
      );
    };
    try {
      const list = await bridge.api.fetchModels({ source: 'active', refresh, expectedProviderId: providerId });
      if (!publish(list)) return false;
      if (!refresh && providerId) {
        // Capability enrichment is background work, outside the loading deadline.
        void bridge.api.fetchModels({ source: 'active', refresh: true, expectedProviderId: providerId })
          .then(publish).catch(error => {
            // Let the switch-completed notice finish before reporting a fast failure.
            setTimeout(() => reportFailure(error, true), 0);
          });
      }
      return true;
    } catch (error) {
      reportFailure(error);
      return false;
    }
  }, [bridge.api, bridge.patch, codexProviderId]);

  const loadClaudeCatalog = React.useCallback(async (providerId: string | null, notify: boolean, refresh = false): Promise<boolean> => {
    const request = ++claudeCatalogRequest.current;
    const isCurrent = () => request === claudeCatalogRequest.current && currentProviderIds.current.claude === providerId;
    if (!providerId) { setClaudeProviderCatalog([]); return true; }
    const publish = (list: readonly ModelCatalogEntry[]) => {
      if (!isCurrent()) return false;
      setClaudeProviderCatalog(list);
      return true;
    };
    const reportFailure = (error: unknown, background = false) => {
      if (!isCurrent()) return;
      if (notify && visibleClient.current === 'claude') showToast(
        background ? t('模型列表刷新失败，已保留原列表') : t('模型列表未加载'), 'warning', undefined, {
          description: modelCatalogFailureMessage(error),
          actionProps: providerFailureAction(error, providerId, t('重试列表'), () => {
            if (!isCurrent()) return;
            closeToast();
            void loadClaudeCatalog(providerId, true, true);
          })
        }
      );
    };
    try {
      const list = await bridge.api.fetchProviderModels({ providerId, refresh });
      if (!publish(list)) return false;
      if (!refresh) {
        // Show the cache immediately, then discover newly published models.
        void bridge.api.fetchProviderModels({ providerId, refresh: true })
          .then(publish).catch(error => {
            setTimeout(() => reportFailure(error, true), 0);
          });
      }
      return true;
    } catch (error) {
      reportFailure(error);
      return false;
    }
  }, [bridge.api]);

  // A tab change does not change the target service. Keep its pending request
  // alive; otherwise returning during a switch can leave the list empty.
  React.useEffect(() => {
    if (clientActive && activeTab === 'codex' && !codexOperationRef.current) void loadCodexCatalog(false, true);
  }, [loadCodexCatalog, clientActive, activeTab]);

  React.useEffect(() => {
    if (clientActive && activeTab === 'claude' && !claudeOperationRef.current) void loadClaudeCatalog(claudeProviderId, true);
  }, [loadClaudeCatalog, claudeProviderId, clientActive, activeTab]);
  React.useEffect(() => () => {
    codexCatalogRequest.current += 1;
    claudeCatalogRequest.current += 1;
    providerSwitchGeneration.current.codex += 1;
    providerSwitchGeneration.current.claude += 1;
  }, []);

  const configuredIds = React.useMemo(() => {
    const ids = new Set<string>();
    const id = codexConfig?.mode === 'compatible' ? codexConfig.compatible.model : codexConfig?.officialModel;
    if (id) ids.add(id);
    return ids;
  }, [codexConfig]);

  // Merge configured-but-uncatalogued models so they remain selectable.
  const mergedCatalog = React.useMemo(() => {
    const byId = new Map<string, ModelCatalogEntry>();
    for (const m of catalog) byId.set(m.id, m);
    for (const id of configuredIds) {
      if (!byId.has(id)) byId.set(id, { id, vendor: t('已配置'), protocols: [], clients: [] });
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }, [catalog, configuredIds, getLanguage()]);

  // Live CompatibleService verification on 2026-07-28: all 31 models returned by the
  // Anthropic directory accepted Messages, while all 29 extra name-matched
  // models failed with no upstream channel. Endpoint membership is therefore
  // the automatic Claude boundary; free-text custom ids remain available.
  // Models without Messages are listed too; the local Gateway converts them.
  const claudeProviderAdapter = bridge.providers?.connections.find(provider => provider.id === claudeProviderId)?.adapter;
  const claudeBridgedIds = React.useMemo(() => new Set(claudeProviderCatalog.filter(m => {
    const protocol = resolveClaudeModelProtocol({ adapter: claudeProviderAdapter }, m);
    return protocol === 'responses' || protocol === 'chat-completions';
  }).map(m => m.id)), [claudeProviderCatalog, claudeProviderAdapter]);
  const claudeCatalog = React.useMemo(() => {
    const byId = new Map(claudeProviderCatalog.filter(m =>
      resolveClaudeModelProtocol({ adapter: claudeProviderAdapter }, m) !== undefined
    ).map(model => [model.id, model]));
    for (const id of Object.values(claudeModels ?? {})) {
      if (id && !isKnownNonConversationalModel(id) && !byId.has(id)) {
        byId.set(id, { id, vendor: t('已配置'), protocols: [], clients: [] });
      }
    }
    return [...byId.values()];
  }, [claudeProviderCatalog, claudeProviderAdapter, claudeModels, getLanguage()]);
  const codexCatalog = mergedCatalog.filter(m =>
    !isKnownNonConversationalModel(m.id)
    && (m.clients.includes('codex') || m.vendor === '已配置'));
  const activeCodexCatalog = React.useMemo(() => (
    codexConfig?.mode === 'compatible'
      ? codexCatalog
      : codexCatalog.filter(model => isOfficialCodexModelId(model.id))
  ), [codexCatalog, codexConfig?.mode]);
  const codexChoices = React.useMemo(() => {
    const choices = activeCodexCatalog.flatMap(model => (
      codexContextVariants(model).map(variant => ({
        variant,
        catalogEntry: { ...model, id: variant.label }
      }))
    ));
    const currentModelId = codexConfig
      ? codexConfig.mode === 'compatible' ? codexConfig.compatible.model : codexConfig.officialModel
      : '';
    const currentWindow = codexConfig?.modelContextWindow;
    const currentModel = activeCodexCatalog.find(model => model.id === currentModelId);
    if (
      currentModel
      && Number.isSafeInteger(currentWindow)
      && (currentWindow ?? 0) > 0
      && !choices.some(choice => (
        choice.variant.modelId === currentModelId
        && choice.variant.contextWindow === currentWindow
      ))
    ) {
      choices.push({
        variant: {
          modelId: currentModelId,
          label: `${currentModelId}[${formatContextWindow(currentWindow!)}]`,
          contextWindow: currentWindow!
        },
        catalogEntry: { ...currentModel, id: `${currentModelId}[${formatContextWindow(currentWindow!)}]` }
      });
    }
    return choices;
  }, [activeCodexCatalog, codexConfig]);
  const codexChoiceByLabel = React.useMemo(() => new Map(
    codexChoices.map(choice => [choice.variant.label, choice.variant] as const)
  ), [codexChoices]);
  const codexChoiceCatalog = React.useMemo(
    () => codexChoices.map(choice => choice.catalogEntry),
    [codexChoices]
  );

  const claudeDesktopSyncEnabled = claudeDesktopSync?.enabled === true;
  const claudeTraceEnabled = bridge.runtime?.tracingEnabled === true;
  const handleClaudeModelChange = React.useCallback(async (role: ClaudeRole, modelId: string) => {
    if (claudeOperationRef.current) return;
    const generation = ++providerSwitchGeneration.current.claude;
    claudeOperationRef.current = true; setBusyClaude(true);
    unsavedClaudeModels.current = { ...unsavedClaudeModels.current, [role]: modelId };
    setClaudeModels(previous => ({ fable: '', opus: '', sonnet: '', haiku: '', ...previous, [role]: modelId }));
    try {
      const updated = await bridge.api.updateClaudeModels({ [role]: modelId, expectedProviderId: claudeProviderId });
      if (generation !== providerSwitchGeneration.current.claude) return;
      delete unsavedClaudeModels.current[role];
      setClaudeModels({ ...updated, ...unsavedClaudeModels.current });
      bridge.patch({ claudeModels: updated });
      if (!claudeTraceEnabled && claudeBridgedIds.has(modelId)) {
        showToast(t('Claude 模型已保存'), 'info', CLAUDE_DESKTOP_TRACE_TOAST_ID, {
          description: t('此模型需要协议转换，开启 Trace 后 Claude CLI 和 Claude Desktop 才能使用。'),
          actionProps: { type: 'button', children: t('开启 Trace'), onClick: () => runNoticeAction('start-trace') }
        });
      } else if (claudeDesktopSyncEnabled && !claudeTraceEnabled && !isClaudeDesktopCompatibleModelId(modelId)) {
        // CLI uses the saved model now; Desktop lists it only while Trace forwards.
        showToast(t('Claude 模型已保存'), 'info', CLAUDE_DESKTOP_TRACE_TOAST_ID, {
          description: t('Claude CLI 立即生效；Claude Desktop 在 Trace 开启后才会显示此模型。'),
          actionProps: { type: 'button', children: t('开启 Trace'), onClick: () => runNoticeAction('start-trace') }
        });
      } else {
        showToast(t('Claude 模型已保存'), 'success');
      }
    } catch (error) {
      if (generation === providerSwitchGeneration.current.claude) showErrorToast(t('Claude 模型未完全写入，选择已保留'), error, undefined, {
        actionProps: { type: 'button', children: t('重试'), onClick: () => {
          if (generation === providerSwitchGeneration.current.claude) void handleClaudeModelChange(role, modelId);
        } }
      });
    } finally {
      if (generation === providerSwitchGeneration.current.claude) { claudeOperationRef.current = false; setBusyClaude(false); }
    }
  }, [bridge.api, bridge.patch, claudeProviderId, claudeDesktopSyncEnabled, claudeTraceEnabled, claudeBridgedIds]);
  const claudeModelNote = React.useCallback((modelId: string): ModelPickerNote | undefined => (
    claudeBridgedIds.has(modelId)
      ? { label: t('需 Trace'), hint: t('需要协议转换：Claude CLI 和 Claude Desktop 都需要开启 Trace。') }
      : claudeDesktopSyncEnabled && !isClaudeDesktopCompatibleModelId(modelId)
        ? { label: t('需 Trace'), hint: t('Claude CLI 可直接使用；Claude Desktop 需要开启 Trace。') }
        : undefined
  ), [claudeDesktopSyncEnabled, claudeBridgedIds]);

  const handleProviderChange = async (
    client: ClientTab,
    providerId: string | null,
    takeOverExternalConfig = false
  ) => {
    let startedAt = Date.now();
    const generation = ++providerSwitchGeneration.current[client];
    const isCurrent = () => generation === providerSwitchGeneration.current[client];
    const lock = client === 'codex' ? codexOperationRef : claudeOperationRef;
    const setBusy = client === 'codex' ? setBusyCodex : setBusyClaude;
    const previousId = client === 'codex' ? codexProviderId : claudeProviderId;
    lock.current = true;
    setBusy(true);
    currentProviderIds.current[client] = providerId;
    setProviderChoice(previous => ({ ...previous, [client]: providerId }));
    if (client === 'codex') {
      codexCatalogRequest.current += 1;
      setCatalog([]);
      setCodexConfig(null);
    } else {
      claudeCatalogRequest.current += 1;
      setClaudeProviderCatalog([]);
      unsavedClaudeModels.current = {};
      setClaudeModels(bridge.providers?.connections.find(provider => provider.id === providerId)?.claudeModels ?? null);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let written = false;
    try {
      if (client === 'codex' && !takeOverExternalConfig && codexConfig?.configOwnership === 'external') {
        const accepted = await confirm({
          title: t('接管 ChatGPT 配置？'),
          body: t('会备份当前配置，保留无关设置，再写入你选择的服务。官方登录文件保持不变。'),
          confirmText: t('备份并切换'),
          cancelText: t('取消')
        });
        if (!isCurrent()) return;
        if (!accepted) {
          currentProviderIds.current[client] = previousId;
          setProviderChoice(previous => ({ ...previous, [client]: previousId }));
          setCodexConfig(codexConfig);
          void loadCodexCatalog(false, true, previousId);
          return;
        }
        takeOverExternalConfig = true;
      }
      startedAt = Date.now();
      timer = setTimeout(() => {
        if (!isCurrent()) return;
        lock.current = false; setBusy(false);
        if (!written) showToast(t('仍在写入，可继续操作'), 'info');
      }, 2_000);
      const providers = await bridge.api.switchClientProvider({ client, providerId,
        takeOverExternalConfig: client === 'codex' && takeOverExternalConfig ? true : undefined });
      if (!isCurrent()) return;
      written = true;
      bridge.patch({ providers });
      clearLifecycleNotice();
      let modelReadFailed = false;
      void refreshModelSelection(client, providerId).then(ok => { modelReadFailed = !ok; });
      if (client === 'claude') {
        void bridge.api.getClaudeEnvironmentOverrides().then(environment => {
          if (!isCurrent() || !environment.overrides.length) return;
          showToast(t('Claude 服务已保存，但环境变量可能覆盖它'), 'info', undefined, {
            description: environment.overrides.map(item => item.name).join('、')
          });
        }).catch(() => undefined);
      }
      const catalogResult = await waitForModelCatalog(
        client === 'codex' ? loadCodexCatalog(false, true, providerId) : loadClaudeCatalog(providerId, true),
        startedAt
      );
      if (!isCurrent()) return;
      // The loader already offered a specific retry/configuration action.
      if (modelReadFailed || (catalogResult === 'failed' && !providers.warning)) return;
      showToast(providerId === null ? t('已恢复客户端连接') : t('模型服务已切换'), providers.warning || catalogResult !== 'ready' ? 'info' : 'success', undefined, {
        description: providers.warning ?? (catalogResult === 'timeout'
          ? t('列表仍在加载，服务配置已保存，可继续操作。')
          : catalogResult === 'failed' ? t('模型列表暂未加载，可稍后重试。') : bridge.runtime?.tracingEnabled ? t('新请求使用所选服务，正在进行的回答继续完成。') : undefined),
        actionProps: providers.warning?.includes(t('需要开启 Trace')) ? {
          type: 'button', children: t('开启 Trace'), onClick: () => runNoticeAction('start-trace')
        } : undefined
      });
    } catch (error) {
      if (!isCurrent()) return;
      showErrorToast(t('目标服务未完全写入，选择已保留'), error, undefined, {
        actionProps: providerFailureAction(error, providerId, t('重试并修复'), () => void repairProviderSwitch(client, providerId))
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (isCurrent()) { lock.current = false; setBusy(false); }
    }
  };

  React.useEffect(() => {
    const restore = (event: Event) => {
      const client = (event as CustomEvent<string>).detail;
      if (client === 'claude' || client === 'codex') void handleProviderChange(client, null);
    };
    window.addEventListener(RESTORE_CLIENT_CONFIG_EVENT, restore);
    return () => window.removeEventListener(RESTORE_CLIENT_CONFIG_EVENT, restore);
  }, [handleProviderChange]);

  const handleCodexModelChange = React.useCallback(async (selection: string) => {
    if (codexOperationRef.current || !codexConfig) return;
    codexOperationRef.current = true;
    setBusyCodex(true);
    const generation = ++providerSwitchGeneration.current.codex;
    const cfg = codexConfig;
    const provider = bridge.providers?.connections.find(item => item.id === codexProviderId);
    const mode = cfg?.mode ?? 'official';
    const choice: CodexContextVariant = codexChoiceByLabel.get(selection) ?? {
      modelId: selection,
      label: selection,
      contextWindow: null
    };
    const modelId = choice.modelId;
    try {
      const saved = await bridge.api.updateCodexConfig({
        expectedProviderId: codexProviderId,
        mode,
        officialModel: mode === 'official' ? modelId : (cfg?.officialModel ?? modelId),
        compatibleModel: mode === 'compatible' ? modelId : (cfg?.compatible?.model ?? modelId),
        compatibleBaseUrl: provider?.baseUrl ?? cfg.compatible.baseUrl,
        compatibleBearerToken: provider?.bearerToken ?? cfg.compatible.bearerToken,
        modelContextWindow: choice.contextWindow,
      });
      if (generation !== providerSwitchGeneration.current.codex) return;
      setCodexConfig(saved);
      bridge.patch({ codexConfig: saved });
      clearLifecycleNotice();
      if (saved.warning) {
        showToast(t('模型选择已保存'), 'info', undefined, { description: saved.warning,
          actionProps: saved.warning.includes(t('需要开启 Trace')) ? { type: 'button', children: t('开启 Trace'), onClick: () => runNoticeAction('start-trace') } : undefined });
      } else if (saved.modelCatalogSource === 'external') {
        showToast(t('ChatGPT 模型可能未更新'), 'info', undefined, {
          description: EXTERNAL_CODEX_CATALOG_DESCRIPTION,
          timeout: 12_000
        });
      } else {
        showToast(t("已选择 {0}；协议由 XwX Deck 自动适配。", choice.label), 'success');
      }
    } catch (error) {
      if (generation === providerSwitchGeneration.current.codex) showLifecycleNotice(lifecycleFailure(error, t('保存 ChatGPT 配置')));
    } finally {
      if (generation === providerSwitchGeneration.current.codex) {
        codexOperationRef.current = false;
        setBusyCodex(false);
      }
    }
  }, [bridge.api, bridge.patch, bridge.providers, codexConfig, codexProviderId, codexChoiceByLabel]);

  const handleEnhancementsUpdate = React.useCallback(async (patch: Record<string, unknown>): Promise<CodexEnhancementsSnapshot> => {
    const updated = await bridge.api.updateCodexEnhancements(patch);
    setEnhancements(updated);
    bridge.patch({ codexEnhancements: updated });
    return updated;
  }, [bridge.api, bridge.patch]);

  const handleClaudeDesktopSyncUpdate = React.useCallback(async (enabled: boolean) => {
    const updated = await bridge.api.updateClaudeDesktopSync(enabled);
    setClaudeDesktopSync(updated);
    bridge.patch({ claudeDesktopSync: updated });
    return updated;
  }, [bridge.api, bridge.patch]);

  const codexModelId = codexConfig
    ? (codexConfig.mode === 'compatible' ? codexConfig.compatible.model : codexConfig.officialModel)
    : '';
  const selectedCodexProvider = bridge.providers?.connections.find(
    provider => provider.id === codexProviderId
  );
  const selectedClaudeProvider = bridge.providers?.connections.find(
    provider => provider.id === claudeProviderId
  );
  // Only mark routes that actually need Chat Completions or Messages conversion.
  const traceEnabled = bridge.runtime?.tracingEnabled === true;
  const codexModelNote = React.useCallback((label: string): ModelPickerNote | undefined => {
    // Official mode does not use third-party protocol conversion.
    if (codexConfig?.mode !== 'compatible') return undefined;
    const modelId = codexChoiceByLabel.get(label)?.modelId ?? label;
    const catalogEntry = activeCodexCatalog.find(item => item.id === modelId);
    if (catalogEntry?.vendor === '已配置') {
      return {
        label: t('不在目录'),
        hint: t('这是上次选择的模型，当前服务目录未提供。可继续保留，或改选当前服务的模型。')
      };
    }
    if (!providerRequiresTrace(selectedCodexProvider ?? bridge.compatibleServiceConfig ?? undefined, modelId, activeCodexCatalog)) return undefined;
    if (selectedCodexProvider?.subscriptionAccountId) return { label: t('需 Trace'), hint: traceEnabled ? t('订阅账号通过 Trace 调用，授权凭证保留在本机。') : t('选择已保存；使用订阅账号时请开启 Trace。') };
    return traceEnabled
      ? { label: t('需 Trace'), hint: t("{0} 需要协议转换。Trace 已开启，可直接使用。", modelId) }
      : {
        label: t('需 Trace'),
        hint: t("{0} 需要协议转换。选择会直接保存；调用时请开启 Trace。", modelId)
      };
  }, [codexConfig?.mode, codexChoiceByLabel, selectedCodexProvider, bridge.compatibleServiceConfig, activeCodexCatalog, traceEnabled]);
  const codexModelValue = React.useMemo(() => {
    if (!codexModelId) return '';
    const variants = codexChoices
      .map(choice => choice.variant)
      .filter(variant => variant.modelId === codexModelId);
    if (!variants.length) return codexModelId;
    return variants.find(variant => variant.contextWindow === (codexConfig?.modelContextWindow ?? null))?.label
      ?? variants[0].label;
  }, [codexChoices, codexConfig?.modelContextWindow, codexModelId]);

  return (
    <section
      className={`page${active ? ' current' : ''}`}
      id="page-models"
      aria-label={t("模型")}
      inert={active ? undefined : true}
    >
      <div className="page-inner">
        <div className="page-head"><h1>{t("模型配置")}</h1></div>

        <Tabs value={shownClients.includes(selectedClient) ? selectedClient : null} onValueChange={value => { if (value) setSelectedClient(value as DownloadClientId); }}>
          <div className="models-switch">
            <TabsList ref={clientTabsList} aria-label={t("选择客户端")}>
              {shownClients.map(id => <TabsTab key={id} value={id} id={`client-tab-${id}`} data-client-tab={id}>{CLIENT_DOWNLOADS.find(client => client.id === id)?.label}</TabsTab>)}
            </TabsList>
            <button ref={clientManagerTrigger} type="button" className="txt-action models-manage-clients" onClick={() => setManagingClients(true)}><SlidersHorizontal size={15} aria-hidden="true" />{t("管理客户端")}</button>
          </div>
          {!shownClients.length && <p className="model-client-status">{t("从「管理客户端」添加已安装的客户端")}</p>}

          {/* Claude panel */}
          <TabsPanel value={clientRoute === 'claude' ? selectedClient : 'claude'} keepMounted
            className="config-block"
            id="client-panel-claude"
            data-client-panel="claude"
          >
            <div className="field-row" data-tour="models-proxy">
              <span className="fr-label">{t("模型服务")}</span>
              <div className="fr-value"><ProviderPicker registry={bridge.providers} client="claude" value={claudeProviderId} onChange={id => void handleProviderChange('claude', id)} /></div>
            </div>
            {CLAUDE_ROLES.map(({ key, label }) => (
              <div key={key} className="field-row">
                <span className="fr-label">{label}</span>
                <div className="fr-value">
                  <ModelPicker
                    value={claudeModels?.[key] ?? ''}
                    disabled={busyClaude || !claudeProviderId}
                    catalog={claudeCatalog}
                    onChange={id => handleClaudeModelChange(key, id)}
                    noteFor={claudeModelNote}
                    allowCustomValue={id => !isKnownNonConversationalModel(id)}
                    dataAttr={{ 'data-claude-model': key }}
                  />
                </div>
              </div>
            ))}
            {claudeDesktopSync && (
              <ClaudeEnhancements
                sync={claudeDesktopSync}
                onUpdate={handleClaudeDesktopSyncUpdate}
              />
            )}
          </TabsPanel>

          {/* ChatGPT panel */}
          <TabsPanel value={clientRoute === 'codex' ? selectedClient : 'codex'} keepMounted
            className="config-block"
            id="client-panel-codex"
            data-client-panel="codex"
          >
            <div className="field-row">
              <span className="fr-label">{t("模型服务")}</span>
              <div className="fr-value"><ProviderPicker registry={bridge.providers} client="codex" value={codexProviderId} onChange={id => void handleProviderChange('codex', id)} /></div>
            </div>
            <div className="field-row">
              <span className="fr-label">{t("默认模型")}</span>
              <div className="fr-value">
                    <ModelPicker
                      value={codexModelValue}
                      disabled={busyCodex || !codexConfig}
                      catalog={codexChoiceCatalog}
                      onChange={handleCodexModelChange}
                      noteFor={codexModelNote}
                      allowCustomValue={id => !isKnownNonConversationalModel(id)
                        && (codexConfig?.mode === 'compatible' || isOfficialCodexModelId(id))}
                      dataAttr={{ 'data-codex-model': '' }}
                    />
              </div>
            </div>
            {enhancements ? (
              <CodexEnhancements
                enhancements={enhancements}
                onUpdate={handleEnhancementsUpdate}
                onAfterUpdate={() => {
                  const generation = providerSwitchGeneration.current.codex;
                  void Promise.all([bridge.api.getCodexConfig(), bridge.api.getModelServices()])
                    .then(([config, nextServices]) => {
                      if (generation !== providerSwitchGeneration.current.codex) return;
                      setCodexConfig(config);
                      bridge.patch({ codexConfig: config, modelServices: nextServices });
                    })
                    .catch(() => undefined);
                }}
              />
            ) : (
              <div className="group">
                <div className="group-label"><span className="eyebrow">{t("ChatGPT 应用增强")}</span></div>
                <div className="field-row">
                  <span className="fr-label" role="status">{enhancementsLoadFailed ? t('增强设置暂未加载') : t('正在加载增强设置…')}</span>
                  <div className="fr-value"><button type="button" className="btn" onClick={retryEnhancements}>{t("重新加载")}</button></div>
                </div>
              </div>
            )}
          </TabsPanel>
          {addedClients.filter(id => modelClientRoute(id) === null).map(id => <TabsPanel key={id} value={id} keepMounted className="config-block model-client-setup" id={`client-panel-${id}`} data-client-panel={id}>
            <div className="model-client-status"><ProviderIcon kind={CLIENT_DOWNLOADS.find(client => client.id === id)?.icon} /><span>{t("模型连接请在客户端中配置")}</span></div>
            <ClientDownloads client={id} />
          </TabsPanel>)}
        </Tabs>
        <ManageClientsDialog open={managingClients} onOpenChange={setManagingClients} finalFocus={clientManagerTrigger} onSelect={setSelectedClient} />
      </div>
    </section>
  );
}
