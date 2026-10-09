import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import { ArrowUpRight, Eye, EyeOff, Trash2 } from 'lucide-react';
import { ProviderIcon, providerIconKind } from './ProviderIcon';
import { AddConfigurationDialog, type ConfigurationTab } from './AddConfigurationDialog';
import { isLocalProvider, newProviderDraft, officialProviderForUrl, OFFICIAL_PROVIDERS, type OfficialProviderId } from '../../../shared/officialProviders';
import { useBridge } from '@/bridge/store';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { OPEN_CONFIGURATION_EVENT, OPEN_PROVIDER_SETTINGS_EVENT, showErrorToast, showToast, type ConfigurationEntry } from '@/lib/toast';
import { groupSubscriptionConnections, subscriptionPlatformForAccount, subscriptionServiceIcon, subscriptionServiceNames } from '@/lib/subscriptionServices';
import { SubscriptionAccountsPanel } from './SubscriptionAccountsPanel';
import { ProviderConnectionChecks } from './ProviderConnectionChecks';
import {
  providerNameError,
  type ProviderInput,
  type ProviderConnection,
  type ProviderSnapshot
} from '../../../shared/providers';

export function ProvidersPanel({ onRequestOpen }: { onRequestOpen: () => void }): React.ReactElement {
  useLanguage();
  const bridge = useBridge();
  const confirm = useConfirm();
  const [drafts, setDrafts] = React.useState<Record<string, ProviderInput>>({});
  const [draftKey, setDraftKey] = React.useState('new');
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [setupProvider, setSetupProvider] = React.useState<OfficialProviderId | 'custom' | null>(null);
  const [configurationTab, setConfigurationTab] = React.useState<ConfigurationTab>('services');
  const [subscriptionPlatform, setSubscriptionPlatform] = React.useState<'chatgpt' | 'grok' | 'copilot' | 'claude' | 'cursor' | null>(null);
  const [subscriptionConnectionId, setSubscriptionConnectionId] = React.useState<string | null>(null);
  const subscriptionConnection = subscriptionConnectionId ? bridge.providers?.connections.find(provider => provider.id === subscriptionConnectionId && provider.subscriptionAccountId)
    ?? bridge.providers?.connections.find(provider => provider.subscriptionAccountId && subscriptionPlatformForAccount(provider.subscriptionAccountId) === subscriptionPlatform) : undefined;
  const configuredConnections = groupSubscriptionConnections(bridge.providers?.connections ?? []);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [managementOpen, setManagementOpen] = React.useState(false);
  const [checksOpen, setChecksOpen] = React.useState(false);
  const returnProviderId = React.useRef<string | null | undefined>(undefined);
  const managementDraftKey = React.useRef<string | null>(null);
  const draft = drafts[draftKey] ?? null;
  const setDraft = (value: ProviderInput | null) => setDrafts(current => {
    const next = { ...current };
    if (value) next[draftKey] = value;
    else delete next[draftKey];
    return next;
  });
  const [showBearerToken, setShowBearerToken] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const savedProvider = bridge.providers?.connections.find(provider => provider.id === draft?.id);
  const previousName = savedProvider?.displayName;
  const draftChanged = !!draft && !!savedProvider && (draft.displayName !== savedProvider.displayName || draft.baseUrl !== savedProvider.baseUrl || draft.bearerToken !== savedProvider.bearerToken || draft.adapter !== savedProvider.adapter);
  const nameError = draft ? providerNameError(draft.displayName, previousName)
    || (draft.displayName !== previousName && bridge.providers?.connections.some(provider => provider.id !== draft.id && (provider.displayName === draft.displayName || provider.codexProviderId === draft.displayName)) ? t('此名称已被其他连接使用。') : undefined) : undefined;
  const lock = React.useRef(false);
  const refreshGeneration = React.useRef(0);
  const editorTrigger = React.useRef<HTMLButtonElement | null>(null);
  React.useEffect(() => {
    const open = (event: Event) => {
      if (lock.current) return;
      const { trigger, tab } = (event as CustomEvent<ConfigurationEntry>).detail;
      editorTrigger.current = trigger;
      setConfigurationTab(tab);
      setSubscriptionPlatform(null); setSubscriptionConnectionId(null);
      setManagementOpen(false); setChecksOpen(false); returnProviderId.current = undefined;
      setSetupProvider(null);
      setEditorOpen(false);
      setDialogOpen(true);
    };
    window.addEventListener(OPEN_CONFIGURATION_EVENT, open);
    return () => window.removeEventListener(OPEN_CONFIGURATION_EVENT, open);
  }, []);
  const closeEditor = () => {
    setShowBearerToken(false);
    setEditorOpen(false);
    setDialogOpen(false);
    setSetupProvider(null);
    setChecksOpen(false);
    setManagementOpen(false);
    requestAnimationFrame(() => editorTrigger.current?.focus());
  };
  const refresh = () => {
    const generation = ++refreshGeneration.current;
    const apply = <T,>(request: Promise<T>, update: (value: T) => void) => {
      void request.then(value => {
        if (generation === refreshGeneration.current) update(value);
      }).catch(() => undefined);
    };
    bridge.patch({ modelCatalog: [] });
    apply(bridge.api.getProviders(), providers => bridge.patch({ providers }));
    apply(bridge.api.getCompatibleServiceConfig(), compatibleServiceConfig => bridge.patch({ compatibleServiceConfig }));
    apply(bridge.api.getModelServices(), modelServices => bridge.patch({ modelServices }));
    apply(bridge.api.getCodexConfig(), codexConfig => bridge.patch({ codexConfig }));
    apply(bridge.api.getClaudeModels(), claudeModels => bridge.patch({ claudeModels }));
  };
  const run = async (title: string, operation: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await operation(); }
    catch (error) { showErrorToast(title, error); }
    finally { lock.current = false; setBusy(false); }
  };
  const edit = React.useCallback((p: ProviderConnection, trigger: HTMLButtonElement | null) => {
    editorTrigger.current = trigger;
    setChecksOpen(false);
    setSubscriptionConnectionId(p.subscriptionAccountId ? p.id : null);
    if (p.subscriptionAccountId) {
      setManagementOpen(true); returnProviderId.current = p.id; managementDraftKey.current = null;
      setSubscriptionPlatform(subscriptionPlatformForAccount(p.subscriptionAccountId));
      setConfigurationTab('saved'); setSetupProvider(null); setDialogOpen(true); setEditorOpen(false); return;
    }

    setConfigurationTab('saved');
    setManagementOpen(true); returnProviderId.current = p.id; managementDraftKey.current = p.id;
    setSetupProvider((OFFICIAL_PROVIDERS.find(item => 'providerPreset' in item && item.providerPreset === p.providerPreset) ?? officialProviderForUrl(p.baseUrl))?.id ?? 'custom');
    setDialogOpen(true);
    setShowBearerToken(false);
    setDraftKey(p.id);
    setEditorOpen(true);
    setDrafts(current => current[p.id] ? current : { ...current, [p.id]: { id: p.id, displayName: p.displayName, baseUrl: p.baseUrl, bearerToken: p.bearerToken, adapter: p.adapter, providerPreset: p.providerPreset, codexModel: p.codexModel } });
  }, []);
  const add = (preset: OfficialProviderId | 'custom') => {
    setSubscriptionConnectionId(null);
    const key = `new:${preset}`;
    if (preset === 'custom') { setManagementOpen(true); setConfigurationTab('saved'); managementDraftKey.current = key; }
    setShowBearerToken(false);
    setChecksOpen(false);
    setDraftKey(key);
    setSetupProvider(preset);
    setEditorOpen(true);
    setDrafts(current => current[key] ? current : { ...current, [key]: newProviderDraft(bridge.providers?.connections, preset) });
  };
  const startAdding = () => {
    if (managementOpen) returnProviderId.current = subscriptionConnection?.id ?? savedProvider?.id ?? null;
    setManagementOpen(false); setChecksOpen(false);
    setConfigurationTab('services'); setSetupProvider(null); setEditorOpen(false);
  };
  const returnToManagement = () => {
    if (managementDraftKey.current === 'new:custom' && drafts['new:custom']) { add('custom'); return; }
    const provider = bridge.providers?.connections.find(item => item.id === returnProviderId.current)
      ?? bridge.providers?.connections.find(item => !item.subscriptionAccountId) ?? bridge.providers?.connections[0];
    if (provider) {
      edit(provider, editorTrigger.current);
    }
    else { setConfigurationTab('saved'); setManagementOpen(true); setChecksOpen(false); setSetupProvider(null); setEditorOpen(false); }
  };
  const imported = (providers: ProviderSnapshot, added: readonly string[]) => {
    const provider = providers.connections.find(item => added.includes(item.displayName) && !item.subscriptionAccountId);
    refresh();
    if (provider) {
      edit(provider, editorTrigger.current);
      requestAnimationFrame(() => document.getElementById('provider-config-tab')?.focus());
    }
  };
  const preset = OFFICIAL_PROVIDERS.find(item => item.id === setupProvider);
  React.useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      const provider = bridge.providers?.connections.find(item => item.id === id);
      if (!provider) return;
      onRequestOpen();
      const entry = provider.subscriptionAccountId
        ? bridge.providers?.connections.find(item => item.subscriptionAccountId && subscriptionPlatformForAccount(item.subscriptionAccountId) === subscriptionPlatformForAccount(provider.subscriptionAccountId!))
        : provider;
      edit(provider, document.getElementById(`provider-edit-${entry?.id ?? id}`) as HTMLButtonElement | null);
      requestAnimationFrame(() => {
        if (provider.subscriptionAccountId) { document.getElementById('configuration-saved-tab')?.focus(); return; }
        document.getElementById('provider-editor')?.scrollIntoView({ block: 'center' });
        document.getElementById(!provider.baseUrl.trim() ? 'provider-url' : 'provider-key')?.focus();
      });
    };
    window.addEventListener(OPEN_PROVIDER_SETTINGS_EVENT, open);
    return () => window.removeEventListener(OPEN_PROVIDER_SETTINGS_EVENT, open);
  }, [bridge.providers, edit, onRequestOpen]);
  const remove = async (provider: ProviderConnection) => {
    if (lock.current) return;
    if (bridge.runtime?.tracingEnabled || bridge.runtime?.backgroundGatewayActive || bridge.providers?.selected.codex === provider.id || bridge.providers?.selected.claude === provider.id) {
      showToast(t('请先停止 Trace，并在模型页切换使用此配置的客户端。'), 'info');
      return;
    }
    const ok = await confirm({ title: t("删除模型服务「{0}」？", provider.displayName), body: t('此操作只删除这份配置，其他模型服务和历史记录会保留。'), confirmText: t('删除'), tone: 'danger' });
    if (!ok) return;
    await run(t('删除模型服务失败'), async () => {
      const providers = await bridge.api.deleteProvider(provider.id);
      bridge.patch({ providers });
      setDrafts(current => { const next = { ...current }; delete next[provider.id]; return next; });
      refresh();
      const remaining = providers.connections.filter(item => !item.subscriptionAccountId);
      const previousIndex = (bridge.providers?.connections.filter(item => !item.subscriptionAccountId) ?? []).findIndex(item => item.id === provider.id);
      const next = remaining[Math.min(previousIndex, remaining.length - 1)];
      if (next) edit(next, editorTrigger.current);
      else { setConfigurationTab('saved'); setManagementOpen(true); setChecksOpen(false); setEditorOpen(false); setSetupProvider(null); returnProviderId.current = null; managementDraftKey.current = null; }
      editorTrigger.current = document.getElementById('provider-add') as HTMLButtonElement | null;
      showToast(t('模型服务已删除'), 'success');
      requestAnimationFrame(() => (document.querySelector('[data-saved-provider][aria-pressed="true"]') as HTMLElement | null)?.focus());
    });
  };
  const editor = draft && <form key={draft.id ?? draftKey} id="provider-editor" className="provider-editor" hidden={!editorOpen} aria-label={draft.id ? t('编辑模型服务') : t('添加模型服务')} aria-busy={busy} onSubmit={e => {
    e.preventDefault();
    if (nameError) return;
    void run(t('保存模型服务失败'), async () => {
      const providers = await bridge.api.saveProvider(draft);
      bridge.patch({ providers });
      refresh();
      const saved = providers.connections.find(item => draft.id ? item.id === draft.id : item.displayName === draft.displayName);
      if (saved) {
        setDrafts(current => { const next = { ...current }; delete next[draftKey]; next[saved.id] = { ...draft, id: saved.id }; return next; });
        edit(saved, editorTrigger.current);
        requestAnimationFrame(() => document.getElementById('provider-config-tab')?.focus());
      }
      const endpointIncluded = /\/(?:responses(?:\/compact)?|chat\/completions|messages)\/?$/i.test(new URL(draft.baseUrl).pathname);
      showToast(t('模型服务已保存'), 'success');
      if (endpointIncluded) {
        showToast(t('请核对 API 地址路径'), 'info', undefined, {
          description: t('地址包含完整接口路径。请按服务商文档确认是否应去掉末尾的 responses、chat/completions 或 messages。')
        });
      }
    });
  }}>
      <div className="field-row">
        <label className="fr-label" htmlFor="provider-name">{t("名称")}</label>
        <div className="fr-value"><div className="provider-name-field">
          <input id="provider-name" type="text" className="txt-input" required maxLength={80}
            value={draft.displayName} placeholder={t("仅支持英文字母、数字、下划线和连字符")}
            disabled={busy} aria-invalid={!!nameError && draft.displayName.length > 0}
            aria-describedby={nameError && draft.displayName.length > 0 ? 'provider-name-feedback' : undefined}
            onChange={e => setDraft({ ...draft, displayName: e.target.value })} />
          {nameError && draft.displayName.length > 0 && <small id="provider-name-feedback" className="provider-field-error" aria-live="polite">{nameError}</small>}
        </div></div>
      </div>
      <div className="field-row"><label className="fr-label" htmlFor="provider-url">URL</label><div className="fr-value"><input id="provider-url" className="txt-input" type="url" required value={draft.baseUrl} placeholder="https://api.example.com/v1" disabled={busy} onChange={e => setDraft({ ...draft, baseUrl: e.target.value, ...(!draft.id && setupProvider === 'custom' ? { adapter: officialProviderForUrl(e.target.value)?.adapter ?? 'auto' as const } : {}) })} /></div></div>
      <div className="field-row"><div className="provider-key-heading"><label className="fr-label" htmlFor="provider-key">Key</label>{preset && <button type="button" className="provider-text-action" disabled={busy} onClick={() => void bridge.api.openSetupWebsite(preset.id).catch(error => showErrorToast(t('打开密钥管理页面失败'), error))}>{'local' in preset ? t('打开官网') : t('获取 Key')}<ArrowUpRight size={14} aria-hidden="true" /></button>}</div><div className="fr-value"><div className="provider-key-control"><input id="provider-key" className="txt-input" type={showBearerToken ? 'text' : 'password'} autoFocus={!draft.id} autoComplete="off" required={!isLocalProvider(draft)} placeholder={isLocalProvider(draft) ? t("可留空") : undefined} value={draft.bearerToken} disabled={busy} onChange={e => setDraft({ ...draft, bearerToken: e.target.value })} /><button type="button" className="provider-key-visibility" aria-label={showBearerToken ? t('隐藏访问密钥') : t('显示访问密钥')} aria-pressed={showBearerToken} aria-controls="provider-key" title={showBearerToken ? t('隐藏访问密钥') : t('显示访问密钥')} disabled={busy} onClick={() => setShowBearerToken(value => !value)}><Eye className="provider-key-icon-show" aria-hidden="true" /><EyeOff className="provider-key-icon-hide" aria-hidden="true" /></button></div></div></div>
      <div className="prov-save-bar">{savedProvider && managementOpen && <button type="button" className="provider-text-action configuration-destructive" disabled={busy} onClick={() => void remove(savedProvider)}><Trash2 size={16} aria-hidden="true" />{t('删除配置')}</button>}<button type="button" className="provider-text-action" disabled={busy} onClick={managementOpen ? closeEditor : returnProviderId.current !== undefined || (bridge.providers?.connections.some(item => !item.subscriptionAccountId)) ? returnToManagement : closeEditor}>{t("取消")}</button><button type="submit" className="btn primary" disabled={busy || !!nameError}>{t("保存")}</button></div>
    </form>;
  return <div id="providerList" aria-busy={busy}>
    <AddConfigurationDialog manageClients activeTab={configurationTab} initialTab={configurationTab} onTabChange={tab => {
      if (tab === configurationTab) return;
      if (tab === 'saved') { returnToManagement(); return; }
      if (managementOpen) returnProviderId.current = subscriptionConnection?.id ?? savedProvider?.id ?? null;
      setSubscriptionConnectionId(null); setSubscriptionPlatform(null);
      setConfigurationTab(tab); setManagementOpen(false); setChecksOpen(false); setSetupProvider(null); setEditorOpen(false);
    }} open={dialogOpen} busy={busy} selected={setupProvider} onSelect={add}
      onBack={() => { setSetupProvider(null); setEditorOpen(false); }} editor={checksOpen && savedProvider ? <ProviderConnectionChecks key={savedProvider.id} provider={savedProvider} disabled={busy} draftChanged={draftChanged} /> : managementOpen ? <div id="provider-config-panel" className="provider-detail-panel" role={savedProvider ? "tabpanel" : undefined} aria-labelledby={savedProvider ? "provider-config-tab" : undefined}>{editor}</div> : editor} finalFocus={editorTrigger}
      subscriptionEditor={managementOpen && subscriptionConnection && <SubscriptionAccountsPanel key={subscriptionPlatform} embedded initialPlatform={subscriptionPlatform} open={dialogOpen} visible={dialogOpen && configurationTab === 'saved'} />}
      managementOpen={managementOpen} onStartAdding={startAdding}
      onImported={imported}
      editorNavigation={savedProvider && managementOpen && <div className="configuration-tabs provider-detail-tabs" role="tablist" aria-label={t('模型服务详情')} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const models = event.key === 'End' || (event.key !== 'Home' && !checksOpen);
        setChecksOpen(models);
        document.getElementById(models ? 'provider-models-tab' : 'provider-config-tab')?.focus();
      }}>
        <button id="provider-config-tab" role="tab" type="button" aria-selected={!checksOpen} aria-controls="provider-config-panel" tabIndex={checksOpen ? -1 : 0} onClick={() => setChecksOpen(false)} disabled={busy}>{t('配置')}</button>
        <button id="provider-models-tab" role="tab" type="button" aria-selected={checksOpen} aria-controls="provider-models-panel" tabIndex={checksOpen ? 0 : -1} onClick={() => setChecksOpen(true)} disabled={busy}>{t('模型')}</button>
      </div>}
      draftName={editorOpen ? draft?.displayName : undefined} connectionNames={Object.fromEntries(Object.entries(drafts).filter(([, value]) => !!value.id).map(([id, value]) => [id, value.displayName]))}
      savedConnections={bridge.providers?.connections ?? []} selectedConnectionId={subscriptionConnection?.id ?? (editorOpen ? draft?.id : undefined)}
      onEditConnection={provider => edit(provider, editorTrigger.current)}
      onOpenChange={open => { setDialogOpen(open); if (!open) { setEditorOpen(false); setChecksOpen(false); setShowBearerToken(false); } }} />
    {configuredConnections.map(p => <div className="provider" key={p.id}>
      <div className="provider-list-row">
        <button id={`provider-edit-${p.id}`} type="button" className="provider-disclosure" disabled={busy} aria-label={t("编辑模型服务 {0}", p.subscriptionAccountId ? t(subscriptionServiceNames[subscriptionPlatformForAccount(p.subscriptionAccountId)]) : p.displayName)} aria-haspopup="dialog" onClick={e => {
          edit(p, e.currentTarget);
        }}>
          <ProviderIcon kind={p.subscriptionAccountId ? subscriptionServiceIcon(p.subscriptionAccountId) : providerIconKind(p.baseUrl)} />
          <span className="provider-name">{p.subscriptionAccountId ? t(subscriptionServiceNames[subscriptionPlatformForAccount(p.subscriptionAccountId)]) : p.displayName}</span>
        </button>

      </div>
    </div>)}
  </div>;
}
