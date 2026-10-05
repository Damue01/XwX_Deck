import * as React from 'react';
import { useBridge } from '@/bridge/store';
import type { XwXDeckUpdateState } from '@/bridge/types';
import { closeToast, showToast } from '@/lib/toast';
import { updateFailureDescription } from '../../../shared/updateFeedback';

const MAX_RELEASE_NOTE_LINES = 5;
const MAX_RELEASE_NOTE_LENGTH = 280;

export function announceAvailableUpdate(
  update: XwXDeckUpdateState,
  download: () => Promise<XwXDeckUpdateState>,
  onDownloaded: (next: XwXDeckUpdateState) => void
): void {
  const version = update.targetVersion;
  if (update?.background || !version || !update.updateAvailable || update.status !== 'available') return;
  const id = `xwxdeck-update-${version}`;
  showToast(`XwX Deck ${version} 可更新`, 'info', id, {
    description: conciseReleaseNotes(update.releaseNotes, update.installMode),
    timeout: 5_000,
    actionProps: {
      type: 'button',
      children: '立即下载',
      'aria-label': `下载 XwX Deck ${version}`,
      onClick: () => {
        closeToast(id);
        void download()
          .then(next => {
            onDownloaded(next);
            if (next.status === 'error') showToast('更新下载失败', 'error', undefined, {
              description: updateFailureDescription(next.error),
              timeout: 12_000
            });
          })
          .catch(error => showToast('更新下载失败', 'error', undefined, {
            description: updateFailureDescription(error),
            timeout: 12_000
          }));
      }
    }
  });
}

export function UpdateNotification(): null {
  const bridge = useBridge();
  const notifiedSignature = React.useRef('');
  const update = bridge.updateState;

  React.useEffect(() => {
    const version = update?.targetVersion;
    if (update?.background || !version || !update.updateAvailable || update.status !== 'available') return;

    const description = conciseReleaseNotes(update.releaseNotes, update.installMode);
    const signature = `${version}\u0000${description}`;
    if (notifiedSignature.current === signature) return;
    notifiedSignature.current = signature;

    announceAvailableUpdate(update, () => bridge.api.downloadUpdate(), next => bridge.patch({ updateState: next }));
  }, [bridge.api, bridge.patch, update?.background, update?.releaseNotes, update?.status, update?.targetVersion, update?.updateAvailable]);

  React.useEffect(() => {
    const version = update?.targetVersion;
    if (!version || update.status === 'available') return;
    closeToast(`xwxdeck-update-${version}`);
  }, [update?.status, update?.targetVersion]);

  return null;
}

function conciseReleaseNotes(value: string | undefined, installMode?: string): string {
  const fallback = installMode === 'manual-dmg' ? '下载并校验后，打开 DMG 完成安装。' : '下载完成后重启即可更新。';
  if (!value?.trim()) return fallback;
  const lines = value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, MAX_RELEASE_NOTE_LINES);
  const text = lines.join('\n');
  if (!text) return fallback;
  return text.length > MAX_RELEASE_NOTE_LENGTH
    ? `${text.slice(0, MAX_RELEASE_NOTE_LENGTH - 1).trimEnd()}…`
    : text;
}
