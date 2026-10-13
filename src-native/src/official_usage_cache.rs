//! Display-only quota metadata. Account identity is always read from the current login.
use super::*;

static ACCESS: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn path(root: &Path) -> PathBuf {
    root.join("official-chatgpt-usage-cache.json")
}
fn load(root: &Path) -> Value {
    let path = path(root);
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return json!({"version":1,"accounts":{}});
    }
    read(&path)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(|v| v["version"] == 1 && v["accounts"].is_object())
        .unwrap_or_else(|| json!({"version":1,"accounts":{}}))
}
pub(super) fn store(root: &Path, account: &Value) {
    let Ok(_guard) = ACCESS.lock() else { return };
    if fs::symlink_metadata(path(root)).is_ok_and(|m| m.file_type().is_symlink()) {
        return;
    }
    let id = text(account, "id");
    let key = text(account, "accountKey");
    if id.is_empty() || key.is_empty() || key == storage::digest(b"\0\0") {
        return;
    }
    let mut cache = load(root);
    // Store only parsed display fields, never credentials, names, emails or redemption IDs.
    let details = &account["quotaDetails"];
    if cache["accounts"][id]["accountKey"] == account["accountKey"]
        && cache["accounts"][id]["quotaDetails"]["checkedAt"]
            .as_u64()
            .unwrap_or(0)
            > details["checkedAt"].as_u64().unwrap_or(0)
    {
        return;
    }
    let mut safe = json!({});
    for field in [
        "source",
        "checkedAt",
        "httpStatus",
        "planType",
        "windows",
        "availableResetCredits",
    ] {
        if let Some(value) = details.get(field) {
            safe[field] = value.clone();
        }
    }
    cache["accounts"][id] = json!({"accountKey":key,"quotaDetails":safe});
    let _ = write(&path(root), &cache.to_string());
}
pub(super) fn forget(root: &Path, id: &str) {
    let Ok(_guard) = ACCESS.lock() else { return };
    let mut cache = load(root);
    if cache["accounts"]
        .as_object_mut()
        .and_then(|rows| rows.remove(id))
        .is_some()
    {
        let _ = write(&path(root), &cache.to_string());
    }
}
pub(super) fn apply(root: &Path, account: &mut Value) {
    if account["status"] != "connected" {
        return;
    }
    let Ok(_guard) = ACCESS.lock() else { return };
    let cache = load(root);
    let stored = &cache["accounts"][text(account, "id")];
    if text(account, "accountKey").is_empty() || stored["accountKey"] != account["accountKey"] {
        return;
    }
    let mut details = stored["quotaDetails"].clone();
    let now = (millis() / 1000) as u64;
    let checked = details["checkedAt"].as_u64().unwrap_or(0);
    if checked == 0 || checked > now {
        return;
    }
    let Some(windows) = details["windows"].as_array_mut() else {
        return;
    };
    windows.retain(|w| {
        w["remainingPercent"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && (0.0..=100.0).contains(&n))
            && w["resetsAt"]
                .as_u64()
                .map_or(now.saturating_sub(checked) < 300, |reset| reset > now)
    });
    if windows.is_empty() {
        return;
    }
    account["quotaDetails"] = details;
    account["quotaCached"] = json!(true);
    // Deliberately do not restore routing aggregates. Policy refresh/leases use live data.
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("xwx-quota-cache-{name}-{}", millis()));
        fs::create_dir_all(&root).unwrap();
        root
    }
    fn account(key: &str, checked: u64, windows: Value) -> Value {
        json!({"id":"official-chatgpt","status":"connected","accountKey":key,
            "email":"private@example.test","tokens":{"access_token":"private-token"},
            "quota":{"remainingPercent":70},"quotaDetails":{"checkedAt":checked,"httpStatus":200,
            "windows":windows,"resetCredits":[{"id":"private-redemption"}]}})
    }
    fn hydrate(root: &Path, key: &str) -> Value {
        let mut value = json!({"id":"official-chatgpt","status":"connected","accountKey":key});
        apply(root, &mut value);
        value
    }
    #[test]
    fn expired_windows_are_removed_without_inventing_a_new_allowance() {
        let root = root("expiry");
        let now = (millis() / 1000) as u64;
        store(
            &root,
            &account(
                "first",
                now - 600,
                json!([
                    {"remainingPercent":70,"resetsAt":now-1,"windowSeconds":18000},
                    {"remainingPercent":40,"resetsAt":now+600,"windowSeconds":604800},
                    {"remainingPercent":80}, {"remainingPercent":null,"resetsAt":now+600}
                ]),
            ),
        );
        let result = hydrate(&root, "first");
        assert_eq!(
            result["quotaDetails"]["windows"].as_array().unwrap().len(),
            1
        );
        assert_eq!(
            result["quotaDetails"]["windows"][0]["windowSeconds"],
            604800
        );
        assert_eq!(result["quotaCached"], true);
        assert!(
            result.get("quota").is_none(),
            "display cache must not seed routing"
        );
        let disk = fs::read_to_string(path(&root)).unwrap();
        assert!(!disk.contains("private-"));
        assert!(!disk.contains("private@example.test"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn identities_and_authoritative_empty_windows_replace_old_cache() {
        let root = root("identity");
        let now = (millis() / 1000) as u64;
        store(
            &root,
            &account(
                "first",
                now,
                json!([{"remainingPercent":70,"resetsAt":now+600}]),
            ),
        );
        assert!(hydrate(&root, "second").get("quotaDetails").is_none());
        let mut signed_out =
            json!({"id":"official-chatgpt","status":"signed-out","accountKey":"first"});
        apply(&root, &mut signed_out);
        assert!(signed_out.get("quotaDetails").is_none());
        store(
            &root,
            &account(
                "second",
                now - 1,
                json!([{"remainingPercent":40,"resetsAt":now+600}]),
            ),
        );
        assert_eq!(
            hydrate(&root, "second")["quotaDetails"]["windows"][0]["remainingPercent"],
            40
        );
        store(&root, &account("second", now, json!([])));
        store(
            &root,
            &account("second", now - 1, json!([{"remainingPercent":90}])),
        );
        assert!(hydrate(&root, "second").get("quotaDetails").is_none());
        forget(&root, "official-chatgpt");
        assert!(load(&root)["accounts"].as_object().unwrap().is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
