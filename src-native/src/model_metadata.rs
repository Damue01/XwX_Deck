//! Port of XwXDeck's owner-first, conservative remote capability resolver.
use super::*;
fn norm(id: &str) -> String {
    id.trim().trim_start_matches("models/").to_lowercase()
}
fn bare(id: &str) -> &str {
    id.rsplit('/').next().unwrap_or(id)
}
fn canonical(id: &str) -> String {
    bare(id)
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}
fn positive(v: &Value) -> Option<u64> {
    v.as_f64()
        .filter(|n| n.is_finite() && *n >= 1.0 && *n <= u64::MAX as f64)
        .map(|n| n.floor() as u64)
}
fn strings(v: &Value) -> Vec<Value> {
    let mut out = vec![];
    for s in v
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.len() <= 128)
    {
        let v = json!(s.to_lowercase());
        if !out.contains(&v) {
            out.push(v);
        }
    }
    out
}
fn flag(out: &mut Value, key: &str, value: &Value) {
    if value.is_boolean() {
        out[key] = value.clone();
    }
}
pub(super) fn cached_capabilities(root: &Path) -> Result<Value> {
    let cached = read(&root.join("model-capabilities-cache.json"))?
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(|v| v["version"] == 1 && v["modelsDev"].is_array())
        .map(|mut v| {
            if let Some(cache) = v.as_object_mut() {
                cache.remove("litellm");
            }
            v
        });
    if let Some(value) = cached.as_ref().filter(|v| {
        v["modelsDev"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|r| r["canonicalModelId"].is_string()))
    }) {
        return Ok(value.clone());
    }
    let bundled: Value =
        serde_json::from_str(crate::embedded_assets::models_dev_capabilities()?).map_err(err)?;
    Ok(json!({"version":1,"modelsDev":parse_models(&bundled["catalog"])}))
}

pub(super) fn parse_models(value: &Value) -> Vec<Value> {
    let mut rows = vec![];
    for (provider, models) in value
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(p, v)| v["models"].as_object().map(|m| (p, m)))
    {
        for (id, raw) in models {
            if id.is_empty() || id.len() > 512 || !raw.is_object() {
                continue;
            }
            let mut cap = json!({});
            for (key, field) in [
                ("contextWindow", "context"),
                ("maxInputTokens", "input"),
                ("maxOutputTokens", "output"),
            ] {
                if let Some(n) = positive(&raw["limit"][field]) {
                    cap[key] = json!(n);
                }
            }
            let modalities = strings(&raw["modalities"]["input"]);
            if !modalities.is_empty() {
                cap["vision"] = json!(modalities.iter().filter_map(Value::as_str).any(|s| [
                    "image", "pdf", "vision"
                ]
                .iter()
                .any(|m| s.contains(m))));
                cap["inputModalities"] = json!(modalities);
            }
            let output_modalities = strings(&raw["modalities"]["output"]);
            if !output_modalities.is_empty() {
                cap["outputModalities"] = json!(output_modalities);
            }
            flag(&mut cap, "temperature", &raw["temperature"]);
            if raw["interleaved"].is_object()
                && ["reasoning_content", "reasoning_details"]
                    .contains(&text(&raw["interleaved"], "field"))
            {
                cap["interleavedThinking"] = json!(true);
                cap["interleavedField"] = raw["interleaved"]["field"].clone();
            }
            for (key, field) in [
                ("reasoning", "reasoning"),
                ("toolCalling", "tool_call"),
                ("structuredOutput", "structured_output"),
                ("interleavedThinking", "interleaved"),
            ] {
                flag(&mut cap, key, &raw[field]);
            }
            let options = raw
                .get("reasoning_options")
                .filter(|v| v.is_array())
                .or_else(|| raw["reasoning"].get("options").filter(|v| v.is_array()))
                .or_else(|| raw["reasoning"].get("effort"));
            let mut levels = vec![];
            for value in options.and_then(Value::as_array).into_iter().flatten() {
                let values = if value.is_string() {
                    strings(&json!([value]))
                } else {
                    strings(&value["values"])
                };
                for value in values {
                    if !levels.contains(&value) {
                        levels.push(value);
                    }
                }
            }
            if let Some(options) = options.and_then(Value::as_array) {
                // Preserve toggle/budget options as metadata; they are not effort levels.
                cap["reasoningOptions"] = json!(options);
                cap["levels"] = json!(levels);
            } else if !levels.is_empty() {
                cap["levels"] = json!(levels);
            }
            if cap.as_object().is_some_and(|o| !o.is_empty()) {
                let target = raw["canonical_model_id"]
                    .as_str()
                    .map(norm)
                    .unwrap_or_else(|| format!("{}/{id}", owner_id(provider)));
                rows.push(json!({"modelId":norm(id),"sourceId":format!("{provider}/{id}"),"providerId":norm(provider),"canonicalModelId":target,"aliases":[target,bare(&target)],"referencePriority":if raw["canonical_model_id"].is_null() && !is_owner(provider) {99} else {reference_priority(provider,&target)},"capability":cap}));
            }
            if rows.len() >= 50_000 {
                return rows;
            }
        }
    }
    rows
}
fn owners(id: &str) -> Vec<&'static str> {
    let id = canonical(id);
    if id.starts_with("gpt")
        || id.starts_with("chatgpt")
        || id.starts_with("codex")
        || id.starts_with('o') && id.as_bytes().get(1).is_some_and(u8::is_ascii_digit)
    {
        return vec!["openai"];
    }
    if id.starts_with("qwen") || id.starts_with("qwq") {
        return vec!["alibaba", "alibaba-cn"];
    }
    if id.starts_with("deepseek") {
        return vec!["deepseek"];
    }
    if id.starts_with("kimi") || id.starts_with("moonshot") {
        return vec!["moonshotai", "moonshotai-cn"];
    }
    if id.starts_with("glm") || id.starts_with("chatglm") {
        return vec!["zhipuai", "zai"];
    }
    if id.starts_with("minimax") {
        return vec!["minimax", "minimax-cn"];
    }
    if id.starts_with("doubao") || id.starts_with("seed") {
        return vec!["volcengine", "volcengine-cn"];
    }
    if id.starts_with("grok") {
        return vec!["xai"];
    }
    if id.starts_with("claude") {
        return vec!["anthropic"];
    }
    if id.starts_with("gemini") {
        return vec!["google"];
    }
    if id.starts_with("mimo") {
        return vec!["xiaomi"];
    }
    if id.starts_with("command") {
        return vec!["cohere"];
    }
    if ["mistral", "codestral", "devstral", "magistral"]
        .iter()
        .any(|p| id.starts_with(p))
    {
        return vec!["mistral"];
    }
    vec![]
}
fn matches<'a>(rows: &'a Value, id: &str, level: usize) -> Vec<&'a Value> {
    rows.as_array()
        .into_iter()
        .flatten()
        .filter(|r| {
            let candidate = norm(text(r, "modelId"));
            match level {
                0 => candidate == id,
                1 => bare(&candidate) == bare(id),
                _ => canonical(&candidate) == canonical(id),
            }
        })
        .take(50_000)
        .collect()
}
fn consensus(rows: &[&Value]) -> Value {
    let mut out = json!({});
    for key in [
        "contextWindow",
        "maxInputTokens",
        "maxOutputTokens",
        "outputModalities",
        "temperature",
        "interleavedField",
        "reasoningOptions",
        "vision",
        "reasoning",
        "toolCalling",
        "structuredOutput",
        "interleavedThinking",
        "inputModalities",
        "levels",
        "defaultLevel",
    ] {
        let values: Vec<_> = rows
            .iter()
            .filter_map(|r| r["capability"].get(key))
            .collect();
        if ["contextWindow", "maxInputTokens", "maxOutputTokens"].contains(&key) {
            if let Some(n) = values.iter().filter_map(|v| positive(v)).min() {
                out[key] = json!(n);
            }
        } else if let Some(v) = values.first().filter(|v| values.iter().all(|n| n == *v)) {
            out[key] = (*v).clone();
        }
    }
    out
}
pub(super) fn resolve(remote: &Value, source: &str, id: &str) -> Value {
    if source == "modelsDev" {
        return remote[source]
            .as_array()
            .and_then(|rows| {
                let alias = find_reference(rows, id)?;
                find_reference(rows, text(alias, "canonicalModelId")).or(Some(alias))
            })
            .map(|r| r["capability"].clone())
            .unwrap_or_else(|| json!({}));
    }
    let id = norm(id);
    let mut out = json!({});
    for level in 0..3 {
        let rows = matches(&remote[source], &id, level);
        let mut capability = consensus(&rows);
        for owner in owners(&id) {
            let preferred: Vec<_> = rows
                .iter()
                .copied()
                .filter(|r| text(r, "providerId") == owner)
                .collect();
            if !preferred.is_empty() {
                for (key, v) in consensus(&preferred).as_object().into_iter().flatten() {
                    capability[key] = v.clone();
                }
                break;
            }
        }
        if capability.as_object().is_some_and(|o| !o.is_empty()) {
            out = capability;
            break;
        }
    }
    out
}
fn cost_rates(cost: &Value) -> Option<Value> {
    let mut rates = json!({});
    for (target, source) in [
        ("input", "input"),
        ("output", "output"),
        ("cacheRead", "cache_read"),
        ("cacheWrite", "cache_write"),
        ("cacheWrite1h", "cache_write_1h"),
        ("reasoning", "reasoning"),
        ("inputAudio", "input_audio"),
        ("outputAudio", "output_audio"),
    ] {
        if cost[source]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n >= 0.0)
        {
            rates[target] = cost[source].clone();
        }
    }
    (rates["input"].is_number() && rates["output"].is_number()).then_some(rates)
}
fn cost_tiers(cost: &Value) -> Option<Value> {
    let raw = cost["tiers"].as_array().filter(|rows| !rows.is_empty())?;
    let mut base = cost_rates(cost)?;
    base["fromInputTokens"] = json!(0);
    let mut tiers = vec![base];
    for raw in raw {
        if raw["tier"]["type"] != "context" {
            return None;
        }
        let size = raw["tier"]["size"]
            .as_u64()
            .filter(|n| *n > 0 && *n < 9_007_199_254_740_991)?;
        let mut band = cost_rates(raw)?;
        band["fromInputTokens"] = json!(size + 1);
        tiers.push(band);
    }
    tiers.sort_by_key(|row| row["fromInputTokens"].as_u64().unwrap());
    if tiers
        .windows(2)
        .any(|rows| rows[0]["fromInputTokens"] == rows[1]["fromInputTokens"])
    {
        return None;
    }
    Some(json!(tiers))
}
fn owner_id(id: &str) -> &str {
    match id {
        "zai" => "zhipuai",
        "bytedance-seed" => "volcengine",
        "meituan" => "longcat",
        "moonshotai-cn" => "moonshotai",
        "alibaba-cn" => "alibaba",
        "google-vertex" => "google",
        _ => id,
    }
}
fn reference_priority(provider: &str, canonical: &str) -> u64 {
    if owner_id(provider) == owner_id(canonical.split('/').next().unwrap_or("")) {
        0
    } else if ["amazon-bedrock", "aws-bedrock", "bedrock"].contains(&provider) {
        1
    } else if ["azure", "azure-cognitive-services"].contains(&provider) {
        2
    } else {
        99
    }
}
fn undated(id: &str) -> String {
    let id = norm(id);
    let Some((base, suffix)) = id.rsplit_once(['-', '_']) else {
        return id;
    };
    if ![6, 8].contains(&suffix.len())
        || !suffix.bytes().all(|b| b.is_ascii_digit())
        || suffix.len() == 8 && !suffix.starts_with("20")
    {
        return id;
    }
    let year = suffix[..suffix.len() - 4].parse::<i32>().unwrap_or(0)
        + if suffix.len() == 6 { 2000 } else { 0 };
    let month = suffix[suffix.len() - 4..suffix.len() - 2]
        .parse()
        .unwrap_or(0);
    let day = suffix[suffix.len() - 2..].parse().unwrap_or(0);
    if chrono::NaiveDate::from_ymd_opt(year, month, day).is_some() {
        base.to_owned()
    } else {
        id
    }
}
pub(super) fn find_reference<'a>(rows: &'a [Value], model: &str) -> Option<&'a Value> {
    let id = norm(model);
    if id.is_empty() {
        return None;
    }
    for level in 0..4 {
        let mut matches: Vec<_> = rows
            .iter()
            .filter(|row| {
                if row["canonicalModelId"].is_null()
                    && row["modelId"]
                        .as_str()
                        .or_else(|| row["tokens"][0].as_str())
                        .unwrap_or("")
                        .contains('/')
                    && !id.contains('/')
                {
                    return false;
                }
                let mut names = vec![row["modelId"]
                    .as_str()
                    .or_else(|| row["tokens"][0].as_str())
                    .unwrap_or("")];
                names.push(text(row, "canonicalModelId"));
                if level > 0 {
                    names.extend(
                        row["aliases"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str),
                    );
                }
                names.into_iter().filter(|s| !s.is_empty()).any(|name| {
                    let name = norm(name);
                    match level {
                        0 | 1 => name == id || !id.contains('/') && bare(&name) == id,
                        2 => canonical(&name) == canonical(&id),
                        _ => {
                            canonical(&undated(&name)) == canonical(&undated(&id))
                                && (undated(&name) != name || undated(&id) != id)
                        }
                    }
                })
            })
            .collect();
        if matches.is_empty() {
            continue;
        }
        matches.sort_by_key(|r| r["referencePriority"].as_u64().unwrap_or(0));
        let best = matches[0]["referencePriority"].as_u64().unwrap_or(0);
        matches.retain(|r| r["referencePriority"].as_u64().unwrap_or(0) == best);
        let targets: std::collections::BTreeSet<_> = matches
            .iter()
            .map(|r| {
                norm(r["canonicalModelId"].as_str().unwrap_or_else(|| {
                    r["modelId"]
                        .as_str()
                        .or_else(|| r["tokens"][0].as_str())
                        .unwrap_or("")
                }))
            })
            .collect();
        return if targets.len() == 1 {
            matches.first().copied()
        } else {
            None
        };
    }
    None
}
fn is_owner(provider: &str) -> bool {
    let owners: Vec<String> =
        serde_json::from_str(include_str!("../../src/shared/model-price-providers.json"))
            .expect("embedded providers");
    owners.iter().any(|p| p == owner_id(provider)) || ["tencent", "meta"].contains(&provider)
}
pub(super) fn pricing(value: &Value) -> Vec<Value> {
    let mut entries = vec![];
    let mut ids: std::collections::BTreeMap<String, std::collections::BTreeSet<String>> =
        std::collections::BTreeMap::new();
    for (provider, catalog) in value.as_object().into_iter().flatten() {
        for (id, raw) in catalog["models"].as_object().into_iter().flatten() {
            let target = raw["canonical_model_id"]
                .as_str()
                .map(norm)
                .unwrap_or_else(|| {
                    if is_owner(provider) {
                        norm(&format!("{}/{id}", owner_id(provider)))
                    } else {
                        String::new()
                    }
                });
            if !target.is_empty() {
                ids.entry(norm(id)).or_default().insert(target.clone());
            }
            entries.push((provider.as_str(), id.as_str(), raw, target));
        }
    }
    let mut groups: std::collections::BTreeMap<String, Vec<usize>> =
        std::collections::BTreeMap::new();
    for (i, (_, id, _, target)) in entries.iter().enumerate() {
        let target = if target.is_empty() {
            ids.get(&norm(id))
                .filter(|s| s.len() == 1)
                .and_then(|s| s.first())
                .cloned()
                .unwrap_or_default()
        } else {
            target.clone()
        };
        if !target.is_empty() {
            groups.entry(target).or_default().push(i);
        }
    }
    let mut rules = vec![];
    for (target, group) in groups {
        let mut candidates: Vec<_> = group
            .iter()
            .filter_map(|i| {
                let (provider, id, raw, _) = &entries[*i];
                (reference_priority(provider, &target) < 99 && cost_rates(&raw["cost"]).is_some())
                    .then_some((
                        *i,
                        reference_priority(provider, &target),
                        *provider != owner_id(target.split('/').next().unwrap_or("")),
                        *id,
                    ))
            })
            .collect();
        candidates.sort_by(|a, b| (a.1, a.2, a.3).cmp(&(b.1, b.2, b.3)));
        let Some((index, priority, _, _)) = candidates.first() else {
            continue;
        };
        let (provider, id, raw, _) = &entries[*index];
        let mut rule = cost_rates(&raw["cost"]).unwrap();
        if raw["cost"]["tiers"]
            .as_array()
            .is_some_and(|t| !t.is_empty())
        {
            let Some(tiers) = cost_tiers(&raw["cost"]) else {
                continue;
            };
            rule["tiers"] = tiers;
        }
        let mut aliases: std::collections::BTreeSet<String> =
            group.iter().map(|i| norm(entries[*i].1)).collect();
        aliases.insert(target.clone());
        aliases.insert(bare(&target).into());
        rule["modelId"] = json!(norm(id));
        rule["tokens"] = json!([norm(id)]);
        rule["match"] = json!("exact");
        rule["canonicalModelId"] = json!(target);
        rule["aliases"] = json!(aliases);
        rule["referencePriority"] = json!(priority);
        rule["referenceOnly"] = json!(true);
        rule["providerId"] = json!(provider);
        rule["source"] = json!("models.dev");
        rule["protocol"] = json!(if target.starts_with("anthropic/") {
            "anthropic"
        } else {
            "openai"
        });
        if rule["cacheWrite"].is_null() {
            if let Some(policy) =
                cache_write_policy(target.split('/').next().unwrap_or(provider), id)
            {
                rule["cacheWritePolicy"] = policy;
                rule["cacheWritePolicySource"] = json!("official");
                if owner_id(target.split('/').next().unwrap_or(provider)) == "volcengine" {
                    rule["cacheStorageScope"] = json!("explicit");
                }
            }
        }
        rules.push(rule);
    }
    rules
}

fn cache_write_policy(provider: &str, id: &str) -> Option<Value> {
    static POLICIES: std::sync::OnceLock<Vec<Value>> = std::sync::OnceLock::new();
    let policies = POLICIES.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/shared/cache-write-policies.json"))
            .expect("embedded cache-write policies")
    });
    policies
        .iter()
        .find(|rule| {
            rule["providerId"] == provider
                && (text(rule, "modelPattern").is_empty()
                    || regex::Regex::new(text(rule, "modelPattern"))
                        .expect("embedded model pattern")
                        .is_match(&id.to_lowercase()))
        })
        .map(|rule| rule["policy"].clone())
}
pub(super) fn normalize_cached_price(mut rule: Value) -> Value {
    if rule["source"] == "models.dev" {
        let policy = if rule["cacheWrite"].as_f64().is_none() {
            cache_write_policy(
                text(&rule, "providerId"),
                rule["modelId"]
                    .as_str()
                    .or_else(|| rule["tokens"][0].as_str())
                    .unwrap_or("")
                    .trim(),
            )
        } else {
            None
        };
        if let Some(fields) = rule.as_object_mut() {
            fields.remove("cacheWritePolicy");
            fields.remove("cacheWritePolicySource");
            if let Some(policy) = policy {
                fields.insert("cacheWritePolicy".into(), policy);
                fields.insert("cacheWritePolicySource".into(), json!("official"));
                if ["volcengine", "bytedance-seed"].contains(
                    &fields
                        .get("providerId")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                ) {
                    fields.insert("cacheStorageScope".into(), json!("explicit"));
                }
            }
        }
    }
    rule
}
pub(super) fn merge_prices(previous: &[Value], fresh: Vec<Value>) -> Vec<Value> {
    let _ = previous;
    fresh.into_iter().map(normalize_cached_price).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_protocol_cache_is_ignored() {
        let root = std::env::temp_dir().join(format!(
            "xwx-legacy-capabilities-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir_all(&root).unwrap();
        let cache = json!({"version":1,"modelsDev":[{"modelId":"old-fixture","canonicalModelId":"owner/old-fixture","capability":{"contextWindow":777}}],"litellm":[{"modelId":"minimax-m2.5","sourceId":"minimax/MiniMax-M2.5","capability":{"servingProvider":"minimax","openAiProtocols":["chat-completions"]}}]});
        let path = root.join("model-capabilities-cache.json");
        let before = cache.to_string();
        fs::write(&path, &before).unwrap();
        let loaded = cached_capabilities(&root).unwrap();
        assert!(loaded["litellm"].is_null());
        assert_eq!(
            resolve(&loaded, "modelsDev", "old-fixture")["contextWindow"],
            777
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), before);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn complete_reasoning_metadata_is_not_an_effort_guess() {
        let raw = json!({"xiaomi":{"models":{
            "mimo-fixture":{"reasoning":true,"reasoning_options":[{"type":"toggle"},{"type":"budget_tokens","min":1024,"max":32768}],"interleaved":{"field":"reasoning_content"},"temperature":false,"limit":{"context":1000000,"input":900000,"output":64000},"modalities":{"input":["text"],"output":["text"]}},
            "mimo-empty":{"reasoning":true,"reasoning_options":[]}
        }},"reseller":{"models":{"mimo-fixture":{"limit":{"context":128000}},"xiaomi/mimo-fixture":{"canonical_model_id":"xiaomi/mimo-fixture","limit":{"context":64000}}}}});
        let remote = json!({"modelsDev":parse_models(&raw)});
        let got = resolve(&remote, "modelsDev", "mimo-fixture");
        assert_eq!(got["contextWindow"], 1000000);
        assert_eq!(got["maxInputTokens"], 900000);
        assert_eq!(got["interleavedThinking"], true);
        assert_eq!(
            got["reasoningOptions"],
            raw["xiaomi"]["models"]["mimo-fixture"]["reasoning_options"]
        );
        assert_eq!(got["levels"], json!([]));
        assert_eq!(
            resolve(&remote, "modelsDev", "mimo-empty")["levels"],
            json!([])
        );
    }
    #[test]
    fn cached_guesses_do_not_become_official_rates() {
        let legacy = |provider, policy| json!({"source":"models.dev","providerId":provider,"modelId":"cache-fixture","cacheWritePolicy":policy});
        assert!(normalize_cached_price(legacy("minimax", "free"))["cacheWritePolicy"].is_null());
        let google = normalize_cached_price(legacy("google", "unknown"));
        assert_eq!(google["cacheWritePolicy"], "storage");
        assert_eq!(google["cacheWritePolicySource"], "official");
        let documented = json!({"source":"official","providerId":"fixture","cacheWritePolicy":"free","cacheWritePolicySource":"official"});
        assert_eq!(normalize_cached_price(documented.clone()), documented);
    }
    #[test]
    fn shared_price_catalog_contract() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../tools/shared-core/trace-price-catalog-cases.json"
        ))
        .unwrap();
        for case in cases {
            let provider = text(&case, "providerId");
            let id = text(&case, "modelId");
            let mut source = json!({});
            source[provider] = json!({"models":{id:{"cost":case["cost"]}}});
            let rows = pricing(&source);
            if case["expected"].is_null() {
                assert!(rows.is_empty(), "{}", case["name"]);
                continue;
            }
            assert_eq!(rows.len(), 1, "{}", case["name"]);
            for (key, expected) in case["expected"].as_object().unwrap() {
                if expected.is_number() {
                    assert_eq!(
                        rows[0][key].as_f64(),
                        expected.as_f64(),
                        "{} / {}",
                        case["name"],
                        key
                    );
                } else {
                    assert_eq!(&rows[0][key], expected, "{} / {}", case["name"], key);
                }
            }
        }
        let models: serde_json::Map<String, Value> = (0..5010)
            .map(|n| {
                (
                    format!("quality-{n}"),
                    json!({"cost":{"input":1,"output":2}}),
                )
            })
            .collect();
        assert_eq!(pricing(&json!({"anthropic":{"models":models}})).len(), 5010);
    }
    #[test]
    fn shared_standard_prices_and_aliases() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../tools/shared-core/models-dev-unification-cases.json"
        ))
        .unwrap();
        for case in cases {
            let rows = pricing(&case["catalog"]);
            let found = find_reference(&rows, text(&case, "lookup"));
            if case["provider"].is_null() {
                assert!(found.is_none(), "{}", case["name"]);
            } else {
                let row = found.unwrap_or_else(|| panic!("{}", case["name"]));
                assert_eq!(row["providerId"], case["provider"], "{}", case["name"]);
                assert_eq!(
                    row["input"].as_f64(),
                    case["input"].as_f64(),
                    "{}",
                    case["name"]
                );
            }
        }
    }
    #[test]
    fn owner_consensus_is_conservative() {
        let models = parse_models(
            &json!({"alibaba":{"models":{"qwen-future":{"limit":{"context":1000000},"modalities":{"input":["text","image"]}}}},"reseller":{"models":{"qwen-future":{"limit":{"context":128000},"modalities":{"input":["text"]}},"unknown":{"limit":{"context":128000},"tool_call":true}}},"another":{"models":{"unknown":{"limit":{"context":64000},"tool_call":false}}}}),
        );
        let remote = json!({"modelsDev":models});
        assert_eq!(
            resolve(&remote, "modelsDev", "models/provider/Qwen_Future")["contextWindow"],
            1000000
        );
        assert_eq!(resolve(&remote, "modelsDev", "qwen-future")["vision"], true);
        assert_eq!(
            resolve(&remote, "modelsDev", "unknown")["contextWindow"],
            Value::Null
        );
        assert!(resolve(&remote, "modelsDev", "unknown")["toolCalling"].is_null());
        assert!(
            resolve(&remote, "modelsDev", "unknown")["openAiProtocols"].is_null(),
            "models.dev has no wire protocol; unknown models must not be guessed"
        );
    }
    #[test]
    fn refresh_replaces_active_prices_and_preserves_reported_cache_rates() {
        let parsed = pricing(
            &json!({"openai":{"models":{"new-fixture":{"cost":{"input":10,"output":20,"cache_read":0.02}}}}}),
        );
        assert_eq!(parsed[0]["cacheRead"], 0.02);
        let curated = json!({"modelId":"new-fixture","input":3,"output":4,"tiers":[{"fromInputTokens":10000,"input":5}]});
        assert_eq!(
            merge_prices(std::slice::from_ref(&curated), parsed.clone()),
            parsed
        );
        let rows = pricing(&json!({"openai":{"models":{
            "gpt-5.4":{"cost":{"input":1,"output":2}},
            "gpt-5.6":{"cost":{"input":1,"output":2}},
            "gpt-6-astra":{"cost":{"input":1,"output":2,"cache_write":1.25}}
        }}}));
        assert_eq!(
            rows.iter().find(|r| r["modelId"] == "gpt-5.4").unwrap()["cacheWritePolicy"],
            "input"
        );
        assert!(
            rows.iter().find(|r| r["modelId"] == "gpt-5.6").unwrap()["cacheWritePolicy"].is_null()
        );
        assert_eq!(
            rows.iter().find(|r| r["modelId"] == "gpt-6-astra").unwrap()["cacheWrite"],
            1.25
        );
    }
}
