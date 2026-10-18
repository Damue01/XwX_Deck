(async()=>{
 const checks=[],check=(name,value)=>{if(!value)throw Error(name);checks.push(name);};
 try{
  for(let n=0;n<100&&!document.querySelector('#recovery-message');n++)await new Promise(r=>setTimeout(r,50));
  check('startup failure uses application HTML and typography',!!document.querySelector('[role=alertdialog]')&&getComputedStyle(document.body).fontFamily.includes('Urbanist'));
  check('failure text is rendered literally, never executed as HTML',document.querySelector('#recovery-message').textContent.includes('<script>')&&!window.recoveryInjected);
  const bounds=document.querySelector('button').getBoundingClientRect();check('startup recovery action fits its window',bounds.top>=0&&bounds.bottom<=innerHeight&&bounds.right<=innerWidth);
  const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});document.querySelector('header').dispatchEvent(event);check('startup recovery suppresses the system context menu',event.defaultPrevented);
  const denied=await window.__TAURI__.core.invoke('pilot_rpc',{method:'getProviders',args:[]}).then(()=>false,()=>true);check('recovery cannot read or modify application configuration',denied&&!window.xwxDeck&&!document.querySelector('#page-signal'));
  await window.__TAURI__.core.invoke('recovery_action',{action:'report',report:{passed:true,checks}});
 }catch(error){await window.__TAURI__.core.invoke('recovery_action',{action:'report',report:{passed:false,checks,error:String(error)}});}
})();
