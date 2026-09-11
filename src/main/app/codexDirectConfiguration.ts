import { selectedProvider, XwXDeckSettingsStore } from './settings';
import { CodexConfigManager } from '../trace/codexConfigManager';
import { CodexOfficialAuthManager } from '../trace/codexOfficialAuthManager';

/** Standalone registry semantics only. Protocol bridges need the Gateway;
 * restore official direct for those, retaining the selection for next launch. */
export async function restoreCodexPreferredDirectConfiguration(userDataDir: string): Promise<{ restoredFields: number; conflicts: string[] }> {
  const store = new XwXDeckSettingsStore(userDataDir);
  const settings = await store.read();
  if (store.readProblem()) throw store.readProblem();
  const manager = new CodexConfigManager(userDataDir);
  const current = await manager.read();
  const provider = selectedProvider(settings, 'codex');
  const useDirect = settings.codexPreferredMode !== 'official' && current.mode === 'compatible'
    && provider && (provider.adapter === 'responses' || provider.adapter === 'auto' && provider.codexApiFormat === 'responses');
  // The direct custom provider carries its own scoped key. auth.json remains
  // the user's official login, including when preservation was disabled in UI.
  await new CodexOfficialAuthManager(userDataDir).restoreOfficialLogin();
  return manager.restoreDirectConfiguration({
    officialBaseUrl: await manager.readOfficialBaseUrl(),
    officialModel: settings.codexModels.official,
    officialContextWindow: settings.codexModels.officialContextWindow,
    ...(useDirect ? { direct: { baseUrl: provider.baseUrl, bearerToken: provider.bearerToken, model: provider.codexModel,
      contextWindow: provider.codexContextWindow, displayName: provider.displayName } } : {})
  });
}
