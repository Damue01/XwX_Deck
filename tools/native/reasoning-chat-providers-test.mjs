import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startNativeRpc} from './rpc-test-session.mjs';

// Each provider is reached through a local path containing the same host
// keyword the production route uses. This keeps the real request conversion
// and catalog publication while never contacting a vendor.
const cases = [
  {name: 'glm-5.3', path: 'bigmodel.cn', model: 'glm-5.3', effort: 'high', expected: {reasoning_effort: 'high'}},
  {name: 'glm-5.2', path: 'z.ai', model: 'glm-5.2', effort: 'max', expected: {reasoning_effort: 'max'}},
  {name: 'kimi-k3', path: 'moonshot', model: 'kimi-k3', effort: 'high', expected: {reasoning_effort: 'high'}},
  {name: 'kimi-k2.6', path: 'moonshot', model: 'kimi-k2.6', effort: 'high', expected: {thinking: 'enabled'}},
  {name: 'kimi-k2.7-code', path: 'moonshot', model: 'kimi-k2.7-code', effort: 'high', expected: {}},
  {name: 'kimi-for-coding', path: 'kimi', model: 'kimi-for-coding', effort: 'max', expected: {reasoning_effort: 'max', thinking: 'enabled'}},
  {name: 'gemini-3.5', path: 'googleapis', model: 'gemini-3.5-flash', effort: 'medium', expected: {reasoning_effort: 'medium'}},
  {name: 'mistral-small', path: 'mistral', model: 'mistral-small-latest', effort: 'high', expected: {reasoning_effort: 'high'}},
  {name: 'step-5', path: 'stepfun', model: 'step-5-preview', effort: 'medium', expected: {reasoning_effort: 'medium'}},
  {name: 'step-3.5-2603', path: 'stepfun', model: 'step-3.5-flash-2603', effort: 'minimal', expected: {reasoning_effort: 'low'}},
  {name: 'qwen3.8', path: 'dashscope', model: 'qwen3.8-max', effort: 'xhigh', expected: {reasoning_effort: 'xhigh', enable_thinking: true}},
  {name: 'qwen3.5', path: 'dashscope', model: 'qwen3.5-plus', effort: 'high', expected: {enable_thinking: true}},
  {name: 'dashscope-kimi-k2.6', path: 'dashscope', model: 'kimi-k2.6', effort: 'high', expected: {enable_thinking: true}},
  {name: 'dashscope-kimi-k3', path: 'dashscope', model: 'kimi-k3', effort: 'max', expected: {enable_thinking: true, reasoning_effort: 'max'}},
  {name: 'dashscope-deepseek', path: 'dashscope', model: 'deepseek-v4-pro', effort: 'high', expected: {enable_thinking: true, reasoning_effort: 'high'}},
  {name: 'tencent-hy3', path: 'tencent', model: 'hy3', effort: 'high', expected: {reasoning_effort: 'high'}},
  {name: 'groq-qwen3.8', path: 'groq', model: 'qwen/qwen3.8-27b', effort: 'high', expected: {reasoning_effort: 'high'}},
  {name: 'deepseek-v4', path: 'deepseek', model: 'deepseek-v4-pro', effort: 'low', expected: {reasoning_effort: 'low', thinking: 'enabled'}},
  {name: 'openrouter-deepseek', path: 'openrouter', model: 'deepseek/deepseek-v4-pro', effort: 'max', expected: {reasoning: 'xhigh'}},
  {name: 'siliconflow-deepseek', path: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4-Pro', effort: 'high', expected: {enable_thinking: true}},
  {name: 'siliconflow-glm5.3', path: 'siliconflow', model: 'zai-org/GLM-5.3', effort: 'high', expected: {reasoning_effort: 'high'}},
  {name: 'minimax-m3', path: 'minimax', model: 'MiniMax-M3', effort: 'high', expected: {thinking: 'adaptive'}},
  {name: 'minimax-m2.5', path: 'minimax', model: 'MiniMax-M2.5', effort: 'high', expected: {reasoning_effort: 'high'}},
  {name: 'openai-gpt5', path: 'api.openai.com', model: 'gpt-5.4', effort: 'high', expected: {reasoning_effort: 'high'}},
  {name: 'xai-grok', path: 'api.x.ai', model: 'grok-4.5', effort: 'high', expected: {reasoning_effort: 'high'}},
  {name: 'generic', path: 'v1', model: 'future-model', effort: 'high', expected: {reasoning_effort: 'high'}},
];

const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-reasoning-chat-'));
const requests = [];
const checks = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : null;
  requests.push({path: req.url, body});
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    id: 'chat-fixture',
    model: body?.model,
    choices: [{message: {role: 'assistant', content: 'fixture'}, finish_reason: 'stop'}],
    usage: {prompt_tokens: 1, completion_tokens: 1},
  }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}/`;
const app = startNativeRpc(root);
const pick = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
try {
  await app.rpc('getState');
  for (const [index, item] of cases.entries()) {
    const id = `reasoning-${index}`;
    await app.rpc('saveProvider', {
      id,
      displayName: id,
      baseUrl: base + item.path,
      bearerToken: 'SYNTHETIC-REASONING',
      adapter: 'chat-completions',
      codexApiFormat: 'chat-completions',
      codexModel: item.model,
      providerPreset: 'custom',
    });
    await app.rpc('switchClientProvider', {client: 'codex', providerId: id});
    const live = await app.rpc('toggleTracing', true);
    const response = await fetch(live.localBaseUrl + '/v1/responses', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        model: item.model,
        input: [{role: 'user', content: 'fixture'}],
        reasoning: {effort: item.effort},
      }),
    });
    assert.equal(response.status, 200, `${item.name} HTTP`);
    await response.json();
    await app.rpc('toggleTracing', false);
    const sent = requests.at(-1)?.body;
    assert.ok(sent, `${item.name} upstream request missing`);
    const actual = pick({
      reasoning_effort: sent.reasoning_effort,
      thinking: sent.thinking?.type,
      enable_thinking: sent.enable_thinking,
      reasoning: sent.reasoning?.effort,
    });
    assert.deepEqual(actual, item.expected, `${item.name}: ${JSON.stringify(sent)}`);
    checks.push(`${item.name} -> ${JSON.stringify(item.expected)}`);
  }
  console.log(JSON.stringify({passed: true, checks, scope: 'actual native Gateway conversion to synthetic Chat upstreams; no vendor request'}));
} finally {
  await app.stop();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(root, {recursive: true, force: true});
}
