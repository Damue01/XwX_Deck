import * as fs from 'fs/promises';
import * as path from 'path';
import { writeFileAtomic } from '../shared/fsx';
import type { LifecycleNotice } from '../../shared/lifecycleNotice';

interface ExitRecoveryReport {
  readonly version: 1;
  readonly managerPid: number;
  readonly status: 'pending' | 'complete' | 'failed';
  readonly issue?: 'configuration' | 'gateway-stop';
  readonly at: string;
}

const reportPath = (userDataDir: string) => path.join(userDataDir, 'exit-recovery-result.json');

export async function beginExitRecoveryReport(userDataDir: string, managerPid: number): Promise<void> {
  await writeReport(userDataDir, { version: 1, managerPid, status: 'pending', at: new Date().toISOString() });
}

/** The guardian owns completion. An old guardian must not finish a newer exit. */
export async function finishExitRecoveryReport(
  userDataDir: string, managerPid: number, failed: boolean, issue: ExitRecoveryReport['issue'] = 'configuration'
): Promise<void> {
  const report = await readReport(userDataDir);
  if (!report || report.managerPid !== managerPid) return;
  await writeReport(userDataDir, { ...report, status: failed ? 'failed' : 'complete', issue: failed ? issue : undefined, at: new Date().toISOString() });
}

export async function readExitRecoveryNotice(userDataDir: string): Promise<LifecycleNotice | undefined> {
  const report = await readReport(userDataDir);
  if (!report || report.status === 'complete') return;
  if (report.status === 'failed' && report.issue === 'gateway-stop') return {
    message: '上次退出的后台停止未确认',
    description: '退出时未能确认后台进程已停止。请查看当前代理状态；若仍有端口或连接冲突，完全退出重复运行的 Deck 实例，再重新打开。运行日志可帮助定位停止失败的原因。',
    type: 'error',
    persistent: true,
    action: 'stop-trace', actionLabel: '恢复直连配置', secondaryAction: 'repair'
  };
  // A historical configuration result is not evidence that the current
  // connection is broken. Startup re-reads and repairs the live configuration;
  // if that fails, the controller exposes the concrete current error instead.
  return;
}

/**
 * A clean startup has re-read and repaired the current client configuration,
 * so an older configuration warning no longer describes the current state.
 * Gateway stop failures remain visible until they are handled explicitly.
 */
export async function completeExitRecoveryAfterVerifiedStartup(userDataDir: string): Promise<boolean> {
  const report = await readReport(userDataDir);
  if (!report || report.status === 'complete') return false;
  if (report.status === 'failed' && report.issue === 'gateway-stop') return false;
  await writeReport(userDataDir, {
    ...report,
    status: 'complete',
    issue: undefined,
    at: new Date().toISOString()
  });
  return true;
}

async function readReport(userDataDir: string): Promise<ExitRecoveryReport | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(reportPath(userDataDir), 'utf8'));
    if (value?.version !== 1 || !Number.isSafeInteger(value.managerPid) || value.managerPid <= 0
      || !['pending', 'complete', 'failed'].includes(value.status) || typeof value.at !== 'string') return;
    return value;
  } catch { return; }
}

async function writeReport(userDataDir: string, report: ExitRecoveryReport): Promise<void> {
  await fs.mkdir(userDataDir, { recursive: true });
  // No paths, upstream URLs, credentials or raw exception messages in this report.
  await writeFileAtomic(reportPath(userDataDir), `${JSON.stringify(report)}\n`);
}
