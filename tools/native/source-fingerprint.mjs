import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const files = new Set(['docs/shared-core-sync.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'tools/build/esbuild.config.mjs', 'esbuild.config.mjs', 'THIRD_PARTY_NOTICES.md', 'release-contract.json', 'LICENSE', 'NOTICE', 'docs/licenses/third-party-notices.md', 'tools/icons/generate-macos-dmg-background.swift']);
const prefixes = ['src/', 'src-native/', 'assets/', 'tools/', 'web/site/', 'docs/licenses/'];
export async function sourceFingerprint(root) {
  const paths = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(path => path && (files.has(path) || prefixes.some(prefix => path.startsWith(prefix)))))].sort();
  const entries = [];
  const checkedDirectories = new Set();
  for (const path of paths) {
    // Git may enumerate files through a Windows junction as ordinary paths.
    // Check ancestors as well as the leaf so such inputs cannot escape root.
    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth++) {
      const directory = segments.slice(0, depth).join('/');
      if (checkedDirectories.has(directory)) continue;
      const meta = await lstat(join(root, directory)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (meta?.isSymbolicLink()) throw Error('原生构建输入不是普通文件：' + path);
      checkedDirectories.add(directory);
    }
    const absolute = join(root, path);
    let meta;
    try { meta = await lstat(absolute); } catch (error) { if (error.code === 'ENOENT') { entries.push({ path, deleted: true }); continue; } throw error; }
    if (!meta.isFile() || meta.isSymbolicLink()) throw Error('原生构建输入不是普通文件：' + path);
    const bytes = await readFile(absolute);
    entries.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), fileCount: entries.length };
}

export async function verifyCandidate({ root, report, binary, allowManualAcceptance = false }) {
  const manualAcceptance = allowManualAcceptance && report.buildMode === 'manual-acceptance' && report.candidate?.bundleId === 'app.xwxdeck.desktop';
  if (!manualAcceptance && report.candidate?.bundleId !== 'app.xwxdeck.validation') throw Error('隔离启动需要 XwXDeck 验证构建；不会启动或替换正式应用。');
  if (!report.sourceFingerprint) throw Error('验证包缺少源码指纹，可能是旧阶段产物。请先运行 npm run build:native:isolated。');
  const current = await sourceFingerprint(root);
  if (current.sha256 !== report.sourceFingerprint) throw Error('验证包与当前本地源码不一致。请先运行 npm run build:native:isolated，避免检查旧界面或后端。');
  const hash = createHash('sha256').update(await readFile(binary)).digest('hex');
  if (hash !== report.candidate.binarySha256) throw Error('验证包可执行文件与构建清单不一致，已阻止启动；请重新构建。');
  return { commit: report.commit, sourceFingerprint: current.sha256, binarySha256: hash, isolated: true, buildMode: report.buildMode ?? 'isolated' };
}

export async function directoryFingerprint(root) {
  const entries = [];
  async function scan(directory, relative = '') {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), local = relative ? relative + '/' + name : name, meta = await lstat(path);
      if (meta.isSymbolicLink()) throw Error('嵌入资源经过符号链接：' + local);
      if (meta.isDirectory()) await scan(path, local);
      else if (meta.isFile()) entries.push({ path: local, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
      else throw Error('嵌入资源不是普通文件：' + local);
    }
  }
  await scan(root);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
