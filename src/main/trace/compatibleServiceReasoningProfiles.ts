/**
 * 兼容服务's verified Chat Completions reasoning contract.
 *
 * Capability directories tell us whether a model can reason. These profiles
 * separately describe the field spelling accepted by the active 兼容服务
 * gateway. `omit` is intentional: the model either has fixed reasoning or the
 * gateway did not expose a reliable control, so guessing would be less correct
 * than sending no control at all.
 */
export interface CompatibleServiceReasoningProfile {
  readonly mode: 'control' | 'omit';
  readonly supportsThinking: boolean;
  readonly supportsEffort: boolean;
  readonly thinkingParam: 'thinking' | 'enable_thinking' | 'reasoning_split' | 'none';
  /**
   * The value that turns thinking ON for `thinkingParam: 'thinking'`. MiniMax
   * rejects `enabled` outright — probed 2026-08-19, the gateway answers
   * `400 invalid thinking.type: "enabled" (allowed: adaptive, disabled)` — so
   * the family that only understands `adaptive` must say so explicitly.
   */
  readonly thinkingOnValue?: 'enabled' | 'adaptive';
  readonly effortParam: 'reasoning_effort' | 'reasoning.effort' | 'none';
  readonly effortValueMode?: 'deepseek' | 'low_high' | 'openrouter' | 'passthrough';
  /**
   * Effort levels this model may advertise, in picker order. Every entry must
   * produce a different outbound request and must not be rejected by the
   * gateway — both established by `tools/dev/probe-reasoning-contract.mjs`. `none`
   * belongs here whenever thinking can be switched off, even for models that
   * reject the literal `reasoning_effort: "none"`: the bridge expresses off
   * through the toggle instead.
   */
  readonly levels?: readonly string[];
  readonly defaultLevel?: string;
  readonly defaultReasoning?: boolean;
  readonly verifiedAt: '2026-07-27' | '2026-08-19';
}

/** Off plus three tiers is the widest ladder every probed family accepted. */
const LADDER = ['none', 'low', 'medium', 'high'] as const;
const LADDER_XHIGH = [...LADDER, 'xhigh'] as const;
const LADDER_MAX = [...LADDER_XHIGH, 'max'] as const;

const OMIT: CompatibleServiceReasoningProfile = {
  mode: 'omit',
  supportsThinking: false,
  supportsEffort: false,
  thinkingParam: 'none',
  effortParam: 'none',
  verifiedAt: '2026-07-27'
};

const THINKING: CompatibleServiceReasoningProfile = {
  mode: 'control',
  supportsThinking: true,
  supportsEffort: false,
  thinkingParam: 'thinking',
  effortParam: 'none',
  verifiedAt: '2026-07-27'
};

const ENABLE_THINKING: CompatibleServiceReasoningProfile = {
  mode: 'control',
  supportsThinking: true,
  supportsEffort: false,
  thinkingParam: 'enable_thinking',
  effortParam: 'none',
  verifiedAt: '2026-07-27'
};

const REASONING_EFFORT: CompatibleServiceReasoningProfile = {
  mode: 'control',
  supportsThinking: false,
  supportsEffort: true,
  thinkingParam: 'none',
  effortParam: 'reasoning_effort',
  effortValueMode: 'passthrough',
  verifiedAt: '2026-07-27'
};

/**
 * Toggle plus a real effort ladder. The two fields do different jobs: the
 * toggle only says on or off, the effort says how deep. Sending the toggle
 * alone is what collapsed every level into one identical request.
 *
 * `thinking` is deliberately preferred over `enable_thinking`: probed
 * 2026-08-19, `enable_thinking: false` returns 200 on `kimi-k3` and
 * `MiniMax-M3` while the model keeps reasoning, so it fails silently and the
 * user still pays for the thinking they asked to switch off.
 *
 * Effort values pass through verbatim. Remapping them locally (the old
 * DeepSeek mode folded medium, high and xhigh onto `high`) would recreate the
 * duplicate-level problem inside the very layer meant to remove it.
 */
function thinkingWithEffort(
  levels: readonly string[],
  defaultLevel: string,
  overrides: Partial<CompatibleServiceReasoningProfile> = {}
): CompatibleServiceReasoningProfile {
  return {
    mode: 'control',
    supportsThinking: true,
    supportsEffort: true,
    thinkingParam: 'thinking',
    effortParam: 'reasoning_effort',
    effortValueMode: 'passthrough',
    levels,
    defaultLevel,
    verifiedAt: '2026-08-19',
    ...overrides
  };
}

/** Effort only: these families ignore or reject every thinking toggle. */
function effortOnly(levels: readonly string[], defaultLevel: string): CompatibleServiceReasoningProfile {
  return {
    mode: 'control',
    supportsThinking: false,
    supportsEffort: true,
    thinkingParam: 'none',
    effortParam: 'reasoning_effort',
    effortValueMode: 'passthrough',
    levels,
    defaultLevel,
    verifiedAt: '2026-08-19'
  };
}

/**
 * Resolve after normalizing provider prefixes, `models/`, punctuation and
 * case. Every ladder below comes from the acceptance matrix produced by
 * `tools/dev/probe-reasoning-contract.mjs` against the live gateway on 2026-08-19:
 * a level is listed only when the gateway did not reject it. Values the
 * gateway accepts with a 200 but silently ignores cannot be detected this way,
 * so a listed level guarantees a distinct outbound request, not that the
 * vendor honours it.
 */
export function resolveCompatibleServiceReasoningProfile(model: string): CompatibleServiceReasoningProfile {
  const id = normalizeModelId(model);

  // Native OpenAI Responses requests are not converted here. On the Chat
  // bridge 兼容服务 validates the flat OpenAI-compatible spelling.
  if (/^(?:gpt-5(?:-|$)|o[1-9](?:-|$))/.test(id)) return REASONING_EFFORT;

  // GLM 5.3 always reasons: every toggle and both `none` and `medium` come
  // back as 400 "该模型始终思考，不支持关闭思考；请使用 low、high 或 max".
  if (/^glm-5-3(?:-|$)/.test(id)) return effortOnly(['low', 'high', 'max'], 'high');
  if (/^glm-5-2(?:-|$)/.test(id) || /^glm-5v(?:-|$)/.test(id)) {
    return thinkingWithEffort(LADDER_MAX, 'high', { defaultReasoning: true });
  }
  // glm-5 and glm-5.1 reject `max`; xhigh is the ceiling.
  if (/^glm-5(?:-1)?(?:-|$)/.test(id)) {
    return thinkingWithEffort(LADDER_XHIGH, 'high', { defaultReasoning: true });
  }

  // Private aliases stayed unvalidated in the probe, so no control is guessed.
  if (/^qwen3-coder-plus(?:-|$)/.test(id) || /^qwen-plus-character(?:-|$)/.test(id)) return OMIT;
  // qwen3.8-max is the only Qwen that accepts `max`; the rest cap at xhigh.
  if (/^qwen3-8(?:-|$)/.test(id)) return thinkingWithEffort(LADDER_MAX, 'high');
  if (/^qwen3(?:-|$)/.test(id)) return thinkingWithEffort(LADDER_XHIGH, 'high');

  // DeepSeek rejects `reasoning_effort: none|minimal`; off is expressed with
  // the toggle, which the probe confirmed stops reasoning entirely.
  if (/^deepseek-v4(?:-|$)/.test(id)) {
    return thinkingWithEffort(LADDER_MAX, 'high', { defaultReasoning: true });
  }

  // Moonshot documents `max` as kimi-k3's default effort.
  if (/^kimi-k3(?:-|$)/.test(id)) {
    return thinkingWithEffort(LADDER_MAX, 'max', { defaultReasoning: true });
  }
  if (/^kimi-k2(?:-5|-6|-7)(?:-|$)/.test(id)) return thinkingWithEffort(LADDER_XHIGH, 'high');

  // M2.5 exposes an effort selector on the Chat route. Forward every chosen
  // value, including `none`, as reasoning_effort rather than treating it as a
  // thinking-off toggle.
  if (id === 'minimax-m2-5') {
    return effortOnly(['none', 'minimal', 'low', 'medium', 'high'], 'medium');
  }
  // Other M2.x profiles remain unchanged. On M3 the effort ladder is a
  // compatibility shim, so only the toggle is published.
  if (/^minimax-m2(?:-|$)/.test(id)) return OMIT;
  if (/^minimax-m3(?:-|$)/.test(id)) {
    return {
      ...THINKING,
      thinkingOnValue: 'adaptive',
      levels: ['high', 'none'],
      defaultLevel: 'high',
      defaultReasoning: true,
      verifiedAt: '2026-08-19'
    };
  }

  // doubao-seed-1.6 rejects none, xhigh and max on the effort field; off still
  // works through the toggle. Later generations accept the full ladder.
  if (/^doubao-seed-1-6(?:-|$)/.test(id)) return thinkingWithEffort(LADDER, 'high');
  if (/^doubao-seed(?:-|$)/.test(id)) return thinkingWithEffort(LADDER_MAX, 'high');

  // Grok ignores every thinking toggle, so off cannot be expressed at all:
  // 4.6 rejects `reasoning_effort: none` outright and 4.5 accepts it while
  // continuing to reason. `max` is rejected by 4.6. 4.20 exposes no effort
  // control — on the multi-agent build the field sizes the agent pool rather
  // than reasoning depth. See docs.x.ai/docs/guides/reasoning.
  if (/^grok-4-20-0309(?:-|$)/.test(id)) return OMIT;
  if (/^grok-4-6(?:-|$)/.test(id)) return effortOnly(['low', 'medium', 'high', 'xhigh'], 'high');
  if (/^grok-(?:4-3|4-5)(?:-|$)/.test(id)) return effortOnly(['low', 'medium', 'high', 'xhigh'], 'high');

  // Non-chat and private aliases should not inherit a guessed family field.
  return OMIT;
}

function normalizeModelId(model: string): string {
  const leaf = model
    .trim()
    .toLowerCase()
    .split('/')
    .filter(segment => segment && segment !== 'models')
    .at(-1) ?? '';
  return leaf
    .replace(/[^a-z0-9]+/g, '-')
    // Some catalogs spell decimal generations as `5p2` / `k2p5`.
    // Normalize those aliases before applying the bounded family rules.
    .replace(/(\d)p(\d)/g, '$1-$2')
    .replace(/^-+|-+$/g, '');
}
