import * as React from 'react';
import { Gauge, Box, Settings, LayoutDashboard, PanelLeft, ArrowDownToLine, Check, LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getApi } from '@/bridge/api';
import type { XwXDeckUpdateState } from '@/bridge/types';

export type PageId = 'signal' | 'models' | 'settings';

interface Props {
  readonly activePage: PageId;
  readonly onNavigate: (page: PageId) => void;
  readonly updateState: XwXDeckUpdateState | null;
}

const NAV_ITEMS: Array<{ id: PageId; label: string; tip: string; Icon: React.ElementType }> = [
  { id: 'signal',   label: 'Trace', tip: 'Trace', Icon: Gauge },
  { id: 'models',   label: '模型',      tip: '模型',      Icon: Box },
];

export function Rail({ activePage, onNavigate, updateState }: Props): React.ReactElement {
  const api = getApi();
  const hasUpdateCue = updateState?.updateAvailable === true;
  const isDownloading = updateState?.status === 'downloading';
  const downloadPercent = Math.round(updateState?.percent || 0);
  const updateTip = isDownloading
    ? `设置，正在下载 XwX Deck ${updateState?.targetVersion || ''}，${downloadPercent}%`
    : updateState?.status === 'ready'
      ? updateState.installMode === 'manual-dmg'
        ? `设置，XwX Deck ${updateState.targetVersion || ''} 已下载，点击打开安装包`
        : `设置，XwX Deck ${updateState.targetVersion || ''} 已准备好，点击重启更新`
      : hasUpdateCue
        ? `设置，发现新版本 ${updateState?.targetVersion || ''}`
        : '设置';
  const [collapsed, setCollapsed] = React.useState<boolean>(() => {
    try { return localStorage.getItem('xwx-deck.sidebar') === 'collapsed'; } catch { return false; }
  });

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem('xwx-deck.sidebar', next ? 'collapsed' : 'expanded'); } catch { /* ignore */ }
      document.body.dataset.sidebar = next ? 'collapsed' : '';
      return next;
    });
  }, []);

  React.useEffect(() => {
    document.body.dataset.sidebar = collapsed ? 'collapsed' : '';
  }, [collapsed]);

  return (
    <nav className="rail" aria-label="主要功能">
      <button
        type="button"
        className="rail-btn rail-toggle"
        id="railToggle"
        data-tip={collapsed ? '展开侧栏' : '收起侧栏'}
        aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
        onClick={toggleCollapsed}
      >
        <PanelLeft size={20} />
        <span className="rail-label">收起侧栏</span>
      </button>

      {NAV_ITEMS.map(({ id, label, tip, Icon }) => (
        <button
          key={id}
          type="button"
          className={cn('rail-btn', activePage === id && 'current')}
          data-page={id}
          data-tip={tip}
          aria-current={activePage === id ? 'page' : undefined}
          aria-label={label}
          onClick={() => onNavigate(id)}
        >
          <Icon size={20} />
          <span className="rail-label">{label}</span>
        </button>
      ))}

      <span className="rail-spring" />
      <span className="rail-sep" aria-hidden="true" />

      <button
        type="button"
        className="rail-btn"
        id="dashBtn"
        data-tip="仪表盘"
        aria-label="仪表盘"
        onClick={() => void api.openDashboard()}
      >
        <LayoutDashboard size={20} />
        <span className="rail-label">仪表盘</span>
      </button>

      <button
        type="button"
        className="rail-btn"
        data-page="settings"
        data-update-status={hasUpdateCue ? updateState?.status : undefined}
        data-tip={updateTip}
        aria-current={activePage === 'settings' ? 'page' : undefined}
        aria-label={updateTip}
        onClick={() => onNavigate('settings')}
      >
        <Settings size={20} aria-hidden="true" />
        <span className="rail-label">设置</span>
        {hasUpdateCue && (
          <span
            className={cn('rail-update-status', isDownloading && 'is-downloading')}
            id="settingsUpdateCue"
            aria-hidden="true"
          >
            {isDownloading ? (
              <>
                <LoaderCircle className="rail-update-spinner" aria-hidden="true" />
                <span>{downloadPercent}%</span>
              </>
            ) : updateState?.status === 'ready' ? (
              <Check aria-hidden="true" />
            ) : (
              <ArrowDownToLine aria-hidden="true" />
            )}
          </span>
        )}
      </button>
    </nav>
  );
}
