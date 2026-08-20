import { ToastProvider, toastManager } from '@/components/ui/toast';

export { ToastProvider };

export function showToast(
  message: string,
  type: 'error' | 'info' | 'success' = 'info',
  id?: string
): void {
  toastManager.add({ ...(id ? { id } : {}), title: message, type });
}
