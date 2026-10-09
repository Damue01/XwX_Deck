//! Read-only local configuration discovery. Preview contains metadata only;
//! import rereads and verifies each selected fingerprint before one local write.
use super::*;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::collections::HashSet;

const MAX_JSON: u64 = 8 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpec {
    source: String,
    path: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportItem {
    fingerprint: String,
    name: String,
    base_url: String,
    adapter: String,
    status: String,
    reason: String,
    #[serde(skip)]
    provider: Option<Provider>,
    #[serde(skip)]
    models: Vec<String>,
}
#[derive(Serialize)]
struct ImportSource {
    source: String,
    name: String,
    path: String,
    found: bool,
    error: String,
    items: Vec<ImportItem>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Preview {
    target_digest: String,
    sources: Vec<ImportSource>,
}
fn fingerprint(v: &impl Serialize) -> String {
    storage::digest(&serde_json::to_vec(v).unwrap_or_default())
}
fn field<'a>(v: &'a Value, keys: &[&str]) -> &'a str {
    keys.iter()
        .find_map(|key| v[*key].as_str().filter(|s| !s.trim().is_empty()))
        .unwrap_or("")
        .trim()
}
fn json_file(path: &Path) -> Result<Value> {
    let meta = fs::metadata(path).map_err(|_| "无法读取配置文件")?;
    if !meta.is_file() || meta.len() > MAX_JSON {
        return Err("配置文件超过 8 MB 或不是普通文件".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| "无法读取配置文件")?)
        .map_err(|_| "配置 JSON 无法解析，原文件已保留".into())
}
fn names(v: &Value) -> Vec<String> {
    let mut result = vec![];
    if let Some(rows) = v.as_array() {
        for row in rows {
            let id = row.as_str().unwrap_or_else(|| text(row, "id"));
            if !id.is_empty() {
                result.push(id.to_owned());
            }
        }
    } else if let Some(rows) = v.as_object() {
        result.extend(rows.keys().cloned());
    }
    result.sort();
    result.dedup();
    result.truncate(1000);
    result
}
fn skipped(name: &str, raw: &Value, reason: &str) -> ImportItem {
    ImportItem {
        fingerprint: fingerprint(raw),
        name: name.to_owned(),
        base_url: String::new(),
        adapter: String::new(),
        status: "unsupported".into(),
        reason: reason.into(),
        provider: None,
        models: vec![],
    }
}
fn entry(
    name: String,
    mut provider: Provider,
    models: Vec<String>,
    raw: &Value,
    disabled: bool,
    blocked_ports: &[u16],
) -> ImportItem {
    let url = reqwest::Url::parse(provider.base_url.trim_end_matches('/'));
    let skip = match &url {
        Err(_) => Some("API 地址无效"),
        Ok(u)
            if !["http", "https"].contains(&u.scheme())
                || u.host_str().is_none()
                || !u.username().is_empty()
                || u.password().is_some()
                || u.query().is_some()
                || u.fragment().is_some() =>
        {
            Some("API 地址包含不支持的认证或参数")
        }
        Ok(u)
            if matches!(
                u.host_str(),
                Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
            ) && u.port().is_some_and(|port| {
                blocked_ports.contains(&port) || (45233..=45242).contains(&port)
            }) =>
        {
            Some("指向配置管理器本地代理，不能作为上游导入")
        }
        Ok(u)
            if u.host_str().is_some_and(|h| {
                h == "chatgpt.com"
                    || h.ends_with(".githubcopilot.com")
                    || h == "api.githubcopilot.com"
                    || h == "api2.cursor.sh"
                    || h == "grok.com"
            }) || provider.bearer_token.starts_with("sk-ant-oat") =>
        {
            Some("此条目需要重新登录订阅账号")
        }
        Ok(u)
            if provider.bearer_token.is_empty()
                && !matches!(
                    u.host_str(),
                    Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
                ) =>
        {
            Some("没有可迁移的 API Key，请重新登录订阅或手动配置")
        }
        _ => None,
    };
    if let Some(reason) = skip {
        return skipped(&name, raw, reason);
    }
    if ["PROXY_MANAGED", "PROXY_MANAGED_TOKEN", "MAGPIE_MANAGED"]
        .contains(&provider.bearer_token.as_str())
    {
        return skipped(&name, raw, "只有本地代理占位密钥，不能导入");
    }
    provider.base_url = provider.base_url.trim_end_matches('/').to_owned();
    provider.display_name = name.clone();
    provider.codex_provider_id = "xwx_deck".into();
    provider.codex_api_format = provider.adapter.clone();
    if provider.provider_preset.is_empty() || provider.provider_preset == "custom" {
        provider.provider_preset = match provider.base_url.as_str() {
            "https://coding.dashscope.aliyuncs.com/v1"
            | "https://coding.dashscope.aliyuncs.com/apps/anthropic" => "qwen-coding-plan",
            "https://open.bigmodel.cn/api/v1"
            | "https://open.bigmodel.cn/api/anthropic"
            | "https://open.bigmodel.cn/api/coding/paas/v4" => "zhipu-coding-plan",
            "https://api.z.ai/api/v1"
            | "https://api.z.ai/api/anthropic"
            | "https://api.z.ai/api/coding/paas/v4" => "zai-coding-plan",
            "https://api.kimi.com/coding/v1" | "https://api.kimi.ai/coding/v1" => {
                "kimi-coding-plan"
            }
            _ => "custom",
        }
        .into();
    }
    ImportItem {
        fingerprint: fingerprint(&json!({"raw":raw,"provider":provider,"models":models})),
        name,
        base_url: provider.base_url.clone(),
        adapter: provider.adapter.clone(),
        status: if disabled { "paused" } else { "new" }.into(),
        reason: if disabled { "来源中已停用" } else { "" }.into(),
        provider: Some(provider),
        models,
    }
}
fn read_magpie(path: &Path) -> Result<Vec<ImportItem>> {
    let config = json_file(path)?;
    let providers = config["providers"]
        .as_array()
        .ok_or("没有找到 Magpie providers 列表")?;
    if providers.len() > 1000 {
        return Err("配置条目超过 1000 个上限".into());
    }
    let port = json_file(&path.with_file_name("settings.json"))
        .ok()
        .and_then(|v| v["port"].as_u64())
        .and_then(|v| u16::try_from(v).ok())
        .unwrap_or(3425);
    let mut out = vec![];
    for raw in providers {
        let name = field(raw, &["name", "id"]);
        if raw["hidden"] == true {
            continue;
        }
        if raw["headers"].as_object().is_some_and(|h| !h.is_empty()) {
            out.push(skipped(name, raw, "含自定义请求头，暂不支持完整导入"));
            continue;
        }
        let endpoints: Vec<_> = [
            ("responses", "responses"),
            ("chat", "chat-completions"),
            ("anthropic", "anthropic-messages"),
        ]
        .into_iter()
        .filter(|(key, _)| !text(raw, key).is_empty())
        .collect();
        if endpoints.is_empty() {
            out.push(skipped(
                name,
                raw,
                if !text(raw, "gemini").is_empty() {
                    "原生 Gemini 协议暂不支持导入"
                } else {
                    "此条目需要重新登录订阅账号"
                },
            ));
            continue;
        }
        let keys = std::iter::once((
            field(raw, &["keyName"]),
            text(raw, "key"),
            text(raw, "keyProtocol"),
            false,
        ))
        .chain(raw["keys"].as_array().into_iter().flatten().map(|key| {
            (
                text(key, "name"),
                text(key, "key"),
                text(key, "protocol"),
                key["off"] == true,
            )
        }));
        for (index, (key_name, key, protocol, key_off)) in keys.enumerate() {
            if index >= 100 {
                return Err("单个服务商的 Key 超过 100 个上限".into());
            }
            for (api, adapter) in &endpoints {
                if out.len() >= 1000 {
                    return Err("配置条目超过 1000 个上限".into());
                }
                if !protocol.is_empty() && protocol != *api {
                    continue;
                }
                let mut label = if name.is_empty() {
                    "Imported".to_owned()
                } else {
                    name.to_owned()
                };
                if index > 0 || !key_name.is_empty() {
                    label.push_str(&format!(
                        " {}",
                        if key_name.is_empty() {
                            format!("Key {}", index + 1)
                        } else {
                            key_name.to_owned()
                        }
                    ));
                }
                if endpoints.len() > 1 {
                    label.push_str(&format!(" ({api})"));
                }
                let provider = Provider {
                    base_url: text(raw, api).into(),
                    bearer_token: key.into(),
                    adapter: (*adapter).into(),
                    claude_models: json!({"fable":"","opus":"","sonnet":"","haiku":""}),
                    ..Default::default()
                };
                out.push(entry(
                    label,
                    provider,
                    names(&raw["models"]),
                    raw,
                    raw["off"] == true || key_off,
                    &[15721, 3425, port],
                ));
            }
        }
    }
    Ok(out)
}
fn cc_entry(
    app: &str,
    name: &str,
    settings: &Value,
    meta: &Value,
    raw: &Value,
    ports: &[u16],
) -> ImportItem {
    let env = &settings["env"];
    if field(meta, &["providerType"]).contains("oauth")
        || field(meta, &["providerType"]) == "github_copilot"
        || meta["authBinding"]["kind"] == "managed_account"
    {
        return skipped(name, raw, "此条目需要重新登录订阅账号");
    }
    if meta["localProxyRequestOverrides"]
        .as_object()
        .is_some_and(|v| !v.is_empty())
    {
        return skipped(name, raw, "含自定义请求覆盖，暂不支持完整导入");
    }
    let mut p = Provider {
        claude_models: json!({"fable":"","opus":"","sonnet":"","haiku":""}),
        ..Default::default()
    };
    let mut models = names(&settings["models"]);
    match app {
        "claude" | "claude-desktop" => {
            if [
                "CLAUDE_CODE_USE_BEDROCK",
                "CLAUDE_CODE_USE_VERTEX",
                "CLAUDE_CODE_USE_FOUNDRY",
            ]
            .iter()
            .any(|k| env[*k] == "1" || env[*k] == true)
            {
                return skipped(name, raw, "此认证方式暂不支持导入");
            }
            p.bearer_token = field(env, &["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]).into();
            p.base_url = field(env, &["ANTHROPIC_BASE_URL"]).into();
            if p.base_url.is_empty() && !p.bearer_token.is_empty() {
                p.base_url = "https://api.anthropic.com".into();
            }
            p.adapter = match field(meta, &["apiFormat"]) {
                "openai_chat" => "chat-completions",
                "openai_responses" => "responses",
                "" | "anthropic" | "anthropic_messages" => "anthropic-messages",
                _ => return skipped(name, raw, "此接口协议暂不支持导入"),
            }
            .into();
            for (role, keys) in [
                ("fable", vec!["ANTHROPIC_DEFAULT_FABLE_MODEL"]),
                ("opus", vec!["ANTHROPIC_DEFAULT_OPUS_MODEL"]),
                (
                    "sonnet",
                    vec!["ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_MODEL"],
                ),
                (
                    "haiku",
                    vec![
                        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                        "ANTHROPIC_SMALL_FAST_MODEL",
                    ],
                ),
            ] {
                let model = field(env, &keys);
                p.claude_models[role] = json!(model);
                if !model.is_empty() {
                    models.push(model.into());
                }
            }
        }
        "codex" => {
            let config = match doc(text(settings, "config")) {
                Ok(config) => config,
                Err(_) => return skipped(name, raw, "此条目 TOML 无法解析"),
            };
            let selected = config
                .get("model_provider")
                .and_then(Item::as_str)
                .unwrap_or("openai");
            let empty = Item::None;
            let provider = config
                .get("model_providers")
                .and_then(|table| table.get(selected))
                .unwrap_or(&empty);
            if provider
                .get("http_headers")
                .and_then(Item::as_table_like)
                .is_some_and(|h| !h.is_empty())
                || provider
                    .get("env_http_headers")
                    .and_then(Item::as_table_like)
                    .is_some_and(|h| !h.is_empty())
            {
                return skipped(name, raw, "含自定义请求头，暂不支持完整导入");
            }
            let env_key = provider.get("env_key").and_then(Item::as_str).unwrap_or("");
            if !env_key.is_empty() {
                p.bearer_token = text(env, env_key).into();
                if p.bearer_token.is_empty() {
                    return skipped(name, raw, "密钥来自环境变量，请手动配置");
                }
            } else {
                p.bearer_token = provider
                    .get("experimental_bearer_token")
                    .and_then(Item::as_str)
                    .unwrap_or("")
                    .into();
                if p.bearer_token.is_empty() {
                    p.bearer_token = field(&settings["auth"], &["OPENAI_API_KEY"]).into();
                }
            }
            p.base_url = provider
                .get("base_url")
                .and_then(Item::as_str)
                .unwrap_or("")
                .into();
            if p.base_url.is_empty() && !p.bearer_token.is_empty() {
                p.base_url = "https://api.openai.com/v1".into();
            }
            p.adapter = match provider
                .get("wire_api")
                .and_then(Item::as_str)
                .unwrap_or("responses")
            {
                "responses" => "responses",
                "chat" | "chat-completions" => "chat-completions",
                _ => return skipped(name, raw, "此接口协议暂不支持导入"),
            }
            .into();
            p.codex_model = config
                .get("model")
                .and_then(Item::as_str)
                .unwrap_or("")
                .into();
            p.codex_context_window = config
                .get("model_context_window")
                .and_then(Item::as_integer)
                .unwrap_or(0)
                .max(0) as u64;
            if !p.codex_model.is_empty() {
                models.push(p.codex_model.clone());
            }
        }
        "gemini" => return skipped(name, raw, "原生 Gemini 协议暂不支持导入"),
        "opencode" | "openclaw" | "pi" | "hermes" | "grokbuild" => {
            let options = &settings["options"];
            p.base_url = field(settings, &["baseUrl", "baseURL", "base_url"]).into();
            if p.base_url.is_empty() {
                p.base_url = field(options, &["baseURL", "baseUrl", "base_url"]).into();
            }
            p.bearer_token = field(settings, &["apiKey", "api_key"]).into();
            if p.bearer_token.is_empty() {
                p.bearer_token = field(options, &["apiKey", "api_key"]).into();
            }
            let api = field(settings, &["api", "npm", "type"]).to_lowercase();
            p.adapter = if api.contains("anthropic") {
                "anthropic-messages"
            } else if api.contains("responses") {
                "responses"
            } else if api.is_empty() || api.contains("openai") {
                "chat-completions"
            } else {
                return skipped(name, raw, "此接口协议暂不支持导入");
            }
            .into();
            if settings["headers"]
                .as_object()
                .is_some_and(|h| !h.is_empty())
                || options["headers"]
                    .as_object()
                    .is_some_and(|h| !h.is_empty())
            {
                return skipped(name, raw, "含自定义请求头，暂不支持完整导入");
            }
        }
        _ => return skipped(name, raw, "此客户端配置格式暂不支持导入"),
    }
    if p.base_url.is_empty() && p.bearer_token.is_empty() {
        return skipped(name, raw, "此条目需要重新登录订阅账号");
    }
    models.sort();
    models.dedup();
    entry(
        name.into(),
        p,
        models,
        raw,
        settings["disabled"] == true,
        ports,
    )
}
fn read_cc(path: &Path) -> Result<Vec<ImportItem>> {
    let mut out = vec![];
    if path
        .extension()
        .is_some_and(|s| s == "db" || s == "sqlite" || s == "sqlite3")
    {
        if fs::metadata(path)
            .map_err(|_| "无法读取 CC Switch 数据库")?
            .len()
            > 128 * 1024 * 1024
        {
            return Err("CC Switch 数据库超过 128 MB 上限".into());
        }
        let db = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| "无法只读打开 CC Switch 数据库")?;
        db.busy_timeout(Duration::from_secs(1)).map_err(err)?;
        let transaction = db
            .unchecked_transaction()
            .map_err(|_| "CC Switch 数据库暂不可读")?;
        let has_meta = transaction
            .prepare("SELECT name FROM pragma_table_info('providers') WHERE name='meta'")
            .and_then(|mut s| s.exists([]))
            .unwrap_or(false);
        let mut ports = vec![15721, 3425];
        if let Ok(mut query) = transaction.prepare("SELECT DISTINCT listen_port FROM proxy_config")
        {
            if let Ok(rows) = query.query_map([], |r| r.get::<_, u16>(0)) {
                ports.extend(rows.filter_map(|r| r.ok()));
            }
        }
        let sql=format!("SELECT id,app_type,name,settings_config,{} FROM providers ORDER BY app_type,id LIMIT 1001",if has_meta{"meta"}else{"'{}'"});
        let mut query = transaction
            .prepare(&sql)
            .map_err(|_| "CC Switch 数据库格式不受支持")?;
        let rows = query
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(|_| "无法读取 CC Switch 服务列表")?;
        for row in rows {
            if out.len() >= 1000 {
                return Err("配置条目超过 1000 个上限".into());
            }
            let (id, app, name, settings, meta) = row.map_err(|_| "CC Switch 条目格式不受支持")?;
            let settings: Value = serde_json::from_str(&settings).unwrap_or(Value::Null);
            let meta: Value = serde_json::from_str(&meta).unwrap_or(Value::Null);
            let raw = json!({"id":id,"app":app,"name":name,"settings":settings,"meta":meta});
            if settings.is_null() {
                out.push(skipped(&name, &raw, "此条目 JSON 无法解析"));
                continue;
            }
            out.push(cc_entry(&app, &name, &settings, &meta, &raw, &ports));
        }
    } else {
        let config = json_file(path)?;
        let sections = config.as_object().ok_or("CC Switch 配置格式不受支持")?;
        for (app, section) in sections {
            for (id, row) in section["providers"].as_object().into_iter().flatten() {
                if out.len() >= 1000 {
                    return Err("配置条目超过 1000 个上限".into());
                }
                let raw = json!({"app":app,"id":id,"row":row});
                out.push(cc_entry(
                    app,
                    text(row, "name"),
                    &row["settingsConfig"],
                    &row["meta"],
                    &raw,
                    &[15721, 3425],
                ));
            }
        }
    }
    Ok(out)
}
fn read_client(path: &Path, source: &str, isolated_root: Option<&Path>) -> Result<Vec<ImportItem>> {
    if source == "claude" {
        let settings = json_file(path)?;
        if !settings.is_object() {
            return Err("Claude 配置格式不受支持，原文件已保留".into());
        }
        let raw = json!({"source":source,"settings":settings});
        return Ok(vec![cc_entry(
            "claude",
            "Claude",
            &settings,
            &json!({}),
            &raw,
            &[15721, 3425],
        )]);
    }
    let meta = fs::metadata(path).map_err(|_| "无法读取 Codex 配置")?;
    if !meta.is_file() || meta.len() > MAX_JSON {
        return Err("配置文件超过 8 MB 或不是普通文件".into());
    }
    let config = fs::read_to_string(path).map_err(|_| "无法读取 Codex 配置")?;
    let parsed = doc(&config).map_err(|_| "Codex TOML 无法解析，原文件已保留")?;
    let selected = parsed
        .get("model_provider")
        .and_then(Item::as_str)
        .unwrap_or("openai");
    if selected == "xwx_deck" {
        return Ok(vec![skipped(
            "Codex",
            &json!({"config":config}),
            "已由 Deck 管理，请从原始服务配置导入",
        )]);
    }
    let empty = Item::None;
    let provider = parsed
        .get("model_providers")
        .and_then(|table| table.get(selected))
        .unwrap_or(&empty);
    // Extract only the API key. OAuth credentials never enter the import plan.
    let mut api_key = String::new();
    if provider
        .get("experimental_bearer_token")
        .and_then(Item::as_str)
        .unwrap_or("")
        .is_empty()
        && provider
            .get("env_key")
            .and_then(Item::as_str)
            .unwrap_or("")
            .is_empty()
    {
        let auth_path = path.with_file_name("auth.json");
        if auth_path.exists() {
            if isolated_root.is_some_and(|root| {
                fs::canonicalize(&auth_path)
                    .map(|p| !p.starts_with(root))
                    .unwrap_or(true)
            }) {
                return Err("隔离验收只能读取隔离目录中的认证文件".into());
            }
            let auth = json_file(&auth_path)?;
            api_key = field(&auth, &["OPENAI_API_KEY"]).into();
            if api_key.is_empty() && (auth["tokens"].is_object() || auth["auth_mode"] == "chatgpt")
            {
                return Ok(vec![skipped(
                    "Codex",
                    &json!({"config":config}),
                    "此条目需要重新登录订阅账号",
                )]);
            }
        }
    }
    let settings = json!({"config":config,"auth":{"OPENAI_API_KEY":api_key}});
    let raw = json!({"source":source,"settings":settings});
    Ok(vec![cc_entry(
        "codex",
        "Codex",
        &settings,
        &json!({}),
        &raw,
        &[15721, 3425],
    )])
}
fn same(a: &Provider, b: &Provider) -> bool {
    a.subscription_account_id.is_empty()
        && a.base_url.trim_end_matches('/') == b.base_url.trim_end_matches('/')
        && a.bearer_token == b.bearer_token
        && a.adapter == b.adapter
}
impl Pilot {
    fn import_target(&self) -> Result<String> {
        if let Some(problem) = &self.settings_problem {
            return Err(problem.clone());
        }
        let disk = read(&self.root.join("settings.json"))?.unwrap_or_default();
        if !disk.is_empty() {
            let mut parsed: Value = serde_json::from_str(&disk)
                .map_err(|_| "配置文件已在外部变更，请重新打开应用；原文件已保留")?;
            if parsed.get("connections").is_none() && parsed["providers"]["connections"].is_array()
            {
                parsed["connections"] = parsed["providers"]["connections"].clone();
                parsed["selected"] = parsed["providers"]["selected"].clone();
            }
            let target: Settings = serde_json::from_value(parsed)
                .map_err(|_| "配置文件已在外部变更，请重新打开应用；原文件已保留")?;
            let normalize = |s: &Settings| -> Result<Value> {
                let mut v = serde_json::to_value(s).map_err(err)?;
                if v.get("providers").is_some() {
                    v["providers"] = json!({"version":1,"identityVersion":2,"connections":s.connections,"selected":s.selected});
                }
                Ok(v)
            };
            if normalize(&target)? != normalize(&self.settings)? {
                return Err("配置文件已在外部修改，请重新打开应用；未覆盖原文件".into());
            }
        }
        Ok(disk)
    }
    fn import_specs(&self, input: &Value) -> Result<Vec<SourceSpec>> {
        if input.get("sources").is_some() {
            let specs: Vec<SourceSpec> =
                serde_json::from_value(input["sources"].clone()).map_err(|_| "无效导入来源")?;
            if specs.len() > 8
                || specs.iter().any(|s| {
                    !["magpie", "cc-switch", "claude", "codex"].contains(&s.source.as_str())
                        || !Path::new(&s.path).is_absolute()
                })
            {
                return Err("无效导入来源".into());
            }
            if self.isolated
                && specs.iter().any(|s| {
                    !Path::new(&s.path).starts_with(&self.root)
                        || Path::new(&s.path).exists()
                            && fs::canonicalize(&s.path)
                                .map(|p| !p.starts_with(&self.root))
                                .unwrap_or(true)
                })
            {
                return Err("隔离验收只能读取隔离目录中的来源文件".into());
            }
            return Ok(specs);
        }
        let home = if self.isolated {
            self.root.join("import-sources")
        } else {
            Self::home()
        };
        let config = if self.isolated {
            home.join(".config")
        } else {
            std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .unwrap_or_else(|| home.join(".config"))
        };
        let cc = home.join(".cc-switch");
        let cc_path = if cc.join("cc-switch.db").exists() {
            cc.join("cc-switch.db")
        } else if cc.join("config.json").exists() {
            cc.join("config.json")
        } else {
            cc.join("cc-switch.db")
        };
        Ok(vec![
            SourceSpec {
                source: "magpie".into(),
                path: config
                    .join("magpie/providers.json")
                    .to_string_lossy()
                    .into(),
            },
            SourceSpec {
                source: "cc-switch".into(),
                path: cc_path.to_string_lossy().into(),
            },
            SourceSpec {
                source: "claude".into(),
                path: self
                    .claude_dir()
                    .join("settings.json")
                    .to_string_lossy()
                    .into(),
            },
            SourceSpec {
                source: "codex".into(),
                path: self.config_path().to_string_lossy().into(),
            },
        ])
    }
    fn import_scan(&self, input: &Value) -> Result<Preview> {
        let disk = self.import_target()?;
        let mut sources = vec![];
        for spec in self.import_specs(input)? {
            let path = Path::new(&spec.path);
            let found = path.exists();
            let mut source = ImportSource {
                source: spec.source.clone(),
                name: match spec.source.as_str() {
                    "magpie" => "Magpie",
                    "cc-switch" => "CC Switch",
                    "claude" => "Claude CLI",
                    _ => "Codex CLI",
                }
                .into(),
                path: spec.path.clone(),
                found,
                error: String::new(),
                items: vec![],
            };
            if found {
                if self.isolated
                    && (!path.starts_with(&self.root)
                        || fs::canonicalize(path)
                            .map(|p| !p.starts_with(&self.root))
                            .unwrap_or(true))
                {
                    return Err("隔离验收只能读取隔离目录中的来源文件".into());
                }
                if self.isolated && spec.source == "magpie" {
                    let settings = path.with_file_name("settings.json");
                    if settings.exists()
                        && fs::canonicalize(settings)
                            .map(|p| !p.starts_with(&self.root))
                            .unwrap_or(true)
                    {
                        return Err("隔离验收只能读取隔离目录中的来源文件".into());
                    }
                }
                match match spec.source.as_str() {
                    "magpie" => read_magpie(path),
                    "cc-switch" => read_cc(path),
                    _ => read_client(
                        path,
                        &spec.source,
                        if self.isolated {
                            Some(&self.root)
                        } else {
                            None
                        },
                    ),
                } {
                    Ok(mut items) => {
                        for item in &mut items {
                            if let Some(p) = &item.provider {
                                if self.settings.connections.iter().any(|old| same(old, p)) {
                                    item.status = "existing".into();
                                    item.reason = "已在 XwX Deck 中".into();
                                }
                            }
                        }
                        source.items = items;
                    }
                    Err(error) => source.error = error,
                }
            }
            sources.push(source);
        }
        Ok(Preview {
            target_digest: storage::digest(disk.as_bytes()),
            sources,
        })
    }
    pub(super) fn preview_import(&self, input: &Value) -> Result<Value> {
        serde_json::to_value(self.import_scan(input)?).map_err(err)
    }
    pub(super) fn apply_import(&mut self, input: &Value) -> Result<Value> {
        if let Some(problem) = &self.settings_problem {
            return Err(problem.clone());
        }
        let expected = text(input, "targetDigest");
        let scan = self.import_scan(input)?;
        if expected != scan.target_digest {
            return Err("XwX Deck 配置已变化，请刷新导入列表；原配置已保留".into());
        }
        let selected: Vec<String> =
            serde_json::from_value(input["fingerprints"].clone()).map_err(|_| "无效导入选择")?;
        if selected.is_empty() || selected.len() > 1000 {
            return Err("请选择要导入的配置".into());
        }
        let mut candidates = vec![];
        let mut seen = HashSet::new();
        for selected in selected {
            if !seen.insert(selected.clone()) {
                continue;
            }
            let item = scan
                .sources
                .iter()
                .flat_map(|s| &s.items)
                .find(|i| i.fingerprint == selected)
                .ok_or("来源配置已变化，请刷新后重新选择；未写入任何配置")?;
            if item.status == "existing" {
                continue;
            }
            let p = item
                .provider
                .as_ref()
                .ok_or("此条目无法完整导入，请调整选择")?;
            candidates.push((p.clone(), item.models.clone()));
        }
        let old_connections = self.settings.connections.clone();
        let old_other = self.settings.other.clone();
        let mut added = vec![];
        for (mut p, models) in candidates {
            if self.settings.connections.iter().any(|old| same(old, &p)) {
                continue;
            }
            let base = format!("import-{}", &fingerprint(&p)[..16]);
            let mut id = base.clone();
            let mut suffix = 2;
            while self.settings.connections.iter().any(|old| old.id == id) {
                id = format!("{base}-{suffix}");
                suffix += 1;
            }
            p.id = id.clone();
            let name = p.display_name.clone();
            let mut suffix = 2;
            while self
                .settings
                .connections
                .iter()
                .any(|old| old.display_name == p.display_name)
            {
                p.display_name = format!("{name}-{suffix}");
                suffix += 1;
            }
            if !models.is_empty() {
                let map = self
                    .settings
                    .other
                    .entry("importedProviderModels")
                    .or_insert(json!({}));
                if !map.is_object() {
                    *map = json!({});
                }
                map[&id] = json!(models);
            }
            added.push(p.display_name.clone());
            self.settings.connections.push(p);
        }
        let result = (|| -> Result<()> {
            let current = read(&self.root.join("settings.json"))?.unwrap_or_default();
            if storage::digest(current.as_bytes()) != expected {
                return Err("XwX Deck 配置已在外部修改，未覆盖原文件".into());
            }
            if !added.is_empty() {
                let backup = self
                    .root
                    .join(format!("settings-before-import-{}.json", millis()));
                write(&backup, &current)?;
                self.persist()?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            self.settings.connections = old_connections;
            self.settings.other = old_other;
            return Err(error);
        }
        Ok(json!({"providers":self.providers(),"added":added}))
    }
}
