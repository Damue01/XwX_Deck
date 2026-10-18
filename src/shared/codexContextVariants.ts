export const CODEX_STANDARD_LONG_CONTEXT_WINDOW = 262_144;
export const CODEX_EXTENDED_CONTEXT_WINDOW = 1_000_000;
/** Codex accepts an explicit operational window in this safe range. */
export const CODEX_MIN_CONTEXT_WINDOW = 16_384;
export const CODEX_MAX_CONTEXT_WINDOW = 2_000_000;

export interface CodexContextCapableModel {
  readonly id: string;
  readonly contextWindow?: number;
  readonly codexContextWindow?: number;
  readonly codexContextWindowSource?: string;
  readonly capabilitySources?: {
    readonly contextWindow?: string;
  };
}

export interface CodexContextVariant {
  readonly modelId: string;
  readonly label: string;
  /** `null` means remove XwX's explicit Codex context override. */
  readonly contextWindow: number | null;
}

/**
 * GPT models use the current client's default and an optional 1M override.
 * The default never freezes a client window in config.toml. The suffix is display-only:
 * config.toml and upstream requests keep the canonical model id.
 */
export function codexContextVariants(model: CodexContextCapableModel): readonly CodexContextVariant[] {
  const modelId = model.id.trim();
  const verifiedWindow = verifiedContextWindow(model);
  const defaultWindow = codexDefaultContextWindow(model);
  if (!isGptModel(modelId)) {
    return [{ modelId, label: modelId, contextWindow: null }];
  }

  if ((verifiedWindow ?? 0) >= CODEX_EXTENDED_CONTEXT_WINDOW) {
    const choices: CodexContextVariant[] = [
      {
        modelId,
        label: defaultWindow === undefined ? modelId : `${modelId}[${formatContextWindow(defaultWindow)}]`,
        contextWindow: null
      }
    ];
    if (defaultWindow === undefined || defaultWindow < CODEX_EXTENDED_CONTEXT_WINDOW) choices.push({
        modelId,
        label: `${modelId}[${formatContextWindow(CODEX_EXTENDED_CONTEXT_WINDOW)}]`,
        contextWindow: CODEX_EXTENDED_CONTEXT_WINDOW
    });
    return choices;
  }

  return [{
    modelId,
    label: defaultWindow === undefined ? modelId : `${modelId}[${formatContextWindow(defaultWindow)}]`,
    contextWindow: null
  }];
}

/** The current operational default, without a fixed historical 256K ceiling. */
export function codexDefaultContextWindow(model: CodexContextCapableModel): number | undefined {
  const verifiedWindow = verifiedContextWindow(model);
  if (Number.isSafeInteger(model.codexContextWindow) && (model.codexContextWindow ?? 0) > 0
    && model.codexContextWindowSource !== 'fallback'
    && model.codexContextWindowSource !== 'models.dev'
    && (verifiedWindow !== undefined || ['codex', 'provider'].includes(model.codexContextWindowSource ?? ''))) {
    return verifiedWindow === undefined ? model.codexContextWindow : Math.min(model.codexContextWindow!, verifiedWindow);
  }
  // Capacity is not an operational recommendation. Unknown defaults stay
  // automatic instead of offering 1050K as another default next to 1M.
  return undefined;
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
  const normalized = modelId.trim().toLowerCase().split('/').at(-1) ?? '';
  return /^gpt(?:[-.]|$)/.test(normalized);
}
