//! Only validated, explicitly returned service facts enter the provider layer.
use super::*;

fn first(row: &Value, paths: &[&str], valid: impl Fn(&Value) -> bool) -> Option<Value> {
    paths
        .iter()
        .find_map(|path| row.pointer(path).filter(|v| valid(v)).cloned())
}
fn number(v: &Value) -> bool {
    v.as_u64()
        .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
}
fn strings(v: &Value) -> bool {
    v.as_array().is_some_and(|a| {
        !a.is_empty()
            && a.iter()
                .all(|s| s.as_str().is_some_and(|s| !s.trim().is_empty()))
    })
}
pub(crate) fn unavailable(row: &Value) -> bool {
    row["runtimeRetired"] == true
        || row["lifecycleStatus"].as_str().is_some_and(|s| {
            matches!(
                s.to_ascii_lowercase().as_str(),
                "shutdown" | "retired" | "discontinued" | "offline"
            )
        })
}
pub(crate) fn non_conversational(row: &Value) -> bool {
    let id = text(row, "id")
        .trim()
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if id == "doubao-seed-translation" || id.starts_with("doubao-seed-translation-") {
        return true;
    }
    if matches!(
        text(row, "modelKind").to_ascii_lowercase().as_str(),
        "image"
            | "video"
            | "embedding"
            | "embeddings"
            | "rerank"
            | "reranking"
            | "speech"
            | "audio"
            | "3d"
            | "translation"
    ) {
        return true;
    }
    let tasks: Vec<String> = row["taskTypes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|s| {
            s.to_ascii_lowercase()
                .chars()
                .filter(char::is_ascii_alphanumeric)
                .collect()
        })
        .collect();
    if !tasks.is_empty()
        && tasks.iter().all(|t| {
            matches!(
                t.as_str(),
                "textembedding"
                    | "imageembedding"
                    | "multimodalembedding"
                    | "embedding"
                    | "embeddings"
                    | "rerank"
                    | "reranking"
                    | "texttoimage"
                    | "imagetoimage"
                    | "imagegeneration"
                    | "texttovideo"
                    | "imagetovideo"
                    | "multimodaltovideo"
                    | "videogeneration"
                    | "videoextension"
                    | "videoediting"
                    | "imageto3d"
                    | "textto3d"
                    | "texttospeech"
                    | "speechsynthesis"
                    | "transcription"
                    | "speechtotext"
            )
        })
    {
        return true;
    }
    if let Some(output) = row["outputModalities"].as_array().filter(|a| !a.is_empty()) {
        if !output
            .iter()
            .filter_map(Value::as_str)
            .any(|s| s.eq_ignore_ascii_case("text"))
        {
            return true;
        }
    }
    if !tasks.is_empty() {
        return false;
    }
    static IDS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let id = text(row, "id")
        .trim()
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    IDS.get_or_init(|| regex::Regex::new(r"^(?:text-embedding|gpt-image|dall-e|embed|embedding|rerank|bge-reranker|sora|veo|imagen|whisper|tts|doubao-(?:embedding|seedream|seedance|seed3d)|hyper3d|hitem3d|qwen\d?(?:\.\d)?-(?:embedding|reranker))(?:[-_.]|$)").unwrap()).is_match(&id)
        || id == "qwen-vl-ocr"
}

pub(super) fn attach(entry: &mut Value, row: &Value) {
    if let Some(price) = super::super::provider_pricing::parse(row, text(entry, "id")) {
        entry["providerPrice"] = price;
    }
    let mut cap = json!({});
    for (key, paths) in [
        (
            "contextWindow",
            vec![
                "/context_window",
                "/contextWindow",
                "/context_length",
                "/max_context_window",
                "/token_limits/context_window",
                "/limit/context",
                "/capabilities/context_window",
            ],
        ),
        (
            "maxInputTokens",
            vec![
                "/max_input_tokens",
                "/input_token_limit",
                "/inputTokenLimit",
                "/token_limits/max_input_token_length",
                "/limit/input",
                "/capabilities/max_input_tokens",
            ],
        ),
        (
            "maxOutputTokens",
            vec![
                "/max_output_tokens",
                "/maxOutputTokens",
                "/max_completion_tokens",
                "/output_token_limit",
                "/outputTokenLimit",
                "/token_limits/max_output_token_length",
                "/limit/output",
                "/capabilities/max_output_tokens",
            ],
        ),
        (
            "maxReasoningTokens",
            vec![
                "/max_reasoning_tokens",
                "/token_limits/max_reasoning_token_length",
            ],
        ),
    ] {
        if let Some(v) = first(row, &paths, number) {
            cap[key] = v;
        }
    }
    for (key, paths) in [
        (
            "inputModalities",
            vec![
                "/input_modalities",
                "/inputModalities",
                "/modalities/input_modalities",
                "/modalities/input",
                "/capabilities/input_modalities",
            ],
        ),
        (
            "outputModalities",
            vec![
                "/output_modalities",
                "/outputModalities",
                "/modalities/output_modalities",
                "/modalities/output",
                "/capabilities/output_modalities",
            ],
        ),
        (
            "levels",
            vec![
                "/reasoning_levels",
                "/reasoningLevels",
                "/reasoning_efforts",
                "/supported_reasoning_levels",
                "/capabilities/reasoning_levels",
            ],
        ),
    ] {
        if let Some(v) = first(row, &paths, |v| {
            strings(v) || key == "levels" && v.as_array().is_some_and(Vec::is_empty)
        }) {
            cap[key] = v;
        }
    }
    for path in [
        "/reasoning_levels",
        "/reasoningLevels",
        "/reasoning_efforts",
        "/supported_reasoning_levels",
        "/capabilities/reasoning_levels",
    ] {
        if let Some(values) = row.pointer(path).and_then(Value::as_array) {
            let mut levels = vec![];
            for value in values {
                if let Some(level) = value
                    .as_str()
                    .or_else(|| value["effort"].as_str())
                    .filter(|s| !s.trim().is_empty() && s.len() <= 128)
                {
                    let level = json!(level.trim().to_ascii_lowercase());
                    if !levels.contains(&level) {
                        levels.push(level);
                    }
                }
            }
            if values.is_empty() || !levels.is_empty() {
                cap["levels"] = json!(levels);
                break;
            }
        }
    }
    for (key, paths) in [
        (
            "vision",
            vec!["/vision", "/supports_vision", "/capabilities/vision"],
        ),
        (
            "reasoning",
            vec![
                "/reasoning",
                "/supports_reasoning",
                "/capabilities/reasoning",
                "/capabilities/thinking",
            ],
        ),
        (
            "toolCalling",
            vec![
                "/toolCalling",
                "/tool_call",
                "/tool_calling",
                "/supports_tool_calling",
                "/supports_function_calling",
                "/features/tools/function_calling",
                "/capabilities/functioncall",
                "/capabilities/tool_calling",
            ],
        ),
        (
            "structuredOutput",
            vec![
                "/structuredOutput",
                "/structured_output",
                "/supports_structured_output",
                "/supports_response_schema",
                "/features/structured_outputs/json_schema",
                "/capabilities/response_format",
            ],
        ),
        (
            "interleavedThinking",
            vec![
                "/interleavedThinking",
                "/interleaved",
                "/capabilities/interleaved",
            ],
        ),
        ("temperature", vec!["/temperature", "/supports_temperature"]),
    ] {
        if let Some(v) = first(row, &paths, Value::is_boolean) {
            cap[key] = v;
        }
    }
    // Client-only controls require explicit service facts. Do not infer these
    // from generic tool or reasoning capability in models.dev.
    for (key, paths) in [
        (
            "supportsSearchTool",
            vec![
                "/supports_search_tool",
                "/supports_web_search",
                "/capabilities/web_search",
            ],
        ),
        (
            "supportVerbosity",
            vec![
                "/support_verbosity",
                "/supports_verbosity",
                "/capabilities/verbosity",
            ],
        ),
    ] {
        if let Some(v) = first(row, &paths, Value::is_boolean) {
            cap[key] = v;
        }
    }
    for (key, paths) in [
        (
            "autoCompactTokenLimit",
            vec!["/auto_compact_token_limit", "/autoCompactTokenLimit"],
        ),
        (
            "effectiveContextWindowPercent",
            vec![
                "/effective_context_window_percent",
                "/effectiveContextWindowPercent",
            ],
        ),
    ] {
        if let Some(v) = first(row, &paths, |v| {
            number(v)
                && (key != "effectiveContextWindowPercent" || v.as_u64().is_some_and(|n| n <= 100))
        }) {
            cap[key] = v;
        }
    }
    for (key, paths, allowed) in [
        (
            "defaultVerbosity",
            vec!["/default_verbosity", "/defaultVerbosity"],
            vec!["low", "medium", "high"],
        ),
        (
            "webSearchToolType",
            vec!["/web_search_tool_type"],
            vec!["text", "text_and_image"],
        ),
    ] {
        if let Some(v) = first(row, &paths, |v| {
            v.as_str().is_some_and(|s| allowed.contains(&s))
        }) {
            cap[key] = v;
        }
    }
    if cap["vision"].is_null() {
        if let Some(a) = cap["inputModalities"].as_array() {
            cap["vision"] = json!(a
                .iter()
                .any(|s| [json!("image"), json!("video"), json!("pdf")].contains(s)));
        }
    }
    // A declared reasoning-token budget is evidence of reasoning capacity,
    // but does not establish any particular effort/toggle parameter.
    if cap["reasoning"].is_null()
        && (cap["maxReasoningTokens"].is_number()
            || cap["levels"].as_array().is_some_and(|a| !a.is_empty()))
    {
        cap["reasoning"] = json!(true);
    }
    for (key, paths) in [
        (
            "defaultLevel",
            vec![
                "/default_reasoning_level",
                "/defaultReasoningLevel",
                "/default_reasoning_effort",
            ],
        ),
        (
            "interleavedField",
            vec!["/interleaved_field", "/interleaved/field"],
        ),
    ] {
        if let Some(v) = first(row, &paths, |v| {
            v.as_str().is_some_and(|s| !s.trim().is_empty())
        }) {
            cap[key] = v;
        }
    }
    if let Some(v) = first(
        row,
        &["/reasoning_options", "/reasoningOptions"],
        Value::is_array,
    ) {
        cap["reasoningOptions"] = v;
    }
    if !cap.as_object().unwrap().is_empty() {
        entry["providerCapabilities"] = cap;
    }
    for (key, paths) in [
        (
            "displayName",
            vec!["/display_name", "/displayName", "/name"],
        ),
        ("modelVersion", vec!["/version", "/primary_version"]),
        (
            "modelKind",
            vec!["/kind", "/model_type", "/type", "/category"],
        ),
        ("domain", vec!["/domain"]),
        ("lifecycleStatus", vec!["/lifecycle_status", "/status"]),
    ] {
        if let Some(v) = first(row, &paths, |v| {
            v.as_str().is_some_and(|s| !s.trim().is_empty())
        }) {
            entry[key] = v;
        }
    }
    if let Some(v) = first(row, &["/created"], Value::is_u64) {
        entry["created"] = v;
    }
    if let Some(v) = first(row, &["/task_type", "/task_types"], strings) {
        entry["taskTypes"] = v;
    }
    // Preserve public provider feature facts without copying arbitrary response
    // properties (which could include credentials or account information).
    let mut features = json!({});
    for (group, keys) in [
        ("tools", vec!["function_calling"]),
        ("structured_outputs", vec!["json_object", "json_schema"]),
        (
            "cache",
            vec!["prefix_cache", "session_cache", "implicit_cache"],
        ),
        ("batch", vec!["batch_chat", "batch_job"]),
    ] {
        for key in keys {
            if row["features"][group][key].is_boolean() {
                if !features[group].is_object() {
                    features[group] = json!({});
                }
                features[group][key] = row["features"][group][key].clone();
            }
        }
    }
    if !features.as_object().unwrap().is_empty() {
        entry["providerFeatures"] = features;
    }
}

#[cfg(test)]
mod purpose_tests {
    use super::*;
    #[test]
    fn shared_model_purpose_cases() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../tools/shared-core/model-purpose-cases.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(
                non_conversational(&case["model"]),
                case["excluded"].as_bool().unwrap(),
                "{}",
                case["model"]["id"]
            );
        }
    }
}
