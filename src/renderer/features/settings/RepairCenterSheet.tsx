import { Dialog } from '@base-ui/react/dialog';
import * as React from 'react';
import { ChevronRight, LoaderCircle, X } from 'lucide-react';

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
  const [open, setOpen] = React.useState(false);

  const openReset = React.useCallback(() => {
    setOpen(false);
    window.setTimeout(onOpenReset, 180);
  }, [onOpenReset]);

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
                <Dialog.Description className="sr-only">清理本地缓存或重新初始化配置</Dialog.Description>
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
                  <h3>完全重置</h3>
                  <p>删除全部本地数据；确认时可同时删除 Claude / ChatGPT 配置。</p>
                </span>
                <button
                  type="button"
                  className="btn repair-reset-button"
                  id="resetApplication"
                  onClick={openReset}
                >
                  完全重置
                </button>
              </section>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
