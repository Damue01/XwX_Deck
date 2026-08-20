/**
 * 兼容服务's `/v1/models` response is the standard OpenAI list shape and does
 * not publish per-model protocol capabilities.  The provider policy confirmed
 * for this connection is therefore authoritative: only the GPT family
 * implements Responses natively; every other model needs the local bridge.
 *
 * Grok was previously treated as Responses-native, but xAI's Responses
 * implementation rejects Codex's `type: "custom"` tool variant with
 * "unknown variant `custom`", breaking the stream.  Routing Grok through the
 * local Chat Completions bridge lets `buildCodexToolContext` flatten custom
 * tools to plain functions before they reach xAI.
 */
import type { ModelCatalogEntry } from './modelCatalog';
import { findOfficialModelRecord } from './officialModelRegistry';

export type CodexProtocol = 'responses' | 'chat-completions' | 'anthropic-messages';

export function resolveCompatibleServiceCodexProtocol(modelId: string): CodexProtocol {
  const normalized = modelId.trim().toLowerCase();
  if (/^(?:claude-|anthropic\/claude-)/.test(normalized)) return 'anthropic-messages';
  // 兼容服务's private review route was verified on 2026-07-28 against a
  // Responses request containing Codex's `type: "custom"` tool variant.
  if (normalized === 'codex-auto-review') return 'responses';
  return /^gpt-/.test(normalized) ? 'responses' : 'chat-completions';
}

/**
 * Prefer the protocol native to a model family when 兼容服务 exposes the same
 * model through several directories. A single explicit server protocol remains
 * authoritative; name inference is only the final fallback.
 */
export function resolveCatalogCodexProtocol(entry: ModelCatalogEntry): CodexProtocol {
  const protocols = new Set(entry.protocols);
  const normalized = entry.id.trim().toLowerCase();
  const isClaude = entry.vendor.trim().toLowerCase() === 'anthropic'
    || /^(?:claude-|anthropic\/claude-)/.test(normalized);
  if (isClaude && protocols.has('anthropic-messages')) return 'anthropic-messages';

  const codexProtocols = [
    protocols.has('openai-responses') ? 'responses' as const : undefined,
    protocols.has('chat-completions') ? 'chat-completions' as const : undefined,
    protocols.has('anthropic-messages') ? 'anthropic-messages' as const : undefined
  ].filter((value): value is CodexProtocol => !!value);
  if (codexProtocols.length === 1) return codexProtocols[0];

  const officialRoute = findOfficialModelRecord(entry.id)?.codexRecommendedProtocol;
  const officialRoutePublished = officialRoute === 'responses'
    ? protocols.has('openai-responses')
    : officialRoute ? protocols.has(officialRoute) : false;
  if (officialRoute && (!entry.protocols.length || officialRoutePublished)) return officialRoute;

  if (normalized === 'codex-auto-review' && protocols.has('openai-responses')) return 'responses';
  if (/^gpt-/.test(normalized) && protocols.has('openai-responses')) return 'responses';
  if (protocols.has('chat-completions')) return 'chat-completions';
  if (protocols.has('anthropic-messages')) return 'anthropic-messages';
  if (protocols.has('openai-responses')) return 'responses';
  // 兼容服务's generic /v1/models list historically tags both OpenAI
  // endpoints without per-model truth. Keep the temporary family fallback for
  // that ambiguous shape until the service publishes authoritative metadata.
  return resolveCompatibleServiceCodexProtocol(entry.id);
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
