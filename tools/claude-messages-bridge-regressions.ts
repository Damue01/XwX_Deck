import assert from 'node:assert/strict';
import { resolveClaudeModelProtocol, resolveProviderCodexProtocol } from '../src/main/app/codexProtocolPolicy';
import { normalizeModelCatalog, type ModelCatalogEntry } from '../src/main/app/modelCatalog';
import { enrichModelCatalog } from '../src/main/app/modelCapabilities';
import {
  anthropicErrorBody,
  anthropicMessageAsSse,
  anthropicMessagesToUpstream,
  chatCompletionToAnthropicMessage,
  ChatToAnthropicStream,
  estimateAnthropicInputTokens,
  responsesSseToResponse,
  responsesToAnthropicMessage,
  ResponsesToAnthropicStream
} from '../src/main/trace/claudeMessagesBridge';

type SseEvent = { event: string; data: any };

function parseSse(raw: string): SseEvent[] {
  return raw.split('\n\n').filter(Boolean).map(block => {
    const lines = block.split('\n');
    return {
      event: lines.find(line => line.startsWith('event: '))!.slice(7),
      data: JSON.parse(lines.find(line => line.startsWith('data: '))!.slice(6))
    };
  });
}

function sse(events: unknown[]): string {
  return events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
}

/** Rebuild the final message the way a Claude client folds Messages SSE. */
function foldAnthropicSse(events: SseEvent[]): { content: any[]; stop: string | undefined; usage: any; error?: any } {
  const content: any[] = [];
  let stop: string | undefined;
  let usage: any;
  let error: any;
  for (const { event, data } of events) {
    if (event === 'content_block_start') content[data.index] = { ...data.content_block, _json: '' };
    else if (event === 'content_block_delta' && data.delta.type === 'text_delta') content[data.index].text += data.delta.text;
    else if (event === 'content_block_delta' && data.delta.type === 'input_json_delta') content[data.index]._json += data.delta.partial_json;
    else if (event === 'message_delta') { stop = data.delta.stop_reason; usage = data.usage; }
    else if (event === 'error') error = data.error;
  }
  return {
    content: content.map(({ _json, ...block }) => block.type === 'tool_use'
      ? { ...block, input: _json ? JSON.parse(_json) : {} } : block),
    stop, usage, error
  };
}

function assertWellFormed(events: SseEvent[]): void {
  const names = events.map(event => event.event);
  assert.equal(names[0], 'message_start');
  assert.equal(names.at(-1), 'message_stop');
  const open = new Set<number>();
  for (const { event, data } of events) {
    if (event === 'content_block_start') { assert(!open.size, 'one block open at a time'); open.add(data.index); }
    if (event === 'content_block_delta') assert(open.has(data.index), 'delta targets the open block');
    if (event === 'content_block_stop') { assert(open.delete(data.index)); }
  }
  assert.equal(open.size, 0, 'every block is closed before message_delta');
}

export async function testClaudeMessagesBridgeRegressions(): Promise<void> {
  // --- Which catalog entries Claude clients can use, and how -------------------
  const entry = (patch: Partial<ModelCatalogEntry>): ModelCatalogEntry => ({ id: 'x', vendor: 'Fixture', protocols: [], ...patch } as ModelCatalogEntry);
  assert.equal(resolveClaudeModelProtocol(undefined, entry({ protocols: ['anthropic-messages', 'chat-completions'] })), 'anthropic-messages');
  assert.equal(resolveClaudeModelProtocol(undefined, entry({ protocols: ['openai-responses', 'chat-completions'] })), 'responses');
  assert.equal(resolveClaudeModelProtocol(undefined, entry({ protocols: ['chat-completions'] })), 'chat-completions');
  assert.equal(resolveClaudeModelProtocol({ adapter: 'anthropic-messages' }, entry({ protocols: ['chat-completions'] })), undefined,
    'a Messages-only connection has no OpenAI endpoint to bridge to');
  assert.equal(resolveClaudeModelProtocol(undefined, entry({ id: 'text-embedding-3-large', protocols: ['openai-responses'] })), undefined);
  assert.equal(resolveClaudeModelProtocol(undefined, entry({ protocols: ['gemini'], protocolsDeclared: true })), undefined);
  assert.equal(resolveClaudeModelProtocol(undefined, entry({ id: 'gpt-5.5', catalogEndpoints: ['openai'] })), 'responses',
    'CompatibleService undeclared OpenAI-directory models default to Responses');
  assert.equal(resolveClaudeModelProtocol(undefined, entry({ id: 'qwen3.8-max', catalogEndpoints: ['openai'] })), 'responses',
    'the protocol is never guessed from the model name');
  assert.equal(resolveClaudeModelProtocol({ codexApiFormat: 'chat-completions' }, entry({ id: 'gpt-5.5', catalogEndpoints: ['openai'] })), 'chat-completions',
    'a connection set to Chat routes undeclared models over Chat, like Codex');
  assert.equal(resolveClaudeModelProtocol({ codexApiFormat: 'responses' }, entry({ id: 'qwen3.8-max', catalogEndpoints: ['openai'] })), 'responses');
  assert.equal(resolveClaudeModelProtocol(undefined, entry({ id: 'mystery' })), undefined);
  assert.equal(resolveClaudeModelProtocol({ adapter: 'responses', codexApiFormat: 'responses' },
    entry({ id: 'deepseek-v4-pro', catalogEndpoints: ['openai'], officialProtocols: ['chat-completions'] })),
  'responses', 'explicit Responses must outrank stale third-party protocol enrichment for Claude too');

  // --- Request: Messages → Responses -------------------------------------------
  const conversation = {
    model: 'gpt-5.5',
    max_tokens: 64_000,
    stream: true,
    temperature: 1,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=fixture' },
      { type: 'text', text: 'You are a coding agent.' },
      { type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }
    ],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'max' },
    stop_sequences: ['a', 'b', 'c', 'd', 'e'],
    tools: [
      { name: 'Read', description: 'Read a file', input_schema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { path: { type: 'string' } } } },
      { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }
    ],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    messages: [
      { role: 'user', content: 'Read README' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'Need the file.', signature: 'sig' },
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'README.md' } }
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: [
          { type: 'text', text: 'denied' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
        ] },
        { type: 'text', text: 'Try again' }
      ] }
    ]
  };
  const responses: any = anthropicMessagesToUpstream(conversation, { wireProtocol: 'responses', maxOutputTokens: 32_000 });
  assert.equal(responses.instructions, 'You are a coding agent.\n\nBe brief.', 'billing header is not an instruction');
  assert.equal(responses.max_output_tokens, 32_000, 'clamped to the catalog ceiling');
  assert.equal(responses.temperature, undefined, 'reasoning models reject sampling knobs');
  assert.equal(responses.stop, undefined, 'Responses has no stop parameter');
  assert.deepEqual(responses.reasoning, { effort: 'high' }, 'max/xhigh map to the highest portable effort');
  assert.equal(responses.store, false);
  assert.equal(responses.stream, true);
  assert.deepEqual(responses.tools, [{ type: 'function', name: 'Read', description: 'Read a file', strict: false,
    parameters: { type: 'object', properties: { path: { type: 'string' } } } }], 'server tools are dropped; $schema removed');
  assert.equal(responses.tool_choice, 'auto');
  assert.equal(responses.parallel_tool_calls, false);
  assert.deepEqual(responses.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read README' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reading.' }] },
    { type: 'function_call', call_id: 'toolu_1', name: 'Read', arguments: '{"path":"README.md"}' },
    { type: 'function_call_output', call_id: 'toolu_1', output: 'Error: denied' },
    { type: 'message', role: 'user', content: [
      { type: 'input_text', text: '[Attachment returned by tool call toolu_1]' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
      { type: 'input_text', text: 'Try again' }
    ] }
  ], 'Responses history carries no unsigned reasoning items');

  const disabled: any = anthropicMessagesToUpstream({ model: 'gpt-5.5', max_tokens: 10, thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }] }, { wireProtocol: 'responses' });
  assert.equal(disabled.reasoning, undefined, 'disabled thinking sends no effort');
  const budget = (budget_tokens: number) => (anthropicMessagesToUpstream({ model: 'gpt-5.5', max_tokens: 10,
    thinking: { type: 'enabled', budget_tokens }, messages: [] }, { wireProtocol: 'responses' }) as any).reasoning?.effort;
  assert.deepEqual([budget(1024), budget(8192), budget(32000)], ['low', 'medium', 'high']);

  // --- Request: Messages → Chat Completions ------------------------------------
  const chat: any = anthropicMessagesToUpstream({ ...conversation, model: 'qwen3.8-max', temperature: 0.2,
    tool_choice: { type: 'tool', name: 'Read' } }, { wireProtocol: 'chat-completions', maxOutputTokens: 8192 });
  assert.equal(chat.model, 'qwen3.8-max');
  assert.equal(chat.max_tokens, 8192);
  assert.equal(chat.temperature, 0.2, 'non-reasoning models keep sampling knobs');
  assert.deepEqual(chat.stop, ['a', 'b', 'c', 'd'], 'Chat accepts at most four stop sequences');
  assert.equal(chat.stream, true);
  assert.deepEqual(chat.tool_choice, { type: 'function', function: { name: 'Read' } });
  assert.equal(chat.messages[0].role, 'system');
  assert.equal(chat.messages[0].content, 'You are a coding agent.\n\nBe brief.');
  const assistants = chat.messages.filter((message: any) => message.role === 'assistant');
  assert.equal(assistants.length, 1, 'one Anthropic assistant turn stays one Chat assistant message');
  const assistant = assistants[0];
  assert.equal(assistant.content, 'Reading.');
  assert.equal(assistant.tool_calls[0].id, 'toolu_1');
  assert.equal(assistant.tool_calls[0].function.name, 'Read');
  assert.equal(assistant.reasoning_content, 'Need the file.', 'Chat providers keep prior reasoning next to a tool call');
  const tool = chat.messages.find((message: any) => message.role === 'tool');
  assert.equal(tool.tool_call_id, 'toolu_1');
  assert.equal(tool.content, 'Error: denied');
  assert.equal(chat.tools[0].function.name, 'Read');
  assert.equal(chat.tools.length, 1);
  const gptChat: any = anthropicMessagesToUpstream({ model: 'gpt-5.5', max_tokens: 100, messages: [] }, { wireProtocol: 'chat-completions' });
  assert.equal(gptChat.max_tokens, undefined);
  assert.equal(gptChat.max_completion_tokens, 100, 'GPT-5 Chat uses max_completion_tokens');

  // --- Response (JSON) → Anthropic message --------------------------------------
  const fromResponses = responsesToAnthropicMessage({
    id: 'resp_abc', model: 'gpt-5.5', status: 'completed',
    output: [
      { type: 'reasoning', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
      { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"path":"a"}' }
    ],
    usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 } }
  }, 'fallback');
  assert.deepEqual(fromResponses, {
    id: 'msg_abc', type: 'message', role: 'assistant', model: 'gpt-5.5',
    content: [{ type: 'text', text: 'Done.' }, { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a' } }],
    stop_reason: 'tool_use', stop_sequence: null,
    usage: { input_tokens: 40, output_tokens: 20, cache_read_input_tokens: 60 }
  });
  assert.equal((responsesToAnthropicMessage({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
    output: [] }, 'm') as any).stop_reason, 'max_tokens');
  const fromChat: any = chatCompletionToAnthropicMessage({
    id: 'chatcmpl-xyz', model: 'qwen3.8-max',
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: 'Hi', reasoning_content: 'hidden',
      tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'Read', arguments: '{"path":"b"}' } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  }, 'fallback');
  assert.deepEqual(fromChat.content, [{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 'call_2', name: 'Read', input: { path: 'b' } }],
    'reasoning is not forged into an unsigned thinking block');
  assert.equal(fromChat.stop_reason, 'tool_use');
  assert.deepEqual(fromChat.usage, { input_tokens: 10, output_tokens: 5 });
  const replayed = parseSse(anthropicMessageAsSse(fromChat));
  assertWellFormed(replayed);
  assert.deepEqual(foldAnthropicSse(replayed).content, fromChat.content, 'buffered SSE replay preserves the message');

  const folded = responsesSseToResponse(sse([
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'late' }] } },
    { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [] } }
  ]));
  assert.equal((folded as any).output[0].content[0].text, 'late', 'empty final output falls back to done items');

  // --- Stream: Responses SSE → Anthropic SSE ------------------------------------
  const responsesStream = new ResponsesToAnthropicStream('gpt-5.5');
  const upstream = sse([
    { type: 'response.created', response: { id: 'resp_s', model: 'gpt-5.5' } },
    { type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'secret' },
    { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Hel' },
    { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'lo' },
    { type: 'response.output_item.done', item: { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Hello' }] } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"pa' },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_s', name: 'Read', arguments: '{"path":"c"}' } },
    { type: 'response.completed', response: { id: 'resp_s', model: 'gpt-5.5', status: 'completed',
      output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_s', name: 'Read', arguments: '{"path":"c"}' }],
      usage: { input_tokens: 7, output_tokens: 3 } } }
  ]);
  // Arbitrary chunk boundaries, including a split CRLF-free event separator.
  let streamed = '';
  for (let offset = 0; offset < upstream.length; offset += 37) streamed += responsesStream.feed(Buffer.from(upstream.slice(offset, offset + 37)));
  streamed += responsesStream.finish();
  const responsesEvents = parseSse(streamed);
  assertWellFormed(responsesEvents);
  assert.equal(responsesEvents[0].data.message.id, 'msg_s');
  const responsesFold = foldAnthropicSse(responsesEvents);
  assert.deepEqual(responsesFold.content, [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 'call_s', name: 'Read', input: { path: 'c' } }],
    'text streams once, reasoning is hidden, the tool call is emitted once');
  assert.equal(responsesFold.stop, 'tool_use');
  assert.deepEqual(responsesFold.usage, { input_tokens: 7, output_tokens: 3 });
  assert.deepEqual(responsesStream.rawUsage(), { input_tokens: 7, output_tokens: 3 });

  const truncated = new ResponsesToAnthropicStream('gpt-5.5');
  const truncatedEvents = parseSse(truncated.feed(sse([{ type: 'response.output_text.delta', delta: 'partial' }])) + truncated.finish());
  assert.equal(truncatedEvents.at(-1)!.event, 'error', 'a stream cut before completion is an error, not a clean end_turn');
  const failed = new ResponsesToAnthropicStream('gpt-5.5');
  const failedEvents = parseSse(failed.feed(sse([{ type: 'response.failed', response: { error: { message: 'quota' } } }])) + failed.finish());
  assert.deepEqual(failedEvents.map(event => event.event), ['error']);
  assert.equal(failedEvents[0].data.error.message, 'quota');

  // --- Stream: Chat SSE → Anthropic SSE -----------------------------------------
  const chatStream = new ChatToAnthropicStream('qwen3.8-max');
  const chatUpstream = sse([
    { id: 'chatcmpl-1', model: 'qwen3.8-max', choices: [{ index: 0, delta: { role: 'assistant', content: '<thi' } }] },
    { id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: 'nk>plan</think>\n\nAns' } }] },
    { id: 'chatcmpl-1', choices: [{ index: 0, delta: { reasoning_content: 'hidden' } }] },
    { id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: 'wer' } }] },
    { id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_c', function: { name: 'Read', arguments: '{"pa' } }] } }] },
    { id: 'chatcmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"d"}' } }] } }] },
    { id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { id: 'chatcmpl-1', choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } } },
    '[DONE]'
  ]);
  const chatEvents = parseSse(chatStream.feed(chatUpstream) + chatStream.finish());
  assertWellFormed(chatEvents);
  const chatFold = foldAnthropicSse(chatEvents);
  assert.deepEqual(chatFold.content, [{ type: 'text', text: 'Answer' }, { type: 'tool_use', id: 'call_c', name: 'Read', input: { path: 'd' } }],
    'inline <think> and reasoning_content stay out of the answer');
  assert.equal(chatFold.stop, 'tool_use');
  assert.deepEqual(chatFold.usage, { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 });

  const noDone = new ChatToAnthropicStream('m');
  const noDoneFold = foldAnthropicSse(parseSse(noDone.feed(sse([
    { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'length' }] }
  ])) + noDone.finish()));
  assert.equal(noDoneFold.stop, 'max_tokens', 'finish_reason without [DONE] still completes');
  const cut = new ChatToAnthropicStream('m');
  const cutEvents = parseSse(cut.feed(sse([{ choices: [{ index: 0, delta: { content: 'par' } }] }])) + cut.finish());
  assert.equal(cutEvents.at(-1)!.event, 'error');
  const midError = new ChatToAnthropicStream('m');
  assert.equal(parseSse(midError.feed(sse([{ error: { message: 'boom' } }])) + midError.finish()).at(-1)!.data.error.message, 'boom');

  // --- Errors and count_tokens --------------------------------------------------
  assert.deepEqual(anthropicErrorBody(429, { error: { message: 'slow down', type: 'rate_limit' } }),
    { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });
  assert.deepEqual(anthropicErrorBody(401, 'bad key'), { type: 'error', error: { type: 'authentication_error', message: 'bad key' } });
  assert.equal(anthropicErrorBody(500, {}).error && (anthropicErrorBody(500, {}) as any).error.type, 'api_error');
  const ascii = estimateAnthropicInputTokens({ messages: [{ role: 'user', content: 'x'.repeat(400) }] });
  const cjk = estimateAnthropicInputTokens({ messages: [{ role: 'user', content: '中'.repeat(400) }] });
  assert(ascii >= 100 && ascii < 150, `ascii estimate ${ascii}`);
  assert(cjk >= 400 && cjk < 450, `CJK estimate ${cjk}`);

  console.log('PASS Claude Messages ↔ Responses / Chat bridge');
}
