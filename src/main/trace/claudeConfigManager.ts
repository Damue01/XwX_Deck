import * as fs from 'fs';
import * as path from 'path';
import { ClaudeModelSettings } from '../app/settings';
import type { ModelCatalogEntry } from '../app/modelCatalog';
import { CLAUDE_MODEL_OVERRIDE_ENV_KEYS, claudeCompatibleServiceModelEnv } from '../app/claudeModelPolicy';
import { writeFileAtomic } from '../shared/fsx';
import { isRecord } from '../shared/obj';
import { claudeCloudProviderMode, ClientPaths, readClaudeSettingsBaseUrl, resolveClientPaths } from './clientConfig';

interface ManagedValue {
  readonly present: boolean;
  readonly value?: unknown;
}

interface ClaudeCompatibleServiceState {
  readonly version: 1;
  readonly enabled: true;
  readonly configPath: string;
  readonly fileExisted: boolean;
  readonly previous: Readonly<Record<string, ManagedValue>>;
  readonly written: Readonly<Record<string, string>>;
}

export interface ClaudeCompatibleServiceSnapshot {
  readonly enabled: boolean;
  readonly configPath: string;
  readonly status: 'disabled' | 'active' | 'drifted' | 'invalid' | 'path-mismatch';
  readonly expectedBaseUrl?: string;
  readonly actualBaseUrl?: string;
  readonly detail?: string;
}

export interface ClaudeCompatibleServiceUpdate {
  readonly nativeAnthropic?: boolean;
  readonly enabled: boolean;
  readonly baseUrl?: string;
  readonly bearerToken?: string;
  readonly models?: ClaudeModelSettings;
  readonly catalog?: readonly ModelCatalogEntry[];
}

const STATE_FILE = 'claude-compatible-state.json';
const MANAGED_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  // 兼容服务 uses Bearer auth. Keeping API_KEY beside AUTH_TOKEN produces an
  // auth conflict in Claude Code, so it is part of the reversible takeover.
  'ANTHROPIC_API_KEY',
  ...CLAUDE_MODEL_OVERRIDE_ENV_KEYS
] as const;

export class ClaudeConfigManager {
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly userDataDir: string,
    private readonly paths: ClientPaths | (() => ClientPaths) = resolveClientPaths
  ) {}

  async read(): Promise<ClaudeCompatibleServiceSnapshot> {
    return this.serialized(async () => {
      const configPath = this.clientPaths().claudeSettingsPath;
      return this.inspect(configPath, await readConfigText(configPath));
    });
  }

  /** Inspect the long-lived config hidden beneath a temporary Trace overlay. */
  async readFromContent(content: string | undefined): Promise<ClaudeCompatibleServiceSnapshot> {
    return this.serialized(async () => {
      const configPath = this.clientPaths().claudeSettingsPath;
      return this.inspect(configPath, content);
    });
  }

  async update(input: ClaudeCompatibleServiceUpdate): Promise<ClaudeCompatibleServiceSnapshot> {
    return this.serialized(() => input.enabled ? this.enable(input) : this.disable());
  }

  private async enable(input: ClaudeCompatibleServiceUpdate): Promise<ClaudeCompatibleServiceSnapshot> {
    const baseUrl = input.nativeAnthropic ? (input.baseUrl || '').trim().replace(/\/v1\/?$/, '') : claudeCompatibleServiceBaseUrl(input.baseUrl || '');
    const bearerToken = input.bearerToken?.trim() || '';
    if (!baseUrl) throw new Error('服务商地址不能为空。');
    if (!bearerToken) throw new Error('服务商密钥不能为空。');

    const configPath = this.clientPaths().claudeSettingsPath;
    const original = await readConfigText(configPath);
    const data = parseSettings(original);
    assertNoRuntimeOverride(data, baseUrl);
    const env = isRecord(data.env) ? { ...data.env } : {};
    const originalState = await readConfigText(this.statePath());
    const existingState = parseClaudeCompatibleServiceState(originalState);
    if (existingState?.enabled === true && existingState.configPath !== configPath) {
      throw new Error(`Claude 配置目录已变化；请先恢复原配置：${existingState.configPath}`);
    }
    const previous = existingState?.enabled === true && existingState.configPath === configPath
      ? captureMissingValues(existingState.previous, env)
      : captureValues(env);
    const written = buildWrittenValues(baseUrl, bearerToken, input.models, input.catalog, data.model);
    if (input.nativeAnthropic) { written.ANTHROPIC_AUTH_TOKEN = ''; written.ANTHROPIC_API_KEY = bearerToken; }
    for (const key of MANAGED_KEYS) {
      const value = written[key];
      if (value) env[key] = value;
      else delete env[key];
    }
    const nextContent = formatSettings({ ...data, env }, original);
    const nextState = {
      version: 1,
      enabled: true,
      configPath,
      fileExisted: existingState?.enabled === true ? existingState.fileExisted : original !== undefined,
      previous,
      written
    } satisfies ClaudeCompatibleServiceState;
    const nextStateContent = JSON.stringify(nextState, null, 2);

    await writeConfigIfUnchanged(configPath, original, nextContent);
    let stateWritten = false;
    try {
      await writeInternalStateIfUnchanged(this.statePath(), originalState, nextStateContent);
      stateWritten = true;
      const snapshot = await this.inspect(configPath, await readConfigText(configPath));
      if (!snapshot.enabled) throw new Error(snapshot.detail || 'Claude 配置写后校验失败。');
      return snapshot;
    } catch (error) {
      const rollbackErrors: Error[] = [];
      await restoreContentIfUnchanged(configPath, nextContent, original).catch(err => rollbackErrors.push(err as Error));
      if (stateWritten) {
        await restoreInternalStateIfUnchanged(this.statePath(), nextStateContent, originalState)
          .catch(err => rollbackErrors.push(err as Error));
      }
      if (rollbackErrors.length) {
        throw new AggregateError([error as Error, ...rollbackErrors], 'Claude 配置事务失败，且自动回滚未完全成功。');
      }
      throw error;
    }
  }

  private async disable(): Promise<ClaudeCompatibleServiceSnapshot> {
    const configPath = this.clientPaths().claudeSettingsPath;
    const originalState = await readConfigText(this.statePath());
    const state = parseClaudeCompatibleServiceState(originalState);
    if (!state) return disabledSnapshot(configPath);
    if (state.configPath !== configPath) {
      throw new Error(`Claude 配置目录已变化；为避免遗留密钥，未修改新目录。请恢复目录后重试：${state.configPath}`);
    }
    const original = await readConfigText(configPath);
    if (original === undefined) {
      if (state.fileExisted) {
        throw new Error('Claude 配置文件已被外部删除；恢复状态已保留。请先重新启用代理修复配置，再关闭代理。');
      }
      await removeInternalStateIfUnchanged(this.statePath(), originalState);
      return disabledSnapshot(configPath);
    }
    const data = parseSettings(original);
    const env = isRecord(data.env) ? { ...data.env } : {};
    for (const key of MANAGED_KEYS) {
      const expected = state.written[key];
      const present = Object.prototype.hasOwnProperty.call(env, key);
      if (expected ? env[key] !== expected : present) continue;
      const previous = state.previous[key];
      if (previous?.present) env[key] = previous.value;
      else delete env[key];
    }
    const next: Record<string, unknown> = { ...data };
    if (Object.keys(env).length) next.env = env;
    else delete next.env;
    const nextContent = !state.fileExisted && Object.keys(next).length === 0
      ? undefined
      : formatSettings(next, original);
    if (nextContent === undefined) {
      await removeIfUnchanged(configPath, original);
    } else {
      await writeConfigIfUnchanged(configPath, original, nextContent);
    }
    try {
      await removeInternalStateIfUnchanged(this.statePath(), originalState);
    } catch (error) {
      const rollbackErrors: Error[] = [];
      await restoreContentIfUnchanged(configPath, nextContent, original)
        .catch(err => rollbackErrors.push(err as Error));
      await restoreInternalStateAfterFailedRemoval(this.statePath(), originalState)
        .catch(err => rollbackErrors.push(err as Error));
      if (rollbackErrors.length) {
        throw new AggregateError([error as Error, ...rollbackErrors], 'Claude 配置关闭失败，且自动回滚未完全成功。');
      }
      throw error;
    }
    return disabledSnapshot(configPath);
  }

  private async inspect(configPath: string, content: string | undefined): Promise<ClaudeCompatibleServiceSnapshot> {
    const state = await this.readState();
    if (!state) return disabledSnapshot(configPath);
    if (state.configPath !== configPath) {
      return {
        enabled: false,
        status: 'path-mismatch',
        configPath,
        expectedBaseUrl: state.written.ANTHROPIC_BASE_URL,
        detail: `XwX Deck 记录的 Claude 配置位于 ${state.configPath}，当前生效目录已变化。`
      };
    }
    if (content === undefined) {
      return {
        enabled: false,
        status: 'drifted',
        configPath,
        expectedBaseUrl: state.written.ANTHROPIC_BASE_URL,
        detail: 'Claude 配置文件已被删除。'
      };
    }
    let data: Record<string, unknown>;
    try { data = parseSettings(content); }
    catch (error) {
      return {
        enabled: false,
        status: 'invalid',
        configPath,
        expectedBaseUrl: state.written.ANTHROPIC_BASE_URL,
        detail: (error as Error).message
      };
    }
    const env = isRecord(data.env) ? data.env : {};
    const drifted = Object.entries(state.written).filter(([key, expected]) => {
      const present = Object.prototype.hasOwnProperty.call(env, key);
      return expected ? !present || env[key] !== expected : present;
    }).map(([key]) => key);
    const actualBaseUrl = readClaudeSettingsBaseUrl(data);
    if (drifted.length) {
      return {
        enabled: false,
        status: 'drifted',
        configPath,
        expectedBaseUrl: state.written.ANTHROPIC_BASE_URL,
        actualBaseUrl,
        detail: `Claude 受管字段已漂移：${drifted.join('、')}`
      };
    }
    return {
      enabled: true,
      status: 'active',
      configPath,
      expectedBaseUrl: state.written.ANTHROPIC_BASE_URL,
      actualBaseUrl
    };
  }

  private statePath(): string {
    return path.join(this.userDataDir, STATE_FILE);
  }

  private async readState(): Promise<ClaudeCompatibleServiceState | undefined> {
    const content = await readConfigText(this.statePath());
    return parseClaudeCompatibleServiceState(content);
  }

  private clientPaths(): ClientPaths {
    return typeof this.paths === 'function' ? this.paths() : this.paths;
  }

  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operation.then(action, action);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

function parseSettings(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (isRecord(value)) return value;
  } catch { /* reported below */ }
  throw new Error('Claude settings.json 不是有效的 JSON，无法切换模型服务。');
}

function captureValues(env: Record<string, unknown>): Record<string, ManagedValue> {
  const previous: Record<string, ManagedValue> = {};
  for (const key of MANAGED_KEYS) {
    previous[key] = Object.prototype.hasOwnProperty.call(env, key)
      ? { present: true, value: env[key] }
      : { present: false };
  }
  return previous;
}

function captureMissingValues(
  previous: Readonly<Record<string, ManagedValue>>,
  env: Record<string, unknown>
): Record<string, ManagedValue> {
  const next = { ...previous };
  // Upgrade old state records without losing fields that earlier versions did
  // not manage. The first write after upgrading captures their live values.
  for (const key of MANAGED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(next, key)) continue;
    next[key] = Object.prototype.hasOwnProperty.call(env, key)
      ? { present: true, value: env[key] }
      : { present: false };
  }
  return next;
}

function buildWrittenValues(
  baseUrl: string,
  bearerToken: string,
  models: ClaudeModelSettings | undefined,
  catalog: readonly ModelCatalogEntry[] | undefined,
  selectedModel: unknown
): Record<string, string> {
  const configuredModels = claudeCompatibleServiceModelEnv(
    models ?? { fable: '', opus: '', sonnet: '', haiku: '' },
    catalog,
    selectedModel
  );
  const modelValues: Record<string, string> = {};
  for (const key of CLAUDE_MODEL_OVERRIDE_ENV_KEYS) {
    modelValues[key] = configuredModels[key] || '';
  }
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: bearerToken,
    ANTHROPIC_API_KEY: '',
    ...modelValues
  };
}

export function claudeCompatibleServiceBaseUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value.trim()); }
  catch { return ''; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  const rootPath = parsed.pathname
    .replace(/\/+$/, '')
    .replace(/\/(?:anthropic(?:\/v1)?|v1)$/i, '');
  parsed.pathname = `${rootPath}/anthropic`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function formatSettings(value: Record<string, unknown>, original: string | undefined): string {
  const indent = original ? Math.min(/\n( +)/.exec(original)?.[1].length || 2, 4) : 2;
  const text = JSON.stringify(value, null, indent);
  return original?.includes('\r\n') ? `${text.replace(/\n/g, '\r\n')}\r\n` : `${text}\n`;
}

function disabledSnapshot(configPath: string): ClaudeCompatibleServiceSnapshot {
  return { enabled: false, status: 'disabled', configPath };
}

function assertNoRuntimeOverride(data: Record<string, unknown>, expectedBaseUrl: string): void {
  const cloudMode = claudeCloudProviderMode(data, process.env);
  if (cloudMode) throw new Error(`Claude 当前启用了 ${cloudMode}，请先切换为普通 Anthropic 网关模式。`);
  const runtimeKeys = [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_FAST_MODEL'
  ] as const;
  const conflicts = runtimeKeys.filter(key => !!process.env[key]?.trim());
  if (conflicts.length) {
    const baseMatches = process.env.ANTHROPIC_BASE_URL?.trim() === expectedBaseUrl;
    const onlyMatchingBase = conflicts.length === 1 && conflicts[0] === 'ANTHROPIC_BASE_URL' && baseMatches;
    if (!onlyMatchingBase) {
      throw new Error(`Claude 接入失败：检测到环境变量 ${conflicts.join('、')}，本地配置已失效，请移除相关环境变量后重试。`);
    }
  }
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

async function writeConfigIfUnchanged(file: string, expected: string | undefined, next: string): Promise<void> {
  const current = await readConfigText(file);
  if (current !== expected) {
    throw new Error(`Claude 配置在写入前被其他软件修改，已停止以避免覆盖：${file}`);
  }
  await writeFileAtomic(file, next);
  if (await readConfigText(file) !== next) throw new Error(`Claude 配置写后校验失败：${file}`);
}

async function restoreContentIfUnchanged(file: string, expected: string | undefined, previous: string | undefined): Promise<void> {
  if (await readConfigText(file) !== expected) {
    throw new Error(`Claude 配置事务失败后又被外部修改，未自动覆盖：${file}`);
  }
  if (previous === undefined) await fs.promises.rm(file, { force: true });
  else await writeFileAtomic(file, previous);
}

async function restoreInternalStateIfUnchanged(
  file: string,
  expected: string | undefined,
  previous: string | undefined
): Promise<void> {
  if (await readConfigText(file) !== expected) {
    throw new Error('Claude 兼容服务 恢复状态被其他进程修改，未自动覆盖。');
  }
  if (previous === undefined) await fs.promises.rm(file, { force: true });
  else await writeFileAtomic(file, previous);
}

async function writeInternalStateIfUnchanged(
  file: string,
  expected: string | undefined,
  next: string
): Promise<void> {
  if (await readConfigText(file) !== expected) {
    throw new Error('Claude 兼容服务 恢复状态在写入前被其他进程修改，已停止。');
  }
  await writeFileAtomic(file, next);
  if (await readConfigText(file) !== next) throw new Error('Claude 兼容服务 恢复状态写后校验失败。');
}

async function removeInternalStateIfUnchanged(file: string, expected: string | undefined): Promise<void> {
  if (await readConfigText(file) !== expected) {
    throw new Error('Claude 兼容服务 恢复状态在关闭前被其他进程修改，已停止。');
  }
  await fs.promises.rm(file, { force: true });
  if (await readConfigText(file) !== undefined) throw new Error('Claude 兼容服务 恢复状态删除后校验失败。');
}

async function restoreInternalStateAfterFailedRemoval(file: string, original: string | undefined): Promise<void> {
  const current = await readConfigText(file);
  if (current === original) return;
  if (current !== undefined) {
    throw new Error('Claude 兼容服务 恢复状态在关闭失败后被其他进程修改，未自动覆盖。');
  }
  if (original !== undefined) await writeFileAtomic(file, original);
}

async function removeIfUnchanged(file: string, expected: string | undefined): Promise<void> {
  if (await readConfigText(file) !== expected) {
    throw new Error(`Claude 配置在删除前被其他软件修改，已停止以避免覆盖：${file}`);
  }
  await fs.promises.rm(file, { force: true });
}

function isClaudeCompatibleServiceState(value: unknown): value is ClaudeCompatibleServiceState {
  if (!isRecord(value)
    || value.version !== 1
    || value.enabled !== true
    || typeof value.configPath !== 'string'
    || typeof value.fileExisted !== 'boolean'
    || !isRecord(value.previous)
    || !isRecord(value.written)
    || typeof value.written.ANTHROPIC_BASE_URL !== 'string') {
    return false;
  }
  const validPrevious = Object.values(value.previous).every(item => (
    isRecord(item) && typeof item.present === 'boolean'
  ));
  const validWritten = Object.values(value.written).every(item => typeof item === 'string');
  return validPrevious && validWritten;
}

function parseClaudeCompatibleServiceState(content: string | undefined): ClaudeCompatibleServiceState | undefined {
  if (content === undefined) return undefined;
  let state: unknown;
  try { state = JSON.parse(content); }
  catch { throw new Error('Claude 兼容服务 恢复状态已损坏，未继续修改配置。'); }
  if (!isClaudeCompatibleServiceState(state)) {
    throw new Error('Claude 兼容服务 恢复状态格式无效，未继续修改配置。');
  }
  return state;
}
