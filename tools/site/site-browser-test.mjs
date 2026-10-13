import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';

// Uses an explicitly supplied installed Playwright module, or the usual package.
const module = process.env.XWX_PLAYWRIGHT_MODULE;
const { chromium } = await import(module ? pathToFileURL(resolve(module)).href : 'playwright');
const root = resolve(import.meta.dirname, '../..');
const site = resolve(process.env.XWX_SITE_PREVIEW_DIR ?? join(root, 'test-results/site-preview'));
const policy = JSON.parse(await readFile(join(root, 'public-release-policy.json'), 'utf8'));
const checks = [];
const errors = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/fixture.exe') {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="fixture.exe"' });
    response.end('synthetic download fixture'); return;
  }
  const configured = url.pathname.startsWith('/configured/');
  const relative = url.pathname.replace(/^\/configured\//, '/').replace(/^\//, '') || 'index.html';
  const file = resolve(site, relative);
  if (!file.startsWith(site + '/')) { response.writeHead(403); response.end(); return; }
  try {
    let body = await readFile(file);
    if (configured && relative === 'index.html') {
      const original = body.toString();
      const replacement = original.replace(/const DOWNLOADS = \{[^}]+\};/, "const DOWNLOADS = { windows: '/fixture.exe', mac: '/fixture.exe' };");
      assert.notEqual(replacement, original, 'configured-download fixture must replace the actual download map');
      body = Buffer.from(replacement);
    }
    response.writeHead(200, { 'content-type': ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}[extname(file)] ?? 'application/octet-stream') });
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  for (const width of [390, 780, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle' });
    assert.equal(page.url(), url + '/');
    assert.equal(await page.title(), 'XwX Deck：让 AI 更简单一点');
    await page.getByRole('heading', { level: 1 }).waitFor();
    assert.match(await page.getByRole('heading', { level: 1 }).textContent(), /让 AI\s*更简单一点/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.XWX_SITE_TEST_SCREENSHOT_DIR) {
      await mkdir(process.env.XWX_SITE_TEST_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.XWX_SITE_TEST_SCREENSHOT_DIR, `public-site-hero-${width}.png`), fullPage: false });
    }
    await page.getByRole('tab', { name: '切换模型服务' }).click();
    const frame = page.frameLocator('iframe');
    await frame.locator('#page-models.current').waitFor();
    assert.match(await frame.locator('#page-models').innerText(), /智谱 GLM/);
    assert.match(await frame.locator('#page-models').innerText(), /glm-5\.3/);
    const publicState = await (await page.locator('iframe').elementHandle()).contentFrame();
    const boundary = await publicState.evaluate(async methods => {
      const api = window.xwxDeck;
      const providers = await api.getProviders();
      const config = await api.getCodexConfig();
      return { selected: Object.keys(providers.selected).sort(), mode: config.mode, hasCompatible: !!config.compatible,
        removedMethods: methods.filter(method => typeof api[method] !== 'undefined') };
    }, policy.forbiddenRpcMethods);
    assert.deepEqual(boundary.selected, ['claude', 'codex']);
    assert.equal(boundary.mode, 'compatible');
    assert.equal(boundary.hasCompatible, true);
    assert.deepEqual(boundary.removedMethods, []);
    await page.getByRole('tab', { name: '集中管理服务' }).click();
    await page.locator('iframe').waitFor();
    await frame.locator('#page-settings.current').waitFor();
    assert.equal(await page.locator('#tab-settings').getAttribute('aria-selected'), 'true');
    assert.equal(await frame.locator('#page-settings h1').innerText(), '设置');
    await page.getByRole('tab', { name: '查看 Trace' }).click();
    assert.equal(await page.locator('#tab-signal').getAttribute('aria-selected'), 'true');
    await frame.locator('#page-signal.current').waitFor();
    assert.match(await frame.locator('body').innerText(), /Trace/);
    if (process.env.XWX_SITE_TEST_SCREENSHOT_DIR) {
      await mkdir(process.env.XWX_SITE_TEST_SCREENSHOT_DIR, { recursive: true });
      await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
      await page.screenshot({ path: join(process.env.XWX_SITE_TEST_SCREENSHOT_DIR, `public-site-${width}.png`), fullPage: true });
    }
    checks.push(`WE01/WE03: title, visible content, overflow, tabs and real renderer at ${width}px`);
  }
  await page.locator('[data-download="windows"]').last().click();
  assert.match(await page.locator('.dl-msg').innerText(), /未配置下载地址/);
  await page.getByRole('link', { name: '查看已发布版本' }).getAttribute('href').then(href => assert.equal(href, 'https://github.com/Damue01/XwX_Deck/releases'));
  checks.push('WE02: missing download URL gives an actionable status');
  await page.goto(url + '/configured/index.html', { waitUntil: 'networkidle' });
  const download = page.waitForEvent('download');
  await page.locator('[data-download="windows"]').last().click();
  assert.equal((await download).suggestedFilename(), 'fixture.exe');
  checks.push('WE02: configured download resolves to the selected artifact fixture');
  assert.deepEqual(errors, []);
  if (process.env.XWX_SITE_TEST_SCREENSHOT) await page.screenshot({ path: process.env.XWX_SITE_TEST_SCREENSHOT, fullPage: true });
  const report = { passed: true, previewDirectory: 'test-results/site-preview', evidenceLevel: 'P', browser: 'Chrome/Playwright', browserPlugin: 'not available', checks, consoleErrors: errors,
    scope: 'Local static site and real renderer with synthetic accounts and download fixtures; no deployment, installation or real authorization.' };
  if (process.env.XWX_SITE_TEST_REPORT) { await mkdir(resolve(process.env.XWX_SITE_TEST_REPORT, '..'), { recursive: true }); await writeFile(process.env.XWX_SITE_TEST_REPORT, JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
