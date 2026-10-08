import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sanitizeClientEnv } from './sanitized-client-env.mjs';

const root = resolve(import.meta.dirname, '..');
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const github = process.argv.includes('--github');
const isMac = process.platform === 'darwin';
assert.ok(isMac || process.platform === 'win32', 'Run on a native Mac or Windows host.');
const name = isMac ? 'XwX-Deck-mac-arm64.dmg' : 'XwX-Deck-windows-x64.exe';
const artifact = join(root, 'release', isMac ? name : 'XwX Deck.exe');
const baseline = join(root, 'release', 'baseline', ...(isMac
  ? ['mac-arm64', 'XwX Deck.app', 'Contents', 'MacOS', 'XwX Deck'] : ['XwX Deck.exe']));
const temp = await mkdtemp(join(tmpdir(), 'xwxdeck-real-update-'));
const reportDir = join(root, 'test-results', `update-${process.platform}-${github ? 'github' : 'local'}`);
await mkdir(reportDir, { recursive: true });
const beforePath = join(reportDir, 'before.json');
const afterPath = join(reportDir, 'after.json');
await rm(beforePath, { force: true });
await rm(afterPath, { force: true });
const userData = join(temp, 'user-data');
const home = join(temp, 'home');
await mkdir(join(home, '.codex'), { recursive: true });
await mkdir(join(home, '.claude'), { recursive: true });
const codexBytes = 'model_provider = "openai"\nmodel = "gpt-5.5"\nopenai_base_url = "https://api.openai.com/v1"\n';
const claudeBytes = '{}\n';
await writeFile(join(home, '.codex', 'config.toml'), codexBytes);
await writeFile(join(home, '.claude', 'settings.json'), claudeBytes);
await mkdir(userData, { recursive: true });
await writeFile(join(userData, 'settings.json'), JSON.stringify({ tracingEnabled: false,
  startupEnabled: false, clientEnabled: { claude: false, codex: false }, theme: 'night' }));
const expectedHash = await hash(artifact, 'sha256', 'hex');
const size = (await stat(artifact)).size;
let server;
let mount;
let activeChild;
const requests = [];
try {
  let feed;
  if (!github) {
    server = createServer(async (request, response) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      requests.push({ method: request.method, path: pathname });
      const url = `http://127.0.0.1:${server.address().port}/${name}`;
      if (pathname === '/release.json') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ schemaVersion: 1, channel: 'release', version,
          publishedAt: new Date().toISOString(), files: [{ name, url, size, sha256: expectedHash }] }));
      } else if (pathname === '/latest.yml') {
        const sha512 = await hash(artifact, 'sha512', 'base64');
        response.writeHead(200, { 'content-type': 'text/yaml' });
        response.end(`version: ${version}\nfiles:\n  - url: ${url}\n    sha512: ${sha512}\n    size: ${size}\npath: ${url}\nsha512: ${sha512}\nreleaseDate: ${new Date().toISOString()}\n`);
      } else if (pathname === `/${name}`) {
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size });
        if (request.method === 'HEAD') response.end();
        else createReadStream(artifact).pipe(response);
      } else response.writeHead(404).end();
    });
    await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    feed = `http://127.0.0.1:${server.address().port}`;
  }
  const env = { ...sanitizeClientEnv(), XWX_DECK_SMOKE_IGNORE_EXTERNAL: '1',
    LOCALAPPDATA: join(temp, 'local-app-data'),
    XWX_DECK_SMOKE_USER_DATA: userData, XWX_DECK_CLIENT_HOME: home,
    CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    XWX_DECK_PACKAGED_UPDATE_SMOKE: '1', XWX_DECK_PACKAGED_UPDATE_RESULT: beforePath,
    XWX_DECK_PORTABLE_UPDATE_SMOKE_RESULT: afterPath };
  // GitHub acceptance deliberately uses the packaged default feed, anonymously.
  delete env.XWX_DECK_UPDATE_SERVER_URL;
  if (feed) env.XWX_DECK_UPDATE_SERVER_URL = feed;
  let executable = baseline;
  if (!isMac) {
    executable = join(temp, 'XwX Deck.exe');
    await copyFile(baseline, executable);
  }
  const oldHash = await hash(executable, 'sha256', 'hex');
  activeChild = launch(executable, env);
  const before = await waitJson(beforePath, 180_000);
  assert.equal(before.error, undefined, before.error);
  assert.equal(before.actualVersion, '0.9.9');
  assert.equal(before.checked.targetVersion, version);
  assert.equal(before.downloaded.status, 'ready');
  assert.equal(before.preflightPassed, true);
  assert.equal(before.windowRendered, true);
  await waitExit(before.pid, 45_000);
  let after;
  if (isMac) {
    const downloaded = join(userData, 'updates', name);
    const downloadedRealPath = await realpath(downloaded);
    assert.equal(await hash(downloaded, 'sha256', 'hex'), expectedHash);
    // shell.openPath in the production handler mounts the actual downloaded DMG.
    const deadline = Date.now() + 60_000;
    while (!mount && Date.now() < deadline) {
      const info = JSON.parse(await command('plutil', ['-convert', 'json', '-o', '-', '-'],
        await command('hdiutil', ['info', '-plist'])));
      mount = info.images?.find(image => image['image-path'] === downloadedRealPath)?.['system-entities']
        ?.find(entity => entity['mount-point'])?.['mount-point'];
      if (!mount) await delay(250);
    }
    assert.ok(mount, 'The production open-installer action must mount a real DMG.');
    const installed = join(temp, 'Applications', 'XwX Deck.app');
    await mkdir(join(temp, 'Applications'), { recursive: true });
    await command('ditto', [join(mount, 'XwX Deck.app'), installed]);
    const restartEnv = { ...env, XWX_DECK_RESET_SMOKE: '1' };
    delete restartEnv.XWX_DECK_PACKAGED_UPDATE_SMOKE;
    activeChild = launch(join(installed, 'Contents', 'MacOS', 'XwX Deck'), restartEnv);
    after = await waitJson(afterPath, 60_000);
    assert.equal(after.actualVersion, version);
  } else {
    after = await waitJson(afterPath, 180_000);
    assert.equal(after.kind, 'complete');
    assert.equal(after.actualVersion, version);
    assert.equal(await hash(executable, 'sha256', 'hex'), expectedHash);
    assert.equal(await hash(`${executable}.previous`, 'sha256', 'hex'), oldHash);
  }
  assert.equal(after.windowReady, true);
  assert.equal(after.lastError, undefined);
  await waitExit(after.pid, 30_000);
  assert.equal(await readFile(join(home, '.codex', 'config.toml'), 'utf8'), codexBytes);
  assert.equal(await readFile(join(home, '.claude', 'settings.json'), 'utf8'), claudeBytes);
  assert.equal(JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')).theme, 'night');
  if (!github) assert.ok(requests.filter(r => r.path === '/release.json').length >= 3,
    'Selection must be checked again before download and installation.');
  await writeFile(join(reportDir, 'receipt.json'), JSON.stringify({ ok: true,
    platform: process.platform, source: github ? 'anonymous-packaged-github-default' : feed,
    baselineVersion: before.actualVersion, targetVersion: after.actualVersion,
    artifact: name, sha256: expectedHash, size, requests,
    installMode: isMac ? 'manual-dmg-copy-to-isolated-Applications' : 'automatic-portable-replace-and-relaunch',
    preservedClientConfiguration: true, before, after, checkedAt: new Date().toISOString()
  }, null, 2));
  console.log(`PASS real packaged update ${before.actualVersion} -> ${after.actualVersion}: ${process.platform}, ${github ? 'GitHub' : 'local'}, ${expectedHash}`);
} catch (error) {
  await writeFile(join(reportDir, 'failure.json'), JSON.stringify({ error: String(error), temp, requests }, null, 2));
  throw error;
} finally {
  if (server) await new Promise(resolveClose => server.close(resolveClose));
  if (mount) await command('hdiutil', ['detach', mount]).catch(() => undefined);
  // Only the test's own processes and temporary installation are touched.
  activeChild?.kill();
  await rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

function launch(executable, env) {
  const child = spawn(executable, [], { cwd: temp, env, stdio: 'ignore', windowsHide: true });
  child.once('error', error => { throw error; });
  return child;
}
async function hash(file, algorithm, encoding) {
  const digest = createHash(algorithm);
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest(encoding);
}
function delay(ms) { return new Promise(resolveWait => setTimeout(resolveWait, ms)); }
async function waitJson(file, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { await delay(100); }
  }
  throw new Error(`Timed out waiting for ${file}`);
}
async function waitExit(pid, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; }
    await delay(100);
  }
  throw new Error(`Isolated app did not exit: ${pid}`);
}
function command(executable, args, input) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolveCommand(stdout) : reject(new Error(stderr)));
    child.stdin.end(input);
  });
}
