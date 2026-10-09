import { OFFICIAL_PROVIDER_WEBSITES, type OfficialProviderId } from './officialProviders';
import { ADDITIONAL_CLIENT_WEBSITES } from './clientDownloads';
import { SUBSCRIPTION_USAGE_WEBSITES } from './subscriptionAccounts';

export const CLIENT_DOWNLOAD_WEBSITES = {
  'chatgpt-windows-official': 'https://learn.chatgpt.com/docs/app',
  'chatgpt-windows-x64-mirror': 'https://codexapp.agentsmirror.com/latest/win-x64',
  'chatgpt-windows-arm64-mirror': 'https://codexapp.agentsmirror.com/latest/win-arm64',
  'chatgpt-mac-arm64-official': 'https://learn.chatgpt.com/docs/app',
  'chatgpt-mac-x64-official': 'https://learn.chatgpt.com/docs/app',
  'chatgpt-mac-arm64-mirror': 'https://codexapp.agentsmirror.com/latest/mac-arm64',
  'chatgpt-mac-x64-mirror': 'https://codexapp.agentsmirror.com/latest/mac-intel',
  'claude-windows-x64-mirror': 'https://claudeapp.agentsmirror.com/latest/win-x64',
  'claude-windows-arm64-mirror': 'https://claudeapp.agentsmirror.com/latest/win-arm64',
  'claude-mac-mirror': 'https://claudeapp.agentsmirror.com/latest/mac',
  'codex-cli-unix-mirror': 'https://install.agentsmirror.com/codex/install.sh',
  'codex-cli-windows-mirror': 'https://install.agentsmirror.com/codex/install.ps1',
  'claude-code-unix-mirror': 'https://install.agentsmirror.com/claude/install.sh',
  'claude-code-windows-mirror': 'https://install.agentsmirror.com/claude/install.ps1',
  'npm-mirror': 'https://npmmirror.com/'
} as const;

export type SetupWebsite = keyof SetupWebsites;
export interface SetupWebsites extends Readonly<typeof CLIENT_DOWNLOAD_WEBSITES>, Readonly<typeof ADDITIONAL_CLIENT_WEBSITES>, Readonly<typeof SUBSCRIPTION_USAGE_WEBSITES>, Readonly<Record<OfficialProviderId, string>> {
  readonly claude: string;
  readonly codex: string;
  readonly 'codex-mirror'?: string;
  readonly 'codex-downloads': string;
  readonly 'codex-mirror-list': string;
  readonly 'codex-linux': string;
}

// Vendor pages let the user choose the current platform/version themselves.
export function setupWebsitesFor(platform: string, arch: string): SetupWebsites {
  const mirrorTarget = platform === 'darwin'
    ? arch === 'arm64' ? 'mac-arm64' : arch === 'x64' ? 'mac-intel' : undefined
    : platform === 'win32'
      ? arch === 'arm64' ? 'win-arm64' : arch === 'x64' ? 'win-x64' : undefined
      : undefined;
  return {
    ...CLIENT_DOWNLOAD_WEBSITES,
    ...ADDITIONAL_CLIENT_WEBSITES,
    ...SUBSCRIPTION_USAGE_WEBSITES,
    ...OFFICIAL_PROVIDER_WEBSITES,
    claude: 'https://claude.com/download',
    codex: 'https://learn.chatgpt.com/docs/app',
    'codex-mirror': mirrorTarget ? `https://codexapp.agentsmirror.com/latest/${mirrorTarget}` : undefined,
    'codex-downloads': 'https://learn.chatgpt.com/docs/app',
    'codex-mirror-list': 'https://codexapp.agentsmirror.com/#mirror',
    'codex-linux': 'https://learn.chatgpt.com/docs/linux/linux-app'
  };
}

export function setupWebsiteUrl(site: unknown, platform: string, arch: string): string {
  const websites = setupWebsitesFor(platform, arch);
  if (typeof site !== 'string' || !Object.hasOwn(websites, site)) {
    throw new Error('无效的官网入口。');
  }
  const url = websites[site as SetupWebsite];
  if (!url) throw new Error('当前系统或架构暂无直连镜像。');
  return url;
}
