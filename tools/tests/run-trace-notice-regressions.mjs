import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: [resolve(root, 'src/renderer/App.tsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react/jsx-runtime', '@/*'], logLevel: 'silent'
});

// Run the real Shell's effects across successive renders. The UI and IPC
// boundaries are replaced; refs, effect dependencies and ordering are retained.
function fixture(runtime) {
  const hooks = [], effects = [], notices = [];
  let cursor = 0, noticeListener;
  const bridge = {
    booted: true, runtime, loadIssues: [],
    api: {
      onWindowState: () => () => {},
      onNotice: listener => { noticeListener = listener; return () => {}; }
    }
  };
  const react = {
    ...require('react'),
    useState(initial) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
      return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }];
    },
    useRef(initial) {
      const i = cursor++;
      return hooks[i] ??= { current: initial };
    },
    useLayoutEffect(effect, deps) { return react.useEffect(effect, deps); },
    useEffect(effect, deps) {
      const i = cursor++;
      const previous = hooks[i];
      if (!previous || deps.some((value, j) => !Object.is(value, previous[j]))) {
        hooks[i] = deps;
        effects.push(effect);
      }
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, URLSearchParams, Event,
    window: { location: { search: '' }, addEventListener() {}, removeEventListener() {} },
    document: { documentElement: { dataset: { nativeFrame: 'false' } }, dispatchEvent() {} },
    require(id) {
      if (id === 'react') return react;
      if (id === '@/bridge/store') return { useBridge: () => bridge, BridgeProvider: 'bridge' };
      if (id === '@/lib/toast') return {
        ToastProvider: 'toast', closeToast() {}, clearLifecycleNotice() {}, showToast() {},
        showLifecycleNotice: notice => notices.push(notice)
      };
      if (id === '@/lib/theme') return { applyTheme() {} };
      if (id === '@/lib/i18n') return {useLanguage() {},restoreLanguage() {},t: value => value};
      if (id.startsWith('@/')) return new Proxy({}, { get: (_, name) => String(name) });
      return require(id);
    }
  });
  const shell = module.exports.App().props.children.props.children.props.children.type;
  function render(next = bridge.runtime) {
    bridge.runtime = next;
    cursor = 0;
    shell();
    while (effects.length) effects.shift()();
  }
  render();
  return { notices, render, publish: notice => noticeListener(notice) };
}

const dependency = { message: '模型需要 Trace', description: '依赖说明', type: 'info', action: 'start-trace' };
const on = { tracingEnabled: true };
const off = { tracingEnabled: false, connectionNotice: dependency };
const result = { message: 'Trace 已关闭', description: '模型依赖和重启建议', type: 'info', action: 'start-trace' };
const tests = [];
const test = (name, run) => tests.push({ name, run });

for (const order of ['broadcast-first', 'result-first']) {
  for (const transitioning of [false, true]) {
    test(`${order}, stopping transition=${transitioning} keeps one combined notice`, () => {
      const f = fixture(on);
      if (transitioning) f.render({ ...on, traceTransition: 'stopping', connectionNotice: dependency });
      if (order === 'result-first') f.publish(result);
      f.render(off);
      if (order === 'broadcast-first') f.publish(result);
      f.render({ ...off });
      assert.deepEqual(f.notices, [result]);
    });
  }
}
test('a stopping broadcast with tracing already false does not replace the result', () => {
  const f = fixture(on);
  f.publish(result);
  f.render({ ...off, traceTransition: 'stopping' });
  f.render(off);
  assert.deepEqual(f.notices, [result]);
});
test('cold startup with Trace off still explains model dependencies', () => {
  const f = fixture(off);
  assert.deepEqual(f.notices, [dependency]);
});
test('a later changed model condition still produces guidance', () => {
  const f = fixture(on);
  f.render(off);
  const changed = { ...dependency, message: '新模型需要 Trace' };
  f.render({ ...off, connectionNotice: changed });
  assert.deepEqual(f.notices, [changed]);
});
test('stop failure remains visible and is not replaced by model dependency guidance', () => {
  const f = fixture(on);
  f.render({ ...on, traceTransition: 'stopping' });
  f.render({ ...off, lastError: '配置恢复冲突：ChatGPT 仍指向本地 Gateway' });
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].type, 'error');
  assert.equal(f.notices[0].persistent, true);
});
test('cancelled stop can still show a changed connection condition', () => {
  const f = fixture(on);
  f.render({ ...on, traceTransition: 'stopping' });
  f.render({ ...on, connectionNotice: dependency });
  assert.deepEqual(f.notices, [dependency]);
});
test('a delayed native tray result cannot overwrite a newer switch', () => {
  const f = fixture({ ...on, revision: 5 });
  f.publish({ ...result, runtimeRevision: 3, tracingEnabled: false });
  assert.deepEqual(f.notices, []);
  f.publish({ ...result, runtimeRevision: 6, tracingEnabled: false });
  assert.equal(f.notices.length, 1, 'result-first must still show the current operation');
});

for (const { name, run } of tests) {
  run();
  console.log(`PASS ${name}`);
}
console.log(`${tests.length} Trace notice regressions passed`);
