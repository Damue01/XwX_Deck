import { randomUUID } from 'crypto';
import { stripAdditionalToolsItems } from './protocolBody';

export const XwX_COMPACTION_PREFIX = 'xwxc1:';

export const XwX_COMPACTION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work. Output only the handoff summary.`;

export const XwX_COMPACTION_SUMMARY_PREFIX = 'Another language model started to solve this problem and produced a summary of its work. Continue from this summary without repeating completed work:';
export const OPAQUE_COMPACTION_NOTE = '[Earlier context was compacted by another provider and cannot be decoded by this model.]';

const RETAINED_USER_CHAR_BUDGET = 20_000 * 4;
const SYNTHETIC_COMPACT_MAX_OUTPUT_TOKENS = 4_096;

export function encodeCompactionSummary(summary: string): string {
  return XwX_COMPACTION_PREFIX + Buffer.from(summary, 'utf8').toString('base64');
}

export function decodeCompactionSummary(value: string): string | undefined {
  if (!value.startsWith(XwX_COMPACTION_PREFIX)) return undefined;
  const encoded = value.slice(XwX_COMPACTION_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined;
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return decoded.trim() ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function compactionItemToChatText(encryptedContent: unknown): string {
  const decoded = typeof encryptedContent === 'string' ? decodeCompactionSummary(encryptedContent) : undefined;
  return decoded ? `${XwX_COMPACTION_SUMMARY_PREFIX}\n\n${decoded}` : OPAQUE_COMPACTION_NOTE;
}

export function isCompactionTriggerRequest(value: unknown): boolean {
  const input = record(value).input;
  return Array.isArray(input) && input.length > 0 && record(input[input.length - 1]).type === 'compaction_trigger';
}

/** Build a normal, tool-free Responses request that asks the routed model for a summary. */
export function buildSyntheticCompactionRequest(value: unknown): Record<string, unknown> {
  const source = record(value);
  // `tools: []` only empties the classic field; responses-lite carries its
  // declarations inside `input`, so that item has to go too or the summary turn
  // still ships the full tool catalogue.
  const input = stripAdditionalToolsItems(removeCompactionTriggers(source.input));
  const body: Record<string, unknown> = {
    ...source,
    input,
    instructions: appendInstructions(source.instructions, XwX_COMPACTION_PROMPT),
    stream: false,
    tools: [],
    max_output_tokens: compactOutputLimit(source.max_output_tokens)
  };
  delete body.tool_choice;
  delete body.parallel_tool_calls;
  delete body.context_management;
  return body;
}

export function compactRequestHasUsableInput(value: unknown): boolean {
  const body = record(value);
  const input = removeCompactionTriggers(body.input);
  if (typeof input === 'string') return input.trim().length > 0;
  if (Array.isArray(input)) return input.length > 0;
  return !!input && typeof input === 'object';
}

export function extractResponseSummary(value: unknown): string | undefined {
  const response = record(value);
  if (typeof response.output_text === 'string' && response.output_text.trim()) return response.output_text.trim();
  const chunks: string[] = [];
  for (const rawItem of list(response.output)) {
    const item = record(rawItem);
    if (item.type === 'message') {
      for (const rawPart of list(item.content)) {
        const part = record(rawPart);
        if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') chunks.push(part.text);
      }
    }
  }
  const summary = chunks.join('').trim();
  return summary || undefined;
}

export function buildStandaloneCompactionResponse(
  request: unknown,
  summary: string,
  usage: unknown
): Record<string, unknown> {
  return {
    id: `cmpresp_xwx_${randomUUID().replace(/-/g, '')}`,
    object: 'response.compaction',
    created_at: Math.floor(Date.now() / 1000),
    output: buildCompactV1Output(extractCompactUserMessages(record(request).input), summary),
    usage: normalizedUsage(usage)
  };
}

export function buildRemoteCompactionResponse(
  model: string,
  summary: string,
  usage: unknown
): Record<string, unknown> {
  const responseId = `resp_xwx_compact_${randomUUID().replace(/-/g, '')}`;
  return {
    id: responseId,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output: [{
      id: `cmp_${randomUUID().replace(/-/g, '')}`,
      type: 'compaction',
      encrypted_content: encodeCompactionSummary(summary)
    }],
    usage: normalizedUsage(usage)
  };
}

function removeCompactionTriggers(input: unknown): unknown {
  return Array.isArray(input)
    ? input.filter(item => record(item).type !== 'compaction_trigger')
    : input;
}

function appendInstructions(value: unknown, prompt: string): string {
  const existing = instructionText(value);
  return existing ? `${existing}\n\n${prompt}` : prompt;
}

function instructionText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map(part => typeof part === 'string' ? part : string(record(part).text))
    .filter(Boolean)
    .join('\n\n');
}

function compactOutputLimit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), SYNTHETIC_COMPACT_MAX_OUTPUT_TOKENS)
    : SYNTHETIC_COMPACT_MAX_OUTPUT_TOKENS;
}

function extractCompactUserMessages(input: unknown): string[] {
  if (!Array.isArray(input)) return typeof input === 'string' && input.trim() ? [input] : [];
  const out: string[] = [];
  for (const raw of input) {
    const item = record(raw);
    if (item.type !== undefined && item.type !== 'message') continue;
    if (item.role !== 'user') continue;
    const text = contentText(item.content);
    if (text.trim()) out.push(text);
  }
  return out;
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(raw => {
    const part = record(raw);
    return (part.type === 'input_text' || part.type === 'text') ? string(part.text) : '';
  }).join('');
}

function buildCompactV1Output(userMessages: readonly string[], summary: string): Record<string, unknown>[] {
  const selected: string[] = [];
  let remaining = RETAINED_USER_CHAR_BUDGET;
  for (let index = userMessages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = userMessages[index];
    if (message.length <= remaining) {
      selected.push(message);
      remaining -= message.length;
    } else {
      selected.push(message.slice(message.length - remaining));
      remaining = 0;
    }
  }
  selected.reverse();
  return [
    ...selected.map(compactUserMessage),
    compactUserMessage(`${XwX_COMPACTION_SUMMARY_PREFIX}\n${summary.trim()}`)
  ];
}

function compactUserMessage(text: string): Record<string, unknown> {
  return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] };
}

function normalizedUsage(value: unknown): Record<string, unknown> {
  const usage = record(value);
  const input = number(usage.input_tokens);
  const output = number(usage.output_tokens);
  return {
    input_tokens: input,
    input_tokens_details: {
      cached_tokens: number(record(usage.input_tokens_details).cached_tokens),
      cache_write_tokens: number(record(usage.input_tokens_details).cache_write_tokens)
    },
    output_tokens: output,
    output_tokens_details: {
      reasoning_tokens: number(record(usage.output_tokens_details).reasoning_tokens)
    },
    total_tokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : input + output
  };
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function list(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
