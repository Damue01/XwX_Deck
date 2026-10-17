import { isRecord } from './object';
import type { ModelPriceRule, ModelPriceTier } from './trace-pricing';
import cacheWritePolicies from './cache-write-policies.json';
import { parseModelsDevReferencePrices } from './models-dev.browser.js';
export const MODELS_DEV_PRICING_URL = 'https://models.dev/api.json';
const CACHE_VERSION = 2;
export interface ModelsDevPricingCache {
  readonly version: 2;
  readonly sourceUrl: string;
  readonly fetchedAt: string;
  readonly etag?: string;
  readonly rules: readonly ModelPriceRule[];
}

export function parseModelsDevPricingCatalog(value: unknown): ModelPriceRule[] {
  return parseModelsDevReferencePrices(value).map(rule => ({ ...rule,
    ...(rule.cacheWrite === undefined ? cacheWritePolicy(rule.canonicalModelId?.split('/')[0] || rule.providerId || '', rule.modelId || '') : {})
  }));
}

/** Replace the active reference snapshot; recorded request prices stay frozen. */
export function mergeRefreshedRules(
  _previous: readonly ModelPriceRule[] | undefined,
  fresh: readonly ModelPriceRule[]
): ModelPriceRule[] {
  // A successful snapshot replaces active reference prices. Historical requests
  // retain their own frozen snapshots; offline fallback uses the whole prior cache.
  return [...fresh];
}

export function normalizeCache(value: unknown): ModelsDevPricingCache | undefined {
  if (!isRecord(value) || value.version !== CACHE_VERSION || !Array.isArray(value.rules)) return undefined;
  if (typeof value.fetchedAt !== 'string' || !Number.isFinite(Date.parse(value.fetchedAt))) return undefined;
  const rules = value.rules.map(normalizeRule).filter((rule): rule is ModelPriceRule => !!rule);
  if (!rules.length) return undefined;
  return {
    version: CACHE_VERSION,
    sourceUrl: typeof value.sourceUrl === 'string' ? value.sourceUrl : MODELS_DEV_PRICING_URL,
    fetchedAt: value.fetchedAt,
    ...(typeof value.etag === 'string' && value.etag ? { etag: value.etag } : {}),
    rules
  };
}

function normalizeRule(value: unknown): ModelPriceRule | undefined {
  if (!isRecord(value) || value.match !== 'exact') return undefined;
  // Ignore caches from the retired multi-source scraper.
  if (value.source !== 'models.dev' || value.referenceOnly !== true) return undefined;
  if (!Array.isArray(value.tokens) || value.tokens.length !== 1 || typeof value.tokens[0] !== 'string') return undefined;
  if (value.protocol !== 'anthropic' && value.protocol !== 'openai') return undefined;
  const input = finiteNonNegative(value.input);
  const output = finiteNonNegative(value.output);
  const cacheRead = finiteNonNegative(value.cacheRead);
  if (input === undefined || output === undefined) return undefined;
  const cacheWrite = finiteNonNegative(value.cacheWrite);
  const cacheWrite1h = finiteNonNegative(value.cacheWrite1h);
  const cacheStoragePerHour = finiteNonNegative(value.cacheStoragePerHour);
  const tiers = normalizeTiers(value.tiers);
  const peak = normalizePeak(value.peak);
  const priceSource = value.priceSource === 'official'
    || value.priceSource === 'consensus'
    || value.priceSource === 'single'
    ? value.priceSource
    : undefined;
  const cacheWritePolicyValue = value.cacheWritePolicy === 'input'
    || value.cacheWritePolicy === 'free'
    || value.cacheWritePolicy === 'storage'
    || value.cacheWritePolicy === 'unknown'
    ? value.cacheWritePolicy
    : undefined;
  const cacheWritePolicySource = value.cacheWritePolicySource === 'official'
    ? value.cacheWritePolicySource
    : undefined;
  // Rebuild legacy models.dev defaults from the shared documented policies;
  // a cached brand guess is not evidence of a published free write rate.
  const policy: Partial<Pick<ModelPriceRule, 'cacheWritePolicy' | 'cacheWritePolicySource'>> = value.source === 'models.dev'
    ? (cacheWrite === undefined ? cacheWritePolicy(typeof value.providerId === 'string' ? value.providerId : '', value.tokens[0]) : {})
    : {
      ...(cacheWritePolicyValue === undefined ? {} : { cacheWritePolicy: cacheWritePolicyValue }),
      ...(cacheWritePolicySource === undefined ? {} : { cacheWritePolicySource })
    };
  return {
    canonicalModelId: typeof value.canonicalModelId === 'string' ? value.canonicalModelId : undefined,
    aliases: Array.isArray(value.aliases) ? value.aliases.filter((v):v is string => typeof v === 'string') : [],
    referencePriority: typeof value.referencePriority === 'number' ? value.referencePriority : 0,
    referenceOnly: true,
    tokens: [value.tokens[0].toLowerCase()],
    match: 'exact',
    protocol: value.protocol,
    input,
    output,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
    ...Object.fromEntries(['reasoning', 'inputAudio', 'outputAudio'].flatMap(key => finiteNonNegative(value[key]) === undefined ? [] : [[key, value[key]]])),
    ...(isRecord(value.fieldSources) ? { fieldSources: Object.fromEntries(Object.entries(value.fieldSources).filter(([, source]) => typeof source === 'string')) as Record<string, string> } : {}),
    ...policy,
    ...(tiers === undefined ? {} : { tiers }),
    ...(peak === undefined ? {} : { peak }),
    ...(cacheStoragePerHour === undefined ? {} : { cacheStoragePerHour }),
    ...(priceSource === undefined ? {} : { priceSource }),
    source: value.source,
    ...(typeof value.providerId === 'string' ? { providerId: value.providerId } : {}),
    ...(typeof value.modelId === 'string' ? { modelId: value.modelId } : {})
  };
}

/**
 * Input-length bands must arrive ascending with the first band starting at 0,
 * because resolvePriceTierIndex() assumes both. A malformed ladder is dropped
 * rather than repaired: the top-level rates already mirror band 0, so the model
 * falls back to a real published rate instead of an invented one.
 */
function normalizeTiers(value: unknown): ModelPriceRule['tiers'] {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const tiers: ModelPriceTier[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const from = finiteNonNegative(entry.fromInputTokens);
    const input = finiteNonNegative(entry.input);
    const output = finiteNonNegative(entry.output);
    if (from === undefined || input === undefined || output === undefined) return undefined;
    if (tiers.length === 0 ? from !== 0 : from <= tiers[tiers.length - 1].fromInputTokens) return undefined;
    const cacheRead = finiteNonNegative(entry.cacheRead);
    const cacheWrite = finiteNonNegative(entry.cacheWrite);
    // A band may carry a cheaper output rate for short replies. Dropping it here
    // would silently restore the 4x over-report it exists to remove.
    const shortOutputRaw = isRecord(entry.shortOutput) ? entry.shortOutput : undefined;
    const shortOutputAtMost = finiteNonNegative(shortOutputRaw?.atMostTokens);
    const shortOutputRate = finiteNonNegative(shortOutputRaw?.output);
    const shortOutput = shortOutputAtMost !== undefined && shortOutputAtMost > 0 && shortOutputRate !== undefined
      ? { atMostTokens: shortOutputAtMost, output: shortOutputRate }
      : undefined;
    tiers.push({
      fromInputTokens: from,
      input,
      output,
      ...Object.fromEntries(['reasoning', 'inputAudio', 'outputAudio'].flatMap(key => finiteNonNegative(entry[key]) === undefined ? [] : [[key, entry[key]]])),
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWrite }),
      ...(finiteNonNegative(entry.cacheWrite1h) === undefined ? {} : {cacheWrite1h:entry.cacheWrite1h as number}),
      ...(shortOutput === undefined ? {} : { shortOutput })
    });
  }
  return tiers;
}

/** Peak windows are [startHour, endHour) in UTC and the multiplier is a discount. */
function normalizePeak(value: unknown): ModelPriceRule['peak'] {
  if (!isRecord(value)) return undefined;
  const multiplier = finiteNonNegative(value.offPeakMultiplier);
  if (multiplier === undefined || multiplier > 1) return undefined;
  if (!Array.isArray(value.peakWindowsUtc) || !value.peakWindowsUtc.length) return undefined;
  const windows: [number, number][] = [];
  for (const window of value.peakWindowsUtc) {
    if (!Array.isArray(window) || window.length !== 2) return undefined;
    const from = finiteNonNegative(window[0]);
    const to = finiteNonNegative(window[1]);
    if (from === undefined || to === undefined || from > 24 || to > 24 || from >= to) return undefined;
    windows.push([from, to]);
  }
  return { peakWindowsUtc: windows, offPeakMultiplier: multiplier };
}

function cacheWritePolicy(
  providerId: string, modelId: string
): Partial<Pick<ModelPriceRule, 'cacheWritePolicy' | 'cacheWritePolicySource' | 'cacheStorageScope'>> {
  const policy = cacheWritePolicies.find(rule => rule.providerId === providerId
    && (!rule.modelPattern || new RegExp(rule.modelPattern).test(modelId.toLowerCase())));
  return policy ? { cacheWritePolicy: policy.policy as 'input' | 'storage', cacheWritePolicySource: 'official',
    ...(policy.storageScope === 'explicit' ? { cacheStorageScope: 'explicit' as const } : {}) } : {};
}

export function newestCache(...values: readonly (ModelsDevPricingCache | undefined)[]): ModelsDevPricingCache | undefined {
  return values.filter((value): value is ModelsDevPricingCache => !!value)
    .sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))[0];
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
