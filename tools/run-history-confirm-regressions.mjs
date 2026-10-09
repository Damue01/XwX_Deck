import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: [resolve(root, 'src/renderer/features/models/CodexEnhancements.tsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react/jsx-runtime', '@/components/ui/confirm-dialog', '@/features/shell/Toggle', '@/lib/toast'],
  logLevel: 'silent'
});

// Exercise the real component's handlers without mounting an app or accessing
// the user's configuration. Only React hooks and the UI boundary are mocked.
function fixture({ hasHistoryBackup = false, enabled = true, confirmed = true, checked = true, history, fails = false } = {}) {
  const prompts = [], updates = [], toasts = [];
  const snapshot = {
    preserveOfficialLogin: true, authMode: 'chatgpt', unifySessionHistory: enabled,
    historyRestorePending: false, hasHistoryBackup
  };
  const module = { exports: {} };
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    require(id) {
      if (id === 'react') return {
        useState: initial => [initial, () => {}],
        useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
        useCallback: fn => fn
      };
      if (id === '@/components/ui/confirm-dialog') return {
        useConfirm: () => async options => { prompts.push(options); return confirmed; },
        useConfirmChecked: () => async options => { prompts.push(options); return { confirmed, checked }; }
      };
      if (id === '@/features/shell/Toggle') return { Toggle: 'test-toggle' };
      if (id === '@/lib/toast') return { showToast: (...args) => toasts.push(args), showErrorToast: (title, error) => toasts.push([title, 'error', error]) };
      return require(id);
    }
  });
  const tree = module.exports.CodexEnhancements({
    enhancements: snapshot,
    async onUpdate(patch) {
      updates.push(JSON.parse(JSON.stringify(patch)));
      if (fails) throw new Error('test: write failed');
      return { ...snapshot, unifySessionHistory: patch.unifySessionHistory, history };
    }
  });
  function find(node, id) {
    if (!node || typeof node !== 'object') return undefined;
    if (node.props?.id === id) return node;
    return [node.props?.children].flat().map(child => find(child, id)).find(Boolean);
  }
  return { prompts, updates, toasts, click: () => find(tree, 'codexHistoryToggle').props.onToggle() };
}

const tests = [];
const test = (name, run) => tests.push({ name, run });
const outcome = skippedReason => ({
  migratedJsonlFiles: 0, migratedStateRows: 0, restoredJsonlFiles: 0,
  restoredStateRows: 0, skippedLockedJsonlFiles: 0, skippedLockedStateDbs: 0, skippedReason
});

for (const hasHistoryBackup of [false, true]) {
  test(`restore remains available with cached hasHistoryBackup=${hasHistoryBackup}`, async () => {
    const f = fixture({ hasHistoryBackup });
    await f.click();
    assert.equal(f.prompts[0].checkboxLabel, '恢复迁移前分类');
    assert.equal(f.prompts[0].checkboxDefaultChecked, true);
    assert.deepEqual(f.updates, [{ unifySessionHistory: false, migrateExisting: false, restoreExisting: true }]);
  });
}

test('unchecking restore only stops management', async () => {
  const f = fixture({ checked: false });
  await f.click();
  assert.deepEqual(f.updates, [{ unifySessionHistory: false, migrateExisting: false, restoreExisting: false }]);
});

test('cancel never writes settings or restores history', async () => {
  const f = fixture({ confirmed: false });
  await f.click();
  assert.deepEqual(f.updates, []);
  assert.deepEqual(f.toasts, []);
});

test('enabling still requires confirmation and never requests restore', async () => {
  const f = fixture({ enabled: false });
  await f.click();
  assert.equal(f.prompts[0].title, '管理已有会话？');
  assert.equal(f.prompts[0].checkboxLabel, undefined);
  assert.deepEqual(f.updates, [{ unifySessionHistory: true, migrateExisting: true, restoreExisting: false }]);
});

test('missing real backup reports no recovery instead of success', async () => {
  const f = fixture({ history: outcome('no_backup_ledger') });
  await f.click();
  assert.match(f.toasts[0][0], /没有可恢复/);
  assert.doesNotMatch(f.toasts[0][0], /已恢复/);
});

test('a running client reports deferred restoration', async () => {
  const f = fixture({ history: outcome('restore_deferred') });
  await f.click();
  assert.match(f.toasts[0][0], /完全退出后自动恢复/);
  assert.doesNotMatch(f.toasts[0][0], /已恢复/);
});

test('successful restoration reports the actual result', async () => {
  const f = fixture({ history: { ...outcome(), restoredJsonlFiles: 2, restoredStateRows: 3 } });
  await f.click();
  assert.equal(f.toasts[0][0], '已恢复 2 个会话文件、3 条侧边栏索引');
});

test('write failure does not report success', async () => {
  const f = fixture({ fails: true });
  await f.click();
  assert.equal(f.toasts[0][1], 'error');
});

for (const { name, run } of tests) {
  await run();
  console.log(`PASS ${name}`);
}
console.log(`${tests.length} history confirmation regressions passed`);
