import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const rootFlag = process.argv.indexOf('--root');
const sandbox = rootFlag >= 0
  ? resolve(process.argv[rootFlag + 1])
  : await mkdtemp(join(await realpath(tmpdir()), 'xwx-rust-pilot-manual-'));
const production = process.argv.includes('--production');
const binary = resolve(import.meta.dirname, process.platform === 'darwin' ? (production ? '../../release-native/XwX Deck.app/Contents/MacOS/xwx-deck-native' : '../../test-results/rust-pilot-package/XwX Deck Rust Pilot.app/Contents/MacOS/xwx-deck-native') : '../../test-results/native-target/release/xwx-deck-native' + (process.platform === 'win32' ? '.exe' : ''));
if (!production) console.log(`Native isolated sandbox: ${sandbox}`);
console.log(production ? 'Starting the native XwX Deck runtime.' : 'Validation uses isolated client configuration.');
const child = spawn(binary, production ? [] : ['--pilot-root', sandbox], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
const [code] = await once(child, 'exit');
process.exitCode = code ?? 1;
