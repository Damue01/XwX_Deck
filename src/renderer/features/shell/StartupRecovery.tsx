import * as React from 'react';
import { t } from '@/lib/i18n';

export function StartupRecovery(): React.ReactElement {
  const message = (window as unknown as { __xwxRecoveryMessage?: string }).__xwxRecoveryMessage ?? t('无法启动，请检查应用数据和访问权限。');
  const close = () => { void (window as unknown as { __TAURI__: { core: { invoke(command: string, args: unknown): Promise<unknown> } } }).__TAURI__.core.invoke('recovery_action', { action: 'close' }); };
  React.useEffect(() => {
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, []);
  return <main className="recovery-window" role="alertdialog" aria-labelledby="recovery-title" aria-describedby="recovery-message">
    <header data-tauri-drag-region>XwX Deck</header>
    <section><h1 id="recovery-title">{t('XwX Deck 无法启动')}</h1><p id="recovery-message">{message}</p></section>
    <footer><button type="button" className="btn primary" autoFocus onClick={close}>{t('关闭')}</button></footer>
  </main>;
}
