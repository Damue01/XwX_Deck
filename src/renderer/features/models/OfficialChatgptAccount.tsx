import { AccountIdentity } from '../settings/AccountIdentity';
import { RefreshButton } from '@/components/ui/refresh-button';
import * as React from 'react';
import { useBridge } from '@/bridge/store';
import { t, useLanguage } from '@/lib/i18n';
import { RESTORE_CLIENT_CONFIG_EVENT } from '@/lib/toast';
import { ChatgptQuota } from './ChatgptQuota';
import type { SubscriptionAccount } from '../../../shared/subscriptionAccounts';

const cachedAccounts = new WeakMap<object, Map<string, SubscriptionAccount>>();
function remember(api: object, id: string, account: SubscriptionAccount | null): void {
  let cache = cachedAccounts.get(api);
  if (!cache) { cache = new Map(); cachedAccounts.set(api, cache); }
  if (account) cache.set(id, account); else cache.delete(id);
}

export function OfficialChatgptAccount({ active, manage = false, accountId }: { active: boolean; manage?: boolean; accountId?: string }): React.ReactElement {
  useLanguage();
  const bridge = useBridge();
  const targetId = accountId ?? 'official-chatgpt';
  const [loadedAccount, setAccount] = React.useState<SubscriptionAccount | null>(() => cachedAccounts.get(bridge.api)?.get(targetId) ?? null);
  const account = loadedAccount?.id === targetId ? loadedAccount : null;
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [switching, setSwitching] = React.useState(false);
  const sequence = React.useRef(0);
  const pending = React.useRef(false);
  const refresh = React.useCallback(async () => {
    if (!active || pending.current) return;
    const ticket = ++sequence.current;
    let identityChecked = false;
    pending.current = true; setBusy(true); setError('');
    const readLocal = async () => accountId && bridge.api.getSubscriptionAccounts
      ? (await bridge.api.getSubscriptionAccounts()).accounts.find(row => row.id === accountId)
      : await bridge.api.getOfficialChatgptAccount?.({ refresh: false });
    try {
      if (!bridge.api.getOfficialChatgptAccount) throw new Error(t('当前版本尚未接入官方额度，请更新桌面应用'));
      // Validate the current local identity and hydrate its display cache before network I/O.
      const cached = await readLocal();
      if (sequence.current !== ticket) return;
      identityChecked = true;
      remember(bridge.api, targetId, cached ?? null);
      setAccount(cached ?? null);
      if (!cached || cached.status !== 'connected') throw new Error(t('此账号已退出，请打开订阅账号重新登录'));
      const next = accountId && bridge.api.refreshSubscriptionUsage
        ? (await bridge.api.refreshSubscriptionUsage({ platform: 'chatgpt-official' })).accounts.find(account => account.id === accountId)
        : await bridge.api.getOfficialChatgptAccount();
      if (!next) throw new Error(t('此账号已退出，请打开订阅账号重新登录'));
      if (sequence.current === ticket) {
        remember(bridge.api, targetId, next);
        setAccount(next);
      }
    } catch (failure) {
      if (sequence.current !== ticket) return;
      // Login can change during the network read. Revalidate even on failure,
      // rather than keeping a previously valid account's allowance on screen.
      const current = identityChecked ? await readLocal().catch(() => undefined) : undefined;
      if (sequence.current === ticket) {
        remember(bridge.api, targetId, current ?? null);
        setAccount(current ?? null);
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      if (sequence.current === ticket) { pending.current = false; setBusy(false); }
    }
  }, [active, accountId, targetId, bridge.api]);
  React.useEffect(() => {
    if (active) {
      void refresh();
      window.addEventListener('focus', refresh);
    }
    return () => { sequence.current++; pending.current = false; window.removeEventListener('focus', refresh); };
  }, [active, refresh]);
  const useOfficial = () => {
    if (switching) return;
    setSwitching(true);
    // ModelsPage stays mounted in App and owns the latest choice, guarded writes
    // and repair UI. Reuse that path so a choice made here cannot leave it stale.
    window.dispatchEvent(new CustomEvent(RESTORE_CLIENT_CONFIG_EVENT, {
      detail: { client: 'codex', onComplete: () => setSwitching(false) }
    }));
  };
  return <section className="official-chatgpt-account" aria-label={t('ChatGPT 官方账号')}>
    <div className="official-chatgpt-heading">
      <AccountIdentity label={account?.label || account?.email || 'ChatGPT'} email={account?.email} />
      <RefreshButton className="provider-menu-trigger" label={t('刷新额度')} busy={busy} onClick={() => void refresh()} />
    </div>
    {account && <ChatgptQuota account={{ ...account, quotaError: error || account.quotaError }} loading={busy} />}
    {!account && error && <p className="provider-field-error" role="status">{error}</p>}
    {manage && <button type="button" className="btn" disabled={switching || !bridge.providers || bridge.providers.active.codex === null} onClick={() => void useOfficial()}>{t(switching ? '正在切换…' : bridge.providers?.active.codex === null ? '已选择官方服务' : '使用此账号')}</button>}
  </section>;
}
