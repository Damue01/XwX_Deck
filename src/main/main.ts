import { app, dialog } from 'electron';
import {
  acknowledgePortableUpdateStarted,
  PortableUpdateRestartError,
  readPortableUpdateLaunchResult,
  readPortableUpdateRequest,
  runPortableUpdateMode
} from './update/portableUpdate';

// The packaged renderer explicitly uses Canvas2D for the animated field. Let
// Chromium select and rebuild its compositor normally instead of forcing the
// Windows software-GPU/WARP path, which can become invalid after an RDP display
// reconnect or resolution change.
const portableUpdateRequest = readPortableUpdateRequest();
if (portableUpdateRequest) {
  void runPortableUpdateMode(portableUpdateRequest)
    .then(() => app.exit(0))
    .catch(error => {
      console.error('[updater] portable update failed', error);
      try {
        if (error instanceof PortableUpdateRestartError) {
          dialog.showErrorBox('XwX Deck 新版已安装，请手动打开', error.message);
        }
      } finally {
        app.exit(1);
      }
    });
} else {
  const portableLaunchResult = readPortableUpdateLaunchResult();
  void acknowledgePortableUpdateStarted(portableLaunchResult)
    .catch(error => console.error('[updater] failed to record portable candidate pid', error))
    .finally(loadRuntime);
}

function loadRuntime(): void {
  void import('./runtime.js').catch(showRuntimeLoadError);
}

function showRuntimeLoadError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[xwx-deck] runtime failed to load', error);
  try {
    // The update helper detects this exit and reports the manual-open path. A
    // blocking dialog here would keep the failed candidate alive until timeout.
    if (readPortableUpdateLaunchResult()?.kind !== 'complete') {
      dialog.showErrorBox('XwX Deck failed to start', message);
    }
  } catch {
    // The runtime has not loaded yet, so stderr is the last fallback.
  } finally {
    // A process that cannot load runtime.ts has no shutdown handlers or usable
    // UI, but it still owns Electron's process lifetime and can block the next
    // updater-launched instance. Never leave that headless owner running after
    // the user dismisses the error.
    app.exit(1);
  }
}
