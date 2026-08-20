import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';

/** lock 文件名（住在 traceStore rootDir 里）。traceStore.clearAll 需要豁免它。 */
export const TAP_LOCK_FILE = 'tap.lock';
const LOCK_FILE = TAP_LOCK_FILE;

/** 指纹探活路由：TapProxy 无条件响应这个 path，带下面的响应头。 */
export const TAP_PING_PATH = '/xwx-trace/ping';
/** 指纹响应头：只有 XwX Trace 代理才会返回，区分「端口被无关进程占用」。 */
export const TAP_FINGERPRINT_HEADER = 'x-xwx-trace';

/** Standalone XwX Deck port range, isolated from the internal XwX Deck build. */
export const PRIMARY_TAP_PORT = 45233;
/** 默认端口被占时顺延的额外尝试次数；总共最多尝试 PRIMARY 起的 10 个端口。 */
export const FALLBACK_TAP_PORT_COUNT = 9;

/** 返回从 PRIMARY_TAP_PORT 起、长度 1+FALLBACK_TAP_PORT_COUNT 的候选端口数组。 */
export function tapPortCandidates(): number[] {
  const list: number[] = [];
  for (let i = 0; i <= FALLBACK_TAP_PORT_COUNT; i++) list.push(PRIMARY_TAP_PORT + i);
  return list;
}

/**
 * Parse an optional helper port override. An absent/blank production override
 * means "use the fixed XwX Trace range"; an explicit 0 remains available to
 * isolated smoke tests that need an OS-assigned port.
 */
export function parseTapListenPorts(value: string | undefined): number[] | undefined {
  if (!value?.trim()) return undefined;
  const ports = value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(Number)
    .filter(port => Number.isInteger(port) && port >= 0 && port <= 65535);
  return ports.length ? ports : undefined;
}

/** 在 127.0.0.1 上尝试 listen 候选端口，返回首个绑定成功后的真实端口（候选传 0 时返回系统分配端口）。全部失败时抛错。 */
export async function listenOnFixedPort(server: net.Server, ports: readonly number[] = tapPortCandidates()): Promise<number> {
  let lastErr: Error | undefined;
  for (const port of ports) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        await new Promise<void>(r => server.close(() => r()));
        throw new Error('server.address() did not expose a TCP port');
      }
      return addr.port;
    } catch (err) {
      lastErr = err as Error;
      // EADDRINUSE / EACCES 等错误一律认为是占用，继续顺延。
    }
  }
  throw new Error(`XwX Deck failed to bind any port in ${ports[0]}-${ports[ports.length - 1]}: ${lastErr?.message ?? 'unknown error'}`);
}

export interface TapPortLock {
  /** TCP 端口号 */
  readonly port: number;
  /** Owner 进程 PID（仅供调试，写删都不依赖它） */
  readonly pid: number;
  /** Owner 写入时间，ISO 字符串 */
  readonly startedAt: string;
}

export interface TapPortDecision {
  /** 是否本窗口成为 owner（需要 listen 真实端口、写 lock） */
  readonly role: 'owner' | 'follower';
  /** Owner 的端口；follower 时是已存活的 owner 端口 */
  readonly port?: number;
  /** 探测过程的简短说明（调试用） */
  readonly reason: string;
}

export function lockFilePath(rootDir: string): string {
  return path.join(rootDir, LOCK_FILE);
}

export async function readLock(rootDir: string): Promise<TapPortLock | undefined> {
  try {
    const text = await fs.promises.readFile(lockFilePath(rootDir), 'utf8');
    const json = JSON.parse(text);
    if (typeof json?.port === 'number' && typeof json?.pid === 'number' && typeof json?.startedAt === 'string') {
      return { port: json.port, pid: json.pid, startedAt: json.startedAt };
    }
  } catch { /* missing / malformed → undefined */ }
  return undefined;
}

export async function writeLock(rootDir: string, port: number): Promise<TapPortLock> {
  await fs.promises.mkdir(rootDir, { recursive: true });
  const lock: TapPortLock = { port, pid: process.pid, startedAt: new Date().toISOString() };
  await fs.promises.writeFile(lockFilePath(rootDir), JSON.stringify(lock), 'utf8');
  return lock;
}

/**
 * 排他写 lock（`wx` flag）：文件已存在时返回 undefined。
 * 两个窗口同时 enable 时只有一个能拿到 owner 资格，输家降级 follower——
  * 避免双 owner 互相覆写 lock + 连环接管 CLI 配置（备份链被 loopback 污染）。
 */
export async function tryWriteLockExclusive(rootDir: string, port: number): Promise<TapPortLock | undefined> {
  await fs.promises.mkdir(rootDir, { recursive: true });
  const lock: TapPortLock = { port, pid: process.pid, startedAt: new Date().toISOString() };
  try {
    await fs.promises.writeFile(lockFilePath(rootDir), JSON.stringify(lock), { encoding: 'utf8', flag: 'wx' });
    return lock;
  } catch {
    return undefined;
  }
}

/** 删除 lock 文件。**只在确认本窗口是 owner 时调用**——不校验文件内容，调用方负责。 */
export async function deleteLock(rootDir: string): Promise<void> {
  try { await fs.promises.rm(lockFilePath(rootDir), { force: true }); } catch { /* ignore */ }
}

/**
 * 指纹探活：GET /xwx-trace/ping 并校验 x-xwx-trace 响应头。
 * 被无关进程占用的端口返回 false（会被当作 stale 自愈），避免：
 * ① follower 认错主，把 Copilot/CLI 流量指向未知进程；
 * ② recoverOnStartup 误信残留备份对应的代理还活着，不去还原 CLI 配置。
 */
export function probeTapPort(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const req = http.get({ host: '127.0.0.1', port, path: TAP_PING_PATH, timeout: timeoutMs }, res => {
        const ok = res.statusCode === 200 && res.headers[TAP_FINGERPRINT_HEADER] === '1';
        res.resume();
        done(ok);
      });
      req.on('timeout', () => { req.destroy(); done(false); });
      req.on('error', () => done(false));
    } catch {
      done(false);
    }
  });
}

/** True when any process accepts TCP connections on the local port. */
export function probeLocalTcpPort(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (alive: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * 决定本窗口在 enable() 时该做 owner 还是 follower。
 *
 * - lock 存在 + 端口活着 → follower，复用现有 owner
 * - lock 不存在 / 端口死了 → 删 stale lock（如果有），本窗口要做 owner
 */
export async function decideRoleOnEnable(rootDir: string): Promise<TapPortDecision> {
  const lock = await readLock(rootDir);
  if (lock) {
    const alive = await probeTapPort(lock.port);
    if (alive) return { role: 'follower', port: lock.port, reason: `lock alive on :${lock.port}` };
    // lock 死了（或被无关进程占用），清理后准备做 owner
    await deleteLock(rootDir);
    return { role: 'owner', reason: `stale lock on :${lock.port} cleaned` };
  }
  return { role: 'owner', reason: 'no lock' };
}
