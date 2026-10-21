use super::*;
pub(super) const ID: &str = "00000000-0000-4000-8000-000000157220";
pub(super) const LEGACY_IDS: [&str; 2] = crate::edition::config::DESKTOP_LEGACY_IDS;
fn object(path: &Path) -> Result<Value> {
    parse_object(&read(path)?)
}
fn parse_object(source: &Option<String>) -> Result<Value> {
    let value: Value = serde_json::from_str(source.as_deref().unwrap_or("{}"))
        .map_err(|_| "Claude Desktop 配置损坏，已保留原文件".to_string())?;
    if !value.is_object() {
        return Err("Claude Desktop 配置不是对象".into());
    }
    Ok(value)
}
fn native(id: &str) -> bool {
    static FOREIGN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static COMPATIBLE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let value = id.trim().to_lowercase();
    // Match the retained Desktop ID policy: a Claude-looking name can still
    // be rejected by the client when it contains another vendor's tokens.
    let foreign = FOREIGN.get_or_init(|| regex::Regex::new(r"ark-code|astron|command-r|deepseek|doubao|gemini|gemma|glm|gpt|grok|hermes|hy3|kimi|lfm|\bling\b|llama|longcat|mimo|minimax|mistral|mixtral|moonshot|nemotron|openai|phi-|qianfan|qwen|\bunic\b|yi-|stepfun|step-3|seed-|bytedance|hunyuan|granite|amazon\.nova|nova-|devstral|ministral|ernie|codex|arcee|trinity|abab|phi\d|\bk2\.|\bm2\.|jamba|arctic|solar|mercury|zamba|kat-coder|\bds-|dpsk").unwrap());
    !value.contains('\0') && !crate::edition::config::foreign_model_alias(&value) && !foreign.is_match(&value)
        && COMPATIBLE.get_or_init(|| regex::Regex::new(r"^claude-(?:haiku|sonnet|opus|fable|mythos)(?:[-.@:]|$)|(?:^|[./])anthropic\.claude-(?:haiku|sonnet|opus|fable|mythos)(?:[-.@:]|$)").unwrap()).is_match(&value)
}

fn conversational(entry: &Value) -> bool {
    if catalog::metadata::non_conversational(entry) {
        return false;
    }
    static NON_CONVERSATIONAL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let id = text(entry, "id").to_lowercase();
    !NON_CONVERSATIONAL
        .get_or_init(|| regex::Regex::new(r"^(?:text-embedding|gpt-image)(?:-|$)").unwrap())
        .is_match(&id)
        && id != "qwen-vl-ocr"
        && !entry["outputModalities"]
            .as_array()
            .is_some_and(|a| !a.is_empty() && !a.iter().any(|v| v == "text"))
        && !entry["protocols"].as_array().is_some_and(|a| {
            !a.is_empty()
                && !a.iter().any(|v| {
                    [
                        "anthropic-messages",
                        "openai-responses",
                        "responses",
                        "chat-completions",
                    ]
                    .iter()
                    .any(|p| v == p)
                })
        })
}

pub(super) fn request_model(
    root: &Path,
    provider: &Provider,
    requested: &str,
    desktop: bool,
) -> String {
    let model = requested.trim_end_matches("[1m]");
    let ledger = read(&root.join("desktop-ledger.json"))
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(Value::Null);
    if let Some(actual) = ledger["aliases"][model].as_str() {
        // An alias already identifies a concrete model. Never remap it again
        // through a role default when its target happens to look like Claude.
        return actual.into();
    }
    let published = ledger["writtenProfile"]
        .as_str()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .is_some_and(|p| {
            p["inferenceModels"]
                .as_array()
                .is_some_and(|a| a.iter().any(|m| m["name"] == model))
        });
    if desktop || published {
        return model.into();
    }
    ["fable", "opus", "sonnet", "haiku"]
        .into_iter()
        .find(|role| model.starts_with(role) || model.starts_with(&format!("claude-{role}")))
        .and_then(|role| provider.claude_models[role].as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(model)
        .into()
}
impl Pilot {
    pub(super) fn refresh_desktop_selection(&mut self) -> Result<()> {
        let result = self.desktop_apply(self.gateway.as_ref().map(|g| g.port));
        if let Err(error) = result {
            self.settings.claude_desktop["syncWarning"] = json!(error);
        } else if let Some(options) = self.settings.claude_desktop.as_object_mut() {
            options.remove("syncWarning");
        }
        // A Desktop conflict must not roll back a successful CLI/provider
        // selection. Keep the choice and a persistent actionable warning.
        self.persist()
    }
    pub(super) fn desktop_paths(&self) -> (Vec<PathBuf>, PathBuf, PathBuf) {
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
        let mut snapshot = self.desktop_snapshot_inner()?;
        if let Some(warning) = self.settings.claude_desktop["syncWarning"].as_str() {
            snapshot["warning"] = json!(warning);
            snapshot["detail"] = json!(warning);
        }
        Ok(snapshot)
    }
    fn desktop_snapshot_inner(&self) -> Result<Value> {
        let file = self.root.join("desktop-ledger.json");
        let enabled = self.settings.claude_desktop["syncEnabled"] == true;
        let Some(source) = read(&file)? else {
            return Ok(
                json!({"enabled":enabled,"supported":cfg!(any(target_os="macos",target_os="windows")),"active":false,"modelCount":0,"detail":if enabled{"等待开启 Trace 或原生 Messages 连接"}else{""}}),
            );
        };
        let ledger: Value = serde_json::from_str(&source).map_err(err)?;
        let (configs, meta, profile) = self.desktop_paths();
        if ledger["writtenMode"] == "1p" {
            let active = configs
                .iter()
                .all(|p| object(p).is_ok_and(|v| v["deploymentMode"] == "1p"));
            return Ok(
                json!({"enabled":enabled,"supported":true,"active":active,"modelCount":0,"official":true,"detail":if active{""}else{"Claude Desktop 官方模式已被外部修改"}}),
            );
        }
        let config = object(&profile)?;
        let active = read(&profile)?.as_deref() == ledger["writtenProfile"].as_str()
            && object(&meta)?["appliedId"] == ID
            && configs
                .iter()
                .all(|p| object(p).is_ok_and(|v| v["deploymentMode"] == "3p"));
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
            let source = read(path)?;
            let mut current = parse_object(&source)?;
            let before = &ledger["configs"][index];
            if current["deploymentMode"] != ledger["writtenMode"]
                && current.get("deploymentMode") != before.get("deploymentMode")
            {
                return Err("外部 Claude Desktop 模式变化已保留".into());
            }
            if let Some(value) = before.get("deploymentMode") {
                current["deploymentMode"] = value.clone();
            } else {
                current.as_object_mut().unwrap().remove("deploymentMode");
            }
            let next = if ledger["configExisted"][index] == false
                && current.as_object().is_some_and(|o| o.is_empty())
            {
                None
            } else {
                Some(current.to_string())
            };
            writes.push((path.clone(), source, next));
        }
        if ledger["writtenMode"] == "3p" {
            let profile_source = read(&profile)?;
            if profile_source.as_deref() != ledger["writtenProfile"].as_str()
                && profile_source.as_deref() != ledger["profile"].as_str()
            {
                return Err("外部 Claude Desktop profile 变化已保留".into());
            }
            let meta_source = read(&meta)?;
            let mut current = parse_object(&meta_source)?;
            if current["appliedId"] != ID
                && current.get("appliedId") != ledger["meta"].get("appliedId")
            {
                return Err("Claude Desktop 已选择其他 profile，选择已保留".into());
            }
            let entries = current["entries"].as_array().cloned().unwrap_or_default();
            let owned = entries.iter().find(|e| e["id"] == ID);
            let previous_entry = ledger["meta"]["entries"]
                .as_array()
                .and_then(|e| e.iter().find(|e| e["id"] == ID));
            if owned.is_some_and(|e| e["name"] != "XwX Deck" && Some(e) != previous_entry) {
                return Err("外部 Claude Desktop profile 名称变化已保留".into());
            }
            let mut entries: Vec<_> = entries.into_iter().filter(|e| e["id"] != ID).collect();
            if let Some(entry) = ledger["meta"]["entries"]
                .as_array()
                .and_then(|e| e.iter().find(|e| e["id"] == ID))
            {
                entries.push(entry.clone());
            }
            if entries.is_empty() && ledger["meta"].get("entries").is_none() {
                current.as_object_mut().unwrap().remove("entries");
            } else {
                current["entries"] = json!(entries);
            }
            if let Some(applied) = ledger["meta"].get("appliedId") {
                current["appliedId"] = applied.clone();
            } else {
                current.as_object_mut().unwrap().remove("appliedId");
            }
            let next = if ledger["metaExisted"] == false
                && current.as_object().is_some_and(|o| o.is_empty())
            {
                None
            } else {
                Some(current.to_string())
            };
            writes.push((meta, meta_source, next));
            writes.push((
                profile,
                profile_source,
                ledger["profile"].as_str().map(str::to_string),
            ));
        }
        // All conflicts are checked before the first write.
        if !apply {
            return Ok(());
        }
        writes.push((file, Some(source), None));
        self.desktop_commit(writes)
    }
    pub(super) fn desktop_apply(&self, port: Option<u16>) -> Result<()> {
        if self.settings.claude_desktop["syncEnabled"] != true {
            return Ok(());
        }
        let file = self.root.join("desktop-ledger.json");
        let Some(provider) = self.selected_for("claude") else {
            return self.desktop_apply_official();
        };
        if self.needs_gateway(provider, "claude") && port.is_none() {
            self.desktop_restore()?;
            return Ok(());
        }
        let mut models = vec![];
        let mut ids = std::collections::BTreeMap::new();
        if let Some(cache) = read(&self.cache_path(provider))?
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .filter(|c| c["baseUrl"] == provider.base_url && c["adapter"] == provider.adapter)
        {
            for entry in cache["entries"].as_array().into_iter().flatten() {
                if let Some(id) = entry["id"].as_str().filter(|s| !s.trim().is_empty()) {
                    ids.insert(id.to_string(), entry.clone());
                }
            }
        }
        for role in ["fable", "opus", "sonnet", "haiku"] {
            if let Some(id) = provider.claude_models[role]
                .as_str()
                .filter(|s| !s.is_empty())
            {
                ids.entry(id.to_string())
                    .or_insert_with(|| json!({"id":id}));
            }
        }
        let mut used: std::collections::BTreeSet<_> =
            ids.keys().filter(|id| native(id)).cloned().collect();
        let mut legacy_used = used.clone();
        let mut aliases = serde_json::Map::new();
        for (id, entry) in ids {
            if catalog::metadata::unavailable(&entry)
                || !conversational(&entry)
                || (port.is_none()
                    && resolve_wire(&self.root, provider, Some(&id), "anthropic-messages")
                        != "anthropic-messages")
            {
                continue;
            }
            let name = if native(&id) {
                id.clone()
            } else {
                if port.is_none() {
                    continue;
                }
                let hash = storage::digest(id.as_bytes());
                let base = format!(
                    "claude-sonnet-4-6-v{}",
                    u128::from_str_radix(&hash[..32], 16).map_err(err)?
                );
                let mut name = base.clone();
                let mut suffix = 2;
                while used.contains(&name) {
                    name = format!("{base}:{suffix}");
                    suffix += 1;
                }
                used.insert(name.clone());
                let legacy_base = base.replace("-v", "-");
                let mut legacy = legacy_base.clone();
                let mut suffix = 2;
                while legacy_used.contains(&legacy) {
                    legacy = format!("{legacy_base}-{suffix}");
                    suffix += 1;
                }
                legacy_used.insert(legacy.clone());
                aliases.insert(legacy, json!(id));
                name
            };
            if name != id {
                aliases.insert(name.clone(), json!(id));
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
            let mut model = json!({"name":name,"labelOverride":id,"anthropicFamilyTier":tier,"isFamilyDefault":provider.claude_models[tier]==id});
            if entry["contextWindow"]
                .as_u64()
                .is_some_and(|n| n >= 1_000_000)
            {
                model["supports1m"] = json!(true);
            }
            models.push(model);
        }
        if models.is_empty() {
            return Err("没有可提供给 Claude Desktop 的模型，请先选择模型".into());
        }
        let gateway_key = if port.is_some() && !provider.subscription_account_id.is_empty() {
            "xwxdeck-local-subscription"
        } else {
            &provider.bearer_token
        };
        let profile_content=json!({"chatTabEnabled":true,"disableDeploymentModeChooser":true,"inferenceProvider":"gateway","inferenceCredentialKind":"static","inferenceGatewayAuthScheme":"x-api-key","modelDiscoveryEnabled":false,"modelCatalogEnabled":true,"inferenceGatewayBaseUrl":port.map(|port|format!("http://127.0.0.1:{port}/claude-desktop")).unwrap_or_else(||Self::claude_base(provider)),"inferenceGatewayApiKey":gateway_key,"inferenceModels":models}).to_string();
        let (configs, meta, profile) = self.desktop_paths();
        let ledger_source = read(&file)?;
        let original = ledger_source
            .clone()
            .map(|s| serde_json::from_str::<Value>(&s).map_err(err))
            .transpose()?;
        let mut config_values = vec![];
        let mut config_sources = vec![];
        for path in &configs {
            let source = read(path)?;
            let current = parse_object(&source)?;
            config_sources.push(source);
            if original
                .as_ref()
                .is_some_and(|l| current["deploymentMode"] != l["writtenMode"])
            {
                return Err("外部 Claude Desktop 配置变化已保留".into());
            }
            config_values.push(current);
        }
        let meta_source = read(&meta)?;
        let profile_source = read(&profile)?;
        let mut metadata = parse_object(&meta_source)?;
        if let Some(ref ledger) = original {
            if ledger["writtenMode"] == "3p"
                && (profile_source.as_deref() != ledger["writtenProfile"].as_str()
                    || metadata["appliedId"] != ID)
            {
                return Err("外部 Claude Desktop profile 变化已保留".into());
            }
        }
        let mut ledger=original.unwrap_or_else(||json!({"configs":config_values,"configExisted":config_sources.iter().map(Option::is_some).collect::<Vec<_>>(),"meta":metadata,"metaExisted":meta_source.is_some(),"profile":profile_source}));
        // Official mode only owns deploymentMode. The user may have edited or
        // selected a library profile since then; capture that current baseline
        // when we first take ownership of the library again.
        if ledger["writtenMode"] == "1p" {
            ledger["meta"] = metadata.clone();
            ledger["metaExisted"] = json!(meta_source.is_some());
            ledger["profile"] = json!(profile_source);
        }
        ledger["writtenMode"] = json!("3p");
        ledger["writtenProfile"] = json!(profile_content);
        ledger["aliases"] = json!(aliases);
        ledger["local"] = json!(port.is_some());
        // Durable ownership evidence is written before routing a Desktop client to localhost.
        let mut changes = vec![(file.clone(), ledger_source, Some(ledger.to_string()))];
        for ((path, mut current), before) in
            configs.into_iter().zip(config_values).zip(config_sources)
        {
            current["deploymentMode"] = json!("3p");
            changes.push((path, before, Some(current.to_string())));
        }
        let mut entries = metadata["entries"].as_array().cloned().unwrap_or_default();
        entries.retain(|e| e["id"] != ID);
        entries.push(json!({"id":ID,"name":"XwX Deck"}));
        metadata["entries"] = json!(entries);
        metadata["appliedId"] = json!(ID);
        changes.push((meta, meta_source, Some(metadata.to_string())));
        changes.push((profile, profile_source, Some(profile_content)));
        self.desktop_commit(changes)
    }
    fn desktop_apply_official(&self) -> Result<()> {
        let file = self.root.join("desktop-ledger.json");
        if let Some(source) = read(&file)? {
            let ledger: Value = serde_json::from_str(&source).map_err(err)?;
            if ledger["writtenMode"] == "1p" {
                let (configs, _, _) = self.desktop_paths();
                if configs
                    .iter()
                    .all(|p| object(p).is_ok_and(|v| v["deploymentMode"] == "1p"))
                {
                    return Ok(());
                }
                return Err("Claude Desktop 官方模式已被外部修改，原配置已保留".into());
            }
            self.desktop_restore()?;
        }
        let (configs, meta, profile) = self.desktop_paths();
        let sources: Vec<_> = configs.iter().map(|p| read(p)).collect::<Result<_>>()?;
        let values: Vec<_> = sources.iter().map(parse_object).collect::<Result<_>>()?;
        let meta_source = read(&meta)?;
        let metadata = parse_object(&meta_source)?;
        let profile_source = read(&profile)?;
        let ledger = json!({"configs":values,"configExisted":sources.iter().map(Option::is_some).collect::<Vec<_>>(),"meta":metadata,"metaExisted":meta_source.is_some(),"profile":profile_source,"writtenMode":"1p","local":false,"aliases":{}});
        let mut changes = vec![(file, None, Some(ledger.to_string()))];
        for ((path, source), mut current) in configs.into_iter().zip(sources).zip(values) {
            current["deploymentMode"] = json!("1p");
            changes.push((path, source, Some(current.to_string())));
        }
        self.desktop_commit(changes)
    }
}

fn replace(path: &Path, before: &Option<String>, after: &Option<String>) -> Result<()> {
    if read(path)? != *before {
        return Err("Claude Desktop 文件被外部修改，原内容已保留".into());
    }
    if before == after {
        return Ok(());
    }
    match after {
        Some(content) => {
            let parent = path.parent().ok_or("Claude Desktop 路径无效")?;
            // Verify every existing ancestor before creating missing directories.
            for ancestor in parent.ancestors() {
                if fs::symlink_metadata(ancestor).is_ok() && !same_physical_path(ancestor)? {
                    return Err("Claude Desktop 路径包含符号链接，未写入".into());
                }
            }
            fs::create_dir_all(parent).map_err(err)?;
            if !same_physical_path(parent)? {
                return Err("Claude Desktop 配置目录发生变化，未写入".into());
            }
            if read(path)? != *before {
                return Err("Claude Desktop 写入前内容发生变化，已保留".into());
            }
            write(path, content)
        }
        None => {
            if before.is_some() {
                fs::remove_file(path).map_err(err)?;
            }
            Ok(())
        }
    }
}
impl Pilot {
    fn desktop_allowed_paths(&self) -> Vec<PathBuf> {
        let (mut paths, meta, profile) = self.desktop_paths();
        paths.extend(
            LEGACY_IDS
                .iter()
                .map(|id| meta.parent().unwrap().join(format!("{id}.json"))),
        );
        paths.extend([
            meta,
            profile,
            self.root.join("desktop-ledger.json"),
            self.root.join("claude-desktop-sync-state.json"),
        ]);
        paths
    }
    pub(super) fn desktop_commit(
        &self,
        changes: Vec<(PathBuf, Option<String>, Option<String>)>,
    ) -> Result<()> {
        let journal = self.root.join("desktop-recovery.json");
        if read(&journal)?.is_some() {
            return Err("Claude Desktop 先前操作尚待恢复，未覆盖恢复记录".into());
        }
        let allowed = self.desktop_allowed_paths();
        let mut unique = std::collections::HashSet::new();
        for (path, before, _) in &changes {
            if !allowed.contains(path) || !unique.insert(path.clone()) {
                return Err("Claude Desktop 事务路径无效".into());
            }
            if read(path)? != *before {
                return Err("Claude Desktop 配置已被外部修改，未开始写入".into());
            }
        }
        let rows: Vec<_> = changes
            .iter()
            .map(|(path, before, after)| json!({"path":path,"before":before,"after":after}))
            .collect();
        let source = json!({"version":1,"changes":rows}).to_string();
        write(&journal, &source)?;
        for (path, before, after) in &changes {
            if let Err(error) = replace(path, before, after) {
                let rollback = self.recover_desktop_transaction();
                return Err(match rollback {
                    Ok(()) => error,
                    Err(e) => format!("{error}；{e}"),
                });
            }
        }
        if read(&journal)?.as_deref() != Some(&source) {
            return Err("Claude Desktop 提交期间恢复账本被外部修改，已保留".into());
        }
        fs::remove_file(journal).map_err(err)
    }
    pub(super) fn recover_desktop_transaction(&self) -> Result<()> {
        let path = self.root.join("desktop-recovery.json");
        let Some(source) = read(&path)? else {
            return Ok(());
        };
        let journal: Value =
            serde_json::from_str(&source).map_err(|_| "Claude Desktop 事务损坏，恢复记录已保留")?;
        let changes = journal["changes"]
            .as_array()
            .filter(|c| c.len() <= 16)
            .ok_or("Claude Desktop 恢复事务无效")?;
        if journal["version"] != 1 {
            return Err("Claude Desktop 恢复版本无效".into());
        }
        let allowed = self.desktop_allowed_paths();
        let mut rows = vec![];
        let mut unique = std::collections::HashSet::new();
        let mut complete = true;
        for row in changes {
            let file = PathBuf::from(text(row, "path"));
            if !allowed.contains(&file) || !unique.insert(file.clone()) {
                return Err("Claude Desktop 恢复路径不匹配，未写入".into());
            }
            for key in ["before", "after"] {
                if !row[key].is_null() && !row[key].is_string() {
                    return Err("Claude Desktop 恢复内容无效".into());
                }
            }
            let before = row["before"].as_str().map(str::to_string);
            let after = row["after"].as_str().map(str::to_string);
            let current = read(&file)?;
            if current != before && current != after {
                return Err(
                    "Claude Desktop 外部修改已保留；事务与加密备份仍保留，可恢复后重试".into(),
                );
            }
            complete &= current == after;
            rows.push((file, current, before));
        }
        // Check every file before restoring any; repeat byte comparison per write.
        if !complete {
            for (file, current, before) in rows.into_iter().rev() {
                replace(&file, &current, &before)?;
            }
        }
        if read(&path)?.as_deref() != Some(&source) {
            return Err("Claude Desktop 恢复账本被外部修改，已保留".into());
        }
        fs::remove_file(path).map_err(err)
    }
}
