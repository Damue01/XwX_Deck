import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const docs = [
  'README.md',
  'docs/product.md',
  '.github/CONTRIBUTING.md',
  '.github/SECURITY.md',
  'docs/README.md',
  'docs/index.md',
  'docs/download.md',
  'docs/getting-started.md',
  'docs/user-manual.md',
  'docs/macos-first-run.md',
  'docs/provider-compatibility.md',
  'docs/provider-setup-and-routing.md',
  'docs/github-release.md',
  'docs/architecture.md',
  'docs/repository-boundary.md',
  'docs/roadmap.md',
  'docs/maintenance/engineering-notes.md',
  'docs/ux-product-requirements.md',
  'docs/documentation-style-guide.md',
  'docs/maintenance/integration-acceptance.md',
  'docs/testing-strategy.md',
  'docs/core-functional-acceptance-checklist.md'
];
const collectMarkdown = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  if (entry.name.startsWith('.')) return [];
  const absolute = path.join(directory, entry.name);
  return entry.isDirectory() ? collectMarkdown(absolute) : entry.name.endsWith('.md') ? [path.relative(root, absolute)] : [];
});
for (const relative of collectMarkdown(path.join(root, 'docs'))) {
  if (!docs.includes(relative)) docs.push(relative);
}
const errors = [];
for (const relative of docs) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) { errors.push(`${relative}: missing`); continue; }
  const content = fs.readFileSync(absolute, 'utf8');
  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1];
    const sourcePrefix = 'https://github.com/Damue01/XwX_Deck/blob/main/';
    if (target.startsWith(sourcePrefix)) {
      const sourcePath = decodeURIComponent(target.slice(sourcePrefix.length).split('#', 1)[0]);
      if (!fs.existsSync(path.resolve(root, sourcePath))) errors.push(`${relative}: broken source link ${target}`);
      continue;
    }
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const resolved = path.resolve(path.dirname(absolute), target.split('#', 1)[0]);
    if (!fs.existsSync(resolved)) errors.push(`${relative}: broken link ${target}`);
  }
}
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
for (const phrase of ['XwX Deck','好工具，更简单','Apache License 2.0','https://xwxdeck.com/docs/','GitHub Releases']) {
  if (!readme.includes(phrase)) errors.push(`README.md: missing ${phrase}`);
}
const development = fs.readFileSync(path.join(root, 'docs/development.md'), 'utf8');
for (const phrase of [packageJson.version,'app.xwxdeck.desktop','127.0.0.1:45233','客户端配置同步','对话诊断']) {
  if (!development.includes(phrase)) errors.push(`docs/development.md: missing ${phrase}`);
}
const manual = fs.readFileSync(path.join(root, 'docs/user-manual.md'), 'utf8');
if (!manual.includes(`适用版本：XwX Deck ${packageJson.version}`)) errors.push('docs/user-manual.md: version line does not match package.json');
if (errors.length) {
  console.error('Documentation consistency check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`PASS documentation consistency (${docs.length} standalone documents)`);
