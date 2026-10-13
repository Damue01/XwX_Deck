import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {rawTextPlugin} from '../build/raw-text-plugin.mjs';

// Browser plugin not available. Uses the caller's installed Playwright and an isolated HTTP fixture.
const root=resolve(import.meta.dirname,'../..');
const module=process.env.XWX_PLAYWRIGHT_MODULE;
const {chromium}=await import(module?pathToFileURL(resolve(module)).href:'playwright');
const bundle=await build({stdin:{contents:"export { renderTapViewerHtml } from './src/renderer/trace/viewerHtml';",resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,plugins:[rawTextPlugin],logLevel:'silent'});
const {renderTapViewerHtml}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const records=Array.from({length:1000},(_,n)=>({id:'reading-'+n,sessionId:'reading-session',turn:n+1,mainOrdinal:n+1,source:'codex-cli',startedAt:new Date(1791849600000+n*1000).toISOString(),completedAt:new Date(1791849600100+n*1000).toISOString(),request:{model:'fixture',method:'POST',path:'/v1/responses',body:{input:'Question '+(n+1),model:'fixture'}},response:{statusCode:200,snapshot:{output_text:'Fixture answer '+(n+1)}},usage:{version:2,totalTokens:2,inputTotalTokens:1,inputUncachedTokens:1,outputTokens:1,cacheReadTokens:0,cacheCreationTokens:0},costSnapshot:{version:1,costComplete:true,knownCostUsd:0}}));
const state={active:true,rootPath:'isolated-reading-fixture',language:'zh-CN',theme:'day',sessions:[{id:'reading-session',source:'codex-cli',firstPrompt:'Reading fixture',startedAt:records[0].startedAt,traceCount:records.length,totalTokens:2000,usageByModel:{fixture:{version:2,input:1000,output:1000,total:2000,capturedCost:{cost:0,complete:true}}},nativeUsage:records.map(r=>r.costSnapshot)}],traces:[]};
const html=renderTapViewerHtml({mode:'live',state:{active:false,sessions:[],traces:[]}});
const requests=[];const errors=[];const checks=[];const eventClients=new Set();
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': connected\n\n');eventClients.add(res);res.on('close',()=>eventClients.delete(res));return;}
 if(url.pathname==='/api/state'){res.setHeader('content-type','application/json');res.end(JSON.stringify(state));return;}
 if(url.pathname==='/api/theme'){res.setHeader('content-type','application/json');res.end(JSON.stringify({language:'zh-CN',theme:'day'}));return;}
 if(url.pathname==='/api/session/reading-session'){
  requests.push(Object.fromEntries(url.searchParams));
  const id=url.searchParams.get('requestId');
  const offset=id?records.findIndex(r=>r.id===id):url.searchParams.has('before')?Math.max(0,Number(url.searchParams.get('before'))-200):url.searchParams.has('offset')?Number(url.searchParams.get('offset')):Math.max(0,records.length-200);
  const limit=id?1:Math.min(200,Number(url.searchParams.get('limit')||200));
  let traces=records.slice(offset,offset+limit);
  if(url.searchParams.get('summary')==='1')traces=traces.map(r=>({...r,summaryOnly:true,request:{model:r.request.model,method:'POST',path:r.request.path},response:{statusCode:200}}));
  if(id)await new Promise(resolve=>setTimeout(resolve,id==='reading-230'?150:20));
  res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'reading-session',traces,offset,limit,total:1000,hasMoreBefore:offset>0,hasMoreAfter:offset+traces.length<1000}));return;
 }
 if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
 res.setHeader('content-type','text/html');res.end(html);
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const url='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1040,height:820}});
try{
 let page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(url);assert.equal(await page.title(),'Trace 模型请求追踪');
 await page.locator('.dash-table tr[data-sid="reading-session"]').click();
 await page.waitForFunction(()=>document.querySelector('#detail')?.textContent.includes('Question 1000')&&!document.querySelector('#detail .detail-loading'));
 assert.equal(await page.locator('.row[aria-pressed="true"]').getAttribute('data-id'),'reading-999');
 assert.ok(await page.locator('#traceList .row').count()>=200);
 assert.equal(await page.evaluate(()=>document.querySelector('#traceList').scrollHeight>document.querySelector('#traceList').clientHeight),true);
 assert.ok(requests.some(r=>r.summary==='1'&&!('offset' in r)&&r.limit==='200'));
 checks.push('first visit fills the rail with 200 metadata rows and opens the latest request');
 const arriving={...records[999],id:'reading-live',turn:1001,mainOrdinal:1001,startedAt:new Date(1791850600000).toISOString(),request:{...records[999].request,body:{input:'Live arrival',model:'fixture'}}};
 for(const client of eventClients)client.write('event: trace\ndata: '+JSON.stringify(arriving)+'\n\n');
 await page.waitForFunction(()=>traces().some(trace=>trace.id==='reading-live'));
 assert.equal(await page.locator('.row[aria-pressed="true"]').getAttribute('data-id'),'reading-999');
 assert.ok((await page.locator('#detail').innerText()).includes('Question 1000'));
 checks.push('a live arriving request updates the rail without moving the opened detail');
 await page.locator('#firstRequest').click();
 await page.waitForFunction(()=>document.querySelector('#detail')?.textContent.includes('Question 1')&&!document.querySelector('#detail .detail-loading'));
 assert.equal(await page.locator('.row[aria-pressed="true"]').getAttribute('data-id'),'reading-0');
 checks.push('from-the-start action opens request 1 and the first metadata page');
 await page.evaluate(()=>{const rail=document.querySelector('#traceList');rail.scrollTop=rail.scrollHeight;rail.dispatchEvent(new Event('scroll'));});
 await page.locator('.row[data-id="reading-250"]').waitFor();
 await page.locator('.row[data-id="reading-230"]').click();
 await page.locator('.row[data-id="reading-231"]').click();
 await page.waitForFunction(()=>document.querySelector('#detail')?.textContent.includes('Question 232'));
 await page.waitForTimeout(180);
 assert.equal(await page.locator('.row[aria-pressed="true"]').getAttribute('data-id'),'reading-231');
 assert.ok((await page.locator('#detail').innerText()).includes('Question 232'));
 checks.push('scroll prefetch extends the rail; late request detail cannot replace the latest selection');
 await page.locator('.row[data-id="reading-250"]').click();
 await page.waitForFunction(()=>document.querySelector('#detail')?.textContent.includes('Question 251'));
 await page.locator('#brandHome').click();
 await page.locator('.dash-table tr[data-sid="reading-session"]').click();
 await page.waitForFunction(()=>document.querySelector('.row[aria-pressed="true"]')?.dataset.id==='reading-250');
 assert.ok((await page.locator('#detail').innerText()).includes('Question 251'));
 assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('xwxTraceSessionPositions'))['reading-session'].requestId),'reading-250');
 assert.equal(await page.evaluate(()=>localStorage.getItem('xwxTraceSessionPositions')),null);
 await page.reload();
 await page.waitForFunction(()=>document.querySelector('#detail')?.textContent.includes('Question 251')&&!document.querySelector('#detail .detail-loading'));
 assert.equal(await page.locator('.row[aria-pressed="true"]').getAttribute('data-id'),'reading-250');
  assert.equal(await page.locator('.row[aria-pressed="true"] .turn').textContent(),'请求 251');
 checks.push('leaving, returning and refreshing preserve the opened request within this window');
 await page.close();page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));await page.goto(url);
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('xwxTraceSessionPositions')),null);
 await page.locator('.dash-table tr[data-sid="reading-session"]').click();
 await page.waitForFunction(()=>document.querySelector('#detail')?.textContent.includes('Question 1000')&&!document.querySelector('#detail .detail-loading'));
 assert.equal(await page.locator('.row[aria-pressed="true"]').getAttribute('data-id'),'reading-999');
 checks.push('a newly opened dashboard window has no prior reading marks and opens the latest request');
  if(process.env.XWX_SESSION_READING_SCREENSHOT)await page.screenshot({path:process.env.XWX_SESSION_READING_SCREENSHOT});
 assert.deepEqual(errors,[]);
 const report={passed:true,checks,errors,requests,scope:'actual Viewer JavaScript and Chromium with 1000 synthetic requests; native window/session storage and real clients are separate acceptance'};
 if(process.env.XWX_SESSION_READING_REPORT)await writeFile(process.env.XWX_SESSION_READING_REPORT,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}finally{await context.close();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
