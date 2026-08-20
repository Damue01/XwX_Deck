import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const RUNTIME_INPUTS = [
  'src/main',
  'package.json',
  'package-lock.json',
  'release-contract.json',
  'esbuild.config.mjs',
  'tools/gateway-build-id.mjs',
  'tools/raw-text-plugin.mjs',
  'assets/models-dev-pricing.json'
];

export async function computeGatewayBuildId(root) {
  const files = [];
  for (const input of RUNTIME_INPUTS) {
    const absolute = path.resolve(root, input);
    const inputStat = await stat(absolute);
    if (inputStat.isDirectory()) await collectFiles(absolute, files);
    else files.push(absolute);
  }
  files.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(root, file));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function collectFiles(directory, output) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(absolute, output);
    else if (entry.isFile()) output.push(absolute);
  }
}

function relative(root, file) {
  return path.relative(root, file).replaceAll(path.sep, '/');
}
