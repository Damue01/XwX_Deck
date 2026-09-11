import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { writeFileAtomic } from '../shared/fsx';
import { CODEX_STABLE_PROVIDER } from './clientConfig';
import { findTomlSection, rootToml } from './toml';

type Value = string | number | boolean | null;
interface Entry { before: Value; written: Value }
interface Ledger { version: 1; configPath: string; fields: Record<string, Entry> }
const provider = `model_providers.${CODEX_STABLE_PROVIDER}`;
export const DIRECT_PROVIDER_FIELDS = ['name', 'base_url', 'wire_api', 'requires_openai_auth', 'supports_websockets', 'experimental_bearer_token', 'env_key', 'env_key_instructions'].map(key => `${provider}.${key}`);
const allowed = new Set([
  'model_provider', 'model', 'model_context_window', 'model_auto_compact_token_limit',
  'model_catalog_json', 'service_tier', 'features.js_repl', 'features.image_gen',
  'features.image_generation', 'features.imagegenext', ...DIRECT_PROVIDER_FIELDS
]);

/** Only explicit writes made by this product establish ownership. No legacy
 * aliases, external provider sections, or full-file restoration are accepted. */
export class CodexDirectRestore {
  private readonly file: string;
  constructor(userDataDir: string) { this.file = path.join(userDataDir, 'codex-direct-restore.json'); }

  async write(configPath: string, before: string | undefined, next: string, explicit: readonly string[], publish: () => Promise<void>): Promise<void> {
    const previous = await readOwnedText(this.file);
    const state = this.parse(previous, configPath) ?? { version: 1 as const, configPath, fields: {} };
    const original = values(before ?? '');
    const written = values(next);
    const fields = { ...state.fields };
    for (const key of allowed) {
      if (original[key] === written[key] && !explicit.includes(key)) continue;
      const prior = fields[key];
      fields[key] = { before: prior && original[key] === prior.written ? prior.before : original[key], written: written[key] };
    }
    const staged = JSON.stringify({ version: 1, configPath, fields }, null, 2) + '\n';
    await writeFileAtomic(this.file, staged);
    try { await publish(); }
    catch (error) {
      // Never undo a concurrent writer. If our config write reached disk,
      // restore precisely its preimage before rolling the ownership record back.
      const errors: unknown[] = [error];
      try {
        if (await readOwnedText(configPath) === next) await restoreFile(configPath, before);
        if (await readOwnedText(this.file) === staged) await restoreFile(this.file, previous);
      } catch (rollbackError) { errors.push(rollbackError); }
      if (errors.length > 1) throw new AggregateError(errors, 'ChatGPT 配置写入与回滚失败；恢复记录已保留。');
      throw error;
    }
  }

  async restore(configPath: string, target: (baseline: string) => string, publish: (before: string, next: string) => Promise<void>): Promise<{ restoredFields: number; conflicts: string[] }> {
    const record = await readOwnedText(this.file);
    const state = this.parse(record, configPath);
    if (!state) return { restoredFields: 0, conflicts: [] };
    const current = await readOwnedText(configPath);
    if (current === undefined) return { restoredFields: 0, conflicts: ['ChatGPT 配置已被外部删除，保留恢复记录'] };
    let baseline = current;
    for (const [key, entry] of Object.entries(state.fields)) baseline = put(baseline, key, entry.before);
    const desired = values(target(baseline));
    const live = values(current);
    const conflicts: string[] = [];
    let next = current;
    let restoredFields = 0;
    for (const [key, entry] of Object.entries(state.fields)) {
      if (live[key] === desired[key]) continue;
      if (live[key] !== entry.written) { conflicts.push(`${key} 已被外部修改，保留当前值`); continue; }
      next = put(next, key, desired[key]);
      restoredFields++;
    }
    // Keep unresolved entries for review/retry. Rebase successful entries to
    // their restored values so a later attempt cannot mistake them for drift.
    const remaining = Object.fromEntries(Object.entries(state.fields).filter(([key]) => conflicts.some(c => c.startsWith(`${key} `))));
    try {
      if (next !== current) await publish(current, next);
      if (await readOwnedText(this.file) !== record) throw new Error('恢复记录已发生变化，已停止恢复。');
      if (Object.keys(remaining).length) await writeFileAtomic(this.file, JSON.stringify({ ...state, fields: remaining }, null, 2) + '\n');
      else await fs.rm(this.file, { force: true });
    } catch (error) {
      const errors: unknown[] = [error];
      try { if (next !== current && await readOwnedText(configPath) === next) await writeFileAtomic(configPath, current); }
      catch (rollbackError) { errors.push(rollbackError); }
      if (errors.length > 1) throw new AggregateError(errors, 'ChatGPT 直连恢复与回滚失败；恢复记录已保留。');
      throw error;
    }
    return { restoredFields, conflicts };
  }

  private parse(text: string | undefined, configPath: string): Ledger | undefined {
    if (text === undefined) return undefined;
    try {
      const value = JSON.parse(text) as Ledger;
      if (value.version !== 1 || value.configPath !== configPath || !value.fields || Array.isArray(value.fields) || typeof value.fields !== 'object') throw new Error();
      for (const [key, entry] of Object.entries(value.fields)) {
        if (!allowed.has(key) || !entry || !validValue(entry.before) || !validValue(entry.written)) throw new Error();
      }
      return value;
    } catch { throw new Error('ChatGPT 恢复记录无效或配置目录已变化，已停止写入。'); }
  }
}

function validValue(value: unknown): value is Value {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isSafeInteger(value);
}
function values(text: string): Record<string, Value> {
  const parsed = parseToml(text) as Record<string, unknown>;
  return Object.fromEntries([...allowed].map(key => {
    let value: unknown = parsed;
    for (const segment of key.split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined;
    if (value !== undefined && !validValue(value)) throw new Error(`无法安全恢复配置字段 ${key}。`);
    return [key, value ?? null];
  }));
}
// Touch one primitive assignment, preserving every other byte. Refuse dotted,
// multiline, or otherwise unfamiliar spellings instead of rewriting the file.
function put(text: string, field: string, value: Value): string {
  if (values(text)[field] === value) return text;
  const segments = field.split('.');
  const key = segments.pop()!;
  const header = segments.length ? `[${segments.join('.')}]` : undefined;
  const section = header ? findTomlSection(text, header) : { start: 0, end: rootToml(text).length };
  const start = section?.start ?? text.length;
  const end = section?.end ?? text.length;
  const part = text.slice(start, end);
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*=.*(?:\\r?\\n|$)`, 'm');
  const found = re.exec(part);
  const encoded = value === null ? '' : `${key} = ${JSON.stringify(value)}\n`;
  let replacement: string;
  if (found) replacement = part.slice(0, found.index) + encoded + part.slice(found.index + found[0].length);
  else {
    if (values(text)[field] !== null) throw new Error(`配置字段 ${field} 使用了不支持的写法，未修改。`);
    if (value === null) return text;
    replacement = part + (part && !part.endsWith('\n') ? '\n' : '') + (!section && header ? `\n${header}\n` : '') + encoded;
  }
  const next = text.slice(0, start) + replacement + text.slice(end);
  if (values(next)[field] !== value) throw new Error(`配置字段 ${field} 恢复校验失败。`);
  return next;
}
async function restoreFile(file: string, text: string | undefined): Promise<void> {
  if (text === undefined) await fs.rm(file, { force: true });
  else await writeFileAtomic(file, text);
}

async function readOwnedText(file: string): Promise<string | undefined> {
  try { const text = await fs.readFile(file, 'utf8'); return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
