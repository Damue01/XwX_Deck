import { app, dialog } from 'electron';
import { readPortableUpdateRequest, runPortableUpdateMode } from './update/portableUpdate';

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
      app.exit(1);
    });
} else {
  loadRuntime();
}

function loadRuntime(): void {
  void import('./runtime.js').catch(showRuntimeLoadError);
}

function showRuntimeLoadError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    dialog.showErrorBox('XwX Deck failed to start', message);
  } catch {
    // The runtime has not loaded yet, so stderr is the last fallback.
    console.error(error);
  }
}
