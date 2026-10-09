import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { ArrowLeft, ArrowUpRight, Plug, RefreshCw, X } from 'lucide-react';
import { useBridge } from '@/bridge/store';
import { showErrorToast, showToast } from '@/lib/toast';
import { OFFICIAL_PROVIDERS, LISTED_OFFICIAL_PROVIDERS, type OfficialProviderId } from '../../../shared/officialProviders';
import { ProviderIcon } from './ProviderIcon';
import { SubscriptionAccountsPanel } from './SubscriptionAccountsPanel';
import { ImportConfigurations } from './ImportConfigurations';
import { ClientDownloads } from './ProviderSetupShortcuts';
import { useClientInstallations } from '../models/useClientInstallations';
import { CLIENT_DOWNLOADS, MODEL_CLIENT_CATALOG, clientDownloadLabel, MODEL_CLIENT_ADDED_EVENT, modelClientRoute, type DownloadClientId } from '../../../shared/clientDownloads';

type Service = OfficialProviderId | 'custom';
const TABS = ['services', 'accounts', 'clients'] as const;
export type ConfigurationTab = typeof TABS[number];

export function AddConfigurationDialog({ open, busy: providerBusy, selected, onOpenChange, onSelect, onBack, editor, finalFocus, initialTab = 'services', initialSubscriptionPlatform = 'chatgpt', clientsOnly = false, manageClients = false, onOpenClient }: {
  clientsOnly?: boolean;
  manageClients?: boolean;
  onOpenClient?: (client: DownloadClientId) => void;
  initialTab?: ConfigurationTab;
  initialSubscriptionPlatform?: 'chatgpt' | 'grok' | 'copilot' | 'claude' | 'cursor';
  open: boolean;
  busy: boolean;
  selected: Service | null;
  onOpenChange: (open: boolean) => void;
  onSelect: (id: Service) => void;
  onBack: () => void;
  editor: React.ReactNode;
  finalFocus: React.RefObject<HTMLButtonElement | null>;
}): React.ReactElement {
  useLanguage();
  const { api, modelClients, patch } = useBridge();
  const [importOpen, setImportOpen] = React.useState(false);
  const [importBusy, setImportBusy] = React.useState(false);
  const busy = providerBusy || importBusy;
  const [addingClient, setAddingClient] = React.useState(false);
  const clientOperation = React.useRef(false);
  const [tab, setTab] = React.useState<ConfigurationTab>('services');
  const [client, setClient] = React.useState<DownloadClientId | null>(null);
  const installation = useClientInstallations(open && (clientsOnly || tab === 'clients'));
  const clientAdded = client !== null && modelClients.includes(modelClientRoute(client) ?? client);
  const clientInstalled = installation.snapshot?.clients.some(item => item.id === (client && (modelClientRoute(client) ?? client)) && item.installed) === true;
  const wasOpen = React.useRef(false);
  const initialTabButton = React.useRef<HTMLButtonElement | null>(null);
  const serviceList = React.useRef<HTMLDivElement | null>(null);
  const clientList = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (open && selected !== null && tab === 'services') serviceList.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, selected, tab]);
  React.useEffect(() => {
    if (open && client !== null) clientList.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, client]);
  React.useEffect(() => {
    if (open && !wasOpen.current) { setTab(initialTab); setClient(null); setImportOpen(false); }
    wasOpen.current = open;
  }, [open, initialTab]);
  const preset = OFFICIAL_PROVIDERS.find(item => item.id === selected);
  const services = <>
    {LISTED_OFFICIAL_PROVIDERS.map(item => <button key={item.id} type="button" className="configuration-choice" data-service={item.id} aria-pressed={selected === item.id} disabled={busy} onClick={() => onSelect(item.id)}>
      <ProviderIcon kind={item.id} /><span>{t(item.label)}</span>
    </button>)}
    <button type="button" className="configuration-choice" data-service="custom" aria-pressed={selected === 'custom'} disabled={busy} onClick={() => onSelect('custom')}><Plug className="provider-brand-icon" aria-hidden="true" /><span>{t("自定义")}</span></button>
  </>;
  const clientInfo = CLIENT_DOWNLOADS.find(item => item.id === client);
  const clients = (manageClients ? MODEL_CLIENT_CATALOG : CLIENT_DOWNLOADS).map(item => {
    const uninstalled = manageClients && installation.snapshot?.available === true
      && installation.snapshot.clients.some(entry => entry.id === (modelClientRoute(item.id) ?? item.id) && !entry.installed);
    return <button key={item.id} type="button" className="configuration-choice" data-client-download={item.id} data-uninstalled={uninstalled || undefined} aria-pressed={client === item.id} disabled={addingClient} onClick={() => setClient(item.id)}>
      <ProviderIcon kind={item.icon} /><span>{clientDownloadLabel(item)}</span>
    </button>;
  });
  const detail = tab === 'services' ? selected !== null : client !== null;
  async function changeClient(remove: boolean) {
    if (client === null || clientOperation.current) return;
    const action = remove ? api.removeModelClient : api.addModelClient;
    if (!action) return;
    clientOperation.current = true;
    setAddingClient(true);
    try {
      const modelClients = await action(client);
      patch({ modelClients });
      if (!remove) {
        onOpenChange(false);
        window.dispatchEvent(new CustomEvent(MODEL_CLIENT_ADDED_EVENT, { detail: client }));
      }
    } catch (error) { showErrorToast(remove ? t('移除客户端失败') : t('添加客户端失败'), error); }
    finally { clientOperation.current = false; setAddingClient(false); }
  }
  async function refreshClients() {
    const result = await installation.refresh();
    if (result) showToast(result.available ? t('客户端检测完成') : t('当前无法检测客户端'), result.available ? 'success' : 'warning');
  }
  return <Dialog.Root open={open} onOpenChange={value => { if (!busy && !clientOperation.current) onOpenChange(value); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="setup-card-backdrop" />
      <Dialog.Popup className={`configuration-dialog${manageClients ? ' client-manager-dialog' : ''}`} id="add-configuration-dialog" finalFocus={finalFocus} initialFocus={initialTabButton}>
        <header className={`configuration-header${clientsOnly ? '' : ' configuration-header-tabs'}`}>
          <Dialog.Title className={clientsOnly ? undefined : 'sr-only'}>{clientsOnly ? manageClients ? t('管理客户端') : t('添加客户端') : t('添加配置')}</Dialog.Title>
          <Dialog.Description className="sr-only">{clientsOnly ? t('选择客户端、打开官方下载页面或管理模型页的客户端标签。移除保留模型配置。') : t('添加 API 服务、订阅账号或下载客户端。')}</Dialog.Description>
          {!clientsOnly && <div className="configuration-tabs" role="tablist" aria-label={t("添加配置类型")} onKeyDown={event => {
            if (busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? TABS[0] : event.key === 'End' ? TABS[2] : TABS[(TABS.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : 2)) % TABS.length];
            setTab(next);
            document.getElementById(`configuration-${next}-tab`)?.focus();
          }}>
            <button ref={initialTab === 'services' ? initialTabButton : undefined} type="button" role="tab" tabIndex={tab === 'services' ? 0 : -1} id="configuration-services-tab" aria-controls="configuration-services" aria-selected={tab === 'services'} onClick={() => setTab('services')} disabled={busy}>{t("API 服务")}</button>
            <button ref={initialTab === 'accounts' ? initialTabButton : undefined} type="button" role="tab" tabIndex={tab === 'accounts' ? 0 : -1} id="configuration-accounts-tab" aria-controls="configuration-accounts" aria-selected={tab === 'accounts'} onClick={() => setTab('accounts')} disabled={busy}>{t("订阅账号")}</button>
            <button ref={initialTab === 'clients' ? initialTabButton : undefined} type="button" role="tab" tabIndex={tab === 'clients' ? 0 : -1} id="configuration-clients-tab" aria-controls="configuration-clients" aria-selected={tab === 'clients'} onClick={() => setTab('clients')} disabled={busy}>{t("客户端下载")}</button>
          </div>}
          <div className="configuration-header-actions">
            {manageClients && <button type="button" className="configuration-close" aria-label={installation.checking ? t('正在检测客户端') : t('重新检测')} title={installation.checking ? t('正在检测客户端') : t('重新检测')} aria-busy={installation.checking} disabled={installation.checking || addingClient} onClick={() => void refreshClients()}><RefreshCw className={installation.checking ? 'configuration-refresh-spinner' : undefined} size={15} aria-hidden="true" /></button>}
            <Dialog.Close ref={clientsOnly ? initialTabButton : undefined} className="configuration-close" aria-label={clientsOnly ? manageClients ? t('关闭管理客户端') : t('关闭添加客户端') : t('关闭添加配置')} disabled={busy || addingClient}><X size={17} aria-hidden="true" /></Dialog.Close>
          </div>
        </header>
        <div id="configuration-services" role="tabpanel" aria-labelledby="configuration-services-tab" hidden={clientsOnly || tab !== 'services'}>
          {importOpen ? <ImportConfigurations visible={open && tab === 'services'} onBack={() => setImportOpen(false)} onBusyChange={setImportBusy} /> : <div className={`configuration-content${detail && tab === 'services' ? ' has-detail' : ''}`}>
            <div className="configuration-directory">
              {selected !== null && <button type="button" className="provider-text-action configuration-back" onClick={onBack} disabled={busy}><ArrowLeft size={15} aria-hidden="true" />{t("全部服务商")}</button>}
              <div ref={serviceList} className={selected === null ? 'configuration-grid' : 'configuration-list'} aria-label={t("服务商")}>{services}</div>
              {api.previewConfigurationImport && <button type="button" className="provider-text-action configuration-import-entry" disabled={busy} onClick={() => setImportOpen(true)}>{t("导入已有配置")}</button>}
            </div>
            {selected !== null && <div className="configuration-detail">
              <div className="configuration-detail-heading">
                <h3>{preset ? <ProviderIcon kind={preset.id} /> : <Plug size={20} aria-hidden="true" />}{preset?.label ?? t('自定义')}</h3>
                {preset && <a className="setup-card-link" href={api.setupWebsites[preset.id]} target="_blank" rel="noopener noreferrer" onClick={event => {
                  event.preventDefault();
                  void api.openSetupWebsite(preset.id).catch(error => showErrorToast(t('打开密钥管理页面失败'), error));
                }}>{'local' in preset ? t('打开官网') : t('获取 Key')}<ArrowUpRight aria-hidden="true" /></a>}
              </div>
              {editor}
            </div>}
          </div>}
        </div>
        <div id="configuration-accounts" role="tabpanel" aria-labelledby="configuration-accounts-tab" hidden={clientsOnly || tab !== 'accounts'}><SubscriptionAccountsPanel key={initialSubscriptionPlatform} initialPlatform={initialSubscriptionPlatform} visible={open && !clientsOnly && tab === 'accounts'} /></div>
        <div id="configuration-clients" role={clientsOnly ? undefined : 'tabpanel'} aria-label={clientsOnly ? t('客户端') : undefined} aria-labelledby={clientsOnly ? undefined : 'configuration-clients-tab'} hidden={!clientsOnly && tab !== 'clients'}>
          <div className={`configuration-content${client !== null ? ' has-detail' : ''}`}>
            <div className="configuration-directory">
              {client !== null && <button type="button" className="provider-text-action configuration-back" disabled={addingClient} onClick={() => setClient(null)}><ArrowLeft size={15} aria-hidden="true" />{t("全部客户端")}</button>}
              {client === null && installation.error && <p className="configuration-client-error" role="status">{installation.error}</p>}
              <div ref={clientList} className={client === null ? 'configuration-grid' : 'configuration-list'} aria-label={t("客户端")}>{clients}</div>
            </div>
            {client !== null && <div className="configuration-detail">
              <div className="configuration-detail-heading"><h3><ProviderIcon kind={clientInfo?.icon} />{clientInfo && clientDownloadLabel(clientInfo)}</h3></div>
              <ClientDownloads key={client} client={client} />
              <div className="configuration-client-actions">
                <button type="button" className="btn primary" disabled={addingClient || (!clientAdded && (!api.addModelClient || !clientInstalled || installation.checking))} onClick={() => {
                  if (clientOperation.current) return;
                  if (clientAdded) {
                    onOpenClient?.(modelClientRoute(client) ?? client);
                    onOpenChange(false);
                    window.dispatchEvent(new CustomEvent(MODEL_CLIENT_ADDED_EVENT, { detail: client }));
                  } else void changeClient(false);
                }}>{clientAdded ? t('打开模型页') : t('添加到模型页')}</button>
                {manageClients && clientAdded && <button type="button" className="txt-action" aria-label={t("移除 {0}", clientInfo?.label ?? client)} disabled={addingClient || !api.removeModelClient} onClick={() => void changeClient(true)}>{t("移除")}</button>}
                {!manageClients && !clientAdded && <button type="button" className="txt-action" disabled={installation.checking || addingClient} onClick={() => void refreshClients()}>{installation.checking ? t('正在检测…') : t('重新检测')}</button>}
              </div>
              {installation.error && <p className="configuration-client-error" role="status">{installation.error}</p>}
            </div>}
          </div>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
