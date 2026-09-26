import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveClientPaths } from '../trace/clientConfig';
import { STARTUP_HIDDEN_ARG } from './startupRegistration';
import { childProcessEnvironment } from '../shared/processEnvironment';

export interface ApplicationResetRequest {
  readonly resetClientConfigs: boolean;
}

export interface ApplicationResetResult {
  readonly removedClientFiles: readonly string[];
  /** Client config files that could not be removed (symlinks, locked, EPERM). */
  readonly skippedClientFiles: readonly string[];
  /** Custom Trace/log entries that could not be cleared. */
  readonly skippedDataPaths: readonly string[];
}

export const APPLICATION_RESET_ARG = '--xwxdeck-reset';

export interface ApplicationRepairResult {
  readonly removedCachePaths: readonly string[];
  /** Total bytes reclaimed, so the UI can report a real outcome. */
  readonly removedBytes: number;
}

export function parseApplicationResetRequest(argv: readonly string[]): ApplicationResetRequest | undefined {
  const argument = argv.find(value => value === APPLICATION_RESET_ARG || value.startsWith(`${APPLICATION_RESET_ARG}=`));
  if (!argument) return undefined;
  const mode = argument === APPLICATION_RESET_ARG
    ? 'app'
    : argument.slice(APPLICATION_RESET_ARG.length + 1);
  if (mode === 'app') return { resetClientConfigs: false };
  if (mode === 'clients') return { resetClientConfigs: true };
  throw new Error('无效的 XwX Deck 重置参数。');
}

export function applicationResetRelaunchArgs(
  argv: readonly string[]
): string[] {
  return argv
    .slice(1)
    .filter(value => value !== APPLICATION_RESET_ARG && !value.startsWith(`${APPLICATION_RESET_ARG}=`))
    // A reset triggered from a login-item launch would otherwise relaunch hidden
    // and the user would never see the onboarding tour they were promised.
    .filter(value => value !== STARTUP_HIDDEN_ARG)
    .filter(value => !/^--xwxdeck-(?:apply-portable-update|portable-update-complete|portable-update-failed)=/.test(value));
}

export function applicationRelaunchExecutable(env = process.env, executable = process.execPath): string {
  return env.PORTABLE_EXECUTABLE_FILE || executable;
}

export function applicationRelaunchEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = childProcessEnvironment(env);
  for (const key of ['ELECTRON_RUN_AS_NODE', 'XWX_APPLICATION_RESET_JOB', 'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_DIR']) {
    delete next[key];
  }
  return next;
}

export function performApplicationResetAtStartup(
  userDataDir: string,
  request: ApplicationResetRequest,
  options: {
    readonly allowedParentDir: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly homeDir?: string;
  }
): ApplicationResetResult {
  assertSafeResetDirectory(userDataDir, options.allowedParentDir);
  const claudeConfigDir = readPersistedClaudeConfigDir(userDataDir);
  const clientPaths = resolveClientPaths(
    options.env ?? process.env,
    options.homeDir,
    { claudeConfigDir }
  );

  const customRoots = resetCustomRoots(userDataDir, readSettingsForReset(userDataDir));
  const safeCustomRoots = customRoots.filter(root => isSafeCustomRoot(root));
  const unsafeCustomRoots = customRoots.filter(root => !isSafeCustomRoot(root));
  // Deleting userData wholesale fails on Windows: the reset now runs after
  // requestSingleInstanceLock (so a losing second instance cannot wipe a live
  // one), which means Chromium already holds its singleton lock file and
  // rmSync(recursive) aborts with EPERM before removing anything. Walk the top
  // level instead, skip what is deliberately kept or held open, and report the
  // rest rather than failing the whole reset.
  const skippedPaths: string[] = [];
  for (const entry of fs.readdirSync(userDataDir)) {
    const target = path.resolve(userDataDir, entry);
    if (ELECTRON_RUNTIME_LOCKS.has(entry)) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
    } catch {
      skippedPaths.push(target);
    }
  }
  const skippedDataPaths = [
    ...unsafeCustomRoots,
    ...safeCustomRoots.flatMap(root => clearCustomRoot(root))
  ];
  const clientFiles = request.resetClientConfigs
    ? removeClientCoreConfigFiles(clientPaths)
    : { removed: [], skipped: [] };
  fs.mkdirSync(userDataDir, { recursive: true });
  return {
    removedClientFiles: clientFiles.removed,
    skippedClientFiles: [...clientFiles.skipped, ...skippedPaths],
    skippedDataPaths
  };
}

/**
 * Files Chromium and Electron hold open for the lifetime of the process. They
 * are runtime plumbing, not user data, so leaving them behind is harmless.
 */
const ELECTRON_RUNTIME_LOCKS = new Set([
  'lockfile',
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket'
]);

/** Clear configured data roots outside the app directory; keep the root folder itself. */
function resetCustomRoots(userDataDir: string, settings: { traceRoot?: string; logRoot?: string }): string[] {
  const roots = [settings.traceRoot, settings.logRoot]
    .map(value => (value && path.isAbsolute(value) ? path.resolve(value) : undefined))
    .filter((value): value is string => !!value);
  const appRoot = path.resolve(userDataDir);
  return [...new Set(roots.filter(root => root !== appRoot
    && !isInside(root, appRoot) && !isInside(appRoot, root)))];
}

function isSafeCustomRoot(root: string): boolean {
  const target = path.resolve(root);
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const physicalTarget = fs.realpathSync.native(target);
    const physicalHome = fs.realpathSync.native(path.resolve(os.homedir()));
    if (physicalTarget === path.parse(physicalTarget).root
      || physicalTarget === physicalHome || isInside(physicalHome, physicalTarget)) return false;
    let parent = path.dirname(physicalTarget);
    while (parent !== path.parse(parent).root) {
      if (fs.lstatSync(parent).isSymbolicLink()) return false;
      parent = path.dirname(parent);
    }
    return true;
  } catch {
    return false;
  }
}

function clearCustomRoot(root: string): string[] {
  const target = path.resolve(root);
  try {
    const skipped: string[] = [];
    for (const entry of fs.readdirSync(target)) {
      const child = path.join(target, entry);
      try {
        fs.rmSync(child, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
      } catch {
        skipped.push(child);
      }
    }
    return skipped;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [target];
  }
}

function isInside(target: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function readSettingsForReset(userDataDir: string): { traceRoot?: string; logRoot?: string } {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8')
    ) as { traceRoot?: unknown; logRoot?: unknown };
    return {
      traceRoot: typeof parsed.traceRoot === 'string' && parsed.traceRoot.trim() ? parsed.traceRoot.trim() : undefined,
      logRoot: typeof parsed.logRoot === 'string' && parsed.logRoot.trim() ? parsed.logRoot.trim() : undefined
    };
  } catch {
    return {};
  }
}

export function performApplicationRepair(
  userDataDir: string,
  options: { readonly allowedParentDir: string; readonly preserveUpdates?: boolean }
): ApplicationRepairResult {
  assertSafeResetDirectory(userDataDir, options.allowedParentDir);
  const relativeTargets = [
    'pricing-cache',
    'updates',
    'model-capabilities-cache.json',
    'compatible-model-catalog-cache.json'
  ];
  const removedCachePaths: string[] = [];
  let removedBytes = 0;
  for (const relativeTarget of relativeTargets) {
    if (relativeTarget === 'updates' && options.preserveUpdates) continue;
    const target = path.resolve(userDataDir, relativeTarget);
    assertPathInside(userDataDir, target);
    if (!fs.existsSync(target)) continue;
    // Measured before deletion: the caches are rebuilt within seconds, so the
    // reclaimed size is the only evidence the action did anything.
    removedBytes += directorySize(target);
    fs.rmSync(target, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 80
    });
    removedCachePaths.push(target);
  }
  fs.mkdirSync(userDataDir, { recursive: true });
  return { removedCachePaths, removedBytes };
}

function directorySize(target: string): number {
  try {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return stat.size;
    let total = 0;
    for (const entry of fs.readdirSync(target)) total += directorySize(path.join(target, entry));
    return total;
  } catch {
    return 0;
  }
}

/**
 * Files and directories only XwX Deck creates. A recursive delete is gated on
 * finding at least one of them, because `userDataDir` can be redirected by
 * XWX_DECK_PREVIEW_USER_DATA / XWX_DECK_SMOKE_USER_DATA and a containment
 * check against its own parent directory is always true — it would have
 * accepted any directory on the machine.
 */
const APPLICATION_DATA_MARKERS = [
  'settings.json',
  'gateway',
  'logs',
  'xwx-trace',
  'xwx-trace-client-backup',
  'pricing-cache',
  'backups'
];

function assertSafeResetDirectory(userDataDir: string, allowedParentDir: string): void {
  const target = path.resolve(userDataDir);
  const parent = path.resolve(allowedParentDir);
  const relative = path.relative(parent, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('XwX Deck 本地数据目录不在允许的重置范围内。');
  }
  const root = path.parse(target).root;
  if (target === root) throw new Error('拒绝重置磁盘根目录。');
  if (path.dirname(target) === root) throw new Error('拒绝重置磁盘顶层目录。');

  const home = path.resolve(os.homedir());
  const homeRelative = path.relative(target, home);
  if (target === home || (homeRelative && !homeRelative.startsWith('..') && !path.isAbsolute(homeRelative))) {
    throw new Error('拒绝重置用户主目录或其上层目录。');
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  // An empty directory has nothing to delete, so there is nothing to protect.
  if (entries.length === 0) return;
  if (!entries.some(entry => APPLICATION_DATA_MARKERS.includes(entry))) {
    throw new Error(`目标目录不像 XwX Deck 的本地数据目录，已拒绝删除：${target}`);
  }
}

function assertPathInside(parentDir: string, targetPath: string): void {
  const parent = path.resolve(parentDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(parent, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('修复目标逃逸出 XwX Deck 本地数据目录。');
  }
}

function readPersistedClaudeConfigDir(userDataDir: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as { claudeConfigDir?: unknown };
    const configured = typeof parsed.claudeConfigDir === 'string'
      ? parsed.claudeConfigDir.trim()
      : '';
    return configured && path.isAbsolute(configured) ? configured : undefined;
  } catch {
    return undefined;
  }
}

function removeClientCoreConfigFiles(
  clientPaths: ReturnType<typeof resolveClientPaths>
): { removed: string[]; skipped: string[] } {
  const claudeDir = path.dirname(clientPaths.claudeSettingsPath);
  const candidates = [
    path.join(claudeDir, 'settings.json'),
    path.join(claudeDir, 'claude.json'),
    clientPaths.codexConfigPath,
    clientPaths.codexAuthPath
  ];
  const existing: string[] = [];
  const skipped: string[] = [];
  for (const candidate of new Set(candidates.map(filePath => path.resolve(filePath)))) {
    try {
      const stat = fs.lstatSync(candidate);
      // Symlinked dotfiles are common. Skipping one must not abort the whole
      // reset before anything has been deleted — that used to leave the app
      // half-reset with no way to retry.
      if (!stat.isFile()) {
        skipped.push(candidate);
        continue;
      }
      existing.push(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      skipped.push(candidate);
    }
  }
  for (const candidate of existing) {
    try {
      fs.rmSync(candidate, { force: true, maxRetries: 5, retryDelay: 80 });
    } catch {
      skipped.push(candidate);
    }
  }
  return { removed: existing.filter(item => !skipped.includes(item)), skipped };
}
