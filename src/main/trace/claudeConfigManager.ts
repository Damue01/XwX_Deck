import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { ClaudeModelSettings } from '../app/settings';
import type { ModelCatalogEntry } from '../app/modelCatalog';
import { CLAUDE_MODEL_OVERRIDE_ENV_KEYS, claudeCompatibleServiceModelEnv } from '../app/claudeModelPolicy';
import { writeFileAtomic } from '../shared/fsx';
import { isRecord } from '../shared/obj';
import {
  CLAUDE_CLOUD_PROVIDER_ENV_KEYS,
  claudeCloudProviderMode,
  ClientPaths,
  readClaudeSettingsBaseUrl,
  resolveClientPaths
} from './clientConfig';

const execFileAsync = promisify(execFile);

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

export interface ClaudeEnvironmentOverride {
  readonly name: string;
  readonly scopes: readonly ('process' | 'user' | 'machine')[];
  readonly canRemoveAutomatically: boolean;
}

export interface ClaudeEnvironmentOverrideSnapshot {
  readonly platform: 'windows' | 'other';
  readonly overrides: readonly ClaudeEnvironmentOverride[];
  readonly canRemoveAutomatically: boolean;
}

export interface ClaudeEnvironmentCleanupResult extends ClaudeEnvironmentOverrideSnapshot {
  readonly backupPath?: string;
}

interface ClaudeConfigManagerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

interface WindowsEnvironmentValue {
  readonly type: 'REG_SZ' | 'REG_EXPAND_SZ';
  readonly value: string;
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
const CLAUDE_RUNTIME_OVERRIDE_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  ...CLAUDE_MODEL_OVERRIDE_ENV_KEYS,
  ...CLAUDE_CLOUD_PROVIDER_ENV_KEYS
] as const;
const WINDOWS_USER_ENVIRONMENT_KEY = 'HKCU\\Environment';
const WINDOWS_MACHINE_ENVIRONMENT_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';

export class ClaudeConfigManager {
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly userDataDir: string,
    private readonly paths: ClientPaths | (() => ClientPaths) = resolveClientPaths,
    private readonly options: ClaudeConfigManagerOptions = {}
  ) {}

  async read(): Promise<ClaudeCompatibleServiceSnapshot> {
    return this.serialized(async () => {
      const configPath = this.clientPaths().claudeSettingsPath;
      return this.inspect(configPath, await readConfigText(configPath));
    });
  }

  /** Snapshot the exact current bytes before an explicit user-confirmed switch. */
  async backupBeforeConfirmedRepair(): Promise<string> {
    return this.serialized(async () => {
      const file = this.clientPaths().claudeSettingsPath;
      const original = await fs.promises.readFile(file).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (!original) return '';
      const backupDir = path.join(this.userDataDir, 'backups');
      await fs.promises.mkdir(backupDir, { recursive: true });
      const backupPath = path.join(backupDir, `claude-settings-before-repair-${Date.now()}-${Math.random().toString(16).slice(2, 10)}.json`);
      await writeFileAtomic(backupPath, original);
      if (!(await fs.promises.readFile(file)).equals(original)) throw new Error('Claude 配置又被修改，请重新修复。');
      return backupPath;
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

  /** Explicit official selection clears API overrides after reversible takeover ends. */
  async switchToOfficial(): Promise<ClaudeCompatibleServiceSnapshot> {
    return this.serialized(async () => {
      await this.disable();
      const configPath = this.clientPaths().claudeSettingsPath;
      const original = await readConfigText(configPath);
      if (original === undefined) return disabledSnapshot(configPath);
      const data = parseSettings(original);
      const env = isRecord(data.env) ? { ...data.env } : {};
      const keys = [...MANAGED_KEYS, ...CLAUDE_CLOUD_PROVIDER_ENV_KEYS];
      if (!keys.some(key => Object.prototype.hasOwnProperty.call(env, key))) {
        return disabledSnapshot(configPath);
      }
      const backupDir = path.join(this.userDataDir, 'backups');
      await fs.promises.mkdir(backupDir, { recursive: true });
      await writeFileAtomic(path.join(backupDir,
        `claude-settings-before-official-${Date.now()}-${Math.random().toString(16).slice(2, 10)}.json`), original);
      for (const key of keys) delete env[key];
      const next = { ...data };
      if (Object.keys(env).length) next.env = env;
      else delete next.env;
      await writeConfigIfUnchanged(configPath, original, formatSettings(next, original));
      return disabledSnapshot(configPath);
    });
  }

  /** Confirmed repair changes managed keys in the latest file, preserving
   * unrelated JSON and allowing a damaged old ownership record. */
  async repair(input: ClaudeCompatibleServiceUpdate): Promise<ClaudeCompatibleServiceSnapshot> {
    return this.serialized(async () => {
      const configPath = this.clientPaths().claudeSettingsPath;
      const original = await readConfigText(configPath);
      const data = parseSettings(original);
      const env = isRecord(data.env) ? { ...data.env } : {};
      const statePath = this.statePath();
      const originalState = await readConfigText(statePath);
      let state: ClaudeCompatibleServiceState | undefined;
      try { state = parseClaudeCompatibleServiceState(originalState); }
      catch {
        if (originalState !== undefined) await this.backupRepairState(originalState);
      }
      if (state?.configPath !== configPath) state = undefined;
      if (input.enabled) {
        const baseUrl = input.nativeAnthropic
          ? (input.baseUrl || '').trim().replace(/\/v1\/?$/, '')
          : claudeCompatibleServiceBaseUrl(input.baseUrl || '');
        const bearerToken = input.bearerToken?.trim() || '';
        if (!baseUrl || !bearerToken) throw new Error('所选 Claude 服务地址或密钥不完整。');
        assertNoRuntimeOverride(data, baseUrl, this.options.env ?? process.env);
        const previous = state ? captureMissingValues(state.previous, env) : captureValues(env);
        const written = buildWrittenValues(baseUrl, bearerToken, input.models, input.catalog, data.model);
        if (input.nativeAnthropic) {
          written.ANTHROPIC_AUTH_TOKEN = '';
          written.ANTHROPIC_API_KEY = bearerToken;
        }
        for (const key of MANAGED_KEYS) {
          if (written[key]) env[key] = written[key];
          else delete env[key];
        }
        const nextContent = formatSettings({ ...data, env }, original);
        const nextStateContent = JSON.stringify({
          version: 1, enabled: true, configPath, fileExisted: state?.fileExisted ?? original !== undefined,
          previous, written
        } satisfies ClaudeCompatibleServiceState, null, 2);
        await writeConfigIfUnchanged(configPath, original, nextContent);
        let stateWritten = false;
        try {
          await writeInternalStateIfUnchanged(statePath, originalState, nextStateContent);
          stateWritten = true;
          const result = await this.inspect(configPath, await readConfigText(configPath));
          if (!result.enabled) throw new Error(result.detail || 'Claude 配置写后未生效。');
          return result;
        } catch (error) {
          await restoreContentIfUnchanged(configPath, nextContent, original);
          if (stateWritten) await restoreInternalStateIfUnchanged(statePath, nextStateContent, originalState);
          throw error;
        }
      }
      for (const key of MANAGED_KEYS) {
        const expected = state?.written[key];
        if (state && (expected ? env[key] !== expected : Object.prototype.hasOwnProperty.call(env, key))) continue;
        const previous = state?.previous[key];
        if (previous?.present) env[key] = previous.value;
        else delete env[key];
      }
      const next = { ...data };
      if (Object.keys(env).length) next.env = env;
      else delete next.env;
      const nextContent = formatSettings(next, original);
      await writeConfigIfUnchanged(configPath, original, nextContent);
      try {
        if (originalState !== undefined) await removeInternalStateIfUnchanged(statePath, originalState);
      } catch (error) {
        await restoreContentIfUnchanged(configPath, nextContent, original);
        throw error;
      }
      return disabledSnapshot(configPath);
    });
  }

  private async backupRepairState(content: string): Promise<void> {
    const backupDir = path.join(this.userDataDir, 'backups');
    await fs.promises.mkdir(backupDir, { recursive: true });
    await writeFileAtomic(path.join(backupDir,
      `claude-state-before-repair-${Date.now()}-${Math.random().toString(16).slice(2, 10)}.json`), content);
  }

  async readEnvironmentOverrides(): Promise<ClaudeEnvironmentOverrideSnapshot> {
    return this.serialized(() => inspectClaudeEnvironmentOverrides(
      this.options.env ?? process.env,
      this.options.platform ?? process.platform
    ));
  }

  async clearEnvironmentOverrides(expectedNames: readonly string[]): Promise<ClaudeEnvironmentCleanupResult> {
    return this.serialized(async () => {
      const env = this.options.env ?? process.env;
      const platform = this.options.platform ?? process.platform;
      const snapshot = await inspectClaudeEnvironmentOverrides(env, platform);
      const expected = [...new Set(expectedNames)].sort();
      const current = snapshot.overrides.map(item => item.name).sort();
      if (expected.length === 0 || expected.some(name => !CLAUDE_RUNTIME_OVERRIDE_ENV_KEYS.includes(
        name as typeof CLAUDE_RUNTIME_OVERRIDE_ENV_KEYS[number]
      ))) {
        throw new Error('无效的 Claude 环境变量清理请求。');
      }
      if (expected.join('\n') !== current.join('\n')) {
        throw new Error('Claude 环境变量在确认后发生了变化，未删除；请重新切换并确认。');
      }
      const machineOverrides = snapshot.overrides.filter(item => item.scopes.includes('machine'));
      if (machineOverrides.length) {
        throw new Error(`检测到系统级环境变量 ${machineOverrides.map(item => item.name).join('、')}，XwX Deck 不会自动删除管理员配置。`);
      }

      const processValues = Object.fromEntries(current.map(name => [name, env[name]]));
      let userValues: Record<string, WindowsEnvironmentValue> = {};
      if (platform === 'win32') {
        userValues = await readWindowsEnvironment(WINDOWS_USER_ENVIRONMENT_KEY);
      }
      const backupPath = path.join(
        this.userDataDir,
        'backups',
        `claude-environment-before-standardization-${Date.now()}.json`
      );
      await writeFileAtomic(backupPath, `${JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        platform,
        variables: current.map(name => ({
          name,
          processValue: processValues[name],
          userValue: userValues[name]
        }))
      }, null, 2)}\n`);

      const removedUserValues: Array<{ name: string; value: WindowsEnvironmentValue }> = [];
      try {
        if (platform === 'win32') {
          for (const name of current) {
            const value = userValues[name];
            if (!value) continue;
            await deleteWindowsEnvironmentValue(WINDOWS_USER_ENVIRONMENT_KEY, name);
            removedUserValues.push({ name, value });
          }
        }
        for (const name of current) delete env[name];
      } catch (error) {
        for (const item of removedUserValues.reverse()) {
          await writeWindowsEnvironmentValue(WINDOWS_USER_ENVIRONMENT_KEY, item.name, item.value).catch(() => undefined);
        }
        for (const [name, value] of Object.entries(processValues)) {
          if (value === undefined) delete env[name];
          else env[name] = value;
        }
        throw error;
      }

      if (platform === 'win32') await broadcastWindowsEnvironmentChange().catch(() => undefined);
      const after = await inspectClaudeEnvironmentOverrides(env, platform);
      if (after.overrides.length) {
        throw new Error(`Claude 环境变量仍在生效：${after.overrides.map(item => item.name).join('、')}。请关闭相关终端或配置工具后重试。`);
      }
      return { ...after, backupPath };
    });
  }

  private async enable(input: ClaudeCompatibleServiceUpdate): Promise<ClaudeCompatibleServiceSnapshot> {
    const baseUrl = input.nativeAnthropic ? (input.baseUrl || '').trim().replace(/\/v1\/?$/, '') : claudeCompatibleServiceBaseUrl(input.baseUrl || '');
    const bearerToken = input.bearerToken?.trim() || '';
    if (!baseUrl) throw new Error('服务商地址不能为空。');
    if (!bearerToken) throw new Error('服务商密钥不能为空。');

    const configPath = this.clientPaths().claudeSettingsPath;
    const original = await readConfigText(configPath);
    let data: Record<string, unknown>;
    try {
      data = parseSettings(original);
    } catch (error) {
      if (original === undefined) throw error;
      const backupDir = path.join(this.userDataDir, 'backups');
      await fs.promises.mkdir(backupDir, { recursive: true });
      const backupPath = path.join(
        backupDir,
        `claude-settings-invalid-before-recovery-${Date.now()}.json`
      );
      await writeFileAtomic(backupPath, original);
      data = {};
    }
    assertNoRuntimeOverride(data, baseUrl, this.options.env ?? process.env);
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

function assertNoRuntimeOverride(
  data: Record<string, unknown>,
  expectedBaseUrl: string,
  env: NodeJS.ProcessEnv
): void {
  const cloudMode = claudeCloudProviderMode(data, env);
  if (cloudMode) throw new Error(`Claude 当前启用了 ${cloudMode}，请先切换为普通 Anthropic 网关模式。`);
  const conflicts = activeClaudeEnvironmentKeys(env);
  if (conflicts.length) {
    const baseMatches = env.ANTHROPIC_BASE_URL?.trim() === expectedBaseUrl;
    const onlyMatchingBase = conflicts.length === 1 && conflicts[0] === 'ANTHROPIC_BASE_URL' && baseMatches;
    if (!onlyMatchingBase) {
      throw new Error(`Claude 接入失败：检测到环境变量 ${conflicts.join('、')}，本地配置已失效，请移除相关环境变量后重试。`);
    }
  }
}

function activeClaudeEnvironmentKeys(env: NodeJS.ProcessEnv): string[] {
  return CLAUDE_RUNTIME_OVERRIDE_ENV_KEYS.filter(key => {
    return claudeEnvironmentValueIsActive(key, env[key]);
  });
}

async function inspectClaudeEnvironmentOverrides(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): Promise<ClaudeEnvironmentOverrideSnapshot> {
  const active = activeClaudeEnvironmentKeys(env);
  const windows = platform === 'win32';
  const [userValues, machineValues] = windows
    ? await Promise.all([
        readWindowsEnvironment(WINDOWS_USER_ENVIRONMENT_KEY),
        readWindowsEnvironment(WINDOWS_MACHINE_ENVIRONMENT_KEY)
      ])
    : [{}, {}];
  const user = activeWindowsEnvironmentKeys(userValues);
  const machine = activeWindowsEnvironmentKeys(machineValues);
  return mergeClaudeEnvironmentOverrideScopes(active, user, machine, windows);
}

export function mergeClaudeEnvironmentOverrideScopes(
  processNames: readonly string[],
  userNames: readonly string[],
  machineNames: readonly string[],
  windows = true
): ClaudeEnvironmentOverrideSnapshot {
  const processSet = new Set(processNames);
  const userSet = new Set(userNames);
  const machineSet = new Set(machineNames);
  const overrides = CLAUDE_RUNTIME_OVERRIDE_ENV_KEYS
    .filter(name => processSet.has(name) || userSet.has(name) || machineSet.has(name))
    .map(name => {
      const scopes: Array<'process' | 'user' | 'machine'> = [];
      if (processSet.has(name)) scopes.push('process');
      if (userSet.has(name)) scopes.push('user');
      if (machineSet.has(name)) scopes.push('machine');
      return {
        name,
        scopes,
        canRemoveAutomatically: !scopes.includes('machine')
      };
    });
  return {
    platform: windows ? 'windows' : 'other',
    overrides,
    canRemoveAutomatically: overrides.every(item => item.canRemoveAutomatically)
  };
}

function activeWindowsEnvironmentKeys(
  values: Readonly<Record<string, WindowsEnvironmentValue>>
): string[] {
  return CLAUDE_RUNTIME_OVERRIDE_ENV_KEYS.filter(name => (
    claudeEnvironmentValueIsActive(name, values[name]?.value)
  ));
}

function claudeEnvironmentValueIsActive(name: string, raw: string | undefined): boolean {
  const value = raw?.trim();
  if (!value) return false;
  if (CLAUDE_CLOUD_PROVIDER_ENV_KEYS.includes(
    name as typeof CLAUDE_CLOUD_PROVIDER_ENV_KEYS[number]
  )) {
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  }
  return true;
}

async function readWindowsEnvironment(key: string): Promise<Record<string, WindowsEnvironmentValue>> {
  let stdout = '';
  try {
    const result = await execFileAsync('reg.exe', ['query', key], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5_000
    });
    stdout = String(result.stdout);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { code?: number }).code;
    if (code === 1 || String((error as Error).message).includes('exit code 1')) return {};
    throw error;
  }
  const values: Record<string, WindowsEnvironmentValue> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s{4}([^\s]+)\s+(REG_SZ|REG_EXPAND_SZ)\s*(.*)$/.exec(line);
    if (!match) continue;
    values[match[1].toUpperCase()] = {
      type: match[2] as WindowsEnvironmentValue['type'],
      value: match[3] ?? ''
    };
  }
  return values;
}

async function deleteWindowsEnvironmentValue(key: string, name: string): Promise<void> {
  await execFileAsync('reg.exe', ['delete', key, '/v', name, '/f'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 5_000
  });
}

async function writeWindowsEnvironmentValue(
  key: string,
  name: string,
  value: WindowsEnvironmentValue
): Promise<void> {
  await execFileAsync('reg.exe', ['add', key, '/v', name, '/t', value.type, '/d', value.value, '/f'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 5_000
  });
}

async function broadcastWindowsEnvironmentChange(): Promise<void> {
  const script = [
    'Add-Type -TypeDefinition @\'',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class XwxDeckEnvironmentBroadcast {',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]',
    '  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);',
    '}',
    '\'@;',
    '$result = [UIntPtr]::Zero;',
    '[void][XwxDeckEnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result)'
  ].join('\n');
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-Command',
    script
  ], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 8_000
  });
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
