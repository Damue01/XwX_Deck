export type TapApiType = 'messages' | 'chat-completions' | 'responses' | 'unknown';

/**
 * 一条 trace 的来源客户端：决定 dashboard 行的 source 列、过滤器、session 边界。
 * - `copilot`：VS Code Copilot 走 CustomEndpoint（chatLanguageModels.json）
 * - `claude-cli`：Claude Code 终端 CLI（user-agent 命中 + system 第一段 cc_entrypoint=claude-code）
 * - `claude-vscode`：Claude Code VSCode 插件（与 CLI UA 完全相同，靠 system 第一段
 *   `cc_entrypoint=claude-vscode` 区分；2026-06-13 拆分，避免同台机器并行的 CLI/IDE 串号）
 * - `codex-cli`：Codex CLI 终端（user-agent 含 `codex-tui` / 老版 `codex_cli_rs`，请求头 originator=codex-tui）
 * - `codex-vscode`：Codex VSCode 插件（user-agent 含 `codex_vscode`，请求头 originator=codex_vscode；
 *   2026-06-13 拆分，避免同台机器并行的 CLI/IDE 实例首句一字不差时被同根归并）
 * - `unknown`：无路由匹配，兜底
 */
export type TapTraceSource = 'copilot' | 'claude-cli' | 'claude-vscode' | 'codex-cli' | 'codex-vscode' | 'unknown';

export type TapProtocol = 'anthropic-messages' | 'openai-chat-completions' | 'openai-responses' | 'unknown';
export type TapCaptureMode = 'custom-endpoint' | 'reverse-proxy' | 'forward-proxy' | 'transcript' | 'unknown';
export type TapUsageField = 'input' | 'cacheRead' | 'cacheWrite' | 'output' | 'total';

export type TapClientFamily = 'copilot' | 'claude' | 'codex' | 'unknown';
export type TapClientSurface = 'vscode' | 'cli' | 'desktop' | 'unknown';
export type TapClientIdentityConfidence = 'strong' | 'medium' | 'weak';

/**
 * Request-native client identity. Headers/body say who emitted the request;
 * routes only say where to forward it.
 */
export interface TapClientIdentity {
  readonly family: TapClientFamily;
  readonly surface: TapClientSurface;
  readonly source: TapTraceSource;
  readonly client: string;
  readonly confidence: TapClientIdentityConfidence;
  readonly evidence: readonly string[];
}

export interface TapRoute {
  readonly path: string;
  readonly apiType: TapApiType;
  readonly upstreamBaseUrl: string;
  readonly connectionId?: string;
  readonly modelId?: string;
  /** Route-specific system proxy resolved by the Electron manager. */
  readonly upstreamProxyUrl?: string;
}

/**
 * Client-anchored fallback 路由：claude/codex CLI 命中时用。跟 TapRoute 不同——
 * 它没有 model id（CLI 请求里的 model 跟 兼容服务 配置毫无关系），改靠 path + client。
 * 可选 stripPathPrefix：codex → openai.com 时要 strip 掉 /v1；
 * Claude 走 兼容服务 风格 /anthropic/v1/messages 时要 strip 掉 /anthropic，避免双重前缀。
 */
export interface TapClientRoute {
  readonly providerId?: string;
  readonly providerName?: string;
  readonly providerAdapter?: import('../../shared/providers').ProviderAdapter;
  readonly source: TapTraceSource;
  readonly path: string;
  readonly apiType: TapApiType;
  readonly upstreamBaseUrl: string;
  /** Route-specific system proxy resolved by the Electron manager. */
  readonly upstreamProxyUrl?: string;
  readonly stripPathPrefix?: '/v1' | '/anthropic' | '/claude-desktop' | '/backend-api' | '/backend-api/codex';
  /**
   * Codex always speaks Responses; non-Responses upstreams are bridged locally.
   * `messages-auto`: Claude speaks Messages; models whose resolved protocol is
   * Responses or Chat Completions are bridged to `openAiBaseUrl`.
   */
  readonly transform?: 'responses-to-chat' | 'responses-to-chat-auto' | 'responses-to-anthropic' | 'responses-compact-auto' | 'messages-auto';
  /** OpenAI-compatible base (ending before `/responses`) used by `messages-auto`. */
  readonly openAiBaseUrl?: string;
  /** Optional authoritative per-model wire protocol discovered from the service. */
  readonly modelProtocols?: Readonly<Record<string, 'responses' | 'chat-completions' | 'anthropic-messages'>>;
  /** Desktop picker aliases or remembered models translated to the selected connection's model. */
  readonly modelAliases?: Readonly<Record<string, string>>;
  /** Provider-wide fallback used only when per-model metadata is unavailable. */
  readonly defaultProtocol?: 'responses' | 'chat-completions' | 'anthropic-messages';
  /** Per-model max output used to supply Anthropic's required max_tokens field. */
  readonly modelMaxOutputTokens?: Readonly<Record<string, number>>;
  /** Native compact support is never inferred from Responses support; it must be explicit. */
  readonly modelSupportsCompact?: Readonly<Record<string, boolean>>;
  /** Allows the local Gateway to proxy Codex Responses WebSocket frames for official routes. */
  readonly webSocket?: 'official-responses';
  /** Enables request-field profiles verified specifically against 兼容服务. */
  readonly compatibleServiceGateway?: boolean;
  /** Responses namespaces rejected by this upstream even though the client may inject them. */
  readonly excludedToolNamespaces?: readonly string[];
  /** Forward even when false; only omit this client from Trace capture. */
  readonly capture?: boolean;
  /** 兼容服务 credential injected by the local gateway; never persisted in Trace. */
  readonly upstreamBearerToken?: string;
  /** Credential that must never cross into this route's upstream. */
  readonly blockedBearerToken?: string;
  /** Safe credential used only when blockedBearerToken was removed. */
  readonly replacementBearerToken?: string;
}

export interface NormalizedUsage {
  /**
   * Legacy provider-native input field. OpenAI reports total input here while
   * Anthropic reports only uncached input. New display/pricing code must use
   * inputUncachedTokens and inputTotalTokens instead.
   */
  readonly inputTokens?: number;
  /** Mutually exclusive non-cached input bucket used for display and billing. */
  readonly inputUncachedTokens?: number;
  /** All prompt-side tokens. Kept for context-window calculations, not shown in the token matrix. */
  readonly inputTotalTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  /** Anthropic 5-minute prompt-cache writes, when the upstream reports the TTL split. */
  readonly cacheCreation5mTokens?: number;
  /** Anthropic 1-hour prompt-cache writes, when the upstream reports the TTL split. */
  readonly cacheCreation1hTokens?: number;
  readonly reasoningTokens?: number;
  /**
   * Fields that could not be obtained or derived without guessing. A missing
   * field is never silently converted to zero for billing.
   */
  readonly incompleteFields?: readonly TapUsageField[];
  /**
   * inputTokens 是否已经把缓存部分算在内。
   * OpenAI（Responses / chat-completions）把 cached / cache_write 放在 *_tokens_details 里，
   * 它们是 input_tokens 的子集；Anthropic 把 cache_read / cache_creation 放在顶层，与
   * input_tokens 独立加和。不区分这一点，上下文窗口占用会把缓存重复计一遍。
   */
  readonly inputIncludesCache?: boolean;
}

export interface TapSseEvent {
  readonly event?: string;
  readonly data: string;
  readonly json?: unknown;
  readonly timestampMs: number;
}

export interface TapContentBlock {
  readonly type: 'text' | 'thinking' | 'refusal' | 'tool_use' | 'tool_result' | 'json';
  readonly id?: string;
  readonly name?: string;
  readonly text?: string;
  readonly thinking?: string;
  /** Anthropic thinking 块的加密签名（signature_delta 累积）。思考明文被上游隐藏时通常只有它。 */
  readonly signature?: string;
  readonly input?: unknown;
  readonly rawInput?: string;
  readonly content?: unknown;
  readonly tool_use_id?: string;
  /**
   * Anthropic 的扩展块类型（server_tool_use / web_search_tool_result / mcp_tool_* /
   * code_execution_tool_result…）会归并到上面的小词表，这里保留线上原始 type，避免
   * 「内置工具调用」和普通 tool_use 在 viewer 里无法区分。
   */
  readonly wireType?: string;
  readonly serverName?: string;
  readonly isError?: boolean;
  /** Chat Completions can return n > 1 choices; keep their boundaries in Read view. */
  readonly choiceIndex?: number;
  /**
   * web_search 等内置工具给 text 块附带的来源出处（web_search_result_location…）。
   * 流式响应把它拆成 citations_delta 增量下发，非流式响应直接挂在 text 块上；两条路径
   * 都归一到这里，保持与 Anthropic 非流式形状一致。
   */
  readonly citations?: unknown[];
}

export interface TapResponseSnapshot {
  readonly apiType: TapApiType;
  readonly model?: string;
  readonly id?: string;
  readonly role?: string;
  readonly content: TapContentBlock[];
  readonly stopReason?: string;
  /** Why an otherwise valid response stopped incomplete (for example max_output_tokens). */
  readonly incompleteReason?: string;
  readonly usage?: NormalizedUsage;
  readonly raw?: unknown;
}

export interface TapTimingSnapshot {
  readonly firstByteMs?: number;
  readonly firstSseMs?: number;
  readonly firstThinkingMs?: number;
  readonly firstTextMs?: number;
  readonly firstToolMs?: number;
  readonly thinkingToTextMs?: number;
}

export interface TapContextBreakdown {
  readonly estimatedTokens: number;
  readonly totalChars: number;
  readonly systemChars: number;
  readonly messagesChars: number;
  readonly toolsChars: number;
  readonly toolResultsChars: number;
  readonly otherChars: number;
}

export interface TapSubagentInfo {
  /** Stable identity of the spawn/tool invocation that owns this request. */
  readonly invocationId: string;
  /** Invocation that spawned this agent; absent for a direct child of the main agent. */
  readonly parentInvocationId?: string;
  /** One-based nesting depth below the main agent. */
  readonly depth: number;
  /** Agent role/type such as explorer or general-purpose. */
  readonly agentType?: string;
  /**
   * 运行中的这个 agent 自己的稳定 id，直接来自 transport header
   * （Claude 的 `x-claude-code-agent-id`）。与 invocationId 不同：invocationId 是父侧那次
   * 调用（Task 的 tool_use id），只有 prompt hash 盖章成功时才拿得到；agentId 每条请求都有。
   * 侧栏归组用它，否则一个子 agent 的请求会因为「有些盖上了章、有些没有」被切成好几张卡。
   */
  readonly agentId?: string;
}

export interface TapTraceRecord {
  readonly provider?: { readonly id: string; readonly name: string; readonly connectionId: string };
  readonly id: string;
  readonly sessionId?: string;
  /**
   * 展示层逻辑 Conversation 的全局请求序号。仅在跨物理 Session 读取时附加；
   * 原始 JSONL 的 turn 仍表示该物理 Session 内的序号，不会被改写。
   */
  readonly logicalTurn?: number;
  readonly turn?: number;
  /**
   * Auxiliary client request：
   * - 'title'：会话标题生成。Codex 走 json_schema 指纹（codex_output_schema 或 properties.title），
   *   Anthropic（Claude Code IDE/CLI）走 system 字面短语集（claude-vscode 2.0 = "Write the title in
   *   the language…"，2.1.175+ 改为 "Generate a concise, sentence-case title…" + <session> 包裹）。
   * - 'count'：Anthropic count_tokens 预算请求（path 后缀指纹）
   * - 'policy'：Claude Code 2.1+ bash sandbox 安全审查（每跑命令前发一次，system 含
   *   "security monitor for autonomous AI coding agents"，user 用 <transcript> 裹历史）。
   *   max_tokens 通常 ≤64，输出 block/allow，不能当主对话。
   */
  readonly auxiliary?: 'title' | 'count' | 'policy' | 'patch' | 'memory' | 'utility';
  /**
   * 子 agent 调用标记（如 Claude Code Task 工具 spawn 的 subagent）。
   * 值为展示用 label（'Subagent' 等）；有值即归并进主会话、不参与 firstPrompt/lastChain。
   */
  readonly subagent?: string;
  /** Structured SubAgent ancestry used only for sidebar grouping. */
  readonly subagentInfo?: TapSubagentInfo;
  /**
  * 上下文压缩（compact）触发回合：客户端发起的会话历史总结请求。
  * compact 后续接的普通请求用 routedBy='compactResume' 表达路由来源，不复用本字段。
  * 仅作展示标注，不影响会话归并路由。
   */
  readonly compact?: boolean;
  /**
   * Provider switch being attempted by this request. Persisted for Trace UI
   * observability; cleared by the Gateway after the target's first success.
   */
  readonly providerTransition?: {
    readonly source: 'official' | 'compatible' | `provider:${string}`;
    readonly target: 'official' | 'compatible' | `provider:${string}`;
  };
  /**
   * 路由决策路径，仅用于可观测性，不参与归并判定本身（Phase 5，2026-06-13）。
   *   - 'prevResponseId' = OpenAI Responses 协议的 previous_response_id 命中宿主 session（Phase 4，权威信号，优先级最高）
   *   - 'prefix' = chainHashes 前缀延伸命中（最常见，正常续聊或 retry）
   *   - 'root'   = root 同根兜底命中（编辑/回退重发，前缀断裂但 root 不变）
   *   - 'pendingSubagentRoot' = subagent 精确命中 pendingSubagentRoots 的宿主会话
   *   - 'auxRootHash' = auxiliary（title/count/policy/patch）抽到的 rootHash 命中已有 session
   *   - 'provisionalTitle' = Copilot title 抽到 rootHash 但暂无宿主 → 落 hidden provisional，等主回合到达再吸收
   *   - 'interactionTurn' = 同 x-interaction-id 命中活跃主 session（patch 等同 turn 内 utility 用）
   *   - 'utilityRecent' = 短窗口（2 min）贴最近同 source 非 hidden 主 session（弱归并，patch / title 抽不到 root 时）
   *   - 'unknownUtility' = utility shape 但未命中已知 rule → 落 hidden bucket，不污染主列表
   *   - 'auxSource' = title/policy/subagent 走 source 找最近活跃会话
   *   - 'compactResume' = compact-resumed 反向归并到 10 分钟内同 source 真实会话
   *   - 'editResend' = 无原生 key 的 Copilot 首条 prompt 被编辑重发，root 改变但文本高度相似
   *   - 'absorbHidden' = 真实主回合吸收先到的 hidden auxiliary provisional session
   *   - 'currentEmpty' = currentSessionId 指向的空会话兜底（startSession 之后第一条 trace）
   *   - 'newSession' = 全部 miss，开新行
   * dashboard 据此显示路由分布；某条路径占比突然升高 = 客户端漂移信号。
   */
  readonly routedBy?:
    | 'prevResponseId'
    | 'clientConversationKey'
    | 'prefix' | 'root' | 'pendingSubagentRoot'
    | 'auxRootHash'
    | 'provisionalTitle'
    | 'interactionTurn'
    | 'utilityRecent'
    | 'unknownUtility'
    | 'auxSource' | 'compactResume' | 'editResend' | 'absorbHidden'
    | 'currentEmpty' | 'newSession';
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly client?: string;
  readonly clientIdentity?: TapClientIdentity;
  readonly clientConversationKey?: string;
  /** 哪个客户端发起的请求（dashboard 用）。老 jsonl 没这个字段，viewer 端会回退到 'copilot'。 */
  readonly source?: TapTraceSource;
  /** Wire protocol inferred from endpoint shape; this is not client identity. */
  readonly protocol?: TapProtocol;
  /** How the request entered XwX Trace. */
  readonly captureMode?: TapCaptureMode;
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly url: string;
    readonly headers: Record<string, string | string[]>;
    readonly body?: unknown;
    readonly rawBody?: string;
    readonly model?: string;
    readonly apiType: TapApiType;
  };
  readonly upstream: {
    readonly baseUrl: string;
    readonly url: string;
    readonly connectionId?: string;
  };
  readonly response: {
    readonly statusCode?: number;
    readonly statusMessage?: string;
    readonly headers: Record<string, string | string[]>;
    readonly body?: unknown;
    readonly rawBody?: string;
    readonly snapshot?: TapResponseSnapshot;
  };
  readonly sse: {
    readonly events: TapSseEvent[];
    readonly snapshot?: TapResponseSnapshot;
  };
  readonly usage?: NormalizedUsage;
  /**
   * Raw usage evidence on both sides of a protocol bridge. upstream is what
   * the selected service returned; client is what XwX Deck delivered after any
   * protocol conversion. For passthrough requests they normally match.
   */
  readonly usageEvidence?: {
    readonly upstream?: {
      readonly protocol: TapProtocol;
      readonly raw: unknown;
    };
    readonly client?: {
      readonly protocol: TapProtocol;
      readonly raw: unknown;
    };
  };
  readonly timings: TapTimingSnapshot;
  /** XwX Trace 对请求体生成的分析元数据，不属于上游 API 原始字段。 */
  readonly xwxContext?: TapContextBreakdown;
  readonly error?: string;
}

export interface TapSessionTracePage {
  readonly id: string;
  readonly traces: TapTraceRecord[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
}

/**
 * 按模型累加的 usage 划分（dashboard token 矩阵用）。
 * 四个分项是 API 原始语义：Anthropic 的 input 不含缓存，Responses 的 input 已含 cacheRead，
 * 所以 total 单独累加（沿用 totalTokensOfTrace 口径），apiType 用于费用公式分流。
 */
/**
 * Usage accumulated within one billing band.
 *
 * A length-tiered model's rate is decided by the *individual request's* prompt
 * length, and a peak/off-peak model's rate by the request's timestamp. Session
 * totals sum many requests, so neither can be resolved after the fact from an
 * aggregate. Splitting the counters by band at capture time is what makes
 * tiered and time-of-day pricing computable at all.
 */
export interface TapModelUsageBand {
  /** Index into the price rule's tiers; 0 for untiered models. */
  readonly tier: number;
  /** True when the request fell outside the provider's peak windows. */
  readonly offPeak: boolean;
  /** True when the reply was short enough for the band's discounted output rate. */
  readonly shortOutput?: boolean;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
  readonly cacheCreation5m?: number;
  readonly cacheCreation1h?: number;
}

export interface TapModelUsage {
  /** Version 2 makes every displayed input/cache bucket mutually exclusive. */
  readonly version?: 2;
  /** Uncached input only. Legacy version-1 rows may contain provider-native total input here. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
  readonly cacheCreation5m?: number;
  readonly cacheCreation1h?: number;
  readonly total: number;
  readonly apiType?: TapApiType;
  readonly incompleteFields?: readonly TapUsageField[];
  /**
   * Per-band split of the same counters. Present only once a tiered or
   * peak-priced model has been captured; the flat fields above stay the
   * authoritative totals.
   */
  readonly bands?: readonly TapModelUsageBand[];
  /**
   * 上游回报的模型名，仅在与客户端请求名不同时出现（DeepSeek 会把
   * deepseek-v4-pro-0813 回成内部构建名 deepseek-v4-pro-ga-260813）。
   * 用量以请求名归集——那是用户选的、也是公开目录收录的那个——回报名保留为
   * 证据，并在请求名没有价格时作为第二个候选去取价。
   */
  readonly servedModel?: string;
}

export interface TapDailyUsage {
  readonly tokens: number;
  readonly usageByModel?: Record<string, TapModelUsage>;
}

export interface TapRatePoint {
  readonly at: string;
  readonly tokens: number;
  readonly tokPerSec?: number;
}

export interface TapPendingSubagentInvocation {
  /** Stable tool/spawn invocation identity. */
  readonly id: string;
  /** Invocation that created this invocation; absent for a direct child. */
  readonly parentId?: string;
  /** One-based nesting depth below the main agent. */
  readonly depth: number;
  /** Prompt hashes that identify the spawned agent's initial task. */
  readonly roots: readonly string[];
  /** User-facing task or agent name captured from the parent invocation. */
  readonly displayName?: string;
  /** Agent role/type such as explorer, general-purpose, or a Copilot mode. */
  readonly agentType?: string;
}

export interface TapSessionSummary {
  readonly id: string;
  /** 该 session 最早一条请求的 startedAt。 */
  readonly startedAt: string;
  /** 最近完成写入的时间，用于排序与状态；不参与 session 耗时计算。 */
  readonly updatedAt: string;
  /** 该 session 最晚一条请求的 startedAt。 */
  readonly lastRequestAt?: string;
  readonly traceCount: number;
  readonly jsonlPath: string;
  /** 历史字段：早期版本写入。新逻辑不再用，仅保留以读旧 index.json。 */
  readonly interactionId?: string;
  /** 历史字段：早期版本以首条 user 文本前缀作指纹。新逻辑改用 chainHashes。 */
  readonly rootDigest?: string;
  /** 首条 user 真实 prompt（已剥掉 envInfo/userMemory 噪音），dashboard 直接展示用。 */
  readonly firstPrompt?: string;
  /** 客户端自己生成的会话标题（如 Codex title 请求的响应），展示时优先于 firstPrompt。 */
  readonly title?: string;
  /** 该 session 最近一条 trace 的 user-chain 哈希数组，用于前缀延伸匹配。 */
  readonly lastChain?: readonly string[];
  /**
   * 主会话里 runSubagent 类工具调用的任务 prompt hash 列表（最近 N 条）。
   * 随后到达的子 agent 请求首条 user 即该 prompt，root hash 命中 ⇒ 精确归并进本 session。
   */
  readonly pendingSubagentRoots?: readonly string[];
  /**
   * Structured companion to pendingSubagentRoots. New records retain the
   * parent invocation's display name/type so matching child requests can show
   * a concrete SubAgent label. pendingSubagentRoots remains for old indexes.
   */
  readonly pendingSubagents?: readonly TapPendingSubagentInvocation[];
  /**
   * 本 session 已下发过的 response_id 列表（OpenAI Responses 协议为 response_id；Anthropic 为 message_id）。
   * 后续 trace 的 `previous_response_id` 命中其一即归并 —— 这是 Copilot gpt-5.x 等
   * Responses 续接请求的权威路由信号（只发增量、chain hash 不再延伸）。最近 16 个滚动保留。
   */
  readonly responseIds?: readonly string[];
  /**
   * Copilot title 等 attach utility 先于宿主主回合到达时，落 hidden provisional
   * session 时记录的 pending root 列表（滚动 8 个）。主回合 root 命中后吸收。
   * v2：泛化为 utility 都可用（不仅限 title）。
   */
  readonly pendingUtilityRoots?: ReadonlyArray<{
    readonly kind: 'title' | 'patch' | 'utility';
    readonly root: string;
    readonly createdAt: string;
  }>;
  /**
   * Claude title generation can arrive just before the first main request while
   * already carrying the main `x-claude-code-session-id`. Keep that exact key on
   * the hidden provisional without treating a utility request as the canonical
   * owner; the first main turn consumes it.
   */
  readonly pendingUtilityClientKeys?: ReadonlyArray<{
    readonly kind: 'title' | 'utility';
    readonly key: string;
    readonly createdAt: string;
  }>;

  /**
   * 本 session 主 trace 写入时记录的 x-interaction-id 列表（滚动 16 个）。
   * patch 等同 turn 内的 utility 通过它精确归并到当前活跃主 session。
   * Copilot 各回合 interactionId 不同，所以同 id 一定是同一回合。
   * 注意：这与早期废弃的 `interactionId?` 单字段（types.ts:230）语义完全不同——
   * 那是 v2 时代当对话 key 用的（已弃用），本字段是 turn 级，只用于 utility 同 turn 归并。
   */
  readonly interactionIds?: readonly string[];
  /** Auxiliary-only provisional sessions are hidden from the dashboard until a real user turn joins them. */
  readonly hidden?: boolean;
  readonly auxiliary?: 'title' | 'count' | 'policy' | 'subagent' | 'patch' | 'memory' | 'utility';
  /** Incremental per-kind counts used by the dashboard without rereading JSONL. */
  readonly auxiliaryCounts?: Readonly<Partial<Record<
    'title' | 'count' | 'policy' | 'subagent' | 'patch' | 'memory' | 'utility',
    number
  >>>;
  // 以下为 dashboard 聚合字段，appendTrace 时增量累加，避免重读 jsonl。
  /** 该 session 所有 trace 的 totalTokens 之和。 */
  readonly totalTokens?: number;
  /** 出现错误（含 error 字段或 statusCode>=400）的 trace 数。 */
  readonly errorCount?: number;
  /**
   * 最近一次主回合是否以失败收尾（dashboard ERR 徽章用）。aux（title/count/policy）
   * 和 subagent trace 不更新这个标记 —— 它们失败不阻止用户继续对话。
   * 中途出错但后续主回合恢复成功 → 字段被覆盖回 false，不再挂 ERR。
   */
  readonly lastTurnError?: boolean;
  /** 会话总耗时：从最早请求的 startedAt 到最晚请求的 startedAt（毫秒）。 */
  readonly durationMs?: number;
  /** 首条 trace 的 model（dashboard Model 列）。 */
  readonly firstModel?: string;
  /** 首条 trace 的 source（dashboard source 过滤器 / 列）。 */
  readonly source?: TapTraceSource;
  /** 首条 trace 的 client（headers 解析得到，dashboard 行可选展示）。 */
  readonly firstClient?: string;
  /** 主回合建立的客户端会话键；辅助标题/计数线程不得占用该身份。 */
  readonly clientConversationKey?: string;
  /** 按模型累加的 token 划分（旧 session 无此字段，矩阵里不出现）。 */
  readonly usageByModel?: Record<string, TapModelUsage>;
  /** 最近 8 个本地自然日的增量汇总，供管理页统计使用，避免轮询读取大型 JSONL。 */
  readonly dailyUsage?: Record<string, TapDailyUsage>;
  /** true 表示 dailyUsage 从该 session 第一条 trace 起完整记录。 */
  readonly dailyUsageComplete?: boolean;
  /** 最近的吞吐点；管理页图表只需要短窗口，不应为此重读完整会话。 */
  readonly recentRatePoints?: readonly TapRatePoint[];
}

export interface TapHistoryIndex {
  readonly version: 1;
  readonly sessions: TapSessionSummary[];
  readonly usageOnly?: {
    readonly totalTokens: number;
    readonly usageByModel?: Record<string, TapModelUsage>;
    readonly dailyUsage?: Record<string, TapDailyUsage>;
    readonly recentRatePoints?: readonly TapRatePoint[];
  };
}
