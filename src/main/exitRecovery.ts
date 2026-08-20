import * as fs from 'fs';
import * as path from 'path';
import { ClientBackupStore, type ClientBackupRecord } from './trace/clientBackupStore';
import { resolveClientPaths } from './trace/clientConfig';
import { ClientConfigOrchestrator } from './trace/clientConfigOrchestrator';
import { ClientConfigWriter } from './trace/clientConfigWriter';
import { CodexConfigManager } from './trace/codexConfigManager';
import { CodexLocalProxyCoordinator } from './trace/codexLocalProxyCoordinator';
import { writeFileAtomic } from './shared/fsx';
import { initLogger, log } from './shared/logger';

interface GatewayRuntimeRecord {
  readonly pid: number;
  readonly gatewayPort: number;
  readonly controlPort: number;
}

export interface ExitRecoveryOptions {
  readonly userDataDir: string;
  readonly managerPid: number;
  readonly delayMs?: number;
  readonly terminateProcess?: (pid: number) => Promise<void>;
}

export interface ExitRecoveryResult {
  readonly restoredClients: readonly string[];
  readonly emergencyRestoredClients: readonly string[];
  readonly gatewayPid?: number;
  readonly gatewayStopped: boolean;
  readonly managerStopped: boolean;
}

export async function runExitRecovery(options: ExitRecoveryOptions): Promise<ExitRecoveryResult> {
  const terminateProcess = options.terminateProcess ?? terminateProcessByPid;
  const runtimeFile = path.join(options.userDataDir, 'gateway', 'runtime.json');
  const runtime = await readRuntime(runtimeFile);
  const settings = await readSettings(options.userDataDir);
  const clientPaths = resolveClientPaths(process.env, undefined, {
    claudeConfigDir: settings.claudeConfigDir
  });
  const backup = new ClientBackupStore(options.userDataDir);
  const records = await backup.listAll();
  const writer = new ClientConfigWriter({ backup });
  const orchestrator = new ClientConfigOrchestrator(backup, writer, clientPaths, process.env);
  const restoredClients: string[] = [];
  const emergencyRestoredClients: string[] = [];
  await writeReadyMarker(options.userDataDir);
  if (options.delayMs && options.delayMs > 0) {
    await waitForTakeover(options.userDataDir, options.managerPid, options.delayMs);
  }

  let recoveryError: unknown;
  try {
    for (const record of records) {
      try {
        await writer.restore(record);
        restoredClients.push(record.client);
      } catch (error) {
        log.warn(`[exit-recovery] field-safe ${record.client} restore failed: ${(error as Error).message}`);
      }
    }
    await new CodexLocalProxyCoordinator(options.userDataDir).restore().catch(error => {
      log.warn(`[exit-recovery] Codex local-proxy restore failed: ${(error as Error).message}`);
    });

    if (runtime) {
      await restoreManagedCodexGateway(options.userDataDir, runtime.gatewayPort, settings.compatibleBaseUrl);
      let dependent = clientsPointingAt(orchestrator, runtime.gatewayPort);
      for (const client of dependent) {
        const record = records.find(item => item.client === (client === 'claude-cli' ? 'claude' : 'codex'));
        if (!record) continue;
        await forceRestoreOriginal(record, options.userDataDir);
        emergencyRestoredClients.push(record.client);
      }
      await restoreManagedCodexGateway(options.userDataDir, runtime.gatewayPort, settings.compatibleBaseUrl);
      dependent = clientsPointingAt(orchestrator, runtime.gatewayPort);
      if (dependent.length) {
        await replaceOwnedLoopbackReferences(
          clientPaths.claudeSettingsPath,
          clientPaths.codexConfigPath,
          runtime.gatewayPort,
          settings.compatibleBaseUrl
        );
        dependent = clientsPointingAt(orchestrator, runtime.gatewayPort);
      }
      if (dependent.length) {
        throw new Error(`退出恢复后仍有客户端依赖本地 Gateway：${dependent.join(', ')}`);
      }
    }
  } catch (error) {
    recoveryError = error;
    log.error(`[exit-recovery] configuration recovery failed before forced process termination: ${(error as Error).message}`);
  } finally {
    if (runtime && await gatewayStillMatches(runtimeFile, runtime)) {
      await terminateProcess(runtime.pid);
    }
    await cleanupGatewayRuntime(options.userDataDir);
    await terminateProcess(options.managerPid);
  }
  if (recoveryError) throw recoveryError;
  return {
    restoredClients,
    emergencyRestoredClients,
    gatewayPid: runtime?.pid,
    gatewayStopped: runtime ? !processAlive(runtime.pid) : true,
    managerStopped: !processAlive(options.managerPid)
  };
}

async function waitForTakeover(userDataDir: string, managerPid: number, timeoutMs: number): Promise<void> {
  const marker = path.join(userDataDir, 'gateway', 'exit-recovery-now');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processAlive(managerPid)) {
    if (await fs.promises.stat(marker).then(() => true, () => false)) break;
    await delay(100);
  }
  await fs.promises.rm(marker, { force: true }).catch(() => undefined);
}

async function writeReadyMarker(userDataDir: string): Promise<void> {
  const marker = path.join(userDataDir, 'gateway', 'exit-recovery.ready');
  await fs.promises.mkdir(path.dirname(marker), { recursive: true });
  await writeFileAtomic(marker, `${process.pid}\n`);
}

async function restoreManagedCodexGateway(
  userDataDir: string,
  gatewayPort: number,
  compatibleServiceBaseUrl: string
): Promise<void> {
  const manager = new CodexConfigManager(userDataDir);
  let snapshot;
  try {
    snapshot = await manager.read();
  } catch (error) {
    log.warn(`[exit-recovery] could not parse Codex config before fallback restore: ${(error as Error).message}`);
    return;
  }
  if (!endpointUsesPort(snapshot.activeBaseUrl, gatewayPort)) return;
  const upstreamBaseUrl = snapshot.mode === 'compatible' && snapshot.compatible.baseUrl
    ? snapshot.compatible.baseUrl
    : snapshot.authMode === 'api-key'
      ? 'https://api.openai.com/v1'
      : 'https://chatgpt.com/backend-api/codex';
  await manager.restoreCompatibleServiceGateway({
    upstreamBaseUrl: upstreamBaseUrl || compatibleServiceBaseUrl,
    gatewayBaseUrl: snapshot.activeBaseUrl
  }).catch(error => {
    log.warn(`[exit-recovery] managed Codex Gateway restore failed: ${(error as Error).message}`);
  });
}

async function forceRestoreOriginal(record: ClientBackupRecord, userDataDir: string): Promise<void> {
  const current = await fs.promises.readFile(record.configPath, 'utf8').catch(() => undefined);
  if (current !== undefined) {
    const backupDir = path.join(userDataDir, 'backups', 'forced-exit');
    await fs.promises.mkdir(backupDir, { recursive: true });
    const name = `${record.client}-${Date.now()}-${path.basename(record.configPath)}.before-recovery`;
    await writeFileAtomic(path.join(backupDir, name), current);
  }
  if (record.originalContent === undefined) {
    await fs.promises.rm(record.configPath, { force: true });
  } else {
    await writeFileAtomic(record.configPath, record.originalContent);
  }
}

async function replaceOwnedLoopbackReferences(
  claudePath: string,
  codexPath: string,
  gatewayPort: number,
  compatibleServiceBaseUrl: string
): Promise<void> {
  const pattern = new RegExp(`http://(?:127\\.0\\.0\\.1|localhost):${gatewayPort}(?:/[^\"'\\s]*)?`, 'gi');
  const claude = await fs.promises.readFile(claudePath, 'utf8').catch(() => undefined);
  if (claude && pattern.test(claude)) {
    pattern.lastIndex = 0;
    await writeFileAtomic(claudePath, claude.replace(pattern, 'https://api.anthropic.com'));
  }
  const codex = await fs.promises.readFile(codexPath, 'utf8').catch(() => undefined);
  if (codex) {
    pattern.lastIndex = 0;
    if (pattern.test(codex)) {
      pattern.lastIndex = 0;
      const upstream = compatibleServiceBaseUrl || 'https://chatgpt.com/backend-api/codex';
      await writeFileAtomic(codexPath, codex.replace(pattern, upstream));
    }
  }
}

function clientsPointingAt(orchestrator: ClientConfigOrchestrator, gatewayPort: number): readonly string[] {
  return orchestrator.clientsPointingAt(`http://127.0.0.1:${gatewayPort}`);
}

async function readRuntime(file: string): Promise<GatewayRuntimeRecord | undefined> {
  try {
    const value = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Partial<GatewayRuntimeRecord>;
    if (!Number.isInteger(value.pid)
      || !Number.isInteger(value.gatewayPort)
      || !Number.isInteger(value.controlPort)) return undefined;
    return value as GatewayRuntimeRecord;
  } catch {
    return undefined;
  }
}

/**
 * Decide whether `runtime.pid` may be terminated.
 *
 * Re-reading the runtime file only proves nobody cleaned it up; it says nothing
 * about whether that PID is still our helper. A stale runtime.json left behind
 * by a hard kill plus an OS-recycled PID would otherwise make us SIGKILL an
 * unrelated process. Two independent signals are accepted:
 *
 *  - one of the recorded ports is open, which only a live Gateway can do; or
 *  - the process started before the runtime file was written, which a process
 *    that later inherited the PID cannot have done.
 *
 * When neither can be established the PID is left alone.
 */
async function gatewayStillMatches(file: string, runtime: GatewayRuntimeRecord): Promise<boolean> {
  const current = await readRuntime(file);
  if (!current
    || current.pid !== runtime.pid
    || current.gatewayPort !== runtime.gatewayPort
    || current.controlPort !== runtime.controlPort) return false;
  // A PID nobody is using cannot be misidentified and terminating it is a
  // no-op, so the identity gate below only needs to protect live processes.
  if (!processAlive(runtime.pid)) return true;
  const [gatewayOpen, controlOpen] = await Promise.all([
    probeTcpPort(runtime.gatewayPort),
    probeTcpPort(runtime.controlPort)
  ]);
  if (gatewayOpen || controlOpen) return true;
  const startedBefore = await processStartedBefore(runtime.pid, file);
  if (startedBefore === undefined) {
    log.warn(
      `[exit-recovery] cannot confirm pid ${runtime.pid} is the recorded Gateway `
      + '(ports closed, process start time unavailable); leaving it running'
    );
    return false;
  }
  if (!startedBefore) {
    log.warn(
      `[exit-recovery] pid ${runtime.pid} started after runtime.json was written; `
      + 'treating it as an unrelated process that inherited a recycled PID'
    );
  }
  return startedBefore;
}

/**
 * True when the process started before `file` was last written, false when it
 * started after, undefined when the platform cannot answer.
 */
async function processStartedBefore(pid: number, file: string): Promise<boolean | undefined> {
  const writtenAt = await fs.promises.stat(file).then(s => s.mtimeMs, () => undefined);
  if (writtenAt === undefined) return undefined;
  const startedAt = await processStartTimeMs(pid);
  if (startedAt === undefined) return undefined;
  // Clock granularity between the process table and the filesystem differs, so
  // allow a small window rather than demanding a strict ordering.
  return startedAt <= writtenAt + 2_000;
}

async function processStartTimeMs(pid: number): Promise<number | undefined> {
  const { execFile } = await import('child_process');
  const run = (command: string, args: readonly string[]): Promise<string | undefined> => (
    new Promise(resolve => {
      execFile(command, [...args], { timeout: 4_000, windowsHide: true }, (error, stdout) => {
        resolve(error ? undefined : stdout);
      });
    })
  );
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
    ]);
    const parsed = Date.parse((out ?? '').trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const out = await run('ps', ['-o', 'lstart=', '-p', String(pid)]);
    const parsed = Date.parse((out ?? '').trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

async function probeTcpPort(port: number): Promise<boolean> {
  const net = await import('net');
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(150);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function readSettings(userDataDir: string): Promise<{
  readonly claudeConfigDir: string;
  readonly compatibleBaseUrl: string;
}> {
  try {
    const value = JSON.parse(
      await fs.promises.readFile(path.join(userDataDir, 'settings.json'), 'utf8')
    ) as {
      claudeConfigDir?: unknown;
      compatible?: { baseUrl?: unknown };
    };
    return {
      claudeConfigDir: typeof value.claudeConfigDir === 'string' ? value.claudeConfigDir : '',
      compatibleBaseUrl: typeof value.compatible?.baseUrl === 'string' ? value.compatible.baseUrl : ''
    };
  } catch {
    return { claudeConfigDir: '', compatibleBaseUrl: '' };
  }
}

async function cleanupGatewayRuntime(userDataDir: string): Promise<void> {
  const root = path.join(userDataDir, 'gateway');
  await Promise.all([
    fs.promises.rm(path.join(root, 'runtime.json'), { force: true }).catch(() => undefined),
    fs.promises.rm(path.join(root, 'control.token'), { force: true }).catch(() => undefined),
    fs.promises.rm(path.join(root, 'bootstrap.json'), { force: true }).catch(() => undefined),
    fs.promises.rm(path.join(root, 'exit-recovery.ready'), { force: true }).catch(() => undefined),
    fs.promises.rm(path.join(root, 'exit-recovery-now'), { force: true }).catch(() => undefined)
  ]);
}

async function terminateProcessByPid(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !processAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  await waitForExit(pid, 750);
  if (!processAlive(pid)) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  await waitForExit(pid, 1_000);
}

function endpointUsesPort(value: string | undefined, gatewayPort: number): boolean {
  try {
    const url = new URL(value ?? '');
    return (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
      && Number(url.port) === gatewayPort;
  } catch {
    return false;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processAlive(pid)) await delay(50);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const userDataDir = process.env.XWX_EXIT_RECOVERY_USER_DATA;
  const managerPid = Number(process.env.XWX_EXIT_RECOVERY_MANAGER_PID);
  const delayMs = Number(process.env.XWX_EXIT_RECOVERY_DELAY_MS || '6000');
  if (!userDataDir || !Number.isInteger(managerPid) || managerPid <= 0) {
    process.exit(2);
    return;
  }
  initLogger(userDataDir);
  try {
    await runExitRecovery({ userDataDir, managerPid, delayMs });
    process.exit(0);
  } catch (error) {
    log.error(`[exit-recovery] fatal recovery failure: ${(error as Error).stack ?? (error as Error).message}`);
    process.exit(1);
  }
}

if (process.env.XWX_EXIT_RECOVERY === '1') {
  void main();
}
