(async () => {
  const rpc = (method,...args) => window.__TAURI__.core.invoke('pilot_rpc',{method,args});
  const report = value => window.__TAURI__.core.invoke('pilot_smoke_report',{report:value});
  try {
    for(let n=0;n<200 && !document.querySelector('[data-page="models"]');n++) await new Promise(resolve=>setTimeout(resolve,50));
    if(!document.querySelector('[data-page="models"]'))throw Error('Application did not render');
    const state=await rpc('getUpdateState');
    if(state.portable)throw Error('Installed executable was identified as portable');
    const context=await rpc('smokeSetupContext');
    if(context.update) {
      const available=await rpc('checkForUpdates');
      if(available.status!=='available')throw Error(JSON.stringify(available));
      await rpc('downloadUpdate');
      let ready;
      for(let n=0;n<1200;n++){ready=await rpc('getUpdateState');if(ready.status!=='downloading')break;await new Promise(resolve=>setTimeout(resolve,50));}
      if(ready.status!=='ready'||!ready.downloadPath.endsWith('-setup.exe'))throw Error(JSON.stringify(ready));
      await report({passed:true,stage:'downloaded',version:state.currentVersion,targetVersion:ready.targetVersion,checks:['installed mode','real Setup download','rendered native application']});
      await rpc('restartAndInstall');
    } else {
      await report({passed:true,stage:'restarted',version:state.currentVersion,update:state,providers:await rpc('getProviders'),checks:['installed mode','rendered native application','Setup restart']});
    }
  } catch(error){await report({passed:false,error:String(error)});}
})();
