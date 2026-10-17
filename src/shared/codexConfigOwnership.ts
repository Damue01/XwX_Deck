/**
 * Who authored the ChatGPT configuration that is on disk right now.
 *
 * This answers one question only: may XwX Deck rewrite the root-level fields
 * without asking? The previous implementation was a white list — the config
 * counted as ours only when the active provider was literally `xwx_deck` and
 * the base URL was literally `${localBaseUrl}/backend-api/codex`. Deck legally
 * writes several other shapes (`openai` for official mode, `/backend-api` for
 * ChatGPT OAuth, `/v1` for the compatibility route, plus every provider id
 * derived from the user's own connections), so those shapes were misread as
 * "another tool took over" and produced a takeover prompt nobody asked for.
 *
 * The rule is inverted here: `external` must be *positively* evidenced, and the
 * caller supplies the full set of identities Deck itself could have written.
 */
export type CodexConfigOwnership = 'deck' | 'external';

export interface CodexOwnershipFacts {
  readonly activeProvider: string;
  readonly activeBaseUrl: string;
  readonly modelCatalogSource: 'none' | 'xwx' | 'external';
  /** Every provider id Deck may legitimately have written, built-ins included. */
  readonly deckProviderIds: readonly string[];
  /** Local Gateway base URLs this installation manages (no path suffix). */
  readonly managedLocalBaseUrls: readonly string[];
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

function normalize(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

function isLoopback(value: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * A base URL under a Deck-owned provider still has to point at a Gateway this
 * installation actually runs. A loopback address on some other port is either
 * another tool reusing our provider name or a stale route from an older run —
 * either way Deck must not overwrite it silently.
 */
function loopbackIsManaged(baseUrl: string, managedLocalBaseUrls: readonly string[]): boolean {
  const target = normalize(baseUrl);
  return managedLocalBaseUrls.some(local => {
    const prefix = normalize(local);
    return prefix.length > 0 && (target === prefix || target.startsWith(`${prefix}/`));
  });
}

export function resolveCodexConfigOwnership(facts: CodexOwnershipFacts): CodexConfigOwnership {
  // A foreign model catalog is the one unambiguous marker of another manager:
  // Deck only ever publishes its own pointer, never someone else's.
  if (facts.modelCatalogSource === 'external') return 'external';
  const provider = facts.activeProvider.trim();
  if (!provider) return 'deck';
  const ours = facts.deckProviderIds.some(id => id.trim() && id.trim() === provider);
  if (!ours) return 'external';
  const baseUrl = facts.activeBaseUrl.trim();
  if (!baseUrl || !isLoopback(baseUrl)) return 'deck';
  return loopbackIsManaged(baseUrl, facts.managedLocalBaseUrls) ? 'deck' : 'external';
}

/** Prompt for explicit consent and a backup only for a positively external config. */
export function codexConfigNeedsTakeover(facts: CodexOwnershipFacts): boolean {
  return resolveCodexConfigOwnership(facts) === 'external';
}
