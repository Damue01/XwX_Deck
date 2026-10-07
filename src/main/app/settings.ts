import * as fs from 'fs';
import { DEFAULT_TRACE_LIMIT_GB, DEFAULT_TRACE_AUTO_CLEANUP } from '../../shared/traceDefaults';
import { resolveClientPaths } from '../trace/clientConfig';
import { readTomlTopLevelString, readTomlStringKey, rootToml, findTomlSection } from '../trace/toml';
import type { ProviderRegistry, ProviderConnection, ProviderClient } from '../../shared/providers';
import * as path from 'path';
import { readJson, writeJson } from '../shared/fsx';
import {
  normalizeProviderPreset,
  providerProfile,
  type ProviderPresetId
} from '../../shared/providerProfiles';

export interface ClaudeModelSettings {
  /** 写入 Claude settings.json env 的模型映射；空串 = 不写该项。 */
  readonly fable: string;
  readonly opus: string;
  readonly sonnet: string;
  readonly haiku: string;
}

export interface CompatibleServiceSettings {
  /** User-facing label; the internal compatibility route remains `compatible`. */
  readonly displayName: string;
  readonly providerPreset: ProviderPresetId;
  readonly baseUrl: string;
  readonly bearerToken: string;
  /** Legacy provider-wide default; model metadata is authoritative when present. */
  readonly codexApiFormat: 'responses' | 'chat-completions' | 'anthropic-messages';
}

export interface CodexEnhancementSettings {
  /** 兼容服务 Gateway 模式下是否保留 Codex auth.json 中现有的 OAuth/API Key。 */
  readonly preserveOfficialLogin: boolean;
  /** Whether the user has applied the one-time local history migration to xwx_deck. */
  readonly unifySessionHistory: boolean;
  /** Retry marker retained for locked resources during an explicit restore. */
  readonly pendingHistoryRestore: boolean;
}

export interface ClaudeDesktopSettings {
  /** Keep Claude Desktop synchronized while Trace owns the local data plane. */
  readonly syncEnabled: boolean;
}

export interface CodexModelSettings {
  /** Last model selected while using the official ChatGPT/OpenAI service. */
  readonly official: string;
  /** Explicit window selected for the official model; zero follows the catalog. */
  readonly officialContextWindow: number;
  /** Last model selected while using 兼容服务. Empty until first configured. */
  readonly compatible: string;
  /** Explicit window selected for the compatible model; zero follows the catalog. */
  readonly compatibleContextWindow: number;
}

export type AppTheme = 'day' | 'night';

export type TraceSkin = 'classic' | 'clean' | 'custom';
export type TraceBackgroundFit = 'cover' | 'contain';

export interface TraceAppearanceSettings {
  readonly skin: TraceSkin;
  readonly showThroughput: boolean;
  /** XwX Deck-managed file name inside userData/appearance; never an arbitrary path. */
  readonly customImageFile: string;
  readonly customImageFit: TraceBackgroundFit;
  /** Readability veil over a custom image, expressed as 0..80 percent. */
  readonly customImageOverlay: number;
}

export interface XwXDeckSettings {
  readonly providers?: ProviderRegistry;
  readonly tracingEnabled: boolean;
  /** 用户显式关闭后台代理后的持久化暂停状态。 */
  readonly gatewayPaused: boolean;
  /** Persistent service intent, independent from the direct-safe Codex config written while the Gateway is stopped. */
  readonly codexPreferredMode: 'auto' | 'official' | 'compatible';
  readonly claudePreferredMode: 'auto' | 'official' | 'compatible';
  /** 夜间/白天主题；持久化后不再依赖渲染进程 file:// 源的 localStorage。 */
  readonly theme: AppTheme;
  /** XwX Trace 页面专属皮肤与模块显隐；不改变全局明暗主题。 */
  readonly traceAppearance: TraceAppearanceSettings;
  /** 开机启动的用户意图；便携版每次启动据此用当前 exe 路径重新对齐登录项。 */
  readonly startupEnabled: boolean;
  /** Zero disables automatic Session-count cleanup. */
  readonly maxSessions: number;
  /** Zero disables automatic storage-budget cleanup. */
  readonly maxStorageMB: number;
  readonly traceWarningGB: number;
  readonly traceAutoCleanup: boolean;
  /** 空串使用 userData/xwx-trace。 */
  readonly traceRoot: string;
  /** 空串使用 userData/logs。 */
  readonly logRoot: string;
  /** 空串遵循 CLAUDE_CONFIG_DIR 或用户主目录下的 .claude。 */
  readonly claudeConfigDir: string;
  readonly clientEnabled: {
    readonly claude: boolean;
    readonly codex: boolean;
  };
  readonly claudeModels: ClaudeModelSettings;
  readonly claudeDesktop: ClaudeDesktopSettings;
  readonly compatible: CompatibleServiceSettings;
  readonly codexModels: CodexModelSettings;
  readonly codexEnhancements: CodexEnhancementSettings;
}

export type XwXDeckSettingsPatch = Omit<Partial<XwXDeckSettings>,
  'clientEnabled' | 'claudeModels' | 'claudeDesktop' | 'compatible' | 'codexModels' | 'codexEnhancements' | 'traceAppearance'> & {
  readonly clientEnabled?: Partial<XwXDeckSettings['clientEnabled']>;
  readonly traceAppearance?: Partial<TraceAppearanceSettings>;
  readonly claudeModels?: Partial<ClaudeModelSettings>;
  readonly claudeDesktop?: Partial<ClaudeDesktopSettings>;
  readonly compatible?: Partial<CompatibleServiceSettings>;
  readonly codexModels?: Partial<CodexModelSettings>;
  readonly codexEnhancements?: Partial<CodexEnhancementSettings>;
};

const DEFAULT_CLAUDE_MODELS: ClaudeModelSettings = {
  fable: '',
  opus: '',
  sonnet: '',
  haiku: ''
};

const DEFAULT_COMPATIBLE_SERVICE: CompatibleServiceSettings = {
  displayName: providerProfile('auto').defaultDisplayName,
  providerPreset: 'auto',
  baseUrl: '',
  bearerToken: '',
  codexApiFormat: 'responses'
};

const DEFAULT_CODEX_ENHANCEMENTS: CodexEnhancementSettings = {
  preserveOfficialLogin: true,
  unifySessionHistory: false,
  pendingHistoryRestore: false
};

const DEFAULT_CLAUDE_DESKTOP: ClaudeDesktopSettings = {
  syncEnabled: false
};

const DEFAULT_CODEX_MODELS: CodexModelSettings = {
  official: 'gpt-5.5',
  officialContextWindow: 0,
  compatible: '',
  compatibleContextWindow: 0
};

const DEFAULT_TRACE_APPEARANCE: TraceAppearanceSettings = {
  skin: 'classic',
  showThroughput: true,
  customImageFile: '',
  customImageFit: 'cover',
  customImageOverlay: 42
};

const DEFAULT_SETTINGS: XwXDeckSettings = {
  tracingEnabled: false,
  gatewayPaused: false,
  codexPreferredMode: 'auto',
  claudePreferredMode: 'auto',
  theme: 'day',
  traceAppearance: DEFAULT_TRACE_APPEARANCE,
  startupEnabled: false,
  maxSessions: 0,
  maxStorageMB: 0,
  traceWarningGB: DEFAULT_TRACE_LIMIT_GB,
  traceAutoCleanup: DEFAULT_TRACE_AUTO_CLEANUP,
  traceRoot: '',
  logRoot: '',
  claudeConfigDir: '',
  clientEnabled: {
    claude: true,
    codex: true
  },
  claudeModels: DEFAULT_CLAUDE_MODELS,
  claudeDesktop: DEFAULT_CLAUDE_DESKTOP,
  compatible: DEFAULT_COMPATIBLE_SERVICE,
  codexModels: DEFAULT_CODEX_MODELS,
  codexEnhancements: DEFAULT_CODEX_ENHANCEMENTS
};

export interface XwXDeckSettingsReadProblem { readonly path: string; readonly message: string; }

export class XwXDeckSettingsStore {
  private writeQueue: Promise<void> = Promise.resolve();
  private readProblemValue: XwXDeckSettingsReadProblem | undefined;
  private migrationProblemValue: XwXDeckSettingsReadProblem | undefined;
  private providerIdentityPending = false;
  private legacySettingsBackupNeeded = false;

  constructor(private readonly userDataDir: string) {}

  path(): string {
    return path.join(this.userDataDir, 'settings.json');
  }

  readProblem(): { path: string; message: string } | undefined { return this.readProblemValue; }

  migrationProblem(): XwXDeckSettingsReadProblem | undefined {
    return this.migrationProblemValue ? { ...this.migrationProblemValue } : undefined;
  }

  /** Explicit repair only: keep the original bytes before replacing damaged settings. */
  async repairUnreadableSettings(): Promise<{ backupPath: string; settings: XwXDeckSettings; lostProviderSettings: boolean }> {
    const result = this.writeQueue.then(async () => {
      const file = this.path();
      const original = await fs.promises.readFile(file);
      if (!this.readProblemValue) throw new Error('设置文件已可读取，无需修复。');
      let parsed: unknown;
      try { parsed = JSON.parse(original.toString('utf8')); }
      catch { parsed = undefined; }
      // Invalid JSON has no trustworthy partial fields. A parseable document
      // with a broken provider registry can retain the unrelated preferences.
      const emptyProviders: ProviderRegistry = {
        version: 1, identityVersion: 2, connections: [],
        selected: { codex: null, claude: null }
      };
      let repaired = normalizeSettings({
        ...DEFAULT_SETTINGS,
        codexPreferredMode: 'official',
        clientEnabled: { claude: false, codex: false },
        providers: emptyProviders
      });
      let lostProviderSettings = true;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const value = parsed as XwXDeckSettings;
        try {
          repaired = normalizeSettings(value);
          lostProviderSettings = false;
        }
        catch {
          // A broken registry cannot be guessed from partial entries.
          const { providers: _invalidProviders, ...safeFields } = value;
          repaired = normalizeSettings({
            ...safeFields,
            codexPreferredMode: 'official',
            tracingEnabled: false,
            clientEnabled: { claude: false, codex: false },
            providers: emptyProviders
          });
        }
      }
      repaired = { ...repaired, tracingEnabled: false };
      if (lostProviderSettings) {
        const entries = await fs.promises.readdir(this.userDataDir);
        const candidates = entries.filter(name =>
          /^settings\.json\.before-(?:provider-standardization|repair-\d+-[a-f0-9]+)\.bak$/.test(name));
        candidates.sort((a, b) => b.localeCompare(a));
        for (const name of candidates) {
          try {
            const candidate = JSON.parse(await fs.promises.readFile(path.join(this.userDataDir, name), 'utf8')) as XwXDeckSettings;
            if (!candidate.providers || candidate.providers.version !== 1
              || !Array.isArray(candidate.providers.connections)) continue;
            const restored = normalizeSettings(candidate);
            if (restored.providers?.connections.length) {
              repaired = {
                ...restored,
                tracingEnabled: false,
                gatewayPaused: false
              };
              lostProviderSettings = false;
              break;
            }
          } catch { /* An invalid backup is not a recovery source. */ }
        }
      }
      // Only a confirmed damaged file may be rebuilt. A concurrent repair or
      // edit must not be replaced by this stale snapshot.
      const latest = await fs.promises.readFile(file);
      if (!latest.equals(original)) throw new Error('设置文件刚被其他软件修改，请重新点击修复。');
      const backupPath = `${file}.before-repair-${Date.now()}-${Math.random().toString(16).slice(2, 10)}.bak`;
      // Copy the on-disk bytes so the backup is exact; do not rename away the
      // live settings path while another process may still have it open.
      await fs.promises.copyFile(file, backupPath, fs.constants.COPYFILE_EXCL);
      if (!(await fs.promises.readFile(file)).equals(original)) {
        throw new Error('设置文件刚被其他软件修改，请重新点击修复。');
      }
      await writeJson(file, repaired);
      const persisted = await this.readUnlocked();
      if (this.readProblemValue) throw new Error('设置文件重建后仍无法读取；原文件备份已保留。');
      return { backupPath, settings: persisted, lostProviderSettings };
    });
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async read(): Promise<XwXDeckSettings> {
    const result = this.writeQueue.then(() => this.readUnlocked());
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readUnlocked(): Promise<XwXDeckSettings> {
    this.migrationProblemValue = undefined;
    this.providerIdentityPending = false;
    this.legacySettingsBackupNeeded = false;
    let value: XwXDeckSettings;
    try {
      let text: string | undefined;
      try { text = await fs.promises.readFile(this.path(), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parsed: unknown = text === undefined ? DEFAULT_SETTINGS : JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('设置文件必须为对象。');
      value = parsed as XwXDeckSettings;
      this.readProblemValue = undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        value = DEFAULT_SETTINGS;
        this.readProblemValue = undefined;
      } else {
        this.readProblemValue = {
          path: this.path(),
          message: `XwX Deck 设置文件无法解析，已使用安全默认值且禁止覆盖原文件：${errorMessage(error)}`
        };
        return normalizeSettings(DEFAULT_SETTINGS);
      }
    }
    let normalized: XwXDeckSettings;
    // Validate before inspecting legacy connections. Damaged settings keep the
    // existing explicit repair path instead of failing before the window opens.
    try { normalized = normalizeSettings(value); }
    catch (error) {
      this.readProblemValue = { path: this.path(), message: `服务连接配置无法解析，禁止覆盖原文件：${errorMessage(error)}` };
      return normalizeSettings(DEFAULT_SETTINGS);
    }
    this.legacySettingsBackupNeeded = value.providers?.identityVersion !== 2;
    let legacyActiveProvider: string | undefined;
    // Preserve the active literal key of pre-registry/older installations,
    // only for a managed identity or a connection with the exact configured URL.
    // never a hostname/name classifier for newly saved connections.
    if ((!value.providers || value.providers.identityVersion !== 2) && !value.codexEnhancements?.unifySessionHistory) {
      try {
        const config = await fs.promises.readFile(resolveClientPaths().codexConfigPath, 'utf8');
        const active = readTomlTopLevelString(rootToml(config), 'model_provider');
        const section = active && findTomlSection(config, `[model_providers.${active}]`);
        const activeUrl = section ? readTomlStringKey(config.slice(section.start, section.end), 'base_url') : undefined;
        const selected = value.providers?.connections.find(provider => provider.id === value.providers?.selected.codex);
        const historicalKey = active && active === 'xwx_deck';
        if (active && /^[A-Za-z0-9_-]{1,80}$/.test(active) && (historicalKey || !!activeUrl && activeUrl === selected?.baseUrl)) {
          legacyActiveProvider = active;
          if (value.providers) {
            value = { ...value, providers: { ...value.providers, connections: value.providers.connections.map(provider => (
              provider.id === value.providers!.selected.codex && !provider.codexProviderId
                ? { ...provider, codexProviderId: active } : provider
            )) } };
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.providerIdentityPending = true;
          this.migrationProblemValue = {
            path: resolveClientPaths().codexConfigPath,
            message: `升级配置迁移未完成：ChatGPT 配置暂时无法读取，服务和模型选择已保留。请在模型配置中继续操作，文件恢复可读后会重试迁移。原因：${errorMessage(error)}`
          };
          // Do not persist a guessed identity or mark migration complete. User
          // edits can still be saved while the optional lookup is unavailable.
          return normalizeSettings(value, true);
        }
      }
    }
    normalized = normalizeSettings(value);
    if (!value.providers && legacyActiveProvider && normalized.providers) {
      normalized = { ...normalized, providers: { ...normalized.providers, connections: normalized.providers.connections.map(provider => ({
        ...provider, codexProviderId: legacyActiveProvider
      })) } };
    }
    // Retire legacy limits independently of the current storage policy.
    // Explicit policy choices are preserved; missing fields use current defaults.
    if (value.maxSessions !== 0 || value.maxStorageMB !== 0
      || value.traceWarningGB !== normalized.traceWarningGB || !value.providers
      || providersNeedRegistryMigration(value.providers, normalized.providers)
      || codexContextWindowNeedsMigration(value, normalized)) {
      // Capture the exact pre-upgrade bytes once, including fields unknown to
      // this version. A failed backup must prevent the migration write.
      try {
        await this.backupLegacySettings();
        await writeJson(this.path(), normalized);
      } catch (error) {
        this.migrationProblemValue = {
          path: this.path(),
          message: `升级配置迁移未完成：设置已读取，但迁移备份或写入失败，原设置已保留。请检查文件权限、占用或磁盘空间后重试。原因：${errorMessage(error)}`
        };
      }
    }
    return normalized;
  }

  private async backupLegacySettings(): Promise<void> {
    if (!this.legacySettingsBackupNeeded) return;
    try { await fs.promises.copyFile(this.path(), `${this.path()}.before-provider-standardization.bak`, fs.constants.COPYFILE_EXCL); }
    catch (error) { if (!['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    this.legacySettingsBackupNeeded = false;
  }

  async ensureUnlimitedTraceRetention(): Promise<{ changed: boolean; persistedSettingsChanged: boolean; legacyLimitsFound: boolean; settings: XwXDeckSettings }> {
    const raw = await readJson<XwXDeckSettings | undefined>(this.path(), undefined);
    const legacyLimitsFound = !!raw && (positiveNumber(raw.maxSessions) || positiveNumber(raw.maxStorageMB));
    const persistedSettingsChanged = !!raw && (raw.maxSessions !== 0 || raw.maxStorageMB !== 0);
    const settings = await this.update({ maxSessions: 0, maxStorageMB: 0 });
    return { changed: legacyLimitsFound, persistedSettingsChanged, legacyLimitsFound, settings };
  }

  async update(patch: XwXDeckSettingsPatch): Promise<XwXDeckSettings> {
    const result = this.writeQueue.then(() => this.updateUnlocked(patch));
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async updateUnlocked(patch: XwXDeckSettingsPatch): Promise<XwXDeckSettings> {
    const current = await this.readUnlocked();
    if (this.readProblemValue) throw new Error(this.readProblemValue.message);
    let merged: XwXDeckSettings = {
      ...current,
      ...patch,
      clientEnabled: {
        ...current.clientEnabled,
        ...patch.clientEnabled
      },
      traceAppearance: {
        ...current.traceAppearance,
        ...patch.traceAppearance
      },
      claudeModels: {
        ...current.claudeModels,
        ...patch.claudeModels
      },
      claudeDesktop: {
        ...current.claudeDesktop,
        ...patch.claudeDesktop
      },
      compatible: {
        ...current.compatible,
        ...patch.compatible
      },
      codexModels: {
        ...current.codexModels,
        ...patch.codexModels
      },
      codexEnhancements: {
        ...current.codexEnhancements,
        ...patch.codexEnhancements
      }
    };
    if (!patch.providers && current.providers) {
      const registry = current.providers;
      const connectionPatch = patch.compatible;
      if (!registry.connections.length && connectionPatch?.baseUrl && connectionPatch?.bearerToken) {
        // An explicit save through the former single-service API creates its first user connection.
        merged = { ...merged, providers: undefined };
      } else {
        merged = { ...merged, providers: { ...registry, connections: registry.connections.map(provider => ({
          ...provider,
          ...(provider.id === registry.selected.codex ? {
            ...connectionPatch,
            ...(patch.codexModels?.compatible !== undefined ? { codexModel: patch.codexModels.compatible } : {}),
            ...(patch.codexModels?.compatibleContextWindow !== undefined ? { codexContextWindow: patch.codexModels.compatibleContextWindow } : {})
          } : {}),
          ...(provider.id === registry.selected.claude && patch.claudeModels ? { claudeModels: { ...provider.claudeModels, ...patch.claudeModels } } : {})
        })) } };
      }
    }
    const next = normalizeSettings(merged, this.providerIdentityPending);
    await this.backupLegacySettings();
    await writeJson(this.path(), next);
    return next;
  }
}

function normalizeSettings(value: XwXDeckSettings, preserveProviderIdentity = false): XwXDeckSettings {
  const normalized: XwXDeckSettings = {
    ...value,
    tracingEnabled: value.tracingEnabled === true,
    gatewayPaused: value.gatewayPaused === true,
    codexPreferredMode: value.codexPreferredMode === 'official' || value.codexPreferredMode === 'compatible'
      ? value.codexPreferredMode
      : 'auto',
    claudePreferredMode: value.claudePreferredMode === 'official' || value.claudePreferredMode === 'compatible'
      ? value.claudePreferredMode
      : 'auto',
    theme: value.theme === 'night' ? 'night' : 'day',
    traceAppearance: {
      skin: value.traceAppearance?.skin === 'clean' || value.traceAppearance?.skin === 'custom'
        ? value.traceAppearance.skin
        : 'classic',
      showThroughput: value.traceAppearance?.showThroughput !== false,
      customImageFile: cleanManagedFileName(value.traceAppearance?.customImageFile),
      customImageFit: value.traceAppearance?.customImageFit === 'contain' ? 'contain' : 'cover',
      customImageOverlay: clampInt(value.traceAppearance?.customImageOverlay, 0, 80, DEFAULT_TRACE_APPEARANCE.customImageOverlay)
    },
    startupEnabled: value.startupEnabled === true,
    // Legacy maxSessions/maxStorageMB stay pinned to zero; storage budgets are
    // only controlled by the explicit traceWarningGB/traceAutoCleanup policy
    // that the user can change from the Trace settings.
    maxSessions: 0,
    maxStorageMB: 0,
    traceWarningGB: typeof value.traceWarningGB === 'number' && Number.isSafeInteger(value.traceWarningGB)
      && value.traceWarningGB >= 0 && value.traceWarningGB <= 1024
      ? value.traceWarningGB : DEFAULT_TRACE_LIMIT_GB,
    traceAutoCleanup: typeof value.traceAutoCleanup === 'boolean'
      ? value.traceAutoCleanup : DEFAULT_TRACE_AUTO_CLEANUP,
    traceRoot: cleanDirectory(value.traceRoot),
    logRoot: cleanDirectory(value.logRoot),
    claudeConfigDir: cleanDirectory(value.claudeConfigDir),
    clientEnabled: {
      claude: value.clientEnabled?.claude !== false,
      codex: value.clientEnabled?.codex !== false
    },
    claudeModels: {
      fable: cleanModel(value.claudeModels?.fable),
      opus: cleanModel(value.claudeModels?.opus),
      sonnet: cleanModel(value.claudeModels?.sonnet),
      haiku: cleanModel(value.claudeModels?.haiku)
    },
    claudeDesktop: {
      syncEnabled: value.claudeDesktop?.syncEnabled === true
    },
    compatible: {
      providerPreset: normalizeProviderPreset(value.compatible?.providerPreset),
      displayName: cleanProviderDisplayName(
        value.compatible?.displayName,
        normalizeProviderPreset(value.compatible?.providerPreset)
      ),
      baseUrl: cleanConnectionValue(value.compatible?.baseUrl, 500),
      bearerToken: cleanConnectionValue(value.compatible?.bearerToken, 1000),
      codexApiFormat: value.compatible?.codexApiFormat === 'chat-completions'
        || value.compatible?.codexApiFormat === 'anthropic-messages'
        ? value.compatible.codexApiFormat
        : 'responses'
    },
    codexModels: {
      official: cleanModel(value.codexModels?.official) || DEFAULT_CODEX_MODELS.official,
      officialContextWindow: cleanContextWindow(value.codexModels?.officialContextWindow),
      compatible: cleanModel(value.codexModels?.compatible),
      compatibleContextWindow: cleanContextWindow(value.codexModels?.compatibleContextWindow)
    },
    codexEnhancements: {
      preserveOfficialLogin: value.codexEnhancements?.preserveOfficialLogin !== false,
      unifySessionHistory: value.codexEnhancements?.unifySessionHistory === true,
      pendingHistoryRestore: value.codexEnhancements?.pendingHistoryRestore === true
    }
  };
  const providers = normalizeProviders(value.providers, normalized, value === DEFAULT_SETTINGS, preserveProviderIdentity);
  const codex = providers.connections.find(p => p.id === providers.selected.codex);
  const claude = providers.connections.find(p => p.id === providers.selected.claude);
  return { ...normalized, providers,
    compatible: codex ? { displayName: codex.displayName, providerPreset: codex.providerPreset, baseUrl: codex.baseUrl, bearerToken: codex.bearerToken, codexApiFormat: codex.codexApiFormat } : DEFAULT_COMPATIBLE_SERVICE,
    codexModels: { ...normalized.codexModels, compatible: codex?.codexModel ?? normalized.codexModels.compatible, compatibleContextWindow: codex?.codexContextWindow ?? normalized.codexModels.compatibleContextWindow },
    claudeModels: claude?.claudeModels ?? normalized.claudeModels
  };
}

function cleanModel(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 120) : '';
}

function cleanContextWindow(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return 0;
  if (value < 16_384) return 0;
  return Math.min(value, 2_000_000);
}

function cleanConnectionValue(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function cleanProviderDisplayName(value: unknown, preset: ProviderPresetId): string {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, 80) || providerProfile(preset).defaultDisplayName
    : providerProfile(preset).defaultDisplayName;
}

function cleanDirectory(value: unknown): string {
  if (typeof value !== 'string') return '';
  const cleaned = value.trim().slice(0, 2000);
  return cleaned && path.isAbsolute(cleaned) ? path.normalize(cleaned) : '';
}

function cleanManagedFileName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const cleaned = path.basename(value.trim()).slice(0, 160);
  return /^trace-background\.(?:png|jpe?g|webp)$/i.test(cleaned) ? cleaned : '';
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function positiveNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeProviders(raw: ProviderRegistry | undefined, legacy: XwXDeckSettings, fresh = false, preserveIdentity = false): ProviderRegistry {
  if (!raw) {
    const configured = !!legacy.compatible.baseUrl || !!legacy.compatible.bearerToken;
    const initial: ProviderConnection = { id: 'initial-provider', ...legacy.compatible, adapter: 'auto',
      codexModel: legacy.codexModels.compatible, codexContextWindow: legacy.codexModels.compatibleContextWindow,
      claudeModels: legacy.claudeModels };
    return { version: 1, identityVersion: preserveIdentity ? undefined : 2, connections: configured ? [initial] : [], selected: { codex: configured ? initial.id : null, claude: configured ? initial.id : null } };
  }
  if (raw.version !== 1 || !Array.isArray(raw.connections) || !raw.selected) throw new Error('服务连接配置格式无效。');
  const ids = new Set<string>();
  const connections: ProviderConnection[] = raw.connections.map(p => {
    if (!p || typeof p.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id) || ids.has(p.id)) throw new Error('服务连接 ID 无效或重复。');
    ids.add(p.id);
    if (!['auto', 'responses', 'chat-completions', 'anthropic-messages'].includes(p.adapter)) throw new Error('不支持的服务连接类型。');
    return { ...p, id: p.id, codexProviderId: preserveIdentity ? p.codexProviderId : p.codexProviderId || 'xwx_deck', displayName: cleanConnectionValue(p.displayName, 80), providerPreset: normalizeProviderPreset(p.providerPreset),
      baseUrl: cleanConnectionValue(p.baseUrl, 2000), bearerToken: cleanConnectionValue(p.bearerToken, 4000), adapter: p.adapter,
      codexApiFormat: p.adapter !== 'auto' ? p.adapter : p.codexApiFormat === 'chat-completions' || p.codexApiFormat === 'anthropic-messages' ? p.codexApiFormat : 'responses',
      codexModel: cleanModel(p.codexModel), codexContextWindow: cleanContextWindow(p.codexContextWindow),
      claudeModels: { fable: cleanModel(p.claudeModels?.fable), opus: cleanModel(p.claudeModels?.opus), sonnet: cleanModel(p.claudeModels?.sonnet), haiku: cleanModel(p.claudeModels?.haiku) } };
  });
  const selected = (client: ProviderClient) => raw.selected[client] && ids.has(raw.selected[client]!) ? raw.selected[client] : null;
  return { ...raw, version: 1, identityVersion: preserveIdentity ? raw.identityVersion : 2, connections, selected: { codex: selected('codex'), claude: selected('claude') } };
}

function providersNeedRegistryMigration(
  raw: ProviderRegistry | undefined,
  normalized: ProviderRegistry | undefined
): boolean {
  if (!raw || !normalized) return false;
  if (raw.identityVersion !== 2 || raw.connections.length !== normalized.connections.length) return true;
  return normalized.connections.some(provider => {
    const stored = raw.connections.find(candidate => candidate.id === provider.id);
    return !stored
      || provider.codexProviderId !== stored.codexProviderId
      || provider.baseUrl !== stored.baseUrl
      || provider.adapter !== stored.adapter
      || provider.codexApiFormat !== stored.codexApiFormat
      || provider.codexModel !== stored.codexModel;
  });
}

/**
 * Keep legacy/custom context overrides instead of comparing them with the
 * canned selector variants. Only values outside Codex's safe integer range are
 * repaired and persisted during the normal settings read migration.
 */
function codexContextWindowNeedsMigration(
  raw: XwXDeckSettings,
  normalized: XwXDeckSettings
): boolean {
  const rawOfficial = raw.codexModels?.officialContextWindow;
  if (
    typeof rawOfficial === 'number'
    && cleanContextWindow(rawOfficial) !== rawOfficial
  ) return true;
  const rawConnections = raw.providers?.connections;
  const normalizedConnections = normalized.providers?.connections;
  if (!rawConnections || !normalizedConnections) return false;
  return rawConnections.some(rawProvider => {
    const normalizedProvider = normalizedConnections.find(candidate => candidate.id === rawProvider.id);
    return !!normalizedProvider
      && cleanContextWindow(rawProvider.codexContextWindow) !== rawProvider.codexContextWindow;
  });
}
export function selectedProvider(settings: XwXDeckSettings, client: ProviderClient): ProviderConnection | undefined {
  return settings.providers?.connections.find(p => p.id === settings.providers?.selected[client]);
}
