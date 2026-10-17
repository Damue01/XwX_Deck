(async () => {
  const checks = [];
  const wait = async (test, label) => { for (let i = 0; i < 120; i++) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error(label); };
  const check = (label, value) => { if (!value) throw Error(label); checks.push(label); };
  const rpc = (method, ...args) => window.__TAURI__.core.invoke('pilot_rpc', { method, args });
  try {
    await wait(() => document.querySelector('.tour-skip'), 'fresh onboarding');
    document.querySelector('.tour-skip').click();
    await wait(() => !document.querySelector('.tour-root'), 'skip onboarding');
    document.querySelector('[data-page="signal"]').click();
    await wait(() => document.querySelector('#signalWrap canvas[data-rendering="active"][data-renderer="2d"]'), 'fresh classic canvas starts');
    const pixels = () => { const canvas = document.querySelector('#signalWrap canvas'); const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; let sum = 0; for (let i = 3; i < data.length; i += 4) sum += data[i]; return sum; };
    await wait(() => pixels() > 1000, 'first classic frame is drawn'); const before = pixels();
    await wait(() => pixels() !== before, 'classic animates after first launch');
    check('first launch classic background paints and animates after onboarding', true);
    const storage = await window.xwxDeck.getState();
    document.querySelector('[data-page="settings"]').click();
    await wait(() => document.querySelector('.trace-storage-inline-reading'), 'storage settings render');
    if (document.querySelector('#trace-settings-content').hidden) document.querySelector('.trace-section-trigger').click();
    const reading = document.querySelector('.trace-storage-inline-reading > span').textContent.replace(/ \/$/, '');
    check('settings capacity agrees with native automatic byte units', reading === storage.storageText && (storage.traceStorageBytes < 1024 || !reading.endsWith(' B')));
    document.querySelector('[data-page="signal"]').click();
    document.querySelector('#appearanceTriggerIdle').click();
    await wait(() => document.querySelector('#appearanceDrawer.open'), 'appearance opens');
    check('day/night controls live inside Trace appearance', !document.querySelector('#page-settings #themeToggle') && document.querySelector('#appearanceDrawer #systemThemeToggle'));
    check('appearance order is skin, day/night, page modules', [...document.querySelectorAll('#appearanceDrawer h3')].map(node => node.id).join(',') === 'skinTitle,themeTitle,modulesTitle');
    document.querySelector('#themeToggle').click();
    await wait(async () => (await window.xwxDeck.getState()).theme === 'night', 'night saved');
    await wait(() => document.documentElement.dataset.theme === 'night', 'night painted');
    check('native titlebar uses dark appearance', (await rpc('smokeWindowThemes')).main === 'night');
    await window.xwxDeck.openDashboard();
    await wait(async () => (await rpc('smokeViewerReport'))?.themes?.includes('night'), 'dashboard opens dark');
    check('dashboard opens using the selected night mode', true);
    document.querySelector('#themeToggle').click();
    await wait(async () => (await window.xwxDeck.getState()).theme === 'day', 'day saved');
    await wait(async () => (await rpc('smokeViewerReport'))?.themes?.includes('day'), 'open dashboard follows day');
    check('main and dashboard native titlebars switch to day', Object.values(await rpc('smokeWindowThemes')).every(theme => theme === 'day'));
    document.querySelector('#systemThemeToggle').click();
    await wait(async () => (await window.xwxDeck.getState()).theme === 'system', 'system saved');
    await wait(async () => (await rpc('smokeViewerReport'))?.themes?.includes('system'), 'dashboard follows system preference');
    const resolved = document.documentElement.dataset.theme;
    check('system preference and resolved native appearance stay consistent', localStorage.getItem('xwx-deck.theme') === 'system' && Object.values(await rpc('smokeWindowThemes')).every(theme => theme === resolved));
    check('no native renderer errors', window.__pilotErrors.length === 0);
    await rpc('smokeCloseViewer');
    await window.__TAURI__.core.invoke('pilot_smoke_report', { report: { passed: true, checks, resolved, errors: window.__pilotErrors, nativeWebView: true, isolatedFixtures: true } });
  } catch (error) {
    await window.__TAURI__.core.invoke('pilot_smoke_report', { report: { passed: false, checks, error: String(error), errors: window.__pilotErrors, nativeWebView: true, isolatedFixtures: true } });
  }
})();
