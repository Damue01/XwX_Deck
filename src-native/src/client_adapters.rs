//! Versioned consumer contracts, using the existing ownership/rollback ledger.
use super::*;
use serde_yaml_ng::Value as Yaml;

fn yaml(source: &str) -> Result<Yaml> {
    serde_yaml_ng::from_str(source).map_err(|_| "YAML 配置无法识别，原文件已保留".into())
}
fn encoded(value: &Value) -> Result<Yaml> {
    serde_yaml_ng::to_value(value).map_err(err)
}
fn output(value: &Yaml) -> Result<String> {
    serde_yaml_ng::to_string(value).map_err(err)
}

fn toml_at<'a>(item: &'a toml_edit::Item, path: &[&str]) -> Option<&'a toml_edit::Item> {
    let mut item = item;
    for key in path {
        item = item.get(key)?;
    }
    if item.is_none() {
        None
    } else {
        Some(item)
    }
}
fn toml_set(item: &mut toml_edit::Item, path: &[&str], value: toml_edit::Item) -> Result<()> {
    if path.is_empty() {
        return Err("TOML 配置字段为空".into());
    }
    let mut item = item;
    for key in &path[..path.len() - 1] {
        if item.is_none() {
            *item = toml_edit::Item::Table(toml_edit::Table::new());
        }
        if !item.is_table_like() {
            return Err("TOML 配置字段类型不匹配，原文件已保留".into());
        }
        item = &mut item[*key];
    }
    if item.is_none() {
        *item = toml_edit::Item::Table(toml_edit::Table::new());
    }
    if !item.is_table_like() {
        return Err("TOML 配置字段类型不匹配，原文件已保留".into());
    }
    item[path[path.len() - 1]] = value;
    Ok(())
}
fn toml_plan(path: &Path, edits: Vec<(Vec<&str>, toml_edit::Item)>) -> Result<Value> {
    let before = read(path)?.unwrap_or_default();
    let mut doc = before
        .parse::<toml_edit::DocumentMut>()
        .map_err(|_| "TOML 配置无法识别，原文件已保留")?;
    let mut keys = vec![];
    for (path, value) in edits {
        toml_set(doc.as_item_mut(), &path, value)?;
        keys.push(path);
    }
    Ok(
        json!({"file":path,"before":before,"beforeExisted":path.exists(),"content":doc.to_string(),"toml":true,"keys":keys}),
    )
}
pub(super) fn restore_toml(current: &str, plan: &Value) -> Result<String> {
    let mut doc = current.parse::<toml_edit::DocumentMut>().map_err(err)?;
    let before = text(plan, "before")
        .parse::<toml_edit::DocumentMut>()
        .map_err(err)?;
    let managed = text(plan, "content")
        .parse::<toml_edit::DocumentMut>()
        .map_err(err)?;
    for key in plan["keys"].as_array().ok_or("TOML 恢复证据损坏")? {
        let path: Vec<_> = key
            .as_array()
            .ok_or("TOML 恢复字段损坏")?
            .iter()
            .filter_map(Value::as_str)
            .collect();
        let cur = toml_at(doc.as_item(), &path).map(ToString::to_string);
        let old = toml_at(before.as_item(), &path);
        if cur != old.map(ToString::to_string)
            && cur != toml_at(managed.as_item(), &path).map(ToString::to_string)
        {
            return Err("客户端 TOML 配置被外部修改，原文件与恢复证据已保留".into());
        }
        toml_set(
            doc.as_item_mut(),
            &path,
            old.cloned().unwrap_or(toml_edit::Item::None),
        )?;
    }
    for key in plan["keys"].as_array().ok_or("TOML 恢复证据损坏")? {
        let path: Vec<_> = key
            .as_array()
            .ok_or("TOML 恢复字段损坏")?
            .iter()
            .filter_map(Value::as_str)
            .collect();
        for depth in (1..path.len()).rev() {
            let prefix = &path[..depth];
            if toml_at(before.as_item(), prefix).is_none()
                && toml_at(doc.as_item(), prefix)
                    .and_then(toml_edit::Item::as_table_like)
                    .is_some_and(|table| table.is_empty())
            {
                toml_set(doc.as_item_mut(), prefix, toml_edit::Item::None)?;
            }
        }
    }
    Ok(doc.to_string())
}

fn model_group(source: &str, name: &str, replacement: Option<&Value>) -> Result<String> {
    let document_value = parsed(source)?;
    let rows = document_value.as_array().ok_or("模型配置必须是列表")?;
    let bytes = clean(source)?;
    let mut ranges = vec![];
    let mut at = ws(&bytes, ws(&bytes, 0) + 1);
    for _ in rows {
        let finish = end(&bytes, at)?;
        ranges.push((at, finish));
        at = ws(&bytes, finish);
        if bytes.get(at) == Some(&b',') {
            at = ws(&bytes, at + 1);
        }
    }
    let matches: Vec<_> = rows
        .iter()
        .enumerate()
        .filter(|(_, row)| row["name"] == name)
        .map(|(i, _)| i)
        .collect();
    if matches.len() > 1 {
        return Err("模型分组名称重复，原配置已保留".into());
    }
    if let Some(&i) = matches.first() {
        let (mut start, mut finish) = ranges[i];
        let value = replacement.map(Value::to_string).unwrap_or_default();
        if replacement.is_none() {
            if i + 1 < ranges.len() {
                finish = ws(&bytes, finish) + 1;
            } else if i > 0 {
                start = ws(&bytes, ranges[i - 1].1);
            }
        }
        return Ok(format!(
            "{}{}{}",
            &source[..start],
            value,
            &source[finish..]
        ));
    }
    let Some(replacement) = replacement else {
        return Ok(source.into());
    };
    let close = bytes
        .iter()
        .rposition(|b| *b == b']')
        .ok_or("模型列表未结束")?;
    let mut content = source.to_owned();
    // clean() masks a trailing comma. Insert before the final item so either
    // existing comma style remains valid and comments keep their exact bytes.
    if let Some((start, _)) = ranges.last() {
        content.insert_str(*start, &format!("{},\n", replacement));
    } else {
        content.insert_str(close, &replacement.to_string());
    }
    parsed(&content)?;
    Ok(content)
}
fn group_plan(path: &Path, group: Value) -> Result<Value> {
    let source = read(path)?.unwrap_or("[]".into());
    let value = parsed(&source)?;
    let before = value
        .as_array()
        .ok_or("模型配置必须是列表")?
        .iter()
        .find(|row| row["name"] == "XwX Deck")
        .cloned();
    let content = model_group(&source, "XwX Deck", Some(&group))?;
    Ok(
        json!({"file":path,"before":source,"beforeExisted":path.exists(),"content":content,"jsonGroup":true,"beforeGroup":before,"managedGroup":group}),
    )
}
pub(super) fn restore_group(current: &str, plan: &Value) -> Result<String> {
    let value = parsed(current)?;
    let rows = value.as_array().ok_or("模型配置必须是列表")?;
    let group = rows.iter().find(|row| row["name"] == "XwX Deck");
    let before = if plan["beforeGroup"].is_null() {
        None
    } else {
        Some(&plan["beforeGroup"])
    };
    if group != Some(&plan["managedGroup"]) && group != before {
        return Err("模型分组被外部修改，原文件与恢复证据已保留".into());
    }
    model_group(current, "XwX Deck", before)
}

pub(super) fn paths(pilot: &Pilot, id: &str) -> Result<Option<Vec<PathBuf>>> {
    let home = pilot.client_home();
    Ok(Some(match id {
        "kimi-code" => {
            let modern = pilot.wiring_directory("KIMI_CODE_HOME", home.join(".kimi-code"));
            let legacy = pilot.wiring_directory("KIMI_SHARE_DIR", home.join(".kimi"));
            vec![if modern.is_dir() || !legacy.is_dir() {
                modern.join("config.toml")
            } else {
                legacy.join("config.toml")
            }]
        }
        "grok-build" => vec![pilot
            .wiring_directory("GROK_HOME", home.join(".grok"))
            .join("config.toml")],
        "deepseek-harness" => {
            let dir = pilot.wiring_directory("DSH_HOME", home.join(".dsh"));
            let mut files = vec![];
            if let Ok(entries) = fs::read_dir(dir.join("profiles")) {
                for entry in entries.take(128).flatten() {
                    let path = entry.path().join("cordis.patch.yml");
                    if path.is_file() {
                        files.push(path);
                    }
                }
            }
            if files.is_empty() {
                if dir.join("config.yaml").exists() {
                    return Err("请更新 DeepSeek Harness 后重试；原配置已保留".into());
                }
                files.push(dir.join("profiles/desktop/cordis.patch.yml"));
            }
            files.sort();
            files.push(dir.join(".credentials.yaml"));
            files
        }
        "cline" => {
            let dir = pilot.wiring_directory("CLINE_DIR", home.join(".cline"));
            let data = pilot.wiring_directory("CLINE_DATA_DIR", dir.join("data"));
            vec![
                data.join("settings/providers.json"),
                data.join("settings/models.json"),
                data.join("globalState.json"),
                data.join("secrets.json"),
            ]
        }
        "vscode" => {
            let portable = pilot
                .settings
                .other
                .get("clientInstallationLocations")
                .and_then(|locations| locations.get("vscode"))
                .and_then(Value::as_str)
                .map(PathBuf::from)
                .map(|root| root.join("data"));
            let dir = if cfg!(windows) && portable.as_ref().is_some_and(|path| path.is_dir()) {
                let data = portable.unwrap();
                if pilot.isolated
                    && !data.canonicalize().is_ok_and(|path| {
                        path.starts_with(pilot.root.canonicalize().unwrap_or_default())
                    })
                {
                    return Err("便携版配置不在本次隔离目录中".into());
                }
                data.join("user-data/User")
            } else if cfg!(windows) {
                pilot
                    .wiring_directory("APPDATA", home.join("AppData/Roaming"))
                    .join("Code/User")
            } else if cfg!(target_os = "macos") {
                home.join("Library/Application Support/Code/User")
            } else {
                pilot
                    .wiring_directory("XDG_CONFIG_HOME", home.join(".config"))
                    .join("Code/User")
            };
            let mut files = vec![
                dir.join("chatLanguageModels.json"),
                dir.join("settings.json"),
            ];
            // Only profiles registered by VS Code, including explicit default inheritance.
            if let Some(source) = read(&dir.join("globalStorage/storage.json"))? {
                let storage = parsed(&source)?;
                for profile in storage["userDataProfiles"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .take(128)
                {
                    let location = profile["location"]
                        .as_str()
                        .or_else(|| profile["location"]["fsPath"].as_str())
                        .unwrap_or("");
                    if location.is_empty() {
                        continue;
                    }
                    let candidate = PathBuf::from(location);
                    let path = if candidate.is_absolute() {
                        candidate
                    } else {
                        dir.join("profiles").join(candidate)
                    };
                    if path.parent() != Some(dir.join("profiles").as_path()) {
                        continue;
                    }
                    if path.is_dir() {
                        if profile["useDefaultFlags"]["languageModels"] != true {
                            files.push(path.join("chatLanguageModels.json"));
                        }
                        if profile["useDefaultFlags"]["settings"] != true {
                            files.push(path.join("settings.json"));
                        }
                    }
                }
            }
            files
        }
        _ => return Ok(None),
    }))
}

// Preserve the original YAML bytes (including !!js entries and comments).
// DSH applies the last config row for each id. Append our merged overrides.
fn dsh_plan(path: &Path, base: &str, model: &str, api: &str, metadata: &Value) -> Result<Value> {
    let before = read(path)?.unwrap_or_default();
    let rows = yaml(if before.trim().is_empty() {
        "[]"
    } else {
        &before
    })?;
    let rows = rows
        .as_sequence()
        .ok_or("Harness 配置必须是 patch 列表，原文件已保留")?;
    let mut provider =
        encoded(&json!({"id":"llm-pi-ai","name":"@deepseek-ai/dsh-llm-pi-ai","config":{}}))?;
    let mut selection = encoded(&json!({"id":"agent-default-model","config":{}}))?;
    for row in rows {
        if row["id"].as_str() == Some("llm-pi-ai") {
            provider = row.clone();
        }
        if row["id"].as_str() == Some("agent-default-model") {
            selection = row.clone();
        }
    }
    if !provider.is_mapping()
        || !selection.is_mapping()
        || (!provider["config"].is_null() && !provider["config"].is_mapping())
        || (!selection["config"].is_null() && !selection["config"].is_mapping())
        || (!provider["config"]["providers"].is_null()
            && !provider["config"]["providers"].is_mapping())
    {
        return Err("Harness 模型配置格式无法识别，原文件已保留".into());
    }
    if provider["config"].is_null() {
        provider["config"] = encoded(&json!({}))?;
    }
    if provider["config"]["providers"].is_null() {
        provider["config"]["providers"] = encoded(&json!({}))?;
    }
    let mut spec = json!({"id":model,"name":model});
    if let Some(context) = metadata
        .get("contextWindow")
        .and_then(Value::as_u64)
        .filter(|n| *n > 0)
    {
        spec["contextWindow"] = json!(context);
    }
    if let Some(max) = metadata
        .get("maxOutputTokens")
        .and_then(Value::as_u64)
        .filter(|n| *n > 0)
    {
        spec["maxTokens"] = json!(max);
    }
    let input: Vec<_> = metadata["inputModalities"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|value| *value == "text" || *value == "image")
        .cloned()
        .collect();
    spec["input"] = if input.is_empty() {
        json!(["text"])
    } else {
        json!(input)
    };
    provider["config"]["providers"]["xwx-deck"] = encoded(
        &json!({"displayName":"XwX Deck","apiKeyEnv":"XWX_DECK_GATEWAY_KEY","api":api,"baseURL":base,"models":[spec]}),
    )?;
    if selection["config"].is_null() {
        selection["config"] = encoded(&json!({}))?;
    }
    selection["config"]["provider"] = Yaml::String("xwx-deck".into());
    selection["config"]["model"] = Yaml::String(model.into());
    // Effort belongs to the old model. Do not carry it into a different one.
    if let Some(config) = selection["config"].as_mapping_mut() {
        config.remove(Yaml::String("reasoningEffort".into()));
    }
    let block = format!(
        "# XwX Deck managed models begin\n{}# XwX Deck managed models end\n",
        output(&Yaml::Sequence(vec![provider, selection]))?
    );
    if before.contains("# XwX Deck managed models begin") {
        return Err("Harness 已有接管片段，请先恢复配置".into());
    }
    // Remove the empty-list placeholder only; preserve the header and comments.
    let mut content = if rows.is_empty() {
        before
            .lines()
            .filter(|line| line.trim() != "[]")
            .map(|line| format!("{line}\n"))
            .collect::<String>()
    } else {
        before.clone()
    };
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&block);
    yaml(&content)?;
    Ok(
        json!({"file":path,"before":before,"beforeExisted":path.exists(),"content":content,"yamlBlock":true,"block":block}),
    )
}
pub(super) fn restore_yaml_block(current: &str, plan: &Value) -> Result<String> {
    let block = text(plan, "block");
    if current == text(plan, "before") {
        return Ok(current.into());
    }
    if block.is_empty() {
        return Err("Harness 恢复证据损坏".into());
    }
    let expected = yaml(block)?;
    let mut starts = vec![];
    let mut offset = 0;
    for line in current.split_inclusive('\n') {
        if line.starts_with("- ") {
            starts.push(offset);
        }
        offset += line.len();
    }
    let mut ranges = vec![];
    for (i, start) in starts.iter().enumerate() {
        let finish = starts.get(i + 1).copied().unwrap_or(current.len());
        let row = yaml(&current[*start..finish])?;
        let row = row
            .as_sequence()
            .and_then(|rows| rows.first())
            .ok_or("Harness 恢复配置不是条目列表")?
            .clone();
        ranges.push((*start, finish, row));
    }
    let mut removals = vec![];
    for row in expected.as_sequence().ok_or("Harness 恢复证据损坏")? {
        let candidate = ranges
            .iter()
            .rfind(|(_, _, actual)| actual["id"] == row["id"])
            .ok_or("Harness 接管条目被删除，恢复证据已保留")?;
        if candidate.2 != *row {
            return Err("Harness 接管配置被外部修改，原文件与恢复证据已保留".into());
        }
        removals.push((candidate.0, candidate.1));
    }
    removals.sort();
    let mut restored = current.to_owned();
    for (start, finish) in removals.into_iter().rev() {
        let comments = current[start..finish]
            .split_inclusive('\n')
            .filter(|line| {
                line.trim_start().starts_with('#') && !line.contains("XwX Deck managed models")
            })
            .collect::<String>();
        restored.replace_range(start..finish, &comments);
    }
    restored = restored
        .replace("# XwX Deck managed models begin\n", "")
        .replace("# XwX Deck managed models end\n", "");
    if restored
        .lines()
        .all(|line| line.trim().is_empty() || line.trim().starts_with('#'))
    {
        restored.push_str("[]\n");
    }
    Ok(restored)
}

// DSH's desktop credentials are a versioned YAML map, not the CLI's .env.
// Edit just the dedicated non-secret loopback key; all other bytes survive.
fn credential_plan(path: &Path) -> Result<Value> {
    let before = read(path)?.unwrap_or_default();
    let value = yaml(if before.trim().is_empty() {
        "{}"
    } else {
        &before
    })?;
    if !value.is_mapping()
        || (!value.is_null() && value["version"].as_i64().is_some_and(|v| v != 1))
    {
        return Err("Harness 凭据格式无法识别，原文件已保留".into());
    }
    if !before.trim().is_empty() && value["version"].as_i64() != Some(1) {
        return Err("Harness 凭据版本无法识别，原文件已保留".into());
    }
    let key = "XWX_DECK_GATEWAY_KEY";
    let old = value["refs"][key].as_str();
    let mut content = before.clone();
    if before.trim().is_empty() {
        content = "version: 1\nrefs:\n".into();
    }
    if old.is_some() {
        // Require an ordinary block scalar so unrelated secrets and comments are retained.
        let re = regex::Regex::new(r"(?m)^([ \t]+)XWX_DECK_GATEWAY_KEY:[^\r\n]*").unwrap();
        if re.find_iter(&content).count() != 1 {
            return Err("Harness 凭据字段无法安全编辑，原文件已保留".into());
        }
        content = re
            .replace(&content, "${1}XWX_DECK_GATEWAY_KEY: xwx-deck")
            .into_owned();
    } else {
        let re = regex::Regex::new(r"(?m)^refs:[ \t]*(?:#[^\r\n]*)?\r?$").unwrap();
        if let Some(found) = re.find(&content) {
            content.insert_str(found.end(), "\n  XWX_DECK_GATEWAY_KEY: xwx-deck");
        } else if value["refs"]
            .as_mapping()
            .is_some_and(|refs| refs.is_empty())
        {
            // Harness serializes an empty store as `refs: {}` after writing
            // its browser grant. Expand only this empty map, retaining records.
            let empty =
                regex::Regex::new(r"(?m)^(refs:[ \t]*)\{\}([ \t]*(?:#[^\r\n]*)?)(\r?)$").unwrap();
            if empty.find_iter(&content).count() != 1 {
                return Err("Harness refs 格式无法安全编辑，原文件已保留".into());
            }
            content = empty
                .replace(
                    &content,
                    "${1}${2}${3}\n  XWX_DECK_GATEWAY_KEY: xwx-deck${3}",
                )
                .into_owned();
        } else if value["refs"].is_null() {
            if !content.ends_with('\n') {
                content.push('\n');
            }
            content.push_str("refs:\n  XWX_DECK_GATEWAY_KEY: xwx-deck\n");
        } else {
            return Err("Harness refs 格式无法安全编辑，原文件已保留".into());
        }
    }
    if yaml(&content)?["refs"][key].as_str() != Some("xwx-deck") {
        return Err("Harness 凭据未能写入，原文件已保留".into());
    }
    Ok(
        json!({"file":path,"before":before,"beforeExisted":path.exists(),"content":content,"yamlMapping":true,"beforeKey":old}),
    )
}
pub(super) fn restore_yaml_mapping(current: &str, plan: &Value) -> Result<String> {
    let value = yaml(current)?;
    let key = value["refs"]["XWX_DECK_GATEWAY_KEY"].as_str();
    if key == plan["beforeKey"].as_str() {
        return Ok(current.into());
    }
    if key != Some("xwx-deck") {
        return Err("Harness 凭据被外部修改，原文件与恢复证据已保留".into());
    }
    let re = regex::Regex::new(r"(?m)^([ \t]+)XWX_DECK_GATEWAY_KEY:[^\r\n]*(?:\r?\n|$)").unwrap();
    if re.find_iter(current).count() != 1 {
        return Err("Harness 凭据恢复字段无法识别".into());
    }
    let replacement = plan["beforeKey"]
        .as_str()
        .map(|v| format!("${{1}}XWX_DECK_GATEWAY_KEY: {}\n", json!(v)))
        .unwrap_or_default();
    let mut restored = re.replace(current, replacement.as_str()).into_owned();
    if yaml(&restored)?["refs"].is_null() {
        let header = regex::Regex::new(r"(?m)^refs:[ \t]*(#[^\r\n]*)?\r?$").unwrap();
        restored = header.replace(&restored, "refs: {} $1").into_owned();
    }
    Ok(restored)
}

pub(super) fn plan(
    pilot: &Pilot,
    id: &str,
    port: u16,
    route: &Value,
) -> Result<Option<Vec<Value>>> {
    if ![
        "deepseek-harness",
        "cline",
        "vscode",
        "kimi-code",
        "grok-build",
    ]
    .contains(&id)
    {
        return Ok(None);
    }
    let paths = pilot.wiring_paths(id)?;
    let model = text(route, "model");
    let base = format!("http://127.0.0.1:{port}/clients/{id}/v1");
    let provider = pilot
        .settings
        .connections
        .iter()
        .find(|p| p.id == text(route, "providerId"))
        .ok_or("模型服务不存在")?;
    let metadata = read(&provider_cache_for_adapter(&pilot.root, provider))
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str::<Value>(&v).ok())
        .and_then(|v| {
            v["entries"]
                .as_array()
                .and_then(|rows| rows.iter().find(|m| m["id"] == model).cloned())
        })
        .unwrap_or(json!({}));
    let wire = catalog::wire(&pilot.root, provider, Some(model), "anthropic-messages");
    let api = match wire.as_str() {
        "responses" | "openai-responses" => "openai-responses",
        "anthropic" | "messages" | "anthropic-messages" => "anthropic-messages",
        _ => "openai-completions",
    };
    let mut plans = vec![];
    if id == "kimi-code" || id == "grok-build" {
        let key = format!("xwx_deck/{model}");
        let string = |s: &str| toml_edit::value(s);
        let mut edits = if id == "kimi-code" {
            vec![
                (vec!["providers", "xwx_deck", "type"], string("kimi")),
                (vec!["providers", "xwx_deck", "base_url"], string(&base)),
                (vec!["providers", "xwx_deck", "api_key"], string("xwx-deck")),
                (vec!["models", &key, "provider"], string("xwx_deck")),
                (vec!["models", &key, "model"], string(model)),
                (
                    vec!["models", &key, "max_context_size"],
                    toml_edit::value(metadata["contextWindow"].as_i64().unwrap_or(128000)),
                ),
                (vec!["default_model"], string(&key)),
            ]
        } else {
            vec![
                (vec!["model", &key, "model"], string(model)),
                (vec!["model", &key, "name"], string(model)),
                (vec!["model", &key, "base_url"], string(&base)),
                (vec!["model", &key, "api_key"], string("xwx-deck")),
                (
                    vec!["model", &key, "api_backend"],
                    string("chat_completions"),
                ),
                (vec!["models", "default"], string(&key)),
            ]
        };
        if id == "grok-build" {
            edits.push((vec!["features", "campaigns"], toml_edit::value(false)));
        }
        if id == "kimi-code"
            && paths[0]
                != pilot
                    .wiring_directory("KIMI_SHARE_DIR", pilot.client_home().join(".kimi"))
                    .join("config.toml")
        {
            let mut caps = toml_edit::Array::new();
            caps.push("tool_use");
            edits.push((vec!["models", &key, "capabilities"], toml_edit::value(caps)));
        }
        plans.push(toml_plan(&paths[0], edits)?);
    } else if id == "deepseek-harness" {
        let dsh_base = if api == "anthropic-messages" {
            base.trim_end_matches("/v1")
        } else {
            &base
        };
        for path in &paths[..paths.len() - 1] {
            plans.push(dsh_plan(path, dsh_base, model, api, &metadata)?);
        }
        plans.push(credential_plan(paths.last().unwrap())?);
    } else if id == "cline" {
        if !pilot.client_discovery().management_supported(id) {
            return Err("当前 Cline 版本不支持此配置方式，请更新后重试".into());
        }
        let mut cline_model = json!({"id":model,"name":model,"capabilities":["streaming","tools"]});
        for (from, to) in [
            ("contextWindow", "contextWindow"),
            ("maxOutputTokens", "maxTokens"),
        ] {
            if let Some(value) = metadata
                .get(from)
                .filter(|value| value.as_u64().is_some_and(|n| n > 0))
            {
                cline_model[to] = value.clone();
            }
        }
        plans.push(json_plan(
            &paths[0],
            vec![
                (vec!["version"], json!(1)),
                (vec!["lastUsedProvider"], json!("openai-compatible")),
                (
                    vec!["providers", "openai-compatible", "settings", "provider"],
                    json!("openai-compatible"),
                ),
                (
                    vec!["providers", "openai-compatible", "settings", "model"],
                    json!(model),
                ),
                (
                    vec!["providers", "openai-compatible", "settings", "baseUrl"],
                    json!(base),
                ),
                (
                    vec!["providers", "openai-compatible", "settings", "apiKey"],
                    json!("xwx-deck"),
                ),
                (
                    vec!["providers", "openai-compatible", "tokenSource"],
                    json!("manual"),
                ),
            ],
        )?);
        plans.push(json_plan(&paths[1], vec![(vec!["providers","openai-compatible"],json!({"provider":{"name":"XwX Deck","baseUrl":base,"defaultModelId":model},"models":{model:cline_model}}))])?);
        plans.push(json_plan(
            &paths[2],
            vec![
                (vec!["actModeApiProvider"], json!("openai")),
                (vec!["planModeApiProvider"], json!("openai")),
                (vec!["actModeOpenAiModelId"], json!(model)),
                (vec!["planModeOpenAiModelId"], json!(model)),
                (vec!["openAiBaseUrl"], json!(base)),
                (vec!["actModeOpenAiModelInfo"], Value::Null),
                (vec!["planModeOpenAiModelInfo"], Value::Null),
            ],
        )?);
        plans.push(json_plan(
            &paths[3],
            vec![(vec!["openAiApiKey"], json!("xwx-deck"))],
        )?);
    } else {
        if !pilot.client_discovery().management_supported(id) {
            return Err("当前 VS Code 版本不支持模型配置，请更新后重试".into());
        }
        for path in &paths {
            let api_type = match api {
                "openai-responses" => "responses",
                "anthropic-messages" => "messages",
                _ => "chat-completions",
            };
            let endpoint = match api_type {
                "responses" => "responses",
                "messages" => "messages",
                _ => "chat/completions",
            };
            if path
                .file_name()
                .is_some_and(|name| name == "chatLanguageModels.json")
            {
                plans.push(group_plan(path, json!({"name":"XwX Deck","vendor":"customendpoint","apiType":api_type,"models":[{"id":model,"name":model,"url":format!("{base}/{endpoint}"),"toolCalling":true,"requestHeaders":{"Authorization":"Bearer xwx-deck"}}]}))?);
            } else {
                plans.push(json_plan(
                    path,
                    vec![(vec!["chat.defaultModel"], json!(model))],
                )?);
            }
        }
    }
    Ok(Some(plans))
}
fn provider_cache_for_adapter(root: &Path, provider: &Provider) -> PathBuf {
    root.join(format!(
        "provider-{}-models.json",
        &storage::digest(provider.id.as_bytes())[..24]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn toml_restore_keeps_external_preferences_and_removes_new_empty_tables() {
        let root = std::env::temp_dir().join(format!(
            "xwx-toml-adapter-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("config.toml");
        fs::write(
            &path,
            "# personal\ndefault_model = 'old'\n[ui]\ntheme='day'\n",
        )
        .unwrap();
        let plan = toml_plan(
            &path,
            vec![
                (vec!["default_model"], toml_edit::value("new")),
                (
                    vec!["providers", "xwx_deck", "api_key"],
                    toml_edit::value("xwx-deck"),
                ),
            ],
        )
        .unwrap();
        let current = text(&plan, "content").replace("theme='day'", "theme='night'");
        let restored = restore_toml(&current, &plan).unwrap();
        assert!(restored.contains("# personal"));
        assert!(restored.contains("theme='night'"));
        assert!(!restored.contains("xwx_deck"));
        assert!(restore_toml(&current.replace("\"new\"", "\"external\""), &plan).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn json_group_preserves_comments_trailing_commas_and_other_groups() {
        for source in [
            "// header\n[\n// personal\n{\"name\":\"mine\"},\n]\n",
            "[/*empty*/]",
        ] {
            let written = model_group(
                source,
                "XwX Deck",
                Some(&json!({"name":"XwX Deck","models":[]})),
            )
            .unwrap();
            assert!(written.contains(if source.contains("personal") {
                "// personal"
            } else {
                "/*empty*/"
            }));
            assert_eq!(
                parsed(&written).unwrap().as_array().unwrap().len(),
                parsed(source).unwrap().as_array().unwrap().len() + 1
            );
            let restored = model_group(&written, "XwX Deck", None).unwrap();
            assert_eq!(parsed(&restored).unwrap(), parsed(source).unwrap());
        }
    }
    #[test]
    fn dsh_preserves_other_plugins_and_detects_owned_changes() {
        let root =
            std::env::temp_dir().join(format!("xwx-dsh-plan-{}-{}", std::process::id(), millis()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("cordis.patch.yml");
        let source="# personal\n- id: tools\n  config:\n    cwd: !!js process.cwd()\n- id: llm-pi-ai\n  config:\n    providers:\n      personal:\n        baseURL: https://example.invalid\n- id: agent-default-model\n  config:\n    provider: personal\n    model: old\n";
        fs::write(&path, source).unwrap();
        let plan = dsh_plan(
            &path,
            "http://127.0.0.1:1234/clients/deepseek-harness/v1",
            "new",
            "openai-responses",
            &json!({"contextWindow":500000,"inputModalities":["text","image","pdf"]}),
        )
        .unwrap();
        assert!(text(&plan, "content").starts_with(source));
        let value = yaml(text(&plan, "content")).unwrap();
        let rows = value.as_sequence().unwrap();
        assert_eq!(
            rows.last().unwrap()["config"]["model"].as_str(),
            Some("new")
        );
        assert_eq!(
            rows[rows.len() - 2]["config"]["providers"]["personal"]["baseURL"].as_str(),
            Some("https://example.invalid")
        );
        let input = &rows[rows.len() - 2]["config"]["providers"]["xwx-deck"]["models"][0]["input"];
        assert_eq!(input.as_sequence().unwrap().len(), 2);
        let inserted=text(&plan,"content").replace("# XwX Deck managed models end", "- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: accepted\n# XwX Deck managed models end");
        assert!(restore_yaml_block(&inserted, &plan)
            .unwrap()
            .contains("welcomeNoticeVersion: accepted"));
        let changed = format!("{}# external preference\n", text(&plan, "content"));
        assert!(restore_yaml_block(&changed, &plan)
            .unwrap()
            .contains("# external preference"));
        assert!(
            restore_yaml_block(&changed.replace("model: new", "model: external"), &plan).is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn empty_harness_refs_survive_browser_grants_and_repeated_enrollment() {
        let root = std::env::temp_dir().join(format!(
            "xwx-dsh-empty-refs-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join(".credentials.yaml");
        for newline in ["\n", "\r\n"] {
            let source = "version: 1\n# retained preference\nrefs: {} # retained refs comment\nrecords:\n  browser:\n    secret: synthetic-grant\n".replace('\n', newline);
            fs::write(&path, &source).unwrap();
            let plan = credential_plan(&path).unwrap();
            assert_eq!(
                yaml(text(&plan, "content")).unwrap()["refs"]["XWX_DECK_GATEWAY_KEY"].as_str(),
                Some("xwx-deck")
            );
            let changed = text(&plan, "content").replace("synthetic-grant", "external-grant");
            let restored = restore_yaml_mapping(&changed, &plan).unwrap();
            assert!(restored.contains("# retained preference"));
            assert!(restored.contains("# retained refs comment"));
            assert!(!restored.contains("XWX_DECK_GATEWAY_KEY"));
            assert_eq!(
                yaml(&restored).unwrap()["records"]["browser"]["secret"].as_str(),
                Some("external-grant")
            );
            fs::write(&path, restored).unwrap();
            assert!(credential_plan(&path).is_ok());
        }
        let unknown = "version: 1\nrefs: { PERSONAL_KEY: synthetic }\nrecords: {}\n";
        fs::write(&path, unknown).unwrap();
        assert!(credential_plan(&path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), unknown);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn credential_edit_preserves_other_credentials_comments_and_external_changes() {
        let root =
            std::env::temp_dir().join(format!("xwx-dsh-key-{}-{}", std::process::id(), millis()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join(".credentials.yaml");
        let source = "version: 1\n# personal\nrefs:\n  PERSONAL_KEY: synthetic\nrecords: {}\n";
        fs::write(&path, source).unwrap();
        let plan = credential_plan(&path).unwrap();
        assert!(text(&plan, "content").contains("# personal"));
        let changed = text(&plan, "content").replace("synthetic", "external");
        let restored = restore_yaml_mapping(&changed, &plan).unwrap();
        assert!(restored.contains("PERSONAL_KEY: external"));
        assert!(!restored.contains("XWX_DECK_GATEWAY_KEY"));
        assert!(restore_yaml_mapping(&changed.replace("xwx-deck", "external"), &plan).is_err());
        fs::remove_file(&path).unwrap();
        let fresh = credential_plan(&path).unwrap();
        let with_grant = format!(
            "{}records: {{browser: {{kind: grant}}}}\n",
            text(&fresh, "content")
        );
        let restored = restore_yaml_mapping(&with_grant, &fresh).unwrap();
        assert!(yaml(&restored).unwrap()["refs"].is_mapping());
        assert_eq!(
            yaml(&restored).unwrap()["records"]["browser"]["kind"].as_str(),
            Some("grant")
        );
        fs::remove_dir_all(root).unwrap();
    }
}
