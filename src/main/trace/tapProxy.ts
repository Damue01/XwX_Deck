import { providerBaseHasVersionRoot } from '../../shared/providerProfiles';
import * as http from 'http';
import * as https from 'https';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Duplex } from 'stream';
import { log } from '../shared/logger';
import { stripTrailingSlash } from '../shared/url';
import { stripUndefined } from '../shared/obj';
import { safeJsonParse } from '../shared/json';
import { headerValue, mapDeclaredResponsesTools } from './protocolBody';
import { analyzeRequestContext, extractModelId } from './context';
import { normalizeUsage } from './normalizeUsage';
import { detectCompact, detectSubagent } from './sessionBoundary';
import { classifyCopilotUtility } from './copilotUtilityRules';
import {
  classifyAuxiliaryTrace,
  getCopilotClassification,
  isCodexStructuredUtilityTrace
} from './sessionRouter';
import { snapshotFromJson, SSEReassembler } from './sseReassembler';
import { listenOnFixedPort, TAP_FINGERPRINT_HEADER, TAP_PING_PATH } from './tapPortLock';
import { TraceStore } from './traceStore';
import { buildCodexToolContext, chatCompletionToResponse, chatErrorToResponseError, chatSseToCompletion, errorAsResponsesSse, responseAsSse, responsesToChatCompletions } from './codexChatBridge';
import {
  AnthropicResponsesStream,
  anthropicMessageToResponse,
  responsesToAnthropicMessages
} from './codexAnthropicBridge';
import {
  buildRemoteCompactionResponse,
  buildStandaloneCompactionResponse,
  buildSyntheticCompactionRequest,
  compactRequestHasUsableInput,
  extractResponseSummary,
  isCompactionTriggerRequest
} from './codexCompaction';
import {
  codexUpstreamIdentity,
  CodexConversationPortability,
  type CodexUpstreamIdentity
} from './codexConversationPortability';
import { ResponsesContinuationStore } from './responsesContinuationStore';
import type { GatewayCapturedClient } from './gatewayProtocol';
import { clientRouteMatchesIdentity, detectClientFromUserAgent, detectStrongVscodeSource, identifyClient, refineClaudeSource, refineCodexSource, resolveTraceSource } from './clientAdapters';
import { TapApiType, TapCaptureMode, TapClientIdentity, TapClientRoute, TapProtocol, TapRoute, TapSessionTracePage, TapTimingSnapshot, TapTraceRecord, TapTraceSource } from './types';

/** 由 controller 注入：把 viewer 的 HTML / state JSON 提供给 proxy server。 */
export interface ViewerHandler {
  readonly html: () => Promise<string>;
  readonly state: () => Promise<unknown>;
  /** 按 id 分页拉单个 session 的 trace；返回 undefined 表示该 session 不存在。 */
  readonly sessionTraces?: (id: string, page?: { offset?: number; limit?: number }) => Promise<TapSessionTracePage | undefined>;
  readonly deleteSession?: (id: string) => Promise<boolean>;
}

/**
 * 路径白名单：前缀匹配（对齐 claude-tap 的 ALLOWED_PATH_PREFIXES）。
 * `/v1/messages` 前缀自动放行 `/v1/messages/count_tokens` 这类子路径——
 * Claude Code 会调 count_tokens 做 token 预算，精确匹配会把它 404 掉。
 * 匹配规则：path === prefix 或 path 以 prefix + '/' 开头；扫描器打 /etc/passwd 等仍 404。
 */
const ALLOWED_PATH_PREFIXES: ReadonlyArray<{ prefix: string; apiType: TapApiType }> = [
  { prefix: '/claude-desktop/v1/messages', apiType: 'messages' },
  { prefix: '/anthropic/v1/messages', apiType: 'messages' },
  { prefix: '/v1/messages', apiType: 'messages' },
  { prefix: '/v1/chat/completions', apiType: 'chat-completions' },
  { prefix: '/v1/models', apiType: 'responses' },
  { prefix: '/v1/responses', apiType: 'responses' },
  { prefix: '/backend-api/codex/models', apiType: 'responses' },
  { prefix: '/backend-api/codex/responses', apiType: 'responses' }
];

/** 返回命中的白名单前缀项；route 表用 prefix 查，转发用完整 pathname 拼上游 URL。 */
function matchAllowedPath(pathname: string): { prefix: string; apiType: TapApiType } | undefined {
  return ALLOWED_PATH_PREFIXES.find(p => pathname === p.prefix || pathname.startsWith(p.prefix + '/'));
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade'
]);

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization'
]);

interface ActiveWebSocketPair {
  downstream: WebSocket;
  upstream: WebSocket;
  finishActive: (error?: Error) => void;
  refreshRoute: () => void;
}

export class TapProxy {
  private server: http.Server | undefined;
  private baseUrl: string | undefined;
  private routes: TapRoute[] = [];
  private clientRoutes: TapClientRoute[] = [];
  private fallbackBaseUrl: string | undefined;
  private fallbackProxyUrl: string | undefined;
  private viewerHandler: ViewerHandler | undefined;
  private readonly sseClients = new Set<http.ServerResponse>();
  private webSocketServer: WebSocketServer | undefined;
  private readonly webSocketPairs = new Set<ActiveWebSocketPair>();
  private readonly pendingWebSocketFinalizations = new Set<Promise<void>>();
  private readonly webSocketUpgradeHeaders = new WeakMap<http.IncomingMessage, http.IncomingHttpHeaders>();
  /** 候选端口段；测试可注入 [0] 走系统随机端口，生产用默认固定段。 */
  private readonly listenPorts: readonly number[] | undefined;
  /**
   * 是否把经过的请求记录成 trace。代理转发与「记录」解耦：disable 时
   * controller 调 setRecordingEnabled(false) 只停记录，proxy 仍在跑做转发/
   * 客户端接管。默认 true 保持「start 即录」的历史行为。
   */
  private recording = true;
  private readonly conversationPortability: CodexConversationPortability;
  private readonly responsesContinuations: ResponsesContinuationStore;
  private activeForwardRequests = 0;
  private activeUserResponses = 0;
  private readonly pendingConversationContinuations = new Map<string, number>();
  private lastForwardActivityAt = 0;
  private shutdownGate = false;
  private readonly activityWaiters = new Set<() => void>();

  constructor(
    private readonly traceStore: TraceStore,
    listenPorts?: readonly number[],
    portabilityStateFile?: string
  ) {
    this.listenPorts = listenPorts;
    this.conversationPortability = new CodexConversationPortability(portabilityStateFile);
    this.responsesContinuations = new ResponsesContinuationStore(
      portabilityStateFile
        ? path.join(path.dirname(portabilityStateFile), 'responses-continuations.json')
        : undefined
    );
  }

  /** 开/关 trace 记录（不影响代理转发本身）。 */
  setRecordingEnabled(enabled: boolean): void {
    this.recording = enabled;
  }

  isRecordingEnabled(): boolean {
    return this.recording;
  }

  async markCodexProviderTransition(
    source: 'official' | 'compatible' | `provider:${string}`,
    target: 'official' | 'compatible' | `provider:${string}`
  ): Promise<void> {
    await this.responsesContinuations.markProviderTransition(source, target);
    await this.conversationPortability.markProviderTransition(source, target);
  }

  async adoptCodexProviderOnStartup(target: 'official' | 'compatible' | `provider:${string}`): Promise<boolean> {
    return this.conversationPortability.adoptProviderOnStartup(target);
  }

  async repairCodexHistoryForProvider(target: 'official' | 'compatible' | `provider:${string}`) {
    return this.conversationPortability.repairLocalHistory(target);
  }

  async restoreLegacyOfficialHistory() {
    return this.conversationPortability.restoreLegacyOfficialHistory();
  }

  setViewerHandler(handler: ViewerHandler | undefined): void {
    this.viewerHandler = handler;
  }

  /** 向所有已连接的实时 viewer 推送一条新 trace。 */
  broadcastTrace(trace: TapTraceRecord): void {
    this.broadcast('trace', JSON.stringify(trace));
  }

  /** 通知 viewer 全量刷新（清空历史等场景）。 */
  broadcastReset(): void {
    this.broadcast('reset', '{}');
  }

  private broadcast(event: string, data: string): void {
    const payload = `event: ${event}\ndata: ${data}\n\n`;
    for (const client of this.sseClients) {
      try { client.write(payload); } catch { /* drop on next cycle */ }
    }
  }

  /** 处理 viewer 的 GET / DELETE 请求；返回 true 表示已处理。 */
  private async handleViewer(req: http.IncomingMessage, res: http.ServerResponse, localUrl: URL, method: string): Promise<boolean> {
    const handler = this.viewerHandler;
    if (!handler) return false;
    const pathname = localUrl.pathname;

    // DELETE /api/session/:id
    if (method === 'DELETE') {
      const m = /^\/api\/session\/([^/]+)$/.exec(pathname);
      if (m && handler.deleteSession) {
        const ok = await handler.deleteSession(decodeURIComponent(m[1]));
        res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok }));
        return true;
      }
      return false;
    }

    if (pathname === '/' || pathname === '/index.html' || pathname === '/dashboard') {
      const html = await handler.html();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
      return true;
    }

    if (pathname === '/api/state') {
      const state = await handler.state();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(state));
      return true;
    }

    // GET /api/session/:id —— 按需分页拉单个 session 的 trace 列表（dashboard 切到详情时用）。
    {
      const m = /^\/api\/session\/([^/]+)$/.exec(pathname);
      if (m && method === 'GET' && handler.sessionTraces) {
        const id = decodeURIComponent(m[1]);
        const page = await handler.sessionTraces(id, {
          offset: parseOptionalInt(localUrl.searchParams.get('offset')),
          limit: parseOptionalInt(localUrl.searchParams.get('limit'))
        });
        if (!page) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'session not found' }));
          return true;
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(page));
        return true;
      }
    }

    if (pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive'
      });
      res.write(': connected\n\n');
      this.sseClients.add(res);
      const keepAlive = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* will be cleaned on close */ }
      }, 25000);
      const cleanup = () => {
        clearInterval(keepAlive);
        this.sseClients.delete(res);
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
      return true;
    }

    return false;
  }

  async start(): Promise<string> {
    if (this.server && this.baseUrl) return this.baseUrl;
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      perMessageDeflate: true
    });
    this.webSocketServer.on('headers', (headers, request) => {
      appendWebSocketResponseHeaders(headers, this.webSocketUpgradeHeaders.get(request));
      this.webSocketUpgradeHeaders.delete(request);
    });
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch(err => {
        if (req.aborted || res.destroyed) return;
        log.error('[compatible/tap] proxy handler failed', String(err));
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`XwX Deck proxy error: ${(err as Error).message}`);
      });
    });
    this.server.on('upgrade', (request, socket, head) => {
      void this.handleWebSocketUpgrade(request, socket, head).catch(error => {
        log.warn(`[compatible/tap] websocket upgrade failed: ${(error as Error).message}`);
        rejectUpgrade(socket, 502, 'XwX Deck WebSocket upstream unavailable.');
      });
    });
    const port = await listenOnFixedPort(this.server, this.listenPorts);
    this.baseUrl = `http://127.0.0.1:${port}`;
    log(`[compatible/tap] proxy listening at ${this.baseUrl}`);
    return this.baseUrl;
  }

  private async handleWebSocketUpgrade(
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> {
    if (socket.destroyed) return;
    const localUrl = new URL(request.url || '/', 'http://127.0.0.1');
    const allowed = matchAllowedPath(localUrl.pathname);
    if (!allowed
      || allowed.apiType !== 'responses'
      || !localUrl.pathname.endsWith('/responses')
      || this.shutdownGate) {
      rejectUpgrade(socket, this.shutdownGate ? 503 : 426, this.shutdownGate
        ? 'XwX Deck is shutting down.'
        : 'XwX Deck WebSocket is available only for official Responses routes.');
      return;
    }

    const clientRoutes = this.clientRoutes;
    const clientIdentity = identifyClient(request.headers, undefined);
    const resolved = this.pickRoute(
      localUrl.pathname,
      allowed.prefix,
      undefined,
      allowed.apiType,
      clientIdentity,
      clientRoutes
    );
    if (!resolved) {
      rejectUpgrade(socket, 426, 'XwX Deck WebSocket route is unavailable.');
      return;
    }
    const route: ResolvedRoute = {
      ...resolved,
      source: resolveTraceSource(clientIdentity, resolved.source)
    };
    if (!isOfficialResponsesWebSocketRoute(route)) {
      rejectUpgrade(socket, 426, 'XwX Deck uses HTTP/SSE for 兼容服务 and protocol-converted models.');
      return;
    }

    const upstreamHttpUrl = buildUpstreamUrl(
      route.upstreamBaseUrl,
      localUrl,
      route.stripPathPrefix,
      undefined,
      'responses'
    );
    const upstreamUrl = new URL(upstreamHttpUrl);
    upstreamUrl.protocol = upstreamUrl.protocol === 'http:' ? 'ws:' : 'wss:';
    const requestHeaders = buildWebSocketForwardHeaders(
      request.headers,
      route.blockedBearerToken,
      route.replacementBearerToken
    );
    const protocols = parseWebSocketProtocols(headerValue(request.headers, 'sec-websocket-protocol'));
    const agent = route.upstreamProxyUrl
      ? upstreamUrl.protocol === 'ws:'
        ? new HttpProxyAgent(route.upstreamProxyUrl)
        : new HttpsProxyAgent(route.upstreamProxyUrl)
      : undefined;
    const upstream = protocols.length
      ? new WebSocket(upstreamUrl, protocols, { headers: requestHeaders, agent, perMessageDeflate: true })
      : new WebSocket(upstreamUrl, { headers: requestHeaders, agent, perMessageDeflate: true });
    let upstreamHeaders: http.IncomingHttpHeaders = {};
    upstream.once('upgrade', response => {
      upstreamHeaders = response.headers;
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        upstream.terminate();
        reject(new Error('official Responses WebSocket handshake timed out'));
      }, 15_000);
      const cleanup = (): void => {
        clearTimeout(timeout);
        upstream.off('open', onOpen);
        upstream.off('error', onError);
        upstream.off('unexpected-response', onUnexpectedResponse);
      };
      const onOpen = (): void => {
        cleanup();
        const server = this.webSocketServer;
        if (!server || socket.destroyed) {
          upstream.terminate();
          resolve();
          return;
        }
        const currentRoute = this.pickRoute(localUrl.pathname, allowed.prefix, undefined, allowed.apiType, clientIdentity);
        if (webSocketConnectionKey(currentRoute, request, localUrl) !== webSocketConnectionKey(route, request, localUrl)) {
          upstream.terminate();
          rejectUpgrade(socket, 426, 'XwX Deck service changed; reconnect using the current route.');
          resolve();
          return;
        }
        this.webSocketUpgradeHeaders.set(request, upstreamHeaders);
        server.handleUpgrade(request, socket, head, downstream => {
          this.bridgeOfficialWebSocket({
            downstream,
            upstream,
            request,
            localUrl,
            allowed,
            route,
            clientIdentity,
            upstreamUrl,
            upstreamHeaders
          });
          resolve();
        });
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onUnexpectedResponse = (_req: http.ClientRequest, response: http.IncomingMessage): void => {
        cleanup();
        reject(new Error(`official Responses WebSocket returned HTTP ${response.statusCode ?? 0}`));
      };
      upstream.once('open', onOpen);
      upstream.once('error', onError);
      upstream.once('unexpected-response', onUnexpectedResponse);
    });
  }

  private bridgeOfficialWebSocket(input: {
    downstream: WebSocket;
    upstream: WebSocket;
    request: http.IncomingMessage;
    localUrl: URL;
    allowed: { prefix: string; apiType: TapApiType };
    route: ResolvedRoute;
    clientIdentity: TapClientIdentity;
    upstreamUrl: URL;
    upstreamHeaders: http.IncomingHttpHeaders;
  }): void {
    const {
      downstream,
      upstream,
      request,
      localUrl,
      allowed,
      clientIdentity,
      upstreamUrl,
      upstreamHeaders
    } = input;
    let active: WebSocketTraceExchange | undefined;
    let sendChain = Promise.resolve();
    let closed = false;
    let retired = false;
    let retirementScheduled = false;
    let lastFinalization = Promise.resolve();
    const connectionKey = webSocketConnectionKey(input.route, request, localUrl);
    let pair: ActiveWebSocketPair;

    const retireWhenIdle = (): void => {
      if (!retired || active || retirementScheduled || closed) return;
      retirementScheduled = true;
      // Flush the completed response's continuation before inviting HTTP/SSE
      // retries on the new provider. Never interrupt an accepted response.
      void lastFinalization.then(() => {
        if (closed) return;
        downstream.close(1000, 'Service changed; reconnect');
        upstream.close(1000, 'Service changed; reconnect');
      });
    };
    const refreshRoute = (): void => {
      const current = this.pickRoute(localUrl.pathname, allowed.prefix, undefined, allowed.apiType, clientIdentity);
      if (webSocketConnectionKey(current, request, localUrl) !== connectionKey) retired = true;
      retireWhenIdle();
    };

    const finishActive = (error?: Error): void => {
      const exchange = active;
      active = undefined;
      if (!exchange) return;
      lastFinalization = Promise.all([lastFinalization, this.queueWebSocketFinalization(exchange, error)]).then(() => undefined);
    };
    const closePair = (source: WebSocket, target: WebSocket, code: number, reason: Buffer): void => {
      if (closed) return;
      closed = true;
      finishActive(new Error(`WebSocket closed before response.completed (${code})`));
      if (target.readyState === WebSocket.OPEN || target.readyState === WebSocket.CONNECTING) {
        try { target.close(normalizeWebSocketCloseCode(code), reason.toString('utf8').slice(0, 120)); }
        catch { target.terminate(); }
      }
      this.webSocketPairs.delete(pair);
      try {
        if (source.readyState !== WebSocket.CLOSED) source.terminate();
      } catch { /* ignore */ }
    };
    pair = { downstream, upstream, finishActive, refreshRoute };
    this.webSocketPairs.add(pair);

    downstream.on('message', (data, isBinary) => {
      sendChain = sendChain.then(async () => {
        refreshRoute();
        if (closed || retired) return;
        if (upstream.readyState !== WebSocket.OPEN) return;
        if (isBinary) {
          upstream.send(data, { binary: true });
          return;
        }
        const text = rawWebSocketDataText(data);
        const body = safeJsonParse(text);
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || (body as Record<string, unknown>).type !== 'response.create') {
          upstream.send(text);
          return;
        }
        if (active) {
          throw new Error('overlapping response.create frames are not supported');
        }
        const model = extractModelId(body);
        const resolved = this.pickRoute(
          localUrl.pathname,
          allowed.prefix,
          model,
          allowed.apiType,
          clientIdentity
        );
        if (!resolved) throw new Error(`no official WebSocket route for model ${model ?? '(unknown)'}`);
        const route: ResolvedRoute = {
          ...resolved,
          source: resolveTraceSource(clientIdentity, resolved.source)
        };
        if (webSocketConnectionKey(route, request, localUrl) !== connectionKey) {
          retired = true;
          retireWhenIdle();
          return;
        }
        const targetUpstream = routeUpstreamIdentity(route, request.headers);
        const continuation = await this.responsesContinuations.prepareRequest(
          body,
          targetUpstream,
          'responses'
        );
        if (continuation.unresolvedToolOutputs > 0) {
          downstream.send(JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              code: 'missing_call_id',
              message: 'XwX Deck rejected a function call output without a recoverable call_id before forwarding it upstream.'
            }
          }));
          return;
        }
        const portableRequest = await this.conversationPortability.prepareRequest(continuation.body, {
          target: targetUpstream,
          wireProtocol: 'responses',
          threadId: codexThreadId(request.headers, body),
          recoverContinuation: continuation.droppedPreviousResponseId && continuation.expandedResponses === 0
        });
        // Route publication can race the async continuation/portability reads.
        refreshRoute();
        if (closed || retired || upstream.readyState !== WebSocket.OPEN) return;
        if (continuation.repairedToolOutputs) {
          log(`[compatible/tap] repaired ${continuation.repairedToolOutputs} malformed Responses tool output item(s) before WebSocket forwarding`);
        }
        const requestProbe = synthesizeInflightProbe({
          startedAt: new Date(),
          req: request,
          requestBody: body,
          requestBodyText: text,
          model,
          route,
          clientIdentity,
          localUrl
        });
        const generate = (body as Record<string, unknown>).generate !== false;
        active = {
          startedAt: new Date(),
          startedNs: process.hrtime.bigint(),
          request,
          localUrl,
          route,
          requestBody: body,
          requestBodyText: text,
          model,
          clientIdentity,
          conversationKey: codexConversationKey(request.headers, body, clientIdentity),
          targetUpstream,
          providerTransitionActive: portableRequest.providerTransitionActive === true,
          providerTransition: portableRequest.providerTransition,
          providerTransitionConsumer: isProviderTransitionConsumer(requestProbe),
          userVisibleResponse: generate && isUserVisibleResponseRequest(requestProbe),
          upstreamUrl,
          upstreamHeaders,
          responseFrames: [],
          reassembler: new SSEReassembler('responses'),
          capture: generate && this.recording && route.capture !== false,
          firstByteMs: undefined
        };
        this.activeForwardRequests += 1;
        if (active.userVisibleResponse) this.activeUserResponses += 1;
        this.lastForwardActivityAt = Date.now();
        this.notifyActivity();
        upstream.send(JSON.stringify(portableRequest.body));
      }).catch(error => {
        finishActive(error as Error);
        try { downstream.close(1011, 'XwX Deck WebSocket request failed'); } catch { downstream.terminate(); }
        try { upstream.close(1011, 'XwX Deck WebSocket request failed'); } catch { upstream.terminate(); }
      });
    });

    upstream.on('message', (data, isBinary) => {
      if (isBinary || !active) {
        if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary: isBinary });
        return;
      }
      const text = rawWebSocketDataText(data);
      const elapsed = elapsedMs(active.startedNs);
      active.firstByteMs ??= elapsed;
      active.responseFrames.push(text);
      const json = safeJsonParse(text);
      const eventType = json && typeof json === 'object' && !Array.isArray(json)
        ? String((json as Record<string, unknown>).type ?? 'message')
        : 'message';
      active.reassembler.feed(Buffer.from(`event: ${eventType}\ndata: ${text}\n\n`), elapsed);
      if (eventType === 'response.completed' || eventType === 'response.failed' || eventType === 'error') {
        const exchange = active;
        active = undefined;
        // Codex can send its continuation as soon as it observes the terminal
        // frame. Release the active slot before publishing that frame so the
        // next response.create cannot be rejected as overlapping work.
        lastFinalization = Promise.all([lastFinalization, this.queueWebSocketFinalization(exchange)]).then(() => undefined);
      }
      if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary: isBinary });
      retireWhenIdle();
    });

    downstream.on('close', (code, reason) => closePair(downstream, upstream, code, reason));
    upstream.on('close', (code, reason) => closePair(upstream, downstream, code, reason));
    downstream.on('error', error => finishActive(error));
    upstream.on('error', error => finishActive(error));
  }

  private async finalizeWebSocketExchange(
    exchange: WebSocketTraceExchange,
    error?: Error
  ): Promise<void> {
    try {
      const completedAt = new Date();
      exchange.reassembler.finish(elapsedMs(exchange.startedNs));
      const events = exchange.reassembler.getEvents();
      const snapshot = exchange.reassembler.snapshot();
      const semanticallyFailed = snapshot.stopReason === 'failed';
      if (exchange.conversationKey) {
        if (!semanticallyFailed && responseNeedsContinuation(snapshot)) {
          this.pendingConversationContinuations.set(exchange.conversationKey, Date.now());
        } else if (!error && !semanticallyFailed) {
          this.pendingConversationContinuations.delete(exchange.conversationKey);
        }
      }
      if (!error && !semanticallyFailed) {
        const responseValue = events.map(event => event.json).filter(value => value !== undefined);
        await this.conversationPortability.observeResponse(
          responseValue,
          exchange.targetUpstream
        ).catch(observeError => log.warn(`[compatible/tap] websocket opaque origin index update failed: ${(observeError as Error).message}`));
        await this.responsesContinuations.recordResponse(
          exchange.requestBody,
          snapshot.raw,
          exchange.targetUpstream
        ).catch(cacheError => log.warn(`[compatible/tap] websocket continuation cache update failed: ${(cacheError as Error).message}`));
        if (exchange.providerTransitionActive && exchange.providerTransitionConsumer) {
          await this.conversationPortability.acknowledgeProviderTransition(exchange.targetUpstream).catch(() => false);
        }
        if (exchange.providerTransitionConsumer) {
          await this.responsesContinuations.acknowledgeProviderTransition(exchange.targetUpstream).catch(() => false);
        }
      }
      if (!exchange.capture || shouldSkipTraceCapture({
        id: 'websocket-probe',
        startedAt: exchange.startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: elapsedMs(exchange.startedNs),
        source: exchange.route.source,
        request: {
          method: 'WS',
          path: exchange.localUrl.pathname,
          url: exchange.localUrl.pathname + exchange.localUrl.search,
          headers: {},
          body: exchange.requestBody,
          model: exchange.model,
          apiType: 'responses'
        },
        upstream: { baseUrl: exchange.route.upstreamBaseUrl, url: exchange.upstreamUrl.toString() },
        response: { headers: {}, snapshot },
        sse: { events, snapshot },
        timings: {}
      })) return;
      const timing: TapTimingSnapshot = {
        ...exchange.reassembler.timing(),
        firstByteMs: exchange.firstByteMs,
        thinkingToTextMs: computeThinkingToText(exchange.reassembler.timing())
      };
      const trace: TapTraceRecord = {
        id: randomUUID(),
        startedAt: exchange.startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: elapsedMs(exchange.startedNs),
        client: exchange.clientIdentity.client,
        clientIdentity: exchange.clientIdentity,
        source: exchange.route.source,
        protocol: 'openai-responses',
        captureMode: captureModeFromSource(exchange.route.source),
        providerTransition: exchange.providerTransition,
        provider: traceProvider(exchange.route),
        request: {
          method: 'WS',
          path: exchange.localUrl.pathname,
          url: exchange.localUrl.pathname + exchange.localUrl.search,
          headers: sanitizeHeaders(exchange.request.headers),
          body: exchange.requestBody,
          model: exchange.model,
          apiType: 'responses'
        },
        upstream: {
          baseUrl: exchange.route.upstreamBaseUrl,
          url: exchange.upstreamUrl.toString(),
          connectionId: exchange.route.connectionId
        },
        response: {
          statusCode: error ? 502 : 101,
          statusMessage: error ? 'WebSocket error' : 'WebSocket',
          headers: sanitizeHeaders(exchange.upstreamHeaders),
          rawBody: exchange.responseFrames.join('\n'),
          snapshot
        },
        sse: { events, snapshot },
        usage: snapshot.usage,
        timings: stripUndefined(timing as unknown as Record<string, unknown>) as unknown as TapTimingSnapshot,
        xwxContext: analyzeRequestContext(exchange.requestBody),
        error: error?.message
      };
      await this.traceStore.appendTrace(trace);
    } finally {
      this.activeForwardRequests = Math.max(0, this.activeForwardRequests - 1);
      if (exchange.userVisibleResponse) {
        this.activeUserResponses = Math.max(0, this.activeUserResponses - 1);
      }
      this.lastForwardActivityAt = Date.now();
      this.notifyActivity();
    }
  }

  private queueWebSocketFinalization(exchange: WebSocketTraceExchange, error?: Error): Promise<void> {
    let pending: Promise<void>;
    pending = this.finalizeWebSocketExchange(exchange, error)
      .catch(finalizeError => {
        log.warn(`[compatible/tap] websocket trace finalization failed: ${(finalizeError as Error).message}`);
      })
      .finally(() => this.pendingWebSocketFinalizations.delete(pending));
    this.pendingWebSocketFinalizations.add(pending);
    return pending;
  }

  private async drainWebSocketFinalizations(): Promise<void> {
    while (this.pendingWebSocketFinalizations.size) {
      await Promise.allSettled([...this.pendingWebSocketFinalizations]);
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    const webSocketServer = this.webSocketServer;
    this.server = undefined;
    this.webSocketServer = undefined;
    this.baseUrl = undefined;
    this.routes = [];
    this.clientRoutes = [];
    this.fallbackBaseUrl = undefined;
    this.fallbackProxyUrl = undefined;
    for (const client of this.sseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    this.sseClients.clear();
    for (const pair of this.webSocketPairs) {
      pair.finishActive(new Error('WebSocket proxy stopped before response.completed'));
      try { pair.downstream.terminate(); } catch { /* ignore */ }
      try { pair.upstream.terminate(); } catch { /* ignore */ }
    }
    this.webSocketPairs.clear();
    await this.drainWebSocketFinalizations();
    this.pendingConversationContinuations.clear();
    if (webSocketServer) {
      try { webSocketServer.close(); } catch { /* ignore */ }
    }
    if (!server) {
      this.shutdownGate = false;
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // server.close 只是停止接受新连接；浏览器 dashboard 的 keep-alive 空闲连接、
      // 仍在流式转发中的模型请求都会让 close 回调迟迟不来——表现为「切换追踪状态…」
      // 通知一直转圈。代理都要停了，在途连接无法继续服务，直接全部强制断开。
      try { server.closeAllConnections(); } catch { /* ignore */ }
    });
    this.shutdownGate = false;
    log('[compatible/tap] proxy stopped');
  }

  async forceStop(): Promise<void> {
    await this.stop();
  }

  activeRequestCount(): number {
    return this.activeForwardRequests;
  }

  activeUserResponseCount(): number {
    return this.activeUserResponses;
  }

  pendingContinuationCount(): number {
    return this.pendingConversationContinuations.size;
  }

  capturedClientIds(): readonly GatewayCapturedClient[] {
    // The in-process controller listens to TraceStore.onDidAppend directly.
    // Only the detached helper needs to report capture ownership over control.
    return [];
  }

  async refreshShutdownActivity(): Promise<void> {
    // In-process counters are already live.
  }

  abandonCodexContinuations(): void {
    if (!this.pendingConversationContinuations.size) return;
    this.pendingConversationContinuations.clear();
    this.notifyActivity();
  }

  /**
   * Keep the local gateway alive while an accepted model request is still
   * streaming. Once it has stayed idle for the quiet period, close the gate so
   * no new request can race configuration restoration and proxy shutdown.
   *
   * A timeout deliberately leaves the gate open: the caller can cancel the
   * application exit without breaking the conversation already in progress.
   */
  async prepareForShutdown(options: {
    readonly timeoutMs?: number;
    readonly quietPeriodMs?: number;
  } = {}): Promise<boolean> {
    const timeoutMs = Math.max(0, options.timeoutMs ?? 120_000);
    const quietPeriodMs = Math.max(0, options.quietPeriodMs ?? 1_000);
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const quietFor = this.lastForwardActivityAt > 0
        ? Date.now() - this.lastForwardActivityAt
        : quietPeriodMs;
      if (this.activeForwardRequests === 0
        && this.pendingConversationContinuations.size === 0
        && quietFor >= quietPeriodMs) {
        this.shutdownGate = true;
        return true;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      const waitMs = this.activeForwardRequests === 0
        ? Math.min(remaining, Math.max(1, quietPeriodMs - quietFor))
        : remaining;
      await this.waitForActivity(waitMs);
    }
  }

  /**
   * User-confirmed destructive shutdown: reject new model requests first,
   * clear tool-call holds, then sever accepted HTTP streams. Configuration is
   * restored by the controller only after this gate is in place.
   */
  async forcePrepareForShutdown(): Promise<void> {
    this.shutdownGate = true;
    this.pendingConversationContinuations.clear();
    try { this.server?.closeAllConnections(); } catch { /* ignore */ }
    this.notifyActivity();
  }

  cancelPreparedShutdown(): void {
    this.shutdownGate = false;
  }

  localBaseUrl(): string | undefined {
    return this.baseUrl;
  }

  isListening(): boolean {
    return !!this.server?.listening && !!this.baseUrl;
  }

  setRoutes(
    routes: readonly TapRoute[],
    fallbackBaseUrl: string | undefined,
    fallbackProxyUrl?: string
  ): void {
    this.routes = routes.map(route => ({
      ...route,
      upstreamBaseUrl: stripTrailingSlash(route.upstreamBaseUrl)
    }));
    this.fallbackBaseUrl = fallbackBaseUrl ? stripTrailingSlash(fallbackBaseUrl) : undefined;
    this.fallbackProxyUrl = fallbackProxyUrl;
    for (const pair of this.webSocketPairs) pair.refreshRoute();
  }

  /**
   * 设置客户端 fallback 路由。入站顺序：兼容服务 routes （按 model id）→ client routes （按 path）→ fallbackBaseUrl。
   * 与 setRoutes 独立，避免 customEndpointSync 重同步时踩掉 client routes。
   */
  setClientRoutes(routes: readonly TapClientRoute[]): void {
    this.clientRoutes = routes.map(route => ({
      ...route,
      upstreamBaseUrl: stripTrailingSlash(route.upstreamBaseUrl)
    }));
    for (const pair of this.webSocketPairs) pair.refreshRoute();
  }

  hasClientRoute(source: TapClientRoute['source'], path: string): boolean {
    return this.clientRoutes.some(route => route.source === source && route.path === path);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const startedAt = new Date();
    const startedNs = process.hrtime.bigint();
    const localUrl = new URL(req.url || '/', 'http://127.0.0.1');

    // 指纹探活：probeTapPort 用这个端点确认对端确实是 XwX Trace 代理，
    // 而不是碌巧占用了同一端口的无关进程。不依赖 viewerHandler。
    if (localUrl.pathname === TAP_PING_PATH) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', [TAP_FINGERPRINT_HEADER]: '1' });
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }

    // Viewer 路由（GET / DELETE）：dashboard / state / SSE / 删除会话。与代理转发（POST 到 ALLOWED_PATHS）互不干扰。
    const method = (req.method || 'GET').toUpperCase();
    if ((method === 'GET' || method === 'DELETE') && this.viewerHandler) {
      if (await this.handleViewer(req, res, localUrl, method)) return;
    }

    const allowed = matchAllowedPath(localUrl.pathname);
    if (!allowed) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('XwX Deck: path is not allowed');
      return;
    }
    if (this.shutdownGate) {
      res.writeHead(503, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'close'
      });
      res.end(JSON.stringify({
        error: {
          type: 'xwx_deck_shutting_down',
          message: 'XwX Deck 正在安全退出；请等待当前客户端重新读取已恢复的连接配置。'
        }
      }));
      return;
    }
    const apiType = allowed.apiType;
    this.activeForwardRequests += 1;
    let userVisibleResponse = false;
    this.lastForwardActivityAt = Date.now();
    this.notifyActivity();

    try {
      // setClientRoutes replaces the array. Capture it when the request arrives
      // so an upstream switch cannot move a request that is still uploading its body.
      const clientRoutes = this.clientRoutes;
      const requestRawBody = await readRequestBody(req);
      let requestBodyText = requestRawBody.toString('utf8');
      const originalRequestBody = safeJsonParse(requestBodyText);
      let requestBody = originalRequestBody;
      let model = extractModelId(requestBody);
      const clientIdentity = identifyClient(req.headers, requestBody);
      const conversationKey = codexConversationKey(req.headers, requestBody, clientIdentity);
      if (conversationKey) this.pendingConversationContinuations.delete(conversationKey);
      // 路由按白名单前缀查（route 表注册的是基路径），转发用完整 pathname 拼上游 URL，
      // 子路径（count_tokens 等）自然落到同一上游。
      const resolved = this.pickRoute(localUrl.pathname, allowed.prefix, model, apiType, clientIdentity, clientRoutes);
      if (!resolved) {
        const message = `XwX Deck: no upstream route for ${localUrl.pathname}${model ? ` model=${model}` : ''}`;
        await this.recordErrorTrace({
          startedAt,
          startedNs,
          req,
          localUrl,
          requestBody,
          requestBodyText,
          apiType,
          model,
          clientIdentity,
          source: resolveTraceSource(clientIdentity, 'unknown'),
          error: message
        });
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(message);
        return;
      }

      let route: ResolvedRoute = {
        ...resolved,
        source: resolveTraceSource(clientIdentity, resolved.source)
      };
      if (route.upstreamModelId && route.upstreamModelId !== model) {
        requestBody = replaceRequestModel(requestBody, route.upstreamModelId);
        requestBodyText = JSON.stringify(requestBody);
        model = route.upstreamModelId;
      }
      const targetUpstream = routeUpstreamIdentity(route, req.headers);
      const continuation = apiType === 'responses'
        ? await this.responsesContinuations.prepareRequest(
            requestBody,
            targetUpstream,
            route.wireProtocol ?? 'responses'
          )
        : { body: requestBody, expandedResponses: 0, restoredToolCalls: 0, repairedToolOutputs: 0, unresolvedToolOutputs: 0, droppedPreviousResponseId: false };
      if (continuation.unresolvedToolOutputs > 0) {
        const errorBody = chatErrorToResponseError({
          message: 'XwX Deck could not safely restore the original tool call for this provider switch. Reopen the task and retry from the last user turn; no tool was re-executed.',
          type: 'invalid_request_error'
        });
        const expectsStream = requestBody && typeof requestBody === 'object'
          && (requestBody as Record<string, unknown>).stream === true;
        const outputText = expectsStream ? errorAsResponsesSse(errorBody) : JSON.stringify(errorBody);
        res.writeHead(409, {
          'content-type': expectsStream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8',
          'cache-control': 'no-store'
        });
        res.end(outputText);
        return;
      }
      const portableRequest = apiType === 'responses'
        ? await this.conversationPortability.prepareRequest(continuation.body, {
            target: targetUpstream,
            wireProtocol: route.wireProtocol ?? 'responses',
            threadId: codexThreadId(req.headers, requestBody),
            recoverContinuation: continuation.droppedPreviousResponseId && continuation.expandedResponses === 0
          })
        : { body: requestBody, removedReasoning: 0, replacedCompactions: 0, normalizedMessageIds: 0 };
      if (continuation.expandedResponses || continuation.restoredToolCalls || continuation.repairedToolOutputs || portableRequest.removedReasoning || portableRequest.replacedCompactions || portableRequest.normalizedMessageIds || portableRequest.insertedCheckpoint) {
        log(`[compatible/tap] portable Codex history: removed ${portableRequest.removedReasoning} unportable reasoning item(s), replaced ${portableRequest.replacedCompactions} compaction item(s)${continuation.repairedToolOutputs ? `, repaired ${continuation.repairedToolOutputs} malformed tool output item(s)` : ''}${portableRequest.normalizedMessageIds ? `, normalized ${portableRequest.normalizedMessageIds} legacy message ID(s)` : ''}${portableRequest.checkpointSource ? ` via ${portableRequest.checkpointSource}` : ''}${portableRequest.transitionSanitizedOpaque ? `; proactively sanitized ${portableRequest.transitionSanitizedOpaque} legacy opaque item(s) after provider switch` : ''}`);
      }
      const remoteCompaction = isCompactionTriggerRequest(requestBody);
      if (remoteCompaction && route.nativeCompact !== true) {
        route = { ...route, transform: 'responses-compact-synthetic' };
      }
    const requestProbe = synthesizeInflightProbe({
      startedAt, req, requestBody, requestBodyText, model, route, clientIdentity, localUrl
    });
    userVisibleResponse = isUserVisibleResponseRequest(requestProbe);
    if (userVisibleResponse) {
      this.activeUserResponses += 1;
      this.notifyActivity();
    }
    const providerTransitionConsumer = isProviderTransitionConsumer(requestProbe);
    // Pre-attribute this request to a session and broadcast `touch` so dashboard
    // can mark it LIVE during long-running streams. Without this, the 30s LIVE
    // window only fires after completedAt lands — which can be minutes for
    // tool-heavy turns, leaving parallel chats falsely showing OK.
    if (this.recording && route.capture !== false) {
      this.traceStore.findInflightSession(requestProbe).then(s => {
        if (s) this.broadcast('touch', JSON.stringify({ sessionId: s.id, ts: new Date().toISOString() }));
      }).catch(err => log.warn(`[compatible/tap] inflight probe failed: ${(err as Error).message}`));
    }
    const upstreamUrl = route.providerAdapter && route.providerAdapter !== 'auto'
      ? new URL(route.upstreamBaseUrl.replace(/\/+$/, '') + (localUrl.pathname.endsWith('/models') ? '/models'
        : route.wireProtocol === 'anthropic-messages' ? '/messages'
        : route.wireProtocol === 'chat-completions' ? '/chat/completions'
        : localUrl.pathname.endsWith('/compact') ? '/responses/compact' : '/responses') + localUrl.search)
      : buildUpstreamUrl(route.upstreamBaseUrl, localUrl, route.stripPathPrefix, route.transform, route.wireProtocol);
    let conversionSource = portableRequest.body;
    if (route.excludedToolNamespaces?.length) {
      conversionSource = excludeToolNamespaces(conversionSource, route.excludedToolNamespaces);
    }
    let upstreamRequestRawBody = conversionSource === originalRequestBody
      ? requestRawBody
      : Buffer.from(JSON.stringify(conversionSource), 'utf8');
    let anthropicToolContext: ReturnType<typeof buildCodexToolContext> | undefined;
    if (route.transform === 'responses-to-chat') {
      upstreamRequestRawBody = Buffer.from(JSON.stringify(responsesToChatCompletions(conversionSource, {
        upstreamBaseUrl: route.upstreamBaseUrl,
        useVerifiedCompatibleServiceReasoningProfile: route.compatibleServiceGateway === true
      })), 'utf8');
    } else if (route.transform === 'responses-to-anthropic') {
      try {
        const converted = responsesToAnthropicMessages(conversionSource, {
          defaultMaxTokens: route.defaultMaxOutputTokens
        });
        anthropicToolContext = converted.toolContext;
        upstreamRequestRawBody = Buffer.from(JSON.stringify(converted.body), 'utf8');
      } catch (error) {
        const errorBody = chatErrorToResponseError({
          message: (error as Error).message,
          type: 'invalid_request_error'
        });
        const expectsStream = requestBody && typeof requestBody === 'object'
          && (requestBody as Record<string, unknown>).stream === true;
        const outputText = expectsStream ? errorAsResponsesSse(errorBody) : JSON.stringify(errorBody);
        res.writeHead(400, {
          'content-type': expectsStream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8',
          'cache-control': 'no-store'
        });
        res.end(outputText);
        return;
      }
    } else if (route.transform === 'responses-compact-synthetic') {
      const compactRequest = buildSyntheticCompactionRequest(conversionSource);
      if (route.wireProtocol === 'chat-completions') {
        if (!compactRequestHasUsableInput(conversionSource) && continuation.droppedPreviousResponseId) {
          const errorBody = chatErrorToResponseError({
            message: 'Synthetic compact cannot resolve previous_response_id without an input history.',
            type: 'invalid_request_error'
          });
          const streamError = !localUrl.pathname.endsWith('/compact') && (requestBody as any)?.stream === true;
          const outputText = streamError ? errorAsResponsesSse(errorBody) : JSON.stringify(errorBody);
          res.writeHead(400, {
            'content-type': streamError ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8',
            'cache-control': 'no-store'
          });
          res.end(outputText);
          return;
        }
        upstreamRequestRawBody = Buffer.from(JSON.stringify(responsesToChatCompletions(compactRequest, {
          upstreamBaseUrl: route.upstreamBaseUrl,
          useVerifiedCompatibleServiceReasoningProfile: route.compatibleServiceGateway === true
        })), 'utf8');
      } else if (route.wireProtocol === 'anthropic-messages') {
        try {
          const converted = responsesToAnthropicMessages(compactRequest, {
            defaultMaxTokens: route.defaultMaxOutputTokens
          });
          anthropicToolContext = converted.toolContext;
          upstreamRequestRawBody = Buffer.from(JSON.stringify(converted.body), 'utf8');
        } catch (error) {
          const errorBody = chatErrorToResponseError({
            message: (error as Error).message,
            type: 'invalid_request_error'
          });
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify(errorBody));
          return;
        }
      } else {
        upstreamRequestRawBody = Buffer.from(JSON.stringify(compactRequest), 'utf8');
      }
    }
      await this.forward({
        req,
        res,
        localUrl,
        upstreamUrl,
        route,
        requestRawBody: upstreamRequestRawBody,
        requestBody,
        requestBodyText,
        startedAt,
        startedNs,
        model,
        clientIdentity,
        conversationKey,
        anthropicToolContext,
        providerTransitionActive: portableRequest.providerTransitionActive === true,
        providerTransition: portableRequest.providerTransition ?? continuation.providerTransition,
        providerTransitionConsumer
      });
    } finally {
      this.activeForwardRequests = Math.max(0, this.activeForwardRequests - 1);
      if (userVisibleResponse) {
        this.activeUserResponses = Math.max(0, this.activeUserResponses - 1);
      }
      this.lastForwardActivityAt = Date.now();
      this.notifyActivity();
    }
  }

  private waitForActivity(timeoutMs: number): Promise<void> {
    return new Promise(resolve => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activityWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.activityWaiters.add(finish);
    });
  }

  private notifyActivity(): void {
    for (const waiter of [...this.activityWaiters]) waiter();
  }

  private pickRoute(
    pathname: string,
    prefix: string,
    model: string | undefined,
    apiType: TapApiType,
    clientIdentity: TapClientIdentity,
    clientRoutes: readonly TapClientRoute[] = this.clientRoutes
  ): ResolvedRoute | undefined {
    const routePaths = pathname === prefix ? [pathname] : [pathname, prefix];
    // 请求来自 CLI 时（user-agent 判出）优先走 client routes，求不让 兼容服务 model-anchored
    // 抢掠同名 model 在 codex / claude 上的请求（会导致 source 误报 + upstream 错位）。
    if (clientIdentity.source !== 'unknown' && clientIdentity.source !== 'copilot') {
      const byClient = routePaths
        .map(routePath => clientRoutes.find(route => route.path === routePath && clientRouteMatchesIdentity(route.source, clientIdentity)))
        .find((route): route is TapClientRoute => !!route);
      if (byClient) return resolveClientRoute(byClient, model);
    }
    // 1) 兼容服务 model-anchored route（优先级最高，仅限未被 CLI 抢走的请求）
    const byModel = model
      ? routePaths.map(routePath => this.routes.find(route => route.path === routePath && route.modelId === model)).find(Boolean)
      : undefined;
    if (byModel) return { ...byModel, source: 'copilot' };
    // 2) 兼容服务 path-anchored route（没带 modelId 的，一般不会包，保留兼容）
    const byPath = routePaths.map(routePath => this.routes.find(route => route.path === routePath && !route.modelId)).find(Boolean);
    if (byPath) return { ...byPath, source: 'copilot' };
    // 3) Client routes：client hint 失败但 path 匹配也能走到这里。
    if (clientIdentity.source !== 'copilot') {
      const byClient = routePaths
        .map(routePath => clientRoutes.find(route => route.path === routePath && clientRouteMatchesIdentity(route.source, clientIdentity)))
        .find((route): route is TapClientRoute => !!route);
      if (byClient) return resolveClientRoute(byClient, model);
    }
    // 4) 兼容服务 fallback baseUrl（历史行为）
    const fallback = this.fallbackBaseUrl;
    if (fallback) {
      return {
        path: pathname,
        apiType,
        upstreamBaseUrl: fallback,
        upstreamProxyUrl: this.fallbackProxyUrl,
        source: 'copilot'
      };
    }
    return undefined;
  }

  private async forward(input: {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    localUrl: URL;
    upstreamUrl: URL;
    route: ResolvedRoute;
    requestRawBody: Buffer;
    requestBody: unknown;
    requestBodyText: string;
    startedAt: Date;
    startedNs: bigint;
    model?: string;
    clientIdentity: TapClientIdentity;
    conversationKey?: string;
    anthropicToolContext?: ReturnType<typeof buildCodexToolContext>;
    providerTransitionActive?: boolean;
    providerTransition?: TapTraceRecord['providerTransition'];
    providerTransitionConsumer: boolean;
  }): Promise<void> {
    const {
      req,
      res,
      localUrl,
      upstreamUrl,
      route,
      requestRawBody,
      requestBody,
      requestBodyText,
      startedAt,
      startedNs,
      model,
      clientIdentity,
      conversationKey,
      anthropicToolContext,
      providerTransitionActive,
      providerTransition,
      providerTransitionConsumer
    } = input;
    const targetUpstream = routeUpstreamIdentity(route, req.headers);
    const anthropicWire = route.wireProtocol === 'anthropic-messages';
    const requestHeaders = buildForwardHeaders(
      req.headers,
      upstreamUrl.host,
      requestRawBody.length,
      route.upstreamBearerToken,
      route.blockedBearerToken,
      route.replacementBearerToken,
      anthropicWire
    );
    if (route.providerAdapter === 'anthropic-messages' && route.upstreamBearerToken) {
      delete requestHeaders.authorization;
      requestHeaders['x-api-key'] = route.upstreamBearerToken;
    }
    const responseChunks: Buffer[] = [];
    let responseStatusCode: number | undefined;
    let responseStatusMessage: string | undefined;
    let responseHeaders: http.IncomingHttpHeaders = {};
    let firstByteMs: number | undefined;
    let reassembler: SSEReassembler | undefined;
    let upstreamError: Error | undefined;
    let responseStarted = false;
    let responseSettled = false;
    let downstreamCloseError: Error | undefined;
    let upstreamUsageRaw: unknown;

    await new Promise<void>((resolve) => {
      const lib = upstreamUrl.protocol === 'http:' ? http : https;
      const agent = route.upstreamProxyUrl
        ? upstreamUrl.protocol === 'http:'
          ? new HttpProxyAgent(route.upstreamProxyUrl)
          : new HttpsProxyAgent(route.upstreamProxyUrl)
        : undefined;
      const upstreamReq = lib.request(upstreamUrl, {
        method: req.method || 'POST',
        headers: requestHeaders,
        agent
      }, upstreamRes => {
        responseStarted = true;
        responseStatusCode = upstreamRes.statusCode;
        responseStatusMessage = upstreamRes.statusMessage;
        responseHeaders = upstreamRes.headers;
        firstByteMs = elapsedMs(startedNs);
        if ((upstreamRes.statusCode ?? 0) >= 500) {
          log.warn(`[compatible/tap] upstream returned ${upstreamRes.statusCode} host=${upstreamUrl.host} path=${localUrl.pathname} proxy=${proxyRouteLabel(route.upstreamProxyUrl)}`);
        }
        const forwardedHeaders = filterResponseHeaders(upstreamRes.headers);
        const statusCode = upstreamRes.statusCode ?? 502;
        const upstreamContentType = headerValue(upstreamRes.headers, 'content-type').toLowerCase();
        const upstreamIsSse = upstreamContentType.includes('text/event-stream');
        const requestExpectsStream = requestBody && typeof requestBody === 'object'
          && (requestBody as Record<string, unknown>).stream === true;
        const successStatus = statusCode >= 200 && statusCode < 300;
        // ChatGPT's official Responses backend can omit Content-Type while still
        // returning a valid event:/data: stream. The request contract is the
        // only streaming signal available in that case.
        const upstreamLooksStreamed = upstreamIsSse
          || (!upstreamContentType && requestExpectsStream && successStatus);
        if (
          route.transform === 'responses-to-anthropic'
          && upstreamLooksStreamed
          && requestExpectsStream
          && successStatus
        ) {
          const converter = new AnthropicResponsesStream(
            model ?? '',
            anthropicToolContext ?? buildCodexToolContext(requestBody)
          );
          const headers: http.OutgoingHttpHeaders = {
            ...forwardedHeaders,
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store'
          };
          delete headers['content-length'];
          res.writeHead(statusCode, headers);
          reassembler = new SSEReassembler(route.apiType);
          const finishLiveStream = (error?: Error): void => {
            if (responseSettled) return;
            responseSettled = true;
            if (error) upstreamError = error;
            const tail = converter.finish();
            upstreamUsageRaw = converter.rawUsage();
            if (tail) {
              const output = Buffer.from(tail);
              responseChunks.push(output);
              reassembler?.feed(output, elapsedMs(startedNs));
              if (!res.destroyed) res.write(output);
            }
            reassembler?.finish(elapsedMs(startedNs));
            if (!res.destroyed) res.end();
            resolve();
          };
          upstreamRes.on('data', (chunk: Buffer) => {
            const converted = converter.feed(chunk);
            if (!converted) return;
            const output = Buffer.from(converted);
            responseChunks.push(output);
            reassembler?.feed(output, elapsedMs(startedNs));
            if (!res.write(output)) {
              upstreamRes.pause();
              res.once('drain', () => upstreamRes.resume());
            }
          });
          upstreamRes.on('end', () => finishLiveStream());
          upstreamRes.on('aborted', () => finishLiveStream(
            downstreamCloseError ?? new Error('Anthropic upstream response aborted')
          ));
          upstreamRes.on('error', error => finishLiveStream(downstreamCloseError ?? error));
          upstreamRes.on('close', () => finishLiveStream(
            downstreamCloseError ?? new Error('Anthropic upstream response closed before completion')
          ));
          return;
        }
        if (
          route.transform === 'responses-to-chat'
          || route.transform === 'responses-to-anthropic'
          || route.transform === 'responses-compact-synthetic'
        ) {
          upstreamRes.on('data', (chunk: Buffer) => responseChunks.push(chunk));
          upstreamRes.on('end', () => {
            if (responseSettled) return;
            responseSettled = true;
            const upstreamText = Buffer.concat(responseChunks).toString('utf8');
            const streamed = upstreamLooksStreamed;
            const syntheticCompact = route.transform === 'responses-compact-synthetic';
            const standaloneCompact = syntheticCompact && localUrl.pathname.endsWith('/responses/compact');
            const expectsStream = !standaloneCompact
              && requestExpectsStream;
            const success = successStatus;
            // A Codex client sent a Responses request and expects a Responses-shaped
            // reply on every path. Non-2xx upstreams (bad key / rate limit / 5xx) and
            // 2xx bodies that fold to nothing (broken/non-JSON SSE) must be surfaced as
            // a Responses error object, not the raw Chat Completions error passed through.
            const chatWire = route.wireProtocol === 'chat-completions' || route.transform === 'responses-to-chat';
            const messagesWire = route.wireProtocol === 'anthropic-messages' || route.transform === 'responses-to-anthropic';
            const chat = success && chatWire
              ? (streamed ? chatSseToCompletion(upstreamText, model ?? '') : safeJsonParse(upstreamText))
              : undefined;
            if (chatWire) upstreamUsageRaw = usageFromEnvelope(chat);
            let anthropicResponse: Record<string, unknown> | undefined;
            if (success && messagesWire) {
              if (streamed) {
                const converter = new AnthropicResponsesStream(
                  model ?? '',
                  anthropicToolContext ?? buildCodexToolContext(requestBody)
                );
                converter.feed(upstreamText);
                converter.finish();
                upstreamUsageRaw = converter.rawUsage();
                anthropicResponse = converter.response();
              } else {
                const parsed = safeJsonParse(upstreamText);
                if (parsed !== undefined) {
                  upstreamUsageRaw = usageFromEnvelope(parsed);
                  anthropicResponse = anthropicMessageToResponse(
                    parsed,
                    model ?? '',
                    anthropicToolContext ?? buildCodexToolContext(requestBody)
                  );
                }
              }
            }
            const canonicalResponse = success
              ? chatWire
                ? (isHollowChatCompletion(chat) ? undefined : chatCompletionToResponse(chat, model ?? '', buildCodexToolContext(requestBody)))
                : messagesWire
                  ? anthropicResponse
                  : safeJsonParse(upstreamText)
              : undefined;
            const summary = syntheticCompact ? extractResponseSummary(canonicalResponse) : undefined;
            const failedEnvelope = success && (canonicalResponse as any)?.status === 'failed';
            const hollow = success && (!canonicalResponse || (syntheticCompact && !summary));
            let outputText: string;
            let outStatus = statusCode;
            if (success && !hollow && !failedEnvelope) {
              const response = syntheticCompact
                ? standaloneCompact
                  ? buildStandaloneCompactionResponse(requestBody, summary!, (canonicalResponse as any)?.usage)
                  : buildRemoteCompactionResponse(model ?? '', summary!, (canonicalResponse as any)?.usage)
                : canonicalResponse as Record<string, unknown>;
              outputText = expectsStream ? responseAsSse(response) : JSON.stringify(response);
            } else {
              const errorBody = chatErrorToResponseError(failedEnvelope
                ? (canonicalResponse as any)?.error
                : hollow
                ? { message: syntheticCompact ? 'Compact summarizer returned an empty or invalid summary.' : '上游返回了空响应或无法解析的流。', type: 'upstream_error' }
                : safeJsonParse(upstreamText) ?? upstreamText);
              if (hollow || failedEnvelope) outStatus = 502;
              outputText = expectsStream ? errorAsResponsesSse(errorBody) : JSON.stringify(errorBody);
            }
            responseStatusCode = outStatus;
            const headers: http.OutgoingHttpHeaders = {
              ...forwardedHeaders,
              'content-type': expectsStream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8',
              'cache-control': 'no-store'
            };
            delete headers['content-length'];
            res.writeHead(outStatus, headers);
            if (expectsStream) {
              reassembler = new SSEReassembler(route.apiType);
              reassembler.feed(Buffer.from(outputText), elapsedMs(startedNs));
              reassembler.finish(elapsedMs(startedNs));
            }
            responseChunks.length = 0;
            responseChunks.push(Buffer.from(outputText));
            res.end(outputText);
            resolve();
          });
          const failBufferedTransform = (error: Error): void => {
            if (responseSettled) return;
            responseSettled = true;
            upstreamError = error;
            responseStatusCode = 502;
            const standaloneCompact = route.transform === 'responses-compact-synthetic'
              && localUrl.pathname.endsWith('/responses/compact');
            const expectsStream = !standaloneCompact && requestExpectsStream;
            const body = chatErrorToResponseError({
              type: 'upstream_stream_error',
              message: error.message
            });
            const outputText = expectsStream ? errorAsResponsesSse(body) : JSON.stringify(body);
            const headers: http.OutgoingHttpHeaders = {
              'content-type': expectsStream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8',
              'cache-control': 'no-store'
            };
            if (!res.headersSent) res.writeHead(502, headers);
            if (expectsStream) {
              reassembler = new SSEReassembler(route.apiType);
              reassembler.feed(Buffer.from(outputText), elapsedMs(startedNs));
              reassembler.finish(elapsedMs(startedNs));
            }
            responseChunks.length = 0;
            responseChunks.push(Buffer.from(outputText));
            res.end(outputText);
            resolve();
          };
          upstreamRes.on('aborted', () => failBufferedTransform(
            downstreamCloseError ?? new Error('upstream response aborted')
          ));
          upstreamRes.on('error', error => failBufferedTransform(downstreamCloseError ?? error));
          upstreamRes.on('close', () => failBufferedTransform(
            downstreamCloseError ?? new Error('upstream response closed before completion')
          ));
          return;
        }
        if (upstreamRes.statusMessage) res.writeHead(statusCode, upstreamRes.statusMessage, forwardedHeaders);
        else res.writeHead(statusCode, forwardedHeaders);
        const contentType = headerValue(upstreamRes.headers, 'content-type').toLowerCase();
        const isSse = contentType.includes('text/event-stream')
          || (!contentType && requestExpectsStream && successStatus);
        if (isSse) reassembler = new SSEReassembler(route.apiType);
        let waitingForDrain = false;
        const resumeAfterDrain = (): void => {
          waitingForDrain = false;
          if (!responseSettled && !res.destroyed && !upstreamRes.destroyed) {
            upstreamRes.resume();
          }
        };
        const finishPassthrough = (error?: Error): void => {
          if (responseSettled) return;
          responseSettled = true;
          res.off('drain', resumeAfterDrain);
          if (error) upstreamError = error;
          if (reassembler) reassembler.finish(elapsedMs(startedNs));
          if (error) {
            if (!res.destroyed) res.destroy();
          } else if (!res.destroyed) {
            res.end();
          }
          resolve();
        };
        upstreamRes.on('data', (chunk: Buffer) => {
          responseChunks.push(chunk);
          if (reassembler) reassembler.feed(chunk, elapsedMs(startedNs));
          if (!res.destroyed && !res.write(chunk) && !waitingForDrain) {
            waitingForDrain = true;
            upstreamRes.pause();
            res.once('drain', resumeAfterDrain);
          }
        });
        upstreamRes.on('end', () => finishPassthrough());
        upstreamRes.on('aborted', () => finishPassthrough(
          downstreamCloseError ?? new Error('upstream response aborted')
        ));
        upstreamRes.on('error', error => finishPassthrough(downstreamCloseError ?? error));
        upstreamRes.on('close', () => finishPassthrough(
          downstreamCloseError ?? new Error('upstream response closed before completion')
        ));
      });
      upstreamReq.on('error', err => {
        // Once response headers exist, IncomingMessage owns final settlement.
        // ClientRequest emits a companion error when a downstream close destroys
        // its socket; resolving here would race the response aborted/close event
        // and allow success side effects to run before the transport is settled.
        if (responseStarted) return;
        upstreamError = err;
        if (res.destroyed) {
          resolve();
          return;
        }
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`XwX Deck upstream error: ${err.message}`);
        resolve();
      });
      const abortForDownstream = (message: string): void => {
        downstreamCloseError ??= new Error(message);
        if (!upstreamReq.destroyed) upstreamReq.destroy(downstreamCloseError);
      };
      req.on('aborted', () => abortForDownstream('client aborted'));
      res.on('close', () => {
        if (!res.writableEnded && !responseSettled) {
          abortForDownstream('client disconnected');
        }
      });
      upstreamReq.end(requestRawBody);
    });

    const completedAt = new Date();
    const responseBodyText = Buffer.concat(responseChunks).toString('utf8');
    const responseBody = safeJsonParse(responseBodyText);
    const reassembledEvents = reassembler?.getEvents() ?? [];
    const reassembledSnapshot = reassembler?.snapshot();
    const capturedSse = reassembledEvents.length > 0;
    const snapshot = capturedSse && reassembledSnapshot
      ? reassembledSnapshot
      : snapshotFromJson(route.apiType, responseBody);
    const clientUsageRaw = reassembler?.usageRaw() ?? usageFromEnvelope(responseBody);
    upstreamUsageRaw ??= clientUsageRaw;
    // Streaming clients (Codex / Claude) routinely close their socket the moment
    // they receive the terminal event, before our upstream socket finishes
    // closing. Preserve that cause across the companion IncomingMessage aborted
    // event, then clear it only after a successful terminal event was captured.
    // Recording it as an error makes every healthy streamed turn show ERR /
    // "Request failed", so clear it before applying success-only side effects.
    if (upstreamError) {
      const clientClosed = upstreamError === downstreamCloseError;
      const succeeded = typeof responseStatusCode === 'number'
        && responseStatusCode >= 200 && responseStatusCode < 300;
      const terminal = !!snapshot.stopReason && snapshot.stopReason !== 'failed';
      if (clientClosed && succeeded && terminal) {
        upstreamError = undefined;
      }
    }
    const responseSemanticallyFailed = snapshot.stopReason === 'failed';
    if (conversationKey) {
      if (!responseSemanticallyFailed && responseNeedsContinuation(snapshot)) {
        this.pendingConversationContinuations.set(conversationKey, Date.now());
      } else if (!upstreamError
        && !responseSemanticallyFailed
        && typeof responseStatusCode === 'number'
        && responseStatusCode < 500) {
        this.pendingConversationContinuations.delete(conversationKey);
      }
    }
    const sseEvents = capturedSse ? reassembledEvents : [];
    const sseSnapshot = capturedSse ? reassembledSnapshot : undefined;
    if (!upstreamError
      && !responseSemanticallyFailed
      && typeof responseStatusCode === 'number'
      && responseStatusCode >= 200
      && responseStatusCode < 300) {
      const canonicalResponse = responseBody ?? reassembledSnapshot?.raw;
      // Record opaque ownership first: the client may issue its next turn as
      // soon as `res.end()` is observed. A slower sidecar write must not delay
      // the safety-critical provider boundary classification.
      await this.conversationPortability.observeResponse(
        responseBody ?? reassembledEvents.map(event => event.json).filter(value => value !== undefined),
        targetUpstream
      ).catch(error => log.warn(`[compatible/tap] opaque origin index update failed: ${(error as Error).message}`));
      await this.responsesContinuations.recordResponse(
        requestBody,
        canonicalResponse,
        targetUpstream
      ).catch(error => log.warn(`[compatible/tap] response continuation cache update failed: ${(error as Error).message}`));
      if (providerTransitionActive && providerTransitionConsumer) {
        const acknowledged = await this.conversationPortability.acknowledgeProviderTransition(targetUpstream)
          .catch(() => false);
        if (acknowledged) log(`[compatible/tap] provider transition checkpoint accepted by ${targetUpstream.kind}`);
      }
      if (providerTransitionConsumer) {
        await this.responsesContinuations.acknowledgeProviderTransition(targetUpstream).catch(() => false);
      }
    }
    if (upstreamError) {
      log.warn(`[compatible/tap] upstream request failed host=${upstreamUrl.host} path=${localUrl.pathname} proxy=${proxyRouteLabel(route.upstreamProxyUrl)} code=${(upstreamError as NodeJS.ErrnoException).code ?? 'unknown'} message=${upstreamError.message}`);
    }
    const invalidEncryptedContent = responseMentionsInvalidEncryptedContent(responseBodyText);
    if (invalidEncryptedContent) {
      const quarantined = await this.conversationPortability.quarantineRejectedRequest(
        requestBody,
        targetUpstream
      ).catch(() => 0);
      if (quarantined) log.warn(`[compatible/tap] quarantined ${quarantined} opaque item(s) rejected by the selected upstream`);
    }
    if (upstreamError || (responseStatusCode ?? 0) >= 500 || invalidEncryptedContent) {
      const removed = await this.conversationPortability.noteUpstreamFailure(
        targetUpstream,
        `${responseStatusCode ?? ''} ${upstreamError?.message ?? ''} ${responseBodyText}`
      ).catch(() => 0);
      if (removed) log.warn(`[compatible/tap] invalidated ${removed} opaque 兼容服务 item origin(s) after upstream failure`);
    }
    const upstreamProtocol = protocolFromApiType(route.apiType, route.wireProtocol);
    const clientProtocol = protocolFromApiType(route.apiType);
    const usage = normalizeUsage(upstreamUsageRaw, upstreamProtocol)
      ?? sseSnapshot?.usage
      ?? snapshot.usage
      ?? normalizeUsage(clientUsageRaw, clientProtocol);
    const sseTiming = reassembler?.timing();
    const timing: TapTimingSnapshot = {
      ...(sseTiming ?? {}),
      firstByteMs,
      thinkingToTextMs: computeThinkingToText(sseTiming)
    };

    const trace: TapTraceRecord = {
      id: randomUUID(),
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: elapsedMs(startedNs),
      client: clientIdentity.client,
      clientIdentity,
      source: route.source,
      protocol: protocolForResolvedRoute(route),
      captureMode: captureModeFromSource(route.source),
      providerTransition,
      provider: traceProvider(route),
      request: {
        method: req.method || 'POST',
        path: localUrl.pathname,
        url: localUrl.pathname + localUrl.search,
        headers: sanitizeHeaders(req.headers),
        body: requestBody,
        rawBody: requestBody === undefined ? requestBodyText : undefined,
        model,
        apiType: route.apiType
      },
      upstream: {
        baseUrl: route.upstreamBaseUrl,
        url: upstreamUrl.toString(),
        connectionId: route.connectionId
      },
      response: {
        statusCode: responseStatusCode,
        statusMessage: responseStatusMessage,
        headers: sanitizeHeaders(responseHeaders),
        body: responseBody,
        rawBody: responseBody === undefined ? responseBodyText : undefined,
        snapshot
      },
      sse: {
        events: sseEvents,
        snapshot: sseSnapshot
      },
      usage,
      usageEvidence: {
        ...(upstreamUsageRaw === undefined ? {} : {
          upstream: { protocol: upstreamProtocol, raw: upstreamUsageRaw }
        }),
        ...(clientUsageRaw === undefined ? {} : {
          client: { protocol: clientProtocol, raw: clientUsageRaw }
        })
      },
      timings: stripUndefined(timing as unknown as Record<string, unknown>) as unknown as TapTimingSnapshot,
      xwxContext: analyzeRequestContext(requestBody),
      error: upstreamError?.message
    };
    if (this.recording && input.route.capture !== false && !shouldSkipTraceCapture(trace)) await this.traceStore.appendTrace(trace);
  }

  private async recordErrorTrace(input: {
    startedAt: Date;
    startedNs: bigint;
    req: http.IncomingMessage;
    localUrl: URL;
    requestBody: unknown;
    requestBodyText: string;
    apiType: TapApiType;
    model?: string;
    clientIdentity: TapClientIdentity;
    source?: TapTraceSource;
    error: string;
  }): Promise<void> {
    if (!this.recording) return;
    const completedAt = new Date();
    await this.traceStore.appendTrace({
      id: randomUUID(),
      startedAt: input.startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: elapsedMs(input.startedNs),
      client: input.clientIdentity.client,
      clientIdentity: input.clientIdentity,
      source: input.source,
      protocol: protocolFromApiType(input.apiType),
      captureMode: captureModeFromSource(input.source),
      request: {
        method: input.req.method || 'POST',
        path: input.localUrl.pathname,
        url: input.localUrl.pathname + input.localUrl.search,
        headers: sanitizeHeaders(input.req.headers),
        body: input.requestBody,
        rawBody: input.requestBody === undefined ? input.requestBodyText : undefined,
        model: input.model,
        apiType: input.apiType
      },
      upstream: { baseUrl: '', url: '' },
      response: { statusCode: 502, headers: {} },
      sse: { events: [] },
      timings: {},
      xwxContext: analyzeRequestContext(input.requestBody),
      error: input.error
    });
  }
}

interface ResolvedRoute {
  readonly path: string;
  readonly apiType: TapApiType;
  readonly upstreamBaseUrl: string;
  readonly source: TapTraceSource;
  readonly connectionId?: string;
  readonly modelId?: string;
  readonly stripPathPrefix?: string;
  readonly transform?: 'responses-to-chat' | 'responses-to-anthropic' | 'responses-compact-synthetic';
  readonly wireProtocol?: 'responses' | 'chat-completions' | 'anthropic-messages';
  readonly defaultMaxOutputTokens?: number;
  readonly nativeCompact?: boolean;
  readonly webSocket?: 'official-responses';
  readonly providerId?: string;
  readonly providerName?: string;
  readonly providerAdapter?: import('../../shared/providers').ProviderAdapter;
  readonly compatibleServiceGateway?: boolean;
  readonly excludedToolNamespaces?: readonly string[];
  readonly capture?: boolean;
  readonly upstreamBearerToken?: string;
  readonly blockedBearerToken?: string;
  readonly replacementBearerToken?: string;
  readonly upstreamProxyUrl?: string;
  readonly upstreamModelId?: string;
}

interface WebSocketTraceExchange {
  readonly startedAt: Date;
  readonly startedNs: bigint;
  readonly request: http.IncomingMessage;
  readonly localUrl: URL;
  readonly route: ResolvedRoute;
  readonly requestBody: unknown;
  readonly requestBodyText: string;
  readonly model?: string;
  readonly clientIdentity: TapClientIdentity;
  readonly conversationKey?: string;
  readonly targetUpstream: CodexUpstreamIdentity;
  readonly providerTransitionActive: boolean;
  readonly providerTransition?: TapTraceRecord['providerTransition'];
  readonly providerTransitionConsumer: boolean;
  readonly userVisibleResponse: boolean;
  readonly upstreamUrl: URL;
  readonly upstreamHeaders: http.IncomingHttpHeaders;
  readonly responseFrames: string[];
  readonly reassembler: SSEReassembler;
  readonly capture: boolean;
  firstByteMs?: number;
}

function resolveClientRoute(route: TapClientRoute, model: string | undefined): ResolvedRoute {
  const upstreamModelId = model ? route.modelAliases?.[model] ?? model : undefined;
  const declaredProtocol = upstreamModelId ? route.modelProtocols?.[upstreamModelId] : undefined;
  const wireProtocol = declaredProtocol
    ?? route.defaultProtocol
    ?? (route.transform === 'responses-to-chat' || route.apiType === 'chat-completions' ? 'chat-completions'
      : route.transform === 'responses-to-anthropic' || route.apiType === 'messages' ? 'anthropic-messages' : 'responses');
  const nativeCompact = upstreamModelId ? route.modelSupportsCompact?.[upstreamModelId] === true : false;
  const transform = route.transform === 'responses-to-chat-auto'
    ? (wireProtocol === 'chat-completions'
      ? 'responses-to-chat'
      : wireProtocol === 'anthropic-messages'
        ? 'responses-to-anthropic'
        : undefined)
    : route.transform === 'responses-compact-auto'
      ? (nativeCompact ? undefined : 'responses-compact-synthetic')
      : route.transform;
  return {
    path: route.path,
    apiType: route.apiType,
    upstreamBaseUrl: route.upstreamBaseUrl,
    source: route.source,
    stripPathPrefix: route.stripPathPrefix,
    transform,
    wireProtocol,
    defaultMaxOutputTokens: upstreamModelId ? route.modelMaxOutputTokens?.[upstreamModelId] : undefined,
    nativeCompact,
    webSocket: route.webSocket,
    providerId: route.providerId,
    providerName: route.providerName,
    providerAdapter: route.providerAdapter,
    compatibleServiceGateway: route.compatibleServiceGateway,
    excludedToolNamespaces: route.excludedToolNamespaces,
    capture: route.capture,
    upstreamBearerToken: route.upstreamBearerToken,
    blockedBearerToken: route.blockedBearerToken,
    replacementBearerToken: route.replacementBearerToken,
    upstreamProxyUrl: route.upstreamProxyUrl,
    upstreamModelId
  };
}

function replaceRequestModel(value: unknown, model: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return { ...(value as Record<string, unknown>), model };
}

function excludeToolNamespaces(value: unknown, names: readonly string[]): unknown {
  const excluded = new Set(names);
  // Covers the top-level `tools` field and the responses-lite `additional_tools`
  // input item alike; otherwise the exclusion silently no-ops for Codex Desktop
  // and the namespace still reaches an upstream that rejects it.
  return mapDeclaredResponsesTools(value, tools => tools.filter(tool => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return true;
    const item = tool as Record<string, unknown>;
    return !(item.type === 'namespace' && typeof item.name === 'string' && excluded.has(item.name));
  }));
}

function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
    };
    const finish = (body: Buffer) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(body);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const onEnd = () => finish(Buffer.concat(chunks));
    const onError = (error: Error) => fail(error);
    const onAborted = () => fail(new Error('client aborted request body'));
    const onClose = () => {
      if (!req.complete) fail(new Error('client disconnected before request body completed'));
    };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
    req.once('close', onClose);
  });
}

/**
 * 使用字符串拼接而不是 WHATWG URL 的相对解析。
 *
 * `new URL('/v1/messages', 'https://host.com/anthropic')` 会返回
 * `https://host.com/v1/messages` — “/v1/messages” 是绝对路径，会
 * 覆盖掉 base URL 的 `/anthropic` 前缀。这是个难查的陷阱：造成
 * Claude CLI 走本地代理转发到 `<compatible>/anthropic` 时选择丢丢
 * `/anthropic` 后缀，兼容服务 返 404，CLI 表现为“模型不存在”。
 */
function buildUpstreamUrl(
  upstreamBaseUrl: string,
  localUrl: URL,
  stripPrefix?: string,
  transform?: 'responses-to-chat' | 'responses-to-anthropic' | 'responses-compact-synthetic',
  wireProtocol: 'responses' | 'chat-completions' | 'anthropic-messages' = 'responses'
): URL {
  let pathname = localUrl.pathname;
  const responsesPath = pathname === '/v1/responses' || pathname === '/backend-api/codex/responses';
  if (transform === 'responses-to-chat' && responsesPath) pathname = '/v1/chat/completions';
  if (transform === 'responses-to-anthropic' && responsesPath) pathname = '/anthropic/v1/messages';
  if (transform === 'responses-compact-synthetic') {
    pathname = wireProtocol === 'chat-completions'
      ? '/v1/chat/completions'
      : wireProtocol === 'anthropic-messages'
        ? '/anthropic/v1/messages'
        : '/v1/responses';
  }
  if (stripPrefix && pathname.startsWith(stripPrefix)) {
    pathname = pathname.slice(stripPrefix.length) || '/';
  }
  let base = stripTrailingSlash(upstreamBaseUrl);
  // Responses bridges use OpenAI's canonical /v1 endpoint paths internally.
  // A configured /api/v3, /v4, or other version root already supplies that
  // segment, including when Desktop entered through /backend-api/codex.
  if (providerBaseHasVersionRoot(base) && pathname.startsWith('/v1/')) {
    pathname = pathname.slice('/v1'.length);
  }
  if (wireProtocol === 'anthropic-messages') {
    // Canonical Anthropic target is `<root>/anthropic/v1/messages`. The configured
    // base may already carry `/anthropic`, `/v1`, or `/anthropic/v1`, while the
    // request path can be native (`/v1/messages`, from Claude Code) or already
    // rewritten to `/anthropic/v1/messages` (Responses→Anthropic transform).
    // Strip only the base segment the path is about to re-supply: dropping the
    // gateway `/anthropic` mount for a native `/v1/...` path produced upstream
    // 404s, while keeping it would double the segment for rewritten paths.
    if (pathname.startsWith('/anthropic')) {
      base = base.replace(/\/(?:anthropic\/v1|anthropic|v1)$/i, '');
    } else if (pathname.startsWith('/v1')) {
      base = base.replace(/\/v1$/i, '');
    }
  }
  return new URL(base + pathname + localUrl.search);
}

function buildForwardHeaders(
  input: http.IncomingHttpHeaders,
  host: string,
  bodyLength: number,
  bearerToken?: string,
  blockedBearerToken?: string,
  replacementBearerToken?: string,
  anthropic = false
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === 'host' || lower === 'content-length' || lower === 'accept-encoding') continue;
    if (value !== undefined) headers[key] = value;
  }
  if (bearerToken) {
    for (const key of Object.keys(headers)) if (['authorization', 'x-api-key', 'api-key', 'chatgpt-account-id', 'cookie'].includes(key.toLowerCase())) delete headers[key];
  }
  headers.host = host;
  headers['accept-encoding'] = 'identity';
  headers['content-length'] = bodyLength;
  if (blockedBearerToken && bearerHeaderMatches(headers.authorization, blockedBearerToken)) {
    delete headers.authorization;
    if (replacementBearerToken) headers.authorization = `Bearer ${replacementBearerToken}`;
  }
  if (replacementBearerToken) {
    delete headers['x-api-key']; delete headers['api-key'];
    headers.authorization = `Bearer ${replacementBearerToken}`;
  }
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
  if (anthropic) headers['anthropic-version'] = '2023-06-01';
  return headers;
}

function buildWebSocketForwardHeaders(
  input: http.IncomingHttpHeaders,
  blockedBearerToken?: string,
  replacementBearerToken?: string
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)
      || lower === 'host'
      || lower === 'content-length'
      || lower === 'accept-encoding'
      || lower.startsWith('sec-websocket-')) continue;
    if (value !== undefined) headers[key] = value;
  }
  if (blockedBearerToken && bearerHeaderMatches(headers.authorization, blockedBearerToken)) {
    delete headers.authorization;
    if (replacementBearerToken) headers.authorization = `Bearer ${replacementBearerToken}`;
  }
  if (replacementBearerToken) {
    delete headers['x-api-key']; delete headers['api-key'];
    headers.authorization = `Bearer ${replacementBearerToken}`;
  }
  return headers;
}

function parseWebSocketProtocols(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function appendWebSocketResponseHeaders(
  output: string[],
  input: http.IncomingHttpHeaders | undefined
): void {
  if (!input) return;
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase();
    if (value === undefined
      || HOP_BY_HOP_HEADERS.has(lower)
      || lower === 'content-length'
      || lower.startsWith('sec-websocket-')) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) output.push(`${key}: ${item}`);
  }
}

function rawWebSocketDataText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function normalizeWebSocketCloseCode(code: number): number {
  return code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1011;
}

function rejectUpgrade(socket: Duplex, statusCode: number, body: string): void {
  if (socket.destroyed) return;
  const statusMessage = statusCode === 426
    ? 'Upgrade Required'
    : statusCode === 503
      ? 'Service Unavailable'
      : 'Bad Gateway';
  socket.end([
    `HTTP/1.1 ${statusCode} ${statusMessage}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body
  ].join('\r\n'));
}

function webSocketConnectionKey(
  route: ResolvedRoute | undefined,
  request: http.IncomingMessage,
  localUrl: URL
): string | undefined {
  if (!route || !isOfficialResponsesWebSocketRoute(route)) return undefined;
  return JSON.stringify([
    buildUpstreamUrl(route.upstreamBaseUrl, localUrl, route.stripPathPrefix, undefined, 'responses').toString(),
    route.upstreamProxyUrl ?? '',
    buildWebSocketForwardHeaders(request.headers, route.blockedBearerToken, route.replacementBearerToken)
  ]);
}

function isOfficialResponsesWebSocketRoute(route: ResolvedRoute): boolean {
  if (route.webSocket !== 'official-responses'
    || route.compatibleServiceGateway === true
    || route.transform
    || (route.wireProtocol && route.wireProtocol !== 'responses')) return false;
  return true;
}

function proxyRouteLabel(proxyUrl: string | undefined): string {
  if (!proxyUrl) return 'DIRECT';
  try { return new URL(proxyUrl).host; }
  catch { return 'configured'; }
}

function bearerHeaderMatches(value: http.OutgoingHttpHeaders[string], token: string): boolean {
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === 'string' && text.trim() === `Bearer ${token}`;
}

function routeUpstreamIdentity(
  route: Pick<ResolvedRoute, 'providerId' | 'compatibleServiceGateway' | 'upstreamBaseUrl' | 'upstreamBearerToken'>,
  headers: http.IncomingHttpHeaders
): CodexUpstreamIdentity {
  return codexUpstreamIdentity({
    kind: route.providerId ? `provider:${route.providerId}` : route.compatibleServiceGateway === true ? 'compatible' : 'official',
    baseUrl: route.upstreamBaseUrl,
    credential: route.providerId || route.compatibleServiceGateway === true
      ? route.upstreamBearerToken
      : undefined,
    accountId: headerValue(headers, 'chatgpt-account-id')
  });
}

function codexThreadId(headers: http.IncomingHttpHeaders, body: unknown): string | undefined {
  const metadata = safeJsonParse(headerValue(headers, 'x-codex-turn-metadata'));
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const record = metadata as Record<string, unknown>;
    for (const key of ['thread_id', 'session_id', 'parent_thread_id']) {
      if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim();
    }
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const clientMetadata = (body as Record<string, unknown>).client_metadata;
    if (clientMetadata && typeof clientMetadata === 'object' && !Array.isArray(clientMetadata)) {
      const record = clientMetadata as Record<string, unknown>;
      for (const key of ['thread_id', 'session_id']) {
        if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim();
      }
    }
  }
  return headerValue(headers, 'thread-id') || headerValue(headers, 'session-id') || undefined;
}

function codexConversationKey(
  headers: http.IncomingHttpHeaders,
  body: unknown,
  identity: TapClientIdentity
): string | undefined {
  if (identity.family !== 'codex') return undefined;
  const threadId = codexThreadId(headers, body);
  return threadId ? `${identity.source}:${threadId}` : undefined;
}

function responseNeedsContinuation(snapshot: ReturnType<typeof snapshotFromJson>): boolean {
  const hasToolBlock = snapshot.content.some(block => block.type === 'tool_use');
  const hasAssistantText = snapshot.content.some(block => block.type === 'text' && !!block.text?.trim());
  if (hasToolBlock && !hasAssistantText) return true;
  const raw = snapshot.raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const output = (raw as Record<string, unknown>).output;
  if (!Array.isArray(output)) return false;
  const hasClientToolCall = output.some(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const type = (item as Record<string, unknown>).type;
    return type === 'function_call' || type === 'custom_tool_call';
  });
  if (!hasClientToolCall) return false;
  return !output.some(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const entry = item as Record<string, unknown>;
    return entry.type === 'message' && Array.isArray(entry.content) && entry.content.some(part => (
      !!part && typeof part === 'object' && !Array.isArray(part)
      && typeof (part as Record<string, unknown>).text === 'string'
      && !!((part as Record<string, unknown>).text as string).trim()
    ));
  });
}

function responseMentionsInvalidEncryptedContent(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes('invalid_encrypted_content')
    || normalized.includes('encrypted content could not be decrypted')
    || normalized.includes('encrypted content could not be verified');
}

function filterResponseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function sanitizeHeaders(headers: http.IncomingHttpHeaders | http.OutgoingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (Array.isArray(value)) {
      out[key] = SENSITIVE_HEADERS.has(lower)
        ? value.map(redact)
        : value.map(String);
    } else {
      out[key] = SENSITIVE_HEADERS.has(lower) ? redact(String(value)) : String(value);
    }
  }
  return out;
}

/** Build a minimal TapTraceRecord shape for findInflightSession; only fields it actually reads are filled. */
function synthesizeInflightProbe(input: {
  startedAt: Date;
  req: http.IncomingMessage;
  requestBody: unknown;
  requestBodyText: string;
  model: string | undefined;
  route: { upstreamBaseUrl: string; apiType: TapApiType; source: TapTraceSource };
  clientIdentity: TapClientIdentity;
  localUrl: URL;
}): TapTraceRecord {
  return {
    id: 'inflight-probe',
    startedAt: input.startedAt.toISOString(),
    completedAt: '',
    durationMs: 0,
    source: input.route.source,
    client: input.clientIdentity.client,
    clientIdentity: input.clientIdentity,
    request: {
      method: input.req.method || 'POST',
      path: input.localUrl.pathname,
      url: input.localUrl.pathname + input.localUrl.search,
      headers: sanitizeHeaders(input.req.headers),
      body: input.requestBody,
      rawBody: input.requestBody === undefined ? input.requestBodyText : undefined,
      model: input.model,
      apiType: input.route.apiType
    },
    upstream: { baseUrl: '', url: '' },
    response: { headers: {} },
    sse: { events: [] },
    timings: {}
  };
}

/**
 * Provider transitions remain active through client-maintenance traffic.
 * Only a successful visible main-agent request proves that the switched
 * provider can carry the actual conversation; title, memory, compact,
 * structured utility and subagent requests must not consume that checkpoint.
 */
function isProviderTransitionConsumer(trace: TapTraceRecord): boolean {
  if (detectCompact(trace)) return false;
  if (classifyAuxiliaryTrace(trace) || isCodexStructuredUtilityTrace(trace)) return false;
  if (getCopilotClassification(trace)) return false;
  if (detectSubagent(trace)) return false;
  return true;
}

/**
 * Exit prompts should describe work the user can actually see being generated.
 * The transport counter remains broader so shutdown still drains model-list,
 * token-count, compaction, title, memory and other helper traffic safely.
 */
function isUserVisibleResponseRequest(trace: TapTraceRecord): boolean {
  const pathname = trace.request.path.replace(/\/+$/, '');
  if (pathname.endsWith('/models') || pathname.endsWith('/count_tokens')) return false;
  return isProviderTransitionConsumer(trace);
}

function redact(value: string): string {
  void value;
  return '<redacted>';
}

function parseOptionalInt(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

function elapsedMs(startedNs: bigint): number {
  return Math.max(0, Math.round(Number(process.hrtime.bigint() - startedNs) / 1_000_000));
}

/**
 * A folded chat.completion with no assistant text, no tool calls and no usage
 * means the upstream returned a broken/unparseable 200 body. Treat it as an
 * error rather than a hollow "completed" Responses reply the client can't use.
 */
function isHollowChatCompletion(chat: unknown): boolean {
  if (!chat || typeof chat !== 'object') return true;
  const choice = (chat as any).choices?.[0];
  const message = choice?.message ?? {};
  const hasText = typeof message.content === 'string' ? message.content.trim() !== '' : Array.isArray(message.content) && message.content.length > 0;
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  const hasReasoning = typeof message.reasoning_content === 'string' && message.reasoning_content.trim() !== '';
  return !hasText && !hasToolCalls && !hasReasoning;
}

function computeThinkingToText(timing: TapTimingSnapshot | undefined): number | undefined {
  if (!timing || typeof timing.firstThinkingMs !== 'number' || typeof timing.firstTextMs !== 'number') return undefined;
  return Math.max(0, timing.firstTextMs - timing.firstThinkingMs);
}

function shouldSkipTraceCapture(trace: TapTraceRecord): boolean {
  if (trace.source !== 'copilot') return false;
  if (detectCompact(trace)) return false;  // compact 永远不 skip
  const c = classifyCopilotUtility(trace);
  return !!c && c.visibility === 'skip';
}

/**
 * Map a request's protocol for trace display. When `wireProtocol` is provided
 * (i.e. the request was routed through the 兼容服务 gateway and possibly
 * converted), it reflects the protocol actually sent upstream — not the path
 * the client used to reach us. This keeps the trace honest for models like
 * GLM/DeepSeek/Kimi that arrive on /v1/responses but are bridged to Chat
 * Completions before reaching the upstream model.
 */
function protocolFromApiType(apiType: TapApiType, wireProtocol?: 'responses' | 'chat-completions' | 'anthropic-messages'): TapProtocol {
  if (wireProtocol === 'responses') return 'openai-responses';
  if (wireProtocol === 'chat-completions') return 'openai-chat-completions';
  if (wireProtocol === 'anthropic-messages') return 'anthropic-messages';
  if (apiType === 'messages') return 'anthropic-messages';
  if (apiType === 'responses') return 'openai-responses';
  if (apiType === 'chat-completions') return 'openai-chat-completions';
  return 'unknown';
}

/**
 * Native client routes keep their request protocol even when the model catalog
 * carries a different default protocol for Codex gateway routing. The wire
 * protocol only describes this trace when a bridge actually transformed the
 * request before forwarding it upstream.
 */
function protocolForResolvedRoute(route: Pick<ResolvedRoute, 'apiType' | 'wireProtocol' | 'transform'>): TapProtocol {
  return protocolFromApiType(route.apiType, route.transform ? route.wireProtocol : undefined);
}

function usageFromEnvelope(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>).usage;
}

function captureModeFromSource(source: TapTraceSource | undefined): TapCaptureMode {
  if (source === 'copilot') return 'custom-endpoint';
  if (source === 'claude-cli' || source === 'claude-vscode' || source === 'codex-cli' || source === 'codex-vscode') {
    return 'reverse-proxy';
  }
  return 'unknown';
}

export const __test = {
  sanitizeHeaders,
  buildForwardHeaders,
  buildUpstreamUrl,
  detectClientFromUserAgent,
  identifyClient,
  refineClaudeSource,
  refineCodexSource,
  detectStrongVscodeSource,
  resolveTraceSource,
  protocolFromApiType,
  protocolForResolvedRoute,
  captureModeFromSource,
  shouldSkipTraceCapture,
  isProviderTransitionConsumer,
  isUserVisibleResponseRequest
};

function traceProvider(route: ResolvedRoute): TapTraceRecord['provider'] {
  return route.providerId ? { id: route.providerId.replace(/_[a-f0-9]{16}$/, ''), name: route.providerName ?? '', connectionId: route.providerId } : undefined;
}
