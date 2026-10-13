import * as React from 'react';
import { ArrowLeft, ChevronRight, Ellipsis, Plus, RefreshCw } from 'lucide-react';
import { Menu } from '@base-ui/react/menu';
import { Tabs, TabsList, TabsTab, TabsPanel } from '@/components/ui/tabs';
import { AccountRoutingControls } from './AccountRoutingControls';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useBridge } from '@/bridge/store';
import { t, useLanguage } from '@/lib/i18n';
import { showErrorToast, showToast } from '@/lib/toast';
import type { SubscriptionAccount, SubscriptionAccountsSnapshot, SubscriptionRoutingGroup, SubscriptionRoutingPolicy } from '../../../shared/subscriptionAccounts';
import { ChatgptQuota, resetDate } from '../models/ChatgptQuota';
import { ProviderIcon } from './ProviderIcon';
import { SortableAccounts } from './SortableAccounts';
import { useSubscriptionPolicies } from './useSubscriptionPolicies';

const fallback: SubscriptionRoutingPolicy = { strategy: 'exhaust', fixedAccountId: '', excludedAccountIds: [] };
export function ChatgptAccounts({ visible, snapshot, setSnapshot, busy, begin, cancel }: {
  visible: boolean; snapshot: SubscriptionAccountsSnapshot | null;
  setSnapshot: (next: SubscriptionAccountsSnapshot) => void; busy: boolean;
  begin: (group: SubscriptionRoutingGroup, id?: string) => void; cancel: () => void;
}): React.ReactElement {
  useLanguage(); const bridge = useBridge(); const confirm = useConfirm();
  const [tab, setTab] = React.useState<'official' | 'api'>('official');
  const group = tab === 'official' ? 'chatgpt-official' : 'chatgpt';
  const policies = useSubscriptionPolicies(bridge.api, setSnapshot);
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const policy = policies.drafts[group] ?? snapshot?.routing?.[group] ?? fallback;
  const accounts = (snapshot?.accounts ?? []).filter(account => (account.platform ?? 'chatgpt') === 'chatgpt' && (account.authKind === 'official' || account.id.startsWith('official-chatgpt')) === (tab === 'official'));
  const order = policy.accountOrder ?? [];
  const ordered = [...accounts].sort((a, b) => (order.includes(a.id) ? order.indexOf(a.id) : order.length) - (order.includes(b.id) ? order.indexOf(b.id) : order.length));
  const [expanded, setExpanded] = React.useState<string | null | undefined>();
  const expandedId = expanded === undefined ? ordered[0]?.id : expanded;
  React.useEffect(() => {
    if (tab === 'official' && ordered[0] && (expanded === undefined || expanded !== null && !ordered.some(account => account.id === expanded))) setExpanded(ordered[0].id);
  }, [tab, ordered, expanded]);
  const flow = snapshot?.flow;
  const waiting = !!flow && ['waiting', 'exchanging'].includes(flow.status);
  const flowHere = (flow?.platform ?? 'chatgpt') === 'chatgpt' && (flow?.authKind === 'official') === (tab === 'official');
  const [refreshing, setRefreshing] = React.useState(false);
  const refreshLock = React.useRef(false), refreshSequence = React.useRef(0);
  const [error, setError] = React.useState('');
  const [resetAccount, setResetAccount] = React.useState<SubscriptionAccount | null>(null);
  const [creditId, setCreditId] = React.useState('');
  const [confirmCredit, setConfirmCredit] = React.useState(false);
  const [resetBusy, setResetBusy] = React.useState(false);
  const redemption = React.useRef<{ accountId: string; creditId: string; key: string } | null>(null);
  const resetLock = React.useRef(false);
  const credits = (resetAccount?.quotaDetails?.resetCredits ?? []).filter(credit => credit.status === 'available' && (!credit.expiresAt || credit.expiresAt > Date.now() / 1000));
  const chosen = credits.find(credit => credit.id === creditId);

  const save = (next: SubscriptionRoutingPolicy) => {
    // Every registration participates. Signing out remains an explicit separate action.
    const requested = next.accountOrder ?? ordered.map(account => account.id);
    const currentIds = new Set(accounts.map(account => account.id));
    const accountOrder = [...new Set([...requested.filter(id => currentIds.has(id)), ...ordered.map(account => account.id)])];
    const desired = { ...next, excludedAccountIds: [], accountOrder };
    policies.save(group, desired);
  };
  React.useEffect(() => {
    // Adopt the approved all-account list once, retaining the existing strategy
    // and fixed choice. Old hidden pause flags must not contradict this page.
    if (visible && accounts.length && !policies.drafts[group] && (!policy.accountOrder?.length || policy.excludedAccountIds.length)) {
      policies.save(group, { ...policy, excludedAccountIds: [], accountOrder: ordered.map(account => account.id) });
    }
  }, [visible, group, accounts, ordered, policy, policies]);
  const refresh = React.useCallback(async () => {
    if (!visible || tab !== 'official' || refreshLock.current || !bridge.api.refreshSubscriptionUsage) return;
    refreshLock.current = true; const ticket = ++refreshSequence.current; setRefreshing(true); setError('');
    try {
      const next = await bridge.api.refreshSubscriptionUsage({ platform: 'chatgpt-official' });
      if (mounted.current && ticket === refreshSequence.current) setSnapshot(next);
    } catch (failure) { if (mounted.current && ticket === refreshSequence.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (ticket === refreshSequence.current) { refreshLock.current = false; if (mounted.current) setRefreshing(false); } }
  }, [visible, tab, bridge.api, setSnapshot]);
  const officialIds = (snapshot?.accounts ?? []).filter(account => account.status === 'connected' && (account.authKind === 'official' || account.id.startsWith('official-chatgpt'))).map(account => account.id).sort().join('|');
  React.useEffect(() => {
    if (officialIds) void refresh();
    const focus = () => { if (officialIds) void refresh(); };
    window.addEventListener('focus', focus);
    return () => { refreshSequence.current++; refreshLock.current = false; window.removeEventListener('focus', focus); };
  }, [refresh, officialIds]);
  const openCredits = async (account: SubscriptionAccount) => {
    if (resetLock.current) return;
    resetLock.current = true; setResetBusy(true); setResetAccount(account); setCreditId(''); setConfirmCredit(false); setError(''); redemption.current = null;
    try {
      if (!bridge.api.getOfficialChatgptResetCredits) throw new Error(t('请更新桌面应用后读取重置卡'));
      const next = await bridge.api.getOfficialChatgptResetCredits(account.id);
      if (mounted.current) setResetAccount(next);
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { resetLock.current = false; if (mounted.current) setResetBusy(false); }
  };
  const consume = async () => {
    if (!resetAccount || !chosen || resetLock.current) return;
    resetLock.current = true; setResetBusy(true); setError('');
    try {
      if (!bridge.api.consumeOfficialChatgptResetCredit) throw new Error(t('请更新桌面应用后使用重置卡'));
      if (!redemption.current || redemption.current.accountId !== resetAccount.id || redemption.current.creditId !== chosen.id) redemption.current = { accountId: resetAccount.id, creditId: chosen.id, key: crypto.randomUUID() };
      const result = await bridge.api.consumeOfficialChatgptResetCredit({ accountId: resetAccount.id, accountKey: resetAccount.accountKey ?? '', creditId: chosen.id, idempotencyKey: redemption.current.key });
      if (['reset', 'alreadyRedeemed'].includes(result.outcome)) {
        showToast(t('额度已重置'), 'success'); if (mounted.current) setResetAccount(null); await refresh();
      } else { if (mounted.current) setError(t(result.outcome === 'nothingToReset' ? '当前额度无需重置' : '这张重置卡已不可用，请重新选择')); }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { resetLock.current = false; if (mounted.current) setResetBusy(false); }
  };
  const signOut = async (account: SubscriptionAccount) => {
    if (!await confirm({ title: t(account.importedLogin ? '移除 {0}？' : '退出 {0}？', account.label), body: account.importedLogin ? t('仅解除 Deck 与来源账号的关联，原应用的登录不受影响。') : account.externalLogin ? t('这会清除本机共享的官方登录凭据，使用此登录的客户端需要重新登录。其他独立账号不受影响。') : t('此账号将退出。正在进行的回复可能继续；新请求按账号策略选择。'), confirmText: t(account.importedLogin ? '移除账号' : '退出登录'), tone: 'danger' })) return;
    try { if (!bridge.api.signOutSubscriptionAccount) throw new Error(t('当前版本不支持退出此账号')); const result = await bridge.api.signOutSubscriptionAccount(account.externalLogin ? { accountId: account.id, accountKey: account.accountKey ?? '' } : account.id); if (result.warning) showToast(result.warning, 'info'); else showToast(t(account.importedLogin ? '账号已移除' : '账号已退出'), 'success'); setSnapshot(await bridge.api.getSubscriptionAccounts?.() ?? { accounts: [] }); }
    catch (failure) { showErrorToast(t('退出登录未完成'), failure); }
  };

  if (resetAccount) return <>
    <button type="button" className="provider-text-action reset-back" disabled={resetBusy} onClick={() => { setResetAccount(null); setError(''); }}><ArrowLeft size={15} />{t('返回账号')}</button>
    <div className="configuration-detail-heading"><h3>{t(confirmCredit ? '确认使用重置卡' : '使用重置卡')}</h3></div>
    <div className="reset-identity"><strong title={resetAccount.label}>{resetAccount.label}</strong>{resetAccount.email && resetAccount.email !== resetAccount.label && <span title={resetAccount.email}>{resetAccount.email}</span>}</div>
    {confirmCredit && chosen ? <>
      <div className="reset-summary"><strong>{chosen.expiresAt ? t('{0} 失效', resetDate(chosen.expiresAt)) : t('未提供失效时间')}</strong><span>{chosen.title || t('额度重置卡')}</span></div>
      <div className="reset-actions"><button type="button" className="btn" disabled={resetBusy} onClick={() => setConfirmCredit(false)}>{t('重新选择')}</button><button type="button" className="btn" disabled={resetBusy} onClick={() => void consume()}>{t(resetBusy ? '正在使用…' : '确认使用')}</button></div>
    </> : <>
      <p className="reset-label">{t(resetBusy ? '正在读取重置卡…' : credits.length ? '选择重置卡' : '暂无可用重置卡')}</p>
      <div className="reset-cards" role="radiogroup" aria-label={t('选择重置卡')}>{credits.map(credit => <label className="reset-card" key={credit.id}><input type="radio" name="chatgpt-reset-credit" checked={creditId === credit.id} disabled={resetBusy} onChange={() => { setCreditId(credit.id); redemption.current = null; }} /><span><strong>{credit.expiresAt ? t('{0} 失效', resetDate(credit.expiresAt)) : t('未提供失效时间')}</strong><small>{credit.title || t('额度重置卡')}</small></span></label>)}</div>
      <div className="reset-actions"><button type="button" className="btn" disabled={resetBusy} onClick={() => void openCredits(resetAccount)}>{t('重试读取')}</button><button type="button" className="btn" disabled={!chosen || resetBusy} onClick={() => setConfirmCredit(true)}>{t('继续')}</button></div>
    </>}
    {error && <p className="provider-field-error" role="alert">{error}</p>}
  </>;
  return <>
    <div className="configuration-detail-heading"><h3><ProviderIcon kind="chatgpt" />ChatGPT</h3>{tab === 'official' && officialIds && <button type="button" className="provider-menu-trigger" aria-label={t('刷新额度')} title={t('刷新额度')} disabled={refreshing} aria-busy={refreshing} onClick={() => void refresh()}><RefreshCw size={16} /></button>}</div>
    <Tabs value={tab} onValueChange={value => { setTab(value as 'official' | 'api'); setError(''); }}>
      <TabsList aria-label={t('授权方式')}><TabsTab value="official">{t('官方账号登录')}</TabsTab><TabsTab value="api">{t('API 授权')}</TabsTab></TabsList>
      {accounts.length > 0 && <AccountRoutingControls policy={policy} accounts={ordered} disabled={!bridge.api.setSubscriptionRouting} quotaSupported={tab === 'official'} onChange={save} />}
      {policies.errors[group] && <p className="provider-field-error" role="status">{policies.errors[group]} <button type="button" className="provider-text-action" onClick={() => policies.retry(group)}>{t('重试保存')}</button></p>}
      {(['official', 'api'] as const).map(kind => <TabsPanel value={kind} key={kind}>
        {tab === kind && <SortableAccounts accounts={ordered} disabled={busy || waiting} onOrder={ids => save({ ...policy, accountOrder: ids })}>{(account, handle) => <>
          <div className="chatgpt-account-heading">{handle}
            {kind === 'official' ? <button type="button" className="account-disclosure" aria-expanded={expandedId === account.id} aria-controls={`quota-${account.id}`} onClick={() => setExpanded(expandedId === account.id ? null : account.id)}><span className="subscription-account-identity"><strong title={account.label}>{account.label}</strong>{account.email && account.email !== account.label && <span title={account.email}>{account.email}</span>}</span><ChevronRight className="disclosure-chevron" aria-hidden="true" /></button> : <div className="subscription-account-identity"><strong title={account.label}>{account.label}</strong>{account.email && account.email !== account.label && <span title={account.email}>{account.email}</span>}</div>}
            {policy.strategy === 'fixed' && <input className="account-selection" type="radio" name={`fixed-${kind}`} aria-label={t('固定使用 {0}', account.label)} checked={policy.fixedAccountId === account.id} disabled={busy || account.status !== 'connected'} onChange={() => save({ ...policy, fixedAccountId: account.id })} />}
            {!account.externalLogin && !account.importedLogin && (account.status !== 'connected' || account.routingStatus === '需重新登录') && <button type="button" className="provider-text-action" disabled={busy || waiting} onClick={() => begin(group, account.id)}>{t('登录')}</button>}
            {<Menu.Root><Menu.Trigger type="button" className="provider-menu-trigger" aria-label={t('{0} 的更多操作', account.label)} disabled={busy || waiting}><Ellipsis size={16} /></Menu.Trigger><Menu.Portal><Menu.Positioner className="conversation-header-menu-positioner" side="bottom" align="end" sideOffset={4}><Menu.Popup className="conversation-header-menu provider-menu"><Menu.Item className="conversation-header-menu-item" onClick={() => void signOut(account)}>{t(account.importedLogin ? '移除账号' : '退出登录')}</Menu.Item></Menu.Popup></Menu.Positioner></Menu.Portal></Menu.Root>}
          </div>
          {account.importedLogin && account.sourceError && <p className="provider-field-error" role="status">{account.sourceError} <button type="button" className="provider-text-action" onClick={() => void bridge.api.getSubscriptionAccounts?.().then(setSnapshot).catch(failure => showErrorToast(t('重新检测失败'), failure))}>{t('重新检测')}</button></p>}
          {kind === 'official' && expandedId === account.id && <div id={`quota-${account.id}`}><ChatgptQuota account={account}>{(account.quotaDetails?.availableResetCredits ?? 0) > 0 && <button type="button" className="provider-text-action reset-entry" onClick={() => void openCredits(account)}>{t('使用重置卡')}<span className="credit-count">{account.quotaDetails!.availableResetCredits}</span></button>}</ChatgptQuota></div>}
        </>}</SortableAccounts>}
        {tab === kind && (waiting && flowHere ? <div className="subscription-login-progress" role="status"><span>{t('请在浏览器中完成登录与授权')}</span><button type="button" className="provider-text-action" onClick={cancel}>{t('取消')}</button></div> : kind === 'official' && snapshot?.officialLoginInstalled === false ? <button type="button" className="btn subscription-login-button" onClick={() => void bridge.api.openSetupWebsite('download-codex-cli').catch(failure => showErrorToast(t('打开官方页面失败'), failure))}>{t('安装 Codex CLI')}</button> : <button type="button" className="btn subscription-login-button" disabled={busy || waiting || snapshot?.supported === false} onClick={() => begin(group)}><Plus size={15} />{t(kind === 'official' ? '添加账号' : '添加授权')}</button>)}
      </TabsPanel>)}
    </Tabs>
    {(error || flow?.status === 'failed' && flowHere && flow.error) && <p className="provider-field-error" role="alert">{error || flow?.error}</p>}
  </>;
}
