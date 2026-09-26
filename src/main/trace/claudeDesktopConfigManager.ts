import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ModelCatalogEntry } from '../app/modelCatalog';
import type { ClaudeModelSettings } from '../app/settings';
import { writeFileAtomic } from '../shared/fsx';
import { isRecord } from '../shared/obj';
import { buildClaudeDesktopModels } from './claudeDesktopModels';

const PROFILE_ID = '00000000-0000-4000-8000-000000157220';
const PROFILE_NAME = 'XwX Deck';
const STATE_FILE = 'claude-desktop-sync-state.json';
const LEGACY_PROFILE_IDS = ['xwx-deck', 'xwx-deck-deepseek'] as const;
const LEGACY_GATEWAY_BASE_URL = 'http://127.0.0.1:15725';
const execFileAsync = promisify(execFile);

interface ManagedValue {
  readonly present: boolean;
  readonly value?: unknown;
}

interface DesktopConfigState {
  readonly path: string;
  readonly fileExisted: boolean;
  readonly previousDeploymentMode: ManagedValue;
}

interface ClaudeDesktopSyncState {
  readonly version: 1;
  /** Missing on profiles created before direct Desktop gateways were supported. */
  readonly mode?: 'direct' | 'local' | 'official';
  readonly root: string;
  readonly configFiles: readonly DesktopConfigState[];
  readonly metaPath: string;
  readonly metaFileExisted: boolean;
  readonly previousAppliedId: ManagedValue;
  readonly previousEntry: ManagedValue;
  readonly profilePath: string;
  readonly previousProfileContent?: string;
  readonly writtenProfileContent: string;
}

export interface ClaudeDesktopSyncSnapshot {
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly active: boolean;
  readonly modelCount: number;
  readonly mode?: 'direct' | 'local' | 'official';
  readonly configPath?: string;
  readonly detail?: string;
}

export interface ClaudeDesktopSyncApplyInput {
  readonly gatewayBaseUrl: string;
  readonly gatewayApiKey: string;
  readonly gatewayAuthScheme: 'bearer' | 'x-api-key';
  readonly mode: 'direct' | 'local';
  readonly catalog: readonly ModelCatalogEntry[];
  readonly models: ClaudeModelSettings;
}

export interface ClaudeDesktopPathOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}

interface ClaudeDesktopPaths {
  readonly root: string;
  readonly configFiles: readonly string[];
  readonly metaPath: string;
  readonly profilePath: string;
}

export class ClaudeDesktopConfigManager {
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly userDataDir: string,
    private readonly pathOptions: ClaudeDesktopPathOptions = {}
  ) {}

  read(): Promise<ClaudeDesktopSyncSnapshot> {
    return this.serialized(() => this.inspect());
  }

  apply(input: ClaudeDesktopSyncApplyInput): Promise<ClaudeDesktopSyncSnapshot> {
    return this.serialized(() => this.applyUnlocked(input));
  }

  restore(): Promise<ClaudeDesktopSyncSnapshot> {
    return this.serialized(() => this.restoreUnlocked());
  }

  /** Keep Desktop on Claude.ai while sync is enabled, without discarding the
   * configuration that must be restored when sync is turned off. */
  restoreOfficial(): Promise<ClaudeDesktopSyncSnapshot> {
    return this.serialized(() => this.restoreOfficialUnlocked());
  }

  /** Stop/exit only removes profiles that depend on XwX's local Gateway. */
  restoreLocal(): Promise<ClaudeDesktopSyncSnapshot> {
    return this.serialized(async () => {
      const state = await this.readState();
      return state?.mode === 'direct' || state?.mode === 'official'
        ? this.inspect()
        : this.restoreUnlocked();
    });
  }

  private async inspect(): Promise<ClaudeDesktopSyncSnapshot> {
    if (!desktopPlatformSupported(this.pathOptions.platform ?? process.platform)) {
      return { enabled: false, supported: false, active: false, modelCount: 0 };
    }
    const state = await this.readState();
    if (!state) return { enabled: false, supported: true, active: false, modelCount: 0 };
    if (state.mode === 'official') {
      const active = (await Promise.all(state.configFiles.map(async config => {
        const data = parseObjectOrEmpty(await readText(config.path), 'Claude Desktop 配置');
        return data.deploymentMode === '1p';
      }))).every(Boolean);
      return {
        enabled: true, supported: true, active, modelCount: 0, mode: 'official',
        ...(!active ? { detail: 'Claude Desktop 官方模式已被外部修改。' } : {})
      };
    }
    const managedProfileId = profileIdFromPath(state.profilePath);
    const profile = await readText(state.profilePath);
    let modelCount = 0;
    if (profile === state.writtenProfileContent) {
      const parsed = parseObject(profile, 'Claude Desktop profile');
      modelCount = Array.isArray(parsed.inferenceModels) ? parsed.inferenceModels.length : 0;
    }
    const meta = await readJsonObject(state.metaPath, 'Claude Desktop configLibrary metadata');
    const active = profile === state.writtenProfileContent && meta.appliedId === managedProfileId;
    return {
      enabled: true,
      supported: true,
      active,
      modelCount,
      mode: state.mode ?? 'local',
      configPath: state.profilePath,
      ...(!active ? { detail: 'Claude Desktop 配置已被外部修改。' } : {})
    };
  }

  private async applyUnlocked(input: ClaudeDesktopSyncApplyInput): Promise<ClaudeDesktopSyncSnapshot> {
    const platform = this.pathOptions.platform ?? process.platform;
    if (!desktopPlatformSupported(platform)) throw new Error('当前系统不支持同步 Claude Desktop。');
    const gatewayBaseUrl = normalizeGatewayBaseUrl(input.gatewayBaseUrl, input.mode);
    const gatewayApiKey = input.gatewayApiKey.trim();
    if (!gatewayApiKey) throw new Error('Claude Desktop Gateway 密钥不能为空。');
    const inferenceModels = buildClaudeDesktopModels(input.catalog, input.models).map(model => ({
      name: model.name,
      labelOverride: model.label,
      anthropicFamilyTier: model.tier,
      ...(model.isFamilyDefault ? { isFamilyDefault: true } : {}),
      ...(model.supports1m ? { supports1m: true } : {})
    }));
    if (!inferenceModels.length) throw new Error('当前 Claude 服务没有可同步到 Desktop 的对话模型。');

    let existingState = await this.readState();
    const resolvedPaths = await resolveClaudeDesktopPaths(this.pathOptions);
    if (existingState && (
      !samePath(existingState.root, resolvedPaths.root, platform)
      || !samePath(existingState.profilePath, resolvedPaths.profilePath, platform)
    )) {
      if (
        samePath(existingState.root, resolvedPaths.root, platform)
        && isLegacyProfileId(profileIdFromPath(existingState.profilePath))
      ) {
        await this.migrateManagedProfileState(existingState, resolvedPaths);
        existingState = await this.readState();
      } else {
        // Older XwX builds treated an MSIX package's LocalCache as the app's
        // configuration root. Claude Desktop is a full-trust packaged app and
        // follows the documented %LOCALAPPDATA%\Claude[-3p] paths instead.
        // Restore the stale managed profile before moving ownership.
        await this.restoreUnlocked();
        existingState = undefined;
      }
    }
    if (!existingState && platform === 'win32' && process.platform === 'win32') await this.migrateLegacyWindowsPolicy();
    const paths = existingState
      ? pathsFromState(existingState)
      : resolvedPaths;

    if (!existingState) await this.migrateLegacyLocalProfile(paths);
    const profile = formatJson({
      chatTabEnabled: true,
      disableDeploymentModeChooser: true,
      inferenceProvider: 'gateway',
      inferenceCredentialKind: 'static',
      inferenceGatewayAuthScheme: input.gatewayAuthScheme,
      modelDiscoveryEnabled: false,
      modelCatalogEnabled: false,
      inferenceGatewayBaseUrl: gatewayBaseUrl,
      inferenceGatewayApiKey: gatewayApiKey,
      inferenceModels
    });
    const before = await snapshotFiles([...paths.configFiles, paths.metaPath, paths.profilePath, this.statePath()]);
    const written = new Map<string, string>();
    try {
      const state = existingState ?? await captureInitialState(paths);
      if (existingState) assertProfileSafeToReplace(existingState, before.get(paths.profilePath));

      for (const configPath of paths.configFiles) {
        const current = before.get(configPath);
        const data = parseObjectOrEmpty(current, 'Claude Desktop 配置');
        if (existingState && data.deploymentMode !== (existingState.mode === 'official' ? '1p' : '3p')) {
          throw new Error(`Claude Desktop 配置已被外部修改，未覆盖：${configPath}`);
        }
        const next = formatLike({ ...data, deploymentMode: '3p' }, current);
        await writeExpected(configPath, current, next);
        written.set(configPath, next);
      }

      const metaCurrent = before.get(paths.metaPath);
      const meta = parseObjectOrEmpty(metaCurrent, 'Claude Desktop configLibrary metadata');
      const entries = Array.isArray(meta.entries)
        ? meta.entries.filter(item => !(isRecord(item) && item.id === PROFILE_ID))
        : [];
      entries.push({ id: PROFILE_ID, name: PROFILE_NAME });
      const nextMeta = formatLike({ ...meta, entries, appliedId: PROFILE_ID }, metaCurrent);
      await writeExpected(paths.metaPath, metaCurrent, nextMeta);
      written.set(paths.metaPath, nextMeta);
      await writeExpected(paths.profilePath, before.get(paths.profilePath), profile);
      written.set(paths.profilePath, profile);

      const nextState: ClaudeDesktopSyncState = { ...state, mode: input.mode, writtenProfileContent: profile };
      const nextStateText = formatJson(nextState);
      await writeExpected(this.statePath(), before.get(this.statePath()), nextStateText);
      written.set(this.statePath(), nextStateText);
      const result = await this.inspect();
      if (!result.active) throw new Error(result.detail || 'Claude Desktop 配置写后校验失败。');
      return result;
    } catch (error) {
      await rollbackSnapshot(before, written).catch(rollbackError => {
        throw new AggregateError([error as Error, rollbackError as Error], 'Claude Desktop 同步失败，且自动回滚未完全成功。');
      });
      throw error;
    }
  }

  private async restoreUnlocked(): Promise<ClaudeDesktopSyncSnapshot> {
    const stateText = await readText(this.statePath());
    const state = parseState(stateText);
    if (!state) {
      return {
        enabled: false,
        supported: desktopPlatformSupported(this.pathOptions.platform ?? process.platform),
        active: false,
        modelCount: 0
      };
    }
    if (state.mode === 'official') return this.restoreOfficialState(state, stateText!);

    const managedProfileId = profileIdFromPath(state.profilePath);
    const conflicts: string[] = [];
    const before = await snapshotFiles([
      ...state.configFiles.map(config => config.path),
      state.metaPath, state.profilePath, this.statePath()
    ]);
    const nextFiles = new Map<string, string | undefined>();
    for (const config of state.configFiles) {
      const current = before.get(config.path);
      const data = parseObjectOrEmpty(current, 'Claude Desktop 配置');
      const previous = config.previousDeploymentMode;
      if (data.deploymentMode === '3p') {
        const next = { ...data };
        if (previous.present) next.deploymentMode = previous.value;
        else delete next.deploymentMode;
        nextFiles.set(config.path, !config.fileExisted && Object.keys(next).length === 0
          ? undefined : formatLike(next, current));
      } else if (!managedValueMatches(previous, data, 'deploymentMode')) {
        conflicts.push(config.path);
      }
    }

    const metaCurrent = before.get(state.metaPath);
    const meta = parseObjectOrEmpty(metaCurrent, 'Claude Desktop configLibrary metadata');
    const entries = Array.isArray(meta.entries) ? [...meta.entries] : [];
    const index = entries.findIndex(item => isRecord(item) && item.id === managedProfileId);
    if (index >= 0) {
      const entry = entries[index];
      if (isRecord(entry) && entry.name === PROFILE_NAME) {
        if (state.previousEntry.present) entries[index] = state.previousEntry.value;
        else entries.splice(index, 1);
      } else if (!state.previousEntry.present || !deepEqual(entry, state.previousEntry.value)) {
        conflicts.push(state.metaPath);
      }
    } else if (state.previousEntry.present) {
      entries.push(state.previousEntry.value);
    }
    const nextMeta: Record<string, any> = { ...meta, entries };
    if (meta.appliedId === managedProfileId) {
      if (state.previousAppliedId.present) nextMeta.appliedId = state.previousAppliedId.value;
      else delete nextMeta.appliedId;
    } else if (!managedValueMatches(state.previousAppliedId, meta, 'appliedId')) {
      conflicts.push(state.metaPath);
    }
    if (!state.metaFileExisted && entries.length === 0 && Object.keys(nextMeta).length === 1) {
      nextFiles.set(state.metaPath, undefined);
    } else {
      nextFiles.set(state.metaPath, formatLike(nextMeta, metaCurrent));
    }

    const profileCurrent = before.get(state.profilePath);
    if (profileCurrent === state.writtenProfileContent) {
      nextFiles.set(state.profilePath, state.previousProfileContent);
    } else if (profileCurrent !== state.previousProfileContent) {
      conflicts.push(state.profilePath);
    }

    if (conflicts.length) {
      throw new Error(`Claude Desktop 配置已被外部修改，未覆盖：${[...new Set(conflicts)].join('、')}`);
    }
    const written = new Map<string, string | undefined>();
    try {
      for (const [file, next] of nextFiles) {
        const current = before.get(file);
        if (current === next) continue;
        await replaceExpected(file, current, next);
        written.set(file, next);
      }
      written.set(this.statePath(), undefined);
      await removeExpected(this.statePath(), stateText);
    } catch (error) {
      await rollbackSnapshot(before, written).catch(rollbackError => {
        throw new AggregateError([error as Error, rollbackError as Error], 'Claude Desktop 配置恢复失败，且自动回滚未完全成功。');
      });
      throw error;
    }
    return {
      enabled: false,
      supported: desktopPlatformSupported(this.pathOptions.platform ?? process.platform),
      active: false,
      modelCount: 0
    };
  }

  private async restoreOfficialUnlocked(): Promise<ClaudeDesktopSyncSnapshot> {
    const platform = this.pathOptions.platform ?? process.platform;
    if (!desktopPlatformSupported(platform)) throw new Error('当前系统不支持同步 Claude Desktop。');
    const state = await this.readState();
    if (state?.mode === 'official') {
      const result = await this.inspect();
      if (!result.active) throw new Error(result.detail);
      return result;
    }
    if (state) await this.restoreUnlocked();
    if (platform === 'win32' && process.platform === 'win32') {
      const machine = await readWindowsPolicy('HKLM\\SOFTWARE\\Policies\\Claude');
      const user = await readWindowsPolicy('HKCU\\SOFTWARE\\Policies\\Claude');
      if (Object.keys(machine).length || Object.keys(user).length) {
        throw new Error('Claude Desktop 正在使用管理策略，无法切换到官方模式。');
      }
    }
    const paths = await resolveClaudeDesktopPaths(this.pathOptions);
    const previous = await captureInitialState(paths);
    const before = await snapshotFiles([...paths.configFiles, this.statePath()]);
    const backupDir = path.join(this.userDataDir, 'backups',
      `claude-desktop-before-official-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`);
    await fs.promises.mkdir(backupDir, { recursive: true });
    for (const [index, file] of paths.configFiles.entries()) {
      const content = before.get(file);
      if (content !== undefined) await writeFileAtomic(path.join(backupDir, `${index}-claude_desktop_config.json`), content);
    }
    const written = new Map<string, string>();
    try {
      for (const file of paths.configFiles) {
        const current = before.get(file);
        const data = parseObjectOrEmpty(current, 'Claude Desktop 配置');
        if (data.deploymentMode === '1p') continue;
        const next = formatLike({ ...data, deploymentMode: '1p' }, current);
        await writeExpected(file, current, next);
        written.set(file, next);
      }
      const nextState = formatJson({ ...previous, mode: 'official' } satisfies ClaudeDesktopSyncState);
      await writeExpected(this.statePath(), before.get(this.statePath()), nextState);
      written.set(this.statePath(), nextState);
      return this.inspect();
    } catch (error) {
      await rollbackSnapshot(before, written).catch(rollbackError => {
        throw new AggregateError([error as Error, rollbackError as Error], 'Claude Desktop 官方模式切换失败，且自动回滚未完全成功。');
      });
      throw error;
    }
  }

  private async restoreOfficialState(state: ClaudeDesktopSyncState, stateText: string): Promise<ClaudeDesktopSyncSnapshot> {
    const before = await snapshotFiles([...state.configFiles.map(item => item.path), this.statePath()]);
    const written = new Map<string, string | undefined>();
    for (const config of state.configFiles) {
      const data = parseObjectOrEmpty(before.get(config.path), 'Claude Desktop 配置');
      if (data.deploymentMode !== '1p' && !managedValueMatches(config.previousDeploymentMode, data, 'deploymentMode')) {
        throw new Error(`Claude Desktop 官方模式已被外部修改，未覆盖：${config.path}`);
      }
    }
    try {
      for (const config of state.configFiles) {
        const current = before.get(config.path);
        const data = parseObjectOrEmpty(current, 'Claude Desktop 配置');
        if (managedValueMatches(config.previousDeploymentMode, data, 'deploymentMode')) continue;
        const next = { ...data };
        if (config.previousDeploymentMode.present) next.deploymentMode = config.previousDeploymentMode.value;
        else delete next.deploymentMode;
        const restored = !config.fileExisted && Object.keys(next).length === 0
          ? undefined : formatLike(next, current);
        if (restored !== current) {
          await replaceExpected(config.path, current, restored);
          written.set(config.path, restored);
        }
      }
      written.set(this.statePath(), undefined);
      await removeExpected(this.statePath(), stateText);
      return {
        enabled: false, supported: desktopPlatformSupported(this.pathOptions.platform ?? process.platform),
        active: false, modelCount: 0
      };
    } catch (error) {
      await rollbackSnapshot(before, written).catch(rollbackError => {
        throw new AggregateError([error as Error, rollbackError as Error], 'Claude Desktop 官方模式恢复失败，且自动回滚未完全成功。');
      });
      throw error;
    }
  }

  private statePath(): string {
    return path.join(this.userDataDir, STATE_FILE);
  }

  private async migrateLegacyWindowsPolicy(): Promise<void> {
    const hklm = await readWindowsPolicy('HKLM\\SOFTWARE\\Policies\\Claude');
    if (Object.keys(hklm).length) {
      throw new Error('Claude Desktop 正在使用系统级管理策略，无法同步。');
    }
    const key = 'HKCU\\SOFTWARE\\Policies\\Claude';
    const values = await readWindowsPolicy(key);
    if (!Object.keys(values).length) return;
    const known = new Set([
      'modelDiscoveryEnabled', 'chatTabEnabled', 'inferenceGatewayBaseUrl',
      'inferenceGatewayApiKey', 'inferenceProvider', 'inferenceModels',
      'inferenceGatewayAuthScheme'
    ]);
    const legacy = values.inferenceGatewayBaseUrl === LEGACY_GATEWAY_BASE_URL
      && values.inferenceProvider === 'gateway'
      && Object.keys(values).every(name => known.has(name));
    if (!legacy) throw new Error('Claude Desktop 正在使用其他软件或管理员配置的用户策略，无法同步。');
    const backup = path.join(this.userDataDir, 'backups', `claude-desktop-legacy-policy-${Date.now()}.json`);
    await writeFileAtomic(backup, formatJson({ key, values }));
    for (const name of Object.keys(values)) {
      await execFileAsync('reg.exe', ['delete', key, '/v', name, '/f'], { windowsHide: true });
    }
  }

  private async migrateLegacyLocalProfile(paths: ClaudeDesktopPaths): Promise<void> {
    const metaText = await readText(paths.metaPath);
    if (!metaText) return;
    const meta = parseObject(metaText, 'Claude Desktop configLibrary metadata');
    const entries = Array.isArray(meta.entries) ? meta.entries : [];
    const found: Array<{ id: string; path: string; content: string }> = [];
    for (const id of LEGACY_PROFILE_IDS) {
      const legacyProfilePath = path.join(paths.root, 'configLibrary', `${id}.json`);
      const profileText = await readText(legacyProfilePath);
      if (!profileText) continue;
      const profile = parseObject(profileText, '旧 Claude Desktop profile');
      const entry = entries.find(item => isRecord(item) && item.id === id);
      const owned = id === 'xwx-deck'
        ? isRecord(entry) && entry.name === PROFILE_NAME
        : profile.inferenceGatewayBaseUrl === LEGACY_GATEWAY_BASE_URL && meta.appliedId === id;
      if (owned) found.push({ id, path: legacyProfilePath, content: profileText });
    }
    if (!found.length) return;
    const backupRoot = path.join(this.userDataDir, 'backups', `claude-desktop-legacy-profile-${Date.now()}`);
    await fs.promises.mkdir(backupRoot, { recursive: true });
    await writeFileAtomic(path.join(backupRoot, '_meta.json'), metaText);
    for (const item of found) {
      await writeFileAtomic(path.join(backupRoot, path.basename(item.path)), item.content);
    }
    const legacyIds = new Set(found.map(item => item.id));
    const remainingEntries = entries.filter(item => !(isRecord(item) && legacyIds.has(String(item.id))));
    meta.entries = remainingEntries;
    const fallback = remainingEntries.find(item => isRecord(item) && typeof item.id === 'string') as Record<string, unknown> | undefined;
    if (legacyIds.has(String(meta.appliedId))) {
      if (fallback) meta.appliedId = fallback.id;
      else delete meta.appliedId;
    }
    await writeExpected(paths.metaPath, metaText, formatLike(meta, metaText));
    for (const item of found) {
      await fs.promises.rm(item.path, { force: true });
    }
  }

  private async migrateManagedProfileState(
    state: ClaudeDesktopSyncState,
    paths: ClaudeDesktopPaths
  ): Promise<void> {
    const oldProfileId = profileIdFromPath(state.profilePath);
    if (!isLegacyProfileId(oldProfileId)) return;
    const statePath = this.statePath();
    const before = await snapshotFiles([state.profilePath, paths.profilePath, state.metaPath, statePath]);
    const oldProfile = before.get(state.profilePath);
    const nextProfile = before.get(paths.profilePath);
    if (oldProfile !== state.writtenProfileContent && nextProfile !== state.writtenProfileContent) {
      throw new Error(`Claude Desktop 的旧 XwX Deck profile 已被外部修改，未覆盖：${state.profilePath}`);
    }
    if (nextProfile !== undefined && nextProfile !== state.writtenProfileContent) {
      throw new Error(`Claude Desktop 的 XwX Deck UUID profile 已被外部修改，未覆盖：${paths.profilePath}`);
    }

    const metaCurrent = before.get(state.metaPath);
    const meta = parseObjectOrEmpty(metaCurrent, 'Claude Desktop configLibrary metadata');
    const entries = Array.isArray(meta.entries) ? meta.entries : [];
    const oldEntry = entries.find(item => isRecord(item) && item.id === oldProfileId);
    const nextEntry = entries.find(item => isRecord(item) && item.id === PROFILE_ID);
    if (oldEntry !== undefined && (!isRecord(oldEntry) || oldEntry.name !== PROFILE_NAME)) {
      throw new Error(`Claude Desktop 的旧 XwX Deck profile 索引已被外部修改，未覆盖：${state.metaPath}`);
    }
    if (nextEntry !== undefined && (!isRecord(nextEntry) || nextEntry.name !== PROFILE_NAME)) {
      throw new Error(`Claude Desktop 的 XwX Deck UUID profile 索引已被外部修改，未覆盖：${state.metaPath}`);
    }

    const nextEntries = entries.filter(item => !(
      isRecord(item) && (item.id === oldProfileId || item.id === PROFILE_ID)
    ));
    nextEntries.push({ id: PROFILE_ID, name: PROFILE_NAME });
    const nextMeta = formatLike({ ...meta, entries: nextEntries, appliedId: PROFILE_ID }, metaCurrent);
    const nextState: ClaudeDesktopSyncState = {
      ...state,
      profilePath: paths.profilePath,
      previousEntry: { present: false },
      previousProfileContent: undefined
    };
    const nextStateText = formatJson(nextState);
    const written = new Map<string, string | undefined>();
    try {
      await writeExpected(paths.profilePath, nextProfile, state.writtenProfileContent);
      written.set(paths.profilePath, state.writtenProfileContent);
      await writeExpected(state.metaPath, metaCurrent, nextMeta);
      written.set(state.metaPath, nextMeta);
      await writeExpected(statePath, before.get(statePath), nextStateText);
      written.set(statePath, nextStateText);
      if (!samePath(state.profilePath, paths.profilePath, this.pathOptions.platform ?? process.platform)) {
        await replaceExpected(state.profilePath, oldProfile, undefined);
        written.set(state.profilePath, undefined);
      }
    } catch (error) {
      await rollbackSnapshot(before, written).catch(rollbackError => {
        throw new AggregateError([error as Error, rollbackError as Error], 'Claude Desktop UUID profile 迁移失败，且自动回滚未完全成功。');
      });
      throw error;
    }
  }

  private async readState(): Promise<ClaudeDesktopSyncState | undefined> {
    return parseState(await readText(this.statePath()));
  }

  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operation.then(action, action);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

export async function restoreClaudeDesktopConfiguration(userDataDir: string): Promise<ClaudeDesktopSyncSnapshot> {
  return new ClaudeDesktopConfigManager(userDataDir).restoreLocal();
}

/** Exit-only recovery. Preserve conflicting bytes, then remove every local
 * XwX endpoint so Claude Desktop cannot be stranded on a dead Gateway. */
export async function forceRestoreClaudeDesktopConfiguration(userDataDir: string): Promise<void> {
  const statePath = path.join(userDataDir, STATE_FILE);
  const stateText = await readText(statePath);
  const state = parseState(stateText);
  if (!state) return;
  if (state.mode === 'direct' || state.mode === 'official') return;
  const managedProfileId = profileIdFromPath(state.profilePath);
  const backupRoot = path.join(userDataDir, 'backups', 'claude-desktop-forced', String(Date.now()));
  const touched = [...state.configFiles.map(item => item.path), state.metaPath, state.profilePath];
  await fs.promises.mkdir(backupRoot, { recursive: true });
  for (let index = 0; index < touched.length; index += 1) {
    const current = await readText(touched[index]);
    if (current !== undefined) await writeFileAtomic(path.join(backupRoot, `${index}-${path.basename(touched[index])}`), current);
  }
  for (const config of state.configFiles) {
    const current = await readText(config.path);
    const data = parseObjectOrEmpty(current, 'Claude Desktop 配置');
    if (config.previousDeploymentMode.present) data.deploymentMode = config.previousDeploymentMode.value;
    else delete data.deploymentMode;
    if (!config.fileExisted && Object.keys(data).length === 0) await fs.promises.rm(config.path, { force: true });
    else await writeFileAtomic(config.path, formatLike(data, current));
  }
  const metaCurrent = await readText(state.metaPath);
  const meta = parseObjectOrEmpty(metaCurrent, 'Claude Desktop configLibrary metadata');
  const entries = Array.isArray(meta.entries)
    ? meta.entries.filter(item => !(isRecord(item) && item.id === managedProfileId))
    : [];
  if (state.previousEntry.present) entries.push(state.previousEntry.value);
  meta.entries = entries;
  if (state.previousAppliedId.present) meta.appliedId = state.previousAppliedId.value;
  else delete meta.appliedId;
  if (!state.metaFileExisted && entries.length === 0 && Object.keys(meta).length === 1) {
    await fs.promises.rm(state.metaPath, { force: true });
  } else {
    await writeFileAtomic(state.metaPath, formatLike(meta, metaCurrent));
  }
  if (state.previousProfileContent === undefined) await fs.promises.rm(state.profilePath, { force: true });
  else await writeFileAtomic(state.profilePath, state.previousProfileContent);
  await fs.promises.rm(statePath, { force: true });
}

export async function resolveClaudeDesktopPaths(
  options: ClaudeDesktopPathOptions = {}
): Promise<ClaudeDesktopPaths> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const candidates: Array<{ root3p: string; root1p: string }> = [];
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA?.trim();
    if (!local) throw new Error('无法读取 Windows LOCALAPPDATA。');
    candidates.push({ root3p: path.join(local, 'Claude-3p'), root1p: path.join(local, 'Claude') });
  } else if (platform === 'darwin') {
    const support = path.join(homeDir, 'Library', 'Application Support');
    candidates.push({ root3p: path.join(support, 'Claude-3p'), root1p: path.join(support, 'Claude') });
  } else {
    throw new Error('当前系统不支持同步 Claude Desktop。');
  }

  const scored = await Promise.all(candidates.map(async candidate => ({
    ...candidate,
    score: await candidateScore(candidate.root3p, candidate.root1p)
  })));
  scored.sort((a, b) => b.score - a.score || a.root3p.localeCompare(b.root3p));
  const selected = scored[0];
  if (!selected) throw new Error('未找到 Claude Desktop 配置目录。');
  const configFiles = [...new Set([
    path.join(selected.root1p, 'claude_desktop_config.json'),
    path.join(selected.root3p, 'claude_desktop_config.json')
  ])];
  return {
    root: selected.root3p,
    configFiles,
    metaPath: path.join(selected.root3p, 'configLibrary', '_meta.json'),
    profilePath: path.join(selected.root3p, 'configLibrary', `${PROFILE_ID}.json`)
  };
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function profileIdFromPath(profilePath: string): string {
  return path.basename(profilePath, path.extname(profilePath));
}

function isLegacyProfileId(value: string): value is typeof LEGACY_PROFILE_IDS[number] {
  return (LEGACY_PROFILE_IDS as readonly string[]).includes(value);
}

async function captureInitialState(paths: ClaudeDesktopPaths): Promise<ClaudeDesktopSyncState> {
  const metaText = await readText(paths.metaPath);
  const meta = parseObjectOrEmpty(metaText, 'Claude Desktop configLibrary metadata');
  const entries = Array.isArray(meta.entries) ? meta.entries : [];
  const previousEntry = entries.find(item => isRecord(item) && item.id === PROFILE_ID);
  return {
    version: 1,
    root: paths.root,
    configFiles: await Promise.all(paths.configFiles.map(async configPath => {
      const content = await readText(configPath);
      const data = parseObjectOrEmpty(content, 'Claude Desktop 配置');
      return { path: configPath, fileExisted: content !== undefined, previousDeploymentMode: captureValue(data, 'deploymentMode') };
    })),
    metaPath: paths.metaPath,
    metaFileExisted: metaText !== undefined,
    previousAppliedId: captureValue(meta, 'appliedId'),
    previousEntry: previousEntry === undefined ? { present: false } : { present: true, value: previousEntry },
    profilePath: paths.profilePath,
    previousProfileContent: await readText(paths.profilePath),
    writtenProfileContent: ''
  };
}

function pathsFromState(state: ClaudeDesktopSyncState): ClaudeDesktopPaths {
  return {
    root: state.root,
    configFiles: state.configFiles.map(item => item.path),
    metaPath: state.metaPath,
    profilePath: state.profilePath
  };
}

async function candidateScore(root3p: string, root1p: string): Promise<number> {
  const checks = await Promise.all([
    fileExists(path.join(root3p, 'configLibrary', '_meta.json')),
    fileExists(path.join(root3p, 'claude_desktop_config.json')),
    fileExists(path.join(root1p, 'claude_desktop_config.json')),
    directoryExists(root3p),
    directoryExists(root1p)
  ]);
  return (checks[0] ? 100 : 0) + (checks[1] ? 20 : 0) + (checks[2] ? 10 : 0) + (checks[3] ? 4 : 0) + (checks[4] ? 2 : 0);
}

function desktopPlatformSupported(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

function normalizeGatewayBaseUrl(value: string, mode: 'direct' | 'local'): string {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Claude Desktop Gateway 地址必须使用 HTTP 或 HTTPS。');
  }
  if (mode === 'local' && (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname))) {
    throw new Error('Claude Desktop 只能同步到本机 Trace 网关。');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function parseState(content: string | undefined): ClaudeDesktopSyncState | undefined {
  if (content === undefined) return undefined;
  const value = parseObject(content, 'Claude Desktop 恢复状态');
  if (value.version !== 1 || typeof value.root !== 'string' || !Array.isArray(value.configFiles)
    || typeof value.metaPath !== 'string' || typeof value.profilePath !== 'string'
    || typeof value.writtenProfileContent !== 'string') {
    throw new Error('Claude Desktop 恢复状态格式无效。');
  }
  return value as unknown as ClaudeDesktopSyncState;
}

function parseObject(content: string, label: string): Record<string, any> {
  try {
    const value = JSON.parse(content) as unknown;
    if (isRecord(value)) return value;
  } catch { /* handled below */ }
  throw new Error(`${label}不是有效的 JSON。`);
}

function parseObjectOrEmpty(content: string | undefined, label: string): Record<string, any> {
  return content === undefined ? {} : parseObject(content, label);
}

async function readJsonObject(file: string, label: string): Promise<Record<string, any>> {
  return parseObjectOrEmpty(await readText(file), label);
}

function captureValue(record: Record<string, unknown>, key: string): ManagedValue {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? { present: true, value: record[key] }
    : { present: false };
}

function managedValueMatches(value: ManagedValue, record: Record<string, unknown>, key: string): boolean {
  return value.present
    ? Object.prototype.hasOwnProperty.call(record, key) && deepEqual(record[key], value.value)
    : !Object.prototype.hasOwnProperty.call(record, key);
}

function assertProfileSafeToReplace(state: ClaudeDesktopSyncState, current: string | undefined): void {
  if (current !== state.writtenProfileContent && current !== state.previousProfileContent) {
    throw new Error(`Claude Desktop 的 XwX Deck profile 已被外部修改，未覆盖：${state.profilePath}`);
  }
}

async function snapshotFiles(files: readonly string[]): Promise<Map<string, string | undefined>> {
  const snapshot = new Map<string, string | undefined>();
  await Promise.all(files.map(async file => snapshot.set(file, await readText(file))));
  return snapshot;
}

async function rollbackSnapshot(
  snapshot: ReadonlyMap<string, string | undefined>,
  written: ReadonlyMap<string, string | undefined>
): Promise<void> {
  const errors: Error[] = [];
  for (const [file, previous] of [...snapshot.entries()].reverse()) {
    try {
      const current = await readText(file);
      if (current === previous) continue;
      if (!written.has(file)) {
        throw new Error(`配置事务失败后被其他软件修改，未自动覆盖：${file}`);
      }
      const managed = written.get(file);
      if (current !== managed) {
        throw new Error(`配置事务失败后被其他软件修改，未自动覆盖：${file}`);
      }
      await replaceExpected(file, managed, previous);
    } catch (error) {
      errors.push(error as Error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Claude Desktop 配置回滚不完整。');
}

async function writeExpected(file: string, expected: string | undefined, next: string): Promise<void> {
  if (await readText(file) !== expected) throw new Error(`配置在写入前被其他软件修改：${file}`);
  await writeFileAtomic(file, next);
  if (await readText(file) !== next) throw new Error(`配置写后校验失败：${file}`);
}

async function replaceExpected(file: string, expected: string | undefined, next: string | undefined): Promise<void> {
  if (await readText(file) !== expected) throw new Error(`配置在恢复前被其他软件修改：${file}`);
  if (next === undefined) await fs.promises.rm(file, { force: true });
  else await writeFileAtomic(file, next);
}

async function removeExpected(file: string, expected: string | undefined): Promise<void> {
  await replaceExpected(file, expected, undefined);
  if (await readText(file) !== undefined) throw new Error(`配置恢复状态删除失败：${file}`);
}

async function readText(file: string): Promise<string | undefined> {
  try {
    const value = await fs.promises.readFile(file, 'utf8');
    return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatLike(value: unknown, original: string | undefined): string {
  const indent = original ? Math.min(/\n( +)/.exec(original)?.[1].length || 2, 4) : 2;
  const text = JSON.stringify(value, null, indent);
  return original?.includes('\r\n') ? `${text.replace(/\n/g, '\r\n')}\r\n` : `${text}\n`;
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function fileExists(file: string): Promise<boolean> {
  return fs.promises.stat(file).then(stat => stat.isFile(), () => false);
}

async function directoryExists(dir: string): Promise<boolean> {
  return fs.promises.stat(dir).then(stat => stat.isDirectory(), () => false);
}

async function readWindowsPolicy(key: string): Promise<Record<string, string>> {
  let stdout = '';
  try {
    const result = await execFileAsync('reg.exe', ['query', key], { windowsHide: true, encoding: 'utf8' });
    stdout = result.stdout;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { code?: number }).code;
    if (code === 1 || String((error as Error).message).includes('exit code 1')) return {};
    throw error;
  }
  const values: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s{4}([^\s]+)\s+REG_(?:SZ|EXPAND_SZ|DWORD)\s+(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}
