import { providerProfile } from '../../shared/providerProfiles';
import type { ProviderConnection } from '../../shared/providers';
import { fetchCompatibleServiceModelCatalog, normalizeModelCatalog, type ModelCatalogEntry } from './modelCatalog';
import { enrichModelCatalog, enrichModelCatalogCacheFirst } from './modelCapabilities';

export async function fetchProviderCatalog(
  provider: ProviderConnection,
  capabilityCachePath?: string,
  forceCapabilityRefresh = false,
  fallbackCatalog: readonly ModelCatalogEntry[] = []
): Promise<readonly ModelCatalogEntry[]> {
  const anthropic = provider.adapter === 'anthropic-messages';
  if (!anthropic) {
    return fetchCompatibleServiceModelCatalog(provider.baseUrl, provider.bearerToken, fetch,
      capabilityCachePath, fallbackCatalog, {
        catalogMode: providerProfile(provider.providerPreset).modelCatalogMode,
        forceCapabilityRefresh
      });
  }
  const response = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/models`, {
    headers: { 'x-api-key': provider.bearerToken, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) {
    if (response.status === 404 || response.status === 405) return [];
    throw new Error(`${provider.displayName} 模型列表请求失败：HTTP ${response.status}`);
  }
  const payload = await response.json() as { data?: { id?: unknown; protocols?: unknown }[] };
  if (!Array.isArray(payload.data)) throw new Error('服务没有返回有效模型列表。');
  const models: ModelCatalogEntry[] = payload.data.filter(row => typeof row?.id === 'string' && row.id.trim()).map(row => {
    const protocols = normalizeModelCatalog([row])[0]?.protocols.filter(protocol => protocol !== 'gemini') ?? [];
    return {
      id: (row.id as string).trim(), vendor: provider.displayName,
      protocols: protocols.length
        ? protocols
        : [provider.codexApiFormat === 'responses' ? 'openai-responses' : provider.codexApiFormat],
      protocolsDeclared: protocols.length > 0,
      catalogEndpoints: [],
      clients: anthropic ? ['claude', 'codex'] : provider.adapter === 'auto' ? ['codex', 'claude'] : provider.adapter === 'chat-completions' ? ['codex'] : ['codex']
    };
  });
  if (!models.length) throw new Error('服务没有返回可用模型。');
  if (!capabilityCachePath) return models;
  return forceCapabilityRefresh
    ? enrichModelCatalog(models, fetch, capabilityCachePath)
    : enrichModelCatalogCacheFirst(models, fetch, capabilityCachePath);
}
