import type { ModelProtocol } from './modelCatalog';

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
const GLM_52 = 'https://docs.z.ai/guides/llm/glm-5.2';
const GLM_CLAUDE_CODE = 'https://docs.z.ai/devpack/latest-model#switching-models-in-claude-code';
const DEEPSEEK_MODELS = 'https://api-docs.deepseek.com/quick_start/pricing';
const DEEPSEEK_CLAUDE_CODE = 'https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code';
const VOLCENGINE_ARK = 'https://www.volcengine.com/docs/82379';
const DEEPSEEK_RESPONSES = 'https://api-docs.deepseek.com/guides/responses_api/';

export const OFFICIAL_MODEL_REGISTRY: readonly OfficialModelRecord[] = [
  {
    modelId: 'deepseek-v4-flash-260425',
    vendor: '火山方舟',
    verifiedAt: '2026-08-18',
    sources: [{ label: 'Volcengine Ark Responses API', url: VOLCENGINE_ARK }],
    capability: {
      inputModalities: ['text'],
      reasoning: true,
      toolCalling: true
    },
    protocols: ['openai-responses'],
    claudeOneMillionRoles: [],
    codexRecommendedProtocol: 'responses'
  },
  {
    modelId: 'doubao-seed-2-1-turbo-260628',
    vendor: '火山方舟',
    verifiedAt: '2026-08-18',
    sources: [{ label: 'Volcengine Ark Chat Completions API', url: VOLCENGINE_ARK }],
    capability: {
      inputModalities: ['text', 'image'],
      vision: true
    },
    protocols: ['chat-completions'],
    claudeOneMillionRoles: [],
    codexRecommendedProtocol: 'chat-completions'
  },
  {
    modelId: 'deepseek-v4-pro',
    vendor: 'DeepSeek',
    verifiedAt: '2026-09-24',
    sources: [
      { label: 'DeepSeek Models & Pricing', url: DEEPSEEK_MODELS },
      { label: 'DeepSeek Claude Code integration', url: DEEPSEEK_CLAUDE_CODE },
      { label: 'DeepSeek Responses API', url: DEEPSEEK_RESPONSES }
    ],
    capability: {
      contextWindow: 1_000_000,
      maxOutputTokens: 393_216,
      reasoning: true,
      levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultLevel: 'high',
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
    verifiedAt: '2026-09-24',
    sources: [
      { label: 'DeepSeek Models & Pricing', url: DEEPSEEK_MODELS },
      { label: 'DeepSeek Claude Code integration', url: DEEPSEEK_CLAUDE_CODE },
      { label: 'DeepSeek Responses API', url: DEEPSEEK_RESPONSES }
    ],
    capability: {
      contextWindow: 1_000_000,
      maxOutputTokens: 393_216,
      reasoning: true,
      levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultLevel: 'high',
      toolCalling: true,
      structuredOutput: true
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
    verifiedAt: '2026-07-28',
    sources: [
      { label: 'Kimi model catalog', url: KIMI_MODELS },
      { label: 'Kimi Claude Code integration', url: KIMI_CLAUDE_CODE }
    ],
    capability: {
      contextWindow: 1_048_576,
      inputModalities: ['text', 'image', 'video'],
      vision: true,
      reasoning: true,
      toolCalling: true
    },
    protocols: ['chat-completions', 'anthropic-messages'],
    claudeOneMillionRoles: ['fable', 'opus', 'sonnet', 'haiku'],
    codexRecommendedProtocol: 'chat-completions'
  },
  {
    modelId: 'kimi-k2.7-code',
    vendor: 'Kimi',
    verifiedAt: '2026-07-28',
    sources: [{ label: 'Kimi model catalog', url: KIMI_MODELS }],
    capability: {
      contextWindow: 262_144,
      reasoning: true,
      toolCalling: true
    },
    protocols: ['chat-completions'],
    claudeOneMillionRoles: [],
    codexRecommendedProtocol: 'chat-completions'
  },
  {
    modelId: 'kimi-k2.6',
    vendor: 'Kimi',
    verifiedAt: '2026-07-28',
    sources: [{ label: 'Kimi model catalog', url: KIMI_MODELS }],
    capability: {
      contextWindow: 262_144,
      inputModalities: ['text', 'image'],
      vision: true,
      reasoning: true,
      toolCalling: true
    },
    protocols: ['chat-completions'],
    claudeOneMillionRoles: [],
    codexRecommendedProtocol: 'chat-completions'
  },
  {
    modelId: 'kimi-k2.5',
    vendor: 'Kimi',
    verifiedAt: '2026-07-28',
    sources: [{ label: 'Kimi model catalog', url: KIMI_MODELS }],
    capability: {
      contextWindow: 262_144,
      inputModalities: ['text', 'image'],
      vision: true,
      reasoning: true,
      toolCalling: true
    },
    protocols: ['chat-completions'],
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
