import { nativeTestBinary } from './test-support.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const root = await mkdtemp(join(await realpath(tmpdir()), 'xwx-index-repair-'));
const child = spawn(nativeTestBinary, ['--rpc', '--pilot-root', root]);
const pending = [];
createInterface({ input: child.stdout }).on('line', line => pending.shift()?.(JSON.parse(line)));
child.stderr.on('data', bytes => process.stderr.write(bytes));
function call(method, ...args) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(method + ' timeout')), 20000); pending.push(result => { clearTimeout(timer); resolve(result); }); child.stdin.write(JSON.stringify({ method, args }) + '\n'); }); }
async function rpc(method, ...args) { const result = await call(method, ...args); assert.equal(result.ok, true, result.error); return result.result; }
const checks = [];
function pass(message) { checks.push(message); }
try {
  await rpc('getState');
  const index = join(root, 'traces/index.json'), jsonl = join(root, 'traces/fixture.jsonl');
  let plan = await rpc('inspectTraceIndexRepair');
  assert.equal(plan.needsRepair, false); pass('empty installations do not offer a meaningless repair');
  const row = n => ({ id: 'r' + n, sessionId: 'fixture', source: 'codex', startedAt: '2026-10-09T00:00:00.000Z', completedAt: '2026-10-09T00:00:00.003Z', startedAtMs: 1791504000000, durationMs: 3, request: { model: 'fixture-model', body: { input: 'fixture input' } }, response: {}, usage: { totalTokens: n, inputTotalTokens: n - 2, inputUncachedTokens: n - 2, outputTokens: 2 } });
  const original = JSON.stringify(row(5)) + '\n' + JSON.stringify(row(7)) + '\n';
  await writeFile(jsonl, original);
  const saved = { version: 1, retainedMetadata: 'keep', usageOnly: { totalTokens: 4 }, sessions: [{ id: 'fixture', jsonlPath: jsonl, traceCount: 2, totalTokens: 12, firstPrompt: 'retained title', customMetadata: 'keep' }] };
  await writeFile(index, JSON.stringify(saved));
  plan = await rpc('inspectTraceIndexRepair'); assert.equal(plan.indexStatus, 'valid'); assert.equal(plan.needsRepair, false); pass('a healthy on-disk index is recognized even after external edits');
  saved.sessions[0].traceCount = 1;
  await writeFile(index, JSON.stringify(saved));
  plan = await rpc('inspectTraceIndexRepair'); assert.equal(plan.needsRepair, true); assert.equal(plan.staleIndexedFiles.length, 1); pass('incomplete session counts require repair');
  const priorBytes = await readFile(index, 'utf8');
  const repaired = await rpc('applyTraceIndexRepair', plan.indexSha256);
  const rebuilt = JSON.parse(await readFile(index, 'utf8'));
  assert.equal(rebuilt.sessions[0].traceCount, 2); assert.equal(rebuilt.sessions[0].totalTokens, 12); assert.equal(rebuilt.sessions[0].firstPrompt, 'retained title'); assert.equal(rebuilt.sessions[0].customMetadata, 'keep'); assert.equal(rebuilt.retainedMetadata, 'keep'); assert.equal(rebuilt.usageOnly.totalTokens, 4);
  assert.equal((await rpc('getTraceStats')).total.tokens, 16);
  assert.equal(await readFile(repaired.backupIndexPath, 'utf8'), priorBytes); assert.equal(await readFile(jsonl, 'utf8'), original); pass('repair restores true counts and usage while preserving source bytes and historical metadata');
  plan = await rpc('inspectTraceIndexRepair'); assert.equal(plan.needsRepair, false); pass('repaired indexes return to a healthy state');
  await rm(index); plan = await rpc('inspectTraceIndexRepair'); assert.equal(plan.indexStatus, 'missing'); assert.equal(plan.unindexedFiles.length, 1); assert.equal(plan.needsRepair, true);
  await rpc('applyTraceIndexRepair', plan.indexSha256); assert.equal(await readFile(jsonl, 'utf8'), original); pass('missing indexes recover existing JSONL records');
  await writeFile(index, '{broken'); plan = await rpc('inspectTraceIndexRepair'); assert.equal(plan.indexStatus, 'invalid');
  const corruptRepair = await rpc('applyTraceIndexRepair', plan.indexSha256); assert.equal(await readFile(corruptRepair.backupIndexPath, 'utf8'), '{broken'); pass('corrupt indexes are backed up before rebuilding');
  await writeFile(jsonl, original + '{truncated\n'); plan = await rpc('inspectTraceIndexRepair'); assert.equal(plan.candidates[0].malformedRecords, 1);
  await rpc('applyTraceIndexRepair', plan.indexSha256); assert.equal(await readFile(jsonl, 'utf8'), original + '{truncated\n'); assert.equal((await rpc('getTraceStats')).total.tokens, 12); pass('invalid record lines are reported and retained without inventing usage');
  plan = await rpc('inspectTraceIndexRepair'); await writeFile(index, (await readFile(index, 'utf8')) + '\n'); const rejected = await call('applyTraceIndexRepair', plan.indexSha256); assert.equal(rejected.ok, false); assert.match(rejected.error, /外部修改/); pass('changes after inspection reject stale repair');
  await rm(jsonl); plan = await rpc('inspectTraceIndexRepair'); assert.equal(plan.needsRepair, true); assert.equal(plan.missingIndexedFiles.length, 1); assert.equal(plan.candidates.length, 0); pass('missing raw records are reported without claiming recoverability');
  const done = once(child, 'exit'); child.stdin.end(); assert.equal((await done)[0], 0);
  console.log(JSON.stringify({ passed: true, checks, root }));
} finally { if (child.exitCode === null) child.kill(); }
