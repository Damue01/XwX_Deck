use super::*;
fn feed() -> Result<String> {
    let feed = std::env::var("XWX_DECK_UPDATE_SERVER_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "https://github.com/Damue01/XwX_Deck/releases/latest/download".into());
    validate_url(&feed)?;
    Ok(feed.trim_end_matches('/').into())
}
pub(super) async fn manifest(_root: &Path) -> Result<Value> {
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(err)?
        .get(format!("{}/release.json", feed()?))
        .send()
        .await
        .map_err(|_| "更新信息请求失败".to_string())?
        .error_for_status()
        .map_err(|e| {
            format!(
                "更新信息 HTTP {}",
                e.status().map(|s| s.as_u16()).unwrap_or(0)
            )
        })?;
    validate_url(response.url().as_str())?;
    let bytes = response.bytes().await.map_err(err)?;
    if bytes.len() > 1024 * 1024 {
        return Err("更新信息过大".into());
    }
    let manifest: Value =
        serde_json::from_slice(&bytes).map_err(|_| "更新信息格式错误".to_string())?;
    if manifest["schemaVersion"] != 1
        || manifest["channel"] != "release"
        || version(text(&manifest, "version")).is_none()
        || manifest["tag"] != format!("v{}", text(&manifest, "version"))
    {
        return Err("更新清单版本或频道不一致".into());
    }
    Ok(manifest)
}
pub(super) fn release_supported(manifest: &Value) -> bool {
    manifest["releaseSeries"] == "native-v1"
}
