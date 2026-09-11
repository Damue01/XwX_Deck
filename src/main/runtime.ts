import * as fs from 'fs';
import * as path from 'path';
import { app, dialog, nativeImage, Notification, session, shell } from 'electron';
import {
  APPLICATION_RESET_ARG,
  applicationResetRelaunchArgs,
  parseApplicationResetRequest,
  performApplicationRepair,
  performApplicationResetAtStartup,
  type ApplicationResetRequest
} from './app/applicationReset';
import { gatewayMenuActionMatches, type GatewayMenuAction } from './app/gatewayMenuAction';
import { isChatGptRunning, isClaudeRunning } from './app/chatGptLifecycle';
import {
  ClientId,
  XwXDeckController,
  XwXDeckRuntimeState,
  ShutdownDrainTimeoutError
} from './app/xwxDeckController';
import { buildTrayQuitPrompt } from './app/shutdownPrompt';
import {
  isStartupHiddenLaunch,
  readStartupSettings,
  startupRegistrationMatches,
  setStartupEnabled as setLoginStartupEnabled
} from './app/startup';
import { registerIpcHandlers } from './ipc/registerHandlers';
import { assetPath } from './shared/assets';
import { errorMessage } from './shared/error';
import { initLogger, log } from './shared/logger';
import { runPackagedSmokeTest } from './smoke/packagedSmoke';
import { loadModelsDevPricingCache, refreshModelsDevPricingCache } from './trace/modelsDevPricing';
import { assertLoopbackSystemProxyReachable, selectSystemProxy } from './trace/systemProxy';
import { XwXDeckTray } from './tray';
import { XwXDeckUpdater } from './update/xwxDeckUpdater';
import { MetadataInvalidationSubscriber } from './update/metadataInvalidationSubscriber';
import { metadataPushUrl } from './update/updateServer';
import {
  acknowledgePortableUpdateReady,
  cleanupPortableUpdateFiles,
  readPortableUpdateLaunchResult,
  safePortableCleanupPaths
} from './update/portableUpdate';
import { ManagerWindow } from './window/managerWindow';

let controller: XwXDeckController | undefined;
let updater: XwXDeckUpdater | undefined;
let tray: XwXDeckTray | undefined;
let managerWindow: ManagerWindow | undefined;
let metadataSubscriber: MetadataInvalidationSubscriber | undefined;
let quitState: 'idle' | 'cleaning' | 'ready' = 'idle';
let fullShutdownRequested = false;
let tracingToggle: Promise<XwXDeckRuntimeState | undefined> | undefined;
let gatewayToggle: Promise<void> | undefined;
let macApplicationIcon = { applied: false, width: 0, height: 0, cornerAlpha: 0, centerAlpha: 0 };

const PACKAGED_SMOKE_TEST = process.env.XWX_DECK_SMOKE_TEST === '1';
const PACKAGED_BACKGROUND_GATEWAY_SMOKE = process.env.XWX_DECK_BACKGROUND_GATEWAY_SMOKE === '1';
const START_HIDDEN = isStartupHiddenLaunch();
const PORTABLE_UPDATE_RESULT = readPortableUpdateLaunchResult();

if (process.env.XWX_DECK_PORTABLE_UPDATE_SMOKE === '1') {
  runPortableUpdateSmoke();
} else {
  startMainProcess();
}

function runPortableUpdateSmoke(): void {
  app.whenReady()
    .then(async () => {
      const resultPath = process.env.XWX_DECK_PORTABLE_UPDATE_SMOKE_RESULT;
      if (!resultPath || PORTABLE_UPDATE_RESULT?.kind !== 'complete') {
        throw new Error('Portable update smoke did not restart through a completed update.');
      }
      await acknowledgePortableUpdateReady(PORTABLE_UPDATE_RESULT);
      await fs.promises.mkdir(path.dirname(resultPath), { recursive: true });
      await fs.promises.writeFile(resultPath, `${JSON.stringify(PORTABLE_UPDATE_RESULT, null, 2)}\n`, 'utf8');
      app.exit(0);
    })
    .catch(error => {
      console.error('[updater] portable update smoke failed', error);
      app.exit(1);
    });
}

function startMainProcess(): void {
  let isolatedUserData = false;
  if (process.env.XWX_DECK_UPDATE_PREVIEW === '1' && process.env.XWX_DECK_PREVIEW_USER_DATA) {
    app.setPath('userData', path.resolve(process.env.XWX_DECK_PREVIEW_USER_DATA));
    isolatedUserData = true;
  }
  if ((PACKAGED_SMOKE_TEST || PACKAGED_BACKGROUND_GATEWAY_SMOKE) && process.env.XWX_DECK_SMOKE_USER_DATA) {
    app.setPath('userData', path.resolve(process.env.XWX_DECK_SMOKE_USER_DATA));
    isolatedUserData = true;
  }
  // The standalone edition uses its own data namespace so it can be installed
  // alongside the internal XwX Deck build without sharing settings or traces.
  const standaloneUserDataDir = isolatedUserData
    ? app.getPath('userData')
    : path.join(app.getPath('appData'), 'xwx-deck');
  app.setPath('userData', standaloneUserDataDir);
  const resetRequest = parseApplicationResetRequest(process.argv);

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', (_event, argv) => {
      if (isStartupHiddenLaunch(argv)) return;
      runDetached('open manager for second instance', openManager);
    });
  }

  // The reset destroys userData, so it must never run in a process that lost the
  // single-instance race — that process would delete the live instance's data
  // and then quit, taking the app down with it.
  if (resetRequest && gotLock) {
    try {
      const reset = performApplicationResetAtStartup(standaloneUserDataDir, resetRequest, {
        allowedParentDir: path.dirname(standaloneUserDataDir)
      });
      if (reset.removedClientFiles.length) {
        console.info(`[xwxdeck] removed ${reset.removedClientFiles.length} client core config file(s) during reset`);
      }
      if (reset.skippedClientFiles.length) {
        recordStartupResetFailure(
          standaloneUserDataDir,
          `未能删除客户端配置：${reset.skippedClientFiles.join('、')}`
        );
      }
    } catch (error) {
      // The logger is not initialised this early and a packaged build has no
      // console, so persist the reason where the app can surface it after boot
      // instead of dying before the first window with no trace of why.
      recordStartupResetFailure(standaloneUserDataDir, errorMessage(error));
      console.error(`[xwxdeck] application reset failed: ${errorMessage(error)}`);
    }
  }
  if (resetRequest) {
    process.argv.splice(
      0,
      process.argv.length,
      ...process.argv.filter(value => !value.startsWith(APPLICATION_RESET_ARG))
    );
  }

  app.setName('XwX Deck');
  app.setPath('userData', standaloneUserDataDir);
  if (process.platform === 'win32') app.setAppUserModelId('app.xwxdeck.desktop');
  app.on('child-process-gone', (_event, details) => {
    const service = details.serviceName || details.name || 'unknown';
    const message = `[xwxdeck] child process exited: type=${details.type} service=${service} reason=${details.reason} code=${details.exitCode}`;
    if (details.reason === 'clean-exit') log.info(message);
    else log.error(message);
  });

  app.whenReady()
    .then(async () => {
      const userDataDir = app.getPath('userData');
      initLogger(userDataDir);
      reportPendingResetFailure();
      if (PACKAGED_BACKGROUND_GATEWAY_SMOKE) {
        await runPackagedBackgroundGatewaySmoke(userDataDir);
        return;
      }
      macApplicationIcon = applyMacApplicationIcon();
      const pricingOptions = {
        userDataDir,
        bundledCachePath: assetPath('models-dev-pricing.json')
      };
      const pricingRuleCount = await loadModelsDevPricingCache(pricingOptions);
      log.info(`[pricing] loaded ${pricingRuleCount} exact models.dev rules`);
      if (!PACKAGED_SMOKE_TEST) {
        runDetached('refresh models.dev pricing', async () => {
          const result = await refreshModelsDevPricingCache(pricingOptions);
          log.info(`[pricing] ${result.status}: ${result.ruleCount} exact rules`);
        });
      }
      controller = new XwXDeckController(userDataDir, {
        backgroundGateway: !PACKAGED_SMOKE_TEST,
        resolveUpstreamProxyUrl,
        ...(PACKAGED_SMOKE_TEST ? { codexHistoryMutationAllowed: async () => true } : {})
      });
      updater = new XwXDeckUpdater();
      managerWindow = new ManagerWindow({
        state: currentState,
        preloadPath: path.join(__dirname, 'preload.js'),
        iconPath: assetPath('icon.png'),
        hidden: PACKAGED_SMOKE_TEST,
        onClosed: undefined,
        onRendererRecoveryExhausted: details => {
          log.error(`[xwxdeck] manager recovery exhausted: reason=${details.reason} code=${details.exitCode}`);
          if (!PACKAGED_SMOKE_TEST && Notification.isSupported()) {
            new Notification({
              title: 'XwX Deck 管理窗口需要重启',
              body: '图形进程连续异常退出；追踪仍在托盘运行，请退出并重新启动 XwX Deck。'
            }).show();
          }
        }
      });
      tray = new XwXDeckTray({
        openManager: () => runDetached('open manager from tray', openManager),
        toggleTracing: () => runDetached('toggle tracing from tray', toggleTracingFromTray),
        showUpdateDetails: () => runDetached('show update details from tray', () => managerWindow?.showUpdateDetails() ?? Promise.resolve()),
        quit: requestFullShutdownFromTray,
        toggleGateway: expectedAction => runDetached(
          `run ${expectedAction} background Gateway action`,
          () => toggleBackgroundGateway(expectedAction)
        )
      });
      registerIpcHandlers({
        controller: () => controller,
        updater: () => updater,
        managerWindow,
        packagedSmokeTest: PACKAGED_SMOKE_TEST,
        currentState,
        updateState,
        refreshUi,
        setStartupEnabled,
        restartAndInstall,
        toggleTracing,
        toggleClient,
        openDashboard,
        clearHistory,
        repairApplication,
        resetApplication
      });
      controller.onDidChange(() => runDetached('refresh UI after controller change', refreshUi));
      updater.onDidChange(state => {
        runDetached('refresh UI after updater change', refreshUi);
        if (state.status === 'ready') {
          runDetached('show downloaded update', () => managerWindow?.showUpdateDetails() ?? Promise.resolve());
        }
      });
      await updater.start();
      await reconcileStartupWithIntent();
      await controller.start();
      const metadataUrl = metadataPushUrl();
      if (!PACKAGED_SMOKE_TEST && metadataUrl) {
        metadataSubscriber = new MetadataInvalidationSubscriber(metadataUrl, async event => {
          const topics = new Set(event.topics);
          if (topics.has('pricing')) {
            const result = await refreshModelsDevPricingCache(pricingOptions);
            log.info(`[metadata] pricing ${result.status}: ${result.ruleCount} rules (${event.reason})`);
          }
          if (topics.has('models') || topics.has('capabilities')) {
            const count = await controller?.refreshModelMetadata() ?? 0;
            log.info(`[metadata] refreshed ${count} 兼容服务 models (${event.reason})`);
          }
          await refreshUi();
        }, { logger: log });
        metadataSubscriber.start();
      }
      await restoreLegacyOfficialHistoryIfChatGptStopped('startup');
      await refreshUi();
      if (!START_HIDDEN || PACKAGED_SMOKE_TEST) await openManager();
      await handlePortableUpdateLaunchResult();
      if (PACKAGED_SMOKE_TEST) {
        const win = managerWindow.current();
        if (!win) throw new Error('Packaged smoke manager window is unavailable.');
        const initialWindowBounds = win.getBounds();
        const initialContentSize = win.getContentSize();
        const result = await runPackagedSmokeTest(win) as Record<string, unknown>;
        const rendererId = win.webContents.id;
        managerWindow.close(win.webContents);
        await managerWindow.open();
        const reopened = managerWindow.current();
        if (!reopened || reopened.webContents.id !== rendererId) {
          throw new Error('Closing to the tray must preserve the healthy manager renderer.');
        }
        reopened.webContents.forcefullyCrashRenderer();
        const recoveryDeadline = Date.now() + 5000;
        while (managerWindow.current() === reopened && Date.now() < recoveryDeadline) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (managerWindow.current() === reopened) {
          throw new Error('Crashed manager window was not discarded.');
        }
        await managerWindow.open();
        const recovered = managerWindow.current();
        if (!recovered || recovered.webContents.id === rendererId) {
          throw new Error('Manager renderer was not recreated after termination.');
        }
        const recoveredFieldRenderer = await recovered.webContents.executeJavaScript(`new Promise((resolve, reject) => {
          const deadline = Date.now() + 5000;
          const check = () => {
            const field = document.querySelector('canvas.field');
            if (field?.dataset.renderer) return resolve(field.dataset.renderer);
            if (Date.now() >= deadline) return reject(new Error('Recovered manager UI did not render.'));
            setTimeout(check, 50);
          };
          check();
        })`);
        if (recoveredFieldRenderer !== '2d') {
          throw new Error(`Recovered manager changed the field renderer to ${String(recoveredFieldRenderer)}.`);
        }
        const ui = result.ui && typeof result.ui === 'object' ? result.ui as Record<string, unknown> : {};
        await finishPackagedSmokeTest({
          ...result,
          ui: {
            ...ui,
            initialWindowBounds: {
              width: initialWindowBounds.width,
              height: initialWindowBounds.height
            },
            initialContentSize: {
              width: initialContentSize[0],
              height: initialContentSize[1]
            },
            rendererReusedAfterTrayClose: true,
            rendererRecreatedAfterCrash: true,
            recoveredFieldRenderer,
            macApplicationIcon
          }
        }, 0);
        return;
      }
      updater.scheduleStartupCheck();
    })
    .catch(err => {
      log.error('[xwxdeck] failed to start', err);
      if (PACKAGED_SMOKE_TEST || PACKAGED_BACKGROUND_GATEWAY_SMOKE) {
        void finishPackagedSmokeTest({ ok: false, error: errorMessage(err) }, 1);
        return;
      }
      dialog.showErrorBox('XwX Deck failed to start', errorMessage(err));
    });

  app.on('window-all-closed', () => {
    // Keep the tray app alive after windows are closed.
  });

  app.on('activate', () => {
    // Re-open the manager when the macOS Dock icon is clicked after the window
    // was closed with Cmd+W or hidden to the menu bar.
    runDetached('open manager after app activation', openManager);
  });

  app.on('before-quit', event => {
    log.info(`[xwxdeck] before-quit requested (state=${quitState})`);
    if (quitState === 'ready') return;
    event.preventDefault();
    if (quitState === 'cleaning') return;
    quitState = 'cleaning';
    void (async () => {
      try {
        const confirmContext: ShutdownConfirmContext = 'tray-quit';
        const shutdown = await prepareSafeShutdown(confirmContext);
        await controller?.beginShutdown();
        await shutdownControllerWithConfirmation(
          shutdown.forceShutdown,
          shutdown.chatGptMayBeRunning,
          confirmContext
        );
        log.info('[xwxdeck] application exit restored direct client configuration and stopped the Gateway');
        quitState = 'ready';
        app.exit(0);
      } catch (err) {
        await controller?.cancelShutdown().catch(() => undefined);
        quitState = 'idle';
        fullShutdownRequested = false;
        if (err instanceof ShutdownCancelledError) {
          log.info('[xwxdeck] shutdown cancelled by user');
          await refreshUi().catch(() => undefined);
          return;
        }
        const message = errorMessage(err);
        log.warn(`[xwxdeck] shutdown cancelled: ${message}`);
        await showManagerNotice(`未能退出：${message}`, 'error');
        await refreshUi().catch(() => undefined);
      }
    })();
  });
}

class ShutdownCancelledError extends Error {
  constructor() {
    super('用户取消了当前操作。');
    this.name = 'ShutdownCancelledError';
  }
}

interface SafeShutdownPreparation {
  readonly forceShutdown: boolean;
  readonly chatGptMayBeRunning: boolean;
  readonly claudeMayBeRunning: boolean;
  readonly activity: { readonly activeRequests: number; readonly pendingContinuations: number };
}

async function inspectSafeShutdown(): Promise<SafeShutdownPreparation> {
  if (!controller) {
    return {
      forceShutdown: false,
      chatGptMayBeRunning: false,
      claudeMayBeRunning: false,
      activity: { activeRequests: 0, pendingContinuations: 0 }
    };
  }
  const requiresChatGptExit = controller.requiresCodexClientExitBeforeShutdown();
  let chatGptMayBeRunning = false;
  if (requiresChatGptExit) {
    try {
      chatGptMayBeRunning = await isChatGptRunning();
    } catch (error) {
      chatGptMayBeRunning = true;
      log.warn(`[xwxdeck] could not detect ChatGPT during shutdown; continuing without controlling it: ${errorMessage(error)}`);
    }
  } else {
    // Official direct mode is independent: never force ChatGPT to quit just to
    // close XwX Deck. If it has already exited voluntarily, use the safe idle
    // window to repair the narrowly identified legacy history rows.
    await restoreLegacyOfficialHistoryIfChatGptStopped('shutdown');
  }

  const claudeMayBeRunning = controller.requiresClaudeClientExitBeforeShutdown() && await isClaudeRunning().catch(() => true);
  const activity = await controller.shutdownActivity();
  const hasActiveConversation = activity.activeRequests > 0 || activity.pendingContinuations > 0;
  return {
    forceShutdown: chatGptMayBeRunning || claudeMayBeRunning || hasActiveConversation,
    chatGptMayBeRunning,
    claudeMayBeRunning,
    activity
  };
}

type ShutdownConfirmContext = 'default' | 'tray-quit';

async function prepareSafeShutdown(
  confirmContext: ShutdownConfirmContext = 'default'
): Promise<SafeShutdownPreparation> {
  if (confirmContext === 'tray-quit') {
    const activity = controller?.shutdownActivitySnapshot()
      ?? { activeRequests: 0, pendingContinuations: 0 };
    const chatGptMayBeRunning = controller?.requiresCodexClientExitBeforeShutdown() === true;
    const claudeMayBeRunning = controller?.requiresClaudeClientExitBeforeShutdown() === true;
    const initial = {
      claudeMayBeRunning,
      forceShutdown: chatGptMayBeRunning
        || activity.activeRequests > 0
        || activity.pendingContinuations > 0,
      chatGptMayBeRunning,
      activity
    };
    const confirmed = await showTrayQuitConfirm(initial);
    if (!confirmed) throw new ShutdownCancelledError();
    try {
      return await inspectSafeShutdown();
    } catch (error) {
      log.warn(`[xwxdeck] live shutdown inspection failed after confirmation; forcing recovery: ${errorMessage(error)}`);
      return { ...initial, forceShutdown: true };
    }
  }
  const shutdown = await inspectSafeShutdown();
  if (shutdown.forceShutdown) {
    const confirmed = await showImmediateShutdownConfirm(shutdown.activity);
    if (!confirmed) throw new ShutdownCancelledError();
  }
  return shutdown;
}

async function shutdownControllerWithConfirmation(
  forceShutdown: boolean,
  skipCodexHistoryRepair = false,
  confirmContext: ShutdownConfirmContext = 'default'
): Promise<void> {
  if (!controller) return;
  if (forceShutdown) {
    await controller.shutdown({ force: true, skipCodexHistoryRepair });
    return;
  }
  try {
    await controller.shutdown({ drainTimeoutMs: 1_000, skipCodexHistoryRepair });
  } catch (error) {
    if (!(error instanceof ShutdownDrainTimeoutError)) throw error;
    const activity = await controller.shutdownActivity();
    if (confirmContext === 'tray-quit') {
      await controller.shutdown({ force: true, skipCodexHistoryRepair });
      return;
    }
    const confirmed = await showImmediateShutdownConfirm(activity);
    if (!confirmed) throw new ShutdownCancelledError();
    await controller.shutdown({ force: true, skipCodexHistoryRepair });
  }
}

function requestFullShutdownFromTray(): void {
  fullShutdownRequested = true;
  app.quit();
}

/**
 * The reset runs before the logger exists and a packaged build has no console,
 * so a failure would otherwise be completely invisible. Leave a breadcrumb the
 * app reports once it is up.
 */
function recordStartupResetFailure(userDataDir: string, reason: string): void {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDataDir, 'reset-failure.json'),
      JSON.stringify({ at: new Date().toISOString(), reason }, null, 2),
      'utf8'
    );
  } catch { /* nothing left to do this early */ }
}

/** Report and clear a reset failure breadcrumb once the logger is available. */
function reportPendingResetFailure(): void {
  const marker = path.join(app.getPath('userData'), 'reset-failure.json');
  try {
    if (!fs.existsSync(marker)) return;
    const { reason } = JSON.parse(fs.readFileSync(marker, 'utf8')) as { reason?: string };
    fs.rmSync(marker, { force: true });
    log.error(`[xwxdeck] previous application reset did not complete: ${reason ?? 'unknown'}`);
    runDetached('report reset failure', () => showManagerNotice(
      `上次重置未完成：${reason ?? '原因未知'}`,
      'error'
    ));
  } catch { /* a malformed breadcrumb is not worth blocking startup */ }
}

async function showTrayQuitConfirm(shutdown: SafeShutdownPreparation): Promise<boolean> {
  const options = buildTrayQuitPrompt({
    ...shutdown.activity,
    chatGptMayBeRunning: shutdown.chatGptMayBeRunning,
    claudeMayBeRunning: shutdown.claudeMayBeRunning
  });
  const owner = managerWindow?.current();
  const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  return result.response === 1;
}

async function restoreLegacyOfficialHistoryIfChatGptStopped(reason: string): Promise<void> {
  if (!controller) return;
  try {
    if (await isChatGptRunning()) return;
    await controller.restoreLegacyOfficialHistoryAfterChatGptExit();
  } catch (error) {
    // This compatibility repair is opportunistic. It must never turn an
    // otherwise independent official-mode startup or exit into a hard block.
    log.warn(`[xwxdeck] legacy official history restore skipped (${reason}): ${errorMessage(error)}`);
  }
}

async function showImmediateShutdownConfirm(
  activity: { activeRequests: number; pendingContinuations: number }
): Promise<boolean> {
  const state: string[] = [];
  if (activity.activeRequests > 0) state.push(`仍有 ${activity.activeRequests} 个 AI 请求正在通过代理传输。`);
  else if (activity.pendingContinuations > 0) state.push('AI 对话正在等待工具调用继续。');
  const consequence = '继续后可能立即中断当前请求；未完成的回复和工具调用结果可能丢失。XwX Deck 不会关闭或打开 ChatGPT。';
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['取消', '确认关闭'],
    defaultId: 0,
    cancelId: 0,
    title: '关闭代理',
    message: '确认关闭代理吗？',
    detail: state.length ? `${state.join('\n')}\n\n${consequence}` : consequence
  };
  const owner = managerWindow?.current();
  const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  return result.response === 1;
}

function applyMacApplicationIcon(): {
  applied: boolean;
  width: number;
  height: number;
  cornerAlpha: number;
  centerAlpha: number;
} {
  if (process.platform !== 'darwin' || !app.dock) {
    return { applied: false, width: 0, height: 0, cornerAlpha: 0, centerAlpha: 0 };
  }
  // A packaged macOS application gets its Dock, Finder and app-switcher icons
  // from the multi-resolution CFBundleIconFile (assets/icon.icns). Do not
  // replace that AppKit-managed icon with a single 256 px bitmap at runtime.
  if (app.isPackaged) {
    log.info('[xwxdeck] using packaged macOS ICNS application icon');
    return { applied: false, width: 0, height: 0, cornerAlpha: 0, centerAlpha: 0 };
  }
  const image = nativeImage.createFromPath(assetPath('icon-runtime.png'));
  if (image.isEmpty()) throw new Error('Unable to load the macOS application icon.');
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const cornerAlpha = bitmap[3] ?? 0;
  const centerOffset = ((Math.floor(size.height / 2) * size.width) + Math.floor(size.width / 2)) * 4 + 3;
  const centerAlpha = bitmap[centerOffset] ?? 0;
  if (cornerAlpha !== 0 || centerAlpha !== 255) {
    throw new Error(`macOS runtime icon alpha mask is invalid (corner=${cornerAlpha}, center=${centerAlpha}).`);
  }
  app.dock.setIcon(image);
  log.info(`[xwxdeck] applied development macOS application icon ${size.width}x${size.height}`);
  return { applied: true, width: size.width, height: size.height, cornerAlpha, centerAlpha };
}

async function currentState(): Promise<XwXDeckRuntimeState> {
  if (!controller) throw new Error('XwX Deck 仍在启动。');
  return {
    ...(await controller.runtimeState()),
    startup: readStartupSettings(),
    update: updateState()
  };
}

function updateState() {
  return updater?.state() ?? {
    status: 'idle' as const,
    currentVersion: app.getVersion(),
    channel: 'release' as const,
    portable: false,
    installMode: process.platform === 'darwin' ? 'manual-dmg' as const : 'automatic' as const,
    supported: app.isPackaged,
    updateAvailable: false
  };
}

async function refreshUi(): Promise<XwXDeckRuntimeState | undefined> {
  if (!controller) return undefined;
  const state = await currentState();
  tray?.refresh(state);
  managerWindow?.sendState(state);
  return state;
}

async function setStartupEnabled(enabled: boolean): Promise<XwXDeckRuntimeState | undefined> {
  if (!controller) return undefined;
  const previous = readStartupSettings();
  await setLoginStartupEnabled(enabled);
  try {
    await controller.setStartupIntent(enabled);
  } catch (error) {
    if (previous.supported) {
      try {
        await setLoginStartupEnabled(previous.enabled);
      } catch (rollbackError) {
        log.warn(`[xwxdeck] startup registration rollback failed: ${errorMessage(rollbackError)}`);
      }
    }
    throw error;
  }
  return refreshUi();
}

/**
 * Windows portable builds register the login item against the exact exe path.
 * macOS registers the packaged main app. Re-align either registration on every
 * launch from the persisted intent.
 */
async function reconcileStartupWithIntent(): Promise<void> {
  if (!controller) return;
  const intent = await controller.readStartupIntent();
  const current = readStartupSettings();
  if (!current.supported || startupRegistrationMatches(current, intent)) return;
  try {
    await setLoginStartupEnabled(intent);
  } catch (error) {
    const actual = readStartupSettings();
    if (actual.supported) await controller.setStartupIntent(actual.enabled);
    log.warn(`[xwxdeck] startup reconcile failed; persisted actual OS state: ${errorMessage(error)}`);
  }
}

async function restartAndInstall() {
  if (!updater) throw new Error('XwX Deck updater is still starting.');
  updater.markInstalling();
  await refreshUi();
  if (updater.state().installMode === 'manual-dmg') {
    try {
      await updater.quitAndInstall();
      await refreshUi();
    } catch (error) {
      updater.failInstallation(error);
      await refreshUi();
      throw error;
    }
    return updater.state();
  }
  try {
    // Automatic/portable replacement cannot leave an old-version data plane
    // behind. Mark this as an explicit full shutdown before any quit path can
    // re-enter `before-quit`; ordinary manager exit uses its own confirmation
    // and persists the proxy as closed.
    fullShutdownRequested = true;
    const portable = updater.state().portable;
    await controller?.beginShutdown();
    const shutdown = await prepareSafeShutdown();
    await shutdownControllerWithConfirmation(shutdown.forceShutdown, shutdown.chatGptMayBeRunning);
    quitState = 'ready';
    await updater.quitAndInstall();
    if (portable) app.quit();
  } catch (error) {
    await controller?.cancelShutdown().catch(() => undefined);
    quitState = 'idle';
    fullShutdownRequested = false;
    if (error instanceof ShutdownCancelledError) {
      updater.cancelInstallation();
      await refreshUi();
      return updater.state();
    }
    updater.failInstallation(error);
    await refreshUi();
    throw error;
  }
  return updater.state();
}

async function handlePortableUpdateLaunchResult(): Promise<void> {
  if (!PORTABLE_UPDATE_RESULT || PACKAGED_SMOKE_TEST) return;
  if (PORTABLE_UPDATE_RESULT.kind === 'failed') {
    dialog.showErrorBox('XwX Deck 更新未完成', `已恢复可用版本并重新启动。\n\n${PORTABLE_UPDATE_RESULT.message}`);
    return;
  }
  await acknowledgePortableUpdateReady(PORTABLE_UPDATE_RESULT);
  if (Notification.isSupported()) {
    new Notification({
      title: 'XwX Deck 更新完成',
      body: PORTABLE_UPDATE_RESULT.version
        ? `已更新到 ${PORTABLE_UPDATE_RESULT.version}`
        : '新版本已安装并重新启动'
    }).show();
  }
  const cleanupPaths = safePortableCleanupPaths(
    PORTABLE_UPDATE_RESULT.cleanupPaths,
    process.env.PORTABLE_EXECUTABLE_FILE
  );
  runDetached('clean portable update files', () => cleanupPortableUpdateFiles(cleanupPaths));
}

async function toggleTracing(): Promise<XwXDeckRuntimeState | undefined> {
  if (tracingToggle) return tracingToggle;
  tracingToggle = toggleTracingOnce();
  try {
    return await tracingToggle;
  } finally {
    tracingToggle = undefined;
  }
}

async function resolveUpstreamProxyUrl(url: string): Promise<string | undefined> {
  const rules = await session.defaultSession.resolveProxy(url);
  const selected = selectSystemProxy(rules);
  if (selected.kind === 'direct') return undefined;
  if (selected.kind === 'proxy') { await assertLoopbackSystemProxyReachable(selected.url); return selected.url; }
  throw new Error(`系统代理规则暂不受 XwX Deck Gateway 支持：${selected.rule}`);
}

async function toggleBackgroundGateway(expectedAction: GatewayMenuAction): Promise<void> {
  if (gatewayToggle) return gatewayToggle;
  tray?.setGatewayActionPending(expectedAction);
  gatewayToggle = toggleBackgroundGatewayOnce(expectedAction);
  try {
    await gatewayToggle;
  } finally {
    gatewayToggle = undefined;
    tray?.setGatewayActionPending(undefined);
  }
}

async function toggleBackgroundGatewayOnce(expectedAction: GatewayMenuAction): Promise<void> {
  if (!controller) return;
  const action = await controller.backgroundGatewayAction();
  if (!gatewayMenuActionMatches(expectedAction, action)) {
    log.warn(`[xwxdeck] ignored stale Gateway menu action: shown=${expectedAction} current=${action ?? 'hidden'}`);
    await refreshUi();
    return;
  }
  if (action === 'close') {
    try {
      const shutdown = await inspectSafeShutdown();
      await controller.beginShutdown();
      await controller.shutdown({
        drainTimeoutMs: 1_000,
        skipCodexHistoryRepair: shutdown.chatGptMayBeRunning
      });
      await controller.finishShutdown(true);
      log.info('[xwxdeck] background Gateway closed without controlling ChatGPT; menu action switched to open');
      await showManagerNotice('代理已关闭。', 'success');
    } catch (error) {
      await controller.cancelShutdown().catch(() => undefined);
      if (error instanceof ShutdownDrainTimeoutError) {
        log.info('[xwxdeck] background Gateway close deferred because a conversation is active');
        await showManagerNotice('有请求正在进行，暂未关闭代理。', 'info');
        return;
      }
      // A dead or wedged control channel used to dead-end here with
      // "代理未关闭：Gateway control request timed out." while the Gateway kept
      // running and the clients kept pointing at it. The user asked for the
      // proxy to close, so escalate the same way the exit path does: restore
      // client configuration first, then stop the helper by PID.
      log.warn(
        `[xwxdeck] background Gateway close failed over the control channel; forcing stop: ${errorMessage(error)}`
      );
      try {
        const forced = await controller.forceExit();
        await controller.finishShutdown(true);
        log.info('[xwxdeck] background Gateway force-stopped after control-channel failure');
        await showManagerNotice(
          forced.dependentClients.length
            ? `代理已强制关闭，但 ${forced.dependentClients.join('、')} 的配置可能仍指向本地代理，请重启该客户端。`
            : '代理已关闭（控制通道无响应，已强制停止）。',
          forced.dependentClients.length ? 'info' : 'success'
        );
      } catch (forceError) {
        await controller.cancelShutdown().catch(() => undefined);
        log.error(`[xwxdeck] forced background Gateway stop failed: ${errorMessage(forceError)}`);
        await showManagerNotice(`代理未关闭：${errorMessage(forceError)}`, 'error');
        return;
      }
    }
  } else if (action === 'open') {
    try {
      const wasPaused = await controller.backgroundGatewayPaused();
      await controller.setBackgroundGatewayPaused(false, 'user selected 开启代理');
      if (wasPaused) await controller.start();
      if (!controller.backgroundGatewayActive()) await controller.startBackgroundGateway();
      log.info('[xwxdeck] background Gateway opened without controlling ChatGPT');
      await showManagerNotice('代理已开启；未生效时请重启 ChatGPT。', 'success');
    } catch (error) {
      await controller.setBackgroundGatewayPaused(true, 'Gateway open failed').catch(() => undefined);
      await showManagerNotice(`代理未开启：${errorMessage(error)}`, 'error');
      return;
    }
  } else {
    return;
  }
  await refreshUi();
}

async function toggleTracingOnce(): Promise<XwXDeckRuntimeState | undefined> {
  if (!controller) return undefined;
  try {
    await controller.toggle();
  } catch (err) {
    log.warn(`[xwxdeck] toggle failed: ${errorMessage(err)}`);
    await refreshUi();
    throw err;
  }
  return refreshUi();
}

/** Tray actions never create hidden native dialogs. Unsafe stops are deferred
 * and explained in the manager's bottom-right notice surface. */
async function toggleTracingFromTray(): Promise<void> {
  if (controller && await controller.disableBreaksCodex()) {
    await showManagerNotice('有请求正在进行，暂未停止 Trace。', 'info');
    return;
  }
  try {
    const next = await toggleTracing();
    if (next) {
      await showManagerNotice(next.tracingEnabled
        ? 'Trace 已开启；未生效时请重启 ChatGPT。'
        : 'Trace 已停止。', 'success');
    }
  } catch (err) {
    await showManagerNotice(`无法切换 Trace：${errorMessage(err)}`, 'error');
  }
}

async function showManagerNotice(message: string, type: 'success' | 'error' | 'info'): Promise<void> {
  await managerWindow?.showNotice({ message, type });
}

async function toggleClient(client: ClientId): Promise<XwXDeckRuntimeState | undefined> {
  if (!controller) return undefined;
  // No dialog: IPC callers (renderer) show a toast on failure; the tray path
  // swallows via its own .catch. Keeping this dialog-free avoids a system
  // popup racing the styled UI.
  try {
    await controller.toggleClient(client);
  } catch (err) {
    await refreshUi();
    throw err;
  }
  return refreshUi();
}

async function openManager(): Promise<void> {
  if (quitState === 'cleaning' || !controller || !managerWindow) return;
  await managerWindow.open();
}

async function openDashboard(): Promise<void> {
  if (!controller) return;
  await controller.startProxy('open-dashboard');
  const url = controller.dashboardUrl();
  if (url) await shell.openExternal(url);
}

async function clearHistory(): Promise<XwXDeckRuntimeState | undefined> {
  if (!controller) return undefined;
  // SettingsPage owns the single styled confirmation.
  await controller.clearHistory();
  return refreshUi();
}

async function resetApplication(request: ApplicationResetRequest): Promise<void> {
  if (!controller) throw new Error('XwX Deck 仍在启动。');
  if (request.resetClientConfigs) {
    let clientsRunning: { chatGpt: boolean; claude: boolean };
    try {
      const [chatGpt, claude] = await Promise.all([isChatGptRunning(), isClaudeRunning()]);
      clientsRunning = { chatGpt, claude };
    } catch (error) {
      log.warn(`[xwxdeck] could not verify client processes before reset: ${errorMessage(error)}`);
      throw new Error('无法确认 Claude 和 ChatGPT 是否已退出。请关闭两个客户端后重试。');
    }
    const running = [
      clientsRunning.claude ? 'Claude' : '',
      clientsRunning.chatGpt ? 'ChatGPT' : ''
    ].filter(Boolean);
    if (running.length) {
      throw new Error(`请先退出 ${running.join(' 和 ')}，再删除客户端配置。`);
    }
  }

  const shutdown = await inspectSafeShutdown();
  if (shutdown.chatGptMayBeRunning) {
    throw new Error('ChatGPT 仍在使用 XwX Deck 代理。请先退出 ChatGPT，再重置。');
  }
  if (shutdown.activity.activeRequests > 0 || shutdown.activity.pendingContinuations > 0) {
    throw new Error('仍有 AI 请求或工具调用正在进行，请等待完成后再重置。');
  }

  fullShutdownRequested = true;
  await controller.beginShutdown();
  try {
    await controller.shutdown({ drainTimeoutMs: 1_000 });
    metadataSubscriber?.stop();
    app.relaunch({ args: applicationResetRelaunchArgs(process.argv, request) });
    quitState = 'ready';
    app.exit(0);
  } catch (error) {
    await controller.cancelShutdown().catch(() => undefined);
    fullShutdownRequested = false;
    quitState = 'idle';
    throw error;
  }
}

async function repairApplication(): Promise<{
  removedCachePaths: number;
  removedBytes: number;
  refreshedModels?: number;
}> {
  const updateStatus = updater?.state().status;
  // 'ready' matters too: the verified installer lives under updates/ and the
  // updater still points at it, so clearing the cache would silently break the
  // pending install while the UI kept claiming it was downloaded.
  if (updateStatus === 'downloading' || updateStatus === 'installing' || updateStatus === 'ready') {
    throw new Error('XwX Deck 有待安装的更新，请先完成或取消更新，再运行快速修复。');
  }
  await session.defaultSession.clearCache();
  const result = performApplicationRepair(app.getPath('userData'), {
    allowedParentDir: path.dirname(app.getPath('userData'))
  });
  log.info(
    `[xwxdeck] quick repair cleared Chromium cache and ${result.removedCachePaths.length} app cache path(s), `
    + `${result.removedBytes} byte(s)`
  );
  // The model directory and price snapshot are rebuilt on demand. Refreshing
  // them here is what makes the action observable: otherwise the caches quietly
  // reappear and the UI keeps showing the same data.
  const refreshedModels = await controller?.refreshModelMetadata().catch(error => {
    log.warn(`[xwxdeck] model directory refresh after quick repair failed: ${errorMessage(error)}`);
    return undefined;
  });
  await refreshUi().catch(() => undefined);
  return {
    removedCachePaths: result.removedCachePaths.length,
    removedBytes: result.removedBytes,
    ...(refreshedModels === undefined ? {} : { refreshedModels })
  };
}

async function finishPackagedSmokeTest(result: unknown, exitCode: number): Promise<void> {
  const resultPath = process.env.XWX_DECK_SMOKE_RESULT;
  if (resultPath) {
    await fs.promises.mkdir(path.dirname(resultPath), { recursive: true });
    await fs.promises.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  quitState = 'ready';
  metadataSubscriber?.stop();
  try { await controller?.shutdown(); }
  catch { /* The result already captures the primary failure. */ }
  app.exit(exitCode);
}

async function runPackagedBackgroundGatewaySmoke(userDataDir: string): Promise<void> {
  const compatibleBaseUrl = process.env.XWX_DECK_BACKGROUND_GATEWAY_UPSTREAM?.trim();
  const compatibleBearerToken = process.env.XWX_DECK_BACKGROUND_GATEWAY_TOKEN?.trim();
  const compatibleModel = process.env.XWX_DECK_BACKGROUND_GATEWAY_MODEL?.trim() || 'xwx-packaged-helper-model';
  if (!compatibleBaseUrl || !compatibleBearerToken) {
    throw new Error('Packaged background Gateway smoke is missing its isolated upstream fixture.');
  }
  controller = new XwXDeckController(userDataDir, {
    backgroundGateway: true,
    proxyListenPorts: [0],
    disableBackgroundModelRefresh: true,
    chatGptRunning: async () => false,
    codexHistoryMutationAllowed: async () => true,
    resolveUpstreamProxyUrl
  });
  await controller.start();
  const codex = (await controller.saveProvider({
    displayName: 'Packaged API', baseUrl: compatibleBaseUrl, bearerToken: compatibleBearerToken,
    adapter: 'responses', codexModel: compatibleModel
  })).connections[0];
  const claude = (await controller.saveProvider({
    displayName: 'Packaged Claude', baseUrl: compatibleBaseUrl.replace(/\/v1$/, '/anthropic/v1'),
    bearerToken: compatibleBearerToken, adapter: 'anthropic-messages'
  })).connections[1];
  await controller.switchClientProvider('codex', codex.id);
  await controller.switchClientProvider('claude', claude.id);
  await controller.enable('packaged background Gateway fallback smoke');
  await controller.disable();
  const state = await controller.runtimeState();
  if (!state.backgroundGatewayActive || !state.localBaseUrl) {
    throw new Error('Packaged app did not activate its independent Gateway helper.');
  }
  if (state.tracingEnabled || state.readiness.recordingEnabled) throw new Error('Packaged Trace did not stop before detach.');
  if (!await controller.detachManager()) {
    throw new Error('Packaged manager could not detach from its active Gateway helper.');
  }
  const resultPath = process.env.XWX_DECK_SMOKE_RESULT;
  if (!resultPath) throw new Error('Packaged background Gateway smoke result path is missing.');
  await fs.promises.mkdir(path.dirname(resultPath), { recursive: true });
  await fs.promises.writeFile(resultPath, `${JSON.stringify({
    ok: true,
    localBaseUrl: state.localBaseUrl,
    backgroundGatewayActive: state.backgroundGatewayActive,
    tracingEnabled: state.tracingEnabled,
    recordingEnabled: state.readiness.recordingEnabled
  }, null, 2)}\n`, 'utf8');
  quitState = 'ready';
  app.quit();
}

function runDetached(label: string, action: () => Promise<unknown>): void {
  void action().catch(error => {
    log.warn(`[xwxdeck] ${label} failed: ${errorMessage(error)}`);
  });
}
