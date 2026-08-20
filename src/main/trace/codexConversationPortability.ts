import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ensureDir, readJson, writeFileAtomic, writeJson } from '../shared/fsx';
import { resolveClientPaths } from './clientConfig';
import { CodexPortableHistory, type PortableCheckpointSource } from './codexPortableHistory';
import {
  decodeCompactionSummary,
  XwX_COMPACTION_SUMMARY_PREFIX
} from './codexCompaction';

const XwX_ANTHROPIC_REASONING_PREFIX = 'xwxa1:';
const MAX_ORIGINS = 4096;
const ORIGIN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PROVIDER_TRANSITION_TTL_MS = 15 * 60 * 1000;
const PORTABILITY_SUMMARY_PREFIX =
  'Another language model started to solve this problem and produced a summary of its work. Continue from this summary without repeating completed work:';

export type CodexUpstreamKind = 'official' | 'compatible';

export interface CodexUpstreamIdentity {
  readonly key: string;
  readonly kind: CodexUpstreamKind;
}

interface OpaqueOriginEntry {
  readonly upstream: string;
  readonly upstreamKind?: CodexUpstreamKind;
  /** Target that explicitly rejected this opaque item. */
  readonly rejectedByKind?: CodexUpstreamKind;
  readonly kind: 'reasoning' | 'compaction';
  readonly seenAt: number;
}

interface OpaqueOriginFile {
  readonly version: 1 | 2 | 3;
  readonly entries: Readonly<Record<string, OpaqueOriginEntry>>;
  readonly transition?: ProviderTransition;
  readonly legacyOfficialRestoreHashes?: readonly string[];
  readonly legacyMessageIdHistoryNormalized?: boolean;
  readonly unreplayableReasoningHistorySanitized?: boolean;
}

interface ProviderTransition {
  readonly source: CodexUpstreamKind;
  readonly target: CodexUpstreamKind;
  readonly createdAt: number;
}

export interface PortableRequestOptions {
  readonly target: CodexUpstreamIdentity;
  readonly wireProtocol: 'responses' | 'chat-completions' | 'anthropic-messages';
  readonly threadId?: string;
  /** A foreign/unavailable previous_response_id was removed before this pass. */
  readonly recoverContinuation?: boolean;
}

export interface PortableRequestResult {
  readonly body: unknown;
  readonly removedReasoning: number;
  readonly replacedCompactions: number;
  readonly normalizedMessageIds?: number;
  readonly checkpointSource?: PortableCheckpointSource | 'unavailable';
  readonly transitionSanitizedOpaque?: number;
  readonly providerTransitionActive?: boolean;
  readonly providerTransition?: {
    readonly source: CodexUpstreamKind;
    readonly target: CodexUpstreamKind;
  };
  readonly insertedCheckpoint?: boolean;
}

export interface LocalHistoryRepairResult {
  readonly changedFiles: number;
  readonly removedItems: number;
  readonly removedUnencryptedReasoningItems?: number;
  readonly normalizedMessageIds?: number;
  readonly backupRoot?: string;
}

export interface LegacyOfficialRestoreResult {
  readonly changedFiles: number;
  readonly restoredItems: number;
  readonly backupRoot?: string;
}

/**
 * Keeps opaque Responses items on the upstream that minted them and converts
 * cross-upstream compaction into portable text. Only hashes and upstream
 * identities are persisted; opaque payloads and credentials are never stored.
 */
export class CodexConversationPortability {
  private readonly origins = new Map<string, OpaqueOriginEntry>();
  private loaded = false;
  private loadedVersion: 0 | 1 | 2 | 3 = 0;
  private loadPromise: Promise<void> | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private transition: ProviderTransition | undefined;
  private legacyMessageIdHistoryNormalized = false;
  private unreplayableReasoningHistorySanitized = false;
  private readonly legacyOfficialRestoreHashes = new Set<string>();
  private readonly pendingLocalRepairHashes: Record<CodexUpstreamKind, Set<string>> = {
    official: new Set(),
    compatible: new Set()
  };
  private readonly portableHistory: CodexPortableHistory;

  constructor(
    private readonly stateFile?: string,
    private readonly codexHome = path.dirname(resolveClientPaths().codexConfigPath)
  ) {
    this.portableHistory = new CodexPortableHistory(
      codexHome,
      stateFile ? path.join(path.dirname(stateFile), 'portable-checkpoints.json') : undefined
    );
  }

  async prepareRequest(body: unknown, options: PortableRequestOptions): Promise<PortableRequestResult> {
    if (!isRecord(body)) {
      return { body, removedReasoning: 0, replacedCompactions: 0 };
    }
    await this.load();

    const transition = this.activeTransition(options.target.kind);
    if (!Array.isArray(body.input)) {
      return {
        body,
        removedReasoning: 0,
        replacedCompactions: 0,
        ...(transition ? {
          providerTransitionActive: true,
          providerTransition: { source: transition.source, target: transition.target }
        } : {})
      };
    }
    // Unknown pre-index opaque items are native OpenAI history by default.
    // Rewriting them on the official route mutates ChatGPT's signed request
    // body and breaks otherwise valid old conversations. 兼容服务 cannot
    // decrypt those unknown OpenAI items, so only that direction is strict.
    const sanitizeUnknownOpaque = !!transition && options.target.kind === 'compatible';

    let removedReasoning = 0;
    let replacedCompactions = 0;
    let normalizedMessageIds = 0;
    let transitionSanitizedOpaque = 0;
    let checkpoint: CodexCheckpoint | undefined;
    let checkpointLoaded = false;
    let learnedTransitionOrigins = false;
    const output: unknown[] = [];
    const recoverFromRollout = options.recoverContinuation === true
      && !body.input.some(raw => isRecord(raw) && isCompactionType(string(raw.type)));

    if (recoverFromRollout) {
      checkpoint = await this.portableHistory.read(options.threadId, { includeDelta: true });
      checkpointLoaded = true;
      if (checkpoint) output.push(checkpointMessage(checkpoint.text));
      else if (body.input.length > 0) output.push(checkpointMessage(unavailableCheckpointText()));
    }

    for (const raw of body.input) {
      if (!isRecord(raw)) {
        output.push(raw);
        continue;
      }
      const type = string(raw.type);
      if (type === 'message' && options.target.kind === 'official') {
        const normalized = normalizeLegacyBridgeMessageId(raw);
        if (normalized !== raw) {
          output.push(normalized);
          normalizedMessageIds += 1;
          continue;
        }
      }
      if (type === 'reasoning') {
        const encrypted = string(raw.encrypted_content);
        if (!encrypted) {
          // A bridge-generated reasoning summary has no replayable payload.
          // Sending its rs_* ID to any native Responses upstream with
          // store:false makes the server treat it as a persisted item
          // reference and return 404. Converted Chat/Anthropic bridge routes
          // may still consume their own summary form.
          if (options.wireProtocol === 'responses') removedReasoning += 1;
          else output.push(raw);
          continue;
        }
        if (encrypted.startsWith(XwX_ANTHROPIC_REASONING_PREFIX)) {
          if (options.target.kind === 'compatible' && options.wireProtocol === 'anthropic-messages') {
            output.push(raw);
          } else {
            removedReasoning += 1;
          }
          continue;
        }
        if (this.canReplay(encrypted, options.target, sanitizeUnknownOpaque)) {
          output.push(raw);
        } else {
          this.pendingLocalRepairHashes[options.target.kind].add(opaqueHash(encrypted));
          removedReasoning += 1;
          if (sanitizeUnknownOpaque && !this.hasOrigin(encrypted) && transition) {
            transitionSanitizedOpaque += 1;
            this.origins.set(opaqueHash(encrypted), {
              upstream: `transition:${transition.source}`,
              upstreamKind: transition.source,
              kind: 'reasoning',
              seenAt: Date.now()
            });
            learnedTransitionOrigins = true;
          }
        }
        continue;
      }

      if (isCompactionType(type)) {
        const encrypted = string(raw.encrypted_content);
        const xwxSummary = encrypted ? decodeCompactionSummary(encrypted) : undefined;
        if (xwxSummary) {
          output.push(checkpointMessage(`${XwX_COMPACTION_SUMMARY_PREFIX}\n\n${xwxSummary}`));
          replacedCompactions += 1;
          continue;
        }
        // A context_compaction without encrypted content is only a local boundary
        // marker. Its following plain summary message remains portable as-is.
        if (!encrypted || this.canReplay(encrypted, options.target, sanitizeUnknownOpaque)) {
          output.push(raw);
          continue;
        }
        if (sanitizeUnknownOpaque && !this.hasOrigin(encrypted) && transition) {
          transitionSanitizedOpaque += 1;
          this.origins.set(opaqueHash(encrypted), {
            upstream: `transition:${transition.source}`,
            upstreamKind: transition.source,
            kind: 'compaction',
            seenAt: Date.now()
          });
          learnedTransitionOrigins = true;
        }
        this.pendingLocalRepairHashes[options.target.kind].add(opaqueHash(encrypted));
        if (!checkpointLoaded) {
          checkpoint = await this.portableHistory.read(options.threadId);
          checkpointLoaded = true;
        }
        output.push(checkpointMessage(checkpoint?.text ?? unavailableCheckpointText()));
        replacedCompactions += 1;
        continue;
      }

      output.push(raw);
    }

    if (learnedTransitionOrigins) {
      this.prune(Date.now());
      await this.persist();
    }

    const insertedCheckpoint = recoverFromRollout && (checkpoint !== undefined || body.input.length > 0);
    if (!removedReasoning && !replacedCompactions && !normalizedMessageIds && !insertedCheckpoint) {
      return {
        body,
        removedReasoning,
        replacedCompactions,
        ...(transition ? {
          providerTransitionActive: true,
          providerTransition: { source: transition.source, target: transition.target }
        } : {})
      };
    }
    return {
      body: { ...body, input: output },
      removedReasoning,
      replacedCompactions,
      ...(normalizedMessageIds ? { normalizedMessageIds } : {}),
      ...(replacedCompactions
        ? { checkpointSource: checkpoint?.source ?? (checkpointLoaded ? 'unavailable' : undefined) }
        : {}),
      ...(transitionSanitizedOpaque ? { transitionSanitizedOpaque } : {}),
      ...(insertedCheckpoint ? { insertedCheckpoint: true } : {}),
      ...(transition ? {
        providerTransitionActive: true,
        providerTransition: { source: transition.source, target: transition.target }
      } : {})
    };
  }

  /**
   * Version 2 had no provider-transition marker. Migrate it once so an
   * already-broken conversation from an older XwX Deck build gets a clean
   * first request after installing this build. Version 3 startup is inert
   * unless a real switch was still pending when XwX Deck exited.
   */
  async adoptProviderOnStartup(target: CodexUpstreamKind): Promise<boolean> {
    await this.load();
    if (this.loadedVersion >= 3) {
      if (this.transition?.target !== target) return false;
      if (target === 'official') {
        // Older builds persisted an aggressive 兼容服务 -> official marker
        // that treated every unknown native OpenAI item as foreign. Drop it
        // during startup so old official conversations remain byte-stable.
        for (const [hash, entry] of this.origins) {
          if (entry.upstream === `transition:${this.transition.source}`
            && entry.upstreamKind === this.transition.source) {
            this.origins.delete(hash);
            this.legacyOfficialRestoreHashes.add(hash);
          }
        }
        this.transition = undefined;
        await this.persist();
        return false;
      }
      // A transition is cleared only after the target accepts a sanitized
      // request. If XwX Deck was closed or the client aborted first, refresh
      // the cleanup window on the next startup instead of abandoning it merely
      // because wall-clock time elapsed.
      this.transition = { ...this.transition, createdAt: Date.now() };
      await this.persist();
      return true;
    }
    if (this.origins.size) {
      const source = target === 'official' ? 'compatible' : 'official';
      const distinct = new Set([...this.origins.values()].map(entry => entry.upstream));
      if (distinct.size === 1) {
        for (const [hash, entry] of this.origins) {
          if (!entry.upstreamKind) this.origins.set(hash, { ...entry, upstreamKind: source });
        }
      }
      if (target === 'compatible') {
        this.transition = { source, target, createdAt: Date.now() };
      }
    }
    this.loadedVersion = 3;
    await this.persist();
    return !!this.transition;
  }

  /**
   * Histories created before the origin index contain bare opaque items. Keep
   * a short persisted transition window so the very first request after an
   * XwX Deck restart or provider switch sanitizes those items proactively.
   */
  async markProviderTransition(source: CodexUpstreamKind, target: CodexUpstreamKind): Promise<void> {
    if (source === target) return;
    await this.load();
    if (target === 'official') {
      // Known 兼容服务 items are filtered by their origin index. Unknown
      // items must remain compatible with native OpenAI history.
      this.transition = undefined;
      await this.persist();
      return;
    }
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

  async observeResponse(value: unknown, upstream: CodexUpstreamIdentity): Promise<void> {
    const items = collectOpaqueItems(value);
    if (!items.length) return;
    await this.load();
    const now = Date.now();
    let changed = false;
    for (const item of items) {
      if (item.encrypted.startsWith('xwxc1:') || item.encrypted.startsWith(XwX_ANTHROPIC_REASONING_PREFIX)) continue;
      this.origins.set(opaqueHash(item.encrypted), {
        upstream: upstream.key,
        upstreamKind: upstream.kind,
        kind: item.kind,
        seenAt: now
      });
      changed = true;
    }
    if (!changed) return;
    this.prune(now);
    await this.persist();
  }

  /**
   * A restarted or failed third-party gateway may lose the key material that
   * validates opaque Responses items it minted earlier. Forget those origins
   * after a transport/5xx failure or an explicit invalid_encrypted_content
   * response so the next retry falls back to portable transcript state.
   */
  async noteUpstreamFailure(upstream: CodexUpstreamIdentity, reason: string): Promise<number> {
    if (upstream.kind !== 'compatible') return 0;
    const normalized = reason.toLowerCase();
    if (!normalized.includes('invalid_encrypted_content')
      && !normalized.includes('encrypted content')
      && !normalized.includes('upstream error')
      && !normalized.includes('fetch failed')
      && !normalized.includes('econn')
      && !normalized.includes('socket')
      && !normalized.includes('aborted')
      && !normalized.includes('502')
      && !normalized.includes('503')
      && !normalized.includes('504')) return 0;
    await this.load();
    let removed = 0;
    for (const [hash, entry] of this.origins) {
      if (entry.upstream !== upstream.key) continue;
      this.origins.delete(hash);
      removed += 1;
    }
    if (removed) await this.persist();
    return removed;
  }

  /**
   * An explicit invalid_encrypted_content response proves that every opaque
   * item in this request is unusable on the selected upstream. This also
   * covers histories created before the v2 origin index existed. Quarantine
   * them so the user's next retry can fall back to local plain-text history.
   */
  async quarantineRejectedRequest(body: unknown, upstream: CodexUpstreamIdentity): Promise<number> {
    const items = collectOpaqueItems(body);
    if (!items.length) return 0;
    await this.load();
    const now = Date.now();
    let changed = 0;
    for (const item of items) {
      if (item.encrypted.startsWith('xwxc1:') || item.encrypted.startsWith(XwX_ANTHROPIC_REASONING_PREFIX)) continue;
      const hash = opaqueHash(item.encrypted);
      const rejectedUpstream = `rejected:${upstream.key}`;
      const existing = this.origins.get(hash);
      if (existing?.upstream === rejectedUpstream && existing.rejectedByKind === upstream.kind) continue;
      this.origins.set(hash, {
        upstream: rejectedUpstream,
        rejectedByKind: upstream.kind,
        kind: item.kind,
        seenAt: now
      });
      this.pendingLocalRepairHashes[upstream.kind].add(hash);
      changed += 1;
    }
    if (changed) {
      this.prune(now);
      await this.persist();
    }
    return changed;
  }

  /**
   * Make local Codex JSONL history portable after the Codex client has exited.
   * Opaque response_item rows already proven foreign and unencrypted reasoning
   * summaries that official Responses cannot replay are removed. Legacy XwX
   * bridge message IDs are normalized before official direct mode resumes.
   * Every changed source file is copied to a timestamped backup before atomic
   * replacement.
   */
  async repairLocalHistory(targetKind: CodexUpstreamKind): Promise<LocalHistoryRepairResult> {
    await this.load();
    const foreignHashes = new Set(this.pendingLocalRepairHashes[targetKind]);
    for (const [hash, entry] of this.origins) {
      if (entry.upstreamKind && entry.upstreamKind !== targetKind) foreignHashes.add(hash);
      if (entry.rejectedByKind === targetKind) foreignHashes.add(hash);
    }
    const normalizeLegacyMessageIds = targetKind === 'official' && !this.legacyMessageIdHistoryNormalized;
    const removeUnencryptedReasoning = targetKind === 'official' && !this.unreplayableReasoningHistorySanitized;
    if (!foreignHashes.size && !normalizeLegacyMessageIds && !removeUnencryptedReasoning) {
      return { changedFiles: 0, removedItems: 0 };
    }

    const files = await listCodexRolloutFiles(this.codexHome);
    const changed: Array<{
      file: string;
      content: string;
      removed: number;
      removedUnencryptedReasoning: number;
      normalized: number;
    }> = [];
    for (const file of files) {
      const result = await portableRolloutContent(
        file,
        foreignHashes,
        normalizeLegacyMessageIds,
        removeUnencryptedReasoning
      );
      if (result.removed || result.normalized) changed.push({ file, ...result });
    }
    if (!changed.length) {
      if (normalizeLegacyMessageIds || removeUnencryptedReasoning) {
        if (normalizeLegacyMessageIds) this.legacyMessageIdHistoryNormalized = true;
        if (removeUnencryptedReasoning) this.unreplayableReasoningHistorySanitized = true;
        try { await this.persist(); }
        catch {
          if (normalizeLegacyMessageIds) this.legacyMessageIdHistoryNormalized = false;
          if (removeUnencryptedReasoning) this.unreplayableReasoningHistorySanitized = false;
        }
      }
      return { changedFiles: 0, removedItems: 0 };
    }

    const backupRoot = localRepairBackupRoot(this.stateFile, this.codexHome);
    const generation = path.join(
      backupRoot,
      `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${process.pid}-${Math.random().toString(16).slice(2)}`
    );
    const manifestFiles: Array<{
      relativePath: string;
      removedItems: number;
      removedUnencryptedReasoningItems?: number;
      normalizedMessageIds?: number;
    }> = [];
    for (const item of changed) {
      const relativePath = safeRelativeRolloutPath(this.codexHome, item.file);
      const backup = path.join(generation, 'jsonl', relativePath);
      await ensureDir(path.dirname(backup));
      await fs.promises.copyFile(item.file, backup, fs.constants.COPYFILE_EXCL);
      manifestFiles.push({
        relativePath,
        removedItems: item.removed,
        ...(item.removedUnencryptedReasoning
          ? { removedUnencryptedReasoningItems: item.removedUnencryptedReasoning }
          : {}),
        ...(item.normalized ? { normalizedMessageIds: item.normalized } : {})
      });
    }
    await writeJson(path.join(generation, 'manifest.json'), {
      version: 1,
      createdAt: new Date().toISOString(),
      codexHome: this.codexHome,
      targetKind,
      files: manifestFiles
    });
    // Do not touch any source until every backup and the recovery manifest are
    // durable. A failure in the preparation phase therefore leaves the entire
    // live history byte-for-byte unchanged.
    const written: typeof changed = [];
    try {
      for (const item of changed) {
        await writeFileAtomic(item.file, item.content);
        written.push(item);
      }
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (const item of written.reverse()) {
        const backup = path.join(generation, 'jsonl', safeRelativeRolloutPath(this.codexHome, item.file));
        try { await writeFileAtomic(item.file, await fs.promises.readFile(backup)); }
        catch { rollbackFailures.push(item.file); }
      }
      if (rollbackFailures.length) {
        throw new Error(`Codex history repair failed and rollback was incomplete: ${rollbackFailures.join(', ')}`, { cause: error });
      }
      throw error;
    }
    for (const hash of foreignHashes) this.pendingLocalRepairHashes[targetKind].delete(hash);
    if (normalizeLegacyMessageIds) this.legacyMessageIdHistoryNormalized = true;
    if (removeUnencryptedReasoning) this.unreplayableReasoningHistorySanitized = true;
    try { await this.persist(); }
    catch {
      if (normalizeLegacyMessageIds) this.legacyMessageIdHistoryNormalized = false;
      if (removeUnencryptedReasoning) this.unreplayableReasoningHistorySanitized = false;
    }
    return {
      changedFiles: changed.length,
      removedItems: changed.reduce((sum, item) => sum + item.removed, 0),
      removedUnencryptedReasoningItems: changed.reduce(
        (sum, item) => sum + item.removedUnencryptedReasoning,
        0
      ),
      normalizedMessageIds: changed.reduce((sum, item) => sum + item.normalized, 0),
      backupRoot: generation
    };
  }

  /**
   * Restore rows removed by the short-lived aggressive official-startup
   * cleanup. This runs only after ChatGPT has fully exited. A source file is
   * eligible only when it is exactly the backup with the manifest's opaque
   * rows removed, optionally followed by newly appended rows.
   */
  async restoreLegacyOfficialHistory(): Promise<LegacyOfficialRestoreResult> {
    await this.load();
    if (!this.legacyOfficialRestoreHashes.size || !this.stateFile) {
      return { changedFiles: 0, restoredItems: 0 };
    }
    const repairRoot = localRepairBackupRoot(this.stateFile, this.codexHome);
    const generations = await fs.promises.readdir(repairRoot, { withFileTypes: true }).catch(() => []);
    const candidates: Array<{ file: string; content: string; restored: number }> = [];
    for (const generation of generations.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!generation.isDirectory()) continue;
      const generationRoot = path.join(repairRoot, generation.name);
      const manifest = await readJson<unknown>(path.join(generationRoot, 'manifest.json'), undefined);
      if (!isLegacyOfficialRepairManifest(manifest, this.codexHome)) continue;
      for (const item of manifest.files) {
        const file = path.resolve(this.codexHome, item.relativePath);
        const relativePath = safeRelativeRolloutPath(this.codexHome, file);
        if (relativePath !== path.normalize(item.relativePath)) {
          throw new Error(`旧对话恢复路径无效：${item.relativePath}`);
        }
        const backup = path.join(generationRoot, 'jsonl', relativePath);
        const backupContent = await fs.promises.readFile(backup, 'utf8');
        const currentContent = await fs.promises.readFile(file, 'utf8');
        const merged = mergeLegacyOfficialRepairBackup(
          backupContent,
          currentContent,
          item.removedItems,
          item.removedUnencryptedReasoningItems ?? 0,
          this.legacyOfficialRestoreHashes
        );
        if (!merged) {
          throw new Error(`旧对话恢复校验失败，文件未修改：${item.relativePath}`);
        }
        if (merged.content !== currentContent) {
          candidates.push({ file, content: merged.content, restored: merged.restoredItems });
        }
      }
    }
    if (!candidates.length) {
      throw new Error('旧对话恢复未找到与错误来源索引匹配的安全备份，文件未修改。');
    }

    const recoveryRoot = path.join(
      path.dirname(path.dirname(this.stateFile)),
      'backups',
      'codex-official-history-restore-v1',
      `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${process.pid}-${Math.random().toString(16).slice(2)}`
    );
    for (const item of candidates) {
      const relativePath = safeRelativeRolloutPath(this.codexHome, item.file);
      const backup = path.join(recoveryRoot, 'jsonl', relativePath);
      await ensureDir(path.dirname(backup));
      await fs.promises.copyFile(item.file, backup, fs.constants.COPYFILE_EXCL);
    }
    await writeJson(path.join(recoveryRoot, 'manifest.json'), {
      version: 1,
      createdAt: new Date().toISOString(),
      codexHome: this.codexHome,
      files: candidates.map(item => ({
        relativePath: safeRelativeRolloutPath(this.codexHome, item.file),
        restoredItems: item.restored
      }))
    });
    const written: typeof candidates = [];
    try {
      for (const item of candidates) {
        await writeFileAtomic(item.file, item.content);
        written.push(item);
      }
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (const item of written.reverse()) {
        const backup = path.join(recoveryRoot, 'jsonl', safeRelativeRolloutPath(this.codexHome, item.file));
        try { await writeFileAtomic(item.file, await fs.promises.readFile(backup)); }
        catch { rollbackFailures.push(item.file); }
      }
      if (rollbackFailures.length) {
        throw new Error(`Codex history restore failed and rollback was incomplete: ${rollbackFailures.join(', ')}`, { cause: error });
      }
      throw error;
    }
    this.legacyOfficialRestoreHashes.clear();
    await this.persist();
    return {
      changedFiles: candidates.length,
      restoredItems: candidates.reduce((sum, item) => sum + item.restored, 0),
      backupRoot: recoveryRoot
    };
  }

  private canReplay(
    encrypted: string,
    target: CodexUpstreamIdentity,
    sanitizeUnknownOpaque = false
  ): boolean {
    const origin = this.origins.get(opaqueHash(encrypted));
    if (origin) return origin.upstream === target.key;
    // Existing histories predate the origin index. Bare opaque items in them
    // are overwhelmingly native OpenAI state, so preserve them only on the
    // official route. Unknown opaque state must never be tried on 兼容服务.
    return target.kind === 'official' && !sanitizeUnknownOpaque;
  }

  private hasOrigin(encrypted: string): boolean {
    return this.origins.has(opaqueHash(encrypted));
  }

  private activeTransition(target: CodexUpstreamKind): ProviderTransition | undefined {
    const transition = this.transition;
    if (!transition) return undefined;
    if (Date.now() - transition.createdAt > PROVIDER_TRANSITION_TTL_MS) {
      this.transition = undefined;
      void this.persist();
      return undefined;
    }
    return transition.target === target ? transition : undefined;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        if (this.stateFile) {
          const saved = await readJson<OpaqueOriginFile>(this.stateFile, { version: 2, entries: {} });
          if ((saved.version === 1 || saved.version === 2 || saved.version === 3) && isRecord(saved.entries)) {
            this.loadedVersion = saved.version;
            for (const [hash, raw] of Object.entries(saved.entries)) {
              if (!isRecord(raw)) continue;
              const upstream = string(raw.upstream);
              const kind = raw.kind === 'reasoning' || raw.kind === 'compaction' ? raw.kind : undefined;
              const seenAt = number(raw.seenAt);
              if (upstream && kind && seenAt) {
                const upstreamKind = raw.upstreamKind === 'official' || raw.upstreamKind === 'compatible'
                  ? raw.upstreamKind
                  : undefined;
                const rejectedByKind = raw.rejectedByKind === 'official' || raw.rejectedByKind === 'compatible'
                  ? raw.rejectedByKind
                  : undefined;
                this.origins.set(hash, { upstream, upstreamKind, rejectedByKind, kind, seenAt });
              }
            }
            if (saved.version === 3 && isRecord(saved.transition)) {
              const source = saved.transition.source === 'official' || saved.transition.source === 'compatible'
                ? saved.transition.source
                : undefined;
              const target = saved.transition.target === 'official' || saved.transition.target === 'compatible'
                ? saved.transition.target
                : undefined;
              const createdAt = number(saved.transition.createdAt);
              if (source && target && source !== target && createdAt) {
                this.transition = { source, target, createdAt };
              }
            }
            if (Array.isArray(saved.legacyOfficialRestoreHashes)) {
              for (const hash of saved.legacyOfficialRestoreHashes) {
                if (typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)) {
                  this.legacyOfficialRestoreHashes.add(hash);
                }
              }
            }
            this.legacyMessageIdHistoryNormalized = saved.legacyMessageIdHistoryNormalized === true;
            this.unreplayableReasoningHistorySanitized = saved.unreplayableReasoningHistorySanitized === true;
            // v1-v3 entries predate upstreamKind. A persisted transition plus
            // one distinct upstream is sufficient to migrate them without
            // exposing or replaying the opaque values.
            if (this.transition) {
              const distinct = new Set([...this.origins.values()].map(entry => entry.upstream));
              if (distinct.size === 1) {
                for (const [hash, entry] of this.origins) {
                  if (!entry.upstreamKind) this.origins.set(hash, { ...entry, upstreamKind: this.transition.source });
                }
              }
            }
          }
        }
        this.prune(Date.now());
        if (!this.stateFile) this.loadedVersion = 3;
        this.loaded = true;
      })();
    }
    await this.loadPromise;
  }

  private prune(now: number): void {
    for (const [hash, entry] of this.origins) {
      if (now - entry.seenAt > ORIGIN_TTL_MS) this.origins.delete(hash);
    }
    if (this.origins.size <= MAX_ORIGINS) return;
    const oldest = [...this.origins.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt);
    for (let index = 0; index < oldest.length - MAX_ORIGINS; index += 1) {
      this.origins.delete(oldest[index][0]);
    }
  }

  private persist(): Promise<void> {
    if (!this.stateFile) return Promise.resolve();
    const write = async (): Promise<void> => {
      await ensureDir(path.dirname(this.stateFile!));
      await writeJson(this.stateFile!, {
        version: 3,
        entries: Object.fromEntries(
          [...this.origins.entries()].map(([hash, entry]) => [hash, {
            ...entry
          }])
        ),
        ...(this.transition ? { transition: this.transition } : {}),
        ...(this.legacyOfficialRestoreHashes.size
          ? { legacyOfficialRestoreHashes: [...this.legacyOfficialRestoreHashes].sort() }
          : {}),
        ...(this.legacyMessageIdHistoryNormalized ? { legacyMessageIdHistoryNormalized: true } : {}),
        ...(this.unreplayableReasoningHistorySanitized
          ? { unreplayableReasoningHistorySanitized: true }
          : {})
      } satisfies OpaqueOriginFile);
      this.loadedVersion = 3;
    };
    const next = this.writeChain.then(write, write);
    this.writeChain = next.then(() => undefined, () => undefined);
    return next;
  }
}

function normalizeLegacyBridgeMessageId(item: Record<string, unknown>): Record<string, unknown> {
  const id = string(item.id);
  if (!/^resp_.+_msg(?:_\d+)?$/.test(id)) return item;
  const digest = createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 32);
  return { ...item, id: `msg_xwx_${digest}` };
}

async function listCodexRolloutFiles(codexHome: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(fullPath);
    }
  };
  await visit(path.join(codexHome, 'sessions'));
  await visit(path.join(codexHome, 'archived_sessions'));
  return out;
}

async function portableRolloutContent(
  file: string,
  foreignHashes: ReadonlySet<string>,
  normalizeLegacyMessageIds: boolean,
  removeUnencryptedReasoning: boolean
): Promise<{
  content: string;
  removed: number;
  removedUnencryptedReasoning: number;
  normalized: number;
}> {
  const source = await fs.promises.readFile(file, 'utf8');
  const hadFinalNewline = source.endsWith('\n');
  let removed = 0;
  let removedUnencryptedReasoning = 0;
  let normalized = 0;
  const lines = source.split(/\r?\n/);
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line && index === lines.length - 1) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch {
      kept.push(line);
      continue;
    }
    if (!isRecord(value) || value.type !== 'response_item' || !isRecord(value.payload)) {
      kept.push(line);
      continue;
    }
    const type = string(value.payload.type);
    if (removeUnencryptedReasoning
      && type === 'reasoning'
      && !string(value.payload.encrypted_content)) {
      removed += 1;
      removedUnencryptedReasoning += 1;
      continue;
    }
    if (type === 'reasoning' || isCompactionType(type)) {
      const encrypted = string(value.payload.encrypted_content);
      if (encrypted && foreignHashes.has(opaqueHash(encrypted))) {
        removed += 1;
        continue;
      }
    }
    if (normalizeLegacyMessageIds && type === 'message') {
      const payload = normalizeLegacyBridgeMessageId(value.payload);
      if (payload !== value.payload) {
        kept.push(JSON.stringify({ ...value, payload }));
        normalized += 1;
        continue;
      }
    }
    kept.push(line);
  }
  return {
    content: `${kept.join('\n')}${hadFinalNewline ? '\n' : ''}`,
    removed,
    removedUnencryptedReasoning,
    normalized
  };
}

interface LegacyOfficialRepairManifest {
  readonly version: 1;
  readonly codexHome: string;
  readonly targetKind: 'official';
  readonly files: ReadonlyArray<{
    readonly relativePath: string;
    readonly removedItems: number;
    readonly removedUnencryptedReasoningItems?: number;
    readonly normalizedMessageIds?: number;
  }>;
}

function isLegacyOfficialRepairManifest(value: unknown, codexHome: string): value is LegacyOfficialRepairManifest {
  if (!isRecord(value) || value.version !== 1 || value.targetKind !== 'official' || value.codexHome !== codexHome) return false;
  if (!Array.isArray(value.files) || !value.files.length) return false;
  return value.files.every(item => isRecord(item)
    && typeof item.relativePath === 'string'
    && !!item.relativePath
    && !item.relativePath.startsWith('..')
    && !path.isAbsolute(item.relativePath)
    && Number.isSafeInteger(item.removedItems)
    && Number(item.removedItems) >= 0
    && (item.removedUnencryptedReasoningItems === undefined
      || (Number.isSafeInteger(item.removedUnencryptedReasoningItems)
        && Number(item.removedUnencryptedReasoningItems) > 0
        && Number(item.removedUnencryptedReasoningItems) <= Number(item.removedItems)))
    && (item.normalizedMessageIds === undefined
      || (Number.isSafeInteger(item.normalizedMessageIds) && Number(item.normalizedMessageIds) > 0))
    && (Number(item.removedItems) > 0 || Number(item.normalizedMessageIds) > 0));
}

function mergeLegacyOfficialRepairBackup(
  backupContent: string,
  currentContent: string,
  expectedRemovedItems: number,
  expectedUnencryptedReasoningItems: number,
  restorableHashes: ReadonlySet<string>
): { readonly content: string; readonly restoredItems: number } | undefined {
  const backupLines = completeLines(backupContent);
  const currentLines = completeLines(currentContent);
  let currentIndex = 0;
  let missingItems = 0;
  let missingUnencryptedReasoningItems = 0;
  let restoredItems = 0;
  const output: string[] = [];
  for (const line of backupLines) {
    if (currentLines[currentIndex] === line) {
      output.push(line);
      currentIndex += 1;
      continue;
    }
    const normalizedLine = normalizeLegacyBridgeMessageRolloutLine(line);
    if (normalizedLine && currentLines[currentIndex] === normalizedLine) {
      output.push(normalizedLine);
      currentIndex += 1;
      continue;
    }
    const hash = encryptedOpaqueResponseItemHash(line);
    if (!hash) {
      if (!isUnencryptedReasoningResponseItemLine(line)
        || missingUnencryptedReasoningItems >= expectedUnencryptedReasoningItems) return undefined;
      missingItems += 1;
      missingUnencryptedReasoningItems += 1;
      continue;
    }
    missingItems += 1;
    if (restorableHashes.has(hash)) {
      output.push(line);
      restoredItems += 1;
    }
  }
  if (missingItems !== expectedRemovedItems) return undefined;
  if (missingUnencryptedReasoningItems !== expectedUnencryptedReasoningItems) return undefined;
  return {
    content: `${output.join('')}${currentLines.slice(currentIndex).join('')}`,
    restoredItems
  };
}

function isUnencryptedReasoningResponseItemLine(line: string): boolean {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return false; }
  return isRecord(value)
    && value.type === 'response_item'
    && isRecord(value.payload)
    && string(value.payload.type) === 'reasoning'
    && !string(value.payload.encrypted_content);
}

function normalizeLegacyBridgeMessageRolloutLine(line: string): string | undefined {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return undefined; }
  if (!isRecord(value) || value.type !== 'response_item' || !isRecord(value.payload)) return undefined;
  if (string(value.payload.type) !== 'message') return undefined;
  const payload = normalizeLegacyBridgeMessageId(value.payload);
  if (payload === value.payload) return undefined;
  return `${JSON.stringify({ ...value, payload })}${line.endsWith('\n') ? '\n' : ''}`;
}

function completeLines(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function encryptedOpaqueResponseItemHash(line: string): string | undefined {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return undefined; }
  if (!isRecord(value) || value.type !== 'response_item' || !isRecord(value.payload)) return undefined;
  const type = string(value.payload.type);
  const encrypted = string(value.payload.encrypted_content);
  return (type === 'reasoning' || isCompactionType(type)) && encrypted
    ? opaqueHash(encrypted)
    : undefined;
}

function localRepairBackupRoot(stateFile: string | undefined, codexHome: string): string {
  if (stateFile) return path.join(path.dirname(path.dirname(stateFile)), 'backups', 'codex-portability-repair-v1');
  return path.join(codexHome, 'backups', 'xwx_deck-codex-portability-repair-v1');
}

function safeRelativeRolloutPath(codexHome: string, file: string): string {
  const relative = path.relative(codexHome, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Codex history path is outside CODEX_HOME: ${file}`);
  }
  return relative;
}

export function codexUpstreamIdentity(input: {
  readonly kind: CodexUpstreamKind;
  readonly baseUrl: string;
  readonly credential?: string;
  readonly accountId?: string;
}): CodexUpstreamIdentity {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, '').toLowerCase();
  const credentialHash = input.credential
    ? createHash('sha256').update(input.credential).digest('hex').slice(0, 20)
    : '';
  return {
    kind: input.kind,
    key: upstreamHash([input.kind, baseUrl, input.accountId?.trim() ?? '', credentialHash].join('|'))
  };
}

interface CodexCheckpoint {
  readonly text: string;
  readonly source: PortableCheckpointSource;
}

function checkpointMessage(text: string): Record<string, unknown> {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }]
  };
}

function unavailableCheckpointText(): string {
  return `${PORTABILITY_SUMMARY_PREFIX}\n\n[Earlier context was compacted by another provider. Its opaque checkpoint could not be decoded, and no matching local plain-text checkpoint was found. Continue from the remaining visible conversation.]`;
}

function collectOpaqueItems(value: unknown): Array<{ kind: 'reasoning' | 'compaction'; encrypted: string }> {
  const out: Array<{ kind: 'reasoning' | 'compaction'; encrypted: string }> = [];
  const seen = new Set<string>();
  const visit = (raw: unknown, depth: number): void => {
    if (depth > 10 || !raw) return;
    if (Array.isArray(raw)) {
      for (const item of raw) visit(item, depth + 1);
      return;
    }
    if (!isRecord(raw)) return;
    const type = string(raw.type);
    const encrypted = string(raw.encrypted_content);
    const kind = type === 'reasoning' ? 'reasoning' : isCompactionType(type) ? 'compaction' : undefined;
    if (kind && encrypted) {
      const key = `${kind}:${encrypted}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ kind, encrypted });
      }
    }
    for (const child of Object.values(raw)) visit(child, depth + 1);
  };
  visit(value, 0);
  return out;
}

function opaqueHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function upstreamHash(value: string): string {
  return /^[0-9a-f]{64}$/.test(value)
    ? value
    : createHash('sha256').update(value).digest('hex');
}

function isCompactionType(value: string): boolean {
  return value === 'compaction' || value === 'compaction_summary' || value === 'context_compaction';
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
