import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import esbuild from 'esbuild';
const root=resolve(import.meta.dirname,'../..');
const bundled=await esbuild.build({entryPoints:[resolve(root,'src/renderer/lib/i18n.ts')],bundle:true,platform:'node',format:'esm',write:false});
const i18n=await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const english=(await import(`data:text/javascript;base64,${Buffer.from((await esbuild.build({entryPoints:[resolve(root,'src/renderer/lib/locales/en.ts')],bundle:true,platform:'node',format:'esm',write:false})).outputFiles[0].text).toString('base64')}`)).english;
const placeholders=value=>[...value.matchAll(/\{\d+\}/g)].map(match=>match[0]).sort();
for(const {id}of i18n.LANGUAGES){
  if(id!=='zh-CN'&&id!=='en'){
    const dictionary=JSON.parse(await readFile(resolve(root,`src/renderer/lib/locales/${id}.json`),'utf8'));
    for(const [key,value]of Object.entries(english)){
      assert.ok(dictionary[key]?.trim(),`${id}: missing ${key}`);
      assert.deepEqual(placeholders(dictionary[key]),placeholders(value),`${id}: placeholders ${key}`);
    }
  }
  i18n.applyLanguage(id);
  assert.equal(i18n.getLanguage(),id);
  assert.notEqual(i18n.t('语言'),'');
  assert.ok(i18n.t('{0} 的更多操作','USER_MODEL_42').includes('USER_MODEL_42'));
}
for(const [input,expected]of [['zh-Hant-HK','zh-TW'],['zh_HK.UTF-8','zh-TW'],['zh-Hans-SG','zh-CN'],['ja-JP','ja'],['ko-KR','ko'],['fr-FR','fr'],['de-DE','de'],['es-MX','es'],['pt_BR','pt-BR'],['it-IT','en']])assert.equal(i18n.systemLanguage([input]),expected);
i18n.applyLanguage('ja');
await assert.rejects(i18n.changeLanguage('fr',async()=>{throw Error('isolated save failure')}));
assert.equal(i18n.getLanguage(),'ja','failed persistence restores previous language');
await i18n.changeLanguage('de',async()=>{});
i18n.restoreLanguage('en');assert.equal(i18n.getLanguage(),'de','late runtime must not overwrite explicit choice');
console.log(`PASS ${i18n.LANGUAGES.length} languages: full dictionary coverage, placeholders, system matching, rollback and explicit choice preservation`);
