import { ProvidersPanel } from './ProvidersPanel';
import * as React from 'react';
import { Pencil, Trash2, ArrowDownToLine, Check, LoaderCircle } from 'lucide-react';
import type { XwXDeckRuntimeState, XwXDeckUpdateState, CompatibleServiceConfigSnapshot } from '@/bridge/types';
import { useBridge } from '@/bridge/store';
import { isDesktop } from '@/bridge/api';
import { showToast } from '@/lib/toast';
import { useConfirm, useConfirmChecked } from '@/components/ui/confirm-dialog';
import { hostFromUrl, isValidServiceUrl } from '@/lib/utils';
import { useTheme } from '@/lib/theme';
import { Toggle } from '@/features/shell/Toggle';
import { RepairCenterSheet } from '@/features/settings/RepairCenterSheet';

interface Props {
  readonly active: boolean;
}

const SERVICE_URL_PLACEHOLDER = 'https://gateway.example.com/v1';
const DEFAULT_PROVIDER_NAME = '兼容服务';

function formatCacheBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function operationError(error: unknown, fallback: string): string {
  const message = error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message.trim()
    : '';
  return message ? `${fallback}：${message}` : fallback;
}


export function SettingsPage({ active }: Props): React.ReactElement {
  const bridge = useBridge();
  const [runtime, setRuntime] = React.useState<XwXDeckRuntimeState | null>(bridge.runtime);
  const [compatibleService, set兼容服务] = React.useState<CompatibleServiceConfigSnapshot | null>(bridge.compatibleServiceConfig);
  const [updateState, setUpdateState] = React.useState<XwXDeckUpdateState | null>(bridge.updateState);
  const [busyStartup, setBusyStartup] = React.useState(false);
  const [busyRepair, setBusyRepair] = React.useState(false);
  const [busyReset, setBusyReset] = React.useState(false);
  const [checkingUpdate, setCheckingUpdate] = React.useState(false);
  const promptedUpdateRef = React.useRef<string>('');
  const [theme, setTheme] = useTheme(runtime?.theme, bridge.api.setTheme);
  const confirm = useConfirm();
  const confirmChecked = useConfirmChecked();

  React.useEffect(() => { if (bridge.runtime) setRuntime(bridge.runtime); }, [bridge.runtime]);
  React.useEffect(() => { if (bridge.compatibleServiceConfig) set兼容服务(bridge.compatibleServiceConfig); }, [bridge.compatibleServiceConfig]);
  React.useEffect(() => { if (bridge.updateState) setUpdateState(bridge.updateState); }, [bridge.updateState]);

  const traceRoot = runtime?.traceRoot || '—';
  const logRoot = runtime?.logRoot || '—';
  const tracing = runtime?.tracingEnabled === true;
  const startupSupported = runtime?.startup?.supported !== false;
  const startupEnabled = startupSupported && runtime?.startup?.enabled === true;

  const changeDir = React.useCallback(async (kind: 'trace' | 'logs') => {
    try {
      const selected = await bridge.api.chooseDirectory({ kind });
      if (!selected) return;
      const next = await bridge.api.updateTraceDirectories(
        kind === 'trace'
          ? { traceRoot: selected }
          : { logRoot: selected }
      );
      setRuntime(next);
      bridge.patch({ runtime: next });
      showToast(
        kind === 'trace'
          ? 'Trace 数据目录已修改；原目录中的数据不会自动移动'
          : '运行日志目录已修改',
        'success'
      );
    } catch (error) {
      showToast(operationError(error, '无法修改目录'), 'error');
    }
  }, [bridge.api, bridge.patch]);

  const handleClear = React.useCallback(async () => {
    if (!(await confirm({
      title: '清空所有 Trace 记录？',
      body: '将永久删除全部 Trace 记录，无法撤销。',
      confirmText: '清空',
      tone: 'danger',
    }))) return;
    try {
      const next = await bridge.api.clearHistory();
      setRuntime(next);
      bridge.patch({ runtime: next });
      showToast(bridge.runtime === null ? '浏览器预览不会删除本地数据' : 'Trace 记录已清空', 'success');
    } catch {
      showToast('无法清空 Trace 记录', 'error');
    }
  }, [bridge.api, bridge.patch, bridge.runtime, confirm]);

  const handleStartup = React.useCallback(async () => {
    if (busyStartup) return;
    const enabled = !startupEnabled;
    setBusyStartup(true);
    try {
      const next = await bridge.api.setStartupEnabled(enabled);
      setRuntime(next);
      bridge.patch({ runtime: next });
      showToast(enabled ? '已开启开机启动' : '已关闭开机启动', 'success');
    } catch {
      showToast('无法更新开机启动', 'error');
      try { setRuntime(await bridge.api.getState()); } catch { /* ignore */ }
    } finally {
      setBusyStartup(false);
    }
  }, [bridge.api, bridge.patch, busyStartup, startupEnabled]);

  const updateAvailable = updateState?.updateAvailable === true && !!updateState.targetVersion;
  const updateDownloading = updateState?.status === 'downloading';
  const manualMacUpdate = updateState?.installMode === 'manual-dmg';
  const updatePercent = Math.round(updateState?.percent || 0);
  const updateHint = updateState?.status === 'ready'
    ? manualMacUpdate
      ? `${updateState.targetVersion} 已下载，点击打开安装包`
      : `${updateState.targetVersion} 已下载，点击重启安装`
    : updateState?.status === 'downloading'
      ? `正在下载 ${updateState.targetVersion} · ${Math.round(updateState.percent || 0)}%`
      : `发现新版本 ${updateState?.targetVersion}，点击下载`;

  const confirmReadyUpdate = React.useCallback(async (version: string, manual: boolean) => {
    const proceed = await confirm({
      title: `XwX Deck ${version} 已准备好`,
      body: manual
        ? '将打开已校验的 DMG。打开后，请先从菜单栏安全退出当前 XwX Deck，再把新版拖入“应用程序”并选择覆盖。如果 macOS 再次阻止打开，请参照安装包中的“首次打开说明”。'
        : '重启后将自动完成更新，无需执行其他安装操作。',
      cancelText: '稍后',
      confirmText: manual ? '打开安装包' : '重启更新'
    });
    if (!proceed) return;
    try {
      const next = await bridge.api.restartAndInstall();
      if (manual) {
        setUpdateState(next);
        bridge.patch({ updateState: next });
        showToast('安装包已打开；请先安全退出当前 XwX Deck，再拖入“应用程序”覆盖', 'info');
      }
    } catch (error) {
      promptedUpdateRef.current = '';
      showToast(operationError(error, manual ? '无法打开安装包' : '无法重启并完成更新'), 'error');
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
      if (next) setUpdateState(next);
    } catch {
      showToast('更新操作失败', 'error');
    }
  }, [bridge.api, confirmReadyUpdate, updateState]);

  React.useEffect(() => {
    const version = updateState?.targetVersion || '';
    if (updateState?.status !== 'ready' || !version || promptedUpdateRef.current === version) return;
    promptedUpdateRef.current = version;
    void confirmReadyUpdate(version, updateState?.installMode === 'manual-dmg');
  }, [confirmReadyUpdate, updateState?.installMode, updateState?.status, updateState?.targetVersion]);

  const checkForUpdates = React.useCallback(async () => {
    if (checkingUpdate || updateDownloading || updateState?.status === 'installing') return;
    // In browser preview there is no real updater; skip the round-trip.
    if (bridge.runtime === null) {
      showToast('浏览器预览无法检查更新', 'info');
      return;
    }
    setCheckingUpdate(true);
    try {
      const next = await bridge.api.checkForUpdates();
      setUpdateState(next);
      bridge.patch({ updateState: next });
      if (next.status === 'error') {
        showToast('检查更新失败，请稍后再试', 'error');
      } else if (next.updateAvailable) {
        showToast(next.targetVersion ? `发现新版本 ${next.targetVersion}` : '发现新版本', 'info');
      } else {
        showToast('已是最新版本', 'success');
      }
    } catch {
      showToast('检查更新失败，请稍后再试', 'error');
    } finally {
      setCheckingUpdate(false);
    }
  }, [bridge.api, bridge.patch, bridge.runtime, checkingUpdate, updateDownloading, updateState?.status]);

  const handleReset = React.useCallback(async () => {
    if (busyReset) return;
    const result = await confirmChecked({
      title: '完全重置 XwX Deck？',
      body: (
        <span className="reset-confirm-copy">
          <span>
            将删除 XwX Deck 的设置、缓存、日志和默认 Trace 数据，并重新进入新手引导。
            自定义 Trace 与日志目录保留。
          </span>
          <span className="reset-confirm-client-note">
            勾选后还会删除 Claude settings.json / claude.json 和 ChatGPT config.toml / auth.json；
            对应客户端需要重新登录和初始化，核心配置由客户端下次启动时自行生成。
          </span>
        </span>
      ),
      checkboxLabel: '同时删除 Claude 与 ChatGPT 的核心配置',
      checkboxDefaultChecked: false,
      cancelText: '取消',
      confirmText: '完全重置',
      tone: 'danger',
      size: 'wide'
    });
    if (!result.confirmed) return;
    if (!isDesktop()) {
      showToast('浏览器预览不会删除本地数据', 'info');
      return;
    }
    setBusyReset(true);
    showToast('正在停止代理并准备重置…', 'info');
    try {
      await bridge.api.resetApplication({ resetClientConfigs: result.checked });
    } catch (error) {
      setBusyReset(false);
      showToast(operationError(error, '无法重置 XwX Deck'), 'error');
    }
  }, [bridge.api, bridge.runtime, busyReset, confirmChecked]);

  const handleQuickRepair = React.useCallback(async () => {
    if (busyRepair) return;
    // previewApi returns a fully populated runtime, so `bridge.runtime === null`
    // never fired in the browser preview: the mock repair reported success and
    // the mock reset left the button stuck busy. isDesktop() checks the preload
    // bridge instead.
    if (!isDesktop()) {
      showToast('浏览器预览不会清理本地数据', 'info');
      return;
    }
    setBusyRepair(true);
    try {
      const result = await bridge.api.repairApplication();
      // The caches rebuild within seconds, so a fixed success message made a
      // real deletion and a no-op look identical. Report what actually went.
      if (result.removedCachePaths === 0) {
        showToast('本地缓存已经是干净的，无需清理', 'info');
      } else {
        const size = formatCacheBytes(result.removedBytes);
        const models = result.refreshedModels ? `，已重新拉取 ${result.refreshedModels} 个模型` : '';
        showToast(`已清理 ${result.removedCachePaths} 项本地缓存${size ? `（${size}）` : ''}${models}`, 'success');
      }
    } catch (error) {
      showToast(operationError(error, '无法运行快速修复'), 'error');
    } finally {
      setBusyRepair(false);
    }
  }, [bridge.api, busyRepair]);

  return (
    <section
      className={`page${active ? ' current' : ''}`}
      id="page-settings"
      aria-label="设置"
      inert={active ? undefined : true}
    >
      <div className="page-inner">
        <div className="page-head"><h1>设置</h1></div>

        {/* Provider */}
        <div className="group">
          <ProvidersPanel />
        </div>

        {/* Trace */}
        <div className="group">
          <div className="group-label"><span className="eyebrow">Trace</span></div>
          <div className="trace-list">
            <div className="trace-row">
              <button
                type="button"
                className="trace-row-open"
                id="openDataFolder"
                title="打开 Trace 数据目录"
                onClick={() => void bridge.api.openDataFolder().catch(() => showToast('无法打开数据目录', 'error'))}
              >
                <span className="trace-row-copy">
                  <span className="trace-row-label">Trace 数据</span>
                  <span className="trace-row-path" id="traceDataPath" title={runtime?.traceRoot || ''}>{traceRoot}</span>
                </span>
              </button>
              <button
                type="button"
                className="trace-row-action"
                id="changeDataFolder"
                aria-label="修改 Trace 数据目录"
                aria-disabled={tracing || undefined}
                title={tracing ? '停止 Trace 后可修改' : '修改 Trace 数据目录'}
                onClick={() => {
                  if (tracing) {
                    showToast('请先停止 Trace，再修改数据目录', 'info');
                    return;
                  }
                  void changeDir('trace');
                }}
              >
                <Pencil className="ic" size={18} />
              </button>
            </div>
            <div className="trace-row">
              <button
                type="button"
                className="trace-row-open"
                id="openLogFolder"
                title="打开运行日志目录"
                onClick={() => void bridge.api.openLogFolder().catch(() => showToast('无法打开日志目录', 'error'))}
              >
                <span className="trace-row-copy">
                  <span className="trace-row-label">运行日志</span>
                  <span className="trace-row-path" id="traceLogPath" title={runtime?.logRoot || ''}>{logRoot}</span>
                </span>
              </button>
              <button
                type="button"
                className="trace-row-action"
                id="changeLogFolder"
                aria-label="修改运行日志目录"
                title="修改运行日志目录"
                onClick={() => void changeDir('logs')}
              >
                <Pencil className="ic" size={18} />
              </button>
            </div>
            <button type="button" className="trace-row danger" id="clearHistory" onClick={handleClear}>
              清空记录
              <span className="trace-row-danger-icon" aria-hidden="true">
                <Trash2 className="ic" size={18} strokeWidth={1.55} />
              </span>
            </button>
          </div>
        </div>

        {/* App */}
        <div className="group">
          <div className="group-label"><span className="eyebrow">应用</span></div>
          <div className="field-row">
            <span className="fr-label">夜间模式</span>
            <div className="fr-value">
              <Toggle
                id="themeToggle"
                checked={theme === 'night'}
                ariaLabel="夜间模式"
                title={theme === 'night' ? '当前为夜间模式' : '切换到夜间模式'}
                onToggle={() => setTheme(theme === 'night' ? 'day' : 'night')}
              />
            </div>
          </div>
          <div className="field-row">
            <span className="fr-label">开机启动</span>
            <div className="fr-value">
              <Toggle
                id="startupToggle"
                checked={startupEnabled}
                disabled={!startupSupported}
                busy={busyStartup}
                ariaLabel="开机启动"
                title={startupSupported
                  ? (startupEnabled ? '已开启开机启动' : '登录系统后自动启动')
                  : '当前运行方式不支持开机启动'}
                onToggle={handleStartup}
              />
            </div>
          </div>
          <div className="field-row">
            <span className="fr-label">版本</span>
            <div className="fr-value version-value">
              <button
                type="button"
                className="mono version-check"
                id="currentVersion"
                disabled={checkingUpdate || updateDownloading || updateState?.status === 'installing'}
                aria-label="点击检查更新"
                title="点击检查更新"
                onClick={checkForUpdates}
              >
                {checkingUpdate ? (
                  <>
                    <LoaderCircle className="ic version-check-spinner" aria-hidden="true" />
                    <span>检查中…</span>
                  </>
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
                aria-label={updateAvailable ? updateHint : '更新 XwX Deck'}
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
            </div>
          </div>
        </div>

        <RepairCenterSheet
          quickRepairBusy={busyRepair}
          onQuickRepair={() => void handleQuickRepair()}
          onOpenReset={() => void handleReset()}
        />
      </div>
    </section>
  );
}
