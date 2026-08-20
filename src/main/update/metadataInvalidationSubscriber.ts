import { log } from '../shared/logger';

export type MetadataTopic = 'models' | 'capabilities' | 'pricing';

export interface MetadataInvalidation {
  readonly revision?: number;
  readonly topics: readonly MetadataTopic[];
  readonly reason: 'push' | 'fallback';
}

type MetadataFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class MetadataInvalidationSubscriber {
  private stopped = true;
  private abort: AbortController | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private fallbackTimer: ReturnType<typeof setInterval> | undefined;
  private lastEventId = '';
  private connectedOnce = false;
  private outageReported = false;
  private refreshChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly url: string,
    private readonly onInvalidate: (event: MetadataInvalidation) => Promise<void>,
    private readonly options: {
      readonly fetcher?: MetadataFetcher;
      readonly fallbackMs?: number;
      readonly reconnectMs?: number;
      readonly logger?: Pick<typeof log, 'info' | 'warn'>;
    } = {}
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const fallbackMs = Math.max(60_000, this.options.fallbackMs ?? 6 * 60 * 60 * 1_000);
    this.fallbackTimer = setInterval(() => {
      this.enqueue({ topics: allTopics(), reason: 'fallback' });
    }, fallbackMs);
    this.fallbackTimer.unref?.();
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    this.abort = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.reconnectTimer = undefined;
    this.fallbackTimer = undefined;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const fetcher = this.options.fetcher ?? fetch;
    const abort = new AbortController();
    this.abort = abort;
    let disconnectMessage = 'stream ended';
    try {
      const response = await fetcher(this.url, {
        headers: {
          accept: 'text/event-stream',
          ...(this.lastEventId ? { 'last-event-id': this.lastEventId } : {})
        },
        cache: 'no-store',
        signal: abort.signal
      });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      if (!this.connectedOnce || this.outageReported) {
        this.options.logger?.info?.(`[metadata] push connected: ${this.url}`);
      }
      this.connectedOnce = true;
      this.outageReported = false;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!this.stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          this.consume(block);
        }
      }
    } catch (error) {
      disconnectMessage = (error as Error).message;
    } finally {
      if (this.abort === abort) this.abort = undefined;
      if (!this.stopped) {
        if (!abort.signal.aborted && !this.outageReported) {
          this.options.logger?.warn?.(`[metadata] push disconnected: ${disconnectMessage}`);
          this.outageReported = true;
        }
        this.scheduleReconnect();
      }
    }
  }

  private consume(block: string): void {
    let event = 'message';
    let id = '';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'data') data.push(value);
    }
    if (id) this.lastEventId = id;
    if (event !== 'metadata' || !data.length) return;
    try {
      const parsed = JSON.parse(data.join('\n')) as { revision?: unknown; topics?: unknown };
      const topics = normalizeTopics(parsed.topics);
      if (!topics.length) return;
      this.enqueue({
        revision: typeof parsed.revision === 'number' ? parsed.revision : undefined,
        topics,
        reason: 'push'
      });
    } catch {
      // An invalid event is untrusted network data and is ignored.
    }
  }

  private enqueue(event: MetadataInvalidation): void {
    this.refreshChain = this.refreshChain
      .then(() => this.onInvalidate(event), () => this.onInvalidate(event))
      .catch(error => this.options.logger?.warn?.(`[metadata] refresh failed: ${(error as Error).message}`));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    const delay = Math.max(10, this.options.reconnectMs ?? 60_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}

function normalizeTopics(value: unknown): MetadataTopic[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((topic): topic is MetadataTopic => (
    topic === 'models' || topic === 'capabilities' || topic === 'pricing'
  )))];
}

function allTopics(): MetadataTopic[] {
  return ['models', 'capabilities', 'pricing'];
}
