import { RefreshButton } from '@/components/ui/refresh-button';
import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp, FileUp } from 'lucide-react';
import { Popover } from '@base-ui/react/popover';
import { useBridge } from '@/bridge/store';
import { showErrorToast, showToast } from '@/lib/toast';
import type { AppliedConfigurationImport, ConfigurationImportPreview, ConfigurationImportSpec } from '../../../shared/configImport';
import { MODEL_CLIENT_CATALOG, clientCatalogLabel, normalizeModelClients, supportsModelManagement, type ClientInstallationSnapshot, type DownloadClientId } from '../../../shared/clientDownloads';
import { useClientInstallations } from '../models/useClientInstallations';
import { ProviderIcon } from './ProviderIcon';

export function ImportConfigurations({ visible, onBack, onBusyChange, onboarding = false, onImported, actionsContainer, onDetected, clientDetection }: { visible: boolean; onBack: () => void; onBusyChange: (busy: boolean) => void; onboarding?: boolean; onImported?: (result: AppliedConfigurationImport) => void; actionsContainer?: HTMLElement | null; onDetected?: (count: number) => void; clientDetection?: { snapshot: ClientInstallationSnapshot | null; checking: boolean; error: string; refresh: () => Promise<unknown> } }): React.ReactElement {
  useLanguage();
  const { api, patch, modelClients = [] } = useBridge();
  const localDetection = useClientInstallations(visible && !clientDetection);
  const detection = clientDetection ?? localDetection;
  const [preview, setPreview] = React.useState<ConfigurationImportPreview | null>(null);
  const [picked, setPicked] = React.useState<readonly string[]>([]);
  const [pickedClients, setPickedClients] = React.useState<readonly DownloadClientId[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const specs = React.useRef<readonly ConfigurationImportSpec[] | undefined>(undefined);
  const manualPath = React.useRef('');
  const generation = React.useRef(0);
  const lock = React.useRef(false);
  const container = React.useRef<HTMLDivElement | null>(null);
  const refreshClients = detection.refresh;
  const scan = React.useCallback(async () => {
    if (lock.current) return;
    const current = ++generation.current;
    lock.current = true; setBusy(true); onBusyChange(true); setError('');
    // Discovery is read-only and independent of configuration preview. A failed
    // client check must not prevent the user from importing a valid file.
    void refreshClients?.();
    try {
      if (!api.previewConfigurationImport) throw new Error(t('当前版本不支持配置导入'));
      const next = await api.previewConfigurationImport({ sources: specs.current });
      if (current !== generation.current) return;
      setPreview(next);
      onDetected?.(next.sources.filter(source => source.found).flatMap(source => source.items.filter(item => ['new', 'paused', 'needs-login'].includes(item.status))).length);
      const eligible = next.sources.flatMap(source => source.items.filter(item => ['new', 'paused', 'needs-login'].includes(item.status)));
      setPicked(current => current.filter(id => eligible.some(item => item.fingerprint === id)));
    } catch (failure) { if (current === generation.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { lock.current = false; setBusy(false); onBusyChange(false); }
  }, [api, onBusyChange, onDetected, refreshClients]);
  React.useEffect(() => () => { generation.current++; }, []);
  React.useEffect(() => { if (visible) void scan(); }, [visible, scan]);
  React.useEffect(() => { if (visible && !onboarding) container.current?.focus(); }, [visible, onboarding]);
  const choose = async () => {
    if (!api.chooseConfigurationImportFile || lock.current) return;
    lock.current = true; setBusy(true); onBusyChange(true);
    let chosen = false;
    try {
      const path = await api.chooseConfigurationImportFile();
      if (path) { specs.current = [...(preview?.sources ?? []).filter(item => item.path !== manualPath.current && item.path !== path).map(({ source, path }) => ({ source, path })), { source: 'auto', path }]; manualPath.current = path; chosen = true; }
    } catch (failure) { showErrorToast(t('选择配置文件失败'), failure); }
    finally { lock.current = false; setBusy(false); onBusyChange(false); }
    if (chosen) await scan();
  };
  const apply = async () => {
    if (!preview || (!picked.length && !selectedClients.length) || !api.importConfigurations || lock.current) return;
    lock.current = true; setBusy(true); onBusyChange(true);
    try {
      const result = await api.importConfigurations({ sources: preview.sources.map(({ source, path }) => ({ source, path })), targetDigest: preview.targetDigest, fingerprints: picked, clients: selectedClients });
      patch({ providers: result.providers, ...(result.modelClients ? { modelClients: result.modelClients } : {}) });
      const count = result.added.length + (result.addedAccounts?.length ?? 0);
      const clientCount = result.addedClients?.length ?? 0;
      showToast(clientCount ? count ? t('已导入 {0} 个配置与账号，已添加 {1} 个客户端', count, clientCount) : t('已添加 {0} 个客户端', clientCount) : count ? t("已导入 {0} 个配置与账号", count) : t('所选配置已存在'), 'success');
      if (onImported) onImported(result);
      else onBack();
    } catch (failure) { showErrorToast(t('导入未完成'), failure); }
    finally { lock.current = false; setBusy(false); onBusyChange(false); }
  };
  const sources = preview?.sources.filter(source => source.found) ?? [];
  const items = sources.flatMap(source => source.items.filter(item => item.status !== 'duplicate').map(item => ({ ...item, sourceName: source.name, sourcePath: source.path })));
  const problems = sources.filter(source => source.error);
  const installedIds = normalizeModelClients(detection.snapshot?.available ? detection.snapshot.clients.filter(client => client.installed).map(client => client.id) : []);
  const installedClients = MODEL_CLIENT_CATALOG.filter(client => installedIds.includes(client.id) && detection.snapshot?.clients.find(row => row.id === client.id)?.modelManagement !== false);
  const managedClients = normalizeModelClients(modelClients);
  const selectedClients = pickedClients.filter(id => installedClients.some(client => client.id === id) && !managedClients.includes(id));
  const hasSelection = picked.length > 0 || selectedClients.length > 0;
  const cannotApply = !preview || !api.importConfigurations || (!!selectedClients.length && (detection.checking || !!detection.error));
  const actions = <div className="configuration-import-actions">
    {(!onboarding || hasSelection) && <button type="button" className="btn" disabled={busy} onClick={onBack}>{onboarding ? t('跳过') : t('取消')}</button>}
    <button type="button" className="btn primary" disabled={busy || (!onboarding && !hasSelection) || (hasSelection && cannotApply)} onClick={() => { if (onboarding && !hasSelection) onBack(); else void apply(); }}>{busy ? t('处理中') : onboarding ? hasSelection ? picked.length ? t('导入并继续') : t('确认并继续') : t('继续') : picked.length ? t('导入') : t('确认')}</button>
  </div>;
  return <div ref={container} className="configuration-import" tabIndex={-1} aria-busy={busy}>
    <div className="configuration-import-toolbar">
      <button type="button" className="provider-text-action" disabled={busy || !api.chooseConfigurationImportFile} onClick={() => void choose()}><FileUp size={16} aria-hidden="true" />{t("从文件导入")}</button>
      <Popover.Root>
        <Popover.Trigger type="button" className="configuration-close configuration-import-help-trigger" aria-label={t("文件说明")} title={t("文件说明")}><CircleHelp size={16} aria-hidden="true" /></Popover.Trigger>
        <Popover.Portal><Popover.Positioner className="conversation-header-menu-positioner" side="bottom" align="start" sideOffset={8} collisionPadding={12}>
          <Popover.Popup className="configuration-import-help">
            <h3>{t("从文件导入")}</h3>
            <p>{t("本机配置会自动检测，无需导出。其他目录或电脑上的配置可手动选择。")}</p>
            <dl>
              <dt>Magpie</dt><dd><code>~/.config/magpie/providers.json</code><code>~/.config/magpie/logins.json</code></dd>
              <dt>CC Switch</dt><dd><code>~/.cc-switch/cc-switch.db</code><span>{t("旧版可选 config.json")}</span></dd>
              <dt>Claude</dt><dd><code>~/.claude/settings.json</code><code>~/.claude/claude.json</code></dd>
              <dt>ChatGPT / Codex</dt><dd><code>~/.codex/config.toml</code><code>~/.codex/auth.json</code></dd>
              <dt>{t("旧版 XwX Deck")}</dt><dd><code>settings.json</code></dd>
            </dl>
            <p>{t('其他受支持客户端沿用模型配置的路径检测，包括自定义目录和 JSONC 文件。仅有环境变量或命令引用的密钥需要手动配置。')}</p>
            <p>{t('CC Switch 自定义数据目录会自动检测；Magpie 便携版可选择 data 目录中的配置原文件。')}</p>
            <p>{t("目前支持配置原文件，不支持 Magpie 加密备份或 CC Switch SQL 备份。")}</p>
            <p>{t('ChatGPT 账号需勾选后导入，复用来源登录，由原应用续期。未导入不会影响原登录；仅有账号名称的订阅仍需重新登录。')}</p>
          </Popover.Popup>
        </Popover.Positioner></Popover.Portal>
      </Popover.Root>
      <RefreshButton className="configuration-close configuration-import-refresh" label={t("重新检测")} busy={busy || !!clientDetection?.checking} onClick={() => void scan()} />
    </div>
    <div className="configuration-import-body">
      <section className="configuration-import-clients" aria-label={t('本机客户端')} aria-busy={detection.checking}>
        <h2>{t('本机客户端')}</h2>
        {!!installedClients.length && <>
          <ul>{installedClients.map(client => {
            const managed = managedClients.includes(client.id);
            const supported = supportsModelManagement(client.id);
            const selected = managed || selectedClients.includes(client.id);
            return <li key={client.id}><button type="button" className="configuration-choice configuration-import-client" data-detected-client={client.id} data-unconfigured={!selected || undefined} aria-pressed={selected} disabled={busy || managed || !supported || (!selected && (detection.checking || !!detection.error))} onClick={() => setPickedClients(current => current.includes(client.id) ? current.filter(id => id !== client.id) : [...current, client.id])}>
              <ProviderIcon kind={client.icon} /><span>{clientCatalogLabel(client)}</span>
            </button></li>;
          })}</ul>
        </>}
        {detection.error ? <p className="provider-field-error" role="alert">{t('客户端检测失败，可继续导入配置')}<span>{detection.error}</span></p>
          : detection.checking ? <p className="configuration-import-status" role="status">{t('正在检测客户端…')}</p>
          : detection.snapshot?.available === false ? <p className="configuration-import-status">{t('当前环境暂不支持客户端检测')}</p>
          : detection.snapshot && !installedClients.length ? <p className="configuration-import-status">{t('未检测到已安装客户端')}</p> : null}
      </section>
      {busy && !preview && <p className="configuration-import-status" role="status">{t("正在读取本地配置…")}</p>}
      {error && <p className="provider-field-error" role="alert">{error}</p>}
      {problems.map(source => <p className="provider-field-error" role="alert" key={`${source.source}:${source.path}`}>{t(source.name)}: {source.error}</p>)}
      {preview && !items.length && !problems.length && <p className="configuration-import-status">{t("未检测到可导入配置")}</p>}
      <div className="configuration-import-list" aria-label={t("已有配置")}>{items.map(item => {
        const selectable = ['new', 'paused', 'needs-login'].includes(item.status);
        const status = item.status === 'paused' ? t('已停用') : item.status === 'needs-login' ? t('需登录') : item.status === 'unsupported' ? t(item.reason.includes('登录') ? '需登录' : '无法导入') : '';
        return <label className={`configuration-import-item${selectable ? '' : ' configuration-import-item-disabled'}`} key={`${item.sourcePath}:${item.fingerprint}`}>
          <span className="configuration-import-identity"><strong>{item.name}</strong><span className="configuration-import-meta">{item.baseUrl && <span className="configuration-import-url">{item.baseUrl}</span>}<span className="configuration-import-source-label">{t(item.sourceName)}</span>{item.accountKind && <span>{t(item.accountKind === 'official' ? '官方账号登录' : 'API 授权')}</span>}</span></span>
          <span className="configuration-import-selection">
            {status && <span className="configuration-import-item-status" title={t(item.reason)}>{status}</span>}
            {selectable && <input type="checkbox" aria-label={t("导入 {0} {1}", item.sourceName, item.name)} checked={picked.includes(item.fingerprint)} disabled={busy} onChange={event => { const checked = event.currentTarget.checked; setPicked(current => checked ? [...new Set([...current, item.fingerprint])] : current.filter(id => id !== item.fingerprint)); }} />}
          </span>
        </label>;
      })}</div>
    </div>
    {actionsContainer ? createPortal(actions, actionsContainer) : actions}
  </div>;
}
