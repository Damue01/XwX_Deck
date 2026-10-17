import assert from 'node:assert/strict';

// Fail closed before real records enter a public build. This contract examines
// only the reviewed fixture; it never opens a local account or capture directory.
export function validateRealExamples(examples) {
  const conversation = examples.provenance.kind === 'sanitized-real-conversation';
  if (conversation) {
    assert.equal(examples.provenance.publicApproved, true);
    assert.equal(examples.provenance.localOnly, false);
  } else {
    assert.equal(examples.provenance.kind, 'sanitized-real-requests');
    assert.equal(examples.provenance.normalAccountFilesUnchanged, true);
  }
  assert.ok(Number.isFinite(Date.parse(examples.provenance.capturedAt)));
  const { sessions, traces } = examples.state;
  assert.ok(traces.length >= 3);
  assert.equal(examples.provenance.requestCount, traces.length);
  assert.ok(sessions.length > 0);
  const forbiddenKeys = /^(authorization|cookie|set-cookie|headers|access_token|refresh_token|id_token|encrypted_content|account_id|accountId|email|connectionId|clientConversationKey|rawBody)$/i;
  const privateText = /Bearer\s+\S+|\/(?:Users|private|home)\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{30,}\.|gAAAA[A-Za-z0-9_+=/-]{80,}|MEMORY_SUMMARY BEGINS/i;
  function scan(value) {
    if (typeof value === 'string') {
      assert.ok(!privateText.test(value), 'Private material cannot enter the website fixture');
      let nested;
      try { nested = JSON.parse(value); } catch { /* Ordinary text. */ }
      if (nested && typeof nested === 'object') scan(nested);
      for (const line of value.split('\n')) if (line.startsWith('data: ')) {
        let event;
        try { event = JSON.parse(line.slice(6)); } catch { /* Non-JSON SSE sentinel. */ }
        if (event && typeof event === 'object') scan(event);
      }
    }
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      assert.ok(!forbiddenKeys.test(key), 'Private field in website fixture: ' + key);
      scan(child);
    }
  }
  scan(examples);
  for (const trace of traces) {
    assert.match(trace.id, /^example-request-\d+$/);
    assert.match(trace.sessionId, conversation ? /^example-weather$/ : /^example-session-\d+$/);
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
    assert.ok(sessions.some(row => row.id === trace.sessionId));
  }
  for (const summary of sessions) {
    const rows = traces.filter(trace => trace.sessionId === summary.id);
    assert.equal(summary.totalTokens, rows.reduce((sum, row) => sum + row.usage.totalTokens, 0));
    if (!conversation) {
      assert.equal(summary.nativeUsage[0].knownCostUsd, rows[0].costSnapshot.knownCostUsd);
      assert.deepEqual(examples.state.sessionTraces[summary.id], rows);
    }
  }
}
