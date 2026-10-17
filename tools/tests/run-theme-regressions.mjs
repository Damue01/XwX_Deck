import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '../..');
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

function fixture({storageFails=false,failSave=false,darkSystem=false}={}) {
  const attrs={},storage=new Map(),saves=[],events=[],warnings=[];
  const listeners=[];const system={matches:darkSystem,addEventListener(_event,cb){listeners.push(cb);}};
  const pending=[];const module={exports:{}};
  vm.runInNewContext(bundle.outputFiles[0].text,{
    module,exports:module.exports,
    document:{documentElement:{dataset:attrs,classList:{toggle(){}},style:{setProperty(){}}},dispatchEvent(event){events.push(event.type);},startViewTransition(){throw Error('whole-window snapshots must not gate theme changes');}},
    window:{matchMedia(){return system;}},Event,process:{env:{NODE_ENV:'production'}},
    localStorage:{getItem(key){if(storageFails)throw Error('blocked');return storage.get(key)??null;},setItem(key,value){if(storageFails)throw Error('blocked');storage.set(key,value);}},
    console:{warn:(...args)=>warnings.push(args)}
  });
  const api=module.exports;api.initTheme();
  const persist=theme=>{saves.push(theme);const job=Promise.withResolvers();pending.push(job);return failSave?Promise.reject(Error('test: save failed')):job.promise;};
  return {api,attrs,storage,saves,events,warnings,pending,system:dark=>{system.matches=dark;listeners.forEach(cb=>cb());},click:theme=>api.changeTheme(theme,persist)};
}
const tests=[];const test=(name,run)=>tests.push({name,run});
const tick=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
test('startup restores the persisted runtime theme',()=>{const f=fixture();f.api.applyTheme('night');assert.equal(f.attrs.theme,'night');assert.equal(f.storage.get('xwx-deck.theme'),'night');});
test('theme paints immediately while save is pending',async()=>{const f=fixture();f.click('night');assert.equal(f.attrs.theme,'night');await tick();assert.deepEqual(f.saves,['night']);f.pending[0].resolve();});
test('late runtime echoes cannot undo the latest local choice',()=>{const f=fixture();f.click('night');f.api.applyTheme('day');assert.equal(f.attrs.theme,'night');f.click('day');f.api.applyTheme('night');assert.equal(f.attrs.theme,'day');});
test('rapid selections persist only the last unsent choice',async()=>{const f=fixture();f.click('night');f.click('day');f.click('night');await tick();assert.deepEqual(f.saves,['night']);f.pending[0].resolve();});
test('a slow earlier save cannot finish after and overwrite a later save',async()=>{const f=fixture();f.click('night');await tick();f.click('day');assert.equal(f.attrs.theme,'day');await tick();assert.deepEqual(f.saves,['night']);f.pending[0].resolve();await tick();assert.deepEqual(f.saves,['night','day']);f.pending[1].resolve();});
test('superseded queued saves never persist intermediate choices',async()=>{const f=fixture();f.click('night');await tick();f.click('night');f.click('day');f.pending[0].resolve();await tick();assert.deepEqual(f.saves,['night','day']);f.pending[1].resolve();});
test('save rejection keeps the choice and later saves still work',async()=>{const f=fixture({failSave:true});f.click('night');await tick();assert.equal(f.attrs.theme,'night');assert.equal(f.warnings.length,1);f.click('day');await tick();assert.deepEqual(f.saves,['night','day']);assert.equal(f.attrs.theme,'day');});
test('storage failure cannot block painting and preserves the event identity',async()=>{const f=fixture({storageFails:true});f.click('night');assert.equal(f.attrs.theme,'night');assert.ok(f.events.every(e=>e==='xwx:themechange'));await tick();f.pending[0].resolve();});
test('system mode follows OS changes without losing the preference',()=>{const f=fixture({darkSystem:true});f.api.applyTheme('system');assert.equal(f.attrs.theme,'night');assert.equal(f.storage.get('xwx-deck.theme'),'system');f.system(false);assert.equal(f.attrs.theme,'day');assert.equal(f.storage.get('xwx-deck.theme'),'system');});
test('manual choice ignores later OS changes and stale runtime',()=>{const f=fixture({darkSystem:true});f.click('day');f.system(true);f.api.applyTheme('system');assert.equal(f.attrs.theme,'day');assert.equal(f.attrs.themePreference,'day');});
for(const{name,run}of tests){await run();console.log('PASS '+name);}
console.log(`${tests.length} responsive theme regressions passed`);
