import { nativeTestBinary } from './test-support.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { once } from 'node:events';
import esbuild from 'esbuild';

const bundled = await esbuild.build({ stdin: { contents: "export * from './src/shared/officialProviders';", resolveDir: resolve(import.meta.dirname, '../..'), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false });
const { OFFICIAL_PROVIDERS, newProviderDraft, isCodingPlanConnection } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const expectedPaths = {
  deepseek: '/responses', qwen: '/compatible-mode/v1/responses', ark: '/api/v3/responses',
  zhipu: '/api/paas/v4/chat/completions', kimi: '/v1/chat/completions', minimax: '/v1/chat/completions', tencent: '/v1/chat/completions',
  'openai-api': '/v1/responses', anthropic: '/v1/messages', siliconflow: '/v1/chat/completions',
  groq: '/openai/v1/chat/completions', mistral: '/v1/chat/completions', xai: '/v1/responses',
  'qwen-coding': '/v1/chat/completions', 'zhipu-coding': '/api/v1/responses',
  gemini: '/v1beta/openai/chat/completions', openrouter: '/api/v1/chat/completions', together: '/v1/chat/completions', fireworks: '/inference/v1/chat/completions',
  nvidia: '/v1/chat/completions', cerebras: '/v1/chat/completions', perplexity: '/router/v1/chat/completions', huggingface: '/v1/chat/completions', stepfun: '/v1/chat/completions', zai: '/api/paas/v4/chat/completions',
  'kimi-coding': '/coding/v1/responses', 'minimax-coding': '/v1/chat/completions', 'zai-coding': '/api/v1/responses',
  ollama: '/v1/chat/completions', lmstudio: '/v1/responses', llamacpp: '/v1/chat/completions', vllm: '/v1/chat/completions', localai: '/v1/chat/completions'
};
const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-provider-presets-'));
const calls = [];
const upstream = createServer(async (request, response) => {
  if (request.method === 'GET') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); return; }
  let text = ''; for await (const chunk of request) text += chunk;
  const body = JSON.parse(text); calls.push({ path: request.url, headers: request.headers, body });
  response.writeHead(200, { 'content-type': 'application/json' });
  if (request.url.endsWith('/chat/completions')) response.end(JSON.stringify({ id: 'chat-fixture', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'preset fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }));
  else if (request.url.endsWith('/messages')) response.end(JSON.stringify({ id: 'msg-fixture', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'preset fixture' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 1 } }));
  else response.end(JSON.stringify({ id: 'resp-fixture', object: 'response', status: 'completed', model: body.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'preset fixture' }] }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }));
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const origin = `http://127.0.0.1:${upstream.address().port}`;
const binary = nativeTestBinary;
const child = spawn(binary, ['--rpc', '--pilot-root', root], { stdio: ['pipe', 'pipe', 'inherit'] });
const queue = [];
createInterface({ input: child.stdout }).on('line', line => queue.shift()?.(JSON.parse(line)));
function rpc(method, ...args) { return new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('RPC timeout: ' + method)), 20000);
  queue.push(value => { clearTimeout(timer); value.ok ? resolve(value.result) : reject(new Error(value.error)); });
  child.stdin.write(JSON.stringify({ method, args }) + '\n');
}); }
try {
  assert.equal(OFFICIAL_PROVIDERS.length, Object.keys(expectedPaths).length);
  assert.deepEqual((await rpc('getProviders')).connections, []);
  for (const preset of OFFICIAL_PROVIDERS) {
    const draft = newProviderDraft([], preset.id);
    assert.equal(draft.bearerToken, '');
    assert.equal(newProviderDraft([{ displayName: draft.displayName }], preset.id).displayName, draft.displayName + '-2');
    const local = { ...draft, baseUrl: origin + new URL(preset.baseUrl).pathname.replace(/\/$/, ''), bearerToken: 'local' in preset ? '' : 'fixture-' + preset.id, codexModel: 'preset-fixture-model' };
    const priorSelection = (await rpc('getProviders')).selected;
    const saved = await rpc('saveProvider', local);
    assert.deepEqual(saved.selected, priorSelection, 'adding a connection must not change the current route');
    const connection = saved.connections.find(item => item.displayName === draft.displayName);
    assert.equal(connection.adapter, preset.adapter);
    assert.equal(isCodingPlanConnection(connection), 'codingPlan' in preset);
    await rpc('switchClientProvider', { client: 'codex', providerId: connection.id });
    const runtime = await rpc('toggleTracing', true);
    const response = await fetch(runtime.localBaseUrl + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'preset-fixture-model', input: 'interactive local fixture', max_output_tokens: 32 }) });
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(JSON.stringify(await response.json()), /preset fixture/);
    const request = calls.at(-1);
    assert.equal(request.path, expectedPaths[preset.id]);
    assert.equal(request.headers.authorization, 'local' in preset ? undefined : 'Bearer fixture-' + preset.id);
    if (preset.adapter === 'anthropic-messages') assert.equal(request.headers['x-api-key'], 'fixture-' + preset.id);
    assert.equal(request.body.model, 'preset-fixture-model');
    await rpc('toggleTracing', false);
    assert.equal((await rpc('getCodexConfig')).activeBaseUrl, local.baseUrl);
    if ('local' in preset) {
      assert.equal((await rpc('validateProvider', { providerId: connection.id })).status, 'valid');
      const validation = calls.at(-1);
      assert.equal(validation.path, expectedPaths[preset.id]);
      assert.equal(validation.headers.authorization, undefined);
      assert.equal(validation.headers['x-api-key'], undefined);
      assert.equal(validation.body.model, 'preset-fixture-model');
    }
    console.log('PASS preset ' + preset.id + ': explicit protocol, upstream path, auth, route retention and direct restore');
  }
  assert.equal(calls.length, OFFICIAL_PROVIDERS.length + OFFICIAL_PROVIDERS.filter(preset => 'local' in preset).length);
  child.stdin.end(); assert.equal((await once(child, 'exit'))[0], 0);
  console.log(JSON.stringify({ passed: true, presets: OFFICIAL_PROVIDERS.length, localHttpRequests: calls.length, sandbox: root }));
} finally {
  if (child.exitCode === null) child.kill();
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
}
