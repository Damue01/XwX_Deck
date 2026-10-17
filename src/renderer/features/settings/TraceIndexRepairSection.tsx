import { t, useLanguage } from '@/lib/i18n';
import * as React from 'react';
import type { TraceIndexRepairPlan } from '@/bridge/types';
import { useBridge } from '@/bridge/store';
import { showErrorToast, showToast } from '@/lib/toast';

export function TraceIndexRepairSection(): React.ReactElement {
  useLanguage();
  const bridge = useBridge();
  const [indexPlan, setIndexPlan] = React.useState<TraceIndexRepairPlan | null>(null);
  const [indexBusy, setIndexBusy] = React.useState(false);
  const repairIndex = async (apply: boolean): Promise<void> => {
    setIndexBusy(true);
    try {
      if (apply && indexPlan) {
        const result = await bridge.api.applyTraceIndexRepair(indexPlan.indexSha256);
        showToast(t("已恢复 {0} 个 Trace 片段，原始记录保持不变。", result.recoveredSessions), 'success');
        setIndexPlan(null);
      } else {
        setIndexPlan(await bridge.api.inspectTraceIndexRepair());
      }
    } catch (error) {
      showErrorToast(t('Trace 索引修复失败'), error);
      setIndexPlan(null);
    } finally {
      setIndexBusy(false);
    }
  };
  const needsRepair = indexPlan ? (indexPlan.needsRepair ?? (indexPlan.candidates.length > 0 || indexPlan.indexStatus === 'invalid' || indexPlan.missingIndexedFiles.length > 0)) : false;
  const malformed = indexPlan?.candidates.reduce((total, item) => total + item.malformedRecords, 0) ?? 0;
  return <section className="repair-action-section">
    <span className="repair-action-copy">
      <h3>{t("Trace 记录")}</h3>
      {!indexPlan && <p>{t("检查记录列表和用量统计。")}</p>}
      {indexPlan && <p role="status">{needsRepair
        ? t("索引{0}，可重建 {1} 个片段{2}。", indexPlan.indexStatus === 'invalid' ? '损坏' : indexPlan.indexStatus === 'missing' ? '缺失' : '需要更新', indexPlan.candidates.length, indexPlan.missingIndexedFiles.length ? `，缺失文件 ${indexPlan.missingIndexedFiles.length} 个` : '')
        : indexPlan.jsonlFiles ? t('记录正常。') : t('暂无记录。')}{malformed > 0 && t(" {0} 条无效记录无法恢复，原文件保留。", malformed)}</p>}
    </span>
    <button type="button" className="btn repair-action-button" id={needsRepair ? 'applyTraceIndexRepair' : 'inspectTraceIndex'} aria-label={needsRepair ? t('备份并修复 Trace 索引') : t('检查 Trace 记录')} aria-busy={indexBusy || undefined} disabled={indexBusy} onClick={() => void repairIndex(needsRepair)}>
      {indexBusy ? needsRepair ? t('修复中') : t('检查中') : needsRepair ? t('修复') : t('检查')}
    </button>
  </section>;
}
