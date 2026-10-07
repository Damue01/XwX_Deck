import * as React from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { ArrowUpRight, ChevronDown } from 'lucide-react';
import { useBridge } from '@/bridge/store';
import { showErrorToast } from '@/lib/toast';
import type { SetupWebsite } from '../../../shared/setupWebsites';
import { OFFICIAL_PROVIDERS, type OfficialProviderId } from '../../../shared/officialProviders';
import { ProviderIcon } from './ProviderIcon';

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

export function ProviderSetupShortcuts({ kind, disabled = false, onConfigure, selectedProvider, onSelectProvider }: {
  kind: 'client' | 'service';
  disabled?: boolean;
  onConfigure?: (id: OfficialProviderId) => void;
  selectedProvider?: OfficialProviderId | null;
  onSelectProvider?: (id: OfficialProviderId | null) => void;
}): React.ReactElement {
  const { api } = useBridge();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const track = scrollRef.current;
    if (!track || kind !== 'service') return;
    const onWheel = (event: WheelEvent) => {
      // Keep horizontal gestures, Shift+wheel and browser zoom native.
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey
        || event.deltaX !== 0 || event.deltaY === 0) return;
      const max = track.scrollWidth - track.clientWidth;
      if (max <= 0) return;
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? track.clientWidth : 1;
      const next = Math.max(0, Math.min(max, track.scrollLeft + event.deltaY * scale));
      if (next === track.scrollLeft) return;
      event.preventDefault();
      track.scrollLeft = next;
    };
    track.addEventListener('wheel', onWheel, { passive: false });
    return () => track.removeEventListener('wheel', onWheel);
  }, [kind]);
  const [clientOpen, setClientOpen] = React.useState<SetupWebsite | null>(null);
  const open = kind === 'service' ? selectedProvider : clientOpen;
  const setOpen = (site: SetupWebsite | null) => {
    if (kind === 'service') onSelectProvider?.(site as OfficialProviderId | null);
    else setClientOpen(site);
  };
  const configuring = React.useRef(false);
  const websiteLink = (site: SetupWebsite, label: string, accessibleName?: string) => api.setupWebsites[site] && <a className="setup-card-link" aria-label={accessibleName} href={api.setupWebsites[site]} target="_blank" rel="noopener noreferrer" onClick={event => {
    event.preventDefault();
    void api.openSetupWebsite(site).catch(error => showErrorToast('打开下载或官网入口失败', error));
  }}>{label}<ArrowUpRight aria-hidden="true" /></a>;
  return <div className={kind === 'service' ? 'provider-shortcut-strip' : undefined} aria-label={kind === 'client' ? '客户端入口' : '模型服务入口'}>
    <div ref={scrollRef} className={`provider-shortcuts${kind === 'service' ? ' provider-shortcuts-scroll' : ''}`}>
    {(kind === 'client' ? ['codex', 'claude'] as const : OFFICIAL_PROVIDERS.map(provider => provider.id)).map(site => {
      const provider = OFFICIAL_PROVIDERS.find(provider => provider.id === site);
      const name = provider?.label ?? (site === 'claude' ? 'Claude' : 'ChatGPT');
      const icon = provider?.id ?? (site === 'claude' ? 'claude' : 'chatgpt');
      return <Dialog.Root key={site} open={open === site} onOpenChange={value => { configuring.current = false; setOpen(value ? site : null); }}>
        <Dialog.Trigger className="provider-shortcut" disabled={disabled}>
          <ProviderIcon kind={icon} /><span>{name}</span>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop className="setup-card-backdrop" />
          <Dialog.Popup className="setup-card" finalFocus={() => configuring.current ? document.getElementById('provider-key') : true}>
            <Dialog.Title className="setup-card-title"><ProviderIcon kind={icon} />{name}</Dialog.Title>
            <Dialog.Description className="sr-only">
              {provider ? '确认后填写模型服务名称与 API 地址。' : '选择客户端下载入口。'}
            </Dialog.Description>
            {provider && <dl className="setup-card-config"><div><dt>名称</dt><dd>{provider.displayName}</dd></div><div><dt>API 地址</dt><dd>{provider.baseUrl}</dd></div></dl>}
            {provider && <div className="setup-card-links">{websiteLink(provider.id, '获取 API 密钥')}</div>}
            {site === 'claude' && <div className="setup-card-download-groups">
              <div className="setup-card-links">{websiteLink('claude', '官方下载')}</div>
              {CLAUDE_DOWNLOAD_GROUPS.map(group => <details key={group.name} className="setup-card-downloads">
                <summary>{group.name} 镜像<ChevronDown aria-hidden="true" /></summary>
                <div className="setup-card-download-links">
                  {group.rows.map(row => <React.Fragment key={row.name}>
                    {websiteLink(row.mirror, row.name, `${group.name} ${row.name} 国内镜像下载（第三方）`)}
                  </React.Fragment>)}
                </div>
              </details>)}
            </div>}
            {site === 'codex' && <div className="setup-card-download-groups">
              <div className="setup-card-links">{websiteLink('codex', '官方下载')}</div>
              {DOWNLOAD_GROUPS.map(group => <details key={group.name} className="setup-card-downloads">
                <summary>{group.name} 镜像<ChevronDown aria-hidden="true" /></summary>
                <div className="setup-card-download-links">
                  {group.rows.map(row => <React.Fragment key={row.name}>
                    {websiteLink(row.mirror, row.name, `${group.name} ${row.name} 国内镜像下载（第三方）`)}
                  </React.Fragment>)}
                </div>
              </details>)}
            </div>}
            <div className="setup-card-actions">
              <Dialog.Close className="btn">{provider ? '取消' : '关闭'}</Dialog.Close>
              {provider && <button type="button" className="btn primary" onClick={() => {
                configuring.current = true;
                setOpen(null);
                onConfigure?.(provider.id);
              }}>确认配置</button>}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>;
    })}
    </div>
  </div>;
}
