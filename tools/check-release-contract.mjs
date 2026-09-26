import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const [contract, packageJson, license, runtime, esbuild, applicationReset, ports, updater, updateServer, app, rail, preload, handlers, workflows] = await Promise.all([
  readJson('release-contract.json'), readJson('package.json'), readText('LICENSE'),
  readText('src/main/runtime.ts'),
  readText('esbuild.config.mjs'), readText('src/main/app/applicationReset.ts'),
  readText('src/main/trace/tapPortLock.ts'), readText('src/main/update/xwxDeckUpdater.ts'),
  readText('src/main/update/updateServer.ts'), readText('src/renderer/App.tsx'),
  readText('src/renderer/features/shell/Rail.tsx'), readText('src/main/preload.ts'),
  readText('src/main/ipc/registerHandlers.ts'),
  Promise.all([
    readText('.github/workflows/ci.yml'),
    readText('.github/workflows/pages.yml'),
    readText('.github/workflows/release.yml')
  ]).then(values => values.join('\n'))
]);
const failures = [];
check(contract.schemaVersion === 1, 'release contract schemaVersion must be 1');
check(contract.product === 'XwX Deck', 'release contract product mismatch');
check(contract.edition === 'standalone', 'release contract must describe the standalone edition');
check(packageJson.name === contract.identity.packageName, 'package name does not match the release contract');
check(packageJson.build?.appId === contract.identity.appId, 'appId does not match the release contract');
check(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageJson.version),
  'package version must be semantic');
check(packageJson.license === contract.openSource.license, 'package license must match the release contract');
check(license.includes('Apache License') && license.includes('Version 2.0'),
  'Apache License 2.0 text is required');
check(runtime.includes(`path.join(app.getPath('appData'), '${contract.identity.dataNamespace}')`), 'runtime userData namespace mismatch');
check(runtime.includes(`app.setAppUserModelId('${contract.identity.appId}')`), 'Windows app identity mismatch');
check(ports.includes(`PRIMARY_TAP_PORT = ${contract.identity.gatewayPortRange[0]}`), 'Gateway port range mismatch');
check(packageJson.build?.publish?.[0]?.url === contract.updates.defaultServer,
  'electron-builder update metadata must point to GitHub Releases');
check(updateServer.includes(`DEFAULT_UPDATE_SERVER = '${contract.updates.defaultServer}'`),
  'default updater must point to GitHub Releases');
check(updateServer.includes("DEFAULT_METADATA_PUSH_SERVER = ''"), 'metadata push must be disabled by default');
check(updater.includes('Boolean(updateServerUrl())'), 'updater must require explicit server configuration');
check(updater.includes('return this.serverUrl();'), 'updater feed must use the GitHub release download root directly');
check(JSON.stringify(contract.providerFramework?.userFields) === JSON.stringify(['displayName', 'baseUrl', 'key', 'adapter', 'codexModel']),
  'provider settings must expose the standalone connection fields');
check(contract.providerFramework?.discovery === 'automatic-or-explicit-adapter',
  'provider model discovery must remain automatic');
check(contract.providerFramework?.protocolSelection === 'explicit-adapter-or-per-model-metadata',
  'provider protocol selection must be driven by model metadata');
check(contract.providerFramework?.defaultConnections?.length === 0 && contract.features?.automaticTraceCleanup === false, 'no default providers or automatic history cleanup');
check(contract.features?.repairCenter === true, 'repair center must remain enabled');
check(contract.features?.safeExitRecovery === true, 'safe exit recovery must remain enabled');
check(contract.features?.toolsPage === true && contract.features?.conversationDiagnostics === true,
  'conversation diagnostics tools page must remain enabled');
check(contract.features?.configurationSync === false && contract.features?.excelToMarkdown === false,
  'configuration sync and Excel conversion must remain disabled');
check(preload.includes('repairApplication') && preload.includes('resetApplication'),
  'preload must expose the repair center actions');
check(handlers.includes('xwxdeck:repair-application') && handlers.includes('xwxdeck:reset-application'),
  'main process must register the repair center IPC');
check(runtime.includes('launchApplicationResetWorker') && esbuild.includes("'application-reset-worker': 'src/main/applicationResetWorker.ts'") && runtime.includes('shutdownControllerWithConfirmation') && runtime.includes('cancelShutdown'),
  'runtime must retain reset and cancellable configuration recovery');
check(esbuild.includes("'exit-recovery': 'src/main/exitRecovery.ts'"),
  'build must include the detached exit recovery entrypoint');
check(applicationReset.includes('assertSafeResetDirectory'),
  'application reset must keep its destructive-operation safety gate');
check(workflows.includes('npm run docs:build'), 'GitHub workflows must build the VitePress documentation');
check(workflows.includes('write-public-release-manifest.mjs'), 'release workflow must create public update manifests');
check(workflows.includes('--draft'), 'release workflow must create a draft before public release');
for (const [label, content] of Object.entries({ app, rail, preload, handlers })) {
  check(!/SyncPage|config-sync|excel-progress|convert-excel|choose-excel|open-excel|read-excel/.test(content), `${label} still exposes a removed feature`);
}
if (failures.length) {
  console.error('Release contract check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('PASS standalone XwX Deck release contract');
function check(condition, message) { if (!condition) failures.push(message); }
async function readText(file) { return readFile(path.join(root, file), 'utf8'); }
async function readJson(file) { return JSON.parse(await readText(file)); }
