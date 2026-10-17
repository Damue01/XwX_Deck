//! Byte transport: no JSON, model overrides, observation limits, retries or redirects.
use super::*;
use axum::{
    extract::{
        ws::{Message as Down, WebSocketUpgrade},
        FromRequestParts,
    },
    http::HeaderMap,
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as Up};

pub(super) fn client() -> Result<reqwest::Client> {
    // Compression features are disabled in Cargo; bytes and Content-Encoding stay paired.
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .build()
        .map_err(err)
}
fn clean_headers(headers: &mut HeaderMap) {
    let named: Vec<String> = headers
        .get_all("connection")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|v| v.trim().into())
        .collect();
    for name in named {
        headers.remove(name.as_str());
    }
    for name in [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "host",
    ] {
        headers.remove(name);
    }
}
async fn cancelled(cancel: &mut tokio::sync::watch::Receiver<bool>) {
    if *cancel.borrow() {
        return;
    }
    let _ = cancel.changed().await;
}
fn response(
    response: reqwest::Response,
    mut cancel: tokio::sync::watch::Receiver<bool>,
    diagnostics: upstream_diagnostics::Log,
    endpoint: String,
    started: u128,
    request_headers: HeaderMap,
) -> Response {
    diagnostics.forwarding_status(&response, &endpoint, started);
    let status = response.status();
    let mut headers = response.headers().clone();
    clean_headers(&mut headers);
    let stream = async_stream::stream! {
        let mut upstream = response.bytes_stream();
        loop {
            tokio::select! {
                biased;
                _ = cancelled(&mut cancel) => { yield Err(std::io::Error::other("Gateway 已停止")); break; }
                chunk = upstream.next() => match chunk {
                    Some(Ok(bytes)) => yield Ok(bytes),
                    Some(Err(error)) => { diagnostics.forwarding_transport(&error, &endpoint, started, "response-body", &request_headers); yield Err(std::io::Error::other("上游传输中断")); break; }
                    None => break,
                }
            }
        }
    };
    let mut out = Response::new(Body::from_stream(stream));
    *out.status_mut() = status;
    *out.headers_mut() = headers;
    out
}
pub(super) async fn forward(route: Route, request: Request, endpoint: String) -> Response {
    if request.headers().contains_key("upgrade") {
        return websocket(route, request, endpoint).await;
    }
    let started = millis();
    let (mut parts, body) = request.into_parts();
    clean_headers(&mut parts.headers);
    let request_headers = parts.headers.clone();
    let upload = body.into_data_stream();
    let send = route
        .transport
        .request(parts.method, &endpoint)
        .headers(parts.headers)
        .body(reqwest::Body::wrap_stream(upload))
        .send();
    let mut cancel = route.cancel.clone();
    tokio::select! {
        biased;
        _ = cancelled(&mut cancel) => protocol_error(503, "forwarding", "Gateway 已停止，请恢复直连后重试"),
        result = send => match result {
            Ok(upstream) => response(upstream, cancel, route.diagnostics, endpoint, started, request_headers),
            Err(error) => {
                route.diagnostics.forwarding_transport(&error, &endpoint, started, "request", &request_headers);
                protocol_error(502, "forwarding", "原始上游连接失败，请检查客户端 API 地址或网络后重试")
            },
        }
    }
}
async fn websocket(route: Route, request: Request, endpoint: String) -> Response {
    let started = millis();
    let (mut parts, _) = request.into_parts();
    let ws = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
        Ok(ws) => ws,
        Err(e) => return e.into_response(),
    };
    let mut url = match reqwest::Url::parse(&endpoint) {
        Ok(u) => u,
        Err(_) => return protocol_error(502, "forwarding", "无效 WebSocket 上游"),
    };
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    let _ = url.set_scheme(scheme);
    let mut handshake = match url.as_str().into_client_request() {
        Ok(r) => r,
        Err(_) => return protocol_error(502, "forwarding", "无效 WebSocket 上游"),
    };
    clean_headers(&mut parts.headers);
    for name in [
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-extensions",
        "sec-websocket-accept",
    ] {
        parts.headers.remove(name);
    }
    for (key, value) in &parts.headers {
        handshake.headers_mut().append(key.clone(), value.clone());
    }
    let expected = tokio_tungstenite::tungstenite::handshake::derive_accept_key(
        handshake.headers()["sec-websocket-key"].as_bytes(),
    );
    let offered: Vec<String> = handshake
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(',')
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    let mut upstream_url = url;
    let scheme = if upstream_url.scheme() == "wss" {
        "https"
    } else {
        "http"
    };
    let _ = upstream_url.set_scheme(scheme);
    let client = match reqwest::Client::builder()
        .http1_only()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(_) => return protocol_error(502, "forwarding", "WebSocket 传输不可用"),
    };
    let mut cancel = route.cancel.clone();
    let send = client
        .get(upstream_url)
        .headers(handshake.headers().clone())
        .send();
    let upstream = tokio::select! {
        biased;
        _ = cancelled(&mut cancel) => return protocol_error(503,"forwarding","Gateway 已停止"),
        result = send => match result { Ok(r) => r, Err(error) => { route.diagnostics.forwarding_transport(&error, &endpoint, started, "websocket-handshake", handshake.headers()); return protocol_error(502,"forwarding","WebSocket 上游连接失败"); } }
    };
    if upstream.status() != StatusCode::SWITCHING_PROTOCOLS {
        return response(
            upstream,
            cancel,
            route.diagnostics,
            endpoint,
            started,
            handshake.headers().clone(),
        );
    }
    let h = upstream.headers();
    let value = |name| h.get(name).and_then(|v| v.to_str().ok()).unwrap_or("");
    let protocol = value("sec-websocket-protocol").to_string();
    if value("sec-websocket-accept") != expected
        || !value("upgrade").eq_ignore_ascii_case("websocket")
        || !value("connection")
            .split(',')
            .any(|v| v.trim().eq_ignore_ascii_case("upgrade"))
        || h.contains_key("sec-websocket-extensions")
        || (!protocol.is_empty() && !offered.contains(&protocol))
    {
        return protocol_error(502, "forwarding", "无效 WebSocket 上游握手");
    }
    let upgraded = tokio::select! {
        _ = cancelled(&mut cancel) => return protocol_error(503,"forwarding","Gateway 已停止"),
        result = upstream.upgrade() => match result { Ok(u) => u, Err(_) => return protocol_error(502,"forwarding","WebSocket 升级失败") }
    };
    let mut upstream = tokio_tungstenite::WebSocketStream::from_raw_socket(
        upgraded,
        tokio_tungstenite::tungstenite::protocol::Role::Client,
        None,
    )
    .await;
    let lease = parts.extensions.remove::<Arc<request_activity::Lease>>();
    let ws = if protocol.is_empty() {
        ws
    } else {
        ws.protocols([protocol])
    };
    ws.on_upgrade(move |mut downstream| async move {
        let _lease = lease;
        let pump = async {
            loop {
                tokio::select! {
                    message = downstream.next() => {
                        let Some(Ok(message)) = message else { break; };
                        let close = matches!(message, Down::Close(_));
                        let message = match message {
                            Down::Text(v) => Up::Text(v.to_string().into()), Down::Binary(v) => Up::Binary(v),
                            Down::Ping(v) => Up::Ping(v), Down::Pong(v) => Up::Pong(v),
                            Down::Close(v) => Up::Close(v.map(|v| tokio_tungstenite::tungstenite::protocol::CloseFrame {code:v.code.into(), reason:v.reason.to_string().into()})),
                        };
                        if upstream.send(message).await.is_err() { break; }
                        if close { let _ = downstream.flush().await; break; }
                    }
                    message = upstream.next() => {
                        let Some(Ok(message)) = message else { break; };
                        let close = matches!(message, Up::Close(_));
                        let message = match message {
                            Up::Text(v) => Down::Text(v.to_string().into()), Up::Binary(v) => Down::Binary(v),
                            Up::Ping(v) => Down::Ping(v), Up::Pong(v) => Down::Pong(v),
                            Up::Close(v) => Down::Close(v.map(|v| axum::extract::ws::CloseFrame {code:v.code.into(), reason:v.reason.to_string().into()})),
                            Up::Frame(_) => continue,
                        };
                        if downstream.send(message).await.is_err() { break; }
                        if close { let _ = upstream.flush().await; break; }
                    }
                }
            }
        };
        tokio::select! { _ = cancelled(&mut cancel) => {}, _ = pump => {} }
        // Dropping both transports propagates cancellation even if the peer is stalled.
    }).into_response()
}
