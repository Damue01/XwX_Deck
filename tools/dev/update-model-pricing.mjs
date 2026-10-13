// Download a models.dev snapshot. No vendor scraping, FX conversion or guessed prices.
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const root = resolve(import.meta.dirname, '../..');
const { parseModelsDevReferencePrices } = createRequire(import.meta.url)('../../src/shared/models-dev.browser.js');
const input = process.argv.indexOf('--input');
let catalog, fetchedAt;
if (input >= 0) {
  const file=resolve(process.argv[input+1]);
  catalog=JSON.parse(await readFile(file,'utf8'));
  fetchedAt=(await stat(file)).mtime.toISOString();
}
else {
  const response = await fetch('https://models.dev/api.json', { signal:AbortSignal.timeout(30000) });
  if (!response.ok) throw Error('models.dev HTTP '+response.status);
  catalog = await response.json();
  fetchedAt = new Date().toISOString();
}
const rules = parseModelsDevReferencePrices(catalog);
if (!rules.length) throw Error('No supported standard reference prices; prior snapshot preserved.');
const destination = resolve(root, 'assets/models-dev-pricing.json');
const snapshot = { version:2, referenceCatalogVersion:1, sourceUrl:'https://models.dev/api.json', fetchedAt, rules };
const staging = destination+'.tmp';
await writeFile(staging,JSON.stringify(snapshot,null,2)+'\n');
await rename(staging,destination);
const keys = ['canonical_model_id','name','limit','modalities','temperature','interleaved','reasoning','reasoning_options','tool_call','structured_output'];
const capabilities = Object.fromEntries(Object.entries(catalog).map(([provider,p]) => [provider,{ models:Object.fromEntries(Object.entries(p.models || {}).map(([id,m]) => [id,Object.fromEntries(keys.filter(key => m[key] !== undefined).map(key => [key,m[key]]))])) }]));
await writeFile(resolve(root,'assets/models-dev-capabilities.json'),JSON.stringify({version:1,fetchedAt:snapshot.fetchedAt,catalog:capabilities})+'\n');
console.log(`Saved ${rules.length} standard reference models from models.dev (model owner, then Bedrock/Azure).`);
