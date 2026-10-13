import * as React from 'react';
import type { XwXDeckApi } from '@/bridge/types';
import type { ProviderSnapshot } from '../../../shared/providers';
import type { ServiceSwitchingClient } from '../../../shared/serviceSwitching';
interface Draft { version: number; values: Record<string, string>; error: string; saving: boolean; listeners: Set<() => void>; }
const stores = new WeakMap<XwXDeckApi, Map<string, Draft>>();
/** Failed model choices survive closing the card, without changing the active service. */
export function useProviderModelDraft(api: XwXDeckApi, providerId: string, client: ServiceSwitchingClient, onSaved: (providers: ProviderSnapshot) => void) {
  const store = React.useMemo(() => {
    let providers = stores.get(api);
    if (!providers) { providers = new Map(); stores.set(api, providers); }
    const key = `${client}:${providerId}`;
    let draft = providers.get(key);
    if (!draft) { draft = { version: 0, values: {}, error: '', saving: false, listeners: new Set() }; providers.set(key, draft); }
    return draft;
  }, [api, providerId, client]);
  const subscribe = React.useCallback((fn: () => void) => { store.listeners.add(fn); return () => { store.listeners.delete(fn); }; }, [store]);
  const snapshot = React.useCallback(() => store.version, [store]);
  React.useSyncExternalStore(subscribe, snapshot, snapshot);
  const publish = () => { store.version++; store.listeners.forEach(fn => fn()); };
  const save = async (role: string, model: string) => {
    if (store.saving) return;
    store.values = { ...store.values, [role]: model }; store.saving = true; publish();
    try {
      if (!api.updateProviderClientModel) throw new Error('当前版本不支持保存备用模型');
      onSaved(await api.updateProviderClientModel({ providerId, client, model, role: client === 'claude' ? role : undefined }));
      delete store.values[role]; store.error = '';
    } catch (failure) { store.error = failure instanceof Error ? failure.message : String(failure); }
    finally { store.saving = false; publish(); }
  };
  return { draft: store.values, error: store.error, saving: store.saving, save, retry: () => { const entry = Object.entries(store.values)[0]; if (entry) void save(...entry); } };
}
