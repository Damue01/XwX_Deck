import * as React from 'react';
import { useBridge } from '@/bridge/store';
import type { ClientInstallationSnapshot } from '../../../shared/clientDownloads';
import { normalizeErrorMessage } from '../../../shared/errors';

export function useClientInstallations(visible: boolean) {
  const { api } = useBridge();
  const [snapshot, setSnapshot] = React.useState<ClientInstallationSnapshot | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [slow, setSlow] = React.useState(false);
  const [error, setError] = React.useState('');
  const generation = React.useRef(0);
  const pending = React.useRef<Promise<ClientInstallationSnapshot | undefined> | null>(null);
  const refresh = React.useCallback(() => {
    if (pending.current) return pending.current;
    const request = ++generation.current;
    setChecking(true);
    setSlow(false);
    setError('');
    const operation = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => api.detectClientInstallations?.() ?? { available: false, clients: [] }).then(result => {
            // A native dialog or startup work can delay the bridge. Accept its
            // eventual result until the user starts a newer detection or leaves.
            if (request === generation.current) { setSnapshot(result); setError(''); setSlow(false); }
            return result;
          }),
          new Promise<undefined>(resolve => { timer = setTimeout(() => {
            if (request === generation.current) setSlow(true);
            resolve(undefined);
          }, 8000); }),
        ]);
        if (result && request === generation.current) { setSnapshot(result); return result; }
      } catch (failure) {
        // A failed read is not evidence that a previously detected client disappeared.
        if (request === generation.current) { setError(normalizeErrorMessage(failure)); setSlow(false); }
      } finally {
        clearTimeout(timer);
        if (request === generation.current) { pending.current = null; setChecking(false); }
      }
    })();
    pending.current = operation;
    return operation;
  }, [api]);
  React.useEffect(() => {
    if (!visible) { setChecking(false); setSlow(false); return; }
    void refresh();
    const focused = () => { void refresh(); };
    window.addEventListener('focus', focused);
    return () => { generation.current++; pending.current = null; window.removeEventListener('focus', focused); };
  }, [visible, refresh]);
  return { snapshot, checking, slow, error, refresh };
}
