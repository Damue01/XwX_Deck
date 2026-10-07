import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { XwXDeckController } from '../src/main/app/xwxDeckController';
import { XwXDeckSettingsStore } from '../src/main/app/settings';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xwx-background-controller-'));
const userData = path.join(root, 'user-data');
const codexHome = path.join(root, '.codex');
const claudeHome = path.join(root, '.claude');
const previous = {
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  XWX_DECK_CLIENT_HOME: process.env.XWX_DECK_CLIENT_HOME,
  XWX_DECK_SMOKE_IGNORE_EXTERNAL: process.env.XWX_DECK_SMOKE_IGNORE_EXTERNAL
};
let upstream: http.Server | undefined;
let first: XwXDeckController | undefined;
let second: XwXDeckController | undefined;
const upstreamRequests: Array<{ pathname: string; authorization?: string }> = [];
let liveRequestStartedResolve: (() => void) | undefined;
let releaseLiveRequest: (() => void) | undefined;
let failModelPreflight = false;
let failEnableClientApply = false;

try {
  process.env.CODEX_HOME = codexHome;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.XWX_DECK_CLIENT_HOME = root;
  process.env.XWX_DECK_SMOKE_IGNORE_EXTERNAL = '1';
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(claudeHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'config.toml'), 'model_provider = "openai"\nmodel = "gpt-5.5"\n');
  await fs.writeFile(path.join(codexHome, 'auth.json'), '{"auth_mode":"chatgpt","tokens":{"access_token":"isolated-oauth"}}\n');
  await fs.writeFile(path.join(claudeHome, 'settings.json'), '{}\n');

  // A Dashboard request can beat controller startup. It must honor a custom
  // persisted Trace root before starting any helper, rather than orphaning a
  // default-root helper when start() later replaces the runtime object.
  const startupTraceRoot = path.join(root, 'custom-startup-trace');
  await new XwXDeckSettingsStore(userData).update({ traceRoot: startupTraceRoot });

  upstream = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    upstreamRequests.push({
      pathname,
      authorization: Array.isArray(req.headers.authorization)
        ? req.headers.authorization[0]
        : req.headers.authorization
    });
    if (pathname.endsWith('/models')) {
      if (failModelPreflight) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'isolated upstream unavailable' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'deepseek-chat', object: 'model' }] }));
      return;
    }
    const body = await readRequest(req);
    if (body.model === 'slow-live') {
      liveRequestStartedResolve?.();
      await new Promise<void>(resolve => { releaseLiveRequest = resolve; });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (pathname.endsWith('/chat/completions')) {
      res.end(JSON.stringify({
        id: 'chatcmpl_isolated',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'isolated ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }));
      return;
    }
    if (pathname.endsWith('/messages')) {
      res.end(JSON.stringify({
        id: 'msg_isolated_claude',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: 'isolated claude ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 }
      }));
      return;
    }
    res.end(JSON.stringify({
      id: 'resp_isolated',
      object: 'response',
      status: 'completed',
      model: body.model,
      output: [{
        id: 'msg_isolated',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'isolated ok' }]
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    }));
  });
  const upstreamPort = await listen(upstream, '0.0.0.0');
  const upstreamBaseUrl = `http://127.0.0.1.nip.io:${upstreamPort}/compatible/v1`;
  const officialBaseUrl = `http://127.0.0.1.nip.io:${upstreamPort}/official/v1`;
  const direct = await postJson(`${upstreamBaseUrl}/responses`, { model: 'direct-preflight', input: [] });
  assert.equal(direct.status, 200, `isolated 兼容服务 preflight failed: ${JSON.stringify(direct.body)}`);
  // Keep the rollback fixture fully local as well. Route preflight now runs
  // before the injected client-write failure, so leaving the default official
  // host here would make the smoke depend on public DNS/network availability.
  await fs.writeFile(path.join(codexHome, 'config.toml'), [
    'model_provider = "openai"',
    'model = "gpt-5.5"',
    `openai_base_url = "${officialBaseUrl}"`,
    ''
  ].join('\n'));
  await fs.writeFile(
    path.join(codexHome, 'auth.json'),
    '{"auth_mode":"api-key","OPENAI_API_KEY":"isolated-openai-key"}\n'
  );
  await fs.writeFile(path.join(claudeHome, 'settings.json'), `${JSON.stringify({
    env: { ANTHROPIC_BASE_URL: officialBaseUrl }
  }, null, 2)}\n`);

  first = new XwXDeckController(userData, {
    backgroundGateway: true,
    proxyListenPorts: [0],
    disableBackgroundModelRefresh: true,
    beforeEnableClientApply: async () => {
      if (failEnableClientApply) throw new Error('injected background enable failure');
    }
  });
  // A Dashboard request can arrive while the manager is still starting. Both
  // lifecycle operations must share the controller mutation queue: startup's
  // official-direct cleanup wins deterministically and no extra helper survives.
  await Promise.all([
    first.startProxy('startup-dashboard-race'),
    first.start()
  ]);
  let state = await first.runtimeState();
  assert.equal(state.readiness.codexGatewayEnabled, false);
  assert.equal(state.readiness.proxyListening, false, 'official direct cold start must not launch a helper');
  assert.equal(state.backgroundGatewayActive, false);
  assert.equal(state.backgroundGatewayAction, undefined, 'official direct idle mode must not expose a useless proxy action');
  assert.equal(state.traceRoot, startupTraceRoot, 'startup/dashboard race must use the persisted Trace root');
  assert.equal(first.requiresCodexClientExitBeforeShutdown(), false,
    'official direct mode must not bind ordinary ChatGPT lifecycle to XwX Deck');
  await assert.rejects(fs.stat(path.join(userData, 'gateway', 'runtime.json')), /ENOENT/);

  failEnableClientApply = true;
  await assert.rejects(first.enable('background-rollback-smoke'), /injected background enable failure/);
  failEnableClientApply = false;
  state = await first.runtimeState();
  assert.equal(state.tracingEnabled, false);
  assert.equal(state.readiness.proxyListening, false,
    'a failed background Trace enable must stop the helper it started');
  await assert.rejects(fs.stat(path.join(userData, 'gateway', 'runtime.json')), /ENOENT/);

  const shutdownGate = first.beginShutdown();
  const blockedMutation = first.startProxy('blocked-after-shutdown-intent');
  await shutdownGate;
  await assert.rejects(blockedMutation, /正在关闭代理/,
    'mutations queued after shutdown begins must not restart the Gateway');
  await first.cancelShutdown();

  // The Dashboard needs an HTTP helper to serve its local viewer, but that is
  // not a model proxy. It must neither expose the proxy menu action nor remain
  // resident after the manager exits.
  await first.startProxy('viewer-only-smoke');
  state = await first.runtimeState();
  assert.equal(state.backgroundGatewayActive, true, 'the Dashboard helper must be reachable while the manager is open');
  assert.equal(state.backgroundGatewayAction, undefined, 'a viewer-only helper must not be labelled as a model proxy');
  assert.equal(first.requiresCodexClientExitBeforeShutdown(), false,
    'closing a viewer-only helper must never require ChatGPT to exit');
  const viewerOnlyPort = Number(new URL(state.localBaseUrl!).port);
  assert.equal(await first.detachManager(), false, 'ordinary quit must stop rather than detach a viewer-only helper');
  await first.shutdown();
  await waitForClosed(viewerOnlyPort);

  // Exercise official Trace against the isolated upstream. API-key mode keeps
  // the test entirely local while following the same config-overlay path as a
  // real OpenAI subscription.
  await fs.writeFile(path.join(codexHome, 'config.toml'), [
    'model_provider = "openai"',
    'model = "gpt-5.5"',
    `openai_base_url = "${officialBaseUrl}"`,
    ''
  ].join('\n'));
  await fs.writeFile(
    path.join(codexHome, 'auth.json'),
    '{"auth_mode":"api-key","OPENAI_API_KEY":"isolated-openai-key"}\n'
  );

  failModelPreflight = true;
  await first.enable('official-preflight-failure-smoke');
  assert.equal((await first.runtimeState()).tracingEnabled, true,
    'upstream catalog health must not block local Trace configuration');
  failModelPreflight = false;

  await first.enable('official-reattach-smoke');
  state = await first.runtimeState();
  assert.equal(state.tracingEnabled, true);
  assert.equal(state.backgroundGatewayAction, 'close');
  assert.equal(state.readiness.codexGatewayEnabled, false);
  assert.equal(state.readiness.codexConfigReady, true);
  assert.equal(state.readiness.codexRouteReady, true);
  assert.equal(
    state.clients.find(client => client.id === 'codex-cli')?.statusText,
    '等待请求',
    'a newly enabled background Trace must wait for a real helper capture'
  );
  assert.equal(first.requiresCodexClientExitBeforeShutdown(), true,
    'explicitly closing an official Trace overlay must coordinate with a running ChatGPT process');
  let gatewayBase = state.localBaseUrl!;
  const firstOfficial = await postJson(`${gatewayBase}/v1/responses`, { model: 'gpt-5.5', input: [] });
  assert.equal(firstOfficial.status, 200, `official Trace request failed: ${JSON.stringify(firstOfficial.body)}`);
  const traceCountBeforeReattach = await waitForTraceCount(gatewayBase, 1);
  state = await first.runtimeState();
  assert.equal(
    state.clients.find(client => client.id === 'codex-cli')?.statusText,
    '追踪中',
    'the manager must read real capture ownership back from the helper'
  );
  const officialConfigBeforeDetach = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');

  assert.equal(await first.detachManager(), true);
  first = undefined;
  second = new XwXDeckController(userData, {
    backgroundGateway: true,
    proxyListenPorts: [0],
    disableBackgroundModelRefresh: true
  });
  await second.start();
  state = await second.runtimeState();
  assert.equal(state.tracingEnabled, true, 'manager reattach must restore the official Trace intent');
  assert.equal(state.localBaseUrl, gatewayBase, 'manager reattach must preserve the official Trace endpoint');
  assert.equal(state.readiness.codexGatewayEnabled, true,
    'manager reattach may promote the official Trace overlay to the persistent official fallback');
  assert.equal(state.readiness.codexConfigReady, true, 'official Trace config must still point at the helper');
  assert.equal(state.readiness.codexRouteReady, true, 'official Trace route must be republished on reattach');
  assert.equal(
    state.clients.find(client => client.id === 'codex-cli')?.statusText,
    '追踪中',
    'manager reattach must preserve the helper capture epoch'
  );
  assert.equal(
    await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8'),
    officialConfigBeforeDetach,
    'official Trace reattach must not rewrite config.toml'
  );
  const secondOfficial = await postJson(`${gatewayBase}/v1/responses`, { model: 'gpt-5.5', input: [] });
  assert.equal(secondOfficial.status, 200, `reattached official Trace request failed: ${JSON.stringify(secondOfficial.body)}`);
  assert.ok(
    await waitForTraceCount(gatewayBase, traceCountBeforeReattach + 1) > traceCountBeforeReattach,
    'the reattached manager must keep capturing official requests'
  );
  assert.equal(await second.disableBreaksCodex(), false,
    'an idle ChatGPT process must not make stopping Trace look destructive');
  const liveRequestStarted = new Promise<void>(resolve => { liveRequestStartedResolve = resolve; });
  const liveRequest = postJson(`${gatewayBase}/v1/responses`, { model: 'slow-live', input: [] });
  await liveRequestStarted;
  assert.equal(await second.disableBreaksCodex(), true,
    'a real in-flight conversation must trigger the stop warning');
  releaseLiveRequest?.();
  assert.equal((await liveRequest).status, 200);
  let liveAfterCompletion = true;
  for (let attempt = 0; attempt < 40 && liveAfterCompletion; attempt += 1) {
    liveAfterCompletion = await second.disableBreaksCodex();
    if (liveAfterCompletion) await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(liveAfterCompletion, false,
    'the warning must clear as soon as the live request finishes');

  first = second;
  second = undefined;
  await first.shutdown();
  await first.setBackgroundGatewayPaused(true, 'smoke close');
  state = await first.runtimeState();
  assert.equal(state.tracingEnabled, false);
  assert.equal(state.backgroundGatewayAction, 'open');
  await first.setBackgroundGatewayPaused(false, 'smoke reopen');
  await first.start();
  state = await first.runtimeState();
  assert.equal(state.tracingEnabled, true, 'opening the Gateway must restore the paused Trace intent');
  gatewayBase = state.localBaseUrl!;
  await first.disable();
  state = await first.runtimeState();
  assert.equal(state.tracingEnabled, false);
  assert.equal(state.readiness.recordingEnabled, false, 'stopping Trace must disable persistence immediately');
  assert.equal(state.readiness.codexGatewayEnabled, false,
    'stopping official Trace must restore direct service and stop the local Gateway');
  const claudeAfterTraceStop = JSON.parse(await fs.readFile(path.join(claudeHome, 'settings.json'), 'utf8'));
  assert.equal(claudeAfterTraceStop.env.ANTHROPIC_BASE_URL, officialBaseUrl,
    'stopping Trace must restore the on-disk Claude upstream for newly started clients');
  await waitForClosed(Number(new URL(gatewayBase).port));
  await assert.rejects(
    postJson(`${gatewayBase}/v1/responses`, { model: 'official-after-trace-stop', input: [] }),
    /fetch failed|ECONNREFUSED/i,
    'a stopped Trace must not keep serving cached localhost requests'
  );
  await first.shutdown();
  await assert.rejects(
    fs.stat(path.join(userData, 'gateway', 'client-fallbacks.json')),
    /ENOENT/,
    'a successful explicit proxy close must remove the persisted client fallback'
  );
  await first.setBackgroundGatewayPaused(true, 'smoke close official direct');
  state = await first.runtimeState();
  assert.equal(state.backgroundGatewayAction, undefined, 'official direct idle mode stays helper-free after a prior Trace pause');
  await first.setBackgroundGatewayPaused(false, 'smoke reset official direct');
  await new XwXDeckSettingsStore(userData).update({ gatewayPaused: false });

  // Keep the isolated official API-key fixture. It lets the 兼容服务 ->
  // official cached-endpoint test prove the final request reaches a distinct
  // official upstream without using the real OpenAI network.

  await first.updateCompatibleServiceConfig({
    baseUrl: upstreamBaseUrl,
    bearerToken: 'isolated-compatible-key',
    codexApiFormat: 'responses'
  });
  await first.updateCodexConfig({
    mode: 'compatible',
    compatibleModel: 'deepseek-chat',
    compatibleBaseUrl: upstreamBaseUrl,
    compatibleBearerToken: 'isolated-compatible-key'
  });
  await first.enable('compatible-gateway-smoke');
  state = await first.runtimeState();
  assert.equal(state.readiness.codexGatewayEnabled, true);
  assert.equal(state.readiness.proxyListening, true);
  assert.equal(state.backgroundGatewayActive, true);
  assert.equal(state.backgroundGatewayAction, 'close');
  assert.equal(first.requiresCodexClientExitBeforeShutdown(), true,
    'explicitly closing a 兼容服务 Gateway must coordinate with a running ChatGPT process');
  gatewayBase = state.localBaseUrl!;
  assert.match(await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8'), new RegExp(escapeRegExp(gatewayBase)));

  const compatibleServiceConfigBeforeTraceRootAttempt = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
  await assert.rejects(
    first.updateTraceDirectories({ traceRoot: path.join(root, 'blocked-compatible-trace-root') }),
    /停止 Trace|关闭代理/,
    'changing the Trace root must not tear down an active 兼容服务 data plane'
  );
  assert.equal(
    await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8'),
    compatibleServiceConfigBeforeTraceRootAttempt,
    'a rejected Trace-root change must keep the 兼容服务 client config byte-stable'
  );
  assert.equal(
    (await postJson(`${gatewayBase}/v1/responses`, { model: 'deepseek-chat', input: [] })).status,
    200,
    'a rejected Trace-root change must leave the 兼容服务 Gateway serving'
  );
  const compatibleServiceLogRoot = path.join(root, 'compatible-log-root');
  state = await first.updateTraceDirectories({ logRoot: compatibleServiceLogRoot });
  assert.equal(state.logRoot, compatibleServiceLogRoot, 'an active 兼容服务 Gateway must not block an independent log-root change');
  assert.equal(
    (await postJson(`${gatewayBase}/v1/responses`, { model: 'deepseek-chat', input: [] })).status,
    200,
    'an independent log-root change must leave the 兼容服务 Gateway serving'
  );

  const beforeDetachConfig = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
  assert.equal(await first.detachManager(), true);
  const throughDetached = await postJson(`${gatewayBase}/v1/responses`, { model: 'deepseek-chat', input: [] });
  assert.equal(throughDetached.status, 200, `detached manager must leave the data plane serving: ${JSON.stringify(throughDetached.body)}`);
  assert.equal(throughDetached.body.model, 'deepseek-chat');

  second = new XwXDeckController(userData, {
    backgroundGateway: true,
    proxyListenPorts: [0],
    disableBackgroundModelRefresh: true
  });
  await second.start();
  const afterAttachConfig = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
  assert.equal(afterAttachConfig, beforeDetachConfig, 'manager reattach must keep live config byte-stable');
  state = await second.runtimeState();
  assert.equal(state.localBaseUrl, gatewayBase, 'manager reattach must preserve the fixed gateway endpoint');
  assert.equal((await postJson(`${gatewayBase}/v1/responses`, { model: 'deepseek-chat', input: [] })).status, 200);

  await second.shutdown();
  await waitForClosed(Number(new URL(gatewayBase).port));
  const directCompatibleConfig = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
  assert.doesNotMatch(directCompatibleConfig, /127\.0\.0\.1:\d+/);
  assert.match(directCompatibleConfig, /^model_catalog_json = ".*xwx-compatible-catalog\.json"$/m,
    'detaching the Gateway into direct compatible mode must retain the static XwX catalog pointer');
  await second.setBackgroundGatewayPaused(true, 'smoke close 兼容服务');
  await second.start();
  state = await second.runtimeState();
  assert.equal(state.backgroundGatewayActive, false, 'a manually closed proxy must stay closed across manager restart');
  assert.equal(state.backgroundGatewayAction, 'open', 'paused 兼容服务 must expose the restore action');
  await second.setBackgroundGatewayPaused(false, 'smoke reopen 兼容服务');
  await second.startBackgroundGateway();
  state = await second.runtimeState();
  assert.equal(state.backgroundGatewayActive, true, 'opening the proxy must restore the saved 兼容服务 intent');
  assert.equal(state.backgroundGatewayAction, 'close');
  gatewayBase = state.localBaseUrl!;
  assert.equal((await postJson(`${gatewayBase}/v1/responses`, { model: 'deepseek-chat', input: [] })).status, 200);

  await second.updateCodexConfig({ mode: 'official', officialModel: 'gpt-5.5' });
  state = await second.runtimeState();
  assert.equal(state.readiness.codexGatewayEnabled, true, 'cached ChatGPT endpoint remains served after 兼容服务 -> official');
  assert.equal(state.localBaseUrl, gatewayBase);
  assert.equal(state.backgroundGatewayActive, true);

  const compatibleServiceRequestsBeforeOfficial = upstreamRequests.filter(item => item.pathname.startsWith('/compatible/')).length;
  const officialRequestsBeforeDetach = upstreamRequests.filter(item => item.pathname.startsWith('/official/')).length;
  const officialThroughGateway = await postJson(`${gatewayBase}/backend-api/codex/responses`, {
    model: 'gpt-5.5', input: []
  }, { authorization: 'Bearer isolated-compatible-key' });
  assert.equal(officialThroughGateway.status, 200, JSON.stringify(officialThroughGateway.body));
  assert.equal(
    upstreamRequests.filter(item => item.pathname.startsWith('/compatible/')).length,
    compatibleServiceRequestsBeforeOfficial,
    '兼容服务 -> official must stop sending requests to the 兼容服务 upstream'
  );
  const firstOfficialGatewayRequest = upstreamRequests
    .filter(item => item.pathname.startsWith('/official/'))
    .at(-1);
  assert.ok(firstOfficialGatewayRequest, 'the cached local endpoint must route to the isolated official upstream');
  assert.equal(firstOfficialGatewayRequest.authorization, 'Bearer isolated-openai-key');
  assert.notEqual(firstOfficialGatewayRequest.authorization, 'Bearer isolated-compatible-key');
  assert.ok(
    upstreamRequests.filter(item => item.pathname.startsWith('/official/')).length > officialRequestsBeforeDetach
  );

  const officialGatewayConfig = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
  assert.equal(await second.detachManager(), true);
  second = undefined;
  second = new XwXDeckController(userData, {
    backgroundGateway: true,
    proxyListenPorts: [0],
    disableBackgroundModelRefresh: true
  });
  await second.start();
  state = await second.runtimeState();
  assert.equal(state.readiness.codexGatewayEnabled, true,
    'a new manager must rehydrate the official route for ChatGPT cached on localhost');
  assert.equal(state.localBaseUrl, gatewayBase, 'official Gateway manager reattach must keep the cached endpoint alive');
  assert.equal(state.readiness.codexConfigReady, true);
  assert.equal(state.readiness.codexRouteReady, true);
  assert.equal(await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8'), officialGatewayConfig,
    'official Gateway manager reattach must keep config byte-stable');
  const officialAfterReattach = await postJson(`${gatewayBase}/backend-api/codex/responses`, {
    model: 'gpt-5.5', input: []
  }, { authorization: 'Bearer isolated-compatible-key' });
  assert.equal(officialAfterReattach.status, 200, JSON.stringify(officialAfterReattach.body));
  const lastOfficialRequest = upstreamRequests.filter(item => item.pathname.startsWith('/official/')).at(-1);
  assert.equal(lastOfficialRequest?.authorization, 'Bearer isolated-openai-key');
  assert.notEqual(lastOfficialRequest?.authorization, 'Bearer isolated-compatible-key');

  await second.shutdown();
  second = undefined;
  state = await first.runtimeState();
  await waitForClosed(Number(new URL(gatewayBase).port));
  const finalConfig = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
  assert.doesNotMatch(finalConfig, /127\.0\.0\.1:\d+/);
  assert.match(finalConfig, new RegExp(escapeRegExp(officialBaseUrl)));

  // A reinstall/reset can remove XwX Deck's 兼容服务 credential while Codex's
  // xwx_deck provider still points at the old localhost endpoint. Starting an
  // empty helper and then stopping it would leave a deterministic 502. A
  // missing connection cannot be reconstructed safely. Keep its bytes and
  // surface a repair action rather than silently selecting official service.
  const staleUserData = path.join(root, 'stale-compatible-user-data');
  const staleGatewayPort = await reserveFreePort();
  const staleCatalogPath = path.join(codexHome, 'xwx-compatible-catalog.json');
  await fs.writeFile(path.join(codexHome, 'config.toml'), [
    'model_provider = "xwx_deck"',
    'model = "deepseek-chat"',
    `model_catalog_json = "${staleCatalogPath.replace(/\\/g, '\\\\')}"`,
    `openai_base_url = "${officialBaseUrl}"`,
    '',
    '[model_providers.xwx_deck]',
    'name = "XwX Deck"',
    `base_url = "http://127.0.0.1:${staleGatewayPort}/backend-api/codex"`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    'supports_websockets = false',
    ''
  ].join('\n'));
  const recovered = new XwXDeckController(staleUserData, {
    backgroundGateway: true,
    proxyListenPorts: [staleGatewayPort],
    disableBackgroundModelRefresh: true
  });
  await recovered.start();
  const recoveredState = await recovered.runtimeState();
  assert.equal(recoveredState.backgroundGatewayActive, false,
    'missing 兼容服务 credentials must not leave an empty helper behind');
  const recoveredConfig = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
  assert.match(recoveredConfig, new RegExp(`127\\.0\\.0\\.1:${staleGatewayPort}`),
    'missing credentials must preserve the selected connection for explicit repair');
  assert.match(recoveredState.lastError ?? '', /不完整|补全|恢复/);
  await recovered.updateCodexConfig({ mode: 'official', takeOverExternalConfig: true });
  await recovered.shutdown();

  const foreignLoopback = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const foreignLoopbackPort = await listen(foreignLoopback);
  try {
    const foreignConfig = [
      'model_provider = "xwx_deck"',
      'model = "deepseek-chat"',
      `model_catalog_json = "${staleCatalogPath.replace(/\\/g, '\\\\')}"`,
      `openai_base_url = "${officialBaseUrl}"`,
      '',
      '[model_providers.xwx_deck]',
      'name = "External local manager"',
      `base_url = "http://127.0.0.1:${foreignLoopbackPort}/backend-api/codex"`,
      'wire_api = "responses"',
      'requires_openai_auth = true',
      ''
    ].join('\n');
    await fs.writeFile(path.join(codexHome, 'config.toml'), foreignConfig);
    const foreignUserData = path.join(root, 'live-foreign-user-data');
    const foreignAware = new XwXDeckController(foreignUserData, {
      backgroundGateway: true,
      proxyListenPorts: [await reserveFreePort()],
      disableBackgroundModelRefresh: true
    });
    await foreignAware.start();
    assert.equal(
      await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8'),
      foreignConfig,
      'missing 兼容服务 settings must not rewrite a live foreign loopback provider'
    );
    await foreignAware.shutdown();
  } finally {
    await close(foreignLoopback);
  }

  // Official direct mode deliberately has no helper. A short-lived broken
  // build could already have removed native official opaque rows before this
  // build is installed, so recovery must still run after ChatGPT exits without
  // starting a persistent Gateway just to access the portability ledger.
  const legacyRestoreUserData = path.join(root, 'official-direct-legacy-restore');
  const legacyStateFile = path.join(legacyRestoreUserData, 'codex-portability', 'opaque-origins.json');
  const legacyRelative = path.join('sessions', '2026', '08', '13', 'rollout-official-direct-restore.jsonl');
  const legacyRolloutFile = path.join(codexHome, legacyRelative);
  const mistakenOpaque = 'official-direct-mistakenly-removed';
  const confirmedCompatibleServiceOpaque = 'official-direct-confirmed-compatible';
  const originalLines = [
    `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'before' } })}\n`,
    `${JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: mistakenOpaque } })}\n`,
    `${JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: confirmedCompatibleServiceOpaque } })}\n`,
    `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: 'after' } })}\n`
  ];
  const appendedLine = `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'appended later' } })}\n`;
  await fs.writeFile(path.join(codexHome, 'config.toml'), 'model_provider = "openai"\nmodel = "gpt-5.5"\n');
  await fs.mkdir(path.dirname(legacyStateFile), { recursive: true });
  await fs.mkdir(path.dirname(legacyRolloutFile), { recursive: true });
  await fs.writeFile(legacyStateFile, JSON.stringify({
    version: 3,
    entries: {
      [createHash('sha256').update(mistakenOpaque).digest('hex')]: {
        upstream: 'transition:compatible',
        upstreamKind: 'compatible',
        kind: 'reasoning',
        seenAt: Date.now()
      },
      [createHash('sha256').update(confirmedCompatibleServiceOpaque).digest('hex')]: {
        upstream: 'compatible:test',
        upstreamKind: 'compatible',
        kind: 'reasoning',
        seenAt: Date.now()
      }
    },
    transition: { source: 'compatible', target: 'official', createdAt: Date.now() }
  }));
  await fs.writeFile(legacyRolloutFile, `${originalLines[0]}${originalLines[3]}${appendedLine}`);
  const repairGeneration = path.join(
    legacyRestoreUserData,
    'backups',
    'codex-portability-repair-v1',
    'broken-official-direct-generation'
  );
  const repairBackup = path.join(repairGeneration, 'jsonl', legacyRelative);
  await fs.mkdir(path.dirname(repairBackup), { recursive: true });
  await fs.writeFile(repairBackup, originalLines.join(''));
  await fs.writeFile(path.join(repairGeneration, 'manifest.json'), JSON.stringify({
    version: 1,
    createdAt: new Date().toISOString(),
    codexHome,
    targetKind: 'official',
    files: [{ relativePath: legacyRelative, removedItems: 2 }]
  }));

  const officialDirectRecovery = new XwXDeckController(legacyRestoreUserData, {
    backgroundGateway: true,
    proxyListenPorts: [await reserveFreePort()],
    disableBackgroundModelRefresh: true
  });
  await officialDirectRecovery.start();
  await assert.rejects(fs.stat(path.join(legacyRestoreUserData, 'gateway', 'runtime.json')), /ENOENT/,
    'official direct recovery precondition must have no helper');
  await officialDirectRecovery.restoreLegacyOfficialHistoryAfterChatGptExit();
  assert.equal(
    await fs.readFile(legacyRolloutFile, 'utf8'),
    `${originalLines[0]}${originalLines[1]}${originalLines[3]}${appendedLine}`,
    'manager-side recovery must restore only the mistaken official row and preserve later appends'
  );
  await assert.rejects(fs.stat(path.join(legacyRestoreUserData, 'gateway', 'runtime.json')), /ENOENT/,
    'official direct history recovery must not start a helper');
  await officialDirectRecovery.shutdown();
  console.log('PASS official direct stays helper-free; Trace and provider Gateways survive manager reattach; official switch and full shutdown are safe');
} finally {
  if (second) await second.shutdown().catch(() => undefined);
  await stopIsolatedHelper(userData).catch(() => undefined);
  if (upstream) await close(upstream);
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
}

async function readRequest(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function listen(server: http.Server, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('server has no TCP port'));
      else resolve(address.port);
    });
  });
}

async function reserveFreePort(): Promise<number> {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

function close(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'codex-tui/controller-smoke',
      originator: 'codex-tui',
      ...headers
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(text) as Record<string, unknown>; }
  catch { parsed = { error: text }; }
  return { status: response.status, body: parsed };
}

async function waitForTraceCount(baseUrl: string, minimum: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  let observed = 0;
  while (Date.now() < deadline) {
    observed = await readTraceCount(baseUrl);
    if (observed >= minimum) return observed;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Trace count did not reach ${minimum}; observed ${observed}`);
}

async function readTraceCount(baseUrl: string): Promise<number> {
  const response = await fetch(`${baseUrl}/api/state`, { headers: { accept: 'application/json' } });
  assert.equal(response.status, 200, `Trace state returned ${response.status}`);
  const state = await response.json() as { sessions?: Array<{ traceCount?: number }> };
  return (state.sessions ?? []).reduce((total, session) => total + (session.traceCount ?? 0), 0);
}

async function waitForClosed(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { await fetch(`http://127.0.0.1:${port}/xwx-trace/ping`); }
    catch { return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Gateway did not close');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function stopIsolatedHelper(storage: string): Promise<void> {
  const controlDir = path.join(storage, 'gateway');
  const [runtimeText, token] = await Promise.all([
    fs.readFile(path.join(controlDir, 'runtime.json'), 'utf8'),
    fs.readFile(path.join(controlDir, 'control.token'), 'utf8')
  ]);
  const runtime = JSON.parse(runtimeText) as { controlPort: number };
  await fetch(`http://127.0.0.1:${runtime.controlPort}/control/stop`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token.trim()}`, 'content-type': 'application/json' },
    body: '{}'
  });
}
