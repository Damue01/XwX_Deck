import assert from 'node:assert/strict';

// Fail closed before real records enter a public build. This contract examines
// only the reviewed fixture; it never opens a local account or capture directory.
export function validateRealExamples(examples) {
  assert.equal(examples.provenance.kind, 'sanitized-real-requests');
  assert.equal(examples.provenance.normalAccountFilesUnchanged, true);
  assert.ok(Number.isFinite(Date.parse(examples.provenance.capturedAt)));
  const { sessions, traces } = examples.state;
  assert.ok(traces.length >= 3);
  assert.equal(examples.provenance.requestCount, traces.length);
  assert.equal(sessions.length, traces.length);
  const forbiddenKeys = /^(authorization|cookie|set-cookie|headers|access_token|refresh_token|id_token|encrypted_content|account_id|accountId|email|connectionId|clientConversationKey|rawBody)$/i;
  const privateText = /Bearer\s+\S+|\/(?:Users|private|home)\/|127\.0\.0\.1|localhost|[\w.+-]+@[\w.-]+\.[a-z]{2,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{30,}\./i;
  function scan(value) {
    if (typeof value === 'string') assert.ok(!privateText.test(value), 'Private material cannot enter the website fixture');
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      assert.ok(!forbiddenKeys.test(key), 'Private field in website fixture: ' + key);
      scan(child);
    }
  }
  scan(examples);
  for (const trace of traces) {
    assert.match(trace.id, /^example-request-\d+$/);
    assert.match(trace.sessionId, /^example-session-\d+$/);
    assert.equal(trace.response.statusCode, 200);
    assert.equal(trace.response.body.status, 'completed');
    assert.ok(trace.durationMs > 0 && trace.usage.totalTokens > 0);
    const evidence = examples.provenance.evidence.find(row => row.requestId === trace.id);
    assert.ok(evidence);
    assert.match(evidence.sourceTraceSha256, /^[a-f0-9]{64}$/);
    assert.equal(trace.request.model, evidence.model);
    assert.equal(trace.usage.inputTotalTokens, evidence.inputTokens);
    assert.equal(trace.usage.outputTokens, evidence.outputTokens);
    assert.equal(trace.usage.totalTokens, evidence.totalTokens);
    assert.equal(trace.durationMs, evidence.durationMs);
    assert.equal(trace.costSnapshot.knownCostUsd, evidence.referenceCostUsd);
    const summary = sessions.find(row => row.id === trace.sessionId);
    assert.equal(summary.totalTokens, trace.usage.totalTokens);
    assert.equal(summary.nativeUsage[0].knownCostUsd, trace.costSnapshot.knownCostUsd);
    assert.deepEqual(examples.state.sessionTraces[trace.sessionId], [trace]);
  }
}
