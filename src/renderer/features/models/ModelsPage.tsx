import * as React from 'react';
import type {
  ClaudeModelSettings,
  CodexConfigSnapshot,
  CodexEnhancementsSnapshot,
  ModelCatalogEntry,
  ModelServiceSnapshot,
  CompatibleServiceConfigSnapshot,
} from '@/bridge/types';
import { useBridge } from '@/bridge/store';
import { showToast } from '@/lib/toast';
import { navigateTo } from '@/lib/utils';
import { Tabs, TabsList, TabsTab, TabsPanel } from '@/components/ui/tabs';
import { Toggle } from '@/features/shell/Toggle';
import { ModelPicker } from './ModelPicker';
import { CodexEnhancements } from './CodexEnhancements';
import { isKnownNonConversationalModel, isOfficialCodexModelId } from '../../../main/app/codexProtocolPolicy';
import { providerProfile } from '../../../shared/providerProfiles';
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

function compatibleServiceReady(cfg: CompatibleServiceConfigSnapshot | null): boolean {
  return !!(cfg?.baseUrl?.trim() && cfg?.bearerToken?.trim());
}

function providerDisplayName(cfg: CompatibleServiceConfigSnapshot | null): string {
  return cfg?.displayName?.trim() || '兼容服务';
}

function operationError(error: unknown, fallback: string): string {
  const message = error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message.trim()
    : '';
  if (message.startsWith('Claude 接入失败：检测到环境变量')) return message;
  return message ? `${fallback}：${message}` : fallback;
}

export function ModelsPage({ active }: Props): React.ReactElement {
  const bridge = useBridge();
  const [activeTab, setActiveTab] = React.useState<ClientTab>('claude');
  const [claudeModels, setClaudeModels] = React.useState<ClaudeModelSettings | null>(bridge.claudeModels);
  const [codexConfig, setCodexConfig] = React.useState<CodexConfigSnapshot | null>(bridge.codexConfig);
  const [enhancements, setEnhancements] = React.useState<CodexEnhancementsSnapshot | null>(bridge.codexEnhancements);
  const [services, setServices] = React.useState<ModelServiceSnapshot | null>(bridge.modelServices);
  const [catalog, setCatalog] = React.useState<readonly ModelCatalogEntry[]>(bridge.modelCatalog);
  const [busyClaude, setBusyClaude] = React.useState(false);
  const [busyCodex, setBusyCodex] = React.useState(false);
  const serviceName = providerDisplayName(bridge.compatibleServiceConfig);
  const providerSupportsClaude = providerProfile(
    bridge.compatibleServiceConfig?.providerPreset
  ).supportsClaude || catalog.some(model => model.protocols.includes('anthropic-messages'));

  // Hydrate local state from the store once it boots.
  React.useEffect(() => { if (bridge.claudeModels) setClaudeModels(bridge.claudeModels); }, [bridge.claudeModels]);
  React.useEffect(() => { if (bridge.codexConfig) setCodexConfig(bridge.codexConfig); }, [bridge.codexConfig]);
  React.useEffect(() => { if (bridge.codexEnhancements) setEnhancements(bridge.codexEnhancements); }, [bridge.codexEnhancements]);
  React.useEffect(() => { if (bridge.modelServices) setServices(bridge.modelServices); }, [bridge.modelServices]);
  React.useEffect(() => { setCatalog(bridge.modelCatalog); }, [bridge.modelCatalog]);

  // Show the cached directory immediately, then replace it with a fresh
  // 兼容服务 snapshot. An empty fresh result must also clear stale entries.
  React.useEffect(() => {
    let alive = true;
    const apply = (list: readonly ModelCatalogEntry[]) => {
      if (!alive) return;
      setCatalog(list);
      bridge.patch({ modelCatalog: list });
    };
    void (async () => {
      await bridge.api.fetchModels({ source: 'compatible' }).then(apply).catch(() => undefined);
      if (!alive) return;
      await bridge.api.fetchModels({ source: 'compatible', refresh: true }).then(apply).catch(() => undefined);
    })();
    return () => { alive = false; };
  }, [bridge.api, bridge.patch]);

  const configuredIds = React.useMemo(() => {
    const ids = new Set<string>();
    if (claudeModels) Object.values(claudeModels).forEach(v => { if (v) ids.add(v); });
    if (codexConfig?.officialModel) ids.add(codexConfig.officialModel);
    if (codexConfig?.compatible?.model) ids.add(codexConfig.compatible.model);
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

  // Live 兼容服务 verification on 2026-07-28: all 31 models returned by the
  // Anthropic directory accepted Messages, while all 29 extra name-matched
  // models failed with no upstream channel. Endpoint membership is therefore
  // the automatic Claude boundary; free-text custom ids remain available.
  const claudeCatalog = mergedCatalog.filter(m =>
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

  const guard兼容服务 = React.useCallback((): boolean => {
    if (compatibleServiceReady(bridge.compatibleServiceConfig)) return true;
    navigateTo('settings');
    window.dispatchEvent(new CustomEvent('xwxdeck:edit-compatible'));
    showToast(`请先填写并保存 ${serviceName} 地址和密钥`, 'error');
    return false;
  }, [bridge.compatibleServiceConfig, serviceName]);

  const handleClaudeModelChange = React.useCallback(async (role: ClaudeRole, modelId: string) => {
    if (!claudeModels) return;
    try {
      const updated = await bridge.api.updateClaudeModels({ [role]: modelId });
      setClaudeModels(updated);
      bridge.patch({ claudeModels: updated });
      showToast('Claude 模型已保存', 'success');
    } catch (error) {
      showToast(operationError(error, '无法保存 Claude 模型'), 'error');
    }
  }, [bridge.api, bridge.patch, claudeModels]);

  const handleClaudeService = React.useCallback(async () => {
    if (busyClaude) return;
    const enabled = !(services?.claude === true);
    if (enabled && !guard兼容服务()) return;
    setBusyClaude(true);
    try {
      const next = await bridge.api.setModelService({ client: 'claude', enabled });
      setServices(next);
      bridge.patch({ modelServices: next });
      showToast(`Claude 已${enabled ? `启用 ${serviceName}` : '切回官方服务'}`, 'success');
    } catch (error) {
      void bridge.api.getModelServices().then(next => {
        setServices(next);
        bridge.patch({ modelServices: next });
      }).catch(() => undefined);
      showToast(operationError(error, `无法切换 ${serviceName} 代理`), 'error');
    } finally {
      setBusyClaude(false);
    }
  }, [bridge.api, bridge.patch, busyClaude, services, guard兼容服务, serviceName]);

  const handleCodexService = React.useCallback(async () => {
    if (busyCodex) return;
    const enabled = !(services?.codex === true);
    if (enabled && !guard兼容服务()) return;

    const previous = services;
    if (previous) setServices({ ...previous, codex: enabled });
    setBusyCodex(true);
    try {
      const next = await bridge.api.setModelService({ client: 'codex', enabled });
      setServices(next);
      const cfg = await bridge.api.getCodexConfig();
      setCodexConfig(cfg);
      bridge.patch({ modelServices: next, codexConfig: cfg });
      showToast(
        enabled
          ? `已切换至 ${serviceName}。当前任务未生效时，请重新打开 ChatGPT。`
          : '已切回官方服务。',
        'success'
      );
    } catch (error) {
      if (previous) setServices(previous);
      showToast(operationError(error, `无法切换 ${serviceName} 代理`), 'error');
    } finally {
      setBusyCodex(false);
    }
  }, [bridge.api, bridge.patch, busyCodex, services, guard兼容服务, serviceName]);

  const handleCodexModelChange = React.useCallback(async (selection: string) => {
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
        mode,
        officialModel: mode === 'official' ? modelId : (cfg?.officialModel ?? modelId),
        compatibleModel: mode === 'compatible' ? modelId : (cfg?.compatible?.model ?? modelId),
        compatibleBaseUrl: bridge.compatibleServiceConfig?.baseUrl ?? cfg?.compatible?.baseUrl ?? '',
        compatibleBearerToken: bridge.compatibleServiceConfig?.bearerToken ?? cfg?.compatible?.bearerToken ?? '',
        modelContextWindow: choice.contextWindow,
      });
      setCodexConfig(saved);
      bridge.patch({ codexConfig: saved });
      showToast(`已选择 ${choice.label}；协议由 XwX Deck 自动适配。`, 'success');
    } catch (error) {
      showToast(operationError(error, '无法保存 ChatGPT 配置'), 'error');
    }
  }, [bridge.api, bridge.patch, codexConfig, bridge.compatibleServiceConfig, codexChoiceByLabel]);

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
              <span className="fr-label">{serviceName} 代理</span>
              <div className="fr-value">
                <Toggle
                  checked={services?.claude === true}
                  disabled={!services || !providerSupportsClaude}
                  busy={busyClaude}
                  ariaLabel={`Claude 使用 ${serviceName} 代理`}
                  title={providerSupportsClaude
                    ? services?.claudeStatus.detail || `Claude 配置：${services?.claudeStatus.configPath || '检测中'}`
                    : `${serviceName} 没有检测到 Claude Messages 兼容入口`}
                  onToggle={handleClaudeService}
                />
              </div>
            </div>
            {!providerSupportsClaude && (
              <p className="setting-note">
                {serviceName} 没有检测到 Claude Messages 兼容入口，请在 ChatGPT 页使用。
              </p>
            )}
            {CLAUDE_ROLES.map(({ key, label }) => (
              <div key={key} className="field-row">
                <span className="fr-label">{label}</span>
                <div className="fr-value">
                  <ModelPicker
                    value={claudeModels?.[key] ?? ''}
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
              <span className="fr-label">{serviceName} 代理</span>
              <div className="fr-value">
                <Toggle
                  id="codexServiceToggle"
                  checked={services?.codex === true}
                  disabled={!services}
                  busy={busyCodex}
                  ariaLabel={`ChatGPT 使用 ${serviceName} 代理`}
                  onToggle={handleCodexService}
                />
              </div>
            </div>
            <div className="field-row">
              <span className="fr-label">默认模型</span>
              <div className="fr-value">
                <ModelPicker
                  value={codexModelValue}
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
