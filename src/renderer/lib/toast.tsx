import type React from 'react';
import { ToastProvider, toastManager } from '@/components/ui/toast';

export { ToastProvider };

const APP_TOAST_SLOT_ID = 'xwx-deck-notification';
let activeToastKey: string | undefined;

interface ShowToastOptions {
  readonly description?: string;
  readonly timeout?: number;
  readonly actionProps?: React.ComponentPropsWithoutRef<'button'>;
}

export function showToast(
  message: string,
  type: 'error' | 'info' | 'success' = 'info',
  key?: string,
  options: ShowToastOptions = {}
): void {
  const toastKey = key ?? `${type}:${message}`;
  activeToastKey = toastKey;
  toastManager.add({
    id: APP_TOAST_SLOT_ID,
    // Base UI merges stable-id updates. Always publish optional fields so a
    // short follow-up notice cannot inherit the previous description, action,
    // or extended timeout.
    description: options.description,
    timeout: options.timeout,
    actionProps: options.actionProps,
    onRemove: () => {
      if (activeToastKey === toastKey) activeToastKey = undefined;
    },
    title: message,
    type
  });
}

export function closeToast(key?: string): void {
  if (key && activeToastKey !== key) return;
  activeToastKey = undefined;
  toastManager.close(APP_TOAST_SLOT_ID);
}
