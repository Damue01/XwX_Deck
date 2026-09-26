import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { sanitizeClientEnv } from './sanitized-client-env.mjs';

const root = resolve(import.meta.dirname, '..');
const releaseDir = resolve(root, process.env.XWX_DECK_RELEASE_DIR || 'release');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const productName = String(packageJson.build?.productName || packageJson.displayName || 'XwX Deck');
const temp = await mkdtemp(join(tmpdir(), 'xwx-deck-packaged-helper-'));
const userData = join(temp, 'user-data');
const clientHome = join(temp, 'home');
const codexHome = join(clientHome, '.codex');
const claudeHome = join(clientHome, '.claude');
const resultPath = join(temp, 'result.json');
const bearerToken = randomBytes(24).toString('hex');
const model = 'xwx-packaged-helper-model';
let upstream;
let runtime;
let passed = false;

try {
  const executable = await resolvePackagedExecutable();
  await access(executable);
  await mkdir(codexHome, { recursive: true });
  await mkdir(claudeHome, { recursive: true });
  await writeFile(join(codexHome, 'config.toml'), 'model_provider = "openai"\nmodel = "gpt-5.5"\n', 'utf8');
  await writeFile(join(codexHome, 'auth.json'), '{"auth_mode":"chatgpt","tokens":{"access_token":"isolated-packaged-oauth"}}\n', 'utf8');

  upstream = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: model, object: 'model' }] }));
      return;
    }
    const body = await readRequest(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (pathname.endsWith('/chat/completions')) {
      res.end(JSON.stringify({
        id: 'chatcmpl_packaged_helper',
        object: 'chat.completion',
        model: body.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'packaged helper survived' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }));
      return;
    }
    if (pathname.endsWith('/messages')) {
      res.end(JSON.stringify({
        id: 'msg_packaged_helper_claude',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: 'packaged Claude fallback survived' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 }
      }));
      return;
    }
    res.end(JSON.stringify({
      id: 'resp_packaged_helper',
      object: 'response',
      status: 'completed',
      model: body.model,
      output: [{
        id: 'msg_packaged_helper',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'packaged helper survived' }]
      }],
      usage: { input_tokens: 1, output_tokens: 1 }
    }));
  });
  const upstreamPort = await listen(upstream, '0.0.0.0');
  const upstreamBaseUrl = `http://${nonLoopbackIpv4Address()}:${upstreamPort}/v1`;
  await writeFile(join(claudeHome, 'settings.json'), `${JSON.stringify({
    env: { ANTHROPIC_BASE_URL: upstreamBaseUrl }
  }, null, 2)}\n`, 'utf8');
  const env = {
    ...sanitizeClientEnv(),
    XWX_DECK_BACKGROUND_GATEWAY_SMOKE: '1',
    XWX_DECK_SMOKE_IGNORE_EXTERNAL: '1',
    XWX_DECK_SMOKE_USER_DATA: userData,
    XWX_DECK_SMOKE_RESULT: resultPath,
    XWX_DECK_CLIENT_HOME: clientHome,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    XWX_DECK_BACKGROUND_GATEWAY_UPSTREAM: upstreamBaseUrl,
    XWX_DECK_BACKGROUND_GATEWAY_TOKEN: bearerToken,
    XWX_DECK_BACKGROUND_GATEWAY_MODEL: model
  };
  const exitCode = await runProcess(executable, [], root, env, 45_000);
  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.equal(exitCode, 0, result.error || `packaged manager exited with ${exitCode}`);
  assert.equal(result.ok, true);
  assert.equal(result.backgroundGatewayActive, true);
  assert.equal(result.tracingEnabled, false);
  assert.equal(result.recordingEnabled, false);

  runtime = await waitForRuntime(join(userData, 'gateway', 'runtime.json'));
  assert.equal(runtime.helperProtocolVersion, 14, 'packaged helper must publish its compatibility protocol');
  assert.equal(result.localBaseUrl, `http://127.0.0.1:${runtime.gatewayPort}`);
  const response = await request(runtime.gatewayPort, '/v1/responses', {
    model,
    input: [{ role: 'user', content: 'manager already exited' }]
  }, 'POST', { 'user-agent': 'codex-tui/packaged-helper-smoke', originator: 'codex-tui' });
  assert.equal(response.status, 200, response.text);
  assert.equal(JSON.parse(response.text).output[0].content[0].text, 'packaged helper survived');
  const claudeConfig = JSON.parse(await readFile(join(claudeHome, 'settings.json'), 'utf8'));
  assert.equal(claudeConfig.env.ANTHROPIC_BASE_URL, upstreamBaseUrl.replace(/\/v1$/, '/anthropic'),
    'packaged Trace stop must restore Claude disk config to the upstream');
  const traceCountBeforeClaude = await readTraceCount(runtime.gatewayPort);
  const claudeResponse = await request(runtime.gatewayPort, '/v1/messages', {
    model: 'claude-packaged-fallback',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'manager already exited' }]
  }, 'POST', {
    'user-agent': 'claude-cli/packaged-helper-smoke',
    'x-api-key': 'isolated-packaged-claude-key',
    'anthropic-version': '2023-06-01'
  });
  assert.equal(claudeResponse.status, 200, claudeResponse.text);
  assert.equal(JSON.parse(claudeResponse.text).content[0].text, 'packaged Claude fallback survived');
  await delay(150);
  assert.equal(await readTraceCount(runtime.gatewayPort), traceCountBeforeClaude,
    'packaged non-recording Claude fallback must not append a Trace record');

  const token = (await readFile(join(userData, 'gateway', 'control.token'), 'utf8')).trim();
  const status = await request(runtime.controlPort, '/control/status', undefined, 'GET', { authorization: `Bearer ${token}` });
  assert.equal(JSON.parse(status.text).helperProtocolVersion, 14);
  await request(runtime.controlPort, '/control/stop', {}, 'POST', { authorization: `Bearer ${token}` });
  await waitForClosed(runtime.controlPort);
  console.log('PASS packaged ASAR Gateway survives manager exit and serves non-recording Claude/ChatGPT fallbacks');
  passed = true;
} finally {
  if (runtime?.controlPort) {
    const token = await readFile(join(userData, 'gateway', 'control.token'), 'utf8').then(v => v.trim()).catch(() => '');
    if (token) await request(runtime.controlPort, '/control/stop', {}, 'POST', { authorization: `Bearer ${token}` }).catch(() => undefined);
  }
  if (upstream) await close(upstream);
  if (passed) await rm(temp, {
    recursive: true,
    force: true,
    maxRetries: 15,
    retryDelay: 200
  });
  else console.error(`[test:packaged-helper] preserved failed smoke data at ${temp}`);
}

async function resolvePackagedExecutable() {
  if (process.platform !== 'darwin') return resolve(releaseDir, 'XwX Deck.exe');
  for (const appDir of [process.env.XWX_DECK_MAC_APP_DIR, `mac-${process.arch}`, 'mac'].filter(Boolean)) {
    const candidate = resolve(releaseDir, appDir, `${productName}.app`, 'Contents', 'MacOS', productName);
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error(`Unable to find packaged ${productName}.app under ${releaseDir}.`);
}

function nonLoopbackIpv4Address() {
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (/^(utun|awdl|llw|lo)/.test(name)) continue;
    for (const entry of entries || []) if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  }
  throw new Error('Packaged helper smoke requires a non-loopback IPv4 address.');
}

function listen(server, host) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('server has no TCP port'));
      else resolveListen(address.port);
    });
  });
}

function close(server) { return new Promise(resolveClose => server.close(() => resolveClose())); }

async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function request(port, pathname, body, method, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolveRequest, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, timeout: 5_000,
      headers: {
        ...headers,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolveRequest({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`request timed out: ${pathname}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function runProcess(file, args, cwd, env, timeoutMs) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${file} timed out after ${timeoutMs} ms.`)); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolveExit(code ?? 1); });
  });
}

async function waitForRuntime(file) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch {}
    await delay(50);
  }
  throw new Error('Packaged helper did not publish runtime.json.');
}

async function waitForClosed(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { await request(port, '/control/status', undefined, 'GET'); } catch { return; }
    await delay(50);
  }
  throw new Error('Packaged helper did not stop.');
}

async function readTraceCount(port) {
  const response = await request(port, '/api/state', undefined, 'GET', { accept: 'application/json' });
  assert.equal(response.status, 200, response.text);
  const state = JSON.parse(response.text);
  return (state.sessions || []).reduce((total, session) => total + Number(session.traceCount || 0), 0);
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
