import type { ProviderConnection } from '../../shared/providers';
import { fetchCompatibleServiceModelCatalog, type ModelCatalogEntry } from './modelCatalog';
import { providerProfile } from '../../shared/providerProfiles';
import { enrichModelCatalog } from './modelCapabilities';

export async function fetchProviderCatalog(provider: ProviderConnection, capabilityCachePath?: string): Promise<readonly ModelCatalogEntry[]> {
  if (provider.adapter === 'auto') {
    return fetchCompatibleServiceModelCatalog(provider.baseUrl, provider.bearerToken, fetch, capabilityCachePath, [], { catalogMode: providerProfile(provider.providerPreset).modelCatalogMode });
  }
  const anthropic = provider.adapter === 'anthropic-messages';
  const response = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/models`, {
    headers: anthropic
      ? { 'x-api-key': provider.bearerToken, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${provider.bearerToken}` },
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) {
    if (response.status === 404 || response.status === 405) return [];
    throw new Error(`${provider.displayName} 模型列表请求失败：HTTP ${response.status}`);
  }
  const payload = await response.json() as { data?: { id?: unknown }[] };
  if (!Array.isArray(payload.data)) throw new Error('服务没有返回有效模型列表。');
  const models: ModelCatalogEntry[] = payload.data.filter(row => typeof row?.id === 'string').map(row => ({
    id: row.id as string, vendor: provider.displayName,
    protocols: [anthropic ? 'anthropic-messages' : provider.adapter === 'responses' ? 'openai-responses' : 'chat-completions'],
    clients: anthropic ? ['claude', 'codex'] : provider.adapter === 'chat-completions' ? ['codex'] : ['codex']
  }));
  if (!models.length) throw new Error('服务没有返回可用模型。');
  return capabilityCachePath ? enrichModelCatalog(models, fetch, capabilityCachePath) : models;
}
