import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  decideNightlyUpdateAction,
  isWithinNightlyWindow,
  nightKey,
  nightlyJitterMs,
  NightlyUpdateScheduler,
  NIGHTLY_IDLE_THRESHOLD_SECONDS,
  NIGHTLY_START_JITTER_MS,
  type NightlyUpdateSnapshot,
  type NightlyUpdaterView
} from '../src/main/update/nightlyUpdate';
import {
  assertPortableUpdateInstallable,
  sweepStalePortableUpdateFiles
} from '../src/main/update/portableUpdate';

const at = (hour: number, minute = 0) => new Date(2026, 8, 30, hour, minute, 0, 0);
const ready: NightlyUpdaterView = {
  status: 'ready', supported: true, installMode: 'automatic', updateAvailable: true, targetVersion: '1.1.7'
};

function snapshot(overrides: Partial<NightlyUpdateSnapshot> = {}): NightlyUpdateSnapshot {
  return {
    now: at(3),
    updater: ready,
    jitterMs: 0,
    systemIdleSeconds: NIGHTLY_IDLE_THRESHOLD_SECONDS,
    busy: false,
    ...overrides
  };
}

export async function testNightlyUpdates(root: string): Promise<void> {
  // Window and slot.
  assert.equal(isWithinNightlyWindow(at(1, 59)), false);
  assert.equal(isWithinNightlyWindow(at(2)), true);
  assert.equal(isWithinNightlyWindow(at(4, 59)), true);
  assert.equal(isWithinNightlyWindow(at(5)), false);
  assert.equal(nightKey(at(3)), '2026-09-30');
  const jitter = nightlyJitterMs('machine-a', at(3));
  assert.equal(jitter, nightlyJitterMs('machine-a', at(4)), 'one slot per machine per night');
  assert.ok(jitter >= 0 && jitter < NIGHTLY_START_JITTER_MS);

  // Policy.
  const action = (overrides: Partial<NightlyUpdateSnapshot>) => decideNightlyUpdateAction(snapshot(overrides)).action;
  assert.equal(action({ now: at(14) }), 'none', 'daytime never installs unattended');
  assert.equal(action({}), 'install');
  assert.equal(action({ systemIdleSeconds: 60 }), 'none', 'someone at the keyboard defers');
  assert.equal(action({ busy: true }), 'none');
  assert.equal(action({ jitterMs: 2 * 60 * 60_000 }), 'none', 'wait for this client\'s slot');
  assert.equal(action({ declinedVersion: '1.1.7' }), 'none', 'a cancelled version is not auto-installed');
  assert.equal(action({ declinedVersion: '1.1.6' }), 'install', 'a newer release is offered again');
  assert.equal(action({ installAttemptNight: '2026-09-30' }), 'none', 'at most one failed install per night');
  assert.equal(action({ installAttemptNight: '2026-09-29' }), 'install');
  assert.equal(action({ updater: { ...ready, installMode: 'manual-dmg' } }), 'none', 'macOS DMG is never unattended');
  assert.equal(action({ updater: { ...ready, supported: false } }), 'none');
  assert.equal(action({ updater: { ...ready, status: 'available' } }), 'download');
  assert.equal(action({ updater: { ...ready, status: 'available' }, downloadAttemptNight: '2026-09-30' }), 'none');
  assert.equal(action({ updater: { ...ready, status: 'downloading' } }), 'none');
  const idle: NightlyUpdaterView = { status: 'portable', supported: true, installMode: 'automatic', updateAvailable: false };
  assert.equal(action({ updater: idle }), 'check');
  assert.equal(action({ updater: idle, lastCheckAt: at(2, 30).getTime() }), 'none', 'one check per night');
  assert.equal(action({ updater: idle, lastCheckAt: at(1).getTime() }), 'check', 'a check before the window does not count');
  assert.equal(action({ updater: { ...idle, status: 'error' }, lastCheckAt: at(2, 30).getTime() }), 'none',
    'a failed check or download waits for the next night');

  // Scheduler chains check -> download -> install within one tick.
  let state: NightlyUpdaterView = idle;
  const calls: string[] = [];
  let installResult: 'started' | 'deferred' = 'deferred';
  let now = at(3);
  let idleSeconds = NIGHTLY_IDLE_THRESHOLD_SECONDS;
  const scheduler = new NightlyUpdateScheduler({
    seed: 'fixture',
    now: () => now,
    updater: () => state,
    check: async () => { calls.push('check'); state = { ...ready, status: 'available' }; },
    download: async () => { calls.push('download'); state = ready; },
    install: async () => {
      calls.push('install');
      return installResult === 'started' ? { kind: 'started' } : { kind: 'deferred', reason: 'conversation in progress' };
    },
    systemIdleSeconds: () => idleSeconds,
    busy: () => false
  });
  // The fixture slot must already be open at 03:00 for the chain assertion.
  now = new Date(at(2).getTime() + nightlyJitterMs('fixture', at(2)) + 60_000);
  await scheduler.tick();
  assert.deepEqual(calls, ['check', 'download', 'install']);
  now = new Date(now.getTime() + 10 * 60_000);
  installResult = 'started';
  await scheduler.tick();
  assert.deepEqual(calls, ['check', 'download', 'install', 'install'], 'a deferral retries later the same night');
  await scheduler.tick();
  assert.equal(calls.length, 4, 'a started (or failed) install is not repeated tonight');

  const declining = new NightlyUpdateScheduler({
    seed: 'fixture', now: () => now, updater: () => ready,
    check: async () => undefined, download: async () => undefined,
    install: async () => { throw new Error('must not install a cancelled version'); },
    systemIdleSeconds: () => idleSeconds, busy: () => false
  });
  declining.decline('1.1.7');
  await declining.tick();

  idleSeconds = 30;
  const active = new NightlyUpdateScheduler({
    seed: 'fixture', now: () => now, updater: () => ready,
    check: async () => undefined, download: async () => undefined,
    install: async () => { throw new Error('must not install while the user is active'); },
    systemIdleSeconds: () => idleSeconds, busy: () => false
  });
  await active.tick();

  // Preflight runs before anything is stopped.
  const directory = path.join(root, 'nightly-update', '中文 目录');
  await fs.promises.mkdir(directory, { recursive: true });
  const target = path.join(directory, 'XwX Deck.exe');
  const source = path.join(directory, 'download.exe');
  await fs.promises.writeFile(target, 'MZ-old');
  await fs.promises.writeFile(source, 'MZ-new');
  await assertPortableUpdateInstallable(source, target);
  assert.deepEqual((await fs.promises.readdir(directory)).sort(), ['XwX Deck.exe', 'download.exe'],
    'the write probe leaves nothing behind');
  await fs.promises.writeFile(source, 'not-an-exe');
  await assert.rejects(assertPortableUpdateInstallable(source, target), /不是有效的 Windows EXE/);
  await fs.promises.writeFile(source, 'MZ-new');
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    await fs.promises.chmod(directory, 0o555);
    try {
      await assert.rejects(assertPortableUpdateInstallable(source, target), /无法写入 XwX Deck 所在目录/);
    } finally {
      await fs.promises.chmod(directory, 0o755);
    }
  }

  // Leftovers from an interrupted helper.
  for (const suffix of ['.updating', '.rollback', '.previous']) await fs.promises.writeFile(target + suffix, 'MZ');
  assert.deepEqual(await sweepStalePortableUpdateFiles(target), [], 'fresh copies are kept');
  const backdatedMtime = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  for (const suffix of ['.updating', '.rollback', '.previous']) {
    await fs.promises.utimes(target + suffix, backdatedMtime, backdatedMtime);
  }
  assert.deepEqual(await sweepStalePortableUpdateFiles(target), [],
    'backdating mtime alone must not delete a file whose change or birth time is recent');
  const hourLater = Date.now() + 60 * 60_000;
  assert.deepEqual((await sweepStalePortableUpdateFiles(target, hourLater)).map(item => path.basename(item)).sort(),
    ['XwX Deck.exe.rollback', 'XwX Deck.exe.updating']);
  assert.ok(fs.existsSync(target + '.previous'), 'the manual fallback stays for a day');
  const dayLater = Date.now() + 25 * 60 * 60_000;
  assert.deepEqual((await sweepStalePortableUpdateFiles(target, dayLater)).map(item => path.basename(item)),
    ['XwX Deck.exe.previous']);
  assert.ok(fs.existsSync(target), 'the running EXE is never swept');
  assert.deepEqual(await sweepStalePortableUpdateFiles(undefined), []);
}
