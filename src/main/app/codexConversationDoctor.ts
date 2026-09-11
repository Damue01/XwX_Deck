import * as fs from 'fs';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';
import type {
  CodexConversationDatabaseHealth,
  CodexConversationHealthReport,
  CodexConversationHealthRow,
  CodexConversationIssue,
  CodexConversationScanPerformance,
  CodexConversationWorkspaceKind,
  CodexRolloutLocation
} from '../../shared/codexConversationHealth';
import Database from '../shared/sqlite';
import { resolveClientPaths } from '../trace/clientConfig';
import { readTextOrUndefined } from '../shared/fsx';

const MAX_THREADS = 5_000;
const MAX_SESSION_META_BYTES = 1024 * 1024;
const SESSION_META_CHUNK_BYTES = 64 * 1024;
const ROLLOUT_SCAN_CONCURRENCY = 16;
const THREAD_ID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const THREAD_ID_ANY_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
const BUILT_IN_PROVIDERS = new Set(['openai', 'ollama', 'lmstudio']);

export interface ThreadIndexRow {
  id: string;
  title: string;
  preview: string;
  workspaceKind: CodexConversationWorkspaceKind;
  workspaceName: string;
  projectId?: string;
  projectName?: string;
  projectRoots: string[];
  cwd?: string;
  rolloutPath?: string;
  provider?: string;
  archived?: boolean;
  archivedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  databasePaths: string[];
  indexConflict: boolean;
  sqliteFields: Array<{ key: string; value: string }>;
}

export interface RolloutFile {
  path: string;
  normalizedPath: string;
  location: CodexRolloutLocation;
  size: number;
  modifiedAt: string;
  filenameThreadId?: string;
  sessionId?: string;
  provider?: string;
  cwd?: string;
  metaValid: boolean;
  metaErrorKind?: 'empty' | 'invalid' | 'read_error';
  metaError?: string;
  sessionFields: Array<{ key: string; value: string }>;
}

interface ProjectRecord {
  name: string;
  roots: string[];
}

interface DatabaseInspection {
  readonly health: CodexConversationDatabaseHealth;
  readonly rows: ThreadIndexRow[];
  readonly truncated: boolean;
}

interface CachedRolloutFile {
  readonly signature: string;
  readonly file: RolloutFile;
}

interface CachedDatabaseInspection {
  readonly signature: string;
  readonly inspection: DatabaseInspection;
}

export class CodexConversationScanCache {
  readonly rollouts = new Map<string, CachedRolloutFile>();
  readonly databases = new Map<string, CachedDatabaseInspection>();
}

export interface CodexConversationDoctorOptions {
  readonly cache?: CodexConversationScanCache;
  readonly isCancelled?: () => boolean;
}

export class CodexConversationScanCancelledError extends Error {
  constructor() {
    super('对话诊断扫描已取消');
    this.name = 'CodexConversationScanCancelledError';
  }
}

export class CodexConversationDoctor {
  private scanPerformance: CodexConversationScanPerformance = {
    durationMs: 0,
    reusedRollouts: 0,
    inspectedRollouts: 0,
    reusedDatabases: 0,
    inspectedDatabases: 0
  };

  constructor(private readonly options: CodexConversationDoctorOptions = {}) {}

  performance(): CodexConversationScanPerformance {
    return this.scanPerformance;
  }

  async diagnose(): Promise<CodexConversationHealthReport> {
    const startedAt = Date.now();
    const counters = {
      reusedRollouts: 0,
      inspectedRollouts: 0,
      reusedDatabases: 0,
      inspectedDatabases: 0
    };
    assertScanActive(this.options);
    const paths = resolveClientPaths();
    const codexHome = path.dirname(paths.codexConfigPath);
    const configText = await readTextOrUndefined(paths.codexConfigPath) ?? '';
    const config = parseConfig(configText);
    const databasePaths = stateDatabasePaths(codexHome, configText);
    const databaseHealth: CodexConversationDatabaseHealth[] = [];
    const scanIssues: CodexConversationIssue[] = [];
    const indexed = new Map<string, ThreadIndexRow>();
    let truncated = false;

    if (config.error) {
      scanIssues.push(issue(
        'scan_incomplete',
        'warning',
        'Provider 配置无法解析',
        `${paths.codexConfigPath}：${config.error}`
      ));
    }

    for (const databasePath of databasePaths) {
      assertScanActive(this.options);
      const result = inspectDatabaseCached(databasePath, this.options.cache, counters);
      databaseHealth.push(result.health);
      if (result.truncated) truncated = true;
      for (const row of result.rows) mergeIndexRow(indexed, cloneIndexRow(row));
    }

    appendDatabaseScanIssues(scanIssues, databaseHealth);
    const seenRolloutPaths = new Set<string>();
    const sessionsScan = await collectRollouts(
      path.join(codexHome, 'sessions'),
      'sessions',
      this.options,
      counters,
      seenRolloutPaths
    );
    const archivedScan = await collectRollouts(
      path.join(codexHome, 'archived_sessions'),
      'archived_sessions',
      this.options,
      counters,
      seenRolloutPaths
    );
    if (this.options.cache) {
      for (const cachedPath of this.options.cache.rollouts.keys()) {
        if (!seenRolloutPaths.has(cachedPath)) this.options.cache.rollouts.delete(cachedPath);
      }
      for (const cachedPath of this.options.cache.databases.keys()) {
        if (!databasePaths.includes(cachedPath)) this.options.cache.databases.delete(cachedPath);
      }
    }
    const allFiles = [...sessionsScan.files, ...archivedScan.files];
    for (const scanError of [...sessionsScan.errors, ...archivedScan.errors]) {
      scanIssues.push(issue(
        'scan_incomplete',
        'warning',
        'Session 目录扫描不完整',
        `${scanError.path}：${scanError.message}`
      ));
    }
    if (allFiles.some(file => file.metaErrorKind === 'read_error')) {
      scanIssues.push(issue(
        'scan_incomplete',
        'warning',
        '部分 JSONL 无法读取',
        '至少一个 Session 文件在扫描期间被锁定、移除或无法访问。'
      ));
    }
    const filesById = indexRolloutsByThreadId(allFiles);
    const indexedIds = new Set(indexed.keys());
    const conversations: CodexConversationHealthRow[] = [];

    for (const row of indexed.values()) {
      assertScanActive(this.options);
      conversations.push(buildIndexedHealthRow(
        row,
        filesById,
        config.providers,
        this.options,
        counters,
        seenRolloutPaths
      ));
    }

    const orphanGroups = new Map<string, RolloutFile[]>();
    for (const file of allFiles) {
      assertScanActive(this.options);
      const id = file.sessionId || file.filenameThreadId || file.path;
      if (indexedIds.has(id)) continue;
      const group = orphanGroups.get(id) ?? [];
      group.push(file);
      orphanGroups.set(id, group);
    }
    for (const files of orphanGroups.values()) {
      assertScanActive(this.options);
      conversations.push(buildOrphanHealthRow(files, config.providers));
    }

    conversations.sort(compareHealthRows);
    const limited = conversations.slice(0, MAX_THREADS);
    if (limited.length < conversations.length) truncated = true;

    this.scanPerformance = {
      durationMs: Date.now() - startedAt,
      ...counters
    };
    return {
      generatedAt: new Date().toISOString(),
      codexHome,
      configPath: paths.codexConfigPath,
      activeProvider: config.activeProvider,
      configuredProviders: [...config.providers].sort(),
      databases: databaseHealth,
      scanScope: 'index-and-session-meta',
      scanComplete: scanIssues.length === 0 && !truncated,
      scanIssues,
      truncated,
      summary: {
        indexedThreads: indexed.size,
        discoveredRollouts: allFiles.length,
        healthy: limited.filter(row => row.status === 'healthy').length,
        warnings: limited.filter(row => row.status === 'warning').length,
        errors: limited.filter(row => row.status === 'error').length,
        orphanRollouts: limited.filter(row => row.issues.some(issue => issue.code === 'orphan_rollout')).length,
        missingRollouts: limited.filter(row => row.issues.some(issue => issue.code === 'rollout_file_missing')).length
      },
      conversations: limited
    };
  }
}

export function isPathInsideCodexHome(filePath: string): boolean {
  const codexHome = realPathOrResolved(path.dirname(resolveClientPaths().codexConfigPath));
  const target = realPathOrResolved(stripWindowsExtendedPrefix(filePath));
  const relative = path.relative(codexHome, target);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function realPathOrResolved(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function parseConfig(text: string): { activeProvider: string; providers: Set<string>; error?: string } {
  const providers = new Set(BUILT_IN_PROVIDERS);
  let activeProvider = 'openai';
  try {
    const parsed = parseToml(text) as {
      model_provider?: unknown;
      model_providers?: Record<string, unknown>;
    };
    if (typeof parsed.model_provider === 'string' && parsed.model_provider.trim()) {
      activeProvider = parsed.model_provider.trim();
    }
    if (parsed.model_providers && typeof parsed.model_providers === 'object') {
      for (const provider of Object.keys(parsed.model_providers)) providers.add(provider);
    }
  } catch (error) {
    // The database and rollout scan remains useful even if config.toml is
    // malformed. Every custom provider will be marked as unavailable.
    return { activeProvider, providers, error: errorMessage(error) };
  }
  return { activeProvider, providers };
}

function stateDatabasePaths(codexHome: string, configText: string): string[] {
  const output = [path.join(codexHome, 'state_5.sqlite')];
  let configuredHome = '';
  try {
    const parsed = parseToml(configText) as { sqlite_home?: unknown };
    configuredHome = typeof parsed.sqlite_home === 'string' ? parsed.sqlite_home.trim() : '';
  } catch {
    configuredHome = '';
  }
  for (const candidate of [configuredHome, process.env.CODEX_SQLITE_HOME?.trim() ?? '']) {
    if (!candidate) continue;
    const home = path.isAbsolute(candidate) ? candidate : path.resolve(codexHome, candidate);
    output.push(path.join(home, 'state_5.sqlite'));
  }
  return [...new Set(output.map(value => path.resolve(value)))];
}

function databaseSignature(databasePath: string): string {
  return [fileSignatureSync(databasePath), fileSignatureSync(`${databasePath}-wal`)].join('|');
}

function fileSignatureSync(filePath: string): string {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

function inspectDatabaseCached(
  databasePath: string,
  cache: CodexConversationScanCache | undefined,
  counters: { reusedDatabases: number; inspectedDatabases: number }
): DatabaseInspection {
  const signature = databaseSignature(databasePath);
  const cached = cache?.databases.get(databasePath);
  if (cached?.signature === signature) {
    counters.reusedDatabases += 1;
    return cached.inspection;
  }
  const inspection = inspectDatabase(databasePath);
  counters.inspectedDatabases += 1;
  cache?.databases.set(databasePath, { signature, inspection });
  return inspection;
}

function inspectDatabase(databasePath: string): DatabaseInspection {
  if (!fs.existsSync(databasePath)) {
    return {
      health: {
        path: databasePath,
        exists: false,
        readable: false,
        walPresent: fs.existsSync(`${databasePath}-wal`)
      },
      rows: [],
      truncated: false
    };
  }

  let db: Database | undefined;
  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 1_000 });
    const quickCheckRows = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check?: unknown }>;
    const quickCheck = quickCheckRows
      .map(row => String(row.quick_check ?? '').trim())
      .filter(Boolean)
      .join('; ');
    const table = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='threads'").get();
    if (!table) {
      return {
        health: databaseHealth(databasePath, false, quickCheck, undefined, '缺少 threads 表'),
        rows: [],
        truncated: false
      };
    }
    const columns = new Set(
      (db.prepare('PRAGMA table_info(threads)').all() as Array<{ name?: unknown }>)
        .map(column => typeof column.name === 'string' ? column.name : '')
        .filter(Boolean)
    );
    if (!columns.has('id')) {
      return {
        health: databaseHealth(databasePath, false, quickCheck, undefined, 'threads 表缺少 id 字段'),
        rows: [],
        truncated: false
      };
    }
    const projects = readProjects(db);
    const selectable = [
      'id', 'rollout_path', 'model_provider', 'model', 'reasoning_effort',
      'source', 'thread_source', 'cwd', 'title', 'name',
      'sandbox_policy', 'approval_mode', 'tokens_used', 'has_user_event',
      'archived', 'archived_at', 'created_at', 'updated_at', 'recency_at',
      'history_mode', 'cli_version', 'git_sha', 'git_branch', 'git_origin_url',
      'agent_nickname', 'agent_role', 'agent_path', 'memory_mode', 'is_pinned',
      'thread_section_id', 'section_position', 'project_id',
      'created_at_ms', 'updated_at_ms', 'recency_at_ms', 'section_entered_at_ms'
    ].filter(column => columns.has(column));
    const total = Number((db.prepare('SELECT COUNT(*) AS count FROM threads').get() as { count?: unknown })?.count ?? 0);
    const rows = db.prepare(
      `SELECT ${selectable.map(column => `"${column}"`).join(', ')} FROM threads ORDER BY `
      + `${columns.has('updated_at_ms') ? '"updated_at_ms"' : columns.has('updated_at') ? '"updated_at"' : '"id"'} DESC `
      + `LIMIT ${MAX_THREADS + 1}`
    ).all() as Array<Record<string, unknown>>;
    return {
      health: databaseHealth(databasePath, true, quickCheck, total),
      rows: rows.slice(0, MAX_THREADS).map(row => {
        const cwd = optionalString(row.cwd);
        const projectId = optionalString(row.project_id);
        const project = projectId ? projects.get(projectId) : undefined;
        const workspaceKind: CodexConversationWorkspaceKind = project
          ? 'project'
          : cwd ? 'directory' : 'none';
        return {
          id: stringValue(row.id),
          title: firstText(row.title, row.name),
          // Keep diagnostics metadata-only. SQLite preview/first_user_message
          // fields may contain conversation text and must never be queried.
          preview: '',
          workspaceKind,
          workspaceName: project ? project.name || '未命名 Project' : cwd ? directoryName(cwd) : '',
          ...(projectId ? { projectId } : {}),
          ...(project ? { projectName: project.name } : {}),
          projectRoots: project?.roots ?? [],
          ...(cwd ? { cwd } : {}),
          rolloutPath: optionalString(row.rollout_path),
          provider: optionalString(row.model_provider),
          archived: row.archived === undefined ? undefined : Number(row.archived) !== 0,
          archivedAt: timestampValue(row.archived_at),
          createdAt: timestampValue(row.created_at_ms ?? row.created_at),
          updatedAt: timestampValue(row.updated_at_ms ?? row.updated_at),
          databasePaths: [databasePath],
          indexConflict: false,
          sqliteFields: sqliteFieldList(row, selectable)
        };
      }).filter(row => !!row.id),
      truncated: total > MAX_THREADS
    };
  } catch (error) {
    return {
      health: databaseHealth(
        databasePath,
        false,
        undefined,
        undefined,
        error instanceof Error ? error.message : String(error)
      ),
      rows: [],
      truncated: false
    };
  } finally {
    db?.close();
  }
}

function readProjects(db: Database): Map<string, ProjectRecord> {
  const output = new Map<string, ProjectRecord>();
  if (!tableExists(db, 'projects')) return output;
  const projectColumns = tableColumns(db, 'projects');
  if (!projectColumns.has('id')) return output;
  const nameExpression = projectColumns.has('name') ? '"name"' : "''";
  const rows = db.prepare(`SELECT "id", ${nameExpression} AS "name" FROM "projects"`).all() as unknown as
    Array<Record<string, unknown>>;
  for (const row of rows) {
    const id = optionalString(row.id);
    if (id) output.set(id, { name: optionalString(row.name) ?? '', roots: [] });
  }
  if (!tableExists(db, 'project_roots')) return output;
  const rootColumns = tableColumns(db, 'project_roots');
  if (!rootColumns.has('project_id') || !rootColumns.has('path')) return output;
  const order = rootColumns.has('position') ? ' ORDER BY "project_id", "position"' : ' ORDER BY "project_id", "path"';
  const roots = db.prepare(`SELECT "project_id", "path" FROM "project_roots"${order}`).all() as unknown as
    Array<Record<string, unknown>>;
  for (const row of roots) {
    const projectId = optionalString(row.project_id);
    const root = optionalString(row.path);
    const project = projectId ? output.get(projectId) : undefined;
    if (project && root && !project.roots.includes(root)) project.roots.push(root);
  }
  return output;
}

function tableExists(db: Database, tableName: string): boolean {
  return !!db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
}

function tableColumns(db: Database, tableName: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name?: unknown }>)
      .map(column => typeof column.name === 'string' ? column.name : '')
      .filter(Boolean)
  );
}

function databaseHealth(
  databasePath: string,
  readable: boolean,
  quickCheck?: string,
  threadCount?: number,
  error?: string
): CodexConversationDatabaseHealth {
  const walPath = `${databasePath}-wal`;
  const walPresent = fs.existsSync(walPath);
  return {
    path: databasePath,
    exists: true,
    readable,
    ...(quickCheck ? { quickCheck } : {}),
    ...(threadCount === undefined ? {} : { threadCount }),
    walPresent,
    ...(walPresent ? { walBytes: safeFileSize(walPath) } : {}),
    ...(error ? { error } : {})
  };
}

function appendDatabaseScanIssues(
  issues: CodexConversationIssue[],
  databases: readonly CodexConversationDatabaseHealth[]
): void {
  const readable = databases.filter(database => database.readable);
  if (readable.length === 0) {
    const detail = databases.length
      ? databases.map(database => `${database.path}${database.error ? `：${database.error}` : ''}`).join('；')
      : '没有找到可读取的 state_5.sqlite。';
    issues.push(issue('database_unavailable', 'error', 'SQLite 无法读取', detail));
    return;
  }
  for (const database of databases) {
    if (database.exists && !database.readable) {
      issues.push(issue(
        'database_unavailable',
        'error',
        'SQLite 无法读取',
        `${database.path}${database.error ? `：${database.error}` : ''}`
      ));
    } else if (database.readable && database.quickCheck !== 'ok') {
      issues.push(issue(
        'sqlite_integrity_failed',
        'error',
        'SQLite 完整性检查失败',
        `${database.path}：${database.quickCheck || '未返回检查结果'}`
      ));
    }
  }
}

function mergeIndexRow(target: Map<string, ThreadIndexRow>, incoming: ThreadIndexRow): void {
  const current = target.get(incoming.id);
  if (!current) {
    target.set(incoming.id, incoming);
    return;
  }
  const conflict = current.rolloutPath !== incoming.rolloutPath
    || current.provider !== incoming.provider
    || current.archived !== incoming.archived
    || current.projectId !== incoming.projectId
    || current.projectName !== incoming.projectName
    || current.projectRoots.join('\n') !== incoming.projectRoots.join('\n')
    || current.cwd !== incoming.cwd;
  current.databasePaths.push(...incoming.databasePaths.filter(item => !current.databasePaths.includes(item)));
  current.indexConflict = current.indexConflict || conflict;
}

function cloneIndexRow(row: ThreadIndexRow): ThreadIndexRow {
  return {
    ...row,
    projectRoots: [...row.projectRoots],
    databasePaths: [...row.databasePaths],
    sqliteFields: row.sqliteFields.map(field => ({ ...field }))
  };
}

async function collectRollouts(
  root: string,
  location: Exclude<CodexRolloutLocation, 'other' | 'missing'>,
  options: CodexConversationDoctorOptions,
  counters: { reusedRollouts: number; inspectedRollouts: number },
  seenRolloutPaths: Set<string>
): Promise<{
  files: RolloutFile[];
  errors: Array<{ path: string; message: string }>;
}> {
  const output: RolloutFile[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  const rolloutPaths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    assertScanActive(options);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (!isMissingPathError(error)) {
        errors.push({ path: directory, message: errorMessage(error) });
      }
      return;
    }
    for (const entry of entries) {
      assertScanActive(options);
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
        rolloutPaths.push(target);
      }
    }
  };
  await visit(root);
  for (let offset = 0; offset < rolloutPaths.length; offset += ROLLOUT_SCAN_CONCURRENCY) {
    assertScanActive(options);
    const batch = rolloutPaths.slice(offset, offset + ROLLOUT_SCAN_CONCURRENCY);
    const inspected = await Promise.all(batch.map(async filePath => {
      try {
        assertScanActive(options);
        const stat = await fs.promises.stat(filePath);
        const normalizedPath = normalizePath(filePath);
        const signature = `${location}:${stat.size}:${stat.mtimeMs}`;
        seenRolloutPaths.add(normalizedPath);
        const cached = options.cache?.rollouts.get(normalizedPath);
        if (cached?.signature === signature) {
          counters.reusedRollouts += 1;
          return { file: cached.file };
        }
        const file = await inspectRollout(filePath, location, stat, options);
        counters.inspectedRollouts += 1;
        options.cache?.rollouts.set(normalizedPath, { signature, file });
        return { file };
      } catch (error) {
        if (error instanceof CodexConversationScanCancelledError) throw error;
        return { error: { path: filePath, message: errorMessage(error) } };
      }
    }));
    for (const result of inspected) {
      if (result.file) output.push(result.file);
      else if (result.error) errors.push(result.error);
    }
  }
  return { files: output, errors };
}

async function inspectRollout(
  filePath: string,
  location: CodexRolloutLocation,
  stat: fs.Stats,
  options: CodexConversationDoctorOptions
): Promise<RolloutFile> {
  let sessionId: string | undefined;
  let provider: string | undefined;
  let cwd: string | undefined;
  let metaValid = false;
  let metaErrorKind: RolloutFile['metaErrorKind'];
  let metaError: string | undefined;
  let sessionFields: Array<{ key: string; value: string }> = [];
  if (stat.size === 0) {
    metaErrorKind = 'empty';
    metaError = 'JSONL 文件为空';
  } else {
    try {
      const firstLine = await readFirstLine(filePath, options);
      const meta = JSON.parse(firstLine) as {
        type?: unknown;
        payload?: Record<string, unknown>;
      };
      if (meta.type !== 'session_meta' || typeof meta.payload?.id !== 'string') {
        metaErrorKind = 'invalid';
        metaError = '首行不是有效的 session_meta';
      } else {
        metaValid = true;
        sessionId = meta.payload.id;
        provider = optionalString(meta.payload.model_provider);
        cwd = optionalString(meta.payload.cwd);
        sessionFields = sessionFieldList(meta.payload);
      }
    } catch (error) {
      if (error instanceof CodexConversationScanCancelledError) throw error;
      metaErrorKind = sessionMetaErrorKind(error);
      metaError = errorMessage(error);
    }
  }
  return {
    path: filePath,
    normalizedPath: normalizePath(filePath),
    location,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    filenameThreadId: threadIdFromFileName(filePath),
    sessionId,
    provider,
    cwd,
    metaValid,
    ...(metaErrorKind ? { metaErrorKind } : {}),
    sessionFields,
    ...(metaError ? { metaError } : {})
  };
}

function assertScanActive(options: CodexConversationDoctorOptions): void {
  if (options.isCancelled?.()) throw new CodexConversationScanCancelledError();
}

async function readFirstLine(filePath: string, options: CodexConversationDoctorOptions): Promise<string> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const chunks: Buffer[] = [];
    let position = 0;
    while (position < MAX_SESSION_META_BYTES) {
      assertScanActive(options);
      const buffer = Buffer.allocUnsafe(Math.min(SESSION_META_CHUNK_BYTES, MAX_SESSION_META_BYTES - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      chunks.push(newline < 0 ? chunk : chunk.subarray(0, newline));
      position += bytesRead;
      if (newline >= 0) {
        return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').replace(/\r$/, '');
      }
      if (bytesRead < buffer.length) break;
    }
    if (!position) throw new Error('JSONL 文件为空');
    if (position >= MAX_SESSION_META_BYTES) throw new Error('session_meta 首行超过扫描上限');
    return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').replace(/\r$/, '');
  } finally {
    await handle.close();
  }
}

function indexRolloutsByThreadId(files: readonly RolloutFile[]): Map<string, RolloutFile[]> {
  const output = new Map<string, RolloutFile[]>();
  for (const file of files) {
    for (const id of new Set([file.sessionId, file.filenameThreadId].filter((value): value is string => !!value))) {
      const existing = output.get(id) ?? [];
      existing.push(file);
      output.set(id, existing);
    }
  }
  return output;
}

function buildIndexedHealthRow(
  row: ThreadIndexRow,
  filesById: ReadonlyMap<string, readonly RolloutFile[]>,
  configuredProviders: ReadonlySet<string>,
  options: CodexConversationDoctorOptions,
  counters: { reusedRollouts: number; inspectedRollouts: number },
  seenRolloutPaths: Set<string>
): CodexConversationHealthRow {
  const issues: CodexConversationIssue[] = [];
  const exactPath = row.rolloutPath?.trim();
  const resolvedIndexPath = exactPath ? resolveIndexedRolloutPath(exactPath, row.databasePaths[0]) : '';
  const exactNormalized = resolvedIndexPath ? normalizePath(resolvedIndexPath) : '';
  const candidates = [...(filesById.get(row.id) ?? [])];
  const exact = exactNormalized
    ? candidates.find(file => file.normalizedPath === exactNormalized)
      ?? inspectExistingPathSyncCached(resolvedIndexPath, options, counters, seenRolloutPaths)
    : undefined;
  if (exact && !candidates.some(file => file.normalizedPath === exact.normalizedPath)) {
    candidates.push(exact);
  }
  const uniqueCandidates = sortRolloutsByStart(uniqueRollouts(candidates));
  const segmentChain = isRolloutSegmentChain(uniqueCandidates, row.id);
  const resolved = exact ?? (
    uniqueCandidates.length === 1 || segmentChain
      ? preferredRollout(uniqueCandidates)
      : undefined
  );
  const candidateSessionProvider = singleValue(uniqueCandidates.map(candidate => candidate.provider));
  const candidateSessionId = singleValue(uniqueCandidates.map(candidate => candidate.sessionId));

  if (row.indexConflict) {
    issues.push(issue('duplicate_index', 'error', '索引记录冲突', '同一任务在多个 SQLite 中的路径、Provider 或归档状态不一致。'));
  }
  if (!exactPath) {
    issues.push(issue('missing_rollout_path', 'error', '索引缺少会话路径', 'threads.rollout_path 为空。'));
  } else if (!exact) {
    issues.push(issue('rollout_file_missing', 'error', '索引指向的文件不存在', exactPath));
  }
  if (!exact && (uniqueCandidates.length === 1 || segmentChain)) {
    const recovery = preferredRollout(uniqueCandidates);
    issues.push(issue(
      'recovery_candidate',
      'warning',
      '发现可恢复文件',
      segmentChain
        ? `找到 ${uniqueCandidates.length} 个连续会话片段，最新文件位于 ${recovery.location}：${recovery.path}`
        : `同一任务 ID 出现在 ${recovery.location}：${recovery.path}`
    ));
  }
  if (uniqueCandidates.length > 1 && !segmentChain) {
    issues.push(issue(
      'multiple_rollout_candidates',
      'error',
      '找到多个同 ID 文件',
      `共 ${uniqueCandidates.length} 个文件，无法唯一确定它们是否属于同一条连续会话。`
    ));
  }
  for (const candidate of uniqueCandidates) {
    if (!candidate.metaValid) {
      issues.push(metaIssue(candidate));
    }
    if (candidate.sessionId && candidate.sessionId !== row.id) {
      issues.push(issue(
        'thread_id_mismatch',
        'error',
        '任务 ID 不一致',
        `SQLite=${row.id}，JSONL=${candidate.sessionId}（${candidate.path}）`
      ));
    }
    if (row.provider && candidate.provider && row.provider !== candidate.provider) {
      issues.push(issue(
        'provider_mismatch',
        'error',
        'Provider 不一致',
        `SQLite=${row.provider}，JSONL=${candidate.provider}（${candidate.path}）`
      ));
    }
  }
  appendProviderIssues(
    issues,
    [row.provider, ...uniqueCandidates.map(candidate => candidate.provider)],
    configuredProviders
  );
  if (resolved && row.archived !== undefined) {
    const expected = row.archived ? 'archived_sessions' : 'sessions';
    if (resolved.location !== expected) {
      issues.push(issue(
        'archive_location_mismatch',
        'warning',
        '归档状态与目录不一致',
        `SQLite archived=${row.archived ? 1 : 0}，文件位于 ${resolved.location}`
      ));
    }
  }

  return {
    threadId: row.id,
    title: row.title || '未命名任务',
    preview: row.preview,
    workspaceKind: row.workspaceKind,
    workspaceName: row.workspaceName,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    ...(row.projectName !== undefined ? { projectName: row.projectName } : {}),
    projectRoots: row.projectRoots,
    ...(row.cwd ? { cwd: row.cwd } : {}),
    indexed: true,
    databasePaths: row.databasePaths,
    ...(exactPath ? { rolloutPath: exactPath } : {}),
    ...(resolved ? {
      resolvedPath: resolved.path,
      fileExists: true,
      fileSize: resolved.size,
      fileModifiedAt: resolved.modifiedAt,
      location: resolved.location,
      ...(resolved.sessionId ? { sessionId: resolved.sessionId } : {}),
      ...(resolved.provider ? { sessionProvider: resolved.provider } : {})
    } : uniqueCandidates.length > 0 ? {
      fileExists: true,
      location: preferredRollout(uniqueCandidates).location,
      ...(candidateSessionId ? { sessionId: candidateSessionId } : {}),
      ...(candidateSessionProvider ? { sessionProvider: candidateSessionProvider } : {})
    } : {
      fileExists: false,
      location: 'missing' as const
    }),
    candidatePaths: uniqueCandidates.map(file => file.path),
    ...(row.archived === undefined ? {} : { archived: row.archived }),
    ...(row.archivedAt ? { archivedAt: row.archivedAt } : {}),
    ...(row.createdAt ? { createdAt: row.createdAt } : {}),
    ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
    ...(row.provider ? { sqliteProvider: row.provider } : {}),
    sqliteFields: row.sqliteFields,
    sessionFields: resolved?.sessionFields ?? [],
    status: statusFromIssues(issues),
    issues
  };
}

function buildOrphanHealthRow(
  files: readonly RolloutFile[],
  configuredProviders: ReadonlySet<string>
): CodexConversationHealthRow {
  const uniqueFiles = sortRolloutsByStart(uniqueRollouts(files));
  const file = preferredRollout(uniqueFiles);
  const sessionProvider = singleValue(uniqueFiles.map(candidate => candidate.provider));
  const sessionId = singleValue(uniqueFiles.map(candidate => candidate.sessionId));
  const cwd = singleValue(uniqueFiles.map(candidate => candidate.cwd));
  const segmentChain = !!sessionId && isRolloutSegmentChain(uniqueFiles, sessionId);
  const issues: CodexConversationIssue[] = [
    issue('orphan_rollout', 'warning', '文件未进入 SQLite 索引', file.path)
  ];
  if (uniqueFiles.length > 1 && !segmentChain) {
    issues.push(issue(
      'multiple_rollout_candidates',
      'error',
      '找到多个同 ID 文件',
      `共 ${uniqueFiles.length} 个文件，无法唯一确定它们是否属于同一条连续会话。`
    ));
  }
  for (const candidate of uniqueFiles) {
    if (!candidate.metaValid) {
      issues.push(metaIssue(candidate));
    }
  }
  appendProviderIssues(
    issues,
    uniqueFiles.map(candidate => candidate.provider),
    configuredProviders
  );
  return {
    threadId: file.sessionId || file.filenameThreadId || path.basename(file.path),
    title: '未索引的会话文件',
    preview: '',
    workspaceKind: cwd ? 'directory' : 'none',
    workspaceName: cwd ? directoryName(cwd) : '',
    projectRoots: [],
    ...(cwd ? { cwd } : {}),
    indexed: false,
    databasePaths: [],
    ...(uniqueFiles.length === 1 || segmentChain ? { resolvedPath: file.path } : {}),
    candidatePaths: uniqueFiles.map(candidate => candidate.path),
    fileExists: true,
    ...(uniqueFiles.length === 1 || segmentChain ? {
      fileSize: file.size,
      fileModifiedAt: file.modifiedAt
    } : {}),
    location: file.location,
    ...(sessionId ? { sessionId } : {}),
    ...(sessionProvider ? { sessionProvider } : {}),
    sqliteFields: [],
    sessionFields: file.sessionFields,
    status: statusFromIssues(issues),
    issues
  };
}

function appendProviderIssues(
  issues: CodexConversationIssue[],
  providers: readonly (string | undefined)[],
  configuredProviders: ReadonlySet<string>
): void {
  for (const provider of new Set(providers.filter((value): value is string => !!value))) {
    if (!configuredProviders.has(provider)) {
      issues.push(issue(
        'provider_not_configured',
        'error',
        'Provider 未配置',
        `配置文件中找不到 ${provider}。`
      ));
    }
  }
}

function metaIssue(file: RolloutFile): CodexConversationIssue {
  if (file.metaErrorKind === 'empty') {
    return issue('empty_session_file', 'error', 'JSONL 文件为空', file.path);
  }
  if (file.metaErrorKind === 'read_error') {
    return issue('invalid_session_meta', 'error', 'JSONL 无法读取', `${file.path}：${file.metaError || '未知错误'}`);
  }
  return issue('invalid_session_meta', 'error', 'Session 元数据无效', file.metaError || file.path);
}

function issue(
  code: CodexConversationIssue['code'],
  severity: CodexConversationIssue['severity'],
  title: string,
  detail: string
): CodexConversationIssue {
  return { code, severity, title, detail };
}

function statusFromIssues(issues: readonly CodexConversationIssue[]): CodexConversationHealthRow['status'] {
  if (issues.some(issue => issue.severity === 'error')) return 'error';
  if (issues.length) return 'warning';
  return 'healthy';
}

function compareHealthRows(left: CodexConversationHealthRow, right: CodexConversationHealthRow): number {
  const rank = { error: 0, warning: 1, healthy: 2 } as const;
  const status = rank[left.status] - rank[right.status];
  if (status) return status;
  return String(right.updatedAt || right.fileModifiedAt || '').localeCompare(
    String(left.updatedAt || left.fileModifiedAt || '')
  );
}

function inspectExistingPathSyncCached(
  filePath: string,
  options: CodexConversationDoctorOptions,
  counters: { reusedRollouts: number; inspectedRollouts: number },
  seenRolloutPaths: Set<string>
): RolloutFile | undefined {
  assertScanActive(options);
  const normalizedPath = normalizePath(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) return undefined;
  } catch {
    return undefined;
  }
  const signature = `${rolloutLocation(filePath)}:${stat.size}:${stat.mtimeMs}`;
  seenRolloutPaths.add(normalizedPath);
  const cached = options.cache?.rollouts.get(normalizedPath);
  if (cached?.signature === signature) {
    counters.reusedRollouts += 1;
    return cached.file;
  }
  const file = inspectExistingPathSync(filePath, stat);
  if (file) {
    counters.inspectedRollouts += 1;
    options.cache?.rollouts.set(normalizedPath, { signature, file });
  }
  return file;
}

function inspectExistingPathSync(filePath: string, existingStat?: fs.Stats): RolloutFile | undefined {
  let stat: fs.Stats;
  try {
    stat = existingStat ?? fs.statSync(filePath);
    if (!stat.isFile()) return undefined;
  } catch {
    return undefined;
  }
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(MAX_SESSION_META_BYTES);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (!bytesRead) {
        return rolloutFromMetaError(filePath, stat, 'JSONL 文件为空', 'empty');
      }
      const content = buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '');
      const newline = content.indexOf('\n');
      if (newline < 0 && bytesRead === buffer.length) {
        return rolloutFromMetaError(filePath, stat, 'session_meta 首行超过扫描上限', 'invalid');
      }
      const line = (newline < 0 ? content : content.slice(0, newline)).replace(/\r$/, '');
      let meta: { type?: unknown; payload?: Record<string, unknown> };
      try {
        meta = JSON.parse(line) as { type?: unknown; payload?: Record<string, unknown> };
      } catch (error) {
        return rolloutFromMetaError(filePath, stat, errorMessage(error), 'invalid');
      }
      if (meta.type !== 'session_meta' || typeof meta.payload?.id !== 'string') {
        return rolloutFromMetaError(filePath, stat, '首行不是有效的 session_meta', 'invalid');
      }
      return {
        path: filePath,
        normalizedPath: normalizePath(filePath),
        location: rolloutLocation(filePath),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        filenameThreadId: threadIdFromFileName(filePath),
        sessionId: meta.payload.id,
        provider: optionalString(meta.payload.model_provider),
        cwd: optionalString(meta.payload.cwd),
        metaValid: true,
        sessionFields: sessionFieldList(meta.payload)
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return rolloutFromMetaError(filePath, stat, errorMessage(error), 'read_error');
  }
}

function rolloutFromMetaError(
  filePath: string,
  stat: fs.Stats,
  metaError: string,
  metaErrorKind: NonNullable<RolloutFile['metaErrorKind']>
): RolloutFile {
  return {
    path: filePath,
    normalizedPath: normalizePath(filePath),
    location: rolloutLocation(filePath),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    filenameThreadId: threadIdFromFileName(filePath),
    metaValid: false,
    metaErrorKind,
    metaError,
    sessionFields: []
  };
}

function sqliteFieldList(
  row: Readonly<Record<string, unknown>>,
  columns: readonly string[]
): Array<{ key: string; value: string }> {
  const visibleColumns = new Set([
    'id', 'rollout_path', 'model_provider', 'model', 'reasoning_effort', 'source',
    'thread_source', 'cwd', 'title', 'name', 'preview', 'sandbox_policy',
    'approval_mode', 'tokens_used', 'has_user_event', 'archived', 'archived_at',
    'created_at', 'updated_at', 'recency_at', 'history_mode', 'cli_version',
    'git_sha', 'git_branch', 'git_origin_url', 'agent_nickname', 'agent_role',
    'agent_path', 'memory_mode', 'is_pinned', 'thread_section_id', 'section_position',
    'project_id'
  ]);
  return columns
    .filter(key => visibleColumns.has(key))
    .map(key => ({ key, value: displayFieldValue(key, row[key]) }))
    .map(field => ({ ...field, value: field.value || '—' }));
}

function sessionFieldList(
  payload: Readonly<Record<string, unknown>>
): Array<{ key: string; value: string }> {
  const preferredOrder = [
    'id', 'session_id', 'model_provider', 'source', 'thread_source', 'originator',
    'cwd', 'timestamp', 'cli_version', 'history_mode', 'context_window',
    'parent_thread_id', 'forked_from_id', 'agent_nickname', 'agent_path',
    'multi_agent_version', 'git', 'dynamic_tools', 'base_instructions'
  ];
  return preferredOrder
    .filter(key => Object.prototype.hasOwnProperty.call(payload, key))
    .map(key => ({ key, value: displayFieldValue(key, payload[key]) }))
    .map(field => ({ ...field, value: field.value || '—' }));
}

function displayFieldValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (key === 'base_instructions') {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text ? `${text.length} 字符` : '';
  }
  if (key === 'dynamic_tools') {
    if (Array.isArray(value)) return `${value.length} 项`;
    if (value && typeof value === 'object') return `${Object.keys(value).length} 项`;
    return '0 项';
  }
  if (key.endsWith('_at') || key.endsWith('_at_ms') || key === 'timestamp') {
    const timestamp = timestampValue(value);
    if (timestamp) return timestamp;
  }
  if (typeof value === 'string') return value.length > 1_000 ? `${value.slice(0, 1_000)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > 1_000 ? `${serialized.slice(0, 1_000)}…` : serialized;
  } catch {
    return String(value);
  }
}

function rolloutLocation(filePath: string): CodexRolloutLocation {
  const normalized = normalizePath(filePath);
  if (normalized.includes(`${path.sep}archived_sessions${path.sep}`)) return 'archived_sessions';
  if (normalized.includes(`${path.sep}sessions${path.sep}`)) return 'sessions';
  return 'other';
}

function threadIdFromFileName(filePath: string): string | undefined {
  return path.basename(filePath).match(THREAD_ID_PATTERN)?.[1];
}

function normalizePath(value: string): string {
  const resolved = path.resolve(stripWindowsExtendedPrefix(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function directoryName(value: string): string {
  const cleaned = stripWindowsExtendedPrefix(value.trim()).replace(/[\\/]+$/u, '');
  return cleaned.split(/[\\/]/u).pop() || cleaned;
}

function resolveIndexedRolloutPath(value: string, databasePath: string | undefined): string {
  const clean = stripWindowsExtendedPrefix(value);
  if (path.isAbsolute(clean)) return path.resolve(clean);
  return path.resolve(databasePath ? path.dirname(databasePath) : process.cwd(), clean);
}

function uniqueRollouts(files: readonly RolloutFile[]): RolloutFile[] {
  const seen = new Set<string>();
  return files.filter(file => {
    if (seen.has(file.normalizedPath)) return false;
    seen.add(file.normalizedPath);
    return true;
  });
}

function sortRolloutsByStart(files: readonly RolloutFile[]): RolloutFile[] {
  return [...files].sort((left, right) => (
    path.basename(left.path).localeCompare(path.basename(right.path), 'en')
      || left.path.localeCompare(right.path, 'en')
  ));
}

function isRolloutSegmentChain(files: readonly RolloutFile[], threadId: string): boolean {
  if (files.length < 2) return false;
  const normalizedThreadId = threadId.toLowerCase();
  const suffixIds = new Set<string>();
  let baseFiles = 0;
  let segmentFiles = 0;

  for (const file of files) {
    if (!file.metaValid || file.sessionId?.toLowerCase() !== normalizedThreadId) return false;
    const filenameIds = path.basename(file.path).match(THREAD_ID_ANY_PATTERN) ?? [];
    if (filenameIds[0]?.toLowerCase() !== normalizedThreadId) return false;
    if (filenameIds.length === 1) {
      baseFiles += 1;
      continue;
    }
    if (filenameIds.length !== 2) return false;
    const suffixId = filenameIds[1].toLowerCase();
    if (suffixId === normalizedThreadId || suffixIds.has(suffixId)) return false;
    suffixIds.add(suffixId);
    segmentFiles += 1;
  }

  return baseFiles <= 1 && segmentFiles > 0;
}

function preferredRollout(files: readonly RolloutFile[]): RolloutFile {
  return [...files].sort((left, right) => {
    const locationRank: Record<CodexRolloutLocation, number> = {
      sessions: 0,
      archived_sessions: 1,
      other: 2,
      missing: 3
    };
    return locationRank[left.location] - locationRank[right.location]
      || right.modifiedAt.localeCompare(left.modifiedAt);
  })[0];
}

function singleValue(values: readonly (string | undefined)[]): string | undefined {
  const unique = new Set(values.filter((value): value is string => !!value));
  return unique.size === 1 ? [...unique][0] : undefined;
}

function isMissingPathError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionMetaErrorKind(error: unknown): NonNullable<RolloutFile['metaErrorKind']> {
  if (error instanceof SyntaxError) return 'invalid';
  const message = errorMessage(error);
  return message.startsWith('session_meta ') ? 'invalid' : 'read_error';
}

function stripWindowsExtendedPrefix(value: string): string {
  return value.startsWith('\\\\?\\') ? value.slice(4) : value;
}

function safeFileSize(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function timestampValue(value: unknown): string | undefined {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1_000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
