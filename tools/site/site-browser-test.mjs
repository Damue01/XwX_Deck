import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { validateRealExamples } from './real-example-contract.mjs';

// Uses an explicitly supplied installed Playwright module, or the usual package.
const module = process.env.XWX_PLAYWRIGHT_MODULE;
const { chromium } = await import(module ? pathToFileURL(resolve(module)).href : 'playwright');
const root = resolve(import.meta.dirname, '../..');
const site = resolve(process.env.XWX_SITE_PREVIEW_DIR ?? join(root, 'test-results/site-preview'));
const policy = JSON.parse(await readFile(join(root, 'tools/checks/repository-policy.json'), 'utf8'));
const examples = JSON.parse(await readFile(join(root, 'web/site/dashboard-examples.json'), 'utf8'));
validateRealExamples(examples);
const unsafeExample = structuredClone(examples);
unsafeExample.state.traces[0].request.headers = { authorization: 'private fixture' };
assert.throws(() => validateRealExamples(unsafeExample), /Private field/);
const builtIndex = await readFile(join(site, 'index.html'), 'utf8');
const builtApp = await readFile(join(site, 'app.html'), 'utf8');
for (const asset of ['fonts.css', 'site.css', 'hero-field.js', 'language.js', 'app.html', 'view.html']) {
  assert.ok(builtIndex.includes(asset + '?v='), 'website references must carry a content version: ' + asset);
}
for (const asset of ['app.css', 'app-preview.js']) {
  assert.ok(builtApp.includes(asset + '?v='), 'demo resources must carry a content version: ' + asset);
}
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
  if (!file.startsWith(site + sep)) { response.writeHead(403); response.end(); return; }
  try {
    let body = await readFile(file);
    if (configured && relative === 'index.html') {
      const original = body.toString();
      const replacement = original.replace(/const DOWNLOADS = \{[^}]+\};/, "const DOWNLOADS = { windows: '/fixture.exe', mac: '/fixture.exe', macIntel: '/fixture.exe' };");
      assert.notEqual(replacement, original, 'configured-download fixture must replace the actual download map');
      body = Buffer.from(replacement);
    }
    response.writeHead(200, { 'content-type': ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'}[extname(file)] ?? 'application/octet-stream') });
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ ...(process.env.XWX_PLAYWRIGHT_CHANNEL === 'chromium' ? {} : { channel: 'chrome' }), headless: true });
try {
  const page = await browser.newPage({ reducedMotion: 'reduce', locale: 'zh-CN' });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgentData', { value: {
      platform: 'Windows', mobile: false,
      getHighEntropyValues: async () => ({ architecture: 'x86', bitness: '64' }),
    } });
  });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  for (const width of [320, 390, 780, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle' });
    assert.equal(page.url(), url + '/');
    assert.equal(await page.title(), 'XwX Deck：好工具，更简单');
    await page.getByRole('heading', { level: 1 }).waitFor();
    assert.match(await page.getByRole('heading', { level: 1 }).textContent(), /好工具，\s*更简单/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const primary = page.locator('#recommended-download');
    await primary.getByText('下载 Windows 版').waitFor();
    assert.match(await primary.getAttribute('href'), /windows-x64\.exe$/);
    const primaryBox = await primary.boundingBox();
    const otherBox = await page.locator('#download-options > summary').boundingBox();
    assert.ok(Math.abs(primaryBox.x + primaryBox.width / 2 - width / 2) < 1, 'primary download aligns with the page center independently of other versions');
    assert.ok(otherBox.x > primaryBox.x + primaryBox.width && otherBox.x + otherBox.width <= width, 'other versions stays to the right without overflowing');
    assert.equal(await page.locator('#download-caption').count(), 0);
    await page.locator('#download-options > summary').click();
    for (const target of ['windows', 'mac', 'macIntel']) assert.equal(await page.locator(`[data-download="${target}"]`).isVisible(), true);
    assert.equal(await page.locator('.download-choices .download-choice').count(), 3);
    const intel = page.locator('[data-download="macIntel"]');
    assert.match(await intel.getAttribute('href'), /mac-x64\.dmg$/);
    assert.match(await intel.innerText(), /Intel[\s\S]*DMG/);
    assert.equal(await page.locator('[data-unavailable-download]').count(), 0);
    assert.equal(await page.locator('.recommend-badge').count(), 0);
    assert.doesNotMatch(await page.locator('.download-choices').innerText(), /推荐|↗/);
    const panelBox = await page.locator('.download-choices').boundingBox();
    assert.ok(panelBox.x >= 0 && panelBox.x + panelBox.width <= width, 'download choices stay inside the viewport');
    await page.locator('[data-download="mac"]').focus();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#download-options').getAttribute('open'), null);
    assert.equal(await page.locator('#download-options > summary').evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('#community [data-download]').count(), 0);
    if (process.env.XWX_SITE_TEST_SCREENSHOT_DIR) {
      await mkdir(process.env.XWX_SITE_TEST_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.XWX_SITE_TEST_SCREENSHOT_DIR, `public-site-hero-${width}.png`), fullPage: false });
    }
    await page.getByRole('tab', { name: '切换模型服务' }).click();
    const frame = page.frameLocator('#app-demo');
    await frame.locator('#page-models.current').waitFor();
    assert.match(await frame.locator('#page-models').innerText(), /ChatGPT 官方登录/);
    assert.match(await frame.locator('#page-models').innerText(), /gpt-6\.1-sol/);
    const publicState = await (await page.locator('#app-demo').elementHandle()).contentFrame();
    const boundary = await publicState.evaluate(async methods => {
      const api = window.xwxDeck;
      const providers = await api.getProviders();
      const config = await api.getCodexConfig();
      const models = await api.fetchModels();
      return { selected: Object.keys(providers.selected).sort(), mode: config.mode, hasCompatible: !!config.compatible,
        model: config.compatible.model, context: config.modelContextWindow, solContext: models.find(model => model.id === 'gpt-6.1-sol')?.contextWindow,
        removedMethods: methods.filter(method => typeof api[method] !== 'undefined') };
    }, policy.forbiddenRpcMethods);
    assert.deepEqual(boundary.selected, ['claude', 'codex']);
    assert.equal(boundary.mode, 'compatible');
    assert.equal(boundary.hasCompatible, true);
    assert.equal(boundary.model, 'gpt-6.1-sol');
    assert.equal(boundary.context, 500000);
    assert.equal(boundary.solContext, 500000);
    assert.deepEqual(boundary.removedMethods, []);
    await page.getByRole('tab', { name: '集中管理服务' }).click();
    await page.locator('#app-demo').waitFor();
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
  for (const width of [320, 390, 780, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle' });
    const picker = page.locator('#language-trigger');
    await page.getByRole('tab', { name: '集中管理服务', exact: true }).click();
    await picker.click();
    assert.equal(await page.getByRole('menuitemradio', { name: '简体中文' }).getAttribute('aria-checked'), 'true');
    const menuBox = await page.locator('#language-menu').boundingBox();
    assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= width, 'language menu stays within the viewport');
    await page.getByRole('menuitemradio', { name: 'English', exact: true }).click();
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.equal(await page.title(), 'XwX Deck: Good tools, made simple');
    assert.match(await page.locator('#title').innerText(), /Good tools,\s+made simple/);
    assert.equal(await page.locator('#language-menu').isVisible(), false);
    assert.equal(await picker.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.getByRole('link', { name: 'Docs', exact: true }).getAttribute('href'), './docs/');
    assert.equal(await page.locator('#tab-settings').getAttribute('aria-selected'), 'true');
    assert.match(await page.locator('#feature-copy').innerText(), /Manage service URLs/);
    await page.frameLocator('#app-demo').getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.match(await page.locator('#recommended-download').innerText(), /Download for Windows/);
    assert.match(await page.locator('#recommended-download').getAttribute('href'), /windows-x64\.exe$/);
    await page.locator('#download-options > summary').click();
    assert.equal(await page.getByRole('link', { name: 'All releases', exact: true }).isVisible(), true);
    const downloadBox = await page.locator('.download-choices').boundingBox();
    assert.ok(downloadBox.x >= 0 && downloadBox.x + downloadBox.width <= width);
    await picker.click();
    assert.equal(await page.locator('#download-options').getAttribute('open'), null);
    if (process.env.XWX_SITE_TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.XWX_SITE_TEST_SCREENSHOT_DIR, `language-menu-en-${width}.png`) });
    await page.keyboard.press('Escape');
    assert.equal(await picker.evaluate(node => node === document.activeElement), true);
    await page.getByRole('tab', { name: 'View dashboard', exact: true }).click();
    await page.frameLocator('#dashboard-demo').locator('html[lang="en"]').waitFor();
    assert.match(await page.frameLocator('#dashboard-demo').locator('.site-example-label').innerText(), /Real requests/);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    await picker.focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.getByRole('menuitemradio', { name: '简体中文' }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('End');
    assert.equal(await page.getByRole('menuitemradio', { name: 'English', exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
    await picker.click();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#language-menu').isVisible(), false);
    await picker.click();
    await page.locator('#title').click();
    assert.equal(await page.locator('#language-menu').isVisible(), false);
    if (process.env.XWX_SITE_TEST_SCREENSHOT_DIR) {
      await page.evaluate(() => scrollTo(0, 0));
      await picker.click();
      await page.screenshot({ path: join(process.env.XWX_SITE_TEST_SCREENSHOT_DIR, `language-menu-zh-${width}.png`) });
      await page.keyboard.press('Escape');
    }
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  }
  const englishContext = await browser.newContext({ locale: 'en-US' });
  const englishPage = await englishContext.newPage();
  await englishPage.goto(url, { waitUntil: 'networkidle' });
  assert.equal(await englishPage.locator('html').getAttribute('lang'), 'en');
  await englishPage.locator('#language-trigger').click();
  await englishPage.getByRole('menuitemradio', { name: '简体中文' }).click();
  await englishPage.reload({ waitUntil: 'networkidle' });
  assert.equal(await englishPage.locator('html').getAttribute('lang'), 'zh-CN', 'explicit choice wins over browser language');
  await englishContext.close();
  const blockedStorage = await browser.newContext({ locale: 'zh-CN' });
  await blockedStorage.addInitScript(() => {
    Storage.prototype.getItem = Storage.prototype.setItem = () => { throw new DOMException('Storage is unavailable', 'SecurityError'); };
  });
  // Isolate the landing page from the existing product demo's storage requirements.
  await blockedStorage.route('**/app.html?*', route => route.fulfill({ contentType: 'text/html', body: '<html><body>Isolated preview</body></html>' }));
  const blockedPage = await blockedStorage.newPage();
  const blockedErrors = [];
  blockedPage.on('pageerror', error => blockedErrors.push(String(error)));
  await blockedPage.goto(url, { waitUntil: 'networkidle' });
  await blockedPage.locator('#language-trigger').click();
  await blockedPage.getByRole('menuitemradio', { name: 'English', exact: true }).click();
  assert.equal(await blockedPage.locator('html').getAttribute('lang'), 'en');
  assert.deepEqual(blockedErrors, []);
  await blockedStorage.close();
  checks.push('WE01/WE03: bilingual copy, download links, live previews, 4 responsive widths, persistence, browser-language override, keyboard/focus, outside dismissal and unavailable storage');
  for (const [platform, file] of [['windows', 'XwX-Deck-windows-x64.exe'], ['mac', 'XwX-Deck-mac-arm64.dmg'], ['macIntel', 'XwX-Deck-mac-x64.dmg']]) {
    const hrefs = await page.locator(`[data-download="${platform}"]`).evaluateAll(nodes => nodes.map(node => node.href));
    assert.equal(hrefs.length, 1);
    assert.ok(hrefs.every(href => href === 'https://github.com/Damue01/XwX_Deck/releases/latest/download/' + file));
  }
  assert.equal(await page.getByRole('link', { name: 'GitHub', exact: true }).getAttribute('href'), 'https://github.com/Damue01/XwX_Deck');
  assert.equal(await page.getByRole('link', { name: '反馈问题', exact: true }).count(), 0);
  assert.equal(await page.locator('header nav a').count(), 1);
  assert.equal(await page.locator('.preview-tools').count(), 0);
  assert.equal(await page.locator('.community-copy').innerText(), '感谢您的使用');
  assert.match(await page.locator('body').evaluate(el => getComputedStyle(el).fontFamily), /Urbanist.*Noto Sans SC/);
  checks.push('WE02: one recommended download and an accessible list of published packages use GitHub latest; the closing section has three community text links');
  await page.goto(url + '/configured/index.html', { waitUntil: 'networkidle' });
  const download = page.waitForEvent('download');
  await page.locator('#recommended-download').click();
  assert.equal((await download).suggestedFilename(), 'fixture.exe');
  checks.push('WE02: configured download resolves to the selected artifact fixture');
  // Exercise browser-reported architectures and conservative fallbacks in real DOMs.
  const profiles = [
    { name: 'Apple Silicon', platform: 'macOS', arch: 'arm', direct: 'mac' },
    { name: 'Intel Mac', platform: 'macOS', arch: 'x86', direct: 'macIntel' },
    { name: 'Windows x64', platform: 'Windows', arch: 'x86', direct: 'windows' },
    { name: 'Windows ARM64', platform: 'Windows', arch: 'arm', context: '当前提供 Windows x64 下载，尚无原生 ARM64 版。' },
    { name: 'Windows 32-bit', platform: 'Windows', arch: 'x86', bitness: '32' },
    { name: 'Safari MacIntel', platform: 'MacIntel', hints: 'absent' },
    { name: 'rejected hints', platform: 'macOS', hints: 'reject' },
    { name: 'missing architecture', platform: 'macOS', arch: '' },
    { name: 'mobile', platform: 'Android', mobile: true },
    { name: 'iPad desktop mode', platform: 'MacIntel', touch: 5, hints: 'absent' },
    { name: 'unknown', platform: 'unknown', hints: 'absent' },
  ];
  async function profilePage(profile) {
    const context = await browser.newContext({ reducedMotion: 'reduce', locale: 'zh-CN', viewport: { width: 390, height: 844 } });
    await context.addInitScript(profile => {
      Object.defineProperty(navigator, 'platform', { value: profile.platform });
      Object.defineProperty(navigator, 'userAgent', { value: profile.platform });
      Object.defineProperty(navigator, 'maxTouchPoints', { value: profile.touch || 0 });
      const hints = () => {
        if (profile.hints === 'reject') return Promise.reject(new Error('Hints denied'));
        const data = { architecture: profile.arch, bitness: profile.bitness || '64' };
        if (profile.hints === 'pending') return new Promise(resolve => { window.resolveDownloadHints = () => resolve(data); });
        return Promise.resolve(data);
      };
      Object.defineProperty(navigator, 'userAgentData', { value: profile.hints === 'absent' ? undefined : {
        platform: profile.platform, mobile: !!profile.mobile, getHighEntropyValues: hints,
      } });
    }, profile);
    const candidate = await context.newPage();
    candidate.on('pageerror', error => errors.push(String(error)));
    await candidate.goto(url, { waitUntil: 'domcontentloaded' });
    return { context, candidate };
  }
  for (const profile of profiles) {
    const { context, candidate } = await profilePage(profile);
    assert.equal(await candidate.locator('#download-caption').count(), 0);
    if (profile.context) await candidate.getByText(profile.context, { exact: true }).waitFor({ state: 'attached' });
    const primary = candidate.locator('#recommended-download');
    if (profile.direct) {
      await candidate.waitForFunction(target => document.querySelector('#recommended-download').href === document.querySelector(`[data-download="${target}"]`).href, profile.direct);
      assert.equal(await primary.getAttribute('href'), await candidate.locator(`[data-download="${profile.direct}"]`).getAttribute('href'));
    } else {
      assert.equal(await primary.getAttribute('href'), '#download-choices', profile.name + ' must not guess an unavailable architecture');
      await primary.click();
      assert.equal(await candidate.locator('#download-options').getAttribute('open'), '');
      assert.equal(await candidate.locator('[data-download="mac"]').evaluate(node => node === document.activeElement), true);
      await candidate.locator('.chip-help > summary').click();
      assert.match(await candidate.locator('.chip-help p').innerText(), /关于本机/);
      await candidate.locator('#download-options > summary').click();
    }
    assert.equal(await candidate.locator('a.download-choice[href*="mac-x64"]').count(), 1);
    assert.equal(await candidate.locator('.download-history').getAttribute('href'), 'https://github.com/Damue01/XwX_Deck/releases');
    await context.close();
  }
  for (const interaction of ['pointer', 'keyboard', 'timeout']) {
    const { context, candidate } = await profilePage({ platform: 'macOS', arch: 'arm', hints: 'pending' });
    if (interaction === 'pointer') await candidate.locator('#recommended-download').click();
    if (interaction === 'keyboard') {
      await candidate.locator('#download-options > summary').focus();
      await candidate.keyboard.press('Enter');
    }
    if (interaction === 'timeout') await candidate.waitForTimeout(650);
    await candidate.evaluate(() => window.resolveDownloadHints());
    await candidate.waitForTimeout(50);
    assert.equal(await candidate.locator('#recommended-download').getAttribute('href'), '#download-choices', 'late hints cannot replace a user choice or exceed the detection deadline');
    if (interaction !== 'timeout') {
      assert.equal(await candidate.locator('#download-options').getAttribute('open'), '');
      await candidate.locator('h1').click();
      assert.equal(await candidate.locator('#download-options').getAttribute('open'), null);
    }
    await context.close();
  }
  const noScript = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const fallback = await noScript.newPage();
  await fallback.goto(url, { waitUntil: 'domcontentloaded' });
  await fallback.locator('#download-options > summary').click();
  assert.equal(await fallback.locator('[data-download="windows"]').isVisible(), true);
  assert.equal(await fallback.locator('[data-download="mac"]').isVisible(), true);
  assert.equal(await fallback.locator('[data-download="macIntel"]').isVisible(), true);
  await noScript.close();
  checks.push('WE02: 11 OS/architecture profiles, mobile and iPad, missing/denied hints, pointer/keyboard choice preservation, timeout, Escape/outside dismissal and no-JavaScript downloads');
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url + '/?demo=dashboard#experience', { waitUntil: 'networkidle' });
    assert.equal(await page.locator('#tab-dashboard').getAttribute('aria-selected'), 'true');
    await page.frameLocator('#dashboard-demo').locator('.dash-table').waitFor();
    assert.equal(await page.locator('#app-demo').isVisible(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.XWX_SITE_TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.XWX_SITE_TEST_SCREENSHOT_DIR, `linked-dashboard-${width}.png`) });
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('#tab-dashboard').getAttribute('aria-selected'), 'true');
    await page.goto(url + '/?demo=models#experience', { waitUntil: 'networkidle' });
    assert.equal(await page.locator('#tab-models').getAttribute('aria-selected'), 'true');
    await page.frameLocator('#app-demo').locator('#page-models.current').waitFor();
  }
  await page.goto(url + '/?demo=unknown#experience', { waitUntil: 'networkidle' });
  assert.equal(await page.locator('#tab-models').getAttribute('aria-selected'), 'true');
  checks.push('WE04: README deep links select the dashboard or models on desktop and mobile, survive reload, and ignore unknown demo values');
  await page.getByRole('tab', { name: '查看仪表盘', exact: true }).click();
  await page.frameLocator('#dashboard-demo').locator('.dash-table').waitFor();
  const viewer = await browser.newPage();
  await viewer.goto(url + '/view.html', { waitUntil: 'networkidle' });
  await viewer.waitForLoadState('networkidle');
  assert.ok(new URL(viewer.url()).pathname.endsWith('/view.html'));
  assert.equal(await viewer.title(), 'XwX Deck 仪表盘：真实请求脱敏示例');
  assert.equal(await viewer.locator('.dash-table tbody tr').count(), examples.state.sessions.length);
  assert.match(await viewer.locator('.site-example-label').innerText(), /真实请求，已脱敏/);
  assert.match(await viewer.locator('.dash-table').innerText(), /gpt-6.1-sol/);
  assert.doesNotMatch(await viewer.locator('.dash-table').innerText(), /LIVE/);
  if (process.env.XWX_SITE_TEST_SCREENSHOT_DIR) await viewer.screenshot({ path: join(process.env.XWX_SITE_TEST_SCREENSHOT_DIR, 'real-dashboard.png') });
  for (const session of examples.state.sessions) {
    const row = viewer.locator('.dash-table tbody tr').filter({ hasText: session.title });
    assert.equal(Number((await row.locator('[data-col="tokens"]').innerText()).replace(/\D/g, '')), session.totalTokens);
    await row.click();
    await viewer.locator('#traceList').waitFor();
    const last = examples.state.traces.filter(trace => trace.sessionId === session.id).at(-1);
    await viewer.locator('#traceList [data-id="' + last.id + '"]').click();
    assert.equal(await viewer.locator('#traceList [aria-pressed="true"]').count(), 1);
    assert.match(await viewer.locator('#detail').innerText(), new RegExp(last.usage.totalTokens.toLocaleString('en-US')));
    if (session.title.includes('天气') && process.env.XWX_SITE_TEST_SCREENSHOT_DIR) await viewer.screenshot({ path: join(process.env.XWX_SITE_TEST_SCREENSHOT_DIR, 'real-weather-request.png') });
    await viewer.locator('#brandHome').click();
  }
  await viewer.close();
  assert.equal(await readFile(join(site, 'view.html'), 'utf8'), await readFile(join(site, 'viewer.html'), 'utf8'));
  checks.push('WE03: the reviewed weather conversation renders all requests and preserved usage; view.html and viewer.html agree');
  checks.push('Privacy: reviewed fixture passes the public-field contract and a credential-bearing fixture is rejected');
  assert.deepEqual(errors, []);
  if (process.env.XWX_SITE_TEST_SCREENSHOT) await page.screenshot({ path: process.env.XWX_SITE_TEST_SCREENSHOT, fullPage: true });
  const report = { passed: true, previewDirectory: 'test-results/site-preview', evidenceLevel: 'P', browser: 'Chrome/Playwright', browserPlugin: 'not available', checks, consoleErrors: errors,
    scope: 'Local static site and production renderer; 12 sanitized real official upstream requests, synthetic configuration accounts and download fixtures. No credentials are used during browser tests.' };
  if (process.env.XWX_SITE_TEST_REPORT) { await mkdir(resolve(process.env.XWX_SITE_TEST_REPORT, '..'), { recursive: true }); await writeFile(process.env.XWX_SITE_TEST_REPORT, JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
