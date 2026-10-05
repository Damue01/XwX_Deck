import {
  CodexConfigManager,
  type CodexConfigMode
} from './codexConfigManager';
import { CodexOfficialAuthManager } from './codexOfficialAuthManager';

export interface CodexPreferredDirectInput {
  readonly preserveOfficialLogin?: boolean;
  readonly providerAdapter?: import('../../shared/providers').ProviderAdapter;
  readonly unifySessionHistory?: boolean;
  readonly directProviders?: readonly import('./codexConfigManager').CodexProviderDirectInput[];
  readonly providerId?: string;
  readonly providerName?: string;
  readonly publishModelCatalog?: boolean;
  readonly requiresGateway?: boolean;
  readonly preferredMode: 'auto' | CodexConfigMode;
  readonly officialModel: string;
  readonly compatibleModel: string;
  readonly compatibleContextWindow: number;
  readonly compatibleBaseUrl: string;
  readonly compatibleBearerToken: string;
  /** Explicit repair and force-stop/exit recovery may rebuild malformed config.toml. */
  readonly allowInvalidConfigRecovery?: boolean;
}

export interface CodexPreferredDirectResult {
  readonly mode: CodexConfigMode;
  readonly restoredFields: number;
  readonly conflicts: readonly string[];
  readonly fellBackToOfficial: boolean;
}

/**
 * Persist a provider-direct Codex configuration for complete Gateway shutdown.
 * Keep the selected identity (or the opted-in shared identity), replace owned
 * localhost endpoints with their recorded direct connections, and preserve
 * every historical provider section. Exit does not migrate session history.
 */
export async function restoreCodexPreferredDirectConfiguration(
  userDataDir: string,
  input: CodexPreferredDirectInput
): Promise<CodexPreferredDirectResult> {
  const manager = new CodexConfigManager(userDataDir);
  const auth = new CodexOfficialAuthManager(userDataDir);
  let current;
  try {
    current = await manager.read();
  } catch (error) {
    if (!input.allowInvalidConfigRecovery
      || !/config\.toml.*格式错误|TOML.*(?:错误|解析)/i.test((error as Error).message)) {
      throw error;
    }
    const recovered = await manager.recoverInvalidConfiguration(input.officialModel);
    if (recovered.backupPath) {
      current = await manager.read();
    } else {
      throw error;
    }
  }
  const preferredMode = input.preferredMode === 'auto' ? current.mode : input.preferredMode;
  const compatibleModel = input.compatibleModel.trim() || current.compatible.model;
  const hasCompatibleServiceDirect = preferredMode === 'compatible'
    && !!input.compatibleBaseUrl.trim()
    && !!input.compatibleBearerToken.trim()
    && !!compatibleModel;

  if (preferredMode === 'compatible' && !hasCompatibleServiceDirect) {
    throw new Error('所选服务的地址、密钥或模型不完整；请补全配置，未切回官方服务。');
  }

  // A provider-scoped CompatibleService credential is sufficient for direct mode, so
  // always put auth.json back exactly as it was before XwX projected a key.
  await auth.restoreOfficialLogin();

  if (hasCompatibleServiceDirect) {
    const restored = await manager.restoreCompatibleServiceDirectConfiguration({
      providerAdapter: input.providerAdapter,
      preserveOfficialLogin: input.preserveOfficialLogin,
      unifySessionHistory: input.unifySessionHistory,
      directProviders: input.directProviders,
      providerId: input.providerId,
      providerName: input.providerName,
      publishModelCatalog: input.publishModelCatalog,
      compatibleBaseUrl: input.compatibleBaseUrl,
      compatibleBearerToken: input.compatibleBearerToken,
      compatibleModel,
      modelContextWindow: input.compatibleContextWindow || null
    });
    return {
      mode: 'compatible',
      ...restored,
      fellBackToOfficial: false
    };
  }

  const restored = await manager.restoreDirectConfiguration({
    officialBaseUrl: await manager.readOfficialBaseUrl(),
    unifySessionHistory: input.unifySessionHistory,
    directProviders: input.directProviders,
    officialModel: input.officialModel
  });
  return {
    mode: 'official',
    restoredFields: restored.restoredFields,
    conflicts: restored.conflicts,
    fellBackToOfficial: false
  };
}
