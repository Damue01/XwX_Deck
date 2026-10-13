import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startNativeRpc } from './rpc-test-session.mjs';

const root = await mkdtemp(join(await realpath(tmpdir()), 'xwxdeck-validation-'));
let httpStatus = 502;
let hold = false;
let delayMs = 0;
let reply = { error: null, output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] };
let errorReply = { error: { message: 'SYNTHETIC-SECRET-MUST-NOT-BE-RETURNED' } };
const calls = [];
const upstream = createServer(async (request, response) => {
  let source = ''; for await (const chunk of request) source += chunk;
  const body = JSON.parse(source);
  calls.push({ path: request.url, model: body.model, prompt: body.input ?? body.messages?.[0]?.content, budget: body.max_output_tokens ?? body.max_tokens });
  if (hold) return;
  if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
  response.writeHead(httpStatus, { 'content-type': 'application/json' });
  response.end(JSON.stringify(httpStatus === 200 ? reply : errorReply));
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const app = startNativeRpc(root, [], 40000);
let passed = false;
try {
  await app.rpc('saveProvider', { id: 'validation-fixture', displayName: 'Fixture', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, adapter: 'responses', bearerToken: 'SYNTHETIC-KEY', codexModel: 'retained-choice' });
  const before = await app.rpc('getProviders');
  httpStatus = 404;
  for (const [code, reason, expected] of [
    ['ModelNotOpen', 'model-not-enabled', 'model-error'],
    ['InvalidEndpointOrModel.ModelIDAccessDisabled', 'endpoint-required', 'model-error'],
    ['InvalidEndpointOrModel.NotFound', 'model-not-found', 'model-error'],
    ['PathNotFound', 'endpoint-not-found', 'unavailable'],
    ['InvalidAction', 'endpoint-not-found', 'unavailable'],
    ['SYNTHETIC-SECRET', 'not-found', 'unavailable'],
    [undefined, 'not-found', 'unavailable'],
  ]) {
    errorReply.error.code = code;
    const count = calls.length;
    const result = await app.rpc('validateProvider', { providerId: 'validation-fixture', model: 'explicit-test-model' });
    assert.equal(result.status, expected);
    assert.equal(result.failureReason, reason);
    assert.equal(result.httpStatus, 404);
    assert.equal(calls.length, count + 1, 'a model/permission failure must not replay a request');
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC|SECRET/);
  }
  for (const [code, expected] of [[502, 'unavailable'], [401, 'authentication-error'], [400, 'model-error'], [200, 'valid']]) {
    httpStatus = code;
    const result = await app.rpc('validateProvider', { providerId: 'validation-fixture', model: 'explicit-test-model' });
    assert.equal(result.status, expected);
    assert.equal(result.httpStatus, code);
    assert.equal(result.protocol, 'responses');
    assert.equal(result.failureReason, null);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC|SECRET|retained-choice/);
  }
  for (const [body, reason] of [
    [{ output: [] }, 'empty-response'],
    [{ content: [], stop_reason: 'max_tokens' }, 'empty-response'],
    [{ output: [{ content: [{ type: 'output_text', text: '  ' }] }] }, 'empty-response'],
    [{ content: [{ type: 'text', text: 'untrusted refusal text' }], stop_reason: 'refusal' }, 'refused'],
    [{ output: [{ content: [{ type: 'refusal', refusal: 'untrusted refusal text' }] }] }, 'refused'],
    [{ choices: [{ message: { refusal: 'untrusted refusal text', content: 'text' } }] }, 'refused'],
  ]) {
    reply = body;
    const result = await app.rpc('validateProvider', { providerId: 'validation-fixture', model: 'explicit-test-model' });
    assert.notEqual(result.status, 'valid');
    assert.equal(result.failureReason, reason);
    assert.doesNotMatch(JSON.stringify(result), /untrusted refusal text/);
  }
  reply = { error: { message: 'SYNTHETIC-SECRET-MUST-NOT-BE-RETURNED' }, output_text: 'not a success' };
  const embeddedError = await app.rpc('validateProvider', { providerId: 'validation-fixture', model: 'explicit-test-model' });
  assert.equal(embeddedError.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(embeddedError), /SYNTHETIC|SECRET|not a success/);
  reply = { error: null, output_text: '4' };
  delayMs = 9000;
  const admitted = once(upstream, 'request');
  const slowValidation = app.rpc('validateProvider', { providerId: 'validation-fixture', model: 'explicit-test-model' });
  await admitted;
  const readStarted = Date.now();
  assert.deepEqual(await app.rpc('getProviders'), before);
  assert.ok(Date.now() - readStarted < 1000, 'validation must not hold the state lock');
  assert.equal((await slowValidation).status, 'valid', 'a valid model taking over eight seconds remains usable');
  delayMs = 0;
  hold = true;
  const timedOut = await app.rpc('validateProvider', { providerId: 'validation-fixture', model: 'explicit-test-model' });
  assert.equal(timedOut.status, 'unavailable');
  assert.equal(timedOut.httpStatus, null);
  assert.equal(timedOut.failureReason, 'timeout');
  assert.deepEqual(await app.rpc('getProviders'), before);
  assert.ok(calls.every(call => call.path === '/v1/responses' && call.model === 'explicit-test-model'));
  assert.ok(calls.every(call => call.prompt === 'What is 2 + 2?' && call.budget >= 200), 'ordinary question and room for reasoning before visible output');
  hold = false; httpStatus = 200;
  for (const [adapter, suffix] of [['responses', 'responses'], ['chat-completions', 'chat/completions']]) {
    reply = adapter === 'responses' ? { output_text: '4' } : { choices: [{ message: { role: 'assistant', content: '4' } }] };
    for (const tail of ['', '/', '/' + suffix]) {
      await app.rpc('saveProvider', { id: 'ark-fixture', displayName: 'Ark_Fixture', providerPreset: 'volcengine-ark', baseUrl: `http://127.0.0.1:${upstream.address().port}/api/v3${tail}`, adapter, bearerToken: 'SYNTHETIC-KEY', codexModel: 'retained-ark-choice' });
      const saved = await app.rpc('getProviders');
      const result = await app.rpc('validateProvider', { providerId: 'ark-fixture', model: 'deepseek-r1-250120' });
      assert.equal(result.status, 'valid');
      assert.equal(result.protocol, adapter);
      assert.equal(calls.at(-1).path, `/api/v3/${suffix}`);
      assert.equal(calls.at(-1).model, 'deepseek-r1-250120');
      assert.deepEqual(await app.rpc('getProviders'), saved, 'testing preserves the exact saved URL, adapter and model');
    }
  }
  passed = true;
  console.log('PASS validation distinguishes Ark 404 permissions/model/path errors without exposing bodies or replaying, preserves version-root paths for both protocols, rejects empty/refused output and retains routing/model');
} finally {
  await app.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  if (passed) await rm(root, { recursive: true, force: true });
}
