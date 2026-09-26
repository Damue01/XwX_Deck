import { selectedProvider, XwXDeckSettingsStore } from './settings';
import { providerCodexId, providerDirectConnections } from '../../shared/providers';
import { restoreCodexPreferredDirectConfiguration as restorePreferred } from '../trace/codexPreferredDirect';

/** Restore the saved connection without replacing the user's service choice. */
export async function restoreCodexPreferredDirectConfiguration(userDataDir: string): Promise<{ restoredFields: number; conflicts: string[] }> {
  const store = new XwXDeckSettingsStore(userDataDir);
  const settings = await store.read();
  if (store.readProblem()) throw new Error(store.readProblem()!.message);
  const provider = selectedProvider(settings, 'codex');
  const result = await restorePreferred(userDataDir, {
    preferredMode: settings.codexPreferredMode,
    officialModel: settings.codexModels.official,
    compatibleModel: provider?.codexModel ?? '',
    compatibleContextWindow: provider?.codexContextWindow ?? 0,
    compatibleBaseUrl: provider?.baseUrl ?? '',
    compatibleBearerToken: provider?.bearerToken ?? '',
    providerAdapter: provider?.adapter,
    providerId: provider && providerCodexId(provider, settings.codexEnhancements.unifySessionHistory),
    providerName: provider?.displayName,
    unifySessionHistory: settings.codexEnhancements.unifySessionHistory,
    directProviders: providerDirectConnections(settings.providers?.connections)
  });
  return { restoredFields: result.restoredFields, conflicts: [...result.conflicts] };
}
