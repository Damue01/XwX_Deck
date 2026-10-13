import { createToastQueue } from './toast-queue';
import { t } from '@/lib/i18n';
import type React from 'react';
import { ToastProvider, toastManager } from '@/components/ui/toast';
import { isPersistentLifecycleNotice, type LifecycleNotice } from '../../shared/lifecycleNotice';
import { userErrorMessage } from '../../shared/errors';

export { ToastProvider };

const lifecycleToastKeys = new Set<string>();
const lifecycleNotices = new Map<string, LifecycleNotice>();
let lifecycleActionsBusy = false;
let lastDiagnosticNotice: LifecycleNotice | undefined;
export const DIAGNOSTIC_NOTICE_EVENT = 'xwxdeck:diagnostic-notice';
export const OPEN_REPAIR_EVENT = 'xwxdeck:open-repair';
export const RESTORE_CLIENT_CONFIG_EVENT = 'xwxdeck:restore-client-config';
export const TRACE_ACTION_EVENT = 'xwxdeck:trace-action';
export const REPAIR_SETTINGS_EVENT = 'xwxdeck:repair-settings';
export const REPAIR_CODEX_CONFIG_EVENT = 'xwxdeck:repair-codex-config';
export const OPEN_PROVIDER_SETTINGS_EVENT = 'xwxdeck:open-provider-settings';
export const OPEN_CONFIGURATION_EVENT = 'xwxdeck:open-configuration';

export interface ConfigurationEntry {
  trigger: HTMLButtonElement;
  tab: 'services' | 'accounts' | 'clients';
}

export function openConfiguration(trigger: HTMLButtonElement, tab: ConfigurationEntry['tab'] = 'services'): void {
  window.dispatchEvent(new CustomEvent<ConfigurationEntry>(OPEN_CONFIGURATION_EVENT, { detail: { trigger, tab } }));
}

export function openProviderSettings(providerId: string): void {
  closeToast();
  window.dispatchEvent(new CustomEvent('xwxdeck:navigate', { detail: 'settings' }));
  window.dispatchEvent(new CustomEvent(OPEN_PROVIDER_SETTINGS_EVENT, { detail: providerId }));
}

export function noticeActionLabel(action: LifecycleNotice['action'] | undefined): string {
  if (!action) return '';
  return action === 'start-trace' ? t('开启 Trace') : action === 'stop-trace' ? t('重试关闭')
    : action === 'models' ? t('检查模型配置') : action === 'repair-settings' || action === 'repair-codex-config' ? t('修复') : t('查看处理建议');
}

export function runNoticeAction(action: LifecycleNotice['action']): void {
  if (action === 'start-trace' || action === 'stop-trace') {
    window.dispatchEvent(new CustomEvent(TRACE_ACTION_EVENT, { detail: action === 'start-trace' }));
    return;
  }
  if (action === 'repair-settings') {
    window.dispatchEvent(new Event(REPAIR_SETTINGS_EVENT));
    return;
  }
  if (action === 'repair-codex-config') {
    window.dispatchEvent(new Event(REPAIR_CODEX_CONFIG_EVENT));
    return;
  }
  window.dispatchEvent(new CustomEvent('xwxdeck:navigate', { detail: action === 'models' ? 'models' : 'settings' }));
  if (action === 'repair') window.dispatchEvent(new Event(OPEN_REPAIR_EVENT));
}

export function readLastDiagnosticNotice(): LifecycleNotice | undefined {
  return lastDiagnosticNotice;
}

export function clearLastDiagnosticNotice(): void {
  if (!lastDiagnosticNotice) return;
  lastDiagnosticNotice = undefined;
  window.dispatchEvent(new Event(DIAGNOSTIC_NOTICE_EVENT));
}

export function clearLifecycleNotice(): void {
  for (const key of lifecycleToastKeys) closeToast(key);
  lifecycleToastKeys.clear();
  lifecycleNotices.clear();
  clearLastDiagnosticNotice();
}

export function showLifecycleNotice(notice: LifecycleNotice, key?: string): void {
  if (notice.type === 'success') clearLifecycleNotice();
  const persistent = isPersistentLifecycleNotice(notice);
  const toastKey = key ?? (persistent ? 'runtime-lifecycle-issue' : `${notice.type}:${notice.message}`);
  if (persistent) { lifecycleToastKeys.add(toastKey); lifecycleNotices.set(toastKey, notice); }
  const action = (kind: LifecycleNotice['action'], label?: string) => kind ? {
    type: 'button' as const, disabled: persistent && lifecycleActionsBusy, children: label ?? noticeActionLabel(kind),
    onClick: () => { if (!persistent) closeToast(toastKey); runNoticeAction(kind); }
  } : undefined;
  showToast(notice.message, notice.type ?? 'error', toastKey, {
    description: notice.description,
    timeout: persistent ? 0 : undefined,
    actionProps: action(notice.action, notice.actionLabel),
    secondaryActionProps: action(notice.secondaryAction, notice.secondaryActionLabel)
  });
  if (notice.type === 'error') {
    lastDiagnosticNotice = notice;
    window.dispatchEvent(new Event(DIAGNOSTIC_NOTICE_EVENT));
  }
}

export function setLifecycleActionsBusy(busy: boolean): void {
  lifecycleActionsBusy = busy;
  for (const [key, notice] of lifecycleNotices) if (notifications.has(key)) showLifecycleNotice(notice, key);
}

interface ShowToastOptions {
  readonly description?: string;
  readonly timeout?: number;
  readonly actionProps?: React.ComponentPropsWithoutRef<'button'>;
  readonly secondaryActionProps?: React.ComponentPropsWithoutRef<'button'>;
}
interface Notification extends ShowToastOptions {
  title: string;
  type: 'error' | 'info' | 'success' | 'warning';
  timeout: number;
}
const toastData = (value: Notification) => ({ secondaryActionProps: value.secondaryActionProps });
const notifications = createToastQueue<Notification>({
  show: (id, value, onClose, onRemove) => toastManager.add({
    ...value, id, data: toastData(value), onClose, onRemove
  }),
  update: (id, value) => toastManager.update(id, { ...value, data: toastData(value) }),
  close: id => toastManager.close(id)
});

export function showToast(
  message: string,
  type: Notification['type'] = 'info',
  key?: string,
  options: ShowToastOptions = {}
): void {
  if (type === 'error') {
    lastDiagnosticNotice = { message, description: options.description ? t(options.description) : undefined, type };
    window.dispatchEvent(new Event(DIAGNOSTIC_NOTICE_EVENT));
  }
  // Short UI notifications omit the final sentence stop. Keep inner punctuation,
  // ellipses and the original message/key used by lifecycle and deduplication.
  const copy = (text: string) => text.replace(/(?<!\.)[。.]\s*$/u, '');
  const title = copy(t(message));
  const description = options.description ? copy(t(options.description)) : undefined;
  const defaultTimeout = type === 'success' ? 3000 : type === 'info' ? 4000 : type === 'warning' ? 5000 : 6000;
  // A queued notification starts its timer only on delivery. Longer copy gets
  // reading time; blocking recovery remains until dismissed or resolved.
  const timeout = options.timeout === 0 ? 0 : Math.min(30_000, Math.max(options.timeout ?? defaultTimeout,
    Math.min(30_000, (title.length + (description?.length ?? 0)) * 70), options.actionProps ? 8000 : 0));
  const toastKey = key ?? `${type}:${message}`;
  const actionSignature = (props: ShowToastOptions['actionProps']) => typeof props?.children === 'string' || typeof props?.children === 'number'
    ? props.children : props ? toastKey : undefined;
  notifications.add({ key: toastKey,
    signature: JSON.stringify([type, title, description, actionSignature(options.actionProps), actionSignature(options.secondaryActionProps), timeout]),
    value: { ...options, title, description, type, timeout, actionProps: options.actionProps, secondaryActionProps: options.secondaryActionProps }
  });
}

export function closeToast(key?: string): void {
  notifications.close(key);
}

export function showErrorToast(title: string, error: unknown, key?: string, options: ShowToastOptions = {}): void {
  showToast(title, 'error', key, {
    ...options,
    description: userErrorMessage(error, options.description
      ?? t('操作未完成。请检查相关地址、权限或配置后重试；如果仍失败，再打开“诊断与修复”查看详细信息。')),
    timeout: options.timeout
  });
}
