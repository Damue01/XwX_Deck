//! Client-facing protocols share the existing capture and upstream accounting path.
use super::*;
use futures_util::StreamExt;
#[derive(Clone)]
pub(super) struct Origin {
    pub client: String,
    pub path: String,
    pub protocol: String,
    pub body: Value,
}
pub(super) fn label(id: &str) -> &str {
    match id {
        "opencode" => "OpenCode",
        "gemini-cli" => "Gemini CLI",
        "qwen-code" => "Qwen Code",
        "cline" => "Cline",
        "cherry-studio" => "Cherry Studio",
        "pi" => "Pi",
        "oh-my-pi" => "oh-my-pi",
        "crush" => "Crush",
        "qoder" => "Qoder",
        "droid" => "Droid",
        "copilot-cli" => "GitHub Copilot CLI",
        "cursor" | "cursor-cli" => "Cursor",
        "mimo-code" => "MiMo Code",
        "workbuddy" => "WorkBuddy",
        "codebuddy-code" => "CodeBuddy Code",
        "hermes-agent" => "Hermes Agent",
        "antigravity-cli" => "Antigravity CLI",
        "openchamber" => "OpenChamber",
        "t3-code" => "T3 Code",
        "zed" => "Zed",
        "goose" => "Goose",
        "vscode" => "VS Code",
        "api-client" => "API 客户端",
        _ => id,
    }
}
pub(super) fn valid_client(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && !["claude", "codex", "claude-cli", "codex-cli"].contains(&id)
}
fn chat_input(body: &Value) -> Result<Value> {
    if body.get("n").is_some_and(|n| n != 1) {
        return Err("当前 Gateway 每次支持一个回答，请将 n 设为 1".into());
    }
    let messages = body["messages"].as_array().ok_or("messages 必须是数组")?;
    let mut input = vec![];
    for m in messages {
        let role = text(m, "role");
        if role == "tool" {
            input.push(json!({"type":"function_call_output","call_id":m["tool_call_id"],"output":m["content"]}));
            continue;
        }
        if !["system", "developer", "user", "assistant"].contains(&role) {
            return Err(format!("不支持 {role} 消息角色，未删除原输入"));
        }
        if let Some(thought) = m["reasoning_content"].as_str() {
            if !thought.is_empty() {
                input.push(
                    json!({"type":"reasoning","summary":[{"type":"summary_text","text":thought}]}),
                );
            }
        }
        if !m["content"].is_null() {
            let content = if m["content"].is_string() {
                m["content"].clone()
            } else {
                let mut parts = vec![];
                for part in m["content"].as_array().ok_or("无效消息内容")? {
                    parts.push(match text(part,"type") {
                        "text"=>json!({"type":if role=="assistant"{"output_text"}else{"input_text"},"text":part["text"]}),
                        "image_url"=>json!({"type":"input_image","image_url":part["image_url"]["url"],"detail":part["image_url"].get("detail").cloned().unwrap_or(json!("auto"))}),
                        _=>return Err("当前转换不支持此内容类型，原输入已保留".into()),
                    });
                }
                json!(parts)
            };
            input.push(json!({"role":role,"content":content}));
        }
        if let Some(calls) = m["tool_calls"].as_array() {
            for call in calls {
                if call["type"] != "function" {
                    return Err("仅支持 function 工具，未删除原工具".into());
                }
                input.push(json!({"type":"function_call","call_id":call["id"],"name":call["function"]["name"],"arguments":call["function"]["arguments"]}));
            }
        }
    }
    let mut out = body.clone();
    let map = out.as_object_mut().ok_or("请求必须是对象")?;
    map.remove("messages");
    map.insert("input".into(), json!(input));
    if let Some(tools) = body["tools"].as_array() {
        let mut list = vec![];
        for tool in tools {
            if tool["type"] != "function" {
                return Err("仅支持 function 工具，未删除原工具".into());
            }
            let mut f = tool["function"].clone();
            f["type"] = json!("function");
            list.push(f);
        }
        out["tools"] = json!(list);
    }
    if body["tool_choice"].is_object() {
        out["tool_choice"] =
            json!({"type":"function","name":body["tool_choice"]["function"]["name"]});
    }
    if let Some(n) = body
        .get("max_completion_tokens")
        .or_else(|| body.get("max_tokens"))
    {
        out["max_output_tokens"] = n.clone();
    }
    if let Some(e) = body.get("reasoning_effort") {
        out["reasoning"] = json!({"effort":e});
    }
    for key in [
        "max_tokens",
        "max_completion_tokens",
        "reasoning_effort",
        "n",
    ] {
        out.as_object_mut().unwrap().remove(key);
    }
    if let Some(options) = body.get("stream_options") {
        if options
            .as_object()
            .is_none_or(|o| o.keys().any(|key| key != "include_usage"))
        {
            return Err("此流式选项尚不能跨协议转换，未删除原参数".into());
        }
        out.as_object_mut().unwrap().remove("stream_options");
    }
    Ok(out)
}
fn gemini_schema(value: &Value) -> Value {
    match value {
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, v)| {
                    (
                        key.clone(),
                        if key == "type" {
                            v.as_str()
                                .map(|t| json!(t.to_ascii_lowercase()))
                                .unwrap_or_else(|| v.clone())
                        } else {
                            gemini_schema(v)
                        },
                    )
                })
                .collect(),
        ),
        Value::Array(items) => json!(items.iter().map(gemini_schema).collect::<Vec<_>>()),
        _ => value.clone(),
    }
}
pub(super) fn first_prompt(body: &Value) -> String {
    let message = body["messages"]
        .as_array()
        .and_then(|ms| ms.iter().find(|m| m["role"] == "user"));
    if let Some(m) = message {
        if let Some(text) = m["content"].as_str() {
            return text.into();
        }
        return m["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
    }
    body["contents"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|m| m["role"] == "user")
        .into_iter()
        .flat_map(|m| m["parts"].as_array().into_iter().flatten())
        .filter_map(|p| p["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}
fn gemini_input(body: &Value, model: &str, stream: bool) -> Result<Value> {
    let mut messages = vec![];
    let mut pending = std::collections::BTreeMap::<String, Vec<String>>::new();
    let mut seq = 0;
    if let Some(parts) = body["systemInstruction"]["parts"].as_array() {
        let mut text_parts = vec![];
        for p in parts {
            if let Some(t) = p["text"].as_str() {
                text_parts.push(t);
            } else {
                return Err("不支持的 Gemini 系统内容".into());
            }
        }
        messages.push(json!({"role":"system","content":text_parts.join("\n")}));
    }
    for entry in body["contents"].as_array().ok_or("contents 必须是数组")? {
        let mut parts = vec![];
        let mut calls = vec![];
        let mut results = vec![];
        for part in entry["parts"].as_array().ok_or("无效 Gemini parts")? {
            if let Some(t) = part["text"].as_str() {
                parts.push(json!({"type":"text","text":t}));
            } else if part["inlineData"].is_object() {
                let p = &part["inlineData"];
                if !text(p, "mimeType").starts_with("image/") {
                    return Err("暂不支持此 Gemini 媒体类型，未删除原输入".into());
                }
                parts.push(json!({"type":"image_url","image_url":{"url":format!("data:{};base64,{}",text(p,"mimeType"),text(p,"data"))}}));
            } else if part["functionCall"].is_object() {
                seq += 1;
                let p = &part["functionCall"];
                let id = p["id"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or(format!("gemini-call-{seq}"));
                pending
                    .entry(text(p, "name").into())
                    .or_default()
                    .push(id.clone());
                calls.push(json!({"id":id,"type":"function","function":{"name":p["name"],"arguments":p["args"].to_string()}}));
            } else if part["functionResponse"].is_object() {
                let p = &part["functionResponse"];
                let ids = pending
                    .get_mut(text(p, "name"))
                    .ok_or("Gemini 工具结果缺少对应调用")?;
                let id = if let Some(id) = p["id"].as_str() {
                    let index = ids
                        .iter()
                        .position(|known| known == id)
                        .ok_or("Gemini 工具结果与调用不匹配")?;
                    ids.remove(index)
                } else {
                    if ids.is_empty() {
                        return Err("Gemini 工具结果缺少对应调用".into());
                    }
                    ids.remove(0)
                };
                results.push(
                    json!({"role":"tool","tool_call_id":id,"content":p["response"].to_string()}),
                );
            } else {
                return Err("不支持此 Gemini 内容或签名，未删除原输入".into());
            }
            if part.get("thoughtSignature").is_some() {
                return Err("跨协议不能携带 Gemini thoughtSignature，原上下文已保留".into());
            }
        }
        if !parts.is_empty() || !calls.is_empty() {
            let mut m =
                json!({"role":if entry["role"]=="model"{"assistant"}else{"user"},"content":parts});
            if !calls.is_empty() {
                m["tool_calls"] = json!(calls);
            }
            messages.push(m);
        }
        messages.extend(results);
    }
    let mut chat = json!({"model":model,"messages":messages,"stream":stream});
    let c = &body["generationConfig"];
    for (a, b) in [
        ("temperature", "temperature"),
        ("topP", "top_p"),
        ("maxOutputTokens", "max_tokens"),
        ("stopSequences", "stop"),
        ("candidateCount", "n"),
    ] {
        if let Some(v) = c.get(a) {
            chat[b] = v.clone();
        }
    }
    let mut tools = vec![];
    for group in body["tools"].as_array().into_iter().flatten() {
        let declarations = group["functionDeclarations"]
            .as_array()
            .ok_or("暂不支持 Gemini 内置工具，未删除原工具")?;
        for f in declarations {
            tools.push(json!({"type":"function","function":{"name":f["name"],"description":f["description"],"parameters":gemini_schema(&f.get("parameters").or_else(||f.get("parametersJsonSchema")).cloned().unwrap_or(json!({"type":"object","properties":{}})))}}));
        }
    }
    if !tools.is_empty() {
        chat["tools"] = json!(tools);
    }
    if let Some(mode) = body["toolConfig"]["functionCallingConfig"]["mode"].as_str() {
        chat["tool_choice"] = json!(match mode {
            "NONE" => "none",
            "ANY" => "required",
            "AUTO" => "auto",
            _ => return Err("不支持的 Gemini 工具策略".into()),
        });
    }
    if let Some(level) = c["thinkingConfig"]["thinkingLevel"].as_str() {
        chat["reasoning_effort"] = json!(level.to_ascii_lowercase());
    }
    if c["thinkingConfig"]["thinkingBudget"]
        .as_i64()
        .is_some_and(|n| n >= 0)
        || c.get("responseSchema").is_some()
        || c.get("responseMimeType").is_some()
    {
        return Err("此 Gemini 高级参数尚未支持跨协议转换，未删除原参数".into());
    }
    chat_input(&chat)
}
pub(super) fn response_json(value: &Value, api: &str) -> Value {
    let u = &value["usage"];
    if api == "gemini" {
        let mut parts = vec![];
        for item in value["output"].as_array().into_iter().flatten() {
            match text(item,"type"){
            "message"=>for p in item["content"].as_array().into_iter().flatten(){if p["type"]=="output_text"{parts.push(json!({"text":p["text"]}));}},
            "reasoning"=>for p in item["summary"].as_array().into_iter().flatten(){parts.push(json!({"text":p["text"],"thought":true}));},
            "function_call"=>parts.push(json!({"functionCall":{"id":item["call_id"],"name":item["name"],"args":serde_json::from_str::<Value>(text(item,"arguments")).unwrap_or(Value::Null)}})),_=>{}
        }
        }
        return json!({"responseId":value["id"],"modelVersion":value["model"],"candidates":[{"index":0,"content":{"role":"model","parts":parts},"finishReason":if value["status"]=="incomplete"{"MAX_TOKENS"}else{"STOP"}}],"usageMetadata":if u.is_object(){json!({"promptTokenCount":u["input_tokens"],"candidatesTokenCount":u["output_tokens"],"totalTokenCount":u["total_tokens"],"cachedContentTokenCount":u["input_tokens_details"]["cached_tokens"]})}else{Value::Null}});
    }
    let mut content = String::new();
    let mut thought = String::new();
    let mut calls = vec![];
    for item in value["output"].as_array().into_iter().flatten() {
        match text(item,"type"){
        "message"=>for p in item["content"].as_array().into_iter().flatten(){if p["type"]=="output_text"{content.push_str(text(p,"text"));}},
        "reasoning"=>for p in item["summary"].as_array().into_iter().flatten(){thought.push_str(text(p,"text"));},
        "function_call"=>calls.push(json!({"id":item["call_id"],"type":"function","function":{"name":item["name"],"arguments":item["arguments"]}})),_=>{}
    }
    }
    let mut message = json!({"role":"assistant","content":if content.is_empty()&&!calls.is_empty(){Value::Null}else{json!(content)}});
    if !calls.is_empty() {
        message["tool_calls"] = json!(calls);
    }
    if !thought.is_empty() {
        message["reasoning_content"] = json!(thought);
    }
    json!({"id":value["id"],"object":"chat.completion","created":millis() as u64/1000,"model":value["model"],"choices":[{"index":0,"message":message,"finish_reason":if !calls.is_empty(){"tool_calls"}else if value["status"]=="incomplete"{"length"}else{"stop"}}],"usage":if u.is_object(){json!({"prompt_tokens":u["input_tokens"],"completion_tokens":u["output_tokens"],"total_tokens":u["total_tokens"],"prompt_tokens_details":u["input_tokens_details"],"completion_tokens_details":u["output_tokens_details"]})}else{Value::Null}})
}
fn stream_frame(value: Value) -> axum::body::Bytes {
    format!("data: {value}\n\n").into()
}
async fn output(mut response: Response, api: String, streaming: bool) -> Response {
    if response.headers_mut().remove("x-xwx-native-chat").is_some() {
        return response;
    }
    if !response.status().is_success() {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    parts.headers.remove("content-length");
    if !streaming {
        return match to_bytes(body, 32 * 1024 * 1024)
            .await
            .and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| axum::Error::new(e)))
        {
            Ok(value) => {
                parts
                    .headers
                    .insert("content-type", "application/json".parse().unwrap());
                Response::from_parts(parts, Body::from(response_json(&value, &api).to_string()))
            }
            Err(_) => protocol_error(502, "responses", "上游响应无法转换"),
        };
    }
    parts
        .headers
        .insert("content-type", "text/event-stream".parse().unwrap());
    let stream = async_stream::stream! {
        let mut upstream=body.into_data_stream();let mut pending=Vec::new();let mut done=false;let mut tools=std::collections::BTreeMap::<String,usize>::new();let mut response_id=String::from("xwx-stream");let mut model=Value::Null;let created=millis() as u64/1000;let mut sent_text=String::new();let mut sent_thought=String::new();let mut sent_tools=std::collections::BTreeSet::<String>::new();
        while let Some(chunk)=upstream.next().await{
            let bytes=match chunk{Ok(b)=>b,Err(e)=>{yield Err::<axum::body::Bytes,_>(std::io::Error::other(e.to_string()));return;}};
            pending.extend_from_slice(&bytes);if pending.len()>32*1024*1024{yield Err(std::io::Error::other("响应帧超过上限"));return;}
            while let Some((end,len))=pending.windows(2).position(|w|w==b"\n\n").map(|p|(p,2)).or_else(||pending.windows(4).position(|w|w==b"\r\n\r\n").map(|p|(p,4))){
                let block=pending.drain(..end+len).collect::<Vec<_>>();let raw=String::from_utf8_lossy(&block);let data=raw.lines().filter_map(|l|l.strip_prefix("data:").map(str::trim)).collect::<Vec<_>>().join("\n");
                let Ok(v)=serde_json::from_str::<Value>(&data)else{continue;};let kind=text(&v,"type");
                if let Some(id)=v["response"]["id"].as_str().or_else(||v["response_id"].as_str()){response_id=id.into();}if let Some(m)=v["response"]["model"].as_str(){model=json!(m);}
                if kind=="error"||kind=="response.failed"||v.get("error").is_some(){yield Ok(stream_frame(json!({"error":v})));return;}
                if kind=="response.completed"||kind=="response.incomplete"{
                    let chat_final=response_json(&v["response"],"chat-completions");
                    for (field,sent) in [("content",&sent_text),("reasoning_content",&sent_thought)] {
                        let full=chat_final["choices"][0]["message"][field].as_str().unwrap_or("");
                        if !full.starts_with(sent){yield Ok(stream_frame(json!({"error":{"message":"上游最终内容与流不一致，未覆盖已显示内容"}})));return;}
                        if full.len()>sent.len(){let tail=&full[sent.len()..];if api=="gemini"{let part=if field=="content"{json!({"text":tail})}else{json!({"text":tail,"thought":true})};yield Ok(stream_frame(json!({"candidates":[{"index":0,"content":{"role":"model","parts":[part]}}]})));}else{yield Ok(stream_frame(json!({"id":response_id,"object":"chat.completion.chunk","created":created,"model":model,"choices":[{"index":0,"delta":{field:tail},"finish_reason":null}]})));}}
                    }
                    for call in chat_final["choices"][0]["message"]["tool_calls"].as_array().into_iter().flatten(){if sent_tools.insert(text(call,"id").into()){if api=="gemini"{yield Ok(stream_frame(json!({"candidates":[{"index":0,"content":{"role":"model","parts":[{"functionCall":{"id":call["id"],"name":call["function"]["name"],"args":serde_json::from_str::<Value>(text(&call["function"],"arguments")).unwrap_or(Value::Null)}}]}}]})));}else{let mut tool=call.clone();tool["index"]=json!(tools.len());yield Ok(stream_frame(json!({"id":response_id,"object":"chat.completion.chunk","created":created,"model":model,"choices":[{"index":0,"delta":{"tool_calls":[tool]},"finish_reason":null}]})));}}}
                    let final_value=response_json(&v["response"],&api);
                    if api=="gemini"{let mut tail=final_value;tail["candidates"][0]["content"]["parts"]=json!([]);yield Ok(stream_frame(tail));}
                    else{yield Ok(stream_frame(json!({"id":v["response"]["id"],"object":"chat.completion.chunk","model":v["response"]["model"],"choices":[{"index":0,"delta":{},"finish_reason":final_value["choices"][0]["finish_reason"]}]})));yield Ok(stream_frame(json!({"id":v["response"]["id"],"object":"chat.completion.chunk","model":v["response"]["model"],"choices":[],"usage":final_value["usage"]})));yield Ok(axum::body::Bytes::from_static(b"data: [DONE]\n\n"));}
                    done=true;continue;
                }
                if kind=="response.output_text.delta"{sent_text.push_str(text(&v,"delta"));}if kind=="response.reasoning_summary_text.delta"{sent_thought.push_str(text(&v,"delta"));}
                if api=="gemini"{
                    let part=if kind=="response.output_text.delta"{Some(json!({"text":v["delta"]}))}else if kind=="response.reasoning_summary_text.delta"{Some(json!({"text":v["delta"],"thought":true}))}else if kind=="response.output_item.done"&&v["item"]["type"]=="function_call"{let item=&v["item"];sent_tools.insert(text(item,"call_id").into());Some(json!({"functionCall":{"id":item["call_id"],"name":item["name"],"args":serde_json::from_str::<Value>(text(item,"arguments")).unwrap_or(Value::Null)}}))}else{None};
                    if let Some(part)=part{yield Ok(stream_frame(json!({"candidates":[{"index":0,"content":{"role":"model","parts":[part]}}]})));}
                }else{
                    let delta=if kind=="response.output_text.delta"{Some(json!({"content":v["delta"]}))}else if kind=="response.reasoning_summary_text.delta"{Some(json!({"reasoning_content":v["delta"]}))}else if kind=="response.output_item.added"&&v["item"]["type"]=="function_call"{let item=&v["item"];let index=tools.len();tools.insert(text(item,"id").into(),index);sent_tools.insert(text(item,"call_id").into());Some(json!({"tool_calls":[{"index":index,"id":item["call_id"],"type":"function","function":{"name":item["name"],"arguments":""}}]}))}else if kind=="response.function_call_arguments.delta"{tools.get(text(&v,"item_id")).map(|i|json!({"tool_calls":[{"index":i,"function":{"arguments":v["delta"]}}]}))}else{None};
                    if let Some(delta)=delta{yield Ok(stream_frame(json!({"id":response_id,"object":"chat.completion.chunk","created":created,"model":model,"choices":[{"index":0,"delta":delta,"finish_reason":null}]})));}
                }
            }
        }
        if !done{yield Ok(stream_frame(json!({"error":{"message":"响应流未完成，请保留当前上下文后重试"}})));}
    };
    Response::from_parts(parts, Body::from_stream(stream))
}
pub(super) async fn forward(
    State(routes): State<Arc<std::sync::RwLock<Route>>>,
    request: Request,
) -> Response {
    let path = request.uri().path().to_string();
    let (client, relative) = if let Some(p) = path.strip_prefix("/clients/") {
        let Some((id, p)) = p.split_once('/') else {
            return protocol_error(404, "responses", "无效客户端入口");
        };
        if !valid_client(id) {
            return protocol_error(404, "responses", "无效客户端身份");
        }
        (Some(id.to_string()), format!("/{p}"))
    } else {
        (None, path.clone())
    };
    let gemini_models = relative == "/v1beta/models";
    let token_count =
        relative.ends_with("/messages/count_tokens") || relative.ends_with(":countTokens");
    let chat = relative.ends_with("/chat/completions");
    let gemini = relative.contains("/models/")
        && (relative.ends_with(":generateContent") || relative.ends_with(":streamGenerateContent"));
    if client.is_none() && !chat && !gemini && !gemini_models && !token_count {
        return super::forward_request(State(routes), request).await;
    }
    let mut route = match routes.read() {
        Ok(r) => r.clone(),
        Err(_) => return protocol_error(503, "responses", "路由暂不可用"),
    };
    let scoped = client.is_some();
    let id = client.unwrap_or("api-client".into());
    if scoped {
        let Some(provider) = route.clients.get(&id).cloned() else {
            return protocol_error(404, "responses", "请先为客户端选择模型服务");
        };
        route.provider = Some(provider.clone());
        route.claude = Some(provider);
    }
    let (mut parts, body) = request.into_parts();
    let body = match to_bytes(body, 16 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return protocol_error(413, "responses", "请求过大"),
    };
    if token_count {
        if relative.ends_with(":countTokens") {
            return protocol_error(
                501,
                "responses",
                "当前上游未提供 Gemini 原生计数，不返回估算值",
            );
        }
        let provider = route.claude.as_ref().or(route.provider.as_ref());
        let Some(provider) = provider else {
            return protocol_error(503, "anthropic-messages", "模型服务未配置");
        };
        if resolve_wire(&route.root, provider, None, "anthropic-messages") != "anthropic-messages"
            || !provider.subscription_account_id.is_empty()
        {
            return protocol_error(
                501,
                "anthropic-messages",
                "当前上游没有可用的原生 Token 计数接口",
            );
        }
        let base = Pilot::api_root(&provider.base_url);
        let endpoint = if base
            .rsplit('/')
            .next()
            .is_some_and(|s| s.starts_with('v') && s[1..].chars().all(|c| c.is_ascii_digit()))
        {
            format!("{base}/messages/count_tokens")
        } else {
            format!("{base}/v1/messages/count_tokens")
        };
        let mut upstream = route
            .client
            .post(endpoint)
            .header("content-type", "application/json")
            .header("anthropic-version", "2023-06-01")
            .body(body);
        if !provider.bearer_token.is_empty() {
            upstream = upstream.header("x-api-key", &provider.bearer_token);
        }
        return match upstream.send().await {
            Ok(response) => {
                let mut out = Response::builder().status(response.status());
                out = out.header("content-type", "application/json");
                out.body(Body::from_stream(response.bytes_stream()))
                    .unwrap()
            }
            Err(_) => protocol_error(502, "anthropic-messages", "上游计数失败"),
        };
    }
    let original = if body.is_empty() {
        Value::Null
    } else {
        match serde_json::from_slice::<Value>(&body) {
            Ok(v) => v,
            Err(_) => return protocol_error(400, "responses", "无效请求 JSON"),
        }
    };
    let api = if chat {
        "chat-completions"
    } else if gemini {
        "gemini"
    } else if relative.ends_with("/messages") {
        "anthropic-messages"
    } else {
        "responses"
    };
    let streaming = if gemini {
        relative.ends_with(":streamGenerateContent")
    } else {
        original["stream"] == true
    };
    let model = relative
        .split("/models/")
        .nth(1)
        .and_then(|s| s.split(':').next())
        .unwrap_or("");
    let native_chat = chat
        && route.provider.as_ref().is_some_and(|p| {
            resolve_wire(&route.root, p, original["model"].as_str(), "responses")
                == "chat-completions"
        });
    let normalized = if native_chat {
        Ok(original.clone())
    } else if chat {
        chat_input(&original)
    } else if gemini {
        gemini_input(&original, model, streaming)
    } else {
        Ok(original.clone())
    };
    let normalized = match normalized {
        Ok(v) => v,
        Err(e) => return protocol_error(400, "responses", &e),
    };
    parts.extensions.insert(Origin {
        client: id,
        path: path.clone(),
        protocol: api.into(),
        body: original,
    });
    let route_path = if gemini_models {
        "/v1/models"
    } else if chat || gemini {
        "/v1/responses"
    } else {
        &relative
    };
    let query = parts
        .uri
        .query()
        .map(|q| {
            q.split('&')
                .filter(|p| !matches!(p.split('=').next().unwrap_or(""), "key" | "alt"))
                .collect::<Vec<_>>()
                .join("&")
        })
        .unwrap_or_default();
    parts.uri = match format!(
        "{route_path}{}",
        if query.is_empty() {
            String::new()
        } else {
            format!("?{query}")
        }
    )
    .parse()
    {
        Ok(u) => u,
        Err(_) => return protocol_error(400, "responses", "无效请求路径"),
    };
    let body = if normalized.is_null() {
        Vec::new()
    } else {
        normalized.to_string().into_bytes()
    };
    let response = super::forward_request(
        State(Arc::new(std::sync::RwLock::new(route))),
        Request::from_parts(parts, Body::from(body)),
    )
    .await;
    if gemini_models && response.status().is_success() {
        let bytes = match to_bytes(response.into_body(), 4 * 1024 * 1024).await {
            Ok(b) => b,
            Err(_) => return protocol_error(502, "responses", "模型目录无法读取"),
        };
        let value = match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) => v,
            Err(_) => return protocol_error(502, "responses", "模型目录无法解析"),
        };
        let models:Vec<_>=value["data"].as_array().into_iter().flatten().map(|m|json!({"name":format!("models/{}",text(m,"id")),"displayName":text(m,"id"),"supportedGenerationMethods":["generateContent","streamGenerateContent"]})).collect();
        Response::builder()
            .header("content-type", "application/json")
            .body(Body::from(json!({"models":models}).to_string()))
            .unwrap()
    } else if chat || gemini {
        output(response, api.into(), streaming).await
    } else {
        response
    }
}
