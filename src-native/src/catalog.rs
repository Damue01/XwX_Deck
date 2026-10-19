//! Connection-scoped catalogs retain connection identity and endpoint membership;
//! capabilities retain their own provenance across cache and client publication.
use super::*;
use std::collections::BTreeMap;
use std::sync::OnceLock;
#[path = "catalog_compatibility.rs"]
mod compatibility;
#[path = "catalog_metadata.rs"]
pub(super) mod metadata;

const FIELDS: &[&str] = &[
    "contextWindow",
    "maxOutputTokens",
    "vision",
    "reasoning",
    "toolCalling",
    "structuredOutput",
    "interleavedThinking",
    "inputModalities",
];
// The model's service capacity and Codex's current operational default are
// different facts. Never hard-code the client's default for future models.
fn codex_window(entry: &Value, native: Option<&Value>) -> u64 {
    let capacity = entry["contextWindow"]
        .as_u64()
        .filter(|n| *n > 0 && entry["capabilitySources"]["contextWindow"] != "fallback");
    let recommended = entry["providerCapabilities"]["recommendedContextWindow"]
        .as_u64()
        .filter(|n| *n > 0);
    let live = entry["nativeCodexContextWindow"]
        .as_u64()
        .filter(|n| *n > 0);
    if let Some(window) = recommended.or(live).or_else(|| {
        native
            .and_then(|row| row["context_window"].as_u64())
            .filter(|n| *n > 0)
    }) {
        return capacity.map_or(window, |limit| window.min(limit));
    }
    let id = normalize_id(text(entry, "id"));
    let gpt = id.rsplit('/').next().unwrap_or(&id).starts_with("gpt-");
    capacity.map_or(262144, |limit| if gpt { limit.min(262144) } else { limit })
}

fn ensure_codex_instructions(row: &mut Value) {
    if row["base_instructions"].is_string()
        || row["model_messages"]["instructions_template"].is_string()
    {
        return;
    }
    row["base_instructions"] = json!("You are a coding agent. Follow the user instructions, use the provided tools carefully, and report the completed result clearly.");
}
const REASONING_LEVELS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];
// DeepSeek's Responses contract exposes none/low/high/max. models.dev records
// the effort tiers but models the thinking toggle separately, so Codex needs
// the documented levels completed. Only the official service gets this
// treatment: resellers that serve DeepSeek models publish their own tier sets.
const DEEPSEEK_REASONING_LEVELS: &[&str] = &["none", "low", "high", "max"];
fn official_deepseek(provider: &Provider) -> bool {
    reqwest::Url::parse(provider.base_url.trim())
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .is_some_and(|host| host.eq_ignore_ascii_case("api.deepseek.com"))
}
fn codex_reasoning_levels(row: &Value, provider: &Provider) -> Vec<Value> {
    let mut levels: Vec<String> = row["reasoningLevels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    // An explicit service declaration, including an empty list, stays authoritative.
    let declared_by_service =
        row["capabilitySources"]["reasoningLevels"].as_str() == Some("provider");
    if official_deepseek(provider) && row["reasoning"] == true && !declared_by_service {
        for tier in DEEPSEEK_REASONING_LEVELS {
            if !levels.iter().any(|level| level.as_str() == *tier) {
                levels.push((*tier).to_owned());
            }
        }
        levels.sort_by_key(|level| {
            REASONING_LEVELS
                .iter()
                .position(|known| *known == level.as_str())
                .unwrap_or(usize::MAX)
        });
        levels.dedup();
    }
    levels
        .into_iter()
        .filter(|level| REASONING_LEVELS.contains(&level.as_str()))
        .map(|level| {
            json!({
                "effort": level,
                "description": format!("{level} reasoning effort")
            })
        })
        .collect()
}
pub(super) fn with_service_metadata(mut entry: Value, raw: &Value) -> Value {
    metadata::attach(&mut entry, raw);
    entry
}
fn normalize_id(id: &str) -> String {
    id.trim().trim_start_matches("models/").to_lowercase()
}
// Official records use the base model ID. Service directories may add a build
// or date suffix, so compare the same canonical identity used by the shared
// registry instead of requiring the raw IDs to match.
pub(super) fn official_model_key(id: &str) -> String {
    let id = normalize_id(id);
    let bare = id.rsplit('/').next().unwrap_or(&id);
    let mut base = bare;
    if let Some((prefix, day)) = base.rsplit_once('-') {
        if day.len() == 2 && day.chars().all(|c| c.is_ascii_digit()) {
            if let Some((month_prefix, month)) = prefix.rsplit_once('-') {
                if month.len() == 2 && month.chars().all(|c| c.is_ascii_digit()) {
                    if let Some((year_prefix, year)) = month_prefix.rsplit_once('-') {
                        if year.len() == 4 && year.chars().all(|c| c.is_ascii_digit()) {
                            base = year_prefix;
                        }
                    }
                }
            }
        }
    }
    if let Some((prefix, suffix)) = bare.rsplit_once('-') {
        if base == bare
            && (4..=8).contains(&suffix.len())
            && suffix.chars().all(|c| c.is_ascii_digit())
        {
            base = prefix;
        }
    }
    if let Some(prefix) = base.strip_suffix("-ga") {
        base = prefix;
    }
    base.chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}
pub(super) fn connection_root(base: &str) -> &str {
    let base = base.trim().trim_end_matches('/');
    ["/anthropic/v1", "/gemini/v1beta", "/v1"]
        .iter()
        .find_map(|suffix| base.strip_suffix(suffix))
        .unwrap_or(base)
}
pub(super) fn identity(p: &Provider) -> String {
    storage::digest(
        format!(
            "{}\0{}",
            connection_root(&p.base_url),
            p.bearer_token.trim()
        )
        .as_bytes(),
    )
}
fn protocols(row: &Value) -> Vec<Value> {
    fn parse(value: &Value) -> Vec<Value> {
        let mut out = vec![];
        for raw in value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let normalized = raw
                .trim()
                .trim_end_matches('/')
                .to_ascii_lowercase()
                .replace('_', "-");
            let name = match normalized.as_str() {
                "responses" | "openai-responses" | "/responses" | "/v1/responses" => {
                    "openai-responses"
                }
                "chat"
                | "chat-completions"
                | "chat-completion"
                | "/chat/completions"
                | "/v1/chat/completions" => "chat-completions",
                "messages" | "anthropic" | "anthropic-messages" | "/messages" | "/v1/messages" => {
                    "anthropic-messages"
                }
                "gemini" | "generate-content" | "generatecontent" => "gemini",
                _ => continue,
            };
            let value = json!(name);
            if !out.contains(&value) {
                out.push(value);
            }
        }
        out
    }
    // Native endpoints describe paths served without a relay conversion.
    let native = parse(&row["native_endpoints"]);
    if !native.is_empty() {
        return native;
    }
    let mut out = vec![];
    for key in [
        "protocols",
        "supported_endpoint_types",
        "supported_endpoints",
    ] {
        for value in parse(&row[key]) {
            if !out.contains(&value) {
                out.push(value);
            }
        }
    }
    if out.is_empty() {
        out = match text(row, "type_target") {
            "openai" => vec![json!("openai-responses"), json!("chat-completions")],
            "anthropic" => vec![json!("anthropic-messages")],
            // PipeLLM declares its Gemini target through its Chat converter.
            "gemini" => vec![json!("chat-completions")],
            _ => vec![],
        };
    }
    out
}

pub(super) fn official_protocol_registry() -> &'static Value {
    static REGISTRY: OnceLock<Value> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../test-results/native-assets/official-models.json"
        ))
        .unwrap_or(Value::Null)
    })
}
// Rules are evaluated for the live service directory, not only the bundled
// models.dev snapshot. New IDs inherit their family contract immediately.
pub(super) fn published_protocols(id: &str) -> Option<Value> {
    let registry = official_protocol_registry().as_array()?;
    let normalized = normalize_id(id);
    if let Some(row) = registry
        .iter()
        .find(|r| normalize_id(text(r, "modelId")) == normalized)
        .or_else(|| {
            registry.iter().find(|r| {
                !text(r, "modelId").contains('/')
                    && official_model_key(text(r, "modelId")) == official_model_key(id)
            })
        })
    {
        return Some(row["protocols"].clone());
    }
    static RULES: OnceLock<Value> = OnceLock::new();
    let table = RULES.get_or_init(|| {
        serde_json::from_str(include_str!("../../assets/model-protocols.json"))
            .unwrap_or(Value::Null)
    });
    let bare = normalized.rsplit('/').next().unwrap_or(&normalized);
    let owner = [
        ("gpt-", "openai"),
        ("chatgpt-", "openai"),
        ("codex-", "openai"),
        ("claude-", "anthropic"),
        ("kimi-", "moonshotai"),
        ("moonshot-", "moonshotai"),
        ("qwen", "alibaba"),
        ("glm-", "zhipuai"),
        ("deepseek-", "deepseek"),
        ("minimax-", "minimax"),
        ("grok-", "xai"),
    ]
    .into_iter()
    .find_map(|(prefix, owner)| bare.starts_with(prefix).then_some(owner))?;
    let matcher = |rule: &&Value| {
        rule["providers"]
            .as_array()
            .is_some_and(|a| a.iter().any(|p| p == owner))
            && ["exact", "prefix", "contains"].into_iter().any(|kind| {
                rule[kind].as_array().is_some_and(|a| {
                    a.iter().filter_map(Value::as_str).any(|value| match kind {
                        "exact" => bare == value,
                        "prefix" => bare.starts_with(value),
                        _ => bare.contains(value),
                    })
                })
            })
    };
    table["modelRules"]
        .as_array()
        .and_then(|a| a.iter().find(matcher))
        .map(|r| r["protocols"].clone())
        .or_else(|| {
            table["providerDefaults"]
                .as_array()?
                .iter()
                .find(|r| r["providerId"] == owner)
                .map(|r| r["protocols"].clone())
        })
}
fn remote_capability(remote: &Value, source: &str, id: &str) -> Value {
    model_metadata::resolve(remote, source, id)
}
fn enrich(mut entry: Value, remote: &Value) -> Value {
    let id = text(&entry, "id").to_owned();
    let official = official_protocol_registry();
    let official = official
        .as_array()
        .and_then(|a| {
            a.iter()
                .find(|r| normalize_id(text(r, "modelId")) == normalize_id(&id))
                .or_else(|| {
                    a.iter()
                        .find(|r| official_model_key(text(r, "modelId")) == official_model_key(&id))
                })
        })
        .cloned()
        .unwrap_or(Value::Null);
    let models = remote_capability(remote, "modelsDev", &id);
    let provider = entry["providerCapabilities"].clone();
    let mut sources = serde_json::Map::new();
    let mut missing = vec![];
    for key in FIELDS {
        let candidates = [("provider", &provider), ("models.dev", &models)];
        let cached_source = entry["capabilitySources"][*key]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let cached_value = entry.get(*key).cloned();
        let resolved = candidates.into_iter().find_map(|(source, cap)| {
            cap.get(*key)
                .or_else(|| {
                    if source == cached_source
                        && !(source == "models.dev" && remote["modelsDev"].is_array())
                        && ["models.dev"].contains(&cached_source.as_str())
                    {
                        cached_value.as_ref()
                    } else {
                        None
                    }
                })
                .filter(|v| {
                    if ["contextWindow", "maxOutputTokens"].contains(key) {
                        v.as_u64().is_some_and(|n| n > 0)
                    } else if *key == "inputModalities" {
                        v.as_array()
                            .is_some_and(|a| !a.is_empty() && a.iter().all(Value::is_string))
                    } else {
                        v.is_boolean()
                    }
                })
                .map(|v| (source, v.clone()))
        });
        if let Some((source, v)) = resolved {
            entry[*key] = v;
            sources.insert((*key).into(), json!(source));
        } else {
            entry[*key] = match *key {
                "contextWindow" => json!(262144),
                "maxOutputTokens" => json!(8192),
                "toolCalling" => json!(true),
                "inputModalities" => json!(["text"]),
                _ => json!(false),
            };
            sources.insert((*key).into(), json!("fallback"));
            missing.push(*key);
        }
    }
    let vision = entry["vision"] == true;
    if let Some(modalities) = entry["inputModalities"].as_array_mut() {
        if sources["inputModalities"] != "provider"
            && vision
            && !modalities.iter().any(|v| v == "image")
        {
            modalities.push(json!("image"));
        }
        if sources["inputModalities"] != "provider" && !vision {
            modalities.retain(|v| ![json!("image"), json!("pdf"), json!("video")].contains(v));
        }
        if modalities.is_empty() {
            modalities.push(json!("text"));
        }
    }
    if sources["inputModalities"] == "fallback" && vision {
        sources.insert("inputModalities".into(), sources["vision"].clone());
    }
    // Optional facts keep their source and stay absent when unconfirmed.
    for key in [
        "maxInputTokens",
        "outputModalities",
        "temperature",
        "reasoningOptions",
        "interleavedField",
        "maxReasoningTokens",
    ] {
        entry.as_object_mut().unwrap().remove(key);
        if let Some((source, value)) = [("provider", &provider), ("models.dev", &models)]
            .into_iter()
            .find_map(|(source, cap)| cap.get(key).map(|value| (source, value)))
        {
            entry[key] = value.clone();
            sources.insert(key.into(), json!(source));
        }
    }
    entry.as_object_mut().unwrap().remove("reasoningLevels");
    entry
        .as_object_mut()
        .unwrap()
        .remove("defaultReasoningLevel");
    for (key, field) in [
        ("levels", "reasoningLevels"),
        ("defaultLevel", "defaultReasoningLevel"),
    ] {
        if entry["reasoning"] != true {
            continue;
        }
        if let Some((source, value)) = [("provider", &provider), ("models.dev", &models)]
            .into_iter()
            .find_map(|(source, capability)| capability.get(key).map(|value| (source, value)))
        {
            entry[field] = value.clone();
            sources.insert(field.into(), json!(source));
        }
    }
    entry.as_object_mut().unwrap().remove("officialProtocols");
    if entry["protocolsDeclared"] != true
        && entry["catalogEndpoints"]
            .as_array()
            .is_some_and(|a| a.is_empty() || a.iter().any(|v| v == "openai"))
    {
        let published_protocols =
            published_protocols(&id).unwrap_or_else(|| official["protocols"].clone());
        let published = published_protocols.as_array().map(|protocols| {
            protocols
                .iter()
                .filter(|p| {
                    **p == "openai-responses"
                        || **p == "chat-completions"
                        || **p == "anthropic-messages"
                })
                .cloned()
                .collect::<Vec<_>>()
        });
        if let Some(published) = published.filter(|p| !p.is_empty()) {
            entry["officialProtocols"] = json!(published);
        }
    }
    entry["capabilitySources"] = Value::Object(sources);
    entry["missingCapabilities"] = json!(missing);
    entry
}
fn merge(entries: impl IntoIterator<Item = Value>) -> Vec<Value> {
    let mut merged = BTreeMap::<String, Value>::new();
    for entry in entries {
        let id = text(&entry, "id").to_owned();
        if id.is_empty() {
            continue;
        }
        if let Some(old) = merged.get_mut(&id) {
            if entry["protocolsDeclared"] == true && old["protocolsDeclared"] != true {
                old["protocols"] = json!([]);
            }
            for field in ["protocols", "catalogEndpoints", "clients"] {
                if field == "protocols"
                    && old["protocolsDeclared"] == true
                    && entry["protocolsDeclared"] != true
                {
                    continue;
                }
                let mut values = old[field].as_array().cloned().unwrap_or_default();
                for v in entry[field].as_array().into_iter().flatten() {
                    if !values.contains(v) {
                        values.push(v.clone());
                    }
                }
                old[field] = json!(values);
            }
            if entry["protocolsDeclared"] == true {
                old["protocolsDeclared"] = json!(true);
            }
            if let Some(cap) = entry["providerCapabilities"].as_object() {
                if !old["providerCapabilities"].is_object() {
                    old["providerCapabilities"] = json!({});
                }
                for (key, value) in cap {
                    old["providerCapabilities"]
                        .as_object_mut()
                        .unwrap()
                        .entry(key.clone())
                        .or_insert_with(|| value.clone());
                }
            }
            // A shutdown record must not be revived by another endpoint.
            for key in [
                "lifecycleStatus",
                "displayName",
                "modelVersion",
                "modelKind",
                "created",
                "domain",
                "taskTypes",
                "providerFeatures",
                "providerPrice",
            ] {
                if !entry[key].is_null()
                    && (old[key].is_null()
                        || key == "lifecycleStatus" && metadata::unavailable(&entry))
                {
                    old[key] = entry[key].clone();
                }
            }
        } else {
            merged.insert(id, entry);
        }
    }
    merged.into_values().collect()
}

pub(super) struct Catalog {
    pub root: PathBuf,
    pub codex_home: PathBuf,
    pub imported: Value,
    pub selected: String,
    pub defer_publication: bool,
}
impl Catalog {
    fn client_defaults(&self, p: &Provider, mut entries: Vec<Value>) -> Vec<Value> {
        let native = read(&self.codex_home.join("models_cache.json"))
            .ok()
            .flatten()
            .and_then(|source| serde_json::from_str::<Value>(&source).ok())
            .unwrap_or(Value::Null);
        for entry in &mut entries {
            let exact = native["models"]
                .as_array()
                .and_then(|rows| rows.iter().find(|row| row["slug"] == entry["id"]));
            entry["codexContextWindow"] = json!(codex_window(entry, exact));
            entry["codexCompatibility"] =
                compatibility::resolve(entry, exact, &entry_wire(p, Some(entry), "responses"));
            entry["codexContextWindowSource"] = json!(if entry["providerCapabilities"]
                ["recommendedContextWindow"]
                .as_u64()
                .is_some_and(|n| n > 0)
            {
                "provider"
            } else if entry["nativeCodexContextWindow"]
                .as_u64()
                .is_some_and(|n| n > 0)
                || exact.is_some_and(|row| row["context_window"].as_u64().is_some_and(|n| n > 0))
            {
                "codex"
            } else {
                "fallback"
            });
        }
        entries
    }
    fn enrich_subscription(&self, p: &Provider, entries: Value) -> Result<Value> {
        let remote = model_metadata::cached_capabilities(&self.root)?;
        let rows = entries
            .as_array()
            .ok_or("订阅模型目录格式无效")?
            .iter()
            .cloned()
            .map(|entry| enrich(entry, &remote))
            .collect();
        Ok(json!(self.client_defaults(p, rows)))
    }
    fn cache_path(&self, p: &Provider) -> PathBuf {
        self.root.join(format!(
            "provider-{}-models.json",
            &storage::digest(p.id.as_bytes())[..24]
        ))
    }
    pub(super) fn local_catalog(&self, p: &Provider) -> Result<Value> {
        let path = self.cache_path(p);
        if let Some(source) = read(&path)? {
            let cached: Value = serde_json::from_str(&source)
                .map_err(|_| "模型缓存损坏，原文件已保留".to_string())?;
            if cached["connectionId"] == identity(p) && cached["adapter"] == p.adapter {
                return super::retired_models::overlay(&self.root, p, cached["entries"].clone());
            }
        }
        let imported = self.imported.get(&p.id).and_then(Value::as_array);
        super::retired_models::overlay(&self.root, p, json!(imported.into_iter().flatten().filter_map(Value::as_str).map(|id|json!({"id":id,"vendor":"导入配置","catalogEndpoints":[],"protocols":[if p.codex_api_format=="responses"{"openai-responses"}else{&p.codex_api_format}],"protocolsDeclared":false})).collect::<Vec<_>>()))
    }
    pub(super) async fn connection_catalog(&self, p: &Provider, network: bool) -> Result<Value> {
        let cached = self.local_catalog(p)?;
        let remote = model_metadata::cached_capabilities(&self.root)?;
        if !network && cached.as_array().is_some_and(|a| !a.is_empty()) {
            let entries: Vec<_> = cached
                .as_array()
                .unwrap()
                .iter()
                .cloned()
                .map(|e| enrich(e, &remote))
                .collect();
            let entries = self.client_defaults(p, entries);
            self.publish_catalog(p, &entries)?;
            return Ok(json!(entries));
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(12))
            .build()
            .map_err(err)?;
        let endpoints = [(
            "",
            format!("{}/models", Pilot::api_root(&p.base_url)),
            "data",
        )];
        let requests=endpoints.iter().map(|(kind,url,collection)|{let client=&client;async move {
            let mut request=client.get(url).header("accept","application/json").header("X-Magpie-Prices","1");
            if !p.bearer_token.is_empty(){request=if p.adapter=="anthropic-messages" {request.header("x-api-key",&p.bearer_token).header("anthropic-version","2023-06-01")}else{request.bearer_auth(&p.bearer_token)};}
            let response=request.send().await.map_err(|_|"目录网络请求失败".to_string())?;
            let status=response.status();if !status.is_success(){return Err(format!("{kind} HTTP {}",status.as_u16()));}
            let bytes=response.bytes().await.map_err(err)?;if bytes.len()>8*1024*1024{return Err("模型目录超过 8 MB".into());}
            let body:Value=serde_json::from_slice(&bytes).map_err(|_|"模型目录 JSON 无效".to_string())?;
            let rows=body[*collection].as_array().ok_or("模型目录格式无效")?;
            let result=rows.iter().filter_map(|r|r["id"].as_str().or_else(||r["name"].as_str()).map(|id| {
                let id=if *kind=="gemini"{id.trim_start_matches("models/")}else{id};let declared=protocols(r);
                let defaults=match *kind {"anthropic"=>json!(["anthropic-messages"]),"gemini"=>json!(["gemini"]),"openai"=>json!(["openai-responses","chat-completions"]),_=>json!([if p.codex_api_format=="responses"{"openai-responses"}else{p.codex_api_format.as_str()}])};
                let mut entry = json!({"id":id,"vendor":r["owned_by"].as_str().unwrap_or(&p.display_name),"protocols":if declared.is_empty(){defaults}else{json!(declared)},"protocolsDeclared":!declared.is_empty(),"catalogEndpoints":if kind.is_empty(){json!([])}else{json!([kind])},"clients":json!(["codex","claude"])});
                metadata::attach(&mut entry,r);
                entry
            })).collect::<Vec<_>>();Ok::<_,String>(result)
        }});
        let results = futures_util::future::join_all(requests).await;
        let mut entries = vec![];
        let mut successes = 0;
        let mut errors = vec![];
        for result in results {
            match result {
                Ok(rows) => {
                    successes += 1;
                    entries.extend(rows);
                }
                Err(e) => {
                    errors.push(e);
                }
            }
        }
        if successes == 0 || !errors.is_empty() {
            return Err(if errors.is_empty() {
                "模型列表接口不存在，请核对服务地址".into()
            } else {
                format!("模型列表刷新失败：{}", errors.join("；"))
            });
        }
        let entries = merge(entries)
            .into_iter()
            .map(|e| enrich(e, &remote))
            .collect::<Vec<_>>();
        let entries = self.client_defaults(p, entries);
        let entries = super::retired_models::overlay(&self.root, p, json!(entries))?;
        self.publish_catalog(p, entries.as_array().unwrap())?;
        Ok(entries)
    }
    pub(super) fn publish_catalog(&self, p: &Provider, entries: &[Value]) -> Result<()> {
        if self.defer_publication {
            return Ok(());
        }
        write(&self.cache_path(p),&json!({"version":3,"connectionId":identity(p),"baseUrl":p.base_url,"adapter":p.adapter,"entries":entries}).to_string())?;
        if self.selected == p.id {
            self.publish_codex_catalog(p, entries)?;
        }
        Ok(())
    }
    pub(super) fn publish_codex_catalog(&self, p: &Provider, entries: &[Value]) -> Result<()> {
        let mut rows = entries.to_vec();
        if !p.codex_model.is_empty() && !rows.iter().any(|r| r["id"] == p.codex_model) {
            let remote = model_metadata::cached_capabilities(&self.root)?;
            rows.push(enrich(
                json!({"id":p.codex_model,"vendor":p.display_name}),
                &remote,
            ));
        }
        let rows = super::retired_models::overlay(&self.root, p, json!(rows))?;
        let rows = rows.as_array().unwrap();
        let native = read(&self.codex_home.join("models_cache.json"))?
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .unwrap_or(Value::Null);
        let models=rows.iter().enumerate().filter(|(_,r)|!metadata::unavailable(r)&&!metadata::non_conversational(r)&&!r["catalogEndpoints"].as_array().is_some_and(|a|a.len()==1&&a[0]=="gemini")).map(|(i,r)|{
            let exact=native["models"].as_array().and_then(|a|a.iter().find(|e|e["slug"]==r["id"]));
            let context=codex_window(r, exact);let vision=if r["capabilitySources"]["vision"]=="fallback"{exact.is_some_and(|e|e["supports_image_detail_original"]==true)}else{r["vision"]==true};
            let mut row=exact.cloned().unwrap_or_else(||json!({"shell_type":"shell_command","base_instructions":"You are a coding agent. Follow the user instructions, use the provided tools carefully, and report the completed result clearly.","apply_patch_tool_type":"freeform","default_verbosity":"medium","truncation_policy":{"mode":"tokens","limit":10000},"experimental_supported_tools":[]}));
            row["slug"]=r["id"].clone();row["display_name"]=r["id"].clone();row["description"]=r["vendor"].clone();row["visibility"]=json!("list");row["supported_in_api"]=json!(true);row["priority"]=json!(i);
            row["context_window"]=json!(context);row["max_context_window"]=json!(r["contextWindow"].as_u64().unwrap_or(context).max(context));row.as_object_mut().unwrap().remove("auto_compact_token_limit");for (key,value) in compatibility::resolve(r,exact,&entry_wire(p,Some(r),"responses"))["values"].as_object().unwrap() {row[key]=value.clone();}
            row["input_modalities"]=if vision{json!(["text","image"])}else{json!(["text"])};row["supports_image_detail_original"]=json!(vision);
            if exact.is_none() || r["reasoningLevels"].is_array() || (r["reasoning"] == false && r["capabilitySources"]["reasoning"] != "fallback") {
                row["supported_reasoning_levels"] = json!(codex_reasoning_levels(r, p));
            }
            let default = r["defaultReasoningLevel"].as_str().or_else(|| exact.and_then(|native| native["default_reasoning_level"].as_str()));
            row.as_object_mut().unwrap().remove("default_reasoning_level");
            if let Some(default) = default.filter(|default| row["supported_reasoning_levels"].as_array().is_some_and(|levels| levels.iter().any(|level| level["effort"] == *default))) {
                row["default_reasoning_level"] = json!(default);
            }
            if exact.is_none() || r["capabilitySources"]["reasoning"] != "fallback" {
                row["supports_reasoning_summary_parameter"]=json!(r["reasoning"]==true);row["default_reasoning_summary"]=json!(if r["reasoning"]==true{"auto"}else{"none"});
            }
            for key in ["comp_hash","max_output_tokens","supports_websockets","availability_nux","multi_agent_version","tool_mode","upgrade","use_responses_lite"] {row.as_object_mut().unwrap().remove(key);}
            // Older Codex builds (for example the 0.144 custom harness on
            // Windows) reject a catalog row without this key even when the
            // service does not summarize reasoning. Preserve a native value
            // and otherwise publish an explicit false rather than omitting it.
            if row.get("supports_reasoning_summaries").is_none() {
                row["supports_reasoning_summaries"] = json!(false);
            }
            if row.get("supports_parallel_tool_calls").is_none() {
                row["supports_parallel_tool_calls"] = json!(false);
            }
            ensure_codex_instructions(&mut row);
            row
        }).collect::<Vec<_>>();
        let path = self.codex_home.join("xwx-deck-model-catalog.json");
        write(&path, &json!({"models":models}).to_string())
    }
}

impl Pilot {
    fn catalog_context(&self) -> Catalog {
        Catalog {
            root: self.root.clone(),
            codex_home: self.codex_home(),
            imported: self
                .settings
                .other
                .get("importedProviderModels")
                .cloned()
                .unwrap_or(Value::Null),
            selected: self.settings.selected["codex"]
                .as_str()
                .unwrap_or("")
                .into(),
            defer_publication: false,
        }
    }
    pub(super) fn local_catalog(&self, p: &Provider) -> Result<Value> {
        self.catalog_context().local_catalog(p)
    }
    pub(super) async fn connection_catalog(&self, p: &Provider, network: bool) -> Result<Value> {
        self.catalog_context().connection_catalog(p, network).await
    }
    pub(super) fn publish_codex_catalog(&self, p: &Provider, entries: &[Value]) -> Result<()> {
        self.catalog_context().publish_codex_catalog(p, entries)
    }
    pub fn catalog_job(&self, method: &str, args: &[Value]) -> Result<Option<CatalogJob>> {
        let input = args.first().cloned().unwrap_or(Value::Null);
        if method == "fetchModels"
            && input.get("expectedProviderId").is_some()
            && input["expectedProviderId"] != self.settings.selected["codex"]
        {
            return Err("连接已切换，请重新加载模型目录".into());
        }
        let provider = if method == "fetchProviderModels" {
            Some(
                self.settings
                    .connections
                    .iter()
                    .find(|p| p.id == text(&input, "providerId"))
                    .ok_or("连接已删除，请重新加载")?,
            )
        } else {
            self.selected()
        };
        let official = if method == "fetchModels" && provider.is_none() {
            Some(self.official_catalog_context(input["refresh"] == true)?)
        } else {
            None
        };
        if official.is_none() && provider.is_none() {
            return Ok(None);
        }
        let mut context = self.catalog_context();
        context.defer_publication = true;
        Ok(Some(CatalogJob {
            generation: self.catalog_generation,
            repair_generation: self.catalog_repair_generation,
            context,
            provider: provider.cloned(),
            official,
            subscription: provider
                .filter(|p| !p.subscription_account_id.is_empty())
                .map(|_| self.subscriptions.clone()),
            refresh: input["refresh"] == true,
            client_scoped: method == "fetchModels",
            selected: self.settings.selected["codex"].clone(),
        }))
    }
    pub fn finish_catalog(&mut self, job: &CatalogJob, entries: Value) -> Result<Value> {
        if job.repair_generation != self.catalog_repair_generation {
            return Err("模型缓存已修复，未应用修复前的迟到目录；请重新加载".into());
        }
        if let Some(official) = &job.official {
            let current = self.official_catalog_context(job.refresh)?;
            if self.settings.selected["codex"] != job.selected
                || serde_json::to_value(&current.provider).map_err(err)?
                    != serde_json::to_value(&official.provider).map_err(err)?
            {
                return Err("连接或模型已更改，未应用迟到的官方目录；请重新加载".into());
            }
            return Ok(entries);
        }
        let provider = job.provider.as_ref().ok_or("连接已删除，未应用迟到目录")?;
        let current = self
            .settings
            .connections
            .iter()
            .find(|p| p.id == provider.id)
            .ok_or("连接已删除，未应用迟到目录")?;
        if serde_json::to_value(current).map_err(err)?
            != serde_json::to_value(provider).map_err(err)?
            || job.client_scoped && self.settings.selected["codex"] != job.selected
        {
            return Err("连接已更改，未应用迟到目录；请重新加载".into());
        }
        if job.subscription.is_some() {
            return self.catalog_context().enrich_subscription(current, entries);
        }
        // A reference-data refresh is not a user cache repair. Keep validated
        // service facts, but consume the current reference and native defaults.
        let entries = if job.generation != self.catalog_generation {
            let remote = model_metadata::cached_capabilities(&self.root)?;
            let rows = entries
                .as_array()
                .ok_or("模型目录格式无效")?
                .iter()
                .cloned()
                .map(|entry| enrich(entry, &remote))
                .collect();
            json!(self.catalog_context().client_defaults(current, rows))
        } else {
            entries
        };
        self.catalog_context().publish_catalog(
            current,
            entries.as_array().map(Vec::as_slice).unwrap_or(&[]),
        )?;
        // Endpoint changes update generated direct configuration only while
        // Trace is inactive. Each writer preserves external edits and the
        // user's selected service/model remains in the application registry.
        if !self.active() {
            if self.settings.selected["codex"] == current.id {
                self.write_direct(false)?;
            }
            if self.settings.selected["claude"] == current.id {
                self.write_claude_direct(false)?;
                self.refresh_desktop_selection()?;
            }
        }
        Ok(entries)
    }
}
pub struct CatalogJob {
    generation: u64,
    repair_generation: u64,
    context: Catalog,
    provider: Option<Provider>,
    official: Option<clients::OfficialCatalog>,
    subscription: Option<subscriptions::Accounts>,
    refresh: bool,
    client_scoped: bool,
    selected: Value,
}
impl CatalogJob {
    pub async fn execute(&self) -> Result<Value> {
        if let Some(official) = &self.official {
            return official.execute().await;
        }
        if let Some(accounts) = &self.subscription {
            let entries = accounts
                .model_catalog(self.provider.as_ref().ok_or("连接已删除")?)
                .await?;
            return self
                .context
                .enrich_subscription(self.provider.as_ref().ok_or("连接已删除")?, entries);
        }
        self.context
            .connection_catalog(self.provider.as_ref().ok_or("连接已删除")?, self.refresh)
            .await
    }
}

fn cached_entry(root: &Path, p: &Provider, model: &str) -> Option<Value> {
    let cache = root.join(format!(
        "provider-{}-models.json",
        &storage::digest(p.id.as_bytes())[..24]
    ));
    let cache = read(&cache)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(Value::Null);
    let entry = if cache["connectionId"] == identity(p) {
        cache["entries"]
            .as_array()
            .and_then(|a| a.iter().find(|r| r["id"].as_str() == Some(model)))
    } else {
        None
    };
    entry.cloned()
}

pub(super) fn output_limit(root: &Path, p: &Provider, model: &str) -> Option<u64> {
    let entry = cached_entry(root, p, model)?;
    if !["provider", "models.dev"]
        .contains(&entry["capabilitySources"]["maxOutputTokens"].as_str()?)
    {
        return None;
    }
    entry["maxOutputTokens"].as_u64().filter(|limit| *limit > 0)
}

pub(super) fn wire(root: &Path, p: &Provider, model: Option<&str>, incoming: &str) -> String {
    let entry = model.and_then(|model| cached_entry(root, p, model));
    entry_wire(p, entry.as_ref(), incoming)
}

/// Shared by ordinary API and subscription routes. Endpoint order from the
/// service is not a preference: keep the client's native wire when available,
/// then prefer Responses and Messages over a Chat bridge.
pub(super) fn preferred_wire(protocols: &Value, incoming: &str) -> Option<&'static str> {
    let supported = |protocol: &str| {
        protocols
            .as_array()
            .is_some_and(|values| values.iter().any(|value| value == protocol))
    };
    if incoming == "anthropic-messages" && supported("anthropic-messages") {
        Some("anthropic-messages")
    } else if supported("openai-responses") {
        Some("responses")
    } else if supported("anthropic-messages") {
        Some("anthropic-messages")
    } else if supported("chat-completions") {
        Some("chat-completions")
    } else {
        None
    }
}

fn entry_wire(p: &Provider, entry: Option<&Value>, incoming: &str) -> String {
    let default = if p.codex_api_format.is_empty() {
        "responses"
    } else {
        p.codex_api_format.as_str()
    };
    if let Some(e) = entry {
        if e["protocolsDeclared"] != true {
            if e["catalogEndpoints"].as_array().is_some_and(|a| {
                !a.is_empty()
                    && !a.iter().any(|v| v == "openai")
                    && a.iter().any(|v| v == "anthropic")
            }) {
                return "anthropic-messages".into();
            }
            return preferred_wire(&e["officialProtocols"], incoming)
                .unwrap_or(default)
                .into();
        }
        return preferred_wire(&e["protocols"], incoming)
            .unwrap_or(default)
            .into();
    }
    default.into()
}

#[cfg(test)]
mod client_contract_tests {
    use super::*;
    #[test]
    fn protocol_order_matches_both_client_contracts() {
        let cases: Value =
            serde_json::from_str(include_str!("../../src/shared/protocol-routing-cases.json"))
                .unwrap();
        for case in cases.as_array().unwrap() {
            let mut protocols = case["protocols"].as_array().unwrap().clone();
            for _ in 0..2 {
                let entry = json!({"protocolsDeclared":true,"protocols":protocols});
                for (client, incoming) in [("codex", "responses"), ("claude", "anthropic-messages")]
                {
                    assert_eq!(
                        entry_wire(&Provider::default(), Some(&entry), incoming),
                        case[client].as_str().unwrap(),
                        "{} {client}",
                        case["name"]
                    );
                }
                protocols.reverse();
            }
        }
        assert_eq!(preferred_wire(&json!([]), "responses"), None);
        assert_eq!(preferred_wire(&json!(["unknown"]), "responses"), None);
    }
    #[test]
    fn instruction_templates_survive_client_publication() {
        let mut template = json!({"model_messages":{"instructions_template":"current native instructions","permissions":{"fixture":true}}});
        let original = template.clone();
        ensure_codex_instructions(&mut template);
        assert_eq!(template, original);
        let mut legacy = json!({"base_instructions":"retained legacy instructions"});
        ensure_codex_instructions(&mut legacy);
        assert_eq!(legacy["base_instructions"], "retained legacy instructions");
        let mut absent = json!({"slug":"codex-auto-review"});
        ensure_codex_instructions(&mut absent);
        assert!(absent["base_instructions"].is_string());
    }
    #[test]
    fn official_protocols_survive_an_empty_openai_directory() {
        let entry = enrich(
            json!({
                "id":"kimi-k3",
                "catalogEndpoints":[],
                "protocolsDeclared":false
            }),
            &json!({"modelsDev":[]}),
        );
        assert!(entry["officialProtocols"]
            .as_array()
            .is_some_and(|p| p.contains(&json!("openai-responses"))));
        assert!(entry["officialProtocols"]
            .as_array()
            .is_some_and(|p| p.contains(&json!("anthropic-messages"))));
        assert_eq!(
            entry_wire(
                &Provider {
                    codex_api_format: "responses".into(),
                    ..Provider::default()
                },
                Some(&entry),
                "responses"
            ),
            "responses"
        );
        assert_eq!(
            entry_wire(
                &Provider {
                    codex_api_format: "responses".into(),
                    ..Provider::default()
                },
                Some(&entry),
                "anthropic-messages"
            ),
            "anthropic-messages"
        );
        assert_eq!(
            entry_wire(
                &Provider {
                    codex_api_format: "chat-completions".into(),
                    ..Provider::default()
                },
                Some(&entry),
                "responses"
            ),
            "responses"
        );
        let flash = enrich(
            json!({
                "id":"deepseek-flash",
                "catalogEndpoints":[],
                "protocolsDeclared":false
            }),
            &json!({"modelsDev":[]}),
        );
        assert!(flash["officialProtocols"]
            .as_array()
            .is_some_and(|p| p.contains(&json!("openai-responses"))));
        assert_eq!(
            entry_wire(
                &Provider {
                    codex_api_format: "responses".into(),
                    ..Provider::default()
                },
                Some(&flash),
                "responses"
            ),
            "responses"
        );
        let k27 = json!({
            "id":"kimi-k2.7-code",
            "catalogEndpoints":[],
            "protocolsDeclared":false,
            "officialProtocols":["chat-completions","anthropic-messages"]
        });
        assert_eq!(
            entry_wire(
                &Provider {
                    codex_api_format: "responses".into(),
                    ..Provider::default()
                },
                Some(&k27),
                "responses"
            ),
            "anthropic-messages"
        );
        assert_eq!(
            entry_wire(
                &Provider {
                    codex_api_format: "responses".into(),
                    ..Provider::default()
                },
                Some(&k27),
                "anthropic-messages"
            ),
            "anthropic-messages"
        );
    }
    #[test]
    fn official_protocol_table_covers_current_provider_models() {
        let official = official_protocol_registry();
        let protocols = |id: &str| -> Vec<String> {
            official
                .as_array()
                .and_then(|rows| rows.iter().find(|row| row["modelId"] == id))
                .and_then(|row| row["protocols"].as_array())
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default()
        };
        assert!(protocols("qwen3.8-max")
            .iter()
            .any(|p| p == "openai-responses"));
        assert!(protocols("qwen3.8-max")
            .iter()
            .any(|p| p == "anthropic-messages"));
        assert_eq!(protocols("qwen3-coder-plus"), vec!["chat-completions"]);
        assert!(protocols("MiniMax-M3")
            .iter()
            .any(|p| p == "anthropic-messages"));
        assert!(protocols("glm-5.3-flash")
            .iter()
            .any(|p| p == "openai-responses"));
        assert!(protocols("kimi-k2.7-code")
            .iter()
            .any(|p| p == "anthropic-messages"));
        assert!(!protocols("kimi-k2.7-code")
            .iter()
            .any(|p| p == "openai-responses"));
        assert!(protocols("gpt-4o").iter().any(|p| p == "openai-responses"));
        assert_eq!(protocols("gpt-3.5-turbo"), vec!["chat-completions"]);
        assert_eq!(protocols("claude-opus-4-7"), vec!["anthropic-messages"]);
        assert_eq!(protocols("mistral-large-4"), vec!["chat-completions"]);
        assert!(protocols("anthropic/claude-opus-4.7")
            .iter()
            .any(|p| p == "anthropic-messages"));
        for id in [
            "qwen3.8-max-0902",
            "qwen3.7-max-2026-05-20",
            "deepseek-v4-pro-0813",
            "deepseek-v4-pro-ga-260813",
        ] {
            let entry = enrich(
                json!({"id":id,"catalogEndpoints":[],"protocolsDeclared":false}),
                &json!({"modelsDev":[]}),
            );
            assert!(
                entry["officialProtocols"]
                    .as_array()
                    .is_some_and(|values| values.contains(&json!("openai-responses"))),
                "{id} must resolve the base official record"
            );
        }
    }
    #[test]
    fn live_new_models_inherit_rules_and_service_declarations_win() {
        for id in [
            "gpt-7-future",
            "openai/gpt-7-future",
            "kimi-k3-future",
            "qwen3.8-max-future",
        ] {
            let entry = enrich(
                json!({"id":id,"catalogEndpoints":["openai"],"protocolsDeclared":false}),
                &json!({"modelsDev":[]}),
            );
            assert_eq!(
                entry_wire(
                    &Provider {
                        codex_api_format: "chat-completions".into(),
                        ..Provider::default()
                    },
                    Some(&entry),
                    "responses"
                ),
                "responses",
                "{id}"
            );
        }
        let declared = enrich(
            json!({"id":"gpt-7-future","catalogEndpoints":["openai"],"protocolsDeclared":true,"protocols":["chat-completions"]}),
            &json!({"modelsDev":[]}),
        );
        assert!(declared["officialProtocols"].is_null());
        assert_eq!(
            entry_wire(&Provider::default(), Some(&declared), "responses"),
            "chat-completions"
        );
        let messages = enrich(
            json!({"id":"gpt-7-future","catalogEndpoints":["anthropic"],"protocolsDeclared":false,"protocols":["anthropic-messages"]}),
            &json!({"modelsDev":[]}),
        );
        assert_eq!(
            entry_wire(&Provider::default(), Some(&messages), "responses"),
            "anthropic-messages"
        );
    }
    #[test]
    fn unknown_models_use_the_connection_default_instead_of_a_guess() {
        let entry = enrich(
            json!({
                "id":"aggregator-unknown-model",
                "catalogEndpoints":[],
                "protocolsDeclared":false
            }),
            &json!({
                "modelsDev":[],
                "litellm":[{
                    "modelId":"aggregator-unknown-model",
                    "capability":{"openAiProtocols":["chat-completions"]}
                }]
            }),
        );
        assert!(
            entry["officialProtocols"].is_null(),
            "a legacy protocol cache must not supply a guessed protocol"
        );
        assert_eq!(
            entry_wire(
                &Provider {
                    codex_api_format: "responses".into(),
                    ..Provider::default()
                },
                Some(&entry),
                "responses"
            ),
            "responses"
        );
        assert_eq!(
            entry_wire(
                &Provider {
                    codex_api_format: "chat-completions".into(),
                    ..Provider::default()
                },
                Some(&entry),
                "responses"
            ),
            "chat-completions"
        );
    }
    fn efforts(levels: &[&str], reasoning: bool, base_url: &str, source: &str) -> Vec<String> {
        let mut row = json!({"reasoning":reasoning,"reasoningLevels":levels});
        if !source.is_empty() {
            row["capabilitySources"] = json!({"reasoningLevels":source});
        }
        codex_reasoning_levels(
            &row,
            &Provider {
                base_url: base_url.into(),
                ..Provider::default()
            },
        )
        .into_iter()
        .filter_map(|level| level["effort"].as_str().map(str::to_owned))
        .collect()
    }
    #[test]
    fn deepseek_contract_levels_stay_scoped_to_the_official_service() {
        assert_eq!(
            efforts(
                &["low", "high", "max"],
                true,
                "https://api.deepseek.com",
                "models.dev"
            ),
            ["none", "low", "high", "max"]
        );
        assert_eq!(
            efforts(&[], true, "https://api.deepseek.com/v1", ""),
            ["none", "low", "high", "max"]
        );
        // A reseller's DeepSeek model keeps its own declared ladder. Ark, for
        // example, does not publish max or none, and adding them would show
        // effort tiers the service never promised.
        assert_eq!(
            efforts(
                &["minimal", "low", "medium", "high"],
                true,
                "https://ark.cn-beijing.volces.com/api/v3",
                "models.dev"
            ),
            ["minimal", "low", "medium", "high"]
        );
        assert_eq!(
            efforts(&[], true, "https://openrouter.ai/api/v1", "models.dev"),
            Vec::<String>::new()
        );
        // Unknown services preserve their exact declared order.
        assert_eq!(
            efforts(
                &["high", "low"],
                true,
                "https://compatible.example/v1",
                "provider"
            ),
            ["high", "low"]
        );
        // Explicit service declarations, including empty lists and a reduced
        // ladder, stay authoritative even on the official endpoint.
        assert_eq!(
            efforts(&[], true, "https://api.deepseek.com", "provider"),
            Vec::<String>::new()
        );
        assert_eq!(
            efforts(&["high"], true, "https://api.deepseek.com", "provider"),
            ["high"]
        );
        // A non-reasoning model never receives invented effort tiers.
        assert_eq!(
            efforts(&[], false, "https://api.deepseek.com", "provider"),
            Vec::<String>::new()
        );
    }
    #[test]
    fn reasoning_level_sources_survive_enrichment() {
        let provider = Provider {
            base_url: "https://api.deepseek.com".into(),
            ..Provider::default()
        };
        let explicit = enrich(
            json!({"id":"deepseek-v4-pro","providerCapabilities":{"reasoning":true,"levels":[]}}),
            &json!({"modelsDev":[]}),
        );
        assert_eq!(
            explicit["capabilitySources"]["reasoningLevels"],
            json!("provider")
        );
        assert_eq!(
            codex_reasoning_levels(&explicit, &provider),
            Vec::<Value>::new()
        );
        let remote = json!({"modelsDev":[{
            "modelId":"deepseek-v4-pro",
            "providerId":"deepseek",
            "canonicalModelId":"deepseek/deepseek-v4-pro",
            "aliases":["deepseek/deepseek-v4-pro","deepseek-v4-pro"],
            "referencePriority":0,
            "capability":{"reasoning":true,"levels":["low","high","max"]}
        }]});
        let resolved = enrich(json!({"id":"deepseek-v4-pro"}), &remote);
        assert_eq!(
            resolved["capabilitySources"]["reasoningLevels"],
            json!("models.dev")
        );
        let efforts: Vec<_> = codex_reasoning_levels(&resolved, &provider)
            .into_iter()
            .filter_map(|level| level["effort"].as_str().map(str::to_owned))
            .collect();
        assert_eq!(efforts, ["none", "low", "high", "max"]);
    }
    #[test]
    fn output_limit_is_scoped_to_the_connection_and_requires_provenance() {
        let root = std::env::temp_dir().join(format!(
            "xwx-output-limit-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let provider = Provider {
            id: "budget-test".into(),
            base_url: "https://synthetic.example/v1".into(),
            bearer_token: "synthetic-only".into(),
            ..Provider::default()
        };
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join(format!(
            "provider-{}-models.json",
            &storage::digest(provider.id.as_bytes())[..24]
        ));
        for source in ["fallback", "provider", "models.dev"] {
            write(&file, &json!({"connectionId":identity(&provider),"entries":[{"id":"model","maxOutputTokens":4096,"capabilitySources":{"maxOutputTokens":source}}]}).to_string()).unwrap();
            assert_eq!(
                output_limit(&root, &provider, "model"),
                if source == "fallback" {
                    None
                } else {
                    Some(4096)
                }
            );
            assert_eq!(output_limit(&root, &provider, "other-model"), None);
            let changed = Provider {
                bearer_token: "different-synthetic-only".into(),
                ..provider.clone()
            };
            assert_eq!(output_limit(&root, &changed, "model"), None);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn current_client_default_does_not_replace_service_capacity() {
        let entry =
            json!({"contextWindow":1050000,"capabilitySources":{"contextWindow":"models.dev"}});
        assert_eq!(
            codex_window(&entry, Some(&json!({"context_window":500000}))),
            500000
        );
        assert_eq!(entry["contextWindow"], 1050000);
        let gpt = json!({"id":"gpt-6.1-sol","contextWindow":1050000,"capabilitySources":{"contextWindow":"provider"}});
        assert_eq!(codex_window(&gpt, None), 262144);
        assert_eq!(
            codex_window(&gpt, Some(&json!({"context_window":500000}))),
            500000
        );
        assert_eq!(codex_window(&entry, None), 1050000);
        let recommended = json!({"id":"gpt-6.1-sol","contextWindow":1050000,"capabilitySources":{"contextWindow":"provider"},"providerCapabilities":{"recommendedContextWindow":600000}});
        assert_eq!(
            codex_window(&recommended, Some(&json!({"context_window":500000}))),
            600000
        );
        let provider =
            json!({"contextWindow":128000,"capabilitySources":{"contextWindow":"provider"}});
        assert_eq!(
            codex_window(&provider, Some(&json!({"context_window":500000}))),
            128000
        );
        let unknown =
            json!({"contextWindow":262144,"capabilitySources":{"contextWindow":"fallback"}});
        assert_eq!(
            codex_window(&unknown, Some(&json!({"context_window":500000}))),
            500000
        );
        assert_eq!(codex_window(&unknown, None), 262144);
    }
}
