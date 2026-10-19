// Actual VS Code extension host; isolated profile and synthetic local upstream.
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, realpath, writeFile, readFile, symlink, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { nativeTestBinary } from "./test-support.mjs";
import { startNativeRpc } from "./rpc-test-session.mjs";
const codeApp = process.argv[2];
const windows = process.platform === "win32";
if (!codeApp || !["darwin", "win32"].includes(process.platform) || windows && !process.argv[3]) throw Error("Pass the official macOS app, or Windows Code.exe and its resources/app directory. This opt-in runner uses an isolated profile.");
const resources = windows ? resolve(process.argv[3]) : join(codeApp, "Contents/Resources/app");
const executable = windows ? resolve(codeApp) : join(codeApp, "Contents/MacOS/Code");
const root = await mkdtemp(join(await realpath(windows ? tmpdir() : "/tmp"), "vs-")), home = join(root, "client-home"), work = join(root, "deck-switch-vscode-workspace"), ext = join(root, "extension");
for (const d of [home, work, ext, join(home, "Applications")]) await mkdir(d, { recursive: true });
await writeFile(join(root, ".xwx-rust-pilot"), "isolated-rust-pilot-v1\n");
if (windows) {
  const fixture = join(home, "Applications/Microsoft VS Code");
  await mkdir(join(fixture, "resources/app"), { recursive: true });
  await writeFile(join(fixture, "Code.exe"), "isolated installation discovery fixture");
  await cp(join(resources, "package.json"), join(fixture, "resources/app/package.json"));
  await cp(join(resources, "product.json"), join(fixture, "resources/app/product.json"));
} else await symlink(codeApp, join(home, "Applications/Visual Studio Code.app"));
const profile = windows ? join(home, "AppData/Roaming/Code") : join(home, "Library/Application Support/Code");
process.env.XWX_CLIENT_INSTALLATIONS_TEST_HOME = home;
let app;
let selected = "a";
const calls = [];
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const b of req) raw += b;
  const body = raw ? JSON.parse(raw) : {};
  if (req.url.startsWith("/control/")) {
    const id2 = req.url.slice(-1), route2 = await app.rpc("getClientRoute", "vscode");
    const before = await Promise.all(route2.configPaths.map(async path => ({path,source:await readFile(path,"utf8").catch(()=>null)})));
    try { await app.rpc("setClientRoute", { client: "vscode", providerId: id2, model: "fixture-" + id2, configDigest: route2.configDigest, takeoverConfirmed: true }); }
    catch(error) { await writeFile(join(root,"switch-conflict.json"),JSON.stringify({id:id2,error:String(error),route:route2,before,after:await Promise.all(route2.configPaths.map(async path=>({path,source:await readFile(path,"utf8").catch(()=>null)})))},null,2));res.statusCode=500;res.end(JSON.stringify({error:String(error)}));return; }
    selected = id2;
    res.end("{}");
    return;
  }
  if (req.method === "GET") {
    res.end(JSON.stringify({ data: [{ id: "fixture-a" }, { id: "fixture-b" }] }));
    return;
  }
  const id = req.url.startsWith("/a/") ? "a" : "b";
  calls.push({ selected, path: req.url, model: body.model, keyCorrect: req.headers.authorization === "Bearer SYNTHETIC-" + id });
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const data of [{ choices: [{ index: 0, delta: { role: "assistant", content: "vscode-live-" + id }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }]) res.write("data: " + JSON.stringify({ id: "vscode-" + calls.length, object: "chat.completion.chunk", created: 1, model: body.model, ...data }) + "\n\n");
  res.end("data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = "http://127.0.0.1:" + server.address().port;
app = startNativeRpc(root);
await app.rpc("getState");
await app.rpc("addModelClient", "vscode");
for (const id of ["a", "b"]) await app.rpc("saveProvider", { id, displayName: "VSCode " + id, adapter: "chat-completions", baseUrl: base + "/" + id + "/v1", bearerToken: "SYNTHETIC-" + id });
await mkdir(join(root, "extensions"), { recursive: true });
if (!windows) await cp(join(resources, "extensions/copilot"), join(root, "extensions/github.copilot-chat"), { recursive: true });
const route = await app.rpc("getClientRoute", "vscode");
await app.rpc("setClientRoute", { client: "vscode", providerId: "a", model: "fixture-a", configDigest: route.configDigest, takeoverConfirmed: true });
await app.rpc("toggleTracing", true);
await writeFile(join(ext, "package.json"), JSON.stringify({ name: "deck-local-switch-test", publisher: "deck-test", version: "0.0.1", engines: { vscode: "^1.126.0" }, activationEvents: ["*"], main: "extension.js" }));
const closeCommand = windows ? "workbench.action.quit" : "workbench.action.closeWindow";
await writeFile(join(ext, "extension.js"), `exports.activate=()=>{require('./tests.js').run().finally(()=>require('vscode').commands.executeCommand(${JSON.stringify(closeCommand)}));};`);
await writeFile(join(ext, "tests.js"), `const vscode=require('vscode'),fs=require('fs');exports.run=async()=>{const phases=[];try{const copilot=vscode.extensions.getExtension('github.copilot-chat');if(copilot)await copilot.activate();for(const id of ['a','b','a']){await fetch(${JSON.stringify(base)}+'/control/'+id,{method:'POST'});let models=[];for(let i=0;i<20;i++){models=await vscode.lm.selectChatModels();if(models.some(m=>m.id.includes('fixture-'+id)))break;await new Promise(r=>setTimeout(r,500));}const all=models.map(m=>({id:m.id,name:m.name,vendor:m.vendor})),model=models.find(m=>m.id.includes('fixture-'+id));if(!model)throw Error('No configured model registered by actual VS Code: '+JSON.stringify(all)+'; provider extension: '+Boolean(copilot)+'; active: '+copilot?.isActive);const response=await model.sendRequest([vscode.LanguageModelChatMessage.User('Reply briefly without tools')],{},new vscode.CancellationTokenSource().token);let text='';for await(const chunk of response.text)text+=chunk;phases.push({id,text});if(!text.includes('vscode-live-'+id))throw Error(text);}fs.writeFileSync(${JSON.stringify(join(root, "vscode-report.json"))},JSON.stringify({passed:true,phases}));}catch(e){fs.writeFileSync(${JSON.stringify(join(root, "vscode-report.json"))},JSON.stringify({passed:false,phases,error:String(e)}));throw e;}};`);
const launchEnv = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR", "TMP", "TEMP"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(launchEnv, { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData/Roaming"), LOCALAPPDATA: join(home, "AppData/Local"), HTTP_PROXY: base, HTTPS_PROXY: base, NO_PROXY: "127.0.0.1,localhost" });
const code = spawn(executable, ["--disable-telemetry", "--disable-updates", "--force-disable-user-env", "--use-inmemory-secretstorage", "--new-window", "--user-data-dir", profile, "--extensions-dir", join(root, "extensions"), "--extensionDevelopmentPath=" + ext, "--extensionDevelopmentPath=" + join(resources, "extensions/copilot"), "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", work], { env: launchEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
code.stdout.on("data", (b) => log += b);
code.stderr.on("data", (b) => log += b);
const timer = setTimeout(() => code.kill("SIGKILL"), 6e4);
try {
  await once(code, "exit");
} finally {
  clearTimeout(timer);
  let restoreFailure;
  await app.rpc("toggleTracing", false).catch(error => { restoreFailure = String(error); log += "\nCleanup: " + restoreFailure; });
  const configPaths = (await app.rpc("getClientRoute", "vscode")).configPaths;
  const restored = await Promise.all(configPaths.map(async path => ({path, content: await readFile(path, "utf8").catch(() => null)})));
  if (restored.some(file => /XwX Deck|xwx-deck|127\.0\.0\.1/.test(file.content ?? ""))) restoreFailure ??= "Managed route remains after stopping Trace";
  await app.stop();
  app = startNativeRpc(root);
  const restartRoute = await app.rpc("getClientRoute", "vscode"), restartState = await app.rpc("getState");
  const restartRetained = restartRoute.providerId === "a" && restartRoute.model === "fixture-a" && !restartState.tracingEnabled;
  await app.stop();
  server.closeAllConnections();
  server.close();
  const detail = await readFile(join(root, "vscode-report.json"), "utf8").then(JSON.parse, () => ({ passed: false, error: "VS Code test host did not report" }));
  detail.restoreVerified = !restoreFailure; detail.restartRetained = restartRetained; detail.restored = restored; if (restoreFailure || !restartRetained) { detail.passed = false; detail.error = restoreFailure ?? "Saved route or Trace state changed after restart"; }
  if (detail.passed && (calls.length < 3 || !calls.every(call => call.keyCorrect && call.model === "fixture-" + call.selected && call.path.startsWith("/" + call.selected + "/")))) { detail.passed = false; detail.error = "Actual editor request did not match its selected endpoint, model and credential"; }
  await writeFile("test-results/live-client-switch-vscode.json", JSON.stringify({ client: "vscode", version: JSON.parse(await readFile(join(resources, "package.json"), "utf8")).version, binarySha256: createHash("sha256").update(await readFile(nativeTestBinary)).digest("hex"), root, ...detail, calls, log: log.slice(-2500) }, null, 2));
  console.log(JSON.stringify({ root, ...detail, calls }));
  if (!detail.passed) process.exitCode = 1;
}
