import { AsyncLocalStorage } from 'async_hooks';
import * as path from 'path';

/**
 * Single-writer lock for a managed client configuration file.
 *
 * Every XwX Deck write to `config.toml` (and to Claude's settings file) is a
 * read-modify-write against a compare-and-swap guard: the writer re-reads the
 * file and refuses to continue when it no longer matches the snapshot it
 * patched. That guard exists to protect *external* edits, but it cannot tell an
 * external editor from a second XwX Deck code path, so two of our own
 * concurrent transactions used to surface as
 * "配置在写入前被其他软件修改".
 *
 * The writers are spread over several independent promise queues on purpose —
 * the mutation queue, the per-client queue, background history alignment,
 * forced-exit restoration. Rather than forcing all of those onto one business
 * queue (which would make an unrelated gigabyte-scale history scan delay a
 * simple provider switch), they share this much narrower lock: it only covers
 * the read-modify-write of one file, keyed by that file's path.
 *
 * With every in-process writer holding it, a CAS failure again means exactly
 * one thing: another program really did edit the file.
 *
 * The lock is re-entrant. A locked method may call another locked method for
 * the same file without deadlocking, because the owning async context is
 * tracked and simply runs the inner action inline.
 */
const chains = new Map<string, Promise<unknown>>();
const ownedKeys = new AsyncLocalStorage<ReadonlySet<string>>();

function lockKey(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function withConfigFileLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const key = lockKey(file);
  const owned = ownedKeys.getStore();
  if (owned?.has(key)) return action();
  const nextOwned = new Set(owned ?? []);
  nextOwned.add(key);
  const run = (): Promise<T> => ownedKeys.run(nextOwned, action);
  const previous = chains.get(key) ?? Promise.resolve();
  const result = previous.then(run, run);
  chains.set(key, result.then(() => undefined, () => undefined));
  return result;
}
