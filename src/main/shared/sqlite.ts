import { backup as backupNativeDatabase, DatabaseSync } from 'node:sqlite';
import type { DatabaseSync as NativeDatabase, StatementSync as NativeStatement } from 'node:sqlite';

// Electron already ships SQLite through Node. Keeping this tiny adapter avoids
// loading a second native addon from a portable app's transient extraction
// directory, while preserving the small better-sqlite3-shaped API used here.
export interface DatabaseOptions {
  readonly readonly?: boolean;
  readonly fileMustExist?: boolean;
  readonly timeout?: number;
}

export interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export class SqliteStatement {
  constructor(private readonly statement: NativeStatement) {}

  get(...params: unknown[]): unknown {
    return this.statement.get(...params);
  }

  all(...params: unknown[]): unknown[] {
    return this.statement.all(...params);
  }

  run(...params: unknown[]): RunResult {
    const result = this.statement.run(...params);
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }
}

export default class Database {
  private readonly database: NativeDatabase;

  constructor(path: string, options: DatabaseOptions = {}) {
    this.database = new DatabaseSync(path, {
      readOnly: options.readonly === true,
      ...(options.timeout === undefined ? {} : { timeout: options.timeout })
    });
  }

  close(): void {
    this.database.close();
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database.prepare(sql));
  }

  transaction<T>(action: () => T): () => T {
    return () => {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const result = action();
        this.database.exec('COMMIT');
        return result;
      } catch (error) {
        try { this.database.exec('ROLLBACK'); } catch { /* preserve the original error */ }
        throw error;
      }
    };
  }

  async backup(path: string): Promise<void> {
    await backupNativeDatabase(this.database, path);
  }
}
