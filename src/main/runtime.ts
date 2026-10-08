import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { app, dialog, nativeImage, Notification, powerMonitor, session, shell } from 'electron';
import {
  applicationResetRelaunchArgs,
  applicationRelaunchExecutable,
  parseApplicationResetRequest,
  performApplicationRepair,
  type ApplicationResetRequest
} from './app/applicationReset';
import {
  forceCloseClientsForReset,
  isChatGptRunning,
  isClaudeDesktopRunning,
  isClaudeRunning,
  listClientsForReset,
  resetClientLabels,
  stopStalledExitRecovery
} from './app/chatGptLifecycle';
import {
  ClientId,
  XwXDeckController,
  XwXDeckRuntimeState,
  ShutdownDrainTimeoutError
} from './app/xwxDeckController';
import { buildTrayQuitPrompt, shouldConfirmTrayQuit } from './app/shutdownPrompt';
import {
  beginExitRecoveryReport,
  completeExitRecoveryAfterVerifiedStartup,
  readExitRecoveryNotice
} from './app/exitRecoveryReport';
import {
  claudeDesktopRestartNote,
  isTraceStopBusyError,
  lifecycleFailure,
  traceStoppedNotice,
  type LifecycleNotice
} from '../shared/lifecycleNotice';
import {
  isStartupHiddenLaunch,
  readStartupSettings,
  startupRegistrationMatches,
  setStartupEnabled as setLoginStartupEnabled,
  type StartupSettingsSnapshot
} from './app/startup';
import { registerIpcHandlers } from './ipc/registerHandlers';
import { assetPath } from './shared/assets';
import { errorMessage } from './shared/error';
import { normalizeErrorMessage } from '../shared/errors';
import { childProcessEnvironment } from './shared/processEnvironment';
import { initLogger, log } from './shared/logger';
import { runPackagedSmokeTest } from './smoke/packagedSmoke';
import { loadModelsDevPricingCache, refreshModelsDevPricingCache } from './trace/modelsDevPricing';
import { assertLoopbackSystemProxyReachable, selectSystemProxy } from './trace/systemProxy';
import { XwXDeckTray } from './tray';
import { XwXDeckUpdater } from './update/xwxDeckUpdater';
import { cleanupMacInstallerAfterLaunch, ejectMacInstallerAfterFinderCopy,
  runningMacInstallerMount } from './update/macInstallerCleanup';
import { MetadataInvalidationSubscriber } from './update/metadataInvalidationSubscriber';
import { NIGHTLY_IDLE_THRESHOLD_SECONDS, NightlyUpdateScheduler, type NightlyInstallOutcome } from './update/nightlyUpdate';
import { metadataPushUrl } from './update/updateServer';
import {
  acknowledgePortableUpdateReady,
  acknowledgePortableUpdateStarted,
  cleanupPortableUpdateFiles,
  readPortableUpdateLaunchResult,
  safePortableCleanupPaths,
  sweepStalePortableUpdateFiles
} from './update/portableUpdate';
import { ManagerWindow } from './window/managerWindow';

let controller: XwXDeckController | undefined;
let updater: XwXDeckUpdater | undefined;
let tray: XwXDeckTray | undefined;
let managerWindow: ManagerWindow | undefined;
let metadataSubscriber: MetadataInvalidationSubscriber | undefined;
let nightlyUpdates: NightlyUpdateScheduler | undefined;
let unattendedUpdateDownload = false;
let quitState: 'idle' | 'cleaning' | 'ready' = 'idle';
let fullShutdownRequested = false;
let tracingToggle: Promise<XwXDeckRuntimeState | undefined> | undefined;
let exitRecoveryGuardianStarted = false;
let exitRecoveryGuardianId: string | undefined;
let fullShutdownUiHidden = false;
let fullShutdownWatchdog: NodeJS.Timeout | undefined;
let emergencyExitRequested = false;
let startupRecoveryNotice: LifecycleNotice | undefined;
let startupSettingsCache: { value: StartupSettingsSnapshot; checkedAt: number } | undefined;
let macApplicationIcon = { applied: false, width: 0, height: 0, cornerAlpha: 0, centerAlpha: 0 };

const PACKAGED_SMOKE_TEST = process.env.XWX_DECK_SMOKE_TEST === '1';
const PACKAGED_BACKGROUND_GATEWAY_SMOKE = process.env.XWX_DECK_BACKGROUND_GATEWAY_SMOKE === '1';
const START_HIDDEN = isStartupHiddenLaunch();
const PORTABLE_UPDATE_RESULT = readPortableUpdateLaunchResult();
const FULL_SHUTDOWN_WATCHDOG_MS = 15_000;
const SHUTDOWN_INSPECTION_TIMEOUT_MS = 8_000;
const EXIT_GUARDIAN_START_TIMEOUT_MS = 3_000;

const PORTABLE_UPDATE_SMOKE = process.env.XWX_DECK_PORTABLE_UPDATE_SMOKE === '1';
const RESET_SMOKE = process.env.XWX_DECK_RESET_SMOKE === '1';
const PACKAGED_UPDATE_SMOKE = process.env.XWX_DECK_PACKAGED_UPDATE_SMOKE === '1'
  && Boolean(process.env.XWX_DECK_SMOKE_USER_DATA && process.env.XWX_DECK_CLIENT_HOME
    && process.env.XWX_DECK_PACKAGED_UPDATE_RESULT);
const STARTUP_SMOKE = PORTABLE_UPDATE_SMOKE || RESET_SMOKE || PACKAGED_UPDATE_SMOKE;
// Lifecycle acceptance observes the normal visible/hidden launch decision.
// The other startup fixtures deliberately suppress their windows.
const PORTABLE_LIFECYCLE_SMOKE = PORTABLE_UPDATE_SMOKE && process.env.XWX_DECK_PORTABLE_LIFECYCLE_SMOKE === '1';
startMainProcess();

async function finishRestartSmoke(): Promise<void> {
  const resultPath = process.env.XWX_DECK_PORTABLE_UPDATE_SMOKE_RESULT;
  if (!resultPath || PORTABLE_UPDATE_SMOKE && PORTABLE_UPDATE_RESULT?.kind !== 'complete') {
    throw new Error('Portable update smoke did not restart through a completed update.');
  }
  const win = managerWindow?.current();
  if (!controller || (!win && !START_HIDDEN)) throw new Error('Updated manager did not initialize.');
  if (win) await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const check = () => {
      if (document.querySelector('button')) return resolve(true);
      if (Date.now() >= deadline) return reject(new Error('Updated manager UI did not render.'));
      setTimeout(check, 50);
    };
    check();
  })`);
  const state = await controller.runtimeState({ fast: true });
  await handlePortableUpdateLaunchResult();
  await fs.promises.mkdir(path.dirname(resultPath), { recursive: true });
  await fs.promises.writeFile(resultPath, `${JSON.stringify({ ...PORTABLE_UPDATE_RESULT,
    pid: process.pid, actualVersion: app.getVersion(), windowReady: Boolean(win),
    windowVisible: win?.isVisible() ?? false, hiddenLaunch: START_HIDDEN,
    readiness: state.readiness, lastError: state.lastError,
    tracingEnabled: state.tracingEnabled
  }, null, 2)}\n`, 'utf8');
  await controller.forceExit();
  app.exit(0);
}

function startMainProcess(): void {
  let isolatedUserData = false;
  if (process.env.XWX_DECK_UPDATE_PREVIEW === '1' && process.env.XWX_DECK_PREVIEW_USER_DATA) {
    app.setPath('userData', path.resolve(process.env.XWX_DECK_PREVIEW_USER_DATA));
    isolatedUserData = true;
  }
  if ((PACKAGED_SMOKE_TEST || PACKAGED_BACKGROUND_GATEWAY_SMOKE || STARTUP_SMOKE) && process.env.XWX_DECK_SMOKE_USER_DATA) {
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
    // runtime.ts is loaded through a dynamic import. Electron may already be
    // ready by the time an updater-launched replacement loses this lock, so
    // app.whenReady() below would otherwise resolve before the process exits
    // and let the losing instance start a second Gateway helper. That races the
    // still-closing version for the shared control files, port and Trace writer
    // lease, and the helper then exits with code 1 until those processes are
    // cleared. A losing instance must not register or run any startup work.
    return;
  } else {
    app.on('second-instance', (_event, argv) => {
      if (isStartupHiddenLaunch(argv)) return;
      runDetached('open manager for second instance', openManager);
    });
  }

  // Older releases relaunch with a reset flag. Hand that request to a detached
  // Node worker too: Chromium must be fully stopped before its profile is wiped.
  if (resetRequest && gotLock) {
    void launchApplicationResetWorker(resetRequest, standaloneUserDataDir)
      .catch(error => recordStartupResetFailure(standaloneUserDataDir, errorMessage(error)))
      .finally(() => app.exit(0));
    return;
  }

  app.setName('XwX Deck');
  app.setPath('userData', standaloneUserDataDir);
  void acknowledgePortableUpdateStarted(PORTABLE_UPDATE_RESULT)
    .catch(error => log.warn(`[updater] failed to record portable candidate pid: ${errorMessage(error)}`));
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
      if (process.platform === 'darwin' && app.isPackaged && !PACKAGED_SMOKE_TEST && !STARTUP_SMOKE) {
        const mount = await runningMacInstallerMount().catch(error => {
          log.warn(`[mac-install] could not inspect running location: ${errorMessage(error)}`);
          return undefined;
        });
        if (mount) {
          ejectMacInstallerAfterFinderCopy(mount);
          log.info(`[mac-install] exiting installer copy on ${mount}`);
          // No controller or Gateway has started yet. A prompt here kept the
          // DMG busy and made Finder's Replace/Eject sequence fail.
          app.exit(0);
          return;
        }
      }
      const startupStartedAt = Date.now();
      let startupPhaseAt = startupStartedAt;
      const reportStartupPhase = (phase: string) => {
        const now = Date.now();
        log.info(`[xwx-deck] startup ${phase}: phase=${now - startupPhaseAt}ms total=${now - startupStartedAt}ms`);
        startupPhaseAt = now;
      };
      await waitForPriorExitRecovery(userDataDir);
      reportStartupPhase('previous-exit-recovery');
      startupRecoveryNotice = await readExitRecoveryNotice(userDataDir);
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
      reportStartupPhase('local-pricing-cache');
      log.info(`[pricing] loaded ${pricingRuleCount} exact models.dev rules`);
      if (!PACKAGED_SMOKE_TEST && !STARTUP_SMOKE) {
        runDetached('refresh models.dev pricing', async () => {
          const result = await refreshModelsDevPricingCache(pricingOptions);
          log.info(`[pricing] ${result.status}: ${result.ruleCount} exact rules`);
        });
      }
      controller = new XwXDeckController(userDataDir, {
        backgroundGateway: !PACKAGED_SMOKE_TEST,
        resolveUpstreamProxyUrl,
        ...(PACKAGED_SMOKE_TEST ? { codexHistoryMutationAllowed: async () => true } : {}),
        ...(STARTUP_SMOKE ? { disableBackgroundModelRefresh: true, proxyListenPorts: [0] } : {})
      });
      updater = new XwXDeckUpdater();
      managerWindow = new ManagerWindow({
        state: currentState,
        preloadPath: path.join(__dirname, 'preload.js'),
        iconPath: assetPath('icon.png'),
        hidden: PACKAGED_SMOKE_TEST || STARTUP_SMOKE && !PORTABLE_LIFECYCLE_SMOKE,
        onClosed: undefined,
        onRendererRecoveryExhausted: details => {
          log.error(`[xwxdeck] manager recovery exhausted: reason=${details.reason} code=${details.exitCode}`);
          if (!PACKAGED_SMOKE_TEST && Notification.isSupported()) {
            new Notification({
              title: 'XwX Deck 管理窗口需要重启',
              body: '管理窗口连续异常退出，后台连接状态尚未确认。请重新打开 XwX Deck；若对话仍连接失败，再完全退出并重新打开相应客户端。'
            }).show();
          }
        }
      });
      tray = new XwXDeckTray({
        openManager: () => runDetached('open manager from tray', openManager),
        toggleTracing: enabled => runDetached('toggle tracing from tray', () => toggleTracingFromTray(enabled)),
        showUpdateDetails: () => runDetached('show update details from tray', () => managerWindow?.showUpdateDetails() ?? Promise.resolve()),
        quit: requestFullShutdownFromTray,

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
        cancelUpdate,
        toggleTracing,
        toggleClient,
        openDashboard,
        clearHistory,
        setTraceStoragePolicy,
        repairApplication,
        repairUnreadableSettings: async () => {
          if (!controller) throw new Error('XwX Deck 仍在启动。');
          const result = await controller.repairUnreadableSettings();
          await refreshUi();
          return result;
        },
        repairInvalidCodexConfiguration: async () => {
          if (!controller) throw new Error('XwX Deck 仍在启动。');
          const result = await controller.repairInvalidCodexConfiguration();
          await refreshUi();
          return result;
        },
        repairClientProviderSwitch: async (client, providerId) => {
          if (!controller) throw new Error('XwX Deck 仍在启动。');
          const result = await controller.repairClientProviderSwitch(client, providerId);
          await refreshUi();
          return result;
        },
        resetApplication
      });
      controller.onDidChange(() => runDetached('refresh UI after controller change', refreshUi));
      updater.onDidChange(state => {
        runDetached('refresh UI after updater change', refreshUi);
        if (state.status === 'checking') nightlyUpdates?.recordCheck();
        // A nightly background download must not pop the manager window open.
        if (state.status === 'ready' && !unattendedUpdateDownload) {
          runDetached('show downloaded update', () => managerWindow?.showUpdateDetails() ?? Promise.resolve());
        }
      });
      await updater.start();
      reportStartupPhase('updater-initialization');
      await controller.start();
      reportStartupPhase('controller-and-client-recovery');
      const verifiedStartupState = await controller.runtimeState({ fast: true });
      if (!verifiedStartupState.lastError && verifiedStartupState.readiness.startupPhase !== 'degraded') {
        try {
          if (await completeExitRecoveryAfterVerifiedStartup(userDataDir)) {
            startupRecoveryNotice = undefined;
            log.info('[xwx-deck] cleared historical exit recovery warning after verified startup');
          }
        } catch (error) {
          log.warn(`[xwx-deck] could not clear historical exit recovery warning: ${errorMessage(error)}`);
        }
      }
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
      await refreshUi();
      reportStartupPhase('first-ui-state');
      if (!START_HIDDEN || PACKAGED_SMOKE_TEST) await openManager();
      reportStartupPhase('manager-window');
      if (!PACKAGED_SMOKE_TEST && !STARTUP_SMOKE) {
        runDetached('reconcile startup registration', reconcileStartupWithIntent);
        runDetached('restore legacy official history after startup', () => restoreLegacyOfficialHistoryIfChatGptStopped('startup'));
        runDetached('clean installed Mac DMG', () => cleanupMacInstallerAfterLaunch(userDataDir));
      }
      if (STARTUP_SMOKE) {
        if (PACKAGED_UPDATE_SMOKE && PORTABLE_UPDATE_RESULT?.kind !== 'complete') {
          await runPackagedUpdateAcceptance();
          return;
        }
        await finishRestartSmoke();
        return;
      }
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
      startNightlyUpdates(userDataDir);
    })
    .catch(err => {
      if (PACKAGED_SMOKE_TEST || PACKAGED_BACKGROUND_GATEWAY_SMOKE) {
        void finishPackagedSmokeTest({ ok: false, error: errorMessage(err) }, 1);
        return;
      }
      void handleStartupFailure(err);
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
    if (quitState === 'cleaning') {
      requestEmergencyExit('repeated quit request');
      return;
    }
    // Closing the manager window does not quit this tray application. Therefore
    // every before-quit event represents an explicit application exit (Dock,
    // Cmd+Q, application menu, tray, updater, or system logout) and must fully
    // detach clients from the local Gateway before the helper is terminated.
    // Previously only the tray's own Quit item set this flag, so Cmd+Q and the
    // macOS application menu silently detached the manager while leaving Codex
    // pointed at localhost.
    fullShutdownRequested = true;
    quitState = 'cleaning';
    void (async () => {
      try {
        const confirmContext: ShutdownConfirmContext = 'tray-quit';
        const shutdown = await prepareSafeShutdown(confirmContext);
        hideFullShutdownUi();
        armFullShutdownWatchdog();
        await withOperationTimeout(
          startExitRecoveryGuardian(),
          EXIT_GUARDIAN_START_TIMEOUT_MS,
          '退出恢复守护进程启动超时。'
        );
        await controller?.beginShutdown();
        await shutdownControllerWithConfirmation(
          shutdown.forceShutdown,
          shutdown.chatGptMayBeRunning,
          confirmContext
        );
        log.info('[xwx-deck] explicit application exit restored direct client configuration and stopped the Gateway');
        await notifyClaudeDesktopRestartAfterExit();
        clearFullShutdownWatchdog();
        quitState = 'ready';
        app.exit(0);
      } catch (err) {
        if (fullShutdownRequested && !(err instanceof ShutdownCancelledError)) {
          log.warn(`[xwx-deck] graceful exit failed; forcing final exit: ${errorMessage(err)}`);
          requestEmergencyExit(`graceful exit failed: ${errorMessage(err)}`);
          return;
        }
        clearFullShutdownWatchdog();
        await cancelExitRecoveryGuardian();
        await controller?.cancelShutdown().catch(() => undefined);
        quitState = 'idle';
        fullShutdownRequested = false;
        if (err instanceof ShutdownCancelledError) {
          log.info('[xwx-deck] shutdown cancelled by user');
          await restoreFullShutdownUi();
          await refreshUi().catch(() => undefined);
          return;
        }
        await restoreFullShutdownUi();
        const message = errorMessage(err);
        log.warn(`[xwx-deck] shutdown cancelled: ${message}`);
        await managerWindow?.showNotice(lifecycleFailure(err, '退出 XwX Deck'));
        await refreshUi().catch(() => undefined);
      }
    })();
  });
}

async function handleStartupFailure(error: unknown): Promise<void> {
  const notice = lifecycleFailure(error, '启动 XwX Deck');
  const message = notice.description ?? '请查看运行日志后重试。';
  log.error('[xwx-deck] failed to start', error);
  metadataSubscriber?.stop();
  hideFullShutdownUi();

  let cleanupError: unknown;
  if (controller) {
    try {
      await withStartupCleanupTimeout(controller.forceExit(), 10_000);
    } catch (failure) {
      cleanupError = failure;
      log.error(`[xwx-deck] startup failure cleanup did not complete: ${errorMessage(failure)}`);
    }
  }

  try {
    if (PORTABLE_UPDATE_RESULT?.kind !== 'complete') dialog.showErrorBox(
      notice.message,
      cleanupError
        ? `${message}\n\n程序将退出；后台恢复进程会继续清理本地 Gateway。`
        : `${message}\n\n程序已结束本次启动，请重新打开 XwX Deck。`
    );
  } catch {
    // Logging above is the last fallback when Electron cannot create a dialog.
  }

  if (cleanupError) {
    await startExitRecoveryGuardian().catch(guardianError => {
      log.error(`[xwx-deck] startup recovery guardian failed to start: ${errorMessage(guardianError)}`);
    });
    await triggerExitRecoveryNow().catch(guardianError => {
      log.error(`[xwx-deck] startup recovery guardian trigger failed: ${errorMessage(guardianError)}`);
    });
  }
  quitState = 'ready';
  app.exit(1);
}

async function withStartupCleanupTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return withOperationTimeout(operation, timeoutMs, '启动失败后的 Gateway 清理超时。');
}

async function withOperationTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  readonly activity: {
    readonly activeRequests: number;
    readonly activeUserResponses: number;
    readonly pendingContinuations: number;
  };
  readonly modelDependencies: ReturnType<XwXDeckController['shutdownModelDependencies']>;
  readonly inspectionFailed?: boolean;
}

async function inspectSafeShutdown(): Promise<SafeShutdownPreparation> {
  if (!controller) {
    return {
      forceShutdown: false,
      chatGptMayBeRunning: false,
      claudeMayBeRunning: false,
      activity: { activeRequests: 0, activeUserResponses: 0, pendingContinuations: 0 },
      modelDependencies: []
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
  // Auxiliary requests (model lists, token counts) are not conversations.
  const hasActiveConversation = activity.activeUserResponses > 0 || activity.pendingContinuations > 0;
  return {
    // Claude Desktop being open is not a reason to ask: its profile switches
    // to the service's remote endpoint (or its own previous configuration)
    // before the Gateway stops, and it is told to restart afterwards.
    forceShutdown: chatGptMayBeRunning || hasActiveConversation,
    chatGptMayBeRunning,
    claudeMayBeRunning,
    activity,
    modelDependencies: controller.shutdownModelDependencies()
  };
}

type ShutdownConfirmContext = 'default' | 'tray-quit';

async function prepareSafeShutdown(
  confirmContext: ShutdownConfirmContext = 'default'
): Promise<SafeShutdownPreparation> {
  if (confirmContext === 'tray-quit') {
    // The activity snapshot is maintained by the helper. Do not delay the
    // user's exit behind process enumeration or history repair.
    const activity = controller?.shutdownActivitySnapshot()
      ?? { activeRequests: 0, activeUserResponses: 0, pendingContinuations: 0 };
    const shutdown: SafeShutdownPreparation = {
      forceShutdown: activity.activeUserResponses > 0 || activity.pendingContinuations > 0,
      chatGptMayBeRunning: true, // Skip optional history repair on exit.
      claudeMayBeRunning: false,
      activity,
      modelDependencies: controller?.shutdownModelDependencies() ?? []
    };
    const riskyExit = shouldConfirmTrayQuit({
      activeUserResponses: shutdown.activity.activeUserResponses,
      pendingContinuations: shutdown.activity.pendingContinuations,
      modelDependencies: shutdown.modelDependencies
    });
    if (riskyExit) {
      const confirmed = await showTrayQuitConfirm(shutdown);
      if (!confirmed) throw new ShutdownCancelledError();
    }
    // Merely having ChatGPT or Claude open is not destructive. The regular
    // drain gate restores and verifies their direct configuration before the
    // helper stops. Force only after the user accepted a concrete risk.
    return { ...shutdown, forceShutdown: riskyExit };
  }
  const shutdown = await inspectSafeShutdownWithinLimit();
  if (shutdown.forceShutdown) {
    const confirmed = shutdown.inspectionFailed
      ? await showTrayQuitConfirm(shutdown)
      : await showImmediateShutdownConfirm(shutdown.activity);
    if (!confirmed) throw new ShutdownCancelledError();
  }
  return shutdown;
}

async function inspectSafeShutdownWithinLimit(): Promise<SafeShutdownPreparation> {
  try { return await withOperationTimeout(
    inspectSafeShutdown(),
    SHUTDOWN_INSPECTION_TIMEOUT_MS,
    '安全退出检查超时。'
  ); } catch (error) {
    log.warn(`[xwx-deck] shutdown inspection failed; offering forced continuation: ${errorMessage(error)}`);
    return { forceShutdown: true, chatGptMayBeRunning: true, claudeMayBeRunning: true,
      activity: controller?.shutdownActivitySnapshot() ?? { activeRequests: 0, activeUserResponses: 0, pendingContinuations: 0 },
      modelDependencies: controller?.shutdownModelDependencies() ?? [], inspectionFailed: true };
  }
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
      const lateRisk: SafeShutdownPreparation = {
        forceShutdown: true,
        chatGptMayBeRunning: skipCodexHistoryRepair,
        claudeMayBeRunning: controller.requiresClaudeClientExitBeforeShutdown(),
        activity,
        modelDependencies: controller.shutdownModelDependencies()
      };
      if (shouldConfirmTrayQuit({
        activeUserResponses: activity.activeUserResponses,
        pendingContinuations: activity.pendingContinuations,
        modelDependencies: lateRisk.modelDependencies
      })) {
        const confirmed = await showTrayQuitConfirm(lateRisk);
        if (!confirmed) throw new ShutdownCancelledError();
      }
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

function armFullShutdownWatchdog(): NodeJS.Timeout {
  if (fullShutdownWatchdog) return fullShutdownWatchdog;
  fullShutdownWatchdog = setTimeout(() => {
    log.error(
      `[xwx-deck] full-shutdown watchdog expired after ${FULL_SHUTDOWN_WATCHDOG_MS}ms; `
      + 'terminating the manager while the detached recovery guardian finishes client restore and process cleanup'
    );
    quitState = 'ready';
    app.exit(1);
  }, FULL_SHUTDOWN_WATCHDOG_MS);
  fullShutdownWatchdog.unref?.();
  return fullShutdownWatchdog;
}

function clearFullShutdownWatchdog(): void {
  if (fullShutdownWatchdog) clearTimeout(fullShutdownWatchdog);
  fullShutdownWatchdog = undefined;
}

function requestEmergencyExit(reason: string): void {
  if (emergencyExitRequested || quitState === 'ready') return;
  emergencyExitRequested = true;
  fullShutdownRequested = true;
  quitState = 'cleaning';
  hideFullShutdownUi();
  armFullShutdownWatchdog();
  log.warn(`[xwx-deck] emergency exit requested: ${reason}`);
  void (async () => {
    await withOperationTimeout(
      startExitRecoveryGuardian(),
      EXIT_GUARDIAN_START_TIMEOUT_MS,
      '退出恢复守护进程启动超时。'
    ).catch(error => {
      log.error(`[xwx-deck] exit recovery guardian failed to start: ${errorMessage(error)}`);
    });
    await triggerExitRecoveryNow().catch(error => {
      log.error(`[xwx-deck] exit recovery guardian trigger failed: ${errorMessage(error)}`);
    });
    await withOperationTimeout(
      controller?.forceExit() ?? Promise.resolve({ helperStopped: true, dependentClients: [] }),
      4_000,
      '进程内强制退出超时。'
    ).catch(error => {
      log.error(`[xwx-deck] forced helper stop failed: ${errorMessage(error)}`);
    });
    clearFullShutdownWatchdog();
    quitState = 'ready';
    app.exit(0);
  })();
}

function hideFullShutdownUi(): void {
  if (fullShutdownUiHidden) return;
  fullShutdownUiHidden = true;
  managerWindow?.current()?.hide();
  tray?.dispose();
  if (process.platform === 'darwin' && app.dock) {
    void app.dock.hide();
  }
  log.info('[xwx-deck] full-shutdown UI hidden; detached recovery continues in background');
}

async function restoreFullShutdownUi(): Promise<void> {
  if (!fullShutdownUiHidden) return;
  fullShutdownUiHidden = false;
  if (process.platform === 'darwin' && app.dock) await app.dock.show();
  await refreshUi().catch(() => undefined);
  await openManager().catch(() => undefined);
}

async function startExitRecoveryGuardian(): Promise<void> {
  if (exitRecoveryGuardianStarted) return;
  const userDataDir = app.getPath('userData');
  await beginExitRecoveryReport(userDataDir, process.pid).catch(error => {
    log.warn(`[xwx-deck] could not record exit recovery intent: ${errorMessage(error)}`);
  });
  const controlDir = path.join(userDataDir, 'gateway');
  const readyFile = path.join(controlDir, 'exit-recovery.ready');
  await fs.promises.mkdir(controlDir, { recursive: true });
  await Promise.all([
    fs.promises.rm(path.join(controlDir, 'exit-recovery-now'), { force: true }).catch(() => undefined),
    fs.promises.rm(path.join(controlDir, 'exit-recovery-cancel'), { force: true }).catch(() => undefined),
    fs.promises.rm(readyFile, { force: true }).catch(() => undefined)
  ]);
  const recoveryPath = path.join(__dirname, 'exit-recovery.js');
  const recoveryId = randomUUID();
  const child = spawn(process.execPath, [recoveryPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...childProcessEnvironment(),
      ELECTRON_RUN_AS_NODE: '1',
      XWX_EXIT_RECOVERY: '1',
      XWX_EXIT_RECOVERY_USER_DATA: userDataDir,
      XWX_EXIT_RECOVERY_MANAGER_PID: String(process.pid),
      XWX_EXIT_RECOVERY_DELAY_MS: '6000',
      XWX_EXIT_RECOVERY_ID: recoveryId
    }
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  const readyDeadline = Date.now() + 1_500;
  while (Date.now() < readyDeadline) {
    const ready = await readExitRecoveryReadyMarker(readyFile);
    if (ready?.recoveryId === recoveryId) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const ready = await readExitRecoveryReadyMarker(readyFile);
  if (ready?.recoveryId !== recoveryId) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    throw new Error('退出恢复守护进程未能在时限内保存恢复快照。');
  }
  exitRecoveryGuardianId = recoveryId;
  exitRecoveryGuardianStarted = true;
  log.info(`[xwx-deck] exit recovery guardian armed pid=${child.pid ?? 'unknown'}`);
}

interface ExitRecoveryReadyMarker {
  readonly recoveryId?: string;
  readonly pid?: number;
}

async function waitForPriorExitRecovery(userDataDir: string): Promise<void> {
  const readyFile = path.join(userDataDir, 'gateway', 'exit-recovery.ready');
  const first = await fs.promises.readFile(readyFile).catch(() => undefined);
  if (!first) return;
  log.info('[xwx-deck] waiting for the previous version exit recovery before starting Gateway');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const contents = await fs.promises.readFile(readyFile).catch(() => undefined);
    if (!contents) return;
    const marker = parseExitRecoveryReadyMarker(contents.toString('utf8'));
    if (!marker?.pid || !processIsAlive(marker.pid)) {
      const current = await fs.promises.readFile(readyFile).catch(() => undefined);
      if (current?.equals(contents)) await fs.promises.rm(readyFile, { force: true }).catch(() => undefined);
      continue;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const stale = await fs.promises.readFile(readyFile).catch(() => undefined);
  if (!stale) return;
  const marker = parseExitRecoveryReadyMarker(stale.toString('utf8'));
  if (marker?.pid) {
    const stoppedOwnWorker = await stopStalledExitRecovery(marker.pid);
    const stopDeadline = Date.now() + 2_000;
    while (stoppedOwnWorker && processIsAlive(marker.pid) && Date.now() < stopDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (stoppedOwnWorker && processIsAlive(marker.pid)) throw new Error(`系统未允许关闭旧恢复进程 ${marker.pid}，请重试启动。`);
  }
  const current = await fs.promises.readFile(readyFile).catch(() => undefined);
  if (current?.equals(stale)) await fs.promises.rm(readyFile, { force: true });
  log.warn('[xwx-deck] cleared stalled prior exit recovery; continuing startup and client recovery');
}

async function readExitRecoveryReadyMarker(file: string): Promise<ExitRecoveryReadyMarker | undefined> {
  const contents = await fs.promises.readFile(file, 'utf8').catch(() => undefined);
  return contents === undefined ? undefined : parseExitRecoveryReadyMarker(contents);
}

function parseExitRecoveryReadyMarker(contents: string): ExitRecoveryReadyMarker | undefined {
  const trimmed = contents.trim();
  if (/^\d+$/.test(trimmed)) {
    const pid = Number(trimmed);
    return Number.isSafeInteger(pid) && pid > 0 ? { pid } : undefined;
  }
  try {
    const value = JSON.parse(trimmed) as { recoveryId?: unknown; pid?: unknown };
    return {
      recoveryId: typeof value.recoveryId === 'string' ? value.recoveryId : undefined,
      pid: Number.isSafeInteger(value.pid) && Number(value.pid) > 0 ? Number(value.pid) : undefined
    };
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function triggerExitRecoveryNow(): Promise<void> {
  if (!exitRecoveryGuardianId) throw new Error('退出恢复守护进程尚未就绪。');
  const marker = path.join(app.getPath('userData'), 'gateway', 'exit-recovery-now');
  await fs.promises.mkdir(path.dirname(marker), { recursive: true });
  await fs.promises.writeFile(marker, `${exitRecoveryGuardianId}\n`, 'utf8');
}

async function cancelExitRecoveryGuardian(): Promise<void> {
  if (!exitRecoveryGuardianId) return;
  const recoveryId = exitRecoveryGuardianId;
  const controlDir = path.join(app.getPath('userData'), 'gateway');
  const marker = path.join(controlDir, 'exit-recovery-cancel');
  const readyFile = path.join(controlDir, 'exit-recovery.ready');
  await fs.promises.mkdir(path.dirname(marker), { recursive: true });
  await fs.promises.writeFile(marker, `${recoveryId}\n`, 'utf8').catch(() => undefined);
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const ready = await readExitRecoveryReadyMarker(readyFile);
    if (ready?.recoveryId !== recoveryId) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const remaining = await readExitRecoveryReadyMarker(readyFile);
  if (remaining?.recoveryId === recoveryId && remaining.pid) {
    const stoppedOwnWorker = await stopStalledExitRecovery(remaining.pid);
    const stoppedAt = Date.now() + 2_000;
    while (stoppedOwnWorker && processIsAlive(remaining.pid) && Date.now() < stoppedAt) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (stoppedOwnWorker && processIsAlive(remaining.pid)) throw new Error('旧恢复进程尚未退出，请重试操作。');
    const current = await readExitRecoveryReadyMarker(readyFile);
    if (current?.recoveryId === recoveryId) await fs.promises.rm(readyFile, { force: true });
  }
  exitRecoveryGuardianId = undefined;
  exitRecoveryGuardianStarted = false;
}

async function showTrayQuitConfirm(shutdown: SafeShutdownPreparation): Promise<boolean> {
  const options = buildTrayQuitPrompt({
    activeUserResponses: shutdown.activity.activeUserResponses,
    pendingContinuations: shutdown.activity.pendingContinuations,
    modelDependencies: shutdown.modelDependencies,
    inspectionFailed: shutdown.inspectionFailed
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

/**
 * A running Claude Desktop keeps the Gateway address it read at launch. When
 * exit moved it off the local Gateway, say so instead of implying the new
 * connection is already in use.
 */
async function notifyClaudeDesktopRestartAfterExit(): Promise<void> {
  if (PACKAGED_SMOKE_TEST || controller?.claudeDesktopRestartHint() !== 'direct') return;
  try {
    if (!await isClaudeDesktopRunning()) return;
    if (!Notification.isSupported()) return;
    new Notification({
      title: 'Claude Desktop 需要重启',
      body: `XwX Deck 已退出。${claudeDesktopRestartNote('direct')}`
    }).show();
  } catch (error) {
    log.warn(`[xwx-deck] Claude Desktop restart notification failed: ${errorMessage(error)}`);
  }
}

async function showImmediateShutdownConfirm(
  activity: { activeUserResponses: number; pendingContinuations: number }
): Promise<boolean> {
  const state: string[] = [];
  if (activity.activeUserResponses > 0) state.push(`${activity.activeUserResponses} 个回复正在生成。`);
  if (activity.pendingContinuations > 0) state.push(`${activity.pendingContinuations} 个会话正在等待工具调用继续。`);
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
  if (image.isEmpty()) throw new Error('无法加载 macOS 应用图标。');
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
  const desiredEnabled = await controller.readStartupIntent().catch(() => undefined);
  const startup = cachedStartupSettings();
  return {
    ...(await controller.runtimeState({ fast: true })),
    lifecycleNotice: startupRecoveryNotice,
    startup: { ...startup, desiredEnabled,
      warning: desiredEnabled === undefined ? '暂时无法读取开机启动偏好，原设置已保留；可稍后重试。'
        : startupRegistrationMatches(startup, desiredEnabled) ? undefined
        : startup.warning ?? (startup.supported ? '选择已保存，系统登录项尚未同步；可点击重试。' : undefined) },
    update: updateState()
  };
}

function cachedStartupSettings(): StartupSettingsSnapshot {
  if (startupSettingsCache && Date.now() - startupSettingsCache.checkedAt < 3_000) {
    return startupSettingsCache.value;
  }
  const value = readStartupSettings();
  startupSettingsCache = { value, checkedAt: Date.now() };
  return value;
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

let uiRefreshInFlight: Promise<XwXDeckRuntimeState | undefined> | undefined;
let uiRefreshAgain = false;

function refreshUi(): Promise<XwXDeckRuntimeState | undefined> {
  if (!controller) return Promise.resolve(undefined);
  if (uiRefreshInFlight) {
    uiRefreshAgain = true;
    return uiRefreshInFlight;
  }
  uiRefreshInFlight = (async () => {
    let state: XwXDeckRuntimeState;
    for (let attempt = 0; attempt < 2; attempt++) {
      uiRefreshAgain = false;
      state = await currentState();
      tray?.refresh(state);
      managerWindow?.sendState(state);
      if (!uiRefreshAgain) break;
    }
    return state!;
  })().finally(() => {
    uiRefreshInFlight = undefined;
    if (uiRefreshAgain) runDetached('refresh UI after concurrent change', refreshUi);
  });
  return uiRefreshInFlight;
}

async function setStartupEnabled(enabled: boolean): Promise<XwXDeckRuntimeState | undefined> {
  if (!controller) return undefined;
  await controller.setStartupIntent(enabled);
  try {
    const actual = await setLoginStartupEnabled(enabled);
    startupSettingsCache = { value: actual, checkedAt: Date.now() };
  } catch (error) {
    startupSettingsCache = { value: { ...readStartupSettings(), warning: errorMessage(error) }, checkedAt: Date.now() };
    log.warn(`[xwx-deck] startup selection retained for retry: ${errorMessage(error)}`);
  }
  return currentState();
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
    startupSettingsCache = undefined;
  } catch (error) {
    const actual = readStartupSettings();
    startupSettingsCache = { value: { ...actual, warning: errorMessage(error) }, checkedAt: Date.now() };
    log.warn(`[xwx-deck] startup reconcile pending; user selection retained: ${errorMessage(error)}`);
  }
}

function startNightlyUpdates(userDataDir: string): void {
  if (!updater?.state().supported) return;
  nightlyUpdates = new NightlyUpdateScheduler({
    seed: `${os.hostname()}\u0000${userDataDir}`,
    updater: () => updater!.state(),
    declinedVersion: () => updater?.declinedVersion(),
    check: async () => {
      await updater?.checkForUpdates(true, true);
    },
    download: async () => {
      if (!updater) return;
      unattendedUpdateDownload = true;
      try {
        await updater.downloadUpdate(true);
      } finally {
        unattendedUpdateDownload = false;
      }
    },
    install: installUpdateUnattended,
    systemIdleSeconds: () => powerMonitor.getSystemIdleTime(),
    busy: () => quitState !== 'idle' || fullShutdownRequested || tracingToggle !== undefined,
    logger: log
  });
  nightlyUpdates.start();
  // A machine woken inside the nightly window should not wait for the next tick.
  powerMonitor.on('resume', () => runDetached('nightly update after resume', () => nightlyUpdates?.tick() ?? Promise.resolve()));
}

/**
 * Nightly install: only when the regular safe-exit inspection needs no
 * confirmation. Active conversations, a ChatGPT that must exit first, or a
 * failed inspection defer instead of prompting an absent user.
 */
async function installUpdateUnattended(): Promise<NightlyInstallOutcome> {
  if (!updater || !controller) return { kind: 'deferred', reason: 'application still starting' };
  if (quitState !== 'idle' || fullShutdownRequested) return { kind: 'deferred', reason: 'application is exiting' };
  const shutdown = await inspectSafeShutdownWithinLimit();
  if (shutdown.forceShutdown) {
    const reason = shutdown.inspectionFailed
      ? 'safe-exit inspection failed'
      : shutdown.activity.activeUserResponses > 0 || shutdown.activity.pendingContinuations > 0
        ? 'conversation in progress'
        : 'ChatGPT must exit before the Gateway stops';
    return { kind: 'deferred', reason };
  }
  const win = managerWindow?.current();
  const windowVisible = Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());
  const result = await installUpdate({ unattended: true, launchHidden: !windowVisible, inspected: shutdown });
  if (result.status !== 'installing') return { kind: 'deferred', reason: 'activity changed during preflight' };
  return { kind: 'started' };
}

async function restartAndInstall() {
  return installUpdate();
}

/** Real packaged acceptance: uses the renderer IPC and the production install handler. */
async function runPackagedUpdateAcceptance(): Promise<void> {
  const win = managerWindow?.current();
  const resultPath = process.env.XWX_DECK_PACKAGED_UPDATE_RESULT!;
  try {
    if (!win || !updater) throw new Error('Update acceptance manager is unavailable.');
    const result = await win.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 15000;
      while (!document.querySelector('button') || !window.xwxDeck) {
        if (Date.now() > deadline) throw new Error('Update acceptance UI did not render.');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const checked = await window.xwxDeck.checkForUpdates();
      if (checked.status !== 'available') throw new Error('Check failed: ' + JSON.stringify(checked));
      const downloaded = await window.xwxDeck.downloadUpdate();
      if (downloaded.status !== 'ready') throw new Error('Download failed: ' + JSON.stringify(downloaded));
      return { checked, downloaded, windowRendered: true };
    })()`);
    await updater.preflightInstall();
    await fs.promises.mkdir(path.dirname(resultPath), { recursive: true });
    await fs.promises.writeFile(`${resultPath}.png`, (await win.webContents.capturePage()).toPNG());
    await fs.promises.writeFile(resultPath, JSON.stringify({ ...result,
      actualVersion: app.getVersion(), pid: process.pid, preflightPassed: true
    }, null, 2));
    await restartAndInstall();
  } catch (error) {
    await fs.promises.mkdir(path.dirname(resultPath), { recursive: true });
    await fs.promises.writeFile(resultPath, JSON.stringify({ error: errorMessage(error) }));
    await controller?.forceExit();
    app.exit(1);
  }
}

async function installUpdate(options: {
  readonly unattended?: boolean;
  readonly launchHidden?: boolean;
  readonly inspected?: SafeShutdownPreparation;
} = {}) {
  if (!updater) throw new Error('XwX Deck updater is still starting.');
  if (quitState === 'cleaning') throw new Error('XwX Deck 正在退出，请稍候。');
  if (updater.state().status === 'ready') {
    try {
      await updater.preflightInstall();
    } catch (error) {
      // Nothing has been stopped yet. A nightly attempt keeps the download ready.
      if (!options.unattended) {
        updater.failInstallation(error);
        await refreshUi();
      }
      throw error;
    }
  }
  if (options.unattended) {
    const latest = await inspectSafeShutdownWithinLimit();
    if (latest.forceShutdown || powerMonitor.getSystemIdleTime() < NIGHTLY_IDLE_THRESHOLD_SECONDS
        || tracingToggle || quitState !== 'idle') return updater.state();
  }
  updater.markInstalling();
  await refreshUi();
  if (updater.state().installMode === 'manual-dmg') {
    try {
      await updater.quitAndInstall();
      await refreshUi();
      // Finder cannot replace the live process. The user already confirmed
      // opening this installer; close the old app through its normal guarded
      // shutdown before the drag-and-drop replacement.
      setTimeout(() => app.quit(), 300).unref?.();
    } catch (error) {
      updater.failInstallation(error);
      await refreshUi();
      throw error;
    }
    return updater.state();
  }
  try {
    fullShutdownRequested = true;
    quitState = 'cleaning';
    const portable = updater.state().portable;
    if (!options.inspected) await prepareSafeShutdown();
    armFullShutdownWatchdog();
    await withOperationTimeout(
      startExitRecoveryGuardian(),
      EXIT_GUARDIAN_START_TIMEOUT_MS,
      '退出恢复守护进程启动超时。'
    );
    await controller?.beginShutdown();
    await withOperationTimeout(
      controller?.forceExit() ?? Promise.resolve({ helperStopped: true, dependentClients: [] }),
      8_000,
      '更新前停止 Gateway 超时。'
    );
    hideFullShutdownUi();
    quitState = 'ready';
    await updater.quitAndInstall({ unattended: options.unattended, launchHidden: options.launchHidden });
    if (portable) app.quit();
  } catch (error) {
    clearFullShutdownWatchdog();
    await cancelExitRecoveryGuardian();
    await controller?.cancelShutdown().catch(() => undefined);
    quitState = 'idle';
    fullShutdownRequested = false;
    await restoreFullShutdownUi();
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

async function cancelUpdate() {
  if (!updater) throw new Error('XwX Deck updater is still starting.');
  nightlyUpdates?.decline(updater.state().targetVersion);
  const state = await updater.discardDownloadedUpdate();
  await refreshUi().catch(() => undefined);
  return state;
}

async function handlePortableUpdateLaunchResult(): Promise<void> {
  if (!PORTABLE_UPDATE_RESULT && !PACKAGED_SMOKE_TEST && app.isPackaged) {
    runDetached('sweep stale portable update files', async () => {
      const removed = await sweepStalePortableUpdateFiles(process.env.PORTABLE_EXECUTABLE_FILE);
      if (removed.length) log.info(`[updater] removed stale update files: ${removed.join(', ')}`);
    });
  }
  if (!PORTABLE_UPDATE_RESULT || PACKAGED_SMOKE_TEST) return;
  if (PORTABLE_UPDATE_RESULT.kind === 'failed') {
    dialog.showErrorBox('XwX Deck 更新未完成', `原路径程序已重新打开。\n\n${PORTABLE_UPDATE_RESULT.message}`);
    return;
  }
  await acknowledgePortableUpdateReady(PORTABLE_UPDATE_RESULT);
  if (PORTABLE_UPDATE_SMOKE) return;
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

async function toggleTracing(enabled?: boolean, force = false): Promise<XwXDeckRuntimeState | undefined> {
  if (force) return toggleTracingOnce(enabled, true);
  if (tracingToggle) await tracingToggle.catch(() => undefined);
  tracingToggle = toggleTracingOnce(enabled, force);
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

async function toggleTracingOnce(enabled?: boolean, force = false): Promise<XwXDeckRuntimeState | undefined> {
  if (!controller) return undefined;
  try {
    await controller.toggle(enabled, force);
  } catch (err) {
    log.warn(`[xwxdeck] toggle failed: ${errorMessage(err)}`);
    await refreshUi();
    throw err;
  }
  return refreshUi();
}

/** Tray actions never create hidden native dialogs. Unsafe stops are deferred
 * and explained in the manager's bottom-right notice surface. */
async function toggleTracingFromTray(enabled: boolean): Promise<void> {
  try {
    let next: XwXDeckRuntimeState | undefined;
    try {
      next = await toggleTracing(enabled);
    } catch (err) {
      if (enabled || !isTraceStopBusyError(err)) throw err;
      // The user asked to stop. Give the same single wait/force choice as the
      // Trace page instead of refusing from the tray.
      if (!await confirmTrayTraceForceStop(err)) return;
      next = await toggleTracing(false, true);
    }
    if (next) {
      await managerWindow?.showNotice(next.lastError
        ? lifecycleFailure(next.lastError, '更新 Trace 配置')
        : next.tracingEnabled
          ? next.claudeDesktopRestart === 'local'
            ? { message: 'Trace 已开启', description: claudeDesktopRestartNote('local'), type: 'info' }
            : { message: 'Trace 已开启', description: '先发送一条新消息；若仍无记录，客户端可能未读取新连接，请完全退出并重新打开相应客户端。', type: 'success' }
          : traceStoppedNotice(next.backgroundGatewayAction === 'close', next.claudeDesktopRestart, next.connectionNotice));
    }
  } catch (err) {
    log.warn(`[xwx-deck] tray Trace toggle failed: ${errorMessage(err)}`);
    await managerWindow?.showNotice(lifecycleFailure(err, '切换 Trace'));
  }
}

async function confirmTrayTraceForceStop(error: unknown): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['继续等待', '强制停止'],
    defaultId: 0,
    cancelId: 0,
    title: '关闭 Trace',
    message: '关闭 Trace？',
    detail: `${normalizeErrorMessage(error)}现在关闭会中断它们；继续等待则保持 Trace 开启。`
  };
  const owner = managerWindow?.current();
  const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  return result.response === 1;
}

async function showManagerNotice(message: string, type: 'success' | 'error' | 'info', details: Pick<LifecycleNotice, 'description' | 'action'> = {}): Promise<void> {
  await managerWindow?.showNotice({ message, type, ...details });
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

async function setTraceStoragePolicy(
  input: { limitGB?: number; autoCleanup?: boolean }
): Promise<XwXDeckRuntimeState | undefined> {
  if (!controller) return undefined;
  await controller.setTraceStoragePolicy(input);
  return refreshUi();
}

async function launchApplicationResetWorker(
  request: ApplicationResetRequest,
  userDataDir: string,
  waitForRecovery = false
): Promise<void> {
  const job = {
    managerPid: process.pid,
    userDataDir,
    executable: applicationRelaunchExecutable(),
    relaunchArgs: applicationResetRelaunchArgs(process.argv),
    waitForRecovery,
    request
  };
  const child = spawn(process.execPath, [path.join(__dirname, 'application-reset-worker.js')], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
    env: { ...childProcessEnvironment(), ELECTRON_RUN_AS_NODE: '1', XWX_APPLICATION_RESET_JOB: JSON.stringify(job) }
  });
  await withOperationTimeout(new Promise<void>((resolve, reject) => {
    child.once('message', message => {
      if ((message as { type?: string })?.type === 'ready') resolve();
      else reject(new Error('重置进程返回了无效的就绪状态。'));
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`重置进程启动失败（${code}）。`)));
  }), 5_000, '重置进程启动超时。').catch(error => {
    child.kill();
    throw error;
  });
  child.unref();
}

async function resetApplication(request: ApplicationResetRequest): Promise<void> {
  if (!controller) throw new Error('XwX Deck 仍在启动。');
  if (quitState === 'cleaning') throw new Error('XwX Deck 正在退出，请稍候。');
  if (request.resetClientConfigs) {
    let running: Awaited<ReturnType<typeof listClientsForReset>>;
    try {
      running = await listClientsForReset();
    } catch (error) {
      log.warn(`[xwx-deck] could not verify client processes before reset: ${errorMessage(error)}`);
      throw new Error(`系统进程查询失败，尚未开始重置；再次点击重置可重新检测：${errorMessage(error)}`);
    }
    if (running.length) {
      const options = {
        type: 'warning' as const,
        title: '关闭客户端并重置？',
        message: '检测到客户端仍在运行',
        detail: `${resetClientLabels(running).join('\n')}\n\n确认后 XwX Deck 将强制关闭这些进程，未保存的工作会丢失。客户端完全退出后才会继续重置。`,
        buttons: ['取消', '强制关闭并继续重置'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      };
      const owner = managerWindow?.current();
      const answer = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
      if (answer.response !== 1) throw new Error('已取消重置。');
      await forceCloseClientsForReset(running);
    }
  }

  fullShutdownRequested = true;
  quitState = 'cleaning';
  armFullShutdownWatchdog();
  try {
    await withOperationTimeout(
      startExitRecoveryGuardian(),
      EXIT_GUARDIAN_START_TIMEOUT_MS,
      '退出恢复守护进程启动超时。'
    );
    await controller.beginShutdown();
    const stopped = await withOperationTimeout(controller.forceExit(), 8_000, '重置前停止 Gateway 超时。');
    metadataSubscriber?.stop();
    const waitForRecovery = stopped.dependentClients.length > 0;
    if (!waitForRecovery) await cancelExitRecoveryGuardian();
    await launchApplicationResetWorker(request, app.getPath('userData'), waitForRecovery);
    hideFullShutdownUi();
    clearFullShutdownWatchdog();
    quitState = 'ready';
    app.exit(0);
  } catch (error) {
    clearFullShutdownWatchdog();
    await cancelExitRecoveryGuardian();
    await controller.cancelShutdown().catch(() => undefined);
    fullShutdownRequested = false;
    quitState = 'idle';
    await restoreFullShutdownUi();
    throw error;
  }
}

async function repairApplication(): Promise<{
  removedCachePaths: number;
  removedBytes: number;
  chromiumCacheCleared: boolean;
  traceRetention: import('./app/xwxDeckController').TraceRetentionRepairResult;
  refreshedModels?: number;
}> {
  const updateStatus = updater?.state().status;
  // 'ready' matters too: the verified installer lives under updates/ and the
  // updater still points at it, so clearing the cache would silently break the
  // pending install while the UI kept claiming it was downloaded.
  const preserveUpdates = updateStatus === 'downloading' || updateStatus === 'installing' || updateStatus === 'ready';
  if (!controller) throw new Error('XwX Deck 仍在启动。');
  const traceRetention = await controller.repairTraceRetention();
  await session.defaultSession.clearCache();
  const result = performApplicationRepair(app.getPath('userData'), {
    allowedParentDir: path.dirname(app.getPath('userData')),
    preserveUpdates
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
    chromiumCacheCleared: true,
    traceRetention,
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
    displayName: 'Packaged_API', baseUrl: compatibleBaseUrl, bearerToken: compatibleBearerToken,
    adapter: 'responses', codexModel: compatibleModel
  })).connections[0];
  const claude = (await controller.saveProvider({
    displayName: 'Packaged_Claude', baseUrl: compatibleBaseUrl.replace(/\/v1$/, '/anthropic/v1'),
    bearerToken: compatibleBearerToken, adapter: 'anthropic-messages'
  })).connections[1];
  await controller.switchClientProvider('codex', codex.id);
  await controller.switchClientProvider('claude', claude.id);
  // Closing the manager keeps Trace running; explicitly stopping Trace restores
  // direct configuration and stops the helper, as covered by controller smoke.
  await controller.enable('packaged background Gateway detach smoke');
  const state = await controller.runtimeState();
  if (!state.backgroundGatewayActive || !state.localBaseUrl) {
    throw new Error('Packaged app did not activate its independent Gateway helper.');
  }
  if (!state.tracingEnabled || !state.readiness.recordingEnabled) {
    throw new Error('Packaged manager detach must preserve active Trace recording.');
  }
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
