import assert from 'node:assert/strict';
import esbuild from 'esbuild';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const module = process.env.XWX_PLAYWRIGHT_MODULE;
const { chromium } = await import(module ? pathToFileURL(resolve(module)).href : 'playwright');
const root = resolve(import.meta.dirname, '../..', 'dist/renderer');
// Explicit browser-only fixture. The shipped preview and fresh registry stay unchanged.
const fixture=await esbuild.build({stdin:{contents:`import {createPreviewApi} from './src/renderer/bridge/previewApi.ts'; const api=createPreviewApi(); api.fetchProviderModels=async()=>[{id:'synthetic-model',vendor:'Synthetic',protocols:['openai-responses'],protocolsDeclared:true,clients:['codex','claude']}]; window.xwxDeck=api;`,resolveDir:resolve(import.meta.dirname,'../..'),loader:'ts'},bundle:true,platform:'browser',format:'iife',write:false,alias:{'@':resolve(import.meta.dirname,'../../src/renderer')}});
const server = createServer(async (req, res) => {
  const relative = new URL(req.url, 'http://localhost').pathname;
  if(relative==='/test-fixture.js'){res.setHeader('content-type','application/javascript');res.end(fixture.outputFiles[0].text);return;}
  const path = resolve(root, '.' + (relative === '/' ? '/index.html' : relative));
  if (!path.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  try {
    res.setHeader('content-type', { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png' }[extname(path)] ?? 'application/octet-stream');
    const content=await readFile(path);
    res.end(extname(path)==='.html'?content.toString().replace('<script type="module"','<script src="/test-fixture.js"></script><script type="module"'):content);
  } catch { res.writeHead(404); res.end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const checks = [], errors = [];
try {
  for (const width of [780, 1040]) for (const theme of ['day', 'night']) {
    const page = await browser.newPage({ viewport: { width, height: 560 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.addInitScript(() => {localStorage.setItem('xwx-deck.onboardingSeen', 'true');localStorage.setItem('xwx-deck.language','zh-CN');});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    assert.match(await page.title(), /XwX Deck/);
    await page.locator('[data-page="settings"]').click();
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
    if (process.env.XWX_TOAST_TEST_BASELINE === '1') await page.addStyleTag({ content: ':root{--z-toast:40}' });
    assert.equal(await page.locator('[id^="provider-edit-"]').count(), 0, 'A fresh public preview has no connections');
    assert.equal(await page.locator('[data-page="sync"], [data-page="tools"]').count(), 0, 'Excluded pages stay absent');
    await page.locator('#provider-add').click();
    await page.locator('[data-service="custom"]').click();
    await page.locator('#provider-name').fill('测试服务');
    await page.locator('#provider-url').fill('http://127.0.0.1:9999/v1');
    await page.locator('#provider-key').fill('isolated-preview-key');
    await page.locator('#provider-editor button[type="submit"]').click();
    await page.locator('#provider-models-tab').waitFor();
    const savedId=await page.evaluate(async()=>{const item=(await window.xwxDeck.getProviders()).connections[0]; if(item.displayName!=='测试服务'||item.id==='测试服务') throw Error('Chinese display name must have an independent stable identity'); return item.id;});
    await page.locator('#provider-name').fill('Synthetic_Draft');
    await page.locator('#provider-models-tab').click();
    await page.getByRole('button', { name: /测试模型/ }).first().click();
    const toast = page.locator('[data-slot="toast-title"]', { hasText: '请先保存修改，再进行测试' });
    await toast.waitFor();
    const close = page.locator('[data-slot="toast-close"]').last();
    await close.waitFor();
    await page.waitForFunction(() => {
      const title=document.querySelector('[data-slot="toast-title"]');
      const toast=title?.closest('[data-position]');
      const rect=toast?.getBoundingClientRect();
      return toast && !toast.hasAttribute('data-starting-style') && rect.height>0 && rect.right<=innerWidth && Math.abs(rect.bottom-(innerHeight-parseFloat(getComputedStyle(toast.closest('[data-slot="toast-viewport"]')).bottom)))<1;
    });
    const evidence = await page.evaluate(() => {
      const toast = document.querySelector('[data-slot="toast-title"]').closest('[data-position]');
      const dialog = document.querySelector('#add-configuration-dialog');
      const a = toast.getBoundingClientRect(), b = dialog.getBoundingClientRect();
      const left = Math.max(a.left, b.left), right = Math.min(a.right, b.right), top = Math.max(a.top, b.top), bottom = Math.min(a.bottom, b.bottom);
      const x = (left + right) / 2, y = (top + bottom) / 2;
      return { overlaps: left < right && top < bottom, toastWinsHit: toast.contains(document.elementFromPoint(x, y)), point: { x, y }, toast: a.toJSON(), dialog: b.toJSON(), toastZ: getComputedStyle(toast.closest('[data-slot="toast-viewport"]')).zIndex, dialogZ: getComputedStyle(dialog).zIndex };
    });
    console.log(JSON.stringify({width,theme,...evidence}));
    assert.equal(evidence.overlaps, true, 'Real notification must overlap the model card');
    assert.equal(evidence.toastWinsHit, process.env.XWX_TOAST_TEST_BASELINE !== '1', 'Overlapping notification is hidden or cannot receive a pointer');
    if (process.env.XWX_TOAST_TEST_SCREENSHOT && width === 780 && theme === 'day') await page.screenshot({ path: process.env.XWX_TOAST_TEST_SCREENSHOT });
    if (process.env.XWX_TOAST_TEST_BASELINE !== '1') {
      await close.click();
      await toast.waitFor({ state: 'hidden' });
      await page.locator('#add-configuration-dialog').waitFor();
      await page.locator('#provider-config-tab').click();
      assert.equal(await page.locator('#provider-name').inputValue(), 'Synthetic_Draft', 'Closing feedback must preserve the draft');
      await page.locator('#provider-name').fill('测试服务新名称');
      await page.locator('#provider-editor button[type="submit"]').click();
      await page.waitForFunction(async id=>{const item=(await window.xwxDeck.getProviders()).connections.find(p=>p.id===id);return item?.displayName==='测试服务新名称';},savedId);
      assert.equal(await page.evaluate(async()=> (await window.xwxDeck.getProviders()).connections.length),1,'Rename must not add or merge another connection');
    }
    checks.push({ width, theme, ...evidence }); await page.close();
  }
  assert.deepEqual(errors, []);
  const report = { passed: true, browser: 'Chrome/Playwright', browserPlugin: 'not available', syntheticPreview: true, checks, consoleErrors: errors, flow: 'Edit provider draft -> Models -> Test model -> visible topmost notification -> close notification -> unchanged draft', normalDataModified: false, baseline: process.env.XWX_TOAST_TEST_BASELINE === '1' };
  if (process.env.XWX_TOAST_TEST_REPORT) await writeFile(process.env.XWX_TOAST_TEST_REPORT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
