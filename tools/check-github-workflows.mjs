import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '..');
const workflowRoot = path.join(root, '.github', 'workflows');
const required = new Set(['ci.yml', 'pages.yml', 'release.yml']);
const failures = [];

for (const entry of await readdir(workflowRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
  required.delete(entry.name);
  const file = path.join(workflowRoot, entry.name);
  const content = await readFile(file, 'utf8');
  let workflow;
  try {
    workflow = parse(content);
  } catch (error) {
    failures.push(`${entry.name}: invalid YAML: ${error.message}`);
    continue;
  }
  check(workflow && typeof workflow === 'object', `${entry.name}: workflow must be an object`);
  check(workflow?.jobs && typeof workflow.jobs === 'object', `${entry.name}: jobs are required`);
  check(!Object.hasOwn(workflow ?? {}, 'pull_request_target'),
    `${entry.name}: pull_request_target is not allowed for this public repository`);
  const internalRemoteMarker = `XwX${'ClientRemote'}`;
  const privateHomeMarker = `/${'Users'}/${'damue'}`;
  const internalIpMarker = ['10', '10', '114', '104'].join('\\.');
  check(!new RegExp(`${internalIpMarker}|${internalRemoteMarker}|${privateHomeMarker}`).test(content),
    `${entry.name}: contains an internal-only value`);
  check(!/\bpermissions:\s*write-all\b/.test(content),
    `${entry.name}: write-all permissions are not allowed`);
}

for (const file of required) failures.push(`missing required workflow: ${file}`);

const release = await readFile(path.join(workflowRoot, 'release.yml'), 'utf8');
check(release.includes('environment: release'), 'release workflow must use the protected release environment');
check(release.includes('--draft'), 'release workflow must create a draft release');
check(release.includes('attest-build-provenance'), 'release workflow must attest build provenance');
check(release.includes('macos-15'), 'release workflow must build on a native macOS arm64 runner');
check(release.includes('windows-latest'), 'release workflow must build on a native Windows runner');
check((release.match(/run-packaged-update-smoke\.mjs/g) ?? []).length === 2,
  'release must validate actual packaged updates on Windows and Mac');
check(release.includes("pattern: '*-x64'"), 'release assembly must exclude verification evidence from download assets');

const pages = await readFile(path.join(workflowRoot, 'pages.yml'), 'utf8');
check(pages.includes('deploy-pages'), 'Pages workflow must deploy with actions/deploy-pages');
check(pages.includes('DOCS_BASE: /XwX_Deck/'), 'Pages workflow must set the repository base path');

if (failures.length) {
  console.error('GitHub workflow check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('PASS GitHub workflows: CI, Pages and draft release framework');

function check(condition, message) {
  if (!condition) failures.push(message);
}
