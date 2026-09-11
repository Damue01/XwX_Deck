import { parentPort } from 'worker_threads';
import { CodexConversationScanCancelledError } from './app/codexConversationDoctor';
import { CodexConversationQueryEngine } from './app/codexConversationQueryEngine';
import type {
  CodexConversationWorkerRequest,
  CodexConversationWorkerResponse
} from './app/codexConversationWorkerProtocol';

if (!parentPort) throw new Error('Codex conversation worker requires a parent port.');

const engine = new CodexConversationQueryEngine();
let queue: Promise<void> = Promise.resolve();

parentPort.on('message', (message: CodexConversationWorkerRequest) => {
  queue = queue.then(() => handleMessage(message));
});

async function handleMessage(message: CodexConversationWorkerRequest): Promise<void> {
  try {
    if (message.type === 'page') {
      const cancelFlag = new Int32Array(message.cancelBuffer);
      const value = await engine.query(message.request, () => Atomics.load(cancelFlag, 0) !== 0);
      post({ id: message.id, ok: true, type: 'page', value });
      return;
    }
    const value = engine.detail(message.request);
    post({ id: message.id, ok: true, type: 'detail', value });
  } catch (error) {
    post({
      id: message.id,
      ok: false,
      cancelled: error instanceof CodexConversationScanCancelledError,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function post(response: CodexConversationWorkerResponse): void {
  parentPort!.postMessage(response);
}

