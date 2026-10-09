import { setupWebsitesFor } from '../../src/shared/setupWebsites';

declare const __NATIVE_ARCH__: 'arm64' | 'x64';
const native = (window as any).__TAURI__;
if (!native?.core?.invoke) throw new Error('Rust pilot requires its native Tauri host.');
const platform = navigator.platform.startsWith('Mac') ? 'darwin' : navigator.platform.startsWith('Win') ? 'win32' : 'linux';
document.documentElement.dataset.platform = platform;
let windowState = { nativeFrame: platform === 'darwin', maximized: false, fullscreen: false };
const subscriptions = new Map<string, Set<(value: any) => void>>();
const publish = (name: string, value: any) => subscriptions.get(name)?.forEach(listener => listener(value));
const subscribe = (name: string, listener: (value: any) => void) => {
  const listeners = subscriptions.get(name) ?? new Set();
  subscriptions.set(name, listeners);
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const rpc = async (method: string, args: any[] = []) => {
  const value = await native.core.invoke('pilot_rpc', { method, args });
  if (value?.readiness) publish('state', value);
  if (value && typeof value.fullscreen === 'boolean') publish('window', { ...windowState, ...value });
  return value;
};
const methods = [
  'previewConfigurationImport', 'importConfigurations', 'chooseConfigurationImportFile',
  'getModelClients', 'addModelClient', 'removeModelClient', 'detectClientInstallations',
  'setSubscriptionRouting', 'refreshSubscriptionUsage', 'getSubscriptionAccounts', 'beginSubscriptionSignIn', 'cancelSubscriptionSignIn', 'connectSubscriptionAccount', 'renameSubscriptionAccount', 'signOutSubscriptionAccount', 'openSubscriptionUsage',
  'getState', 'getTraceStats', 'getUpdateState', 'getClaudeModels', 'getClaudeDesktopSync',
  'getCodexConfig', 'getCodexEnhancements', 'getCompatibleServiceConfig', 'getModelServices',
  'getProviders', 'saveProvider', 'deleteProvider', 'switchClientProvider', 'fetchProviderModels',
  'fetchModels', 'validateProvider', 'getClaudeEnvironmentOverrides', 'isChatGptRunning',
  'setTheme', 'setLanguage', 'setTraceAppearance', 'setTraceStoragePolicy', 'toggleTracing', 'toggleClient',
  'updateCodexConfig', 'setModelService', 'refresh', 'disableBreaksCodex',
  'minimizeWindow', 'toggleFullscreen', 'toggleMaximize', 'setManagerView', 'closeWindow',
  'moveWindowStart', 'moveWindow', 'moveWindowEnd', 'resizeWindowStart', 'resizeWindowMove', 'resizeWindowEnd',
  'openSetupWebsite', 'checkForUpdates', 'downloadUpdate', 'restartAndInstall', 'cancelUpdate',
  'setStartupEnabled', 'chooseTraceBackground', 'clearTraceBackground', 'repairApplication',
  'repairUnreadableSettings', 'repairInvalidCodexConfiguration', 'repairClientProviderSwitch',
  'resetApplication', 'updateCodexEnhancements', 'updateClaudeModels', 'updateClaudeDesktopSync',
  'clearClaudeEnvironmentOverrides', 'updateCompatibleServiceConfig', 'chooseDirectory',
  'updateTraceDirectories', 'openDashboard', 'openDataFolder', 'openLogFolder', 'clearHistory',
  'inspectTraceIndexRepair', 'applyTraceIndexRepair', 'copyText'
];
const bridge: any = Object.fromEntries(methods.map(method => [method, (...args: any[]) => rpc(method, args)]));
bridge.setupWebsites = setupWebsitesFor(platform, __NATIVE_ARCH__);
bridge.onState = (listener: any) => subscribe('state', listener);
bridge.onWindowState = (listener: any) => { listener(windowState); return subscribe('window', listener); };
bridge.onUpdateState = (listener: any) => subscribe('update', listener);
bridge.onShowUpdateDetails = (listener: any) => subscribe('showUpdate', listener);
bridge.onNotice = (listener: any) => subscribe('notice', listener);
(window as any).xwxDeck = bridge;
let lastSubscriptionNotice = 0;
let noticesInitialized = false;
let checkingNotices = false;
void rpc('getSubscriptionNotices').then(notices => {
  lastSubscriptionNotice = Math.max(0, ...notices.map((notice: any) => notice.id));
  noticesInitialized = true;
}).catch(() => { noticesInitialized = true; });
setInterval(() => {
  if (document.visibilityState !== 'visible' || checkingNotices) return;
  checkingNotices = true;
  void rpc('getSubscriptionNotices').then(notices => {
    for (const notice of notices) {
      if (notice.id > lastSubscriptionNotice) {
        lastSubscriptionNotice = notice.id;
        if (noticesInitialized) publish('notice', { message: notice.message, type: 'info' });
      }
    }
    noticesInitialized = true;
  }).catch(() => undefined).finally(() => { checkingNotices = false; });
}, 2000);
native.event.listen('pilot-state', (event: any) => publish('state', event.payload));
native.event.listen('pilot-update', (event: any) => publish('update', event.payload));
native.event.listen('pilot-window', (event: any) => { windowState = event.payload; publish('window', windowState); });
void rpc('getWindowState').then(value => { windowState = value; publish('window', value); });

// Native WebKit smoke is injected only when the host is launched with --smoke.
// Capture actual runtime errors; never substitute previewApi or mock backend data.
const errors: string[] = [];
window.addEventListener('error', event => errors.push(event.message));
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
(window as any).__pilotErrors = errors;
