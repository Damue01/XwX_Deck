import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import { ArrowUpRight, ChevronDown } from 'lucide-react';
import { useBridge } from '@/bridge/store';
import { showErrorToast, showToast } from '@/lib/toast';
import type { SetupWebsite } from '../../../shared/setupWebsites';
import type { DownloadClientId } from '../../../shared/clientDownloads';

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
  readonly command?: string;
}

const NPM_MIRROR_PACKAGES: Partial<Record<DownloadClientId, string>> = {
  'gemini-cli': '@google/gemini-cli',
  'qwen-code': '@qwen-code/qwen-code',
  opencode: 'opencode-ai'
};

function cliDownloadGroups(client: DownloadClientId): readonly DownloadGroup[] {
  if (client === 'codex-cli' || client === 'claude-code') {
    const provider = client === 'codex-cli' ? 'codex' : 'claude';
    return [
      { name: 'Windows', rows: [{ name: t('安装脚本'), mirror: `${client}-windows-mirror` }], command: `irm https://install.agentsmirror.com/${provider}/install.ps1 | iex` },
      { name: 'Mac / Linux', rows: [{ name: t('安装脚本'), mirror: `${client}-unix-mirror` }], command: `curl -fsSL https://install.agentsmirror.com/${provider}/install.sh | bash` }
    ];
  }
  const npmPackage = NPM_MIRROR_PACKAGES[client];
  return npmPackage ? [{ name: 'npm', rows: [{ name: t('打开镜像站'), mirror: 'npm-mirror' }], command: `npm install -g ${npmPackage} --registry=https://registry.npmmirror.com` }] : [];
}

export function ClientDownloads({ client }: { client: DownloadClientId }): React.ReactElement {
  useLanguage();
  const { api } = useBridge();
  const groups: readonly DownloadGroup[] = client === 'claude' ? CLAUDE_DOWNLOAD_GROUPS : client === 'codex' ? DOWNLOAD_GROUPS : cliDownloadGroups(client);
  const websiteLink = (site: SetupWebsite, label: string, accessibleName?: string) => api.setupWebsites[site] && <a className="setup-card-link" aria-label={accessibleName} href={api.setupWebsites[site]} target="_blank" rel="noopener noreferrer" onClick={event => {
    event.preventDefault();
    void api.openSetupWebsite(site).catch(error => showErrorToast(t('打开下载入口失败'), error));
  }}>{label}<ArrowUpRight aria-hidden="true" /></a>;
  return <div className="setup-card-download-groups">
    <div className="setup-card-links">{websiteLink(client === 'codex' || client === 'claude' ? client : `download-${client}`, t('官方下载'))}</div>
    {groups.map(group => <details key={group.name} className="setup-card-downloads">
      <summary>{group.name}{t("镜像")}<ChevronDown aria-hidden="true" /></summary>
      <div className="setup-card-download-links">{group.rows.map(row => <React.Fragment key={row.name}>
        {websiteLink(row.mirror, row.name, t("{0} {1} 国内镜像下载（第三方）", group.name, row.name))}
      </React.Fragment>)}</div>
      {group.command && <div className="setup-card-install">
        <code className="setup-card-install-command">{group.command}</code>
        <button type="button" className="provider-text-action" aria-label={t("复制 {0} 镜像安装命令", group.name)} onClick={() => void api.copyText(group.command!).then(() => showToast(t('安装命令已复制'), 'success')).catch(error => showErrorToast(t('复制安装命令失败'), error))}>{t("复制安装命令")}</button>
      </div>}
    </details>)}
  </div>;
}
