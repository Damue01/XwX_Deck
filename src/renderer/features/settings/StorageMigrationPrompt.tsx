import * as React from 'react';
import { useBridge } from '@/bridge/store';
import { showErrorToast, showToast } from '@/lib/toast';
import { normalizeErrorMessage } from '../../../shared/errors';
import type { StorageMigrationProgress } from '../../../shared/storageMigration';
import { DataMigrationProgress } from './DataMigrationProgress';

const INITIAL: StorageMigrationProgress = { phase: 'scanning', percent: 0, completedFiles: 0, totalFiles: 0 };
export function StorageMigrationPrompt(): React.ReactElement {
  const { api, booted } = useBridge();
  const inspected = React.useRef(false);
  const alive = React.useRef(true);
  const [destination, setDestination] = React.useState('');
  const [progress, setProgress] = React.useState<StorageMigrationProgress | null>(null);
  const [failure, setFailure] = React.useState('');
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const migrate = React.useCallback(async () => {
    setFailure(''); setProgress(INITIAL);
    const off = api.onStorageMigrationProgress?.(value => { if (alive.current) setProgress(value); });
    try {
      const result = await api.migrateStorage!();
      const pending = (result as typeof result & { storageMigrationResult?: { cleanupPending?: number } }).storageMigrationResult?.cleanupPending ?? 0;
      if (pending > 0) showToast(`数据已迁移，${pending} 个发生变化或被占用的原文件已保留。`, 'warning');
      if (alive.current) setProgress(null);
    } catch (error) { if (alive.current) setFailure(normalizeErrorMessage(error)); }
    finally { off?.(); }
  }, [api]);
  React.useEffect(() => {
    if (!booted || inspected.current || !api.inspectStorageMigration || !api.migrateStorage) return;
    const inspect = async () => {
      if (inspected.current || document.querySelector('#onboarding-setup')) return;
      inspected.current = true;
      try {
        const plan = await api.inspectStorageMigration!();
        if (plan?.deferred) { inspected.current = false; return; }
        if (!plan || !alive.current) return;
        setDestination(plan.destination); await migrate();
      } catch (error) { if (alive.current) showErrorToast('数据目录迁移未完成', error); }
    };
    const observer = new MutationObserver(() => { void inspect(); });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setInterval(() => { void inspect(); }, 2000);
    void inspect();
    return () => { clearInterval(timer); observer.disconnect(); };
  }, [api, booted, migrate]);
  return <DataMigrationProgress title={failure ? '数据迁移未完成' : '正在整理数据目录'} description={`Trace 和运行日志迁移至 ${destination}。校验完成后自动切换，配置和自定义目录保留。`} progress={progress} phase="正在迁移并校验数据">
    {failure && <><p className="provider-field-error" role="alert">{failure}</p><div className="data-migration-actions">
      <button className="btn" onClick={() => setProgress(null)}>稍后处理</button>
      <button className="btn primary" onClick={() => { void migrate(); }}>重试迁移</button>
    </div></>}
  </DataMigrationProgress>;
}
