import * as path from 'path';
import { readTextOrUndefined } from '../shared/fsx';
import { resolveClientPaths } from '../trace/clientConfig';
import { findBuiltInModelCapability } from './builtInModelCapabilityRegistry';
import type {
  ModelCapabilityField,
  ModelCapabilitySource,
  ModelCatalogEntry
} from './modelCatalog';

type NativeModelRow = Record<string, unknown>;

/**
 * Reads Codex's own downloaded model directory. XwX never writes this file;
 * keeping the official picker on this source lets new Codex models appear
 * without shipping a second official model catalog.
 */
export async function readCodexOfficialModelCatalog(
  configuredModelId?: string
): Promise<readonly ModelCatalogEntry[]> {
  const cachePath = path.join(path.dirname(resolveClientPaths().codexConfigPath), 'models_cache.json');
  const text = await readTextOrUndefined(cachePath);
  const entries: ModelCatalogEntry[] = [];
  if (text) {
    try {
      const parsed = JSON.parse(text) as { models?: unknown };
      if (Array.isArray(parsed.models)) {
        for (const value of parsed.models) {
          if (!isRecord(value)) continue;
          const entry = officialEntry(value);
          if (entry) entries.push(entry);
        }
      }
    } catch {
      // A damaged or partially-written Codex cache falls back to the selected model.
    }
  }

  const configured = configuredModelId?.trim();
  if (configured && !entries.some(entry => entry.id === configured)) {
    entries.push(configuredOfficialEntry(configured));
  }
  return entries;
}

function officialEntry(row: NativeModelRow): ModelCatalogEntry | undefined {
  const id = cleanString(row.slug);
  if (!id || row.visibility !== 'list' || row.supported_in_api !== true) return undefined;
  const builtin = findBuiltInModelCapability(id);
  const contextWindow = builtin?.contextWindow ?? positiveInt(row.context_window);
  const inputModalities = builtin?.inputModalities ?? stringArray(row.input_modalities);
  const reasoningLevels = nativeReasoningLevels(row.supported_reasoning_levels);
  const defaultReasoningLevel = cleanString(row.default_reasoning_level);
  const capabilitySources: Partial<Record<ModelCapabilityField, ModelCapabilitySource>> = {};
  if (contextWindow !== undefined) capabilitySources.contextWindow = builtin?.contextWindow !== undefined ? 'builtin' : 'official';
  if (builtin?.maxOutputTokens !== undefined) capabilitySources.maxOutputTokens = 'builtin';
  if (inputModalities?.length) capabilitySources.inputModalities = builtin?.inputModalities ? 'builtin' : 'official';
  if (builtin?.vision !== undefined) capabilitySources.vision = 'builtin';
  if (builtin?.reasoning !== undefined) capabilitySources.reasoning = 'builtin';
  if (builtin?.toolCalling !== undefined) capabilitySources.toolCalling = 'builtin';
  if (builtin?.structuredOutput !== undefined) capabilitySources.structuredOutput = 'builtin';

  return {
    id,
    vendor: 'OpenAI',
    protocols: ['openai-responses'],
    clients: ['codex'],
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(builtin?.maxOutputTokens !== undefined ? { maxOutputTokens: builtin.maxOutputTokens } : {}),
    ...(inputModalities?.length ? { inputModalities } : {}),
    ...(builtin?.vision !== undefined ? { vision: builtin.vision } : {}),
    ...(builtin?.reasoning !== undefined ? { reasoning: builtin.reasoning } : {}),
    ...(builtin?.toolCalling !== undefined ? { toolCalling: builtin.toolCalling } : {}),
    ...(builtin?.structuredOutput !== undefined ? { structuredOutput: builtin.structuredOutput } : {}),
    ...(reasoningLevels.length ? { reasoningLevels } : {}),
    ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
    ...(Object.keys(capabilitySources).length ? { capabilitySources } : {})
  };
}

function configuredOfficialEntry(id: string): ModelCatalogEntry {
  const builtin = findBuiltInModelCapability(id);
  const capabilitySources: Partial<Record<ModelCapabilityField, ModelCapabilitySource>> = {};
  if (builtin?.contextWindow !== undefined) capabilitySources.contextWindow = 'builtin';
  if (builtin?.maxOutputTokens !== undefined) capabilitySources.maxOutputTokens = 'builtin';
  if (builtin?.inputModalities?.length) capabilitySources.inputModalities = 'builtin';
  return {
    id,
    vendor: '已配置',
    protocols: ['openai-responses'],
    clients: ['codex'],
    ...(builtin?.contextWindow !== undefined ? { contextWindow: builtin.contextWindow } : {}),
    ...(builtin?.maxOutputTokens !== undefined ? { maxOutputTokens: builtin.maxOutputTokens } : {}),
    ...(builtin?.inputModalities?.length ? { inputModalities: builtin.inputModalities } : {}),
    ...(Object.keys(capabilitySources).length ? { capabilitySources } : {})
  };
}

function nativeReasoningLevels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const levels: string[] = [];
  for (const item of value) {
    const effort = isRecord(item) ? cleanString(item.effort) : cleanString(item);
    if (effort && !levels.includes(effort)) levels.push(effort);
  }
  return levels;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean);
  return values.length ? values : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is NativeModelRow {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
