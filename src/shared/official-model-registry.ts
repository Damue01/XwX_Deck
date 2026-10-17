import type { ModelProtocol } from './model-catalog';

export type ClaudeModelRole = 'fable' | 'opus' | 'sonnet' | 'haiku';
export type CodexRecommendedProtocol = 'responses' | 'chat-completions' | 'anthropic-messages';

export interface OfficialModelCapability {
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

export interface OfficialModelSource {
  readonly label: string;
  readonly url: string;
}

/**
 * Auditable model-owner facts used between 兼容服务 metadata and aggregator
 * fallbacks. An omitted field means the cited pages did not establish it.
 */
export interface OfficialModelRecord {
  readonly modelId: string;
  readonly vendor: string;
  readonly verifiedAt: `${number}-${number}-${number}`;
  readonly sources: readonly OfficialModelSource[];
  readonly capability: OfficialModelCapability;
  readonly protocols: readonly ModelProtocol[];
  readonly claudeOneMillionRoles: readonly ClaudeModelRole[];
  readonly codexRecommendedProtocol: CodexRecommendedProtocol;
}

const KIMI_MODELS = 'https://platform.kimi.com/docs/models';
const KIMI_CLAUDE_CODE = 'https://platform.kimi.com/docs/guide/claude-code-kimi';
const KIMI_RESPONSES = 'https://platform.kimi.com/docs/api/responses';
const KIMI_CODEX = 'https://platform.kimi.com/docs/guide/codex-kimi';
const GLM_52 = 'https://docs.z.ai/guides/llm/glm-5.2';
const GLM_CLAUDE_CODE = 'https://docs.z.ai/devpack/latest-model#switching-models-in-claude-code';
const DEEPSEEK_MODELS = 'https://api-docs.deepseek.com/quick_start/pricing';
const DEEPSEEK_CLAUDE_CODE = 'https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code';
const DEEPSEEK_RESPONSES = 'https://api-docs.deepseek.com/guides/responses_api/';
const DEEPSEEK_THINKING = 'https://api-docs.deepseek.com/guides/thinking_mode';

export const OFFICIAL_MODEL_REGISTRY: readonly OfficialModelRecord[] = [
  {
    modelId: 'deepseek-v4-pro',
    vendor: 'DeepSeek',
    verifiedAt: '2026-10-17',
    sources: [
      { label: 'DeepSeek Models & Pricing', url: DEEPSEEK_MODELS },
      { label: 'DeepSeek Claude Code integration', url: DEEPSEEK_CLAUDE_CODE },
      { label: 'DeepSeek Responses API', url: DEEPSEEK_RESPONSES },
      { label: 'DeepSeek Thinking Mode', url: DEEPSEEK_THINKING }
    ],
    capability: {
      contextWindow: 1_000_000,
      maxOutputTokens: 393_216,
      reasoning: true,
      levels: ['none', 'low', 'high', 'max'],
      defaultLevel: 'high',
      interleavedThinking: true,
      toolCalling: true,
      structuredOutput: true
    },
    protocols: ['openai-responses', 'chat-completions', 'anthropic-messages'],
    claudeOneMillionRoles: ['opus', 'sonnet'],
    codexRecommendedProtocol: 'responses'
  },
  {
    modelId: 'deepseek-v4-flash',
    vendor: 'DeepSeek',
    verifiedAt: '2026-10-17',
    sources: [
      { label: 'DeepSeek Models & Pricing', url: DEEPSEEK_MODELS },
      { label: 'DeepSeek Claude Code integration', url: DEEPSEEK_CLAUDE_CODE },
      { label: 'DeepSeek Responses API', url: DEEPSEEK_RESPONSES },
      { label: 'DeepSeek Thinking Mode', url: DEEPSEEK_THINKING }
    ],
    capability: {
      contextWindow: 1_000_000,
      maxOutputTokens: 393_216,
      reasoning: true,
      levels: ['none', 'low', 'high', 'max'],
      defaultLevel: 'high',
      interleavedThinking: true,
      toolCalling: true,
      structuredOutput: true
    },
    protocols: ['openai-responses', 'chat-completions', 'anthropic-messages'],
    claudeOneMillionRoles: [],
    codexRecommendedProtocol: 'responses'
  },
  {
    modelId: 'deepseek-flash',
    vendor: 'DeepSeek',
    verifiedAt: '2026-10-17',
    sources: [
      { label: 'DeepSeek Models & Pricing', url: DEEPSEEK_MODELS },
      { label: 'DeepSeek Responses API', url: DEEPSEEK_RESPONSES },
      { label: 'DeepSeek Thinking Mode', url: DEEPSEEK_THINKING }
    ],
    capability: {
      contextWindow: 1_000_000,
      maxOutputTokens: 393_216,
      reasoning: true,
      levels: ['none', 'low', 'high', 'max'],
      defaultLevel: 'high',
      interleavedThinking: true,
      toolCalling: true,
      structuredOutput: true
    },
    protocols: ['openai-responses', 'chat-completions', 'anthropic-messages'],
    claudeOneMillionRoles: [],
    codexRecommendedProtocol: 'responses'
  },
  {
    modelId: 'glm-5.3',
    vendor: '智谱',
    verifiedAt: '2026-10-12',
    sources: [
      { label: 'GLM-5.3 model guide', url: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3' },
      { label: 'BigModel Responses API', url: 'https://docs.bigmodel.cn/cn/guide/develop/responses/introduction' },
      { label: 'BigModel Claude API compatibility', url: 'https://docs.bigmodel.cn/cn/guide/develop/claude/introduction' }
    ],
    capability: {
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      inputModalities: ['text'],
      vision: false,
      reasoning: true,
      levels: ['low', 'high', 'max'],
      toolCalling: true
    },
    protocols: ['openai-responses', 'chat-completions', 'anthropic-messages'],
    claudeOneMillionRoles: [],
    codexRecommendedProtocol: 'responses'
  },
  {
    modelId: 'glm-5.2',
    vendor: '智谱',
    verifiedAt: '2026-07-28',
    sources: [
      { label: 'GLM-5.2 model guide', url: GLM_52 },
      { label: 'Z.AI Claude Code model switching', url: GLM_CLAUDE_CODE }
    ],
    capability: {
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      inputModalities: ['text'],
      vision: false,
      reasoning: true,
      toolCalling: true
    },
    protocols: ['chat-completions', 'anthropic-messages'],
    claudeOneMillionRoles: ['opus', 'sonnet'],
    codexRecommendedProtocol: 'chat-completions'
  },
  {
    modelId: 'kimi-k3',
    vendor: 'Kimi',
    verifiedAt: '2026-10-17',
    sources: [
      { label: 'Kimi model catalog', url: KIMI_MODELS },
      { label: 'Kimi Responses API', url: KIMI_RESPONSES },
      { label: 'Kimi Codex integration', url: KIMI_CODEX },
      { label: 'Kimi Claude Code integration', url: KIMI_CLAUDE_CODE }
    ],
    capability: {
      contextWindow: 1_048_576,
      inputModalities: ['text', 'image', 'video'],
      vision: true,
      reasoning: true,
      levels: ['low', 'high', 'max'],
      defaultLevel: 'max',
      interleavedThinking: true,
      toolCalling: true
    },
    protocols: ['openai-responses', 'chat-completions', 'anthropic-messages'],
    claudeOneMillionRoles: ['fable', 'opus', 'sonnet', 'haiku'],
    codexRecommendedProtocol: 'responses'
  },
  {
    modelId: 'kimi-k2.7-code',
    vendor: 'Kimi',
    verifiedAt: '2026-10-17',
    sources: [
      { label: 'Kimi model catalog', url: KIMI_MODELS },
      { label: 'Kimi Claude Code integration', url: KIMI_CLAUDE_CODE }
    ],
    capability: {
      contextWindow: 262_144,
      reasoning: true,
      interleavedThinking: true,
      toolCalling: true
    },
    protocols: ['chat-completions', 'anthropic-messages'],
    claudeOneMillionRoles: [],
    codexRecommendedProtocol: 'chat-completions'
  },
  {
    modelId: 'kimi-k2.6',
    vendor: 'Kimi',
    verifiedAt: '2026-10-17',
    sources: [
      { label: 'Kimi model catalog', url: KIMI_MODELS },
      { label: 'Kimi Claude Code integration', url: KIMI_CLAUDE_CODE }
    ],
    capability: {
      contextWindow: 262_144,
      inputModalities: ['text', 'image'],
      vision: true,
      reasoning: true,
      interleavedThinking: true,
      toolCalling: true
    },
    protocols: ['chat-completions', 'anthropic-messages'],
    claudeOneMillionRoles: [],
    codexRecommendedProtocol: 'chat-completions'
  },
  {
    modelId: 'kimi-k2.5',
    vendor: 'Kimi',
    verifiedAt: '2026-10-17',
    sources: [
      { label: 'Kimi model catalog', url: KIMI_MODELS },
      { label: 'Kimi Claude Code integration', url: KIMI_CLAUDE_CODE }
    ],
    capability: {
      contextWindow: 262_144,
      inputModalities: ['text', 'image'],
      vision: true,
      reasoning: true,
      interleavedThinking: true,
      toolCalling: true
    },
    protocols: ['chat-completions', 'anthropic-messages'],
    claudeOneMillionRoles: [],
    codexRecommendedProtocol: 'chat-completions'
  }
];

const OFFICIAL_BY_ID = new Map(
  OFFICIAL_MODEL_REGISTRY.map(record => [canonicalModelId(record.modelId), record] as const)
);

export function findOfficialModelRecord(modelId: string): OfficialModelRecord | undefined {
  return OFFICIAL_BY_ID.get(canonicalModelId(modelId));
}

function canonicalModelId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^models\//, '');
  const slash = normalized.lastIndexOf('/');
  const bare = slash === -1 ? normalized : normalized.slice(slash + 1);
  // DeepSeek V4 build/date snapshots (`deepseek-v4-pro-0813`,
  // `deepseek-v4-pro-ga-260813`) share one official capability contract with
  // the base id (`deepseek-v4-pro`). Collapse a trailing `-<date>` or
  // `-ga-<date>` build suffix so a snapshot id resolves to its base record.
  const base = bare.replace(/(?:-ga)?-\d{4,8}$/, '');
  return base.replace(/[^a-z0-9]/g, '');
}
