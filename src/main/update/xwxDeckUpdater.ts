import { app, net, shell } from 'electron';
import { NsisUpdater } from 'electron-updater/out/NsisUpdater';
import { CancellationToken } from 'electron-updater/out/types';
import type { ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater/out/types';
import { createHash, randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../shared/logger';
import { errorMessage } from '../shared/error';
import { assertPortableUpdateInstallable, launchPortableUpdate } from './portableUpdate';
import { normalizeReleaseNotes, releaseNotesFromManifest } from './releaseNotes';
import {
  resolveManualMacRelease,
  type PublishedArtifact
} from './manualMacUpdate';
import { updateServerUrl } from './updateServer';
import { rememberOpenedMacDmg } from './macInstallerCleanup';

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

export interface InstallOptions {
  readonly unattended?: boolean;
  readonly launchHidden?: boolean;
}

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
  readonly background?: boolean;
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
  private hasChecked = false;
  private declinedVersionValue: string | undefined;
  private cancellationPromise: Promise<XwXDeckUpdateState> | undefined;
  private downloadPromise: Promise<XwXDeckUpdateState> | undefined;
  private downloadOperation = 0;
  private selectedFeedUrl: string | undefined;
  private selectedArtifact: PublishedArtifact | undefined;
  private checkPromise: Promise<XwXDeckUpdateState> | undefined;
  private downloadCancellation: CancellationToken | undefined;
  private manualDownloadAbort: AbortController | undefined;
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
    try {
      const value = JSON.parse(await fs.promises.readFile(this.preferencePath(), 'utf8'));
      if (typeof value.declinedVersion === 'string') this.declinedVersionValue = value.declinedVersion;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`[updater] unable to read update preference; unattended installs disabled: ${errorMessage(error)}`);
        this.declinedVersionValue = '*';
      }
    }
    if (this.updater) this.configureFeed();
    this.setState(this.baseState(this.portable ? 'portable' : 'idle'));
  }

  declinedVersion(): string | undefined { return this.declinedVersionValue; }

  private preferencePath(): string { return path.join(app.getPath('userData'), 'updates', 'preferences.json'); }

  private async saveDeclinedVersion(version: string | undefined): Promise<void> {
    this.declinedVersionValue = version;
    const file = this.preferencePath();
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}-${randomUUID()}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify({ declinedVersion: version }), 'utf8');
    await fs.promises.rename(temp, file);
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
      if (this.hasChecked) return;
      void this.checkForUpdates(true)
        .then(state => state)
        .catch(error => log.warn(`[updater] automatic update failed: ${errorMessage(error)}`));
    }, delayMs);
    timer.unref?.();
  }

  async checkForUpdates(silent = false, background = false): Promise<XwXDeckUpdateState> {
    const updater = this.updater;
    if (!this.supported) {
      this.setState(this.baseState(this.portable ? 'portable' : 'idle'));
      return this.state();
    }
    this.hasChecked = true;
    if (this.checkPromise) return this.checkPromise;
    if (this.downloadPromise || this.stateValue.status === 'installing') return this.state();
    this.checkPromise = (async () => {
      this.setState({
        ...this.stateValue,
        status: 'checking',
        background,
        error: undefined,
        percent: undefined,
        transferred: undefined,
        total: undefined,
        bytesPerSecond: undefined
      });
      try {
        this.selectedFeedUrl = this.feedUrl();
        this.selectedArtifact = undefined;
        this.configureFeed();
        if (this.manualMac) await this.checkManualMacUpdate();
        else if (updater) await updater.checkForUpdates();
        else throw new Error('当前环境无法启动更新服务。');
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

  async downloadUpdate(background = false): Promise<XwXDeckUpdateState> {
    if (this.cancellationPromise) await this.cancellationPromise;
    if (this.downloadPromise) return this.downloadPromise;
    if (this.checkPromise) await this.checkPromise;
    if (this.downloadPromise) return this.downloadPromise;
    if (this.stateValue.status === 'installing' || this.stateValue.status === 'ready') return this.state();
    if (!this.stateValue.updateAvailable || !this.stateValue.targetVersion) {
      throw new Error('当前没有可下载的 XwX Deck 更新。');
    }
    const operation = ++this.downloadOperation;
    const abort = new AbortController();
    this.manualDownloadAbort = abort;
    this.setState({ ...this.stateValue, status: 'downloading', background, error: undefined, percent: 0, transferred: 0 });
    this.downloadPromise = (async () => {
      try {
        if (!background) await this.saveDeclinedVersion(undefined);
        abort.signal.throwIfAborted();
        await this.confirmReleaseSelection(abort.signal);
        abort.signal.throwIfAborted();
        if (this.manualMac) return await this.downloadManualMacUpdate(abort);
        if (!this.updater) throw new Error('当前平台暂不支持自动更新。');
        const cancellation = new CancellationToken();
        this.downloadCancellation = cancellation;
        await this.updater.downloadUpdate(cancellation);
      } catch (error) {
        if (operation === this.downloadOperation && !abort.signal.aborted) {
          this.setState({ ...this.stateValue, status: 'error', error: errorMessage(error) });
        }
      } finally {
        this.downloadCancellation = undefined;
        if (this.manualDownloadAbort === abort) this.manualDownloadAbort = undefined;
      }
      return this.state();
    })().finally(() => { this.downloadPromise = undefined; });
    return this.downloadPromise;
  }

  markInstalling(): void {
    if (
      this.stateValue.status !== 'ready'
      || ((this.portable || this.manualMac) && !this.downloadedFile)
    ) {
      throw new Error('更新尚未下载完成，暂时不能安装。');
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

  discardDownloadedUpdate(): Promise<XwXDeckUpdateState> {
    if (this.cancellationPromise) return this.cancellationPromise;
    this.cancellationPromise = this.discardDownload().finally(() => { this.cancellationPromise = undefined; });
    return this.cancellationPromise;
  }

  private async discardDownload(): Promise<XwXDeckUpdateState> {
    if (this.stateValue.status === 'installing') throw new Error('更新正在安装，无法取消。');
    this.downloadOperation += 1;
    this.downloadCancellation?.cancel();
    this.manualDownloadAbort?.abort();
    await this.downloadPromise;
    const cancelledVersion = this.stateValue.targetVersion;
    const downloadedFile = this.downloadedFile;
    this.downloadedFile = undefined;
    if (downloadedFile) {
      await fs.promises.rm(downloadedFile, { force: true }).catch(error => {
        log.warn(`[updater] could not remove cancelled update ${downloadedFile}: ${errorMessage(error)}`);
      });
    }
    this.setState({
      ...this.stateValue,
      status: this.stateValue.updateAvailable ? 'available' : this.portable ? 'portable' : 'idle',
      percent: undefined,
      transferred: undefined,
      total: undefined,
      bytesPerSecond: undefined,
      error: undefined
    });
    await this.saveDeclinedVersion(cancelledVersion);
    return this.state();
  }

  /** Keep the running version usable until source, payload and target checks pass. */
  async preflightInstall(): Promise<void> {
    await this.confirmReleaseSelection();
    if (!this.downloadedFile || !this.selectedArtifact
        || !await fileMatches(this.downloadedFile, this.selectedArtifact)) {
      throw new Error('安装包大小或 SHA-256 校验失败，请重新检查并下载更新。');
    }
    if (this.manualMac || !this.portable) return;
    const target = process.env.PORTABLE_EXECUTABLE_FILE;
    if (!target) throw new Error('无法确认便携程序的原安装路径。');
    await assertPortableUpdateInstallable(this.downloadedFile, target);
  }

  private async confirmReleaseSelection(signal?: AbortSignal): Promise<void> {
    if (!this.selectedFeedUrl || this.feedUrl() !== this.selectedFeedUrl) {
      throw new Error('更新源已更改，请重新检查更新。');
    }
    const manifest = await this.fetchReleaseManifest(signal);
    if (manifest.version !== this.stateValue.targetVersion) {
      throw new Error('发布版本已变化，请重新检查更新。');
    }
    const name = this.manualMac ? `XwX-Deck-mac-${process.arch}.dmg` : 'XwX-Deck-windows-x64.exe';
    const raw = Array.isArray(manifest.files) ? manifest.files.find((item: PublishedArtifact) => item?.name === name) : undefined;
    if (!raw || typeof raw.url !== 'string' || !Number.isSafeInteger(raw.size) || raw.size <= 0
        || typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(raw.sha256)) {
      throw new Error('发布清单缺少有效的安装包，请重新检查更新。');
    }
    const url = new URL(raw.url);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      throw new Error('安装包地址无效，请重新检查更新。');
    }
    const artifact: PublishedArtifact = { name, url: raw.url, size: raw.size, sha256: raw.sha256.toLowerCase() };
    if (this.selectedArtifact && JSON.stringify(this.selectedArtifact) !== JSON.stringify(artifact)) {
      throw new Error('安装包已变化，请重新检查并下载更新。');
    }
    this.selectedArtifact = artifact;
  }

  private async fetchReleaseManifest(signal?: AbortSignal): Promise<{ version?: string; files?: PublishedArtifact[] }> {
    const response = await net.fetch(`${this.selectedFeedUrl ?? this.feedUrl()}/release.json`, {
      headers: this.requestHeaders(), cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`更新服务器返回 HTTP ${response.status}。`);
    return response.json();
  }

  async quitAndInstall(options: InstallOptions = {}): Promise<void> {
    if (this.manualMac) {
      const installer = this.downloadedFile;
      if (!installer) throw new Error('macOS 安装包不完整，请重新下载。');
      const openError = await shell.openPath(installer);
      if (openError) throw new Error(`无法打开 macOS 安装包：${openError}`);
      if (this.stateValue.targetVersion && this.selectedArtifact) {
        await rememberOpenedMacDmg(app.getPath('userData'), this.stateValue.targetVersion, this.selectedArtifact)
          .catch(error => log.warn(`[updater] unable to remember opened DMG: ${errorMessage(error)}`));
      }
      this.setState({ ...this.stateValue, status: 'ready', error: undefined });
      return;
    }
    if (!this.updater) throw new Error('当前平台暂不支持自动更新。');
    if (!this.portable) {
      this.updater.quitAndInstall(options.unattended === true, true);
      return;
    }
    const sourcePath = this.downloadedFile;
    const targetPath = process.env.PORTABLE_EXECUTABLE_FILE;
    if (!sourcePath || !targetPath || !this.stateValue.targetVersion) {
      throw new Error('更新文件不完整，请重新下载。');
    }
    await launchPortableUpdate({
      sourcePath,
      targetPath,
      version: this.stateValue.targetVersion,
      waitPids: [process.pid],
      launchHidden: options.launchHidden === true
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
      if (this.manualDownloadAbort?.signal.aborted) return;
      this.setState(this.progressState(progress));
    });
    updater.on('update-downloaded', event => {
      if (this.manualDownloadAbort?.signal.aborted) return;
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
      if (this.manualDownloadAbort?.signal.aborted) return;
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
    const selection = resolveManualMacRelease(await this.fetchReleaseManifest(), app.getVersion(), process.arch);
    if (!selection) {
      this.downloadedFile = undefined;
      this.manualArtifact = undefined;
      this.setState(this.baseState('up-to-date'));
      return;
    }
    this.downloadedFile = undefined;
    this.manualArtifact = selection.artifact;
    this.selectedArtifact = selection.artifact;
    this.setState({
      ...this.baseState('available'),
      targetVersion: selection.version,
      updateAvailable: true,
      releaseNotes: normalizeReleaseNotes(selection.changelog),
      releaseDate: selection.publishedAt,
      size: selection.artifact.size
    });
  }

  private async downloadManualMacUpdate(abort: AbortController): Promise<XwXDeckUpdateState> {
    const artifact = this.manualArtifact;
    if (!artifact || !this.stateValue.targetVersion) {
      throw new Error('macOS 安装包信息不完整，请重新检查更新。');
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
        abort.signal.throwIfAborted();
        this.downloadedFile = target;
        this.setState(this.manualDownloadedState(artifact.size));
        return this.state();
      }
      const response = await net.fetch(
        artifact.url,
        { headers: this.requestHeaders(), cache: 'no-store', signal: abort.signal }
      );
      if (!response.ok || !response.body) {
        throw new Error(`安装包下载失败（HTTP ${response.status}），请稍后重试。`);
      }
      const handle = await fs.promises.open(temporary, 'wx');
      const hash = createHash('sha256');
      const reader = response.body.getReader();
      const startedAt = Date.now();
      let transferred = 0;
      let lastProgressAt = 0;
      try {
        while (true) {
          abort.signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value);
          transferred += chunk.length;
          if (transferred > artifact.size) throw new Error('安装包大小超过发布清单，已停止下载。');
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
        await reader.cancel().catch(() => undefined);
        await handle.close();
      }
      abort.signal.throwIfAborted();
      if (transferred !== artifact.size) throw new Error('安装包大小与发布清单不一致，已丢弃本次下载。');
      if (hash.digest('hex') !== artifact.sha256.toLowerCase()) {
        throw new Error('安装包完整性校验失败，已丢弃本次下载。');
      }
      await fs.promises.rm(target, { force: true });
      await fs.promises.rename(temporary, target);
      abort.signal.throwIfAborted();
      this.downloadedFile = target;
      this.setState(this.manualDownloadedState(transferred));
    } catch (error) {
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
      if (!abort.signal.aborted) {
        this.setState({ ...this.stateValue, status: 'error', error: errorMessage(error) });
      }
    } finally {
      if (this.manualDownloadAbort === abort) this.manualDownloadAbort = undefined;
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
      background: this.stateValue?.background,
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
