import * as fs from 'fs';
import * as path from 'path';
import { readTextOrUndefined, writeFileAtomic } from '../shared/fsx';
import type { ClientTakeoverResult } from './clientConfigOrchestrator';

const VERSION = 1;

interface StoredClientFallback {
  readonly client: ClientTakeoverResult['client'];
  readonly upstreamBaseUrl: string;
  readonly stripV1?: boolean;
  readonly codexRouteKind?: ClientTakeoverResult['codexRouteKind'];
}

interface StoredClientFallbackState {
  readonly version: typeof VERSION;
  readonly localBaseUrl: string;
  readonly clients: readonly StoredClientFallback[];
  readonly updatedAt: string;
}

export interface ClientFallbackState {
  readonly localBaseUrl: string;
  readonly takeovers: readonly ClientTakeoverResult[];
}

/**
 * Persists non-recording routes for clients that may have cached the local
 * Gateway endpoint after Trace restores their on-disk configuration.
 */
export class ClientFallbackStore {
  constructor(private readonly userDataDir: string) {}

  async read(): Promise<ClientFallbackState | undefined> {
    const text = await readTextOrUndefined(this.path());
    if (!text) return undefined;
    try {
      const value = JSON.parse(text) as Partial<StoredClientFallbackState>;
      if (value.version !== VERSION || !validLocalGatewayUrl(value.localBaseUrl) || !Array.isArray(value.clients)) {
        return undefined;
      }
      const takeovers = value.clients
        .map(readClient)
        .filter((item): item is ClientTakeoverResult => !!item);
      if (!takeovers.length) return undefined;
      return {
        localBaseUrl: value.localBaseUrl!,
        takeovers
      };
    } catch {
      return undefined;
    }
  }

  async write(localBaseUrl: string, takeovers: readonly ClientTakeoverResult[]): Promise<void> {
    if (!validLocalGatewayUrl(localBaseUrl)) {
      throw new Error('Non-recording client fallback requires a loopback Gateway URL.');
    }
    const clients = takeovers
      .filter((item): item is ClientTakeoverResult & { upstreamBaseUrl: string } => (
        item.status === 'taken' && validHttpUrl(item.upstreamBaseUrl)
      ))
      .map(item => ({
        client: item.client,
        upstreamBaseUrl: item.upstreamBaseUrl,
        ...(item.stripV1 === undefined ? {} : { stripV1: item.stripV1 }),
        ...(item.codexRouteKind === undefined ? {} : { codexRouteKind: item.codexRouteKind })
      }));
    if (!clients.length) {
      await this.clear();
      return;
    }
    const state: StoredClientFallbackState = {
      version: VERSION,
      localBaseUrl,
      clients,
      updatedAt: new Date().toISOString()
    };
    await writeFileAtomic(this.path(), `${JSON.stringify(state, null, 2)}\n`);
  }

  async clear(): Promise<void> {
    await fs.promises.rm(this.path(), { force: true });
  }

  private path(): string {
    return path.join(this.userDataDir, 'gateway', 'client-fallbacks.json');
  }
}

function readClient(value: unknown): ClientTakeoverResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Partial<StoredClientFallback>;
  if ((item.client !== 'claude-cli' && item.client !== 'codex-cli')
    || !validHttpUrl(item.upstreamBaseUrl)) return undefined;
  const codexRouteKind = item.codexRouteKind === 'chatgpt-oauth'
    || item.codexRouteKind === 'openai-api'
    || item.codexRouteKind === 'custom-provider'
    ? item.codexRouteKind
    : undefined;
  return {
    client: item.client,
    status: 'taken',
    upstreamBaseUrl: item.upstreamBaseUrl,
    ...(item.stripV1 === undefined ? {} : { stripV1: item.stripV1 === true }),
    ...(codexRouteKind === undefined ? {} : { codexRouteKind })
  };
}

function validHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validLocalGatewayUrl(value: unknown): value is string {
  if (!validHttpUrl(value)) return false;
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}
