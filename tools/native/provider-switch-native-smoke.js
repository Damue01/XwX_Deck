(async () => {
  const checks = [], turns = [];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const invoke = (method, ...args) => window.__TAURI__.core.invoke('pilot_rpc', { method, args });
  const wait = async (test, label) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await test()) return;
      await delay(100);
    }
    throw Error('Timed out: ' + label);
  };
  const check = (label, value) => { if (!value) throw Error(label); checks.push(label); };
  const closeAndRestore = async tracing => {
    for (const action of ['application button', 'native system close']) {
      if (action === 'application button') await window.xwxDeck.closeWindow();
      else await invoke('smokeManagerWindow', 'close');
      await wait(async () => !(await invoke('smokeManagerWindow')).visible, action + ' hides the manager');
      check(action + ' preserves the process and Trace ' + (tracing ? 'on' : 'off'),
        (await window.xwxDeck.getState()).tracingEnabled === tracing && !document.querySelector('[role=alertdialog]'));
      await invoke('smokeManagerWindow', 'show');
      await wait(async () => (await invoke('smokeManagerWindow')).visible, 'restore the same manager');
    }
  };
  const selectModel = async (client, model) => {
    const selector = client === 'codex' ? '[data-codex-model]' : '[data-claude-model="sonnet"]';
    await wait(() => document.querySelector(selector + ' button')?.disabled === false, client + ' model control');
    if (document.querySelector(selector).dataset.value === model) return;
    document.querySelector(selector + ' button').click();
    await wait(() => [...document.querySelectorAll('.model-choice-positioner [role=option]')].some(option => option.textContent.includes(model)), model + ' catalog option');
    [...document.querySelectorAll('.model-choice-positioner [role=option]')].find(option => option.textContent.includes(model)).click();
    await wait(() => document.querySelector(selector)?.dataset.value === model && !document.querySelector(selector + ' button').disabled, model + ' saved');
    await wait(() => document.querySelector(selector + ' button')?.getAttribute('aria-expanded') === 'false', 'model popup closed');
  };
  try {
    if ((await invoke('smokeContext')).physical) return;
    await wait(() => window.xwxDeck && document.querySelector('#captureBtn'), 'native production renderer');
    document.querySelector('#onboarding-setup .tour-skip')?.click();
    await wait(() => !document.querySelector('#onboarding-setup'), 'onboarding dismissed');
    document.querySelector('.rail [data-page="models"]').click();
    check('native page identity', document.title === 'XwX Deck' && document.body.dataset.runtime === 'desktop');
    await closeAndRestore(false);
    document.querySelector('#captureBtn').click();
    await wait(async () => (await window.xwxDeck.getState()).tracingEnabled, 'Trace started from UI');
    await closeAndRestore(true);
    for (const client of ['codex', 'claude']) {
      document.querySelector(`[data-client-tab="${client}"]`)?.click();
      await wait(() => document.querySelector(`[data-client-tab="${client}"]`)?.getAttribute("aria-selected") === "true", client + " selected panel");
      const label = client === 'codex' ? 'ChatGPT' : 'Claude';
      for (const expected of ['a', 'b', 'a']) {
        const name = expected === 'b' ? 'ChatGPT 官方登录' : client === 'claude' ? 'UI DeepSeek Claude A' : 'UI DeepSeek A';
        await wait(() => document.querySelector(`button[aria-label="${label} 使用的模型服务"]`)?.disabled === false, client + ' provider control');
        const picker = document.querySelector(`button[aria-label="${label} 使用的模型服务"]`);
        if (picker.textContent.trim() !== name) {
          picker.click();
          await wait(() => [...document.querySelectorAll('.xwx-combobox-popup [role=option]')].some(option => option.textContent.trim() === name && option.getBoundingClientRect().height > 0), name + ' option');
          [...document.querySelectorAll('.xwx-combobox-popup [role=option]')].find(option => option.textContent.trim() === name && option.getBoundingClientRect().height > 0).click();
          await wait(() => document.querySelector(`button[aria-label="${label} 使用的模型服务"]`)?.textContent.trim() === name, name + ' selected');
          await wait(() => picker.getAttribute('aria-expanded') === 'false', 'provider popup closed');
        }
        await selectModel(client, 'fixture-' + expected);
        const turn = await invoke('smokeClientRequest', client, expected);
        turns.push(turn);
        check(client + ' UI switch ' + expected + ' reaches the selected service with retained history', turn.passed);
      }
    }
    await wait(async () => (await window.xwxDeck.getState()).activeRequests === 0, 'all replies complete');
    document.querySelector('#captureBtn').click();
    await wait(async () => !(await window.xwxDeck.getState()).tracingEnabled, 'Trace stopped from UI');
    for (const client of ['codex', 'claude']) {
      const turn = await invoke('smokeClientRequest', client, 'a');
      turns.push(turn);
      check(client + ' same session continues directly after UI stops Trace', turn.passed);
    }
    check('native renderer has no errors', !window.__pilotErrors?.length && !document.querySelector('vite-error-overlay'));
    await window.__TAURI__.core.invoke('pilot_smoke_report', { report: { passed: true, checks, turns, rendererErrors: window.__pilotErrors ?? [] } });
  } catch (error) {
    await window.__TAURI__.core.invoke('pilot_smoke_report', { report: { passed: false, checks, turns, error: String(error), text: document.body.innerText.slice(-3000), rendererErrors: window.__pilotErrors ?? [] } });
  }
})();
