import { isRecord } from './obj';

/** Parse JSON, returning `undefined` for empty/whitespace/invalid input instead of throwing. */
export function safeJsonParse(text: string | undefined | null): unknown {
  if (typeof text !== 'string') return undefined;
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Parse JSON and return it only when the result is a plain object; otherwise `undefined`. */
export function parseJsonObject(text: string | undefined | null): Record<string, unknown> | undefined {
  const value = safeJsonParse(text);
  return isRecord(value) ? value : undefined;
}
