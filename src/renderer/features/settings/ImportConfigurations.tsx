import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { useBridge } from '@/bridge/store';
import { showErrorToast, showToast } from '@/lib/toast';
import type { ConfigurationImportPreview, ConfigurationImportSpec, ConfigurationImportSource } from '../../../shared/configImport';

export function ImportConfigurations({ visible, onBack, onBusyChange, onboarding = false }: { visible: boolean; onBack: () => void; onBusyChange: (busy: boolean) => void; onboarding?: boolean }): React.ReactElement {
  useLanguage();
  const { api, patch } = useBridge();
  const [preview, setPreview] = React.useState<ConfigurationImportPreview | null>(null);
  const [picked, setPicked] = React.useState<readonly string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const specs = React.useRef<readonly ConfigurationImportSpec[] | undefined>(undefined);
  const generation = React.useRef(0);
  const lock = React.useRef(false);
  const scan = React.useCallback(async () => {
    if (lock.current) return;
    const current = ++generation.current;
    lock.current = true; setBusy(true); onBusyChange(true); setError('');
    try {
      if (!api.previewConfigurationImport) throw new Error(t('当前版本不支持配置导入'));
      const next = await api.previewConfigurationImport({ sources: specs.current });
      if (current !== generation.current) return;
      setPreview(next);
      setPicked([...new Set(next.sources.flatMap(source => source.items.filter(item => item.status === 'new').map(item => item.fingerprint)))]);
    } catch (failure) { if (current === generation.current) { setPreview(null); setPicked([]); setError(failure instanceof Error ? failure.message : String(failure)); } }
    finally { lock.current = false; setBusy(false); onBusyChange(false); }
  }, [api, onBusyChange]);
  React.useEffect(() => () => { generation.current++; }, []);
  React.useEffect(() => { if (visible) void scan(); }, [visible, scan]);
  const choose = async (source: ConfigurationImportSource) => {
    if (!api.chooseConfigurationImportFile || lock.current) return;
    lock.current = true; setBusy(true); onBusyChange(true);
    let chosen = false;
    try {
      const path = await api.chooseConfigurationImportFile();
      if (path) { specs.current = [...(preview?.sources ?? []).filter(item => item.source !== source).map(({ source, path }) => ({ source, path })), { source, path }]; chosen = true; }
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
      onBack();
    } catch (failure) { showErrorToast(t('导入未完成'), failure); }
    finally { lock.current = false; setBusy(false); onBusyChange(false); }
  };
  const shownSources = preview?.sources.filter(source => !onboarding || source.found) ?? [];
  const otherSources = preview?.sources.filter(source => !source.found) ?? [];
  return <div className="configuration-import" aria-busy={busy}>
    <div className="configuration-import-body">
    <div className="configuration-import-heading">{onboarding ? <p className="configuration-import-status">{t("选择要带入 Deck 的配置，原文件保留。")}</p> : <button type="button" className="provider-text-action" disabled={busy} onClick={onBack}><ArrowLeft size={15} aria-hidden="true" />{t("返回服务商")}</button>}<button type="button" className="provider-text-action" aria-busy={busy} disabled={busy} onClick={() => void scan()}><RefreshCw size={14} className={busy ? 'animate-spin' : undefined} aria-hidden="true" />{t("重新检测")}</button></div>
    {!onboarding && <h3>{t("导入已有配置")}</h3>}
    {busy && !preview && <p className="configuration-import-status" role="status">{t("正在读取本地配置…")}</p>}
    {error && <p className="provider-field-error" role="alert">{error}</p>}
    {onboarding && preview && !shownSources.length && <p className="configuration-import-status">{t("未检测到可导入配置。")}</p>}
    {shownSources.map(source => <section className="configuration-import-source" key={source.source}>
      <div className="configuration-import-heading"><strong>{source.name}</strong><button type="button" className="provider-text-action" aria-label={t("选择 {0} 配置文件", source.name)} disabled={busy || !api.chooseConfigurationImportFile} onClick={() => void choose(source.source)}>{t("选择文件")}</button></div>
      {!source.found && <p className="configuration-import-status">{t("未检测到配置")}</p>}
      {source.error && <p className="provider-field-error" role="alert">{source.error}</p>}
      {source.found && !source.error && !source.items.length && <p className="configuration-import-status">{t("没有可导入的配置")}</p>}
      {source.items.map((item, index) => <label className="configuration-import-item" key={`${item.fingerprint}-${index}`}>
        <input type="checkbox" aria-label={t("导入 {0} {1}", source.name, item.name)} checked={picked.includes(item.fingerprint)} disabled={busy || item.status === 'existing' || item.status === 'unsupported'} onChange={event => { const checked = event.currentTarget.checked; setPicked(current => checked ? [...new Set([...current, item.fingerprint])] : current.filter(id => id !== item.fingerprint)); }} />
        <span><strong>{item.name}</strong>{item.baseUrl && <span className="configuration-import-url">{item.baseUrl}</span>}{item.reason && <span className="configuration-import-status">{item.reason}</span>}</span>
      </label>)}
    </section>)}
    {onboarding && otherSources.length > 0 && <details className="configuration-import-other"><summary>{t("其他来源")}</summary>{otherSources.map(source => <div className="configuration-import-heading" key={source.source}><span>{source.name}</span><button type="button" className="provider-text-action" aria-label={t("选择 {0} 配置文件", source.name)} disabled={busy || !api.chooseConfigurationImportFile} onClick={() => void choose(source.source)}>{t("选择文件")}</button></div>)}</details>}
    </div>
    <div className="configuration-import-actions">{onboarding && picked.length > 0 && <button type="button" className="btn" disabled={busy} onClick={onBack}>{t("跳过")}</button>}<button type="button" className="btn primary" disabled={busy || (!onboarding && !picked.length) || (picked.length > 0 && !api.importConfigurations)} onClick={() => { if (onboarding && !picked.length) onBack(); else void apply(); }}>{busy ? t('处理中') : onboarding ? picked.length ? t('导入并继续') : t('继续') : t("导入{0}", picked.length ? ` ${picked.length} 项` : '')}</button></div>
  </div>;
}
