/**
 * 探测 Claude Code CLI / Codex CLI 的本地配置，识别真实上游 baseUrl。
 *
 * 跟 claude-tap 的 _detect_claude_target / _detect_codex_target 同语义：
 * 读取用户已有的 settings.json / config.toml，按 claude-tap 的回退顺序找出
 * CLI 真实会走的 baseUrl。XwX Trace 用这个值作为代理转发的 upstream，
 * 同时把 settings 中的 baseUrl 字段临时改写成本地代理地址。
 *
 * 这里**只做读 + 算**，不做任何文件改写。改写动作在 `clientConfigWriter`。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { providerBaseHasVersionRoot } from '../../shared/providerProfiles';
import { readTextOrUndefinedSync } from '../shared/fsx';
import { isRecord } from '../shared/obj';
import { findTomlSection, readTomlStringKey, readTomlTopLevelString } from './toml';

/** Claude Code 默认上游（用户没配也没设环境变量时）。 */
export const CLAUDE_DEFAULT_TARGET = 'https://api.anthropic.com';
/** Codex CLI 默认上游。 */
export const CODEX_DEFAULT_TARGET = 'https://api.openai.com';
/** Codex 当 wire_api=responses 且 upstream 是 openai.com 时，需要 strip 掉 URL 中的 /v1 前缀。 */
export const OPENAI_OFFICIAL_HOST = 'api.openai.com';
/**
 * Codex ChatGPT 订阅 OAuth 模式的真实上游。与 codex-rs `CHATGPT_CODEX_BASE_URL`
 * 一致。注意它不含 /v1 尾缀，但 Codex 入站仍发 /v1/responses，转发时必须 strip /v1
 * 才能拼出 `<base>/responses`。
 */
export const CODEX_CHATGPT_OAUTH_TARGET = 'https://chatgpt.com/backend-api';
/** Base URL used by a custom provider that authenticates with a ChatGPT subscription. */
export const CODEX_CHATGPT_OAUTH_PROVIDER_TARGET = `${CODEX_CHATGPT_OAUTH_TARGET}/codex`;
/** XwX Deck keeps this provider id stable across official, 兼容服务, and Trace modes. */
export const CODEX_STABLE_PROVIDER = 'xwx_deck';

export function isXwXManagedProvider(provider: string): boolean {
  return provider === CODEX_STABLE_PROVIDER;
}

/** Claude modes that bypass the normal Anthropic HTTP gateway contract. */
export const CLAUDE_CLOUD_PROVIDER_ENV_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS'
] as const;

export type CodexRouteKind = 'chatgpt-oauth' | 'openai-api' | 'custom-provider';
export type CodexFieldLocation = 'provider-section' | 'openai-base-url' | 'chatgpt-base-url';

export interface ClaudeDetection {
  readonly client: 'claude-cli';
  readonly configPath: string;
  /** 真实上游 baseUrl（用于代理转发与 disable 时的还原）。 */
  readonly baseUrl: string;
  /** settings.json 是否已经显式写了 `env.ANTHROPIC_BASE_URL`。false=默认值兜底。 */
  readonly hadExplicitValue: boolean;
}

export interface ClaudeUnavailable {
  readonly client: 'claude-cli';
  readonly reason: 'no-config' | 'bedrock-mode' | 'cloud-provider-mode' | 'parse-error' | 'loopback-residue' | 'environment-override';
  readonly configPath?: string;
  readonly upstreamBaseUrl?: string;
}

export interface CodexDetection {
  readonly client: 'codex-cli';
  /** 接管模式：chatgpt 订阅 OAuth，或 API key / 默认官方。 */
  readonly mode: 'chatgpt-oauth' | 'api-key';
  readonly configPath: string;
  /** 当前 `model_provider` 值（用来定位 `[model_providers.<id>]` section）。 */
  readonly provider: string;
  /** 决定本地代理接收官方 ChatGPT、官方 API，还是第三方 provider 的请求。 */
  readonly routeKind: CodexRouteKind;
  /** 真实上游 baseUrl。 */
  readonly baseUrl: string;
  /** 改写时是用 toml section 内的 `base_url` 键，还是顶层 `openai_base_url` 键。 */
  readonly fieldLocation: CodexFieldLocation;
  /**
   * 转发时是否要从入站请求 path 前缀里 strip 掉 `/v1`。
   * Codex 协议入站 path 永远是 `/v1/responses` / `/v1/chat/completions`；
   * 当 codex `base_url` 已经以 `/v1` 结尾时（兼容服务 / 官方推荐写法），
   * 必须 strip 一次否则会拼出双 `/v1` 让 FastAPI 上游 404。
   */
  readonly stripV1: boolean;
  /** 原配置是否显式写了对应键；false 表示我们落了 default fallback。 */
  readonly hadExplicitValue: boolean;
}

export interface CodexUnavailable {
  readonly client: 'codex-cli';
  readonly reason: 'no-config' | 'parse-error' | 'loopback-residue' | 'missing-provider-base-url';
  readonly configPath?: string;
  readonly upstreamBaseUrl?: string;
}

export type ClientDetection = ClaudeDetection | CodexDetection;
export type ClientUnavailable = ClaudeUnavailable | CodexUnavailable;
export type ClientDetectionResult = ClientDetection | ClientUnavailable;

export interface ClientPaths {
  readonly homeDir: string;
  readonly claudeSettingsPath: string;
  readonly codexConfigPath: string;
  readonly codexAuthPath: string;
}

export interface ClientPathOverrides {
  readonly claudeConfigDir?: string;
}

export function resolveClientPaths(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = (env.XWX_DECK_CLIENT_HOME && env.XWX_DECK_CLIENT_HOME.trim()) || os.homedir(),
  overrides: ClientPathOverrides = {}
): ClientPaths {
  const codexHome = (env.CODEX_HOME && env.CODEX_HOME.trim()) || path.join(homeDir, '.codex');
  // CLAUDE_CONFIG_DIR is interpreted by Claude Code itself and therefore has
  // to win over XwX Deck's persisted fallback. Otherwise the UI can report a
  // successful write to a file that the CLI never reads.
  const claudeHome = cleanDirectoryOverride(env.CLAUDE_CONFIG_DIR)
    || cleanDirectoryOverride(overrides.claudeConfigDir)
    || path.join(homeDir, '.claude');
  return {
    homeDir,
    claudeSettingsPath: resolveClaudeSettingsPath(claudeHome),
    codexConfigPath: path.join(codexHome, 'config.toml'),
    codexAuthPath: path.join(codexHome, 'auth.json')
  };
}

/** Prefer the current filename, but keep using legacy claude.json when it is the only live file. */
export function resolveClaudeSettingsPath(claudeHome: string): string {
  const current = path.join(claudeHome, 'settings.json');
  if (fs.existsSync(current)) return current;
  const legacy = path.join(claudeHome, 'claude.json');
  return fs.existsSync(legacy) ? legacy : current;
}

// -- claude ---------------------------------------------------------------

export function detectClaudeUpstream(
  paths: ClientPaths,
  env: NodeJS.ProcessEnv = process.env,
  contentOverride?: { readonly text: string | undefined }
): ClaudeDetection | ClaudeUnavailable {
  // Cloud provider modes use provider-specific authentication/signing and do
  // not follow the normal Anthropic gateway contract.
  const environmentProviderMode = claudeCloudProviderMode(undefined, env);
  if (environmentProviderMode) {
    return {
      client: 'claude-cli',
      reason: environmentProviderMode === 'CLAUDE_CODE_USE_BEDROCK' ? 'bedrock-mode' : 'cloud-provider-mode',
      configPath: paths.claudeSettingsPath
    };
  }
  // A shell-level base URL wins over settings.json. XwX Deck cannot rewrite the
  // environment of an already-running terminal, so pretending the disk patch
  // took effect would report a false successful takeover.
  const environmentBaseUrl = env.ANTHROPIC_BASE_URL?.trim();
  if (environmentBaseUrl) {
    return {
      client: 'claude-cli',
      reason: isLoopbackUrl(environmentBaseUrl) ? 'loopback-residue' : 'environment-override',
      configPath: paths.claudeSettingsPath,
      upstreamBaseUrl: environmentBaseUrl,
    };
  }
  const text = contentOverride ? contentOverride.text : readTextOrUndefinedSync(paths.claudeSettingsPath);
  if (text === undefined) {
    return { client: 'claude-cli', reason: 'no-config', configPath: paths.claudeSettingsPath };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { client: 'claude-cli', reason: 'parse-error', configPath: paths.claudeSettingsPath };
  }
  const settingsProviderMode = claudeCloudProviderMode(data, {});
  if (settingsProviderMode) {
    return {
      client: 'claude-cli',
      reason: settingsProviderMode === 'CLAUDE_CODE_USE_BEDROCK' ? 'bedrock-mode' : 'cloud-provider-mode',
      configPath: paths.claudeSettingsPath
    };
  }
  const baseUrl = readClaudeSettingsBaseUrl(data);
  // 配置里是 loopback = 上次会话残留（崩溃 / 备份被污染后没还原干净）。
  // 绝不能静默回退到官方 api.anthropic.com —— 那会把 兼容服务 的 key 转发给
  // Anthropic 官方 API，全部 401（2026-06-11 事故）。拒绝接管，让用户先恢复配置。
  if (baseUrl !== undefined && isLoopbackUrl(baseUrl)) {
    return { client: 'claude-cli', reason: 'loopback-residue', configPath: paths.claudeSettingsPath, upstreamBaseUrl: baseUrl };
  }
  return {
    client: 'claude-cli',
    configPath: paths.claudeSettingsPath,
    baseUrl: baseUrl ?? CLAUDE_DEFAULT_TARGET,
    hadExplicitValue: baseUrl !== undefined
  };
}

export function readClaudeSettingsBaseUrl(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const env = data.env;
  if (!isRecord(env)) return undefined;
  const value = env.ANTHROPIC_BASE_URL;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

export function claudeCloudProviderMode(
  data: unknown,
  env: NodeJS.ProcessEnv = process.env
): typeof CLAUDE_CLOUD_PROVIDER_ENV_KEYS[number] | undefined {
  const settingsEnv = isRecord(data) && isRecord(data.env) ? data.env : undefined;
  return CLAUDE_CLOUD_PROVIDER_ENV_KEYS.find(key => (
    isTruthy(env[key]) || isTruthy(settingsEnv?.[key])
  ));
}

// -- codex ----------------------------------------------------------------

export function detectCodexUpstream(
  paths: ClientPaths,
  contentOverride?: { readonly text: string | undefined }
): CodexDetection | CodexUnavailable {
  // ChatGPT 订阅 OAuth：默认真实上游是 chatgpt.com/backend-api/codex。
  // 但用户显式选择自定义 provider（例如 兼容服务）时，必须尊重 provider.base_url；
  // 否则登录 OpenAI 账号会把 兼容服务 配置短路回官方后端。
  let chatgptOauth = false;
  const authText = readTextOrUndefinedSync(paths.codexAuthPath);
  if (authText !== undefined) {
    try {
      const auth = JSON.parse(authText);
      if (isRecord(auth) && auth.auth_mode === 'chatgpt') {
        chatgptOauth = true;
      }
    } catch { /* auth.json 坏了不致命：按非 chatgpt 处理 */ }
  }
  const text = contentOverride ? contentOverride.text : readTextOrUndefinedSync(paths.codexConfigPath);
  if (text === undefined) {
    // 无 config.toml：仍可接管。用顶层 openai_base_url 覆盖内建 openai provider，
    // 转发时由 mode 决定真实上游与是否 strip /v1。
    return {
      client: 'codex-cli',
      mode: chatgptOauth ? 'chatgpt-oauth' : 'api-key',
      configPath: paths.codexConfigPath,
      provider: 'openai',
      routeKind: chatgptOauth ? 'chatgpt-oauth' : 'openai-api',
      baseUrl: chatgptOauth ? CODEX_CHATGPT_OAUTH_TARGET : CODEX_DEFAULT_TARGET,
      fieldLocation: 'openai-base-url',
      stripV1: !chatgptOauth && baseUrlHasV1Suffix(CODEX_DEFAULT_TARGET),
      hadExplicitValue: false
    };
  }
  const provider = readTomlTopLevelString(text, 'model_provider')?.trim() || 'openai';
  if (provider === 'openai') {
    const routeKind: CodexRouteKind = chatgptOauth ? 'chatgpt-oauth' : 'openai-api';
    // Model traffic and workspace/account traffic must use separate roots.
    // New Desktop versions require chatgpt_base_url to remain HTTPS.
    const fieldLocation: CodexFieldLocation = 'openai-base-url';
    const modelBaseUrl = readTomlTopLevelString(text, 'openai_base_url')?.trim();
    const configuredBaseUrl = modelBaseUrl || (chatgptOauth
      ? readTomlTopLevelString(text, 'chatgpt_base_url')?.trim()
      : undefined);
    if (configuredBaseUrl && isLoopbackUrl(configuredBaseUrl)) {
      return { client: 'codex-cli', reason: 'loopback-residue', configPath: paths.codexConfigPath, upstreamBaseUrl: configuredBaseUrl };
    }
    const selectedBaseUrl = configuredBaseUrl || (chatgptOauth ? CODEX_CHATGPT_OAUTH_TARGET : CODEX_DEFAULT_TARGET);
    const baseUrl = chatgptOauth ? selectedBaseUrl.replace(/\/codex\/?$/i, '') : selectedBaseUrl;
    return {
      client: 'codex-cli',
      mode: chatgptOauth ? 'chatgpt-oauth' : 'api-key',
      configPath: paths.codexConfigPath,
      provider,
      routeKind,
      baseUrl,
      fieldLocation,
      stripV1: !chatgptOauth && baseUrlHasV1Suffix(baseUrl),
      hadExplicitValue: configuredBaseUrl !== undefined
    };
  }
  // 1) 先看 `[model_providers.<provider>].base_url`
  const section = findTomlSection(text, `[model_providers.${provider}]`);
  if (section) {
    const sectionText = text.slice(section.start, section.end);
    const baseUrl = readTomlStringKey(sectionText, 'base_url')?.trim();
    // loopback = 上次会话残留。绝不能回退默认官方 api.openai.com（会把 兼容服务 key
    // 发给 OpenAI 官方 → 401 invalid_api_key，2026-06-11 事故），拒绝接管。
    if (baseUrl && isLoopbackUrl(baseUrl)) {
      return { client: 'codex-cli', reason: 'loopback-residue', configPath: paths.codexConfigPath, upstreamBaseUrl: baseUrl };
    }
    if (baseUrl) {
      if (isXwXManagedProvider(provider) && chatgptOauth && isChatGptProviderBaseUrl(baseUrl)) {
        return {
          client: 'codex-cli',
          mode: 'chatgpt-oauth',
          configPath: paths.codexConfigPath,
          provider,
          routeKind: 'chatgpt-oauth',
          // TapProxy's ChatGPT route preserves `/codex` from the inbound path,
          // so its upstream base intentionally stops at `/backend-api`.
          baseUrl: CODEX_CHATGPT_OAUTH_TARGET,
          fieldLocation: 'provider-section',
          stripV1: false,
          hadExplicitValue: true
        };
      }
      return {
        client: 'codex-cli',
        mode: chatgptOauth ? 'chatgpt-oauth' : 'api-key',
        configPath: paths.codexConfigPath,
        provider,
        routeKind: 'custom-provider',
        baseUrl,
        fieldLocation: 'provider-section',
        stripV1: baseUrlHasV1Suffix(baseUrl),
        hadExplicitValue: true
      };
    }
  }
  return { client: 'codex-cli', reason: 'missing-provider-base-url', configPath: paths.codexConfigPath };
}

// -- utils ----------------------------------------------------------------

function isTruthy(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v !== 'string' || !v) return false;
  const t = v.trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'yes' || t === 'on';
}

function cleanDirectoryOverride(value: string | undefined): string {
  if (!value?.trim()) return '';
  return path.isAbsolute(value.trim()) ? path.normalize(value.trim()) : '';
}

/**
 * 用 `<base>/v1` 形式配置的 codex provider（兼容服务、Azure OpenAI 兼容代理等）
 * 在转发时必须把入站 `/v1/...` 的前缀剥掉，否则会拼成 `<base>/v1/v1/...`。
 */
export function baseUrlHasV1Suffix(url: string): boolean {
  return providerBaseHasVersionRoot(url);
}

/**
 * 判定 baseUrl 是否指向本机 loopback 接口。XwX Trace 自己的代理就跑在 loopback 上，
 * 一旦 detector 把 loopback 当作 upstream，转发会与 兼容服务 完全脱节并形成
 * 自调用循环。这种值只可能是上次未正常关闭后的残留，必须忽略。
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost') return true;
    if (host === '::1') return true;
    if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

function isChatGptProviderBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === 'chatgpt.com'
      && parsed.pathname.replace(/\/+$/, '') === '/backend-api/codex';
  } catch {
    return false;
  }
}
