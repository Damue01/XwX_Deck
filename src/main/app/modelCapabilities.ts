import { isRecord } from '../shared/obj';
import { readTextOrUndefined, writeFileAtomic } from '../shared/fsx';
import type {
  ModelCapabilityField,
  ModelCapabilitySource,
  ModelCatalogEntry
} from './modelCatalog';
import { findBuiltInModelCapability } from './builtInModelCapabilityRegistry';
import { findOfficialModelRecord } from './officialModelRegistry';
import { findProbedModelCapability } from './probedModelCapabilityRegistry';

type JsonFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface Capability {
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly inputModalities?: readonly string[];
  readonly vision?: boolean;
  readonly reasoning?: boolean;
  readonly levels?: readonly string[];
  readonly defaultLevel?: string;
  readonly toolCalling?: boolean;
  readonly structuredOutput?: boolean;
  readonly interleavedThinking?: boolean;
}

interface IndexedCapability {
  readonly sourceId: string;
  readonly providerId?: string;
  readonly capability: Capability;
}

interface CapabilityIndex {
  readonly exact: Map<string, IndexedCapability[]>;
  readonly bare: Map<string, IndexedCapability[]>;
  readonly canonical: Map<string, IndexedCapability[]>;
}

interface ResolvedCapability {
  readonly capability: Capability;
  readonly source: ModelCapabilitySource;
}

const MODELS_DEV_URL = 'https://models.dev/api.json';
const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const REMOTE_TIMEOUT_MS = 12_000;
const FALLBACK_CONTEXT_WINDOW = 262_144;
const FALLBACK_MAX_OUTPUT_TOKENS = 8_192;
const CAPABILITY_FIELDS: readonly ModelCapabilityField[] = [
  'contextWindow',
  'maxOutputTokens',
  'vision',
  'reasoning',
  'toolCalling',
  'structuredOutput',
  'interleavedThinking'
];

let remoteCache: RemoteCapabilities | undefined;
let remoteLoad: {
  readonly forceNetworkRefresh: boolean;
  readonly promise: Promise<RemoteCapabilities>;
} | undefined;

interface RemoteCapabilities {
  readonly modelsDev: CapabilityIndex;
  readonly litellm: CapabilityIndex;
}

interface SerializedCapabilityEntry {
  readonly modelId: string;
  readonly sourceId: string;
  readonly providerId?: string;
  readonly capability: Capability;
}

interface SerializedRemoteCapabilities {
  readonly version: 1;
  readonly savedAt: string;
  readonly modelsDev: readonly SerializedCapabilityEntry[];
  readonly litellm: readonly SerializedCapabilityEntry[];
}

/**
 * Enriches service-discovered model ids field by field. The 兼容服务 fetch
 * path strips per-model capability metadata before reaching this layer;
 * release-bundled/official data and last-known-good aggregators own abilities.
 */
export async function enrichModelCatalog(
  entries: readonly ModelCatalogEntry[],
  fetcher: JsonFetcher = fetch,
  cachePath?: string
): Promise<ModelCatalogEntry[]> {
  const remote = await loadRemoteCapabilities(fetcher, cachePath, true);
  return entries.map(entry => enrichEntry(entry, remote));
}

/**
 * Startup/UI path: use the last successful capability snapshot immediately and
 * refresh models.dev/LiteLLM in the background. Model discovery must not wait
 * up to two remote-catalog timeouts before names become selectable.
 */
export async function enrichModelCatalogCacheFirst(
  entries: readonly ModelCatalogEntry[],
  fetcher: JsonFetcher = fetch,
  cachePath?: string
): Promise<ModelCatalogEntry[]> {
  const cached = remoteCache
    ?? (cachePath ? await readRemoteCapabilityCache(cachePath) : undefined);
  if (cached && hasRemoteCapabilities(cached)) {
    return entries.map(entry => enrichEntry(entry, cached));
  }
  // A clean install has no last-known-good capability snapshot. Wait for the
  // bounded remote load instead of publishing a fallback directory and
  // launching an orphan background task that cannot republish downstream
  // 兼容服务/Codex catalogs when it later succeeds.
  const loaded = await loadRemoteCapabilities(fetcher, cachePath, true);
  return entries.map(entry => enrichEntry(entry, loaded));
}

function enrichEntry(entry: ModelCatalogEntry, remote: RemoteCapabilities): ModelCatalogEntry {
  const officialRecord = findOfficialModelRecord(entry.id);
  const official = officialCapability(entry.id);
  const probed = probedCapability(entry.id);
  const modelsDev = resolveCapability(remote.modelsDev, entry.id, 'models.dev');
  // LiteLLM is a per-field fallback when models.dev leaves a disputed field
  // unknown. It still has to pass the same conservative matching rules.
  const litellm = resolveCapability(remote.litellm, entry.id, 'litellm');
  const builtin = builtinCapability(entry.id);
  const sources: Partial<Record<ModelCapabilityField, ModelCapabilitySource>> = {
    ...(entry.capabilitySources ?? {})
  };
  const cachedValue = <T>(field: ModelCapabilityField, value: T | undefined): T | undefined => (
    sources[field] === 'fallback' ? undefined : value
  );
  // Source-tagged values restored from the v2 capability cache remain usable
  // as a fast baseline. Fresh 兼容服务 discovery is identity/protocol-only and
  // therefore reaches this function without untrusted ability fields.
  if (entry.contextWindow !== undefined) sources.contextWindow ??= 'compatible';
  if (entry.maxOutputTokens !== undefined) sources.maxOutputTokens ??= 'compatible';
  if (entry.inputModalities?.length) sources.inputModalities ??= 'compatible';
  if (entry.vision !== undefined) sources.vision ??= 'compatible';
  if (entry.reasoning !== undefined || entry.reasoningLevels?.length) sources.reasoning ??= 'compatible';
  if (entry.toolCalling !== undefined) sources.toolCalling ??= 'compatible';
  if (entry.structuredOutput !== undefined) sources.structuredOutput ??= 'compatible';
  if (entry.interleavedThinking !== undefined) sources.interleavedThinking ??= 'compatible';

  const resolvedContextWindow = firstDefined(
    cachedValue('contextWindow', entry.contextWindow),
    takeNumber(official, 'contextWindow', sources),
    takeNumber(modelsDev, 'contextWindow', sources),
    takeNumber(litellm, 'contextWindow', sources),
    takeNumber(builtin, 'contextWindow', sources)
  );
  const contextWindow = resolvedContextWindow ?? FALLBACK_CONTEXT_WINDOW;
  if (resolvedContextWindow === undefined) sources.contextWindow = 'fallback';

  const resolvedMaxOutputTokens = firstDefined(
    cachedValue('maxOutputTokens', entry.maxOutputTokens),
    takeNumber(official, 'maxOutputTokens', sources),
    takeNumber(modelsDev, 'maxOutputTokens', sources),
    takeNumber(litellm, 'maxOutputTokens', sources),
    takeNumber(builtin, 'maxOutputTokens', sources)
  );
  const maxOutputTokens = resolvedMaxOutputTokens ?? FALLBACK_MAX_OUTPUT_TOKENS;
  if (resolvedMaxOutputTokens === undefined) sources.maxOutputTokens = 'fallback';

  const resolvedVision = firstDefined(
    cachedValue('vision', entry.vision),
    takeBoolean(official, 'vision', sources),
    takeBoolean(modelsDev, 'vision', sources),
    takeBoolean(litellm, 'vision', sources),
    takeBoolean(builtin, 'vision', sources)
  );
  const vision = resolvedVision ?? false;
  if (resolvedVision === undefined) sources.vision = 'fallback';

  const resolvedReasoning = firstDefined(
    cachedValue('reasoning', entry.reasoning),
    takeBoolean(official, 'reasoning', sources),
    // A gateway measurement beats a directory's guess: several ids the
    // aggregators mark non-reasoning demonstrably emit reasoning tokens, and
    // letting the guess win left their Codex effort picker empty.
    takeBoolean(probed, 'reasoning', sources),
    takeBoolean(modelsDev, 'reasoning', sources),
    takeBoolean(litellm, 'reasoning', sources),
    takeBoolean(builtin, 'reasoning', sources)
  );
  const reasoning = resolvedReasoning ?? false;
  if (resolvedReasoning === undefined) sources.reasoning = 'fallback';

  const resolvedToolCalling = firstDefined(
    cachedValue('toolCalling', entry.toolCalling),
    takeBoolean(official, 'toolCalling', sources),
    takeBoolean(modelsDev, 'toolCalling', sources),
    takeBoolean(litellm, 'toolCalling', sources),
    takeBoolean(builtin, 'toolCalling', sources)
  );
  // Unknown tool support is operationally attempted. This value controls
  // compatibility behavior only; it never blocks model selection.
  const toolCalling = resolvedToolCalling ?? true;
  if (resolvedToolCalling === undefined) sources.toolCalling = 'fallback';

  const resolvedStructuredOutput = firstDefined(
    cachedValue('structuredOutput', entry.structuredOutput),
    takeBoolean(official, 'structuredOutput', sources),
    takeBoolean(modelsDev, 'structuredOutput', sources),
    takeBoolean(litellm, 'structuredOutput', sources)
  );
  const structuredOutput = resolvedStructuredOutput ?? false;
  if (resolvedStructuredOutput === undefined) sources.structuredOutput = 'fallback';

  const resolvedInterleavedThinking = firstDefined(
    cachedValue('interleavedThinking', entry.interleavedThinking),
    takeBoolean(official, 'interleavedThinking', sources),
    takeBoolean(modelsDev, 'interleavedThinking', sources),
    takeBoolean(litellm, 'interleavedThinking', sources)
  );
  const interleavedThinking = resolvedInterleavedThinking ?? false;
  if (resolvedInterleavedThinking === undefined) sources.interleavedThinking = 'fallback';

  const resolvedInputModalities = cachedValue('inputModalities', entry.inputModalities)
    ?? official?.capability.inputModalities
    ?? modelsDev?.capability.inputModalities
    ?? litellm?.capability.inputModalities
    ?? builtin?.capability.inputModalities;
  const inputModalities = resolvedInputModalities?.length ? unique(resolvedInputModalities) : ['text'];
  if (cachedValue('inputModalities', entry.inputModalities)) sources.inputModalities ??= 'compatible';
  else if (official?.capability.inputModalities) sources.inputModalities = 'official';
  else if (modelsDev?.capability.inputModalities) sources.inputModalities = 'models.dev';
  else if (litellm?.capability.inputModalities) sources.inputModalities = 'litellm';
  else if (builtin?.capability.inputModalities) sources.inputModalities = 'builtin';
  else sources.inputModalities = 'fallback';
  if (vision && !inputModalities.includes('image')) {
    inputModalities.push('image');
    if (sources.inputModalities === 'fallback') {
      sources.inputModalities = sources.vision ?? 'builtin';
    }
  }

  const thirdPartyLevels = official?.capability.levels
    ?? modelsDev?.capability.levels
    ?? litellm?.capability.levels
    ?? builtin?.capability.levels;
  const reasoningLevels = entry.reasoningLevels?.length
    ? unique(entry.reasoningLevels)
    : reasoning === true && thirdPartyLevels?.length
      ? unique(thirdPartyLevels)
      : undefined;
  if (entry.reasoningLevels?.length) sources.reasoning ??= 'compatible';
  else if (reasoningLevels?.length) sources.reasoning ??= official?.capability.levels
    ? 'official'
    : modelsDev?.capability.levels
      ? 'models.dev'
      : litellm?.capability.levels
        ? 'litellm'
        : 'builtin';
  const defaultReasoningLevel = entry.defaultReasoningLevel && reasoningLevels?.includes(entry.defaultReasoningLevel)
    ? entry.defaultReasoningLevel
    : (official?.capability.defaultLevel
      ?? modelsDev?.capability.defaultLevel
      ?? litellm?.capability.defaultLevel
      ?? builtin?.capability.defaultLevel)
      ?? (reasoningLevels?.includes('medium') ? 'medium' : reasoningLevels?.[0]);

  const missingCapabilities = CAPABILITY_FIELDS.filter(field => valueForField({
    contextWindow: resolvedContextWindow,
    maxOutputTokens: resolvedMaxOutputTokens,
    inputModalities,
    vision: resolvedVision,
    reasoning: resolvedReasoning,
    toolCalling: resolvedToolCalling,
    structuredOutput: resolvedStructuredOutput,
    interleavedThinking: resolvedInterleavedThinking
  }, field) === undefined);
  return {
    ...entry,
    vendor: officialRecord && (entry.vendor === '兼容服务' || entry.vendor === '其他')
      ? officialRecord.vendor
      : entry.vendor,
    contextWindow,
    maxOutputTokens,
    inputModalities: unique(inputModalities),
    vision,
    reasoning,
    ...(reasoningLevels?.length ? { reasoningLevels } : {}),
    ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
    toolCalling,
    structuredOutput,
    interleavedThinking,
    capabilitySources: sources,
    missingCapabilities
  };
}

function takeValue(
  resolved: ResolvedCapability | undefined,
  field: keyof Capability,
  sources: Partial<Record<ModelCapabilityField, ModelCapabilitySource>>
): Capability[keyof Capability] | undefined {
  const value = resolved?.capability[field];
  if (value !== undefined && resolved) {
    const catalogField = field === 'levels' || field === 'defaultLevel' ? 'reasoning' : field as ModelCapabilityField;
    if (sources[catalogField] === undefined || sources[catalogField] === 'fallback') {
      sources[catalogField] = resolved.source;
    }
  }
  return value;
}

function takeNumber(
  resolved: ResolvedCapability | undefined,
  field: 'contextWindow' | 'maxOutputTokens',
  sources: Partial<Record<ModelCapabilityField, ModelCapabilitySource>>
): number | undefined {
  const value = takeValue(resolved, field, sources);
  return typeof value === 'number' ? value : undefined;
}

function takeBoolean(
  resolved: ResolvedCapability | undefined,
  field: 'vision' | 'reasoning' | 'toolCalling' | 'structuredOutput' | 'interleavedThinking',
  sources: Partial<Record<ModelCapabilityField, ModelCapabilitySource>>
): boolean | undefined {
  const value = takeValue(resolved, field, sources);
  return typeof value === 'boolean' ? value : undefined;
}

async function loadRemoteCapabilities(
  fetcher: JsonFetcher,
  cachePath?: string,
  forceNetworkRefresh = false
): Promise<RemoteCapabilities> {
  const isDefault = fetcher === fetch;
  if (isDefault && remoteCache && !forceNetworkRefresh) return remoteCache;
  const inflight = remoteLoad;
  if (isDefault && inflight) {
    if (!forceNetworkRefresh || inflight.forceNetworkRefresh) return inflight.promise;
    await inflight.promise.catch(() => undefined);
    if (remoteLoad === inflight) remoteLoad = undefined;
  }
  const load = (async (): Promise<RemoteCapabilities> => {
    const cached = cachePath
      ? await readRemoteCapabilityCache(cachePath)
      : undefined;
    const [modelsDev, lite] = await Promise.allSettled([
      fetchJson(MODELS_DEV_URL, fetcher),
      fetchJson(LITELLM_URL, fetcher)
    ]);
    const modelsDevIndex = modelsDev.status === 'fulfilled'
      ? createIndex()
      : cached?.modelsDev ?? createIndex();
    const litellmIndex = lite.status === 'fulfilled'
      ? createIndex()
      : cached?.litellm ?? createIndex();
    if (modelsDev.status === 'fulfilled') parseModelsDev(modelsDev.value, modelsDevIndex);
    if (lite.status === 'fulfilled') parseLiteLLM(lite.value, litellmIndex);
    const result = { modelsDev: modelsDevIndex, litellm: litellmIndex };
    if (cachePath && (modelsDev.status === 'fulfilled' || lite.status === 'fulfilled')) {
      await writeRemoteCapabilityCache(cachePath, result).catch(() => undefined);
    }
    return result;
  })();
  const activeLoad = { forceNetworkRefresh, promise: load };
  if (isDefault) remoteLoad = activeLoad;
  try {
    const result = await load;
    // A partial result is still a valid last-known-good snapshot because each
    // failed source is filled from its own disk cache. Strong refreshes ignore
    // this memory snapshot and retry the network on the next invalidation.
    if (isDefault) remoteCache = result;
    return result;
  } finally {
    if (isDefault && remoteLoad === activeLoad) remoteLoad = undefined;
  }
}

function emptyRemoteCapabilities(): RemoteCapabilities {
  return {
    modelsDev: createIndex(),
    litellm: createIndex()
  };
}

function hasRemoteCapabilities(remote: RemoteCapabilities): boolean {
  return remote.modelsDev.exact.size > 0 || remote.litellm.exact.size > 0;
}

async function fetchJson(url: string, fetcher: JsonFetcher): Promise<unknown> {
  const response = await fetcher(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

async function readRemoteCapabilityCache(file: string): Promise<RemoteCapabilities | undefined> {
  const text = await readTextOrUndefined(file);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as Partial<SerializedRemoteCapabilities>;
    if (parsed.version !== 1 || !Array.isArray(parsed.modelsDev) || !Array.isArray(parsed.litellm)) return undefined;
    return {
      modelsDev: deserializeCapabilityIndex(parsed.modelsDev),
      litellm: deserializeCapabilityIndex(parsed.litellm)
    };
  } catch {
    return undefined;
  }
}

async function writeRemoteCapabilityCache(file: string, remote: RemoteCapabilities): Promise<void> {
  const modelsDev = serializeCapabilityIndex(remote.modelsDev);
  const litellm = serializeCapabilityIndex(remote.litellm);
  const existing = await readTextOrUndefined(file);
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as Partial<SerializedRemoteCapabilities>;
      if (
        parsed.version === 1
        && Array.isArray(parsed.modelsDev)
        && Array.isArray(parsed.litellm)
        && JSON.stringify(parsed.modelsDev) === JSON.stringify(modelsDev)
        && JSON.stringify(parsed.litellm) === JSON.stringify(litellm)
      ) {
        return;
      }
    } catch {
      // A damaged cache is replaced below.
    }
  }
  const value: SerializedRemoteCapabilities = {
    version: 1,
    savedAt: new Date().toISOString(),
    modelsDev,
    litellm
  };
  await writeFileAtomic(file, `${JSON.stringify(value)}\n`);
}

function serializeCapabilityIndex(index: CapabilityIndex): SerializedCapabilityEntry[] {
  const out: SerializedCapabilityEntry[] = [];
  for (const [modelId, entries] of index.exact) {
    for (const entry of entries) {
      out.push({
        modelId,
        sourceId: entry.sourceId,
        ...(entry.providerId ? { providerId: entry.providerId } : {}),
        capability: entry.capability
      });
    }
  }
  return out;
}

function deserializeCapabilityIndex(values: readonly unknown[]): CapabilityIndex {
  const index = createIndex();
  for (const value of values) {
    if (!isRecord(value) || typeof value.modelId !== 'string' || typeof value.sourceId !== 'string') continue;
    if (!isRecord(value.capability)) continue;
    addToIndex(
      index,
      value.sourceId,
      value.modelId,
      value.capability as Capability,
      typeof value.providerId === 'string' ? value.providerId : undefined
    );
  }
  return index;
}

function parseModelsDev(value: unknown, index: CapabilityIndex): void {
  if (!isRecord(value)) return;
  for (const [providerId, provider] of Object.entries(value)) {
    if (!isRecord(provider) || !isRecord(provider.models)) continue;
    for (const [id, raw] of Object.entries(provider.models)) {
      if (!isRecord(raw)) continue;
      const reasoning = isRecord(raw.reasoning) ? raw.reasoning : undefined;
      const options = Array.isArray(raw.reasoning_options)
        ? raw.reasoning_options
        : reasoning ? reasoningOptions(reasoning) : [];
      const levels = options.flatMap(item => {
        if (typeof item === 'string') return [item.toLowerCase()];
        if (!isRecord(item) || !Array.isArray(item.values)) return [];
        return item.values.filter((item): item is string => typeof item === 'string').map(item => item.toLowerCase());
      });
      const limit = isRecord(raw.limit) ? raw.limit : undefined;
      const modalities = modalitiesFrom(raw.modalities);
      const capability: Capability = {
        ...(positiveInt(limit?.context) ? { contextWindow: positiveInt(limit?.context) } : {}),
        ...(positiveInt(limit?.output) ? { maxOutputTokens: positiveInt(limit?.output) } : {}),
        ...(modalities.length ? { inputModalities: modalities, vision: modalities.some(isVisionModality) } : {}),
        ...(typeof raw.reasoning === 'boolean' ? { reasoning: raw.reasoning } : {}),
        ...(levels.length ? { levels: unique(levels) } : {}),
        ...(typeof raw.tool_call === 'boolean' ? { toolCalling: raw.tool_call } : {}),
        ...(typeof raw.structured_output === 'boolean' ? { structuredOutput: raw.structured_output } : {}),
        ...(typeof raw.interleaved === 'boolean' ? { interleavedThinking: raw.interleaved } : {})
      };
      if (Object.keys(capability).length) addToIndex(index, `${providerId}/${id}`, id, capability, providerId);
    }
  }
}

function parseLiteLLM(value: unknown, index: CapabilityIndex): void {
  if (!isRecord(value)) return;
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const levels = raw.supports_reasoning === true
      ? raw.supports_xhigh_reasoning_effort === true
        ? ['none', 'low', 'medium', 'high', 'xhigh']
        : ['low', 'medium', 'high']
      : [];
    const capability: Capability = {
      ...(positiveInt(raw.max_input_tokens) ? { contextWindow: positiveInt(raw.max_input_tokens) } : {}),
      ...(positiveInt(raw.max_output_tokens) ? { maxOutputTokens: positiveInt(raw.max_output_tokens) } : {}),
      ...(raw.supports_vision === true ? { vision: true, inputModalities: ['text', 'image'] } : {}),
      ...(typeof raw.supports_reasoning === 'boolean' ? { reasoning: raw.supports_reasoning } : {}),
      ...(levels.length ? { levels } : {}),
      ...(typeof raw.supports_function_calling === 'boolean' ? { toolCalling: raw.supports_function_calling } : {}),
      ...(typeof raw.supports_response_schema === 'boolean' ? { structuredOutput: raw.supports_response_schema } : {})
    };
    if (Object.keys(capability).length) addToIndex(index, id, id, capability);
  }
}

function createIndex(): CapabilityIndex {
  return { exact: new Map(), bare: new Map(), canonical: new Map() };
}

function addToIndex(
  index: CapabilityIndex,
  sourceId: string,
  modelId: string,
  capability: Capability,
  providerId?: string
): void {
  const entry = { sourceId, providerId: providerId ? normalizeId(providerId) : undefined, capability };
  const normalized = normalizeId(modelId);
  if (!normalized) return;
  add(index.exact, normalized, entry);
  const bare = bareId(normalized);
  if (bare) add(index.bare, bare, entry);
  const canonical = canonicalId(bare);
  if (canonical) add(index.canonical, canonical, entry);
}

function add(map: Map<string, IndexedCapability[]>, key: string, entry: IndexedCapability): void {
  const values = map.get(key) ?? [];
  if (!values.some(value => value.sourceId === entry.sourceId)) values.push(entry);
  map.set(key, values);
}

function resolveCapability(index: CapabilityIndex, id: string, source: ModelCapabilitySource): ResolvedCapability | undefined {
  const normalized = normalizeId(id);
  const candidates = [
    index.exact.get(normalized),
    index.bare.get(bareId(normalized)),
    index.canonical.get(canonicalId(bareId(normalized)))
  ];
  for (const matches of candidates) {
    const preferred = preferredProviderMatches(matches, normalized);
    const preferredCapability = consensusCapability(preferred);
    const sharedCapability = consensusCapability(matches);
    const capability = mergeCapabilities(preferredCapability, sharedCapability);
    if (capability) return { capability, source };
  }
  return undefined;
}

/**
 * models.dev contains a model under several serving routes. A field is usable
 * from the model owner's provider first. Serving-route limits often describe
 * the reseller rather than the model itself, so treating every reseller as
 * equally authoritative would erase otherwise reliable 1M context metadata.
 * Models without a known owner still require cross-route consensus.
 */
function preferredProviderMatches(
  matches: readonly IndexedCapability[] | undefined,
  modelId: string
): IndexedCapability[] | undefined {
  if (!matches?.length) return undefined;
  for (const providerId of preferredProviderIds(bareId(modelId))) {
    const preferred = matches.filter(item => item.providerId === providerId);
    if (preferred.length) return preferred;
  }
  return undefined;
}

function preferredProviderIds(modelId: string): readonly string[] {
  const canonical = canonicalId(modelId);
  if (/^(?:gpt|o[1-9])/.test(canonical)) return ['openai'];
  if (/^(?:glm|chatglm)/.test(canonical)) return ['zhipuai', 'zai'];
  if (/^qwen/.test(canonical)) return ['alibaba', 'alibaba-cn'];
  if (/^deepseek/.test(canonical)) return ['deepseek'];
  if (/^(?:kimi|moonshot)/.test(canonical)) return ['moonshotai', 'moonshotai-cn'];
  if (/^minimax/.test(canonical)) return ['minimax', 'minimax-cn'];
  if (/^(?:doubao|seed)/.test(canonical)) return ['volcengine', 'volcengine-cn'];
  if (/^grok/.test(canonical)) return ['xai'];
  if (/^(?:claude)/.test(canonical)) return ['anthropic'];
  if (/^(?:gemini)/.test(canonical)) return ['google'];
  return [];
}

function consensusCapability(matches: readonly IndexedCapability[] | undefined): Capability | undefined {
  if (!matches?.length) return undefined;
  // Serving routes may impose different limits on the same exact model id.
  // When no owner record settles the value, the smallest published limit is
  // the only value that is safe across every matching route.
  const contextWindow = minimumPositive(matches, item => item.capability.contextWindow);
  const maxOutputTokens = minimumPositive(matches, item => item.capability.maxOutputTokens);
  const inputModalities = consensus(matches, item => item.capability.inputModalities);
  const vision = consensus(matches, item => item.capability.vision);
  const reasoning = consensus(matches, item => item.capability.reasoning);
  const levels = consensus(matches, item => item.capability.levels);
  const defaultLevel = consensus(matches, item => item.capability.defaultLevel);
  const toolCalling = consensus(matches, item => item.capability.toolCalling);
  const structuredOutput = consensus(matches, item => item.capability.structuredOutput);
  const interleavedThinking = consensus(matches, item => item.capability.interleavedThinking);
  const capability: Capability = {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(inputModalities !== undefined ? { inputModalities } : {}),
    ...(vision !== undefined ? { vision } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(levels !== undefined ? { levels } : {}),
    ...(defaultLevel !== undefined ? { defaultLevel } : {}),
    ...(toolCalling !== undefined ? { toolCalling } : {}),
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    ...(interleavedThinking !== undefined ? { interleavedThinking } : {})
  };
  return Object.keys(capability).length ? capability : undefined;
}

function minimumPositive(
  matches: readonly IndexedCapability[],
  get: (item: IndexedCapability) => number | undefined
): number | undefined {
  const values = matches.map(get).filter((value): value is number => (
    typeof value === 'number' && Number.isFinite(value) && value > 0
  ));
  return values.length ? Math.min(...values) : undefined;
}

function mergeCapabilities(
  preferred: Capability | undefined,
  shared: Capability | undefined
): Capability | undefined {
  if (!preferred) return shared;
  if (!shared) return preferred;
  return {
    ...shared,
    ...preferred
  };
}

function consensus<T>(
  matches: readonly IndexedCapability[],
  get: (item: IndexedCapability) => T | undefined
): T | undefined {
  const values = matches.map(get).filter((value): value is T => value !== undefined);
  if (!values.length) return undefined;
  const first = JSON.stringify(values[0]);
  return values.every(value => JSON.stringify(value) === first) ? values[0] : undefined;
}

/**
 * Small, reviewable overlays for capabilities stated by model-owner docs but
 * missing or stale in third-party catalogs. These never override metadata
 * explicitly returned by 兼容服务.
 */
function officialCapability(id: string): ResolvedCapability | undefined {
  const record = findOfficialModelRecord(id);
  return record ? { source: 'official', capability: record.capability } : undefined;
}

/**
 * Direct observation of the configured gateway. Ranked below a cited
 * model-owner page but above the aggregator directories, which only report what
 * some catalog believes rather than what this serving path does.
 */
function probedCapability(id: string): ResolvedCapability | undefined {
  const record = findProbedModelCapability(id);
  if (!record || record.reasoning === undefined) return undefined;
  return { source: 'probed', capability: { reasoning: record.reasoning } };
}

function builtinCapability(id: string): ResolvedCapability | undefined {
  const value = normalizeId(id);
  let capability: Capability = {};
  const registered = findBuiltInModelCapability(value);
  if (registered) capability = { ...capability, ...registered };
  // Minimal forced-function calls against the active 兼容服务 Chat/Responses
  // routes returned real tool_calls for these private or not-yet-indexed ids
  // on 2026-07-28. No context/output limit is inferred from that probe.
  if ([
    'codex-auto-review',
    'gui-plus',
    'doubao-seed-1-6-vision',
    'doubao-seed-2-1-pro',
    'doubao-seed-2-1-turbo',
    'doubao-seed-character'
  ].includes(value)) {
    capability = { ...capability, toolCalling: true };
  }
  if (/^gpt-5(?:[.-]|$)/.test(value)) {
    capability = {
      ...capability,
      reasoning: true,
      levels: ['none', 'low', 'medium', 'high', 'xhigh']
    };
  } else if (/^(?:o[1-4]|deepseek-reasoner|deepseek-r1)(?:[.-]|$)/.test(value)) {
    capability = { ...capability, reasoning: true, levels: ['low', 'medium', 'high'] };
  }
  return Object.keys(capability).length ? { source: 'builtin', capability } : undefined;
}

function reasoningOptions(value: Record<string, unknown>): unknown[] {
  return Array.isArray(value.options) ? value.options : Array.isArray(value.effort) ? value.effort : [];
}

function modalitiesFrom(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.input)) return [];
  return value.input.filter((item): item is string => typeof item === 'string').map(item => item.toLowerCase());
}

function isVisionModality(value: string): boolean {
  return /image|pdf|vision/i.test(value);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase().replace(/^models\//, '');
}

function bareId(value: string): string {
  const slash = value.lastIndexOf('/');
  return slash === -1 ? value : value.slice(slash + 1);
}

function canonicalId(value: string): string {
  return value.replace(/[^a-z0-9]/g, '');
}

function firstDefined<T>(...values: readonly (T | undefined)[]): T | undefined {
  return values.find((value): value is T => value !== undefined);
}

function valueForField(value: Partial<Record<ModelCapabilityField, unknown>>, field: ModelCapabilityField): unknown {
  return value[field];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
