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

// Use the same system/environment proxy and TLS stack as HTTP forwarding.
// connect_async opens a direct TCP socket and bypasses macOS HTTP proxies.
async fn connect_upstream(
    request: axum::http::Request<()>,
) -> Result<tokio_tungstenite::WebSocketStream<reqwest::Upgraded>> {
    let mut url = reqwest::Url::parse(&request.uri().to_string()).map_err(err)?;
    let scheme = if url.scheme() == "wss" {
        "https"
    } else {
        "http"
    };
    url.set_scheme(scheme).map_err(|_| "无效 WebSocket 上游")?;
    let expected = tokio_tungstenite::tungstenite::handshake::derive_accept_key(
        request.headers()["sec-websocket-key"].as_bytes(),
    );
    let protocols = request
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .collect::<Vec<_>>();
    let response = reqwest::Client::builder()
        .http1_only()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .build()
        .map_err(err)?
        .get(url)
        .headers(request.headers().clone())
        .send()
        .await
        .map_err(|_| "WebSocket 上游连接失败")?;
    let headers = response.headers();
    let header = |key| headers.get(key).and_then(|v| v.to_str().ok()).unwrap_or("");
    if response.status() != 101
        || !header("upgrade").eq_ignore_ascii_case("websocket")
        || !header("connection")
            .split(',')
            .any(|v| v.trim().eq_ignore_ascii_case("upgrade"))
        || header("sec-websocket-accept") != expected
        || headers.contains_key("sec-websocket-extensions")
        || request.headers().contains_key("sec-websocket-protocol")
            != headers.contains_key("sec-websocket-protocol")
        || headers
            .get("sec-websocket-protocol")
            .is_some_and(|v| v.to_str().map_or(true, |v| !protocols.contains(&v)))
    {
        return Err("无效 WebSocket 上游握手".into());
    }
    let stream = response.upgrade().await.map_err(err)?;
    Ok(tokio_tungstenite::WebSocketStream::from_raw_socket(
        stream,
        tokio_tungstenite::tungstenite::protocol::Role::Client,
        None,
    )
    .await)
}

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
        return protocol_error(426, "responses", "当前协议请使用 HTTP Responses 传输");
    }
    let ws = match WebSocketUpgrade::from_request_parts(parts, &()).await {
        Ok(ws) => ws,
        Err(e) => return e.into_response(),
    };
    let official_oauth = official_chatgpt::backend_subscription(provider);
    if !provider.subscription_account_id.is_empty() || official_oauth {
        // The official subscription's HTTP catalog does not guarantee that
        // its models are enabled on WS. Negotiate before accepting a create;
        // the client can use the same Responses provider/model over HTTP.
        // Custom OAuth endpoints and API services retain their WS transport.
        return protocol_error(426, "responses", "订阅账号请使用 HTTP Responses 流式请求");
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
    let auth = official_chatgpt::authorization(
        provider,
        parts
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok()),
        &route.third_party_tokens,
    )
    .and_then(|value| value.parse().ok());
    if let Some(auth) = auth {
        request.headers_mut().insert("authorization", auth);
    }
    let upstream =
        match tokio::time::timeout(Duration::from_secs(10), connect_upstream(request)).await {
            Ok(Ok(stream)) => stream,
            _ if !provider.official && !provider.oauth => {
                // No response.create has been accepted or sent. Codex can safely
                // negotiate HTTP when a compatible Responses service lacks WS.
                return protocol_error(
                    426,
                    "responses",
                    "此服务的 WebSocket 不可用，请使用 HTTP Responses 传输",
                );
            }
            _ => return protocol_error(502, "responses", "WebSocket 上游连接失败"),
        };
    let headers = parts.headers.clone();
    let provider = provider.clone();
    let mut cancel = route.cancel.clone();
    let lease = parts.extensions.remove::<Arc<request_activity::Lease>>();
    ws.max_message_size(16*1024*1024).on_upgrade(move |mut downstream| async move {
        drop(lease);
        let mut active_lease = None;
        let mut upstream=upstream;
        let mut capture:Option<storage::Capture>=None;
        let mut continuation_body:Option<Value>=None;
        let mut session:Option<String>=None;
        let mut tool_observer:Option<tool_wait::Observer>=None;
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
                                    session=conversation_identity::session(&headers,&body,true);
                                    let mut expanded=match continuation::expand(&route.root,&provider,session.as_deref().unwrap_or(""),&body,false){Ok(value)=>value,Err(error)=>{let _=downstream.send(Down::Text(json!({"type":"error","error":{"type":"context_unavailable","message":error}}).to_string().into())).await;continue;}};
                                    match continuation::selected_model(&route.root,&provider,session.as_deref().unwrap_or(""),super::text(&body,"model")){Ok(model) if !model.is_empty()=>expanded["model"]=json!(model),Ok(_)=>{},Err(error)=>{let _=downstream.send(Down::Text(json!({"type":"error","error":{"type":"context_unavailable","message":error}}).to_string().into())).await;continue;}};
                                    let admitted=match route.activity.enter(){Ok(lease)=>lease,Err(error)=>{let _=downstream.send(Down::Text(json!({"type":"error","error":{"type":"gateway_stopping","message":error}}).to_string().into())).await;continue;}};
                                    active_lease=Some(admitted);
                                    forwarded=expanded.to_string();continuation_body=Some(expanded);
                                    if let Some(old)=capture.take(){old.finish(None);}
                                    let index=route.count.fetch_add(1,Ordering::Relaxed)+1;let started=millis();
                                    tool_observer=Some(tool_wait::Observer::new(route.activity.clone(),index,&provider,"codex-cli",session.as_deref().unwrap_or(""),&continuation_body.as_ref().unwrap()["input"],"responses"));
                                    let key=format!("codex-cli:{}",session.clone().unwrap_or_else(||format!("ws-{started}-{index}")));
                                    let mut record=json!({"id":format!("trace-{started}-{index}"),"startedAt":storage::iso(started),"startedAtMs":started as u64,"source":"codex-cli","clientConversationKey":key,"protocol":"openai-responses","captureMode":"reverse-proxy","provider":{"id":provider.id,"name":provider.display_name},"request":{"method":"WS","path":"/responses","headers":{},"body":body,"model":body["model"],"apiType":"responses"},"upstream":{"baseUrl":provider.base_url,"url":url.to_string()},"response":{"statusCode":200},"timings":{}});
                                    record["clientFirstPrompt"]=json!(ingress::first_prompt(continuation_body.as_ref().unwrap_or(&body)));
                                    record["catalogIdentity"]=json!(catalog::identity(&provider));
                                    if let Some(price)=provider_pricing::snapshot(&route.root,&provider,super::text(continuation_body.as_ref().unwrap(),"model")){record["providerPrice"]=storage::provider_price(&route.store,super::text(continuation_body.as_ref().unwrap(),"model"),price);}
                                    record["contextChanges"]=json!({"clientProtocol":"responses","upstreamProtocol":"responses","historyRestored":body.get("previous_response_id").is_some()&&continuation_body.as_ref().is_some_and(|b|b.get("previous_response_id").is_none()),"transformed":continuation_body.as_ref()!=Some(&body)});
                                    record["upstream"]["requestBody"] = continuation_body.clone().unwrap_or(Value::Null);
                                    record["upstream"]["model"] = record["upstream"]["requestBody"]["model"].clone();
                                    record["request"]["clientModel"] = body["model"].clone();
                                    record["request"]["model"] = record["upstream"]["model"].clone();
                                    record["contextChanges"]["modelRemapped"] = json!(record["upstream"]["model"] != body["model"]);
                                    storage::freeze_reference_price(&route.store,&mut record);
                                    capture=Some(storage::Capture{_detail_lease:Some(storage::DetailLease::new(route.store.clone(),&key)),store:route.store.clone(),record,wire:"responses".into(),key,raw:vec![],chunk_receipts:vec![],overflow:false,done:false,client_evidence:None});
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
                            if let (Some(observer),Some(guard),Ok(value))=(tool_observer.as_mut(),capture.as_ref(),serde_json::from_str::<Value>(text.as_str())) { observer.event(&value,&guard.raw); }
                            if let Ok(value)=serde_json::from_str::<Value>(text.as_str()) {
                                if ["response.completed","response.incomplete","response.failed"].contains(&super::text(&value,"type")) {
                                    if let Some(mut guard)=capture.take() {
                                        let assembled=if !guard.overflow {protocol::collapse_sse(&String::from_utf8_lossy(&guard.raw),"responses",super::text(&guard.record["request"],"model")).ok()} else {None};
                                        if assembled.is_none() && value["type"] != "response.failed" {guard.record["error"]=json!("上游 Responses 输出项未完整结束，未发布续接缓存");}
                                        if let (Some(body),Some(response))=(continuation_body.take(),assembled.as_ref()) {
                                            if let Err(error)=continuation::save(&route.root,&provider,session.as_deref().unwrap_or(""),&body,response,super::text(&guard.record["request"],"clientModel")){guard.record["contextChanges"]["cacheWarning"]=json!(error);}
                                        }
                                        guard.finish(assembled.or_else(||value.get("response").cloned()));
                                    }
                                }
                            }
                            Down::Text(text.to_string().into())
                        },Up::Binary(data)=>Down::Binary(data),Up::Ping(data)=>Down::Ping(data),Up::Pong(data)=>Down::Pong(data),Up::Close(_)=>Down::Close(None),Up::Frame(_)=>continue
                    };
                    if downstream.send(translated).await.is_err(){break;}
                    if capture.is_none() { active_lease.take(); }
                }
            }
        }
    }).into_response()
}
