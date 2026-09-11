import { ToastProvider, toastManager } from '@/components/ui/toast';

export { ToastProvider };

export function showToast(
  message: string,
  type: 'error' | 'info' | 'success' = 'info',
  id?: string,
  options: { readonly description?: string; readonly timeout?: number } = {}
): void {
  toastManager.add({
    ...(id ? { id } : {}),
    ...(options.description ? { description: options.description } : {}),
    ...(options.timeout ? { timeout: options.timeout } : {}),
    title: message,
    type
  });
}
