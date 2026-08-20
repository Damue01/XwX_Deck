import * as React from 'react';
import type { CodexEnhancementsSnapshot } from '@/bridge/types';
import { useConfirm, useConfirmChecked } from '@/components/ui/confirm-dialog';
import { Toggle } from '@/features/shell/Toggle';
import { showToast } from '@/lib/toast';

interface Props {
  readonly enhancements: CodexEnhancementsSnapshot;
  readonly onUpdate: (patch: Record<string, unknown>) => Promise<CodexEnhancementsSnapshot>;
  readonly onAfterUpdate?: () => void;
}

function historyResultText(
  history: CodexEnhancementsSnapshot['history'] | undefined,
  enabled: boolean
): string {
  if (!history) return enabled ? '已开启会话历史管理' : '已关闭会话历史管理';
  const locked = history.skippedLockedJsonlFiles + history.skippedLockedStateDbs;
  if (history.skippedReason === 'live_not_target') {
    return '当前 ChatGPT 配置未使用 xwx_deck，未迁移会话';
  }
  if (history.skippedReason === 'locked_history') {
    return `${locked} 项历史正在被 ChatGPT 使用，XwX Deck 稍后会自动重试`;
  }
  if (history.skippedReason === 'restore_deferred') {
    return enabled
      ? 'ChatGPT 正在运行；已开启管理，完全退出 ChatGPT 后自动迁移'
      : 'ChatGPT 正在运行；完全退出后自动恢复迁移前分类';
  }
  if (history.skippedReason === 'no_matching_history') {
    return '现有本地会话已经归入 xwx_deck';
  }
  if (history.skippedReason === 'no_backup_ledger') {
    return '没有可恢复的迁移前分类记录';
  }
  if (history.skippedReason === 'nothing_to_restore') {
    return '会话已经恢复为迁移前的分类';
  }
  const files = enabled ? history.migratedJsonlFiles : history.restoredJsonlFiles;
  const rows = enabled ? history.migratedStateRows : history.restoredStateRows;
  const skipped = locked ? `；另有 ${locked} 项正在使用，稍后自动重试` : '';
  return enabled
    ? `已迁移 ${files} 个会话文件、${rows} 条侧边栏索引到 xwx_deck${skipped}`
    : `已恢复 ${files} 个会话文件、${rows} 条侧边栏索引${skipped}`;
}

export function CodexEnhancements({ enhancements, onUpdate, onAfterUpdate }: Props): React.ReactElement {
  const [busyAuth, setBusyAuth] = React.useState(false);
  const [busyHistory, setBusyHistory] = React.useState(false);
  const confirm = useConfirm();
  const confirmChecked = useConfirmChecked();

  const handleAuth = React.useCallback(async () => {
    if (busyAuth) return;
    const enabled = !enhancements.preserveOfficialLogin;
    setBusyAuth(true);
    try {
      await onUpdate({ preserveOfficialLogin: enabled });
      showToast(enabled ? '已开启保留官方登录' : '已关闭保留官方登录');
      onAfterUpdate?.();
    } catch {
      showToast('无法更新 ChatGPT 官方登录设置', 'error');
    } finally {
      setBusyAuth(false);
    }
  }, [busyAuth, enhancements.preserveOfficialLogin, onAfterUpdate, onUpdate]);

  const handleHistory = React.useCallback(async () => {
    if (busyHistory) return;
    const enabled = !enhancements.unifySessionHistory;
    let restoreExisting = false;

    if (enabled) {
      const accepted = await confirm({
        title: '管理已有会话？',
        body: '已有会话将归入 xwx_deck，切换服务后仍可见。操作前会备份。',
        confirmText: '开启'
      });
      if (!accepted) return;
    } else if (enhancements.hasHistoryBackup) {
      const result = await confirmChecked({
        title: '停止管理会话？',
        body: '停止后不再自动迁移。可同时恢复迁移前分类。',
        checkboxLabel: '恢复迁移前分类',
        checkboxDefaultChecked: true,
        confirmText: '关闭'
      });
      if (!result.confirmed) return;
      restoreExisting = result.checked;
    } else {
      const accepted = await confirm({
        title: '停止管理会话？',
        body: '停止后不再自动迁移，现有分类保持不变。',
        confirmText: '关闭'
      });
      if (!accepted) return;
    }

    setBusyHistory(true);
    try {
      const next = await onUpdate({
        unifySessionHistory: enabled,
        migrateExisting: enabled,
        restoreExisting
      });
      showToast(historyResultText(next.history, enabled));
      onAfterUpdate?.();
    } catch {
      showToast('无法更新 ChatGPT 会话历史设置', 'error');
    } finally {
      setBusyHistory(false);
    }
  }, [
    busyHistory,
    confirm,
    confirmChecked,
    enhancements.hasHistoryBackup,
    enhancements.unifySessionHistory,
    onAfterUpdate,
    onUpdate
  ]);

  return (
    <div className="group">
      <div className="group-label"><span className="eyebrow">ChatGPT 应用增强</span></div>
      <div className="field-row">
        <span className="fr-label">保留官方登录</span>
        <div className="fr-value">
          <Toggle
            id="codexAuthToggle"
            checked={enhancements.preserveOfficialLogin === true}
            busy={busyAuth}
            ariaLabel="切换第三方服务商时保留现有的 OAuth 或 OpenAI API Key"
            title="适用于 ChatGPT OAuth 和 OpenAI API Key"
            onToggle={handleAuth}
          />
        </div>
      </div>
      <div className="field-row">
        <span className="fr-label">管理会话历史</span>
        <div className="fr-value">
          <Toggle
            id="codexHistoryToggle"
            checked={enhancements.unifySessionHistory === true}
            busy={busyHistory}
            ariaLabel="管理 ChatGPT 本地会话分类"
            onToggle={handleHistory}
          />
        </div>
      </div>
    </div>
  );
}
