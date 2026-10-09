import * as path from 'path';
import { BrowserWindow, nativeImage, screen, type WebContents } from 'electron';
import type { XwXDeckRuntimeState } from '../app/xwxDeckController';
import { log } from '../shared/logger';

type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface WindowResizeSession {
  readonly win: BrowserWindow;
  readonly edge: ResizeEdge;
  readonly startX: number;
  readonly startY: number;
  readonly bounds: Electron.Rectangle;
  readonly minWidth: number;
  readonly minHeight: number;
}

interface WindowMoveSession {
  readonly win: BrowserWindow;
  readonly startX: number;
  readonly startY: number;
  readonly bounds: Electron.Rectangle;
}

export interface ManagerWindowOptions {
  readonly state: () => Promise<XwXDeckRuntimeState>;
  readonly preloadPath: string;
  readonly iconPath: string;
  readonly hidden?: boolean;
  readonly onClosed?: () => void;
  readonly onRendererRecoveryExhausted?: (details: Electron.RenderProcessGoneDetails) => void;
}

export type ManagerNotice = import('../../shared/lifecycleNotice').LifecycleNotice;

interface WindowRecoveryState {
  readonly bounds: Electron.Rectangle;
  readonly contentSize: readonly [number, number];
  readonly maximized: boolean;
  readonly fullscreen: boolean;
}

const MIN_WIDTH = 620;
const MIN_HEIGHT = 340;
const DEFAULT_WIDTH = 1040;
const DEFAULT_HEIGHT = 560;

export class ManagerWindow {
  private win: BrowserWindow | undefined;
  private resizeSession: WindowResizeSession | undefined;
  private moveSession: WindowMoveSession | undefined;
  private homeBounds: Electron.Rectangle | undefined;
  private rendererRecoveryTimes: number[] = [];
  private recoveryState: WindowRecoveryState | undefined;
  private showRequested = false;

  constructor(private readonly options: ManagerWindowOptions) {}

  current(): BrowserWindow | undefined {
    return this.win && !this.win.isDestroyed() ? this.win : undefined;
  }

  async open(): Promise<void> {
    this.showRequested = !this.options.hidden;
    const existing = this.current();
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.setSkipTaskbar(!this.showRequested);
      if (this.showRequested) {
        existing.show();
        existing.focus();
      }
      this.sendState(await this.options.state());
      return;
    }

    const recoveryState = this.recoveryState;
    this.recoveryState = undefined;
    const targetContentWidth = recoveryState?.contentSize[0] ?? DEFAULT_WIDTH;
    const targetContentHeight = recoveryState?.contentSize[1] ?? DEFAULT_HEIGHT;
    // Load the taskbar/window icon through nativeImage so it works from inside
    // the packaged asar. BrowserWindow's `icon` string path is resolved by the
    // native layer, which cannot see files bundled in app.asar and would fall
    // back to Electron's default icon; reading the bytes here avoids that.
    const windowIcon = nativeImage.createFromPath(this.options.iconPath);
    const nativeMacWindow = process.platform === 'darwin';
    const win = new BrowserWindow({
      width: targetContentWidth,
      height: targetContentHeight,
      ...(recoveryState ? { x: recoveryState.bounds.x, y: recoveryState.bounds.y } : {}),
      useContentSize: true,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      title: 'XwX Deck',
      // macOS must keep an AppKit-managed frame so traffic lights, window
      // resizing, title-bar double-click and fullscreen transitions retain the
      // system's native behavior and animation. Windows keeps the established
      // custom frame used by the portable build.
      ...(nativeMacWindow
        ? { frame: true, titleBarStyle: 'default' as const }
        : { frame: false }),
      transparent: false,
      resizable: true,
      hasShadow: true,
      autoHideMenuBar: true,
      backgroundColor: '#fcfcfb',
      show: false,
      icon: windowIcon.isEmpty() ? this.options.iconPath : windowIcon,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    fitContentSize(win, targetContentWidth, targetContentHeight);
    this.win = win;
    win.webContents.on('render-process-gone', (_event, details) => {
      log.error(`[xwxdeck] manager renderer exited: reason=${details.reason} code=${details.exitCode}`);
      if (details.reason !== 'clean-exit') this.recoverRenderer(win, details);
    });
    win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      log.warn(`[xwxdeck] manager load failed: code=${code} description=${description} url=${url}`);
    });
    win.webContents.on('did-finish-load', () => {
      this.sendWindowState();
      void this.options.state()
        .then(state => this.sendState(state))
        .catch(error => log.warn(`[xwxdeck] manager state refresh after load failed: ${(error as Error).message}`));
    });
    win.on('unresponsive', () => log.warn('[xwxdeck] manager window became unresponsive'));
    win.on('closed', () => {
      if (this.resizeSession?.win === win) this.resizeSession = undefined;
      if (this.moveSession?.win === win) this.moveSession = undefined;
      this.homeBounds = undefined;
      if (this.win === win) this.win = undefined;
      this.options.onClosed?.();
    });
    win.on('enter-full-screen', () => this.sendWindowState());
    win.on('leave-full-screen', () => this.sendWindowState());
    win.on('maximize', () => this.sendWindowState());
    win.on('unmaximize', () => this.sendWindowState());
    try {
      await loadManagerFile(win, path.join(__dirname, 'renderer', 'index.html'));
    } catch (error) {
      if (this.current() !== win || win.isDestroyed() || win.webContents.isDestroyed()) {
        log.warn('[xwxdeck] manager load aborted after renderer exit');
        return;
      }
      win.destroy();
      throw error;
    }
    this.sendWindowState();
    if (recoveryState?.maximized) win.maximize();
    if (recoveryState?.fullscreen) win.setFullScreen(true);
    if (this.showRequested && !win.isDestroyed()) {
      win.setSkipTaskbar(false);
      win.show();
      win.focus();
    }
    void this.options.state()
      .then(state => this.sendState(state))
      .catch(error => log.warn(`[xwx-deck] manager initial state refresh failed: ${(error as Error).message}`));
  }

  sendState(state: XwXDeckRuntimeState): void {
    const win = this.current();
    if (!win || win.webContents.isDestroyed()) return;
    try {
      win.webContents.send('xwxdeck:state', state);
      if (state.update) win.webContents.send('xwxdeck:update-state', state.update);
    } catch (error) {
      log.warn(`[xwxdeck] manager state delivery failed: ${(error as Error).message}`);
    }
  }

  async showNotice(notice: ManagerNotice): Promise<void> {
    await this.open();
    const win = this.current();
    if (!win || win.webContents.isDestroyed()) return;
    win.webContents.send('xwxdeck:notice', notice);
  }

  private recoverRenderer(win: BrowserWindow, details: Electron.RenderProcessGoneDetails): void {
    if (this.current() !== win) return;
    const now = Date.now();
    this.rendererRecoveryTimes = this.rendererRecoveryTimes.filter(at => now - at < 30_000);
    const shouldReopen = this.showRequested;
    if (!win.isDestroyed()) {
      const [contentWidth, contentHeight] = win.getContentSize();
      this.recoveryState = {
        bounds: win.getBounds(),
        contentSize: [contentWidth, contentHeight],
        maximized: win.isMaximized(),
        fullscreen: win.isFullScreen()
      };
      win.destroy();
    }
    if (!shouldReopen) {
      log.warn('[xwxdeck] hidden manager renderer exited; a fresh window will be created on next open');
      return;
    }
    if (this.rendererRecoveryTimes.length >= 2) {
      log.error('[xwxdeck] manager renderer recovery stopped after repeated exits');
      this.options.onRendererRecoveryExhausted?.(details);
      return;
    }
    this.rendererRecoveryTimes.push(now);
    setTimeout(() => {
      if (!this.showRequested || this.current()) return;
      log.warn('[xwxdeck] creating a fresh manager window after renderer exit');
      void this.open().catch(error => {
        log.warn(`[xwxdeck] manager recovery open failed: ${(error as Error).message}`);
      });
    }, 250).unref?.();
  }

  async showUpdateDetails(): Promise<void> {
    await this.open();
    this.current()?.webContents.send('xwxdeck:show-update-details');
  }

  minimize(sender: WebContents): boolean {
    BrowserWindow.fromWebContents(sender)?.minimize();
    return true;
  }

  toggleFullscreen(sender: WebContents): { fullscreen: boolean } {
    const win = BrowserWindow.fromWebContents(sender);
    if (!win) return { fullscreen: false };
    const fullscreen = !win.isFullScreen();
    win.setFullScreen(fullscreen);
    return { fullscreen };
  }

  toggleMaximize(sender: WebContents): { maximized: boolean; fullscreen: boolean } {
    const win = BrowserWindow.fromWebContents(sender);
    if (!win) return { maximized: false, fullscreen: false };
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return { maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
  }

  setView(sender: WebContents, view: unknown): boolean {
    const win = BrowserWindow.fromWebContents(sender);
    if (!win || win !== this.current()) return false;
    this.setWindowView(win, view === 'settings' ? 'settings' : 'home');
    return true;
  }

  close(sender: WebContents): boolean {
    const win = BrowserWindow.fromWebContents(sender);
    if (!win || win !== this.current()) return false;
    this.showRequested = false;
    win.hide();
    win.setSkipTaskbar(true);
    return true;
  }

  startMove(sender: WebContents, payload: unknown): void {
    const win = BrowserWindow.fromWebContents(sender);
    const point = readScreenPoint(payload);
    if (!win || win !== this.current() || !point || win.isDestroyed() || win.isFullScreen()) return;
    this.moveSession = {
      win,
      startX: point.screenX,
      startY: point.screenY,
      bounds: win.getBounds()
    };
  }

  move(sender: WebContents, payload: unknown): void {
    const session = this.moveSession;
    const point = readScreenPoint(payload);
    if (!session || !point || session.win.isDestroyed() || session.win.webContents !== sender) return;
    session.win.setBounds({
      ...session.bounds,
      x: Math.round(session.bounds.x + point.screenX - session.startX),
      y: Math.round(session.bounds.y + point.screenY - session.startY)
    }, false);
  }

  endMove(sender: WebContents): void {
    if (this.moveSession?.win.webContents === sender) this.moveSession = undefined;
  }

  startResize(sender: WebContents, payload: unknown): void {
    const win = BrowserWindow.fromWebContents(sender);
    const edge = readResizeEdge(payload);
    const point = readScreenPoint(payload);
    if (!win || win !== this.current() || !edge || !point || win.isDestroyed() || win.isFullScreen() || !win.isResizable()) return;
    const [minWidth, minHeight] = win.getMinimumSize();
    this.resizeSession = {
      win,
      edge,
      startX: point.screenX,
      startY: point.screenY,
      bounds: win.getBounds(),
      minWidth: Math.max(MIN_WIDTH, minWidth),
      minHeight: Math.max(MIN_HEIGHT, minHeight)
    };
  }

  resize(sender: WebContents, payload: unknown): void {
    const session = this.resizeSession;
    const point = readScreenPoint(payload);
    if (!session || !point || session.win.isDestroyed() || session.win.webContents !== sender) return;
    const dx = point.screenX - session.startX;
    const dy = point.screenY - session.startY;
    const next = { ...session.bounds };
    if (session.edge.includes('e')) next.width = Math.max(session.minWidth, session.bounds.width + dx);
    if (session.edge.includes('s')) next.height = Math.max(session.minHeight, session.bounds.height + dy);
    if (session.edge.includes('w')) {
      const width = Math.max(session.minWidth, session.bounds.width - dx);
      next.width = width;
      next.x = session.bounds.x + session.bounds.width - width;
    }
    if (session.edge.includes('n')) {
      const height = Math.max(session.minHeight, session.bounds.height - dy);
      next.height = height;
      next.y = session.bounds.y + session.bounds.height - height;
    }
    session.win.setBounds(next, false);
  }

  endResize(sender: WebContents): void {
    if (this.resizeSession?.win.webContents === sender) this.resizeSession = undefined;
  }

  private setWindowView(win: BrowserWindow, view: 'home' | 'settings'): void {
    if (win.isMaximized() || win.isFullScreen()) return;
    if (view === 'home') {
      if (!this.homeBounds) return;
      win.setBounds(fitBoundsToWorkArea(this.homeBounds));
      this.homeBounds = undefined;
      return;
    }
    if (!this.homeBounds) this.homeBounds = win.getBounds();
    const current = win.getBounds();
    const workArea = screen.getDisplayMatching(current).workArea;
    const width = Math.min(Math.max(current.width, 1120), Math.max(MIN_WIDTH, workArea.width - 48));
    const height = Math.min(Math.max(current.height, 720), Math.max(MIN_HEIGHT, workArea.height - 48));
    win.setBounds(fitBoundsToWorkArea({
      x: Math.round(current.x + (current.width - width) / 2),
      y: Math.round(current.y + (current.height - height) / 2),
      width,
      height
    }));
  }

  private sendWindowState(): void {
    const win = this.current();
    if (!win) return;
    win.webContents.send('xwxdeck:window-state', {
      fullscreen: win.isFullScreen(),
      maximized: win.isMaximized(),
      nativeFrame: process.platform === 'darwin'
    });
  }
}

async function loadManagerFile(win: BrowserWindow, file: string): Promise<void> {
  let lastError: unknown;
  for (const delayMs of [0, 150, 500]) {
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    try {
      await win.loadFile(file);
      return;
    } catch (error) {
      lastError = error;
      if (win.isDestroyed() || win.webContents.isDestroyed()) throw error;
      log.warn(`[xwxdeck] retrying manager load: ${(error as Error).message}`);
    }
  }
  throw lastError;
}

function fitContentSize(win: BrowserWindow, targetWidth: number, targetHeight: number): void {
  const [contentWidth, contentHeight] = win.getContentSize();
  if (contentWidth === targetWidth && contentHeight === targetHeight) return;
  win.setContentSize(targetWidth, targetHeight, false);
}

function fitBoundsToWorkArea(bounds: Electron.Rectangle): Electron.Rectangle {
  const workArea = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    x: Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height)),
    width,
    height
  };
}

function readResizeEdge(payload: unknown): ResizeEdge | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const edge = (payload as { edge?: unknown }).edge;
  return edge === 'n' || edge === 's' || edge === 'e' || edge === 'w'
    || edge === 'ne' || edge === 'nw' || edge === 'se' || edge === 'sw'
    ? edge
    : undefined;
}

function readScreenPoint(payload: unknown): { screenX: number; screenY: number } | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const { screenX, screenY } = payload as { screenX?: unknown; screenY?: unknown };
  if (typeof screenX !== 'number' || typeof screenY !== 'number') return undefined;
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return undefined;
  return { screenX, screenY };
}
