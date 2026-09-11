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
  readonly tracingEnabled: boolean;
  /** 用户显式关闭后台代理后的持久化暂停状态。 */
  readonly gatewayPaused: boolean;
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
  readonly compatible: CompatibleServiceSettings;
  readonly codexModels: CodexModelSettings;
  readonly codexEnhancements: CodexEnhancementSettings;
}

export type XwXDeckSettingsPatch = Omit<Partial<XwXDeckSettings>,
  'clientEnabled' | 'claudeModels' | 'compatible' | 'codexModels' | 'codexEnhancements' | 'traceAppearance'> & {
  readonly clientEnabled?: Partial<XwXDeckSettings['clientEnabled']>;
  readonly traceAppearance?: Partial<TraceAppearanceSettings>;
  readonly claudeModels?: Partial<ClaudeModelSettings>;
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
  theme: 'day',
  traceAppearance: DEFAULT_TRACE_APPEARANCE,
  startupEnabled: false,
  maxSessions: 0,
  maxStorageMB: 0,
  traceRoot: '',
  logRoot: '',
  claudeConfigDir: '',
  clientEnabled: {
    claude: true,
    codex: true
  },
  claudeModels: DEFAULT_CLAUDE_MODELS,
  compatible: DEFAULT_COMPATIBLE_SERVICE,
  codexModels: DEFAULT_CODEX_MODELS,
  codexEnhancements: DEFAULT_CODEX_ENHANCEMENTS
};

export class XwXDeckSettingsStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly userDataDir: string) {}

  path(): string {
    return path.join(this.userDataDir, 'settings.json');
  }

  async read(): Promise<XwXDeckSettings> {
    const value = await readJson<XwXDeckSettings>(this.path(), DEFAULT_SETTINGS);
    return normalizeSettings(value);
  }

  async update(patch: XwXDeckSettingsPatch): Promise<XwXDeckSettings> {
    const result = this.writeQueue.then(() => this.updateUnlocked(patch));
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async updateUnlocked(patch: XwXDeckSettingsPatch): Promise<XwXDeckSettings> {
    const current = await this.read();
    const next = normalizeSettings({
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
    });
    await writeJson(this.path(), next);
    return next;
  }
}

function normalizeSettings(value: XwXDeckSettings): XwXDeckSettings {
  return {
    tracingEnabled: value.tracingEnabled === true,
    gatewayPaused: value.gatewayPaused === true,
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
    // XwX Deck never deletes Trace history automatically. Keep these
    // serialized compatibility fields pinned to zero and reject unsupported
    // renderer or configuration patches that try to revive retention budgets.
    maxSessions: 0,
    maxStorageMB: 0,
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
}

function cleanModel(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 120) : '';
}

function cleanContextWindow(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 16_384 && value <= 2_000_000
    ? value
    : 0;
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
