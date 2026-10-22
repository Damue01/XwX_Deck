export interface StorageMigrationProgress {
  readonly phase: 'scanning' | 'backup' | 'merging' | 'complete';
  readonly percent: number;
  readonly completedFiles: number;
  readonly totalFiles: number;
}
