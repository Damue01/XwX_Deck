// The protocol table is maintained separately from the generated client asset.
// It only carries facts that a cited provider page states explicitly; a missing
// field is unknown, never an inferred "unsupported".
const PROTOCOLS = new Set(['openai-responses', 'chat-completions', 'anthropic-messages']);
const PROTOCOL_ORDER = ['openai-responses', 'chat-completions', 'anthropic-messages'];
const SOURCE_HOSTS = new Set([
  'api-docs.deepseek.com',
  'platform.kimi.com',
  'docs.bigmodel.cn',
  'www.alibabacloud.com',
  'platform.minimax.cn',
  'platform.openai.com',
  'platform.claude.com',
  'docs.x.ai',
  'docs.mistral.ai',
  'console.groq.com',
  'inference-docs.cerebras.ai',
  'docs.perplexity.ai',
  'docs.together.ai',
  'docs.fireworks.ai',
  'docs.api.nvidia.com',
  'huggingface.co',
  'docs.siliconflow.cn',
  'platform.stepfun.com',
  'cloud.tencent.com',
  'docs.z.ai',
  'ai.google.dev',
  'openrouter.ai',
  'docs.volcengine.com'
]);

function fail(message) {
  throw Error('model-protocols: ' + message);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function canonicalOfficialModelId(value) {
  const normalized = String(value).trim().toLowerCase().replace(/^models\//, '');
  const slash = normalized.lastIndexOf('/');
  const bare = slash === -1 ? normalized : normalized.slice(slash + 1);
  // Keep this in sync with src/shared/official-model-registry.ts. Official
  // snapshots share the base model's protocol and capability contract.
  const base = bare
    .replace(/-\d{4}-\d{2}-\d{2}$/u, '')
    .replace(/(?:-ga)?-\d{4,8}$/u, '')
    .replace(/-ga$/u, '');
  return base.replace(/[^a-z0-9]/g, '');
}

// Exact rows use the model owner's bare ID. Generated aggregator rows keep
// their provider namespace so two providers can expose different protocols for
// the same underlying model without overwriting each other.
function tableKey(value) {
  const normalized = String(value).trim().toLowerCase().replace(/^models\//, '');
  const slash = normalized.lastIndexOf('/');
  if (slash === -1) return canonicalOfficialModelId(normalized);
  return normalized.slice(0, slash).replace(/[^a-z0-9/]/g, '') + '/' + canonicalOfficialModelId(normalized.slice(slash + 1));
}

function source(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(key + ' must be an object');
  if (typeof value.label !== 'string' || !value.label.trim()) fail(key + '.label is required');
  if (typeof value.url !== 'string') fail(key + '.url is required');
  let url;
  try { url = new URL(value.url); } catch { fail(key + '.url is invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password) fail(key + '.url must be a credential-free HTTPS URL');
  if (!SOURCE_HOSTS.has(url.hostname)) fail(key + '.url host is not an approved official documentation host');
  return { label: value.label.trim(), url: url.toString() };
}

function capability(value, modelId) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(modelId + '.capability must be an object');
  const out = {};
  for (const key of ['contextWindow', 'maxOutputTokens']) {
    if (value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) fail(modelId + '.' + key + ' must be a positive integer');
    out[key] = value[key];
  }
  for (const key of ['vision', 'reasoning', 'toolCalling', 'structuredOutput', 'interleavedThinking']) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'boolean') fail(modelId + '.' + key + ' must be boolean');
    out[key] = value[key];
  }
  for (const key of ['inputModalities', 'levels']) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || value[key].some(item => typeof item !== 'string' || !item.trim())) {
      fail(modelId + '.' + key + ' must be an array of non-empty strings');
    }
    out[key] = [...new Set(value[key].map(item => item.trim()))];
  }
  if (value.defaultLevel !== undefined) {
    if (typeof value.defaultLevel !== 'string' || !value.defaultLevel.trim()) fail(modelId + '.defaultLevel must be a string');
    out.defaultLevel = value.defaultLevel.trim();
  }
  return out;
}

function protocols(value, key) {
  if (!Array.isArray(value) || !value.length) fail(key + ' is required');
  if (value.some(protocol => !PROTOCOLS.has(protocol))) fail(key + ' contains an unknown protocol');
  return PROTOCOL_ORDER.filter(protocol => value.includes(protocol));
}

function sourceIds(value, sources, key) {
  if (!Array.isArray(value) || !value.length) fail(key + ' is required');
  if (value.some(sourceId => !sources[sourceId])) fail(key + ' references an unknown source');
  return [...new Set(value)].map(sourceId => sources[sourceId]);
}

function providerDefaults(value, sources) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('providerDefaults must be an array');
  const seen = new Set();
  return value.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('providerDefaults[' + index + '] must be an object');
    if (typeof row.providerId !== 'string' || !row.providerId.trim()) fail('providerDefaults[' + index + '].providerId is required');
    const providerId = row.providerId.trim();
    if (seen.has(providerId)) fail('duplicate provider default: ' + providerId);
    seen.add(providerId);
    return {
      providerId,
      vendor: typeof row.vendor === 'string' && row.vendor.trim() ? row.vendor.trim() : providerId,
      protocols: protocols(row.protocols, providerId + '.protocols'),
      sources: sourceIds(row.sourceIds, sources, providerId + '.sourceIds')
    };
  });
}

function modelRules(value, sources) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('modelRules must be an array');
  return value.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('modelRules[' + index + '] must be an object');
    if (!Array.isArray(row.providers) || !row.providers.length || row.providers.some(provider => typeof provider !== 'string' || !provider.trim())) {
      fail('modelRules[' + index + '].providers must be a non-empty string array');
    }
    const matchers = ['exact', 'prefix', 'contains'].filter(key => row[key] !== undefined);
    if (!matchers.length) fail('modelRules[' + index + '] needs exact, prefix or contains');
    const out = {
      providers: [...new Set(row.providers.map(provider => provider.trim()))],
      protocols: protocols(row.protocols, 'modelRules[' + index + '].protocols'),
      sources: sourceIds(row.sourceIds, sources, 'modelRules[' + index + '].sourceIds')
    };
    for (const key of matchers) {
      if (!Array.isArray(row[key]) || !row[key].length || row[key].some(item => typeof item !== 'string' || !item.trim())) {
        fail('modelRules[' + index + '].' + key + ' must be a non-empty string array');
      }
      out[key] = [...new Set(row[key].map(item => item.trim().toLowerCase()))];
    }
    return out;
  });
}

export function normalizeProtocolTable(table) {
  if (!table || typeof table !== 'object' || Array.isArray(table)) fail('root must be an object');
  if (table.version !== 1) fail('version must be 1');
  if (typeof table.verifiedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(table.verifiedAt)) fail('verifiedAt must be an ISO date');
  if (!table.sources || typeof table.sources !== 'object' || Array.isArray(table.sources)) fail('sources must be an object');
  const sources = Object.fromEntries(Object.entries(table.sources).map(([key, value]) => [key, source(value, 'sources.' + key)]));
  if (!Array.isArray(table.models) || !table.models.length) fail('models must be a non-empty array');
  if (table.models.length > 1000) fail('models exceeds the 1000-row maintenance limit');
  const seen = new Set();
  const models = table.models.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail('models[' + index + '] must be an object');
    if (typeof row.modelId !== 'string' || !row.modelId.trim()) fail('models[' + index + '].modelId is required');
    if (typeof row.vendor !== 'string' || !row.vendor.trim()) fail(row.modelId + '.vendor is required');
    const modelId = row.modelId.trim();
    const key = canonicalOfficialModelId(modelId);
    if (!key) fail(modelId + ' has no canonical identity');
    if (seen.has(key)) fail('duplicate canonical model identity: ' + modelId);
    seen.add(key);
    return {
      modelId,
      vendor: row.vendor.trim(),
      protocols: protocols(row.protocols, modelId + '.protocols'),
      sources: sourceIds(row.sourceIds, sources, modelId + '.sourceIds'),
      capability: capability(row.capability, modelId),
      ...(typeof row.notes === 'string' && row.notes.trim() ? { notes: row.notes.trim() } : {})
    };
  });
  return {
    version: 1,
    verifiedAt: table.verifiedAt,
    models,
    providerDefaults: providerDefaults(table.providerDefaults, sources),
    modelRules: modelRules(table.modelRules, sources)
  };
}

const NON_CHAT_ID = /(embed|rerank|moderation|guard|tts|asr|transcri|speech|audio|realtime|image|video|ocr|flux|veo|lyria|sora|dall-e|stable-diffusion|midjourney|canvas)/iu;

function conversational(raw, modelId) {
  if (!raw || typeof raw !== 'object' || NON_CHAT_ID.test(modelId)) return false;
  if (!(raw.limit && raw.limit.context > 0)) return false;
  return raw.temperature === true || raw.tool_call === true || raw.reasoning === true;
}

function capabilityFromRaw(raw) {
  const out = {};
  for (const [key, field] of [['contextWindow', 'context'], ['maxOutputTokens', 'output']]) {
    if (Number.isSafeInteger(raw.limit?.[field]) && raw.limit[field] > 0) out[key] = raw.limit[field];
  }
  const modalities = raw.modalities?.input;
  if (Array.isArray(modalities) && modalities.length) {
    out.inputModalities = [...new Set(modalities.filter(item => typeof item === 'string'))];
    out.vision = out.inputModalities.some(item => ['image', 'pdf', 'video'].includes(item));
  }
  for (const [key, field] of [
    ['reasoning', 'reasoning'],
    ['toolCalling', 'tool_call'],
    ['structuredOutput', 'structured_output']
  ]) {
    if (typeof raw[field] === 'boolean') out[key] = raw[field];
  }
  const levels = [];
  for (const option of raw.reasoning_options ?? []) {
    if (option?.type === 'effort' && Array.isArray(option.values)) {
      for (const value of option.values) if (typeof value === 'string' && !levels.includes(value)) levels.push(value);
    }
  }
  if (levels.length) out.levels = levels;
  if (raw.interleaved && typeof raw.interleaved.field === 'string') out.interleavedThinking = true;
  return out;
}

function matchesRule(rule, providerId, modelId) {
  if (!rule.providers.includes(providerId)) return false;
  const id = modelId.toLowerCase();
  if (rule.exact?.includes(id)) return true;
  if (rule.prefix?.some(prefix => id.startsWith(prefix))) return true;
  if (rule.contains?.some(value => id.includes(value))) return true;
  return false;
}

export function expandProtocolTable(table, catalog) {
  const normalized = normalizeProtocolTable(table);
  const exact = new Set(normalized.models.map(row => canonicalOfficialModelId(row.modelId)));
  const generated = [];
  for (const provider of normalized.providerDefaults) {
    const models = catalog?.[provider.providerId]?.models ?? {};
    for (const [modelId, raw] of Object.entries(models)) {
      if (!conversational(raw, modelId) || exact.has(canonicalOfficialModelId(modelId))) continue;
      const rule = normalized.modelRules.find(candidate => matchesRule(candidate, provider.providerId, modelId));
      generated.push({
        modelId,
        vendor: provider.vendor,
        protocols: rule ? rule.protocols : provider.protocols,
        sources: rule ? rule.sources : provider.sources,
        capability: capabilityFromRaw(raw),
        generated: true
      });
    }
  }
  return { ...normalized, models: [...normalized.models, ...generated] };
}

function mergeSources(existing, incoming) {
  const out = Array.isArray(existing) ? clone(existing) : [];
  for (const item of incoming) {
    if (!out.some(candidate => candidate.url === item.url)) out.push(clone(item));
  }
  return out;
}

function fillCapability(existing, incoming) {
  const out = existing && typeof existing === 'object' ? clone(existing) : {};
  for (const [key, value] of Object.entries(incoming)) {
    if (out[key] === undefined) {
      out[key] = clone(value);
    } else if ((key === 'inputModalities' || key === 'levels') && Array.isArray(out[key]) && Array.isArray(value)) {
      out[key] = [...new Set([...out[key], ...value])];
    }
  }
  return out;
}

function recommendedProtocol(protocols) {
  return protocols.includes('openai-responses')
    ? 'responses'
    : protocols.includes('chat-completions') ? 'chat-completions' : 'anthropic-messages';
}

export function mergeOfficialModels(registry, table) {
  const normalized = Array.isArray(table.models) && table.models.every(row => Array.isArray(row.sources) && !('sourceIds' in row))
    ? table
    : normalizeProtocolTable(table);
  const merged = new Map();
  for (const row of registry) {
    if (!row || typeof row.modelId !== 'string') fail('registry contains an invalid model row');
    merged.set(tableKey(row.modelId), clone(row));
  }
  for (const row of normalized.models) {
    const key = tableKey(row.modelId);
    const current = merged.get(key);
    if (current) {
      if (row.modelId.length < current.modelId.length) {
        merged.set(key, {
          ...clone(current),
          ...clone(row),
          verifiedAt: normalized.verifiedAt > String(current.verifiedAt) ? normalized.verifiedAt : current.verifiedAt
        });
      } else {
        current.protocols = PROTOCOL_ORDER.filter(protocol =>
          current.protocols.includes(protocol) || row.protocols.includes(protocol));
        current.sources = mergeSources(current.sources, row.sources);
        current.capability = fillCapability(current.capability, row.capability);
        if (normalized.verifiedAt > String(current.verifiedAt)) current.verifiedAt = normalized.verifiedAt;
        if (row.notes) current.notes = row.notes;
      }
    } else {
      merged.set(key, {
        modelId: row.modelId,
        vendor: row.vendor,
        verifiedAt: normalized.verifiedAt,
        sources: clone(row.sources),
        capability: clone(row.capability),
        protocols: row.protocols,
        claudeOneMillionRoles: [],
        codexRecommendedProtocol: recommendedProtocol(row.protocols),
        ...(row.notes ? { notes: row.notes } : {})
      });
    }
  }
  return [...merged.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
}
