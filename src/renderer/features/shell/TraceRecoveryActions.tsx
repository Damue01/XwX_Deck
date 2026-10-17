import * as React from 'react';
import { useBridge } from '@/bridge/store';
import { claudeDesktopRestartNote, isTraceStopBusyError, lifecycleFailure, traceStoppedNotice } from '../../../shared/lifecycleNotice';
import { normalizeErrorMessage } from '../../../shared/errors';
import { TRACE_ACTION_EVENT, closeToast, clearLifecycleNotice, setLifecycleActionsBusy, showLifecycleNotice, showToast } from '@/lib/toast';
import { useConfirm } from '@/components/ui/confirm-dialog';

/** Trace recovery actions are shared by Toast, Signal and tray; no fixed banner. */
export function TraceRecoveryActions(): null {
  const { api, runtime, patch } = useBridge();
  const confirm = useConfirm();
  const busyRef = React.useRef(false);
  const pendingTraceAction = React.useRef<boolean | undefined>(undefined);
  React.useEffect(() => {
    const handle = async (event: Event) => {
      const enabled = (event as CustomEvent<boolean>).detail;
      // The Trace switch is also reachable from the Signal page and the tray;
      // a transition already reported by runtime means one is in flight.
      if (typeof enabled !== 'boolean') return;
      if (busyRef.current || runtime?.traceTransition) {
        pendingTraceAction.current = enabled;
        return;
      }
      busyRef.current = true;
      setLifecycleActionsBusy(true);
      if (!enabled) showToast('正在恢复直连…', 'info', 'trace-recovery-progress');
      try {
        let next;
        try {
          next = await api.toggleTracing(enabled);
        } catch (error) {
          if (enabled) throw error;
          const busy = isTraceStopBusyError(error);
          if (!busy && !/配置.*(?:恢复|冲突)|恢复直连|仍指向/.test(normalizeErrorMessage(error))) throw error;
          if (!await confirm(busy ? {
            title: '关闭 Trace？',
            body: `${normalizeErrorMessage(error)}现在关闭会中断它们；继续等待则保持 Trace 开启。`,
            cancelText: '继续等待', confirmText: '强制停止', tone: 'danger'
          } : {
            title: '恢复直连配置？',
            body: '会备份当前客户端配置，再按已保存的服务和模型恢复直连并停止 Trace。',
            confirmText: '备份并恢复', tone: 'danger'
          })) {
            pendingTraceAction.current = undefined;
            return;
          }
          if (!busy) {
            // The confirmation promises a backup and recovery, not just killing
            // the helper. Resolve saved targets in main so late UI reads cannot
            // restore an earlier service/model over the user's latest choice.
            await api.repairClientProviderSwitch({ client: 'codex' });
            await api.repairClientProviderSwitch({ client: 'claude' });
          }
          next = await api.toggleTracing(false, true);
        }
        if (!patch({ runtime: next })) return;
        if (next.lastError) {
          showLifecycleNotice(lifecycleFailure(next.lastError, '更新 Trace'));
        } else if (next.tracingEnabled && next.clients.some(client => client.enabled && client.status === 'skipped')) {
          // App publishes skipped-client guidance through the shared Toast queue.
        } else if (next.tracingEnabled) {
          // The model page resumes a selection that was waiting for Trace, so this
          // must not ask for a re-selection the user may not owe.
          showLifecycleNotice(next.claudeDesktopRestart === 'local'
            ? { message: 'Trace 已开启', description: claudeDesktopRestartNote('local'), type: 'info' }
            : { message: 'Trace 已开启', description: '本地转发与协议转换已开启。刚才因缺少 Trace 未完成的模型选择会自动继续；若客户端连接失败，请完全退出并重新打开。', type: 'success' });
        } else {
          showLifecycleNotice(traceStoppedNotice(next.backgroundGatewayAction === 'close', next.claudeDesktopRestart, next.connectionNotice));
        }
      } catch (error) {
        void api.getState().then(state => patch({ runtime: state })).catch(() => undefined);
        showLifecycleNotice(lifecycleFailure(error, enabled ? '开启 Trace' : '关闭 Trace'));
      } finally {
        closeToast('trace-recovery-progress');
        busyRef.current = false;
        setLifecycleActionsBusy(false);
        const pending = pendingTraceAction.current;
        pendingTraceAction.current = undefined;
        if (pending !== undefined) {
          void handle(new CustomEvent<boolean>(TRACE_ACTION_EVENT, { detail: pending }));
        }
      }
    };
    window.addEventListener(TRACE_ACTION_EVENT, handle);
    return () => window.removeEventListener(TRACE_ACTION_EVENT, handle);
  }, [api, patch, runtime?.traceTransition, confirm]);
  React.useEffect(() => {
    if (runtime?.traceTransition || busyRef.current || pendingTraceAction.current === undefined) return;
    const enabled = pendingTraceAction.current;
    pendingTraceAction.current = undefined;
    window.dispatchEvent(new CustomEvent<boolean>(TRACE_ACTION_EVENT, { detail: enabled }));
  }, [runtime?.traceTransition]);
  React.useEffect(() => {
    const handle = async () => {
      if (busyRef.current) return;
      if (!await confirm({
        title: '修复 XwX Deck 设置？',
        body: '会先备份原设置文件，再恢复能安全读取的内容；无法读取的设置将使用最小可用默认值。修复后可继续配置模型服务。',
        confirmText: '备份并修复'
      })) return;
      busyRef.current = true;
      setLifecycleActionsBusy(true);
      showToast('正在修复设置…', 'info');
      try {
        const repaired = await api.repairUnreadableSettings();
        clearLifecycleNotice();
        const next = await api.getState();
        patch({ runtime: next });
        const refreshes = await Promise.allSettled([
          api.getProviders(), api.getModelServices(), api.getCodexConfig()
        ]);
        if (refreshes[0].status === 'fulfilled') patch({ providers: refreshes[0].value });
        if (refreshes[1].status === 'fulfilled') patch({ modelServices: refreshes[1].value });
        if (refreshes[2].status === 'fulfilled') patch({ codexConfig: refreshes[2].value });
        if (next.lastError) {
          showToast('设置已修复，部分连接仍需处理', 'warning', undefined, {
            diagnostic: true,
            description: lifecycleFailure(next.lastError, '恢复运行状态').description
          });
        } else if (repaired.lostProviderSettings) {
          showToast('设置文件已重建', 'warning', undefined, {
            description: '原文件已备份。服务连接、ChatGPT 和 Claude 的模型选择需要重新设置。'
          });
        } else {
          showToast('设置已修复', 'success');
        }
      } catch (error) {
        showToast('设置修复失败', 'error', undefined, {
          description: error instanceof Error ? error.message : String(error),
          actionProps: {
            type: 'button',
            children: '修复',
            onClick: () => window.dispatchEvent(new Event('xwxdeck:repair-settings'))
          }
        });
      } finally {
        busyRef.current = false;
        setLifecycleActionsBusy(false);
      }
    };
    window.addEventListener('xwxdeck:repair-settings', handle);
    return () => window.removeEventListener('xwxdeck:repair-settings', handle);
  }, [api, patch, confirm]);
  const skippedClient = runtime?.tracingEnabled
    ? runtime.clients.find(client => client.enabled && client.status === 'skipped') : undefined;
  const skippedSignature = skippedClient ? `${skippedClient.id}:${skippedClient.detail}` : '';
  const lastSkipped = React.useRef('');
  React.useEffect(() => {
    if (lastSkipped.current === skippedSignature) return;
    lastSkipped.current = skippedSignature;
    if (!skippedClient) { closeToast('trace-skipped-client'); return; }
    showToast(`${skippedClient.id === 'codex-cli' ? 'ChatGPT' : 'Claude'} 未接入 Trace`, 'info', 'trace-skipped-client', {
      description: skippedClient.detail || '客户端尚未接入，请检查客户端配置。'
    });
  }, [skippedSignature]);
  return null;
}
