/**
 * Argument the login-item registration passes so the app boots to the tray.
 * It lives in this electron-free module because non-Electron consumers (the
 * reset path, smoke tests) need the literal without pulling in `app`.
 */
export const STARTUP_HIDDEN_ARG = '--hidden';

/** Electron parses this path as a Windows command line when checking approval. */
export function startupLoginItemPath(executable: string): string {
  return `"${executable.replace(/^"|"$/g, '')}"`;
}

export interface StartupRegistrationSnapshot {
  readonly enabled: boolean;
  readonly supported: boolean;
  readonly executableWillLaunchAtLogin?: boolean;
}

export interface StartupRegistrationWaitOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

export function startupRegistrationMatches(
  actual: StartupRegistrationSnapshot,
  expectedEnabled: boolean
): boolean {
  if (!actual.supported || actual.enabled !== expectedEnabled) return false;
  return expectedEnabled
    ? actual.executableWillLaunchAtLogin !== false
    : true;
}

export async function waitForStartupRegistration<T extends StartupRegistrationSnapshot>(
  read: () => T,
  expectedEnabled: boolean,
  options: StartupRegistrationWaitOptions = {}
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 6));
  const delayMs = Math.max(0, Math.floor(options.delayMs ?? 150));
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let actual = read();
  for (let attempt = 1; attempt < attempts && !startupRegistrationMatches(actual, expectedEnabled); attempt += 1) {
    await sleep(delayMs);
    actual = read();
  }
  return actual;
}
