import { build, Platform, Arch } from 'electron-builder';

// This lower-version executable is a test fixture only. It is never uploaded
// to Releases; the production package and source version stay unchanged.
if (!['darwin', 'win32'].includes(process.platform)) throw new Error('A native Windows or Mac host is required.');
await build({
  targets: process.platform === 'win32'
    ? Platform.WINDOWS.createTarget(['portable'], Arch.x64)
    : Platform.MAC.createTarget(['dir'], Arch.arm64),
  publish: 'never',
  config: { extraMetadata: { version: '0.9.9' }, directories: { output: 'release/baseline' } }
});
