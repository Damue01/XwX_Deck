import * as React from 'react';
import { english } from './locales/en';
import traditional from './locales/zh-TW.json';
import japanese from './locales/ja.json';
import korean from './locales/ko.json';
import french from './locales/fr.json';
import german from './locales/de.json';
import spanish from './locales/es.json';
import portuguese from './locales/pt-BR.json';

export const LANGUAGES = [
  { id: 'zh-CN', name: '简体中文' }, { id: 'zh-TW', name: '繁體中文' },
  { id: 'en', name: 'English' }, { id: 'ja', name: '日本語' },
  { id: 'ko', name: '한국어' }, { id: 'fr', name: 'Français' },
  { id: 'de', name: 'Deutsch' }, { id: 'es', name: 'Español' },
  { id: 'pt-BR', name: 'Português (Brasil)' },
] as const;
export type Language = typeof LANGUAGES[number]['id'];
export function isLanguage(value: unknown): value is Language { return LANGUAGES.some(item => item.id === value); }
const dictionaries: Partial<Record<Language, Readonly<Record<string, string>>>> = {
  en: english, 'zh-TW': traditional, ja: japanese, ko: korean,
  fr: french, de: german, es: spanish, 'pt-BR': portuguese,
};
const storageKey = 'xwx-deck.language';
const listeners = new Set<() => void>();
export function systemLanguage(languages: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages ?? []): Language {
  for (const locale of languages.length ? languages : [typeof navigator === 'undefined' ? 'en' : navigator.language]) {
    const tag = locale.trim().split('.')[0].toLowerCase().replaceAll('_', '-');
    if (tag.startsWith('zh')) return tag.includes('hans') ? 'zh-CN' : /hant|\b(tw|hk|mo)\b/.test(tag) ? 'zh-TW' : 'zh-CN';
    if (tag.startsWith('pt')) return 'pt-BR';
    const base = tag.split('-')[0];
    if (isLanguage(base)) return base;
  }
  return 'en';
}
let language: Language = typeof document === 'undefined' ? 'zh-CN' : systemLanguage();
try { const hint = localStorage.getItem(storageKey); if (isLanguage(hint)) language = hint; } catch { /* Runtime settings remain authoritative. */ }
let locallyChosen = false;
export function getLanguage(): Language { return language; }
export function applyLanguage(next: Language): void {
  language = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  try { localStorage.setItem(storageKey, next); } catch { /* No storage must not block switching. */ }
  for (const notify of listeners) notify();
}
export function restoreLanguage(saved: Language | undefined): void {
  if (!locallyChosen) applyLanguage(isLanguage(saved) ? saved : systemLanguage());
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
  const template = language === 'zh-CN' ? message : dictionaries[language]?.[message] ?? english[message] ?? message;
  return template.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < values.length ? String(values[Number(index)]) : match);
}
