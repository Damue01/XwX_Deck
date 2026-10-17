import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createMarkdownRenderer } from 'vitepress';
import { readerContent } from '../../docs/.vitepress/reader-content.mjs';

// Exercise the assembled /docs/ deployment, including its real homepage entry.
const module = process.env.XWX_PLAYWRIGHT_MODULE;
const { chromium } = await import(module ? pathToFileURL(resolve(module)).href : 'playwright');
const root = resolve(import.meta.dirname, '../..');
const site = resolve(process.env.XWX_SITE_PREVIEW_DIR ?? join(root, 'test-results/site-preview'));
const errors = [];
const checks = [];
const readerPages = new Set((await readdir(join(site, 'docs'))).filter(file => file.endsWith('.html') && file !== '404.html').map(file => file.replace(/\.html$/, '.md')));
const markdown = await createMarkdownRenderer(join(root, 'docs'), {
  config: md => readerContent(md, { readerPages, docsRoot: join(root, 'docs'), base: '/docs/' })
}, '/docs/');
const checklist = await readFile(join(root, 'docs/core-functional-acceptance-checklist.md'), 'utf8');
const fixtureBody = await markdown.renderAsync(checklist + '\n\n## 链接检查\n\n[未开放入口](not-published.md)\n\n[维护清单入口](core-functional-acceptance-checklist.md)\n\n[缺少文件入口](../tools/native/missing.mjs)\n\n[可用入口](trace-and-usage.md)\n', {
  relativePath: 'core-functional-acceptance-checklist.md',
  path: join(root, 'docs/core-functional-acceptance-checklist.md'),
  cleanUrls: true
});
const fixtureStyles = (await readFile(join(site, 'docs/index.html'), 'utf8')).match(/<link\b(?=[^>]*\brel="[^"]*\bstylesheet\b[^"]*")[^>]*>/g) || [];
assert.ok(fixtureStyles.length, 'Table fixture uses the built documentation theme');
const fixtureHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="/docs/icon.png">${fixtureStyles.join('')}</head><body><main class="vp-doc" style="max-width:720px;margin:40px auto;padding:0 24px">${fixtureBody}</main></body></html>`;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (pathname === '/docs/__table-layout-check') {
    response.writeHead(200, { 'content-type': mime['.html'] }); response.end(fixtureHtml); return;
  }
  const relative = pathname.endsWith('/') ? pathname + 'index.html' : extname(pathname) ? pathname : pathname + '.html';
  const file = resolve(site, '.' + relative);
  if (!file.startsWith(site + '/')) { response.writeHead(403); response.end(); return; }
  try {
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ ...(process.env.XWX_PLAYWRIGHT_CHANNEL === 'chromium' ? {} : { channel: 'chrome' }), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(origin, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('h1').innerText(), '好工具，更简单');
  await page.getByRole('link', { name: '文档', exact: true }).click();
  await page.waitForURL(origin + '/docs/');
  await page.locator('.vp-doc h1').waitFor();
  assert.equal((await page.locator('.vp-doc h1').textContent()).replace(/\u200b/g, '').trim(), '快速开始');
  assert.equal(await page.locator('.VPHome').count(), 0);
  checks.push('Homepage slogan and direct documentation reading entry');

  for (const width of [320, 390, 780, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(origin + '/docs/', { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const style = await page.locator('.vp-doc').evaluate(el => {
      const css = getComputedStyle(el);
      return { family: css.fontFamily, weight: css.fontWeight, size: parseFloat(css.fontSize), overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.match(style.family, /Urbanist.*Noto Sans SC/);
    assert.equal(style.weight, '450');
    assert.equal(await page.locator('.vp-doc h1').evaluate(el => getComputedStyle(el).fontWeight), '500');
    assert.equal(await page.locator('.vp-doc h2').first().evaluate(el => getComputedStyle(el).fontWeight), '500');
    assert.ok(style.size >= 15);
    assert.equal(style.overflow, false, `No page overflow at ${width}`);
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    if (width < 960) {
      await page.getByRole('button', { name: '文档目录', exact: true }).click();
      await page.locator('.VPSidebar.open').waitFor();
    }
    await page.locator('.VPSidebar').getByRole('link', { name: 'Trace 与用量', exact: true }).click();
    await page.waitForURL(origin + '/docs/trace-and-usage');
    await page.locator('.vp-doc h1').filter({ hasText: 'Trace 与用量' }).waitFor();
    assert.equal((await page.locator('.vp-doc h1').textContent()).replace(/\u200b/g, '').trim(), 'Trace 与用量');
    assert.equal(await page.locator('.VPSidebar.open').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.XWX_SITE_TEST_SCREENSHOT_DIR) {
      await mkdir(process.env.XWX_SITE_TEST_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.XWX_SITE_TEST_SCREENSHOT_DIR, `docs-trace-${width}.png`) });
      await page.goto(origin + '/docs/', { waitUntil: 'networkidle' });
      await page.screenshot({ path: join(process.env.XWX_SITE_TEST_SCREENSHOT_DIR, `docs-start-${width}.png`) });
    }
    checks.push(`Reading typography, navigation and overflow at ${width}px`);
  }

  const routes = ['download', 'connections', 'models-and-clients', 'accounts-and-switching', 'trace-and-usage', 'settings-and-data', 'troubleshooting', 'user-manual', 'getting-started', 'macos-first-run', 'provider-compatibility', 'about'];
  const publicHtml = new Set(['index.html', '404.html', ...routes.map(route => route + '.html')]);
  const builtHtml = (await readdir(join(site, 'docs'), { recursive: true })).filter(file => file.endsWith('.html'));
  assert.deepEqual(builtHtml.sort(), [...publicHtml].sort(), 'Only user manual chapters are published');
  assert.equal(await page.locator('.VPSidebar a[href*="public-release-boundary"]').count(), 0);
  for (const route of ['', ...routes]) {
    await page.goto(`${origin}/docs/${route}`, { waitUntil: 'networkidle' });
    assert.ok(((await page.locator('.vp-doc h1').textContent()).replace(/\u200b/g, '').trim()).length);
    assert.doesNotMatch(await page.locator('.vp-doc').innerText(), /[a-f0-9]{40,64}|选择性同步|源码指纹|本地候选|当前源码验收|整合验收/i);
    const decoratedExternalLinks = await page.locator('.vp-external-link-icon, .vp-doc a[href*="://"], .vp-doc a[target="_blank"]').evaluateAll(links => links.filter(link => {
      const after = getComputedStyle(link, '::after');
      return !['none', 'normal'].includes(after.content) && after.display !== 'none';
    }).length);
    assert.equal(decoratedExternalLinks, 0, 'Documentation external links must not display decorative arrows');
    const links = await page.locator('a[href]').evaluateAll(links => links.map(link => link.href));
    for (const href of new Set(links)) {
      const url = new URL(href);
      if (url.origin !== origin) continue;
      const path = url.pathname.endsWith('/') ? url.pathname + 'index.html' : extname(url.pathname) ? url.pathname : url.pathname + '.html';
      const html = await readFile(join(site, path), 'utf8');
      if (url.hash) assert.ok(html.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`), `Missing anchor: ${href}`);
    }
  }
  checks.push('Only user manual chapters are published; no internal reports, commit hashes or broken reader links');

  for (const width of [320, 390, 780, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(origin + '/docs/__table-layout-check', { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('tbody tr').count(), 74, 'Every checklist entry renders as a table row');
    assert.equal(await page.locator('tbody tr').evaluateAll(rows => rows.every(row => row.cells.length === 4)), true);
    const layout = await page.locator('.doc-table-scroll').evaluateAll(tables => tables.map(table => ({
      width: table.getBoundingClientRect().width,
      articleWidth: table.closest('.vp-doc').clientWidth,
      overflowing: table.scrollWidth > table.clientWidth,
      scrollable: getComputedStyle(table).overflowX === 'auto',
      cellsFit: [...table.querySelectorAll('th,td')].every(cell => cell.scrollWidth <= cell.clientWidth + 1)
    })));
    if (process.env.XWX_SITE_TEST_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.XWX_SITE_TEST_SCREENSHOT_DIR, `docs-tables-${width}.png`) });
    assert.ok(layout.every(table => table.width <= table.articleWidth && table.scrollable && table.cellsFit), `Contained table layout at ${width}px: ${JSON.stringify(layout)}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const table = page.locator('.doc-table-scroll').first();
    await table.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    assert.equal(await table.evaluate(el => el.scrollLeft > 0), layout[0].overflowing, 'Overflowing tables can scroll to their last column');
    await table.evaluate(el => { el.scrollLeft = 0; });
    for (const name of ['未开放入口', '维护清单入口', '缺少文件入口']) {
      const unavailable = page.getByText(name, { exact: true });
      assert.equal(await unavailable.getAttribute('aria-disabled'), 'true');
      assert.equal(await unavailable.getAttribute('href'), null);
      await unavailable.click();
      assert.equal(new URL(page.url()).pathname, '/docs/__table-layout-check');
    }
    await page.getByRole('link', { name: '可用入口', exact: true }).click();
    await page.waitForURL(origin + '/docs/trace-and-usage');
    checks.push(`All 74 checklist rows, horizontal table scrolling and disabled missing links at ${width}px`);
  }

  for (const route of ['download', 'user-manual', 'trace-and-usage', 'provider-compatibility']) {
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${origin}/docs/${route}`, { waitUntil: 'networkidle' });
      assert.equal(await page.locator('.vp-doc table').evaluateAll(tables => tables.every(table => table.parentElement.classList.contains('doc-table-scroll'))), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
  }
  checks.push('All public table chapters stay within the reading column on desktop and mobile');

  await page.goto(origin + '/docs/', { waitUntil: 'networkidle' });
  const heading = page.locator('.vp-doc h2').first();
  await heading.hover();
  const anchor = heading.locator('.header-anchor');
  const symbol = await anchor.evaluate(el => getComputedStyle(el, '::before').content);
  assert.equal(symbol, '""', 'Heading links use an icon instead of the raw hash character');
  const headingBox = await heading.boundingBox();
  const anchorBox = await anchor.boundingBox();
  assert.ok(Math.abs(anchorBox.y + anchorBox.height / 2 - headingBox.y - headingBox.height / 2) < 1, 'Heading link stays vertically aligned');
  await anchor.click();
  assert.match(decodeURIComponent(new URL(page.url()).hash), /安装与准备/);
  checks.push('Heading hover uses an aligned link icon and retains permalink navigation');
  await page.locator('.VPDocAsideOutline').getByRole('link', { name: '3. 选择模型', exact: true }).click();
  assert.match(decodeURIComponent(new URL(page.url()).hash), /选择模型/);
  await page.waitForFunction(() => {
    const heading = [...document.querySelectorAll('.vp-doc h2')].find(el => el.textContent.includes('3. 选择模型'));
    const y = heading?.getBoundingClientRect().y;
    return y >= 76 && y < 300;
  });
  const section = await page.locator('h2').filter({ hasText: '3. 选择模型' }).boundingBox();
  assert.ok(section.y >= 76 && section.y < 300, 'Outline scroll keeps the heading below navigation');
  await page.getByRole('button', { name: '搜索文档', exact: true }).click();
  const input = page.getByPlaceholder('搜索文档', { exact: true });
  await input.fill('自动清理');
  await page.locator('.VPLocalSearchBox a[href*="/trace-and-usage"]').first().waitFor();
  assert.ok(!(await page.locator('.VPLocalSearchBox').innerText()).includes('历史技术吸收记录'));
  await input.fill('Trace');
  const result = page.locator('.VPLocalSearchBox a[href*="/trace-and-usage"]').first();
  await result.waitFor();
  await result.click();
  await page.waitForURL(/\/docs\/trace-and-usage/);
  await page.locator('.vp-doc h1').filter({ hasText: 'Trace 与用量' }).waitFor();
  assert.equal((await page.locator('.vp-doc h1').textContent()).replace(/\u200b/g, '').trim(), 'Trace 与用量');
  await page.getByRole('link', { name: '下一篇 设置与本地数据', exact: true }).click();
  await page.waitForURL(origin + '/docs/settings-and-data');
  checks.push('Outline scroll, Chinese/Latin local search and next-chapter navigation');
  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole('button', { name: '搜索文档', exact: true }).click();
  await page.getByPlaceholder('搜索文档', { exact: true }).fill('自动清理');
  const mobileResult = page.locator('.VPLocalSearchBox a[href*="/trace-and-usage"]').first();
  await mobileResult.waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobileResult.click();
  await page.waitForURL(/\/docs\/trace-and-usage/);
  await page.locator('.vp-doc h1').filter({ hasText: 'Trace 与用量' }).waitFor();
  checks.push('Mobile Chinese search opens the matching chapter');
  assert.deepEqual(errors, [], 'No browser errors or failed assets');
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
