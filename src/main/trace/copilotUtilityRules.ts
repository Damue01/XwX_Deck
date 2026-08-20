/**
 * Copilot utility 请求的结构化分类器。
 *
 * 背景：VS Code 把 `chat.utilityModel` / `chat.utilitySmallModel` 指向 兼容服务
 * CustomEndpoint 后，Copilot 内部 utility 流量（title / patch repair / SCM /
 * categorization / workbench helpers）也会经 TapProxy。这些请求既不是主对话
 * 也不是 subagent，必须被显式分类，否则会被当主回合开成独立 session。
 *
 * 设计要点（v2，2026-06-22 重写）：
 *   1. 单一 source of truth：所有 utility 字面量与结构判定只在本文件。
 *      捕获层（tapProxy.shouldSkipTraceCapture）与 store 层（traceStore）
 *      都消费 classifyCopilotUtility 的结构化输出，不再各自堆 isCopilotXxx。
 *   2. Defense in depth：每条文本规则必须配结构 guard（apiType / tools /
 *      previous_response_id / <userRequest>），用户主对话引用 utility prompt 不会误判。
 *   3. 主链路强信号优先：分类前先跑 isLikelyMainCopilotTurn，prev_response_id /
 *      主 agent tools / <userRequest> 命中即返回 undefined（让上游主路径处理）。
 *   4. unknownUtility 兜底：结构上像 utility 但无已知模板匹配时，标 unknownUtility
 *      + visibility=hidden + confidence=weak，dashboard 不显示但落盘可见，便于补规则。
 *   5. 每条 classification 带 evidence 数组，trace.routedBy 与 evidence 一并落盘，
 *      排查时可直接看出"为什么归到这里"。
 *
 * 维护规约：
 *   - 客户端版本漂移：第一站到本表加/改 rule，更新 lastVerified。
 *   - 新加 rule 必须带 evidence、structural guard、文本锚点三件套。
 *   - 不要在其它文件复制 helper —— 全部 in-file，rule 自包含。
 */

import { TapTraceRecord } from './types';
import { extractCopilotTitleRootHash } from './sessionBoundary';
import { extractSystemText, firstUserText, headerValue } from './protocolBody';

function toolNames(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const tools = (body as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return [];
  const out: string[] = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    if (typeof o.name === 'string') { out.push(o.name); continue; }
    const fn = o.function;
    if (fn && typeof fn === 'object' && typeof (fn as Record<string, unknown>).name === 'string') {
      out.push((fn as Record<string, unknown>).name as string);
    }
  }
  return out;
}

function hasPreviousResponseId(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const v = (body as Record<string, unknown>).previous_response_id;
  return typeof v === 'string' && v.length > 0;
}

function stripMarkdownHeading(text: string): string {
  return text.replace(/^#+\s+.*\n+/, '');
}

// ============== 主链路保护 & utility shape guard ==============

/**
 * trace 看起来像 Copilot 主对话回合（不应进入 utility 分类）：
 *   - body 带 previous_response_id（Responses 续接，永远是主链路）
 *   - body 带主 agent tools 数量 ≥ 3（Copilot 主对话通常一次注入十几个 tool；
 *     utility 调用最多带 1 个分类用 tool，所以阈值 3 区分度足够且没有歧义）
 *   - 首条 user content 含 <userRequest> 标签（Copilot 主对话固定 wrapper）
 *
 * 任一命中即返回 true。返回 true 时 classifyCopilotUtility 直接 undefined。
 */
export function isLikelyMainCopilotTurn(trace: TapTraceRecord): boolean {
  const body = trace.request?.body;
  if (hasPreviousResponseId(body)) return true;
  if (toolNames(body).length >= 3) return true;
  const user = firstUserText(body);
  if (/<userRequest\b/i.test(user)) return true;
  return false;
}

/**
 * trace 看起来像 utility shape（结构上 plausible），用于 unknownUtility 兜底。
 *   - source=copilot
 *   - apiType=chat-completions（Copilot utility 几乎全是 chat-completions；
 *     主对话也可能是 chat-completions，所以这条 alone 不够强）
 *   - 无 previous_response_id
 *   - tools 数 ≤ 1（utility 通常 0 个 tool，或 1 个 categorize_prompt 这种）
 *   - 不像主回合（isLikelyMainCopilotTurn=false）
 *
 * 这是必要不充分条件——通过本函数的 trace 不一定是 utility，
 * 只是"如果未命中已知 rule 时，可以 hidden 兜底而非当主对话"。
 */
export function isLikelyUtilityShape(trace: TapTraceRecord): boolean {
  if (trace.source !== 'copilot') return false;
  if (trace.request?.apiType !== 'chat-completions') return false;
  if (isLikelyMainCopilotTurn(trace)) return false;
  if (toolNames(trace.request?.body).length > 1) return false;
  return true;
}

// ============== 分类器输出类型 ==============

export type CopilotUtilityKind =
  | 'title' | 'patch' | 'scm' | 'classifier' | 'intent' | 'workbench' | 'background'
  | 'unknownUtility';

export type CopilotUtilityVisibility = 'skip' | 'attach' | 'hidden';

export type CopilotUtilityConfidence = 'strong' | 'medium' | 'weak';

/**
 * routedByHint 指示 store 层怎么归并；store 层不需要再按 kind 写 switch。
 *   - 'rootHash'        : classification 带 rootHash，按 root 命中或落 provisional
 *   - 'interactionTurn' : 用 x-interaction-id 找同 turn 内的活跃主 session
 *   - 'recentSource'    : 短窗口（2 min）贴最近同 source 非 hidden 主 session
 *   - 'provisional'     : 落 hidden provisional，等主回合到达再吸收（pendingUtilityRoots）
 *   - 'drop'            : visibility=skip 时使用，store 层不会被调用，仅作枚举完整性
 */
export type CopilotUtilityRoutedByHint =
  | 'rootHash' | 'interactionTurn' | 'recentSource' | 'provisional' | 'drop';

export interface CopilotUtilityClassification {
  readonly kind: CopilotUtilityKind;
  readonly visibility: CopilotUtilityVisibility;
  readonly confidence: CopilotUtilityConfidence;
  readonly routedByHint: CopilotUtilityRoutedByHint;
  readonly evidence: readonly string[];
  /** title 等带主对话原文指纹的 rule 在此返回 rootHash；store 层据此走 root 路由。 */
  readonly rootHash?: string;
  /** 调试用：触发本分类的 rule id。 */
  readonly ruleId: string;
}

export interface CopilotUtilityRule {
  readonly id: string;
  readonly kind: CopilotUtilityKind;
  readonly visibility: CopilotUtilityVisibility;
  readonly confidence: CopilotUtilityConfidence;
  readonly routedByHint: CopilotUtilityRoutedByHint;
  readonly lastVerified: string;
  readonly notes?: string;
  /**
   * 返回 evidence 数组 = 命中；null = 未命中。
   * evidence 用于落盘排查（"为什么归到这里"），格式建议 `signal:detail` 例如
   * `apiType:chat-completions` / `anchor:invalidPatch`。
   */
  readonly classify: (trace: TapTraceRecord) => CopilotUtilityRuleHit | null;
}

export interface CopilotUtilityRuleHit {
  readonly evidence: readonly string[];
  readonly rootHash?: string;
}

export const COPILOT_UTILITY_RULES: readonly CopilotUtilityRule[] = [
  {
    id: 'title-chat',
    kind: 'title',
    visibility: 'attach',
    confidence: 'strong',
    routedByHint: 'rootHash',
    lastVerified: '2026-06-22',
    notes:
      'Copilot 主对话标题。结构 guard：chat-completions + 无 tools + 无 prev_id；' +
      '文本锚点：固定模板 "Please write a brief title for the following request: <原始首句>"。' +
      'sessionBoundary.extractCopilotTitleRootHash 抽出 rootHash，store 层据此精确归并。',
    classify: t => {
      // 结构 guard
      if (t.request?.apiType !== 'chat-completions') return null;
      if (hasPreviousResponseId(t.request?.body)) return null;
      if (toolNames(t.request?.body).length > 0) return null;

      // 文本锚点
      const user = firstUserText(t.request?.body);
      if (!/^please write a brief title for the following request:/i.test(user.trim())) return null;

      // 抽 rootHash（命中即返回 evidence + hash；抽不到也算命中，让 store 走 recentSource 兜底）
      const rootHash = extractCopilotTitleRootHash(user);
      const evidence = ['apiType:chat-completions', 'shape:no-tools', 'anchor:title-template'];
      if (rootHash) evidence.push('rootHash:' + rootHash.slice(0, 8));
      return { evidence, rootHash };
    }
  },
  {
    id: 'patch-repair',
    kind: 'patch',
    visibility: 'attach',
    confidence: 'strong',
    routedByHint: 'interactionTurn',
    lastVerified: '2026-06-22',
    notes:
      'Copilot 失败 patch 的修复请求。结构 guard：chat-completions + 无 tools + 无 prev_id。' +
      '文本三锚点：必须同时含 "The goal of the patch is:" + "The patch I want to apply is:" + "<invalidPatch"。' +
      'invalidPatch 是 Copilot 私有 wrapper，用户主对话不会天然出现，三锚点齐就是充要条件。' +
      'store 层先按 x-interaction-id 找同 turn 主 session（interactionTurn），失败再退 recentSource。',
    classify: t => {
      // 结构 guard
      if (t.request?.apiType !== 'chat-completions') return null;
      if (hasPreviousResponseId(t.request?.body)) return null;
      if (toolNames(t.request?.body).length > 0) return null;

      // 三锚点
      const text = firstUserText(t.request?.body);
      if (!text) return null;
      const lower = text.toLowerCase();
      const hasGoal = lower.includes('the goal of the patch is:');
      const hasPatchToApply = lower.includes('the patch i want to apply is:');
      const hasInvalidTag = lower.includes('<invalidpatch');
      if (!(hasGoal && hasPatchToApply && hasInvalidTag)) return null;

      return {
        evidence: [
          'apiType:chat-completions',
          'shape:no-tools',
          'anchor:patch-goal',
          'anchor:patch-to-apply',
          'anchor:invalidPatch'
        ]
      };
    }
  },
  {
    id: 'background',
    kind: 'background',
    visibility: 'skip',
    confidence: 'strong',
    routedByHint: 'drop',
    lastVerified: '2026-06-22',
    notes: 'header 显式标记后台请求，与主对话无关。',
    classify: t => {
      const h = t.request?.headers;
      const xit = headerValue(h, 'x-interaction-type').toLowerCase();
      const oi = headerValue(h, 'openai-intent').toLowerCase();
      if (xit === 'conversation-background') return { evidence: ['header:x-interaction-type=conversation-background'] };
      if (oi === 'conversation-background') return { evidence: ['header:openai-intent=conversation-background'] };
      return null;
    }
  },
  {
    id: 'scm-branch-name',
    kind: 'scm',
    visibility: 'skip',
    confidence: 'strong',
    routedByHint: 'drop',
    lastVerified: '2026-06-22',
    classify: t => {
      const text = firstUserText(t.request?.body).trim();
      if (!text) return null;
      const lower = stripMarkdownHeading(text).toLowerCase();
      if (!lower.startsWith('please write a brief branch name for the following request:')) return null;
      return { evidence: ['anchor:branch-name', 'apiType:' + (t.request?.apiType ?? '?')] };
    }
  },
  {
    id: 'scm-commit-message',
    kind: 'scm',
    visibility: 'skip',
    confidence: 'strong',
    routedByHint: 'drop',
    lastVerified: '2026-06-22',
    classify: t => {
      const text = firstUserText(t.request?.body).trim();
      if (!text) return null;
      const lower = stripMarkdownHeading(text).toLowerCase();
      if (!lower.includes('now generate a commit messages that describe the code changes')) return null;
      if (!lower.includes('only return a single markdown code block')) return null;
      return { evidence: ['anchor:commit-message', 'anchor:single-markdown-block'] };
    }
  },
  {
    id: 'scm-pr-title-desc',
    kind: 'scm',
    visibility: 'skip',
    confidence: 'strong',
    routedByHint: 'drop',
    lastVerified: '2026-06-22',
    classify: t => {
      const text = firstUserText(t.request?.body).trim();
      if (!text) return null;
      const lower = stripMarkdownHeading(text).toLowerCase();
      if (!lower.startsWith('these are the commits that will be included in the pull request you are about to make:')) return null;
      if (!lower.includes('below is a list of git patches')) return null;
      if (!lower.includes('the title and description of the pull request should be:')) return null;
      return { evidence: ['anchor:pr-commits', 'anchor:git-patches', 'anchor:pr-title-desc'] };
    }
  },
  {
    id: 'scm-repository-details',
    kind: 'scm',
    visibility: 'skip',
    confidence: 'strong',
    routedByHint: 'drop',
    lastVerified: '2026-06-22',
    classify: t => {
      const text = firstUserText(t.request?.body).trim();
      if (!text) return null;
      const lower = stripMarkdownHeading(text).toLowerCase();
      if (!lower.startsWith('repository details:')) return null;
      if (!lower.includes('repository name:')) return null;
      if (!lower.includes('branch name:')) return null;
      return { evidence: ['anchor:repository-details'] };
    }
  },
  {
    id: 'classifier-categorize-prompt',
    kind: 'classifier',
    visibility: 'skip',
    confidence: 'strong',
    routedByHint: 'drop',
    lastVerified: '2026-06-22',
    classify: t => {
      const body = t.request?.body;
      const sys = extractSystemText(body).toLowerCase();
      const tools = toolNames(body);
      if (sys.includes('expert classifier for ai coding assistant prompts')
        && sys.includes('categorize_prompt')) {
        return { evidence: ['system:expert-classifier', 'system:categorize_prompt'] };
      }
      if (tools.includes('categorize_prompt')
        && firstUserText(body).toLowerCase().includes('user message:')) {
        return { evidence: ['tool:categorize_prompt', 'anchor:user-message'] };
      }
      return null;
    }
  },
  {
    id: 'intent-detection',
    kind: 'intent',
    visibility: 'skip',
    confidence: 'strong',
    routedByHint: 'drop',
    lastVerified: '2026-06-22',
    classify: t => {
      const body = t.request?.body;
      const sys = extractSystemText(body).toLowerCase();
      const user = firstUserText(body).toLowerCase();
      if (sys.includes('choose one category from the markdown table of categories below')
        && sys.includes('respond with just the category name')) {
        return { evidence: ['system:markdown-table', 'system:category-name'] };
      }
      if (user.startsWith('a software developer is using an ai chatbot in a code editor')
        && user.includes('available functions:') && user.includes('response:')) {
        return { evidence: ['anchor:developer-chatbot', 'anchor:available-functions'] };
      }
      return null;
    }
  },
  {
    id: 'workbench-issue-title',
    kind: 'workbench',
    visibility: 'skip',
    confidence: 'strong',
    routedByHint: 'drop',
    lastVerified: '2026-06-22',
    classify: t => {
      const user = firstUserText(t.request?.body).trim().toLowerCase();
      if (!user.startsWith('generate a concise issue title (max 10 words')) return null;
      return { evidence: ['anchor:issue-title'] };
    }
  },
  {
    id: 'workbench-progress-batch',
    kind: 'workbench',
    visibility: 'skip',
    confidence: 'strong',
    routedByHint: 'drop',
    lastVerified: '2026-06-22',
    classify: t => {
      const user = firstUserText(t.request?.body).trim().toLowerCase();
      if (!user.startsWith('please generate exactly ')) return null;
      if (!user.includes(' unique progress messages for the "')) return null;
      if (!user.includes(' code" scenario')) return null;
      if (!user.includes('return only a json array of strings')) return null;
      return { evidence: ['anchor:progress-batch'] };
    }
  },
  {
    id: 'workbench-progress-single',
    kind: 'workbench',
    visibility: 'skip',
    confidence: 'strong',
    routedByHint: 'drop',
    lastVerified: '2026-06-22',
    classify: t => {
      const body = t.request?.body;
      const sys = extractSystemText(body).toLowerCase();
      const user = firstUserText(body).toLowerCase();
      if (!sys.includes('short, catchy, and encouraging progress messages for a coding assistant')) return null;
      if (!user.includes('generate a single short progress message that is specific to this request')) return null;
      return { evidence: ['system:progress-msg', 'anchor:single-progress'] };
    }
  },
  {
    id: 'workbench-status-badge',
    kind: 'workbench',
    visibility: 'skip',
    confidence: 'strong',
    routedByHint: 'drop',
    lastVerified: '2026-06-22',
    classify: t => {
      const sys = extractSystemText(t.request?.body).toLowerCase();
      if (!sys.includes('single short phrase suitable for a status badge')) return null;
      return { evidence: ['system:status-badge'] };
    }
  },
  {
    id: 'workbench-one-sentence-summary',
    kind: 'workbench',
    visibility: 'skip',
    confidence: 'strong',
    routedByHint: 'drop',
    lastVerified: '2026-06-22',
    classify: t => {
      const user = firstUserText(t.request?.body).trim().toLowerCase();
      if (!user.startsWith('summarize the following content in a single sentence (under 10 words)')) return null;
      return { evidence: ['anchor:one-sentence-summary'] };
    }
  },
  {
    id: 'workbench-changes-analyze',
    kind: 'workbench',
    visibility: 'skip',
    confidence: 'strong',
    routedByHint: 'drop',
    lastVerified: '2026-06-22',
    classify: t => {
      const user = firstUserText(t.request?.body).trim().toLowerCase();
      if (!user.startsWith('analyze these ')) return null;
      if (!user.includes(' code changes across ')) return null;
      if (!user.includes('return only valid json')) return null;
      return { evidence: ['anchor:changes-analyze'] };
    }
  },
  {
    id: 'workbench-terminal-risk',
    kind: 'workbench',
    visibility: 'skip',
    confidence: 'strong',
    routedByHint: 'drop',
    lastVerified: '2026-06-22',
    classify: t => {
      const user = firstUserText(t.request?.body).trim().toLowerCase();
      if (!user.startsWith('you assess what one terminal command does for a code-editing ai agent')) return null;
      return { evidence: ['anchor:terminal-risk'] };
    }
  },
  {
    id: 'workbench-tool-risk',
    kind: 'workbench',
    visibility: 'skip',
    confidence: 'strong',
    routedByHint: 'drop',
    lastVerified: '2026-06-22',
    classify: t => {
      const user = firstUserText(t.request?.body).trim().toLowerCase();
      if (!user.startsWith('you assess what one tool call does for a code-editing ai agent')) return null;
      return { evidence: ['anchor:tool-risk'] };
    }
  },
  {
    id: 'workbench-name-suggestions',
    kind: 'workbench',
    visibility: 'skip',
    confidence: 'strong',
    routedByHint: 'drop',
    lastVerified: '2026-06-22',
    classify: t => {
      const body = t.request?.body;
      const sys = extractSystemText(body).toLowerCase();
      const user = firstUserText(body).toLowerCase();
      if (!sys.includes('you are a distinguished software engineer')) return null;
      if (!sys.includes('json array of strings')) return null;
      if (!user.includes('reply with a json array of strings of at least four new names')) return null;
      return { evidence: ['system:name-suggestions', 'anchor:json-array'] };
    }
  }
];

export function classifyCopilotUtility(trace: TapTraceRecord): CopilotUtilityClassification | undefined {
  if (trace.source !== 'copilot') return undefined;
  if (isLikelyMainCopilotTurn(trace)) return undefined;

  for (const rule of COPILOT_UTILITY_RULES) {
    const hit = rule.classify(trace);
    if (hit) {
      return {
        kind: rule.kind,
        visibility: rule.visibility,
        confidence: rule.confidence,
        routedByHint: rule.routedByHint,
        evidence: hit.evidence,
        rootHash: hit.rootHash,
        ruleId: rule.id
      };
    }
  }

  // unknownUtility 兜底：结构像 utility 但没命中已知模板 → hidden capture
  if (isLikelyUtilityShape(trace)) {
    return {
      kind: 'unknownUtility',
      visibility: 'hidden',
      confidence: 'weak',
      routedByHint: 'recentSource',
      evidence: ['shape:chat-completions', 'shape:no-prev-id', 'shape:not-main-turn'],
      ruleId: '__unknownUtility'
    };
  }

  return undefined;
}

// 暴露 helper 给上游需要时复用（store 层 patch 归并要 x-interaction-id）
export function extractInteractionId(trace: TapTraceRecord): string | undefined {
  const v = headerValue(trace.request?.headers, 'x-interaction-id');
  return v.length > 0 ? v : undefined;
}
