import * as http from 'http';
import { identifyClaude, refineClaudeSource } from './attribution/claude';
import { identifyCodex, refineCodexSource } from './attribution/codex';
import { identifyCopilot } from './attribution/copilot';
import { headerValue, type HeaderBag } from './protocolBody';
import {
  TapClientFamily,
  TapClientIdentity,
  TapTraceRecord,
  TapTraceSource
} from './types';
import { parseJsonObject } from '../shared/json';

export interface TapClientAdapter {
  readonly id: TapClientFamily;
  readonly identify: (headers: http.IncomingHttpHeaders, body: unknown) => TapClientIdentity | undefined;
  readonly conversationKey?: (trace: TapTraceRecord) => string | undefined;
}

const UNKNOWN_IDENTITY: TapClientIdentity = {
  family: 'unknown',
  surface: 'unknown',
  source: 'unknown',
  client: 'CustomEndpoint',
  confidence: 'weak',
  evidence: []
};

const COPILOT_ADAPTER: TapClientAdapter = {
  id: 'copilot',
  identify: headers => identifyCopilot(headers)
};

const CLAUDE_ADAPTER: TapClientAdapter = {
  id: 'claude',
  identify: identifyClaude,
  conversationKey: trace => stableId(headerValue(trace.request?.headers, 'x-claude-code-session-id'))
};

const CODEX_ADAPTER: TapClientAdapter = {
  id: 'codex',
  identify: identifyCodex,
  conversationKey: trace => {
    const headers = trace.request?.headers ?? {};
    const clientMetadata = codexClientMetadata(trace.request?.body);
    const metadata = parseJsonObject(headerValue(headers, 'x-codex-turn-metadata'))
      ?? parseJsonObject(stringField(clientMetadata, 'x-codex-turn-metadata'));
    const parentThread = stringField(metadata, 'parent_thread_id');
    const parentOwnsRequest = isCodexParentedAgentRequest(metadata, headers);
    const fromMetadata = parentOwnsRequest && parentThread
      ? parentThread
      : stringField(metadata, 'thread_id')
      ?? stringField(clientMetadata, 'thread_id')
      ?? stringField(metadata, 'session_id')
      ?? stringField(clientMetadata, 'session_id')
      ?? parentThread;
    const fromHeader = headerValue(headers, 'thread-id')
      || headerValue(headers, 'session-id');
    const fromWindow = windowThreadId(headerValue(headers, 'x-codex-window-id'))
      ?? windowThreadId(stringField(metadata, 'window_id'))
      ?? windowThreadId(stringField(clientMetadata, 'x-codex-window-id'));
    return stableId(fromMetadata || fromHeader || fromWindow);
  }
};

const CLIENT_ADAPTERS: readonly TapClientAdapter[] = [
  // Copilot must stay before protocol-native clients: Copilot can emit both
  // Anthropic Messages and OpenAI Responses payloads from the VS Code extension.
  COPILOT_ADAPTER,
  CLAUDE_ADAPTER,
  CODEX_ADAPTER
];

export function identifyClient(headers: http.IncomingHttpHeaders, body: unknown): TapClientIdentity {
  for (const adapter of CLIENT_ADAPTERS) {
    const identity = adapter.identify(headers, body);
    if (identity) return identity;
  }
  return UNKNOWN_IDENTITY;
}

export function resolveTraceSource(identity: TapClientIdentity, routeSource: TapTraceSource): TapTraceSource {
  return identity.source !== 'unknown' ? identity.source : routeSource;
}

export function clientRouteMatchesIdentity(routeSource: TapTraceSource, identity: TapClientIdentity): boolean {
  if (identity.source === 'unknown') return true;
  if (routeSource === identity.source) return true;
  return sourceFamily(routeSource) === identity.family;
}

export function sourceFamily(source: TapTraceSource): TapClientFamily {
  if (source === 'claude-cli' || source === 'claude-vscode') return 'claude';
  if (source === 'codex-cli' || source === 'codex-vscode') return 'codex';
  if (source === 'copilot') return 'copilot';
  return 'unknown';
}

export function extractClientConversationKey(trace: TapTraceRecord): string | undefined {
  const adapter = adapterForTrace(trace);
  const key = adapter?.conversationKey?.(trace);
  const source = trace.source;
  return key && source && source !== 'unknown' ? `${source}:${key}` : undefined;
}

export function detectClientFromUserAgent(userAgent: string | string[] | undefined): TapTraceSource | undefined {
  if (!userAgent) return undefined;
  const headers: HeaderBag = { 'user-agent': Array.isArray(userAgent) ? userAgent : String(userAgent) };
  const identity = identifyClient(headers, undefined);
  return identity?.source === 'unknown' ? undefined : identity?.source;
}

export function detectStrongVscodeSource(body: unknown, headers: http.IncomingHttpHeaders): TapTraceSource | undefined {
  const claude = identifyClaude(headers, body);
  if (claude?.source === 'claude-vscode' && claude.confidence === 'strong') return 'claude-vscode';
  const codex = identifyCodex(headers, body);
  if (codex?.source === 'codex-vscode' && codex.confidence === 'strong') return 'codex-vscode';
  return undefined;
}

export { refineClaudeSource, refineCodexSource };

function adapterForTrace(trace: TapTraceRecord): TapClientAdapter | undefined {
  const family = trace.clientIdentity?.family ?? sourceFamily(trace.source || 'unknown');
  return CLIENT_ADAPTERS.find(adapter => adapter.id === family);
}

function codexClientMetadata(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const meta = (body as Record<string, unknown>).client_metadata;
  if (!meta || typeof meta !== 'object') return undefined;
  return meta as Record<string, unknown>;
}

function isCodexParentedAgentRequest(
  metadata: Record<string, unknown> | undefined,
  headers: Record<string, string | string[]>
): boolean {
  const threadSource = stringField(metadata, 'thread_source');
  if (threadSource === 'subagent') return true;
  if (stringField(metadata, 'subagent_kind')) return true;
  return !!stableId(headerValue(headers, 'x-openai-subagent'));
}

function windowThreadId(windowId: string | undefined): string | undefined {
  const id = stableId(windowId);
  return id ? id.split(':')[0] : undefined;
}

function stableId(value: string | undefined): string | undefined {
  const trimmed = (value || '').trim();
  if (!trimmed || trimmed.length > 200) return undefined;
  return trimmed;
}

function stringField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
