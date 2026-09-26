import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vm from 'node:vm';
import ts from 'typescript';
import * as startupRegistration from '../src/main/app/startupRegistration';
import { applicationResetRelaunchArgs, applicationRelaunchExecutable, applicationRelaunchEnvironment,
  performApplicationRepair } from '../src/main/app/applicationReset';
import { XwXDeckController } from '../src/main/app/xwxDeckController';
import { XwXDeckSettingsStore } from '../src/main/app/settings';
import { __test as lifecycleTest } from '../src/main/app/chatGptLifecycle';

async function sourceFunction(file: string, name: string, context: vm.Context): Promise<any> {
  const source = await fs.readFile(file, 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const node = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert(node, `${name} must exist`);
  const code = node.getText(tree).replace(/^export\s+/, '');
  return vm.runInContext(ts.transpile(`${code}\n${name}`, { target: ts.ScriptTarget.ES2022 }), context);
}

export async function testSettingsActions(root: string): Promise<void> {
  // Exercise the real Electron adapter with the command-line interpretation
  // used by Electron's Windows implementation, without touching login items.
  let registered = false;
  const executable = 'E:\\Apps With Spaces\\XwX Deck.exe';
  const startupExports: any = {};
  const context = vm.createContext({ exports: startupExports, setTimeout, clearTimeout,
    process: { platform: 'win32', execPath: executable, env: {}, argv: [] },
    require: (name: string) => name === 'electron' ? { app: {
      isPackaged: true,
      setLoginItemSettings: (options: any) => { registered = options.openAtLogin; },
      getLoginItemSettings: (options: any) => ({ openAtLogin: registered,
        executableWillLaunchAtLogin: registered && options.path === `"${executable}"` })
    } } : startupRegistration
  });
  vm.runInContext(ts.transpile(await fs.readFile('src/main/app/startup.ts', 'utf8'), {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
  }), context);
  assert.equal((await startupExports.setStartupEnabled(true)).executableWillLaunchAtLogin, true);
  assert.equal((await startupExports.setStartupEnabled(false)).enabled, false);
  assert.equal(startupRegistration.startupRegistrationMatches({ enabled: false, supported: true,
    executableWillLaunchAtLogin: true }, false), true, 'another login entry cannot invalidate removal of Deck\'s entry');

  let desired = false;
  const intentWrites: boolean[] = [];
  const runtimeContext: any = vm.createContext({ Date,
    controller: { setStartupIntent: async (enabled: boolean) => { desired = enabled; intentWrites.push(enabled); },
      readStartupIntent: async () => desired },
    readStartupSettings: () => ({ enabled: false, supported: true }),
    setLoginStartupEnabled: async () => { throw new Error('fixture OS registration unavailable'); },
    startupRegistrationMatches: startupRegistration.startupRegistrationMatches,
    startupSettingsCache: undefined,
    currentState: async () => ({ desired }), log: { warn: () => {} }, errorMessage: (e: Error) => e.message
  });
  const save = await sourceFunction('src/main/runtime.ts', 'setStartupEnabled', runtimeContext);
  await save(true);
  const reconcile = await sourceFunction('src/main/runtime.ts', 'reconcileStartupWithIntent', runtimeContext);
  await reconcile();
  assert.equal(desired, true, 'OS readback failure must never overwrite saved startup intent');
  assert.deepEqual(intentWrites, [true]);
  assert.match(runtimeContext.startupSettingsCache.value.warning, /fixture OS/);

  const failedStartup = vm.createContext({ controller: {
    readStartupIntent: async () => { throw new Error('fixture settings unavailable'); },
    runtimeState: async () => ({ lastError: '启动恢复未完成：fixture settings unavailable' })
  }, cachedStartupSettings: () => ({ enabled: true, supported: true }),
  startupRegistrationMatches: startupRegistration.startupRegistrationMatches,
  startupRecoveryNotice: undefined, updateState: () => ({ status: 'idle' }) });
  const readState = await sourceFunction('src/main/runtime.ts', 'currentState', failedStartup);
  const readableState = await readState();
  assert.equal(readableState.startup.desiredEnabled, undefined, 'an unreadable preference is unknown, not disabled');
  assert.equal(readableState.startup.enabled, true);
  assert.match(readableState.startup.warning, /原设置已保留/);
  assert.match(readableState.lastError, /启动恢复未完成/);
  const uncertainReconcile = await sourceFunction('src/main/runtime.ts', 'reconcileStartupWithIntent', failedStartup);
  await assert.rejects(uncertainReconcile(), /fixture settings unavailable/,
    'automatic login registration must stop before reading or changing the OS when saved intent is unknown');

  assert.equal(applicationRelaunchExecutable({ PORTABLE_EXECUTABLE_FILE: executable }, 'temporary.exe'), executable);
  assert.deepEqual(applicationResetRelaunchArgs(['temporary.exe', '--hidden', '--xwxdeck-reset=clients',
    '--xwxdeck-portable-update-complete=old-marker', '--user-data-dir=fixture']), ['--user-data-dir=fixture']);
  assert.deepEqual(applicationRelaunchEnvironment({ ELECTRON_RUN_AS_NODE: '1', PORTABLE_EXECUTABLE_FILE: 'old',
    PORTABLE_EXECUTABLE_DIR: 'old-dir', XWX_APPLICATION_RESET_JOB: '{}', NODE_OPTIONS: '--require missing.cjs',
    NODE_PATH: 'another tool', node_options: '--inspect', KEEP: 'yes' }), { KEEP: 'yes' });
  const repairRoot = path.join(root, 'repair-preserves-update');
  await fs.mkdir(path.join(repairRoot, 'updates'), { recursive: true });
  await fs.writeFile(path.join(repairRoot, 'settings.json'), '{}');
  await fs.writeFile(path.join(repairRoot, 'updates', 'pending.exe'), 'verified installer');
  await fs.writeFile(path.join(repairRoot, 'model-capabilities-cache.json'), '{}');
  performApplicationRepair(repairRoot, { allowedParentDir: root, preserveUpdates: true });
  assert.equal(await fs.readFile(path.join(repairRoot, 'updates', 'pending.exe'), 'utf8'), 'verified installer');
  await assert.rejects(fs.stat(path.join(repairRoot, 'model-capabilities-cache.json')), /ENOENT/);

  let commandLine = 'C:\\Other\\unrelated.exe';
  const killed: number[] = [];
  const processContext = vm.createContext({ process: { pid: 1, platform: 'win32',
    kill: (pid: number) => killed.push(pid) }, execFileText: async () => commandLine });
  const stop = await sourceFunction('src/main/app/chatGptLifecycle.ts', 'stopStalledExitRecovery', processContext);
  assert.equal(await stop(42), false);
  assert.deepEqual(killed, [], 'a reused recovery PID must not close an unrelated application');
  commandLine = '"E:\\Deck\\XwX Deck.exe" "E:\\Deck\\resources\\app.asar\\dist\\exit-recovery.js"';
  assert.equal(await stop(42), true);
  assert.deepEqual(killed, [42]);
  const fallback = lifecycleTest.windowsTasklistResetProcesses('"ChatGPT.exe","42","Console"\n"codex.exe","43","Console"\n"Code.exe","44","Console"');
  assert.deepEqual(fallback.map(p => p.pid), [42, 43]);
  assert.equal(lifecycleTest.matchingResetClientProcesses(fallback,
    [{ pid: 42, label: 'ChatGPT', executable: 'E:\\Apps\\ChatGPT.exe' }]).length, 1,
    'switching process-enumeration methods must not strand a confirmed client');

  const base = path.join(root, 'storage-policy');
  const codex = path.join(base, 'codex');
  const claude = path.join(base, 'claude');
  const userData = path.join(base, 'deck');
  const previous = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    XWX_DECK_CLIENT_HOME: process.env.XWX_DECK_CLIENT_HOME };
  let controller: XwXDeckController | undefined;
  let internal: any;
  try {
    Object.assign(process.env, { CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude, XWX_DECK_CLIENT_HOME: base });
    await fs.mkdir(codex, { recursive: true }); await fs.mkdir(claude, { recursive: true });
    await fs.writeFile(path.join(codex, 'config.toml'), 'model_provider = "openai"\nmodel = "gpt-5.5"\n');
    await fs.writeFile(path.join(claude, 'settings.json'), '{}');
    controller = new XwXDeckController(userData, { proxyListenPorts: [0], disableBackgroundModelRefresh: true,
      chatGptRunning: async () => false, codexHistoryMutationAllowed: async () => true });
    await controller.start(); internal = controller as any;
    internal.proxy.background = true;
    internal.proxy.isListening = () => true;
    internal.proxy.enforceTraceRetention = async () => { throw new Error('fixture helper offline'); };
    const state = await controller.setTraceStoragePolicy({ autoCleanup: true, limitGB: 0 });
    assert.equal(state.traceAutoCleanup, false);
    assert.equal(state.traceWarningGB, 2);
    const saved = await new XwXDeckSettingsStore(userData).read();
    assert.equal(saved.traceAutoCleanup, false);
    assert.equal(saved.maxStorageMB, 0);
    assert.equal(saved.maxSessions, 0);

  } finally {
    if (internal?.traceStorageSyncTimer) clearTimeout(internal.traceStorageSyncTimer);
    if (internal) internal.proxy.background = false;
    await controller?.shutdown();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  console.log('PASS settings actions preserve intent, quote startup paths, isolate forced process cleanup, and relaunch the portable executable');
}
