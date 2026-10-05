import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
// Keep the production surface private; expose the click handler only in this
// in-memory test bundle. No generated files or user settings are needed.
const source = await readFile(resolve(root, 'src/renderer/lib/theme.ts'), 'utf8');
const bundle = await build({
  stdin: {
    contents: `${source}\nexport { changeTheme };`,
    loader: 'ts',
    resolveDir: resolve(root, 'src/renderer/lib')
  },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent'
});

function fixture({ reducedMotion = false, supported = true, storageFails = false, throws = false } = {}) {
  const attributes = {};
  const classes = new Set();
  const storage = new Map();
  const events = [], warnings = [], transitions = [], saves = [];
  const html = {
    dataset: attributes,
    classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
    style: { setProperty() {} }
  };
  const document = {
    documentElement: html,
    visibilityState: 'visible',
    dispatchEvent(event) { events.push(event.type); },
    startViewTransition: supported ? update => {
      if (throws) throw new Error('test: snapshot unavailable');
      const ready = Promise.withResolvers(), finished = Promise.withResolvers();
      let captured = false;
      const transition = {
        ready: ready.promise,
        finished: finished.promise,
        oldTheme: undefined,
        newTheme: undefined,
        async capture() {
          if (captured) return;
          captured = true;
          this.oldTheme = html.dataset.theme;
          await update();
          this.newTheme = html.dataset.theme;
          ready.resolve();
          await Promise.resolve();
        },
        finish() { finished.resolve(); },
        skipTransition() { this.skipped = true; ready.reject(new Error('test: superseded')); finished.resolve(); },
        reject() { ready.reject(new Error('test: asynchronous snapshot failure')); finished.resolve(); }
      };
      // Observe rejections in the baseline too, without changing their outcome.
      void transition.ready.catch(() => {});
      transitions.push(transition);
      return transition;
    } : undefined
  };
  const module = { exports: {} };
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, document,
    window: { innerWidth: 1040, innerHeight: 560, matchMedia: () => ({ matches: reducedMotion }) },
    localStorage: {
      getItem(key) { if (storageFails) throw Error('blocked'); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageFails) throw Error('blocked'); storage.set(key, value); }
    },
    console: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
    Event, process: { env: { NODE_ENV: 'production' } }
  });
  const api = module.exports;
  const origin = { getBoundingClientRect: () => ({ left: 940, top: 370, width: 40, height: 20 }) };
  const click = theme => api.changeTheme(theme, origin, async value => { saves.push(value); });
  api.initTheme();
  return { api, html, click, transitions, saves, events, warnings };
}

const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('startup still restores the persisted runtime theme', () => {
  const f = fixture();
  f.api.applyTheme('night');
  assert.equal(f.html.dataset.theme, 'night');
});

test('an early runtime echo cannot turn both circular snapshots into the same theme', async () => {
  const f = fixture();
  f.click('night');
  // Shell and Settings both reconcile runtime independently of the pending
  // native snapshot. A same-target echo must not paint before its callback.
  f.api.applyTheme('night');
  assert.equal(f.html.dataset.theme, 'day', 'old theme must survive until the native snapshot');
  await f.transitions[0].capture();
  assert.equal(f.transitions[0].oldTheme, 'day');
  assert.equal(f.transitions[0].newTheme, 'night');
  assert.deepEqual(f.saves, ['night']);
  f.transitions[0].finish();
});

test('late runtime state does not undo the most recent user selection', async () => {
  const f = fixture();
  f.click('night');
  await f.transitions[0].capture();
  f.transitions[0].finish();
  await Promise.resolve();
  f.api.applyTheme('day');
  assert.equal(f.html.dataset.theme, 'night');
});

test('superseded callbacks cannot paint or persist an earlier choice', async () => {
  const f = fixture();
  f.click('night');
  f.click('day');
  await f.transitions[0].capture();
  await f.transitions[1].capture();
  assert.equal(f.transitions[0].skipped, true);
  assert.equal(f.html.dataset.theme, 'day');
  assert.deepEqual(f.saves, ['day']);
  f.transitions[1].finish();
});

test('finishing an earlier transition cannot remove the next circle', async () => {
  const f = fixture();
  f.click('night');
  await f.transitions[0].capture();
  f.click('day');
  await f.transitions[1].capture();
  f.transitions[0].finish();
  await Promise.resolve();
  assert.equal(f.html.dataset.themeTransition, 'circle');
  f.transitions[1].finish();
  await Promise.resolve();
  assert.equal(f.html.dataset.themeTransition, undefined);
  assert.equal(f.html.dataset.themeTransitionStatus, 'finished');
});

test('missing origin switches directly and records why', () => {
  const f = fixture();
  f.api.changeTheme('night', null, async theme => f.saves.push(theme));
  assert.equal(f.html.dataset.theme, 'night');
  assert.equal(f.html.dataset.themeTransitionStatus, 'missing-origin');
});

for (const [name, options] of [
  ['reduced motion', { reducedMotion: true }],
  ['unsupported API', { supported: false }],
  ['synchronous snapshot failure', { throws: true }]
]) {
  test(`${name} preserves the requested theme without a stalled transition`, () => {
    const f = fixture(options);
    f.click('night');
    assert.equal(f.html.dataset.theme, 'night');
    assert.deepEqual(f.saves, ['night']);
    assert.equal(f.html.dataset.themeTransition, undefined);
  });
}

test('asynchronous snapshot failure is observed and does not revert the theme', async () => {
  const f = fixture();
  f.click('night');
  // The browser still invokes the update callback when it skips a transition.
  await f.transitions[0].capture();
  // Use a fresh pending transition to reject ready before it resolves.
  f.click('day');
  f.transitions[1].reject();
  await f.transitions[1].capture();
  await Promise.resolve();
  assert.equal(f.html.dataset.theme, 'day');
  assert.ok(f.warnings.some(args => args.join(' ').includes('snapshot')), 'skip reason must be diagnosable');
});

test('storage failure cannot prevent the DOM theme from changing', async () => {
  const f = fixture({ storageFails: true });
  f.click('night');
  await f.transitions[0].capture();
  assert.equal(f.html.dataset.theme, 'night');
  assert.deepEqual(f.saves, ['night']);
  f.transitions[0].finish();
});

let failed = 0;
for (const { name, run } of tests) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
}
if (failed) process.exitCode = 1;
console.log(`Theme regressions: ${tests.length - failed}/${tests.length} passed`);
