import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const policy = JSON.parse(await readFile(path.join(root, 'public-release-policy.json'), 'utf8'));
const failures = [];
check(policy.schemaVersion === 1, 'public policy schemaVersion must be 1');
check(policy.repositoryMode === 'standalone', 'repository must be marked standalone');
check(policy.historyStrategy === 'new-root-history', 'repository must use a new root history');
const patterns = policy.forbiddenPatterns.map(pattern => new RegExp(pattern, 'iu'));
const forbiddenNameFragments = [
  ['paper', 'hub'].join(''),
  [['x', '3'].join(''), 'client'].join(''),
  ['open', 'trace'].join('')
];
for (const file of await textFiles(root)) {
  const relative = path.relative(root, file);
  if (relative === 'public-release-policy.json') continue;
  for (const fragment of forbiddenNameFragments) {
    if (relative.toLowerCase().includes(fragment)) failures.push(`${relative} contains forbidden filename fragment`);
  }
  let content = await readFile(file, 'utf8');
  // Registry integrity digests are opaque bytes, never product branding.
  if (relative === 'package-lock.json') content = content.replace(/"integrity"\s*:\s*"[^"]*"/g, '"integrity":"verified-by-package-manager"');
  for (const pattern of patterns) if (pattern.test(content)) failures.push(`${relative} contains forbidden pattern ${pattern}`);
}
for (const relative of ['src/renderer/features/sync/SyncPage.tsx','src/main/app/configSync.ts','src/main/app/excelMarkdown.ts','src/renderer/features/tools/ToolsPage.tsx','src/main/app/codexConversationDoctor.ts','src/main/codexConversationWorker.ts']) {
  check(!await exists(path.join(root, relative)), `removed feature file still exists: ${relative}`);
}
const settings = await readFile(path.join(root, 'src/main/app/settings.ts'), 'utf8');
check(settings.includes('connections: configured ? [initial] : []'), 'standalone registry must support empty connections');
const helper = await readFile(path.join(root, 'src/main/gatewayHelper.ts'), 'utf8');
check(
  helper.includes('const maxSessions = typeof record.maxSessions')
  && helper.includes('const maxStorageBytes = typeof record.maxStorageBytes'),
  'helper must apply configured Trace retention limits'
);
if (failures.length) {
  console.error('Public boundary check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('PASS standalone boundary: clean history policy, no internal defaults, removed features absent');
async function textFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.tmp-') || ['.git','node_modules','dist','release','release-native','target','gen','test-results'].includes(entry.name)) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await textFiles(candidate));
    else if (entry.isFile() && /\.(?:c?js|mjs|ts|tsx|rs|toml|json|md|html|css|txt|yml|yaml|bat|ps1)$/iu.test(entry.name)) output.push(candidate);
  }
  return output;
}
async function exists(candidate) { try { await readFile(candidate); return true; } catch { return false; } }
function check(condition, message) { if (!condition) failures.push(message); }
