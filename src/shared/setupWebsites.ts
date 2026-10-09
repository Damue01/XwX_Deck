import { OFFICIAL_PROVIDER_WEBSITES, type OfficialProviderId } from './officialProviders';
import { CLIENT_GATEWAY_HELP } from './clientGatewaySetup';
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
  'opencode-mac-arm64-download': 'https://github.com/anomalyco/opencode/releases/latest/download/opencode-desktop-mac-arm64.dmg',
  'opencode-mac-x64-download': 'https://github.com/anomalyco/opencode/releases/latest/download/opencode-desktop-mac-x64.dmg',
  'opencode-windows-x64-download': 'https://github.com/anomalyco/opencode/releases/latest/download/opencode-desktop-win-x64.exe',
  'opencode-windows-arm64-download': 'https://github.com/anomalyco/opencode/releases/latest/download/opencode-desktop-win-arm64.exe',
  'qwen-code-mac-arm64-download': 'https://github.com/QwenLM/qwen-code/releases/download/desktop-latest/Qwen-Code-Desktop-arm64.dmg',
  'qwen-code-mac-x64-download': 'https://github.com/QwenLM/qwen-code/releases/download/desktop-latest/Qwen-Code-Desktop-x64.dmg',
  'opencode-cli-official': 'https://opencode.ai/docs/#install',
  'qwen-code-cli-official': 'https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/'
} as const;

export type SetupWebsite = keyof SetupWebsites;
export interface SetupWebsites extends Readonly<typeof CLIENT_DOWNLOAD_WEBSITES>, Readonly<typeof ADDITIONAL_CLIENT_WEBSITES>, Readonly<typeof CLIENT_GATEWAY_HELP>, Readonly<typeof SUBSCRIPTION_USAGE_WEBSITES>, Readonly<Record<OfficialProviderId, string>> {
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
    ...CLIENT_GATEWAY_HELP,
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
