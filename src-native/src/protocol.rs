use super::*;
use std::collections::BTreeMap;

fn items(v: &Value) -> Vec<Value> {
    match v {
        Value::Array(a) => a.clone(),
        Value::String(s) => vec![json!({"role":"user","content":s})],
        Value::Object(_) => vec![v.clone()],
        _ => vec![],
    }
}
fn string(v: &Value) -> String {
    v.as_str()
        .map(str::to_string)
        .unwrap_or_else(|| v.to_string())
}
fn parts_text(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        s.into()
    } else {
        items(v)
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }
}
fn frame(event: &str, value: Value) -> String {
    format!("event: {event}\ndata: {value}\n\n")
}

#[derive(Default, Clone)]
pub(super) struct ToolContext {
    specs: BTreeMap<String, Value>,
    tools: Vec<Value>,
}
impl ToolContext {
    pub(super) fn spec(&self, name: &str) -> Option<&Value> {
        self.specs.get(name)
    }
    fn name(&self, name: &str, namespace: &str) -> String {
        self.specs
            .iter()
            .find(|(_, v)| v["name"] == name && v["namespace"].as_str().unwrap_or("") == namespace)
            .map(|(k, _)| k.clone())
            .unwrap_or_else(|| name.into())
    }
    fn add(&mut self, tool: &Value, namespace: &str) -> Result<()> {
        let name = text(tool, "name");
        match text(tool, "type") {
            "namespace" => {
                for t in items(&tool["tools"]) {
                    self.add(&t, name)?;
                }
                return Ok(());
            }
            "function" | "custom" | "tool_search" => {}
            _ => {
                return Err(format!(
                    "Chat 协议不支持该内置工具类型：{}",
                    text(tool, "type")
                ))
            }
        }
        let original = if name.is_empty() && tool["type"] == "tool_search" {
            "tool_search"
        } else {
            name
        };
        if original.is_empty() {
            return Err("工具缺少名称".into());
        }
        let joined = if namespace.is_empty() {
            original.to_string()
        } else {
            format!("{namespace}__{original}")
        };
        let flat = if joined.len() > 64 {
            let hash = joined.bytes().fold(0xcbf29ce484222325u64, |h, b| {
                (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
            });
            let prefix: String = joined.chars().take(46).collect();
            format!("{prefix}_{hash:016x}")
        } else {
            joined
        };
        if self.specs.contains_key(&flat) {
            return Ok(());
        }
        let mut function = json!({"name":flat,"description":text(tool,"description"),"parameters":tool.get("parameters").cloned().unwrap_or_else(||json!({"type":"object","properties":{}}))});
        if tool["type"] == "custom" {
            function["description"] = json!(format!(
                "{}\nOriginal tool definition: {}",
                text(tool, "description"),
                tool
            ));
            function["parameters"] = json!({"type":"object","properties":{"input":{"type":"string"}},"required":["input"]});
        }
        if tool["type"] == "tool_search" {
            function["parameters"] = json!({"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer"}},"required":["query"]});
        }
        if let Some(strict) = tool.get("strict") {
            function["strict"] = strict.clone();
        }
        self.specs.insert(
            flat.clone(),
            json!({"type":tool["type"],"name":original,"namespace":namespace}),
        );
        self.tools
            .push(json!({"type":"function","function":function}));
        Ok(())
    }
    fn from_body(body: &Value) -> Result<Self> {
        let mut c = Self::default();
        for tool in items(&body["tools"]) {
            c.add(&tool, "")?;
        }
        for item in items(&body["input"]) {
            if item["type"] == "additional_tools" {
                for tool in items(&item["tools"]) {
                    c.add(&tool, "")?;
                }
            }
        }
        Ok(c)
    }
}

// Grok's CLI backend uses Responses with flat function tools. Reuse the same
// reversible mapping as Chat conversion so Codex custom/namespace tools survive.
pub(super) fn grok_request(body: &mut Value) -> Result<ToolContext> {
    let mut context = ToolContext::default();
    let mut builtins = vec![];
    for tool in items(&body["tools"]) {
        match text(&tool, "type") {
            "function" | "custom" | "namespace" => context.add(&tool, "")?,
            "web_search" | "x_search" | "image_generation" | "collections_search"
            | "file_search" | "code_execution" | "code_interpreter" | "mcp" | "shell"
            | "tool_search" => builtins.push(tool),
            other => return Err(format!("Grok 订阅暂不支持该工具类型：{other}")),
        }
    }
    for item in items(&body["input"]) {
        if item["type"] == "additional_tools" {
            for tool in items(&item["tools"]) {
                context.add(&tool, "")?;
            }
        }
    }
    if !body["tools"].is_null() || !context.tools.is_empty() {
        let mut tools: Vec<_> = context
            .tools
            .iter()
            .map(|t| {
                let mut f = t["function"].clone();
                f["type"] = json!("function");
                f
            })
            .collect();
        tools.extend(builtins);
        body["tools"] = json!(tools);
    }
    if let Some(input) = body["input"].as_array_mut() {
        input.retain(|item| item["type"] != "additional_tools");
        for item in input {
            if item["type"] == "function_call" || item["type"] == "custom_tool_call" {
                let name = context.name(text(item, "name"), text(item, "namespace"));
                if item["type"] == "custom_tool_call" {
                    item["arguments"] = json!(json!({"input":item["input"]}).to_string());
                    item["type"] = json!("function_call");
                    item.as_object_mut().unwrap().remove("input");
                }
                item["name"] = json!(name);
                item.as_object_mut().unwrap().remove("namespace");
            } else if item["type"] == "custom_tool_call_output" {
                item["type"] = json!("function_call_output");
            }
            if item["type"] == "reasoning" && item["content"].is_null() {
                item.as_object_mut().unwrap().remove("content");
            }
        }
    }
    if body["tool_choice"].is_object()
        && ["function", "custom"].contains(&text(&body["tool_choice"], "type"))
    {
        let choice = &body["tool_choice"];
        body["tool_choice"] = json!({"type":"function","name":context.name(text(choice,"name"),text(choice,"namespace"))});
    }
    Ok(context)
}
pub(super) fn grok_response(value: &mut Value, context: &ToolContext) {
    if let Some(output) = value["output"].as_array_mut() {
        for item in output {
            if item["type"] != "function_call" {
                continue;
            }
            if let Some(spec) = context.specs.get(text(item, "name")) {
                item["name"] = spec["name"].clone();
                if let Some(namespace) = spec["namespace"].as_str().filter(|s| !s.is_empty()) {
                    item["namespace"] = json!(namespace);
                }
                if spec["type"] == "custom" {
                    let arguments = serde_json::from_str::<Value>(text(item, "arguments")).ok();
                    item["type"] = json!("custom_tool_call");
                    item["input"] = arguments
                        .as_ref()
                        .and_then(|a| a.get("input"))
                        .cloned()
                        .unwrap_or_else(|| item["arguments"].clone());
                    item.as_object_mut().unwrap().remove("arguments");
                }
            }
        }
    }
}

pub(super) fn responses_chat(body: &Value) -> Result<(Value, ToolContext)> {
    let context = ToolContext::from_body(body)?;
    let mut messages = vec![];
    let mut systems = vec![];
    let instructions = parts_text(&body["instructions"]);
    if !instructions.is_empty() {
        systems.push(instructions);
    }
    let mut pending = vec![];
    let mut thought = String::new();
    for item in items(&body["input"]) {
        match text(&item, "type") {
            "additional_tools" => continue,
            "function_call" | "custom_tool_call" => {
                let name = context.name(text(&item, "name"), text(&item, "namespace"));
                let arguments = if item["type"] == "custom_tool_call" {
                    json!({"input":item["input"]}).to_string()
                } else {
                    string(&item["arguments"])
                };
                pending.push(json!({"id":item["call_id"],"type":"function","function":{"name":name,"arguments":arguments}}));
                continue;
            }
            "reasoning" => {
                let visible = parts_text(&item["content"]);
                thought.push_str(if visible.is_empty() { "" } else { &visible });
                if visible.is_empty() {
                    thought.push_str(&parts_text(&item["summary"]));
                }
                continue;
            }
            _ => {}
        }
        if !pending.is_empty() {
            let mut message = json!({"role":"assistant","content":null,"tool_calls":std::mem::take(&mut pending)});
            if !thought.is_empty() {
                message["reasoning_content"] = json!(std::mem::take(&mut thought));
            }
            messages.push(message);
        }
        match text(&item, "type") {
            "function_call_output" | "custom_tool_call_output" => {
                if item["output"].is_array() {
                    let mut text_parts = vec![];
                    let mut images = vec![];
                    for part in items(&item["output"]) {
                        match text(&part, "type") {
                            "input_text" | "output_text" | "text" => {
                                text_parts.push(text(&part, "text").to_string())
                            }
                            "input_image" => images.push(
                                json!({"type":"image_url","image_url":{"url":part["image_url"]}}),
                            ),
                            _ => {
                                return Err(
                                    "工具结果包含当前协议无法转换的内容，原输入已保留".into()
                                )
                            }
                        }
                    }
                    messages.push(json!({"role":"tool","tool_call_id":item["call_id"],"content":text_parts.join("\n")}));
                    if !images.is_empty() {
                        messages.push(json!({"role":"user","content":images}));
                    }
                } else {
                    messages.push(json!({"role":"tool","tool_call_id":item["call_id"],"content":string(&item["output"])}));
                }
            }
            "compaction" => {
                use base64::Engine;
                let encoded = text(&item, "encrypted_content");
                let summary = encoded
                    .strip_prefix("xwxc1:")
                    .and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok())
                    .and_then(|b| String::from_utf8(b).ok())
                    .filter(|s| !s.trim().is_empty())
                    .ok_or("当前上游无法解密其他 Provider 的 compaction，请恢复完整上下文后继续")?;
                messages.push(json!({"role":"user","content":format!("Continue from this context checkpoint without repeating completed work:\n{summary}")}));
            }
            _ => {
                let role = match text(&item, "role") {
                    "developer" | "system" => "system",
                    "assistant" => "assistant",
                    _ => "user",
                };
                if role == "system" {
                    systems.push(parts_text(&item["content"]));
                    continue;
                }
                let content = if item["content"].is_string() {
                    item["content"].clone()
                } else {
                    let mut content = vec![];
                    for p in items(&item["content"]) {
                        match text(&p,"type") {
                        "input_text"|"output_text"|"text"=>content.push(json!({"type":"text","text":p["text"]})),
                        "input_image"=>content.push(json!({"type":"image_url","image_url":{"url":p["image_url"],"detail":p.get("detail").cloned().unwrap_or(json!("auto"))}})),
                        "input_file"=>return Err("所选 Chat 协议尚未支持文件输入，未删除原输入".into()),
                        _=>return Err(format!("当前转换尚未支持 {} 内容，原输入已保留",text(&p,"type"))),
                    }
                    }
                    json!(content)
                };
                messages.push(json!({"role":role,"content":content}));
                if role == "assistant" && !thought.is_empty() {
                    messages.last_mut().unwrap()["reasoning_content"] =
                        json!(std::mem::take(&mut thought));
                }
            }
        }
    }
    if !pending.is_empty() {
        let mut message = json!({"role":"assistant","content":null,"tool_calls":pending});
        if !thought.is_empty() {
            message["reasoning_content"] = json!(thought);
        }
        messages.push(message);
    }
    if !systems.is_empty() {
        messages.insert(0, json!({"role":"system","content":systems.join("\n\n")}));
    }
    let mut out = json!({"model":body["model"],"messages":messages});
    if let Some(limit) = body.get("max_output_tokens") {
        out["max_tokens"] = limit.clone();
    }
    for key in [
        "temperature",
        "top_p",
        "stream",
        "max_tokens",
        "max_completion_tokens",
        "frequency_penalty",
        "logit_bias",
        "logprobs",
        "metadata",
        "n",
        "parallel_tool_calls",
        "presence_penalty",
        "response_format",
        "seed",
        "service_tier",
        "stop",
        "stream_options",
        "top_logprobs",
        "user",
    ] {
        if let Some(v) = body.get(key) {
            out[key] = v.clone();
        }
    }
    if let Some(effort) = body["reasoning"].get("effort") {
        out["reasoning_effort"] = effort.clone();
    }
    if !context.tools.is_empty() {
        out["tools"] = json!(context.tools);
        if let Some(choice) = body.get("tool_choice") {
            out["tool_choice"] = if choice.is_string() {
                choice.clone()
            } else {
                json!({"type":"function","function":{"name":context.name(text(choice,"name"),text(choice,"namespace"))}})
            };
        }
    } else {
        out.as_object_mut().unwrap().remove("parallel_tool_calls");
    }
    if out["stream"] == true {
        if !out["stream_options"].is_object() {
            out["stream_options"] = json!({});
        }
        out["stream_options"]["include_usage"] = json!(true);
    }
    Ok((out, context))
}

pub(super) fn messages_responses(body: &Value) -> Result<Value> {
    let mut input = vec![];
    for message in items(&body["messages"]) {
        let role = text(&message, "role");
        let mut content = vec![];
        if let Some(s) = message["content"].as_str() {
            input.push(json!({"type":"message","role":role,"content":[{"type":if role=="assistant"{"output_text"}else{"input_text"},"text":s}]}));
            continue;
        }
        for block in items(&message["content"]) {
            match text(&block,"type") {
                "text"=>content.push(json!({"type":if role=="assistant"{"output_text"}else{"input_text"},"text":block["text"]})),
                "image"=>{let source=&block["source"];let url=if source["type"]=="base64"{format!("data:{};base64,{}",text(source,"media_type"),text(source,"data"))}else{text(source,"url").into()};content.push(json!({"type":"input_image","image_url":url}));},
                "tool_use"=>{if !content.is_empty(){input.push(json!({"type":"message","role":role,"content":std::mem::take(&mut content)}));}input.push(json!({"type":"function_call","call_id":block["id"],"name":block["name"],"arguments":block["input"].to_string()}));},
                "tool_result"=>{
                    if !content.is_empty(){input.push(json!({"type":"message","role":role,"content":std::mem::take(&mut content)}));}
                    let output=if block["content"].is_string(){json!(if block["is_error"]==true{format!("Error: {}",text(&block,"content"))}else{string(&block["content"])})}else{
                        let mut output=vec![];
                        if block["is_error"]==true { output.push(json!({"type":"input_text","text":"Error:"})); }
                        for part in items(&block["content"]) {match text(&part,"type") {
                            "text"=>output.push(json!({"type":"input_text","text":part["text"]})),
                            "image"=>{let source=&part["source"];let url=if source["type"]=="base64"{format!("data:{};base64,{}",text(source,"media_type"),text(source,"data"))}else{text(source,"url").into()};output.push(json!({"type":"input_image","image_url":url}));},
                            _=>return Err("工具结果包含当前协议无法转换的内容，原输入已保留".into()),
                        }}json!(output)
                    };
                    input.push(json!({"type":"function_call_output","call_id":block["tool_use_id"],"output":output}));
                },
                "thinking"=>input.push(json!({"type":"reasoning","content":[{"type":"reasoning_text","text":block["thinking"]}],"summary":[]})),
                "redacted_thinking"=>{},
                _=>return Err(format!("当前转换尚未支持 Messages {} 内容，原请求已保留",text(&block,"type"))),
            }
        }
        if !content.is_empty() {
            input.push(json!({"type":"message","role":role,"content":content}));
        }
    }
    let mut out = json!({"model":body["model"],"input":input,"instructions":parts_text(&body["system"]),"max_output_tokens":body["max_tokens"],"stream":body["stream"]==true});
    let effort = if body["thinking"]["type"] == "disabled" {
        Some("none")
    } else if let Some(effort) = body["output_config"]["effort"].as_str() {
        Some(effort)
    } else if body["thinking"]["type"] == "adaptive" {
        Some("medium")
    } else if body["thinking"]["type"] == "enabled" {
        Some(
            match body["thinking"]["budget_tokens"].as_u64().unwrap_or(0) {
                0..=4096 => "low",
                4097..=16384 => "medium",
                _ => "high",
            },
        )
    } else {
        None
    };
    if let Some(effort) = effort {
        out["reasoning"] = json!({"effort":effort});
    }
    let tools:Vec<_>=items(&body["tools"]).iter().map(|t|json!({"type":"function","name":t["name"],"description":t["description"],"parameters":t["input_schema"]})).collect();
    if !tools.is_empty() {
        out["tools"] = json!(tools);
    }
    if let Some(choice) = body.get("tool_choice") {
        out["tool_choice"] = match text(choice, "type") {
            "any" => json!("required"),
            "tool" => json!({"type":"function","name":choice["name"]}),
            "none" => json!("none"),
            _ => json!("auto"),
        };
    }
    for key in ["temperature", "top_p"] {
        if let Some(v) = body.get(key) {
            out[key] = v.clone();
        }
    }
    if let Some(v) = body.get("stop_sequences") {
        out["stop"] = v.clone();
    }
    Ok(out)
}

pub(super) fn responses_messages(body: &Value) -> Result<(Value, ToolContext)> {
    let (chat, context) = responses_chat(body)?;
    let mut messages = vec![];
    let mut system = vec![];
    for message in items(&chat["messages"]) {
        let role = text(&message, "role");
        if role == "system" {
            system.push(parts_text(&message["content"]));
            continue;
        }
        let mut content = vec![];
        if role == "tool" {
            content.push(json!({"type":"tool_result","tool_use_id":message["tool_call_id"],"content":message["content"]}));
        } else {
            if let Some(s) = message["content"].as_str() {
                if !s.is_empty() {
                    content.push(json!({"type":"text","text":s}));
                }
            } else {
                for p in items(&message["content"]) {
                    if p["type"] == "text" {
                        content.push(p);
                    } else if p["type"] == "image_url" {
                        let url = text(&p["image_url"], "url");
                        let source = if url.starts_with("data:") {
                            let (kind, data) = url
                                .trim_start_matches("data:")
                                .split_once(";base64,")
                                .ok_or("无效图像格式")?;
                            json!({"type":"base64","media_type":kind,"data":data})
                        } else {
                            json!({"type":"url","url":url})
                        };
                        content.push(json!({"type":"image","source":source}));
                    }
                }
            }
            for call in items(&message["tool_calls"]) {
                let arguments = serde_json::from_str::<Value>(text(&call["function"], "arguments"))
                    .map_err(err)?;
                content.push(json!({"type":"tool_use","id":call["id"],"name":call["function"]["name"],"input":arguments}));
            }
        }
        if !content.is_empty() {
            let role = if role == "assistant" {
                "assistant"
            } else {
                "user"
            };
            if let Some(last) = messages
                .last_mut()
                .filter(|m: &&mut Value| m["role"] == role)
            {
                last["content"].as_array_mut().unwrap().extend(content);
            } else {
                messages.push(json!({"role":role,"content":content}));
            }
        }
    }
    if messages.first().is_some_and(|m| m["role"] != "user") {
        messages.insert(
            0,
            json!({"role":"user","content":[{"type":"text","text":"[Conversation resumed]"}]}),
        );
    }
    let mut out = json!({"model":body["model"],"messages":messages,"max_tokens":body["max_output_tokens"].as_u64().filter(|n|*n>0).unwrap_or(8192),"stream":body["stream"]==true});
    if !system.is_empty() {
        out["system"] = json!(system.join("\n\n"));
    }
    let tools:Vec<_>=context.tools.iter().map(|t|json!({"name":t["function"]["name"],"description":t["function"]["description"],"input_schema":t["function"]["parameters"]})).collect();
    if !tools.is_empty() {
        out["tools"] = json!(tools);
        if let Some(choice) = chat.get("tool_choice") {
            out["tool_choice"] = match choice.as_str() {
                Some("required") => json!({"type":"any"}),
                Some("none") => json!({"type":"none"}),
                Some(_) => json!({"type":"auto"}),
                _ => json!({"type":"tool","name":choice["function"]["name"]}),
            };
        }
    }
    for key in ["temperature", "top_p"] {
        if let Some(v) = body.get(key) {
            out[key] = v.clone();
        }
    }
    if let Some(stops) = body.get("stop") {
        out["stop_sequences"] = if stops.is_array() {
            stops.clone()
        } else {
            json!([stops])
        };
    }
    Ok((out, context))
}

pub(super) fn chat_response(value: &Value, context: &ToolContext) -> Value {
    let message = &value["choices"][0]["message"];
    let mut output = vec![];
    if let Some(reasoning) = message
        .get("reasoning_content")
        .or_else(|| message.get("reasoning"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        output.push(json!({"id":format!("rs_{}",millis()),"type":"reasoning","summary":[{"type":"summary_text","text":reasoning}]}));
    }
    if let Some(content) = message["content"].as_str().filter(|s| !s.is_empty()) {
        output.push(json!({"id":format!("msg_{}",millis()),"type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":content,"annotations":[]}]}));
    }
    for call in items(&message["tool_calls"]) {
        let wire_name = text(&call["function"], "name");
        let spec = context.specs.get(wire_name);
        let custom = spec.is_some_and(|s| s["type"] == "custom");
        let args = text(&call["function"], "arguments");
        let mut item = json!({"id":format!("fc_{}",text(&call,"id")),"type":if custom{"custom_tool_call"}else{"function_call"},"status":"completed","call_id":call["id"],"name":spec.map(|s|s["name"].clone()).unwrap_or(json!(wire_name))});
        if custom {
            let parsed = serde_json::from_str::<Value>(args).ok();
            item["input"] = parsed
                .as_ref()
                .and_then(|v| v.get("input"))
                .cloned()
                .unwrap_or(json!(args));
        } else {
            item["arguments"] = json!(args);
        }
        if let Some(namespace) = spec
            .and_then(|s| s["namespace"].as_str())
            .filter(|s| !s.is_empty())
        {
            item["namespace"] = json!(namespace);
        }
        output.push(item);
    }
    let raw = &value["usage"];
    let input = raw["prompt_tokens"].as_u64().unwrap_or(0);
    let out = raw["completion_tokens"].as_u64().unwrap_or(0);
    let usage = if raw.is_object() {
        json!({"input_tokens":input,"output_tokens":out,"total_tokens":raw["total_tokens"].as_u64().unwrap_or(input+out),"input_tokens_details":{"cached_tokens":raw["prompt_tokens_details"]["cached_tokens"].as_u64().unwrap_or(0)},"output_tokens_details":raw.get("completion_tokens_details").cloned().unwrap_or(json!({}))})
    } else {
        Value::Null
    };
    let incomplete = value["choices"][0]["finish_reason"] == "length";
    json!({"id":format!("resp_{}",text(value,"id")),"object":"response","created_at":(millis()/1000)as u64,"status":if incomplete{"incomplete"}else{"completed"},"model":value["model"],"output":output,"usage":usage,"error":null,"incomplete_details":if incomplete{json!({"reason":"max_output_tokens"})}else{Value::Null}})
}

pub(super) fn messages_response(value: &Value, context: &ToolContext) -> Value {
    let mut content = String::new();
    let mut calls = vec![];
    let mut reasoning = String::new();
    for part in items(&value["content"]) {
        if part["type"] == "text" {
            content.push_str(text(&part, "text"));
        } else if part["type"] == "thinking" {
            reasoning.push_str(text(&part, "thinking"));
        } else if part["type"] == "tool_use" {
            calls.push(json!({"id":part["id"],"type":"function","function":{"name":part["name"],"arguments":part["input"].to_string()}}));
        }
    }
    let u = &value["usage"];
    let uncached = u["input_tokens"].as_u64().unwrap_or(0);
    let read = u["cache_read_input_tokens"].as_u64().unwrap_or(0);
    let write = u["cache_creation_input_tokens"].as_u64().unwrap_or(0);
    let output = u["output_tokens"].as_u64().unwrap_or(0);
    let mut result = chat_response(
        &json!({"id":value["id"],"model":value["model"],"choices":[{"message":{"content":content,"reasoning_content":reasoning,"tool_calls":calls},"finish_reason":if value["stop_reason"]=="max_tokens"{"length"}else{"stop"}}],"usage":if u.is_object(){json!({"prompt_tokens":uncached+read+write,"completion_tokens":output,"prompt_tokens_details":{"cached_tokens":read},"total_tokens":uncached+read+write+output})}else{Value::Null}}),
        context,
    );
    if write > 0 {
        result["usage"]["input_tokens_details"]["cache_write_tokens"] = json!(write);
    }
    result
}

pub(super) fn responses_message(value: &Value) -> Value {
    let mut content = vec![];
    let mut tool = false;
    for item in items(&value["output"]) {
        match text(&item, "type") {
            "message" => {
                for p in items(&item["content"]) {
                    if p["type"] == "output_text" {
                        content.push(json!({"type":"text","text":p["text"]}));
                    }
                }
            }
            "function_call" | "custom_tool_call" => {
                tool = true;
                let input = if item["type"] == "custom_tool_call" {
                    json!({"input":item["input"]})
                } else {
                    serde_json::from_str(text(&item, "arguments")).unwrap_or(json!({}))
                };
                content.push(json!({"type":"tool_use","id":item["call_id"],"name":item["name"],"input":input}));
            }
            _ => {}
        }
    }
    let usage = &value["usage"];
    let input = usage["input_tokens"].as_u64().unwrap_or(0);
    let read = usage["input_tokens_details"]["cached_tokens"]
        .as_u64()
        .unwrap_or(0);
    let write = usage["input_tokens_details"]["cache_write_tokens"]
        .as_u64()
        .unwrap_or(0);
    json!({"id":format!("msg_{}",text(value,"id")),"type":"message","role":"assistant","model":value["model"],"content":content,"stop_reason":if tool{"tool_use"}else if value["status"]=="incomplete"{"max_tokens"}else{"end_turn"},"stop_sequence":null,"usage":if usage.is_object(){json!({"input_tokens":input.saturating_sub(read+write),"output_tokens":usage["output_tokens"],"cache_read_input_tokens":read,"cache_creation_input_tokens":write})}else{Value::Null}})
}

pub(super) fn response_sse(value: &Value) -> String {
    let mut output = String::new();
    let mut seq = 0;
    let mut emit = |event: &str, mut body: Value| {
        body["type"] = json!(event);
        body["sequence_number"] = json!(seq);
        seq += 1;
        output.push_str(&frame(event, body));
    };
    let mut initial = value.clone();
    initial["status"] = json!("in_progress");
    initial["output"] = json!([]);
    emit("response.created", json!({"response":initial}));
    emit("response.in_progress", json!({"response":initial}));
    for (index, item) in items(&value["output"]).iter().enumerate() {
        let mut start = item.clone();
        start["status"] = json!("in_progress");
        emit(
            "response.output_item.added",
            json!({"output_index":index,"item":start}),
        );
        if item["type"] == "message" {
            for (part_index, part) in items(&item["content"]).iter().enumerate() {
                emit(
                    "response.content_part.added",
                    json!({"item_id":item["id"],"output_index":index,"content_index":part_index,"part":{"type":"output_text","text":"","annotations":[]}}),
                );
                emit(
                    "response.output_text.delta",
                    json!({"item_id":item["id"],"output_index":index,"content_index":part_index,"delta":part["text"]}),
                );
                emit(
                    "response.output_text.done",
                    json!({"item_id":item["id"],"output_index":index,"content_index":part_index,"text":part["text"]}),
                );
                emit(
                    "response.content_part.done",
                    json!({"item_id":item["id"],"output_index":index,"content_index":part_index,"part":part}),
                );
            }
        } else if item["type"] == "function_call" {
            emit(
                "response.function_call_arguments.delta",
                json!({"item_id":item["id"],"output_index":index,"delta":item["arguments"]}),
            );
            emit(
                "response.function_call_arguments.done",
                json!({"item_id":item["id"],"output_index":index,"arguments":item["arguments"]}),
            );
        }
        emit(
            "response.output_item.done",
            json!({"output_index":index,"item":item}),
        );
    }
    emit(
        if value["status"] == "incomplete" {
            "response.incomplete"
        } else {
            "response.completed"
        },
        json!({"response":value}),
    );
    output
}

pub(super) fn message_sse(value: &Value) -> String {
    let mut start = value.clone();
    start["content"] = json!([]);
    start["stop_reason"] = Value::Null;
    let mut out = frame(
        "message_start",
        json!({"type":"message_start","message":start}),
    );
    for (index, block) in items(&value["content"]).iter().enumerate() {
        let mut begin = block.clone();
        if block["type"] == "text" {
            begin["text"] = json!("");
        } else if block["type"] == "tool_use" {
            begin["input"] = json!({});
        }
        out.push_str(&frame(
            "content_block_start",
            json!({"type":"content_block_start","index":index,"content_block":begin}),
        ));
        let delta = if block["type"] == "tool_use" {
            json!({"type":"input_json_delta","partial_json":block["input"].to_string()})
        } else {
            json!({"type":"text_delta","text":block["text"]})
        };
        out.push_str(&frame(
            "content_block_delta",
            json!({"type":"content_block_delta","index":index,"delta":delta}),
        ));
        out.push_str(&frame(
            "content_block_stop",
            json!({"type":"content_block_stop","index":index}),
        ));
    }
    out.push_str(&frame("message_delta",json!({"type":"message_delta","delta":{"stop_reason":value["stop_reason"],"stop_sequence":null},"usage":{"output_tokens":value["usage"]["output_tokens"]}})));
    out.push_str(&frame("message_stop", json!({"type":"message_stop"})));
    out
}

pub(super) fn collapse_sse(raw: &str, wire: &str, model: &str) -> Result<Value> {
    let mut result = json!({"id":format!("native_{}",millis()),"model":model});
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut calls: BTreeMap<usize, Value> = BTreeMap::new();
    let mut blocks: BTreeMap<usize, Value> = BTreeMap::new();
    let mut finish = Value::Null;
    let mut usage = Value::Null;
    let mut parsed = false;
    let mut ended = false;
    for block in raw.replace("\r\n", "\n").split("\n\n") {
        let data = block
            .lines()
            .filter_map(|l| l.strip_prefix("data:").map(str::trim_start))
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let v: Value = serde_json::from_str(&data).map_err(|_| "上游 SSE JSON 损坏".to_string())?;
        parsed = true;
        if wire == "responses" {
            if ["response.completed", "response.incomplete"].contains(&text(&v, "type")) {
                return Ok(v["response"].clone());
            }
            if v["type"] == "response.failed" || v["type"] == "error" {
                return Err("上游 Responses 失败".into());
            }
            continue;
        }
        if wire == "chat-completions" {
            if !v["model"].is_null() {
                result["model"] = v["model"].clone();
            }
            if !v["id"].is_null() {
                result["id"] = v["id"].clone();
            }
            if !v["usage"].is_null() {
                usage = v["usage"].clone();
            }
            let choice = &v["choices"][0];
            content.push_str(text(&choice["delta"], "content"));
            reasoning.push_str(text(&choice["delta"], "reasoning_content"));
            if !choice["finish_reason"].is_null() {
                finish = choice["finish_reason"].clone();
            }
            for call in items(&choice["delta"]["tool_calls"]) {
                let index = call["index"].as_u64().unwrap_or(0) as usize;
                let current = calls.entry(index).or_insert(
                    json!({"id":"","type":"function","function":{"name":"","arguments":""}}),
                );
                for key in ["id"] {
                    current[key] = json!(format!("{}{}", text(current, key), text(&call, key)));
                }
                for key in ["name", "arguments"] {
                    current["function"][key] = json!(format!(
                        "{}{}",
                        text(&current["function"], key),
                        text(&call["function"], key)
                    ));
                }
            }
        } else {
            match text(&v, "type") {
                "message_start" => {
                    result = v["message"].clone();
                    usage = result["usage"].clone();
                }
                "content_block_start" => {
                    blocks.insert(
                        v["index"].as_u64().unwrap_or(0) as usize,
                        v["content_block"].clone(),
                    );
                }
                "content_block_delta" => {
                    let current = blocks
                        .entry(v["index"].as_u64().unwrap_or(0) as usize)
                        .or_insert(json!({"type":"text","text":""}));
                    let delta = &v["delta"];
                    if delta["type"] == "text_delta" {
                        current["text"] =
                            json!(format!("{}{}", text(current, "text"), text(delta, "text")));
                    } else if delta["type"] == "thinking_delta" {
                        current["thinking"] = json!(format!(
                            "{}{}",
                            text(current, "thinking"),
                            text(delta, "thinking")
                        ));
                    } else if delta["type"] == "input_json_delta" {
                        current["partial_json"] = json!(format!(
                            "{}{}",
                            text(current, "partial_json"),
                            text(delta, "partial_json")
                        ));
                    }
                }
                "message_delta" => {
                    finish = v["delta"]["stop_reason"].clone();
                    if !usage.is_object() {
                        usage = json!({});
                    }
                    for (k, value) in v["usage"].as_object().into_iter().flatten() {
                        usage[k] = value.clone();
                    }
                }
                "message_stop" => ended = true,
                "error" => return Err("上游 Messages 流失败".into()),
                _ => {}
            }
        }
    }
    if !parsed {
        return Err("上游返回空或不可解析的流".into());
    }
    if wire == "responses" {
        return Err("上游 Responses 流未完成".into());
    }
    if wire == "chat-completions" {
        if ![
            "stop",
            "tool_calls",
            "length",
            "content_filter",
            "function_call",
        ]
        .contains(&finish.as_str().unwrap_or(""))
        {
            return Err("上游 Chat 流未完成，未将残缺回复标记为成功".into());
        }
        {
            for call in calls.values() {
                if text(call, "id").is_empty()
                    || text(&call["function"], "name").is_empty()
                    || serde_json::from_str::<Value>(text(&call["function"], "arguments")).is_err()
                {
                    return Err("工具调用未完整返回，未执行残缺工具".into());
                }
            }
        }
        result["choices"] = json!([{"message":{"role":"assistant","content":content,"reasoning_content":reasoning,"tool_calls":calls.values().collect::<Vec<_>>()},"finish_reason":finish}]);
    } else {
        if !ended || finish.is_null() {
            return Err("上游 Messages 流未完成，未将残缺回复标记为成功".into());
        }
        let mut values = vec![];
        for mut block in blocks.into_values() {
            if let Some(raw) = block.get("partial_json").and_then(Value::as_str) {
                block["input"] =
                    serde_json::from_str(raw).map_err(|_| "工具参数 JSON 不完整".to_string())?;
                block.as_object_mut().unwrap().remove("partial_json");
            }
            values.push(block);
        }
        result["content"] = json!(values);
        result["stop_reason"] = finish;
    }
    result["usage"] = usage;
    Ok(result)
}

pub(super) fn validate_response(value: &Value, wire: &str) -> Result<()> {
    if value["error"].is_object() {
        return Err("上游返回错误，任务未完成".into());
    }
    if wire == "chat-completions" {
        let choice = &value["choices"][0];
        if ![
            "stop",
            "tool_calls",
            "length",
            "content_filter",
            "function_call",
        ]
        .contains(&text(choice, "finish_reason"))
        {
            return Err("上游回复未完成".into());
        }
        for call in items(&choice["message"]["tool_calls"]) {
            if text(&call, "id").is_empty()
                || text(&call["function"], "name").is_empty()
                || !serde_json::from_str::<Value>(text(&call["function"], "arguments"))
                    .is_ok_and(|v| v.is_object())
            {
                return Err("工具调用未完整返回，未执行残缺工具".into());
            }
        }
    } else if wire == "anthropic-messages" {
        if value["stop_reason"].is_null() {
            return Err("上游回复未完成".into());
        }
        for part in items(&value["content"]) {
            if part["type"] == "tool_use"
                && (text(&part, "id").is_empty()
                    || text(&part, "name").is_empty()
                    || !part["input"].is_object())
            {
                return Err("工具调用未完整返回".into());
            }
        }
    } else {
        for item in items(&value["output"]) {
            if item["type"] == "function_call"
                && !serde_json::from_str::<Value>(text(&item, "arguments"))
                    .is_ok_and(|v| v.is_object())
            {
                return Err("工具参数 JSON 不完整".into());
            }
        }
    }
    Ok(())
}
