/**
 * Regenerate assets/models-dev-pricing.json — the bundled price catalogue that
 * src/main/trace/pricing.ts loads through setCatalogPriceRules().
 *
 * WHY THIS IS NOT A SINGLE-SOURCE FETCH ANY MORE
 * ----------------------------------------------
 * The previous version mirrored models.dev verbatim. models.dev has the widest
 * coverage of any free catalogue, but it is structurally unable to express three
 * things this app needs, and it silently publishes stale rows:
 *   - No 1-hour cache-write tier at all, so every Anthropic model lost the TTL
 *     price that estimateCostUsd() needs to bill a 1h cache creation.
 *   - No cache-storage-per-hour field, so Volcengine/Gemini token-hour caches
 *     looked free.
 *   - No input-length bands, so it flattens Alibaba and Volcengine to the
 *     cheapest band and under-reports long contexts by up to 6x.
 *   - No retirement marker on first-party rows (anthropic/deepseek/alibaba/
 *     moonshotai all report 0 deprecated models), so withdrawn SKUs keep their
 *     last-seen price forever — e.g. qwen-vl-ocr still carries the 2024-10-28
 *     snapshot price, 16.7x above the current rate.
 *
 * So this tool cross-references three list-price catalogues, layers the two cloud
 * price APIs that are machine-readable and officially published on top, overrides
 * both with scrapes of the four vendors whose rates none of the catalogues get
 * right, and runs two automatic sanity checks before anything is allowed into the
 * asset.
 *
 * SOURCES AND WHY EACH ONE IS HERE
 * --------------------------------
 *  1. models.dev            — widest coverage (6.7k models across 190 providers).
 *                             Used for breadth and, via its many reseller
 *                             mirrors of the same model id, for the cross-provider
 *                             mode check (validation B).
 *  2. LiteLLM               — the only catalogue that publishes
 *                             cache_creation_input_token_cost_above_1hr (the 1h
 *                             Anthropic tier), tiered_pricing, deprecation_date,
 *                             and a volcengine/* block. Every row cites an
 *                             official source URL, so it is re-checkable.
 *  3. Vercel AI Gateway     — no auth required, and the only catalogue that
 *                             models Chinese vendors' length bands natively
 *                             (pricing.input_tiers / output_tiers /
 *                             input_cache_read_tiers).
 *  4. Azure Retail Prices   — Microsoft's own billing meters, no auth. The only
 *                             machine-readable *official* rate card that covers
 *                             OpenAI, xAI, DeepSeek, Moonshot and Qwen in one
 *                             place, and it splits every model into explicit
 *                             cached-input / cache-write / short- vs long-context
 *                             meters. See parseAzureFoundry().
 *  5. AWS Bedrock price list— Amazon's own billing meters, no auth. The only
 *                             official source with BOTH Anthropic cache TTL tiers
 *                             as separate meters (CacheWriteInputTokenCount vs
 *                             CacheWrite1hInputTokenCount), so it is the
 *                             independent corroboration for the 1h price that
 *                             LiteLLM is otherwise alone in publishing.
 *  6. OpenRouter endpoints  — read PER ENDPOINT, never in aggregate, and used for
 *                             cache columns only. See the OPENROUTER block below.
 *  7. Helicone registry     — the only public registry with
 *                             cacheStoragePerHour. Used ONLY to corroborate
 *                             Google's token-hour cache storage fee.
 *
 * Deliberately excluded: Requesty, and every reseller endpoint on OpenRouter.
 * Both publish *resale* prices — the same model id is offered by ~18 endpoints
 * spanning a 6.5x range — so including them in a median would drag every rate
 * toward whatever markup the most numerous reseller applies. models.dev's
 * reseller providers are read for validation B only, never as a price candidate.
 *
 * OPENROUTER: WHY PER-ENDPOINT, AND WHY CACHE COLUMNS ONLY
 * -------------------------------------------------------
 * The top-level https://openrouter.ai/api/v1/models feed reports, for each model,
 * the price of its CHEAPEST endpoint. Measured 2026-08-19: it quotes gpt-5.6-sol
 * at $2.50/1M input — exactly half the standard rate, because OpenAI also sells a
 * discounted tier through the same account. That feed is therefore never read for
 * a price; it is fetched once purely to enumerate slugs.
 *
 * The per-endpoint feed .../models/{author}/{slug}/endpoints is what gets read.
 * Each endpoint carries `provider_name`, a `tag`, and pricing in USD/token. The
 * `tag` is what separates service tiers, and the same first-party provider ships
 * several. Measured for openai/gpt-5.6-sol on 2026-08-19:
 *     tag=openai           in=2.50   (a discounted tier)
 *     tag=openai/flex      in=1.25   (flex)
 *     tag=openai/priority  in=5.00   (matches the official standard rate)
 *     tag=azure            in=5.00   (matches)
 *     tag=azure/us         in=5.50   (+10% region uplift)
 * So "take the first-party endpoint" is not enough and "take the cheapest" is
 * actively wrong. Three guards are applied instead:
 *   a. only endpoints whose tag root is the model's own vendor (or, for the
 *      overseas vendors, Azure / Bedrock / Vertex) are considered — no reseller;
 *   b. flex and batch tiers and region uplifts are dropped by tag;
 *   c. every surviving endpoint is ANCHORED: its `prompt` and `completion` must
 *      both match the already-arbitrated input/output within AGREEMENT_TOLERANCE.
 *      An endpoint that fails the anchor is describing a different service tier or
 *      carrying a markup, so ALL of its cache columns are discarded too — not just
 *      its price. This is what stops deepseek's endpoint (0.66/1.98/0.022, the
 *      official OFF-PEAK card) from overwriting the busy-hour rates we store.
 * Only after the anchor passes are `input_cache_read`, `input_cache_write` and
 * `input_cache_write_1h` adopted, and only into columns that are still empty.
 *
 * OpenRouter is never allowed to vote on input/output. Its price column cannot be
 * distinguished from a service-tier discount without an anchor, and once anchored
 * it agrees with the anchor by construction, so it carries no new information
 * about the price — only about the cache columns, which is precisely where it is
 * the richest public source (`input_cache_write_1h` exists nowhere else, and it
 * fills cacheRead for models the three catalogues leave blank).
 *
 * AZURE / AWS: OFFICIAL, BUT OFFICIAL FOR *THEIR* CLOUD
 * ----------------------------------------------------
 * Azure and AWS publish their own resale rate, not the vendor's. For the overseas
 * vendors the two coincide: measured 2026-08-19, Azure's `5.6 sol ShortCo Inp Std
 * Gl` is $5.00 and AWS's `Claude Sonnet 5 input_tokens_global_standard` is $2.00,
 * both identical to the vendors' own cards, and both clouds additionally publish
 * the cached-input / cache-write meters. For the Chinese vendors they do not:
 * Azure's `V4 Pro Inp glbl` is $1.74 against DeepSeek's own $1.32 (+32%).
 *
 * Hence the split enforced by CLOUD_PRICE_PROVIDERS below — Azure/AWS are a price
 * source only for anthropic/openai/google/xai, and for everyone else they are
 * read as corroboration and logged in audit.cloud.conflicts when they disagree.
 * Even inside those four they are vetoed by a real catalogue consensus: Azure
 * quotes gpt-5.6-terra at $2.50 where all three catalogues say $2.00.
 * What this app needs is the order-of-magnitude list price a 兼容服务 relay bills
 * against, not an Azure invoice, so on any conflict the vendor's own page (or the
 * consensus) wins and the disagreement is reported rather than silently averaged.
 *
 * OFFICIAL SCRAPERS AND WHY THEY OVERRIDE EVERYTHING
 * --------------------------------------------------
 *  - DeepSeek (api-docs.deepseek.com/quick_start/pricing): switched to peak /
 *    off-peak pricing. No aggregator models a time-of-day schedule, so all three
 *    are wrong by 2x in one direction. The page also proves that only
 *    deepseek-v4-flash and deepseek-v4-pro are billable ids — DeepSeek-V4-*-0731
 *    is a MODEL VERSION row, not a SKU — and that deepseek-chat /
 *    deepseek-reasoner are gone.
 *  - Alibaba (alibabacloud.com/help/en/model-studio/model-pricing): the
 *    international (Singapore) rate card, which is denominated in USD, so no FX
 *    conversion is needed. It is the only source with the real length bands and
 *    the only one with the current qwen-vl-ocr rate.
 *  - Volcengine (volcengine.com/api/doc/getDocDetail?DocumentID=1544106): the
 *    only place doubao's three input-length bands and the ¥0.017/M-token-hour
 *    cache storage fee are published. CNY only, hence the FX constant below.
 *  - Google cache storage: taken from Helicone, cross-checked against Google's
 *    published $1.00 (Flash) / $4.50 (Pro) per 1M tokens per hour.
 *
 * ARBITRATION — see PRICE_PRIORITY. Recorded per rule in `priceSource` (the
 * closed union the runtime validates) and `priceSourceDetail` (free text, ignored
 * by the runtime, kept so the viewer's price table can show provenance).
 */
import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(projectRoot, 'assets', 'models-dev-pricing.json');

/**
 * CNY -> USD conversion. Only Volcengine needs it: Ark publishes 元/百万token
 * and has no USD rate card. Alibaba is read from its USD international page
 * precisely so that no conversion error enters the qwen prices.
 *
 * Rate obtained 2026-08-18 from https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY
 * ("date":"2026-08-18","rates":{"CNY":6.7423}). Cross-checked the same day
 * against https://open.er-api.com/v6/latest/USD (CNY 6.753148, +0.16%).
 *
 * Every rule derived through this constant carries `fxCnyPerUsd` so the
 * conversion is traceable back to the published CNY figure, and the CNY figure
 * itself is kept in `listPriceCny`.
 */
const FX = {
  cnyPerUsd: 6.7423,
  obtainedAt: '2026-08-18',
  obtainedFrom: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY',
  crossCheck: 'https://open.er-api.com/v6/latest/USD -> 6.753148 (+0.16%)'
};

const SOURCE_URLS = {
  modelsDev: 'https://models.dev/api.json',
  liteLlm: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
  vercel: 'https://ai-gateway.vercel.sh/v1/models',
  helicone: 'https://api.helicone.ai/v1/public/model-registry/models',
  // Foundry Models is the current serviceName. 'Cognitive Services' — the name
  // every older integration uses — now returns Count=0, so a filter typo here
  // fails silently as "Azure has no prices" rather than as an error.
  azureRetail: "https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'Foundry Models'",
  awsIndex: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json',
  awsHost: 'https://pricing.us-east-1.amazonaws.com',
  openRouterModels: 'https://openrouter.ai/api/v1/models',
  openRouterEndpoints: 'https://openrouter.ai/api/v1/models/{slug}/endpoints',
  deepseek: 'https://api-docs.deepseek.com/quick_start/pricing',
  alibaba: 'https://www.alibabacloud.com/help/en/model-studio/model-pricing.md',
  alibabaCache: 'https://help.aliyun.com/zh/model-studio/context-cache.md',
  volcengine: 'https://www.volcengine.com/api/doc/getDocDetail?DocumentID=1544106'
};

/**
 * The arbitration ladder, as code rather than as prose, because it is the one
 * thing in this file that must be auditable at a glance.
 *
 *   overseas (anthropic/openai/google/xai)
 *     vendor's own page  >  Azure/AWS official API  >  3-catalogue median  >  single
 *   domestic (deepseek/alibaba/volcengine/moonshotai/zhipuai/minimax)
 *     vendor's own page  >  3-catalogue median  >  single
 *     (Azure/AWS are corroboration only here: they are reselling, see the header)
 *   cache columns still empty after the above
 *     OpenRouter first-party endpoint, anchored  >  Helicone (cacheStoragePerHour only)
 *   never adopted, under any circumstance
 *     the OpenRouter top-level aggregate price, any flex/batch tier, any region
 *     uplift, any reseller endpoint
 *
 * One veto sits on top of the tier order, in reconcileCloudOfficial(): a cloud rate
 * that contradicts the vendor's page OR a rate two or more catalogues independently
 * agree on is withdrawn for that model and reported in audit.cloud.conflicts.
 * "Azure beats the median" means it beats a median nobody actually agrees on — it
 * does not mean it beats a real cross-checked consensus.
 *
 * `tier` is the numeric rank arbitrate() sorts on; the lowest non-empty tier wins
 * outright and the tiers below it are never averaged in.
 */
const PRICE_PRIORITY = [
  { tier: 0, source: 'official', what: "the vendor's own published rate card, scraped" },
  { tier: 1, source: 'azure', what: 'Azure Retail Prices API, global standard meter' },
  { tier: 1, source: 'aws', what: 'AWS Bedrock price list, global standard meter' },
  { tier: 2, source: 'models.dev', what: 'list-price catalogue' },
  { tier: 2, source: 'litellm', what: 'list-price catalogue' },
  { tier: 2, source: 'vercel', what: 'list-price catalogue' },
  { tier: 3, source: 'openrouter', what: 'first-party endpoint, cache columns only, anchored' }
];
const SOURCE_TIER = new Map(PRICE_PRIORITY.map(entry => [entry.source, entry.tier]));
const CATALOGUE_TIER = 2;

/**
 * Providers for which Azure/AWS may set a price, not merely corroborate one.
 * Measured 2026-08-19: for these four the clouds' global-standard meter equals
 * the vendor's own card to the cent, while for every Chinese vendor it carries the
 * cloud's markup (Azure `V4 Pro Inp glbl` $1.74 vs DeepSeek's own $1.32).
 */
const CLOUD_PRICE_PROVIDERS = new Set(['anthropic', 'openai', 'google', 'xai']);

/**
 * Providers that bill a context cache as token-hour STORAGE rather than as a
 * per-token write. For these, a per-token `input_cache_write` is not a price this
 * app can charge — and OpenRouter's value for it is demonstrably the storage fee
 * re-expressed: measured 2026-08-19 it reports 0.0833 for gemini-3.5-flash and
 * 0.375 for gemini-3.1-pro, which are exactly Google's published $1.00 (Flash) and
 * $4.50 (Pro) per-1M-per-hour storage rates divided by 12. Adopting them would let
 * estimateCostUsd() bill a cache creation twice under two different models.
 */
const STORAGE_BILLED_PROVIDERS = new Set(['google', 'volcengine']);

/**
 * OpenRouter tag roots that are the vendor itself. The root is the segment before
 * the first '/' in `tag`; everything after it is a qualifier.
 */
const OPENROUTER_FIRST_PARTY_TAGS = new Map([
  ['openai', 'openai'],
  ['anthropic', 'anthropic'],
  ['google-vertex', 'google'],
  ['google-ai-studio', 'google'],
  ['xai', 'xai'],
  ['deepseek', 'deepseek'],
  ['moonshotai', 'moonshotai'],
  ['alibaba', 'alibaba'],
  ['z-ai', 'zhipuai'],
  ['minimax', 'minimax'],
  ['bytedance', 'volcengine'],
  ['volcengine', 'volcengine']
]);

/**
 * Tag roots that are a cloud reselling someone else's model at (for the overseas
 * vendors) the vendor's own rate. Accepted only when the model's native provider
 * is in CLOUD_PRICE_PROVIDERS, and still subject to the anchor.
 */
const OPENROUTER_CLOUD_TAGS = new Set(['azure', 'amazon-bedrock', 'claude-on-aws', 'google-vertex']);

/**
 * Tag qualifiers that mark a different SKU. `flex` and `batch` are discounted
 * asynchronous tiers; the region codes are the +10% locality uplift. Quantisation
 * qualifiers (`fp8`, `int4`, …) are NOT excluded — Moonshot's own endpoint is
 * tagged `moonshotai/int4` and is the first-party rate — and neither is
 * `priority`, because for gpt-5.6-sol `openai/priority` is the tag that carries
 * the official standard rate while the bare `openai` tag is a discount. Deciding
 * which of a vendor's tiers is "the" rate is the anchor's job, not a name's.
 */
const OPENROUTER_EXCLUDED_QUALIFIERS = new Set(['flex', 'batch', 'scale', 'us', 'eu', 'europe', 'asia', 'apac', 'india', 'japan']);
const OPENROUTER_REGION_QUALIFIER = /^[a-z]{2,4}-[a-z]+-\d+$/;

/** OpenRouter author prefix -> our provider id. Authors not listed are resellers
 *  or third-party fine-tunes and are never fetched. */
const OPENROUTER_AUTHORS = new Map([
  ['openai', 'openai'],
  ['anthropic', 'anthropic'],
  ['google', 'google'],
  ['x-ai', 'xai'],
  ['deepseek', 'deepseek'],
  ['qwen', 'alibaba'],
  ['alibaba', 'alibaba'],
  ['moonshotai', 'moonshotai'],
  ['z-ai', 'zhipuai'],
  ['zhipu', 'zhipuai'],
  ['minimax', 'minimax'],
  ['bytedance', 'volcengine'],
  ['bytedance-seed', 'volcengine']
]);

/**
 * Azure `productName` -> the provider whose models that product family holds, and
 * the id prefix the vendor uses. Azure strips the family name out of its skuName
 * ("5.6 sol", "V4 Pro", "K2.5 Thinking"), so the prefix has to be put back from
 * the product family before the id can be matched.
 */
const AZURE_PRODUCT_FAMILIES = new Map([
  ['Azure OpenAI', { providerId: 'openai', prefix: 'gpt' }],
  ['Azure OpenAI GPT5', { providerId: 'openai', prefix: 'gpt' }],
  ['Azure OpenAI Reasoning', { providerId: 'openai', prefix: 'gpt' }],
  ['Azure OpenAI Embedding', { providerId: 'openai', prefix: 'text-embedding' }],
  ['Azure OpenAI OSS Models', { providerId: 'openai', prefix: 'gpt-oss' }],
  ['Azure Grok Models', { providerId: 'xai', prefix: 'grok' }],
  ['Azure Deepseek Models', { providerId: 'deepseek', prefix: 'deepseek' }],
  ['Azure Kimi', { providerId: 'moonshotai', prefix: 'kimi' }],
  ['Qwen models', { providerId: 'alibaba', prefix: 'qwen' }]
]);

/**
 * Azure skuName vocabulary. Everything in here is a billing dimension, not part
 * of the model name, so it is stripped before the id is reconstructed.
 *
 * `opt` is Azure's abbreviation for OUTPUT ("5.6 sol ShortCo Opt Std Gl" = $30),
 * not for "optimized" — reading it the other way round silently swaps every
 * OpenAI model's input and output rate.
 */
const AZURE_SKU_VOCABULARY = new Set([
  'cd', 'wr', 'cached', 'cchd', 'cache', 'write', 'read',
  'inp', 'inpt', 'input', 'outp', 'outpt', 'opt', 'out', 'output',
  'std', 'standard', 'gl', 'glbl', 'global', 'dz', 'dzone', 'dzn', 'data', 'zone',
  'regnl', 'rgnl', 'regional', 'shortco', 'longco', 'l', '1m', '1k', 'tokens'
]);
/** Trailing words Azure adds that are a capability label, not a separate SKU:
 *  "K2.5 Thinking" and "K2.5" are the same billable model. `code` is NOT here —
 *  kimi-k2.7-code really is priced apart from kimi-k2.7. */
const AZURE_DESCRIPTOR_WORDS = new Set(['thinking', 'chat', 'instruct', 'text', 'models', 'model']);
/** Non-standard service tiers and non-inference meters. `pp` is Azure's
 *  provisioned/priority tier and runs at exactly 2x standard. */
const AZURE_EXCLUDED_WORDS = /\b(batch|pp|ft|prov|provisioned|reserved|overage|spill|grdr|mdl|hosting|deployment|session|unit|units)\b/;
/** Sovereign clouds carry their own uplift (US Gov +25%) and must not be mistaken
 *  for a second opinion about the commercial global rate. */
const AZURE_EXCLUDED_REGIONS = /^(usgov|usdod|usnat|ussec|china)/;

/** AWS Bedrock servicename suffix and the usagetype meters we accept. */
const AWS_BEDROCK_OFFER = 'AmazonBedrockFoundationModels';
const AWS_BEDROCK_REGION = 'us-east-1';
const AWS_EXCLUDED_METERS = /batch|latencyoptimized|reserved|provisioned|customization|customizationtoken|modelstorage|tpm/i;



/**
 * Providers we emit rules for, with the id each source files them under.
 * `protocol` is the wire shape 兼容服务 bridges them as; it decides how
 * estimateCostUsd() splits the cache buckets.
 *
 * volcengine has no first-party block on models.dev at all (only resellers such
 * as qiniu-ai / nano-gpt / zenmux mirror doubao), which is why it is fed purely
 * from the official Ark doc plus LiteLLM.
 */
const PROVIDERS = [
  { id: 'anthropic', protocol: 'anthropic', modelsDev: 'anthropic', liteLlm: 'anthropic', vercel: 'anthropic' },
  { id: 'openai', protocol: 'openai', modelsDev: 'openai', liteLlm: 'openai', vercel: 'openai' },
  { id: 'deepseek', protocol: 'openai', modelsDev: 'deepseek', liteLlm: 'deepseek', vercel: 'deepseek' },
  { id: 'google', protocol: 'openai', modelsDev: 'google', liteLlm: 'gemini', vercel: 'google' },
  { id: 'xai', protocol: 'openai', modelsDev: 'xai', liteLlm: 'xai', vercel: 'xai' },
  { id: 'moonshotai', protocol: 'openai', modelsDev: 'moonshotai', liteLlm: 'moonshot', vercel: 'moonshotai' },
  { id: 'alibaba', protocol: 'openai', modelsDev: 'alibaba', liteLlm: 'dashscope', vercel: 'alibaba' },
  { id: 'zhipuai', protocol: 'openai', modelsDev: 'zhipuai', liteLlm: 'zai', vercel: 'zai' },
  { id: 'minimax', protocol: 'openai', modelsDev: 'minimax', liteLlm: 'minimax', vercel: 'minimax' },
  { id: 'volcengine', protocol: 'openai', modelsDev: null, liteLlm: 'volcengine', vercel: 'bytedance' }
];

/**
 * Which provider owns a model id natively. Aggregators file hosted copies of a
 * rival's model under the host (dashscope/deepseek-v4-pro, Ark's glm-5.2), and
 * those copies carry the *host's* resale rate. findModelPrice() matches on model
 * id alone, so a hosted duplicate would be indistinguishable from the vendor's
 * own SKU — we keep the native one and drop the rest.
 */
const NATIVE_PROVIDER_BY_PREFIX = [
  [/^claude|^anthropic\./, 'anthropic'],
  [/^gpt-|^o[1345](-|$)|^chatgpt|^codex|^text-embedding|^sora/, 'openai'],
  [/^deepseek/, 'deepseek'],
  [/^gemini|^imagen|^veo|^palm/, 'google'],
  [/^grok/, 'xai'],
  [/^kimi|^moonshot/, 'moonshotai'],
  [/^qwen|^qwq|^qvq|^tongyi|^wanx/, 'alibaba'],
  [/^glm|^charglm|^cogview/, 'zhipuai'],
  [/^minimax|^abab/, 'minimax'],
  [/^doubao|^seed-|^seedance|^seedream/, 'volcengine']
];

/**
 * Explicit alias map for surface ids that carry a release code and therefore do
 * not normalise onto the vendor's documented id. Kept tiny and explicit rather
 * than adding a "strip trailing digits" rule, which would collapse dated SKUs
 * such as qwen3-max-2026-01-23 onto qwen3-max and hide a real price difference.
 */
const ID_ALIASES = new Map([
  ['doubao-seed-2-0-pro-260215', 'doubao-seed-2-0-pro'],
  ['doubao-seed-2-0-lite-260215', 'doubao-seed-2-0-lite'],
  ['doubao-seed-2-0-mini-260215', 'doubao-seed-2-0-mini'],
  ['doubao-seed-2-0-code-preview-260215', 'doubao-seed-2-0-code']
]);

/**
 * Alibaba cache pricing is a multiplier on the input rate, not a separate rate
 * card, so it can only be derived from help.aliyun.com/zh/model-studio/context-cache
 * (verified 2026-08-19). The doc defines two mutually exclusive modes:
 *
 *   Explicit cache (opt in per request via cache_control, 5-minute TTL)
 *     "用于创建缓存Token计费: 输入 Token 单价的125%"
 *     "命中缓存的输入 Token 计费: 输入 Token 单价的10%"
 *   Implicit cache (always on, cannot be disabled)
 *     "用于创建缓存Token计费: 输入 Token 单价的100%"   -> cacheWritePolicy 'input'
 *     "命中缓存的输入 Token 计费: 输入 Token 单价的20%"
 *
 * WHY SUPPORT IS READ FROM THE DOC AND NOT INFERRED FROM THE PRICE PAGE
 * --------------------------------------------------------------------
 * The previous version treated "the pricing table has no cache column" as "cache
 * writes are free" and stamped cacheWritePolicy:'free' with
 * cacheWritePolicySource:'official' on 120 alibaba rules. That inference is wrong
 * in both directions: the pricing page simply does not carry a cache column for
 * most models, and Alibaba does charge for caching. Billing a cache creation at
 * zero silently under-reports every request that writes one.
 *
 * The cache doc publishes an explicit per-region "支持的模型" list for each mode,
 * so support is now read from there. A model in neither list gets NO cache columns
 * and NO cacheWritePolicy, which leaves pricing.ts's own alibaba fallback to
 * resolve 'unknown' and show "—" instead of a fabricated $0.
 *
 * Deliberately NOT emitting cacheWritePolicy:'unknown' explicitly: pricing.ts only
 * lets COMPATIBLE_SERVICE_PRICE_OVERRIDES supply a policy when the rule leaves the field
 * undefined, so writing 'unknown' would freeze the gap shut against a hand fix
 * while displaying exactly the same "—".
 *
 * Scope: the price card we read is the Singapore/international one, so the
 * Singapore support lists are the primary authority. A model listed only under
 * another region is still treated as cache-capable — the multiplier is a
 * percentage of whatever the local input price is, so it is scope-independent, and
 * the asymmetry favours it: an unused cache rate on a model that turns out not to
 * cache in Singapore costs nothing, whereas omitting one on a model that does
 * cache shows "—" for a real charge. Every such case is labelled
 * `other-region-scope` in audit.alibabaCache.
 */
const ALIBABA_CACHE = {
  /** Fallbacks if the doc's own wording ever stops parsing; parseAlibabaCacheDoc
   *  throws rather than silently using these, they exist to document the shape. */
  explicitCreate: 1.25,
  explicitHit: 0.1,
  implicitCreate: 1,
  implicitHit: 0.2,
  /**
   * Models whose cache-hit multiplier the doc explicitly withholds:
   *   "deepseek-v4-pro：cached_token 单价不是 input_token 单价的 20%，具体价格请参见百炼控制台"
   *   "qwen3.8-max：cached_token 单价不是 input_token 单价的 20%，具体价格请参见百炼控制台"
   *   "例外：qwen3.8-max 的显式缓存命中价格不是标准输入单价的 10%，具体价格请参见百炼控制台
   *    （缓存创建价格仍为标准单价的 125%）"
   * The creation multiplier still applies; only the hit price is unknown, so these
   * go into ModelRecord.unpublished where an anchored first-party endpoint may
   * supply the real figure (that is how qwen3.8-max gets its $0.25).
   */
  unknownHit: new Set(['deepseek-v4-pro', 'qwen3.8-max'].map(matchKey)),
  /**
   * The doc's implicit-hit exception list, copied verbatim (lines "阿里云百炼部署的
   * 模型（deepseek-v4-pro、qwen3.8-max 除外）：cached_token 单价为 input_token 单价的
   * 20%" onwards). Ids are written exactly as the doc spells them and folded through
   * matchKey() here, so a key can be grepped against the doc without the reader
   * having to know that matchKey turns `qwen3.8-max` into `qwen3-8-max`. Getting
   * that wrong is not a lookup miss you notice: it silently falls through to the
   * 20% default, which is how qwen3.8-max briefly acquired a $0.40 cacheRead.
   */
  implicitHitOverrides: new Map(([
    // "DeepSeek（快手万擎部署）：vanchin/deepseek-v4-pro 为 8.33%；
    //  vanchin/deepseek-v3.2-think 为 10%；vanchin/deepseek-v3.1-terminus、
    //  vanchin/deepseek-r1、vanchin/deepseek-v3 为 40%"
    ['vanchin/deepseek-v4-pro', 0.0833],
    ['vanchin/deepseek-v3.2-think', 0.1],
    ['vanchin/deepseek-v3.1-terminus', 0.4],
    ['vanchin/deepseek-r1', 0.4],
    ['vanchin/deepseek-v3', 0.4],
    // "Kimi（月之暗面部署）：kimi/kimi-k3 为 10%；kimi/kimi-k2.6 为 16.9%；
    //  kimi/kimi-k2.5 为 17.5%"
    ['kimi/kimi-k3', 0.1],
    ['kimi/kimi-k2.6', 0.169],
    ['kimi/kimi-k2.5', 0.175],
    // "GLM（阿里云百炼部署）：glm-5.2、glm-5.2-fast-preview 为 25%，其余 glm 系列模型均为 20%"
    ['glm-5.2', 0.25],
    ['glm-5.2-fast-preview', 0.25],
    // "GLM（智谱部署）：ZHIPU/GLM-5.2、ZHIPU/GLM-5.1、ZHIPU/GLM-5 均为 25%"
    ['ZHIPU/GLM-5.2', 0.25],
    ['ZHIPU/GLM-5.1', 0.25],
    ['ZHIPU/GLM-5', 0.25],
    // "MiniMax（稀宇科技部署）：MiniMax/MiniMax-M3、MiniMax/MiniMax-M2.7 为 20%，
    //  MiniMax/MiniMax-M2.5、MiniMax/MiniMax-M2.1 为 10%"
    ['MiniMax/MiniMax-M3', 0.2],
    ['MiniMax/MiniMax-M2.7', 0.2],
    ['MiniMax/MiniMax-M2.5', 0.1],
    ['MiniMax/MiniMax-M2.1', 0.1]
  ]).map(([id, multiplier]) => [matchKey(id), multiplier])),
  /**
   * The bare kimi ids Alibaba hosts get the same multiplier as their
   * vendor-prefixed twins above. Kept separate from the verbatim block so it is
   * obvious which lines came from the doc and which are the doc's figure applied to
   * an Alibaba-deployed alias of the same model.
   */
  aliasedHitOverrides: new Map(([
    ['kimi-k3', 0.1],
    ['kimi-k2.6', 0.169],
    ['kimi-k2.5', 0.175]
  ]).map(([id, multiplier]) => [matchKey(id), multiplier]))
};

/** cacheRead / input ratios published by first-party vendors, for validation A. */
const CACHE_READ_RATIO_FLOOR = 0.05;
const CACHE_READ_RATIO_CEILING = 0.6;
/** Two list prices are "the same price" below this relative gap. */
const AGREEMENT_TOLERANCE = 0.02;

/**
 * Sanity ceiling for a band's lower bound. Nothing published sits near it; it
 * only rejects a garbage ladder from a malformed source.
 *
 * Every band a vendor publishes is kept. estimateCostUsd() charges each band at
 * its own rate using the per-band token split that traceStore records at capture
 * time (`usage.bands`, keyed by resolved tier and peak period), so keeping a band
 * no longer costs the model its cost display. Dropping the >200K/272K
 * long-context premiums that OpenAI, Anthropic and Gemini charge would instead
 * under-report exactly the requests that trip them — and Gemini's own rate card
 * is explicit that crossing the threshold reprices the whole request, output
 * included.
 */
const TIER_THRESHOLD_LIMIT = 4_000_000;

const warnings = [];
const rejections = [];
const staleAlerts = [];
const aliasDrift = [];
const notes = [];
/** Azure/AWS rows that contradict the vendor's own page. Never silently averaged;
 *  the vendor wins and the disagreement ships in the asset. */
const cloudConflicts = [];
/**
 * Cases where a cloud rate won because the catalogues had no consensus to defend —
 * i.e. exactly the situation PRICE_PRIORITY puts Azure/AWS above the catalogues
 * for. Usually the cloud is right (Azure has grok-code-fast-1 at the published
 * $0.20/$1.50 where LiteLLM alone says $1/$2), but sometimes the cloud is simply
 * dearer on its own platform (Azure's grok-3-mini output is $1.27 against xAI's
 * $0.50). Every one of them is listed so a maintainer can pin the vendor's figure
 * in COMPATIBLE_SERVICE_PRICE_OVERRIDES if the cloud's is the wrong one.
 */
const cloudOverrides = [];
/** OpenRouter endpoints thrown away by the anchor, with the measured gap. */
const openRouterRejections = [];
/** Bookkeeping for the report and the audit block. */
const cloudStats = { azureRows: 0, azureMapped: 0, azureModels: new Set(), azureUnmapped: new Map(), azureLongContext: 0, longContextAgree: 0, longContextDisagree: 0, awsRows: 0, awsModels: new Set(), awsUnmapped: new Set() };
const openRouterStats = { slugs: 0, fetched: 0, failed: 0, endpoints: 0, firstParty: 0, anchored: 0, filled: { cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, corroborated: 0, dateAliasResolved: [], ratioFilled: [], ratioCorroborated: [], ratioDisagreement: [], ratioBlockedByDoc: [] };
/**
 * What the Alibaba cache doc resolved each model to. `noSupport` is the group that
 * used to be stamped cacheWritePolicy:'free'; it now carries no policy at all.
 */
const alibabaCacheStats = {
  explicitOnly: 0,
  implicitOnly: 0,
  both: 0,
  unpublishedHit: 0,
  noSupport: 0,
  otherRegionScope: [],
  pageHintWithoutDocSupport: [],
  implicitFlagAgreements: 0,
  implicitFlagDisagreement: []
};

function warn(kind, message) {
  warnings.push({ kind, message });
}

// ───────────────────────────────── fetch ──────────────────────────────────

async function fetchText(url, accept) {
  const response = await fetch(url, {
    headers: { accept, 'user-agent': 'XwX Deck-pricing-sync/3' },
    redirect: 'follow',
    signal: AbortSignal.timeout(180_000)
  });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return { text: await response.text(), etag: response.headers.get('etag') || undefined };
}

async function fetchJson(url) {
  const { text, etag } = await fetchText(url, 'application/json');
  return { data: JSON.parse(text), etag };
}

/** OpenRouter is polled a few hundred times, so a single 429/503 must not abort
 *  the run. Two retries with a widening delay, then the slug is skipped. */
async function fetchJsonRetry(url, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError;
}

/** Bounded-concurrency map. Keeps the OpenRouter fan-out polite. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Azure returns 1000 meters per page and follows NextPageLink. The Foundry Models
 * card is ~30 pages; the cap is a guard against a server-side paging loop, not a
 * budget, and a truncated read is reported rather than silently accepted.
 */
async function fetchAzureRetail() {
  const items = [];
  let url = SOURCE_URLS.azureRetail;
  let pages = 0;
  while (url && pages < 60) {
    const { data } = await fetchJsonRetry(url);
    if (Array.isArray(data?.Items)) items.push(...data.Items);
    pages += 1;
    url = data?.NextPageLink;
  }
  if (url) warn('azure-truncated', `Azure Retail Prices paging stopped at ${pages} pages with NextPageLink still set; coverage is incomplete`);
  if (!items.length) {
    throw new Error("Azure Retail Prices returned no items — check the serviceName filter ('Foundry Models', not 'Cognitive Services')");
  }
  return { items, pages };
}

/**
 * Three hops: the offer index names the Bedrock offer, the region index names the
 * versioned file for a region, and that file holds the meters. us-east-1 is read
 * because it is the region where every Anthropic model ships first and where the
 * `_Global` meters (the base rate) are published.
 */
async function fetchAwsBedrock() {
  const index = await fetchJsonRetry(SOURCE_URLS.awsIndex);
  const offer = index.data?.offers?.[AWS_BEDROCK_OFFER];
  if (!offer?.currentRegionIndexUrl) throw new Error(`AWS offer index has no ${AWS_BEDROCK_OFFER} region index`);
  const regionIndex = await fetchJsonRetry(`${SOURCE_URLS.awsHost}${offer.currentRegionIndexUrl}`);
  const region = regionIndex.data?.regions?.[AWS_BEDROCK_REGION];
  if (!region?.currentVersionUrl) throw new Error(`AWS Bedrock region index has no ${AWS_BEDROCK_REGION} entry`);
  const file = await fetchJsonRetry(`${SOURCE_URLS.awsHost}${region.currentVersionUrl}`);
  return { payload: file.data, url: `${SOURCE_URLS.awsHost}${region.currentVersionUrl}`, publicationDate: file.data?.publicationDate };
}

// ───────────────────────── helpers: numbers and ids ───────────────────────

function validPrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Per-token -> per-1M-token, keeping only sane values. */
function perMillion(value) {
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return round(numeric * 1_000_000);
}

/**
 * Round to 10 significant digits. Per-token source values are floats such as
 * 4.6e-7, and multiplying by 1e6 leaves artefacts like 0.45999999999999996 that
 * would otherwise be shown to the user as a price.
 */
function round(value) {
  if (!Number.isFinite(value)) return undefined;
  return Number(value.toPrecision(10));
}

/** Round FX-converted rates to 4 significant digits: the conversion itself is
 *  only good to ~0.2%, so ten digits of precision would be fake. */
function roundFx(value) {
  if (!Number.isFinite(value)) return undefined;
  return Number(value.toPrecision(4));
}

function relativeGap(a, b) {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return 0;
  return Math.abs(a - b) / scale;
}

/**
 * Cross-source matching key. Dots and dashes are used interchangeably by the
 * catalogues (doubao-seed-2.0-pro vs doubao-seed-2-0-pro), so they are folded
 * together; nothing else is stripped.
 */
function matchKey(id) {
  const lower = String(id || '').trim().toLowerCase().replace(/\./g, '-');
  return ID_ALIASES.get(lower) || lower;
}

function nativeProviderFor(id) {
  for (const [pattern, provider] of NATIVE_PROVIDER_BY_PREFIX) {
    if (pattern.test(id)) return provider;
  }
  return undefined;
}

// ────────────────────────── candidate bookkeeping ─────────────────────────

/**
 * One model, as seen by every source. `byField` holds one array of
 * {source, value} per numeric field; `tiers` and the scalar-only extras are
 * kept separately because they arbitrate differently.
 */
class ModelRecord {
  constructor(providerId, key) {
    this.providerId = providerId;
    this.key = key;
    this.surfaceIds = new Set();
    this.byField = new Map();
    this.tierSets = [];
    this.peak = undefined;
    this.cacheStorage = [];
    this.lastUpdated = new Map();
    this.deprecationDate = undefined;
    this.officialSeen = false;
    this.fx = undefined;
    this.listPriceCny = undefined;
    this.cacheWritePolicy = undefined;
    this.cacheWritePolicySource = undefined;
    /**
     * Per-field provenance for values that were DERIVED rather than published,
     * e.g. 'alibaba-multiplier:explicit-10pct'. Surfaces in priceSourceDetail so a
     * derived rate is never mistaken for one a vendor printed.
     */
    this.cacheDerivation = {};
    /** Cache modes the vendor's cache doc lists for this model, if any. */
    this.cacheModes = undefined;
    /** Fields the vendor's own page says are not publicly priced. */
    this.suppressed = new Set();
    /**
     * Subset of `suppressed`: the vendor charges the fee but does not print the
     * rate ("具体价格请参见百炼控制台"). No catalogue value may be used, but an
     * anchored first-party endpoint is the vendor's own number and may fill it.
     */
    this.unpublished = new Set();
    /** What Azure/AWS say, whether or not they are allowed to set the price. */
    this.cloudObserved = new Map();
  }

  offer(source, field, value) {
    if (!validPrice(value)) return;
    // A zero in a cache column of an aggregator is a placeholder, not a price:
    // LiteLLM writes cache_creation_input_token_cost: 0 for every DeepSeek row
    // even though DeepSeek bills those tokens at the ordinary cache-miss rate.
    // Taking it literally would silently make cache creation free. input/output
    // zeros are kept because embedding models legitimately have output 0.
    if (value === 0 && source !== 'official' && field !== 'input' && field !== 'output') return;
    if (!this.byField.has(field)) this.byField.set(field, []);
    this.byField.get(field).push({ source, value: round(value) });
  }

  candidates(field) {
    return this.byField.get(field) || [];
  }

  dropField(field, predicate) {
    const list = this.byField.get(field);
    if (!list) return [];
    const dropped = list.filter(predicate);
    this.byField.set(field, list.filter(entry => !predicate(entry)));
    return dropped;
  }
}

const records = new Map();

function recordFor(providerId, id) {
  const key = `${providerId}::${matchKey(id)}`;
  if (!records.has(key)) records.set(key, new ModelRecord(providerId, matchKey(id)));
  const record = records.get(key);
  record.surfaceIds.add(String(id).toLowerCase());
  return record;
}

/**
 * Look up an existing record by any of several candidate ids, most specific first.
 * Used by the cloud and OpenRouter readers, which must attach to a model some
 * other source already priced and must never create one.
 */
function findRecord(providerId, candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const record = records.get(`${providerId}::${matchKey(candidate)}`);
    if (record) return record;
  }
  return undefined;
}

// ───────────────────────────── source: models.dev ─────────────────────────

/**
 * models.dev supplies breadth. Its `cost` block is flat (input/output/
 * cache_read/cache_write) plus an optional `tiers` array that describes a
 * *context-window* step, not an input-length band, so it is read for the four
 * flat numbers only.
 */
function collectModelsDev(catalog) {
  let seen = 0;
  for (const provider of PROVIDERS) {
    if (!provider.modelsDev) continue;
    const models = catalog?.[provider.modelsDev]?.models;
    if (!models || typeof models !== 'object') continue;
    for (const modelId of Object.keys(models).sort((a, b) => a.localeCompare(b))) {
      const model = models[modelId];
      const cost = model?.cost;
      if (!cost || !validPrice(cost.input) || !validPrice(cost.output)) continue;
      const record = recordFor(provider.id, modelId);
      record.offer('models.dev', 'input', cost.input);
      record.offer('models.dev', 'output', cost.output);
      record.offer('models.dev', 'cacheRead', cost.cache_read);
      record.offer('models.dev', 'cacheWrite', cost.cache_write);
      const tiers = normaliseModelsDevTiers(cost);
      if (tiers) record.tierSets.push({ source: 'models.dev', tiers });
      if (typeof model.last_updated === 'string') record.lastUpdated.set('models.dev', model.last_updated);
      seen += 1;
    }
  }
  return seen;
}

/**
 * models.dev length bands: `cost.tiers` holds only the bands *above* the base
 * rate, each carrying its own threshold in `tier.size`, while band 0 is the
 * top-level `cost`. This is where OpenAI's >272K premium lives, and reading it
 * is what keeps a long-context request from being billed at the standard rate.
 *
 * The threshold is taken from `tier.size` and never from the sibling
 * `cost.context_over_200k` field, whose name lies: for OpenAI models it holds
 * the 272K band. Only `type: 'context'` bands are accepted — anything else is a
 * different pricing axis this ladder cannot express.
 */
function normaliseModelsDevTiers(cost) {
  if (!Array.isArray(cost?.tiers) || !cost.tiers.length) return undefined;
  const band = (from, source) => {
    if (!validPrice(source?.input) || !validPrice(source?.output)) return undefined;
    return {
      fromInputTokens: from,
      input: source.input,
      output: source.output,
      ...(validPrice(source.cache_read) ? { cacheRead: source.cache_read } : {}),
      ...(validPrice(source.cache_write) ? { cacheWrite: source.cache_write } : {})
    };
  };
  const base = band(0, cost);
  if (!base) return undefined;
  const bands = [base];
  for (const tier of cost.tiers) {
    if (tier?.tier?.type !== 'context') return undefined;
    const size = Number(tier.tier.size);
    if (!Number.isFinite(size) || size <= 0) return undefined;
    const next = band(size + 1, tier);
    if (!next) return undefined;
    bands.push(next);
  }
  return sealTiers(bands);
}

/**
 * Validation B input: every provider on models.dev that mirrors a model id,
 * resellers included. Resellers scale input and cache_read together, so the
 * *ratio* survives their markup while a mistyped decimal point does not —
 * which is exactly what makes the ratio mode a usable outlier detector.
 */
function buildRatioModes(catalog) {
  const perModel = new Map();
  for (const providerBlock of Object.values(catalog || {})) {
    const models = providerBlock?.models;
    if (!models || typeof models !== 'object') continue;
    for (const [id, model] of Object.entries(models)) {
      const cost = model?.cost;
      if (!cost || !validPrice(cost.input) || cost.input === 0 || !validPrice(cost.cache_read)) continue;
      const short = matchKey(String(id).split('/').pop());
      const ratio = Number((cost.cache_read / cost.input).toFixed(2));
      if (!perModel.has(short)) perModel.set(short, new Map());
      const histogram = perModel.get(short);
      histogram.set(ratio, (histogram.get(ratio) || 0) + 1);
    }
  }
  const modes = new Map();
  for (const [short, histogram] of perModel) {
    const sorted = [...histogram].sort((a, b) => b[1] - a[1]);
    // A tie carries no information about which entry is the typo.
    if (sorted.length && (sorted.length === 1 || sorted[0][1] > sorted[1][1])) {
      modes.set(short, { ratio: sorted[0][0], support: sorted[0][1], total: [...histogram.values()].reduce((a, b) => a + b, 0) });
    }
  }
  return modes;
}

// ───────────────────────────── source: LiteLLM ────────────────────────────

/**
 * LiteLLM is the only catalogue with the 1h Anthropic cache tier, per-model
 * deprecation dates, and a volcengine block. Its keys are `provider/model` or a
 * bare model name; entries are selected by `litellm_provider` so that Bedrock /
 * Azure / Vertex re-hosts (which carry regional markups) are never read.
 */
function collectLiteLlm(catalog) {
  const byLiteLlmProvider = new Map(PROVIDERS.filter(p => p.liteLlm).map(p => [p.liteLlm, p]));
  let seen = 0;
  for (const [key, entry] of Object.entries(catalog || {})) {
    const provider = byLiteLlmProvider.get(entry?.litellm_provider);
    if (!provider) continue;
    if (entry.mode && entry.mode !== 'chat' && entry.mode !== 'responses' && entry.mode !== 'embedding') continue;
    const id = key.split('/').pop();
    if (!id) continue;
    const tiers = normaliseLiteLlmTiers(entry.tiered_pricing);
    const input = perMillion(entry.input_cost_per_token);
    const output = perMillion(entry.output_cost_per_token);
    if (input === undefined && !tiers) continue;
    const record = recordFor(provider.id, id);
    record.offer('litellm', 'input', tiers ? tiers[0].input : input);
    record.offer('litellm', 'output', tiers ? tiers[0].output : output);
    record.offer('litellm', 'cacheRead', perMillion(entry.cache_read_input_token_cost));
    record.offer('litellm', 'cacheWrite', perMillion(entry.cache_creation_input_token_cost));
    record.offer('litellm', 'cacheWrite1h', perMillion(entry.cache_creation_input_token_cost_above_1hr));
    if (tiers) record.tierSets.push({ source: 'litellm', tiers });
    if (typeof entry.deprecation_date === 'string') record.deprecationDate = entry.deprecation_date;
    seen += 1;
  }
  return seen;
}

/** LiteLLM tiered_pricing: [{range:[from,to], input_cost_per_token, output_cost_per_token}]. */
function normaliseLiteLlmTiers(value) {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const bands = [];
  for (const band of value) {
    const from = Array.isArray(band?.range) ? Number(band.range[0]) : NaN;
    const input = perMillion(band?.input_cost_per_token);
    const output = perMillion(band?.output_cost_per_token);
    if (!Number.isFinite(from) || input === undefined || output === undefined) return undefined;
    bands.push({
      fromInputTokens: from <= 0 ? 0 : from + 1,
      input,
      output,
      ...(perMillion(band?.cache_read_input_token_cost) === undefined
        ? {}
        : { cacheRead: perMillion(band.cache_read_input_token_cost) })
    });
  }
  return sealTiers(bands);
}

// ─────────────────────── source: Vercel AI Gateway ────────────────────────

/**
 * Vercel models Chinese vendors' length bands natively. Only the base `pricing`
 * block is read: `fast`, `service_tiers`, and `regional` are separate SKUs, and
 * a batch/flex rate silently substituted for the standard rate is the exact
 * failure mode that makes Vercel unusable on its own for OpenAI (it lists
 * gpt-5.6-sol at half price because it reports the Batch tier).
 */
function collectVercel(payload) {
  const byOwner = new Map(PROVIDERS.filter(p => p.vercel).map(p => [p.vercel, p]));
  let seen = 0;
  for (const model of payload?.data || []) {
    const provider = byOwner.get(model?.owned_by);
    if (!provider || model?.type !== 'language') continue;
    const pricing = model.pricing;
    if (!pricing) continue;
    const id = String(model.id || '').split('/').pop();
    if (!id) continue;
    const record = recordFor(provider.id, id);
    record.offer('vercel', 'input', perMillion(pricing.input));
    record.offer('vercel', 'output', perMillion(pricing.output));
    record.offer('vercel', 'cacheRead', perMillion(pricing.input_cache_read));
    record.offer('vercel', 'cacheWrite', perMillion(pricing.input_cache_write));
    const tiers = normaliseVercelTiers(pricing);
    if (tiers) record.tierSets.push({ source: 'vercel', tiers });
    seen += 1;
  }
  return seen;
}

function normaliseVercelTiers(pricing) {
  const inputTiers = Array.isArray(pricing?.input_tiers) ? pricing.input_tiers : undefined;
  if (!inputTiers || inputTiers.length < 2) return undefined;
  const outputTiers = Array.isArray(pricing.output_tiers) ? pricing.output_tiers : [];
  const readTiers = Array.isArray(pricing.input_cache_read_tiers) ? pricing.input_cache_read_tiers : [];
  const writeTiers = Array.isArray(pricing.input_cache_write_tiers) ? pricing.input_cache_write_tiers : [];
  const bands = [];
  for (let index = 0; index < inputTiers.length; index += 1) {
    const from = Number(inputTiers[index]?.min ?? 0);
    const input = perMillion(inputTiers[index]?.cost);
    const output = perMillion(outputTiers[index]?.cost);
    if (!Number.isFinite(from) || input === undefined || output === undefined) return undefined;
    const cacheRead = perMillion(readTiers[index]?.cost);
    const cacheWrite = perMillion(writeTiers[index]?.cost);
    bands.push({
      fromInputTokens: from <= 0 ? 0 : from,
      input,
      output,
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWrite })
    });
  }
  return sealTiers(bands);
}

/** Sort ascending, force the first band to start at 0, drop degenerate sets. */
function sealTiers(bands) {
  const sorted = [...bands].sort((a, b) => a.fromInputTokens - b.fromInputTokens);
  if (sorted.length < 2) return undefined;
  sorted[0] = { ...sorted[0], fromInputTokens: 0 };
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].fromInputTokens <= sorted[index - 1].fromInputTokens) return undefined;
  }
  return sorted;
}

// ────────────────────── source: Helicone (storage only) ───────────────────

/**
 * Helicone is read for one field: cacheStoragePerHour. It is the only public
 * registry that has it, and only for Gemini — its Volcengine coverage is empty,
 * so doubao's storage fee stays single-source official.
 */
function collectHeliconeStorage(payload) {
  const found = new Map();
  // The registry nests the same pricing array at endpoints[].pricing and
  // endpoints[].endpoint.modelConfig.pricing, and occasionally ships an object
  // where an array is expected, so read both shapes defensively.
  const bandsOf = value => (Array.isArray(value) ? value : []);
  for (const model of payload?.data?.models || []) {
    for (const endpoint of Array.isArray(model?.endpoints) ? model.endpoints : []) {
      const bands = [
        ...bandsOf(endpoint?.pricing),
        ...bandsOf(endpoint?.endpoint?.pricing),
        ...bandsOf(endpoint?.endpoint?.modelConfig?.pricing)
      ];
      for (const band of bands) {
        const perHour = perMillion(band?.cacheStoragePerHour);
        if (perHour === undefined || perHour === 0) continue;
        found.set(matchKey(model.id), perHour);
      }
    }
  }
  return found;
}

// ───────────────────────── official: DeepSeek scrape ──────────────────────

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function tableRows(html) {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match =>
    [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => stripTags(cell[1]))
  );
}

/**
 * DeepSeek's rate card is a transposed table: models are columns. The PEAK row
 * of each of the three price groups holds the list price; OFF-PEAK is exactly
 * half of it, which is why the schedule is stored as a multiplier instead of a
 * second set of numbers.
 */
function parseDeepSeek(html) {
  const rows = tableRows(html);
  const modelRow = rows.find(cells => cells[0] === 'MODEL');
  if (!modelRow) throw new Error('DeepSeek pricing page: MODEL header row not found');
  const ids = modelRow.slice(1).filter(cell => /^[a-z0-9][a-z0-9.\-]*$/i.test(cell));
  if (!ids.length) throw new Error('DeepSeek pricing page: no billable model ids in the MODEL row');

  // Groups appear in fixed order; each is followed by an OFF-PEAK row then a
  // PEAK row. Track the current group label as we walk the rows.
  const fields = { 'CACHE HIT': 'cacheRead', 'CACHE MISS': 'input', 'OUTPUT': 'output' };
  const values = {};
  let current;
  for (const cells of rows) {
    const label = cells.find(cell => /1M (INPUT|OUTPUT) TOKENS/.test(cell));
    if (label) {
      current = label.includes('CACHE HIT') ? 'cacheRead' : label.includes('CACHE MISS') ? 'input' : 'output';
    }
    if (!current) continue;
    const isPeak = cells.some(cell => cell === 'PEAK');
    if (!isPeak) continue;
    const prices = cells.map(parseDollar).filter(value => value !== undefined);
    if (prices.length !== ids.length) continue;
    values[current] = prices;
  }
  for (const field of Object.values(fields)) {
    if (!values[field]) throw new Error(`DeepSeek pricing page: no PEAK row for ${field}`);
  }

  const footnote = stripTags(html);
  const multiplierText = /Off-peak rates are (half|[\d.]+%?) of the peak rates/i.exec(footnote);
  if (!multiplierText) throw new Error('DeepSeek pricing page: off-peak multiplier sentence missing');
  const offPeakMultiplier = /half/i.test(multiplierText[1]) ? 0.5 : Number(multiplierText[1].replace('%', '')) / 100;
  const hoursText = /Peak hours are ([^.]+?) UTC/i.exec(footnote);
  if (!hoursText) throw new Error('DeepSeek pricing page: peak hours sentence missing');
  const peakWindowsUtc = [...hoursText[1].matchAll(/(\d{1,2}):\d{2}\s*-\s*(\d{1,2}):\d{2}/g)]
    .map(match => [Number(match[1]), Number(match[2])]);
  if (!peakWindowsUtc.length) throw new Error('DeepSeek pricing page: no peak windows parsed');

  return {
    ids,
    // The MODEL VERSION row names the build behind each billable id
    // (DeepSeek-V4-Flash-0731). It is not a separate SKU and must not get its own
    // price rule, so it is registered as an alias of the id in its column.
    versionAliases: (() => {
      const versionRow = rows.find(cells => cells.some(cell => cell === 'MODEL VERSION'));
      if (!versionRow) return [];
      const versions = versionRow.filter(cell => /^deepseek-v\d/i.test(cell));
      return versions.length === ids.length ? versions.map((version, index) => [version, ids[index]]) : [];
    })(),
    offPeakMultiplier,
    peakWindowsUtc,
    rates: ids.map((id, index) => ({
      id,
      input: values.input[index],
      output: values.output[index],
      cacheRead: values.cacheRead[index]
    }))
  };
}

function parseDollar(text) {
  const match = /\$\s*([\d.]+)/.exec(String(text || ''));
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

// ───────────────────────── official: Alibaba scrape ───────────────────────

/**
 * Bands are written as `0<Token≤32K` / `32K<Token≤128K`. The page states
 * "K represents 1,000, M represents 1,000,000", and that a request's *whole*
 * token count is billed at the band its input total lands in — so the next band
 * starts one token above the previous ceiling.
 */
function parseTokenBand(text) {
  const cleaned = String(text || '').replace(/\\/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, '');
  if (/^(no|无)/i.test(cleaned) || /notiered/i.test(cleaned)) return { from: 0 };
  const match = /^(\d+(?:\.\d+)?)([KM]?)<Token(?:≤|<=)(\d+(?:\.\d+)?)([KM]?)$/i.exec(cleaned);
  if (!match) return undefined;
  const scale = unit => (unit.toUpperCase() === 'M' ? 1_000_000 : unit.toUpperCase() === 'K' ? 1_000 : 1);
  const lower = Number(match[1]) * scale(match[2]);
  return { from: lower <= 0 ? 0 : lower + 1 };
}

/**
 * Region sub-headings. The page mis-levels several of them as `##`
 * ("## China(Hong Kong)" between the Kimi and MiniMax families), so a level-2
 * heading that names a region must not be mistaken for a new category — doing so
 * silently truncated every third-party family after DeepSeek.
 */
const ALIBABA_REGION_HEADING = /^(singapore|china\s*[（(]|hong\s*kong|germany|us\s*[（(]|united states|japan|korea|indonesia|malaysia|philippines|thailand|uk|india)/i;

/**
 * The Alibaba page is markdown with raw HTML tables, sectioned
 * `## category` / `### family` / `#### region`. Only the Singapore region is
 * read: it is the international deployment (`Deployment scope: International`)
 * and — unlike the Chinese page, which quotes the same models in 元 at an
 * internal conversion rate that varies per model (7.339 for qwen3-max, 7.494 for
 * qwen3.8-max) — it is denominated in USD, so no FX error enters the qwen rates.
 */
function parseAlibaba(markdown) {
  const lines = markdown.split(/\r?\n/);
  const models = new Map();
  let category = '';
  let region = '';
  let buffer = null;
  const includeCategory = () => /^text generation|^text embedding|^industry models/i.test(category);

  const flush = () => {
    if (!buffer) return;
    const parsed = parseAlibabaTable(buffer);
    for (const [id, entry] of parsed) {
      if (!models.has(id)) models.set(id, entry);
    }
    buffer = null;
  };

  for (const line of lines) {
    const heading = /^(#{2,5})\s*(.*)$/.exec(line);
    if (heading) {
      flush();
      const text = heading[2].replace(/[*_`]/g, '').trim();
      const level = heading[1].length;
      if (ALIBABA_REGION_HEADING.test(text)) region = text;
      else if (level === 2) { category = text; region = ''; }
      else if (level === 3) region = '';
      else if (level === 4) region = text;
      // Level 5 ("More models") stays inside the current region.
      continue;
    }
    if (!/^singapore$/i.test(region) || !includeCategory()) continue;
    if (line.includes('<table')) buffer = line;
    else if (buffer !== null) buffer += `\n${line}`;
    if (buffer !== null && line.includes('</table>')) flush();
  }
  flush();
  return models;
}

function parseAlibabaTable(html) {
  const out = new Map();
  let currentId;
  for (const cells of tableRows(html)) {
    if (!cells.length) continue;
    if (/^model id$/i.test(cells[0])) continue;
    const band = parseTokenBand(cells[0]);
    const dollars = cells.map(parseDollar);
    const prices = dollars.filter(value => value !== undefined);

    if (band && currentId && out.has(currentId)) {
      // Continuation row: another length band for the model above.
      if (prices.length < 2) continue;
      out.get(currentId).bands.push({ fromInputTokens: band.from, input: prices[0], output: prices[1] });
      continue;
    }

    const idMatch = /^([A-Za-z][\w.\-\/]*)/.exec(cells[0]);
    if (!idMatch) continue;
    const id = idMatch[1].toLowerCase();
    const alias = /(?:Currently equivalent to|当前能力等同于)\s*([\w.\-\/]+)/i.exec(cells[0]);
    // A link to the context-cache guide (document_detail/2862577) is the pricing
    // page's own hint that the model caches. It is read as CORROBORATION only:
    // most rows omit it whether or not the model caches, so its absence proves
    // nothing (that inference is what produced 120 bogus 'free' policies). The
    // authority is the cache doc's per-mode 支持的模型 list — see ALIBABA_CACHE.
    const pageHintsCache = /2862577/.test(cells[0]) || /context caching/i.test(cells[0]);
    // The source table occasionally ships a row with the price cells missing
    // (qwen-vl-ocr-2025-11-20 in the Singapore OCR table). No price, no rule.
    if (prices.length < 2) {
      if (alias) aliasDrift.push({ providerId: 'alibaba', modelId: id, equivalentTo: alias[1].toLowerCase(), note: 'row published without price cells' });
      continue;
    }
    currentId = id;
    const firstBand = cells.map(parseTokenBand).find(value => value !== undefined) || { from: 0 };
    out.set(id, {
      id,
      pageHintsCache,
      equivalentTo: alias ? alias[1].toLowerCase() : undefined,
      bands: [{ fromInputTokens: firstBand.from <= 0 ? 0 : firstBand.from, input: prices[0], output: prices[1] }]
    });
    if (alias) aliasDrift.push({ providerId: 'alibaba', modelId: id, equivalentTo: alias[1].toLowerCase() });
  }
  return out;
}

// ───────────── official: Alibaba context-cache doc (support + rates) ────────

/**
 * The cache doc carries two `### 支持的模型` sections — explicit first, implicit
 * second — each split into `## <region>` blocks that list ids after a `：`. Both
 * the multipliers and the support lists are parsed, and a failure to find the
 * multipliers throws: silently falling back to the hard-coded constants would let
 * a rate change go unnoticed, which is the whole failure mode this file exists to
 * avoid.
 */
function parseAlibabaCacheDoc(markdown) {
  const rate = (label, pattern) => {
    const match = pattern.exec(markdown);
    if (!match) throw new Error(`Alibaba context-cache doc: ${label} multiplier sentence not found`);
    const percent = Number(match[1]);
    if (!Number.isFinite(percent) || percent <= 0) throw new Error(`Alibaba context-cache doc: ${label} multiplier "${match[1]}" is not a percentage`);
    return percent / 100;
  };
  // "用于创建缓存Token计费 | 输入 Token 单价的125% | 输入 Token 单价的100%" and
  // "命中缓存的输入 Token 计费 | 输入 Token 单价的10% | 输入 Token 单价的20%" — the
  // comparison table lists explicit then implicit in that column order.
  const createRow = /用于创建缓存Token计费[\s\S]{0,400}?输入 Token 单价的\s*([\d.]+)%[\s\S]{0,400}?输入 Token 单价的\s*([\d.]+)%/.exec(markdown);
  const hitRow = /命中缓存的输入 Token 计费[\s\S]{0,400}?输入 Token 单价的\s*([\d.]+)%[\s\S]{0,400}?输入 Token 单价的\s*([\d.]+)%/.exec(markdown);
  if (!createRow || !hitRow) throw new Error('Alibaba context-cache doc: explicit/implicit comparison table not found');
  const rates = {
    explicitCreate: Number(createRow[1]) / 100,
    implicitCreate: Number(createRow[2]) / 100,
    explicitHit: Number(hitRow[1]) / 100,
    implicitHit: Number(hitRow[2]) / 100
  };
  for (const [key, value] of Object.entries(rates)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Alibaba context-cache doc: ${key} parsed as ${value}`);
  }
  // Cross-check against the prose, which states the same four numbers separately.
  const proseExplicitCreate = rate('explicit create (prose)', /用于创建缓存的 Token 按输入 Token 标准单价的\s*([\d.]+)%\s*计费/);
  const proseExplicitHit = rate('explicit hit (prose)', /后续命中仅需支付\s*([\d.]+)%\s*的费用/);
  const proseImplicitHit = rate('implicit hit (prose)', /对命中缓存的部分，按输入 Token 标准单价的\s*([\d.]+)%\s*计费/);
  for (const [label, table, prose] of [
    ['explicitCreate', rates.explicitCreate, proseExplicitCreate],
    ['explicitHit', rates.explicitHit, proseExplicitHit],
    ['implicitHit', rates.implicitHit, proseImplicitHit]
  ]) {
    if (relativeGap(table, prose) > AGREEMENT_TOLERANCE) {
      throw new Error(`Alibaba context-cache doc: ${label} is ${table} in the comparison table but ${prose} in the prose`);
    }
  }

  const sections = [...markdown.matchAll(/### \*?\*?支持的模型/g)].map(match => match.index);
  if (sections.length < 2) throw new Error('Alibaba context-cache doc: expected two 支持的模型 sections (explicit, implicit)');
  const nextHeading = markdown.indexOf('\n### ', sections[1] + 10);
  const support = {
    explicit: parseAlibabaCacheRegions(markdown.slice(sections[0], sections[1])),
    implicit: parseAlibabaCacheRegions(markdown.slice(sections[1], nextHeading < 0 ? undefined : nextHeading))
  };
  if (!support.explicit.size || !support.implicit.size) {
    throw new Error('Alibaba context-cache doc: 支持的模型 lists parsed empty');
  }
  return { rates, support };
}

/** `## <region>` -> Set of matchKey ids listed after any `：` in that block. */
function parseAlibabaCacheRegions(text) {
  const regions = new Map();
  const headings = [...text.matchAll(/\n## +([^\n]+)/g)];
  for (let index = 0; index < headings.length; index += 1) {
    const name = headings[index][1].replace(/[*`]/g, '').trim();
    const from = headings[index].index + headings[index][0].length;
    const to = index + 1 < headings.length ? headings[index + 1].index : text.length;
    const ids = new Set();
    for (const line of text.slice(from, to).matchAll(/[：:]\s*([^\n]+)/g)) {
      for (const token of line[1].split(/[、,，]/)) {
        const cleaned = token.replace(/\*\*/g, '').replace(/<br\s*\/?>/g, '').trim();
        // Ids only: skip the prose fragments and markdown links that also follow a colon.
        const match = /^([A-Za-z][\w.\-]*(?:\/[\w.\-]+)?)$/.exec(cleaned);
        if (match) ids.add(matchKey(match[1]));
      }
    }
    if (ids.size) regions.set(name, ids);
  }
  return regions;
}

/**
 * Which cache mode a model is documented to support, and in which scope.
 *
 * The Singapore block is checked first because the price card we read is the
 * Singapore/international one. `other-region` means the doc lists the model under
 * a different deployment only — the multiplier still applies (it is a percentage
 * of the local input price) but the availability is extrapolated, so it is flagged.
 */
function alibabaCacheModes(support, id) {
  const scopeOf = regions => {
    const singapore = [...regions].find(([name]) => /新加坡|singapore/i.test(name));
    if (singapore && singapore[1].has(id)) return 'singapore';
    for (const [, ids] of regions) if (ids.has(id)) return 'other-region';
    return undefined;
  };
  const explicit = scopeOf(support.explicit);
  const implicit = scopeOf(support.implicit);
  if (!explicit && !implicit) return undefined;
  return {
    explicit: !!explicit,
    implicit: !!implicit,
    scope: explicit === 'singapore' || implicit === 'singapore' ? 'singapore' : 'other-region'
  };
}

/**
 * Turn the doc's mode support plus its multipliers into the record's cache columns.
 *
 * WHICH HIT MULTIPLIER, WHEN A MODEL SUPPORTS BOTH MODES
 * -----------------------------------------------------
 * Implicit caching "无法关闭" (cannot be disabled) and needs no client change, so
 * 20% is what an unmodified client actually pays on a cache hit. Explicit caching
 * needs an opt-in `cache_control` marker to reach its cheaper 10%. Pricing the
 * default is the safe direction: quoting 10% for a client that never sets the
 * marker would under-report every hit by half.
 *
 * WHY THE CREATE MULTIPLIER IS THE EXPLICIT ONE (125%) WHENEVER EXPLICIT IS
 * AVAILABLE
 * ------------------------------------------------------------------------
 * Implicit creation is billed at 100% of input — i.e. as ordinary input — and the
 * client reports those tokens in the plain input bucket, not as a cache write. A
 * usage record that carries a separate cache-creation count can therefore only
 * have come from explicit caching, which bills 125%.
 */
function resolveAlibabaCache(record, entry, doc) {
  const id = record.key;
  const modes = alibabaCacheModes(doc.support, id);
  const rates = doc.rates;

  if (!modes) {
    // Absent from both 支持的模型 lists: no context cache on any documented
    // deployment. No cache columns, and crucially NO cacheWritePolicy — see the
    // ALIBABA_CACHE comment for why 'free' was wrong and why 'unknown' is left to
    // pricing.ts's own fallback rather than written out here.
    record.suppressed.add('cacheRead');
    record.suppressed.add('cacheWrite');
    alibabaCacheStats.noSupport += 1;
    if (entry.pageHintsCache) {
      // The two official sources disagree: worth a look, but the cache doc's
      // explicit list is the one that names a multiplier, so it wins.
      alibabaCacheStats.pageHintWithoutDocSupport.push(id);
      warn('alibaba-cache-source-disagreement', `alibaba/${id}: the pricing page links the context-cache guide but the cache doc lists the model under neither 支持的模型 section; no cache rate derived`);
    }
    return { hitMultiplier: undefined, createMultiplier: undefined };
  }

  record.cacheModes = modes;
  if (modes.scope === 'other-region') alibabaCacheStats.otherRegionScope.push(id);
  const createMultiplier = modes.explicit ? rates.explicitCreate : undefined;
  const hitMultiplier = (() => {
    if (ALIBABA_CACHE.unknownHit.has(id)) return undefined;
    if (modes.implicit) {
      return ALIBABA_CACHE.implicitHitOverrides.get(id)
        ?? ALIBABA_CACHE.aliasedHitOverrides.get(id)
        ?? rates.implicitHit;
    }
    return rates.explicitHit;
  })();

  const first = entry.bands[0];
  // The mode counters partition the rate card; `unpublishedHit` below is a subset
  // overlay on top of it, not a fourth bucket.
  alibabaCacheStats[modes.explicit && modes.implicit ? 'both' : modes.explicit ? 'explicitOnly' : 'implicitOnly'] += 1;
  // Implicit is always on and cannot be disabled, so its 20% is what an unmodified
  // client pays; explicit's cheaper 10% needs an opt-in cache_control marker.
  const label = modes.implicit ? 'implicit' : 'explicit';

  if (hitMultiplier === undefined) {
    // "具体价格请参见百炼控制台" — the fee exists, the multiplier does not. Leave the
    // column to an anchored first-party endpoint (ModelRecord.unpublished).
    record.suppressed.add('cacheRead');
    record.unpublished.add('cacheRead');
    alibabaCacheStats.unpublishedHit += 1;
    notes.push(`alibaba/${id}: the cache doc withholds the cache-hit multiplier ("具体价格请参见百炼控制台"), so cacheRead is left for an anchored first-party endpoint to supply`);
  } else {
    record.offer('official', 'cacheRead', round(first.input * hitMultiplier));
    record.cacheDerivation.cacheRead = `alibaba-multiplier:${label}-${formatPercent(hitMultiplier)}`;
  }

  if (createMultiplier !== undefined) {
    record.offer('official', 'cacheWrite', round(first.input * createMultiplier));
    record.cacheDerivation.cacheWrite = `alibaba-multiplier:explicit-create-${formatPercent(createMultiplier)}`;
  } else {
    // Implicit-only: creation is billed at 100% of input, which is exactly what
    // cacheWritePolicy 'input' means. This one IS official — the doc states it.
    record.suppressed.add('cacheWrite');
    record.cacheWritePolicy = 'input';
    record.cacheWritePolicySource = 'official';
    record.cacheDerivation.cacheWrite = `alibaba-multiplier:implicit-create-${formatPercent(rates.implicitCreate)}`;
  }

  return { hitMultiplier, createMultiplier };
}

/** 0.169 -> "16.9pct", so the derivation label reads back to the doc's wording. */
function formatPercent(multiplier) {
  return `${Number((multiplier * 100).toPrecision(6))}pct`;
}

// ──────────────────────── official: Volcengine scrape ─────────────────────

/**
 * Ark's doc API returns the page as markdown in Result.MDContent with a real
 * UpdatedTime. Only the "在线推理（常规）" table is read — 低延迟 (low-latency)
 * and TPM-package tables are separate, more expensive SKUs that a normal API key
 * does not hit, and 批量推理 is the batch discount.
 *
 * Bands are `输入长度 [0, 32]` / `(32, 128]` / `(128, 256]` in *thousands* of
 * tokens. Some models add an output-length condition on top; a single per-band
 * rate cannot express that, so the highest output rate in a band is kept. That
 * over-estimates short-output requests on doubao-seed-1.6 / 1.8 / glm-4.7
 * (their ≤200-output-token rows drop the output rate to ¥2.00) and never
 * under-estimates, which is the safer direction for a cost display.
 */
function parseVolcengine(markdown) {
  const start = markdown.indexOf('## 在线推理（常规）');
  if (start < 0) throw new Error('Volcengine doc: 在线推理（常规） section not found');
  const tableStart = markdown.indexOf('|模型名称', start);
  if (tableStart < 0) throw new Error('Volcengine doc: regular-inference table header not found');
  const tableEnd = markdown.indexOf('\n\n', markdown.indexOf('\n', tableStart));
  const table = markdown.slice(tableStart, tableEnd < 0 ? undefined : tableEnd);

  const rows = table.split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('|'))
    .map(line => line.slice(1).replace(/\|$/, '').split('|').map(cell => cell.replace(/\\/g, '').trim()));
  const header = rows.shift();
  const columnOf = pattern => header.findIndex(cell => pattern.test(cell));
  const columns = {
    condition: columnOf(/^条件/),
    input: columnOf(/^输入\(非音频\)/),
    storage: columnOf(/^缓存存储/),
    cacheHit: columnOf(/^缓存命中\(非音频\)/),
    output: columnOf(/^输出/)
  };
  for (const [name, index] of Object.entries(columns)) {
    if (index < 0) throw new Error(`Volcengine doc: column ${name} not found`);
  }

  const models = new Map();
  let currentId;
  for (const cells of rows) {
    if (/^-+$/.test(cells[0])) continue;
    const rawName = cells[0].replace(/<br>[\s\S]*$/, '').replace(/>.*$/, '').trim();
    if (rawName) currentId = rawName.toLowerCase();
    if (!currentId) continue;
    // Ark also hosts third-party models (deepseek-*, glm-*) at its own resale
    // rate. findModelPrice() keys on model id alone, so an Ark copy would be
    // indistinguishable from the vendor's own SKU — keep only ByteDance ids.
    if (!/^doubao/.test(currentId)) continue;
    const numeric = key => {
      const value = Number(String(cells[columns[key]] ?? '').replace(/[^\d.]/g, ''));
      return Number.isFinite(value) && value > 0 ? value : undefined;
    };
    const inputCny = numeric('input');
    const outputCny = numeric('output');
    if (inputCny === undefined || outputCny === undefined) continue;
    const bandLower = /\[\s*0\s*,/.test(cells[columns.condition])
      ? 0
      : (() => {
        const match = /[\(\[]\s*(\d+(?:\.\d+)?)\s*,/.exec(cells[columns.condition] || '');
        return match ? Number(match[1]) * 1000 + 1 : 0;
      })();
    if (!models.has(currentId)) {
      models.set(currentId, { id: currentId, bands: [], cacheStorageCny: numeric('storage') });
    }
    const model = models.get(currentId);
    const existing = model.bands.find(band => band.fromInputTokens === bandLower);
    // The condition also carries an output-length bound for the rows that discount
    // short replies, e.g. 输入长度[0, 32]且输出长度[0, 0.2] — in thousands of tokens.
    const outputAtMostTokens = (() => {
      const match = /输出长度\s*[\(\[]\s*0\s*,\s*(\d+(?:\.\d+)?)\s*\]/.exec(cells[columns.condition] || '');
      return match ? Math.round(Number(match[1]) * 1000) : undefined;
    })();
    const band = {
      fromInputTokens: bandLower,
      inputCny,
      outputCny,
      outputAtMostTokens,
      cacheReadCny: numeric('cacheHit')
    };
    // Same input band listed twice = an output-length sub-tier. The dearer row is
    // the band's base rate and the cheaper bounded row becomes its shortOutput, so
    // a short reply is billed at the rate the vendor actually charges instead of
    // being over-reported by up to 4x.
    if (!existing) model.bands.push(band);
    else {
      const dearer = band.outputCny > existing.outputCny ? band : existing;
      const cheaper = dearer === band ? existing : band;
      const merged = { ...dearer, outputAtMostTokens: undefined };
      if (cheaper.outputAtMostTokens !== undefined) {
        merged.shortOutputCny = { atMostTokens: cheaper.outputAtMostTokens, outputCny: cheaper.outputCny };
      } else {
        notes.push(`volcengine/${currentId}: band from ${bandLower} tokens is listed twice (¥${existing.outputCny} vs ¥${band.outputCny} per 1M output) but neither row bounds the output length, so ¥${dearer.outputCny} is used and a short reply may be over-estimated`);
      }
      Object.assign(existing, merged);
    }
  }
  return models;
}

// ────────────────── source: Azure Retail Prices (official) ────────────────

/**
 * Azure publishes one billing meter per (model, dimension, deployment scope), so
 * the whole rate card has to be reassembled from `skuName`. The vocabulary is
 * abbreviated but consistent — `5.6 sol ShortCo Cd Wr Std Gl` reads as
 * "gpt-5.6-sol, short context, cache write, standard tier, global deployment".
 *
 * Four things are filtered out before anything is believed:
 *   - sovereign clouds (US Gov is +25% over commercial, see AZURE_EXCLUDED_REGIONS);
 *   - non-global deployment scopes (Data Zone and Regional are +10%);
 *   - the Batch and PP tiers (PP is exactly 2x standard) and every non-token meter;
 *   - long-context meters, which are collected separately because Azure names the
 *     band (`LongCo`) without publishing the token threshold, so they can only
 *     corroborate a ladder another source supplies — never define one.
 *
 * The model name is then reconstructed and looked up against the records the
 * catalogues already created. A wrong reconstruction cannot poison a price: the
 * cloud reconciliation step downstream anchors every Azure row against the
 * vendor's own input rate and throws the whole source away for that model if it
 * disagrees.
 */
function parseAzureFoundry(items) {
  const collected = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    cloudStats.azureRows += 1;
    if (item?.currencyCode !== 'USD' || item?.type !== 'Consumption') continue;
    if (AZURE_EXCLUDED_REGIONS.test(String(item.armRegionName || ''))) continue;
    const family = AZURE_PRODUCT_FAMILIES.get(item.productName);
    if (!family) continue;
    const scale = item.unitOfMeasure === '1K' ? 1000 : item.unitOfMeasure === '1M' ? 1 : undefined;
    if (scale === undefined) continue;
    if (!/tokens\s*$/i.test(String(item.meterName || ''))) continue;

    const words = String(item.skuName || '').toLowerCase().replace(/[-_]/g, ' ').split(/\s+/).filter(Boolean);
    const text = ` ${words.join(' ')} `;
    if (AZURE_EXCLUDED_WORDS.test(text)) continue;
    if (/ (dz|dzone|dzn|regnl|rgnl|regional) /.test(text) || / data zone /.test(text)) continue;
    // An explicit global marker is required. A sku with no scope word at all is a
    // fine-tuning or hosting meter whose scope we cannot establish.
    if (!/ (gl|glbl|global) /.test(text)) continue;

    const field = azureFieldOf(text);
    if (!field) continue;
    const longContext = / longco /.test(text) || words[words.length - 1] === 'l';
    const modelWords = words.filter(word => !AZURE_SKU_VOCABULARY.has(word));
    if (!modelWords.length) continue;

    const record = findRecord(family.providerId, azureIdCandidates(family.prefix, modelWords));
    if (!record) {
      const label = `${family.providerId}/${modelWords.join('-')}`;
      cloudStats.azureUnmapped.set(label, (cloudStats.azureUnmapped.get(label) || 0) + 1);
      continue;
    }
    const price = round(Number(item.retailPrice) * scale);
    if (!validPrice(price) || price === 0) continue;
    const startsAt = String(item.effectiveStartDate || '');

    const key = `${record.providerId}::${record.key}`;
    if (!collected.has(key)) collected.set(key, { record, standard: new Map(), longContext: new Map() });
    const bucket = collected.get(key)[longContext ? 'longContext' : 'standard'];
    if (longContext) cloudStats.azureLongContext += 1;
    // Azure keeps every historical revision of a meter, so the same sku appears
    // with several effectiveStartDate values. The newest revision is the current
    // price; among rows sharing that date every commercial region quotes the same
    // figure, and a spread there means a filter above let a different SKU through,
    // so the lowest is kept and the spread reported.
    const existing = bucket.get(field);
    if (!existing || startsAt > existing.startsAt) {
      bucket.set(field, { value: price, min: price, max: price, rows: (existing?.rows || 0) + 1, startsAt });
    } else if (startsAt === existing.startsAt) {
      existing.rows += 1;
      existing.min = Math.min(existing.min, price);
      existing.max = Math.max(existing.max, price);
      existing.value = existing.min;
    } else existing.rows += 1;
  }

  for (const entry of collected.values()) {
    cloudStats.azureMapped += 1;
    cloudStats.azureModels.add(`${entry.record.providerId}/${entry.record.key}`);
    for (const [field, cell] of entry.standard) {
      if (cell.max > cell.min && relativeGap(cell.min, cell.max) > AGREEMENT_TOLERANCE) {
        warn('azure-region-spread', `${entry.record.providerId}/${entry.record.key} ${field}: Azure global meters disagree across regions (${cell.min}…${cell.max}); using ${cell.min}`);
      }
    }
    observeCloudPrices(entry.record, 'azure', entry.standard, entry.longContext);
  }
  return collected.size;
}

/** Azure dimension words. `opt` is OUTPUT, not "optimized" — see the constant. */
function azureFieldOf(text) {
  if (/ (cd|cache) wr /.test(text) || / cache write /.test(text)) return 'cacheWrite';
  if (/ (cd|cache) inp /.test(text) || / cached /.test(text) || / cchd /.test(text) || / cache read /.test(text)) return 'cacheRead';
  if (/ (outp|outpt|output|opt|out) /.test(text)) return 'output';
  if (/ (inp|inpt|input) /.test(text)) return 'input';
  return undefined;
}

/**
 * Rebuild the vendor's model id from Azure's abbreviated one, most specific first.
 * Azure drops the family prefix ("5.6 sol" for gpt-5.6-sol) and sometimes adds a
 * capability word ("K2.5 Thinking") the vendor's own id does not carry.
 *
 * A release stamp is NOT stripped. Azure writes `gpt 4o 0513` and `gpt-4o-0806`
 * for two SKUs priced $5 and $2.50; folding either onto `gpt-4o` merges two real
 * prices into one meaningless pair. Dated Azure skus simply go unmapped — the
 * catalogues cover them — and show up in audit.cloud.azure.unmappedSkuFragments.
 */
function azureIdCandidates(prefix, words) {
  const variants = [];
  const push = list => {
    if (!list.length) return;
    const raw = list.join('-');
    if (!variants.includes(raw)) variants.push(raw);
    const prefixed = `${prefix}-${raw}`;
    if (!raw.startsWith(`${prefix}-`) && raw !== prefix && !variants.includes(prefixed)) variants.push(prefixed);
  };
  const base = [...words];
  if (/^\d{4}$/.test(base[base.length - 1])) return [];
  push(base);
  while (base.length > 1 && AZURE_DESCRIPTOR_WORDS.has(base[base.length - 1])) {
    base.pop();
    push(base);
  }
  return variants;
}

// ─────────────────── source: AWS Bedrock price list (official) ─────────────

/**
 * The Bedrock offer file is the only official source that publishes Anthropic's
 * two cache TTLs as separate meters — `cache_write_tokens_standard` and
 * `cache_write_tokens_1h_standard` — which is the independent corroboration for
 * the 1h price that LiteLLM is otherwise alone in carrying.
 *
 * Only `*_global_standard` meters are read. The meter without `global` is the
 * region-pinned one and runs exactly +10%: Claude Mythos Preview publishes only
 * that one, at $27.50 input, and taking it as a fallback quoted the model 10% over
 * its real $25 list. A model with no global meter therefore gets no AWS row at
 * all rather than an inflated one.
 */
function parseAwsBedrock(payload) {
  const prices = new Map();
  for (const [sku, offers] of Object.entries(payload?.terms?.OnDemand || {})) {
    for (const offer of Object.values(offers || {})) {
      for (const dimension of Object.values(offer?.priceDimensions || {})) {
        const usd = Number(dimension?.pricePerUnit?.USD);
        if (!Number.isFinite(usd)) continue;
        prices.set(sku, { usd, unit: String(dimension.unit || '') });
      }
    }
  }

  const collected = new Map();
  const regionOnly = new Map();
  for (const product of Object.values(payload?.products || {})) {
    cloudStats.awsRows += 1;
    const serviceName = String(product?.attributes?.servicename || '');
    const name = serviceName.replace(/\s*\(Amazon Bedrock Edition\)\s*$/i, '').trim();
    // Only Anthropic is in PROVIDERS; the other Bedrock families (Cohere, Llama,
    // Jamba, Stability…) have no rule to corroborate.
    if (!/^claude\b/i.test(name)) continue;
    const meter = String(product?.attributes?.usagetype || '').split(':').pop().replace(/-Units$/i, '').replace(/^[A-Z0-9]+_/, '');
    const flat = meter.toLowerCase().replace(/_/g, '');
    if (AWS_EXCLUDED_METERS.test(flat)) continue;
    const field = awsFieldOf(flat);
    if (!field) continue;

    const record = findRecord('anthropic', [name.toLowerCase().replace(/\s+/g, '-')]);
    if (!record) {
      cloudStats.awsUnmapped.add(name);
      continue;
    }
    if (!/global/.test(flat)) {
      const seen = regionOnly.get(record) || new Set();
      seen.add(field);
      regionOnly.set(record, seen);
      continue;
    }
    const priced = prices.get(product.sku);
    if (!priced) continue;
    const scale = /1k/i.test(priced.unit) ? 1000 : /1m/i.test(priced.unit) ? 1 : undefined;
    if (scale === undefined) {
      warn('aws-unit', `${name} ${meter}: unrecognised unit "${priced.unit}"`);
      continue;
    }
    const value = round(priced.usd * scale);
    if (!validPrice(value) || value === 0) continue;

    const key = `${record.providerId}::${record.key}`;
    if (!collected.has(key)) collected.set(key, { record, standard: new Map() });
    const bucket = collected.get(key).standard;
    const existing = bucket.get(field);
    if (!existing || value < existing.value) bucket.set(field, { value, rows: (existing?.rows || 0) + 1 });
    else existing.rows += 1;
  }

  for (const [record, fields] of regionOnly) {
    if (collected.has(`${record.providerId}::${record.key}`)) continue;
    notes.push(`aws/${record.key}: only region-pinned meters exist (${[...fields].sort().join(', ')}), which run +10% over the global rate, so no AWS row is used for this model`);
  }
  for (const entry of collected.values()) {
    cloudStats.awsModels.add(`${entry.record.providerId}/${entry.record.key}`);
    observeCloudPrices(entry.record, 'aws', entry.standard, new Map());
  }
  return collected.size;
}

function awsFieldOf(flat) {
  if (/cachewrite1h|cachewritetokens1h/.test(flat)) return 'cacheWrite1h';
  if (/cachewrite/.test(flat)) return 'cacheWrite';
  if (/cacheread/.test(flat)) return 'cacheRead';
  if (/^inputtoken/.test(flat)) return 'input';
  if (/^outputtoken/.test(flat)) return 'output';
  return undefined;
}

/**
 * Record what a cloud says, and offer it as a price only where the cloud is not
 * reselling at a markup (CLOUD_PRICE_PROVIDERS). For everyone else the numbers
 * are still kept so reconcileCloudOfficial() can report the disagreement.
 */
function observeCloudPrices(record, sourceId, standard, longContext) {
  const values = {};
  for (const [field, cell] of standard) values[field] = cell.value;
  const long = {};
  for (const [field, cell] of longContext) long[field] = cell.value;
  record.cloudObserved.set(sourceId, { values, longContext: long });
  if (!CLOUD_PRICE_PROVIDERS.has(record.providerId)) return;
  for (const [field, value] of Object.entries(values)) record.offer(sourceId, field, value);
}

/**
 * A cloud rate that contradicts the vendor's own page — or a rate three
 * independent catalogues already agree on — is describing that cloud's invoice,
 * not the vendor's list price. What this app displays is the order of magnitude a
 * 兼容服务 relay bills against, so the vendor (or the consensus) wins and the
 * cloud's whole contribution for that model is withdrawn: keeping half of it would
 * leave a cache column priced against a rate the top-level fields no longer use.
 *
 * Measured cases this exists for: Azure quotes gpt-5.6-terra at $2.50 and
 * gpt-5.6-luna at $1.00 where models.dev, LiteLLM and Vercel unanimously say
 * $2.00 and $0.20, and Azure quotes deepseek-v4-pro 32% above DeepSeek's own page.
 * Letting the cloud win those also cost both gpt-5.6-* models their long-context
 * ladder, because the ladder's band 0 then no longer matched the flat rate.
 *
 * Where the catalogues have NO consensus of their own (one lone source, or three
 * mutually contradictory ones) the cloud does win — that is the case Azure/AWS are
 * here for, and it is how grok-code-fast-1 gets $0.20 instead of LiteLLM's lone $1.
 */
function reconcileCloudOfficial(record) {
  if (!record.cloudObserved.size) return;
  const vendorOf = field => record.candidates(field).find(entry => entry.source === 'official');
  const consensusOf = field => {
    const catalogues = record.candidates(field).filter(entry => (SOURCE_TIER.get(entry.source) ?? CATALOGUE_TIER) === CATALOGUE_TIER);
    if (catalogues.length < 2) return undefined;
    const middle = median(catalogues.map(entry => entry.value));
    const agreeing = catalogues.filter(entry => relativeGap(entry.value, middle) <= AGREEMENT_TOLERANCE);
    if (agreeing.length < 2) return undefined;
    return { value: middle, support: `${agreeing.length}/${catalogues.length}`, sources: catalogues.map(entry => `${entry.source}=${entry.value}`) };
  };

  for (const [sourceId, observed] of record.cloudObserved) {
    const cloudInput = observed.values.input;
    if (!validPrice(cloudInput)) continue;
    const vendorInput = vendorOf('input');
    const vendorOutput = vendorOf('output');
    const reference = vendorInput
      ? { kind: 'vendor page', input: vendorInput.value, output: vendorOutput?.value, detail: 'official' }
      : (() => {
        const input = consensusOf('input');
        if (!input) return undefined;
        const output = consensusOf('output');
        return { kind: 'catalogue consensus', input: input.value, output: output?.value, detail: input.sources.join(', '), support: input.support };
      })();
    if (!reference) {
      // No vendor page and no catalogue consensus: the cloud wins, which is the
      // case it is in the ladder for. Log it if it actually changes anything, so a
      // silent 2.5x move is never invisible.
      if (!CLOUD_PRICE_PROVIDERS.has(record.providerId)) continue;
      const loneInput = record.candidates('input').filter(entry => (SOURCE_TIER.get(entry.source) ?? CATALOGUE_TIER) === CATALOGUE_TIER);
      const loneOutput = record.candidates('output').filter(entry => (SOURCE_TIER.get(entry.source) ?? CATALOGUE_TIER) === CATALOGUE_TIER);
      const inputMoves = loneInput.length && loneInput.every(entry => relativeGap(entry.value, cloudInput) > AGREEMENT_TOLERANCE);
      const outputMoves = validPrice(observed.values.output) && loneOutput.length
        && loneOutput.every(entry => relativeGap(entry.value, observed.values.output) > AGREEMENT_TOLERANCE);
      if (inputMoves || outputMoves) {
        cloudOverrides.push({
          providerId: record.providerId,
          modelId: record.key,
          source: sourceId,
          cloudInput,
          cloudOutput: observed.values.output,
          catalogueInput: loneInput.map(entry => `${entry.source}=${entry.value}`),
          catalogueOutput: loneOutput.map(entry => `${entry.source}=${entry.value}`),
          reason: 'no vendor page and no catalogue consensus, so the cloud rate is adopted per PRICE_PRIORITY'
        });
      }
      continue;
    }

    const inputGap = relativeGap(cloudInput, reference.input);
    const outputGap = validPrice(observed.values.output) && validPrice(reference.output)
      ? relativeGap(observed.values.output, reference.output)
      : 0;
    if (inputGap <= AGREEMENT_TOLERANCE && outputGap <= AGREEMENT_TOLERANCE) continue;
    cloudConflicts.push({
      providerId: record.providerId,
      modelId: record.key,
      source: sourceId,
      resolution: `${reference.kind} kept; ${sourceId} rows dropped for this model`,
      cloudInput,
      referenceInput: reference.input,
      inputDelta: `${((cloudInput / reference.input - 1) * 100).toFixed(1)}%`,
      ...(observed.values.output === undefined ? {} : { cloudOutput: observed.values.output, referenceOutput: reference.output }),
      ...(observed.values.cacheRead === undefined ? {} : { cloudCacheRead: observed.values.cacheRead }),
      referenceDetail: reference.detail,
      ...(reference.support ? { referenceSupport: reference.support } : {})
    });
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h']) {
      record.dropField(field, entry => entry.source === sourceId);
    }
    record.cloudObserved.delete(sourceId);
  }
}

/**
 * Azure names its long-context band but not the threshold, so it can only check a
 * ladder somebody else supplied. Logged, never used to build one.
 */
function checkCloudLongContext(record, tiers) {
  if (!tiers || tiers.length < 2) return;
  const top = tiers[tiers.length - 1];
  for (const [sourceId, observed] of record.cloudObserved) {
    const long = observed.longContext;
    if (!validPrice(long?.input)) continue;
    if (relativeGap(long.input, top.input) <= AGREEMENT_TOLERANCE) {
      cloudStats.longContextAgree += 1;
      continue;
    }
    cloudStats.longContextDisagree += 1;
    notes.push(`${record.providerId}/${record.key}: ${sourceId} long-context input ${long.input} differs from the arbitrated top band ${top.input} (threshold is not published by ${sourceId}, so the ladder is left as arbitrated)`);
  }
}

// ────────────────────── source: OpenRouter (per endpoint) ──────────────────

/**
 * Enumerate the slugs worth polling. The top-level feed is read for ids ONLY —
 * its `pricing` block is the cheapest endpoint's and is never touched (measured:
 * gpt-5.6-sol at 2.50 against a 5.00 standard rate). Slugs carrying a ':' suffix
 * (`:free`, `:batch`, `:thinking`) are separate SKUs and are skipped, and a slug
 * that does not resolve to a model some other source already priced is skipped
 * too — OpenRouter must not be able to introduce a model on its own.
 */
function selectOpenRouterSlugs(payload) {
  const targets = [];
  const seen = new Set();
  const leftovers = [];
  for (const model of payload?.data || []) {
    const id = String(model?.id || '');
    if (!id || id.includes(':')) continue;
    const slash = id.indexOf('/');
    if (slash < 0) continue;
    const providerId = OPENROUTER_AUTHORS.get(id.slice(0, slash));
    if (!providerId) continue;
    const slugName = id.slice(slash + 1);
    const record = findRecord(providerId, openRouterSlugCandidates(providerId, slugName));
    if (!record) {
      leftovers.push({ slug: id, providerId, slugName });
      continue;
    }
    if (seen.has(record)) continue;
    seen.add(record);
    targets.push({ slug: id, record });
  }

  // Second pass: a model whose vendor id carries no release stamp often exists on
  // OpenRouter only under a dated slug (`qwen/qwen3.5-plus` is a 404; the real slug
  // is `qwen/qwen3.5-plus-20260420`). Adopt the dated slug for the undated record,
  // but only when exactly one dated slug matches the prefix — two candidates mean
  // OpenRouter is carrying two builds and picking either would be a guess.
  const byPrefix = new Map();
  for (const leftover of leftovers) {
    const dated = /^(.*?)-(\d{4}-\d{2}-\d{2}|\d{8}|\d{2}-\d{2})$/.exec(leftover.slugName);
    if (!dated) continue;
    const key = `${leftover.providerId}::${matchKey(dated[1])}`;
    if (!byPrefix.has(key)) byPrefix.set(key, []);
    byPrefix.get(key).push(leftover);
  }
  for (const [key, candidates] of byPrefix) {
    const record = records.get(key);
    if (!record || seen.has(record)) continue;
    if (candidates.length !== 1) {
      warn('openrouter-dated-slug-ambiguous', `${key}: OpenRouter carries ${candidates.length} dated slugs (${candidates.map(entry => entry.slug).join(', ')}) and the vendor id has no stamp, so none is adopted`);
      continue;
    }
    seen.add(record);
    targets.push({ slug: candidates[0].slug, record });
    openRouterStats.dateAliasResolved.push({ modelId: `${record.providerId}/${record.key}`, slug: candidates[0].slug });
  }
  return targets;
}

/**
 * Slug spellings to try against our record ids, most literal first.
 *
 * OpenRouter writes a release stamp compactly (`qwen3.5-plus-20260420`) where
 * Alibaba's own id dashes it (`qwen3.5-plus-2026-04-20`), and sometimes drops the
 * year entirely (`qwen3.5-flash-02-23` for `qwen3.5-flash-2026-02-23`). Rewriting
 * the stamp is safe in a way that *stripping* it is not: the rewrite still points
 * at one specific dated build, so it cannot collapse two differently priced SKUs
 * onto one id the way the Azure date-stripping bug did.
 */
function openRouterSlugCandidates(providerId, slugName) {
  const out = [slugName];
  const compact = /^(.*)-(\d{4})(\d{2})(\d{2})$/.exec(slugName);
  if (compact) out.push(`${compact[1]}-${compact[2]}-${compact[3]}-${compact[4]}`);
  const dashed = /^(.*)-(\d{4})-(\d{2})-(\d{2})$/.exec(slugName);
  if (dashed) out.push(`${dashed[1]}-${dashed[2]}${dashed[3]}${dashed[4]}`);
  // Year-less stamp: try the years our own ids actually use rather than inventing one.
  const monthDay = /^(.*)-(\d{2})-(\d{2})$/.exec(slugName);
  if (monthDay && !dashed) {
    for (let year = 2024; year <= new Date().getUTCFullYear() + 1; year += 1) {
      out.push(`${monthDay[1]}-${year}-${monthDay[2]}-${monthDay[3]}`);
    }
  }
  // ByteDance files doubao under the bare `seed-*` name on OpenRouter.
  if (providerId === 'volcengine' && /^seed-/.test(slugName)) out.push(`doubao-${slugName}`);
  return out;
}

async function fetchOpenRouterEndpoints(targets) {
  openRouterStats.slugs = targets.length;
  const fetched = await mapLimit(targets, 6, async target => {
    try {
      const { data } = await fetchJsonRetry(SOURCE_URLS.openRouterEndpoints.replace('{slug}', target.slug));
      openRouterStats.fetched += 1;
      return { ...target, endpoints: Array.isArray(data?.data?.endpoints) ? data.data.endpoints : [] };
    } catch (error) {
      openRouterStats.failed += 1;
      warn('openrouter-fetch', `${target.slug}: ${error.message}`);
      return undefined;
    }
  });
  return fetched.filter(Boolean);
}

/** Endpoints that are the vendor's own (or its cloud's) standard, non-regional tier. */
function openRouterUsableEndpoints(record, endpoints) {
  const kept = [];
  for (const endpoint of endpoints) {
    const tag = String(endpoint?.tag || '').toLowerCase();
    if (!tag) continue;
    const parts = tag.split('/');
    const root = parts[0];
    const qualifiers = parts.slice(1);
    const firstParty = OPENROUTER_FIRST_PARTY_TAGS.get(root) === record.providerId;
    const cloud = OPENROUTER_CLOUD_TAGS.has(root) && CLOUD_PRICE_PROVIDERS.has(record.providerId);
    // Everything else is a reseller: same model id, someone else's markup.
    if (!firstParty && !cloud) continue;
    const excluded = qualifiers.find(part => OPENROUTER_EXCLUDED_QUALIFIERS.has(part) || OPENROUTER_REGION_QUALIFIER.test(part));
    if (excluded) {
      if (!openRouterRejections.some(entry => entry.check === 'C1:openrouter-tag' && entry.modelId === record.key && entry.providerId === record.providerId && entry.tag === tag)) openRouterRejections.push({
        check: 'C1:openrouter-tag',
        providerId: record.providerId,
        modelId: record.key,
        tag,
        provider: endpoint.provider_name,
        endpointInput: perMillion(endpoint?.pricing?.prompt),
        reason: `tag qualifier "${excluded}" marks a discounted tier or a region uplift, not the standard rate`
      });
      continue;
    }
    kept.push({
      tag,
      provider: endpoint.provider_name,
      pricing: endpoint.pricing || {},
      supportsImplicitCaching: endpoint.supports_implicit_caching
    });
  }
  return kept;
}

/**
 * Anchor, then donate. An endpoint whose prompt/completion do not both reproduce
 * the arbitrated rate is a different service tier (or carries a markup), so its
 * cache columns describe that other tier and are dropped with it — this is what
 * keeps DeepSeek's off-peak endpoint (0.66/1.98/0.022) from overwriting the
 * busy-hour card we store, and what rejects the bare `openai` tag's 2.50.
 *
 * Donation is gap-fill only, per PRICE_PRIORITY: a column another source already
 * priced is compared and reported, never overwritten.
 */
function applyOpenRouterCacheFields(record, endpoints, arbitratedInput, arbitratedOutput) {
  if (!validPrice(arbitratedInput) || !validPrice(arbitratedOutput)) return;
  const usable = openRouterUsableEndpoints(record, endpoints);
  openRouterStats.endpoints += endpoints.length;
  openRouterStats.firstParty += usable.length;
  const accepted = [];
  for (const endpoint of usable) {
    const prompt = perMillion(endpoint.pricing.prompt);
    const completion = perMillion(endpoint.pricing.completion);
    if (prompt === undefined || completion === undefined) continue;
    const inputGap = relativeGap(prompt, arbitratedInput);
    const outputGap = relativeGap(completion, arbitratedOutput);
    if (inputGap > AGREEMENT_TOLERANCE || outputGap > AGREEMENT_TOLERANCE) {
      openRouterRejections.push({
        check: 'C2:openrouter-anchor',
        providerId: record.providerId,
        modelId: record.key,
        tag: endpoint.tag,
        provider: endpoint.provider,
        endpointInput: prompt,
        endpointOutput: completion,
        arbitratedInput,
        arbitratedOutput,
        inputGap: round(inputGap),
        outputGap: round(outputGap),
        reason: 'endpoint price does not reproduce the arbitrated rate, so its cache columns describe a different service tier'
      });
      continue;
    }
    openRouterStats.anchored += 1;
    accepted.push(endpoint);
  }
  if (!accepted.length) return;

  const columns = [
    ['cacheRead', 'input_cache_read', 1],
    ['cacheWrite', 'input_cache_write', 4],
    ['cacheWrite1h', 'input_cache_write_1h', 4]
  ];
  for (const [field, key, ceilingFactor] of columns) {
    // A field the vendor's page says the model does not have at all stays empty.
    // `unpublished` is the other case — the vendor charges the fee but prints
    // "see the console" instead of the multiplier (qwen3.8-max) — and there an
    // anchored first-party endpoint is the vendor's own number, not a guess.
    if (record.suppressed.has(field) && !record.unpublished.has(field)) continue;
    if (field !== 'cacheRead' && STORAGE_BILLED_PROVIDERS.has(record.providerId)) {
      const observed = perMillion(accepted[0].pricing[key]);
      if (observed !== undefined && observed > 0) {
        openRouterRejections.push({
          check: 'C4:openrouter-storage-billed',
          providerId: record.providerId,
          modelId: record.key,
          field,
          value: observed,
          reason: `${record.providerId} bills its cache as token-hour storage, and this column is that storage rate re-expressed per token (see STORAGE_BILLED_PROVIDERS)`
        });
      }
      continue;
    }
    const values = accepted.map(endpoint => perMillion(endpoint.pricing[key])).filter(value => value !== undefined && value > 0);
    if (!values.length) continue;
    const value = median(values);
    // The anchor proves the tier; this only catches a transposed column.
    if (value > arbitratedInput * ceilingFactor) {
      openRouterRejections.push({
        check: 'C3:openrouter-column-sanity',
        providerId: record.providerId,
        modelId: record.key,
        field,
        value,
        arbitratedInput,
        reason: `${field} above ${ceilingFactor}x the input rate is a mislabelled column, not a price`
      });
      continue;
    }
    const existing = record.candidates(field).filter(entry => entry.source !== 'openrouter');
    if (existing.length && !record.suppressed.has(field)) {
      const current = median(existing.map(entry => entry.value));
      if (relativeGap(value, current) > AGREEMENT_TOLERANCE) {
        warn('openrouter-cache-disagrees', `${record.providerId}/${record.key} ${field}: first-party endpoint ${accepted.map(e => e.tag).join('/')} says ${value} but the arbitrated value is ${current}; keeping ${current} per PRICE_PRIORITY (gap-fill only)`);
      } else openRouterStats.corroborated += 1;
      continue;
    }
    record.offer('openrouter', field, value);
    openRouterStats.filled[field] += 1;
  }
}

/**
 * Cross-check the cache doc's mode list against OpenRouter's per-endpoint
 * `supports_implicit_caching` flag. Corroboration only, never authority: measured
 * 2026-08-19 the flag reads false for qwen3.8-max even though the doc lists it
 * under implicit caching in every region, so believing the flag would strip a
 * documented rate. It is logged so a systematic drift in the doc parse would show
 * up as a burst of disagreements rather than as silent wrong prices.
 */
function checkImplicitCachingFlag(record, endpoints) {
  if (!record.cacheModes) return;
  for (const endpoint of openRouterUsableEndpoints(record, endpoints)) {
    if (typeof endpoint.supportsImplicitCaching !== 'boolean') continue;
    if (endpoint.supportsImplicitCaching === record.cacheModes.implicit) {
      alibabaCacheStats.implicitFlagAgreements += 1;
      continue;
    }
    alibabaCacheStats.implicitFlagDisagreement.push({
      modelId: `${record.providerId}/${record.key}`,
      tag: endpoint.tag,
      docImplicit: record.cacheModes.implicit,
      docExplicit: record.cacheModes.explicit,
      openRouterSupportsImplicit: endpoint.supportsImplicitCaching,
      resolution: 'cache doc kept; the flag is corroboration only'
    });
  }
}

/**
 * The ratio rescue: use an endpoint's cache/input RATIO when its absolute prices
 * were rejected by the anchor.
 *
 * A reseller discount scales an endpoint's whole price column by one factor, so
 * the absolute figures are unusable but the ratios between them survive intact.
 * Measured 2026-08-19, Alibaba's own OpenRouter endpoints:
 *     qwen3.5-plus-20260420   in=0.3000  cw=0.3750  ->  cw/in = 1.25
 *     qwen3.6-plus            in=0.3250  cw=0.4063  ->  cw/in = 1.25
 * Both are 0.75x and 0.65x of our list rates respectively — two *different*
 * discounts, so neither absolute price is a list price — yet both reproduce exactly
 * the 125% explicit-cache-creation multiplier Alibaba's cache doc publishes. The
 * ratio is the signal; the absolute value is noise.
 *
 * Two guards keep this from becoming a laundering route for a foreign SKU:
 *   a. the endpoint's own input:output ratio must match ours within tolerance. A
 *      flat discount preserves it; a genuinely different SKU (a different context
 *      band, a different modality mix — gemini-3-pro-image's endpoint is 2/12
 *      against our 2/66) does not. This makes "same shape, different scale" a
 *      checkable claim rather than an assumption.
 *   b. gap-fill only, and only from a first-party tag, same as the anchored path.
 *
 * A column the vendor's own doc rules out is NOT filled from a ratio either: the
 * doc outranks an aggregator's opinion about whether a model caches at all, and
 * those declines are logged in ratioBlockedByDoc rather than silently skipped.
 *
 * When the column is already priced the ratio is still computed and COMPARED. That
 * is what keeps this path honest: it independently reproduces the Alibaba
 * multipliers off a live first-party endpoint on every run, instead of sitting
 * unexecuted until the day it is needed.
 */
function applyOpenRouterRatioFallback(record, endpoints, arbitratedInput, arbitratedOutput) {
  if (!validPrice(arbitratedInput) || !validPrice(arbitratedOutput) || arbitratedInput === 0) return;
  const columns = [
    ['cacheRead', 'input_cache_read', 1],
    ['cacheWrite', 'input_cache_write', 4],
    ['cacheWrite1h', 'input_cache_write_1h', 4]
  ];
  const ourShape = arbitratedOutput / arbitratedInput;

  for (const endpoint of openRouterUsableEndpoints(record, endpoints)) {
    const prompt = perMillion(endpoint.pricing.prompt);
    const completion = perMillion(endpoint.pricing.completion);
    if (prompt === undefined || completion === undefined || prompt === 0) continue;
    // Endpoints whose absolute prices match are the anchored path's business.
    if (relativeGap(prompt, arbitratedInput) <= AGREEMENT_TOLERANCE
      && relativeGap(completion, arbitratedOutput) <= AGREEMENT_TOLERANCE) continue;
    if (relativeGap(completion / prompt, ourShape) > AGREEMENT_TOLERANCE) continue;

    for (const [field, key, ceilingFactor] of columns) {
      const observed = perMillion(endpoint.pricing[key]);
      if (observed === undefined || observed <= 0) continue;
      const ratio = observed / prompt;
      if (ratio > ceilingFactor) continue;
      const value = round(arbitratedInput * ratio);
      const label = `openrouter-ratio:${Number(ratio.toPrecision(6))}x-input`;
      const evidence = {
        providerId: record.providerId,
        modelId: record.key,
        field,
        tag: endpoint.tag,
        endpointInput: prompt,
        endpointValue: observed,
        ratio: round(ratio),
        arbitratedInput,
        value
      };

      if (record.suppressed.has(field) && !record.unpublished.has(field)) {
        openRouterStats.ratioBlockedByDoc.push({
          ...evidence,
          reason: "the vendor's own cache doc does not list this model as cache-capable, so a ratio must not invent one"
        });
        continue;
      }
      if (field !== 'cacheRead' && STORAGE_BILLED_PROVIDERS.has(record.providerId)) continue;

      const existing = record.candidates(field).filter(entry => entry.source !== 'openrouter');
      if (!existing.length) {
        record.offer('openrouter', field, value);
        record.cacheDerivation[field] = label;
        openRouterStats.ratioFilled.push({
          ...evidence,
          reason: 'endpoint absolute prices are a resale discount (anchor rejected) but its input:output shape matches ours, so only the ratio is used'
        });
        continue;
      }
      const current = median(existing.map(entry => entry.value));
      if (relativeGap(value, current) <= AGREEMENT_TOLERANCE) {
        openRouterStats.ratioCorroborated.push({ ...evidence, current });
      } else {
        openRouterStats.ratioDisagreement.push({
          ...evidence,
          current,
          reason: 'ratio off a first-party endpoint disagrees with the arbitrated value; the arbitrated value is kept'
        });
      }
    }
  }
}

// ─────────────────────────── validation A and B ───────────────────────────

/**
 * Validation A — cacheRead/input ratio plausibility.
 *
 * Every first-party vendor prices a cache read as a fixed fraction of input:
 * 0.1 (Anthropic, Moonshot k3, Alibaba explicit), 0.16 (Moonshot k2.6),
 * 0.2 (Anthropic Sonnet-5, Alibaba implicit), 0.25 (Gemini 2.5, GLM-5.2),
 * 0.5 (older OpenAI). A ratio outside [0.05, 0.6] is therefore not a pricing
 * decision, it is a lost or added decimal place. Rejecting the *field* (not the
 * row) keeps the input/output prices and makes cache reads unpriced rather than
 * wrong.
 *
 * Officially scraped values are exempt and only logged: DeepSeek genuinely
 * prices cache hits at 3.3% of input ($0.044 against $1.32 for v4-pro), which
 * this heuristic would otherwise throw away. A vendor's own page outranks a
 * heuristic built from other vendors' habits.
 */
function validateCacheReadRatio(record) {
  const inputs = record.candidates('input');
  // The vendor's own input rate is the right denominator when we have it; a
  // median over catalogue rows can be dragged by a stale one and would then make
  // a correct cache rate look like an outlier.
  const official = inputs.find(entry => entry.source === 'official');
  const reference = official ? official.value : inputs.length ? median(inputs.map(entry => entry.value)) : undefined;
  if (!reference) return;
  const dropped = record.dropField('cacheRead', entry => {
    if (entry.source === 'official') return false;
    const ratio = entry.value / reference;
    return ratio < CACHE_READ_RATIO_FLOOR || ratio > CACHE_READ_RATIO_CEILING;
  });
  for (const entry of dropped) {
    rejections.push({
      check: 'A:cache-read-ratio',
      providerId: record.providerId,
      modelId: record.key,
      source: entry.source,
      field: 'cacheRead',
      value: entry.value,
      ratio: round(entry.value / reference),
      reason: `cacheRead/input outside [${CACHE_READ_RATIO_FLOOR}, ${CACHE_READ_RATIO_CEILING}]`
    });
  }
  for (const entry of record.candidates('cacheRead')) {
    if (entry.source !== 'official') continue;
    const ratio = entry.value / reference;
    if (ratio < CACHE_READ_RATIO_FLOOR || ratio > CACHE_READ_RATIO_CEILING) {
      warn('official-ratio-outlier', `${record.providerId}/${record.key} official cacheRead ratio ${round(ratio)} is outside the first-party cluster but is kept because the vendor published it`);
    }
  }
}

/**
 * Validation B — cross-provider mode.
 *
 * models.dev files the same model id under dozens of providers. A data-entry
 * slip lands in one of them; the correct number is repeated by the rest. Comparing
 * the cacheRead/input *ratio* against the mode of all providers isolates the
 * slip without being fooled by resale markup, which scales both numbers.
 *
 * This check is weaker than A in practice: several resellers re-import
 * models.dev, so a bad first-party ratio can become the mode itself
 * (deepseek-v4-pro's 0.008 has 9 supporters against 5 for the correct 0.033).
 * It is kept because it catches typos on models that check A's absolute window
 * cannot separate.
 */
function validateAgainstRatioMode(record, modes) {
  const mode = modes.get(record.key);
  if (!mode || mode.support < 3) return;
  const inputs = record.candidates('input');
  const reference = inputs.length ? median(inputs.map(entry => entry.value)) : undefined;
  if (!reference || !mode.ratio) return;
  const dropped = record.dropField('cacheRead', entry => {
    if (entry.source !== 'models.dev') return false;
    const ratio = entry.value / reference;
    if (!ratio) return false;
    const factor = ratio / mode.ratio;
    return factor >= 3 || factor <= 1 / 3;
  });
  for (const entry of dropped) {
    rejections.push({
      check: 'B:cross-provider-mode',
      providerId: record.providerId,
      modelId: record.key,
      source: entry.source,
      field: 'cacheRead',
      value: entry.value,
      ratio: round(entry.value / reference),
      modeRatio: mode.ratio,
      modeSupport: `${mode.support}/${mode.total}`,
      reason: 'ratio differs from the cross-provider mode by 3x or more'
    });
  }
}

function median(values) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : round((sorted[middle - 1] + sorted[middle]) / 2);
}

// ─────────────────────────────── arbitration ──────────────────────────────

/**
 * PRICE_PRIORITY, applied. The lowest non-empty tier wins outright: the tiers
 * below it are never averaged in, which is the whole point — a vendor's own page
 * must not be dragged by three catalogues, and Azure/AWS must not be dragged by
 * a reseller-fed median.
 *
 * Within the catalogue tier the median is what saves gpt-5.6-sol: Vercel reports
 * its Batch rate ($2.5/$15, exactly half), while models.dev and LiteLLM both
 * report the standard $5/$30. Two agreeing sources outvote the odd one out, and
 * taking the median rather than the mean means the wrong value does not leak in.
 *
 * `priceSource` stays inside the union the runtime validates
 * ('official' | 'consensus' | 'single'); the finer provenance goes to `detail`,
 * which is emitted as the runtime-ignored `priceSourceDetail`. A cloud rate is
 * only labelled 'consensus' when something independent reproduces it — being
 * official does not make an unverified single reading cross-checked.
 */
function arbitrate(record, field) {
  const entries = record.candidates(field);
  if (!entries.length) return undefined;
  const tierOf = entry => SOURCE_TIER.get(entry.source) ?? CATALOGUE_TIER;
  const best = Math.min(...entries.map(tierOf));
  const group = entries.filter(entry => tierOf(entry) === best);
  const below = entries.filter(entry => tierOf(entry) !== best);

  if (best === 0) {
    return { value: group[0].value, priceSource: 'official', detail: 'vendor-page', sources: ['official'] };
  }

  if (best === 1) {
    const value = median(group.map(entry => entry.value));
    const agreeingClouds = group.filter(entry => relativeGap(entry.value, value) <= AGREEMENT_TOLERANCE).length;
    const corroborated = agreeingClouds >= 2 || below.some(entry => relativeGap(entry.value, value) <= AGREEMENT_TOLERANCE);
    return {
      value,
      priceSource: corroborated ? 'consensus' : 'single',
      detail: `${group.map(entry => entry.source).join('+')}-official`,
      sources: group.map(entry => entry.source)
    };
  }

  const values = group.map(entry => entry.value);
  if (best === 3) {
    return { value: median(values), priceSource: 'single', detail: 'openrouter-endpoint', sources: group.map(entry => entry.source) };
  }
  if (values.length === 1) {
    return { value: values[0], priceSource: 'single', detail: `catalogue:${group[0].source}`, sources: group.map(entry => entry.source) };
  }
  const middle = median(values);
  const agreeing = values.filter(value => relativeGap(value, middle) <= AGREEMENT_TOLERANCE).length;
  if (agreeing >= 2) {
    return { value: middle, priceSource: 'consensus', detail: 'catalogue-median', sources: group.map(entry => entry.source) };
  }
  warn('no-consensus', `${record.providerId}/${record.key} ${field}: sources disagree (${group.map(e => `${e.source}=${e.value}`).join(', ')}); using the median ${middle}`);
  return { value: middle, priceSource: 'single', detail: 'catalogue-median-no-agreement', sources: group.map(entry => entry.source) };
}

/**
 * Cache columns, with the two vendor markers honoured. A column the vendor's page
 * rules out entirely stays empty; a column it charges for but does not print may
 * be supplied by an anchored first-party endpoint (see ModelRecord.unpublished).
 */
function arbitrateCacheField(record, field) {
  if (!record.suppressed.has(field)) return arbitrate(record, field);
  if (!record.unpublished.has(field)) return undefined;
  const donated = record.candidates(field).filter(entry => entry.source === 'openrouter');
  if (!donated.length) return undefined;
  return {
    value: median(donated.map(entry => entry.value)),
    priceSource: 'single',
    detail: 'openrouter-endpoint:unpublished-multiplier',
    sources: ['openrouter']
  };
}

/**
 * Band sets are arbitrated by *shape* first, then value by value.
 *
 * The three catalogues express the same boundary slightly differently (Vercel's
 * `min: 32001`, LiteLLM's `range: [32000, …]`, Alibaba's `32K<Token≤128K`), so
 * shapes are compared on boundaries rounded to the nearest 1000. The shape the
 * vendor publishes wins; otherwise the shape with the most independent sources
 * wins. Within the winning shape an official set is used verbatim, else each
 * band's fields are the median across sources — which is what stops Vercel's
 * Batch-rate ladder from being adopted for gpt-5.6-sol.
 */
function arbitrateTiers(record, arbitratedInput) {
  const usable = [];
  for (const set of record.tierSets) {
    const kept = set.tiers.filter(band => band.fromInputTokens <= TIER_THRESHOLD_LIMIT);
    if (kept.length !== set.tiers.length) {
      const dropped = set.tiers.filter(band => band.fromInputTokens > TIER_THRESHOLD_LIMIT);
      notes.push(`${record.providerId}/${record.key}: dropped ${dropped.length} long-context premium band(s) at ${dropped.map(band => band.fromInputTokens).join(', ')} tokens from ${set.source}; the standard rate stays priceable instead`);
    }
    if (kept.length >= 2) usable.push({ source: set.source, tiers: kept });
  }
  if (!usable.length) return undefined;

  // A ladder whose base rate contradicts the arbitrated base rate is a different
  // SKU tier, not a competing opinion about the same one. Vercel publishes
  // OpenAI's Batch ladder (2.5 -> 5) alongside models.dev's standard ladder
  // (5 -> 10); both describe a single 272K step, so shape grouping merged them
  // and averaged band 0 to 3.75, which the base-rate guard below then rejected —
  // costing gpt-5.6-sol its long-context premium entirely. Drop the contradicting
  // ladders first, and only fall back to considering them all if none agrees.
  const agreeing = arbitratedInput === undefined
    ? usable
    : usable.filter(set => relativeGap(set.tiers[0].input, arbitratedInput) <= AGREEMENT_TOLERANCE);
  if (agreeing.length && agreeing.length !== usable.length) {
    for (const set of usable) {
      if (agreeing.includes(set)) continue;
      warn('tier-base-off-sku', `${record.providerId}/${record.key}: ignoring the ${set.source} band ladder because its band 0 input ${set.tiers[0].input} is a different service tier than the arbitrated rate ${arbitratedInput}`);
    }
  }
  const candidates = agreeing.length ? agreeing : usable;

  const signatureOf = set => `${set.tiers.length}:${set.tiers.map(band => Math.round(band.fromInputTokens / 1000)).join('|')}`;
  const groups = new Map();
  for (const set of candidates) {
    const signature = signatureOf(set);
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(set);
  }
  const officialSet = candidates.find(set => set.source === 'official');
  const group = officialSet
    ? groups.get(signatureOf(officialSet))
    : [...groups.values()].sort((a, b) => b.length - a.length || b[0].tiers.length - a[0].tiers.length)[0];

  for (const [signature, sets] of groups) {
    if (sets === group) continue;
    warn('tier-shape-mismatch', `${record.providerId}/${record.key}: keeping band shape ${signatureOf(group[0])} from ${group.map(s => s.source).join('+')} over ${signature} from ${sets.map(s => s.source).join('+')}`);
  }

  const template = officialSet || group[0];
  const tiers = template.tiers.map((band, index) => {
    const valueOf = field => {
      if (officialSet) return officialSet.tiers[index][field];
      const values = group
        .map(set => set.tiers[index]?.[field])
        .filter(value => typeof value === 'number');
      return values.length ? median(values) : undefined;
    };
    // Boundaries differ by one token between sources; take the strictest so a
    // request exactly on a ceiling is billed in the cheaper band, as the vendors
    // document ("0<Token≤32K").
    const fromInputTokens = index === 0
      ? 0
      : Math.max(...group.map(set => set.tiers[index]?.fromInputTokens || band.fromInputTokens));
    const cacheRead = valueOf('cacheRead');
    const cacheWrite = valueOf('cacheWrite');
    // An output-length discount is a published condition, not a rate to average
    // across catalogues - no aggregator carries it at all - so it is passed
    // through from the vendor ladder only, and only when the arbitrated base rate
    // still sits above it.
    const officialBand = officialSet?.tiers?.[index];
    const shortOutput = officialBand?.shortOutput;
    const arbitratedOutput = valueOf('output');
    const keepShortOutput = shortOutput
      && typeof arbitratedOutput === 'number'
      && shortOutput.output < arbitratedOutput;
    return {
      fromInputTokens,
      input: valueOf('input'),
      output: arbitratedOutput,
      ...(cacheRead === undefined || record.suppressed.has('cacheRead') ? {} : { cacheRead }),
      ...(cacheWrite === undefined || record.suppressed.has('cacheWrite') ? {} : { cacheWrite }),
      ...(keepShortOutput ? { shortOutput } : {})
    };
  });
  if (tiers.some(band => band.input === undefined || band.output === undefined)) return undefined;

  // A ladder whose bottom rung disagrees with the arbitrated flat rate is
  // describing a different SKU (batch, priority, a region). Vercel's
  // gpt-5.6-sol ladder starts at the Batch rate, exactly half of list.
  if (arbitratedInput !== undefined && relativeGap(tiers[0].input, arbitratedInput) > AGREEMENT_TOLERANCE) {
    warn('tier-base-mismatch', `${record.providerId}/${record.key}: dropping the ${template.source} band ladder because band 0 input ${tiers[0].input} disagrees with the arbitrated rate ${arbitratedInput}`);
    return undefined;
  }

  return {
    tiers,
    priceSource: officialSet ? 'official' : group.length > 1 ? 'consensus' : 'single'
  };
}

// ─────────────────────────────── staleness ────────────────────────────────

/**
 * Stale-data probes. None of these block a rule; a wrong-but-flagged price is
 * still better than no price, and the maintainer needs the list to decide what
 * to pin by hand in COMPATIBLE_SERVICE_PRICE_OVERRIDES.
 */
function detectStaleness(record, resolved, officialIds) {
  const lastUpdated = record.lastUpdated.get('models.dev');
  const modelsDevInput = record.candidates('input').find(entry => entry.source === 'models.dev');
  // Compare against the vendor's own rate card as well as the rival catalogues:
  // qwen-vl-ocr is only detectable that way, because no other catalogue lists it
  // and models.dev is still quoting the withdrawn 2024-10-28 snapshot.
  const others = record.candidates('input').filter(entry => entry.source !== 'models.dev');
  if (lastUpdated && modelsDevInput && others.length) {
    const worst = others.reduce((acc, entry) => Math.max(acc, relativeGap(entry.value, modelsDevInput.value)), 0);
    if (worst > AGREEMENT_TOLERANCE) {
      staleAlerts.push({
        severity: 'high',
        providerId: record.providerId,
        modelId: record.key,
        reason: `models.dev row last touched ${lastUpdated} and its input price differs from another source by ${(worst * 100).toFixed(1)}%`,
        modelsDev: modelsDevInput.value,
        others: others.map(entry => `${entry.source}=${entry.value}`)
      });
    }
  }

  // Retired SKUs. models.dev leaves `status` empty on every first-party row, so
  // withdrawal has to be inferred from LiteLLM's deprecation_date or from the id
  // no longer appearing on the vendor's own page.
  const today = new Date().toISOString().slice(0, 10);
  if (record.deprecationDate && record.deprecationDate <= today) {
    staleAlerts.push({
      severity: 'high',
      providerId: record.providerId,
      modelId: record.key,
      reason: `LiteLLM deprecation_date ${record.deprecationDate} has passed but the id is still priced`
    });
  }
  const official = officialIds.get(record.providerId);
  // Only providers whose whole text-generation rate card we scrape can support
  // an "absent means withdrawn" inference. The Volcengine scrape is doubao-only
  // by design, so it must not be used to declare an embedding SKU retired.
  const cardIsComplete = record.providerId === 'deepseek' || record.providerId === 'alibaba';
  if (cardIsComplete && official && official.size && !record.officialSeen && !official.has(record.key)) {
    staleAlerts.push({
      severity: 'high',
      providerId: record.providerId,
      modelId: record.key,
      reason: 'id is absent from the vendor\'s current rate card; the price is a catalogue snapshot of a withdrawn SKU'
    });
  }
  if (resolved.priceSource === 'single' && !record.officialSeen) {
    staleAlerts.push({
      severity: 'info',
      providerId: record.providerId,
      modelId: record.key,
      reason: 'only one catalogue prices this id, so no cross-check is possible'
    });
  }
}

// ──────────────────────────────── main flow ───────────────────────────────

async function main() {
  console.log('Fetching price sources…');
  const [modelsDev, liteLlm, vercel, helicone, deepseekPage, alibabaPage, alibabaCachePage, volcenginePage, azureItems, awsRegion, openRouterModels] = await Promise.all([
    fetchJson(SOURCE_URLS.modelsDev),
    fetchJson(SOURCE_URLS.liteLlm),
    fetchJson(SOURCE_URLS.vercel),
    fetchJson(SOURCE_URLS.helicone).catch(error => {
      warn('source-unavailable', `Helicone registry unavailable (${error.message}); Google cache storage will be omitted`);
      return { data: undefined };
    }),
    fetchText(SOURCE_URLS.deepseek, 'text/html'),
    fetchText(SOURCE_URLS.alibaba, 'text/markdown'),
    // No .catch(): without this doc there is no way to tell a cache-capable
    // Alibaba model from one that does not cache, and guessing that is exactly the
    // bug this source was added to fix. A failed fetch must fail the run.
    fetchText(SOURCE_URLS.alibabaCache, 'text/markdown'),
    fetchJson(SOURCE_URLS.volcengine),
    fetchAzureRetail().catch(error => {
      warn('source-unavailable', `Azure Retail Prices unavailable (${error.message}); no Azure corroboration this run`);
      return { items: [], pages: 0 };
    }),
    fetchAwsBedrock().catch(error => {
      warn('source-unavailable', `AWS Bedrock price list unavailable (${error.message}); no AWS corroboration this run`);
      return undefined;
    }),
    fetchJson(SOURCE_URLS.openRouterModels).catch(error => {
      warn('source-unavailable', `OpenRouter model list unavailable (${error.message}); cache columns will not be gap-filled`);
      return { data: undefined };
    })
  ]);

  const sourceStats = [];

  // ── vendor rate cards are parsed first: they can declare id aliases, and
  //    matchKey() has to know about them before the catalogues are folded in ──
  const officialIds = new Map();

  const deepseek = parseDeepSeek(deepseekPage.text);
  for (const [version, canonical] of deepseek.versionAliases) {
    ID_ALIASES.set(matchKey(version), matchKey(canonical));
    notes.push(`deepseek/${version.toLowerCase()} is a MODEL VERSION row on the official page, not a billable SKU; folded into ${canonical}`);
  }

  // ── list-price catalogues ──
  sourceStats.push({ id: 'models.dev', url: SOURCE_URLS.modelsDev, models: collectModelsDev(modelsDev.data) });
  const ratioModes = buildRatioModes(modelsDev.data);
  sourceStats.push({ id: 'litellm', url: SOURCE_URLS.liteLlm, models: collectLiteLlm(liteLlm.data) });
  sourceStats.push({ id: 'vercel-ai-gateway', url: SOURCE_URLS.vercel, models: collectVercel(vercel.data) });

  // ── fold the official rates in; arbitrate() lets them win over the catalogues ──
  officialIds.set('deepseek', new Set(deepseek.rates.map(rate => matchKey(rate.id))));
  for (const rate of deepseek.rates) {
    const record = recordFor('deepseek', rate.id);
    record.officialSeen = true;
    // Aggregator candidates are kept alongside so the staleness probe can still
    // report how far models.dev has drifted; arbitrate() prefers 'official'.
    record.offer('official', 'input', rate.input);
    record.offer('official', 'output', rate.output);
    record.offer('official', 'cacheRead', rate.cacheRead);
    // Peak rates go in the top-level fields and the schedule multiplies them
    // down, so the off-peak half-price falls out of isOffPeakAt().
    record.peak = { peakWindowsUtc: deepseek.peakWindowsUtc, offPeakMultiplier: deepseek.offPeakMultiplier };
    // DeepSeek has no cache-creation line at all: uncached prompt tokens are
    // billed at the CACHE MISS rate, which is the plain input rate. The rate card
    // states this, so the policy carries an 'official' source — unlike the Alibaba
    // 'free' inference this replaced, which asserted 'official' from the mere
    // ABSENCE of a cache column.
    record.cacheWritePolicy = 'input';
    record.cacheWritePolicySource = 'official';
    record.suppressed.add('cacheWrite');
  }
  sourceStats.push({ id: 'deepseek-official', url: SOURCE_URLS.deepseek, models: deepseek.rates.length, note: `peak ${deepseek.peakWindowsUtc.map(w => `${w[0]}-${w[1]}`).join(',')} UTC, off-peak x${deepseek.offPeakMultiplier}; only these ids are billable SKUs (DeepSeek-V4-*-0731 is a MODEL VERSION row)` });

  const alibaba = parseAlibaba(alibabaPage.text);
  const alibabaCache = parseAlibabaCacheDoc(alibabaCachePage.text);
  officialIds.set('alibaba', new Set([...alibaba.keys()].map(matchKey)));
  for (const entry of alibaba.values()) {
    const record = recordFor('alibaba', entry.id);
    record.officialSeen = true;
    const first = entry.bands[0];
    record.offer('official', 'input', round(first.input));
    record.offer('official', 'output', round(first.output));
    const derived = resolveAlibabaCache(record, entry, alibabaCache);

    const bands = sealTiers(entry.bands.map(band => ({ ...band })));
    if (bands) {
      const tiered = bands.map(band => ({
        fromInputTokens: band.fromInputTokens,
        input: round(band.input),
        output: round(band.output),
        // Every band is the same multiplier applied to that band's own input rate,
        // which is what the doc describes ("输入 Token 单价的 N%" — the *local* unit
        // price). A band must never reuse band 0's derived cache rate.
        ...(derived.hitMultiplier === undefined ? {} : { cacheRead: round(band.input * derived.hitMultiplier) }),
        ...(derived.createMultiplier === undefined ? {} : { cacheWrite: round(band.input * derived.createMultiplier) })
      }));
      record.tierSets = [{ source: 'official', tiers: tiered }, ...record.tierSets.filter(set => set.source !== 'official')];
    }
  }
  sourceStats.push({
    id: 'alibaba-official',
    url: SOURCE_URLS.alibaba,
    models: alibaba.size,
    note: 'international (Singapore) scope, USD-denominated; cache support and multipliers read from ' + SOURCE_URLS.alibabaCache
  });
  sourceStats.push({
    id: 'alibaba-cache-doc',
    url: SOURCE_URLS.alibabaCache,
    models: alibabaCacheStats.explicitOnly + alibabaCacheStats.implicitOnly + alibabaCacheStats.both + alibabaCacheStats.unpublishedHit,
    note: `explicit create x${alibabaCache.rates.explicitCreate} / hit x${alibabaCache.rates.explicitHit}, implicit create x${alibabaCache.rates.implicitCreate} / hit x${alibabaCache.rates.implicitHit}, all parsed from the doc; support read from its per-region 支持的模型 lists`
  });

  const volcengine = parseVolcengine(volcenginePage.data?.Result?.MDContent || '');
  officialIds.set('volcengine', new Set([...volcengine.keys()].map(matchKey)));
  for (const entry of volcengine.values()) {
    const record = recordFor('volcengine', entry.id);
    record.officialSeen = true;
    record.fx = FX.cnyPerUsd;
    const toUsd = value => (value === undefined ? undefined : roundFx(value / FX.cnyPerUsd));
    const bands = sealTiers(entry.bands.map(band => ({
      fromInputTokens: band.fromInputTokens,
      input: toUsd(band.inputCny),
      output: toUsd(band.outputCny),
      ...(band.cacheReadCny === undefined ? {} : { cacheRead: toUsd(band.cacheReadCny) }),
      ...(band.shortOutputCny === undefined ? {} : {
        shortOutput: {
          atMostTokens: band.shortOutputCny.atMostTokens,
          output: toUsd(band.shortOutputCny.outputCny)
        }
      })
    })));
    const first = entry.bands.find(band => band.fromInputTokens === 0) || entry.bands[0];
    record.offer('official', 'input', toUsd(first.inputCny));
    record.offer('official', 'output', toUsd(first.outputCny));
    if (first.cacheReadCny !== undefined) record.offer('official', 'cacheRead', toUsd(first.cacheReadCny));
    if (bands) record.tierSets = [{ source: 'official', tiers: bands }, ...record.tierSets.filter(set => set.source !== 'official')];
    if (entry.cacheStorageCny !== undefined) record.cacheStorage.push({ source: 'official', value: toUsd(entry.cacheStorageCny) });
    record.listPriceCny = {
      unit: 'CNY per 1M tokens',
      source: SOURCE_URLS.volcengine,
      updatedTime: volcenginePage.data?.Result?.UpdatedTime,
      bands: entry.bands.map(band => ({
        fromInputTokens: band.fromInputTokens,
        input: band.inputCny,
        output: band.outputCny,
        cacheRead: band.cacheReadCny,
        ...(band.shortOutputCny === undefined ? {} : { shortOutput: band.shortOutputCny })
      })),
      ...(entry.cacheStorageCny === undefined ? {} : { cacheStoragePerHour: entry.cacheStorageCny })
    };
  }
  sourceStats.push({ id: 'volcengine-official', url: SOURCE_URLS.volcengine, models: volcengine.size, updatedTime: volcenginePage.data?.Result?.UpdatedTime, note: `regular online inference table, CNY converted at ${FX.cnyPerUsd} CNY/USD (${FX.obtainedAt}); doubao-* only, Ark-hosted third-party SKUs skipped because their ids collide with the vendors' own` });

  // ── Helicone: Google token-hour cache storage only ──
  const heliconeStorage = collectHeliconeStorage(helicone.data);
  for (const [key, perHour] of heliconeStorage) {
    const record = records.get(`google::${key}`);
    if (!record) continue;
    record.cacheStorage.push({ source: 'helicone', value: perHour });
  }
  sourceStats.push({ id: 'helicone-registry', url: SOURCE_URLS.helicone, models: heliconeStorage.size, note: 'cacheStoragePerHour cross-check only; no Volcengine coverage' });

  // ── cloud rate cards. Read after the catalogues and the vendor pages because
  //    they attach to existing records only, and reconciled against the vendor
  //    pages before anything is arbitrated. ──
  const azureModels = parseAzureFoundry(azureItems.items);
  sourceStats.push({
    id: 'azure-retail-prices',
    url: SOURCE_URLS.azureRetail,
    models: azureModels,
    note: `${azureItems.pages} pages, ${cloudStats.azureRows} meters; global standard commercial scope only (Data Zone/Regional +10%, US Gov +25%, Batch and PP tiers excluded); price source for ${[...CLOUD_PRICE_PROVIDERS].join('/')} only, corroboration elsewhere`
  });

  const awsModels = awsRegion ? parseAwsBedrock(awsRegion.payload) : 0;
  sourceStats.push({
    id: 'aws-bedrock-price-list',
    url: awsRegion?.url || SOURCE_URLS.awsIndex,
    models: awsModels,
    publicationDate: awsRegion?.publicationDate,
    note: `${AWS_BEDROCK_REGION} offer file, ${cloudStats.awsRows} products; *_global_standard meters, the only official source carrying both Anthropic cache TTLs as separate meters`
  });

  for (const record of records.values()) reconcileCloudOfficial(record);

  // ── OpenRouter: slugs now, endpoints now, anchoring after arbitration ──
  const openRouterTargets = openRouterModels.data ? selectOpenRouterSlugs(openRouterModels.data) : [];
  const openRouterEndpoints = openRouterTargets.length ? await fetchOpenRouterEndpoints(openRouterTargets) : [];
  sourceStats.push({
    id: 'openrouter-endpoints',
    url: SOURCE_URLS.openRouterEndpoints,
    models: openRouterEndpoints.length,
    note: `per-endpoint feed only; the top-level ${SOURCE_URLS.openRouterModels} feed is read for slugs and never for a price because it quotes each model's cheapest endpoint. Cache columns only, first-party tags only, anchored against the arbitrated rate`
  });

  // ── validation ──
  for (const record of records.values()) {
    validateCacheReadRatio(record);
    validateAgainstRatioMode(record, ratioModes);
  }

  // ── pass 1: settle input/output, which the OpenRouter anchor needs ──
  const resolved = new Map();
  for (const record of records.values()) {
    const input = arbitrate(record, 'input');
    const output = arbitrate(record, 'output');
    if (!input || !output) continue;
    resolved.set(record, { input, output });
  }

  // ── pass 2: anchored cache-column gap-fill from OpenRouter ──
  for (const target of openRouterEndpoints) {
    const settled = resolved.get(target.record);
    if (!settled) continue;
    applyOpenRouterCacheFields(target.record, target.endpoints, settled.input.value, settled.output.value);
  }
  // ── pass 2b: ratio rescue for endpoints the anchor rejected on price ──
  for (const target of openRouterEndpoints) {
    const settled = resolved.get(target.record);
    if (!settled) continue;
    applyOpenRouterRatioFallback(target.record, target.endpoints, settled.input.value, settled.output.value);
    checkImplicitCachingFlag(target.record, target.endpoints);
  }

  // ── pass 3: build rules ──
  const protocolOf = new Map(PROVIDERS.map(provider => [provider.id, provider.protocol]));
  const built = [];
  for (const [record, settled] of resolved) {
    const { input, output } = settled;
    // A row priced at zero on both sides is a placeholder (free preview, an
    // unpriced modality). Emitting it would display $0.00 as a real cost.
    if (input.value === 0 && output.value === 0) continue;
    const cacheRead = arbitrateCacheField(record, 'cacheRead');
    const cacheWriteRaw = arbitrateCacheField(record, 'cacheWrite');
    const cacheWrite1h = arbitrateCacheField(record, 'cacheWrite1h');
    const tiers = arbitrateTiers(record, input.value);
    checkCloudLongContext(record, tiers?.tiers);
    const storage = record.cacheStorage.length
      ? { value: median(record.cacheStorage.map(entry => entry.value)), priceSource: record.cacheStorage.length > 1 ? 'consensus' : 'single' }
      : undefined;
    // A token-hour storage fee and a per-token write fee are mutually exclusive
    // billing models. When the vendor charges storage, a write price published by
    // an aggregator is describing something else, and keeping both would let
    // estimateCostUsd bill the cheaper one.
    const cacheWrite = storage ? undefined : cacheWriteRaw;
    if (storage && cacheWriteRaw) {
      warn('storage-vs-write', `${record.providerId}/${record.key}: dropping cacheWrite ${cacheWriteRaw.value} because the vendor bills cache as ${storage.value}/1M/hour storage`);
    }

    const priceSource = weakest([input.priceSource, output.priceSource]);
    // Top-level rates MUST mirror band 0 so a caller that ignores `tiers` still
    // reads a real published rate (pricing.ts ModelPriceTier contract).
    const band0 = tiers?.tiers[0];
    const resolvedCacheRead = pick(band0?.cacheRead, cacheRead?.value);
    const resolvedCacheWrite = storage ? undefined : pick(band0?.cacheWrite, cacheWrite?.value);
    const rule = {
      tokens: [],
      match: 'exact',
      protocol: protocolOf.get(record.providerId) || 'openai',
      input: band0 ? band0.input : input.value,
      output: band0 ? band0.output : output.value,
      ...(resolvedCacheRead === undefined ? {} : { cacheRead: resolvedCacheRead }),
      ...(resolvedCacheWrite === undefined ? {} : { cacheWrite: resolvedCacheWrite }),
      ...(cacheWrite1h === undefined || storage ? {} : { cacheWrite1h: cacheWrite1h.value }),
      // cacheWritePolicySource is 'official' only when a vendor document actually
      // states the policy. It is never asserted from the ABSENCE of a rate — that
      // inference is what produced 120 bogus official-free alibaba rules. A record
      // with a policy but no source ships the policy alone.
      ...(record.cacheWritePolicy && resolvedCacheWrite === undefined && !storage
        ? {
          cacheWritePolicy: record.cacheWritePolicy,
          ...(record.cacheWritePolicySource ? { cacheWritePolicySource: record.cacheWritePolicySource } : {})
        }
        : {}),
      ...(tiers ? { tiers: tiers.tiers } : {}),
      ...(record.peak ? { peak: record.peak } : {}),
      ...(storage ? { cacheStoragePerHour: storage.value } : {}),
      priceSource,
      // Free text, ignored by modelsDevPricing.ts (which rebuilds the rule from a
      // fixed field list). Kept so a maintainer, or the viewer's price table, can
      // see *which* official source a rate came from without re-running this tool.
      priceSourceDetail: describeProvenance(record, input, output, { cacheRead, cacheWrite, cacheWrite1h }),
      source: record.officialSeen ? 'official' : 'models.dev',
      providerId: record.providerId,
      ...(record.fx ? { fxCnyPerUsd: record.fx } : {}),
      ...(record.listPriceCny ? { listPriceCny: record.listPriceCny } : {})
    };
    detectStaleness(record, { priceSource }, officialIds);
    built.push({ record, rule });
  }

  // ── id collision resolution and expansion ──
  const byModelId = new Map();
  for (const entry of built) {
    for (const surfaceId of entry.record.surfaceIds) {
      if (!byModelId.has(surfaceId)) byModelId.set(surfaceId, []);
      byModelId.get(surfaceId).push(entry);
    }
    if (!byModelId.has(entry.record.key)) byModelId.set(entry.record.key, []);
    if (!byModelId.get(entry.record.key).includes(entry)) byModelId.get(entry.record.key).push(entry);
  }

  const rules = [];
  for (const modelId of [...byModelId.keys()].sort((a, b) => a.localeCompare(b))) {
    const owners = byModelId.get(modelId);
    let chosen = owners[0];
    if (owners.length > 1) {
      const native = nativeProviderFor(modelId);
      const preferred = owners.find(entry => entry.record.providerId === native)
        || owners.find(entry => entry.record.officialSeen);
      chosen = preferred || owners[0];
      warn('id-collision', `${modelId} is priced by ${owners.map(entry => entry.record.providerId).join(', ')}; keeping ${chosen.record.providerId} (findModelPrice matches on model id alone)`);
    }
    rules.push({ ...chosen.rule, tokens: [modelId], modelId });
  }

  if (!rules.length) throw new Error('no supported model prices survived arbitration');

  // ── write ──
  const snapshot = {
    version: 2,
    // Kept so that ModelsDevPricingCache.sourceUrl stays meaningful for the
    // runtime refresher, which still polls models.dev directly.
    sourceUrl: SOURCE_URLS.modelsDev,
    fetchedAt: new Date().toISOString(),
    ...(modelsDev.etag ? { etag: modelsDev.etag } : {}),
    sources: sourceStats,
    fx: FX,
    priority: PRICE_PRIORITY,
    audit: {
      ruleCount: rules.length,
      withTiers: rules.filter(rule => rule.tiers).length,
      withPeak: rules.filter(rule => rule.peak).length,
      withCacheStoragePerHour: rules.filter(rule => rule.cacheStoragePerHour !== undefined).length,
      withCacheRead: rules.filter(rule => rule.cacheRead !== undefined).length,
      withCacheWrite: rules.filter(rule => rule.cacheWrite !== undefined).length,
      withCacheWrite1h: rules.filter(rule => rule.cacheWrite1h !== undefined).length,
      priceSource: countBy(rules, rule => rule.priceSource),
      priceSourceDetail: countBy(rules, rule => rule.priceSourceDetail),
      cloud: {
        azure: {
          meterRows: cloudStats.azureRows,
          models: [...cloudStats.azureModels].sort(),
          priceEligible: [...cloudStats.azureModels].filter(id => CLOUD_PRICE_PROVIDERS.has(id.split('/')[0])).length,
          longContextMeters: cloudStats.azureLongContext,
          // Azure sku fragments that map to no model we price. Kept because a new
          // model usually shows up here first, and because a jump in this list is
          // how a change in Azure's naming scheme announces itself.
          unmappedSkuFragments: Object.fromEntries([...cloudStats.azureUnmapped].sort((a, b) => b[1] - a[1]).slice(0, 60))
        },
        aws: {
          productRows: cloudStats.awsRows,
          models: [...cloudStats.awsModels].sort(),
          unmappedServiceNames: [...cloudStats.awsUnmapped].sort()
        },
        longContextCorroboration: { agree: cloudStats.longContextAgree, disagree: cloudStats.longContextDisagree },
        conflicts: cloudConflicts,
        overrides: cloudOverrides
      },
      openRouter: {
        ...openRouterStats,
        filled: { ...openRouterStats.filled },
        rejectedByTag: openRouterRejections.filter(entry => entry.check === 'C1:openrouter-tag').length,
        rejectedByAnchor: openRouterRejections.filter(entry => entry.check === 'C2:openrouter-anchor').length,
        rejectedByColumnSanity: openRouterRejections.filter(entry => entry.check === 'C3:openrouter-column-sanity').length,
        rejections: openRouterRejections
      },
      /**
       * How the Alibaba cache doc classified every model on the rate card. The
       * `noSupport` group is the one that used to carry cacheWritePolicy:'free'
       * with an 'official' source; it now carries no policy, so pricing.ts resolves
       * 'unknown' and the cost reads "—" rather than a fabricated $0.
       */
      alibabaCache: {
        ...alibabaCacheStats,
        cacheWritePolicyEmitted: countBy(
          rules.filter(rule => rule.providerId === 'alibaba'),
          rule => `${rule.cacheWritePolicy || '(none)'}/${rule.cacheWritePolicySource || '(no source)'}`
        )
      },
      rejections,
      staleAlerts: staleAlerts.filter(alert => alert.severity === 'high'),
      // The 'only one catalogue prices this id' alerts are numerous and carry no
      // detail beyond the id, so they ship as a compact list.
      singleSourceIds: staleAlerts
        .filter(alert => alert.severity === 'info')
        .map(alert => `${alert.providerId}/${alert.modelId}`),
      aliasDrift,
      notes,
      warnings
    },
    rules
  };

  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    await rename(temporary, outputPath);
  } finally {
    await rm(temporary, { force: true });
  }

  report(snapshot);
}

function pick(...values) {
  return values.find(value => value !== undefined);
}

/**
 * One short string naming where each price actually came from, e.g.
 * "rate=vendor-page cacheRead=alibaba-multiplier:implicit-20pct". Only columns that
 * differ from the rate's own provenance are listed, so the common case stays one
 * token. A DERIVED value (a documented multiplier applied to the input rate, or a
 * ratio taken off a resale endpoint) always names its derivation, so it can never
 * be read back as a figure the vendor printed.
 */
function describeProvenance(record, input, output, cacheFields) {
  const rate = input.detail === output.detail ? input.detail : `${input.detail}|${output.detail}`;
  const extras = [];
  for (const [field, resolvedField] of Object.entries(cacheFields)) {
    if (!resolvedField) continue;
    const detail = record.cacheDerivation[field] ?? resolvedField.detail;
    if (detail === rate) continue;
    extras.push(`${field}=${detail}`);
  }
  return extras.length ? `rate=${rate} ${extras.join(' ')}` : `rate=${rate}`;
}

function weakest(levels) {
  if (levels.includes('single')) return 'single';
  if (levels.includes('consensus')) return 'consensus';
  return 'official';
}

function countBy(items, keyOf) {
  const out = {};
  for (const item of items) {
    const key = keyOf(item) || '(none)';
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function report(snapshot) {
  const { audit } = snapshot;
  console.log(`\nWrote ${relative(projectRoot, outputPath)}`);
  console.log(`  rules                     ${audit.ruleCount}`);
  console.log(`  with tiers                ${audit.withTiers}`);
  console.log(`  with peak schedule        ${audit.withPeak}`);
  console.log(`  with cacheStoragePerHour  ${audit.withCacheStoragePerHour}`);
  console.log(`  with cacheRead            ${audit.withCacheRead}`);
  console.log(`  with cacheWrite           ${audit.withCacheWrite}`);
  console.log(`  with cacheWrite1h         ${audit.withCacheWrite1h}`);
  console.log(`  priceSource               ${JSON.stringify(audit.priceSource)}`);
  const { azure, aws } = audit.cloud;
  console.log(`  azure                     ${azure.models.length} models mapped from ${azure.meterRows} meters (${azure.priceEligible} price-eligible, ${azure.longContextMeters} long-context meters)`);
  console.log(`  aws bedrock               ${aws.models.length} models mapped from ${aws.productRows} products`);
  console.log(`  cloud conflicts           ${audit.cloud.conflicts.length}`);
  for (const conflict of audit.cloud.conflicts) {
    console.log(`    ${conflict.providerId}/${conflict.modelId} via ${conflict.source}: input ${conflict.cloudInput} vs ${conflict.referenceInput} (${conflict.inputDelta}) — ${conflict.resolution}`);
  }
  console.log(`  cloud overrides           ${audit.cloud.overrides.length} (cloud adopted where the catalogues had no consensus)`);
  for (const entry of audit.cloud.overrides) {
    console.log(`    ${entry.providerId}/${entry.modelId} via ${entry.source}: ${entry.cloudInput}/${entry.cloudOutput} adopted over ${entry.catalogueInput.join(',')} | ${entry.catalogueOutput.join(',')}`);
  }
  const or = audit.openRouter;
  console.log(`  openrouter                ${or.fetched}/${or.slugs} slugs fetched (${or.failed} failed), ${or.endpoints} endpoints seen, ${or.firstParty} first-party, ${or.anchored} anchored`);
  console.log(`    filled                  cacheRead ${or.filled.cacheRead}, cacheWrite ${or.filled.cacheWrite}, cacheWrite1h ${or.filled.cacheWrite1h}; ${or.corroborated} columns corroborated`);
  console.log(`    rejected                ${or.rejectedByTag} by tag, ${or.rejectedByAnchor} by anchor, ${or.rejectedByColumnSanity} by column sanity`);
  for (const entry of or.rejections.filter(item => item.check === 'C2:openrouter-anchor').slice(0, 8)) {
    console.log(`      [anchor] ${entry.providerId}/${entry.modelId} tag=${entry.tag} ${entry.endpointInput}/${entry.endpointOutput} vs ${entry.arbitratedInput}/${entry.arbitratedOutput}`);
  }
  console.log(`    ratio path              ${or.ratioFilled.length} filled, ${or.ratioCorroborated.length} corroborated, ${or.ratioDisagreement.length} disagreed, ${or.ratioBlockedByDoc.length} blocked by the vendor doc`);
  for (const entry of [...or.ratioFilled, ...or.ratioCorroborated].slice(0, 8)) {
    console.log(`      ${entry.providerId}/${entry.modelId} ${entry.field}: ${entry.ratio}x of ${entry.arbitratedInput} = ${entry.value}${entry.current === undefined ? '' : ` (have ${entry.current})`} from ${entry.endpointValue}/${entry.endpointInput} via ${entry.tag}`);
  }
  for (const entry of or.ratioDisagreement.slice(0, 6)) {
    console.log(`      [ratio-disagrees] ${entry.providerId}/${entry.modelId} ${entry.field}: ${entry.value} vs kept ${entry.current}`);
  }
  console.log(`    dated slugs adopted     ${or.dateAliasResolved.length}${or.dateAliasResolved.length ? `: ${or.dateAliasResolved.slice(0, 6).map(e => `${e.modelId}<-${e.slug}`).join(', ')}` : ''}`);
  const ac = audit.alibabaCache;
  console.log(`  alibaba cache doc         explicit-only ${ac.explicitOnly}, implicit-only ${ac.implicitOnly}, both ${ac.both}, no-support ${ac.noSupport} (of which hit-unpublished ${ac.unpublishedHit})`);
  console.log(`    policy emitted          ${JSON.stringify(ac.cacheWritePolicyEmitted)}`);
  console.log(`    other-region scope      ${ac.otherRegionScope.length}${ac.otherRegionScope.length ? `: ${ac.otherRegionScope.slice(0, 8).join(', ')}` : ''}`);
  console.log(`    page hint w/o doc list  ${ac.pageHintWithoutDocSupport.length}${ac.pageHintWithoutDocSupport.length ? `: ${ac.pageHintWithoutDocSupport.slice(0, 8).join(', ')}` : ''}`);
  console.log(`    implicit-flag check     ${ac.implicitFlagAgreements} agree, ${ac.implicitFlagDisagreement.length} disagree (doc wins)`);
  console.log(`  validation rejections     ${audit.rejections.length}`);
  for (const entry of audit.rejections) {
    console.log(`    [${entry.check}] ${entry.providerId}/${entry.modelId} ${entry.field}=${entry.value} (ratio ${entry.ratio}) via ${entry.source} — ${entry.reason}`);
  }
  const high = audit.staleAlerts;
  console.log(`  stale alerts (high)       ${high.length}; single-source ids ${audit.singleSourceIds.length}`);
  for (const alert of high) console.log(`    ${alert.providerId}/${alert.modelId}: ${alert.reason}`);
  console.log(`  alias declarations        ${audit.aliasDrift.length}`);
  console.log(`  warnings                  ${audit.warnings.length}`);
  for (const entry of audit.warnings.slice(0, 40)) console.log(`    [${entry.kind}] ${entry.message}`);
  if (audit.warnings.length > 40) console.log(`    …and ${audit.warnings.length - 40} more (see audit.warnings in the asset)`);
}

await main();
