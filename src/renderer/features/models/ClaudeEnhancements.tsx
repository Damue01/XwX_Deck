import * as React from 'react';
import type { ClaudeDesktopSyncSnapshot } from '@/bridge/types';
import { Toggle } from '@/features/shell/Toggle';
import { showToast } from '@/lib/toast';

interface Props {
  readonly sync: ClaudeDesktopSyncSnapshot;
  readonly onUpdate: (enabled: boolean) => Promise<ClaudeDesktopSyncSnapshot>;
}

export function ClaudeEnhancements({ sync, onUpdate }: Props): React.ReactElement {
  const [busy, setBusy] = React.useState(false);

  const handleToggle = React.useCallback(async () => {
    if (busy) return;
    const enabled = !sync.enabled;
    setBusy(true);
    try {
      await onUpdate(enabled);
      showToast(enabled ? '已开启 Desktop 同步，正在后台应用' : '已关闭 Desktop 同步');
    } catch {
      showToast('无法更新 Claude Desktop 同步设置', 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, onUpdate, sync.enabled]);

  return (
    <div className="group">
      <div className="group-label"><span className="eyebrow">Claude 应用增强</span></div>
      <div className="field-row">
        <span className="fr-label">同步配置到 Desktop 版本</span>
        <div className="fr-value">
          <Toggle
            id="claudeDesktopSyncToggle"
            checked={sync.enabled}
            busy={busy}
            ariaLabel="同步配置到 Desktop 版本"
            onToggle={handleToggle}
          />
        </div>
      </div>
    </div>
  );
}
