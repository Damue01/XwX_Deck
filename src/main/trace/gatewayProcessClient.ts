import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { writeFileAtomic } from '../shared/fsx';
import { log } from '../shared/logger';
import { ViewerHandler } from './tapProxy';
import { GATEWAY_HELPER_BUILD_ID, GATEWAY_HELPER_PROTOCOL_VERSION } from './gatewayProtocol';
import type { GatewayCapturedClient, GatewayTraceRetention } from './gatewayProtocol';
import { probeLocalTcpPort, probeTapPort } from './tapPortLock';
import { TraceProxy } from './traceProxy';
import { TapClientRoute, TapRoute, TapTraceRecord } from './types';

interface GatewayRuntimeRecord {
  readonly version: 1;
  readonly helperProtocolVersion?: number;
  readonly helperBuildId?: string;
  readonly pid: number;
  readonly gatewayPort: number;
  readonly controlPort: number;
  readonly traceRoot: string;
  readonly startedAt: string;
}

interface GatewayStatus {
  readonly helperProtocolVersion?: number;
  readonly helperBuildId?: string;
  readonly gatewayPort: number;
  readonly activeRequests: number;
  readonly pendingContinuations: number;
  readonly recording: boolean;
  readonly generation: number;
  readonly traceRetention?: GatewayTraceRetention;
  readonly capturedClients?: readonly GatewayCapturedClient[];
}

const START_TIMEOUT_MS = 15_000;
const UPGRADE_RETRY_MS = 1_000;
const UPGRADE_QUIET_PERIOD_MS = 1_000;
const CONTROL_STATUS_RETRY_MS = 75;
const CONTROL_STATUS_TIMEOUT_MS = 1_000;
type GatewayAttachmentState = 'attached' | 'missing' | 'uncertain';
type GatewayAttachmentProbe =
  | {
      readonly state: 'attached';
      readonly runtime: GatewayRuntimeRecord;
      readonly token: string;
      readonly status: GatewayStatus;
    }
  | {
      readonly state: 'uncertain';
      readonly runtime: GatewayRuntimeRecord;
      readonly token: string;
      readonly error?: unknown;
    }
  | {
      readonly state: 'missing';
      readonly recoverableRuntime?: GatewayRuntimeRecord;
    };

export class GatewayProcessClient implements TraceProxy {
  readonly background = true;
  private runtime: GatewayRuntimeRecord | undefined;
  private token = '';
  private routes: TapRoute[] = [];
  private clientRoutes: TapClientRoute[] = [];
  private fallbackBaseUrl: string | undefined;
  private fallbackProxyUrl: string | undefined;
  private recording = false;
  private generation = 0;
  private syncedGeneration = -1;
  private syncChain: Promise<void> = Promise.resolve();
  private lifecycleChain: Promise<void> = Promise.resolve();
  private desiredRunning = false;
  private status: GatewayStatus | undefined;
  private helperUpgradePending = false;
  /**
   * Once an older helper has owned a client-visible endpoint, its replacement
   * must reclaim that exact port. Keep the requirement across failed retries;
   * choosing a fallback would leave ChatGPT pointed at a dead localhost URL.
   */
  private helperUpgradePort: number | undefined;
  private helperUpgradeTimer: ReturnType<typeof setTimeout> | undefined;
  private deferredCodexProviderAdoption: 'official' | 'compatible' | undefined;
  private controlUncertainKey: string | undefined;

  constructor(
    private readonly userDataDir: string,
    private readonly traceRoot: string,
    private readonly listenPorts?: readonly number[],
    private readonly canAbandonStaleContinuations: () => Promise<boolean> = async () => false,
    private readonly lifecycleHooks: {
      readonly beforeUpgradeReplacement?: () => Promise<void>;
      readonly traceRetention?: () => GatewayTraceRetention;
    } = {}
  ) {}

  setRecordingEnabled(enabled: boolean): void {
    this.recording = enabled;
    this.queueSync();
  }

  isRecordingEnabled(): boolean {
    return this.recording;
  }

  setRoutes(routes: readonly TapRoute[], fallbackBaseUrl: string | undefined, fallbackProxyUrl?: string): void {
    this.routes = routes.map(route => ({ ...route }));
    this.fallbackBaseUrl = fallbackBaseUrl;
    this.fallbackProxyUrl = fallbackProxyUrl;
    this.queueSync();
  }

  setClientRoutes(routes: readonly TapClientRoute[]): void {
    this.clientRoutes = routes.map(route => ({ ...route }));
    this.queueSync();
  }

  hasClientRoute(source: TapClientRoute['source'], routePath: string): boolean {
    return this.clientRoutes.some(route => route.source === source && route.path === routePath);
  }

  async start(): Promise<string> {
    this.desiredRunning = true;
    return this.serializeLifecycle(() => this.startUnlocked());
  }

  private async startUnlocked(): Promise<string> {
    if (!this.desiredRunning) throw new Error('XwX Gateway 启动已被关闭请求取消。');
    const attachment = await this.attach();
    if (attachment === 'uncertain') throw new GatewayControlUnavailableError();
    if (attachment === 'missing') await this.spawnAndAttach(this.requiredStartPorts());
    if (!this.runtime) throw new Error('XwX Gateway helper 未返回运行状态。');
    return `http://127.0.0.1:${this.runtime.gatewayPort}`;
  }

  async stop(): Promise<void> {
    // Publish the stop intent before waiting for an in-progress upgrade. The
    // upgrade path re-checks this immediately before spawning its replacement.
    this.desiredRunning = false;
    this.clearHelperUpgradeTimer();
    try {
      await this.serializeLifecycle(() => this.stopUnlocked());
    } catch (error) {
      if (this.runtime) {
        this.desiredRunning = true;
        this.scheduleHelperUpgradeRetry();
      }
      throw error;
    }
  }

  async forceStop(): Promise<void> {
    this.desiredRunning = false;
    this.clearHelperUpgradeTimer();
    await this.serializeLifecycle(() => this.forceStopUnlocked());
  }

  private async forceStopUnlocked(): Promise<void> {
    const runtime = this.runtime ?? await readRuntime(this.runtimeFile());
    const token = this.token || await fs.promises.readFile(this.tokenFile(), 'utf8')
      .then(value => value.trim())
      .catch(() => '');
    if (runtime) {
      if (token) {
        await this.requestControl(runtime, token, '/control/stop', {}, 'POST', 750).catch(error => {
          log.warn(`[gateway] graceful force-exit stop failed: ${(error as Error).message}`);
        });
      }
      await this.waitForHelperExit(runtime, token, 1_500).catch(() => undefined);
      if (processAlive(runtime.pid)) {
        try { process.kill(runtime.pid, 'SIGTERM'); } catch { /* already gone */ }
        await waitForProcessExit(runtime.pid, 750);
      }
      if (processAlive(runtime.pid)) {
        try { process.kill(runtime.pid, 'SIGKILL'); } catch { /* already gone */ }
        await waitForProcessExit(runtime.pid, 1_000);
      }
    }
    await Promise.all([
      fs.promises.rm(this.runtimeFile(), { force: true }).catch(() => undefined),
      fs.promises.rm(this.tokenFile(), { force: true }).catch(() => undefined),
      fs.promises.rm(this.bootstrapFile(), { force: true }).catch(() => undefined)
    ]);
    this.runtime = undefined;
    this.status = undefined;
    this.token = '';
    this.helperUpgradePending = false;
    this.helperUpgradePort = undefined;
    this.deferredCodexProviderAdoption = undefined;
  }

  private async stopUnlocked(): Promise<void> {
    const attachment = await this.attach();
    if (attachment === 'uncertain') throw new GatewayControlUnavailableError();
    if (attachment === 'attached') {
      const runtime = this.runtime!;
      const token = this.token;
      await this.request('/control/stop', {});
      await this.waitForHelperExit(runtime, token);
    }
    this.runtime = undefined;
    this.status = undefined;
    this.helperUpgradePending = false;
    this.helperUpgradePort = undefined;
    this.deferredCodexProviderAdoption = undefined;
  }

  localBaseUrl(): string | undefined {
    return this.runtime ? `http://127.0.0.1:${this.runtime.gatewayPort}` : undefined;
  }

  isListening(): boolean {
    return !!this.runtime;
  }

  activeRequestCount(): number {
    return this.status?.activeRequests ?? 0;
  }

  pendingContinuationCount(): number {
    return this.status?.pendingContinuations ?? 0;
  }

  capturedClientIds(): readonly GatewayCapturedClient[] {
    return (this.status?.capturedClients ?? [])
      .filter((value): value is GatewayCapturedClient => value === 'claude-cli' || value === 'codex-cli');
  }

  async refreshShutdownActivity(): Promise<void> {
    if (!this.runtime) return;
    const probe = await this.probeAttachment();
    if (probe.state === 'attached') {
      this.runtime = probe.runtime;
      this.token = probe.token;
      this.status = probe.status;
      this.controlUncertainKey = undefined;
      return;
    }
    if (probe.state === 'uncertain') {
      this.noteUncertainControl(probe);
      throw new GatewayControlUnavailableError();
    }
    this.runtime = undefined;
    this.status = undefined;
    this.controlUncertainKey = undefined;
  }

  abandonCodexContinuations(): void {
    void this.request('/control/abandon-continuations', {}).catch(error => {
      log.warn(`[gateway] abandon continuations failed: ${(error as Error).message}`);
    });
  }

  async prepareForShutdown(options: { timeoutMs?: number; quietPeriodMs?: number } = {}): Promise<boolean> {
    const result = await this.request<{ prepared: boolean; status: GatewayStatus }>('/control/prepare-shutdown', options);
    this.status = result.status;
    return result.prepared;
  }

  async forcePrepareForShutdown(): Promise<void> {
    try {
      const result = await this.request<{ status: GatewayStatus }>('/control/force-prepare-shutdown', {});
      this.status = result.status;
    } catch (error) {
      // A manager may still be attached to a pre-v7 helper while that helper
      // has an active request and therefore cannot yet be upgraded. Preserve
      // the live endpoint until configuration restoration; stop() will sever
      // the old helper only after clients have been detached from localhost.
      if (isUnsupportedControlEndpoint(error)) {
        log.warn('[gateway] legacy helper has no force-abort gate; deferring connection abort until final stop');
        return;
      }
      throw error;
    }
  }

  cancelPreparedShutdown(): void {
    void this.request('/control/cancel-shutdown', {}).catch(error => {
      log.warn(`[gateway] cancel shutdown failed: ${(error as Error).message}`);
    });
  }

  async markCodexProviderTransition(source: 'official' | 'compatible', target: 'official' | 'compatible'): Promise<void> {
    await this.request('/control/portability/mark-transition', { source, target });
  }

  async adoptCodexProviderOnStartup(target: 'official' | 'compatible'): Promise<boolean> {
    try {
      const result = await this.request<{ adopted: boolean }>('/control/portability/adopt', { target });
      return result.adopted;
    } catch (error) {
      // Protocol-less helpers predate portability control endpoints. Keep their
      // live data plane serving, then replay adoption immediately after the
      // lifecycle queue replaces them with the current helper.
      if (this.helperUpgradePending && isUnsupportedControlEndpoint(error)) {
        this.deferredCodexProviderAdoption = target;
        log(`[gateway] deferred Codex provider adoption until legacy helper upgrade (${target})`);
        return false;
      }
      throw error;
    }
  }

  async repairCodexHistoryForProvider(target: 'official' | 'compatible') {
    return this.request<{
      changedFiles: number;
      removedItems: number;
      removedUnencryptedReasoningItems?: number;
      normalizedMessageIds?: number;
      backupRoot?: string;
    }>(
      '/control/portability/repair', { target }
    );
  }

  async restoreLegacyOfficialHistory() {
    return this.request<{ changedFiles: number; restoredItems: number; backupRoot?: string }>(
      '/control/portability/restore-legacy', {}
    );
  }

  async clearHistory(): Promise<void> {
    await this.request('/control/clear-history', {});
  }

  setViewerHandler(_handler: ViewerHandler | undefined): void {}
  broadcastTrace(_trace: TapTraceRecord): void {}
  broadcastReset(): void {}

  async synchronize(): Promise<void> {
    await this.serializeLifecycle(() => this.synchronizeUnlocked());
  }

  private async synchronizeUnlocked(): Promise<void> {
    if (!this.desiredRunning) return;
    await this.syncChain;
    await this.flushSync();
    await this.upgradeHelperIfIdleUnlocked();
    if (!this.helperUpgradePending) await this.flushDeferredCodexProviderAdoption();
  }

  private async flushSync(): Promise<void> {
    if (!this.runtime || this.syncedGeneration === this.generation) return;
    const generation = this.generation;
    const status = await this.request<GatewayStatus>('/control/configure', {
      generation,
      routes: this.routes,
      clientRoutes: this.clientRoutes,
      fallbackBaseUrl: this.fallbackBaseUrl,
      fallbackProxyUrl: this.fallbackProxyUrl,
      recording: this.recording,
      traceRetention: this.configuredTraceRetention()
    });
    if (status.generation !== generation) {
      throw new Error(`XwX Gateway 拒绝了过期路由代次（sent=${generation}, active=${status.generation}）。`);
    }
    this.status = status;
    this.syncedGeneration = generation;
  }

  private queueSync(): void {
    this.generation += 1;
    if (!this.runtime) return;
    this.syncChain = this.syncChain.then(() => this.flushSync(), () => this.flushSync());
  }

  private async attach(): Promise<GatewayAttachmentState> {
    const probe = await this.probeAttachment();
    if (probe.state === 'attached') {
      this.acceptAttachment(probe.runtime, probe.token, probe.status);
      return 'attached';
    }
    if (probe.state === 'uncertain') {
      this.noteUncertainControl(probe);
      return 'uncertain';
    }
    if (probe.recoverableRuntime) this.helperUpgradePort ??= probe.recoverableRuntime.gatewayPort;
    this.runtime = undefined;
    this.status = undefined;
    this.controlUncertainKey = undefined;
    return 'missing';
  }

  private async probeAttachment(): Promise<GatewayAttachmentProbe> {
    const candidates: Array<{
      runtime: GatewayRuntimeRecord;
      token: string;
      traceRootMatches: boolean;
    }> = [];
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const runtime = await readRuntime(this.runtimeFile());
      const token = await fs.promises.readFile(this.tokenFile(), 'utf8')
        .then(value => value.trim())
        .catch(() => '');
      if (runtime) {
        const candidate = {
          runtime,
          token,
          traceRootMatches: path.normalize(runtime.traceRoot) === path.normalize(this.traceRoot)
        };
        candidates.push(candidate);
        if (token && candidate.traceRootMatches) {
          try {
            const status = await this.requestControl<GatewayStatus>(
              runtime,
              token,
              '/control/status',
              undefined,
              'GET',
              CONTROL_STATUS_TIMEOUT_MS
            );
            if (status.gatewayPort !== runtime.gatewayPort) {
              throw new Error(
                `Gateway runtime/status port mismatch (${runtime.gatewayPort} != ${status.gatewayPort}).`
              );
            }
            return { state: 'attached', runtime, token, status };
          } catch (error) {
            lastError = error;
          }
        }
      }
      if (attempt === 0) await delay(CONTROL_STATUS_RETRY_MS);
    }

    for (const candidate of [...candidates].reverse()) {
      if (!await this.hasLiveHelperEvidence(candidate.runtime)) continue;
      return {
        state: 'uncertain',
        runtime: candidate.runtime,
        token: candidate.token,
        error: lastError
      };
    }

    const recoverable = [...candidates].reverse().find(candidate => candidate.traceRootMatches);
    return { state: 'missing', recoverableRuntime: recoverable?.runtime };
  }

  private noteUncertainControl(probe: Extract<GatewayAttachmentProbe, { state: 'uncertain' }>): void {
    const sameRuntime = this.runtime?.pid === probe.runtime.pid
      && this.runtime.gatewayPort === probe.runtime.gatewayPort
      && this.runtime.controlPort === probe.runtime.controlPort;
    this.runtime = probe.runtime;
    this.token = probe.token;
    if (!sameRuntime) this.status = undefined;
    const uncertainKey = `${probe.runtime.pid}:${probe.runtime.gatewayPort}:${probe.runtime.controlPort}`;
    if (this.controlUncertainKey === uncertainKey) return;
    this.controlUncertainKey = uncertainKey;
    log.warn(
      `[gateway] control status unavailable while helper evidence remains live`
      + ` pid=${probe.runtime.pid} gateway=:${probe.runtime.gatewayPort}`
      + ` control=:${probe.runtime.controlPort}`
      + `${probe.error ? `: ${(probe.error as Error).message}` : ''}`
    );
  }

  private acceptAttachment(
    runtime: GatewayRuntimeRecord,
    token: string,
    status: GatewayStatus
  ): void {
    this.runtime = runtime;
    this.token = token;
    this.status = status;
    this.controlUncertainKey = undefined;
    const identityMismatch = !helperIdentityMatches(runtime, status);
    if (identityMismatch && this.helperUpgradePort === undefined) {
      this.helperUpgradePort = runtime.gatewayPort;
    }
    const endpointMismatch = this.helperUpgradePort !== undefined
      && runtime.gatewayPort !== this.helperUpgradePort;
    this.helperUpgradePending = identityMismatch || endpointMismatch;
    if (!this.helperUpgradePending) this.helperUpgradePort = undefined;
    // Do not publish constructor defaults over a helper that is already
    // serving ChatGPT. The controller rebuilds and atomically publishes the
    // complete route generation after startup recovery.
    this.generation = Math.max(this.generation, status.generation);
    this.syncedGeneration = this.generation;
  }

  private async hasLiveHelperEvidence(runtime: GatewayRuntimeRecord): Promise<boolean> {
    const [gatewayAlive, controlAlive] = await Promise.all([
      probeTapPort(runtime.gatewayPort, 250),
      probeLocalTcpPort(runtime.controlPort, 250)
    ]);
    return gatewayAlive || controlAlive || processAlive(runtime.pid);
  }

  private configuredTraceRetention(): GatewayTraceRetention {
    const configured = this.lifecycleHooks.traceRetention?.();
    const maxSessions = typeof configured?.maxSessions === 'number' && Number.isFinite(configured.maxSessions)
      ? Math.max(0, Math.floor(configured.maxSessions))
      : 0;
    const maxStorageBytes = typeof configured?.maxStorageBytes === 'number' && Number.isFinite(configured.maxStorageBytes)
      ? Math.max(0, Math.floor(configured.maxStorageBytes))
      : 0;
    return { maxSessions, maxStorageBytes };
  }

  /**
   * A manager may outlive an installation replacement because the detached
   * helper owns the data plane. Keep the old helper serving while a model
   * request or tool-call continuation exists, then replace it in-place once
   * its shutdown gate proves the connection is idle. The manager's complete
   * route generation is republished before the new helper accepts traffic.
   */
  private async upgradeHelperIfIdleUnlocked(): Promise<void> {
    if (!this.desiredRunning || !this.helperUpgradePending) return;
    await this.performHelperUpgrade();
  }

  private async performHelperUpgrade(): Promise<void> {
    if (!this.desiredRunning) return;
    const attachment = await this.attach();
    if (attachment !== 'attached' || !this.runtime || !this.status) {
      this.scheduleHelperUpgradeRetry();
      if (attachment === 'uncertain') {
        log.warn('[gateway] helper upgrade deferred while control status is uncertain');
      }
      return;
    }
    const oldRuntime = this.runtime;
    let latest = this.status;
    if (helperIdentityMatches(oldRuntime, latest)
      && (this.helperUpgradePort === undefined || oldRuntime.gatewayPort === this.helperUpgradePort)) {
      this.helperUpgradePending = false;
      this.helperUpgradePort = undefined;
      this.clearHelperUpgradeTimer();
      return;
    }
    if (latest.activeRequests === 0 && latest.pendingContinuations > 0) {
      let canAbandon = false;
      try { canAbandon = await this.canAbandonStaleContinuations(); }
      catch (error) {
        log.warn(`[gateway] could not verify whether stale continuations are safe to clear: ${(error as Error).message}`);
      }
      if (canAbandon) {
        try {
          latest = await this.request<GatewayStatus>('/control/abandon-continuations', {});
          this.status = latest;
          log('[gateway] cleared stale continuations after confirming ChatGPT exited');
        } catch (error) {
          // Some protocol-less helpers predate this endpoint. Do not fail
          // manager startup and do not kill an ungated data plane: keep it
          // serving until an explicit full stop or OS restart clears the
          // in-memory continuation safely.
          if (isUnsupportedControlEndpoint(error)) {
            log.warn('[gateway] legacy helper cannot clear stale continuations; keeping its data plane alive until a safe full stop');
            return;
          }
          this.scheduleHelperUpgradeRetry();
          log.warn(`[gateway] could not clear stale continuations: ${(error as Error).message}`);
          return;
        }
      }
    }
    if (latest.activeRequests > 0 || latest.pendingContinuations > 0) {
      this.scheduleHelperUpgradeRetry();
      log(`[gateway] helper upgrade deferred; active=${latest.activeRequests}, continuations=${latest.pendingContinuations}`);
      return;
    }

    let prepared = false;
    try {
      const result = await this.request<{ prepared: boolean; status: GatewayStatus }>(
        '/control/prepare-shutdown',
        { timeoutMs: 0, quietPeriodMs: UPGRADE_QUIET_PERIOD_MS }
      );
      prepared = result.prepared;
      this.status = result.status;
    } catch (error) {
      // An unknown older helper is safer left alive than killed from an
      // ungated status snapshot. A later manager run can retry the handshake.
      this.scheduleHelperUpgradeRetry();
      log.warn(`[gateway] helper upgrade gate unavailable: ${(error as Error).message}`);
      return;
    }
    if (!prepared) {
      this.scheduleHelperUpgradeRetry();
      return;
    }

    const previousProtocol = oldRuntime.helperProtocolVersion ?? latest.helperProtocolVersion ?? 'legacy';
    const previousBuild = oldRuntime.helperBuildId ?? latest.helperBuildId ?? 'unknown';
    try {
      if (!this.desiredRunning) return;
      await this.request('/control/stop', {});
      await this.waitForHelperExit(oldRuntime, this.token);
      this.runtime = undefined;
      this.status = undefined;
      await this.lifecycleHooks.beforeUpgradeReplacement?.();
      if (!this.desiredRunning) return;
      this.helperUpgradePort ??= oldRuntime.gatewayPort;
      await this.spawnAndAttach([this.helperUpgradePort]);
      await this.flushSync();
      await this.flushDeferredCodexProviderAdoption();
      this.helperUpgradePending = false;
      this.clearHelperUpgradeTimer();
      log(
        `[gateway] upgraded helper ${previousProtocol}/${shortBuildId(previousBuild)}`
        + ` -> ${GATEWAY_HELPER_PROTOCOL_VERSION}/${shortBuildId(GATEWAY_HELPER_BUILD_ID)}`
      );
    } catch (error) {
      // If another manager won the same upgrade race, the next start/attach
      // adopts its current helper. Never overwrite a live helper token here.
      this.runtime = undefined;
      this.status = undefined;
      this.scheduleHelperUpgradeRetry();
      log.error(`[gateway] helper upgrade failed: ${(error as Error).message}`);
    }
  }

  private scheduleHelperUpgradeRetry(): void {
    if (!this.desiredRunning || !this.helperUpgradePending || this.helperUpgradeTimer) return;
    this.helperUpgradeTimer = setTimeout(() => {
      this.helperUpgradeTimer = undefined;
      void this.serializeLifecycle(async () => {
        if (!this.desiredRunning) return;
        await this.startUnlocked();
        await this.synchronizeUnlocked();
      })
        .catch(error => {
          log.warn(`[gateway] deferred helper upgrade failed: ${(error as Error).message}`);
          this.scheduleHelperUpgradeRetry();
        });
    }, UPGRADE_RETRY_MS);
    this.helperUpgradeTimer.unref?.();
  }

  private requiredStartPorts(): readonly number[] | undefined {
    return this.helperUpgradePort === undefined ? this.listenPorts : [this.helperUpgradePort];
  }

  private clearHelperUpgradeTimer(): void {
    if (this.helperUpgradeTimer) clearTimeout(this.helperUpgradeTimer);
    this.helperUpgradeTimer = undefined;
  }

  private async flushDeferredCodexProviderAdoption(): Promise<void> {
    const target = this.deferredCodexProviderAdoption;
    if (!target || !this.runtime) return;
    const result = await this.request<{ adopted: boolean }>('/control/portability/adopt', { target });
    this.deferredCodexProviderAdoption = undefined;
    if (result.adopted) log(`[gateway] completed deferred Codex provider adoption (${target})`);
  }

  private serializeLifecycle<T>(action: () => Promise<T>): Promise<T> {
    const result = this.lifecycleChain.then(action, action);
    this.lifecycleChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async waitForHelperExit(runtime: GatewayRuntimeRecord, token: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let controlAlive = true;
      try {
        await this.requestControl(runtime, token, '/control/status', undefined, 'GET');
      }
      catch { controlAlive = false; }
      const gatewayAlive = await probeLocalTcpPort(runtime.gatewayPort, 100);
      if (!controlAlive && !gatewayAlive && !processAlive(runtime.pid)) return;
      await delay(100);
    }
    throw new Error('旧 XwX Gateway 未在安全关闭后释放端口。');
  }

  private async spawnAndAttach(listenPorts = this.listenPorts): Promise<void> {
    await fs.promises.mkdir(this.controlDir(), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.bootstrapFile(), `${JSON.stringify({
      generation: this.generation,
      routes: this.routes,
      clientRoutes: this.clientRoutes,
      fallbackBaseUrl: this.fallbackBaseUrl,
      fallbackProxyUrl: this.fallbackProxyUrl,
      recording: this.recording,
      traceRetention: this.configuredTraceRetention()
    })}\n`);
    await fs.promises.chmod(this.bootstrapFile(), 0o600).catch(() => undefined);
    this.token = randomBytes(32).toString('hex');
    await writeFileAtomic(this.tokenFile(), `${this.token}\n`);
    await fs.promises.chmod(this.tokenFile(), 0o600).catch(() => undefined);
    await fs.promises.rm(this.runtimeFile(), { force: true }).catch(() => undefined);
    const helperPath = path.join(__dirname, 'gateway-helper.js');
    const child = spawn(process.execPath, [helperPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        XwX_GATEWAY_USER_DATA: this.userDataDir,
        XwX_GATEWAY_TRACE_ROOT: this.traceRoot,
        XwX_GATEWAY_LISTEN_PORTS: listenPorts?.join(',') ?? ''
      }
    });
    child.unref();
    let childExit: Error | undefined;
    let childAttached = false;
    child.once('error', error => { childExit = error; });
    child.once('exit', (code, signal) => {
      if (!childAttached) {
        childExit = new Error(`XwX Gateway 后台进程提前退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）。`);
      }
    });
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const attachment = await this.attach();
      if (attachment === 'attached') {
        childAttached = true;
        // This helper has no prior live route generation. Force the first
        // synchronize call to publish the manager's prepared state.
        this.syncedGeneration = -1;
        return;
      }
      if (childExit) throw childExit;
      await delay(100);
    }
    throw new Error('XwX Gateway 后台进程启动超时；配置未切换到本地代理。');
  }

  private async request<T = unknown>(pathname: string, body?: unknown, method = 'POST'): Promise<T> {
    const runtime = this.runtime;
    if (!runtime) throw new Error('XwX Gateway 后台进程未连接。');
    return this.requestControl(runtime, this.token, pathname, body, method);
  }

  private async requestControl<T = unknown>(
    runtime: GatewayRuntimeRecord,
    token: string,
    pathname: string,
    body?: unknown,
    method = 'POST',
    timeoutMs = 5_000
  ): Promise<T> {
    const payload = body === undefined ? '' : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: runtime.controlPort,
        path: pathname,
        method,
        timeout: timeoutMs,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
        }
      }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('aborted', () => reject(new Error('Gateway control response aborted.')));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode ?? 500) >= 400) {
            reject(new GatewayControlError(res.statusCode ?? 500, text || `Gateway control returned ${res.statusCode}`));
            return;
          }
          try { resolve((text ? JSON.parse(text) : {}) as T); }
          catch (error) { reject(error); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('Gateway control request timed out.')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  private controlDir(): string { return path.join(this.userDataDir, 'gateway'); }
  private runtimeFile(): string { return path.join(this.controlDir(), 'runtime.json'); }
  private tokenFile(): string { return path.join(this.controlDir(), 'control.token'); }
  private bootstrapFile(): string { return path.join(this.controlDir(), 'bootstrap.json'); }
}

class GatewayControlError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'GatewayControlError';
  }
}

class GatewayControlUnavailableError extends Error {
  constructor() {
    super('XwX Gateway 数据面仍可能运行，但控制通道暂时不可用；未启动替代进程，请稍后重试。');
    this.name = 'GatewayControlUnavailableError';
  }
}

async function readRuntime(file: string): Promise<GatewayRuntimeRecord | undefined> {
  try {
    const value = JSON.parse(await fs.promises.readFile(file, 'utf8')) as GatewayRuntimeRecord;
    if (value.version !== 1 || !Number.isInteger(value.pid) || !Number.isInteger(value.gatewayPort)
      || !Number.isInteger(value.controlPort) || typeof value.traceRoot !== 'string') return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function helperIdentityMatches(runtime: GatewayRuntimeRecord, status: GatewayStatus): boolean {
  return runtime.helperProtocolVersion === GATEWAY_HELPER_PROTOCOL_VERSION
    && status.helperProtocolVersion === GATEWAY_HELPER_PROTOCOL_VERSION
    && runtime.helperBuildId === GATEWAY_HELPER_BUILD_ID
    && status.helperBuildId === GATEWAY_HELPER_BUILD_ID;
}

function shortBuildId(value: string): string {
  return /^[0-9a-f]{64}$/i.test(value) ? value.slice(0, 12) : value;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processAlive(pid)) await delay(50);
}

function isUnsupportedControlEndpoint(error: unknown): boolean {
  return error instanceof GatewayControlError && (error.statusCode === 404 || error.statusCode === 405);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
