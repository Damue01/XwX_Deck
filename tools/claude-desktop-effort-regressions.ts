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

const defaults = { fable: '', opus: 'claude-opus-5', sonnet: 'deepseek-v4-flash', haiku: '' };
const legacyDeepSeek = 'claude-sonnet-4-6-327156033800268087906663732885483040381';

// Desktop 2.7032.0.0's built-in thinking lookup normalizes version/date
// suffixes. Merely passing its vendor-name check does not enable its menu.
function desktopThinkingModel(name: string): string {
  return name.replace(/\[[^\]]+\]$/, '').replace(/-v\d+(?::\d+)?$/, '').replace(/-\d{8}$/, '');
}

export async function testClaudeDesktopEffortRegressions(root: string): Promise<void> {
  const catalog: ModelCatalogEntry[] = [
    ...['deepseek-v4-flash', 'qwen3.8-max', 'glm-5.3', 'kimi-k3', 'claude-opus-5'].map(id => ({
      id, vendor: 'Fixture', protocols: ['anthropic-messages'] as const,
      clients: ['claude'] as const, contextWindow: 1_000_000
    })),
    { id: 'chat-only', vendor: 'Fixture', protocols: ['chat-completions'], clients: ['codex'] }
  ];
  const models = buildClaudeDesktopModels(catalog, defaults);
  const deepSeek = models.find(model => model.id === 'deepseek-v4-flash')!;
  assert.equal(deepSeek.legacyName, legacyDeepSeek);
  assert.notEqual(desktopThinkingModel(legacyDeepSeek), 'claude-sonnet-4-6', 'reproduce the old missing menu');
  assert.deepEqual(buildClaudeDesktopModels([...catalog].reverse(), defaults), models, 'catalog order cannot change routing');
  assert.equal(models.length, 5, 'Chat-only models are still excluded');
  for (const model of models) {
    assert.equal(model.label, model.id, 'display names keep the original service model ID');
    if (model.id === 'claude-opus-5') assert.equal(model.name, model.id);
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
    gatewayAuthScheme: 'bearer', mode: 'local', catalog, models: defaults
  });
  const profilePath = path.join(root, 'local', 'Claude-3p', 'configLibrary', '00000000-0000-4000-8000-000000157220.json');
  const profile = JSON.parse(await fs.readFile(profilePath, 'utf8'));
  assert.deepEqual(profile.inferenceModels.map((model: any) => model.name), models.map(model => model.name));
  assert.equal(profile.inferenceModels.find((model: any) => model.name === deepSeek.name).labelOverride, deepSeek.id);
  assert.equal(profile.defaultModelEffort, undefined, 'sync must not reset the effort selected by the user');
  await manager.restore();

  const received: Array<{ url: string; body: Record<string, unknown> }> = [];
  const upstream = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    received.push({ url: request.url!, body });
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
      assert.deepEqual(received.at(-1), { url: `/anthropic/v1/messages${endpoint}`, body: { ...body, model: expectedModel } },
        'only the routing alias changes; thinking, effort, tools and message history must survive exactly');
    };
    for (const model of models) {
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
    assert.deepEqual(controllerTest.buildClaudeDesktopRoutes({ ...settings, providers: {
      ...settings.providers!, selected: { ...settings.providers!.selected, claude: 'official' }
    } }, catalog), [], 'official Claude remains outside the Desktop alias route');
  } finally {
    await proxy.stop();
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
  }
  console.log('PASS Claude Desktop effort lookup, old conversations, 1M aliases and Messages passthrough');
}
