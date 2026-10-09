//! Cursor Connect/protobuf adapter, based on magpie-community's MIT Cursor provider.
//! Only caller-supplied MCP tool calls leave this adapter. Remote shell/file requests are refused.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use std::collections::HashMap;
#[derive(Default, Clone)]
struct Pb(Vec<u8>);
impl Pb {
    fn uv(&mut self, mut n: u64) {
        while n >= 128 {
            self.0.push(n as u8 | 128);
            n >>= 7;
        }
        self.0.push(n as u8);
    }
    fn var(mut self, k: u64, n: u64) -> Self {
        self.uv(k * 8);
        self.uv(n);
        self
    }
    fn bytes(mut self, k: u64, b: &[u8]) -> Self {
        self.uv(k * 8 + 2);
        self.uv(b.len() as u64);
        self.0.extend(b);
        self
    }
    fn msg(self, k: u64, b: Pb) -> Self {
        self.bytes(k, &b.0)
    }
    fn string(self, k: u64, s: &str) -> Self {
        self.bytes(k, s.as_bytes())
    }
}
struct Field {
    num: u64,
    n: u64,
    b: Vec<u8>,
}
fn fields(b: &[u8]) -> Result<Vec<Field>> {
    fn uv(b: &[u8], i: &mut usize) -> Result<u64> {
        let mut n = 0u64;
        for shift in (0..70).step_by(7) {
            let c = *b.get(*i).ok_or("Cursor protobuf 截断")?;
            *i += 1;
            if shift == 63 && c > 1 {
                return Err("Cursor protobuf 整数溢出".into());
            }
            n |= ((c & 127) as u64) << shift;
            if c < 128 {
                return Ok(n);
            }
        }
        Err("Cursor protobuf 整数溢出".into())
    }
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        let tag = uv(b, &mut i)?;
        if out.len() > 100000 {
            return Err("Cursor protobuf field limit exceeded".into());
        }
        if tag / 8 == 0 {
            return Err("Cursor protobuf 字段无效".into());
        }
        let (n, data) = match tag % 8 {
            0 => (uv(b, &mut i)?, vec![]),
            1 | 5 => {
                let size = if tag % 8 == 1 { 8 } else { 4 };
                let data = b.get(i..i + size).ok_or("Cursor protobuf 截断")?.to_vec();
                i += size;
                (0, data)
            }
            2 => {
                let size = usize::try_from(uv(b, &mut i)?).map_err(err)?;
                let end = i.checked_add(size).ok_or("Cursor protobuf 长度溢出")?;
                let data = b.get(i..end).ok_or("Cursor protobuf 截断")?.to_vec();
                i = end;
                (0, data)
            }
            _ => return Err("Cursor protobuf 字段类型无效".into()),
        };
        out.push(Field {
            num: tag / 8,
            n,
            b: data,
        });
    }
    Ok(out)
}
fn number(f: &[Field], k: u64) -> u64 {
    f.iter().find(|f| f.num == k).map(|f| f.n).unwrap_or(0)
}
fn string(f: &[Field], k: u64) -> String {
    f.iter()
        .find(|f| f.num == k)
        .map(|f| String::from_utf8_lossy(&f.b).into_owned())
        .unwrap_or_default()
}
fn value(v: &Value) -> Pb {
    match v {
        Value::Null => Pb::default().var(1, 0),
        Value::Bool(b) => Pb::default().var(4, *b as u64),
        Value::Number(n) => {
            let mut p = Pb::default();
            p.uv(17);
            p.0.extend(n.as_f64().unwrap_or(0.0).to_le_bytes());
            p
        }
        Value::String(s) => Pb::default().string(3, s),
        Value::Array(a) => {
            let mut p = Pb::default();
            for v in a {
                p = p.msg(1, value(v));
            }
            Pb::default().msg(6, p)
        }
        Value::Object(o) => {
            let mut p = Pb::default();
            for (k, v) in o {
                p = p.msg(1, Pb::default().string(1, k).msg(2, value(v)));
            }
            Pb::default().msg(5, p)
        }
    }
}
fn any(b: &[u8], depth: u8) -> Result<Value> {
    if depth > 64 {
        return Err("Cursor 工具参数嵌套过深".into());
    }
    for f in fields(b)? {
        return match f.num {
            1 => Ok(Value::Null),
            2 => Ok(json!(f64::from_le_bytes(
                f.b.try_into().map_err(|_| "Cursor 数值参数无效")?
            ))),
            3 => Ok(json!(String::from_utf8(f.b).map_err(err)?)),
            4 => Ok(json!(f.n != 0)),
            5 => {
                let mut m = serde_json::Map::new();
                for e in fields(&f.b)?.into_iter().filter(|f| f.num == 1) {
                    let kv = fields(&e.b)?;
                    m.insert(
                        string(&kv, 1),
                        if let Some(v) = kv.iter().find(|f| f.num == 2) {
                            any(&v.b, depth + 1)?
                        } else {
                            Value::Null
                        },
                    );
                }
                Ok(Value::Object(m))
            }
            6 => Ok(Value::Array(
                fields(&f.b)?
                    .into_iter()
                    .filter(|f| f.num == 1)
                    .map(|f| any(&f.b, depth + 1))
                    .collect::<Result<Vec<_>>>()?,
            )),
            _ => Err("Cursor 参数类型无效".into()),
        };
    }
    Ok(Value::Null)
}
fn frame(b: Pb) -> Vec<u8> {
    let mut out = vec![0];
    out.extend((b.0.len() as u32).to_be_bytes());
    out.extend(b.0);
    out
}
pub(super) fn uuid() -> Result<String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(err)?;
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    let s = b.iter().map(|b| format!("{b:02x}")).collect::<String>();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &s[..8],
        &s[8..12],
        &s[12..16],
        &s[16..20],
        &s[20..]
    ))
}
fn content(v: &Value) -> String {
    v.as_str().map(str::to_string).unwrap_or_else(|| {
        v.as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
    })
}
fn tool_def(t: &Value) -> Pb {
    let f = &t["function"];
    let schema = f
        .get("parameters")
        .cloned()
        .unwrap_or(json!({"type":"object","properties":{}}));
    Pb::default()
        .string(1, text(f, "name"))
        .string(2, text(f, "description"))
        .msg(3, value(&schema))
        .string(4, "xwxdeck")
        .string(5, text(f, "name"))
        .string(6, &schema.to_string())
}
fn environment() -> Pb {
    Pb::default()
        .string(1, std::env::consts::OS)
        .string(2, &std::env::temp_dir().to_string_lossy())
        .string(10, "UTC")
}
fn conversation(chat: &Value, tools: &[Value]) -> Result<(Vec<Vec<u8>>, String)> {
    let messages = chat["messages"].as_array().ok_or("Cursor 对话内容无效")?;
    let mut system = messages
        .iter()
        .filter(|m| ["system", "developer"].contains(&text(m, "role")))
        .map(|m| content(&m["content"]))
        .collect::<Vec<_>>()
        .join("\n\n");
    if !tools.is_empty() {
        system.push_str("\n<dynamic_tool_catalog>\nMCP namespace xwxdeck provides the following tools. Call them only through CallDynamicTool({\"namespace\":\"xwxdeck\",\"toolName\":name,\"arguments\":arguments}).\n");
        for t in tools {
            system.push_str(&format!(
                "{}: {}\narguments schema: {}\n",
                text(&t["function"], "name"),
                text(&t["function"], "description"),
                t["function"]["parameters"]
            ));
        }
        system.push_str("</dynamic_tool_catalog>");
    }
    let mut out = vec![];
    let mut last = ".".to_string();
    if !system.is_empty() {
        out.push(serde_json::to_vec(&json!({"role":"system","content":system})).map_err(err)?);
    }
    let mut pending = Vec::<String>::new();
    let mut results = vec![];
    let flush = |out: &mut Vec<Vec<u8>>,
                 pending: &mut Vec<String>,
                 results: &mut Vec<Value>|
     -> Result<()> {
        for id in pending.drain(..) {
            results.push(json!({"type":"tool-result","toolCallId":id,"toolName":"CallDynamicTool","result":"Tool use interrupted without a result.","isError":true}));
        }
        if !results.is_empty() {
            out.push(
                serde_json::to_vec(&json!({"role":"tool","content":std::mem::take(results)}))
                    .map_err(err)?,
            );
        }
        Ok(())
    };
    for m in messages {
        match text(m, "role") {
            "system" | "developer" => continue,
            "tool" => {
                let id = text(m, "tool_call_id").replace("__fc_", "\nfc_");
                if let Some(i) = pending.iter().position(|s| s == &id) {
                    pending.remove(i);
                    let txt = content(&m["content"]);
                    results.push(json!({"type":"tool-result","toolCallId":id,"toolName":"CallDynamicTool","result":serde_json::from_str::<Value>(&txt).unwrap_or(json!(txt)),"experimental_content":[{"type":"text","text":txt}]}));
                }
            }
            "assistant" => {
                flush(&mut out, &mut pending, &mut results)?;
                let mut parts = vec![];
                let txt = content(&m["content"]);
                if !txt.is_empty() {
                    parts.push(json!({"type":"text","text":txt}));
                }
                for call in m["tool_calls"].as_array().into_iter().flatten() {
                    let id = text(call, "id").replace("__fc_", "\nfc_");
                    parts.push(json!({"type":"tool-call","toolCallId":id,"toolName":"CallDynamicTool","args":{"namespace":"xwxdeck","toolName":call["function"]["name"],"arguments":serde_json::from_str::<Value>(text(&call["function"],"arguments")).map_err(|_|"工具参数不是有效 JSON")?}}));
                    pending.push(id);
                }
                if !parts.is_empty() {
                    out.push(
                        serde_json::to_vec(&json!({"role":"assistant","content":parts}))
                            .map_err(err)?,
                    );
                }
            }
            _ => {
                flush(&mut out, &mut pending, &mut results)?;
                let mut parts = vec![];
                if let Some(txt) = m["content"].as_str() {
                    last = txt.into();
                    parts.push(json!({"type":"text","text":txt}));
                } else {
                    for part in m["content"].as_array().into_iter().flatten() {
                        match text(part, "type") {
                            "text" => {
                                last = text(part, "text").into();
                                parts.push(json!({"type":"text","text":last}));
                            }
                            "image_url" => {
                                let raw = part["image_url"]
                                    .as_str()
                                    .or_else(|| part["image_url"]["url"].as_str())
                                    .unwrap_or("");
                                let (mime, data) = raw
                                    .strip_prefix("data:")
                                    .and_then(|s| s.split_once(";base64,"))
                                    .ok_or("Cursor 图片需要以内嵌图片形式发送")?;
                                let bytes = STANDARD.decode(data).map_err(|_| "图片编码无效")?;
                                parts.push(json!({"type":"image","mimeType":mime,"image":{"__type":"Uint8Array","hex":bytes.iter().map(|b|format!("{b:02x}")).collect::<String>()}}));
                            }
                            _ => return Err("Cursor 暂不支持此附件格式".into()),
                        }
                    }
                }
                if !parts.is_empty() {
                    out.push(
                        serde_json::to_vec(&json!({"role":"user","content":parts})).map_err(err)?,
                    );
                }
            }
        }
    }
    flush(&mut out, &mut pending, &mut results)?;
    Ok((out, last))
}
fn build(
    chat: &Value,
    tools: &[Value],
    catalog: Option<&Value>,
) -> Result<(Pb, HashMap<Vec<u8>, Vec<u8>>, Value)> {
    use sha2::{Digest, Sha256};
    let (mut blobs, mut state) = (HashMap::new(), Pb::default());
    let mut put = |data: Vec<u8>| {
        let id = Sha256::digest(&data).to_vec();
        blobs.insert(id.clone(), data);
        id
    };
    let (messages, last) = conversation(chat, tools)?;
    for m in messages {
        state = state.bytes(1, &put(m));
    }
    let mid = uuid()?;
    let user = Pb::default().string(1, &last).string(2, &mid).var(4, 1);
    let turn = Pb::default().msg(1, Pb::default().bytes(1, &put(user.0)).string(10, &mid));
    state = state.bytes(8, &put(turn.0)).var(10, 1).string(22, "cli");
    let mut rc = Pb::default().msg(4, environment());
    let mut mcp = Pb::default();
    for tool in tools {
        rc = rc.msg(7, tool_def(tool));
        mcp = mcp.msg(1, tool_def(tool));
    }
    let wanted = text(chat, "model");
    let name = if wanted == "auto" { "default" } else { wanted };
    let entry = catalog
        .and_then(|c| c["models"].as_array())
        .and_then(|m| m.iter().find(|m| text(m, "name") == name));
    let variant = entry.and_then(|m| m["variants"].as_array()).and_then(|v| {
        v.iter()
            .find(|v| v["isDefaultNonMaxConfig"] == true)
            .or_else(|| v.iter().find(|v| v["isDefaultMaxConfig"] == true))
            .or(v.first())
    });
    let actual = variant
        .map(|v| text(v, "legacySlug"))
        .filter(|v| !v.is_empty())
        .unwrap_or(name);
    let max = entry.is_some_and(|m| m["supportsNonMaxMode"] == false)
        || variant.is_some_and(|v| v["isMaxMode"] == true);
    let mut details = Pb::default()
        .string(1, actual)
        .string(3, actual)
        .string(4, actual);
    let mut requested = Pb::default().string(1, actual);
    if max {
        details = details.var(7, 1);
        requested = requested.var(2, 1);
    }
    for p in variant
        .and_then(|v| v["parameterValues"].as_array())
        .into_iter()
        .flatten()
    {
        requested = requested.msg(
            3,
            Pb::default()
                .string(1, text(p, "id"))
                .string(2, text(p, "value")),
        );
    }
    let conversation = uuid()?;
    Ok((
        Pb::default().msg(
            1,
            Pb::default()
                .msg(1, state)
                .msg(2, Pb::default().msg(2, Pb::default().msg(2, rc)))
                .msg(3, details)
                .msg(4, mcp)
                .string(5, &conversation)
                .msg(9, requested)
                .var(19, 1),
        ),
        blobs,
        json!({"model":actual,"conversationId":conversation,"maxMode":max,"tools":tools.iter().map(|t|t["function"]["name"].clone()).collect::<Vec<_>>()}),
    ))
}
async fn send(tx: &tokio::sync::mpsc::Sender<Vec<u8>>, p: Pb) -> Result<()> {
    tx.send(frame(p))
        .await
        .map_err(|_| "Cursor 请求流已关闭".into())
}
fn failure(http_status: u16, value: &Value) -> Value {
    let error = value
        .get("error")
        .filter(|value| value.is_object())
        .unwrap_or(value);
    let code = text(error, "code");
    let mut message = text(error, "message").to_string();
    for detail in error["details"].as_array().into_iter().flatten() {
        let title = text(&detail["debug"]["details"], "title");
        let description = text(&detail["debug"]["details"], "detail");
        let description = [title, description]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(": ");
        if !description.is_empty() {
            message = description;
        }
    }
    if message.is_empty() || message == "Error" {
        message = code.into();
    }
    let status = match code {
        "permission_denied" => 403,
        "unauthenticated" => 401,
        "resource_exhausted" => 429,
        "invalid_argument" => 400,
        "unavailable" => 503,
        _ => {
            if http_status >= 400 {
                http_status
            } else {
                502
            }
        }
    };
    if message.is_empty() {
        message = format!("HTTP {status}");
    }
    json!({"_cursor_status":status,"error":{"type":if code.is_empty(){"upstream_error"}else{code},"message":format!("Cursor：{}",message.chars().take(1000).collect::<String>())}})
}
pub(super) async fn run(
    token: &str,
    base: &str,
    chat: &Value,
    catalog: Option<&Value>,
    test: bool,
) -> Result<(Value, Value)> {
    let tools: Vec<_> = if chat["tool_choice"] == "none" {
        vec![]
    } else {
        chat["tools"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|t| t["type"] == "function" && !text(&t["function"], "name").is_empty())
            .cloned()
            .collect()
    };
    let (first, blobs, sent) = build(chat, &tools, catalog)?;
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
    send(&tx, first).await?;
    let body = reqwest::Body::wrap_stream(
        async_stream::stream! {while let Some(data)=rx.recv().await{yield Ok::<_,std::io::Error>(data);}},
    );
    let builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(240))
        .redirect(reqwest::redirect::Policy::none());
    let client = if test {
        builder.no_proxy().http2_prior_knowledge()
    } else {
        builder
    }
    .build()
    .map_err(err)?;
    let mut req = client
        .post(format!(
            "{}/agent.v1.AgentService/Run",
            base.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .header("content-type", "application/connect+proto")
        .header(
            "x-cursor-agent-allowed-tools",
            "mcp_tool_call,get_mcp_tools_tool_call",
        )
        .header("x-request-id", uuid()?)
        .body(body);
    for (k, v) in cursor_accounts::CursorAccounts::headers() {
        req = req.header(k, v);
    }
    let response = req.send().await.map_err(|_| "Cursor 流式连接失败")?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response
            .bytes()
            .await
            .map_err(|_| "Cursor 错误响应读取失败")?;
        if body.len() > 1024 * 1024 {
            return Err("Cursor 错误响应过大".into());
        }
        let error =
            serde_json::from_slice(&body).unwrap_or(json!({"message":format!("HTTP {status}")}));
        return Ok((failure(status, &error), sent));
    }
    let mut stream = response.bytes_stream();
    let mut buffer = vec![];
    let (mut answer, mut reasoning, mut calls) =
        (String::new(), String::new(), Vec::<Value>::new());
    let mut listed = 0;
    let mut ended = false;
    let mut usage = json!({"prompt_tokens":0,"completion_tokens":0,"total_tokens":0});
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    'outer: loop {
        let chunk = tokio::select! {_=heartbeat.tick()=>{send(&tx,Pb::default().bytes(7,&[])).await?;continue;},chunk=stream.next()=>chunk};
        let Some(chunk) = chunk else {
            if !ended && calls.is_empty() {
                return Err("Cursor 响应中断".into());
            }
            break;
        };
        let chunk = chunk.map_err(|_| "Cursor 响应流中断")?;
        if buffer.len() + chunk.len() > 32 * 1024 * 1024 {
            return Err("Cursor 响应超过 32 MB 上限".into());
        }
        buffer.extend(chunk);
        while buffer.len() >= 5 {
            let n = u32::from_be_bytes(buffer[1..5].try_into().unwrap()) as usize;
            if n > 32 * 1024 * 1024 {
                return Err("Cursor 响应帧过大".into());
            }
            if buffer.len() < 5 + n {
                break;
            }
            let flags = buffer[0];
            let data = buffer[5..5 + n].to_vec();
            buffer.drain(..5 + n);
            if flags & 1 != 0 {
                return Err("Cursor 返回了未协商的压缩帧".into());
            }
            if flags & 2 != 0 {
                let end: Value = serde_json::from_slice(&data).map_err(|_| "Cursor 结束帧无效")?;
                if end["error"].is_object() {
                    return Ok((failure(200, &end), sent));
                }
                ended = true;
                break 'outer;
            }
            for m in fields(&data)? {
                match m.num {
                    1 => {
                        for update in fields(&m.b)? {
                            let u = fields(&update.b)?;
                            match update.num {
                                1 => answer.push_str(&string(&u, 1)),
                                4 => reasoning.push_str(&string(&u, 1)),
                                14 => {
                                    let input = number(&u, 1);
                                    let output = number(&u, 2);
                                    usage = json!({"prompt_tokens":input,"completion_tokens":output,"total_tokens":input+output,"prompt_tokens_details":{"cached_tokens":number(&u,3),"cache_write_tokens":number(&u,4)},"completion_tokens_details":{"reasoning_tokens":number(&u,5)}});
                                    ended = true;
                                    if calls.is_empty() {
                                        break 'outer;
                                    }
                                }
                                27 => {
                                    listed = number(&u, 1) as usize;
                                    if listed > 0 && calls.len() >= listed {
                                        ended = true;
                                        break 'outer;
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    2 => {
                        let es = fields(&m.b)?;
                        let id = number(&es, 1);
                        let exec_id = string(&es, 15);
                        let mut handled = false;
                        for e in &es {
                            match e.num {
                                11 => {
                                    let a = fields(&e.b)?;
                                    let name = string(&a, 5);
                                    let name = if name.is_empty() {
                                        string(&a, 1).trim_start_matches("xwxdeck-").to_string()
                                    } else {
                                        name
                                    };
                                    if !tools.iter().any(|t| text(&t["function"], "name") == name) {
                                        return Err("Cursor 返回了未提供的工具调用".into());
                                    }
                                    let mut args = serde_json::Map::new();
                                    for kv in a.iter().filter(|f| f.num == 2) {
                                        let kv = fields(&kv.b)?;
                                        args.insert(
                                            string(&kv, 1),
                                            if let Some(v) = kv.iter().find(|f| f.num == 2) {
                                                any(&v.b, 0)?
                                            } else {
                                                Value::Null
                                            },
                                        );
                                    }
                                    let call = string(&a, 3).replace('\n', "__");
                                    calls.push(json!({"id":if call.is_empty(){format!("call_{}",uuid()?)}else{call},"type":"function","function":{"name":name,"arguments":Value::Object(args).to_string()}}));
                                    handled = true;
                                }
                                36 => {
                                    let mut server = Pb::default()
                                        .string(1, "xwxdeck")
                                        .string(2, "xwxdeck")
                                        .string(7, "connected");
                                    for t in &tools {
                                        server = server.msg(5, tool_def(t));
                                    }
                                    send(
                                        &tx,
                                        Pb::default().msg(
                                            2,
                                            Pb::default().var(1, id).string(15, &exec_id).msg(
                                                36,
                                                Pb::default().msg(1, Pb::default().msg(1, server)),
                                            ),
                                        ),
                                    )
                                    .await?;
                                    handled = true;
                                }
                                10 => {
                                    send(
                                        &tx,
                                        Pb::default().msg(
                                            2,
                                            Pb::default().var(1, id).string(15, &exec_id).msg(
                                                10,
                                                Pb::default().msg(
                                                    1,
                                                    Pb::default().msg(
                                                        1,
                                                        Pb::default().msg(4, environment()),
                                                    ),
                                                ),
                                            ),
                                        ),
                                    )
                                    .await?;
                                    handled = true;
                                }
                                _ => {}
                            }
                        }
                        if !handled {
                            send(
                                &tx,
                                Pb::default().msg(
                                    5,
                                    Pb::default().msg(
                                        2,
                                        Pb::default().var(1, id).string(2, "not available"),
                                    ),
                                ),
                            )
                            .await?;
                        }
                        if !es.iter().any(|f| f.num == 11) {
                            send(
                                &tx,
                                Pb::default()
                                    .msg(5, Pb::default().msg(1, Pb::default().var(1, id))),
                            )
                            .await?;
                        }
                        if listed > 0 && calls.len() >= listed {
                            ended = true;
                            break 'outer;
                        }
                    }
                    4 => {
                        let kv = fields(&m.b)?;
                        let id = number(&kv, 1);
                        for k in kv.iter() {
                            if k.num == 2 {
                                let wanted = fields(&k.b)?;
                                let blob = wanted
                                    .iter()
                                    .find(|f| f.num == 1)
                                    .and_then(|f| blobs.get(&f.b));
                                let result = if let Some(blob) = blob {
                                    Pb::default().bytes(1, blob)
                                } else {
                                    Pb::default().msg(2, Pb::default().string(1, "blob not found"))
                                };
                                send(
                                    &tx,
                                    Pb::default().msg(3, Pb::default().var(1, id).msg(2, result)),
                                )
                                .await?;
                            } else if k.num == 3 {
                                send(
                                    &tx,
                                    Pb::default().msg(3, Pb::default().var(1, id).bytes(3, &[])),
                                )
                                .await?;
                            }
                        }
                    }
                    _ => {}
                }
            }
            if answer.len()
                + reasoning.len()
                + calls.iter().map(|v| v.to_string().len()).sum::<usize>()
                > 32 * 1024 * 1024
            {
                return Err("Cursor 回答超过 32 MB 上限".into());
            }
        }
    }
    drop(tx);
    if !ended && calls.is_empty() || answer.is_empty() && calls.is_empty() {
        return Err("Cursor 没有返回完整回答".into());
    }
    let mut message = json!({"role":"assistant","content":answer});
    if !reasoning.is_empty() {
        message["reasoning_content"] = json!(reasoning);
    }
    if !calls.is_empty() {
        message["tool_calls"] = json!(calls);
    }
    Ok((
        json!({"id":format!("chatcmpl-{}",uuid()?),"object":"chat.completion","model":chat["model"],"choices":[{"index":0,"message":message,"finish_reason":if calls.is_empty(){"stop"}else{"tool_calls"}}],"usage":usage}),
        sent,
    ))
}
