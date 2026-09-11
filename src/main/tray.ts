import { app, Menu, nativeImage, Tray } from 'electron';
import type { XwXDeckRuntimeState } from './app/xwxDeckController';
import { assetPath } from './shared/assets';

export interface TrayActions {
  readonly openManager: () => void;
  readonly toggleTracing: () => void;
  readonly showUpdateDetails: () => void;
  readonly quit: () => void;
  readonly toggleGateway: (expectedAction: 'close' | 'open') => void;
}

export class XwXDeckTray {
  private tray: Tray | undefined;
  private lastState: XwXDeckRuntimeState | undefined;
  private pendingGatewayAction: 'close' | 'open' | undefined;

  constructor(private readonly actions: TrayActions) {}

  refresh(state: XwXDeckRuntimeState): void {
    this.lastState = state;
    if (!this.tray) {
      this.tray = new Tray(createTrayIcon(state.tracingEnabled));
      this.tray.on('click', this.actions.openManager);
      this.tray.on('double-click', this.actions.openManager);
    } else {
      this.tray.setImage(createTrayIcon(state.tracingEnabled));
    }
    this.tray.setToolTip(state.tracingEnabled ? 'XwX Deck 正在追踪请求' : 'XwX Deck 待命中');
    this.tray.setContextMenu(this.buildMenu(state));
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setMenu(this.buildDockMenu(state));
    }
  }

  setGatewayActionPending(action: 'close' | 'open' | undefined): void {
    this.pendingGatewayAction = action;
    if (!this.tray || !this.lastState) return;
    this.tray.setContextMenu(this.buildMenu(this.lastState));
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setMenu(this.buildDockMenu(this.lastState));
    }
  }

  dispose(): void {
    this.tray?.destroy();
    this.tray = undefined;
    this.lastState = undefined;
    this.pendingGatewayAction = undefined;
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setMenu(Menu.buildFromTemplate([]));
    }
  }

  private buildMenu(state: XwXDeckRuntimeState): Menu {
    const status = state.tracingEnabled
      ? '正在追踪'
      : state.externalTracePort
        ? `被外部追踪占用：:${state.externalTracePort}`
        : '追踪未开启';
    return Menu.buildFromTemplate([
      { label: `XwX Deck · ${status}`, enabled: false },
      { type: 'separator' },
      { label: state.tracingEnabled ? '停止追踪' : '开始追踪', click: this.actions.toggleTracing },
      ...(state.update?.updateAvailable && state.update.targetVersion ? [{ type: 'separator' as const }, {
        label: `更新到 XwX Deck ${state.update.targetVersion}…`,
        click: this.actions.showUpdateDetails
      }] : []),
      { type: 'separator' },
      ...this.gatewayMenuItems(state),
      { label: '退出', click: this.actions.quit }
    ]);
  }

  private buildDockMenu(state: XwXDeckRuntimeState): Menu {
    return Menu.buildFromTemplate([
      ...this.gatewayMenuItems(state)
      // macOS appends its native “退出” item to the Dock menu.
    ]);
  }

  private gatewayMenuItems(state: XwXDeckRuntimeState): Electron.MenuItemConstructorOptions[] {
    if (this.pendingGatewayAction) {
      return [{
        label: this.pendingGatewayAction === 'close' ? '正在关闭代理…' : '正在开启代理…',
        enabled: false
      }];
    }
    if (!state.backgroundGatewayAction) return [];
    const action = state.backgroundGatewayAction;
    return [{
      label: action === 'close' ? '关闭代理' : '开启代理',
      click: () => this.actions.toggleGateway(action)
    }];
  }
}

function createTrayIcon(active: boolean): Electron.NativeImage {
  const template = process.platform === 'darwin';
  const image = nativeImage.createFromPath(assetPath(template ? 'trayTemplate.png' : 'tray.png'));
  if (!image.isEmpty()) {
    image.setTemplateImage(template);
    return image;
  }
  const fallback = nativeImage.createFromPath(assetPath('tray.png'));
  if (!fallback.isEmpty()) return fallback;
  throw new Error(`Unable to load XwX Deck tray icon (active=${active}).`);
}
