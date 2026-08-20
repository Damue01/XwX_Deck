import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const TRACE_WRITER_LEASE_FILE = 'trace-writer.lock';

interface TraceWriterLeaseRecord {
  readonly version: 1;
  readonly pid: number;
  readonly leaseId: string;
  readonly startedAt: string;
}

export interface TraceWriterLease {
  readonly path: string;
  readonly pid: number;
  readonly leaseId: string;
  release(): Promise<void>;
}

const INITIALIZING_LEASE_MAX_AGE_MS = 10_000;
const ACQUIRE_RETRY_MS = 100;
const ACQUIRE_ATTEMPTS = 3;

/**
 * Own the production Trace write path across helper processes.
 *
 * TraceStore serializes writes only inside one process. Without an external
 * lease, two helpers can independently choose the same turn, then interleave
 * very large JSONL append operations. Root the lease beside the Trace data so
 * different app user-data directories cannot write one history concurrently.
 */
export async function acquireTraceWriterLease(rootDir: string): Promise<TraceWriterLease> {
  await fs.promises.mkdir(rootDir, { recursive: true });
  const leasePath = path.join(rootDir, TRACE_WRITER_LEASE_FILE);
  const record: TraceWriterLeaseRecord = {
    version: 1,
    pid: process.pid,
    leaseId: randomUUID(),
    startedAt: new Date().toISOString()
  };

  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      const handle = await fs.promises.open(leasePath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      await fs.promises.chmod(leasePath, 0o600).catch(() => undefined);
      return {
        path: leasePath,
        pid: record.pid,
        leaseId: record.leaseId,
        release: () => releaseTraceWriterLease(leasePath, record)
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const existing = await readTraceWriterLease(leasePath);
    if (existing && processAlive(existing.pid)) {
      throw new Error(`Trace 数据目录已有写入进程（PID ${existing.pid}），未启动第二个 Gateway helper。`);
    }

    if (!existing) {
      const ageMs = await leaseAgeMs(leasePath);
      if (ageMs !== undefined && ageMs < INITIALIZING_LEASE_MAX_AGE_MS) {
        if (attempt + 1 < ACQUIRE_ATTEMPTS) {
          await delay(ACQUIRE_RETRY_MS);
          continue;
        }
        throw new Error('Trace 写入租约正在初始化，未启动第二个 Gateway helper。');
      }
    }

    await fs.promises.rm(leasePath, { force: true }).catch(() => undefined);
  }

  throw new Error('无法取得 Trace 写入租约。');
}

async function releaseTraceWriterLease(
  leasePath: string,
  owned: TraceWriterLeaseRecord
): Promise<void> {
  const current = await readTraceWriterLease(leasePath);
  if (!current || current.leaseId !== owned.leaseId || current.pid !== owned.pid) return;
  await fs.promises.rm(leasePath, { force: true }).catch(() => undefined);
}

async function readTraceWriterLease(filePath: string): Promise<TraceWriterLeaseRecord | undefined> {
  try {
    const value = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as Partial<TraceWriterLeaseRecord>;
    if (value.version !== 1
      || !Number.isInteger(value.pid)
      || typeof value.leaseId !== 'string'
      || !value.leaseId
      || typeof value.startedAt !== 'string') {
      return undefined;
    }
    return value as TraceWriterLeaseRecord;
  } catch {
    return undefined;
  }
}

async function leaseAgeMs(filePath: string): Promise<number | undefined> {
  try {
    return Math.max(0, Date.now() - (await fs.promises.stat(filePath)).mtimeMs);
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
