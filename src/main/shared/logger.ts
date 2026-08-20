import * as fs from 'fs';
import * as path from 'path';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogFn {
  (msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

let logFile: string | undefined;

export function initLogger(userDataDir: string): void {
  setLogDirectory(path.join(userDataDir, 'logs'));
}

export function setLogDirectory(rootDir: string): void {
  logFile = path.join(rootDir, 'xwxdeck.log');
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  } catch {
    logFile = undefined;
  }
}

function safe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function write(level: LogLevel, msg: string, args: unknown[]): void {
  const text = args.length ? `${msg} ${args.map(safe).join(' ')}` : msg;
  const line = `${new Date().toISOString()} [${level}] ${text}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  if (!logFile) return;
  fs.appendFile(logFile, `${line}\n`, () => undefined);
}

const base = ((msg: string, ...args: unknown[]) => write('info', msg, args)) as LogFn;
base.info = (msg, ...args) => write('info', msg, args);
base.warn = (msg, ...args) => write('warn', msg, args);
base.error = (msg, ...args) => write('error', msg, args);
base.debug = (msg, ...args) => write('debug', msg, args);

export const log: LogFn = base;
