//! Public directory prices, normalized to USD per million tokens.
use super::*;

pub(super) fn parse(row: &Value, model: &str) -> Option<Value> {
    let (raw, scale) = if row["magpie_price"].is_object() {
        (&row["magpie_price"], 1.0)
    } else {
        let raw = &row["pricing"];
        if raw["currency"] != "USD" {
            return None;
        }
        let scale = match text(raw, "unit") {
            "per_million_tokens" => 1.0,
            "per_token" => 1_000_000.0,
            _ => return None,
        };
        (raw, scale)
    };
    let mut price = json!({"match":"exact","tokens":[model],"modelId":model,"source":"provider","currency":"USD","unit":"per_million_tokens"});
    let fields = [
        ("input", "input"),
        ("output", "output"),
        ("cache_read", "cacheRead"),
        ("cache_write", "cacheWrite"),
        ("cache_write_1h", "cacheWrite1h"),
        ("reasoning", "reasoning"),
    ];
    let mut count = 0;
    for (key, target) in fields {
        if let Some(value) = raw.get(key) {
            let n = value.as_f64()? * scale;
            if !n.is_finite() || !(0.0..=1_000_000.0).contains(&n) {
                return None;
            }
            price[target] = json!(n);
            count += 1;
        }
    }
    if count == 0 {
        return None;
    }
    if let Some(tiers) = raw.get("tiers") {
        let mut out = vec![];
        for tier in tiers.as_array()? {
            let above = tier["above"].as_u64().or_else(|| {
                (tier["tier"]["type"] == "context")
                    .then(|| tier["tier"]["size"].as_u64())
                    .flatten()
            })?;
            if above == 0 || above >= 9_007_199_254_740_991 {
                return None;
            }
            let mut mapped = json!({"fromInputTokens":above + 1});
            for (key, target) in fields {
                if let Some(value) = tier.get(key) {
                    let n = value.as_f64()? * scale;
                    if !n.is_finite() || !(0.0..=1_000_000.0).contains(&n) {
                        return None;
                    }
                    mapped[target] = json!(n);
                }
            }
            out.push(mapped);
        }
        out.sort_by_key(|t| t["fromInputTokens"].as_u64());
        if out
            .windows(2)
            .any(|t| t[0]["fromInputTokens"] == t[1]["fromInputTokens"])
        {
            return None;
        }
        price["tiers"] = json!(out);
    }
    Some(price)
}

pub(super) fn snapshot(root: &Path, p: &Provider, model: &str) -> Option<Value> {
    let cache = root.join(format!(
        "provider-{}-models.json",
        &storage::digest(p.id.as_bytes())[..24]
    ));
    let value: Value = serde_json::from_str(&read(&cache).ok()??).ok()?;
    if value["connectionId"] != catalog::identity(p) || value["adapter"] != p.adapter {
        return None;
    }
    value["entries"]
        .as_array()?
        .iter()
        .find(|r| r["id"] == model)?
        .get("providerPrice")
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn units_zero_tiers_and_invalid_prices() {
        let p = parse(&json!({"magpie_price":{"input":0,"output":2,"cache_read":0,"tiers":[{"above":100,"output":4}]}}), "m").unwrap();
        assert_eq!(p["input"], 0.0);
        assert_eq!(p["tiers"][0]["fromInputTokens"], 101);
        assert_eq!(
            parse(
                &json!({"pricing":{"currency":"USD","unit":"per_token","input":0.000002}}),
                "m"
            )
            .unwrap()["input"],
            2.0
        );
        for row in [
            json!({"pricing":{"input":1,"output":2}}),
            json!({"pricing":{"currency":"CNY","unit":"per_million_tokens","input":1}}),
            json!({"magpie_price":{"input":-1}}),
            json!({"magpie_price":{"input":1,"tiers":[{"above":0}]}}),
        ] {
            assert!(parse(&row, "m").is_none());
        }
    }
}
