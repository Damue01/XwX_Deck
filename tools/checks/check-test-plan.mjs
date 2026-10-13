import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const catalog = JSON.parse(readFileSync(join(root, 'docs/test-catalog.json'), 'utf8'));
const checklist = readFileSync(join(root, 'docs/core-functional-acceptance-checklist.md'), 'utf8');
const template = JSON.parse(readFileSync(join(root, 'docs/test-run-template.json'), 'utf8'));
const errors = [];
const moduleIds = new Set();
const caseIds = new Set();
const scripts = new Set();
const markdownIds = [...checklist.matchAll(/^\| ([A-Z]{2}\d{2}) \|/gm)].map(match => match[1]);
const checkPath = (path, context) => {
  if (typeof path !== 'string' || path.startsWith('/') || path.split('/').includes('..')) {
    errors.push(`${context}: path must be repository-relative`); return;
  }
  const absolute = join(root, path);
  if (!existsSync(absolute) || lstatSync(absolute).isSymbolicLink()) errors.push(`${context}: missing or symlinked path ${path}`);
};
if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.modules) || !Array.isArray(catalog.cases)) throw Error('Invalid test catalog schema');
for (const module of catalog.modules) {
  if (!/^[A-Z]{2}$/.test(module.id) || moduleIds.has(module.id)) errors.push(`Duplicate/invalid module ${module.id}`);
  moduleIds.add(module.id);
  if (!module.name || !module.automationScope || !module.realOperationScope || !module.sourcePaths?.length) errors.push(`${module.id}: missing module scope`);
  for (const path of module.sourcePaths ?? []) checkPath(path, module.id);
}
for (const item of catalog.cases) {
  if (!/^[A-Z]{2}\d{2}$/.test(item.id) || caseIds.has(item.id)) errors.push(`Duplicate/invalid case ${item.id}`);
  caseIds.add(item.id);
  if (!moduleIds.has(item.moduleId) || !item.id.startsWith(item.moduleId)) errors.push(`${item.id}: invalid module`);
  if (!['P0', 'P1', 'P2'].includes(item.priority) || !item.requirement || !item.realScenario) errors.push(`${item.id}: missing requirement/scenario`);
  if (!item.requiredEvidence?.length || item.requiredEvidence.some(level => !['P', 'R', 'U', 'H'].includes(level))) errors.push(`${item.id}: invalid evidence levels`);
  if (!['entry-points-only', 'planned'].includes(item.automation?.mappingStatus) || !item.automation?.gap) errors.push(`${item.id}: must state mapping boundary/gap`);
  if (item.automation?.mappingStatus === 'entry-points-only' && !item.automation.scripts?.length) errors.push(`${item.id}: mapped case has no script`);
  for (const path of item.automation?.scripts ?? []) { checkPath(path, item.id); scripts.add(path); }
  if (markdownIds.filter(id => id === item.id).length !== 1) errors.push(`${item.id}: markdown must contain one corresponding row`);
  const row = checklist.split('\n').find(line => line.startsWith(`| ${item.id} |`));
  if (row && !row.includes(item.requirement)) errors.push(`${item.id}: requirement differs between markdown and catalog`);
}
for (const id of markdownIds) if (!caseIds.has(id)) errors.push(`Markdown case missing from catalog: ${id}`);
for (const id of moduleIds) if (!catalog.cases.some(item => item.moduleId === id)) errors.push(`Module has no cases: ${id}`);
if (!template.templateOnly || template.status !== '待验' || !caseIds.has(template.caseId)) errors.push('Run template must remain unexecuted and reference a valid case');
const runner = readFileSync(join(root, 'tools/native/run-backend-tests.mjs'), 'utf8');
const separate = [...scripts].filter(path => !runner.includes('"' + path.split('/').at(-1) + '"'));
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else {
  console.log(`PASS test plan: ${moduleIds.size} modules, ${caseIds.size} stable IDs, ${scripts.size} existing script entry points`);
  console.log(`Separate topic/UI commands (not in backend runner): ${separate.join(', ')}`);
  console.log('Mapping validation only; no functional or real-environment acceptance is inferred.');
}
