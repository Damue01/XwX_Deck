/**
 * XwX Trace 客户端配置改写器：apply（启用监听）、restore（关闭监听）。
 *
 * 跟 detector 一样，纯函数 + 文件 I/O 分离。fileOps 可以注入便于单测。
 */

import * as fs from 'fs';
import { promisify } from 'util';
import {
  ClaudeDetection,
  CodexDetection,
  CODEX_STABLE_PROVIDER
} from './clientConfig';
import {
  ensureTomlSection,
  findTomlSection,
  readTomlBooleanKey,
  readTomlStringKey,
  readTomlTopLevelString,
  removeTomlBooleanKey,
  removeTomlStringKey,
  setTomlBooleanKey,
  setTomlStringKey
} from './toml';
import {
  ClientBackupRecord,
  ClientBackupStore,
  ClientManagedField,
  ClientManagedValue,
  FieldSafeClientBackupRecord
} from './clientBackupStore';
import { writeFileAtomic } from '../shared/fsx';
import { isRecord } from '../shared/obj';

const unlink = promisify(fs.unlink);

export { CODEX_STABLE_PROVIDER };
export const CODEX_TRACE_PROVIDER = CODEX_STABLE_PROVIDER;
const CODEX_TRACE_PROVIDER_SECTION = `[model_providers.${CODEX_TRACE_PROVIDER}]`;

export interface ApplyClaudeInput {
  readonly detection: ClaudeDetection;
  readonly localProxyUrl: string;
  readonly now?: Date;
}

export interface ApplyCodexInput {
  readonly detection: CodexDetection;
  /** 本地代理 base URL（不含 /v1）。Codex 写入时会自动追加 `/v1`。 */
  readonly localProxyUrl: string;
  readonly now?: Date;
}

export interface ClientWriterOptions {
  /** 注入点：写入前先把当前文件全文存进 backup store。 */
  readonly backup: ClientBackupStore;
}

export interface ClientRestoreResult {
  readonly client: 'claude' | 'codex';
  readonly restoredFields: number;
  readonly conflicts: readonly string[];
}

export class ClientConfigWriter {
  constructor(private readonly options: ClientWriterOptions) {}

  async applyClaude(input: ApplyClaudeInput): Promise<void> {
    const { detection, localProxyUrl } = input;
    const original = await readConfigText(detection.configPath);
    if (original === undefined) {
      throw new Error(`XwX Deck 无法接管 Claude：找不到 ${detection.configPath}`);
    }
    const next = patchClaudeSettings(original, localProxyUrl);
    if (next === undefined) {
      throw new Error(`XwX Deck 无法接管 Claude：${detection.configPath} 不是有效的 JSON`);
    }
    const fields = claudeManagedFields(original, localProxyUrl);
    await this.options.backup.write({
      version: 2,
      client: 'claude',
      configPath: detection.configPath,
      fileExisted: true,
      originalContent: original,
      writtenContent: next,
      fields,
      writtenLocalUrl: localProxyUrl,
      writtenAt: (input.now ?? new Date()).toISOString()
    });
    try {
      await writeIfUnchanged(detection.configPath, original, next);
    } catch (err) {
      await this.options.backup.remove('claude');
      throw err;
    }
  }

  async applyCodex(input: ApplyCodexInput): Promise<void> {
    const { detection, localProxyUrl } = input;
    const original = await readConfigText(detection.configPath);
    const localProxyValue = codexProxyValue(detection, localProxyUrl);
    // 无 config.toml 时从空串起手创建；backup 记 originalContent=undefined，
    // restore 时会删掉这个 XwX 创建的文件（见 ClientConfigWriter.restore）。
    const base = original ?? '';
    const next = patchCodexConfig(base, detection, localProxyValue);
    const fields = codexManagedFields(base, detection, localProxyValue);
    await this.options.backup.write({
      version: 2,
      client: 'codex',
      configPath: detection.configPath,
      fileExisted: original !== undefined,
      originalContent: original,
      writtenContent: next,
      fields,
      writtenLocalUrl: localProxyUrl,
      writtenAt: (input.now ?? new Date()).toISOString()
    });
    try {
      await writeIfUnchanged(detection.configPath, original, next);
    } catch (err) {
      await this.options.backup.remove('codex');
      throw err;
    }
  }

  /** 字段级三方合并：只还原当前值仍等于 XwX 写入值的字段。 */
  async restore(record: ClientBackupRecord): Promise<ClientRestoreResult> {
    const result = record.version === 2
      ? await restoreFieldSafeRecord(record)
      : await restoreLegacyRecord(record);
    await this.options.backup.remove(record.client);
    return result;
  }
}

function claudeManagedFields(
  original: string,
  localProxyUrl: string
): ClientManagedField[] {
  const data = JSON.parse(original) as Record<string, unknown>;
  const env = isRecord(data.env) ? data.env : {};
  const written: Record<string, string> = { ANTHROPIC_BASE_URL: localProxyUrl };
  return Object.entries(written).map(([key, writtenValue]) => ({
    format: 'json-env',
    key,
    previous: captureValue(env, key),
    writtenValue
  }));
}

function codexManagedFields(original: string, detection: CodexDetection, writtenValue: string): ClientManagedField[] {
  if (detection.routeKind === 'chatgpt-oauth') {
    const sectionExisted = !!findTomlSection(original, CODEX_TRACE_PROVIDER_SECTION);
    return [
      tomlStringManagedField(original, 'model_provider', CODEX_TRACE_PROVIDER),
      tomlStringManagedField(original, 'name', 'XwX Deck', CODEX_TRACE_PROVIDER_SECTION, !sectionExisted),
      tomlStringManagedField(original, 'base_url', writtenValue, CODEX_TRACE_PROVIDER_SECTION),
      tomlStringManagedField(original, 'wire_api', 'responses', CODEX_TRACE_PROVIDER_SECTION),
      tomlBooleanManagedField(original, 'requires_openai_auth', true, CODEX_TRACE_PROVIDER_SECTION),
      tomlBooleanManagedField(original, 'supports_websockets', true, CODEX_TRACE_PROVIDER_SECTION)
    ];
  }
  const sectionHeader = detection.fieldLocation === 'provider-section'
    ? `[model_providers.${detection.provider}]`
    : undefined;
  const key = codexConfigKey(detection);
  return [tomlStringManagedField(original, key, writtenValue, sectionHeader)];
}

function tomlStringManagedField(
  original: string,
  key: string,
  writtenValue: string,
  sectionHeader?: string,
  removeSectionIfEmpty = false
): ClientManagedField {
  const previousValue = sectionHeader
    ? readTomlStringKey(sectionText(original, sectionHeader), key)
    : readTomlTopLevelString(original, key);
  return {
    format: 'toml-string',
    key,
    sectionHeader,
    previous: previousValue === undefined ? { present: false } : { present: true, value: previousValue },
    writtenValue,
    removeSectionIfEmpty
  };
}

function tomlBooleanManagedField(
  original: string,
  key: string,
  writtenValue: boolean,
  sectionHeader: string
): ClientManagedField {
  const previousValue = readTomlBooleanKey(sectionText(original, sectionHeader), key);
  return {
    format: 'toml-boolean',
    key,
    sectionHeader,
    previous: previousValue === undefined ? { present: false } : { present: true, value: previousValue },
    writtenValue
  };
}

async function restoreFieldSafeRecord(record: FieldSafeClientBackupRecord): Promise<ClientRestoreResult> {
  const current = await readConfigText(record.configPath);
  if (current === undefined) {
    return {
      client: record.client,
      restoredFields: 0,
      conflicts: record.fileExisted ? ['配置文件已被外部删除，已保留删除结果'] : []
    };
  }
  if (!record.fileExisted && current === record.writtenContent) {
    await unlinkIfUnchanged(record.configPath, current);
    return { client: record.client, restoredFields: record.fields.length, conflicts: [] };
  }
  return record.client === 'claude'
    ? restoreClaudeFields(record, current)
    : restoreCodexFields(record, current);
}

async function restoreClaudeFields(
  record: FieldSafeClientBackupRecord,
  current: string
): Promise<ClientRestoreResult> {
  let data: unknown;
  try { data = JSON.parse(current); }
  catch {
    return { client: 'claude', restoredFields: 0, conflicts: ['settings.json 已被改成无效 JSON，未覆盖外部内容'] };
  }
  if (!isRecord(data)) {
    return { client: 'claude', restoredFields: 0, conflicts: ['settings.json 顶层格式已变化，未覆盖外部内容'] };
  }
  const env = isRecord(data.env) ? { ...data.env } : {};
  const conflicts: string[] = [];
  let restoredFields = 0;
  for (const field of record.fields.filter(item => item.format === 'json-env')) {
    const currentValue = captureValue(env, field.key);
    if (currentValue.present && currentValue.value === field.writtenValue) {
      restoreValue(env, field.key, field.previous);
      restoredFields += 1;
    } else if (!managedValuesEqual(currentValue, field.previous)) {
      conflicts.push(`${field.key} 已被外部修改，保留当前值`);
    }
  }
  if (restoredFields > 0) {
    const next: Record<string, unknown> = { ...data };
    if (Object.keys(env).length > 0) next.env = env;
    else delete next.env;
    await writeIfUnchanged(record.configPath, current, formatJson(next, current));
  }
  return { client: 'claude', restoredFields, conflicts };
}

async function restoreCodexFields(
  record: FieldSafeClientBackupRecord,
  current: string
): Promise<ClientRestoreResult> {
  const conflicts: string[] = [];
  let restoredFields = 0;
  let next = current;
  for (const field of record.fields.filter(item => item.format === 'toml-string' || item.format === 'toml-boolean')) {
    const fragment = field.sectionHeader ? sectionText(next, field.sectionHeader) : next;
    const value = field.format === 'toml-boolean'
      ? readTomlBooleanKey(fragment, field.key)
      : field.sectionHeader
        ? readTomlStringKey(fragment, field.key)
        : readTomlTopLevelString(fragment, field.key);
    const currentValue = value === undefined ? { present: false } : { present: true, value };
    if (value === field.writtenValue) {
      if (field.format === 'toml-boolean') {
        next = field.previous.present
          ? setTomlBooleanKey(next, field.key, field.previous.value === true, { sectionHeader: field.sectionHeader }).text
          : removeTomlBooleanKey(next, field.key, field.sectionHeader).text;
      } else {
        next = field.previous.present
          ? setTomlStringKey(next, field.key, String(field.previous.value ?? ''), { sectionHeader: field.sectionHeader }).text
          : removeTomlStringKey(next, field.key, field.sectionHeader).text;
      }
      restoredFields += 1;
    } else if (!managedValuesEqual(currentValue, field.previous)) {
      conflicts.push(`${field.sectionHeader ? `${field.sectionHeader}.` : ''}${field.key} 已被外部修改，保留当前值`);
    }
  }
  for (const sectionHeader of new Set(record.fields.filter(field => field.removeSectionIfEmpty).map(field => field.sectionHeader))) {
    if (sectionHeader) next = removeEmptyTomlSection(next, sectionHeader);
  }
  if (!record.fileExisted && next.trim() === '') {
    await unlinkIfUnchanged(record.configPath, current);
  } else if (next !== current) {
    await writeIfUnchanged(record.configPath, current, next);
  }
  return { client: 'codex', restoredFields, conflicts };
}

async function restoreLegacyRecord(record: Extract<ClientBackupRecord, { version: 1 }>): Promise<ClientRestoreResult> {
  const current = await readConfigText(record.configPath);
  if (current === undefined) {
    return { client: record.client, restoredFields: 0, conflicts: record.originalContent === undefined ? [] : ['配置文件已被外部删除'] };
  }
  if (record.client === 'claude') {
    const original = parseJsonRecord(record.originalContent);
    const active = parseJsonRecord(current);
    if (!active) return { client: 'claude', restoredFields: 0, conflicts: ['旧版备份遇到无效 JSON，未覆盖外部内容'] };
    const env = isRecord(active.env) ? { ...active.env } : {};
    if (env.ANTHROPIC_BASE_URL !== record.writtenLocalUrl) {
      return { client: 'claude', restoredFields: 0, conflicts: ['ANTHROPIC_BASE_URL 已被外部修改，保留当前值'] };
    }
    const originalEnv = original && isRecord(original.env) ? original.env : {};
    restoreValue(env, 'ANTHROPIC_BASE_URL', captureValue(originalEnv, 'ANTHROPIC_BASE_URL'));
    const next = { ...active, ...(Object.keys(env).length ? { env } : {}) };
    if (!Object.keys(env).length) delete next.env;
    await writeIfUnchanged(record.configPath, current, formatJson(next, current));
    return { client: 'claude', restoredFields: 1, conflicts: [] };
  }
  return restoreLegacyCodex(record, current);
}

async function restoreLegacyCodex(
  record: Extract<ClientBackupRecord, { version: 1; client: 'codex' }> | Extract<ClientBackupRecord, { version: 1 }>,
  current: string
): Promise<ClientRestoreResult> {
  const localWithV1 = ensureSuffix(record.writtenLocalUrl, '/v1');
  const provider = readTomlTopLevelString(current, 'model_provider')?.trim() || 'openai';
  const sectionHeader = `[model_providers.${provider}]`;
  const sectionValue = readTomlStringKey(sectionText(current, sectionHeader), 'base_url');
  const topValue = readTomlTopLevelString(current, 'openai_base_url');
  const original = record.originalContent ?? '';
  let next = current;
  if (sectionValue === localWithV1) {
    const previous = readTomlStringKey(sectionText(original, sectionHeader), 'base_url');
    next = previous === undefined
      ? removeTomlStringKey(next, 'base_url', sectionHeader).text
      : setTomlStringKey(next, 'base_url', previous, { sectionHeader }).text;
  } else if (topValue === localWithV1) {
    const previous = readTomlTopLevelString(original, 'openai_base_url');
    next = previous === undefined
      ? removeTomlStringKey(next, 'openai_base_url').text
      : setTomlStringKey(next, 'openai_base_url', previous).text;
  } else {
    return { client: 'codex', restoredFields: 0, conflicts: ['旧版受管 base_url 已被外部修改，保留当前值'] };
  }
  if (record.originalContent === undefined && next.trim() === '') {
    await unlinkIfUnchanged(record.configPath, current);
  } else {
    await writeIfUnchanged(record.configPath, current, next);
  }
  return { client: 'codex', restoredFields: 1, conflicts: [] };
}

function parseJsonRecord(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : undefined;
  } catch { return undefined; }
}

function captureValue(record: Record<string, unknown>, key: string): ClientManagedValue {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? { present: true, value: record[key] }
    : { present: false };
}

function restoreValue(record: Record<string, unknown>, key: string, previous: ClientManagedValue): void {
  if (previous.present) record[key] = previous.value;
  else delete record[key];
}

function managedValuesEqual(left: ClientManagedValue, right: ClientManagedValue): boolean {
  return left.present === right.present && (!left.present || left.value === right.value);
}

function sectionText(text: string, header: string): string {
  const section = findTomlSection(text, header);
  return section ? text.slice(section.start, section.end) : '';
}

function formatJson(value: Record<string, unknown>, original: string): string {
  const text = JSON.stringify(value, null, indentOf(original));
  return original.includes('\r\n') ? `${text.replace(/\n/g, '\r\n')}\r\n` : `${text}\n`;
}

async function readConfigText(file: string): Promise<string | undefined> {
  try {
    const text = await fs.promises.readFile(file, 'utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeIfUnchanged(file: string, expected: string | undefined, next: string): Promise<void> {
  const current = await readConfigText(file);
  if (current !== expected) {
    throw new Error(`配置文件在 XwX Deck 写入前被其他软件修改，已停止以避免覆盖：${file}`);
  }
  await writeFileAtomic(file, next);
}

async function unlinkIfUnchanged(file: string, expected: string): Promise<void> {
  const current = await readConfigText(file);
  if (current === undefined) return;
  if (current !== expected) {
    throw new Error(`配置文件在 XwX Deck 清理前被其他软件修改，已停止以避免覆盖：${file}`);
  }
  await unlink(file);
}

export function patchClaudeSettings(
  original: string,
  localProxyUrl: string
): string | undefined {
  let data: unknown;
  try { data = JSON.parse(original); } catch { return undefined; }
  if (!isRecord(data)) return undefined;
  const env = isRecord(data.env) ? { ...(data.env as Record<string, unknown>) } : {};
  env.ANTHROPIC_BASE_URL = localProxyUrl;
  // CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC 是 globalOfficial 也会写的标记，
  // 但 XwX Trace 不应主动设——监听期间不影响 nonessential 流量更接近用户原意。
  const next: Record<string, unknown> = { ...data, env };
  // 保留原文 EOL 风格：JSON.stringify 总是用 \n，文件原本是 \r\n 的话尽量贴回去。
  const text = JSON.stringify(next, null, indentOf(original));
  return original.includes('\r\n') ? text.replace(/\n/g, '\r\n') + (original.endsWith('\n') ? '' : '\r\n')
                                   : text + (original.endsWith('\n') ? '' : '\n');
}

export function patchCodexConfig(original: string, detection: CodexDetection, localProxyValue: string): string {
  if (detection.routeKind === 'chatgpt-oauth') {
    let next = setTomlStringKey(original, 'model_provider', CODEX_TRACE_PROVIDER).text;
    next = ensureTomlSection(next, CODEX_TRACE_PROVIDER_SECTION);
    next = setTomlStringKey(next, 'name', 'XwX Deck', { sectionHeader: CODEX_TRACE_PROVIDER_SECTION }).text;
    next = setTomlStringKey(next, 'base_url', localProxyValue, { sectionHeader: CODEX_TRACE_PROVIDER_SECTION }).text;
    next = setTomlStringKey(next, 'wire_api', 'responses', { sectionHeader: CODEX_TRACE_PROVIDER_SECTION }).text;
    next = setTomlBooleanKey(next, 'requires_openai_auth', true, { sectionHeader: CODEX_TRACE_PROVIDER_SECTION }).text;
    return setTomlBooleanKey(next, 'supports_websockets', true, { sectionHeader: CODEX_TRACE_PROVIDER_SECTION }).text;
  }
  const key = codexConfigKey(detection);
  if (detection.fieldLocation !== 'provider-section') {
    return setTomlStringKey(original, key, localProxyValue).text;
  }
  return setTomlStringKey(original, key, localProxyValue, {
    sectionHeader: `[model_providers.${detection.provider}]`
  }).text;
}

function codexConfigKey(detection: CodexDetection): 'base_url' | 'openai_base_url' | 'chatgpt_base_url' {
  if (detection.fieldLocation === 'provider-section') return 'base_url';
  return detection.fieldLocation === 'chatgpt-base-url' ? 'chatgpt_base_url' : 'openai_base_url';
}

function codexProxyValue(detection: CodexDetection, localProxyUrl: string): string {
  const base = localProxyUrl.replace(/\/+$/, '');
  if (detection.routeKind === 'chatgpt-oauth') return `${base}/backend-api/codex`;
  return detection.fieldLocation === 'chatgpt-base-url'
    ? `${base}/backend-api/`
    : ensureSuffix(base, '/v1');
}

function removeEmptyTomlSection(text: string, header: string): string {
  const section = findTomlSection(text, header);
  if (!section) return text;
  const body = text.slice(section.start, section.end).replace(/^\s*\[[^\]]+\]\s*(?:\r?\n|$)/, '');
  if (body.trim()) return text;
  return text.slice(0, section.start) + text.slice(section.end);
}

function indentOf(jsonText: string): number {
  const m = /\n( +)/.exec(jsonText);
  if (!m) return 2;
  return Math.min(m[1].length, 4) || 2;
}

function ensureSuffix(url: string, suffix: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.endsWith(suffix) ? trimmed : trimmed + suffix;
}
