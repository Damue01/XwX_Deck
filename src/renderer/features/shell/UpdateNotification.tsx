import * as React from 'react';
import { useBridge } from '@/bridge/store';
import { closeToast, showErrorToast, showToast } from '@/lib/toast';
import { userErrorMessage } from '@/lib/errors';

const MAX_RELEASE_NOTE_LINES = 5;
const MAX_RELEASE_NOTE_LENGTH = 280;

export function UpdateNotification(): null {
  const bridge = useBridge();
  const notifiedSignature = React.useRef('');
  const update = bridge.updateState;

  React.useEffect(() => {
    const version = update?.targetVersion;
    if (!version || !update.updateAvailable || update.status !== 'available') return;

    const description = conciseReleaseNotes(update.releaseNotes);
    const signature = `${version}\u0000${description}`;
    if (notifiedSignature.current === signature) return;
    notifiedSignature.current = signature;

    const id = `xwx-deck-update-${version}`;
    showToast(`XwX Deck ${version} 可更新`, 'info', id, {
      description,
      timeout: 5_000,
      actionProps: {
        type: 'button',
        children: '立即下载',
        'aria-label': `下载 XwX Deck ${version}`,
        onClick: () => {
          closeToast(id);
          void bridge.api.downloadUpdate()
            .then(next => {
              bridge.patch({ updateState: next });
              if (next.status === 'error') showToast('更新下载失败', 'error', undefined, {
                description: userErrorMessage(next.error, '请检查网络后重试。'),
                timeout: 8_000
              });
            })
            .catch(error => showErrorToast('更新下载失败', error, undefined, { description: '请检查网络后重试。' }));
        }
      }
    });
  }, [bridge.api, bridge.patch, update?.releaseNotes, update?.status, update?.targetVersion, update?.updateAvailable]);

  React.useEffect(() => {
    const version = update?.targetVersion;
    if (!version || update.status === 'available') return;
    closeToast(`xwx-deck-update-${version}`);
  }, [update?.status, update?.targetVersion]);

  return null;
}

function conciseReleaseNotes(value: string | undefined): string {
  const fallback = '新版本已准备好；详细内容将在有更新说明时显示。';
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
