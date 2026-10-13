//! Definite retirement evidence is scoped to one connection, never a global ID.
use super::*;
const TTL: u64 = 7 * 24 * 60 * 60 * 1000;
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn path(root: &Path) -> PathBuf {
    root.join("retired-models.json")
}
fn load(root: &Path) -> Result<Value> {
    read(&path(root))?
        .map(|s| serde_json::from_str(&s).map_err(|_| "模型下线记录损坏，原文件已保留".into()))
        .unwrap_or_else(|| Ok(json!({"version":1,"entries":{}})))
}
fn key(provider: &str, identity: &str, model: &str) -> String {
    storage::digest(format!("{provider}\0{identity}\0{model}").as_bytes())
}
pub(super) fn definite(status: u16, value: &Value) -> bool {
    if ![400, 404, 410, 422].contains(&status) {
        return false;
    }
    let error = if value["error"].is_object() {
        &value["error"]
    } else {
        &value["response"]["error"]
    };
    let message = text(error, "message").to_ascii_lowercase();
    let code = text(error, "code").to_ascii_lowercase();
    let kind = text(error, "type").to_ascii_lowercase();
    let evidence = format!("{code} {kind} {message}");
    if [
        "quota",
        "balance",
        "credit",
        "billing",
        "rate_limit",
        "rate limit",
        "insufficient",
        "usage limit",
        "budget",
        "额度",
        "余额",
        "欠费",
        "限流",
    ]
    .iter()
    .any(|s| evidence.contains(s))
    {
        return false;
    }
    if [&code, &kind].iter().any(|c| {
        [
            "modeldeprecated",
            "model_deprecated",
            "model_retired",
            "model_discontinued",
            "model_decommissioned",
            "model_sunset",
        ]
        .contains(&c.as_str())
    }) {
        return true;
    }
    static WORDS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    WORDS.get_or_init(|| regex::Regex::new(r"(?i)\bmodel\b.{0,80}\b(?:has been|was|is now|is) (?:deprecated|retired|discontinued|decommissioned|sunset)\b").unwrap()).is_match(&message)
}
pub(super) fn successful(wire: &str, value: &Value) -> bool {
    if super::protocol::validate_response(value, wire).is_err() {
        return false;
    }
    match wire {
        "chat-completions" => ["stop", "length", "tool_calls", "function_call"]
            .contains(&text(&value["choices"][0], "finish_reason")),
        "anthropic-messages" => ["end_turn", "max_tokens", "tool_use", "stop_sequence"]
            .contains(&text(value, "stop_reason")),
        _ => {
            value["status"] == "completed"
                && value["output"].as_array().is_some_and(|a| !a.is_empty())
        }
    }
}
pub(super) fn observe(
    root: &Path,
    provider: &str,
    identity: &str,
    model: &str,
    status: u16,
    value: &Value,
    success: bool,
) -> Result<()> {
    if provider.is_empty()
        || identity.is_empty()
        || model.is_empty()
        || (!success && !definite(status, value))
    {
        return Ok(());
    }
    let _guard = LOCK.lock().unwrap();
    let mut state = load(root)?;
    let entries = state["entries"]
        .as_object_mut()
        .ok_or("模型下线记录格式无效，原文件已保留")?;
    entries.retain(|_, row| {
        row["expiresAt"]
            .as_u64()
            .is_some_and(|at| at > millis() as u64)
    });
    let key = key(provider, identity, model);
    let changed = if success {
        entries.remove(&key).is_some()
    } else {
        entries.insert(key, json!({"expiresAt":millis() as u64 + TTL}));
        true
    };
    if changed {
        write(&path(root), &state.to_string())?;
    }
    Ok(())
}
pub(super) fn overlay(root: &Path, p: &Provider, mut rows: Value) -> Result<Value> {
    let _guard = LOCK.lock().unwrap();
    let state = load(root)?;
    if state["version"] != 1 || !state["entries"].is_object() {
        return Err("模型下线记录格式无效，原文件已保留".into());
    }
    for row in rows.as_array_mut().into_iter().flatten() {
        let key = key(&p.id, &catalog::identity(p), text(row, "id"));
        if state["entries"][key]["expiresAt"]
            .as_u64()
            .is_some_and(|at| at > millis() as u64)
        {
            row["runtimeRetired"] = json!(true);
        } else if let Some(row) = row.as_object_mut() {
            row.remove("runtimeRetired");
        }
    }
    Ok(rows)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retirement_requires_definite_model_evidence() {
        assert!(definite(404, &json!({"error":{"code":"ModelDeprecated"}})));
        assert!(definite(
            410,
            &json!({"error":{"message":"The model is retired."}})
        ));
        for (status, error) in [
            (401, json!({"code":"ModelDeprecated"})),
            (503, json!({"code":"ModelDeprecated"})),
            (404, json!({"message":"Model not exist."})),
            (
                400,
                json!({"code":"ModelDeprecated","message":"Insufficient quota"}),
            ),
            (
                404,
                json!({"message":"Endpoint closed or temporarily unavailable"}),
            ),
        ] {
            assert!(!definite(status, &json!({"error":error})));
        }
    }
}
