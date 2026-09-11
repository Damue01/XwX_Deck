import * as path from 'path';
import { ModelCatalogEntry } from '../app/modelCatalog';
import { isKnownNonConversationalModel } from '../app/codexProtocolPolicy';
import { readTextOrUndefined, writeFileAtomic } from '../shared/fsx';
import { resolveClientPaths } from './clientConfig';
import { resolveCompatibleServiceReasoningProfile } from './compatibleServiceReasoningProfiles';
import { readTomlTopLevelString, rootToml } from './toml';
import { codexDefaultContextWindow } from '../../shared/codexContextVariants';

export const XwX_CODEX_CATALOG_FILE = 'xwx-compatible-catalog.json';

type CatalogRow = Record<string, unknown>;

interface CatalogDocument {
  readonly models: CatalogRow[];
  readonly [key: string]: unknown;
}

interface NativeCatalogTemplates {
  readonly fallback: CatalogRow;
  readonly bySlug: ReadonlyMap<string, CatalogRow>;
}

export interface CodexCatalogSyncResult {
  readonly path: string;
  readonly changed: boolean;
}

/**
 * Materializes the startup-only model catalog shared by Codex CLI/App.
 * The catalog is intentionally service-scoped: while 兼容服务 is selected it
 * contains 兼容服务 models; returning to the official service removes only the
 * XwX-owned `model_catalog_json` pointer from config.toml.
 */
export class CodexModelCatalogManager {
  private writes: Promise<unknown> = Promise.resolve();
  catalogPath(): string {
    return path.join(path.dirname(resolveClientPaths().codexConfigPath), XwX_CODEX_CATALOG_FILE);
  }

  async sync(entries: readonly ModelCatalogEntry[], compatibleServiceProfile = true): Promise<string> {
    const result = await this.writeCatalog(entries, compatibleServiceProfile);
    return result.path;
  }

  /**
   * Refresh the XwX-owned catalog without touching a catalog owned by another
   * tool. An absent pointer is also allowed because the caller may be in the
   * middle of publishing the 兼容服务 config transaction.
   */
  async syncIfXwXOwned(entries: readonly ModelCatalogEntry[], compatibleServiceProfile = true): Promise<CodexCatalogSyncResult | undefined> {
    const configText = await readTextOrUndefined(resolveClientPaths().codexConfigPath);
    const configuredPath = configText
      ? readTomlTopLevelString(rootToml(configText), 'model_catalog_json')
      : undefined;
    if (configuredPath && !isXwXCodexCatalogPath(configuredPath)) return undefined;
    return this.writeCatalog(entries, compatibleServiceProfile);
  }

  private writeCatalog(entries: readonly ModelCatalogEntry[], compatibleServiceProfile: boolean): Promise<CodexCatalogSyncResult> {
    const result = this.writes.then(() => this.writeCatalogUnlocked(entries, compatibleServiceProfile));
    this.writes = result.catch(() => undefined);
    return result;
  }

  private async writeCatalogUnlocked(entries: readonly ModelCatalogEntry[], compatibleServiceProfile: boolean): Promise<CodexCatalogSyncResult> {
    const templates = await this.readNativeTemplates();
    const rows = entries
      .filter(entry => (
        entry.clients.includes('codex')
        || entry.protocols.includes('openai-responses')
        || entry.protocols.includes('chat-completions')
        || entry.protocols.includes('anthropic-messages')
      ) && !isKnownNonConversationalModel(entry.id))
      .map((entry, index) => routedCatalogRow(
        templates.fallback,
        templates.bySlug.get(normalizeSlug(entry.id)),
        entry,
        index,
        compatibleServiceProfile
      ));
    if (!rows.length) throw new Error('兼容服务 没有返回可用于 ChatGPT 的模型。');
    const document: CatalogDocument = { models: rows };
    const target = this.catalogPath();
    const content = `${JSON.stringify(document, null, 2)}\n`;
    const previous = await readTextOrUndefined(target);
    if (previous === content) return { path: target, changed: false };
    await writeFileAtomic(target, content);
    return { path: target, changed: true };
  }

  private async readNativeTemplates(): Promise<NativeCatalogTemplates> {
    const codexHome = path.dirname(resolveClientPaths().codexConfigPath);
    const candidates = [
      path.join(codexHome, 'models_cache.json'),
      this.catalogPath()
    ];
    let fallback: CatalogRow | undefined;
    const bySlug = new Map<string, CatalogRow>();
    for (const candidate of candidates) {
      const text = await readTextOrUndefined(candidate);
      if (!text) continue;
      try {
        const parsed = JSON.parse(text) as { models?: unknown };
        if (!Array.isArray(parsed.models)) continue;
        for (const value of parsed.models) {
          if (!isRecord(value)) continue;
          if (!fallback && typeof value.base_instructions === 'string') fallback = value;
          if (typeof value.slug === 'string' && value.slug.trim()) {
            const slug = normalizeSlug(value.slug);
            if (!bySlug.has(slug)) bySlug.set(slug, value);
          }
        }
      } catch {
        // A damaged cache must not block the conservative built-in template.
      }
    }
    return { fallback: fallback ?? fallbackTemplate(), bySlug };
  }
}

export function isXwXCodexCatalogPath(value: string | undefined): boolean {
  if (!value) return false;
  return path.basename(value).toLowerCase() === XwX_CODEX_CATALOG_FILE.toLowerCase();
}

// Codex deserializes the catalog into strict Rust enums and hard-errors on
// startup (no fallback) if a closed enum — `shell_type`, `visibility`,
// `input_modalities`, `truncation_policy.mode` — receives an unknown variant.
// `ReasoningEffort` is NOT one of them any more: it carries a `Custom(String)`
// arm, so Codex forwards any spelling verbatim. This list is therefore ours,
// not Codex's: it keeps an aggregator's invented level out of the picker.
// `ultra` is excluded on purpose — Codex rewrites it to `max` before the
// request leaves (`reasoning_effort_for_request`), so publishing both would
// show two entries that produce byte-identical requests.
const CODEX_REASONING_EFFORTS = new Set([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'
]);
const CODEX_INPUT_MODALITIES = new Set(['text', 'image', 'audio']);

function clampReasoningEfforts(levels: readonly unknown[] | undefined): string[] {
  if (!levels?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of levels) {
    const effort = isRecord(raw) && typeof raw.effort === 'string'
      ? raw.effort.trim().toLowerCase()
      : String(raw).trim().toLowerCase();
    if (CODEX_REASONING_EFFORTS.has(effort) && !seen.has(effort)) {
      seen.add(effort);
      out.push(effort);
    }
  }
  return out;
}

function clampInputModalities(modalities: readonly string[] | undefined, vision: boolean): string[] {
  const source = modalities?.length ? modalities : vision ? ['text', 'image'] : ['text'];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of source) {
    const modality = String(raw).trim().toLowerCase();
    if (CODEX_INPUT_MODALITIES.has(modality) && !seen.has(modality)) {
      seen.add(modality);
      out.push(modality);
    }
  }
  // Codex requires a usable modality; text is the safe universal floor.
  if (!out.length) out.push('text');
  if (vision && !seen.has('image')) out.push('image');
  return out;
}

function routedCatalogRow(
  template: CatalogRow,
  nativeModel: CatalogRow | undefined,
  entry: ModelCatalogEntry,
  index: number,
  compatibleServiceProfile = true
): CatalogRow {
  // Enrichment normally supplies a sourced value for every row. Keep the same
  // 256K operational fallback here for damaged or hand-built catalogs.
  const maxContextWindow = entry.contextWindow ?? 262_144;
  const contextWindow = codexDefaultContextWindow(entry) ?? maxContextWindow;
  const row: CatalogRow = structuredClone(template);
  row.slug = entry.id;
  row.display_name = entry.id;
  row.description = entry.vendor && entry.vendor !== '其他'
    ? `${entry.vendor} · 兼容服务`
    : '兼容服务 compatible model';
  row.visibility = 'list';
  row.supported_in_api = true;
  row.priority = index;
  const nativeLevels = clampReasoningEfforts(
    Array.isArray(nativeModel?.supported_reasoning_levels)
      ? nativeModel.supported_reasoning_levels
      : undefined
  );
  const shouldUseNativeLevels = compatibleServiceProfile && nativeLevels.length > 0
    && entry.capabilitySources?.reasoning !== 'compatible';
  const levels = shouldUseNativeLevels
    ? nativeLevels
    : clampReasoningEfforts(entry.reasoningLevels);
  const verifiedReasoning = compatibleServiceProfile ? verifiedCatalogReasoning(entry, levels) : undefined;
  const displayedLevels = verifiedReasoning?.levels ?? levels;
  // `supported_reasoning_levels` is a required Codex field. Always emit it
  // (even empty) instead of deleting it or inheriting the template's value.
  row.supported_reasoning_levels = displayedLevels.map(effort => ({ effort, description: `${effort} reasoning effort` }));
  if (displayedLevels.length) {
    const preferredDefault = shouldUseNativeLevels && typeof nativeModel?.default_reasoning_level === 'string'
      ? nativeModel.default_reasoning_level.trim().toLowerCase()
      : entry.defaultReasoningLevel
        ? String(entry.defaultReasoningLevel).trim().toLowerCase()
        : undefined;
    const verifiedDefault = verifiedReasoning?.defaultLevel;
    row.default_reasoning_level = verifiedDefault && displayedLevels.includes(verifiedDefault)
      ? verifiedDefault
      : preferredDefault && displayedLevels.includes(preferredDefault)
        ? preferredDefault
        : displayedLevels.includes('medium') ? 'medium' : displayedLevels[0];
  } else {
    delete row.default_reasoning_level;
  }
  row.context_window = contextWindow;
  row.max_context_window = maxContextWindow;
  row.auto_compact_token_limit = Math.floor(contextWindow * 0.9);
  row.effective_context_window_percent = 95;
  const nativeInputModalities = Array.isArray(nativeModel?.input_modalities)
    ? nativeModel.input_modalities.filter((value): value is string => typeof value === 'string')
    : undefined;
  const nativeVision = nativeModel?.supports_image_detail_original === true
    || nativeInputModalities?.some(value => value.trim().toLowerCase() === 'image') === true;
  const inputModalities = entry.capabilitySources?.inputModalities === 'fallback'
    && nativeInputModalities?.length
    ? nativeInputModalities
    : entry.inputModalities;
  const vision = entry.capabilitySources?.vision === 'fallback'
    ? nativeVision
    : entry.vision === true;
  row.input_modalities = clampInputModalities(inputModalities, vision);
  row.supports_search_tool = false;
  // Codex reads `supports_reasoning_summary_parameter`, and its default is
  // `true`: omitting the field enables summaries. `supports_reasoning_summaries`
  // is not part of the schema at all and was silently discarded.
  // A probed effort ladder counts as evidence of reasoning even when the
  // capability directories never set the flag.
  const reasons = entry.reasoning === true || (verifiedReasoning?.levels.length ?? 0) > 0;
  row.supports_reasoning_summary_parameter = reasons;
  row.default_reasoning_summary = reasons ? 'auto' : 'none';
  // Tool calling does not prove parallel tool-call support.
  row.supports_parallel_tool_calls = false;
  row.support_verbosity = false;
  row.supports_image_detail_original = vision;
  // A compatibility hash change makes Codex compact before the first turn on
  // the new model, even when the context window is nowhere near full. XwX does
  // not publish a provider-wide compact format, so do not inherit or invent a
  // hash for routed 兼容服务 models.
  delete row.comp_hash;

  // Never inherit OpenAI-only capabilities from the strict native template.
  // `max_output_tokens` and a model-level `supports_websockets` are not part of
  // the Codex model schema (websockets is a provider field); emitting them only
  // implies a contract Codex never reads.
  for (const key of [
    'additional_speed_tiers',
    'availability_nux',
    'default_service_tier',
    'max_output_tokens',
    'model_messages',
    'multi_agent_version',
    'service_tier',
    'service_tiers',
    'supports_reasoning_summaries',
    'supports_websockets',
    'tool_mode',
    'upgrade',
    'use_responses_lite',
    'web_search_tool_type'
  ]) delete row[key];
  return row;
}

function fallbackTemplate(): CatalogRow {
  return {
    slug: 'compatible-model',
    display_name: '兼容服务 model',
    description: '兼容服务 compatible model',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Lower reasoning effort' },
      { effort: 'medium', description: 'Balanced reasoning effort' },
      { effort: 'high', description: 'Higher reasoning effort' }
    ],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 0,
    base_instructions: 'You are a coding agent. Follow the user instructions, use the provided tools carefully, and report the completed result clearly.',
    supports_reasoning_summary_parameter: false,
    default_reasoning_summary: 'none',
    support_verbosity: false,
    default_verbosity: 'medium',
    apply_patch_tool_type: 'freeform',
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: false,
    experimental_supported_tools: [],
    input_modalities: ['text'],
    context_window: 262_144,
    max_context_window: 262_144,
    auto_compact_token_limit: 235_929,
    effective_context_window_percent: 95
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}

function verifiedCatalogReasoning(
  entry: ModelCatalogEntry,
  sourcedLevels: readonly string[]
): { readonly levels: string[]; readonly defaultLevel?: string } | undefined {
  const id = entry.id.trim().toLowerCase().replace(/^models\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  // OpenAI's API default for these models is `none`, but Codex is a coding
  // surface: shipping "no reasoning" as the default silently degrades every
  // task the user did not think to re-configure. Codex's own catalogs never
  // default to `none` either. Pin `medium` so neither a cached 兼容服务 row
  // nor an aggregator can move the default off it; the user can still pick
  // any sourced level, including `none`.
  if (/^gpt-5-(?:2|4)(?:-|$)/.test(id) && !/(?:codex)(?:-|$)/.test(id)) {
    return { levels: [...sourcedLevels], defaultLevel: sourcedLevels.includes('medium') ? 'medium' : undefined };
  }

  // Anthropic's effort availability table is authoritative for native
  // output_config.effort support. Older Claude models may still expose XwX's
  // synthetic thinking-budget controls, so leave their sourced levels alone.
  if (/^claude-(?:opus-4-6|sonnet-4-6)(?:-|$)/.test(id)) {
    return { levels: ['low', 'medium', 'high', 'max'], defaultLevel: 'high' };
  }
  if (/^claude-(?:opus-(?:4-7|4-8|5)|sonnet-5)(?:-|$)/.test(id)) {
    return { levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: 'high' };
  }

  // Whether a model reasons at all is the capability layer's call, not this
  // one's: a family regex would hand an effort picker to genuinely
  // non-reasoning members such as doubao-seed-character, which accepted every
  // parameter in the probe while never emitting a reasoning token. Models
  // measured as reasoning but missing the directories' flag belong in
  // `builtInModelCapabilityRegistry.ts` instead.
  if (!entry.protocols.includes('chat-completions')) return undefined;
  if (entry.reasoning !== true) return undefined;
  const profile = resolveCompatibleServiceReasoningProfile(entry.id);
  if (profile.levels) return { levels: [...profile.levels], defaultLevel: profile.defaultLevel };
  // A profile that takes an effort field but publishes no ladder of its own
  // (GPT and the o-series on the chat route) keeps whatever the capability
  // layer sourced. Note these models also appear on `/v1/models`, so they do
  // reach this branch — emptying their levels here silently removed the effort
  // picker for gpt-5.5 and the gpt-5.6 family.
  if (profile.supportsEffort) return undefined;
  // Reasoning is fixed on with no accepted control: no picker should be offered.
  return { levels: [] };
}
