// Inventory of declared test entry points. This never executes product tests.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const read = path => readFileSync(join(root, path), 'utf8');
const catalog = JSON.parse(read('docs/test-catalog.json'));
const scripts = JSON.parse(read('package.json')).scripts;
const runner = read('tools/native/run-backend-tests.mjs');
const list = runner.match(/const suites\s*=\s*\[([\s\S]*?)\];/);
if (!list) throw Error('Backend entry-point format changed; review the inventory parser.');
const backend = new Set([...list[1].matchAll(/["']([^"']+\.mjs)["']/g)].map(match => 'tools/native/' + match[1]));
const conditional = new Set([...runner.matchAll(/suites\.push\(['"]([^'"]+)['"]\)/g)].map(match => 'tools/native/' + match[1]));
const built = new Set();
function walk(name, visiting = new Set()) {
  if (visiting.has(name)) throw Error('Cyclic npm entry point: ' + name);
  const command = scripts[name];
  if (!command) throw Error('Missing npm entry point: ' + name);
  const next = new Set([...visiting, name]);
  for (const match of command.matchAll(/\bnpm run ([\w:-]+)/g)) walk(match[1], next);
  for (const match of command.matchAll(/\bnode\s+(?:--test\s+)?(tools\/[\w/.-]+\.(?:mjs|js))/g)) built.add(match[1]);
}
walk('test:built');
const mapped = new Map();
for (const item of catalog.cases) for (const path of item.automation.scripts) {
  if (!existsSync(join(root, path))) throw Error('Missing mapped script: ' + path);
  if (!mapped.has(path)) mapped.set(path, []);
  mapped.get(path).push(item.id);
}
const category = path => backend.has(path) ? '后端默认入口' : built.has(path) ? 'test:built 入口' : conditional.has(path) ? '条件入口' : '独立专题入口';
const modules = catalog.modules.map(module => ({
  id: module.id,
  name: module.name,
  caseIds: catalog.cases.filter(item => item.moduleId === module.id).map(item => item.id),
  scripts: [...new Set(catalog.cases.filter(item => item.moduleId === module.id).flatMap(item => item.automation.scripts))].sort().map(path => ({path, entry: category(path), caseIds: mapped.get(path)})),
}));
const unassigned = [...new Set([...backend, ...built, ...conditional])].filter(path => !mapped.has(path)).sort().map(path => ({path, entry:category(path)}));
const report = {schemaVersion:1, scope:'Declared entry points only; no execution, assertion coverage or pass result is inferred.', modules, unassigned};
let markdown = '# 自动化脚本入口映射\n\n';
markdown += '本文件由 `node tools/checks/report-test-coverage.mjs --write` 生成。\n';
markdown += '来源为功能目录、后端清单和 `test:built` 命令。\n';
markdown += '脚本入口不代表子场景全部覆盖，也不代表本次执行通过。\n';
markdown += '断言与真实环境要求见 [开发流程](development-testing-workflow.md) 和 [Trace 状态矩阵](maintenance/trace-state-acceptance.md)。\n\n';
markdown += '后端默认入口由 `test:native:backend` 执行。\n';
markdown += '`check:quality` 编译当前源码后调用该入口。\n';
markdown += '`test:built` 入口也属于工程门禁。\n';
markdown += '条件入口依赖环境和已安装客户端。\n';
markdown += '独立专题入口需要另行选择，不能假设默认门禁已执行。\n';
markdown += '本表只展开 npm 命令直接列出的脚本。\n';
markdown += '包装脚本内部的导入、Rust 单测与原生界面套件需按各自报告核对。\n';
markdown += '平台跳过、真实授权与付费生成另行登记。\n\n';
for (const module of modules) {
  markdown += `## ${module.id} ${module.name}\n\n`;
  markdown += `功能编号：${module.caseIds.map(id => '`' + id + '`').join('、')}。\n\n`;
  markdown += '| 脚本 | 执行入口 | 关联编号 |\n| --- | --- | --- |\n';
  for (const item of module.scripts) markdown += `| [${item.path.split('/').at(-1)}](../${item.path}) | ${item.entry} | ${item.caseIds.join('、')} |\n`;
  markdown += '\n';
}
markdown += '## 尚未关联稳定编号的门禁脚本\n\n';
markdown += '这些脚本已列入命令，但功能目录未引用。\n';
markdown += '新增或调整断言时，应补充对应编号。\n';
markdown += '本表不会自动创建验收项目或通过结果。\n\n';
if (unassigned.length === 0) markdown += '当前没有未关联编号的已声明入口。\n';
else markdown += '| 脚本 | 执行入口 |\n| --- | --- |\n';
for (const item of unassigned) markdown += `| [${item.path.split('/').at(-1)}](../${item.path}) | ${item.entry} |\n`;
const target = join(root, 'docs/test-coverage-map.md');
const args = process.argv.slice(2);
if (args.some(arg => !['--write','--check','--json'].includes(arg)) || args.length > 1) throw Error('Choose one of --write, --check, --json.');
if (args.includes('--json')) console.log(JSON.stringify(report,null,2));
else if (args.includes('--write')) {writeFileSync(target,markdown); console.log('Updated docs/test-coverage-map.md');}
else if (args.includes('--check')) {
  if (!existsSync(target) || readFileSync(target,'utf8') !== markdown) throw Error('Test entry-point map is stale. Run node tools/checks/report-test-coverage.mjs --write.');
  console.log(`PASS entry-point inventory: ${modules.length} modules, ${mapped.size} mapped scripts, ${unassigned.length} unassigned entry points`);
} else process.stdout.write(markdown);
