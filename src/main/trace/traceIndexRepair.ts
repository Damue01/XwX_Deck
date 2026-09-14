import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ensureDir, writeJson } from '../shared/fsx';
import { recoverSessionSummaryFromJsonl } from './traceStore';
import { TapHistoryIndex, TapSessionSummary } from './types';
import { acquireTraceWriterLease } from './traceWriterLease';

export interface TraceIndexRepairCandidate {
  readonly id: string;
  readonly jsonlPath: string;
  readonly validRecords: number;
  readonly malformedRecords: number;
  readonly summary: TapSessionSummary;
}

export interface TraceIndexRepairPlan {
  readonly rootPath: string;
  readonly indexPath: string;
  readonly indexStatus: 'valid' | 'missing' | 'invalid';
  readonly indexSha256: string;
  readonly indexedSessions: number;
  readonly jsonlFiles: number;
  readonly missingIndexedFiles: readonly string[];
  readonly candidates: readonly TraceIndexRepairCandidate[];
}

export interface AppliedTraceIndexRepair extends TraceIndexRepairPlan {
  readonly applied: true;
  readonly backupIndexPath?: string;
  readonly recoveredSessions: number;
}

export async function inspectTraceIndexRepair(rootDir: string): Promise<TraceIndexRepairPlan> {
  const rootPath = path.resolve(rootDir);
  const indexPath = path.join(rootPath, 'index.json');
  const { index, status, bytes, sha256 } = await readIndexSnapshot(indexPath);
  const entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
  const jsonlFiles = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => path.join(rootPath, entry.name))
    .sort((a, b) => a.localeCompare(b));
  const indexedIds = new Set(index.sessions.map(session => session.id));
  const missingIndexedFiles: string[] = [];
  for (const session of index.sessions) {
    try {
      await fs.promises.access(path.join(rootPath, `${session.id}.jsonl`), fs.constants.R_OK);
    } catch {
      missingIndexedFiles.push(session.id);
    }
  }

  const candidates: TraceIndexRepairCandidate[] = [];
  for (const jsonlPath of jsonlFiles) {
    const id = path.basename(jsonlPath, '.jsonl');
    if (indexedIds.has(id)) continue;
    const recovered = await recoverSessionSummaryFromJsonl(jsonlPath);
    candidates.push({
      id,
      jsonlPath,
      validRecords: recovered.validRecords,
      malformedRecords: recovered.malformedRecords,
      summary: recovered.summary
    });
  }

  // Keep the exact bytes alive until the scan finishes. Besides avoiding an
  // unused snapshot, this documents that the plan is tied to one immutable
  // index version rather than only an mtime/size pair.
  if (sha256Hex(bytes) !== sha256) throw new Error(`Trace index changed while reading: ${indexPath}`);
  return {
    rootPath,
    indexPath,
    indexStatus: status,
    indexSha256: sha256,
    indexedSessions: index.sessions.length,
    jsonlFiles: jsonlFiles.length,
    missingIndexedFiles,
    candidates
  };
}

export async function applyTraceIndexRepair(
  rootDir: string,
  expectedIndexSha256?: string
): Promise<AppliedTraceIndexRepair> {
  const lease = await acquireTraceWriterLease(rootDir);
  try {
    return await applyTraceIndexRepairUnlocked(rootDir, expectedIndexSha256);
  } finally {
    await lease.release();
  }
}

async function applyTraceIndexRepairUnlocked(
  rootDir: string,
  expectedIndexSha256?: string
): Promise<AppliedTraceIndexRepair> {
  const plan = await inspectTraceIndexRepair(rootDir);
  if (expectedIndexSha256 && plan.indexSha256 !== expectedIndexSha256) {
    throw new Error('Trace 索引已在扫描后发生变化，本次修复未作任何修改。请重新扫描后再试。');
  }
  const current = await readIndexSnapshot(plan.indexPath);
  if (current.status !== plan.indexStatus || current.sha256 !== plan.indexSha256) {
    throw new Error('Trace 索引在修复检查期间发生变化，本次修复未作任何修改。请重新扫描后再试。');
  }
  const recoveryDir = path.join(plan.rootPath, '_index-recovery');
  await ensureDir(recoveryDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupIndexPath = current.status === 'missing'
    ? undefined
    : path.join(recoveryDir, `index.before-${stamp}.json`);
  if (backupIndexPath) await fs.promises.writeFile(backupIndexPath, current.bytes, { flag: 'wx' });

  const recoveredIds = new Set(plan.candidates.map(candidate => candidate.id));
  const sessions = [
    ...(current.status === 'valid' ? current.index.sessions : [])
      .filter(session => !recoveredIds.has(session.id))
      .map(session => ({ ...session, jsonlPath: path.join(plan.rootPath, `${session.id}.jsonl`) })),
    ...plan.candidates.map(candidate => candidate.summary)
  ].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  await writeJson(path.join(recoveryDir, `manifest-${stamp}.json`), {
    version: 1,
    appliedAt: new Date().toISOString(),
    priorIndexStatus: plan.indexStatus,
    priorIndexSha256: plan.indexSha256,
    ...(backupIndexPath ? { backupIndexPath } : {}),
    recovered: plan.candidates.map(candidate => ({
      id: candidate.id,
      jsonlPath: candidate.jsonlPath,
      validRecords: candidate.validRecords,
      malformedRecords: candidate.malformedRecords
    }))
  });
  await writeJson(plan.indexPath, { version: 1, sessions } satisfies TapHistoryIndex);
  return {
    ...plan,
    applied: true,
    backupIndexPath,
    recoveredSessions: plan.candidates.length
  };
}

async function readIndexSnapshot(indexPath: string): Promise<{
  readonly index: TapHistoryIndex;
  readonly status: TraceIndexRepairPlan['indexStatus'];
  readonly bytes: Buffer;
  readonly sha256: string;
}> {
  let bytes: Buffer;
  try {
    bytes = await fs.promises.readFile(indexPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    bytes = Buffer.alloc(0);
    return {
      index: { version: 1, sessions: [] },
      status: 'missing',
      bytes,
      sha256: sha256Hex(bytes)
    };
  }
  try {
    const index = JSON.parse(bytes.toString('utf8')) as TapHistoryIndex;
    if (
      index?.version === 1
      && Array.isArray(index.sessions)
      && index.sessions.every(session => (
        !!session
        && typeof session === 'object'
        && typeof session.id === 'string'
        && !!session.id
        && typeof session.jsonlPath === 'string'
        && !!session.jsonlPath
      ))
    ) {
      return { index, status: 'valid', bytes, sha256: sha256Hex(bytes) };
    }
  } catch {
    // Preserve and hash the exact invalid bytes. Explicit apply will back them
    // up before reconstructing the derived index from JSONL records.
  }
  return {
    index: { version: 1, sessions: [] },
    status: 'invalid',
    bytes,
    sha256: sha256Hex(bytes)
  };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
