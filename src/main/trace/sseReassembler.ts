import { StringDecoder } from 'string_decoder';
import {
  NormalizedUsage,
  TapApiType,
  TapContentBlock,
  TapResponseSnapshot,
  TapSseEvent,
  TapTimingSnapshot
} from './types';
import { mergeUsage, normalizeUsage } from './normalizeUsage';
import { stripUndefined } from '../shared/obj';
import { safeJsonParse } from '../shared/json';

type MutableBlock = {
  type: TapContentBlock['type'];
  id?: string;
  name?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  input?: unknown;
  rawInput?: string;
  content?: unknown;
  tool_use_id?: string;
  /** Original Anthropic block type when it is not the plain tool_use / tool_result form. */
  wireType?: string;
  serverName?: string;
  isError?: boolean;
  choiceIndex?: number;
  /**
   * web_search 等内置工具的来源标注。流式下走 citations_delta 增量下发，非流式响应则直接挂在
   * text 块上；这里跟非流式形状保持一致，都累积到「归属的那个 text 块」而不是单独开块。
   */
  citations?: unknown[];
};

export class SSEReassembler {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private eventName: string | undefined;
  private dataLines: string[] = [];
  private readonly events: TapSseEvent[] = [];
  private readonly anthropicBlocks = new Map<number, MutableBlock>();
  private readonly openaiToolBlocks = new Map<string, MutableBlock>();
  private readonly responseToolBlocks = new Map<string, MutableBlock>();
  private readonly openaiTextBlocks = new Map<number, MutableBlock>();
  private readonly openaiThinkingBlocks = new Map<number, MutableBlock>();
  private responseTextBlock: MutableBlock | undefined;
  private responseThinkingBlock: MutableBlock | undefined;
  private responseRefusalBlock: MutableBlock | undefined;
  private readonly responseOtherBlocks = new Map<string, MutableBlock>();
  private raw: unknown;
  private rawUsage: Record<string, unknown> | undefined;
  private id: string | undefined;
  private model: string | undefined;
  private role: string | undefined;
  private stopReason: string | undefined;
  private incompleteReason: string | undefined;
  private usage: NormalizedUsage | undefined;
  private firstSseMs: number | undefined;
  private firstThinkingMs: number | undefined;
  private firstTextMs: number | undefined;
  private firstToolMs: number | undefined;

  constructor(private readonly apiType: TapApiType) {}

  feed(chunk: Buffer | string, timestampMs: number): TapSseEvent[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.buffer += text;
    return this.drain(timestampMs, false);
  }

  finish(timestampMs: number): TapSseEvent[] {
    const rest = this.decoder.end();
    if (rest) this.buffer += rest;
    const drained = this.drain(timestampMs, true);
    for (const block of [...this.anthropicBlocks.values(), ...this.openaiToolBlocks.values(), ...this.responseToolBlocks.values()]) {
      finalizeJsonInput(block);
    }
    return drained;
  }

  getEvents(): TapSseEvent[] {
    return [...this.events];
  }

  timing(): TapTimingSnapshot {
    const firstThinkingMs = this.firstThinkingMs;
    const firstTextMs = this.firstTextMs;
    return stripUndefined({
      firstSseMs: this.firstSseMs,
      firstThinkingMs,
      firstTextMs,
      firstToolMs: this.firstToolMs,
      thinkingToTextMs: typeof firstThinkingMs === 'number' && typeof firstTextMs === 'number'
        ? Math.max(0, firstTextMs - firstThinkingMs)
        : undefined
    });
  }

  snapshot(): TapResponseSnapshot {
    const content = this.contentBlocks();
    return stripUndefined({
      apiType: this.apiType,
      id: this.id,
      model: this.model,
      role: this.role,
      content,
      stopReason: this.stopReason,
      incompleteReason: this.incompleteReason,
      usage: this.usage,
      raw: this.raw
    });
  }

  usageRaw(): Record<string, unknown> | undefined {
    return this.rawUsage ? { ...this.rawUsage } : undefined;
  }

  private drain(timestampMs: number, final: boolean): TapSseEvent[] {
    const out: TapSseEvent[] = [];
    while (true) {
      const lineEnd = findLineEnd(this.buffer);
      if (lineEnd < 0) break;
      const rawLine = this.buffer.slice(0, lineEnd);
      const consume = this.buffer[lineEnd] === '\r' && this.buffer[lineEnd + 1] === '\n'
        ? lineEnd + 2
        : lineEnd + 1;
      this.buffer = this.buffer.slice(consume);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      const event = this.handleLine(line, timestampMs);
      if (event) out.push(event);
    }
    if (final && this.buffer.length > 0) {
      const event = this.handleLine(this.buffer, timestampMs);
      this.buffer = '';
      if (event) out.push(event);
      const finalEvent = this.flushEvent(timestampMs);
      if (finalEvent) out.push(finalEvent);
    }
    return out;
  }

  private handleLine(line: string, timestampMs: number): TapSseEvent | undefined {
    if (line === '') return this.flushEvent(timestampMs);
    if (line.startsWith(':')) return undefined;
    const sep = line.indexOf(':');
    const field = sep >= 0 ? line.slice(0, sep) : line;
    let value = sep >= 0 ? line.slice(sep + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.eventName = value;
    else if (field === 'data') this.dataLines.push(value);
    return undefined;
  }

  private flushEvent(timestampMs: number): TapSseEvent | undefined {
    if (!this.eventName && this.dataLines.length === 0) return undefined;
    const data = this.dataLines.join('\n');
    const currentEventName = this.eventName;
    this.eventName = undefined;
    this.dataLines = [];
    if (!data) return undefined;
    if (this.firstSseMs === undefined) this.firstSseMs = timestampMs;
    const json = safeJsonParse(data);
    const event: TapSseEvent = stripUndefined({
      event: inferEventName(currentEventName, json),
      data,
      json,
      timestampMs
    });
    this.events.push(event);
    this.applyEvent(event);
    return event;
  }

  private applyEvent(event: TapSseEvent): void {
    if (event.data === '[DONE]') return;
    const json = event.json;
    if (!json || typeof json !== 'object') return;
    switch (this.apiType) {
      case 'messages':
        this.applyAnthropic(json as Record<string, unknown>, event.timestampMs);
        break;
      case 'chat-completions':
        this.applyOpenAIChat(json as Record<string, unknown>, event.timestampMs);
        break;
      case 'responses':
        this.applyOpenAIResponses(json as Record<string, unknown>, event.timestampMs, event.event);
        break;
      default:
        this.applyUnknown(json as Record<string, unknown>);
        break;
    }
  }

  private applyAnthropic(json: Record<string, unknown>, timestampMs: number): void {
    const type = stringField(json, 'type');
    if (type === 'message_start') {
      const message = objectField(json, 'message');
      this.raw = message ?? json;
      this.id = stringField(message, 'id') ?? this.id;
      this.model = stringField(message, 'model') ?? this.model;
      this.role = stringField(message, 'role') ?? this.role;
      this.captureRawUsage(message?.usage);
      this.usage = mergeUsage(this.usage, normalizeUsage(message?.usage, 'anthropic-messages'));
      return;
    }
    if (type === 'content_block_start') {
      const index = numberField(json, 'index') ?? this.anthropicBlocks.size;
      const block = objectField(json, 'content_block') ?? {};
      const next = anthropicContentBlock(block);
      this.anthropicBlocks.set(index, next);
      if (next.type === 'thinking' && next.thinking) this.markThinking(timestampMs);
      if (next.type === 'text' && next.text) this.markText(timestampMs);
      if (next.type === 'tool_use') this.markTool(timestampMs);
      return;
    }
    if (type === 'content_block_delta') {
      const index = numberField(json, 'index') ?? 0;
      const block = this.anthropicBlocks.get(index) ?? { type: 'text', text: '' };
      this.anthropicBlocks.set(index, block);
      const delta = objectField(json, 'delta') ?? {};
      const deltaType = stringField(delta, 'type');
      if (deltaType === 'text_delta') {
        block.type = 'text';
        block.text = (block.text ?? '') + (stringField(delta, 'text') ?? '');
        this.markText(timestampMs);
      } else if (deltaType === 'thinking_delta') {
        block.type = 'thinking';
        block.thinking = (block.thinking ?? '') + (stringField(delta, 'thinking') ?? '');
        this.markThinking(timestampMs);
      } else if (deltaType === 'signature_delta') {
        // 思考明文被隐藏时上游只发 signature_delta；留下签名让 viewer 能展示「确实思考过、被加密」的证据。
        block.type = 'thinking';
        block.signature = (block.signature ?? '') + (stringField(delta, 'signature') ?? '');
      } else if (deltaType === 'citations_delta') {
        // citation 是逐条 delta 下发的，累积成数组挂回本块，才能对齐非流式响应里 text.citations 的形状。
        const citation = objectField(delta, 'citation');
        if (citation) {
          block.type = 'text';
          block.citations = [...(block.citations ?? []), citation];
        }
      } else if (deltaType === 'input_json_delta') {
        block.type = 'tool_use';
        block.rawInput = (block.rawInput ?? '') + (stringField(delta, 'partial_json') ?? '');
        this.markTool(timestampMs);
      }
      return;
    }
    if (type === 'content_block_stop') {
      const index = numberField(json, 'index') ?? 0;
      const block = this.anthropicBlocks.get(index);
      if (block) finalizeJsonInput(block);
      return;
    }
    if (type === 'message_delta') {
      const delta = objectField(json, 'delta');
      this.stopReason = stringField(delta, 'stop_reason') ?? this.stopReason;
      this.captureRawUsage(json.usage);
      this.usage = mergeUsage(this.usage, normalizeUsage(json.usage, 'anthropic-messages'));
      return;
    }
    if (type === 'message_stop') {
      this.captureRawUsage(json.usage);
      this.usage = mergeUsage(this.usage, normalizeUsage(json.usage, 'anthropic-messages'));
    }
  }

  private applyOpenAIChat(json: Record<string, unknown>, timestampMs: number): void {
    this.raw = json;
    this.id = stringField(json, 'id') ?? this.id;
    this.model = stringField(json, 'model') ?? this.model;
    this.captureRawUsage(json.usage);
    this.usage = mergeUsage(this.usage, normalizeUsage(json.usage, 'openai-chat-completions'));
    const choices = Array.isArray(json.choices) ? json.choices : [];
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue;
      const c = choice as Record<string, unknown>;
      const choiceIndex = numberField(c, 'index') ?? 0;
      const delta = objectField(c, 'delta') ?? objectField(c, 'message') ?? {};
      this.stopReason = stringField(c, 'finish_reason') ?? this.stopReason;
      this.role = stringField(delta, 'role') ?? this.role;
      const content = stringField(delta, 'content');
      if (content) {
        const block = this.openaiTextBlocks.get(choiceIndex) ?? { type: 'text', text: '', choiceIndex };
        block.text = (block.text ?? '') + content;
        this.openaiTextBlocks.set(choiceIndex, block);
        this.markText(timestampMs);
      }
      const reasoning = stringField(delta, 'reasoning_content')
        ?? stringField(delta, 'reasoning')
        ?? stringField(delta, 'reasoning_text');
      if (reasoning) {
        const block = this.openaiThinkingBlocks.get(choiceIndex) ?? { type: 'thinking', thinking: '', choiceIndex };
        block.thinking = (block.thinking ?? '') + reasoning;
        this.openaiThinkingBlocks.set(choiceIndex, block);
        this.markThinking(timestampMs);
      }
      const toolCalls = Array.isArray(delta.tool_calls)
        ? delta.tool_calls
        : Array.isArray(delta.toolCalls)
          ? delta.toolCalls
          : [];
      for (const call of toolCalls) this.applyOpenAIToolCall(call, timestampMs, choiceIndex);
    }
  }

  private applyOpenAIToolCall(call: unknown, timestampMs: number, choiceIndex: number): void {
    if (!call || typeof call !== 'object') return;
    const item = call as Record<string, unknown>;
    const index = numberField(item, 'index') ?? this.openaiToolBlocks.size;
    const key = `${choiceIndex}:${index}`;
    const fn = objectField(item, 'function') ?? objectField(item, 'function_call') ?? {};
    const block = this.openaiToolBlocks.get(key) ?? { type: 'tool_use', choiceIndex };
    block.id = stringField(item, 'id') ?? block.id;
    block.name = stringField(fn, 'name') ?? stringField(item, 'name') ?? block.name;
    const args = stringField(fn, 'arguments') ?? stringField(item, 'arguments');
    if (args) block.rawInput = (block.rawInput ?? '') + args;
    this.openaiToolBlocks.set(key, block);
    this.markTool(timestampMs);
  }

  private applyOpenAIResponses(json: Record<string, unknown>, timestampMs: number, eventName?: string): void {
    const type = stringField(json, 'type') ?? eventName;
    this.raw = json;
    const response = objectField(json, 'response');
    this.id = stringField(response, 'id') ?? stringField(json, 'response_id') ?? this.id;
    this.model = stringField(response, 'model') ?? stringField(json, 'model') ?? this.model;
    this.captureRawUsage(json.usage);
    this.captureRawUsage(response?.usage);
    this.usage = mergeUsage(
      this.usage,
      normalizeUsage(json.usage, 'openai-responses'),
      normalizeUsage(response?.usage, 'openai-responses')
    );

    if (type === 'response.output_text.delta' || type === 'response.output_text.done') {
      const done = type.endsWith('.done');
      const value = stringField(json, done ? 'text' : 'delta');
      if (value) {
        this.responseTextBlock ??= { type: 'text', text: '' };
        this.responseTextBlock.text = done ? value : (this.responseTextBlock.text ?? '') + value;
        this.markText(timestampMs);
      }
    } else if (
      type === 'response.reasoning_text.delta'
      || type === 'response.reasoning_summary_text.delta'
      || type === 'response.reasoning.delta'
      || type === 'response.reasoning_text.done'
      || type === 'response.reasoning_summary_text.done'
      || type === 'response.reasoning.done'
    ) {
      const done = type.endsWith('.done');
      const value = stringField(json, done ? 'text' : 'delta');
      if (value) {
        this.responseThinkingBlock ??= { type: 'thinking', thinking: '' };
        this.responseThinkingBlock.thinking = done ? value : (this.responseThinkingBlock.thinking ?? '') + value;
        this.markThinking(timestampMs);
      }
    } else if (type === 'response.refusal.delta' || type === 'response.refusal.done') {
      const value = stringField(json, type.endsWith('.done') ? 'refusal' : 'delta') ?? '';
      if (value) {
        this.responseRefusalBlock ??= { type: 'refusal', text: '' };
        this.responseRefusalBlock.text = type.endsWith('.done')
          ? value
          : (this.responseRefusalBlock.text ?? '') + value;
        this.markText(timestampMs);
      }
    } else if (type === 'response.output_text.annotation.added') {
      const annotation = objectField(json, 'annotation');
      if (annotation) {
        this.responseTextBlock ??= { type: 'text', text: '' };
        this.responseTextBlock.citations = [...(this.responseTextBlock.citations ?? []), annotation];
      }
    } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = objectField(json, 'item') ?? {};
      this.mergeResponseOutputItem(item, timestampMs, numberField(json, 'output_index'), type.endsWith('.done'));
    } else if (
      type === 'response.function_call_arguments.delta'
      || type === 'response.function_call_arguments.done'
      || type === 'response.custom_tool_call_input.delta'
      || type === 'response.custom_tool_call_input.done'
    ) {
      const id = stringField(json, 'item_id') ?? stringField(json, 'call_id') ?? lastKey(this.responseToolBlocks);
      const done = type.endsWith('.done');
      const value = type.includes('custom_tool_call')
        ? (stringField(json, done ? 'input' : 'delta') ?? '')
        : (stringField(json, done ? 'arguments' : 'delta') ?? '');
      if (id) {
        const block = this.responseToolBlocks.get(id) ?? { type: 'tool_use', id };
        block.rawInput = done ? value : (block.rawInput ?? '') + value;
        if (done) {
          const parsed = safeJsonParse(value);
          block.input = parsed === undefined ? undefined : parsed;
        }
        this.responseToolBlocks.set(id, block);
        this.markTool(timestampMs);
      }
    } else if (type === 'response.completed' && response) {
      this.raw = response;
      this.mergeResponseSnapshot(snapshotFromJson('responses', response), timestampMs);
      this.stopReason = stringField(response, 'status') ?? this.stopReason;
      this.incompleteReason = incompleteReasonField(response) ?? this.incompleteReason;
    } else if ((type === 'response.failed' || type === 'response.incomplete') && response) {
      this.raw = response;
      this.mergeResponseSnapshot(snapshotFromJson('responses', response), timestampMs);
      const error = objectField(response, 'error');
      if (error) this.responseOtherBlocks.set('response-error', { type: 'json', content: { type: 'error', ...error } });
      this.stopReason = stringField(response, 'status') ?? this.stopReason;
      this.incompleteReason = incompleteReasonField(response) ?? this.incompleteReason;
    } else if (type === 'error') {
      this.responseOtherBlocks.set('response-error', { type: 'json', content: json });
      this.stopReason = this.stopReason ?? 'failed';
    }
  }

  private mergeResponseOutputItem(item: Record<string, unknown>, timestampMs: number, outputIndex: number | undefined, finalItem: boolean): void {
    const blocks = responseOutputItemBlocks(item);
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block.type === 'text') {
        if (finalItem && !this.responseTextBlock?.text && block.text) {
          this.responseTextBlock = { ...block };
          this.markText(timestampMs);
        }
        continue;
      }
      if (block.type === 'thinking') {
        if (finalItem && !this.responseThinkingBlock?.thinking && block.thinking) {
          this.responseThinkingBlock = { ...block };
          this.markThinking(timestampMs);
        }
        continue;
      }
      if (block.type === 'refusal') {
        if (finalItem && !this.responseRefusalBlock?.text && block.text) {
          this.responseRefusalBlock = { ...block };
          this.markText(timestampMs);
        }
        continue;
      }
      if (block.type === 'tool_use') {
        const itemType = stringField(item, 'type');
        const safeBlock = !finalItem && (itemType === 'function_call' || itemType === 'custom_tool_call')
          ? { ...block, rawInput: undefined, input: undefined }
          : block;
        this.mergeResponseToolBlock(safeBlock, stringField(item, 'id') ?? stringField(item, 'call_id'), timestampMs);
        continue;
      }
      const key = stringField(item, 'id')
        ?? `${stringField(item, 'type') ?? 'output'}-${outputIndex ?? this.responseOtherBlocks.size}-${index}`;
      this.responseOtherBlocks.set(key, { ...block });
    }
  }

  private mergeResponseSnapshot(snapshot: TapResponseSnapshot, timestampMs: number): void {
    this.incompleteReason = snapshot.incompleteReason ?? this.incompleteReason;
    for (const block of snapshot.content) {
      if (block.type === 'text') {
        if (!this.responseTextBlock?.text && block.text) {
          this.responseTextBlock = { ...block };
          this.markText(timestampMs);
        }
      } else if (block.type === 'thinking') {
        if (!this.responseThinkingBlock?.thinking && block.thinking) {
          this.responseThinkingBlock = { ...block };
          this.markThinking(timestampMs);
        }
      } else if (block.type === 'refusal') {
        if (!this.responseRefusalBlock?.text && block.text) {
          this.responseRefusalBlock = { ...block };
          this.markText(timestampMs);
        }
      } else if (block.type === 'tool_use') {
        this.mergeResponseToolBlock(block, block.id, timestampMs);
      } else {
        const raw = block.content && typeof block.content === 'object' ? block.content as Record<string, unknown> : undefined;
        const key = stringField(raw, 'id') ?? `snapshot-${this.responseOtherBlocks.size}`;
        this.responseOtherBlocks.set(key, { ...block });
      }
    }
  }

  private mergeResponseToolBlock(block: MutableBlock, preferredKey: string | undefined, timestampMs: number): void {
    let key = preferredKey;
    if (block.id) {
      for (const [candidateKey, candidate] of this.responseToolBlocks) {
        if (candidate.id === block.id) {
          key = candidateKey;
          break;
        }
      }
    }
    key ??= `tool-${this.responseToolBlocks.size}`;
    const current = this.responseToolBlocks.get(key);
    const rawInput = block.rawInput || current?.rawInput;
    const input = block.input !== undefined ? block.input : current?.input;
    this.responseToolBlocks.set(key, stripUndefined({
      ...current,
      ...block,
      type: 'tool_use' as const,
      rawInput,
      input
    }));
    this.markTool(timestampMs);
  }

  private applyUnknown(json: Record<string, unknown>): void {
    this.raw = json;
    this.captureRawUsage(json.usage);
    this.usage = mergeUsage(this.usage, normalizeUsage(json.usage, protocolFromApiType(this.apiType)));
  }

  private captureRawUsage(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    this.rawUsage = { ...(this.rawUsage ?? {}), ...(value as Record<string, unknown>) };
  }

  private contentBlocks(): TapContentBlock[] {
    const content: MutableBlock[] = [];
    if (this.apiType === 'messages') {
      content.push(...Array.from(this.anthropicBlocks.entries())
        .sort(([a], [b]) => a - b)
        .map(([, block]) => block));
    } else if (this.apiType === 'chat-completions') {
      const choiceIndexes = new Set<number>([
        ...this.openaiThinkingBlocks.keys(),
        ...this.openaiTextBlocks.keys(),
        ...Array.from(this.openaiToolBlocks.values()).map(block => block.choiceIndex ?? 0)
      ]);
      for (const choiceIndex of [...choiceIndexes].sort((a, b) => a - b)) {
        const thinking = this.openaiThinkingBlocks.get(choiceIndex);
        const text = this.openaiTextBlocks.get(choiceIndex);
        if (thinking) content.push(thinking);
        if (text) content.push(text);
        content.push(...Array.from(this.openaiToolBlocks.entries())
          .filter(([, block]) => (block.choiceIndex ?? 0) === choiceIndex)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, block]) => block));
      }
    } else if (this.apiType === 'responses') {
      if (this.responseThinkingBlock) content.push(this.responseThinkingBlock);
      if (this.responseTextBlock) content.push(this.responseTextBlock);
      if (this.responseRefusalBlock) content.push(this.responseRefusalBlock);
      content.push(...this.responseToolBlocks.values());
      content.push(...this.responseOtherBlocks.values());
    }
    return content.map(block => stripUndefined({
      type: block.type,
      id: block.id,
      name: block.name,
      text: block.text,
      thinking: block.thinking,
      signature: block.signature,
      input: block.input,
      rawInput: block.rawInput,
      content: block.content,
      // 下面几项是 Anthropic 扩展块/引用信息的唯一载体，漏掉就等于持久化时丢数据：
      // tool_result 没有 tool_use_id 就无法和调用配对，没有 wireType 就分不清内置工具与客户端工具。
      tool_use_id: block.tool_use_id,
      wireType: block.wireType,
      serverName: block.serverName,
      isError: block.isError,
      choiceIndex: block.choiceIndex,
      citations: block.citations
    }));
  }

  private markThinking(timestampMs: number): void {
    if (this.firstThinkingMs === undefined) this.firstThinkingMs = timestampMs;
  }

  private markText(timestampMs: number): void {
    if (this.firstTextMs === undefined) this.firstTextMs = timestampMs;
  }

  private markTool(timestampMs: number): void {
    if (this.firstToolMs === undefined) this.firstToolMs = timestampMs;
  }
}

export function snapshotFromJson(apiType: TapApiType, json: unknown): TapResponseSnapshot {
  if (!json || typeof json !== 'object') {
    return { apiType, content: [], raw: json };
  }
  const obj = json as Record<string, unknown>;
  if (apiType === 'messages') return snapshotFromAnthropicJson(obj);
  if (apiType === 'chat-completions') return snapshotFromOpenAIChatJson(obj);
  if (apiType === 'responses') return snapshotFromResponsesJson(obj);
  return {
    apiType,
    content: [],
    usage: normalizeUsage(obj.usage, protocolFromApiType(apiType)),
    raw: json
  };
}

function snapshotFromAnthropicJson(obj: Record<string, unknown>): TapResponseSnapshot {
  const content = Array.isArray(obj.content)
    ? obj.content.map(contentBlockFromAnthropic).filter(Boolean) as TapContentBlock[]
    : [];
  return stripUndefined({
    apiType: 'messages' as const,
    id: stringField(obj, 'id'),
    model: stringField(obj, 'model'),
    role: stringField(obj, 'role'),
    content,
    stopReason: stringField(obj, 'stop_reason'),
    usage: normalizeUsage(obj.usage, 'anthropic-messages'),
    raw: obj
  });
}

function snapshotFromOpenAIChatJson(obj: Record<string, unknown>): TapResponseSnapshot {
  const content: TapContentBlock[] = [];
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  let stopReason: string | undefined;
  let role: string | undefined;
  for (let choicePosition = 0; choicePosition < choices.length; choicePosition += 1) {
    const choice = choices[choicePosition];
    if (!choice || typeof choice !== 'object') continue;
    const c = choice as Record<string, unknown>;
    const choiceIndex = numberField(c, 'index') ?? choicePosition;
    const message = objectField(c, 'message') ?? objectField(c, 'delta') ?? {};
    stopReason = stringField(c, 'finish_reason') ?? stopReason;
    role = stringField(message, 'role') ?? role;
    const thinking = stringField(message, 'reasoning_content') ?? stringField(message, 'reasoning');
    if (thinking) content.push({ type: 'thinking', thinking, choiceIndex });
    const text = stringField(message, 'content');
    if (text) content.push({ type: 'text', text, choiceIndex });
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const call of toolCalls) {
      if (!call || typeof call !== 'object') continue;
      const item = call as Record<string, unknown>;
      const fn = objectField(item, 'function') ?? {};
      const rawInput = stringField(fn, 'arguments') ?? '';
      content.push(stripUndefined({
        type: 'tool_use' as const,
        id: stringField(item, 'id'),
        name: stringField(fn, 'name'),
        rawInput,
        input: safeJsonParse(rawInput),
        choiceIndex
      }));
    }
  }
  return stripUndefined({
    apiType: 'chat-completions' as const,
    id: stringField(obj, 'id'),
    model: stringField(obj, 'model'),
    role,
    content,
    stopReason,
    usage: normalizeUsage(obj.usage, 'openai-chat-completions'),
    raw: obj
  });
}

function snapshotFromResponsesJson(obj: Record<string, unknown>): TapResponseSnapshot {
  const content: TapContentBlock[] = [];
  const output = Array.isArray(obj.output) ? obj.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    content.push(...responseOutputItemBlocks(item as Record<string, unknown>));
  }
  return stripUndefined({
    apiType: 'responses' as const,
    id: stringField(obj, 'id'),
    model: stringField(obj, 'model'),
    role: 'assistant',
    content,
    stopReason: stringField(obj, 'status'),
    incompleteReason: incompleteReasonField(obj),
    usage: normalizeUsage(obj.usage, 'openai-responses'),
    raw: obj
  });
}

function protocolFromApiType(apiType: TapApiType): 'anthropic-messages' | 'openai-chat-completions' | 'openai-responses' | 'unknown' {
  if (apiType === 'messages') return 'anthropic-messages';
  if (apiType === 'chat-completions') return 'openai-chat-completions';
  if (apiType === 'responses') return 'openai-responses';
  return 'unknown';
}

function responseOutputItemBlocks(entry: Record<string, unknown>): MutableBlock[] {
  const type = stringField(entry, 'type');
  if (type === 'message') {
    const parts = Array.isArray(entry.content) ? entry.content : [];
    const blocks: MutableBlock[] = [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const contentPart = part as Record<string, unknown>;
      const refusal = stringField(contentPart, 'refusal');
      const text = stringField(contentPart, 'text');
      blocks.push(refusal
        ? { type: 'refusal', text: refusal }
        : text
          ? { type: 'text', text, citations: citationsField(contentPart) }
          : { type: 'json', content: contentPart });
    }
    return blocks;
  }
  if (type === 'reasoning') {
    const summary = Array.isArray(entry.summary)
      ? entry.summary.map(part => typeof part === 'string' ? part : stringField(part as Record<string, unknown>, 'text')).filter(Boolean).join('\n')
      : stringField(entry, 'text');
    return summary ? [{ type: 'thinking', thinking: summary }] : [];
  }
  if (type === 'function_call' || type === 'custom_tool_call' || type === 'tool_search_call') {
    const rawInput = type === 'custom_tool_call'
      ? (stringField(entry, 'input') ?? '')
      : (stringField(entry, 'arguments') ?? '');
    const structuredInput = entry.arguments !== undefined && typeof entry.arguments !== 'string'
      ? entry.arguments
      : safeJsonParse(rawInput);
    return [stripUndefined({
      type: 'tool_use' as const,
      id: stringField(entry, 'call_id') ?? stringField(entry, 'id'),
      name: stringField(entry, 'name') ?? (type === 'tool_search_call' ? 'tool_search' : undefined),
      rawInput,
      input: structuredInput
    })];
  }
  if (type?.endsWith('_call')) {
    const input = entry.arguments ?? entry.input ?? entry.action ?? entry;
    return [stripUndefined({
      type: 'tool_use' as const,
      id: stringField(entry, 'call_id') ?? stringField(entry, 'id'),
      name: stringField(entry, 'name') ?? type.slice(0, -'_call'.length),
      input
    })];
  }
  return [{ type: 'json', content: entry }];
}

function contentBlockFromAnthropic(value: unknown): TapContentBlock | undefined {
  if (!value || typeof value !== 'object') return undefined;
  // 非流式 body 与流式 content_block_start 的块形状完全相同，共用同一个映射函数：
  // 各自维护一份就会漂移（早期版本这里只认字面 tool_use，把 server_tool_use 退化成裸 json）。
  return stripUndefined(anthropicContentBlock(value as Record<string, unknown>));
}

function finalizeJsonInput(block: MutableBlock): void {
  if (!block.rawInput) return;
  const parsed = safeJsonParse(block.rawInput);
  if (parsed !== undefined) block.input = parsed;
}

/**
 * Anthropic keeps adding content block types (server_tool_use, web_search_tool_result,
 * mcp_tool_use / mcp_tool_result, code_execution_tool_result, redacted_thinking…). Those
 * blocks arrive COMPLETE in content_block_start with no follow-up deltas, so whatever is
 * not captured here is lost for good — it never reaches the viewer.
 *
 * The snapshot vocabulary is deliberately small, so map onto it by suffix instead of
 * enumerating every dated variant, and fall back to a lossless `json` block. Never
 * degrade an unknown block to empty text: that renders as a silent gap.
 *
 * 流式（content_block_start）和非流式（response body 的 content[]）共用本函数，
 * 两条路径的块形状本来就一样，各写一份必然漂移。
 */
function anthropicContentBlock(block: Record<string, unknown>): MutableBlock {
  const blockType = stringField(block, 'type') ?? '';
  if (blockType === 'text') {
    return { type: 'text', text: stringField(block, 'text') ?? '', citations: citationsField(block) };
  }
  // 非流式 thinking 块自带 signature；流式则靠 signature_delta 累积。
  if (blockType === 'thinking') {
    return { type: 'thinking', thinking: stringField(block, 'thinking') ?? '', signature: stringField(block, 'signature') };
  }
  // redacted_thinking carries the opaque payload in `data`; the viewer already renders a
  // signature-only thinking block as "encrypted, not sent in clear text".
  if (blockType === 'redacted_thinking') {
    return { type: 'thinking', thinking: '', signature: stringField(block, 'data') ?? '' };
  }
  if (blockType.endsWith('tool_use')) {
    return {
      type: 'tool_use',
      id: stringField(block, 'id'),
      name: stringField(block, 'name'),
      input: block.input,
      wireType: blockType === 'tool_use' ? undefined : blockType,
      serverName: stringField(block, 'server_name')
    };
  }
  if (blockType.endsWith('tool_result')) {
    return {
      type: 'tool_result',
      tool_use_id: stringField(block, 'tool_use_id'),
      content: block.content,
      wireType: blockType === 'tool_result' ? undefined : blockType,
      isError: block.is_error === true ? true : undefined
    };
  }
  return { type: 'json', content: block, wireType: blockType || undefined };
}

function inferEventName(current: string | undefined, json: unknown): string | undefined {
  if (current) return current;
  if (json && typeof json === 'object') return stringField(json as Record<string, unknown>, 'type');
  return undefined;
}

function findLineEnd(text: string): number {
  const n = text.indexOf('\n');
  const r = text.indexOf('\r');
  if (n < 0) return r;
  if (r < 0) return n;
  return Math.min(n, r);
}

function objectField(obj: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = obj?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = obj?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 空数组视为「没有引用」：流式的 content_block_start 会先发 `citations: []` 占位，
 * 真正的 citation 稍后才由 citations_delta 补上，落一个空数组只是噪音。
 */
function citationsField(obj: Record<string, unknown> | undefined): unknown[] | undefined {
  const value = obj?.citations ?? obj?.annotations;
  return Array.isArray(value) && value.length > 0 ? value : undefined;
}

function incompleteReasonField(obj: Record<string, unknown> | undefined): string | undefined {
  return stringField(objectField(obj, 'incomplete_details'), 'reason');
}

function lastKey<T>(map: Map<string, T>): string | undefined {
  let out: string | undefined;
  for (const key of map.keys()) out = key;
  return out;
}
