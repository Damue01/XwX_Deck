import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron';
import * as path from 'path';
import { isChatGptRunning } from '../app/chatGptLifecycle';
import { isPathInsideCodexHome } from '../app/codexConversationDoctor';
import type { ClientId, XwXDeckController, XwXDeckRuntimeState } from '../app/xwxDeckController';
import type { XwXDeckUpdater } from '../update/xwxDeckUpdater';
import type { ManagerWindow } from '../window/managerWindow';

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type EventHandler = (event: IpcMainEvent, ...args: unknown[]) => void;

export interface IpcHandlerDependencies {
  readonly controller: () => XwXDeckController | undefined;
  readonly updater: () => XwXDeckUpdater | undefined;
  readonly managerWindow: ManagerWindow;
  readonly packagedSmokeTest: boolean;
  readonly currentState: () => Promise<XwXDeckRuntimeState>;
  readonly updateState: () => unknown;
  readonly refreshUi: () => Promise<XwXDeckRuntimeState | undefined>;
  readonly setStartupEnabled: (enabled: boolean) => Promise<XwXDeckRuntimeState | undefined>;
  readonly restartAndInstall: () => Promise<unknown>;
  readonly toggleTracing: () => Promise<XwXDeckRuntimeState | undefined>;
  readonly toggleClient: (client: ClientId) => Promise<XwXDeckRuntimeState | undefined>;
  readonly openDashboard: () => Promise<void>;
  readonly clearHistory: () => Promise<XwXDeckRuntimeState | undefined>;
  readonly repairApplication: () => Promise<{ removedCachePaths: number; removedBytes: number; refreshedModels?: number }>;
  readonly resetApplication: (input: { resetClientConfigs: boolean }) => Promise<void>;
}

export function registerIpcHandlers(deps: IpcHandlerDependencies): void {
  const requireController = (): XwXDeckController => {
    const controller = deps.controller();
    if (!controller) throw new Error('XwX Deck 仍在启动。');
    return controller;
  };
  const requireUpdater = (): XwXDeckUpdater => {
    const updater = deps.updater();
    if (!updater) throw new Error('XwX Deck updater is still starting.');
    return updater;
  };
  const handlers: Record<string, InvokeHandler> = {
    'xwxdeck:get-state': () => deps.currentState(),
    'xwxdeck:get-trace-stats': () => requireController().traceStats(),
    'xwxdeck:get-update-state': () => deps.updateState(),
    'xwxdeck:check-for-updates': () => requireUpdater().checkForUpdates(false),
    'xwxdeck:download-update': () => requireUpdater().downloadUpdate(),
    'xwxdeck:restart-and-install': () => deps.restartAndInstall(),
    'xwxdeck:set-startup-enabled': (_event, enabled) => {
      if (typeof enabled !== 'boolean') throw new Error('无效的开机启动设置。');
      return deps.setStartupEnabled(enabled);
    },
    'xwxdeck:set-theme': (_event, theme) => {
      if (theme !== 'day' && theme !== 'night') throw new Error('无效的主题设置。');
      return requireController().setTheme(theme);
    },
    'xwxdeck:set-trace-appearance': (_event, input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('无效的 Trace 外观设置。');
      return requireController().setTraceAppearance(input);
    },
    'xwxdeck:choose-trace-background': async event => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.OpenDialogOptions = {
        title: '选择 Trace 背景图片',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
      };
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0]) return undefined;
      return requireController().installTraceBackgroundImage(result.filePaths[0]);
    },
    'xwxdeck:clear-trace-background': () => requireController().clearTraceBackgroundImage(),
    'xwxdeck:repair-application': () => deps.repairApplication(),
    'xwxdeck:reset-application': (_event, input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('无效的重置选项。');
      const value = input as { resetClientConfigs?: unknown };
      if (typeof value.resetClientConfigs !== 'boolean') throw new Error('无效的客户端配置重置选项。');
      return deps.resetApplication({ resetClientConfigs: value.resetClientConfigs });
    },
    'xwxdeck:toggle-tracing': () => deps.toggleTracing(),
    'xwxdeck:toggle-client': (_event, client) => {
      if (!isClientId(client)) throw new Error('Unsupported XwX Deck client.');
      return deps.toggleClient(client);
    },
    'xwxdeck:get-codex-config': () => requireController().readCodexConfig(),
    'xwxdeck:is-chatgpt-running': () => isChatGptRunning(),
    'xwxdeck:get-codex-enhancements': () => requireController().readCodexEnhancements(),
    'xwxdeck:update-codex-enhancements': (_event, input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid ChatGPT enhancements payload.');
      return requireController().updateCodexEnhancements(input);
    },
    'xwxdeck:get-compatible-config': () => requireController().readCompatibleServiceConfig(),
    'xwxdeck:update-compatible-config': (_event, input) => {
      if (!input || typeof input !== 'object') throw new Error('Invalid 兼容服务 config payload.');
      return requireController().updateCompatibleServiceConfig(input);
    },
    'xwxdeck:get-model-services': () => requireController().readModelServices(),
    'xwxdeck:set-model-service': (_event, input) => {
      if (!input || typeof input !== 'object') throw new Error('Invalid model service payload.');
      const value = input as { client?: unknown; enabled?: unknown };
      if (value.client !== 'claude' && value.client !== 'codex') throw new Error('Unsupported model service client.');
      if (typeof value.enabled !== 'boolean') throw new Error('Invalid model service state.');
      return requireController().setModelService(value.client, value.enabled);
    },
    'xwxdeck:get-claude-models': () => requireController().readClaudeModels(),
    'xwxdeck:update-claude-models': (_event, input) => {
      if (!input || typeof input !== 'object') throw new Error('Invalid Claude models payload.');
      return requireController().updateClaudeModels(input as Record<string, string>);
    },
    'xwxdeck:update-codex-config': (_event, input) => {
      if (!input || typeof input !== 'object') throw new Error('Invalid ChatGPT config payload.');
      return requireController().updateCodexConfig(input);
    },
    'xwxdeck:diagnose-codex-conversations': () => requireController().diagnoseCodexConversations(),
    'xwxdeck:open-codex-conversation-path': (_event, input) => {
      if (typeof input !== 'string' || !input.trim() || !isPathInsideCodexHome(input)) {
        throw new Error('无效的 ChatGPT 会话路径。');
      }
      shell.showItemInFolder(path.resolve(input));
      return true;
    },
    'xwxdeck:fetch-models': (_event, input) => {
      const source = input && typeof input === 'object' && (input as { source?: unknown }).source === 'compatible'
        ? 'compatible'
        : 'active';
      const refresh = !!(input && typeof input === 'object' && (input as { refresh?: unknown }).refresh === true);
      return requireController().fetchModels(source, refresh);
    },
    'xwxdeck:choose-directory': async (event, input) => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const kind = input && typeof input === 'object' && !Array.isArray(input)
        ? (input as { kind?: unknown }).kind
        : undefined;
      const options: Electron.OpenDialogOptions = {
        title: kind === 'trace'
          ? '选择 Trace 数据目录'
          : kind === 'logs'
            ? '选择运行日志目录'
            : kind === 'claude'
              ? '选择 Claude 配置目录'
              : '选择配置目录',
        properties: ['openDirectory', 'createDirectory']
      };
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? undefined : result.filePaths[0];
    },
    'xwxdeck:update-trace-directories': (_event, input) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('无效的 Trace 目录设置。');
      return requireController().updateTraceDirectories(input);
    },
    'xwxdeck:open-dashboard': async () => {
      await deps.openDashboard();
      return deps.refreshUi();
    },
    'xwxdeck:open-data-folder': async () => {
      await requireController().xwxDeckFolder();
      return deps.currentState();
    },
    'xwxdeck:open-log-folder': async () => {
      await requireController().openLogFolder();
      return deps.currentState();
    },
    'xwxdeck:clear-history': () => deps.clearHistory(),
    'xwxdeck:disable-breaks-codex': () => requireController().disableBreaksCodex(),
    'xwxdeck:refresh': () => deps.refreshUi(),
    'xwxdeck:window-minimize': event => deps.managerWindow.minimize(event.sender),
    'xwxdeck:window-toggle-fullscreen': event => deps.managerWindow.toggleFullscreen(event.sender),
    'xwxdeck:window-toggle-maximize': event => deps.managerWindow.toggleMaximize(event.sender),
    'xwxdeck:window-set-view': (event, view) => deps.managerWindow.setView(event.sender, view),
    'xwxdeck:window-close': event => deps.managerWindow.close(event.sender)
  };

  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);

  const events: Record<string, EventHandler> = {
    'xwxdeck:window-move-start': (event, payload) => deps.managerWindow.startMove(event.sender, payload),
    'xwxdeck:window-move': (event, payload) => deps.managerWindow.move(event.sender, payload),
    'xwxdeck:window-move-end': event => deps.managerWindow.endMove(event.sender),
    'xwxdeck:window-resize-start': (event, payload) => deps.managerWindow.startResize(event.sender, payload),
    'xwxdeck:window-resize-move': (event, payload) => deps.managerWindow.resize(event.sender, payload),
    'xwxdeck:window-resize-end': event => deps.managerWindow.endResize(event.sender)
  };
  for (const [channel, handler] of Object.entries(events)) ipcMain.on(channel, handler);
}

function isClientId(value: unknown): value is ClientId {
  return value === 'claude-cli' || value === 'codex-cli';
}
