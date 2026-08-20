// Local browser preview server for the built renderer.
//
// The renderer ships a browser-only mock API (src/renderer/bridge/previewApi.ts)
// that fabricates realistic data, so you can open the whole Manager UI in a plain
// browser — no Electron, no real client config touched.
//
//   npm run preview            # then open the printed URL
//
// Optional scenario: ?update=1 shows the update-available toast.
//
// Bind is loopback-only; nothing is exposed off the machine.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'renderer');
const PORT = Number(process.env.PREVIEW_PORT) || 8899;
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error(`[preview] dist/renderer/index.html not found — run "npm run compile" first.`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  // Keep every request inside dist/renderer.
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback: unknown paths serve index.html.
      fs.readFile(path.join(ROOT, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  const base = `http://${HOST}:${PORT}/index.html`;
  console.log(`\n  XwX Deck 浏览器预览已启动（仅本机可访问）\n`);
  console.log(`  常规界面       ${base}`);
  console.log(`  更新提示演示   ${base}?update=1`);
  console.log(`\n  Ctrl+C 结束预览。\n`);
});
