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
  // Directory membership is evidence; vendor/name-based routing is not.
  if (entry.catalogEndpoints) {
    if (!entry.catalogEndpoints.includes('openai')) {
      return entry.catalogEndpoints.includes('anthropic') ? 'anthropic-messages' : fallback;
    }
    // An explicit connection protocol outranks enrichment from third-party
    // registries, which may lag behind the service's current API support.
    return provider?.adapter && provider.adapter !== 'auto'
      ? fallback : officialOpenAiProtocol(entry, fallback) ?? fallback;
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

export type ClaudeModelProtocol = 'anthropic-messages' | 'responses' | 'chat-completions';

/**
 * How a Claude client reaches this model. Messages is native; Responses and
 * Chat Completions go through the local Gateway's Messages bridge (needs Trace).
 * Undefined: the model cannot serve a Claude conversation.
 */
export function resolveClaudeModelProtocol(
  provider: Partial<Pick<ProviderConnection, 'adapter' | 'codexApiFormat'>> | undefined,
  entry: ModelCatalogEntry
): ClaudeModelProtocol | undefined {
  if (isKnownNonConversationalModel(entry.id)) return undefined;
  const protocols = new Set(entry.protocols);
  if (protocols.has('anthropic-messages')) return 'anthropic-messages';
  // A Messages-only connection has no OpenAI endpoint to bridge to.
  if (provider?.adapter === 'anthropic-messages') return undefined;
  if (protocols.has('openai-responses')) return 'responses';
  if (protocols.has('chat-completions')) return 'chat-completions';
  if (entry.protocolsDeclared || protocols.size) return undefined;
  // Missing protocol metadata keeps the current connection default.
  if (entry.catalogEndpoints?.includes('openai')) {
    const preferred = provider?.codexApiFormat === 'chat-completions' ? 'chat-completions' : 'responses';
    return provider?.adapter && provider.adapter !== 'auto'
      ? preferred : officialOpenAiProtocol(entry, preferred) ?? preferred;
  }
  return undefined;
}

/**
 * The OpenAI protocol the model's official API publishes, preferring the
 * connection's choice when both are available. Undefined when unknown.
 */
function officialOpenAiProtocol(
  entry: ModelCatalogEntry,
  preferred: CodexProtocol
): 'responses' | 'chat-completions' | undefined {
  const official = new Set(entry.officialProtocols ?? []);
  const responses = official.has('openai-responses');
  const chat = official.has('chat-completions');
  if (preferred === 'chat-completions' && chat) return 'chat-completions';
  if (responses) return 'responses';
  return chat ? 'chat-completions' : undefined;
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
