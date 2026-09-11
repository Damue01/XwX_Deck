import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { EventEmitter } from 'events';
import { ensureDir, writeJson } from '../shared/fsx';
import { clampInt } from '../shared/obj';
import { TAP_LOCK_FILE } from './tapPortLock';
import { TRACE_WRITER_LEASE_FILE } from './traceWriterLease';
import {
  TapDailyUsage,
  TapHistoryIndex,
  TapModelUsage,
  TapModelUsageBand,
  TapRatePoint,
  TapSessionSummary,
  TapSessionTracePage,
  TapSubagentInfo,
  TapTraceRecord
} from './types';
import { billableTotalTokens } from './normalizeUsage';
import { findModelPriceForUsage, isBandedPrice, isOffPeakAt, isShortOutput, resolvePriceTierIndex } from './pricing';
import { detectCompact, detectSubagent, detectSubagentMode, extractAnthropicTitleRootHash, extractClaudeAgentId, extractCodexThreadAncestry, extractCodexTitleRootHash, extractCopilotTitleRootHash, extractFingerprint, extractPreviousResponseId, extractResponseId, SessionFingerprint, stripKnownLeadingPromptNoise, stripKnownPromptNoise, subagentInvocations } from './sessionBoundary';
import { extractClientConversationKey } from './clientAdapters';
import { extractInteractionId } from './copilotUtilityRules';
import { extractCodexIdeRequest } from './userPrompt';
import { parseJsonlLines, userTexts } from './protocolBody';
import { SSEReassembler } from './sseReassembler';
import {
  classifyAuxiliaryTrace,
  extractGeneratedTitle,
  findHiddenProvisionalByPendingClientKey,
  findHiddenProvisionalByPendingRoot,
  findRecentCompactResumeHost,
  findRecentEditedPromptSession,
  findRecentHiddenAuxiliarySession,
  findRecentMainSession,
  findRecentSessionBySource,
  findRecentTitleHostSession,
  findSessionByClientConversationKey,
  findSessionByInteractionId,
  findSessionByPendingSubagentRoot,
  findSessionByResponseId,
  findSessionByRootHash,
  getCopilotClassification,
  isCodexStructuredUtilityTrace,
  matchSession
} from './sessionRouter';

const INDEX_FILE = 'index.json';
const DEFAULT_STORAGE_CLEANUP_RECENT_MS = 30 * 60 * 1000;
// A single captured Codex request can be 10-15 MB when it repeats a very large
// conversation. Count-only pagination therefore allowed a 160-item page to
// exceed 1 GB and made the live viewer appear to hang. Keep ordinary traces at
// the existing page size, but adapt the count for unusually large JSONL files.
const MAX_TRACE_PAGE_ESTIMATED_BYTES = 24 * 1024 * 1024;

type AppendListener = (trace: TapTraceRecord) => void;

export interface TraceStorageStats {
  readonly rootPath: string;
  readonly totalBytes: number;
  readonly maxBytes?: number;
}

export class TraceStore {
  private currentSessionId: string | undefined;
  private readonly events = new EventEmitter();
  private readonly legacyTitleRepairChecks = new Set<string>();
  private readonly legacyClaudeTitleRouteChecks = new Set<string>();
  /**
   * Codex 子 agent 的 thread id → 嵌套深度。header 只给出父 thread id，深度要靠"父 thread
   * 是否也是子 agent"逐层推出，因此必须跨 appendTrace 记住见过的子 agent thread。
   * 有上限：长跑进程里 thread 只增不减，超出后丢最早的（深链场景极少，退化为 depth 1 可接受）。
   */
  private readonly codexSubagentThreads = new Map<string, number>();
  /**
   * Claude 子 agent 的 x-claude-code-agent-id → 已知的最佳展示名。
   * prompt hash 只在子 agent 首条请求（首条 user 消息 == Task prompt）盖得上章，此后进入工具
   * 循环就再也匹配不上；名字只有盖章那次拿得到。记住它，后续同 agent 的请求才不会退回裸
   * "Subagent"。与 codexSubagentThreads 同样有上限，超出丢最早的。
   */
  private readonly claudeSubagentLabels = new Map<string, { label: string; agentType?: string; invocationId?: string; parentInvocationId?: string; depth: number }>();
  /**
   * index.json 串行化锁（2026-06-15）：所有"读取 index → 修改 → 写回"的路径都通过 withIndexLock。
   *
   * 起因：单进程并发请求 → 并发 appendTrace → 各自 readIndex 拿到同一份旧快照 → 各自计算
   * turn=N+1 写回 → last-write-wins 互相覆盖。实测翻车（tests/jsonl 2026-06-15T02-45-46-581Z）：
   *   - 5 处 turn 重号（同一 turn 出现 2 次）
   *   - traceCount 比物理 trace 数少 5
   *   - session.source / firstPrompt 等聚合字段偶发空白
   *
   * 设计：
   *   - 写路径：appendTrace / startSession / cleanup / deleteSession / clearAll 都包 withIndexLock。
   *   - 读路径：listSessions / readSession / latestTrace 不参与——它们只 readIndex，
   *     即使读到旧快照也只是读到旧数据，不会污染。
   *   - 防重入：startSession 内部调 cleanup、appendTrace 内部调 startSession，
   *     这些"内部互调"走 _*Locked 版（不再二次获取锁），避免死锁。
   *   - 容错：链上某次操作 reject 不应卡住后续——withIndexLock 在 chain 中央 catch 掉异常，
   *     但 throw 给本次调用方。
   */
  private indexChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly rootDir: string,
    private readonly maxSessions: () => number = () => 0,
    private readonly maxStorageBytes: () => number | undefined = () => undefined,
    private readonly sessionTitleOverlay: (
      sessions: readonly TapSessionSummary[]
    ) => Promise<ReadonlyMap<string, string>> = async () => new Map()
  ) {}

  rootPath(): string {
    return this.rootDir;
  }

  currentSessionIdValue(): string | undefined {
    return this.currentSessionId;
  }

  indexPath(): string {
    return path.join(this.rootDir, INDEX_FILE);
  }

  async storageStats(): Promise<TraceStorageStats> {
    return {
      rootPath: this.rootDir,
      totalBytes: await directorySize(this.rootDir),
      maxBytes: this.configuredMaxStorageBytes()
    };
  }

  onDidAppend(listener: AppendListener): { dispose(): void } {
    this.events.on('append', listener);
    return { dispose: () => this.events.off('append', listener) };
  }

  /** 把任意"读改写 index.json"的操作串行化执行；并发调用按到达顺序排队。 */
  private withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.indexChain.then(fn, fn);
    // chain 自身吞掉异常（避免后续调用因为前面失败而卡死），但 next 仍会把异常透传给调用方。
    this.indexChain = next.then(() => undefined, () => undefined);
    return next;
  }

  async startSession(
    now: Date = new Date(),
    fingerprint?: SessionFingerprint,
    options: { clientConversationKey?: string } = {}
  ): Promise<TapSessionSummary> {
    return this.withIndexLock(() => this._startSessionLocked(now, fingerprint, options));
  }

  private async _startSessionLocked(
    now: Date,
    fingerprint: SessionFingerprint | undefined,
    options: { clientConversationKey?: string } = {}
  ): Promise<TapSessionSummary> {
    await ensureDir(this.rootDir);
    const index = await this.readIndex();
    const id = await this.uniqueSessionId(now);
    const session: TapSessionSummary = {
      id,
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastRequestAt: now.toISOString(),
      traceCount: 0,
      jsonlPath: this.sessionJsonlPath(id),
      firstPrompt: fingerprint?.firstPrompt || undefined,
      lastChain: fingerprint && fingerprint.chainHashes.length > 0
        ? [...fingerprint.chainHashes]
        : undefined,
      clientConversationKey: options.clientConversationKey
    };
    index.sessions.push(session);
    this.currentSessionId = id;
    await this.writeIndex(index);
    await this._cleanupLocked();
    return session;
  }

  async currentSession(): Promise<TapSessionSummary> {
    const index = await this.readIndex();
    const current = this.currentSessionId
      ? index.sessions.find(s => s.id === this.currentSessionId)
      : undefined;
    if (current) return current;
    return this.startSession();
  }

  /**
   * Fail closed before enabling capture when an existing index cannot be read.
   * Routing may continue without recording, but no caller may replace an
   * unreadable index with a freshly generated partial index.
   */
  async assertIndexReadable(): Promise<void> {
    await this.readIndex();
  }

  async appendTrace(trace: TapTraceRecord): Promise<TapTraceRecord> {
    return this.withIndexLock(() => this._appendTraceLocked(trace));
  }

  private async _appendTraceLocked(trace: TapTraceRecord): Promise<TapTraceRecord> {
    let index = await this.readIndex();
    const fp = extractFingerprint(trace);
    const classifiedAuxiliary = classifyAuxiliaryTrace(trace);
    const codexUtility = !classifiedAuxiliary && isCodexStructuredUtilityTrace(trace);
    // Generic structured-output helpers are auxiliary even when their schema
    // is not one of the named title/memory signatures. Persist that fact so
    // they cannot supply a visible title, flip lastTurnError, or count as a
    // user turn merely because routing sent them to the hidden utility bucket.
    const auxiliary: TapTraceRecord['auxiliary'] = classifiedAuxiliary
      ?? (codexUtility ? 'utility' : undefined);
    const compact = detectCompact(trace) || undefined;
    const startedAt = new Date(trace.startedAt || Date.now());
    const clientConversationKey = trace.clientConversationKey || extractClientConversationKey(trace);

    // 子 agent 判定分两路：
    // - Claude Code Task spawn：system 开场白即可定性（detectSubagent）。
    // - Copilot runSubagent / Codex spawn_agent：子 agent 请求复用主 agent prompt，开场白认不出。
    //   唯一可靠信号是任务文本本身：主会话响应里 spawn 工具的 input.prompt/message hash
    //   （pendingSubagentRoots）与新请求的 chain hash 命中 ⇒ 定性 + 直接拿到归并目标。
    //   <modeInstructions>（Copilot 才有）仅提供展示 label，不是必要条件。
    let subagent = auxiliary ? undefined : detectSubagent(trace);
    let subagentInfo: TapSubagentInfo | undefined;
    let subagentHost: TapSessionSummary | undefined;
    if (!auxiliary) {
      // 任务 prompt 不一定在 chainHashes[0]：Copilot 子 agent 请求首条 user 可能是 env 注入
      // （noise-only 过滤后通常已跳过，但保险起见扫前几项）。
      const candidates = fp.chainHashes.slice(0, 4);
      if (candidates.length > 0) {
        const match = findSessionByPendingSubagentRoot(
          index.sessions,
          startedAt,
          candidates,
          trace.source,
          clientConversationKey
        );
        subagentHost = match?.session;
        if (match?.invocation) {
          subagentInfo = {
            invocationId: match.invocation.id,
            ...(match.invocation.parentId
              ? { parentInvocationId: match.invocation.parentId }
              : {}),
            depth: match.invocation.depth,
            ...(match.invocation.agentType
              ? { agentType: match.invocation.agentType }
              : {})
          };
        }
        const matchedLabel = match?.invocation?.displayName || match?.invocation?.agentType;
        if (matchedLabel && (!subagent || subagent === 'Subagent' || subagent === 'AgentSDK')) {
          subagent = matchedLabel;
        } else if (subagentHost && !subagent) {
          subagent = detectSubagentMode(trace) || 'Subagent';
        }
      }
    }

    // Claude 的 x-claude-code-agent-id 是这个子 agent 自己的稳定身份，每条请求都有；
    // prompt hash 盖章只在首条请求成立。两者合起来才完整：hash 给名字和父子链，header 给归组键。
    // 不做这一步，一个子 agent 的 13 条请求会因为「6 条盖上章、7 条没盖上」被切成 3 张侧栏卡。
    const claudeAgentId = subagent && !auxiliary ? extractClaudeAgentId(trace) : undefined;
    if (claudeAgentId) {
      const remembered = this.claudeSubagentLabels.get(claudeAgentId);
      const matchedLabel = subagent;
      if (subagentInfo) {
        // 盖章成功：记住名字/类型/父子链，供同 agent 的后续请求复用。
        if (matchedLabel) {
          if (this.claudeSubagentLabels.size >= 512) {
            const oldest = this.claudeSubagentLabels.keys().next().value;
            if (oldest !== undefined) this.claudeSubagentLabels.delete(oldest);
          }
          this.claudeSubagentLabels.set(claudeAgentId, {
            label: matchedLabel,
            agentType: subagentInfo.agentType,
            invocationId: subagentInfo.invocationId,
            parentInvocationId: subagentInfo.parentInvocationId,
            depth: subagentInfo.depth
          });
        }
        subagentInfo = { ...subagentInfo, agentId: claudeAgentId };
      } else if (remembered) {
        // 没盖上章但这个 agent 之前盖过：沿用它的身份，别退回裸 "Subagent"。
        subagentInfo = {
          invocationId: remembered.invocationId || claudeAgentId,
          ...(remembered.parentInvocationId ? { parentInvocationId: remembered.parentInvocationId } : {}),
          depth: remembered.depth,
          ...(remembered.agentType ? { agentType: remembered.agentType } : {}),
          agentId: claudeAgentId
        };
        if (!subagent || subagent === 'Subagent' || subagent === 'AgentSDK') subagent = remembered.label;
      } else {
        // 整个 agent 都没盖上章（fork / compaction / 噪声包裹首条消息）：至少让 header 撑起归组。
        subagentInfo = { invocationId: claudeAgentId, depth: 1, agentId: claudeAgentId };
      }
    }

    // Codex 的 thread header 是权威父子链：hash 路径没盖上章时用它兜底补 ancestry。
    // 区分同名并行子 Agent 靠 viewer 从 invocationId 派生的短 id 徽标（对 Claude / Codex 一视同仁），
    // 不再把短 id 塞进 agentType 槽位——那个槽位是「general-purpose」这类真实 agent 类型，
    // 被一串 hex 占住后 subagentColor() 永远拿不到真名，Explore 之类也就拿不到对应强调色。
    if (subagent) {
      const threadAncestry = extractCodexThreadAncestry(trace);
      if (threadAncestry && !subagentInfo) {
        const parentIsSubagent = this.codexSubagentThreads.has(threadAncestry.parentInvocationId || '');
        const parentDepth = parentIsSubagent
          ? (this.codexSubagentThreads.get(threadAncestry.parentInvocationId || '') || 1)
          : 0;
        const depth = parentDepth + 1;
        if (this.codexSubagentThreads.size >= 512) {
          const oldest = this.codexSubagentThreads.keys().next().value;
          if (oldest !== undefined) this.codexSubagentThreads.delete(oldest);
        }
        this.codexSubagentThreads.set(threadAncestry.invocationId, depth);
        subagentInfo = {
          invocationId: threadAncestry.invocationId,
          ...(parentIsSubagent ? { parentInvocationId: threadAncestry.parentInvocationId } : {}),
          depth
        };
      }
    }

    // 1. 反查路由：按 chainHashes 前缀延伸到合适的 session。
    // Routing order and source/window guardrails are documented in docs/session-routing.md.
    // routedBy is persisted so the dashboard can expose routing drift.
    let session: TapSessionSummary | undefined;
    let routedBy: TapTraceRecord['routedBy'] | undefined;

    // A native Responses continuation id outranks prompt heuristics.
    const prevRespId = extractPreviousResponseId(trace);
    if (prevRespId) {
      const hit = findSessionByResponseId(index.sessions, prevRespId, trace.source);
      if (hit) {
        session = hit;
        routedBy = 'prevResponseId';
      }
    }

    if (!session && clientConversationKey && !codexUtility) {
      const hit = findSessionByClientConversationKey(index.sessions, clientConversationKey, trace.source);
      if (hit) {
        session = hit;
        routedBy = hit.hidden === true ? 'absorbHidden' : 'clientConversationKey';
      }
    }

    // Claude title generation may beat the first main turn by a few milliseconds
    // while already carrying the main x-claude-code-session-id. Only a real main
    // turn may consume that provisional key and establish the canonical key.
    if (!session && clientConversationKey && !auxiliary && !subagent && !codexUtility) {
      const hit = findHiddenProvisionalByPendingClientKey(
        index.sessions,
        clientConversationKey,
        trace.source
      );
      if (hit) {
        session = hit;
        routedBy = 'absorbHidden';
      }
    }

    if (!session) {
      if (auxiliary === 'title') {
        const titleBody = trace.request?.body;
        const titleUserTexts = titleBody && typeof titleBody === 'object'
          ? userTexts(titleBody as Record<string, unknown>)
          : [];
        const isClaudeTitle = trace.source === 'claude-cli' || trace.source === 'claude-vscode';
        let titleRoot: string | undefined;
        for (let i = titleUserTexts.length - 1; i >= 0 && !titleRoot; i -= 1) {
          titleRoot = trace.source === 'copilot'
            ? extractCopilotTitleRootHash(titleUserTexts[i])
            : (trace.source === 'codex-cli' || trace.source === 'codex-vscode')
              ? extractCodexTitleRootHash(titleUserTexts[i])
              : isClaudeTitle
                ? extractAnthropicTitleRootHash(titleUserTexts[i])
                : undefined;
        }

        // Claude uses the main session id on the title request. Preserve it only
        // as a pending exact key when the title arrives before the main turn.
        if (isClaudeTitle && clientConversationKey) {
          session = findHiddenProvisionalByPendingClientKey(
            index.sessions,
            clientConversationKey,
            trace.source
          );
          if (!session) {
            session = await this.createHiddenProvisionalForClientKeyLocked(
              index,
              startedAt,
              trace.source,
              clientConversationKey,
              titleRoot
            );
          }
          routedBy = 'provisionalTitle';
        }

        // Prompt roots remain an exact fallback for Claude versions without the
        // header, and for Codex/Copilot utility threads.
        if (!session && titleRoot) {
            session = findSessionByRootHash(index.sessions, titleRoot, trace.source, startedAt);
            if (session) {
              routedBy = 'auxRootHash';
            } else {
              session = await this.createHiddenProvisionalForRootLocked(
                index, startedAt, trace.source, 'title', titleRoot
              );
              routedBy = 'provisionalTitle';
            }
        }

        // A title can change a visible session name, so weak same-source routing
        // is never safe. Preserve unknown/future title formats in a hidden bucket.
        if (!session) {
          session = await this.ensureUnknownUtilityBucketLocked(index, startedAt, trace.source);
          routedBy = 'unknownUtility';
        }
      } else if (auxiliary === 'policy') {
        // Policy helpers do not write visible titles, so older Claude clients may
        // retain the guarded same-source fallback.
        session = findRecentTitleHostSession(index.sessions, startedAt, trace.source);
        if (session) routedBy = 'auxSource';
      } else if (codexUtility) {
      session = await this.ensureUnknownUtilityBucketLocked(index, startedAt, trace.source);
      routedBy = 'unknownUtility';
      } else if (auxiliary === 'memory') {
      // A memory-maintenance request with a native conversation key was already
      // attached above. Orphan maintenance traffic remains hidden and auditable
      // rather than creating a dashboard row that looks user-authored.
      session = await this.ensureMemoryUtilityBucketLocked(index, startedAt, trace.source);
      routedBy = 'unknownUtility';
      } else if (auxiliary === 'count') {
      const matched = clientConversationKey
        ? undefined
        : matchSession(index.sessions, fp, { now: startedAt, source: trace.source });
      if (matched) {
        session = matched.session;
        routedBy = matched.by === 'pickRecent' ? 'auxSource' : matched.by; // 'prefix' | 'root'
      } else if (!clientConversationKey) {
        session = findRecentSessionBySource(index.sessions, startedAt, trace.source);
        if (session) routedBy = 'auxSource';
      }
      } else if (auxiliary === 'patch' && trace.source === 'copilot') {
      // Patch routing falls back from interaction id to a same-source window, then a hidden bucket.
      const iid = extractInteractionId(trace);
      if (iid) {
        session = findSessionByInteractionId(index.sessions, iid, trace.source, startedAt);
        if (session) routedBy = 'interactionTurn';
      }
      if (!session) {
        session = findRecentMainSession(index.sessions, startedAt, trace.source, 2 * 60 * 1000);
        if (session) routedBy = 'utilityRecent';
      }
      if (!session) {
        session = await this.ensureUnknownUtilityBucketLocked(index, startedAt, trace.source);
        routedBy = 'unknownUtility';
      }
      } else if (subagent) {
      if (subagentHost) {
        session = subagentHost;
        routedBy = 'pendingSubagentRoot';
      } else if (!clientConversationKey) {
        session = findRecentSessionBySource(index.sessions, startedAt, trace.source);
        if (session) {
          routedBy = 'auxSource';
        } else {
          // chainHashes=[] 的 fallback：subagent 兜底取最近 session（同 source 内）
          const matched = matchSession(index.sessions, { chainHashes: [], firstPrompt: '' }, { now: startedAt, source: trace.source });
          if (matched) {
            session = matched.session;
            routedBy = 'auxSource';
          }
        }
      }
      } else {
      if (!session && (compact || fp.compactResume)) {
        session = findRecentCompactResumeHost(index.sessions, startedAt, trace.source);
        if (session) routedBy = 'compactResume';
      }
      // Unknown utility traffic must be hidden before main-session matching.
      if (!session && trace.source === 'copilot') {
        const classification = getCopilotClassification(trace);
        if (classification && classification.kind === 'unknownUtility') {
          session = await this.ensureUnknownUtilityBucketLocked(index, startedAt, trace.source);
          routedBy = 'unknownUtility';
        }
      }
      if (!session && !clientConversationKey && fp.chainHashes.length > 0) {
        const root = fp.chainHashes[0];
        const host = findHiddenProvisionalByPendingRoot(index.sessions, root, trace.source);
        if (host) {
          session = host;
          routedBy = 'absorbHidden';
        }
      }
      if (!session && !clientConversationKey) {
        session = findRecentHiddenAuxiliarySession(index.sessions, startedAt, trace.source);
        if (session) routedBy = 'absorbHidden';
      }
      if (!session) {
        // matchSession enforces the same-source guard for prompt roots.
        const matched = matchSession(index.sessions, fp, { now: startedAt, source: trace.source, clientConversationKey });
        if (matched) {
          session = matched.session;
          // 'pickRecent'（chainHashes=[] 服务请求）很少在主路径出现，归到 'absorbHidden' 风格的兜底类
          routedBy = matched.by === 'pickRecent' ? 'auxSource' : matched.by; // 'prefix' | 'root'
        }
      }
      // A main turn may absorb a same-source provisional title with an exact root.
      if (!session && !auxiliary && !subagent && fp.chainHashes.length > 0) {
        const root = fp.chainHashes[0];
        const host = findHiddenProvisionalByPendingRoot(index.sessions, root, trace.source);
        if (host) {
          session = host;
          routedBy = 'absorbHidden';
        }
      }
      if (!session && !clientConversationKey) {
        // Copilot can rotate the root when the first prompt is edited and resent before a response lands.
        session = findRecentEditedPromptSession(index.sessions, startedAt, trace.source, fp);
        if (session) routedBy = 'editResend';
      }
      }
    }

    // 2. 兜底：currentSessionId 指向的空 session（startSession 之后还没落第一条 trace）。
    if (!session && this.currentSessionId) {
      const candidate = index.sessions.find(s => s.id === this.currentSessionId);
      if (candidate && candidate.traceCount === 0) {
        session = candidate;
        routedBy = 'currentEmpty';
      }
    }

    // 3. 仍未命中：开新会话；startSession 会持久化 index，所以要重新读取。
    //    这里走 _startSessionLocked（不二次获取锁）——_appendTraceLocked 已持锁。
    if (!session) {
      session = await this._startSessionLocked(startedAt, auxiliary || subagent ? undefined : fp, { clientConversationKey });
      index = await this.readIndex();
      routedBy = 'newSession';
    } else {
      this.currentSessionId = session.id;
    }

    const turn = session.traceCount + 1;
    const record: TapTraceRecord = {
      ...trace,
      auxiliary,
      subagent,
      subagentInfo,
      compact,
      routedBy,
      clientConversationKey,
      sessionId: session.id,
      turn
    };
    await ensureDir(this.rootDir);
    await fs.promises.appendFile(session.jsonlPath, JSON.stringify(record) + '\n', 'utf8');

    // firstPrompt 首次有值即冻结（避免后续请求的 user 文本覆盖标题）。
    // lastChain 每次都更新到本次 trace 的 chain，支撑下一次前缀延伸匹配。
    // 子 agent 的 prompt 是任务描述、chain 与主对话无关，两者都不参与。
    const nextFirstPrompt = session.firstPrompt && session.firstPrompt.length > 0
      ? session.firstPrompt
      : (auxiliary || subagent ? undefined : (fp.firstPrompt || undefined));
    // 客户端生成的会话标题（Codex title 请求响应）：首次有值即冻结，展示时优先于 firstPrompt。
    const generatedTitle = auxiliary === 'title' ? extractGeneratedTitle(record) : undefined;
    const nextTitle = session.title && session.title.length > 0 ? session.title : generatedTitle;
    const nextLastChain = !auxiliary && !subagent && fp.chainHashes.length > 0
      ? [...fp.chainHashes]
      : session.lastChain;

    // 本回合响应里的 runSubagent 类工具调用：记下任务 prompt hash，
    // 随后到达的子 agent 请求靠它精确归并回本 session（保留最近 16 次调用）。
    // pendingSubagents 是权威来源；legacy 的 pendingSubagentRoots 由它**派生**而非独立累加——
    // 早先两者各自 slice(-16)（一边 16 次调用、一边 16 个哈希≈8 次调用），窗口会漂移，
    // 路由端只能两边都查再 || 兜底，且无法判断哪份权威。
    const invocationRecords = subagentInvocations(record);
    const nextPendingSubagents = invocationRecords.length > 0
      ? [...(session.pendingSubagents || []), ...invocationRecords].slice(-16)
      : session.pendingSubagents;
    const nextPendingSubagentRoots = invocationRecords.length > 0
      ? (nextPendingSubagents || []).flatMap(invocation => invocation.roots)
      : session.pendingSubagentRoots;

    // 本回合响应的 response_id（OpenAI Responses 协议 = response_id；Anthropic = message_id）。
    // Retain recent response ids for native continuation routing.
    const respId = extractResponseId(record);
    const nextResponseIds = respId
      ? [...(session.responseIds || []), respId].slice(-16)
      : session.responseIds;

    // Only main turns contribute interaction ids used by patch routing.
    const interactionId = extractInteractionId(trace);
    const nextInteractionIds: readonly string[] | undefined = (() => {
      if (!interactionId || auxiliary || subagent) return session.interactionIds;
      const existing = session.interactionIds ?? [];
      if (existing.includes(interactionId)) return existing;
      const next = [...existing, interactionId];
      return next.length > 16 ? next.slice(next.length - 16) : next;
    })();

    // dashboard 聚合字段：增量累加，避免每次打开 dashboard 都重读 jsonl。
    const recordTokens = totalTokensOfTrace(record);
    const recordIsError = traceHasError(record);
    const isMainTurn = !auxiliary && !subagent;
    const nextTotalTokens = (session.totalTokens || 0) + recordTokens;
    const nextErrorCount = (session.errorCount || 0) + (recordIsError ? 1 : 0);
    // lastTurnError: only main turns flip this; aux/subagent failures don't block continuation.
    const nextLastTurnError = isMainTurn ? recordIsError : session.lastTurnError;
    const nextFirstModel = session.firstModel || (auxiliary || subagent ? undefined : record.request?.model) || undefined;
    const nextSource = session.source || record.source || undefined;
    const nextFirstClient = session.firstClient || (auxiliary || subagent ? undefined : record.client) || undefined;
    const nextUsageByModel = accumulateUsageByModel(session.usageByModel, record);
    const nextDailyUsage = accumulateDailyUsage(session.dailyUsage, record);
    const nextDailyUsageComplete = session.dailyUsageComplete === true || session.traceCount === 0;
    const nextRecentRatePoints = appendRatePoint(session.recentRatePoints, record);
    const nextAuxiliaryCounts = auxiliary
      ? {
          ...(session.auxiliaryCounts || {}),
          [auxiliary]: (session.auxiliaryCounts?.[auxiliary] || 0) + 1
        }
      : subagent
        ? {
            ...(session.auxiliaryCounts || {}),
            subagent: (session.auxiliaryCounts?.subagent || 0) + 1
          }
        : session.auxiliaryCounts;
    // Provisional hidden sessions：辅助 trace（title/count/policy）或 orphan subagent trace
    // （子 agent 比父 agent 先到，host 三层 fallback 全空）落 hidden=true，等真实主 trace absorb。
    // 已有真实回合（traceCount>0 且有 firstPrompt）的 session 永远不会被改成 hidden。
    const isOrphanSubagent = !!subagent && (session.hidden === true || (session.traceCount === 0 && !session.firstPrompt));
    const auxiliaryOnlySession = !!auxiliary && (session.hidden === true || (session.traceCount === 0 && !session.firstPrompt));
    // Unknown utility buckets stay hidden even when trace.auxiliary is absent.
    const unknownUtilityHidden = routedBy === 'unknownUtility';
    const hidden = auxiliaryOnlySession || isOrphanSubagent || unknownUtilityHidden;
    const hiddenAuxLabel: TapSessionSummary['auxiliary'] | undefined = auxiliaryOnlySession
      ? (session.auxiliary ?? auxiliary)
      : isOrphanSubagent
        ? (session.auxiliary ?? 'subagent')
        : unknownUtilityHidden
          ? (session.auxiliary ?? 'utility')
          : undefined;

    // A main-turn absorption consumes its pending utility roots.
    const nextPendingUtilityRoots = (isMainTurn && session.hidden === true)
      ? undefined
      : session.pendingUtilityRoots;
    const nextPendingUtilityClientKeys = (isMainTurn && session.hidden === true)
      ? undefined
      : session.pendingUtilityClientKeys;

    // Session duration is the request span, not the time since the session was
    // first seen. Completion order can differ from request order, so keep both
    // boundaries as min/max startedAt values.
    const previousStartMs = Date.parse(session.startedAt || '');
    const recordStartMs = Date.parse(record.startedAt || '');
    const explicitLastRequestMs = Date.parse(session.lastRequestAt || '');
    const previousLastRequestMs = Number.isFinite(explicitLastRequestMs)
      ? explicitLastRequestMs
      : Number.isFinite(previousStartMs) && typeof session.durationMs === 'number' && Number.isFinite(session.durationMs)
        ? previousStartMs + Math.max(0, session.durationMs)
        : previousStartMs;
    const sessionStartMs = Number.isFinite(previousStartMs) && Number.isFinite(recordStartMs)
      ? Math.min(previousStartMs, recordStartMs)
      : Number.isFinite(previousStartMs)
        ? previousStartMs
        : recordStartMs;
    const sessionEndMs = Number.isFinite(previousLastRequestMs) && Number.isFinite(recordStartMs)
      ? Math.max(previousLastRequestMs, recordStartMs)
      : Number.isFinite(previousLastRequestMs)
        ? previousLastRequestMs
        : recordStartMs;
    const previousUpdatedMs = Date.parse(session.updatedAt || '');
    const recordCompletedMs = Date.parse(record.completedAt || '');
    const updatedAtMs = Number.isFinite(previousUpdatedMs) && Number.isFinite(recordCompletedMs)
      ? Math.max(previousUpdatedMs, recordCompletedMs)
      : Number.isFinite(recordCompletedMs)
        ? recordCompletedMs
        : previousUpdatedMs;
    const nextDurationMs = Number.isFinite(sessionStartMs) && Number.isFinite(sessionEndMs)
      ? Math.max(0, sessionEndMs - sessionStartMs)
      : session.durationMs;

    const nextSession: TapSessionSummary = {
      ...session,
      startedAt: Number.isFinite(sessionStartMs) ? new Date(sessionStartMs).toISOString() : session.startedAt,
      updatedAt: Number.isFinite(updatedAtMs) ? new Date(updatedAtMs).toISOString() : session.updatedAt,
      lastRequestAt: Number.isFinite(sessionEndMs) ? new Date(sessionEndMs).toISOString() : session.lastRequestAt,
      traceCount: turn,
      hidden: hidden ? true : undefined,
      auxiliary: hiddenAuxLabel,
      firstPrompt: nextFirstPrompt,
      title: nextTitle,
      lastChain: nextLastChain,
      pendingSubagentRoots: nextPendingSubagentRoots,
      pendingSubagents: nextPendingSubagents,
      pendingUtilityRoots: nextPendingUtilityRoots,
      pendingUtilityClientKeys: nextPendingUtilityClientKeys,
      responseIds: nextResponseIds,
      interactionIds: nextInteractionIds,
      totalTokens: nextTotalTokens,
      errorCount: nextErrorCount,
      lastTurnError: nextLastTurnError,
      durationMs: nextDurationMs,
      firstModel: nextFirstModel,
      source: nextSource,
      firstClient: nextFirstClient,
      // Title/count/subagent helpers can run in independent client utility threads.
      // Only a main turn may establish the canonical conversation key; an auxiliary
      // attached to an existing main session simply preserves that session's key.
      clientConversationKey: session.clientConversationKey || (isMainTurn ? clientConversationKey : undefined),
      usageByModel: nextUsageByModel,
      dailyUsage: nextDailyUsage,
      dailyUsageComplete: nextDailyUsageComplete,
      recentRatePoints: nextRecentRatePoints,
      auxiliaryCounts: nextAuxiliaryCounts
    };
    const idx = index.sessions.findIndex(s => s.id === session!.id);
    if (idx >= 0) index.sessions[idx] = nextSession;
    else index.sessions.push(nextSession);
    await this.writeIndex(index);
    if (turn % 10 === 0) {
      await this._cleanupLocked();
    }
    this.events.emit('append', record);
    return record;
  }

  async listSessions(): Promise<TapSessionSummary[]> {
    const index = await this.withIndexLock(() => this.readIndexWithLegacyRepairLocked());
    const sorted = [...index.sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    try {
      const overlay = await this.sessionTitleOverlay(sorted);
      return sorted.map(session => {
        const title = overlay.get(session.id);
        return title && title !== session.title ? { ...session, title } : session;
      });
    } catch {
      return sorted;
    }
  }

  /** Reuse one hidden unknown-utility bucket per source and day. */
  private async ensureUnknownUtilityBucketLocked(
    index: TapHistoryIndex,
    now: Date,
    source: TapTraceRecord['source']
  ): Promise<TapSessionSummary> {
    const dayKey = now.toISOString().slice(0, 10);
    const existing = index.sessions.find(s =>
      s.hidden === true
      && s.auxiliary === 'utility'
      && s.source === source
      && s.startedAt.startsWith(dayKey)
    );
    if (existing) return existing;
    return this.createHiddenBucketLocked(index, now, source, 'utility', undefined);
  }

  /** Reuse one hidden memory-maintenance bucket per source and day. */
  private async ensureMemoryUtilityBucketLocked(
    index: TapHistoryIndex,
    now: Date,
    source: TapTraceRecord['source']
  ): Promise<TapSessionSummary> {
    const dayKey = now.toISOString().slice(0, 10);
    const existing = index.sessions.find(s =>
      s.hidden === true
      && s.auxiliary === 'memory'
      && s.source === source
      && s.startedAt.startsWith(dayKey)
    );
    if (existing) return existing;
    return this.createHiddenBucketLocked(index, now, source, 'memory', undefined);
  }

  /** Create a hidden provisional session that an exact main-turn root can absorb. */
  private async createHiddenProvisionalForRootLocked(
    index: TapHistoryIndex,
    now: Date,
    source: TapTraceRecord['source'],
    kind: 'title' | 'patch' | 'utility',
    root: string
  ): Promise<TapSessionSummary> {
    const auxiliary: 'title' | 'utility' = kind === 'title' ? 'title' : 'utility';
    return this.createHiddenBucketLocked(index, now, source, auxiliary, [
      { kind, root, createdAt: now.toISOString() }
    ], undefined);
  }

  /** Create a hidden Claude title provisional owned by an exact future main key. */
  private async createHiddenProvisionalForClientKeyLocked(
    index: TapHistoryIndex,
    now: Date,
    source: TapTraceRecord['source'],
    key: string,
    root?: string
  ): Promise<TapSessionSummary> {
    return this.createHiddenBucketLocked(index, now, source, 'title', root ? [
      { kind: 'title', root, createdAt: now.toISOString() }
    ] : undefined, [
      { kind: 'title', key, createdAt: now.toISOString() }
    ]);
  }

  private async createHiddenBucketLocked(
    index: TapHistoryIndex,
    now: Date,
    source: TapTraceRecord['source'],
    auxiliary: 'title' | 'memory' | 'utility',
    pendingUtilityRoots: TapSessionSummary['pendingUtilityRoots'],
    pendingUtilityClientKeys: TapSessionSummary['pendingUtilityClientKeys'] = undefined
  ): Promise<TapSessionSummary> {
    const id = await this.uniqueSessionId(now);
    const summary: TapSessionSummary = {
      id,
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastRequestAt: now.toISOString(),
      traceCount: 0,
      jsonlPath: this.sessionJsonlPath(id),
      source,
      hidden: true,
      auxiliary,
      pendingUtilityRoots,
      pendingUtilityClientKeys
    };
    index.sessions.push(summary);
    return summary;
  }

  /**
   * Best-effort 预识别请求归属 session，**不写盘**。tapProxy 在请求刚到达时调用，
   * 用于让 dashboard 在 mid-stream 阶段就把这个 session 标 LIVE（否则 30s 窗口要等到
   * 当前回合 completedAt 落盘才刷新，长 stream 期间 session 看起来是 OK）。
   *
   * 只覆盖最常见三条主路径：prevResponseId / clientConversationKey / chainHashes 前缀
   * 或 root 命中。aux/subagent/兜底分支不在这里实现 —— 那些回合通常很短，不会卡 30s 窗口。
   */
  async findInflightSession(trace: TapTraceRecord): Promise<TapSessionSummary | undefined> {
    const index = await this.readIndex();
    const startedAt = new Date(trace.startedAt || Date.now());
    const prevId = extractPreviousResponseId(trace);
    if (prevId) {
      const hit = findSessionByResponseId(index.sessions, prevId, trace.source);
      if (hit) return hit;
    }
    const key = trace.clientConversationKey || extractClientConversationKey(trace);
    if (key) {
      const hit = findSessionByClientConversationKey(index.sessions, key, trace.source);
      if (hit) return hit;
      const provisional = findHiddenProvisionalByPendingClientKey(index.sessions, key, trace.source);
      if (provisional) return provisional;
    }
    const fp = extractFingerprint(trace);
    if (fp.chainHashes.length > 0) {
      const matched = matchSession(index.sessions, fp, { now: startedAt, source: trace.source, clientConversationKey: key });
      if (matched && matched.by !== 'pickRecent') return matched.session;
    }
    return undefined;
  }

  async readSession(sessionId?: string): Promise<TapTraceRecord[]> {
    const index = await this.readIndex();
    const id = sessionId ?? this.currentSessionId ?? index.sessions[index.sessions.length - 1]?.id;
    if (!id) return [];
    const session = index.sessions.find(s => s.id === id);
    if (!session) return [];
    let text = '';
    try { text = await fs.promises.readFile(session.jsonlPath, 'utf8'); }
    catch { return []; }
    return parseJsonlLines<TapTraceRecord>(text).map(hydrateStoredSse);
  }

  async readSessionPage(
    sessionId?: string,
    opts: { offset?: number; limit?: number } = {}
  ): Promise<TapSessionTracePage | undefined> {
    return this.withIndexLock(async () => {
      const index = await this.readIndex();
      const id = sessionId ?? this.currentSessionId ?? index.sessions[index.sessions.length - 1]?.id;
      if (!id) return undefined;
      const session = index.sessions.find(s => s.id === id);
      if (!session) return undefined;
      return this.readSessionPageFromSnapshot(session, opts);
    });
  }

  private async readSessionPageFromSnapshot(
    session: TapSessionSummary,
    opts: { offset?: number; limit?: number }
  ): Promise<TapSessionTracePage> {
    const total = Math.max(0, Math.floor(session.traceCount || 0));
    const requestedLimit = clampInt(opts.limit, 1, 500, 160);
    const limit = await byteAwareTracePageLimit(session.jsonlPath, total, requestedLimit);
    const requestedOffset = opts.offset === undefined
      ? Math.max(0, total - limit)
      : clampInt(opts.offset, 0, total, 0);
    const offset = Math.min(requestedOffset, total);
    const endOffset = Math.min(total, offset + limit);
    const linesBefore = offset;
    const linesAfter = total - endOffset;
    const traces = linesAfter < linesBefore
      ? await readTraceLineWindowFromEnd(session.jsonlPath, linesAfter, limit)
      : await readTraceLineWindow(session.jsonlPath, offset, limit);

    return {
      id: session.id,
      traces,
      offset,
      limit,
      total,
      hasMoreBefore: offset > 0,
      hasMoreAfter: endOffset < total
    };
  }

  /**
   * Read one logical client conversation across manager/Gateway restart
   * fragments. The physical JSONL files remain immutable; the viewer receives
   * one chronological timeline and can keep using its existing auxiliary labels.
   */
  async readConversationPage(
    sessionId: string,
    opts: { offset?: number; limit?: number } = {}
  ): Promise<TapSessionTracePage | undefined> {
    return this.withIndexLock(async () => {
      const index = await this.readIndex();
      return this.readConversationPageFromSnapshot(index, sessionId, opts);
    });
  }

  private async readConversationPageFromSnapshot(
    index: TapHistoryIndex,
    sessionId: string,
    opts: { offset?: number; limit?: number }
  ): Promise<TapSessionTracePage | undefined> {
    const selected = index.sessions.find(session => session.id === sessionId);
    if (!selected) return undefined;
    if (!selected.clientConversationKey || !selected.source) {
      return this.readSessionPageFromSnapshot(selected, opts);
    }
    const matchingFragments = index.sessions.filter(session =>
      session.source === selected.source
      && session.clientConversationKey === selected.clientConversationKey
    );
    // A provider transition can create a short hidden physical fragment before
    // the next visible main turn (for example a title/compact/maintenance
    // request recorded while the client reconnects). Once this native
    // conversation has any visible owner, those hidden siblings are still part
    // of the same logical timeline. Pure hidden utility groups remain scoped to
    // their selected physical bucket and never become user Conversations.
    const fragments = (matchingFragments.some(session => session.hidden !== true)
      ? matchingFragments
      : [selected])
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    if (fragments.length <= 1) return this.readSessionPageFromSnapshot(selected, opts);

    const total = fragments.reduce((sum, fragment) => sum + Math.max(0, Math.floor(fragment.traceCount || 0)), 0);
    const requestedLimit = clampInt(opts.limit, 1, 500, 160);
    if (opts.offset === undefined) {
      // Default detail load must return the newest contiguous suffix. Starting
      // at total-requestedLimit and then applying a byte-aware per-file limit
      // returned a small page from the middle of large Conversations, making
      // the sidebar open around request 84 while request 243 already existed.
      let fragmentEnd = total;
      let remaining = requestedLimit;
      const chunks: TapTraceRecord[][] = [];
      for (let index = fragments.length - 1; index >= 0 && remaining > 0; index -= 1) {
        const fragment = fragments[index];
        const fragmentTotal = Math.max(0, Math.floor(fragment.traceCount || 0));
        const fragmentStart = fragmentEnd - fragmentTotal;
        if (fragmentTotal <= 0) {
          fragmentEnd = fragmentStart;
          continue;
        }
        const page = await this.readSessionPageFromSnapshot(fragment, {
          limit: Math.min(remaining, fragmentTotal)
        });
        chunks.unshift(page.traces.map((trace, traceIndex) => ({
          ...trace,
          logicalTurn: fragmentStart + page.offset + traceIndex + 1
        })));
        remaining -= page.traces.length;
        // Earlier rows still exist in this same fragment. Crossing into the
        // previous fragment would create a gap, so this byte-limited suffix is
        // the complete default page.
        if (page.offset > 0) break;
        fragmentEnd = fragmentStart;
      }
      const traces = chunks.flat();
      const offset = Math.max(0, total - traces.length);
      return {
        id: sessionId,
        traces,
        offset,
        limit: traces.length,
        total,
        hasMoreBefore: offset > 0,
        hasMoreAfter: false
      };
    }
    const requestedOffset = opts.offset === undefined
      ? Math.max(0, total - requestedLimit)
      : clampInt(opts.offset, 0, total, 0);
    const offset = Math.min(requestedOffset, total);
    let globalStart = 0;
    let remaining = Math.min(requestedLimit, total - offset);
    const traces: TapTraceRecord[] = [];

    for (const fragment of fragments) {
      if (remaining <= 0) break;
      const fragmentTotal = Math.max(0, Math.floor(fragment.traceCount || 0));
      const fragmentEnd = globalStart + fragmentTotal;
      if (offset >= fragmentEnd) {
        globalStart = fragmentEnd;
        continue;
      }
      const localOffset = Math.max(0, offset - globalStart);
      const take = Math.min(remaining, fragmentTotal - localOffset);
      const page = await this.readSessionPageFromSnapshot(fragment, { offset: localOffset, limit: take });
      traces.push(...page.traces.map((trace, index) => ({
        ...trace,
        logicalTurn: globalStart + localOffset + index + 1
      })));
      remaining -= page.traces.length;
      // Byte-aware paging may intentionally return fewer rows than requested.
      // Stop here so the next request resumes from the returned global offset.
      if (page.traces.length < take) break;
      globalStart = fragmentEnd;
    }

    return {
      id: sessionId,
      traces,
      offset,
      limit: traces.length,
      total,
      hasMoreBefore: offset > 0,
      hasMoreAfter: offset + traces.length < total
    };
  }

  async latestTrace(): Promise<TapTraceRecord | undefined> {
    const traces = await this.readSession();
    return traces[traces.length - 1];
  }

  async clearAll(): Promise<void> {
    return this.withIndexLock(() => this._clearAllLocked());
  }

  private async _clearAllLocked(): Promise<void> {
    // 不能 rm -rf rootDir：tap.lock（owner/follower 协调文件）也住在这里。
    // 运行中清历史若把 lock 一起删掉，follower 窗口会被 onDidDelete 误判
    // 「owner 退出」而同步关闭，owner 也要靠自保护重写才能恢复。
    let names: string[] = [];
    try { names = await fs.promises.readdir(this.rootDir); } catch { /* dir missing */ }
    for (const name of names) {
      if (name === TAP_LOCK_FILE || name === TRACE_WRITER_LEASE_FILE) continue;
      await fs.promises.rm(path.join(this.rootDir, name), { recursive: true, force: true }).catch(() => undefined);
    }
    this.currentSessionId = undefined;
    await ensureDir(this.rootDir);
    await this.writeIndex({ version: 1, sessions: [] });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.withIndexLock(() => this._deleteSessionLocked(sessionId));
  }

  private async _deleteSessionLocked(sessionId: string): Promise<boolean> {
    const index = await this.readIndex();
    const target = index.sessions.find(s => s.id === sessionId);
    if (!target) return false;

    // The dashboard exposes one logical Conversation for all physical Session
    // fragments with the same native key. Deleting only the representative
    // fragment makes the row reappear after refresh and leaves part of the
    // user's captured history on disk. Keep unkeyed legacy Sessions scoped to
    // one file; keyed Conversations remove every same-source fragment,
    // including hidden auxiliary fragments owned by that native conversation.
    const targets = target.clientConversationKey && target.source
      ? index.sessions.filter(session =>
          session.source === target.source
          && session.clientConversationKey === target.clientConversationKey
        )
      : [target];
    await this.removeSessionsFromIndex(index, targets);
    return true;
  }

  async cleanup(): Promise<void> {
    return this.withIndexLock(() => this._cleanupLocked());
  }

  private async _cleanupLocked(): Promise<void> {
    const configuredMaxSessions = this.maxSessions();
    const max = typeof configuredMaxSessions === 'number' && Number.isFinite(configuredMaxSessions)
      ? Math.max(0, Math.floor(configuredMaxSessions))
      : 0;
    let index = await this.readIndex();
    if (max > 0 && index.sessions.length > max) {
      const sorted = [...index.sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      const remove = sorted.slice(0, Math.max(0, sorted.length - max));
      try {
        index = await this.removeSessionsFromIndex(index, remove);
      } catch {
        return;
      }
    }

    const maxBytes = this.configuredMaxStorageBytes();
    if (!maxBytes) return;
    let totalBytes = await directorySize(this.rootDir);
    if (totalBytes <= maxBytes) return;
    const now = Date.now();
    const removable = [...index.sessions]
      .filter(s => s.id !== this.currentSessionId)
      .filter(s => {
        const ts = Date.parse(s.updatedAt || s.startedAt);
        return Number.isFinite(ts) ? now - ts > DEFAULT_STORAGE_CLEANUP_RECENT_MS : true;
      })
      .sort((a, b) => (a.updatedAt || a.startedAt).localeCompare(b.updatedAt || b.startedAt));
    const remove: TapSessionSummary[] = [];
    for (const session of removable) {
      if (totalBytes <= maxBytes) break;
      remove.push(session);
      totalBytes -= await sessionFileSize(session);
    }
    if (remove.length === 0) return;
    try {
      await this.removeSessionsFromIndex(index, remove);
    } catch {
      // Retention cleanup is best-effort and must never fail a durable append.
    }
  }

  private async removeSessionsFromIndex(
    index: TapHistoryIndex,
    remove: readonly TapSessionSummary[]
  ): Promise<TapHistoryIndex> {
    const removeIds = new Set(remove.map(s => s.id));
    for (const session of remove) {
      if (this.currentSessionId === session.id) this.currentSessionId = undefined;
    }
    const next: TapHistoryIndex = {
      version: 1,
      sessions: index.sessions.filter(s => !removeIds.has(s.id))
    };
    const staged = await stageSessionFilesForRemoval(remove);
    try {
      await this.writeIndex(next);
    } catch (error) {
      await restoreStagedSessionFiles(staged);
      throw error;
    }
    await discardStagedSessionFiles(staged);
    return next;
  }

  private configuredMaxStorageBytes(): number | undefined {
    const value = this.maxStorageBytes();
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const bytes = Math.floor(value);
    return bytes > 0 ? bytes : undefined;
  }

  private async readIndexWithLegacyRepairLocked(): Promise<TapHistoryIndex> {
    const index = await this.readIndex();
    let changed = false;
    const sessions: TapSessionSummary[] = [];

    for (const session of index.sessions) {
      let next = session;
      const cleanedCodexPrompt = extractCodexIdeRequest(session.firstPrompt);
      if (cleanedCodexPrompt && cleanedCodexPrompt !== session.firstPrompt) {
        next = { ...next, firstPrompt: cleanedCodexPrompt };
        changed = true;
      }
      const cleanedNoisePrompt = cleanStoredFirstPromptNoise(next.firstPrompt, next.source);
      if (cleanedNoisePrompt !== next.firstPrompt) {
        next = { ...next, firstPrompt: cleanedNoisePrompt };
        changed = true;
      }

      if (!next.title && next.traceCount > 0) {
        const repairKey = `${next.id}:${next.traceCount}`;
        if (!this.legacyTitleRepairChecks.has(repairKey)) {
          this.legacyTitleRepairChecks.add(repairKey);
          const recoveredTitle = await recoverStoredSessionTitle(next);
          if (recoveredTitle) {
            next = { ...next, title: recoveredTitle };
            changed = true;
          }
        }
      }

      if (legacyCopilotSessionNeedsTraceCheck(next)) {
        const traces = await readJsonlPrefix(next.jsonlPath, Math.max(1, Math.min(5, next.traceCount || 1)));
        const hiddenAuxiliary = legacyHiddenAuxiliaryForCopilotSession(traces);
        if (hiddenAuxiliary) {
          next = { ...next, hidden: true, auxiliary: hiddenAuxiliary };
          changed = true;
        }
      }

      if (legacyCodexUtilitySessionNeedsTraceCheck(next)) {
        const traces = await readJsonlPrefix(next.jsonlPath, Math.max(1, Math.min(5, next.traceCount || 1)));
        if (traces.length > 0 && traces.every(isCodexStructuredUtilityTrace)) {
          next = { ...next, hidden: true, auxiliary: 'utility' };
          changed = true;
        }
      }

      sessions.push(next);
    }

    if (await this.repairMisroutedClaudeTitles(sessions)) {
      changed = true;
    }

    if (!changed) return index;
    const repaired: TapHistoryIndex = { version: 1, sessions };
    await this.writeIndex(repaired);
    return repaired;
  }

  /**
   * Repair only the derived index title when an older build attached a Claude
   * title request to the wrong recent session. Raw JSONL records are never moved,
   * rewritten, or deleted.
   */
  private async repairMisroutedClaudeTitles(sessions: TapSessionSummary[]): Promise<boolean> {
    let changed = false;
    for (let hostIndex = 0; hostIndex < sessions.length; hostIndex += 1) {
      const host = sessions[hostIndex];
      if (!host.title || (host.source !== 'claude-cli' && host.source !== 'claude-vscode')) continue;
      const repairKey = `${host.id}:${host.traceCount}:${host.title}`;
      if (this.legacyClaudeTitleRouteChecks.has(repairKey)) continue;
      this.legacyClaudeTitleRouteChecks.add(repairKey);

      const traces = await readJsonlPrefix(host.jsonlPath, Math.max(1, Math.min(8, host.traceCount || 1)));
      for (const storedTrace of traces) {
        const trace = hydrateStoredSse(storedTrace);
        const auxiliary = trace.auxiliary ?? classifyAuxiliaryTrace(trace);
        if (auxiliary !== 'title') continue;
        const generatedTitle = extractGeneratedTitle(trace);
        if (!generatedTitle || generatedTitle !== host.title) continue;
        const requestKey = trace.clientConversationKey || extractClientConversationKey(trace);
        if (!requestKey || requestKey === host.clientConversationKey) continue;
        const targetIndex = sessions.findIndex(candidate =>
          candidate.id !== host.id
          && candidate.hidden !== true
          && candidate.source === trace.source
          && candidate.clientConversationKey === requestKey
        );
        if (targetIndex < 0 || sessions[targetIndex].title) continue;

        sessions[targetIndex] = { ...sessions[targetIndex], title: generatedTitle };
        sessions[hostIndex] = { ...host, title: undefined };
        changed = true;
        break;
      }
    }
    return changed;
  }

  private async readIndex(): Promise<TapHistoryIndex> {
    const indexPath = this.indexPath();
    let text: string;
    try {
      text = await fs.promises.readFile(indexPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (await this.hasUnindexedJsonlFiles()) {
          throw traceIndexReadError(indexPath, '索引缺失，但目录中仍有 JSONL；请先运行索引诊断与修复');
        }
        return { version: 1, sessions: [] };
      }
      throw traceIndexReadError(indexPath, `读取失败：${errorMessage(error)}`);
    }

    let index: TapHistoryIndex;
    try {
      index = JSON.parse(text) as TapHistoryIndex;
    } catch (error) {
      throw traceIndexReadError(indexPath, `JSON 无法解析：${errorMessage(error)}`);
    }
    if (!index || index.version !== 1 || !Array.isArray(index.sessions)) {
      throw traceIndexReadError(indexPath, '索引结构或版本无效');
    }
    if (index.sessions.some(session => (
      !session
      || typeof session !== 'object'
      || typeof session.id !== 'string'
      || !session.id
      || typeof session.jsonlPath !== 'string'
      || !session.jsonlPath
    ))) {
      throw traceIndexReadError(indexPath, '至少一条 Session 索引记录缺少 id 或 jsonlPath');
    }
    return {
      version: 1,
      sessions: index.sessions
        .filter(s => s && typeof s.id === 'string' && typeof s.jsonlPath === 'string')
        .map(s => ({
          id: s.id,
          startedAt: s.startedAt,
          updatedAt: s.updatedAt,
          traceCount: s.traceCount,
          jsonlPath: s.jsonlPath,
          interactionId: typeof s.interactionId === 'string' ? s.interactionId : undefined,
          rootDigest: typeof s.rootDigest === 'string' ? s.rootDigest : undefined,
          firstPrompt: typeof s.firstPrompt === 'string' ? s.firstPrompt : undefined,
          title: typeof s.title === 'string' ? s.title : undefined,
          lastChain: Array.isArray(s.lastChain)
            ? s.lastChain.filter((x: unknown): x is string => typeof x === 'string')
            : undefined,
          pendingSubagentRoots: Array.isArray(s.pendingSubagentRoots)
            ? s.pendingSubagentRoots.filter((x: unknown): x is string => typeof x === 'string')
            : undefined,
          pendingSubagents: parsePendingSubagents(s.pendingSubagents),
          responseIds: Array.isArray(s.responseIds)
            ? s.responseIds.filter((x: unknown): x is string => typeof x === 'string')
            : undefined,
          interactionIds: Array.isArray(s.interactionIds)
            ? s.interactionIds.filter((x: unknown): x is string => typeof x === 'string')
            : undefined,
          pendingUtilityRoots: Array.isArray(s.pendingUtilityRoots)
            ? s.pendingUtilityRoots
                .map((x: unknown) => {
                  if (!x || typeof x !== 'object') return undefined;
                  const r = x as Record<string, unknown>;
                  const kind = r.kind;
                  const root = r.root;
                  const createdAt = r.createdAt;
                  if ((kind !== 'title' && kind !== 'patch' && kind !== 'utility')
                    || typeof root !== 'string'
                    || typeof createdAt !== 'string') {
                    return undefined;
                  }
                  return { kind, root, createdAt } as { kind: 'title' | 'patch' | 'utility'; root: string; createdAt: string };
                })
                .filter((x): x is { kind: 'title' | 'patch' | 'utility'; root: string; createdAt: string } => !!x)
            : undefined,
          pendingUtilityClientKeys: Array.isArray(s.pendingUtilityClientKeys)
            ? s.pendingUtilityClientKeys
                .map((x: unknown) => {
                  if (!x || typeof x !== 'object') return undefined;
                  const r = x as Record<string, unknown>;
                  const kind = r.kind;
                  const key = r.key;
                  const createdAt = r.createdAt;
                  if ((kind !== 'title' && kind !== 'utility')
                    || typeof key !== 'string'
                    || typeof createdAt !== 'string') {
                    return undefined;
                  }
                  return { kind, key, createdAt } as { kind: 'title' | 'utility'; key: string; createdAt: string };
                })
                .filter((x): x is { kind: 'title' | 'utility'; key: string; createdAt: string } => !!x)
            : undefined,
          hidden: s.hidden === true ? true : undefined,
          auxiliary: s.auxiliary === 'title' || s.auxiliary === 'count' || s.auxiliary === 'policy' || s.auxiliary === 'subagent' || s.auxiliary === 'patch' || s.auxiliary === 'memory' || s.auxiliary === 'utility' ? s.auxiliary : undefined,
          auxiliaryCounts: parseAuxiliaryCounts(s.auxiliaryCounts),
          totalTokens: typeof s.totalTokens === 'number' ? s.totalTokens : undefined,
          errorCount: typeof s.errorCount === 'number' ? s.errorCount : undefined,
          lastTurnError: typeof s.lastTurnError === 'boolean' ? s.lastTurnError : undefined,
          firstModel: typeof s.firstModel === 'string' ? s.firstModel : undefined,
          source: isTraceSource(s.source) ? s.source : undefined,
          firstClient: typeof s.firstClient === 'string' ? s.firstClient : undefined,
          clientConversationKey: typeof s.clientConversationKey === 'string' ? s.clientConversationKey : undefined,
          lastRequestAt: typeof s.lastRequestAt === 'string' ? s.lastRequestAt : undefined,
          usageByModel: parseUsageByModel(s.usageByModel),
          dailyUsage: parseDailyUsage(s.dailyUsage),
          dailyUsageComplete: s.dailyUsageComplete === true ? true : undefined,
          recentRatePoints: parseRatePoints(s.recentRatePoints),
          durationMs: typeof s.durationMs === 'number' && Number.isFinite(s.durationMs)
            ? s.durationMs
            : undefined
        }))
    };
  }

  private async hasUnindexedJsonlFiles(): Promise<boolean> {
    try {
      const entries = await fs.promises.readdir(this.rootDir, { withFileTypes: true });
      return entries.some(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async writeIndex(index: TapHistoryIndex): Promise<void> {
    await ensureDir(this.rootDir);
    await writeJson(this.indexPath(), index);
  }

  private sessionJsonlPath(sessionId: string): string {
    return path.join(this.rootDir, `${sessionId}.jsonl`);
  }

  private async uniqueSessionId(now: Date): Promise<string> {
    const base = now.toISOString().replace(/[:.]/g, '-');
    let id = base;
    let suffix = 2;
    while (await exists(this.sessionJsonlPath(id))) {
      id = `${base}-${suffix++}`;
    }
    return id;
  }
}

export interface RecoveredSessionSummary {
  readonly summary: TapSessionSummary;
  readonly validRecords: number;
  readonly malformedRecords: number;
}

/**
 * Rebuild one physical Session summary from its immutable JSONL records.
 * This is intentionally routing-free: an orphaned file already contains the
 * authoritative physical sessionId/turn assignments, so recovery must not
 * rewrite or regroup the original Trace records.
 */
export async function recoverSessionSummaryFromJsonl(
  jsonlPath: string
): Promise<RecoveredSessionSummary> {
  const resolvedPath = path.resolve(jsonlPath);
  const id = path.basename(resolvedPath, '.jsonl');
  let validRecords = 0;
  let malformedRecords = 0;
  let maxTurn = 0;
  let startedAtMs = Number.POSITIVE_INFINITY;
  let lastRequestAtMs = Number.NEGATIVE_INFINITY;
  let updatedAtMs = Number.NEGATIVE_INFINITY;
  let mainRecords = 0;
  let source: TapSessionSummary['source'];
  let firstClient: string | undefined;
  let firstModel: string | undefined;
  let firstPrompt: string | undefined;
  let title: string | undefined;
  let clientConversationKey: string | undefined;
  let lastChain: readonly string[] | undefined;
  let pendingSubagents: TapSessionSummary['pendingSubagents'];
  let responseIds: readonly string[] | undefined;
  let interactionIds: readonly string[] | undefined;
  let totalTokens = 0;
  let errorCount = 0;
  let lastTurnError: boolean | undefined;
  let usageByModel: TapSessionSummary['usageByModel'];
  let dailyUsage: TapSessionSummary['dailyUsage'];
  let recentRatePoints: TapSessionSummary['recentRatePoints'];
  let auxiliaryCounts: TapSessionSummary['auxiliaryCounts'];
  const hiddenLabels = new Set<NonNullable<TapSessionSummary['auxiliary']>>();

  const input = fs.createReadStream(resolvedPath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const text = String(line || '').trim();
      if (!text) continue;
      let stored: TapTraceRecord;
      try {
        stored = JSON.parse(text) as TapTraceRecord;
      } catch {
        malformedRecords += 1;
        continue;
      }
      if (stored.sessionId && stored.sessionId !== id) {
        throw new Error(`Trace file ${resolvedPath} contains a foreign sessionId`);
      }
      const trace = hydrateStoredSse(stored);
      validRecords += 1;
      if (Number.isInteger(trace.turn) && (trace.turn ?? 0) > 0) {
        maxTurn = Math.max(maxTurn, trace.turn ?? 0);
      }

      const recordStartMs = Date.parse(trace.startedAt || '');
      if (Number.isFinite(recordStartMs)) {
        startedAtMs = Math.min(startedAtMs, recordStartMs);
        lastRequestAtMs = Math.max(lastRequestAtMs, recordStartMs);
      }
      const recordCompletedMs = Date.parse(trace.completedAt || '');
      if (Number.isFinite(recordCompletedMs)) updatedAtMs = Math.max(updatedAtMs, recordCompletedMs);

      const auxiliary = trace.auxiliary
        ?? classifyAuxiliaryTrace(trace)
        ?? (isCodexStructuredUtilityTrace(trace) ? 'utility' : undefined);
      const subagent = trace.subagent || (!auxiliary ? detectSubagent(trace) : undefined);
      const isMain = !auxiliary && !subagent;
      if (auxiliary) hiddenLabels.add(auxiliary);
      else if (subagent) hiddenLabels.add('subagent');

      source = source || trace.source;
      const fingerprint = extractFingerprint(trace);
      if (isMain) {
        mainRecords += 1;
        firstClient = firstClient || trace.client;
        firstModel = firstModel || trace.request?.model;
        firstPrompt = firstPrompt || fingerprint.firstPrompt || undefined;
        clientConversationKey = clientConversationKey
          || trace.clientConversationKey
          || extractClientConversationKey(trace);
        if (fingerprint.chainHashes.length > 0) lastChain = [...fingerprint.chainHashes];
      }

      if (!title && auxiliary === 'title') title = extractGeneratedTitle(trace);
      const invocations = subagentInvocations(trace);
      if (invocations.length > 0) {
        pendingSubagents = [...(pendingSubagents || []), ...invocations].slice(-16);
      }
      const responseId = extractResponseId(trace);
      if (responseId) responseIds = [...(responseIds || []), responseId].slice(-16);
      const interactionId = extractInteractionId(trace);
      if (isMain && interactionId && !(interactionIds || []).includes(interactionId)) {
        interactionIds = [...(interactionIds || []), interactionId].slice(-16);
      }

      totalTokens += totalTokensOfTrace(trace);
      const isError = traceHasError(trace);
      errorCount += isError ? 1 : 0;
      if (isMain) lastTurnError = isError;
      usageByModel = accumulateUsageByModel(usageByModel, trace);
      dailyUsage = accumulateDailyUsage(dailyUsage, trace);
      recentRatePoints = appendRatePoint(recentRatePoints, trace);
      if (auxiliary || subagent) {
        const label: NonNullable<TapSessionSummary['auxiliary']> = auxiliary || 'subagent';
        auxiliaryCounts = {
          ...(auxiliaryCounts || {}),
          [label]: (auxiliaryCounts?.[label] || 0) + 1
        };
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }

  if (validRecords === 0 || !Number.isFinite(startedAtMs)) {
    throw new Error(`Trace file has no recoverable records: ${resolvedPath}`);
  }
  if (!Number.isFinite(lastRequestAtMs)) lastRequestAtMs = startedAtMs;
  if (!Number.isFinite(updatedAtMs)) updatedAtMs = lastRequestAtMs;
  const hidden = mainRecords === 0;
  const hiddenAuxiliary: TapSessionSummary['auxiliary'] | undefined = hidden
    ? hiddenLabels.size === 1
      ? [...hiddenLabels][0]
      : hiddenLabels.has('subagent')
        ? 'subagent'
        : 'utility'
    : undefined;
  const summary: TapSessionSummary = {
    id,
    startedAt: new Date(startedAtMs).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
    lastRequestAt: new Date(lastRequestAtMs).toISOString(),
    traceCount: maxTurn > 0 ? maxTurn : validRecords,
    jsonlPath: resolvedPath,
    firstPrompt,
    title,
    lastChain,
    pendingSubagentRoots: pendingSubagents?.flatMap(invocation => invocation.roots),
    pendingSubagents,
    responseIds,
    interactionIds,
    hidden: hidden ? true : undefined,
    auxiliary: hiddenAuxiliary,
    auxiliaryCounts,
    totalTokens,
    errorCount,
    lastTurnError,
    durationMs: Math.max(0, lastRequestAtMs - startedAtMs),
    firstModel,
    source,
    firstClient,
    clientConversationKey,
    usageByModel,
    dailyUsage,
    dailyUsageComplete: true,
    recentRatePoints
  };
  return { summary, validRecords, malformedRecords };
}
interface StagedSessionFile {
  readonly originalPath: string;
  readonly stagedPath: string;
}

async function stageSessionFilesForRemoval(
  sessions: readonly TapSessionSummary[]
): Promise<StagedSessionFile[]> {
  const staged: StagedSessionFile[] = [];
  try {
    for (const session of sessions) {
      if (!await exists(session.jsonlPath)) continue;
      const stagedPath = `${session.jsonlPath}.deleting-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await fs.promises.rename(session.jsonlPath, stagedPath);
      staged.push({ originalPath: session.jsonlPath, stagedPath });
    }
    return staged;
  } catch (error) {
    await restoreStagedSessionFiles(staged);
    throw error;
  }
}

async function restoreStagedSessionFiles(staged: readonly StagedSessionFile[]): Promise<void> {
  for (const file of [...staged].reverse()) {
    await fs.promises.rename(file.stagedPath, file.originalPath).catch(() => undefined);
  }
}

async function discardStagedSessionFiles(staged: readonly StagedSessionFile[]): Promise<void> {
  for (const file of staged) {
    // A failed unlink leaves a uniquely named recoverable copy instead of
    // silently losing the only bytes.
    await fs.promises.rm(file.stagedPath, { force: true }).catch(() => undefined);
  }
}

async function sessionFileSize(session: TapSessionSummary): Promise<number> {
  return fileSize(session.jsonlPath);
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await fs.promises.stat(filePath)).size;
  } catch {
    return 0;
  }
}

async function directorySize(dirPath: string): Promise<number> {
  let entries: fs.Dirent[] = [];
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(fullPath);
    } else if (entry.isFile()) {
      total += await fileSize(fullPath);
    }
  }
  return total;
}

async function readTraceLineWindow(filePath: string, offset: number, limit: number): Promise<TapTraceRecord[]> {
  const traces: TapTraceRecord[] = [];
  let stream: fs.ReadStream | undefined;
  try {
    stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let index = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      if (index >= offset && traces.length < limit) {
        traces.push(...parseJsonlLines<TapTraceRecord>([line]).map(hydrateStoredSse));
      }
      index += 1;
      if (index >= offset + limit) break;
    }
  } catch {
    return traces;
  } finally {
    try { stream?.destroy(); } catch { /* ignore */ }
  }
  return traces;
}

async function byteAwareTracePageLimit(
  filePath: string,
  total: number,
  requestedLimit: number
): Promise<number> {
  if (total <= 0) return requestedLimit;
  try {
    const stat = await fs.promises.stat(filePath);
    const averageLineBytes = Math.max(1, Math.ceil(stat.size / total));
    const byteLimitedCount = Math.max(1, Math.floor(MAX_TRACE_PAGE_ESTIMATED_BYTES / averageLineBytes));
    return Math.min(requestedLimit, byteLimitedCount);
  } catch {
    return requestedLimit;
  }
}

async function readTraceLineWindowFromEnd(
  filePath: string,
  skipAfter: number,
  limit: number
): Promise<TapTraceRecord[]> {
  if (limit <= 0) return [];
  let handle: fs.promises.FileHandle | undefined;
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size <= 0) return [];
    handle = await fs.promises.open(filePath, 'r');
    const chunks: Buffer[] = [];
    const chunkSize = 64 * 1024;
    let position = stat.size;
    let newlineCount = 0;
    const requiredLines = Math.max(1, skipAfter + limit);
    while (position > 0 && newlineCount <= requiredLines) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const buffer = Buffer.allocUnsafe(readSize);
      const read = await handle.read(buffer, 0, readSize, position);
      const chunk = read.bytesRead === readSize ? buffer : buffer.subarray(0, read.bytesRead);
      chunks.unshift(chunk);
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 10) newlineCount += 1;
      }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const lines = text.split(/\r?\n/);
    if (position > 0) lines.shift(); // The leading line may start mid-record.
    const completeLines = lines
      .map(line => line.trim())
      .filter(Boolean);
    const end = Math.max(0, completeLines.length - skipAfter);
    return completeLines
      .slice(Math.max(0, end - limit), end)
      .flatMap(line => parseJsonlLines<TapTraceRecord>([line]).map(hydrateStoredSse));
  } catch {
    return [];
  } finally {
    try { await handle?.close(); } catch { /* ignore */ }
  }
}

async function exists(file: string): Promise<boolean> {
  try { await fs.promises.access(file); return true; } catch { return false; }
}

/**
 * Repairs the read model for traces captured while an upstream omitted the
 * text/event-stream response header. The JSONL remains untouched so raw
 * evidence stays immutable; only the viewer/read result receives the
 * reconstructed events and snapshot.
 */
function hydrateStoredSse(trace: TapTraceRecord): TapTraceRecord {
  if ((trace.sse?.events?.length ?? 0) > 0) return trace;
  const rawBody = trace.response?.rawBody;
  if (typeof rawBody !== 'string' || !/^\s*(?:event|data):/i.test(rawBody)) return trace;

  const reassembler = new SSEReassembler(trace.request.apiType);
  reassembler.feed(rawBody, trace.durationMs);
  reassembler.finish(trace.durationMs);
  const events = reassembler.getEvents();
  if (events.length === 0) return trace;
  const snapshot = reassembler.snapshot();

  return {
    ...trace,
    response: {
      ...trace.response,
      snapshot
    },
    sse: {
      events,
      snapshot
    },
    usage: trace.usage ?? snapshot.usage
  };
}

function totalTokensOfTrace(t: TapTraceRecord): number {
  // 计费累计用计费总量口径（含输出），权威定义在 normalizeUsage.billableTotalTokens。
  return billableTotalTokens(t.usage);
}

/**
 * 把本条 trace 的 usage 按模型累进 session 的 usageByModel。
 * 模型名优先取响应 snapshot 的 model（上游实际模型），缺时退回请求 model。
 * 无 usage（如 count_tokens）或无模型名的 trace 不进矩阵。
 */
/**
 * Split one trace's usage into the billing band it belongs to.
 *
 * The band is a property of the individual request: length-tiered vendors pick
 * their rate from that request's prompt length, and peak/off-peak vendors from
 * its timestamp. Once requests are summed into a session total both are
 * unrecoverable, so the split has to be recorded here or the model can never be
 * priced better than "cheapest band", which is the 2x-6x under-report the public
 * catalogues produce.
 */
function accumulateUsageBands(
  before: readonly TapModelUsageBand[] | undefined,
  model: string,
  servedModel: string | undefined,
  t: TapTraceRecord,
  u: NonNullable<TapTraceRecord['usage']>
): readonly TapModelUsageBand[] | undefined {
  const price = findModelPriceForUsage(model, servedModel);
  if (!price || !isBandedPrice(price)) return before;
  const promptTokens = u.inputTotalTokens
    ?? (u.inputUncachedTokens ?? u.inputTokens ?? 0) + (u.cacheReadTokens || 0) + (u.cacheCreationTokens || 0);
  const startedAtMs = Date.parse(t.startedAt || '');
  const tier = resolvePriceTierIndex(price, promptTokens);
  const offPeak = Number.isFinite(startedAtMs) ? isOffPeakAt(price, startedAtMs) : false;
  // Volcengine discounts the output rate for short replies inside a band, so the
  // reply length is a third per-request dimension alongside prompt length and
  // time of day, and has to be split here for the same reason.
  const shortOutput = isShortOutput(price, tier, u.outputTokens ?? 0);
  const bands = [...(before ?? [])];
  const index = bands.findIndex(band => (
    band.tier === tier && band.offPeak === offPeak && !!band.shortOutput === shortOutput
  ));
  const current = index >= 0 ? bands[index] : undefined;
  const next: TapModelUsageBand = {
    tier,
    offPeak,
    ...(shortOutput ? { shortOutput: true } : {}),
    input: (current?.input || 0) + (u.inputUncachedTokens || 0),
    output: (current?.output || 0) + (u.outputTokens || 0),
    cacheRead: (current?.cacheRead || 0) + (u.cacheReadTokens || 0),
    cacheCreation: (current?.cacheCreation || 0) + (u.cacheCreationTokens || 0),
    ...(current?.cacheCreation5m !== undefined || u.cacheCreation5mTokens !== undefined
      ? { cacheCreation5m: (current?.cacheCreation5m || 0) + (u.cacheCreation5mTokens || 0) }
      : {}),
    ...(current?.cacheCreation1h !== undefined || u.cacheCreation1hTokens !== undefined
      ? { cacheCreation1h: (current?.cacheCreation1h || 0) + (u.cacheCreation1hTokens || 0) }
      : {})
  };
  if (index >= 0) bands[index] = next;
  else bands.push(next);
  return bands;
}

function accumulateUsageByModel(
  prev: Record<string, TapModelUsage> | undefined,
  t: TapTraceRecord
): Record<string, TapModelUsage> | undefined {
  const u = t.usage;
  if (!u) return prev;
  const snapshot = t.sse?.snapshot ?? t.response?.snapshot;
  // 以客户端请求名归集：那是用户选的名字，也是公开价目表收录的那个。上游回报名
  // 只在不同时另存为证据——DeepSeek 把 deepseek-v4-pro-0813 回成内部构建名
  // deepseek-v4-pro-ga-260813，按回报名归集会让一个本来有官方价的模型变成无价，
  // 而且矩阵里显示的名字和会话列表对不上。
  const model = t.request?.model || snapshot?.model;
  if (!model) return prev;
  const served = snapshot?.model && snapshot.model !== model ? snapshot.model : undefined;
  const before = prev?.[model];
  const legacyAggregate = !!before && before.version !== 2;
  const bands = accumulateUsageBands(before?.bands, model, served, t, u);
  const entry: TapModelUsage = {
    ...(legacyAggregate ? {} : { version: 2 as const }),
    input: legacyAggregate
      ? before.input
      : (before?.input || 0) + (u.inputUncachedTokens || 0),
    output: (before?.output || 0) + (u.outputTokens || 0),
    cacheRead: (before?.cacheRead || 0) + (u.cacheReadTokens || 0),
    cacheCreation: (before?.cacheCreation || 0) + (u.cacheCreationTokens || 0),
    ...(before?.cacheCreation5m !== undefined || u.cacheCreation5mTokens !== undefined
      ? { cacheCreation5m: (before?.cacheCreation5m || 0) + (u.cacheCreation5mTokens || 0) }
      : {}),
    ...(before?.cacheCreation1h !== undefined || u.cacheCreation1hTokens !== undefined
      ? { cacheCreation1h: (before?.cacheCreation1h || 0) + (u.cacheCreation1hTokens || 0) }
      : {}),
    total: (before?.total || 0) + totalTokensOfTrace(t),
    apiType: before?.apiType ?? t.request?.apiType,
    incompleteFields: mergeUsageFields(
      mergeUsageFields(before?.incompleteFields, legacyAggregate ? ['input'] : undefined),
      u.incompleteFields
    ),
    ...(bands?.length ? { bands } : {}),
    ...(before?.servedModel ?? served ? { servedModel: before?.servedModel ?? served } : {})
  };
  return { ...prev, [model]: entry };
}

const RECENT_USAGE_DAYS = 8;
const RECENT_RATE_POINTS = 240;

function accumulateDailyUsage(
  previous: Record<string, TapDailyUsage> | undefined,
  trace: TapTraceRecord
): Record<string, TapDailyUsage> | undefined {
  const tokens = totalTokensOfTrace(trace);
  const usageByModel = accumulateUsageByModel(undefined, trace);
  if (tokens <= 0 && !usageByModel) return previous;

  const day = localDateKey(trace.completedAt || trace.startedAt);
  if (!day) return previous;
  const before = previous?.[day];
  const next: Record<string, TapDailyUsage> = {
    ...previous,
    [day]: {
      tokens: (before?.tokens || 0) + tokens,
      usageByModel: accumulateUsageMaps(before?.usageByModel, usageByModel)
    }
  };
  const keep = Object.keys(next).sort().slice(-RECENT_USAGE_DAYS);
  return Object.fromEntries(keep.map(key => [key, next[key]]));
}

function accumulateUsageMaps(
  previous: Record<string, TapModelUsage> | undefined,
  addition: Record<string, TapModelUsage> | undefined
): Record<string, TapModelUsage> | undefined {
  if (!addition) return previous;
  const next = { ...previous };
  for (const [model, value] of Object.entries(addition)) {
    const before = next[model];
    const legacyAggregate = !!before && before.version !== 2;
    next[model] = {
      ...(legacyAggregate ? {} : { version: 2 as const }),
      input: legacyAggregate ? before.input : (before?.input || 0) + value.input,
      output: (before?.output || 0) + value.output,
      cacheRead: (before?.cacheRead || 0) + value.cacheRead,
      cacheCreation: (before?.cacheCreation || 0) + value.cacheCreation,
      ...(before?.cacheCreation5m !== undefined || value.cacheCreation5m !== undefined
        ? { cacheCreation5m: (before?.cacheCreation5m || 0) + (value.cacheCreation5m || 0) }
        : {}),
      ...(before?.cacheCreation1h !== undefined || value.cacheCreation1h !== undefined
        ? { cacheCreation1h: (before?.cacheCreation1h || 0) + (value.cacheCreation1h || 0) }
        : {}),
      total: (before?.total || 0) + value.total,
      apiType: before?.apiType ?? value.apiType,
      incompleteFields: mergeUsageFields(
        mergeUsageFields(before?.incompleteFields, legacyAggregate ? ['input'] : undefined),
        value.incompleteFields
      ),
      bands: mergeUsageBands(before?.bands, value.bands),
      servedModel: before?.servedModel ?? value.servedModel
    };
  }
  return next;
}

function appendRatePoint(previous: readonly TapRatePoint[] | undefined, trace: TapTraceRecord): readonly TapRatePoint[] | undefined {
  const at = trace.completedAt || trace.startedAt;
  if (!at || !Number.isFinite(Date.parse(at))) return previous;
  const tokens = totalTokensOfTrace(trace);
  const outputTokens = trace.usage?.outputTokens || 0;
  const seconds = (trace.durationMs || 0) / 1000;
  if (tokens <= 0 && outputTokens <= 0) return previous;
  return [
    ...(previous || []),
    {
      at,
      tokens,
      tokPerSec: outputTokens > 0 && seconds > 0.2 ? outputTokens / seconds : undefined
    }
  ].slice(-RECENT_RATE_POINTS);
}

function localDateKey(value: string | undefined): string | undefined {
  const date = value ? new Date(value) : new Date(NaN);
  if (!Number.isFinite(date.getTime())) return undefined;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseUsageByModel(v: unknown): Record<string, TapModelUsage> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, TapModelUsage> = {};
  for (const [model, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    out[model] = {
      version: r.version === 2 ? 2 : undefined,
      input: numOrZero(r.input),
      output: numOrZero(r.output),
      cacheRead: numOrZero(r.cacheRead),
      cacheCreation: numOrZero(r.cacheCreation),
      cacheCreation5m: numOrUndefined(r.cacheCreation5m),
      cacheCreation1h: numOrUndefined(r.cacheCreation1h),
      total: numOrZero(r.total),
      apiType: r.apiType === 'messages' || r.apiType === 'chat-completions' || r.apiType === 'responses' ? r.apiType : undefined,
      incompleteFields: parseUsageFields(r.incompleteFields),
      bands: parseUsageBands(r.bands),
      servedModel: typeof r.servedModel === 'string' && r.servedModel ? r.servedModel : undefined
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseAuxiliaryCounts(value: unknown): TapSessionSummary['auxiliaryCounts'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const counts: Partial<Record<'title' | 'count' | 'policy' | 'subagent' | 'patch' | 'memory' | 'utility', number>> = {};
  for (const kind of ['title', 'count', 'policy', 'subagent', 'patch', 'memory', 'utility'] as const) {
    const count = source[kind];
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
      counts[kind] = Math.floor(count);
    }
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

function parseDailyUsage(value: unknown): Record<string, TapDailyUsage> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, TapDailyUsage> = {};
  for (const [day, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    out[day] = {
      tokens: numOrZero(record.tokens),
      usageByModel: parseUsageByModel(record.usageByModel)
    };
  }
  const keep = Object.keys(out).sort().slice(-RECENT_USAGE_DAYS);
  return keep.length ? Object.fromEntries(keep.map(key => [key, out[key]])) : undefined;
}

function parseRatePoints(value: unknown): readonly TapRatePoint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const points = value.flatMap(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const record = raw as Record<string, unknown>;
    const at = typeof record.at === 'string' ? record.at : '';
    if (!at || !Number.isFinite(Date.parse(at))) return [];
    const tokPerSec = typeof record.tokPerSec === 'number' && Number.isFinite(record.tokPerSec)
      ? record.tokPerSec
      : undefined;
    return [{ at, tokens: numOrZero(record.tokens), tokPerSec }];
  });
  return points.length ? points.slice(-RECENT_RATE_POINTS) : undefined;
}

function parsePendingSubagents(value: unknown): TapSessionSummary['pendingSubagents'] {
  if (!Array.isArray(value)) return undefined;
  const invocations = value.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const record = raw as Record<string, unknown>;
    const roots = Array.isArray(record.roots)
      ? record.roots.filter((root): root is string => typeof root === 'string' && root.length > 0)
      : [];
    if (roots.length === 0) return [];
    const id = typeof record.id === 'string' && record.id.trim()
      ? record.id.trim().slice(0, 240)
      : `legacy-subagent:${roots[0]}:${index + 1}`;
    const parentId = typeof record.parentId === 'string' && record.parentId.trim()
      ? record.parentId.trim().slice(0, 240)
      : undefined;
    const depth = typeof record.depth === 'number' && Number.isFinite(record.depth)
      ? Math.max(1, Math.min(16, Math.floor(record.depth)))
      : 1;
    const displayName = typeof record.displayName === 'string' && record.displayName.trim()
      ? record.displayName.trim().slice(0, 120)
      : undefined;
    const agentType = typeof record.agentType === 'string' && record.agentType.trim()
      ? record.agentType.trim().slice(0, 120)
      : undefined;
    return [{
      id,
      parentId,
      depth,
      roots: [...new Set(roots)].slice(0, 4),
      displayName,
      agentType
    }];
  });
  return invocations.length ? invocations.slice(-16) : undefined;
}

function cleanStoredFirstPromptNoise(
  firstPrompt: unknown,
  source: TapTraceRecord['source']
): string | undefined {
  if (typeof firstPrompt !== 'string' || !firstPrompt.trim()) return undefined;
  const cleaned = (source === 'claude-cli' || source === 'claude-vscode'
    ? stripKnownLeadingPromptNoise(firstPrompt)
    : stripKnownPromptNoise(firstPrompt)).trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

async function recoverStoredSessionTitle(session: TapSessionSummary): Promise<string | undefined> {
  const traces = await readJsonlPrefix(
    session.jsonlPath,
    Math.max(1, Math.min(8, session.traceCount || 1))
  );
  for (const storedTrace of traces) {
    const trace = hydrateStoredSse(storedTrace);
    const auxiliary = trace.auxiliary ?? classifyAuxiliaryTrace(trace);
    if (auxiliary !== 'title') continue;
    if (trace.source === 'claude-cli' || trace.source === 'claude-vscode') {
      const requestKey = trace.clientConversationKey || extractClientConversationKey(trace);
      if (requestKey && session.clientConversationKey && requestKey !== session.clientConversationKey) {
        continue;
      }
    }
    const title = extractGeneratedTitle(trace);
    if (title) return title;
  }
  return undefined;
}

function legacyCopilotSessionNeedsTraceCheck(session: TapSessionSummary): boolean {
  if (session.hidden === true || session.source !== 'copilot') return false;
  const prompt = (session.firstPrompt || '').trim().toLowerCase();
  return prompt.startsWith('the following is a compressed version of the preceeding history in the current conversation.')
    || prompt.startsWith('the following is a compressed version of the preceding history in the current conversation.')
    || prompt.startsWith('the goal of the patch is:')
    || prompt.startsWith('please generate exactly ')
    || prompt.startsWith('please write a brief branch name for the following request:')
    || prompt.startsWith('generate a concise issue title')
    || prompt.startsWith('summarize the following content in a single sentence')
    || prompt.startsWith('you assess what one terminal command does for a code-editing ai agent')
    || prompt.startsWith('you assess what one tool call does for a code-editing ai agent')
    || prompt.startsWith('repository details:');
}

function legacyCodexUtilitySessionNeedsTraceCheck(session: TapSessionSummary): boolean {
  if (session.source !== 'codex-cli' && session.source !== 'codex-vscode') return false;
  return session.hidden === true && session.auxiliary === 'title';
}

function legacyHiddenAuxiliaryForCopilotSession(
  traces: readonly TapTraceRecord[]
): TapSessionSummary['auxiliary'] | undefined {
  if (traces.length === 0) return undefined;
  const labels = new Set<'title' | 'patch' | 'utility'>();

  for (const trace of traces) {
    if (trace.source && trace.source !== 'copilot') return undefined;
    const classification = getCopilotClassification(trace);
    if (classification) {
      if (classification.kind === 'title') labels.add('title');
      else if (classification.kind === 'patch') labels.add('patch');
      else labels.add('utility');
      continue;
    }
    if (trace.auxiliary === 'title' || trace.auxiliary === 'patch') {
      labels.add(trace.auxiliary);
      continue;
    }
    if (detectCompact(trace)) {
      labels.add('utility');
      continue;
    }
    return undefined;
  }

  if (labels.size === 0) return undefined;
  if (labels.size === 1 && labels.has('title')) return 'title';
  if (labels.size === 1 && labels.has('patch')) return 'patch';
  return 'utility';
}

async function readJsonlPrefix(file: string, maxRecords: number): Promise<TapTraceRecord[]> {
  const traces: TapTraceRecord[] = [];
  let input: fs.ReadStream | undefined;
  let rl: readline.Interface | undefined;
  try {
    input = fs.createReadStream(file, { encoding: 'utf8' });
    rl = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) {
      const text = String(line || '').trim();
      if (!text) continue;
      traces.push(...parseJsonlLines<TapTraceRecord>([text]));
      if (traces.length >= maxRecords) {
        rl.close();
        break;
      }
    }
  } catch {
    return traces;
  } finally {
    if (rl) rl.close();
    if (input) input.destroy();
  }
  return traces;
}

function numOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function numOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function parseUsageFields(value: unknown): TapModelUsage['incompleteFields'] {
  if (!Array.isArray(value)) return undefined;
  const fields = value.filter((field): field is NonNullable<TapModelUsage['incompleteFields']>[number] => (
    field === 'input' || field === 'cacheRead' || field === 'cacheWrite' || field === 'output' || field === 'total'
  ));
  return fields.length ? [...new Set(fields)] : undefined;
}

function parseUsageBands(value: unknown): readonly TapModelUsageBand[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const bands: TapModelUsageBand[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.tier !== 'number' || !Number.isFinite(r.tier)) continue;
    bands.push({
      tier: r.tier,
      offPeak: r.offPeak === true,
      ...(r.shortOutput === true ? { shortOutput: true as const } : {}),
      input: numOrZero(r.input),
      output: numOrZero(r.output),
      cacheRead: numOrZero(r.cacheRead),
      cacheCreation: numOrZero(r.cacheCreation),
      cacheCreation5m: numOrUndefined(r.cacheCreation5m),
      cacheCreation1h: numOrUndefined(r.cacheCreation1h)
    });
  }
  return bands.length ? bands : undefined;
}

function mergeUsageBands(
  left: readonly TapModelUsageBand[] | undefined,
  right: readonly TapModelUsageBand[] | undefined
): readonly TapModelUsageBand[] | undefined {
  if (!left?.length) return right?.length ? right : undefined;
  if (!right?.length) return left;
  const merged = [...left];
  for (const band of right) {
    const index = merged.findIndex(item => (
      item.tier === band.tier && item.offPeak === band.offPeak && !!item.shortOutput === !!band.shortOutput
    ));
    if (index < 0) {
      merged.push(band);
      continue;
    }
    const current = merged[index];
    merged[index] = {
      tier: band.tier,
      offPeak: band.offPeak,
      ...(band.shortOutput ? { shortOutput: true } : {}),
      input: current.input + band.input,
      output: current.output + band.output,
      cacheRead: current.cacheRead + band.cacheRead,
      cacheCreation: current.cacheCreation + band.cacheCreation,
      ...(current.cacheCreation5m !== undefined || band.cacheCreation5m !== undefined
        ? { cacheCreation5m: (current.cacheCreation5m || 0) + (band.cacheCreation5m || 0) }
        : {}),
      ...(current.cacheCreation1h !== undefined || band.cacheCreation1h !== undefined
        ? { cacheCreation1h: (current.cacheCreation1h || 0) + (band.cacheCreation1h || 0) }
        : {})
    };
  }
  return merged;
}

function mergeUsageFields(
  left: TapModelUsage['incompleteFields'],
  right: TapModelUsage['incompleteFields']
): TapModelUsage['incompleteFields'] {
  const fields = [...new Set([...(left ?? []), ...(right ?? [])])];
  return fields.length ? fields : undefined;
}

function traceIndexReadError(indexPath: string, detail: string): Error {
  return new Error(`Trace 索引不可用，已停止记录且未修改原文件：${detail}（${indexPath}）`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function traceHasError(t: TapTraceRecord): boolean {
  if (t.error) return true;
  const sc = t.response?.statusCode;
  if (typeof sc !== 'number' || sc < 400) return false;
  // count_tokens 404 = 网关没实现 Anthropic 的 /v1/messages/count_tokens 端点
  // （兼容服务 等兼容网关常见缺口）。Claude Code 容忍它、回退到自己的估算，对话不受影响。
  // 这是「上游能力缺口」而非「请求失败」，不计入 session 的 errorCount，避免 dashboard 误标红。
  if (t.auxiliary === 'count' && sc === 404) return false;
  return true;
}

function isTraceSource(v: unknown): v is TapTraceRecord['source'] {
  return v === 'copilot' || v === 'claude-cli' || v === 'claude-vscode'
    || v === 'codex-cli' || v === 'codex-vscode' || v === 'unknown';
}
