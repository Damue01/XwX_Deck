import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { ensureDir, readJson, writeJson } from '../shared/fsx';

const MAX_RECOVERED_TRANSCRIPT_CHARS = 60_000;
const MAX_RECOVERED_ITEM_CHARS = 6_000;
const MAX_CHECKPOINTS = 256;
const CHECKPOINT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PORTABILITY_SUMMARY_PREFIX =
  'Another language model started to solve this problem and produced a summary of its work. Continue from this summary without repeating completed work:';

export type PortableCheckpointSource = 'compacted_message' | 'replacement_history' | 'recovered_transcript';

export interface PortableCheckpoint {
  readonly text: string;
  readonly source: PortableCheckpointSource;
  /** Byte offset immediately after the compaction row summarized by `text`. */
  readonly coveredThroughBytes: number;
  readonly rolloutFile: string;
}

interface CheckpointIndexEntry {
  readonly rolloutRelativePath: string;
  readonly summary: string;
  readonly source: Exclude<PortableCheckpointSource, 'recovered_transcript'>;
  readonly coveredThroughBytes: number;
  readonly boundaryStartBytes: number;
  readonly boundaryHash: string;
  readonly updatedAt: number;
}

interface CheckpointIndexFile {
  readonly version: 1;
  readonly entries: Readonly<Record<string, CheckpointIndexEntry>>;
}

/**
 * Reads only the rollout tail after the latest known compaction boundary.
 * The source JSONL remains the audit log; this index is a disposable speed-up.
 */
export class CodexPortableHistory {
  private readonly entries = new Map<string, CheckpointIndexEntry>();
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly codexHome: string,
    private readonly indexFile?: string
  ) {}

  async read(
    threadId: string | undefined,
    options: { readonly includeDelta?: boolean } = {}
  ): Promise<PortableCheckpoint | undefined> {
    const normalized = normalizeThreadId(threadId);
    if (!normalized) return undefined;
    await this.load();
    const file = await findRolloutFile(this.codexHome, normalized);
    if (!file) return undefined;
    const stat = await fs.promises.stat(file).catch(() => undefined);
    if (!stat?.isFile()) return undefined;

    const relative = path.relative(this.codexHome, file);
    const cached = this.entries.get(normalized);
    const canResume = !!cached
      && cached.rolloutRelativePath === relative
      && cached.coveredThroughBytes <= stat.size
      && await boundaryMatches(file, cached);
    const start = canResume ? cached.coveredThroughBytes : 0;
    let latestSummary = canResume
      ? { text: cached.summary, source: cached.source }
      : undefined;
    let coveredThroughBytes = canResume ? cached.coveredThroughBytes : 0;
    let boundaryStartBytes = canResume ? cached.boundaryStartBytes : 0;
    let boundaryHash = canResume ? cached.boundaryHash : '';
    const transcript = new BoundedTranscript();

    await forEachCompleteJsonlLine(file, start, (line, startOffset, endOffset) => {
      let item: Record<string, any>;
      try { item = JSON.parse(line) as Record<string, any>; } catch { return; }
      if (item.type === 'compacted') {
        const summary = compactedSummary(item.payload);
        if (summary) {
          latestSummary = summary;
          boundaryStartBytes = startOffset;
          coveredThroughBytes = endOffset;
          boundaryHash = lineHash(line);
          transcript.clear();
        }
        return;
      }
      const text = transcriptItemText(item);
      if (text) transcript.push(text);
    });

    if (latestSummary) {
      const entry: CheckpointIndexEntry = {
        rolloutRelativePath: relative,
        summary: latestSummary.text,
        source: latestSummary.source,
        coveredThroughBytes,
        boundaryStartBytes,
        boundaryHash,
        updatedAt: Date.now()
      };
      this.entries.set(normalized, entry);
      this.prune(Date.now());
      await this.persist();
      const delta = transcript.text();
      return {
        source: latestSummary.source,
        coveredThroughBytes,
        rolloutFile: file,
        text: options.includeDelta && delta
          ? `${latestSummary.text}\n\nUpdates recorded after that checkpoint:\n\n${delta}`
          : latestSummary.text
      };
    }

    const recovered = transcript.text();
    if (!recovered) return undefined;
    return {
      source: 'recovered_transcript',
      coveredThroughBytes: 0,
      rolloutFile: file,
      text: `${PORTABILITY_SUMMARY_PREFIX}\n\nThe original provider's opaque checkpoint was unavailable. The following bounded plain-text transcript was recovered from the local Codex history:\n\n${recovered}`
    };
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        if (this.indexFile) {
          const saved = await readJson<CheckpointIndexFile>(this.indexFile, { version: 1, entries: {} });
          if (saved.version === 1 && isRecord(saved.entries)) {
            for (const [threadId, raw] of Object.entries(saved.entries)) {
              if (!isRecord(raw)) continue;
              const source = raw.source === 'compacted_message' || raw.source === 'replacement_history'
                ? raw.source
                : undefined;
              if (!source || typeof raw.summary !== 'string' || !raw.summary.trim()) continue;
              if (typeof raw.rolloutRelativePath !== 'string' || path.isAbsolute(raw.rolloutRelativePath)) continue;
              if (!Number.isSafeInteger(raw.coveredThroughBytes) || Number(raw.coveredThroughBytes) < 0) continue;
              this.entries.set(threadId, {
                rolloutRelativePath: raw.rolloutRelativePath,
                summary: raw.summary,
                source,
                coveredThroughBytes: Number(raw.coveredThroughBytes),
                boundaryStartBytes: number(raw.boundaryStartBytes),
                boundaryHash: typeof raw.boundaryHash === 'string' ? raw.boundaryHash : '',
                updatedAt: number(raw.updatedAt) || Date.now()
              });
            }
          }
        }
        this.prune(Date.now());
        this.loaded = true;
      })();
    }
    await this.loadPromise;
  }

  private prune(now: number): void {
    for (const [threadId, entry] of this.entries) {
      if (now - entry.updatedAt > CHECKPOINT_TTL_MS) this.entries.delete(threadId);
    }
    if (this.entries.size <= MAX_CHECKPOINTS) return;
    const oldest = [...this.entries.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (let index = 0; index < oldest.length - MAX_CHECKPOINTS; index += 1) {
      this.entries.delete(oldest[index][0]);
    }
  }

  private persist(): Promise<void> {
    if (!this.indexFile) return Promise.resolve();
    const write = async (): Promise<void> => {
      await ensureDir(path.dirname(this.indexFile!));
      await writeJson(this.indexFile!, {
        version: 1,
        entries: Object.fromEntries(this.entries)
      } satisfies CheckpointIndexFile);
    };
    const next = this.writeChain.then(write, write);
    this.writeChain = next.then(() => undefined, () => undefined);
    return next;
  }
}

class BoundedTranscript {
  private readonly items: string[] = [];
  private chars = 0;

  clear(): void {
    this.items.length = 0;
    this.chars = 0;
  }

  push(text: string): void {
    const clipped = text.length > MAX_RECOVERED_ITEM_CHARS
      ? `${text.slice(0, MAX_RECOVERED_ITEM_CHARS)}\n[truncated]`
      : text;
    this.items.push(clipped);
    this.chars += clipped.length;
    while (this.chars > MAX_RECOVERED_TRANSCRIPT_CHARS && this.items.length > 1) {
      this.chars -= this.items.shift()!.length;
    }
  }

  text(): string {
    return this.items.join('\n\n');
  }
}

async function forEachCompleteJsonlLine(
  file: string,
  start: number,
  visit: (line: string, startOffset: number, endOffset: number) => void
): Promise<void> {
  const stream = fs.createReadStream(file, { start });
  let pending = Buffer.alloc(0);
  let consumed = start;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let newline: number;
    while ((newline = pending.indexOf(0x0a)) >= 0) {
      const startOffset = consumed;
      let line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      consumed += newline + 1;
      if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
      if (line.length) visit(line.toString('utf8'), startOffset, consumed);
    }
  }
  // Ignore an unterminated final row: Codex may still be appending it.
}

async function boundaryMatches(file: string, entry: CheckpointIndexEntry): Promise<boolean> {
  if (!entry.boundaryHash || entry.boundaryStartBytes < 0 || entry.boundaryStartBytes >= entry.coveredThroughBytes) {
    return false;
  }
  const length = entry.coveredThroughBytes - entry.boundaryStartBytes;
  if (length > MAX_RECOVERED_ITEM_CHARS * 20) return false;
  const handle = await fs.promises.open(file, 'r').catch(() => undefined);
  if (!handle) return false;
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, entry.boundaryStartBytes);
    if (bytesRead !== length) return false;
    const line = buffer.subarray(0, buffer.at(-1) === 0x0a ? -1 : undefined);
    const normalized = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
    return lineHash(normalized.toString('utf8')) === entry.boundaryHash;
  } finally {
    await handle.close();
  }
}

function lineHash(line: string): string {
  return createHash('sha256').update(line).digest('hex');
}

function compactedSummary(value: unknown): { text: string; source: 'compacted_message' | 'replacement_history' } | undefined {
  if (!isRecord(value)) return undefined;
  const message = string(value.message).trim();
  if (message) return { text: message, source: 'compacted_message' };
  const replacement = summaryFromReplacementHistory(value.replacement_history);
  return replacement ? { text: replacement, source: 'replacement_history' } : undefined;
}

function summaryFromReplacementHistory(value: unknown): string {
  if (!Array.isArray(value)) return '';
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const item = value[index];
    if (!isRecord(item) || item.role !== 'user') continue;
    const text = contentText(item.content);
    if (text.startsWith('Another language model started')) return text;
  }
  return '';
}

function transcriptItemText(value: Record<string, any>): string {
  if (value.type !== 'response_item' || !isRecord(value.payload)) return '';
  const payload = value.payload;
  if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
    const text = contentText(payload.content);
    return text ? `${String(payload.role).toUpperCase()}: ${text}` : '';
  }
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    const name = string(payload.name) || 'tool';
    const input = string(payload.arguments) || string(payload.input);
    return `TOOL CALL ${name}: ${input}`;
  }
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '');
    return output ? `TOOL RESULT: ${output}` : '';
  }
  return '';
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map(raw => {
    if (typeof raw === 'string') return raw;
    if (!isRecord(raw)) return '';
    return typeof raw.text === 'string' ? raw.text : '';
  }).join('');
}

async function findRolloutFile(codexHome: string, threadId: string): Promise<string | undefined> {
  for (const rootName of ['sessions', 'archived_sessions']) {
    const root = path.join(codexHome, rootName);
    const found = await findNamedFile(root, threadId, 5);
    if (found) return found;
  }
  return undefined;
}

async function findNamedFile(dir: string, needle: string, depth: number): Promise<string | undefined> {
  if (depth < 0) return undefined;
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return undefined; }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(needle)) {
      return path.join(dir, entry.name);
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findNamedFile(path.join(dir, entry.name), needle, depth - 1);
    if (found) return found;
  }
  return undefined;
}

function normalizeThreadId(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[a-z0-9_-]{8,128}$/.test(normalized) ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
