import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { sanitizeClientEnv } from './sanitized-client-env.mjs';

const root = resolve(import.meta.dirname, '..');
const releaseDir = resolve(root, process.env.XWX_DECK_RELEASE_DIR || 'release');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const version = packageJson.version;
const artifact = join(releaseDir, 'XwX Deck.exe');
const helper = join(releaseDir, 'win-unpacked', 'XwX Deck.exe');
const temp = await mkdtemp(join(tmpdir(), 'xwxdeck-portable-update-'));

try {
  for (const scenario of ['trace-off', 'trace-on', 'damaged-index', 'legacy-unreadable-config', 'legacy-damaged-registry', 'migration-write-failure', 'reset']) {
    const fixture = join(temp, scenario);
    const userData = join(fixture, 'user-data');
    const clientHome = join(fixture, 'home');
    const resultPath = join(fixture, 'result.json');
    const traceRoot = join(userData, 'xwx-trace');
    const source = join(fixture, 'download.exe');
    const target = join(fixture, 'XwX Deck.exe');
    await mkdir(traceRoot, { recursive: true });
    await mkdir(join(clientHome, '.codex'), { recursive: true });
    await mkdir(join(clientHome, '.claude'), { recursive: true });
    const configPath = join(clientHome, '.codex', 'config.toml');
    if (scenario === 'legacy-unreadable-config') await mkdir(configPath);
    else await writeFile(configPath, 'model_provider = "openai"\nmodel = "gpt-5.5"\n');
    await writeFile(join(clientHome, '.claude', 'settings.json'), '{}');
    const migrationFailure = scenario.startsWith('legacy-') || scenario === 'migration-write-failure';
    const traceEnabled = scenario === 'trace-on' || scenario === 'damaged-index' || migrationFailure;
    const settingsPath = join(userData, 'settings.json');
    const settingsBytes = JSON.stringify({ tracingEnabled: traceEnabled,
      clientEnabled: { claude: false, codex: false },
      ...(migrationFailure ? { codexPreferredMode: 'compatible', providers: { version: 1,
        connections: scenario === 'legacy-damaged-registry' ? null : [{ id: 'legacy', displayName: 'Legacy',
          baseUrl: 'https://example.invalid/v1', bearerToken: 'fixture-key', adapter: 'responses',
          codexApiFormat: 'responses', codexModel: 'legacy-model' }],
        selected: { codex: 'legacy', claude: null } } } : {}) });
    await writeFile(settingsPath, settingsBytes);
    if (scenario === 'migration-write-failure') await chmod(settingsPath, 0o444);
    if (scenario === 'damaged-index') await writeFile(join(traceRoot, 'index.json'), '{broken-index');
    const env = {
      ...sanitizeClientEnv(),
      XWX_DECK_SMOKE_IGNORE_EXTERNAL: '1',
      XWX_DECK_SMOKE_USER_DATA: userData,
      XWX_DECK_CLIENT_HOME: clientHome,
      CODEX_HOME: join(clientHome, '.codex'),
      CLAUDE_CONFIG_DIR: join(clientHome, '.claude'),
      XWX_DECK_PORTABLE_UPDATE_SMOKE_RESULT: resultPath,
      ...(scenario === 'reset' ? { XWX_DECK_RESET_SMOKE: '1' } : { XWX_DECK_PORTABLE_UPDATE_SMOKE: '1' })
    };
    await copyFile(artifact, target);
    if (scenario === 'reset') {
      await mkdir(join(userData, 'Cache'), { recursive: true });
      await writeFile(join(userData, 'Cache', 'reset-sentinel'), 'old cache');
      await runProcess(target, ['--xwxdeck-reset'], env, fixture);
    } else {
      await copyFile(artifact, source);
      await writeFile(target, Buffer.from('old-build-marker'), { flag: 'a' });
      const oldHash = await sha256(target);
      const request = Buffer.from(JSON.stringify({ sourcePath: source, targetPath: target, version, waitPids: [] })).toString('base64url');
      await runProcess(helper, ['--xwxdeck-apply-portable-update=' + request], env, fixture);
      assert.equal(await sha256(target), await sha256(source));
      assert.equal(await sha256(target + '.previous'), oldHash);
    }
    const result = await waitForJson(resultPath, 60_000);
    assert.equal(result.windowReady, true, scenario + ': the actual manager UI must render');
    assert.equal(result.tracingEnabled, scenario === 'trace-on', 'report actual recording, not only saved intent');
    const persisted = JSON.parse(await readFile(settingsPath, 'utf8'));
    assert.equal(persisted.tracingEnabled, traceEnabled, 'startup failure must preserve the saved Trace preference');
    assert.equal(result.readiness.proxyListening, scenario === 'trace-on');
    if (migrationFailure) {
      assert.equal(result.readiness.startupPhase, 'degraded');
      assert.match(result.lastError, scenario === 'legacy-damaged-registry' ? /服务连接配置无法解析/ : /升级配置迁移未完成/);
      assert.equal(await readFile(settingsPath, 'utf8'), settingsBytes, 'failed automatic migration must preserve the complete old file');
      if (scenario === 'migration-write-failure') await chmod(settingsPath, 0o666);
    } else if (scenario === 'damaged-index') {
      assert.equal(result.readiness.startupPhase, 'degraded');
      assert.ok(result.lastError, 'a damaged index must be visible without terminating Deck');
      assert.equal(await readFile(join(traceRoot, 'index.json'), 'utf8'), '{broken-index');
    } else {
      assert.equal(result.lastError, undefined, scenario + ': ' + result.lastError);
    }
    if (scenario === 'reset') {
      await assert.rejects(readFile(join(userData, 'Cache', 'reset-sentinel')), /ENOENT/);
    } else {
      assert.equal(result.kind, 'complete');
      assert.equal(result.version, version);
      assert.match(basename(result.readyPath), /^xwx-portable-update-ready-[0-9a-f-]{36}\.json$/i);
      assert.match(basename(result.startedPath), /^xwx-portable-update-started-[0-9a-f-]{36}\.json$/i);
    }
    await waitForExit(result.pid);
    console.log('PASS portable ' + scenario + ': real controller, Gateway state and rendered window after restart (' + version + ')');
  }
} finally {
  if (dirname(temp) !== resolve(tmpdir())) throw new Error('Unexpected smoke directory');
  await rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

function runProcess(executable, args, env, cwd) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Restart test timed out: ' + stderr)); }, 150_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('Restart process exited with ' + code + ': ' + stderr));
      else resolveExit();
    });
  });
}

async function waitForJson(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { /* still starting */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error('Timed out waiting for real startup: ' + file);
}

async function waitForExit(pid) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error('Isolated manager did not exit: ' + pid);
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}
