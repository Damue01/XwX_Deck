(async()=>{
  const checks=[];
  const check=(name,condition)=>{if(!condition)throw Error(name);checks.push(name);};
  const wait=async(test,label)=>{await window.__TAURI__.core.invoke('pilot_smoke_progress',{checks,pending:label});for(let i=0;i<200;i++){if(await test())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('timeout '+label);};
  const report=async(passed,error)=>window.__TAURI__.core.invoke('pilot_smoke_report',{report:{passed,error,checks,nativeWebView:true,fullReset:true,persistentStore:true,isolatedFixtures:true}});
  const database=()=>new Promise((resolve,reject)=>{const request=indexedDB.open('xwx-deck-reset-synthetic',1);request.onupgradeneeded=()=>request.result.createObjectStore('fixture');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  const value=async(write)=>{const db=await database();try{return await new Promise((resolve,reject)=>{const tx=db.transaction('fixture',write?'readwrite':'readonly');const request=write?tx.objectStore('fixture').put('synthetic','value'):tx.objectStore('fixture').get('value');let result;request.onsuccess=()=>{result=request.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);});}finally{db.close();}};
  try{
    await wait(()=>window.xwxDeck&&document.querySelector('#captureBtn'),'application boot');
    // A fresh root (including the post-reset process) opens onboarding. Do not
    // drive settings and confirmation dialogs underneath that modal overlay.
    await wait(()=>document.querySelector('#onboarding-setup .tour-skip'),'fresh onboarding');
    document.querySelector('#onboarding-setup .tour-skip').click();
    await wait(()=>!document.querySelector('#onboarding-setup')&&!document.querySelector('.tour-root'),'dismiss onboarding');
    check('reset verification dismisses onboarding before interacting with the underlying application',true);
    await window.__TAURI__.core.invoke('pilot_smoke_progress',{checks,pending:'read reset state'});
    const reset=await window.xwxDeck.getApplicationResetResult();
    if(reset){
      await wait(()=>document.querySelector('[role="alertdialog"]')?.textContent.includes(reset.backupPath),'designed reset result');
      const resultDialog=document.querySelector('[role="alertdialog"]');
      check('reset result uses the shared designed dialog with a backup continuation',resultDialog.textContent.includes(reset.backupPath)&&resultDialog.querySelectorAll('button').length===2);
      [...resultDialog.querySelectorAll('button')].find(button=>['继续','Continue'].includes(button.textContent.trim())).click();
      await wait(()=>!document.querySelector('[role="alertdialog"]'),'dismiss reset result');
      await wait(async()=>(await window.xwxDeck.getApplicationResetResult()).noticeSeen===true,'reset notice acknowledged');
      check('independent worker completed reset and relaunched the same native executable',reset.status==='completed'&&reset.backupPath&&reset.skippedClientFiles.length===0);
      check('full reset clears an unknown localStorage key across a real process restart',localStorage.getItem('xwx-deck.synthetic.reset')===null);
      check('full reset clears IndexedDB rather than treating it as network cache',await value(false)===undefined);
      const fresh=await window.xwxDeck.getProviders();
      check('reset restores empty public providers and 1 GB cleanup',fresh.connections.length===0&&fresh.selected.codex===null&&fresh.selected.claude===null&&(await window.xwxDeck.getState()).traceWarningGB===1);
      document.querySelector('.rail [data-page="models"]').click();await wait(()=>document.querySelector('#page-models').classList.contains('current'),'public models after reset');
      check('reset leaves no default model service or excluded navigation', !document.querySelector('[data-page=tools],[data-page=sync]') && (await window.xwxDeck.getProviders()).connections.length===0);
      document.querySelector('.rail [data-page="settings"]').click();await wait(()=>document.querySelector('#page-settings').classList.contains('current'),'settings after reset');
      check('restarted WebView navigation remains usable',!window.__pilotErrors?.length);
      await report(true);return;
    }
    check('fresh public reset fixture starts with no connection',(await window.xwxDeck.getProviders()).connections.length===0);
    await window.__TAURI__.core.invoke('pilot_smoke_progress',{checks,pending:'save synthetic reset fixture'});
    await window.xwxDeck.saveProvider({id:'webview-reset-fixture',displayName:'Fixture_ac0aeb60',baseUrl:'http://127.0.0.1:9/v1',bearerToken:'SYNTHETIC-WEBVIEW-RESET',adapter:'responses',codexModel:'preserve-in-backup'});
    await window.__TAURI__.core.invoke('pilot_smoke_progress',{checks,pending:'write persistent browser fixtures'});
    localStorage.setItem('xwx-deck.synthetic.reset','synthetic');await value(true);
    check('persistent WebView fixture writes localStorage and IndexedDB',localStorage.getItem('xwx-deck.synthetic.reset')==='synthetic'&&await value(false)==='synthetic');
    document.querySelector('.rail [data-page="settings"]').click();await wait(()=>document.querySelector('#page-settings').classList.contains('current'),'settings');
    await wait(()=>document.querySelector('#repairCenterTrigger'),'repair entry');document.querySelector('#repairCenterTrigger').click();
    await wait(()=>document.querySelector('#repair-center-sheet')||document.querySelector('#resetApplication'),'repair panel');document.querySelector('#resetApplication').click();
    await wait(()=>document.querySelector('[role="alertdialog"]'),'reset confirmation');
    let dialog=document.querySelector('[role="alertdialog"]');
    check('reset confirmation describes data and client impact',dialog.textContent.includes('Trace 记录')&&dialog.textContent.includes('Skills、Agents'));
    check('reset confirmation states archive storage and automatic restart',dialog.textContent.includes('归档备份')&&dialog.textContent.includes('仍占用磁盘空间')&&dialog.textContent.includes('重新启动应用'));
    const checkbox=dialog.querySelector('[role="checkbox"],input[type="checkbox"]');check('core client deletion is opt-in',checkbox&&(checkbox.getAttribute('aria-checked')==='false'||checkbox.checked===false));
    [...dialog.querySelectorAll('button')].find(button=>button.textContent.trim()==='取消').click();
    await wait(()=>!document.querySelector('[role="alertdialog"]'),'cancel confirmation');
    check('cancelling keeps service and browser data',(await window.xwxDeck.getProviders()).connections.length===1&&localStorage.getItem('xwx-deck.synthetic.reset')==='synthetic');
    document.querySelector('#repairCenterTrigger').click();await wait(()=>document.querySelector('#resetApplication'),'reopen repair panel');
    document.querySelector('#resetApplication').click();await wait(()=>document.querySelector('[role="alertdialog"]'),'reopen confirmation');
    dialog=document.querySelector('[role="alertdialog"]');
    await window.__TAURI__.core.invoke('pilot_smoke_progress',{checks,pending:'confirmed reset and native relaunch'});
    [...dialog.querySelectorAll('button')].find(button=>button.textContent.trim()==='重置').click();
    // Success exits this process. A preflight error must be reported instead
    // of being mistaken for a successful restart by the external controller.
    await new Promise(resolve=>setTimeout(resolve,12000));throw Error('confirmed reset did not exit: '+document.body.textContent.slice(-2500));
  }catch(error){await report(false,String(error));}
})();
