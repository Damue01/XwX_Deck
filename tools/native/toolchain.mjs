import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

/** Use an explicitly configured/bundled toolchain, otherwise the caller's PATH. */
export function rustToolchain(root, overrides = {}) {
  const env = { ...process.env, ...overrides };
  const tools = env.XWX_DECK_RUST_TOOLCHAIN || resolve(root, 'test-results/rust-toolchain');
  const executable = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const bundledCargo = resolve(tools, 'cargo/bin', executable);
  if (existsSync(bundledCargo) && !env.RUSTUP_HOME && !env.CARGO_HOME) {
    env.RUSTUP_HOME = resolve(tools, 'rustup');
    env.CARGO_HOME = resolve(tools, 'cargo');
  }
  const configuredCargo = env.CARGO_HOME && resolve(env.CARGO_HOME, 'bin', executable);
  const cargo = configuredCargo && existsSync(configuredCargo) ? configuredCargo : executable;
  env.CARGO_TARGET_DIR ||= resolve(root, 'test-results/native-target');
  const flags = env.CARGO_ENCODED_RUSTFLAGS !== undefined
    ? env.CARGO_ENCODED_RUSTFLAGS.split('\u001f').filter(Boolean)
    : (env.RUSTFLAGS ?? '').split(/\s+/u).filter(Boolean);
  for (const [from, to] of [[homedir(), '/user'], [resolve(root), '/src'],
    [env.CARGO_HOME || resolve(homedir(), '.cargo'), '/cargo'],
    [env.RUSTUP_HOME || resolve(homedir(), '.rustup'), '/rustup']]) {
    flags.push(`--remap-path-prefix=${from}=${to}`);
  }
  env.CARGO_ENCODED_RUSTFLAGS = flags.join('\u001f');
  return { cargo, env };
}
