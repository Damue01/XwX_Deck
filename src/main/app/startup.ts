import { app } from 'electron';
import {
  STARTUP_HIDDEN_ARG,
  startupLoginItemPath,
  startupRegistrationMatches,
  waitForStartupRegistration
} from './startupRegistration';

export {
  STARTUP_HIDDEN_ARG,
  startupRegistrationMatches,
  waitForStartupRegistration
} from './startupRegistration';

export interface StartupSettingsSnapshot {
  readonly enabled: boolean;
  readonly desiredEnabled?: boolean;
  readonly warning?: string;
  readonly supported: boolean;
  readonly launchHidden: boolean;
  readonly executableWillLaunchAtLogin?: boolean;
}

export function isStartupHiddenLaunch(argv: readonly string[] = process.argv): boolean {
  if (argv.includes(STARTUP_HIDDEN_ARG)) return true;
  if (process.platform !== 'darwin') return false;
  try {
    // Available on macOS 12 and earlier. macOS 13+ no longer supports hidden
    // main-app login items, so those launches intentionally open the manager.
    return app.getLoginItemSettings(loginItemOptions()).wasOpenedAsHidden === true;
  } catch {
    return false;
  }
}

export function readStartupSettings(): StartupSettingsSnapshot {
  if (!startupSupported()) return unsupportedStartup();
  try {
    const settings = app.getLoginItemSettings(loginItemOptions());
    return {
      enabled: settings.openAtLogin === true,
      supported: true,
      launchHidden: process.platform === 'win32' || settings.openAsHidden === true,
      ...(process.platform === 'win32'
        ? { executableWillLaunchAtLogin: settings.executableWillLaunchAtLogin }
        : {})
    };
  } catch (error) {
    return { ...unsupportedStartup(), supported: true,
      warning: `无法读取系统登录项：${(error as Error).message}` };
  }
}

export async function setStartupEnabled(enabled: boolean): Promise<StartupSettingsSnapshot> {
  if (!startupSupported()) throw new Error('当前系统不支持开机启动设置。');
  app.setLoginItemSettings({
    ...loginItemOptions(),
    openAtLogin: enabled,
    ...(process.platform === 'win32' && enabled ? { enabled: true } : {}),
    ...(process.platform === 'darwin' ? { openAsHidden: true } : {})
  });
  if (process.platform === 'darwin' && enabled) {
    const status = app.getLoginItemSettings(loginItemOptions()).status;
    if (status === 'requires-approval') {
      throw new Error('macOS 需要你的批准，请在“系统设置 → 通用 → 登录项”中允许 XwX Deck。');
    }
  }
  const actual = await waitForStartupRegistration(readStartupSettings, enabled);
  if (!startupRegistrationMatches(actual, enabled)) {
    throw new Error(enabled
      ? '系统暂未确认开机启动项；选择已保存，可重试注册。'
      : '系统暂未确认启动项已移除；选择已保存，可重试。');
  }
  return actual;
}

function startupSupported(): boolean {
  return (process.platform === 'win32' || process.platform === 'darwin') && app.isPackaged;
}

function unsupportedStartup(): StartupSettingsSnapshot {
  return { enabled: false, supported: false, launchHidden: process.platform === 'win32' };
}

function loginItemOptions(): Electron.LoginItemSettingsOptions {
  if (process.platform === 'darwin') return { type: 'mainAppService' };
  return {
    path: startupLoginItemPath(startupExecutablePath()),
    args: [STARTUP_HIDDEN_ARG]
  };
}

function startupExecutablePath(): string {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}
