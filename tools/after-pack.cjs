const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

// XwX Deck does not use WebGPU. Electron ships Dawn's DirectX Shader Compiler
// for navigator.gpu/D3D12 workloads, while the desktop renderer uses Canvas2D
// and retains ANGLE, SwiftShader/Vulkan, and the D3D11 compiler for compositor
// fallback and RDP/display-device recovery.
const UNUSED_WINDOWS_RUNTIME_FILES = [
  'dxcompiler.dll',
  'dxil.dll'
];

async function trimUnusedElectronRuntime(context) {
  if (context.electronPlatformName !== 'win32') return;

  for (const fileName of UNUSED_WINDOWS_RUNTIME_FILES) {
    const filePath = path.join(context.appOutDir, fileName);
    await fs.rm(filePath, { force: true });
    console.log(`[after-pack] removed unused WebGPU runtime ${fileName}`);
  }
}

async function adHocSignMacApp(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const productFilename = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${productFilename}.app`);
  await execFileAsync('/usr/bin/codesign', [
    '--force',
    '--deep',
    '--sign',
    '-',
    '--timestamp=none',
    appPath
  ], { maxBuffer: 10 * 1024 * 1024 });
  await execFileAsync('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    appPath
  ], { maxBuffer: 10 * 1024 * 1024 });
  console.log(`[after-pack] applied and verified ad-hoc signature for ${productFilename}.app`);
}

module.exports = async function preparePackagedRuntime(context) {
  await trimUnusedElectronRuntime(context);
  await adHocSignMacApp(context);
};
