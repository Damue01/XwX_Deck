import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CodexConfigManager } from '../src/main/trace/codexConfigManager';
import { CodexDirectRestore } from '../src/main/trace/codexDirectRestore';

export async function testDirectRestore(root: string): Promise<void> {
  const dir = path.join(root, 'direct-restore');
  const file = path.join(dir, 'config.toml');
  await fs.mkdir(dir, { recursive: true });
  const ledger = new CodexDirectRestore(dir);
  const original = 'model = "before"\nservice_tier = "user-tier"\n# keep\n[model_providers.custom]\nbase_url = "https://external.example/api"\n';
  const written = original.replace('"before"', '"gateway"');
  await fs.writeFile(file, original);
  await ledger.write(file, original, written, ['model'], () => fs.writeFile(file, written));
  const external = written.replace('"gateway"', '"external"');
  await fs.writeFile(file, external);
  const conflict = await ledger.restore(file, baseline => baseline.replace('"user-tier"', '"unexpected"'), (before, next) => fs.writeFile(file, next));
  assert.deepEqual(conflict.conflicts, ['model 已被外部修改，保留当前值']);
  assert.equal(await fs.readFile(file, 'utf8'), external, 'unwritten service_tier and external model edits must survive');
  // Explicitly writing again rebases ownership to the external value.
  const again = external.replace('"external"', '"gateway-2"');
  await ledger.write(file, external, again, ['model'], () => fs.writeFile(file, again));
  await ledger.restore(file, baseline => baseline, (before, next) => fs.writeFile(file, next));
  assert.equal(await fs.readFile(file, 'utf8'), external);
  await assert.rejects(fs.stat(path.join(dir, 'codex-direct-restore.json')), /ENOENT/);

  await assert.rejects(ledger.write(file, external, written, ['model'], async () => {
    await fs.writeFile(file, written); throw new Error('write verification fixture');
  }), /verification fixture/);
  assert.equal(await fs.readFile(file, 'utf8'), external, 'write-after-publish failure rolls back exact bytes');
  await assert.rejects(fs.stat(path.join(dir, 'codex-direct-restore.json')), /ENOENT/);

  await ledger.write(file, external, written, ['model'], () => fs.writeFile(file, written));
  const state = await fs.readFile(path.join(dir, 'codex-direct-restore.json'), 'utf8');
  await assert.rejects(ledger.restore(file, baseline => baseline, async (before, next) => {
    await fs.writeFile(file, next); throw new Error('restore verification fixture');
  }), /verification fixture/);
  assert.equal(await fs.readFile(file, 'utf8'), written);
  assert.equal(await fs.readFile(path.join(dir, 'codex-direct-restore.json'), 'utf8'), state);
  await assert.rejects(ledger.restore(path.join(dir, 'other.toml'), text => text, async () => {}), /目录已变化/);
  // A race during publication preserves the competing writer, while restoring
  // the ledger to the prior state so no uncommitted write claims ownership.
  await assert.rejects(ledger.write(file, written, again, ['model'], async () => {
    await fs.writeFile(file, original); throw new Error('external race');
  }), /external race/);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.equal(await fs.readFile(path.join(dir, 'codex-direct-restore.json'), 'utf8'), state);
  await testLegacySnapshotUpgrade(root);
}

async function testLegacySnapshotUpgrade(root: string): Promise<void> {
  const data = path.join(root, 'direct-restore-upgrade');
  const home = path.join(data, 'home');
  const file = path.join(home, 'config.toml');
  const originalHome = process.env.CODEX_HOME;
  const original = 'model_provider = "openai"\nmodel = "before"\nservice_tier = "user-tier"\n# keep\n[model_providers.user_service]\nbase_url = "https://external.example/api"\n';
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(file, original);
  process.env.CODEX_HOME = home;
  try {
    const ledger = new CodexDirectRestore(data);
    const written = original.replace('"before"', '"gateway"');
    await ledger.write(file, original, written, ['model'], () => fs.writeFile(file, written));
    const legacy = await fs.readFile(path.join(data, 'codex-direct-restore.json'));
    const external = written.replace('"gateway"', '"external"');
    await fs.writeFile(file, external);
    const manager = new CodexConfigManager(data);
    const input = { officialBaseUrl: 'https://api.openai.com/v1', officialModel: 'before' };
    const conflicted = await manager.restoreDirectConfiguration(input);
    assert.ok(conflicted.conflicts.length, 'legacy field conflicts remain visible after migration');
    assert.equal(await fs.readFile(file, 'utf8'), external, 'migration cannot claim untouched root/provider fields');
    assert.deepEqual(await fs.readFile(path.join(data, 'codex-direct-restore.json.migrated.bak')), legacy);
    const snapshotPath = path.join(data, 'codex-direct-config-state.json');
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
    assert.deepEqual(snapshot.ownedFieldPaths, ['model']);
    await fs.writeFile(file, written);
    const restored = await manager.restoreDirectConfiguration(input);
    assert.deepEqual(restored.conflicts, []);
    assert.equal(await fs.readFile(file, 'utf8'), original);
    await assert.rejects(fs.stat(snapshotPath), /ENOENT/);
    // An unreadable new record must never be treated as absent and overwritten.
    await fs.mkdir(snapshotPath);
    await assert.rejects(manager.update({ mode: 'official', officialModel: 'other' }), /EISDIR/);
    assert.equal(await fs.readFile(file, 'utf8'), original);
    await fs.rmdir(snapshotPath);
    await fs.writeFile(snapshotPath, JSON.stringify({ ...snapshot, configPath: path.join(home, 'other.toml') }));
    await assert.rejects(manager.restoreDirectConfiguration(input), /目录已变化/);
    assert.equal(await fs.readFile(file, 'utf8'), original);
  } finally {
    if (originalHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalHome;
  }
}
