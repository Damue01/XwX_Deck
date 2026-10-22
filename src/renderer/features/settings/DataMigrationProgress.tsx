import type React from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Progress, ProgressIndicator, ProgressLabel, ProgressTrack } from '@/components/ui/progress';
import type { StorageMigrationProgress } from '../../../shared/storageMigration';

export function DataMigrationProgress({ title, description, progress, phase, children }: {
  title: string; description: string; progress: StorageMigrationProgress | null; phase: string; children?: React.ReactNode;
}): React.ReactElement {
  return <Dialog.Root open={progress !== null}>
    <Dialog.Portal>
      <Dialog.Backdrop className="setup-card-backdrop" />
      <Dialog.Popup className="configuration-dialog data-migration-dialog" id="data-migration-dialog">
        <header className="configuration-header"><Dialog.Title>{title}</Dialog.Title></header>
        <div className="data-migration-body">
          <Dialog.Description>{description}</Dialog.Description>
          {progress && <Progress value={progress.phase === 'scanning' ? null : progress.percent}>
            <div className="data-migration-status" role="status">
              <ProgressLabel>{phase}{progress.totalFiles > 0 && <span className="data-migration-count"> · {progress.completedFiles} / {progress.totalFiles}</span>}</ProgressLabel>
              <span>{progress.percent}%</span>
            </div>
            <ProgressTrack><ProgressIndicator /></ProgressTrack>
          </Progress>}
          {children}
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
