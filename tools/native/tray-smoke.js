(async () => {
  const checks=[],rpc=(method,...args)=>window.__TAURI__.core.invoke('pilot_rpc',{method,args});
  const wait=async(test,label)=>{for(let i=0;i<160;i++){if(await test())return;await new Promise(r=>setTimeout(r,50));}throw Error(label);};
  const check=(label,value)=>{if(!value)throw Error(label);checks.push(label);};
  const open=async()=>{await rpc('smokeTrayWindow','open');await wait(async()=>(await rpc('smokeTrayWindow'))?.visible,'tray opens');};
  const inspect=async()=>{await rpc('smokeTrayWindow','inspect');await wait(async()=>!!(await rpc('smokeTrayReport'))?.items,'popup paints');return rpc('smokeTrayReport');};
  try{
    await wait(()=>document.querySelector('.tour-skip'),'onboarding');document.querySelector('.tour-skip').click();
    await wait(()=>!document.querySelector('#onboarding-setup,.tour-root'),'onboarding releases manager');
    await window.xwxDeck.closeWindow();
    await wait(async()=>!(await rpc('smokeManagerWindow')).visible,'idle manager hidden by Close button');
    check('idle Close hides the manager without confirmation, exit or Trace activation',!document.querySelector('[role=alertdialog]') && !(await window.xwxDeck.getState()).tracingEnabled);
    await rpc('smokeManagerWindow','show');
    await rpc('smokeManagerWindow','close');
    await wait(async()=>!(await rpc('smokeManagerWindow')).visible,'idle manager hidden');
    check('native system Close also hides the idle manager without confirmation',!document.querySelector('[role=alertdialog]'));
    await rpc('smokeManagerWindow','show');
    await open();let view=await inspect();
    check('Windows tray uses exactly two application-rendered menu items',view.items.map(x=>x.label).join('|')==='开启 Trace|退出'&&!view.managerMounted);
    check('tray menu shares the application font and menu surface',view.font.includes('Urbanist')&&view.background==='rgb(255, 255, 255)');
    check('tray opens without an extra background or initial item highlight',view.menuFocused&&view.itemBackgrounds.every(color=>color==='rgba(0, 0, 0, 0)'));
    check('tray item boxes fit the native viewport and receive pointer input',view.items.every(x=>x.hit&&x.rect.x>=0&&x.rect.y>=0&&x.rect.right<=view.viewport.width&&x.rect.bottom<=view.viewport.height));
    check('tray receives only runtime state and presentation preferences',view.stateKeys.join('|')==='busy|enabled|language|theme');
    await rpc('smokeTrayWindow','deny');await wait(async()=>(await rpc('smokeTrayReport'))?.denied,'restricted tray caller');
    check('tray WebView cannot read provider configuration through the main RPC',true);
    await rpc('smokeTrayWindow','down');view=await inspect();check('ArrowDown first focuses Trace without a filled background',view.focused==='开启 Trace'&&view.itemBackgrounds.every(color=>color==='rgba(0, 0, 0, 0)'));
    await rpc('smokeTrayWindow','down');view=await inspect();check('ArrowDown moves keyboard focus to Exit',view.focused==='退出');
    await rpc('smokeTrayWindow','escape');await wait(async()=>!(await rpc('smokeTrayWindow'))?.visible,'Escape hides tray');check('Escape dismisses the custom tray window',true);
    await open();await rpc('smokeTrayWindow','blur');await wait(async()=>!(await rpc('smokeTrayWindow'))?.visible,'focus loss hides tray');check('focus loss dismisses the custom tray window',true);
    await window.xwxDeck.setTheme('night');await open();view=await inspect();check('tray follows the saved night theme',view.theme==='night'&&view.background==='rgb(26, 28, 31)');
    await rpc('smokeTrayWindow','hide');await window.xwxDeck.setTheme('day');await window.xwxDeck.setLanguage('en');await open();view=await inspect();
    check('tray follows the saved language',view.language==='en'&&view.items.map(x=>x.label).join('|')==='Start Trace|Exit');
    await rpc('smokeTrayWindow','hide');await window.xwxDeck.setLanguage('zh-CN');await open();
    await rpc('smokeTrayWindow','click-trace');await wait(async()=>(await window.xwxDeck.getState()).tracingEnabled,'tray starts Trace');
    check('custom tray Start dispatches the actual native Trace transition',true);
    await wait(async()=>!(await rpc('smokeTrayWindow'))?.visible,'tray action dismisses popup');check('selecting an action dismisses the tray menu',true);
    await window.xwxDeck.closeWindow();
    await wait(async()=>!(await rpc('smokeManagerWindow')).visible,'active manager hidden');
    check('Close with Trace on hides the manager without confirmation or stopping its Gateway',!document.querySelector('[role=alertdialog]') && (await window.xwxDeck.getState()).tracingEnabled);
    await rpc('smokeManagerWindow','show');
    const response=await rpc('smokeRequest');check('tray-started Gateway completes an actual local request after closing and restoring its manager',response.status===200);
    await open();view=await inspect();check('reopening changes Start to Stop from actual runtime state',view.items[0].label==='关闭 Trace');
    await rpc('smokeTrayWindow','click-exit');await wait(()=>document.querySelector('[role=alertdialog]')?.textContent.includes('恢复直连并退出'),'custom exit confirmation');
    check('tray Exit uses the application confirmation while Trace is active',true);
    [...document.querySelectorAll('[role=alertdialog] button')].find(b=>b.textContent==='继续运行').click();await wait(()=>!document.querySelector('[role=alertdialog]'),'exit cancelled');
    const afterCancel=await rpc('smokeRequest');check('cancelled tray Exit retains the running Gateway and actual requests',afterCancel.status===200&&(await window.xwxDeck.getState()).tracingEnabled);
    await open();await rpc('smokeTrayWindow','click-trace');await wait(async()=>!(await window.xwxDeck.getState()).tracingEnabled,'tray stops Trace');
    check('custom tray Stop restores the actual direct client route',(await window.xwxDeck.getCodexConfig()).activeBaseUrl===(await rpc('smokeContext')).upstream);
    await open();view=await inspect();check('stopping changes the next menu back to Start',view.items[0].label==='开启 Trace');
    await rpc('smokeTrayWindow','stale-stop');await new Promise(r=>setTimeout(r,100));check('a stale explicit Stop cannot restart Trace',!(await window.xwxDeck.getState()).tracingEnabled);
    check('main renderer remains healthy',window.__pilotErrors.length===0);
    if((await rpc('smokeContext')).physical){
      const entry=document.createElement('button');entry.textContent='打开托盘菜单（隔离验收）';entry.id='tray-acceptance-open';entry.style='position:fixed;left:210px;bottom:12px;z-index:10001;padding:8px;background:var(--surface);color:var(--ink);border:1px solid var(--control-border);border-radius:8px';entry.onclick=()=>void open();document.body.append(entry);
    }
    await window.__TAURI__.core.invoke('pilot_smoke_report',{report:{suite:'windows-tray-menu',passed:true,checks,nativeWebView:true,isolatedFixtures:true,errors:window.__pilotErrors}});
  }catch(error){await window.xwxDeck.toggleTracing(false).catch(()=>{});await rpc('smokeTrayWindow','hide').catch(()=>{});await window.__TAURI__.core.invoke('pilot_smoke_report',{report:{suite:'windows-tray-menu',passed:false,checks,error:String(error),errors:window.__pilotErrors}});}
})();
