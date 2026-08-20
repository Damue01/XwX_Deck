import { ANTHROPIC_POLICY_SYSTEM_PHRASES, ANTHROPIC_TITLE_SYSTEM_PHRASES } from './clientSignatures';
import {
  classifyCopilotUtility,
  type CopilotUtilityClassification
} from './copilotUtilityRules';
import { extractSystemText, userTexts } from './protocolBody';
import type { SessionFingerprint } from './sessionBoundary';
import { findSessionByResponseId, matchSession } from './sessionBoundary';
import type { TapSessionSummary, TapTraceRecord } from './types';

export { findSessionByResponseId, matchSession };

const COPILOT_CLASSIFICATION_CACHE = new WeakMap<TapTraceRecord, CopilotUtilityClassification | null>();

export function getCopilotClassification(trace: TapTraceRecord): CopilotUtilityClassification | undefined {
  if (COPILOT_CLASSIFICATION_CACHE.has(trace)) {
    return COPILOT_CLASSIFICATION_CACHE.get(trace) ?? undefined;
  }
  const classification = classifyCopilotUtility(trace);
  COPILOT_CLASSIFICATION_CACHE.set(trace, classification ?? null);
  return classification;
}

export function classifyAuxiliaryTrace(trace: TapTraceRecord): TapTraceRecord['auxiliary'] | undefined {
  const requestPath = trace.request?.path || '';
  if (/\/messages\/count_tokens$/i.test(requestPath)) return 'count';
  if (isAnthropicTitleRequest(trace)) return 'title';
  if (trace.source === 'copilot') {
    const classification = getCopilotClassification(trace);
    if (classification?.visibility === 'attach') {
      if (classification.kind === 'title') return 'title';
      if (classification.kind === 'patch') return 'patch';
    }
  }
  if (isAnthropicPolicyRequest(trace)) return 'policy';
  if (trace.source !== 'codex-cli' && trace.source !== 'codex-vscode') return undefined;
  if (isCodexMemoryMaintenanceRequest(trace)) return 'memory';
  const format = codexResponseFormat(trace);
  if (!format) return undefined;
  if (format.name === 'codex_output_schema') return codexFormatHasTitleSchema(format) ? 'title' : undefined;
  if (format.type !== 'json_schema') return undefined;
  return codexFormatHasTitleSchema(format) ? 'title' : undefined;
}

export function isCodexStructuredUtilityTrace(trace: TapTraceRecord): boolean {
  if (trace.source !== 'codex-cli' && trace.source !== 'codex-vscode') return false;
  const format = codexResponseFormat(trace);
  if (!format) return false;
  const structured = format.name === 'codex_output_schema' || format.type === 'json_schema';
  return structured && !codexFormatHasTitleSchema(format);
}

export function extractGeneratedTitle(trace: TapTraceRecord): string | undefined {
  const snapshot = trace.sse?.snapshot ?? trace.response?.snapshot;
  const blocks = snapshot?.content;
  if (!Array.isArray(blocks)) return undefined;
  const text = blocks
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('')
    .trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') {
      const title = (parsed as Record<string, unknown>).title;
      return typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : undefined;
    }
  } catch { /* A non-JSON Claude title is already the display value. */ }
  return text.slice(0, 120);
}

export function findSessionByRootHash(
  sessions: readonly TapSessionSummary[],
  rootHash: string,
  source: TapTraceRecord['source'],
  now: Date
): TapSessionSummary | undefined {
  return pickRecentSession(
    sessions,
    now,
    session => session.hidden !== true
      && !!source && session.source === source
      && Array.isArray(session.lastChain) && session.lastChain[0] === rootHash,
    10 * 60 * 1000
  );
}

export function findSessionByInteractionId(
  sessions: readonly TapSessionSummary[],
  interactionId: string,
  source: TapTraceRecord['source'],
  now: Date
): TapSessionSummary | undefined {
  const maxAgeMs = 2 * 60 * 1000;
  const nowMs = now.getTime();
  let best: TapSessionSummary | undefined;
  let bestTs = -Infinity;
  for (const session of sessions) {
    if (session.hidden === true || !source || session.source !== source) continue;
    if (!Array.isArray(session.interactionIds) || !session.interactionIds.includes(interactionId)) continue;
    const updatedAt = Date.parse(session.updatedAt || session.startedAt);
    if (!Number.isFinite(updatedAt) || nowMs - updatedAt > maxAgeMs) continue;
    if (updatedAt > bestTs) {
      bestTs = updatedAt;
      best = session;
    }
  }
  return best;
}

export function findRecentMainSession(
  sessions: readonly TapSessionSummary[],
  now: Date,
  source: TapTraceRecord['source'],
  maxAgeMs: number
): TapSessionSummary | undefined {
  return pickRecentSession(
    sessions,
    now,
    session => session.hidden !== true && !!source && session.source === source,
    maxAgeMs
  );
}

export function findHiddenProvisionalByPendingRoot(
  sessions: readonly TapSessionSummary[],
  root: string,
  source: TapTraceRecord['source']
): TapSessionSummary | undefined {
  return sessions.find(session =>
    session.hidden === true
    && !!source && session.source === source
    && Array.isArray(session.pendingUtilityRoots)
    && session.pendingUtilityRoots.some(candidate => candidate.root === root)
  );
}

export function findHiddenProvisionalByPendingClientKey(
  sessions: readonly TapSessionSummary[],
  key: string,
  source: TapTraceRecord['source']
): TapSessionSummary | undefined {
  return sessions.find(session =>
    session.hidden === true
    && !!source && session.source === source
    && Array.isArray(session.pendingUtilityClientKeys)
    && session.pendingUtilityClientKeys.some(candidate => candidate.key === key)
  );
}

export function findRecentTitleHostSession(
  sessions: readonly TapSessionSummary[],
  now: Date,
  source: TapTraceRecord['source']
): TapSessionSummary | undefined {
  return pickRecentSession(
    sessions,
    now,
    session => !!source
      && session.source === source
      && (session.hidden !== true || session.auxiliary === 'title' || session.auxiliary === 'policy'),
    10 * 60 * 1000
  );
}

export function findRecentHiddenAuxiliarySession(
  sessions: readonly TapSessionSummary[],
  now: Date,
  source: TapTraceRecord['source']
): TapSessionSummary | undefined {
  return pickRecentSession(sessions, now, session =>
    session.hidden === true
    && (session.auxiliary === 'title' || session.auxiliary === 'count'
      || session.auxiliary === 'policy' || session.auxiliary === 'subagent')
    && !session.pendingUtilityRoots
    && !session.pendingUtilityClientKeys
    && !!source && session.source === source);
}

export function findRecentSessionBySource(
  sessions: readonly TapSessionSummary[],
  now: Date,
  source: TapTraceRecord['source']
): TapSessionSummary | undefined {
  return pickRecentSession(
    sessions,
    now,
    session => session.hidden !== true && !!source && session.source === source
  );
}

export function findRecentCompactResumeHost(
  sessions: readonly TapSessionSummary[],
  now: Date,
  source: TapTraceRecord['source']
): TapSessionSummary | undefined {
  return pickRecentSession(
    sessions,
    now,
    session => session.hidden !== true && !!source && session.source === source,
    10 * 60 * 1000
  );
}

export function findRecentEditedPromptSession(
  sessions: readonly TapSessionSummary[],
  now: Date,
  source: TapTraceRecord['source'],
  fingerprint: SessionFingerprint
): TapSessionSummary | undefined {
  if (source !== 'copilot' || !fingerprint.firstPrompt || fingerprint.chainHashes.length === 0) return undefined;
  const nowMs = now.getTime();
  const maxAgeMs = 10 * 60 * 1000;
  let best: TapSessionSummary | undefined;
  let bestScore = 0;
  let bestTs = -Infinity;
  for (const session of sessions) {
    if (session.hidden === true || session.source !== source || session.clientConversationKey) continue;
    if (!session.firstPrompt || !session.lastChain?.length) continue;
    if (session.lastChain[0] === fingerprint.chainHashes[0]) continue;
    const updatedAt = Date.parse(session.updatedAt || session.startedAt);
    if (!Number.isFinite(updatedAt) || nowMs - updatedAt > maxAgeMs) continue;
    const score = promptSimilarity(session.firstPrompt, fingerprint.firstPrompt);
    if (score < 0.82) continue;
    if (score > bestScore || (score === bestScore && updatedAt > bestTs)) {
      best = session;
      bestScore = score;
      bestTs = updatedAt;
    }
  }
  return best;
}

export function findSessionByClientConversationKey(
  sessions: readonly TapSessionSummary[],
  clientConversationKey: string,
  source: TapTraceRecord['source']
): TapSessionSummary | undefined {
  // Hidden utility buckets can be newer than the real conversation. Prefer the
  // existing visible owner so an internal memory/title request cannot become
  // the canonical session merely because it arrived milliseconds earlier.
  const visible = pickRecentSession(
    sessions,
    new Date(8640000000000000),
    session => !!source
      && session.source === source
      && session.hidden !== true
      && session.clientConversationKey === clientConversationKey,
    Number.POSITIVE_INFINITY
  );
  if (visible) return visible;
  return pickRecentSession(
    sessions,
    new Date(8640000000000000),
    session => !!source
      && session.source === source
      && session.clientConversationKey === clientConversationKey,
    Number.POSITIVE_INFINITY
  );
}

export interface PendingSubagentSessionHit {
  readonly session: TapSessionSummary;
  readonly invocation?: NonNullable<TapSessionSummary['pendingSubagents']>[number];
}

export function findSessionByPendingSubagentRoot(
  sessions: readonly TapSessionSummary[],
  now: Date,
  candidates: readonly string[],
  source: TapTraceRecord['source'],
  clientConversationKey?: string
): PendingSubagentSessionHit | undefined {
  const session = pickRecentSession(sessions, now, candidate =>
    candidate.hidden !== true
    && !!source && candidate.source === source
    && (!clientConversationKey || !candidate.clientConversationKey || candidate.clientConversationKey === clientConversationKey)
    && !!(
      candidate.pendingSubagents?.some(invocation =>
        candidates.some(hash => invocation.roots.includes(hash)))
      || candidate.pendingSubagentRoots?.some(hash => candidates.includes(hash))
    ));
  if (!session) return undefined;
  // roots[0] 是全文哈希，roots[1] 才是 200 字截断哈希（见 subagentInvocations）。共享长前缀的
  // 并发调用截断后哈希相同，若按任意 root 取"最新一条"，同批 fan out 的多个 agent 会全部冒充
  // 成最后那个（invocationId/displayName/parentId 全错，viewer 里合并成一张挂错名的卡）。
  // 故：全文匹配优先；仅当截断匹配唯一时才接受它，有歧义则不返回 invocation——
  // 宁可退回旧的连续同名分组，也不要写入错误的父子关系。
  const pending = [...(session.pendingSubagents || [])].reverse();
  const exact = pending.find(candidate => candidates.includes(candidate.roots[0]));
  let invocation = exact;
  if (!invocation) {
    const loose = pending.filter(candidate =>
      candidate.roots.some(hash => candidates.includes(hash)));
    invocation = loose.length === 1 ? loose[0] : undefined;
  }
  return { session, invocation };
}

function isAnthropicTitleRequest(trace: TapTraceRecord): boolean {
  if (trace.source !== 'claude-cli' && trace.source !== 'claude-vscode') return false;
  const system = extractSystemText(trace.request?.body).toLowerCase();
  return ANTHROPIC_TITLE_SYSTEM_PHRASES.some(rule => system.includes(rule.phrase));
}

function isAnthropicPolicyRequest(trace: TapTraceRecord): boolean {
  if (trace.source !== 'claude-cli' && trace.source !== 'claude-vscode') return false;
  const system = extractSystemText(trace.request?.body).toLowerCase();
  return ANTHROPIC_POLICY_SYSTEM_PHRASES.some(rule => system.includes(rule.phrase));
}

function isCodexMemoryMaintenanceRequest(trace: TapTraceRecord): boolean {
  const body = trace.request?.body;
  if (!body || typeof body !== 'object') return false;
  return userTexts(body as Record<string, unknown>).some(text => {
    const normalized = text.trim();
    return /^##\s*Memory Writing Agent:\s*Phase\s+[12]\b/i.test(normalized)
      || /^Analyze this rollout and produce JSON with `raw_memory`, `rollout_summary`, and `rollout_slug`/i.test(normalized);
  });
}

function codexResponseFormat(trace: TapTraceRecord): Record<string, unknown> | undefined {
  const body = trace.request?.body;
  if (!body || typeof body !== 'object') return undefined;
  const text = (body as Record<string, unknown>).text;
  if (!text || typeof text !== 'object') return undefined;
  const format = (text as Record<string, unknown>).format;
  return format && typeof format === 'object' ? format as Record<string, unknown> : undefined;
}

function codexFormatHasTitleSchema(format: Record<string, unknown>): boolean {
  const schema = format.schema;
  if (!schema || typeof schema !== 'object') return false;
  const properties = (schema as Record<string, unknown>).properties;
  return !!properties && typeof properties === 'object' && Object.prototype.hasOwnProperty.call(properties, 'title');
}

function promptSimilarity(a: string, b: string): number {
  const x = normalizePromptForSimilarity(a).slice(0, 1200);
  const y = normalizePromptForSimilarity(b).slice(0, 1200);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (Math.min(x.length, y.length) < 32) return 0;
  const shorter = x.length <= y.length ? x : y;
  const longer = x.length <= y.length ? y : x;
  if (longer.includes(shorter) && shorter.length / longer.length >= 0.6) return 1;
  return diceCoefficient(charNgrams(x, 3), charNgrams(y, 3));
}

function normalizePromptForSimilarity(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function charNgrams(text: string, size: number): Map<string, number> {
  const ngrams = new Map<string, number>();
  if (text.length <= size) {
    ngrams.set(text, 1);
    return ngrams;
  }
  for (let index = 0; index <= text.length - size; index += 1) {
    const gram = text.slice(index, index + size);
    ngrams.set(gram, (ngrams.get(gram) || 0) + 1);
  }
  return ngrams;
}

function diceCoefficient(a: Map<string, number>, b: Map<string, number>): number {
  let overlap = 0;
  let totalA = 0;
  let totalB = 0;
  for (const [gram, count] of a) {
    totalA += count;
    overlap += Math.min(count, b.get(gram) || 0);
  }
  for (const count of b.values()) totalB += count;
  const denominator = totalA + totalB;
  return denominator === 0 ? 0 : (2 * overlap) / denominator;
}

function pickRecentSession(
  sessions: readonly TapSessionSummary[],
  now: Date,
  predicate: (session: TapSessionSummary) => boolean,
  maxAgeMs: number = 2 * 60 * 1000
): TapSessionSummary | undefined {
  let best: TapSessionSummary | undefined;
  let bestTs = -Infinity;
  const nowMs = now.getTime();
  for (const session of sessions) {
    if (!predicate(session)) continue;
    const updatedAt = Date.parse(session.updatedAt || session.startedAt);
    if (!Number.isFinite(updatedAt) || nowMs - updatedAt > maxAgeMs) continue;
    if (updatedAt > bestTs) {
      bestTs = updatedAt;
      best = session;
    }
  }
  return best;
}
