// Theme management for XwX Deck. Two themes: 'day' (light) and 'night' (dark).
// Drives both our own tokens (html[data-theme]) and COSS components (html.dark).
//
// The authoritative store is the main-process settings.json, delivered via
// runtime state. localStorage is kept only as an early-paint hint so the first
// frame does not flash the wrong theme before the bridge boots — it is NOT the
// source of truth (a portable repackage changes the file:// origin and drops
// it, which is exactly the bug this indirection avoids).
import * as React from 'react';

export type Theme = 'day' | 'night';

const STORAGE_KEY = 'xwx-deck.theme';

/** Early-paint hint only; the runtime state overrides this once the bridge boots. */
export function getStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'day' || v === 'night') return v;
  } catch { /* ignore */ }
  return 'day';
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle('dark', theme === 'night');
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* ignore */ }
  document.dispatchEvent(new Event('xwx:themechange'));
}

/** Apply the early-paint hint as soon as possible (called from main entry). */
export function initTheme(): void {
  applyTheme(getStoredTheme());
}

/**
 * React hook: current theme + setter, backed by the persistent main-process
 * store. `persist` is invoked to write settings.json (via the bridge); the DOM
 * is updated optimistically and reconciled when runtime state arrives.
 */
export function useTheme(
  authoritative: Theme | undefined,
  persist: (theme: Theme) => Promise<unknown>,
): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = React.useState<Theme>(getStoredTheme);

  // Reconcile with the authoritative value delivered by runtime state.
  React.useEffect(() => {
    if (authoritative && authoritative !== theme) {
      setThemeState(authoritative);
      applyTheme(authoritative);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authoritative]);

  React.useEffect(() => {
    const onChange = () => setThemeState(getStoredTheme());
    document.addEventListener('xwx:themechange', onChange);
    return () => document.removeEventListener('xwx:themechange', onChange);
  }, []);

  const setTheme = React.useCallback((t: Theme) => {
    applyTheme(t);
    void persist(t).catch(() => { /* runtime state stays the fallback */ });
  }, [persist]);

  return [theme, setTheme];
}
