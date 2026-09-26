import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { XwXDeckSettingsStore } from '../src/main/app/settings';
import { XwXDeckController } from '../src/main/app/xwxDeckController';
import { lifecycleFailure } from '../src/shared/lifecycleNotice';

export async function testUpgradeSettings(root: string): Promise<void> {
  const base = path.join(root, 'upgrade-settings');
  const home = path.join(base, 'home');
  const codexHome = path.join(home, '.codex');
  const claudeHome = path.join(home, '.claude');
  const configPath = path.join(codexHome, 'config.toml');
  const env = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    XWX_DECK_CLIENT_HOME: process.env.XWX_DECK_CLIENT_HOME };
  process.env.CODEX_HOME = codexHome;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.XWX_DECK_CLIENT_HOME = home;
  await fs.promises.mkdir(codexHome, { recursive: true });
  await fs.promises.mkdir(claudeHome, { recursive: true });
  const config = 'model_provider = "my_legacy_provider"\nmodel = "legacy-model"\n[model_providers.my_legacy_provider]\nbase_url = "https://example.invalid/v1"\nwire_api = "responses"\n';
  await fs.promises.writeFile(configPath, config);
  await fs.promises.writeFile(path.join(codexHome, 'auth.json'), '{}');
  await fs.promises.writeFile(path.join(claudeHome, 'settings.json'), '{}');
  const legacy = { tracingEnabled: true, codexPreferredMode: 'compatible', claudePreferredMode: 'official',
    startupEnabled: true, theme: 'night', unknownField: 'keep', maxSessions: 0, maxStorageMB: 0,
    providers: { version: 1, connections: [{ id: 'legacy', displayName: 'Legacy',
      baseUrl: 'https://example.invalid/v1', bearerToken: 'fixture-key', adapter: 'responses',
      codexApiFormat: 'responses', codexModel: 'legacy-model', codexContextWindow: 32768 }],
    selected: { codex: 'legacy', claude: null } } };
  const seed = async (name: string, value: unknown = legacy) => {
    const store = new XwXDeckSettingsStore(path.join(base, name));
    await fs.promises.mkdir(path.dirname(store.path()), { recursive: true });
    const bytes = JSON.stringify(value, null, 2) + '\n';
    await fs.promises.writeFile(store.path(), bytes);
    return { store, bytes };
  };
  const controller = (store: XwXDeckSettingsStore) => new XwXDeckController(path.dirname(store.path()), {
    disableBackgroundModelRefresh: true, chatGptRunning: async () => false, codexHistoryMutationAllowed: async () => false
  });
  const readFile = fs.promises.readFile;
  const copyFile = fs.promises.copyFile;
  const rename = fs.promises.rename;
  const failure = (code: string) => Object.assign(new Error(`fixture ${code}`), { code });
  try {
    for (const code of ['EACCES', 'EBUSY']) {
      const { store, bytes } = await seed(code);
      fs.promises.readFile = (async (file: any, ...args: any[]) => {
        if (String(file) === configPath) throw failure(code);
        return (readFile as any)(file, ...args);
      }) as typeof readFile;
      const settings = await store.read();
      assert.deepEqual(settings.providers?.selected, legacy.providers.selected);
      assert.equal(settings.providers?.connections[0].codexModel, 'legacy-model');
      assert.equal(settings.providers?.identityVersion, undefined, 'an unreadable client must not complete identity migration');
      assert.equal(settings.providers?.connections[0].codexProviderId, undefined, 'do not persist a guessed identity');
      assert.equal(store.readProblem(), undefined, 'valid Deck settings must remain editable');
      assert.ok(store.migrationProblem());
      assert.equal(await readFile(store.path(), 'utf8'), bytes);
      const app = controller(store);
      await app.start();
      for (const fast of [true, false]) {
        const state = await app.runtimeState({ fast });
        assert.equal(state.readiness.startupPhase, 'degraded');
        assert.equal(state.tracingEnabled, false);
        assert.equal(state.theme, 'night');
        assert.match(state.lastError ?? '', /升级配置迁移未完成/);
        assert.equal(lifecycleFailure(state.lastError, '启动').action, 'models');
      }
      assert.equal((await app.readProviders()).active.codex, 'legacy');
      assert.equal((await app.readCodexEnhancements()).preserveOfficialLogin, true);
      await app.setStartupIntent(false);
      const saved = JSON.parse(await readFile(store.path(), 'utf8'));
      assert.equal(saved.startupEnabled, false, 'an unrelated setting must still save');
      assert.equal(saved.tracingEnabled, true, 'a failed startup must preserve Trace intent');
      assert.deepEqual(saved.providers.selected, legacy.providers.selected);
      assert.equal(saved.providers.identityVersion, undefined);
      assert.equal(saved.providers.connections[0].codexProviderId, undefined);
      assert.equal(await readFile(store.path() + '.before-provider-standardization.bak', 'utf8'), bytes);
      fs.promises.readFile = readFile;
      const recovered = await store.read();
      assert.equal(recovered.providers?.connections[0].codexProviderId, 'my_legacy_provider');
      assert.equal(recovered.providers?.identityVersion, 2);
      assert.equal(recovered.startupEnabled, false);
      assert.equal(store.migrationProblem(), undefined);
      assert.equal(await readFile(configPath, 'utf8'), config, 'opening Deck must not rewrite the client to an old/default service');
    }

    for (const operation of ['backup', 'write'] as const) {
      const { store, bytes } = await seed(operation);
      if (operation === 'backup') fs.promises.copyFile = async (source, target, mode) => {
        if (String(source) === store.path()) throw failure('EACCES');
        return copyFile(source, target, mode);
      };
      else fs.promises.rename = async (source, target) => {
        if (String(target) === store.path()) throw failure('ENOSPC');
        return rename(source, target);
      };
      const settings = await store.read();
      assert.equal(settings.providers?.connections[0].codexProviderId, 'my_legacy_provider');
      assert.deepEqual(settings.providers?.selected, legacy.providers.selected);
      assert.equal(store.readProblem(), undefined);
      assert.match(store.migrationProblem()?.message ?? '', /备份或写入失败/);
      const app = controller(store);
      await app.start();
      assert.equal((await app.runtimeState({ fast: true })).readiness.startupPhase, 'degraded');
      await assert.rejects(store.update({ theme: 'day' }), /fixture/, 'real write failures must not report success');
      assert.equal(await readFile(store.path(), 'utf8'), bytes);
      fs.promises.copyFile = copyFile;
      fs.promises.rename = rename;
      await store.read();
      assert.equal(store.migrationProblem(), undefined);
      assert.equal(await readFile(store.path() + '.before-provider-standardization.bak', 'utf8'), bytes);
    }

    const broken = { ...legacy, providers: { version: 1, connections: null, selected: { codex: 'legacy' } } };
    const { store, bytes } = await seed('invalid-registry', broken);
    await store.read();
    assert.ok(store.readProblem());
    const app = controller(store);
    await app.start();
    const state = await app.runtimeState({ fast: true });
    assert.equal(state.readiness.startupPhase, 'degraded');
    assert.equal(lifecycleFailure(state.lastError, '启动').action, 'repair-settings');
    await assert.rejects(app.readStartupIntent(), /服务连接配置无法解析/,
      'safe display defaults must not be treated as a saved intent to remove the login item');
    assert.equal(await readFile(store.path(), 'utf8'), bytes);
    assert.equal(await readFile(configPath, 'utf8'), config);
    const repair = await store.repairUnreadableSettings();
    assert.equal(await readFile(repair.backupPath, 'utf8'), bytes);
    assert.equal((await store.update({ theme: 'day' })).theme, 'day', 'confirmed repair must restore normal edits');

    // A future unexpected initialization failure must not make status repeat
    // the same failed read before the manager window has a chance to open.
    const failed = controller((await seed('unexpected-read-failure')).store);
    const internal = failed as any;
    let reads = 0;
    internal.settingsStore.read = async () => { reads++; throw failure('EIO'); };
    await failed.start();
    assert.equal((await failed.runtimeState({ fast: true })).readiness.startupPhase, 'degraded');
    assert.equal(reads, 1);
  } finally {
    fs.promises.readFile = readFile;
    fs.promises.copyFile = copyFile;
    fs.promises.rename = rename;
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
