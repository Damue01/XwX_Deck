import * as fs from 'fs';
import * as path from 'path';
import Database from '../shared/sqlite';
import { readTextOrUndefinedSync } from '../shared/fsx';
import { TapSessionSummary } from './types';
import { readTomlTopLevelString, rootToml } from './toml';

const STATE_DB_NAME = 'state_5.sqlite';
// 必须显著大于面板轮询间隔（约 3s），否则几乎每次 listSessions 都会触发一次同步刷新，
// 把 SQLite 打开 + 查询压在 Electron 主线程（与 tap proxy 共享事件循环）上。
const REFRESH_INTERVAL_MS = 15_000;
const SQLITE_BUSY_TIMEOUT_MS = 250;
// 单次查询最多取多少个 thread id：面板一屏的会话数远小于此，超出则退化为不带 WHERE 的全表查。
const MAX_QUERY_IDS = 200;

interface NativeThreadTitle {
  readonly title: string;
  readonly updatedAt: number;
}

interface ThreadTitleRow {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly name?: unknown;
  readonly first_user_message?: unknown;
  readonly updated_at?: unknown;
}

/**
 * Read-only adapter for Codex's own persisted Thread metadata.
 *
 * The Codex state database belongs to Codex. XwX Deck never creates, migrates,
 * updates, checkpoints, or backs it up here; it only overlays native names on
 * the dashboard response.
 */
export class CodexThreadTitleReader {
  private refreshedAt = 0;
  private cached = new Map<string, NativeThreadTitle>();
  /** 上次查询覆盖过的 thread id：窄查询下，出现未覆盖的 id 必须立刻刷新而不能等 TTL。 */
  private covered = new Set<string>();

  constructor(
    private readonly codexConfigPath: () => string,
    private readonly env: () => NodeJS.ProcessEnv = () => process.env
  ) {}

  async overlay(sessions: readonly TapSessionSummary[]): Promise<ReadonlyMap<string, string>> {
    const requested = sessions.flatMap(session => {
      const threadId = codexThreadId(session);
      return threadId ? [{ sessionId: session.id, threadId }] : [];
    });
    if (requested.length === 0) return new Map();

    this.refreshIfNeeded(requested.map(item => item.threadId));
    const overlay = new Map<string, string>();
    for (const item of requested) {
      const native = this.cached.get(item.threadId);
      if (native?.title) overlay.set(item.sessionId, native.title);
    }
    return overlay;
  }

  private refreshIfNeeded(threadIds: readonly string[]): void {
    const wanted = [...new Set(threadIds)];
    const now = Date.now();
    const missing = wanted.some(id => !this.covered.has(id));
    if (!missing && now - this.refreshedAt < REFRESH_INTERVAL_MS) return;
    this.refreshedAt = now;

    const configPath = this.codexConfigPath();
    const codexHome = path.dirname(configPath);
    const configText = readTextOrUndefinedSync(configPath) ?? '';
    const dbPaths = stateDbPaths(codexHome, configText, this.env());
    const next = new Map<string, NativeThreadTitle>();
    let opened = 0;

    for (const dbPath of dbPaths) {
      if (!fs.existsSync(dbPath)) continue;
      let db: Database | undefined;
      try {
        db = new Database(dbPath, {
          readonly: true,
          fileMustExist: true,
          timeout: SQLITE_BUSY_TIMEOUT_MS
        });
        // 打开成功即计入：若放在列检查之后，一个缺 title 列的库会让 continue 跳过计数，
        // 下方的"保留上次快照"守卫随之为假，this.cached 永远不被赋值——overlay 静默永久返回空。
        opened += 1;
        const columns = threadColumns(db);
        if (!columns.has('id') || !columns.has('title')) continue;
        // 只查面板当前需要的 thread：早先是无 WHERE/LIMIT 的全表扫描，
        // 会把几千条 title/first_user_message 同步拉进主进程。
        const useFilter = wanted.length > 0 && wanted.length <= MAX_QUERY_IDS;
        const sql = [
          'SELECT id, title,',
          columns.has('name') ? 'name,' : 'NULL AS name,',
          columns.has('first_user_message')
            ? 'first_user_message,'
            : 'NULL AS first_user_message,',
          columns.has('updated_at') ? 'updated_at' : '0 AS updated_at',
          'FROM threads',
          useFilter ? `WHERE id IN (${wanted.map(() => '?').join(',')})` : ''
        ].join(' ');
        const statement = db.prepare(sql);
        const rows = (useFilter ? statement.all(...wanted) : statement.all()) as ThreadTitleRow[];
        for (const row of rows) {
          const id = cleanText(row.id, 200);
          const name = cleanText(row.name, 4_000);
          const title = cleanText(row.title, 4_000);
          const firstUserMessage = cleanText(row.first_user_message, 4_000);
          const display = name || (title && title !== firstUserMessage ? title : undefined);
          if (!id || !display) continue;
          const updatedAt = typeof row.updated_at === 'number' && Number.isFinite(row.updated_at)
            ? row.updated_at
            : 0;
          const existing = next.get(id);
          if (!existing || updatedAt >= existing.updatedAt) {
            next.set(id, { title: display, updatedAt });
          }
        }
      } catch {
        // A busy, old, or partially migrated Codex database must never block Trace.
      } finally {
        db?.close();
      }
    }

    // If every existing database was temporarily unreadable, keep the last
    // successful snapshot instead of making titles flicker.
    if (opened > 0 || dbPaths.every(dbPath => !fs.existsSync(dbPath))) {
      this.cached = next;
      this.covered = new Set(wanted);
    }
  }
}

function codexThreadId(session: TapSessionSummary): string | undefined {
  if (session.source !== 'codex-cli' && session.source !== 'codex-vscode') return undefined;
  const key = (session.clientConversationKey || '').trim();
  const prefix = `${session.source}:`;
  if (!key.startsWith(prefix)) return undefined;
  const id = key.slice(prefix.length).trim();
  return id && id.length <= 200 ? id : undefined;
}

function stateDbPaths(
  codexHome: string,
  configText: string,
  env: NodeJS.ProcessEnv
): string[] {
  const configured = readTomlTopLevelString(rootToml(configText), 'sqlite_home')?.trim();
  const envHome = env.CODEX_SQLITE_HOME?.trim();
  const homes = [codexHome, configured, envHome].flatMap(value => {
    if (!value) return [];
    return [path.isAbsolute(value) ? value : path.resolve(codexHome, value)];
  });
  return [...new Set(homes.map(home => path.resolve(home, STATE_DB_NAME)))];
}

function threadColumns(db: Database): Set<string> {
  const table = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'threads'"
  ).get();
  if (!table) return new Set();
  const columns = db.prepare('PRAGMA table_info(threads)').all() as Array<{ name?: unknown }>;
  return new Set(columns.flatMap(column =>
    typeof column.name === 'string' ? [column.name] : []
  ));
}

function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : undefined;
}
