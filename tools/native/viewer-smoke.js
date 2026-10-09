(async()=>{
 const checks=[];const delay=ms=>new Promise(r=>setTimeout(r,ms));const wait=async(test,label)=>{for(let i=0;i<150;i++){if(test())return;await delay(100);}throw Error(label);};const check=(label,value)=>{if(!value)throw Error(label);checks.push(label);};
 let report;
 try{
  await wait(()=>document.querySelector('.dash-table tbody tr')&&document.querySelector('#generatedAt .live-on'),'live native Trace table');
  check('existing Viewer renders in native WebKit',document.title==='Trace 模型请求追踪'&&document.querySelector('.dash-table tbody tr').getBoundingClientRect().height>0);
  check('native EventSource is connected',document.querySelector('#generatedAt .live-on').textContent==='LIVE');
  check('dashboard header, columns and table rows have no dividers',getComputedStyle(document.querySelector('.top')).borderBottomWidth==='0px'&&getComputedStyle(document.querySelector('.rail')).borderRightWidth==='0px'&&[...document.querySelectorAll('.dash-table th,.dash-table td')].every(element=>getComputedStyle(element).borderBottomWidth==='0px'));
  document.querySelector('.dash-table tbody tr').click();
  await wait(()=>location.hash.startsWith('#session=')&&document.querySelector('#detail')?.innerText.includes('POST'),'lazy native session detail');
  check('visible session row opens real request details',document.querySelector('#detail').getBoundingClientRect().height>0&&document.querySelector('#detail').innerText.includes('POST'));
  check('request details have no separators between metrics and messages',!document.querySelector('.return-divider')&&[...document.querySelectorAll('.head .seg,.metrics .mcol,.metrics-detail .mdcol,.msg')].every(element=>getComputedStyle(element).borderLeftWidth==='0px'&&getComputedStyle(element).borderTopWidth==='0px'));
  report={passed:true,checks,userAgent:navigator.userAgent};
 }catch(error){report={passed:false,checks,error:String(error)};}
 await fetch('/__native-viewer-smoke',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(report)});
})();
