//! Unparsed traffic has an immutable source binding, independent of model routing.
use super::*;
use axum::http::{HeaderMap, Method, Uri};
use std::collections::BTreeMap;

#[derive(Clone, Default)]
pub(super) struct Bindings(BTreeMap<String, Result<Binding>>);
#[derive(Clone)]
pub(super) struct Binding {
    base: String,
    token: String,
    api_key: bool,
    // Client credentials may be used only while the model still belongs to this source.
    client_auth: bool,
    mount_v1: bool,
    mount_backend: bool,
    mount_codex: bool,
}
fn unavailable() -> String {
    "无法确定此接口的原始上游，请检查客户端 API 地址或停止 Trace 恢复直连后重试".into()
}
impl Binding {
    fn new(base: String, token: String, api_key: bool, client_auth: bool) -> Result<Self> {
        let url = reqwest::Url::parse(&base).map_err(|_| unavailable())?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || token.contains("local-subscription")
        {
            return Err(unavailable());
        }
        Ok(Self {
            base: base.trim_end_matches('/').into(),
            token,
            api_key,
            client_auth,
            mount_v1: false,
            mount_backend: false,
            mount_codex: false,
        })
    }
    fn provider(p: &Provider) -> Result<Self> {
        if !p.subscription_account_id.is_empty() {
            return Err(unavailable());
        }
        let mut binding = Self::new(
            Pilot::provider_api_root(p),
            p.bearer_token.clone(),
            p.adapter == "anthropic-messages",
            false,
        )?;
        binding.mount_v1 = true;
        Ok(binding)
    }
    fn same_service(&self, provider: Option<&Provider>) -> bool {
        provider.is_some_and(|p| {
            p.subscription_account_id.is_empty()
                && reqwest::Url::parse(&Pilot::provider_api_root(p))
                    .ok()
                    .zip(reqwest::Url::parse(&self.base).ok())
                    .is_some_and(|(a, b)| {
                        a.origin() == b.origin()
                            && (a.path().trim_end_matches('/') == b.path().trim_end_matches('/')
                                || (p.official
                                    && p.oauth
                                    && a.path().trim_end_matches('/').trim_end_matches("/codex")
                                        == b.path()
                                            .trim_end_matches('/')
                                            .trim_end_matches("/codex")))
                    })
                && (p.official || p.bearer_token == self.token)
        })
    }
    fn endpoint(&self, path: &str, query: Option<&str>, local_port: u16) -> Result<String> {
        // Concatenate a bound prefix; URL::join would allow ../ and // to change it.
        if !path.starts_with('/')
            || path.starts_with("//")
            || path.contains('\\')
            || path.split('/').any(|s| {
                let decoded = s.to_ascii_lowercase().replace("%2e", ".");
                decoded == "." || decoded == ".."
            })
        {
            return Err("无效接口路径，请检查客户端 API 地址".into());
        }
        let base = reqwest::Url::parse(&self.base).map_err(|_| unavailable())?;
        if matches!(
            base.host_str(),
            Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
        ) && base.port_or_known_default() == Some(local_port)
        {
            return Err("原始上游仍指向当前 Gateway，请停止 Trace 并修复客户端 API 地址".into());
        }
        // /v1 is the legacy local mount. Retain an existing upstream API prefix.
        let relative = if self.mount_codex {
            ["/backend-api/codex", "/v1", "/codex"]
                .iter()
                .find_map(|prefix| {
                    path.strip_prefix(prefix)
                        .filter(|s| s.is_empty() || s.starts_with('/'))
                })
                .unwrap_or(path)
                .to_string()
        } else if self.mount_v1 || base.path().ends_with("/v1") {
            path.strip_prefix("/v1/")
                .map(|p| format!("/{p}"))
                .or_else(|| (path == "/v1").then(String::new))
                .unwrap_or_else(|| path.into())
        } else if (self.mount_backend || base.path().ends_with("/backend-api"))
            && path.starts_with("/backend-api/")
        {
            path.trim_start_matches("/backend-api").into()
        } else {
            path.into()
        };
        Ok(format!(
            "{}{relative}{}",
            self.base,
            query.map(|q| format!("?{q}")).unwrap_or_default()
        ))
    }
}
// Reuse the existing field-ownership ledgers rather than treating Deck's current
// model overlay as the original source after a stop/restart.
fn codex_source(pilot: &Pilot) -> Result<DocumentMut> {
    let mut current = pilot.config()?;
    // Runtime refreshes must recover the source behind the active overlay too.
    // Otherwise enabling another client can capture this Gateway as its source.
    if let Some(gateway) = &pilot.gateway {
        if gateway.codex_managed {
            current = doc(&restore_codex_fields(
                &current.to_string(),
                &gateway.before,
                &gateway.managed,
                gateway.codex_official,
            )?)?;
        }
    }
    if pilot.selected().is_none() {
        return Ok(current);
    }
    if let Some(source) = read(&pilot.root.join("codex-direct.json"))? {
        let ledger: Value = serde_json::from_str(&source).map_err(err)?;
        return doc(&restore_codex_fields(
            &current.to_string(),
            text(&ledger, "before"),
            text(&ledger, "managed"),
            false,
        )?);
    }
    Ok(current)
}
fn codex_auth(pilot: &Pilot) -> Result<Value> {
    read(&pilot.codex_home().join("auth.json"))?
        .map(|s| serde_json::from_str(&s).map_err(err))
        .transpose()
        .map(|v| v.unwrap_or(Value::Null))
}
fn auth_token(auth: &Value) -> String {
    auth["tokens"]["access_token"]
        .as_str()
        .or_else(|| auth["OPENAI_API_KEY"].as_str())
        .unwrap_or("")
        .into()
}
fn official_binding(config: &DocumentMut, auth: &Value, active: &str) -> Result<Binding> {
    let oauth = auth["tokens"]["access_token"]
        .as_str()
        .is_some_and(|s| !s.is_empty());
    let unified = (active == "xwx_deck")
        .then(|| {
            config
                .get("model_providers")
                .and_then(|p| p.get(active))
                .and_then(|p| p.get("base_url"))
                .and_then(Item::as_str)
        })
        .flatten();
    let base = unified
        .or_else(|| config.get("openai_base_url").and_then(Item::as_str))
        .filter(|s| !s.is_empty())
        .unwrap_or(if oauth {
            "https://chatgpt.com/backend-api/codex"
        } else {
            "https://api.openai.com/v1"
        });
    if auth_token(auth).is_empty()
        && !config.contains_key("openai_base_url")
        && !config.contains_key("chatgpt_base_url")
        && unified.is_none()
    {
        return Err(unavailable());
    }
    let mut binding = Binding::new(base.into(), auth_token(auth), false, true)?;
    binding.mount_v1 = !oauth;
    binding.mount_codex = oauth;
    Ok(binding)
}
impl Bindings {
    pub(super) fn capture(pilot: &Pilot) -> Self {
        let mut bindings = BTreeMap::new();
        let codex = (|| {
            let config = codex_source(pilot)?;
            let active = config
                .get("model_provider")
                .and_then(Item::as_str)
                .unwrap_or("openai");
            if active == "openai"
                || (active == "xwx_deck"
                    && pilot.settings.codex_enhancements["unifySessionHistory"] == true)
            {
                official_binding(&config, &codex_auth(pilot)?, active)
            } else {
                let table = config
                    .get("model_providers")
                    .and_then(|v| v.get(active))
                    .ok_or_else(unavailable)?;
                let base = table
                    .get("base_url")
                    .and_then(Item::as_str)
                    .ok_or_else(unavailable)?
                    .into();
                let token = table
                    .get("experimental_bearer_token")
                    .and_then(Item::as_str)
                    .map(str::to_string)
                    .or_else(|| {
                        table
                            .get("env_key")
                            .and_then(Item::as_str)
                            .and_then(|key| std::env::var(key).ok())
                    })
                    .or_else(|| {
                        (table.get("requires_openai_auth").and_then(Item::as_bool) == Some(true))
                            .then(|| read(&pilot.codex_home().join("auth.json")).ok().flatten())
                            .flatten()
                            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                            .and_then(|v| {
                                v["tokens"]["access_token"]
                                    .as_str()
                                    .or_else(|| v["OPENAI_API_KEY"].as_str())
                                    .map(str::to_string)
                            })
                    })
                    .unwrap_or_default();
                let mut binding = Binding::new(base, token, false, true)?;
                binding.mount_v1 = true;
                Ok(binding)
            }
        })();
        let account = (|| {
            let config = codex_source(pilot)?;
            let active = config
                .get("model_provider")
                .and_then(Item::as_str)
                .unwrap_or("openai");
            if active != "openai"
                && !(active == "xwx_deck"
                    && pilot.settings.codex_enhancements["unifySessionHistory"] == true)
            {
                return Err(unavailable());
            }
            let auth = codex_auth(pilot)?;
            if auth["tokens"]["access_token"]
                .as_str()
                .is_none_or(str::is_empty)
            {
                return Err(unavailable());
            }
            let base = config
                .get("chatgpt_base_url")
                .and_then(Item::as_str)
                .unwrap_or("https://chatgpt.com/backend-api")
                .into();
            {
                let mut binding = Binding::new(base, auth_token(&auth), false, true)?;
                binding.mount_backend = true;
                Ok(binding)
            }
        })();
        bindings.insert("@account".into(), account);
        bindings.insert("codex".into(), codex);
        let claude = (|| {
            let current = pilot.claude_config()?;
            let config = if let Some(source) = read(&pilot.root.join("claude-direct.json"))? {
                let ledger: Value = serde_json::from_str(&source).map_err(err)?;
                pilot.check_claude_restore_source(
                    &current.to_string(),
                    &ledger["before"].to_string(),
                    &ledger["managed"].to_string(),
                )?
            } else {
                current
            };
            let credentials = read(&pilot.claude_dir().join(".credentials.json"))?
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .unwrap_or(Value::Null);
            let oauth_token = credentials["claudeAiOauth"]["accessToken"]
                .as_str()
                .filter(|s| !s.is_empty());
            if oauth_token.is_none()
                && ![
                    "ANTHROPIC_BASE_URL",
                    "ANTHROPIC_AUTH_TOKEN",
                    "ANTHROPIC_API_KEY",
                ]
                .iter()
                .any(|key| {
                    config["env"][key]
                        .as_str()
                        .is_some_and(|s| !s.trim().is_empty())
                })
            {
                return Err(unavailable());
            }
            let base = config["env"]["ANTHROPIC_BASE_URL"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("https://api.anthropic.com")
                .into();
            let token = config["env"]["ANTHROPIC_AUTH_TOKEN"]
                .as_str()
                .or_else(|| config["env"]["ANTHROPIC_API_KEY"].as_str())
                .or(oauth_token)
                .unwrap_or("")
                .into();
            Binding::new(
                base,
                token,
                config["env"]["ANTHROPIC_AUTH_TOKEN"].as_str().is_none()
                    && config["env"]["ANTHROPIC_API_KEY"].as_str().is_some(),
                true,
            )
        })();
        bindings.insert("claude".into(), claude);
        for (id, p) in pilot.generic_routes() {
            bindings.insert(id, Binding::provider(&p));
        }
        Self(bindings)
    }
    pub(super) fn add_clients(&mut self, clients: &BTreeMap<String, Provider>) {
        for (id, p) in clients {
            self.0
                .entry(id.clone())
                .or_insert_with(|| Binding::provider(p));
        }
    }
    // New clients can be enabled in place; existing sources never follow model switching.
    pub(super) fn extend(&mut self, next: Self) {
        for (id, binding) in next.0 {
            match self.0.entry(id) {
                std::collections::btree_map::Entry::Vacant(entry) => {
                    entry.insert(binding);
                }
                std::collections::btree_map::Entry::Occupied(mut entry)
                    if entry.get().is_err() && binding.is_ok() =>
                {
                    let _ = entry.insert(binding);
                }
                _ => {}
            }
        }
    }
}

fn scoped(path: &str) -> (&str, &str) {
    if let Some(p) = path.strip_prefix("/_xwx/claude/") {
        return ("claude", p);
    }
    if let Some(p) = path.strip_prefix("/claude-desktop/") {
        return ("claude", p);
    }
    if let Some((id, p)) = path
        .strip_prefix("/clients/")
        .and_then(|p| p.split_once('/'))
    {
        return (id, p);
    }
    ("codex", path.trim_start_matches('/'))
}
// Only known model protocols enter conversion, failover, decompression and Trace.
pub(super) fn model_request(request: &Request) -> bool {
    let (_, relative) = scoped(request.uri().path());
    let p = format!("/{relative}");
    let get = *request.method() == Method::GET;
    if get {
        return matches!(p.as_str(), "/models" | "/v1/models" | "/v1beta/models")
            || (request.headers().contains_key("upgrade")
                && matches!(
                    p.as_str(),
                    "/responses" | "/v1/responses" | "/backend-api/codex/responses"
                ));
    }
    if *request.method() != Method::POST {
        return false;
    }
    matches!(
        p.as_str(),
        "/responses"
            | "/v1/responses"
            | "/responses/compact"
            | "/v1/responses/compact"
            | "/backend-api/codex/responses"
            | "/backend-api/codex/responses/compact"
            | "/messages"
            | "/v1/messages"
            | "/anthropic/v1/messages"
            | "/messages/count_tokens"
            | "/v1/messages/count_tokens"
            | "/anthropic/v1/messages/count_tokens"
            | "/chat/completions"
            | "/v1/chat/completions"
    ) || ((p.starts_with("/v1beta/models/") || p.starts_with("/v1/models/"))
        && [":generateContent", ":streamGenerateContent", ":countTokens"]
            .iter()
            .any(|s| p.ends_with(s)))
}
pub(super) fn normalize_model_scope(request: &mut Request) {
    if let Some(p) = request.uri().path().strip_prefix("/_xwx/claude/") {
        let query = request
            .uri()
            .query()
            .map(|q| format!("?{q}"))
            .unwrap_or_default();
        // Keep the Claude identity on model paths used by the existing router.
        let path =
            if p.ends_with("/messages") || p.ends_with("/messages/count_tokens") || p == "messages"
            {
                format!("/{p}{query}")
            } else {
                return;
            };
        if let Ok(uri) = path.parse::<Uri>() {
            *request.uri_mut() = uri;
        }
    }
}
pub(super) async fn forward(route: Route, request: Request) -> Response {
    let (client_id, relative) = scoped(request.uri().path());
    let id = if client_id == "codex"
        && relative.starts_with("backend-api/")
        && !relative.starts_with("backend-api/codex/")
    {
        "@account"
    } else {
        client_id
    };
    let enabled = match client_id {
        "codex" => route.provider.is_some(),
        "claude" => route.claude.is_some(),
        _ => route.clients.contains_key(id),
    };
    if !enabled {
        return protocol_error(
            404,
            "forwarding",
            "此客户端未开启 Trace，请在客户端列表中开启后重试",
        );
    }
    let binding = match route.forwarding.0.get(id) {
        Some(Ok(b)) => b.clone(),
        Some(Err(e)) => return protocol_error(502, "forwarding", e),
        None => return protocol_error(502, "forwarding", &unavailable()),
    };
    let endpoint = match binding.endpoint(
        &format!("/{relative}"),
        request.uri().query(),
        route.local_port,
    ) {
        Ok(url) => url,
        Err(e) => return protocol_error(502, "forwarding", &e),
    };
    let model = match client_id {
        "codex" => route.provider.as_ref(),
        "claude" => route.claude.as_ref(),
        _ => route.clients.get(id),
    };
    let client_auth = binding.client_auth
        && (binding.same_service(model)
            || (id == "@account" && model.is_some_and(|p| p.official && p.oauth)));
    // A query credential must not cross from the selected model service to a
    // different source. Reject it rather than silently rewriting the query.
    if reqwest::Url::parse(&endpoint).ok().is_some_and(|url| {
        url.query_pairs().any(|(key, value)| {
            matches!(key.as_ref(), "key" | "api_key" | "access_token")
                && ((!client_auth && value != binding.token)
                    || value.contains("local-subscription")
                    || (value != binding.token
                        && route.third_party_tokens.iter().any(|t| *t == value)))
        })
    }) {
        return protocol_error(
            401,
            "forwarding",
            "此接口的查询凭据不属于原始服务，请恢复原服务配置或停止 Trace 后重试",
        );
    }
    let mut request = request;
    let headers = request.headers_mut();
    if let Err(e) = authorize(&binding, client_auth, headers, &route.third_party_tokens) {
        return protocol_error(401, "forwarding", &e);
    }
    super::gateway_transport::forward(route, request, endpoint).await
}
fn authorize(
    binding: &Binding,
    client_auth: bool,
    headers: &mut HeaderMap,
    foreign: &[String],
) -> Result<()> {
    let incoming = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim_start_matches("Bearer ");
    let key = headers
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let google_key = headers
        .get("x-goog-api-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let foreign_auth = [incoming, key, google_key].iter().any(|v| {
        v.contains("local-subscription")
            || (!v.is_empty() && *v != binding.token && foreign.iter().any(|t| t == v))
    });
    if client_auth && !foreign_auth {
        return Ok(());
    }
    let had_auth = [
        "authorization",
        "x-api-key",
        "x-goog-api-key",
        "cookie",
        "chatgpt-account-id",
    ]
    .iter()
    .any(|k| headers.contains_key(*k));
    for key in [
        "authorization",
        "x-api-key",
        "x-goog-api-key",
        "cookie",
        "chatgpt-account-id",
    ] {
        headers.remove(key);
    }
    if binding.token.is_empty() {
        if had_auth {
            return Err("此接口属于客户端原始服务，当前模型服务的凭据不能用于该服务；请恢复原服务登录或停止 Trace 后重试".into());
        }
    } else {
        let value = if binding.api_key {
            binding.token.clone()
        } else {
            format!("Bearer {}", binding.token)
        };
        headers.insert(
            if binding.api_key {
                "x-api-key"
            } else {
                "authorization"
            },
            value.parse().map_err(|_| "原始服务凭据无效，请重新登录")?,
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn official_model_source_uses_sdk_root_and_preserves_explicit_override() {
        let auth = json!({"tokens":{"access_token":"fixture-token"}});
        let config =
            doc(r#"chatgpt_base_url = "https://account.example.test/account-root""#).unwrap();
        let binding = official_binding(&config, &auth, "openai").unwrap();
        assert_eq!(
            binding.endpoint("/images/generations", None, 1234).unwrap(),
            "https://chatgpt.com/backend-api/codex/images/generations"
        );
        for path in [
            "/v1/images/generations",
            "/backend-api/codex/images/generations",
            "/codex/images/generations",
        ] {
            assert_eq!(
                binding.endpoint(path, None, 1234).unwrap(),
                "https://chatgpt.com/backend-api/codex/images/generations"
            );
        }
        let config = doc(r#"openai_base_url = "https://model.example.test/custom"
chatgpt_base_url = "https://account.example.test/account-root"
"#)
        .unwrap();
        let binding = official_binding(&config, &auth, "openai").unwrap();
        assert_eq!(
            binding.endpoint("/v1/images/edits", None, 1234).unwrap(),
            "https://model.example.test/custom/images/edits"
        );
        let config = doc(r#"openai_base_url = "https://inactive.example.test/unused"
[model_providers.xwx_deck]
base_url = "https://model.example.test/custom/codex"
"#)
        .unwrap();
        let binding = official_binding(&config, &auth, "xwx_deck").unwrap();
        assert_eq!(
            binding.endpoint("/images/generations", None, 1234).unwrap(),
            "https://model.example.test/custom/codex/images/generations"
        );
        let binding = official_binding(
            &doc("").unwrap(),
            &json!({"OPENAI_API_KEY":"fixture-key"}),
            "openai",
        )
        .unwrap();
        assert_eq!(
            binding.endpoint("/v1/files", None, 1234).unwrap(),
            "https://api.openai.com/v1/files"
        );
    }
}
