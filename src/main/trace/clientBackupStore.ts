/**
 * 临时改写 ~/.claude/settings.json 和 ~/.codex/config.toml 的备份/还原记录。
 *
 * 行为模型：
 *   - 启用 XwX Trace：先把当前文件内容（或缺失的事实）存一份快照到
 *     globalStorage/xwx-trace-client-backup/<client>.json，然后改写源文件。
 *   - 关闭 XwX Trace：读快照 → 对 XwX 写过的字段做三方合并 → 删快照。
 *   - 启动 XwX Deck：扫快照目录，如果快照里记录的 writtenLocalUrl 端口已死，
 *     恢复源文件并删快照（启动自愈，跟 tapPortLock 同思路）。
 *
 * 设计要点：
 *   - 与 globalOfficial 的 compatible-global-backup 完全独立。两者用途正交：
 *     globalOfficial 长期把 CLI 指向 兼容服务；XwX Trace 临时指向本地代理。
 *     合并会让职责互相污染。
 *   - v2 同时记录原值、XwX 写入值与字段位置。只有当前值仍等于 XwX 写入值时才
 *     恢复原值；用户或其他软件在 Trace 期间写入的新值永远优先保留。
 */

import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { writeFileAtomic } from '../shared/fsx';

const readFile = promisify(fs.readFile);
const unlink = promisify(fs.unlink);
const readdir = promisify(fs.readdir);

export type ClientBackupKind = 'claude' | 'codex';

export interface ClientManagedValue {
  readonly present: boolean;
  readonly value?: unknown;
}

export interface ClientManagedField {
  readonly format: 'json-env' | 'toml-string' | 'toml-boolean';
  readonly key: string;
  readonly sectionHeader?: string;
  readonly previous: ClientManagedValue;
  readonly writtenValue: string | boolean;
  /** Remove a section created only for Trace after all of its managed keys are gone. */
  readonly removeSectionIfEmpty?: boolean;
}

/** 旧版整文件快照。读取仅用于兼容已经留在磁盘上的崩溃恢复记录。 */
export interface LegacyClientBackupRecord {
  readonly version: 1;
  readonly client: ClientBackupKind;
  readonly configPath: string;
  readonly originalContent: string | undefined;
  readonly writtenLocalUrl: string;
  readonly writtenAt: string;
}

/** 当前字段级三方合并记录。 */
export interface FieldSafeClientBackupRecord {
  readonly version: 2;
  readonly client: ClientBackupKind;
  readonly configPath: string;
  readonly fileExisted: boolean;
  readonly originalContent: string | undefined;
  readonly writtenContent: string;
  readonly fields: readonly ClientManagedField[];
  /** 仅用于启动自愈时探活判断「这个备份对应的代理还活着吗」。 */
  readonly writtenLocalUrl: string;
  readonly writtenAt: string;
}

export type ClientBackupRecord = LegacyClientBackupRecord | FieldSafeClientBackupRecord;

const SUBDIR = 'xwx-trace-client-backup';

export class ClientBackupStore {
  constructor(private readonly storageDir: string) {}

  dir(): string {
    return path.join(this.storageDir, SUBDIR);
  }

  recordPath(client: ClientBackupKind): string {
    return path.join(this.dir(), `${client}.json`);
  }

  async write(record: ClientBackupRecord): Promise<void> {
    const payload = JSON.stringify(record, null, 2);
    await writeFileAtomic(this.recordPath(record.client), payload);
  }

  async read(client: ClientBackupKind): Promise<ClientBackupRecord | undefined> {
    try {
      const text = await readFile(this.recordPath(client), 'utf8');
      const data = JSON.parse(text) as ClientBackupRecord;
      if ((data?.version === 1 || data?.version === 2)
        && (data.client === 'claude' || data.client === 'codex')) {
        return data;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async remove(client: ClientBackupKind): Promise<void> {
    try {
      await unlink(this.recordPath(client));
    } catch {
      /* already gone */
    }
  }

  /** 列出磁盘上所有已知 backup（用于启动自愈）。 */
  async listAll(): Promise<ClientBackupRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir());
    } catch {
      return [];
    }
    const out: ClientBackupRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const client = name.replace(/\.json$/i, '') as ClientBackupKind;
      const rec = await this.read(client);
      if (rec) out.push(rec);
    }
    return out;
  }
}
