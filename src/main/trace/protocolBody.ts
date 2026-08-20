import * as http from 'http';

export type HeaderBag = http.IncomingHttpHeaders | Record<string, string | string[] | undefined>;

/** Read an HTTP header without depending on the caller's key casing. */
export function headerValue(headers: unknown, name: string): string {
  if (!headers || typeof headers !== 'object') return '';
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== target) continue;
    if (Array.isArray(value)) return value.map(item => String(item)).join(', ');
    return value === undefined || value === null ? '' : String(value);
  }
  return '';
}

/** Extract text from Anthropic content blocks and OpenAI chat/Responses parts. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    const value = block as Record<string, unknown>;
    if (typeof value.text === 'string') parts.push(value.text);
    else if (typeof value.input_text === 'string') parts.push(value.input_text);
    else if (typeof value.output_text === 'string') parts.push(value.output_text);
  }
  return parts.join('\n');
}

function bodyMessages(body: unknown): unknown[] {
  if (!body || typeof body !== 'object') return [];
  const value = body as Record<string, unknown>;
  return Array.isArray(value.messages)
    ? value.messages
    : Array.isArray(value.input)
      ? value.input
      : [];
}

/** Return every non-empty user message across Messages, Chat, and Responses bodies. */
export function userTexts(body: unknown): string[] {
  const texts: string[] = [];
  for (const item of bodyMessages(body)) {
    if (!item || typeof item !== 'object') continue;
    const message = item as Record<string, unknown>;
    if (message.role !== 'user') continue;
    const text = contentText(message.content);
    if (text.trim()) texts.push(text);
  }
  return texts;
}

/** Return the first non-empty user message across Messages, Chat, and Responses bodies. */
export function firstUserText(body: unknown): string {
  for (const item of bodyMessages(body)) {
    if (!item || typeof item !== 'object') continue;
    const message = item as Record<string, unknown>;
    if (message.role !== 'user') continue;
    const text = contentText(message.content);
    if (text.trim()) return text;
  }
  return '';
}

/** Extract system/developer instructions across Anthropic, Chat, and Responses bodies. */
export function extractSystemText(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const value = body as Record<string, unknown>;
  const parts: string[] = [];
  const system = value.system;
  if (typeof system === 'string') parts.push(system);
  else if (Array.isArray(system)) {
    const text = contentText(system);
    if (text) parts.push(text);
  }
  if (typeof value.instructions === 'string') parts.push(value.instructions);
  const messages = Array.isArray(value.messages)
    ? value.messages
    : Array.isArray(value.input)
      ? value.input
      : [];
  for (const item of messages as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const message = item as Record<string, unknown>;
    if (message.role !== 'system' && message.role !== 'developer') continue;
    const text = contentText(message.content);
    if (text.trim()) parts.push(text);
  }
  return parts.join('\n');
}

/**
 * Codex Desktop 0.144+ negotiates a "responses-lite" variant of the Responses API
 * (header `x-openai-internal-codex-responses-lite: true`) that moves the tool
 * declarations out of the top-level `tools` field and into an `input` history item
 * shaped `{ type: 'additional_tools', role: 'developer', tools: [...] }`.
 *
 * Every reader of tool declarations must go through the helpers below, otherwise it
 * silently sees zero tools on that protocol. Symptoms when a call site is missed:
 * an empty Trace tool list, and — far worse — a bridged request that reaches a
 * third-party model with no tools at all.
 */
const ADDITIONAL_TOOLS_ITEM = 'additional_tools';

/** True for the responses-lite `input` item that carries tool declarations. */
export function isAdditionalToolsItem(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (value as Record<string, unknown>).type === ADDITIONAL_TOOLS_ITEM;
}

/**
 * Tool declarations from a Responses body, across both the classic top-level
 * `tools` field and the responses-lite `additional_tools` input item. Tools loaded
 * later in the turn via `tool_search_output` are NOT included — callers that need
 * those already walk the history separately.
 */
export function collectDeclaredResponsesTools(body: unknown): unknown[] {
  if (!body || typeof body !== 'object') return [];
  const value = body as Record<string, unknown>;
  const tools: unknown[] = [];
  if (Array.isArray(value.tools)) tools.push(...value.tools);
  for (const item of Array.isArray(value.input) ? value.input : []) {
    if (!isAdditionalToolsItem(item)) continue;
    const declared = (item as Record<string, unknown>).tools;
    if (Array.isArray(declared)) tools.push(...declared);
  }
  return tools;
}

/**
 * Rewrite every declared tool list in place-by-copy. Used to drop namespaces an
 * upstream rejects; returns the original reference when `transform` changed nothing
 * so callers can keep forwarding the untouched body.
 */
export function mapDeclaredResponsesTools(
  body: unknown,
  transform: (tools: readonly unknown[]) => unknown[]
): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const value = body as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = { ...value };
  if (Array.isArray(value.tools)) {
    const tools = transform(value.tools);
    if (tools.length !== value.tools.length) { next.tools = tools; changed = true; }
  }
  if (Array.isArray(value.input)) {
    const input = value.input.map(item => {
      if (!isAdditionalToolsItem(item)) return item;
      const declared = (item as Record<string, unknown>).tools;
      if (!Array.isArray(declared)) return item;
      const tools = transform(declared);
      if (tools.length === declared.length) return item;
      changed = true;
      return { ...(item as Record<string, unknown>), tools };
    });
    if (changed) next.input = input;
  }
  return changed ? next : body;
}

/** Drop the responses-lite tool declaration item; pairs with sending `tools: []`. */
export function stripAdditionalToolsItems(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  return input.filter(item => !isAdditionalToolsItem(item));
}

/** Parse JSONL while ignoring blank or malformed historical rows. */
export function parseJsonlLines<T>(source: string | Iterable<string>): T[] {
  const lines = typeof source === 'string' ? source.split(/\r?\n/) : source;
  const values: T[] = [];
  for (const line of lines) {
    const text = String(line || '').trim();
    if (!text) continue;
    try { values.push(JSON.parse(text) as T); }
    catch { /* Ignore malformed rows so one record cannot hide the rest of a session. */ }
  }
  return values;
}
