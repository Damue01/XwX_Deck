import { randomUUID } from 'crypto';
import {
  chatCompletionToResponse,
  responsesToChatCompletions,
  supportsReasoningEffort
} from './codexChatBridge';

/**
 * Claude clients (Claude Code / Claude Desktop) speak Anthropic Messages only.
 * This bridge lets them use models the selected service publishes solely over
 * OpenAI Responses or Chat Completions. It runs only inside the local Gateway,
 * which is why those models need Trace.
 *
 * Request: Messages → a Responses-shaped request (the common intermediate).
 * Responses upstreams receive it directly; Chat upstreams receive it through
 * the existing Responses → Chat bridge, so reasoning/tool rules stay shared.
 *
 * Response: Responses / Chat (JSON or SSE) → Anthropic message / Anthropic SSE.
 * Text streams live; a tool_use block is emitted once its arguments are
 * complete. Reasoning is not surfaced as a thinking block: a Claude thinking
 * block needs an Anthropic signature, and a forged one breaks the conversation
 * as soon as the user switches back to a native Claude model.
 */

type JsonObject = Record<string, any>;

export type ClaudeBridgeWireProtocol = 'responses' | 'chat-completions';

export interface ClaudeMessagesBridgeOptions {
  readonly wireProtocol: ClaudeBridgeWireProtocol;
  /** Upstream per-model output ceiling from the service catalog. */
  readonly maxOutputTokens?: number;
  readonly upstreamBaseUrl?: string;
  readonly compatibleServiceGateway?: boolean;
}

const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:';

// ---------------------------------------------------------------------------
// Request: Anthropic Messages → Responses / Chat Completions
// ---------------------------------------------------------------------------

export function anthropicMessagesToUpstream(
  value: unknown,
  options: ClaudeMessagesBridgeOptions
): Record<string, unknown> {
  const intermediate = anthropicMessagesToResponsesRequest(value, options);
  if (options.wireProtocol === 'responses') {
    const body: JsonObject = { ...intermediate };
    delete body.stop;
    const effort = text(object(body.reasoning).effort);
    if (!effort || effort === 'none' || !supportsReasoningEffort(text(body.model))) delete body.reasoning;
    if (Array.isArray(body.tools)) body.tools = body.tools.map((tool: JsonObject) => ({ ...tool, strict: false }));
    body.store = false;
    return body;
  }
  const chat: JsonObject = responsesToChatCompletions(intermediate, {
    upstreamBaseUrl: options.upstreamBaseUrl,
    useVerifiedCompatibleServiceReasoningProfile: options.compatibleServiceGateway === true
  });
  if (Array.isArray(chat.messages)) chat.messages = mergeAssistantTurns(chat.messages);
  if (chat.reasoning_effort === 'none') delete chat.reasoning_effort;
  if (usesMaxCompletionTokens(text(chat.model)) && chat.max_tokens !== undefined) {
    if (chat.max_completion_tokens === undefined) chat.max_completion_tokens = chat.max_tokens;
    delete chat.max_tokens;
  }
  return chat;
}

/** Messages request expressed as a Responses request (shared by both wires). */
export function anthropicMessagesToResponsesRequest(
  value: unknown,
  options: ClaudeMessagesBridgeOptions
): Record<string, unknown> {
  const body = object(value);
  const model = text(body.model);
  const result: JsonObject = {};
  if (body.model !== undefined) result.model = body.model;

  const instructions = systemText(body.system);
  if (instructions) result.instructions = instructions;
  result.input = messagesToResponsesInput(body.messages, options.wireProtocol);

  const requested = positiveInt(body.max_tokens);
  const ceiling = positiveInt(options.maxOutputTokens);
  const maxTokens = requested && ceiling ? Math.min(requested, ceiling) : requested ?? ceiling;
  if (maxTokens) result.max_output_tokens = maxTokens;

  const reasoningModel = supportsReasoningEffort(model);
  if (!reasoningModel) {
    if (typeof body.temperature === 'number') result.temperature = body.temperature;
    if (typeof body.top_p === 'number') result.top_p = body.top_p;
  }
  if (body.stream === true) result.stream = true;
  const stops = array(body.stop_sequences).filter(item => typeof item === 'string' && item);
  if (stops.length) result.stop = stops.slice(0, 4);

  const effort = requestedEffort(body);
  if (effort) result.reasoning = { effort };

  const tools = array(body.tools).map(anthropicToolToResponses).filter((tool): tool is JsonObject => !!tool);
  if (tools.length) {
    result.tools = tools;
    const choice = anthropicToolChoiceToResponses(body.tool_choice, tools);
    if (choice !== undefined) result.tool_choice = choice;
    if (object(body.tool_choice).disable_parallel_tool_use === true) result.parallel_tool_calls = false;
  }
  return result;
}

function systemText(value: unknown): string {
  if (typeof value === 'string') return value;
  return array(value)
    .map(block => text(object(block).text))
    // Claude Code's first system block is an attribution header for Anthropic
    // billing; it is not an instruction for another vendor's model.
    .filter(value => value && !value.trimStart().toLowerCase().startsWith(BILLING_HEADER_PREFIX))
    .join('\n\n');
}

function messagesToResponsesInput(value: unknown, wire: ClaudeBridgeWireProtocol): JsonObject[] {
  const input: JsonObject[] = [];
  for (const raw of array(value)) {
    const message = object(raw);
    const role = text(message.role) === 'assistant' ? 'assistant' : 'user';
    const blocks = typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : array(message.content).map(object);
    if (role === 'assistant') appendAssistantBlocks(input, blocks, wire);
    else appendUserBlocks(input, blocks);
  }
  return input;
}

function appendAssistantBlocks(input: JsonObject[], blocks: JsonObject[], wire: ClaudeBridgeWireProtocol): void {
  const reasoning: string[] = [];
  const parts: JsonObject[] = [];
  const calls: JsonObject[] = [];
  for (const block of blocks) {
    switch (text(block.type)) {
      case 'text':
        if (text(block.text)) parts.push({ type: 'output_text', text: block.text });
        break;
      case 'thinking':
        if (text(block.thinking).trim()) reasoning.push(text(block.thinking));
        break;
      case 'tool_use':
        calls.push({
          type: 'function_call',
          call_id: text(block.id) || `call_${randomUUID()}`,
          name: text(block.name),
          arguments: JSON.stringify(block.input ?? {})
        });
        break;
      default:
        // redacted_thinking and server-tool blocks have no portable meaning.
        break;
    }
  }
  // Chat providers such as DeepSeek/Kimi require the prior reasoning next to a
  // tool call; Responses reasoning items need an encrypted payload we do not have.
  if (wire === 'chat-completions' && reasoning.length) {
    input.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning.join('\n\n') }] });
  }
  if (parts.length) input.push({ type: 'message', role: 'assistant', content: parts });
  input.push(...calls);
}

function appendUserBlocks(input: JsonObject[], blocks: JsonObject[]): void {
  const outputs: JsonObject[] = [];
  const toolParts: JsonObject[] = [];
  const parts: JsonObject[] = [];
  for (const block of blocks) {
    switch (text(block.type)) {
      case 'text':
        if (text(block.text)) parts.push({ type: 'input_text', text: block.text });
        break;
      case 'image': {
        const image = imagePart(block);
        if (image) parts.push(image);
        break;
      }
      case 'document':
        parts.push(...documentParts(block));
        break;
      case 'tool_result': {
        const result = toolResult(block);
        outputs.push({ type: 'function_call_output', call_id: text(block.tool_use_id), output: result.output });
        toolParts.push(...result.media);
        break;
      }
      default:
        break;
    }
  }
  input.push(...outputs);
  const content = [...toolParts, ...parts];
  if (content.length) input.push({ type: 'message', role: 'user', content });
}

function toolResult(block: JsonObject): { output: string; media: JsonObject[] } {
  const texts: string[] = [];
  const media: JsonObject[] = [];
  if (typeof block.content === 'string') texts.push(block.content);
  for (const raw of array(block.content)) {
    const part = object(raw);
    const type = text(part.type);
    if (type === 'text' && text(part.text)) texts.push(part.text);
    else if (type === 'image') {
      const image = imagePart(part);
      if (image) media.push(image);
    } else if (type === 'document') media.push(...documentParts(part));
  }
  if (media.length) {
    // Function outputs are text-only on Chat; carry media in the next user turn.
    media.unshift({ type: 'input_text', text: `[Attachment returned by tool call ${text(block.tool_use_id)}]` });
  }
  let output = texts.join('\n');
  if (block.is_error === true) output = output ? `Error: ${output}` : 'Error';
  return { output, media };
}

function imagePart(block: JsonObject): JsonObject | undefined {
  const source = object(block.source);
  const kind = text(source.type);
  if (kind === 'base64' && text(source.data)) {
    return { type: 'input_image', image_url: `data:${text(source.media_type) || 'image/png'};base64,${source.data}`, detail: 'auto' };
  }
  if (kind === 'url' && text(source.url)) return { type: 'input_image', image_url: source.url, detail: 'auto' };
  return undefined;
}

function documentParts(block: JsonObject): JsonObject[] {
  const source = object(block.source);
  const title = text(block.title);
  switch (text(source.type)) {
    case 'text':
      return text(source.data) ? [{ type: 'input_text', text: title ? `${title}\n\n${source.data}` : source.data }] : [];
    case 'content':
      return array(source.content).map(object).flatMap(part => (
        text(part.type) === 'text' && text(part.text) ? [{ type: 'input_text', text: part.text }]
          : text(part.type) === 'image' ? [imagePart(part)].filter((item): item is JsonObject => !!item)
            : []
      ));
    case 'base64':
      return text(source.data) ? [{
        type: 'input_file',
        filename: title || 'document.pdf',
        file_data: `data:${text(source.media_type) || 'application/pdf'};base64,${source.data}`
      }] : [];
    case 'url':
      return text(source.url) ? [{ type: 'input_file', file_url: source.url }] : [];
    default:
      return [];
  }
}

function anthropicToolToResponses(value: unknown): JsonObject | undefined {
  const tool = object(value);
  const type = text(tool.type);
  // Typed Anthropic tools (web_search_*, bash_*, text_editor_*, …) run on
  // Anthropic's side or need Anthropic-specific schemas; other vendors cannot run them.
  if (type && type !== 'custom') return undefined;
  const name = text(tool.name).trim();
  if (!name) return undefined;
  const parameters: JsonObject = isObject(tool.input_schema) ? { ...tool.input_schema } : { type: 'object', properties: {} };
  delete parameters.$schema;
  const result: JsonObject = { type: 'function', name, parameters };
  if (text(tool.description)) result.description = tool.description;
  return result;
}

function anthropicToolChoiceToResponses(value: unknown, tools: JsonObject[]): unknown {
  const choice = object(value);
  switch (text(choice.type)) {
    case 'auto': return 'auto';
    case 'any': return 'required';
    case 'none': return 'none';
    case 'tool': {
      const name = text(choice.name);
      return tools.some(tool => tool.name === name) ? { type: 'function', name } : 'required';
    }
    default: return undefined;
  }
}

function requestedEffort(body: JsonObject): string | undefined {
  const thinking = object(body.thinking);
  const kind = text(thinking.type);
  if (kind === 'disabled') return 'none';
  const explicit = text(object(body.output_config).effort).toLowerCase();
  if (explicit) return normalizeEffort(explicit);
  if (kind === 'enabled') {
    const budget = positiveInt(thinking.budget_tokens) ?? 0;
    if (budget <= 4096) return 'low';
    if (budget <= 16384) return 'medium';
    return 'high';
  }
  if (kind === 'adaptive') return 'medium';
  return undefined;
}

function normalizeEffort(value: string): string | undefined {
  if (value === 'max' || value === 'xhigh') return 'high';
  return ['minimal', 'low', 'medium', 'high'].includes(value) ? value : undefined;
}

const TOOL_CALL_REASONING_PLACEHOLDER = 'tool call';

/**
 * One Anthropic assistant turn (text + tool_use) comes out of the shared
 * Responses → Chat converter as two assistant messages, with the reasoning on
 * the text half. Chat providers expect a single message whose reasoning sits
 * next to its tool calls (DeepSeek/Kimi reject the split form), so rejoin them.
 */
function mergeAssistantTurns(messages: JsonObject[]): JsonObject[] {
  const merged: JsonObject[] = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous?.role === 'assistant' && message.role === 'assistant'
      && !Array.isArray(previous.tool_calls) && Array.isArray(message.tool_calls)
      && (message.content === null || message.content === undefined || message.content === '')) {
      const reasoning = [previous.reasoning_content, message.reasoning_content]
        .filter((value): value is string => typeof value === 'string' && !!value.trim())
        .filter((value, _index, all) => value !== TOOL_CALL_REASONING_PLACEHOLDER || all.length === 1);
      const joined: JsonObject = { ...previous, tool_calls: message.tool_calls };
      if (reasoning.length) joined.reasoning_content = reasoning.join('\n\n');
      merged[merged.length - 1] = joined;
      continue;
    }
    merged.push(message);
  }
  return merged;
}

function usesMaxCompletionTokens(model: string): boolean {
  return /^(?:gpt-[5-9]|o\d)/i.test(model.trim());
}

// ---------------------------------------------------------------------------
// Response (JSON): Responses / Chat → Anthropic message
// ---------------------------------------------------------------------------

export function responsesToAnthropicMessage(value: unknown, fallbackModel: string): Record<string, unknown> {
  const response = object(value);
  const content: JsonObject[] = [];
  let sawTool = false;
  for (const raw of array(response.output)) {
    const item = object(raw);
    switch (text(item.type)) {
      case 'message':
        for (const partRaw of array(item.content)) {
          const part = object(partRaw);
          const value = text(part.type) === 'refusal' ? text(part.refusal) : text(part.text);
          if (value) content.push({ type: 'text', text: value });
        }
        break;
      case 'function_call':
        sawTool = true;
        content.push({
          type: 'tool_use',
          id: text(item.call_id) || text(item.id) || `call_${randomUUID()}`,
          name: text(item.name),
          input: parseArguments(item.arguments)
        });
        break;
      default:
        break;
    }
  }
  return {
    id: anthropicMessageId(text(response.id)),
    type: 'message',
    role: 'assistant',
    model: text(response.model) || fallbackModel,
    content,
    stop_reason: responsesStopReason(response, sawTool),
    stop_sequence: null,
    usage: anthropicUsage(response.usage)
  };
}

export function chatCompletionToAnthropicMessage(value: unknown, fallbackModel: string): Record<string, unknown> {
  return responsesToAnthropicMessage(chatCompletionToResponse(value, fallbackModel), fallbackModel);
}

/** A 2xx upstream body that carries a failure instead of a result. */
export function upstreamFailureMessage(value: unknown): string | undefined {
  const body = object(value);
  if (text(body.status) === 'failed') return text(object(body.error).message) || 'Upstream response failed.';
  if (isObject(body.error) && !Array.isArray(body.choices) && !Array.isArray(body.output)) {
    return text(body.error.message) || 'Upstream returned an error.';
  }
  return undefined;
}

export function isEmptyAnthropicMessage(message: Record<string, unknown>): boolean {
  return array(message.content).length === 0 && message.stop_reason !== 'max_tokens';
}

/** Fold a Responses SSE body into its final response object. */
export function responsesSseToResponse(raw: string): Record<string, unknown> | undefined {
  let final: JsonObject | undefined;
  const items: JsonObject[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
    if (!data || data === '[DONE]') continue;
    let event: JsonObject;
    try { event = object(JSON.parse(data)); } catch { continue; }
    const type = text(event.type);
    if (type === 'response.output_item.done' && isObject(event.item)) items.push(event.item);
    else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') final = object(event.response);
    else if (type === 'error') final = { status: 'failed', error: isObject(event.error) ? event.error : event };
  }
  if (!final) return undefined;
  return array(final.output).length || !items.length ? final : { ...final, output: items };
}

/** A complete Anthropic message rendered as the Messages SSE sequence. */
export function anthropicMessageAsSse(message: Record<string, unknown>): string {
  const writer = new AnthropicSseWriter(text(message.model));
  writer.identify(text(message.id).replace(/^msg_/, ''), text(message.model));
  let out = writer.start();
  for (const raw of array(message.content)) {
    const block = object(raw);
    if (text(block.type) === 'text') out += writer.text(text(block.text));
    else if (text(block.type) === 'tool_use') out += writer.toolUse(text(block.id), text(block.name), JSON.stringify(block.input ?? {}));
  }
  return out + writer.finish(text(message.stop_reason) || 'end_turn', object(message.usage) as Record<string, number>);
}

function responsesStopReason(response: JsonObject, sawTool: boolean): string {
  if (text(response.status) === 'incomplete') {
    return text(object(response.incomplete_details).reason) === 'content_filter' ? 'refusal' : 'max_tokens';
  }
  return sawTool ? 'tool_use' : 'end_turn';
}

function anthropicMessageId(value: string): string {
  const id = value.replace(/^(?:resp_|chatcmpl[-_])/, '');
  return `msg_${id || randomUUID().replace(/-/g, '')}`;
}

/** Responses or Chat usage → Anthropic usage (input excludes cache reads). */
export function anthropicUsage(value: unknown): Record<string, number> {
  const usage = object(value);
  const input = num(usage.input_tokens ?? usage.prompt_tokens);
  const output = num(usage.output_tokens ?? usage.completion_tokens);
  const cached = Math.min(input, num(
    usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? usage.prompt_cache_hit_tokens
  ));
  const result: Record<string, number> = { input_tokens: Math.max(0, input - cached), output_tokens: output };
  if (cached > 0) result.cache_read_input_tokens = cached;
  return result;
}

// ---------------------------------------------------------------------------
// Errors / count_tokens
// ---------------------------------------------------------------------------

export function anthropicErrorBody(status: number, body: unknown): Record<string, unknown> {
  return { type: 'error', error: { type: anthropicErrorType(status), message: upstreamErrorMessage(body, status) } };
}

export function anthropicErrorSse(type: string, message: string): string {
  return frame('error', { type: 'error', error: { type, message } });
}

export function anthropicErrorType(status: number): string {
  if (status === 400 || status === 422) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 402 || status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limit_error';
  if (status === 503 || status === 529) return 'overloaded_error';
  return 'api_error';
}

function upstreamErrorMessage(body: unknown, status: number): string {
  if (typeof body === 'string') return body.trim().slice(0, 2000) || `Upstream returned HTTP ${status}.`;
  const record = object(body);
  const error = record.error;
  if (typeof error === 'string' && error) return error;
  const message = text(object(error).message) || text(record.message) || text(record.detail);
  return message || `Upstream returned HTTP ${status}.`;
}

/** Local estimate: converted routes have no upstream count_tokens endpoint. */
export function estimateAnthropicInputTokens(value: unknown): number {
  const body = object(value);
  const serialized = JSON.stringify([body.system ?? '', body.messages ?? [], body.tools ?? []]);
  let cjk = 0;
  for (const char of serialized) if (/[　-鿿가-힯＀-￯]/.test(char)) cjk += 1;
  return Math.max(1, Math.ceil(cjk + (serialized.length - cjk) / 4));
}

// ---------------------------------------------------------------------------
// Anthropic SSE writer shared by both stream converters
// ---------------------------------------------------------------------------

class AnthropicSseWriter {
  private started = false;
  private blockIndex = -1;
  private openBlock: 'text' | undefined;
  private id = `msg_${randomUUID().replace(/-/g, '')}`;
  terminal = false;

  constructor(private model: string) {}

  identify(id: string, model: string): void {
    if (this.started) return;
    if (id) this.id = anthropicMessageId(id);
    if (model) this.model = model;
  }

  start(): string {
    if (this.started) return '';
    this.started = true;
    return frame('message_start', {
      type: 'message_start',
      message: {
        id: this.id,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
  }

  text(delta: string): string {
    if (!delta || this.terminal) return '';
    let out = this.start();
    if (this.openBlock !== 'text') {
      out += this.close();
      this.blockIndex += 1;
      this.openBlock = 'text';
      out += frame('content_block_start', { type: 'content_block_start', index: this.blockIndex, content_block: { type: 'text', text: '' } });
    }
    return out + frame('content_block_delta', { type: 'content_block_delta', index: this.blockIndex, delta: { type: 'text_delta', text: delta } });
  }

  toolUse(id: string, name: string, args: string): string {
    if (this.terminal) return '';
    let out = this.start() + this.close();
    this.blockIndex += 1;
    const index = this.blockIndex;
    out += frame('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: id || `call_${randomUUID()}`, name, input: {} }
    });
    const json = canonicalArguments(args);
    if (json !== '{}') {
      out += frame('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } });
    }
    return out + frame('content_block_stop', { type: 'content_block_stop', index });
  }

  finish(stopReason: string, usage: Record<string, number>): string {
    if (this.terminal) return '';
    const out = this.start() + this.close();
    this.terminal = true;
    return out
      + frame('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage })
      + frame('message_stop', { type: 'message_stop' });
  }

  fail(type: string, message: string): string {
    if (this.terminal) return '';
    this.terminal = true;
    return anthropicErrorSse(type, message);
  }

  private close(): string {
    if (this.openBlock === undefined) return '';
    this.openBlock = undefined;
    return frame('content_block_stop', { type: 'content_block_stop', index: this.blockIndex });
  }
}

abstract class SseLineStream {
  private readonly decoder = new TextDecoder();
  private pending = '';
  protected readonly writer: AnthropicSseWriter;
  protected usage: JsonObject | undefined;

  constructor(model: string) {
    this.writer = new AnthropicSseWriter(model);
  }

  feed(chunk: Buffer | Uint8Array | string): string {
    if (this.writer.terminal) return '';
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  finish(): string {
    if (this.writer.terminal) return '';
    this.pending += this.decoder.decode();
    const out = this.drain(true);
    return out + (this.writer.terminal ? '' : this.end());
  }

  rawUsage(): Record<string, unknown> | undefined {
    return this.usage ? { ...this.usage } : undefined;
  }

  private drain(flush: boolean): string {
    let out = '';
    while (!this.writer.terminal) {
      const match = /\r?\n\r?\n/.exec(this.pending);
      if (!match) break;
      const block = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      out += this.block(block);
    }
    if (flush && !this.writer.terminal && this.pending.trim()) {
      out += this.block(this.pending);
      this.pending = '';
    }
    if (this.writer.terminal) this.pending = '';
    return out;
  }

  private block(raw: string): string {
    let eventName = '';
    const data: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    const payload = data.join('\n').trim();
    if (!payload) return '';
    if (payload === '[DONE]') return this.done();
    let parsed: JsonObject;
    try {
      parsed = object(JSON.parse(payload));
    } catch {
      return this.writer.fail('api_error', 'Upstream stream contained an incomplete JSON event.');
    }
    return this.event(eventName, parsed);
  }

  protected abstract event(name: string, payload: JsonObject): string;
  protected abstract done(): string;
  /** Upstream closed without a terminal event. */
  protected abstract end(): string;
}

// ---------------------------------------------------------------------------
// Stream: Responses SSE → Anthropic SSE
// ---------------------------------------------------------------------------

export class ResponsesToAnthropicStream extends SseLineStream {
  private sawTool = false;
  private readonly textItems = new Set<string>();
  private readonly toolItems = new Set<string>();

  constructor(fallbackModel: string) {
    super(fallbackModel);
  }

  protected event(name: string, payload: JsonObject): string {
    const type = text(payload.type) || name;
    switch (type) {
      case 'response.created':
      case 'response.in_progress': {
        const response = object(payload.response);
        this.writer.identify(text(response.id), text(response.model));
        return this.writer.start();
      }
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        if (text(payload.item_id)) this.textItems.add(text(payload.item_id));
        return this.writer.text(text(payload.delta));
      case 'response.output_item.done':
        return this.itemDone(object(payload.item));
      case 'response.completed':
      case 'response.incomplete':
        return this.complete(object(payload.response));
      case 'response.failed': {
        const error = object(object(payload.response).error);
        return this.writer.fail('api_error', text(error.message) || 'Upstream response failed.');
      }
      case 'error': {
        const error = isObject(payload.error) ? payload.error : payload;
        return this.writer.fail('api_error', text(error.message) || 'Upstream stream error.');
      }
      default:
        return '';
    }
  }

  private itemDone(item: JsonObject): string {
    const id = text(item.id) || text(item.call_id);
    if (text(item.type) === 'function_call') {
      if (id && this.toolItems.has(id)) return '';
      if (id) this.toolItems.add(id);
      this.sawTool = true;
      return this.writer.toolUse(text(item.call_id) || id, text(item.name), text(item.arguments));
    }
    if (text(item.type) === 'message' && !(id && this.textItems.has(id))) {
      // Some gateways send only whole items; render their text once.
      if (id) this.textItems.add(id);
      return array(item.content).map(object)
        .map(part => this.writer.text(text(part.type) === 'refusal' ? text(part.refusal) : text(part.text)))
        .join('');
    }
    return '';
  }

  private complete(response: JsonObject): string {
    this.usage = isObject(response.usage) ? response.usage : this.usage;
    this.writer.identify(text(response.id), text(response.model));
    let out = '';
    for (const item of array(response.output)) out += this.itemDone(object(item));
    return out + this.writer.finish(responsesStopReason(response, this.sawTool), anthropicUsage(this.usage));
  }

  protected done(): string {
    return this.end();
  }

  protected end(): string {
    return this.writer.fail('api_error', 'Upstream stream ended before the response completed.');
  }
}

// ---------------------------------------------------------------------------
// Stream: Chat Completions SSE → Anthropic SSE
// ---------------------------------------------------------------------------

export class ChatToAnthropicStream extends SseLineStream {
  private finishReason: string | undefined;
  private readonly calls = new Map<number, { id: string; name: string; arguments: string }>();
  private thinkState: 'probe' | 'thinking' | 'pass' = 'probe';
  private buffered = '';

  constructor(fallbackModel: string) {
    super(fallbackModel);
  }

  protected event(_name: string, payload: JsonObject): string {
    if (isObject(payload.error)) {
      return this.writer.fail('api_error', text(payload.error.message) || 'Upstream stream error.');
    }
    this.writer.identify(text(payload.id), text(payload.model));
    let out = this.writer.start();
    if (isObject(payload.usage)) this.usage = payload.usage;
    const choice = object(array(payload.choices)[0]);
    const delta = object(choice.delta);
    out += this.content(text(delta.content));
    for (const raw of array(delta.tool_calls)) {
      const call = object(raw);
      const index = typeof call.index === 'number' ? call.index : 0;
      const known = this.calls.get(index) ?? { id: '', name: '', arguments: '' };
      known.id += text(call.id);
      const fn = object(call.function);
      known.name += text(fn.name);
      known.arguments += text(fn.arguments);
      this.calls.set(index, known);
    }
    if (text(choice.finish_reason)) this.finishReason = text(choice.finish_reason);
    return out;
  }

  /** Leading <think>…</think> blocks are reasoning, not answer text. */
  private content(delta: string): string {
    if (!delta) return '';
    if (this.thinkState === 'pass') return this.writer.text(delta);
    this.buffered += delta;
    if (this.thinkState === 'probe') {
      const head = this.buffered.trimStart();
      if (head.length < '<think>'.length && '<think>'.startsWith(head)) return '';
      if (!head.startsWith('<think>')) return this.release(this.buffered);
      this.thinkState = 'thinking';
    }
    const close = this.buffered.indexOf('</think>');
    if (close < 0) return '';
    return this.release(this.buffered.slice(close + '</think>'.length).replace(/^\s+/, ''));
  }

  private release(value: string): string {
    this.thinkState = 'pass';
    this.buffered = '';
    return this.writer.text(value);
  }

  protected done(): string {
    let out = '';
    if (this.thinkState === 'probe' && this.buffered) out += this.release(this.buffered);
    if (this.thinkState === 'thinking') out += this.release(this.buffered.trimStart().slice('<think>'.length).trimStart());
    const calls = [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call).filter(call => call.name);
    for (const call of calls) out += this.writer.toolUse(call.id, call.name, call.arguments);
    const stop = this.finishReason === 'length' ? 'max_tokens'
      : this.finishReason === 'content_filter' ? 'refusal'
        : calls.length || this.finishReason === 'tool_calls' || this.finishReason === 'function_call' ? 'tool_use'
          : 'end_turn';
    return out + this.writer.finish(stop, anthropicUsage(this.usage));
  }

  protected end(): string {
    // Many OpenAI-compatible services close after finish_reason without [DONE].
    if (this.finishReason) return this.done();
    return this.writer.fail('api_error', 'Upstream stream ended before the response completed.');
  }
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function parseArguments(value: unknown): JsonObject {
  if (isObject(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : { value: parsed };
  } catch {
    return { raw: value };
  }
}

function canonicalArguments(value: string): string {
  return JSON.stringify(parseArguments(value));
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function object(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function array(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
