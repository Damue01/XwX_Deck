import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { inspectPublicHistory } from './public-history.mjs';
import { containsPrivateIdentifier, createIdentifierMatcher } from './privacy-identifiers.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const policy = JSON.parse(await readFile(path.join(root, 'tools/checks/repository-policy.json'), 'utf8'));
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const read = relative => readFile(path.join(root, relative), 'utf8');
const exists = async relative => { try { return await lstat(path.join(root, relative)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
check(policy.schemaVersion === 1, 'public policy schemaVersion must be 1');
check(policy.repositoryMode === 'standalone', 'repository must be marked standalone');
check(policy.historyStrategy === 'new-root-history', 'repository must preserve independent history');
const patterns = [...policy.forbiddenPatterns, ...policy.historyPatterns].map(pattern => new RegExp(pattern, 'iu'));
const excludedDirectories = new Set(['.git', 'node_modules', 'dist', 'release', 'release-native', 'release-upload', 'target', 'gen', 'test-results', '.cache', '.temp']);
const textExtension = /\.(?:c?js|mjs|ts|tsx|rs|toml|json|md|html|css|txt|yml|yaml|bat|ps1|svg|map|m)$/iu;
const production = /^(?:src-native\/src|src\/renderer|src\/shared|web\/site)\//u;
const artifacts = ['dist/renderer', 'test-results/native-frontend', 'test-results/native-assets', 'test-results/site-preview'];
let sourceFiles = 0;
let artifactFiles = 0;
// Font compression can coincidentally contain a forbidden short name in base64.
// Only omit exact bundled WOFF2 bytes; arbitrary data URLs still get scanned.
const fontDigests = new Set();
for (const directory of ['assets/fonts', 'node_modules/@fontsource-variable/geist-mono/files']) {
  if (!(await exists(directory))?.isDirectory()) continue;
  for (const name of await readdir(path.join(root, directory))) if (name.endsWith('.woff2')) {
    const bytes = await readFile(path.join(root, directory, name));
    if (bytes.toString('ascii', 0, 4) === 'wOF2') fontDigests.add(createHash('sha256').update(bytes).digest('hex'));
  }
}
function withoutBundledFonts(content) {
  return content.replace(/data:font\/woff2;base64,([A-Za-z0-9+/=]+)/gu, (url, encoded) => {
    const bytes = Buffer.from(encoded, 'base64');
    return fontDigests.has(createHash('sha256').update(bytes).digest('hex')) ? 'bundled-woff2-font' : url;
  });
}

function rejectedPatterns(content, relative, generated, matcher = containsPrivateIdentifier) {
  content = withoutBundledFonts(content);
  const fingerprint = /private-identifier-fingerprint/;
  if (!generated || !/\.[cm]?js$/iu.test(relative)) return [...patterns.filter(pattern => pattern.test(content)), ...(matcher(content) ? [fingerprint] : [])];
  // Minifiers may use any short local binding. Product strings and public
  // property names retain meaning, including escaped and template literals.
  // Long brands, addresses and personal paths still receive a full-text scan.
  const literalTexts = [];
  const source = ts.createSourceFile(relative, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length) throw Error(`Cannot inspect generated JavaScript ${relative}`);
  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) literalTexts.push(node.text);
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      if ((ts.isPropertyAccessExpression(parent) && parent.name === node)
        || ((ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent) || ts.isMethodDeclaration(parent)
          || ts.isPropertyDeclaration(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) && parent.name === node)) literalTexts.push(node.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...patterns.filter(pattern => pattern.test(content) || literalTexts.some(text => pattern.test(text))),
    ...(matcher(content, { includeShort: false }) || literalTexts.some(text => matcher(text)) ? [fingerprint] : [])];
}

// Exact known font bytes may be skipped; unknown payloads and surrounding text may not.
const fontFixturePath = 'assets/fonts/' + (await readdir(path.join(root, 'assets/fonts'))).find(name => name.endsWith('.woff2'));
const fontFixture = 'data:font/woff2;base64,' + (await readFile(path.join(root, fontFixturePath))).toString('base64');
const fixtureName = 'fixturecode';
const fixtureMatcher = createIdentifierMatcher([{ length: fixtureName.length, sha256: createHash('sha256').update(fixtureName).digest('hex'), short: true }]);
check(withoutBundledFonts(fontFixture) === 'bundled-woff2-font', 'bundled fonts must match their actual bytes');
check(withoutBundledFonts('data:font/woff2;base64,dW5rbm93bg==') === 'data:font/woff2;base64,dW5rbm93bg==', 'unknown data payloads must remain inspected');
check(rejectedPatterns(fontFixture + ' ' + fixtureName, 'fixture.css', true, fixtureMatcher).length > 0, 'text around bundled fonts must remain inspected');

// Exercise the generated-code exception without writing fixtures into a build.
const generatedFixture = 'function ' + fixtureName + '(e){return e.visibility}const ' + fixtureName.toUpperCase() + '=10;';
check(rejectedPatterns(generatedFixture, 'fixture.js', true, fixtureMatcher).length === 0, 'minified local names must not be mistaken for branding');
check(rejectedPatterns(generatedFixture, 'fixture.js', false, fixtureMatcher).length > 0, 'source files must retain the strict full-text scan');
for (const text of [JSON.stringify(fixtureName), '`' + fixtureName + ' ${value}`', '"\\u0066ixturecode"', '({' + fixtureName + ':true})', 'value.' + fixtureName]) {
  check(rejectedPatterns(text, 'fixture.js', true, fixtureMatcher).length > 0, 'generated strings, templates, escaped literals and property names must reject short branding');
}


async function inspect(directory, generated = false) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!generated && (excludedDirectories.has(entry.name) || entry.name.startsWith('.tmp-'))) continue;
    const file = path.join(directory, entry.name);
    const relative = path.relative(root, file).split(path.sep).join('/');
    check(!containsPrivateIdentifier(relative), `${relative}: forbidden filename`);
    if (entry.isDirectory()) { await inspect(file, generated); continue; }
    if (!entry.isFile() || !textExtension.test(entry.name)) continue;
    generated ? artifactFiles++ : sourceFiles++;
    let content = await readFile(file, 'utf8');
    // Dependency integrity is an opaque digest, rather than product text.
    if (entry.name === 'package-lock.json') content = content.replace(/"integrity"\s*:\s*"[^"]*"/gu, '"integrity":"package-manager-digest"');
    for (const pattern of rejectedPatterns(content, relative, generated)) check(false, `${relative}: forbidden branding, address or personal path (${pattern.source})`);
    if (production.test(relative) || generated) {
      for (const method of policy.forbiddenRpcMethods) check(!content.includes(method), `${relative}: removed RPC ${method}`);
      for (const event of policy.forbiddenRuntimeEvents) check(!content.includes(event), `${relative}: removed event ${event}`);
      for (const type of policy.forbiddenProductionIdentifiers) check(!new RegExp(`\\b${type}\\b`, 'u').test(content), `${relative}: removed feature identifier ${type}`);
    }
  }
}
await inspect(root);
for (const directory of artifacts) if ((await exists(directory))?.isDirectory()) await inspect(path.join(root, directory), true);
for (const relative of policy.forbiddenFeaturePaths) check(!await exists(relative), `${relative}: removed feature path still exists`);
check(!await exists('src/main'), 'production TypeScript backend must be removed');
check(!await exists('tools/legacy'), 'public repository must not import historical private fixtures');

const [pkg, contract, tauri, settings, main, core, metadata, updates, cargo] = await Promise.all([
  read('package.json').then(JSON.parse), read('release-contract.json').then(JSON.parse), read('src-native/tauri.conf.json').then(JSON.parse),
  read('src-native/src/settings.rs'), read('src-native/src/main.rs'), read('src-native/src/core.rs'), read('src-native/src/metadata.rs'), read('src-native/src/updates.rs'), read('src-native/Cargo.toml'),
]);
check(pkg.name === 'xwx-deck', 'package identity must remain public');
check(tauri.identifier === 'app.xwxdeck.desktop', 'native application ID must remain public');
check(tauri.productName === 'XwX Deck' && tauri.version === pkg.version, 'native product/version must match package');
check(contract.identity?.dataNamespace === 'xwx-deck' && contract.identity?.appId === tauri.identifier, 'public data/application identity must match');
check(main.includes('join("xwx-deck")') && main.includes('Library/Application Support/xwx-deck'), 'native default data roots must retain the public namespace');
check(contract.identity?.gatewayPort === 45233 && core.includes('const GATEWAY_PORT: u16 = 45233;') && core.includes('bind_gateway_listener(gateway_listen_port(self.isolated))'), 'Gateway must retain the fixed independent public port');
check(/name\s*=\s*"xwx-deck-native"/u.test(cargo), 'native binary identity must remain public');
for (const feature of ['configurationSync', 'toolsPage', 'conversationDiagnostics', 'excelToMarkdown']) check(contract.features?.[feature] === false, `release contract must disable ${feature}`);
check(contract.providerFramework?.defaultConnections?.length === 0, 'release contract must not seed connections');
check(contract.traceRetention?.defaultStorageLimitGB === 1 && contract.traceRetention?.automaticCleanupEnabledByDefault === true, 'release contract must preserve public retention defaults');
check(/connections:\s*vec!\[\s*\]/u.test(settings), 'native fresh registry must be empty');
check(/selected:\s*json!\(\s*\{\s*"codex"\s*:\s*null\s*,\s*"claude"\s*:\s*null\s*\}\s*\)/u.test(settings), 'native fresh client choices must be empty');
check(/trace_warning_gb:\s*1\.0/u.test(settings) && /trace_auto_cleanup:\s*true/u.test(settings), 'native public retention defaults must be 1 GB with cleanup');
check(core.includes('"getClaudeDesktopSync"') && core.includes('"updateClaudeDesktopSync"'), 'supported Desktop model integration must remain');
const publicFeed = 'https://github.com/Damue01/XwX_Deck/releases/latest/download';
check(contract.updates?.defaultServer === publicFeed && updates.includes(publicFeed), 'default update feed must remain public');
check(!/events:\s*"https?:\/\//u.test(metadata), 'metadata events must have no built-in remote endpoint');
check(/events:\s*String::new\(\)/u.test(metadata) || /events:\s*std::env::var\([^)]*\)[\s\S]{0,120}?\.unwrap_or_default\(\)/u.test(metadata), 'metadata push must default to an empty endpoint');
for (const name of ['electron', 'electron-builder', 'electron-updater']) check(!pkg.dependencies?.[name] && !pkg.devDependencies?.[name], `default dependency must exclude ${name}`);
check((await exists('tools/checks/check-runtime-boundary.mjs'))?.isFile(), 'current runtime dependency graph checker must exist');
const history = inspectPublicHistory(root, containsPrivateIdentifier, policy.historyPatterns, policy.historyAuthorEmailDomains);
failures.push(...history.failures);

if (failures.length) {
  console.error('Repository privacy check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else console.log(`PASS public boundary: ${sourceFiles} source text files, ${artifactFiles} current build files, ${history.counts.commit} historical commits, removed features, isolated identity and empty defaults`);
