import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { nativeTestBinary } from './test-support.mjs';

/** Isolated test transport; synthetic credentials never use the user's vault. */
export function startNativeRpc(root, extraArgs = [], requestTimeoutMs = 15000) {
  const child = spawn(nativeTestBinary, ['--rpc', '--pilot-root', root, ...extraArgs], {
    env: { ...process.env, XWX_DECK_TEST_SECURE_STORE: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let sequence = 0;
  const fail = error => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  // Drain stderr without exposing credential-bearing upstream errors.
  child.stderr.resume();
  child.on('error', fail);
  child.on('exit', () => fail(new Error('Isolated RPC process exited')));
  createInterface({ input: child.stdout }).on('line', line => {
    let value;
    try { value = JSON.parse(line); } catch { fail(new Error('Invalid isolated RPC response')); return; }
    const entry = pending.get(value.requestId);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(value.requestId);
    value.ok ? entry.resolve(value.result) : entry.reject(new Error(value.error));
  });
  const rpc = (method, ...args) => new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) { reject(new Error("Isolated RPC process already exited")); return; }
    const requestId = ++sequence;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out`)); }, requestTimeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ requestId, method, args }) + '\n');
  });
  return {
    rpc,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit'); child.stdin.end();
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { assert.equal((await exited)[0], 0); } finally { clearTimeout(timeout); }
    },
  };
}
