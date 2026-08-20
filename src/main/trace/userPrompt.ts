/**
 * 从客户端的 user 消息里抽出真正的用户输入。
 *
 * 历史失效形态（2026-06-13 实测）：
 *   Copilot 走 Anthropic 协议时，user.content 是多 part 数组：
 *     part0 = `<environment_info>...`
 *     part1 = `<attachments>...</attachments>`（attachment 可能整段塞用户粘的文档原文）
 *     partN = `<userRequest>...</userRequest>`（真实用户输入，永远在末尾）
 *   旧实现把所有 part join 成一段后用非贪婪正则 `<userRequest>([\\s\\S]*?)</userRequest>`，
 *   一旦 attachment 文档正文里**字面字符**含有 `<userRequest>`（被反引号包着也算），
 *   就会从伪开标签匹到真闭标签，把文档正文当成首条用户输入。
 *
 * 方案 C 的根治：
 *   ① 接受 part 数组或单串，**逐 part 扫**——把 attachment part 与 userRequest part 物理隔离。
 *   ② **倒序优先**——客户端真实的 `<userRequest>` 永远在 user 消息最后一段，
 *      从末尾往前找，第一个命中的 part 就是真 prompt。
 *   ③ **配对计数校验**——只接受 `<tag` / `</tag>` 出现次数相等且 ≥ 1 的 part；
 *      混入伪开标签（次数不平衡）的 part 直接跳过。
 *   ④ **part 内取最后一对**——若同一 part 内同 tag 出现多对（极端情况），用末尾配对，
 *      与"客户端注入永远在末尾"的客观规律对齐。
 */

const USER_PROMPT_TAGS_FALLBACK: readonly string[] = [
  'userRequest', 'user_query', 'user_message', 'user_input', 'user_prompt', 'user_instructions', 'question'
];

export interface ExtractUserPromptOptions {
  /** 自定义优先级标签列表；默认覆盖 Copilot/Codex/Claude 已知形态。 */
  readonly tags?: readonly string[];
  /** 同时接受 `<conversation-summary>` fallback（仅供 firstPrompt 展示路径使用，hash 路径不应启用）。 */
  readonly acceptConversationSummary?: boolean;
}

/** 把单串 / part 数组归一到 part 数组。 */
function toParts(input: string | readonly string[] | undefined | null): string[] {
  if (input == null) return [];
  if (typeof input === 'string') return input ? [input] : [];
  if (!Array.isArray(input)) return [];
  return input.filter(p => typeof p === 'string' && p.length > 0);
}

/** 统计 `<tag` 与 `</tag>` 在 part 中的出现次数，用于配对校验。 */
function countTag(part: string, tag: string): { open: number; close: number } {
  // 注意：开标签计数只看 `<tag` 而不要求 `<tag>` 完整闭合，否则 `<userRequest foo="x">` 这种带属性的会漏。
  const openRe = new RegExp('<' + tag + '\\b', 'gi');
  const closeRe = new RegExp('</' + tag + '\\s*>', 'gi');
  return {
    open: (part.match(openRe) || []).length,
    close: (part.match(closeRe) || []).length
  };
}

/** part 内取最后一对配对的内容；返回去除前后空白后的内容，无配对返回空串。 */
function takeLastPair(part: string, tag: string): string {
  const openRe = new RegExp('<' + tag + '\\b[^>]*>', 'gi');
  const closeRe = new RegExp('</' + tag + '\\s*>', 'gi');
  let lastOpen: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(part))) lastOpen = m;
  if (!lastOpen) return '';
  closeRe.lastIndex = lastOpen.index + lastOpen[0].length;
  const closeMatch = closeRe.exec(part);
  if (!closeMatch) return '';
  const inner = part.slice(lastOpen.index + lastOpen[0].length, closeMatch.index);
  return inner.trim();
}

/**
 * 主入口：从 user 消息内容里抽取真实用户 prompt。
 * 接受单串（向后兼容旧调用 / 测试）或 part 数组（结构化新路径）。
 *
 * 抽取分两遍：
 *   ① 严格遍：part 内 `<tag` / `</tag>` 计数完全相等且 ≥ 1，取末尾配对内容。
 *      在真实流量下（user.content 是 part 数组），attachment part 与 userRequest part
 *      物理隔离，伪开标签出现在 attachment part 里且不平衡 → 整段被拒；真 part 平衡命中。
 *   ② 兜底遍：放宽配对计数，仅要求 part 内末尾存在一个开标签 + 其后存在一个闭标签。
 *      用于单串输入（旧 API / 极端样本），仍按 part 边界处理，不跨 part。
 * 倒序扫 part：客户端真实用户输入永远在最后一段，从末尾向前扫提高命中率。
 */
export function extractUserPrompt(
  input: string | readonly string[] | undefined | null,
  options: ExtractUserPromptOptions = {}
): string {
  const parts = toParts(input);
  if (parts.length === 0) return '';
  const tags = options.tags && options.tags.length > 0 ? options.tags : USER_PROMPT_TAGS_FALLBACK;

  // ① 严格遍：配对计数相等 + 末尾配对。
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    for (const tag of tags) {
      const { open, close } = countTag(part, tag);
      if (open === 0 || open !== close) continue;
      const inner = takeLastPair(part, tag);
      if (inner) return inner;
    }
  }

  // ② 兜底遍：仅要求"末尾开标签 + 其后存在闭标签"，不强制全 part 计数平衡。
  // 用于单串退化场景；按 part 处理保证不跨 part 错配。
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    for (const tag of tags) {
      const inner = takeLastPair(part, tag);
      if (inner) return inner;
    }
  }

  // 可选 fallback：conversation-summary（compact-resume 形态展示用）。
  if (options.acceptConversationSummary) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      const { open, close } = countTag(part, 'conversation-summary');
      if (open >= 1 && open === close) {
        const inner = takeLastPair(part, 'conversation-summary');
        if (inner) return inner;
      }
    }
    // 兜底遍：放宽配对计数。
    for (let i = parts.length - 1; i >= 0; i--) {
      const inner = takeLastPair(parts[i], 'conversation-summary');
      if (inner) return inner;
    }
  }

  return '';
}

/**
 * Codex VS Code wraps the real user prompt in a markdown diagnostics block.
 * Keep the wrapper out of session titles and root hashes.
 */
export function extractCodexIdeRequest(input: string | readonly string[] | undefined | null): string {
  const parts = toParts(input);
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    const match = /^##\s+My request(?:\s+for Codex)?\s*:?\s*$/im.exec(part);
    if (!match || match.index === undefined) continue;
    const rest = part.slice(match.index + match[0].length).trim();
    if (rest) return rest;
  }
  return '';
}

export function isCopilotCompressedHistorySummary(
  input: string | readonly string[] | undefined | null
): boolean {
  const text = toParts(input).join('\n').trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  const startsWithKnownPrefix =
    lower.startsWith('the following is a compressed version of the preceeding history in the current conversation.')
    || lower.startsWith('the following is a compressed version of the preceding history in the current conversation.');
  if (!startsWithKnownPrefix) return false;
  return /<user\b[\s\S]*<\/user>/i.test(text)
    || /<assistant\b[\s\S]*<\/assistant>/i.test(text)
    || /<tool\b[\s\S]*<\/tool>/i.test(text);
}

/**
 * 判断一段 user 消息（单串或 part 数组）是不是只有 `<conversation-summary>` 兜底命中
 * （即 USER_PROMPT_TAGS 全部未命中、只能靠 conversation-summary 抽出）。
 * 这是 Copilot 自动 compact 后首请求的判定锚点。
 */
export function isConversationSummaryOnly(
  input: string | readonly string[] | undefined | null
): boolean {
  const parts = toParts(input);
  if (parts.length === 0) return false;
  // 任何 USER_PROMPT_TAG 命中（带配对校验）即返回 false。
  if (extractUserPrompt(parts)) return false;
  // 必须真有 conversation-summary 块（带配对校验）。
  for (const part of parts) {
    const { open, close } = countTag(part, 'conversation-summary');
    if (open >= 1 && open === close) return true;
  }
  if (isCopilotCompressedHistorySummary(parts)) return true;
  return false;
}
