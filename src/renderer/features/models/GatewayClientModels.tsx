import * as React from 'react';
import { ArrowUpRight, ChevronDown, Copy } from 'lucide-react';
import { t, useLanguage } from '@/lib/i18n';
import { useBridge } from '@/bridge/store';
import type { GatewayClientRoute, ModelCatalogEntry } from '@/bridge/types';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { ProviderPicker } from './ProviderPicker';
import { ModelPicker } from './ModelPicker';
import { showErrorToast, showToast } from '@/lib/toast';
import { CLIENT_DOWNLOADS, type DownloadClientId } from '../../../shared/clientDownloads';
import { CLIENT_GATEWAY_HELP } from '../../../shared/clientGatewaySetup';
import { ClientDownloads } from '../settings/ProviderSetupShortcuts';

export function GatewayClientModels({ client, active }: { client: DownloadClientId; active: boolean }): React.ReactElement {
  useLanguage();
  const bridge = useBridge();
  const confirm = useConfirm();
  const [route, setRoute] = React.useState<GatewayClientRoute | null>(null);
  const [provider, setProvider] = React.useState<string | null>(null);
  const [model, setModel] = React.useState('');
  const [catalog, setCatalog] = React.useState<readonly ModelCatalogEntry[]>([]);
  const [busy, setBusy] = React.useState(false);
  const saving = React.useRef(false);
  const generation = React.useRef(0);
  const label = CLIENT_DOWNLOADS.find(item => item.id === client)?.label ?? client;
  React.useEffect(() => {
    if (!active || !bridge.api.getClientRoute) return;
    let alive = true;
    void bridge.api.getClientRoute(client).then(value => {
      if (!alive) return;
      setRoute(value); setProvider(value.providerId); setModel(value.model || '');
    }).catch(error => { if (alive) showErrorToast(t('客户端配置读取失败'), error); });
    return () => { alive = false; };
  }, [client, active, bridge.api]);
  React.useEffect(() => {
    const current = ++generation.current;
    setCatalog([]);
    if (!active || !provider) { setCatalog([]); return; }
    // The catalog is optional. Its failure never prevents saving an explicit model.
    void bridge.api.fetchProviderModels({ providerId: provider }).then(value => {
      if (current === generation.current) setCatalog(value);
    }).catch(() => undefined);
    return () => { generation.current++; };
  }, [active, provider, bridge.api]);
  const save = async (providerId: string | null, modelId: string) => {
    if (saving.current || !providerId || !modelId || !bridge.api.getClientRoute || !bridge.api.setClientRoute) return;
    saving.current = true; setBusy(true);
    try {
      const latest = await bridge.api.getClientRoute(client);
      let takeoverConfirmed = false;
      if (latest.requiresTakeover) {
        takeoverConfirmed = await confirm({ title: t('接管 {0} 的模型连接', label), body: t('原连接会备份，关闭 Trace 后恢复。只修改模型连接，保留其他设置。'), confirmText: t('接管'), cancelText: t('取消') });
        if (!takeoverConfirmed) { setProvider(route?.providerId ?? null); setModel(route?.model ?? ''); return; }
      }
      const value = await bridge.api.setClientRoute({ client, providerId, model: modelId, configDigest: latest.configDigest, takeoverConfirmed });
      setRoute(value); setProvider(value.providerId); setModel(value.model);
      const runtime = await bridge.api.getState();
      bridge.patch({ runtime });
      showToast(t(client === 'workbuddy' ? '已保存，请在 WorkBuddy 任务中选择模型' : !value.automatic ? '模型配置已保存，请在客户端连接' : runtime.tracingEnabled ? '模型配置已保存' : '已保存，开启 Trace 后生效'), 'success');
    } catch (error) {
      setProvider(route?.providerId ?? null); setModel(route?.model ?? '');
      showErrorToast(t('模型配置保存失败'), error);
    } finally { saving.current = false; setBusy(false); }
  };
  if (!bridge.api.getClientRoute) return <ClientDownloads client={client} />;
  const gatewayBase = bridge.runtime?.localBaseUrl ? `${bridge.runtime.localBaseUrl}/clients/${client}` : null;
  const base = gatewayBase ? `${gatewayBase}${['gemini-cli', 'antigravity-cli'].includes(client) ? '' : '/v1'}` : null;
  const helpKey = `gateway-help-${client}` as keyof typeof CLIENT_GATEWAY_HELP;
  const help = CLIENT_GATEWAY_HELP[helpKey];
  if (client === 'cursor') return <><div className="field-row"><span className="fr-label">{t('模型连接')}</span><span className="fr-value">{t('Cursor CLI 暂不支持自动接管')}</span></div><ClientDownloads client="cursor" officialOnly /></>;
  return <>
    <div className="field-row">
      <label className="fr-label">{t('模型服务')}</label>
      <div className="fr-value"><ProviderPicker registry={bridge.providers} client="codex" clientLabel={label} value={provider} disabled={busy || !route} onChange={id => { setProvider(id); if (model) void save(id, model); }} /></div>
    </div>
    <div className="field-row">
      <span className="fr-label">{t('默认模型')}</span>
      <div className="fr-value"><ModelPicker value={model} catalog={catalog} disabled={busy || !provider} onChange={id => void save(provider, id)} noteFor={id => catalog.length && !catalog.some(item => item.id === id) ? { label: t('不在目录'), hint: t('保留已选择的模型') } : undefined} /></div>
    </div>
    {route && !route.automatic && <details className="setup-card-downloads gateway-client-connection">
      <summary>{t('连接设置')}<ChevronDown aria-hidden="true" /></summary>
      <div className="field-row">
      <span className="fr-label">{t('接入地址')}</span>
      <div className="fr-value"><button type="button" className="provider-text-action" disabled={!base || !route.providerId} aria-label={t('复制接入地址')} title={base ?? t('开启 Trace 后可连接')} onClick={() => { if (base) void bridge.api.copyText(base).then(() => showToast(t('已复制'), 'success')); }}><span className="mono">{base ?? t('开启 Trace 后可连接')}</span><Copy size={14} /></button></div>
    </div><div className="field-row">
      <span className="fr-label">{t('接入密钥')}</span>
      <div className="fr-value"><button type="button" className="provider-text-action" disabled={!base || !route.providerId} aria-label={t('复制接入密钥')} onClick={() => void bridge.api.copyText('xwx-deck').then(() => showToast(t('已复制'), 'success'))}><span className="mono">xwx-deck</span><Copy size={14} /></button></div>
    </div>
      {help && <a className="setup-card-link" href={help} target="_blank" rel="noopener noreferrer" onClick={event => { event.preventDefault(); void bridge.api.openSetupWebsite(helpKey).catch(error => showErrorToast(t('打开下载入口失败'), error)); }}>{t('查看连接说明')}<ArrowUpRight aria-hidden="true" /></a>}
    </details>}
  </>;
}
