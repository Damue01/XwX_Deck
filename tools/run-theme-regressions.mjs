import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const source = await readFile(resolve(root, 'src/renderer/lib/theme.ts'), 'utf8');
const bundle = await build({
  stdin: { contents: `${source}\nexport { changeTheme }; export const settled = () => pendingPersistence;`, loader: 'ts', resolveDir: resolve(root, 'src/renderer/lib') },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent'
});

function fixture({ storageFails = false } = {}) {
  const html = { dataset: {}, classList: { toggle() {} } };
  const storage = new Map(), warnings = [], saves = [];
  const module = { exports: {} };
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports,
    document: {
      documentElement: html, dispatchEvent() {},
      startViewTransition() { throw Error('Whole-page snapshots block interaction'); }
    },
    localStorage: {
      getItem(key) { if (storageFails) throw Error('blocked'); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageFails) throw Error('blocked'); storage.set(key, value); }
    },
    console: { warn: (...args) => warnings.push(args) }, Event,
    process: { env: { NODE_ENV: 'production' } }
  });
  const api = module.exports;
  api.initTheme();
  return { api, html, warnings, saves, click: theme => api.changeTheme(theme, async value => { saves.push(value); }) };
}

const tests = [];
const test = (name, run) => tests.push({ name, run });

test('startup restores the persisted runtime theme', () => {
  const f = fixture(); f.api.applyTheme('night'); assert.equal(f.html.dataset.theme, 'night');
});
test('a click paints immediately without a browser snapshot or waiting for save', async () => {
  const f = fixture(); const pending = Promise.withResolvers();
  f.api.changeTheme('night', () => pending.promise);
  assert.equal(f.html.dataset.theme, 'night');
  assert.equal(f.html.dataset.themeTransition, undefined);
  pending.resolve(); await f.api.settled();
});
test('late runtime echoes cannot revert the chosen theme', async () => {
  const f = fixture(); f.click('night'); f.api.applyTheme('day');
  assert.equal(f.html.dataset.theme, 'night'); await f.api.settled();
  f.api.applyTheme('day'); assert.equal(f.html.dataset.theme, 'night');
});
test('rapid choices show the final intent and coalesce pending saves', async () => {
  const f = fixture(); f.click('night'); f.click('day'); f.click('night');
  assert.equal(f.html.dataset.theme, 'night'); await f.api.settled();
  assert.deepEqual(f.saves, ['night']);
});
test('a slow earlier save cannot overwrite the final persisted choice', async () => {
  const f = fixture(); const earlier = Promise.withResolvers(); let persisted;
  f.api.changeTheme('night', async theme => { await earlier.promise; persisted = theme; });
  await Promise.resolve();
  f.api.changeTheme('day', async theme => { persisted = theme; });
  assert.equal(f.html.dataset.theme, 'day');
  earlier.resolve(); await f.api.settled(); assert.equal(persisted, 'day');
});
test('a failed save does not stall later choices or revert the UI', async () => {
  const f = fixture(); f.api.changeTheme('night', async () => { throw Error('fixture save failed'); });
  await f.api.settled(); assert.equal(f.html.dataset.theme, 'night');
  assert.equal(f.warnings.length, 1);
  f.click('day'); await f.api.settled(); assert.deepEqual(f.saves, ['day']);
});
test('blocked localStorage cannot prevent theme changes', async () => {
  const f = fixture({ storageFails: true }); f.click('night');
  assert.equal(f.html.dataset.theme, 'night'); await f.api.settled(); assert.deepEqual(f.saves, ['night']);
});

let failed = 0;
for (const { name, run } of tests) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
}
if (failed) process.exitCode = 1;
console.log(`Theme regressions: ${tests.length - failed}/${tests.length} passed`);
