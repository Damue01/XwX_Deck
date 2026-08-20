import * as fs from 'fs';
import * as path from 'path';
import { readJson, writeFileAtomic, writeJson } from '../shared/fsx';
import { resolveClientPaths } from './clientConfig';

interface CodexOfficialAuthState {
  readonly version: 1;
  readonly authPath: string;
  readonly originalExisted: boolean;
  readonly originalContentBase64: string;
  readonly writtenContentBase64: string;
}

export interface CodexOfficialAuthOutcome {
  readonly changed: boolean;
  readonly managed: boolean;
}

const STATE_FILE = 'codex-official-auth-state.json';

/**
 * Manages the optional 兼容服务 credential projection in Codex auth.json.
 *
 * When official-login preservation is disabled, XwX Deck temporarily writes the
 * 兼容服务 API key and keeps the original OAuth/API-key file byte-for-byte for
 * conflict-safe restoration.
 */
export class CodexOfficialAuthManager {
  constructor(private readonly userDataDir: string) {}

  async useCompatibleServiceKey(bearerToken: string): Promise<CodexOfficialAuthOutcome> {
    const token = bearerToken.trim();
    if (!token) throw new Error('服务商密钥不能为空。');
    const authPath = resolveClientPaths().codexAuthPath;
    const written = Buffer.from(`${JSON.stringify({ OPENAI_API_KEY: token })}\n`, 'utf8');
    const current = await readOptionalBuffer(authPath);
    const previousState = await this.readState();

    if (previousState && previousState.authPath !== authPath) {
      throw new Error('ChatGPT 登录目录已变化；请先切回原 ChatGPT 目录恢复登录。');
    }

    const original = previousState ? decodeOriginal(previousState) : current;
    if (previousState) {
      const expected = Buffer.from(previousState.writtenContentBase64, 'base64');
      if (!optionalBuffersEqual(current, expected) && !optionalBuffersEqual(current, original)) {
        throw authConflictError();
      }
    }

    const nextState: CodexOfficialAuthState = {
      version: 1,
      authPath,
      originalExisted: previousState?.originalExisted ?? current !== undefined,
      originalContentBase64: previousState?.originalContentBase64 ?? current?.toString('base64') ?? '',
      writtenContentBase64: written.toString('base64')
    };

    await writeJson(this.statePath(), nextState);
    try {
      await writeFileAtomic(authPath, written);
    } catch (error) {
      if (previousState) await writeJson(this.statePath(), previousState);
      else await fs.promises.rm(this.statePath(), { force: true });
      throw error;
    }
    return { changed: !optionalBuffersEqual(current, written), managed: true };
  }

  async restoreOfficialLogin(): Promise<CodexOfficialAuthOutcome> {
    const state = await this.readState();
    if (!state) return { changed: false, managed: false };

    const authPath = resolveClientPaths().codexAuthPath;
    if (state.authPath !== authPath) {
      throw new Error('ChatGPT 登录目录已变化；XwX Deck 未恢复其他目录中的 auth.json。');
    }

    const current = await readOptionalBuffer(authPath);
    const original = decodeOriginal(state);
    const expected = Buffer.from(state.writtenContentBase64, 'base64');
    if (optionalBuffersEqual(current, original)) {
      await fs.promises.rm(this.statePath(), { force: true });
      return { changed: false, managed: false };
    }
    if (!optionalBuffersEqual(current, expected)) throw authConflictError();

    if (original === undefined) await fs.promises.rm(authPath, { force: true });
    else await writeFileAtomic(authPath, original);
    await fs.promises.rm(this.statePath(), { force: true });
    return { changed: true, managed: false };
  }

  async readCurrentBearerToken(): Promise<string | undefined> {
    const data = await readOptionalBuffer(resolveClientPaths().codexAuthPath);
    if (!data) return undefined;
    try {
      const value = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      if (typeof value.OPENAI_API_KEY === 'string' && value.OPENAI_API_KEY.trim()) {
        return value.OPENAI_API_KEY.trim();
      }
      const tokens = value.tokens;
      if (tokens && typeof tokens === 'object' && !Array.isArray(tokens)) {
        const accessToken = (tokens as Record<string, unknown>).access_token;
        if (typeof accessToken === 'string' && accessToken.trim()) return accessToken.trim();
      }
    } catch { /* malformed auth is handled by the normal Codex login flow */ }
    return undefined;
  }

  private statePath(): string {
    return path.join(this.userDataDir, STATE_FILE);
  }

  private async readState(): Promise<CodexOfficialAuthState | undefined> {
    const state = await readJson<CodexOfficialAuthState | undefined>(this.statePath(), undefined);
    if (!state || state.version !== 1 || typeof state.authPath !== 'string') return undefined;
    if (typeof state.originalExisted !== 'boolean') return undefined;
    if (typeof state.originalContentBase64 !== 'string' || typeof state.writtenContentBase64 !== 'string') return undefined;
    return state;
  }
}

function decodeOriginal(state: CodexOfficialAuthState): Buffer | undefined {
  return state.originalExisted ? Buffer.from(state.originalContentBase64, 'base64') : undefined;
}

function authConflictError(): Error {
  return new Error('检测到 ChatGPT auth.json 已被其他软件修改；XwX Deck 已保留外部内容，没有覆盖登录状态。');
}

async function readOptionalBuffer(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.promises.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function optionalBuffersEqual(left: Buffer | undefined, right: Buffer | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.equals(right);
}
