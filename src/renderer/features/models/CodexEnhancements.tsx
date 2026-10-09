import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import type { CodexEnhancementsSnapshot } from '@/bridge/types';
import { useConfirm, useConfirmChecked } from '@/components/ui/confirm-dialog';
import { Toggle } from '@/features/shell/Toggle';
import { showErrorToast, showToast } from '@/lib/toast';

interface Props {
  readonly enhancements: CodexEnhancementsSnapshot;
  readonly onUpdate: (patch: Record<string, unknown>) => Promise<CodexEnhancementsSnapshot>;
  readonly onAfterUpdate?: () => void;
}

function historyResultText(
  history: CodexEnhancementsSnapshot['history'] | undefined,
  enabled: boolean
): string {
  if (!history) return enabled ? t('已开启会话历史管理') : t('已关闭会话历史管理');
  const locked = history.skippedLockedJsonlFiles + history.skippedLockedStateDbs;
  if (history.skippedReason === 'live_not_target') {
    return t('当前 ChatGPT 配置未使用 xwx_deck，未迁移会话');
  }
  if (history.skippedReason === 'locked_history') {
    return t("{0} 项历史正在被 ChatGPT 使用，XwX Deck 稍后会自动重试", locked);
  }
  if (history.skippedReason === 'restore_deferred') {
    return enabled
      ? t('ChatGPT 正在运行；已开启管理，完全退出 ChatGPT 后自动迁移')
      : t('ChatGPT 正在运行；完全退出后自动恢复迁移前分类');
  }
  if (history.skippedReason === 'no_matching_history') {
    return t('没有需要迁移的现有会话');
  }
  if (history.skippedReason === 'no_backup_ledger') {
    return t('没有可恢复的迁移前分类记录');
  }
  if (history.skippedReason === 'nothing_to_restore') {
    return t('会话已经恢复为迁移前的分类');
  }
  const files = enabled ? history.migratedJsonlFiles : history.restoredJsonlFiles;
  const rows = enabled ? history.migratedStateRows : history.restoredStateRows;
  const skipped = locked ? t("；另有 {0} 项正在使用，稍后自动重试", locked) : '';
  return enabled
    ? t("已迁移 {0} 个会话文件、{1} 条侧边栏索引到 xwx_deck{2}", files, rows, skipped)
    : t("已恢复 {0} 个会话文件、{1} 条侧边栏索引{2}", files, rows, skipped);
}

export function CodexEnhancements({ enhancements, onUpdate, onAfterUpdate }: Props): React.ReactElement {
  useLanguage();
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
      showToast(enabled ? t('已开启保留官方登录') : t('已关闭保留官方登录'));
      onAfterUpdate?.();
    } catch (error) {
      showErrorToast(t('无法更新 ChatGPT 官方登录设置'), error);
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
        title: t('管理已有会话？'),
        body: t('已有会话将归入 xwx_deck，切换服务后仍可见。操作前会备份。'),
        confirmText: t('开启')
      });
      if (!accepted) return;
    } else {
      // The cached backup flag may predate a background migration. Let the
      // restore operation check the current ledger instead of hiding the choice.
      const result = await confirmChecked({
        title: t('停止管理会话？'),
        body: t('停止后不再自动迁移。可同时恢复迁移前分类。'),
        checkboxLabel: t('恢复迁移前分类'),
        checkboxDefaultChecked: true,
        confirmText: t('关闭')
      });
      if (!result.confirmed) return;
      restoreExisting = result.checked;
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
    } catch (error) {
      showErrorToast(t('无法更新 ChatGPT 会话历史设置'), error);
    } finally {
      setBusyHistory(false);
    }
  }, [
    busyHistory,
    confirm,
    confirmChecked,
    enhancements.unifySessionHistory,
    onAfterUpdate,
    onUpdate
  ]);

  return (
    <div className="group">
      <div className="group-label"><span className="eyebrow">{t("ChatGPT 应用增强")}</span></div>
      <div className="field-row">
        <span className="fr-label">{t("保留官方登录")}</span>
        <div className="fr-value">
          <Toggle
            id="codexAuthToggle"
            checked={enhancements.preserveOfficialLogin === true}
            busy={busyAuth}
            ariaLabel={t("切换第三方模型服务时保留现有的 OAuth 或 OpenAI API Key")}
            title={t("适用于 ChatGPT OAuth 和 OpenAI API Key")}
            onToggle={handleAuth}
          />
        </div>
      </div>
      <div className="field-row">
        <span className="fr-label">{t("管理会话历史")}</span>
        <div className="fr-value">
          <Toggle
            id="codexHistoryToggle"
            checked={enhancements.unifySessionHistory === true}
            busy={busyHistory}
            ariaLabel={t("管理 ChatGPT 本地会话分类")}
            onToggle={handleHistory}
          />
        </div>
      </div>
    </div>
  );
}
