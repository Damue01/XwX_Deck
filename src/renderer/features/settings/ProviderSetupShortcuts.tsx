import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import { ArrowUpRight, ChevronDown } from 'lucide-react';
import { useBridge } from '@/bridge/store';
import { showErrorToast } from '@/lib/toast';
import type { SetupWebsite } from '../../../shared/setupWebsites';
import { CLIENT_DOWNLOADS, clientDownloadLabel, canonicalModelClient, type DownloadClientId } from '../../../shared/clientDownloads';

const DOWNLOAD_GROUPS = [
  { name: 'Windows', rows: [
    { name: 'x64', mirror: 'chatgpt-windows-x64-mirror' },
    { name: 'ARM64', mirror: 'chatgpt-windows-arm64-mirror' }
  ] },
  { name: 'Mac', rows: [
    { name: 'Apple Silicon', mirror: 'chatgpt-mac-arm64-mirror' },
    { name: 'Intel', mirror: 'chatgpt-mac-x64-mirror' }
  ] }
] as const;

const CLAUDE_DOWNLOAD_GROUPS = [
  { name: 'Windows', rows: [
    { name: 'x64', mirror: 'claude-windows-x64-mirror' },
    { name: 'ARM64', mirror: 'claude-windows-arm64-mirror' }
  ] },
  { name: 'Mac', rows: [
    { name: '通用（Apple Silicon + Intel）', mirror: 'claude-mac-mirror' }
  ] }
] as const;

interface DownloadGroup {
  readonly name: string;
  readonly rows: readonly { readonly name: string; readonly mirror: SetupWebsite }[];
  readonly official?: boolean;
}

function desktopDownloadGroups(client: DownloadClientId): readonly DownloadGroup[] {
  if (client === 'opencode') {
    return [
      { name: 'Windows', official: true, rows: [{ name: 'x64', mirror: 'opencode-windows-x64-download' }, { name: 'ARM64', mirror: 'opencode-windows-arm64-download' }] },
      { name: 'Mac', official: true, rows: [{ name: 'Apple Silicon', mirror: 'opencode-mac-arm64-download' }, { name: 'Intel', mirror: 'opencode-mac-x64-download' }] }
    ];
  }
  return client === 'qwen-code' ? [
    { name: 'Mac', official: true, rows: [{ name: 'Apple Silicon', mirror: 'qwen-code-mac-arm64-download' }, { name: 'Intel', mirror: 'qwen-code-mac-x64-download' }] }
  ] : [];
}

const CLI_DOWNLOADS: Partial<Record<DownloadClientId, { name: string; site: SetupWebsite }>> = {
  codex: { name: 'Codex CLI', site: 'download-codex-cli' },
  claude: { name: 'Claude Code CLI', site: 'download-claude-code' },
  opencode: { name: 'OpenCode CLI', site: 'opencode-cli-official' },
  'qwen-code': { name: 'Qwen Code CLI', site: 'qwen-code-cli-official' },
  cursor: { name: 'Cursor CLI', site: 'download-cursor-cli' }
};

export function ClientDownloads({ client, officialOnly = false }: { client: DownloadClientId; officialOnly?: boolean }): React.ReactElement {
  useLanguage();
  const { api } = useBridge();
  const product = canonicalModelClient(client);
  const info = CLIENT_DOWNLOADS.find(item => item.id === product)!;
  const cli = CLI_DOWNLOADS[product];
  const groups: readonly DownloadGroup[] = product === 'claude' ? CLAUDE_DOWNLOAD_GROUPS : product === 'codex' ? DOWNLOAD_GROUPS : desktopDownloadGroups(product);
  const websiteLink = (site: SetupWebsite, label: string, accessibleName?: string) => api.setupWebsites[site] && <a className="setup-card-link" aria-label={accessibleName} href={api.setupWebsites[site]} target="_blank" rel="noopener noreferrer" onClick={event => {
    event.preventDefault();
    void api.openSetupWebsite(site).catch(error => showErrorToast(t('打开下载入口失败'), error));
  }}>{label}<ArrowUpRight aria-hidden="true" /></a>;
  return <div className="setup-card-download-versions">
    <section className="setup-card-download-groups" aria-label={clientDownloadLabel(info)}>
      <div className="setup-card-download-version-heading">{(cli || 'downloadLabel' in info) && <h4>{clientDownloadLabel(info)}</h4>}{websiteLink(product === 'codex' || product === 'claude' ? product : `download-${product}`, t('官方下载'), `${clientDownloadLabel(info)} ${t('官方下载')}`)}</div>
    {!officialOnly && groups.map(group => <details key={group.name} className="setup-card-downloads">
      <summary>{group.name} {t(group.official ? '官方下载' : '镜像')}<ChevronDown aria-hidden="true" /></summary>
      <div className="setup-card-download-links">{group.rows.map(row => <React.Fragment key={row.name}>
        {websiteLink(row.mirror, row.name, group.official ? `${group.name} ${row.name} Desktop ${t('官方下载')}` : t("{0} {1} 国内镜像下载（第三方）", group.name, row.name))}
      </React.Fragment>)}</div>
    </details>)}
    </section>
    {cli && <section className="setup-card-download-groups" aria-label={cli.name}><div className="setup-card-download-version-heading"><h4>{cli.name}</h4>{websiteLink(cli.site, t('官方下载'), `${cli.name} ${t('官方下载')}`)}</div></section>}
  </div>;
}
