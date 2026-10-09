// Theme management for XwX Deck. Two themes: 'day' (light) and 'night' (dark).
// Drives both our own tokens (html[data-theme]) and COSS components (html.dark).
//
// Main-process settings restore the theme at startup. After a local selection,
// that selection owns the current window; delayed runtime snapshots must not
// repaint it, including while preferences are being saved.
// localStorage is only an early-paint hint, never the live UI state.
import * as React from 'react';

export type Theme = 'day' | 'night';

const STORAGE_KEY = 'xwx-deck.theme';
let themeChangeId = 0;
let pendingPersistence: Promise<unknown> = Promise.resolve();
let requestedTheme: Theme | undefined;
let currentTheme: Theme | undefined;

/** Early-paint hint only; the runtime state overrides this once the bridge boots. */
export function getStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'day' || v === 'night') return v;
  } catch { /* ignore */ }
  return 'day';
}

export function applyTheme(theme: Theme): void {
  if (requestedTheme !== undefined) return;
  paintTheme(theme);
}

function paintTheme(theme: Theme): void {
  currentTheme = theme;
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

function changeTheme(theme: Theme, persist: (theme: Theme) => Promise<unknown>): void {
  const changeId = ++themeChangeId;
  requestedTheme = theme;
  // Whole-page snapshots can swallow rapid clicks. Paint immediately and keep
  // only the local switch motion; saving must never block an interaction.
  paintTheme(theme);
  pendingPersistence = pendingPersistence.then(() => {
    if (changeId !== themeChangeId) return;
    return persist(theme);
  }).catch(error => console.warn('[theme] Could not save the selected theme', error));
}

/**
 * React hook: current theme + setter, backed by the persistent main-process
 * store. Runtime restores the initial theme; this window's latest user choice
 * then takes priority over runtime echoes. Persistence never gates rendering.
 */
export function useTheme(
  authoritative: Theme | undefined,
  persist: (theme: Theme) => Promise<unknown>,
): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = React.useState<Theme>(() => currentTheme ?? getStoredTheme());

  React.useEffect(() => {
    if (authoritative) applyTheme(authoritative);
  }, [authoritative]);

  React.useEffect(() => {
    const onChange = () => setThemeState(currentTheme ?? getStoredTheme());
    document.addEventListener('xwx:themechange', onChange);
    onChange();
    return () => document.removeEventListener('xwx:themechange', onChange);
  }, []);

  const setTheme = React.useCallback((t: Theme) => {
    setThemeState(t);
    changeTheme(t, persist);
  }, [persist]);

  return [theme, setTheme];
}
