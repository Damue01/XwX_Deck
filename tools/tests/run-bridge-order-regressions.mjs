import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const bundle = await build({
  entryPoints: [resolve(root, 'src/renderer/bridge/store.tsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['react', 'react/jsx-runtime', './api', '@/lib/toast'], logLevel: 'silent'
});

// Real Bridge effects with deferred IPC. Keep the store alive while pages change.
const hooks = [], effects = [], requests = new Map();
let cursor = 0, listener, value;
const api = new Proxy({
  onState: callback => { listener = callback; return () => {}; },
  onUpdateState: () => () => {}, onShowUpdateDetails: () => () => {}
}, { get(target, key) {
  if (key in target) return target[key];
  return () => {
    const deferred = Promise.withResolvers();
    const list = requests.get(key) ?? [];
    list.push(deferred); requests.set(key, list);
    return deferred.promise;
  };
} });
const react = {
  ...require('react'),
  useContext: () => value,
  useState(initial) {
    const i = cursor++;
    if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
    return [hooks[i], next => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next; }];
  },
  useRef(initial) { const i = cursor++; return hooks[i] ??= { current: initial }; },
  useMemo(fn) { cursor++; return fn(); },
  useCallback(fn) { cursor++; return fn; },
  useEffect(fn, deps) {
    const i = cursor++, previous = hooks[i];
    if (!previous || deps.some((item, j) => !Object.is(item, previous.deps[j]))) {
      effects.push(() => { previous?.cleanup?.(); hooks[i] = { deps, cleanup: fn() }; });
    }
  }
};
const module = { exports: {} };
vm.runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, setTimeout, clearTimeout,
  document: { body: { dataset: {} } },
  window: { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} },
  require(id) {
    if (id === 'react') return react;
    if (id === './api') return { getApi: () => api, isDesktop: () => true };
    if (id === '@/lib/toast') return { showLifecycleNotice() {} };
    return require(id);
  }
});
function render() {
  cursor = 0;
  value = module.exports.BridgeProvider({ children: null }).props.value;
  while (effects.length) effects.shift()();
}
async function settle(method, index, result) {
  requests.get(method)[index].resolve(result);
  await new Promise(resolve => setImmediate(resolve));
  render();
}
render(); render();
const current = { tracingEnabled: false, revision: 3 };
value.patch({ runtime: current, providers: { active: { codex: 'latest' } },
  codexConfig: { model: 'latest-model' }, modelServices: { codex: true } });
render();
await settle('getState', 0, { tracingEnabled: true, revision: 1 });
assert.equal(value.runtime, current, 'late boot read must not turn Trace back on');
await settle('getProviders', 0, { active: { codex: 'old' } });
await settle('getCodexConfig', 0, { model: 'old-model' });
await settle('getModelServices', 0, { codex: false });
assert.equal(value.providers.active.codex, 'latest');
assert.equal(value.codexConfig.model, 'latest-model');
assert.equal(value.modelServices.codex, true);
console.log('PASS delayed initial reads preserve Trace and latest service/model');

value.patch({ providers: { active: { codex: 'newest' } }, codexConfig: { model: 'newest-model' } });
render();
await settle('getProviders', 1, { active: { codex: 'late-stop-read' } });
await settle('getCodexConfig', 1, { model: 'late-stop-model' });
assert.equal(value.providers.active.codex, 'newest');
assert.equal(value.codexConfig.model, 'newest-model');
console.log('PASS Trace follow-up reads cannot undo a later service/model commit');

listener({ tracingEnabled: true, revision: 5 }); render();
listener({ tracingEnabled: false, revision: 4 }); render();
assert.equal(value.runtime.tracingEnabled, true);
assert.equal(value.patch({ runtime: { tracingEnabled: false, revision: 3 } }), false);
render();
assert.equal(value.runtime.tracingEnabled, true);
assert.equal(value.patch({ runtime: { tracingEnabled: true, revision: 4 } }), true,
  'a newer matching broadcast must retain the operation notice');
console.log('PASS out-of-order broadcasts/results keep latest state and suppress obsolete notices');

for (const list of requests.values()) for (const request of list) request.resolve(null);
for (const hook of hooks) hook?.cleanup?.();
await new Promise(resolve => setImmediate(resolve));
console.log('3 Bridge ordering regressions passed');
