import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as vm from 'node:vm';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { applicationRelaunchEnvironment } from '../src/main/app/applicationReset';

export async function testPortableRestartFailures(root: string): Promise<void> {
  const source = await fs.promises.readFile('src/main/update/portableUpdate.ts', 'utf8');
  const bootstrap = await fs.promises.readFile('src/main/main.ts', 'utf8');
  assert.doesNotMatch(bootstrap, /acknowledgePortableUpdateStarted/,
    'bootstrap must load runtime before asynchronous update-marker IO');
  const transpile = (code: string) => ts.transpile(code, {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
  });
  await testWorkerHandoff(root, transpile(source));
  for (const scenario of ['success', 'success-hidden', 'spawn-failed', 'early-exit', 'timeout', 'install-failed']) {
    const succeeds = scenario === 'success' || scenario === 'success-hidden';
    const directory = path.join(root, 'portable-restart', scenario, '中文 原安装路径');
    await fs.promises.mkdir(directory, { recursive: true });
    const targetPath = path.join(directory, '我的 Deck.exe');
    const sourcePath = path.join(directory, 'download.exe');
    const oldBytes = Buffer.from('MZ-old-version');
    const newBytes = Buffer.from(scenario === 'install-failed' ? 'invalid-download' : 'MZ-new-version');
    await fs.promises.writeFile(targetPath, oldBytes);
    await fs.promises.writeFile(sourcePath, newBytes);
    const launches: Array<{ executable: string; args: string[] }> = [];
    const signals: unknown[] = [];
    const exports: any = {};
    let now = Date.now();
    const context = vm.createContext({ exports, Buffer, Error,
      Date: class extends Date { static now() { return now; } },
      setTimeout: (callback: () => void, ms: number) => {
        now += ms;
        return setTimeout(callback, 0);
      },
      process: { pid: process.pid, env: {}, kill: (_pid: number, signal: unknown) => {
        if (signal !== 0) signals.push(signal);
        if (scenario === 'early-exit') throw Object.assign(new Error('exited'), { code: 'ESRCH' });
      } },
      require: (name: string) => {
        if (name === 'fs') return fs;
        if (name === 'path') return path;
        if (name === 'os') return os;
        if (name === 'crypto') return crypto;
        if (name === '../app/applicationReset') return { applicationRelaunchEnvironment };
        if (name === '../app/startupRegistration') return { STARTUP_HIDDEN_ARG: '--hidden' };
        assert.equal(name, 'child_process');
        return { spawn: (executable: string, args: string[], options: { cwd: string }) => {
          assert.equal(options.cwd, path.dirname(executable),
            'restart must not inherit a deleted portable extraction directory');
          launches.push({ executable, args });
          const child = Object.assign(new EventEmitter(), { pid: 77881, unref() {} });
          queueMicrotask(() => {
            if (scenario === 'spawn-failed') {
              child.emit('error', new Error('fixture OS rejected startup'));
              return;
            }
            if (succeeds) {
              const payload = JSON.parse(Buffer.from(args[0].split('=')[1], 'base64url').toString());
              fs.writeFileSync(payload.readyPath, JSON.stringify({ attemptId: payload.attemptId }));
            }
            child.emit('spawn');
          });
          return child;
        } };
      }
    });
    vm.runInContext(transpile(source), context);
    const request = { sourcePath, targetPath, version: '1.1.6', waitPids: [],
      ...(scenario === 'success-hidden' ? { launchHidden: true } : {}) };
    let failure: Error | undefined;
    try { await exports.runPortableUpdateMode(request); } catch (error) { failure = error as Error; }
    assert.equal(launches.length, 1, scenario + ': never launch an old version after a successful install');
    assert.equal(launches[0].executable, targetPath, 'relaunch always uses the original filename and directory');
    assert.deepEqual(signals, [], 'missing readiness must not terminate an application that may still be loading');
    assert.deepEqual(await fs.promises.readFile(targetPath), scenario === 'install-failed' ? oldBytes : newBytes);
    if (scenario !== 'install-failed') assert.deepEqual(await fs.promises.readFile(targetPath + '.previous'), oldBytes);
    assert.equal(launches[0].args.includes('--hidden'), scenario === 'success-hidden',
      'only an unattended install relaunches to the tray');
    if (succeeds) {
      assert.equal(failure, undefined);
    } else if (scenario === 'install-failed') {
      assert.match(failure!.message, /不是有效的 Windows EXE/);
      assert.match(launches[0].args[0], /^--xwxdeck-portable-update-failed=/);
      assert.equal(failure instanceof exports.PortableUpdateRestartError, false);
    } else {
      assert.ok(failure instanceof exports.PortableUpdateRestartError);
      assert.match(failure!.message, /已安装在原路径，未退回旧版本/);
      assert.ok(failure!.message.includes(targetPath));
      assert.match(failure!.message, /手动打开/);
      assert.ok(failure!.message.includes(targetPath + '.previous'), 'the notice names the manual fallback copy');
      if (scenario === 'early-exit') assert.match(failure!.message, /完成启动前退出/);
      if (scenario === 'timeout') assert.match(failure!.message, /启动确认超时/);

      const notices: Array<{ title: string; message: string }> = [];
      const exitCode = await new Promise<number>(resolve => {
        const mainContext = vm.createContext({ exports: {}, console: { error() {} },
          require: (name: string) => name === 'electron' ? {
            app: { exit: resolve }, dialog: { showErrorBox: (title: string, message: string) => notices.push({ title, message }) }
          } : { ...exports, readPortableUpdateRequest: () => request,
            runPortableUpdateMode: async () => { throw failure; } }
        });
        vm.runInContext(transpile(bootstrap), mainContext);
      });
      assert.equal(exitCode, 1);
      assert.equal(notices.length, 1, 'the helper must show a visible, actionable failure instead of exiting silently');
      assert.match(notices[0].title, /新版已安装，请手动打开/);
      assert.equal(notices[0].message, failure!.message);
    }
    if (scenario !== 'install-failed') {
      const payload = JSON.parse(Buffer.from(launches[0].args[0].split('=')[1], 'base64url').toString());
      await assert.rejects(fs.promises.access(payload.readyPath));
      await assert.rejects(fs.promises.access(payload.startedPath));
    }
  }
}

async function testWorkerHandoff(root: string, code: string): Promise<void> {
  const directory = path.join(root, 'portable-worker-handoff');
  await fs.promises.mkdir(directory, { recursive: true });
  const sourcePath = path.join(directory, 'download.exe');
  const targetPath = path.join(directory, '我的 Deck.exe');
  await fs.promises.writeFile(sourcePath, 'MZ-test');
  for (const scenario of ['ready', 'startup-error', 'early-exit', 'invalid-message']) {
    let settled = false;
    let killed = false;
    let unrefed = false;
    const exports: any = {};
    const child = Object.assign(new EventEmitter(), {
      pid: 77882,
      unref() { unrefed = true; },
      kill() { killed = true; }
    });
    const context = vm.createContext({
      exports, Buffer, Error, setTimeout, clearTimeout, __dirname: directory,
      process: { execPath: path.join(directory, 'runtime.exe'), env: {} },
      require: (name: string) => {
        if (name === 'fs') return fs;
        if (name === 'path') return path;
        if (name === 'os') return os;
        if (name === 'crypto') return crypto;
        if (name === '../app/applicationReset') return { applicationRelaunchEnvironment };
        if (name === '../app/startupRegistration') return { STARTUP_HIDDEN_ARG: '--hidden' };
        assert.equal(name, 'child_process');
        return { spawn: (executable: string, args: string[], options: any) => {
          assert.equal(executable, path.join(directory, 'runtime.exe'));
          assert.equal(args[0], path.join(directory, 'portable-update-worker.js'));
          assert.match(args[1], /^--xwxdeck-apply-portable-update=/);
          assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
          assert.equal(options.cwd, directory);
          assert.equal(options.stdio[3], 'ipc');
          assert.equal(options.windowsHide, true);
          setImmediate(() => {
            child.emit('spawn');
            assert.equal(settled, false, 'OS spawn is not acknowledgement that the worker bundle has loaded');
            if (scenario === 'ready') child.emit('message', { type: 'ready' });
            if (scenario === 'startup-error') child.emit('error', new Error('worker not readable'));
            if (scenario === 'early-exit') child.emit('exit', 1);
            if (scenario === 'invalid-message') child.emit('message', { type: 'wrong' });
          });
          return child;
        } };
      }
    });
    vm.runInContext(code, context);
    let error: unknown;
    try {
      await exports.launchPortableUpdate({ sourcePath, targetPath, version: '1.1.7', waitPids: [process.pid] });
    } catch (caught) { error = caught; }
    settled = true;
    assert.equal(error === undefined, scenario === 'ready');
    assert.equal(killed, scenario !== 'ready', 'only failed, not-yet-ready workers are cancelled');
    assert.equal(unrefed, scenario === 'ready');
  }
}
