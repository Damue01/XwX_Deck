// Add published models.dev fields without rerunning the multi-source curator or
// overwriting its verified prices. All processing uses the runtime parser/merge.
import { readFile, writeFile, mkdtemp, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '../..');
const temporary = await mkdtemp(join(tmpdir(), 'xwx-price-supplement-'));
try {
  const moduleFile = join(temporary, 'catalog.mjs');
  await build({ stdin: { contents: "export { parseModelsDevPricingCatalog, mergeRefreshedRules } from './src/shared/model-pricing-cache';", resolveDir: root }, outfile: moduleFile, bundle: true, platform: 'node', format: 'esm' });
  const { parseModelsDevPricingCatalog, mergeRefreshedRules } = await import(pathToFileURL(moduleFile));
  const catalogFile = process.argv.find(arg => arg.startsWith('--catalog='))?.slice('--catalog='.length);
  const sourceUrl = 'https://models.dev/api.json';
  const payload = catalogFile ? JSON.parse(await readFile(resolve(catalogFile), 'utf8')) : await (async () => {
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw Error(`Model pricing HTTP ${response.status}`);
    return response.json();
  })();
  const fresh = parseModelsDevPricingCatalog(payload);
  if (!fresh.length) throw Error('No valid model prices; retained existing asset.');
  const file = resolve(root, 'assets/models-dev-pricing.json');
  const previous = JSON.parse(await readFile(file, 'utf8'));
  const rules = mergeRefreshedRules(previous.rules, fresh);
  const now = new Date().toISOString();
  const next = { ...previous, fetchedAt: now, rules, supplement: { sourceUrl, fetchedAt: now, curatedAt: previous.supplement?.curatedAt ?? previous.fetchedAt, previousRuleCount: previous.rules.length, publishedRuleCount: fresh.length } };
  // The curator's ETag belongs to its old fetch and must not validate this data.
  delete next.etag;
  await writeFile(file + '.tmp', JSON.stringify(next, null, 2) + '\n');
  await rename(file + '.tmp', file);
  console.log(JSON.stringify({ previous: previous.rules.length, published: fresh.length, rules: rules.length, scope: 'Checked prices retained; missing fields require matching base rates; reseller prices require a provider prefix.' }));
} finally { await rm(temporary, { recursive: true, force: true }); }
