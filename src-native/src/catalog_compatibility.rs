//! Codex runtime controls are not generic model capacities.
use super::*;

pub(super) fn resolve(entry: &Value, native: Option<&Value>, wire: &str) -> Value {
    let provider = &entry["providerCapabilities"];
    let native = native.unwrap_or(&Value::Null);
    let context = codex_window(entry, Some(native));
    let compact_limit = context / 10 * 9 + context % 10 * 9 / 10;
    let mut values = json!({});
    let mut sources = json!({});
    let mut restrictions = json!({});
    for (field, key, fallback, upper) in [
        (
            "auto_compact_token_limit",
            "autoCompactTokenLimit",
            compact_limit,
            compact_limit,
        ),
        (
            "effective_context_window_percent",
            "effectiveContextWindowPercent",
            95,
            100,
        ),
    ] {
        let (number, source) = [("provider", &provider[key]), ("codex", &native[field])]
            .into_iter()
            .find_map(|(source, value)| {
                value
                    .as_u64()
                    .filter(|n| {
                        *n > 0
                            && *n <= 9_007_199_254_740_991
                            && (field != "effective_context_window_percent" || *n <= 100)
                    })
                    .map(|n| (n, source))
            })
            .unwrap_or((fallback, "fallback"));
        // Leave the default lazy: config may select a larger runtime window.
        // Codex derives 90% after applying that selection.
        if field != "auto_compact_token_limit" || source != "fallback" {
            values[field] = json!(number.min(upper));
        }
        sources[field] = json!(source);
        if number > upper {
            restrictions[field] = json!("client-context-limit");
        }
    }
    for (field, key) in [
        ("supports_search_tool", "supportsSearchTool"),
        ("support_verbosity", "supportVerbosity"),
    ] {
        let (supported, source) = provider[key]
            .as_bool()
            .map(|v| (v, "provider"))
            // An official client template cannot prove a relay's support.
            .or_else(|| (native[field] == false).then_some((false, "codex")))
            .unwrap_or((false, "fallback"));
        if supported && wire != "responses" {
            values[field] = json!(false);
            sources[field] = json!("protocol");
            restrictions[field] = json!(wire);
        } else {
            values[field] = json!(supported);
            sources[field] = json!(source);
            if source == "fallback" && native[field] == true {
                restrictions[field] = json!("service-unconfirmed");
            }
        }
    }
    for (field, key, allowed, fallback) in [
        (
            "default_verbosity",
            "defaultVerbosity",
            vec!["low", "medium", "high"],
            "medium",
        ),
        (
            "web_search_tool_type",
            "webSearchToolType",
            vec!["text", "text_and_image"],
            "text",
        ),
    ] {
        let (value, source) = [("provider", &provider[key]), ("codex", &native[field])]
            .into_iter()
            .find_map(|(source, value)| {
                value
                    .as_str()
                    .filter(|v| allowed.contains(v))
                    .map(|v| (v, source))
            })
            .unwrap_or((fallback, "fallback"));
        values[field] = json!(value);
        sources[field] = json!(source);
    }
    json!({"values": values, "sources": sources, "restrictions": restrictions})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_thresholds_survive_and_service_limits_bound_them() {
        let native = json!({"context_window":500000,"auto_compact_token_limit":400000,"effective_context_window_percent":92});
        let entry =
            json!({"contextWindow":1050000,"capabilitySources":{"contextWindow":"models.dev"}});
        let result = resolve(&entry, Some(&native), "responses");
        assert_eq!(result["values"]["auto_compact_token_limit"], 400000);
        assert_eq!(result["values"]["effective_context_window_percent"], 92);
        assert_eq!(result["sources"]["auto_compact_token_limit"], "codex");
        let restricted = json!({"contextWindow":100000,"capabilitySources":{"contextWindow":"provider"},"providerCapabilities":{"autoCompactTokenLimit":95000,"effectiveContextWindowPercent":90}});
        let result = resolve(&restricted, Some(&native), "responses");
        assert_eq!(result["values"]["auto_compact_token_limit"], 90000);
        assert_eq!(
            result["restrictions"]["auto_compact_token_limit"],
            "client-context-limit"
        );
        assert_eq!(result["values"]["effective_context_window_percent"], 90);
    }
    #[test]
    fn capabilities_require_service_evidence_and_a_supported_route() {
        let native =
            json!({"supports_search_tool":true,"support_verbosity":true,"default_verbosity":"low"});
        let unknown = json!({"contextWindow":100000,"toolCalling":true});
        let result = resolve(&unknown, Some(&native), "responses");
        assert_eq!(result["values"]["supports_search_tool"], false);
        assert_eq!(
            result["restrictions"]["support_verbosity"],
            "service-unconfirmed"
        );
        let declared = json!({"contextWindow":100000,"providerCapabilities":{"supportsSearchTool":true,"supportVerbosity":true,"defaultVerbosity":"high"}});
        let result = resolve(&declared, Some(&native), "responses");
        assert_eq!(result["values"]["supports_search_tool"], true);
        assert_eq!(result["values"]["support_verbosity"], true);
        assert_eq!(result["values"]["default_verbosity"], "high");
        for wire in ["chat-completions", "anthropic-messages"] {
            let result = resolve(&declared, Some(&native), wire);
            assert_eq!(result["values"]["supports_search_tool"], false);
            assert_eq!(result["sources"]["support_verbosity"], "protocol");
        }
        let disabled =
            json!({"providerCapabilities":{"supportsSearchTool":false,"supportVerbosity":false}});
        assert_eq!(
            resolve(&disabled, Some(&native), "responses")["sources"]["supports_search_tool"],
            "provider"
        );
    }
    #[test]
    fn malformed_controls_do_not_become_verified_defaults() {
        let entry = json!({"contextWindow":100000,"providerCapabilities":{"autoCompactTokenLimit":0,"effectiveContextWindowPercent":101,"defaultVerbosity":"invalid","supportsSearchTool":"true"}});
        let result = resolve(&entry, None, "responses");
        assert!(result["values"].get("auto_compact_token_limit").is_none());
        assert_eq!(result["sources"]["auto_compact_token_limit"], "fallback");
        assert_eq!(result["values"]["effective_context_window_percent"], 95);
        assert_eq!(
            result["sources"]["effective_context_window_percent"],
            "fallback"
        );
        assert_eq!(result["values"]["default_verbosity"], "medium");
        assert_eq!(result["values"]["supports_search_tool"], false);
    }
}
