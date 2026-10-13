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
  const revision = React.useRef(0);
  const routeRead = React.useRef(0);
  const dirty = React.useRef(false);
  const mounted = React.useRef(true);
  const activeRef = React.useRef(active);
  activeRef.current = active;
  const runtimeRef = React.useRef(bridge.runtime);
  runtimeRef.current = bridge.runtime;
  const desired = React.useRef({ providerId: provider, model });
  const [catalogRetry, retryCatalog] = React.useReducer((value: number) => value + 1, 0);
  const [catalogBusy, setCatalogBusy] = React.useState(false);
  const label = CLIENT_DOWNLOADS.find(item => item.id === client)?.label ?? client;
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const readRoute = React.useCallback(async (): Promise<void> => {
    if (!bridge.api.getClientRoute || dirty.current || saving.current) return;
    const current = revision.current;
    const request = ++routeRead.current;
    try {
      const value = await bridge.api.getClientRoute(client);
      if (!mounted.current || !activeRef.current || request !== routeRead.current || current !== revision.current || dirty.current) return;
      setRoute(value); setProvider(value.providerId); setModel(value.model || '');
      desired.current = { providerId: value.providerId, model: value.model || '' };
    } catch (error) {
      if (mounted.current && activeRef.current && request === routeRead.current && current === revision.current) showErrorToast(t('客户端配置读取失败'), error, `client-read:${client}`, {
        actionProps: { children: t('重试'), onClick: () => void readRoute() }
      });
    }
  }, [client, bridge.api]);
  React.useEffect(() => {
    if (active) void readRoute();
    return () => { routeRead.current++; };
  }, [active, readRoute]);
  React.useEffect(() => {
    const current = ++generation.current;
    setCatalog([]);
    setCatalogBusy(false);
    if (!active || !provider) return;
    setCatalogBusy(true);
    // The catalog is optional. Its failure never prevents saving an explicit model.
    void bridge.api.fetchProviderModels({ providerId: provider }).then(value => {
      if (current === generation.current) setCatalog(value);
    }).catch(error => {
      if (current === generation.current) showErrorToast(t('模型列表读取失败'), error, `client-catalog:${client}`, {
        actionProps: { children: t('重试'), onClick: retryCatalog }
      });
    }).finally(() => { if (current === generation.current) setCatalogBusy(false); });
    return () => { generation.current++; };
  }, [active, provider, bridge.api, client, catalogRetry]);
  const save = async (providerId: string | null, modelId: string) => {
    if (saving.current || !providerId || !modelId || !bridge.api.getClientRoute || !bridge.api.setClientRoute) return;
    const current = revision.current;
    saving.current = true; setBusy(true);
    try {
      const latest = await bridge.api.getClientRoute(client);
      let takeoverConfirmed = false;
      if (latest.requiresTakeover) {
        takeoverConfirmed = await confirm({ title: t('接管 {0} 的模型连接', label), body: t('原连接会备份，关闭 Trace 后恢复。只修改模型连接，保留其他设置。'), confirmText: t('接管'), cancelText: t('取消') });
        if (!takeoverConfirmed) {
          if (mounted.current && current === revision.current) {
            desired.current = { providerId: route?.providerId ?? null, model: route?.model ?? '' };
            dirty.current = false; setProvider(desired.current.providerId); setModel(desired.current.model);
          }
          return;
        }
      }
      const value = await bridge.api.setClientRoute({ client, providerId, model: modelId, configDigest: latest.configDigest, takeoverConfirmed });
      if (!mounted.current || current !== revision.current) return;
      setRoute(value); dirty.current = false;
      setProvider(value.providerId); setModel(value.model);
      desired.current = { providerId: value.providerId, model: value.model };
      // A delayed runtime refresh must not hold the selector or overwrite a newer operation.
      const observedRuntime = runtimeRef.current;
      void bridge.api.getState().then(runtime => {
        if (mounted.current && current === revision.current && runtimeRef.current === observedRuntime) bridge.patch({ runtime });
      }).catch(() => undefined);
      if (activeRef.current) showToast(t(client === 'workbuddy' ? '已保存，请在 WorkBuddy 任务中选择模型' : !value.automatic ? '模型配置已保存，请在客户端连接' : bridge.runtime?.tracingEnabled ? '模型配置已保存' : '已保存，开启 Trace 后生效'), 'success');
    } catch (error) {
      if (mounted.current && activeRef.current) showErrorToast(t('模型配置保存失败'), error, `client-save:${client}`, {
        actionProps: { children: t('重试'), onClick: () => void save(desired.current.providerId, desired.current.model) }
      });
    } finally { saving.current = false; if (mounted.current) setBusy(false); }
  };
  const choose = (providerId: string | null, modelId: string) => {
    revision.current++; dirty.current = true;
    desired.current = { providerId, model: modelId };
    setProvider(providerId); setModel(modelId);
    void save(providerId, modelId);
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
      <div className="fr-value" aria-busy={busy}><ProviderPicker registry={bridge.providers} client="codex" clientLabel={label} value={provider} disabled={busy || !route} onChange={id => choose(id, model)} /></div>
    </div>
    <div className="field-row">
      <span className="fr-label">{t('默认模型')}</span>
      <div className="fr-value" aria-busy={busy || catalogBusy}><ModelPicker value={model} catalog={catalog} disabled={busy || !provider} onChange={id => choose(provider, id)} noteFor={id => catalog.length && !catalog.some(item => item.id === id) ? { label: t('不在目录'), hint: t('保留已选择的模型') } : undefined} /></div>
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
