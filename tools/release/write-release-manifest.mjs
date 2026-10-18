import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve(process.argv[2] || 'release-assets');
const version = requiredEnv('RELEASE_VERSION');
const tag = requiredEnv('RELEASE_TAG');
const repository = requiredEnv('GITHUB_REPOSITORY');
if (tag !== `v${version}`) throw new Error(`Release tag ${tag} does not match version ${version}.`);

const contract = JSON.parse(await readFile(new URL('../../release-contract.json', import.meta.url), 'utf8'));
const artifactDefinitions = Object.values(contract.platforms).flatMap(({ publishedArtifactName: name, portableArtifactName, platform, arch }) => [
  {name,platform,arch,kind:platform==='windows'?'installer':'disk-image'},...(portableArtifactName?[{name:portableArtifactName,platform,arch,kind:'portable'}]:[])
]);
if (artifactDefinitions.some(file => !file.name || !file.platform || !file.arch)
  || new Set(artifactDefinitions.map(file => file.name)).size !== artifactDefinitions.length
  || new Set(artifactDefinitions.map(file => `${file.platform}/${file.arch}/${file.kind}`)).size !== artifactDefinitions.length) {
  throw Error('Release contract has missing or duplicate artifact identities.');
}

const names = new Set(await readdir(directory));
for (const { name } of artifactDefinitions) {
  if (!names.has(name)) throw new Error(`Missing release artifact: ${name}`);
}
const files = [];
const checksumLines = [];
for (const definition of artifactDefinitions) {
  const file = path.join(directory, definition.name);
  const details = await stat(file);
  const sha256 = await hash(file, 'sha256', 'hex');
  const sha512 = await hash(file, 'sha512', 'base64');
  const url = `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(definition.name)}`;
  files.push({
    platform: definition.platform,
    arch: definition.arch,
    kind: definition.kind,
    name: definition.name,
    url,
    size: details.size,
    sha256
  });
  checksumLines.push(`${sha256}  ${definition.name}`);
  await writeFile(path.join(directory, `${definition.name}.sha256`), `${sha256}  ${definition.name}\n`, 'utf8');
  if (definition.platform === 'windows' && definition.kind === 'installer') {
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

const changelogSource = await readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
const heading = `## [${version}]`;
const start = changelogSource.indexOf(heading);
if (start < 0) throw new Error(`Missing changelog for ${version}`);
const next = changelogSource.indexOf('\n## [', start + heading.length);
const releaseChanges = changelogSource.slice(start, next < 0 ? undefined : next).trim();
const publishedAt = new Date().toISOString();
await writeFile(path.join(directory, 'release.json'), `${JSON.stringify({
  schemaVersion: 1,
  channel: 'release',
  releaseSeries: 'native-v1',
  version,
  tag,
  publishedAt,
  changelog: releaseChanges,
  files
}, null, 2)}\n`, 'utf8');
await writeFile(path.join(directory, 'checksums.txt'), `${checksumLines.join('\n')}\n`, 'utf8');
await writeFile(path.join(directory, 'release-notes.md'), [
  `# XwX Deck ${version}`,
  '',
  releaseChanges,
  '',
  '本版本提供 Windows x64 按用户安装包和便携版，以及 Apple Silicon 和 Intel Mac 安装包。',
  '',
  '## 下载与更新',
  '',
  '- Windows：下载 `XwX-Deck-windows-x64-setup.exe`，选择位置并安装到当前用户。后续更新会校验 Setup、升级并重新启动；卸载保留配置与数据。',
  '- Windows 便携版：下载 `XwX-Deck-windows-x64.exe`，放在可写目录运行。后续更新继续校验并替换原路径 EXE。',
  '- Apple Silicon Mac：下载 `XwX-Deck-mac-arm64.dmg`，将应用拖入“应用程序”。后续在应用内下载并校验新版 DMG，再手动拖拽替换。',
  '- Intel Mac：下载 `XwX-Deck-mac-x64.dmg`，安装与更新方式同 Apple Silicon Mac。',
  '- 当前没有 Windows ARM64 或 Linux 制品。',
  '',
  '## macOS 说明',
  '',
  'macOS 制品的签名、公证和票据装订结果见对应制品的验收记录。请从本仓库 Release 下载，并核对 SHA-256。',
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
