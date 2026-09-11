import { app, net, shell } from 'electron';
import { NsisUpdater } from 'electron-updater/out/NsisUpdater';
import type { ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater/out/types';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../shared/logger';
import { errorMessage } from '../shared/error';
import { launchPortableUpdate } from './portableUpdate';
import { normalizeReleaseNotes, releaseNotesFromManifest } from './releaseNotes';
import {
  resolveManualMacRelease,
  type PublishedArtifact
} from './manualMacUpdate';
import { updateServerUrl } from './updateServer';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error'
  | 'portable';

export type UpdateChannel = 'release';
export type UpdateInstallMode = 'automatic' | 'manual-dmg';

export interface XwXDeckUpdateState {
  readonly status: UpdateStatus;
  readonly currentVersion: string;
  readonly targetVersion?: string;
  readonly channel: UpdateChannel;
  readonly portable: boolean;
  readonly installMode: UpdateInstallMode;
  readonly supported: boolean;
  readonly updateAvailable: boolean;
  readonly releaseNotes?: string;
  readonly releaseDate?: string;
  readonly size?: number;
  readonly percent?: number;
  readonly transferred?: number;
  readonly total?: number;
  readonly bytesPerSecond?: number;
  readonly error?: string;
}

const UPDATE_CHANNEL: UpdateChannel = 'release';
export class XwXDeckUpdater {
  private readonly events = new EventEmitter();
  private readonly updater: NsisUpdater | undefined;
  private readonly portable = isPortableBuild();
  private readonly manualMac = app.isPackaged && process.platform === 'darwin';
  private readonly supported = Boolean(updateServerUrl())
    && app.isPackaged
    && (process.platform === 'win32' || this.manualMac);
  private checkPromise: Promise<XwXDeckUpdateState> | undefined;
  private downloadedFile: string | undefined;
  private manualArtifact: PublishedArtifact | undefined;
  private stateValue: XwXDeckUpdateState;

  constructor() {
    this.stateValue = this.baseState(this.portable ? 'portable' : 'idle');
    if (!this.supported || this.manualMac) return;
    const updater = new NsisUpdater({ provider: 'generic', url: this.feedUrl() });
    this.updater = updater;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.disableWebInstaller = true;
    updater.disableDifferentialDownload = true;
    updater.logger = {
      info: message => log.info(`[updater] ${String(message)}`),
      warn: message => log.warn(`[updater] ${String(message)}`),
      error: message => log.error(`[updater] ${String(message)}`),
      debug: message => log.debug(`[updater] ${String(message)}`)
    };
    this.installEventHandlers();
  }

  async start(): Promise<void> {
    if (this.updater) this.configureFeed();
    this.setState(this.baseState(this.portable ? 'portable' : 'idle'));
  }

  onDidChange(listener: (state: XwXDeckUpdateState) => void): () => void {
    this.events.on('change', listener);
    return () => this.events.off('change', listener);
  }

  state(): XwXDeckUpdateState {
    return { ...this.stateValue };
  }

  scheduleStartupCheck(delayMs = 6000): void {
    if (!this.supported) return;
    const timer = setTimeout(() => {
      void this.checkForUpdates(true)
        .then(state => state)
        .catch(error => log.warn(`[updater] automatic update failed: ${errorMessage(error)}`));
    }, delayMs);
    timer.unref?.();
  }

  async checkForUpdates(silent = false): Promise<XwXDeckUpdateState> {
    const updater = this.updater;
    if (!this.supported) {
      this.setState(this.baseState(this.portable ? 'portable' : 'idle'));
      return this.state();
    }
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = (async () => {
      this.setState({
        ...this.stateValue,
        status: 'checking',
        error: undefined,
        percent: undefined,
        transferred: undefined,
        total: undefined,
        bytesPerSecond: undefined
      });
      try {
        if (this.manualMac) await this.checkManualMacUpdate();
        else if (updater) await updater.checkForUpdates();
        else throw new Error('The XwX Deck updater is not available.');
      } catch (error) {
        const message = errorMessage(error);
        this.setState({
          ...this.stateValue,
          status: 'error',
          error: message,
          updateAvailable: false
        });
        if (!silent) log.warn(`[updater] manual check failed: ${message}`);
      }
      return this.state();
    })().finally(() => {
      this.checkPromise = undefined;
    });
    return this.checkPromise;
  }

  async downloadUpdate(): Promise<XwXDeckUpdateState> {
    if (!this.stateValue.updateAvailable || !this.stateValue.targetVersion) {
      throw new Error('No XwX Deck update is available.');
    }
    if (this.stateValue.status === 'downloading') return this.state();
    if (this.manualMac) return this.downloadManualMacUpdate();
    if (!this.updater) throw new Error('Updates are not available on this platform yet.');
    this.setState({
      ...this.stateValue,
      status: 'downloading',
      error: undefined,
      percent: 0,
      transferred: 0
    });
    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      this.setState({
        ...this.stateValue,
        status: 'error',
        error: errorMessage(error)
      });
    }
    return this.state();
  }

  markInstalling(): void {
    if (
      this.stateValue.status !== 'ready'
      || ((this.portable || this.manualMac) && !this.downloadedFile)
    ) {
      throw new Error('The XwX Deck update is not ready to install.');
    }
    this.setState({ ...this.stateValue, status: 'installing', error: undefined });
  }

  failInstallation(error: unknown): void {
    this.setState({
      ...this.stateValue,
      status: 'error',
      error: errorMessage(error)
    });
  }

  cancelInstallation(): void {
    this.setState({ ...this.stateValue, status: 'ready', error: undefined });
  }

  async quitAndInstall(): Promise<void> {
    if (this.manualMac) {
      const installer = this.downloadedFile;
      if (!installer) throw new Error('The macOS XwX Deck installer is incomplete.');
      const openError = await shell.openPath(installer);
      if (openError) throw new Error(openError);
      this.setState({ ...this.stateValue, status: 'ready', error: undefined });
      return;
    }
    if (!this.updater) throw new Error('Updates are not available on this platform yet.');
    if (!this.portable) {
      this.updater.quitAndInstall(false, true);
      return;
    }
    const sourcePath = this.downloadedFile;
    const targetPath = process.env.PORTABLE_EXECUTABLE_FILE;
    if (!sourcePath || !targetPath || !this.stateValue.targetVersion) {
      throw new Error('The portable XwX Deck update is incomplete.');
    }
    await launchPortableUpdate({
      sourcePath,
      targetPath,
      version: this.stateValue.targetVersion,
      waitPids: [process.pid]
    });
  }

  private installEventHandlers(): void {
    const updater = this.updater;
    if (!updater) return;
    updater.on('checking-for-update', () => {
      if (this.stateValue.status !== 'checking') {
        this.setState({ ...this.stateValue, status: 'checking', error: undefined });
      }
    });
    updater.on('update-available', info => {
      this.downloadedFile = undefined;
      const available = this.availableState(info);
      this.setState(available);
      if (!available.releaseNotes) {
        void this.loadPublishedReleaseNotes(info.version);
      }
    });
    updater.on('update-not-available', () => {
      this.downloadedFile = undefined;
      this.setState(this.baseState(this.portable ? 'portable' : 'up-to-date'));
    });
    updater.on('download-progress', progress => {
      this.setState(this.progressState(progress));
    });
    updater.on('update-downloaded', event => {
      this.downloadedFile = event.downloadedFile;
      this.setState(this.downloadedState(event));
    });
    updater.on('update-cancelled', () => {
      this.setState({
        ...this.stateValue,
        status: this.stateValue.updateAvailable ? 'available' : this.portable ? 'portable' : 'idle',
        percent: undefined,
        transferred: undefined,
        total: undefined,
        bytesPerSecond: undefined
      });
    });
    updater.on('error', error => {
      this.setState({
        ...this.stateValue,
        status: 'error',
        error: errorMessage(error)
      });
    });
  }

  private configureFeed(): void {
    if (!this.updater) return;
    this.updater.setFeedURL({ provider: 'generic', url: this.feedUrl() });
    this.updater.requestHeaders = this.requestHeaders();
  }

  private requestHeaders(): Record<string, string> {
    return {
      'X-XwX-Deck-Version': app.getVersion(),
      'X-XwX-Deck-Channel': UPDATE_CHANNEL,
      'X-XwX-Deck-Platform': `${process.platform}-${process.arch}`
    };
  }

  private async checkManualMacUpdate(): Promise<void> {
    const response = await net.fetch(`${this.feedUrl()}/release.json`, {
      headers: this.requestHeaders(),
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`Update server returned HTTP ${response.status}.`);
    const selection = resolveManualMacRelease(await response.json(), app.getVersion(), process.arch);
    if (!selection) {
      this.downloadedFile = undefined;
      this.manualArtifact = undefined;
      this.setState(this.baseState('up-to-date'));
      return;
    }
    this.downloadedFile = undefined;
    this.manualArtifact = selection.artifact;
    this.setState({
      ...this.baseState('available'),
      targetVersion: selection.version,
      updateAvailable: true,
      releaseNotes: normalizeReleaseNotes(selection.changelog),
      releaseDate: selection.publishedAt,
      size: selection.artifact.size
    });
  }

  private async downloadManualMacUpdate(): Promise<XwXDeckUpdateState> {
    const artifact = this.manualArtifact;
    if (!artifact || !this.stateValue.targetVersion) {
      throw new Error('The macOS XwX Deck installer metadata is incomplete.');
    }
    const updateDirectory = path.join(app.getPath('userData'), 'updates');
    const target = path.join(updateDirectory, artifact.name);
    const temporary = `${target}.download-${process.pid}-${Date.now()}`;
    this.setState({
      ...this.stateValue,
      status: 'downloading',
      error: undefined,
      percent: 0,
      transferred: 0,
      total: artifact.size,
      bytesPerSecond: 0
    });
    try {
      await fs.promises.mkdir(updateDirectory, { recursive: true });
      if (await fileMatches(target, artifact)) {
        this.downloadedFile = target;
        this.setState(this.manualDownloadedState(artifact.size));
        return this.state();
      }
      const response = await net.fetch(
        artifact.url,
        { headers: this.requestHeaders(), cache: 'no-store' }
      );
      if (!response.ok || !response.body) {
        throw new Error(`Installer download returned HTTP ${response.status}.`);
      }
      const handle = await fs.promises.open(temporary, 'wx');
      const hash = createHash('sha256');
      const reader = response.body.getReader();
      const startedAt = Date.now();
      let transferred = 0;
      let lastProgressAt = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          transferred += chunk.length;
          if (transferred > artifact.size) throw new Error('Installer download exceeded the published size.');
          hash.update(chunk);
          await handle.write(chunk);
          const now = Date.now();
          if (now - lastProgressAt >= 100) {
            lastProgressAt = now;
            this.setState({
              ...this.stateValue,
              status: 'downloading',
              percent: clampPercent(transferred / artifact.size * 100),
              transferred,
              total: artifact.size,
              bytesPerSecond: Math.round(transferred / Math.max(1, now - startedAt) * 1000),
              error: undefined
            });
          }
        }
      } finally {
        await handle.close();
      }
      if (transferred !== artifact.size) throw new Error('Installer download size does not match the published release.');
      if (hash.digest('hex') !== artifact.sha256.toLowerCase()) {
        throw new Error('Installer SHA-256 verification failed.');
      }
      await fs.promises.rm(target, { force: true });
      await fs.promises.rename(temporary, target);
      this.downloadedFile = target;
      this.setState(this.manualDownloadedState(transferred));
    } catch (error) {
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
      this.setState({ ...this.stateValue, status: 'error', error: errorMessage(error) });
    }
    return this.state();
  }

  private async loadPublishedReleaseNotes(targetVersion: string): Promise<void> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5000);
    timer.unref?.();
    try {
      const response = await net.fetch(`${this.feedUrl()}/release.json`, {
        headers: this.requestHeaders(),
        signal: abort.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const releaseNotes = releaseNotesFromManifest(await response.json(), targetVersion);
      if (!releaseNotes) return;
      if (!this.stateValue.updateAvailable || this.stateValue.targetVersion !== targetVersion) return;
      this.setState({ ...this.stateValue, releaseNotes });
    } catch (error) {
      if (!abort.signal.aborted) {
        log.warn(`[updater] unable to load release notes: ${errorMessage(error)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private feedUrl(): string {
    return this.serverUrl();
  }

  private serverUrl(): string {
    return updateServerUrl();
  }

  private baseState(status: UpdateStatus): XwXDeckUpdateState {
    return {
      status,
      currentVersion: app.getVersion(),
      channel: UPDATE_CHANNEL,
      portable: this.portable,
      installMode: this.manualMac ? 'manual-dmg' : 'automatic',
      supported: this.supported,
      updateAvailable: false
    };
  }

  private availableState(info: UpdateInfo): XwXDeckUpdateState {
    const file = info.files?.[0];
    return {
      ...this.baseState('available'),
      targetVersion: info.version,
      updateAvailable: true,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      releaseDate: info.releaseDate,
      size: file?.size
    };
  }

  private progressState(progress: ProgressInfo): XwXDeckUpdateState {
    return {
      ...this.stateValue,
      status: 'downloading',
      percent: clampPercent(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
      error: undefined
    };
  }

  private downloadedState(event: UpdateDownloadedEvent): XwXDeckUpdateState {
    return {
      ...this.stateValue,
      status: 'ready',
      targetVersion: event.version,
      updateAvailable: true,
      releaseNotes: normalizeReleaseNotes(event.releaseNotes) || this.stateValue.releaseNotes,
      releaseDate: event.releaseDate || this.stateValue.releaseDate,
      percent: 100,
      transferred: this.stateValue.total || this.stateValue.transferred,
      error: undefined
    };
  }

  private manualDownloadedState(transferred: number): XwXDeckUpdateState {
    return {
      ...this.stateValue,
      status: 'ready',
      updateAvailable: true,
      percent: 100,
      transferred,
      total: transferred,
      bytesPerSecond: undefined,
      error: undefined
    };
  }

  private setState(next: XwXDeckUpdateState): void {
    this.stateValue = {
      ...next,
      channel: UPDATE_CHANNEL,
      portable: this.portable,
      installMode: this.manualMac ? 'manual-dmg' : 'automatic',
      supported: this.supported
    };
    this.events.emit('change', this.state());
  }
}

function isPortableBuild(): boolean {
  return Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

async function fileMatches(filePath: string, artifact: PublishedArtifact): Promise<boolean> {
  try {
    const fileStat = await fs.promises.stat(filePath);
    if (!fileStat.isFile() || fileStat.size !== artifact.size) return false;
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex') === artifact.sha256.toLowerCase();
  } catch {
    return false;
  }
}
