import { createHash } from 'crypto';
import * as path from 'path';
import { isRecord } from '../shared/obj';
import { readTextOrUndefined, writeFileAtomic } from '../shared/fsx';
import { enrichModelCatalog, enrichModelCatalogCacheFirst } from './modelCapabilities';
import type { ProviderModelCatalogMode, ProviderPresetId } from '../../shared/providerProfiles';
import { detectProviderPreset } from '../../shared/providerProfiles';
import { buildProviderModelUrlCandidates } from './providerDiscovery';

export type ModelProtocol = 'anthropic-messages' | 'openai-responses' | 'chat-completions' | 'gemini';
export type ModelClient = 'claude' | 'codex';
export type ModelCatalogEndpointKind = 'openai' | 'anthropic' | 'gemini';
export type ModelCapabilitySource = 'compatible' | 'official' | 'probed' | 'models.dev' | 'litellm' | 'builtin' | 'fallback';
export type ModelCapabilityField =
  | 'contextWindow'
  | 'maxOutputTokens'
  | 'inputModalities'
  | 'vision'
  | 'reasoning'
  | 'toolCalling'
  | 'structuredOutput'
  | 'interleavedThinking';

export interface ModelCatalogEntry {
  readonly id: string;
  readonly vendor: string;
  /** Empty means the service did not publish protocol metadata. */
  readonly protocols: readonly ModelProtocol[];
  /** The service explicitly published these protocols, rather than directory defaults. */
  readonly protocolsDeclared?: boolean;
  /** CompatibleService directories that actually listed this model; [] means no endpoint evidence. */
  readonly catalogEndpoints?: readonly ModelCatalogEndpointKind[];
  /** Undefined means the service did not publish modality metadata. */
  readonly vision?: boolean;
  /** True only when the service explicitly advertises POST /responses/compact. */
  readonly responsesCompact?: boolean;
  /** Empty means compatibility was not explicitly declared. */
  readonly clients: readonly ModelClient[];
  readonly reasoningLevels?: readonly string[];
  readonly defaultReasoningLevel?: string;
  /** Resolved context limit; `capabilitySources.contextWindow` identifies fallbacks. */
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly inputModalities?: readonly string[];
  readonly reasoning?: boolean;
  readonly toolCalling?: boolean;
  readonly structuredOutput?: boolean;
  readonly interleavedThinking?: boolean;
  /** Per-field provenance after 兼容服务/official/aggregator resolution. */
  readonly capabilitySources?: Partial<Record<ModelCapabilityField, ModelCapabilitySource>>;
  /** Fields not explicitly known after all conservative sources are consulted. */
  readonly missingCapabilities?: readonly ModelCapabilityField[];
}

type ModelCatalogFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface ModelCatalogEndpoint {
  readonly kind: ModelCatalogEndpointKind;
  readonly path: string;
  readonly collectionKey: 'data' | 'models';
  readonly protocols: readonly ModelProtocol[];
  readonly clients: readonly ModelClient[];
}

interface ResolvedModelCatalogEndpoint extends ModelCatalogEndpoint {
  readonly url: string;
}

interface SerializedCompatibleServiceModelCatalog {
  readonly version: 1 | 2;
  readonly connectionId: string;
  readonly savedAt: string;
  readonly models: readonly unknown[];
}

const MODEL_CAPABILITY_FIELDS: readonly ModelCapabilityField[] = [
  'contextWindow',
  'maxOutputTokens',
  'inputModalities',
  'vision',
  'reasoning',
  'toolCalling',
  'structuredOutput',
  'interleavedThinking'
];

const MODEL_CAPABILITY_SOURCES: readonly ModelCapabilitySource[] = [
  'compatible',
  'official',
  'models.dev',
  'litellm',
  'builtin',
  'fallback'
];

const COMPATIBLE_SERVICE_MODEL_ENDPOINTS: readonly ModelCatalogEndpoint[] = [
  {
    kind: 'openai',
    path: '/v1/models',
    collectionKey: 'data',
    protocols: ['openai-responses', 'chat-completions'],
    clients: ['codex']
  },
  {
    kind: 'anthropic',
    path: '/anthropic/v1/models',
    collectionKey: 'data',
    protocols: ['anthropic-messages'],
    clients: ['claude', 'codex']
  },
  {
    kind: 'gemini',
    path: '/gemini/v1beta/models',
    collectionKey: 'models',
    protocols: ['gemini'],
    clients: []
  }
];

/** Read every protocol-specific 兼容服务 model endpoint and merge duplicate ids. */
export async function fetchCompatibleServiceModelCatalog(
  baseUrl: string,
  bearerToken: string,
  fetcher: ModelCatalogFetcher = fetch,
  capabilityCachePath?: string,
  fallbackCatalog: readonly ModelCatalogEntry[] = [],
  options: {
    readonly forceCapabilityRefresh?: boolean;
    readonly catalogMode?: ProviderModelCatalogMode;
  } = {}
): Promise<ModelCatalogEntry[]> {
  const catalogMode = options.catalogMode ?? 'multi-protocol';
  if (catalogMode === 'manual') {
    if (!fallbackCatalog.length) {
      throw new Error('该服务商需要手动填写模型或 Endpoint ID。');
    }
    return [...fallbackCatalog];
  }
  const endpoints = resolveModelCatalogEndpoints(baseUrl, catalogMode);
  const headers = { accept: 'application/json', authorization: `Bearer ${bearerToken}` };
  const results = await Promise.all(endpoints.map(async endpoint => {
    try {
      const response = await fetcher(endpoint.url, {
        headers,
        signal: AbortSignal.timeout(12_000)
      });
      if (!response.ok) {
        return { ok: false as const, missing: response.status === 404 || response.status === 405, error: `${endpoint.kind} HTTP ${response.status}`, entries: [] as unknown[] };
      }
      const payload = await response.json() as unknown;
      return { ok: true as const, missing: false, error: '', entries: entriesFromEndpoint(payload, endpoint) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false as const, missing: false, error: `${endpoint.kind} ${message}`, entries: [] as unknown[] };
    }
  }));

  if (!results.some(result => result.ok)) {
    const failures = results.filter(result => !result.missing);
    if (failures.length) {
      throw new Error(`模型列表请求失败：${failures.map(result => result.error).filter(Boolean).join('；')}`);
    }
  }
  const discovered = normalizeModelCatalog(results.flatMap((result, index) => (
    result.ok
      ? result.entries
      : result.missing ? [] : cachedEntriesForEndpoint(fallbackCatalog, endpoints[index])
  )));
  const providerCatalog = detectProviderPreset(baseUrl) === 'volcengine-ark'
    ? discovered
    : discovered.map(stripUntrustedCompatibleServiceCapabilities);
  const values = capabilityCachePath
    ? options.forceCapabilityRefresh
      ? await enrichModelCatalog(providerCatalog, fetcher, capabilityCachePath)
      : await enrichModelCatalogCacheFirst(providerCatalog, fetcher, capabilityCachePath)
    : await enrichModelCatalog(providerCatalog, fetcher);

  return values;
}

function resolveModelCatalogEndpoints(
  baseUrl: string,
  mode: Exclude<ProviderModelCatalogMode, 'manual'>
): ResolvedModelCatalogEndpoint[] {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const root = compatibleServiceRootUrl(baseUrl);
  const openAiEndpoint: ModelCatalogEndpoint = {
    kind: 'openai',
    path: '/models',
    collectionKey: 'data',
    protocols: ['openai-responses', 'chat-completions'],
    clients: ['codex']
  };
  if (mode === 'openai') {
    return buildProviderModelUrlCandidates(base).map(url => ({ ...openAiEndpoint, url }));
  }
  if (mode === 'multi-protocol') {
    return COMPATIBLE_SERVICE_MODEL_ENDPOINTS.map(endpoint => ({
      ...endpoint,
      url: `${root}${endpoint.path}`
    }));
  }
  const candidates: ResolvedModelCatalogEndpoint[] = buildProviderModelUrlCandidates(base)
    .map(url => ({ ...openAiEndpoint, url }));
  if (baseUrlUsesStandardV1Root(base)) {
    candidates.push(...COMPATIBLE_SERVICE_MODEL_ENDPOINTS.map(endpoint => ({
      ...endpoint,
      url: `${root}${endpoint.path}`
    })));
  }
  const seen = new Set<string>();
  return candidates.filter(endpoint => {
    if (seen.has(endpoint.url)) return false;
    seen.add(endpoint.url);
    return true;
  });
}

function baseUrlUsesStandardV1Root(value: string): boolean {
  try {
    return /\/v1\/?$/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function cachedEntriesForEndpoint(
  catalog: readonly ModelCatalogEntry[],
  endpoint: ModelCatalogEndpoint
): ModelCatalogEntry[] {
  return catalog.filter(entry => entry.catalogEndpoints
    ? entry.catalogEndpoints.includes(endpoint.kind)
    : endpoint.protocols.some(protocol => entry.protocols.includes(protocol))
  ).map(entry => ({ ...entry, catalogEndpoints: [endpoint.kind] }));
}

/** Restore the last complete 兼容服务 directory for the exact URL/token pair. */
export async function readCompatibleServiceModelCatalogCache(
  file: string,
  baseUrl: string,
  bearerToken: string,
  providerPreset: ProviderPresetId = 'compatible',
  readOnly = false
): Promise<ModelCatalogEntry[]> {
  const text = await readTextOrUndefined(file);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as Partial<SerializedCompatibleServiceModelCatalog>;
    if (
      (parsed.version !== 1 && parsed.version !== 2)
      || parsed.connectionId !== compatibleServiceConnectionId(baseUrl, bearerToken, providerPreset)
      || !Array.isArray(parsed.models)
    ) {
      return [];
    }
    if (parsed.version === 1) {
      // v1 persisted conservative runtime fallbacks without provenance, so a
      // stored `vision: false` cannot be distinguished from an explicit
      // 兼容服务 declaration. Keep only connection-scoped model existence and
      // protocol membership, then rebuild capabilities from the local
      // last-known-good cache plus the release seed. This also repairs the
      // Codex catalog when 兼容服务 is temporarily unreachable during upgrade.
      const discovered = normalizeModelCatalog(parsed.models).map(stripUntrustedCompatibleServiceCapabilities);
      if (readOnly) return discovered;
      const migrated = await enrichModelCatalogCacheFirst(
        discovered,
        fetch,
        path.join(path.dirname(file), 'model-capabilities-cache.json')
      );
      await writeCompatibleServiceModelCatalogCache(file, baseUrl, bearerToken, migrated, providerPreset).catch(() => undefined);
      return migrated;
    }
    if (parsed.version !== 2) return [];
    return normalizeModelCatalog(parsed.models);
  } catch {
    return [];
  }
}

/** Persist a compact, credential-free directory snapshot for fast cold starts. */
export async function writeCompatibleServiceModelCatalogCache(
  file: string,
  baseUrl: string,
  bearerToken: string,
  models: readonly ModelCatalogEntry[],
  providerPreset: ProviderPresetId = 'compatible'
): Promise<void> {
  const cachedModels = models.map(serializeCachedModel);
  const connectionId = compatibleServiceConnectionId(baseUrl, bearerToken, providerPreset);
  const existing = await readTextOrUndefined(file);
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as Partial<SerializedCompatibleServiceModelCatalog>;
      if (
        parsed.version === 2
        && parsed.connectionId === connectionId
        && Array.isArray(parsed.models)
        && JSON.stringify(parsed.models) === JSON.stringify(cachedModels)
      ) {
        return;
      }
    } catch {
      // A damaged cache is replaced below.
    }
  }
  const value: SerializedCompatibleServiceModelCatalog = {
    version: 2,
    connectionId,
    savedAt: new Date().toISOString(),
    models: cachedModels
  };
  await writeFileAtomic(file, `${JSON.stringify(value)}\n`);
}

export function normalizeModelCatalog(value: unknown): ModelCatalogEntry[] {
  const record = isRecord(value) ? value : undefined;
  const list = Array.isArray(value)
    ? value
    : Array.isArray(record?.data)
      ? record.data
      : Array.isArray(record?.models)
        ? record.models
        : [];
  const byId = new Map<string, ModelCatalogEntry>();
  for (const item of list) {
    const entry = normalizeModelEntry(item);
    if (!entry) continue;
    const previous = byId.get(entry.id);
    byId.set(entry.id, previous ? mergeEntries(previous, entry) : entry);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeModelEntry(value: unknown): ModelCatalogEntry | undefined {
  if (typeof value === 'string') {
    const id = value.trim();
    return id ? { id, vendor: '其他', protocols: [], clients: [] } : undefined;
  }
  if (!isRecord(value)) return undefined;
  const id = firstString(value.id, value.name, value.model);
  if (!id) return undefined;
  const capabilities = isRecord(value.capabilities) ? value.capabilities : undefined;
  const tokenLimits = isRecord(value.token_limits) ? value.token_limits : undefined;
  const modalities = isRecord(value.modalities) ? value.modalities : undefined;
  const features = isRecord(value.features) ? value.features : undefined;
  const toolFeatures = isRecord(features?.tools) ? features.tools : undefined;
  const structuredOutputFeatures = isRecord(features?.structured_outputs) ? features.structured_outputs : undefined;
  const vendor = normalizeVendor(firstString(
    value.vendor,
    value.provider,
    value.provider_name,
    value.organization,
    value.owned_by,
    capabilities?.vendor
  ));
  const protocols = normalizeProtocols([
    value.protocol,
    value.protocols,
    value.api_type,
    value.api,
    value.supported_protocols,
    value.api_types,
    value.apis,
    value.endpoints,
    value.supported_endpoints,
    capabilities?.protocols,
    capabilities?.api_types,
    capabilities?.endpoints,
    capabilities?.supported_endpoints
  ]);
  const clients = normalizeClients([
    value.clients,
    value.compatible_clients,
    value.entrypoints,
    capabilities?.clients,
    capabilities?.entrypoints
  ]);
  const vision = firstBoolean(
    value.vision,
    value.supports_vision,
    value.vision_capable,
    capabilities?.vision,
    capabilities?.supports_vision
  ) ?? modalityVision(value.input_modalities)
    ?? modalityVision(modalities?.input_modalities)
    ?? modalityVision(capabilities?.input_modalities);
  const inputModalities = normalizeModalities(
    value.input_modalities ?? modalities?.input_modalities ?? capabilities?.input_modalities
  );
  const contextWindow = firstPositiveInt(
    value.context_window, value.max_context_window, value.context_length, value.input_token_limit,
    value.inputTokenLimit, capabilities?.context_window, capabilities?.max_context_window,
    capabilities?.context_length, capabilities?.input_token_limit, capabilities?.inputTokenLimit,
    tokenLimits?.context_window, tokenLimits?.max_input_token_length
  );
  const maxOutputTokens = firstPositiveInt(
    value.max_output_tokens, value.output_token_limit, value.outputTokenLimit,
    capabilities?.max_output_tokens, capabilities?.output_token_limit, capabilities?.outputTokenLimit,
    tokenLimits?.max_output_token_length
  );
  const reasoning = firstBoolean(value.reasoning, value.supports_reasoning, capabilities?.reasoning, capabilities?.supports_reasoning);
  const toolCalling = firstBoolean(
    value.tool_call, value.supports_tool_calling, value.supports_function_calling,
    capabilities?.tool_call, capabilities?.supports_tool_calling, capabilities?.supports_function_calling,
    toolFeatures?.function_calling
  );
  const structuredOutput = firstBoolean(
    value.structured_output, value.supports_structured_output, value.supports_response_schema,
    capabilities?.structured_output, capabilities?.supports_structured_output, capabilities?.supports_response_schema,
    anyBooleanTrue(structuredOutputFeatures?.json_schema, structuredOutputFeatures?.json_object)
  );
  const interleavedThinking = firstBoolean(value.interleaved, capabilities?.interleaved);
  const responsesCompact = firstBoolean(
    value.responses_compact,
    value.supports_responses_compact,
    value.supports_compact,
    capabilities?.responses_compact,
    capabilities?.supports_responses_compact,
    capabilities?.supports_compact
  ) ?? responsesCompactEndpoint([
    value.endpoints,
    value.supported_endpoints,
    capabilities?.endpoints,
    capabilities?.supported_endpoints
  ]);
  const reasoningLevels = normalizeReasoningLevels([
    value.supported_reasoning_levels, value.reasoning_levels,
    value.reasoning_efforts, value.reasoning_levels_supported,
    value.effort_levels, value.efforts,
    capabilities?.supported_reasoning_levels, capabilities?.reasoning_levels
  ]);
  const defaultReasoningLevel = firstString(
    value.default_reasoning_level, value.default_reasoning_effort,
    capabilities?.default_reasoning_level, capabilities?.default_reasoning_effort
  )?.toLowerCase();
  const capabilitySources = normalizeCapabilitySources(value._xwx_capability_sources);
  const missingCapabilities = normalizeMissingCapabilities(value._xwx_missing_capabilities);
  const catalogEndpoints = value._xwx_catalog_endpoints ?? value.catalogEndpoints;
  return {
    id, vendor, protocols, vision,
    ...(value._xwx_protocols_declared === true || value.protocolsDeclared === true ? { protocolsDeclared: true } : {}),
    ...(Array.isArray(catalogEndpoints) ? { catalogEndpoints: unique(catalogEndpoints.filter(
      (kind): kind is ModelCatalogEndpointKind => kind === 'openai' || kind === 'anthropic' || kind === 'gemini'
    )) } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(inputModalities.length ? { inputModalities } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(toolCalling !== undefined ? { toolCalling } : {}),
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    ...(interleavedThinking !== undefined ? { interleavedThinking } : {}),
    ...(responsesCompact !== undefined ? { responsesCompact } : {}),
    ...(reasoningLevels.length ? { reasoningLevels } : {}),
    ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
    ...(Object.keys(capabilitySources).length ? { capabilitySources } : {}),
    ...(missingCapabilities.length ? { missingCapabilities } : {}),
    clients
  };
}

function entriesFromEndpoint(payload: unknown, endpoint: ModelCatalogEndpoint): unknown[] {
  const record = isRecord(payload) ? payload : undefined;
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.[endpoint.collectionKey])
      ? record[endpoint.collectionKey] as unknown[]
      : [];
  const out: unknown[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      const id = normalizeEndpointId(item, endpoint.kind);
      if (id) out.push({ id, protocols: endpointDefaultProtocols(endpoint), clients: endpoint.clients, catalogEndpoints: [endpoint.kind] });
      continue;
    }
    if (!isRecord(item)) continue;
    const id = normalizeEndpointId(firstString(item.id, item.name, item.model), endpoint.kind);
    if (!id) continue;
    const declared = normalizeModelEntry(item)?.protocols ?? [];
    out.push({
      ...item,
      id,
      protocols: declared.length ? declared : endpointDefaultProtocols(endpoint),
      _xwx_protocols_declared: declared.length > 0,
      _xwx_catalog_endpoints: [endpoint.kind],
      clients: endpoint.clients
    });
  }
  return out;
}

function endpointDefaultProtocols(endpoint: ModelCatalogEndpoint): readonly ModelProtocol[] {
  if (endpoint.kind !== 'openai') return endpoint.protocols;
  // /models lists model IDs; it does not declare a generation protocol.
  return [];
}

function normalizeEndpointId(value: string, kind: ModelCatalogEndpoint['kind']): string {
  const id = value.trim();
  return kind === 'gemini' ? id.replace(/^models\//i, '') : id;
}

function compatibleServiceRootUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/\/(?:anthropic\/v1|gemini\/v1beta|v1)$/i, '');
}

function compatibleServiceConnectionId(
  baseUrl: string,
  bearerToken: string,
  providerPreset: ProviderPresetId
): string {
  const normalizedBaseUrl = providerPreset === 'compatible'
    ? compatibleServiceRootUrl(baseUrl)
    : baseUrl.trim().replace(/\/+$/, '');
  return createHash('sha256')
    .update(`${providerPreset}\0${normalizedBaseUrl}\0${bearerToken.trim()}`)
    .digest('hex');
}

/** True when both catalogs persist to the same cache content. */
export function sameCachedModelCatalog(a: readonly ModelCatalogEntry[], b: readonly ModelCatalogEntry[]): boolean {
  return canonicalJson(a.map(serializeCachedModel)) === canonicalJson(b.map(serializeCachedModel));
}

/** Key order is not meaningful (e.g. capability sources are rebuilt in a different order). */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)))
    : item));
}

function serializeCachedModel(entry: ModelCatalogEntry): Record<string, unknown> {
  const isFallback = (field: ModelCapabilityField): boolean => (
    entry.capabilitySources?.[field] === 'fallback'
  );
  return {
    id: entry.id,
    vendor: entry.vendor,
    protocols: entry.protocols,
    ...(entry.protocolsDeclared ? { _xwx_protocols_declared: true } : {}),
    ...(entry.catalogEndpoints ? { _xwx_catalog_endpoints: entry.catalogEndpoints } : {}),
    clients: entry.clients,
    ...(entry.vision !== undefined && !isFallback('vision') ? { vision: entry.vision } : {}),
    ...(entry.responsesCompact !== undefined ? { responses_compact: entry.responsesCompact } : {}),
    ...(entry.contextWindow !== undefined && !isFallback('contextWindow') ? { context_window: entry.contextWindow } : {}),
    ...(entry.maxOutputTokens !== undefined && !isFallback('maxOutputTokens') ? { max_output_tokens: entry.maxOutputTokens } : {}),
    ...(entry.inputModalities?.length && !isFallback('inputModalities') ? { input_modalities: entry.inputModalities } : {}),
    ...(entry.reasoning !== undefined && !isFallback('reasoning') ? { reasoning: entry.reasoning } : {}),
    ...(entry.toolCalling !== undefined && !isFallback('toolCalling') ? { supports_tool_calling: entry.toolCalling } : {}),
    ...(entry.structuredOutput !== undefined && !isFallback('structuredOutput')
      ? { supports_structured_output: entry.structuredOutput }
      : {}),
    ...(entry.interleavedThinking !== undefined && !isFallback('interleavedThinking')
      ? { interleaved: entry.interleavedThinking }
      : {}),
    ...(entry.reasoningLevels?.length ? { reasoning_levels: entry.reasoningLevels } : {}),
    ...(entry.defaultReasoningLevel ? { default_reasoning_level: entry.defaultReasoningLevel } : {}),
    ...(entry.capabilitySources && Object.keys(entry.capabilitySources).length
      ? { _xwx_capability_sources: entry.capabilitySources }
      : {}),
    ...(entry.missingCapabilities?.length
      ? { _xwx_missing_capabilities: entry.missingCapabilities }
      : {})
  };
}

function stripUntrustedCompatibleServiceCapabilities(entry: ModelCatalogEntry): ModelCatalogEntry {
  return {
    id: entry.id,
    vendor: entry.vendor,
    protocols: entry.protocols,
    ...(entry.protocolsDeclared ? { protocolsDeclared: true } : {}),
    ...(entry.catalogEndpoints ? { catalogEndpoints: entry.catalogEndpoints } : {}),
    clients: entry.clients
  };
}

function mergeEntries(a: ModelCatalogEntry, b: ModelCatalogEntry): ModelCatalogEntry {
  return {
    id: a.id,
    vendor: a.vendor !== '其他' ? a.vendor : b.vendor,
    protocols: a.protocolsDeclared && !b.protocolsDeclared ? a.protocols
      : b.protocolsDeclared && !a.protocolsDeclared ? b.protocols
        : unique([...a.protocols, ...b.protocols]),
    ...(a.protocolsDeclared || b.protocolsDeclared ? { protocolsDeclared: true } : {}),
    ...(a.catalogEndpoints || b.catalogEndpoints
      ? { catalogEndpoints: unique([...(a.catalogEndpoints ?? []), ...(b.catalogEndpoints ?? [])]) } : {}),
    vision: a.vision ?? b.vision,
    contextWindow: a.contextWindow ?? b.contextWindow,
    maxOutputTokens: a.maxOutputTokens ?? b.maxOutputTokens,
    inputModalities: unique([...(a.inputModalities ?? []), ...(b.inputModalities ?? [])]),
    reasoning: a.reasoning ?? b.reasoning,
    toolCalling: a.toolCalling ?? b.toolCalling,
    structuredOutput: a.structuredOutput ?? b.structuredOutput,
    interleavedThinking: a.interleavedThinking ?? b.interleavedThinking,
    ...((a.responsesCompact ?? b.responsesCompact) !== undefined
      ? { responsesCompact: a.responsesCompact ?? b.responsesCompact }
      : {}),
    ...((a.reasoningLevels?.length || b.reasoningLevels?.length)
      ? { reasoningLevels: unique([...(a.reasoningLevels ?? []), ...(b.reasoningLevels ?? [])]) }
      : {}),
    ...((a.defaultReasoningLevel ?? b.defaultReasoningLevel)
      ? { defaultReasoningLevel: a.defaultReasoningLevel ?? b.defaultReasoningLevel }
      : {}),
    clients: unique([...a.clients, ...b.clients])
  };
}

function normalizeReasoningLevels(value: unknown): string[] {
  const out: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === 'string') out.push(item.trim().toLowerCase());
    else if (isRecord(item)) { visit(item.effort); visit(item.level); visit(item.name); }
    else if (Array.isArray(item)) item.forEach(visit);
  };
  visit(value);
  return unique(out.filter(Boolean));
}

function normalizeCapabilitySources(
  value: unknown
): Partial<Record<ModelCapabilityField, ModelCapabilitySource>> {
  if (!isRecord(value)) return {};
  const out: Partial<Record<ModelCapabilityField, ModelCapabilitySource>> = {};
  for (const field of MODEL_CAPABILITY_FIELDS) {
    const source = value[field];
    if (
      typeof source === 'string'
      && MODEL_CAPABILITY_SOURCES.includes(source as ModelCapabilitySource)
    ) {
      out[field] = source as ModelCapabilitySource;
    }
  }
  return out;
}

function normalizeMissingCapabilities(value: unknown): ModelCapabilityField[] {
  if (!Array.isArray(value)) return [];
  return unique(value.filter((field): field is ModelCapabilityField => (
    typeof field === 'string'
    && MODEL_CAPABILITY_FIELDS.includes(field as ModelCapabilityField)
  )));
}

function normalizeProtocols(values: readonly unknown[]): ModelProtocol[] {
  const out: ModelProtocol[] = [];
  for (const raw of flattenStrings(values)) {
    const value = raw.toLowerCase().replace(/[\s_]+/g, '-');
    if (value.includes('anthropic') || value === 'messages' || value.endsWith('/messages')) out.push('anthropic-messages');
    else if (value.includes('response')) out.push('openai-responses');
    else if (value.includes('chat') || value.includes('completion')) out.push('chat-completions');
    else if (value.includes('gemini') || value.includes('generate-content')) out.push('gemini');
  }
  return unique(out);
}

function normalizeClients(values: readonly unknown[]): ModelClient[] {
  const out: ModelClient[] = [];
  for (const raw of flattenStrings(values)) {
    const value = raw.toLowerCase();
    if (value.includes('claude') || value.includes('anthropic')) out.push('claude');
    if (value.includes('codex') || value.includes('responses')) out.push('codex');
  }
  return unique(out);
}

function modalityVision(value: unknown): boolean | undefined {
  const modalities = flattenStrings([value]).map(item => item.toLowerCase());
  return modalities.length ? modalities.some(item => item.includes('image') || item.includes('vision')) : undefined;
}

function normalizeModalities(value: unknown): string[] {
  return unique(flattenStrings([value]).map(item => item.toLowerCase()));
}

function responsesCompactEndpoint(values: readonly unknown[]): boolean | undefined {
  const endpoints = flattenStrings(values).map(item => item.toLowerCase().replace(/\/+$/, ''));
  return endpoints.length
    ? endpoints.some(item => item.endsWith('/responses/compact') || item === 'responses-compact') || undefined
    : undefined;
}

function flattenStrings(values: readonly unknown[]): string[] {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      value.split(/[,|]/).map(item => item.trim()).filter(Boolean).forEach(item => out.push(item));
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    }
  };
  values.forEach(visit);
  return out;
}

function normalizeVendor(value: string): string {
  if (!value) return '其他';
  const lower = value.toLowerCase();
  if (lower === 'paper-llm-hub' || lower === 'compatible') return '兼容服务';
  if (lower === 'openai') return 'OpenAI';
  if (lower === 'anthropic') return 'Anthropic';
  return value;
}

function firstString(...values: readonly unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function firstBoolean(...values: readonly unknown[]): boolean | undefined {
  for (const value of values) if (typeof value === 'boolean') return value;
  return undefined;
}

function anyBooleanTrue(...values: readonly unknown[]): boolean | undefined {
  const booleans = values.filter((value): value is boolean => typeof value === 'boolean');
  return booleans.length ? booleans.some(Boolean) : undefined;
}

function firstPositiveInt(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return undefined;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
