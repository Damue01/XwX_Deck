import * as React from 'react';
import type { XwXDeckApi } from '@/bridge/types';
import type { SubscriptionAccountsSnapshot, SubscriptionRoutingGroup, SubscriptionRoutingPolicy } from '../../../shared/subscriptionAccounts';

type Policies = Partial<Record<SubscriptionRoutingGroup, SubscriptionRoutingPolicy>>;
interface DraftStore {
  version: number; drafts: Policies; errors: Partial<Record<SubscriptionRoutingGroup, string>>;
  pending: Map<SubscriptionRoutingGroup, SubscriptionRoutingPolicy>;
  saving: Set<SubscriptionRoutingGroup>; listeners: Set<() => void>;
}
// Metadata drafts survive closing the dialog and switching service cards.
// Each native bridge owns its own store; credentials never enter it.
const stores = new WeakMap<XwXDeckApi, DraftStore>();
export function useSubscriptionPolicies(api: XwXDeckApi, onSnapshot: (value: SubscriptionAccountsSnapshot) => void) {
  const store = React.useMemo(() => {
    let value = stores.get(api);
    if (!value) { value = { version: 0, drafts: {}, errors: {}, pending: new Map(), saving: new Set(), listeners: new Set() }; stores.set(api, value); }
    return value;
  }, [api]);
  const subscribe = React.useCallback((listener: () => void) => { store.listeners.add(listener); return () => { store.listeners.delete(listener); }; }, [store]);
  const version = React.useCallback(() => store.version, [store]);
  React.useSyncExternalStore(subscribe, version, version);
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const publish = () => { store.version++; store.listeners.forEach(listener => listener()); };
  const persist = async (group: SubscriptionRoutingGroup) => {
    if (store.saving.has(group)) return;
    store.saving.add(group);
    try {
      while (store.pending.has(group)) {
        const next = store.pending.get(group)!;
        if (!api.setSubscriptionRouting) throw new Error('当前版本不支持账号策略');
        const saved = await api.setSubscriptionRouting({ platform: group, policy: next });
        if (store.pending.get(group) === next) { store.pending.delete(group); if (mounted.current) onSnapshot(saved); }
        store.errors = { ...store.errors, [group]: '' }; publish();
      }
    } catch (failure) { store.errors = { ...store.errors, [group]: failure instanceof Error ? failure.message : String(failure) }; publish(); }
    finally { store.saving.delete(group); }
  };
  return {
    drafts: store.drafts, errors: store.errors,
    save: (group: SubscriptionRoutingGroup, policy: SubscriptionRoutingPolicy) => {
      store.drafts = { ...store.drafts, [group]: policy }; store.pending.set(group, policy); publish(); void persist(group);
    },
    retry: (group: SubscriptionRoutingGroup) => { void persist(group); }
  };
}
