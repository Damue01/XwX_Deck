use super::*;
const CLAUDE_KEYS: &[&str] = &[
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

impl Pilot {
    pub(super) fn official_catalog(&self) -> Result<Value> {
        let cache = read(&self.codex_home().join("models_cache.json"))?
            .and_then(|s| serde_json::from_str::<Value>(&s).ok());
        let mut entries = vec![];
        for row in cache
            .as_ref()
            .and_then(|c| c["models"].as_array())
            .into_iter()
            .flatten()
        {
            let id = text(row, "slug");
            if id.is_empty() || row["visibility"] != "list" || row["supported_in_api"] != true {
                continue;
            }
            let mut entry = json!({"id":id,"vendor":"OpenAI","protocols":["openai-responses"],"clients":["codex"],"protocolsDeclared":true});
            if row["context_window"].as_u64().is_some_and(|n| n > 0) {
                entry["contextWindow"] = row["context_window"].clone();
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
        let config = self.config()?;
        let selected = config.get("model").and_then(Item::as_str).unwrap_or("");
        if !selected.is_empty() && !entries.iter().any(|e| e["id"] == selected) {
            entries.push(json!({"id":selected,"vendor":"已配置","protocols":["openai-responses"],"clients":["codex"]}));
        }
        Ok(json!(entries))
    }

    pub(super) fn recover_interrupted_gateway(&self) -> Result<()> {
        let file = self.root.join("gateway-recovery.json");
        let Some(source) = read(&file)? else {
            return Ok(());
        };
        let ledger: Value = serde_json::from_str(&source).map_err(err)?;
        let mut codex = None;
        if ledger["codexManaged"].as_bool().unwrap_or(true) {
            let expected = doc(ledger["managed"].as_str().ok_or("恢复账本损坏")?)?;
            let before = doc(ledger["before"].as_str().ok_or("恢复账本损坏")?)?;
            let mut current = self.config()?;
            for key in if ledger["codexOfficial"] == true {
                vec!["openai_base_url", "chatgpt_base_url"]
            } else {
                vec!["model", "model_provider"]
            } {
                if current.get(key).map(Item::to_string) != expected.get(key).map(Item::to_string) {
                    return Err("崩溃恢复遇到外部配置变化，原文件和恢复证据已保留".into());
                }
            }
            if (ledger["codexOfficial"] != true
                || expected.get("model_provider").and_then(Item::as_str) == Some("xwx_deck"))
                && current
                    .get("model_providers")
                    .and_then(|v| v.get("xwx_deck"))
                    .map(Item::to_string)
                    != expected
                        .get("model_providers")
                        .and_then(|v| v.get("xwx_deck"))
                        .map(Item::to_string)
            {
                return Err("崩溃恢复遇到外部服务配置变化，原文件和恢复证据已保留".into());
            }
            for key in if ledger["codexOfficial"] == true {
                vec!["openai_base_url", "chatgpt_base_url"]
            } else {
                vec!["model", "model_provider"]
            } {
                if let Some(v) = before.get(key) {
                    current[key] = v.clone();
                } else {
                    current.remove(key);
                }
            }
            if let Some(v) = before
                .get("model_providers")
                .and_then(|v| v.get("xwx_deck"))
            {
                current["model_providers"]["xwx_deck"] = v.clone();
            } else if let Some(table) = current
                .get_mut("model_providers")
                .and_then(Item::as_table_like_mut)
            {
                table.remove("xwx_deck");
                if table.is_empty() && before.get("model_providers").is_none() {
                    current.remove("model_providers");
                }
            }
            codex = Some(current.to_string());
        }
        let claude = if let Some(pair) = ledger["claude"].as_array() {
            Some(self.check_claude_restore(
                pair[0].as_str().ok_or("恢复账本损坏")?,
                pair[1].as_str().ok_or("恢复账本损坏")?,
            )?)
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
        if let Some(restored) = codex {
            write(&self.config_path(), &restored)?;
        }
        if let Some(restored) = claude {
            write(&self.claude_path(), &restored.to_string())?;
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
    pub(super) fn official_codex(&self) -> Result<Option<Provider>> {
        if !self.config_path().exists() && !self.codex_home().join("auth.json").exists() {
            return Ok(None);
        }
        let config = self.config()?;
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
        let oauth = auth["tokens"]["access_token"]
            .as_str()
            .is_some_and(|s| !s.is_empty());
        let provider_base = config
            .get("model_providers")
            .and_then(|v| v.get("xwx_deck"))
            .and_then(|v| v.get("base_url"))
            .and_then(Item::as_str)
            .map(|s| s.trim_end_matches("/codex"));
        let base = config
            .get("openai_base_url")
            .and_then(Item::as_str)
            .or(provider_base)
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
            return Err("当前 Codex 仍依赖其他本地代理，已保留配置；请先恢复直连".into());
        }
        let token = auth["tokens"]["access_token"]
            .as_str()
            .or_else(|| auth["OPENAI_API_KEY"].as_str())
            .unwrap_or("");
        Ok(Some(Provider {
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
        let config = self.claude_config()?;
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
        self.claude_dir().join("settings.json")
    }
    pub(super) fn claude_config(&self) -> Result<Value> {
        let source = read(&self.claude_path())?.unwrap_or_else(|| "{}".into());
        let value: Value = serde_json::from_str(&source).map_err(err)?;
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
        let previous: Value = serde_json::from_str(before).map_err(err)?;
        let expected: Value = serde_json::from_str(managed).map_err(err)?;
        let mut current = self.claude_config()?;
        for key in CLAUDE_KEYS {
            if current["env"].get(*key) != expected["env"].get(*key) {
                return Err(format!(
                    "外部 Claude 配置变化已保留：{key}；Gateway 继续运行"
                ));
            }
        }
        if let Some(env) = current.get_mut("env").and_then(Value::as_object_mut) {
            for key in CLAUDE_KEYS {
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
        let mut current = self.claude_config()?;
        let accepted_subscription =
            self.subscription_route_accepted("claude", &current.to_string())?;
        let journal = self.root.join("claude-direct.json");
        let existing = read(&journal)?
            .map(|s| serde_json::from_str::<Value>(&s).map_err(err))
            .transpose()?;
        if let Some(ref ledger) = existing {
            if !accepted_subscription
                && !(takeover
                    && self
                        .selected_for("claude")
                        .is_some_and(|p| !p.subscription_account_id.is_empty()))
            {
                // Detect drift before replacing the user's current intent.
                self.check_claude_restore(
                    &ledger["before"].to_string(),
                    &ledger["managed"].to_string(),
                )?;
            }
        } else {
            let base = current["env"]["ANTHROPIC_BASE_URL"].as_str().unwrap_or("");
            let retained = self.selected_for("claude").is_some_and(|p| {
                base.trim_end_matches('/')
                    == p.base_url.trim_end_matches("/v1").trim_end_matches('/')
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
        if self
            .selected_for("claude")
            .is_some_and(|p| !p.subscription_account_id.is_empty())
        {
            return self.remember_subscription_route("claude", &current.to_string());
        }
        if let Some(p) = self.selected_for("claude") {
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
            env.insert(
                "ANTHROPIC_BASE_URL".into(),
                json!(p.base_url.trim_end_matches("/v1")),
            );
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
                &json!({"before":before,"managed":current}).to_string(),
            )?;
            write(
                &self.claude_path(),
                &serde_json::to_string_pretty(&current).map_err(err)?,
            )?;
        } else if let Some(ledger) = existing {
            current = self.check_claude_restore(
                &ledger["before"].to_string(),
                &ledger["managed"].to_string(),
            )?;
            write(
                &self.claude_path(),
                &serde_json::to_string_pretty(&current).map_err(err)?,
            )?;
            fs::remove_file(journal).map_err(err)?;
        }
        Ok(())
    }
    pub(super) fn claude_managed(&self, port: u16) -> Result<Option<(String, String)>> {
        if !self.settings.client_enabled["claude"]
            .as_bool()
            .unwrap_or(true)
            || (self.selected_for("claude").is_none() && self.official_claude()?.is_none())
        {
            return Ok(None);
        }
        if self.selected_for("claude").is_some() {
            self.write_claude_direct(false)?;
        }
        let before = self.claude_config()?;
        let mut managed = before.clone();
        if let Some(p) = self
            .selected_for("claude")
            .filter(|p| !p.subscription_account_id.is_empty())
        {
            if managed.get("env").is_none() {
                managed["env"] = json!({});
            }
            managed["env"]
                .as_object_mut()
                .ok_or("Claude env 必须为对象")?
                .remove("ANTHROPIC_API_KEY");
            managed["env"]["ANTHROPIC_AUTH_TOKEN"] = json!("xwx-local-subscription");
            for role in ["fable", "opus", "sonnet", "haiku"] {
                if let Some(model) = p.claude_models[role].as_str().filter(|s| !s.is_empty()) {
                    managed["env"][format!("ANTHROPIC_DEFAULT_{}_MODEL", role.to_uppercase())] =
                        json!(model);
                }
            }
        }
        managed["env"]["ANTHROPIC_BASE_URL"] = json!(format!("http://127.0.0.1:{port}"));
        Ok(Some((before.to_string(), managed.to_string())))
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
    pub(super) fn cache_path(&self, provider: &Provider) -> PathBuf {
        self.root.join(format!(
            "provider-{}-models.json",
            &storage::digest(provider.id.as_bytes())[..24]
        ))
    }
    pub(super) async fn catalog(&self, provider: &Provider) -> Result<Value> {
        if !provider.subscription_account_id.is_empty() {
            let snapshot = self.subscriptions.snapshot().await;
            let lease = self.subscriptions.pool.choose(
                &provider.subscription_account_id,
                &snapshot,
                "",
                "",
                &std::collections::HashSet::new(),
            )?;
            let actual = self.subscriptions.provider(&lease.id).await?;
            let result = self.catalog_single(&actual).await?;
            self.subscriptions.pool.catalog(&lease.id, &result);
            return Ok(result);
        }
        self.catalog_single(provider).await
    }
    async fn catalog_single(&self, provider: &Provider) -> Result<Value> {
        if !provider.subscription_account_id.is_empty() {
            let body = self
                .subscriptions
                .catalog(&provider.subscription_account_id)
                .await?;
            if provider.subscription_account_id.starts_with("cursor-") {
                let rows = body["models"]
                    .as_array()
                    .ok_or("无效 Cursor 订阅模型目录")?;
                return Ok(json!(rows.iter().filter(|m|m["isHidden"]!=true&&m["isChatOnly"]!=true&&m["onlySupportsCmdK"]!=true&&m["supportsAgent"]!=false).filter_map(|m|m["name"].as_str().map(|id|json!({"id":if id=="default"{"auto"}else{id},"displayName":m["clientDisplayName"].as_str().unwrap_or(id),"vendor":"Cursor","protocols":["chat-completions"],"protocolsDeclared":true,"clients":["codex","claude"]}))).collect::<Vec<_>>()));
            }
            if provider
                .subscription_account_id
                .starts_with("claude-subscription-")
            {
                let rows = body["data"].as_array().ok_or("无效 Claude 订阅模型目录")?;
                return Ok(json!(rows.iter().filter_map(|m|m["id"].as_str().map(|id|json!({"id":id,"displayName":m["display_name"].as_str().unwrap_or(id),"vendor":"Anthropic","protocols":["anthropic-messages"],"protocolsDeclared":true,"clients":["codex","claude"]}))).collect::<Vec<_>>()));
            }
            if provider.subscription_account_id.starts_with("copilot-") {
                let rows = body["data"].as_array().ok_or("无效 Copilot 订阅模型目录")?;
                let entries:Vec<_>=rows.iter().filter(|m|copilot_accounts::CopilotAccounts::model_visible(m)).filter_map(|m|m["id"].as_str().map(|id| {
                    let endpoints=m["supported_endpoints"].as_array();
                    let mut protocols=vec![];
                    for endpoint in endpoints.into_iter().flatten().filter_map(Value::as_str) {match endpoint {"/responses"|"/v1/responses"=>protocols.push("openai-responses"),"/chat/completions"|"/v1/chat/completions"=>protocols.push("chat-completions"),"/messages"|"/v1/messages"=>protocols.push("anthropic-messages"),_=>{}}}
                    if protocols.is_empty(){protocols.push("chat-completions");}
                    json!({"id":id,"displayName":m["name"].as_str().unwrap_or(id),"vendor":"GitHub Copilot","protocols":protocols,"protocolsDeclared":true,"clients":["codex","claude"]})
                })).collect();
                write(&self.cache_path(provider),&json!({"baseUrl":provider.base_url,"adapter":provider.adapter,"entries":entries}).to_string())?;
                return Ok(json!(entries));
            }
            if provider.subscription_account_id.starts_with("grok-") {
                let rows = body["data"].as_array().ok_or("无效 Grok 订阅模型目录")?;
                return Ok(json!(rows.iter().filter_map(|m|m["id"].as_str().map(|id|json!({"id":id,"displayName":m["name"].as_str().unwrap_or(id),"vendor":"xai","protocols":["openai-responses"],"protocolsDeclared":true,"clients":["codex","claude"]}))).collect::<Vec<_>>()));
            }
            let rows = body["models"].as_array().ok_or("无效订阅模型目录")?;
            let entries:Vec<_>=rows.iter().filter(|m|m["visibility"]=="list").filter_map(|m|m["slug"].as_str().map(|id|json!({"id":id,"displayName":m["display_name"],"vendor":"openai","protocols":["openai-responses"],"protocolsDeclared":true,"clients":["codex","claude"]}))).collect();
            return Ok(json!(entries));
        }
        let cache = self.cache_path(provider);
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3))
            .build()
            .map_err(err)?;
        let base = Self::api_root(&provider.base_url);
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
                let official:Value=serde_json::from_str(include_str!("../../test-results/native-assets/official-models.json")).map_err(err)?;
                let entries:Vec<_>=rows.iter().filter_map(|m|m["id"].as_str().map(|id|{
                    let known=official.as_array().unwrap().iter().find(|e|e["modelId"]==id);
                    let explicit=match provider.adapter.as_str(){"responses"=>Some("openai-responses"),"chat-completions"=>Some("chat-completions"),"anthropic-messages"=>Some("anthropic-messages"),_=>None};
                    let declared=m["protocols"].as_array().or_else(||m["supported_endpoint_types"].as_array()).map(|values|values.iter().filter_map(|v|v.as_str()).filter_map(|s|match s {"responses"|"openai-responses"=>Some("openai-responses"),"chat"|"chat-completions"|"chat_completion"=>Some("chat-completions"),"anthropic"|"messages"|"anthropic-messages"=>Some("anthropic-messages"),_=>None}).map(|s|json!(s)).collect::<Vec<_>>()).filter(|a|!a.is_empty());
                    let protocols=if let Some(p)=explicit{json!([p])}else if let Some(p)=declared.clone(){json!(p)}else if let Some(e)=known{e["protocols"].clone()}else{json!(["openai-responses","chat-completions","anthropic-messages"])};
                    let mut result=json!({"id":id,"vendor":m["owned_by"].as_str().or_else(||known.and_then(|e|e["vendor"].as_str())).unwrap_or("custom"),"protocols":protocols,"protocolsDeclared":explicit.is_some()||declared.is_some()||known.is_some(),"clients":["codex","claude"]});
                    for key in ["contextWindow","maxOutputTokens","vision","reasoning","toolCalling","structuredOutput","interleavedThinking","inputModalities","reasoningLevels","defaultReasoningLevel"] {if let Some(v)=m.get(key).or_else(||known.and_then(|e|e["capability"].get(key))){result[key]=v.clone();}}
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
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(err)?;
        let model = if let Some(model) = requested_model {
            model
        } else if !p.codex_model.is_empty() {
            p.codex_model.as_str()
        } else {
            p.claude_models["sonnet"].as_str().unwrap_or("")
        };
        let wire = resolve_wire(&self.root, p, Some(model), "responses");
        let base = Self::api_root(&p.base_url);
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
                "chat/completions",
                json!({"model":model,"messages":[{"role":"user","content":"Reply OK"}],"max_tokens":1}),
            ),
            "anthropic-messages" => (
                messages,
                json!({"model":model,"messages":[{"role":"user","content":"Reply OK"}],"max_tokens":1}),
            ),
            _ => (
                "responses",
                json!({"model":model,"input":"Reply OK","max_output_tokens":16}),
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
        }
        let response = request
            .header("anthropic-version", "2023-06-01")
            .send()
            .await;
        let status = match response {
            Ok(r) if r.status().is_success() => {
                use futures_util::StreamExt;
                let mut stream = r.bytes_stream();
                let mut bytes = vec![];
                let mut failed = false;
                while let Some(part) = stream.next().await {
                    match part {
                        Ok(chunk) if bytes.len() + chunk.len() <= 2 * 1024 * 1024 => {
                            bytes.extend_from_slice(&chunk)
                        }
                        _ => {
                            failed = true;
                            break;
                        }
                    }
                }
                let value = serde_json::from_slice::<Value>(&bytes).ok();
                if failed
                    || value
                        .as_ref()
                        .is_none_or(|v| v.get("error").is_some() || v["type"] == "error")
                {
                    "unavailable"
                } else if model.is_empty() {
                    "reachable"
                } else if value.as_ref().is_some_and(|v| {
                    v.get("choices").is_some()
                        || v.get("output").is_some()
                        || v.get("content").is_some()
                }) {
                    "valid"
                } else {
                    "unavailable"
                }
            }
            Ok(r) if [401, 403].contains(&r.status().as_u16()) => "authentication-error",
            Ok(r) if r.status().as_u16() == 400 => "model-error",
            _ => "unavailable",
        };
        Ok(json!({"status":status,"providerId":p.id,"providerName":p.display_name}))
    }
}
