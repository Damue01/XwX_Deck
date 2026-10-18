use super::*;
pub(super) const CLAUDE_KEYS: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_FAST_MODEL",
    "ANTHROPIC_REASONING_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
];

pub(super) struct OfficialCatalog {
    cache: Option<Value>,
    pub(super) provider: Option<Provider>,
    account_id: String,
    selected: String,
}
impl OfficialCatalog {
    pub(super) async fn execute(&self) -> Result<Value> {
        let mut cache = self.cache.clone();
        if let Some(provider) = self.provider.as_ref() {
            let base = provider.base_url.trim_end_matches('/');
            let url = if provider.oauth && base.ends_with("/backend-api") {
                format!("{base}/codex/models")
            } else {
                format!("{base}/models")
            };
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(8))
                .build()
                .map_err(err)?;
            let mut request = client.get(&url).bearer_auth(&provider.bearer_token);
            if provider.oauth {
                request = request.query(&[("client_version", env!("CARGO_PKG_VERSION"))]);
                if !self.account_id.is_empty() {
                    request = request.header("ChatGPT-Account-Id", &self.account_id);
                }
            }
            let response = request
                .send()
                .await
                .map_err(|_| "官方模型目录请求失败，请检查网络后重试")?;
            if !response.status().is_success() {
                return Err(format!(
                    "官方模型目录读取失败（HTTP {}），请刷新客户端登录后重试；已选模型保留",
                    response.status().as_u16()
                ));
            }
            let body: Value = response
                .json()
                .await
                .map_err(|_| "官方模型目录格式无法识别")?;
            if !provider.oauth {
                let rows = body["data"]
                    .as_array()
                    .ok_or("官方 API 模型目录格式无法识别")?;
                let mut entries: Vec<Value> = rows
                    .iter()
                    .filter_map(|row| {
                        row["id"].as_str().filter(|id| !id.is_empty()).map(|id| {
                            json!({"id":id,"vendor":"OpenAI","protocols":["openai-responses"],
                                "clients":["codex"],"protocolsDeclared":false})
                        })
                    })
                    .collect();
                if !provider.codex_model.is_empty()
                    && !entries.iter().any(|e| e["id"] == provider.codex_model)
                {
                    entries.push(json!({"id":provider.codex_model,"vendor":"已配置",
                            "protocols":["openai-responses"],"clients":["codex"]}));
                }
                return Ok(json!(entries));
            }
            if !body["models"].is_array() {
                return Err(
                    "当前授权未返回套餐模型目录，请重新选择订阅账号后重试；已选模型保留".into(),
                );
            }
            // Never rewrite Codex's own cache or credentials.
            cache = Some(body);
        }
        let mut entries = vec![];
        for row in cache
            .as_ref()
            .and_then(|c| c["models"].as_array())
            .into_iter()
            .flatten()
        {
            let id = text(row, "slug");
            if id.is_empty() || row["visibility"] != "list" || row["supported_in_api"] == false {
                continue;
            }
            let mut entry = json!({"id":id,"vendor":"OpenAI","protocols":["openai-responses"],"clients":["codex"],"protocolsDeclared":true});
            if row["display_name"].is_string() {
                entry["displayName"] = row["display_name"].clone();
            }
            if row["context_window"].as_u64().is_some_and(|n| n > 0) {
                entry["contextWindow"] = row["context_window"].clone();
                entry["codexContextWindow"] = row["context_window"].clone();
                entry["codexContextWindowSource"] = json!("codex");
                entry["nativeCodexContextWindow"] = row["context_window"].clone();
            }
            if row["input_modalities"].is_array() {
                entry["inputModalities"] = row["input_modalities"].clone();
            }
            let levels: Vec<_> = row["supported_reasoning_levels"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().or_else(|| v["effort"].as_str()))
                .collect();
            if !levels.is_empty() {
                entry["reasoningLevels"] = json!(levels);
            }
            if row["default_reasoning_level"].is_string() {
                entry["defaultReasoningLevel"] = row["default_reasoning_level"].clone();
            }
            entries.push(entry);
        }
        let selected = self.selected.as_str();
        if !selected.is_empty() && !entries.iter().any(|e| e["id"] == selected) {
            entries.push(json!({"id":selected,"vendor":"已配置","protocols":["openai-responses"],"clients":["codex"]}));
        }
        Ok(json!(entries))
    }
}

fn provider_cache(root: &Path, provider: &Provider) -> PathBuf {
    root.join(format!(
        "provider-{}-models.json",
        &storage::digest(provider.id.as_bytes())[..24]
    ))
}
pub(super) async fn subscription_catalog(
    accounts: &subscriptions::Accounts,
    root: &Path,
    provider: &Provider,
) -> Result<Value> {
    let body = accounts.catalog(&provider.subscription_account_id).await?;
    if provider.subscription_account_id.starts_with("cursor-") {
        let rows = body["models"]
            .as_array()
            .ok_or("无效 Cursor 订阅模型目录")?;
        return Ok(json!(rows.iter().filter(|m|m["isHidden"]!=true&&m["isChatOnly"]!=true&&m["onlySupportsCmdK"]!=true&&m["supportsAgent"]!=false).filter_map(|m|m["name"].as_str().map(|id|catalog::with_service_metadata(json!({"id":if id=="default"{"auto"}else{id},"displayName":m["clientDisplayName"].as_str().unwrap_or(id),"vendor":"Cursor","protocols":["chat-completions"],"protocolsDeclared":true,"clients":["codex","claude"]}), m))).collect::<Vec<_>>()));
    }
    if provider
        .subscription_account_id
        .starts_with("claude-subscription-")
    {
        let rows = body["data"].as_array().ok_or("无效 Claude 订阅模型目录")?;
        return Ok(json!(rows.iter().filter_map(|m|m["id"].as_str().map(|id|catalog::with_service_metadata(json!({"id":id,"displayName":m["display_name"].as_str().unwrap_or(id),"vendor":"Anthropic","protocols":["anthropic-messages"],"protocolsDeclared":true,"clients":["codex","claude"]}), m))).collect::<Vec<_>>()));
    }
    if provider.subscription_account_id.starts_with("copilot-") {
        let rows = body["data"].as_array().ok_or("无效 Copilot 订阅模型目录")?;
        let entries:Vec<_>=rows.iter().filter(|m|copilot_accounts::CopilotAccounts::model_visible(m)).filter_map(|m|m["id"].as_str().map(|id| {
                    let endpoints=m["supported_endpoints"].as_array();
                    let mut protocols=vec![];
                    for endpoint in endpoints.into_iter().flatten().filter_map(Value::as_str) {match endpoint {"/responses"|"/v1/responses"=>protocols.push("openai-responses"),"/chat/completions"|"/v1/chat/completions"=>protocols.push("chat-completions"),"/messages"|"/v1/messages"=>protocols.push("anthropic-messages"),_=>{}}}
                    if protocols.is_empty(){protocols.push("chat-completions");}
                    catalog::with_service_metadata(json!({"id":id,"displayName":m["name"].as_str().unwrap_or(id),"vendor":"GitHub Copilot","protocols":protocols,"protocolsDeclared":true,"clients":["codex","claude"]}), m)
                })).collect();
        write(
            &provider_cache(root, provider),
            &json!({"baseUrl":provider.base_url,"adapter":provider.adapter,"entries":entries})
                .to_string(),
        )?;
        return Ok(json!(entries));
    }
    if provider.subscription_account_id.starts_with("grok-") {
        let rows = body["data"].as_array().ok_or("无效 Grok 订阅模型目录")?;
        return Ok(json!(rows.iter().filter_map(|m|m["id"].as_str().map(|id|catalog::with_service_metadata(json!({"id":id,"displayName":m["name"].as_str().unwrap_or(id),"vendor":"xai","protocols":["openai-responses"],"protocolsDeclared":true,"clients":["codex","claude"]}), m))).collect::<Vec<_>>()));
    }
    let rows = body["models"].as_array().ok_or("无效订阅模型目录")?;
    let entries:Vec<_>=rows.iter().filter(|m|m["visibility"]=="list").filter_map(|m|m["slug"].as_str().map(|id|catalog::with_service_metadata(json!({"id":id,"displayName":m["display_name"],"vendor":"openai","protocols":["openai-responses"],"protocolsDeclared":true,"clients":["codex","claude"]}), m))).collect();
    Ok(json!(entries))
}

impl Pilot {
    /// Keep the selected connection as intent, while only publishing a direct
    /// endpoint that the receiving client can actually consume.
    pub(super) fn needs_gateway(&self, provider: &Provider, client: &str) -> bool {
        if !provider.subscription_account_id.is_empty() {
            return true;
        }
        if client == "codex" {
            !["responses", "openai-responses"].contains(
                &resolve_wire(
                    &self.root,
                    provider,
                    Some(&provider.codex_model),
                    "responses",
                )
                .as_str(),
            )
        } else {
            let models = provider
                .claude_models
                .as_object()
                .into_iter()
                .flat_map(|m| m.values())
                .filter_map(Value::as_str)
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>();
            if models.is_empty() {
                resolve_wire(&self.root, provider, None, "anthropic-messages")
                    != "anthropic-messages"
            } else {
                models.iter().any(|model| {
                    resolve_wire(&self.root, provider, Some(model), "anthropic-messages")
                        != "anthropic-messages"
                })
            }
        }
    }
    pub(super) fn official_catalog_context(&self, refresh: bool) -> Result<OfficialCatalog> {
        let provider = if refresh {
            self.official_codex()?
                .filter(|p| !p.bearer_token.is_empty())
        } else {
            None
        };
        let auth: Value = read(&self.codex_home().join("auth.json"))?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(Value::Null);
        if provider.as_ref().is_some_and(|p| {
            p.oauth && auth["tokens"]["access_token"].as_str() != Some(p.bearer_token.as_str())
        }) {
            return Err("客户端登录已更改，请重新加载模型目录".into());
        }
        Ok(OfficialCatalog {
            cache: read(&self.codex_home().join("models_cache.json"))?
                .and_then(|s| serde_json::from_str(&s).ok()),
            provider,
            account_id: auth["tokens"]["account_id"]
                .as_str()
                .or_else(|| auth["account_id"].as_str())
                .unwrap_or("")
                .into(),
            selected: self
                .config()?
                .get("model")
                .and_then(Item::as_str)
                .unwrap_or("")
                .into(),
        })
    }
    pub(super) async fn official_catalog(&self, refresh: bool) -> Result<Value> {
        self.official_catalog_context(refresh)?.execute().await
    }

    pub(super) fn recover_interrupted_gateway(&self) -> Result<()> {
        let file = self.root.join("gateway-recovery.json");
        let Some(source) = read(&file)? else {
            return Ok(());
        };
        let ledger: Value = serde_json::from_str(&source).map_err(err)?;
        let claude_path = self.resolve_claude_path()?;
        let mut codex = None;
        if ledger["codexManaged"].as_bool().unwrap_or(true) {
            let current = read(&self.config_path())?.unwrap_or_default();
            let restored = restore_codex_fields(
                &current,
                ledger["before"].as_str().ok_or("恢复账本损坏")?,
                ledger["managed"].as_str().ok_or("恢复账本损坏")?,
                ledger["codexOfficial"] == true,
            )?;
            codex = Some((current, restored));
        }
        let claude = if let Some(pair) = ledger["claude"].as_array() {
            let current = read(&claude_path)?.unwrap_or_default();
            Some((
                current,
                self.check_claude_restore(
                    pair[0].as_str().ok_or("恢复账本损坏")?,
                    pair[1].as_str().ok_or("恢复账本损坏")?,
                )?,
            ))
        } else {
            None
        };
        self.desktop_preflight()?;
        // Retain evidence before attempting any field-safe repair.
        write(
            &self
                .root
                .join(format!("gateway-recovered-{}.json", millis())),
            &source,
        )?;
        if let Some((current, restored)) = codex {
            write_checked(&self.config_path(), &current, &restored)?;
        }
        if let Some((current, restored)) = claude {
            write_checked(&claude_path, &current, &restored.to_string())?;
        }
        self.desktop_restore()?;
        self.desktop_apply(None)?;
        fs::remove_file(file).map_err(err)?;
        Ok(())
    }
    pub(super) fn auth_mode(&self) -> &'static str {
        let auth = read(&self.codex_home().join("auth.json"))
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok());
        if auth.as_ref().is_some_and(|v| {
            v["tokens"]["access_token"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        }) {
            "chatgpt"
        } else if auth
            .as_ref()
            .is_some_and(|v| v["OPENAI_API_KEY"].as_str().is_some_and(|s| !s.is_empty()))
        {
            "api-key"
        } else {
            "unknown"
        }
    }
    // Trace can observe an existing client connection without importing it into Deck.
    pub(super) fn client_codex(&self) -> Result<Option<Provider>> {
        let mut config = self.config()?;
        if let Some(gateway) = self.gateway.as_ref().filter(|g| g.codex_official) {
            config = doc(&restore_codex_fields(
                &config.to_string(),
                &gateway.before,
                &gateway.managed,
                true,
            )?)?;
        }
        let id = config
            .get("model_provider")
            .and_then(Item::as_str)
            .unwrap_or("openai");
        if id == "openai"
            || (id == "xwx_deck" && self.settings.codex_enhancements["unifySessionHistory"] == true)
        {
            return self.official_codex();
        }
        let table = config
            .get("model_providers")
            .and_then(|v| v.get(id))
            .ok_or("当前 Codex 服务缺少配置，请在客户端补齐后重试")?;
        let base = table
            .get("base_url")
            .and_then(Item::as_str)
            .filter(|s| !s.trim().is_empty())
            .ok_or("当前 Codex 服务缺少 API 地址，请在客户端补齐后重试")?;
        let url = reqwest::Url::parse(base).map_err(|_| "当前 Codex API 地址无效，原配置已保留")?;
        if !["http", "https"].contains(&url.scheme())
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("当前 Codex API 地址无效，原配置已保留".into());
        }
        if [Some("127.0.0.1"), Some("localhost"), Some("::1")].contains(&url.host_str())
            && !std::env::args().any(|a| a == "--rpc" || a == "--smoke")
        {
            return Err("当前 Codex 仍依赖其他本地代理，配置已保留；请在模型页选择目标服务并备份接管，再重启 Codex 后打开原会话".into());
        }
        let wire = table
            .get("wire_api")
            .and_then(Item::as_str)
            .unwrap_or("responses");
        if !["responses", "chat"].contains(&wire) {
            return Err("当前 Codex 协议暂不支持 Trace，原配置已保留".into());
        }
        Ok(Some(Provider {
            id: "client-codex".into(),
            codex_provider_id: id.into(),
            display_name: table
                .get("name")
                .and_then(Item::as_str)
                .unwrap_or(id)
                .into(),
            base_url: base.trim_end_matches('/').into(),
            adapter: if wire == "chat" {
                "chat-completions"
            } else {
                "responses"
            }
            .into(),
            codex_api_format: if wire == "chat" {
                "chat-completions"
            } else {
                "responses"
            }
            .into(),
            codex_model: config
                .get("model")
                .and_then(Item::as_str)
                .unwrap_or("")
                .into(),
            // The CLI supplies its existing auth header; never borrow an official account.
            official: true,
            ..Provider::default()
        }))
    }
    pub(super) fn official_codex(&self) -> Result<Option<Provider>> {
        if !self.config_path().exists() && !self.codex_home().join("auth.json").exists() {
            return Ok(None);
        }
        let mut config = self.config()?;
        if let Some(gateway) = self.gateway.as_ref().filter(|g| g.codex_official) {
            // Read the direct route while our own temporary override is active.
            // The existing restore merge keeps newer unrelated/client edits.
            config =
                restore_codex_fields(&config.to_string(), &gateway.before, &gateway.managed, true)?
                    .parse::<DocumentMut>()
                    .map_err(err)?;
        }
        let active = config
            .get("model_provider")
            .and_then(Item::as_str)
            .unwrap_or("openai");
        if active != "openai"
            && !(active == "xwx_deck"
                && self.settings.codex_enhancements["unifySessionHistory"] == true)
        {
            return Err("外部 Codex 连接已保留，请在设置中明确选择服务后接管".into());
        }
        let auth = read(&self.codex_home().join("auth.json"))?
            .map(|s| {
                serde_json::from_str::<Value>(&s)
                    .map_err(|_| "auth.json 损坏，登录状态已保留".to_string())
            })
            .transpose()?
            .unwrap_or(Value::Null);
        if auth["tokens"]["access_token"]
            .as_str()
            .is_none_or(str::is_empty)
            && auth["OPENAI_API_KEY"].as_str().is_none_or(str::is_empty)
            && !["openai_base_url", "chatgpt_base_url"].iter().any(|key| {
                config
                    .get(key)
                    .and_then(Item::as_str)
                    .is_some_and(|v| !v.is_empty())
            })
            && !(active == "xwx_deck"
                && self.settings.codex_enhancements["unifySessionHistory"] == true)
        {
            return Ok(None);
        }
        let oauth = auth["tokens"]["access_token"]
            .as_str()
            .is_some_and(|s| !s.is_empty());
        // A saved provider table can outlive the user's selection. Only the
        // active unified-history provider may supply the official model route.
        let provider_base = (active == "xwx_deck")
            .then(|| config.get("model_providers"))
            .flatten()
            .and_then(|v| v.get("xwx_deck"))
            .and_then(|v| v.get("base_url"))
            .and_then(Item::as_str)
            .map(|s| s.trim_end_matches("/codex"));
        let base = config
            .get("openai_base_url")
            .and_then(Item::as_str)
            .or(provider_base)
            .or_else(|| {
                oauth
                    .then(|| config.get("chatgpt_base_url").and_then(Item::as_str))
                    .flatten()
            })
            .filter(|s| !s.is_empty())
            .unwrap_or(if oauth {
                "https://chatgpt.com/backend-api"
            } else {
                "https://api.openai.com/v1"
            });
        let url = reqwest::Url::parse(base).map_err(err)?;
        if [Some("127.0.0.1"), Some("localhost")].contains(&url.host_str())
            && !std::env::args().any(|a| a == "--rpc" || a == "--smoke")
        {
            return Err("当前 Codex 仍依赖其他本地代理，配置已保留；请在模型页选择目标服务并备份接管，再重启 Codex 后打开原会话".into());
        }
        let token = auth["tokens"]["access_token"]
            .as_str()
            .or_else(|| auth["OPENAI_API_KEY"].as_str())
            .unwrap_or("");
        Ok(Some(Provider {
            other: Default::default(),
            id: "openai".into(),
            codex_provider_id: "openai".into(),
            display_name: "ChatGPT".into(),
            provider_preset: "auto".into(),
            base_url: base.trim_end_matches('/').into(),
            subscription_account_id: String::new(),
            account_label: String::new(),
            bearer_token: token.into(),
            adapter: "responses".into(),
            codex_api_format: "responses".into(),
            codex_model: config
                .get("model")
                .and_then(Item::as_str)
                .unwrap_or("")
                .into(),
            codex_context_window: 0,
            claude_models: json!({}),
            official: true,
            oauth,
        }))
    }
    pub(super) fn official_claude(&self) -> Result<Option<Provider>> {
        if !self.claude_path().exists() {
            return Ok(None);
        }
        let mut config = self.claude_config()?;
        if let Some((before, managed)) = self.gateway.as_ref().and_then(|g| g.claude.as_ref()) {
            config = self.check_claude_restore_source(&config.to_string(), before, managed)?;
        }
        let configured = [
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
        ]
        .iter()
        .any(|key| {
            config["env"][key]
                .as_str()
                .is_some_and(|v| !v.trim().is_empty())
        });
        let logged_in = read(&self.claude_dir().join(".credentials.json"))?
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .is_some_and(|v| {
                v["claudeAiOauth"]["accessToken"]
                    .as_str()
                    .is_some_and(|t| !t.is_empty())
            });
        if !configured && !logged_in {
            return Ok(None);
        }
        let base = config["env"]["ANTHROPIC_BASE_URL"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("https://api.anthropic.com");
        let url = reqwest::Url::parse(base).map_err(err)?;
        if !["http", "https"].contains(&url.scheme())
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("无效 Claude API 地址，配置已保留".into());
        }
        if [Some("127.0.0.1"), Some("localhost")].contains(&url.host_str())
            && !std::env::args().any(|a| a == "--rpc" || a == "--smoke")
        {
            return Err("Claude 依赖其他本地代理，请先恢复直连".into());
        }
        Ok(Some(Provider {
            other: Default::default(),
            id: "anthropic".into(),
            codex_provider_id: "anthropic".into(),
            display_name: "Claude".into(),
            provider_preset: "auto".into(),
            base_url: base.trim_end_matches('/').into(),
            subscription_account_id: String::new(),
            account_label: String::new(),
            bearer_token: String::new(),
            adapter: "anthropic-messages".into(),
            codex_api_format: "anthropic-messages".into(),
            codex_model: String::new(),
            codex_context_window: 0,
            claude_models: json!({}),
            official: true,
            oauth: false,
        }))
    }
    pub(super) fn selected_for(&self, client: &str) -> Option<&Provider> {
        self.settings.selected[client]
            .as_str()
            .and_then(|id| self.settings.connections.iter().find(|p| p.id == id))
    }
    pub(super) fn claude_path(&self) -> PathBuf {
        self.resolve_claude_path()
            .unwrap_or_else(|_| self.claude_dir().join("settings.json"))
    }
    pub(super) fn resolve_claude_path(&self) -> Result<PathBuf> {
        if let Some(gateway) = self.gateway.as_ref().filter(|g| g.claude.is_some()) {
            return Ok(gateway.claude_path.clone());
        }
        let directory = self.claude_dir();
        for name in ["gateway-recovery.json", "claude-direct.json"] {
            if let Some(source) = read(&self.root.join(name))? {
                let ledger: Value =
                    serde_json::from_str(&source).map_err(|_| "Claude 路径账本损坏，配置已保留")?;
                if name == "gateway-recovery.json" && !ledger["claude"].is_array() {
                    continue;
                }
                // Older native journals always wrote settings.json. Do not
                // accidentally apply their recovery to a different legacy file.
                let path = ledger["claudeConfigPath"]
                    .as_str()
                    .map(PathBuf::from)
                    .unwrap_or_else(|| directory.join("settings.json"));
                if path.parent() != Some(directory.as_path())
                    || ![
                        Some(std::ffi::OsStr::new("settings.json")),
                        Some(std::ffi::OsStr::new("claude.json")),
                    ]
                    .contains(&path.file_name())
                {
                    return Err(
                        "Claude 恢复账本指向其他目录，原文件已保留；请恢复原配置目录后重试".into(),
                    );
                }
                return Ok(path);
            }
        }
        let current = directory.join("settings.json");
        let legacy = directory.join("claude.json");
        let present = |path: &Path| -> Result<bool> {
            match fs::symlink_metadata(path) {
                Ok(_) => Ok(true),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(error) => Err(err(error)),
            }
        };
        Ok(if present(&current)? || !present(&legacy)? {
            current
        } else {
            legacy
        })
    }
    pub(super) fn claude_config(&self) -> Result<Value> {
        let source = read(&self.resolve_claude_path()?)?.unwrap_or_else(|| "{}".into());
        Self::parse_claude_config(&source)
    }
    fn parse_claude_config(source: &str) -> Result<Value> {
        let value: Value = serde_json::from_str(if source.trim().is_empty() {
            "{}"
        } else {
            source
        })
        .map_err(err)?;
        if !value.is_object() || value.get("env").is_some_and(|v| !v.is_object()) {
            return Err("Claude 配置损坏，原文件已保留".into());
        }
        Ok(value)
    }
    pub(super) fn claude_models(&self) -> Value {
        self.selected_for("claude")
            .map(|p| p.claude_models.clone())
            .unwrap_or_else(|| self.settings.claude_models.clone())
    }
    pub(super) fn claude_service(&self) -> Result<Value> {
        let config = self.claude_config()?;
        let actual = config["env"]["ANTHROPIC_BASE_URL"].as_str().unwrap_or("");
        let expected = self
            .selected_for("claude")
            .map(|p| p.base_url.trim_end_matches("/v1"))
            .unwrap_or("");
        let managed = read(&self.root.join("claude-direct.json"))?
            .map(|s| serde_json::from_str::<Value>(&s).map_err(err))
            .transpose()?;
        let drifted = managed.as_ref().is_some_and(|m| {
            CLAUDE_KEYS
                .iter()
                .any(|key| config["env"].get(*key) != m["managed"]["env"].get(*key))
        });
        let enabled = managed.is_some();
        Ok(
            json!({"enabled":enabled,"configPath":self.claude_path(),"status":if drifted {"drifted"}else if enabled {"active"}else{"disabled"},"actualBaseUrl":actual,"expectedBaseUrl":expected,"traceManaged":self.active()&&self.selected_for("claude").is_some(),"liveBaseUrl":actual}),
        )
    }
    pub(super) fn check_claude_restore(&self, before: &str, managed: &str) -> Result<Value> {
        let source = read(&self.resolve_claude_path()?)?.unwrap_or_default();
        self.check_claude_restore_source(&source, before, managed)
    }
    pub(super) fn check_claude_restore_source(
        &self,
        source: &str,
        before: &str,
        managed: &str,
    ) -> Result<Value> {
        let previous: Value = if before.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(before).map_err(err)?
        };
        let expected: Value = serde_json::from_str(managed).map_err(err)?;
        let mut current: Value = serde_json::from_str(if source.trim().is_empty() {
            "{}"
        } else {
            source
        })
        .map_err(err)?;
        if !current.is_object() || current.get("env").is_some_and(|value| !value.is_object()) {
            return Err("Claude 配置损坏，原文件已保留".into());
        }
        for key in CLAUDE_KEYS {
            if previous["env"].get(*key) == expected["env"].get(*key)
                && !matches!(
                    *key,
                    "ANTHROPIC_BASE_URL" | "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY"
                )
            {
                continue;
            }
            if current["env"].get(*key) != expected["env"].get(*key)
                && current["env"].get(*key) != previous["env"].get(*key)
            {
                return Err(format!(
                    "外部 Claude 配置变化已保留：{key}；Gateway 继续运行"
                ));
            }
        }
        if let Some(env) = current.get_mut("env").and_then(Value::as_object_mut) {
            for key in CLAUDE_KEYS {
                if previous["env"].get(*key) == expected["env"].get(*key) {
                    continue;
                }
                if let Some(v) = previous["env"].get(*key) {
                    env.insert((*key).into(), v.clone());
                } else {
                    env.remove(*key);
                }
            }
            if env.is_empty() && previous.get("env").is_none() {
                current.as_object_mut().unwrap().remove("env");
            }
        }
        Ok(current)
    }
    pub(super) fn write_claude_direct(&self, takeover: bool) -> Result<()> {
        let path = self.resolve_claude_path()?;
        self.write_claude_direct_at(&path, takeover)
    }
    fn write_claude_direct_at(&self, path: &Path, takeover: bool) -> Result<()> {
        let expected = read(path)?.unwrap_or_default();
        let mut current = Self::parse_claude_config(&expected)?;
        let accepted_subscription =
            self.subscription_route_accepted("claude", &current.to_string())?;
        let journal = self.root.join("claude-direct.json");
        let existing = read(&journal)?
            .map(|s| serde_json::from_str::<Value>(&s).map_err(err))
            .transpose()?;
        if let Some(ref ledger) = existing {
            if !accepted_subscription && !takeover {
                // Detect drift before replacing the user's current intent.
                self.check_claude_restore(
                    &ledger["before"].to_string(),
                    &ledger["managed"].to_string(),
                )?;
            }
        } else {
            let base = current["env"]["ANTHROPIC_BASE_URL"].as_str().unwrap_or("");
            let retained = self.selected_for("claude").is_some_and(|p| {
                base.trim_end_matches('/') == Self::claude_base(p)
                    && (current["env"]["ANTHROPIC_AUTH_TOKEN"] == p.bearer_token
                        || current["env"]["ANTHROPIC_API_KEY"] == p.bearer_token)
            });
            if !base.is_empty()
                && !base.starts_with("https://api.anthropic.com")
                && !retained
                && !takeover
                && !accepted_subscription
            {
                return Err("外部 Claude 配置变化已保留，请确认接管后重试".into());
            }
        }
        if takeover {
            self.backup_client_repair("claude", &expected)?;
        }
        if self
            .selected_for("claude")
            .is_some_and(|p| !p.subscription_account_id.is_empty())
        {
            return self.remember_subscription_route("claude", &current.to_string());
        }
        if let Some(p) = self
            .selected_for("claude")
            .filter(|p| !self.needs_gateway(p, "claude"))
        {
            let before = existing
                .as_ref()
                .map(|j| j["before"].clone())
                .unwrap_or_else(|| current.clone());
            if current.get("env").is_none() {
                current["env"] = json!({});
            }
            let env = current["env"].as_object_mut().unwrap();
            for key in CLAUDE_KEYS {
                env.remove(*key);
            }
            env.insert("ANTHROPIC_BASE_URL".into(), json!(Self::claude_base(p)));
            env.insert("ANTHROPIC_AUTH_TOKEN".into(), json!(p.bearer_token));
            for role in ["fable", "opus", "sonnet", "haiku"] {
                if let Some(model) = p.claude_models[role].as_str().filter(|s| !s.is_empty()) {
                    for suffix in ["MODEL", "MODEL_NAME"] {
                        env.insert(
                            format!("ANTHROPIC_DEFAULT_{}_{suffix}", role.to_uppercase()),
                            json!(model),
                        );
                    }
                }
            }
            write(
                &journal,
                &json!({"before":before,"managed":current,"claudeConfigPath":path}).to_string(),
            )?;
            write_checked(
                path,
                &expected,
                &serde_json::to_string_pretty(&current).map_err(err)?,
            )?;
        } else if let Some(ledger) = existing {
            current = if takeover {
                serde_json::from_str(&client_repair::claude_owned(
                    &expected,
                    &ledger["before"].to_string(),
                )?)
                .map_err(err)?
            } else {
                self.check_claude_restore(
                    &ledger["before"].to_string(),
                    &ledger["managed"].to_string(),
                )?
            };
            write_checked(
                path,
                &expected,
                &serde_json::to_string_pretty(&current).map_err(err)?,
            )?;
            fs::remove_file(journal).map_err(err)?;
        }
        Ok(())
    }
    pub(super) fn claude_managed(
        &self,
        port: u16,
        path: &Path,
    ) -> Result<Option<(String, String)>> {
        if !self.client_enabled("claude")
            || (self.selected_for("claude").is_none() && self.official_claude()?.is_none())
        {
            return Ok(None);
        }
        if self.selected_for("claude").is_some() {
            self.write_claude_direct_at(path, false)?;
        }
        let before_source = read(path)?.unwrap_or_default();
        let before: Value = if before_source.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&before_source).map_err(|_| "Claude 配置损坏，原文件已保留")?
        };
        if !before.is_object() || before.get("env").is_some_and(|v| !v.is_object()) {
            return Err("Claude 配置损坏，原文件已保留".into());
        }
        let mut managed = before.clone();
        if let Some(p) = self.selected_for("claude") {
            if managed.get("env").is_none() {
                managed["env"] = json!({});
            }
            managed["env"]
                .as_object_mut()
                .ok_or("Claude env 必须为对象")?
                .remove("ANTHROPIC_API_KEY");
            managed["env"]["ANTHROPIC_AUTH_TOKEN"] =
                json!(if p.subscription_account_id.is_empty() {
                    p.bearer_token.as_str()
                } else {
                    "xwxdeck-local-subscription"
                });
            for role in ["fable", "opus", "sonnet", "haiku"] {
                if let Some(model) = p.claude_models[role].as_str().filter(|s| !s.is_empty()) {
                    managed["env"][format!("ANTHROPIC_DEFAULT_{}_MODEL", role.to_uppercase())] =
                        json!(model);
                }
            }
        }
        managed["env"]["ANTHROPIC_BASE_URL"] =
            json!(format!("http://127.0.0.1:{port}/_xwx/claude"));
        Ok(Some((before_source, managed.to_string())))
    }
    pub(super) fn env_overrides(&self) -> Value {
        let mut keys = CLAUDE_KEYS.to_vec();
        keys.extend([
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
        ]);
        let overrides: Vec<_> = keys
            .iter()
            .filter(|k| std::env::var(k).is_ok_and(|v| !v.is_empty()))
            .map(|k| json!({"name":k,"scopes":["process"],"canRemoveAutomatically":false}))
            .collect();
        json!({"platform":"other","overrides":overrides,"canRemoveAutomatically":false})
    }
    pub(super) fn claude_base(p: &Provider) -> String {
        Self::provider_api_root(p).trim_end_matches("/v1").into()
    }
    pub(super) fn api_root(base: &str) -> String {
        let base = base.trim_end_matches('/');
        for suffix in [
            "/chat/completions",
            "/responses/compact",
            "/responses",
            "/messages",
        ] {
            if let Some(root) = base.strip_suffix(suffix) {
                return root.into();
            }
        }
        base.into()
    }
    pub(super) fn provider_api_root(provider: &Provider) -> String {
        Self::api_root(&provider.base_url)
    }
    pub(super) fn cache_path(&self, provider: &Provider) -> PathBuf {
        provider_cache(&self.root, provider)
    }
    pub(super) async fn catalog(&self, provider: &Provider) -> Result<Value> {
        if !provider.subscription_account_id.is_empty() {
            return self.subscriptions.model_catalog(provider).await;
        }
        self.catalog_single(provider).await
    }
    async fn catalog_single(&self, provider: &Provider) -> Result<Value> {
        if !provider.subscription_account_id.is_empty() {
            return subscription_catalog(&self.subscriptions, &self.root, provider).await;
        }
        let cache = self.cache_path(provider);
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3))
            .build()
            .map_err(err)?;
        let base = Self::provider_api_root(provider);
        let mut endpoints = vec![format!("{base}/models")];
        let version = base.rsplit('/').next().is_some_and(|s| {
            s.strip_prefix('v')
                .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
        });
        if !version {
            endpoints.push(format!("{base}/v1/models"));
        }
        let mut error = "未取得模型目录".to_string();
        for endpoint in endpoints {
            let fetched=async {
                let mut request=client.get(endpoint).header("anthropic-version","2023-06-01");
                if !provider.bearer_token.is_empty(){request=request.bearer_auth(&provider.bearer_token).header("x-api-key",&provider.bearer_token);}
                let response=request.send().await.map_err(|_|"模型目录请求失败".to_string())?.error_for_status().map_err(|e|format!("模型目录 HTTP {}",e.status().map(|s|s.as_u16()).unwrap_or(0)))?;
                let bytes=response.bytes().await.map_err(err)?;if bytes.len()>8*1024*1024{return Err("模型目录超过 8 MB 上限".into());}
                let body:Value=serde_json::from_slice(&bytes).map_err(|_|"无效模型目录 JSON".to_string())?;
                let rows=body["data"].as_array().or_else(||body.as_array()).ok_or("无效模型列表")?;
                let official=catalog::official_protocol_registry();
                let entries:Vec<_>=rows.iter().filter_map(|m|m["id"].as_str().map(|id|{
                    let known=official.as_array().unwrap().iter().find(|e|text(e,"modelId").eq_ignore_ascii_case(id)).or_else(||official.as_array().unwrap().iter().find(|e|catalog::official_model_key(text(e,"modelId"))==catalog::official_model_key(id)));
                    let explicit=match provider.adapter.as_str(){"responses"=>Some("openai-responses"),"chat-completions"=>Some("chat-completions"),"anthropic-messages"=>Some("anthropic-messages"),_=>None};
                    let declared=m["protocols"].as_array().or_else(||m["supported_endpoint_types"].as_array()).map(|values|values.iter().filter_map(|v|v.as_str()).filter_map(|s|match s {"responses"|"openai-responses"=>Some("openai-responses"),"chat"|"chat-completions"|"chat_completion"=>Some("chat-completions"),"anthropic"|"messages"|"anthropic-messages"=>Some("anthropic-messages"),_=>None}).map(|s|json!(s)).collect::<Vec<_>>()).filter(|a|!a.is_empty());
                    let protocols=if let Some(p)=explicit{json!([p])}else if let Some(p)=declared.clone(){json!(p)}else if let Some(e)=known{e["protocols"].clone()}else{json!(["openai-responses","chat-completions","anthropic-messages"])};
                    let mut result=json!({"id":id,"vendor":m["owned_by"].as_str().or_else(||known.and_then(|e|e["vendor"].as_str())).unwrap_or("custom"),"protocols":protocols,"protocolsDeclared":explicit.is_some()||declared.is_some()||known.is_some(),"clients":["codex","claude"]});
                    merge_known_capability(&mut result, m, known);
                    for (source,key) in [("context_length","contextWindow"),("max_output_tokens","maxOutputTokens")] {if let Some(v)=m.get(source).filter(|v|v.is_u64()){result[key]=v.clone();}}
                    result
                })).collect();
                let result=json!(entries);write(&cache,&json!({"baseUrl":provider.base_url,"adapter":provider.adapter,"entries":result}).to_string())?;Ok::<_,String>(result)
            }.await;
            match fetched {
                Ok(v) => return Ok(v),
                Err(e) => error = e,
            }
        }
        if let Some(source) = read(&cache)? {
            let cached: Value = serde_json::from_str(&source).map_err(err)?;
            if cached["baseUrl"] == provider.base_url && cached["adapter"] == provider.adapter {
                return Ok(cached["entries"].clone());
            }
        }
        if let Some(models) = self
            .settings
            .other
            .get("importedProviderModels")
            .and_then(|v| v.get(&provider.id))
            .and_then(Value::as_array)
        {
            return Ok(json!(models.iter().filter_map(Value::as_str).map(|id|json!({"id":id,"vendor":"导入配置","protocols":[if provider.adapter=="responses"{"openai-responses"}else{provider.adapter.as_str()}],"protocolsDeclared":true,"clients":["codex","claude"]})).collect::<Vec<_>>()));
        }
        Err(error)
    }
    pub(super) async fn validate(&self, id: &str, requested_model: Option<&str>) -> Result<Value> {
        let p = self
            .settings
            .connections
            .iter()
            .find(|p| p.id == id)
            .ok_or("连接不存在")?;
        validate_provider(
            self.root.clone(),
            p.clone(),
            requested_model.map(str::to_owned),
        )
        .await
    }
}

fn validation_has_text(value: &Value) -> bool {
    let text = |value: &Value| value.as_str().is_some_and(|s| !s.trim().is_empty());
    let content = |value: &Value| {
        text(value)
            || value
                .as_array()
                .is_some_and(|parts| parts.iter().any(|part| text(&part["text"])))
    };
    content(&value["content"])
        || text(&value["output_text"])
        || value["output"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| content(&item["content"])))
        || value["choices"].as_array().is_some_and(|choices| {
            choices
                .iter()
                .any(|choice| content(&choice["message"]["content"]))
        })
        || value["candidates"].as_array().is_some_and(|candidates| {
            candidates.iter().any(|candidate| {
                candidate["content"]["parts"]
                    .as_array()
                    .is_some_and(|parts| {
                        parts
                            .iter()
                            .any(|part| part["thought"] != true && text(&part["text"]))
                    })
            })
        })
}

fn validation_refused(value: &Value) -> bool {
    value["stop_reason"] == "refusal"
        || value["promptFeedback"]["blockReason"]
            .as_str()
            .is_some_and(|reason| !reason.is_empty() && reason != "BLOCK_REASON_UNSPECIFIED")
        || value["candidates"].as_array().is_some_and(|candidates| {
            candidates.iter().any(|candidate| {
                [
                    "SAFETY",
                    "RECITATION",
                    "BLOCKLIST",
                    "PROHIBITED_CONTENT",
                    "SPII",
                    "IMAGE_SAFETY",
                ]
                .contains(&text(candidate, "finishReason"))
            })
        })
        || value["choices"].as_array().is_some_and(|choices| {
            choices.iter().any(|choice| {
                choice["finish_reason"] == "content_filter"
                    || !choice["message"]["refusal"].is_null()
            })
        })
        || value["output"].as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item["content"]
                    .as_array()
                    .is_some_and(|parts| parts.iter().any(|part| part["type"] == "refusal"))
            })
        })
}

// Only recognized error codes become UI reasons. Never return upstream text,
// which may contain credentials, account identifiers or request details.
fn validation_http_failure(status: u16, value: &Value) -> Option<&'static str> {
    if status != 404 {
        return None;
    }
    Some(match text(&value["error"], "code") {
        "ModelNotOpen" => "model-not-enabled",
        "InvalidEndpointOrModel.ModelIDAccessDisabled" => "endpoint-required",
        "InvalidEndpointOrModel.NotFound" => "model-not-found",
        "PathNotFound" | "InvalidAction" => "endpoint-not-found",
        _ => "not-found",
    })
}

async fn validation_body(response: reqwest::Response) -> Option<Value> {
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut bytes = vec![];
    while let Some(part) = stream.next().await {
        let chunk = part.ok()?;
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return None;
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).ok()
}

pub(super) async fn validate_provider(
    root: PathBuf,
    provider: Provider,
    requested: Option<String>,
) -> Result<Value> {
    let p = &provider;
    let requested_model = requested.as_deref();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(err)?;
    let model = if let Some(model) = requested_model {
        model
    } else if !p.codex_model.is_empty() {
        p.codex_model.as_str()
    } else {
        p.claude_models["sonnet"].as_str().unwrap_or("")
    };
    let wire = resolve_wire(&root, p, Some(model), "responses");
    let base = Pilot::provider_api_root(p);
    let messages = if base.rsplit('/').next().is_some_and(|s| {
        s.strip_prefix('v')
            .is_some_and(|n| n.chars().all(|c| c.is_ascii_digit()))
    }) {
        "messages"
    } else {
        "v1/messages"
    };
    let (endpoint, body) = match wire.as_str() {
        "chat-completions" => (
            "chat/completions".to_owned(),
            json!({"model":model,"messages":[{"role":"user","content":"What is 2 + 2?"}],"max_tokens":256}),
        ),
        "anthropic-messages" => (
            messages.to_owned(),
            json!({"model":model,"messages":[{"role":"user","content":"What is 2 + 2?"}],"max_tokens":256}),
        ),
        "gemini" => {
            let encoded = model
                .bytes()
                .map(|b| {
                    if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                        (b as char).to_string()
                    } else {
                        format!("%{b:02X}")
                    }
                })
                .collect::<String>();
            (
                format!("models/{encoded}:generateContent"),
                json!({"contents":[{"role":"user","parts":[{"text":"What is 2 + 2?"}]}],"generationConfig":{"maxOutputTokens":256}}),
            )
        }
        _ => (
            "responses".to_owned(),
            json!({"model":model,"input":"What is 2 + 2?","max_output_tokens":256}),
        ),
    };
    let mut request = if model.is_empty() {
        client.get(format!("{base}/models"))
    } else {
        client.post(format!("{base}/{endpoint}")).json(&body)
    };
    if !p.bearer_token.is_empty() {
        request = request
            .bearer_auth(&p.bearer_token)
            .header("x-api-key", &p.bearer_token);
        if wire == "gemini" {
            request = request.header("x-goog-api-key", &p.bearer_token);
        }
    }
    let response = request
        .header("anthropic-version", "2023-06-01")
        .send()
        .await;
    // Expose only safe outcome metadata, never upstream bodies or credential-bearing errors.
    let http_status = response.as_ref().ok().map(|r| r.status().as_u16());
    let mut failure_reason = response.as_ref().err().map(|error| {
        if error.is_timeout() {
            "timeout"
        } else if error.is_connect() {
            "connect"
        } else {
            "transport"
        }
    });
    let mut observed = Value::Null;
    let status = match response {
        Ok(r) if r.status().is_success() => {
            let value = validation_body(r).await;
            observed = value.clone().unwrap_or(Value::Null);
            if value.as_ref().is_none_or(|v| {
                !v["error"].is_null()
                    || v["type"] == "error"
                    || ["failed", "incomplete", "cancelled", "in_progress", "queued"]
                        .contains(&text(v, "status"))
            }) {
                "unavailable"
            } else if model.is_empty() {
                "reachable"
            } else if value.as_ref().is_some_and(validation_refused) {
                failure_reason = Some("refused");
                "model-error"
            } else if value.as_ref().is_some_and(validation_has_text) {
                "valid"
            } else {
                failure_reason = Some("empty-response");
                "unavailable"
            }
        }
        Ok(r) => {
            let code = r.status().as_u16();
            observed = validation_body(r).await.unwrap_or(Value::Null);
            failure_reason = validation_http_failure(code, &observed);
            if [401, 403].contains(&code) {
                "authentication-error"
            } else if code == 400
                || super::retired_models::definite(code, &observed)
                || matches!(
                    failure_reason,
                    Some("model-not-enabled" | "endpoint-required" | "model-not-found")
                )
            {
                "model-error"
            } else {
                "unavailable"
            }
        }
        _ => "unavailable",
    };
    super::retired_models::observe(
        &root,
        &p.id,
        &catalog::identity(p),
        model,
        http_status.unwrap_or(0),
        &observed,
        status == "valid" && super::retired_models::successful(&wire, &observed),
    )?;
    Ok(
        json!({"status":status,"providerId":p.id,"providerName":p.display_name,
        "protocol":wire,"httpStatus":http_status,"failureReason":failure_reason}),
    )
}

fn merge_known_capability(result: &mut Value, service: &Value, known: Option<&Value>) {
    for key in [
        "contextWindow",
        "maxOutputTokens",
        "vision",
        "reasoning",
        "toolCalling",
        "structuredOutput",
        "interleavedThinking",
        "inputModalities",
        "reasoningLevels",
        "defaultReasoningLevel",
    ] {
        if matches!(key, "reasoningLevels" | "defaultReasoningLevel")
            && result["reasoning"] == false
        {
            continue;
        }
        let official_key = match key {
            "reasoningLevels" => "levels",
            "defaultReasoningLevel" => "defaultLevel",
            _ => key,
        };
        if let Some(value) = service
            .get(key)
            .or_else(|| known.and_then(|entry| entry["capability"].get(official_key)))
        {
            result[key] = value.clone();
        }
    }
}

#[cfg(test)]
mod subscription_metadata_tests {
    use super::*;
    #[test]
    fn raw_subscription_facts_survive_normalization() {
        let raw = json!({"context_window":500000,"input_modalities":["text","image"],"reasoning":true,"supported_reasoning_levels":[{"effort":"high"}],"tool_calling":false});
        let entry = catalog::with_service_metadata(
            json!({"id":"exact-model","protocols":["openai-responses"]}),
            &raw,
        );
        assert_eq!(entry["providerCapabilities"]["contextWindow"], 500000);
        assert_eq!(
            entry["providerCapabilities"]["inputModalities"],
            json!(["text", "image"])
        );
        assert_eq!(entry["providerCapabilities"]["levels"], json!(["high"]));
        assert_eq!(entry["id"], "exact-model");
        assert_eq!(entry["protocols"], json!(["openai-responses"]));
    }

    #[test]
    fn official_level_aliases_fill_missing_service_facts() {
        let mut entry = json!({});
        merge_known_capability(
            &mut entry,
            &json!({"reasoning":true}),
            Some(&json!({"capability":{
                "levels":["none","low","high","max"],
                "defaultLevel":"high"
            }})),
        );
        assert_eq!(
            entry["reasoningLevels"],
            json!(["none", "low", "high", "max"])
        );
        assert_eq!(entry["defaultReasoningLevel"], "high");
    }
}
