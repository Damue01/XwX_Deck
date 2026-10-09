use super::*;
fn normalized(model: &str) -> String {
    model
        .rsplit('/')
        .next()
        .unwrap_or(model)
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}
fn family(id: &str, prefix: &str) -> bool {
    id == prefix || id.starts_with(&format!("{prefix}-"))
}
pub(super) fn chat(out: &mut Value, body: &Value, provider: &Provider) {
    let effort = body["reasoning"]["effort"].as_str();
    let Some(effort) = effort else {
        return;
    };
    let enabled = !["none", "off", "disabled"].contains(&effort);
    let id = normalized(text(body, "model"));
    let base = provider.base_url.to_lowercase();
    out.as_object_mut().unwrap().remove("reasoning_effort");
    let mut toggle = "none";
    let mut field = "none";
    let mut mapping = "passthrough";
    let mut on = "enabled";
    if provider.provider_preset == "compatible" {
        if family(&id, "gpt-5")
            || id.as_bytes().first() == Some(&b'o')
                && id.as_bytes().get(1).is_some_and(|c| c.is_ascii_digit())
        {
            field = "reasoning_effort";
        } else if family(&id, "glm-5-3")
            || family(&id, "grok-4-3")
            || family(&id, "grok-4-5")
            || family(&id, "grok-4-6")
        {
            field = "reasoning_effort";
        } else if [
            "glm-5",
            "glm-5v",
            "qwen3",
            "deepseek-v4",
            "kimi-k3",
            "kimi-k2-5",
            "kimi-k2-6",
            "kimi-k2-7",
            "doubao-seed",
        ]
        .iter()
        .any(|p| family(&id, p))
            && !family(&id, "qwen3-coder-plus")
        {
            toggle = "thinking";
            field = "reasoning_effort";
        } else if id == "minimax-m2-5" {
            field = "reasoning_effort";
        } else if family(&id, "minimax-m3") {
            toggle = "thinking";
            on = "adaptive";
        }
    } else {
        let haystack = format!("{base} {id}");
        if haystack.contains("openrouter") {
            field = "reasoning.effort";
            mapping = "openrouter";
        } else if haystack.contains("siliconflow") {
            toggle = "enable_thinking";
        } else if haystack.contains("deepseek") {
            toggle = "thinking";
            field = "reasoning_effort";
            mapping = "deepseek";
        } else if haystack.contains("stepfun") || haystack.contains("step-3-5-flash") {
            if haystack.contains("2603") {
                field = "reasoning_effort";
                mapping = "low_high";
            }
        } else if ["kimi", "moonshot", "glm", "zhipu", "z.ai", "mimo"]
            .iter()
            .any(|s| haystack.contains(s))
        {
            toggle = "thinking";
        } else if ["qwen", "dashscope", "bailian"]
            .iter()
            .any(|s| haystack.contains(s))
        {
            toggle = "enable_thinking";
        } else if haystack.contains("minimax") {
            toggle = "reasoning_split";
        } else if family(&id, "gpt-5")
            || id.starts_with('o') && id.as_bytes().get(1).is_some_and(|c| c.is_ascii_digit())
            || family(&id, "grok-4-5")
        {
            field = "reasoning_effort";
        }
    }
    match toggle {
        "thinking" => out["thinking"] = json!({"type":if enabled{on}else{"disabled"}}),
        "enable_thinking" => out["enable_thinking"] = json!(enabled),
        "reasoning_split" => out["reasoning_split"] = json!(enabled),
        _ => {}
    }
    if !enabled {
        if field == "reasoning.effort" {
            out["reasoning"] = json!({"effort":"none"});
        } else if id == "minimax-m2-5" && field == "reasoning_effort" {
            out["reasoning_effort"] = json!(effort);
        }
        return;
    }
    let mapped = match mapping {
        "deepseek" => {
            if effort == "low" {
                "low"
            } else if effort == "max" {
                "max"
            } else {
                "high"
            }
        }
        "low_high" => {
            if ["minimal", "low"].contains(&effort) {
                "low"
            } else {
                "high"
            }
        }
        "openrouter" => {
            if ["max", "xhigh"].contains(&effort) {
                "xhigh"
            } else {
                effort
            }
        }
        _ => effort,
    };
    if field == "reasoning.effort" {
        out["reasoning"] = json!({"effort":mapped});
    } else if field == "reasoning_effort" {
        out["reasoning_effort"] = json!(mapped);
    }
}
pub(super) fn messages(out: &mut Value, body: &Value) {
    let effort = text(&body["reasoning"], "effort");
    if effort.is_empty() || ["none", "off", "disabled"].contains(&effort) {
        return;
    }
    let id = normalized(text(body, "model"));
    let adaptive = id.contains("claude-fable-")
        || [
            "claude-opus-4-7",
            "claude-haiku-4-7",
            "claude-sonnet-5",
            "claude-opus-5",
            "claude-haiku-5",
        ]
        .iter()
        .any(|s| id.contains(s));
    let native = adaptive
        || id.contains("claude-mythos-5")
        || ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-6"]
            .iter()
            .any(|s| id.contains(s));
    if native {
        out["output_config"] = json!({"effort":if effort=="minimal"{"low"}else{effort}});
        if adaptive {
            out["thinking"] = json!({"type":"adaptive"});
        }
        return;
    }
    let budget = match effort {
        "minimal" => 1024,
        "low" => 4096,
        "high" => 16384,
        "xhigh" => 24576,
        "max" => 32000,
        _ => 8192,
    };
    let budget = budget.min(out["max_tokens"].as_u64().unwrap_or(8192) / 2);
    if budget >= 1024 {
        out["thinking"] = json!({"type":"enabled","budget_tokens":budget});
        for key in ["temperature", "top_p"] {
            out.as_object_mut().unwrap().remove(key);
        }
    }
}
