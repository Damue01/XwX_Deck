//! Legacy Codex lifecycle journals, read from the actual Electron managers.
//! Dead owned routes are detached without reviving the former localhost helper.
use super::*;
use std::net::TcpStream;

fn owned_local(url: &str) -> bool {
    super::legacy_recovery::endpoint(url).is_some_and(|a| (45233..=45242).contains(&a.port()))
}
fn usable_direct(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|u| {
        ["http", "https"].contains(&u.scheme())
            && u.host_str().is_some()
            && u.username().is_empty()
            && u.password().is_none()
            && !owned_local(url)
    })
}
fn check_dead(url: &str) -> Result<()> {
    if let Some(address) =
        super::legacy_recovery::endpoint(url).filter(|a| (45233..=45242).contains(&a.port()))
    {
        if TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok() {
            return Err("旧版 Codex Gateway 仍在运行，请先停止旧版 Trace；现有请求未中断".into());
        }
    }
    Ok(())
}
fn field<'a>(d: &'a DocumentMut, id: &str, key: &str) -> Option<&'a Item> {
    if id.is_empty() {
        d.get(key)
    } else {
        provider_field(d, id, key)
    }
}
fn patch(d: &mut DocumentMut, id: &str, key: &str, next: Option<&Item>) {
    if id.is_empty() {
        if let Some(next) = next {
            set_codex_field(d, key, next.clone());
        } else {
            d.remove(key);
        }
    } else if let Some(next) = next {
        set_codex_provider_field(d, id, key, next.clone());
    } else if let Some(t) = d
        .get_mut("model_providers")
        .and_then(|v| v.get_mut(id))
        .and_then(Item::as_table_like_mut)
    {
        t.remove(key);
    }
}

fn public_direct_patch(document: &mut DocumentMut, path: &str, value_json: &Value) -> Result<()> {
    let item = match value_json {
        Value::Null => None,
        Value::String(v) => Some(value(v)),
        Value::Bool(v) => Some(value(*v)),
        Value::Number(v) => Some(value(v.as_i64().ok_or("配置数值无效")?)),
        _ => return Err("配置字段值无效".into()),
    };
    if let Some(key) = path.strip_prefix("features.") {
        if let Some(item) = item {
            let existing = document.get("features").and_then(|v| v.get(key));
            document["features"][key] = restored_value(&item, existing);
        } else if let Some(table) = document
            .get_mut("features")
            .and_then(Item::as_table_like_mut)
        {
            table.remove(key);
        }
    } else if let Some(key) = path.strip_prefix("model_providers.xwx_deck.") {
        patch(document, "xwx_deck", key, item.as_ref());
    } else {
        patch(document, "", path, item.as_ref());
    }
    Ok(())
}

const DIRECT_ROOT_FIELDS: &[&str] = &[
    "model_provider",
    "model",
    "openai_base_url",
    "chatgpt_base_url",
    "model_context_window",
    "model_auto_compact_token_limit",
    "service_tier",
    "model_catalog_json",
];
const DIRECT_FEATURE_FIELDS: &[&str] = &["js_repl", "image_gen", "image_generation", "imagegenext"];
const DIRECT_PROVIDER_FIELDS: &[&str] = &[
    "auth",
    "http_headers",
    "env_http_headers",
    "name",
    "base_url",
    "wire_api",
    "requires_openai_auth",
    "supports_websockets",
    "experimental_bearer_token",
    "env_key",
    "env_key_instructions",
];

/// Release only values still owned by the recorded direct configuration. An
/// unrelated edit inside the same table must survive returning to official.
pub(super) fn release_direct_fields(current: &mut DocumentMut, ledger: &Value) -> Result<()> {
    let before = doc(text(ledger, "before"))?;
    let managed = doc(text(ledger, "managed"))?;
    for key in DIRECT_ROOT_FIELDS {
        if semantic(current.get(key)) == semantic(managed.get(key))
            && semantic(before.get(key)) != semantic(managed.get(key))
        {
            patch(current, "", key, before.get(key));
        }
    }
    for key in DIRECT_FEATURE_FIELDS {
        let path = ["features".to_string()];
        let old = super::legacy_recovery::table(&before, &path).and_then(|t| t.get(key));
        let expected = super::legacy_recovery::table(&managed, &path).and_then(|t| t.get(key));
        let actual = super::legacy_recovery::table(current, &path).and_then(|t| t.get(key));
        if semantic(actual) == semantic(expected) && semantic(old) != semantic(expected) {
            if let Some(old) = old {
                let restored = restored_value(old, actual);
                current["features"][key] = restored;
            } else if let Some(t) = current
                .get_mut("features")
                .and_then(Item::as_table_like_mut)
            {
                t.remove(key);
            }
        }
    }
    let mut ids: Vec<String> = ledger["providerIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    if ids.is_empty() {
        ids.push(text(ledger, "providerId").into());
    }
    ids.sort();
    ids.dedup();
    if ids.len() > 128 || ids.iter().any(|s| s.is_empty() || s.len() > 256) {
        return Err("Codex 直连恢复身份无效".into());
    }
    for id in ids {
        // A newly published direct definition remains usable for historical
        // sessions. Existing definitions release only their recorded fields.
        if before
            .get("model_providers")
            .and_then(|t| t.get(&id))
            .is_none()
        {
            continue;
        }
        for key in DIRECT_PROVIDER_FIELDS {
            let old = provider_field(&before, &id, key);
            let expected = provider_field(&managed, &id, key);
            if semantic(provider_field(current, &id, key)) == semantic(expected)
                && semantic(old) != semantic(expected)
            {
                patch(current, &id, key, old);
            }
        }
    }
    Ok(())
}

impl Pilot {
    fn legacy_codex_record(&self, name: &str, versions: &[u64]) -> Result<Option<(String, Value)>> {
        let Some(source) = read(&self.root.join(name))? else {
            return Ok(None);
        };
        if source.len() > 16 * 1024 * 1024 {
            return Err("旧 Codex 账本过大，已保留".into());
        }
        let record: Value =
            serde_json::from_str(&source).map_err(|_| "旧 Codex 账本损坏，原内容已保留")?;
        if !record["version"]
            .as_u64()
            .is_some_and(|v| versions.contains(&v))
            || Path::new(text(&record, "configPath")) != self.config_path()
            || !same_physical_path(self.config_path().parent().ok_or("旧 Codex 路径无效")?)?
        {
            return Err("旧 Codex 账本版本或路径不匹配，未写入外部文件".into());
        }
        Ok(Some((source, record)))
    }
    fn archive_legacy_codex(&self, name: &str, source: &str) -> Result<()> {
        let archive = self.root.join(format!(
            "legacy-recovery-{}-{}.json",
            name.trim_end_matches(".json"),
            storage::digest(source.as_bytes())
        ));
        if read(&archive)?.is_none() {
            write(&archive, source)?;
        }
        Ok(())
    }
    fn consume_legacy_codex(&self, name: &str, source: &str) -> Result<()> {
        let file = self.root.join(name);
        if read(&file)?.as_deref() != Some(source) {
            return Err("旧 Codex 账本被外部修改，已保留".into());
        }
        fs::remove_file(file).map_err(err)
    }
    pub(super) fn recover_legacy_codex_overlays(&self) -> Result<()> {
        let name = "codex-local-proxy-suspension.json";
        if let Some((source, record)) = self.legacy_codex_record(name, &[1, 2, 3])? {
            if !record["restoreOriginal"].is_boolean()
                || !record["originalBaseUrl"].is_string()
                || !usable_direct(text(&record, "directBaseUrl"))
            {
                return Err("旧 Codex 暂停账本的直连信息无效，未恢复死亡地址".into());
            }
            check_dead(text(&record, "originalBaseUrl"))?;
            let provider = if record["version"] == 1 {
                "xwx_deck"
            } else {
                record["preparedProvider"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("xwx_deck")
            };
            let location = if record["version"] == 3 {
                record["fieldLocation"]
                    .as_str()
                    .unwrap_or("provider-section")
            } else {
                "provider-section"
            };
            let (id, key) = match location {
                "provider-section" => (provider, "base_url"),
                "openai-base-url" => ("", "openai_base_url"),
                "chatgpt-base-url" => ("", "chatgpt_base_url"),
                _ => return Err("旧 Codex 暂停字段无效，账本已保留".into()),
            };
            if let Some(current) = read(&self.config_path())? {
                let mut document = doc(&current)?;
                let actual = field(&document, id, key)
                    .and_then(Item::as_str)
                    .unwrap_or("");
                let original = text(&record, "originalBaseUrl");
                let direct = text(&record, "directBaseUrl");
                if actual == original && owned_local(original) {
                    patch(&mut document, id, key, Some(&value(direct)));
                } else if owned_local(actual) {
                    return Err("旧 Codex 暂停字段的本地地址被外部修改，原内容已保留".into());
                }
                // Both an already bypassed route and a new external choice are
                // retained. Never reintroduce originalBaseUrl after old exit.
                self.archive_legacy_codex(name, &source)?;
                if document.to_string() != current {
                    write_checked(&self.config_path(), &current, &document.to_string())?;
                }
            } else {
                self.archive_legacy_codex(name, &source)?;
            }
            self.consume_legacy_codex(name, &source)?;
        }
        let name = "compatible-image-gen.json";
        if let Some((source, record)) = self.legacy_codex_record(name, &[1])? {
            if record["writtenValue"] != false
                || !record["previous"]["present"].is_boolean()
                || (record["previous"]["present"] == true
                    && !record["previous"]["value"].is_boolean())
            {
                return Err("旧图片开关恢复记录无效，已保留".into());
            }
            self.archive_legacy_codex(name, &source)?;
            if let Some(current) = read(&self.config_path())? {
                let mut document = doc(&current)?;
                let existing = document.get("features").and_then(|v| v.get("image_gen"));
                if existing.and_then(Item::as_bool) == Some(false) {
                    if record["previous"]["present"] == true {
                        let restored = restored_value(
                            &value(record["previous"]["value"].as_bool().unwrap()),
                            existing,
                        );
                        document["features"]["image_gen"] = restored;
                    } else if let Some(features) = document
                        .get_mut("features")
                        .and_then(Item::as_table_like_mut)
                    {
                        features.remove("image_gen");
                    }
                    if document
                        .get("features")
                        .and_then(Item::as_table_like)
                        .is_some_and(|t| t.is_empty())
                    {
                        let comments = document
                            .get("features")
                            .and_then(Item::as_table)
                            .map(|t| {
                                format!(
                                    "{}{}",
                                    t.decor().prefix().and_then(|s| s.as_str()).unwrap_or(""),
                                    t.decor().suffix().and_then(|s| s.as_str()).unwrap_or("")
                                )
                            })
                            .unwrap_or_default();
                        document.remove("features");
                        if comments.contains('#') {
                            document.set_trailing(format!(
                                "{}\n{}",
                                comments,
                                document.trailing().as_str().unwrap_or("")
                            ));
                        }
                    }
                    write_checked(&self.config_path(), &current, &document.to_string())?;
                }
            }
            self.consume_legacy_codex(name, &source)?;
        }
        Ok(())
    }

    fn stage_public_codex_direct(&self) -> Result<Option<String>> {
        let name = "codex-direct-restore.json";
        let Some((source, record)) = self.legacy_codex_record(name, &[1])? else {
            return Ok(None);
        };
        let fields = record["fields"]
            .as_object()
            .filter(|fields| fields.len() <= 32)
            .ok_or("旧 Codex 字段账本无效，原文件已保留")?;
        let scalar = |value: &Value| {
            value.is_null()
                || value.is_boolean()
                || value.as_str().is_some_and(|s| s.len() <= 32768)
                || value
                    .as_i64()
                    .is_some_and(|n| n.unsigned_abs() <= 9_007_199_254_740_991)
        };
        let valid_path = |path: &str| {
            (DIRECT_ROOT_FIELDS.contains(&path)
                && !["openai_base_url", "chatgpt_base_url"].contains(&path))
                || path
                    .strip_prefix("features.")
                    .is_some_and(|key| DIRECT_FEATURE_FIELDS.contains(&key))
                || path
                    .strip_prefix("model_providers.xwx_deck.")
                    .is_some_and(|key| DIRECT_PROVIDER_FIELDS.contains(&key))
        };
        if fields.iter().any(|(path, entry)| {
            !valid_path(path)
                || !entry.is_object()
                || entry.get("before").is_none()
                || entry.get("written").is_none()
                || !scalar(&entry["before"])
                || !scalar(&entry["written"])
        }) {
            return Err("旧 Codex 账本含未归属字段或无效值，未修改配置".into());
        }
        let hash = storage::digest(source.as_bytes());
        let native = self.root.join("codex-direct.json");
        if let Some(existing) = read(&native)? {
            let existing: Value =
                serde_json::from_str(&existing).map_err(|_| "Codex 直连账本损坏，已保留")?;
            if existing["publicSourceSha256"] == hash {
                self.archive_legacy_codex(name, &source)?;
                self.consume_legacy_codex(name, &source)?;
                return Ok(None);
            }
            return Err("新旧 Codex 直连账本同时存在，原配置与记录已保留".into());
        }
        let staged = self.root.join("codex-direct-config-state.json");
        if let Some(existing) = read(&staged)? {
            let existing: Value =
                serde_json::from_str(&existing).map_err(|_| "Codex 迁移账本损坏，已保留")?;
            if existing["publicSourceSha256"] != hash {
                return Err("新旧 Codex 直连账本同时存在，原配置与记录已保留".into());
            }
            return Ok(Some(source));
        }
        let current = read(&self.config_path())?.ok_or("ChatGPT 配置已被外部删除，保留恢复记录")?;
        let document = doc(&current)?;
        let mut before = document.clone();
        let mut written = document.clone();
        for (path, entry) in fields {
            public_direct_patch(&mut before, path, &entry["before"])?;
            public_direct_patch(&mut written, path, &entry["written"])?;
        }
        // Public field ownership cannot authorize restoring another provider's
        // unrecorded local endpoint. Keep the complete record for an explicit repair.
        for key in ["openai_base_url", "chatgpt_base_url"] {
            if document
                .get(key)
                .and_then(Item::as_str)
                .is_some_and(owned_local)
                && !fields.contains_key(key)
            {
                return Err("旧配置存在未归属的本地根路由，未猜测或改写配置".into());
            }
        }
        if let Some(providers) = document
            .get("model_providers")
            .and_then(Item::as_table_like)
        {
            for (id, provider) in providers.iter() {
                if provider
                    .get("base_url")
                    .and_then(Item::as_str)
                    .is_some_and(owned_local)
                    && (id != "xwx_deck"
                        || !fields.contains_key("model_providers.xwx_deck.base_url"))
                {
                    return Err("旧配置存在未归属的本地服务路由，未猜测或改写配置".into());
                }
            }
        }
        write(
            &staged,
            &json!({"version":1,"configPath":self.config_path(),"originalExisted":true,
            "originalContent":before.to_string(),"writtenContent":written.to_string(),
            "baselineWasManaged":false,"ownedFieldPaths":fields.keys().collect::<Vec<_>>(),
            "publicSourceSha256":hash})
            .to_string(),
        )?;
        Ok(Some(source))
    }

    pub(super) fn recover_legacy_codex_direct(&self) -> Result<()> {
        let public_source = self.stage_public_codex_direct()?;
        let name = "codex-direct-config-state.json";
        let Some((source, record)) = self.legacy_codex_record(name, &[1])? else {
            return Ok(());
        };
        if !record["originalExisted"].is_boolean()
            || !record["baselineWasManaged"].is_boolean()
            || !record["writtenContent"].is_string()
            || (record["originalExisted"] == true && !record["originalContent"].is_string())
        {
            return Err("旧 Codex 长期直连账本无效，原内容已保留".into());
        }
        let Some(current) = read(&self.config_path())? else {
            self.archive_legacy_codex(name, &source)?;
            return self.consume_legacy_codex(name, &source);
        };
        let original = doc(text(&record, "originalContent"))?;
        let written = doc(text(&record, "writtenContent"))?;
        let mut next = doc(&current)?;
        let mut baseline = original.clone();
        let shared = record["sharedProviderOriginalContent"]
            .as_str()
            .map(doc)
            .transpose()?;
        let definitions = record["directProviders"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if definitions.len() > 128 {
            return Err("旧 Codex 直连服务过多，账本已保留".into());
        }
        let mut ids: Vec<String> = ["xwx_deck"]
            .into_iter()
            .filter(|id| {
                written
                    .get("model_providers")
                    .and_then(|p| p.get(id))
                    .is_some()
            })
            .map(str::to_string)
            .collect();
        ids.extend(
            definitions
                .iter()
                .filter_map(|p| p["providerId"].as_str())
                .map(str::to_string),
        );
        if let Some(active) = written
            .get("model_provider")
            .and_then(Item::as_str)
            .filter(|s| *s != "openai")
        {
            ids.push(active.into());
        }
        ids.sort();
        ids.dedup();
        if ids.iter().any(|id| id.is_empty() || id.len() > 256) {
            return Err("旧 Codex provider ID 无效".into());
        }
        if record["baselineWasManaged"] == true {
            for key in DIRECT_ROOT_FIELDS {
                if !([
                    "model_provider",
                    "model",
                    "model_catalog_json",
                    "openai_base_url",
                    "chatgpt_base_url",
                ]
                .contains(key)
                    || (record["officialSelectionPromoted"] == true
                        && ["model_context_window", "model_auto_compact_token_limit"]
                            .contains(key)))
                {
                    patch(&mut baseline, "", key, next.get(key));
                }
            }
            for key in DIRECT_FEATURE_FIELDS {
                let actual = next.get("features").and_then(|t| t.get(key));
                if let Some(actual) = actual {
                    baseline["features"][key] = actual.clone();
                } else if let Some(t) = baseline
                    .get_mut("features")
                    .and_then(Item::as_table_like_mut)
                {
                    t.remove(key);
                }
            }
            set_codex_field(&mut baseline, "model_provider", value("openai"));
            set_codex_field(
                &mut baseline,
                "model",
                value(
                    self.settings.codex_models["official"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or("gpt-5.5"),
                ),
            );
            baseline.remove("model_catalog_json");
        }
        for key in ["openai_base_url", "chatgpt_base_url"] {
            if baseline
                .get(key)
                .and_then(Item::as_str)
                .is_some_and(owned_local)
            {
                baseline.remove(key);
            }
            if let Some(actual) = next
                .get(key)
                .and_then(Item::as_str)
                .filter(|s| owned_local(s))
            {
                check_dead(actual)?;
                if semantic(next.get(key)) != semantic(written.get(key)) {
                    return Err("旧 Codex 根路由已被外部修改，未覆盖".into());
                }
                patch(&mut next, "", key, baseline.get(key));
            }
        }
        for id in &ids {
            if id == "xwx_deck" {
                if let Some(shared) = shared.as_ref() {
                    for key in DIRECT_PROVIDER_FIELDS {
                        patch(&mut baseline, id, key, provider_field(shared, id, key));
                    }
                }
            }
            let actual = provider_field(&next, id, "base_url")
                .and_then(Item::as_str)
                .unwrap_or("")
                .to_string();
            let old = provider_field(&baseline, id, "base_url")
                .and_then(Item::as_str)
                .unwrap_or("")
                .to_string();
            if owned_local(&actual) {
                check_dead(&actual)?;
                if semantic(provider_field(&next, id, "base_url"))
                    != semantic(provider_field(&written, id, "base_url"))
                {
                    return Err(format!("旧 Codex {id} 本地路由已被外部修改，未覆盖"));
                }
            }
            if owned_local(&old) || (owned_local(&actual) && !usable_direct(&old)) {
                let matches: Vec<_> = definitions
                    .iter()
                    .filter(|p| p["providerId"] == *id && usable_direct(text(p, "baseUrl")))
                    .collect();
                let first = matches.first().copied();
                if first.is_some_and(|first| matches.iter().any(|p| *p != first)) {
                    return Err(format!("旧 Codex {id} 直连服务不唯一，未猜测地址或凭据"));
                }
                if let Some(definition) = first {
                    let base = text(definition, "baseUrl").trim_end_matches('/');
                    set_codex_provider_field(&mut baseline, id, "base_url", value(base));
                    set_codex_provider_field(
                        &mut baseline,
                        id,
                        "name",
                        value(definition["providerName"].as_str().unwrap_or(id)),
                    );
                    set_codex_provider_field(&mut baseline, id, "wire_api", value("responses"));
                    set_codex_provider_field(
                        &mut baseline,
                        id,
                        "experimental_bearer_token",
                        value(text(definition, "bearerToken")),
                    );
                    set_codex_provider_field(
                        &mut baseline,
                        id,
                        "requires_openai_auth",
                        value(false),
                    );
                    set_codex_provider_field(
                        &mut baseline,
                        id,
                        "supports_websockets",
                        value(false),
                    );
                } else if usable_direct(&actual) {
                    for key in DIRECT_PROVIDER_FIELDS {
                        patch(&mut baseline, id, key, provider_field(&next, id, key));
                    }
                } else {
                    return Err(format!("旧 Codex {id} 缺少可核对的原直连配置；请在旧应用恢复直连后继续，原账本已保留"));
                }
            }
            if owned_local(&actual) {
                for key in DIRECT_PROVIDER_FIELDS {
                    if semantic(provider_field(&next, id, key))
                        == semantic(provider_field(&written, id, key))
                    {
                        patch(&mut next, id, key, provider_field(&baseline, id, key));
                    }
                }
            }
        }
        // Rebase newer external edits into the recovery baseline rather than
        // adopting them as values which a later official switch may erase.
        for key in DIRECT_ROOT_FIELDS {
            if semantic(next.get(key)) != semantic(written.get(key))
                && semantic(next.get(key)) != semantic(baseline.get(key))
            {
                patch(&mut baseline, "", key, next.get(key));
            }
        }
        for key in DIRECT_FEATURE_FIELDS {
            let actual = next.get("features").and_then(|t| t.get(key));
            let expected = written.get("features").and_then(|t| t.get(key));
            let old = baseline.get("features").and_then(|t| t.get(key));
            if semantic(actual) != semantic(expected) && semantic(actual) != semantic(old) {
                if let Some(actual) = actual {
                    baseline["features"][key] = actual.clone();
                } else if let Some(t) = baseline
                    .get_mut("features")
                    .and_then(Item::as_table_like_mut)
                {
                    t.remove(key);
                }
            }
        }
        for id in &ids {
            for key in DIRECT_PROVIDER_FIELDS {
                if semantic(provider_field(&next, id, key))
                    != semantic(provider_field(&written, id, key))
                    && semantic(provider_field(&next, id, key))
                        != semantic(provider_field(&baseline, id, key))
                {
                    patch(&mut baseline, id, key, provider_field(&next, id, key));
                }
            }
        }
        let active = next
            .get("model_provider")
            .and_then(Item::as_str)
            .unwrap_or("openai");
        let hash = storage::digest(source.as_bytes());
        let native = self.root.join("codex-direct.json");
        if let Some(existing) = read(&native)? {
            let existing: Value =
                serde_json::from_str(&existing).map_err(|_| "新 Codex 直连账本损坏，未覆盖")?;
            if existing["legacySourceSha256"] != hash {
                return Err("新旧 Codex 直连账本同时存在，原配置与记录已保留".into());
            }
        }
        self.archive_legacy_codex(name, &source)?;
        write(&native,&json!({"providerId":active,"providerIds":ids,"before":baseline.to_string(),"managed":next.to_string(),"legacySourceSha256":hash,"publicSourceSha256":record["publicSourceSha256"]}).to_string())?;
        if next.to_string() != current {
            write_checked(&self.config_path(), &current, &next.to_string())?;
        }
        self.consume_legacy_codex(name, &source)?;
        if let Some(public_source) = public_source {
            self.archive_legacy_codex("codex-direct-restore.json", &public_source)?;
            self.consume_legacy_codex("codex-direct-restore.json", &public_source)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod direct_tests {
    use super::*;
    #[test]
    fn release_all_legacy_direct_fields_without_reverting_foreign_edits() {
        let before="model = \"official\"\nservice_tier = \"flex\"\n[features]\njs_repl = true\n[model_providers.custom_provider]\nname = \"old\"\nbase_url = \"https://old.fixture/v1\"\n[model_providers.xwx_deck]\nbase_url = \"https://shared.fixture/v1\"\nrequires_openai_auth = true\n";
        let managed="model = \"service\"\nservice_tier = \"default\"\n[features]\njs_repl = false\n[model_providers.custom_provider]\nname = \"new\"\nbase_url = \"https://new.fixture/v1\"\n[model_providers.xwx_deck]\nbase_url = \"https://api.fixture/v1\"\nrequires_openai_auth = false\nexperimental_bearer_token = \"synthetic\"\n";
        let mut current = doc(&managed
            .replace(
                "service_tier = \"default\"",
                "service_tier = \"latest\" # preserve",
            )
            .replace("name = \"new\"", "name = \"new\" # user note")
            .replace("[features]", "[external]\nkeep = true\n[features]"))
        .unwrap();
        let ledger = json!({"before":before,"managed":managed,"providerId":"xwx_deck","providerIds":["custom_provider","xwx_deck"]});
        release_direct_fields(&mut current, &ledger).unwrap();
        let next = current.to_string();
        assert!(next.contains("model = \"official\""));
        assert!(next.contains("service_tier = \"latest\" # preserve"));
        assert!(next.contains("js_repl = true"));
        assert!(next.contains("https://old.fixture/v1"));
        assert!(next.contains("https://shared.fixture/v1"));
        assert!(next.contains("name = \"old\" # user note"));
        assert!(next.contains("keep = true"));
        assert!(!next.contains("synthetic"));
        assert_eq!(release_direct_fields(&mut current, &ledger), Ok(()));
        assert_eq!(next, current.to_string());
    }
    #[test]
    fn mapped_loopback_is_owned_and_other_local_servers_are_valid_direct() {
        assert!(owned_local("http://[::ffff:127.0.0.1]:45233/v1"));
        assert!(!usable_direct("http://[::ffff:127.0.0.1]:45233/v1"));
        assert!(usable_direct("http://127.0.0.1:11434/v1"));
        assert!(!usable_direct("https://user:password@fixture.example/v1"));
    }
}
