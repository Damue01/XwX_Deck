import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ensureDir, readTextOrUndefined, writeFileAtomic } from '../shared/fsx';
import Database from '../shared/sqlite';
import { resolveClientPaths } from './clientConfig';
import { CODEX_STABLE_PROVIDER } from './clientConfigWriter';
import { readTomlTopLevelString, rootToml } from './toml';

const OFFICIAL_PROVIDER = 'openai';
const COMPATIBLE_SERVICE_PROVIDER = 'compatible';
const STATE_DB_NAME = 'state_5.sqlite';
// v1 moved official history into compatible; v2 moved compatible into official.
// Keep both ledgers so v3 can recover the original provider of upgraded users.
const LEGACY_MIGRATION_BACKUP_NAME = 'codex-official-history-unify-v1';
const MIGRATION_BACKUP_NAME = 'codex-official-history-unify-v2';
const ACTIVE_MIGRATION_BACKUP_NAME_V3 = 'codex-active-history-unify-v3';
const ACTIVE_MIGRATION_BACKUP_NAME_V4 = 'codex-active-history-unify-v4';
const ACTIVE_MIGRATION_BACKUP_NAME = 'codex-stable-history-migration-v5';
const ACTIVE_RESTORE_BACKUP_NAME = 'codex-stable-history-restore-v5';
const SQLITE_ID_CHUNK = 400;
const SESSION_META_SCAN_BYTES = 4 * 1024;
const SESSION_META_LINE_LIMIT = 1024 * 1024;
const SESSION_REWRITE_CONCURRENCY = 2;
const PROVIDER_SCAN_CONCURRENCY = 16;
const SESSION_COPY_BUFFER_BYTES = 256 * 1024;
const SQLITE_BUSY_TIMEOUT_MS = 750;

export interface CodexHistoryMigrationOutcome {
  readonly migratedJsonlFiles: number;
  readonly migratedStateRows: number;
  readonly restoredJsonlFiles: number;
  readonly restoredStateRows: number;
  readonly skippedLockedJsonlFiles: number;
  readonly skippedLockedStateDbs: number;
  readonly skippedReason?: 'no_matching_history' | 'no_backup_ledger' | 'nothing_to_restore' | 'locked_history' | 'live_not_target' | 'restore_deferred';
}

interface GenerationContext {
  readonly root: string;
  readonly codexHome: string;
  readonly sourceProvider: string;
  readonly targetProvider: string;
  ready: boolean;
  preparing?: Promise<void>;
}

interface FileFingerprint {
  readonly size: number;
  readonly mtimeMs: number;
}

interface SessionTreeRewriteOutcome {
  readonly changedFiles: number;
  readonly lockedFiles: readonly string[];
}

interface OriginalProviderLedger {
  readonly sessionProviders: ReadonlyMap<string, string>;
  readonly threadProviders: ReadonlyMap<string, string>;
  readonly unifiedProviders: ReadonlySet<string>;
}

interface HistoryUnifyState {
  readonly version: 3 | 4 | 5;
  readonly codexHome: string;
  readonly targetProvider: string;
  readonly protectedSessionPaths: readonly string[];
}

/**
 * 把全部本地会话归入稳定的 `xwx_deck` 历史桶。OpenAI、兼容服务、自定义
 * provider 和旧 Trace 临时头都只作为迁移来源，不再随上游切换目标分类。
 * JSONL 与 SQLite 都在改写前备份；v5 按每条记录的精确原始 provider 恢复。
 *
 * 这只是 Codex 本地状态归类，不会把第三方请求或会话上传到 OpenAI。
 */
export class CodexHistoryManager {
  private operation: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly userDataDir: string,
    private readonly mutationAllowed: () => Promise<boolean> = async () => true
  ) {}

  async hasMigrationBackup(): Promise<boolean> {
    const codexHome = await currentCodexHome();
    for (const name of [
      LEGACY_MIGRATION_BACKUP_NAME,
      MIGRATION_BACKUP_NAME,
      ACTIVE_MIGRATION_BACKUP_NAME_V3,
      ACTIVE_MIGRATION_BACKUP_NAME_V4,
      ACTIVE_MIGRATION_BACKUP_NAME
    ]) {
      if ((await matchingGenerations(this.backupParent(name), codexHome)).length > 0) return true;
    }
    return false;
  }

  mergeIntoActiveHistory(): Promise<CodexHistoryMigrationOutcome> {
    return this.serialized(async () => {
      if (!await this.mutationAllowed()) return emptyOutcome('restore_deferred');
      const codexHome = await currentCodexHome();
      const configText = await readTextOrUndefined(path.join(codexHome, 'config.toml')) ?? '';
      const activeProvider = readTomlTopLevelString(rootToml(configText), 'model_provider')?.trim()
        || OFFICIAL_PROVIDER;
      if (activeProvider !== CODEX_STABLE_PROVIDER) return emptyOutcome('live_not_target');
      return this.mergeIntoProviderHistoryInner(codexHome, configText, CODEX_STABLE_PROVIDER);
    });
  }

  /** Merge into a provider resolved by the caller from the real config beneath any Trace overlay. */
  mergeIntoProviderHistory(targetProvider: string): Promise<CodexHistoryMigrationOutcome> {
    return this.serialized(async () => {
      if (!await this.mutationAllowed()) return emptyOutcome('restore_deferred');
      const codexHome = await currentCodexHome();
      const configText = await readTextOrUndefined(path.join(codexHome, 'config.toml')) ?? '';
      const activeProvider = readTomlTopLevelString(rootToml(configText), 'model_provider')?.trim()
        || OFFICIAL_PROVIDER;
      const requestedTarget = targetProvider.trim() || CODEX_STABLE_PROVIDER;
      if (requestedTarget !== CODEX_STABLE_PROVIDER) {
        throw new Error(`不支持的 ChatGPT 历史目标 provider：${requestedTarget}`);
      }
      if (activeProvider !== requestedTarget) return emptyOutcome('live_not_target');
      return this.mergeIntoProviderHistoryInner(
        codexHome,
        configText,
        requestedTarget
      );
    });
  }

  /** Merge every discovered local provider into XwX Deck's stable bucket. */
  mergeIntoXwXDeckHistory(): Promise<CodexHistoryMigrationOutcome> {
    return this.mergeIntoProviderHistory(CODEX_STABLE_PROVIDER);
  }

  /** @deprecated Use mergeIntoXwXDeckHistory(). */
  mergeIntoOfficialHistory(): Promise<CodexHistoryMigrationOutcome> {
    return this.mergeIntoXwXDeckHistory();
  }

  restoreSeparatedHistory(): Promise<CodexHistoryMigrationOutcome> {
    return this.serialized(async () => (
      await this.mutationAllowed()
        ? this.restoreSeparatedHistoryInner()
        : emptyOutcome('restore_deferred')
    ));
  }

  private async mergeIntoProviderHistoryInner(
    codexHome: string,
    configText: string,
    targetProvider: string
  ): Promise<CodexHistoryMigrationOutcome> {
    if (targetProvider !== CODEX_STABLE_PROVIDER) {
      throw new Error(`不支持的 ChatGPT 历史目标 provider：${targetProvider}`);
    }
    const dbPaths = stateDbPaths(codexHome, configText);
    const sourceProviders = await discoverHistoryProviders(codexHome, dbPaths);
    const statePath = historyUnifyStatePath(this.backupParent(ACTIVE_MIGRATION_BACKUP_NAME), codexHome);
    const cachedState = await readHistoryUnifyState(statePath, codexHome);
    if (![...sourceProviders].some(provider => provider !== targetProvider)) {
      return emptyOutcome('no_matching_history');
    }
    const protectedSessionPaths = cachedState?.protectedSessionPaths.length
      ? new Set(cachedState.protectedSessionPaths.map(relativePathKey))
      : await collectProtectedSessionPaths([
          this.backupParent(LEGACY_MIGRATION_BACKUP_NAME),
          this.backupParent(MIGRATION_BACKUP_NAME),
          this.backupParent(ACTIVE_MIGRATION_BACKUP_NAME_V3),
          this.backupParent(ACTIVE_MIGRATION_BACKUP_NAME_V4),
          this.backupParent(ACTIVE_MIGRATION_BACKUP_NAME)
        ], codexHome);
    let migratedJsonlFiles = 0;
    let migratedStateRows = 0;
    const lockedJsonlFiles = new Set<string>();
    const lockedStateDbs = new Set<string>();

    for (const sourceProvider of sourceProviders) {
      if (sourceProvider === targetProvider) continue;
      const generation = this.generation(
        ACTIVE_MIGRATION_BACKUP_NAME,
        codexHome,
        sourceProvider,
        targetProvider
      );
      const sessions = await rewriteSessionTrees(
        codexHome,
        generation,
        provider => provider === sourceProvider ? targetProvider : undefined,
        protectedSessionPaths
      );
      migratedJsonlFiles += sessions.changedFiles;
      for (const file of sessions.lockedFiles) lockedJsonlFiles.add(file);
      for (const dbPath of dbPaths) {
        try {
          migratedStateRows += await rewriteStateDb(
            dbPath,
            codexHome,
            generation,
            sourceProvider,
            targetProvider
          );
        } catch (error) {
          if (isLockedResourceError(error)) lockedStateDbs.add(dbPath);
          else throw error;
        }
      }
    }

    if (lockedJsonlFiles.size === 0 && lockedStateDbs.size === 0) {
      await writeHistoryUnifyState(statePath, {
        version: 5,
        codexHome,
        targetProvider,
        protectedSessionPaths: [...protectedSessionPaths].sort()
      }).catch(() => undefined);
    }

    if (migratedJsonlFiles === 0 && migratedStateRows === 0) {
      return emptyOutcome(
        lockedJsonlFiles.size || lockedStateDbs.size ? 'locked_history' : 'no_matching_history',
        lockedJsonlFiles.size,
        lockedStateDbs.size
      );
    }
    return {
      migratedJsonlFiles,
      migratedStateRows,
      restoredJsonlFiles: 0,
      restoredStateRows: 0,
      skippedLockedJsonlFiles: lockedJsonlFiles.size,
      skippedLockedStateDbs: lockedStateDbs.size
    };
  }

  private async restoreSeparatedHistoryInner(): Promise<CodexHistoryMigrationOutcome> {
    const codexHome = await currentCodexHome();
    const ledger = await collectOriginalProviderLedger({
      legacy: this.backupParent(LEGACY_MIGRATION_BACKUP_NAME),
      officialFirst: this.backupParent(MIGRATION_BACKUP_NAME),
      active: [
        this.backupParent(ACTIVE_MIGRATION_BACKUP_NAME_V3),
        this.backupParent(ACTIVE_MIGRATION_BACKUP_NAME_V4),
        this.backupParent(ACTIVE_MIGRATION_BACKUP_NAME)
      ]
    }, codexHome);
    if (ledger.sessionProviders.size === 0 && ledger.threadProviders.size === 0) {
      return emptyOutcome('no_backup_ledger');
    }

    const configText = await readTextOrUndefined(path.join(codexHome, 'config.toml')) ?? '';
    const generation = this.generation(ACTIVE_RESTORE_BACKUP_NAME, codexHome, 'unified', 'original');
    const statePath = historyUnifyStatePath(this.backupParent(ACTIVE_MIGRATION_BACKUP_NAME), codexHome);
    const cachedState = await readHistoryUnifyState(statePath, codexHome);
    const protectedSessionPaths = cachedState?.protectedSessionPaths.length
      ? new Set(cachedState.protectedSessionPaths.map(relativePathKey))
      : await collectProtectedSessionPaths([
          this.backupParent(LEGACY_MIGRATION_BACKUP_NAME),
          this.backupParent(MIGRATION_BACKUP_NAME),
          this.backupParent(ACTIVE_MIGRATION_BACKUP_NAME_V3),
          this.backupParent(ACTIVE_MIGRATION_BACKUP_NAME_V4),
          this.backupParent(ACTIVE_MIGRATION_BACKUP_NAME)
        ], codexHome);
    const sessions = await rewriteSessionTrees(
      codexHome,
      generation,
      (provider, id) => {
        const originalProvider = ledger.sessionProviders.get(id);
        return originalProvider
          && originalProvider !== provider
          && ledger.unifiedProviders.has(provider)
          ? originalProvider
          : undefined;
      },
      protectedSessionPaths
    );
    const restoredJsonlFiles = sessions.changedFiles;
    let restoredStateRows = 0;
    const lockedStateDbs = new Set<string>();
    for (const dbPath of stateDbPaths(codexHome, configText)) {
      try {
        restoredStateRows += await restoreStateDbProviders(
          dbPath,
          codexHome,
          ledger.threadProviders,
          ledger.unifiedProviders,
          generation
        );
      } catch (error) {
        if (isLockedResourceError(error)) lockedStateDbs.add(dbPath);
        else throw error;
      }
    }
    if (restoredJsonlFiles === 0 && restoredStateRows === 0) {
      return emptyOutcome(
        sessions.lockedFiles.length || lockedStateDbs.size ? 'locked_history' : 'nothing_to_restore',
        sessions.lockedFiles.length,
        lockedStateDbs.size
      );
    }
    return {
      migratedJsonlFiles: 0,
      migratedStateRows: 0,
      restoredJsonlFiles,
      restoredStateRows,
      skippedLockedJsonlFiles: sessions.lockedFiles.length,
      skippedLockedStateDbs: lockedStateDbs.size
    };
  }

  private backupParent(name: string): string {
    return path.join(this.userDataDir, 'backups', name);
  }

  private generation(
    name: string,
    codexHome: string,
    sourceProvider: string,
    targetProvider: string
  ): GenerationContext {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
    const nonce = crypto.randomBytes(4).toString('hex');
    return {
      root: path.join(this.backupParent(name), `${stamp}-${process.pid}-${nonce}`),
      codexHome,
      sourceProvider,
      targetProvider,
      ready: false
    };
  }

  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operation.then(action, action);
    this.operation = next.then(() => undefined, () => undefined);
    return next;
  }
}

function legacyLogicalProvider(provider: string): 'openai' | 'compatible' {
  return provider === OFFICIAL_PROVIDER
    ? OFFICIAL_PROVIDER
    : COMPATIBLE_SERVICE_PROVIDER;
}

function emptyOutcome(
  skippedReason: CodexHistoryMigrationOutcome['skippedReason'],
  skippedLockedJsonlFiles = 0,
  skippedLockedStateDbs = 0
): CodexHistoryMigrationOutcome {
  return {
    migratedJsonlFiles: 0,
    migratedStateRows: 0,
    restoredJsonlFiles: 0,
    restoredStateRows: 0,
    skippedLockedJsonlFiles,
    skippedLockedStateDbs,
    skippedReason
  };
}

async function currentCodexHome(): Promise<string> {
  const configPath = resolveClientPaths().codexConfigPath;
  return canonicalPath(path.dirname(configPath));
}

async function canonicalPath(value: string): Promise<string> {
  let resolved = path.resolve(value);
  try { resolved = await fs.promises.realpath(resolved); } catch { /* path can be created later */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function ensureGeneration(generation: GenerationContext): Promise<void> {
  if (generation.ready) return;
  if (!generation.preparing) {
    generation.preparing = (async () => {
      await ensureDir(generation.root);
      await writeFileAtomic(path.join(generation.root, 'meta.json'), JSON.stringify({
        version: 5,
        codexHome: generation.codexHome,
        createdAt: new Date().toISOString(),
        sourceProvider: generation.sourceProvider,
        targetProvider: generation.targetProvider
      }, null, 2));
      generation.ready = true;
    })();
  }
  await generation.preparing;
}

async function matchingGenerations(parent: string, codexHome: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(parent, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const generation = path.join(parent, entry.name);
    try {
      const meta = JSON.parse(await fs.promises.readFile(path.join(generation, 'meta.json'), 'utf8')) as { codexHome?: unknown };
      if (typeof meta.codexHome === 'string' && await canonicalPath(meta.codexHome) === codexHome) out.push(generation);
    } catch { /* ignore incomplete or foreign generations */ }
  }
  return out.sort();
}

interface GenerationMeta {
  readonly version?: unknown;
  readonly codexHome?: unknown;
  readonly sourceProvider?: unknown;
  readonly logicalSourceProvider?: unknown;
  readonly targetProvider?: unknown;
}

async function readGenerationMeta(generation: string): Promise<GenerationMeta | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(path.join(generation, 'meta.json'), 'utf8')) as GenerationMeta;
  } catch {
    return undefined;
  }
}

async function discoverHistoryProviders(codexHome: string, dbPaths: readonly string[]): Promise<Set<string>> {
  const providers = new Set<string>();
  const files = [
    ...await collectFiles(path.join(codexHome, 'sessions'), '.jsonl', 8),
    ...await collectFiles(path.join(codexHome, 'archived_sessions'), '.jsonl', 4)
  ];
  let nextIndex = 0;
  const workerCount = Math.min(PROVIDER_SCAN_CONCURRENCY, files.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= files.length) return;
      try {
        const stat = await fs.promises.stat(files[index]);
        const head = await readFileHead(files[index], Math.min(stat.size, SESSION_META_SCAN_BYTES));
        const provider = readSessionMetaPrefix(head)?.provider.trim();
        if (provider) providers.add(provider);
      } catch {
        // A live rollout may be locked while Codex writes it. SQLite normally
        // supplies the same provider; otherwise a later merge retries it.
      }
    }
  }));

  for (const dbPath of dbPaths) {
    if (!fs.existsSync(dbPath)) continue;
    let db: Database | undefined;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: SQLITE_BUSY_TIMEOUT_MS });
      if (!hasThreadsProviderColumn(db)) continue;
      const rows = db.prepare('SELECT DISTINCT model_provider FROM threads').all() as Array<{ model_provider?: unknown }>;
      for (const row of rows) {
        if (typeof row.model_provider === 'string' && row.model_provider.trim()) {
          providers.add(row.model_provider.trim());
        }
      }
    } catch {
      // Keep history classification best-effort; locked databases are retried
      // by the next startup/provider switch.
    } finally {
      db?.close();
    }
  }
  return providers;
}

function historyUnifyStatePath(activeMigrationParent: string, codexHome: string): string {
  const key = crypto.createHash('sha256').update(codexHome).digest('hex').slice(0, 16);
  return path.join(activeMigrationParent, 'state', `${key}.json`);
}

async function readHistoryUnifyState(
  statePath: string,
  codexHome: string
): Promise<HistoryUnifyState | undefined> {
  try {
    const value = JSON.parse(await fs.promises.readFile(statePath, 'utf8')) as Partial<HistoryUnifyState>;
    if ((value.version !== 3 && value.version !== 4 && value.version !== 5)
      || value.codexHome !== codexHome
      || typeof value.targetProvider !== 'string') {
      return undefined;
    }
    return {
      version: value.version,
      codexHome,
      targetProvider: value.targetProvider,
      protectedSessionPaths: Array.isArray(value.protectedSessionPaths)
        ? value.protectedSessionPaths.filter((item): item is string => typeof item === 'string')
        : []
    };
  } catch {
    return undefined;
  }
}

async function writeHistoryUnifyState(statePath: string, state: HistoryUnifyState): Promise<void> {
  await ensureDir(path.dirname(statePath));
  await writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function collectOriginalProviderLedger(
  parents: { readonly legacy: string; readonly officialFirst: string; readonly active: readonly string[] },
  codexHome: string
): Promise<OriginalProviderLedger> {
  const sessionProviders = new Map<string, string>();
  const threadProviders = new Map<string, string>();
  const unifiedProviders = new Set<string>([
    OFFICIAL_PROVIDER,
    COMPATIBLE_SERVICE_PROVIDER,
    CODEX_STABLE_PROVIDER
  ]);

  const remember = async (
    generations: readonly string[],
    storedProvider: string,
    restoreProvider: string
  ): Promise<void> => {
    const ids = await collectProviderLedger(generations, storedProvider);
    for (const id of ids.sessionIds) if (!sessionProviders.has(id)) sessionProviders.set(id, restoreProvider);
    for (const id of ids.threadIds) if (!threadProviders.has(id)) threadProviders.set(id, restoreProvider);
  };

  // v1 moved official -> compatible; v2 moved genuine compatible -> openai.
  // Seed those known original sources before considering v3 switch generations.
  await remember(await matchingGenerations(parents.legacy, codexHome), OFFICIAL_PROVIDER, OFFICIAL_PROVIDER);
  await remember(await matchingGenerations(parents.officialFirst, codexHome), COMPATIBLE_SERVICE_PROVIDER, COMPATIBLE_SERVICE_PROVIDER);

  for (const parent of parents.active) {
    for (const generation of await matchingGenerations(parent, codexHome)) {
      const meta = await readGenerationMeta(generation);
      const source = typeof meta?.sourceProvider === 'string' ? meta.sourceProvider : '';
      const target = typeof meta?.targetProvider === 'string' ? meta.targetProvider : '';
      const logicalSource = typeof meta?.logicalSourceProvider === 'string'
        ? meta.logicalSourceProvider
        : legacyLogicalProvider(source);
      if (!source || !target) continue;
      unifiedProviders.add(source);
      unifiedProviders.add(target);
      const restoreProvider = meta?.version === 5 ? source : legacyLogicalProvider(logicalSource);
      await remember([generation], source, restoreProvider);
    }
  }

  return { sessionProviders, threadProviders, unifiedProviders };
}

async function rewriteSessionTrees(
  codexHome: string,
  generation: GenerationContext,
  replacement: (provider: string, id: string) => string | undefined,
  protectedSessionPaths: Set<string>
): Promise<SessionTreeRewriteOutcome> {
  const files = [
    ...await collectFiles(path.join(codexHome, 'sessions'), '.jsonl', 8),
    ...await collectFiles(path.join(codexHome, 'archived_sessions'), '.jsonl', 4)
  ];
  let changed = 0;
  const lockedFiles: string[] = [];
  let nextIndex = 0;
  // Large real-world rollout files can be tens or hundreds of MB. Keep disk
  // concurrency bounded so a first-time merge cannot create a memory/IO storm.
  const workerCount = Math.min(SESSION_REWRITE_CONCURRENCY, files.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= files.length) return;
      const file = files[index];
      try {
        if (await rewriteSessionFile(file, codexHome, generation, replacement, protectedSessionPaths)) changed += 1;
      } catch (error) {
        if (isLockedResourceError(error)) lockedFiles.push(file);
        else throw error;
      }
    }
  }));
  return { changedFiles: changed, lockedFiles };
}

async function collectFiles(root: string, extension: string, maxDepth: number, depth = 0): Promise<string[]> {
  if (depth > maxDepth) return [];
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return []; }
  const nested = await Promise.all(entries.map(entry => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return collectFiles(target, extension, maxDepth, depth + 1);
    return Promise.resolve(entry.isFile() && path.extname(entry.name).toLowerCase() === extension ? [target] : []);
  }));
  return nested.flat();
}

async function rewriteSessionFile(
  file: string,
  codexHome: string,
  generation: GenerationContext,
  replacement: (provider: string, id: string) => string | undefined,
  protectedSessionPaths: Set<string>
): Promise<boolean> {
  const before = await fingerprint(file);
  const head = await readFileHead(file, Math.min(before.size, SESSION_META_SCAN_BYTES));
  const meta = readSessionMetaPrefix(head);
  if (meta) {
    const nextProvider = replacement(meta.provider, meta.id);
    if (nextProvider === undefined) return false;
    const nextBytes = Buffer.from(nextProvider, 'utf8');
    if (nextBytes.length + 1 <= meta.providerRegionLength) {
      const fitted = Buffer.alloc(meta.providerRegionLength, 0x20);
      nextBytes.copy(fitted);
      fitted[nextBytes.length] = 0x22;
      await prepareSessionRewrite(file, codexHome, generation, before, protectedSessionPaths);
      await writeBufferAt(file, before, fitted, meta.providerValueStart);
      return true;
    }
  }

  // A first move to a longer provider id cannot be done in place. Rewrite only
  // the metadata line and stream-copy the remaining bytes into an atomic temp
  // file. Reading the entire rollout into a UTF-16 JS string caused multi-GB
  // memory spikes on normal Codex histories.
  const firstLine = await readFirstLine(file, before.size);
  if (!firstLine) return false;
  const nextLine = rewriteSessionProvider(firstLine.text, replacement);
  if (nextLine === undefined) return false;
  await prepareSessionRewrite(file, codexHome, generation, before, protectedSessionPaths);
  await rewriteFilePrefixAtomic(
    file,
    before,
    Buffer.concat([Buffer.from(nextLine, 'utf8'), firstLine.newline]),
    firstLine.remainderOffset
  );
  return true;
}

interface FirstLine {
  readonly text: string;
  readonly newline: Buffer;
  readonly remainderOffset: number;
}

async function readFirstLine(file: string, size: number): Promise<FirstLine | undefined> {
  const content = await readFileHead(file, Math.min(size, SESSION_META_LINE_LIMIT));
  let delimiter = -1;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === 0x0A || content[index] === 0x0D) {
      delimiter = index;
      break;
    }
  }
  if (delimiter < 0) {
    if (size > content.length) return undefined;
    return { text: content.toString('utf8'), newline: Buffer.alloc(0), remainderOffset: content.length };
  }
  const newlineEnd = content[delimiter] === 0x0D && content[delimiter + 1] === 0x0A
    ? delimiter + 2
    : delimiter + 1;
  return {
    text: content.subarray(0, delimiter).toString('utf8'),
    newline: content.subarray(delimiter, newlineEnd),
    remainderOffset: newlineEnd
  };
}

async function rewriteFilePrefixAtomic(
  file: string,
  before: FileFingerprint,
  prefix: Buffer,
  remainderOffset: number
): Promise<void> {
  const temp = `${file}.xwx-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  let source: fs.promises.FileHandle | undefined;
  let target: fs.promises.FileHandle | undefined;
  try {
    source = await fs.promises.open(file, 'r');
    target = await fs.promises.open(temp, 'wx');
    await writeAll(target, prefix, 0);

    const buffer = Buffer.allocUnsafe(SESSION_COPY_BUFFER_BYTES);
    let readPosition = remainderOffset;
    let writePosition = prefix.length;
    while (readPosition < before.size) {
      const length = Math.min(buffer.length, before.size - readPosition);
      const { bytesRead } = await source.read(buffer, 0, length, readPosition);
      if (bytesRead <= 0) throw new Error(`ChatGPT 会话流式读取提前结束：${file}`);
      await writeAll(target, buffer.subarray(0, bytesRead), writePosition);
      readPosition += bytesRead;
      writePosition += bytesRead;
    }
    await target.sync();
    await source.close();
    source = undefined;
    await target.close();
    target = undefined;
    await assertFingerprint(file, before);
    await fs.promises.rename(temp, file);
  } catch (error) {
    await source?.close().catch(() => undefined);
    await target?.close().catch(() => undefined);
    await fs.promises.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeAll(handle: fs.promises.FileHandle, content: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < content.length) {
    const { bytesWritten } = await handle.write(content, offset, content.length - offset, position + offset);
    if (bytesWritten <= 0) throw new Error('ChatGPT 会话流式写入未取得进展。');
    offset += bytesWritten;
  }
}

interface JsonStringField {
  readonly value: string;
  readonly valueStart: number;
  readonly valueEnd: number;
}

interface SessionMetaPrefix {
  readonly id: string;
  readonly provider: string;
  readonly providerValueStart: number;
  readonly providerRegionLength: number;
}

function readSessionMetaPrefix(content: Buffer): SessionMetaPrefix | undefined {
  const type = readJsonStringField(content, 'type');
  const id = readJsonStringField(content, 'id');
  const provider = readJsonStringField(content, 'model_provider');
  if (type?.value !== 'session_meta' || !id?.value || !provider?.value) return undefined;
  let whitespaceEnd = provider.valueEnd + 1;
  while (whitespaceEnd < content.length && (content[whitespaceEnd] === 0x20 || content[whitespaceEnd] === 0x09)) {
    whitespaceEnd += 1;
  }
  return {
    id: id.value,
    provider: provider.value,
    providerValueStart: provider.valueStart,
    providerRegionLength: whitespaceEnd - provider.valueStart
  };
}

function readJsonStringField(content: Buffer, key: string): JsonStringField | undefined {
  const token = Buffer.from(JSON.stringify(key), 'utf8');
  let keyStart = content.indexOf(token);
  while (keyStart >= 0) {
    let cursor = keyStart + token.length;
    while (cursor < content.length && isJsonWhitespace(content[cursor])) cursor += 1;
    if (content[cursor] !== 0x3A) {
      keyStart = content.indexOf(token, keyStart + token.length);
      continue;
    }
    cursor += 1;
    while (cursor < content.length && isJsonWhitespace(content[cursor])) cursor += 1;
    if (content[cursor] !== 0x22) return undefined;
    const valueStart = cursor + 1;
    let escaped = false;
    for (let end = valueStart; end < content.length; end += 1) {
      const byte = content[end];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (byte === 0x5C) {
        escaped = true;
        continue;
      }
      if (byte === 0x22) {
        try {
          return {
            value: JSON.parse(content.subarray(valueStart - 1, end + 1).toString('utf8')) as string,
            valueStart,
            valueEnd: end
          };
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }
  return undefined;
}

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0A || byte === 0x0D;
}

async function readFileHead(file: string, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function prepareSessionRewrite(
  file: string,
  codexHome: string,
  generation: GenerationContext,
  before: FileFingerprint,
  protectedSessionPaths: Set<string>
): Promise<void> {
  await assertFingerprint(file, before);
  await ensureGeneration(generation);
  const relative = safeRelativePath(file, codexHome);
  const key = relativePathKey(relative);
  if (!protectedSessionPaths.has(key)) {
    const backup = path.join(generation.root, 'jsonl', relative);
    await ensureDir(path.dirname(backup));
    await fs.promises.copyFile(file, backup, fs.constants.COPYFILE_EXCL);
    protectedSessionPaths.add(key);
  }
  await assertFingerprint(file, before);
}

async function writeBufferAt(
  file: string,
  before: FileFingerprint,
  content: Buffer,
  position: number
): Promise<void> {
  const handle = await fs.promises.open(file, 'r+');
  try {
    const current = await handle.stat();
    if (current.size !== before.size || current.mtimeMs !== before.mtimeMs) {
      throw changedDuringMigrationError(file);
    }
    const { bytesWritten } = await handle.write(content, 0, content.length, position);
    if (bytesWritten !== content.length) throw new Error(`ChatGPT 会话元数据写入不完整：${file}`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function rewriteSessionProvider(
  line: string,
  replacement: (provider: string, id: string) => string | undefined
): string | undefined {
  if (!line.includes('session_meta') || !line.includes('model_provider')) return undefined;
  const bom = line.charCodeAt(0) === 0xFEFF ? '\uFEFF' : '';
  try {
    const value = JSON.parse(bom ? line.slice(1) : line) as {
      type?: unknown;
      payload?: { id?: unknown; model_provider?: unknown; [key: string]: unknown };
    };
    if (value.type !== 'session_meta' || !value.payload) return undefined;
    const id = typeof value.payload.id === 'string' ? value.payload.id : '';
    const provider = typeof value.payload.model_provider === 'string' ? value.payload.model_provider : '';
    const next = id && provider ? replacement(provider, id) : undefined;
    if (!next) return undefined;
    value.payload.model_provider = next;
    return `${bom}${JSON.stringify(value)}`;
  } catch {
    return undefined;
  }
}

async function fingerprint(file: string): Promise<FileFingerprint> {
  const stat = await fs.promises.stat(file);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

async function assertFingerprint(file: string, before: FileFingerprint): Promise<void> {
  const after = await fingerprint(file);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw changedDuringMigrationError(file);
  }
}

function changedDuringMigrationError(file: string): Error {
  return Object.assign(
    new Error(`ChatGPT 会话在迁移期间发生变化，已跳过以避免覆盖：${file}`),
    { code: 'EBUSY' }
  );
}

function isLockedResourceError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const sqliteCode = typeof error === 'object' && error !== null && 'errcode' in error
    ? Number((error as { errcode?: unknown }).errcode)
    : undefined;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return sqliteCode === 5 || sqliteCode === 6 || message.includes('database is locked') || [
    'EPERM',
    'EACCES',
    'EBUSY',
    'SQLITE_BUSY',
    'SQLITE_BUSY_RECOVERY',
    'SQLITE_BUSY_SNAPSHOT',
    'SQLITE_LOCKED',
    'SQLITE_LOCKED_SHAREDCACHE'
  ].includes(code);
}

function stateDbPaths(codexHome: string, configText: string): string[] {
  const configured = readTomlTopLevelString(rootToml(configText), 'sqlite_home')?.trim();
  const envHome = process.env.CODEX_SQLITE_HOME?.trim();
  const paths = [path.join(codexHome, STATE_DB_NAME)];
  for (const extraHome of [configured, envHome]) {
    if (!extraHome) continue;
    const resolvedHome = path.isAbsolute(extraHome) ? extraHome : path.resolve(codexHome, extraHome);
    paths.push(path.join(resolvedHome, STATE_DB_NAME));
  }
  return [...new Set(paths.map(value => path.resolve(value)))];
}

async function rewriteStateDb(
  dbPath: string,
  codexHome: string,
  generation: GenerationContext,
  sourceProvider: string,
  targetProvider: string
): Promise<number> {
  if (!fs.existsSync(dbPath)) return 0;
  const db = new Database(dbPath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
  try {
    if (!hasThreadsProviderColumn(db)) return 0;
    const count = Number((db.prepare('SELECT COUNT(*) AS count FROM threads WHERE model_provider = ?').get(sourceProvider) as { count: number }).count);
    if (!count) return 0;
    await backupDatabase(db, dbPath, codexHome, generation);
    return db.transaction(() => db.prepare('UPDATE threads SET model_provider = ? WHERE model_provider = ?').run(targetProvider, sourceProvider).changes)();
  } finally {
    db.close();
  }
}

async function restoreStateDbProviders(
  dbPath: string,
  codexHome: string,
  originalProviders: ReadonlyMap<string, string>,
  unifiedProviders: ReadonlySet<string>,
  generation: GenerationContext
): Promise<number> {
  if (!fs.existsSync(dbPath) || originalProviders.size === 0) return 0;
  const db = new Database(dbPath, { timeout: SQLITE_BUSY_TIMEOUT_MS });
  try {
    if (!hasThreadsProviderColumn(db)) return 0;
    const idsByTarget = new Map<string, string[]>();
    for (const [id, provider] of originalProviders) {
      const ids = idsByTarget.get(provider) ?? [];
      ids.push(id);
      idsByTarget.set(provider, ids);
    }
    const sources = [...unifiedProviders];
    let matching = 0;
    for (const [target, ids] of idsByTarget) {
      for (const source of sources) {
        if (source === target) continue;
        for (const chunk of chunks(ids, SQLITE_ID_CHUNK)) {
          const sql = `SELECT COUNT(*) AS count FROM threads WHERE model_provider = ? AND id IN (${placeholders(chunk.length)})`;
          matching += Number((db.prepare(sql).get(source, ...chunk) as { count: number }).count);
        }
      }
    }
    if (!matching) return 0;
    await backupDatabase(db, dbPath, codexHome, generation);
    return db.transaction(() => {
      let changed = 0;
      for (const [target, ids] of idsByTarget) {
        for (const source of sources) {
          if (source === target) continue;
          for (const chunk of chunks(ids, SQLITE_ID_CHUNK)) {
            const sql = `UPDATE threads SET model_provider = ? WHERE model_provider = ? AND id IN (${placeholders(chunk.length)})`;
            changed += db.prepare(sql).run(target, source, ...chunk).changes;
          }
        }
      }
      return changed;
    })();
  } finally {
    db.close();
  }
}

function hasThreadsProviderColumn(db: Database): boolean {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get();
  if (!table) return false;
  const columns = db.prepare('PRAGMA table_info(threads)').all() as Array<{ name?: unknown }>;
  return columns.some(column => column.name === 'id') && columns.some(column => column.name === 'model_provider');
}

async function backupDatabase(
  db: Database,
  dbPath: string,
  codexHome: string,
  generation: GenerationContext
): Promise<void> {
  await ensureGeneration(generation);
  const backup = path.join(generation.root, 'state', safeRelativePath(dbPath, codexHome));
  await ensureDir(path.dirname(backup));
  await db.backup(backup);
}

async function collectProviderLedger(
  generations: readonly string[],
  providerToCollect: string
): Promise<{ sessionIds: Set<string>; threadIds: Set<string> }> {
  const sessionIds = new Set<string>();
  const threadIds = new Set<string>();
  for (const generation of generations) {
    for (const file of await collectFiles(path.join(generation, 'jsonl'), '.jsonl', 12)) {
      const stat = await fs.promises.stat(file).catch(() => undefined);
      const content = stat
        ? await readFileHead(file, Math.min(stat.size, SESSION_META_SCAN_BYTES)).catch(() => Buffer.alloc(0))
        : Buffer.alloc(0);
      const meta = readSessionMetaPrefix(content);
      if (meta?.provider === providerToCollect) sessionIds.add(meta.id);
    }
    for (const file of await collectFiles(path.join(generation, 'state'), '.sqlite', 6)) {
      let db: Database | undefined;
      try {
        db = new Database(file, { readonly: true, fileMustExist: true });
        if (!hasThreadsProviderColumn(db)) continue;
        const rows = db.prepare('SELECT id FROM threads WHERE model_provider = ?').all(providerToCollect) as Array<{ id?: unknown }>;
        for (const row of rows) if (typeof row.id === 'string') threadIds.add(row.id);
      } catch { /* a damaged backup must not block other generations */ }
      finally { db?.close(); }
    }
  }
  return { sessionIds, threadIds };
}

async function collectProtectedSessionPaths(
  parents: readonly string[],
  codexHome: string
): Promise<Set<string>> {
  const protectedPaths = new Set<string>();
  for (const parent of parents) {
    for (const generation of await matchingGenerations(parent, codexHome)) {
      const jsonRoot = path.join(generation, 'jsonl');
      for (const file of await collectFiles(jsonRoot, '.jsonl', 12)) {
        const relative = path.relative(jsonRoot, file);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
          protectedPaths.add(relativePathKey(relative));
        }
      }
    }
  }
  return protectedPaths;
}

function relativePathKey(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function safeRelativePath(file: string, root: string): string {
  const relative = path.relative(root, file);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  const hash = crypto.createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 16);
  return path.join('external', hash, path.basename(file));
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}
