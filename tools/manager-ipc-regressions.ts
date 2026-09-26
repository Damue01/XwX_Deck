import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vm from 'node:vm';
import ts from 'typescript';

/** Execute both sides of the IPC contract, including payload validation. */
export async function testManagerIpc(): Promise<void> {
  const handlers = new Map<string, Function>();
  const events = new Map<string, Function>();
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const controller = new Proxy({}, { get: (_target, method) => (...args: unknown[]) => {
    calls.push({ method: String(method), args }); return args;
  } });
  const exports: any = {};
  const electron = { ipcMain: {
    handle: (channel: string, handler: Function) => handlers.set(channel, handler),
    on: (channel: string, handler: Function) => events.set(channel, handler)
  }, BrowserWindow: {}, shell: {}, dialog: {} };
  vm.runInNewContext(ts.transpile(await fs.readFile('src/main/ipc/registerHandlers.ts', 'utf8'), {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
  }), { exports, require: (name: string) => name === 'electron' ? electron : name === 'path' ? path : {} });
  exports.registerIpcHandlers({ controller: () => controller, managerWindow: {}, packagedSmokeTest: true });
  let api: any;
  const invoked = new Set<string>();
  vm.runInNewContext(ts.transpile(await fs.readFile('src/main/preload.ts', 'utf8'), {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
  }), { exports: {}, window: { addEventListener() {} }, process: { platform: process.platform },
    require: () => ({ contextBridge: { exposeInMainWorld: (name: string, value: unknown) => {
      assert.equal(name, 'xwxDeck'); api = value;
    } }, clipboard: { writeText() {} }, ipcRenderer: {
      on() {}, removeListener() {}, send: (channel: string) => assert.ok(events.has(channel), channel),
      invoke: (channel: string, ...args: unknown[]) => {
        invoked.add(channel); assert.ok(handlers.has(channel), channel);
        return handlers.get(channel)!({}, ...args);
      }
    } })
  });
  const preload = await fs.readFile('src/main/preload.ts', 'utf8');
  for (const [, channel] of preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)) assert.ok(handlers.has(channel), channel);
  await api.validateProvider({ providerId: 'fixture' });
  assert.deepEqual(calls.pop(), { method: 'validateProvider', args: ['fixture'] });
  await api.fetchProviderModels({ providerId: 'fixture', refresh: true });
  assert.deepEqual(calls.pop(), { method: 'fetchProviderModels', args: ['fixture', true] });
  await api.switchClientProvider({ client: 'codex', providerId: 'fixture', takeOverExternalConfig: true });
  assert.equal(calls.at(-1)?.method, 'switchClientProvider');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.pop()?.args)), ['codex', 'fixture', { takeOverExternalConfig: true }]);
  assert.throws(() => api.validateProvider('fixture'), /无效/);
  assert.throws(() => api.switchClientProvider({ client: 'unsupported', providerId: 'fixture' }), /无效|不支持/);
  assert.throws(() => api.applyTraceIndexRepair(42), /无效/);
  for (const channel of handlers.keys()) assert.doesNotMatch(channel, /excel|config-sync|trace-storage-policy|update-channel/);
  for (const required of ['queryCodexConversations', 'detailCodexConversation', 'inspectTraceIndexRepair',
    'applyTraceIndexRepair', 'repairClientProviderSwitch', 'getClaudeDesktopSync', 'cancelUpdate']) {
    assert.equal(typeof api[required], 'function', required);
  }
  assert.ok(invoked.size >= 4);
}
