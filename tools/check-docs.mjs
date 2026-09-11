import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const docs = [
  'README.md',
  'PRODUCT.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/README.md',
  'docs/index.md',
  'docs/getting-started.md',
  'docs/user-manual.md',
  'docs/macos-first-run.md',
  'docs/provider-compatibility.md',
  'docs/github-release.md',
  'docs/architecture.md',
  'docs/public-release-boundary.md',
  'docs/roadmap.md'
];
const errors = [];
for (const relative of docs) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) { errors.push(`${relative}: missing`); continue; }
  const content = fs.readFileSync(absolute, 'utf8');
  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const resolved = path.resolve(path.dirname(absolute), target.split('#', 1)[0]);
    if (!fs.existsSync(resolved)) errors.push(`${relative}: broken link ${target}`);
  }
}
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
for (const phrase of ['XwX Deck','0.1.0','Apache License 2.0','app.xwxdeck.desktop','45233-45242','客户端配置同步','对话诊断','GitHub Releases']) {
  if (!readme.includes(phrase)) errors.push(`README.md: missing ${phrase}`);
}
const manual = fs.readFileSync(path.join(root, 'docs/user-manual.md'), 'utf8');
if (!manual.includes('适用版本：XwX Deck 0.1.x')) errors.push('docs/user-manual.md: version line missing');
if (packageJson.version !== '0.1.0') errors.push('package.json: standalone version must be 0.1.0');
if (errors.length) {
  console.error('Documentation consistency check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`PASS documentation consistency (${docs.length} standalone documents)`);
