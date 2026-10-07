import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vm from 'node:vm';
import ts from 'typescript';
import * as setupWebsites from '../src/shared/setupWebsites';
import { OFFICIAL_PROVIDER_WEBSITES } from '../src/shared/officialProviders';

/** Execute both sides of the IPC contract, including payload validation. */
export async function testManagerIpc(): Promise<void> {
  const handlers = new Map<string, Function>();
  const events = new Map<string, Function>();
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const controller = new Proxy({}, { get: (_target, method) => (...args: unknown[]) => {
    calls.push({ method: String(method), args }); return args;
  } });
  const exports: any = {};
  const host = { platform: 'darwin', arch: 'arm64' };
  const opened: string[] = [];
  const electron = { ipcMain: {
    handle: (channel: string, handler: Function) => handlers.set(channel, handler),
    on: (channel: string, handler: Function) => events.set(channel, handler)
  }, BrowserWindow: {}, shell: { openExternal: async (url: string) => { opened.push(url); } }, dialog: {} };
  vm.runInNewContext(ts.transpile(await fs.readFile('src/main/ipc/registerHandlers.ts', 'utf8'), {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
  }), { exports, process: host, require: (name: string) => name === 'electron' ? electron : name === 'path' ? path : name.endsWith('/setupWebsites') ? setupWebsites : {} });
  exports.registerIpcHandlers({
    controller: () => controller,
    managerWindow: {},
    packagedSmokeTest: true,
    setTraceStoragePolicy: async (input: unknown) => {
      calls.push({ method: 'setTraceStoragePolicy', args: [input] });
      return input;
    }
  });
  let api: any;
  const invoked = new Set<string>();
  vm.runInNewContext(ts.transpile(await fs.readFile('src/main/preload.ts', 'utf8'), {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
  }), { exports: {}, window: { addEventListener() {} }, process: host,
    require: (name: string) => name.endsWith('/setupWebsites') ? setupWebsites : ({ contextBridge: { exposeInMainWorld: (name: string, value: unknown) => {
      assert.equal(name, 'xwxDeck'); api = value;
    } }, clipboard: { writeText() {} }, ipcRenderer: {
      on() {}, removeListener() {}, send: (channel: string) => assert.ok(events.has(channel), channel),
      invoke: (channel: string, ...args: unknown[]) => {
        invoked.add(channel); assert.ok(handlers.has(channel), channel);
        return handlers.get(channel)!({}, ...args);
      }
    } })
  });
  assert.equal(api.setupWebsites.codex, 'https://persistent.oaistatic.com/codex-app-prod/Codex.dmg');
  for (const [platform, arch, mirror] of [['darwin', 'arm64', 'mac-arm64'], ['darwin', 'x64', 'mac-intel'],
    ['win32', 'x64', 'win-x64'], ['win32', 'arm64', 'win-arm64']]) {
    host.platform = platform; host.arch = arch;
    await api.openSetupWebsite('codex-mirror');
    assert.equal(opened.at(-1), `https://codexapp.agentsmirror.com/latest/${mirror}`);
    await api.openSetupWebsite('codex');
    assert.ok(platform === 'darwin' ? opened.at(-1)?.endsWith('.dmg') : opened.at(-1) === 'https://apps.microsoft.com/detail/9PLM9XGG6VKS');
  }
  const openedCount = opened.length;
  for (const value of ['https://example.com', '__proto__', 'constructor', null]) assert.throws(() => api.openSetupWebsite(value), /无效/);
  host.platform = 'linux';
  assert.throws(() => api.openSetupWebsite('codex-mirror'), /暂无/);
  assert.equal(opened.length, openedCount);
  await api.openSetupWebsite('codex');
  assert.equal(opened.at(-1), 'https://learn.chatgpt.com/docs/linux/linux-app');
  for (const [site, url] of [
    ['codex-downloads', 'https://learn.chatgpt.com/docs/app'],
    ['codex-mirror-list', 'https://codexapp.agentsmirror.com/#mirror'],
    ['codex-linux', 'https://learn.chatgpt.com/docs/linux/linux-app']
  ]) {
    await api.openSetupWebsite(site);
    assert.equal(opened.at(-1), url);
    assert.equal(api.setupWebsites[site], url);
  }
  // Explicit platform choices must not be rewritten to the running host's OS.
  for (const [platform, arch] of [['darwin', 'arm64'], ['win32', 'x64'], ['linux', 'arm64']]) {
    host.platform = platform; host.arch = arch;
    for (const [site, url] of Object.entries(setupWebsites.CLIENT_DOWNLOAD_WEBSITES)) {
      await api.openSetupWebsite(site);
      assert.equal(opened.at(-1), url);
      assert.equal(api.setupWebsites[site], url);
    }
  }
  for (const [site, url] of Object.entries({ ...OFFICIAL_PROVIDER_WEBSITES, claude: 'https://claude.com/download' })) {
    await api.openSetupWebsite(site);
    assert.equal(opened.at(-1), url);
    assert.equal(api.setupWebsites[site], url);
  }
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
  assert.throws(() => api.setTraceStoragePolicy({ limitGB: '4' }), /Trace 存储上限/);
  assert.throws(() => api.setTraceStoragePolicy({ autoCleanup: 'yes' }), /自动清理/);
  await api.setTraceStoragePolicy({ limitGB: 0, autoCleanup: true });
  assert.equal(calls.at(-1)?.method, 'setTraceStoragePolicy');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.pop()?.args)), [{ limitGB: 0, autoCleanup: true }]);
  for (const channel of handlers.keys()) assert.doesNotMatch(channel, /excel|config-sync|update-channel/);
  for (const required of ['queryCodexConversations', 'detailCodexConversation', 'inspectTraceIndexRepair',
    'applyTraceIndexRepair', 'repairClientProviderSwitch', 'getClaudeDesktopSync', 'cancelUpdate']) {
    assert.equal(typeof api[required], 'function', required);
  }
  assert.ok(invoked.size >= 4);
}
