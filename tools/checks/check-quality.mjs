import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { rustToolchain } from '../native/toolchain.mjs';
import { sourceFingerprint } from '../native/source-fingerprint.mjs';

const root = resolve(import.meta.dirname, '../..');
const { cargo, env } = rustToolchain(root, { XWX_NATIVE_PILOT: '1' });
const source = await sourceFingerprint(root);
const git = args => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw Error('Cannot record quality-check source');
  return result.stdout.trim();
};
const baseline = { branch: git(['branch', '--show-current']), commit: git(['rev-parse', 'HEAD']), worktree: git(['status', '--porcelain']), sourceFingerprint: source.sha256 };
const binary = resolve(env.CARGO_TARGET_DIR, 'debug', process.platform === 'win32' ? 'xwx-deck-native.exe' : 'xwx-deck-native');
const npm = script => [process.execPath, [process.env.npm_execpath, 'run', script]];
if (!process.env.npm_execpath) throw Error('Run this check through npm run check:quality.');
const manifest = ['--manifest-path', resolve(root, 'src-native/Cargo.toml')];
const nativeBackendSupported = ['darwin', 'win32'].includes(process.platform);
const steps = [
  ['frontend compile and repository checks', ...npm('compile')],
  ['existing behavior and shared contracts', ...npm('test:built')],
  ['native embedded resources', process.execPath, ['tools/native/prepare.mjs']],
  ['Rust formatting', cargo, ['fmt', ...manifest, '--', '--check']],
  ['Rust static checks', cargo, ['clippy', '--locked', ...manifest, '--all-targets', '--', '-D', 'warnings']],
  ['Rust unit tests', cargo, ['test', '--locked', ...manifest]],
  ['current native test executable', cargo, ['build', '--locked', ...manifest]],
  ...(nativeBackendSupported ? [['isolated native requests and lifecycle', process.execPath, ['tools/native/run-backend-tests.mjs']]] : []),
];
if (!nativeBackendSupported) console.log('SKIP desktop backend acceptance: this public release targets Windows and macOS; source, Rust and frontend checks still run.');
const results = [];
for (const [name, command, args] of steps) {
  console.log(`\nQuality check: ${name}`);
  const started = Date.now();
  const run = spawnSync(command, args, { cwd: root, env: { ...env, XWX_NATIVE_TEST_BINARY: binary }, stdio: 'inherit' });
  results.push({ name, passed: run.status === 0 && !run.error, exitCode: run.status, error: run.error?.message, elapsedMs: Date.now() - started });
  if (!results.at(-1).passed) break;
}
const sourceUnchanged = source.sha256 === (await sourceFingerprint(root)).sha256;
const built = results.some(row => row.name === 'current native test executable' && row.passed);
const binarySha256 = built ? createHash('sha256').update(await readFile(binary)).digest('hex') : null;
const passed = sourceUnchanged && results.length === steps.length && results.every(row => row.passed);
await mkdir(resolve(root, 'test-results'), { recursive: true });
await writeFile(resolve(root, 'test-results/quality-summary.json'), JSON.stringify({ passed, ...baseline, sourceUnchanged, binarySha256, nativeBackendSupported, results,
  scope: 'Current source, isolated synthetic upstreams; GUI, real authorization, billing statements and other platforms are separate acceptance gates.' }, null, 2) + '\n');
if (!passed) process.exitCode = 1;
