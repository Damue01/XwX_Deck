import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { ArrowLeft, FileUp, Plug, Plus, RefreshCw, X } from 'lucide-react';
import { useBridge } from '@/bridge/store';
import { groupSubscriptionConnections, subscriptionPlatformForAccount, subscriptionServiceIcon, subscriptionServiceNames } from '@/lib/subscriptionServices';
import { showErrorToast, showToast } from '@/lib/toast';
import { OFFICIAL_PROVIDERS, LISTED_OFFICIAL_PROVIDERS, type OfficialProviderId } from '../../../shared/officialProviders';
import { ProviderIcon, providerIconKind } from './ProviderIcon';
import type { ProviderConnection } from '../../../shared/providers';
import { SubscriptionAccountsPanel } from './SubscriptionAccountsPanel';
import { ImportConfigurations } from './ImportConfigurations';
import { ClientDownloads } from './ProviderSetupShortcuts';
import { useClientInstallations } from '../models/useClientInstallations';
import { CLIENT_DOWNLOADS, MODEL_CLIENT_CATALOG, clientCatalogLabel, MODEL_CLIENT_ADDED_EVENT, canonicalModelClient, supportsManagedModels, type DownloadClientId } from '../../../shared/clientDownloads';

type Service = OfficialProviderId | 'custom';
const TABS = ['services', 'accounts', 'saved', 'clients'] as const;
export type ConfigurationTab = typeof TABS[number];

export function AddConfigurationDialog({ open, busy: providerBusy, selected, onOpenChange, onSelect, onBack, editor, finalFocus, initialTab = 'services', initialSubscriptionPlatform = null, clientsOnly = false, manageClients = false, onOpenClient, savedConnections = [], selectedConnectionId, onEditConnection, managementOpen = false, onStartAdding, activeTab, onTabChange, onImported, editorNavigation, draftName, connectionNames = {}, subscriptionEditor }: {
  subscriptionEditor?: React.ReactNode;
  managementOpen?: boolean;
  onStartAdding?: () => void;
  activeTab?: ConfigurationTab;
  onTabChange?: (tab: ConfigurationTab) => void;
  onImported?: (providers: import('../../../shared/providers').ProviderSnapshot, added: readonly string[]) => void;
  draftName?: string;
  connectionNames?: Readonly<Record<string, string>>;
  editorNavigation?: React.ReactNode;
  savedConnections?: readonly ProviderConnection[];
  selectedConnectionId?: string;
  onEditConnection?: (provider: ProviderConnection) => void;
  clientsOnly?: boolean;
  manageClients?: boolean;
  onOpenClient?: (client: DownloadClientId) => void;
  initialTab?: ConfigurationTab;
  initialSubscriptionPlatform?: 'chatgpt' | 'grok' | 'copilot' | 'claude' | 'cursor' | null;
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
  const dialogActions = React.useRef<Dialog.Root.Actions | null>(null);
  const previouslyOpen = React.useRef(open);
  React.useEffect(() => {
    // Release the modal on close even when WebKit delays animation callbacks.
    if (previouslyOpen.current && !open) dialogActions.current?.unmount();
    previouslyOpen.current = open;
  }, [open]);
  const { api, modelClients, patch } = useBridge();
  const [importOpen, setImportOpen] = React.useState(false);
  const [importBusy, setImportBusy] = React.useState(false);
  const busy = providerBusy || importBusy;
  const [addingClient, setAddingClient] = React.useState(false);
  const clientOperation = React.useRef(false);
  const [catalogTab, setCatalogTab] = React.useState<ConfigurationTab>('services');
  const tab = activeTab ?? catalogTab;
  const setTab = (next: ConfigurationTab) => { if (onTabChange) onTabChange(next); else setCatalogTab(next); };
  const [client, setClient] = React.useState<DownloadClientId | null>(null);
  const installation = useClientInstallations(open && (clientsOnly || tab === 'clients'));
  const clientAdded = client !== null && modelClients.includes(canonicalModelClient(client));
  const clientInstalled = installation.snapshot?.clients.some(item => item.id === (client && (canonicalModelClient(client))) && item.installed) === true;
  const wasOpen = React.useRef(false);
  const initialTabButton = React.useRef<HTMLButtonElement | null>(null);
  const serviceList = React.useRef<HTMLDivElement | null>(null);
  const detailPane = React.useRef<HTMLDivElement | null>(null);
  const returnScroll = React.useRef({ list: 0, detail: 0 });
  const wasManaging = React.useRef(false);
  const startAdding = () => {
    returnScroll.current = { list: serviceList.current?.scrollTop ?? 0, detail: detailPane.current?.scrollTop ?? 0 };
    onStartAdding?.();
  };
  React.useLayoutEffect(() => {
    if (managementOpen && !wasManaging.current) {
      if (serviceList.current) serviceList.current.scrollTop = returnScroll.current.list;
      if (detailPane.current) detailPane.current.scrollTop = returnScroll.current.detail;
    }
    wasManaging.current = managementOpen;
  }, [managementOpen]);
  const importEntry = React.useRef<HTMLButtonElement | null>(null);
  const closeImport = () => {
    setImportOpen(false);
    // The dialog restores focus on the first frame after removing the task.
    requestAnimationFrame(() => requestAnimationFrame(() => importEntry.current?.focus()));
  };
  const clientList = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (open && selected !== null && (tab === 'services' || tab === 'saved')) serviceList.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, selected, selectedConnectionId, tab]);
  React.useEffect(() => {
    if (open && client !== null) clientList.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, client]);
  React.useEffect(() => {
    if (open && !wasOpen.current) { setCatalogTab(initialTab); setClient(null); setImportOpen(false); }
    wasOpen.current = open;
  }, [open, initialTab]);
  const preset = OFFICIAL_PROVIDERS.find(item => item.id === selected);
  const saved = savedConnections.find(item => item.id === selectedConnectionId);
  const maintenance = managementOpen && tab === 'saved';
  const savedList = maintenance ? groupSubscriptionConnections(savedConnections, selectedConnectionId) : [];
  const savedChoices = savedList.map(item => <button key={item.id} type="button" className="configuration-choice" data-saved-provider={item.id} aria-pressed={selectedConnectionId === item.id} disabled={busy} onClick={() => onEditConnection?.(item)}><ProviderIcon kind={item.subscriptionAccountId ? subscriptionServiceIcon(item.subscriptionAccountId) : providerIconKind(item.baseUrl)} /><span>{item.subscriptionAccountId ? t(subscriptionServiceNames[subscriptionPlatformForAccount(item.subscriptionAccountId)]) : connectionNames[item.id]?.trim() || item.displayName}</span></button>);
  const services = <>
    {LISTED_OFFICIAL_PROVIDERS.map(item => <button key={item.id} type="button" className="configuration-choice" data-service={item.id} aria-pressed={selected === item.id} disabled={busy} onClick={() => onSelect(item.id)}>
      <ProviderIcon kind={item.id} /><span>{t(item.label)}</span>
    </button>)}
    <button type="button" className="configuration-choice" data-service="custom" aria-pressed={selected === 'custom'} disabled={busy} onClick={() => onSelect('custom')}><Plug className="provider-brand-icon" aria-hidden="true" /><span>{t("自定义")}</span></button>
    {api.previewConfigurationImport && <button ref={importEntry} type="button" className="configuration-choice configuration-import-entry" disabled={busy} onClick={() => setImportOpen(true)}><FileUp className="provider-brand-icon" aria-hidden="true" /><span>{t('导入已有配置')}</span></button>}
  </>;
  const clientInfo = CLIENT_DOWNLOADS.find(item => item.id === client);
  const manageable = (id: DownloadClientId) => supportsManagedModels(id) || modelClients.includes(canonicalModelClient(id));
  const clients = MODEL_CLIENT_CATALOG.map(item => {
    const uninstalled = manageClients && installation.snapshot?.available === true
      && installation.snapshot.clients.some(entry => entry.id === (canonicalModelClient(item.id)) && !entry.installed);
    return <button key={item.id} type="button" className="configuration-choice" data-client-download={item.id} data-uninstalled={uninstalled || undefined} aria-pressed={client === item.id} disabled={addingClient} onClick={() => setClient(item.id)}>
      <ProviderIcon kind={item.icon} /><span>{clientCatalogLabel(item)}</span>
    </button>;
  });
  const importing = importOpen && (tab === 'services' || tab === 'saved') && !clientsOnly;
  const detail = tab === 'services' || tab === 'saved' ? selected !== null || maintenance : client !== null;
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
  return <Dialog.Root open={open} actionsRef={dialogActions} onOpenChange={value => { if (!busy && !clientOperation.current) onOpenChange(value); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="setup-card-backdrop" />
      <Dialog.Popup className={`configuration-dialog${maintenance ? ' configuration-management-dialog' : ''}${manageClients && (clientsOnly || tab === 'clients') ? ' client-manager-dialog' : ''}`} id="add-configuration-dialog" finalFocus={finalFocus} initialFocus={initialTabButton}>
        <header className={`configuration-header${clientsOnly || importing ? '' : ' configuration-header-tabs'}`}>
          <Dialog.Title className={clientsOnly || importing ? undefined : 'sr-only'}>{importing ? t('导入已有配置') : maintenance ? t('我的配置') : clientsOnly ? manageClients ? t('管理客户端') : t('添加客户端') : t('添加配置')}</Dialog.Title>
          <Dialog.Description className="sr-only">{importing ? t('选择要导入的配置') : clientsOnly ? t('选择客户端、打开官方下载页面或管理模型页的客户端标签。移除保留模型配置。') : t('添加 API 服务、订阅账号或下载客户端。')}</Dialog.Description>
          {!clientsOnly && !importing && <div className="configuration-tabs" role="tablist" aria-label={t("添加配置类型")} onKeyDown={event => {
            if (busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? TABS[0] : event.key === 'End' ? TABS[TABS.length - 1] : TABS[(TABS.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
            setTab(next);
            document.getElementById(`configuration-${next}-tab`)?.focus();
          }}>
            <button ref={tab === 'services' ? initialTabButton : undefined} type="button" role="tab" tabIndex={tab === 'services' ? 0 : -1} id="configuration-services-tab" aria-controls="configuration-services" aria-selected={tab === 'services'} onClick={() => setTab('services')} disabled={busy}>{t("API 服务")}</button>
            <button ref={tab === 'accounts' ? initialTabButton : undefined} type="button" role="tab" tabIndex={tab === 'accounts' ? 0 : -1} id="configuration-accounts-tab" aria-controls="configuration-accounts" aria-selected={tab === 'accounts'} onClick={() => setTab('accounts')} disabled={busy}>{t("订阅账号")}</button>
            <button ref={tab === 'saved' ? initialTabButton : undefined} type="button" role="tab" tabIndex={tab === 'saved' ? 0 : -1} id="configuration-saved-tab" aria-controls="configuration-saved" aria-selected={tab === 'saved'} onClick={() => setTab('saved')} disabled={busy}>{t('我的配置')}</button>
            <button ref={tab === 'clients' ? initialTabButton : undefined} type="button" role="tab" tabIndex={tab === 'clients' ? 0 : -1} id="configuration-clients-tab" aria-controls="configuration-clients" aria-selected={tab === 'clients'} onClick={() => setTab('clients')} disabled={busy}>{t("客户端管理")}</button>
          </div>}
          <div className="configuration-header-actions">
            {manageClients && (clientsOnly || tab === 'clients') && <button type="button" className="configuration-close" aria-label={installation.checking ? t('正在检测客户端') : t('重新检测')} title={installation.checking ? t('正在检测客户端') : t('重新检测')} aria-busy={installation.checking} disabled={installation.checking || addingClient} onClick={() => void refreshClients()}><RefreshCw className={installation.checking ? 'configuration-refresh-spinner' : undefined} size={15} aria-hidden="true" /></button>}
            <Dialog.Close ref={clientsOnly || importing ? initialTabButton : undefined} className="configuration-close" aria-label={importing ? t('关闭导入配置') : clientsOnly ? manageClients ? t('关闭管理客户端') : t('关闭添加客户端') : t('关闭添加配置')} disabled={busy || addingClient}><X size={17} aria-hidden="true" /></Dialog.Close>
          </div>
        </header>

        <div id={maintenance ? 'configuration-saved' : 'configuration-services'} role={importing ? undefined : "tabpanel"} aria-labelledby={importing ? undefined : maintenance ? "configuration-saved-tab" : "configuration-services-tab"} hidden={clientsOnly || (tab !== 'services' && tab !== 'saved')} >
          {importOpen ? <ImportConfigurations visible={open && (tab === 'services' || tab === 'saved')} onBack={closeImport} onBusyChange={setImportBusy} onImported={result => { setImportOpen(false); onImported?.(result.providers, result.added); }} /> : <div className={`configuration-content${detail && (tab === 'services' || tab === 'saved') ? ' has-detail' : ''}${maintenance ? ' configuration-maintenance' : ''}`}>
            <div className="configuration-directory">
              {selected !== null && !maintenance && <button type="button" className="provider-text-action configuration-back" onClick={onBack} disabled={busy}><ArrowLeft size={15} aria-hidden="true" />{t("全部服务商")}</button>}
              <div ref={serviceList} className={selected === null && !maintenance ? 'configuration-grid' : 'configuration-list'} aria-label={t(maintenance ? '已保存的配置' : '服务商')}>
                {maintenance ? <>{savedChoices}{selected !== null && !selectedConnectionId && <button type="button" className="configuration-choice" aria-pressed="true" disabled={busy} onClick={() => onSelect(selected)}><ProviderIcon kind={selected === 'custom' ? undefined : selected} /><span>{draftName?.trim() || t('名称')}</span></button>}</> : services}
              </div>
              {maintenance ? <div className="configuration-management-actions">
                <button type="button" className="configuration-choice" disabled={busy} onClick={startAdding}><Plus aria-hidden="true" /><span>{t('新增配置')}</span></button>
                {api.previewConfigurationImport && <button ref={importEntry} type="button" className="configuration-choice" disabled={busy} onClick={() => setImportOpen(true)}><FileUp aria-hidden="true" /><span>{t('导入配置')}</span></button>}
              </div> : null}
            </div>
            {subscriptionEditor ? subscriptionEditor : selected !== null && <div ref={detailPane} className="configuration-detail">
              <div className="configuration-detail-heading">
                <h3><ProviderIcon kind={saved ? providerIconKind(saved.baseUrl) ?? preset?.id : preset?.id} />{draftName?.trim() || saved?.displayName || (preset ? t(preset.label) : t('自定义'))}</h3>
              </div>
              {editorNavigation}
              {editor}
            </div>}
            {maintenance && selected === null && !subscriptionEditor && <div className="configuration-empty">{t("暂无已保存的配置")}</div>}
          </div>}
        </div>
        <div id="configuration-accounts" role="tabpanel" aria-labelledby="configuration-accounts-tab" hidden={clientsOnly || tab !== 'accounts'}><SubscriptionAccountsPanel initialPlatform={initialSubscriptionPlatform} open={open} visible={open && !clientsOnly && tab === 'accounts'} /></div>
        <div id="configuration-clients" role={clientsOnly ? undefined : 'tabpanel'} aria-label={clientsOnly ? t('客户端') : undefined} aria-labelledby={clientsOnly ? undefined : 'configuration-clients-tab'} hidden={!clientsOnly && tab !== 'clients'}>
          <div className={`configuration-content${client !== null ? ' has-detail' : ''}`}>
            <div className="configuration-directory">
              {client !== null && <button type="button" className="provider-text-action configuration-back" disabled={addingClient} onClick={() => setClient(null)}><ArrowLeft size={15} aria-hidden="true" />{t("全部客户端")}</button>}
              {client === null && installation.error && <p className="configuration-client-error" role="status">{installation.error}</p>}
              <div ref={clientList} className={client === null ? 'configuration-grid' : 'configuration-list'} aria-label={t("客户端")}>{clients}</div>
            </div>
            {client !== null && <div className="configuration-detail">
              <div className="configuration-detail-heading"><h3><ProviderIcon kind={clientInfo?.icon} />{clientInfo && clientCatalogLabel(clientInfo)}</h3></div>
              <ClientDownloads key={client} client={client} />
              {manageable(client) && <div className="configuration-client-actions">
                <button type="button" className="btn primary" disabled={addingClient || (!clientAdded && (!api.addModelClient || !clientInstalled || installation.checking))} onClick={() => {
                  if (clientOperation.current) return;
                  if (clientAdded) {
                    onOpenClient?.(canonicalModelClient(client));
                    onOpenChange(false);
                    window.dispatchEvent(new CustomEvent(MODEL_CLIENT_ADDED_EVENT, { detail: client }));
                  } else void changeClient(false);
                }}>{clientAdded ? t('打开模型页') : t('添加到模型页')}</button>
                {manageClients && clientAdded && <button type="button" className="txt-action" aria-label={t("移除 {0}", clientInfo?.label ?? client)} disabled={addingClient || !api.removeModelClient} onClick={() => void changeClient(true)}>{t("移除")}</button>}
                {!manageClients && !clientAdded && <button type="button" className="txt-action" disabled={installation.checking || addingClient} onClick={() => void refreshClients()}>{installation.checking ? t('正在检测…') : t('重新检测')}</button>}
              </div>}
              {installation.error && <p className="configuration-client-error" role="status">{installation.error}</p>}
            </div>}
          </div>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
