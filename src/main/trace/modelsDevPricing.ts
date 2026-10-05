import * as path from 'path';
import { readTextOrUndefined, writeJson } from '../shared/fsx';
import { isRecord } from '../shared/obj';
import { ModelPriceRule, ModelPriceTier, setCatalogPriceRules } from './pricing';

export const MODELS_DEV_PRICING_URL = 'https://models.dev/api.json';
const CACHE_VERSION = 2;
const MAX_RULES = 5_000;
const MAX_TIERS = 8;

const OFFICIAL_PROVIDERS = [
  ['anthropic', 'anthropic'],
  ['openai', 'openai'],
  ['deepseek', 'openai'],
  ['google', 'openai'],
  ['xai', 'openai'],
  ['moonshotai', 'openai'],
  ['alibaba', 'openai'],
  ['zhipuai', 'openai'],
  ['minimax', 'openai']
] as const satisfies readonly (readonly [string, ModelPriceRule['protocol']])[];

export interface ModelsDevPricingCache {
  readonly version: 2;
  readonly sourceUrl: string;
  readonly fetchedAt: string;
  readonly etag?: string;
  readonly rules: readonly ModelPriceRule[];
}

export interface ModelsDevPricingLoadOptions {
  readonly userDataDir: string;
  readonly bundledCachePath: string;
}

export interface ModelsDevPricingRefreshResult {
  readonly status: 'updated' | 'not-modified';
  readonly ruleCount: number;
  readonly cachePath: string;
}

type PricingFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function modelsDevPricingCachePath(userDataDir: string): string {
  return path.join(userDataDir, 'pricing-cache', 'models-dev-pricing.json');
}

/** Convert the large models.dev provider catalog into exact-id token price rules. */
export function parseModelsDevPricingCatalog(value: unknown): ModelPriceRule[] {
  if (!isRecord(value)) return [];
  const rules: ModelPriceRule[] = [];
  for (const [providerId, protocol] of OFFICIAL_PROVIDERS) {
    const provider = isRecord(value[providerId]) ? value[providerId] : undefined;
    const models = provider && isRecord(provider.models) ? provider.models : undefined;
    if (!models) continue;
    for (const modelId of Object.keys(models).sort((a, b) => a.localeCompare(b))) {
      const model = isRecord(models[modelId]) ? models[modelId] : undefined;
      const cost = model && isRecord(model.cost) ? model.cost : undefined;
      const input = finiteNonNegative(cost?.input);
      const output = finiteNonNegative(cost?.output);
      if (input === undefined || output === undefined) continue;
      const cacheWrite = finiteNonNegative(cost?.cache_write);
      const cacheRead = plausibleCacheRead(finiteNonNegative(cost?.cache_read), input);
      rules.push({
        tokens: [modelId.toLowerCase()],
        match: 'exact',
        protocol,
        input,
        output,
        ...(cacheRead === undefined ? {} : { cacheRead }),
        ...(cacheWrite === undefined ? {} : { cacheWrite }),
        ...(cacheWrite === undefined ? cacheWritePolicy(providerId) : {}),
        source: 'models.dev',
        providerId,
        modelId
      });
    }
  }
  return rules;
}

/**
 * Reject a cache-read rate that cannot plausibly be a published discount.
 *
 * First-party cache-read rates cluster tightly at 10%, 16%, 20%, 25% and 50% of
 * the input rate. models.dev ships several rows an order of magnitude off — every
 * DeepSeek model carried a ratio near 2% where the vendor publishes 3.3%, which
 * is a misplaced decimal point, not a discount. Dropping the field leaves the
 * bucket unpriced and the model reports no cost, which is the honest outcome;
 * keeping it would quietly bill cache reads at a tenth of the real rate.
 *
 * The same rule runs in tools/dev/update-model-pricing.mjs against every source, so
 * this guard is what stops a live refresh from reintroducing what the build-time
 * validator already rejected.
 */
function plausibleCacheRead(cacheRead: number | undefined, input: number): number | undefined {
  if (cacheRead === undefined) return undefined;
  if (cacheRead === 0 || input <= 0) return cacheRead;
  const ratio = cacheRead / input;
  return ratio >= 0.05 && ratio <= 0.6 ? cacheRead : undefined;
}

/** Load the newest valid bundled/user cache without touching the network. */
export async function loadModelsDevPricingCache(options: ModelsDevPricingLoadOptions): Promise<number> {
  const diskPath = modelsDevPricingCachePath(options.userDataDir);
  const [bundled, disk] = await Promise.all([
    readCache(options.bundledCachePath),
    readCache(diskPath)
  ]);
  const selected = newestCache(bundled, disk);
  setCatalogPriceRules(selected?.rules ?? []);
  return selected?.rules.length ?? 0;
}

/** Fetch, validate, persist, and activate a new last-known-good price cache. */
export async function refreshModelsDevPricingCache(
  options: ModelsDevPricingLoadOptions,
  fetcher: PricingFetcher = fetch
): Promise<ModelsDevPricingRefreshResult> {
  const cachePath = modelsDevPricingCachePath(options.userDataDir);
  const previous = newestCache(await readCache(options.bundledCachePath), await readCache(cachePath));
  const headers: Record<string, string> = { accept: 'application/json' };
  if (previous?.etag) headers['if-none-match'] = previous.etag;
  const response = await fetcher(MODELS_DEV_PRICING_URL, {
    headers,
    signal: AbortSignal.timeout(12_000)
  });
  if (response.status === 304 && previous) {
    setCatalogPriceRules(previous.rules);
    return { status: 'not-modified', ruleCount: previous.rules.length, cachePath };
  }
  if (!response.ok) throw new Error(`models.dev pricing HTTP ${response.status}`);
  const fresh = parseModelsDevPricingCatalog(await response.json() as unknown);
  if (!fresh.length) throw new Error('models.dev pricing catalog contained no supported official models.');
  const rules = mergeRefreshedRules(previous?.rules, fresh);
  const cache: ModelsDevPricingCache = {
    version: CACHE_VERSION,
    sourceUrl: MODELS_DEV_PRICING_URL,
    fetchedAt: new Date().toISOString(),
    ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
    rules
  };
  await writeJson(cachePath, cache);
  setCatalogPriceRules(cache.rules);
  return { status: 'updated', ruleCount: cache.rules.length, cachePath };
}

/**
 * Fold a fresh models.dev fetch into the curated rule set instead of replacing it.
 *
 * The bundled asset is not a models.dev mirror: tools/dev/update-model-pricing.mjs
 * arbitrates three catalogues, overrides them with vendor rate-card scrapes, and
 * rejects values its validators distrust. models.dev alone cannot express any of
 * the length bands, peak schedules, TTL write tiers or token-hour storage rates
 * that asset carries, and it is measurably wrong where it matters most — it was
 * still publishing a retired qwen-vl-ocr snapshot at 16.7x the current rate and
 * a DeepSeek cache-read rate off by 10x. A wholesale replace therefore threw the
 * curated data away on the first refresh and reinstated those errors.
 *
 * So a refresh only contributes ids the curated set does not know about yet.
 * Existing ids are refreshed by re-running update:pricing at build time, where
 * the cross-checks and vendor scrapes run.
 */
function mergeRefreshedRules(
  curated: readonly ModelPriceRule[] | undefined,
  fresh: readonly ModelPriceRule[]
): ModelPriceRule[] {
  if (!curated?.length) return [...fresh];
  const known = new Set(curated.map(rule => exactRuleId(rule)).filter(Boolean));
  const added = fresh.filter(rule => {
    const id = exactRuleId(rule);
    return !!id && !known.has(id);
  });
  return [...curated, ...added];
}

function exactRuleId(rule: ModelPriceRule): string {
  return (rule.modelId || rule.tokens[0] || '').toLowerCase();
}

async function readCache(file: string): Promise<ModelsDevPricingCache | undefined> {
  const text = await readTextOrUndefined(file);
  if (!text) return undefined;
  try { return normalizeCache(JSON.parse(text) as unknown); }
  catch { return undefined; }
}

function normalizeCache(value: unknown): ModelsDevPricingCache | undefined {
  if (!isRecord(value) || value.version !== CACHE_VERSION || !Array.isArray(value.rules)) return undefined;
  if (typeof value.fetchedAt !== 'string' || !Number.isFinite(Date.parse(value.fetchedAt))) return undefined;
  const rules = value.rules.slice(0, MAX_RULES).map(normalizeRule).filter((rule): rule is ModelPriceRule => !!rule);
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
  // The bundled asset is built by tools/dev/update-model-pricing.mjs, which arbitrates
  // models.dev against LiteLLM/Vercel and overrides both with vendor rate-card
  // scrapes. Those scraped rows are tagged 'official', so restricting this to
  // 'models.dev' would silently drop every price we trust most.
  if (value.source !== 'models.dev' && value.source !== 'official') return undefined;
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
  return {
    tokens: [value.tokens[0].toLowerCase()],
    match: 'exact',
    protocol: value.protocol,
    input,
    output,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
    ...(cacheWritePolicyValue === undefined ? {} : { cacheWritePolicy: cacheWritePolicyValue }),
    ...(cacheWritePolicySource === undefined ? {} : { cacheWritePolicySource }),
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
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_TIERS) return undefined;
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
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWrite }),
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
  providerId: string
): Partial<Pick<ModelPriceRule, 'cacheWritePolicy' | 'cacheWritePolicySource'>> {
  if (providerId === 'openai' || providerId === 'deepseek' || providerId === 'xai') {
    return { cacheWritePolicy: 'input', cacheWritePolicySource: 'official' };
  }
  if (providerId === 'google') return { cacheWritePolicy: 'storage', cacheWritePolicySource: 'official' };
  return {};
}

function newestCache(...values: readonly (ModelsDevPricingCache | undefined)[]): ModelsDevPricingCache | undefined {
  return values.filter((value): value is ModelsDevPricingCache => !!value)
    .sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt))[0];
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
