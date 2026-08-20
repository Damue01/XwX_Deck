import { NormalizedUsage, TapProtocol, TapUsageField } from './types';
import { stripUndefined } from '../shared/obj';

export function normalizeUsage(value: unknown, protocol: TapProtocol): NormalizedUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as Record<string, unknown>;
  const promptDetails = objectField(usage, 'prompt_tokens_details')
    ?? objectField(usage, 'input_tokens_details')
    ?? objectField(usage, 'input_token_details');
  const completionDetails = objectField(usage, 'completion_tokens_details')
    ?? objectField(usage, 'output_tokens_details')
    ?? objectField(usage, 'output_token_details');
  const cacheCreation = objectField(usage, 'cache_creation');

  const inputTokens = firstNumber(
    usage.input_tokens,
    usage.prompt_tokens,
    usage.input,
    usage.prompt
  );
  const outputTokens = firstNumber(
    usage.output_tokens,
    usage.completion_tokens,
    usage.output,
    usage.completion
  );
  const topLevelCacheRead = firstNumber(
    usage.cache_read_input_tokens,
    usage.cache_read_tokens,
    usage.cacheReadTokens
  );
  const detailCacheRead = firstNumber(
    promptDetails?.cached_tokens,
    promptDetails?.cache_read_tokens,
    promptDetails?.cache_read_input_tokens
  );
  const cacheCreation5mTokens = firstNumber(
    cacheCreation?.ephemeral_5m_input_tokens,
    promptDetails?.cache_write_5m_tokens,
    // 兼容服务 的 Chat Completions 用这两个名字公布写入量（含 TTL 拆分），
    // 不读它们的话，经 chat 线路桥接的模型「缓存写」永远是未知，费用直接不可用。
    usage.claude_cache_creation_5_m_tokens
  );
  const cacheCreation1hTokens = firstNumber(
    cacheCreation?.ephemeral_1h_input_tokens,
    promptDetails?.cache_write_1h_tokens,
    usage.claude_cache_creation_1_h_tokens
  );
  const topLevelCacheCreation = firstNumber(
    usage.cache_creation_input_tokens,
    usage.cache_creation_tokens,
    usage.cacheCreationTokens,
    cacheCreation?.input_tokens,
    cacheCreation?.tokens,
    sumDefined(cacheCreation5mTokens, cacheCreation1hTokens)
  );
  // The payload's shape outranks the declared protocol.
  //
  // A 兼容服务-bridged model answers a Messages client from a Chat Completions
  // upstream and emits BOTH shapes at once — top-level Anthropic counters plus a
  // prompt_tokens_details mirror of just the read count. Trusting the declared
  // upstream protocol then read it as subset semantics, which zeroed the
  // cache-write bucket while cacheCreation5m still held the real 10,396 tokens,
  // and collapsed a 35,226-token turn to 838. OpenAI never reports cache
  // *creation* at the top level, so its presence is an unambiguous marker of the
  // additive Anthropic shape.
  const anthropicShaped = usage.cache_creation_input_tokens !== undefined
    || usage.cache_creation_tokens !== undefined
    || cacheCreation !== undefined;
  const effectiveProtocol: TapProtocol = anthropicShaped ? 'anthropic-messages' : protocol;
  const cacheReadTokens = effectiveProtocol === 'anthropic-messages'
    ? preferPositive(topLevelCacheRead, detailCacheRead)
    : effectiveProtocol === 'openai-responses' || effectiveProtocol === 'openai-chat-completions'
      ? detailCacheRead
      : preferPositive(topLevelCacheRead, detailCacheRead);
  const detailCacheCreation = firstNumber(
    promptDetails?.cache_creation_tokens,
    promptDetails?.cache_creation_input_tokens,
    // Responses 用的就是这个名字；漏掉它，Codex 每一轮的「缓存写」都显示 —
    promptDetails?.cache_write_tokens
  );
  const cacheCreationTokens = effectiveProtocol === 'anthropic-messages'
    ? topLevelCacheCreation
    : effectiveProtocol === 'openai-responses' || effectiveProtocol === 'openai-chat-completions'
      // Reaching the top level here cannot pull in Anthropic's additive counters:
      // their presence would already have flipped effectiveProtocol above. What is
      // left is the TTL pair 兼容服务 publishes on the chat wire.
      ? preferPositive(detailCacheCreation, topLevelCacheCreation)
      : preferPositive(topLevelCacheCreation, detailCacheCreation);
  const inputIncludesCache = effectiveProtocol === 'openai-responses' || effectiveProtocol === 'openai-chat-completions'
    ? true
    : effectiveProtocol === 'anthropic-messages'
      ? false
      : undefined;
  const reasoningTokens = firstNumber(
    usage.reasoning_tokens,
    completionDetails?.reasoning_tokens,
    completionDetails?.reasoning,
    // Anthropic：output_tokens_details.thinking_tokens（思考明文被加密隐藏时也会给计数）
    completionDetails?.thinking_tokens,
    usage.thinking_tokens
  );
  const openAiInput = effectiveProtocol === 'openai-responses' || effectiveProtocol === 'openai-chat-completions';
  const anthropicInput = effectiveProtocol === 'anthropic-messages';
  // Token counts and prices have different tolerances for a missing field.
  // A cache bucket the upstream never reported contributes nothing to the token
  // arithmetic, so counting it as 0 keeps the Tokens column and context-window
  // math intact. Whether that absence means "no cache writes happened" or "this
  // gateway just doesn't report them" is a *pricing* question, so the field is
  // still recorded in incompleteFields and billing stays unavailable until the
  // provider semantics are known. Reproduced by Anthropic-compatible endpoints
  // that omit cache_creation_input_tokens entirely.
  const inputUncachedTokens = anthropicInput
    ? inputTokens
    : openAiInput && inputTokens !== undefined
      ? Math.max(0, inputTokens - (cacheReadTokens ?? 0) - (cacheCreationTokens ?? 0))
      : undefined;
  const inputTotalTokens = openAiInput
    ? inputTokens
    : anthropicInput && inputTokens !== undefined
      ? inputTokens + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0)
      : undefined;

  // total_tokens is authoritative when present, otherwise derived from the
  // total-input bucket and output.
  const explicitTotal = firstNumber(usage.total_tokens, usage.total);
  const totalTokens = explicitTotal !== undefined
    ? explicitTotal
    : inputTotalTokens !== undefined && outputTokens !== undefined
      ? inputTotalTokens + outputTokens
      : undefined;
  const incompleteFields: TapUsageField[] = [];
  if (inputUncachedTokens === undefined) incompleteFields.push('input');
  if (cacheReadTokens === undefined) incompleteFields.push('cacheRead');
  if (cacheCreationTokens === undefined) incompleteFields.push('cacheWrite');
  if (outputTokens === undefined) incompleteFields.push('output');
  if (totalTokens === undefined) incompleteFields.push('total');

  const out: NormalizedUsage = stripUndefined({
    inputTokens,
    inputUncachedTokens,
    inputTotalTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheCreationTokens,
    cacheCreation5mTokens,
    cacheCreation1hTokens,
    reasoningTokens,
    inputIncludesCache,
    incompleteFields: incompleteFields.length ? incompleteFields : undefined
  });

  return Object.keys(out).length > 0 ? out : undefined;
}

export function mergeUsage(...values: Array<NormalizedUsage | undefined>): NormalizedUsage | undefined {
  let merged: NormalizedUsage | undefined;
  for (const value of values) {
    if (!value) continue;
    merged = stripUndefined({
      inputTokens: value.inputTokens ?? merged?.inputTokens,
      inputUncachedTokens: value.inputUncachedTokens ?? merged?.inputUncachedTokens,
      inputTotalTokens: value.inputTotalTokens ?? merged?.inputTotalTokens,
      outputTokens: value.outputTokens ?? merged?.outputTokens,
      totalTokens: value.totalTokens ?? merged?.totalTokens,
      cacheReadTokens: value.cacheReadTokens ?? merged?.cacheReadTokens,
      cacheCreationTokens: value.cacheCreationTokens ?? merged?.cacheCreationTokens,
      cacheCreation5mTokens: value.cacheCreation5mTokens ?? merged?.cacheCreation5mTokens,
      cacheCreation1hTokens: value.cacheCreation1hTokens ?? merged?.cacheCreation1hTokens,
      reasoningTokens: value.reasoningTokens ?? merged?.reasoningTokens,
      inputIncludesCache: value.inputIncludesCache ?? merged?.inputIncludesCache,
      incompleteFields: undefined
    });
    merged = { ...merged, incompleteFields: incompleteFieldsOf(merged) };
  }
  if (merged && merged.totalTokens === undefined && merged.inputTotalTokens !== undefined && merged.outputTokens !== undefined) {
    merged = {
      ...merged,
      totalTokens: merged.inputTotalTokens + merged.outputTokens,
      incompleteFields: merged.incompleteFields?.filter(field => field !== 'total')
    };
  }
  return merged;
}

// ─── Token 口径权威定义（唯一来源）──────────────────────────────────────────
// 两个概念必须分清，历史上因为混用 totalTokens 一个名字而口径漂移：
//   1) 上下文窗口占用 = 喂进模型的内容（输入 + 缓存读 + 缓存写），【不含输出】。
//   2) 计费总量       = 一整回合消耗（上下文窗口 + 输出），用于估算费用。
// 缓存写(cacheCreation)是"首次写入缓存的那部分输入"，本回合确实喂进了模型、占上下文窗口，故两者都计入。
// 输出(output)是模型吐出来的，不占输入侧上下文窗口，故仅计入计费总量。
// ⚠️ inputIncludesCache 为真时（OpenAI 系）缓存已经算在 inputTokens 里，再加一遍就是翻倍：
//    Codex 一轮 input=49910 / cached=49682，旧公式给出 99592，实际上下文占用就是 49910。
// ⚠️ viewerHtml.ts 的客户端 <script> 内有这两个函数的镜像实现，改这里务必同步改那里。

/**
 * 上下文窗口占用 = prompt_tokens 口径，与 VS Code Copilot 的 context window 一致。
 * = 输入 + 缓存读 + 缓存写（不含输出）；OpenAI 系的 input_tokens 本身已含缓存，直接取它。
 */
export function contextWindowTokens(u: NormalizedUsage | undefined): number {
  if (!u) return 0;
  if (typeof u.inputTotalTokens === 'number') return u.inputTotalTokens;
  if (u.inputIncludesCache) return u.inputTokens || 0;
  return (u.inputUncachedTokens ?? u.inputTokens ?? 0)
    + (u.cacheReadTokens || 0)
    + (u.cacheCreationTokens || 0);
}

/**
 * 计费总量 = total_tokens 口径，用于估算费用。
 * API 显式给的 totalTokens 优先（已含缓存与输出）；缺失时按 上下文窗口占用 + 输出 兜底。
 */
export function billableTotalTokens(u: NormalizedUsage | undefined): number {
  if (!u) return 0;
  if (typeof u.totalTokens === 'number') return u.totalTokens;
  return contextWindowTokens(u) + (u.outputTokens || 0);
}

function objectField(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = obj[key];
  return v && typeof v === 'object' && !Array.isArray(v)
    ? v as Record<string, unknown>
    : undefined;
}

/**
 * Pick a token count from a field's aliases.
 *
 * An alias that reports 0 while a sibling alias reports a real count is not a
 * measurement of zero — it is the naming scheme this payload does not use.
 * 兼容服务's Chat Completions usage carries BOTH schemes and zero-fills the
 * unused one (`input_tokens: 0` next to `prompt_tokens: 109331`), so taking the
 * first defined alias zeroed input and output on every request bridged over the
 * chat wire while total_tokens stayed right — the Tokens column looked plausible
 * and the input/output columns read 0. A genuine zero still survives, because it
 * is only skipped when another alias carries a positive count.
 */
function firstNumber(...values: unknown[]): number | undefined {
  let fallback: number | undefined;
  for (const value of values) {
    const parsed = toFiniteNumber(value);
    if (parsed === undefined) continue;
    if (parsed > 0) return parsed;
    if (fallback === undefined) fallback = parsed;
  }
  return fallback;
}

/** Same rule across two already-resolved candidates from different shapes. */
function preferPositive(...values: Array<number | undefined>): number | undefined {
  let fallback: number | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    if (value > 0) return value;
    if (fallback === undefined) fallback = value;
  }
  return fallback;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  let total = 0;
  let any = false;
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) { total += v; any = true; }
  }
  return any ? total : undefined;
}

function incompleteFieldsOf(usage: NormalizedUsage): TapUsageField[] | undefined {
  const fields: TapUsageField[] = [];
  if (usage.inputUncachedTokens === undefined) fields.push('input');
  if (usage.cacheReadTokens === undefined) fields.push('cacheRead');
  if (usage.cacheCreationTokens === undefined) fields.push('cacheWrite');
  if (usage.outputTokens === undefined) fields.push('output');
  if (usage.totalTokens === undefined) fields.push('total');
  return fields.length ? fields : undefined;
}
