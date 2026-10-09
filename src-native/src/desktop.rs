use super::*;
const ID: &str = "00000000-0000-4000-8000-000000157220";
fn object(path: &Path) -> Result<Value> {
    let source = read(path)?.unwrap_or_else(|| "{}".into());
    let value: Value = serde_json::from_str(&source)
        .map_err(|_| "Claude Desktop 配置损坏，已保留原文件".to_string())?;
    if !value.is_object() {
        return Err("Claude Desktop 配置不是对象".into());
    }
    Ok(value)
}
fn native(id: &str) -> bool {
    let value = id.to_lowercase();
    [
        "claude-sonnet",
        "claude-opus",
        "claude-haiku",
        "claude-fable",
        "claude-mythos",
    ]
    .iter()
    .any(|s| value.starts_with(s) || value.contains(&format!("anthropic.{s}")))
        && !['\0'].iter().any(|c| value.contains(*c))
        && ![
            "deepseek", "glm", "gpt", "kimi", "qwen", "gemini", "minimax", "doubao", "openai",
        ]
        .iter()
        .any(|s| value.contains(s))
}
impl Pilot {
    fn desktop_paths(&self) -> (Vec<PathBuf>, PathBuf, PathBuf) {
        let root = if self.isolated {
            self.root.join("desktop")
        } else if cfg!(target_os = "macos") {
            Self::home().join("Library/Application Support")
        } else {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .ok_or("LOCALAPPDATA")
                .unwrap_or(self.root.clone())
        };
        (
            vec![
                root.join("Claude/claude_desktop_config.json"),
                root.join("Claude-3p/claude_desktop_config.json"),
            ],
            root.join("Claude-3p/configLibrary/_meta.json"),
            root.join(format!("Claude-3p/configLibrary/{ID}.json")),
        )
    }
    pub(super) fn desktop_snapshot(&self) -> Result<Value> {
        let file = self.root.join("desktop-ledger.json");
        let enabled = self.settings.claude_desktop["syncEnabled"] == true;
        let Some(source) = read(&file)? else {
            return Ok(
                json!({"enabled":enabled,"supported":cfg!(any(target_os="macos",target_os="windows")),"active":false,"modelCount":0,"detail":if enabled{"等待开启 Trace 或原生 Messages 连接"}else{""}}),
            );
        };
        let ledger: Value = serde_json::from_str(&source).map_err(err)?;
        let (_, meta, profile) = self.desktop_paths();
        let config = object(&profile)?;
        let active = read(&profile)?.as_deref() == ledger["writtenProfile"].as_str()
            && object(&meta)?["appliedId"] == ID;
        Ok(
            json!({"enabled":enabled,"supported":true,"active":active,"modelCount":config["inferenceModels"].as_array().map(Vec::len).unwrap_or(0),"configPath":profile,"detail":if active{""}else{"Claude Desktop 配置已被外部修改"}}),
        )
    }
    pub(super) fn desktop_restore(&self) -> Result<()> {
        self.desktop_restore_impl(true)
    }
    pub(super) fn desktop_preflight(&self) -> Result<()> {
        self.desktop_restore_impl(false)
    }
    fn desktop_restore_impl(&self, apply: bool) -> Result<()> {
        let file = self.root.join("desktop-ledger.json");
        let Some(source) = read(&file)? else {
            return Ok(());
        };
        let ledger: Value = serde_json::from_str(&source).map_err(err)?;
        let (configs, meta, profile) = self.desktop_paths();
        let mut writes = vec![];
        for (index, path) in configs.iter().enumerate() {
            let mut current = object(path)?;
            if current["deploymentMode"] != ledger["writtenMode"] {
                return Err("外部 Claude Desktop 模式变化已保留".into());
            }
            let before = &ledger["configs"][index];
            if let Some(value) = before.get("deploymentMode") {
                current["deploymentMode"] = value.clone();
            } else {
                current.as_object_mut().unwrap().remove("deploymentMode");
            }
            writes.push((path.clone(), Some(current.to_string())));
        }
        if ledger["writtenMode"] == "3p" {
            if read(&profile)?.as_deref() != ledger["writtenProfile"].as_str() {
                return Err("外部 Claude Desktop profile 变化已保留".into());
            }
            let mut current = object(&meta)?;
            if current["appliedId"] != ID {
                return Err("Claude Desktop 已选择其他 profile，选择已保留".into());
            }
            let entries = current["entries"].as_array().cloned().unwrap_or_default();
            let owned = entries.iter().find(|e| e["id"] == ID);
            if owned.is_some_and(|e| e["name"] != "XwX Deck") {
                return Err("外部 Claude Desktop profile 名称变化已保留".into());
            }
            let mut entries: Vec<_> = entries.into_iter().filter(|e| e["id"] != ID).collect();
            if let Some(entry) = ledger["meta"]["entries"]
                .as_array()
                .and_then(|e| e.iter().find(|e| e["id"] == ID))
            {
                entries.push(entry.clone());
            }
            current["entries"] = json!(entries);
            if let Some(applied) = ledger["meta"].get("appliedId") {
                current["appliedId"] = applied.clone();
            } else {
                current.as_object_mut().unwrap().remove("appliedId");
            }
            writes.push((meta, Some(current.to_string())));
            writes.push((profile, ledger["profile"].as_str().map(str::to_string)));
        }
        // All conflicts are checked before the first write.
        if !apply {
            return Ok(());
        }
        for (path, value) in writes {
            if let Some(value) = value {
                write(&path, &value)?;
            } else if path.exists() {
                fs::remove_file(path).map_err(err)?;
            }
        }
        fs::remove_file(file).map_err(err)?;
        Ok(())
    }
    pub(super) fn desktop_apply(&self, port: Option<u16>) -> Result<()> {
        if self.settings.claude_desktop["syncEnabled"] != true {
            return Ok(());
        }
        let file = self.root.join("desktop-ledger.json");
        let Some(provider) = self.selected_for("claude") else {
            self.desktop_restore()?;
            return Ok(());
        };
        if provider.adapter != "anthropic-messages" && port.is_none() {
            self.desktop_restore()?;
            return Ok(());
        }
        let mut models = vec![];
        let mut ids = std::collections::BTreeSet::new();
        if let Some(cache) = read(&self.cache_path(provider))?
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .filter(|c| c["baseUrl"] == provider.base_url && c["adapter"] == provider.adapter)
        {
            for entry in cache["entries"].as_array().into_iter().flatten() {
                if let Some(id) = entry["id"].as_str() {
                    ids.insert(id.to_string());
                }
            }
        }
        for role in ["fable", "opus", "sonnet", "haiku"] {
            if let Some(id) = provider.claude_models[role]
                .as_str()
                .filter(|s| !s.is_empty())
            {
                ids.insert(id.into());
            }
        }
        let mut aliases = serde_json::Map::new();
        for id in ids {
            let name = if native(&id) {
                id.clone()
            } else {
                if port.is_none() {
                    continue;
                }
                let hash = storage::digest(id.as_bytes());
                format!(
                    "claude-sonnet-4-6-v{}",
                    u128::from_str_radix(&hash[..32], 16).map_err(err)?
                )
            };
            if name != id {
                aliases.insert(name.clone(), json!(id));
                aliases.insert(name.replace("-v", "-"), json!(id));
            }
            let tier = ["fable", "opus", "sonnet", "haiku"]
                .into_iter()
                .find(|role| provider.claude_models[*role] == id)
                .unwrap_or(if id.contains("opus") {
                    "opus"
                } else if id.contains("haiku") {
                    "haiku"
                } else {
                    "sonnet"
                });
            models.push(json!({"name":name,"labelOverride":id,"anthropicFamilyTier":tier,"isFamilyDefault":provider.claude_models[tier]==id}));
        }
        if models.is_empty() {
            return Err("没有可同步到 Claude Desktop 的模型，请先选择模型".into());
        }
        let profile_content=json!({"chatTabEnabled":true,"disableDeploymentModeChooser":true,"inferenceProvider":"gateway","inferenceCredentialKind":"static","inferenceGatewayAuthScheme":if provider.adapter=="anthropic-messages"{"x-api-key"}else{"bearer"},"modelDiscoveryEnabled":false,"modelCatalogEnabled":true,"inferenceGatewayBaseUrl":port.map(|port|format!("http://127.0.0.1:{port}")).unwrap_or_else(||Self::api_root(&provider.base_url).trim_end_matches("/v1").to_string()),"inferenceGatewayApiKey":provider.bearer_token,"inferenceModels":models}).to_string();
        let (configs, meta, profile) = self.desktop_paths();
        let original = read(&file)?
            .map(|s| serde_json::from_str::<Value>(&s).map_err(err))
            .transpose()?;
        let mut config_values = vec![];
        for path in &configs {
            let current = object(path)?;
            if original
                .as_ref()
                .is_some_and(|l| current["deploymentMode"] != l["writtenMode"])
            {
                return Err("外部 Claude Desktop 配置变化已保留".into());
            }
            config_values.push(current);
        }
        let mut metadata = object(&meta)?;
        if let Some(ref ledger) = original {
            if read(&profile)?.as_deref() != ledger["writtenProfile"].as_str()
                || metadata["appliedId"] != ID
            {
                return Err("外部 Claude Desktop profile 变化已保留".into());
            }
        }
        let mut ledger=original.unwrap_or_else(||json!({"configs":config_values,"meta":metadata,"profile":read(&profile).ok().flatten()}));
        ledger["writtenMode"] = json!("3p");
        ledger["writtenProfile"] = json!(profile_content);
        ledger["aliases"] = json!(aliases);
        ledger["local"] = json!(port.is_some());
        // Durable ownership evidence is written before routing a Desktop client to localhost.
        write(&file, &ledger.to_string())?;
        for (path, mut current) in configs.into_iter().zip(config_values) {
            current["deploymentMode"] = json!("3p");
            write(&path, &current.to_string())?;
        }
        let mut entries = metadata["entries"].as_array().cloned().unwrap_or_default();
        entries.retain(|e| e["id"] != ID);
        entries.push(json!({"id":ID,"name":"XwX Deck"}));
        metadata["entries"] = json!(entries);
        metadata["appliedId"] = json!(ID);
        write(&meta, &metadata.to_string())?;
        write(&profile, &profile_content)?;
        Ok(())
    }
}
