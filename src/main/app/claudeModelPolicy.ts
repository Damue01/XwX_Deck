import type { ClaudeModelSettings } from './settings';
import type { ModelCatalogEntry } from './modelCatalog';
import { findOfficialModelRecord, type ClaudeModelRole } from './officialModelRegistry';

/**
 * Claude Code model-routing fields that belong to the active model service.
 *
 * This follows CC Switch's live-takeover field set. In particular, a stale
 * ANTHROPIC_MODEL pins the client to the previous provider's model and makes
 * all four role mappings appear ineffective.
 */
export const CLAUDE_MODEL_OVERRIDE_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_FAST_MODEL',
  'ANTHROPIC_REASONING_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
] as const;

/** Complete model field values for a live 兼容服务 configuration. */
export function claudeCompatibleServiceModelEnv(
  models: ClaudeModelSettings,
  catalog: readonly ModelCatalogEntry[] = [],
  selectedModel?: unknown
): Readonly<Record<string, string>> {
  const contextWindows = new Map(catalog.map(entry => [entry.id, entry.contextWindow] as const));
  const values: Record<string, string> = {};
  addRole(values, 'FABLE', modelWithContextVariant(models.fable, contextWindows, 'fable'));
  addRole(values, 'OPUS', modelWithContextVariant(models.opus, contextWindows, 'opus'));
  addRole(values, 'SONNET', modelWithContextVariant(models.sonnet, contextWindows, 'sonnet'));
  addRole(values, 'HAIKU', modelWithContextVariant(models.haiku, contextWindows, 'haiku'));
  const activeContextWindow = contextWindows.get(selectedModelId(selectedModel, models));
  if (activeContextWindow !== undefined) {
    values.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(activeContextWindow);
  }
  return values;
}

function selectedModelId(selectedModel: unknown, models: ClaudeModelSettings): string {
  const selected = typeof selectedModel === 'string' ? selectedModel.trim() : '';
  const role = /^(fable|opus|sonnet|haiku)(?:\[1m\])?$/i.exec(selected)?.[1]?.toLowerCase();
  if (role === 'fable') return stripContextVariant(models.fable);
  if (role === 'opus') return stripContextVariant(models.opus);
  if (role === 'haiku') return stripContextVariant(models.haiku);
  if (role === 'sonnet') return stripContextVariant(models.sonnet);
  // Claude Code defaults to the Sonnet role when the user has not selected a
  // top-level model. A direct custom model ID remains valid as well.
  return stripContextVariant(selected || models.sonnet);
}

function stripContextVariant(model: string): string {
  return model.trim().replace(/\[1m\]$/i, '').trim();
}

function modelWithContextVariant(
  model: string,
  contextWindows: ReadonlyMap<string, number | undefined>,
  role: ClaudeModelRole
): string {
  const value = model.trim();
  if (!value) return '';
  const hasExtendedContext = /\[1m\]$/i.test(value);
  const baseModel = stripContextVariant(value);
  const contextWindow = contextWindows.get(baseModel);
  if (contextWindow !== undefined) {
    if (contextWindow < 1_000_000) return baseModel;
    const official = findOfficialModelRecord(baseModel);
    const supportsRole = official
      ? official.claudeOneMillionRoles.includes(role)
      : role === 'opus' || role === 'sonnet';
    return supportsRole ? `${baseModel}[1m]` : baseModel;
  }
  // Preserve an explicit selection when the service did not publish enough
  // metadata to make a safer decision.
  return hasExtendedContext ? `${baseModel}[1m]` : baseModel;
}

function addRole(values: Record<string, string>, role: 'FABLE' | 'OPUS' | 'SONNET' | 'HAIKU', model: string): void {
  const value = model.trim();
  if (!value) return;
  values[`ANTHROPIC_DEFAULT_${role}_MODEL`] = value;
  // Prevent a stale provider display name from making a successful switch look
  // ineffective. Until richer catalog labels exist, the model ID is truthful.
  values[`ANTHROPIC_DEFAULT_${role}_MODEL_NAME`] = value;
}
