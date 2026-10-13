export type ModelProtocol =
  | 'anthropic-messages' | 'openai-responses' | 'chat-completions' | 'gemini';
export type ModelCatalogEndpointKind = 'openai' | 'anthropic' | 'gemini';
export type ModelClient = 'claude' | 'codex';
export type ModelCapabilitySource = 'provider' | 'probed' | 'compatible' | 'official' | 'models.dev' | 'litellm' | 'builtin' | 'fallback';
export type ModelCapabilityField =
  | 'contextWindow'
  | 'maxOutputTokens'
  | 'inputModalities'
  | 'vision'
  | 'reasoning'
  | 'toolCalling'
  | 'structuredOutput'
  | 'interleavedThinking';

export interface ModelCatalogEntry {
  readonly id: string;
  readonly lifecycleStatus?: string;
  readonly runtimeRetired?: boolean;
  readonly providerPrice?: Readonly<Record<string, unknown>>;
  readonly displayName?: string;
  readonly modelVersion?: string;
  readonly created?: number;
  readonly domain?: string;
  readonly taskTypes?: readonly string[];
  readonly modelKind?: string;
  readonly providerFeatures?: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
  readonly maxInputTokens?: number;
  readonly maxReasoningTokens?: number;
  readonly outputModalities?: readonly string[];
  readonly temperature?: boolean;
  readonly reasoningOptions?: readonly unknown[];
  readonly interleavedField?: string;
  readonly vendor: string;
  readonly protocols: readonly ModelProtocol[];
  readonly protocolsDeclared?: boolean;
  readonly catalogEndpoints?: readonly ('openai' | 'anthropic' | 'gemini')[];
  readonly officialProtocols?: readonly ModelProtocol[];
  readonly vision?: boolean;
  readonly clients: readonly ModelClient[];
  readonly reasoningLevels?: readonly string[];
  readonly defaultReasoningLevel?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly inputModalities?: readonly string[];
  readonly reasoning?: boolean;
  readonly toolCalling?: boolean;
  readonly structuredOutput?: boolean;
  readonly interleavedThinking?: boolean;
  readonly capabilitySources?: Partial<Record<ModelCapabilityField, ModelCapabilitySource>>;
  readonly missingCapabilities?: readonly ModelCapabilityField[];
}
