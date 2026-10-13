import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import { Menu } from '@base-ui/react/menu';
import { ArrowLeft, ArrowUpRight, Check, ChevronRight, Ellipsis, Plus, RefreshCw, X } from 'lucide-react';
import { useBridge } from '@/bridge/store';
import { subscriptionServiceNames } from '@/lib/subscriptionServices';
import { showErrorToast, showToast } from '@/lib/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import type { SubscriptionAccountsSnapshot, SubscriptionRoutingPolicy } from '../../../shared/subscriptionAccounts';
import { ProviderIcon } from './ProviderIcon';
import { ChatgptAccounts } from './ChatgptAccounts';
import { AccountRoutingControls } from './AccountRoutingControls';
import { SortableAccounts } from './SortableAccounts';
import { useSubscriptionPolicies } from './useSubscriptionPolicies';
import { ChatgptQuota, hasAccountQuota } from '../models/ChatgptQuota';
import type { SubscriptionRoutingGroup } from '../../../shared/subscriptionAccounts';

const OPTIONS = [
  { id: 'chatgpt', label: 'ChatGPT', icon: 'chatgpt' },
  { id: 'grok', label: 'Grok', icon: 'xai' },
  { id: 'claude', label: 'Claude', icon: 'claude' },
  { id: 'copilot', label: 'GitHub Copilot', icon: 'copilot' },
  { id: 'cursor', label: 'Cursor', icon: 'cursor' }
] as const;

const cachedSnapshots = new WeakMap<object, SubscriptionAccountsSnapshot>();

export function SubscriptionAccountsPanel({ visible, open, initialPlatform = null, embedded = false }: { visible: boolean; open: boolean; embedded?: boolean; initialPlatform?: 'chatgpt' | 'grok' | 'copilot' | 'claude' | 'cursor' | null }): React.ReactElement {
  useLanguage();
  const bridge = useBridge();
  const confirm = useConfirm();
  const [platform, setPlatform] = React.useState<'chatgpt' | 'grok' | 'copilot' | 'claude' | 'cursor' | null>(initialPlatform);
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (open && !wasOpen.current) { setPlatform(initialPlatform); setRenaming(null); }
    wasOpen.current = open;
  }, [open, initialPlatform]);
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [label, setLabel] = React.useState('');
  const lock = React.useRef(false);
  const platformInfo = OPTIONS.find(item => item.id === platform)!;
  const [snapshot, setSnapshot] = React.useState<SubscriptionAccountsSnapshot | null>(() => {
    const cached = cachedSnapshots.get(bridge.api);
    return cached ? { ...cached, flow: null } : null;
  });
  React.useEffect(() => { if (snapshot) cachedSnapshots.set(bridge.api, snapshot); }, [bridge.api, snapshot]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const generation = React.useRef(0);
  const revision = React.useRef(0);
  const connected = React.useRef(new Set<string>());
  const pendingSignIn = React.useRef(new Set<string>());
  const waiting = snapshot?.flow?.status === 'waiting' || snapshot?.flow?.status === 'exchanging';
  const acceptSnapshot = React.useCallback((next: SubscriptionAccountsSnapshot) => {
    if (lock.current) return;
    setSnapshot(current => {
      const flow = current?.flow;
      if (flow && (['waiting', 'exchanging'].includes(flow.status) && flow.id !== next.flow?.id || flow.id === next.flow?.id && ['complete', 'failed', 'cancelled'].includes(flow.status) && ['waiting', 'exchanging'].includes(next.flow?.status ?? ''))) return { ...next, flow };
      return next;
    });
  }, []);
  React.useEffect(() => {
    if (!visible) return;
    const current = ++generation.current;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const observedRevision = revision.current;
        const next = await bridge.api.getSubscriptionAccounts?.();
        if (generation.current !== current) return;
        if (!lock.current && revision.current === observedRevision) { acceptSnapshot(next ?? { supported: false, accounts: [] }); setError(''); }
        if (next?.flow && ['waiting', 'exchanging'].includes(next.flow.status)) pendingSignIn.current.add(next.flow.id);
        if (next?.flow?.status === 'complete' && next.flow.accountId && !connected.current.has(next.flow.id)) {
          connected.current.add(next.flow.id);
          try {
            const currentProviders = await bridge.api.getProviders();
            const exists = currentProviders.connections.some(provider => provider.subscriptionAccountId === next.flow?.accountId);
            if (!exists || pendingSignIn.current.has(next.flow.id)) {
            const providers = await bridge.api.connectSubscriptionAccount?.(next.flow.accountId);
            if (generation.current !== current) return;
            if (providers) bridge.patch({ providers });
            if (!exists) showToast(t('订阅账号已添加'), 'success');
            }
          } catch (failure) { connected.current.delete(next.flow.id); throw failure; }
        }
      } catch (failure) { if (generation.current === current) setError(failure instanceof Error ? failure.message : String(failure)); }
      if (generation.current === current) timer = setTimeout(refresh, 1500);
    };
    void refresh();
    return () => { generation.current++; clearTimeout(timer); };
  }, [visible, bridge.api, bridge.patch, acceptSnapshot]);
  const run = async (operation: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; revision.current++; setBusy(true); setError('');
    try { await operation(); } catch (failure) { showErrorToast(t('账号操作未完成'), failure); }
    finally { revision.current++; lock.current = false; setBusy(false); }
  };
  const begin = (accountId?: string, group?: SubscriptionRoutingGroup) => void run(async () => {
    if (!platform) return;
    if (!bridge.api.beginSubscriptionSignIn) throw new Error(t('请在 Rust 桌面应用中添加订阅账号'));
    const next = await bridge.api.beginSubscriptionSignIn({ accountId, platform: group ?? platform });
    if (next.flow) pendingSignIn.current.add(next.flow.id);
    setSnapshot(next);
  });
  const accounts = snapshot?.accounts.filter(account => (account.platform ?? 'chatgpt') === platform) ?? [];
  const policies = useSubscriptionPolicies(bridge.api, acceptSnapshot);
  const policy: SubscriptionRoutingPolicy = (platform ? policies.drafts[platform] ?? snapshot?.routing?.[platform] : undefined) ?? { strategy: 'exhaust', fixedAccountId: '', excludedAccountIds: [] };
  const order = policy.accountOrder ?? [];
  const ordered = [...accounts].sort((a, b) => (order.includes(a.id) ? order.indexOf(a.id) : order.length) - (order.includes(b.id) ? order.indexOf(b.id) : order.length));
  const [expanded, setExpanded] = React.useState<Partial<Record<SubscriptionRoutingGroup, string | null>>>({});
  const expandedId = platform && expanded[platform] !== undefined ? expanded[platform] : ordered[0]?.id;
  React.useEffect(() => {
    if (platform && ordered[0] && (expanded[platform] === undefined || expanded[platform] !== null && !ordered.some(account => account.id === expanded[platform]))) {
      setExpanded(current => ({ ...current, [platform]: ordered[0].id }));
    }
  }, [platform, ordered, expanded]);
  const flowHere = (snapshot?.flow?.platform ?? 'chatgpt') === platform;
  // SiWC accounts use the public Responses API, not the Codex WHAM grant.
  // Keep the API tab free of Codex quota probes and unsupported usage controls.
  const supportsUsage = platform !== 'chatgpt';
  const hasQuota = supportsUsage && accounts.some(account => hasAccountQuota(account, true));
  const connectedIds = accounts.filter(account => account.status === 'connected').map(account => account.id).sort().join('|');
  const usageGeneration = React.useRef(0);
  const usageLock = React.useRef<string | null>(null);
  const [usageBusy, setUsageBusy] = React.useState(false);
  const [usageError, setUsageError] = React.useState('');
  const refreshUsage = React.useCallback(async () => {
    if (!visible || !platform || !supportsUsage || !connectedIds || !bridge.api.refreshSubscriptionUsage || usageLock.current === platform) return;
    const ticket = ++usageGeneration.current;
    const observedRevision = revision.current;
    usageLock.current = platform; setUsageBusy(true); setUsageError('');
    try {
      const next = await bridge.api.refreshSubscriptionUsage({ platform });
      if (usageGeneration.current !== ticket) return;
      // Do not replace a more recent account edit or policy selection.
      if (!lock.current && observedRevision === revision.current) setSnapshot(next);
    } catch (failure) {
      if (usageGeneration.current !== ticket) return;
      setUsageError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (usageGeneration.current === ticket) { usageLock.current = null; setUsageBusy(false); }
    }
  }, [visible, platform, supportsUsage, connectedIds, bridge.api]);
  React.useEffect(() => {
    usageGeneration.current++; usageLock.current = null; setUsageBusy(false); setUsageError('');
    void refreshUsage();
    const onFocus = () => { void refreshUsage(); };
    if (visible) window.addEventListener('focus', onFocus);
    return () => { usageGeneration.current++; window.removeEventListener('focus', onFocus); };
  }, [visible, refreshUsage]);

  const needsUsageWebsite = !usageBusy && !!connectedIds && (!!usageError || accounts.some(account => account.status === 'connected' && (!hasAccountQuota(account, true) || account.quotaError)));

  const savePolicy = (next: SubscriptionRoutingPolicy) => {
    if (!platform) return;
    const ids = new Set(accounts.map(account => account.id));
    const accountOrder = [...new Set([...(next.accountOrder ?? ordered.map(account => account.id)).filter(id => ids.has(id)), ...ordered.map(account => account.id)])];
    policies.save(platform, { ...next, accountOrder });
  };

  return <div className={embedded ? 'configuration-detail subscription-accounts' : `configuration-content subscription-workspace${platform ? ' has-detail' : ''}`} aria-busy={busy}>
    {!embedded && <div className="configuration-directory">
      {platform && <button type="button" className="provider-text-action configuration-back" disabled={busy} onClick={() => { setPlatform(null); setRenaming(null); }}><ArrowLeft size={15} aria-hidden="true" />{t("全部订阅")}</button>}
      <div className={platform ? 'configuration-list' : 'configuration-grid'} aria-label={t("订阅服务")}>{OPTIONS.map(item => <button className="configuration-choice" type="button" data-subscription-service={item.id} aria-pressed={platform === item.id} key={item.id} disabled={busy} onClick={() => {
        setRenaming(null);
        setPlatform(item.id); setError('');
      }}><ProviderIcon kind={item.icon} /><span>{item.label}</span></button>)}</div>
    </div>}
    {platform && <div className={embedded ? 'subscription-accounts-body' : 'configuration-detail subscription-accounts'}>
      {platform === 'chatgpt' ? <><ChatgptAccounts visible={visible && open} snapshot={snapshot} setSnapshot={acceptSnapshot} busy={busy} begin={(group, id) => begin(id, group)} cancel={() => void run(async () => { setSnapshot(await bridge.api.cancelSubscriptionSignIn?.() ?? null); })} />{error && <p className="provider-field-error" role="alert">{error}<button type="button" className="provider-text-action" onClick={() => void run(async () => { if (!bridge.api.getSubscriptionAccounts) throw new Error(t('请更新桌面应用')); setSnapshot(await bridge.api.getSubscriptionAccounts()); })}>{t('重试读取')}</button></p>}</> : <>
      <div className="configuration-detail-heading"><h3><ProviderIcon kind={platformInfo.icon} />{embedded ? t(subscriptionServiceNames[platform!]) : platformInfo.label}</h3>
        {connectedIds && <button type="button" className="provider-menu-trigger" aria-label={t("刷新额度")} title={t("刷新额度")} disabled={busy || waiting || usageBusy || !bridge.api.refreshSubscriptionUsage} aria-busy={usageBusy} onClick={() => void refreshUsage()}><RefreshCw size={16} /></button>}
      </div>
      <>
        {accounts.length > 0 && <AccountRoutingControls policy={policy} accounts={ordered} disabled={!bridge.api.setSubscriptionRouting} quotaAvailable={hasQuota} onChange={savePolicy} />}
        {policies.errors[platform] && <p className="provider-field-error" role="status">{policies.errors[platform]} <button type="button" className="provider-text-action" onClick={() => policies.retry(platform)}>{t('重试保存')}</button></p>}
        {supportsUsage && usageError && <p className="provider-field-error" role="status">{usageError}</p>}
        {needsUsageWebsite && <div className="subscription-usage-fallback"><a className="setup-card-link subscription-usage-link" href={bridge.api.setupWebsites[`subscription-${platform}-usage`]} target="_blank" rel="noopener noreferrer" onClick={event => {
          event.preventDefault();
          void bridge.api.openSetupWebsite(`subscription-${platform}-usage`).catch(failure => showErrorToast(t('打开用量页面失败'), failure));
        }}>{t("查看套餐用量")}<ArrowUpRight size={14} aria-hidden="true" /></a></div>}
        <SortableAccounts accounts={ordered} disabled={busy || waiting || !bridge.api.setSubscriptionRouting} onOrder={ids => savePolicy({ ...policy, accountOrder: ids })}>{(account, handle) => {
          const paused = policy.strategy !== 'fixed' && policy.excludedAccountIds.includes(account.id);
          const needsLogin = account.status !== 'connected' || account.routingStatus === '需重新登录';
          const identity = <span className="subscription-account-identity"><strong title={account.label}>{account.label}</strong>{account.email && account.email !== account.label && <span title={account.email}>{account.email}</span>}</span>;
          const resume = () => savePolicy({ ...policy, excludedAccountIds: policy.excludedAccountIds.filter(id => id !== account.id) });
          return <><div className="chatgpt-account-heading subscription-service-account">{handle}
            {renaming === account.id ? <form className="subscription-rename" onSubmit={event => { event.preventDefault(); void run(async () => {
              if (!bridge.api.renameSubscriptionAccount) throw new Error(t('此版本尚不支持账号改名'));
              bridge.patch({ providers: await bridge.api.renameSubscriptionAccount({ accountId: account.id, label: label.trim() }) });
              setSnapshot(await bridge.api.getSubscriptionAccounts?.() ?? null); setRenaming(null);
            }); }}><input className="txt-input" aria-label={t("账号名称")} value={label} maxLength={80} required autoFocus onChange={event => setLabel(event.target.value)} disabled={busy} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRenaming(null); } }} /><button type="submit" className="provider-text-action" aria-label={t("保存账号名称")} disabled={busy || !label.trim()}><Check size={15} /></button><button type="button" className="provider-text-action" aria-label={t("取消改名")} onClick={() => setRenaming(null)} disabled={busy}><X size={15} /></button></form>
              : needsLogin ? identity : <button type="button" className="account-disclosure" aria-expanded={expandedId === account.id} aria-controls={`quota-${account.id}`} onClick={() => setExpanded(current => ({ ...current, [platform]: expandedId === account.id ? null : account.id }))}>{identity}<ChevronRight className="disclosure-chevron" aria-hidden="true" /></button>}
          {policy.strategy === 'fixed' && <input className="account-selection" type="radio" name={`fixed-${platform}`} aria-label={t("固定使用 {0}", account.label)} checked={policy.fixedAccountId === account.id} disabled={busy || waiting || needsLogin || !bridge.api.setSubscriptionRouting} onChange={() => savePolicy({ ...policy, fixedAccountId: account.id })} />}
          {!needsLogin && (paused || account.routingStatus) && <span className="subscription-account-status">{paused ? t('已暂停') : account.routingStatus}</span>}
          {needsLogin && <button className="provider-text-action" type="button" disabled={busy || waiting} onClick={() => begin(account.id)}>{t("登录")}</button>}
          {paused && <button className="provider-text-action" type="button" disabled={busy || waiting || !bridge.api.setSubscriptionRouting} onClick={resume}>{t("恢复使用")}</button>}
          {<Menu.Root>
            <Menu.Trigger type="button" className="provider-menu-trigger" aria-label={t("{0} 的更多操作", account.label)} disabled={busy || waiting}><Ellipsis aria-hidden="true" /></Menu.Trigger>
            <Menu.Portal><Menu.Positioner className="conversation-header-menu-positioner" side="bottom" align="end" sideOffset={4}>
              <Menu.Popup className="conversation-header-menu provider-menu">
                <Menu.Item className="conversation-header-menu-item" closeOnClick disabled={!bridge.api.renameSubscriptionAccount} onClick={() => { setRenaming(account.id); setLabel(account.label); }}>{t('重命名 {0}', account.label)}</Menu.Item>
                {account.status === 'connected' && <Menu.Item className="conversation-header-menu-item" closeOnClick onClick={() => void run(async () => {
            if (!await confirm({ title: t("退出 {0}？", account.label), body: t('此账号将退出。正在进行的回复可能继续；新请求按账号策略选择。'), confirmText: t('退出登录'), tone: 'danger' })) return;
            if (!bridge.api.signOutSubscriptionAccount) throw new Error(t('当前版本不支持退出此账号'));
            const result = await bridge.api.signOutSubscriptionAccount(account.id);
            setSnapshot(await bridge.api.getSubscriptionAccounts?.() ?? null);
            bridge.patch({ runtime: await bridge.api.getState() });
            if (result?.warning) showToast(result.warning, 'info');
            else showToast(t('账号已退出'), 'success');
                })}>{t("退出登录")}</Menu.Item>}
              </Menu.Popup>
            </Menu.Positioner></Menu.Portal>
          </Menu.Root>}
        </div>
        {expandedId === account.id && !needsLogin && <div id={`quota-${account.id}`}><ChatgptQuota account={account} summaryFallback>{!hasAccountQuota(account, true) && !account.quotaError && <p className="subscription-quota-empty" role="status">{t(usageBusy ? '刷新中…' : '额度未知')}</p>}</ChatgptQuota></div>}
        </>;
        }}</SortableAccounts>
        {waiting && flowHere && snapshot?.flow?.userCode && <div className="subscription-device-code"><span>{t("授权码")}</span><button type="button" className="inline-editable mono" aria-label={t("复制授权码")} onClick={() => void bridge.api.copyText(snapshot.flow!.userCode!).catch(failure => showErrorToast(t('复制授权码失败'), failure))}>{snapshot.flow.userCode}</button></div>}
        {waiting && flowHere ? <div className="subscription-login-progress" role="status"><span>{snapshot?.flow?.status === 'exchanging' ? t('正在完成账号授权…') : t('请在浏览器中完成登录与授权')}</span><button type="button" className="provider-text-action" disabled={busy} onClick={() => void run(async () => { setSnapshot(await bridge.api.cancelSubscriptionSignIn?.() ?? null); })}>{t("取消")}</button></div>
          : platform === 'claude' && snapshot?.claudeInstalled === false ? <button type="button" className="btn subscription-login-button" onClick={() => void bridge.api.openSetupWebsite('download-claude-code').catch(failure => showErrorToast(t('打开官方页面失败'), failure))}>{t("安装 Claude Code CLI")}<ArrowUpRight size={14} /></button>
          : platform === 'grok' && snapshot?.grokInstalled === false ? <button type="button" className="btn subscription-login-button" onClick={() => void bridge.api.openSetupWebsite('download-grok-build').catch(failure => showErrorToast(t('打开官方页面失败'), failure))}>{t("安装 Grok Build")}<ArrowUpRight size={14} /></button>
          : <button type="button" className="btn subscription-login-button" disabled={busy || waiting || snapshot?.supported === false} onClick={() => begin()}><Plus size={15} />{t('添加账号')}</button>}
        {error && <p className="provider-field-error" role="alert">{error}<button type="button" className="provider-text-action" onClick={() => void run(async () => { if (!bridge.api.getSubscriptionAccounts) throw new Error(t('请更新桌面应用')); setSnapshot(await bridge.api.getSubscriptionAccounts()); })}>{t('重试读取')}</button></p>}
        {snapshot?.flow?.status === 'failed' && flowHere && snapshot.flow.error && <p className="provider-field-error" role="alert">{snapshot.flow.error}</p>}
      </>
      </>}
    </div>}
  </div>;
}
