import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { containsPrivateIdentifier } from './privacy-identifiers.mjs';

const root = path.resolve(import.meta.dirname, '../..');
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
  check(!containsPrivateIdentifier(content), `${entry.name}: contains a private identifier`);
  check(!/\bpermissions:\s*write-all\b/.test(content),
    `${entry.name}: write-all permissions are not allowed`);
  for (const [name, job] of Object.entries(workflow?.jobs ?? {})) {
    const steps = job.steps ?? [];
    const auditsHistory = steps.some(step => /npm test\b|npm run (?:compile|check:quality|check:public-boundary|check:repository|build:(?:rust|native|win|mac))\b/u.test(step.run ?? ''));
    if (auditsHistory) {
      const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'));
      check(checkout?.with?.['fetch-depth'] === 0, `${entry.name}/${name}: repository checks require full Git history`);
    }
  }
}

for (const file of required) failures.push(`missing required workflow: ${file}`);

const release = await readFile(path.join(workflowRoot, 'release.yml'), 'utf8');
check(release.includes('environment: release'), 'release workflow must use the protected release environment');
check(release.includes('--draft'), 'release workflow must create a draft release');
check(release.includes('attest-build-provenance'), 'release workflow must attest build provenance');
check(release.includes('macos-15'), 'release workflow must build on a native macOS arm64 runner');
check(release.includes('windows-latest'), 'release workflow must build on a native Windows runner');
check((release.match(/npm run test:rust:backend/g) ?? []).length === 2 && (release.match(/tools\/native\/native-test\.mjs/g) ?? []).length === 2,
  'release must validate native backend, update integrity and actual WebViews on both platforms');
check(release.includes("pattern: '*-x64'"), 'release assembly must exclude verification evidence from download assets');

const releaseWorkflow = parse(release);
check(Object.hasOwn(releaseWorkflow.on, 'workflow_dispatch'), 'candidate builds require manual dispatch');
for (const job of ['windows', 'release-draft']) check(releaseWorkflow.jobs[job]?.if === "github.event_name == 'push'", `${job}: manual candidates must not publish or build Windows`);
const matrix = releaseWorkflow.jobs.macos?.strategy?.matrix?.include ?? '';
const choices = [...matrix.matchAll(/'([\[{][^']+)'/g)].map(match => JSON.parse(match[1]));
check(matrix.includes("github.event_name == 'workflow_dispatch'") && choices.length === 2
  && JSON.stringify(choices[0]) === JSON.stringify([{os:'macos-15-intel', arch:'x64'}])
  && choices[1].some(target => target.os === 'macos-15' && target.arch === 'arm64')
  && choices[1].some(target => target.os === 'macos-15-intel' && target.arch === 'x64'),
  'release must build both Mac architectures; manual dispatch builds only Intel');
check(releaseWorkflow.jobs['release-draft'].needs.includes('macos'), 'draft assembly must wait for all Mac candidates');
const ciWorkflow = parse(await readFile(path.join(workflowRoot, 'ci.yml'), 'utf8'));
check(ciWorkflow.jobs['platform-compile'].strategy.matrix.os.includes('macos-15-intel'), 'CI must validate native Intel Mac');
for (const [name, workflow] of [['ci', ciWorkflow], ['release', releaseWorkflow]]) {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) if (step.uses?.startsWith('actions/cache/restore@')) {
      check(step.with.key.includes('runner.arch'), `${name}: native caches must distinguish architectures`);
    }
  }
}

const published = await readFile(path.join(workflowRoot, 'verify-release.yml'), 'utf8');
check(published.includes('tools/native/published-artifact-test.mjs') && !published.includes('build-update-baseline'),
  'published verification must exercise downloaded native artifacts rather than an Electron-only baseline');

check(parse(published).jobs.verify.strategy.matrix.os.includes('macos-15-intel'), 'published verification must include Intel Mac');

const pages = await readFile(path.join(workflowRoot, 'pages.yml'), 'utf8');
check(pages.includes('deploy-pages'), 'Pages workflow must deploy with actions/deploy-pages');
check(pages.includes('DOCS_BASE: /docs/'), 'Pages workflow must publish documentation beneath the website');
check(pages.includes('npm run build:site') && pages.includes('npm run test:site') && pages.includes('path: test-results/site-preview'), 'Pages must build and verify the actual website before deployment');

if (failures.length) {
  console.error('GitHub workflow check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('PASS GitHub workflows: CI, Pages and draft release framework');

function check(condition, message) {
  if (!condition) failures.push(message);
}
