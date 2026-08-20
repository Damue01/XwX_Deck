/**
 * Release-bundled model capability baseline.
 *
 * 兼容服务 decides only whether a model id exists for the current connection
 * and which native protocol endpoint exposes it. Capability fields from the
 * 兼容服务 model response are intentionally ignored. This registry provides a
 * useful offline/default baseline; owner metadata from models.dev/LiteLLM can
 * update individual fields after startup.
 */
export interface BuiltInModelCapability {
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly inputModalities?: readonly string[];
  readonly vision?: boolean;
  readonly reasoning?: boolean;
  readonly levels?: readonly string[];
  readonly defaultLevel?: string;
  readonly toolCalling?: boolean;
  readonly structuredOutput?: boolean;
  readonly interleavedThinking?: boolean;
}

export interface BuiltInModelCapabilityRegistry {
  readonly version: 1;
  readonly verifiedAt: string;
  readonly models: Readonly<Record<string, BuiltInModelCapability>>;
}

const visual = (...inputModalities: string[]): BuiltInModelCapability => ({
  inputModalities,
  vision: true
});

export const BUILT_IN_MODEL_CAPABILITY_REGISTRY: BuiltInModelCapabilityRegistry = {
  version: 1,
  verifiedAt: '2026-08-18',
  models: {
    'claude-haiku-4-5': visual('text', 'image', 'pdf'),
    'claude-haiku-4-5-20251001': visual('text', 'image', 'pdf'),
    'claude-opus-4-6': visual('text', 'image', 'pdf'),
    'claude-opus-4-7': visual('text', 'image', 'pdf'),
    'claude-opus-4-8': visual('text', 'image', 'pdf'),
    'claude-opus-5': visual('text', 'image', 'pdf'),
    'claude-sonnet-4-6': visual('text', 'image', 'pdf'),
    'claude-sonnet-4.5': visual('text', 'image', 'pdf'),
    'claude-sonnet-5': visual('text', 'image', 'pdf'),
    'doubao-seed-1-6-flash': visual('text', 'image'),
    'doubao-seed-1-6-vision': visual('text', 'image'),
    'doubao-seed-2-0-code-preview': visual('text', 'image', 'video'),
    'doubao-seed-2-0-lite': visual('text', 'image', 'video'),
    'doubao-seed-2-0-mini': visual('text', 'image', 'video'),
    'doubao-seed-2-0-pro': visual('text', 'image', 'video'),
    'doubao-seed-2-1-pro': visual('text', 'image', 'video'),
    'doubao-seed-2-1-turbo': visual('text', 'image', 'video'),
    'doubao-seed-character': visual('text', 'image'),
    'glm-5v-turbo': visual('text', 'image', 'video', 'pdf'),
    'gpt-5.2': visual('text', 'image'),
    'gpt-5.2-codex': visual('text', 'image'),
    'gpt-5.3-codex': visual('text', 'image', 'pdf'),
    'gpt-5.4': visual('text', 'image', 'pdf'),
    'gpt-5.4-mini': visual('text', 'image'),
    'gpt-5.4-nano': visual('text', 'image'),
    'gpt-5.5': visual('text', 'image', 'pdf'),
    'gpt-5.6-luna': {
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      inputModalities: ['text', 'image', 'pdf'],
      vision: true,
      reasoning: true,
      levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultLevel: 'medium',
      toolCalling: true,
      structuredOutput: true
    },
    'gpt-5.6-sol': {
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      inputModalities: ['text', 'image', 'pdf'],
      vision: true,
      reasoning: true,
      levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultLevel: 'low',
      toolCalling: true,
      structuredOutput: true
    },
    'gpt-5.6-terra': {
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      inputModalities: ['text', 'image', 'pdf'],
      vision: true,
      reasoning: true,
      levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultLevel: 'medium',
      toolCalling: true,
      structuredOutput: true
    },
    'grok-4.20-0309-non-reasoning': visual('text', 'image', 'pdf'),
    'grok-4.20-0309-reasoning': visual('text', 'image', 'pdf'),
    'grok-4.3': visual('text', 'image', 'pdf'),
    'grok-4.5': visual('text', 'image', 'pdf'),
    'grok-4.6': visual('text', 'image', 'pdf'),
    'kimi-k2.5': visual('text', 'image'),
    'kimi-k2.6': visual('text', 'image'),
    'kimi-k2.7-code': visual('text', 'image', 'video'),
    'kimi-k3': visual('text', 'image', 'video'),
    'kimi-k3-external': visual('text', 'image', 'video'),
    'minimax-m3': visual('text', 'image', 'video'),
    'qwen3-vl-plus': visual('text', 'image'),
    'qwen3.5-flash': visual('text', 'image', 'video'),
    'qwen3.5-plus': visual('text', 'image', 'video'),
    'qwen3.6-plus': visual('text', 'image', 'video'),
    'qwen3.7-plus': visual('text', 'image', 'video'),
    'qwen3.8-max': visual('text', 'image', 'video', 'pdf')
  }
};

export function findBuiltInModelCapability(modelId: string): BuiltInModelCapability | undefined {
  return BUILT_IN_MODEL_CAPABILITY_REGISTRY.models[modelId.trim().toLowerCase().replace(/^models\//, '')];
}
