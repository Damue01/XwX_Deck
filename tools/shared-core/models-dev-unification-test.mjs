import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
const root = resolve(import.meta.dirname,'../..');
const require = createRequire(import.meta.url);
const source = await readFile(resolve(root,'src/shared/models-dev.browser.js'),'utf8');
const browser = { window:{} }; vm.runInNewContext(source,browser);
const apis = [require('../../src/shared/models-dev.browser.js'),browser.window.XwXModelsDev];
const cases = JSON.parse(await readFile(resolve(import.meta.dirname,'models-dev-unification-cases.json'),'utf8'));
for(const api of apis) for(const item of cases) {
 const rows=api.parseModelsDevReferencePrices(item.catalog);
 const row=api.findModelReference(item.lookup,rows);
 assert.equal(row?.providerId ?? null,item.provider,item.name);
 if(item.provider) assert.equal(row.input,item.input,item.name);
}
const snapshot=JSON.parse(await readFile(resolve(root,'assets/models-dev-pricing.json'),'utf8'));
for(const api of apis) {
 const row=api.findModelReference('deepseek-v4-1-flash-260910',snapshot.rules);
 assert.equal(row.canonicalModelId,'deepseek/deepseek-v4.1-flash');
 assert.equal(row.providerId,'deepseek');
 assert.equal(api.findModelReference('gpt-6.1-sol',snapshot.rules).providerId,'openai');
}
console.log(`PASS ${cases.length} standard-price/alias cases in Node and browser, plus actual DeepSeek/OpenAI snapshot aliases`);
