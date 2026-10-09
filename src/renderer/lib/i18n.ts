import * as React from 'react';
import { english } from './locales/en';
export type Language = 'zh-CN' | 'en';
export function isLanguage(value: unknown): value is Language { return value === 'zh-CN' || value === 'en'; }
const storageKey = 'xwx-deck.language';
const listeners = new Set<() => void>();
export function systemLanguage(languages: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages ?? []): Language {
  return (languages[0] ?? (typeof navigator === 'undefined' ? 'en' : navigator.language)).toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}
let language: Language = typeof document === 'undefined' ? 'zh-CN' : systemLanguage();
try { const hint = localStorage.getItem(storageKey); if (isLanguage(hint)) language = hint; } catch { /* Runtime settings remain authoritative. */ }
let locallyChosen = false;
export function getLanguage(): Language { return language; }
export function applyLanguage(next: Language): void {
  language = next;
  document.documentElement.lang = next;
  try { localStorage.setItem(storageKey, next); } catch { /* No storage must not block switching. */ }
  for (const notify of listeners) notify();
}
export function restoreLanguage(saved: Language | undefined): void {
  if (!locallyChosen) applyLanguage(saved ?? systemLanguage());
}
/** Explicit choices persist in native settings; local storage is an early paint hint. */
export async function changeLanguage(next: Language, persist: (next: Language) => Promise<unknown>): Promise<void> {
  const before = language;
  locallyChosen = true;
  applyLanguage(next);
  try { await persist(next); }
  catch (error) { applyLanguage(before); throw error; }
}
function subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
export function useLanguage(): Language { return React.useSyncExternalStore(subscribe, getLanguage); }
/** Translate product copy only, never model IDs, configuration names or credentials. */
export function t(message: string, ...values: readonly unknown[]): string {
  const template = language === 'en' ? english[message] ?? message : message;
  return template.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < values.length ? String(values[Number(index)]) : match);
}
