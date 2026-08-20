import { createHash, randomUUID } from 'crypto';
import { compactionItemToChatText } from './codexCompaction';
import { resolveCompatibleServiceReasoningProfile } from './compatibleServiceReasoningProfiles';
import { collectDeclaredResponsesTools, isAdditionalToolsItem } from './protocolBody';

/**
 * Compatibility bridge between Codex's Responses wire format and
 * OpenAI-compatible Chat Completions gateways. Used when a Codex client talks
 * to XwX Trace over the Responses API while the selected upstream only exposes a
 * Chat Completions endpoint (DeepSeek / Kimi / GLM / Qwen / MiniMax / OpenRouter…).
 *
 * The design mirrors cc-switch's Rust bridge (`transform_codex_chat.rs`),
 * adapted to our buffer model: we collapse the upstream Chat SSE into one
 * non-streaming chat.completion, convert it to a Responses response, then render
 * our own Responses SSE. Because the collapse is lossless, the non-streaming
 * transform below is the single source of truth — no separate streaming path.
 *
 * Client-facing side stays Responses-only: current Codex releases reject
 * `wire_api = "chat"`.
 */

const TOOL_SEARCH_PROXY_NAME = 'tool_search';
const CUSTOM_TOOL_INPUT_FIELD = 'input';
const CHAT_TOOL_NAME_MAX_LEN = 64;
const CUSTOM_TOOL_INPUT_DESCRIPTION =
  'Raw string input for the original custom tool. Preserve formatting exactly and follow the original tool definition embedded in the description.';
const CUSTOM_TOOL_PRESERVED_METADATA_HEADING = 'Original tool definition:';

/** Fields a Codex Responses request may carry that map 1:1 onto Chat Completions. */
const EXTRA_CHAT_PASSTHROUGH_FIELDS = [
  'frequency_penalty', 'logit_bias', 'logprobs', 'metadata', 'n',
  'parallel_tool_calls', 'presence_penalty', 'response_format', 'seed',
  'service_tier', 'stop', 'stream_options', 'top_logprobs', 'user'
] as const;

// ---------------------------------------------------------------------------
// Tool context: built from the original Responses request, threaded into the
// response transform so Codex-specific tool identities (custom / namespace /
// tool_search) can be restored from the flat Chat Completions function names.
// ---------------------------------------------------------------------------

type CodexToolKind = 'function' | 'namespace' | 'custom' | 'tool_search';

interface CodexToolSpec {
  readonly kind: CodexToolKind;
  readonly name: string;
  readonly namespace?: string;
}

export class CodexToolContext {
  private readonly chatToolsList: Record<string, unknown>[] = [];
  private readonly seenChatNames = new Set<string>();
  private readonly chatNameToSpec = new Map<string, CodexToolSpec>();
  private readonly namespaceNameToChatName = new Map<string, string>();

  chatTools(): Record<string, unknown>[] {
    return this.chatToolsList;
  }

  lookupChatName(chatName: string): CodexToolSpec | undefined {
    return this.chatNameToSpec.get(chatName);
  }

  isCustomToolChatName(chatName: string): boolean {
    return this.lookupChatName(chatName)?.kind === 'custom';
  }

  chatNameForResponseFunction(name: string, namespace: string | undefined): string {
    if (namespace) {
      const mapped = this.namespaceNameToChatName.get(nsKey(namespace, name));
      if (mapped) return mapped;
      return flattenNamespaceToolName(namespace, name);
    }
    return name;
  }

  private addChatTool(chatName: string, spec: CodexToolSpec, chatTool: Record<string, unknown>): void {
    if (!chatName.trim() || this.seenChatNames.has(chatName)) return;
    this.seenChatNames.add(chatName);
    if (spec.namespace) this.namespaceNameToChatName.set(nsKey(spec.namespace, spec.name), chatName);
    this.chatNameToSpec.set(chatName, spec);
    this.chatToolsList.push(chatTool);
  }

  private addFunctionTool(tool: Record<string, any>, namespace: string | undefined): void {
    const originalName = responsesToolName(tool);
    if (!originalName) return;
    const chatName = namespace ? flattenNamespaceToolName(namespace, originalName) : originalName;
    const chatTool = responsesFunctionToolToChatTool(tool, chatName);
    if (!chatTool) return;
    this.addChatTool(chatName, {
      kind: namespace ? 'namespace' : 'function',
      name: originalName,
      namespace
    }, chatTool);
  }

  private addCustomTool(tool: Record<string, any>): void {
    const name = responsesToolName(tool);
    if (!name) return;
    const chatTool = {
      type: 'function',
      function: {
        name,
        description: responsesCustomToolDescription(tool),
        parameters: {
          type: 'object',
          properties: {
            [CUSTOM_TOOL_INPUT_FIELD]: { type: 'string', description: CUSTOM_TOOL_INPUT_DESCRIPTION }
          },
          required: [CUSTOM_TOOL_INPUT_FIELD]
        }
      }
    };
    this.addChatTool(name, { kind: 'custom', name }, chatTool);
  }

  private addToolSearchTool(): void {
    const chatTool = {
      type: 'function',
      function: {
        name: TOOL_SEARCH_PROXY_NAME,
        description: 'Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query for tools or connectors to load.' },
            limit: { type: 'integer', description: 'Maximum number of tool groups to return.' }
          },
          required: ['query']
        }
      }
    };
    this.addChatTool(TOOL_SEARCH_PROXY_NAME, { kind: 'tool_search', name: TOOL_SEARCH_PROXY_NAME }, chatTool);
  }

  private addNamespaceTool(namespaceTool: Record<string, any>): void {
    const namespace = text(namespaceTool.name);
    if (!namespace) return;
    const children = array(namespaceTool.tools ?? namespaceTool.children);
    for (const child of children) {
      if (text(object(child).type) === 'function') this.addFunctionTool(object(child), namespace);
    }
  }

  addResponseTool(tool: unknown): void {
    if (typeof tool === 'string') {
      this.addCustomTool({ type: 'custom', name: tool });
      return;
    }
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return;
    const t = tool as Record<string, any>;
    switch (text(t.type)) {
      // local_shell / web_search and other built-ins are intentionally dropped:
      // third-party chat gateways cannot execute them, and Codex routes shell
      // work through the ordinary `function`-typed `shell` tool for these models.
      case 'function': this.addFunctionTool(t, undefined); break;
      case 'custom': this.addCustomTool(t); break;
      case 'tool_search': this.addToolSearchTool(); break;
      case 'namespace': this.addNamespaceTool(t); break;
      default: break;
    }
  }
}

/** Build the tool context from a Responses request body (tools + any loaded tool_search_output). */
export function buildCodexToolContext(value: unknown): CodexToolContext {
  const body = object(value);
  const context = new CodexToolContext();
  // Covers both the top-level `tools` field and the responses-lite
  // `additional_tools` input item Codex Desktop 0.144+ uses.
  for (const tool of collectDeclaredResponsesTools(body)) context.addResponseTool(tool);
  collectToolSearchOutputTools(body.input, context);
  return context;
}

function collectToolSearchOutputTools(value: unknown, context: CodexToolContext): void {
  if (Array.isArray(value)) {
    for (const item of value) collectToolSearchOutputTools(item, context);
    return;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, any>;
    if (text(obj.type) === 'tool_search_output') {
      for (const tool of array(obj.tools)) context.addResponseTool(tool);
    }
    for (const v of Object.values(obj)) collectToolSearchOutputTools(v, context);
  }
}

// ---------------------------------------------------------------------------
// Reasoning capability inference (no per-provider config UI: derived from the
// model id + upstream base URL, matching cc-switch's infer_* rules).
// ---------------------------------------------------------------------------

interface CodexChatReasoningConfig {
  supportsThinking?: boolean;
  supportsEffort?: boolean;
  thinkingParam?: string;   // 'thinking' | 'enable_thinking' | 'reasoning_split' | 'none'
  thinkingOnValue?: string; // 'enabled' | 'adaptive' — the value that turns thinking on
  effortParam?: string;     // 'reasoning_effort' | 'reasoning.effort' | 'none'
  effortValueMode?: string; // 'deepseek' | 'low_high' | 'openrouter' | 'passthrough'
}

function inferReasoningConfig(
  model: string,
  upstreamBaseUrl: string,
  useVerifiedCompatibleServiceProfile = false
): CodexChatReasoningConfig | undefined {
  if (useVerifiedCompatibleServiceProfile) return resolveCompatibleServiceReasoningProfile(model);
  const haystack = `${upstreamBaseUrl} ${model}`.toLowerCase();
  // Platform-first (name + base URL), then model/name substring rules.
  if (haystack.includes('openrouter'))
    return { supportsThinking: false, supportsEffort: true, thinkingParam: 'none', effortParam: 'reasoning.effort', effortValueMode: 'openrouter' };
  if (haystack.includes('siliconflow'))
    return { supportsThinking: true, supportsEffort: false, thinkingParam: 'enable_thinking', effortParam: 'none' };
  if (haystack.includes('deepseek'))
    return { supportsThinking: true, supportsEffort: true, thinkingParam: 'thinking', effortParam: 'reasoning_effort', effortValueMode: 'deepseek' };
  if (haystack.includes('stepfun') || haystack.includes('step-3.5-flash-2603'))
    return { supportsThinking: true, supportsEffort: haystack.includes('2603'), thinkingParam: 'none', effortParam: 'reasoning_effort', effortValueMode: 'low_high' };
  if (haystack.includes('kimi') || haystack.includes('moonshot'))
    return { supportsThinking: true, supportsEffort: false, thinkingParam: 'thinking', effortParam: 'none' };
  if (haystack.includes('glm') || haystack.includes('zhipu') || haystack.includes('z.ai'))
    return { supportsThinking: true, supportsEffort: false, thinkingParam: 'thinking', effortParam: 'none' };
  if (haystack.includes('qwen') || haystack.includes('dashscope') || haystack.includes('bailian'))
    return { supportsThinking: true, supportsEffort: false, thinkingParam: 'enable_thinking', effortParam: 'none' };
  if (haystack.includes('minimax'))
    return { supportsThinking: true, supportsEffort: false, thinkingParam: 'reasoning_split', effortParam: 'none' };
  if (haystack.includes('mimo'))
    return { supportsThinking: true, supportsEffort: false, thinkingParam: 'thinking', effortParam: 'none' };
  return undefined;
}

function isOpenAiOSeries(model: string): boolean {
  return model.length > 1 && model[0] === 'o' && model[1] >= '0' && model[1] <= '9';
}

function supportsReasoningEffort(model: string): boolean {
  const n = model.toLowerCase();
  const gpt5Plus = n.startsWith('gpt-') && n[4] >= '5' && n[4] <= '9';
  return isOpenAiOSeries(n) || gpt5Plus || n === 'grok-4.5' || n.startsWith('grok-4.5-') || n.startsWith('grok-build-');
}

/** Some Responses inputs express reasoning intent; None (undefined) means "no reasoning key at all". */
function reasoningRequested(body: Record<string, any>): boolean | undefined {
  const effort = body.reasoning?.effort;
  if (typeof effort === 'string') {
    return !['none', 'off', 'disabled'].includes(effort.trim().toLowerCase());
  }
  if (body.reasoning === undefined) return undefined;
  return body.reasoning !== null;
}

function mapReasoningEffort(effort: string, mode: string | undefined): string | undefined {
  const e = effort.trim().toLowerCase();
  if (['none', 'off', 'disabled'].includes(e)) return undefined;
  switch (mode ?? 'passthrough') {
    // DeepSeek accepts reasoning_effort: low|high|max and publishes the mapping
    // low→low, medium→high, high→high, xhigh→high, max→max.
    case 'deepseek':
      if (e === 'low') return 'low';
      if (e === 'max') return 'max';
      return 'high';
    case 'low_high': return e === 'minimal' || e === 'low' ? 'low' : 'high';
    case 'openrouter':
      if (e === 'max' || e === 'xhigh') return 'xhigh';
      return ['high', 'medium', 'low', 'minimal'].includes(e) ? e : undefined;
    default:
      return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(e) ? e : undefined;
  }
}

function applyReasoningOptions(
  result: Record<string, unknown>,
  body: Record<string, any>,
  model: string,
  config: CodexChatReasoningConfig | undefined
): void {
  if (!config) {
    if (supportsReasoningEffort(model) && body.reasoning?.effort !== undefined) {
      result.reasoning_effort = body.reasoning.effort;
    }
    return;
  }
  const supportsEffort = config.supportsEffort ?? false;
  const supportsThinking = (config.supportsThinking ?? false) || supportsEffort;
  const enabled = reasoningRequested(body);
  if (enabled === undefined) return;

  if (supportsThinking) {
    switch ((config.thinkingParam ?? 'thinking').trim().toLowerCase()) {
      case 'thinking':
        result.thinking = { type: enabled ? (config.thinkingOnValue ?? 'enabled') : 'disabled' };
        break;
      case 'enable_thinking': result.enable_thinking = enabled; break;
      case 'reasoning_split': result.reasoning_split = enabled; break;
      default: break;
    }
  }

  const effortParam = (config.effortParam ?? 'reasoning_effort').trim().toLowerCase();
  if (!enabled) {
    // Only OpenRouter's native reasoning.effort form carries an explicit "none".
    if (effortParam === 'reasoning.effort') result.reasoning = { effort: 'none' };
    return;
  }
  if (!supportsEffort) return;
  const effort = body.reasoning?.effort;
  if (typeof effort !== 'string') return;
  const mapped = mapReasoningEffort(effort, config.effortValueMode);
  if (!mapped) return;
  if (effortParam === 'reasoning_effort') result.reasoning_effort = mapped;
  else if (effortParam === 'reasoning.effort') result.reasoning = { effort: mapped };
}

// ---------------------------------------------------------------------------
// Request: Codex Responses → OpenAI Chat Completions
// ---------------------------------------------------------------------------

export function responsesToChatCompletions(
  value: unknown,
  options?: { upstreamBaseUrl?: string; useVerifiedCompatibleServiceReasoningProfile?: boolean }
): Record<string, unknown> {
  const body = object(value);
  const context = buildCodexToolContext(body);
  const model = text(body.model);
  const result: Record<string, unknown> = {};
  if (body.model !== undefined) result.model = body.model;

  let messages: Record<string, unknown>[] = [];
  const instructions = instructionText(body.instructions);
  if (instructions) messages.push({ role: 'system', content: instructions });
  appendResponsesInputAsChatMessages(body.input, messages, context);
  messages = collapseSystemMessagesToHead(messages);
  result.messages = messages;

  // Token limits: o-series wants max_completion_tokens; everyone else max_tokens.
  if (body.max_output_tokens !== undefined) {
    if (isOpenAiOSeries(model.toLowerCase())) result.max_completion_tokens = body.max_output_tokens;
    else result.max_tokens = body.max_output_tokens;
  }
  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens;
  if (body.max_completion_tokens !== undefined) result.max_completion_tokens = body.max_completion_tokens;

  for (const key of ['temperature', 'top_p', 'stream'] as const) {
    if (body[key] !== undefined) result[key] = body[key];
  }

  applyReasoningOptions(result, body, model, inferReasoningConfig(
    model,
    options?.upstreamBaseUrl ?? '',
    options?.useVerifiedCompatibleServiceReasoningProfile === true
  ));

  const tools = context.chatTools();
  if (tools.length) result.tools = tools;
  if (body.tool_choice !== undefined) result.tool_choice = responsesToolChoiceToChat(body.tool_choice, context);

  for (const key of EXTRA_CHAT_PASSTHROUGH_FIELDS) {
    if (body[key] !== undefined) result[key] = body[key];
  }

  // Strict OpenAI-compatible upstreams reject tool_choice / parallel_tool_calls
  // without a non-empty tools array. Drop both when tools ended up empty.
  const hasTools = Array.isArray(result.tools) && (result.tools as unknown[]).length > 0;
  if (!hasTools) {
    delete result.tool_choice;
    delete result.parallel_tool_calls;
  }

  // OpenAI-compatible upstreams omit usage from streaming SSE unless include_usage
  // is set explicitly; without it kimi/MiniMax etc. log token/cost/cache as 0.
  injectStreamIncludeUsage(result);
  return result;
}

function injectStreamIncludeUsage(result: Record<string, unknown>): void {
  if (result.stream !== true) return;
  const existing = result.stream_options;
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    (existing as Record<string, unknown>).include_usage = true;
  } else {
    result.stream_options = { include_usage: true };
  }
}

function instructionText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map(part => text(object(part).text) || (typeof part === 'string' ? part : ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

/** MiniMax rejects any non-head `system` role; merge all system messages to index 0. */
function collapseSystemMessagesToHead(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  const chunks: string[] = [];
  const rest: Record<string, unknown>[] = [];
  for (const msg of messages) {
    if (msg.role === 'system' && typeof msg.content === 'string') {
      if (msg.content.trim()) chunks.push(msg.content);
      continue;
    }
    rest.push(msg);
  }
  return chunks.length ? [{ role: 'system', content: chunks.join('\n\n') }, ...rest] : rest;
}

// ---- Input item → Chat messages, with reasoning attribution state machine ----

function appendResponsesInputAsChatMessages(
  input: unknown,
  messages: Record<string, unknown>[],
  context: CodexToolContext
): void {
  const state: ConvState = { pendingToolCalls: [], pendingReasoning: undefined, lastAssistantIndex: undefined };
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) appendResponsesItem(object(item), messages, state, context);
  } else if (input && typeof input === 'object') {
    appendResponsesItem(object(input), messages, state, context);
  }
  flushPendingToolCalls(messages, state);
  attachPendingReasoningToPreviousAssistant(messages, state);
  backfillToolCallReasoningPlaceholders(messages);
}

interface ConvState {
  pendingToolCalls: Record<string, unknown>[];
  pendingReasoning: string | undefined;
  lastAssistantIndex: number | undefined;
}

function appendResponsesItem(
  item: Record<string, any>,
  messages: Record<string, unknown>[],
  state: ConvState,
  context: CodexToolContext
): void {
  switch (text(item.type)) {
    case 'additional_tools':
      // Tool declarations, not conversation. They are already projected into the
      // request's `tools` array; emitting them here would add an empty developer
      // message (the item carries no `content`).
      return;
    case 'function_call':
      appendUniquePendingReasoning(state, extractReasoningFieldText(item));
      state.pendingToolCalls.push(responsesFunctionCallToChatToolCall(item, context));
      return;
    case 'custom_tool_call':
      appendUniquePendingReasoning(state, extractReasoningFieldText(item));
      state.pendingToolCalls.push(responsesCustomToolCallToChatToolCall(item));
      return;
    case 'tool_search_call':
      appendUniquePendingReasoning(state, extractReasoningFieldText(item));
      state.pendingToolCalls.push(responsesToolSearchCallToChatToolCall(item));
      return;
    case 'function_call_output': {
      flushPendingToolCalls(messages, state);
      const output = typeof item.output === 'string'
        ? canonicalizeJsonStringIfParseable(item.output)
        : (item.output === undefined ? '' : canonicalJsonString(item.output));
      messages.push({ role: 'tool', tool_call_id: text(item.call_id), content: output });
      return;
    }
    case 'custom_tool_call_output':
    case 'tool_search_output':
      flushPendingToolCalls(messages, state);
      messages.push({ role: 'tool', tool_call_id: text(item.call_id), content: canonicalJsonString(item) });
      return;
    case 'reasoning':
      // Attach forward to the following assistant/function_call (consumed on flush).
      appendPendingReasoning(state, extractReasoningSummaryText(item));
      return;
    case 'compaction':
      flushPendingToolCalls(messages, state);
      attachPendingReasoningToPreviousAssistant(messages, state);
      messages.push({ role: 'user', content: compactionItemToChatText(item.encrypted_content) });
      return;
    case 'compaction_trigger':
      // The proxy intercepts this request and runs a dedicated summary turn.
      // Ignore it defensively if the generic converter is called directly.
      return;
    case 'input_text':
    case 'input_image':
    case 'input_file':
    case 'input_audio': {
      flushPendingToolCalls(messages, state);
      const role = item.role ? responsesRoleToChatRole(text(item.role)) : 'user';
      const message = { role, content: responsesContentToChatContent([item]) };
      if (role === 'assistant') {
        attachPendingReasoningToAssistant(message, state);
      } else {
        attachPendingReasoningToPreviousAssistant(messages, state);
      }
      updateLastAssistantIndex(messages, message, state);
      messages.push(message);
      return;
    }
    default: {
      flushPendingToolCalls(messages, state);
      if (item.role !== undefined || item.content !== undefined) {
        const message = responsesMessageItemToChatMessage(item, messages, state);
        updateLastAssistantIndex(messages, message, state);
        messages.push(message);
      }
      return;
    }
  }
}

function flushPendingToolCalls(messages: Record<string, unknown>[], state: ConvState): void {
  if (!state.pendingToolCalls.length) return;
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: null,
    tool_calls: state.pendingToolCalls
  };
  state.pendingToolCalls = [];
  attachPendingReasoningToAssistant(message, state);
  state.lastAssistantIndex = messages.length;
  messages.push(message);
}

function responsesMessageItemToChatMessage(
  item: Record<string, any>,
  messages: Record<string, unknown>[],
  state: ConvState
): Record<string, unknown> {
  const role = responsesRoleToChatRole(text(item.role) || 'user');
  const content = item.content !== undefined ? responsesContentToChatContent(item.content) : null;
  const message: Record<string, unknown> = { role, content };
  if (role === 'assistant') {
    appendPendingReasoning(state, extractReasoningFieldText(item));
    attachPendingReasoningToAssistant(message, state);
  } else {
    attachPendingReasoningToPreviousAssistant(messages, state);
  }
  return message;
}

function responsesRoleToChatRole(role: string): string {
  switch (role) {
    case 'system': case 'developer': return 'system';
    case 'assistant': return 'assistant';
    case 'tool': return 'tool';
    default: return 'user';
  }
}

function updateLastAssistantIndex(messages: Record<string, unknown>[], message: Record<string, unknown>, state: ConvState): void {
  const role = message.role;
  if (role === 'assistant') state.lastAssistantIndex = messages.length;
  else if (role === 'tool') { /* keep */ }
  else state.lastAssistantIndex = undefined;
}

function appendPendingReasoning(state: ConvState, reasoning: string | undefined): void {
  const r = (reasoning ?? '').trim();
  if (!r) return;
  state.pendingReasoning = state.pendingReasoning ? `${state.pendingReasoning}\n\n${r}` : r;
}

function appendUniquePendingReasoning(state: ConvState, reasoning: string | undefined): void {
  const r = (reasoning ?? '').trim();
  if (!r) return;
  if (state.pendingReasoning?.includes(r)) return;
  state.pendingReasoning = state.pendingReasoning ? `${state.pendingReasoning}\n\n${r}` : r;
}

function attachPendingReasoningToAssistant(message: Record<string, unknown>, state: ConvState): void {
  const r = state.pendingReasoning;
  state.pendingReasoning = undefined;
  if (r && r.trim()) appendReasoningContent(message, r);
}

function attachPendingReasoningToPreviousAssistant(messages: Record<string, unknown>[], state: ConvState): void {
  const r = state.pendingReasoning;
  state.pendingReasoning = undefined;
  if (!r || !r.trim()) return;
  const idx = state.lastAssistantIndex;
  if (idx === undefined) return;
  const message = messages[idx];
  if (!message || message.role !== 'assistant') return;
  appendReasoningContent(message, r);
}

/** Kimi/DeepSeek reject assistant tool-call messages lacking reasoning_content. */
function backfillToolCallReasoningPlaceholders(messages: Record<string, unknown>[]): void {
  for (const message of messages) {
    const isToolCall = message.role === 'assistant'
      && Array.isArray(message.tool_calls) && (message.tool_calls as unknown[]).length > 0;
    if (!isToolCall) continue;
    const existing = message.reasoning_content;
    if (typeof existing !== 'string' || !existing.trim()) message.reasoning_content = 'tool call';
  }
}

function appendReasoningContent(message: Record<string, unknown>, reasoning: string): void {
  const r = reasoning.trim();
  if (!r) return;
  const existing = message.reasoning_content;
  message.reasoning_content = (typeof existing === 'string' && existing) ? `${existing}\n\n${r}` : r;
}

function responsesContentToChatContent(content: unknown): unknown {
  if (content === null || typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;

  const parts: Record<string, unknown>[] = [];
  let hasNonText = false;
  for (const raw of content) {
    const part = object(raw);
    switch (text(part.type)) {
      case 'input_text': case 'output_text': case 'text':
        if (text(part.text)) parts.push({ type: 'text', text: part.text });
        break;
      case 'refusal':
        if (text(part.refusal)) parts.push({ type: 'text', text: part.refusal });
        break;
      case 'input_image':
        if (part.image_url !== undefined) {
          const imageUrl = part.image_url && typeof part.image_url === 'object'
            ? part.image_url
            : { url: text(part.image_url) };
          parts.push({ type: 'image_url', image_url: imageUrl });
          hasNonText = true;
        }
        break;
      case 'input_file': {
        const file = responsesInputFileToChatFile(part);
        if (file) { parts.push({ type: 'file', file }); hasNonText = true; }
        break;
      }
      case 'input_audio':
        if (part.input_audio !== undefined) {
          parts.push({ type: 'input_audio', input_audio: part.input_audio });
          hasNonText = true;
        }
        break;
      default: break;
    }
  }

  if (!hasNonText) {
    return parts.map(p => text(p.text)).filter(Boolean).join('\n');
  }
  return parts;
}

function responsesInputFileToChatFile(part: Record<string, any>): Record<string, unknown> | undefined {
  if (part.file_id === undefined && part.file_data === undefined) return undefined;
  const file: Record<string, unknown> = {};
  for (const key of ['file_id', 'file_data', 'filename']) {
    if (part[key] !== undefined) file[key] = part[key];
  }
  return file;
}

// ---- Tool definition / call conversion helpers ----

function responsesToolName(tool: Record<string, any>): string | undefined {
  const name = text(object(tool.function).name) || text(tool.name);
  return name.trim() ? name.trim() : undefined;
}

function responsesCustomToolDescription(tool: Record<string, any>): string {
  return `${CUSTOM_TOOL_PRESERVED_METADATA_HEADING}\n\`\`\`json\n${canonicalJsonString(tool)}\n\`\`\``;
}

function normalizeFunctionParameters(params: unknown): Record<string, unknown> {
  const base = (params && typeof params === 'object' && !Array.isArray(params))
    ? { ...(params as Record<string, unknown>) }
    : { type: 'object', properties: {} };
  if (base.type !== 'object') base.type = 'object';
  return base;
}

function responsesFunctionToolToChatTool(tool: Record<string, any>, chatName: string): Record<string, unknown> | undefined {
  if (text(tool.type) !== 'function') return undefined;
  if (tool.function && typeof tool.function === 'object') {
    const fn = { ...(tool.function as Record<string, unknown>) };
    fn.parameters = normalizeFunctionParameters(fn.parameters);
    fn.name = chatName;
    if (tool.strict !== undefined && fn.strict === undefined) fn.strict = tool.strict;
    return { type: 'function', function: fn };
  }
  const fn: Record<string, unknown> = {
    name: chatName,
    description: tool.description ?? null,
    parameters: normalizeFunctionParameters(tool.parameters)
  };
  if (tool.strict !== undefined) fn.strict = tool.strict;
  return { type: 'function', function: fn };
}

function responsesFunctionCallToChatToolCall(item: Record<string, any>, context: CodexToolContext): Record<string, unknown> {
  const callId = text(item.call_id) || text(item.id);
  const name = text(item.name);
  const namespace = text(item.namespace) || undefined;
  const chatName = context.chatNameForResponseFunction(name, namespace);
  return {
    id: callId,
    type: 'function',
    function: { name: chatName, arguments: canonicalizeToolArguments(item.arguments) }
  };
}

function responsesCustomToolCallToChatToolCall(item: Record<string, any>): Record<string, unknown> {
  const callId = text(item.call_id) || text(item.id);
  const input = item.input ?? '';
  return {
    id: callId,
    type: 'function',
    function: { name: text(item.name), arguments: canonicalJsonString({ [CUSTOM_TOOL_INPUT_FIELD]: input }) }
  };
}

function responsesToolSearchCallToChatToolCall(item: Record<string, any>): Record<string, unknown> {
  const callId = text(item.call_id) || text(item.id);
  const args = item.arguments !== undefined ? canonicalJsonString(item.arguments) : '{}';
  return { id: callId, type: 'function', function: { name: TOOL_SEARCH_PROXY_NAME, arguments: args } };
}

function responsesToolChoiceToChat(toolChoice: unknown, context: CodexToolContext): unknown {
  if (!toolChoice || typeof toolChoice !== 'object' || Array.isArray(toolChoice)) return toolChoice;
  const tc = toolChoice as Record<string, any>;
  switch (text(tc.type)) {
    case 'function': {
      const chatName = context.chatNameForResponseFunction(text(tc.name), text(tc.namespace) || undefined);
      return { type: 'function', function: { name: chatName } };
    }
    case 'tool_search':
      return { type: 'function', function: { name: TOOL_SEARCH_PROXY_NAME } };
    case 'custom':
      return { type: 'function', function: { name: text(tc.name) } };
    default:
      return toolChoice;
  }
}

// ---------------------------------------------------------------------------
// Response: OpenAI Chat Completions → Codex Responses
// ---------------------------------------------------------------------------

export function chatCompletionToResponse(
  value: unknown,
  fallbackModel: string,
  context: CodexToolContext = new CodexToolContext()
): Record<string, unknown> {
  const chat = object(value);
  const choice = object(array(chat.choices)[0]);
  const message = object(choice.message);
  const responseId = responseIdFromChatId(text(chat.id));
  const model = text(chat.model) || fallbackModel;
  const finishReason = text(choice.finish_reason) || undefined;

  const reasoning = chatReasoningText(message);
  const output: Record<string, unknown>[] = [];
  const reasoningItem = chatReasoningToOutputItem(reasoning, responseId);
  if (reasoningItem) output.push(reasoningItem);
  const messageItem = chatMessageToOutputItem(message, responseId);
  if (messageItem) output.push(messageItem);
  output.push(...chatToolCallsToOutputItems(message, reasoning, context));

  const response: Record<string, unknown> = {
    id: responseId,
    object: 'response',
    created_at: typeof chat.created === 'number' ? chat.created : 0,
    status: finishReason === 'length' ? 'incomplete' : 'completed',
    model,
    output,
    usage: chatUsageToResponsesUsage(chat.usage)
  };
  if (finishReason === 'length') response.incomplete_details = { reason: 'max_output_tokens' };
  return response;
}

function responseIdFromChatId(id: string): string {
  const base = id || 'xwx_deck';
  return base.startsWith('resp_') ? base : `resp_${base}`;
}

function chatReasoningText(message: Record<string, any>): string | undefined {
  const field = extractReasoningFieldText(message);
  if (field) return field;
  const content = text(message.content);
  if (content) {
    const split = splitLeadingThinkBlock(content);
    if (split && split.reasoning) return split.reasoning;
  }
  return undefined;
}

function chatReasoningToOutputItem(reasoning: string | undefined, responseId: string): Record<string, unknown> | undefined {
  if (!reasoning) return undefined;
  return {
    id: `rs_${responseId}`,
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: reasoning }]
  };
}

function chatMessageToOutputItem(message: Record<string, any>, responseId: string): Record<string, unknown> | undefined {
  const content: Record<string, unknown>[] = [];
  if (typeof message.content === 'string') {
    const split = splitLeadingThinkBlock(message.content);
    const answer = split ? split.answer : message.content;
    if (answer) content.push({ type: 'output_text', text: answer, annotations: [] });
  } else if (Array.isArray(message.content)) {
    for (const raw of message.content) {
      const part = object(raw);
      const type = text(part.type);
      if ((type === 'text' || type === 'output_text') && text(part.text)) {
        content.push({ type: 'output_text', text: part.text, annotations: [] });
      } else if (type === 'refusal' && text(part.refusal)) {
        content.push({ type: 'refusal', refusal: part.refusal });
      }
    }
  }
  if (text(message.refusal)) content.push({ type: 'refusal', refusal: message.refusal });
  if (!content.length) return undefined;
  return { id: responsesMessageId(responseId), type: 'message', status: 'completed', role: 'assistant', content };
}

function responsesMessageId(responseId: string): string {
  const digest = createHash('sha256')
    .update(`${responseId}\u0000message\u00000`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `msg_xwx_${digest}`;
}

function chatToolCallsToOutputItems(
  message: Record<string, any>,
  reasoning: string | undefined,
  context: CodexToolContext
): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = [];
  const toolCalls = array(message.tool_calls);
  if (toolCalls.length) {
    toolCalls.forEach((raw, index) => {
      const call = object(raw);
      const fn = object(call.function);
      const name = text(fn.name);
      if (!name) return; // defensive: some models emit nameless tool calls
      const callId = text(call.id) || `call_${index}`;
      const args = canonicalizeToolArguments(fn.arguments);
      output.push(toolCallItemFromChatName(callId, name, args, reasoning, context));
    });
    return output;
  }
  const legacy = object(message.function_call);
  if (Object.keys(legacy).length) {
    const name = text(legacy.name);
    if (name) {
      const callId = text(legacy.id) || 'call_0';
      output.push(toolCallItemFromChatName(callId, name, canonicalizeToolArguments(legacy.arguments), reasoning, context));
    }
  }
  return output;
}

function toolCallItemFromChatName(
  callId: string,
  chatName: string,
  args: string,
  reasoning: string | undefined,
  context: CodexToolContext
): Record<string, unknown> {
  const spec = context.lookupChatName(chatName);
  let item: Record<string, unknown>;
  if (spec?.kind === 'tool_search') {
    item = {
      type: 'tool_search_call',
      call_id: callId,
      status: 'completed',
      execution: 'client',
      arguments: parseToolArgumentsObject(args)
    };
  } else if (spec?.kind === 'custom') {
    item = {
      id: `ctc_${callId}`,
      type: 'custom_tool_call',
      status: 'completed',
      call_id: callId,
      name: spec.name,
      input: customToolInputFromChatArguments(args)
    };
  } else if (spec) {
    item = {
      id: `fc_${callId}`,
      type: 'function_call',
      status: 'completed',
      call_id: callId,
      name: spec.name,
      arguments: args
    };
    if (spec.namespace) item.namespace = spec.namespace;
  } else {
    item = {
      id: `fc_${callId}`,
      type: 'function_call',
      status: 'completed',
      call_id: callId,
      name: chatName,
      arguments: args
    };
  }
  if (reasoning && reasoning.trim()) item.reasoning_content = reasoning;
  return item;
}

function parseToolArgumentsObject(args: string): unknown {
  if (!args.trim()) return {};
  try {
    const parsed = JSON.parse(args);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* fall through */ }
  return { query: args };
}

function customToolInputFromChatArguments(args: string): string {
  if (!args.trim()) return '';
  try {
    const parsed = JSON.parse(args);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const input = (parsed as Record<string, unknown>)[CUSTOM_TOOL_INPUT_FIELD];
      return typeof input === 'string' ? input : args;
    }
  } catch { /* fall through */ }
  return args;
}

function chatUsageToResponsesUsage(value: unknown): Record<string, unknown> {
  const usage = object(value);
  if (!Object.keys(usage).length) {
    return { input_tokens: 0, output_tokens: 0, total_tokens: 0, output_tokens_details: { reasoning_tokens: 0 } };
  }
  const inputTokens = num(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = num(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = usage.total_tokens !== undefined ? num(usage.total_tokens) : inputTokens + outputTokens;

  const result: Record<string, unknown> = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens
  };

  const cached = num(
    usage.prompt_tokens_details?.cached_tokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? usage.cache_read_input_tokens
  );
  const cacheWrite = num(
    usage.prompt_tokens_details?.cache_write_tokens
    ?? usage.input_tokens_details?.cache_write_tokens
    ?? usage.cache_creation_input_tokens
  );
  if (cached > 0 || cacheWrite > 0) {
    result.input_tokens_details = { cached_tokens: cached, cache_write_tokens: cacheWrite };
  }

  const completionDetails = usage.completion_tokens_details;
  if (completionDetails && typeof completionDetails === 'object' && !Array.isArray(completionDetails)) {
    const details = { ...(completionDetails as Record<string, unknown>) };
    if (details.reasoning_tokens === undefined) details.reasoning_tokens = 0;
    result.output_tokens_details = details;
  } else {
    result.output_tokens_details = { reasoning_tokens: 0 };
  }

  return result;
}

// ---------------------------------------------------------------------------
// SSE: fold upstream Chat SSE into one chat.completion; render Responses SSE.
// ---------------------------------------------------------------------------

/** Fold an OpenAI Chat SSE response into its non-streaming representation. */
export function chatSseToCompletion(raw: string, fallbackModel: string): Record<string, unknown> {
  let model = fallbackModel;
  let content = '';
  let reasoning = '';
  let finishReason: string | undefined;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let usage: unknown;

  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
    if (!data || data === '[DONE]') continue;
    try {
      const item = object(JSON.parse(data));
      model = text(item.model) || model;
      if (item.usage !== undefined) usage = item.usage;
      const choice = object(array(item.choices)[0]);
      if (text(choice.finish_reason)) finishReason = text(choice.finish_reason);
      const delta = object(choice.delta);
      content += text(delta.content);
      reasoning += text(delta.reasoning_content) || text(delta.reasoning);
      for (const rawCall of array(delta.tool_calls)) {
        const call = object(rawCall);
        const index = typeof call.index === 'number' ? call.index : 0;
        const known = calls.get(index) ?? { id: '', name: '', arguments: '' };
        known.id += text(call.id);
        const fn = object(call.function);
        known.name += text(fn.name);
        known.arguments += text(fn.arguments);
        calls.set(index, known);
      }
    } catch { /* malformed chunk skipped; a wholly-unparseable stream folds to an empty completion, which the proxy detects and turns into an error reply */ }
  }

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: content || null,
    tool_calls: [...calls.values()].map(call => ({
      id: call.id || `call_${randomUUID()}`,
      type: 'function',
      function: { name: call.name, arguments: call.arguments || '{}' }
    }))
  };
  if (reasoning.trim()) message.reasoning_content = reasoning;

  return {
    id: `chatcmpl_xwx_${randomUUID()}`,
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message, finish_reason: finishReason ?? 'stop' }],
    usage
  };
}

/**
 * Render a complete Responses SSE sequence from a fully-materialized response.
 * Buffering the upstream Chat SSE first keeps correctness for gateways that
 * split JSON / tool arguments across arbitrary chunks.
 */
export function responseAsSse(response: Record<string, unknown>): string {
  const events: string[] = [];
  events.push(sse('response.created', { type: 'response.created', response: { ...response, status: 'in_progress' } }));
  events.push(sse('response.in_progress', { type: 'response.in_progress', response: { ...response, status: 'in_progress' } }));

  array(response.output).forEach((raw, outputIndex) => {
    const item = object(raw);
    const type = text(item.type);
    const itemId = text(item.id) || text(item.call_id);
    events.push(sse('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item }));

    if (type === 'message') {
      array(item.content).forEach((partRaw, contentIndex) => {
        const part = object(partRaw);
        if (text(part.type) === 'output_text' && text(part.text)) {
          events.push(sse('response.output_text.delta', {
            type: 'response.output_text.delta', item_id: itemId, output_index: outputIndex, content_index: contentIndex, delta: part.text
          }));
          events.push(sse('response.output_text.done', {
            type: 'response.output_text.done', item_id: itemId, output_index: outputIndex, content_index: contentIndex, text: part.text
          }));
        }
      });
    } else if (type === 'reasoning') {
      const summaryText = text(object(array(item.summary)[0]).text);
      if (summaryText) {
        events.push(sse('response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta', item_id: itemId, output_index: outputIndex, summary_index: 0, delta: summaryText
        }));
        events.push(sse('response.reasoning_summary_text.done', {
          type: 'response.reasoning_summary_text.done', item_id: itemId, output_index: outputIndex, summary_index: 0, text: summaryText
        }));
      }
    } else if (type === 'function_call') {
      const args = text(item.arguments);
      events.push(sse('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta', item_id: itemId, output_index: outputIndex, delta: args
      }));
      events.push(sse('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done', item_id: itemId, output_index: outputIndex, arguments: args
      }));
    } else if (type === 'custom_tool_call') {
      const input = text(item.input);
      events.push(sse('response.custom_tool_call_input.delta', {
        type: 'response.custom_tool_call_input.delta', item_id: itemId, output_index: outputIndex, delta: input
      }));
      events.push(sse('response.custom_tool_call_input.done', {
        type: 'response.custom_tool_call_input.done', item_id: itemId, output_index: outputIndex, input
      }));
    }

    events.push(sse('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item }));
  });

  events.push(sse('response.completed', { type: 'response.completed', response }));
  events.push('data: [DONE]\n\n');
  return events.join('');
}

/**
 * Render a Responses-style error as an SSE sequence for streaming clients.
 * Codex surfaces `response.failed` / `response.error` events; we emit both a
 * failed lifecycle event and the terminal [DONE] so the client stops cleanly.
 */
export function errorAsResponsesSse(errorBody: Record<string, unknown>): string {
  const error = object(errorBody.error);
  return [
    sse('response.failed', {
      type: 'response.failed',
      response: { id: `resp_xwx_${randomUUID()}`, object: 'response', status: 'failed', error }
    }),
    sse('error', { type: 'error', ...error }),
    'data: [DONE]\n\n'
  ].join('');
}


// ---------------------------------------------------------------------------
// Error normalization + shared primitives
// ---------------------------------------------------------------------------

/** Normalize a Chat Completions upstream error body into a Responses-style error. */
export function chatErrorToResponseError(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) {
    return { error: { message: 'Upstream returned an empty error response', type: 'upstream_error', code: null, param: null } };
  }
  if (typeof body === 'string') {
    return { error: { message: body, type: 'upstream_error', code: null, param: null } };
  }
  const value = object(body);
  const source = object(value.error).message !== undefined || Object.keys(object(value.error)).length ? object(value.error) : value;
  const message =
    text(source.message) || text(source.detail) || text(source.status_msg) || text(object(source.base_resp).status_msg)
    || (typeof body === 'string' ? body : JSON.stringify(source));
  const errorType = text(source.type) || 'upstream_error';
  const code = source.code ?? object(source.base_resp).status_code ?? null;
  const param = source.param ?? null;
  return { error: { message, type: errorType, code, param } };
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

function splitLeadingThinkBlock(text: string): { reasoning: string; answer: string } | undefined {
  const leadingWs = text.length - text.trimStart().length;
  const afterWs = text.slice(leadingWs);
  if (!afterWs.startsWith(THINK_OPEN)) return undefined;
  const bodyStart = leadingWs + THINK_OPEN.length;
  const closeRel = text.slice(bodyStart).indexOf(THINK_CLOSE);
  if (closeRel < 0) return undefined;
  const closeStart = bodyStart + closeRel;
  const answerStart = closeStart + THINK_CLOSE.length;
  return {
    reasoning: text.slice(bodyStart, closeStart).trim(),
    answer: text.slice(answerStart).replace(/^[\r\n\t ]+/, '')
  };
}

function extractReasoningFieldText(value: Record<string, any>): string | undefined {
  for (const key of ['reasoning_content', 'reasoning']) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  const reasoning = value.reasoning;
  if (reasoning && typeof reasoning === 'object') {
    for (const key of ['content', 'text', 'summary']) {
      if (typeof reasoning[key] === 'string' && reasoning[key]) return reasoning[key];
    }
  }
  const details = value.reasoning_details;
  if (details !== undefined) {
    const detailText = extractReasoningDetailsText(details);
    if (detailText) return detailText;
  }
  return undefined;
}

function extractReasoningDetailsText(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (Array.isArray(value)) {
    const joined = value.map(extractReasoningDetailPartText).filter(Boolean).join('\n\n');
    return joined || undefined;
  }
  if (value && typeof value === 'object') return extractReasoningDetailPartText(value);
  return undefined;
}

function extractReasoningDetailPartText(value: unknown): string | undefined {
  const obj = object(value);
  for (const key of ['text', 'content', 'summary']) {
    if (typeof obj[key] === 'string' && obj[key]) return obj[key];
  }
  if (Array.isArray(obj.parts)) {
    const joined = obj.parts.map(extractReasoningDetailPartText).filter(Boolean).join('\n\n');
    return joined || undefined;
  }
  return undefined;
}

function extractReasoningSummaryText(item: Record<string, any>): string | undefined {
  for (const key of ['reasoning_content', 'content', 'text']) {
    if (typeof item[key] === 'string' && item[key]) return item[key];
  }
  const summary = item.summary;
  if (typeof summary === 'string') return summary || undefined;
  if (Array.isArray(summary)) {
    const joined = summary
      .map(part => text(object(part).text) || text(object(part).content) || (typeof part === 'string' ? part : ''))
      .filter(Boolean)
      .join('\n\n');
    return joined || undefined;
  }
  return undefined;
}

function flattenNamespaceToolName(namespace: string, name: string): string {
  const full = `${namespace}__${name}`;
  if (full.length <= CHAT_TOOL_NAME_MAX_LEN) return full;
  const hash = createHash('sha256').update(full, 'utf8').digest('hex').slice(0, 8);
  const suffix = `__${hash}`;
  const prefixLen = Math.max(0, CHAT_TOOL_NAME_MAX_LEN - suffix.length);
  return full.slice(0, prefixLen) + suffix;
}

function nsKey(namespace: string, name: string): string {
  return `${namespace} ${name}`;
}

// ---- canonical JSON (sorted keys) so argument/output payloads are stable ----

function canonicalJsonString(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function canonicalizeJsonStringIfParseable(s: string): string {
  try { return canonicalJsonString(JSON.parse(s)); } catch { return s; }
}

function canonicalizeToolArguments(value: unknown): string {
  if (typeof value === 'string') return value.trim() === '' ? '{}' : canonicalizeJsonStringIfParseable(value);
  if (value === undefined || value === null) return '{}';
  return canonicalJsonString(value);
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
function object(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
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
