import { estimateTraceCost } from './trace-pricing.browser.js';
import { TapModelUsage } from './trace-types';
import { traceCostBreakdown } from './trace-cost.browser.js';
import { findModelReference } from './models-dev.browser.js';

/**
 * 模型价格规则（USD / 1M tokens，官方牌价）。
 * 使用 models.dev 标准身份及唯一别名匹配，不做型号家族子串兜底。
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
 * Select bands per request from the models.dev context thresholds.
 */
export interface ModelPriceTier {
  /** Inclusive lower bound, in total prompt tokens. The first tier starts at 0. */
  readonly fromInputTokens: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cacheWrite1h?: number;
  readonly reasoning?: number;
  readonly inputAudio?: number;
  readonly outputAudio?: number;
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
  readonly peakDaysUtc?: readonly number[];
  readonly calendarUtcOffsetHours?: number;
  readonly offPeakDateRanges?: readonly (readonly string[])[];
}

export interface ModelPriceRule {
  readonly canonicalModelId?: string;
  readonly aliases?: readonly string[];
  readonly referencePriority?: number;
  readonly referenceOnly?: boolean;
  readonly billingTime?: 'completedAt';
  readonly fxCnyPerUsd?: number;
  readonly fxDate?: string;
  readonly listPriceCny?: Readonly<Record<string, number>>;
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
  /** Separate token rates, when published. Reasoning is a subset of output. */
  readonly reasoning?: number;
  readonly inputAudio?: number;
  readonly outputAudio?: number;
  readonly fieldSources?: Readonly<Record<string, string>>;
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
  /** Ark implicit caches have no storage charge; explicit caching is separate. */
  readonly cacheStorageScope?: 'explicit';
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

let catalogPriceRules: readonly ModelPriceRule[] = [];
export function setCatalogPriceRules(rules: readonly ModelPriceRule[]): void { catalogPriceRules = [...rules]; }
export function getPriceRules(): readonly ModelPriceRule[] { return catalogPriceRules; }
export function findModelPrice(model: string, rules: readonly ModelPriceRule[] = getPriceRules()): ModelPriceRule | undefined {
  return findModelReference(model, rules);
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
  if (price.providerId === 'deepseek' || price.providerId === 'xai') {
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
  if(schedule.peakDaysUtc && !schedule.peakDaysUtc.includes(new Date(atMs).getUTCDay())) return true;
  const date = new Date(atMs + (schedule.calendarUtcOffsetHours || 0)*3600000).toISOString().slice(0,10);
  if(schedule.offPeakDateRanges?.some(([from,to]) => date >= from && date <= to)) return true;
  return !schedule.peakWindowsUtc.some(([from, to]) => hour >= from && hour < to);
}

/** Legacy time/length bands remain readable from frozen request snapshots. */
export function isBandedPrice(price: ModelPriceRule): boolean { return !!price.tiers?.length || !!price.peak?.peakWindowsUtc.length; }
export function estimateCostUsd(usage: TapModelUsage, price: ModelPriceRule): number | undefined {
  return estimateTraceCost(usage, price);
}

/** Known components remain useful even when the full charge is unavailable. */
export function estimateCostBreakdown(usage: TapModelUsage, price: ModelPriceRule): { cost?: number; complete: boolean } {
  return traceCostBreakdown(usage, price, estimateCostUsd);
}
