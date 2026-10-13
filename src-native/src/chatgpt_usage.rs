//! Whitelisted WHAM evidence. Missing/invalid percentages never become zero.
use super::*;

pub(super) fn parse(data: &Value) -> (Value, Option<(f64, u64)>) {
    let mut windows = vec![];
    let mut ordinary = vec![];
    let mut incomplete = false;
    let mut add = |limit: &Value, id: &str, model: Option<&str>, ordinary_limit: bool| {
        for key in ["primary_window", "secondary_window"] {
            let window = &limit[key];
            if !window.is_object() {
                continue;
            }
            let used = window["used_percent"]
                .as_f64()
                .filter(|n| n.is_finite() && (0. ..=100.).contains(n));
            let reset = window["reset_at"].as_u64();
            windows.push(json!({"limitId":id,"normalModelSlug":model,"window":key,"usedPercent":used,
                "remainingPercent":used.map(|n|100.-n),"resetsAt":reset,
                "windowSeconds":window["limit_window_seconds"].as_u64(),
                "allowed":limit["allowed"].as_bool(),"limitReached":limit["limit_reached"].as_bool()}));
            if ordinary_limit {
                if let (Some(used), Some(reset)) = (used, reset) {
                    ordinary.push((100. - used, reset));
                } else {
                    incomplete = true;
                }
            }
        }
    };
    add(&data["rate_limit"], "codex", None, true);
    for limit in data["additional_rate_limits"]
        .as_array()
        .into_iter()
        .flatten()
    {
        add(
            &limit["rate_limit"],
            text(limit, "limit_name"),
            limit["normal_model_slug"].as_str(),
            false,
        );
    }
    let aggregate = if incomplete {
        None
    } else {
        ordinary.into_iter().min_by(|a, b| a.0.total_cmp(&b.0))
    };
    (
        json!({"source":"chatgpt-wham","httpStatus":200,"planType":data["plan_type"].as_str(),
            "ordinaryUsageAllowed":data["rate_limit"]["allowed"].as_bool(),
            "availableResetCredits":data["rate_limit_reset_credits"]["available_count"].as_u64(),"windows":windows}),
        aggregate,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retains_windows_without_applying_model_specific_limits_to_the_account() {
        let (details, aggregate) = parse(&json!({"plan_type":"plus","rate_limit":{
            "primary_window":{"used_percent":20,"reset_at":200,"limit_window_seconds":18000},
            "secondary_window":{"used_percent":60,"reset_at":900,"limit_window_seconds":604800}},
            "additional_rate_limits":[{"limit_name":"specific-model","rate_limit":{
                "primary_window":{"used_percent":100,"reset_at":300,"limit_window_seconds":3600}}}],
            "secret":"never copy raw response"}));
        assert_eq!(aggregate, Some((40., 900)));
        assert_eq!(details["windows"].as_array().unwrap().len(), 3);
        assert_eq!(details["windows"][0]["windowSeconds"], 18000);
        assert!(details.get("secret").is_none());
    }
    #[test]
    fn incomplete_or_invalid_windows_remain_unknown() {
        for bad in [Value::Null, json!(-1), json!(101), json!("80")] {
            let (details, aggregate) = parse(&json!({"rate_limit":{
                "primary_window":{"used_percent":bad,"reset_at":100},
                "secondary_window":{"used_percent":60,"reset_at":900}}}));
            assert_eq!(aggregate, None);
            assert_eq!(details["windows"][0]["remainingPercent"], Value::Null);
        }
        assert_eq!(parse(&json!({})).1, None);
    }

    #[test]
    fn plans_do_not_determine_which_windows_exist() {
        for plan in ["plus", "pro", "future-plan"] {
            for short in [
                Value::Null,
                json!({"used_percent":20,"reset_at":200,"limit_window_seconds":18000}),
            ] {
                let (details, aggregate) = parse(&json!({"plan_type":plan,"rate_limit":{
                    "primary_window":short,"secondary_window":{
                        "used_percent":40,"reset_at":900,"limit_window_seconds":604800}}}));
                assert_eq!(details["planType"], plan);
                assert_eq!(
                    details["windows"].as_array().unwrap().len(),
                    if short.is_null() { 1 } else { 2 }
                );
                assert_eq!(aggregate, Some((60., 900)));
            }
        }
    }
}
