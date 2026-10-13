import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { verifyCandidate } from './source-fingerprint.mjs';

const workspace = resolve(import.meta.dirname, '../..');
const production = process.argv.includes('--production');
const binary = resolve(import.meta.dirname, process.platform === 'darwin' ? (production ? '../../release-native/XwX Deck.app/Contents/MacOS/xwx-deck-native' : '../../test-results/rust-pilot-package/XwXDeck Rust Validation.app/Contents/MacOS/xwx-deck-native') : process.platform === 'win32' ? (production ? '../../release/XwX Deck.exe' : '../../test-results/native-package/XwX Deck.exe') : '../../test-results/native-target/release/xwx-deck-native');
const readiness = JSON.parse(await readFile(join(workspace, 'src-native/migration-status.json'), 'utf8'));
if (process.argv.includes('--check') && (production || !['darwin', 'win32'].includes(process.platform))) throw Error('--check 仅核对 macOS 或 Windows 隔离验证包，不会启动应用。');
if (production && readiness.productionReady !== true) throw Error('原生迁移尚未完整验收，不能启动生产目录。');
if (!production && ['darwin', 'win32'].includes(process.platform)) {
  const report = JSON.parse(await readFile(join(workspace, process.platform === 'win32' ? 'test-results/native-package/native-build-report.json' : 'test-results/rust-pilot-package/native-build-report.json'), 'utf8'));
  const verified = await verifyCandidate({ root: workspace, report, binary });
  if (process.argv.includes('--check')) { console.log(JSON.stringify(verified)); process.exit(0); }
}

const osCredentials = process.argv.includes('--os-credentials');
const liveMetadata = process.argv.includes('--live-metadata');
const rootFlag = process.argv.indexOf('--root');
if (liveMetadata && (production || rootFlag < 0)) throw Error('--live-metadata 需要显式 --root 独立真实验收目录。');
if (liveMetadata && ['XWX_DECK_TEST_SECURE_STORE', 'XWX_DECK_TEST_PRIVATE_STORE', 'XWX_DECK_TEST_MIGRATE_PRIVATE_STORE'].some(name => process.env[name] === '1')) throw Error('真实元数据不能与模拟凭据混用。');
if (osCredentials && (production || rootFlag < 0)) throw Error('--os-credentials 需要显式 --root 独立目录；目录会保留，不使用正常客户端或生产凭据命名空间。');
if (osCredentials && process.env.XWX_DECK_TEST_SECURE_STORE === '1') throw Error('系统凭据验证不能与模拟密钥同时启用。');
if (rootFlag >= 0 && !process.argv[rootFlag + 1]) throw Error('--root 需要独立配置目录。');
const sandbox = rootFlag >= 0
  ? resolve(process.argv[rootFlag + 1])
  : await mkdtemp(join(await realpath(tmpdir()), 'xwx-rust-pilot-manual-'));
if (!production) console.log(`Native isolated sandbox: ${sandbox}`);
console.log(production ? 'Starting the native XwX Deck runtime.' : 'Validation uses isolated client configuration.');
if (osCredentials) console.log('OS credentials: app.xwxdeck.validation.credentials; isolated client files, persistent validation data.');
else if (liveMetadata) console.log('Private credential files: isolated directory and client files; normal accounts are not used.');
else if (!production) console.log('Synthetic fixtures only: do not enter real account credentials in this mode.');
if (liveMetadata) console.log('Live owner metadata enabled; protocol readiness must be checked before real model acceptance.');
const child = spawn(binary, production ? [] : ['--pilot-root', sandbox, ...(osCredentials ? ['--pilot-os-credentials'] : []), ...(liveMetadata ? ['--pilot-live-metadata'] : [])], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
try {
  const [code] = await once(child, 'exit');
  process.exitCode = code ?? 1;
} finally {
  if(rootFlag < 0) await rm(sandbox,{recursive:true,force:true});
}
