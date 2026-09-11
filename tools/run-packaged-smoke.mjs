import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { sanitizeClientEnv } from './sanitized-client-env.mjs';

const root = resolve(import.meta.dirname, '..');
const releaseDir = resolve(root, process.env.XWX_DECK_RELEASE_DIR || 'release');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const appVersion = String(packageJson.version || '').trim();
const productName = String(packageJson.build?.productName || packageJson.displayName || 'XwX Deck');
if (!/^\d+\.\d+\.\d+$/.test(appVersion)) throw new Error(`Invalid package version: ${appVersion}`);
const macUpdateVersion = appVersion.replace(/\.(\d+)$/, (_match, patch) => `.${Number(patch) + 1}`);
const macUpdateBytes = Buffer.from('packaged-manual-mac-update-dmg');
const macUpdateSha256 = createHash('sha256').update(macUpdateBytes).digest('hex');

const temp = await mkdtemp(join(tmpdir(), 'xwx_deck-packaged-smoke-'));
let passed = false;
const executable = await resolvePackagedExecutable();
const userData = join(temp, 'user-data');
const clientHome = join(temp, 'home');
const codexHome = join(clientHome, '.codex');
const claudePath = join(clientHome, '.claude', 'settings.json');
const codexPath = join(codexHome, 'config.toml');
const codexAuthPath = join(codexHome, 'auth.json');
const codexSessionPath = join(codexHome, 'sessions', '2026', '07', '17', 'official.jsonl');
const resultPath = join(temp, 'result.json');
let updateServer;
let upstreamServer;
let tracedUpstreamRequests = 0;
let compatibleServiceRoot = '';
let claudeOriginal = '';
let codexOriginal = '';
const codexAuthOriginal = '{\r\n  "auth_mode": "chatgpt",\r\n  "tokens": { "access_token": "packaged-oauth-secret" }\r\n}\r\n';
const codexSessionOriginal = '{"type":"session_meta","payload":{"id":"packaged-official","model_provider":"openai"}}\n'
  + '{"type":"response_item","payload":{"role":"user","content":"packaged history body"}}\n';
try {
  await access(executable);
  upstreamServer = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (body.includes('packaged-trace-e2e')) tracedUpstreamRequests += 1;
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      if (request.url?.includes('/models')) {
        response.end(JSON.stringify({ data: [{ id: 'packaged-trace-model', object: 'model' }] }));
        return;
      }
      response.end(JSON.stringify({
        id: 'msg_packaged_trace',
        type: 'message',
        role: 'assistant',
        model: 'packaged-trace-model',
        content: [{ type: 'text', text: 'packaged trace captured' }],
        usage: { input_tokens: 4, output_tokens: 3 }
      }));
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    upstreamServer.once('error', rejectListen);
    upstreamServer.listen(0, '0.0.0.0', resolveListen);
  });
  const upstreamAddress = upstreamServer.address();
  if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('Packaged smoke upstream did not expose a TCP port.');
  compatibleServiceRoot = `http://${nonLoopbackIpv4Address()}:${upstreamAddress.port}/qa-openai`;
  claudeOriginal = `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: `${compatibleServiceRoot}/anthropic` } }, null, 2)}\n`;
  codexOriginal = `model_provider = "compatible"\nmodel = "qa-model"\nservice_tier = "default"\n\n[model_providers.compatible]\nbase_url = "${compatibleServiceRoot}/v1"\nwire_api = "responses"\nrequires_openai_auth = true\nexperimental_bearer_token = "packaged-compatible-key"\nname = "兼容服务"\n\n[features]\njs_repl = false\nimage_gen = true\n`;
  await mkdir(dirname(claudePath), { recursive: true });
  await mkdir(dirname(codexPath), { recursive: true });
  await mkdir(dirname(codexSessionPath), { recursive: true });
  await writeFile(claudePath, claudeOriginal, 'utf8');
  await writeFile(codexPath, codexOriginal, 'utf8');
  await writeFile(codexAuthPath, codexAuthOriginal, 'utf8');
  await writeFile(codexSessionPath, codexSessionOriginal, 'utf8');

  updateServer = createServer((request, response) => {
    if (request.url?.split('?', 1)[0].endsWith('/release.json')) {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        channel: 'release',
        version: process.platform === 'darwin' ? macUpdateVersion : appVersion,
        publishedAt: new Date(0).toISOString(),
        files: process.platform === 'darwin'
          ? [{
              name: `XwX-Deck-mac-${process.arch}.dmg`,
              url: `http://127.0.0.1:${updateServer.address()?.port}/XwX-Deck-mac-${process.arch}.dmg`,
              size: macUpdateBytes.length,
              sha256: macUpdateSha256
            }]
          : [{ name: 'XwX Deck.exe', size: 1, sha256: '0'.repeat(64) }]
      }));
      return;
    }
    if (request.url?.split('?', 1)[0].endsWith(`/XwX-Deck-mac-${process.arch}.dmg`)) {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': macUpdateBytes.length
      });
      response.end(macUpdateBytes);
      return;
    }
    if (request.url?.split('?', 1)[0].endsWith('/latest.yml')) {
      const checksum = Buffer.alloc(64).toString('base64');
      response.writeHead(200, { 'content-type': 'text/yaml; charset=utf-8' });
      response.end([
        `version: ${appVersion}`,
        'files:',
        '  - url: XwX%20Deck.exe',
        `    sha512: ${checksum}`,
        '    size: 1',
        'path: XwX%20Deck.exe',
        `sha512: ${checksum}`,
        `releaseDate: ${new Date(0).toISOString()}`,
        ''
      ].join('\n'));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolveListen, rejectListen) => {
    updateServer.once('error', rejectListen);
    updateServer.listen(0, '127.0.0.1', resolveListen);
  });
  const updateAddress = updateServer.address();
  if (!updateAddress || typeof updateAddress === 'string') throw new Error('Packaged smoke update server did not expose a TCP port.');

  const env = {
    ...sanitizeClientEnv(),
    XWX_DECK_SMOKE_TEST: '1',
    XWX_DECK_SMOKE_IGNORE_EXTERNAL: '1',
    XWX_DECK_SMOKE_RESULT: resultPath,
    XWX_DECK_SMOKE_SCREENSHOTS: join(root, 'test-results', 'packaged-ui'),
    XWX_DECK_SMOKE_USER_DATA: userData,
    XWX_DECK_SMOKE_PRESERVE_TRACE: '1',
    XWX_DECK_SMOKE_COMPATIBLE_SERVICE_BASE_URL: `${compatibleServiceRoot}/v1`,
    XWX_DECK_SMOKE_COMPATIBLE_SERVICE_TOKEN: 'packaged-compatible-key',
    XWX_DECK_CLIENT_HOME: clientHome,
    CODEX_HOME: codexHome,
    XWX_DECK_UPDATE_SERVER_URL: `http://127.0.0.1:${updateAddress.port}`
  };
  if (process.platform === 'darwin') env.XWX_DECK_SMOKE_SKIP_STARTUP_TOGGLE = '1';

  // A first launch of a newly built portable executable must self-extract and
  // may be scanned by Defender before Electron starts. Keep the outer process
  // budget comfortably above the renderer's own 5 s assertions; 30 seconds
  // was short enough to kill the wrapper mid-smoke and then close the local
  // update fixture server underneath the still-running child process.
  const exitCode = await runProcess(executable, [], root, env, 90_000);

  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.equal(exitCode, 0, result.error || `packaged app exited with ${exitCode}`);
  assert.equal(result.ok, true);
  assert.equal(result.appVersion, appVersion);
  assert.equal(result.updateChannel, 'release');
  assert.equal(result.updateInstallMode, process.platform === 'darwin' ? 'manual-dmg' : 'automatic');
  if (process.platform === 'darwin') {
    assert.equal(result.updateStatus, 'ready');
    assert.equal(
      await readFile(join(userData, 'updates', `XwX-Deck-mac-${process.arch}.dmg`), 'utf8'),
      macUpdateBytes.toString('utf8')
    );
  }
  // Standalone surface plus the three read-only conversation-diagnosis methods.
  assert.equal(result.ipcMethods, 42);
  assert.ok(Math.abs(result.ui.clearRowHeight - 48) <= 0.25, "clearRowHeight exceeds subpixel tolerance");
  assert.deepEqual(result.ui.faviconSize, { width: 256, height: 256 });
  assert.ok(result.ui.appearanceRightDelta <= 1, `appearance controls are misaligned by ${result.ui.appearanceRightDelta}px`);
  assert.equal(result.ui.appearanceDividerWidth, 0);
  assert.ok(result.ui.appearanceSectionTitleSize > result.ui.appearanceOptionLabelSize);
  assert.ok(Math.abs(result.ui.clearIconSize - 32) <= 0.25, "clearIconSize exceeds subpixel tolerance");
  assert.ok(Math.abs(result.ui.clearIconOffset - 0) <= 0.25, "clearIconOffset exceeds subpixel tolerance");
  assert.ok(Math.abs(result.ui.clearIconVerticalOffset - 0) <= 0.25, "clearIconVerticalOffset exceeds subpixel tolerance");
  assert.equal(result.ui.clearIconFill, 'none');
  assert.equal(result.ui.startupRestored !== undefined, true);
  assert.equal(result.ui.themePersisted === 'day' || result.ui.themePersisted === 'night', true);
  assert.equal(result.ui.themeRestored === 'day' || result.ui.themeRestored === 'night', true);
  assert.deepEqual(result.ui.initialContentSize, { width: 1040, height: 560 });
  assert.deepEqual(result.ui.initialViewport, { width: 1040, height: 560 });
  assert.ok(Math.abs(result.ui.initialWindowBounds.width - 1040) <= 2, `unexpected DPI-adjusted window width: ${result.ui.initialWindowBounds.width}`);
  assert.ok(Math.abs(result.ui.initialWindowBounds.height - 560) <= 2, `unexpected DPI-adjusted window height: ${result.ui.initialWindowBounds.height}`);
  assert.equal(result.ui.fieldPausedOffPage, true);
  assert.equal(result.ui.fieldRenderer, '2d');
  assert.equal(result.ui.rendererReusedAfterTrayClose, true);
  assert.equal(result.ui.rendererRecreatedAfterCrash, true);
  assert.equal(result.ui.recoveredFieldRenderer, '2d');
  if (process.platform === 'darwin') {
    assert.deepEqual(result.ui.macApplicationIcon, {
      applied: false,
      width: 0,
      height: 0,
      cornerAlpha: 0,
      centerAlpha: 0
    });
  }
  assert.equal(result.traceCapture?.captured, true);
  assert.equal(result.traceCapture?.delta, 1);
  assert.equal(tracedUpstreamRequests, 1, 'the packaged Trace request must reach the isolated upstream exactly once');
  assert.equal(result.codexEnhancements.migrated.migratedJsonlFiles, 1);
  assert.equal(result.codexEnhancements.restored.restoredStateRows, 1);
  assert.deepEqual(result.clients.map(client => client.status), ['taken', 'taken']);
  assert.equal(await readFile(claudePath, 'utf8'), claudeOriginal);
  const stableCodexConfig = await readFile(codexPath, 'utf8');
  assert.match(stableCodexConfig, /^model_provider = "xwx_deck"$/m);
  assert.match(stableCodexConfig, /\[model_providers\.xwx_deck\][\s\S]*name = "Fixture API"/);
  assert.ok(stableCodexConfig.includes(`base_url = "${compatibleServiceRoot}/v1"`));
  assert.doesNotMatch(stableCodexConfig, /127\.0\.0\.1/);
  assert.match(stableCodexConfig, /\[features\][\s\S]*js_repl = false/);
  assert.match(stableCodexConfig, /\[features\][\s\S]*image_gen = true/);
  assert.equal(await readFile(codexAuthPath, 'utf8'), codexAuthOriginal);
  const restoredCodexSession = await readFile(codexSessionPath, 'utf8');
  const restoredCodexLines = restoredCodexSession.trimEnd().split(/\r?\n/);
  const restoredCodexMeta = JSON.parse(restoredCodexLines[0]);
  assert.equal(restoredCodexMeta.payload?.id, 'packaged-official');
  assert.equal(restoredCodexMeta.payload?.model_provider, 'openai');
  assert.equal(restoredCodexLines[1], '{"type":"response_item","payload":{"role":"user","content":"packaged history body"}}');
  const traceRoot = join(userData, 'xwx-trace');
  const traceFiles = (await readdir(traceRoot)).filter(name => name.endsWith('.jsonl'));
  assert.ok(traceFiles.length > 0, 'the packaged Trace request must create a session JSONL');
  const traceText = (await Promise.all(traceFiles.map(name => readFile(join(traceRoot, name), 'utf8')))).join('\n');
  assert.match(traceText, /packaged-trace-e2e/, 'the real packaged request body must be present in Trace JSONL');
  const capturedRecord = traceText.trim().split(/\r?\n/)
    .map(line => JSON.parse(line))
    .find(record => JSON.stringify(record.request?.body).includes('packaged-trace-e2e'));
  assert.ok(capturedRecord, 'the real packaged request must be readable from Trace JSONL');
  assert.equal(capturedRecord.response?.statusCode, 200, 'the real packaged request must receive the mock upstream response');
  assert.ok(String(capturedRecord.upstream?.url || '').startsWith(compatibleServiceRoot), 'the captured upstream URL must be the isolated 兼容服务 fixture');
  const traceIndex = await readFile(join(traceRoot, 'index.json'), 'utf8');
  assert.match(traceIndex, /"traceCount"\s*:\s*1/, 'the Trace index must count the real packaged request');
  console.log(JSON.stringify(result, null, 2));
  console.log(`PASS packaged XwX Deck ${process.platform === 'darwin' ? 'macOS' : 'portable'} real IPC smoke test`);
  passed = true;
} finally {
  if (updateServer) {
    await new Promise(resolveClose => updateServer.close(() => resolveClose()));
  }
  if (upstreamServer) {
    await new Promise(resolveClose => upstreamServer.close(() => resolveClose()));
  }
  if (passed) await rm(temp, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  else console.error(`[test:packaged] preserved failed smoke data at ${temp}`);
}

function nonLoopbackIpv4Address() {
  const interfaces = networkInterfaces();
  for (const preferred of ['en0', 'en1']) {
    for (const entry of interfaces[preferred] || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  for (const [name, entries] of Object.entries(interfaces)) {
    if (/^(utun|awdl|llw|lo)/.test(name)) continue;
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  throw new Error('Packaged Trace smoke requires a non-loopback IPv4 address for its isolated upstream.');
}

async function resolvePackagedExecutable() {
  if (process.platform !== 'darwin') return resolve(releaseDir, 'XwX Deck.exe');

  const appDirs = [
    process.env.XWX_DECK_MAC_APP_DIR,
    `mac-${process.arch}`,
    'mac'
  ].filter(Boolean);
  for (const appDir of appDirs) {
    const candidate = resolve(releaseDir, appDir, `${productName}.app`, 'Contents', 'MacOS', productName);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next electron-builder output directory.
    }
  }
  throw new Error(`Unable to find packaged macOS ${productName}.app under ${releaseDir}.`);
}

function runProcess(file, args, cwd, env, timeoutMs) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${file} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); resolveExit(code ?? 1); });
  });
}
