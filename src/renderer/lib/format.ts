import { getLanguage, t } from '@/lib/i18n';
// Pure formatting helpers ported from src/main/trace/webview/common.ts.
// No DOM manipulation here — all functions are stateless and browser-environment-agnostic.

export function formatNumber(value: unknown, locale = getLanguage()): string {
  return Math.max(0, Math.round(Number(value) || 0)).toLocaleString(locale);
}

export function formatRate(value: unknown): string {
  const n = Math.max(0, Number(value) || 0);
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n));
}

export function formatTime(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value || ''));
  return Number.isFinite(date.getTime())
    ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    : '--:--';
}

export function formatDuration(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;
}

export interface CompactNumber {
  value: string;
  unit: string;
}

export function compactNumber(value: unknown): CompactNumber {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n >= 1e9) return { value: (n / 1e9).toFixed(2).replace(/\.?0+$/, ''), unit: 'B' };
  if (n >= 1e6) return { value: (n / 1e6).toFixed(2).replace(/\.?0+$/, ''), unit: 'M' };
  if (n >= 1e3) return { value: (n / 1e3).toFixed(1).replace(/\.?0+$/, ''), unit: 'K' };
  return { value: String(n), unit: '' };
}

export interface TokenCostPresentation {
  label: string;
  value: string;
  unit: string;
  toggleHint: string;
}

export function tokenCostPresentation(options: {
  showCost: boolean;
  tokens: unknown;
  costUsd: unknown;
  language?: 'zh' | 'en';
  compact?: boolean;
}): TokenCostPresentation {
  const english = options.language === 'en';
  if (options.showCost) {
    return {
      label: 'USD',
      value: Number(options.costUsd || 0).toFixed(2),
      unit: '$',
      toggleHint: english ? 'Show Token usage' : t('点击查看 Token 使用量')
    };
  }
  const n = options.compact ? compactNumber(options.tokens) : { value: formatNumber(options.tokens), unit: '' };
  return {
    label: 'TOKENS',
    value: n.value,
    unit: n.unit,
    toggleHint: english ? 'Show estimated cost' : t('点击查看费用')
  };
}

export function readoutRange(text: string): 'normal' | 'wide' | 'extra-wide' {
  const len = text.length;
  if (len >= 16) return 'extra-wide';
  if (len >= 12) return 'wide';
  return 'normal';
}
