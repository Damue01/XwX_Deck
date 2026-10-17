import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeTestBinary } from './test-support.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'deck-official-chatgpt-'));
let child, sequence = 0, mode = 'ok', release, entered, usageRequests = 0;
const pending = new Map(), models = [], checks = [];
const pass = message => { checks.push(message); console.log('PASS ' + message); };
const now = Math.floor(Date.now() / 1000);
const auth = { tokens: { access_token: 'official-secret', refresh_token: 'official-refresh', account_id: 'official-account', id_token: `e30.${Buffer.from(JSON.stringify({ email: 'official@example.test' })).toString('base64url')}.signature` } };
const server = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, 'Bearer official-secret');
  res.setHeader('content-type', 'application/json');
  if (req.url === '/backend-api/wham/usage') {
    usageRequests++;
    assert.equal(req.headers['chatgpt-account-id'], 'official-account');
    assert.equal(req.headers.cookie, undefined);
    if (mode === 'unavailable') { res.statusCode = 503; res.end('{}'); return; }
    if (mode === 'denied') { res.statusCode = 401; res.end('{"secret":"private-error"}'); return; }
    const finish = () => res.end(JSON.stringify({ plan_type: 'pro', rate_limit: { primary_window: { used_percent: mode === 'missing' ? null : 23, limit_window_seconds: 604800, reset_at: now + 900 } }, secret: 'private-body' }));
    if (mode === 'held') { release = finish; entered(); } else finish();
    return;
  }
  if (req.url.startsWith('/backend-api/codex/models')) { res.end(JSON.stringify({ models: ['model-a', 'model-b'].map(slug => ({ slug, visibility: 'list', display_name: slug })) })); return; }
  if (req.url === '/backend-api/codex/responses') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); models.push(body.model);
    res.setHeader('content-type', 'text/event-stream');
    res.end('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: { id: 'fixture', object: 'response', status: 'completed', model: body.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '4' }] }], usage: { input_tokens: 2, output_tokens: 1 } } }) + '\n\n'); return;
  }
  res.statusCode = 404; res.end('{}');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
function start() {
  child = spawn(nativeTestBinary, ['--rpc', '--pilot-root', root, '--subscription-test-endpoint', base], { stdio: ['pipe', 'pipe', 'inherit'] });
  createInterface({ input: child.stdout }).on('line', line => { const value = JSON.parse(line); pending.get(value.requestId)?.(value); pending.delete(value.requestId); });
}
const call = (method, ...args) => new Promise((resolve, reject) => {
  const requestId = ++sequence, timer = setTimeout(() => reject(Error(method + ' timed out')), 15000);
  pending.set(requestId, result => { clearTimeout(timer); resolve(result); }); child.stdin.write(JSON.stringify({ requestId, method, args }) + '\n');
});
const rpc = async (method, ...args) => { const value = await call(method, ...args); assert.equal(value.ok, true, value.error); return value.result; };
const stop = async () => { const done = once(child, 'exit'); child.stdin.end(); assert.equal((await done)[0], 0); };
try {
  start(); await rpc('getState'); await stop();
  await mkdir(join(root, 'codex'), { recursive: true });
  const config = `model_provider = "openai"\nmodel = "model-a"\nopenai_base_url = "${base}/backend-api"\nchatgpt_base_url = "https://chatgpt.com/backend-api"\n`;
  await writeFile(join(root, 'codex/config.toml'), config);
  const authPath = join(root, 'codex/auth.json'), originalAuth = JSON.stringify(auth);
  await writeFile(authPath, originalAuth); start();
  const registry = await rpc('getProviders');
  let account = await rpc('getOfficialChatgptAccount');
  assert.equal(account.email, 'official@example.test'); assert.equal(account.quota.remainingPercent, 77);
  assert.equal(account.quotaDetails.windows[0].windowSeconds, 604800);
  assert.ok(!/official-secret|official-refresh|private-body|signature/.test(JSON.stringify(account)));
  assert.deepEqual(await rpc('getProviders'), registry);
  let registrations = await rpc('getSubscriptionAccounts'); assert.equal(registrations.accounts.length, 0, 'read-only login detection must not enroll the account');
  await rpc('connectSubscriptionAccount', 'official-chatgpt');
  registrations = await rpc('getSubscriptionAccounts'); assert.equal(registrations.accounts.length, 1); assert.equal(registrations.accounts[0].authKind, 'official'); assert.equal(registrations.accounts[0].externalLogin, true); assert.equal(registrations.routing.chatgpt.fixedAccountId, '');
  pass('official account reads its own allowance without exporting credentials, changing selection or joining API authorization rotation');
  const readsBeforeCache = usageRequests;
  account = await rpc('getOfficialChatgptAccount', {refresh:false});
  assert.equal(usageRequests, readsBeforeCache); assert.equal(account.quotaCached, true);
  assert.equal(account.quotaDetails.windows[0].remainingPercent, 77); assert.equal(account.quota, undefined);
  await stop(); start();
  registrations = await rpc('getSubscriptionAccounts');
  assert.equal(registrations.accounts[0].quotaDetails.windows[0].remainingPercent, 77);
  assert.equal(registrations.accounts[0].quota, undefined); assert.equal(usageRequests, readsBeforeCache);
  account = await rpc('getOfficialChatgptAccount', {refresh:false}); assert.equal(account.quotaCached, true);
  await writeFile(authPath, JSON.stringify({...auth,tokens:{...auth.tokens,account_id:'another-account'}}));
  account = await rpc('getOfficialChatgptAccount', {refresh:false}); assert.equal(account.quotaDetails, undefined);
  await writeFile(authPath, originalAuth);
  mode = 'unavailable'; account = await rpc('getOfficialChatgptAccount');
  assert.equal(account.quotaCached, true); assert.equal(account.quota, undefined);
  assert.equal(account.quotaDetails.windows[0].remainingPercent, 77); assert.match(account.quotaError, /503/);
  pass('cold restart hydrates identity-bound display quota without HTTP or routing quota; identity change rejects cache and 503 retains last read with its error');
  mode = 'denied'; account = await rpc('getOfficialChatgptAccount');
  assert.equal(account.quota, undefined); assert.equal(account.status, 'connected'); assert.match(account.quotaError, /HTTP 401/); assert.ok(!JSON.stringify(account).includes('private-error'));
  assert.equal((await rpc('getOfficialChatgptAccount', {refresh:false})).quotaDetails, undefined);
  mode = 'ok'; await rpc('getOfficialChatgptAccount');
  mode = 'missing'; account = await rpc('getOfficialChatgptAccount'); assert.equal(account.quota, undefined); assert.equal(account.quotaDetails.windows[0].remainingPercent, null);
  assert.equal((await rpc('getOfficialChatgptAccount', {refresh:false})).quotaDetails, undefined);
  pass('authorization failure and incomplete windows clear success without inventing zero or logging the user out');
  mode = 'held'; const reached = new Promise(resolve => { entered = resolve; }); const reading = call('getOfficialChatgptAccount'); await reached;
  await rpc('getState'); await writeFile(authPath, JSON.stringify({ ...auth, changed: true })); release(); release = null;
  assert.match((await reading).error, /登录已变化/); await writeFile(authPath, originalAuth); mode = 'ok';
  pass('network read leaves state responsive and rejects a late result after the official login changes');
  await rpc('switchClientProvider', { client: 'codex', providerId: null });
  const catalog = await rpc('fetchModels', { expectedProviderId: null, refresh: true }); assert.ok(catalog.some(row => row.id === 'model-b'));
  await rpc('updateCodexConfig', { expectedProviderId: null, officialModel: 'model-b', modelContextWindow: 64000 });
  assert.match(await readFile(join(root, 'codex/config.toml'), 'utf8'), /model = "model-b"/);
  const state = await rpc('toggleTracing', true);
  for (const model of ['model-a', 'model-b']) {
    const saved = await rpc('updateCodexConfig', { expectedProviderId: null, officialModel: model, modelContextWindow: null });
    assert.equal(saved.officialModel, model);
    const response = await fetch(state.localBaseUrl + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: saved.officialModel, input: 'What is 2 + 2?', stream: true, store: false }) });
    assert.equal(response.status, 200); assert.match(await response.text(), /response.completed/);
  }
  await rpc('toggleTracing', false); assert.deepEqual(models, ['model-a', 'model-b']);
  assert.equal(await readFile(authPath, 'utf8'), originalAuth);
  assert.match(await readFile(join(root, 'codex/config.toml'), 'utf8'), /model_provider = "openai"/);
  assert.equal((await rpc('getCodexConfig')).officialModel, 'model-b');
  await stop(); start(); assert.equal((await rpc('getCodexConfig')).officialModel, 'model-b');
  pass('official model save, Trace requests, stop and restart preserve latest model and exact official login bytes');
  await writeFile(authPath, '{}'); account = await rpc('getOfficialChatgptAccount'); assert.equal(account.status, 'signed-out'); assert.match(account.quotaError, /登录/);
  pass('missing official login offers login and refresh instead of a fabricated account allowance');
  console.log(JSON.stringify({ passed: true, checks, scope: 'Synthetic official login, actual native RPC and loopback requests; live account verification is separate' }));
} finally {
  release?.();
  if (child?.exitCode === null) { try { await rpc('toggleTracing', false); await stop(); } catch { child.kill(); } }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
