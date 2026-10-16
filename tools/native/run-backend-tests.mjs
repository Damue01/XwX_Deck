import {homedir} from 'node:os';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, mkdtemp, realpath, copyFile, chmod, readFile, rm } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { nativeTestBinary } from './test-support.mjs';
import { existsSync } from 'node:fs';

// Every suite gets its own process, configuration root and local test service.
// Keep checking after a failure so a platform run reports all blocking issues.
const suites = [
  "public-binary-boundary-test.mjs",
  "public-boundary-test.mjs",
  "source-fingerprint-test.mjs",
  "regressions.mjs",
  "credential-vault-test.mjs",
  "credential-private-files-test.mjs",
  "official-private-files-test.mjs",
  "subscription-import-private-files-test.mjs",
  "credential-os-test.mjs",
  "credential-validation-test.mjs",
  "chatgpt-usage-test.mjs",
  "official-chatgpt-test.mjs",
  "upstream-diagnostics-test.mjs",
  "official-accounts-test.mjs",
  "official-chatgpt-renderer-test.mjs",
  "cli-home-lifecycle-test.mjs",
  "client-config-merge-test.mjs",
  "claude-config-path-test.mjs",
  "client-repair-test.mjs",
  "metadata-test.mjs",
  "model-metadata-consumption-test.mjs",
  "provider-catalog-test.mjs",
  "catalog-contract-test.mjs",
  "codex-client-compatibility-test.mjs",
  "catalog-contract-edges-test.mjs",
  "price-catalog-test.mjs",
  "models-dev-unification-test.mjs",
  "provider-presets-test.mjs",
  "provider-validation-test.mjs",
  "provider-identity-test.mjs",
  "config-import-test.mjs",
  "subscription-import-test.mjs",
  "subscription-import-renderer-test.mjs",
  "onboarding-renderer-test.mjs",
  "provider-dialog-renderer-test.mjs",
  "configuration-state-renderer-test.mjs",
  "enhancements-choices-renderer-test.mjs",
  "subscriptions-test.mjs",
  "subscription-routing-test.mjs",
  "service-switching-test.mjs",
  "service-switching-pool-test.mjs",
  "subscription-usage-test.mjs",
  "grok-subscriptions-test.mjs",
  "grok-secure-store-test.mjs",
  "copilot-subscriptions-test.mjs",
  "claude-subscriptions-test.mjs",
  "claude-secure-store-test.mjs",
  "cursor-subscriptions-test.mjs",
  "official-test.mjs",
  "official-websocket-proxy-test.mjs",
  "trace-native-sessions-test.mjs",
  "trace-session-navigation-test.mjs",
  "claude-native-sessions-test.mjs",
  "official-catalog-test.mjs",
  "protocol-test.mjs",
  "trace-client-evidence-test.mjs",
  "trace-viewer-renderer-test.mjs",
  "trace-cache-usage-test.mjs",
  "trace-usage-only-test.mjs",
  "trace-billing-test.mjs",
  "trace-stop-admission-test.mjs",
  "tool-wait-test.mjs",
  "universal-gateway-test.mjs",
  "expanded-clients-test.mjs",
  "client-models-renderer-test.mjs",
  "codex-models-renderer-test.mjs",
  "trace-index-repair-test.mjs",
  "portability-test.mjs",
  "routing-consumption-test.mjs",
  "preferences-test.mjs",
  "application-repair-test.mjs",
  "application-reset-test.mjs",
  "application-reset-private-files-test.mjs",
  "directory-lifecycle-test.mjs",
  "update-test.mjs",
  "settings-write-test.mjs",
  "legacy-recovery-test.mjs",
  "legacy-codex-test.mjs",
  "legacy-direct-test.mjs",
  "legacy-helper-test.mjs",
  "trace-writer-test.mjs",
  "desktop-lifecycle-test.mjs",
  "desktop-model-routing-test.mjs",
  "reasoning-test.mjs",
  "client-management-test.mjs",
  "client-trace-defaults-test.mjs",
  "language-test.mjs",
  "language-renderer-test.mjs",
  "toggle-renderer-test.mjs",
  "toast-renderer-test.mjs",
  "bridge-renderer-lifecycle-test.mjs",
  "portable-update-test.mjs"
];
const installedClientPaths = [process.env.XWX_DECK_INSTALLED_CODEX ?? join(homedir(), '.local/bin/codex'), process.env.XWX_DECK_INSTALLED_CLAUDE ?? join(homedir(), '.local/bin/claude')];
const installedClientsAvailable = (process.platform === 'darwin' || (process.platform === 'win32' && process.env.XWX_DECK_INSTALLED_CODEX && process.env.XWX_DECK_INSTALLED_CLAUDE)) && installedClientPaths.every(path => existsSync(path));
if (installedClientsAvailable) suites.push('installed-clients-test.mjs');
if (process.env.XWX_INSTALLED_PI || process.env.XWX_INSTALLED_OPENCODE) suites.push('gateway-clients-test.mjs');
const results = [];
const requestedSuites=process.argv.slice(2).map(argument=>{
  if(!argument.startsWith('--suite='))throw Error('Unknown backend test argument: '+argument);
  const suite=argument.slice('--suite='.length);
  if(!suites.includes(suite))throw Error('Unknown backend test suite: '+suite);
  return suite;
});
const activeSuites=requestedSuites.length?suites.filter(suite=>requestedSuites.includes(suite)):suites;
const temporaryRoot=await mkdtemp(join(await realpath(tmpdir()),'xwx-deck-native-tests-'));
let binary=join(temporaryRoot,process.platform==='win32'?'xwx-deck-native.exe':'xwx-deck-native');
const original=resolve(nativeTestBinary), appRoot=dirname(dirname(dirname(original)));
if(process.platform==='darwin' && basename(dirname(original))==='MacOS' && basename(dirname(dirname(original)))==='Contents' && appRoot.endsWith('.app')){
  // Developer ID binaries bind their Info.plist. Freeze the complete bundle,
  // preserving its signature instead of copying an executable out of its app.
  const staged=join(temporaryRoot,basename(appRoot));
  const copied=spawnSync('/usr/bin/ditto',[appRoot,staged],{encoding:'utf8'});
  if(copied.status!==0)throw Error('Unable to stage signed test app: '+copied.stderr);
  const verified=spawnSync('/usr/bin/codesign',['--verify','--deep','--strict',staged],{encoding:'utf8'});
  if(verified.status!==0)throw Error('Staged test app signature mismatch: '+verified.stderr);
  binary=join(staged,'Contents/MacOS',basename(original));
}else{await copyFile(original,binary);await chmod(binary,0o700);}
if(!Buffer.from(await readFile(original)).equals(await readFile(binary)))throw Error('Staged test binary changed');
const binarySha256=createHash('sha256').update(await readFile(binary)).digest('hex');
await mkdir('test-results', { recursive: true });
const logs = join(temporaryRoot, 'logs'); await mkdir(logs, {recursive:true});
try {for (const suite of activeSuites) {
  console.log(`\nNative suite: ${suite}`);
  const started = Date.now();
  const suiteRoot=join(temporaryRoot,suite.replace(/[^a-z0-9-]/gi,'-'));await mkdir(suiteRoot);
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, suite)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: suite === 'installed-clients-test.mjs' ? 600_000 : 180_000,
    env:{...process.env,XWX_NATIVE_TEST_BINARY:binary,TMPDIR:suiteRoot,TMP:suiteRoot,TEMP:suiteRoot} });
  const output = (result.stdout ?? '') + (result.stderr ?? ''); process.stdout.write(output);
  const log = join(logs, suite + '.log'); await writeFile(log, output);
  results.push({ suite, code: result.status, signal: result.signal, error: result.error?.message,
    ...(result.status !== 0 || result.error ? {log} : {}),
    skipped: (suite === 'portable-update-test.mjs' && process.platform !== 'win32') || (suite === 'cli-home-lifecycle-test.mjs' && process.platform === 'win32'), elapsedMs: Date.now() - started });
}}finally{if (results.length === activeSuites.length && results.every(result => result.code === 0 && !result.error)) await rm(temporaryRoot,{recursive:true,force:true});}
const failed = results.filter(result => result.code !== 0 || result.error);
await mkdir('test-results', { recursive: true });
await writeFile('test-results/native-backend-summary.json', JSON.stringify({ platform: process.platform, binarySha256, isolatedFixtures:true, fixturesCleaned:failed.length === 0, ...failed.length ? {retainedFixtures:temporaryRoot} : {}, installedClientsAvailable:Boolean(installedClientsAvailable), passed: failed.length === 0, results }, null, 2) + '\n');
console.log(`Native backend: ${results.length - failed.length}/${results.length} suites returned successfully; ${results.filter(result => result.skipped).length} platform-specific skips`);
if (failed.length) { console.error('Failed suites:', failed.map(result => result.suite).join(', ')); process.exitCode = 1; }
