use super::*;
use futures_util::StreamExt;
fn frame(event: &str, value: Value, raw: &mut Vec<u8>) -> axum::body::Bytes {
    let bytes = format!("event: {event}\ndata: {value}\n\n");
    raw.extend_from_slice(bytes.as_bytes());
    bytes.into()
}
fn delta(wire: &str, value: &Value) -> String {
    match wire {
        "chat-completions" => value["choices"][0]["delta"]["content"]
            .as_str()
            .unwrap_or("")
            .into(),
        "responses" => {
            if value["type"] == "response.output_text.delta" {
                text(value, "delta").into()
            } else {
                String::new()
            }
        }
        _ => {
            if value["type"] == "content_block_delta" && value["delta"]["type"] == "text_delta" {
                text(&value["delta"], "text").into()
            } else {
                String::new()
            }
        }
    }
}
pub(super) fn claude(
    response: reqwest::Response,
    mut capture: storage::Capture,
    context: protocol::ToolContext,
    model: String,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) -> Response {
    let wire = capture.wire.clone();
    let upstream_sse = response
        .headers()
        .get("content-type")
        .and_then(|s| s.to_str().ok())
        .is_some_and(|s| s.contains("text/event-stream"));
    let stream = async_stream::stream! {
       let mut client_raw=vec![];let mut upstream=response.bytes_stream();let mut raw=vec![];let mut pending=vec![];let mut sent=String::new();let mut started=false;let mut text_open=false;
       loop {
           let next=tokio::select!{_ = cancel.changed()=>{yield Ok::<_,std::io::Error>(frame("error",json!({"type":"error","error":{"type":"api_error","message":"Gateway 已停止，响应未完成"}}),&mut client_raw));return;},next=upstream.next()=>next};
           let Some(next)=next else{break;};
           let bytes=match next {Ok(bytes)=>bytes,Err(_)=>{yield Ok(frame("error",json!({"type":"error","error":{"type":"api_error","message":"上游响应流中断"}}),&mut client_raw));return;}};
           if raw.len()+bytes.len()>32*1024*1024{yield Ok(frame("error",json!({"type":"error","error":{"type":"api_error","message":"转换响应超过 32 MB 上限"}}),&mut client_raw));return;}
           capture.chunk(&bytes);raw.extend_from_slice(&bytes);
           if !upstream_sse{continue;}
           pending.extend_from_slice(&bytes);
           loop {
               let delimiter=pending.windows(2).position(|w|w==b"\n\n").map(|p|(p,2)).or_else(||pending.windows(4).position(|w|w==b"\r\n\r\n").map(|p|(p,4)));
               let Some((end,length))=delimiter else{break;};
               let block=pending.drain(..end+length).collect::<Vec<_>>();
               let block=match std::str::from_utf8(&block){Ok(s)=>s,Err(_)=>{yield Ok(frame("error",json!({"type":"error","error":{"type":"api_error","message":"上游 SSE 不是有效 UTF-8"}}),&mut client_raw));return;}};
               let data=block.lines().filter_map(|l|l.strip_prefix("data:").map(str::trim_start)).collect::<Vec<_>>().join("\n");
               let Ok(value)=serde_json::from_str::<Value>(&data) else{continue;};
               if value["type"]=="error"||value["error"].is_object(){yield Ok(frame("error",json!({"type":"error","error":{"type":"api_error","message":"上游返回错误，响应未完成"}}),&mut client_raw));return;}
               let chunk=delta(&wire,&value);if chunk.is_empty(){continue;}
               if !started{started=true;yield Ok(frame("message_start",json!({"type":"message_start","message":{"id":format!("msg_stream_{}",millis()),"type":"message","role":"assistant","model":model,"content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}),&mut client_raw));}
               if !text_open{text_open=true;yield Ok(frame("content_block_start",json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),&mut client_raw));}
               sent.push_str(&chunk);yield Ok(frame("content_block_delta",json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":chunk}}),&mut client_raw));
           }
       }
       let parsed=if upstream_sse {std::str::from_utf8(&raw).map_err(err).and_then(|s|protocol::collapse_sse(s,&wire,&model))}else{serde_json::from_slice::<Value>(&raw).map_err(err)};
       let upstream=match parsed{Ok(v)=>v,Err(_)=>{yield Ok(frame("error",json!({"type":"error","error":{"type":"api_error","message":"上游响应无法解析"}}),&mut client_raw));return;}};
       if let Err(e)=protocol::validate_response(&upstream,&wire){yield Ok(frame("error",json!({"type":"error","error":{"type":"api_error","message":e}}),&mut client_raw));return;}
       let response=match wire.as_str(){"chat-completions"=>protocol::chat_response(&upstream,&context),"anthropic-messages"=>protocol::messages_response(&upstream,&context),_=>upstream.clone()};
       let value=protocol::responses_message(&response);
       let full=value["content"].as_array().into_iter().flatten().filter(|v|v["type"]=="text").filter_map(|v|v["text"].as_str()).collect::<Vec<_>>().join("");
       if !full.starts_with(&sent){yield Ok(frame("error",json!({"type":"error","error":{"type":"api_error","message":"上游最终文本与流不一致"}}),&mut client_raw));return;}
       if !started{let mut start=value.clone();start["content"]=json!([]);start["stop_reason"]=Value::Null;yield Ok(frame("message_start",json!({"type":"message_start","message":start}),&mut client_raw));}
       if !full.is_empty(){if !text_open{yield Ok(frame("content_block_start",json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),&mut client_raw));}if full.len()>sent.len(){yield Ok(frame("content_block_delta",json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":&full[sent.len()..]}}),&mut client_raw));}yield Ok(frame("content_block_stop",json!({"type":"content_block_stop","index":0}),&mut client_raw));}
       let mut index=if full.is_empty(){0}else{1};
       for item in value["content"].as_array().into_iter().flatten().filter(|v|v["type"]=="tool_use"){
           let mut start=item.clone();start["input"]=json!({});
           yield Ok(frame("content_block_start",json!({"type":"content_block_start","index":index,"content_block":start}),&mut client_raw));
           yield Ok(frame("content_block_delta",json!({"type":"content_block_delta","index":index,"delta":{"type":"input_json_delta","partial_json":item["input"].to_string()}}),&mut client_raw));
           yield Ok(frame("content_block_stop",json!({"type":"content_block_stop","index":index}),&mut client_raw));index+=1;
       }
       capture.record["response"]["body"]=value.clone();
       yield Ok(frame("message_delta",json!({"type":"message_delta","delta":{"stop_reason":value["stop_reason"],"stop_sequence":null},"usage":value["usage"]}),&mut client_raw));
       yield Ok(frame("message_stop",json!({"type":"message_stop"}),&mut client_raw));
       capture.record["clientRawBody"]=json!(String::from_utf8_lossy(&client_raw));capture.finish(Some(upstream));
    };
    Response::builder()
        .status(200)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .body(Body::from_stream(stream))
        .unwrap()
}

struct ResponseEvents {
    id: String,
    sequence: usize,
    slots: Vec<(String, Value, String)>,
    tools: std::collections::BTreeMap<usize, Value>,
}
impl ResponseEvents {
    fn emit(&mut self, event: &str, mut value: Value, raw: &mut Vec<u8>) -> axum::body::Bytes {
        value["type"] = json!(event);
        value["sequence_number"] = json!(self.sequence);
        self.sequence += 1;
        frame(event, value, raw)
    }
    fn slot(
        &mut self,
        key: &str,
        item: Value,
        raw: &mut Vec<u8>,
        events: &mut Vec<axum::body::Bytes>,
    ) -> usize {
        if let Some(i) = self.slots.iter().position(|(k, _, _)| k == key) {
            return i;
        }
        let i = self.slots.len();
        self.slots.push((key.into(), item.clone(), String::new()));
        events.push(self.emit(
            "response.output_item.added",
            json!({"output_index":i,"item":item}),
            raw,
        ));
        i
    }
    fn visible(&mut self, thought: bool, text: &str, raw: &mut Vec<u8>) -> Vec<axum::body::Bytes> {
        let mut events = vec![];
        if text.is_empty() {
            return events;
        }
        let key = if thought { "reasoning" } else { "text" };
        let exists = self.slots.iter().any(|(k, _, _)| k == key);
        let id = format!("{}_{}", if thought { "rs" } else { "msg" }, self.id);
        let item = if thought {
            json!({"id":id,"type":"reasoning","summary":[]})
        } else {
            json!({"id":id,"type":"message","role":"assistant","status":"in_progress","content":[]})
        };
        let i = self.slot(key, item, raw, &mut events);
        if !exists {
            events.push(self.emit(if thought{"response.reasoning_summary_part.added"}else{"response.content_part.added"},if thought{json!({"item_id":id,"output_index":i,"summary_index":0,"part":{"type":"summary_text","text":""}})}else{json!({"item_id":id,"output_index":i,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}})},raw));
        }
        self.slots[i].2.push_str(text);
        events.push(self.emit(
            if thought {
                "response.reasoning_summary_text.delta"
            } else {
                "response.output_text.delta"
            },
            if thought {
                json!({"item_id":id,"output_index":i,"summary_index":0,"delta":text})
            } else {
                json!({"item_id":id,"output_index":i,"content_index":0,"delta":text})
            },
            raw,
        ));
        events
    }
    fn tool(
        &mut self,
        index: usize,
        id: &str,
        name: &str,
        args: &str,
        context: &protocol::ToolContext,
        raw: &mut Vec<u8>,
    ) -> Vec<axum::body::Bytes> {
        let state = self
            .tools
            .entry(index)
            .or_insert(json!({"id":"","name":"","arguments":""}));
        for (key, part) in [("id", id), ("name", name), ("arguments", args)] {
            state[key] = json!(format!("{}{}", text(state, key), part));
        }
        let state = state.clone();
        let name = text(&state, "name");
        let Some(spec) = context.spec(name) else {
            return vec![];
        };
        if text(&state, "id").is_empty() {
            return vec![];
        }
        let key = format!("tool:{index}");
        let exists = self.slots.iter().any(|(k, _, _)| k == &key);
        let custom = spec["type"] == "custom";
        let id = format!("fc_{}", text(&state, "id"));
        let mut item = json!({"id":id,"type":if custom{"custom_tool_call"}else{"function_call"},"status":"in_progress","call_id":state["id"],"name":spec["name"]});
        if spec["namespace"].as_str().is_some_and(|n| !n.is_empty()) {
            item["namespace"] = spec["namespace"].clone();
        }
        item[if custom { "input" } else { "arguments" }] = json!("");
        let mut events = vec![];
        let i = self.slot(&key, item, raw, &mut events);
        if !custom {
            let fragment = if exists {
                args
            } else {
                text(&state, "arguments")
            };
            self.slots[i].2.push_str(fragment);
            if !fragment.is_empty() {
                events.push(self.emit(
                    "response.function_call_arguments.delta",
                    json!({"item_id":id,"output_index":i,"delta":fragment}),
                    raw,
                ));
            }
        }
        events
    }
}
pub(super) fn responses(
    response: reqwest::Response,
    mut capture: storage::Capture,
    context: protocol::ToolContext,
    provider: Provider,
    root: PathBuf,
    session: String,
    body: Value,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) -> Response {
    let wire = capture.wire.clone();
    let sse = response
        .headers()
        .get("content-type")
        .and_then(|s| s.to_str().ok())
        .is_some_and(|s| s.contains("text/event-stream"));
    let stream = async_stream::stream! {
        let mut client_raw=vec![];let mut events=ResponseEvents{id:format!("resp_{}",text(&capture.record,"id")),sequence:0,slots:vec![],tools:Default::default()};
        let initial=json!({"id":events.id,"object":"response","model":body["model"],"status":"in_progress","output":[],"error":null});
        yield Ok::<_,std::io::Error>(events.emit("response.created",json!({"response":initial}),&mut client_raw));
        yield Ok(events.emit("response.in_progress",json!({"response":initial}),&mut client_raw));
        let mut upstream=response.bytes_stream();let mut raw=vec![];let mut pending=vec![];
        loop {
            let next=tokio::select!{_ = cancel.changed()=>{yield Ok(events.emit("response.failed",json!({"response":{"id":events.id,"status":"failed","error":{"type":"gateway_stopped","message":"Gateway 已停止，响应未完成"}}}),&mut client_raw));return;},next=upstream.next()=>next};
            let Some(next)=next else{break};let bytes=match next{Ok(b)=>b,Err(_)=>{yield Ok(events.emit("response.failed",json!({"response":{"id":events.id,"status":"failed","error":{"type":"upstream_stream_error","message":"上游响应流中断，未自动重发任务"}}}),&mut client_raw));return;}};
            if raw.len()+bytes.len()>32*1024*1024{yield Ok(events.emit("response.failed",json!({"response":{"id":events.id,"status":"failed","error":{"type":"response_too_large","message":"转换响应超过上限"}}}),&mut client_raw));return;}
            capture.chunk(&bytes);raw.extend_from_slice(&bytes);if !sse{continue;}pending.extend_from_slice(&bytes);
            loop {
                let delimiter=pending.windows(2).position(|w|w==b"\n\n").map(|p|(p,2)).or_else(||pending.windows(4).position(|w|w==b"\r\n\r\n").map(|p|(p,4)));
                let Some((end,length))=delimiter else{break};let block=pending.drain(..end+length).collect::<Vec<_>>();
                let Ok(block)=std::str::from_utf8(&block) else{yield Ok(events.emit("response.failed",json!({"response":{"id":events.id,"status":"failed","error":{"type":"invalid_stream","message":"上游流编码无效"}}}),&mut client_raw));return;};
                let data=block.lines().filter_map(|l|l.strip_prefix("data:").map(str::trim_start)).collect::<Vec<_>>().join("\n");let Ok(value)=serde_json::from_str::<Value>(&data) else{continue;};
                if value["type"]=="error" || value["error"].is_object(){yield Ok(events.emit("response.failed",json!({"response":{"id":events.id,"status":"failed","error":{"type":"upstream_error","message":"上游返回错误，任务未完成"}}}),&mut client_raw));return;}
                if wire=="chat-completions" {
                    for event in events.visible(false,text(&value["choices"][0]["delta"],"content"),&mut client_raw){yield Ok(event);}
                    for event in events.visible(true,text(&value["choices"][0]["delta"],"reasoning_content"),&mut client_raw){yield Ok(event);}
                    for call in value["choices"][0]["delta"]["tool_calls"].as_array().into_iter().flatten(){for event in events.tool(call["index"].as_u64().unwrap_or(0)as usize,text(call,"id"),text(&call["function"],"name"),text(&call["function"],"arguments"),&context,&mut client_raw){yield Ok(event);}}
                } else {
                    if value["type"]=="content_block_delta" {
                        if value["delta"]["type"]=="text_delta" {for event in events.visible(false,text(&value["delta"],"text"),&mut client_raw){yield Ok(event);}}
                        if value["delta"]["type"]=="thinking_delta" {for event in events.visible(true,text(&value["delta"],"thinking"),&mut client_raw){yield Ok(event);}}
                        if value["delta"]["type"]=="input_json_delta" {for event in events.tool(value["index"].as_u64().unwrap_or(0)as usize,"","",text(&value["delta"],"partial_json"),&context,&mut client_raw){yield Ok(event);}}
                    } else if value["type"]=="content_block_start" && value["content_block"]["type"]=="tool_use" {
                        let part=&value["content_block"];let arguments=if part["input"].as_object().is_some_and(|o|!o.is_empty()){part["input"].to_string()}else{String::new()};
                        for event in events.tool(value["index"].as_u64().unwrap_or(0)as usize,text(part,"id"),text(part,"name"),&arguments,&context,&mut client_raw){yield Ok(event);}
                    }
                }
            }
        }
        let parsed=if sse{std::str::from_utf8(&raw).map_err(err).and_then(|s|protocol::collapse_sse(s,&wire,text(&body,"model")))}else{serde_json::from_slice::<Value>(&raw).map_err(err)};
        let upstream=match parsed{Ok(v)=>v,Err(e)=>{yield Ok(events.emit("response.failed",json!({"response":{"id":events.id,"status":"failed","error":{"type":"incomplete_stream","message":e}}}),&mut client_raw));return;}};
        if let Err(e)=protocol::validate_response(&upstream,&wire){yield Ok(events.emit("response.failed",json!({"response":{"id":events.id,"status":"failed","error":{"type":"invalid_response","message":e}}}),&mut client_raw));return;}
        let mut value=if wire=="chat-completions"{protocol::chat_response(&upstream,&context)}else{protocol::messages_response(&upstream,&context)};value["id"]=json!(events.id);
        let mut ordered=vec![];let mut final_items=value["output"].as_array().cloned().unwrap_or_default();
        for (key,start,sent) in events.slots.clone() {
            let pos=final_items.iter().position(|item|if key=="text"{item["type"]=="message"}else if key=="reasoning"{item["type"]=="reasoning"}else{item["call_id"]==start["call_id"]});
            let Some(pos)=pos else{yield Ok(events.emit("response.failed",json!({"response":{"id":events.id,"status":"failed","error":{"type":"inconsistent_stream","message":"上游流与最终回复不一致"}}}),&mut client_raw));return;};
            let mut item=final_items.remove(pos);item["id"]=start["id"].clone();let index=ordered.len();
            let full=if key=="text"{text(&item["content"][0],"text")}else if key=="reasoning"{text(&item["summary"][0],"text")}else{text(&item,"arguments")};
            if !full.starts_with(&sent){yield Ok(events.emit("response.failed",json!({"response":{"id":events.id,"status":"failed","error":{"type":"inconsistent_stream","message":"上游增量与最终回复不一致"}}}),&mut client_raw));return;}
            if key=="text" || key=="reasoning" {
                if full.len()>sent.len(){yield Ok(events.emit(if key=="text"{"response.output_text.delta"}else{"response.reasoning_summary_text.delta"},json!({"item_id":item["id"],"output_index":index,"content_index":0,"summary_index":0,"delta":&full[sent.len()..]}),&mut client_raw));}
                yield Ok(events.emit(if key=="text"{"response.output_text.done"}else{"response.reasoning_summary_text.done"},json!({"item_id":item["id"],"output_index":index,"content_index":0,"summary_index":0,"text":full}),&mut client_raw));
                yield Ok(events.emit(if key=="text"{"response.content_part.done"}else{"response.reasoning_summary_part.done"},json!({"item_id":item["id"],"output_index":index,"content_index":0,"summary_index":0,"part":if key=="text"{item["content"][0].clone()}else{item["summary"][0].clone()}}),&mut client_raw));
            } else {
                let custom=item["type"]=="custom_tool_call";
                if custom {yield Ok(events.emit("response.custom_tool_call_input.delta",json!({"item_id":item["id"],"output_index":index,"delta":item["input"]}),&mut client_raw));}
                yield Ok(events.emit(if custom{"response.custom_tool_call_input.done"}else{"response.function_call_arguments.done"},json!({"item_id":item["id"],"output_index":index,"arguments":item["arguments"],"input":item["input"]}),&mut client_raw));
            }
            yield Ok(events.emit("response.output_item.done",json!({"output_index":index,"item":item}),&mut client_raw));ordered.push(item);
        }
        // A non-streaming upstream or tool without a declared name can arrive only at completion.
        for item in final_items {
            let index=ordered.len();let mut start=item.clone();
            start["status"]=json!("in_progress");
            match text(&item,"type") { "message"=>start["content"]=json!([]),"reasoning"=>start["summary"]=json!([]),"function_call"=>start["arguments"]=json!(""),"custom_tool_call"=>start["input"]=json!(""),_=>{} }
            yield Ok(events.emit("response.output_item.added",json!({"output_index":index,"item":start}),&mut client_raw));
            let thought=item["type"]=="reasoning";
            if item["type"]=="message" || thought {
                let parts=if thought{&item["summary"]}else{&item["content"]};
                for (part_index,part) in parts.as_array().into_iter().flatten().enumerate() {
                    let mut empty=part.clone();empty["text"]=json!("");
                    let base=json!({"item_id":item["id"],"output_index":index,"content_index":part_index,"summary_index":part_index});
                    let mut added=base.clone();added["part"]=empty;
                    yield Ok(events.emit(if thought{"response.reasoning_summary_part.added"}else{"response.content_part.added"},added,&mut client_raw));
                    let mut delta=base.clone();delta["delta"]=part["text"].clone();
                    yield Ok(events.emit(if thought{"response.reasoning_summary_text.delta"}else{"response.output_text.delta"},delta,&mut client_raw));
                    let mut done=base.clone();done["text"]=part["text"].clone();
                    yield Ok(events.emit(if thought{"response.reasoning_summary_text.done"}else{"response.output_text.done"},done,&mut client_raw));
                    let mut done=base;done["part"]=part.clone();
                    yield Ok(events.emit(if thought{"response.reasoning_summary_part.done"}else{"response.content_part.done"},done,&mut client_raw));
                }
            } else if item["type"]=="function_call" || item["type"]=="custom_tool_call" {
                let custom=item["type"]=="custom_tool_call";let field=if custom{"input"}else{"arguments"};
                yield Ok(events.emit(if custom{"response.custom_tool_call_input.delta"}else{"response.function_call_arguments.delta"},json!({"item_id":item["id"],"output_index":index,"delta":item[field]}),&mut client_raw));
                let mut done=json!({"item_id":item["id"],"output_index":index});done[field]=item[field].clone();
                yield Ok(events.emit(if custom{"response.custom_tool_call_input.done"}else{"response.function_call_arguments.done"},done,&mut client_raw));
            }
            yield Ok(events.emit("response.output_item.done",json!({"output_index":index,"item":item}),&mut client_raw));ordered.push(item);
        }
        value["output"]=json!(ordered);capture.record["response"]["body"]=value.clone();
        if let Err(e)=continuation::save(&root,&provider,&session,&body,&value){capture.record["contextChanges"]["cacheWarning"]=json!(e);}
        yield Ok(events.emit(if value["status"]=="completed"{"response.completed"}else{"response.incomplete"},json!({"response":value}),&mut client_raw));
        capture.record["clientRawBody"]=json!(String::from_utf8_lossy(&client_raw));capture.finish(Some(upstream));
    };
    Response::builder()
        .status(200)
        .header("content-type", "text/event-stream")
        .header("cache-control", "no-cache")
        .body(Body::from_stream(stream))
        .unwrap()
}
