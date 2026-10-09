import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import { CircleHelp, FileUp, RefreshCw } from 'lucide-react';
import { Popover } from '@base-ui/react/popover';
import { useBridge } from '@/bridge/store';
import { showErrorToast, showToast } from '@/lib/toast';
import type { AppliedConfigurationImport, ConfigurationImportPreview, ConfigurationImportSpec } from '../../../shared/configImport';

export function ImportConfigurations({ visible, onBack, onBusyChange, onboarding = false, onImported }: { visible: boolean; onBack: () => void; onBusyChange: (busy: boolean) => void; onboarding?: boolean; onImported?: (result: AppliedConfigurationImport) => void }): React.ReactElement {
  useLanguage();
  const { api, patch } = useBridge();
  const [preview, setPreview] = React.useState<ConfigurationImportPreview | null>(null);
  const [picked, setPicked] = React.useState<readonly string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const specs = React.useRef<readonly ConfigurationImportSpec[] | undefined>(undefined);
  const manualPath = React.useRef('');
  const generation = React.useRef(0);
  const lock = React.useRef(false);
  const container = React.useRef<HTMLDivElement | null>(null);
  const seen = React.useRef(new Set<string>());
  const scan = React.useCallback(async () => {
    if (lock.current) return;
    const current = ++generation.current;
    lock.current = true; setBusy(true); onBusyChange(true); setError('');
    try {
      if (!api.previewConfigurationImport) throw new Error(t('当前版本不支持配置导入'));
      const next = await api.previewConfigurationImport({ sources: specs.current });
      if (current !== generation.current) return;
      setPreview(next);
      const previouslySeen = seen.current;
      const eligible = next.sources.flatMap(source => source.items.filter(item => item.status === 'new' || item.status === 'paused'));
      setPicked(current => [...new Set(eligible.filter(item => current.includes(item.fingerprint) || (item.status === 'new' && !previouslySeen.has(item.fingerprint))).map(item => item.fingerprint))]);
      seen.current = new Set([...previouslySeen, ...eligible.map(item => item.fingerprint)]);
    } catch (failure) { if (current === generation.current) { setPreview(null); setPicked([]); setError(failure instanceof Error ? failure.message : String(failure)); } }
    finally { lock.current = false; setBusy(false); onBusyChange(false); }
  }, [api, onBusyChange]);
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
    if (!preview || !picked.length || !api.importConfigurations || lock.current) return;
    lock.current = true; setBusy(true); onBusyChange(true);
    try {
      const result = await api.importConfigurations({ sources: preview.sources.map(({ source, path }) => ({ source, path })), targetDigest: preview.targetDigest, fingerprints: picked });
      patch({ providers: result.providers });
      showToast(result.added.length ? t("已导入 {0} 个配置", result.added.length) : t('所选配置已存在'), 'success');
      if (onImported) onImported(result);
      else onBack();
    } catch (failure) { showErrorToast(t('导入未完成'), failure); }
    finally { lock.current = false; setBusy(false); onBusyChange(false); }
  };
  const sources = preview?.sources.filter(source => source.found) ?? [];
  const items = sources.flatMap(source => source.items.filter(item => item.status !== 'duplicate').map(item => ({ ...item, sourceName: source.name, sourcePath: source.path })));
  const problems = sources.filter(source => source.error);
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
              <dt>Magpie</dt><dd><code>~/.config/magpie/providers.json</code></dd>
              <dt>CC Switch</dt><dd><code>~/.cc-switch/cc-switch.db</code><span>{t("旧版可选 config.json")}</span></dd>
              <dt>Claude</dt><dd><code>~/.claude/settings.json</code></dd>
              <dt>ChatGPT / Codex</dt><dd><code>~/.codex/config.toml</code></dd>
              <dt>{t("旧版 XwX Deck")}</dt><dd><code>settings.json</code></dd>
            </dl>
            <p>{t("目前支持配置原文件，不支持 Magpie 加密备份或 CC Switch SQL 备份。")}</p>
          </Popover.Popup>
        </Popover.Positioner></Popover.Portal>
      </Popover.Root>
      <button type="button" className="configuration-close configuration-import-refresh" aria-label={t("重新检测")} title={t("重新检测")} aria-busy={busy} disabled={busy} onClick={() => void scan()}><RefreshCw size={16} className={busy ? 'configuration-refresh-spinner' : undefined} aria-hidden="true" /></button>
    </div>
    <div className="configuration-import-body">
      {busy && !preview && <p className="configuration-import-status" role="status">{t("正在读取本地配置…")}</p>}
      {error && <p className="provider-field-error" role="alert">{error}</p>}
      {problems.map(source => <p className="provider-field-error" role="alert" key={`${source.source}:${source.path}`}>{t(source.name)}: {source.error}</p>)}
      {preview && !items.length && !problems.length && <p className="configuration-import-status">{t("未检测到可导入配置。")}</p>}
      <div className="configuration-import-list" aria-label={t("已有配置")}>{items.map(item => {
        const selectable = item.status === 'new' || item.status === 'paused';
        const status = item.status === 'existing' ? t('已添加') : item.status === 'paused' ? t('已停用') : item.status === 'unsupported' ? t(item.reason.includes('订阅') ? '需登录' : '无法导入') : '';
        return <label className={`configuration-import-item${selectable ? '' : ' configuration-import-item-disabled'}`} key={`${item.sourcePath}:${item.fingerprint}`}>
          <span className="configuration-import-identity"><strong>{item.name}</strong><span className="configuration-import-meta">{item.baseUrl && <span className="configuration-import-url">{item.baseUrl}</span>}<span className="configuration-import-source-label">{t(item.sourceName)}</span></span></span>
          <span className="configuration-import-selection">
            {status && <span className="configuration-import-item-status" title={t(item.reason)}>{status}</span>}
            {selectable && <input type="checkbox" aria-label={t("导入 {0} {1}", item.sourceName, item.name)} checked={picked.includes(item.fingerprint)} disabled={busy} onChange={event => { const checked = event.currentTarget.checked; setPicked(current => checked ? [...new Set([...current, item.fingerprint])] : current.filter(id => id !== item.fingerprint)); }} />}
          </span>
        </label>;
      })}</div>
    </div>
    <div className="configuration-import-actions">
      {(!onboarding || picked.length > 0) && <button type="button" className="btn" disabled={busy} onClick={onBack}>{onboarding ? t('跳过') : t('取消')}</button>}
      <button type="button" className="btn primary" disabled={busy || (!onboarding && !picked.length) || (picked.length > 0 && !api.importConfigurations)} onClick={() => { if (onboarding && !picked.length) onBack(); else void apply(); }}>{busy ? t('处理中') : onboarding ? picked.length ? t('导入并继续') : t('继续') : t('导入')}</button>
    </div>
  </div>;
}
