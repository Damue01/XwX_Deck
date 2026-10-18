import * as React from 'react';
import { useBridge } from '@/bridge/store';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { showToast } from '@/lib/toast';
import { t } from '@/lib/i18n';
import { userErrorMessage } from '@/lib/errors';

export function NativeLifecycleActions(): null {
  const { api, booted } = useBridge();
  const confirm = useConfirm();
  const exitPending = React.useRef(false);
  const resetSeen = React.useRef(false);
  React.useEffect(() => {
    const clipboardError = (event: Event) => showToast((event as CustomEvent<string>).detail, 'error', 'clipboard-error');
    const validationError = (event: Event) => {
      if (document.documentElement.dataset.platform !== 'win32') return;
      const field = event.target;
      if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) return;
      event.preventDefault();
      // Keep constraint validation; replace only the WebView's default bubble.
      if (field.form?.querySelector('input:invalid,textarea:invalid,select:invalid') !== field) return;
      field.focus({ preventScroll: true });
      showToast(field.validationMessage, 'error', 'form-validation');
    };
    const exit = async () => {
      if (exitPending.current) return;
      exitPending.current = true;
      try {
        if (await confirm({ title: t('退出 XwX Deck'), body: t('退出前将停止 Trace 并恢复客户端直连；尚未完成的请求可能中断。'), confirmText: t('恢复直连并退出'), cancelText: t('继续运行'), tone: 'danger' })) {
          await api.confirmApplicationExit();
        }
      } catch (error) {
        showToast(t('配置恢复未完成，Gateway 继续运行'), 'error', 'application-exit', { description: userErrorMessage(error) });
      } finally { exitPending.current = false; }
    };
    window.addEventListener('xwxdeck:request-exit', exit);
    window.addEventListener('xwxdeck:clipboard-error', clipboardError);
    document.addEventListener('invalid', validationError, true);
    return () => {
      window.removeEventListener('xwxdeck:request-exit', exit);
      window.removeEventListener('xwxdeck:clipboard-error', clipboardError);
      document.removeEventListener('invalid', validationError, true);
    };
  }, [api, confirm]);
  React.useEffect(() => {
    if (!booted || resetSeen.current || !api.getApplicationResetResult) return;
    let cancelled = false;
    void api.getApplicationResetResult().then(async result => {
      if (cancelled || !result || result.noticeSeen || resetSeen.current) return;
      resetSeen.current = true;
      const failed = result.status !== 'completed';
      const skipped = result.skippedClientFiles?.length ?? 0;
      const detail = failed ? t('重置未完成：{0}', result.reason ?? t('请检查恢复记录')) : skipped ? t('应用重置完成；{0} 个客户端文件因外部变化或占用而保留，请核对后再处理。', skipped) : t('应用已重置，原数据与凭据恢复记录已归档。客户端历史、Skills 与 Agents 保留。');
      const open = await confirm({ title: t(failed ? '重置未完成' : '重置完成'), body: <>{detail}{result.backupPath && <span className="mt-2 block break-all">{t('备份：')}{result.backupPath}</span>}</>, confirmText: t('打开备份'), cancelText: t('继续') });
      await api.acknowledgeApplicationResetResult(result.atMs, open);
    }).catch(error => { if (!cancelled) showToast(t('无法读取重置记录'), 'error', 'reset-result', { description: userErrorMessage(error) }); });
    return () => { cancelled = true; };
  }, [api, booted, confirm]);
  return null;
}
