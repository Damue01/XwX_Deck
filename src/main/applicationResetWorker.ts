import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { applicationRelaunchEnvironment, performApplicationResetAtStartup, type ApplicationResetRequest } from './app/applicationReset';

interface ResetJob {
  readonly managerPid: number;
  readonly userDataDir: string;
  readonly executable: string;
  readonly relaunchArgs: string[];
  readonly waitForRecovery?: boolean;
  readonly request: ApplicationResetRequest;
}

async function main(): Promise<void> {
  const job = JSON.parse(process.env.XWX_APPLICATION_RESET_JOB ?? 'null') as ResetJob | null;
  if (!job || !Number.isSafeInteger(job.managerPid) || job.managerPid < 1
    || !path.isAbsolute(job.userDataDir) || !path.isAbsolute(job.executable)
    || !Array.isArray(job.relaunchArgs) || !job.relaunchArgs.every(value => typeof value === 'string')
    || typeof job.request?.resetClientConfigs !== 'boolean') {
    throw new Error('无效的重置任务。');
  }
  delete process.env.XWX_APPLICATION_RESET_JOB;
  process.send?.({ type: 'ready' });
  process.disconnect?.();

  const stopped = await waitForProcessExit(job.managerPid, 30_000);
  if (!stopped) {
    recordFailure(job.userDataDir, '旧版 XwX Deck 未能退出；为保护正在使用的数据，重置未执行。');
    return;
  }
  const recovered = !job.waitForRecovery || await waitForRecoveryReport(job.userDataDir, job.managerPid);
  if (!recovered) {
    recordFailure(job.userDataDir, '退出恢复未完成；为保留客户端配置的恢复依据，重置未执行。');
  }
  // The main process can disappear just before its Chromium children release
  // profile files. This worker uses Node mode and never opens the profile.
  await new Promise(resolve => setTimeout(resolve, 750));
  if (recovered) {
    try {
      const result = performApplicationResetAtStartup(job.userDataDir, job.request, {
        allowedParentDir: path.dirname(job.userDataDir)
      });
      const skipped = [...result.skippedClientFiles, ...result.skippedDataPaths];
      if (skipped.length) recordFailure(job.userDataDir, `未清理的路径：${skipped.join('、')}`);
    } catch (error) {
      recordFailure(job.userDataDir, error instanceof Error ? error.message : String(error));
    }
  }
  const child = spawn(job.executable, job.relaunchArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: applicationRelaunchEnvironment()
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', error => {
      recordFailure(job.userDataDir, `重置已结束，但重新启动失败：${error.message}`);
      reject(error);
    });
  });
  child.unref();
}

async function waitForRecoveryReport(userDataDir: string, managerPid: number): Promise<boolean> {
  const reportPath = path.join(userDataDir, 'exit-recovery-result.json');
  const readyPath = path.join(userDataDir, 'gateway', 'exit-recovery.ready');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const report = await fs.promises.readFile(reportPath, 'utf8').then(
      value => JSON.parse(value) as { managerPid?: number; status?: string }, () => undefined
    ).catch(() => undefined);
    const guardianReady = await fs.promises.access(readyPath).then(() => true, () => false);
    if (report?.managerPid === managerPid && !guardianReady) {
      if (report.status === 'complete') return true;
      if (report.status === 'failed') return false;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

function recordFailure(userDataDir: string, reason: string): void {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'reset-failure.json'),
      JSON.stringify({ at: new Date().toISOString(), reason }, null, 2), 'utf8');
  } catch { /* No profile can be opened to report the failure. */ }
}

void main().catch(error => {
  console.error('[xwx-deck] application reset worker failed', error);
  process.exitCode = 1;
});
