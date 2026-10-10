(async () => {
  const checks = [];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (test, label) => {
    const deadline=performance.now()+15000;
    while(performance.now()<deadline) { if (await test()) return; await delay(100); }
    throw Error('Timed out: ' + label);
  };
  const check = (label, value) => { if (!value) throw Error(label); checks.push(label); };
  const invoke = (method, ...args) => window.__TAURI__.core.invoke('pilot_rpc', {method,args});
  try {
    await wait(() => window.xwxDeck && document.querySelector('[data-page="models"]'), 'production renderer');
    await delay(300);
    document.querySelector('#onboarding-setup .tour-skip')?.click();
    await wait(() => !document.querySelector('#onboarding-setup, .tour-root'), 'initial onboarding dismissed');
    const api = window.xwxDeck;
    if (!localStorage.getItem('xwx-universal-ui-seeded')) {
      const context = await invoke('smokeContext');
      for (const name of ['native-one','native-two']) await api.saveProvider({id:name,displayName:name,baseUrl:context.upstream,bearerToken:'fixture-key',adapter:'responses',codexModel:'gpt-4.1'});
      for (const client of ['opencode','cline','cherry-studio','goose']) {
        const route = await api.getClientRoute(client);
        await api.setClientRoute({client,providerId:'native-one',model:'gpt-4.1',configDigest:route.configDigest,takeoverConfirmed:true});
      }
      await api.addModelClient('opencode');
      localStorage.setItem('xwx-deck.onboardingSeen','true');
      localStorage.setItem('xwx-universal-ui-seeded','true');
      location.reload(); return;
    }
    check('native production renderer and bridge', document.title === 'XwX Deck' && document.body.dataset.runtime === 'desktop');
    document.querySelector('[data-page="models"]').click();
    await wait(() => document.querySelector('[data-client-tab="opencode"]'), 'OpenCode tab');
    document.querySelector('[data-client-tab="opencode"]').click();
    const picker = () => document.querySelector('button[aria-label="OpenCode 使用的模型服务"]');
    await wait(() => picker()?.textContent.includes('native-one'), 'saved provider');
    check('only the selected client panel is visible', document.querySelector('#client-panel-opencode').getBoundingClientRect().height > 0 && document.querySelector('#client-panel-claude').hidden && document.querySelector('#client-panel-codex').hidden);
    picker().click(); await wait(() => document.querySelector('[role="listbox"]'), 'provider menu');
    check('provider selection uses the shared menu without search', !document.querySelector('[role="listbox"] input'));
    [...document.querySelectorAll('[role="option"]')].find(option => option.textContent.includes('native-two')).click();
    await wait(async () => (await api.getClientRoute('opencode')).providerId === 'native-two', 'provider saved');
    check('provider switch is independent', (await api.getClientRoute('cline')).providerId === 'native-one' && (await api.getProviders()).selected.codex === null);
    document.querySelector('.models-manage-clients').click();
    await wait(() => document.querySelector('#add-configuration-dialog'), 'manager opened');
    await delay(300);
    document.querySelector('#add-configuration-dialog button.configuration-close[aria-label^="关闭"]').click();
    await wait(() => !document.querySelector('#add-configuration-dialog'), 'manager closed');
    check('closing the manager releases the modal', !document.querySelector('.setup-card-backdrop'));
    document.querySelector('[data-page="signal"]').click(); document.querySelector('#captureBtn').click();
    await wait(async () => (await api.getState()).tracingEnabled && document.querySelector('[data-client="opencode-live"]'), 'Trace started');
    await delay(400);
    const bounds = document.querySelector('#stopCaptureBtn').getBoundingClientRect();
    check('six capture sources do not clip the controls', bounds.right <= innerWidth && bounds.left >= 0 && document.querySelectorAll('#liveBoard .src-t').length === 6);
    const response = await invoke('smokeRequest', {client:'opencode'});
    check('native client request returns converted Chat text', response.status === 200 && response.body.includes('fixture reply') && response.body.includes('[DONE]'));
    const stats = await api.getTraceStats();
    check('actual upstream usage and cached pricing are unchanged', stats.total.tokens === 20 && Math.abs(stats.total.costUsd - .000076) < 1e-12);
    await wait(() => document.querySelector('#chartNow')?.textContent.includes('20 tokens'), 'latest request counter');
    const chartRange = () => {
      const chart = document.querySelector('#throughputChart');
      return [chart.dataset.requestCount, chart.dataset.rangeStart, chart.dataset.rangeEnd].join(':');
    };
    const beforeIdle = chartRange();
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + 5 * 60 * 1000;
      await delay(500);
      check('idle time preserves the latest request and retained chart range', document.querySelector('#chartNow').textContent.includes('20 tokens') && Number(document.querySelector('#throughputChart').dataset.requestCount) > 0 && chartRange() === beforeIdle);
    } finally { Date.now = originalNow; }
    document.querySelector('[data-client="opencode-live"]').click();
    await wait(async () => !(await api.getClientRoute('opencode')).enabled, 'source paused');
    check('pausing one source preserves other routes', (await api.getClientRoute('cline')).enabled && (await api.getState()).tracingEnabled);
    await api.toggleTracing(false);
    document.querySelector('[data-page="models"]').click();
    document.querySelector('.models-manage-clients').click();
    await wait(()=>document.querySelector('[data-client-download="oh-my-pi"]'),'independent CLI in manager');
    document.querySelector('[data-client-download="oh-my-pi"]').click();
    await wait(()=>[...document.querySelectorAll('.configuration-client-actions button')].some(button=>button.textContent==='添加到模型页'&&!button.disabled),'manual CLI can be added');
    [...document.querySelectorAll('.configuration-client-actions button')].find(button=>button.textContent==='添加到模型页').click();
    await wait(()=>!document.querySelector('#add-configuration-dialog')&&document.querySelector('[data-client-tab="oh-my-pi"][aria-selected="true"]'),'new CLI tab selected');
    await wait(()=>document.querySelector('#client-panel-oh-my-pi .gateway-client-connection'),'manual connection settings');
    check('manual CLI has an independent model panel and does not claim automatic configuration',(await api.getClientRoute('oh-my-pi')).automatic===false&&!!document.querySelector('[data-client-tab="opencode"]')&&!!document.querySelector('button[aria-label="oh-my-pi 使用的模型服务"]'));
    check('no framework overlay or console errors', !document.querySelector('vite-error-overlay') && window.__pilotErrors.length === 0);
    await window.__TAURI__.core.invoke('pilot_smoke_report', {report:{passed:true,checks,viewport:{width:innerWidth,height:innerHeight},errors:window.__pilotErrors,userAgent:navigator.userAgent}});
  } catch(error) {
    const diagnostic={visibility:document.visibilityState,latestRequest:document.querySelector('#chartNow')?.textContent};
    await invoke('toggleTracing',false).catch(() => undefined);
    await window.__TAURI__.core.invoke('pilot_smoke_report', {report:{passed:false,checks,error:String(error),errors:window.__pilotErrors,...diagnostic,dialogs:[...document.querySelectorAll('[role="dialog"]')].map(node=>({id:node.id,attributes:[...node.attributes].map(a=>[a.name,a.value]),closeButtons:[...node.querySelectorAll('button.configuration-close')].map(b=>({label:b.getAttribute('aria-label'),disabled:b.disabled}))})),popups:document.querySelectorAll('[role="listbox"]').length}});
  }
})();
