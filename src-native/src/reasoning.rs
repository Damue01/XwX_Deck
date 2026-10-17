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
fn kimi_k3(id: &str) -> bool {
    family(id, "kimi-k3") || id == "k3" || id == "k3-256k"
}
fn kimi_k27(id: &str) -> bool {
    id.starts_with("kimi-k2-7-code") || id.starts_with("kimi-for-coding-highspeed")
}
fn kimi_coding_effort(id: &str) -> bool {
    id.starts_with("kimi-k2-8")
        || id == "kimi-for-coding"
        || id.starts_with("kimi-for-coding-") && !id.starts_with("kimi-for-coding-highspeed")
}
fn kimi_k26(id: &str) -> bool {
    family(id, "kimi-k2-6") || family(id, "kimi-k2-5")
}
fn aliyun_host(haystack: &str) -> bool {
    ["dashscope", "bailian", "aliyuncs.com"]
        .iter()
        .any(|name| haystack.contains(name))
}
fn deepseek_effort(effort: &str) -> &str {
    match effort {
        "minimal" | "low" => "low",
        "max" | "ultra" => "max",
        _ => "high",
    }
}
fn three_tier_effort(effort: &str) -> &str {
    match effort {
        "minimal" | "low" => "low",
        "medium" | "high" => "high",
        "xhigh" | "max" | "ultra" => "max",
        _ => "max",
    }
}
fn high_max_effort(effort: &str) -> &str {
    match effort {
        "max" | "ultra" => "max",
        _ => "high",
    }
}
fn fixed_sampling(out: &mut Value) {
    for key in ["temperature", "top_p"] {
        out.as_object_mut().unwrap().remove(key);
    }
}
/// Ark's Responses reasoning effort does not consistently enable thinking.
/// Preserve explicit provider-native controls; only translate an omitted toggle.
pub(super) fn responses(out: &mut Value, provider: &Provider) {
    let ark = provider.provider_preset == "volcengine-ark"
        || reqwest::Url::parse(&provider.base_url).is_ok_and(|url| {
            url.host_str()
                .is_some_and(|host| host == "volces.com" || host.ends_with(".volces.com"))
        });
    if !ark || !out["thinking"].is_null() {
        return;
    }
    let Some(effort) = out["reasoning"]["effort"].as_str() else {
        return;
    };
    let id = normalized(text(out, "model"));
    // Only the documented thinking-capable character generation needs this
    // explicit pairing. Earlier character and unrelated models stay untouched.
    if id != "doubao-seed-character-260628" {
        return;
    }
    let enabled = !["none", "off", "disabled", "minimal"].contains(&effort);
    out["thinking"] = json!({"type": if enabled { "enabled" } else { "disabled" }});
}

pub(super) fn chat(out: &mut Value, body: &Value, provider: &Provider) {
    let effort = body["reasoning"]["effort"].as_str();
    let Some(effort) = effort else {
        return;
    };
    let enabled = !["none", "off", "disabled"].contains(&effort);
    let id = normalized(text(body, "model"));
    let base = provider.base_url.to_lowercase();
    let haystack = format!("{base} {id}");
    out.as_object_mut().unwrap().remove("reasoning_effort");
    // Qwen3-Coder-Plus is a non-reasoning model. A client-wide reasoning
    // setting must not leak an unsupported field into its request.
    if family(&id, "qwen3-coder-plus") {
        return;
    }
    // OpenAI-compatible Chat services accept reasoning_effort by default.
    // Provider-specific branches below either replace that field, add the
    // service's thinking toggle, or map the requested tier.
    let mut toggle = "none";
    let mut field = "reasoning_effort";
    let mut mapping = "passthrough";
    let mut on = "enabled";
    let mut always_thinking = false;
    // A relay's OpenAI-compatible route is not evidence that it understands a
    // vendor-only thinking parameter. Known aggregators therefore use the
    // generic reasoning_effort field even when the model id looks like GLM/Qwen.
    let generic_effort_provider = [
        "gemini",
        "googleapis",
        "mistral",
        "tencent",
        "groq",
        "cerebras",
        "nvidia",
        "together",
        "fireworks",
        "perplexity",
        "huggingface",
        "api.openai.com",
        "api.x.ai",
    ]
    .iter()
    .any(|name| haystack.contains(name));
    if haystack.contains("openrouter") {
        field = "reasoning.effort";
        mapping = "openrouter";
    } else if haystack.contains("siliconflow") {
        if family(&id, "glm-5-3") || family(&id, "glm-5-2") {
            field = "reasoning_effort";
            mapping = if family(&id, "glm-5-3") {
                "three_tier"
            } else {
                "high_max"
            };
        } else {
            toggle = "enable_thinking";
            field = "none";
        }
    } else if aliyun_host(&haystack) {
        // Aliyun-hosted Qwen, DeepSeek, GLM and Kimi use enable_thinking even
        // when the model id is the same as a vendor-native endpoint.
        let qwen = ["qwen", "qwq"].iter().any(|name| id.starts_with(name));
        let deepseek = id.starts_with("deepseek");
        let kimi = ["kimi", "moonshot", "mimo"]
            .iter()
            .any(|name| id.starts_with(name));
        let glm = id.starts_with("glm") || id.starts_with("chatglm");
        if qwen && !family(&id, "qwen3-coder-plus") {
            toggle = "enable_thinking";
            if family(&id, "qwen3-8") {
                field = "reasoning_effort";
            } else {
                field = "none";
            }
        } else if deepseek {
            toggle = "enable_thinking";
            field = "reasoning_effort";
            mapping = "deepseek";
        } else if kimi {
            if kimi_k3(&id) {
                toggle = "enable_thinking";
                field = "reasoning_effort";
                mapping = "kimi";
            } else if kimi_k27(&id) {
                // K2.7 Code only accepts an enabled thinking mode.
                field = "none";
            } else if kimi_coding_effort(&id) {
                toggle = "enable_thinking";
                field = "reasoning_effort";
                mapping = "kimi";
            } else {
                toggle = "enable_thinking";
                field = "none";
            }
        } else if glm {
            if family(&id, "glm-5-3") || family(&id, "glm-5-2") {
                field = "reasoning_effort";
                if family(&id, "glm-5-3") {
                    always_thinking = true;
                    mapping = "three_tier";
                } else {
                    mapping = "high_max";
                }
            } else {
                field = "none";
            }
            if !family(&id, "glm-5-3") {
                toggle = "enable_thinking";
            }
        }
    } else if haystack.contains("deepseek") {
        toggle = "thinking";
        field = "reasoning_effort";
        if base.contains("api.deepseek.com") {
            mapping = "deepseek";
        }
    } else if family(&id, "minimax-m3") {
        toggle = "thinking";
        field = "none";
        on = "adaptive";
    } else if id == "minimax-m2-5" {
        field = "reasoning_effort";
    } else if haystack.contains("minimax") {
        toggle = "reasoning_split";
        field = "none";
    } else if haystack.contains("stepfun") || family(&id, "step-3-5-flash") {
        if haystack.contains("2603") {
            mapping = "low_high";
        }
    } else if generic_effort_provider {
        if family(&id, "glm-5-3") {
            mapping = "three_tier";
        } else if family(&id, "glm-5-2") {
            mapping = "high_max";
        }
    } else if family(&id, "glm-5-3") || family(&id, "glm-5-2") {
        // These GLM generations expose effort without a separate toggle.
        if family(&id, "glm-5-3") {
            always_thinking = true;
            mapping = "three_tier";
        } else {
            mapping = "high_max";
        }
    } else if family(&id, "glm-5") || family(&id, "glm-5v") || family(&id, "glm-4") {
        toggle = "thinking";
        field = "none";
    } else if kimi_k3(&id) {
        // K3 always reasons and does not accept the K2.x thinking parameter.
        field = "reasoning_effort";
        mapping = "kimi";
        always_thinking = true;
    } else if kimi_k27(&id) {
        // K2.7 Code always reasons and only accepts an enabled control when
        // one is sent at all. Omitting it is the documented request shape.
        field = "none";
        always_thinking = true;
    } else if kimi_coding_effort(&id) {
        toggle = "thinking";
        field = "reasoning_effort";
        mapping = "kimi";
    } else if ["kimi", "moonshot", "mimo"]
        .iter()
        .any(|name| haystack.contains(name))
    {
        toggle = "thinking";
        field = "none";
    } else if family(&id, "qwen3-8") {
        toggle = "enable_thinking";
        field = "reasoning_effort";
    } else if !family(&id, "qwen3-coder-plus")
        && ["qwen", "dashscope", "bailian"]
            .iter()
            .any(|name| haystack.contains(name))
    {
        toggle = "enable_thinking";
        field = "none";
    } else if family(&id, "doubao-seed") {
        toggle = "thinking";
        field = "reasoning_effort";
    }
    let kimi_model = kimi_k3(&id) || kimi_k27(&id) || kimi_k26(&id) || kimi_coding_effort(&id);
    if kimi_model {
        fixed_sampling(out);
    }
    match toggle {
        "thinking" => out["thinking"] = json!({"type":if enabled{on}else{"disabled"}}),
        "enable_thinking" => out["enable_thinking"] = json!(enabled),
        "reasoning_split" => out["reasoning_split"] = json!(enabled),
        _ => {}
    }
    if !enabled {
        if always_thinking {
            // Kimi K3 cannot disable thinking. The documented closest choice
            // is the lowest effort tier instead of an unsupported toggle.
            if field == "reasoning_effort" {
                out["reasoning_effort"] = json!("low");
            }
            return;
        }
        if field == "reasoning.effort" {
            out["reasoning"] = json!({"effort":"none"});
        } else if field == "reasoning_effort" && toggle == "none" {
            out["reasoning_effort"] = json!("none");
        } else if id == "minimax-m2-5" && field == "reasoning_effort" {
            out["reasoning_effort"] = json!(effort);
        }
        return;
    }
    let mapped = match mapping {
        "deepseek" => deepseek_effort(effort),
        "kimi" => three_tier_effort(effort),
        "three_tier" => three_tier_effort(effort),
        "high_max" => high_max_effort(effort),
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
    if effort.is_empty() {
        return;
    }
    let id = normalized(text(body, "model"));
    let disabled = ["none", "off", "disabled"].contains(&effort);
    if disabled {
        // DeepSeek and Kimi K3 default to thinking on. Their Messages APIs
        // accept an explicit disabled toggle, so a converted "none" must not
        // silently leave the vendor default in place.
        if id.starts_with("deepseek") || kimi_k3(&id) || kimi_k26(&id) {
            out["thinking"] = json!({"type":"disabled"});
            fixed_sampling(out);
        }
        return;
    }
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
        || [
            "claude-sonnet-4-6",
            "claude-opus-4-6",
            "claude-haiku-4-6",
            "claude-opus-4-5",
            "claude-opus-4-8",
        ]
        .iter()
        .any(|s| id.contains(s));
    if native {
        out["output_config"] = json!({"effort":if effort=="minimal"{"low"}else{effort}});
        if adaptive {
            out["thinking"] = json!({"type":"adaptive"});
        }
        return;
    }
    if id.starts_with("deepseek") {
        // DeepSeek ignores thinking.budget_tokens and reads the tier from
        // output_config. effort.
        out["thinking"] = json!({"type":"enabled"});
        out["output_config"] = json!({"effort":deepseek_effort(effort)});
        return;
    }
    if kimi_k3(&id) {
        // Kimi K3's Anthropic-compatible Messages API has no thinking budget;
        // it reads the tier from output_config. effort.
        out["output_config"] = json!({"effort":three_tier_effort(effort)});
        fixed_sampling(out);
        return;
    }
    if kimi_k27(&id) {
        // K2.7 Code only accepts an enabled, preserved-thinking control.
        out["thinking"] = json!({"type":"enabled","keep":"all"});
        fixed_sampling(out);
        return;
    }
    if kimi_k26(&id) {
        out["thinking"] = json!({"type":"enabled"});
        fixed_sampling(out);
        return;
    }
    if kimi_coding_effort(&id) {
        out["thinking"] = json!({"type":"enabled"});
        out["output_config"] = json!({"effort":three_tier_effort(effort)});
        fixed_sampling(out);
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

#[cfg(test)]
mod chat_tests {
    use super::*;

    fn mapped(base: &str, preset: &str, model: &str, effort: &str) -> Value {
        let provider = Provider {
            base_url: base.into(),
            provider_preset: preset.into(),
            ..Provider::default()
        };
        let mut out = json!({"model":model});
        chat(
            &mut out,
            &json!({"model":model,"reasoning":{"effort":effort}}),
            &provider,
        );
        out
    }
    fn effort(out: &Value) -> Option<&str> {
        out["reasoning_effort"].as_str()
    }

    #[test]
    fn chat_uses_the_effort_parameter_each_service_actually_accepts() {
        let cases = [
            (
                "https://open.bigmodel.cn/api/paas/v4",
                "glm-5.3",
                "high",
                Some("high"),
                None,
            ),
            (
                "https://api.z.ai/api/paas/v4",
                "glm-5.2",
                "max",
                Some("max"),
                None,
            ),
            (
                "https://api.moonshot.cn/v1",
                "kimi-k3",
                "high",
                Some("high"),
                None,
            ),
            (
                "https://api.moonshot.cn/v1",
                "kimi-k2.6",
                "high",
                None,
                Some("enabled"),
            ),
            (
                "https://api.moonshot.cn/v1",
                "kimi-k2.7-code",
                "high",
                None,
                None,
            ),
            (
                "https://api.kimi.com/coding/v1",
                "kimi-for-coding",
                "max",
                Some("max"),
                Some("enabled"),
            ),
            (
                "https://coding.dashscope.aliyuncs.com/v1",
                "kimi-k2.6",
                "high",
                None,
                None,
            ),
            (
                "https://coding.dashscope.aliyuncs.com/v1",
                "deepseek-v4-pro",
                "max",
                Some("max"),
                None,
            ),
            (
                "https://generativelanguage.googleapis.com/v1beta/openai",
                "gemini-3.5-flash",
                "medium",
                Some("medium"),
                None,
            ),
            (
                "https://api.mistral.ai/v1",
                "mistral-small-latest",
                "high",
                Some("high"),
                None,
            ),
            (
                "https://api.stepfun.com/v1",
                "step-5-preview",
                "medium",
                Some("medium"),
                None,
            ),
            (
                "https://coding.dashscope.aliyuncs.com/v1",
                "qwen3.8-max",
                "xhigh",
                Some("xhigh"),
                None,
            ),
            (
                "https://coding.dashscope.aliyuncs.com/v1",
                "qwen3.5-plus",
                "high",
                None,
                None,
            ),
            (
                "https://tokenhub.tencentmaas.com/v1",
                "hy3",
                "high",
                Some("high"),
                None,
            ),
            (
                "https://api.groq.com/openai/v1",
                "qwen/qwen3.8-27b",
                "high",
                Some("high"),
                None,
            ),
            (
                "https://api.deepseek.com",
                "deepseek-v4-pro",
                "low",
                Some("low"),
                Some("enabled"),
            ),
            (
                "https://api.minimax.cn/v1",
                "MiniMax-M3",
                "high",
                None,
                Some("adaptive"),
            ),
            (
                "https://api.minimax.cn/v1",
                "MiniMax-M2.5",
                "high",
                Some("high"),
                None,
            ),
            (
                "https://api.openai.com/v1",
                "gpt-5.4",
                "high",
                Some("high"),
                None,
            ),
            (
                "https://api.x.ai/v1",
                "grok-4.5",
                "high",
                Some("high"),
                None,
            ),
            (
                "https://compatible.example/v1",
                "future-model",
                "high",
                Some("high"),
                None,
            ),
        ];
        for (base, model, effort_value, expected_effort, expected_toggle) in cases {
            let out = mapped(base, "custom", model, effort_value);
            assert_eq!(
                effort(&out),
                expected_effort,
                "{model} effort at {base}: {out}"
            );
            if base.contains("dashscope") {
                assert_eq!(
                    out["enable_thinking"], true,
                    "{model} enable_thinking at {base}: {out}"
                );
            } else {
                assert_eq!(
                    out["thinking"]["type"].as_str(),
                    expected_toggle,
                    "{model} thinking at {base}: {out}"
                );
            }
        }
    }

    #[test]
    fn chat_maps_special_effort_ladders_and_disables_thinking_cleanly() {
        let step = mapped(
            "https://api.stepfun.com/v1",
            "custom",
            "step-3.5-flash-2603",
            "minimal",
        );
        assert_eq!(effort(&step), Some("low"));
        let silicon = mapped(
            "https://api.siliconflow.cn/v1",
            "custom",
            "deepseek-ai/DeepSeek-V4-Pro",
            "high",
        );
        assert_eq!(effort(&silicon), None);
        assert_eq!(silicon["enable_thinking"], true);
        let silicon_glm = mapped(
            "https://api.siliconflow.cn/v1",
            "custom",
            "zai-org/GLM-5.3",
            "high",
        );
        assert_eq!(effort(&silicon_glm), Some("high"));
        assert!(silicon_glm["thinking"].is_null());
        let openrouter = mapped(
            "https://openrouter.ai/api/v1",
            "custom",
            "deepseek/deepseek-v4-pro",
            "max",
        );
        assert_eq!(openrouter["reasoning"]["effort"], "xhigh");
        assert!(openrouter["reasoning_effort"].is_null());
        let deepseek_off = mapped(
            "https://api.deepseek.com",
            "custom",
            "deepseek-v4-pro",
            "none",
        );
        assert_eq!(deepseek_off["thinking"]["type"], "disabled");
        assert!(deepseek_off["reasoning_effort"].is_null());
        let ark_deepseek = mapped(
            "https://ark.cn-beijing.volces.com/api/v3",
            "custom",
            "deepseek-v4-pro-ga-260813",
            "medium",
        );
        assert_eq!(ark_deepseek["thinking"]["type"], "enabled");
        assert_eq!(ark_deepseek["reasoning_effort"], "medium");
        let glm_off = mapped(
            "https://open.bigmodel.cn/api/paas/v4",
            "custom",
            "glm-5.3",
            "none",
        );
        assert!(glm_off["thinking"].is_null());
        assert_eq!(glm_off["reasoning_effort"], "low");
        let glm_medium = mapped(
            "https://open.bigmodel.cn/api/paas/v4",
            "custom",
            "glm-5.3",
            "medium",
        );
        assert_eq!(glm_medium["reasoning_effort"], "high");
        let glm52_low = mapped("https://api.z.ai/api/paas/v4", "custom", "glm-5.2", "low");
        assert_eq!(glm52_low["reasoning_effort"], "high");
        let coder = mapped(
            "https://coding.dashscope.aliyuncs.com/v1",
            "custom",
            "qwen3-coder-plus",
            "high",
        );
        assert!(coder["reasoning_effort"].is_null());
        assert!(coder["thinking"].is_null());
        assert!(coder["enable_thinking"].is_null());
        let kimi_off = mapped("https://api.moonshot.cn/v1", "custom", "kimi-k3", "none");
        assert!(kimi_off["thinking"].is_null());
        assert_eq!(kimi_off["reasoning_effort"], "low");
        let kimi_k27_off = mapped(
            "https://api.moonshot.cn/v1",
            "custom",
            "kimi-k2.7-code",
            "none",
        );
        assert!(kimi_k27_off["thinking"].is_null());
        assert!(kimi_k27_off["reasoning_effort"].is_null());
        let aliyun_kimi_off = mapped(
            "https://coding.dashscope.aliyuncs.com/v1",
            "custom",
            "kimi-k2.6",
            "none",
        );
        assert_eq!(aliyun_kimi_off["enable_thinking"], false);
        assert!(aliyun_kimi_off["thinking"].is_null());
        let qwen_off = mapped(
            "https://coding.dashscope.aliyuncs.com/v1",
            "custom",
            "qwen3.8-max",
            "none",
        );
        assert_eq!(qwen_off["enable_thinking"], false);
        assert!(qwen_off["reasoning_effort"].is_null());
        let generic_off = mapped(
            "https://compatible.example/v1",
            "custom",
            "future-model",
            "none",
        );
        assert_eq!(effort(&generic_off), Some("none"));
    }

    #[test]
    fn aliyun_hosted_vendor_models_use_enable_thinking() {
        let deepseek = mapped(
            "https://coding.dashscope.aliyuncs.com/v1",
            "custom",
            "deepseek-v4-pro",
            "high",
        );
        assert_eq!(deepseek["enable_thinking"], true);
        assert_eq!(deepseek["reasoning_effort"], "high");
        assert!(deepseek["thinking"].is_null());
        let kimi = mapped(
            "https://coding.dashscope.aliyuncs.com/v1",
            "custom",
            "kimi-k3",
            "max",
        );
        assert_eq!(kimi["enable_thinking"], true);
        assert_eq!(kimi["reasoning_effort"], "max");
        assert!(kimi["thinking"].is_null());
        let glm = mapped(
            "https://coding.dashscope.aliyuncs.com/v1",
            "custom",
            "glm-5.2",
            "max",
        );
        assert_eq!(glm["enable_thinking"], true);
        assert_eq!(glm["reasoning_effort"], "max");
        assert!(glm["thinking"].is_null());
    }
}

#[cfg(test)]
mod messages_tests {
    use super::*;

    fn converted(model: &str, effort: &str) -> Value {
        let mut out = json!({"max_tokens":8192});
        messages(
            &mut out,
            &json!({"model":model,"reasoning":{"effort":effort}}),
        );
        out
    }

    #[test]
    fn native_claude_effort_models_use_output_config() {
        for model in [
            "claude-opus-4-8",
            "claude-opus-4-5",
            "claude-opus-4-6",
            "claude-sonnet-4-6",
            "claude-mythos-5",
        ] {
            let out = converted(model, "xhigh");
            assert_eq!(out["output_config"]["effort"], "xhigh", "{model}");
            assert!(out["thinking"].is_null(), "{model}");
        }
        let adaptive = converted("claude-opus-4-7", "high");
        assert_eq!(adaptive["output_config"]["effort"], "high");
        assert_eq!(adaptive["thinking"]["type"], "adaptive");
    }

    #[test]
    fn budget_only_claude_models_keep_a_bounded_thinking_budget() {
        let out = converted("claude-sonnet-4-5", "high");
        assert_eq!(out["thinking"]["type"], "enabled");
        assert_eq!(out["thinking"]["budget_tokens"], 4096);
        let disabled = converted("claude-opus-4-8", "none");
        assert!(disabled["output_config"].is_null());
        assert!(disabled["thinking"].is_null());
    }

    #[test]
    fn vendor_messages_apis_use_their_documented_thinking_controls() {
        let deepseek = converted("deepseek-v4-pro", "low");
        assert_eq!(deepseek["thinking"]["type"], "enabled");
        assert_eq!(deepseek["output_config"]["effort"], "low");
        assert!(deepseek["thinking"]["budget_tokens"].is_null());
        let deepseek_off = converted("deepseek-v4-pro", "none");
        assert_eq!(deepseek_off["thinking"]["type"], "disabled");
        assert!(deepseek_off["output_config"].is_null());

        let k3 = converted("kimi-k3", "high");
        assert_eq!(k3["output_config"]["effort"], "high");
        assert!(k3["thinking"].is_null());
        let k3_off = converted("kimi-k3", "none");
        assert_eq!(k3_off["thinking"]["type"], "disabled");

        let k27 = converted("kimi-k2.7-code", "high");
        assert_eq!(k27["thinking"]["type"], "enabled");
        assert_eq!(k27["thinking"]["keep"], "all");
        assert!(k27["thinking"]["budget_tokens"].is_null());

        let k26 = converted("kimi-k2.6", "high");
        assert_eq!(k26["thinking"]["type"], "enabled");
        assert!(k26["thinking"]["budget_tokens"].is_null());
    }
}

#[cfg(test)]
mod response_tests {
    use super::*;
    #[test]
    fn ark_character_pairs_effort_without_changing_explicit_controls() {
        let provider: Provider = serde_json::from_value(json!({
            "id":"ark", "baseUrl":"https://ark.cn-beijing.volces.com/api/v3"
        }))
        .unwrap();
        for (effort, toggle) in [
            ("low", "enabled"),
            ("high", "enabled"),
            ("minimal", "disabled"),
        ] {
            let mut body =
                json!({"model":"doubao-seed-character-260628","reasoning":{"effort":effort}});
            responses(&mut body, &provider);
            assert_eq!(body["thinking"]["type"], toggle);
            assert_eq!(body["reasoning"]["effort"], effort);
        }
        for mut body in [
            json!({"model":"doubao-seed-character-260628","reasoning":{"effort":"low"},"thinking":{"type":"disabled"}}),
            json!({"model":"doubao-seed-character-251128","reasoning":{"effort":"low"}}),
            json!({"model":"doubao-seed-character-260628"}),
        ] {
            let original = body.clone();
            responses(&mut body, &provider);
            assert_eq!(body, original);
        }
        let other: Provider =
            serde_json::from_value(json!({"id":"other","baseUrl":"https://example.com/v1"}))
                .unwrap();
        let mut body = json!({"model":"doubao-seed-character-260628","reasoning":{"effort":"low"}});
        let original = body.clone();
        responses(&mut body, &other);
        assert_eq!(body, original);
    }
}
