/**
 * XwX Trace 客户端配置接管编排：把 detect / apply / restore / 启动自愈 串起来。
 *
 * TapController 只跟这个对象打交道：
 *   - enable() 启用监听时调 `apply(localBaseUrl)`，得到「成功接管的客户端 + 真实上游」
 *     列表，传给 TapProxy 作为 fallback 路由。
 *   - disable() 关闭监听时调 `restoreAll()`，逐个把 backup 写回。
 *   - extension 启动时调 `recoverOnStartup(probeTapPort)` 处理上次崩溃的残留。
 */

import * as os from 'os';
import { log } from '../shared/logger';
import { parsePort } from '../shared/url';
import { ClientBackupStore } from './clientBackupStore';
import {
  ClientDetectionResult,
  ClientPaths,
  detectClaudeUpstream,
  detectCodexUpstream,
  resolveClientPaths,
  CodexRouteKind,
  ClaudeUnavailable,
  CodexUnavailable
} from './clientConfig';
import { ClientConfigWriter, ClientRestoreResult } from './clientConfigWriter';

export interface ClientTakeoverResult {
  readonly client: 'claude-cli' | 'codex-cli';
  readonly status: 'taken' | 'skipped';
  /** taken：识别到的真实上游 baseUrl（用于代理 fallback）。 */
  readonly upstreamBaseUrl?: string;
  /** taken：codex 专用，转发时是否要 strip /v1。 */
  readonly stripV1?: boolean;
  /** taken：Codex 当前走官方 ChatGPT OAuth、官方 API，还是自定义 provider。 */
  readonly codexRouteKind?: CodexRouteKind;
  /** skipped：跳过原因，UI 友好展示。 */
  readonly skipReason?: 'no-config' | 'bedrock-mode' | 'cloud-provider-mode' | 'parse-error' | 'write-failed' | 'loopback-residue' | 'missing-provider-base-url' | 'environment-override';
  /** taken：用户配置文件路径，UI 上展示位置用。 */
  readonly configPath?: string;
}

export interface ClientPreflightResult {
  readonly client: 'claude-cli' | 'codex-cli';
  readonly status: 'ready' | 'skipped';
  readonly configPath?: string;
  readonly upstreamBaseUrl?: string;
  readonly source: 'environment' | 'default' | 'settings' | 'oauth' | 'provider';
  readonly skipReason?: ClientTakeoverResult['skipReason'];
  readonly conflicts: readonly string[];
}

export interface PortProbe {
  (port: number, timeoutMs?: number): Promise<boolean>;
}

export class ClientConfigOrchestrator {
  constructor(
    private readonly backup: ClientBackupStore,
    private readonly writer: ClientConfigWriter,
    private readonly paths: ClientPaths | (() => ClientPaths) = resolveClientPaths(),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Read-only readiness pass performed immediately before Trace is enabled. */
  preflight(clients?: { readonly claude?: boolean; readonly codex?: boolean }): ClientPreflightResult[] {
    const results: ClientPreflightResult[] = [];
    const paths = this.clientPaths();
    if (clients?.claude !== false) results.push(preflightResult(detectClaudeUpstream(paths, this.env), this.env));
    if (clients?.codex !== false) results.push(preflightResult(detectCodexUpstream(paths), this.env));
    return results;
  }

  /**
   * Build the route table that must be live before any client config points at
   * the local proxy. This is intentionally read-only; apply() performs the
   * conflict-safe disk transaction only after the controller has published and
   * probed these routes.
   */
  plan(clients?: { readonly claude?: boolean; readonly codex?: boolean }): ClientTakeoverResult[] {
    const results: ClientTakeoverResult[] = [];
    const paths = this.clientPaths();
    if (clients?.claude !== false) results.push(takeoverFromDetection(detectClaudeUpstream(paths, this.env)));
    if (clients?.codex !== false) results.push(takeoverFromDetection(detectCodexUpstream(paths)));
    return results;
  }

  /**
   * Rebuild routes from the original field-safe snapshots while a healthy
   * background Gateway keeps the live files on localhost. This is read-only:
   * manager restart never flashes config.toml/settings.json back to upstream.
   */
  async planFromLiveBackups(
    localBaseUrl: string,
    clients?: { readonly claude?: boolean; readonly codex?: boolean }
  ): Promise<ClientTakeoverResult[]> {
    const paths = this.clientPaths();
    const results: ClientTakeoverResult[] = [];
    if (clients?.claude !== false) {
      const backup = await this.backup.read('claude');
      results.push(backup && sameLocalEndpoint(backup.writtenLocalUrl, localBaseUrl)
        ? takeoverFromDetection(detectClaudeUpstream(paths, this.env, { text: backup.originalContent }))
        : takeoverFromDetection(detectClaudeUpstream(paths, this.env)));
    }
    if (clients?.codex !== false) {
      const backup = await this.backup.read('codex');
      results.push(backup && sameLocalEndpoint(backup.writtenLocalUrl, localBaseUrl)
        ? takeoverFromDetection(detectCodexUpstream(paths, { text: backup.originalContent }))
        : takeoverFromDetection(detectCodexUpstream(paths)));
    }
    return results;
  }

  async applyOrResume(
    localBaseUrl: string,
    now: Date = new Date(),
    clients?: { readonly claude?: boolean; readonly codex?: boolean }
  ): Promise<ClientTakeoverResult[]> {
    const planned = await this.planFromLiveBackups(localBaseUrl, clients);
    const results: ClientTakeoverResult[] = [];
    for (const plan of planned) {
      const kind = plan.client === 'claude-cli' ? 'claude' : 'codex';
      const backup = await this.backup.read(kind);
      if (backup && sameLocalEndpoint(backup.writtenLocalUrl, localBaseUrl)) {
        results.push(plan);
      } else {
        results.push(await this.applyOne(plan.client, localBaseUrl, now));
      }
    }
    return results;
  }

  /**
   * 接管所有可接管的 CLI 客户端，把 baseUrl 改写为本地代理。
   * 返回每个客户端的接管/跳过结果，TapController 用结果填 fallback routes 和 sidebar 状态。
   * `clients` 可选过滤：对应项为 false 的客户端跳过接管（用户在侧栏关掉了该 CLI 的追踪）。
   */
  async apply(
    localBaseUrl: string,
    now: Date = new Date(),
    clients?: { readonly claude?: boolean; readonly codex?: boolean }
  ): Promise<ClientTakeoverResult[]> {
    const results: ClientTakeoverResult[] = [];
    if (clients?.claude !== false) results.push(await this.applyClaude(localBaseUrl, now));
    if (clients?.codex !== false) results.push(await this.applyCodex(localBaseUrl, now));
    return results;
  }

  /** 运行中单独接管一个客户端（侧栏子开关从关切到开）。 */
  async applyOne(
    client: 'claude-cli' | 'codex-cli',
    localBaseUrl: string,
    now: Date = new Date()
  ): Promise<ClientTakeoverResult> {
    return client === 'claude-cli'
      ? this.applyClaude(localBaseUrl, now)
      : this.applyCodex(localBaseUrl, now);
  }

  /** 运行中单独还原一个客户端的配置（侧栏子开关从开切到关）。 */
  async restoreOne(client: 'claude-cli' | 'codex-cli'): Promise<ClientRestoreResult | undefined> {
    const kind = client === 'claude-cli' ? 'claude' : 'codex';
    const rec = await this.backup.read(kind);
    if (!rec) return;
    const result = await this.writer.restore(rec);
    for (const conflict of result.conflicts) {
      log.warn(`[xwx/trace] preserved external ${rec.client} config change: ${conflict}`);
    }
    return result;
  }

  private async applyClaude(localBaseUrl: string, now: Date): Promise<ClientTakeoverResult> {
    const detection = detectClaudeUpstream(this.clientPaths(), this.env);
    if (isUnavailable(detection)) {
      return clientFromUnavailable(detection);
    }
    try {
      await this.writer.applyClaude({ detection, localProxyUrl: localBaseUrl, now });
      return {
        client: 'claude-cli',
        status: 'taken',
        upstreamBaseUrl: detection.baseUrl,
        configPath: detection.configPath
      };
    } catch (err) {
      log.warn(`[compatible/tap] failed to take over Claude config: ${(err as Error).message}`);
      return { client: 'claude-cli', status: 'skipped', skipReason: 'write-failed', configPath: detection.configPath };
    }
  }

  private async applyCodex(localBaseUrl: string, now: Date): Promise<ClientTakeoverResult> {
    const detection = detectCodexUpstream(this.clientPaths());
    if (isUnavailable(detection)) {
      return clientFromUnavailable(detection);
    }
    try {
      await this.writer.applyCodex({ detection, localProxyUrl: localBaseUrl, now });
      return {
        client: 'codex-cli',
        status: 'taken',
        upstreamBaseUrl: detection.baseUrl,
        stripV1: detection.stripV1,
        codexRouteKind: detection.routeKind,
        configPath: detection.configPath
      };
    } catch (err) {
      log.warn(`[compatible/tap] failed to take over Codex config: ${(err as Error).message}`);
      return { client: 'codex-cli', status: 'skipped', skipReason: 'write-failed', configPath: detection.configPath };
    }
  }

  /** 关闭 XwX Trace 时调：把磁盘上所有 backup 全部写回 + 删除。 */
  async restoreAll(): Promise<readonly ClientRestoreResult[]> {
    const records = await this.backup.listAll();
    const results: ClientRestoreResult[] = [];
    const failures: Error[] = [];
    for (const rec of records) {
      try {
        const result = await this.writer.restore(rec);
        results.push(result);
        for (const conflict of result.conflicts) {
          log.warn(`[xwx/trace] preserved external ${rec.client} config change: ${conflict}`);
        }
      } catch (err) {
        log.warn(`[compatible/tap] failed to restore ${rec.client} config (${rec.configPath}): ${(err as Error).message}`);
        failures.push(err as Error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `有 ${failures.length} 个客户端配置未能安全恢复`);
    }
    return results;
  }

  /**
   * Read-only safety check used immediately before a forced helper stop.
   * Host + port are the dependency boundary; client-specific path suffixes do
   * not change which local Gateway process must remain alive.
   */
  clientsPointingAt(localBaseUrl: string): readonly ('claude-cli' | 'codex-cli')[] {
    const paths = this.clientPaths();
    const detections = [
      detectClaudeUpstream(paths, this.env),
      detectCodexUpstream(paths)
    ];
    return detections
      .filter(detection => {
        const upstreamBaseUrl = isUnavailable(detection)
          ? detection.upstreamBaseUrl
          : detection.baseUrl;
        return !!upstreamBaseUrl && sameLocalEndpoint(upstreamBaseUrl, localBaseUrl);
      })
      .map(detection => detection.client);
  }

  /**
   * 启动自愈：扫所有 backup，探测里面记录的本地代理端口是不是死的。
   * 死端口对应的是「XwX Trace 上次没正常关闭」的残留 → 强制 restore。
   * 活端口对应的是「另一个窗口的 XwX Trace 还活着」（跟 tapPortLock owner 共享），不动。
   */
  async recoverOnStartup(probe: PortProbe): Promise<void> {
    const records = await this.backup.listAll();
    for (const rec of records) {
      const port = parsePort(rec.writtenLocalUrl);
      const alive = port !== undefined ? await probe(port).catch(() => false) : false;
      if (alive) continue;
      try {
        const result = await this.writer.restore(rec);
        for (const conflict of result.conflicts) {
          log.warn(`[xwx/trace] startup recovery preserved external ${rec.client} change: ${conflict}`);
        }
        log(`[compatible/tap] recovered stale ${rec.client} config from previous session (${rec.configPath})`);
      } catch (err) {
        log.warn(`[compatible/tap] failed to recover ${rec.client} config: ${(err as Error).message}`);
      }
    }
  }

  private clientPaths(): ClientPaths {
    return typeof this.paths === 'function' ? this.paths() : this.paths;
  }
}

function sameLocalEndpoint(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    const host = (value: string): string => (
      value === '127.0.0.1' || value === 'localhost' || value === '::1'
        ? 'loopback'
        : value.toLowerCase()
    );
    return host(a.hostname) === host(b.hostname) && a.port === b.port;
  } catch {
    return false;
  }
}

function isUnavailable(
  detection: ClientDetectionResult
): detection is ClaudeUnavailable | CodexUnavailable {
  return 'reason' in (detection as { reason?: unknown });
}

function clientFromUnavailable(detection: ClaudeUnavailable | CodexUnavailable): ClientTakeoverResult {
  return {
    client: detection.client,
    status: 'skipped',
    skipReason: detection.reason,
    configPath: detection.configPath,
    upstreamBaseUrl: detection.upstreamBaseUrl,
  };
}

function takeoverFromDetection(detection: ClientDetectionResult): ClientTakeoverResult {
  if (isUnavailable(detection)) return clientFromUnavailable(detection);
  if (detection.client === 'claude-cli') {
    return {
      client: detection.client,
      status: 'taken',
      upstreamBaseUrl: detection.baseUrl,
      configPath: detection.configPath
    };
  }
  return {
    client: detection.client,
    status: 'taken',
    upstreamBaseUrl: detection.baseUrl,
    stripV1: detection.stripV1,
    codexRouteKind: detection.routeKind,
    configPath: detection.configPath
  };
}

function preflightResult(
  detection: ClientDetectionResult,
  env: NodeJS.ProcessEnv,
): ClientPreflightResult {
  const conflicts = detection.client === 'claude-cli'
    ? ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']
      .filter(key => !!env[key])
      .map(key => `环境变量 ${key} 已设置`)
    : ['OPENAI_API_KEY'].filter(key => !!env[key]).map(key => `环境变量 ${key} 已设置`);
  if (isUnavailable(detection)) {
    const environmentBaseUrl = env.ANTHROPIC_BASE_URL?.trim();
    const fromEnvironment = detection.client === 'claude-cli'
      && !!environmentBaseUrl
      && detection.upstreamBaseUrl === environmentBaseUrl;
    return {
      client: detection.client,
      status: 'skipped',
      configPath: detection.configPath,
      upstreamBaseUrl: detection.upstreamBaseUrl,
      source: fromEnvironment || detection.reason === 'environment-override' ? 'environment' : 'settings',
      skipReason: detection.reason,
      conflicts,
    };
  }
  const source = detection.client === 'claude-cli'
    ? (detection.hadExplicitValue ? 'settings' : 'default')
    : detection.routeKind === 'custom-provider'
      ? 'provider'
      : detection.routeKind === 'chatgpt-oauth'
        ? 'oauth'
        : (detection.hadExplicitValue ? 'settings' : 'default');
  return {
    client: detection.client,
    status: 'ready',
    configPath: detection.configPath,
    upstreamBaseUrl: detection.baseUrl,
    source,
    conflicts,
  };
}


export function defaultClientPaths(env: NodeJS.ProcessEnv = process.env): ClientPaths {
  return resolveClientPaths(env, os.homedir());
}

// Re-exports for callers
export type { ClaudeDetection, CodexDetection } from './clientConfig';
