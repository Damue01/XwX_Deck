import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';

const APPLY_ARG = '--xwxdeck-apply-portable-update=';
const COMPLETE_ARG = '--xwxdeck-portable-update-complete=';
const FAILED_ARG = '--xwxdeck-portable-update-failed=';
const PROCESS_WAIT_TIMEOUT_MS = 120_000;
const FILE_RETRY_TIMEOUT_MS = 30_000;
const READY_WAIT_TIMEOUT_MS = 120_000;
const READY_FILE_PREFIX = 'xwx-portable-update-ready-';

export interface PortableUpdateRequest {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly version: string;
  readonly waitPids: readonly number[];
}

export type PortableUpdateLaunchResult =
  | {
      readonly kind: 'complete';
      readonly version: string;
      readonly cleanupPaths: readonly string[];
      readonly readyPath?: string;
      readonly attemptId?: string;
    }
  | { readonly kind: 'failed'; readonly message: string };

export interface PortableReplaceResult {
  readonly backupPath: string;
  readonly pendingPath: string;
}

export interface PortableReplaceHooks {
  readonly beforeInstall?: () => Promise<void>;
  readonly afterInstall?: () => Promise<void>;
}

export function readPortableUpdateRequest(argv: readonly string[] = process.argv): PortableUpdateRequest | undefined {
  const raw = argumentValue(argv, APPLY_ARG);
  if (!raw) return undefined;
  const value = decodeArgument(raw) as Partial<PortableUpdateRequest>;
  if (!value || typeof value !== 'object') throw new Error('更新请求无效。');
  if (typeof value.sourcePath !== 'string' || typeof value.targetPath !== 'string' || typeof value.version !== 'string') {
    throw new Error('更新请求不完整。');
  }
  const sourcePath = path.resolve(value.sourcePath);
  const targetPath = path.resolve(value.targetPath);
  validateExecutablePath(sourcePath, '安装包');
  validateExecutablePath(targetPath, '当前程序');
  if (samePath(sourcePath, targetPath)) throw new Error('更新文件不能与当前程序使用同一个文件。');
  const version = value.version.trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error('更新版本号无效。');
  return {
    sourcePath,
    targetPath,
    version,
    waitPids: Array.isArray(value.waitPids)
      ? value.waitPids.filter(pid => Number.isSafeInteger(pid) && pid > 0)
      : []
  };
}

export function readPortableUpdateLaunchResult(argv: readonly string[] = process.argv): PortableUpdateLaunchResult | undefined {
  const complete = argumentValue(argv, COMPLETE_ARG);
  if (complete) {
    const value = decodeArgument(complete) as Partial<Extract<PortableUpdateLaunchResult, { kind: 'complete' }>>;
    return {
      kind: 'complete',
      version: typeof value.version === 'string' ? value.version : '',
      cleanupPaths: Array.isArray(value.cleanupPaths)
        ? value.cleanupPaths.filter((item): item is string => typeof item === 'string').map(item => path.resolve(item))
        : [],
      readyPath: portableReadyPath(value.readyPath),
      attemptId: typeof value.attemptId === 'string' && /^[0-9a-f-]{36}$/i.test(value.attemptId)
        ? value.attemptId
        : undefined
    };
  }
  const failed = argumentValue(argv, FAILED_ARG);
  if (!failed) return undefined;
  const value = decodeArgument(failed) as { message?: unknown };
  return {
    kind: 'failed',
    message: typeof value?.message === 'string' && value.message.trim()
      ? value.message.trim()
      : '更新未能完成，已保留原版本。'
  };
}

export async function launchPortableUpdate(request: PortableUpdateRequest): Promise<void> {
  validateExecutablePath(request.sourcePath, '更新文件');
  validateExecutablePath(request.targetPath, '当前程序');
  await assertWindowsExecutable(request.sourcePath);
  const encoded = encodeArgument(request);
  // Reuse the already-extracted Electron executable as the hidden helper.
  // Starting the downloaded portable wrapper here would unpack a second app
  // while the first wrapper is still shutting down, which is unreliable on
  // managed Windows machines with process-injection/security software.
  const helperUserData = await fs.promises.mkdtemp(path.join(tmpdir(), 'xwx_deck-update-helper-'));
  await spawnDetached(
    process.execPath,
    [`--user-data-dir=${helperUserData}`, `${APPLY_ARG}${encoded}`],
    { isolatedEnvironment: true }
  );
}

export async function runPortableUpdateMode(request: PortableUpdateRequest): Promise<void> {
  try {
    await waitForProcessesExit(request.waitPids, PROCESS_WAIT_TIMEOUT_MS);
    const result = await replacePortableExecutable(request.sourcePath, request.targetPath);
    const attemptId = randomUUID();
    const readyPath = path.join(tmpdir(), `${READY_FILE_PREFIX}${attemptId}.json`);
    await removeWithRetry(readyPath, 2_000);
    try {
      await spawnDetached(request.targetPath, [
        `${COMPLETE_ARG}${encodeArgument({
          version: request.version,
          cleanupPaths: [request.sourcePath, result.backupPath, result.pendingPath],
          readyPath,
          attemptId
        })}`
      ], { windowsHide: false });
      await waitForPortableUpdateReady(readyPath, attemptId, READY_WAIT_TIMEOUT_MS);
    } catch (error) {
      await restorePortableExecutable(result.backupPath, request.targetPath);
      throw error;
    } finally {
      await removeWithRetry(readyPath, 2_000).catch(() => undefined);
    }
  } catch (error) {
    await relaunchAfterFailure(request, error).catch(() => undefined);
    throw error;
  }
}

export async function replacePortableExecutable(
  sourcePath: string,
  targetPath: string,
  hooks: PortableReplaceHooks = {}
): Promise<PortableReplaceResult> {
  const source = path.resolve(sourcePath);
  const target = path.resolve(targetPath);
  validateExecutablePath(source, '更新文件');
  validateExecutablePath(target, '当前程序');
  if (samePath(source, target)) throw new Error('更新文件不能与当前程序使用同一个文件。');
  await assertWindowsExecutable(source);
  await fs.promises.access(target, fs.constants.R_OK | fs.constants.W_OK);

  const backupPath = `${target}.previous`;
  const pendingPath = `${target}.updating`;
  await removeWithRetry(pendingPath, 2_000);
  await removeWithRetry(backupPath, 2_000);
  await fs.promises.copyFile(source, pendingPath);
  await assertWindowsExecutable(pendingPath);
  await fs.promises.copyFile(target, backupPath);
  await assertWindowsExecutable(backupPath);

  let targetReplaced = false;
  try {
    await hooks.beforeInstall?.();
    await renameWithRetry(pendingPath, target, FILE_RETRY_TIMEOUT_MS);
    targetReplaced = true;
    await assertWindowsExecutable(target);
    await hooks.afterInstall?.();
    return { backupPath, pendingPath };
  } catch (error) {
    await removeWithRetry(pendingPath, 2_000).catch(() => undefined);
    if (targetReplaced) await restorePortableExecutable(backupPath, target).catch(() => undefined);
    throw error;
  }
}

export async function acknowledgePortableUpdateReady(result: PortableUpdateLaunchResult | undefined): Promise<void> {
  if (result?.kind !== 'complete' || !result.readyPath || !result.attemptId) return;
  const readyPath = portableReadyPath(result.readyPath);
  if (!readyPath) throw new Error('更新启动确认路径无效。');
  await fs.promises.writeFile(readyPath, `${JSON.stringify({
    attemptId: result.attemptId,
    version: result.version,
    readyAt: new Date().toISOString()
  })}\n`, { encoding: 'utf8', flag: 'wx' });
}

export async function restorePortableExecutable(backupPath: string, targetPath: string): Promise<void> {
  const backup = path.resolve(backupPath);
  const target = path.resolve(targetPath);
  validatePortableBackupPath(backup);
  validateExecutablePath(target, '当前程序');
  await assertWindowsExecutable(backup);
  const rollbackPath = `${target}.rollback`;
  await removeWithRetry(rollbackPath, 2_000);
  try {
    await fs.promises.copyFile(backup, rollbackPath);
    await assertWindowsExecutable(rollbackPath);
    await renameWithRetry(rollbackPath, target, FILE_RETRY_TIMEOUT_MS);
    await assertWindowsExecutable(target);
  } finally {
    await removeWithRetry(rollbackPath, 2_000).catch(() => undefined);
  }
}

export async function cleanupPortableUpdateFiles(paths: readonly string[]): Promise<void> {
  for (const item of paths) {
    const resolved = path.resolve(item);
    if (!resolved.toLowerCase().endsWith('.exe')
      && !resolved.toLowerCase().endsWith('.exe.previous')
      && !resolved.toLowerCase().endsWith('.exe.updating')
      && !resolved.toLowerCase().endsWith('.exe.rollback')) continue;
    await removeWithRetry(resolved, 30_000).catch(() => undefined);
  }
}

export function safePortableCleanupPaths(paths: readonly string[], currentExecutable: string | undefined): string[] {
  if (!currentExecutable) return [];
  const target = path.resolve(currentExecutable);
  const allowed = new Set([
    path.resolve(`${target}.previous`).toLowerCase(),
    path.resolve(`${target}.updating`).toLowerCase(),
    path.resolve(`${target}.rollback`).toLowerCase()
  ]);
  return paths
    .map(item => path.resolve(item))
    .filter(item => {
      if (allowed.has(item.toLowerCase())) return true;
      return path.basename(path.dirname(item)).toLowerCase() === 'pending'
        && (/^XwX Deck-[0-9].*\.exe$/i.test(path.basename(item))
          || /^XwX Deck\.exe$/i.test(path.basename(item))
          || /^XwX Deck(?:-[0-9].*)?\.exe$/i.test(path.basename(item)));
    });
}

async function relaunchAfterFailure(request: PortableUpdateRequest, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await assertWindowsExecutable(request.targetPath);
  } catch {
    const backupPath = `${request.targetPath}.previous`;
    await restorePortableExecutable(backupPath, request.targetPath);
  }
  await spawnDetached(request.targetPath, [`${FAILED_ARG}${encodeArgument({ message })}`]);
}

async function waitForPortableUpdateReady(readyPath: string, attemptId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await fs.promises.readFile(readyPath, 'utf8')) as { attemptId?: unknown };
      if (value.attemptId === attemptId) return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && code !== 'ENOENT') throw error;
    }
    await delay(250);
  }
  throw new Error('新版 XwX Deck 启动超时，已恢复旧版本。');
}

async function waitForProcessesExit(pids: readonly number[], timeoutMs: number): Promise<void> {
  const unique = [...new Set(pids.filter(pid => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid))];
  const deadline = Date.now() + timeoutMs;
  while (unique.some(isProcessRunning)) {
    if (Date.now() >= deadline) throw new Error('等待旧版 XwX Deck 退出超时。');
    await delay(250);
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function assertWindowsExecutable(file: string): Promise<void> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const header = Buffer.alloc(2);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== 2 || header[0] !== 0x4d || header[1] !== 0x5a) {
      throw new Error(`更新文件不是有效的 Windows EXE：${path.basename(file)}`);
    }
  } finally {
    await handle.close();
  }
}

async function spawnDetached(
  executable: string,
  args: readonly string[],
  options: { readonly isolatedEnvironment?: boolean; readonly windowsHide?: boolean } = {}
): Promise<void> {
  const env = { ...process.env };
  delete env.PORTABLE_EXECUTABLE_FILE;
  delete env.PORTABLE_EXECUTABLE_DIR;
  if (options.isolatedEnvironment) {
    delete env.XWX_DECK_UPDATE_PREVIEW;
    delete env.XWX_DECK_PREVIEW_USER_DATA;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      detached: true,
      env,
      stdio: 'ignore',
      windowsHide: options.windowsHide ?? true
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function renameWithRetry(source: string, target: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await fs.promises.rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (Date.now() >= deadline || !['EBUSY', 'EACCES', 'EPERM'].includes(code || '')) throw error;
      await delay(250);
    }
  }
}

async function removeWithRetry(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await fs.promises.rm(file, { force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (Date.now() >= deadline || !['EBUSY', 'EACCES', 'EPERM'].includes(code || '')) throw error;
      await delay(250);
    }
  }
}

function validateExecutablePath(file: string, label: string): void {
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.exe') {
    throw new Error(`${label}路径无效。`);
  }
}

function validatePortableBackupPath(file: string): void {
  if (!path.isAbsolute(file) || !file.toLowerCase().endsWith('.exe.previous')) {
    throw new Error('更新备份路径无效。');
  }
}

function portableReadyPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const resolved = path.resolve(value);
  if (path.dirname(resolved).localeCompare(path.resolve(tmpdir()), undefined, { sensitivity: 'accent' }) !== 0) {
    return undefined;
  }
  return new RegExp(`^${READY_FILE_PREFIX}[0-9a-f-]{36}\\.json$`, 'i').test(path.basename(resolved))
    ? resolved
    : undefined;
}

function encodeArgument(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeArgument(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('更新参数损坏，请重新下载更新。');
  }
}

function argumentValue(argv: readonly string[], prefix: string): string | undefined {
  return argv.find(item => item.startsWith(prefix))?.slice(prefix.length);
}

function samePath(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
