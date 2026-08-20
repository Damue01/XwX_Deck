import * as React from 'react';
import { BridgeProvider, useBridge } from '@/bridge/store';
import { showToast, ToastProvider } from '@/lib/toast';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog';
import { Titlebar } from '@/features/shell/Titlebar';
import { Rail, type PageId } from '@/features/shell/Rail';
import { SignalPage, TRACE_TOGGLE_REQUEST_EVENT } from '@/features/trace/SignalPage';
import { ModelsPage } from '@/features/models/ModelsPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { OnboardingTour } from '@/features/onboarding/OnboardingTour';
import { UpdateNotification } from '@/features/shell/UpdateNotification';
import { applyTheme } from '@/lib/theme';

function Shell(): React.ReactElement {
  const bridge = useBridge();
  const [activePage, setActivePage] = React.useState<PageId>('signal');
  const [windowState, setWindowState] = React.useState({ maximized: false, fullscreen: false, nativeFrame: false });

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
    showToast(notice.message, notice.type ?? 'info');
  }), [bridge.api]);

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
        <div className="stage">
          <SignalPage active={activePage === 'signal'} />
          <ModelsPage active={activePage === 'models'} />
          <SettingsPage active={activePage === 'settings'} />
        </div>
      </div>
      <OnboardingTour />
      <UpdateNotification />
    </div>
  );
}

export function App(): React.ReactElement {
  return (
    <ToastProvider position="bottom-right" timeout={3000}>
      <BridgeProvider showToast={showToast}>
        <ConfirmDialogProvider>
          <Shell />
        </ConfirmDialogProvider>
      </BridgeProvider>
    </ToastProvider>
  );
}
