import * as React from 'react';

/** UI-only preference: unavailable local storage must not block the controls. */
export function useRememberedExpansion(section: string): readonly [boolean, (open: boolean) => void] {
  const key = `xwx-deck:settings:${section}:expanded:v1`;
  const [open, setOpen] = React.useState(() => {
    try { return localStorage.getItem(key) !== 'false'; }
    catch { return true; }
  });
  const remember = React.useCallback((next: boolean) => {
    setOpen(next);
    try { localStorage.setItem(key, String(next)); }
    catch { /* The current session still retains the choice. */ }
  }, [key]);
  return [open, remember];
}
