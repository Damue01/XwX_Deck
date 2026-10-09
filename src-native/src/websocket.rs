use super::*;
use axum::{
    extract::{
        ws::{Message as Down, WebSocketUpgrade},
        FromRequestParts,
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as Up};

pub(super) async fn upgrade(
    route: Route,
    routes: Arc<std::sync::RwLock<Route>>,
    parts: &mut axum::http::request::Parts,
) -> Response {
    let Some(provider) = route.provider.as_ref() else {
        return protocol_error(404, "responses", "Codex route is disabled");
    };
    if !parts.uri.path().ends_with("/responses") {
        return protocol_error(404, "responses", "Unknown WebSocket route");
    }
    if !["responses", "auto"].contains(&provider.adapter.as_str()) {
        return protocol_error(400, "responses", "当前协议请使用 HTTP Responses 传输");
    }
    let ws = match WebSocketUpgrade::from_request_parts(parts, &()).await {
        Ok(ws) => ws,
        Err(e) => return e.into_response(),
    };
    if !provider.subscription_account_id.is_empty() {
        return protocol_error(400, "responses", "订阅账号请使用 HTTP Responses 流式请求");
    }
    let suffix = parts
        .uri
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    // Keep the official URL path and query while changing only the transport scheme.
    let mut url = match reqwest::Url::parse(&format!(
        "{}/responses{suffix}",
        provider.base_url.trim_end_matches('/').to_string()
            + if provider.oauth { "/codex" } else { "" }
    )) {
        Ok(url) => url,
        Err(_) => return protocol_error(502, "responses", "无效 WebSocket 上游"),
    };
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    let _ = url.set_scheme(scheme);
    let mut request = match url.as_str().into_client_request() {
        Ok(r) => r,
        Err(_) => return protocol_error(502, "responses", "无效 WebSocket 请求"),
    };
    for (key, value) in &parts.headers {
        if ![
            "host",
            "connection",
            "upgrade",
            "sec-websocket-key",
            "sec-websocket-version",
            "sec-websocket-extensions",
            "authorization",
            "x-api-key",
            "cookie",
            "proxy-authorization",
        ]
        .contains(&key.as_str())
        {
            request.headers_mut().insert(key.clone(), value.clone());
        }
    }
    let auth = if provider.official {
        parts.headers.get("authorization").cloned().or_else(|| {
            format!("Bearer {}", provider.bearer_token)
                .parse()
                .ok()
                .filter(|_| !provider.bearer_token.is_empty())
        })
    } else {
        format!("Bearer {}", provider.bearer_token).parse().ok()
    };
    if let Some(auth) = auth {
        request.headers_mut().insert("authorization", auth);
    }
    let upstream = match tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async(request),
    )
    .await
    {
        Ok(Ok((stream, _))) => stream,
        _ => return protocol_error(502, "responses", "WebSocket 上游连接失败"),
    };
    let session = parts
        .headers
        .get("x-codex-thread-id")
        .or_else(|| parts.headers.get("session_id"))
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let provider = provider.clone();
    let mut cancel = route.cancel.clone();
    ws.max_message_size(16*1024*1024).on_upgrade(move |mut downstream| async move {
        let mut upstream=upstream;
        let mut capture:Option<storage::Capture>=None;
        let mut continuation_body:Option<Value>=None;
        let mut route_check=tokio::time::interval(Duration::from_millis(100));
        let changed=|| routes.read().map(|current|current.provider.as_ref().is_none_or(|next|next.id!=provider.id || next.base_url!=provider.base_url || next.adapter!=provider.adapter || next.bearer_token!=provider.bearer_token || next.subscription_account_id!=provider.subscription_account_id)).unwrap_or(true);
        loop {
            tokio::select! {
                _=cancel.changed()=>{let _=downstream.send(Down::Close(None)).await;let _=upstream.send(Up::Close(None)).await;break;},
                _=route_check.tick()=>{
                    // Finish the accepted response on its original connection. Idle connections
                    // reconnect before another task can be sent to an obsolete selection.
                    if capture.is_none() && changed(){let _=downstream.send(Down::Close(None)).await;let _=upstream.send(Up::Close(None)).await;break;}
                },
                message=downstream.next()=>{
                    let Some(Ok(message))=message else {break};
                    let translated=match message {
                        Down::Text(text)=>{
                            let mut forwarded=text.to_string();
                            if let Ok(body)=serde_json::from_str::<Value>(text.as_str()) {
                                if body["type"]=="response.create" {
                                    if changed(){let _=downstream.send(Down::Text(json!({"type":"error","error":{"type":"service_changed","message":"模型服务已切换，请重新连接"}}).to_string().into())).await;if capture.is_some(){continue;}let _=downstream.send(Down::Close(None)).await;break;}
                                    let expanded=match continuation::expand(&route.root,&provider,session.as_deref().unwrap_or(""),&body,false){Ok(value)=>value,Err(error)=>{let _=downstream.send(Down::Text(json!({"type":"error","error":{"type":"context_unavailable","message":error}}).to_string().into())).await;continue;}};
                                    forwarded=expanded.to_string();continuation_body=Some(expanded);
                                    if let Some(old)=capture.take(){old.finish(None);}
                                    let index=route.count.fetch_add(1,Ordering::Relaxed)+1;let started=millis();
                                    let key=format!("codex-cli:{}",session.clone().unwrap_or_else(||format!("ws-{started}-{index}")));
                                    let mut record=json!({"id":format!("trace-{started}-{index}"),"startedAt":storage::iso(started),"startedAtMs":started as u64,"source":"codex-cli","clientConversationKey":key,"protocol":"openai-responses","captureMode":"reverse-proxy","provider":{"id":provider.id,"name":provider.display_name},"request":{"method":"WS","path":"/responses","headers":{},"body":body,"model":body["model"],"apiType":"responses"},"upstream":{"baseUrl":provider.base_url,"url":url.to_string()},"response":{"statusCode":200},"timings":{}});
                                    record["contextChanges"]=json!({"clientProtocol":"responses","upstreamProtocol":"responses","historyRestored":body.get("previous_response_id").is_some()&&continuation_body.as_ref().is_some_and(|b|b.get("previous_response_id").is_none()),"transformed":continuation_body.as_ref()!=Some(&body)});
                                    record["upstream"]["requestBody"] = continuation_body.clone().unwrap_or(Value::Null);
                                    capture=Some(storage::Capture{store:route.store.clone(),record,wire:"responses".into(),key,raw:vec![],chunk_receipts:vec![],overflow:false,done:false});
                                }
                            }
                            Up::Text(forwarded.into())
                        },Down::Binary(data)=>Up::Binary(data),Down::Ping(data)=>Up::Ping(data),Down::Pong(data)=>Up::Pong(data),Down::Close(_)=>Up::Close(None)
                    };
                    if upstream.send(translated).await.is_err(){break;}
                },
                message=upstream.next()=>{
                    let Some(Ok(message))=message else {break};
                    let translated=match message {
                        Up::Text(text)=>{
                            if let Some(ref mut guard)=capture { guard.chunk(format!("data: {text}\n\n").as_bytes()); }
                            if let Ok(value)=serde_json::from_str::<Value>(text.as_str()) {if ["response.completed","response.incomplete","response.failed"].contains(&super::text(&value,"type")){if let Some(mut guard)=capture.take(){if let (Some(body),Some(response))=(continuation_body.take(),value.get("response")){if let Err(error)=continuation::save(&route.root,&provider,session.as_deref().unwrap_or(""),&body,response){guard.record["contextChanges"]["cacheWarning"]=json!(error);}}guard.finish(value.get("response").cloned());}}}
                            Down::Text(text.to_string().into())
                        },Up::Binary(data)=>Down::Binary(data),Up::Ping(data)=>Down::Ping(data),Up::Pong(data)=>Down::Pong(data),Up::Close(_)=>Down::Close(None),Up::Frame(_)=>continue
                    };
                    if downstream.send(translated).await.is_err(){break;}
                }
            }
        }
    }).into_response()
}
