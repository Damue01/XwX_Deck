import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import { Menu } from '@base-ui/react/menu';
import { ChevronDown, Ellipsis, Eye, EyeOff } from 'lucide-react';
import { ProviderIcon, providerIconKind } from './ProviderIcon';
import { AddConfigurationDialog, type ConfigurationTab } from './AddConfigurationDialog';
import { isCodingPlanConnection, isLocalProvider, newProviderDraft, officialProviderForUrl, type OfficialProviderId } from '../../../shared/officialProviders';
import { useBridge } from '@/bridge/store';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { OPEN_CONFIGURATION_EVENT, OPEN_PROVIDER_SETTINGS_EVENT, showErrorToast, showToast, type ConfigurationEntry } from '@/lib/toast';
import { modelCatalogFailureMessage } from '../../../shared/modelCatalogError';
import {
  providerNameError,
  type ProviderInput,
  type ProviderConnection,
  type ProviderValidationResult
} from '../../../shared/providers';

const VALIDATION_TOAST_ID = 'provider-validation';

function adapterLabel(adapter: ProviderValidationResult['suggestedAdapter']): string {
  if (adapter === 'chat-completions') return 'Chat Completions';
  if (adapter === 'anthropic-messages') return 'Anthropic Messages';
  return 'OpenAI Responses';
}

function showValidationResult(result: ProviderValidationResult): void {
  if (result.status === 'stale') return;
  if (result.status === 'valid') {
    showToast(t("{0} 连接验证成功", result.providerName), 'success', VALIDATION_TOAST_ID);
    return;
  }
  if (result.status === 'suggestion' && result.suggestedBaseUrl && result.suggestedAdapter) {
    const protocolOnly = result.suggestionReason === 'protocol';
    showToast(t("{0} 的{1}可能有误", result.providerName, t(protocolOnly ? '接口类型' : '接口地址')), 'info', VALIDATION_TOAST_ID, {
      description: protocolOnly
        ? t("当前模型通过 {0} 验证。建议在连接中选择该接口；当前配置未更改。", adapterLabel(result.suggestedAdapter))
        : t("建议将 API 地址改为 {0}，接口选择 {1}。当前配置未更改。", result.suggestedBaseUrl, adapterLabel(result.suggestedAdapter)),
      timeout: 12_000
    });
    return;
  }
  if (result.status === 'authentication-error') {
    showToast(t("{0} 地址可达，但密钥无效或权限不足", result.providerName), 'error', VALIDATION_TOAST_ID, { timeout: 8_000 });
    return;
  }
  if (result.status === 'model-error') {
    showToast(t("{0} 地址可达，但模型 ID 不可用", result.providerName), 'info', VALIDATION_TOAST_ID, { timeout: 8_000 });
    return;
  }
  if (result.status === 'reachable') {
    showToast(t("{0} 接口可达，但未能完成模型验证", result.providerName), 'info', VALIDATION_TOAST_ID, { timeout: 8_000 });
    return;
  }
  showToast(t("{0} 暂时无法完成连接验证", result.providerName), 'error', VALIDATION_TOAST_ID, {
    description: t('配置已保存且未自动更改，请检查地址或稍后重试。'),
    timeout: 8_000
  });
}

export function ProvidersPanel({ onRequestOpen }: { onRequestOpen: () => void }): React.ReactElement {
  useLanguage();
  const bridge = useBridge();
  const confirm = useConfirm();
  const [drafts, setDrafts] = React.useState<Record<string, ProviderInput>>({});
  const [draftKey, setDraftKey] = React.useState('new');
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [setupProvider, setSetupProvider] = React.useState<OfficialProviderId | 'custom' | null>(null);
  const [configurationTab, setConfigurationTab] = React.useState<ConfigurationTab>('services');
  const [subscriptionPlatform, setSubscriptionPlatform] = React.useState<'chatgpt' | 'grok' | 'copilot' | 'claude' | 'cursor'>('chatgpt');
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const draft = drafts[draftKey] ?? null;
  const setDraft = (value: ProviderInput | null) => setDrafts(current => {
    const next = { ...current };
    if (value) next[draftKey] = value;
    else delete next[draftKey];
    return next;
  });
  const [showBearerToken, setShowBearerToken] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const previousName = bridge.providers?.connections.find(provider => provider.id === draft?.id)?.displayName;
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
      setSubscriptionPlatform('chatgpt');
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
    setDraft(null);
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
    if (p.subscriptionAccountId) { setSubscriptionPlatform(p.subscriptionAccountId.startsWith('cursor-') ? 'cursor' : p.subscriptionAccountId.startsWith('claude-subscription-') ? 'claude' : p.subscriptionAccountId.startsWith('copilot-') ? 'copilot' : p.subscriptionAccountId.startsWith('grok-') ? 'grok' : 'chatgpt'); setConfigurationTab('accounts'); setDialogOpen(true); setEditorOpen(false); return; }

    setDialogOpen(false);
    setShowBearerToken(false);
    setDraftKey(p.id);
    setEditorOpen(true);
    setDrafts(current => current[p.id] ? current : { ...current, [p.id]: { id: p.id, displayName: p.displayName, baseUrl: p.baseUrl, bearerToken: p.bearerToken, adapter: p.adapter, providerPreset: p.providerPreset, codexModel: p.codexModel } });
  }, []);
  const add = (preset: OfficialProviderId | 'custom') => {
    const key = `new:${preset}`;
    setShowBearerToken(false);
    setDraftKey(key);
    setSetupProvider(preset);
    setEditorOpen(true);
    setDrafts(current => current[key] ? current : { ...current, [key]: newProviderDraft(bridge.providers?.connections, preset) });
  };
  React.useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      const provider = bridge.providers?.connections.find(item => item.id === id);
      if (!provider) return;
      onRequestOpen();
      edit(provider, document.getElementById(`provider-edit-${id}`) as HTMLButtonElement | null);
      requestAnimationFrame(() => {
        document.getElementById('provider-editor')?.scrollIntoView({ block: 'center' });
        document.getElementById(!provider.baseUrl.trim() ? 'provider-url' : 'provider-key')?.focus();
      });
    };
    window.addEventListener(OPEN_PROVIDER_SETTINGS_EVENT, open);
    return () => window.removeEventListener(OPEN_PROVIDER_SETTINGS_EVENT, open);
  }, [bridge.providers, edit, onRequestOpen]);
  const editor = draft && <form key={draft.id ?? draftKey} id="provider-editor" className="provider-editor" hidden={!editorOpen} aria-label={draft.id ? t('编辑模型服务') : t('添加模型服务')} aria-busy={busy} onSubmit={e => {
    e.preventDefault();
    if (nameError) return;
    void run(t('保存模型服务失败'), async () => {
      const providers = await bridge.api.saveProvider(draft);
      bridge.patch({ providers });
      refresh();
      closeEditor();
      const endpointIncluded = /\/(?:responses(?:\/compact)?|chat\/completions|messages)\/?$/i.test(new URL(draft.baseUrl).pathname);
      showToast(t('模型服务已保存'), 'success');
      const saved = draft.id ? providers.connections.find(p => p.id === draft.id) : providers.connections.at(-1);
      if (saved && !isCodingPlanConnection(saved)) void bridge.api.validateProvider({ providerId: saved.id }).then(showValidationResult).catch(error => showErrorToast(t('连接验证未完成'), error, VALIDATION_TOAST_ID));
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
      <div className="field-row"><label className="fr-label" htmlFor="provider-key">Key</label><div className="fr-value"><div className="provider-key-control"><input id="provider-key" className="txt-input" type={showBearerToken ? 'text' : 'password'} autoFocus={!draft.id} autoComplete="off" required={!isLocalProvider(draft)} placeholder={isLocalProvider(draft) ? t("可留空") : undefined} value={draft.bearerToken} disabled={busy} onChange={e => setDraft({ ...draft, bearerToken: e.target.value })} /><button type="button" className="provider-key-visibility" aria-label={showBearerToken ? t('隐藏访问密钥') : t('显示访问密钥')} aria-pressed={showBearerToken} aria-controls="provider-key" title={showBearerToken ? t('隐藏访问密钥') : t('显示访问密钥')} disabled={busy} onClick={() => setShowBearerToken(value => !value)}><Eye className="provider-key-icon-show" aria-hidden="true" /><EyeOff className="provider-key-icon-hide" aria-hidden="true" /></button></div></div></div>
      {(draft.id || setupProvider === 'custom') && <details className="provider-advanced">
        <summary>{t("高级设置")}</summary>
        <div className="field-row"><label className="fr-label" htmlFor="provider-adapter">{t("接口协议")}</label><div className="fr-value"><select id="provider-adapter" className="txt-input" value={draft.adapter} disabled={busy} onChange={e => setDraft({ ...draft, adapter: e.target.value as ProviderInput['adapter'] })}>
          <option value="auto">{t("自动识别")}</option><option value="responses">OpenAI Responses</option><option value="chat-completions">OpenAI Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option>
        </select></div></div>
      </details>}
      <div className="prov-save-bar"><button type="button" className="provider-text-action" disabled={busy} onClick={closeEditor}>{t("取消")}</button><button type="submit" className="btn primary" disabled={busy || !!nameError}>{t("保存")}</button></div>
    </form>;
  return <div id="providerList" aria-busy={busy}>
    <AddConfigurationDialog clientsOnly={configurationTab === 'clients'} initialTab={configurationTab} initialSubscriptionPlatform={subscriptionPlatform} open={dialogOpen} busy={busy} selected={setupProvider} onSelect={add}
      onBack={() => setSetupProvider(null)} editor={draft?.id ? null : editor} finalFocus={editorTrigger}
      onOpenChange={open => { setDialogOpen(open); if (!open) { setEditorOpen(false); setShowBearerToken(false); } }} />
    {(bridge.providers?.connections ?? []).map(p => <div className="provider" key={p.id}>
      <div className="provider-list-row">
        <button id={`provider-edit-${p.id}`} type="button" className="provider-disclosure" disabled={busy} aria-label={t("编辑模型服务 {0}", p.displayName)} aria-expanded={draft?.id === p.id && editorOpen} aria-controls={draft?.id === p.id ? 'provider-editor' : undefined} onClick={e => {
          setShowBearerToken(false);
          if (p.subscriptionAccountId) edit(p, e.currentTarget);
          else if (draft?.id === p.id) setEditorOpen(open => !open);
          else edit(p, e.currentTarget);
        }}>
          <ProviderIcon kind={providerIconKind(drafts[p.id]?.baseUrl ?? p.baseUrl)} />
          <span className="provider-name">{drafts[p.id]?.displayName || p.displayName}</span>
          <ChevronDown className="trace-section-chevron" aria-hidden="true" />
        </button>
        <div className="provider-row-actions">
        <Menu.Root>
          <Menu.Trigger type="button" className="provider-menu-trigger" aria-label={t("{0} 的更多操作", p.displayName)} disabled={busy}><Ellipsis aria-hidden="true" /></Menu.Trigger>
          <Menu.Portal><Menu.Positioner className="conversation-header-menu-positioner" side="bottom" align="end" sideOffset={4}>
            <Menu.Popup className="conversation-header-menu provider-menu">
              <Menu.Item className="conversation-header-menu-item" closeOnClick onClick={() => void (async () => {
                try {
                showToast(t('正在检查模型目录…'));
                const models = await bridge.api.fetchProviderModels({ providerId: p.id, refresh: true });
                const discovered = models;
                showToast(discovered.length
                  ? t("{0} 模型目录可访问，共 {1} 个模型", p.displayName, discovered.length)
                  : t("{0} 未公开模型目录", p.displayName), 'info', undefined, {
                      description: t('此检查只读取模型目录。目录缺失不代表对话服务不可用；目录可访问也不代表密钥有权使用所选模型，请发送新消息验证。'),
                      timeout: 12_000
                    });
                } catch (error) {
                  showToast(t('模型目录加载失败'), 'error', undefined, {
                    description: modelCatalogFailureMessage(error)
                  });
                }
              })()}>{t("检查模型目录")}</Menu.Item>
              <Menu.Item className="conversation-header-menu-item" closeOnClick onClick={() => void (async () => {
                const ok = await confirm({
                  title: t("删除模型服务「{0}」？", p.displayName),
                  body: t('使用它的客户端需要重新选择模型服务。'),
                  confirmText: t('删除'),
                  tone: 'danger'
                });
                if (!ok) return;
                await run(t('删除模型服务失败'), async () => {
                const providers = await bridge.api.deleteProvider(p.id);
                bridge.patch({ providers });
                setDrafts(current => { const next = { ...current }; delete next[p.id]; return next; });
                refresh();
                showToast(t('模型服务已删除'));
                requestAnimationFrame(() => document.getElementById('provider-add')?.focus());
                });
              })()}>{t("删除")}</Menu.Item>
            </Menu.Popup>
          </Menu.Positioner></Menu.Portal>
        </Menu.Root>
        </div>
      </div>
      {draft?.id === p.id && editor}
    </div>)}
  </div>;
}
