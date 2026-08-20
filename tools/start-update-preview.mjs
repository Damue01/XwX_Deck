import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const targetVersion = String(packageJson.version || '').trim();
const baselineVersion = process.env.XWX_DECK_PREVIEW_BASELINE_VERSION || '1.0.0';
const baselineArtifact = resolve(root, 'update-preview', 'baseline-build', `XwX Deck-${baselineVersion}.exe`);
const updateArtifact = resolve(root, 'release', 'XwX Deck.exe');
const runRoot = resolve(root, 'update-preview', `run-${Date.now()}`);
const workingExecutable = join(runRoot, 'XwX Deck.exe');
const userData = join(runRoot, 'user-data');
const home = join(runRoot, 'home');
const statePath = resolve(root, 'update-preview', 'preview-state.json');
const previewBytesPerSecond = Math.max(
  256 * 1024,
  Number(process.env.XWX_DECK_PREVIEW_BYTES_PER_SECOND) || 4 * 1024 * 1024
);

if (baselineVersion === targetVersion) throw new Error('Preview baseline and target versions must differ.');
await Promise.all([stat(baselineArtifact), stat(updateArtifact)]);
await mkdir(home, { recursive: true });
await copyFile(baselineArtifact, workingExecutable);

const updateBytes = await readFile(updateArtifact);
const updateSha512 = createHash('sha512').update(updateBytes).digest('base64');
const updateName = 'XwX Deck.exe';
const updateUrlName = encodeURIComponent(updateName);

const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/xwxdeck/channels/release/latest.yml') {
    const manifest = [
      `version: ${targetVersion}`,
      'files:',
      `  - url: ../../releases/release/${updateUrlName}`,
      `    sha512: ${updateSha512}`,
      `    size: ${updateBytes.length}`,
      `path: ../../releases/release/${updateUrlName}`,
      `sha512: ${updateSha512}`,
      `releaseDate: '${new Date().toISOString()}'`,
      ''
    ].join('\n');
    response.writeHead(200, {
      'content-type': 'text/yaml; charset=utf-8',
      'content-length': Buffer.byteLength(manifest)
    });
    if (request.method === 'HEAD') response.end();
    else response.end(manifest);
    return;
  }
  if (url.pathname === `/xwxdeck/releases/release/${updateUrlName}`) {
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': updateBytes.length,
      'cache-control': 'no-store'
    });
    if (request.method === 'HEAD') response.end();
    else streamPreviewArtifact(response, updateBytes, previewBytesPerSecond);
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('Not found');
});

await new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolveListen);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Preview server did not expose a TCP port.');
const serverUrl = `http://127.0.0.1:${address.port}`;

const child = spawn(workingExecutable, [], {
  detached: true,
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    XWX_DECK_UPDATE_PREVIEW: '1',
    XWX_DECK_PREVIEW_USER_DATA: userData,
    XWX_DECK_UPDATE_SERVER_URL: serverUrl
  },
  stdio: 'ignore',
  windowsHide: false
});
child.unref();

await writeFile(statePath, `${JSON.stringify({
  serverPid: process.pid,
  clientPid: child.pid,
  serverUrl,
  baselineVersion,
  targetVersion,
  previewBytesPerSecond,
  workingExecutable,
  userData,
  startedAt: new Date().toISOString()
}, null, 2)}\n`, 'utf8');

console.log(`[update-preview] ${baselineVersion} -> ${targetVersion}`);
console.log(`[update-preview] server ${serverUrl}`);
console.log(`[update-preview] client ${workingExecutable}`);
console.log(`[update-preview] throttled download ${Math.round(previewBytesPerSecond / 1024 / 1024)} MiB/s`);

const expiry = setTimeout(() => server.close(), 30 * 60 * 1000);
server.on('close', () => clearTimeout(expiry));

function streamPreviewArtifact(response, bytes, bytesPerSecond) {
  const intervalMs = 100;
  const chunkSize = Math.max(64 * 1024, Math.floor(bytesPerSecond * intervalMs / 1000));
  let offset = 0;
  let timer;
  const send = () => {
    if (response.destroyed || response.writableEnded) return;
    const end = Math.min(bytes.length, offset + chunkSize);
    response.write(bytes.subarray(offset, end));
    offset = end;
    if (offset >= bytes.length) {
      response.end();
      return;
    }
    timer = setTimeout(send, intervalMs);
  };
  response.once('close', () => { if (timer) clearTimeout(timer); });
  send();
}
