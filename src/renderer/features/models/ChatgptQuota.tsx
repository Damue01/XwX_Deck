import * as React from 'react';
import { Meter, MeterTrack, MeterIndicator } from '@/components/ui/meter';
import { t } from '@/lib/i18n';
import type { SubscriptionAccount } from '../../../shared/subscriptionAccounts';

const validRemaining = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
export function hasAccountQuota(account: SubscriptionAccount, summaryFallback = false): boolean {
  return !!account.quotaDetails?.windows.some(window => validRemaining(window.remainingPercent)) || summaryFallback && validRemaining(account.quota?.remainingPercent);
}

export function resetDate(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return '';
  const date = new Date(seconds * 1000);
  return new Intl.DateTimeFormat(undefined, { year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
export function ChatgptQuota({ account, children, summaryFallback = false, loading = false }: { account: SubscriptionAccount; children?: React.ReactNode; summaryFallback?: boolean; loading?: boolean }): React.ReactElement {
  let windows = (account.quotaDetails?.windows ?? []).filter(window => validRemaining(window.remainingPercent));
  // Other services currently provide a real aggregate only. Do not invent cycles.
  const quota = account.quota;
  if (summaryFallback && !windows.length && quota && validRemaining(quota.remainingPercent)) {
    windows = [{ limitId: '', window: 'summary', remainingPercent: quota.remainingPercent, usedPercent: 100 - quota.remainingPercent, resetsAt: quota.resetsAt, windowSeconds: null }];
  }
  return <div className="account-quota" data-window-count={windows.length} title={account.quotaCached ? t('上次读取的额度') : undefined}>
    {windows.map((window, index) => {
      const seconds = window.windowSeconds;
      const duration = seconds === 18000 ? t('5h 限额') : seconds === 604800 ? t('每周限额') : seconds && seconds > 0 && Number.isFinite(seconds) ? seconds % 86400 === 0 ? t('{0} 天', seconds / 86400) : seconds % 3600 === 0 ? t('{0} 小时', seconds / 3600) : seconds % 60 === 0 ? t('{0} 分钟', seconds / 60) : t('{0} 秒', seconds) : t('额度窗口');
      const bucket = window.normalModelSlug || window.limitName || window.limitId;
      const name = window.window === 'summary' ? t('套餐额度') : !bucket || window.limitId === 'codex' ? duration : `${bucket} ${duration}`;
      return <div className="quota-window" key={`${window.limitId}:${window.window}:${index}`}>
        <div className="quota-label"><span>{name}</span>{window.resetsAt ? <span className="quota-reset">{t('{0} 重置', resetDate(window.resetsAt))}</span> : null}</div>
        <Meter value={window.remainingPercent!} aria-label={`${account.label} ${name}`}><MeterTrack className="quota-track"><MeterIndicator className="quota-indicator" /></MeterTrack></Meter>
      </div>;
    })}
    {!windows.length && !account.quotaError && <p className="subscription-quota-empty" role="status">{t(loading ? '刷新中…' : '额度未知')}</p>}
    {account.quotaError && <p className="provider-field-error" role="status">{account.quotaError}</p>}
    {children}
  </div>;
}
