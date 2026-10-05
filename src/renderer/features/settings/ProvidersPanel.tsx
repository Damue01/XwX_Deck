import * as React from 'react';
import { Menu } from '@base-ui/react/menu';
import { Ellipsis, Eye, EyeOff, Pencil, Plus } from 'lucide-react';
import { useBridge } from '@/bridge/store';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { OPEN_PROVIDER_SETTINGS_EVENT, showErrorToast, showToast } from '@/lib/toast';
import { modelCatalogFailureMessage } from '../../../shared/modelCatalogError';
import {
  providerNameError,
  type ProviderInput,
  type ProviderConnection,
  type ProviderValidationResult
} from '../../../shared/providers';

const empty: ProviderInput = { displayName: '', baseUrl: '', bearerToken: '', adapter: 'auto' };

const VALIDATION_TOAST_ID = 'provider-validation';

function adapterLabel(adapter: ProviderValidationResult['suggestedAdapter']): string {
  if (adapter === 'chat-completions') return 'Chat Completions';
  if (adapter === 'anthropic-messages') return 'Anthropic Messages';
  return 'OpenAI Responses';
}

function showValidationResult(result: ProviderValidationResult): void {
  if (result.status === 'stale') return;
  if (result.status === 'valid') {
    showToast(`${result.providerName} 连接验证成功`, 'success', VALIDATION_TOAST_ID);
    return;
  }
  if (result.status === 'suggestion' && result.suggestedBaseUrl && result.suggestedAdapter) {
    const protocolOnly = result.suggestionReason === 'protocol';
    showToast(`${result.providerName} 的${protocolOnly ? '接口类型' : '接口地址'}可能有误`, 'info', VALIDATION_TOAST_ID, {
      description: protocolOnly
        ? `当前模型通过 ${adapterLabel(result.suggestedAdapter)} 验证。建议在连接中选择该接口；当前配置未更改。`
        : `建议将 API 地址改为 ${result.suggestedBaseUrl}，接口选择 ${adapterLabel(result.suggestedAdapter)}。当前配置未更改。`,
      timeout: 12_000
    });
    return;
  }
  if (result.status === 'authentication-error') {
    showToast(`${result.providerName} 地址可达，但密钥无效或权限不足`, 'error', VALIDATION_TOAST_ID, { timeout: 8_000 });
    return;
  }
  if (result.status === 'model-error') {
    showToast(`${result.providerName} 地址可达，但模型 ID 不可用`, 'info', VALIDATION_TOAST_ID, { timeout: 8_000 });
    return;
  }
  if (result.status === 'reachable') {
    showToast(`${result.providerName} 接口可达，但未能完成模型验证`, 'info', VALIDATION_TOAST_ID, { timeout: 8_000 });
    return;
  }
  showToast(`${result.providerName} 暂时无法完成连接验证`, 'error', VALIDATION_TOAST_ID, {
    description: '配置已保存且未自动更改，请检查地址或稍后重试。',
    timeout: 8_000
  });
}

export function ProvidersPanel(): React.ReactElement {
  const bridge = useBridge();
  const confirm = useConfirm();
  const [draft, setDraft] = React.useState<ProviderInput | null>(null);
  const [showBearerToken, setShowBearerToken] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const previousName = bridge.providers?.connections.find(provider => provider.id === draft?.id)?.displayName;
  const nameError = draft ? providerNameError(draft.displayName, previousName)
    || (draft.displayName !== previousName && bridge.providers?.connections.some(provider => provider.id !== draft.id && (provider.displayName === draft.displayName || provider.codexProviderId === draft.displayName)) ? '此名称已被其他连接使用。' : undefined) : undefined;
  const lock = React.useRef(false);
  const refreshGeneration = React.useRef(0);
  const editorTrigger = React.useRef<HTMLButtonElement | null>(null);
  const addButton = React.useRef<HTMLButtonElement | null>(null);
  const closeEditor = () => {
    setShowBearerToken(false);
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
    setShowBearerToken(false);
    setDraft({ id: p.id, displayName: p.displayName, baseUrl: p.baseUrl, bearerToken: p.bearerToken, adapter: p.adapter, providerPreset: p.providerPreset, codexModel: p.codexModel });
  }, []);
  React.useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      const provider = bridge.providers?.connections.find(item => item.id === id);
      if (!provider) return;
      edit(provider, document.getElementById(`provider-edit-${id}`) as HTMLButtonElement | null);
      requestAnimationFrame(() => {
        document.getElementById('provider-editor')?.scrollIntoView({ block: 'center' });
        document.getElementById(!provider.baseUrl.trim() ? 'provider-url' : 'provider-key')?.focus();
      });
    };
    window.addEventListener(OPEN_PROVIDER_SETTINGS_EVENT, open);
    return () => window.removeEventListener(OPEN_PROVIDER_SETTINGS_EVENT, open);
  }, [bridge.providers, edit]);
  const editor = draft && <form key={draft.id ?? 'new'} id="provider-editor" className="provider-editor" aria-label={draft.id ? '编辑模型服务' : '添加模型服务'} aria-busy={busy} onSubmit={e => {
    e.preventDefault();
    if (nameError) return;
    void run('保存模型服务失败', async () => {
      const providers = await bridge.api.saveProvider(draft);
      bridge.patch({ providers });
      refresh();
      closeEditor();
      const endpointIncluded = /\/(?:responses(?:\/compact)?|chat\/completions|messages)\/?$/i.test(new URL(draft.baseUrl).pathname);
      showToast('模型服务已保存', 'success');
      const saved = draft.id ? providers.connections.find(p => p.id === draft.id) : providers.connections.at(-1);
      if (saved) void bridge.api.validateProvider({ providerId: saved.id }).then(showValidationResult).catch(error => showErrorToast('连接验证未完成', error, VALIDATION_TOAST_ID));
      if (endpointIncluded) {
        showToast('请核对 API 地址路径', 'info', undefined, {
          description: '地址包含完整接口路径。请按服务商文档确认是否应去掉末尾的 responses、chat/completions 或 messages。'
        });
      }
    });
  }}>
      <div className="field-row">
        <label className="fr-label" htmlFor="provider-name">名称</label>
        <div className="fr-value"><div className="provider-name-field">
          <input id="provider-name" type="text" autoFocus className="txt-input" required maxLength={80}
            value={draft.displayName} placeholder="仅支持英文字母、数字、下划线和连字符"
            disabled={busy} aria-invalid={!!nameError && draft.displayName.length > 0}
            aria-describedby={nameError && draft.displayName.length > 0 ? 'provider-name-feedback' : undefined}
            onChange={e => setDraft({ ...draft, displayName: e.target.value })} />
          {nameError && draft.displayName.length > 0 && <small id="provider-name-feedback" className="provider-field-error" aria-live="polite">{nameError}</small>}
        </div></div>
      </div>
      <div className="field-row"><label className="fr-label" htmlFor="provider-url">API 地址</label><div className="fr-value"><input id="provider-url" className="txt-input" type="url" required value={draft.baseUrl} placeholder="https://api.example.com/v1" disabled={busy} onChange={e => setDraft({ ...draft, baseUrl: e.target.value })} /></div></div>
      <div className="field-row"><label className="fr-label" htmlFor="provider-key">访问密钥</label><div className="fr-value"><div className="provider-key-control"><input id="provider-key" className="txt-input" type={showBearerToken ? 'text' : 'password'} autoComplete="off" required value={draft.bearerToken} disabled={busy} onChange={e => setDraft({ ...draft, bearerToken: e.target.value })} /><button type="button" className="provider-key-visibility" aria-label={showBearerToken ? '隐藏访问密钥' : '显示访问密钥'} aria-pressed={showBearerToken} aria-controls="provider-key" title={showBearerToken ? '隐藏访问密钥' : '显示访问密钥'} disabled={busy} onClick={() => setShowBearerToken(value => !value)}><Eye className="provider-key-icon-show" aria-hidden="true" /><EyeOff className="provider-key-icon-hide" aria-hidden="true" /></button></div></div></div>
      <div className="prov-save-bar"><button type="button" className="provider-text-action" disabled={busy} onClick={closeEditor}>取消</button><button type="submit" className="btn primary" disabled={busy || !!nameError}>保存</button></div>
    </form>;
  return <div id="providerList" aria-busy={busy}>
    <div className="group-label provider-heading">
      <span className="eyebrow">模型服务</span>
      <button ref={addButton} type="button" className="provider-text-action" aria-label="添加模型服务" disabled={busy} onClick={e => { editorTrigger.current = e.currentTarget; setShowBearerToken(false); setDraft(empty); }}><Plus aria-hidden="true" />添加</button>
    </div>
    {!bridge.providers?.connections.length && !draft ? <p className="provider-empty">添加你使用的 API 服务连接。</p> : null}
    {(bridge.providers?.connections ?? []).map(p => <div className="provider" key={p.id}>
      <div className="provider-list-row">
        <span className="provider-name">{p.displayName}</span>
        <div className="provider-row-actions">
        <button id={`provider-edit-${p.id}`} type="button" className="provider-edit-trigger" disabled={busy} aria-label={`编辑模型服务 ${p.displayName}`} aria-expanded={draft?.id === p.id} aria-controls={draft?.id === p.id ? 'provider-editor' : undefined} onClick={e => draft?.id === p.id ? closeEditor() : edit(p, e.currentTarget)}>
          <Pencil aria-hidden="true" />
        </button>
        <Menu.Root>
          <Menu.Trigger type="button" className="provider-menu-trigger" aria-label={`${p.displayName} 的更多操作`} disabled={busy}><Ellipsis aria-hidden="true" /></Menu.Trigger>
          <Menu.Portal><Menu.Positioner className="conversation-header-menu-positioner" side="bottom" align="end" sideOffset={4}>
            <Menu.Popup className="conversation-header-menu provider-menu">
              <Menu.Item className="conversation-header-menu-item" closeOnClick onClick={() => void (async () => {
                try {
                showToast('正在检查模型目录…');
                const models = await bridge.api.fetchProviderModels({ providerId: p.id, refresh: true });
                const discovered = models;
                showToast(discovered.length
                  ? `${p.displayName} 模型目录可访问，共 ${discovered.length} 个模型`
                  : `${p.displayName} 未公开模型目录`, 'info', undefined, {
                      description: '此检查只读取模型目录。目录缺失不代表对话服务不可用；目录可访问也不代表密钥有权使用所选模型，请发送新消息验证。',
                      timeout: 12_000
                    });
                } catch (error) {
                  showToast('模型目录加载失败', 'error', undefined, {
                    description: modelCatalogFailureMessage(error)
                  });
                }
              })()}>检查模型目录</Menu.Item>
              <Menu.Item className="conversation-header-menu-item" closeOnClick onClick={() => void (async () => {
                const ok = await confirm({
                  title: `删除模型服务「${p.displayName}」？`,
                  body: '使用它的客户端需要重新选择模型服务。',
                  confirmText: '删除',
                  tone: 'danger'
                });
                if (!ok) return;
                await run('删除模型服务失败', async () => {
                const providers = await bridge.api.deleteProvider(p.id);
                bridge.patch({ providers });
                if (draft?.id === p.id) setDraft(null);
                refresh();
                showToast('模型服务已删除');
                requestAnimationFrame(() => addButton.current?.focus());
                });
              })()}>删除</Menu.Item>
            </Menu.Popup>
          </Menu.Positioner></Menu.Portal>
        </Menu.Root>
        </div>
      </div>
      {draft?.id === p.id && editor}
    </div>)}
    {draft && !draft.id && editor}
  </div>;
}
