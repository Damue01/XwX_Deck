import type { ModelCatalogEntry } from './modelCatalog';
import type { ProviderConnection } from '../../shared/providers';

export type CodexProtocol = 'responses' | 'chat-completions' | 'anthropic-messages';
type ProtocolConnection = Pick<ProviderConnection, 'codexApiFormat'> & Partial<Pick<ProviderConnection, 'adapter'>>;

/** Use the same precedence as the Gateway's model route, including automatic providers. */
export function providerRequiresTrace(
  provider: ProtocolConnection | undefined,
  modelId: string,
  catalog: readonly ModelCatalogEntry[] = []
): boolean {
  return resolveProviderCodexProtocol(provider, modelId, catalog) !== 'responses';
}

export function resolveProviderCodexProtocol(
  provider: ProtocolConnection | undefined,
  modelId: string,
  catalog: readonly ModelCatalogEntry[] = []
): CodexProtocol {
  const entry = catalog.find(model => model.id === modelId);
  const fallback = provider?.codexApiFormat ?? 'responses';
  if (!entry) return fallback;
  if (entry.protocolsDeclared) return resolveCatalogCodexProtocol(entry, fallback);
  // An Anthropic-only directory publishes a Messages route. A generic OpenAI
  // directory does not distinguish Responses from Chat: keep its connection default.
  if (entry.catalogEndpoints) {
    return entry.catalogEndpoints.includes('anthropic') && !entry.catalogEndpoints.includes('openai')
      ? 'anthropic-messages' : fallback;
  }
  // Older caches retained Anthropic endpoint membership in Claude-only protocol entries.
  // Preserve that evidence without trusting model-name protocol guesses.
  const legacyCompatibleService = !provider?.adapter || provider.adapter === 'auto';
  return legacyCompatibleService && entry.clients.includes('claude') && entry.protocols.length === 1
    && entry.protocols.includes('anthropic-messages') ? 'anthropic-messages' : fallback;
}

/**
 * Codex speaks Responses. Use it whenever published, regardless of model name;
 * otherwise select an existing bridge. Missing metadata uses the connection.
 */
export function resolveCatalogCodexProtocol(entry: ModelCatalogEntry, fallback: CodexProtocol = 'responses'): CodexProtocol {
  const protocols = new Set(entry.protocols);
  if (protocols.has('openai-responses')) return 'responses';
  if (protocols.has('chat-completions')) return 'chat-completions';
  if (protocols.has('anthropic-messages')) return 'anthropic-messages';
  return fallback;
}

/** Models whose published purpose is not a conversational coding-agent turn. */
export function isKnownNonConversationalModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return /^text-embedding(?:-|$)/.test(normalized)
    || /^gpt-image(?:-|$)/.test(normalized)
    || normalized === 'qwen-vl-ocr';
}

/** Conservative boundary for models accepted by the official ChatGPT/OpenAI service. */
export function isOfficialCodexModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (normalized === 'codex-auto-review') return false;
  return /^(?:gpt-|chatgpt-|codex-|computer-use-|o\d(?:-|$))/.test(normalized);
}
