import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as http from 'node:http';
import { once } from 'node:events';
import * as vm from 'node:vm';
import ts from 'typescript';
import WebSocket, { WebSocketServer } from 'ws';
import { TapProxy } from '../src/main/trace/tapProxy';
import { TraceStore } from '../src/main/trace/traceStore';
import { XwXDeckController } from '../src/main/app/xwxDeckController';
import { readCompatibleServiceModelCatalogCache, writeCompatibleServiceModelCatalogCache, type ModelCatalogEntry } from '../src/main/app/modelCatalog';

export async function testServiceSyncRegressions(root: string): Promise<void> {
  await testLiveWebSocketSwitch(path.join(root, 'ws-switch'));
  await testModelActionConcurrency();
  await testClaudeCatalogRefresh(path.join(root, 'claude-catalog-refresh'));
}

async function testLiveWebSocketSwitch(root: string): Promise<void> {
  const seen: string[] = [];
  let finishSlow: (() => void) | undefined;
  let slowReached!: () => void;
  const reached = new Promise<void>(resolve => { slowReached = resolve; });
  const official = http.createServer();
  const wss = new WebSocketServer({ server: official });
  wss.on('connection', ws => ws.on('message', raw => {
    const frame = JSON.parse(raw.toString());
    seen.push(String(frame.input));
    const respond = () => ws.send(JSON.stringify({ type: 'response.completed', response: {
      id: `resp_${frame.input}`, object: 'response', status: 'completed', model: frame.model,
      output: [{ id: `msg_${frame.input}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `reply ${frame.input}` }] }]
    } }));
    if (frame.input === 'slow') { finishSlow = respond; slowReached(); }
    else respond();
  }));
  let paperBody: any;
  const paper = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    paperBody = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'resp_paper', status: 'completed', output: [] }));
  });
  official.listen(0, '127.0.0.1');
  paper.listen(0, '127.0.0.1');
  await Promise.all([once(official, 'listening'), once(paper, 'listening')]);
  const url = (server: http.Server) => `http://127.0.0.1:${(server.address() as any).port}`;
  const proxy = new TapProxy(new TraceStore(root), [0]);
  const officialRoute = { source: 'codex-cli', path: '/v1/responses', apiType: 'responses', upstreamBaseUrl: url(official), defaultProtocol: 'responses', webSocket: 'official-responses' } as const;
  proxy.setClientRoutes([officialRoute]);
  const local = await proxy.start();
  const sockets: WebSocket[] = [];
  const open = async () => {
    const ws = new WebSocket(local.replace(/^http/, 'ws') + '/v1/responses', { headers: { 'user-agent': 'codex-cli/qa', originator: 'codex-tui', authorization: 'Bearer old-fixture-credential' } });
    sockets.push(ws);
    await once(ws, 'open', { signal: AbortSignal.timeout(5000) });
    return ws;
  };
  const send = (ws: WebSocket, input: string) => ws.send(JSON.stringify({ type: 'response.create', model: 'gpt-5.6-sol', input }));
  try {
    const ws = await open();
    let reply = once(ws, 'message', { signal: AbortSignal.timeout(5000) });
    send(ws, 'first');
    await reply;
    proxy.setClientRoutes([{ ...officialRoute, capture: false }]);
    assert.equal(ws.readyState, WebSocket.OPEN, 'recording-only updates retain the connection');
    reply = once(ws, 'message', { signal: AbortSignal.timeout(5000) });
    send(ws, 'slow');
    await reached;
    const closed = once(ws, 'close', { signal: AbortSignal.timeout(5000) });
    await proxy.markCodexProviderTransition('official', 'compatible');
    proxy.setClientRoutes([{ source: 'codex-cli', path: '/v1/responses', apiType: 'responses', upstreamBaseUrl: url(paper), defaultProtocol: 'responses', compatibleServiceGateway: true }]);
    assert.equal(ws.readyState, WebSocket.OPEN, 'an active response must finish');
    send(ws, 'must-not-reach-official');
    finishSlow!();
    assert.match(String((await reply)[0]), /response.completed/);
    assert.equal((await closed)[0], 1000);
    assert.deepEqual(seen, ['first', 'slow']);
    const response = await fetch(`${local}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'codex-cli/qa' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', previous_response_id: 'resp_slow', input: 'after switch' })
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.match(JSON.stringify(paperBody), /reply slow/, 'the drained WS continuation is available to HTTP immediately after close');
    assert.equal(paperBody.previous_response_id, undefined);
    proxy.setClientRoutes([officialRoute]);
    const idle = await open();
    const idleClosed = once(idle, 'close', { signal: AbortSignal.timeout(5000) });
    proxy.setClientRoutes([{ ...officialRoute, blockedBearerToken: 'old-fixture-credential', replacementBearerToken: 'new-fixture-credential' }]);
    assert.equal((await idleClosed)[0], 1000, 'idle connections retire when effective upstream credentials change');
  } finally {
    for (const ws of sockets) ws.terminate();
    await proxy.stop();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await Promise.all([new Promise<void>(resolve => official.close(() => resolve())), new Promise<void>(resolve => paper.close(() => resolve()))]);
  }
}

async function testModelActionConcurrency(): Promise<void> {
  const source = await fs.readFile(path.resolve('src/renderer/features/models/ModelsPage.tsx'), 'utf8');
  const tree = ts.createSourceFile('ModelsPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const callbacks = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer
      && ['handleCodexModelChange', 'handleClaudeModelChange', 'handleProviderChange', 'loadCodexCatalog', 'loadClaudeCatalog', 'refreshModelSelection', 'repairCodexConfig'].includes(node.name.getText(tree))) {
      callbacks.set(node.name.getText(tree), (ts.isCallExpression(node.initializer) ? node.initializer.arguments[0] : node.initializer).getText(tree));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
  };
  const calls: string[] = [];
  const patched: any[] = [];
  const shownCatalogs: string[][] = [];
  const cfg = { mode: 'official', configOwnership: 'deck', activeProvider: 'openai', officialModel: 'gpt-5.5',
    modelCatalogSource: 'none', compatible: { model: 'gpt-5.6-sol' } };
  const pending = new Map<string, ReturnType<typeof deferred<any>>>();
  const context: any = vm.createContext({
    Date, setTimeout, clearTimeout,
    waitForModelCatalog: async (request: Promise<boolean>) => await request ? 'ready' : 'failed',
    React: { createElement: (...args: unknown[]) => ({ args }) },
    codexOperationRef: { current: false }, claudeOperationRef: { current: false },
    repairingCodexRef: { current: false },
    providerSwitchGeneration: { current: { codex: 0, claude: 0 } },
    selectionReadRequest: { current: { codex: 0, claude: 0 } },
    unsavedClaudeModels: { current: {} },
    currentProviderIds: { current: { codex: null, claude: null } },
    visibleClient: { current: 'codex' },
    codexCatalogRequest: { current: 0 }, claudeCatalogRequest: { current: 0 },
    codexConfig: cfg, codexProviderId: null, claudeProviderId: null, codexChoiceByLabel: new Map(),
    setProviderChoice: () => {}, setBusyClaude: () => {}, setClaudeModels: () => {},
    setClaudeProviderCatalog: () => {}, setServices: () => {}, setBusyCodex: () => {},
    setCodexConfig: (value: any) => { patched.push({ config: value }); },
    setCatalog: (models: Array<{ id: string }>) => { shownCatalogs.push(models.map(model => model.id)); },
    clearLifecycleNotice: () => {}, closeToast: () => {}, showLifecycleNotice: () => {}, showToast: () => {}, showErrorToast: () => {},
    lifecycleFailure: () => ({}), repairProviderSwitch: () => {}, runNoticeAction: () => {},
    providerFailureAction: (_error: unknown, _id: unknown, label: string, retry: () => void) => ({ children: label, onClick: retry }),
    confirm: async () => true, normalizeErrorMessage: (error: unknown) => String(error),
    modelCatalogFailureMessage: (error: unknown) => String(error),
    bridge: { compatibleServiceConfig: {}, patch: (value: any) => { patched.push(value); }, api: {
      switchClientProvider: async ({ providerId }: any) => {
        calls.push(providerId);
        const request = deferred<any>(); pending.set(providerId, request); return request.promise;
      },
      updateCodexConfig: async () => cfg,
      getCodexConfig: async () => cfg, getClaudeModels: async () => ({}),
      fetchModels: async ({ expectedProviderId }: any) => [{ id: expectedProviderId ?? 'official-model' }]
    } }
  });
  const load = (name: string) => vm.runInContext(ts.transpile(`(${callbacks.get(name)})`, {
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React
  }), context);
  context.loadCodexCatalog = load('loadCodexCatalog');
  context.loadClaudeCatalog = load('loadClaudeCatalog');
  context.refreshModelSelection = load('refreshModelSelection');
  const choose = load('handleProviderChange');
  const first = choose('codex', 'A');
  const second = choose('codex', 'B');
  assert.deepEqual(calls, ['A', 'B'], 'a second explicit provider choice is accepted while the first is pending');
  pending.get('B')!.resolve({ active: { codex: 'B' } });
  await second;
  pending.get('A')!.resolve({ active: { codex: 'A' } });
  await first;
  assert.deepEqual(patched.filter(p => p.providers).map(p => p.providers.active.codex), ['B'],
    'a late response to A must not overwrite the newer B selection');
  assert.equal(context.codexOperationRef.current, false);

  const save = deferred<any>();
  context.bridge.api.updateCodexConfig = () => save.promise;
  const model = load('handleCodexModelChange');
  const saving = model('old-model');
  const third = choose('codex', 'C');
  save.resolve({ ...cfg, officialModel: 'old-model' });
  await saving;
  assert.equal(context.codexOperationRef.current, true, 'old model completion must not unlock the newer provider operation');
  pending.get('C')!.resolve({ active: { codex: 'C' } });
  await third;
  assert.equal(patched.some(p => p.config?.officialModel === 'old-model'), false);

  const repairing = deferred<any>();
  context.bridge.api.repairInvalidCodexConfiguration = () => repairing.promise;
  const repair = load('repairCodexConfig');
  const oldRepair = repair();
  await Promise.resolve();
  const fourth = choose('codex', 'D');
  const beforeOldRepair = patched.length;
  repairing.resolve({ mode: 'official', conflicts: [] });
  await oldRepair;
  assert.equal(patched.length, beforeOldRepair, 'a late repair must not refresh over a newer provider choice');
  assert.equal(context.codexOperationRef.current, true, 'a late repair must not unlock a newer provider switch');
  pending.get('D')!.resolve({ active: { codex: 'D' } });
  await fourth;
  assert.equal(context.codexOperationRef.current, false);

  shownCatalogs.length = 0;
  context.currentProviderIds.current.codex = null;
  const old = deferred<any[]>();
  const current = deferred<any[]>();
  let requests = 0;
  context.bridge.api.fetchModels = () => ++requests === 1 ? old.promise : current.promise;
  const oldLoad = context.loadCodexCatalog(false, true, null);
  const newLoad = context.loadCodexCatalog(false, true, null);
  current.resolve([{ id: 'new-service-model' }]); await newLoad;
  old.resolve([{ id: 'old-service-model' }]); await oldLoad;
  assert.deepEqual(shownCatalogs, [['new-service-model']]);

  let toasts = 0;
  context.showToast = () => { toasts += 1; };
  context.bridge.api.fetchModels = async () => { throw new Error('服务连接已变化，请重新加载模型。'); };
  await context.loadCodexCatalog(false, true, null);
  assert.equal(toasts, 0, 'superseded directory requests must stay silent');

  // Empty/bootstrap-failed role settings must not turn a visible model choice
  // into a silent no-op. The backend still receives the explicit target id.
  context.claudeProviderId = 'claude-A';
  context.currentProviderIds.current.claude = 'claude-A';
  context.claudeModels = null;
  context.setClaudeModels = (value: any) => {
    context.claudeModels = typeof value === 'function' ? value(context.claudeModels) : value;
  };
  let savedPatch: any;
  context.bridge.api.updateClaudeModels = async (patch: any) => {
    savedPatch = patch;
    return { fable: '', opus: '', sonnet: patch.sonnet, haiku: '' };
  };
  const saveClaude = load('handleClaudeModelChange');
  await saveClaude('sonnet', 'claude-custom');
  assert.equal(savedPatch.expectedProviderId, 'claude-A');
  assert.equal(context.claudeModels.sonnet, 'claude-custom');

  const staleRoles = deferred<any>();
  context.bridge.api.getClaudeModels = () => staleRoles.promise;
  const reading = context.refreshModelSelection('claude', 'claude-A');
  await saveClaude('sonnet', 'claude-new-choice');
  staleRoles.resolve({ fable: '', opus: '', sonnet: 'old-read', haiku: '' });
  await reading;
  assert.equal(context.claudeModels.sonnet, 'claude-new-choice', 'late model read must not overwrite a save');

  context.bridge.api.updateClaudeModels = async () => { throw new Error('disk unavailable'); };
  await saveClaude('opus', 'keep-failed-choice');
  context.bridge.api.getClaudeModels = async () => ({ fable: '', opus: 'old-saved-model', sonnet: 'claude-new-choice', haiku: '' });
  await context.refreshModelSelection('claude', 'claude-A');
  assert.equal(context.claudeModels.opus, 'keep-failed-choice', 'refresh must preserve the unsaved choice for retry');

  const claudeLists: string[][] = [];
  context.visibleClient.current = 'claude';
  context.setClaudeProviderCatalog = (models: Array<{ id: string }>) => claudeLists.push(models.map(model => model.id));
  const oldClaude = deferred<any[]>();
  context.bridge.api.fetchProviderModels = () => oldClaude.promise;
  const oldClaudeLoad = context.loadClaudeCatalog('claude-A', true, true);
  context.currentProviderIds.current.claude = 'claude-B';
  context.bridge.api.fetchProviderModels = async () => [{ id: 'claude-B-model' }];
  await context.loadClaudeCatalog('claude-B', true, true);
  oldClaude.resolve([{ id: 'claude-A-model' }]); await oldClaudeLoad;
  assert.deepEqual(claudeLists, [['claude-B-model']]);

  let retry: (() => void) | undefined;
  context.showToast = (_title: string, _type: string, _id: unknown, options: any) => { retry = options?.actionProps?.onClick; };
  context.bridge.api.fetchProviderModels = async () => { throw new Error('directory offline'); };
  assert.equal(await context.loadClaudeCatalog('claude-B', true), false);
  assert.equal(typeof retry, 'function', 'directory failure must offer a working retry');
  context.bridge.api.fetchProviderModels = async ({ providerId, refresh }: any) => {
    assert.equal(providerId, 'claude-B'); assert.equal(refresh, true);
    return [{ id: 'claude-retried' }];
  };
  retry!(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(claudeLists.at(-1), ['claude-retried']);

  // An existing cache must not hide a newly published model indefinitely.
  claudeLists.length = 0;
  const refreshed = deferred<any[]>();
  const cacheRequests: boolean[] = [];
  context.bridge.api.fetchProviderModels = async ({ refresh }: any) => {
    cacheRequests.push(refresh);
    return refresh ? refreshed.promise : [{ id: 'claude-opus-5' }];
  };
  assert.equal(await context.loadClaudeCatalog('claude-B', true), true,
    'the cached list must release foreground waiting while the network is still pending');
  assert.deepEqual(claudeLists, [['claude-opus-5']]);
  assert.deepEqual(cacheRequests, [false, true], 'reading a cache must also request the latest directory');
  const selectedModels = JSON.stringify(context.claudeModels);
  refreshed.resolve([{ id: 'claude-opus-5' }, { id: 'claude-opus-5-5' }]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(claudeLists.at(-1), ['claude-opus-5', 'claude-opus-5-5']);
  assert.equal(JSON.stringify(context.claudeModels), selectedModels, 'new directory entries must not change selected models');

  const lateRefresh = deferred<any[]>();
  context.bridge.api.fetchProviderModels = async ({ refresh }: any) => refresh ? lateRefresh.promise : [{ id: 'claude-B-cached' }];
  await context.loadClaudeCatalog('claude-B', true);
  context.currentProviderIds.current.claude = 'claude-C';
  context.bridge.api.fetchProviderModels = async () => [{ id: 'claude-C-model' }];
  await context.loadClaudeCatalog('claude-C', true, true);
  lateRefresh.resolve([{ id: 'claude-B-late' }]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(claudeLists.at(-1), ['claude-C-model'], 'a background result cannot replace the newer service list');

  context.bridge.api.fetchProviderModels = async ({ refresh }: any) => {
    if (refresh) throw new Error('background directory offline');
    return [{ id: 'claude-C-cached' }];
  };
  assert.equal(await context.loadClaudeCatalog('claude-C', true), true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(claudeLists.at(-1), ['claude-C-cached'], 'failed background refresh must retain the usable cache');

  // Background refresh errors must offer the same actionable feedback on both
  // clients while leaving cached models and the user's selection intact.
  for (const client of ['claude', 'codex']) {
    const notices: Array<{ title: string; options: any }> = [];
    let dismissed = 0;
    context.closeToast = () => { dismissed++; };
    context.visibleClient.current = client;
    context.currentProviderIds.current[client] = 'selected-provider';
    context.showToast = (title: string, _type: string, _key: unknown, options: any) => notices.push({ title, options });
    const lists = client === 'claude' ? claudeLists : shownCatalogs;
    const apiMethod = client === 'claude' ? 'fetchProviderModels' : 'fetchModels';
    const load = (notify = true) => client === 'claude'
      ? context.loadClaudeCatalog('selected-provider', notify)
      : context.loadCodexCatalog(false, notify, 'selected-provider');
    const refreshFailure = deferred<any[]>();
    context.bridge.api[apiMethod] = async ({ refresh }: any) => refresh
      ? refreshFailure.promise : [{ id: 'cached-model' }];
    await load();
    assert.deepEqual(lists.at(-1), ['cached-model']);
    refreshFailure.reject(new Error('HTTP 503 fixture'));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(notices.length, 1);
    assert.equal(notices[0].title, '模型列表刷新失败，已保留原列表');
    assert.match(notices[0].options.description, /503/);
    assert.equal(notices[0].options.actionProps.children, '重试列表');
    assert.deepEqual(lists.at(-1), ['cached-model']);
    context.bridge.api[apiMethod] = async (input: any) => {
      assert.equal(input.providerId ?? input.expectedProviderId, 'selected-provider');
      assert.equal(input.refresh, true);
      return [{ id: 'new-model-after-retry' }];
    };
    notices[0].options.actionProps.onClick();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(dismissed, 1, 'retry dismisses the old failure so a successful refresh does not look broken');
    assert.deepEqual(lists.at(-1), ['new-model-after-retry']);

    for (const reason of ['hidden', 'superseded', 'quiet']) {
      notices.length = 0;
      context.visibleClient.current = client;
      context.currentProviderIds.current[client] = 'selected-provider';
      const lateFailure = deferred<any[]>();
      context.bridge.api[apiMethod] = async ({ refresh }: any) => refresh
        ? lateFailure.promise : [{ id: 'cached-model' }];
      await load(reason !== 'quiet');
      if (reason === 'hidden') context.visibleClient.current = null;
      if (reason === 'superseded') context.currentProviderIds.current[client] = 'different-provider';
      lateFailure.reject(new Error('late background failure'));
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(notices.length, 0, reason + ': an irrelevant background request must not interrupt the current operation');
    }
  }
}

async function testClaudeCatalogRefresh(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  const provider = { id: 'initial-provider', adapter: 'auto', providerPreset: 'compatible', baseUrl: 'https://fixture.invalid/v1', bearerToken: 'fixture' };
  const file = path.join(root, 'provider-initial-provider-auto-models.json');
  const cached: ModelCatalogEntry[] = [{ id: 'claude-opus-5', vendor: 'Anthropic', protocols: ['anthropic-messages'],
    clients: ['claude', 'codex'], catalogEndpoints: ['anthropic'] }];
  await writeCompatibleServiceModelCatalogCache(file, provider.baseUrl, provider.bearerToken, cached, 'compatible');
  const controller = { userDataDir: root, settingsStore: { read: async () => ({ providers: { connections: [provider] } }) },
    scheduleClaudeDesktopSync: () => {} };
  const load = (refresh: boolean) => XwXDeckController.prototype.fetchProviderModels.call(controller as any, provider.id, refresh);
  const originalFetch = globalThis.fetch;
  let anthropicAvailable = false;
  let allOffline = false;
  let requests = 0;
  globalThis.fetch = async input => {
    requests++;
    const url = new URL(String(input));
    assert.equal(url.hostname, 'fixture.invalid', 'catalog tests must never request real services');
    if (allOffline || (url.pathname.includes('anthropic') && !anthropicAvailable)) return new Response('', { status: 503 });
    if (url.pathname.includes('gemini')) return new Response('', { status: 404 });
    return Response.json({ data: (url.pathname.includes('anthropic')
      ? ['claude-opus-5', 'claude-opus-5-5'] : ['gpt-5.5']).map(id => ({ id })) });
  };
  try {
    assert.deepEqual((await load(false)).map(model => model.id), ['claude-opus-5']);
    assert.equal(requests, 0, 'cached models remain immediately available');
    const partial = await load(true);
    assert(partial.some(model => model.id === 'claude-opus-5'), 'an unavailable Anthropic endpoint must not erase its cached models');
    assert(partial.some(model => model.id === 'gpt-5.5'), 'working directories can still update');
    anthropicAvailable = true;
    const fresh = await load(true);
    assert(fresh.some(model => model.id === 'claude-opus-5-5'), 'a forced refresh must discover the new Claude model');
    const saved = await readCompatibleServiceModelCatalogCache(file, provider.baseUrl, provider.bearerToken, 'compatible', true);
    assert(saved.some(model => model.id === 'claude-opus-5-5'), 'new model entries must persist for the next launch');
    const beforeFailure = await fs.readFile(file);
    allOffline = true;
    await assert.rejects(load(true), /模型列表请求失败/);
    assert.deepEqual(await fs.readFile(file), beforeFailure, 'a failed refresh must preserve the last successful cache');
  } finally {
    globalThis.fetch = originalFetch;
  }
}
