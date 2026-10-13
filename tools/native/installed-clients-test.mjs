import {homedir} from 'node:os';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, mkdir, readFile, writeFile, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import {crc32, deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {nativeTestBinary} from './test-support.mjs';

// Run actual installed clients against synthetic local credentials and HTTP only.
// Proxy external requests into the rejecting local server; never read normal auth/config.
const codex = process.env.XWX_DECK_INSTALLED_CODEX ?? join(homedir(), '.local/bin/codex');
const claude = process.env.XWX_DECK_INSTALLED_CLAUDE ?? join(homedir(), '.local/bin/claude');
await Promise.all([access(codex), access(claude)]);
const root = await mkdtemp(join(await realpath(tmpdir()), 'xwxdeck-installed-clients-'));
const workspace = join(root, 'workspace');
const requests = [], checks = [], versions = {};
const binarySha256 = createHash('sha256').update(await readFile(nativeTestBinary)).digest('hex');
let passed = false;
let child, queue = [];
let toolPending = false;
let toolKind = 'codex';
const toolResult = 'isolated tool result';
const codexToolCommand = process.platform === 'win32' ? `Write-Output '${toolResult}'` : `printf '${toolResult}'`;
const token = 'SYNTHETIC-INSTALLED-CLIENT-TEST';
const answer = 'isolated client response';
const upstream = createServer(async (req, res) => {
  if (!['/v1/'].some(prefix => req.url.startsWith(prefix))) { res.writeHead(403); res.end('External network blocked by isolated test'); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : null;
  requests.push({path: req.url, body, auth: req.headers.authorization, key: req.headers['x-api-key']});
  if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({data: [{id: 'fixture-model'}, {id: 'compatible-model', supported_endpoint_types: ['anthropic-messages'], vision: true, tool_calling: true}]})); return; }
  if (req.url === '/v1/messages/count_tokens') { res.end('{"input_tokens":20}'); return; }
  const id = 'response-fixture-' + requests.length;
  const emit = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  if (req.url === '/v1/responses') {
    const message = {id: 'msg-' + id, type: 'message', status: 'completed', role: 'assistant', content: [{type: 'output_text', text: answer, annotations: []}]};
    const call = toolPending ? {id: 'fc-' + id, type: 'function_call', status: 'completed', call_id: 'isolated-call', name: 'exec_command', arguments: JSON.stringify({cmd: codexToolCommand, max_output_tokens: 64, login: false})} : null;
    toolPending = false;
    const response = {id, object: 'response', status: 'completed', model: body.model, output: [call ?? message], usage: {input_tokens: 10, output_tokens: 4, total_tokens: 14}};
    if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response)); return; }
    res.writeHead(200, {'content-type': 'text/event-stream'});
    emit({type: 'response.created', response: {...response, status: 'in_progress', output: []}});
    if (call) {
      emit({type: 'response.output_item.added', output_index: 0, item: {...call, status: 'in_progress', arguments: ''}});
      emit({type: 'response.function_call_arguments.delta', output_index: 0, item_id: call.id, delta: call.arguments});
      emit({type: 'response.function_call_arguments.done', output_index: 0, item_id: call.id, arguments: call.arguments});
      emit({type: 'response.output_item.done', output_index: 0, item: call});
      emit({type: 'response.completed', response}); res.end(); return;
    }
    emit({type: 'response.output_item.added', output_index: 0, item: {...message, status: 'in_progress', content: []}});
    emit({type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: message.id, part: {type: 'output_text', text: '', annotations: []}});
    emit({type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: message.id, delta: answer});
    emit({type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: message.id, text: answer});
    emit({type: 'response.content_part.done', output_index: 0, content_index: 0, item_id: message.id, part: message.content[0]});
    emit({type: 'response.output_item.done', output_index: 0, item: message});
    emit({type: 'response.completed', response}); res.end(); return;
  }
  if (req.url.startsWith('/v1/messages')) {
    const call = toolPending ? {type: 'tool_use', id: 'isolated-call', name: toolKind === 'claude' ? 'Bash' : 'exec_command', input: toolKind === 'claude' ? {command: `printf '${toolResult}'`, description: 'Local read-only fixture'} : {cmd: codexToolCommand, max_output_tokens: 64, login: false}} : null;
    toolPending = false;
    const response = {id, type: 'message', role: 'assistant', model: body.model, content: [call ?? {type: 'text', text: answer}], stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null, usage: {input_tokens: 10, output_tokens: 4}};
    if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response)); return; }
    res.writeHead(200, {'content-type': 'text/event-stream'});
    emit({type: 'message_start', message: {...response, content: [], stop_reason: null, usage: {input_tokens: 10, output_tokens: 0}}});
    if (call) {
      emit({type: 'content_block_start', index: 0, content_block: {...call, input: {}}});
      emit({type: 'content_block_delta', index: 0, delta: {type: 'input_json_delta', partial_json: JSON.stringify(call.input)}});
      emit({type: 'content_block_stop', index: 0});
      emit({type: 'message_delta', delta: {stop_reason: 'tool_use', stop_sequence: null}, usage: {output_tokens: 4}});
      emit({type: 'message_stop'}); res.end(); return;
    }
    emit({type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}});
    emit({type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: answer}});
    emit({type: 'content_block_stop', index: 0});
    emit({type: 'message_delta', delta: {stop_reason: 'end_turn', stop_sequence: null}, usage: {output_tokens: 4}});
    emit({type: 'message_stop'}); res.end(); return;
  }
  if (req.url === '/v1/chat/completions') {
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write('data: ' + JSON.stringify({id, model: body.model, choices: [{index: 0, delta: {role: 'assistant', content: answer}, finish_reason: null}]}) + '\n\n');
    res.write('data: ' + JSON.stringify({id, model: body.model, choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: {prompt_tokens: 10, completion_tokens: 4, total_tokens: 14}}) + '\n\n');
    res.end('data: [DONE]\n\n'); return;
  }
  res.writeHead(404); res.end('{}');
});
upstream.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const base = `http://127.0.0.1:${upstream.address().port}`;
const isolatedHome = join(root, 'home');
const isolatedRoaming = join(isolatedHome, 'AppData', 'Roaming'), isolatedLocal = join(isolatedHome, 'AppData', 'Local');
const cliEnv = {...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome, APPDATA: isolatedRoaming, LOCALAPPDATA: isolatedLocal,
  XDG_CONFIG_HOME: join(isolatedHome, '.config'), XDG_DATA_HOME: join(isolatedHome, '.local', 'share'),
  CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
  HTTP_PROXY: base, HTTPS_PROXY: base, ALL_PROXY: base, http_proxy: base, https_proxy: base, all_proxy: base,
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ANTHROPIC_API_KEY: token};
for (const key of Object.keys(cliEnv)) if ((/^(CODEX_|OPENAI_)/.test(key) && key !== 'CODEX_HOME') || /^(ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)$/.test(key)) delete cliEnv[key];
async function runCli(binary, args, expectedCode = 0, input) {
  const cli = spawn(binary, args, {cwd: workspace, env: cliEnv, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']});
  if (input !== undefined) cli.stdin.end(input);
  let stdout = '', stderr = ''; cli.stdout.on('data', b => stdout += b); cli.stderr.on('data', b => stderr += b);
  const timer = setTimeout(() => cli.kill('SIGKILL'), 45000);
  try { const [code] = await once(cli, 'exit'); assert.equal(code, expectedCode, stderr.slice(-4000) + stdout.slice(-4000) + JSON.stringify(requests.slice(-6).map(r=>r.path))); return {stdout, stderr}; }
  finally { clearTimeout(timer); if (cli.exitCode === null) cli.kill('SIGKILL'); }
}
function start() {
  child = spawn(nativeTestBinary, ['--rpc', '--pilot-root', root]); queue = [];
  createInterface({input: child.stdout}).on('line', line => queue.shift()?.(JSON.parse(line)));
  child.stderr.on('data', b => process.stderr.write(b));
}
function rpc(method, ...args) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(method + ' timeout')), 15000);
    queue.push(r => { clearTimeout(timer); r.ok ? resolve(r.result) : reject(Error(r.error)); });
    child.stdin.write(JSON.stringify({method, args}) + '\n');
  });
}
async function stop() { const exit = once(child, 'exit'); child.stdin.end(); assert.equal((await exit)[0], 0); }
function pass(label) { checks.push(label); console.log('PASS ' + label); }
const codexArgs = ['exec', '--strict-config', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '-s', 'read-only', '--json', '--color', 'never', '-C', workspace, '-c', 'analytics.enabled=false', 'Return a short response. Do not call tools.'];
const claudeArgs = ['--bare', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--no-chrome', '--model', 'sonnet', '--output-format', 'json', '-p', 'Return a short response. Do not call tools.'];
try {
  start(); await rpc('getState'); await mkdir(workspace);
  await Promise.all([mkdir(isolatedRoaming, {recursive:true}), mkdir(isolatedLocal, {recursive:true})]);
  versions.codex = (await runCli(codex, ['--version'])).stdout.trim();
  versions.claude = (await runCli(claude, ['--version'])).stdout.trim();
  let registry = await rpc('saveProvider', {displayName: 'Fixture_8b4a3b5c', adapter: 'responses', baseUrl: base + '/v1', bearerToken: token, codexApiFormat: 'responses', codexModel: 'fixture-model'});
  const codexId = registry.connections.find(p => p.displayName === 'Fixture_8b4a3b5c').id;
  registry = await rpc('saveProvider', {displayName: 'Fixture_6533595c', adapter: 'anthropic-messages', baseUrl: base + '/v1', bearerToken: token, codexModel: 'fixture-model', claudeModels: {sonnet: 'fixture-model', opus: 'fixture-model', haiku: 'fixture-model'}});
  const claudeId = registry.connections.find(p => p.displayName === 'Fixture_6533595c').id;
  await rpc('switchClientProvider', {client: 'codex', providerId: codexId});
  await rpc('switchClientProvider', {client: 'claude', providerId: claudeId});
  await rpc('updateClaudeModels', {sonnet:'fixture-model', opus:'fixture-model', haiku:'fixture-model'});
  await writeFile(join(root, 'model-capabilities-cache.json'), JSON.stringify({version: 1, modelsDev: ['fixture-model', 'compatible-model'].map(modelId => ({modelId, providerId: 'fixture', sourceId: 'fixture/' + modelId, canonicalModelId: 'fixture/' + modelId, aliases: [modelId], referencePriority: 0, capability: {vision: true, toolCalling: true, reasoning: false, contextWindow: 32768, maxOutputTokens: 4096, inputModalities: ['text', 'image']}})), litellm: []}));
  await rpc('fetchProviderModels', {providerId: codexId, refresh: true});
  const directCodex = await runCli(codex, codexArgs);
  assert.ok(directCodex.stdout.includes(answer)); assert.equal(requests.at(-1).auth, 'Bearer ' + token);
  pass('installed Codex loads the generated strict config and catalog and completes a real local Responses SSE request');
  const image = join(workspace, 'fixture.png');
  const pngChunk = (type, data) => { const bytes = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(bytes)); return Buffer.concat([length, bytes, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  await writeFile(image, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255]))), pngChunk('IEND', Buffer.alloc(0))]));
  const imageArgs = [...codexArgs.slice(0, -1), '-i', image, '--', 'Inspect the provided image without calling tools.'];
  const imageReply = await runCli(codex, imageArgs); assert.ok(imageReply.stdout.includes(answer));
  assert.ok(JSON.stringify(requests.at(-1).body.input).includes('data:image/'), 'Codex did not attach an image payload');
  pass('installed Codex consumes generated image capability and sends the actual image payload to the configured upstream');
  toolPending = true; const toolStart = requests.length;
  const toolArgs = [...codexArgs.slice(0, -1), 'Run the requested harmless output tool once, then return a short response.'];
  const executed = await runCli(codex, toolArgs); assert.ok(executed.stdout.includes(answer));
  const toolCalls = requests.slice(toolStart).filter(r => r.path === '/v1/responses'); assert.equal(toolCalls.length, 2);
  assert.ok(toolCalls[1].body.input.some(i => i.type === 'function_call_output' && i.call_id === 'isolated-call' && JSON.stringify(i.output).includes(toolResult)));
  pass('installed Codex executes one harmless read-only tool and returns the same call identity and real tool output without replay');
  const directClaude = await runCli(claude, claudeArgs);
  assert.ok(directClaude.stdout.includes(answer)); assert.ok(requests.some(r => r.path.startsWith('/v1/messages') && (r.key === token || r.auth === 'Bearer ' + token)));
  assert.equal(requests.at(-1).body.model, 'fixture-model');
  pass('installed Claude loads isolated generated settings and completes a real local Messages SSE request without Keychain login');
  const claudeImageArgs = [...claudeArgs.slice(0,-1).map(arg => arg === 'json' ? 'stream-json' : arg), '--verbose', '--input-format', 'stream-json'];
  const claudeImageInput = JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text:'Inspect this image without calling tools.'},{type:'image',source:{type:'base64',media_type:'image/png',data:(await readFile(image)).toString('base64')}}]}})+'\n';
  assert.ok((await runCli(claude,claudeImageArgs,0,claudeImageInput)).stdout.includes(answer));
  assert.ok(requests.at(-1).body.messages.some(m=>m.content?.some?.(c=>c.type==='image'&&c.source?.data)));
  pass('installed Claude uses the saved role model and sends a real image payload with isolated generated connection settings');
  const claudeToolArgs = [...claudeArgs.slice(0,-1).map(arg => arg === '' ? 'Bash' : arg), '--allowedTools', 'Bash(printf*)', '--max-turns', '3', 'Execute the requested harmless printf tool once, then respond.'];
  toolPending=true;toolKind='claude';let claudeToolStart=requests.length;
  const claudeToolReply = await runCli(claude,claudeToolArgs);assert.ok(claudeToolReply.stdout.includes(answer));
  let claudeToolCalls=requests.slice(claudeToolStart).filter(r=>r.path.startsWith('/v1/messages'));
  assert.equal(claudeToolCalls.length,2);assert.ok(claudeToolCalls[1].body.messages.some(m=>m.content?.some?.(c=>c.type==='tool_result'&&c.tool_use_id==='isolated-call'&&JSON.stringify(c.content).includes(toolResult))));
  toolKind='codex';pass('installed Claude executes only the allowed harmless tool and returns its actual result with the original call identity');
  await rpc('toggleTracing', true); const live = await rpc('getState');
  assert.ok((await readFile(join(root, 'codex/config.toml'), 'utf8')).includes(new URL(live.localBaseUrl).port));
  assert.ok((await runCli(codex, codexArgs)).stdout.includes(answer));
  assert.ok((await runCli(claude, claudeArgs)).stdout.includes(answer));
  const stats = await rpc('getTraceStats'); assert.ok(stats.total.tokens >= 28);
  pass('both installed clients consume the native Gateway config and native Trace records real upstream usage');
  registry = await rpc('saveProvider', {displayName: 'Fixture_04260321', adapter: 'chat-completions', baseUrl: base + '/v1', bearerToken: token, codexApiFormat: 'chat-completions', codexModel: 'fixture-model', claudeModels: {sonnet: 'fixture-model'}});
  const conversionId = registry.connections.find(p => p.displayName === 'Fixture_04260321').id;
  await rpc('switchClientProvider', {client: 'codex', providerId: conversionId}); await rpc('switchClientProvider', {client: 'claude', providerId: conversionId});
  await rpc('updateClaudeModels',{sonnet:'fixture-model'});
  assert.match(await readFile(join(root, 'codex/config.toml'), 'utf8'), /web_search = "disabled"/);
  let conversionStart = requests.length;
  assert.ok((await runCli(codex, codexArgs)).stdout.includes(answer)); assert.equal(requests.at(-1).path, '/v1/chat/completions'); assert.equal(requests.length - conversionStart, 1);
  conversionStart = requests.length;
  assert.ok((await runCli(claude, claudeArgs)).stdout.includes(answer)); assert.equal(requests.at(-1).path, '/v1/chat/completions'); assert.equal(requests.length - conversionStart, 1);
  pass('installed Codex Responses and Claude Messages clients consume native SSE conversion from an explicit Chat Completions provider');
  registry = await rpc('saveProvider', {displayName: 'Fixture_2856bcb3', adapter: 'auto', baseUrl: base + '/v1', bearerToken: token, codexApiFormat: 'responses', codexModel: 'compatible-model', claudeModels: {sonnet: 'compatible-model'}});
  const compatibleId = registry.connections.find(p => p.displayName === 'Fixture_2856bcb3').id;
  await rpc('fetchProviderModels', {providerId: compatibleId, refresh: true});
  await rpc('switchClientProvider', {client: 'codex', providerId: compatibleId});
  assert.ok((await runCli(codex, imageArgs)).stdout.includes(answer)); assert.equal(requests.at(-1).path, '/v1/messages');
  assert.ok(requests.at(-1).body.messages.some(m => m.content?.some?.(c => c.type === 'image' && c.source?.data)));
  toolPending = true; const compatibleStart = requests.length;
  const compatibleExecuted = await runCli(codex, toolArgs); assert.ok(compatibleExecuted.stdout.includes(answer));
  const compatibleCalls = requests.slice(compatibleStart).filter(r => r.path === '/v1/messages'); assert.equal(compatibleCalls.length, 2);
  assert.ok(compatibleCalls[1].body.messages.some(m => m.content?.some?.(c => c.type === 'tool_result' && c.tool_use_id === 'isolated-call' && JSON.stringify(c.content).includes(toolResult))), JSON.stringify(compatibleCalls.map(r=>r.body.messages.map(m=>({role:m.role,parts:Array.isArray(m.content)?m.content.map(c=>({type:c.type,id:c.tool_use_id??c.id})):typeof m.content})))) + compatibleExecuted.stdout.slice(-4000));
  pass('installed Codex follows the declared Messages protocol on the configured URL, sends images and executes a single tool with matching returned tool results');
  await rpc('switchClientProvider',{client:'claude',providerId:compatibleId});await rpc('updateClaudeModels',{sonnet:'compatible-model'});
  assert.ok((await runCli(claude,claudeImageArgs,0,claudeImageInput)).stdout.includes(answer));
  assert.equal(requests.at(-1).path.split('?')[0],'/v1/messages');assert.equal(requests.at(-1).body.model,'compatible-model');
  assert.ok(requests.at(-1).body.messages.some(m=>m.content?.some?.(c=>c.type==='image'&&c.source?.data)));
  toolPending=true;toolKind='claude';claudeToolStart=requests.length;
  assert.ok((await runCli(claude,claudeToolArgs)).stdout.includes(answer));
  claudeToolCalls=requests.slice(claudeToolStart).filter(r=>r.path.startsWith('/v1/messages'));
  assert.equal(claudeToolCalls.length,2);assert.ok(claudeToolCalls[1].body.messages.some(m=>m.content?.some?.(c=>c.type==='tool_result'&&c.tool_use_id==='isolated-call'&&JSON.stringify(c.content).includes(toolResult))));
  toolKind='codex';pass('installed Claude consumes compatible role, image and tool configuration through the native Messages route without repeating tools');
  await rpc('switchClientProvider', {client: 'codex', providerId: codexId}); await rpc('switchClientProvider', {client: 'claude', providerId: claudeId});
  await rpc('toggleTracing', false); await assert.rejects(fetch(live.localBaseUrl + '/v1/responses'));
  assert.ok((await runCli(codex, codexArgs)).stdout.includes(answer));
  assert.ok((await runCli(claude, claudeArgs)).stdout.includes(answer));
  await stop(); start(); assert.equal((await rpc('getState')).tracingEnabled, false);
  assert.ok((await runCli(codex, codexArgs)).stdout.includes(answer));
  pass('stop closes the owned listener and both installed clients complete direct requests; isolated restart retains direct Codex routing');
  const configPath = join(root, 'codex/config.toml'); assert.ok(!(await readFile(configPath, 'utf8')).includes('web_search'));
  await rpc('switchClientProvider', {client: 'codex', providerId: conversionId});
  await writeFile(configPath, 'web_search = "live" # explicit user choice\n' + await readFile(configPath, 'utf8'));
  await rpc('toggleTracing', true); assert.match(await readFile(configPath, 'utf8'), /web_search = "live" # explicit user choice/);
  const beforeUnsupported = requests.length; const rejected = await runCli(codex, codexArgs, 1);
  assert.ok(rejected.stdout.includes('web_search')); assert.equal(requests.length, beforeUnsupported);
  await rpc('toggleTracing', false); assert.match(await readFile(configPath, 'utf8'), /web_search = "live" # explicit user choice/);
  pass('conversion supplies a reversible disabled search default; explicit live search is preserved and rejected before upstream without tool replay');
  await stop();
  passed = true;
  console.log(JSON.stringify({passed, checks, versions, requests: requests.length, scope: 'actual installed CLI clients; synthetic credentials and local upstream only; real platform authorization not tested'}));
} finally {
  if (child?.exitCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); } upstream.closeAllConnections(); await new Promise(r => upstream.close(r));
  const fixturesCleaned = passed && process.env.XWX_DECK_KEEP_FIXTURES !== '1';
  if (fixturesCleaned) await rm(root, {recursive: true, force: true});
  else console.error('Installed CLI fixtures retained: ' + root);
  await mkdir('test-results', {recursive:true});
  await writeFile('test-results/native-installed-clients-summary.json', JSON.stringify({passed, checks, versions, binarySha256, requests: requests.length, fixturesCleaned, ...(!fixturesCleaned ? {retainedFixtures:root} : {}), realInstalledClients:true, realPlatformAuthorization:false},null,2)+'\n');
}
