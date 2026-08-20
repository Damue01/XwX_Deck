import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const MAX_REPORTED_ITEMS = 24;

export async function auditTraceIntegrity(rootDir) {
  const root = path.resolve(rootDir);
  const indexPath = path.join(root, 'index.json');
  const rawIndex = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
  if (rawIndex?.version !== 1 || !Array.isArray(rawIndex.sessions)) {
    throw new Error(`Invalid Trace index: ${indexPath}`);
  }

  const result = {
    version: 1,
    rootPath: root,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    summary: {
      sessions: 0,
      records: 0,
      malformedRecords: 0,
      errorSessions: 0,
      warningSessions: 0,
      totalBytes: 0
    },
    sessions: []
  };

  for (const session of rawIndex.sessions) {
    if (!session || typeof session.id !== 'string' || typeof session.jsonlPath !== 'string') continue;
    const audit = await auditSession(session);
    result.sessions.push(audit);
    result.summary.sessions += 1;
    result.summary.records += audit.validRecords;
    result.summary.malformedRecords += audit.malformedRecords;
    result.summary.totalBytes += audit.fileBytes;
    if (audit.severity === 'error') result.summary.errorSessions += 1;
    else if (audit.severity === 'warning') result.summary.warningSessions += 1;
  }

  return result;
}

async function auditSession(session) {
  const turnCounts = new Map();
  const traceIds = new Set();
  const duplicateTraceIds = [];
  const malformedLineNumbers = [];
  const strongConversationKeyMismatches = [];
  let fileBytes = 0;
  let physicalLines = 0;
  let validRecords = 0;
  let malformedRecords = 0;
  let maxTurn = 0;
  let sourceMismatches = 0;
  let sessionIdMismatches = 0;

  try {
    fileBytes = (await fsp.stat(session.jsonlPath)).size;
    const input = fs.createReadStream(session.jsonlPath);
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      physicalLines += 1;
      let trace;
      try {
        trace = JSON.parse(line);
      } catch {
        malformedRecords += 1;
        if (malformedLineNumbers.length < MAX_REPORTED_ITEMS) {
          malformedLineNumbers.push(physicalLines);
        }
        continue;
      }
      validRecords += 1;

      if (Number.isInteger(trace.turn) && trace.turn > 0) {
        maxTurn = Math.max(maxTurn, trace.turn);
        turnCounts.set(trace.turn, (turnCounts.get(trace.turn) || 0) + 1);
      }
      if (typeof trace.id === 'string' && trace.id) {
        if (traceIds.has(trace.id) && duplicateTraceIds.length < MAX_REPORTED_ITEMS) {
          duplicateTraceIds.push(trace.id);
        }
        traceIds.add(trace.id);
      }
      if (trace.source && session.source && trace.source !== session.source) {
        sourceMismatches += 1;
      }
      if (trace.sessionId && trace.sessionId !== session.id) {
        sessionIdMismatches += 1;
      }
      if (trace.routedBy === 'clientConversationKey'
        && trace.clientConversationKey
        && session.clientConversationKey
        && trace.clientConversationKey !== session.clientConversationKey
        && strongConversationKeyMismatches.length < MAX_REPORTED_ITEMS) {
        strongConversationKeyMismatches.push(trace.turn);
      }
    }
  } catch (error) {
    return {
      id: session.id,
      source: session.source,
      hidden: session.hidden === true,
      auxiliary: session.auxiliary,
      indexTraceCount: Number(session.traceCount) || 0,
      fileBytes,
      physicalLines,
      validRecords,
      malformedRecords,
      maxTurn,
      missingTurnCount: 0,
      missingTurns: [],
      duplicateTurns: [],
      duplicateTraceIds,
      sourceMismatches,
      sessionIdMismatches,
      strongConversationKeyMismatches,
      severity: 'error',
      issues: [`file-read-failed: ${error instanceof Error ? error.message : String(error)}`]
    };
  }

  const duplicateTurns = [...turnCounts.entries()]
    .filter(([, count]) => count > 1)
    .slice(0, MAX_REPORTED_ITEMS)
    .map(([turn, count]) => ({ turn, count }));
  const missingTurns = [];
  let missingTurnCount = 0;
  for (let turn = 1; turn <= maxTurn; turn += 1) {
    if (turnCounts.has(turn)) continue;
    missingTurnCount += 1;
    if (missingTurns.length < MAX_REPORTED_ITEMS) missingTurns.push(turn);
  }

  const issues = [];
  if (malformedRecords > 0) issues.push('malformed-jsonl');
  if (duplicateTurns.length > 0) issues.push('duplicate-turn');
  if (missingTurnCount > 0) issues.push('missing-turn');
  if (duplicateTraceIds.length > 0) issues.push('duplicate-trace-id');
  if (sourceMismatches > 0) issues.push('source-mismatch');
  if (sessionIdMismatches > 0) issues.push('session-id-mismatch');
  if (strongConversationKeyMismatches.length > 0) issues.push('strong-conversation-key-mismatch');
  if (physicalLines !== Number(session.traceCount || 0)) issues.push('index-line-count-drift');
  if (maxTurn !== Number(session.traceCount || 0)) issues.push('index-turn-count-drift');

  const hardIssues = new Set([
    'malformed-jsonl',
    'duplicate-turn',
    'missing-turn',
    'duplicate-trace-id',
    'source-mismatch',
    'session-id-mismatch',
    'strong-conversation-key-mismatch'
  ]);
  const severity = issues.some(issue => hardIssues.has(issue))
    ? 'error'
    : issues.length > 0
      ? 'warning'
      : 'ok';

  return {
    id: session.id,
    source: session.source,
    hidden: session.hidden === true,
    auxiliary: session.auxiliary,
    indexTraceCount: Number(session.traceCount) || 0,
    fileBytes,
    physicalLines,
    validRecords,
    malformedRecords,
    malformedLineNumbers,
    maxTurn,
    missingTurnCount,
    missingTurns,
    duplicateTurns,
    duplicateTraceIds,
    sourceMismatches,
    sessionIdMismatches,
    strongConversationKeyMismatches,
    severity,
    issues
  };
}

async function main() {
  const rootDir = process.argv[2];
  if (!rootDir || !path.isAbsolute(rootDir)) {
    console.error('Usage: npm run diagnose:trace -- <absolute-trace-root>');
    process.exitCode = 1;
    return;
  }
  const result = await auditTraceIntegrity(rootDir);
  console.log(JSON.stringify(result, null, 2));
  if (result.summary.errorSessions > 0) process.exitCode = 2;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  await main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
