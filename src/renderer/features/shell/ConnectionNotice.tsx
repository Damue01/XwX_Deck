import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import { X } from 'lucide-react';
import { useBridge } from '@/bridge/store';
import { claudeDesktopRestartNote, isPersistentLifecycleNotice, lifecycleFailure, traceStoppedNotice, type LifecycleNotice } from '../../../shared/lifecycleNotice';
import { LIFECYCLE_NOTICE_EVENT, TRACE_ACTION_EVENT, noticeActionLabel, runNoticeAction, showLifecycleNotice, showToast } from '@/lib/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';

function noticeSignature(notice: LifecycleNotice | undefined | null): string {
  if (!notice) return '';
  return [
    notice.message,
    notice.description ?? '',
    notice.type ?? '',
    notice.action ?? '',
    notice.secondaryAction ?? ''
  ].join('\n');
}

export function ConnectionNotice(): React.ReactElement | null {
  useLanguage();
  const { api, runtime, patch } = useBridge();
  const confirm = useConfirm();
  const [notice, setNotice] = React.useState<LifecycleNotice | null>(null);
  const [dismissedSignature, setDismissedSignature] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const busyRef = React.useRef(false);
  const [handledRecovery, setHandledRecovery] = React.useState(false);
  React.useEffect(() => {
    const receive = (event: Event) => {
      const next = (event as CustomEvent<LifecycleNotice | null>).detail;
      setNotice(next);
      if (!next) setHandledRecovery(true);
    };
    window.addEventListener(LIFECYCLE_NOTICE_EVENT, receive);
    return () => window.removeEventListener(LIFECYCLE_NOTICE_EVENT, receive);
  }, []);
  React.useEffect(() => {
    const handle = async (event: Event) => {
      const enabled = (event as CustomEvent<boolean>).detail;
      // The Trace switch is also reachable from the Signal page and the tray;
      // a transition already reported by runtime means one is in flight.
      if (typeof enabled !== 'boolean' || busyRef.current || runtime?.traceTransition) return;
      busyRef.current = true;
      setBusy(true);
      if (!enabled) showToast(t('正在恢复直连…'), 'info', 'trace-recovery-progress');
      try {
        const next = await api.toggleTracing(enabled, !enabled);
        patch({ runtime: next });
        setHandledRecovery(true);
        if (next.lastError) {
          showLifecycleNotice(lifecycleFailure(next.lastError, t('更新 Trace')));
        } else if (next.tracingEnabled && next.clients.some(client => client.enabled && client.status === 'skipped')) {
          // The persistent connection notice explains the incomplete takeover.
          setNotice(null);
        } else if (next.tracingEnabled) {
          showLifecycleNotice(next.claudeDesktopRestart === 'local'
            ? { message: t('Trace 已开启'), description: claudeDesktopRestartNote('local'), type: 'info' }
            : { message: t('Trace 已开启'), description: t('没有新记录时，重开客户端。'), type: 'success' });
        } else {
          showLifecycleNotice(traceStoppedNotice(next.backgroundGatewayAction === 'close', next.claudeDesktopRestart, next.connectionNotice));
        }
      } catch (error) {
        void api.getState().then(state => patch({ runtime: state })).catch(() => undefined);
        showLifecycleNotice(lifecycleFailure(error, enabled ? t('开启 Trace') : t('关闭 Trace')));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    };
    window.addEventListener(TRACE_ACTION_EVENT, handle);
    return () => window.removeEventListener(TRACE_ACTION_EVENT, handle);
  }, [api, patch, runtime?.traceTransition]);
  React.useEffect(() => {
    const handle = async () => {
      if (busyRef.current) return;
      if (!await confirm({
        title: t('修复 XwX Deck 设置？'),
        body: t('会先备份原设置文件，再恢复能安全读取的内容；无法读取的设置将使用最小可用默认值。修复后可继续配置模型服务。'),
        confirmText: t('备份并修复')
      })) return;
      busyRef.current = true;
      setBusy(true);
      showToast(t('正在修复设置…'), 'info');
      try {
        const repaired = await api.repairUnreadableSettings();
        const next = await api.getState();
        patch({ runtime: next });
        const refreshes = await Promise.allSettled([
          api.getProviders(), api.getModelServices(), api.getCodexConfig()
        ]);
        if (refreshes[0].status === 'fulfilled') patch({ providers: refreshes[0].value });
        if (refreshes[1].status === 'fulfilled') patch({ modelServices: refreshes[1].value });
        if (refreshes[2].status === 'fulfilled') patch({ codexConfig: refreshes[2].value });
        if (next.lastError) {
          showToast(t('设置已修复，部分连接仍需处理'), 'warning', undefined, {
            description: lifecycleFailure(next.lastError, t('恢复运行状态')).description
          });
        } else if (repaired.lostProviderSettings) {
          setNotice(null);
          showToast(t('设置文件已重建'), 'warning', undefined, {
            description: t('原文件已备份。服务连接、ChatGPT 和 Claude 的模型选择需要重新设置。')
          });
        } else {
          setNotice(null);
          showToast(t('设置已修复'), 'success');
        }
      } catch (error) {
        showToast(t('设置修复失败'), 'error', undefined, {
          description: error instanceof Error ? error.message : String(error),
          actionProps: {
            type: 'button',
            children: t('修复'),
            onClick: () => window.dispatchEvent(new Event('xwxdeck:repair-settings'))
          }
        });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    };
    window.addEventListener('xwxdeck:repair-settings', handle);
    return () => window.removeEventListener('xwxdeck:repair-settings', handle);
  }, [api, patch, confirm]);
  const skippedClient = runtime?.tracingEnabled
    ? runtime.clients.find(client => client.enabled && client.status === 'skipped')
    : undefined;
  const skippedNotice: LifecycleNotice | undefined = skippedClient ? {
    message: t("{0} 未接入 Trace", skippedClient.id === 'codex-cli' ? 'ChatGPT' : 'Claude'),
    description: skippedClient.detail || t('客户端尚未接入，请检查客户端配置。'),
    type: 'info'
  } : undefined;
  const current = runtime?.lastError ? lifecycleFailure(runtime.lastError, t('恢复运行状态'))
    : notice ?? skippedNotice ?? runtime?.connectionNotice
      ?? (!handledRecovery ? runtime?.lifecycleNotice : undefined);
  const signature = noticeSignature(current);
  React.useEffect(() => {
    setDismissedSignature(dismissed => dismissed && dismissed !== signature ? '' : dismissed);
  }, [signature]);
  if (!current || !isPersistentLifecycleNotice(current) || dismissedSignature === signature) return null;
  const actions = [current.action, current.secondaryAction].filter(Boolean) as NonNullable<LifecycleNotice['action']>[];
  return <aside className="connection-notice" aria-label={t("连接状态提示")} aria-busy={busy}>
    <div className="connection-notice-copy"><strong>{current.message}</strong><p>{current.description}</p></div>
    {actions.length > 0 ? <div className="connection-notice-actions">{actions.map((action, index) => <button key={action} type="button" className="btn"
      disabled={busy} onClick={() => runNoticeAction(action)}>
      {(index === 0 ? current.actionLabel : current.secondaryActionLabel) ?? noticeActionLabel(action)}
    </button>)}</div> : null}
    <button
      type="button"
      className="connection-notice-close"
      aria-label={t("关闭连接状态提示")}
      title={t("关闭")}
      onClick={() => setDismissedSignature(signature)}
    >
      <X aria-hidden="true" />
    </button>
  </aside>;
}
