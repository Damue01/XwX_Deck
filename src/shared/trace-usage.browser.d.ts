export function normalizeTraceUsage(raw: unknown, protocol: string, inclusiveOverride?: boolean, request?: unknown): {
  inputTokens?: number; inputUncachedTokens?: number; inputTotalTokens?: number;
  outputTokens?: number; totalTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number;
  cacheCreation5mTokens?: number; cacheCreation1hTokens?: number; reasoningTokens?: number;
  inputIncludesCache?: boolean;
  incompleteFields?: Array<'input' | 'cacheRead' | 'cacheWrite' | 'output' | 'total'>;
  invalidFields?: string[];
  optionalDefaults?: Array<'input' | 'cacheRead' | 'cacheWrite' | 'output' | 'total'>;
  derivedFields?: Array<'input' | 'cacheRead' | 'cacheWrite' | 'output' | 'total' | 'cacheWriteTtl'>;
} | undefined;
