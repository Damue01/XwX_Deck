import { createHash } from 'crypto';
import {
  COMPACT_LAST_USER_PHRASES,
  COMPACT_SYSTEM_PREFIX_PHRASES,
  LOCAL_COMMAND_CAVEAT_TAG,
  LOCAL_COMMAND_CAVEAT_TEXT,
  MAIN_AGENT_EXCLUDE_PHRASES,
  NOISE_TAGS,
  SUBAGENT_LITERAL_PHRASES,
  USER_PROMPT_TAGS
} from './clientSignatures';
import { TapPendingSubagentInvocation, TapSessionSummary, TapTraceRecord } from './types';
import { extractCodexIdeRequest, extractUserPrompt, isConversationSummaryOnly } from './userPrompt';
import { parseJsonObject } from '../shared/json';
import { extractSystemText, headerValue } from './protocolBody';

/**
 * 一条 trace 的会话指纹。
 *
 * 设计目标：与 Copilot Chat 真实对话生命周期对齐——
 *   - 中断后继续聊：messages[] 末尾追加，新请求 chainHashes 是旧 chain 的“前缀延伸”。
 *   - 中间 fork 出新分支：fork 后的新 chat 改写了第 k 条 user，chainHashes 与旧的共享前 k-1 项后分歧。
 *   - “Continue in new chat”：第 0 条 user 重写或注入 <conversation-summary>，第 0 项 hash 就不同。
 *   - compact 后续接：第 0 条 user 仅含 <conversation-summary>（无 <userRequest>）——
 *     是同一 chat 的延续，需走专门反向归并而不是按 root hash 找。
 *
 * 因此只比对“每条 user 消息” extract 出来的 prompt hash 数组，
 * envInfo/userMemory/attachments 这些在 Copilot 注入层抖动的内容不参与判定。
 */
export interface SessionFingerprint {
  /** 每条 user 文本归一化后的 16 字 sha256 前缀，按出现顺序排列。可能为空（请求里没 user）。 */
  readonly chainHashes: readonly string[];
  /** 首条 user 的可读 prompt 文本（已剥掉 envInfo/userMemory 等噪音），供 Dashboard 直接展示。 */
  readonly firstPrompt: string;
  /**
   * 首条 meaningful user 仅由 <conversation-summary> 兜底命中（即 USER_PROMPT_TAGS 全部未命中、
   * 只能靠 conversation-summary fallback 抽出）⇒ 这是 Copilot 自动 compact 后的首请求，
   * 应反向归并到时间窗口内最近的同 source session，而不是按 root hash 找同根。
   * Codex/Claude 的 compact 形态首条 user 没有 conversation-summary 标签，仍走原 root hash 路径。
   */
  readonly compactResume?: boolean;
}

const PROMPT_DISPLAY_LEN = 4000;
const HASH_PREFIX_LEN = 16;
const HASH_TEXT_FALLBACK_LEN = 200;

export function extractFingerprint(trace: TapTraceRecord): SessionFingerprint {
  const body = bodyOf(trace);
  const userParts = userMessageParts(body);
  if (userParts.length === 0) {
    return { chainHashes: [], firstPrompt: '' };
  }
  // Codex CLI 首次连接 / Claude CLI SessionStart hook 会发一条只包 envInfo / system-reminder 的 user 消息；
  // 这种 trace 没有真实用户输入，视为 service 请求走 chainHashes=[] 分支，被 matchSession 默认粘到上一条会话。
  const meaningful = userParts.filter(parts => !isSystemNoiseOnly(parts));
  if (meaningful.length === 0) {
    return { chainHashes: [], firstPrompt: '' };
  }
  const chainHashes = meaningful.map(parts => hashPrompt(extractPromptForHash(parts)));
  const firstPrompt = extractPromptForDisplay(meaningful[0]);
  // 仅当首条 meaningful user 是 conversation-summary fallback 命中（USER_PROMPT_TAGS 全空），
  // 才认作 compact-resumed，避免把 Copilot 主对话里偶然引用 <conversation-summary> 的请求误判。
  const compactResume = isConversationSummaryOnly(meaningful[0]) || undefined;
  return compactResume ? { chainHashes, firstPrompt, compactResume } : { chainHashes, firstPrompt };
}

/**
 * OpenAI Responses 协议续接信号：请求 body 的 `previous_response_id` 指向上一次响应的 id。
 * 这是 Copilot gpt-5.x / Codex 在 Responses 模式下传递的会话级权威 id —— 比 chain-hash 更稳。
 * Responses 续接请求**不重发完整历史**（只发 previous_response_id + 新 user + tool outputs），
 * 所以 chain prefix 必然不命中，root hash 也不同；只能靠这个字段找到正确的父会话。
 *
 * Anthropic /v1/messages 协议没有这个字段，返回 undefined（路由继续走 chain-hash 路径）。
 */
export function extractPreviousResponseId(trace: TapTraceRecord): string | undefined {
  const body = bodyOf(trace);
  const v = body.previous_response_id;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Copilot utility title 请求**自带**主对话首句指纹。
 *
 * 背景（2026-06-18 实测）：Copilot 走 Anthropic/OpenAI 协议透传时，**不发送任何稳定的对话级 id
 * header**——同一对话连续两条请求的 x-interaction-id / x-request-id / x-agent-task-id 全部变化
 * （旧 jsonl 抓样：04af… → 6fdc…）。所以 title 请求无法靠 header 区分来源对话。
 *
 * 但 title 请求 body 的 user 文本是固定模板：
 *   `Please write a brief title for the following request: <用户在主对话里输入的原始首句>`
 * 这个原始首句正是主对话首条 user 的真实 prompt（主对话 trace 抽取 <userRequest> 后的内容），
 * 归一化后与主会话 root hash（lastChain[0]）一致。因此可用它精确路由到来源对话，
 * 而不是退回「同 source 最近活跃会话」——后者在**同时开两个 Copilot 对话**时会把两个 title
 * 都吸进最近那一个，导致两个对话的标题挤进同一行（本次修复的 bug）。
 *
 * 返回 root hash（与 chainHashes[0] 同算法），抽不到原句时返回 undefined。
 */
const COPILOT_TITLE_PROMPT_PREFIX = 'please write a brief title for the following request:';

/**
 * 把标题请求里还原出的原句，按**主回合完全相同**的口径取 root hash。
 *
 * 必须复用 extractPromptForHash：主回合走 hashPrompt(extractPromptForHash(parts))，其退化路径
 * 会 stripKnownPromptNoise 并截断到 HASH_TEXT_FALLBACK_LEN。早先三个提取器各自手写
 * `normalize(tagged || original)` 复刻这套逻辑，结果任何超过 200 字或含噪音标签的首条 prompt
 * 都算出不同的 hash，标题永久路由不到会话（唯一的断言样本只有 15 字，恰好落在安全区）。
 */
function titleRootHash(original: string): string | undefined {
  const promptForHash = extractPromptForHash([original]);
  return promptForHash ? hashPrompt(promptForHash) : undefined;
}

export function extractCopilotTitleRootHash(titleUserText: string): string | undefined {
  const text = (titleUserText || '').trim();
  const lower = text.toLowerCase();
  if (lower.indexOf(COPILOT_TITLE_PROMPT_PREFIX) !== 0) return undefined;
  const original = text.slice(COPILOT_TITLE_PROMPT_PREFIX.length).trim();
  if (!original) return undefined;
  return titleRootHash(original);
}

export function extractCodexTitleRootHash(titleUserText: string): string | undefined {
  const text = (titleUserText || '').trim();
  const match = /(?:^|\n)User prompt:\s*\n?([\s\S]+)$/i.exec(text);
  const original = match ? match[1].trim() : '';
  if (!original) return undefined;
  return titleRootHash(original);
}

/**
 * Claude Code title requests wrap the original first prompt in an outer
 * `<session>...</session>` block. Use the outermost closing tag so a user-authored
 * literal tag inside the prompt does not truncate the routing fingerprint.
 */
export function extractAnthropicTitleRootHash(titleUserText: string): string | undefined {
  const text = (titleUserText || '').trim();
  const open = /<session\b[^>]*>/i.exec(text);
  if (!open || open.index === undefined) return undefined;
  const closeStart = text.toLowerCase().lastIndexOf('</session>');
  const contentStart = open.index + open[0].length;
  if (closeStart < contentStart) return undefined;
  const original = text.slice(contentStart, closeStart).trim();
  if (!original) return undefined;
  return titleRootHash(original);
}

/**
 * 抽取本条 trace 响应的 response_id（OpenAI Responses）/ message_id（Anthropic）。
 * 写入 session.responseIds 后，下条 trace 的 previous_response_id 即可精确路由回来。
 * 优先 SSE 重组的 snapshot（流式终态），其次普通 JSON response.snapshot。
 */
export function extractResponseId(trace: TapTraceRecord): string | undefined {
  const sseId = trace.sse?.snapshot?.id;
  if (typeof sseId === 'string' && sseId.length > 0) return sseId;
  const respId = trace.response?.snapshot?.id;
  if (typeof respId === 'string' && respId.length > 0) return respId;
  return undefined;
}

/**
 * 在 session 列表里找含指定 response_id 的 session（最近一次响应过该 id 的）。
 * Phase 4（2026-06-13）：Copilot Responses 续接的权威路由信号。
 * Phase 5：可选 source 过滤——response_id 实测全局唯一，但保持与其他路由分支一致的
 * source 严格性，防御 jsonl 手改 / 测试夹具 / 未来 provider id 命名空间重叠的边角场景。
 */
export function findSessionByResponseId(
  sessions: readonly TapSessionSummary[],
  responseId: string,
  source?: TapTraceRecord['source']
): TapSessionSummary | undefined {
  for (const s of sessions) {
    if (source && s.source !== source) continue;
    const ids = s.responseIds;
    if (Array.isArray(ids) && ids.includes(responseId)) return s;
  }
  return undefined;
}

/**
 * 把新 trace 路由到合适的 session。
 *
 * - 有 chainHashes：在 TTL 窗口内找“最近一条 lastChain 是新 chain 的前缀（含相等）”的 session。
 *   前缀不命中再做**同根兜底**：root（第 0 条 user 的 hash）相同 ⇒ 同一个聊天窗口。
 *   Copilot 的「编辑第 k 条消息并重发」会把 chain 在中途改写（前缀断裂），
 *   但 root 不变；如果不做同根归并，用户每编辑一次就会多出一行会话（2026-06-10 实测翻车）。
 *   只有 root 也不同（全新对话 / Continue in new chat 注入 summary 重写首条）才开新 session。
 * - 没 chainHashes（embedding / /title / 纯 tool 续接）：粘到最近活跃 session 末尾，不开新会话，
 *   避免一条服务类请求把列表搅乱；如果一条 session 都没有则返回 undefined。
 */
/**
 * matchSession 的命中信息：包含选中的 session 和命中路径（用于 Phase 5 的 routedBy 可观测）。
 *   - 'prefix' = chainHashes 前缀延伸命中（最常见，正常续聊或 retry）
 *   - 'root'   = root 同根兜底命中（编辑/回退重发，前缀断裂但 root 不变）
 *   - 'pickRecent' = chainHashes 为空的服务请求按最近活跃匹配
 */
export interface MatchSessionHit {
  readonly session: TapSessionSummary;
  readonly by: 'prefix' | 'root' | 'pickRecent';
}

/**
 * options.source（2026-06-13 加入）：当前 trace 的 source（'copilot' / 'codex-cli' / 'claude-cli' /
 * 'claude-vscode'）。传入后所有命中路径（prefix / root / pickRecent）都强制要求候选 session
 * 的 source 与之相等——避免**两个不同客户端首句相同**时跨 source 误并。
 *
 * 实测翻车：用户在 Copilot 与 Codex CLI 各发"晚上好，用 subagent 查上海天气"，hash 完全相同 →
 * v6 同根归并把 Copilot trace 吸进 Codex 行。空 source 不参与归并（兼容旧 jsonl 没有 source 字段）。
 *
 * 不传 source 时退回旧行为（不做过滤，保留对老测试的向后兼容）。
 */
export function matchSession(
  sessions: readonly TapSessionSummary[],
  fp: SessionFingerprint,
  options: { now?: Date; ttlMs?: number; source?: string; clientConversationKey?: string } = {}
): MatchSessionHit | undefined {
  if (sessions.length === 0) return undefined;
  const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  const now = (options.now ?? new Date()).getTime();
  const sourceFilter = (options.source || '').trim();
  const clientConversationKey = (options.clientConversationKey || '').trim();
  const sameSource = (s: TapSessionSummary): boolean => {
    if (!sourceFilter) return true;
    const ss = (s.source || '').trim();
    return ss.length > 0 && ss === sourceFilter;
  };
  const sameClientConversation = (s: TapSessionSummary): boolean => {
    if (!clientConversationKey) return true;
    return (s.clientConversationKey || '').trim() === clientConversationKey;
  };
  const fresh = sessions.filter(s => {
    const ts = Date.parse(s.updatedAt || s.startedAt);
    const fresh = Number.isFinite(ts) ? now - ts <= ttlMs : true;
    return fresh && sameSource(s) && sameClientConversation(s);
  });
  if (fresh.length === 0) return undefined;

  if (fp.chainHashes.length === 0) {
    const picked = pickMostRecent(fresh);
    return picked ? { session: picked, by: 'pickRecent' } : undefined;
  }

  for (let i = fresh.length - 1; i >= 0; i--) {
    const candidate = fresh[i];
    const lastChain = candidate.lastChain;
    if (!lastChain || lastChain.length === 0) continue;
    if (isPrefix(lastChain, fp.chainHashes)) return { session: candidate, by: 'prefix' };
  }

  // 同根兜底（v6，同根即归并）：root（首条真实 user 的 hash）相同 ⇒ 同一个聊天窗口，直接归并。
  // 历史演进：v5.1 曾要求「公共前缀 ≥ 父链长-1」（只允许末项分叉），想把 fork 回早期检查点拆成新行；
  // 但 2026-06-11 实测两类误拆都来自这个限制：
  //   ① Copilot 注入的独立 user 消息（<attachments> 附件内容 / <context> 终端状态）每回合抖动，
  //      被算进 chainHashes 后链在中途分歧（不是真实编辑），前缀断裂 → 同一对话被拆成多行；
  //   ② 回退检查点 / 编辑中间消息重发，root 不变却被拆成新行。
  // 用户确认期望：同一个 chat 窗口永远一行。
  // 2026-06-13：再加 source guard——**两个不同客户端首句一字不差**仍会跨 source 同根归并，
  // 必须靠 options.source 过滤。filter 已在 fresh 列表层面收敛，本分支无需重复判断。
  // 完整规则与演进见 docs/trace-session-merging.md。
  const root = fp.chainHashes[0];
  let best: TapSessionSummary | undefined;
  let bestTs = -Infinity;
  for (const candidate of fresh) {
    const lastChain = candidate.lastChain;
    if (!lastChain || lastChain.length === 0 || lastChain[0] !== root) continue;
    const ts = Date.parse(candidate.updatedAt || candidate.startedAt);
    if (Number.isFinite(ts) && ts > bestTs) { bestTs = ts; best = candidate; }
  }
  return best ? { session: best, by: 'root' } : undefined;
}

/**
 * 检测一条 trace 是否为子 agent（Claude Code Task 工具 spawn 的 subagent 等）发出的请求。
 * 返回展示用 label；undefined 表示主 agent 请求。
 *
 * 判定顺序很重要：主 agent 的 system prompt 里可能**提到** subagent 这个词
 * （比如 Copilot 主 prompt 描述 runSubagent 工具），所以先用子 agent 的自我介绍短语精确命中，
 * 再排除已知主 agent prompt，最后才允许宽匹配。与 claude-tap sidebar.js 的 label 推断链对齐，
 * 但比它保守——claude-tap 的 label 只影响配色，我们的判定还影响会话归并路由。
 */
export function detectSubagent(trace: TapTraceRecord): string | undefined {
  const transportSubagent = detectCodexTransportSubagent(trace);
  if (transportSubagent) return transportSubagent;

  const sys = extractSystemText(bodyOf(trace)).toLowerCase();
  if (!sys) return undefined;
  const copilotBuiltIn = detectCopilotBuiltinSubagent(trace, sys);
  if (copilotBuiltIn) return copilotBuiltIn;
  // Anthropic 自家硬标记：billing header 块里带 `cc_is_subagent=true`。Claude Code
  // 2.1.177 抓样本实证 web_search / Task spawn 子调度都会带,主 agent 不带。比下面
  // 任何 system 短语判定都稳——未来 Anthropic 改措辞或加新工具子调度,只要 header 还在
  // 就识别得到。优先级最高,但仍需后续判定提取展示 label,所以不直接 return。
  const carriesSubagentMarker = /\bcc_is_subagent\s*=\s*true\b/.test(sys);
  // Claude Code 2.1.177+ 内置工具子调度（web_search 等）：system 第二段沿用
  // "You are Claude Code…" 主 agent 身份，第三段才是 "You are an assistant for
  // performing a <tool> tool use" 这条真正区分子调度的短语。必须**早于**下面
  // "you are claude code" 短路返回，否则永远命中不到第三段——这是 2026-06-13
  // 实测 web_search 调用被当主会话开新行的根因。label 从短语里抽工具名（'web search'
  // → 'WebSearch'），未来 web_fetch / deep_research 等同形态子调度自然覆盖。
  const builtIn = sys.match(/you are an assistant for performing an? ([a-z][a-z\s]*?) tool use/);
  if (builtIn) {
    return builtIn[1].split(/\s+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  }
  // 通用兜底：句式不是 "performing X tool use" 的内置子调度（如未来 "an assistant
  // for summarizing X"），抽不到具体工具名时回退 'Subagent' label。锁词序避免误伤
  // Copilot 主 agent "You are an expert AI programming assistant"（含 "an expert"
  // 隔断），Claude Code 主 agent "You are Claude Code"（不含 "an assistant"）。
  if (/\byou are an assistant\b/.test(sys)) return 'Subagent';
  // Literal subagent 短语：表搬到 clientSignatures.ts:SUBAGENT_LITERAL_PHRASES。
  // Copilot 的 SearchSubagent 在前面 detectCopilotBuiltinSubagent 里已处理（带联合短语判定），
  // 此处只跑 Claude 系（claude-cli / claude-vscode）的 literal 匹配。
  for (const rule of SUBAGENT_LITERAL_PHRASES) {
    if (rule.client === 'copilot') continue;
    if (sys.includes(rule.phrase)) return rule.label;
  }
  // 已知主 agent prompt：哪怕正文里出现 subagent 字样也不是子 agent。
  // 例外：Claude Code 内置工具子调度（web_search 等）会**沿用** "You are Claude Code"
  // 主 agent 身份,仅靠 cc_is_subagent=true marker 区分。所以这里要让 marker 否决主
  // agent 排除,避免 system[2] 子调度短语缺失/改写时把 web_search 误判成主对话。
  for (const rule of MAIN_AGENT_EXCLUDE_PHRASES) {
    if (!sys.includes(rule.phrase)) continue;
    // claude-cli 主 agent 排除条件：marker 不存在
    if (rule.client === 'claude-cli' && carriesSubagentMarker) continue;
    return undefined;
  }
  // 自我介绍式宽匹配："You are … subagent/sub-agent …"。
  if (/\byou are\b[^.\n]{0,160}\bsub-?agent\b/.test(sys)) return 'Subagent';
  // 兜底：上面所有 system 短语都没命中、但 Anthropic 自家 marker 在,仍然判子 agent。
  // 覆盖未来 Claude Code 新增的子调度（系统短语未列入清单）以及主 agent 短语意外缺失
  // 的边角情况。主 agent 永远不带这个 marker,所以不会误伤。
  if (carriesSubagentMarker) return 'Subagent';
  return undefined;
}

/**
 * Codex spawned agents currently reuse the main "You are Codex" instructions, so
 * the only stable self-identification lives in request headers/turn metadata.
 *
 * 接受 codex-cli（终端 TUI）和 codex-vscode（VSCode 插件）两个 source——
 * 同一套请求头 / metadata，只有产品识别字段（originator / UA）不同。
 */
/**
 * Codex 子 agent 的**权威**父子关系：直接来自 transport header，无需 prompt hash 启发式。
 *
 * 实测 Codex Desktop 0.147：子 agent 请求带 `x-openai-subagent: collab_spawn`、
 * `x-codex-parent-thread-id`（父 thread）与 `thread-id`（自身 thread）。这一对 id 就是精确的
 * 父子链，比 hash 匹配可靠得多——而且 hash 路径对 Codex **根本不可能成立**：`spawn_agent`
 * 的参数是 `fork_context: true`，子 agent 继承父对话全文，其首条 user 消息是原对话首句，
 * 永远不等于 spawn 时记下的 message hash（实测全盘 308 条 subagent、0 条成功盖章）。
 *
 * Codex 不给通用子 agent 任何名字（`spawn_agent` 只有 fork_context / message / reasoning_effort，
 * header 里也没有），所以这里只负责父子链。区分同名并行子 Agent 的短 id 由 viewer 统一从
 * invocationId 派生（Claude 是 Task 的 tool_use id、Codex 是 thread id），对两个客户端一视同仁，
 * 不再占用 agentType 槽位——那里是 `general-purpose` 这类真实 agent 类型。
 * 选了自定义 agent 时 spawn_agent 会带 agent_type / nickname，那条路径优先，不会走到这里。
 */
export function extractCodexThreadAncestry(trace: TapTraceRecord): {
  readonly invocationId: string;
  readonly parentInvocationId?: string;
} | undefined {
  if (trace.source !== 'codex-cli' && trace.source !== 'codex-vscode') return undefined;
  const headers = trace.request?.headers ?? {};
  const threadId = cleanSubagentId(headerValue(headers, 'thread-id').trim());
  if (!threadId) return undefined;
  const parentThreadId = cleanSubagentId(headerValue(headers, 'x-codex-parent-thread-id').trim());
  if (!parentThreadId) return undefined;
  return {
    invocationId: threadId,
    parentInvocationId: parentThreadId
  };
}

/**
 * Claude 子 agent **自身**的稳定 id，直接来自 transport header `x-claude-code-agent-id`。
 *
 * 与 subagentInvocations() 的 prompt-hash 盖章是两条独立的线索，缺一不可：
 * - hash 盖章给的是**父侧那次 Task 调用**（tool_use id、displayName、subagent_type），
 *   但只有子 agent 首条 user 消息恰好等于 Task prompt 时才成立；子 agent 进入工具循环后，
 *   后续请求的首条消息是 tool_result，hash 再也匹配不上。
 * - 这个 header 每条请求都有，但不含名字。
 *
 * 实测（会话 2026-08-06T02-43-59）：一个子 agent 的 13 条请求全部带
 * `x-claude-code-agent-id: a91fb5cc7152599c7`，其中只有 6 条 hash 盖章成功。仅按盖章结果归组，
 * 这一个子 agent 会被切成 3 张卡（"查询纽约天气" / "Subagent" / "WebSearch"）。
 * 所以归组必须用这个 header——它对 Claude 的作用等同于 thread-id 对 Codex。
 *
 * 同时接受 claude-cli 与 claude-vscode：同一套请求头，只有产品识别字段不同。
 */
export function extractClaudeAgentId(trace: TapTraceRecord): string | undefined {
  if (trace.source !== 'claude-cli' && trace.source !== 'claude-vscode') return undefined;
  const headers = trace.request?.headers ?? {};
  return cleanSubagentId(headerValue(headers, 'x-claude-code-agent-id').trim());
}

function detectCodexTransportSubagent(trace: TapTraceRecord): string | undefined {
  if (trace.source !== 'codex-cli' && trace.source !== 'codex-vscode') return undefined;
  const headers = trace.request?.headers ?? {};
  const subagentHeader = headerValue(headers, 'x-openai-subagent').toLowerCase();
  const clientMetadata = codexClientMetadata(trace);
  const rawMetadata = headerValue(headers, 'x-codex-turn-metadata')
    || stringField(clientMetadata, 'x-codex-turn-metadata')
    || '';
  const metadata = parseJsonObject(rawMetadata);
  const metadataMarksSubagent = metadata?.thread_source === 'subagent'
    || metadata?.subagent_kind === 'thread_spawn';
  const rawMetadataMarksSubagent = /"thread_source"\s*:\s*"subagent"/i.test(rawMetadata)
    || /"subagent_kind"\s*:\s*"thread_spawn"/i.test(rawMetadata);
  const headerMarksSubagent = /subagent|collab_spawn|thread_spawn/.test(subagentHeader);
  if (!headerMarksSubagent && !metadataMarksSubagent && !rawMetadataMarksSubagent) return undefined;

  const displayName = codexSubagentDisplayName(metadata);
  if (displayName) return displayName;
  if (metadata) {
    const agentType = cleanSubagentLabel(
      stringField(metadata, 'agent_role')
      || stringField(metadata, 'agent_type')
    );
    if (agentType) return agentType;
  }
  return 'Subagent';
}

function codexClientMetadata(trace: TapTraceRecord): Record<string, unknown> | undefined {
  const value = bodyOf(trace).client_metadata;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function codexSubagentDisplayName(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined;
  const source = recordField(metadata, 'source');
  const subagent = recordField(source, 'subagent');
  const threadSpawn = recordField(subagent, 'thread_spawn');
  const directName = stringField(metadata, 'agent_nickname')
    || stringField(metadata, 'agent_name')
    || stringField(metadata, 'nickname')
    || stringField(threadSpawn, 'agent_nickname')
    || stringField(threadSpawn, 'agent_name')
    || stringField(threadSpawn, 'nickname');
  const cleanName = cleanSubagentLabel(directName);
  if (cleanName) return cleanName;

  const agentPath = stringField(metadata, 'agent_path')
    || stringField(threadSpawn, 'agent_path');
  if (!agentPath) return undefined;
  const pathName = agentPath.split(/[\\/]/).filter(Boolean).at(-1);
  return cleanSubagentLabel(pathName);
}

function recordField(
  obj: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> | undefined {
  const value = obj?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function cleanSubagentLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = normalize(value).slice(0, 120);
  return cleaned || undefined;
}

function detectCopilotBuiltinSubagent(trace: TapTraceRecord, sys: string): string | undefined {
  if (trace.source !== 'copilot') return undefined;
  if (
    sys.includes('you are an ai coding research assistant that uses search tools to gather information')
    || (sys.includes('you are an ai coding research assistant') && sys.includes('<final_answer>'))
  ) {
    return 'SearchSubagent';
  }
  return undefined;
}

/**
 * Copilot 子 agent 的辅助信号：system 末尾带 <modeInstructions>（runSubagent spawn 的
 * Explore / 自定义 agent 等都会注入）。仅用于提供展示 label（mode 名）：归并判定本身
 * 靠 pendingSubagentRoots 的任务 prompt hash 命中（Codex spawn_agent 的子 agent 请求
 * instructions 与主 agent 完全相同、无 modeInstructions，所以这不能作为必要条件）。
 * 提取不到名字时回退 'Subagent'；没有 modeInstructions 返回 undefined。
 */
export function detectSubagentMode(trace: TapTraceRecord): string | undefined {
  const sys = extractSystemText(bodyOf(trace));
  if (!/<modeInstructions>/i.test(sys)) return undefined;
  const m = sys.match(/running in "([^"]{1,40})" (?:mode|agent)/i);
  return (m && m[1]) || 'Subagent';
}

/**
 * 从一条 trace 的响应快照里提取子 agent spawn 类工具调用的任务 prompt hash。
 * 工具名覆盖：Copilot runSubagent / Codex spawn_agent / Claude Code 内置 Task
 * （wait_agent/close_agent 无任务文本，天然不命中）。
 * Task 用 ^Task$ 严格锚定避免与含 "Task" 子串的其它工具名误命中。
 * 用途：主 agent 调 spawn 时，把 input.prompt/task/message 的 hash 记到 session 上
 * （pendingSubagentRoots）；随后到达的子 agent 请求首条 user 即该 prompt
 * （Copilot 包成 <userRequest>，Codex 是裸文本，Claude Task 也是裸文本），
 * chain hash 与之相等 ⇒ 精确归并。
 * 同时存全文 hash 与 200 字截断 hash（覆盖子 agent 侧无 tag 包裹走截断路径的客户端）。
 */
export function subagentInvocations(trace: TapTraceRecord): TapPendingSubagentInvocation[] {
  const snap = trace.sse?.snapshot ?? trace.response?.snapshot;
  const blocks = snap?.content;
  if (!Array.isArray(blocks)) return [];
  const invocations: TapPendingSubagentInvocation[] = [];
  for (const b of blocks) {
    if (!b || b.type !== 'tool_use') continue;
    let input: unknown = b.input;
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch { /* ignore */ }
    }
    if (input === undefined && typeof b.rawInput === 'string') {
      try { input = JSON.parse(b.rawInput); } catch { /* ignore */ }
    }
    if (!input || typeof input !== 'object') continue;
    const obj = input as Record<string, unknown>;
    const namedSubagentTool = /sub-?agent|spawn_agent|^(?:Task|Agent)$/i.test(b.name || '');
    const copilotRunSubagentShape = typeof obj.agentName === 'string' && typeof obj.prompt === 'string';
    if (!namedSubagentTool && !copilotRunSubagentShape) continue;
    const prompt = typeof obj.prompt === 'string' ? obj.prompt
      : typeof obj.task === 'string' ? obj.task
        : typeof obj.message === 'string' ? obj.message
          : undefined;
    if (!prompt || !prompt.trim()) continue;
    const norm = normalize(prompt);
    const roots = [hashPrompt(norm)];
    const sliced = norm.slice(0, HASH_TEXT_FALLBACK_LEN);
    if (sliced !== norm) roots.push(hashPrompt(sliced));
    const displayName = cleanSubagentLabel(
      stringField(obj, 'agentName')
      || stringField(obj, 'agent_name')
      || stringField(obj, 'agentNickname')
      || stringField(obj, 'agent_nickname')
      // Codex 的 spawn_agent 用裸 `nickname`（实测 codex.exe 的 serde 字段串
      // `fork_context agent_id nickname id`），不是 agent_nickname。
      || stringField(obj, 'nickname')
      || stringField(obj, 'description')
      || stringField(obj, 'taskName')
      || stringField(obj, 'task_name')
    );
    const agentType = cleanSubagentLabel(
      stringField(obj, 'agentType')
      || stringField(obj, 'agent_type')
      || stringField(obj, 'subagentType')
      || stringField(obj, 'subagent_type')
      || stringField(obj, 'role')
      || stringField(obj, 'mode')
    );
    const id = cleanSubagentId(b.id)
      || `${trace.id}:subagent:${invocations.length + 1}`;
    invocations.push({
      id,
      parentId: trace.subagentInfo?.invocationId,
      depth: Math.max(1, (trace.subagentInfo?.depth || 0) + 1),
      roots: [...new Set(roots)],
      displayName,
      agentType
    });
  }
  return invocations;
}

function cleanSubagentId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim();
  return cleaned && cleaned.length <= 240 ? cleaned : undefined;
}

/**
 * 检测一条 trace 是否为上下文压缩（compact / summarize）触发请求。
 *
 * 指纹来源（2026-06-11 真实 trace 库实证 + 各客户端公开 prompt）：
 * - Copilot summarizeConversationHistory（UI 里手动 /compact 或 token 超限自动触发）：
 *   专用 system prompt（"Your task is to create a comprehensive, detailed summary…"）
 *   + 末条 user "Summarize the conversation history so far…"。
 * - Claude Code CLI /compact 与 auto-compact：末条 user "Your task is to create a detailed
 *   summary of the conversation so far…"。
 * - Codex CLI /compact 与 auto-compact（openai/codex codex-rs/prompts/templates/compact/prompt.md）：
 *   末条 user "You are performing a CONTEXT CHECKPOINT COMPACTION…"。
 * 只认这几个锣定短语，不做泛化匹配——误报会把普通「帮我总结一下」回合错标成 compact。
 * 仅用于展示标注，不进会话归并判定（compact 请求的 chain 天然延伸主链，路由不受影响）。
 */
export function detectCompact(trace: TapTraceRecord): boolean {
  if (/\/responses\/compact\/?$/i.test(trace.request.path || '')) return true;
  const body = bodyOf(trace);
  const input = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).input
    : undefined;
  if (Array.isArray(input) && input.length > 0) {
    const last = input[input.length - 1];
    if (last && typeof last === 'object' && !Array.isArray(last) && (last as Record<string, unknown>).type === 'compaction_trigger') {
      return true;
    }
  }
  const sys = extractSystemText(body).toLowerCase();
  // 短语表搬到 clientSignatures.ts；维护时去那里检查 / 补条目。
  for (const rule of COMPACT_SYSTEM_PREFIX_PHRASES) {
    if (sys.startsWith(rule.phrase)) return true;
  }
  const users = userMessageTexts(body);
  const last = (users[users.length - 1] || '').toLowerCase();
  if (!last) return false;
  for (const rule of COMPACT_LAST_USER_PHRASES) {
    if (last.includes(rule.phrase)) return true;
  }
  return false;
}

function pickMostRecent(sessions: readonly TapSessionSummary[]): TapSessionSummary | undefined {
  let best: TapSessionSummary | undefined;
  let bestTs = -Infinity;
  for (const s of sessions) {
    const ts = Date.parse(s.updatedAt || s.startedAt);
    if (!Number.isFinite(ts)) continue;
    if (ts > bestTs) { bestTs = ts; best = s; }
  }
  return best ?? sessions[sessions.length - 1];
}

function isPrefix(a: readonly string[], b: readonly string[]): boolean {
  if (a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function hashPrompt(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, HASH_PREFIX_LEN);
}

/** hash 用：尽量稳定的归一化文本。优先 extracted prompt，否则退化到前 200 字归一化前缀。 */
function extractPromptForHash(parts: readonly string[]): string {
  const tagged = extractUserPrompt(parts, { tags: USER_PROMPT_TAGS });
  if (tagged) return normalize(tagged);
  const codexIdeRequest = extractCodexIdeRequest(parts);
  if (codexIdeRequest) return normalize(codexIdeRequest);
  // 退化路径：所有 part 拼起来取前 200 字归一化前缀（与原行为一致）。
  const stripped = parts.map(p => stripKnownPromptNoise(p)).join('\n').trim();
  return normalize(stripped || parts.join('\n')).slice(0, HASH_TEXT_FALLBACK_LEN);
}

/** Dashboard 直接展示用：未截断的可读 prompt，剥掉 envInfo/userMemory 等噪音。 */
function extractPromptForDisplay(parts: readonly string[]): string {
  // acceptConversationSummary：compact 续接时真实输入裹在 <conversation-summary> 里，
  // 这条 fallback 让 firstPrompt 显示摘要内文而不是字面 wrapper（NOISE_TAGS 不含此 tag）。
  const tagged = extractUserPrompt(parts, { tags: USER_PROMPT_TAGS, acceptConversationSummary: true });
  if (tagged) return tagged.slice(0, PROMPT_DISPLAY_LEN);
  const codexIdeRequest = extractCodexIdeRequest(parts);
  if (codexIdeRequest) return codexIdeRequest.slice(0, PROMPT_DISPLAY_LEN);
  // 没有任何 USER_PROMPT_TAG 命中：剥光 NOISE_TAGS 后取剩余文本（每个 part 单独剥，再拼）。
  const stripped = parts.map(p => stripKnownPromptNoise(p)).join('\n').trim();
  return (stripped || parts.join('\n').trim()).slice(0, PROMPT_DISPLAY_LEN);
}

// 整条 user 消息只包含已知注入 wrapper 时视为系统注入，没有真实用户输入，不进 chainHashes。
// 2026-06-11 从独立窄白名单改用完整 NOISE_TAGS：
//   ① Copilot 某些模型（gpt-5.5）会把 <environment_info>+<workspace_info>+<userMemory>
//      单独放进首条 user，这段文本**所有对话都相同**——不过滤的话 root hash 跨对话碰撞，
//      同根归并（v6）会把不同对话误并成一行，firstPrompt 也变成 envInfo 乱码；
//   ② <attachments>/<context>（附件内容 / 终端状态）独立 user 消息每回合抖动，
//      算进 chain 会让前缀在中途分歧，同一对话被拆成多行（2026-06-11 实测）。
// 带 <userRequest> 等真实输入标签的消息由 extractUserPrompt 提前豁免，不会被误杀。
// NOISE_TAGS 维护已搬到 clientSignatures.ts。
// 2026-06-13 方案 C：从单串改成 part 数组——逐 part 判定 + 配对计数 + 倒序优先，
// 防御 attachment 内容里字面字符 `<userRequest>` 引发的跨 part 错配。
/** 检测一段 user 文本（part 数组）是不是“只有系统注入的包装、没有人写的内容”。 */
function isSystemNoiseOnly(parts: readonly string[]): boolean {
  if (parts.length === 0) return true;
  if (extractUserPrompt(parts, { tags: USER_PROMPT_TAGS })) return false;
  // 每个 part 单独剥 noise，再拼起来看剩余非空白字符。
  return parts.map(p => stripKnownPromptNoise(p)).join('').trim().length === 0;
}

/** Remove client-owned context serialized inside a logical user turn. */
export function stripKnownPromptNoise(text: string): string {
  if (isLocalCommandCaveatPart(text)) return '';
  let out = text;
  for (const tag of NOISE_TAGS) {
    const re = new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?</' + tag + '>', 'gi');
    out = out.replace(re, '');
  }
  // Only remove the leading Codex repository marker when a blank-line
  // boundary separates it from the actual user prompt.
  out = out.replace(
    /^\s*#\s+AGENTS\.md instructions for [^\r\n]*(?:\r?\n[ \t]*){2,}/i,
    ''
  );
  return out;
}

/**
 * Stored firstPrompt values from affected versions flattened the caveat part and
 * the real prompt into one string. Repair only the leading, exact Claude-owned
 * wrapper; never remove a matching tag quoted later in user-authored prose.
 */
export function stripKnownLeadingPromptNoise(text: string): string {
  let out = stripKnownPromptNoise(text);
  const match = new RegExp(
    '^\\s*<' + LOCAL_COMMAND_CAVEAT_TAG + '\\b[^>]*>([\\s\\S]*?)</'
      + LOCAL_COMMAND_CAVEAT_TAG + '\\s*>',
    'i'
  ).exec(out);
  if (!match || normalize(match[1]) !== normalize(LOCAL_COMMAND_CAVEAT_TEXT)) return out;
  out = out.slice(match[0].length);
  return stripKnownPromptNoise(out);
}

function isLocalCommandCaveatPart(text: string): boolean {
  const match = new RegExp(
    '^\\s*<' + LOCAL_COMMAND_CAVEAT_TAG + '\\b[^>]*>([\\s\\S]*?)</'
      + LOCAL_COMMAND_CAVEAT_TAG + '\\s*>\\s*$',
    'i'
  ).exec(text);
  return !!match && normalize(match[1]) === normalize(LOCAL_COMMAND_CAVEAT_TEXT);
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function bodyOf(t: TapTraceRecord | undefined): Record<string, unknown> {
  const body = t?.request?.body;
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

function userMessageTexts(body: Record<string, unknown>): string[] {
  // detectCompact 等"按整段 user 文本子串匹配关键短语"的路径仍用 join 后的单串：
  // 短语命中跟 part 边界无关，且历史接口签名稳定。
  return userMessageParts(body).map(parts => parts.join('\n')).filter(t => t.length > 0);
}

/**
 * 返回每条**逻辑 user turn** 的 part 数组（不做 join）。
 * 这是方案 C 的结构基础：抽取 first prompt / 计算 chain hash 都在 part 边界内进行，
 * 防止跨 part 的字面字符（如 attachment 文档里的 `<userRequest>`）污染正则匹配。
 *
 * 关键不变量：**连续的 user-role 条目合并成一个逻辑 turn**（多个 part 拼一起）。
 * 起因：Copilot 切模型时，Anthropic /v1/messages 把 envInfo + <attachments> + image + <userRequest>
 * 打包成 ONE user 消息的多 part；OpenAI /v1/responses 同样内容却拆成多条 consecutive user-role
 * 条目（每条单 part）。不合并的话 Responses 形态会出现孤立 `<attachments>` 字面、image-only 条目
 * 挤进 chainHashes，与 Messages 形态产生不同的根 hash —— 同一对话切模型直接拆成两行。
 * Anthropic 协议本来就 user/assistant 交替，连续 user 极少出现，合并是空操作；Responses 协议
 * 才是合并的真正受益方。assistant / system / function_call 等非 user 条目是 turn 边界，触发 flush。
 */
function userMessageParts(body: Record<string, unknown>): string[][] {
  const list = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.input)
      ? body.input
      : [];
  const out: string[][] = [];
  let pending: string[] | undefined;
  const flush = () => {
    if (pending && pending.length > 0) out.push(pending);
    pending = undefined;
  };
  for (const item of list as unknown[]) {
    if (!item || typeof item !== 'object') { flush(); continue; }
    const obj = item as Record<string, unknown>;
    if (obj.role !== 'user') { flush(); continue; }
    const parts = contentParts(obj.content);
    if (parts.length === 0) continue; // 跳过纯非文本 (image-only 等) 条目，但不打断合并
    if (!pending) pending = [];
    pending.push(...parts);
  }
  flush();
  return out;
}

/** 保留 content part 边界，供结构化 prompt 抽取使用。 */
function contentParts(content: unknown): string[] {
  if (typeof content === 'string') return content ? [content] : [];
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') { if (block) parts.push(block); continue; }
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      if (typeof b.text === 'string' && b.text) parts.push(b.text);
      else if (typeof b.input_text === 'string' && b.input_text) parts.push(b.input_text);
      else if (typeof b.output_text === 'string' && b.output_text) parts.push(b.output_text);
    }
  }
  return parts;
}
