import { t } from '@/lib/i18n';
import * as React from 'react';
import { useBridge } from '@/bridge/store';
import type { ClientInstallationSnapshot } from '../../../shared/clientDownloads';
import { normalizeErrorMessage } from '../../../shared/errors';

export function useClientInstallations(visible: boolean) {
  const { api } = useBridge();
  const [snapshot, setSnapshot] = React.useState<ClientInstallationSnapshot | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState('');
  const generation = React.useRef(0);
  const refresh = React.useCallback(async () => {
    const request = ++generation.current;
    setChecking(true);
    setError('');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        api.detectClientInstallations?.() ?? Promise.resolve({ available: false, clients: [] }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(t('检测超时，请重新检测'))), 8000); }),
      ]);
      if (request === generation.current) { setSnapshot(result); return result; }
    } catch (failure) {
      if (request === generation.current) { setSnapshot(null); setError(normalizeErrorMessage(failure)); }
    } finally {
      clearTimeout(timer);
      if (request === generation.current) setChecking(false);
    }
  }, [api]);
  React.useEffect(() => {
    if (!visible) return;
    void refresh();
    const focused = () => { void refresh(); };
    window.addEventListener('focus', focused);
    return () => { generation.current++; window.removeEventListener('focus', focused); };
  }, [visible, refresh]);
  return { snapshot, checking, error, refresh };
}
