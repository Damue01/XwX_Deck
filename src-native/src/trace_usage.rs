//! Provider counters stay distinct from their wire format. In particular,
//! Providers can send additive Anthropic counters on a Chat Completions route.
use serde_json::{json, Value};

fn first(values: &[&Value]) -> Option<u64> {
    let valid: Vec<u64> = values
        .iter()
        .filter_map(|v| {
            v.as_u64().or_else(|| {
                v.as_str().and_then(|s| {
                    let s = s.trim();
                    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
                        s.parse().ok()
                    } else {
                        None
                    }
                })
            })
        })
        .filter(|v| *v <= 9_007_199_254_740_991)
        .collect();
    valid
        .iter()
        .copied()
        .find(|v| *v > 0)
        .or_else(|| valid.first().copied())
}
fn add(a: u64, b: u64) -> Option<u64> {
    a.checked_add(b).filter(|v| *v <= 9_007_199_254_740_991)
}
fn positive(primary: Option<u64>, mirror: Option<u64>) -> Option<u64> {
    if primary.unwrap_or(0) > 0 {
        primary
    } else {
        mirror.or(primary)
    }
}
pub(super) fn normalize(value: &Value, wire: &str) -> Value {
    normalize_for_request(value, wire, &Value::Null)
}
pub(super) fn normalize_for_request(value: &Value, wire: &str, request: &Value) -> Value {
    let u = &value["usage"];
    if !u.is_object() {
        return json!({"incompleteFields":["input","cacheRead","cacheWrite","output","total"]});
    }
    let details = [
        "prompt_tokens_details",
        "input_tokens_details",
        "input_token_details",
    ]
    .iter()
    .find_map(|k| u.get(*k).filter(|v| v.is_object()))
    .unwrap_or(&Value::Null);
    let output_details = [
        "completion_tokens_details",
        "output_tokens_details",
        "output_token_details",
    ]
    .iter()
    .find_map(|k| u.get(*k).filter(|v| v.is_object()))
    .unwrap_or(&Value::Null);
    let creation = &u["cache_creation"];
    let mut input = first(&[
        &u["input_tokens"],
        &u["prompt_tokens"],
        &u["input"],
        &u["prompt"],
    ]);
    let mut output = first(&[
        &u["output_tokens"],
        &u["completion_tokens"],
        &u["output"],
        &u["completion"],
    ]);
    let mut five = first(&[
        &creation["ephemeral_5m_input_tokens"],
        &details["cache_write_5m_tokens"],
        &u["claude_cache_creation_5_m_tokens"],
    ]);
    let mut hour = first(&[
        &creation["ephemeral_1h_input_tokens"],
        &details["cache_write_1h_tokens"],
        &u["claude_cache_creation_1_h_tokens"],
    ]);
    let split = five.zip(hour).and_then(|(a, b)| add(a, b));
    // A lone TTL counter is sufficient only when an explicit write total lets
    // us derive its complement. Never call an omitted hour counter zero.
    let top_write = first(&[
        &u["cache_creation_input_tokens"],
        &u["cache_creation_tokens"],
        &u["cacheCreationTokens"],
        &creation["input_tokens"],
        &creation["tokens"],
    ])
    .or(split);
    let detail_write = first(&[
        &details["cache_creation_tokens"],
        &details["cache_creation_input_tokens"],
        &details["cache_write_tokens"],
    ]);
    let additive = ["messages", "anthropic-messages"].contains(&wire)
        || u.get("cache_creation_input_tokens").is_some()
        || u.get("cache_creation_tokens").is_some()
        || creation.is_object();
    let detail_read = first(&[
        &details["cached_tokens"],
        &details["cache_read_tokens"],
        &details["cache_read_input_tokens"],
    ]);
    let top_read = first(&[
        &u["cache_read_input_tokens"],
        &u["cache_read_tokens"],
        &u["cacheReadTokens"],
        &u["prompt_cache_hit_tokens"],
        &u["cached_tokens"],
    ]);
    let mut read = if additive {
        positive(top_read, detail_read)
    } else {
        positive(detail_read, top_read)
    };
    let mut write = if additive {
        positive(top_write, detail_write)
    } else {
        positive(detail_write, top_write)
    };
    let supplied = |values: &[&Value]| values.iter().any(|v| !v.is_null());
    let optional = [
        "chat-completions",
        "openai-chat-completions",
        "messages",
        "anthropic-messages",
    ]
    .contains(&wire)
        && (input.is_some() || output.is_some());
    let mut defaults = vec![];
    let mut derived = vec![];
    if optional
        && read.is_none()
        && !supplied(&[
            &details["cached_tokens"],
            &details["cache_read_tokens"],
            &details["cache_read_input_tokens"],
            &u["cache_read_input_tokens"],
            &u["cache_read_tokens"],
            &u["cacheReadTokens"],
            &u["prompt_cache_hit_tokens"],
            &u["cached_tokens"],
        ])
    {
        read = Some(0);
        defaults.push("cacheRead");
    }
    if optional
        && write.is_none()
        && !supplied(&[
            &u["cache_creation_input_tokens"],
            &u["cache_creation_tokens"],
            &u["cacheCreationTokens"],
            &creation["input_tokens"],
            &creation["tokens"],
            &details["cache_creation_tokens"],
            &details["cache_creation_input_tokens"],
            &details["cache_write_tokens"],
            &creation["ephemeral_5m_input_tokens"],
            &creation["ephemeral_1h_input_tokens"],
            &details["cache_write_5m_tokens"],
            &details["cache_write_1h_tokens"],
            &u["claude_cache_creation_5_m_tokens"],
            &u["claude_cache_creation_1_h_tokens"],
        ])
    {
        write = Some(0);
        defaults.push("cacheWrite");
    }
    if let Some(total) = write {
        if five.is_none() {
            five = hour.and_then(|h| total.checked_sub(h));
        }
        if hour.is_none() {
            hour = five.and_then(|f| total.checked_sub(f));
        }
    }
    fn hour_requested(value: &Value) -> bool {
        value["cache_control"]["ttl"] == "1h"
            || match value {
                Value::Object(fields) => fields.values().any(hour_requested),
                Value::Array(values) => values.iter().any(hour_requested),
                _ => false,
            }
    }
    if additive
        && write.is_some_and(|n| n > 0)
        && five.is_none()
        && hour.is_none()
        && request.is_object()
        && !hour_requested(request)
    {
        five = write;
        hour = Some(0);
        derived.push("cacheWriteTtl");
    }
    let cache = add(read.unwrap_or(0), write.unwrap_or(0));
    let explicit_total = first(&[&u["total_tokens"], &u["total"]]);
    if let Some((total, cache)) = explicit_total
        .zip(cache)
        .filter(|_| read.is_some() && write.is_some())
    {
        if let Some(known_output) = output.filter(|_| {
            input.is_none()
                && !supplied(&[
                    &u["input_tokens"],
                    &u["prompt_tokens"],
                    &u["input"],
                    &u["prompt"],
                ])
        }) {
            input = total
                .checked_sub(known_output)
                .and_then(|n| n.checked_sub(if additive { cache } else { 0 }));
            if input.is_some() {
                derived.push("input");
            }
        }
        if let Some(known_input) = input.filter(|_| {
            output.is_none()
                && !supplied(&[
                    &u["output_tokens"],
                    &u["completion_tokens"],
                    &u["output"],
                    &u["completion"],
                ])
        }) {
            output = total
                .checked_sub(known_input)
                .and_then(|n| n.checked_sub(if additive { cache } else { 0 }));
            if output.is_some() {
                derived.push("output");
            }
        }
    }
    let uncached = if additive {
        input
    } else {
        input.zip(cache).and_then(|(i, c)| i.checked_sub(c))
    };
    let input_total = if additive {
        input.zip(cache).and_then(|(i, c)| add(i, c))
    } else {
        input
    };
    let total = explicit_total.or_else(|| input_total.zip(output).and_then(|(i, o)| add(i, o)));
    let reasoning = first(&[
        &u["reasoning_tokens"],
        &output_details["reasoning_tokens"],
        &output_details["reasoning"],
        &output_details["thinking_tokens"],
        &u["thinking_tokens"],
    ]);
    let mut missing = vec![];
    if uncached.is_none() {
        missing.push("input");
    }
    if read.is_none() {
        missing.push("cacheRead");
    }
    if write.is_none() {
        missing.push("cacheWrite");
    }
    if output.is_none() {
        missing.push("output");
    }
    if total.is_none() {
        missing.push("total");
    }
    let mut normalized = json!({"inputTokens":input,"inputUncachedTokens":uncached,"inputTotalTokens":input_total,"outputTokens":output,"cacheReadTokens":read,"cacheCreationTokens":write,"cacheCreation5mTokens":five,"cacheCreation1hTokens":hour,"reasoningTokens":reasoning,"totalTokens":total,"inputIncludesCache":!additive,"incompleteFields":missing});
    if !defaults.is_empty() {
        normalized["optionalDefaults"] = json!(defaults);
    }
    if !derived.is_empty() {
        normalized["derivedFields"] = json!(derived);
    }
    if five
        .zip(hour)
        .zip(write)
        .is_some_and(|((f, h), w)| f.checked_add(h) != Some(w))
    {
        normalized["invalidFields"] = json!(["cacheWriteTtl"]);
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_usage_corpus() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../tools/shared-core/trace-usage-cases.json"
        ))
        .unwrap();
        for case in cases {
            let got = normalize_for_request(
                &json!({"usage":case["raw"]}),
                case["wire"].as_str().unwrap(),
                &case["request"],
            );
            for (key, expected) in case["expected"].as_object().unwrap() {
                assert_eq!(&got[key], expected, "{} / {}", case["name"], key);
            }
        }
    }
}
