import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { OFFICIAL_PROVIDERS, newProviderDraft } from '../src/shared/officialProviders';
import { providerNameError } from '../src/shared/providers';
import { TapProxy } from '../src/main/trace/tapProxy';
import { TraceStore } from '../src/main/trace/traceStore';
import { __test as controllerTest } from '../src/main/app/xwxDeckController';
import { XwXDeckSettingsStore } from '../src/main/app/settings';

/** Local requests validate preset protocol conversion and version-root joining; no vendor credentials. */
export async function testOfficialProviders(root: string): Promise<void> {
  const received: Array<{ url: string; authorization: string | undefined; body: any }> = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    received.push({ url: req.url!, authorization: req.headers.authorization, body });
    const switchModels = req.url?.includes('/switch/deepseek/') ? ['deepseek-v4-pro', 'deepseek-flash']
      : req.url?.includes('/switch/ark/') ? ['deepseek-v4-pro-260425']
      : req.url?.includes('/switch/official/') ? ['gpt-6.1-sol', 'gpt-6-luna'] : undefined;
    if (switchModels && !switchModels.includes(body.model)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `unsupported model: ${body.model}` } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url?.endsWith('/chat/completions') ? {
      id: 'chatcmpl-preset', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'preset route ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
    } : {
      id: 'resp_preset', object: 'response', status: 'completed', model: body.model,
      output: [{ id: 'msg_preset', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'preset route ok' }] }],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }
    }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert(address && typeof address === 'object');
  const testRoot = path.join(root, 'official-provider-presets');
  await fs.mkdir(testRoot, { recursive: true });
  const proxy = new TapProxy(new TraceStore(path.join(testRoot, 'trace')), [0]);
  proxy.setRecordingEnabled(false);
  try {
    const gateway = await proxy.start();
    for (const preset of OFFICIAL_PROVIDERS) {
      const draft = newProviderDraft([], preset.id);
      assert.equal(providerNameError(draft.displayName), undefined);
      assert.equal(draft.bearerToken, '');
      assert.equal(draft.codexModel, undefined);
      const connections = [{ displayName: draft.displayName, codexProviderId: `${draft.displayName}-2` }] as Parameters<typeof newProviderDraft>[0];
      assert.equal(newProviderDraft(connections, preset.id).displayName, `${draft.displayName}-3`);
      assert.equal(connections[0].displayName, draft.displayName);
      const pathname = new URL(draft.baseUrl).pathname.replace(/\/$/, '');
      proxy.setClientRoutes([{
        source: 'codex-cli', path: '/v1/responses', apiType: 'responses', transform: 'responses-to-chat-auto',
        upstreamBaseUrl: `http://127.0.0.1:${address.port}${pathname}`,
        defaultProtocol: preset.adapter, compatibleServiceGateway: true,
        upstreamBearerToken: 'local-preset-test-key'
      }]);
      const response = await fetch(`${gateway}/v1/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/preset-test' },
        body: JSON.stringify({ model: 'preset-test-model', input: 'hello', stream: false })
      });
      const result = await response.text();
      assert.equal(response.status, 200, `${preset.id}: ${result}`);
      assert.match(result, /preset route ok/);
      const request = received.at(-1)!;
      assert.equal(request.url, `${pathname || '/v1'}/${preset.adapter === 'responses' ? 'responses' : 'chat/completions'}`, preset.id);
      assert.equal(request.authorization, 'Bearer local-preset-test-key');
      assert.equal(request.body.model, 'preset-test-model');
      assert.ok(preset.adapter === 'responses' ? request.body.input : request.body.messages);
    }
    assert.deepEqual(newProviderDraft([], 'custom'), { displayName: 'Custom', baseUrl: '', bearerToken: '', adapter: 'auto' });

    const settings = await new XwXDeckSettingsStore(path.join(testRoot, 'settings')).read();
    const deepseek = { id: 'switch-deepseek', displayName: 'DeepSeek', providerPreset: 'auto' as const,
      adapter: 'responses' as const, codexApiFormat: 'responses' as const,
      baseUrl: `http://127.0.0.1:${address.port}/switch/deepseek/v1`, bearerToken: 'deepseek-fixture-key',
      codexModel: 'deepseek-v4-pro', codexContextWindow: 0, claudeModels: settings.claudeModels };
    const ark = { ...deepseek, id: 'switch-ark', displayName: 'Ark',
      adapter: 'chat-completions' as const, codexApiFormat: 'chat-completions' as const,
      baseUrl: `http://127.0.0.1:${address.port}/switch/ark/api/v3`, bearerToken: 'ark-fixture-key',
      codexModel: 'deepseek-v4-pro-260425' };
    const connections = [deepseek, ark];
    const selected = (provider: typeof deepseek | typeof ark) => ({ ...settings,
      compatible: provider, codexModels: { ...settings.codexModels, official: 'gpt-6.1-sol', compatible: provider.codexModel },
      providers: { version: 1 as const, connections, selected: { codex: provider.id, claude: null } } });
    const send = async (model: string, pathname = '/backend-api/codex/responses', expectedStatus = 200) => {
      const response = await fetch(`${gateway}${pathname}`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/preset-test', authorization: 'Bearer ark-fixture-key' },
        body: JSON.stringify({ model, input: 'provider switch fixture', stream: false }) });
      assert.equal(response.status, expectedStatus, await response.text());
      return received.at(-1)!;
    };
    const catalog = [deepseek.codexModel, 'deepseek-flash'].map(id => ({ id, vendor: 'fixture',
      protocols: ['openai-responses'] as const, clients: ['codex'] as const }));
    proxy.setClientRoutes(controllerTest.buildCodexGatewayRoutes(selected(deepseek), catalog));
    for (const pathname of ['/backend-api/codex/responses', '/v1/responses', '/v1/chat/completions', '/backend-api/codex/responses/compact']) {
      const request = await send('gpt-6.1-sol', pathname);
      assert.equal(request.body.model, deepseek.codexModel, 'cached official model must follow the selected provider model');
      assert.equal(request.authorization, 'Bearer deepseek-fixture-key');
    }
    assert.equal((await send('deepseek-flash')).body.model, 'deepseek-flash', 'valid models in the current directory remain selectable');
    assert.equal((await send('manual-unknown-model', '/v1/responses', 400)).body.model, 'manual-unknown-model',
      'unknown manual model names are never silently changed');

    // A multi-model target that supports the remembered official model keeps it.
    const multiModel = [...catalog, { ...catalog[0], id: 'gpt-6.1-sol' }];
    assert.equal(controllerTest.buildCodexGatewayRoutes(selected(deepseek), multiModel)
      .find(route => route.path === '/v1/responses')?.modelAliases?.['gpt-6.1-sol'], undefined);

    proxy.setClientRoutes(controllerTest.buildCodexGatewayRoutes(selected(ark)));
    const arkRequest = await send(deepseek.codexModel);
    assert.equal(arkRequest.body.model, ark.codexModel, 'provider-to-provider switch restores the target model');
    assert.equal(arkRequest.url, '/switch/ark/api/v3/chat/completions');
    assert.equal(arkRequest.authorization, 'Bearer ark-fixture-key');

    proxy.setClientRoutes(controllerTest.buildCodexOfficialGatewayRoutes(selected(ark), 'chatgpt', 'official-fixture-oauth',
      `http://127.0.0.1:${address.port}/switch/official/backend-api/codex`));
    const officialRequest = await send(ark.codexModel);
    assert.equal(officialRequest.body.model, 'gpt-6.1-sol', 'returning official translates the old provider model');
    assert.equal(officialRequest.authorization, 'Bearer official-fixture-oauth');
    assert.equal((await send('gpt-6-luna')).body.model, 'gpt-6-luna', 'official auxiliary models stay intact');
  } finally {
    await proxy.stop();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
}
