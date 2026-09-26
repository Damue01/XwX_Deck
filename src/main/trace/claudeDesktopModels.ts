import { createHash } from 'crypto';
import type { ModelCatalogEntry } from '../app/modelCatalog';
import type { ClaudeModelSettings } from '../app/settings';

export interface ClaudeDesktopModel {
  readonly id: string;
  readonly name: string;
  readonly legacyName?: string;
  readonly label: string;
  readonly tier: keyof ClaudeModelSettings;
  readonly isFamilyDefault: boolean;
  readonly supports1m: boolean;
}

export function buildClaudeDesktopModels(
  catalog: readonly ModelCatalogEntry[],
  defaults: ClaudeModelSettings
): ClaudeDesktopModel[] {
  const conversational = catalog.filter(entry => (
    entry.protocols.includes('anthropic-messages')
    && entry.clients.includes('claude')
    && entry.id.trim().length > 0
  ));
  const roles = new Map<string, keyof ClaudeModelSettings>();
  for (const role of ['fable', 'opus', 'sonnet', 'haiku'] as const) {
    const id = defaults[role].trim();
    if (id && !roles.has(id)) roles.set(id, role);
  }
  const unique = conversational
    .filter((entry, index, list) => list.findIndex(other => other.id === entry.id) === index)
    .sort((a, b) => a.id.localeCompare(b.id));
  const usedNames = new Set(
    unique
      .map(entry => entry.id)
      .filter(isClaudeDesktopCompatibleModelId)
  );
  const legacyNames = new Set(usedNames);
  return unique
    .map(entry => {
      const tier = roles.get(entry.id) ?? inferTier(entry.id);
      const name = claudeDesktopModelName(entry.id, usedNames);
      return {
        id: entry.id,
        name,
        ...(name !== entry.id ? { legacyName: claudeDesktopModelName(entry.id, legacyNames, true) } : {}),
        label: entry.id,
        tier,
        isFamilyDefault: roles.has(entry.id),
        supports1m: entry.contextWindow !== undefined && entry.contextWindow >= 1_000_000
      };
    });
}

export function claudeDesktopNeedsLocalGateway(models: readonly ClaudeDesktopModel[]): boolean {
  return models.some(model => model.name !== model.id);
}

export function buildClaudeDesktopModelAliases(models: readonly ClaudeDesktopModel[]): Record<string, string> {
  const aliases: Record<string, string> = {};
  const originalIds = new Set(models.map(model => model.id));
  for (const model of models) {
    if (model.name === model.id) continue;
    for (const name of [model.name, model.legacyName]) {
      if (!name) continue;
      // Existing conversations retain their old route name. Never let a
      // compatibility alias take over an actual model published by the service.
      if (!originalIds.has(name)) aliases[name] = model.id;
      if (model.supports1m && !originalIds.has(`${name}[1m]`)) aliases[`${name}[1m]`] = model.id;
    }
  }
  return aliases;
}

function claudeDesktopModelName(
  modelId: string,
  usedNames: Set<string>,
  legacy = false
): string {
  if (isClaudeDesktopCompatibleModelId(modelId)) return modelId;
  // Claude Desktop rejects gateway route names containing other vendors'
  // names, even when they start with "claude-". Keep the actual model ID in
  // labelOverride and in the Gateway alias map, never in this route name.
  const numericId = BigInt(`0x${createHash('sha256').update(modelId).digest('hex').slice(0, 32)}`).toString(10);
  // Desktop strips a numeric -v<version>[:revision] suffix when looking up
  // thinking controls. A plain long numeric suffix passes its vendor check
  // but is unrecognized, so it hides the effort menu (verified on 2.7032.0.0).
  // Keep the full hash: shortening it to a date-shaped suffix risks collisions.
  const base = `claude-sonnet-4-6-${legacy ? '' : 'v'}${numericId}`;
  let name = base;
  let suffix = 2;
  while (usedNames.has(name)) name = `${base}${legacy ? '-' : ':'}${suffix++}`;
  usedNames.add(name);
  return name;
}

function isClaudeDesktopCompatibleModelId(modelId: string): boolean {
  const value = modelId.trim().toLowerCase();
  // Desktop 2.2553.1.0 rejects these vendor tokens even inside a name that
  // starts with "claude-". This is a client-side heuristic, not an API contract.
  if (/ark-code|astron|command-r|deepseek|doubao|gemini|gemma|glm|gpt|grok|hermes|hy3|kimi|lfm|\bling\b|llama|longcat|mimo|minimax|mistral|mixtral|moonshot|nemotron|openai|phi-|qianfan|qwen|tc-code|\bunic\b|yi-|stepfun|step-3|seed-|bytedance|hunyuan|granite|amazon\.nova|nova-|devstral|ministral|ernie|codex|arcee|trinity|abab|phi\d|\bk2\.|\bm2\.|jamba|arctic|solar|mercury|zamba|kat-coder|\bds-|dpsk/.test(value)) {
    return false;
  }
  return /^claude-(?:haiku|sonnet|opus|fable|mythos)(?:[-.@:]|$)/.test(value)
    || /(?:^|[./])anthropic\.claude-(?:haiku|sonnet|opus|fable|mythos)(?:[-.@:]|$)/.test(value);
}

function inferTier(modelId: string): keyof ClaudeModelSettings {
  const value = modelId.toLowerCase();
  if (value.includes('fable')) return 'fable';
  if (value.includes('opus')) return 'opus';
  if (value.includes('haiku')) return 'haiku';
  return 'sonnet';
}
