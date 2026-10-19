import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { nativeTestBinary, writeCliFixture } from "./test-support.mjs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, realpath, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startNativeRpc } from "./rpc-test-session.mjs";
const [exe, claudeExe] = process.argv.slice(2);
const client = "provider-ui";
// Opt-in: node client-switch-live-test.mjs <client-id> <official-executable>.
// HOME and all credentials are disposable; only the local upstream may answer.
const startedAt = new Date().toISOString();
if (!exe || !claudeExe) throw Error("Pass official Codex and Claude executables explicitly");
const root = await mkdtemp(join(await realpath(tmpdir()), "xwx-live-" + client + "-")), home = join(root, "client-home"), work = join(root, "workspace");
await writeFile(join(root, ".xwx-rust-pilot"), "isolated-rust-pilot-v1\n");
await mkdir(work, { recursive: true });
await mkdir(home, { recursive: true });
const calls = [], phases = [];
let phase, base, session;
const server = createServer(async (req, res) => {
  if (req.url.startsWith("/control/")) { await control(req,res); return; }
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
    res.end(JSON.stringify({ models:["fixture-a","fixture-b"].map(slug=>({slug,visibility:"list",display_name:slug})), data: ["fixture-a", "fixture-b"].map((id2) => ({ id: id2, object: "model", created: 1, owned_by: "fixture", context_window: 131072, context_length: 131072, max_output_tokens: 8192 })) }));
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

const sessions={}, turns=[], originalClaude={env:{RETAIN_EXTERNAL_FIELD:"synthetic-preserved"},permissions:{allow:["Read"]}};
process.env.XWX_CLIENT_INSTALLATIONS_TEST_HOME=home;
await mkdir(join(home,'.local/bin'),{recursive:true});
for(const [id,path]of [['codex',exe],['claude',claudeExe]]){
 if(process.platform==='win32')await writeCliFixture(join(home,'.local/bin',id),'process.exit(0);');
 else await symlink(path,join(home,'.local/bin',id));
}
let app=startNativeRpc(root,['--subscription-test-endpoint',base]);
await app.rpc('getState');
await writeFile(join(root,'claude/settings.json'),JSON.stringify(originalClaude));
const claims=Buffer.from(JSON.stringify({sub:'ui-fixture',email:'ui@example.test',exp:Math.floor(Date.now()/1000)+3600,'https://api.openai.com/auth':{chatgpt_account_id:'ui-fixture',chatgpt_plan_type:'plus',chatgpt_user_id:'ui-fixture'}})).toString('base64url');
await writeFile(join(root,'codex/auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'SYNTHETIC-b',id_token:'eyJhbGciOiJub25lIn0.'+claims+'.fixture',refresh_token:'synthetic-preserved',account_id:'ui-fixture'}}));
await writeFile(join(root,'codex/config.toml'),'model_provider="openai"\nmodel="fixture-b"\nchatgpt_base_url="'+base+'/backend-api"\n');
await app.rpc('connectSubscriptionAccount','official-chatgpt');
await app.rpc('saveProvider',{id:'a',displayName:'UI DeepSeek A',adapter:'responses',baseUrl:base+'/a/v1',bearerToken:'SYNTHETIC-a',codexModel:'fixture-a'});
await app.rpc('saveProvider',{id:'b',displayName:'UI API B',adapter:'responses',baseUrl:base+'/b/v1',bearerToken:'SYNTHETIC-b',codexModel:'fixture-b'});
await app.rpc('saveProvider',{id:'claude-a',displayName:'UI DeepSeek Claude A',adapter:'anthropic-messages',baseUrl:base+'/a/v1',bearerToken:'SYNTHETIC-a',codexModel:'fixture-a'});
for(const id of ['codex','claude']){await app.rpc('addModelClient',id);await app.rpc('switchClientProvider',{client:id,providerId:id==='claude'?'claude-a':'a'});}
await app.rpc('updateCodexConfig',{expectedProviderId:'a',compatibleModel:'fixture-a'});
await app.rpc('updateClaudeModels',{sonnet:'fixture-a'});
await app.stop();
const binary=nativeTestBinary, started=Date.now();
const ui=spawn(binary,['--pilot-root',root,'--subscription-test-endpoint',base,...(process.env.XWX_NATIVE_UI_MANUAL==='1'?['--smoke','--smoke-provider-switch','--smoke-physical','--smoke-upstream',base]:['--smoke','--smoke-provider-switch','--smoke-upstream',base,'--smoke-exit'])],{env:{...process.env,XWX_DECK_TEST_SECURE_STORE:'1',XWX_CLIENT_INSTALLATIONS_TEST_HOME:home,XWX_SYSTEM_LANGUAGE_TEST:'zh-CN'},stdio:['ignore','pipe','pipe']});
let uiLog='';ui.stdout.on('data',b=>uiLog+=b);ui.stderr.on('data',b=>uiLog+=b);
const ready={root,base,pid:ui.pid,binarySha256:createHash('sha256').update(await readFile(binary)).digest('hex')};
await writeFile(join(tmpdir(), 'xwx-provider-ui-session.json'),JSON.stringify(ready));console.log(JSON.stringify(ready));
async function runClient(id){
 const cmd=id==='codex'?exe:claudeExe;
 let args=id==='codex'?['exec','--skip-git-repo-check','--ignore-rules','-s','read-only','--json','Reply briefly without tools.']:['--bare','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','','--no-chrome','--model','sonnet','--output-format','json','-p','Reply briefly without tools.'];
 if(sessions[id]){if(id==='codex')args=['exec','resume','--skip-git-repo-check','--json',sessions[id],'Reply briefly without tools.'];else args.unshift('--resume',sessions[id]);}
 const p=spawn(cmd,args,{cwd:work,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',errors='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>errors+=b);const timer=setTimeout(()=>p.kill('SIGKILL'),45000);let code;try{[code]=await once(p,'exit')}finally{clearTimeout(timer)}
 for(const line of output.split('\n'))try{const e=JSON.parse(line);sessions[id]??=id==='codex'?e.thread_id:e.session_id;}catch{}
 return{code,output,errors};
}
async function control(req,res){
 res.setHeader('content-type','application/json');try{
 const path=new URL(req.url,'http://fixture').pathname;
 if(path==='/control/state'){res.end(JSON.stringify({settings:JSON.parse(await readFile(join(root,'settings.json'),'utf8')),claude:JSON.parse(await readFile(join(root,'claude/settings.json'),'utf8')),turns}));return;}
 if(path.startsWith('/control/run/')){
  const [, , ,id,expected]=path.split('/');if(!['codex','claude'].includes(id)||!['a','b'].includes(expected))throw Error('Invalid fixture phase');phase=id+'-'+expected+'-'+turns.length;
  const previous=turns.filter(t=>t.client===id).at(-1),before=calls.length,result=await runClient(id),observed=calls.slice(before);
  const turn={client:id,expected,session:sessions[id],code:result.code,calls:observed.map(c=>({provider:c.provider,path:c.path,model:c.model,correctKey:c.correctKey})),historyRetained:previous?observed.some(c=>JSON.stringify(c.body).includes('live-switch-'+previous.expected)):null,output:result.output.slice(-2000),errors:result.errors.slice(-1200)};turns.push(turn);
  turn.passed=result.code===0&&observed.length>0&&observed.every(c=>c.provider===expected&&c.correctKey&&c.model==='fixture-'+expected)&&result.output.includes('live-switch-'+expected)&&(!previous||turn.historyRetained);await writeFile('test-results/native-provider-switch-progress.json',JSON.stringify({...ready,turns},null,2));res.end(JSON.stringify(turn));return;
 }
 if(path==='/control/finish'){
  if(ui.exitCode===null&&ui.signalCode===null){const done=once(ui,'exit');ui.kill('SIGTERM');await done;}
  const report={...ready,finishedAt:new Date().toISOString(),turns,passed:turns.length>=8&&turns.every(t=>t.passed),uiLog};await writeFile('test-results/native-provider-switch.json',JSON.stringify(report,null,2));res.end(JSON.stringify(report));setTimeout(()=>server.close(),100);return;
 }
 throw Error('Unknown fixture action');
 }catch(error){res.statusCode=500;res.end(JSON.stringify({error:String(error)}));}
}

if(process.env.XWX_NATIVE_UI_MANUAL!=='1'){
 let result, failure;
 try{
  for(let i=0;i<1800;i++){
   result=await readFile(join(root,'native-smoke.json'),'utf8').then(JSON.parse,()=>null);
   if(result)break;
   if(ui.exitCode!==null||ui.signalCode!==null)throw Error('Native UI exited before reporting: '+uiLog);
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(result,'Native provider UI timed out');
  assert.equal(result.passed,true,JSON.stringify(result));
  assert.ok(turns.length>=8&&turns.every(turn=>turn.passed),'All actual CLI requests must match UI choices');
  if(ui.exitCode===null&&ui.signalCode===null)await once(ui,'exit');
  const reopened=startNativeRpc(root,['--subscription-test-endpoint',base]);
  try{const state=await reopened.rpc('getState'),providers=await reopened.rpc('getProviders');assert.equal(state.tracingEnabled,false);assert.equal(providers.selected.codex,'a');assert.equal(providers.selected.claude,'claude-a');}finally{await reopened.stop();}
 }catch(error){failure=String(error);}
 finally{
  if(ui.exitCode===null&&ui.signalCode===null){const done=once(ui,'exit');ui.kill('SIGTERM');await done;}
  server.closeAllConnections();server.close();
  const report={...ready,...result,passed:!failure&&result?.passed===true,turns,restartRetained:!failure,uiLog,...failure?{failure}:{}};
  await writeFile('test-results/native-provider-switch.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,turns:turns.length,root,binarySha256:ready.binarySha256,failure}));
  if(failure)process.exitCode=1;
 }
}
