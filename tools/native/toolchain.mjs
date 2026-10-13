import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
  return { cargo, env };
}
