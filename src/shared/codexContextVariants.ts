export const CODEX_STANDARD_LONG_CONTEXT_WINDOW = 272_000;
export const CODEX_EXTENDED_CONTEXT_WINDOW = 1_000_000;

export interface CodexContextCapableModel {
  readonly id: string;
  readonly contextWindow?: number;
  readonly capabilitySources?: {
    readonly contextWindow?: string;
  };
}

export interface CodexContextVariant {
  readonly modelId: string;
  readonly label: string;
  /** `null` means remove XwX Deck's explicit Codex context override. */
  readonly contextWindow: number | null;
}

/**
 * GPT models whose maintained capability reaches 1M expose the standard Codex
 * window and the opt-in 1M window as two UI choices. The suffix is display-only:
 * config.toml and upstream requests keep the canonical model id.
 */
export function codexContextVariants(model: CodexContextCapableModel): readonly CodexContextVariant[] {
  const modelId = model.id.trim();
  const verifiedWindow = verifiedContextWindow(model);
  if (!isGptModel(modelId) || verifiedWindow === undefined) {
    return [{ modelId, label: modelId, contextWindow: null }];
  }

  if (verifiedWindow >= CODEX_EXTENDED_CONTEXT_WINDOW) {
    return [
      {
        modelId,
        label: `${modelId}[${formatContextWindow(CODEX_STANDARD_LONG_CONTEXT_WINDOW)}]`,
        contextWindow: CODEX_STANDARD_LONG_CONTEXT_WINDOW
      },
      {
        modelId,
        label: `${modelId}[${formatContextWindow(CODEX_EXTENDED_CONTEXT_WINDOW)}]`,
        contextWindow: CODEX_EXTENDED_CONTEXT_WINDOW
      }
    ];
  }

  return [{
    modelId,
    label: `${modelId}[${formatContextWindow(verifiedWindow)}]`,
    contextWindow: null
  }];
}

/** Default operational window written into XwX Deck's compatible Codex catalog. */
export function codexDefaultContextWindow(model: CodexContextCapableModel): number | undefined {
  const verifiedWindow = verifiedContextWindow(model);
  if (verifiedWindow === undefined) return undefined;
  return isGptModel(model.id) && verifiedWindow >= CODEX_EXTENDED_CONTEXT_WINDOW
    ? CODEX_STANDARD_LONG_CONTEXT_WINDOW
    : verifiedWindow;
}

export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 100_000 === 0) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (tokens % 1_024 === 0) return `${tokens / 1_024}K`;
  if (tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return tokens.toLocaleString('en-US');
}

function verifiedContextWindow(model: CodexContextCapableModel): number | undefined {
  const value = model.contextWindow;
  if (!Number.isInteger(value) || (value ?? 0) <= 0) return undefined;
  if (model.capabilitySources?.contextWindow === 'fallback') return undefined;
  return value;
}

function isGptModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase().replace(/^models\//, '');
  return /^gpt(?:[-.]|$)/.test(normalized);
}
