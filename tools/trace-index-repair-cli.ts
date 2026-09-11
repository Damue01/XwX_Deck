import * as path from 'path';
import { applyTraceIndexRepair, inspectTraceIndexRepair } from '../src/main/trace/traceIndexRepair';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const rootArg = args.find(arg => arg !== '--apply');
  if (!rootArg || !path.isAbsolute(rootArg)) {
    throw new Error('Usage: npm run repair:trace-index -- <absolute-trace-root> [--apply]');
  }
  const plan = await inspectTraceIndexRepair(rootArg);
  if (!apply) {
    console.log(JSON.stringify({
      ...plan,
      candidates: plan.candidates.map(candidate => ({
        id: candidate.id,
        jsonlPath: candidate.jsonlPath,
        validRecords: candidate.validRecords,
        malformedRecords: candidate.malformedRecords,
        hidden: candidate.summary.hidden === true,
        source: candidate.summary.source,
        clientConversationKey: candidate.summary.clientConversationKey
      })),
      applied: false
    }, null, 2));
    return;
  }
  const result = await applyTraceIndexRepair(rootArg, plan.indexSha256);
  console.log(JSON.stringify({
    applied: true,
    rootPath: result.rootPath,
    priorIndexStatus: result.indexStatus,
    priorIndexSha256: result.indexSha256,
    backupIndexPath: result.backupIndexPath,
    recoveredSessions: result.recoveredSessions,
    malformedRecords: result.candidates.reduce((sum, candidate) => sum + candidate.malformedRecords, 0)
  }, null, 2));
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
