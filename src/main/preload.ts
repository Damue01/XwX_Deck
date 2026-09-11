import { clipboard, contextBridge, ipcRenderer } from 'electron';

type ClientId = 'claude-cli' | 'codex-cli';
type StateListener = (state: unknown) => void;
type WindowStateListener = (state: unknown) => void;
type UpdateStateListener = (state: unknown) => void;
type ShowUpdateListener = () => void;
type NoticeListener = (notice: unknown) => void;

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.platform = process.platform;
});

contextBridge.exposeInMainWorld('xwxDeck', {
  getState: () => ipcRenderer.invoke('xwxdeck:get-state'),
  getTraceStats: () => ipcRenderer.invoke('xwxdeck:get-trace-stats'),
  getUpdateState: () => ipcRenderer.invoke('xwxdeck:get-update-state'),
  checkForUpdates: () => ipcRenderer.invoke('xwxdeck:check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('xwxdeck:download-update'),
  restartAndInstall: () => ipcRenderer.invoke('xwxdeck:restart-and-install'),
  setStartupEnabled: (enabled: unknown) => ipcRenderer.invoke('xwxdeck:set-startup-enabled', enabled),
  setTheme: (theme: unknown) => ipcRenderer.invoke('xwxdeck:set-theme', theme),
  setTraceAppearance: (payload: unknown) => ipcRenderer.invoke('xwxdeck:set-trace-appearance', payload),
  chooseTraceBackground: () => ipcRenderer.invoke('xwxdeck:choose-trace-background'),
  clearTraceBackground: () => ipcRenderer.invoke('xwxdeck:clear-trace-background'),
  repairApplication: () => ipcRenderer.invoke('xwxdeck:repair-application'),
  resetApplication: (payload: unknown) => ipcRenderer.invoke('xwxdeck:reset-application', payload),
  toggleTracing: () => ipcRenderer.invoke('xwxdeck:toggle-tracing'),
  toggleClient: (client: ClientId) => ipcRenderer.invoke('xwxdeck:toggle-client', client),
  getCodexConfig: () => ipcRenderer.invoke('xwxdeck:get-codex-config'),
  isChatGptRunning: () => ipcRenderer.invoke('xwxdeck:is-chatgpt-running'),
  getCodexEnhancements: () => ipcRenderer.invoke('xwxdeck:get-codex-enhancements'),
  updateCodexEnhancements: (payload: unknown) => ipcRenderer.invoke('xwxdeck:update-codex-enhancements', payload),
  diagnoseCodexConversations: () => ipcRenderer.invoke('xwxdeck:diagnose-codex-conversations'),
  queryCodexConversations: (payload: unknown) => ipcRenderer.invoke('xwxdeck:query-codex-conversations', payload),
  detailCodexConversation: (payload: unknown) => ipcRenderer.invoke('xwxdeck:detail-codex-conversation', payload),
  cancelCodexConversationScan: (requestId: unknown) => ipcRenderer.invoke('xwxdeck:cancel-codex-conversation-scan', requestId),
  openCodexConversationPath: (filePath: unknown) => ipcRenderer.invoke('xwxdeck:open-codex-conversation-path', filePath),
  copyText: async (value: unknown) => clipboard.writeText(String(value ?? '')),
  getCompatibleServiceConfig: () => ipcRenderer.invoke('xwxdeck:get-compatible-config'),
  updateCompatibleServiceConfig: (payload: unknown) => ipcRenderer.invoke('xwxdeck:update-compatible-config', payload),
  getModelServices: () => ipcRenderer.invoke('xwxdeck:get-model-services'),
  setModelService: (payload: unknown) => ipcRenderer.invoke('xwxdeck:set-model-service', payload),
  getClaudeModels: () => ipcRenderer.invoke('xwxdeck:get-claude-models'),
  updateClaudeModels: (payload: unknown) => ipcRenderer.invoke('xwxdeck:update-claude-models', payload),
  updateCodexConfig: (payload: unknown) => ipcRenderer.invoke('xwxdeck:update-codex-config', payload),
  fetchModels: (payload?: unknown) => ipcRenderer.invoke('xwxdeck:fetch-models', payload),
  chooseDirectory: (payload?: unknown) => ipcRenderer.invoke('xwxdeck:choose-directory', payload),
  updateTraceDirectories: (payload: unknown) => ipcRenderer.invoke('xwxdeck:update-trace-directories', payload),
  openDashboard: () => ipcRenderer.invoke('xwxdeck:open-dashboard'),
  openDataFolder: () => ipcRenderer.invoke('xwxdeck:open-data-folder'),
  openLogFolder: () => ipcRenderer.invoke('xwxdeck:open-log-folder'),
  clearHistory: () => ipcRenderer.invoke('xwxdeck:clear-history'),
  inspectTraceIndexRepair: () => ipcRenderer.invoke('xwxdeck:inspect-trace-index-repair'),
  applyTraceIndexRepair: (expectedIndexSha256: unknown) => ipcRenderer.invoke('xwxdeck:apply-trace-index-repair', expectedIndexSha256),
  disableBreaksCodex: () => ipcRenderer.invoke('xwxdeck:disable-breaks-codex'),
  refresh: () => ipcRenderer.invoke('xwxdeck:refresh'),
  minimizeWindow: () => ipcRenderer.invoke('xwxdeck:window-minimize'),
  toggleFullscreen: () => ipcRenderer.invoke('xwxdeck:window-toggle-fullscreen'),
  toggleMaximize: () => ipcRenderer.invoke('xwxdeck:window-toggle-maximize'),
  setManagerView: (view: unknown) => ipcRenderer.invoke('xwxdeck:window-set-view', view),
  closeWindow: () => ipcRenderer.invoke('xwxdeck:window-close'),
  moveWindowStart: (payload: unknown) => ipcRenderer.send('xwxdeck:window-move-start', payload),
  moveWindow: (payload: unknown) => ipcRenderer.send('xwxdeck:window-move', payload),
  moveWindowEnd: () => ipcRenderer.send('xwxdeck:window-move-end'),
  resizeWindowStart: (payload: unknown) => ipcRenderer.send('xwxdeck:window-resize-start', payload),
  resizeWindowMove: (payload: unknown) => ipcRenderer.send('xwxdeck:window-resize-move', payload),
  resizeWindowEnd: () => ipcRenderer.send('xwxdeck:window-resize-end'),
  onState: (listener: StateListener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on('xwxdeck:state', wrapped);
    return () => ipcRenderer.removeListener('xwxdeck:state', wrapped);
  },
  onWindowState: (listener: WindowStateListener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on('xwxdeck:window-state', wrapped);
    return () => ipcRenderer.removeListener('xwxdeck:window-state', wrapped);
  },
  onUpdateState: (listener: UpdateStateListener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on('xwxdeck:update-state', wrapped);
    return () => ipcRenderer.removeListener('xwxdeck:update-state', wrapped);
  },
  onShowUpdateDetails: (listener: ShowUpdateListener) => {
    const wrapped = () => listener();
    ipcRenderer.on('xwxdeck:show-update-details', wrapped);
    return () => ipcRenderer.removeListener('xwxdeck:show-update-details', wrapped);
  },
  onNotice: (listener: NoticeListener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, notice: unknown) => listener(notice);
    ipcRenderer.on('xwxdeck:notice', wrapped);
    return () => ipcRenderer.removeListener('xwxdeck:notice', wrapped);
  }
});
