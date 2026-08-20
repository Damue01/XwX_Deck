import { TapModelUsage, TapUsageField } from './types';

/**
 * 模型价格规则（USD / 1M tokens，官方牌价）。
 * 匹配方式：tokens 里所有子串都出现在模型 id（小写）中即命中，首条命中生效——
 * 所以"更具体"的规则（mini/nano）必须排在同 family 的泛化规则前面。
 * 经 兼容服务 中转的实际结算价可能不同，估算仅供量级参考。
 *
 * 缓存计费必须按捕获到的 usage 形状分流，不能只看模型供应商：
 * - Messages：input / cacheRead / cacheCreation 三者互斥独立计价。
 * - Responses / Chat Completions：cacheRead / cacheCreation 是 input 的子集。
 *
 * 兼容服务 可能在 Claude 客户端和 Codex 客户端之间桥接同一个模型，因此同一个价格规则
 * 可能遇到两种 usage 形状。TapModelUsage.apiType 记录捕获侧的真实形状，缺失时才回退到
 * 价格规则的协议。
 */
/**
 * One price band of a length-tiered model.
 *
 * Alibaba Model Studio and Volcengine Ark step their rates across input-length
 * bands, and the band a request lands in applies to *every* bucket including
 * output. Flattening this to the lowest band under-reports long contexts by up
 * to 6x (measured against models.dev, which does exactly that for six of the
 * eight comparable Qwen models).
 */
export interface ModelPriceTier {
  /** Inclusive lower bound, in total prompt tokens. The first tier starts at 0. */
  readonly fromInputTokens: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  /**
   * A cheaper output rate for short replies, which Volcengine publishes inside a
   * band: doubao-seed-1.6 and -1.8 charge CNY 2 per 1M output instead of 8 when a
   * request emits at most 200 tokens. Without it every tool-call turn is billed at
   * the long-reply rate, which over-reports their output by 4x.
   */
  readonly shortOutput?: {
    readonly atMostTokens: number;
    readonly output: number;
  };
}

/**
 * Off-peak discount window. DeepSeek halves every bucket outside peak hours and
 * publishes the windows in UTC; no aggregator models this, which is why every
 * one of them reports a DeepSeek price that is wrong by 2x in one direction or
 * the other.
 */
export interface ModelPricePeakSchedule {
  /** UTC hour ranges that are billed at full price, as [startHour, endHour). */
  readonly peakWindowsUtc: readonly (readonly [number, number])[];
  /** Multiplier applied to every rate outside the peak windows. */
  readonly offPeakMultiplier: number;
}

export interface ModelPriceRule {
  readonly tokens: readonly string[];
  /** models.dev entries use exact model ids; built-in fallbacks use substring tokens. */
  readonly match?: 'exact' | 'substring';
  readonly protocol: 'anthropic' | 'openai';
  /** USD per 1M input tokens */
  readonly input: number;
  /** USD per 1M output tokens */
  readonly output: number;
  /** USD per 1M cache-read tokens. Undefined means the source did not publish it. */
  readonly cacheRead?: number;
  /** USD per 1M default / 5-minute cache-write tokens. */
  readonly cacheWrite?: number;
  /** USD per 1M 1-hour cache-write tokens, when the provider has a TTL-specific tier. */
  readonly cacheWrite1h?: number;
  /** Explicit provider semantics used only when no numeric cache-write price was published. */
  readonly cacheWritePolicy?: 'input' | 'free' | 'storage' | 'unknown';
  readonly cacheWritePolicySource?: 'official';
  /**
   * Input-length bands, ascending by fromInputTokens. When present the top-level
   * input/output/cacheRead/cacheWrite mirror the first band so that callers
   * unaware of tiers still see a real published rate rather than nothing.
   */
  readonly tiers?: readonly ModelPriceTier[];
  /** Time-of-day discount, applied on top of the resolved tier. */
  readonly peak?: ModelPricePeakSchedule;
  /**
   * USD per 1M cached tokens per hour, for providers that bill explicit cache
   * as storage instead of a write fee. Cannot be derived from token counts
   * alone, so its presence makes a used cache-write bucket unpriceable.
   */
  readonly cacheStoragePerHour?: number;
  /**
   * How much corroboration this rate has. 'official' came from the vendor,
   * 'consensus' from agreeing independent catalogues, 'single' from one source.
   */
  readonly priceSource?: 'official' | 'consensus' | 'single';
  /** Where this rule came from. Used for diagnostics/tooltips only. */
  readonly source?: 'compatible' | 'official' | 'models.dev' | 'static';
  readonly providerId?: string;
  readonly modelId?: string;
}

const COMPATIBLE_SERVICE_PRICE_OVERRIDES: readonly ModelPriceRule[] = [
  // 兼容服务 still exposes this exact Codex id after models.dev removed the
  // dedicated row on 2026-08-04. Preserve its last exact models.dev price
  // until the upstream catalog publishes the id again.
  {
    tokens: ['gpt-5.2-codex'],
    match: 'exact',
    protocol: 'openai',
    input: 1.75,
    output: 14,
    cacheRead: 0.175,
    source: 'static',
    providerId: 'openai',
    modelId: 'gpt-5.2-codex'
  },
  // 兼容服务 uses a dotted Claude version while models.dev publishes the same
  // model as claude-sonnet-4-5. Keep an exact alias instead of enabling broad
  // punctuation/family matching for every model.
  {
    tokens: ['claude-sonnet-4.5'],
    match: 'exact',
    protocol: 'anthropic',
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    source: 'official',
    providerId: 'anthropic',
    modelId: 'claude-sonnet-4.5'
  },
  // 兼容服务 exposes doubao-seed-2-0-code-preview, but Volcengine's rate card
  // itemises the family as doubao-seed-2.0-code with no "-preview" row, so the
  // generator leaves the id unpriced. The mapping to that SKU has two independent
  // corroborations: LiteLLM prices volcengine/doubao-seed-2-0-code-preview-260215
  // identically to seed-2-0-pro, and BytePlus prices seed-2-0-code-preview the
  // same as seed-2-0-pro on its own card. The rate card lists doubao-seed-2.0-code
  // at the same three bands as the pro tier (CNY 3.2/16 | 4.8/24 | 9.6/48 per 1M,
  // cache hit 0.64/0.96/1.92, cache storage 0.017/1M/hour), converted here at the
  // same 6.7423 CNY/USD the generator used on 2026-08-18.
  //
  // Distinct from the cheaper doubao-seed-code SKU on the same page; this one is
  // the 2.0 generation. Retires itself as soon as the generator maps the id.
  {
    tokens: ['doubao-seed-2-0-code-preview'],
    match: 'exact',
    protocol: 'openai',
    input: 0.4746,
    output: 2.373,
    cacheRead: 0.09492,
    tiers: [
      { fromInputTokens: 0, input: 0.4746, output: 2.373, cacheRead: 0.09492 },
      { fromInputTokens: 32001, input: 0.7119, output: 3.56, cacheRead: 0.1424 },
      { fromInputTokens: 128001, input: 1.424, output: 7.119, cacheRead: 0.2848 }
    ],
    cacheStoragePerHour: 0.002521,
    priceSource: 'official',
    source: 'official',
    providerId: 'volcengine',
    modelId: 'doubao-seed-2-0-code-preview'
  },
  // Alibaba Cloud Model Studio launched qwen3.8-max at $2/M input and $6/M
  // output on 2026-08-03. models.dev did not yet list the model when verified
  // on 2026-08-04. This exact override is automatically retired once
  // models.dev publishes its own exact rule.
  //
  // cacheRead comes from OpenRouter's first-party Alibaba endpoint
  // (/api/v1/models/qwen/qwen3.8-max/endpoints, tag "alibaba", verified
  // 2026-08-19), which publishes 2 / 6 / 0.25 / 2.5. Its input and output match
  // Alibaba's own list price to the digit, so that endpoint carries no resale
  // markup and its cache-read rate is the list rate too. 0.25 is 12.5% of input,
  // matching neither the 20% implicit nor the 10% explicit multiplier - which is
  // consistent with Alibaba's context-cache page naming qwen3.8-max as one of the
  // two explicit exceptions to those rules and pointing at the console instead.
  {
    tokens: ['qwen3.8-max'],
    match: 'exact',
    protocol: 'openai',
    input: 2,
    output: 6,
    cacheRead: 0.25,
    cacheWrite: 2.5,
    source: 'official',
    providerId: 'alibaba',
    modelId: 'qwen3.8-max'
  },
  // Moonshot's current rate card has exactly two input tiers (Cache Hit / Cache
  // Miss) and no cache-creation or storage line, and its caching guide describes
  // fully automatic prefix caching with no manual creation or TTL. So a cache
  // write is billed at the ordinary Cache Miss rate.
  // platform.kimi.ai/docs/pricing/chat-k25 · /chat-k26 · /chat-k27-code · /chat-k3
  // verified 2026-08-18. The historical explicit Context Caching product (per
  // token-minute storage plus per-call fees) no longer appears in any official page.
  {
    tokens: ['kimi-k2.5'],
    match: 'exact',
    protocol: 'openai',
    input: 0.6,
    output: 3,
    cacheRead: 0.1,
    cacheWritePolicy: 'input',
    cacheWritePolicySource: 'official',
    source: 'official',
    providerId: 'moonshotai',
    modelId: 'kimi-k2.5'
  },
  {
    tokens: ['kimi-k2.6'],
    match: 'exact',
    protocol: 'openai',
    input: 0.95,
    output: 4,
    cacheRead: 0.16,
    cacheWritePolicy: 'input',
    cacheWritePolicySource: 'official',
    source: 'official',
    providerId: 'moonshotai',
    modelId: 'kimi-k2.6'
  },
  {
    tokens: ['kimi-k2.7-code'],
    match: 'exact',
    protocol: 'openai',
    input: 0.95,
    output: 4,
    cacheRead: 0.19,
    cacheWritePolicy: 'input',
    cacheWritePolicySource: 'official',
    source: 'official',
    providerId: 'moonshotai',
    modelId: 'kimi-k2.7-code'
  },
  {
    tokens: ['kimi-k3'],
    match: 'exact',
    protocol: 'openai',
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWritePolicy: 'input',
    cacheWritePolicySource: 'official',
    source: 'official',
    providerId: 'moonshotai',
    modelId: 'kimi-k3'
  },
  // MiniMax publishes ≤512K rates of $0.30/$1.20 with $0.06 cache reads and
  // states "No additional charge for cache writes" for the default passive
  // caching mode. The explicit (Anthropic-compatible `cache_control`) mode does
  // incur first-time write charges but MiniMax does not publish that rate, so no
  // cache-write price is recorded: a response that actually reports cache
  // creation tokens will report no cost instead of a wrong one.
  // platform.minimax.io/docs/api-reference/text-prompt-caching verified 2026-08-18.
  // Requests above 512K input are billed at 2x across every bucket, which a
  // single per-model rate cannot express — those sessions are under-reported.
  {
    tokens: ['minimax-m3'],
    match: 'exact',
    protocol: 'openai',
    input: 0.3,
    output: 1.2,
    cacheRead: 0.06,
    source: 'official',
    providerId: 'minimax',
    modelId: 'MiniMax-M3'
  },
  // Embedding models are a single forward pass with no prompt reuse, so they have
  // no cache concept at all — the official rate cards show "-" in their Cached
  // input column rather than omitting a value.
  // developers.openai.com/api/docs/pricing · ai.google.dev/gemini-api/docs/pricing
  // verified 2026-08-18.
  {
    tokens: ['text-embedding-3-large'],
    match: 'exact',
    protocol: 'openai',
    input: 0.13,
    output: 0,
    cacheWritePolicy: 'free',
    cacheWritePolicySource: 'official',
    source: 'official',
    providerId: 'openai',
    modelId: 'text-embedding-3-large'
  },
  {
    tokens: ['text-embedding-ada-002'],
    match: 'exact',
    protocol: 'openai',
    input: 0.1,
    output: 0,
    cacheWritePolicy: 'free',
    cacheWritePolicySource: 'official',
    source: 'official',
    providerId: 'openai',
    modelId: 'text-embedding-ada-002'
  },
  {
    tokens: ['gemini-embedding-2'],
    match: 'exact',
    protocol: 'openai',
    input: 0.2,
    output: 0,
    cacheWritePolicy: 'free',
    cacheWritePolicySource: 'official',
    source: 'official',
    providerId: 'google',
    modelId: 'gemini-embedding-2'
  },
  // Alibaba Model Studio international (Singapore) rates, verified 2026-08-18
  // against help.aliyun.com/zh/model-studio/billing-for-model-studio and the
  // per-model pages. Only models Alibaba does NOT tier by input length are
  // listed here: its text models step up across 32k/128k/256k/1m input bands, so
  // a single rate would systematically under-report long-context sessions.
  // Alibaba's cache rule (help.aliyun.com/zh/model-studio/context-cache) is a
  // multiplier, not a storage fee: explicit-cache create = 125% of input,
  // explicit hit = 10%, implicit create = 100% (no surcharge), implicit hit = 20%.
  {
    tokens: ['text-embedding-v3'],
    match: 'exact',
    protocol: 'openai',
    input: 0.07,
    output: 0,
    cacheWritePolicy: 'free',
    cacheWritePolicySource: 'official',
    source: 'official',
    providerId: 'alibaba',
    modelId: 'text-embedding-v3'
  },
  {
    tokens: ['text-embedding-v4'],
    match: 'exact',
    protocol: 'openai',
    input: 0.07,
    output: 0,
    cacheWritePolicy: 'free',
    cacheWritePolicySource: 'official',
    source: 'official',
    providerId: 'alibaba',
    modelId: 'text-embedding-v4'
  },
  // qwen-vl-ocr does not support context caching at all, so no cache bucket can
  // ever be charged for it.
  {
    tokens: ['qwen-vl-ocr'],
    match: 'exact',
    protocol: 'openai',
    input: 0.07,
    output: 0.16,
    cacheWritePolicy: 'free',
    cacheWritePolicySource: 'official',
    source: 'official',
    providerId: 'alibaba',
    modelId: 'qwen-vl-ocr'
  },
  {
    tokens: ['qwen-plus-character'],
    match: 'exact',
    protocol: 'openai',
    input: 0.5,
    output: 1.4,
    cacheRead: 0.102,
    cacheWritePolicy: 'input',
    cacheWritePolicySource: 'official',
    source: 'official',
    providerId: 'alibaba',
    modelId: 'qwen-plus-character'
  }
];

export const PRICE_RULES: readonly ModelPriceRule[] = [
  // Anthropic（cacheRead = 0.1×input，cacheWrite = 1.25×input；牌价来源 platform.claude.com/docs pricing，2026-06）
  { tokens: ['claude', 'fable'], protocol: 'anthropic', input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  { tokens: ['claude', 'mythos'], protocol: 'anthropic', input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  // Opus 4.1 / Opus 4（deprecated）旧价必须排在泛化 opus 规则前。Opus 4.1 走 'opus-4-1' 子串；
  // 老 Opus 4（claude-opus-4-2025xxxx 等带日期 SKU）走 'opus-4-2025' 命中（不会撞到 4-1-2025xxxx）。
  { tokens: ['claude', 'opus-4-1'], protocol: 'anthropic', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { tokens: ['claude', 'opus-4-2025'], protocol: 'anthropic', input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { tokens: ['claude', 'opus'], protocol: 'anthropic', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { tokens: ['claude', 'sonnet-5'], protocol: 'anthropic', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  { tokens: ['claude', 'sonnet'], protocol: 'anthropic', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  // Haiku 4.5 新价排在 3.5 旧价前（'haiku-4' 不能写裸 '4'，会误中日期后缀）
  { tokens: ['claude', 'haiku-4'], protocol: 'anthropic', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { tokens: ['claude', 'haiku'], protocol: 'anthropic', input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  // OpenAI（cached input 计价；牌价按 LiteLLM/官方 2026-06，mini/nano 与
  // 具体版本号必须在泛化规则前）
  { tokens: ['gpt-5.6', 'luna'], protocol: 'openai', input: 1, output: 6, cacheRead: 0.1 },
  { tokens: ['gpt-5.6', 'terra'], protocol: 'openai', input: 2.5, output: 15, cacheRead: 0.25 },
  { tokens: ['gpt-5.6'], protocol: 'openai', input: 5, output: 30, cacheRead: 0.5 },
  { tokens: ['gpt-5.5', 'pro'], protocol: 'openai', input: 30, output: 180, cacheRead: 30 },
  { tokens: ['gpt-5.5'], protocol: 'openai', input: 5, output: 30, cacheRead: 0.5 },
  { tokens: ['gpt-5.4', 'pro'], protocol: 'openai', input: 30, output: 180, cacheRead: 30 },
  { tokens: ['gpt-5.4', 'mini'], protocol: 'openai', input: 0.75, output: 4.5, cacheRead: 0.075 },
  { tokens: ['gpt-5.4', 'nano'], protocol: 'openai', input: 0.2, output: 1.25, cacheRead: 0.02 },
  { tokens: ['gpt-5.4'], protocol: 'openai', input: 2.5, output: 15, cacheRead: 0.25 },
  { tokens: ['gpt-5.3'], protocol: 'openai', input: 1.75, output: 14, cacheRead: 0.175 },
  { tokens: ['gpt-5.2', 'pro'], protocol: 'openai', input: 21, output: 168, cacheRead: 21 },
  { tokens: ['gpt-5.2'], protocol: 'openai', input: 1.75, output: 14, cacheRead: 0.175 },
  // gpt-5-codex（Codex CLI 微调档）必须排在泛化 gpt-5 前，否则被通配规则吞掉错误档位
  { tokens: ['gpt-5.1', 'codex', 'mini'], protocol: 'openai', input: 0.25, output: 2, cacheRead: 0.025 },
  { tokens: ['gpt-5', 'codex'], protocol: 'openai', input: 1.25, output: 10, cacheRead: 0.125 },
  { tokens: ['gpt-5', 'nano'], protocol: 'openai', input: 0.05, output: 0.4, cacheRead: 0.005 },
  { tokens: ['gpt-5', 'mini'], protocol: 'openai', input: 0.25, output: 2, cacheRead: 0.025 },
  { tokens: ['gpt-5'], protocol: 'openai', input: 1.25, output: 10, cacheRead: 0.125 },
  { tokens: ['gpt-4o', 'mini'], protocol: 'openai', input: 0.15, output: 0.6, cacheRead: 0.075 },
  { tokens: ['gpt-4o'], protocol: 'openai', input: 2.5, output: 10, cacheRead: 1.25 },
  { tokens: ['gpt-4.1', 'mini'], protocol: 'openai', input: 0.4, output: 1.6, cacheRead: 0.1 },
  { tokens: ['gpt-4.1', 'nano'], protocol: 'openai', input: 0.1, output: 0.4, cacheRead: 0.025 },
  { tokens: ['gpt-4.1'], protocol: 'openai', input: 2, output: 8, cacheRead: 0.5 },
  // OpenAI 推理家族 o1/o3/o4（含 mini）。tokens 用 'o1'/'o3'/'o4' 短串，但因为放在所有 gpt-* 规则后，
  // gpt-* 形态不会落到这里；Anthropic 模型 ID 不含相邻 'o1'/'o3'/'o4' 子串故安全。mini 变体先行。
  { tokens: ['o4', 'mini', 'deep-research'], protocol: 'openai', input: 2, output: 8, cacheRead: 0.5 },
  { tokens: ['o4', 'mini'], protocol: 'openai', input: 1.1, output: 4.4, cacheRead: 0.275 },
  { tokens: ['o3', 'mini'], protocol: 'openai', input: 1.1, output: 4.4, cacheRead: 0.55 },
  { tokens: ['o3', 'deep-research'], protocol: 'openai', input: 10, output: 40, cacheRead: 2.5 },
  { tokens: ['o3', 'pro'], protocol: 'openai', input: 20, output: 80, cacheRead: 20 },
  { tokens: ['o3'], protocol: 'openai', input: 2, output: 8, cacheRead: 0.5 },
  { tokens: ['o1', 'mini'], protocol: 'openai', input: 1.1, output: 4.4, cacheRead: 0.55 },
  { tokens: ['o1'], protocol: 'openai', input: 15, output: 60, cacheRead: 7.5 },
  // —— 以下为国产/第三方 family（LiteLLM + 各家公开对外牌价，2026-06）——
  // 内部改名 SKU（如 qwen3.7-plus / deepseek-v4-pro）按 family 子串命中，
  // 只能作量级参考；兼容服务 实际结算价可能不同。
  // DeepSeek（按 V3.1 官方档：reasoner ≈ chat 的 2× output；cache hit ≈ 0.1×input）
  // 内部 deepseek-v4-pro 大概率是 reasoner 档；deepseek-v4-flash 走 chat 档优惠价。
  { tokens: ['deepseek', 'reasoner'], protocol: 'openai', input: 0.14, output: 0.28, cacheRead: 0.0028 },
  { tokens: ['deepseek', 'pro'], protocol: 'openai', input: 0.435, output: 0.87, cacheRead: 0.003625 },
  { tokens: ['deepseek', 'flash'], protocol: 'openai', input: 0.14, output: 0.28, cacheRead: 0.0028 },
  // 泛化 deepseek 兜底（V3 chat 档，对应 deepseek-chat / deepseek-coder）
  { tokens: ['deepseek'], protocol: 'openai', input: 0.14, output: 0.28, cacheRead: 0.0028 },
  // Qwen（DashScope 国际版；cache hit = 0.4×input；具体 SKU 先于泛化规则）
  { tokens: ['qwen', 'max'], protocol: 'openai', input: 1.6, output: 6.4, cacheRead: 0.64 },
  { tokens: ['qwen', 'flash'], protocol: 'openai', input: 0.05, output: 0.4, cacheRead: 0.02 },
  { tokens: ['qwen', 'turbo'], protocol: 'openai', input: 0.05, output: 0.2, cacheRead: 0.02 },
  { tokens: ['qwen', 'coder'], protocol: 'openai', input: 1, output: 5, cacheRead: 0.4 },
  // 泛化 qwen 兜底按 qwen-plus 档（plus 是主力档位）
  { tokens: ['qwen'], protocol: 'openai', input: 0.4, output: 1.2, cacheRead: 0.16 },
  // Kimi（Moonshot：k2.6 牌价 0.95/4，其余按 k2.5 档；cache hit $0.15）
  { tokens: ['kimi', 'k3'], protocol: 'openai', input: 3, output: 15, cacheRead: 0.3 },
  { tokens: ['kimi', 'k2.7', 'highspeed'], protocol: 'openai', input: 1.9, output: 8, cacheRead: 0.38 },
  { tokens: ['kimi', 'k2.7'], protocol: 'openai', input: 0.95, output: 4, cacheRead: 0.19 },
  { tokens: ['kimi', 'k2.6'], protocol: 'openai', input: 0.95, output: 4, cacheRead: 0.16 },
  { tokens: ['kimi'], protocol: 'openai', input: 0.6, output: 3, cacheRead: 0.1 },
  // GLM（Z.ai GLM-5 档：1/3.2，cache hit 0.2）
  { tokens: ['glm-5'], protocol: 'openai', input: 1.4, output: 4.4, cacheRead: 0.26 },
  { tokens: ['glm'], protocol: 'openai', input: 0.6, output: 2.2, cacheRead: 0.11 },
  // MiniMax（M3 = 0.6/2.4；M2.x = 0.3/1.2）
  { tokens: ['minimax', 'm3'], protocol: 'openai', input: 0.3, output: 1.2, cacheRead: 0.06 },
  { tokens: ['minimax'], protocol: 'openai', input: 0.3, output: 1.2, cacheRead: 0.06 },
  // Doubao（火山引擎 seed 档，CNY→USD 粗换算）
  { tokens: ['doubao'], protocol: 'openai', input: 0.15, output: 1.1, cacheRead: 0.02 },
  // Grok（xAI：fast 档 0.2/0.5；grok-4 = 3/15，cached input 0.75）
  { tokens: ['grok', 'fast'], protocol: 'openai', input: 0.2, output: 0.5, cacheRead: 0.05 },
  { tokens: ['grok'], protocol: 'openai', input: 3, output: 15, cacheRead: 0.75 },
  // Gemini（lite < 3.x flash < 3.5 flash < 泛化 pro 档）
  { tokens: ['gemini', '3.6', 'flash'], protocol: 'openai', input: 1.5, output: 7.5, cacheRead: 0.15 },
  { tokens: ['gemini', '3.5', 'flash', 'lite'], protocol: 'openai', input: 0.3, output: 2.5, cacheRead: 0.03 },
  { tokens: ['gemini', 'flash', 'lite'], protocol: 'openai', input: 0.25, output: 1.5, cacheRead: 0.025 },
  { tokens: ['gemini', '3.5', 'flash'], protocol: 'openai', input: 1.5, output: 9, cacheRead: 0.15 },
  { tokens: ['gemini', '2.5', 'pro'], protocol: 'openai', input: 1.25, output: 10, cacheRead: 0.125 },
  { tokens: ['gemini', '2.5', 'flash'], protocol: 'openai', input: 0.3, output: 2.5, cacheRead: 0.03 },
  { tokens: ['gemini', 'flash'], protocol: 'openai', input: 0.5, output: 3, cacheRead: 0.05 },
  { tokens: ['gemini'], protocol: 'openai', input: 2, output: 12, cacheRead: 0.2 }
];

let catalogPriceRules: readonly ModelPriceRule[] = [];

export function setCatalogPriceRules(rules: readonly ModelPriceRule[]): void {
  catalogPriceRules = [...rules];
}

export function getPriceRules(): readonly ModelPriceRule[] {
  // Overrides and the catalogue are merged per field rather than one replacing
  // the other. The catalogue wins every field it publishes, so a hand-written
  // rate cannot rot in place once update:pricing learns the id. But a catalogue
  // row can be authoritative and still incomplete — Alibaba's rate card omits
  // qwen3.8-max's cache-read rate and points at the console — and an all-or-
  // nothing replace threw away a verified value for a field the catalogue simply
  // does not carry. The exception is a row the generator itself marked weakly
  // corroborated: a lone unverified aggregator row must not displace a rate read
  // off the vendor's own page, which is how a retired qwen-vl-ocr snapshot at
  // 16.7x the real rate got published.
  const overridesById = new Map<string, ModelPriceRule>();
  for (const rule of COMPATIBLE_SERVICE_PRICE_OVERRIDES) {
    const id = (rule.modelId || rule.tokens[0] || '').toLowerCase();
    if (id) overridesById.set(id, rule);
  }
  const usedOverrideIds = new Set<string>();
  const catalog = (catalogPriceRules.length ? catalogPriceRules : PRICE_RULES).map(rule => {
    if (rule.match !== 'exact') return rule;
    const id = (rule.modelId || rule.tokens[0] || '').toLowerCase();
    const override = id ? overridesById.get(id) : undefined;
    if (!override) return rule;
    usedOverrideIds.add(id);
    if (rule.priceSource === 'single') return override;
    return { ...fillMissingRates(rule, override) };
  });
  const pendingOverrides = COMPATIBLE_SERVICE_PRICE_OVERRIDES.filter(rule => {
    const id = (rule.modelId || rule.tokens[0] || '').toLowerCase();
    return !id || !usedOverrideIds.has(id);
  });
  return [...pendingOverrides, ...catalog];
}

/** Copy only the rate fields the catalogue row leaves undefined. */
function fillMissingRates(rule: ModelPriceRule, override: ModelPriceRule): ModelPriceRule {
  return {
    ...rule,
    ...(rule.cacheRead === undefined && override.cacheRead !== undefined
      ? { cacheRead: override.cacheRead }
      : {}),
    ...(rule.cacheWrite === undefined && override.cacheWrite !== undefined
      ? { cacheWrite: override.cacheWrite }
      : {}),
    ...(rule.cacheWrite1h === undefined && override.cacheWrite1h !== undefined
      ? { cacheWrite1h: override.cacheWrite1h }
      : {}),
    ...(rule.cacheWrite === undefined && rule.cacheWritePolicy === undefined && override.cacheWritePolicy !== undefined
      ? {
        cacheWritePolicy: override.cacheWritePolicy,
        ...(override.cacheWritePolicySource === undefined
          ? {}
          : { cacheWritePolicySource: override.cacheWritePolicySource })
      }
      : {})
  };
}

export function findModelPrice(model: string, rules: readonly ModelPriceRule[] = getPriceRules()): ModelPriceRule | undefined {
  const id = (model || '').toLowerCase();
  if (!id) return undefined;
  return rules.find(rule => {
    if (rule.match === 'exact') {
      const exactId = (rule.modelId || rule.tokens[0] || '').toLowerCase();
      return !!exactId && (id === exactId || id.endsWith(`/${exactId}`));
    }
    return rule.tokens.every(token => id.includes(token.toLowerCase()));
  });
}

/**
 * 一次请求可能带两个模型名：客户端请求的那个，和上游回报的那个。
 * 两者都是同一次请求的事实，所以这不是近似匹配——请求名优先（用户选的、公开
 * 目录收录的那个），它没有价再用回报名兜底。DeepSeek 把 deepseek-v4-pro-0813
 * 回成内部构建名 deepseek-v4-pro-ga-260813，只认回报名就会丢掉已有的官方价；
 * 反过来客户端请求 xxx-latest 时，回报名才是能定价的那个。
 */
export function findModelPriceForUsage(
  requestedModel: string,
  servedModel?: string,
  rules: readonly ModelPriceRule[] = getPriceRules()
): ModelPriceRule | undefined {
  return findModelPrice(requestedModel, rules)
    ?? (servedModel && servedModel !== requestedModel ? findModelPrice(servedModel, rules) : undefined);
}

export function effectiveCacheWritePolicy(price: ModelPriceRule): NonNullable<ModelPriceRule['cacheWritePolicy']> | 'listed' {
  if (price.cacheWrite !== undefined) return 'listed';
  if (price.cacheWritePolicy) return price.cacheWritePolicy;
  if (price.providerId === 'openai' || price.providerId === 'deepseek' || price.providerId === 'xai') {
    return 'input';
  }
  if (price.providerId === 'google') return 'storage';
  return 'unknown';
}

export function effectiveCacheWrite1h(price: ModelPriceRule): number | undefined {
  if (price.cacheWrite1h !== undefined) return price.cacheWrite1h;
  return price.protocol === 'anthropic' ? price.input * 2 : undefined;
}

/**
 * Resolve which tier a request's total prompt length falls into. Tiers are
 * ascending and the first one starts at 0, so the last tier whose lower bound is
 * not above the length wins.
 */
export function resolvePriceTierIndex(price: ModelPriceRule, inputTotalTokens: number): number {
  const tiers = price.tiers;
  if (!tiers?.length) return 0;
  let index = 0;
  for (let i = 0; i < tiers.length; i += 1) {
    if (inputTotalTokens >= tiers[i].fromInputTokens) index = i;
  }
  return index;
}

/**
 * Whether a request's reply is short enough for the band's discounted output rate.
 * Decided per request, so it has to be resolved at capture time and recorded in
 * the band exactly like the input length and the peak period.
 */
export function isShortOutput(price: ModelPriceRule, tier: number, outputTokens: number): boolean {
  const band = price.tiers?.[tier];
  const discount = band?.shortOutput;
  return !!discount && outputTokens <= discount.atMostTokens;
}

/** True when a UTC timestamp falls outside every published peak window. */
export function isOffPeakAt(price: ModelPriceRule, atMs: number): boolean {
  const schedule = price.peak;
  if (!schedule?.peakWindowsUtc.length) return false;
  const hour = new Date(atMs).getUTCHours();
  return !schedule.peakWindowsUtc.some(([from, to]) => hour >= from && hour < to);
}

/** The four rates that apply inside one band. */
function bandRates(price: ModelPriceRule, tier: number, offPeak: boolean, shortOutput?: boolean): {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
} {
  const band = price.tiers?.[tier];
  const scale = offPeak && price.peak ? price.peak.offPeakMultiplier : 1;
  const scaled = (value: number | undefined): number | undefined => (
    value === undefined ? undefined : value * scale
  );
  const output = shortOutput && band?.shortOutput
    ? band.shortOutput.output
    : band?.output ?? price.output;
  return {
    input: (band?.input ?? price.input) * scale,
    output: output * scale,
    cacheRead: scaled(band?.cacheRead ?? price.cacheRead),
    cacheWrite: scaled(band?.cacheWrite ?? price.cacheWrite)
  };
}

/**
 * Whether a stored row's `input` field is already a mutually exclusive
 * "uncached input" bucket. Version 2 rows always are, because normalizeUsage
 * subtracts the cache buckets at capture time. Version 1 rows only are when the
 * captured shape was Anthropic Messages, where `input_tokens` never included
 * cache tokens in the first place; a version 1 Responses row stored the
 * provider-native total and can no longer be split.
 */
/**
 * Do the recorded bands account for every token the aggregate says was billed?
 * A band split is only usable when it explains the whole usage: merging a banded
 * usage with an unbanded one leaves bands covering part of the tokens, and
 * charging that part while presenting it as the total silently understates it.
 */
function bandsAccountForUsage(usage: TapModelUsage): boolean {
  const bands = usage.bands;
  if (!bands?.length) return false;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  for (const band of bands) {
    input += band.input;
    output += band.output;
    cacheRead += band.cacheRead;
    cacheCreation += band.cacheCreation;
  }
  return input === usage.input
    && output === usage.output
    && cacheRead === usage.cacheRead
    && cacheCreation === usage.cacheCreation;
}

function hasExclusiveInputBucket(usage: TapModelUsage, price: ModelPriceRule): boolean {
  if (usage.version === 2) return true;
  const captured = usage.apiType;
  if (captured) return captured === 'messages';
  // Pre-apiType rows: fall back to the price rule's protocol.
  return price.protocol === 'anthropic';
}

/**
 * Whether an absent usage field actually prevents billing.
 *
 * Absence is not automatically "unknown". Verified provider semantics decide:
 *  - Z.ai/GLM caches implicitly and has no cache-write charge at all
 *    (docs.bigmodel.cn/cn/guide/capabilities/cache), and DeepSeek ignores
 *    cache_control with free cache writes (api-docs.deepseek.com/guides/
 *    anthropic_api + /news/news0802), so a missing cache-write count is a
 *    definite zero for them.
 *  - Anthropic always reports both cache fields
 *    (platform.claude.com/docs/en/docs/build-with-claude/prompt-caching uses
 *    "both are 0" as the not-cached test), so for a provider that does itemise
 *    cache writes an absent count means we lost data and must not bill.
 */
function absenceBlocksBilling(field: TapUsageField, price: ModelPriceRule): boolean {
  // Only used for display and context-window math.
  if (field === 'total') return false;
  if (field === 'input' || field === 'output') return true;
  // A bucket the upstream never reported contributes zero tokens, so its cost is
  // zero whatever the rate. The only question is whether the absence could be
  // hiding real usage:
  //  - Anthropic itemises both cache fields on every response and uses "both are
  //    0" as its own not-cached test, so a missing field means we lost data.
  //  - Every verified third party either caches implicitly with no separate
  //    write charge (Z.ai/GLM, DeepSeek, Moonshot) or omits the field when
  //    nothing was cached, so absence is a definite zero. This is also what
  //    LiteLLM and Helicone do.
  return price.protocol === 'anthropic' || price.providerId === 'anthropic';
}

/** True when this rule's rates depend on request length or request time. */
export function isBandedPrice(price: ModelPriceRule): boolean {
  return !!price.tiers?.length || !!price.peak?.peakWindowsUtc.length;
}

/**
 * Charge one band's counters at one set of rates. Undefined means a bucket was
 * used but the rate for it is not knowable.
 */
interface BillableCounters {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
  readonly cacheCreation5m?: number;
  readonly cacheCreation1h?: number;
}

function chargeBucket(
  counters: BillableCounters,
  price: ModelPriceRule,
  rates: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
): number | undefined {
  const M = 1_000_000;
  if (counters.cacheRead > 0 && rates.cacheRead === undefined) return undefined;

  const cacheCreation5m = Math.min(counters.cacheCreation, counters.cacheCreation5m || 0);
  const remainingAfter5m = Math.max(0, counters.cacheCreation - cacheCreation5m);
  const cacheCreation1h = Math.min(remainingAfter5m, counters.cacheCreation1h || 0);
  const cacheCreationUnspecified = Math.max(0, counters.cacheCreation - cacheCreation5m - cacheCreation1h);
  const hasCacheWriteTtlBreakdown = counters.cacheCreation5m !== undefined || counters.cacheCreation1h !== undefined;
  // Anthropic is the only vendor with TTL-specific write tiers, and its 5m and
  // 1h rates differ. Without the split we cannot pick a tier, and assuming the
  // cheaper one would under-bill, so the model reports no cost at all.
  if (price.protocol === 'anthropic' && counters.cacheCreation > 0 && !hasCacheWriteTtlBreakdown) {
    return undefined;
  }
  const cacheWritePolicy = effectiveCacheWritePolicy(price);
  const writePrice = rates.cacheWrite
    ?? (cacheWritePolicy === 'input'
      ? rates.input
      : cacheWritePolicy === 'free'
        ? 0
        : undefined);
  const write1hPrice = rates.cacheWrite === undefined
    ? effectiveCacheWrite1h(price)
    : price.cacheWrite1h ?? (price.protocol === 'anthropic' ? rates.input * 2 : undefined);
  if ((cacheCreation5m > 0 || cacheCreationUnspecified > 0) && writePrice === undefined) return undefined;
  if (cacheCreation1h > 0 && write1hPrice === undefined) return undefined;

  return (counters.input * rates.input
    + counters.cacheRead * (rates.cacheRead || 0)
    + cacheCreation5m * (writePrice || 0)
    + cacheCreation1h * (write1hPrice || 0)
    + cacheCreationUnspecified * (writePrice || 0)
    + counters.output * rates.output) / M;
}

/**
 * Estimate a complete token charge. Undefined means a token bucket was used but its
 * public price is unknown or cannot be represented by the current token-only data
 * (for example Gemini/Volcengine cache storage billed per token-hour).
 */
export function estimateCostUsd(usage: TapModelUsage, price: ModelPriceRule): number | undefined {
  if (!hasExclusiveInputBucket(usage, price)) return undefined;
  if (usage.incompleteFields?.some(field => absenceBlocksBilling(field, price))) return undefined;
  // Token-hour cache storage cannot be derived from token counts, so a model
  // that actually wrote to such a cache has no representable cost.
  if (price.cacheStoragePerHour !== undefined && usage.cacheCreation > 0) return undefined;

  if (isBandedPrice(price)) {
    // Length- and time-tiered rates are decided per request. Without the
    // per-band split there is no honest way to pick one rate for an aggregate,
    // and picking the cheapest band is exactly the 2x-6x under-report that the
    // public catalogues produce.
    if (!usage.bands?.length) return undefined;
    // Bands that do not add up to the usage they belong to would bill only the
    // part they cover and present the shortfall as a total. That happens when an
    // aggregate merges a banded usage with an unbanded one (a session captured
    // before banding existed, or a caller that summed usage and dropped bands),
    // so the shortfall is silent and always understates the bill.
    if (!bandsAccountForUsage(usage)) return undefined;
    let total = 0;
    for (const band of usage.bands) {
      const charge = chargeBucket(band, price, bandRates(price, band.tier, band.offPeak, band.shortOutput));
      if (charge === undefined) return undefined;
      total += charge;
    }
    return total;
  }

  return chargeBucket(usage, price, {
    input: price.input,
    output: price.output,
    cacheRead: price.cacheRead,
    cacheWrite: price.cacheWrite
  });
}
