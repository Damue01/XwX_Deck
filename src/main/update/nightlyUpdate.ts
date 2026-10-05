import { createHash } from 'crypto';

/**
 * Unattended nightly update policy.
 *
 * XwX Deck checks for updates once shortly after launch. In addition, while
 * the tray app keeps running overnight, it checks once per night inside a fixed
 * local window, downloads silently, and installs only when the machine has been
 * idle and the safe-shutdown inspection needs no confirmation. Anything that
 * would require a prompt (active conversation, ChatGPT must exit first, user at
 * the keyboard) defers to the next tick or the next night; it never asks.
 *
 * This module stays free of Electron so the policy can be regression-tested.
 */

export const NIGHTLY_WINDOW_START_HOUR = 2;
export const NIGHTLY_WINDOW_END_HOUR = 5;
/** Spread client checks/downloads over the first part of the window. */
export const NIGHTLY_START_JITTER_MS = 90 * 60_000;
export const NIGHTLY_TICK_MS = 10 * 60_000;
export const NIGHTLY_IDLE_THRESHOLD_SECONDS = 15 * 60;

export type NightlyUpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error'
  | 'portable';

export interface NightlyUpdaterView {
  readonly status: NightlyUpdateStatus;
  readonly supported: boolean;
  readonly installMode: 'automatic' | 'manual-dmg';
  readonly updateAvailable: boolean;
  readonly targetVersion?: string;
}

export interface NightlyUpdateSnapshot {
  readonly now: Date;
  readonly updater: NightlyUpdaterView;
  readonly jitterMs: number;
  readonly systemIdleSeconds: number;
  readonly busy: boolean;
  readonly declinedVersion?: string;
  /** Last check started by this scheduler or by startup/manual checks. */
  readonly lastCheckAt?: number;
  /** Night key (YYYY-MM-DD of the window start) of the last install attempt. */
  readonly installAttemptNight?: string;
  /** Night key of the last unattended download attempt. */
  readonly downloadAttemptNight?: string;
}

export type NightlyUpdateAction = 'none' | 'check' | 'download' | 'install';

export interface NightlyUpdateDecision {
  readonly action: NightlyUpdateAction;
  readonly reason: string;
}

export function nightlyWindowStart(now: Date): Date {
  const start = new Date(now);
  start.setHours(NIGHTLY_WINDOW_START_HOUR, 0, 0, 0);
  return start;
}

export function isWithinNightlyWindow(now: Date): boolean {
  const hour = now.getHours();
  return hour >= NIGHTLY_WINDOW_START_HOUR && hour < NIGHTLY_WINDOW_END_HOUR;
}

export function nightKey(now: Date): string {
  const start = nightlyWindowStart(now);
  const month = String(start.getMonth() + 1).padStart(2, '0');
  const day = String(start.getDate()).padStart(2, '0');
  return `${start.getFullYear()}-${month}-${day}`;
}

/** Stable per machine and per night, so one client does not always go first. */
export function nightlyJitterMs(seed: string, now: Date): number {
  const digest = createHash('sha256').update(`${seed}\u0000${nightKey(now)}`).digest();
  return digest.readUInt32BE(0) % NIGHTLY_START_JITTER_MS;
}

export function decideNightlyUpdateAction(snapshot: NightlyUpdateSnapshot): NightlyUpdateDecision {
  const { now, updater } = snapshot;
  if (!updater.supported || updater.installMode !== 'automatic') {
    return { action: 'none', reason: 'unattended install unsupported' };
  }
  if (!isWithinNightlyWindow(now)) return { action: 'none', reason: 'outside nightly window' };
  const windowStart = nightlyWindowStart(now).getTime();
  if (now.getTime() < windowStart + snapshot.jitterMs) {
    return { action: 'none', reason: 'waiting for this client\'s nightly slot' };
  }
  if (snapshot.busy) return { action: 'none', reason: 'application busy' };
  if (snapshot.declinedVersion === '*' || updater.targetVersion && snapshot.declinedVersion === updater.targetVersion) {
    return { action: 'none', reason: `user cancelled ${updater.targetVersion}` };
  }
  const tonight = nightKey(now);
  switch (updater.status) {
    case 'checking':
    case 'downloading':
    case 'installing':
      return { action: 'none', reason: `update ${updater.status}` };
    case 'ready':
      if (snapshot.installAttemptNight === tonight) {
        return { action: 'none', reason: 'install already attempted tonight' };
      }
      if (snapshot.systemIdleSeconds < NIGHTLY_IDLE_THRESHOLD_SECONDS) {
        return { action: 'none', reason: 'user recently active' };
      }
      return { action: 'install', reason: 'downloaded update and idle machine' };
    case 'available':
      if (!updater.updateAvailable) break;
      if (snapshot.downloadAttemptNight === tonight) {
        return { action: 'none', reason: 'download already attempted tonight' };
      }
      return { action: 'download', reason: 'update available' };
    default:
      break;
  }
  if (snapshot.lastCheckAt !== undefined && snapshot.lastCheckAt >= windowStart) {
    return { action: 'none', reason: 'already checked tonight' };
  }
  return { action: 'check', reason: 'nightly check' };
}

export type NightlyInstallOutcome =
  | { readonly kind: 'started' }
  | { readonly kind: 'deferred'; readonly reason: string };

export interface NightlyUpdateSchedulerDeps {
  readonly seed: string;
  readonly declinedVersion?: () => string | undefined;
  readonly updater: () => NightlyUpdaterView;
  readonly check: () => Promise<void>;
  readonly download: () => Promise<void>;
  readonly install: () => Promise<NightlyInstallOutcome>;
  readonly systemIdleSeconds: () => number;
  readonly busy: () => boolean;
  readonly now?: () => Date;
  readonly logger?: {
    info(message: string): void;
    warn(message: string): void;
  };
}

export class NightlyUpdateScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private lastCheckAt: number | undefined;
  private installAttemptNight: string | undefined;
  private downloadAttemptNight: string | undefined;
  private declinedVersion: string | undefined;
  private lastLoggedReason = '';

  constructor(private readonly deps: NightlyUpdateSchedulerDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), NIGHTLY_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Startup and manual checks count as the latest check. */
  recordCheck(at = this.now().getTime()): void {
    this.lastCheckAt = at;
  }

  /** The user's latest choice wins: a cancelled version is not auto-installed. */
  decline(version: string | undefined): void {
    if (version) this.declinedVersion = version;
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runSteps().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runSteps(): Promise<void> {
    // check -> download -> install can chain within one tick.
    for (let step = 0; step < 3; step += 1) {
      const now = this.now();
      const decision = decideNightlyUpdateAction({
        now,
        updater: this.deps.updater(),
        jitterMs: nightlyJitterMs(this.deps.seed, now),
        systemIdleSeconds: this.safeIdleSeconds(),
        busy: this.deps.busy(),
        declinedVersion: this.deps.declinedVersion ? this.deps.declinedVersion() : this.declinedVersion,
        lastCheckAt: this.lastCheckAt,
        installAttemptNight: this.installAttemptNight,
        downloadAttemptNight: this.downloadAttemptNight
      });
      if (decision.action === 'none') {
        if (isWithinNightlyWindow(now) && decision.reason !== this.lastLoggedReason) {
          this.deps.logger?.info(`[updater] nightly: ${decision.reason}`);
        }
        this.lastLoggedReason = decision.reason;
        return;
      }
      this.lastLoggedReason = '';
      this.deps.logger?.info(`[updater] nightly ${decision.action}: ${decision.reason}`);
      try {
        if (decision.action === 'check') {
          this.lastCheckAt = now.getTime();
          await this.deps.check();
        } else if (decision.action === 'download') {
          this.downloadAttemptNight = nightKey(now);
          await this.deps.download();
        } else {
          this.installAttemptNight = nightKey(now);
          const outcome = await this.deps.install();
          if (outcome.kind === 'deferred') {
            // A deferral is not a failure: allow another attempt later tonight.
            this.installAttemptNight = undefined;
            this.deps.logger?.info(`[updater] nightly install deferred: ${outcome.reason}`);
          }
          return;
        }
      } catch (error) {
        this.deps.logger?.warn(`[updater] nightly ${decision.action} failed: ${(error as Error)?.message ?? String(error)}`);
        return;
      }
    }
  }

  private safeIdleSeconds(): number {
    try {
      const value = this.deps.systemIdleSeconds();
      return Number.isFinite(value) && value >= 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
