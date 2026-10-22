use super::*;
pub(super) struct State;
impl State {
    pub(super) fn new(_root: &Path, _isolated: bool) -> Self {
        Self
    }
    pub(super) fn reset_keep(&self, _root: &Path) -> Result<Vec<PathBuf>> {
        Ok(vec![])
    }
}
pub(super) async fn call(_pilot: &mut Pilot, method: &str, _args: &[Value]) -> Result<Value> {
    Err(format!("当前原生版本不支持操作 {method}"))
}
pub(super) fn migrate(_root: &Path, value: &mut Value) -> Result<()> {
    if let Some(connections) = value["connections"].as_array_mut() {
        for p in connections {
            if p["codexProviderId"].as_str().is_none_or(str::is_empty) {
                p["codexProviderId"] = p["id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .map(|id| json!(id))
                    .unwrap_or(json!("xwx_deck"));
            }
        }
    }
    Ok(())
}
pub(super) fn fresh_settings() -> Settings {
    Settings::default()
}
pub(super) fn automatic_adapter(_adapter: &str) -> bool {
    false
}
pub(super) fn adapter_supported(_adapter: &str) -> bool {
    false
}
pub(super) fn default_protocol(_adapter: &str) -> &str {
    "responses"
}
pub(super) fn endpoint(_p: &Provider, _wire: &str) -> Option<String> {
    None
}
pub(super) fn claude_base(_p: &Provider) -> Option<String> {
    None
}
pub(super) fn validation_wire(_root: &Path, _p: &Provider, _model: &str) -> Option<String> {
    None
}
pub(super) fn cached_catalog(_root: &Path, _p: &Provider) -> Result<Option<Value>> {
    Ok(None)
}
pub(super) fn catalog_endpoints(
    _p: &Provider,
) -> Option<Vec<(&'static str, String, &'static str)>> {
    None
}
pub(super) fn catalog_clients(_kind: &str) -> Value {
    json!(["codex", "claude"])
}
pub(super) fn optional_catalog_error(_p: &Provider, _error: &str) -> bool {
    false
}
pub(super) fn catalog_wire(
    _p: &Provider,
    _e: &Value,
    _incoming: &str,
    _default: &str,
) -> Option<String> {
    None
}
pub(super) fn model_cache_paths(_root: &Path) -> Vec<PathBuf> {
    vec![]
}

pub(super) fn legacy_direct_base(definition: &Value) -> Option<String> {
    let _ = definition;
    None
}

pub(super) fn codex_snapshot(value: Value) -> Value {
    value
}
pub(super) fn defer_storage_migration(_root: &std::path::Path) -> std::result::Result<bool, String> { Ok(false) }
pub(super) fn legacy_bulk_trace_root(_root: &std::path::Path) -> Option<std::path::PathBuf> { None }
