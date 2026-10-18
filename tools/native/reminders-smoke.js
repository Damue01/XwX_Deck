(async()=>{
 const checks=[],rpc=(method,...args)=>window.__TAURI__.core.invoke('pilot_rpc',{method,args}),delay=ms=>new Promise(r=>setTimeout(r,ms));
 const wait=async(test,label)=>{for(let n=0;n<240;n++){if(await test())return;await delay(50);}throw Error(label);};
 const check=(label,value)=>{if(!value)throw Error(label);checks.push(label);};
 const dialog=()=>document.querySelector('[role=alertdialog]');
 const action=text=>[...dialog().querySelectorAll('button')].find(button=>button.textContent===text);
 const styled=()=>getComputedStyle(dialog()).fontFamily.includes('Urbanist')&&parseFloat(getComputedStyle(dialog()).borderRadius)>0;
 const running=async()=>{const state=await window.xwxDeck.getState();return state.tracingEnabled&&state.activeRequests>0;};
 try{
  await wait(()=>document.querySelector('.tour-skip'),'guide ready');document.querySelector('.tour-skip').click();await wait(()=>!document.querySelector('#onboarding-setup,.tour-root'),'guide closed');
  document.querySelector('#captureBtn').click();await wait(async()=>(await window.xwxDeck.getState()).tracingEnabled,'Trace enabled');
  const held=rpc('smokeRequest').catch(()=>null);await wait(running,'actual ongoing request');
  check('reminder fixture has an actual unfinished streamed request',await running());
  document.querySelector('#stopCaptureBtn').click();await wait(()=>dialog()?.textContent.includes('强制停止'),'busy stop confirmation');await delay(200);
  check('busy Trace stop uses the shared application confirmation',styled()&&!!action('继续等待')&&!!action('强制停止'));
  check('busy stop initially focuses the safe waiting action',document.activeElement===action('继续等待'));
  action('继续等待').click();await wait(()=>!dialog(),'stop cancelled');await delay(200);
  check('waiting preserves the actual request and running Gateway',await running());
  document.querySelector('#stopCaptureBtn').click();await wait(()=>dialog()?.textContent.includes('强制停止'),'busy stop reopened');action('强制停止').click();
  await wait(async()=>!(await window.xwxDeck.getState()).tracingEnabled,'force stop complete');await held;
  check('explicit force stop restores direct routing',(await window.xwxDeck.getCodexConfig()).activeBaseUrl===(await rpc('smokeContext')).upstream);
  await wait(()=>document.querySelector('#captureBtn')&&!document.querySelector('#captureBtn').disabled,'Trace can restart');document.querySelector('#captureBtn').click();await wait(async()=>(await window.xwxDeck.getState()).tracingEnabled,'Trace restarted');
  void rpc('smokeRequest').catch(()=>null);await wait(running,'second ongoing stream');
  await rpc('smokeRequestExit');await wait(()=>dialog()?.textContent.includes('恢复直连并退出'),'active exit confirmation');await delay(200);
  check('exit during an ongoing conversation uses the application dialog',styled()&&!!action('继续运行')&&!!action('恢复直连并退出'));
  check('exit confirmation warns that active requests may be interrupted',dialog().textContent.includes('尚未完成的请求可能中断'));
  action('继续运行').click();await wait(()=>!dialog(),'exit cancelled');check('cancelled exit keeps the same unfinished request and Gateway',await running());
  await rpc('smokeRequestExit');await wait(()=>dialog()?.textContent.includes('恢复直连并退出'),'final exit confirmation');await delay(200);
  check('repeated exit remains a single application confirmation',document.querySelectorAll('[role=alertdialog]').length===1);
  const rect=action('恢复直连并退出').getBoundingClientRect();check('exit action is visible and receives pointer input',rect.bottom<=innerHeight&&action('恢复直连并退出').contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)));
  check('renderer stays healthy through busy stop and exit',window.__pilotErrors.length===0);
  const report={suite:'windows-active-reminders',passed:true,checks,actualOngoingRequests:true,gatewayBase:(await window.xwxDeck.getState()).localBaseUrl};
  await window.__TAURI__.core.invoke('pilot_smoke_report',{report});
  if(!(await rpc('smokeContext')).physical)action('恢复直连并退出').click();
 }catch(error){await window.xwxDeck.toggleTracing(false,true).catch(()=>{});await window.__TAURI__.core.invoke('pilot_smoke_report',{report:{suite:'windows-active-reminders',passed:false,checks,error:String(error)}});}
})();
