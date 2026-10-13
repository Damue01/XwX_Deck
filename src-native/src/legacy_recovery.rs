//! Restore the actual Electron v1/v2 Trace field journals before native wiring.
//! A live old proxy is never interrupted by migration. External fields win.
use super::*;
use std::net::{IpAddr, SocketAddr, TcpStream};

pub(super) fn endpoint(value: &str) -> Option<SocketAddr> {
    let url = reqwest::Url::parse(value).ok()?;
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let host = url.host_str()?;
    let ip: IpAddr = if host == "localhost" {
        "127.0.0.1".parse().ok()?
    } else {
        host.trim_matches(['[', ']']).parse().ok()?
    };
    let ip = match ip {
        IpAddr::V6(v) => v.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        _ => ip,
    };
    if !ip.is_loopback() {
        return None;
    }
    Some(SocketAddr::new(ip, url.port_or_known_default()?))
}
fn same_endpoint(value: &Value, local: &str) -> bool {
    value
        .as_str()
        .and_then(endpoint)
        .is_some_and(|a| Some(a) == endpoint(local))
}
fn section(field: &Value) -> Result<Vec<String>> {
    let header = text(field, "sectionHeader");
    if header.is_empty() {
        return Ok(vec![]);
    }
    // Parse TOML's real quoted/dotted key grammar, rather than splitting on dots.
    let parsed = doc(&format!("{header}\n__native_field_probe = true\n"))?;
    fn path(table: &dyn toml_edit::TableLike, out: &mut Vec<String>) -> bool {
        for (key, item) in table.iter() {
            if key == "__native_field_probe" {
                return true;
            }
            if let Some(child) = item.as_table_like() {
                out.push(key.into());
                if path(child, out) {
                    return true;
                }
                out.pop();
            }
        }
        false
    }
    let mut result = vec![];
    if !path(parsed.as_table(), &mut result) || result.len() > 8 {
        return Err("旧版恢复字段位置无效，账本已保留".into());
    }
    Ok(result)
}
pub(super) fn table<'a>(
    document: &'a DocumentMut,
    path: &[String],
) -> Option<&'a dyn toml_edit::TableLike> {
    let mut table: &dyn toml_edit::TableLike = document.as_table();
    for key in path {
        table = table.get(key)?.as_table_like()?;
    }
    Some(table)
}
fn table_mut<'a>(
    document: &'a mut DocumentMut,
    path: &[String],
) -> Option<&'a mut dyn toml_edit::TableLike> {
    let mut table: &mut dyn toml_edit::TableLike = document.as_table_mut();
    for key in path {
        table = table.get_mut(key)?.as_table_like_mut()?;
    }
    Some(table)
}
fn previous(field: &Value) -> Option<Value> {
    (field["previous"]["present"] == true).then(|| field["previous"]["value"].clone())
}
fn legacy_fields(record: &Value, current: &str) -> Result<Vec<Value>> {
    if record["version"] == 2 {
        let fields = record["fields"].as_array().ok_or("旧版字段恢复账本损坏")?;
        if fields.len() > 256 {
            return Err("旧版恢复字段过多".into());
        }
        return Ok(fields.clone());
    }
    let original = text(record, "originalContent");
    let local = text(record, "writtenLocalUrl");
    if record["client"] == "claude" {
        let old: Value = serde_json::from_str(original).unwrap_or(json!({}));
        return Ok(vec![
            json!({"format":"json-env","key":"ANTHROPIC_BASE_URL","writtenValue":local,"previous":{"present":old["env"].get("ANTHROPIC_BASE_URL").is_some(),"value":old["env"]["ANTHROPIC_BASE_URL"]}}),
        ]);
    }
    let active = doc(current)?;
    let old = doc(original)?;
    let provider = active
        .get("model_provider")
        .and_then(Item::as_str)
        .unwrap_or("openai");
    let path = vec!["model_providers".into(), provider.into()];
    let managed = format!("{}/v1", local.trim_end_matches('/').trim_end_matches("/v1"));
    let provider_value = table(&active, &path).and_then(|t| t.get("base_url"));
    let (key, header, old_value) = if semantic(provider_value) == Some(json!(managed)) {
        (
            "base_url",
            format!(
                "[model_providers.{}]",
                serde_json::to_string(provider).map_err(err)?
            ),
            table(&old, &path).and_then(|t| t.get("base_url")),
        )
    } else {
        ("openai_base_url", String::new(), old.get("openai_base_url"))
    };
    Ok(vec![
        json!({"format":"toml-string","key":key,"sectionHeader":header,"writtenValue":managed,"previous":{"present":old_value.is_some(),"value":semantic(old_value)}}),
    ])
}

fn restore(record: &Value, current: &str) -> Result<(String, Vec<String>, bool)> {
    let fields = legacy_fields(record, current)?;
    let mut conflicts = vec![];
    let local = text(record, "writtenLocalUrl");
    if record["client"] == "claude" {
        let mut data: Value =
            serde_json::from_str(current).map_err(|_| "旧版 Claude 配置无法解析，原文件已保留")?;
        if !data.is_object() || data.get("env").is_some_and(|v| !v.is_object()) {
            return Err("旧版 Claude env 格式变化，原文件已保留".into());
        }
        if data.get("env").is_none() {
            data["env"] = json!({});
        }
        let env = data["env"].as_object_mut().unwrap();
        let mut changed = false;
        for field in &fields {
            let key = text(field, "key");
            if field["format"] != "json-env" || !super::clients::CLAUDE_KEYS.contains(&key) {
                return Err("旧版 Claude 恢复包含未知字段，账本已保留".into());
            }
            let old = previous(field);
            if env.get(key) == Some(&field["writtenValue"]) {
                match old {
                    Some(v) => {
                        env.insert(key.into(), v);
                    }
                    None => {
                        env.remove(key);
                    }
                }
                changed = true;
            } else if env.get(key) != old.as_ref() {
                conflicts.push(key.into());
            }
        }
        let unresolved = env
            .get("ANTHROPIC_BASE_URL")
            .is_some_and(|v| same_endpoint(v, local));
        if env.is_empty() {
            data.as_object_mut().unwrap().remove("env");
        }
        return Ok((
            if changed {
                serde_json::to_string_pretty(&data).map_err(err)? + "\n"
            } else {
                current.into()
            },
            conflicts,
            unresolved,
        ));
    }
    let mut document = doc(current)?;
    let mut changed = false;
    for field in &fields {
        let key = text(field, "key");
        let path = section(field)?;
        let format = text(field, "format");
        let owned = if path.is_empty() {
            ["model_provider", "openai_base_url", "chatgpt_base_url"].contains(&key)
        } else {
            path.len() == 2 && path[0] == "model_providers" && CODEX_PROVIDER_FIELDS.contains(&key)
        };
        if !["toml-string", "toml-boolean"].contains(&format) || !owned {
            return Err("旧版 Codex 恢复包含未知字段，账本已保留".into());
        }
        let current_value = table(&document, &path).and_then(|t| t.get(key));
        let actual = semantic(current_value);
        let old = previous(field);
        if actual == Some(field["writtenValue"].clone()) {
            let item = match &old {
                Some(Value::String(v)) if format == "toml-string" => {
                    Some(restored_value(&value(v), current_value))
                }
                Some(Value::Bool(v)) if format == "toml-boolean" => {
                    Some(restored_value(&value(*v), current_value))
                }
                None => None,
                _ => return Err("旧版恢复原值类型无效，账本已保留".into()),
            };
            if let Some(t) = table_mut(&mut document, &path) {
                if let Some(item) = item {
                    t.insert(key, item);
                } else {
                    t.remove(key);
                }
                changed = true;
            }
        } else if actual != old {
            conflicts.push(format!("{}.{}", text(field, "sectionHeader"), key));
        }
    }
    // Creation ownership is attached to the first field in old v2 journals;
    // remove the table only after every owned field has been restored.
    for field in &fields {
        let path = section(field)?;
        if field["removeSectionIfEmpty"] == true
            && !path.is_empty()
            && table(&document, &path).is_some_and(|t| t.is_empty())
        {
            if let Some(parent) = table_mut(&mut document, &path[..path.len() - 1]) {
                parent.remove(path.last().unwrap());
            }
        }
    }
    let unresolved = ["openai_base_url", "chatgpt_base_url"]
        .iter()
        .any(|key| semantic(document.get(key)).is_some_and(|v| same_endpoint(&v, local)))
        || document
            .get("model_providers")
            .and_then(Item::as_table_like)
            .is_some_and(|providers| {
                providers.iter().any(|(_, provider)| {
                    provider
                        .get("base_url")
                        .and_then(Item::as_str)
                        .is_some_and(|s| same_endpoint(&json!(s), local))
                })
            });
    Ok((
        if changed {
            document.to_string()
        } else {
            current.into()
        },
        conflicts,
        unresolved,
    ))
}

impl Pilot {
    fn recover_legacy_desktop(&self) -> Result<()> {
        let file = self.root.join("claude-desktop-sync-state.json");
        let Some(source) = read(&file)? else {
            return Ok(());
        };
        let state: Value =
            serde_json::from_str(&source).map_err(|_| "旧 Desktop 恢复记录损坏，已保留")?;
        if state["version"] != 1 {
            return Err("旧 Desktop 恢复版本无效，已保留".into());
        }
        let (configs, meta, profile) = self.desktop_paths();
        let old_profile = PathBuf::from(text(&state, "profilePath"));
        let managed_id = old_profile
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or("旧 Desktop profile 身份无效")?;
        let legacy_alias = old_profile != profile;
        let saved = state["configFiles"]
            .as_array()
            .filter(|c| c.len() == configs.len())
            .ok_or("旧 Desktop 配置路径缺失")?;
        if state["metaPath"].as_str().map(Path::new) != Some(meta.as_path())
            || (legacy_alias
                && (!super::desktop::LEGACY_IDS.contains(&managed_id)
                    || old_profile.parent() != profile.parent()))
            || state["root"].as_str().map(Path::new) != meta.parent().and_then(Path::parent)
            || configs.iter().any(|p| {
                saved
                    .iter()
                    .filter(|s| s["path"].as_str().map(Path::new) == Some(p.as_path()))
                    .count()
                    != 1
            })
        {
            return Err("旧 Desktop 路径与当前产品配置不匹配，未写入".into());
        }
        let archive = self.root.join(format!(
            "legacy-recovery-desktop-{}.json",
            storage::digest(source.as_bytes())
        ));
        if read(&archive)?.is_none() {
            write(&archive, &source)?;
        }
        let mode = state["mode"].as_str().unwrap_or("local");
        if !["official", "direct", "local"].contains(&mode) {
            return Err("旧 Desktop 模式无效，已保留".into());
        }
        let written_mode = if mode == "official" { "1p" } else { "3p" };
        let mut baselines = vec![];
        let mut existence = vec![];
        for path in &configs {
            let current = read(path)?;
            let mut value: Value = serde_json::from_str(current.as_deref().unwrap_or("{}"))
                .map_err(|_| "旧 Desktop JSON 损坏，原文件已保留")?;
            if !value.is_object() || value["deploymentMode"] != written_mode {
                return Err("旧 Desktop 模式被外部修改，原配置已保留".into());
            }
            let previous = saved
                .iter()
                .find(|s| s["path"].as_str().map(Path::new) == Some(path.as_path()))
                .ok_or("旧 Desktop 配置路径缺失")?;
            if previous["previousDeploymentMode"]["present"] == true {
                value["deploymentMode"] = previous["previousDeploymentMode"]["value"].clone();
            } else {
                value.as_object_mut().unwrap().remove("deploymentMode");
            }
            baselines.push(value);
            existence.push(previous["fileExisted"] == true);
        }
        let meta_source = read(&meta)?;
        let mut metadata: Value = serde_json::from_str(meta_source.as_deref().unwrap_or("{}"))
            .map_err(|_| "旧 Desktop 元数据损坏，已保留")?;
        let profile_source = read(&old_profile)?;
        let canonical_source = if legacy_alias {
            read(&profile)?
        } else {
            profile_source.clone()
        };
        if !metadata.is_object() {
            return Err("旧 Desktop 元数据格式无效".into());
        }
        let written = text(&state, "writtenProfileContent");
        if mode != "official" {
            if mode == "local" {
                let profile_value: Value =
                    serde_json::from_str(written).map_err(|_| "旧 Desktop profile JSON 损坏")?;
                if endpoint(text(&profile_value, "inferenceGatewayBaseUrl")).is_some_and(|a| {
                    TcpStream::connect_timeout(&a, Duration::from_millis(200)).is_ok()
                }) {
                    return Err("旧 Desktop 代理仍在运行；请先停止旧版 Trace，原请求未中断".into());
                }
            }
            if profile_source.as_deref() != Some(written) || metadata["appliedId"] != managed_id {
                return Err("旧 Desktop profile 或选择已被外部修改，原内容已保留".into());
            }
            let entries = metadata["entries"]
                .as_array()
                .ok_or("旧 Desktop profile 列表无效")?;
            if entries.iter().filter(|e| e["id"] == managed_id).count() != 1
                || entries
                    .iter()
                    .find(|e| e["id"] == managed_id)
                    .is_none_or(|e| e["name"] != "XwX Deck")
            {
                return Err("旧 Desktop profile 名称已被外部修改".into());
            }
            if legacy_alias
                && (canonical_source.as_deref().is_some_and(|s| s != written)
                    || entries
                        .iter()
                        .filter(|e| e["id"] == super::desktop::ID)
                        .count()
                        > 1
                    || entries
                        .iter()
                        .find(|e| e["id"] == super::desktop::ID)
                        .is_some_and(|e| e["name"] != "XwX Deck")
                    || (canonical_source.is_some()
                        && entries.iter().all(|e| e["id"] != super::desktop::ID)))
            {
                return Err(
                    "Claude Desktop UUID profile 已被外部修改或归属不明，旧别名和原文件已保留"
                        .into(),
                );
            }
        }
        let files_archive = self.root.join(format!(
            "legacy-recovery-desktop-files-{}.json",
            storage::digest(source.as_bytes())
        ));
        if read(&files_archive)?.is_none() {
            let mut originals = vec![];
            for path in configs.iter().chain([&meta, &old_profile, &profile]) {
                originals.push(json!({"path":path,"content":read(path)?}));
            }
            write(
                &files_archive,
                &json!({"version":1,"files":originals}).to_string(),
            )?;
        }
        let mut entries: Vec<_> = metadata["entries"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|e| e["id"] != managed_id && !(legacy_alias && e["id"] == super::desktop::ID))
            .cloned()
            .collect();
        if state["previousEntry"]["present"] == true {
            entries.push(state["previousEntry"]["value"].clone());
        }
        metadata["entries"] = json!(entries);
        if state["previousAppliedId"]["present"] == true {
            metadata["appliedId"] = state["previousAppliedId"]["value"].clone();
        } else {
            metadata.as_object_mut().unwrap().remove("appliedId");
        }
        let fallback = state["directFallbackProfileContent"]
            .as_str()
            .filter(|s| !s.is_empty());
        let mut published = written.to_string();
        let mut local = mode == "local";
        if let Some(fallback) = fallback.filter(|_| mode == "local") {
            let value: Value = serde_json::from_str(fallback)
                .map_err(|_| "旧 Desktop 直连 fallback 无效，已保留")?;
            let base = text(&value, "inferenceGatewayBaseUrl");
            let url = reqwest::Url::parse(base).map_err(|_| "旧 Desktop 直连 URL 无效")?;
            if !["https", "http"].contains(&url.scheme())
                || endpoint(base).is_some()
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("旧 Desktop fallback 仍为本地路由或无效 URL，未使用".into());
            }
            published = fallback.into();
            local = false;
        }
        let native = self.root.join("desktop-ledger.json");
        if read(&native)?.is_some() {
            return Err("新旧 Desktop 恢复记录同时存在，已保留并阻止覆盖".into());
        }
        let mut aliases = serde_json::Map::new();
        if mode != "official" {
            let profile_value: Value =
                serde_json::from_str(&published).map_err(|_| "旧 Desktop profile JSON 损坏")?;
            for model in profile_value["inferenceModels"]
                .as_array()
                .into_iter()
                .flatten()
            {
                let name = text(model, "name");
                let label = text(model, "labelOverride");
                if !name.is_empty() && !label.is_empty() && name != label {
                    aliases.insert(name.into(), json!(label));
                    aliases.insert(name.replace("-v", "-"), json!(label));
                }
            }
        }
        let baseline_profile = if legacy_alias {
            Value::Null
        } else {
            state["previousProfileContent"].clone()
        };
        let ledger = json!({"configs":baselines,"configExisted":existence,"meta":metadata,"metaExisted":state["metaFileExisted"],"profile":baseline_profile,"writtenMode":written_mode,"writtenProfile":published,"local":local,"legacySourceSha256":storage::digest(source.as_bytes()),"aliases":aliases});
        let mut changes = vec![(native, None, Some(ledger.to_string()))];
        if legacy_alias && mode != "official" {
            let mut active = metadata.clone();
            let mut entries = active["entries"].as_array().cloned().unwrap_or_default();
            entries.retain(|e| e["id"] != super::desktop::ID);
            entries.push(json!({"id":super::desktop::ID,"name":"XwX Deck"}));
            active["entries"] = json!(entries);
            active["appliedId"] = json!(super::desktop::ID);
            changes.push((meta, meta_source, Some(active.to_string())));
            changes.push((profile, canonical_source, Some(published)));
            changes.push((
                old_profile,
                profile_source,
                state["previousProfileContent"].as_str().map(str::to_string),
            ));
        } else if published != written {
            changes.push((profile, profile_source, Some(published)));
        }
        changes.push((file, Some(source), None));
        self.desktop_commit(changes)?;
        if local {
            self.desktop_restore()?;
            self.desktop_apply(None)?;
        }
        Ok(())
    }
    pub(super) fn recover_legacy_clients(&self) -> Result<()> {
        let mut results = vec![];
        for client in ["claude", "codex"] {
            let journal = self
                .root
                .join("trace-client-backups")
                .join(format!("{client}.json"));
            let Some(source) = read(&journal)? else {
                continue;
            };
            if source.len() > 16 * 1024 * 1024 {
                return Err("旧版恢复账本过大，已保留".into());
            }
            let record: Value =
                serde_json::from_str(&source).map_err(|_| "旧版 Trace 恢复账本损坏，已保留")?;
            if record["client"] != client || ![json!(1), json!(2)].contains(&record["version"]) {
                return Err("旧版恢复账本身份不匹配，已保留".into());
            }
            let expected = if client == "codex" {
                self.config_path()
            } else {
                self.claude_path()
            };
            if Path::new(text(&record, "configPath")) != expected
                || !same_physical_path(expected.parent().ok_or("旧版路径无效")?)?
            {
                return Err("旧版恢复路径与当前客户端不匹配，未写入任何外部文件".into());
            }
            let local = endpoint(text(&record, "writtenLocalUrl"))
                .ok_or("旧版恢复账本不是本地代理地址，已保留")?;
            if TcpStream::connect_timeout(&local, Duration::from_millis(200)).is_ok() {
                return Err(
                    "旧版 Trace 代理仍在运行；请先在旧应用停止 Trace，再继续迁移。现有请求未中断"
                        .into(),
                );
            }
            let archive = self.root.join(format!(
                "legacy-recovery-{}-{}.json",
                client,
                storage::digest(source.as_bytes())
            ));
            if read(&archive)?.is_none() {
                write(&archive, &source)?;
            }
            let current = read(&expected)?;
            let (conflicts, unresolved) = if let Some(current) = current {
                let (next, conflicts, unresolved) = restore(&record, &current)?;
                if record["version"] == 2
                    && record["fileExisted"] == false
                    && current == text(&record, "writtenContent")
                    && !unresolved
                {
                    if read(&expected)?.as_deref() != Some(&current) {
                        return Err("旧版恢复时配置被外部修改，已保留".into());
                    }
                    fs::remove_file(&expected).map_err(err)?;
                } else if next != current {
                    write_checked(&expected, &current, &next)?;
                }
                (conflicts, unresolved)
            } else {
                (vec!["配置已被外部删除，保留删除结果".into()], false)
            };
            results.push(json!({"client":client,"conflicts":conflicts,"unresolvedLocal":unresolved,"archive":archive.file_name()}));
            write(
                &self.root.join("legacy-recovery-result.json"),
                &json!({"version":1,"clients":results}).to_string(),
            )?;
            if unresolved {
                return Err(
                    "旧版受管本地路由尚未恢复；外部修改已保留，恢复账本与备份未删除".into(),
                );
            }
            if read(&journal)?.as_deref() != Some(&source) {
                return Err("旧版恢复账本被外部修改，已保留".into());
            }
            fs::remove_file(journal).map_err(err)?;
        }
        self.recover_legacy_desktop()?;
        self.recover_legacy_codex_overlays()?;
        self.recover_legacy_codex_direct()?;
        // Helper process identity/control recovery is audited independently;
        // these field journals never authorize killing a recorded PID.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn field_journal_restores_only_owned_values_and_comments() {
        let record = json!({"version":2,"client":"codex","writtenLocalUrl":"http://127.0.0.1:45233","fields":[
            {"format":"toml-string","key":"base_url","sectionHeader":"[model_providers.\"my.provider\"]","previous":{"present":true,"value":"https://service.example/v1"},"writtenValue":"http://127.0.0.1:45233/v1"},
            {"format":"toml-boolean","key":"supports_websockets","sectionHeader":"[model_providers.\"my.provider\"]","previous":{"present":false},"writtenValue":true}
        ]});
        let current="# keep comment\nuser_note = \"http://127.0.0.1:45233/unrelated\"\n[model_providers.\"my.provider\"]\nbase_url = \"http://127.0.0.1:45233/v1\" # endpoint\nsupports_websockets = false\nexternal = 7\n";
        let (next, conflicts, local) = restore(&record, current).unwrap();
        assert!(next.contains("https://service.example/v1\" # endpoint"));
        assert!(next.contains("supports_websockets = false"));
        assert!(next.contains("external = 7"));
        assert!(next.starts_with("# keep comment"));
        assert_eq!(conflicts.len(), 1);
        assert!(!local);
        assert_eq!(restore(&record, &next).unwrap().0, next);
    }
    #[test]
    fn legacy_v1_claude_keeps_external_credentials_and_other_keys() {
        let record = json!({"version":1,"client":"claude","writtenLocalUrl":"http://127.0.0.1:45233","originalContent":"{\"env\":{\"ANTHROPIC_BASE_URL\":\"https://service.example/anthropic\"}}"});
        let current=json!({"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:45233","ANTHROPIC_AUTH_TOKEN":"synthetic-new"},"permissions":{"allow":["Read"]}}).to_string();
        let (next, conflicts, local) = restore(&record, &current).unwrap();
        let value: Value = serde_json::from_str(&next).unwrap();
        assert_eq!(value["env"]["ANTHROPIC_AUTH_TOKEN"], "synthetic-new");
        assert_eq!(value["permissions"]["allow"][0], "Read");
        assert!(conflicts.is_empty());
        assert!(!local);
    }
    #[test]
    fn unresolved_local_external_change_never_destroys_recovery() {
        let record = json!({"version":2,"client":"codex","writtenLocalUrl":"http://localhost:45233","fields":[{"format":"toml-string","key":"openai_base_url","previous":{"present":true,"value":"https://api.example/v1"},"writtenValue":"http://localhost:45233/v1"}]});
        let source = "openai_base_url = \"http://127.0.0.1:45233/changed\"\n";
        let (next, conflicts, local) = restore(&record, source).unwrap();
        assert_eq!(next, source);
        assert_eq!(conflicts.len(), 1);
        assert!(local);
    }
    #[test]
    fn malformed_or_unowned_fields_fail_without_overwrite() {
        let record = json!({"version":2,"client":"codex","writtenLocalUrl":"http://localhost:45233","fields":[{"format":"toml-string","key":"external","previous":{"present":false},"writtenValue":"user"}]});
        assert!(restore(&record, "external = \"user\"\n").is_err());
    }
    #[test]
    fn old_created_provider_section_is_removed_after_all_fields() {
        let record = json!({"version":2,"client":"codex","writtenLocalUrl":"http://127.0.0.1:45233","fields":[
            {"format":"toml-string","key":"name","sectionHeader":"[model_providers.xwx_deck]","previous":{"present":false},"writtenValue":"XwX Deck","removeSectionIfEmpty":true},
            {"format":"toml-string","key":"base_url","sectionHeader":"[model_providers.xwx_deck]","previous":{"present":false},"writtenValue":"http://127.0.0.1:45233/v1"}
        ]});
        let source="external = true\n[model_providers.xwx_deck]\nname = \"XwX Deck\"\nbase_url = \"http://127.0.0.1:45233/v1\"\n";
        let (next, conflicts, local) = restore(&record, source).unwrap();
        assert!(!next.contains("xwx_deck"));
        assert!(next.contains("external = true"));
        assert!(conflicts.is_empty());
        assert!(!local);
    }
}
