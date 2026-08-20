import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Navigate the shell to a page (used by cross-page flows like the 兼容服务 guard). */
export function navigateTo(page: 'signal' | 'models' | 'sync' | 'tools' | 'settings'): void {
  window.dispatchEvent(new CustomEvent('xwxdeck:navigate', { detail: page }));
}

export function hostFromUrl(value: string): string {
  try { return new URL(value).host; } catch { return ''; }
}

export function isValidServiceUrl(value: string): boolean {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}
