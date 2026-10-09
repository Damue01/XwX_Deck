import { nativeTestBinary } from './test-support.mjs';
// Explicitly invoked Copilot/Cursor acceptance probe. Client files and Trace stay in a temporary root.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const source = process.argv[process.argv.indexOf('--source-root') + 1];
const platform = process.argv.find(argument => argument.startsWith('--platform='))?.split('=')[1] ?? 'copilot';
assert.ok(['copilot', 'cursor'].includes(platform), 'This acceptance probe supports Copilot and Cursor only.');
const providerName = platform === 'copilot' ? 'GitHub Copilot' : 'Cursor';
assert.ok(process.argv.includes('--source-root') && source, 'Pass the explicitly authorized preview account root.');
assert.match(basename(await realpath(source)), /^xwx-rust-pilot-native-/);
const root = await mkdtemp(join(await realpath(tmpdir()), `xwx-${platform}-live-`));
await chmod(root, 0o700);
let child, tracing = false;
const pending = [];
const report = { passed: false, isolated: true, provider: providerName };
const rpc = (method, ...args) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Native RPC timeout: ${method}`)), 90_000);
  pending.push(value => {
    clearTimeout(timeout);
    value.ok ? resolve(value.result) : reject(new Error(value.error));
  });
  child.stdin.write(JSON.stringify({ method, args }) + '\n');
});
const start = () => {
  child = spawn(nativeTestBinary, ['--rpc', '--pilot-root', root], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdin.on('error', () => pending.splice(0).forEach(callback => callback({ ok: false, error: 'Native verification pipe closed.' })));
  createInterface({ input: child.stdout }).on('line', line => pending.shift()?.(JSON.parse(line)));
  child.once('exit', () => pending.splice(0).forEach(callback => callback({ ok: false, error: 'Native verification host exited.' })));
};
const stop = async () => {
  if (!child || child.exitCode !== null) return;
  const process = child;
  const exited = once(process, 'exit'); process.stdin.end();
  let timer;
  try {
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { process.kill('SIGTERM'); resolve(); }, 3000); timer.unref(); })]);
  } finally { clearTimeout(timer); }
};
try {
  // Let the host initialize its empty sandbox and ownership marker before importing this copy.
  start(); await rpc('getState'); await stop();
  // OS-level copy only: tokens are decoded and used exclusively by the native backend.
  await copyFile(join(source, `${platform}-accounts.json`), join(root, `${platform}-accounts.json`));
  await chmod(join(root, `${platform}-accounts.json`), 0o600);
  start();
  const account = (await rpc('getSubscriptionAccounts')).accounts.find(account => account.platform === platform && account.status === 'connected');
  assert.ok(account, `No connected ${providerName} registration in the authorized preview.`);
  const provider = (await rpc('connectSubscriptionAccount', account.id)).connections[0];
  const catalog = await rpc('fetchProviderModels', { providerId: provider.id });
  report.modelCount = catalog.length;
  const available = catalog.filter(model => model.protocols.includes('chat-completions') || model.protocols.includes('openai-responses'));
  const preferred = platform === 'cursor' ? ['auto'] : ['gpt-4.1', 'gpt-4o', 'gpt-5-mini'];
  const model = preferred.map(id => available.find(model => model.id === id)).find(Boolean)
    ?? available.find(model => /mini|luna|flash/i.test(model.id)) ?? available[0];
  assert.ok(model, `${providerName} has no compatible chat model in its current catalog.`);
  report.model = model.id;
  await rpc('switchClientProvider', { client: 'codex', providerId: provider.id });
  await rpc('updateCodexConfig', { expectedProviderId: provider.id, compatibleModel: model.id });
  await mkdir(join(root, 'codex'), { recursive: true });
  const direct = 'model = "isolated-original"\n';
  await writeFile(join(root, 'codex/config.toml'), direct);
  const runtime = await rpc('toggleTracing', true); tracing = true;
  const response = await fetch(runtime.localBaseUrl + '/v1/responses', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: model.id, input: 'Reply with exactly OK.', stream: false, max_output_tokens: 16 }),
    signal: AbortSignal.timeout(90_000)
  });
  report.status = response.status;
  const body = await response.json();
  assert.equal(response.status, 200, `${providerName} inference HTTP ${response.status}: ${body.error?.message ?? 'request failed'}`);
  assert.equal(body.status, 'completed');
  const output = (body.output ?? []).flatMap(item => item.content ?? []).map(part => part.text ?? '').join('').trim();
  assert.ok(output, `${providerName} returned no response text.`);
  report.responseReceived = true;
  report.expectedReply = /^OK[.!]?$/i.test(output);
  report.usage = body.usage;
  await rpc('toggleTracing', false); tracing = false;
  assert.equal(await readFile(join(root, 'codex/config.toml'), 'utf8'), direct);
  await assert.rejects(fetch(runtime.localBaseUrl + '/v1/models'));
  const records = (await Promise.all((await readdir(join(root, 'traces'))).filter(name => name.endsWith('.jsonl')).map(async name => (await readFile(join(root, 'traces', name), 'utf8')).trim().split('\n').map(JSON.parse)))).flat();
  assert.equal(records.length, 1);
  report.upstream = records[0].upstream.url;
  report.protocol = records[0].upstream.protocol;
  report.directRestored = true;
  report.passed = true;
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) {
    if (tracing) await rpc('toggleTracing', false).catch(() => {});
    await stop();
  }
  // The generated test conversation and credential copy are disposable; the source is untouched.
  await rm(root, { recursive: true, force: true });
  report.temporaryCredentialsRemoved = true;
  await writeFile(resolve(`test-results/${platform}-live-acceptance.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
