// Theme management for XwX Deck. Two themes: 'day' (light) and 'night' (dark).
// Drives both our own tokens (html[data-theme]) and COSS components (html.dark).
//
// Main-process settings restore the theme at startup. After a local selection,
// that selection owns the current window; delayed runtime snapshots must not
// repaint it, including before the transition captures the old theme.
// localStorage is only an early-paint hint, never the live UI state.
import * as React from 'react';

export type Theme = 'day' | 'night';

const STORAGE_KEY = 'xwx-deck.theme';
type ThemeViewTransition = { ready: Promise<void>; finished: Promise<void>; skipTransition: () => void };
let activeTransition: ThemeViewTransition | null = null;
let themeChangeId = 0;
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

function changeTheme(theme: Theme, origin: HTMLElement | null | undefined, persist: (theme: Theme) => Promise<unknown>): void {
  const changeId = ++themeChangeId;
  requestedTheme = theme;
  activeTransition?.skipTransition();
  const root = document.documentElement;
  const status = (value: string) => {
    if (changeId === themeChangeId) root.dataset.themeTransitionStatus = value;
  };

  let committed = false;
  const commit = () => {
    if (changeId !== themeChangeId || committed) return;
    committed = true;
    paintTheme(theme);
    void persist(theme).catch(error => console.warn('[theme] Could not save the selected theme', error));
  };

  const skipReason = !origin ? 'missing-origin'
    : window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced-motion'
    : !document.startViewTransition ? 'unsupported'
    : undefined;
  if (!origin || skipReason) {
    status(skipReason ?? 'missing-origin');
    commit();
    return;
  }

  const bounds = origin.getBoundingClientRect();
  const x = bounds.left + bounds.width / 2;
  const y = bounds.top + bounds.height / 2;
  const radius = Math.max(
    Math.hypot(x, y),
    Math.hypot(window.innerWidth - x, y),
    Math.hypot(x, window.innerHeight - y),
    Math.hypot(window.innerWidth - x, window.innerHeight - y),
  );
  root.style.setProperty('--theme-reveal-x', `${x}px`);
  root.style.setProperty('--theme-reveal-y', `${y}px`);
  root.style.setProperty('--theme-reveal-radius', `${Math.ceil(radius) + 2}px`);
  root.dataset.themeTransition = 'circle';
  status('capturing');

  try {
    const transition = document.startViewTransition(commit);
    activeTransition = transition;
    void transition.ready.then(() => status('animating'), error => {
      if (changeId !== themeChangeId) return; // A newer click deliberately cancelled it.
      status('snapshot-failed');
      console.warn('[theme] Circular snapshot failed', error);
    });
    const cleanup = () => {
      if (activeTransition !== transition) return;
      activeTransition = null;
      delete root.dataset.themeTransition;
      if (root.dataset.themeTransitionStatus === 'animating') status('finished');
    };
    void transition.finished.then(cleanup, cleanup);
  } catch (error) {
    delete root.dataset.themeTransition;
    status('snapshot-failed');
    console.warn('[theme] Circular snapshot failed', error);
    commit();
  }
}

/**
 * React hook: current theme + setter, backed by the persistent main-process
 * store. Runtime restores the initial theme; this window's latest user choice
 * then takes priority over runtime echoes. Persistence never gates rendering.
 */
export function useTheme(
  authoritative: Theme | undefined,
  persist: (theme: Theme) => Promise<unknown>,
): [Theme, (t: Theme, origin?: HTMLElement | null) => void] {
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

  const setTheme = React.useCallback((t: Theme, origin?: HTMLElement | null) => {
    setThemeState(t);
    changeTheme(t, origin, persist);
  }, [persist]);

  return [theme, setTheme];
}
