import * as fs from 'fs';
import * as path from 'path';
import { readTextOrUndefined, writeFileAtomic } from '../shared/fsx';
import {
  CODEX_CHATGPT_OAUTH_PROVIDER_TARGET,
  CODEX_DEFAULT_TARGET,
  CODEX_STABLE_PROVIDER,
  isXwXManagedProvider,
  isLoopbackUrl
} from './clientConfig';
import type { CodexConfigSnapshot } from './codexConfigManager';
import { findTomlSection, readTomlStringKey, setTomlStringKey } from './toml';

const STATE_FILE = 'codex-local-proxy-suspension.json';
const PROVIDER_SECTION = `[model_providers.${CODEX_STABLE_PROVIDER}]`;

interface CodexLocalProxySuspensionRecord {
  readonly version: 1 | 2;
  readonly configPath: string;
  readonly preparedProvider: string;
  readonly originalBaseUrl: string;
  readonly directBaseUrl: string;
  readonly restoreOriginal: boolean;
  readonly writtenAt: string;
}

export interface CodexLocalProxyPrepareResult {
  readonly status: 'not-needed' | 'adjusted' | 'resumed' | 'unsupported';
  readonly localBaseUrl?: string;
}

export interface CodexLocalProxyRestoreResult {
  readonly restored: boolean;
  readonly conflict?: string;
}

/**
 * Temporarily bypasses a local XwX Deck connection while Trace installs its
 * own overlay. This is intentionally a second, narrower transaction outside
 * ClientConfigWriter: Trace first restores its overlay to `directBaseUrl`, then
 * this coordinator restores the pre-existing XwX Deck connection.
 */
export class CodexLocalProxyCoordinator {
  constructor(private readonly userDataDir: string) {}

  async hasPendingOriginalRestore(): Promise<boolean> {
    return (await this.readRecord())?.restoreOriginal === true;
  }

  async prepare(
    snapshot: CodexConfigSnapshot,
    restoreOriginal: boolean
  ): Promise<CodexLocalProxyPrepareResult> {
    const existing = await this.readRecord();
    if (existing) {
      const current = await readTextOrUndefined(existing.configPath);
      if (current !== undefined && managedProviderBaseUrl(current, existing.preparedProvider) === existing.directBaseUrl) {
        return { status: 'resumed', localBaseUrl: existing.originalBaseUrl };
      }
      await this.removeRecord();
    }

    if (!isLoopbackUrl(snapshot.activeBaseUrl)) return { status: 'not-needed' };
    if (!isXwXManagedProvider(snapshot.activeProvider)) {
      return { status: 'unsupported', localBaseUrl: snapshot.activeBaseUrl };
    }
    const directBaseUrl = snapshot.authMode === 'chatgpt'
      ? CODEX_CHATGPT_OAUTH_PROVIDER_TARGET
      : snapshot.authMode === 'api-key'
        ? `${CODEX_DEFAULT_TARGET}/v1`
        : undefined;
    if (!directBaseUrl) return { status: 'unsupported', localBaseUrl: snapshot.activeBaseUrl };

    const original = await readTextOrUndefined(snapshot.configPath);
    if (original === undefined || providerBaseUrl(original, snapshot.activeProvider) !== snapshot.activeBaseUrl) {
      throw new Error('ChatGPT 配置在连接调整前发生了变化。');
    }
    const next = setTomlStringKey(original, 'base_url', directBaseUrl, {
      sectionHeader: `[model_providers.${snapshot.activeProvider}]`
    }).text;
    const record: CodexLocalProxySuspensionRecord = {
      version: 2,
      configPath: snapshot.configPath,
      preparedProvider: snapshot.activeProvider,
      originalBaseUrl: snapshot.activeBaseUrl,
      directBaseUrl,
      restoreOriginal,
      writtenAt: new Date().toISOString()
    };
    await writeFileAtomic(this.statePath(), `${JSON.stringify(record, null, 2)}\n`);
    try {
      const current = await readTextOrUndefined(snapshot.configPath);
      if (current !== original) throw new Error('ChatGPT 配置在连接调整前发生了变化。');
      await writeFileAtomic(snapshot.configPath, next);
    } catch (error) {
      await this.removeRecord();
      throw error;
    }
    return { status: 'adjusted', localBaseUrl: snapshot.activeBaseUrl };
  }

  async restore(): Promise<CodexLocalProxyRestoreResult> {
    const record = await this.readRecord();
    if (!record) return { restored: false };
    const current = await readTextOrUndefined(record.configPath);
    if (current === undefined) {
      await this.removeRecord();
      return { restored: false, conflict: 'ChatGPT 配置已被外部删除，未恢复原连接' };
    }
    const currentBaseUrl = managedProviderBaseUrl(current, record.preparedProvider);
    if (currentBaseUrl !== record.directBaseUrl) {
      await this.removeRecord();
      return { restored: false, conflict: 'ChatGPT 连接已被外部修改，保留当前连接' };
    }
    if (record.restoreOriginal) {
      const next = setTomlStringKey(current, 'base_url', record.originalBaseUrl, {
        sectionHeader: PROVIDER_SECTION
      }).text;
      const latest = await readTextOrUndefined(record.configPath);
      if (latest !== current) throw new Error('ChatGPT 配置在恢复原连接前发生了变化。');
      await writeFileAtomic(record.configPath, next);
    }
    await this.removeRecord();
    return { restored: record.restoreOriginal };
  }

  async discard(): Promise<void> {
    await this.removeRecord();
  }

  private statePath(): string {
    return path.join(this.userDataDir, STATE_FILE);
  }

  private async readRecord(): Promise<CodexLocalProxySuspensionRecord | undefined> {
    const text = await readTextOrUndefined(this.statePath());
    if (!text) return undefined;
    try {
      const value = JSON.parse(text) as Partial<CodexLocalProxySuspensionRecord>;
      if (value.version !== 1 && value.version !== 2
        || typeof value.configPath !== 'string'
        || typeof value.originalBaseUrl !== 'string'
        || typeof value.directBaseUrl !== 'string'
        || typeof value.restoreOriginal !== 'boolean'
        || typeof value.writtenAt !== 'string') return undefined;
      return {
        ...value,
        preparedProvider: value.version === 2 && typeof value.preparedProvider === 'string'
          ? value.preparedProvider
          : CODEX_STABLE_PROVIDER
      } as CodexLocalProxySuspensionRecord;
    } catch {
      return undefined;
    }
  }

  private async removeRecord(): Promise<void> {
    await fs.promises.unlink(this.statePath()).catch(() => undefined);
  }
}

function providerBaseUrl(text: string, provider: string): string | undefined {
  const section = findTomlSection(text, `[model_providers.${provider}]`);
  if (!section) return undefined;
  return readTomlStringKey(text.slice(section.start, section.end), 'base_url')?.trim();
}

function managedProviderBaseUrl(text: string, preparedProvider: string): string | undefined {
  return providerBaseUrl(text, CODEX_STABLE_PROVIDER) ?? providerBaseUrl(text, preparedProvider);
}
