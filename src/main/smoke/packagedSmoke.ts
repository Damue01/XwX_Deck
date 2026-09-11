import type { BrowserWindow } from 'electron';
import * as path from 'path';
import Database from '../shared/sqlite';

export async function runPackagedSmokeTest(managerWindow: BrowserWindow): Promise<unknown> {
  const codexHome = process.env.CODEX_HOME;
  const compatibleServiceBaseUrl = process.env.XWX_DECK_SMOKE_COMPATIBLE_SERVICE_BASE_URL;
  const compatibleServiceToken = process.env.XWX_DECK_SMOKE_COMPATIBLE_SERVICE_TOKEN;
  const skipStartupToggle = process.env.XWX_DECK_SMOKE_SKIP_STARTUP_TOGGLE === '1';
  const preserveTrace = process.env.XWX_DECK_SMOKE_PRESERVE_TRACE === '1';
  if (!codexHome || !compatibleServiceBaseUrl || !compatibleServiceToken) {
    throw new Error('Packaged smoke fixtures were not provided.');
  }

  const stateDbPath = path.join(codexHome, 'state_5.sqlite');
  const stateDb = new Database(stateDbPath);
  stateDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL); INSERT INTO threads VALUES ('packaged-official', 'openai');");
  stateDb.close();

  // Electron's executeJavaScript() collapses any rejection from the async block
  // below into the opaque "Script failed to execute" message and drops the real
  // error onto the renderer console, which nothing forwards. Capture the console
  // so a failing UI assertion names itself instead of forcing a rebuild-and-guess.
  const consoleLog: string[] = [];
  const onConsole = (...cbArgs: unknown[]) => {
    // Electron changed this signature: older builds pass
    // (event, level, message, line, sourceId); newer builds pass a single
    // Event object with .level/.message/.lineNumber/.sourceId. Handle both.
    const first = cbArgs[0] as Record<string, unknown> | undefined;
    if (first && typeof first === 'object' && typeof first.message === 'string') {
      const line = first.lineNumber ?? first.line;
      consoleLog.push(`[renderer:${String(first.level ?? '')}] ${first.message}${line ? ` (${String(first.sourceId ?? '')}:${String(line)})` : ''}`);
      return;
    }
    const [, level, message, line, sourceId] = cbArgs as [unknown, unknown, string, number, string];
    if (typeof message === 'string') {
      consoleLog.push(`[renderer:${String(level ?? '')}] ${message}${line ? ` (${sourceId}:${line})` : ''}`);
    }
  };
  managerWindow.webContents.on('console-message', onConsole as never);

  const runScript = async () => {
    return managerWindow.webContents.executeJavaScript(`(async () => {
    try {
    const skipStartupToggle = ${JSON.stringify(skipStartupToggle)};
    const preserveTrace = ${JSON.stringify(preserveTrace)};
    const compatibleServiceBaseUrl = ${JSON.stringify(compatibleServiceBaseUrl)};
    const compatibleServiceToken = ${JSON.stringify(compatibleServiceToken)};
    const api = window.xwxDeck;
    if (!api) throw new Error('window.xwxDeck is missing');
    const required = ${JSON.stringify([
      'getState', 'getTraceStats', 'getUpdateState', 'checkForUpdates', 'setStartupEnabled', 'setTheme', 'setTraceAppearance', 'chooseTraceBackground', 'clearTraceBackground', 'repairApplication', 'resetApplication', 'toggleTracing', 'toggleClient',
      'getCodexConfig', 'getCodexEnhancements', 'updateCodexEnhancements',
      'diagnoseCodexConversations', 'openCodexConversationPath', 'copyText',
      'getCompatibleServiceConfig', 'updateCompatibleServiceConfig', 'getModelServices', 'setModelService', 'isChatGptRunning',
      'getClaudeModels', 'updateClaudeModels', 'clearHistory', 'refresh', 'toggleMaximize', 'setManagerView', 'fetchModels',
      'updateTraceDirectories'
    ])};
    const missing = required.filter(name => typeof api[name] !== 'function');
    if (missing.length) throw new Error('missing IPC methods: ' + missing.join(', '));

    const waitFor = async (check, message, timeout = 5000) => {
      const started = Date.now();
      while (!check()) {
        if (Date.now() - started > timeout) throw new Error(message);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    if (document.body.dataset.runtime !== 'desktop') throw new Error('manager renderer did not enter desktop mode');
    // React may still be committing the first render when loadFile resolves;
    // wait for the rail to exist before querying controls.
    await waitFor(() => document.querySelector('.rail-btn[data-page="signal"]'), 'manager UI did not render (root html length=' + (document.getElementById('root') ? document.getElementById('root').innerHTML.length : -1) + ')');
    const expectedPlatform = ${JSON.stringify(process.platform)};
    if (document.documentElement.dataset.platform !== expectedPlatform) {
      throw new Error('renderer platform marker is missing or incorrect');
    }
    const nativeMacFrame = expectedPlatform === 'darwin';
    if (nativeMacFrame === Boolean(document.querySelector('.titlebar .win'))) {
      throw new Error('manager window controls do not match the native-frame platform contract');
    }
    const favicon = document.querySelector('link[rel="icon"]');
    if (!favicon || !favicon.href.endsWith('/icon-runtime.png')) {
      throw new Error('manager window favicon is missing or not using the packaged geometric icon');
    }
    const faviconSize = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error('manager window favicon did not load'));
      image.src = favicon.href;
    });
    if (faviconSize.width < 128 || faviconSize.height < 128) {
      throw new Error('manager window favicon is too small: ' + JSON.stringify(faviconSize));
    }
    const settingsButton = document.querySelector('.rail-btn[data-page="settings"]');
    const modelsButton = document.querySelector('.rail-btn[data-page="models"]');
    const toolsButton = document.querySelector('.rail-btn[data-page="tools"]');
    const signalButton = document.querySelector('.rail-btn[data-page="signal"]');
    const fieldCanvas = document.querySelector('canvas.field');
    const appearanceTrigger = document.querySelector('[data-appearance-trigger]');
    const captureButton = document.getElementById('captureBtn');
    const stopCaptureButton = document.getElementById('stopCaptureBtn');
    const codexTab = document.querySelector('[data-client-tab="codex"]');
    const codexPanel = document.querySelector('[data-client-panel="codex"]');
    const startupToggle = document.getElementById('startupToggle');
    const clearHistoryButton = document.getElementById('clearHistory');
    const clearHistoryIcon = clearHistoryButton?.querySelector('.trace-row-danger-icon');
    const dataFolderAction = document.getElementById('changeDataFolder');
    const repairCenterTrigger = document.getElementById('repairCenterTrigger');
    const codexAuthToggle = document.getElementById('codexAuthToggle');
    const codexHistoryToggle = document.getElementById('codexHistoryToggle');
    const codexServiceToggle = document.getElementById('codexServiceToggle');
    if (!settingsButton || !modelsButton || !toolsButton || !signalButton || !fieldCanvas || !appearanceTrigger || !captureButton || !stopCaptureButton || !codexTab || !codexPanel) {
      throw new Error('manager interaction controls are missing');
    }
    if (!startupToggle || !document.getElementById('page-settings')?.contains(startupToggle)) {
      throw new Error('startup toggle is not rendered in Settings');
    }
    if (!clearHistoryButton || !clearHistoryIcon || !dataFolderAction || !repairCenterTrigger) {
      throw new Error('Trace history alignment controls are missing');
    }
    if (
      !codexAuthToggle
      || !codexHistoryToggle
      || !codexServiceToggle
      || !codexPanel.contains(codexAuthToggle)
      || !codexPanel.contains(codexHistoryToggle)
      || !codexPanel.contains(codexServiceToggle)
    ) {
      throw new Error('ChatGPT enhancement controls are not rendered inside the ChatGPT model panel');
    }
    if (codexAuthToggle.disabled || codexAuthToggle.getAttribute('aria-pressed') !== 'true') {
      throw new Error('ChatGPT official login preference must be enabled and interactive');
    }
    if (codexTab.textContent?.trim() !== 'ChatGPT') throw new Error('ChatGPT display name was not rendered');
    if (document.querySelector('.brand')?.textContent?.trim() !== 'XwX Deck') throw new Error('XwX Deck product name was not rendered');
    const initialViewport = { width: window.innerWidth, height: window.innerHeight };
    const assertStableViewport = page => {
      if (window.innerWidth !== initialViewport.width || window.innerHeight !== initialViewport.height) {
        throw new Error(page + ' navigation changed the manager viewport');
      }
    };
    modelsButton.click();
    codexTab.click();
    await waitFor(
      () => document.getElementById('page-models')?.classList.contains('current') && !codexPanel.hasAttribute('hidden'),
      'ChatGPT model panel did not become visible'
    );
    await waitFor(
      () => fieldCanvas.dataset.rendering === 'paused' && document.getElementById('page-signal')?.inert,
      'Trace field did not pause after leaving Trace'
    );
    if (fieldCanvas.dataset.renderer !== '2d') {
      throw new Error('packaged Windows Trace field must avoid software WebGL');
    }
    assertStableViewport('model');
    settingsButton.click();
    await waitFor(
      () => document.getElementById('page-settings')?.classList.contains('current'),
      'settings navigation click was not handled'
    );
    assertStableViewport('settings');
    const clearRowRect = clearHistoryButton.getBoundingClientRect();
    const clearIconRect = clearHistoryIcon.getBoundingClientRect();
    const dataActionRect = dataFolderAction.getBoundingClientRect();
    const clearIconSvg = clearHistoryIcon.querySelector('svg');
    const clearIconOffset = Math.abs(
      (clearIconRect.left + clearIconRect.width / 2)
        - (dataActionRect.left + dataActionRect.width / 2)
    );
    const clearIconVerticalOffset = Math.abs(
      (clearIconRect.top + clearIconRect.height / 2)
        - (clearRowRect.top + clearRowRect.height / 2)
    );
    if (Math.abs(clearRowRect.height - 48) > 0.25 || Math.abs(clearIconRect.width - 32) > 0.25 || Math.abs(clearIconRect.height - 32) > 0.25) {
      throw new Error('Trace history row or icon container has unexpected dimensions');
    }
    if (clearIconOffset > 0.25 || clearIconVerticalOffset > 0.25) {
      throw new Error('Trace history icon is not centered with the actions above');
    }
    if (!clearIconSvg || getComputedStyle(clearIconSvg).fill !== 'none') {
      throw new Error('Trace history icon must remain outline-only');
    }
    repairCenterTrigger.click();
    await waitFor(() => document.getElementById('repairCenterSheet'), 'repair center sheet did not open');
    const repairSheet = document.getElementById('repairCenterSheet');
    // The sheet slides in from the right, so it legitimately starts one full
    // width off-screen via [data-starting-style]. Measuring the moment it mounts
    // reports it outside the viewport; wait for the enter transition to settle.
    await waitFor(
      () => !repairSheet.hasAttribute('data-starting-style')
        && repairSheet.getBoundingClientRect().right <= innerWidth + 0.5,
      'repair center sheet never finished sliding into the manager viewport'
    );
    const quickRepairButton = document.getElementById('quickRepairApplication');
    const resetApplicationButton = document.getElementById('resetApplication');
    const repairClose = document.getElementById('repairCenterClose');
    if (!repairSheet || !quickRepairButton || !resetApplicationButton || !repairClose) {
      throw new Error('repair center actions are missing');
    }
    const repairRect = repairSheet.getBoundingClientRect();
    if (repairRect.right > innerWidth + 0.5 || repairRect.top < 35 || repairRect.width < 300) {
      throw new Error(
        'repair center sheet is outside the manager viewport'
        + ' (right=' + repairRect.right.toFixed(1) + ' innerWidth=' + innerWidth
        + ' top=' + repairRect.top.toFixed(1) + ' width=' + repairRect.width.toFixed(1) + ')'
      );
    }
    repairClose.click();
    await waitFor(() => !document.getElementById('repairCenterSheet'), 'repair center sheet did not close');
    toolsButton.click();
    await waitFor(
      () => document.getElementById('page-tools')?.classList.contains('current'),
      'tools navigation click was not handled'
    );
    await waitFor(
      () => document.querySelector('#conversationDoctor .conversation-table'),
      'conversation diagnosis did not finish its initial scan'
    );
    const removedSpreadsheetDropzoneId = ['excel', 'Dropzone'].join('');
    const removedSpreadsheetPanelId = ['tool-panel-', 'excel'].join('');
    if (document.getElementById(removedSpreadsheetDropzoneId) || document.getElementById(removedSpreadsheetPanelId)) {
      throw new Error('removed Excel conversion UI returned with the conversation diagnosis page');
    }
    assertStableViewport('tools');
    signalButton.click();
    await waitFor(
      () => document.getElementById('page-signal')?.classList.contains('current'),
      'signal navigation click was not handled'
    );
    if (document.getElementById('page-signal')?.inert) throw new Error('Trace remained inert after navigation');
    assertStableViewport('Trace');
    document.getElementById('appearanceTriggerIdle')?.click();
    await waitFor(
      () => document.getElementById('appearanceDrawer')?.classList.contains('open'),
      'appearance drawer did not open'
    );
    const appearanceText = document.getElementById('appearanceDrawer')?.textContent ?? '';
    for (const requiredLabel of ['皮肤', '页面模块']) {
      if (!appearanceText.includes(requiredLabel)) throw new Error('appearance group title is missing: ' + requiredLabel);
    }
    for (const redundantNote of [
      '仅影响 Trace 页面',
      '当前 Trace 动态背景',
      '无背景元素，仅保留内容',
      '使用本机图片作为背景',
      '只控制显示，不停止统计'
    ]) {
      if (appearanceText.includes(redundantNote)) throw new Error('appearance drawer still contains redundant note: ' + redundantNote);
    }
    const appearanceSectionTitle = document.querySelector('.appearance-section h3');
    const appearanceOptionLabel = document.querySelector('.skin-copy strong');
    if (!appearanceSectionTitle || !appearanceOptionLabel) throw new Error('appearance typography contract targets are missing');
    const appearanceSectionTitleSize = parseFloat(getComputedStyle(appearanceSectionTitle).fontSize);
    const appearanceOptionLabelSize = parseFloat(getComputedStyle(appearanceOptionLabel).fontSize);
    if (appearanceSectionTitleSize <= appearanceOptionLabelSize) {
      throw new Error('appearance section titles must be larger than option labels');
    }
    const skinRadio = document.querySelector('.skin-option.selected .skin-radio');
    const throughputToggle = document.getElementById('throughputVisibilityToggle');
    if (!skinRadio || !throughputToggle) throw new Error('appearance alignment controls are missing');
    const appearanceRightDelta = Math.abs(
      skinRadio.getBoundingClientRect().right - throughputToggle.getBoundingClientRect().right
    );
    if (appearanceRightDelta > 1) {
      throw new Error('appearance controls do not share one right alignment axis: ' + appearanceRightDelta);
    }
    const dividerTargets = [
      document.querySelector('.appearance-head'),
      document.querySelector('.skin-list'),
      ...document.querySelectorAll('.skin-option'),
      document.querySelector('.modules-section'),
      document.querySelector('.module-row')
    ];
    if (dividerTargets.some(target => !target)) throw new Error('appearance divider contract targets are missing');
    const appearanceDividerWidth = Math.max(...dividerTargets.flatMap(target => {
      const style = getComputedStyle(target);
      return [parseFloat(style.borderTopWidth), parseFloat(style.borderBottomWidth)];
    }));
    if (appearanceDividerWidth !== 0) {
      throw new Error('appearance drawer contains an unexpected divider: ' + appearanceDividerWidth);
    }
    document.querySelector('.appearance-head')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    if (!document.getElementById('appearanceDrawer')?.classList.contains('open')) {
      throw new Error('appearance drawer closed after an interaction inside the panel');
    }
    document.getElementById('appearanceDismiss')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await waitFor(
      () => !document.getElementById('appearanceDrawer')?.classList.contains('open'),
      'appearance drawer did not close after clicking outside the panel'
    );

    // Verify the token readout actually renders in the bundled Geist Mono
    // (packaged app has no node_modules; the font must be inlined in the CSS).
    const readout = document.getElementById('readoutValue');
    const readoutFont = readout ? getComputedStyle(readout).fontFamily : '';
    if (!/geist mono/i.test(readoutFont)) {
      throw new Error('token readout is not using bundled Geist Mono: ' + readoutFont);
    }
    const geistFace = Array.from(document.fonts).some(f => /geist mono/i.test(f.family));
    if (!geistFace) throw new Error('Geist Mono @font-face was not registered');

    const before = await api.getState();
    if (before.tracingEnabled) throw new Error('isolated smoke profile unexpectedly started with tracing enabled');
    const enabledIdleClients = before.clients.filter(item => item.enabled);
    if (!enabledIdleClients.length || enabledIdleClients.some(item => item.status !== 'idle')) {
      throw new Error('enabled clients must remain idle before Trace starts');
    }
    const idleSourceButtons = Array.from(document.querySelectorAll('.idle-state .src-t.on'));
    if (
      idleSourceButtons.length !== enabledIdleClients.length
      || idleSourceButtons.some(button => button.getAttribute('data-status') !== 'idle')
      || idleSourceButtons.some(button => button.matches('[data-status="skipped"]'))
    ) {
      throw new Error('idle Trace clients must not render as connection failures');
    }
    if (!before.startup?.supported) throw new Error('packaged startup setting is not supported');
    const startupInitiallyEnabled = before.startup.enabled === true;
    if (!skipStartupToggle) try {
      settingsButton.click();
      await waitFor(() => document.getElementById('page-settings')?.classList.contains('current'), 'settings did not open for startup toggle');
      startupToggle.click();
      await waitFor(
        () => startupToggle.getAttribute('aria-checked') === String(!startupInitiallyEnabled),
        'startup toggle did not change state'
      );
      const startupChanged = await api.getState();
      if (startupChanged.startup?.enabled !== !startupInitiallyEnabled) {
        throw new Error('startup setting did not persist after the UI toggle');
      }
    } finally {
      const startupRestored = await api.setStartupEnabled(startupInitiallyEnabled);
      if (startupRestored?.startup?.enabled !== startupInitiallyEnabled) {
        throw new Error('startup setting was not restored after the smoke test');
      }
    }

    // Theme now persists through main-process settings.json (delivered via
    // runtime state) instead of the renderer's file:// localStorage, which a
    // portable repackage would silently drop. Drive the real toggle and observe
    // both the runtime state and the DOM reflect it.
    const themeToggle = document.getElementById('themeToggle');
    if (!themeToggle || !document.getElementById('page-settings')?.contains(themeToggle)) {
      throw new Error('theme toggle is not rendered in Settings');
    }
    const themeBefore = (await api.getState()).theme;
    themeToggle.click();
    const themeExpected = themeBefore === 'night' ? 'day' : 'night';
    await waitFor(
      () => themeToggle.getAttribute('aria-checked') === String(themeExpected === 'night'),
      'theme toggle did not change state'
    );
    // The renderer flips the control optimistically, while settings.json is
    // persisted through asynchronous IPC. Poll the authoritative runtime state
    // instead of treating the immediate aria-checked change as proof that the
    // main process has completed the write.
    let themeChanged = await api.getState();
    for (let attempt = 0; themeChanged.theme !== themeExpected && attempt < 100; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
      themeChanged = await api.getState();
    }
    if (themeChanged.theme !== themeExpected) {
      throw new Error('theme did not persist to runtime state after the UI toggle');
    }
    if (document.documentElement.dataset.theme !== themeExpected
      || document.documentElement.classList.contains('dark') !== (themeExpected === 'night')) {
      throw new Error('theme change was not applied to the document root');
    }
    // Restore the original theme through the API so the smoke leaves no residue.
    const themeRestored = await api.setTheme(themeBefore);
    if (themeRestored?.theme !== themeBefore) {
      throw new Error('theme was not restored after the smoke test');
    }
    signalButton.click();
    const stats = await api.getTraceStats();
    const compatible = await api.updateCompatibleServiceConfig({
      baseUrl: compatibleServiceBaseUrl,
      bearerToken: compatibleServiceToken
    });
    const modelServices = await api.getModelServices();
    if (compatible.baseUrl !== compatibleServiceBaseUrl || !modelServices.codex) {
      throw new Error('兼容服务/model-service state was not applied from the explicit packaged fixture');
    }
    await api.updateClaudeModels({ fable: 'packaged-fable', opus: 'packaged-opus', sonnet: 'packaged-sonnet', haiku: 'packaged-haiku' });
    const claudeEnabled = await api.setModelService({ client: 'claude', enabled: true });
    if (!claudeEnabled.claude || claudeEnabled.claudeStatus.status !== 'active') {
      throw new Error('Claude 兼容服务 service did not pass live configuration verification');
    }
    if (!claudeEnabled.claudeStatus.actualBaseUrl?.endsWith('/qa-openai/anthropic')) {
      throw new Error('Claude 兼容服务 URL was not normalized to the Anthropic gateway: ' + claudeEnabled.claudeStatus.actualBaseUrl);
    }
    const enhancementsBefore = await api.getCodexEnhancements();
    if (!enhancementsBefore.preserveOfficialLogin || enhancementsBefore.unifySessionHistory || enhancementsBefore.authMode !== 'chatgpt') {
      throw new Error('unexpected initial ChatGPT enhancement state');
    }
    modelsButton.click();
    codexTab.click();
    const enhancementsOn = await api.updateCodexEnhancements({ unifySessionHistory: true, migrateExisting: true });
    if (!enhancementsOn.unifySessionHistory || enhancementsOn.history?.migratedJsonlFiles !== 1 || enhancementsOn.history?.migratedStateRows !== 1) {
      throw new Error('ChatGPT history migration did not update JSONL and SQLite');
    }
    const enhancementsOff = await api.updateCodexEnhancements({ unifySessionHistory: false, restoreExisting: true });
    if (enhancementsOff.unifySessionHistory || enhancementsOff.history?.restoredJsonlFiles !== 1 || enhancementsOff.history?.restoredStateRows !== 1) {
      throw new Error('ChatGPT history restore did not restore JSONL and SQLite');
    }
    const keepCurrentOn = await api.updateCodexEnhancements({ unifySessionHistory: true, migrateExisting: true });
    if (keepCurrentOn.history?.migratedJsonlFiles !== 1 || keepCurrentOn.history?.migratedStateRows !== 1) {
      throw new Error('ChatGPT history did not migrate before the keep-current close case');
    }
    const keepCurrentOff = await api.updateCodexEnhancements({ unifySessionHistory: false, restoreExisting: false });
    if (keepCurrentOff.unifySessionHistory || keepCurrentOff.historyRestorePending || keepCurrentOff.history) {
      throw new Error('closing history unification with keep-current selected changed or queued history');
    }
    const legacyAuthUpdate = await api.updateCodexEnhancements({ preserveOfficialLogin: false });
    if (legacyAuthUpdate.preserveOfficialLogin || legacyAuthUpdate.authMode !== 'unknown') {
      throw new Error('disabling login preservation did not project the managed Gateway credential');
    }
    const restoredAuthUpdate = await api.updateCodexEnhancements({ preserveOfficialLogin: true });
    if (!restoredAuthUpdate.preserveOfficialLogin || restoredAuthUpdate.authMode !== 'chatgpt') {
      throw new Error('re-enabling login preservation did not restore ChatGPT auth.json');
    }

    const cleanAppearance = await api.setTraceAppearance({ skin: 'clean' });
    if (cleanAppearance.traceAppearance?.skin !== 'clean') {
      throw new Error('clean Trace skin did not persist before capture regression');
    }
    await waitFor(() => !document.querySelector('canvas.field'), 'clean Trace skin kept the classic particle canvas mounted');
    captureButton.click();
    await waitFor(() => document.body.dataset.capturing === 'true', 'capture button click did not start tracing');
    await waitFor(
      () => document.getElementById('liveBoard')?.getAttribute('aria-hidden') === 'false',
      'clean Trace skin did not reveal the live board after capture started'
    );
    const classicAppearance = await api.setTraceAppearance({ skin: 'classic' });
    if (classicAppearance.traceAppearance?.skin !== 'classic') {
      throw new Error('classic Trace skin was not restored after capture regression');
    }
    await waitFor(() => !!document.querySelector('canvas.field'), 'classic Trace particle canvas did not return');
    const active = await api.getState();
    if (!active.tracingEnabled) throw new Error('trace did not start');
    const claudeDuringTrace = await api.getModelServices();
    if (!claudeDuringTrace.claude || !claudeDuringTrace.claudeStatus.traceManaged) {
      throw new Error('Claude 兼容服务 state was lost beneath Trace takeover');
    }
    if (claudeDuringTrace.claudeStatus.liveBaseUrl !== active.localBaseUrl) {
      throw new Error('Claude live URL was not replaced by the XwX Trace endpoint');
    }
    const protectedDuringTrace = await api.getCodexEnhancements();
    if (protectedDuringTrace.authMode !== 'chatgpt') throw new Error('Trace takeover changed ChatGPT auth.json');
    const notTaken = active.clients.filter(item => item.enabled && item.status !== 'taken');
    if (notTaken.length) throw new Error('client takeover failed: ' + notTaken.map(item => item.id + '=' + item.status).join(', '));
    const notWaiting = active.clients.filter(item => item.enabled && item.statusText !== '等待请求');
    if (notWaiting.length) throw new Error('client status claimed capture before its first request');
    if (!active.localBaseUrl) throw new Error('Trace did not publish its local proxy URL');
    const tracesBeforeRequest = active.traces;
    await fetch(active.localBaseUrl + '/v1/messages', {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({
        model: 'packaged-trace-model',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'packaged-trace-e2e' }]
      })
    });
    let traceAfterRequest = await api.getState();
    for (let attempt = 0; traceAfterRequest.traces <= tracesBeforeRequest && attempt < 100; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
      traceAfterRequest = await api.getState();
    }
    if (traceAfterRequest.traces !== tracesBeforeRequest + 1) {
      throw new Error('real proxy request was not captured into the Trace index');
    }
    const capturedClaude = traceAfterRequest.clients.find(item => item.id === 'claude-cli');
    if (capturedClaude?.statusText !== '追踪中') {
      throw new Error('Claude did not transition from waiting to active capture');
    }
    const traceCapture = {
      captured: true,
      delta: traceAfterRequest.traces - tracesBeforeRequest,
      beforeStatus: active.clients.find(item => item.id === 'claude-cli')?.statusText,
      afterStatus: capturedClaude.statusText
    };
    modelsButton.click();
    codexTab.click();
    await waitFor(() => codexServiceToggle.getAttribute('aria-checked') === 'true', 'ChatGPT 兼容服务 toggle lost its underlying state during Trace');
    codexServiceToggle.click();
    await waitFor(() => codexServiceToggle.getAttribute('aria-checked') === 'false', 'ChatGPT 兼容服务 toggle did not react immediately during Trace');
    await waitFor(() => codexServiceToggle.getAttribute('aria-busy') !== 'true', 'ChatGPT switch to official service did not finish during Trace');
    if ((await api.getModelServices()).codex) throw new Error('ChatGPT did not switch to official service during Trace');
    if ((await api.getCodexConfig()).mode !== 'official') throw new Error('ChatGPT underlying config was not official during Trace');
    const immediateOfficialTrace = await api.getState();
    const immediateOfficialChatGpt = immediateOfficialTrace.clients.find(item => item.id === 'codex-cli');
    if (!immediateOfficialTrace.readiness.codexConfigReady
      || !immediateOfficialTrace.readiness.codexRouteReady
      || !immediateOfficialTrace.readiness.codexGatewayEnabled
      || immediateOfficialChatGpt?.status !== 'taken') {
      throw new Error('ChatGPT official service did not remain on the active Trace route after 兼容服务 was disabled');
    }
    const traceHistoryOn = await api.updateCodexEnhancements({ unifySessionHistory: true, migrateExisting: true });
    if (traceHistoryOn.history?.skippedReason !== 'no_matching_history') {
      throw new Error('stable xwx_deck history unexpectedly changed during official Trace');
    }
    const traceHistoryOff = await api.updateCodexEnhancements({ unifySessionHistory: false, restoreExisting: true });
    if (traceHistoryOff.history?.restoredJsonlFiles !== 1 || traceHistoryOff.history?.restoredStateRows !== 1 || traceHistoryOff.historyRestorePending) {
      throw new Error('official Trace did not restore history immediately under the stable provider');
    }
    const traceHistoryReEnabled = await api.updateCodexEnhancements({ unifySessionHistory: true, migrateExisting: true });
    if (traceHistoryReEnabled.historyRestorePending || traceHistoryReEnabled.history?.migratedJsonlFiles !== 1 || traceHistoryReEnabled.history?.migratedStateRows !== 1) {
      throw new Error('history did not migrate back to xwx_deck during official Trace');
    }
    const traceHistoryOffAgain = await api.updateCodexEnhancements({ unifySessionHistory: false, restoreExisting: true });
    if (traceHistoryOffAgain.historyRestorePending || traceHistoryOffAgain.history?.restoredJsonlFiles !== 1 || traceHistoryOffAgain.history?.restoredStateRows !== 1) {
      throw new Error('history did not restore immediately after re-migration');
    }
    codexServiceToggle.click();
    await waitFor(() => codexServiceToggle.getAttribute('aria-checked') === 'true', 'ChatGPT 兼容服务 toggle did not switch back during Trace');
    await waitFor(() => codexServiceToggle.getAttribute('aria-busy') !== 'true', 'ChatGPT switch back to 兼容服务 did not finish during Trace');
    if (document.querySelector('[role="alertdialog"]')) {
      throw new Error('ChatGPT 兼容服务 must not require a second confirmation');
    }
    if (!(await api.getModelServices()).codex) throw new Error('ChatGPT did not switch back to 兼容服务 during Trace');
    if ((await api.getCodexConfig()).mode !== 'compatible') throw new Error('ChatGPT underlying config was not 兼容服务 during Trace');
    signalButton.click();
    const codexOff = await api.toggleClient('codex-cli');
    const codexOffState = codexOff.clients.find(item => item.id === 'codex-cli');
    if (!codexOffState || codexOffState.enabled) throw new Error('ChatGPT client did not turn off');
    const codexOn = await api.toggleClient('codex-cli');
    const codexOnState = codexOn.clients.find(item => item.id === 'codex-cli');
    if (!codexOnState || !codexOnState.enabled) throw new Error('ChatGPT client did not turn back on');
    stopCaptureButton.click();
    await waitFor(() => document.body.dataset.capturing === 'false', 'stop button click did not stop tracing');
    const stopped = await api.getState();
    if (stopped.tracingEnabled) throw new Error('trace did not stop');
    const claudeAfterTrace = await api.getModelServices();
    if (!claudeAfterTrace.claude || claudeAfterTrace.claudeStatus.traceManaged) {
      throw new Error('Claude 兼容服务 service did not resume after Trace stopped');
    }
    if (claudeAfterTrace.claudeStatus.liveBaseUrl !== claudeAfterTrace.claudeStatus.expectedBaseUrl) {
      throw new Error('Claude 兼容服务 URL was not restored after Trace stopped');
    }
    const claudeDisabled = await api.setModelService({ client: 'claude', enabled: false });
    if (claudeDisabled.claude || claudeDisabled.claudeStatus.status !== 'disabled') {
      throw new Error('Claude 兼容服务 service did not restore the original config');
    }
    const resumedAfterTrace = await api.getCodexEnhancements();
    if (resumedAfterTrace.historyRestorePending) throw new Error('queued ChatGPT history restore did not finish after Trace stopped');
    if (!resumedAfterTrace.preserveOfficialLogin || resumedAfterTrace.authMode !== 'chatgpt') {
      throw new Error('兼容服务/Trace lifecycle changed ChatGPT auth.json');
    }

    if (!preserveTrace) await api.clearHistory();
    const afterClear = await api.getTraceStats();
    await api.setManagerView('settings');
    await api.setManagerView('home');
    const maximize = await api.toggleMaximize();
    await api.toggleMaximize();
    const updateBefore = await api.getUpdateState();
    let updateAfter = await api.checkForUpdates();
    if (updateAfter.status === 'error') throw new Error('update check failed: ' + (updateAfter.error || 'unknown'));
    if (updateAfter.installMode === 'manual-dmg') {
      if (updateAfter.status !== 'available' || !updateAfter.targetVersion) {
        throw new Error('macOS manual update did not become available');
      }
      updateAfter = await api.downloadUpdate();
      if (updateAfter.status !== 'ready' || updateAfter.percent !== 100) {
        throw new Error('macOS manual update DMG was not downloaded and verified');
      }
    }

    return {
      ok: true,
      appVersion: updateBefore.currentVersion,
      updateChannel: updateBefore.channel,
      updateInstallMode: updateBefore.installMode,
      updateStatus: updateAfter.status,
      ipcMethods: required.length,
      traceCapture,
      ui: {
        clearRowHeight: clearRowRect.height,
        faviconSize,
        appearanceRightDelta,
        appearanceDividerWidth,
        appearanceSectionTitleSize,
        appearanceOptionLabelSize,
        clearIconSize: clearIconRect.width,
        clearIconOffset,
        clearIconVerticalOffset,
        clearIconFill: getComputedStyle(clearIconSvg).fill,
        startupRestored: startupInitiallyEnabled,
        startupToggleSkipped: skipStartupToggle,
        themePersisted: themeExpected,
        themeRestored: themeBefore,
        initialViewport,
        fieldPausedOffPage: true,
        fieldRenderer: fieldCanvas.dataset.renderer,
      },
      clients: active.clients.map(item => ({ id: item.id, status: item.status })),
      codexEnhancements: { migrated: enhancementsOn.history, restored: enhancementsOff.history },
      stats: { beforeTokens: stats.total.tokens, afterClearTokens: afterClear.total.tokens },
      window: maximize
    };
    } catch (smokeError) {
      // Return the real assertion instead of letting executeJavaScript collapse
      // it into a generic "Script failed to execute" message.
      return {
        __smokeError: String(smokeError && smokeError.message ? smokeError.message : smokeError),
        __smokeStack: smokeError && smokeError.stack ? String(smokeError.stack) : undefined
      };
    }
  })()`);
  };

  let result: Record<string, unknown>;
  try {
    result = await runScript() as Record<string, unknown>;
  } catch (boundaryError) {
    // executeJavaScript() rejected before (or around) the injected try/catch —
    // e.g. an unhandled rejection Electron reports only as "Script failed to
    // execute". Surface the captured renderer console so the real cause shows.
    const base = boundaryError instanceof Error ? boundaryError.message : String(boundaryError);
    const detail = consoleLog.length ? `\n--- renderer console ---\n${consoleLog.join('\n')}` : ' (renderer console was empty)';
    throw new Error(`packaged renderer smoke failed at executeJavaScript boundary: ${base}${detail}`);
  } finally {
    managerWindow.webContents.off('console-message', onConsole as never);
  }
  if (result && typeof result.__smokeError === 'string') {
    const detail = [
      result.__smokeError,
      result.__smokeStack ? `\n${result.__smokeStack}` : '',
      consoleLog.length ? `\n--- renderer console ---\n${consoleLog.join('\n')}` : ''
    ].join('');
    throw new Error(`packaged renderer smoke failed: ${detail}`);
  }
  const restoredStateDb = new Database(stateDbPath, { readonly: true });
  try {
    const row = restoredStateDb.prepare("SELECT model_provider FROM threads WHERE id = 'packaged-official'").get() as { model_provider?: unknown } | undefined;
    if (row?.model_provider !== 'openai') throw new Error('packaged ChatGPT SQLite history was not restored');
  } finally {
    restoredStateDb.close();
  }
  return result;
}
