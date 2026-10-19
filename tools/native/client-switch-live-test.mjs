import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { nativeTestBinary } from "./test-support.mjs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { mkdtemp, realpath, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { startNativeRpc } from "./rpc-test-session.mjs";
const [client, executable] = process.argv.slice(2);
// Opt-in: node client-switch-live-test.mjs <client-id> <official-executable>.
// HOME and all credentials are disposable; only the local upstream may answer.
const startedAt = new Date().toISOString();
if (!executable) throw Error("client and official executable required");
const exe = resolve(executable);
const root = await mkdtemp(join(await realpath(tmpdir()), "xwx-live-" + client + "-")), home = join(root, "client-home"), work = join(root, "workspace");
await writeFile(join(root, ".xwx-rust-pilot"), "isolated-rust-pilot-v1\n");
await mkdir(work, { recursive: true });
await mkdir(home, { recursive: true });
const calls = [], phases = [];
let phase, base, session;
const server = createServer(async (req, res) => {
  req.url = new URL(req.url, "http://fixture").pathname;
  if (!/^\/([ab]\/|backend-api\/)/.test(req.url)) {
    res.writeHead(403);
    res.end("External network rejected");
    return;
  }
  let raw = "";
  for await (const b of req) raw += b;
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    res.writeHead(400);
    res.end("{}");
    return;
  }
  if (req.method === "GET" || req.url.includes("models") && !req.url.includes("GenerateContent")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: ["fixture-a", "fixture-b"].map((id2) => ({ id: id2, object: "model", created: 1, owned_by: "fixture", context_window: 131072, context_length: 131072, max_output_tokens: 8192 })) }));
    return;
  }
  if (!["/responses", "/messages", "/chat/completions", "/count_tokens"].some((p) => req.url.endsWith(p))) {
    res.end("{}");
    return;
  }
  if (req.url.endsWith("/count_tokens")) {
    res.end('{"input_tokens":20}');
    return;
  }
  const provider = req.url.startsWith("/a/") ? "a" : "b", text = "live-switch-" + provider, id = "live-" + calls.length;
  calls.push({ phase, provider, path: req.url, model: body.model, correctKey: req.headers.authorization === "Bearer SYNTHETIC-" + provider || req.headers["x-api-key"] === "SYNTHETIC-" + provider, body });
  const response = { id, object: "response", created_at: Math.floor(Date.now() / 1e3), model: body.model, status: "completed", output: [{ id: "msg-" + id, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } };
  if (req.url.endsWith("/responses")) {
    if (!body.stream) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(response));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const item = response.output[0];
    for (const e of [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } }, { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }, { type: "response.content_part.added", output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }, { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: text }, { type: "response.output_text.done", output_index: 0, item_id: item.id, content_index: 0, text }, { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response }]) res.write("event: " + e.type + "\ndata: " + JSON.stringify(e) + "\n\n");
  } else if (req.url.endsWith("/chat/completions")) {
    if (!body.stream) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id, object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const e of [{ choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }]) res.write("data: " + JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: body.model, ...e }) + "\n\n");
    res.write("data: [DONE]\n\n");
  } else if (req.url.endsWith("/messages")) {
    const msg = { id, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 4 } };
    if (!body.stream) {
      res.end(JSON.stringify(msg));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const e of [{ type: "message_start", message: { ...msg, content: [], stop_reason: null } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }, { type: "message_stop" }]) res.write("event: " + e.type + "\ndata: " + JSON.stringify(e) + "\n\n");
  } else {
    res.writeHead(404);
    res.end("{}");
    return;
  }
  res.end();
});
server.on("connect", (_req, socket) => {
  socket.on("error", () => {
  });
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
base = "http://127.0.0.1:" + server.address().port;
const env = Object.fromEntries(["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"), APPDATA: join(home, "AppData/Roaming"), LOCALAPPDATA: join(home, "AppData/Local"), HTTP_PROXY: base, HTTPS_PROXY: base, ALL_PROXY: base, http_proxy: base, https_proxy: base, all_proxy: base, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", DSH_HOME: join(home, ".dsh"), WORKBUDDY_CONFIG_DIR: join(home, ".workbuddy"), CODEBUDDY_CONFIG_DIR: join(home, ".codebuddy"), QWEN_CODE_CONFIG_DIR: join(home, ".qwen"), OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", GEMINI_CLI_HOME: home, CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude"), ANTHROPIC_API_KEY: "SYNTHETIC-a", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1", DISABLE_AUTOUPDATER: "1", CODEBUDDY_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
if (client !== "workbuddy") delete env.WORKBUDDY_CONFIG_DIR;
const manual = ["copilot-cli", "oh-my-pi", "goose", "qoder", "hermes-agent"].includes(client);
const specs = {
  "pi": {cmd:process.execPath,prefix:[exe],args:["--offline","--no-tools","--no-mcp","--no-extensions","--no-skills","--no-prompt-templates","--no-context-files","--no-approve","--session",join(root,"pi-session.jsonl"),"-p","Reply briefly with no tool calls."],name:"pi"},
  "copilot-cli": { cmd: exe, args: ["-p", "Reply briefly with no tool calls.", "--disable-builtin-mcps"], name: "copilot" },
  "oh-my-pi": { cmd: process.env.XWX_TEST_BUN, prefix: [exe], args: ["-p", "Reply briefly with no tool calls.", "--mode", "json", "--no-tools", "--no-title", "--no-lsp", "--no-extensions", "--model", "deck/fixture-a"], name: "omp" },
  "goose": { cmd: exe, args: ["run", "--no-profile", "--output-format", "json", "--text", "Reply briefly with no tool calls."], name: "goose" },
  "qoder": { cmd: exe, args: ["-p", "Reply briefly with no tool calls.", "--tools", "", "--max-model-request-retries", "0"], name: "qoder" },
  "hermes-agent": { cmd: exe, args: ["chat", "-q", "Reply briefly with no tool calls.", "--oneshot", "--ignore-rules", "--format", "stream-json"], name: "hermes" },
  "droid": { cmd: exe, args: ["exec", "--output-format", "json", "--only-tools", "read", "Reply briefly with no tool calls."], name: "droid" },
  "crush": { cmd: exe, args: ["run", "Reply briefly with no tool calls."], name: "crush" },
  "codex": { cmd: exe, args: ["exec", "--skip-git-repo-check", "--ignore-rules", "-s", "read-only", "--json", "Reply briefly with no tool calls."], name: "codex" },
  "claude": { cmd: exe, args: ["--bare", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", "", "--no-chrome", "--model", "sonnet", "--output-format", "json", "-p", "Reply briefly with no tool calls."], name: "claude" },
  "deepseek-harness": { cmd: exe, args: ["headless", "--json", "Reply briefly with no tool calls."], name: "dsh" },
  "workbuddy": { cmd: process.execPath, prefix: [exe], args: ["-p", "Reply briefly with no tool calls.", "--output-format", "json", "--tools", "", "--max-turns", "1"], name: "workbuddy" },
  "codebuddy-code": { cmd: exe, args: ["-p", "Reply briefly with no tool calls.", "--output-format", "json", "--tools", "", "--max-turns", "1"], name: "codebuddy" },
  "qwen-code": { cmd: exe, args: ["-p", "Reply briefly with no tool calls.", "--output-format", "json"], name: "qwen" },
  "gemini-cli": { cmd: exe, args: ["--skip-trust", "-p", "Reply briefly with no tool calls.", "--output-format", "json"], name: "gemini" },
  "opencode": { cmd: exe, args: ["run", "--format", "json", "Reply briefly with no tool calls."], name: "opencode" },
  "mimo-code": { cmd: exe, args: ["run", "--format", "json", "Reply briefly with no tool calls."], name: "mimo" },
  "cline": { cmd: exe, args: ["--json", "--auto-approve", "false", "--retries", "1", "--timeout", "25", "Reply briefly with no tool calls."], name: "cline" },
  "grok-build": { cmd: exe, args: ["--output-format","json","-p", "Reply briefly with no tool calls."], name: "grok" },
  "kimi-code": { cmd: exe, args: ["-p", "Reply briefly with no tool calls.", "--output-format", "stream-json"], name: "kimi" }
};
const latestResume = {"pi":[],"opencode":["--continue"],"mimo-code":["--continue"],"gemini-cli":["--resume","latest"],"qwen-code":["--continue"],"crush":["--continue"],"goose":["--resume"],"copilot-cli":["--continue"],"oh-my-pi":["--continue"]};
const spec = specs[client];
if (!spec) throw Error("unconfigured actual CLI");
if (["qwen-code", "codebuddy-code", "gemini-cli", "qoder"].includes(client) && /\.[cm]?js$/i.test(exe)) {
  spec.cmd = process.execPath;
  spec.prefix = [exe];
}
const useAcp = process.env.XWX_NATIVE_TEST_ACP === "1";
let acpProcess, acpSession, acpInitialization, acpSequence = 0, acpError = "";
const acpPending = new Map(), acpUpdates = [];
async function acpCall(method, params) {
  const id = ++acpSequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { acpPending.delete(id); reject(Error("ACP timeout: " + method + "; " + acpError)); }, 45000);
    acpPending.set(id, {resolve, reject, timer});
    acpProcess.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params}) + "\n");
  });
}
async function runAcp() {
  if (!acpProcess) {
    if (!["grok-build", "cline"].includes(client)) throw Error("No official ACP launch contract for this client");
    const args = client === "grok-build" ? ["agent","stdio"] : ["--acp","--auto-approve","false"];
    acpProcess = spawn(spec.cmd, [...spec.prefix ?? [], ...args], {cwd:work,env:{...env,CLINE_SESSION_BACKEND_MODE:"local"},windowsHide:true,stdio:["pipe","pipe","pipe"]});
    acpProcess.stderr.on("data",bytes=>acpError=(acpError+bytes).slice(-3000));
    createInterface({input:acpProcess.stdout}).on("line",line=>{
      let message;try{message=JSON.parse(line)}catch{return}
      if (message.method) {
        if (message.id !== undefined) acpProcess.stdin.write(JSON.stringify({jsonrpc:"2.0",id:message.id,...message.method==="session/request_permission"?{result:{outcome:{outcome:"cancelled"}}}:{error:{code:-32601,message:"Fixture does not expose client tools"}}})+"\n");
        else acpUpdates.push(message);
      } else {
        const pending = acpPending.get(message.id);if(!pending)return;clearTimeout(pending.timer);acpPending.delete(message.id);message.error?pending.reject(Error(JSON.stringify(message.error))):pending.resolve(message.result);
      }
    });
    acpProcess.on("exit",()=>{for(const pending of acpPending.values()){clearTimeout(pending.timer);pending.reject(Error("ACP process exited: "+acpError));}acpPending.clear();});
    acpInitialization = await acpCall("initialize",{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},clientInfo:{name:"deck-isolated-verification",version:"1.0.0"}});
    const opened=await acpCall("session/new",{cwd:work,mcpServers:[]});acpSession=opened.sessionId;
    assert.ok(acpSession,"official ACP client must create a real native session");
  }
  const before=acpUpdates.length;
  await acpCall("session/prompt",{sessionId:acpSession,prompt:[{type:"text",text:"Reply briefly with no tool calls."}]});
  return {code:0,out:JSON.stringify({session_id:acpSession,updates:acpUpdates.slice(before)}),err:acpError};
}
async function stopAcp() {
  if(!acpProcess||acpProcess.exitCode!==null||acpProcess.signalCode!==null)return;
  const done=once(acpProcess,"exit"),timer=setTimeout(()=>acpProcess.kill("SIGKILL"),3000);acpProcess.stdin.end();try{await done}finally{clearTimeout(timer)}
}
const run = async (args) => {
  if(useAcp&&!args.includes("--version")) return runAcp();
  const child = spawn(spec.cmd, [...spec.prefix ?? [], ...args], { cwd: work, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (b) => out += b);
  child.stderr.on("data", (b) => err += b);
  const timer = setTimeout(() => child.kill("SIGKILL"), 45e3);
  try {
    const [code, signal] = await once(child, "exit");
    return { code, signal, out, err };
  } finally {
    clearTimeout(timer);
  }
};
await mkdir(join(home, ".local/bin"), { recursive: true });
if (process.platform === "win32") {
  // Discovery stays within the disposable home. Execution above still uses
  // the supplied official binary, never this installation fixture.
  await writeFile(join(home, ".local/bin", spec.name + ".cmd"), "@echo off\r\nexit /b 0\r\n");
} else {
  await symlink(exe, join(home, ".local/bin", spec.name));
}
if (client === "workbuddy" && process.platform !== "win32") {
  await mkdir(join(home, "Applications"), { recursive: true });
  await symlink("/Applications/WorkBuddy.app", join(home, "Applications/WorkBuddy.app"));
}
if (client === "deepseek-harness") {
  await mkdir(join(home, ".dsh/profiles/headless"), { recursive: true });
  await writeFile(join(home, ".dsh/profiles/headless/cordis.patch.yml"), "[]\n");
}
process.env.XWX_CLIENT_INSTALLATIONS_TEST_HOME = home;
if (client === "workbuddy") env.CODEBUDDY_CONFIG_DIR = env.WORKBUDDY_CONFIG_DIR;
let app = startNativeRpc(root, ["--subscription-test-endpoint", base]);
let failure, version, processCleanup;
const lifecycle = [];
const verifyLifecycle = ["workbuddy", "kimi-code", "droid"].includes(client);
let originalFiles;
try {
  await app.rpc("getState");
  version = await run(["--version"]);
  if (!manual && !["codex", "claude"].includes(client)) await app.rpc("addModelClient", client);
  if (verifyLifecycle) {
    originalFiles = await Promise.all((await app.rpc("getClientRoute", client)).configPaths.map(async path => [path, await readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; })]));
  }
  if (["codex", "claude"].includes(client)) {
    const claims = Buffer.from(JSON.stringify({ sub: "fixture", email: "switch@example.test", exp: Math.floor(Date.now() / 1e3) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "fixture", chatgpt_plan_type: "plus", chatgpt_user_id: "fixture" } })).toString("base64url");
    await writeFile(join(root, "codex/auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "SYNTHETIC-b", id_token: "eyJhbGciOiJub25lIn0." + claims + ".fixture", refresh_token: "synthetic-retained", account_id: "fixture" } }));
    await writeFile(join(root, "codex/config.toml"), 'model_provider="openai"\nmodel="fixture-b"\nchatgpt_base_url="' + base + '/backend-api"\n');
    await app.rpc("connectSubscriptionAccount", "official-chatgpt");
  }
  for (const id of ["a", "b"]) await app.rpc("saveProvider", { id, displayName: "Switch " + id, adapter: client === "claude" && id === "a" ? "anthropic-messages" : "responses", baseUrl: base + "/" + id + "/v1", bearerToken: "SYNTHETIC-" + id, codexModel: "fixture-" + id });
  for (const id of ["a", "b", "a"]) {
    if (phases.length && client === "grok-build") {
      let quietSince;
      for (let attempt = 0; attempt < 200; attempt++) {
        if ((await app.rpc("getState")).activeRequests === 0) {
          quietSince ??= Date.now();
          if (Date.now() - quietSince >= 500) break;
        } else quietSince = undefined;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal((await app.rpc("getState")).activeRequests, 0, "previous Grok background replies must finish before the next selection");
    }
    if (["codex", "claude"].includes(client)) {
      const target = id === "a" ? "a" : "subscription-official-chatgpt";
      await app.rpc("switchClientProvider", { client, providerId: target });
      if (client === "claude") await app.rpc("updateClaudeModels", { sonnet: "fixture-" + id });
      else await app.rpc("updateCodexConfig", { expectedProviderId: target, compatibleModel: "fixture-" + id });
    } else {
      const route = await app.rpc("getClientRoute", client);
      await app.rpc("setClientRoute", { client, providerId: id, model: "fixture-" + id, configDigest: route.configDigest, takeoverConfirmed: true });
    }
    if (!phase) await app.rpc("toggleTracing", true);
    phase = String(phases.length + 1) + id;
    const args = [...spec.args];
    const gateway = (await app.rpc("getState")).localBaseUrl + "/clients/" + client + "/v1";
    if (client === "hermes-agent") {
      env.HERMES_HOME = join(home, ".hermes");
      await mkdir(env.HERMES_HOME, { recursive: true });
      await writeFile(join(env.HERMES_HOME, "config.yaml"), JSON.stringify({model:{default:"fixture-"+id,provider:"custom",base_url:gateway,api_key:"xwx-deck"}}));
    }
    if (client === "copilot-cli") Object.assign(env, { COPILOT_PROVIDER_BASE_URL: gateway, COPILOT_PROVIDER_API_KEY: "xwx-deck", COPILOT_PROVIDER_WIRE_API: "responses", COPILOT_MODEL: "fixture-" + id });
    if (client === "goose") Object.assign(env, { GOOSE_PROVIDER: "openai", GOOSE_MODEL: "fixture-" + id, OPENAI_HOST: gateway.replace(/\/v1$/, ""), OPENAI_API_KEY: "xwx-deck", GOOSE_MODE: "chat", GOOSE_DISABLE_KEYRING: "true" });
    if (client === "oh-my-pi") {
      const agent = join(home, ".omp/agent");
      await mkdir(agent, { recursive: true });
      await writeFile(join(agent, "models.yml"), JSON.stringify({ providers: { deck: { baseUrl: gateway, apiKey: "xwx-deck", api: "openai-responses", models: ["a", "b"].map((i) => ({ id: "fixture-" + i, name: "Fixture " + i, contextWindow: 128e3, maxTokens: 8192 })) } } }));
      args[args.indexOf("deck/fixture-a")] = "deck/fixture-" + id;
    }
    if (session) {
      if (client === "droid") args.splice(1, 0, "--session-id", session);
      if (client === "cline" && process.env.XWX_NATIVE_TEST_REQUIRE_CLINE_RESUME === "1") args.unshift("--id", session);
      if (client === "hermes-agent") args.push("--resume", session);
      if (client === "kimi-code") args.unshift("--session", session);
      if (client === "deepseek-harness") args.splice(1, 0, "--session-id", session);
      if (client === "codex") {
        args.splice(0, args.length, "exec", "resume", "--skip-git-repo-check", "--json", session, "Reply briefly with no tool calls.");
      }
      if (["claude", "workbuddy", "codebuddy-code", "grok-build"].includes(client)) args.unshift("--resume", session);
    }
    if (phases.length && latestResume[client]) args.push(...latestResume[client]);
    const managedBefore = client === "grok-build" ? await readFile(join(home,".grok/config.toml"),"utf8") : undefined;
    const before = calls.length, result = await run(args);
    const events = [];
    try {
      const parsed = JSON.parse(result.out);
      events.push(...Array.isArray(parsed) ? parsed : [parsed]);
    } catch {
      for (const line of result.out.split("\n")) {
        try {
          events.push(JSON.parse(line));
        } catch {
        }
      }
    }
    for (const e of events) {
      if (!session) session = (client === "deepseek-harness" ? e.sessionId : client === "codex" ? e.thread_id : e.session_id ?? e.sessionId ?? (client === "cline" ? e.taskId : undefined)) || undefined;
    }
    const observed = calls.slice(before);
    const resumed = phases.length > 0 && (client !== "cline" || useAcp || process.env.XWX_NATIVE_TEST_REQUIRE_CLINE_RESUME === "1") && (Boolean(latestResume[client]) || session && ["codex", "claude", "deepseek-harness", "workbuddy", "codebuddy-code", "grok-build", "kimi-code", "droid", "cline", "hermes-agent"].includes(client));
    const historyRetained = resumed ? observed.some((call) => JSON.stringify(call.body).includes("live-switch-" + phases.at(-1).phase.slice(-1))) : null;
    phases.push({ phase, resumed:Boolean(resumed), managedBefore, managedAfter:client==="grok-build"?await readFile(join(home,".grok/config.toml"),"utf8"):undefined, code: result.code, historyRetained, calls: observed.map(({ provider, path, model, correctKey }) => ({ provider, path, model, correctKey })), output: result.out.slice(-3e3), errors: result.err.slice(-3e3) });
    assert.equal(result.code, 0, JSON.stringify(phases.at(-1)));
    if (resumed) assert.ok(historyRetained, "same native session must retain its prior visible answer after switching");
    assert.ok(observed.length > 0, "actual client did not reach selected upstream");
    assert.ok(observed.every((c) => c.provider === id && c.correctKey) && observed.some((c) => c.model === "fixture-" + id) && observed.every((c) => c.model === "fixture-" + id || client === "grok-build" && c.model === "grok-4.6"), JSON.stringify(phases.at(-1)));
    assert.ok(result.out.includes("live-switch-" + id), result.out);
  }
  const url = (await app.rpc("getState")).localBaseUrl;
  // A CLI can exit just before the final transport lease is released.
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await app.rpc("getState")).activeRequests === 0) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal((await app.rpc("getState")).activeRequests, 0, "all real client replies must finish before restore");
  await app.rpc("toggleTracing", false);
  await assert.rejects(fetch(url + "/v1/models"));
  if (verifyLifecycle) {
    for (const [path, original] of originalFiles) {
      const restored = await readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (original !== null) assert.equal(restored, original, "restore original client configuration");
      else assert.ok(!restored || (!restored.includes(url) && !restored.includes("xwx_deck")), "stop removes owned routing while retaining client preferences");
    }
    lifecycle.push("stop restores original routing and closes listener");
    await app.stop();
    app = startNativeRpc(root, ["--subscription-test-endpoint", base]);
    const saved = await app.rpc("getClientRoute", client);
    assert.equal(saved.providerId, "a");
    assert.equal(saved.model, "fixture-a");
    lifecycle.push("restart retains selected provider and exact model");
    await app.rpc("toggleTracing", true);
    const args = [...spec.args];
    assert.ok(session, "native client persisted a resumable session");
    if (client === "workbuddy") args.unshift("--resume", session);
    if (client === "kimi-code") args.unshift("--session", session);
    if (client === "droid") args.splice(1, 0, "--session-id", session);
    phase = "restart-a";
    const before = calls.length, result = await run(args), observed = calls.slice(before);
    assert.equal(result.code, 0, result.err + result.out);
    assert.ok(observed.length && observed.every(call => call.provider === "a" && call.model === "fixture-a" && call.correctKey));
    assert.ok(observed.some(call => JSON.stringify(call.body).includes("live-switch-a")), "restart resumes same native conversation history");
    assert.ok(result.out.includes("live-switch-a"));
    lifecycle.push("same native conversation resumes with correct endpoint, key, model and visible answer after Deck restart");
    for (let attempt = 0; attempt < 100 && (await app.rpc("getState")).activeRequests; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await app.rpc("getState")).activeRequests, 0);
    const restartedUrl = (await app.rpc("getState")).localBaseUrl;
    await app.rpc("toggleTracing", false);
    await assert.rejects(fetch(restartedUrl + "/v1/models"));
  } else {
    const native = ["codex", "claude"].includes(client);
    const choice = async () => {
      if (!native) {
        const route = await app.rpc("getClientRoute", client);
        return { providerId: route.providerId, model: route.model };
      }
      const registry = await app.rpc("getProviders");
      const providerId = registry.selected[client];
      return { providerId, model: registry.connections.find(provider => provider.id === providerId)?.codexModel };
    };
    if (!manual && !native) {
      await assert.rejects(readFile(join(root, "client-wiring-" + client + ".json")), { code: "ENOENT" });
      lifecycle.push("stop removes the owned wiring journal and closes the listener");
    } else lifecycle.push(native ? "stop closes the native capture listener" : "stop closes the listener; manual connections remain client-owned");
    const beforeRestart = await choice();
    assert.equal(beforeRestart.providerId, "a");
    assert.equal(beforeRestart.model, "fixture-a");
    await app.stop();
    app = startNativeRpc(root, ["--subscription-test-endpoint", base]);
    assert.deepEqual(await choice(), beforeRestart);
    assert.equal((await app.rpc("getState")).tracingEnabled, false);
    lifecycle.push("restart retains the selected provider, exact model and stopped Trace state");
  }
} catch (e) {
  failure = e.message;
} finally {
  await stopAcp();
  await app.rpc("toggleTracing", false).catch(() => {
  });
  try {
    await app.stop();
  } catch (error) {
    failure ??= error.message;
  }
  server.closeAllConnections();
  server.close();
  if (process.platform === "win32" && client === "cline") {
    // Cline's idle hub outlives its CLI and holds SQLite files on Windows.
    // Match both the exact supplied executable and this disposable workspace.
    const cleanup = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$taskExe=[IO.Path]::GetFullPath($env:XWX_TEST_CLINE_EXE); $taskWork=[IO.Path]::GetFullPath($env:XWX_TEST_CLINE_WORK); $taskStopped=@(); Get-CimInstance Win32_Process -Filter \"Name='cline.exe'\" | Where-Object { $_.ExecutablePath -ieq $taskExe -and $_.CommandLine.IndexOf('--cline-hub-daemon',[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.CommandLine.IndexOf($taskWork,[StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction Stop; $taskStopped += $_.ProcessId }; ConvertTo-Json -Compress -InputObject $taskStopped"], { env: { ...process.env, XWX_TEST_CLINE_EXE: exe, XWX_TEST_CLINE_WORK: work }, encoding: "utf8", windowsHide: true, timeout: 15000 });
    processCleanup = { passed: cleanup.status === 0, stoppedPids: cleanup.status === 0 ? JSON.parse(cleanup.stdout.trim() || "[]") : [], scope: "exact executable and owned fixture workspace only" };
    if (!processCleanup.passed) failure ??= "Owned Cline hub cleanup failed";
  }
  if (process.platform === "win32" && client === "hermes-agent") {
    const leaseFile = join(home, ".hermes/gateway.lock"), lease = JSON.parse(await readFile(leaseFile, "utf8").catch(error => { if (error.code === "ENOENT") return "null"; throw error; }));
    if (lease) {
      assert.equal(resolve(lease.hermes_home).toLowerCase(), resolve(home, ".hermes").toLowerCase());
      const cleanup = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$taskPid=[int]$env:XWX_HERMES_PID; $taskStage=[IO.Path]::GetFullPath($env:XWX_HERMES_STAGE).TrimEnd('\\')+'\\'; $taskChild=Get-CimInstance Win32_Process -Filter ('ProcessId='+$taskPid); $taskStopped=@(); if ($taskChild) { if (-not $taskChild.ExecutablePath.StartsWith($taskStage,[StringComparison]::OrdinalIgnoreCase) -or $taskChild.CommandLine -notlike '*hermes_cli.main*gateway run --quiet --idle-exit*') { throw 'Owned gateway mismatch' }; $taskParent=Get-CimInstance Win32_Process -Filter ('ProcessId='+$taskChild.ParentProcessId); Stop-Process -Id $taskChild.ProcessId; $taskStopped+=$taskChild.ProcessId; if ($taskParent -and $taskParent.ExecutablePath.StartsWith($taskStage,[StringComparison]::OrdinalIgnoreCase) -and $taskParent.CommandLine -like '*hermes_cli.main*gateway run --quiet --idle-exit*') { Stop-Process -Id $taskParent.ProcessId; $taskStopped+=$taskParent.ProcessId } }; ConvertTo-Json -Compress -InputObject $taskStopped"], { env: { ...process.env, XWX_HERMES_PID: String(lease.pid), XWX_HERMES_STAGE: resolve(dirname(exe), "../..") }, encoding: "utf8", windowsHide: true, timeout: 15000 });
      processCleanup = { passed: cleanup.status === 0, stoppedPids: cleanup.status === 0 ? JSON.parse(cleanup.stdout.trim() || "[]") : [], scope: "owned isolated Hermes gateway lease, exact staging directory and daemon arguments" };
      if (!processCleanup.passed) failure ??= "Owned Hermes gateway cleanup failed: " + cleanup.stderr;
    }
  }
  const fixturesCleaned = !failure && process.env.XWX_DECK_KEEP_FIXTURES !== "1";
  if (fixturesCleaned) await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  const report = { client, sameNativeSession:phases.length>=3&&phases.slice(1).every(item=>item.resumed&&item.historyRetained), transport:useAcp?"ACP stdio":"CLI", continuationLimitation:client==="cline"&&!useAcp?"CLI 3.0.73 --json --id rejects a supplied prompt; native ACP requires vendor authentication. New-session switching only.":undefined, acpInitialization, startedAt, finishedAt: new Date().toISOString(), binarySha256: createHash("sha256").update(await readFile(nativeTestBinary)).digest("hex"), clientEntrySha256: createHash("sha256").update(await readFile(exe)).digest("hex"), configuration: manual ? "manual client setup" : "Deck generated config", session, passed: !failure, failure, version, phases, lifecycle, processCleanup, fixturesCleaned, root: fixturesCleaned ? undefined : root };
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/live-client-switch-" + client + ".json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (failure) process.exitCode = 1;
}
