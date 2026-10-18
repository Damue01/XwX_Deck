#[path = "settings.rs"]
mod settings;
pub use settings::Provider;
use settings::Settings;
#[path = "application_repair.rs"]
mod application_repair;
#[path = "application_reset.rs"]
mod application_reset;
#[path = "catalog.rs"]
mod catalog;
#[path = "chatgpt_usage.rs"]
mod chatgpt_usage;
#[path = "claude_accounts.rs"]
mod claude_accounts;
#[path = "claude_directory.rs"]
mod claude_directory;
#[path = "client_installations.rs"]
mod client_installations;
#[path = "client_repair.rs"]
mod client_repair;
#[path = "client_wiring.rs"]
mod client_wiring;
#[path = "clients.rs"]
mod clients;
#[path = "config_import.rs"]
mod config_import;
#[path = "configuration_removal.rs"]
mod configuration_removal;
#[path = "imported_subscriptions.rs"]
mod imported_subscriptions;
#[path = "official_usage_cache.rs"]
mod official_usage_cache;
#[path = "official_responses.rs"]
mod official_responses;
pub(crate) fn is_imported_subscription(id: &str) -> bool {
    imported_subscriptions::is_imported(id)
}
#[path = "continuation.rs"]
mod continuation;
#[path = "conversation_identity.rs"]
mod conversation_identity;
#[path = "copilot_accounts.rs"]
mod copilot_accounts;
#[path = "credentials.rs"]
mod credentials;
#[path = "cursor_accounts.rs"]
mod cursor_accounts;
#[path = "cursor_protocol.rs"]
mod cursor_protocol;
#[path = "desktop.rs"]
mod desktop;
#[path = "directory_settings.rs"]
mod directory_settings;
#[path = "gateway_forwarding.rs"]
mod gateway_forwarding;
#[path = "gateway_transport.rs"]
mod gateway_transport;
#[path = "grok_accounts.rs"]
mod grok_accounts;
#[path = "history.rs"]
mod history;
#[path = "ingress.rs"]
mod ingress;
#[path = "legacy_codex.rs"]
mod legacy_codex;
#[path = "legacy_helper.rs"]
mod legacy_helper;
#[path = "legacy_recovery.rs"]
mod legacy_recovery;
#[path = "live.rs"]
mod live;
#[path = "metadata.rs"]
mod metadata;
#[path = "model_metadata.rs"]
mod model_metadata;
#[path = "native_auth.rs"]
pub(crate) mod native_auth;
#[path = "official_accounts.rs"]
mod official_accounts;
#[path = "official_chatgpt.rs"]
mod official_chatgpt;
#[path = "protocol.rs"]
mod protocol;
#[path = "provider_pricing.rs"]
mod provider_pricing;
#[path = "reasoning.rs"]
mod reasoning;
#[path = "request_activity.rs"]
mod request_activity;
#[path = "request_encoding.rs"]
mod request_encoding;
#[path = "retired_models.rs"]
mod retired_models;
#[path = "service_switching.rs"]
mod service_switching;
#[path = "routing_errors.rs"]
mod routing_errors;
#[path = "storage.rs"]
mod storage;
#[path = "subscription_routing.rs"]
mod subscription_routing;
#[path = "subscriptions.rs"]
mod subscriptions;
#[path = "tool_wait.rs"]
mod tool_wait;
#[path = "trace_compaction.rs"]
mod trace_compaction;
#[path = "trace_usage.rs"]
mod trace_usage;
#[path = "trace_writer.rs"]
mod trace_writer;
#[path = "updates.rs"]
mod updates;
#[path = "upstream_diagnostics.rs"]
mod upstream_diagnostics;
#[path = "websocket.rs"]
mod websocket;
use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::StatusCode,
    response::Response,
    routing::any,
    Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{oneshot, Mutex};
use toml_edit::{value, DocumentMut, Item};

pub type Result<T> = std::result::Result<T, String>;
#[cfg(target_os = "macos")]
pub fn webcrypto_private_key(
    root: &Path,
    isolated: bool,
    interactive: bool,
) -> Result<zeroize::Zeroizing<Vec<u8>>> {
    credentials::webcrypto_private_key(root, isolated, interactive)
}
pub fn credential_store_diagnostic(mode: &str, id: &str, challenge: &str) -> Result<Value> {
    credentials::platform_diagnostic(mode, id, challenge)
}
pub fn export_credential_backup(
    root: &Path,
    destination: &Path,
    original: bool,
    isolated: bool,
) -> Result<Value> {
    credentials::export_backup(root, destination, original, isolated)
}
#[cfg(target_os = "macos")]
pub fn finish_manual_update(open: impl FnOnce() -> Result<()>, exit: impl FnOnce()) -> Result<()> {
    open()?;
    exit();
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod manual_update_tests {
    use super::*;
    #[test]
    fn opening_failure_keeps_the_manager_running() {
        let exited = std::cell::Cell::new(false);
        assert!(finish_manual_update(|| Err("opener failed".into()), || exited.set(true)).is_err());
        assert!(!exited.get());
    }
    #[test]
    fn successful_open_precedes_exit() {
        let opened = std::cell::Cell::new(false);
        let exited = std::cell::Cell::new(false);
        finish_manual_update(
            || {
                opened.set(true);
                Ok(())
            },
            || {
                assert!(opened.get());
                exited.set(true);
            },
        )
        .unwrap();
        assert!(exited.get());
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
// Keep the native readout aligned with the dashboard and retained renderer backend.
fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    let digits = usize::from(unit > 0 && value < 10.0);
    // JavaScript toFixed rounds positive halfway cases up; Rust formatting uses ties-to-even.
    let factor = if digits == 1 { 10.0 } else { 1.0 };
    let rounded = (value * factor).round() / factor;
    format!("{rounded:.digits$} {}", UNITS[unit])
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn same_physical_path(path: &Path) -> Result<bool> {
    let canonical = fs::canonicalize(path).map_err(err)?;
    #[cfg(target_os = "windows")]
    {
        let canonical = canonical.to_string_lossy().replace('/', "\\");
        let expected = path.to_string_lossy().replace('/', "\\");
        Ok(canonical
            .trim_start_matches(r"\\?\")
            .eq_ignore_ascii_case(expected.trim_start_matches(r"\\?\")))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(canonical == path)
    }
}
fn millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

struct ManagedClientRoutes {
    before: String,
    managed: String,
    claude: Option<(String, String)>,
    codex_managed: bool,
    codex_official: bool,
    claude_path: PathBuf,
}
struct Gateway {
    activity: Arc<request_activity::Activity>,
    routes: Arc<std::sync::RwLock<Route>>,
    port: u16,
    shutdown: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
    before: String,
    managed: String,
    claude: Option<(String, String)>,
    claude_path: PathBuf,
    codex_managed: bool,
    codex_official: bool,
    cancel: tokio::sync::watch::Sender<bool>,
}
#[derive(Clone)]
struct Route {
    forwarding: gateway_forwarding::Bindings,
    transport: reqwest::Client,
    local_port: u16,
    switching: service_switching::Routing,
    model_override: Option<String>,
    activity: Arc<request_activity::Activity>,
    subscriptions: subscriptions::Accounts,
    provider: Option<Provider>,
    third_party_tokens: Vec<String>,
    clients: std::collections::BTreeMap<String, Provider>,
    claude: Option<Provider>,
    client: reqwest::Client,
    diagnostics: upstream_diagnostics::Log,
    count: Arc<AtomicU64>,
    store: storage::Store,
    root: PathBuf,
    cancel: tokio::sync::watch::Receiver<bool>,
    codex_home: PathBuf,
}
struct Dashboard {
    port: u16,
    task: tokio::task::JoinHandle<()>,
    stopped: tokio::sync::watch::Sender<bool>,
}
impl Drop for Dashboard {
    fn drop(&mut self) {
        let _ = self.stopped.send(true);
        self.task.abort();
    }
}
pub struct Pilot {
    reset_pending: bool,
    catalog_generation: u64,
    catalog_repair_generation: u64,
    state_revision: std::sync::Mutex<(u64, Value)>,
    pub root: PathBuf,
    subscriptions: subscriptions::Accounts,
    isolated: bool,
    settings: Settings,
    gateway: Option<Gateway>,
    count: Arc<AtomicU64>,
    lock: fs::File,
    store: storage::Store,
    dashboard: Option<Dashboard>,
    settings_source: std::sync::Mutex<Option<String>>,
    settings_problem: Option<String>,
    recovery_problem: Option<String>,
    renderer_preferences_problem: Option<String>,
    updates: updates::Updates,
    metadata: metadata::Metadata,
}
pub type Shared = Arc<Mutex<Pilot>>;
pub(crate) fn admit_rpc(method: &str) -> Result<application_reset::RpcGuard> {
    application_reset::admit_rpc(method)
}
pub(crate) fn reset_worker(path: &Path) -> Result<()> {
    application_reset::worker(path)
}
pub(crate) fn pending_reset(root: &Path) -> Result<Option<PathBuf>> {
    application_reset::pending_job(root)
}
pub(crate) fn resume_reset(path: &Path) -> Result<()> {
    application_reset::resume(path)
}

fn read(path: &Path) -> Result<Option<String>> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err("隔离目录内不允许符号链接".into()),
        Ok(_) => fs::read_to_string(path)
            .map_err(err)
            .and_then(|source| credentials::decode(path, source))
            .map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}
#[path = "file_write.rs"]
mod file_write;
use file_write::{write, write_checked};
// Compare semantic values rather than TOML decoration so another editor may
// safely change comments and fields outside the ownership set.
fn semantic(item: Option<&Item>) -> Option<Value> {
    fn val(value: &toml_edit::Value) -> Value {
        match value {
            toml_edit::Value::String(v) => json!(v.value()),
            toml_edit::Value::Integer(v) => json!(v.value()),
            toml_edit::Value::Float(v) => json!(v.value()),
            toml_edit::Value::Boolean(v) => json!(v.value()),
            toml_edit::Value::Datetime(v) => json!({"datetime":v.value().to_string()}),
            toml_edit::Value::Array(values) => json!(values.iter().map(val).collect::<Vec<_>>()),
            toml_edit::Value::InlineTable(table) => {
                Value::Object(table.iter().map(|(key, v)| (key.into(), val(v))).collect())
            }
        }
    }
    let item = item?;
    if item.is_none() {
        return None;
    }
    if let Some(value) = item.as_value() {
        Some(val(value))
    } else {
        item.as_table_like().map(|table| {
            Value::Object(
                table
                    .iter()
                    .filter_map(|(key, value)| semantic(Some(value)).map(|v| (key.into(), v)))
                    .collect(),
            )
        })
    }
}
fn restored_value(previous: &Item, current: Option<&Item>) -> Item {
    let mut value = previous.clone();
    if let (Some(value), Some(current)) = (value.as_value_mut(), current.and_then(Item::as_value)) {
        *value.decor_mut() = current.decor().clone();
    }
    value
}
fn provider_field<'a>(doc: &'a DocumentMut, id: &str, key: &str) -> Option<&'a Item> {
    doc.get("model_providers")
        .and_then(|providers| providers.get(id))
        .and_then(|table| table.get(key))
}
fn set_codex_field(doc: &mut DocumentMut, key: &str, next: Item) {
    let restored = restored_value(&next, doc.get(key));
    doc[key] = restored;
}
fn set_codex_provider_field(doc: &mut DocumentMut, id: &str, key: &str, next: Item) {
    let restored = restored_value(&next, provider_field(doc, id, key));
    doc["model_providers"][id][key] = restored;
}
fn local_codex_endpoint(base: &str) -> bool {
    reqwest::Url::parse(base).is_ok_and(|url| {
        matches!(
            url.host_str(),
            Some("127.0.0.1" | "localhost" | "::1" | "[::1]")
        )
    })
}
fn codex_resume_endpoint(config: &DocumentMut) -> Option<reqwest::Url> {
    provider_field(config, "xwx_deck", "base_url")
        .and_then(Item::as_str)
        .filter(|base| local_codex_endpoint(base))
        .and_then(|base| reqwest::Url::parse(base).ok())
        .filter(|url| matches!(url.path().trim_matches('/'), "v1" | "backend-api/codex"))
}
fn codex_resume_origins(
    config: &DocumentMut,
    ledger: Option<&Value>,
    target_base: Option<&str>,
) -> Result<Vec<String>> {
    let mut origins = Vec::new();
    if let Some(url) = codex_resume_endpoint(config) {
        origins.push(url.origin().ascii_serialization());
    }
    if let Some(ledger) = ledger {
        if let Some(url) = codex_resume_endpoint(&doc(text(ledger, "before"))?) {
            origins.push(url.origin().ascii_serialization());
        }
        for origin in ledger["adoptedResumeOrigins"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let Some(url) = origin
                .as_str()
                .filter(|s| local_codex_endpoint(s))
                .and_then(|s| reqwest::Url::parse(s).ok())
                .filter(|url| {
                    url.path() == "/" && url.query().is_none() && url.fragment().is_none()
                })
            {
                origins.push(url.origin().ascii_serialization());
            }
        }
    }
    // The explicitly selected local API is a live upstream, not an old manager.
    if let Some(target) = target_base.and_then(|base| reqwest::Url::parse(base).ok()) {
        let origin = target.origin().ascii_serialization();
        origins.retain(|candidate| candidate != &origin);
    }
    origins.sort();
    origins.dedup();
    Ok(origins)
}
fn codex_root_override(config: &DocumentMut, key: &str, origins: &[String]) -> bool {
    config
        .get(key)
        .and_then(Item::as_str)
        .and_then(|base| reqwest::Url::parse(base).ok())
        .is_some_and(|url| {
            origins.contains(&url.origin().ascii_serialization())
                && matches!(url.path().trim_matches('/'), "" | "v1")
        })
}
fn stale_codex_root_override(config: &DocumentMut, origins: &[String]) -> bool {
    let current_origin = provider_field(config, "xwx_deck", "base_url")
        .and_then(Item::as_str)
        .and_then(|base| reqwest::Url::parse(base).ok())
        .map(|url| url.origin().ascii_serialization());
    let old_origins: Vec<_> = origins
        .iter()
        .filter(|origin| Some(origin.as_str()) != current_origin.as_deref())
        .cloned()
        .collect();
    ["openai_base_url", "chatgpt_base_url"]
        .iter()
        .any(|key| codex_root_override(config, key, &old_origins))
}
const GATEWAY_PORT: u16 = 45233;
fn gateway_listen_port(isolated: bool) -> u16 {
    if isolated {
        0
    } else {
        GATEWAY_PORT
    }
}
async fn bind_gateway_listener(port: u16) -> Result<tokio::net::TcpListener> {
    tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|error| {
            format!("Gateway 端口 {port} 无法监听，请完全退出旧版或检查端口占用后重试：{error}")
        })
}
const CODEX_PROVIDER_FIELDS: &[&str] = &[
    "name",
    "base_url",
    "wire_api",
    "experimental_bearer_token",
    "env_key",
    "env_key_instructions",
    "requires_openai_auth",
    "supports_websockets",
    "auth",
    "http_headers",
    "env_http_headers",
];
fn restore_codex_fields(
    source: &str,
    before: &str,
    managed: &str,
    official: bool,
) -> Result<String> {
    let mut current = doc(source)?;
    let expected = doc(managed)?;
    let previous = doc(before)?;
    let keys = if official {
        vec!["openai_base_url", "chatgpt_base_url"]
    } else {
        vec![
            "model",
            "model_provider",
            "model_context_window",
            "model_catalog_json",
            "web_search",
        ]
    };
    for key in &keys {
        if semantic(previous.get(key)) != semantic(expected.get(key))
            && semantic(current.get(key)) != semantic(expected.get(key))
            && semantic(current.get(key)) != semantic(previous.get(key))
        {
            return Err("外部配置变化已保留，Gateway 继续运行；请恢复受管字段后重试".into());
        }
    }
    if official {
        if let Some(id) = previous
            .get("model_provider")
            .and_then(Item::as_str)
            .filter(|id| !["openai", "xwx_deck"].contains(id))
        {
            let old = provider_field(&previous, id, "base_url");
            let expected_url = provider_field(&expected, id, "base_url");
            let actual = provider_field(&current, id, "base_url");
            if semantic(old) != semantic(expected_url) {
                if semantic(actual) != semantic(expected_url) && semantic(actual) != semantic(old) {
                    return Err(
                        "外部服务配置变化已保留，Gateway 继续运行；请恢复受管字段后重试".into(),
                    );
                }
                if let Some(old) = old {
                    let restored = restored_value(old, actual);
                    current["model_providers"][id]["base_url"] = restored;
                }
            }
        }
    }
    let fields = CODEX_PROVIDER_FIELDS
        .iter()
        .filter(|key| {
            semantic(provider_field(&previous, "xwx_deck", key))
                != semantic(provider_field(&expected, "xwx_deck", key))
        })
        .copied()
        .collect::<Vec<_>>();
    for key in &fields {
        if semantic(provider_field(&current, "xwx_deck", key))
            != semantic(provider_field(&expected, "xwx_deck", key))
            && semantic(provider_field(&current, "xwx_deck", key))
                != semantic(provider_field(&previous, "xwx_deck", key))
        {
            return Err("外部服务配置变化已保留，Gateway 继续运行；请恢复受管字段后重试".into());
        }
    }
    for key in keys {
        if semantic(previous.get(key)) == semantic(expected.get(key)) {
            continue;
        }
        if let Some(value) = previous.get(key) {
            current[key] = restored_value(value, current.get(key));
        } else {
            current.remove(key);
        }
    }
    for key in fields {
        if let Some(value) = provider_field(&previous, "xwx_deck", key) {
            let restored = restored_value(value, provider_field(&current, "xwx_deck", key));
            current["model_providers"]["xwx_deck"][key] = restored;
        } else if let Some(table) = current
            .get_mut("model_providers")
            .and_then(|p| p.get_mut("xwx_deck"))
            .and_then(Item::as_table_like_mut)
        {
            table.remove(key);
        }
    }
    if previous
        .get("model_providers")
        .and_then(|p| p.get("xwx_deck"))
        .is_none()
        && current
            .get("model_providers")
            .and_then(|p| p.get("xwx_deck"))
            .and_then(Item::as_table_like)
            .is_some_and(|t| t.is_empty())
    {
        if let Some(table) = current
            .get_mut("model_providers")
            .and_then(Item::as_table_like_mut)
        {
            table.remove("xwx_deck");
            if table.is_empty() && previous.get("model_providers").is_none() {
                current.remove("model_providers");
            }
        }
    }
    Ok(if source == managed {
        before.into()
    } else {
        current.to_string()
    })
}
fn doc(source: &str) -> Result<DocumentMut> {
    source
        .parse()
        .map_err(|_| "Codex TOML 无法解析，原文件已保留；请在设置中修复配置".into())
}
fn codex_external_change(
    current: &DocumentMut,
    expected: &DocumentMut,
    id: &str,
    owns_resume_alias: bool,
) -> bool {
    // Older builds wrote requires_openai_auth=true for third-party providers.
    // Accept the app's own true→false migration instead of treating the
    // current file as an external edit; otherwise every later model switch is
    // blocked until an explicit takeover.
    let migrated_auth = |provider: &str| {
        provider_field(current, provider, "experimental_bearer_token")
            .and_then(Item::as_str)
            .is_some_and(|token| !token.trim().is_empty())
            && provider_field(current, provider, "requires_openai_auth").and_then(Item::as_bool)
                == Some(false)
            && provider_field(expected, provider, "requires_openai_auth").and_then(Item::as_bool)
                == Some(true)
    };
    ["model", "model_provider", "model_context_window"]
        .iter()
        .any(|key| semantic(current.get(key)) != semantic(expected.get(key)))
        || CODEX_PROVIDER_FIELDS.iter().any(|key| {
            !(*key == "requires_openai_auth" && migrated_auth(id))
                && semantic(provider_field(current, id, key))
                    != semantic(provider_field(expected, id, key))
        })
        || (owns_resume_alias
            && CODEX_PROVIDER_FIELDS.iter().any(|key| {
                !(*key == "requires_openai_auth" && migrated_auth("xwx_deck"))
                    && semantic(provider_field(current, "xwx_deck", key))
                        != semantic(provider_field(expected, "xwx_deck", key))
            }))
}

impl Pilot {
    pub fn updates_context(&self) -> updates::Updates {
        self.updates.clone()
    }
    pub fn subscription_context(&self) -> subscriptions::Accounts {
        self.subscriptions.clone()
    }
    pub fn official_chatgpt_job(&self) -> official_chatgpt::ReadAccount {
        official_chatgpt::ReadAccount::new(
            self.codex_home(),
            self.subscriptions.official_usage_url(),
            self.data_root(),
        )
    }
    pub fn validation_job(&self, input: &Value) -> Result<(PathBuf, Provider, Option<String>)> {
        let provider = self
            .settings
            .connections
            .iter()
            .find(|p| p.id == text(input, "providerId"))
            .cloned()
            .ok_or("连接不存在")?;
        Ok((
            self.root.clone(),
            provider,
            match input.get("model") {
                None => None,
                Some(Value::String(value)) if !value.trim().is_empty() && value.len() <= 512 => {
                    Some(value.trim().to_owned())
                }
                _ => return Err("无效模型名称".into()),
            },
        ))
    }
    pub async fn execute_validation(job: (PathBuf, Provider, Option<String>)) -> Result<Value> {
        clients::validate_provider(job.0, job.1, job.2).await
    }
    fn client_discovery(&self) -> client_installations::Discovery {
        let fixture_home =
            if self.isolated && std::env::args().any(|arg| arg == "--rpc" || arg == "--smoke") {
                std::env::var_os("XWX_CLIENT_INSTALLATIONS_TEST_HOME")
                    .map(PathBuf::from)
                    .filter(|path| path.is_absolute() && path.starts_with(&self.root))
            } else {
                None
            };
        let discovery = if self.isolated {
            client_installations::Discovery::for_home(
                &fixture_home.unwrap_or_else(|| self.root.join("installations")),
            )
        } else {
            client_installations::Discovery::system()
        };
        let locations = client_installations::manual_locations(
            &self.settings.other,
            self.isolated.then_some(self.root.as_path()),
        );
        discovery.with_manual_locations(locations)
    }
    fn inspect_client_installation(&self, id: &str, location: &str) -> Result<PathBuf> {
        let catalog: Value = serde_json::from_str(include_str!(
            "../../test-results/native-assets/clients.json"
        ))
        .map_err(err)?;
        let id = client_installations::canonical_id(id);
        if !catalog.as_array().is_some_and(|rows| {
            rows.iter()
                .any(|row| row["id"] == id && row["modelManagement"] == true)
        }) {
            return Err("暂不支持此客户端的模型配置".into());
        }
        let path = PathBuf::from(location);
        if !path.is_absolute() || !path.is_dir() {
            return Err("请选择客户端的安装目录".into());
        }
        let path = std::fs::canonicalize(path).map_err(err)?;
        if self.isolated && !path.starts_with(std::fs::canonicalize(&self.root).map_err(err)?) {
            return Err("隔离验证只允许选择本次测试目录中的安装位置".into());
        }
        let discovery = client_installations::Discovery::for_location(&path);
        if !discovery.installed(id) {
            return Err("所选位置未找到对应客户端，请选择其安装目录".into());
        }
        if !discovery.management_supported(id) {
            return Err("所选客户端版本不支持模型配置，请更新后重试".into());
        }
        Ok(path)
    }
    fn client_configured(&self, client: &str) -> bool {
        if self
            .selected_for(client)
            .is_some_and(|p| !p.base_url.trim().is_empty())
        {
            return true;
        }
        match client {
            "codex" => self.client_codex().ok().flatten().is_some(),
            "claude" => self.official_claude().ok().flatten().is_some(),
            _ => false,
        }
    }
    pub(super) fn client_enabled(&self, client: &str) -> bool {
        self.settings.client_enabled[client]
            .as_bool()
            .unwrap_or_else(|| self.client_configured(client))
    }
    fn model_clients(&self) -> Vec<String> {
        // Installation discovery is read-only. Only explicit saved enrollment
        // creates model tabs, including on the first run.
        let mut clients = vec![];
        for id in self
            .settings
            .other
            .get("modelClients")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let id = client_installations::canonical_id(id).to_owned();
            if !clients.contains(&id) {
                clients.push(id);
            }
        }
        clients
    }
    pub fn open(root: PathBuf) -> Result<Shared> {
        let isolated = std::env::args().any(|a| a == "--pilot-root");
        // Isolated verification never discovers live client configuration.
        if !root.is_absolute()
            || root
                .components()
                .any(|p| matches!(p, std::path::Component::ParentDir))
        {
            return Err("必须指定绝对路径的隔离试验目录 --pilot-root".into());
        }
        fs::create_dir_all(&root).map_err(err)?;
        if !same_physical_path(&root)? {
            return Err("试验目录不能经过符号链接".into());
        }
        let marker = root.join(".xwx-rust-pilot");
        if read(&marker)?.is_none() {
            if isolated && fs::read_dir(&root).map_err(err)?.next().is_some() {
                return Err("首次试验必须使用空目录".into());
            }
            write(&marker, "isolated-rust-pilot-v1\n")?;
        } else if read(&marker)?.as_deref() != Some("isolated-rust-pilot-v1\n") {
            return Err("隔离目录标记不匹配".into());
        }
        for name in ["codex", "claude", "traces", "logs"] {
            let path = root.join(name);
            fs::create_dir_all(&path).map_err(err)?;
            if !same_physical_path(&path)? {
                return Err("隔离子目录不能经过符号链接".into());
            }
        }
        let lock_path = root.join("pilot.lock");
        if lock_path.exists() && !same_physical_path(&lock_path)? {
            return Err("目录锁不能经过符号链接".into());
        }
        let mut lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(err)?;
        let deadline = std::time::Instant::now() + Duration::from_secs(40);
        let settling = std::time::Instant::now() + Duration::from_millis(100);
        loop {
            if lock.try_lock().is_ok() {
                break;
            }
            if std::time::Instant::now() >= deadline
                || (std::time::Instant::now() >= settling
                    && read(&root.join(native_auth::LEASE))?.is_none())
            {
                return Err("试验目录已被另一个运行中的进程占用".into());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        lock.set_len(0).map_err(err)?;
        use std::io::Write;
        lock.write_all(std::process::id().to_string().as_bytes())
            .map_err(err)?;
        if root.join(native_auth::LEASE).exists() {
            fs::remove_file(root.join(native_auth::LEASE)).map_err(err)?;
        }
        legacy_helper::preflight(&root, false)?;
        credentials::register(&root, isolated)?;
        legacy_helper::preflight(&root, true)?;
        credentials::migrate_documents(&root)?;
        let settings_source = read(&root.join("settings.json"))?;
        let (settings, settings_problem) = match settings_source.clone() {
            Some(source) => match (|| -> Result<Settings> {
                let mut value: Value = serde_json::from_str(&source).map_err(err)?;
                if value.get("traceWarningGB").is_some() {
                    value
                        .as_object_mut()
                        .ok_or("设置不是对象")?
                        .remove("traceWarningGb");
                }
                if value.get("nativeMigrationVersion").is_none() {
                    let backup = root.join("settings-before-native-migration.json");
                    if !backup.exists() {
                        write(&backup, &source)?;
                    }
                }
                if value.get("connections").is_none() {
                    if let Some(registry) = value
                        .get("providers")
                        .cloned()
                        .filter(|r| r["connections"].is_array())
                    {
                        value["connections"] = registry["connections"].clone();
                        value["selected"] = registry["selected"].clone();
                        let backup = root.join("settings-before-native-migration.json");
                        if !backup.exists() {
                            write(&backup, &source)?;
                        }
                    }
                }
                if value.get("nativeMigrationVersion").is_none() {
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
                    let remembered = value["selected"].clone();
                    for (client, mode) in [
                        ("codex", "codexPreferredMode"),
                        ("claude", "claudePreferredMode"),
                    ] {
                        if value[mode] == "official" {
                            value["selected"][client] = Value::Null;
                        }
                    }
                    value["rememberedProviderIds"] = remembered;
                    if value.get("traceDesiredEnabled").is_none() {
                        value["traceDesiredEnabled"] = json!(
                            value["tracingEnabled"] == true && value["gatewayPaused"] != true
                        );
                    }
                    value["nativeMigrationInputSha256"] = json!(storage::digest(source.as_bytes()));
                    value["nativeMigrationVersion"] = json!(1);
                }
                serde_json::from_value(value).map_err(err)
            })() {
                Ok(settings) => (settings, None),
                Err(_) => (
                    Settings::default(),
                    Some("设置文件损坏，原文件已保留；修复前不会覆盖连接与选择".into()),
                ),
            },
            None => (Settings::fresh(), None),
        };
        let trace_root = Self::directory(&root, &settings.trace_root, "traces")?;
        let store = storage::TraceStore::open(
            trace_root,
            (settings.trace_warning_gb * 1024.0f64.powi(3)) as u64,
            settings.trace_auto_cleanup,
            &root,
        )?;
        {
            let mut trace_store = store.lock().map_err(err)?;
            trace_store.theme = settings.theme.clone();
            trace_store.language = settings
                .language
                .clone()
                .unwrap_or_else(crate::language::system_language);
        }
        let mut pilot = Self {
            reset_pending: false,
            catalog_generation: 0,
            catalog_repair_generation: 0,
            state_revision: std::sync::Mutex::new((0, Value::Null)),
            subscriptions: subscriptions::Accounts::open(&root, isolated)?,
            updates: updates::Updates::new(root.clone()),
            metadata: metadata::Metadata::new(root.clone(), isolated)?,
            root,
            isolated,
            settings,
            gateway: None,
            count: Arc::new(AtomicU64::new(0)),
            lock,
            store,
            dashboard: None,
            settings_source: std::sync::Mutex::new(settings_source),
            settings_problem,
            recovery_problem: None,
            renderer_preferences_problem: None,
        };
        pilot.recovery_problem = pilot
            .recover_desktop_transaction()
            .and_then(|_| pilot.resolve_claude_path().map(|_| ()))
            .and_then(|_| pilot.recover_legacy_clients())
            .and_then(|_| pilot.restore_client_wiring(None))
            .and_then(|_| pilot.recover_interrupted_gateway())
            .and_then(|_| pilot.recover_legacy_helper())
            .err();
        if pilot.settings_problem.is_none() {
            pilot
                .settings
                .other
                .entry("nativeMigrationVersion")
                .or_insert(json!(1));
            pilot.persist()?;
        }
        Ok(Arc::new(Mutex::new(pilot)))
    }
    pub fn data_root(&self) -> PathBuf {
        self.root.clone()
    }
    pub fn renderer_preferences_context(&self) -> (PathBuf, Vec<String>) {
        (
            self.root.clone(),
            crate::renderer_preferences::keys(
                self.settings.connections.iter().map(|p| p.id.clone()),
                &self.config_path(),
            ),
        )
    }
    pub fn renderer_preferences_problem(&mut self, problem: &str) {
        self.renderer_preferences_problem = Some(problem.to_owned());
    }
    pub fn trace_root(&self) -> PathBuf {
        if self.settings.trace_root.is_empty() {
            self.root.join("traces")
        } else {
            PathBuf::from(&self.settings.trace_root)
        }
    }
    pub fn log_root(&self) -> PathBuf {
        if self.settings.log_root.is_empty() {
            self.root.join("logs")
        } else {
            PathBuf::from(&self.settings.log_root)
        }
    }
    fn default_claude_dir(&self) -> PathBuf {
        self.resolve_claude_directory("")
    }
    fn claude_dir(&self) -> PathBuf {
        self.resolve_claude_directory(&self.settings.claude_config_dir)
    }
    fn resolve_claude_directory(&self, persisted: &str) -> PathBuf {
        let environment = std::env::var("CLAUDE_CONFIG_DIR").ok();
        let fallback = if self.isolated {
            self.root.join("claude")
        } else {
            Self::home().join(".claude")
        };
        claude_directory::resolve(self.isolated, environment.as_deref(), persisted, &fallback)
    }
    fn home() -> PathBuf {
        std::env::var_os(if cfg!(target_os = "windows") {
            "USERPROFILE"
        } else {
            "HOME"
        })
        .map(PathBuf::from)
        .unwrap_or_default()
    }
    fn codex_home(&self) -> PathBuf {
        if self.isolated {
            self.root.join("codex")
        } else {
            std::env::var("CODEX_HOME")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| Self::home().join(".codex"))
        }
    }
    fn config_path(&self) -> PathBuf {
        self.codex_home().join("config.toml")
    }
    fn config(&self) -> Result<DocumentMut> {
        doc(&read(&self.config_path())?.unwrap_or_default())
    }
    fn selected(&self) -> Option<&Provider> {
        self.settings.selected["codex"]
            .as_str()
            .and_then(|id| self.settings.connections.iter().find(|p| p.id == id))
    }
    fn generic_routes(&self) -> std::collections::BTreeMap<String, Provider> {
        self.settings
            .other
            .get("clientRoutes")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter(|(id, v)| ingress::valid_client(id) && v["enabled"] != false)
            .filter_map(|(id, v)| {
                self.settings
                    .connections
                    .iter()
                    .find(|p| p.id == text(v, "providerId"))
                    .map(|p| {
                        let mut p = p.clone();
                        p.codex_model = text(v, "model").into();
                        (id.clone(), p)
                    })
            })
            .collect()
    }
    pub fn update_state(&self) -> Value {
        self.updates.state()
    }
    pub fn trace_events(&self) -> Result<tokio::sync::broadcast::Receiver<String>> {
        Ok(self.store.lock().map_err(err)?.events.subscribe())
    }
    pub fn nightly_eligible(&self) -> bool {
        if !self.settings.automatic_updates {
            return false;
        }
        let state = self.updates.state();
        read(&self.root.join("declined-update.json"))
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .is_none_or(|v| v["version"] != state["targetVersion"])
    }
    async fn providers(&self) -> Value {
        // Keep saved models and explicit selections, but do not offer an API
        // subscription whose authorization was never added or was signed out.
        let mut connections = Vec::new();
        for provider in &self.settings.connections {
            let id = &provider.subscription_account_id;
            if !id.is_empty()
                && subscription_routing::group(id) == "chatgpt"
                && !self.subscriptions.has_api_authorization(id).await
            {
                continue;
            }
            let mut connection = json!(provider);
            if official_accounts::is_official(id) {
                connection["codexNativeOfficial"] = json!(self.codex_native_official(provider));
            }
            if !id.is_empty() {
                connection["codexNativeAuth"] = json!(native_auth::available(provider));
            }
            connections.push(connection);
        }
        json!({"version":1,"identityVersion":2,"connections":connections,"selected":self.settings.selected,"active":self.settings.selected,"warning":self.settings_problem})
    }
    pub fn state(&self) -> Value {
        let active = self.gateway.is_some();
        let (sessions, count, bytes) = self.store.lock().unwrap().totals();
        let mut state = json!({"waitingTools":self.gateway.as_ref().map(|g|g.activity.waiting_tools()).unwrap_or(0),"activeRequests":self.gateway.as_ref().map(|g|g.activity.count()).unwrap_or(0),"tracingEnabled":active,"readiness":{"startupPhase":"ready","proxyListening":active,"recordingEnabled":active,"claudeConfigReady":self.gateway.as_ref().is_some_and(|g|g.claude.is_some()),"claudeRouteReady":self.gateway.as_ref().is_some_and(|g|g.claude.is_some()),"codexConfigReady":self.gateway.as_ref().is_some_and(|g|g.codex_managed),"codexRouteReady":self.gateway.as_ref().is_some_and(|g|g.codex_managed),"codexGatewayEnabled":self.gateway.as_ref().is_some_and(|g|g.codex_managed)},
          "applicationResetArchives":true,
          "localBaseUrl":self.gateway.as_ref().map(|g|format!("http://127.0.0.1:{}",g.port)),"traceRoot":self.trace_root(),"logRoot":self.log_root(),"claudeConfigDir":self.claude_dir(),"claudeConfigPath":self.claude_path(),
          "backgroundGatewayActive":active,"backgroundGatewayAction":if active {Some("close")} else {None},"chatGptRestartRecommended":false,
          "sessions":sessions,"traces":count,"storageText":format_bytes(bytes),"traceStorageBytes":bytes,"traceWarningGB":self.settings.trace_warning_gb,"traceAutoCleanup":self.settings.trace_auto_cleanup,"traceStorageNotice":self.store.lock().unwrap().retention_notice,
          "clients":[{"id":"claude-cli","label":"Claude","enabled":self.client_enabled("claude"),"status":if self.gateway.as_ref().is_some_and(|g|g.claude.is_some()){"taken"}else{"idle"},"statusText":if self.gateway.as_ref().is_some_and(|g|g.claude.is_some()){"追踪中"}else{"待命"},"detail":if self.gateway.as_ref().is_some_and(|g|g.claude.is_some()){"客户端请求正在追踪"}else{"客户端直连"}},{"id":"codex-cli","label":"ChatGPT","enabled":self.client_enabled("codex"),"status":if self.gateway.as_ref().is_some_and(|g|g.codex_managed){"taken"}else{"idle"},"statusText":if self.gateway.as_ref().is_some_and(|g|g.codex_managed){"追踪中"}else{"待命"},"detail":if self.gateway.as_ref().is_some_and(|g|g.codex_managed){"客户端请求正在追踪"}else{"客户端直连"}}],
          "metadata":self.metadata.state(),"lastError":self.settings_problem.clone().or_else(||self.recovery_problem.clone()).or_else(||self.renderer_preferences_problem.clone()).or_else(||self.settings.claude_desktop["syncWarning"].as_str().map(str::to_string)).or_else(||self.store.lock().unwrap().read_problem.clone()).or_else(||self.config().err()),"theme":self.settings.theme,"language":self.settings.language.clone().unwrap_or_else(crate::language::system_language),"automaticUpdates":self.settings.automatic_updates,"traceAppearance":self.trace_appearance(),"startup":{"enabled":self.settings.startup_enabled,"desiredEnabled":self.settings.startup_enabled,"supported":!self.isolated&&cfg!(any(target_os="macos",target_os="windows")),"launchHidden":true,"warning":if self.isolated {Some("隔离验证不注册系统登录项")}else{None}},"update":self.update_state()});
        if let Some(rows) = state["clients"].as_array_mut() {
            let routes = self.generic_routes();
            for (id, v) in self
                .settings
                .other
                .get("clientRoutes")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
            {
                let enabled = v["enabled"] != false;
                let automatic = client_wiring::automatic_client(id);
                let listening = active && routes.contains_key(id);
                let wired = listening
                    && (!automatic || self.root.join(format!("client-wiring-{id}.json")).exists());
                let skipped = listening && automatic && !wired;
                rows.push(json!({"id":id,"label":ingress::label(id),"enabled":enabled,
                    "status":if !enabled {"off"} else if skipped {"skipped"} else if wired {"taken"} else {"idle"},
                    "statusText":if !enabled {"已暂停"} else if skipped {"未接管"} else if wired && automatic {"追踪中"} else if wired {"入口已就绪"} else {"待命"},
                    "detail":if skipped {"未检测到客户端，原配置保留"} else if wired && automatic {"客户端请求正在追踪"} else if wired {"将接入地址填入客户端后开始捕获"} else {"客户端直连"}}));
            }
        }
        if !active {
            let clients = [("codex", "ChatGPT"), ("claude", "Claude")]
                .into_iter()
                .filter(|(client, _)| {
                    self.client_enabled(client)
                        && self
                            .selected_for(client)
                            .is_some_and(|p| self.needs_gateway(p, client))
                })
                .map(|(_, label)| label)
                .collect::<Vec<_>>();
            if !clients.is_empty() {
                state["connectionNotice"] = json!({"message":"当前模型需要开启 Trace","description":format!("{} 的所选连接需要协议转换或订阅授权。已恢复可用的原始直连配置，保留所选连接和模型；开启 Trace 后继续使用。",clients.join("、")),"type":"info","action":"start-trace","actionLabel":"开启 Trace"});
            }
        }
        // A read of unchanged state must not create a broadcast storm. Revision
        // advances only when a complete snapshot changes, under the same lock.
        if let Ok(mut revision) = self.state_revision.lock() {
            if revision.1 != state {
                revision.0 += 1;
                revision.1 = state.clone();
            }
            state["revision"] = json!(revision.0);
        }
        state
    }
    fn owns_codex_resume_alias(&self, current: &DocumentMut) -> Result<bool> {
        if self.gateway.as_ref().is_some_and(|g| {
            doc(&g.managed).is_ok_and(|expected| {
                CODEX_PROVIDER_FIELDS.iter().all(|key| {
                    semantic(provider_field(current, "xwx_deck", key))
                        == semantic(provider_field(&expected, "xwx_deck", key))
                })
            })
        }) {
            return Ok(true);
        }
        let Some(source) = read(&self.root.join("codex-direct.json"))? else {
            return Ok(false);
        };
        let ledger: Value = serde_json::from_str(&source).map_err(err)?;
        let before = doc(text(&ledger, "before"))?;
        let expected = doc(text(&ledger, "managed"))?;
        let owned = ledger["providerIds"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|id| id == "xwx_deck"))
            && (ledger["resumeAlias"] == true
                || before
                    .get("model_providers")
                    .and_then(|t| t.get("xwx_deck"))
                    .is_none());
        Ok(owned
            && CODEX_PROVIDER_FIELDS.iter().all(|key| {
                semantic(provider_field(current, "xwx_deck", key))
                    == semantic(provider_field(&expected, "xwx_deck", key))
            }))
    }
    fn codex_snapshot(&self) -> Result<Value> {
        let d = self.config()?;
        let provider = d
            .get("model_provider")
            .and_then(Item::as_str)
            .unwrap_or("openai");
        let model = d.get("model").and_then(Item::as_str).unwrap_or("");
        let base = d
            .get("model_providers")
            .and_then(|t| t.get(provider))
            .and_then(|p| p.get("base_url"))
            .and_then(Item::as_str)
            .unwrap_or("");
        let selected = self.selected();
        let using_selected = selected.is_some_and(|p| {
            provider == "xwx_deck" && self.active()
                || !self.needs_gateway(p, "codex")
                    && (provider == p.codex_provider_id
                        || provider == p.id
                        || provider == "xwx_deck")
        });
        let foreign_resume_alias = provider_field(&d, "xwx_deck", "base_url")
            .and_then(Item::as_str)
            .is_some_and(local_codex_endpoint)
            && !self.owns_codex_resume_alias(&d)?;
        let direct_ledger = read(&self.root.join("codex-direct.json"))?
            .map(|source| serde_json::from_str::<Value>(&source).map_err(err))
            .transpose()?;
        let stale_root = stale_codex_root_override(
            &d,
            &codex_resume_origins(
                &d,
                direct_ledger.as_ref(),
                selected.map(|p| p.base_url.as_str()),
            )?,
        );
        let owned_provider = !foreign_resume_alias
            && !stale_root
            && (provider == "openai"
                || provider == "xwx_deck"
                || self.settings.connections.iter().any(|p| {
                    (provider == p.codex_provider_id || provider == p.id)
                        && base == Self::provider_api_root(p)
                }));
        Ok(
            json!({"configPath":self.config_path(),"authPath":self.codex_home().join("auth.json"),"exists":self.config_path().exists(),"mode":if using_selected{"compatible"}else{"official"},"authMode":self.auth_mode(),"activeProvider":provider,"activeBaseUrl":base,"officialModel":if !using_selected{model}else{""},"modelCatalogSource":if d.get("model_catalog_json").and_then(Item::as_str).is_some_and(|p|Path::new(p)==self.codex_home().join("xwx-deck-model-catalog.json")){"compatible"}else{"none"},"configOwnership":if !self.config_path().exists() || owned_provider {"deck"} else {"external"},
          "modelContextWindow":selected.map(|p|p.codex_context_window).filter(|n|*n>0).or_else(||if selected.is_none(){d.get("model_context_window").and_then(Item::as_integer).and_then(|n|u64::try_from(n).ok()).filter(|n|*n>0)}else{None}),
          "compatible":{"provider":selected.map(|p|p.display_name.as_str()).unwrap_or(""),"model":selected.map(|p|p.codex_model.as_str()).unwrap_or(""),"baseUrl":selected.map(|p|p.base_url.as_str()).unwrap_or(""),"bearerToken":selected.map(|p|p.bearer_token.as_str()).unwrap_or("")}}),
        )
    }
    fn subscription_route_accepted(&self, client: &str, source: &str) -> Result<bool> {
        use sha2::{Digest, Sha256};
        if self
            .selected_for(client)
            .is_none_or(|p| p.subscription_account_id.is_empty())
        {
            return Ok(false);
        }
        let fingerprint = format!("{:x}", Sha256::digest(source.as_bytes()));
        Ok(
            read(&self.root.join(format!("subscription-{client}-route.json")))?
                .is_some_and(|s| s == fingerprint),
        )
    }
    fn remember_subscription_route(&self, client: &str, source: &str) -> Result<()> {
        use sha2::{Digest, Sha256};
        write(
            &self.root.join(format!("subscription-{client}-route.json")),
            &format!("{:x}", Sha256::digest(source.as_bytes())),
        )
    }
    fn write_direct(&self, takeover: bool) -> Result<()> {
        let native_official = self.selected().filter(|p| self.codex_native_official(p));
        let direct_provider = self
            .selected()
            .filter(|p| !self.codex_native_official(p) && !self.needs_gateway(p, "codex"));
        let mut d = self.config()?;
        let accepted_subscription = self.subscription_route_accepted("codex", &d.to_string())?;
        let journal = self.root.join("codex-direct.json");
        let previous = read(&journal)?
            .map(|s| serde_json::from_str::<Value>(&s).map_err(err))
            .transpose()?;
        // Persistent Codex threads retain the Gateway provider ID. Keep a
        // managed direct definition usable after Trace stops, without changing
        // the provider selected for newly created threads.
        let owns_resume_alias = previous.as_ref().is_some_and(|ledger| {
            ledger["providerIds"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|id| id == "xwx_deck"))
                && (ledger["resumeAlias"] == true
                    || doc(text(ledger, "before")).is_ok_and(|before| {
                        before
                            .get("model_providers")
                            .and_then(|t| t.get("xwx_deck"))
                            .is_none()
                    }))
        });
        if let Some(ref ledger) = previous {
            let expected = doc(text(ledger, "managed"))?;
            let id = text(ledger, "providerId").trim();
            if !takeover
                && !accepted_subscription
                && codex_external_change(&d, &expected, id, owns_resume_alias)
            {
                return Err("外部 Codex 配置变化已保留，请明确接管后重试".into());
            }
        }
        let has_resume_alias = d
            .get("model_providers")
            .and_then(|t| t.get("xwx_deck"))
            .is_some();
        let foreign_local_alias = provider_field(&d, "xwx_deck", "base_url")
            .and_then(Item::as_str)
            .is_some_and(local_codex_endpoint)
            && !self.owns_codex_resume_alias(&d)?;
        if foreign_local_alias && !takeover {
            return Err("旧会话仍绑定其他本地代理，配置已保留；请在模型页选择目标服务并备份接管，再重新打开原会话".into());
        }
        let resume_alias = owns_resume_alias || !has_resume_alias || takeover;
        // Retain proven local origins even when an older baseline predates
        // this takeover. This is route ownership, never a port-name heuristic.
        let target_base = self.selected().map(|p| p.base_url.as_str());
        let resume_origins = codex_resume_origins(&d, previous.as_ref(), target_base)?;
        let adopted_resume_origins = if takeover {
            resume_origins.clone()
        } else {
            // A normal local API endpoint is not evidence of an old proxy.
            codex_resume_origins(&DocumentMut::new(), previous.as_ref(), target_base)?
        };
        if !takeover && stale_codex_root_override(&d, &resume_origins) {
            return Err("外部 Codex 配置变化已保留，请明确接管后重试".into());
        }
        let adopted_root_override =
            |config: &DocumentMut, key: &str| codex_root_override(config, key, &resume_origins);
        let before = d.to_string();
        let direct_id = direct_provider
            .map(|p| {
                if self.settings.codex_enhancements["unifySessionHistory"] == true {
                    "xwx_deck"
                } else if p.codex_provider_id.is_empty() {
                    p.id.as_str()
                } else {
                    p.codex_provider_id.as_str()
                }
            })
            .unwrap_or("openai");
        let active = d
            .get("model_provider")
            .and_then(Item::as_str)
            .unwrap_or("openai");
        let retained = self.selected().is_some_and(|p| {
            active == p.codex_provider_id
                && d.get("model_providers")
                    .and_then(|t| t.get(active))
                    .and_then(|t| t.get("base_url"))
                    .and_then(Item::as_str)
                    == Some(Self::provider_api_root(p).as_str())
        });
        if active != "openai"
            && active != "xwx_deck"
            && !retained
            && previous.is_none()
            && !takeover
            && !accepted_subscription
        {
            return Err("外部配置变化已保留，请确认接管后重试".into());
        }
        if takeover {
            write(
                &self.root.join(format!("codex/backup-{}.toml", millis())),
                &d.to_string(),
            )?;
        }
        if self
            .selected()
            .is_some_and(|p| !p.subscription_account_id.is_empty())
            && native_official.is_none()
            && direct_provider.is_none()
            && !(takeover
                && (foreign_local_alias
                    || ["openai_base_url", "chatgpt_base_url"]
                        .iter()
                        .any(|key| adopted_root_override(&d, key))))
        {
            return self.remember_subscription_route("codex", &d.to_string());
        }
        if direct_provider.is_none() {
            if let Some(ref ledger) = previous {
                legacy_codex::release_direct_fields(&mut d, ledger)?;
            }
        }
        // Apply approved cleanup to every target, including API providers.
        // Independent origins and custom paths remain outside this takeover.
        if takeover {
            for key in ["openai_base_url", "chatgpt_base_url"] {
                if adopted_root_override(&d, key) {
                    d.remove(key);
                }
            }
        }
        if let Some(p) = self
            .selected()
            .filter(|p| p.subscription_account_id.is_empty())
        {
            let entries = self.local_catalog(p)?;
            self.publish_codex_catalog(p, entries.as_array().map(Vec::as_slice).unwrap_or(&[]))?;
        }
        if let Some(p) = direct_provider {
            set_codex_field(&mut d, "model_provider", value(direct_id));
            set_codex_field(&mut d, "model", value(&p.codex_model));
            set_codex_provider_field(&mut d, direct_id, "name", value(&p.display_name));
            set_codex_provider_field(
                &mut d,
                direct_id,
                "base_url",
                value(Self::provider_api_root(p)),
            );
            set_codex_provider_field(&mut d, direct_id, "wire_api", value("responses"));
            set_codex_provider_field(
                &mut d,
                direct_id,
                "experimental_bearer_token",
                value(&p.bearer_token),
            );
            if p.codex_context_window > 0 {
                set_codex_field(
                    &mut d,
                    "model_context_window",
                    value(p.codex_context_window as i64),
                );
            } else {
                d.remove("model_context_window");
            }
            // A compatible-service provider authenticates with its own bearer
            // token. Never send the ChatGPT login to a third-party endpoint.
            set_codex_provider_field(&mut d, direct_id, "requires_openai_auth", value(false));
            if p.subscription_account_id.is_empty() {
                let owned_auth = native_auth::owns_auth(&d, direct_id);
                if provider_field(&d, direct_id, "auth").is_some() && !owned_auth && !takeover {
                    return Err("外部认证命令已保留，请明确接管后重试".into());
                }
                if let Some(table) = d
                    .get_mut("model_providers")
                    .and_then(|p| p.get_mut(direct_id))
                    .and_then(Item::as_table_like_mut)
                {
                    // Release only the helper fields published by Deck.
                    if owned_auth || takeover {
                        for key in ["auth", "http_headers", "env_http_headers"] {
                            table.remove(key);
                        }
                    }
                }
            } else {
                if provider_field(&d, direct_id, "auth").is_some()
                    && !native_auth::owns_auth(&d, direct_id)
                    && !takeover
                {
                    return Err("外部认证命令已保留，请明确接管后重试".into());
                }
                if !native_auth::owns_auth(&d, direct_id)
                    && !takeover
                    && ["http_headers", "env_http_headers"]
                        .iter()
                        .any(|key| provider_field(&d, direct_id, key).is_some())
                {
                    return Err("外部认证请求头已保留，请明确接管后重试".into());
                }
                native_auth::configure(&mut d, direct_id, &self.root, self.isolated, p)?;
            }
            let catalog_path = self.codex_home().join("xwx-deck-model-catalog.json");
            let pointer = d.get("model_catalog_json").and_then(Item::as_str);
            if pointer.is_some_and(|path| Path::new(path) != catalog_path) && !takeover {
                return Err("外部模型目录已保留，请确认接管后重试".into());
            }
            let entries = self.local_catalog(p)?;
            self.publish_codex_catalog(p, entries.as_array().map(Vec::as_slice).unwrap_or(&[]))?;
            set_codex_field(
                &mut d,
                "model_catalog_json",
                value(catalog_path.to_string_lossy().to_string()),
            );
        } else {
            set_codex_field(&mut d, "model_provider", value("openai"));
            if let Some(model) = native_official
                .map(|p| p.codex_model.as_str())
                .or_else(|| self.settings.codex_models["official"].as_str())
                .filter(|s| !s.is_empty())
            {
                set_codex_field(&mut d, "model", value(model));
            }
            let context_window = native_official
                .map(|p| p.codex_context_window)
                .or_else(|| self.settings.codex_models["officialContextWindow"].as_u64())
                .unwrap_or(0);
            if context_window > 0 {
                set_codex_field(&mut d, "model_context_window", value(context_window as i64));
            } else if native_official.is_some() {
                d.remove("model_context_window");
            }
            if d.get("model_catalog_json")
                .and_then(Item::as_str)
                .is_some_and(|p| {
                    Path::new(p) == self.codex_home().join("xwx-deck-model-catalog.json")
                })
            {
                d.remove("model_catalog_json");
            }
            if self.settings.codex_enhancements["unifySessionHistory"] == true || resume_alias {
                let oauth = self.auth_mode() == "chatgpt";
                let base = d
                    .get(if oauth {
                        "chatgpt_base_url"
                    } else {
                        "openai_base_url"
                    })
                    .and_then(Item::as_str)
                    .unwrap_or(if oauth {
                        "https://chatgpt.com/backend-api"
                    } else {
                        "https://api.openai.com/v1"
                    })
                    .trim_end_matches('/')
                    .to_string();
                if self.settings.codex_enhancements["unifySessionHistory"] == true {
                    set_codex_field(&mut d, "model_provider", value("xwx_deck"));
                }
                set_codex_provider_field(&mut d, "xwx_deck", "name", value("XwX Deck"));
                set_codex_provider_field(&mut d, "xwx_deck", "wire_api", value("responses"));
                set_codex_provider_field(
                    &mut d,
                    "xwx_deck",
                    "base_url",
                    value(if oauth { format!("{base}/codex") } else { base }),
                );
                set_codex_provider_field(&mut d, "xwx_deck", "requires_openai_auth", value(true));
                if let Some(table) = d
                    .get_mut("model_providers")
                    .and_then(|t| t.get_mut("xwx_deck"))
                    .and_then(Item::as_table_like_mut)
                {
                    for key in [
                        "experimental_bearer_token",
                        "env_key",
                        "env_key_instructions",
                        "auth",
                        "http_headers",
                        "env_http_headers",
                    ] {
                        table.remove(key);
                    }
                }
            }
        }
        let managed = direct_provider.is_some()
            || self.settings.codex_enhancements["unifySessionHistory"] == true
            || resume_alias;
        let publish_resume_alias =
            direct_provider.is_some() && direct_id != "xwx_deck" && resume_alias;
        if publish_resume_alias {
            for key in CODEX_PROVIDER_FIELDS {
                if let Some(next) = provider_field(&d, direct_id, key).cloned() {
                    set_codex_provider_field(&mut d, "xwx_deck", key, next);
                } else if let Some(table) = d
                    .get_mut("model_providers")
                    .and_then(|t| t.get_mut("xwx_deck"))
                    .and_then(Item::as_table_like_mut)
                {
                    table.remove(key);
                }
            }
        }
        if managed {
            let managed_id = d
                .get("model_provider")
                .and_then(Item::as_str)
                .unwrap_or(direct_id);
            let mut ids: Vec<String> = previous
                .as_ref()
                .and_then(|l| l["providerIds"].as_array())
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            if let Some(old) = previous
                .as_ref()
                .map(|l| text(l, "providerId"))
                .filter(|s| !s.is_empty())
            {
                ids.push(old.into());
            }
            ids.push(managed_id.into());
            if resume_alias {
                ids.push("xwx_deck".into());
            }
            ids.sort();
            ids.dedup();
            let mut baseline = doc(previous
                .as_ref()
                .map(|l| text(l, "before"))
                .unwrap_or(&before))?;
            // The exact original remains in the takeover backup. The routing
            // baseline must not resurrect a repaired dead root on later switches.
            if takeover {
                for key in ["openai_base_url", "chatgpt_base_url"] {
                    if d.get(key).is_none() && adopted_root_override(&baseline, key) {
                        baseline.remove(key);
                    }
                }
            }
            write(&journal,&json!({"providerId":managed_id,"providerIds":ids,"resumeAlias":resume_alias,"adoptedResumeOrigins":adopted_resume_origins,"before":baseline.to_string(),"managed":d.to_string()}).to_string())?;
        }
        write_checked(&self.config_path(), &before, &d.to_string())?;
        if !managed && previous.is_some() {
            fs::remove_file(journal).map_err(err)?;
        }
        Ok(())
    }
    async fn prepare_routes(
        &mut self,
        validate: bool,
    ) -> Result<(Option<Provider>, Option<Provider>)> {
        // Unreadable client settings are actionable errors, not empty configurations.
        // An explicit off choice excludes that client from route preparation.
        if self.settings.client_enabled["codex"] != false && self.selected().is_none() {
            self.client_codex()?;
        }
        if self.settings.client_enabled["claude"] != false && self.selected_for("claude").is_none()
        {
            self.official_claude()?;
        }
        let provider = if self.client_enabled("codex") {
            if let Some(p) = self.selected() {
                Some(p.clone())
            } else {
                self.client_codex()?
            }
        } else {
            None
        };
        let claude = if self.client_enabled("claude") {
            if let Some(p) = self.selected_for("claude") {
                Some(p.clone())
            } else {
                self.official_claude()?
            }
        } else {
            None
        };
        let generic = self.generic_routes();
        for p in [provider.as_ref(), claude.as_ref()]
            .into_iter()
            .flatten()
            .chain(generic.values())
        {
            if validate && !p.subscription_account_id.is_empty() {
                self.subscriptions
                    .validate_pool(&p.subscription_account_id)
                    .await?;
            }
        }
        if provider.is_none() && claude.is_none() && self.generic_routes().is_empty() {
            return Err("请先安装并配置客户端，或保存并选择 API 连接".into());
        }
        if let Some(ref p) = provider {
            if validate && !p.official && p.codex_model.is_empty() {
                return Err("请先选择或输入模型".into());
            }
            if !p.official {
                self.write_direct(false)?;
            }
        }
        if claude.as_ref().is_some_and(|p| !p.official) {
            self.write_claude_direct(false)?;
        }
        Ok((provider, claude))
    }
    fn manage_routes(&self, port: u16, provider: &Option<Provider>) -> Result<ManagedClientRoutes> {
        let claude_path = self.resolve_claude_path()?;
        let codex_managed = provider.is_some();
        let codex_official = provider.as_ref().is_some_and(|p| p.official);
        let codex_oauth = provider.as_ref().is_some_and(|p| p.oauth);
        let before = read(&self.config_path())?.unwrap_or_default();
        let mut managed = doc(&before)?;
        if codex_managed {
            if codex_official && provider.as_ref().is_some_and(|p| p.id == "client-codex") {
                let p = provider.as_ref().unwrap();
                set_codex_provider_field(
                    &mut managed,
                    &p.codex_provider_id,
                    "base_url",
                    value(format!("http://127.0.0.1:{port}/v1")),
                );
            } else if codex_official {
                set_codex_field(
                    &mut managed,
                    "openai_base_url",
                    value(format!(
                        "http://127.0.0.1:{port}{}",
                        if codex_oauth { "" } else { "/v1" }
                    )),
                );
                if codex_oauth && managed.get("chatgpt_base_url").is_none() {
                    set_codex_field(
                        &mut managed,
                        "chatgpt_base_url",
                        value("https://chatgpt.com/backend-api"),
                    );
                }
                if managed.get("model_provider").and_then(Item::as_str) == Some("xwx_deck")
                    || self.owns_codex_resume_alias(&managed)?
                {
                    set_codex_provider_field(
                        &mut managed,
                        "xwx_deck",
                        "base_url",
                        value(format!(
                            "http://127.0.0.1:{port}{}",
                            if codex_oauth {
                                "/backend-api/codex"
                            } else {
                                "/v1"
                            }
                        )),
                    );
                }
            } else {
                if let Some(p) = provider.as_ref() {
                    // Codex defaults to adding a cached web_search tool even
                    // when the generated model catalog declares no search.
                    // Supply a reversible default only for conversion routes;
                    // an explicit user choice remains authoritative.
                    if managed.get("web_search").is_none()
                        && p.subscription_account_id.is_empty()
                        && !["responses", "openai-responses"].contains(
                            &resolve_wire(&self.root, p, Some(&p.codex_model), "responses")
                                .as_str(),
                        )
                    {
                        set_codex_field(&mut managed, "web_search", value("disabled"));
                    }
                    let direct = managed
                        .get("model_provider")
                        .and_then(Item::as_str)
                        .unwrap_or("openai")
                        .to_owned();
                    if direct != "xwx_deck"
                        && managed
                            .get("model_providers")
                            .and_then(|p| p.get("xwx_deck"))
                            .is_none()
                    {
                        if let Some(table) = managed
                            .get("model_providers")
                            .and_then(|t| t.get(&direct))
                            .cloned()
                        {
                            managed["model_providers"]["xwx_deck"] = table;
                        }
                    }
                    set_codex_field(&mut managed, "model_provider", value("xwx_deck"));
                    set_codex_provider_field(
                        &mut managed,
                        "xwx_deck",
                        "name",
                        value(&p.display_name),
                    );
                    set_codex_provider_field(
                        &mut managed,
                        "xwx_deck",
                        "wire_api",
                        value("responses"),
                    );
                    set_codex_provider_field(
                        &mut managed,
                        "xwx_deck",
                        "supports_websockets",
                        value(false),
                    );
                    set_codex_field(&mut managed, "model", value(&p.codex_model));
                    if p.codex_context_window > 0 {
                        set_codex_field(
                            &mut managed,
                            "model_context_window",
                            value(p.codex_context_window as i64),
                        );
                    } else {
                        managed.remove("model_context_window");
                    }
                    if p.subscription_account_id.is_empty() {
                        set_codex_provider_field(
                            &mut managed,
                            "xwx_deck",
                            "experimental_bearer_token",
                            value(&p.bearer_token),
                        );
                        if managed
                            .get("model_catalog_json")
                            .and_then(Item::as_str)
                            .is_some_and(|path| {
                                Path::new(path)
                                    != self.codex_home().join("xwx-deck-model-catalog.json")
                            })
                        {
                            return Err("外部模型目录已保留，请先明确接管后再开启 Trace".into());
                        }
                        self.publish_codex_catalog(
                            p,
                            self.local_catalog(p)?
                                .as_array()
                                .map(Vec::as_slice)
                                .unwrap_or(&[]),
                        )?;
                        set_codex_field(
                            &mut managed,
                            "model_catalog_json",
                            value(
                                self.codex_home()
                                    .join("xwx-deck-model-catalog.json")
                                    .to_string_lossy()
                                    .to_string(),
                            ),
                        );
                    }
                }
                if let Some(p) = provider
                    .as_ref()
                    .filter(|p| !p.subscription_account_id.is_empty())
                {
                    set_codex_field(&mut managed, "model_provider", value("xwx_deck"));
                    set_codex_field(&mut managed, "model", value(&p.codex_model));
                    set_codex_provider_field(
                        &mut managed,
                        "xwx_deck",
                        "name",
                        value(&p.display_name),
                    );
                    set_codex_provider_field(
                        &mut managed,
                        "xwx_deck",
                        "wire_api",
                        value("responses"),
                    );
                    set_codex_provider_field(
                        &mut managed,
                        "xwx_deck",
                        "experimental_bearer_token",
                        value("xwx-local-subscription"),
                    );
                }
                set_codex_provider_field(
                    &mut managed,
                    "xwx_deck",
                    "base_url",
                    value(format!("http://127.0.0.1:{port}/v1")),
                );
                if native_auth::owns_auth(&managed, "xwx_deck") {
                    if let Some(table) = managed
                        .get_mut("model_providers")
                        .and_then(|p| p.get_mut("xwx_deck"))
                        .and_then(Item::as_table_like_mut)
                    {
                        for key in ["auth", "http_headers", "env_http_headers"] {
                            table.remove(key);
                        }
                    }
                }
            }
        }
        let managed = managed.to_string();
        let claude = self.claude_managed(port, &claude_path)?;
        let result=write(&self.root.join("gateway-recovery.json"),&json!({"before":before,"managed":managed,"port":port,"codexManaged":codex_managed,"codexOfficial":codex_official,"claude":claude,"claudeConfigPath":claude_path}).to_string()).and_then(|_| {
            if codex_managed {write_checked(&self.config_path(),&before,&managed)?;}
            if let Some((ref before,ref managed))=claude {write_checked(&claude_path,before,managed)?;}
            Ok(())
        });
        if let Err(e) = result {
            if codex_managed {
                let _ = write_checked(&self.config_path(), &managed, &before);
            }
            if let Some((ref before, ref managed)) = claude {
                let _ = write_checked(&claude_path, managed, before);
            }
            return Err(e);
        }
        Ok(ManagedClientRoutes {
            before,
            managed,
            claude,
            codex_managed,
            codex_official,
            claude_path,
        })
    }
    fn restore_gateway_config(&self, g: &Gateway) -> Result<()> {
        self.desktop_preflight()?;
        let claude = g
            .claude
            .as_ref()
            .map(|(before, managed)| -> Result<(String, String)> {
                let source = read(&g.claude_path)?.unwrap_or_default();
                let restored = self.check_claude_restore_source(&source, before, managed)?;
                Ok((
                    source,
                    serde_json::to_string_pretty(&restored).map_err(err)?,
                ))
            })
            .transpose()?;
        let codex = if g.codex_managed {
            let source = read(&self.config_path())?.unwrap_or_default();
            let restored = restore_codex_fields(&source, &g.before, &g.managed, g.codex_official)?;
            Some((source, restored))
        } else {
            None
        };
        self.desktop_restore()?;
        if let Some((source, restored)) = &codex {
            write_checked(&self.config_path(), source, restored)?;
        }
        if let Some((source, restored)) = &claude {
            if let Err(error) = write_checked(&g.claude_path, source, restored) {
                if let Some((source, restored)) = &codex {
                    if write_checked(&self.config_path(), restored, source).is_err() {
                        return Err(format!(
                            "{error}；Codex 又有外部修改，已保留；请确认修复后继续恢复直连"
                        ));
                    }
                }
                return Err(error);
            }
        }
        Ok(())
    }
    async fn publish_routes(&mut self, g: &mut Gateway) -> Result<()> {
        let forwarding = gateway_forwarding::Bindings::capture(self);
        let (provider, claude) = self.prepare_routes(false).await?;
        let config = self.manage_routes(g.port, &provider)?;
        {
            let mut routes = g.routes.write().map_err(err)?;
            routes.forwarding.extend(forwarding);
            routes.switching.configure(&self.settings);
            routes.clients = self.generic_routes();
            routes.provider = provider;
            routes.third_party_tokens = self
                .settings
                .connections
                .iter()
                .map(|p| p.bearer_token.clone())
                .filter(|token| !token.is_empty())
                .collect();
            routes.claude = claude;
        }
        g.before = config.before;
        g.managed = config.managed;
        g.claude = config.claude;
        g.codex_managed = config.codex_managed;
        g.codex_official = config.codex_official;
        g.claude_path = config.claude_path;
        self.desktop_apply(Some(g.port))?;
        Ok(())
    }
    async fn start(&mut self) -> Result<()> {
        if let Some(ref e) = self.recovery_problem {
            return Err(e.clone());
        }
        if self.gateway.is_some() {
            return Ok(());
        }
        let forwarding = gateway_forwarding::Bindings::capture(self);
        let (provider, claude) = self.prepare_routes(true).await?;
        self.store.lock().map_err(err)?.begin_writer()?;
        let result = self.start_gateway(provider, claude, forwarding).await;
        if result.is_err() && self.gateway.is_none() {
            self.store.lock().map_err(err)?.end_writer();
        }
        result
    }
    async fn start_gateway(
        &mut self,
        provider: Option<Provider>,
        claude: Option<Provider>,
        forwarding: gateway_forwarding::Bindings,
    ) -> Result<()> {
        // Isolated acceptance must never receive requests from normal clients.
        // Normal restarts reuse the same endpoint; occupation must be visible.
        let listener = bind_gateway_listener(gateway_listen_port(self.isolated)).await?;
        let port = listener.local_addr().map_err(err)?.port();
        let (cancel, cancelled) = tokio::sync::watch::channel(false);
        let activity = Arc::new(request_activity::Activity::default());
        let route = Route {
            forwarding,
            transport: gateway_transport::client()?,
            local_port: port,
            switching: service_switching::Routing::new(&self.root, &self.settings),
            model_override: None,
            diagnostics: upstream_diagnostics::Log::new(self.log_root()),
            activity: activity.clone(),
            subscriptions: self.subscriptions.clone(),
            provider: provider.clone(),
            third_party_tokens: self
                .settings
                .connections
                .iter()
                .map(|p| p.bearer_token.clone())
                .filter(|token| !token.is_empty())
                .collect(),
            clients: self.generic_routes(),
            claude,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(3))
                .read_timeout(Duration::from_secs(90))
                .build()
                .map_err(err)?,
            count: self.count.clone(),
            store: self.store.clone(),
            root: self.root.clone(),
            cancel: cancelled,
            codex_home: self.codex_home(),
        };
        let routes = Arc::new(std::sync::RwLock::new(route));
        let (shutdown, receive) = oneshot::channel();
        let app = Router::new()
            .route("/v1/responses", any(ingress::forward))
            .route("/responses", any(ingress::forward))
            .route("/v1/messages", any(ingress::forward))
            .route("/anthropic/v1/messages", any(ingress::forward))
            .fallback(ingress::forward)
            .with_state(routes.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = receive.await;
                })
                .await;
        });
        let result = self.manage_routes(port, &provider);
        let ManagedClientRoutes {
            before,
            managed,
            claude,
            codex_managed,
            codex_official,
            claude_path,
        } = match result {
            Ok(config) => config,
            Err(e) => {
                let _ = shutdown.send(());
                task.abort();
                return Err(e);
            }
        };
        {
            let mut store = self.store.lock().map_err(err)?;
            store.active = true;
            let _ = store.events.send("event: reset\ndata: {}\n\n".into());
        }
        self.gateway = Some(Gateway {
            activity,
            routes,
            port,
            shutdown,
            task,
            before,
            managed,
            claude,
            claude_path,
            codex_managed,
            codex_official,
            cancel,
        });
        if let Err(error) = self.apply_client_wiring(port) {
            return match self.stop().await {
                Ok(()) => Err(error),
                Err(restore) => Err(format!("{error}；{restore}")),
            };
        }
        if let Err(e) = self.desktop_apply(Some(port)) {
            eprintln!("Claude Desktop 模型连接刷新失败：{e}");
        }
        Ok(())
    }
    pub async fn stop(&mut self) -> Result<()> {
        self.stop_checked(true).await
    }
    async fn stop_checked(&mut self, force: bool) -> Result<()> {
        let Some(g) = self.gateway.as_ref() else {
            return Ok(());
        };
        g.activity.begin_stop(force)?;
        if let Err(error) = self
            .restore_client_wiring(None)
            .and_then(|_| self.restore_gateway_config(g))
        {
            g.activity.reopen();
            return Err(format!("恢复直连未完成：{error}"));
        }
        let g = self.gateway.take().unwrap();
        {
            let mut store = self.store.lock().map_err(err)?;
            store.active = false;
            let _ = store.events.send("event: reset\ndata: {}\n\n".into());
        }
        let _ = g.cancel.send(true);
        let _ = g.shutdown.send(());
        let mut task = g.task;
        if tokio::time::timeout(Duration::from_secs(15), &mut task)
            .await
            .is_err()
        {
            task.abort();
            let _ = task.await;
        }
        self.store.lock().map_err(err)?.end_writer();
        fs::remove_file(self.root.join("gateway-recovery.json")).map_err(err)?;
        self.desktop_apply(None)?;
        Ok(())
    }
    pub async fn dashboard_url(&mut self) -> Result<String> {
        if let Some(ref dashboard) = self.dashboard {
            return Ok(format!("http://127.0.0.1:{}/", dashboard.port));
        }
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(err)?;
        let port = listener.local_addr().map_err(err)?.port();
        let (stopped, receiver) = tokio::sync::watch::channel(false);
        let app = Router::new()
            .fallback(storage::dashboard)
            .with_state(storage::DashboardState {
                store: self.store.clone(),
                stopped: receiver,
            });
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        self.dashboard = Some(Dashboard {
            port,
            task,
            stopped,
        });
        Ok(format!("http://127.0.0.1:{port}/"))
    }
    pub fn choose_background(&mut self, file: &Path) -> Result<Value> {
        use base64::Engine;
        let bytes = fs::read(file).map_err(err)?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("背景图最大 8 MB".into());
        }
        let kind = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            "image/png"
        } else if bytes.starts_with(b"\xff\xd8\xff") {
            "image/jpeg"
        } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
            "image/webp"
        } else {
            return Err("请选择 PNG、JPEG 或 WebP 图像".into());
        };
        let directory = self.root.join("appearance");
        fs::create_dir_all(&directory).map_err(err)?;
        if !same_physical_path(&directory)? {
            return Err("背景目录不能经过符号链接".into());
        }
        let filename = format!("{}-background", &storage::digest(&bytes)[..24]);
        let path = directory.join(&filename);
        if !path.exists() {
            let mut output = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)
                .map_err(err)?;
            use std::io::Write;
            output.write_all(&bytes).map_err(err)?;
            output.sync_all().map_err(err)?;
        }
        self.settings.trace_appearance["customImageFile"] = json!(filename);
        self.settings.trace_appearance["skin"] = json!("custom");
        self.persist()?;
        let mut state = self.state();
        state["traceAppearance"]["customImageUrl"] = json!(format!(
            "data:{kind};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ));
        Ok(state)
    }
    fn trace_appearance(&self) -> Value {
        use base64::Engine;
        let mut appearance = self.settings.trace_appearance.clone();
        if let Some(name) = appearance["customImageFile"]
            .as_str()
            .filter(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'))
        {
            let path = self.root.join("appearance").join(name);
            if fs::symlink_metadata(&path).is_ok_and(|m| {
                m.is_file() && !m.file_type().is_symlink() && m.len() <= 8 * 1024 * 1024
            }) {
                if let Ok(bytes) = fs::read(path) {
                    let kind = if bytes.starts_with(b"\x89PNG") {
                        "image/png"
                    } else if bytes.starts_with(b"\xff\xd8") {
                        "image/jpeg"
                    } else {
                        "image/webp"
                    };
                    appearance["customImageUrl"] = json!(format!(
                        "data:{kind};base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(bytes)
                    ));
                }
            }
        }
        appearance
    }
    pub fn active(&self) -> bool {
        self.gateway.is_some()
    }
    pub fn release_lock(&mut self) {
        self.dashboard = None;
        self.metadata.shutdown();
        let _ = self.lock.unlock();
    }
    pub async fn call(&mut self, method: &str, args: &[Value]) -> Result<Value> {
        if self.reset_pending {
            return Err("正在重置，请等待应用重新启动".into());
        }
        self.preflight_settings_write(method)?;
        if self.active()
            && [
                "saveProvider",
                "switchClientProvider",
                "updateCodexConfig",
                "updateClaudeModels",
                "updateProviderClientModel",
                "setModelService",
                "updateCompatibleServiceConfig",
                "updateCodexEnhancements",
            ]
            .contains(&method)
        {
            let mut gateway = self.gateway.take().unwrap();
            if let Err(e) = self.restore_gateway_config(&gateway) {
                self.gateway = Some(gateway);
                return Err(e);
            }
            let result = Box::pin(self.call(method, args)).await;
            let resumed = self.publish_routes(&mut gateway).await;
            self.gateway = Some(gateway);
            return match (result, resumed) {
                (Err(e), _) => Err(e),
                (Ok(_), Err(e)) => {
                    Err(format!("选择已保存，Gateway 更新失败，原请求继续运行：{e}"))
                }
                (Ok(value), Ok(())) => {
                    if method == "updateCodexConfig" {
                        self.codex_snapshot()
                    } else if value.get("connections").is_some() {
                        let mut snapshot = self.providers().await;
                        if let Some(warning) = value.get("warning") {
                            snapshot["warning"] = warning.clone();
                        }
                        Ok(snapshot)
                    } else if value.get("readiness").is_some() {
                        Ok(self.state())
                    } else {
                        Ok(value)
                    }
                }
            };
        }
        let input = args.first().cloned().unwrap_or(Value::Null);
        match method {
            "getServiceSwitching" => self.service_switching_snapshot(),
            "setServiceSwitching" => self.set_service_switching(&input),
            "updateProviderClientModel" => self.update_provider_client_model(&input).await,
            "getClientRoute" => self.client_route_snapshot(input.as_str().ok_or("无效客户端")?),
            "setClientRoute" => {
                let id=text(&input,"client");let snapshot=self.client_route_snapshot(id)?;
                if snapshot["configDigest"]!=input["configDigest"] {return Err("客户端配置已变化，请重新检查后重试".into());}
                if snapshot["requiresTakeover"]==true&&input["takeoverConfirmed"]!=true{return Err("请确认接管已有客户端配置".into());}
                let provider_id=text(&input,"providerId");if !self.settings.connections.iter().any(|p|p.id==provider_id){return Err("模型服务不存在".into());}
                let model=text(&input,"model");client_wiring::checked_model(id,model)?;
                let previous=self.settings.clone();
                self.restore_client_wiring(Some(id))?;
                if !self.settings.other.contains_key("clientRoutes"){self.settings.other.insert("clientRoutes".into(),json!({}));}
                self.settings.other.get_mut("clientRoutes").unwrap()[id]=json!({"providerId":provider_id,"model":model,"enabled":snapshot["enabled"],"acceptedDigest":self.client_route_snapshot(id)?["configDigest"]});
                let port=self.gateway.as_ref().map(|g|g.port);
                let result=self.persist().and_then(|_|if let Some(port)=port{self.apply_client_wiring_for(port,Some(id))}else{Ok(())});
                if let Err(error)=result{self.settings=previous;let restored=self.persist().and_then(|_|if let Some(port)=port{self.apply_client_wiring_for(port,Some(id))}else{Ok(())});if let Err(recovery)=restored{self.recovery_problem=Some(recovery);}return Err(error);}
                if let Some(g)=self.gateway.as_ref(){let clients=self.generic_routes();let mut routes=g.routes.write().map_err(err)?;routes.forwarding.add_clients(&clients);routes.clients=clients;}
                self.client_route_snapshot(id)
            }
            "resumeTracing" => {
                let desired=self.settings.other.get("traceDesiredEnabled").and_then(Value::as_bool)
                    .unwrap_or(self.selected().is_some()||self.selected_for("claude").is_some()||!self.generic_routes().is_empty());
                if desired&&!self.active(){self.start().await?;}Ok(self.state())
            }
            "getMetadataState" => Ok(self.metadata.state()),
            "getSubscriptionNotices" => Ok(self.subscriptions.pool.notices()),
            "getSubscriptionAccounts" => Ok(self.subscriptions.snapshot().await),
            "setSubscriptionRouting" => {
                let service=text(&input,"platform");
                let policy:subscription_routing::Policy=serde_json::from_value(input["policy"].clone()).map_err(err)?;
                let snapshot=self.subscriptions.snapshot().await;
                for id in policy.account_order.iter().chain(policy.excluded_account_ids.iter()).chain(if policy.strategy=="fixed" {Some(&policy.fixed_account_id)}else{None}) {
                    let visible=snapshot["accounts"].as_array().is_some_and(|rows|rows.iter().any(|a|a["id"]==*id));
                    // API sign-out hides the row, while its sealed registration and routing metadata remain.
                    let registered=service=="chatgpt" && self.subscriptions.has_registered_api_account(id).await;
                    if subscription_routing::group(id)!=service || (!visible && !registered){return Err("策略中的账号不属于此订阅".into());}
                }
                self.subscriptions.pool.save(service,policy)?;
                Ok(self.subscriptions.snapshot().await)
            }
            "refreshSubscriptionUsage" => {self.subscriptions.refresh_usage(text(&input,"platform")).await?;Ok(self.subscriptions.snapshot().await)} ,
            "beginSubscriptionSignIn" => self.subscriptions.begin_for(text(&input,"platform"), text(&input,"accountId")).await,
            "getConfigurationRemovalImpact" => {
                let providers: Vec<String> = serde_json::from_value(input["providerIds"].clone()).map_err(err)?;
                let accounts: Vec<String> = serde_json::from_value(input.get("accountIds").cloned().unwrap_or(json!([]))).map_err(err)?;
                Ok(json!(self.removal_impact(&providers, &accounts)))
            }
            "removeSubscriptionAccounts" => self.remove_subscription_accounts(&input).await,
            "cancelSubscriptionSignIn" => Ok(self.subscriptions.cancel().await),
            "subscriptionTestAuthorizationUrl" => Ok(json!(self.subscriptions.test_url().await?)),
            "connectSubscriptionAccount" => {
                let id = input.as_str().ok_or("无效订阅账号")?;
                if self.settings.other.get("removedSubscriptionAccounts").and_then(Value::as_array).is_some_and(|rows| rows.iter().any(|row| row["id"] == id)) {
                    let snapshot = self.subscriptions.snapshot().await;
                    if snapshot["flow"]["status"] != "complete" || snapshot["flow"]["accountId"] != id { return Err("此账号已从 Deck 移除，请重新添加或导入".into()); }
                }
                let mut provider = self.subscriptions.provider(input.as_str().ok_or("无效订阅账号")?).await?;
                if !self.codex_native_official(&provider) {native_auth::prepare(&self.subscriptions,&mut provider).await?;}
                self.subscriptions.pool.recovered(&provider.subscription_account_id);
                let before = self.settings.clone();
                if let Some(rows) = self.settings.other.get_mut("removedSubscriptionAccounts").and_then(Value::as_array_mut) { rows.retain(|row| row["id"] != id); }
                if !self.settings.connections.iter().any(|p|p.id==provider.id) { self.settings.connections.push(provider); }
                if let Err(error) = self.persist() { self.settings = before; return Err(error); }
                Ok(self.providers().await)
            }
            "renameSubscriptionAccount" => {
                let id=text(&input,"accountId"); let label=text(&input,"label").trim();
                if label.is_empty() || label.chars().count()>80 || label.chars().any(char::is_control) { return Err("账号名称须为 1–80 个字符".into()); }

                self.subscriptions.rename(id,label).await?;
                if let Some(p)=self.settings.connections.iter_mut().find(|p|p.subscription_account_id==id) { p.display_name=label.into(); self.persist()?; }
                Ok(self.providers().await)
            }
            "signOutSubscriptionAccount" => {
                if imported_subscriptions::is_imported(input.as_str().unwrap_or("")) {return self.remove_imported_account(input.as_str().unwrap());}
                // Clearing one registration must not tear down other accounts' in-flight replies.
                // Already accepted requests own their credential snapshot; new requests observe sign-out.
                self.subscriptions.sign_out_input(&input).await
            }
            "detectClientInstallations" => {
                let discovery = self.client_discovery();
                let catalog: Value = serde_json::from_str(include_str!("../../test-results/native-assets/clients.json")).map_err(err)?;
                Ok(json!({"available":true,"clients":catalog.as_array().into_iter().flatten().map(|client|json!({"id":client["id"],"installed":discovery.installed(text(client,"id")),"modelManagement":client["modelManagement"]==true && discovery.management_supported(text(client,"id")),"installationLocation":self.settings.other.get("clientInstallationLocations").and_then(|locations|locations.get(client_installations::canonical_id(text(client,"id"))))})).collect::<Vec<_>>()}))
            }
            "getModelClients" => Ok(json!(self.model_clients())),
            "inspectClientInstallation" => {
                let id = text(&input,"client");
                let path = self.inspect_client_installation(id, text(&input,"location"))?;
                Ok(json!({"location":path,"installed":true,"modelManagement":true}))
            }
            "addModelClient" | "removeModelClient" => {
                let id = input.as_str().ok_or("无效客户端")?;
                let catalog: Value = serde_json::from_str(include_str!("../../test-results/native-assets/clients.json")).map_err(err)?;
                if !catalog.as_array().is_some_and(|rows|rows.iter().any(|row|row["id"]==id)) { return Err("未知客户端".into()); }
                let id = client_installations::canonical_id(id);
                // Explicit null restores automatic discovery; omitted retains the saved choice.
                let restore_detection = method == "addModelClient" && args.get(1).is_some_and(Value::is_null);
                let location = if method == "addModelClient" {
                    args.get(1).and_then(Value::as_str).map(|path| self.inspect_client_installation(id,path)).transpose()?
                } else { None };
                let active_installation = self.root.join(format!("client-wiring-{id}.json")).exists()
                    || (self.gateway.is_some() && ((self.client_enabled(id) && self.client_configured(id))
                        || self.settings.other.get("clientRoutes").and_then(|routes|routes.get(id)).is_some_and(|route|route["enabled"]!=false && !text(route,"providerId").is_empty())));
                if (location.is_some() || restore_detection) && active_installation {
                    return Err("请先停止此客户端的追踪，再更改安装位置".into());
                }
                let mut clients = self.model_clients();
                if method == "removeModelClient" {
                    if ingress::valid_client(id)&&self.settings.other.get("clientRoutes").and_then(|r|r.get(id)).is_some_and(|r|r["enabled"]!=false){Box::pin(self.call("toggleClient",&[json!(id)])).await?;}
                    clients.retain(|client|client!=id);
                }
                else if !clients.iter().any(|client|client==id) {
                    if !catalog.as_array().is_some_and(|rows|rows.iter().any(|row|row["id"]==id && row["modelManagement"]==true)) { return Err("暂不支持此客户端的模型配置".into()); }
                    if location.is_none() && !self.client_discovery().installed(id) { return Err("未检测到客户端安装，请先安装、手动选择安装位置或重新检测".into()); }
                    if location.is_none() && !self.client_discovery().management_supported(id) { return Err("当前客户端版本不支持模型配置，请更新后重试".into()); }
                    clients.push(id.to_owned());
                }
                let value=json!(clients);
                let before = self.settings.other.insert("modelClients".into(), value.clone());
                let version_before = self.settings.other.insert("modelClientsVersion".into(),json!(2));
                let locations_before = self.settings.other.get("clientInstallationLocations").cloned();
                if location.is_some() || restore_detection {
                    let mut locations = locations_before.clone().unwrap_or(json!({}));
                    if !locations.is_object() {
                        // Preserve unreadable externally supplied state instead of discarding it.
                        if let Some(old)=before {self.settings.other.insert("modelClients".into(),old);} else {self.settings.other.remove("modelClients");}
                        if let Some(old)=version_before {self.settings.other.insert("modelClientsVersion".into(),old);} else {self.settings.other.remove("modelClientsVersion");}
                        return Err("客户端安装位置记录已变化，请检查设置后重试".into());
                    }
                    if let Some(location) = location { locations[id] = json!(location); }
                    else { locations.as_object_mut().unwrap().remove(id); }
                    self.settings.other.insert("clientInstallationLocations".into(),locations);
                }
                if let Err(error)=self.persist() {
                    if let Some(old)=before { self.settings.other.insert("modelClients".into(),old); } else { self.settings.other.remove("modelClients"); }
                    if let Some(old)=version_before { self.settings.other.insert("modelClientsVersion".into(),old); } else { self.settings.other.remove("modelClientsVersion"); }
                    if let Some(old)=locations_before {self.settings.other.insert("clientInstallationLocations".into(),old);} else {self.settings.other.remove("clientInstallationLocations");}
                    return Err(error);
                }
                Ok(value)
            }
            "getState" | "refresh" => Ok(self.state()),
            "getProviders" => Ok(self.providers().await),
            "previewConfigurationImport" => self.preview_import(&input).await,
            "importConfigurations" => self.apply_import(&input).await,
            "repairUnreadableSettings" => {
                let source = read(&self.root.join("settings.json"))?.ok_or("设置文件不存在")?;
                let backup = self.root.join(format!("settings-backup-{}.json", millis()));
                write(&backup, &source)?;
                let settings = Settings::default();
                let updated = Self::settings_document(&settings)?;
                write_checked(&self.root.join("settings.json"), &source, &updated)?;
                self.settings = settings;
                self.settings_problem = None;
                *self.settings_source.lock().map_err(err)? = Some(updated);
                Ok(json!({"backupPath":backup,"lostProviderSettings":true}))
            }
            "repairInvalidCodexConfiguration" => {
                if self.active() {
                    return Err("请先停止 Trace 再修复配置".into());
                }
                let source = read(&self.config_path())?.ok_or("配置不存在")?;
                if doc(&source).is_ok() {
                    return Err("配置可正常读取，无需破坏性修复".into());
                }
                let backup = self
                    .root
                    .join(format!("codex/config-backup-{}.toml", millis()));
                write(&backup, &source)?;
                write_checked(&self.config_path(), &source, "")?;
                self.write_direct(false)?;
                Ok(
                    json!({"backupPath":backup,"mode":if self.selected().is_some(){"compatible"}else{"official"},"conflicts":[]}),
                )
            }
            "repairClientProviderSwitch" => {
                let mut request = input.clone();
                let client = text(&input, "client");
                if !["codex", "claude"].contains(&client) { return Err("此客户端不需要修复配置".into()); }
                if input.get("providerId").is_none() {
                    request["providerId"] = if self.settings.other.get(&format!("{client}PreferredMode")) == Some(&json!("official")) { Value::Null } else { self.settings.selected[client].clone() };
                }
                if !request["providerId"].is_null()
                    && !request["providerId"].as_str().is_some_and(|id| self.settings.connections.iter().any(|provider| provider.id == id)) {
                    return Err("连接不存在，配置未修改".into());
                }
                let repaired = self.repair_active_client(client)?;
                if self.active() && request["providerId"] == self.settings.selected[client] {
                    if !repaired {
                        if client == "codex" && self.config_path().exists() { self.write_direct(true)?; }
                        else if client == "claude" && self.claude_path().exists() { self.write_claude_direct(true)?; }
                    }
                    return Ok(self.providers().await);
                }
                request["takeOverExternalConfig"] = json!(true);
                Box::pin(self.call("switchClientProvider", &[request])).await
            }
            "getDashboardUrl" => Ok(json!(self.dashboard_url().await?)),
            "getTraceStats" => Ok(self.store.lock().map_err(err)?.stats()),
            "inspectTraceIndexRepair" => self.store.lock().map_err(err)?.inspect_repair(),
            "applyTraceIndexRepair" => {
                if self.active() {
                    return Err("请先关闭 Trace 再手动修复索引".into());
                }
                self.store.lock().map_err(err)?.apply_repair(input.as_str())
            }
            "clearHistory" => {
                if self.active() {
                    return Err("请先停止 Trace 再手动删除记录".into());
                }
                self.store.lock().map_err(err)?.clear()?;
                Ok(self.state())
            }
            "clearTraceBackground" => {
                self.settings.trace_appearance["customImageFile"] = json!("");
                self.settings.trace_appearance["skin"] = json!("classic");
                self.persist()?;
                Ok(self.state())
            }
            "getUpdateState" => Ok(self.update_state()),
            "checkForUpdates"=>self.updates.check().await,
            "checkForAutomaticUpdates"=>{
                let state = self.updates.state();
                if state["status"] != "idle" { Ok(state) }
                else { self.updates.check().await }
            },
            "downloadAutomaticUpdate"=>{
                let state = self.updates.state();
                if !self.nightly_eligible() || state["status"] != "available" { Ok(state) }
                else { self.updates.download() }
            },
            "downloadUpdate"=>self.updates.download(),
            "cancelUpdate"=>self.updates.cancel(),
            "restartAndInstall" => {
                // Validate the immutable release before changing a working route.
                let path = self.updates.installer().await?;
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                self.stop_checked(false).await?;
                let mut update = self.updates.state();
                update["path"] = json!(path);
                Ok(update)
            },
            "repairApplication"=>Err("快速修复必须由共享修复流程发起".into()),
            "resetApplication"=>{
                if !self.isolated || !std::env::args().any(|arg|arg=="--rpc") {return Err("重置必须由原生主窗口发起".into());}
                let reset_clients=input["resetClientConfigs"].as_bool().ok_or("无效重置选项")?;
                let job=self.prepare_reset(reset_clients).await?;
                self.launch_reset(job).await
            }
            "getApplicationResetResult"=>{
                let source=read(&self.root.join("application-reset-result.json"))?;
                source.map(|source|serde_json::from_str::<Value>(&source).map_err(err)).transpose().map(|value|value.unwrap_or(Value::Null))
            }
            "ackApplicationResetResult"=>{
                let path=self.root.join("application-reset-result.json");let before=read(&path)?;
                let mut result:Value=serde_json::from_str(before.as_deref().ok_or("重置结果不存在")?).map_err(err)?;
                if input["atMs"]!=result["atMs"] {return Err("重置结果已变化，请重新查看".into());}
                result["noticeSeen"]=json!(true);write_checked(&path,before.as_deref().ok_or("重置结果不存在")?,&result.to_string())?;Ok(Value::Null)
            }
            "isChatGptRunning"=>{
                if self.isolated{return Ok(json!(false));}
                #[cfg(unix)]{let output=std::process::Command::new("/bin/ps").args(["-A","-o","comm="]).output().map_err(err)?;let running=String::from_utf8_lossy(&output.stdout).lines().any(|line|line.ends_with("/Codex")||line.ends_with("/ChatGPT"));Ok(json!(running))}
                #[cfg(not(unix))]{
                    let mut command=std::process::Command::new("tasklist.exe");
                    command.args(["/FO","CSV","/NH"]);
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        command.creation_flags(0x08000000);
                    }
                    let output=command.output().map_err(err)?;
                    Ok(json!(String::from_utf8_lossy(&output.stdout).lines().any(|line|line.to_lowercase().starts_with("\"codex.exe\"")||line.to_lowercase().starts_with("\"chatgpt.exe\""))))
                }
            },
            "setStartupEnabled"=>{let enabled=input.as_bool().ok_or("无效启动设置")?;if self.isolated{return Err("隔离验证不注册系统登录项".into());}self.settings.startup_enabled=enabled;self.persist()?;Ok(self.state())},
            "updateTraceDirectories" => self.update_directories(&input),
            "setModelService" => {
                let client=text(&input,"client");if !["codex","claude"].contains(&client){return Err("无效客户端".into());}
                let id=if input["enabled"]==true {self.settings.selected[client].as_str().ok_or("请先保存并选择连接")?.to_string()}else{String::new()};
                Box::pin(self.call("switchClientProvider",&[json!({"client":client,"providerId":if id.is_empty(){Value::Null}else{json!(id)}})])).await?;
                Box::pin(self.call("getModelServices",&[])).await
            }
            "updateCompatibleServiceConfig" => {
                let selected=self.selected().ok_or("请先保存并选择连接")?;
                let mut update=serde_json::to_value(selected).map_err(err)?;
                for (key,value) in input.as_object().ok_or("无效连接设置")?{update[key]=value.clone();}
                if let Some(format)=input["codexApiFormat"].as_str(){update["adapter"]=json!(format);}
                Box::pin(self.call("saveProvider",&[update])).await?;
                Box::pin(self.call("getCompatibleServiceConfig",&[])).await
            }
            "getClaudeModels" => Ok(self.claude_models()),
            "getClaudeDesktopSync" => self.desktop_snapshot(),
            "updateClaudeDesktopSync"=>{
                let enabled=input.as_bool().ok_or("无效开关")?;
                self.settings.claude_desktop["syncEnabled"]=json!(enabled);self.persist()?;
                let outcome=if enabled{self.desktop_apply(self.gateway.as_ref().map(|g|g.port))}else{self.desktop_restore()};
                if let Err(ref error)=outcome {self.settings.claude_desktop["syncWarning"]=json!(error);}
                else if let Some(options)=self.settings.claude_desktop.as_object_mut(){options.remove("syncWarning");}
                self.persist()?;
                let mut snapshot=self.desktop_snapshot().unwrap_or_else(|_|json!({"enabled":enabled,"supported":cfg!(any(target_os="macos",target_os="windows")),"active":false,"modelCount":0}));
                if let Err(error)=outcome {snapshot["warning"]=json!(error);snapshot["detail"]=snapshot["warning"].clone();}
                Ok(snapshot)
            },
            "getCodexConfig" => self.codex_snapshot(),
            "getCodexEnhancements" => Ok(
                json!({"preserveOfficialLogin":self.settings.codex_enhancements["preserveOfficialLogin"],"authMode":self.auth_mode(),"unifySessionHistory":self.settings.codex_enhancements["unifySessionHistory"],"historyRestorePending":self.settings.codex_enhancements["pendingHistoryRestore"],"hasHistoryBackup":self.root.join("history-ledger.json").exists()}),
            ),
            "updateCodexEnhancements"=>{
                let mut changed=false;
                for key in ["preserveOfficialLogin","unifySessionHistory"]{if let Some(v)=input.get(key){if !v.is_boolean(){return Err("无效增强设置".into());}self.settings.codex_enhancements[key]=v.clone();changed=true;}}
                if !changed{return Err("无效增强设置".into());}self.persist()?;
                self.write_direct(false)?;
                let outcome=if input["unifySessionHistory"]==true&&input["migrateExisting"]==true {Some(self.history_update(false)?)}else if input["unifySessionHistory"]==false&&input["restoreExisting"]==true{Some(self.history_update(true)?)}else{None};
                let mut snapshot=Box::pin(self.call("getCodexEnhancements",&[])).await?;if let Some(outcome)=outcome{snapshot["history"]=outcome;}Ok(snapshot)
            }
            "getCompatibleServiceConfig" => Ok(
                self.selected().map(|p|json!({"displayName":p.display_name,"providerPreset":p.provider_preset,"baseUrl":p.base_url,"bearerToken":p.bearer_token,"codexApiFormat":p.codex_api_format})).unwrap_or_else(||json!({"displayName":"自定义连接","providerPreset":"custom","baseUrl":"","bearerToken":"","codexApiFormat":"responses"})),
            ),
            "getModelServices" => Ok(
                json!({"claude":self.selected_for("claude").is_some(),"codex":self.selected().is_some(),"claudeStatus":self.claude_service()?}),
            ),
            "getClaudeEnvironmentOverrides" => Ok(self.env_overrides()),
            "clearClaudeEnvironmentOverrides" => {
                Err("进程环境变量需要在启动来源中移除并重启客户端；未修改系统环境".into())
            }
            "validateProvider" => {
                let model = match input.get("model") {
                    None => None,
                    Some(Value::String(value)) if !value.trim().is_empty() && value.len() <= 512 => Some(value.trim()),
                    _ => return Err("无效模型名称".into()),
                };
                self.validate(text(&input, "providerId"), model).await
            },
            "updateClaudeModels" => {
                if input.get("expectedProviderId").is_some()
                    && input["expectedProviderId"] != self.settings.selected["claude"]
                {
                    return Err("连接已变化，保留当前选择".into());
                }
                if self.active() {
                    return Err("修改模型前请先停止 Trace".into());
                }
                let mut models = self.claude_models();
                for role in ["fable", "opus", "sonnet", "haiku"] {
                    if let Some(v) = input.get(role) {
                        if !v.is_string() {
                            return Err("无效模型".into());
                        }
                        models[role] = v.clone();
                    }
                }
                if let Some(id) = self.settings.selected["claude"].as_str() {
                    let p = self
                        .settings
                        .connections
                        .iter_mut()
                        .find(|p| p.id == id)
                        .ok_or("连接不存在")?;
                    p.claude_models = models.clone();
                } else {
                    self.settings.claude_models = models.clone();
                }
                self.persist()?;
                self.write_claude_direct(false)?;
                self.refresh_desktop_selection()?;
                Ok(models)
            }
            "toggleClient" => {
                if let Some(id)=input.as_str().filter(|id|ingress::valid_client(id)) {
                    let previous=self.settings.clone();
                    let routes=self.settings.other.get_mut("clientRoutes").and_then(Value::as_object_mut).ok_or("客户端未配置")?;
                    let route=routes.get_mut(id).ok_or("客户端未配置")?;let enabled=route["enabled"]==false;
                    if !enabled{self.restore_client_wiring(Some(id))?;}
                    self.settings.other.get_mut("clientRoutes").unwrap()[id]["enabled"]=json!(enabled);
                    let port=self.gateway.as_ref().map(|g|g.port);
                    let result=self.persist().and_then(|_|if enabled{if let Some(port)=port{self.apply_client_wiring_for(port,Some(id))}else{Ok(())}}else{Ok(())});
                    if let Err(error)=result{self.settings=previous;let restored=self.persist().and_then(|_|if let Some(port)=port{self.apply_client_wiring_for(port,Some(id))}else{Ok(())});if let Err(recovery)=restored{self.recovery_problem=Some(recovery);}return Err(error);}
                    if let Some(g)=self.gateway.as_ref(){let clients=self.generic_routes();let mut routes=g.routes.write().map_err(err)?;routes.forwarding.add_clients(&clients);routes.clients=clients;}return Ok(self.state());
                }
                let client = match input.as_str() {
                    Some("claude-cli") => "claude",
                    Some("codex-cli") => "codex",
                    _ => return Err("无效客户端".into()),
                };
                let was_active = self.active();
                if was_active {
                    self.stop().await?;
                }
                self.settings.client_enabled[client] = json!(!self.client_enabled(client));
                self.persist()?;
                if was_active {
                    self.start().await?;
                }
                Ok(self.state())
            }
            "disableBreaksCodex" => Ok(json!(self.client_enabled("codex") && self.selected().is_some_and(|p|self.needs_gateway(p,"codex")))),
            "saveProvider" => {
                if self.active() {
                    return Err("修改连接前请先停止 Trace".into());
                }
                let name = text(&input, "displayName");
                if name.trim().is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
                    return Err("名称需为 1–80 个字符，不能包含控制字符".into());
                }
                let base = text(&input, "baseUrl").trim_end_matches('/');
                let url = reqwest::Url::parse(base).map_err(err)?;
                if !["http", "https"].contains(&url.scheme())
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some()
                {
                    return Err("无效的 API 地址".into());
                }
                let adapter = text(&input, "adapter");
                if ![
                    "responses",
                    "auto",
                    "chat-completions",
                    "anthropic-messages",
                ]
                .contains(&adapter)
                {
                    return Err("无效协议".into());
                }
                // A new connection must never reuse a renamed connection's identity.
                let supplied_id = text(&input, "id");
                let id = if supplied_id.is_empty() {
                    let stem = if name.bytes().all(|c|c.is_ascii_alphanumeric() || c==b'_' || c==b'-') && !["openai","xwx_deck"].contains(&name.to_lowercase().as_str()) {name.to_string()} else {format!("provider-{}",&storage::digest(name.as_bytes())[..12])};
                    let mut candidate = stem.clone();
                    let mut suffix = 2;
                    while self.settings.connections.iter().any(|p| p.id == candidate) {
                        candidate = format!("{}-{}", stem, suffix);
                        suffix += 1;
                    }
                    candidate
                } else {
                    supplied_id.to_string()
                };
                let old = self.settings.connections.iter().find(|p| p.id == id);
                if old.is_some_and(|p| !p.subscription_account_id.is_empty()) { return Err("订阅账号请在订阅账号页面管理".into()); }
                let provider = Provider {
                    other: old.map(|p|p.other.clone()).unwrap_or_default(),
                    subscription_account_id: String::new(),
                    account_label: String::new(),
                    official: false,
                    oauth: false,
                    id: id.clone(),
                    codex_provider_id: old.map(|p|p.codex_provider_id.clone()).filter(|id|!id.is_empty()).unwrap_or_else(||id.clone()),
                    display_name: name.into(),
                    provider_preset: input["providerPreset"].as_str().unwrap_or("custom").into(),
                    base_url: base.into(),
                    bearer_token: text(&input, "bearerToken").into(),
                    adapter: adapter.into(),
                    codex_api_format: input["codexApiFormat"].as_str().filter(|v|["responses","chat-completions","anthropic-messages"].contains(v)).unwrap_or_else(||if adapter=="auto"{old.map(|p|p.codex_api_format.as_str()).filter(|s|!s.is_empty()).unwrap_or("responses")}else{adapter}).into(),
                    codex_model: input
                        .get("codexModel")
                        .and_then(Value::as_str)
                        .unwrap_or_else(|| old.map(|p| p.codex_model.as_str()).unwrap_or(""))
                        .into(),
                    codex_context_window: old.map(|p| p.codex_context_window).unwrap_or(0),
                    claude_models: old
                        .map(|p| p.claude_models.clone())
                        .unwrap_or_else(|| json!({"fable":"","opus":"","sonnet":"","haiku":""})),
                };
                if let Some(index) = self.settings.connections.iter().position(|p| p.id == id) {
                    self.settings.connections[index] = provider;
                } else {
                    self.settings.connections.push(provider);
                }
                self.persist()?;
                if self.settings.selected["claude"]==id {self.write_claude_direct(false)?;self.refresh_desktop_selection()?;}
                Ok(self.providers().await)
            }
            "switchClientProvider" => {
                let client = text(&input, "client");
                if !["codex", "claude"].contains(&client) {
                    return Err("无效客户端".into());
                }
                if self.active() {
                    return Err("切换连接前请先停止 Trace".into());
                }
                let selected = input.get("providerId").cloned().unwrap_or(Value::Null);
                if !selected.is_null()
                    && !self
                        .settings
                        .connections
                        .iter()
                        .any(|p| Some(p.id.as_str()) == selected.as_str())
                {
                    return Err("连接不存在".into());
                }
                if !selected.is_null() {
                    let remembered=self.settings.other.entry("rememberedProviderIds").or_insert_with(||json!({}));remembered[client]=selected.clone();
                }
                self.settings.other.insert(format!("{client}PreferredMode"),json!(if selected.is_null(){"official"}else{"compatible"}));
                self.settings.selected[client] = selected;
                self.persist()?;
                if client=="codex" {self.prepare_native_auth().await?;}
                let takeover = input["takeOverExternalConfig"].as_bool().unwrap_or(false);
                let old_alias = if client == "codex" {
                    provider_field(&self.config()?, "xwx_deck", "base_url").and_then(Item::as_str).map(str::to_string)
                } else { None };
                let old_auth = if client == "codex" {provider_field(&self.config()?, "xwx_deck", "auth").map(ToString::to_string)} else {None};
                if client == "codex" {
                    self.write_direct(takeover)?;
                } else if client == "claude" {
                    self.write_claude_direct(takeover)?;
                    self.refresh_desktop_selection()?;
                }
                let mut snapshot = self.providers().await;
                if snapshot["warning"].is_null()
                    && self
                        .selected_for(client)
                        .is_some_and(|p| self.needs_gateway(p, client))
                    && !self.active()
                {
                    snapshot["warning"] =
                        json!("选择已保存，需要开启 Trace 后用于客户端请求。");
                }
                if let Some(old) = old_alias {
                    let current_config = self.config()?;
                    let changed_auth = self.settings.other.get("traceDesiredEnabled") != Some(&json!(true))
                        && provider_field(&current_config, "xwx_deck", "auth").map(ToString::to_string) != old_auth;
                    if changed_auth || provider_field(&current_config, "xwx_deck", "base_url").and_then(Item::as_str) != Some(old.as_str()) {
                        snapshot["warning"] = json!("旧会话连接已更新。请等待当前回答结束后重启 Codex，再打开原会话继续。");
                    }
                }
                Ok(snapshot)
            }
            "updateCodexConfig" => {
                if self.active() {
                    return Err("修改模型前请先停止 Trace".into());
                }
                if input.get("expectedProviderId").is_some()
                    && input["expectedProviderId"] != self.settings.selected["codex"]
                {
                    return Err("连接已变化，保留当前选择".into());
                }
                if let Some(id) = self.settings.selected["codex"].as_str() {
                    let p = self
                        .settings
                        .connections
                        .iter_mut()
                        .find(|p| p.id == id)
                        .ok_or("连接不存在")?;
                    if let Some(model) = input["compatibleModel"].as_str() {
                        p.codex_model = model.into();
                    }
                    if let Some(window) = input.get("modelContextWindow") {
                        p.codex_context_window = if window.is_null() { 0 } else { window.as_u64().ok_or("无效上下文长度")? };
                    }
                    self.persist()?;
                    self.prepare_native_auth().await?;
                    self.write_direct(false)?;
                } else {
                    let source = read(&self.config_path())?.unwrap_or_default();
                    let mut d = doc(&source)?;
                    if let Some(model)=input["officialModel"].as_str(){self.settings.codex_models["official"]=json!(model);set_codex_field(&mut d,"model",value(model));}
                    if let Some(window)=input.get("modelContextWindow"){let window=if window.is_null(){0}else{window.as_u64().ok_or("无效上下文长度")?};self.settings.codex_models["officialContextWindow"]=json!(window);if window>0{d["model_context_window"]=value(window as i64);}else{d.remove("model_context_window");}}
                    self.persist()?;
                    write_checked(&self.config_path(), &source, &d.to_string())?;
                }
                let mut snapshot = self.codex_snapshot()?;
                if self.selected().is_some_and(|p| self.needs_gateway(p, "codex")) {
                    snapshot["warning"] = json!("模型选择已保存，需要开启 Trace 后用于客户端请求。");
                }
                Ok(snapshot)
            }
            "deleteProvider" => {
                let id = input.as_str().ok_or("无效连接")?;
                let impact = self.removal_impact(&[id.to_string()], &[]);
                if !impact.is_empty() { return Err(format!("请先在模型页切换以下客户端，再移除配置：{}", impact.join("、"))); }
                let before = self.settings.clone();
                self.prune_removed_connections(&[id.to_string()]);
                if let Err(error) = self.persist() { self.settings = before; return Err(error); }
                self.refresh_removal_routes();
                Ok(self.providers().await)
            }
            "fetchProviderModels" | "fetchModels" => {
                let provider = if method == "fetchProviderModels" {
                    self.settings
                        .connections
                        .iter()
                        .find(|p| p.id == text(&input, "providerId"))
                } else {
                    self.selected()
                };
                if method == "fetchModels" && input.get("expectedProviderId").is_some() && input["expectedProviderId"] != self.settings.selected["codex"] { return Err("连接已切换，请重新加载模型目录".into()); }
                let Some(provider) = provider else {return self.official_catalog(input["refresh"]==true).await;};
                if provider.subscription_account_id.is_empty() {self.connection_catalog(provider,input["refresh"]==true).await} else {self.catalog(provider).await}
            }
            "setAutomaticUpdates" => {
                let enabled = input.as_bool().ok_or("无效更新设置")?;
                let before = self.settings.automatic_updates;
                self.settings.automatic_updates = enabled;
                if let Err(error) = self.persist() { self.settings.automatic_updates = before; return Err(error); }
                Ok(self.state())
            }
            "setLanguage" => {
                let language = input.as_str().ok_or("无效语言")?;
                if !crate::language::is_supported(language) { return Err("无效语言".into()); }
                let before = self.settings.language.clone();
                self.settings.language = Some(language.into());
                if let Err(error) = self.persist() { self.settings.language = before; return Err(error); }
                let mut store = self.store.lock().map_err(err)?;
                store.language = language.into();
                let _ = store.events.send(format!("event: theme\ndata: {}\n\n", json!({"theme":store.theme,"language":store.language})));
                drop(store);
                Ok(self.state())
            }
            "setTheme" => {
                let theme = input.as_str().ok_or("无效主题")?;
                if !["day", "night", "system"].contains(&theme) {
                    return Err("无效主题".into());
                }
                self.settings.theme = theme.into();
                self.persist()?;
                let mut store = self.store.lock().map_err(err)?;
                store.theme = theme.into();
                let _ = store.events.send(format!("event: theme\ndata: {}\n\n", json!({"theme":theme})));
                drop(store);
                Ok(self.state())
            }
            "setTraceAppearance" => {
                for key in [
                    "skin",
                    "showThroughput",
                    "customImageFit",
                    "customImageOverlay",
                ] {
                    if let Some(v) = input.get(key) {
                        self.settings.trace_appearance[key] = v.clone();
                    }
                }
                self.persist()?;
                Ok(self.state())
            }
            "setTraceStoragePolicy" => {
                if input.get("clearUsage").is_some_and(|v| !v.is_boolean()) {
                    return Err("无效的用量清理选项".into());
                }
                if input["clearUsage"] == true && input["limitGB"].as_f64() != Some(0.0) {
                    return Err("仅在明确切换为 0 GB 时可同时清空用量".into());
                }
                if let Some(limit) = input["limitGB"].as_f64() {
                    if !limit.is_finite() || limit < 0.0 {
                        return Err("无效容量".into());
                    }
                    self.settings.trace_warning_gb = limit;
                }
                if let Some(auto) = input["autoCleanup"].as_bool() {
                    self.settings.trace_auto_cleanup = auto;
                }
                self.persist()?;
                {
                    let mut store = self.store.lock().map_err(err)?;
                    store.set_retention((self.settings.trace_warning_gb * 1024.0f64.powi(3)) as u64, self.settings.trace_auto_cleanup);
                    if input["clearUsage"] == true { store.reset_usage()?; }
                }
                Ok(self.state())
            }
            "toggleTracing" => {
                let desired=input.as_bool().unwrap_or(!self.active());
                if desired {
                    self.check_settings_source()?;
                    self.start().await?;
                } else {
                    self.stop_checked(args.get(1).and_then(Value::as_bool).unwrap_or(false)).await?;
                }
                self.settings.other.insert("traceDesiredEnabled".into(),json!(desired));self.persist()?;
                Ok(self.state())
            }
            _ => Err(format!(
                "当前原生版本不支持操作 {method}"
            )),
        }
    }
}

async fn forward_request(
    State(routes): State<Arc<std::sync::RwLock<Route>>>,
    request: Request,
) -> Response {
    let route = match routes.read() {
        Ok(r) => r.clone(),
        Err(_) => return protocol_error(503, "responses", "路由暂不可用，请重试"),
    };
    service_switching::forward(route, routes, request).await
}
async fn forward_subscription(
    route: Route,
    routes: Arc<std::sync::RwLock<Route>>,
    request: Request,
) -> Response {
    if request.headers().contains_key("upgrade") {
        return forward_once(route, routes, request).await;
    }
    let request = match request_encoding::decode(request).await {
        Ok(request) => request,
        Err((status, message)) => return protocol_error(status, "responses", &message),
    };
    let is_claude = request.uri().path().ends_with("/messages")
        || request.uri().path().starts_with("/claude-desktop/");
    let provider = if is_claude {
        route.claude.as_ref()
    } else {
        route.provider.as_ref()
    };
    let Some(provider) = provider.filter(|p| !p.subscription_account_id.is_empty()) else {
        return forward_once(route, routes, request).await;
    };
    let preferred = provider.subscription_account_id.clone();
    let (parts, body) = request.into_parts();
    let body = match to_bytes(body, 16 * 1024 * 1024).await {
        Ok(body) => body,
        Err(_) => return protocol_error(413, "responses", "请求过大"),
    };
    let payload = serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null);
    let session = conversation_identity::session(&parts.headers, &payload, !is_claude)
        .or_else(|| payload["metadata"]["user_id"].as_str().map(str::to_owned))
        .unwrap_or_else(|| {
            payload["previous_response_id"]
                .as_str()
                .map(|id| format!("response:{id}"))
                .unwrap_or_default()
        });
    let session = parts
        .extensions
        .get::<ingress::Origin>()
        .map(|o| format!("{}:{session}", o.client))
        .unwrap_or(session);
    let claude_model;
    let model = if is_claude {
        claude_model = desktop::request_model(
            &route.root,
            provider,
            text(&payload, "model"),
            parts.uri.path().starts_with("/claude-desktop/"),
        );
        claude_model.as_str()
    } else {
        payload["model"].as_str().unwrap_or(&provider.codex_model)
    };
    let model = route.model_override.as_deref().unwrap_or(model);
    let service = subscription_routing::group(&preferred);
    if route.subscriptions.pool.refresh_due(service) {
        let subscriptions = route.subscriptions.clone();
        tokio::spawn(async move {
            let _ = subscriptions.refresh_usage(service).await;
        });
    }
    let accounts = route.subscriptions.snapshot().await;
    let mut attempted = std::collections::HashSet::new();
    let mut previous = None;
    loop {
        let lease = match route
            .subscriptions
            .pool
            .choose(&preferred, &accounts, &session, model, &attempted)
        {
            Ok(lease) => lease,
            Err(error) => {
                return previous.unwrap_or_else(|| {
                    protocol_error(
                        503,
                        if is_claude {
                            "anthropic-messages"
                        } else {
                            "responses"
                        },
                        &error,
                    )
                })
            }
        };
        attempted.insert(lease.id.clone());
        let mut attempt = route.clone();
        let mut selected = match route.subscriptions.provider(&lease.id).await {
            Ok(p) => p,
            Err(error) => return protocol_error(401, "responses", &error),
        };
        selected.codex_model = provider.codex_model.clone();
        selected.claude_models = provider.claude_models.clone();
        if is_claude {
            attempt.claude = Some(selected);
        } else {
            attempt.provider = Some(selected);
        }
        if let Err(error) = route.subscriptions.credential(&lease.id).await {
            let latest = route.subscriptions.snapshot().await;
            if latest["accounts"].as_array().is_some_and(|rows| {
                rows.iter()
                    .any(|a| a["id"] == lease.id && a["status"] == "signed-out")
            }) {
                route
                    .subscriptions
                    .pool
                    .reject(&lease.id, 401, &axum::http::HeaderMap::new(), b"");
                previous = Some(protocol_error(401, "responses", &error));
                continue;
            }
            return protocol_error(503, "responses", &error);
        }
        let request = Request::from_parts(parts.clone(), Body::from(body.clone()));
        let response = forward_once(attempt, routes.clone(), request).await;
        let status = response.status().as_u16();
        if [400, 401, 403, 404, 429].contains(&status) {
            let (response_parts, response_body) = response.into_parts();
            let error_body = match to_bytes(response_body, 1024 * 1024).await {
                Ok(body) => body,
                Err(_) => return protocol_error(status, "responses", "订阅请求被拒绝"),
            };
            let retry = route.subscriptions.pool.reject(
                &lease.id,
                status,
                &response_parts.headers,
                &error_body,
            ) || route
                .subscriptions
                .pool
                .reject_model(&lease.id, model, &error_body);
            previous = Some(Response::from_parts(response_parts, Body::from(error_body)));
            if retry {
                continue;
            }
            return previous.unwrap();
        }
        if response.status().is_success() {
            route
                .subscriptions
                .pool
                .switched(&preferred, &lease.id, &accounts);
        }
        let (response_parts, response_body) = response.into_parts();
        let pool = route.subscriptions.pool.clone();
        let sse = response_parts
            .headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|s| s.contains("text/event-stream"));
        let stream = async_stream::stream! {
            let lease=lease;let mut pending=Vec::new();let mut upstream=response_body.into_data_stream();use futures_util::StreamExt;
            while let Some(chunk)=upstream.next().await {
                if let Ok(bytes)=&chunk {
                    if pending.len()+bytes.len()<=256*1024 {pending.extend_from_slice(bytes);}else{pending.clear();}
                    if sse {while let Some(end)=pending.windows(2).position(|pair|pair==b"\n\n") {
                        let event:Vec<_>=pending.drain(..end+2).collect();
                        for line in event.split(|byte|*byte==b'\n') {if let Some(data)=line.strip_prefix(b"data: "){pool.observe(&lease.id,data);}}
                    }}else{pool.observe(&lease.id,&pending);}
                }
                yield chunk;
            }
        };
        return Response::from_parts(response_parts, Body::from_stream(stream));
    }
}
async fn forward_once(
    route: Route,
    routes: Arc<std::sync::RwLock<Route>>,
    request: Request,
) -> Response {
    let (mut parts, body) = request.into_parts();
    if parts
        .headers
        .get("upgrade")
        .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"))
    {
        return websocket::upgrade(route, routes, &mut parts).await;
    }
    if ![axum::http::Method::POST, axum::http::Method::GET].contains(&parts.method) {
        return Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .body(Body::empty())
            .unwrap();
    }
    let body = match to_bytes(body, 16 * 1024 * 1024).await {
        Ok(b) => b,
        Err(_) => return Response::builder().status(413).body(Body::empty()).unwrap(),
    };
    let is_claude =
        parts.uri.path().ends_with("/messages") || parts.uri.path().starts_with("/claude-desktop/");
    let Some(provider) = (if is_claude {
        route.claude.as_ref()
    } else {
        route.provider.as_ref()
    }) else {
        return Response::builder()
            .status(404)
            .body(Body::from("Client route is disabled"))
            .unwrap();
    };
    let mut hydrated = provider.clone();
    if !provider.subscription_account_id.is_empty() {
        hydrated.bearer_token = match route
            .subscriptions
            .credential(&provider.subscription_account_id)
            .await
        {
            Ok(t) => t,
            Err(e) => {
                return protocol_error(
                    401,
                    if is_claude {
                        "anthropic-messages"
                    } else {
                        "responses"
                    },
                    &e,
                )
            }
        };
        hydrated.base_url = match route
            .subscriptions
            .endpoint_for(&provider.subscription_account_id)
            .await
        {
            Ok(url) => url,
            Err(error) => {
                return protocol_error(
                    401,
                    if is_claude {
                        "anthropic-messages"
                    } else {
                        "responses"
                    },
                    &error,
                )
            }
        };
        hydrated.official = false;
        hydrated.oauth = official_accounts::is_official(&provider.subscription_account_id);
    }
    let provider = &hydrated;
    let original_payload = serde_json::from_slice::<Value>(&body).ok();
    let started = millis();
    let index = route.count.fetch_add(1, Ordering::Relaxed) + 1;
    let origin = parts.extensions.get::<ingress::Origin>();
    let source = origin.map(|o| o.client.as_str()).unwrap_or(if is_claude {
        "claude-cli"
    } else {
        "codex-cli"
    });
    let native_key = conversation_identity::session(
        &parts.headers,
        original_payload.as_ref().unwrap_or(&Value::Null),
        !is_claude,
    );
    let key = native_key
        .as_deref()
        .map(|key| format!("{source}:{key}"))
        .unwrap_or_else(|| format!("{source}:request-{started}-{index}"));
    let detail_lease = storage::DetailLease::new(route.store.clone(), &key);
    let mut payload = original_payload.clone();
    if is_claude {
        if let Some(ref mut v) = payload {
            v["model"] = json!(desktop::request_model(
                &route.root,
                provider,
                text(v, "model"),
                parts.uri.path().starts_with("/claude-desktop/")
            ));
        }
    }
    if let (Some(ref mut payload), Some(model)) = (&mut payload, &route.model_override) {
        payload["model"] = json!(model);
    }
    let native_session = conversation_identity::session(
        &parts.headers,
        payload.as_ref().unwrap_or(&Value::Null),
        !is_claude,
    );
    let session = native_session.as_deref().unwrap_or("");
    let scoped_session = parts
        .extensions
        .get::<ingress::Origin>()
        .map(|o| format!("{}:{session}", o.client))
        .unwrap_or_else(|| session.to_string());
    let session = scoped_session.as_str();
    if !is_claude {
        if let Some(ref mut body) = payload {
            match continuation::selected_model(&route.root, provider, session, text(body, "model"))
            {
                Ok(model) if !model.is_empty() => body["model"] = json!(model),
                Ok(_) => {}
                Err(error) => return protocol_error(400, "responses", &error),
            }
        }
    }
    let model = payload
        .as_ref()
        .and_then(|v| v["model"].as_str().map(String::from));
    let frozen_reference = storage::reference_price(&route.store, model.as_deref().unwrap_or(""));
    let frozen_provider_price =
        provider_pricing::snapshot(&route.root, provider, model.as_deref().unwrap_or("")).map(
            |price| storage::provider_price(&route.store, model.as_deref().unwrap_or(""), price),
        );
    let path = parts.uri.path();
    let metadata = parts.method == axum::http::Method::GET;
    let account = path.starts_with("/backend-api/wham");
    if !(path.ends_with("/responses")
        || path.ends_with("/responses/compact")
        || path.ends_with("/messages")
        || (metadata && path.ends_with("/models"))
        || (account && provider.oauth))
    {
        return protocol_error(404, "responses", "Unknown Gateway route");
    }
    let incoming = if is_claude {
        "anthropic-messages"
    } else {
        "responses"
    };
    let resolved_wire = resolve_wire(&route.root, provider, model.as_deref(), incoming);
    let wire = resolved_wire.as_str();
    let subscription = !provider.subscription_account_id.is_empty();
    let native_chat = parts
        .extensions
        .get::<ingress::Origin>()
        .is_some_and(|o| o.protocol == "chat-completions")
        && wire == "chat-completions";
    let convert = incoming != wire && !metadata && !account && !native_chat;
    let compact = (convert || (subscription && !provider.oauth))
        && !is_claude
        && (path.ends_with("/compact")
            || payload.as_ref().is_some_and(|b| {
                b["input"]
                    .as_array()
                    .and_then(|a| a.last())
                    .is_some_and(|v| v["type"] == "compaction_trigger")
            }));
    let client_stream = payload.as_ref().is_some_and(|v| v["stream"] == true);
    if !is_claude && !metadata && !account {
        if let Some(ref body) = payload {
            match continuation::prepare(
                &route.root,
                &route.codex_home,
                provider,
                session,
                body,
                convert,
            )
            .await
            {
                Ok(expanded) => {
                    let expanded = if wire == "responses" {
                        match continuation::strict_responses(&expanded) {
                            Ok(body) => body,
                            Err(error) => return protocol_error(400, incoming, &error),
                        }
                    } else {
                        expanded
                    };
                    payload = Some(expanded);
                }
                Err(e) => return protocol_error(400, incoming, &e),
            }
        }
    }
    let continuation_body = payload.clone();
    let tool_input = if native_chat {
        parts
            .extensions
            .get::<ingress::Origin>()
            .and_then(|o| ingress::chat_input(&o.body).ok())
            .map(|b| b["input"].clone())
            .unwrap_or(Value::Null)
    } else if is_claude {
        continuation_body
            .as_ref()
            .and_then(|b| protocol::messages_responses(b).ok())
            .map(|b| b["input"].clone())
            .unwrap_or(Value::Null)
    } else {
        continuation_body
            .as_ref()
            .map(|b| b["input"].clone())
            .unwrap_or(Value::Null)
    };
    // Retire proven client results before contacting the upstream. Its next reply
    // may fail or never complete, but the tool results have already arrived here.
    let tool_observer = if !metadata && !account && !compact && !path.ends_with("/compact") {
        let mut observer = tool_wait::Observer::new(
            route.activity.clone(),
            index,
            provider,
            source,
            native_key.as_deref().unwrap_or(""),
            &tool_input,
            origin.map(|o| o.protocol.as_str()).unwrap_or(incoming),
        );
        if wire == "responses" {
            if let Some(body) = &continuation_body {
                observer.native_request(body);
            }
        }
        Some(observer)
    } else {
        None
    };
    if native_chat {
        payload = parts
            .extensions
            .get::<ingress::Origin>()
            .map(|o| o.body.clone());
    }
    if compact {
        if let Some(ref mut body) = payload {
            if let Some(input) = body["input"].as_array_mut() {
                input.retain(|v| {
                    v["type"] != "compaction_trigger" && v["type"] != "additional_tools"
                });
            }
            body["instructions"]=json!(format!("{}\nYou are performing a CONTEXT CHECKPOINT COMPACTION. Output only a concise handoff summary including progress, decisions, user constraints, next steps and critical references.",text(body,"instructions")));
            body["tools"] = json!([]);
            body["stream"] = json!(false);
            body["max_output_tokens"] = json!(body["max_output_tokens"]
                .as_u64()
                .unwrap_or(4096)
                .clamp(1, 4096));
            for key in ["tool_choice", "parallel_tool_calls", "context_management"] {
                body.as_object_mut().unwrap().remove(key);
            }
        }
    }
    let mut context = protocol::ToolContext::default();
    if convert {
        let conversion = (|| -> Result<Value> {
            let original = payload.as_ref().ok_or("无效请求 JSON")?;
            let responses = if is_claude {
                protocol::messages_responses(original)?
            } else {
                original.clone()
            };
            match wire {
                "responses" => Ok(responses),
                "chat-completions" => {
                    let (mut body, tools) = protocol::responses_chat(&responses)?;
                    reasoning::chat(&mut body, &responses, provider);
                    context = tools;
                    Ok(body)
                }
                "anthropic-messages" => {
                    let (mut body, tools) = protocol::responses_messages(
                        &responses,
                        catalog::output_limit(
                            &route.root,
                            provider,
                            model.as_deref().unwrap_or(""),
                        ),
                    )?;
                    reasoning::messages(&mut body, &responses);
                    context = tools;
                    Ok(body)
                }
                _ => Err("未知协议".into()),
            }
        })();
        match conversion {
            Ok(body) => payload = Some(body),
            Err(error) => return protocol_error(400, incoming, &error),
        }
    }
    if wire == "responses" && !metadata && !account {
        if let Some(ref mut body) = payload {
            if provider.oauth {
                if let Err(error) = official_responses::normalize(body) {
                    return protocol_error(400, incoming, &error);
                }
            }
            reasoning::responses(body, provider);
        }
    }
    let mut grok_tools = None;
    if provider.subscription_account_id.starts_with("grok-") && !metadata && !is_claude {
        if let Some(ref mut body) = payload {
            if body["tools"].as_array().is_some_and(|a| !a.is_empty())
                || body["input"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v["type"] == "additional_tools"))
            {
                match protocol::grok_request(body) {
                    Ok(context) => grok_tools = Some(context),
                    Err(error) => return protocol_error(400, incoming, &error),
                }
            }
        }
    }
    if subscription && !metadata && wire == "responses" {
        if let Some(ref mut body) = payload {
            body["store"] = json!(false);
            body["stream"] = json!(true);
        }
    }
    let body = if is_claude || convert || subscription || payload != original_payload {
        payload
            .as_ref()
            .map(|v| serde_json::to_vec(v).unwrap())
            .unwrap_or_else(|| body.to_vec())
    } else {
        body.to_vec()
    };
    let query = parts.uri.query().unwrap_or("");
    // Claude's SDK adds beta=true for Messages. That protocol flag is not an
    // OpenAI Chat/Responses parameter and must not leak across conversion.
    // Preserve all other caller parameters and native Messages passthrough.
    let query = if is_claude && wire != "anthropic-messages" {
        query
            .split('&')
            .filter(|part| part.split('=').next() != Some("beta"))
            .collect::<Vec<_>>()
            .join("&")
    } else {
        query.to_string()
    };
    let suffix = if query.is_empty() {
        String::new()
    } else {
        format!("?{query}")
    };
    let normalized = Pilot::provider_api_root(provider);
    let base = normalized.as_str();
    let endpoint = if provider.oauth {
        if account {
            format!(
                "{base}{}{suffix}",
                path.strip_prefix("/backend-api").unwrap_or(path)
            )
        } else if metadata {
            format!("{base}/codex/models{suffix}")
        } else if path.ends_with("/compact") {
            format!("{base}/codex/responses/compact{suffix}")
        } else {
            format!("{base}/codex/responses{suffix}")
        }
    } else if metadata {
        format!("{base}/models{suffix}")
    } else if path.ends_with("/compact") && !compact {
        format!("{base}/responses/compact{suffix}")
    } else {
        match wire {
            "anthropic-messages" => {
                if base.rsplit('/').next().is_some_and(|s| {
                    s.strip_prefix('v')
                        .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
                }) {
                    format!("{base}/messages{suffix}")
                } else {
                    format!("{base}/v1/messages{suffix}")
                }
            }
            "chat-completions" => format!("{base}/chat/completions{suffix}"),
            _ => format!("{base}/responses{suffix}"),
        }
    };
    let mut request = route
        .client
        .request(parts.method.clone(), &endpoint)
        .body(body);
    let credential = official_chatgpt::authorization(
        provider,
        parts
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok()),
        &route.third_party_tokens,
    );
    if let Some(credential) = credential {
        request = request.header("authorization", credential);
    }
    if wire == "anthropic-messages" {
        if provider.official {
            if let Some(key) = parts.headers.get("x-api-key") {
                request = request.header("x-api-key", key);
            }
        } else if !subscription && !provider.bearer_token.is_empty() {
            request = request.header("x-api-key", &provider.bearer_token);
        }
        if !provider
            .subscription_account_id
            .starts_with("claude-subscription-")
        {
            request = request.header(
                "anthropic-version",
                parts
                    .headers
                    .get("anthropic-version")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("2023-06-01"),
            );
        }
    }
    for (name, value) in &parts.headers {
        if official_chatgpt::omit_client_version(provider, name.as_str()) {
            continue;
        }
        if subscription
            && [
                "chatgpt-account-id",
                "openai-organization",
                "openai-project",
            ]
            .contains(&name.as_str())
        {
            continue;
        }
        if !(subscription
            && (name.as_str().starts_with("x-grok-")
                || name.as_str() == "x-xai-token-auth"
                || name.as_str() == "user-agent"
                || name.as_str() == "anthropic-version"
                || name.as_str() == "anthropic-beta"
                || name.as_str() == "editor-version"
                || name.as_str() == "editor-plugin-version"
                || name.as_str() == "copilot-integration-id"
                || name.as_str() == "x-github-api-version"))
            && ![
                "host",
                "authorization",
                "x-api-key",
                "x-goog-api-key",
                "connection",
                "content-length",
                "transfer-encoding",
                "accept-encoding",
                "proxy-authorization",
                "cookie",
            ]
            .contains(&name.as_str())
        {
            request = request.header(name, value);
        }
    }
    if subscription {
        match route
            .subscriptions
            .bound_headers(&provider.subscription_account_id, &provider.bearer_token)
            .await
        {
            Ok(headers) => {
                for (name, value) in headers {
                    request = request.header(name, value);
                }
            }
            Err(error) => return protocol_error(401, incoming, &error),
        }
        if provider.subscription_account_id.starts_with("grok-") {
            if let Some(model) = payload.as_ref().and_then(|v| v["model"].as_str()) {
                request = request.header("x-grok-model-override", model);
            }
        }
    }
    let index = route.count.fetch_add(1, Ordering::Relaxed) + 1;
    let response = match if provider.subscription_account_id.starts_with("cursor-") && !metadata {
        route
            .subscriptions
            .cursor_response(
                &provider.subscription_account_id,
                payload.as_ref().unwrap_or(&Value::Null),
            )
            .await
    } else if provider.subscription_account_id.starts_with("cursor-")
        && metadata
        && path.ends_with("/models")
    {
        route
            .subscriptions
            .cursor_model_response(&provider.subscription_account_id)
            .await
    } else {
        request.send().await.map_err(|error| {
            route.diagnostics.transport(
                &error,
                &endpoint,
                provider,
                wire,
                started,
                index,
                &parts.headers,
            );
            upstream_diagnostics::user_message(&error).to_string()
        })
    } {
        Ok(r) => r,
        Err(error) => {
            if provider.subscription_account_id.starts_with("cursor-") {
                return protocol_error(502, incoming, &error);
            }
            return upstream_diagnostics::response(incoming, &error);
        }
    };
    if response.status().is_server_error() {
        route
            .diagnostics
            .http_status(&response, &endpoint, provider, wire, started, index);
    }
    let mut output = Response::builder().status(response.status());
    if native_chat {
        output = output.header("x-xwx-native-chat", "1");
    }
    for (name, value) in response.headers() {
        if ![
            "connection",
            "transfer-encoding",
            "content-length",
            "set-cookie",
        ]
        .contains(&name.as_str())
        {
            output = output.header(name, value);
        }
    }
    if metadata || account {
        return output
            .body(Body::from_stream(response.bytes_stream()))
            .unwrap();
    }
    let headers: serde_json::Map<_, _> = parts
        .headers
        .iter()
        .filter(|(k, _)| {
            ![
                "authorization",
                "x-api-key",
                "x-goog-api-key",
                "cookie",
                "proxy-authorization",
                "set-cookie",
            ]
            .contains(&k.as_str())
        })
        .map(|(k, v)| (k.to_string(), json!(v.to_str().unwrap_or(""))))
        .collect();
    let mut record = json!({"id":format!("trace-{started}-{index}"),"startedAt":storage::iso(started),"startedAtMs":started as u64,"completedAt":storage::iso(millis()),"source":source,"clientConversationKey":key,"protocol":if is_claude{"anthropic-messages"}else{"openai-responses"},"captureMode":"reverse-proxy","provider":{"id":provider.id,"name":provider.display_name,"connectionId":provider.id},"request":{"method":"POST","path":parts.uri.path(),"url":parts.uri.to_string(),"headers":headers,"body":original_payload,"model":model,"apiType":if is_claude{"messages"}else{"responses"}},"upstream":{"baseUrl":provider.base_url,"url":endpoint,"connectionId":provider.id},"response":{"statusCode":response.status().as_u16(),"headers":{}},"timings":{}});
    record["clientFirstPrompt"] = json!(ingress::first_prompt(
        original_payload.as_ref().unwrap_or(&Value::Null)
    ));
    if let Some(adapter) = response.extensions().get::<cursor_accounts::CursorWire>() {
        record["upstream"]["baseUrl"] = json!(adapter.base);
        record["upstream"]["url"] = json!(adapter.url);
        record["upstream"]["transport"] = json!("cursor-connect-protobuf");
        record["upstream"]["transportRequest"] = adapter.request.clone();
    }
    if let Some(origin) = origin {
        record["sourceLabel"] = json!(ingress::label(&origin.client));
        record["clientFirstPrompt"] = json!(ingress::first_prompt(&origin.body));
        record["protocol"] = json!(origin.protocol);
        record["request"]["body"] = origin.body.clone();
        record["request"]["path"] = json!(origin.path);
        record["request"]["url"] = json!(origin.path);
        record["request"]["apiType"] = json!(origin.protocol);
        record["normalizedRequest"] = original_payload.clone().unwrap_or(Value::Null);
    }
    record["upstream"]["requestBody"] = payload.clone().unwrap_or(Value::Null);
    record["upstream"]["model"] = json!(model);
    record["request"]["clientModel"] = original_payload
        .as_ref()
        .map(|body| body["model"].clone())
        .unwrap_or(Value::Null);
    if compact || path.ends_with("/responses/compact") {
        record["compact"] = json!(true);
    }
    record["contextChanges"] = json!({"clientProtocol":incoming,"upstreamProtocol":wire,"historyRestored":original_payload.as_ref().is_some_and(|p|p.get("previous_response_id").is_some()) && payload.as_ref().is_some_and(|p|p.get("previous_response_id").is_none()),"transformed":payload!=original_payload});
    record["contextChanges"]["modelRemapped"] = json!(
        payload.as_ref().map(|b| &b["model"]) != original_payload.as_ref().map(|b| &b["model"])
    );
    if route.model_override.is_some() {
        record["contextChanges"]["serviceSwitch"] =
            json!({"providerId":provider.id,"providerName":provider.display_name,"model":model});
    }
    if parts.headers.contains_key("version")
        && official_chatgpt::omit_client_version(provider, "version")
    {
        record["contextChanges"]["omittedUpstreamHeaders"] = json!(["version"]);
    }
    if record["compact"] == true {
        record["contextChanges"]["compactionMode"] = json!(if compact {
            "gateway-summary"
        } else {
            "upstream"
        });
    }
    trace_compaction::annotate(&mut record);
    if let Some(origin) = origin {
        if origin.protocol == "gemini" {
            let mut notes = vec![];
            if origin.body["generationConfig"].get("topK").is_some() {
                notes.push("topK 无跨协议等价项，使用上游采样规则");
            }
            if origin.body["generationConfig"]["thinkingConfig"]
                .get("includeThoughts")
                .is_some()
            {
                notes.push("展示上游提供的思考摘要，不生成或估算隐藏思考内容");
            }
            record["contextChanges"]["conversionNotes"] = json!(notes);
        }
        record["contextChanges"]["clientProtocol"] = json!(origin.protocol);
        record["contextChanges"]["transformed"] = json!(payload != Some(origin.body.clone()));
    }
    record["catalogIdentity"] = json!(catalog::identity(provider));
    if let Some(price) = frozen_provider_price {
        record["providerPrice"] = price;
    }
    record["referencePriceVersion"] = json!(1);
    record["referencePrice"] = frozen_reference;
    let mut capture = storage::Capture {
        _detail_lease: Some(detail_lease),
        store: route.store.clone(),
        record,
        wire: wire.into(),
        key,
        raw: vec![],
        chunk_receipts: vec![],
        overflow: false,
        done: false,
        client_evidence: parts
            .extensions
            .get::<storage::ClientEvidence>()
            .map(|e| e.capture()),
    };
    if response.status().is_success() && !compact {
        if let (Some(evidence), Some(observer)) = (
            parts.extensions.get::<storage::ClientEvidence>(),
            tool_observer,
        ) {
            evidence.tools(observer);
        }
    }
    capture.record["upstream"]["statusCode"] = json!(response.status().as_u16());
    if (convert || compact || grok_tools.is_some() || (subscription && !client_stream))
        && response.status().is_success()
    {
        if convert && !is_claude && client_stream && !compact && grok_tools.is_none() {
            return live::responses(
                response,
                capture,
                live::ResponseContext {
                    tools: context,
                    provider: provider.clone(),
                    root: route.root.clone(),
                    session: session.into(),
                },
                continuation_body.clone().unwrap_or(Value::Null),
                route.cancel.clone(),
            );
        }
        if is_claude && client_stream {
            return live::claude(
                response,
                capture,
                context,
                model.unwrap_or_default(),
                route.cancel.clone(),
            );
        }
        use futures_util::StreamExt;
        let upstream_sse = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains("text/event-stream"));
        let mut stream = response.bytes_stream();
        let mut bytes = vec![];
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(chunk) => {
                    if bytes.len() + chunk.len() > 32 * 1024 * 1024 {
                        return protocol_error(502, incoming, "上游转换响应超过 32 MB 上限");
                    }
                    capture.chunk(&chunk);
                    bytes.extend_from_slice(&chunk);
                }
                Err(_) => return protocol_error(502, incoming, "上游响应流中断"),
            }
        }
        let parsed = if upstream_sse {
            std::str::from_utf8(&bytes)
                .map_err(err)
                .and_then(|raw| protocol::collapse_sse(raw, wire, model.as_deref().unwrap_or("")))
        } else {
            serde_json::from_slice::<Value>(&bytes).map_err(err)
        };
        let mut value = match parsed {
            Ok(v) => v,
            Err(error) => return protocol_error(502, incoming, &error),
        };
        if let Err(error) = protocol::validate_response(&value, wire) {
            return protocol_error(502, incoming, &error);
        }
        if subscription && wire == "responses" && value["status"] != "completed" {
            return protocol_error(502, incoming, "订阅调用未完成，请检查授权与套餐额度");
        }
        let upstream_value = value.clone();
        if let Some(ref context) = grok_tools {
            protocol::grok_response(&mut value, context);
        }
        let response = match wire {
            "chat-completions" => protocol::chat_response(&value, &context),
            "anthropic-messages" => protocol::messages_response(&value, &context),
            _ => value,
        };
        if !is_claude {
            if let Some(ref body) = continuation_body {
                if let Err(e) = continuation::save(
                    &route.root,
                    provider,
                    session,
                    body,
                    &response,
                    original_payload
                        .as_ref()
                        .map(|b| text(b, "model"))
                        .unwrap_or(""),
                ) {
                    eprintln!("{e}");
                }
            }
        }
        let value = if compact {
            use base64::Engine;
            let summary = response["output"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|i| i["content"].as_array().into_iter().flatten())
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            if summary.trim().is_empty() {
                return protocol_error(502, incoming, "上游未返回压缩摘要");
            }
            json!({"id":format!("cmp_{}",millis()),"object":"response.compaction","created_at":millis() as u64/1000,"output":[{"id":format!("ci_{}",millis()),"type":"compaction","encrypted_content":format!("xwxc1:{}",base64::engine::general_purpose::STANDARD.encode(summary))}],"usage":response["usage"]})
        } else if is_claude {
            protocol::responses_message(&response)
        } else {
            response
        };
        if !is_claude && compact {
            if let Some(ref body) = continuation_body {
                if let Err(e) = continuation::save(
                    &route.root,
                    provider,
                    session,
                    body,
                    &value,
                    original_payload
                        .as_ref()
                        .map(|b| text(b, "model"))
                        .unwrap_or(""),
                ) {
                    capture.record["contextChanges"]["cacheWarning"] = json!(e);
                }
            }
        }
        capture.record["response"]["body"] = value.clone();
        capture.record["clientRawBody"] = json!(if client_stream {
            if is_claude {
                protocol::message_sse(&value)
            } else {
                protocol::response_sse(&value)
            }
        } else {
            value.to_string()
        });
        capture.finish(Some(upstream_value));
        return if client_stream && !compact {
            Response::builder()
                .status(200)
                .header("content-type", "text/event-stream")
                .header("cache-control", "no-cache")
                .body(Body::from(if is_claude {
                    protocol::message_sse(&value)
                } else {
                    protocol::response_sse(&value)
                }))
                .unwrap()
        } else {
            Response::builder()
                .status(200)
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap()
        };
    }
    use futures_util::StreamExt;
    let continuation_root = route.root.clone();
    let continuation_provider = provider.clone();
    let continuation_session = session.to_string();
    let save_body = continuation_body.clone();
    let native_sse = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("text/event-stream"));
    let upstream = response.bytes_stream();
    let stream = futures_util::stream::unfold(
        (upstream, Some(capture), route.cancel.clone(), false, false),
        move |(mut upstream, mut capture, mut cancel, mut saved, mut terminal_seen)| {
            let root = continuation_root.clone();
            let provider = continuation_provider.clone();
            let session = continuation_session.clone();
            let body = save_body.clone();
            async move {
                let next =
                    tokio::select! {biased;_=cancel.changed()=>None,chunk=upstream.next()=>chunk};
                match next {
                    Some(chunk) => {
                        let mut completed = None;
                        if let Ok(ref bytes) = chunk {
                            if let Some(ref mut guard) = capture {
                                let previous = guard.raw.len();
                                guard.chunk(bytes);
                                let response_sse = native_sse || protocol::is_sse_body(&guard.raw);
                                if response_sse && !terminal_seen {
                                    let tail = &guard.raw[previous.saturating_sub(64)..];
                                    terminal_seen = tail
                                        .windows(b"response.completed".len())
                                        .any(|w| w == b"response.completed");
                                }
                                let json_end = !response_sse
                                    && bytes.iter().rev().find(|b| !b.is_ascii_whitespace())
                                        == Some(&b'}');
                                if !is_claude
                                    && !native_chat
                                    && !saved
                                    && !guard.overflow
                                    && (terminal_seen || json_end)
                                {
                                    let value = serde_json::from_slice::<Value>(&guard.raw)
                                        .ok()
                                        .or_else(|| {
                                            std::str::from_utf8(&guard.raw).ok().and_then(|s| {
                                                protocol::collapse_sse(
                                                    s,
                                                    "responses",
                                                    text(&guard.record["request"], "model"),
                                                )
                                                .ok()
                                            })
                                        });
                                    if let Some(value) = value.filter(|v| {
                                        v["status"] == "completed"
                                            || v["object"] == "response.compaction"
                                    }) {
                                        if let Some(ref body) = body {
                                            if let Err(e) = continuation::save(
                                                &root,
                                                &provider,
                                                &session,
                                                body,
                                                &value,
                                                text(&guard.record["request"], "clientModel"),
                                            ) {
                                                guard.record["contextChanges"]["cacheWarning"] =
                                                    json!(e);
                                            }
                                        }
                                        saved = true;
                                        completed = Some(value);
                                    }
                                }
                            }
                        }
                        if let Some(value) = completed {
                            if let Some(guard) = capture.take() {
                                guard.finish(Some(value));
                            }
                        }
                        Some((chunk, (upstream, capture, cancel, saved, terminal_seen)))
                    }
                    None => {
                        if let Some(guard) = capture.take() {
                            guard.finish(None);
                        }
                        None
                    }
                }
            }
        },
    );
    output.body(Body::from_stream(stream)).unwrap()
}

fn resolve_wire(root: &Path, provider: &Provider, model: Option<&str>, incoming: &str) -> String {
    if provider.adapter == "auto" && provider.subscription_account_id.is_empty() {
        return catalog::wire(root, provider, model, incoming);
    }
    if provider.adapter == "auto" {
        let known: Value = serde_json::from_str(include_str!(
            "../../test-results/native-assets/official-models.json"
        ))
        .unwrap_or(json!([]));
        let cache = root.join(format!(
            "provider-{}-models.json",
            &storage::digest(provider.id.as_bytes())[..24]
        ));
        let entries = read(&cache)
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok());
        let catalog = entries
            .as_ref()
            .filter(|v| v["baseUrl"] == provider.base_url && v["adapter"] == provider.adapter)
            .and_then(|v| v["entries"].as_array())
            .and_then(|a| {
                a.iter()
                    .find(|e| e["id"].as_str() == model && e["protocolsDeclared"] == true)
            });
        if provider.subscription_account_id.starts_with("copilot-") && catalog.is_none() {
            return "chat-completions".into();
        }
        let official = known
            .as_array()
            .and_then(|a| a.iter().find(|e| e["modelId"].as_str() == model));
        let protocols = catalog.or(official).map(|v| &v["protocols"]);
        protocols
            .and_then(|protocols| catalog::preferred_wire(protocols, incoming))
            .unwrap_or(incoming)
            .into()
    } else {
        provider.adapter.clone()
    }
}

fn protocol_error(status: u16, incoming: &str, message: &str) -> Response {
    let error = if incoming == "anthropic-messages" {
        json!({"type":"error","error":{"type":"api_error","message":message}})
    } else {
        json!({"error":{"type":"gateway_protocol_error","message":message}})
    };
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(error.to_string()))
        .unwrap()
}

#[cfg(test)]
mod gateway_listener_tests {
    use super::*;

    #[test]
    fn normal_endpoint_is_fixed_and_acceptance_is_isolated() {
        assert_eq!(gateway_listen_port(false), 45233);
        assert_eq!(gateway_listen_port(true), 0);
    }

    #[tokio::test]
    async fn occupied_endpoint_fails_without_replacing_its_owner_then_can_be_reused() {
        // Exercise the production binder on an isolated port, never 45233.
        let owner = bind_gateway_listener(0).await.unwrap();
        let port = owner.local_addr().unwrap().port();
        let error = bind_gateway_listener(port).await.unwrap_err();
        assert!(error.contains(&port.to_string()));
        let connection = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let (accepted, _) = owner.accept().await.unwrap();
        drop(connection);
        drop(accepted);
        drop(owner);
        let reopened = bind_gateway_listener(port).await.unwrap();
        assert_eq!(reopened.local_addr().unwrap().port(), port);
    }
}

#[cfg(test)]
mod config_merge_tests {
    use super::*;
    #[test]
    fn restores_only_changed_owned_fields_and_keeps_comments() {
        let before="# initial\nmodel = \"direct\" # old note\nmodel_provider = \"openai\"\n[model_providers.xwx_deck]\nname = \"Original\"\nbase_url = \"https://original.invalid/v1\"\ncustom_header = \"keep\"\n";
        let managed = before
            .replace("\"direct\"", "\"gateway\"")
            .replace(
                "model_provider = \"openai\"",
                "model_provider = \"xwx_deck\"",
            )
            .replace("https://original.invalid/v1", "http://127.0.0.1:45233/v1");
        let current = managed
            .replace("# old note", "# user's newest comment")
            .replace(
                "custom_header = \"keep\"",
                "custom_header = \"external-update\"\nrequest_timeout_ms = 1234",
            );
        let restored = restore_codex_fields(&current, before, &managed, false).unwrap();
        assert!(restored.contains("# user's newest comment"));
        assert!(restored.contains("external-update"));
        assert!(restored.contains("request_timeout_ms = 1234"));
        assert!(restored.contains("https://original.invalid/v1"));
        assert!(!restored.contains("127.0.0.1"));
        assert_eq!(
            restore_codex_fields(&managed, before, &managed, false).unwrap(),
            before
        );
    }
    #[test]
    fn refuses_owned_route_drift_without_a_write() {
        let before = "model_provider = \"openai\"\n";
        let managed="model_provider = \"xwx_deck\"\n[model_providers.xwx_deck]\nbase_url = \"http://127.0.0.1:45233/v1\"\n";
        let external = managed.replace("45233", "59999");
        assert!(restore_codex_fields(&external, before, managed, false).is_err());
    }
    #[test]
    fn older_auth_flag_migration_is_not_external_drift() {
        let managed = "model = \"deepseek-v4-pro\"\nmodel_provider = \"DeepSeek\"\n[model_providers.DeepSeek]\nbase_url = \"https://api.deepseek.com\"\nexperimental_bearer_token = \"synthetic\"\nrequires_openai_auth = true\n[model_providers.xwx_deck]\nbase_url = \"https://api.deepseek.com\"\nexperimental_bearer_token = \"synthetic\"\nrequires_openai_auth = true\n";
        let migrated = managed.replace(
            "requires_openai_auth = true",
            "requires_openai_auth = false",
        );
        assert!(!codex_external_change(
            &doc(&migrated).unwrap(),
            &doc(managed).unwrap(),
            "DeepSeek",
            true
        ));
        // A user who explicitly re-enables the login is still external drift.
        assert!(codex_external_change(
            &doc(managed).unwrap(),
            &doc(&migrated).unwrap(),
            "DeepSeek",
            true
        ));
        // Other owned fields remain protected.
        let changed_model = migrated.replace("\"deepseek-v4-pro\"", "\"other\"");
        assert!(codex_external_change(
            &doc(&changed_model).unwrap(),
            &doc(managed).unwrap(),
            "DeepSeek",
            true
        ));
    }
}

#[cfg(test)]
mod storage_readout_tests {
    use super::format_bytes;

    #[test]
    fn storage_uses_readable_units_across_refreshes_and_thresholds() {
        let cases: Vec<(u64, String)> =
            serde_json::from_str(include_str!("../../src/shared/format-bytes-cases.json")).unwrap();
        for (bytes, expected) in cases {
            assert_eq!(format_bytes(bytes), expected);
        }
    }
}
