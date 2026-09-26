import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xwx-reset-worker-'));
const userDataDir = path.join(root, 'xwx-deck');
const resultFile = path.join(root, 'relaunched.txt');
const relaunchScript = path.join(root, 'relaunch.cjs');
const workerPath = path.resolve('dist/application-reset-worker.js');
try {
  await fs.mkdir(path.join(userDataDir, 'Cache'), { recursive: true });
  await fs.writeFile(path.join(userDataDir, 'settings.json'), '{}');
  await fs.writeFile(path.join(userDataDir, 'Cache', 'entry'), 'cache');
  await fs.writeFile(relaunchScript, `require('fs').writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({
    started: true, nodeMode: process.env.ELECTRON_RUN_AS_NODE, portable: process.env.PORTABLE_EXECUTABLE_FILE,
    resetJob: process.env.XWX_APPLICATION_RESET_JOB
  }))`);

  const manager = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 700)'], {
    stdio: 'ignore'
  });
  await new Promise((resolve, reject) => {
    manager.once('spawn', resolve);
    manager.once('error', reject);
  });
  const worker = spawn(process.execPath, [workerPath], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      PORTABLE_EXECUTABLE_FILE: 'previous portable executable',
      XWX_APPLICATION_RESET_JOB: JSON.stringify({
        managerPid: manager.pid,
        userDataDir,
        executable: process.execPath,
        relaunchArgs: [relaunchScript],
        request: { resetClientConfigs: false }
      })
    }
  });
  await new Promise((resolve, reject) => {
    worker.once('message', message => {
      assert.equal(message.type, 'ready');
      resolve();
    });
    worker.once('error', reject);
    worker.once('exit', code => reject(new Error(`Worker exited before ready: ${code}`)));
  });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await fs.readFile(path.join(userDataDir, 'settings.json'), 'utf8'), '{}',
    'reset must wait until the manager exits');
  const exitCode = await new Promise((resolve, reject) => {
    worker.once('exit', resolve);
    worker.once('error', reject);
  });
  assert.equal(exitCode, 0);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await fs.access(resultFile).then(() => true, () => false)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.deepEqual(JSON.parse(await fs.readFile(resultFile, 'utf8')), { started: true });
  await assert.rejects(fs.access(path.join(userDataDir, 'settings.json')));
  await assert.rejects(fs.access(path.join(userDataDir, 'Cache', 'entry')));
  console.log('PASS reset worker waits for manager exit, clears isolated profile, then relaunches');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
