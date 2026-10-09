import { t } from '@/lib/i18n';
import type React from 'react';
import { ToastProvider, toastManager } from '@/components/ui/toast';
import { isPersistentLifecycleNotice, type LifecycleNotice } from '../../shared/lifecycleNotice';
import { userErrorMessage } from '../../shared/errors';

export { ToastProvider };

const APP_TOAST_SLOT_ID = 'xwx-deck-notification';
let activeToastKey: string | undefined;
let lastDiagnosticNotice: LifecycleNotice | undefined;
export const DIAGNOSTIC_NOTICE_EVENT = 'xwxdeck:diagnostic-notice';
export const OPEN_REPAIR_EVENT = 'xwxdeck:open-repair';
export const RESTORE_CLIENT_CONFIG_EVENT = 'xwxdeck:restore-client-config';
export const LIFECYCLE_NOTICE_EVENT = 'xwxdeck:lifecycle-notice';
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
  clearLastDiagnosticNotice();
  window.dispatchEvent(new CustomEvent(LIFECYCLE_NOTICE_EVENT, { detail: null }));
}

export function showLifecycleNotice(notice: LifecycleNotice, key?: string): void {
  if (notice.type === 'success') {
    clearLifecycleNotice();
    showToast(notice.message, 'success', key, {
      description: notice.description
    });
    return;
  }
  if (!isPersistentLifecycleNotice(notice)) {
    const action = notice.action;
    showToast(notice.message, notice.type ?? 'error', key, {
      description: notice.description,
      actionProps: action ? {
        type: 'button',
        children: notice.actionLabel ?? noticeActionLabel(action),
        onClick: () => {
          closeToast(key);
          runNoticeAction(action);
        }
      } : undefined
    });
    return;
  }
  // Lifecycle problems stay in the persistent top notice. Publishing the
  // same problem as a Toast as well creates two competing prompts. Only
  // safety/blocking states use this persistent surface.
  closeToast();
  if (notice.type === 'error') {
    lastDiagnosticNotice = notice;
    window.dispatchEvent(new Event(DIAGNOSTIC_NOTICE_EVENT));
  }
  window.dispatchEvent(new CustomEvent(LIFECYCLE_NOTICE_EVENT, { detail: notice }));
}

interface ShowToastOptions {
  readonly description?: string;
  readonly timeout?: number;
  readonly actionProps?: React.ComponentPropsWithoutRef<'button'>;
}

export function showToast(
  message: string,
  type: 'error' | 'info' | 'success' | 'warning' = 'info',
  key?: string,
  options: ShowToastOptions = {}
): void {
  if (type === 'error') {
    lastDiagnosticNotice = { message, description: options.description ? t(options.description) : undefined, type };
    window.dispatchEvent(new Event(DIAGNOSTIC_NOTICE_EVENT));
  }
  const toastKey = key ?? `${type}:${message}`;
  const defaultTimeout = type === 'success' ? 3000
    : type === 'info' ? 4000
      : type === 'warning' ? 5000
        : 6000;
  const maxTimeout = options.actionProps ? 8000 : defaultTimeout;
  activeToastKey = toastKey;
  toastManager.add({
    id: APP_TOAST_SLOT_ID,
    // Base UI merges stable-id updates. Always publish optional fields so a
    // short follow-up notice cannot inherit the previous description, action,
    // or extended timeout.
    description: options.description ? t(options.description) : undefined,
    timeout: Math.min(options.timeout ?? defaultTimeout, maxTimeout),
    actionProps: options.actionProps,
    onRemove: () => {
      if (activeToastKey === toastKey) activeToastKey = undefined;
    },
    title: t(message),
    type
  });
}

export function closeToast(key?: string): void {
  if (key && activeToastKey !== key) return;
  activeToastKey = undefined;
  toastManager.close(APP_TOAST_SLOT_ID);
}

export function showErrorToast(title: string, error: unknown, key?: string, options: ShowToastOptions = {}): void {
  showToast(title, 'error', key, {
    ...options,
    description: userErrorMessage(error, options.description
      ?? t('操作未完成。请检查相关地址、权限或配置后重试；如果仍失败，再打开“诊断与修复”查看详细信息。')),
    timeout: options.timeout
  });
}
