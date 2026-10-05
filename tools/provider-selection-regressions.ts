import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { XwXDeckController } from '../src/main/app/xwxDeckController';
import { XwXDeckSettingsStore } from '../src/main/app/settings';
import { CodexConfigManager } from '../src/main/trace/codexConfigManager';
import { restoreCodexPreferredDirectConfiguration } from '../src/main/trace/codexPreferredDirect';
import { resolveClientPaths } from '../src/main/trace/clientConfig';
import { waitForModelCatalog } from '../src/shared/modelCatalogWait';
import { enrichModelCatalogCacheFirst } from '../src/main/app/modelCapabilities';

export async function testProviderSelections(root: string): Promise<void> {
  const base = path.join(root, 'provider-selection');
  const codexHome = path.join(base, 'codex');
  const claudeHome = path.join(base, 'claude');
  const userData = path.join(base, 'data');
  const env = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, XWX_DECK_CLIENT_HOME: process.env.XWX_DECK_CLIENT_HOME };
  const originalFetch = globalThis.fetch;
  let controller: XwXDeckController | undefined;
  try {
    process.env.CODEX_HOME = codexHome;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    process.env.XWX_DECK_CLIENT_HOME = base;
    await fs.mkdir(codexHome, { recursive: true });
    await fs.mkdir(claudeHome, { recursive: true });
    await fs.writeFile(path.join(codexHome, 'config.toml'), 'model_provider = "openai"\nmodel = "gpt-5.5"\n');
    await fs.writeFile(path.join(codexHome, 'auth.json'), '{"auth_mode":"chatgpt","tokens":{"access_token":"fixture"}}');
    await fs.writeFile(path.join(claudeHome, 'settings.json'), '{}');
    let networkRequests = 0;
    globalThis.fetch = async () => { networkRequests += 1; throw new Error('isolated test: no network'); };
    const manager = new CodexConfigManager(userData);
    for (const provider of ['xwx_deck', 'external_legacy', 'OrdinaryProvider']) {
      for (const auth of [false, true, undefined]) {
        const text = `model_provider = "${provider}"\n[model_providers.${provider}]\nbase_url = "http://127.0.0.1:45233/backend-api/codex"\n`
          + (auth === undefined ? '' : `requires_openai_auth = ${auth}\n`);
        const result = await manager.readFromContent(text, resolveClientPaths());
        assert.equal(result.mode, auth === false || provider !== 'xwx_deck' ? 'compatible' : 'official');
      }
    }
    const capabilities = await enrichModelCatalogCacheFirst([
      { id: 'gpt-5.6-sol', vendor: 'fixture', protocols: ['openai-responses'], clients: ['codex'] }
    ], globalThis.fetch, path.join(base, 'missing-capabilities.json'));
    assert.equal(capabilities[0].id, 'gpt-5.6-sol');
    assert.equal(networkRequests, 0, 'showing model names must not wait for remote capability services');

    controller = new XwXDeckController(userData, { proxyListenPorts: [0], disableBackgroundModelRefresh: true,
      chatGptRunning: async () => false, codexHistoryMutationAllowed: async () => true });
    await controller.start();
    const store = new XwXDeckSettingsStore(userData);
    const a = await controller.saveProvider({ displayName: 'SelectionA', baseUrl: 'https://a.example.invalid/v1', bearerToken: 'fixture-a', adapter: 'responses', codexModel: 'gpt-5.5' });
    const aid = a.connections.find(p => p.displayName === 'SelectionA')!.id;
    const b = await controller.saveProvider({ displayName: 'SelectionB', baseUrl: 'https://b.example.invalid/v1', bearerToken: 'fixture-b', adapter: 'chat-completions', codexModel: 'deepseek-chat' });
    const bid = b.connections.find(p => p.displayName === 'SelectionB')!.id;
    const requestsBeforeSwitch = networkRequests;
    for (const id of [aid, bid, null, bid, aid, null, aid]) {
      const result = await controller.switchClientProvider('codex', id);
      assert.equal(result.active.codex, id);
      assert.equal((await controller.readProviders()).active.codex, id, 'readback must retain the saved selection');
      const written = await manager.read();
      assert.equal(written.mode, id ? 'compatible' : 'official');
      assert.equal(written.activeProvider, id === aid ? 'SelectionA' : id === bid ? 'SelectionB' : 'openai');
    }
    assert.equal(networkRequests, requestsBeforeSwitch, 'provider writes never request a model directory');

    await controller.enable('provider selection regression');
    for (const id of [bid, null, aid, bid]) {
      await controller.switchClientProvider('codex', id);
      assert.equal((await controller.readProviders()).active.codex, id);
      assert.equal((await manager.read()).mode, id ? 'compatible' : 'official');
    }
    await controller.disable();
    assert.equal((await manager.read()).activeProvider, 'SelectionB', 'disabling Trace preserves a conversion model provider');
    await controller.switchClientProvider('codex', aid);

    const internal = controller as any;
    const readConfig = internal.codexConfig.read.bind(internal.codexConfig);
    internal.codexConfig.read = async () => ({ mode: 'official' });
    assert.equal((await controller.readProviders()).active.codex, aid, 'a contradictory live read cannot undo intent');
    internal.codexConfig.read = readConfig;

    const writeConfig = internal.codexConfig.update.bind(internal.codexConfig);
    let writeAttempts = 0;
    internal.codexConfig.update = async () => { writeAttempts += 1; throw new Error('EPERM: fixture write failure'); };
    await assert.rejects(controller.switchClientProvider('codex', bid), /EPERM/);
    assert.equal(writeAttempts, 1, 'a real write failure must not trigger a second write of the old service');
    assert.equal((await controller.readProviders()).active.codex, bid);
    assert.equal((await store.read()).providers!.selected.codex, bid);
    assert.equal((await manager.read()).activeProvider, 'SelectionA', 'failed writes are reported without pretending the file changed');
    internal.codexConfig.update = writeConfig;
    await controller.switchClientProvider('codex', bid);

    const apply = internal.applyCodexConfigAndAuth.bind(internal);
    internal.applyCodexConfigAndAuth = async () => { throw new Error('fixture Gateway preparation failed'); };
    const unavailableGateway = await controller.switchClientProvider('codex', aid);
    assert.match(unavailableGateway.warning ?? '', /配置已保存/);
    assert.equal((await manager.read()).activeProvider, 'SelectionA');
    internal.applyCodexConfigAndAuth = apply;

    await controller.switchClientProvider('codex', bid);
    const chosen = await store.read();
    const restored = await restoreCodexPreferredDirectConfiguration(userData, {
      preferredMode: 'compatible', providerId: 'SelectionB', providerName: 'SelectionB', providerAdapter: 'chat-completions',
      requiresGateway: true, officialModel: 'gpt-5.5', compatibleModel: 'deepseek-chat', compatibleContextWindow: 0,
      compatibleBaseUrl: chosen.compatible.baseUrl, compatibleBearerToken: chosen.compatible.bearerToken
    });
    assert.equal(restored.mode, 'compatible');
    assert.equal((await manager.read()).activeProvider, 'SelectionB', 'stopping Trace cannot choose official for a conversion model');

    const c = await controller.saveProvider({ displayName: 'SelectionC', baseUrl: 'https://c.example.invalid/v1', bearerToken: 'fixture-c', adapter: 'anthropic-messages' });
    const cid = c.connections.find(p => p.displayName === 'SelectionC')!.id;
    await controller.switchClientProvider('codex', cid);
    internal.compatibleServiceCatalog = [];
    const fallbackCatalogPath = await internal.ensureCompatibleServiceModelCatalog('messages-without-directory');
    const fallbackCatalog = JSON.parse(await fs.readFile(fallbackCatalogPath, 'utf8'));
    assert.ok(fallbackCatalog.models.some((entry: { slug: string }) => entry.slug === 'messages-without-directory'),
      'missing Messages metadata must not block publishing the user-selected model');
    assert.equal((await manager.read()).activeProvider, 'SelectionC');
    await controller.switchClientProvider('codex', bid);
    await controller.switchClientProvider('claude', cid);
    const writeClaude = internal.claudeConfig.update.bind(internal.claudeConfig);
    let claudeWrites = 0;
    internal.claudeConfig.update = async () => { claudeWrites += 1; throw new Error('fixture Claude write failure'); };
    await assert.rejects(controller.switchClientProvider('claude', null), /fixture Claude write failure/);
    assert.equal(claudeWrites, 1);
    assert.equal((await controller.readProviders()).active.claude, null);
    internal.claudeConfig.update = writeClaude;
    await controller.switchClientProvider('claude', null);

    await controller.switchClientProvider('codex', null);
    const savedOfficial = await store.read();
    assert.equal(savedOfficial.codexPreferredMode, 'official');
    assert.equal(savedOfficial.providers!.selected.codex, bid, 'remembering the last API connection is separate from the active selection');
    assert.equal((await controller.readProviders()).active.codex, null);

    // Reproduce a fresh Deck startup with malformed TOML and saved enhancements.
    await controller.shutdown();
    await store.update({ codexEnhancements: { preserveOfficialLogin: true, unifySessionHistory: true } });
    const invalidConfig = 'model_provider = "openai"\n[broken\n';
    await fs.writeFile(path.join(codexHome, 'config.toml'), invalidConfig);
    const authBeforeRepair = await fs.readFile(path.join(codexHome, 'auth.json'));
    controller = new XwXDeckController(userData, { proxyListenPorts: [0], disableBackgroundModelRefresh: true,
      chatGptRunning: async () => false, codexHistoryMutationAllowed: async () => false });
    await controller.start();
    await assert.rejects(manager.read(), /config.toml/);
    const enhancementsBeforeRepair = await controller.readCodexEnhancements();
    assert.equal(enhancementsBeforeRepair.preserveOfficialLogin, true);
    assert.equal(enhancementsBeforeRepair.unifySessionHistory, true);
    assert.equal(enhancementsBeforeRepair.authMode, 'chatgpt');
    assert.equal(await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8'), invalidConfig,
      'reading enhancement preferences must not silently repair or overwrite the config');

    await assert.rejects(controller.switchClientProvider('codex', aid), /config.toml/);
    await controller.repairClientProviderSwitch('codex', aid);
    assert.equal((await manager.read()).mode, 'compatible');
    assert.deepEqual(await controller.readCodexEnhancements(), enhancementsBeforeRepair,
      'repairing provider configuration preserves independently stored enhancement preferences');
    assert.deepEqual(await fs.readFile(path.join(codexHome, 'auth.json')), authBeforeRepair);
    assert.equal((await controller.updateCodexEnhancements({ preserveOfficialLogin: false })).preserveOfficialLogin, false);
    assert.equal((await controller.updateCodexEnhancements({ unifySessionHistory: false })).unifySessionHistory, false);
    await controller.switchClientProvider('codex', null);
    const enhancementsAfterSwitch = await controller.readCodexEnhancements();
    assert.equal(enhancementsAfterSwitch.preserveOfficialLogin, false);
    assert.equal(enhancementsAfterSwitch.unifySessionHistory, false);
  } finally {
    await controller?.shutdown();
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }

  assert.equal(await waitForModelCatalog(Promise.resolve(true), Date.now()), 'ready');
  assert.equal(await waitForModelCatalog(Promise.reject(new Error('directory unavailable')), Date.now()), 'failed');
  let finish!: (ready: boolean) => void;
  const delayed = new Promise<boolean>(resolve => { finish = resolve; });
  const started = performance.now();
  assert.equal(await waitForModelCatalog(delayed, Date.now()), 'timeout');
  const elapsed = performance.now() - started;
  assert(elapsed >= 1_950 && elapsed < 2_200, `catalog wait exceeded its budget: ${elapsed}ms`);
  finish(true);
  assert.equal(await delayed, true, 'late results remain usable without reopening the switch');
  console.log(`Provider selection regressions passed; slow catalog released after ${Math.round(elapsed)}ms.`);
}
