import * as React from 'react';
import { ChevronRight, Ellipsis, Plus } from 'lucide-react';
import { Menu } from '@base-ui/react/menu';
import { useBridge } from '@/bridge/store';
import { ChoiceSelect } from '@/components/ui/choice-select';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Toggle } from '@/features/shell/Toggle';
import { useRememberedExpansion } from '@/lib/useRememberedExpansion';
import { groupSubscriptionConnections, subscriptionServiceIcon, subscriptionServiceNames, subscriptionPlatformForAccount } from '@/lib/subscriptionServices';
import { isNonConversationalModel, isUnavailableModel } from '../../../shared/modelAvailability';
import { EMPTY_SERVICE_SWITCHING_POLICY, type ServiceSwitchingClient } from '../../../shared/serviceSwitching';
import type { ProviderConnection } from '../../../shared/providers';
import type { ModelCatalogEntry } from '@/bridge/types';
import { ProviderIcon, providerIconKind } from './ProviderIcon';
import { SortableAccounts } from './SortableAccounts';
import { useServiceSwitching } from './useServiceSwitching';
import { useProviderModelDraft } from './useProviderModelDraft';

function name(provider: ProviderConnection): string {
  if (provider.subscriptionAccountId && subscriptionPlatformForAccount(provider.subscriptionAccountId) === 'chatgpt') {
    return provider.subscriptionAccountId.startsWith('official-chatgpt') ? 'ChatGPT 订阅（官方登录）' : 'ChatGPT 订阅（API 授权）';
  }
  return provider.subscriptionAccountId ? subscriptionServiceNames[subscriptionPlatformForAccount(provider.subscriptionAccountId)] : provider.displayName;
}
function serviceKey(provider: ProviderConnection): string {
  if (!provider.subscriptionAccountId) return provider.id;
  const platform = subscriptionPlatformForAccount(provider.subscriptionAccountId);
  return platform === 'chatgpt' ? (provider.subscriptionAccountId.startsWith('official-chatgpt') ? 'chatgpt-official' : 'chatgpt-api') : platform;
}
function ServiceActions({ label, onRemove }: { label: string; onRemove: () => void }) {
  const confirm = useConfirm();
  const trigger = React.useRef<HTMLButtonElement>(null);
  const pending = React.useRef(false);
  const remove = async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      if (await confirm({ title: `移除 ${label}？`, body: '仅从切换顺序中移除，保留服务配置、模型选择和账号登录', confirmText: '移除', tone: 'danger', returnFocus: trigger })) onRemove();
    } finally { pending.current = false; }
  };
  return <Menu.Root>
    <Menu.Trigger ref={trigger} type="button" className="provider-menu-trigger" aria-label={`${label} 的更多操作`}><Ellipsis size={16} aria-hidden="true" /></Menu.Trigger>
    <Menu.Portal><Menu.Positioner className="conversation-header-menu-positioner" side="bottom" align="end" sideOffset={4}>
      <Menu.Popup className="conversation-header-menu provider-menu"><Menu.Item className="conversation-header-menu-item" closeOnClick onClick={() => void remove()}>移除</Menu.Item></Menu.Popup>
    </Menu.Positioner></Menu.Portal>
  </Menu.Root>;
}

function ServiceModel({ provider, client }: { provider: ProviderConnection; client: ServiceSwitchingClient }) {
  const { api, patch } = useBridge();
  const [catalog, setCatalog] = React.useState<readonly ModelCatalogEntry[]>([]);
  const [catalogError, setCatalogError] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const loaded = React.useRef(false);
  const catalogVersion = React.useRef(0);
  const mounted = React.useRef(true);
  const [rolesOpen, setRolesOpen] = React.useState(false);
  const { draft, error, saving, save, retry } = useProviderModelDraft(api, provider.id, client, providers => patch({ providers }));
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const fetchModels = async () => {
    if (loading || loaded.current) return;
    const version = catalogVersion.current;
    setLoading(true);
    try { const entries = await api.fetchProviderModels({ providerId: provider.id }); if (mounted.current && version === catalogVersion.current) { setCatalog(entries.filter(entry => !isNonConversationalModel(entry) && !isUnavailableModel(entry))); setCatalogError(''); loaded.current = true; } }
    catch (failure) { if (mounted.current && version === catalogVersion.current) setCatalogError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (mounted.current && version === catalogVersion.current) setLoading(false); }
  };
  React.useEffect(() => { catalogVersion.current++; loaded.current = false; setCatalog([]); setCatalogError(''); setLoading(false); }, [provider.bearerToken]);
  const picker = (role: string, selected: string) => {
    const model = draft[role] ?? selected;
    const items = catalog.map(entry => ({ id: entry.id, label: entry.id }));
    if (model && !items.some(item => item.id === model)) items.unshift({ id: model, label: model });
    return <div className="routing-model" data-missing={!model || undefined}><ChoiceSelect variant="inline" label={`${name(provider)} 的${client === 'claude' ? ` ${role}` : ''}模型`} value={model || null} selectedLabel={model ? <span title={model}>{model}</span> : undefined} placeholder={loading ? '读取模型…' : '选择模型'} emptyLabel={loading ? '读取模型…' : '暂无可用模型'} items={items} disabled={saving} onOpen={() => void fetchModels()} onChange={id => void save(role, id)} /></div>;
  };
  return <>
    {client === 'codex' ? picker('codex', provider.codexModel) : <div className="routing-model"><button type="button" className="provider-text-action routing-role-trigger" aria-expanded={rolesOpen} onClick={() => { setRolesOpen(!rolesOpen); void fetchModels(); }}>按角色配置</button></div>}
    <div className="routing-model-details" hidden={!error && !catalogError && !(client === 'claude' && rolesOpen)}>
      {client === 'claude' && rolesOpen && ['fable', 'opus', 'sonnet', 'haiku'].map(role => <div className="routing-role-row" key={role}><span>{role}</span>{picker(role, provider.claudeModels[role as keyof typeof provider.claudeModels])}</div>)}
      {catalogError && <div className="provider-field-error" role="alert">模型列表读取失败 <button type="button" className="provider-text-action" onClick={() => void fetchModels()}>重试</button><span className="sr-only">{catalogError}</span></div>}
      {error && <div className="provider-field-error" role="alert">{error} <button type="button" className="provider-text-action" disabled={saving} onClick={retry}>重试保存</button></div>}
    </div>
  </>;
}

export function EnhancementsPanel(): React.ReactElement {
  const { api, providers, runtime } = useBridge();
  const state = useServiceSwitching(api);
  const [moduleOpen, setModuleOpen] = useRememberedExpansion('service-switching');
  const [client, setClient] = React.useState<ServiceSwitchingClient>('codex');
  const [adding, setAdding] = React.useState(false);
  const config = state.policies[client] ?? EMPTY_SERVICE_SWITCHING_POLICY;
  const connections = providers?.connections ?? [];
  const configuredServices = new Set(config.providerIds.map(id => connections.find(provider => provider.id === id)).filter((provider): provider is ProviderConnection => Boolean(provider)).map(serviceKey));
  const available = groupSubscriptionConnections(connections, undefined, true).filter(provider => !configuredServices.has(serviceKey(provider)));
  const accounts = config.providerIds.map(id => ({ id, label: connections.find(provider => provider.id === id) ? name(connections.find(provider => provider.id === id)!) : '服务已移除', email: '', status: 'connected' as const }));
  const update = (next: typeof config) => state.save(client, next);
  return <section className="configuration-detail routing-preview" aria-label="增强功能">
    <div className="group routing-feature-group">
      <div className="group-label"><button type="button" className="trace-section-trigger" aria-expanded={moduleOpen} aria-controls="routing-feature-content" onClick={() => setModuleOpen(!moduleOpen)}><span className="eyebrow">服务切换</span><ChevronRight size={15} className="trace-section-chevron" aria-hidden="true" /></button></div>
      <div id="routing-feature-content" hidden={!moduleOpen}>
        {state.loadError && <div className="provider-field-error" role="alert">{state.loadError} <button type="button" className="provider-text-action" onClick={() => void state.reload()}>重试</button></div>}
        <div className="field-row routing-client-row"><label htmlFor="routing-client">客户端</label><div className="fr-value"><ChoiceSelect id="routing-client" label="客户端" value={client} items={[{ id: 'codex', label: 'ChatGPT / Codex' }, { id: 'claude', label: 'Claude' }]} onChange={id => { setClient(id as ServiceSwitchingClient); setAdding(false); }} /></div></div>
        <div className="field-row routing-switch-row"><label htmlFor="routing-auto-switch">额度用尽时自动切换</label><div className="fr-value"><Toggle id="routing-auto-switch" ariaLabel="额度用尽时自动切换" title="当前服务额度用尽时，按列表顺序切换到下一个服务商，继续当前对话" checked={config.enabled} disabled={!state.loaded} onToggle={() => update({ ...config, enabled: !config.enabled })} /></div></div>
        {state.errors[client] && <div className="provider-field-error" role="alert">{state.errors[client]} <button type="button" className="provider-text-action" onClick={() => state.retry(client)}>重试保存</button></div>}
        <div className="routing-sequence" hidden={!config.enabled}>
          <div className="routing-section-heading"><span>切换顺序</span><button type="button" className="provider-text-action" disabled={!available.length} onClick={() => setAdding(value => !value)}><Plus size={14} aria-hidden="true" />添加服务</button></div>
          {adding && <div className="routing-add"><ChoiceSelect label="添加服务" value={null} placeholder="选择已添加的服务" items={available.map(provider => ({ id: provider.id, label: name(provider) }))} onChange={id => { update({ ...config, providerIds: [...config.providerIds, id] }); setAdding(false); }} /></div>}
          {!accounts.length && <p className="strategy-order-help">添加备用服务，沿用模型页保存的模型</p>}
          {runtime?.tracingEnabled === false && <p className="strategy-order-help">开启 Trace 后生效</p>}
          <div className="routing-services"><SortableAccounts accounts={accounts} onOrder={providerIds => update({ ...config, providerIds })}>{(account, handle) => {
            const provider = connections.find(item => item.id === account.id);
            return <div className="routing-service-row">{handle}<ProviderIcon kind={provider?.subscriptionAccountId ? subscriptionServiceIcon(provider.subscriptionAccountId) : providerIconKind(provider?.baseUrl ?? '')} /><span className="routing-service-name" title={account.label}>{account.label}</span>
              {provider ? <ServiceModel key={`${client}:${provider.id}:${provider.baseUrl}`} provider={provider} client={client} /> : <span />}
              <ServiceActions label={account.label} onRemove={() => { update({ ...config, providerIds: config.providerIds.filter(id => id !== account.id) }); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.routing-section-heading .provider-text-action')?.focus()); }} />
            </div>;
          }}</SortableAccounts></div>
          <span id="subscription-order-help" className="sr-only">拖动调整服务顺序，或聚焦排序把手使用上下方向键</span>
        </div>
      </div>
    </div>
  </section>;
}
