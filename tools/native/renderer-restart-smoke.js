(async () => {
  const checks = [];
  const check = (name, result) => { if (!result) throw Error(name); checks.push(name); };
  const wait = async test => { for (let n=0;n<150;n++) { if (test()) return; await new Promise(r=>setTimeout(r,100)); } throw Error('persistent WebView timeout'); };
  const stage = window.__nativeRendererRestartStage;
  const database = () => new Promise((resolve, reject) => {
    const request = indexedDB.open('xwx-deck-synthetic-repair', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('fixture');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const storedValue = async (write) => {
    const db = await database();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('fixture', write ? 'readwrite' : 'readonly');
        const request = write ? tx.objectStore('fixture').put('synthetic-indexeddb-value', 'test') : tx.objectStore('fixture').get('test');
        let value; request.onsuccess = () => { value = request.result; };
        tx.oncomplete = () => resolve(value); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  };
  const storedCryptoKey = async (write) => {
    const db = await database();
    try {
      const key = write ? await crypto.subtle.generateKey({name:'AES-GCM',length:128},false,['encrypt','decrypt']) : null;
      return await new Promise((resolve,reject) => {
        const tx=db.transaction('fixture',write?'readwrite':'readonly');
        const request=write?tx.objectStore('fixture').put(key,'crypto-key'):tx.objectStore('fixture').get('crypto-key');
        let value;request.onsuccess=()=>{value=request.result;};
        tx.oncomplete=()=>resolve(write?key:value);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
      });
    } finally { db.close(); }
  };
  try {
    await wait(() => window.xwxDeck && document.querySelector('#captureBtn'));
    const boot = window.__nativeRendererPreferencesBoot;
    if (stage >= 5) {
      const providers = JSON.stringify(await window.xwxDeck.getProviders());
      if (stage === 5) {
        await wait(() => document.querySelector('.onboarding-panel[data-step="0"]'));
        document.querySelector('.onboarding-start').click();
        await wait(() => document.querySelector('.onboarding-panel[data-step="1"],.onboarding-panel[data-step="2"]'));
        if (document.querySelector('.onboarding-panel[data-step="1"]')) document.querySelector('.onboarding-foot .btn.primary').click();
        await wait(() => document.querySelector('.onboarding-panel[data-step="2"]'));
        check('actual welcome controls persist the import step before application exit', JSON.parse(localStorage.getItem('xwx-deck.onboardingProgress.v1')).setupStep === 2);
      } else if (stage === 6) {
        await wait(() => document.querySelector('.onboarding-panel[data-step="2"]'));
        check('full native process restart restores the import step without marking it complete', localStorage.getItem('xwx-deck.onboardingSeen') !== 'true');
        await wait(() => [...document.querySelectorAll('.configuration-import-actions .btn.primary')].some(b => !b.disabled));
        [...document.querySelectorAll('.configuration-import-actions .btn.primary')].find(b => !b.disabled).click();
        await wait(() => document.querySelector('.tour-root[data-tour-index="0"]'));
        document.querySelector('.tour-next').click();
        await wait(() => document.querySelector('.tour-root[data-tour-index="1"]'));
      } else if (stage === 7 || stage === 8) {
        await wait(() => document.querySelector('.tour-root[data-tour-index="1"]'));
        check('full native process restart restores the model walkthrough step', localStorage.getItem('xwx-deck.onboardingSeen') !== 'true');
        if (stage === 7) {
          window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}));
          await wait(() => !document.querySelector('.tour-root'));
          check('Escape suspends the guide and keeps its saved step', JSON.parse(localStorage.getItem('xwx-deck.onboardingProgress.v1')).index === 1 && localStorage.getItem('xwx-deck.onboardingSeen') !== 'true');
        } else {
          for (const index of [1, 2, 3]) {
            await wait(() => document.querySelector(`.tour-root[data-tour-index="${index}"]`));
            document.querySelector('.tour-next').click();
          }
          await wait(() => !document.querySelector('.tour-root'));
          check('explicit finish clears progress and records completion', localStorage.getItem('xwx-deck.onboardingSeen') === 'true' && localStorage.getItem('xwx-deck.onboardingProgress.v1') === null);
        }
      } else {
        check('finished guide stays dismissed after another native process restart', !document.querySelector('#onboarding-setup,.tour-root') && localStorage.getItem('xwx-deck.onboardingSeen') === 'true');
      }
      check('resuming the guide never changes providers or activates Trace', JSON.stringify(await window.xwxDeck.getProviders()) === providers && !(await window.xwxDeck.getState()).tracingEnabled);
      await window.__TAURI__.core.invoke('pilot_smoke_report', {report:{passed:true,stage,checks,nativeWebView:true,persistentStore:true,isolatedFixtures:true}});
      return;
    }
    const modelsFoldKey = 'xwx-deck:settings:models:expanded:v1';
    const applicationFoldKey = 'xwx-deck:settings:application:expanded:v1';
    check('legacy migration marker survives or is set before React', localStorage.getItem('xwxdeck.rendererMigration.v1') === 'done');
    if(document.querySelector('#onboarding-setup .tour-skip')) { document.querySelector('#onboarding-setup .tour-skip').click();await wait(()=>!document.querySelector('#onboarding-setup')&&!document.querySelector('.tour-root')); }
    document.querySelector('.rail [data-page="settings"]').click();
    await wait(() => document.querySelector('#page-settings').classList.contains('current'));
    if (stage === 4) {
      const state = await window.xwxDeck.getState();
      check('corrupt wrapping key keeps the application usable and exposes explicit migration',state.webCryptoStorage?.status==='migration-required');
      let migrations=0;
      const migrate=window.xwxDeck.migrateWebCryptoKey;
      window.xwxDeck.migrateWebCryptoKey=async(...args)=>{migrations++;return migrate(...args);};
      const button=()=>[...document.querySelectorAll('#application-settings-content button')].find(b=>b.textContent==='迁移到本地');
      await wait(button);button().click();
      await wait(()=>document.querySelector('[role=alertdialog]'));
      [...document.querySelectorAll('[role=alertdialog] button')].find(b=>b.textContent==='取消').click();
      await wait(()=>!document.querySelector('[role=alertdialog]'));
      check('cancel migration never invokes credential recovery and keeps the action',migrations===0 && !!button());
      button().click();await wait(()=>document.querySelector('[role=alertdialog]'));
      [...document.querySelectorAll('[role=alertdialog] button')].find(b=>b.textContent==='迁移到本地').click();
      await wait(()=>migrations===1 && document.body.textContent.includes('网页登录密钥未迁移') && !!button() && !button().disabled);
      check('migration failure keeps the retry action and reports the concrete error',migrations===1 && document.body.textContent.includes('网页登录密钥未迁移'));
      let rejected=false;try { await storedCryptoKey(true); } catch { rejected=true; }
      check('unavailable private wrapping key rejects serialization through our delegate instead of Keychain fallback',rejected && (await window.xwxDeck.getState()).webCryptoStorage.keyRequests>0);
      await window.__TAURI__.core.invoke('pilot_smoke_report',{report:{passed:true,stage,checks,nativeWebView:true,persistentStore:true,isolatedFixtures:true}});
      return;
    }
    if (stage === 1) {
      check('fresh isolated persistent store imports original public sidebar and expansion', boot['xwx-deck.sidebar'] === 'collapsed' && boot[applicationFoldKey] === window.__nativeRendererPreferencesExpected[applicationFoldKey]);
      document.querySelector('#railToggle').click();
      await wait(() => document.body.dataset.sidebar !== 'collapsed');
      document.querySelector('[aria-controls="application-settings-content"]').click();
      await wait(() => !document.getElementById('application-settings-content').hidden);
      document.querySelector('.rail-btn[data-page="signal"]')?.click();
      await wait(() => document.querySelector('#page-signal.current'));
      document.querySelector('#appearanceTriggerIdle').click();
      document.querySelector('#themeToggle').click();
      await wait(() => document.documentElement.dataset.theme === 'night');
      document.querySelector('.appearance-close').click();
      document.querySelector('.rail [data-page="settings"]').click();
      await wait(()=>document.querySelector('#page-settings.current'));
      if(!document.getElementById('model-config-content').hidden)document.querySelector('[aria-controls="model-config-content"]').click();
      check('visible sidebar, expansion and theme controls save new choices', localStorage.getItem('xwx-deck.sidebar') === 'expanded' && localStorage.getItem('xwx-deck:settings:application:expanded:v1') === 'true' && (await window.xwxDeck.getState()).theme === 'night');
      localStorage.setItem('xwx-deck.synthetic.repair-preserved', 'synthetic-value');
      await storedValue(true);
      if ((await window.xwxDeck.getState()).webCryptoStorage) {
        await storedCryptoKey(true);
        check('nonextractable CryptoKey uses the private WebKit key delegate', (await window.xwxDeck.getState()).webCryptoStorage.keyRequests > 0);
      }
      const before = Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]));
      const repair = await window.xwxDeck.repairApplication();
      check('quick repair waits for native cache callback and retains every preference', repair.chromiumCacheCleared === true && JSON.stringify(before) === JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]))));
      check('quick repair retains IndexedDB data', await storedValue(false) === 'synthetic-indexeddb-value');
    } else {
      check('full process restart keeps sidebar and fold choices', boot['xwx-deck.sidebar'] === 'expanded' && boot['xwx-deck:settings:application:expanded:v1'] === 'true' && document.body.dataset.sidebar !== 'collapsed' && !document.getElementById('application-settings-content').hidden);
      await wait(() => document.documentElement.dataset.theme === 'night');
      check('native saved theme survives restart', (await window.xwxDeck.getState()).theme === 'night' && localStorage.getItem('xwx-deck.theme') === 'night');
      check('browser databases and unknown UI keys survive quick repair and full restart', await storedValue(false) === 'synthetic-indexeddb-value' && localStorage.getItem('xwx-deck.synthetic.repair-preserved') === 'synthetic-value');
      if ((await window.xwxDeck.getState()).webCryptoStorage) {
      const key = await storedCryptoKey(false);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode('private-webcrypto-restart'));
      const plaintext = await crypto.subtle.decrypt({name:'AES-GCM',iv},key,ciphertext);
      check('nonextractable CryptoKey decrypts after full process restart using the same private wrapping key',new TextDecoder().decode(plaintext)==='private-webcrypto-restart' && (await window.xwxDeck.getState()).webCryptoStorage?.keyRequests>0);
      }
      if (stage === 2) {
        check('old migration cannot overwrite the newer explicit model-section preference', boot[modelsFoldKey] === 'false' && document.getElementById('model-config-content').hidden);
        localStorage.removeItem(modelsFoldKey);
        // Let WebKit flush the deliberate removal before the full restart.
        await new Promise(resolve => setTimeout(resolve, 1200));
        check('deliberately removed expansion preference stays removed before shutdown',localStorage.getItem(modelsFoldKey)===null);
      } else {
        check('second restart does not reimport a deliberately removed public expansion preference', boot[modelsFoldKey] === null && localStorage.getItem(modelsFoldKey) === null && !document.getElementById('model-config-content').hidden);
      }
    }
    check('no native framework errors during restart acceptance', !window.__pilotErrors?.length);
    await window.__TAURI__.core.invoke('pilot_smoke_report', { report: { passed:true, stage, checks, nativeWebView:true, persistentStore:true, isolatedFixtures:true } });
  } catch (error) {
    await window.__TAURI__.core.invoke('pilot_smoke_report', { report: { passed:false, stage, checks, error:String(error), nativeWebView:true, persistentStore:true, isolatedFixtures:true } });
  }
})();
