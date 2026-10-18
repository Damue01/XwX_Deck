import * as React from 'react';
import { LogOut, Play, Square } from 'lucide-react';
import { applyLanguage, isLanguage, t, useLanguage } from '@/lib/i18n';
import { applyTheme, type Theme } from '@/lib/theme';

interface TrayState { enabled: boolean; busy: boolean; theme: Theme; language: string; }
interface NativeTray {
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
  event: { listen<T>(name: string, listener: (event: { payload: T }) => void): Promise<() => void> };
}
const native = (window as unknown as { __TAURI__: NativeTray }).__TAURI__;
const rpc = <T,>(action: string, enabled?: boolean) => native.core.invoke<T>('pilot_tray', { action, enabled });

/** A small native window hosts the same menu surface as the manager. */
export function TrayMenu(): React.ReactElement {
  useLanguage();
  const [state, setState] = React.useState<TrayState>();
  const [pending, setPending] = React.useState(false);
  const menu = React.useRef<HTMLDivElement>(null);
  const first = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    let disposed = false;
    const accept = (next: TrayState) => {
      if (disposed) return;
      if (isLanguage(next.language)) applyLanguage(next.language);
      applyTheme(next.theme);
      setState(next);
    };
    const refresh = () => { void rpc<TrayState>('state').then(accept).catch(() => {}); };
    const focus = () => { refresh(); requestAnimationFrame(() => (first.current?.disabled ? menu.current : first.current)?.focus()); };
    const subscription = native.event.listen<TrayState>('pilot-tray-state', event => accept(event.payload));
    window.addEventListener('focus', focus);
    refresh();
    return () => { disposed = true; window.removeEventListener('focus', focus); void subscription.then(unlisten => unlisten()); };
  }, []);
  React.useEffect(() => { if (state && !state.busy) first.current?.focus(); }, [state?.busy, !!state]);
  React.useEffect(() => { if (state) void rpc('ready').catch(() => {}); }, [!!state]);
  const choose = async (action: 'trace' | 'exit') => {
    if (!state || state.busy || pending) return;
    setPending(true);
    try { await rpc(action, action === 'trace' ? !state.enabled : undefined); }
    catch { const latest = await rpc<TrayState>('state').catch(() => undefined); if (latest) setState(latest); }
    finally { setPending(false); }
  };
  const keydown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); void rpc('hide'); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[target]?.focus();
  };
  const disabled = !state || state.busy || pending;
  return <div className="tray-menu-wrap">
    <div className="xwx-combobox-popup tray-menu" role="menu" aria-label="XwX Deck" ref={menu} tabIndex={-1} onKeyDown={keydown}>
      <button className="tray-menu-item" role="menuitem" ref={first} disabled={disabled} onClick={() => { void choose('trace'); }}>
        {state?.enabled ? <Square size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}<span>{t(state?.enabled ? '关闭 Trace' : '开启 Trace')}</span>
      </button>
      <button className="tray-menu-item" role="menuitem" disabled={disabled} onClick={() => { void choose('exit'); }}><LogOut size={14} aria-hidden="true" /><span>{t('退出')}</span></button>
    </div>
  </div>;
}
