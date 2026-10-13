import * as React from 'react';
import type { XwXDeckApi } from '@/bridge/types';
import type { ServiceSwitchingClient, ServiceSwitchingConfig, ServiceSwitchingPolicy } from '../../../shared/serviceSwitching';

interface Store {
  version: number; policies: ServiceSwitchingConfig; loaded: boolean; loadError: string;
  pending: Map<ServiceSwitchingClient, ServiceSwitchingPolicy>; saving: Set<ServiceSwitchingClient>;
  errors: Partial<Record<ServiceSwitchingClient, string>>; listeners: Set<() => void>;
}
const stores = new WeakMap<XwXDeckApi, Store>();
/** Serialize each client's writes; drafts and retry survive dialog navigation. */
export function useServiceSwitching(api: XwXDeckApi) {
  const store = React.useMemo(() => {
    let value = stores.get(api);
    if (!value) { value = { version: 0, policies: {}, loaded: false, loadError: '', pending: new Map(), saving: new Set(), errors: {}, listeners: new Set() }; stores.set(api, value); }
    return value;
  }, [api]);
  const publish = React.useCallback(() => { store.version++; store.listeners.forEach(fn => fn()); }, [store]);
  const subscribe = React.useCallback((fn: () => void) => { store.listeners.add(fn); return () => { store.listeners.delete(fn); }; }, [store]);
  const snapshot = React.useCallback(() => store.version, [store]);
  React.useSyncExternalStore(subscribe, snapshot, snapshot);
  const load = React.useCallback(async () => {
    try {
      if (!api.getServiceSwitching) throw new Error('当前版本不支持服务切换');
      const saved = await api.getServiceSwitching();
      store.policies = { ...saved, ...Object.fromEntries(store.pending) }; store.loaded = true; store.loadError = '';
    } catch (error) { store.loadError = error instanceof Error ? error.message : String(error); }
    publish();
  }, [api, store, publish]);
  React.useEffect(() => { if (!store.loaded) void load(); }, [store, load]);
  const persist = async (client: ServiceSwitchingClient) => {
    if (store.saving.has(client)) return;
    store.saving.add(client);
    try {
      while (store.pending.has(client)) {
        const next = store.pending.get(client)!;
        if (!api.setServiceSwitching) throw new Error('当前版本不支持服务切换');
        await api.setServiceSwitching({ client, policy: next });
        if (store.pending.get(client) === next) store.pending.delete(client);
        store.errors[client] = ''; publish();
      }
    } catch (error) { store.errors[client] = error instanceof Error ? error.message : String(error); publish(); }
    finally { store.saving.delete(client); }
  };
  return {
    ...store, reload: load,
    save: (client: ServiceSwitchingClient, policy: ServiceSwitchingPolicy) => {
      store.policies = { ...store.policies, [client]: policy }; store.pending.set(client, policy); publish(); void persist(client);
    },
    retry: (client: ServiceSwitchingClient) => { void persist(client); }
  };
}
