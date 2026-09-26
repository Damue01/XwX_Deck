import { Dialog } from '@base-ui/react/dialog';
import * as React from 'react';
import { ChevronRight, LoaderCircle, X } from 'lucide-react';
import type { TraceIndexRepairPlan } from '@/bridge/types';
import { showErrorToast, showToast } from '@/lib/toast';
import { useBridge } from '@/bridge/store';
import {
  DIAGNOSTIC_NOTICE_EVENT,
  OPEN_REPAIR_EVENT,
  clearLastDiagnosticNotice,
  noticeActionLabel,
  readLastDiagnosticNotice,
  runNoticeAction
} from '@/lib/toast';
import { lifecycleFailure, type LifecycleNotice } from '../../../shared/lifecycleNotice';

function subscribeDiagnosticNotices(listener: () => void): () => void {
  window.addEventListener(DIAGNOSTIC_NOTICE_EVENT, listener);
  return () => window.removeEventListener(DIAGNOSTIC_NOTICE_EVENT, listener);
}

interface Props {
  readonly quickRepairBusy: boolean;
  readonly onQuickRepair: () => void;
  readonly onOpenReset: () => void;
}

export function RepairCenterSheet({
  quickRepairBusy,
  onQuickRepair,
  onOpenReset,
}: Props): React.ReactElement {
  const bridge = useBridge();
  const [open, setOpen] = React.useState(false);
  const [indexPlan, setIndexPlan] = React.useState<TraceIndexRepairPlan | null>(null);
  const [indexBusy, setIndexBusy] = React.useState(false);
  const repairIndex = async (apply: boolean): Promise<void> => {
    setIndexBusy(true);
    try {
      if (apply && indexPlan) {
        const result = await bridge.api.applyTraceIndexRepair(indexPlan.indexSha256);
        showToast(`已恢复 ${result.recoveredSessions} 个 Trace 片段，原始记录保持不变。`, 'success');
        setIndexPlan(null);
      } else {
        setIndexPlan(await bridge.api.inspectTraceIndexRepair());
      }
    } catch (error) {
      showErrorToast('Trace 索引修复失败', error);
      setIndexPlan(null);
    } finally {
      setIndexBusy(false);
    }
  };


  const recentNotice = React.useSyncExternalStore(subscribeDiagnosticNotices, readLastDiagnosticNotice);
  const currentNotice = bridge.runtime?.lastError
    ? lifecycleFailure(bridge.runtime.lastError, '恢复运行状态')
    : bridge.runtime?.connectionNotice ?? bridge.runtime?.lifecycleNotice;
  const notices = [currentNotice, recentNotice]
    .filter((notice, index, values) => notice && values.findIndex(item =>
      item?.message === notice.message && item?.description === notice.description) === index);

  React.useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_REPAIR_EVENT, show);
    return () => window.removeEventListener(OPEN_REPAIR_EVENT, show);
  }, []);

  const openReset = React.useCallback(() => {
    setOpen(false);
    window.setTimeout(onOpenReset, 180);
  }, [onOpenReset]);

  const renderNoticeActions = (notice: LifecycleNotice): React.ReactNode => {
    const actions = [notice.action, notice.secondaryAction]
      .filter((action, index, values): action is NonNullable<LifecycleNotice['action']> =>
        !!action && action !== 'repair' && values.indexOf(action) === index);
    if (actions.length === 0) return null;
    return (
      <span className="repair-notice-actions">
        {actions.map((action, index) => (
          <button
            type="button"
            className="btn repair-action-button"
            key={action}
            onClick={() => {
              clearLastDiagnosticNotice();
              setOpen(false);
              runNoticeAction(action);
            }}
          >
            {(index === 0 ? notice.actionLabel : notice.secondaryActionLabel) ?? noticeActionLabel(action)}
          </button>
        ))}
      </span>
    );
  };

  return (
    <section className="group repair-entry-group">
      <div className="group-label"><span className="eyebrow">支持</span></div>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger
          render={(
            <button
              type="button"
              className="repair-entry"
              id="repairCenterTrigger"
            />
          )}
        >
          <span className="repair-entry-title">诊断与修复</span>
          <ChevronRight className="ic repair-entry-chevron" aria-hidden="true" />
        </Dialog.Trigger>

        <Dialog.Portal>
          <Dialog.Backdrop className="repair-sheet-backdrop" />
          <Dialog.Popup className="repair-sheet-popup" id="repairCenterSheet">
            <header className="repair-sheet-header">
              <span className="repair-sheet-heading">
                <Dialog.Title>诊断与修复</Dialog.Title>
                <Dialog.Description className="sr-only">查看当前问题或重置本地数据</Dialog.Description>
              </span>
              <Dialog.Close
                type="button"
                className="repair-sheet-close"
                id="repairCenterClose"
                aria-label="关闭诊断与修复"
              >
                <X className="ic" aria-hidden="true" />
              </Dialog.Close>
            </header>

            <div className="repair-sheet-body">
              {notices.length > 0 ? (
                <section className="repair-notices" aria-label="问题提示">
                  <p className="repair-recent-label">问题提示</p>
                  {notices.map((notice, index) => notice ? (
                    <article className="repair-notice" key={`${notice.message}:${notice.description}`}>
                      <span className="repair-action-copy">
                        <h3>{index === 0 && currentNotice ? '当前问题' : '最近一次失败'}：{notice.message}</h3>
                        {notice.description ? <p>{notice.description}</p> : null}
                      </span>
                      {renderNoticeActions(notice)}
                      {notice === recentNotice && notice !== currentNotice ? (
                        <button type="button" className="repair-notice-dismiss"
                          aria-label="移除最近一次失败"
                          onClick={clearLastDiagnosticNotice}>
                          <X className="ic" aria-hidden="true" />
                        </button>
                      ) : null}
                    </article>
                  ) : null)}
                </section>
              ) : null}
              <section className="repair-action-section">
                <span className="repair-action-copy">
                  <h3>Trace 索引修复</h3>
                  <p>检查缺失或损坏的索引。修复前请关闭 Gateway；原索引会备份，历史记录不会删除。</p>
                  {indexPlan ? <p role="status">索引{indexPlan.indexStatus === 'valid' ? '可用' : indexPlan.indexStatus === 'missing' ? '缺失' : '损坏'}，可恢复 {indexPlan.candidates.length} 个片段，缺失文件 {indexPlan.missingIndexedFiles.length} 个。</p> : null}
                </span>
                <button type="button" className="btn repair-action-button" id="inspectTraceIndex" disabled={indexBusy} onClick={() => void repairIndex(false)}>
                  {indexBusy ? '正在处理' : '检查索引'}
                </button>
                {indexPlan && (indexPlan.candidates.length > 0 || indexPlan.indexStatus !== 'valid') ? (
                  <button type="button" className="btn repair-action-button" id="applyTraceIndexRepair" disabled={indexBusy} onClick={() => void repairIndex(true)}>备份并修复</button>
                ) : null}
              </section>
              <section className="repair-action-section">
                <span className="repair-action-copy">
                  <h3>快速修复</h3>
                  <p>删除 XwX Deck 缓存（含模型目录）和更新残留，不影响设置、Trace 或客户端配置。</p>
                </span>
                <button
                  type="button"
                  className="btn repair-action-button"
                  id="quickRepairApplication"
                  disabled={quickRepairBusy}
                  onClick={onQuickRepair}
                >
                  {quickRepairBusy
                    ? <LoaderCircle className="ic repair-action-spinner" aria-hidden="true" />
                    : null}
                  <span>{quickRepairBusy ? '正在清理' : '清理缓存'}</span>
                </button>
              </section>

              <section className="repair-action-section">
                <span className="repair-action-copy">
                  <h3>重置 XwX Deck</h3>
                  <p>删除 Deck 设置、缓存、Trace 记录和日志，重新开始。Claude 与 ChatGPT 配置默认保留。</p>
                </span>
                <button
                  type="button"
                  className="btn repair-reset-button"
                  id="resetApplication"
                  onClick={openReset}
                >
                  重置
                </button>
              </section>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
