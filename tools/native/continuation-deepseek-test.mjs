import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startNativeRpc} from './rpc-test-session.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-deepseek-continuation-'));
const requests = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : null;
  requests.push(body);
  const index = requests.length;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    id: 'resp-' + index,
    object: 'response',
    status: 'completed',
    model: body?.model,
    output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: index === 1 ? 'OK' : 'ORANGE'}]}],
    usage: {input_tokens: 1, output_tokens: 1},
  }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}/deepseek/v1`;
const app = startNativeRpc(root);
const post = async (localBaseUrl, body) => {
  const response = await fetch(localBaseUrl + '/v1/responses', {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-codex-thread-id': 'deepseek-continuation'},
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
};
try {
  await app.rpc('getState');
  await app.rpc('saveProvider', {
    id: 'deepseek-continuation',
    displayName: 'DeepSeek_Continuation',
    baseUrl: base,
    bearerToken: 'SYNTHETIC-DEEPSEEK',
    adapter: 'responses',
    codexApiFormat: 'responses',
    codexModel: 'deepseek-v4-pro',
    providerPreset: 'custom',
  });
  await app.rpc('switchClientProvider', {client: 'codex', providerId: 'deepseek-continuation'});
  const live = await app.rpc('toggleTracing', true);
  const first = await post(live.localBaseUrl, {
    model: 'deepseek-v4-pro',
    input: [{role: 'user', content: 'Remember the code word ORANGE.'}],
    max_output_tokens: 16,
    stream: false,
  });
  const second = await post(live.localBaseUrl, {
    model: 'deepseek-v4-pro',
    previous_response_id: first.id,
    input: [{role: 'user', content: 'What code word did I ask you to remember?'}],
    max_output_tokens: 16,
    stream: false,
  });
  assert.equal(second.output[0].content[0].text, 'ORANGE');
  const forwarded = requests.at(-1);
  assert.equal(forwarded.previous_response_id, undefined, JSON.stringify(forwarded));
  const serialized = JSON.stringify(forwarded.input);
  assert.match(serialized, /Remember the code word ORANGE/);
  assert.match(serialized, /What code word did I ask you to remember/);
  await app.rpc('toggleTracing', false);
  console.log(JSON.stringify({passed: true, checks: ['DeepSeek previous_response_id expands cached input instead of forwarding stateless server state']}));
} finally {
  await app.stop();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(root, {recursive: true, force: true});
}
