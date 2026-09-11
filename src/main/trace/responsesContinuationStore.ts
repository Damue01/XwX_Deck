import { isCodexUpstreamKind } from './codexConversationPortability';
import * as path from 'path';
import { ensureDir, readJson, writeJson } from '../shared/fsx';
import type { CodexUpstreamIdentity } from './codexConversationPortability';

const MAX_RESPONSES = 1000;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 8 * 1024 * 1024;
const RESPONSE_TTL_MS = 60 * 60 * 1000;
const TRANSITION_TTL_MS = 15 * 60 * 1000;

interface ContinuationEntry {
  readonly upstreamKey: string;
  readonly previousResponseId?: string;
  readonly input: unknown[];
  readonly output: unknown[];
  readonly createdAt: number;
  readonly bytes: number;
}

interface ContinuationFile {
  readonly version: 1;
  readonly entries: Readonly<Record<string, ContinuationEntry>>;
  readonly transition?: ContinuationTransition;
}

interface ContinuationTransition {
  readonly source: 'official' | 'compatible' | `provider:${string}`;
  readonly target: 'official' | 'compatible' | `provider:${string}`;
  readonly createdAt: number;
}

export interface ContinuationPrepareResult {
  readonly body: unknown;
  readonly expandedResponses: number;
  readonly restoredToolCalls: number;
  readonly repairedToolOutputs: number;
  readonly unresolvedToolOutputs: number;
  readonly droppedPreviousResponseId: boolean;
  readonly unresolvedPreviousResponseId?: string;
  readonly unresolvedContinuation?: boolean;
  readonly providerTransition?: {
    readonly source: 'official' | 'compatible' | `provider:${string}`;
    readonly target: 'official' | 'compatible' | `provider:${string}`;
  };
}

/**
 * A bounded provider-sidecar cache. It never executes or retries tools; it only
 * restores already-observed visible messages and tool call/result pairs.
 */
export class ResponsesContinuationStore {
  private readonly entries = new Map<string, ContinuationEntry>();
  private readonly callIndex = new Map<string, Set<string>>();
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private transition: ContinuationTransition | undefined;

  constructor(private readonly stateFile?: string) {}

  async markProviderTransition(
    source: 'official' | 'compatible' | `provider:${string}`,
    target: 'official' | 'compatible' | `provider:${string}`
  ): Promise<void> {
    if (source === target) return;
    await this.load();
    this.transition = { source, target, createdAt: Date.now() };
    await this.persist();
  }

  async acknowledgeProviderTransition(target: CodexUpstreamIdentity): Promise<boolean> {
    await this.load();
    if (!this.activeTransition(target.kind)) return false;
    this.transition = undefined;
    await this.persist();
    return true;
  }

  async prepareRequest(
    body: unknown,
    target: CodexUpstreamIdentity,
    wireProtocol: 'responses' | 'chat-completions' | 'anthropic-messages'
  ): Promise<ContinuationPrepareResult> {
    if (!isRecord(body)) return unchanged(body);
    await this.load();
    const transition = this.activeTransition(target.kind);
    const integrity = repairToolOutputIntegrity(body);
    if (integrity.unresolved > 0) {
      return unchanged(integrity.body, transition, integrity.repaired, integrity.unresolved);
    }
    const requestBody = integrity.body;
    const previousResponseId = string(requestBody.previous_response_id).trim();
    if (!previousResponseId) return unchanged(requestBody, transition, integrity.repaired);

    const previous = this.entries.get(previousResponseId);
    const needsLocalExpansion = wireProtocol !== 'responses'
      || !!transition
      || (!!previous && previous.upstreamKey !== target.key);
    if (!needsLocalExpansion) return unchanged(requestBody, transition, integrity.repaired);

    const currentInput = inputItems(requestBody.input);
    const chain = previous ? this.chain(previousResponseId) : undefined;
    if (chain?.length) {
      const rebuilt: unknown[] = [];
      for (const entry of chain) {
        rebuilt.push(...entry.input, ...entry.output);
      }
      rebuilt.push(...currentInput);
      const expandedIntegrity = repairToolOutputIntegrity(withoutPreviousResponseId(
        requestBody,
        deduplicateRefreshableDeveloperContext(deduplicateToolPairs(rebuilt))
      ));
      return {
        body: expandedIntegrity.body,
        expandedResponses: chain.length,
        restoredToolCalls: 0,
        repairedToolOutputs: integrity.repaired + expandedIntegrity.repaired,
        unresolvedToolOutputs: expandedIntegrity.unresolved,
        droppedPreviousResponseId: true,
        providerTransition: transitionMetadata(transition)
      };
    }

    const restored = this.restoreRequestedToolCalls(currentInput);
    return {
      body: withoutPreviousResponseId(requestBody, restored.input),
      expandedResponses: 0,
      restoredToolCalls: restored.count,
      repairedToolOutputs: integrity.repaired,
      unresolvedToolOutputs: restored.unresolved,
      droppedPreviousResponseId: true,
      unresolvedPreviousResponseId: previousResponseId,
      unresolvedContinuation: restored.count === 0,
      providerTransition: transitionMetadata(transition)
    };
  }

  async recordResponse(
    requestBody: unknown,
    response: unknown,
    upstream: CodexUpstreamIdentity
  ): Promise<boolean> {
    if (!isRecord(requestBody) || !isRecord(response)) return false;
    const responseId = string(response.id).trim();
    if (!responseId) return false;
    const integrity = repairToolOutputIntegrity(requestBody);
    if (integrity.unresolved > 0) return false;
    const normalizedRequestBody = integrity.body;
    const input = portableItems(inputItems(normalizedRequestBody.input));
    const output = portableItems(inputItems(response.output));
    if (!input.length && !output.length) return false;
    const previousResponseId = string(normalizedRequestBody.previous_response_id).trim() || undefined;
    const raw = JSON.stringify({ input, output });
    if (Buffer.byteLength(raw) > MAX_ENTRY_BYTES) return false;
    await this.load();
    const entry: ContinuationEntry = {
      upstreamKey: upstream.key,
      ...(previousResponseId ? { previousResponseId } : {}),
      input,
      output,
      createdAt: Date.now(),
      bytes: Buffer.byteLength(raw)
    };
    this.entries.set(responseId, entry);
    this.rebuildCallIndex();
    this.prune(Date.now());
    await this.persist();
    return true;
  }

  private chain(responseId: string): ContinuationEntry[] | undefined {
    const reversed: ContinuationEntry[] = [];
    const seen = new Set<string>();
    let currentId: string | undefined = responseId;
    let bytes = 0;
    while (currentId) {
      if (seen.has(currentId)) return undefined;
      seen.add(currentId);
      const entry = this.entries.get(currentId);
      if (!entry) {
        // A missing parent means the reconstruction would silently omit state.
        return reversed.length ? undefined : undefined;
      }
      reversed.push(entry);
      bytes += entry.bytes;
      if (bytes > MAX_EXPANDED_BYTES) return undefined;
      currentId = entry.previousResponseId;
    }
    return reversed.reverse();
  }

  private restoreRequestedToolCalls(input: unknown[]): { input: unknown[]; count: number; unresolved: number } {
    const existingCalls = new Set(input.filter(isToolCall).map(rawCallId).filter((value): value is string => !!value));
    let count = 0;
    let unresolved = 0;
    const output: unknown[] = [];
    for (const item of input) {
      if (isToolOutput(item)) {
        const id = rawCallId(item);
        if (id && !existingCalls.has(id)) {
          const responseIds = this.callIndex.get(id);
          if (responseIds?.size === 1) {
            const responseId = responseIds.values().next().value as string | undefined;
            const call = responseId
              ? this.entries.get(responseId)?.output.find(candidate => isToolCall(candidate) && rawCallId(candidate) === id)
              : undefined;
            if (call) {
              output.push(call);
              existingCalls.add(id);
              count += 1;
            } else {
              unresolved += 1;
            }
          } else {
            unresolved += 1;
          }
        }
      }
      output.push(item);
    }
    return { input: output, count, unresolved };
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        if (this.stateFile) {
          const saved = await readJson<ContinuationFile>(this.stateFile, { version: 1, entries: {} });
          if (saved.version === 1 && isRecord(saved.entries)) {
            for (const [responseId, raw] of Object.entries(saved.entries)) {
              if (!isContinuationEntry(raw)) continue;
              this.entries.set(responseId, raw);
            }
          }
          if (isRecord(saved.transition)) {
            const source = isCodexUpstreamKind(saved.transition.source)
              ? saved.transition.source
              : undefined;
            const target = isCodexUpstreamKind(saved.transition.target)
              ? saved.transition.target
              : undefined;
            const createdAt = number(saved.transition.createdAt);
            if (source && target && source !== target && createdAt) {
              this.transition = { source, target, createdAt };
            }
          }
        }
        this.prune(Date.now());
        this.rebuildCallIndex();
        this.loaded = true;
      })();
    }
    await this.loadPromise;
  }

  private prune(now: number): void {
    for (const [responseId, entry] of this.entries) {
      if (now - entry.createdAt > RESPONSE_TTL_MS) this.entries.delete(responseId);
    }
    let bytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    const oldest = [...this.entries.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    while ((this.entries.size > MAX_RESPONSES || bytes > MAX_TOTAL_BYTES) && oldest.length) {
      const [responseId, entry] = oldest.shift()!;
      if (!this.entries.delete(responseId)) continue;
      bytes -= entry.bytes;
    }
    this.rebuildCallIndex();
  }

  private rebuildCallIndex(): void {
    this.callIndex.clear();
    for (const [responseId, entry] of this.entries) {
      for (const item of entry.output) {
        if (!isToolCall(item)) continue;
        const id = rawCallId(item);
        if (!id) continue;
        const ids = this.callIndex.get(id) ?? new Set<string>();
        ids.add(responseId);
        this.callIndex.set(id, ids);
      }
    }
  }

  private activeTransition(target: 'official' | 'compatible' | `provider:${string}`): ContinuationTransition | undefined {
    const transition = this.transition;
    if (!transition) return undefined;
    if (Date.now() - transition.createdAt > TRANSITION_TTL_MS) {
      this.transition = undefined;
      void this.persist();
      return undefined;
    }
    return transition.target === target ? transition : undefined;
  }

  private persist(): Promise<void> {
    if (!this.stateFile) return Promise.resolve();
    const write = async (): Promise<void> => {
      await ensureDir(path.dirname(this.stateFile!));
      await writeJson(this.stateFile!, {
        version: 1,
        entries: Object.fromEntries(this.entries),
        ...(this.transition ? { transition: this.transition } : {})
      } satisfies ContinuationFile);
    };
    const next = this.writeChain.then(write, write);
    this.writeChain = next.then(() => undefined, () => undefined);
    return next;
  }
}

function portableItems(items: unknown[]): unknown[] {
  return items.filter(item => {
    if (!isRecord(item)) return true;
    const type = string(item.type);
    if (type === 'reasoning' && typeof item.encrypted_content === 'string') return false;
    if ((type === 'compaction' || type === 'context_compaction' || type === 'compaction_summary')
      && typeof item.encrypted_content === 'string') return false;
    return type === 'message' || isToolCall(item) || isToolOutput(item)
      || (type === 'reasoning' && Array.isArray(item.summary));
  });
}

function deduplicateToolPairs(items: unknown[]): unknown[] {
  const seenCalls = new Set<string>();
  const seenOutputs = new Set<string>();
  return items.filter(item => {
    const id = rawCallId(item);
    if (!id) return true;
    if (isToolCall(item)) {
      if (seenCalls.has(id)) return false;
      seenCalls.add(id);
    } else if (isToolOutput(item)) {
      if (seenOutputs.has(id)) return false;
      seenOutputs.add(id);
    }
    return true;
  });
}

const REFRESHABLE_DEVELOPER_CONTEXT_TAGS = new Set([
  'app-context',
  'apps_instructions',
  'collaboration_mode',
  'model_switch',
  'multi_agent_mode',
  'permissions instructions',
  'plugins_instructions',
  'skills_instructions'
]);

/**
 * Provider expansion concatenates the incremental input saved for every
 * Responses turn. Codex repeats its current runtime/bootstrap context after a
 * model switch, so blindly concatenating those turns can send several stale
 * copies of the same developer context to the next upstream. Keep the newest
 * block for each known refreshable context tag while leaving ordinary system
 * and developer instructions untouched.
 */
function deduplicateRefreshableDeveloperContext(items: unknown[]): unknown[] {
  const seenTags = new Set<string>();
  const output: unknown[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = compactDeveloperContextItem(items[index], seenTags);
    if (item !== undefined) output.push(item);
  }
  return output.reverse();
}

function compactDeveloperContextItem(item: unknown, seenTags: Set<string>): unknown | undefined {
  if (!isRecord(item) || (item.role !== 'developer' && item.role !== 'system')) return item;
  if (typeof item.content === 'string') {
    const tag = refreshableDeveloperContextTag(item.content);
    if (!tag) return item;
    if (seenTags.has(tag)) return undefined;
    seenTags.add(tag);
    return item;
  }
  if (!Array.isArray(item.content)) return item;

  const content: unknown[] = [];
  let changed = false;
  for (let index = item.content.length - 1; index >= 0; index -= 1) {
    const block = item.content[index];
    const value = typeof block === 'string'
      ? block
      : isRecord(block) ? string(block.text) : '';
    const tag = refreshableDeveloperContextTag(value);
    if (tag && seenTags.has(tag)) {
      changed = true;
      continue;
    }
    if (tag) seenTags.add(tag);
    content.push(block);
  }
  if (!content.length) return undefined;
  if (!changed) return item;
  return { ...item, content: content.reverse() };
}

function refreshableDeveloperContextTag(value: string): string | undefined {
  const match = value.trimStart().match(/^<([a-z0-9_-]+|permissions instructions)>/i);
  if (!match) return undefined;
  const tag = match[1].toLowerCase();
  return REFRESHABLE_DEVELOPER_CONTEXT_TAGS.has(tag) ? tag : undefined;
}

function withoutPreviousResponseId(body: Record<string, any>, input: unknown[]): Record<string, unknown> {
  const output: Record<string, unknown> = { ...body, input };
  delete output.previous_response_id;
  return output;
}

function unchanged(
  body: unknown,
  transition?: ContinuationTransition,
  repairedToolOutputs = 0,
  unresolvedToolOutputs = 0
): ContinuationPrepareResult {
  return {
    body,
    expandedResponses: 0,
    restoredToolCalls: 0,
    repairedToolOutputs,
    unresolvedToolOutputs,
    droppedPreviousResponseId: false,
    providerTransition: transitionMetadata(transition)
  };
}

function transitionMetadata(
  transition?: ContinuationTransition
): ContinuationPrepareResult['providerTransition'] {
  return transition
    ? { source: transition.source, target: transition.target }
    : undefined;
}

function inputItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  if (typeof value === 'string') return [{ type: 'message', role: 'user', content: value }];
  return [value];
}

function isToolCall(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.type === 'function_call'
    || value.type === 'custom_tool_call'
    || value.type === 'tool_search_call';
}

function isToolOutput(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.type === 'function_call_output'
    || value.type === 'custom_tool_call_output'
    || value.type === 'tool_search_output';
}

function rawCallId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const id = string(value.call_id) || (isToolCall(value) ? string(value.id) : '');
  if (!id) return undefined;
  return isToolCall(value) || isToolOutput(value) ? id : undefined;
}

interface ToolOutputIntegrityResult {
  readonly body: Record<string, any>;
  readonly repaired: number;
  readonly unresolved: number;
}

/**
 * Codex heartbeat wakeups are control messages, not results of a model-issued
 * function call. Codex Desktop 0.144 can persist them as a standalone
 * `function_call_output` without `call_id`, which native Responses correctly
 * rejects. Preserve the scheduler instructions as developer input. For every
 * other malformed output, only recover an exact call-id match already present
 * in the same input; never guess by tool name, order, or output item id shape.
 */
function repairToolOutputIntegrity(body: Record<string, any>): ToolOutputIntegrityResult {
  if (!Array.isArray(body.input)) return { body, repaired: 0, unresolved: 0 };
  const callIds = new Set(
    body.input
      .filter(isToolCall)
      .map(rawCallId)
      .filter((value): value is string => !!value)
  );
  let repaired = 0;
  let unresolved = 0;
  let changed = false;
  const input = body.input.map((item: unknown) => {
    if (!isToolOutput(item) || !isRecord(item) || string(item.call_id).trim()) return item;
    if (isCodexHeartbeatControlOutput(item)) {
      repaired += 1;
      changed = true;
      return {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: item.output }]
      };
    }
    const exactLegacyCallId = string(item.id).trim();
    if (exactLegacyCallId && callIds.has(exactLegacyCallId)) {
      repaired += 1;
      changed = true;
      return { ...item, call_id: exactLegacyCallId };
    }
    unresolved += 1;
    return item;
  });
  return {
    body: changed ? { ...body, input } : body,
    repaired,
    unresolved
  };
}

function isCodexHeartbeatControlOutput(value: Record<string, any>): boolean {
  if (value.type !== 'function_call_output'
    || value.namespace !== 'codex_app'
    || value.name !== 'automation_update'
    || typeof value.output !== 'string') return false;
  const output = value.output.trim();
  return output.startsWith('<heartbeat>')
    && output.endsWith('</heartbeat>')
    && /<automation_id>[^<]+<\/automation_id>/.test(output)
    && /<instructions>[\s\S]*<\/instructions>/.test(output);
}

function isContinuationEntry(value: unknown): value is ContinuationEntry {
  return isRecord(value)
    && typeof value.upstreamKey === 'string'
    && Array.isArray(value.input)
    && Array.isArray(value.output)
    && typeof value.createdAt === 'number'
    && typeof value.bytes === 'number';
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
