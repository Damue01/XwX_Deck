import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import { Menu } from '@base-ui/react/menu';
import { ArrowLeft, ArrowUpRight, Check, Ellipsis, X } from 'lucide-react';
import { useBridge } from '@/bridge/store';
import { subscriptionServiceNames } from '@/lib/subscriptionServices';
import { showErrorToast, showToast } from '@/lib/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';
import type { SubscriptionAccountsSnapshot, SubscriptionRoutingPolicy, SubscriptionStrategy } from '../../../shared/subscriptionAccounts';
import { ProviderIcon } from './ProviderIcon';

const OPTIONS = [
  { id: 'chatgpt', label: 'ChatGPT', icon: 'chatgpt' },
  { id: 'grok', label: 'Grok', icon: 'xai' },
  { id: 'claude', label: 'Claude', icon: 'claude' },
  { id: 'copilot', label: 'GitHub Copilot', icon: 'copilot' },
  { id: 'cursor', label: 'Cursor', icon: 'cursor' }
] as const;

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
  const [snapshot, setSnapshot] = React.useState<SubscriptionAccountsSnapshot | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const generation = React.useRef(0);
  const revision = React.useRef(0);
  const connected = React.useRef(new Set<string>());
  const pendingSignIn = React.useRef(new Set<string>());
  const waiting = snapshot?.flow?.status === 'waiting' || snapshot?.flow?.status === 'exchanging';
  React.useEffect(() => {
    if (!visible) return;
    const current = ++generation.current;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const observedRevision = revision.current;
        const next = await bridge.api.getSubscriptionAccounts?.();
        if (generation.current !== current) return;
        if (!lock.current && revision.current === observedRevision) setSnapshot(next ?? { supported: false, accounts: [] });
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
  }, [visible, bridge.api, bridge.patch]);
  const run = async (operation: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; revision.current++; setBusy(true); setError('');
    try { await operation(); } catch (failure) { showErrorToast(t('账号操作未完成'), failure); }
    finally { revision.current++; lock.current = false; setBusy(false); }
  };
  const begin = (accountId?: string) => void run(async () => {
    if (!platform) return;
    if (!bridge.api.beginSubscriptionSignIn) throw new Error(t('请在 Rust 桌面应用中添加订阅账号'));
    const next = await bridge.api.beginSubscriptionSignIn({ accountId, platform });
    if (next.flow) pendingSignIn.current.add(next.flow.id);
    setSnapshot(next);
  });
  const accounts = snapshot?.accounts.filter(account => (account.platform ?? 'chatgpt') === platform) ?? [];
  const policy: SubscriptionRoutingPolicy = (platform ? snapshot?.routing?.[platform] : undefined) ?? { strategy: 'exhaust', fixedAccountId: '', excludedAccountIds: [] };
  const hasQuota = accounts.some(account => account.quota);
  const savePolicy = (next: SubscriptionRoutingPolicy, message = t('账号策略已保存')) => void run(async () => {
    if (!platform) return;
    if (!bridge.api.setSubscriptionRouting) throw new Error(t('当前版本不支持账号策略'));
    const previous = snapshot;
    const currentGeneration = generation.current;
    setSnapshot(current => current ? { ...current, routing: { ...current.routing, [platform]: next } } : current);
    try {
      const saved = await bridge.api.setSubscriptionRouting({ platform, policy: next });
      if (generation.current !== currentGeneration) return;
      setSnapshot(saved);
      showToast(message, 'success', 'subscription-policy');
    } catch (failure) {
      if (generation.current === currentGeneration) setSnapshot(previous);
      throw failure;
    }
  });
  const strategies: readonly { id: SubscriptionStrategy; label: string; needsQuota?: boolean }[] = [
    { id: 'exhaust', label: t('用完再换') }, { id: 'balanced', label: t('平衡使用') },
    { id: 'most-remaining', label: t('剩余额度最多'), needsQuota: true },
    { id: 'reset-soon', label: t('优先使用即将恢复'), needsQuota: true }, { id: 'fixed', label: t('固定账号') }
  ];

  return <div className={embedded ? 'configuration-detail subscription-accounts' : `configuration-content subscription-workspace${platform ? ' has-detail' : ''}`} aria-busy={busy}>
    {!embedded && <div className="configuration-directory">
      {platform && <button type="button" className="provider-text-action configuration-back" disabled={busy || waiting} onClick={() => { setPlatform(null); setRenaming(null); }}><ArrowLeft size={15} aria-hidden="true" />{t("全部订阅")}</button>}
      <div className={platform ? 'configuration-list' : 'configuration-grid'} aria-label={t("订阅服务")}>{OPTIONS.map(item => <button className="configuration-choice" type="button" data-subscription-service={item.id} aria-pressed={platform === item.id} key={item.id} disabled={busy || waiting} onClick={() => {
        setRenaming(null);
        setPlatform(item.id); setError('');
      }}><ProviderIcon kind={item.icon} /><span>{item.label}</span></button>)}</div>
    </div>}
    {platform && <div className={embedded ? 'subscription-accounts-body' : 'configuration-detail subscription-accounts'}>
      <div className="configuration-detail-heading"><h3><ProviderIcon kind={platformInfo.icon} />{embedded ? t(subscriptionServiceNames[platform!]) : platformInfo.label}</h3>
        <a className="setup-card-link subscription-usage-link" href={bridge.api.setupWebsites[`subscription-${platform}-usage`]} target="_blank" rel="noopener noreferrer" onClick={event => {
          event.preventDefault();
          void bridge.api.openSetupWebsite(`subscription-${platform}-usage`).catch(failure => showErrorToast(t('打开用量页面失败'), failure));
        }}>{t("查看套餐用量")}<ArrowUpRight size={14} aria-hidden="true" /></a>
      </div>
      <>
        {accounts.length > 0 && <div className="subscription-routing">
          <div className="subscription-routing-heading"><span>{t("账号策略")}</span>{platform !== 'chatgpt' && <button type="button" className="provider-text-action" disabled={busy || waiting} onClick={() => void run(async () => {
            if (bridge.api.refreshSubscriptionUsage) setSnapshot(await bridge.api.refreshSubscriptionUsage({ platform }));
          })}>{t("刷新额度")}</button>}</div>
          <div className="subscription-strategies" role="radiogroup" aria-label={t("账号策略")}>{strategies.map(strategy => <button type="button" role="radio" aria-checked={policy.strategy === strategy.id} className="subscription-strategy" key={strategy.id} disabled={busy || waiting || !bridge.api.setSubscriptionRouting || (strategy.needsQuota && !hasQuota)} title={strategy.needsQuota && !hasQuota ? t('读取官方额度后可用') : undefined} onClick={() => savePolicy({ ...policy, strategy: strategy.id, fixedAccountId: strategy.id === 'fixed' ? policy.fixedAccountId || accounts.find(a => a.status === 'connected')?.id || accounts[0].id : policy.fixedAccountId })}>{t(strategy.label)}</button>)}</div>
        </div>}
        {accounts.map(account => {
          const paused = policy.strategy !== 'fixed' && policy.excludedAccountIds.includes(account.id);
          const needsLogin = account.status !== 'connected' || account.routingStatus === '需重新登录';
          const resume = () => savePolicy({ ...policy, excludedAccountIds: policy.excludedAccountIds.filter(id => id !== account.id) }, t("{0} 已恢复使用", account.label));
          return <div className="subscription-account-row" key={account.id}>
          <div className="subscription-account-identity">
            {renaming === account.id ? <form className="subscription-rename" onSubmit={event => { event.preventDefault(); void run(async () => {
              if (!bridge.api.renameSubscriptionAccount) throw new Error(t('此版本尚不支持账号改名'));
              bridge.patch({ providers: await bridge.api.renameSubscriptionAccount({ accountId: account.id, label: label.trim() }) });
              setSnapshot(await bridge.api.getSubscriptionAccounts?.() ?? null); setRenaming(null);
            }); }}><input className="txt-input" aria-label={t("账号名称")} value={label} maxLength={80} required autoFocus onChange={event => setLabel(event.target.value)} disabled={busy} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRenaming(null); } }} /><button type="submit" className="provider-text-action" aria-label={t("保存账号名称")} disabled={busy || !label.trim()}><Check size={15} /></button><button type="button" className="provider-text-action" aria-label={t("取消改名")} onClick={() => setRenaming(null)} disabled={busy}><X size={15} /></button></form>
              : <strong><button className="inline-editable subscription-rename-trigger" type="button" aria-label={t("重命名 {0}", account.label)} disabled={busy || waiting} onClick={() => { setRenaming(account.id); setLabel(account.label); }}>{account.label}</button></strong>}
            <span>{account.email || account.label}</span>
          </div>
          {snapshot?.routing && policy.strategy === 'fixed' && <label className="subscription-account-participation"><input type="radio" name="subscription-account" aria-label={t("固定使用 {0}", account.label)} checked={policy.fixedAccountId === account.id} disabled={busy || waiting || needsLogin} onChange={() => savePolicy({ ...policy, fixedAccountId: account.id })} /><span>{t("固定")}</span></label>}
          <span className="subscription-account-status">{needsLogin ? t('需登录') : paused ? t('已暂停') : account.routingStatus || (account.activeRequests ? t('使用中') : account.quota ? t("剩余 {0}%", Math.round(account.quota.remainingPercent)) : t('额度未知'))}</span>
          {needsLogin && <button className="provider-text-action" type="button" disabled={busy || waiting} onClick={() => begin(account.id)}>{t("登录")}</button>}
          {paused && <button className="provider-text-action" type="button" disabled={busy || waiting || !bridge.api.setSubscriptionRouting} onClick={resume}>{t("恢复使用")}</button>}
          {account.status === 'connected' && <Menu.Root>
            <Menu.Trigger type="button" className="provider-menu-trigger" aria-label={t("{0} 的更多操作", account.label)} disabled={busy || waiting}><Ellipsis aria-hidden="true" /></Menu.Trigger>
            <Menu.Portal><Menu.Positioner className="conversation-header-menu-positioner" side="bottom" align="end" sideOffset={4}>
              <Menu.Popup className="conversation-header-menu provider-menu">
                {snapshot?.routing && policy.strategy !== 'fixed' && <Menu.Item className="conversation-header-menu-item" closeOnClick disabled={!bridge.api.setSubscriptionRouting} onClick={() => paused ? resume() : savePolicy({ ...policy, excludedAccountIds: [...policy.excludedAccountIds, account.id] }, t("{0} 已暂停使用", account.label))}>{paused ? t('恢复使用') : t('暂停使用')}</Menu.Item>}
                <Menu.Item className="conversation-header-menu-item" closeOnClick onClick={() => void run(async () => {
            if (!await confirm({ title: t("退出 {0}？", account.label), body: t('此账号将退出。正在进行的回复可能继续；新请求按账号策略选择。'), confirmText: t('退出登录'), tone: 'danger' })) return;
            const result = await bridge.api.signOutSubscriptionAccount?.(account.id);
            setSnapshot(await bridge.api.getSubscriptionAccounts?.() ?? null);
            bridge.patch({ runtime: await bridge.api.getState() });
            if (result?.warning) showToast(result.warning, 'info');
            else showToast(t('账号已退出'), 'success');
                })}>{t("退出登录")}</Menu.Item>
              </Menu.Popup>
            </Menu.Positioner></Menu.Portal>
          </Menu.Root>}
        </div>;
        })}
        {waiting && snapshot?.flow?.userCode && <div className="subscription-device-code"><span>{t("授权码")}</span><button type="button" className="inline-editable mono" aria-label={t("复制授权码")} onClick={() => void bridge.api.copyText(snapshot.flow!.userCode!).catch(failure => showErrorToast(t('复制授权码失败'), failure))}>{snapshot.flow.userCode}</button></div>}
        {waiting ? <div className="subscription-login-progress" role="status"><span>{snapshot?.flow?.status === 'exchanging' ? t('正在完成账号授权…') : t('请在浏览器中完成登录与套餐授权')}</span><button type="button" className="provider-text-action" disabled={busy} onClick={() => void run(async () => { setSnapshot(await bridge.api.cancelSubscriptionSignIn?.() ?? null); })}>{t("取消")}</button></div>
          : platform === 'claude' && snapshot?.claudeInstalled === false ? <button type="button" className="btn subscription-login-button" onClick={() => void bridge.api.openSetupWebsite('download-claude-code').catch(failure => showErrorToast(t('打开官方页面失败'), failure))}>{t("安装 Claude Code CLI")}<ArrowUpRight size={14} /></button>
          : platform === 'grok' && snapshot?.grokInstalled === false ? <button type="button" className="btn subscription-login-button" onClick={() => void bridge.api.openSetupWebsite('download-grok-build').catch(failure => showErrorToast(t('打开官方页面失败'), failure))}>{t("安装 Grok Build")}<ArrowUpRight size={14} /></button>
          : <button type="button" className="btn btn-primary subscription-login-button" disabled={busy || snapshot?.supported === false} onClick={() => begin()}><ProviderIcon kind={platformInfo.icon} />{`Continue with ${platformInfo.label}`}</button>}
        {((snapshot?.flow?.status === 'failed' && (snapshot.flow.platform ?? 'chatgpt') === platform) || error) && <p className="provider-field-error" role="alert">{error || snapshot?.flow?.error}</p>}
      </>
    </div>}
  </div>;
}
