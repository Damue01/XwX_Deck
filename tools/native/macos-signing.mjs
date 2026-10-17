import { spawn } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export async function appleReleaseConfig(root) {
  const config = JSON.parse(await readFile(resolve(root, 'assets/macos/native-release.json'), 'utf8'));
  if (!/^[A-Z0-9]{10}$/.test(config.teamId)) throw Error('Invalid Apple Developer Team ID');
  return config;
}
export async function appleTool(command, args) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? done(stdout.trim()) : reject(Error(`${command} failed (${code}): ${stderr || stdout}`)));
  });
}
export async function signMac(path, config, runtime = false, identifier) {
  await appleTool('/usr/bin/codesign', ['--force', '--sign', config.signingIdentity, '--timestamp', ...(runtime ? ['--options', 'runtime'] : []), ...(identifier ? ['--identifier', identifier] : []), path]);
  await appleTool('/usr/bin/codesign', ['--verify', '--deep', '--strict', path]);
}
export async function notarizeMac(path, config, reportPath) {
  console.log(`Submitting to Apple notarization: ${path}`);
  const sha256 = createHash('sha256').update(await readFile(path)).digest('hex');
  const submission = JSON.parse(await appleTool('/usr/bin/xcrun', ['notarytool', 'submit', path, '--keychain-profile', config.notaryProfile, '--no-s3-acceleration', '--no-wait', '--output-format', 'json']));
  await writeFile(reportPath, JSON.stringify({ ...submission, status: 'In Progress', uploaded: true, sha256 }, null, 2) + '\n');
  console.log(`Apple upload complete; waiting for submission ${submission.id}`);
  const result = JSON.parse(await appleTool('/usr/bin/xcrun', ['notarytool', 'wait', submission.id, '--keychain-profile', config.notaryProfile, '--output-format', 'json']));
  await writeFile(reportPath, JSON.stringify({ ...result, uploaded: true, sha256 }, null, 2) + '\n');
  if (result.status !== 'Accepted') {
    const log = await appleTool('/usr/bin/xcrun', ['notarytool', 'log', result.id, '--keychain-profile', config.notaryProfile]);
    await writeFile(reportPath + '.log.json', log + '\n');
    throw Error(`Apple notarization ${result.status}; see ${reportPath}.log.json`);
  }
  return { id: result.id, status: result.status };
}
export async function notarizeApp(app, config, reportPath) {
  const zip = reportPath + '.upload.zip';
  try {
    await appleTool('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
    const result = await notarizeMac(zip, config, reportPath);
    await appleTool('/usr/bin/xcrun', ['stapler', 'staple', app]);
    await appleTool('/usr/bin/xcrun', ['stapler', 'validate', app]);
    await appleTool('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
    return result;
  } finally { await rm(zip, { force: true }); }
}
