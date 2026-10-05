import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as http from 'node:http';
import { once } from 'node:events';
import { XwXDeckSettingsStore } from '../src/main/app/settings';
import { XwXDeckController } from '../src/main/app/xwxDeckController';
import { readCodexOfficialModelCatalog } from '../src/main/app/codexOfficialModelCatalog';

export async function testProviderRegistry(root: string): Promise<void> {
  const base = path.join(root, 'provider-registry');
  const codexHome = path.join(base, '.codex');
  const claudeHome = path.join(base, '.claude');
  const userData = path.join(base, 'data');
  const env = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, XWX_DECK_CLIENT_HOME: process.env.XWX_DECK_CLIENT_HOME };
  const originalFetch = globalThis.fetch;
  const requests: { path: string; authorization?: string; key?: string; cookie?: string; model?: string }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    requests.push({ path: req.url!, authorization: req.headers.authorization, key: req.headers['x-api-key'] as string, cookie: req.headers.cookie, model: body.model });
    res.setHeader('content-type', 'application/json');
    if (req.url?.includes('/no-directory') && req.url.endsWith('/models')) { res.statusCode = 404; res.end('{}'); return; }
    if (req.url?.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'gpt-5.5' }, { id: 'gpt-5.6-sol' }] })); return; }
    if (req.url?.endsWith('/chat/completions')) { res.end(JSON.stringify({ id: 'chat-provider-test', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })); return; }
    res.end(JSON.stringify({ id: 'resp-provider', status: 'completed', model: body.model, output: [{ id: 'msg-provider', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const upstream = `http://127.0.0.1.nip.io:${port}`;
  let controller: XwXDeckController | undefined;
  try {
    process.env.CODEX_HOME = codexHome; process.env.CLAUDE_CONFIG_DIR = claudeHome; process.env.XWX_DECK_CLIENT_HOME = base;
    await fs.mkdir(codexHome, { recursive: true }); await fs.mkdir(claudeHome, { recursive: true });
    const externalSection = '[model_providers.user_service]\nname = "My service"\nbase_url = "https://user.example/api"\nwire_api = "responses"\nexternal_option = "preserve"\n';
    await fs.writeFile(path.join(codexHome, 'config.toml'), 'model_provider = "openai"\nmodel = "gpt-5.5"\n' + externalSection);
    const auth = '{"auth_mode":"chatgpt","tokens":{"access_token":"official-fixture"}}\n';
    await fs.writeFile(path.join(codexHome, 'auth.json'), auth); await fs.writeFile(path.join(claudeHome, 'settings.json'), '{}\n');
    globalThis.fetch = async (input, init) => {
      if (!String(input).includes(`:${port}`) && !String(input).startsWith('http://127.0.0.1:')) throw new Error('isolated fixture');
      return originalFetch(input, init);
    };
    const store = new XwXDeckSettingsStore(userData);
    assert.equal((await store.read()).providers?.connections.length, 0, 'new installations never seed API connections');
    const legacyDir = path.join(base, 'legacy'); await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, 'settings.json'), JSON.stringify({ compatible: { displayName: 'My existing provider', baseUrl: `${upstream}/legacy/v1`, bearerToken: 'legacy-key' }, codexModels: { compatible: 'gpt-5.5', compatibleContextWindow: 272000 }, maxSessions: 50, maxStorageMB: 2048 }));
    const migrated = await new XwXDeckSettingsStore(legacyDir).read();
    assert.equal(migrated.providers?.connections.length, 1); assert.equal(migrated.providers?.connections[0].displayName, 'My existing provider');
    assert.equal(migrated.providers?.connections[0].codexModel, 'gpt-5.5'); assert.equal(migrated.maxSessions, 0);
    assert.equal(JSON.parse(await fs.readFile(path.join(legacyDir, 'settings.json'), 'utf8')).maxStorageMB, 0);
    controller = new XwXDeckController(userData, { proxyListenPorts: [0], disableBackgroundModelRefresh: true, chatGptRunning: async () => false, codexHistoryMutationAllowed: async () => true });
    await controller.start();
    const a = (await controller.saveProvider({ displayName: 'A', baseUrl: `${upstream}/a/api/responses`, bearerToken: 'key-a', adapter: 'responses', codexModel: 'gpt-5.6-sol' })).connections[0];
    const b = (await controller.saveProvider({ displayName: 'B', baseUrl: `${upstream}/b/v1`, bearerToken: 'key-b', adapter: 'chat-completions', codexModel: 'gpt-5.5' })).connections[1];
    assert.equal(a.baseUrl, `${upstream}/a/api`, 'full API endpoints normalize once without adding /v1');
    const noDirectory = (await controller.saveProvider({ displayName: 'No_directory', baseUrl: `${upstream}/no-directory`, bearerToken: 'key-manual', adapter: 'responses', codexModel: 'gpt-user-model' })).connections[2];
    assert.deepEqual(await controller.fetchProviderModels(noDirectory.id, true), [], '404 directory is not an invented model catalog');
    await controller.switchClientProvider('codex', a.id);
    await assert.rejects(controller.deleteProvider(a.id), /请先/);
    await controller.updateCodexConfig({ expectedProviderId: a.id, mode: 'compatible', compatibleModel: 'gpt-5.6-sol', compatibleBaseUrl: a.baseUrl, compatibleBearerToken: a.bearerToken, modelContextWindow: 1000000 });
    await controller.switchClientProvider('codex', b.id);
    await assert.rejects(controller.updateCodexConfig({ expectedProviderId: a.id, mode: 'compatible', compatibleModel: 'stale' }), /(?:连接|服务)已变化/);
    assert.equal((await controller.readCodexConfig()).compatible.model, b.codexModel);
    await controller.switchClientProvider('codex', a.id);
    assert.equal((await controller.readCodexConfig()).modelContextWindow, 1000000, 'A-B-A retains the selected context window');
    await controller.enable('registry routing regression');
    const config = await controller.readCodexConfig();
    const response = await originalFetch(`${config.activeBaseUrl}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/test', authorization: 'Bearer official-credential', 'x-api-key': 'foreign-key', cookie: 'foreign-cookie', 'chatgpt-account-id': 'foreign-account' }, body: JSON.stringify({ model: 'gpt-5.5', input: 'hello' }) });
    assert.equal(response.status, 200, await response.text());
    const sent = requests.find(r => r.path === '/a/api/responses'); assert.ok(sent); assert.equal(sent.authorization, 'Bearer key-a'); assert.equal(sent.key, undefined); assert.equal(sent.cookie, undefined);
    assert.equal(await fs.readFile(path.join(codexHome, 'auth.json'), 'utf8'), auth);
    assert.ok((await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8')).includes(externalSection), 'unrelated external provider sections remain byte stable');
    while ((controller as any).proxy.activeRequestCount() > 0) await new Promise(resolve => setTimeout(resolve, 10));
    await controller.disable();
    await controller.shutdown({ force: true, skipCodexHistoryRepair: true });
    const direct = await controller.readCodexConfig();
    assert.equal(direct.activeBaseUrl, a.baseUrl, 'Responses full shutdown preserves the exact API prefix');
    const directToml = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(directToml, /requires_openai_auth = true/, 'preserved ChatGPT account remains visible with a provider-scoped API key');
    assert.match(directToml, /experimental_bearer_token = "key-a"/);
    assert.equal(await fs.readFile(path.join(codexHome, 'auth.json'), 'utf8'), auth);
    await controller.start();
    await controller.switchClientProvider('codex', b.id);
    await controller.shutdown({ force: true, skipCodexHistoryRepair: true });
    assert.equal((await controller.readCodexConfig()).activeProvider, b.codexProviderId, 'full exit retains the explicit provider identity');
    await controller.start();
    assert.equal((await controller.readProviders()).active.codex, b.id, 'a protocol bridge resumes the saved selection');
    await controller.switchClientProvider('codex', a.id);
    const ownedContent = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
    const externallySelected = ownedContent.replace('model_provider = "A"', 'model_provider = "user_service"');
    assert.notEqual(externallySelected, ownedContent);
    await fs.writeFile(path.join(codexHome, 'config.toml'), externallySelected);
    assert.equal((await controller.readProviders()).active.codex, a.id, 'saved selection survives an external config change');
    assert.equal((await controller.readCodexConfig()).configOwnership, 'external');
    await controller.saveProvider({ ...a, displayName: 'A_edited_while_external' });
    assert.equal(await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8'), externallySelected, 'editing a saved provider preserves the external selection');
    await assert.rejects(controller.updateCodexConfig({ expectedProviderId: a.id, compatibleModel: 'stale' }), /(?:连接|服务)已变化|外部配置/);
    await assert.rejects(controller.updateCodexConfig({ expectedProviderId: null, compatibleModel: 'stale' }), /外部配置/);
    await fs.writeFile(path.join(codexHome, 'config.toml'), ownedContent);
    const internal = controller as any; const read = internal.codexConfig.read.bind(internal.codexConfig); internal.codexConfig.read = async () => { throw new Error('fixture unreadable config'); };
    try {
      assert.equal((await controller.readProviders()).connections.length, 3);
      await controller.saveProvider({ ...noDirectory, baseUrl: `${upstream}/new/v1`, bearerToken: 'key-new' });
    } finally { internal.codexConfig.read = read; }
    const claude = (await controller.saveProvider({ displayName: 'Independent_Claude', baseUrl: `${upstream}/claude/v1`, bearerToken: 'claude-key', adapter: 'anthropic-messages' })).connections.find(p => p.displayName === 'Independent_Claude')!;
    await controller.switchClientProvider('claude', claude.id);
    await controller.updateClaudeModels({ expectedProviderId: claude.id, sonnet: 'claude-user-model' });
    assert.equal((await controller.readProviders()).active.codex, a.id);
    assert.equal((await controller.readProviders()).active.claude, claude.id);
    const claudeConfig = JSON.parse(await fs.readFile(path.join(claudeHome, 'settings.json'), 'utf8'));
    assert.equal(claudeConfig.env.ANTHROPIC_BASE_URL, `${upstream}/claude`);
    assert.equal(claudeConfig.env.ANTHROPIC_API_KEY, 'claude-key');
    assert.equal(claudeConfig.env.ANTHROPIC_AUTH_TOKEN, undefined);
    await controller.saveProvider({ ...claude, adapter: 'responses' });
    assert.equal((await controller.readProviders()).active.claude, claude.id, 'Claude can retain a bridge-capable Responses connection');
    await controller.saveProvider({ ...claude, adapter: 'anthropic-messages' });
    await assert.rejects(controller.updateClaudeModels({ expectedProviderId: a.id, sonnet: 'stale' }), /(?:连接|服务)已变化/);
    await controller.switchClientProvider('claude', null);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(claudeHome, 'settings.json'), 'utf8')), {});
    await controller.switchClientProvider('codex', null);
    await controller.deleteProvider(a.id); await controller.deleteProvider(b.id); await controller.deleteProvider(noDirectory.id);
    for (const p of (await controller.readProviders()).connections) await controller.deleteProvider(p.id);
    assert.equal((await new XwXDeckSettingsStore(userData).read()).providers?.connections.length, 0, 'deleting the last connection survives restart');
    await fs.writeFile(path.join(codexHome, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-official-new', visibility: 'list', supported_in_api: true, context_window: 555000, input_modalities: ['text', 'image'] }, { slug: 'gpt-hidden', visibility: 'hide', supported_in_api: true }] }));
    assert.deepEqual((await readCodexOfficialModelCatalog('gpt-configured')).map(m => m.id), ['gpt-official-new', 'gpt-configured']);
    const brokenDir = path.join(base, 'broken'); await fs.mkdir(brokenDir, { recursive: true }); await fs.writeFile(path.join(brokenDir, 'settings.json'), '{broken');
    const broken = new XwXDeckSettingsStore(brokenDir); await broken.read(); await assert.rejects(broken.update({ theme: 'night' }), /禁止覆盖/); assert.equal(await fs.readFile(path.join(brokenDir, 'settings.json'), 'utf8'), '{broken');
  } finally {
    await controller?.shutdown({ force: true, skipCodexHistoryRepair: true }).catch(() => undefined);
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
