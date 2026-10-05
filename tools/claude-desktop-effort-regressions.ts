import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { __test as controllerTest } from '../src/main/app/xwxDeckController';
import { XwXDeckSettingsStore } from '../src/main/app/settings';
import type { ModelCatalogEntry } from '../src/main/app/modelCatalog';
import { ClaudeDesktopConfigManager } from '../src/main/trace/claudeDesktopConfigManager';
import { buildClaudeDesktopModels, buildClaudeDesktopModelAliases } from '../src/main/trace/claudeDesktopModels';
import { TapProxy } from '../src/main/trace/tapProxy';
import { TraceStore } from '../src/main/trace/traceStore';

const defaults = { fable: '', opus: 'claude-opus-5-5', sonnet: 'deepseek-v4-flash', haiku: '' };
const legacyDeepSeek = 'claude-sonnet-4-6-327156033800268087906663732885483040381';

// Desktop's built-in thinking lookup normalizes version/date suffixes for
// non-Claude compatibility aliases. Native IDs use the signed model catalog.
function desktopThinkingModel(name: string): string {
  return name.replace(/\[[^\]]+\]$/, '').replace(/-v\d+(?::\d+)?$/, '').replace(/-\d{8}$/, '');
}

export async function testClaudeDesktopEffortRegressions(root: string): Promise<void> {
  const catalog: ModelCatalogEntry[] = [
    ...['deepseek-v4-flash', 'qwen3.8-max', 'glm-5.3', 'kimi-k3', 'claude-opus-5', 'claude-opus-5-5'].map(id => ({
      id, vendor: 'Fixture', protocols: ['anthropic-messages'] as const,
      clients: ['claude'] as const, contextWindow: 1_000_000
    })),
    { id: 'chat-only', vendor: 'Fixture', protocols: ['chat-completions'], clients: ['codex'] }
  ];
  const models = buildClaudeDesktopModels(catalog, defaults);
  const deepSeek = models.find(model => model.id === 'deepseek-v4-flash')!;
  const opus55 = models.find(model => model.id === 'claude-opus-5-5')!;
  assert.equal(deepSeek.legacyName, legacyDeepSeek);
  assert.notEqual(desktopThinkingModel(legacyDeepSeek), 'claude-sonnet-4-6', 'reproduce the old missing menu');
  assert.deepEqual(buildClaudeDesktopModels([...catalog].reverse(), defaults), models, 'catalog order cannot change routing');
  assert.equal(models.length, 7, 'Chat-only models are listed; the Gateway bridges them');
  const chatOnly = models.find(model => model.id === 'chat-only')!;
  assert(chatOnly, 'Chat-only model is visible to Desktop');
  assert.equal(opus55.name, opus55.id, 'native Opus 5.5 keeps its upstream ID');
  assert.equal(opus55.legacyName, undefined, 'native Opus 5.5 needs no Gateway alias');
  assert.equal(opus55.tier, 'opus');
  assert.equal(buildClaudeDesktopModelAliases(models)[opus55.id], undefined,
    'native Opus 5.5 is sent to the provider unchanged');
  for (const model of models) {
    assert.equal(model.label, model.id, 'display names keep the original service model ID');
    if (model.id.startsWith('claude-opus-')) assert.equal(model.name, model.id);
    else {
      assert.equal(desktopThinkingModel(model.name), 'claude-sonnet-4-6', 'Desktop can resolve its effort menu');
      assert.equal(desktopThinkingModel(`${model.name}[1m]`), 'claude-sonnet-4-6');
    }
  }
  const colliding = buildClaudeDesktopModels([
    ...catalog,
    { id: deepSeek.name, vendor: 'Fixture', protocols: ['anthropic-messages'], clients: ['claude'] },
    { id: legacyDeepSeek, vendor: 'Fixture', protocols: ['anthropic-messages'], clients: ['claude'] }
  ], defaults);
  const collided = colliding.find(model => model.id === deepSeek.id)!;
  assert.equal(collided.name, `${deepSeek.name}:2`);
  assert.equal(collided.legacyName, `${legacyDeepSeek}-2`, 'old collision aliases also remain routable');
  assert.equal(desktopThinkingModel(collided.name), 'claude-sonnet-4-6', 'collision suffix must not hide effort again');
  const collisionAliases = buildClaudeDesktopModelAliases(colliding);
  assert.equal(collisionAliases[deepSeek.name], undefined, 'never shadow an actual upstream ID');
  assert.equal(collisionAliases[legacyDeepSeek], undefined);
  assert.equal(collisionAliases[collided.legacyName!], deepSeek.id);

  const manager = new ClaudeDesktopConfigManager(path.join(root, 'desktop-state'), {
    platform: 'win32', homeDir: path.join(root, 'home'), env: { LOCALAPPDATA: path.join(root, 'local') }
  });
  await manager.apply({
    gatewayBaseUrl: 'http://127.0.0.1:45678/claude-desktop', gatewayApiKey: 'fixture-key',
    gatewayAuthScheme: 'bearer', mode: 'local', catalog, models: defaults,
    directFallback: {
      gatewayBaseUrl: 'https://fixture.example/anthropic', gatewayApiKey: 'fixture-key',
      gatewayAuthScheme: 'bearer'
    }
  });
  const profilePath = path.join(root, 'local', 'Claude-3p', 'configLibrary', '00000000-0000-4000-8000-000000157220.json');
  const profile = JSON.parse(await fs.readFile(profilePath, 'utf8'));
  assert.deepEqual(profile.inferenceModels.map((model: any) => model.name), models.map(model => model.name));
  assert.equal(profile.inferenceModels.find((model: any) => model.name === deepSeek.name).labelOverride, deepSeek.id);
  assert.equal(profile.inferenceModels.find((model: any) => model.name === opus55.id).labelOverride, opus55.id);
  assert.equal(profile.modelCatalogEnabled, true, 'Desktop uses the signed catalog for native effort metadata');
  assert.equal(profile.defaultModelEffort, undefined, 'sync must not reset the effort selected by the user');
  const direct = await manager.restoreLocal();
  assert.equal(direct.mode, 'direct');
  const directProfile = JSON.parse(await fs.readFile(profilePath, 'utf8'));
  assert.equal(directProfile.inferenceModels.find((model: any) => model.name === opus55.id)?.name, opus55.id);
  assert.equal(directProfile.inferenceModels.find((model: any) => model.name === opus55.id)?.labelOverride, opus55.id);
  assert.equal(directProfile.modelCatalogEnabled, true, 'remote direct mode also uses the signed catalog');
  assert.equal(directProfile.defaultModelEffort, undefined);
  assert.equal(directProfile.inferenceModels.some((model: any) => model.labelOverride === chatOnly.id || model.name === chatOnly.id), false,
    'direct mode has no Gateway, so bridged models stay out of it');
  await manager.restore();

  const received: Array<{ url: string; body: Record<string, unknown>; headers?: http.IncomingHttpHeaders }> = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    received.push({ url: request.url!, body, headers: request.headers });
    if (request.url === '/api/v3/responses') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'resp_fixture', model: body.model, status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Responses bridge' }] }],
        usage: { input_tokens: 7, output_tokens: 3 } }));
      return;
    }
    if (request.url === '/v1/chat/completions') {
      const prompt = JSON.stringify(body.messages);
      if (prompt.includes('fail')) {
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'fixture quota', type: 'rate_limit' } }));
        return;
      }
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const chunk of [
          { id: 'chatcmpl-s', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] },
          { id: 'chatcmpl-s', choices: [{ index: 0, delta: { content: 'lo' } }] },
          { id: 'chatcmpl-s', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_s', function: { name: 'read_file', arguments: '{"path":"a"}' } }] } }] },
          { id: 'chatcmpl-s', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 9, completion_tokens: 2 } }
        ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.end('data: [DONE]\n\n');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'chatcmpl-j', model: body.model, choices: [{ index: 0, finish_reason: 'stop',
        message: { role: 'assistant', content: 'Bridged' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [] }));
  });
  const proxy = new TapProxy(new TraceStore(path.join(root, 'trace')), [0]);
  try {
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    assert(address && typeof address === 'object');
    const settings = await new XwXDeckSettingsStore(path.join(root, 'settings')).update({
      claudeModels: defaults,
      providers: {
        version: 1, identityVersion: 2, selected: { claude: 'fixture', codex: 'official' },
        connections: [{ id: 'fixture', displayName: 'Fixture', adapter: 'auto', providerPreset: 'compatible',
          baseUrl: `http://127.0.0.1:${address.port}/v1`, bearerToken: 'fixture-key',
          codexApiFormat: 'anthropic-messages', codexModel: '', codexContextWindow: 0, claudeModels: defaults }]
      }
    });
    const routes = controllerTest.buildClaudeDesktopRoutes(settings, catalog);
    assert.equal(routes.length, 1);
    proxy.setClientRoutes(routes.map(route => ({ ...route, capture: false })));
    const base = await proxy.start();
    const send = async (model: string, fields: Record<string, unknown>, expectedModel: string, endpoint = '') => {
      const body = { model, max_tokens: 1024, messages: [{ role: 'user', content: 'Fixture' }], ...fields };
      const response = await fetch(`${base}/claude-desktop/v1/messages${endpoint}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'claude-desktop/fixture' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const last = received.at(-1)!;
      assert.deepEqual({ url: last.url, body: last.body }, { url: `/anthropic/v1/messages${endpoint}`, body: { ...body, model: expectedModel } },
        'only the routing alias changes; thinking, effort, tools and message history must survive exactly');
    };
    for (const model of models) {
      if (model.id === chatOnly.id) continue;
      for (const effort of ['low', 'medium', 'high', 'max']) {
        await send(model.name, { thinking: { type: 'adaptive' }, output_config: { effort },
          tools: [{ name: 'read_file', input_schema: { type: 'object' } }] }, model.id);
      }
      if (model.legacyName) {
        await send(model.legacyName, { thinking: { type: 'enabled', budget_tokens: 1024 } }, model.id);
        await send(`${model.name}[1m]`, { output_config: { effort: 'high' } }, model.id);
        await send(`${model.legacyName}[1m]`, { output_config: { effort: 'max' } }, model.id);
      }
    }
    await send(deepSeek.name, { thinking: { type: 'disabled' } }, deepSeek.id);
    await send(deepSeek.name, {}, deepSeek.id, '/count_tokens');
    await send('claude-opus-5', { output_config: { effort: 'xhigh' } }, 'claude-opus-5');
    await send(`${opus55.id}[1m]`, { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } },
      `${opus55.id}[1m]`);

    // Chat-only model: Messages in, Chat Completions upstream, Messages out.
    assert.equal(routes[0].transform, 'messages-auto');
    assert.equal(routes[0].openAiBaseUrl, `http://127.0.0.1:${address.port}/v1`);
    const bridged = async (fields: Record<string, unknown>, endpoint = '') => {
      const before = received.length;
      const response = await fetch(`${base}/claude-desktop/v1/messages${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'claude-desktop/fixture',
          'anthropic-version': '2023-06-01', 'anthropic-beta': 'fixture-beta', authorization: 'Bearer desktop-local' },
        body: JSON.stringify({ model: chatOnly.name, max_tokens: 1024, messages: [{ role: 'user', content: 'Fixture' }],
          tools: [{ name: 'read_file', input_schema: { type: 'object' } }], ...fields }),
        signal: AbortSignal.timeout(5000)
      });
      return { response, text: await response.text(), upstream: received.slice(before) };
    };
    const counted = await bridged({}, '/count_tokens');
    assert.equal(counted.response.status, 200, counted.text);
    assert(JSON.parse(counted.text).input_tokens > 0);
    assert.equal(counted.upstream.length, 0, 'count_tokens is answered locally for bridged models');

    const plain = await bridged({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    assert.equal(plain.response.status, 200, plain.text);
    assert.equal(plain.upstream.length, 1);
    const sent = plain.upstream[0];
    assert.equal(sent.url, '/v1/chat/completions');
    assert.equal(sent.body.model, 'chat-only', 'Desktop alias is resolved before conversion');
    assert.deepEqual(sent.body.messages, [{ role: 'user', content: 'Fixture' }]);
    assert.equal((sent.body.tools as any[])[0].function.name, 'read_file');
    assert.equal(sent.body.thinking, undefined, 'Anthropic-only fields do not leak upstream');
    assert.equal(sent.body.output_config, undefined);
    assert.equal(sent.headers!['anthropic-version'], undefined, 'Anthropic headers are stripped');
    assert.equal(sent.headers!['anthropic-beta'], undefined);
    assert.equal(sent.headers!.authorization, 'Bearer fixture-key', 'the provider key replaces the local Desktop key');
    const message = JSON.parse(plain.text);
    assert.equal(message.type, 'message');
    assert.equal(message.role, 'assistant');
    assert.deepEqual(message.content, [{ type: 'text', text: 'Bridged' }]);
    assert.equal(message.stop_reason, 'end_turn');
    assert.deepEqual(message.usage, { input_tokens: 5, output_tokens: 1 });

    const streamed = await bridged({ stream: true });
    assert.equal(streamed.response.status, 200, streamed.text);
    assert.match(streamed.response.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(streamed.upstream[0].body.stream, true);
    const events = streamed.text.split('\n\n').filter(Boolean).map(block => {
      const lines = block.split('\n');
      return { event: lines.find(line => line.startsWith('event: '))?.slice(7),
        data: JSON.parse(lines.find(line => line.startsWith('data: '))!.slice(6)) };
    });
    assert.equal(events[0].event, 'message_start');
    assert.equal(events.at(-1)!.event, 'message_stop');
    assert.equal(events.filter(event => event.event === 'content_block_delta' && event.data.delta.type === 'text_delta')
      .map(event => event.data.delta.text).join(''), 'Hello');
    const toolStart = events.find(event => event.event === 'content_block_start' && event.data.content_block.type === 'tool_use');
    assert.equal(toolStart?.data.content_block.name, 'read_file');
    assert.equal(events.find(event => event.event === 'message_delta')?.data.delta.stop_reason, 'tool_use');

    const failure = await bridged({ messages: [{ role: 'user', content: 'fail please' }] });
    assert.equal(failure.response.status, 429, 'upstream status is kept so Claude clients retry correctly');
    assert.deepEqual(JSON.parse(failure.text), { type: 'error', error: { type: 'rate_limit_error', message: 'fixture quota' } });
    // Public connections keep their own version root and declared protocol.
    const responsesCatalog: ModelCatalogEntry[] = [{ id: 'responses-only', vendor: 'Fixture',
      protocols: ['openai-responses'], protocolsDeclared: true, clients: ['codex'] }];
    const responsesModel = buildClaudeDesktopModels(responsesCatalog, defaults)[0];
    const responsesSettings = { ...settings, providers: { ...settings.providers!, connections: [{
      ...settings.providers!.connections[0], adapter: 'responses' as const, providerPreset: 'custom' as const,
      baseUrl: `http://127.0.0.1:${address.port}/api/v3`, codexApiFormat: 'responses' as const
    }] } };
    proxy.setClientRoutes(controllerTest.buildClaudeDesktopRoutes(responsesSettings, responsesCatalog));
    const responseBridge = await fetch(`${base}/claude-desktop/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer desktop-local' },
      body: JSON.stringify({ model: responsesModel.name, max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] }),
      signal: AbortSignal.timeout(5000)
    });
    assert.equal(responseBridge.status, 200);
    const responseMessage = await responseBridge.json() as any;
    assert.equal(responseMessage.type, 'message');
    assert.deepEqual(responseMessage.content, [{ type: 'text', text: 'Responses bridge' }]);
    assert.equal(received.at(-1)!.url, '/api/v3/responses', 'no extra /v1 or discarded version root');
    assert.equal(received.at(-1)!.body.model, 'responses-only');
    assert.equal(received.at(-1)!.headers!.authorization, 'Bearer fixture-key');
    assert.deepEqual(controllerTest.buildClaudeDesktopRoutes({ ...settings, providers: {
      ...settings.providers!, selected: { ...settings.providers!.selected, claude: 'official' }
    } }, catalog), [], 'official Claude remains outside the Desktop alias route');
  } finally {
    await proxy.stop();
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
  console.log('PASS Claude Desktop effort lookup, old conversations, 1M aliases, Messages passthrough, Chat streaming and Responses version-root bridge');
}
