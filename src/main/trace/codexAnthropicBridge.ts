import { createHash, randomUUID } from 'crypto';
import { CodexToolContext, buildCodexToolContext } from './codexChatBridge';
import { compactionItemToChatText } from './codexCompaction';

/**
 * OpenAI Responses <-> Anthropic Messages compatibility for the XwX Gateway.
 *
 * Protocol behavior was studied against the MIT-licensed implementations in
 * farion1231/cc-switch and lidge-jun/opencodex. This is an independent
 * TypeScript implementation built around XwX Deck's existing route and trace
 * model; no AGPL Codex++ source is used.
 */

const THINKING_ENVELOPE_PREFIX = 'xwxa1:';
const DEFAULT_MAX_TOKENS = 8192;
const MAX_CACHE_BREAKPOINTS = 4;
const TOOL_SEARCH_NAME = 'tool_search';
const CACHE_CONTROL = { type: 'ephemeral', ttl: '5m' } as const;

type JsonObject = Record<string, any>;

export interface AnthropicBridgeOptions {
  readonly defaultMaxTokens?: number;
}

export interface AnthropicRequestConversion {
  readonly body: Record<string, unknown>;
  readonly toolContext: CodexToolContext;
}

interface ThinkingEnvelope {
  readonly type: 'thinking' | 'redacted_thinking';
  readonly thinking?: string;
  readonly signature?: string;
  readonly data?: string;
}

interface StreamBlock {
  readonly sourceIndex: number;
  readonly outputIndex: number;
  readonly itemId: string;
  readonly kind: 'text' | 'thinking' | 'tool';
  readonly callId?: string;
  readonly wireName?: string;
  source: JsonObject;
  text: string;
  startInput: unknown;
  closed: boolean;
}

/** Convert a complete Codex Responses request to 兼容服务 Anthropic Messages. */
export function responsesToAnthropicMessages(
  value: unknown,
  options: AnthropicBridgeOptions = {}
): AnthropicRequestConversion {
  const input = object(value);
  const model = text(input.model);
  if (!model) throw new Error('Anthropic Messages route requires a model.');

  const toolContext = buildCodexToolContext(input);
  const system = collectSystemBlocks(input);
  const messages = responsesInputToAnthropicMessages(input.input, toolContext);
  if (!messages.length) throw new Error('Anthropic Messages route requires at least one user message.');
  if (messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: [{ type: 'text', text: '[Conversation resumed]' }] });
  }

  const maxTokens = positiveInt(input.max_output_tokens)
    ?? positiveInt(options.defaultMaxTokens)
    ?? DEFAULT_MAX_TOKENS;
  const result: JsonObject = {
    model,
    messages,
    max_tokens: maxTokens,
    stream: input.stream === true
  };
  if (system.length) result.system = system;

  const tools = toolContext.chatTools().map(chatToolToAnthropic).filter((item): item is JsonObject => !!item);
  if (tools.length) {
    result.tools = tools;
    const choice = toolChoiceToAnthropic(input.tool_choice, toolContext);
    if (choice) result.tool_choice = choice;
    if (input.parallel_tool_calls === false) {
      result.tool_choice = { ...(object(result.tool_choice).type ? object(result.tool_choice) : { type: 'auto' }), disable_parallel_tool_use: true };
    }
  }

  let thinkingEnabled = applyThinking(result, input, model, maxTokens);
  const forcedToolChoice = ['any', 'tool'].includes(text(object(result.tool_choice).type));
  if (thinkingEnabled && forcedToolChoice) {
    // Anthropic rejects forced tool choice while thinking is enabled. Preserve
    // the client's explicit tool contract and disable thinking for this turn.
    delete result.thinking;
    delete result.output_config;
    thinkingEnabled = false;
  }
  if (!thinkingEnabled) {
    if (typeof input.temperature === 'number') result.temperature = input.temperature;
    if (typeof input.top_p === 'number') result.top_p = input.top_p;
  }
  if (Array.isArray(input.stop)) result.stop_sequences = input.stop.filter((item: unknown) => typeof item === 'string');
  else if (typeof input.stop === 'string') result.stop_sequences = [input.stop];
  const userId = text(object(input.metadata).user_id);
  if (userId) result.metadata = { user_id: userId };

  applyPromptCacheBreakpoints(result);
  return { body: result, toolContext };
}

/** Convert one complete Anthropic message (including HTTP-2xx error envelopes). */
export function anthropicMessageToResponse(
  value: unknown,
  fallbackModel: string,
  context: CodexToolContext = new CodexToolContext()
): Record<string, unknown> {
  const message = object(value);
  if (message.type === 'error' || message.error !== undefined) {
    return failedResponseFromAnthropicError(message, fallbackModel);
  }
  const responseId = responsesId(text(message.id));
  const output: JsonObject[] = [];
  for (const raw of array(message.content)) {
    const block = object(raw);
    switch (text(block.type)) {
      case 'text': {
        if (!text(block.text)) break;
        output.push(messageItem(responsesMessageId(responseId, output.length), text(block.text), 'completed'));
        break;
      }
      case 'thinking':
      case 'redacted_thinking': {
        const item = reasoningItem(`rs_${responseId}_${output.length}`, block);
        if (item) output.push(item);
        break;
      }
      case 'tool_use': {
        output.push(toolItemFromAnthropic(
          text(block.id) || `call_${output.length}`,
          text(block.name),
          JSON.stringify(isObject(block.input) ? block.input : {}),
          'completed',
          context
        ));
        break;
      }
      default:
        break;
    }
  }
  const [status, incompleteReason] = mapStopReason(text(message.stop_reason));
  const response: JsonObject = {
    id: responseId,
    object: 'response',
    created_at: 0,
    status,
    model: text(message.model) || fallbackModel,
    output,
    usage: responsesUsageFromAnthropic(message.usage)
  };
  if (incompleteReason) response.incomplete_details = { reason: incompleteReason };
  return response;
}

/**
 * Stateful, chunk-safe Anthropic SSE -> Responses SSE converter.
 * `feed` returns immediately-emittable frames; `finish` rejects unterminated
 * streams with response.failed while retaining partial/incomplete output.
 */
export class AnthropicResponsesStream {
  private readonly decoder = new TextDecoder();
  private pending = '';
  private responseId = responsesId('');
  private model: string;
  private usage: JsonObject | undefined;
  private stopReason: string | undefined;
  private started = false;
  private terminal = false;
  private terminalFailed = false;
  private nextOutputIndex = 0;
  private readonly blocks = new Map<number, StreamBlock>();
  private readonly output: JsonObject[] = [];

  constructor(
    fallbackModel: string,
    private readonly context: CodexToolContext = new CodexToolContext()
  ) {
    this.model = fallbackModel;
  }

  feed(chunk: Buffer | Uint8Array | string): string {
    if (this.terminal) return '';
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  finish(): string {
    if (this.terminal) return '';
    this.pending += this.decoder.decode();
    let out = this.drain(true);
    if (!this.terminal) {
      out += this.fail('Anthropic stream ended before message_stop.', 'upstream_stream_truncated');
    }
    return out;
  }

  isTerminal(): boolean {
    return this.terminal;
  }

  failed(): boolean {
    return this.terminalFailed;
  }

  response(): Record<string, unknown> {
    return this.baseResponse(this.terminalFailed ? 'failed' : mapStopReason(this.stopReason)[0]);
  }

  rawUsage(): Record<string, unknown> | undefined {
    return this.usage ? { ...this.usage } : undefined;
  }

  private drain(flush: boolean): string {
    let out = '';
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.pending);
      if (!match) break;
      const block = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      out += this.processEventBlock(block);
      if (this.terminal) {
        this.pending = '';
        return out;
      }
    }
    if (flush && this.pending.trim()) {
      out += this.processEventBlock(this.pending);
      this.pending = '';
    }
    return out;
  }

  private processEventBlock(block: string): string {
    let eventName = '';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return '';
    let payload: JsonObject;
    try {
      payload = object(JSON.parse(data.join('\n')));
    } catch {
      return this.fail('Anthropic stream contained an incomplete JSON event.', 'invalid_sse_event');
    }
    const type = text(payload.type) || eventName;
    switch (type) {
      case 'message_start':
        return this.onMessageStart(object(payload.message));
      case 'content_block_start':
        return this.onBlockStart(num(payload.index), object(payload.content_block));
      case 'content_block_delta':
        return this.onBlockDelta(num(payload.index), object(payload.delta));
      case 'content_block_stop':
        return this.closeBlock(num(payload.index), false);
      case 'message_delta':
        this.stopReason = text(object(payload.delta).stop_reason) || this.stopReason;
        this.usage = mergeUsage(this.usage, objectOrUndefined(payload.usage));
        return '';
      case 'message_stop':
        return this.complete();
      case 'error': {
        const error = object(payload.error);
        return this.fail(text(error.message) || 'Anthropic upstream error.', text(error.type) || 'upstream_error');
      }
      default:
        return '';
    }
  }

  private onMessageStart(message: JsonObject): string {
    if (text(message.id)) this.responseId = responsesId(text(message.id));
    if (text(message.model)) this.model = text(message.model);
    this.usage = mergeUsage(this.usage, objectOrUndefined(message.usage));
    return this.ensureStarted();
  }

  private ensureStarted(): string {
    if (this.started) return '';
    this.started = true;
    const response = this.baseResponse('in_progress');
    return frame('response.created', { type: 'response.created', response })
      + frame('response.in_progress', { type: 'response.in_progress', response });
  }

  private onBlockStart(sourceIndex: number, block: JsonObject): string {
    let out = this.ensureStarted();
    const outputIndex = this.nextOutputIndex++;
    const type = text(block.type);
    if (type === 'text') {
      const itemId = responsesMessageId(this.responseId, outputIndex);
      const item = { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] };
      this.blocks.set(sourceIndex, {
        sourceIndex, outputIndex, itemId, kind: 'text', source: block, text: text(block.text), startInput: undefined, closed: false
      });
      out += frame('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item });
      out += frame('response.content_part.added', {
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] }
      });
      if (text(block.text)) out += this.textDelta(outputIndex, itemId, text(block.text));
      return out;
    }
    if (type === 'thinking' || type === 'redacted_thinking') {
      const itemId = `rs_${this.responseId}_${outputIndex}`;
      const item = { id: itemId, type: 'reasoning', summary: [] };
      this.blocks.set(sourceIndex, {
        sourceIndex,
        outputIndex,
        itemId,
        kind: 'thinking',
        source: { ...block },
        text: text(block.thinking),
        startInput: undefined,
        closed: false
      });
      out += frame('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item });
      if (type === 'thinking') {
        out += frame('response.reasoning_summary_part.added', {
          type: 'response.reasoning_summary_part.added',
          item_id: itemId,
          output_index: outputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: '' }
        });
        if (text(block.thinking)) out += reasoningDelta(outputIndex, itemId, text(block.thinking));
      }
      return out;
    }
    if (type === 'tool_use') {
      const callId = text(block.id) || `call_${outputIndex}`;
      const wireName = text(block.name);
      const itemId = toolItemId(callId, wireName, this.context);
      const item = toolItemFromAnthropic(callId, wireName, '', 'in_progress', this.context);
      this.blocks.set(sourceIndex, {
        sourceIndex,
        outputIndex,
        itemId,
        kind: 'tool',
        callId,
        wireName,
        source: { ...block },
        text: '',
        startInput: block.input,
        closed: false
      });
      out += frame('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item });
    }
    return out;
  }

  private onBlockDelta(sourceIndex: number, delta: JsonObject): string {
    const block = this.blocks.get(sourceIndex);
    if (!block || block.closed) return '';
    switch (text(delta.type)) {
      case 'text_delta': {
        const value = text(delta.text);
        block.text += value;
        return this.textDelta(block.outputIndex, block.itemId, value);
      }
      case 'thinking_delta':
      case 'reasoning_delta': {
        const value = text(delta.thinking ?? delta.reasoning);
        block.text += value;
        block.source.thinking = block.text;
        return value ? reasoningDelta(block.outputIndex, block.itemId, value) : '';
      }
      case 'signature_delta':
        if (text(delta.signature)) block.source.signature = text(delta.signature);
        return '';
      case 'input_json_delta': {
        const value = text(delta.partial_json);
        block.text += value;
        return value ? toolArgumentsDelta(block, value, this.context) : '';
      }
      default:
        return '';
    }
  }

  private textDelta(outputIndex: number, itemId: string, delta: string): string {
    if (!delta) return '';
    return frame('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      delta
    });
  }

  private closeBlock(sourceIndex: number, incomplete: boolean): string {
    const block = this.blocks.get(sourceIndex);
    if (!block || block.closed) return '';
    block.closed = true;
    if (block.kind === 'text') {
      const item = messageItem(block.itemId, block.text, incomplete ? 'incomplete' : 'completed');
      this.output[block.outputIndex] = item;
      return frame('response.output_text.done', {
        type: 'response.output_text.done',
        item_id: block.itemId,
        output_index: block.outputIndex,
        content_index: 0,
        text: block.text
      }) + frame('response.content_part.done', {
        type: 'response.content_part.done',
        item_id: block.itemId,
        output_index: block.outputIndex,
        content_index: 0,
        part: item.content[0]
      }) + frame('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: block.outputIndex,
        item
      });
    }
    if (block.kind === 'thinking') {
      block.source.thinking = block.text;
      const item = reasoningItem(block.itemId, block.source)
        ?? { id: block.itemId, type: 'reasoning', summary: block.text ? [{ type: 'summary_text', text: block.text }] : [] };
      this.output[block.outputIndex] = item;
      let out = '';
      if (block.source.type === 'thinking') {
        out += frame('response.reasoning_summary_text.done', {
          type: 'response.reasoning_summary_text.done',
          item_id: block.itemId,
          output_index: block.outputIndex,
          summary_index: 0,
          text: block.text
        });
        out += frame('response.reasoning_summary_part.done', {
          type: 'response.reasoning_summary_part.done',
          item_id: block.itemId,
          output_index: block.outputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: block.text }
        });
      }
      return out + frame('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: block.outputIndex,
        item
      });
    }
    const rawArgs = block.text.trim()
      ? block.text
      : isObject(block.startInput) ? JSON.stringify(block.startInput) : '{}';
    const item = toolItemFromAnthropic(
      block.callId || `call_${block.outputIndex}`,
      block.wireName || '',
      canonicalArguments(rawArgs),
      incomplete ? 'incomplete' : 'completed',
      this.context
    );
    this.output[block.outputIndex] = item;
    let out = toolArgumentsDone(block, item, this.context, incomplete);
    out += frame('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: block.outputIndex,
      item
    });
    return out;
  }

  private closeOpenBlocks(incomplete: boolean): string {
    let out = '';
    for (const [index, block] of this.blocks) {
      if (!block.closed) out += this.closeBlock(index, incomplete);
    }
    return out;
  }

  private complete(): string {
    if (this.terminal) return '';
    let out = this.ensureStarted();
    out += this.closeOpenBlocks(false);
    const [status, reason] = mapStopReason(this.stopReason);
    const response = this.baseResponse(status);
    if (reason) response.incomplete_details = { reason };
    out += frame('response.completed', { type: 'response.completed', response });
    out += 'data: [DONE]\n\n';
    this.terminal = true;
    return out;
  }

  private fail(message: string, type: string): string {
    if (this.terminal) return '';
    let out = this.ensureStarted();
    out += this.closeOpenBlocks(true);
    const response = this.baseResponse('failed');
    response.error = { message, type };
    out += frame('response.failed', { type: 'response.failed', response });
    out += frame('error', { type: 'error', error: response.error });
    out += 'data: [DONE]\n\n';
    this.terminal = true;
    this.terminalFailed = true;
    return out;
  }

  private baseResponse(status: string): JsonObject {
    return {
      id: this.responseId,
      object: 'response',
      created_at: 0,
      status,
      model: this.model,
      output: this.output.filter(Boolean),
      usage: responsesUsageFromAnthropic(this.usage)
    };
  }
}

export function responsesUsageFromAnthropic(value: unknown): Record<string, unknown> {
  const usage = object(value);
  const fresh = num(usage.input_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  const inputTokens = fresh + cacheRead + cacheWrite;
  const outputTokens = num(usage.output_tokens);
  const reasoningTokens = num(object(usage.output_tokens_details).thinking_tokens);
  const result: JsonObject = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningTokens }
  };
  if (cacheRead || cacheWrite) {
    result.input_tokens_details = {
      cached_tokens: cacheRead,
      cache_write_tokens: cacheWrite
    };
  }
  return result;
}

export function encodeAnthropicThinkingEnvelope(block: unknown): string | undefined {
  const value = object(block);
  const type = text(value.type);
  if (type === 'thinking') {
    if (!text(value.signature)) return undefined;
    return THINKING_ENVELOPE_PREFIX + Buffer.from(JSON.stringify({
      type,
      thinking: text(value.thinking),
      signature: text(value.signature)
    } satisfies ThinkingEnvelope), 'utf8').toString('base64url');
  }
  if (type === 'redacted_thinking' && text(value.data)) {
    return THINKING_ENVELOPE_PREFIX + Buffer.from(JSON.stringify({
      type,
      data: text(value.data)
    } satisfies ThinkingEnvelope), 'utf8').toString('base64url');
  }
  return undefined;
}

export function decodeAnthropicThinkingEnvelope(value: unknown): ThinkingEnvelope | undefined {
  if (typeof value !== 'string' || !value.startsWith(THINKING_ENVELOPE_PREFIX)) return undefined;
  try {
    const parsed = object(JSON.parse(Buffer.from(value.slice(THINKING_ENVELOPE_PREFIX.length), 'base64url').toString('utf8')));
    if (parsed.type === 'thinking' && text(parsed.signature)) {
      return { type: 'thinking', thinking: text(parsed.thinking), signature: text(parsed.signature) };
    }
    if (parsed.type === 'redacted_thinking' && text(parsed.data)) {
      return { type: 'redacted_thinking', data: text(parsed.data) };
    }
  } catch {
    // Foreign/native Responses encrypted content is intentionally not decoded.
  }
  return undefined;
}

function collectSystemBlocks(body: JsonObject): JsonObject[] {
  const out: JsonObject[] = [];
  for (const value of extractTextValues(body.instructions)) {
    if (value) out.push({ type: 'text', text: value });
  }
  for (const raw of array(body.input)) {
    const item = object(raw);
    if (!['system', 'developer'].includes(text(item.role))) continue;
    for (const value of extractTextValues(item.content)) {
      if (value) out.push({ type: 'text', text: value });
    }
  }
  return out;
}

function responsesInputToAnthropicMessages(value: unknown, context: CodexToolContext): JsonObject[] {
  if (typeof value === 'string') return value ? [{ role: 'user', content: [{ type: 'text', text: value }] }] : [];
  const messages: JsonObject[] = [];
  for (const raw of array(value)) {
    const item = object(raw);
    const itemType = text(item.type);
    const role = text(item.role);
    if (role === 'system' || role === 'developer') continue;
    if (itemType === 'message' || role) {
      const targetRole = role === 'assistant' ? 'assistant' : 'user';
      for (const block of responsesContentToAnthropic(item.content, targetRole)) pushMessageBlock(messages, targetRole, block);
      continue;
    }
    if (itemType === 'reasoning') {
      const envelope = decodeAnthropicThinkingEnvelope(item.encrypted_content);
      if (envelope) pushMessageBlock(messages, 'assistant', envelope);
      continue;
    }
    if (itemType === 'function_call' || itemType === 'custom_tool_call' || itemType === 'tool_search_call') {
      if (item.status === 'incomplete') continue;
      const callId = text(item.call_id) || text(item.id);
      let wireName = text(item.name);
      let input: unknown = {};
      if (itemType === 'function_call') {
        wireName = context.chatNameForResponseFunction(wireName, text(item.namespace) || undefined);
        input = parseArguments(item.arguments);
      } else if (itemType === 'custom_tool_call') {
        input = { input: item.input ?? '' };
      } else {
        wireName = TOOL_SEARCH_NAME;
        input = isObject(item.arguments) ? item.arguments : parseArguments(item.arguments);
      }
      pushMessageBlock(messages, 'assistant', {
        type: 'tool_use',
        id: callId,
        name: wireName,
        input
      });
      continue;
    }
    if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output' || itemType === 'tool_search_output') {
      const content = toolResultContent(item.output ?? item.content ?? item.result);
      const result: JsonObject = {
        type: 'tool_result',
        tool_use_id: text(item.call_id) || text(item.id),
        content
      };
      if (item.is_error === true || item.error !== undefined || item.status === 'failed') result.is_error = true;
      pushMessageBlock(messages, 'user', result);
      continue;
    }
    if (itemType === 'compaction') {
      pushMessageBlock(messages, 'user', {
        type: 'text',
        text: compactionItemToChatText(text(item.encrypted_content))
      });
    }
  }
  return messages.filter(message => array(message.content).length);
}

function responsesContentToAnthropic(value: unknown, role: string): JsonObject[] {
  if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : [];
  const out: JsonObject[] = [];
  for (const raw of array(value)) {
    const part = object(raw);
    switch (text(part.type)) {
      case 'input_text':
      case 'output_text':
      case 'text':
        if (text(part.text)) out.push({ type: 'text', text: text(part.text) });
        break;
      case 'refusal':
        if (text(part.refusal)) out.push({ type: 'text', text: text(part.refusal) });
        break;
      case 'input_image': {
        const image = imageBlock(part);
        if (image) out.push(image);
        break;
      }
      case 'input_file': {
        const document = documentBlock(part);
        if (document) out.push(document);
        break;
      }
      case 'tool_result':
        if (role === 'user') out.push(part);
        break;
      case 'thinking':
      case 'redacted_thinking':
        if (role === 'assistant') out.push(part);
        break;
      default:
        break;
    }
  }
  return out;
}

function pushMessageBlock(messages: JsonObject[], role: 'user' | 'assistant', block: unknown): void {
  const previous = messages.at(-1);
  if (previous?.role === role && Array.isArray(previous.content)) {
    previous.content.push(block);
  } else {
    messages.push({ role, content: [block] });
  }
}

function imageBlock(part: JsonObject): JsonObject | undefined {
  const raw = typeof part.image_url === 'string'
    ? part.image_url
    : text(object(part.image_url).url);
  if (!raw) return undefined;
  const data = parseDataUrl(raw);
  return data
    ? { type: 'image', source: { type: 'base64', media_type: data.mediaType, data: data.data } }
    : { type: 'image', source: { type: 'url', url: raw } };
}

function documentBlock(part: JsonObject): JsonObject | undefined {
  const fileData = text(part.file_data);
  const fileUrl = text(part.file_url ?? part.url);
  const filename = text(part.filename);
  if (fileData) {
    const parsed = parseDataUrl(fileData);
    return {
      type: 'document',
      source: parsed
        ? { type: 'base64', media_type: parsed.mediaType, data: parsed.data }
        : { type: 'base64', media_type: filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/plain', data: fileData },
      ...(filename ? { title: filename } : {})
    };
  }
  if (fileUrl) {
    return { type: 'document', source: { type: 'url', url: fileUrl }, ...(filename ? { title: filename } : {}) };
  }
  if (text(part.file_id)) {
    return { type: 'text', text: `[Unresolved client file reference: ${text(part.file_id)}]` };
  }
  return undefined;
}

function parseDataUrl(value: string): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(value);
  return match ? { mediaType: match[1], data: match[2] } : undefined;
}

function toolResultContent(value: unknown): unknown {
  if (typeof value === 'string') return value || '(empty tool output)';
  if (Array.isArray(value)) {
    const blocks = responsesContentToAnthropic(value, 'user');
    return blocks.length ? blocks : '(empty tool output)';
  }
  if (value === undefined || value === null) return '(empty tool output)';
  return JSON.stringify(value);
}

function chatToolToAnthropic(value: unknown): JsonObject | undefined {
  const fn = object(object(value).function);
  const name = text(fn.name);
  if (!name) return undefined;
  const schema = isObject(fn.parameters) ? { ...fn.parameters } : { type: 'object', properties: {} };
  if (schema.type !== 'object') schema.type = 'object';
  return {
    name,
    ...(text(fn.description) ? { description: text(fn.description) } : {}),
    input_schema: schema,
    ...(typeof fn.strict === 'boolean' ? { strict: fn.strict } : {})
  };
}

function toolChoiceToAnthropic(value: unknown, context: CodexToolContext): JsonObject | undefined {
  if (typeof value === 'string') {
    if (value === 'required') return { type: 'any' };
    if (value === 'none') return { type: 'none' };
    return { type: 'auto' };
  }
  const choice = object(value);
  if (!Object.keys(choice).length) return undefined;
  if (choice.type === 'function') {
    return { type: 'tool', name: context.chatNameForResponseFunction(text(choice.name), text(choice.namespace) || undefined) };
  }
  if (choice.type === 'custom') return { type: 'tool', name: text(choice.name) };
  if (choice.type === 'tool_search') return { type: 'tool', name: TOOL_SEARCH_NAME };
  return { type: 'auto' };
}

function applyThinking(result: JsonObject, input: JsonObject, model: string, maxTokens: number): boolean {
  const effort = text(object(input.reasoning).effort).toLowerCase();
  if (!effort || ['none', 'off', 'disabled'].includes(effort)) return false;
  const normalizedEffort = effort === 'minimal'
    ? 'low'
    : ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
      ? effort
      : 'medium';
  if (supportsNativeEffort(model)) {
    result.output_config = { effort: normalizedEffort };
    if (!usesAdaptiveThinking(model)) return false;
    result.thinking = { type: 'adaptive' };
    return true;
  }
  if (usesAdaptiveThinking(model)) {
    result.thinking = { type: 'adaptive' };
    result.output_config = { effort: normalizedEffort };
    return true;
  }
  const requested = thinkingBudget(effort);
  const budget = Math.min(requested, Math.floor(maxTokens / 2));
  if (budget < 1024) return false;
  result.thinking = { type: 'enabled', budget_tokens: budget };
  return true;
}

function thinkingBudget(effort: string): number {
  if (effort === 'minimal') return 1024;
  if (effort === 'low') return 4096;
  if (effort === 'high') return 16384;
  if (effort === 'xhigh') return 24576;
  if (effort === 'max') return 32000;
  return 8192;
}

function supportsNativeEffort(model: string): boolean {
  const value = model.toLowerCase();
  if (/claude-(?:fable|mythos)-5(?:[.-]|$)/.test(value)) return true;
  const version = claudeVersion(value);
  if (!version) return false;
  return version.major > 4 || (version.major === 4 && version.minor >= 6);
}

function usesAdaptiveThinking(model: string): boolean {
  const value = model.toLowerCase();
  if (/claude-fable-/.test(value)) return true;
  const version = claudeVersion(value);
  if (!version) return false;
  return version.family === 'sonnet'
    ? version.major >= 5
    : version.major > 4 || (version.major === 4 && version.minor >= 7);
}

/**
 * Both `claude-opus-4-7` and `claude-opus-4.7` reach the bridge: catalog rows
 * use the hyphen spelling while some registry ids keep the dotted one. Parse
 * the generation once so the native-effort and adaptive-thinking rules cannot
 * disagree about which model they are looking at.
 */
function claudeVersion(value: string): { family: 'sonnet' | 'opus'; major: number; minor: number } | undefined {
  const match = /claude-(sonnet|opus)-(\d+)(?:[.-](\d{1,2}))?/.exec(value);
  if (!match) return undefined;
  return { family: match[1] as 'sonnet' | 'opus', major: Number(match[2]), minor: Number(match[3] ?? 0) };
}

function applyPromptCacheBreakpoints(body: JsonObject): void {
  let used = 0;
  const markLast = (blocks: unknown): boolean => {
    if (!Array.isArray(blocks) || !blocks.length || used >= MAX_CACHE_BREAKPOINTS) return false;
    const index = blocks.length - 1;
    if (!isObject(blocks[index])) return false;
    blocks[index] = { ...blocks[index], cache_control: { ...CACHE_CONTROL } };
    used++;
    return true;
  };
  markLast(body.tools);
  markLast(body.system);
  const userMessages = array(body.messages).filter(message => object(message).role === 'user');
  const stable = userMessages.slice(-2);
  for (const message of stable) {
    if (used >= MAX_CACHE_BREAKPOINTS) break;
    const content = array(object(message).content);
    let index = content.length - 1;
    while (index >= 0 && object(content[index]).type !== 'text') index--;
    if (index < 0) index = content.length - 1;
    if (index >= 0 && isObject(content[index])) {
      content[index] = { ...content[index], cache_control: { ...CACHE_CONTROL } };
      object(message).content = content;
      used++;
    }
  }
}

function reasoningItem(id: string, block: JsonObject): JsonObject | undefined {
  const encrypted = encodeAnthropicThinkingEnvelope(block);
  const summaryText = block.type === 'thinking' ? text(block.thinking) : '';
  if (!encrypted && !summaryText) return undefined;
  return {
    id,
    type: 'reasoning',
    summary: summaryText ? [{ type: 'summary_text', text: summaryText }] : [],
    ...(encrypted ? { encrypted_content: encrypted } : {})
  };
}

function messageItem(id: string, value: string, status: string): JsonObject {
  return {
    id,
    type: 'message',
    status,
    role: 'assistant',
    content: [{ type: 'output_text', text: value, annotations: [] }]
  };
}

function responsesMessageId(responseId: string, outputIndex: number): string {
  const digest = createHash('sha256')
    .update(`${responseId}\u0000message\u0000${outputIndex}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `msg_xwx_${digest}`;
}

function toolItemId(callId: string, wireName: string, context: CodexToolContext): string {
  const spec = context.lookupChatName(wireName);
  if (spec?.kind === 'custom') return `ctc_${callId}`;
  if (spec?.kind === 'tool_search') return `ts_${callId}`;
  return `fc_${callId}`;
}

function toolItemFromAnthropic(
  callId: string,
  wireName: string,
  args: string,
  status: string,
  context: CodexToolContext
): JsonObject {
  const spec = context.lookupChatName(wireName);
  if (spec?.kind === 'custom') {
    return {
      id: `ctc_${callId}`,
      type: 'custom_tool_call',
      status,
      call_id: callId,
      name: spec.name,
      input: customInput(args)
    };
  }
  if (spec?.kind === 'tool_search') {
    return {
      id: `ts_${callId}`,
      type: 'tool_search_call',
      status,
      call_id: callId,
      execution: 'client',
      arguments: parseArguments(args)
    };
  }
  return {
    id: `fc_${callId}`,
    type: 'function_call',
    status,
    call_id: callId,
    name: spec?.name || wireName,
    arguments: canonicalArguments(args),
    ...(spec?.namespace ? { namespace: spec.namespace } : {})
  };
}

function toolArgumentsDelta(block: StreamBlock, delta: string, context: CodexToolContext): string {
  const spec = context.lookupChatName(block.wireName || '');
  if (spec?.kind === 'custom') {
    // Custom tools are represented on the Messages wire as a JSON wrapper
    // (`{"input":"..."}`). Do not leak those wrapper bytes as Codex input.
    return '';
  }
  return frame('response.function_call_arguments.delta', {
    type: 'response.function_call_arguments.delta',
    item_id: block.itemId,
    output_index: block.outputIndex,
    delta
  });
}

function toolArgumentsDone(
  block: StreamBlock,
  item: JsonObject,
  context: CodexToolContext,
  incomplete: boolean
): string {
  if (incomplete) return '';
  const spec = context.lookupChatName(block.wireName || '');
  if (spec?.kind === 'custom') {
    const input = typeof item.input === 'string' ? item.input : String(item.input ?? '');
    return frame('response.custom_tool_call_input.delta', {
      type: 'response.custom_tool_call_input.delta',
      item_id: block.itemId,
      output_index: block.outputIndex,
      delta: input
    }) + frame('response.custom_tool_call_input.done', {
      type: 'response.custom_tool_call_input.done',
      item_id: block.itemId,
      output_index: block.outputIndex,
      input
    });
  }
  return frame('response.function_call_arguments.done', {
    type: 'response.function_call_arguments.done',
    item_id: block.itemId,
    output_index: block.outputIndex,
    arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})
  });
}

function reasoningDelta(outputIndex: number, itemId: string, delta: string): string {
  return frame('response.reasoning_summary_text.delta', {
    type: 'response.reasoning_summary_text.delta',
    item_id: itemId,
    output_index: outputIndex,
    summary_index: 0,
    delta
  });
}

function failedResponseFromAnthropicError(value: JsonObject, fallbackModel: string): JsonObject {
  const source = object(value.error);
  const message = text(source.message) || text(value.message) || 'Anthropic upstream error.';
  return {
    id: responsesId(''),
    object: 'response',
    created_at: 0,
    status: 'failed',
    model: fallbackModel,
    output: [],
    usage: responsesUsageFromAnthropic(undefined),
    error: { message, type: text(source.type) || text(value.type) || 'upstream_error' }
  };
}

function mapStopReason(reason: string | undefined): [string, string | undefined] {
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return ['incomplete', 'max_output_tokens'];
  if (reason === 'refusal' || reason === 'content_filter') return ['incomplete', 'content_filter'];
  return ['completed', undefined];
}

function mergeUsage(base: JsonObject | undefined, next: JsonObject | undefined): JsonObject | undefined {
  return next ? { ...(base ?? {}), ...next } : base;
}

function extractTextValues(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (Array.isArray(value)) {
    return value.flatMap(item => {
      if (typeof item === 'string') return item.trim() ? [item] : [];
      const part = object(item);
      return text(part.text).trim() ? [text(part.text)] : [];
    });
  }
  const record = object(value);
  return text(record.text).trim() ? [text(record.text)] : [];
}

function parseArguments(value: unknown): JsonObject {
  if (isObject(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : { input: parsed };
  } catch {
    throw new Error('Tool call arguments are not a complete JSON object.');
  }
}

function canonicalArguments(value: unknown): string {
  if (typeof value !== 'string') return JSON.stringify(isObject(value) ? value : {});
  if (!value.trim()) return '{}';
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value;
  }
}

function customInput(value: string): string {
  try {
    const parsed = JSON.parse(value);
    if (isObject(parsed) && typeof parsed.input === 'string') return parsed.input;
  } catch {
    // Keep the raw input for a malformed/truncated custom tool call.
  }
  return value;
}

function responsesId(value: string): string {
  if (value.startsWith('resp_')) return value;
  return `resp_${value || randomUUID().replace(/-/g, '')}`;
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function object(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function objectOrUndefined(value: unknown): JsonObject | undefined {
  return isObject(value) ? value : undefined;
}

function array(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export const __test = {
  applyPromptCacheBreakpoints,
  mapStopReason,
  thinkingBudget,
  usesAdaptiveThinking
};
