import * as fs from 'fs';
import * as path from 'path';

const RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800] as const;

export async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const txt = await fs.promises.readFile(file, 'utf8');
    return JSON.parse(txt) as T;
  } catch {
    return fallback;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(value, null, 2));
}

/** Atomically write UTF-8 text or exact bytes: write a unique temp sibling, then rename over the target. */
export async function writeFileAtomic(file: string, content: string | Uint8Array): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  try {
    if (typeof content === 'string') await fs.promises.writeFile(tmp, content, 'utf8');
    else await fs.promises.writeFile(tmp, content);
    await renameWithRetry(tmp, file);
  } finally {
    // A locked Windows destination can make rename fail. Never leave a fixed
    // sibling behind that poisons later writes or collides with another process.
    await fs.promises.unlink(tmp).catch(() => undefined);
  }
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.promises.rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error;
      await new Promise<void>(resolve => setTimeout(resolve, delay));
    }
  }
}

/** Read a UTF-8 file, stripping a leading BOM; returns `undefined` when it can't be read. */
export async function readTextOrUndefined(file: string): Promise<string | undefined> {
  try {
    const text = await fs.promises.readFile(file, 'utf8');
    return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  } catch {
    return undefined;
  }
}

/** Synchronous {@link readTextOrUndefined}. */
export function readTextOrUndefinedSync(file: string): string | undefined {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  } catch {
    return undefined;
  }
}
