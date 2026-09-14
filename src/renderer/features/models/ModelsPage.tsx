import { ProviderPicker } from './ProviderPicker';
import * as React from 'react';
import type {
  ClaudeModelSettings,
  CodexConfigSnapshot,
  CodexEnhancementsSnapshot,
  ModelCatalogEntry,
  ModelServiceSnapshot,
} from '@/bridge/types';
import { useBridge } from '@/bridge/store';
import { showErrorToast, showToast } from '@/lib/toast';
import { Tabs, TabsList, TabsTab, TabsPanel } from '@/components/ui/tabs';
import { ModelPicker } from './ModelPicker';
import { CodexEnhancements } from './CodexEnhancements';
import { isKnownNonConversationalModel, isOfficialCodexModelId } from '../../../main/app/codexProtocolPolicy';
import { codexContextVariants, type CodexContextVariant } from '../../../shared/codexContextVariants';

type ClientTab = 'claude' | 'codex';
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

const EXTERNAL_CODEX_CATALOG_DESCRIPTION = '请移除其他软件写入的 model_catalog_json，再完全退出并重新打开 ChatGPT。';

export function ModelsPage({ active }: Props): React.ReactElement {
  const bridge = useBridge();
  const [activeTab, setActiveTab] = React.useState<ClientTab>('claude');
  const [claudeModels, setClaudeModels] = React.useState<ClaudeModelSettings | null>(bridge.claudeModels);
  const [codexConfig, setCodexConfig] = React.useState<CodexConfigSnapshot | null>(bridge.codexConfig);
  const [enhancements, setEnhancements] = React.useState<CodexEnhancementsSnapshot | null>(bridge.codexEnhancements);
  const [services, setServices] = React.useState<ModelServiceSnapshot | null>(bridge.modelServices);
  const [catalog, setCatalog] = React.useState<readonly ModelCatalogEntry[]>(bridge.modelCatalog);
  const [claudeProviderCatalog, setClaudeProviderCatalog] = React.useState<readonly ModelCatalogEntry[]>([]);
  const claudeOperationRef = React.useRef(false);
  const [busyClaude, setBusyClaude] = React.useState(false);
  const [busyCodex, setBusyCodex] = React.useState(false);
  const codexOperationRef = React.useRef(false);
  const externalCodexProvider = !!bridge.providers && codexConfig?.mode === 'compatible' && !bridge.providers.active.codex;
  // Hydrate local state from the store once it boots.
  React.useEffect(() => { if (bridge.claudeModels) setClaudeModels(bridge.claudeModels); }, [bridge.claudeModels]);
  React.useEffect(() => { if (bridge.codexConfig) setCodexConfig(bridge.codexConfig); }, [bridge.codexConfig]);
  React.useEffect(() => { if (bridge.codexEnhancements) setEnhancements(bridge.codexEnhancements); }, [bridge.codexEnhancements]);
  React.useEffect(() => { if (bridge.modelServices) setServices(bridge.modelServices); }, [bridge.modelServices]);
  React.useEffect(() => { setCatalog(bridge.modelCatalog); }, [bridge.modelCatalog]);

  // Load the active service directory. Official mode reads Codex's own
  // models_cache.json; API connections refresh their remote directory.
  React.useEffect(() => {
    let alive = true;
    const apply = (list: readonly ModelCatalogEntry[]) => {
      if (!alive) return;
      setCatalog(list);
      bridge.patch({ modelCatalog: list });
    };
    void (async () => {
      await bridge.api.fetchModels({ source: 'active' }).then(apply).catch(() => undefined);
      if (!alive) return;
      if (codexConfig?.mode === 'compatible') {
        await bridge.api.fetchModels({ source: 'active', refresh: true }).then(apply).catch(() => undefined);
      }
    })();
    return () => { alive = false; };
  }, [bridge.api, bridge.patch, bridge.providers, codexConfig?.mode]);

  React.useEffect(() => {
    let alive = true;
    setClaudeProviderCatalog([]);
    const id = bridge.providers?.selected.claude;
    if (id) void bridge.api.fetchProviderModels({ providerId: id }).then(models => { if (alive) setClaudeProviderCatalog(models); }).catch(() => undefined);
    return () => { alive = false; };
  }, [bridge.api, bridge.providers]);

  const configuredIds = React.useMemo(() => {
    const ids = new Set<string>();
    const id = codexConfig?.mode === 'compatible' ? codexConfig.compatible.model : codexConfig?.officialModel;
    if (id) ids.add(id);
    return ids;
  }, [claudeModels, codexConfig]);

  // Merge configured-but-uncatalogued models so they remain selectable.
  const mergedCatalog = React.useMemo(() => {
    const byId = new Map<string, ModelCatalogEntry>();
    for (const m of catalog) byId.set(m.id, m);
    for (const id of configuredIds) {
      if (!byId.has(id)) byId.set(id, { id, vendor: '已配置', protocols: [], clients: [] });
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }, [catalog, configuredIds]);

  // Endpoint metadata determines Claude support; configured model IDs stay editable.
  const claudeCatalog = claudeProviderCatalog.filter(m =>
    !isKnownNonConversationalModel(m.id)
    && (m.protocols.includes('anthropic-messages') || m.vendor === '已配置'));
  const codexCatalog = mergedCatalog.filter(m =>
    !isKnownNonConversationalModel(m.id)
    && (m.clients.includes('codex') || m.vendor === '已配置'));
  const activeCodexCatalog = React.useMemo(() => (
    codexConfig?.mode === 'compatible'
      ? codexCatalog
      : codexCatalog.filter(model => isOfficialCodexModelId(model.id))
  ), [codexCatalog, codexConfig?.mode]);
  const codexChoices = React.useMemo(() => activeCodexCatalog.flatMap(model => (
    codexContextVariants(model).map(variant => ({
      variant,
      catalogEntry: { ...model, id: variant.label }
    }))
  )), [activeCodexCatalog]);
  const codexChoiceByLabel = React.useMemo(() => new Map(
    codexChoices.map(choice => [choice.variant.label, choice.variant] as const)
  ), [codexChoices]);
  const codexChoiceCatalog = React.useMemo(
    () => codexChoices.map(choice => choice.catalogEntry),
    [codexChoices]
  );

  const handleClaudeModelChange = React.useCallback(async (role: ClaudeRole, modelId: string) => {
    if (!claudeModels || claudeOperationRef.current) return;
    claudeOperationRef.current = true; setBusyClaude(true);
    try {
      const updated = await bridge.api.updateClaudeModels({ [role]: modelId, expectedProviderId: bridge.providers?.active.claude ?? null });
      setClaudeModels(updated);
      bridge.patch({ claudeModels: updated });
      showToast('Claude 模型已保存', 'success');
    } catch (error) {
      showErrorToast('无法保存 Claude 模型', error);
    } finally { claudeOperationRef.current = false; setBusyClaude(false); }
  }, [bridge.api, bridge.patch, bridge.providers?.active.claude, claudeModels]);

  const handleProviderChange = async (client: ClientTab, providerId: string | null) => {
    const lock = client === 'codex' ? codexOperationRef : claudeOperationRef;
    if (lock.current) return;
    lock.current = true;
    const setBusy = client === 'codex' ? setBusyCodex : setBusyClaude;
    setBusy(true);
    let committed = false;
    let switchWarningShown = false;
    try {
      const providers = await bridge.api.switchClientProvider({ client, providerId });
      committed = true;
      bridge.patch({ providers, modelCatalog: [] });
      setCatalog([]);
      const [runtimeResult, configResult] = client === 'codex'
        ? await Promise.allSettled([bridge.api.getState(), bridge.api.getCodexConfig()])
        : [null, null];
      const runtime = runtimeResult?.status === 'fulfilled' ? runtimeResult.value : null;
      const switchedConfig = configResult?.status === 'fulfilled' ? configResult.value : null;
      if (runtime) bridge.patch({ runtime });
      if (switchedConfig) {
        setCodexConfig(switchedConfig);
        bridge.patch({ codexConfig: switchedConfig });
      }
      if (client === 'codex' && providerId && switchedConfig?.modelCatalogSource === 'external') {
        switchWarningShown = true;
        showToast('ChatGPT 配置存在冲突', 'info', undefined, {
          description: EXTERNAL_CODEX_CATALOG_DESCRIPTION,
          timeout: 12_000
        });
      } else if (client === 'codex' && runtime?.chatGptRestartRecommended) {
        switchWarningShown = true;
        showToast('ChatGPT 配置已更新', 'info', undefined, {
          description: '当前对话通常可继续使用；若仍在使用原服务或对话无法继续，再完全退出并重新打开 ChatGPT。',
          timeout: 12_000
        });
      } else if (client === 'codex' && (!runtime || !switchedConfig)) {
        switchWarningShown = true;
        showToast('ChatGPT 配置已更新，切换状态未确认', 'info');
      } else {
        showToast(providerId ? '服务已切换' : '已切回官方服务。', 'success');
      }
    } catch (error) {
      showErrorToast(`无法切换 ${client === 'codex' ? 'ChatGPT' : 'Claude'} 服务`, error, undefined, {
        timeout: 10_000
      });
    }
    finally {
      const results = await Promise.allSettled([bridge.api.getProviders(), bridge.api.getModelServices(), bridge.api.getCodexConfig(), bridge.api.getClaudeModels(), bridge.api.getCompatibleServiceConfig()]);
      const [pr, sr, cr, mr, pc] = results;
      if (pr.status === 'fulfilled') bridge.patch({ providers: pr.value });
      if (sr.status === 'fulfilled') { setServices(sr.value); bridge.patch({ modelServices: sr.value }); }
      if (cr.status === 'fulfilled') { setCodexConfig(cr.value); bridge.patch({ codexConfig: cr.value }); }
      if (mr.status === 'fulfilled') { setClaudeModels(mr.value); bridge.patch({ claudeModels: mr.value }); }
      if (pc.status === 'fulfilled') bridge.patch({ compatibleServiceConfig: pc.value });
      if (committed && !switchWarningShown && results.some(r => r.status === 'rejected')) {
        showToast('服务配置已保存，页面状态未刷新，请重新进入。', 'info');
      }
      lock.current = false; setBusy(false);
    }
  };

  const handleCodexModelChange = React.useCallback(async (selection: string) => {
    if (codexOperationRef.current || !codexConfig) return;
    codexOperationRef.current = true;
    setBusyCodex(true);
    const cfg = codexConfig;
    const mode = cfg?.mode ?? 'official';
    const choice: CodexContextVariant = codexChoiceByLabel.get(selection) ?? {
      modelId: selection,
      label: selection,
      contextWindow: null
    };
    const modelId = choice.modelId;
    try {
      const saved = await bridge.api.updateCodexConfig({
        expectedProviderId: bridge.providers?.active.codex ?? null,
        mode,
        officialModel: mode === 'official' ? modelId : (cfg?.officialModel ?? modelId),
        compatibleModel: mode === 'compatible' ? modelId : (cfg?.compatible?.model ?? modelId),
        compatibleBaseUrl: bridge.compatibleServiceConfig?.baseUrl ?? cfg?.compatible?.baseUrl ?? '',
        compatibleBearerToken: bridge.compatibleServiceConfig?.bearerToken ?? cfg?.compatible?.bearerToken ?? '',
        modelContextWindow: choice.contextWindow,
      });
      setCodexConfig(saved);
      bridge.patch({ codexConfig: saved });
      if (saved.modelCatalogSource === 'external') {
        showToast('ChatGPT 模型可能未更新', 'info', undefined, {
          description: EXTERNAL_CODEX_CATALOG_DESCRIPTION,
          timeout: 12_000
        });
      } else {
        showToast(`已选择 ${choice.label}；协议由 XwX Deck 自动适配。`, 'success');
      }
    } catch (error) {
      showErrorToast('无法保存 ChatGPT 配置', error);
    } finally {
      codexOperationRef.current = false;
      setBusyCodex(false);
    }
  }, [bridge.api, bridge.patch, codexConfig, bridge.compatibleServiceConfig, bridge.providers, codexChoiceByLabel]);

  const handleEnhancementsUpdate = React.useCallback(async (patch: Record<string, unknown>): Promise<CodexEnhancementsSnapshot> => {
    const updated = await bridge.api.updateCodexEnhancements(patch);
    setEnhancements(updated);
    bridge.patch({ codexEnhancements: updated });
    return updated;
  }, [bridge.api, bridge.patch]);

  const codexModelId = codexConfig
    ? (codexConfig.mode === 'compatible' ? codexConfig.compatible.model : codexConfig.officialModel)
    : '';
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
      aria-label="模型"
      inert={active ? undefined : true}
    >
      <div className="page-inner">
        <div className="page-head"><h1>模型配置</h1></div>

        <Tabs
          value={activeTab}
          onValueChange={v => setActiveTab(v as ClientTab)}
        >
          <div className="models-switch">
            <TabsList aria-label="选择客户端">
              <TabsTab value="claude" id="client-tab-claude" data-client-tab="claude">Claude</TabsTab>
              <TabsTab value="codex" id="client-tab-codex" data-client-tab="codex">ChatGPT</TabsTab>
            </TabsList>
          </div>

          {/* Claude panel */}
          <TabsPanel
            value="claude"
            keepMounted
            className="config-block"
            id="client-panel-claude"
            data-client-panel="claude"
          >
            <div className="field-row" data-tour="models-proxy">
              <span className="fr-label">服务连接</span>
              <div className="fr-value"><ProviderPicker registry={bridge.providers} client="claude" disabled={busyClaude} onChange={id => void handleProviderChange('claude', id)} /></div>
            </div>
            {CLAUDE_ROLES.map(({ key, label }) => (
              <div key={key} className="field-row">
                <span className="fr-label">{label}</span>
                <div className="fr-value">
                  <ModelPicker
                    value={claudeModels?.[key] ?? ''}
                    disabled={busyClaude || !services?.claude}
                    catalog={claudeCatalog}
                    onChange={id => handleClaudeModelChange(key, id)}
                    allowCustomValue={id => !isKnownNonConversationalModel(id)}
                    dataAttr={{ 'data-claude-model': key }}
                  />
                </div>
              </div>
            ))}
          </TabsPanel>

          {/* ChatGPT panel */}
          <TabsPanel
            value="codex"
            keepMounted
            className="config-block"
            id="client-panel-codex"
            data-client-panel="codex"
          >
            <div className="field-row">
              <span className="fr-label">服务连接</span>
              <div className="fr-value"><ProviderPicker registry={bridge.providers} client="codex" external={externalCodexProvider} disabled={busyCodex} onChange={id => void handleProviderChange('codex', id)} /></div>
            </div>
            <div className="field-row">
              <span className="fr-label">默认模型</span>
              <div className="fr-value">
                    <ModelPicker
                      value={codexModelValue}
                      disabled={busyCodex || !codexConfig || externalCodexProvider}
                      catalog={codexChoiceCatalog}
                      onChange={handleCodexModelChange}
                      allowCustomValue={id => !isKnownNonConversationalModel(id)
                        && (codexConfig?.mode === 'compatible' || isOfficialCodexModelId(id))}
                      dataAttr={{ 'data-codex-model': '' }}
                    />
              </div>
            </div>
            {enhancements && (
              <CodexEnhancements
                enhancements={enhancements}
                onUpdate={handleEnhancementsUpdate}
                onAfterUpdate={() => {
                  void Promise.all([bridge.api.getCodexConfig(), bridge.api.getModelServices()])
                    .then(([config, nextServices]) => {
                      setCodexConfig(config);
                      setServices(nextServices);
                      bridge.patch({ codexConfig: config, modelServices: nextServices });
                    })
                    .catch(() => undefined);
                }}
              />
            )}
          </TabsPanel>
        </Tabs>
      </div>
    </section>
  );
}
