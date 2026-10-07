import * as React from 'react';
import type { TraceIndexRepairPlan } from '@/bridge/types';
import { useBridge } from '@/bridge/store';
import { showErrorToast, showToast } from '@/lib/toast';

export function TraceIndexRepairSection(): React.ReactElement {
  const bridge = useBridge();
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
  return (
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
  );
}
