import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from '../shared/fsx';

interface GatewayStartupErrorRecord {
  readonly version: 1;
  readonly attemptId: string;
  readonly pid: number;
  readonly message: string;
  readonly createdAt: string;
}

const FILE_NAME = 'startup-error.json';
const MAX_MESSAGE_LENGTH = 1_000;

export function gatewayStartupErrorPath(userDataDir: string): string {
  return path.join(userDataDir, 'gateway', FILE_NAME);
}

export async function clearGatewayStartupError(userDataDir: string): Promise<void> {
  await fs.promises.rm(gatewayStartupErrorPath(userDataDir), { force: true }).catch(() => undefined);
}

export async function writeGatewayStartupError(
  userDataDir: string,
  attemptId: string,
  pid: number,
  error: unknown
): Promise<string> {
  const message = sanitizeGatewayStartupError(error);
  const file = gatewayStartupErrorPath(userDataDir);
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, `${JSON.stringify({
    version: 1,
    attemptId,
    pid,
    message,
    createdAt: new Date().toISOString()
  } satisfies GatewayStartupErrorRecord)}\n`);
  await fs.promises.chmod(file, 0o600).catch(() => undefined);
  return message;
}

export async function readGatewayStartupError(
  userDataDir: string,
  attemptId: string,
  pid?: number
): Promise<string | undefined> {
  try {
    const value = JSON.parse(
      await fs.promises.readFile(gatewayStartupErrorPath(userDataDir), 'utf8')
    ) as Partial<GatewayStartupErrorRecord>;
    if (value.version !== 1
      || value.attemptId !== attemptId
      || (pid !== undefined && value.pid !== pid)
      || typeof value.message !== 'string'
      || !value.message.trim()) return undefined;
    return value.message.trim().slice(0, MAX_MESSAGE_LENGTH);
  } catch {
    return undefined;
  }
}

export function sanitizeGatewayStartupError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(api[-_ ]?key|authorization|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH) || 'Gateway 启动失败，未返回具体原因。';
}
