import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve(process.argv[2] || 'release-assets');
const version = requiredEnv('RELEASE_VERSION');
const tag = requiredEnv('RELEASE_TAG');
const repository = requiredEnv('GITHUB_REPOSITORY');
if (tag !== `v${version}`) throw new Error(`Release tag ${tag} does not match version ${version}.`);

const artifactDefinitions = [
  { name: 'XwX-Deck-windows-x64.exe', platform: 'windows', arch: 'x64', required: true },
  { name: 'XwX-Deck-mac-arm64.dmg', platform: 'darwin', arch: 'arm64', required: true }
];

const names = new Set(await readdir(directory));
const files = [];
const checksumLines = [];
for (const definition of artifactDefinitions) {
  if (!names.has(definition.name)) {
    if (definition.required) throw new Error(`Missing release artifact: ${definition.name}`);
    continue;
  }
  const file = path.join(directory, definition.name);
  const details = await stat(file);
  const sha256 = await hash(file, 'sha256', 'hex');
  const sha512 = await hash(file, 'sha512', 'base64');
  const url = `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(definition.name)}`;
  files.push({
    platform: definition.platform,
    arch: definition.arch,
    name: definition.name,
    url,
    size: details.size,
    sha256
  });
  checksumLines.push(`${sha256}  ${definition.name}`);
  await writeFile(path.join(directory, `${definition.name}.sha256`), `${sha256}  ${definition.name}\n`, 'utf8');
  if (definition.platform === 'windows') {
    await writeFile(path.join(directory, 'latest.yml'), [
      `version: ${version}`,
      'files:',
      `  - url: ${url}`,
      `    sha512: ${sha512}`,
      `    size: ${details.size}`,
      `path: ${url}`,
      `sha512: ${sha512}`,
      `releaseDate: ${new Date().toISOString()}`,
      ''
    ].join('\n'), 'utf8');
  }
}

const publishedAt = new Date().toISOString();
await writeFile(path.join(directory, 'release.json'), `${JSON.stringify({
  schemaVersion: 1,
  channel: 'release',
  version,
  tag,
  publishedAt,
  changelog: `XwX Deck ${version}`,
  files
}, null, 2)}\n`, 'utf8');
await writeFile(path.join(directory, 'checksums.txt'), `${checksumLines.join('\n')}\n`, 'utf8');
await writeFile(path.join(directory, 'release-notes.md'), [
  `# XwX Deck ${version}`,
  '',
  '本版本提供 Windows x64 便携版和 Apple Silicon Mac 安装包。',
  '',
  '## 下载与更新',
  '',
  '- Windows：下载 `XwX-Deck-windows-x64.exe`，放在可写目录后双击运行。后续更新会校验安装包、替换原路径 EXE 并重新启动。',
  '- Apple Silicon Mac：下载 `XwX-Deck-mac-arm64.dmg`，将应用拖入“应用程序”。后续在应用内下载并校验新版 DMG，再手动拖拽替换。',
  '- 当前没有 Intel Mac、Windows ARM64 或 Linux 制品。',
  '',
  '## macOS 说明',
  '',
  'macOS 制品尚未使用 Developer ID 签名或 Apple 公证。请只从本仓库 Release 下载，核对 SHA-256，并按照 DMG 内的《首次打开说明》操作。',
  '',
  '## 校验',
  '',
  '本 Release 同时提供 `checksums.txt`、单文件 `.sha256` 和 GitHub Artifact Attestation。',
  ''
].join('\n'), 'utf8');

console.log(`Prepared public release ${tag}: ${files.map(file => file.name).join(', ')}`);

async function hash(file, algorithm, encoding) {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest(encoding);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}.`);
  return value;
}
