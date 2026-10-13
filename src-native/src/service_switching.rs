//! Explicit, per-client quota failover. Never replays accepted/partial responses.
use super::*;
use std::collections::{BTreeMap, HashSet};

impl Pilot {
    pub(super) fn service_switching_snapshot(&self) -> Result<Value> {
        let value = self
            .settings
            .other
            .get("serviceSwitching")
            .cloned()
            .unwrap_or(json!({}));
        if !value.is_object() {
            return Err("服务切换配置格式错误，请检查设置文件后重试".into());
        }
        for client in ["codex", "claude"] {
            if let Some(policy) = value.get(client) {
                serde_json::from_value::<Policy>(policy.clone()).map_err(err)?;
            }
        }
        Ok(value)
    }

    pub(super) fn set_service_switching(&mut self, input: &Value) -> Result<Value> {
        self.check_settings_source()?;
        let client = text(input, "client");
        if !["codex", "claude"].contains(&client) {
            return Err("无效客户端".into());
        }
        let policy: Policy = serde_json::from_value(input["policy"].clone()).map_err(err)?;
        let mut policies = self.service_switching_snapshot()?;
        let mut unique = HashSet::new();
        for id in &policy.provider_ids {
            let saved = policies[client]["providerIds"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|v| v.as_str() == Some(id)));
            if !unique.insert(id)
                || (!saved && !self.settings.connections.iter().any(|p| &p.id == id))
            {
                return Err("服务不存在或顺序包含重复项，请刷新配置".into());
            }
        }
        policies[client] = json!(policy);
        let previous = self.settings.clone();
        self.settings
            .other
            .insert("serviceSwitching".into(), policies.clone());
        if let Err(error) = self.persist() {
            self.settings = previous;
            return Err(error);
        }
        if let Some(gateway) = &self.gateway {
            gateway
                .routes
                .read()
                .map_err(err)?
                .switching
                .configure(&self.settings);
        }
        Ok(policies)
    }

    pub(super) fn update_provider_client_model(&mut self, input: &Value) -> Result<Value> {
        self.check_settings_source()?;
        let client = text(input, "client");
        if !["codex", "claude"].contains(&client) {
            return Err("无效客户端".into());
        }
        let model = text(input, "model");
        if model.is_empty() {
            return Err("请选择模型".into());
        }
        let previous = self.settings.clone();
        let provider = self
            .settings
            .connections
            .iter_mut()
            .find(|p| p.id == text(input, "providerId"))
            .ok_or("服务不存在")?;
        if client == "codex" {
            provider.codex_model = model.into();
        } else {
            let role = text(input, "role");
            if !["fable", "opus", "sonnet", "haiku"].contains(&role) {
                return Err("请选择模型角色".into());
            }
            provider.claude_models[role] = json!(model);
        }
        if let Err(error) = self.persist() {
            self.settings = previous;
            return Err(error);
        }
        if self.settings.selected[client].as_str() == Some(text(input, "providerId")) {
            if client == "codex" {
                self.write_direct(false)?;
            } else {
                self.write_claude_direct(false)?;
                self.refresh_desktop_selection()?;
            }
        }
        Ok(self.providers())
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct Policy {
    pub enabled: bool,
    pub provider_ids: Vec<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct Affinity {
    provider: String,
    at: u64,
}
#[derive(Default, Serialize, Deserialize)]
struct Runtime {
    #[serde(default)]
    selected: Value,
    affinity: BTreeMap<String, Affinity>,
    blocked: BTreeMap<String, u64>,
}
#[derive(Default)]
struct Config {
    policies: BTreeMap<String, Policy>,
    providers: Vec<Provider>,
    selected: Value,
}
#[derive(Clone)]
pub(super) struct Routing {
    config: Arc<std::sync::RwLock<Config>>,
    runtime: Arc<std::sync::Mutex<Runtime>>,
    path: PathBuf,
}
fn now() -> u64 {
    (millis() / 1000) as u64
}
pub(super) fn quota_error(status: u16, bytes: &[u8]) -> bool {
    if ![400, 402, 403, 429].contains(&status) {
        return false;
    }
    let Ok(v) = serde_json::from_slice::<Value>(bytes) else {
        return false;
    };
    let e = if v["error"].is_object() {
        &v["error"]
    } else {
        &v["response"]["error"]
    };
    let code = text(e, "code");
    let kind = text(e, "type");
    let codes = [
        "insufficient_quota",
        "quota_exceeded",
        "usage_limit_reached",
        "credits_exhausted",
        "billing_hard_limit_reached",
        "credit_balance_too_low",
    ];
    if codes.contains(&code) || codes.contains(&kind) {
        return true;
    }
    let message = text(e, "message").to_lowercase();
    [
        "quota exhausted",
        "quota exceeded",
        "insufficient quota",
        "usage limit reached",
        "credit balance is too low",
        "额度已用完",
        "额度已用尽",
        "余额不足",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}
impl Routing {
    pub fn new(root: &Path, settings: &Settings) -> Self {
        let path = root.join("service-switching-runtime.json");
        let runtime = read(&path)
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let this = Self {
            config: Arc::new(std::sync::RwLock::new(Config::default())),
            runtime: Arc::new(std::sync::Mutex::new(runtime)),
            path,
        };
        this.configure(settings);
        this
    }
    pub fn configure(&self, settings: &Settings) {
        if let Ok(mut config) = self.config.write() {
            if let Ok(mut runtime) = self.runtime.lock() {
                if runtime.selected != settings.selected {
                    if !runtime.selected.is_null() {
                        runtime.affinity.clear();
                    }
                    runtime.selected = settings.selected.clone();
                    self.persist(&mut runtime);
                }
            }
            config.policies = serde_json::from_value(
                settings
                    .other
                    .get("serviceSwitching")
                    .cloned()
                    .unwrap_or(json!({})),
            )
            .unwrap_or_default();
            config.providers = settings.connections.clone();
            config.selected = settings.selected.clone();
        }
    }
    pub fn enabled(&self, client: &str) -> bool {
        self.config
            .read()
            .ok()
            .and_then(|c| c.policies.get(client).map(|p| p.enabled))
            .unwrap_or(false)
    }
    fn key(client: &str, base: &Provider, session: &str) -> String {
        storage::digest(format!("{client}\n{}\n{session}", base.id).as_bytes())
    }
    fn block_key(p: &Provider) -> String {
        storage::digest(
            format!(
                "{}\n{}\n{}\n{}",
                p.id, p.base_url, p.bearer_token, p.codex_model
            )
            .as_bytes(),
        )
    }
    pub fn current(&self, client: &str, base: &Provider, session: &str) -> Provider {
        if session.is_empty() || !self.enabled(client) {
            return base.clone();
        }
        let id = self.runtime.lock().ok().and_then(|r| {
            r.affinity
                .get(&Self::key(client, base, session))
                .filter(|a| now().saturating_sub(a.at) < 86400)
                .map(|a| a.provider.clone())
        });
        id.and_then(|id| {
            let c = self.config.read().ok()?;
            if !c.policies.get(client)?.provider_ids.contains(&id) {
                return None;
            }
            c.providers.iter().find(|p| p.id == id).cloned()
        })
        .unwrap_or_else(|| base.clone())
    }
    pub fn blocked(&self, p: &Provider) -> bool {
        self.runtime
            .lock()
            .ok()
            .and_then(|r| r.blocked.get(&Self::block_key(p)).copied())
            .is_some_and(|until| until > now())
    }
    pub fn exhausted(&self, p: &Provider, headers: &axum::http::HeaderMap) {
        // A cooldown is an observed failure state, never an invented quota reading.
        let seconds = headers
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(300)
            .clamp(1, 7 * 86400);
        if let Ok(mut r) = self.runtime.lock() {
            r.blocked.insert(Self::block_key(p), now() + seconds);
            self.persist(&mut r);
        }
    }
    pub fn switched(
        &self,
        client: &str,
        base: &Provider,
        target: &Provider,
        session: &str,
    ) -> bool {
        if session.is_empty() {
            return false;
        }
        if let Ok(mut r) = self.runtime.lock() {
            let previous = r.affinity.insert(
                Self::key(client, base, session),
                Affinity {
                    provider: target.id.clone(),
                    at: now(),
                },
            );
            self.persist(&mut r);
            return target.id != base.id && previous.is_none_or(|a| a.provider != target.id);
        }
        false
    }
    fn persist(&self, r: &mut Runtime) {
        r.affinity.retain(|_, a| now().saturating_sub(a.at) < 86400);
        r.blocked.retain(|_, until| *until > now());
        while r.affinity.len() > 4096 {
            if let Some(key) = r
                .affinity
                .iter()
                .min_by_key(|(_, a)| a.at)
                .map(|(key, _)| key.clone())
            {
                r.affinity.remove(&key);
            }
        }
        if let Ok(data) = serde_json::to_string(r) {
            let _ = write(&self.path, &data);
        }
    }
    pub fn selected(&self, client: &str) -> Value {
        self.config
            .read()
            .map(|c| c.selected[client].clone())
            .unwrap_or(Value::Null)
    }
    pub fn candidates(
        &self,
        client: &str,
        after: &str,
        attempted: &HashSet<String>,
    ) -> Vec<Provider> {
        let Ok(c) = self.config.read() else {
            return vec![];
        };
        let Some(policy) = c.policies.get(client).filter(|p| p.enabled) else {
            return vec![];
        };
        policy
            .provider_ids
            .iter()
            .skip(
                policy
                    .provider_ids
                    .iter()
                    .position(|id| id == after)
                    .map(|i| i + 1)
                    .unwrap_or(0),
            )
            .filter(|id| !attempted.contains(*id))
            .filter_map(|id| c.providers.iter().find(|p| &p.id == id))
            .filter(|p| !self.blocked(p))
            .cloned()
            .collect()
    }
}
pub(super) fn target_model(
    client: &str,
    base: &Provider,
    target: &Provider,
    requested: &str,
) -> Option<String> {
    if client == "codex" {
        return (!target.codex_model.is_empty()).then(|| target.codex_model.clone());
    }
    ["fable", "opus", "sonnet", "haiku"]
        .iter()
        .find(|role| {
            requested == **role
                || base.claude_models[**role]
                    .as_str()
                    .is_some_and(|m| !m.is_empty() && m == requested)
        })
        .and_then(|role| target.claude_models[*role].as_str())
        .filter(|m| !m.is_empty())
        .map(String::from)
}
pub(super) async fn forward(
    route: Route,
    routes: Arc<std::sync::RwLock<Route>>,
    request: Request,
) -> Response {
    if request.extensions().get::<ingress::Origin>().is_some() {
        return forward_subscription(route, routes, request).await;
    }
    let is_claude = request.uri().path().ends_with("/messages")
        || request.uri().path().starts_with("/claude-desktop/");
    let client = if is_claude { "claude" } else { "codex" };
    if request.headers().contains_key("upgrade") {
        if route.switching.enabled(client) {
            return protocol_error(
                426,
                "responses",
                "自动切换使用 HTTP 流式传输，请继续同一会话",
            );
        }
        return forward_subscription(route, routes, request).await;
    }
    let generation = request.method() == axum::http::Method::POST
        && (request.uri().path().ends_with("/responses")
            || request.uri().path().ends_with("/messages")
            || request.uri().path().ends_with("/compact"));
    let base = if is_claude {
        route.claude.clone()
    } else {
        route.provider.clone()
    };
    let Some(base) = base.filter(|_| generation) else {
        return forward_subscription(route, routes, request).await;
    };
    let request = match request_encoding::decode(request).await {
        Ok(r) => r,
        Err((s, e)) => return protocol_error(s, "responses", &e),
    };
    let (parts, body) = request.into_parts();
    let bytes = match to_bytes(body, 16 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return protocol_error(413, "responses", "请求过大"),
    };
    let payload = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
    let session = conversation_identity::session(&parts.headers, &payload, !is_claude)
        .or_else(|| payload["metadata"]["user_id"].as_str().map(String::from))
        .unwrap_or_default();
    let session = parts
        .extensions
        .get::<ingress::Origin>()
        .map(|o| format!("{}:{session}", o.client))
        .unwrap_or(session);
    if !route.switching.enabled(client) {
        return forward_subscription(route, routes, Request::from_parts(parts, Body::from(bytes)))
            .await;
    }
    let initial_selection = route.switching.selected(client);
    let mut selected = route.switching.current(client, &base, &session);
    let mut attempted = HashSet::new();
    let mut previous = None;
    if !selected.subscription_account_id.is_empty()
        && route.subscriptions.pool.quota_exhausted(
            &selected.subscription_account_id,
            &route.subscriptions.snapshot().await,
        )
    {
        route
            .switching
            .exhausted(&selected, &axum::http::HeaderMap::new());
    }
    if route.switching.blocked(&selected) {
        attempted.insert(selected.id.clone());
        if let Some(next) = route
            .switching
            .candidates(client, &selected.id, &attempted)
            .into_iter()
            .find(|p| target_model(client, &base, p, text(&payload, "model")).is_some())
        {
            selected = next;
        } else {
            return protocol_error(
                429,
                "responses",
                "没有可用的备用服务，请检查额度、模型和切换顺序后重试",
            );
        }
    }
    loop {
        attempted.insert(selected.id.clone());
        let mut attempt = route.clone();
        if selected.id != base.id {
            attempt.model_override =
                target_model(client, &base, &selected, text(&payload, "model"));
            if attempt.model_override.is_none() {
                return previous.unwrap_or_else(|| {
                    protocol_error(
                        400,
                        "responses",
                        "备用服务尚未配置对应模型，请在增强功能中选择模型",
                    )
                });
            }
        }
        if is_claude {
            attempt.claude = Some(selected.clone());
        } else {
            attempt.provider = Some(selected.clone());
        }
        let response = forward_subscription(
            attempt,
            routes.clone(),
            Request::from_parts(parts.clone(), Body::from(bytes.clone())),
        )
        .await;
        let status = response.status().as_u16();
        if ![400, 402, 403, 429, 503].contains(&status)
            || !route.switching.enabled(client)
            || parts.uri.path().ends_with("/compact")
        {
            if response.status().is_success() {
                if route.switching.switched(client, &base, &selected, &session) {
                    route
                        .subscriptions
                        .pool
                        .notice(format!("额度用尽，已切换到 {}", selected.display_name));
                }
                // Stream errors affect the next turn only. Never replay a partially accepted turn.
                let (response_parts, body) = response.into_parts();
                let routing = route.switching.clone();
                let provider = selected.clone();
                let headers = response_parts.headers.clone();
                let sse = headers
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|v| v.contains("text/event-stream"));
                let stream = async_stream::stream! {
                    use futures_util::StreamExt;
                    let mut upstream=body.into_data_stream();let mut pending=Vec::new();
                    while let Some(chunk)=upstream.next().await {
                        if let Ok(bytes)=&chunk {
                            if pending.len()+bytes.len()<=256*1024 {pending.extend_from_slice(bytes);}else{pending.clear();}
                            if sse {while let Some(end)=pending.windows(2).position(|pair|pair==b"\n\n") {
                                let event:Vec<_>=pending.drain(..end+2).collect();
                                for line in event.split(|byte|*byte==b'\n') {if let Some(data)=line.strip_prefix(b"data:") {if quota_error(429,data){routing.exhausted(&provider,&headers);}}}
                            }}else if quota_error(429,&pending){routing.exhausted(&provider,&headers);}
                        }
                        yield chunk;
                    }
                };
                return Response::from_parts(response_parts, Body::from_stream(stream));
            }
            return response;
        }
        let (response_parts, body) = response.into_parts();
        let error = match to_bytes(body, 1024 * 1024).await {
            Ok(b) => b,
            Err(_) => return protocol_error(status, "responses", "上游拒绝请求，请重试"),
        };
        let quota = if selected.subscription_account_id.is_empty() {
            quota_error(status, &error)
        } else {
            let accounts = route.subscriptions.snapshot().await;
            route
                .subscriptions
                .pool
                .quota_exhausted(&selected.subscription_account_id, &accounts)
        };
        previous = Some(Response::from_parts(
            response_parts.clone(),
            Body::from(error),
        ));
        if !quota
            || !route.switching.enabled(client)
            || route.switching.selected(client) != initial_selection
        {
            return previous.unwrap();
        }
        route
            .switching
            .exhausted(&selected, &response_parts.headers);
        let Some(next) = route
            .switching
            .candidates(client, &selected.id, &attempted)
            .into_iter()
            .find(|p| target_model(client, &base, p, text(&payload, "model")).is_some())
        else {
            return previous.unwrap();
        };
        selected = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_definite_quota_rejection() {
        assert!(quota_error(
            429,
            br#"{"error":{"code":"insufficient_quota"}}"#
        ));
        assert!(!quota_error(
            429,
            br#"{"error":{"code":"rate_limit_exceeded"}}"#
        ));
        assert!(!quota_error(
            500,
            br#"{"error":{"code":"insufficient_quota"}}"#
        ));
        assert!(!quota_error(
            200,
            br#"{"error":{"code":"insufficient_quota"}}"#
        ));
        assert!(!quota_error(429, br#"{"output_text":"quota exceeded"}"#));
    }
    #[test]
    fn claude_keeps_role_mapping() {
        let base = Provider {
            claude_models: json!({"sonnet":"old-sonnet"}),
            ..Default::default()
        };
        let target = Provider {
            claude_models: json!({"sonnet":"new-sonnet"}),
            ..Default::default()
        };
        assert_eq!(
            target_model("claude", &base, &target, "old-sonnet").as_deref(),
            Some("new-sonnet")
        );
        assert!(target_model("claude", &base, &target, "explicit-other").is_none());
    }
}
