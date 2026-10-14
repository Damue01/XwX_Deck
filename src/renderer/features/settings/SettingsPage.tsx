import { formatBytes } from '../../../shared/format-bytes.browser.js';
import { changeLanguage, useLanguage, type Language, t } from '@/lib/i18n';
import { ProvidersPanel } from './ProvidersPanel';
import { DEFAULT_TRACE_LIMIT_GB, DEFAULT_TRACE_AUTO_CLEANUP } from '../../../shared/traceDefaults';
import * as React from 'react';
import { Pencil, ChevronRight, ArrowDownToLine, Check, LoaderCircle, Plus } from 'lucide-react';
import type { XwXDeckRuntimeState, XwXDeckUpdateState } from '@/bridge/types';
import { useBridge } from '@/bridge/store';
import { isDesktop } from '@/bridge/api';
import { openConfiguration, showErrorToast, showToast } from '@/lib/toast';
import { updateFailureDescription } from '../../../shared/updateFeedback';
import { useConfirm, useConfirmChecked } from '@/components/ui/confirm-dialog';
import { hostFromUrl, isValidServiceUrl } from '@/lib/utils';
import { Toggle } from '@/features/shell/Toggle';
import { Meter } from '@/components/ui/meter';
import { Badge } from '@/components/ui/badge';
import { RepairCenterSheet } from '@/features/settings/RepairCenterSheet';
import { announceAvailableUpdate } from '@/features/shell/UpdateNotification';
import { useRememberedExpansion } from '@/lib/useRememberedExpansion';
import { LanguagePicker } from './LanguagePicker';

interface Props {
  readonly active: boolean;
}

export function SettingsPage({ active }: Props): React.ReactElement {
  const bridge = useBridge();
  const language = useLanguage();
  const [savingLanguage, setSavingLanguage] = React.useState(false);
  const languageCommitPending = React.useRef(false);
  const selectLanguage = async (next: Language) => {
    if (languageCommitPending.current || next === language) return;
    languageCommitPending.current = true;
    setSavingLanguage(true);
    try {
      await changeLanguage(next, async value => {
        if (!bridge.api.setLanguage) throw new Error(t('当前版本不支持语言设置'));
        const updated = await bridge.api.setLanguage(value);
        bridge.patch({ runtime: updated });
      });
    } catch (error) { showErrorToast(t('语言未保存'), error); }
    finally { languageCommitPending.current = false; setSavingLanguage(false); }
  };
  const [runtime, setRuntime] = React.useState<XwXDeckRuntimeState | null>(bridge.runtime);
  const [updateState, setUpdateState] = React.useState<XwXDeckUpdateState | null>(bridge.updateState);
  const [busyStartup, setBusyStartup] = React.useState(false);
  const [savingAutomaticUpdates, setSavingAutomaticUpdates] = React.useState(false);
  const [applicationOpen, setApplicationOpen] = useRememberedExpansion('application');
  const saveAutomaticUpdates = async () => {
    if (savingAutomaticUpdates || !bridge.api.setAutomaticUpdates) return;
    setSavingAutomaticUpdates(true);
    try {
      const updated = await bridge.api.setAutomaticUpdates(!(runtime?.automaticUpdates ?? true));
      setRuntime(updated);
      bridge.patch({ runtime: updated });
    } catch (error) { showErrorToast(t('自动更新未保存'), error); }
    finally { setSavingAutomaticUpdates(false); }
  };
  const [busyReset, setBusyReset] = React.useState(false);
  const [busyWebCrypto, setBusyWebCrypto] = React.useState(false);
  const [webCryptoStorage, setWebCryptoStorage] = React.useState(bridge.runtime?.webCryptoStorage);
  const migrateWebCrypto = async () => {
    if (busyWebCrypto || !bridge.api.migrateWebCryptoKey) return;
    if (!await confirm({ title: t('迁移网页登录密钥？'), body: t('这会读取一次旧的 WebKit 主密钥，系统可能要求输入钥匙串密码。迁移后保存在本地，原网页登录和 API Key 保留。'), confirmText: t('迁移到本地') })) return;
    setBusyWebCrypto(true);
    try {
      const updated = await bridge.api.migrateWebCryptoKey();
      setRuntime(updated); bridge.patch({ runtime: updated });
      showToast(t('网页登录密钥已迁移'), 'success');
    } catch (error) { showErrorToast(t('网页登录密钥未迁移'), error); }
    finally { setBusyWebCrypto(false); }
  };
  const [checkingUpdate, setCheckingUpdate] = React.useState(false);
  const [traceOpen, setTraceOpen] = useRememberedExpansion('trace');
  const [modelConfigOpen, setModelConfigOpen] = useRememberedExpansion('models');
  const [limitDraft, setLimitDraft] = React.useState(String(DEFAULT_TRACE_LIMIT_GB));
  const [editingLimit, setEditingLimit] = React.useState(false);
  const [savingStorage, setSavingStorage] = React.useState(false);
  const limitCommitPending = React.useRef(false);
  const openModelConfig = React.useCallback(() => setModelConfigOpen(true), [setModelConfigOpen]);
  const promptedUpdateRef = React.useRef<string>('');
  const confirm = useConfirm();
  const confirmChecked = useConfirmChecked();

  React.useEffect(() => { if (bridge.runtime) setRuntime(bridge.runtime); }, [bridge.runtime]);
  React.useEffect(() => { if (bridge.runtime?.webCryptoStorage) setWebCryptoStorage(bridge.runtime.webCryptoStorage); }, [bridge.runtime?.webCryptoStorage]);
  React.useEffect(() => { if (bridge.updateState) setUpdateState(bridge.updateState); }, [bridge.updateState]);
  React.useEffect(() => {
    if (!editingLimit && runtime?.traceWarningGB !== undefined) setLimitDraft(String(runtime.traceWarningGB));
  }, [editingLimit, runtime?.traceWarningGB]);
  React.useEffect(() => {
    if (!active) return;
    const showTraceSettings = () => setTraceOpen(true);
    window.addEventListener('xwxdeck:open-trace-settings', showTraceSettings);
    return () => window.removeEventListener('xwxdeck:open-trace-settings', showTraceSettings);
  }, [active, setTraceOpen]);
  React.useEffect(() => {
    if (!traceOpen && editingLimit) {
      setEditingLimit(false);
      setLimitDraft(String(runtime?.traceWarningGB ?? DEFAULT_TRACE_LIMIT_GB));
    }
  }, [traceOpen, editingLimit, runtime?.traceWarningGB]);

  const traceRoot = runtime?.traceRoot || '—';
  const logRoot = runtime?.logRoot || '—';
  const startupSupported = runtime?.startup?.supported !== false;
  const startupEnabled = startupSupported && (runtime?.startup?.desiredEnabled ?? runtime?.startup?.enabled) === true;
  const limitValue = Number(limitDraft);
  const limitValid = /^\d+$/.test(limitDraft) && Number.isSafeInteger(limitValue)
    && limitValue >= 0;
  const storageExceeded = (runtime?.traceWarningGB ?? DEFAULT_TRACE_LIMIT_GB) > 0
    && (runtime?.traceStorageBytes ?? 0) > (runtime?.traceWarningGB ?? DEFAULT_TRACE_LIMIT_GB) * 1024 ** 3;
  const needsManualCleanup = storageExceeded && !runtime?.traceAutoCleanup;
  const storageUsedText = runtime?.traceStorageBytes === undefined ? '—' : formatBytes(runtime.traceStorageBytes);
  const storageLimitGB = runtime?.traceWarningGB ?? DEFAULT_TRACE_LIMIT_GB;
  const storagePercent = storageLimitGB === 0 ? 0
    : Math.min(100, Math.max(0, (runtime?.traceStorageBytes ?? 0) / (storageLimitGB * 1024 ** 3) * 100));
  const saveStorage = React.useCallback(async (input: { limitGB?: number; autoCleanup?: boolean; clearUsage?: boolean }) => {
    if (savingStorage) return;
    setSavingStorage(true);
    try {
      const next = await bridge.api.setTraceStoragePolicy(input);
      setRuntime(next);
      bridge.patch({ runtime: next });
      if (next.traceStorageNotice) showToast(t('Trace 存储设置已保存'), 'info', undefined, { description: next.traceStorageNotice });
    } catch (error) {
      showErrorToast(t('更新 Trace 存储设置失败'), error);
    } finally {
      setSavingStorage(false);
    }
  }, [bridge.api, bridge.patch, savingStorage]);

  const commitLimit = React.useCallback(async () => {
    if (limitCommitPending.current) return;
    limitCommitPending.current = true;
    try {
      setEditingLimit(false);
      if (!limitValid) {
        setLimitDraft(String(storageLimitGB));
        showToast(t('请输入非负整数，单位 GB'), 'info');
        return;
      }
      if (limitValue === runtime?.traceWarningGB && !runtime?.traceStorageNotice) return;
      let clearUsage = false;
      if (limitValue === 0 && runtime?.traceWarningGB !== 0) {
        const proceed = await confirmChecked({
          title: t('切换为仅用量模式？'),
          body: t('现有 Trace 详细记录将被永久删除。之后不再保存请求和响应内容，只保留 token 用量与费用统计。Gateway 仍会正常转发。'),
          confirmText: t('删除记录并切换'),
          cancelText: t('取消'),
          tone: 'danger',
          checkboxLabel: t('同时删除已有 Token 用量和费用统计'),
          checkboxDefaultChecked: false
        });
        if (!proceed.confirmed) {
          setLimitDraft(String(storageLimitGB));
          return;
        }
        clearUsage = proceed.checked;
      }
      await saveStorage({ limitGB: limitValue, ...(clearUsage ? { clearUsage: true } : {}) });
      await bridge.refreshStats();
    } finally {
      limitCommitPending.current = false;
    }
  }, [confirmChecked, bridge.refreshStats, limitValid, limitValue, runtime?.traceWarningGB, saveStorage, storageLimitGB]);

  const limitControl = editingLimit ? (
    <span className="trace-storage-limit-editor">
      <input
        id="traceWarningGB"
        type="number"
        min={0}
        step={1}
        value={limitDraft}
        aria-label={t("Trace 存储上限，单位 GB")}
        aria-invalid={!limitValid}
        disabled={savingStorage}
        autoFocus
        onChange={event => setLimitDraft(event.target.value)}
        onBlur={commitLimit}
        onKeyDown={event => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setLimitDraft(String(storageLimitGB));
            setEditingLimit(false);
          }
        }}
      />
      <span>GB</span>
    </span>
  ) : (
    <button
      type="button"
      className="trace-storage-limit"
      aria-label={t("修改 Trace 存储设置，当前 {0}", storageLimitGB === 0 ? '仅用量统计' : `${storageLimitGB} GB`)}
      disabled={savingStorage}
      onClick={() => setEditingLimit(true)}
    >
      {storageLimitGB === 0 ? t('仅用量') : `${storageLimitGB} GB`}
    </button>
  );
  const autoCleanupControl = (
    <Toggle
      id="traceAutoCleanup"
      checked={runtime?.traceAutoCleanup ?? DEFAULT_TRACE_AUTO_CLEANUP}
      busy={savingStorage}
      ariaLabel={t("超出上限时自动清理旧 Trace 记录")}
      title={t("开启后，超出上限时会从最旧的完整对话开始删除，保留正在记录的对话。")}
      onToggle={() => void saveStorage({ autoCleanup: !(runtime?.traceAutoCleanup ?? DEFAULT_TRACE_AUTO_CLEANUP) })}
    />
  );
  const changeDir = React.useCallback(async (kind: 'trace' | 'logs') => {
    let resumeTrace = false;
    try {
      const selected = await bridge.api.chooseDirectory({ kind });
      if (!selected) return;
      if (kind === 'trace' && (runtime?.tracingEnabled || runtime?.backgroundGatewayActive)) {
        if (!await confirm({ title: t('暂停 Trace 并更改目录？'),
          body: t('Deck 会自动暂停转发并更改目录，完成后恢复原来的 Trace 开关。进行中的请求可能中断。'),
          confirmText: t('暂停并更改'), cancelText: t('取消') })) return;
        await bridge.api.toggleTracing(false, true);
        resumeTrace = runtime.tracingEnabled;
      }
      const next = await bridge.api.updateTraceDirectories(
        kind === 'trace'
          ? { traceRoot: selected }
          : { logRoot: selected }
      );
      setRuntime(next);
      bridge.patch({ runtime: next });
      showToast(
        kind === 'trace'
          ? t('Trace 数据目录已修改；原目录中的数据不会自动移动')
          : t('运行日志目录已修改'),
        'success'
      );
    } catch (error) {
      showErrorToast(t('修改目录失败'), error);
    } finally {
      if (resumeTrace) {
        try {
          const restored = await bridge.api.toggleTracing(true);
          setRuntime(restored); bridge.patch({ runtime: restored });
        } catch (error) {
          showErrorToast(t('目录操作已结束，重新开启 Trace 未完成'), error);
        }
      }
    }
  }, [bridge.api, bridge.patch, confirm, runtime?.tracingEnabled, runtime?.backgroundGatewayActive]);

  const saveStartup = React.useCallback(async (enabled: boolean) => {
    if (busyStartup) return;
    setBusyStartup(true);
    try {
      const next = await bridge.api.setStartupEnabled(enabled);
      setRuntime(next);
      bridge.patch({ runtime: next });
      showToast(next.startup?.warning ? t('开机启动选择已保存，系统同步待完成')
        : enabled ? t('已开启开机启动') : t('已关闭开机启动'), next.startup?.warning ? 'info' : 'success', undefined,
        { description: next.startup?.warning, diagnostic: !!next.startup?.warning });
    } catch (error) {
      showErrorToast(t('更新开机启动失败'), error);
    } finally {
      setBusyStartup(false);
    }
  }, [bridge.api, bridge.patch, busyStartup]);
  const handleStartup = () => saveStartup(!startupEnabled);

  const updateAvailable = updateState?.updateAvailable === true && !!updateState.targetVersion;
  const updateDownloading = updateState?.status === 'downloading';
  const manualMacUpdate = updateState?.installMode === 'manual-dmg';
  const updatePercent = Math.round(updateState?.percent || 0);
  const updateHint = updateState?.status === 'ready'
    ? manualMacUpdate
      ? t("{0} 已下载，点击打开安装包", updateState.targetVersion)
      : t("{0} 已下载，点击重启安装", updateState.targetVersion)
    : updateState?.status === 'downloading'
      ? t("正在下载 {0}，{1}%", updateState.targetVersion, Math.round(updateState.percent || 0))
      : t("发现新版本 {0}，点击下载", updateState?.targetVersion);

  const confirmReadyUpdate = React.useCallback(async (version: string, manual: boolean) => {
    const proceed = await confirm({
      title: t("XwX Deck {0} 已准备好", version),
      body: manual
        ? t('将打开已校验的 DMG，并安全退出当前 XwX Deck。退出完成后，把新版拖入“应用程序”并选择替换。如果 macOS 再次阻止打开，请参照安装包中的“首次打开说明”。')
        : t('重启后将自动完成更新，无需执行其他安装操作。'),
      cancelText: t('稍后'),
      confirmText: manual ? t('打开安装包') : t('重启更新')
    });
    if (!proceed) return;
    try {
      const next = await bridge.api.restartAndInstall();
      if (manual) {
        setUpdateState(next);
        bridge.patch({ updateState: next });
        showToast(t('安装包已打开，正在安全退出；退出后拖入“应用程序”替换'), 'info');
      }
    } catch (error) {
      promptedUpdateRef.current = '';
      showErrorToast(manual ? t('打开安装包失败') : t('重启并完成更新失败'), error);
    }
  }, [bridge.api, bridge.patch, confirm]);

  const handleUpdateClick = React.useCallback(async () => {
    if (updateState?.status === 'ready' && updateState.targetVersion) {
      await confirmReadyUpdate(updateState.targetVersion, updateState.installMode === 'manual-dmg');
      return;
    }
    try {
      const next = updateState?.updateAvailable
        ? await bridge.api.downloadUpdate()
        : updateState;
      if (next) {
        setUpdateState(next);
        bridge.patch({ updateState: next });
        if (next.status === 'error') {
          showToast(t('更新下载失败'), 'error', undefined, {
            description: updateFailureDescription(next.error),
            timeout: 12_000
          });
        }
      }
    } catch (error) {
      showErrorToast(t('更新操作失败'), error);
    }
  }, [bridge.api, confirmReadyUpdate, updateState]);

  const handleCancelUpdate = React.useCallback(async () => {
    const downloading = updateState?.status === 'downloading';
    try {
      const next = await bridge.api.cancelUpdate();
      setUpdateState(next);
      bridge.patch({ updateState: next });
      promptedUpdateRef.current = '';
      showToast(downloading ? t('已取消更新下载') : t('已取消待安装更新'), 'success');
    } catch (error) {
      showErrorToast(t('取消更新失败'), error);
    }
  }, [bridge.api, bridge.patch, updateState?.status]);

  React.useEffect(() => {
    const version = updateState?.targetVersion || '';
    if (updateState?.background || updateState?.status !== 'ready' || !version || promptedUpdateRef.current === version) return;
    promptedUpdateRef.current = version;
    void confirmReadyUpdate(version, updateState?.installMode === 'manual-dmg');
  }, [confirmReadyUpdate, updateState?.background, updateState?.installMode, updateState?.status, updateState?.targetVersion]);

  const checkForUpdates = React.useCallback(async () => {
    if (checkingUpdate || updateDownloading || updateState?.status === 'installing') return;
    // In browser preview there is no real updater; skip the round-trip.
    if (bridge.runtime === null) {
      showToast(t('浏览器预览无法检查更新'), 'info');
      return;
    }
    setCheckingUpdate(true);
    try {
      const next = await bridge.api.checkForUpdates();
      setUpdateState(next);
      bridge.patch({ updateState: next });
      if (!next.supported) {
        showToast(t('当前运行方式不支持应用内更新检查'), 'info');
      } else if (next.status === 'error') {
        showToast(t('检查更新失败'), 'error', undefined, {
          description: updateFailureDescription(next.error),
          timeout: 12_000
        });
      } else if (next.updateAvailable) {
        // A manual repeat check should still show the actionable notice even
        // when the automatic version notification was already shown.
        announceAvailableUpdate(next, () => bridge.api.downloadUpdate(), downloaded => bridge.patch({ updateState: downloaded }));
      } else if (next.status === 'up-to-date' || next.status === 'portable') {
        showToast(t('当前更新通道暂无可用新版本'), 'info');
      } else {
        showToast(t('更新检查尚未完成，无法确认是否有新版本'), 'info');
      }
    } catch (error) {
      showToast(t('检查更新失败'), 'error', undefined, {
        description: updateFailureDescription(error),
        timeout: 12_000
      });
    } finally {
      setCheckingUpdate(false);
    }
  }, [bridge.api, bridge.patch, bridge.runtime, checkingUpdate, updateDownloading, updateState?.status]);

  const handleReset = React.useCallback(async () => {
    if (busyReset) return;
    const result = await confirmChecked({
      title: t('重置 XwX Deck？'),
      body: (
        <span className="reset-confirm-copy">
          <span>{t("将删除 XwX Deck 的设置、缓存、Trace 记录和运行日志，清空自定义 Trace、日志目录中的内容。")}</span>
          {bridge.runtime?.applicationResetArchives && <span>{t("重置前会归档备份；备份仍占用磁盘空间。完成后会重新启动应用。")}</span>}
          <span className="reset-confirm-client-note">{t("勾选下面选项后，还会删除 Claude、ChatGPT／Codex 的核心配置。若客户端仍在运行，将弹窗询问是否强制关闭；未保存的工作会丢失。Skills、Agents 不受影响。")}</span>
        </span>
      ),
      checkboxLabel: t('同时删除 Claude 与 ChatGPT／Codex 的核心配置'),
      checkboxDefaultChecked: false,
      cancelText: t('取消'),
      confirmText: t('重置'),
      tone: 'danger',
      size: 'wide'
    });
    if (!result.confirmed) return;
    if (!isDesktop()) {
      showToast(t('浏览器预览不会删除本地数据'), 'info');
      return;
    }
    setBusyReset(true);
    showToast(t('正在准备重置…'), 'info');
    try {
      await bridge.api.resetApplication({ resetClientConfigs: result.checked });
    } catch (error) {
      setBusyReset(false);
      const message = error instanceof Error ? error.message : String(error);
      if (message === '已取消重置。') return;
      if (/客户端未能完全关闭|无法确认.*退出/.test(message)) {
        showToast('客户端未能关闭', 'warning', undefined, {
          diagnostic: true,
          description: message,
          timeout: 8_000
        });
      } else {
        showErrorToast(t('重置失败'), error);
      }
    }
  }, [bridge.api, bridge.runtime, busyReset, confirmChecked]);

  return (
    <section
      className={`page${active ? ' current' : ''}`}
      id="page-settings"
      aria-label={t("设置")}
      inert={active ? undefined : true}
    >
      <div className="page-inner">
        <div className="page-head"><h1>{t("设置")}</h1></div>

        {/* Provider */}
        <div className="group">
          <div className="group-label provider-heading">
            <button type="button" className="trace-section-trigger" aria-expanded={modelConfigOpen}
              aria-controls="model-config-content" onClick={() => setModelConfigOpen(!modelConfigOpen)}>
              <span className="eyebrow">{t("模型配置")}</span>
              <ChevronRight size={15} className="trace-section-chevron" aria-hidden="true" />
            </button>
            <button id="provider-add" type="button" className="provider-text-action" onClick={event => openConfiguration(event.currentTarget)}><Plus aria-hidden="true" />{t("添加配置")}</button>
          </div>
          <div id="model-config-content" hidden={!modelConfigOpen}>
            <ProvidersPanel onRequestOpen={openModelConfig} />
          </div>
        </div>

        {/* Trace */}
        <div className="group">
          <div className="group-label">
            <button
              type="button"
              className="trace-section-trigger"
              aria-expanded={traceOpen}
              aria-controls="trace-settings-content"
              onClick={() => setTraceOpen(!traceOpen)}
            >
              <span className="eyebrow">Trace</span>
              <ChevronRight size={15} className="trace-section-chevron" aria-hidden="true" />
            </button>
            {needsManualCleanup && <Badge variant="secondary">{t("超出上限")}</Badge>}
          </div>
          <div className="trace-list" id="trace-settings-content" hidden={!traceOpen}>
            <div className="trace-storage">
              <div className="trace-storage-heading">
                <span className="trace-storage-heading-label">{t("Trace 记录")}</span>
                <div className="trace-storage-inline-reading">
                  <span>{storageUsedText}{storageLimitGB === 0 ? '' : ' /'}</span>
                  {limitControl}
                </div>
              </div>
              {storageLimitGB > 0 && <Meter value={storagePercent} min={0} max={100}
                aria-label={storageLimitGB === 0 ? t('仅用量模式，不保存详细 Trace') : t("Trace 记录占用 {0}，设置上限 {1} GB", storageUsedText, storageLimitGB)}
                className="trace-storage-meter" />}
              {storageLimitGB > 0 && <div className="trace-storage-controls">
                <label className="trace-storage-control-label" htmlFor="traceAutoCleanup"
                  title={t("开启后，超出上限时会从最旧的完整对话开始删除，保留正在记录的对话。")}>{t("超出上限时自动清理")}</label>
                <div className="trace-storage-control-value">{autoCleanupControl}</div>
              </div>}
            </div>
            <div className="trace-row">
              <button
                type="button"
                className="trace-row-open"
                id="openDataFolder"
                title={t("打开 Trace 数据目录")}
                onClick={() => void bridge.api.openDataFolder().catch(() => showToast(t('无法打开数据目录'), 'error'))}
              >
                <span className="trace-row-copy">
                  <span className="trace-row-label">{t("Trace 数据")}</span>
                  <span className="trace-row-path" id="traceDataPath" title={runtime?.traceRoot || ''}>{traceRoot}</span>
                </span>
              </button>
              <button
                type="button"
                className="trace-row-action"
                id="changeDataFolder"
                aria-label={t("修改 Trace 数据目录")}
                title={t("修改 Trace 数据目录")}
                onClick={() => void changeDir('trace')}
              >
                <Pencil className="ic" size={18} />
              </button>
            </div>
            <div className="trace-row">
              <button
                type="button"
                className="trace-row-open"
                id="openLogFolder"
                title={t("打开运行日志目录")}
                onClick={() => void bridge.api.openLogFolder().catch(() => showToast(t('无法打开日志目录'), 'error'))}
              >
                <span className="trace-row-copy">
                  <span className="trace-row-label">{t("运行日志")}</span>
                  <span className="trace-row-path" id="traceLogPath" title={runtime?.logRoot || ''}>{logRoot}</span>
                </span>
              </button>
              <button
                type="button"
                className="trace-row-action"
                id="changeLogFolder"
                aria-label={t("修改运行日志目录")}
                title={t("修改运行日志目录")}
                onClick={() => void changeDir('logs')}
              >
                <Pencil className="ic" size={18} />
              </button>
            </div>
          </div>
        </div>

        {/* App */}
        <div className="group">
          <div className="group-label">
            <button type="button" className="trace-section-trigger"
              aria-expanded={applicationOpen} aria-controls="application-settings-content"
              onClick={() => setApplicationOpen(!applicationOpen)}>
              <span className="eyebrow">{t("应用")}</span>
              <ChevronRight size={15} className="trace-section-chevron" aria-hidden="true" />
            </button>
          </div>
          <div id="application-settings-content" hidden={!applicationOpen}>
          {webCryptoStorage?.status === 'migration-required' && <div className="field-row">
            <span className="fr-label">{t('网页登录密钥')}</span>
            <div className="fr-value"><button type="button" className="btn" disabled={busyWebCrypto}
              title={webCryptoStorage.message} onClick={() => void migrateWebCrypto()}>
              {busyWebCrypto ? t('迁移中…') : t('迁移到本地')}
            </button></div>
          </div>}
          <div className="field-row">
            <label className="fr-label fr-label-action" htmlFor="applicationLanguage">{t("语言")}</label>
            <div className="fr-value"><LanguagePicker value={language} busy={savingLanguage} onChange={next => void selectLanguage(next)} /></div>
          </div>
          <div className="field-row">
            <span className="fr-label">{t("开机启动")}</span>
            <div className="fr-value">
              {runtime?.startup?.warning && <button type="button" className="version-check"
                disabled={busyStartup} title={runtime.startup.warning}
                onClick={() => void saveStartup(startupEnabled)}>{t("重试同步")}</button>}
              <Toggle
                id="startupToggle"
                checked={startupEnabled}
                disabled={!startupSupported}
                busy={busyStartup}
                ariaLabel={t("开机启动")}
                title={runtime?.startup?.warning ?? (startupSupported
                  ? (startupEnabled ? t('已开启开机启动') : t('登录系统后自动启动'))
                  : t('当前运行方式不支持开机启动'))}
                onToggle={handleStartup}
              />
            </div>
          </div>
          <div className="field-row">
            <label className="fr-label fr-label-action" htmlFor="automaticUpdatesToggle">{t("自动更新")}</label>
            <div className="fr-value"><Toggle
              id="automaticUpdatesToggle"
              checked={runtime?.automaticUpdates ?? true}
              busy={savingAutomaticUpdates}
              disabled={!bridge.api.setAutomaticUpdates || !runtime}
              ariaLabel={t("自动更新")}
              onToggle={saveAutomaticUpdates}
            /></div>
          </div>
          <div className="field-row">
            <span className="fr-label">{t("版本")}</span>
            <div className="fr-value version-value">
              <button
                type="button"
                className="mono version-check"
                id="currentVersion"
                disabled={checkingUpdate || updateDownloading || updateState?.status === 'installing'}
                aria-label={t("点击检查更新")}
                title={t("点击检查更新")}
                onClick={checkForUpdates}
              >
                {checkingUpdate ? (
                  <span>{t("检查中…")}</span>
                ) : (
                  updateState?.currentVersion || '—'
                )}
              </button>
              <button
                type="button"
                className={`update-cue version-update-cue${updateDownloading ? ' is-downloading' : ''}`}
                id="versionUpdateCue"
                hidden={!updateAvailable}
                disabled={updateDownloading || updateState?.status === 'installing'}
                aria-label={updateAvailable ? updateHint : t('更新 XwX Deck')}
                title={updateAvailable ? updateHint : ''}
                onClick={handleUpdateClick}
              >
                {updateDownloading ? (
                  <>
                    <LoaderCircle className="ic version-update-spinner" aria-hidden="true" />
                    <span className="version-update-percent">{updatePercent}%</span>
                  </>
                ) : updateState?.status === 'ready' ? (
                  <Check className="ic" aria-hidden="true" />
                ) : (
                  <ArrowDownToLine className="ic" aria-hidden="true" />
                )}
              </button>
              {updateState?.status === 'ready' || updateState?.status === 'downloading' ? (
                <button
                  type="button"
                  className="version-cancel-update"
                  onClick={handleCancelUpdate}
                >
                  {updateState.status === 'downloading' ? t('取消下载') : t('取消更新')}
                </button>
              ) : null}
            </div>
          </div>
          </div>
        </div>

        <RepairCenterSheet onOpenReset={() => void handleReset()} />
      </div>
    </section>
  );
}
