/**
 * Capabilities measured against the live 兼容服务 gateway.
 *
 * This layer exists because vendor docs and aggregator directories both answer
 * a different question than the one that matters at request time. A vendor page
 * describes the model's own API; models.dev and LiteLLM describe what some
 * catalog believes; neither observes what the configured gateway actually does.
 * `tools/probe-reasoning-contract.mjs` does observe it, so its results outrank
 * the aggregators — but never a cited model-owner page, which stays
 * authoritative in `officialModelRegistry.ts`.
 *
 * Only record what a probe directly observed, and only fields the probe can
 * actually establish. Reasoning is observable: the response reports reasoning
 * tokens. Context windows and prices are not, and must not appear here.
 *
 * Re-run the probe and update `verifiedAt` whenever an entry is revisited; a
 * stale measurement is worse than none because it looks like evidence.
 */
export interface ProbedModelCapability {
  /** Observed emitting reasoning tokens. */
  readonly reasoning?: boolean;
  readonly verifiedAt: `${number}-${number}-${number}`;
  /** How the observation was made, so a reader can reproduce or refute it. */
  readonly evidence: string;
}

const REASONING_TOKENS_OBSERVED = 'emitted reasoning tokens on a trivial prompt via tools/probe-reasoning-contract.mjs';

/**
 * These ids are marked non-reasoning by models.dev/LiteLLM, which would
 * otherwise win the merge and leave their Codex effort picker empty even though
 * the gateway demonstrably reasons for them. `doubao-seed-character` is
 * deliberately absent: it accepted every reasoning control parameter in the
 * same probe while never emitting a reasoning token, so a family-wide rule
 * would have handed it a picker it cannot honour.
 */
export const PROBED_MODEL_CAPABILITIES: Readonly<Record<string, ProbedModelCapability>> = {
  'doubao-seed-1-6-flash': { reasoning: true, verifiedAt: '2026-08-19', evidence: REASONING_TOKENS_OBSERVED },
  'doubao-seed-1-6-vision': { reasoning: true, verifiedAt: '2026-08-19', evidence: REASONING_TOKENS_OBSERVED },
  'doubao-seed-2-1-pro': { reasoning: true, verifiedAt: '2026-08-19', evidence: REASONING_TOKENS_OBSERVED },
  'doubao-seed-2-1-turbo': { reasoning: true, verifiedAt: '2026-08-19', evidence: REASONING_TOKENS_OBSERVED },
  'kimi-k3-external': { reasoning: true, verifiedAt: '2026-08-19', evidence: REASONING_TOKENS_OBSERVED }
};

/** Resolve after the same normalization the other registries use. */
export function findProbedModelCapability(model: string): ProbedModelCapability | undefined {
  const id = model.trim().toLowerCase().replace(/^models\//, '');
  const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  const normalized = bare.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  for (const [key, value] of Object.entries(PROBED_MODEL_CAPABILITIES)) {
    if (key.replace(/[^a-z0-9]+/g, '-') === normalized) return value;
  }
  return undefined;
}
