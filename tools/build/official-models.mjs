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
  'platform.minimax.cn'
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
    if (!Array.isArray(row.protocols) || !row.protocols.length) fail(modelId + '.protocols is required');
    if (row.protocols.some(protocol => !PROTOCOLS.has(protocol))) fail(modelId + '.protocols contains an unknown protocol');
    if (!Array.isArray(row.sourceIds) || !row.sourceIds.length) fail(modelId + '.sourceIds is required');
    if (row.sourceIds.some(sourceId => !sources[sourceId])) fail(modelId + '.sourceIds references an unknown source');
    return {
      modelId,
      vendor: row.vendor.trim(),
      protocols: PROTOCOL_ORDER.filter(protocol => row.protocols.includes(protocol)),
      sources: [...new Set(row.sourceIds)].map(sourceId => sources[sourceId]),
      capability: capability(row.capability, modelId),
      ...(typeof row.notes === 'string' && row.notes.trim() ? { notes: row.notes.trim() } : {})
    };
  });
  return { version: 1, verifiedAt: table.verifiedAt, models };
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
  const normalized = normalizeProtocolTable(table);
  const merged = new Map();
  for (const row of registry) {
    if (!row || typeof row.modelId !== 'string') fail('registry contains an invalid model row');
    merged.set(canonicalOfficialModelId(row.modelId), clone(row));
  }
  for (const row of normalized.models) {
    const key = canonicalOfficialModelId(row.modelId);
    const current = merged.get(key);
    if (current) {
      current.protocols = PROTOCOL_ORDER.filter(protocol =>
        current.protocols.includes(protocol) || row.protocols.includes(protocol));
      current.sources = mergeSources(current.sources, row.sources);
      current.capability = fillCapability(current.capability, row.capability);
      if (normalized.verifiedAt > String(current.verifiedAt)) current.verifiedAt = normalized.verifiedAt;
      if (row.notes) current.notes = row.notes;
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
