import * as React from 'react';
import { BridgeProvider, useBridge } from '@/bridge/store';
import { clearLifecycleNotice, closeToast, showToast, showLifecycleNotice, ToastProvider } from '@/lib/toast';
import { lifecycleFailure } from '../shared/lifecycleNotice';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog';
import { Titlebar } from '@/features/shell/Titlebar';
import { Rail, type PageId } from '@/features/shell/Rail';
import { SignalPage, TRACE_TOGGLE_REQUEST_EVENT } from '@/features/trace/SignalPage';
import { ModelsPage } from '@/features/models/ModelsPage';
import { ToolsPage } from '@/features/tools/ToolsPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { OnboardingTour } from '@/features/onboarding/OnboardingTour';
import { UpdateNotification } from '@/features/shell/UpdateNotification';
import { ConnectionNotice } from '@/features/shell/ConnectionNotice';
import { applyTheme } from '@/lib/theme';
import { userErrorMessage } from '@/lib/errors';

function Shell(): React.ReactElement {
  const bridge = useBridge();
  const [activePage, setActivePage] = React.useState<PageId>('signal');
  const [windowState, setWindowState] = React.useState({ maximized: false, fullscreen: false, nativeFrame: false });
  const notifiedMissingProviders = React.useRef('');
  const notifiedRuntimeIssue = React.useRef('');
  const notifiedLoadIssues = React.useRef('');
  const notifiedTraceWarning = React.useRef('');
  const [retryingInitialData, setRetryingInitialData] = React.useState(false);

  // Apply the authoritative theme from persistent runtime state app-wide, so it
  // holds even if the user never opens Settings (e.g. after a portable
  // repackage dropped the localStorage early-paint hint).
  const runtimeTheme = bridge.runtime?.theme;
  React.useEffect(() => {
    if (runtimeTheme) applyTheme(runtimeTheme);
  }, [runtimeTheme]);

  // Notify particle field and other listeners when the active page changes.
  React.useEffect(() => {
    document.dispatchEvent(new Event('xwx:pagechange'));
  }, [activePage]);

  React.useEffect(() => {
    const unsub = bridge.api.onWindowState(state => setWindowState(state));
    return unsub;
  }, [bridge.api]);

  React.useEffect(() => {
    const handler = () => setActivePage('settings');
    window.addEventListener('xwxdeck:show-update-details', handler);
    return () => window.removeEventListener('xwxdeck:show-update-details', handler);
  }, []);

  React.useEffect(() => bridge.api.onNotice(notice => {
    showLifecycleNotice(notice);
  }), [bridge.api]);

  const runtimeError = bridge.runtime?.lastError;
  const recoveryNotice = bridge.runtime?.lifecycleNotice;
  const connectionNotice = bridge.runtime?.connectionNotice;
  const traceStorageBytes = bridge.runtime?.traceStorageBytes ?? 0;
  const traceWarningGB = bridge.runtime?.traceWarningGB ?? 2;
  const traceStorageText = bridge.runtime?.storageText ?? '0 B';
  React.useEffect(() => {
    if (!bridge.booted || !bridge.runtime) return;
    const id = 'trace-capacity-warning';
    if (traceWarningGB === 0 || traceStorageBytes <= traceWarningGB * 1024 ** 3 || bridge.runtime.traceAutoCleanup) {
      notifiedTraceWarning.current = '';
      closeToast(id);
      return;
    }
    const signature = `${bridge.runtime.traceRoot}:${traceWarningGB}`;
    if (notifiedTraceWarning.current === signature) return;
    notifiedTraceWarning.current = signature;
    showToast('Trace 记录需要清理', 'info', id, {
      description: `已使用 ${traceStorageText}，超过 ${traceWarningGB} GB。可调整上限或开启自动清理。`,
      actionProps: {
        type: 'button',
        children: '查看设置',
        onClick: () => {
          setActivePage('settings');
          window.dispatchEvent(new Event('xwxdeck:open-trace-settings'));
        }
      }
    });
  }, [bridge.booted, bridge.runtime?.traceRoot, bridge.runtime?.traceAutoCleanup, traceStorageBytes, traceWarningGB, traceStorageText]);
  React.useEffect(() => {
    if (!bridge.booted) return;
    const notice = runtimeError ? lifecycleFailure(runtimeError, '恢复运行状态') : recoveryNotice;
    const signature = notice ? `${notice.message}\n${notice.description ?? ''}` : '';
    if (signature === notifiedRuntimeIssue.current) return;
    const previousSignature = notifiedRuntimeIssue.current;
    notifiedRuntimeIssue.current = signature;
    if (notice) showLifecycleNotice(notice, 'runtime-lifecycle-issue');
    else if (previousSignature) clearLifecycleNotice();
  }, [bridge.booted, runtimeError, recoveryNotice]);

  const notifiedConnectionNotice = React.useRef('');
  React.useEffect(() => {
    if (!bridge.booted) return;
    const id = 'runtime-connection-notice';
    const signature = connectionNotice
      ? `${connectionNotice.message}\n${connectionNotice.description ?? ''}`
      : '';
    const stateSignature = `${signature}\n${runtimeError ? 'suppressed' : 'visible'}`;
    if (stateSignature === notifiedConnectionNotice.current) return;
    notifiedConnectionNotice.current = stateSignature;
    if (connectionNotice && !runtimeError) showLifecycleNotice(connectionNotice, id);
    else closeToast(id);
  }, [bridge.booted, connectionNotice, runtimeError]);

  React.useEffect(() => {
    if (!bridge.booted) return;
    const key = 'initial-load-issues';
    const signature = bridge.loadIssues.join('\u0000');
    if (!signature) {
      if (notifiedLoadIssues.current) closeToast(key);
      notifiedLoadIssues.current = '';
      setRetryingInitialData(false);
      return;
    }
    if (retryingInitialData) return;
    if (notifiedLoadIssues.current === signature) return;
    notifiedLoadIssues.current = signature;
    showToast('部分数据仍在加载', 'warning', key, {
      description: '已加载内容仍可继续使用。需要时可以重新加载未就绪的数据。',
      actionProps: {
        type: 'button',
        children: '重试',
        onClick: () => {
          notifiedLoadIssues.current = '';
          setRetryingInitialData(true);
          showToast('正在重新加载…', 'info', key, { timeout: 3000 });
          bridge.retryInitialData();
          window.setTimeout(() => setRetryingInitialData(false), 1000);
        }
      }
    });
  }, [bridge.booted, bridge.loadIssues, bridge.retryInitialData, retryingInitialData]);

  const missingProviderSignature = [...(bridge.runtime?.missingCodexHistoryProviders ?? [])].sort().join('\u0000');
  const codexConfigPath = bridge.codexConfig?.configPath;
  React.useEffect(() => {
    if (!bridge.booted || !codexConfigPath) return;
    const id = 'codex-history-provider-missing';
    const storageKey = `xwx.missingHistoryProviders.${codexConfigPath}`;
    if (!missingProviderSignature) {
      if (notifiedMissingProviders.current) closeToast(id);
      notifiedMissingProviders.current = '';
      return;
    }
    let ignored: string[] = [];
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]');
      if (Array.isArray(saved)) ignored = saved.filter((value): value is string => typeof value === 'string');
    } catch { /* invalid or unavailable local storage must not block the audit */ }
    const missingProviders = missingProviderSignature.split('\u0000').filter(provider => !ignored.includes(provider));
    const visibleSignature = missingProviders.join('\u0000');
    if (!visibleSignature) {
      if (notifiedMissingProviders.current) closeToast(id);
      notifiedMissingProviders.current = '';
      return;
    }
    if (notifiedMissingProviders.current === visibleSignature) return;
    if (runtimeError || recoveryNotice) return;
    notifiedMissingProviders.current = visibleSignature;
    const labels: Record<string, string> = {
      xwx_deck: 'XwX Deck',
    };
    const missing = missingProviders.map(provider => labels[provider] ?? provider);
    showToast('ChatGPT 历史连接配置缺失', 'warning', id, {
      description: `历史对话仍引用 ${missing.join('、')}，但该连接已不在 ChatGPT 配置中。当前新对话不受影响；如需继续使用旧对话，请从可信备份恢复原连接。`,
      timeout: 12_000,
      actionProps: {
        type: 'button',
        children: '不再提醒',
        'aria-label': '不再提醒这些已删除的 ChatGPT 历史连接',
        onClick: () => {
          try {
            localStorage.setItem(storageKey, JSON.stringify([...new Set([...ignored, ...missingProviders])]));
            closeToast(id);
          } catch {
            showToast('无法保存“不再提醒”', 'warning', id, {
              description: '应用本地存储不可用，下次启动仍可能出现此提醒。'
            });
          }
        }
      }
    });
  }, [bridge.booted, codexConfigPath, missingProviderSignature, runtimeError, recoveryNotice]);

  React.useEffect(() => {
    const handler = (e: Event) => {
      const page = (e as CustomEvent<PageId>).detail;
      if (page) setActivePage(page);
    };
    window.addEventListener('xwxdeck:navigate', handler as EventListener);
    return () => window.removeEventListener('xwxdeck:navigate', handler as EventListener);
  }, []);

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || activePage !== 'signal') return;
      const target = document.activeElement;
      if (!target || target === document.body || (target as HTMLElement).id === 'captureBtn') {
        e.preventDefault();
        window.dispatchEvent(new Event(TRACE_TOGGLE_REQUEST_EVENT));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activePage]);

  if (!bridge.booted) {
    return (
      <div className="app">
        <Titlebar isMaximized={windowState.maximized} nativeFrame={windowState.nativeFrame} />
        <div className="body">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, color: 'var(--quiet)', fontSize: 12 }}>
            加载中…
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Titlebar isMaximized={windowState.maximized} nativeFrame={windowState.nativeFrame} />
      <div className="body">
        <Rail activePage={activePage} onNavigate={setActivePage} updateState={bridge.updateState} />
        <div className="content-column">
          <ConnectionNotice />
          <div className="stage">
          <SignalPage active={activePage === 'signal'} />
          <ModelsPage active={activePage === 'models'} />
          <ToolsPage active={activePage === 'tools'} />
          <SettingsPage active={activePage === 'settings'} />
          </div>
        </div>
      </div>
      <OnboardingTour />
      <UpdateNotification />
    </div>
  );
}

export function App(): React.ReactElement {
  return (
    <ToastProvider position="bottom-right" timeout={3000} limit={1}>
      <BridgeProvider>
        <ConfirmDialogProvider><Shell /></ConfirmDialogProvider>
      </BridgeProvider>
    </ToastProvider>
  );
}
