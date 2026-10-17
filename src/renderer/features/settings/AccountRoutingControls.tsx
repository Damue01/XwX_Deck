import * as React from 'react';
import { ChoiceSelect } from '@/components/ui/choice-select';
import { HelpLabel } from '@/components/ui/help-label';
import { t, useLanguage } from '@/lib/i18n';
import type { SubscriptionAccount, SubscriptionRoutingPolicy, SubscriptionStrategy } from '../../../shared/subscriptionAccounts';

const strategies: readonly { id: SubscriptionStrategy; label: string; help: string; quota?: boolean }[] = [
  { id: 'exhaust', label: '用完再换', help: '拖动调整顺序，优先使用排在前面的账号' },
  { id: 'balanced', label: '平衡使用', help: '拖动调整轮换顺序，所有账号依次使用' },
  { id: 'most-remaining', label: '剩余额度最多', help: '优先使用剩余额度最多的账号，同额度时按排序', quota: true },
  { id: 'reset-soon', label: '优先使用即将恢复', help: '优先使用即将恢复额度的账号，同时间时按排序', quota: true },
  { id: 'fixed', label: '固定账号', help: '选择一个固定账号，排序不影响使用' }
];

/** Shared strategy interaction for every subscription service and authorization group. */
export function AccountRoutingControls({ policy, accounts, disabled, quotaSupported = true, quotaAvailable = true, onChange }: {
  policy: SubscriptionRoutingPolicy; accounts: readonly SubscriptionAccount[]; disabled: boolean;
  quotaSupported?: boolean; quotaAvailable?: boolean; onChange: (next: SubscriptionRoutingPolicy) => void;
}): React.ReactElement {
  useLanguage();
  const strategy = strategies.find(item => item.id === policy.strategy)!;
  const help = t(!quotaSupported && strategy.quota ? '此授权不提供额度，暂按排序使用' : strategy.help);
  return <>
    <div className="chatgpt-policy"><HelpLabel help={help}>{t('账号策略')}</HelpLabel><ChoiceSelect label={t('账号策略')} value={policy.strategy} selectedLabel={t(strategy.label)} disabled={disabled}
      items={strategies.filter(item => ['exhaust', 'most-remaining'].includes(item.id) && (quotaSupported || !item.quota)).map(item => ({
        id: item.id, label: t(item.label), disabled: !!item.quota && !quotaAvailable,
        hint: item.quota && !quotaAvailable ? t('读取官方额度后可用') : undefined
      }))}
      onChange={id => onChange({ ...policy, strategy: id as SubscriptionStrategy,
        fixedAccountId: id === 'fixed' ? (accounts.some(account => account.id === policy.fixedAccountId) ? policy.fixedAccountId : '') || accounts.find(account => account.status === 'connected')?.id || accounts[0]?.id || '' : policy.fixedAccountId
      })} /></div>
    <span className="sr-only" id="subscription-order-help">{help}</span>
  </>;
}
