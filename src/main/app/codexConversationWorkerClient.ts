import * as path from 'path';
import { Worker } from 'worker_threads';
import type {
  CodexConversationDetailRequest,
  CodexConversationHealthRow,
  CodexConversationPageRequest,
  CodexConversationPageResponse
} from '../../shared/codexConversationHealth';
import type {
  CodexConversationWorkerRequest,
  CodexConversationWorkerResponse
} from './codexConversationWorkerProtocol';

const DEFAULT_CACHE_RELEASE_DELAY_MS = 3 * 60_000;

interface PendingOperation<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

export class CodexConversationWorkerClient {
  private worker: Worker | undefined;
  private sequence = 0;
  private readonly pending = new Map<string, PendingOperation<unknown>>();
  private readonly cancellationFlags = new Map<string, Int32Array>();
  private releaseTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly workerScriptPath?: string,
    private readonly cacheReleaseDelayMs = DEFAULT_CACHE_RELEASE_DELAY_MS
  ) {}

  query(request: CodexConversationPageRequest): Promise<CodexConversationPageResponse> {
    this.setActive(true);
    if (this.pending.has(request.requestId)) throw new Error('重复的对话诊断请求 ID。');
    const cancelBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const flag = new Int32Array(cancelBuffer);
    this.cancellationFlags.set(request.requestId, flag);
    return this.send<CodexConversationPageResponse>({
      id: request.requestId,
      type: 'page',
      request,
      cancelBuffer
    }).finally(() => {
      if (this.cancellationFlags.get(request.requestId) === flag) {
        this.cancellationFlags.delete(request.requestId);
      }
    });
  }

  detail(request: CodexConversationDetailRequest): Promise<CodexConversationHealthRow> {
    this.setActive(true);
    const id = `detail:${++this.sequence}`;
    return this.send<CodexConversationHealthRow>({ id, type: 'detail', request });
  }

  cancel(requestId: string): boolean {
    const flag = this.cancellationFlags.get(requestId);
    if (!flag) return false;
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
    return true;
  }

  setActive(active: boolean): void {
    if (active) {
      if (this.releaseTimer) clearTimeout(this.releaseTimer);
      this.releaseTimer = undefined;
      return;
    }
    if (!this.worker || this.releaseTimer) return;
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = undefined;
      void this.dispose();
    }, this.cacheReleaseDelayMs);
    this.releaseTimer.unref?.();
  }

  async dispose(): Promise<void> {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = undefined;
    const worker = this.worker;
    this.worker = undefined;
    this.rejectAll(new Error('对话诊断后台线程已停止。'));
    this.cancellationFlags.clear();
    if (worker) await worker.terminate();
  }

  private send<T>(message: CodexConversationWorkerRequest): Promise<T> {
    const worker = this.requireWorker();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(message.id, {
        resolve: value => resolve(value as T),
        reject
      });
      try {
        worker.postMessage(message);
      } catch (error) {
        this.pending.delete(message.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private requireWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(
      this.workerScriptPath ?? path.join(__dirname, 'codex-conversation-worker.js')
    );
    worker.on('message', (response: CodexConversationWorkerResponse) => this.handleResponse(response));
    worker.on('error', error => {
      if (this.worker === worker) this.worker = undefined;
      this.cancellationFlags.clear();
      this.rejectAll(error);
    });
    worker.on('exit', code => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.cancellationFlags.clear();
      this.rejectAll(new Error(
        code === 0 ? '对话诊断后台线程已结束。' : `对话诊断后台线程异常退出（${code}）。`
      ));
    });
    this.worker = worker;
    return worker;
  }

  private handleResponse(response: CodexConversationWorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.value);
    else pending.reject(new Error(response.error));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

