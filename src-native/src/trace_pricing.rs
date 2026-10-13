use chrono::{Datelike, TimeZone, Utc};
use serde_json::{json, Value};

fn select_price<'a>(prices: &'a [Value], model: &str) -> Option<&'a Value> {
    super::model_metadata::find_reference(prices, model)
}

pub(super) fn model_cost(prices: &[Value], model: &str, usage: &Value, at: u128) -> Option<f64> {
    if usage["inputUncachedTokens"].as_u64().is_none()
        || usage["outputTokens"].as_u64().is_none()
        || usage["invalidFields"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
    {
        return None;
    }
    let price = select_price(prices, model)?;
    let total = usage["inputTotalTokens"].as_u64().unwrap_or(0);
    let tier = price["tiers"].as_array().and_then(|tiers| {
        tiers
            .iter()
            .rev()
            .find(|t| t["fromInputTokens"].as_u64().unwrap_or(0) <= total)
    });
    if price["tiers"].as_array().is_some_and(|t| !t.is_empty())
        && usage["inputTotalTokens"].as_u64().is_none()
    {
        return None;
    }
    let output = usage["outputTokens"].as_u64().unwrap_or(0);
    let hour = ((at / 1000 / 3600) % 24) as u64;
    let windows = price["peak"]["peakWindowsUtc"].as_array();
    let date = Utc.timestamp_millis_opt(at as i64).single()?;
    let excluded_day = price["peak"]["peakDaysUtc"].as_array().is_some_and(|days| {
        !days
            .iter()
            .any(|day| day.as_u64() == Some(date.weekday().num_days_from_sunday() as u64))
    });
    let calendar_date = (date
        + chrono::Duration::hours(
            price["peak"]["calendarUtcOffsetHours"]
                .as_i64()
                .unwrap_or(0),
        ))
    .format("%Y-%m-%d")
    .to_string();
    let holiday = price["peak"]["offPeakDateRanges"]
        .as_array()
        .is_some_and(|ranges| {
            ranges.iter().any(|range| {
                range[0]
                    .as_str()
                    .is_some_and(|from| calendar_date.as_str() >= from)
                    && range[1]
                        .as_str()
                        .is_some_and(|to| calendar_date.as_str() <= to)
            })
        });
    let off_peak = windows.is_some_and(|windows| {
        !windows.is_empty()
            && (excluded_day
                || holiday
                || !windows.iter().any(|w| {
                    hour >= w[0].as_u64().unwrap_or(0) && hour < w[1].as_u64().unwrap_or(24)
                }))
    });
    let scale = if off_peak {
        price["peak"]["offPeakMultiplier"].as_f64().unwrap_or(1.0)
    } else {
        1.0
    };
    let rate = |key: &str| {
        tier.and_then(|p| p[key].as_f64())
            .or_else(|| price[key].as_f64())
    };
    let write_rate =
        rate("cacheWrite").or_else(|| match price["cacheWritePolicy"].as_str().unwrap_or("") {
            "free" => Some(0.0),
            "input" => rate("input"),
            _ if ["deepseek", "xai"].contains(&price["providerId"].as_str().unwrap_or("")) => {
                rate("input")
            }
            _ => None,
        });
    // Missing detail need not prevent a token estimate when it cannot change
    // the charge: inclusive input and equal rates are enough. Keep the missing
    // flag in the record; this is a pricing decision, not invented usage.
    for field in usage["incompleteFields"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        match field {
            "total" => {}
            "cacheWrite"
                if price["cacheWritePolicy"] == "free"
                    && price["cacheWritePolicySource"] == "official"
                    && (price["tiers"].as_array().is_none_or(|t| t.is_empty())
                        || usage["inputIncludesCache"] == true) => {}
            "cacheRead"
                if usage["inputIncludesCache"] == true && rate("cacheRead") == rate("input") => {}
            "cacheWrite" if usage["inputIncludesCache"] == true && write_rate == rate("input") => {}
            _ => return None,
        }
    }
    let output_rate = tier
        .and_then(|p| {
            if output <= p["shortOutput"]["atMostTokens"].as_u64().unwrap_or(0) {
                p["shortOutput"]["output"].as_f64()
            } else {
                None
            }
        })
        .or_else(|| rate("output"))?;
    let reasoning_rate = rate("reasoning").unwrap_or(output_rate);
    let reasoning = usage["reasoningTokens"].as_u64();
    if reasoning_rate != output_rate
        && output > 0
        && (reasoning.is_none()
            || usage["reasoningComplete"] == false
            || reasoning.is_some_and(|n| n > output))
    {
        return None;
    }
    let output_cost = output as f64 * output_rate
        + reasoning.unwrap_or(0) as f64 * (reasoning_rate - output_rate);
    let mut cost =
        usage["inputUncachedTokens"].as_u64().unwrap_or(0) as f64 * rate("input")? + output_cost;
    let cache_read = usage["cacheReadTokens"].as_u64().unwrap_or(0);
    if cache_read > 0 {
        cost += cache_read as f64 * rate("cacheRead")?;
    }
    let cache_write = usage["cacheCreationTokens"].as_u64().unwrap_or(0);
    if cache_write > 0 {
        if price["cacheStoragePerHour"].as_f64().is_some() {
            return None;
        }
        if price["protocol"] == "anthropic"
            && usage["cacheCreation5mTokens"].as_u64().is_none()
            && usage["cacheCreation1hTokens"].as_u64().is_none()
        {
            return None;
        }
        let one_hour = usage["cacheCreation1hTokens"].as_u64().unwrap_or(0);
        if one_hour > cache_write {
            return None;
        }
        let five = usage["cacheCreation5mTokens"].as_u64().unwrap_or(0);
        if price["protocol"] == "anthropic" && five.checked_add(one_hour) != Some(cache_write) {
            return None;
        }
        let other = cache_write.saturating_sub(one_hour);
        if other > 0 {
            cost += other as f64 * write_rate?;
        }
        if one_hour > 0 {
            cost += one_hour as f64
                * rate("cacheWrite1h").or_else(|| {
                    if price["protocol"] == "anthropic" {
                        rate("input").map(|r| r * 2.0)
                    } else {
                        None
                    }
                })?;
        }
    }
    Some(cost * scale / 1_000_000.0)
}

// Keep costUsd complete-only for existing readers. knownCostUsd is explicitly a
// subtotal, paired with costComplete so zero never stands in for missing usage.
pub(super) fn model_cost_parts(
    prices: &[Value],
    model: &str,
    usage: &Value,
    at: u128,
) -> (Option<f64>, bool) {
    if let Some(cost) = model_cost(prices, model, usage, at) {
        return (Some(cost), true);
    }
    let missing = |field: &str| {
        usage["incompleteFields"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == field))
    };
    let invalid = |field: &str| {
        usage["invalidFields"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == field))
    };
    if usage["invalidFields"].as_array().is_some_and(|a| {
        a.iter().any(|v| {
            ![
                "input",
                "output",
                "cacheRead",
                "cacheWrite",
                "cacheWriteTtl",
                "total",
            ]
            .contains(&v.as_str().unwrap_or(""))
        })
    }) {
        return (None, false);
    }
    let project = |keys: &[&str], override_write: Option<u64>| {
        let mut part = usage.clone();
        for key in [
            "inputUncachedTokens",
            "outputTokens",
            "cacheReadTokens",
            "cacheCreationTokens",
        ] {
            part[key] = json!(0);
        }
        part.as_object_mut()
            .unwrap()
            .remove("cacheCreation5mTokens");
        part.as_object_mut()
            .unwrap()
            .remove("cacheCreation1hTokens");
        for key in keys {
            part[*key] = usage[*key].clone();
        }
        if let Some(write) = override_write {
            part["cacheCreationTokens"] = json!(write);
        }
        if !keys.contains(&"outputTokens") {
            part["reasoningComplete"] = json!(true);
        }
        part["reasoningTokens"] = if keys.contains(&"outputTokens") {
            usage["reasoningTokens"].clone()
        } else {
            json!(0)
        };
        part["incompleteFields"] = json!([]);
        part["invalidFields"] = json!([]);
        model_cost(prices, model, &part, at)
    };
    let mut known = None;
    let mut add = |cost: Option<f64>| {
        if let Some(cost) = cost {
            known = Some(known.unwrap_or(0.0) + cost);
        }
    };
    let valid = |field: &str, key: &str| {
        !missing(field) && !invalid(field) && usage[key].as_u64().is_some()
    };
    let mut input_group = usage.clone();
    input_group["outputTokens"] = json!(0);
    input_group["reasoningTokens"] = json!(0);
    input_group["reasoningComplete"] = json!(true);
    for field in ["incompleteFields", "invalidFields"] {
        input_group[field] = json!(usage[field]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|v| *v != "output" && *v != "total")
            .cloned()
            .collect::<Vec<_>>());
    }
    if let Some(input) = model_cost(prices, model, &input_group, at) {
        let output = if valid("output", "outputTokens") {
            project(&["outputTokens"], None).unwrap_or(0.0)
        } else {
            0.0
        };
        return (Some(input + output), false);
    }
    if valid("input", "inputUncachedTokens")
        && (usage["inputIncludesCache"] == false
            || (!missing("cacheRead") && !missing("cacheWrite")))
    {
        add(project(&["inputUncachedTokens"], None));
    }
    if valid("output", "outputTokens") {
        add(project(&["outputTokens"], None));
    }
    if valid("cacheRead", "cacheReadTokens") {
        add(project(&["cacheReadTokens"], None));
    }
    if valid("cacheWrite", "cacheCreationTokens") && !invalid("cacheWriteTtl") {
        let write = project(
            &[
                "cacheCreationTokens",
                "cacheCreation5mTokens",
                "cacheCreation1hTokens",
            ],
            None,
        );
        if write.is_some() {
            add(write);
        } else if usage["cacheCreation5mTokens"]
            .as_u64()
            .unwrap_or(0)
            .checked_add(usage["cacheCreation1hTokens"].as_u64().unwrap_or(0))
            .is_some_and(|n| n <= usage["cacheCreationTokens"].as_u64().unwrap_or(0))
        {
            for key in ["cacheCreation5mTokens", "cacheCreation1hTokens"] {
                if let Some(count) = usage[key].as_u64().filter(|n| *n > 0) {
                    add(project(&[key], Some(count)));
                }
            }
        }
    }
    (known, false)
}
pub(super) fn reference_price(prices: &[Value], model: &str) -> Value {
    select_price(prices, model).cloned().unwrap_or(Value::Null)
}
pub(super) fn provider_price(_prices: &[Value], _model: &str, snapshot: Value) -> Value {
    // Preserve declared service rates as one card. Never mix rates across sources.
    snapshot
}

pub(super) fn needs_ark_cost_repair(point: &Value) -> bool {
    let rule = &point["priceRule"];
    let legacy_official = rule["providerId"] == "volcengine"
        && rule["modelId"] == "deepseek-v4-1-flash-260910"
        && rule["source"] == "official"
        && rule["cacheWritePolicy"] == "storage";
    let omitted_standard_policy = ["volcengine", "bytedance-seed"]
        .contains(&rule["providerId"].as_str().unwrap_or(""))
        && rule["source"] == "models.dev"
        && rule["referenceOnly"] == true
        && rule["cacheWrite"].as_f64().is_none()
        && rule["cacheWritePolicy"] != "input";
    point["version"] == 1 && (legacy_official || omitted_standard_policy)
}

fn cost_gap_reasons(point: &Value, usage: &Value) -> Vec<&'static str> {
    if point["costComplete"] == true {
        return vec![];
    }
    let mut reasons = vec![];
    if !point["priceRule"].is_object() {
        reasons.push("missing_price");
    }
    if usage["invalidFields"]
        .as_array()
        .is_some_and(|v| !v.is_empty())
    {
        reasons.push("invalid_usage");
    }
    if point["tokenCostComplete"] != true
        && (usage["inputUncachedTokens"].as_u64().is_none()
            || usage["outputTokens"].as_u64().is_none()
            || usage["incompleteFields"]
                .as_array()
                .is_some_and(|v| !v.is_empty()))
    {
        reasons.push("incomplete_usage");
    }
    if point["storageUnpriced"] == true {
        reasons.push("missing_storage_duration");
    }
    if reasons.is_empty() {
        reasons.push("incomplete_pricing");
    }
    reasons
}

pub(super) fn repaired_cost_point(prices: &[Value], record: &Value) -> Value {
    let point = &record["costSnapshot"];
    let mut corrected = if needs_ark_cost_repair(point) {
        // Correct only the documented billing semantics. Keep the original
        // frozen rates, FX and schedule rather than applying today's catalogue.
        let mut rule = point["priceRule"].clone();
        rule["cacheWritePolicy"] = json!("input");
        rule["cacheWritePolicySource"] = json!("official");
        rule["cacheStorageScope"] = json!("explicit");
        let mut corrected = record.clone();
        corrected["referencePrice"] = rule.clone();
        corrected["referencePriceVersion"] = json!(1);
        usage_cost_point(&[rule], &corrected)
    } else if point["version"] == 1
        && point["costComplete"] == false
        && point["priceRule"].is_object()
        && (["optionalDefaults", "derivedFields"].iter().any(|key| {
            record["usage"][key]
                .as_array()
                .is_some_and(|v| !v.is_empty())
        }))
    {
        let mut corrected = record.clone();
        corrected["referencePrice"] = point["priceRule"].clone();
        corrected["referencePriceVersion"] = json!(1);
        usage_cost_point(&[], &corrected)
    } else if point["version"] == 1 {
        point.clone()
    } else {
        usage_cost_point(prices, record)
    };
    corrected["unpricedReasons"] = json!(cost_gap_reasons(&corrected, &record["usage"]));
    corrected["modelId"] = record["request"]["model"].clone();
    corrected
}

pub(super) fn usage_cost_point(prices: &[Value], record: &Value) -> Value {
    // Keep a connection-bound public price snapshot on the original record;
    // later directory refreshes must not reprice that historical request.
    let model = record["request"]["model"].as_str().unwrap_or("");
    let snapshot = &record["providerPrice"];
    let scoped = vec![snapshot.clone()];
    let frozen = vec![record["referencePrice"].clone()];
    let standard = if record["referencePriceVersion"] == 1 {
        &frozen
    } else {
        prices
    };
    let effective = if select_price(standard, model).is_some() {
        standard
    } else if snapshot["source"] == "provider"
        && snapshot["currency"] == "USD"
        && snapshot["unit"] == "per_million_tokens"
        && snapshot["modelId"] == model
    {
        &scoped
    } else {
        standard
    };
    let at = select_price(effective, model)
        .filter(|p| p["billingTime"] == "completedAt")
        .and_then(|_| record["completedAt"].as_str())
        .and_then(|date| chrono::DateTime::parse_from_rfc3339(date).ok())
        .map(|date| date.timestamp_millis() as u128)
        .unwrap_or(record["startedAtMs"].as_u64().unwrap_or(0) as u128);
    let rule = select_price(effective, model);
    let mut token_rule = rule.cloned().unwrap_or_else(|| json!({}));
    let explicit_storage = token_rule["cacheStorageScope"] == "explicit";
    if explicit_storage {
        token_rule
            .as_object_mut()
            .unwrap()
            .remove("cacheStoragePerHour");
    }
    let token_prices = [token_rule];
    let (known, complete) = model_cost_parts(
        if explicit_storage {
            &token_prices
        } else {
            effective
        },
        record["request"]["model"].as_str().unwrap_or(""),
        &record["usage"],
        at,
    );
    let body = record["upstream"]["requestBody"]
        .as_object()
        .map(|_| &record["upstream"]["requestBody"])
        .unwrap_or(&record["request"]["body"]);
    let storage_unpriced = explicit_storage && body["caching"]["type"] == "enabled";
    let token_complete = complete;
    let complete = complete && !storage_unpriced;
    let mut point = json!({"version":1,"atMs":record["startedAtMs"],"billingAtMs":at,"modelId":model,"priceRule":rule,"tokens":record["usage"]["totalTokens"],"costUsd":if complete {known} else {None},"knownCostUsd":known,"costComplete":complete,"tokenCostComplete":token_complete,"storageUnpriced":storage_unpriced});
    point["unpricedReasons"] = json!(cost_gap_reasons(&point, &record["usage"]));
    point
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpriced_reasons_preserve_known_amounts_and_classify_request_gaps() {
        let rule =
            json!({"modelId":"gap-fixture","input":2,"output":10,"cacheRead":0.1,"cacheWrite":2});
        let mut row = json!({"request":{"model":"gap-fixture"},"startedAtMs":1,"usage":{"inputUncachedTokens":100,"inputTotalTokens":100,"outputTokens":5,"cacheReadTokens":0,"cacheCreationTokens":0,"totalTokens":105}});
        let complete = usage_cost_point(std::slice::from_ref(&rule), &row);
        assert_eq!(complete["unpricedReasons"], json!([]));
        row["usage"] = json!({"incompleteFields":["input","output"]});
        let missing = usage_cost_point(std::slice::from_ref(&rule), &row);
        assert_eq!(missing["unpricedReasons"], json!(["incomplete_usage"]));
        assert!(missing["knownCostUsd"].is_null());
        assert_eq!(
            usage_cost_point(&[], &row)["unpricedReasons"],
            json!(["missing_price", "incomplete_usage"])
        );
        row["usage"] = json!({"inputUncachedTokens":100,"inputTotalTokens":100,"cacheReadTokens":0,"cacheCreationTokens":0,"invalidFields":["output"]});
        let invalid = usage_cost_point(std::slice::from_ref(&rule), &row);
        assert_eq!(
            invalid["unpricedReasons"],
            json!(["invalid_usage", "incomplete_usage"])
        );
        assert!((invalid["knownCostUsd"].as_f64().unwrap() - 0.0002).abs() < 1e-12);
        row["costSnapshot"] = invalid.clone();
        let historical = repaired_cost_point(&[], &row);
        assert_eq!(historical["knownCostUsd"], invalid["knownCostUsd"]);
        assert_eq!(historical["modelId"], "gap-fixture");
        assert_eq!(historical["unpricedReasons"], invalid["unpricedReasons"]);
    }

    #[test]
    fn standard_prices_win_and_freeze_without_mixing_service_fields() {
        let old = json!({"modelId":"fixture","input":2,"output":10,"cacheRead":0.1,"cacheWrite":2});
        let fresh =
            json!({"modelId":"fixture","input":99,"output":999,"cacheRead":9,"cacheWrite":99});
        let service = json!({"source":"provider","currency":"USD","unit":"per_million_tokens","modelId":"fixture","input":1,"output":2});
        assert_eq!(
            provider_price(std::slice::from_ref(&old), "fixture", service.clone()),
            service
        );
        let mut row = json!({"request":{"model":"fixture"},"usage":{"version":2,"inputUncachedTokens":100,"inputTotalTokens":100,"outputTokens":5,"cacheReadTokens":0,"cacheCreationTokens":0,"totalTokens":105},"providerPrice":service,"referencePriceVersion":1,"referencePrice":reference_price(&[old],"fixture")});
        let point = usage_cost_point(std::slice::from_ref(&fresh), &row);
        assert!((point["costUsd"].as_f64().unwrap() - 0.00025).abs() < 1e-12);
        assert_eq!(point["priceRule"]["input"], 2);
        row["referencePrice"] = Value::Null;
        let point = usage_cost_point(&[fresh], &row);
        assert!((point["costUsd"].as_f64().unwrap() - 0.00011).abs() < 1e-12);
        assert_eq!(point["priceRule"]["source"], "provider");
    }
    #[test]
    fn ark_token_charges_do_not_require_a_cache_write_counter() {
        let rule = json!({"tokens":["deepseek-v4-1-flash-260910"],"match":"exact","modelId":"deepseek-v4-1-flash-260910","providerId":"volcengine","source":"official","input":2,"output":8,"cacheRead":0.04,"cacheWritePolicy":"input","cacheWritePolicySource":"official","cacheStoragePerHour":0.017,"cacheStorageScope":"explicit"});
        let mut record = json!({"request":{"model":"deepseek-v4-1-flash-260910","body":{}},"startedAtMs":1,"usage":{"inputUncachedTokens":900000,"inputTotalTokens":1000000,"inputIncludesCache":true,"cacheReadTokens":100000,"outputTokens":1000,"incompleteFields":["cacheWrite"]}});
        let point = usage_cost_point(std::slice::from_ref(&rule), &record);
        assert_eq!(point["costComplete"], true);
        assert!((point["knownCostUsd"].as_f64().unwrap() - 1.812).abs() < 1e-12);
        record["request"]["body"]["caching"] = json!({"type":"enabled"});
        let explicit = usage_cost_point(std::slice::from_ref(&rule), &record);
        assert_eq!(explicit["costComplete"], false);
        assert_eq!(explicit["storageUnpriced"], true);
        assert_eq!(
            explicit["unpricedReasons"],
            json!(["missing_storage_duration"])
        );
        assert_eq!(explicit["knownCostUsd"], point["knownCostUsd"]);
        record["costSnapshot"] = point;
        record["costSnapshot"]["priceRule"]["cacheWritePolicy"] = json!("storage");
        record["costSnapshot"]["priceRule"]
            .as_object_mut()
            .unwrap()
            .remove("cacheStorageScope");
        let repaired = repaired_cost_point(
            &[json!({"tokens":["deepseek-v4-1-flash-260910"],"input":999,"output":999})],
            &record,
        );
        assert_eq!(
            repaired["priceRule"]["input"], 2,
            "repair preserves frozen rates"
        );
        assert_eq!(repaired["knownCostUsd"], explicit["knownCostUsd"]);
        assert!(!needs_ark_cost_repair(&repaired));
    }

    #[test]
    fn ark_standard_snapshot_correction_preserves_frozen_rates() {
        let rule = json!({"tokens":["doubao-seed-2-1-pro-260915"],"modelId":"doubao-seed-2-1-pro-260915","providerId":"volcengine","source":"models.dev","referenceOnly":true,"input":0.8906,"output":4.45301,"cacheRead":0.17812});
        let mut record = json!({"request":{"model":"doubao-seed-2-1-pro-260915","body":{}},"startedAtMs":1,"referencePriceVersion":1,"referencePrice":rule,"usage":{"inputUncachedTokens":51,"inputTotalTokens":51,"inputIncludesCache":true,"cacheReadTokens":0,"cacheCreationTokens":null,"outputTokens":99,"reasoningTokens":98,"totalTokens":150,"incompleteFields":["cacheWrite"]}});
        record["costSnapshot"] = usage_cost_point(&[], &record);
        assert_eq!(record["costSnapshot"]["costComplete"], false);
        let original = record.to_string();
        let repaired = repaired_cost_point(
            &[json!({"tokens":["doubao-seed-2-1-pro-260915"],"input":999,"output":999})],
            &record,
        );
        assert_eq!(repaired["costComplete"], true);
        assert!((repaired["costUsd"].as_f64().unwrap() - 0.00048626859).abs() < 1e-12);
        assert_eq!(repaired["priceRule"]["input"], 0.8906);
        assert!(!needs_ark_cost_repair(&repaired));
        assert_eq!(record.to_string(), original);
        record["request"]["body"]["caching"] = json!({"type":"enabled"});
        let explicit = repaired_cost_point(&[], &record);
        assert_eq!(explicit["costComplete"], false);
        assert_eq!(explicit["storageUnpriced"], true);
        assert_eq!(
            explicit["unpricedReasons"],
            json!(["missing_storage_duration"])
        );
    }
    #[test]
    fn peak_pricing_respects_weekends_holidays_and_completion_time() {
        let rule = json!({"tokens":["calendar-fixture"],"modelId":"calendar-fixture","match":"exact","input":2,"output":8,"cacheRead":0.04,"cacheWrite":2,
            "peak":{"peakWindowsUtc":[[1,4],[6,10]],"offPeakMultiplier":0.5,"peakDaysUtc":[1,2,3,4,5],"calendarUtcOffsetHours":8,"offPeakDateRanges":[["2026-10-01","2026-10-07"]]}});
        let usage = json!({"inputUncachedTokens":1000000,"inputTotalTokens":1000000,"inputIncludesCache":true,"cacheReadTokens":0,"cacheCreationTokens":0,"outputTokens":0});
        let at = |date: &str| {
            chrono::DateTime::parse_from_rfc3339(date)
                .unwrap()
                .timestamp_millis() as u128
        };
        for (date, expected) in [
            ("2026-10-13T02:00:00Z", 2.0),
            ("2026-10-11T02:00:00Z", 1.0),
            ("2026-10-05T02:00:00Z", 1.0),
            ("2026-10-13T05:00:00Z", 1.0),
        ] {
            assert_eq!(
                model_cost(
                    std::slice::from_ref(&rule),
                    "calendar-fixture",
                    &usage,
                    at(date)
                ),
                Some(expected)
            );
        }
        let mut completion_rule = rule;
        completion_rule["billingTime"] = json!("completedAt");
        let record = json!({"request":{"model":"calendar-fixture"},"usage":usage,"startedAtMs":at("2026-10-13T03:59:59Z"),"completedAt":"2026-10-13T04:00:01Z"});
        assert_eq!(
            usage_cost_point(&[completion_rule], &record)["costUsd"],
            1.0
        );
    }

    #[test]
    fn persisted_costs_keep_the_same_value_after_restart() {
        for cost in [
            0.000019050000000000002,
            0.000022400000000000002,
            0.0029773500000000006,
            0.0,
        ] {
            let expected = json!({"costUsd": cost, "knownCostUsd": cost});
            let mut stored = expected.clone();
            for _ in 0..3 {
                stored = serde_json::from_str(&stored.to_string()).unwrap();
                assert_eq!(stored, expected);
            }
        }
    }
}
