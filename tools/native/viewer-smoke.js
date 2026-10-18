(async()=>{
 const checks=[],environmentBlocks=[];const delay=ms=>new Promise(r=>setTimeout(r,ms));const wait=async(test,label,timeout=15000)=>{for(let i=0;i<timeout/100;i++){if(test())return;await delay(100);}throw Error(label);};const check=(label,value)=>{if(!value)throw Error(label);checks.push(label);};
 let report;
 try{
  await wait(()=>document.querySelector('.dash-table tbody tr')&&liveConnected,'live native Trace table');
  for(const [family,sample] of [['Urbanist','Trace Deck'],['Noto Sans SC','中文配置与模型']]){
    const loaded=await document.fonts.load(`400 14px "${family}"`,sample);
    check(`native Viewer loads bundled ${family} glyphs offline`,loaded.length>0&&loaded.every(face=>face.status==='loaded'));
  }
  check('native Viewer uses the confirmed sans fonts while usage values remain monospace',getComputedStyle(document.body).fontFamily.includes('Urbanist')&&getComputedStyle(document.querySelector('.dash-hero-num')).fontFamily.includes('Mono')&&!getComputedStyle(document.querySelector('.dash-hero-num')).fontFamily.includes('Urbanist'));
  check('existing Viewer renders in native WebKit',document.title==='Trace 模型请求追踪'&&document.querySelector('.dash-table tbody tr').getBoundingClientRect().height>0);
  check('native EventSource remains connected without a toolbar LIVE label',liveConnected&&!document.querySelector('#generatedAt').textContent);
  check('native dashboard replaces error rate with honest cache hit rate',document.querySelector('[data-cache-hit-rate] .dash-hs-label').textContent==='缓存命中率'&&!document.querySelector('.dash-hero-side').textContent.includes('错误率')&&/^(—|\d+\.\d+%)$/.test(document.querySelector('[data-cache-hit-rate] .dash-hs-val').textContent));
  check('native dashboard displays 60.0% from actual upstream cache usage',document.querySelector('[data-cache-hit-rate] .dash-hs-val').textContent==='60.0%');
  check('native Viewer follows application language and has no independent language selector',(await(await fetch('api/theme')).json()).language===document.documentElement.lang&&!document.querySelector('#langToggle'));
  const tableWrap=document.querySelector('.dash-table-wrap');
  check('native default table fits its viewport with complete numeric columns',tableWrap.scrollWidth<=tableWrap.clientWidth+2&&[...tableWrap.querySelectorAll('td[data-col="tokens"],td[data-col="cost"],td[data-col="requests"]')].every(cell=>cell.scrollWidth<=cell.clientWidth));
  const unknown={id:'native-no-usage-fixture',request:{model:'native-no-usage'},usage:{version:2,incompleteFields:['input','cacheRead','cacheWrite','output','total']}};
  const unknownSection=document.createElement('section');
  try{
    unknownSection.innerHTML=renderMetrics(unknown,unknown.usage)+railRowHtml(unknown,false);document.body.append(unknownSection);
    check('native request detail and rail mark missing usage as unknown instead of zero',unknownSection.querySelector('.mhero').textContent==='—'&&unknownSection.querySelector('.tok').textContent==='— tok');
  }finally{unknownSection.remove();}
  const fixturePrice={match:'exact',modelId:'native-partial-fixture',tokens:['native-partial-fixture'],protocol:'openai',input:1,output:2,cacheRead:.1,cacheWritePolicy:'input'};
  const fixtureUsage={version:2,input:20,inputTotal:100,inputTotalComplete:true,output:5,cacheRead:60,cacheCreation:20,total:105,invalidFields:['cacheWriteTtl']};
  const partial=estimateCostBreakdown(fixtureUsage,fixturePrice);
  check('native Viewer retains known input output and cache-read charges with invalid TTL',!partial.complete&&Math.abs(partial.cost-.000036)<1e-12);
  PRICE_RULES.unshift(fixturePrice);
  const matrix=document.createElement('section');
  try {
    matrix.innerHTML=renderTokenMatrix([{usageByModel:{'native-partial-fixture':fixtureUsage}}]);document.body.append(matrix);
    const cells=matrix.querySelectorAll('tbody td');
    check('native Viewer marks invalid usage separately and keeps a normal positive tiny known amount',cells[1].textContent==='20'&&cells[2].textContent==='60'&&cells[3].textContent==='20'&&cells[4].textContent==='5'&&cells[5].textContent==='105'&&cells[6].textContent==='$0.000036'&&cells[6].getBoundingClientRect().height>0&&matrix.querySelector('tfoot td:last-child').textContent==='$0.000036');
  } finally {matrix.remove();PRICE_RULES.splice(PRICE_RULES.indexOf(fixturePrice),1);}
  check('dashboard header, columns and table rows have no dividers',getComputedStyle(document.querySelector('.top')).borderBottomWidth==='0px'&&getComputedStyle(document.querySelector('.rail')).borderRightWidth==='0px'&&[...document.querySelectorAll('.dash-table th,.dash-table td')].every(element=>getComputedStyle(element).borderBottomWidth==='0px'));
  const idleRow=document.querySelector('.dash-table tbody tr');
  const blankContext=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});document.querySelector('.dash-hero').dispatchEvent(blankContext);
  check('native Viewer suppresses the system context menu on dashboard surfaces',blankContext.defaultPrevented&&!document.querySelector('.xwx-edit-menu'));
  openSearch();await delay(100);
  check('Viewer search uses the application modal and typography',document.querySelector('#searchOv.on [role=dialog]')?.getBoundingClientRect().height>0&&getComputedStyle(document.querySelector('#searchOv .modal')).fontFamily.includes('Urbanist'));
  const searchInput=document.querySelector('#globalSearch');searchInput.value='synthetic search';searchInput.focus();searchInput.select();const searchRect=searchInput.getBoundingClientRect();
  const searchContext=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:searchRect.x+10,clientY:searchRect.y+10});searchInput.dispatchEvent(searchContext);
  check('Viewer search input has a designed edit menu inside its modal',searchContext.defaultPrevented&&!!document.querySelector('#searchOv .xwx-edit-menu'));
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  check('Viewer edit-menu dismissal preserves the search modal',!document.querySelector('.xwx-edit-menu')&&document.querySelector('#searchOv').classList.contains('on'));
  closeSearch();openPricing();await delay(100);
  check('Viewer pricing uses its application modal',document.querySelector('#pricingOv.on [role=dialog]')?.getBoundingClientRect().height>0);
  closePricing();
  const deletePrompt = confirmDeleteSession(idleRow.dataset.sid);
  check('Viewer delete reminder uses its application modal',document.querySelector('#confirmDeleteOv.on [role=dialog]')?.getBoundingClientRect().height>0&&getComputedStyle(document.querySelector('#confirmDeleteOv .modal')).fontFamily.includes('Urbanist'));
  check('native delete confirmation preserves accounting by default', !document.querySelector('#confirmDeleteUsage').checked && document.querySelector('#confirmDeleteUsageLabel').getBoundingClientRect().height>0);
  document.querySelector('#confirmDeleteUsage').click();
  document.querySelector('#confirmDeleteCancel').click(); await deletePrompt;
  const reopenedDelete = confirmDeleteSession(idleRow.dataset.sid);
  check('native delete confirmation resets the usage choice when reopened', !document.querySelector('#confirmDeleteUsage').checked);
  document.querySelector('#confirmDeleteCancel').click(); await reopenedDelete;
  check('native dashboard omits LIVE and secondary metadata rows',!document.querySelector('.dash-status.live,.dash-first-meta')&&!idleRow.textContent.includes('LIVE'));
  check('native dashboard date time title and model remain on one line',[...document.querySelectorAll('.dash-time span,.dash-first-title,.dash-model')].every(element=>getComputedStyle(element).whiteSpace==='nowrap')&&idleRow.querySelector('.dash-time').children.length===1&&idleRow.querySelector('.dash-first-line').getBoundingClientRect().height<=20&&idleRow.getBoundingClientRect().height<=50);
  const costFixtureState=state,costFixtureMatrix=tokenMatrixOpen;
  try {
    state={...state,sessions:[{id:'native-cost-gap',source:'codex-cli',firstPrompt:'Known amount fixture',startedAt:'2026-10-13T00:00:00Z',traceCount:2,totalTokens:165,nativeUsage:[{knownCostUsd:.003,costComplete:true},{knownCostUsd:null,costComplete:false,priceRule:{},tokens:null,unpricedReasons:['incomplete_usage']}],usageByModel:{fixture:{version:2,input:100,output:5,cacheRead:60,cacheCreation:0,total:165,incompleteFields:['input'],capturedCost:{cost:.003,complete:false}}}}]};
    tokenMatrixOpen=true;renderDashboard();
    check('native dashboard shows known fees without stars in hero session and matrix',document.querySelector('.dash-hero-num').textContent==='$0.003'&&document.querySelector('td[data-col="cost"]').textContent==='$0.003'&&[...document.querySelectorAll('.dash-matrix tr')].every(row=>!row.lastElementChild.textContent.includes('*')));
    check('native dashboard keeps single-line rows without unpriced fallback labels',!document.querySelector('.dash-unpriced-report,.dash-unpriced-badge')&&!document.querySelector('.dash').textContent.includes('未计价')&&document.querySelector('.dash-table tbody tr').getBoundingClientRect().height<=50);
  } finally {state=costFixtureState;tokenMatrixOpen=costFixtureMatrix;renderDashboard();}
  document.querySelector('.dash-table tbody tr').click();
  await wait(()=>location.hash.startsWith('#session=')&&document.querySelector('#detail')?.innerText.includes('POST'),'lazy native session detail');
  check('visible session row opens real request details',document.querySelector('#detail').getBoundingClientRect().height>0&&document.querySelector('#detail').innerText.includes('POST'));
  check('native detail exposes the session folder action at the top right',!document.querySelector('#revealSession').hidden&&document.querySelector('#revealSession').getBoundingClientRect().width>0&&document.querySelector('#revealSession').textContent.includes('打开所在文件夹'));
  document.querySelector('#revealSession').click();
  await wait(()=>!document.querySelector('#revealSession').disabled,'native folder reveal finishes');
  const folderError=document.querySelector('#toast')?.textContent||'';
  if(navigator.platform.startsWith('Win')&&folderError.includes('0x80070005'))environmentBlocks.push({check:'open session folder',error:folderError});
  else check('native WebView folder action completes without an error: '+folderError,!folderError);
  check('request details have no separators between metrics and messages',!document.querySelector('.return-divider')&&[...document.querySelectorAll('.head .seg,.metrics .mcol,.metrics-detail .mdcol,.msg')].every(element=>getComputedStyle(element).borderLeftWidth==='0px'&&getComputedStyle(element).borderTopWidth==='0px'));
  const savedState=state,savedId=selectedId,savedSid=selectedSessionId;
  try{
    const requests=Array.from({length:600},(_,i)=>({id:'native-rail-'+i,sessionId:'native-rail-fixture',turn:i+1,startedAt:new Date(1791849600000+i*1000).toISOString(),request:{model:'fixture'},usage:{totalTokens:0,inputUncachedTokens:0,inputTotalTokens:0}}));
    state={sessions:[{id:'native-rail-fixture',traceCount:600}],sessionTraces:{'native-rail-fixture':requests}};
    selectedSessionId='native-rail-fixture';selectedId=requests[599].id;railWinDirty=true;renderList();
    const stable=document.querySelector('#traceList [data-id="native-rail-599"]');
    check('native long session initially renders 200 requests',document.querySelectorAll('#traceList .row').length===200);
    loadRailRows('top');
    check('native history expansion keeps existing request DOM',document.querySelectorAll('#traceList .row').length===400&&document.querySelector('#traceList [data-id="native-rail-599"]')===stable);
    const requestBefore=currentTrace().id;
    const visibleBefore=captureRailAnchor();
    gotoDashboard();gotoSession('native-rail-fixture');
    check('native session return restores the selected request and rail anchor',currentTrace().id===requestBefore&&(!visibleBefore||captureRailAnchor().id===visibleBefore.id));
  }finally{state=savedState;selectedId=savedId;selectedSessionId=savedSid;railWinDirty=true;renderList();}

  const contextFixture = document.createElement('section');
  try {
    const environment = '<environment_context><cwd>/workspace/native-fixture</cwd><shell>zsh</shell><current_date>2026-10-16</current_date><timezone>Asia/Shanghai</timezone><filesystem><workspace_roots><root>/workspace/native-fixture</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>';
    const context = {request:{body:{input:[{role:'user',content:environment}]}}};
    contextFixture.innerHTML = renderMessages(getMessages(context)); document.body.append(contextFixture);
    check('native WebKit renders self-closing filesystem environment cards', contextFixture.querySelector('.env-context') && contextFixture.innerText.includes('/workspace/native-fixture') && !contextFixture.innerText.includes('<environment_context>'));
  } finally { contextFixture.remove(); }
  const compactFixture = document.createElement('section');
  try {
    const body = {input:[{type:'compaction',encrypted_content:'xwxc1:'+btoa('native compact summary')},{role:'user',content:'continue'}]};
    const compactTrace = {id:'native-compact-display',compact:true,request:{body,model:'fixture'},usage:{total:0}};
    compactFixture.innerHTML = renderMessages(getMessages(compactTrace)) + railRowHtml(compactTrace,false); document.body.append(compactFixture);
    check('native WebKit decodes native compact summaries and shows the compact request label',compactFixture.innerText.includes('native compact summary') && compactFixture.innerText.includes('上下文压缩') && !compactFixture.innerText.includes('xwxc1:'));
  } finally { compactFixture.remove(); }

  report={passed:environmentBlocks.length===0,checks,environmentBlocks,userAgent:navigator.userAgent};
 }catch(error){report={...report,passed:false,checks,error:String(error)};}
 await fetch('/__native-viewer-smoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(report)});
})();
