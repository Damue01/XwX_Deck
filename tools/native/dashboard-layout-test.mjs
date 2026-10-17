import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { rawTextPlugin } from '../build/raw-text-plugin.mjs';

// Render the production Viewer in an installed browser. Native WebKit is tested separately.
const root = resolve(import.meta.dirname, '../..');
const module = process.env.XWX_PLAYWRIGHT_MODULE;
const { chromium } = await import(module ? pathToFileURL(resolve(module)).href : 'playwright');
const bundle = await build({stdin:{contents:"export { renderTapViewerHtml } from './src/renderer/trace/viewerHtml';",resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,plugins:[rawTextPlugin],logLevel:'silent'});
const { renderTapViewerHtml } = await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const sessions = [false,true].map((lastTurnError,i)=>({id:'layout-'+i,source:i?'claude-cli':'codex-cli',startedAt:'2026-10-13T00:00:00Z',updatedAt:new Date().toISOString(),title:'完整会话标题'.repeat(100),firstPrompt:'完整原文'.repeat(100),firstModel:'long-model-name'.repeat(100),traceCount:1234,totalTokens:47801222,lastTurnError,nativeUsage:Array.from({length:1234},(_,n)=>({costComplete:n!==1233,knownCostUsd:n===0?.012:n===1233?null:0,priceRule:{},tokens:n===1233?null:0,unpricedReasons:n===1233?['incomplete_usage']:[]})),usageByModel:{fixture:{version:2,input:47801222,output:0,cacheRead:0,cacheCreation:0,total:47801222,capturedCost:{cost:.012,complete:false}}}}));
const html = renderTapViewerHtml({mode:'static',state:{active:true,rootPath:'isolated-layout-fixture',sessions,traces:[]}});
const browser = await chromium.launch({channel:'chrome',headless:true});
const checks=[];const errors=[];
try {
  const page=await browser.newPage();
  page.on('pageerror',error=>errors.push(String(error)));
  await page.route('http://127.0.0.1/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:html}));
  await page.goto('http://127.0.0.1/');
  for(const width of [780,1040,1440]) for(const language of ['zh-CN','en']) {
    await page.setViewportSize({width,height:900});
    await page.evaluate(language=>{applyViewerPreferences({language});state.dashSourceFilter='all';tokenMatrixOpen=false;gotoDashboard();},language);
    await page.locator('.dash-table tbody tr').first().waitFor();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const layout=await page.evaluate(()=>{
      const wrap=document.querySelector('.dash-table-wrap');
      const rows=[...wrap.querySelectorAll('tbody tr')];
      return {headersSingleLine:[...wrap.querySelectorAll('th[data-col]')].filter(cell=>getComputedStyle(cell).display!=='none').every(cell=>getComputedStyle(cell).whiteSpace==='nowrap'&&cell.scrollWidth<=cell.clientWidth),fits:wrap.scrollWidth<=wrap.clientWidth+2,singleLine:rows.every(row=>row.getBoundingClientRect().height<=50&&row.querySelector('.dash-first-line').getBoundingClientRect().height<=20&&row.querySelector('.dash-time').children.length===1),numericComplete:[...wrap.querySelectorAll('td[data-col="tokens"],td[data-col="cost"],td[data-col="requests"]')].every(cell=>cell.scrollWidth<=cell.clientWidth),noLive:!wrap.innerText.includes('LIVE')&&!wrap.querySelector('.dash-first-meta'),errors:wrap.querySelectorAll('.dash-status.err').length,titleClips:rows.every(row=>row.querySelector('.dash-first-title').scrollWidth>row.querySelector('.dash-first-title').clientWidth),modelNoWrap:[...wrap.querySelectorAll('.dash-model')].every(cell=>getComputedStyle(cell).whiteSpace==='nowrap'&&cell.title.length>100)};
    });
    assert.deepEqual(layout,{headersSingleLine:true,fits:true,singleLine:true,numericComplete:true,noLive:true,errors:1,titleClips:true,modelNoWrap:true},`${width}px ${language}`);
    checks.push(`TR08: single line, full numbers, title/model truncation, no LIVE and inline error at ${width}px ${language}`);
    await page.locator('[data-toggle-matrix]').click();
    assert.equal(await page.locator('.dash-hero-num').textContent(),'$0.024');
    assert.equal(await page.locator('.dash-unpriced-report').count(),0);
    assert.equal(await page.locator('.dash-unpriced-badge').count(),0);
    assert.deepEqual(await page.locator('td[data-col="cost"]').allTextContents(),['$0.012','$0.012']);
    await page.locator('[data-sfilter="codex-cli"]').click();
    assert.equal(await page.locator('.dash-table tbody tr').count(),1);
    assert.equal(await page.locator('.dash-hero-num').textContent(),'$0.012');
    assert.equal(await page.locator('.dash-unpriced-report').count(),0);
    assert.equal(await page.locator('.dash-unpriced-badge').count(),0);
    checks.push(`CO03: normal known fees, no top warning or fallback badge, and actual filter/fee-toggle interaction at ${width}px ${language}`);

  }
  if(process.env.XWX_DASHBOARD_TEST_SCREENSHOT) await page.screenshot({path:process.env.XWX_DASHBOARD_TEST_SCREENSHOT});
  assert.deepEqual(errors,[]);
  const report={passed:true,checks,errors,scope:'Production Viewer HTML, synthetic session summaries, Chromium; native WebKit and physical OS actions are separate'};
  if(process.env.XWX_DASHBOARD_TEST_REPORT) await writeFile(process.env.XWX_DASHBOARD_TEST_REPORT,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {await browser.close();}
