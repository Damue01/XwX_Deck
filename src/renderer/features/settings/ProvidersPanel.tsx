import * as React from 'react';
import { Menu } from '@base-ui/react/menu';
import { Ellipsis, Pencil, Plus } from 'lucide-react';
import { useBridge } from '@/bridge/store';
import { showErrorToast, showToast } from '@/lib/toast';
import {
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
  const [draft, setDraft] = React.useState<ProviderInput | null>(null);
  const [busy, setBusy] = React.useState(false);
  const lock = React.useRef(false);
  const editorTrigger = React.useRef<HTMLButtonElement | null>(null);
  const addButton = React.useRef<HTMLButtonElement | null>(null);
  const closeEditor = () => {
    setDraft(null);
    requestAnimationFrame(() => editorTrigger.current?.focus());
  };
  const refresh = async () => {
    const [providers, compatibleServiceConfig, modelServices, codexConfig, claudeModels] = await Promise.allSettled([
      bridge.api.getProviders(), bridge.api.getCompatibleServiceConfig(), bridge.api.getModelServices(), bridge.api.getCodexConfig(), bridge.api.getClaudeModels()
    ]);
    bridge.patch({
      ...(providers.status === 'fulfilled' ? { providers: providers.value } : {}),
      ...(compatibleServiceConfig.status === 'fulfilled' ? { compatibleServiceConfig: compatibleServiceConfig.value } : {}),
      ...(modelServices.status === 'fulfilled' ? { modelServices: modelServices.value } : {}),
      ...(codexConfig.status === 'fulfilled' ? { codexConfig: codexConfig.value } : {}),
      ...(claudeModels.status === 'fulfilled' ? { claudeModels: claudeModels.value } : {}),
      modelCatalog: []
    });
    return [providers, compatibleServiceConfig, modelServices, codexConfig, claudeModels].every(result => result.status === 'fulfilled');
  };
  const run = async (operation: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await operation(); }
    catch (error) { showErrorToast('服务连接操作失败', error); }
    finally { lock.current = false; setBusy(false); }
  };
  const edit = (p: ProviderConnection, trigger: HTMLButtonElement) => {
    editorTrigger.current = trigger;
    setDraft({ id: p.id, displayName: p.displayName, baseUrl: p.baseUrl, bearerToken: p.bearerToken, adapter: p.adapter, providerPreset: p.providerPreset, codexModel: p.codexModel });
  };
  const editor = draft && <form key={draft.id ?? 'new'} id="provider-editor" className="provider-editor" aria-label={draft.id ? '编辑服务连接' : '添加服务连接'} aria-busy={busy} onSubmit={e => {
    e.preventDefault();
    void run(async () => {
      const providers = await bridge.api.saveProvider(draft);
      bridge.patch({ providers });
      const provider = draft.id
        ? providers.connections.find(item => item.id === draft.id)
        : providers.connections.at(-1);
      closeEditor();
      showToast('连接已保存，正在后台验证…', 'info', VALIDATION_TOAST_ID);
      void refresh();
      if (provider) {
        void bridge.api.validateProvider({ providerId: provider.id })
          .then(showValidationResult)
          .catch(() => showToast(`${provider.displayName} 暂时无法完成连接验证`, 'error', VALIDATION_TOAST_ID, {
            description: '配置已保存且未自动更改，请检查地址或稍后重试。',
            timeout: 8_000
          }));
      }
    });
  }}>
      <div className="field-row"><label className="fr-label" htmlFor="provider-name">名称</label><div className="fr-value"><input id="provider-name" autoFocus className="txt-input" required maxLength={80} value={draft.displayName} disabled={busy} onChange={e => setDraft({ ...draft, displayName: e.target.value })} /></div></div>
      <div className="field-row"><label className="fr-label" htmlFor="provider-url">API 地址</label><div className="fr-value"><input id="provider-url" className="txt-input" type="url" required value={draft.baseUrl} placeholder="https://api.example.com/v1" disabled={busy} onChange={e => setDraft({ ...draft, baseUrl: e.target.value })} /></div></div>
      <div className="field-row"><label className="fr-label" htmlFor="provider-key">访问密钥</label><div className="fr-value"><input id="provider-key" className="txt-input" type="password" autoComplete="off" required value={draft.bearerToken} disabled={busy} onChange={e => setDraft({ ...draft, bearerToken: e.target.value })} /></div></div>
      <div className="field-row"><label className="fr-label" htmlFor="provider-adapter">接口</label><div className="fr-value"><select id="provider-adapter" className="txt-input" value={draft.adapter} disabled={busy} onChange={e => setDraft({ ...draft, adapter: e.target.value as ProviderInput['adapter'] })}><option value="auto">自动识别</option><option value="responses">OpenAI Responses</option><option value="chat-completions">Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option></select></div></div>
      <div className="field-row"><label className="fr-label" htmlFor="provider-model">模型 ID</label><div className="fr-value"><input id="provider-model" className="txt-input" value={draft.codexModel ?? ''} placeholder="可选；服务无模型目录时填写" disabled={busy} onChange={e => setDraft({ ...draft, codexModel: e.target.value })} /></div></div>
      <p className="provider-validation-note">保存后会在后台发送最小验证请求；配置不会被自动修改。</p>
      <div className="prov-save-bar"><button type="button" className="provider-text-action" disabled={busy} onClick={closeEditor}>取消</button><button type="submit" className="btn primary" disabled={busy}>保存</button></div>
    </form>;
  return <div id="providerList" aria-busy={busy}>
    <div className="group-label provider-heading">
      <span className="eyebrow">服务商</span>
      <button ref={addButton} type="button" className="provider-text-action" aria-label="添加服务连接" disabled={busy} onClick={e => { editorTrigger.current = e.currentTarget; setDraft(empty); }}><Plus aria-hidden="true" />添加</button>
    </div>
    {!bridge.providers?.connections.length && !draft ? <p className="provider-empty">添加你使用的 API 服务连接。</p> : null}
    {(bridge.providers?.connections ?? []).map(p => <div className="provider" key={p.id}>
      <div className="provider-list-row">
        <span className="provider-name">{p.displayName}</span>
        <div className="provider-row-actions">
        <button type="button" className="provider-edit-trigger" disabled={busy} aria-label={`编辑 ${p.displayName}`} aria-expanded={draft?.id === p.id} aria-controls={draft?.id === p.id ? 'provider-editor' : undefined} onClick={e => draft?.id === p.id ? closeEditor() : edit(p, e.currentTarget)}>
          <Pencil aria-hidden="true" />
        </button>
        <Menu.Root>
          <Menu.Trigger type="button" className="provider-menu-trigger" aria-label={`${p.displayName} 的更多操作`} disabled={busy}><Ellipsis aria-hidden="true" /></Menu.Trigger>
          <Menu.Portal><Menu.Positioner className="conversation-header-menu-positioner" side="bottom" align="end" sideOffset={4}>
            <Menu.Popup className="conversation-header-menu provider-menu">
              <Menu.Item className="conversation-header-menu-item" closeOnClick onClick={() => void run(async () => {
                showToast('正在检查模型目录…');
                const models = await bridge.api.fetchProviderModels({ providerId: p.id, refresh: true });
                showToast(models.length ? `${p.displayName} 模型目录可访问，共 ${models.length} 个模型` : `${p.displayName} 未公开模型目录，可在连接中填写模型 ID。`, 'info');
              })}>检查模型目录</Menu.Item>
              <Menu.Item className="conversation-header-menu-item" closeOnClick onClick={() => void run(async () => {
                const providers = await bridge.api.deleteProvider(p.id);
                bridge.patch({ providers });
                if (draft?.id === p.id) setDraft(null);
                const refreshed = await refresh();
                showToast(refreshed ? '连接已删除' : '连接已删除，部分状态未能刷新，请重新进入页面。');
                requestAnimationFrame(() => addButton.current?.focus());
              })}>删除连接</Menu.Item>
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
