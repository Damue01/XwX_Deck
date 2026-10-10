#[path = "client_wiring.rs"]
mod client_wiring;
#[path = "ingress.rs"]
mod ingress;
#[path = "claude_accounts.rs"]
mod claude_accounts;
#[path = "client_installations.rs"]
mod client_installations;
#[path = "clients.rs"]
mod clients;
#[path = "config_import.rs"]
mod config_import;
#[path = "continuation.rs"]
mod continuation;
#[path = "copilot_accounts.rs"]
mod copilot_accounts;
#[path = "cursor_accounts.rs"]
mod cursor_accounts;
#[path = "cursor_protocol.rs"]
mod cursor_protocol;
#[path = "desktop.rs"]
mod desktop;
#[path = "grok_accounts.rs"]
mod grok_accounts;
#[path = "history.rs"]
mod history;
#[path = "live.rs"]
mod live;
#[path = "protocol.rs"]
mod protocol;
#[path = "reasoning.rs"]
mod reasoning;
#[path = "storage.rs"]
mod storage;
#[path = "subscription_routing.rs"]
mod subscription_routing;
#[path = "subscriptions.rs"]
mod subscriptions;
#[path = "updates.rs"]
mod updates;
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
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn same_physical_path(path: &Path) -> Result<bool> {
    let canonical = fs::canonicalize(path).map_err(err)?;
    #[cfg(target_os = "windows")]
    {
        let canonical = canonical.to_string_lossy();
        let expected = path.to_string_lossy();
        Ok(canonical
            .trim_start_matches(r"\\?\")
            .eq_ignore_ascii_case(&expected))
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

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Provider {
    id: String,
    codex_provider_id: String,
    display_name: String,
    provider_preset: String,
    base_url: String,
    bearer_token: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    subscription_account_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    account_label: String,
    adapter: String,
    codex_api_format: String,
    codex_model: String,
    codex_context_window: u64,
    claude_models: Value,
    #[serde(skip)]
    official: bool,
    #[serde(skip)]
    oauth: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    theme: String,
    language: Option<String>,
    connections: Vec<Provider>,
    selected: Value,
    #[serde(rename = "traceWarningGB", alias = "traceWarningGb")]
    trace_warning_gb: f64,
    trace_auto_cleanup: bool,
    trace_appearance: Value,
    claude_models: Value,
    client_enabled: Value,
    trace_root: String,
    log_root: String,
    claude_config_dir: String,
    codex_enhancements: Value,
    codex_models: Value,
    claude_desktop: Value,
    startup_enabled: bool,
    automatic_updates: bool,
    #[serde(flatten)]
    other: serde_json::Map<String, Value>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            claude_models: json!({"fable":"","opus":"","sonnet":"","haiku":""}),
            client_enabled: json!({"claude":true,"codex":true}),
            theme: "day".into(),
            language: None,
            connections: vec![],
            selected: json!({"codex":null,"claude":null}),
            trace_warning_gb: 1.0,
            trace_auto_cleanup: true,
            trace_appearance: json!({"skin":"classic","showThroughput":true,"customImageFile":"","customImageFit":"cover","customImageOverlay":42}),
            trace_root: String::new(),
            log_root: String::new(),
            claude_config_dir: String::new(),
            codex_enhancements: json!({"preserveOfficialLogin":true,"unifySessionHistory":false,"pendingHistoryRestore":false}),
            codex_models: json!({"official":"","officialContextWindow":0}),
            claude_desktop: json!({"syncEnabled":false}),
            startup_enabled: false,
            automatic_updates: true,
            other: serde_json::Map::new(),
        }
    }
}
struct Gateway {
    routes: Arc<std::sync::RwLock<Route>>,
    port: u16,
    shutdown: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
    before: String,
    managed: String,
    claude: Option<(String, String)>,
    codex_managed: bool,
    codex_official: bool,
    cancel: tokio::sync::watch::Sender<bool>,
}
#[derive(Clone)]
struct Route {
    subscriptions: subscriptions::Accounts,
    provider: Option<Provider>,
    clients: std::collections::BTreeMap<String, Provider>,
    claude: Option<Provider>,
    client: reqwest::Client,
    count: Arc<AtomicU64>,
    store: storage::Store,
    root: PathBuf,
    cancel: tokio::sync::watch::Receiver<bool>,
}
pub struct Pilot {
    pub root: PathBuf,
    subscriptions: subscriptions::Accounts,
    isolated: bool,
    settings: Settings,
    gateway: Option<Gateway>,
    count: Arc<AtomicU64>,
    lock: fs::File,
    store: storage::Store,
    dashboard_port: Option<u16>,
    settings_problem: Option<String>,
    recovery_problem: Option<String>,
    updates: updates::Updates,
}
pub type Shared = Arc<Mutex<Pilot>>;

fn read(path: &Path) -> Result<Option<String>> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err("隔离目录内不允许符号链接".into()),
        Ok(_) => fs::read_to_string(path).map(Some).map_err(err),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}
fn write(path: &Path, content: &str) -> Result<()> {
    read(path)?;
    let temporary = path.with_extension("pilot-tmp");
    if fs::symlink_metadata(&temporary).is_ok() {
        return Err("临时文件已存在，保留现场".into());
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(err)?;
    }
    use std::io::Write;
    file.write_all(content.as_bytes()).map_err(err)?;
    file.sync_all().map_err(err)?;
    fs::rename(temporary, path).map_err(err)
}
fn doc(source: &str) -> Result<DocumentMut> {
    source
        .parse()
        .map_err(|_| "Codex TOML 无法解析，原文件已保留；请在设置中修复配置".into())
}

impl Pilot {
    fn client_discovery(&self) -> client_installations::Discovery {
        if self.isolated && std::env::args().any(|arg| arg == "--rpc" || arg == "--smoke") {
            if let Some(home) = std::env::var_os("XWX_CLIENT_INSTALLATIONS_TEST_HOME")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute() && path.starts_with(&self.root))
            {
                return client_installations::Discovery::for_home(&home);
            }
        }
        client_installations::Discovery::system()
    }
    fn model_clients(&self) -> Vec<String> {
        let mut clients: Vec<String> =
            if self.settings.other.get("modelClientsVersion") == Some(&json!(2)) {
                vec![]
            } else {
                vec!["claude".into(), "codex".into()]
            };
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
        read(&lock_path)?;
        let mut lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(err)?;
        lock.try_lock()
            .map_err(|_| "试验目录已被另一个运行中的进程占用".to_string())?;
        lock.set_len(0).map_err(err)?;
        use std::io::Write;
        lock.write_all(std::process::id().to_string().as_bytes())
            .map_err(err)?;
        let (settings, settings_problem) = match read(&root.join("settings.json"))? {
            Some(source) => match (|| -> Result<Settings> {
                let mut value: Value = serde_json::from_str(&source).map_err(err)?;
                if value.get("traceWarningGB").is_some() {
                    value
                        .as_object_mut()
                        .ok_or("设置不是对象")?
                        .remove("traceWarningGb");
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
                serde_json::from_value(value).map_err(err)
            })() {
                Ok(settings) => (settings, None),
                Err(_) => (
                    Settings::default(),
                    Some("设置文件损坏，原文件已保留；修复前不会覆盖连接与选择".into()),
                ),
            },
            None => (Settings::default(), None),
        };
        let trace_root = Self::directory(
            &root,
            &settings.trace_root,
            if isolated { "traces" } else { "xwx-trace" },
        )?;
        let store = storage::TraceStore::open(
            trace_root,
            (settings.trace_warning_gb * 1024.0f64.powi(3)) as u64,
            settings.trace_auto_cleanup,
        )?;
        let mut pilot = Self {
            subscriptions: subscriptions::Accounts::open(&root, isolated)?,
            updates: updates::Updates::new(root.clone()),
            root,
            isolated,
            settings,
            gateway: None,
            count: Arc::new(AtomicU64::new(0)),
            lock,
            store,
            dashboard_port: None,
            settings_problem,
            recovery_problem: None,
        };
        pilot.recovery_problem = pilot.restore_client_wiring(None).and_then(|_|pilot.recover_interrupted_gateway()).err();
        if pilot.settings_problem.is_none() {
            pilot.persist()?;
        }
        Ok(Arc::new(Mutex::new(pilot)))
    }
    fn directory(root: &Path, path: &str, default: &str) -> Result<PathBuf> {
        let path = if path.trim().is_empty() {
            root.join(default)
        } else {
            PathBuf::from(path)
        };
        if !path.is_absolute()
            || (std::env::args().any(|a| a == "--pilot-root") && !path.starts_with(root))
            || path
                .components()
                .any(|p| matches!(p, std::path::Component::ParentDir))
        {
            return Err("隔离测试只能选择试验根目录内的绝对路径".into());
        }
        fs::create_dir_all(&path).map_err(err)?;
        if !same_physical_path(&path)? {
            return Err("配置目录不允许符号链接".into());
        }
        Ok(path)
    }
    pub async fn subscription_authorization_url(&self) -> Result<String> {
        self.subscriptions.authorization_url().await
    }
    pub fn trace_root(&self) -> PathBuf {
        if self.settings.trace_root.is_empty() {
            self.root
                .join(if self.isolated { "traces" } else { "xwx-trace" })
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
    fn claude_dir(&self) -> PathBuf {
        if self.settings.claude_config_dir.is_empty() {
            if self.isolated {
                self.root.join("claude")
            } else {
                std::env::var("CLAUDE_CONFIG_DIR")
                    .ok()
                    .filter(|s| !s.trim().is_empty())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| Self::home().join(".claude"))
            }
        } else {
            PathBuf::from(&self.settings.claude_config_dir)
        }
    }
    fn persist(&self) -> Result<()> {
        if let Some(ref error) = self.settings_problem {
            return Err(error.clone());
        }
        let mut value = serde_json::to_value(&self.settings).map_err(err)?;
        if value.get("providers").is_some() {
            value["providers"] = json!({"version":1,"identityVersion":2,"connections":self.settings.connections,"selected":self.settings.selected});
        }
        write(
            &self.root.join("settings.json"),
            &serde_json::to_string_pretty(&value).map_err(err)?,
        )
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
        self.settings.other.get("clientRoutes").and_then(Value::as_object).into_iter().flatten()
            .filter(|(id, v)| ingress::valid_client(id) && v["enabled"] != false)
            .filter_map(|(id, v)| self.settings.connections.iter().find(|p| p.id == text(v,"providerId"))
                .map(|p| {let mut p=p.clone(); p.codex_model=text(v,"model").into(); (id.clone(),p)})).collect()
    }
    pub fn update_state(&self) -> Value {
        self.updates.state()
    }
    pub fn trace_events(&self) -> Result<tokio::sync::broadcast::Receiver<String>> {
        Ok(self.store.lock().map_err(err)?.events.subscribe())
    }
    pub fn nightly_eligible(&self) -> bool {
        if !self.settings.automatic_updates { return false; }
        let state = self.updates.state();
        read(&self.root.join("declined-update.json"))
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .is_none_or(|v| v["version"] != state["targetVersion"])
    }
    fn providers(&self) -> Value {
        json!({"version":1,"identityVersion":2,"connections":self.settings.connections,"selected":self.settings.selected,"active":self.settings.selected,"warning":self.settings_problem})
    }
    pub fn state(&self) -> Value {
        let active = self.gateway.is_some();
        let (sessions, count, bytes) = self.store.lock().unwrap().totals();
        let mut state = json!({"tracingEnabled":active,"readiness":{"startupPhase":"ready","proxyListening":active,"recordingEnabled":active,"claudeConfigReady":self.gateway.as_ref().is_some_and(|g|g.claude.is_some()),"claudeRouteReady":self.gateway.as_ref().is_some_and(|g|g.claude.is_some()),"codexConfigReady":self.gateway.as_ref().is_some_and(|g|g.codex_managed),"codexRouteReady":self.gateway.as_ref().is_some_and(|g|g.codex_managed),"codexGatewayEnabled":self.gateway.as_ref().is_some_and(|g|g.codex_managed)},
          "localBaseUrl":self.gateway.as_ref().map(|g|format!("http://127.0.0.1:{}",g.port)),"traceRoot":self.trace_root(),"logRoot":self.log_root(),"claudeConfigDir":self.claude_dir(),"claudeConfigPath":self.claude_path(),
          "backgroundGatewayActive":active,"backgroundGatewayAction":if active {Some("close")} else {None},"chatGptRestartRecommended":false,
          "sessions":sessions,"traces":count,"storageText":format!("{bytes} B"),"traceStorageBytes":bytes,"traceWarningGB":self.settings.trace_warning_gb,"traceAutoCleanup":self.settings.trace_auto_cleanup,
          "clients":[{"id":"claude-cli","label":"Claude","enabled":self.settings.client_enabled["claude"],"status":if self.gateway.as_ref().is_some_and(|g|g.claude.is_some()){"taken"}else{"idle"},"statusText":if self.gateway.as_ref().is_some_and(|g|g.claude.is_some()){"追踪中"}else{"待命"},"detail":if self.gateway.as_ref().is_some_and(|g|g.claude.is_some()){"客户端请求正在追踪"}else{"客户端直连"}},{"id":"codex-cli","label":"ChatGPT","enabled":self.settings.client_enabled["codex"],"status":if self.gateway.as_ref().is_some_and(|g|g.codex_managed){"taken"}else{"idle"},"statusText":if self.gateway.as_ref().is_some_and(|g|g.codex_managed){"追踪中"}else{"待命"},"detail":if self.gateway.as_ref().is_some_and(|g|g.codex_managed){"客户端请求正在追踪"}else{"客户端直连"}}],
          "lastError":self.settings_problem.clone().or_else(||self.recovery_problem.clone()).or_else(||self.store.lock().unwrap().read_problem.clone()).or_else(||self.config().err()),"theme":self.settings.theme,"language":self.settings.language.clone().unwrap_or_else(crate::language::system_language),"automaticUpdates":self.settings.automatic_updates,"traceAppearance":self.trace_appearance(),"startup":{"enabled":self.settings.startup_enabled,"desiredEnabled":self.settings.startup_enabled,"supported":!self.isolated&&cfg!(any(target_os="macos",target_os="windows")),"launchHidden":true,"warning":if self.isolated {Some("隔离验证不注册系统登录项")}else{None}},"update":self.update_state()});
        if let Some(rows)=state["clients"].as_array_mut(){
            let routes = self.generic_routes();
            for (id, v) in self.settings.other.get("clientRoutes").and_then(Value::as_object).into_iter().flatten() {
                let enabled = v["enabled"] != false;
                let automatic = client_wiring::automatic_client(id);
                let listening = active && routes.contains_key(id);
                let wired = listening && (!automatic || self.root.join(format!("client-wiring-{id}.json")).exists());
                let skipped = listening && automatic && !wired;
                rows.push(json!({"id":id,"label":ingress::label(id),"enabled":enabled,
                    "status":if !enabled {"off"} else if skipped {"skipped"} else if wired {"taken"} else {"idle"},
                    "statusText":if !enabled {"已暂停"} else if skipped {"未接管"} else if wired && automatic {"追踪中"} else if wired {"入口已就绪"} else {"待命"},
                    "detail":if skipped {"未检测到客户端，原配置保留"} else if wired && automatic {"客户端请求正在追踪"} else if wired {"将接入地址填入客户端后开始捕获"} else {"客户端直连"}}));
            }
        }
        state
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
        Ok(
            json!({"configPath":self.config_path(),"authPath":self.codex_home().join("auth.json"),"exists":self.config_path().exists(),"mode":if selected.is_some(){"compatible"}else{"official"},"authMode":self.auth_mode(),"activeProvider":provider,"activeBaseUrl":base,"officialModel":if selected.is_none(){model}else{""},"modelCatalogSource":"none","configOwnership":if !self.config_path().exists() || provider=="xwx_deck" || provider=="openai" {"deck"} else {"external"},
          "compatible":{"provider":selected.map(|p|p.display_name.as_str()).unwrap_or(""),"model":selected.map(|p|p.codex_model.as_str()).unwrap_or(""),"baseUrl":selected.map(|p|p.base_url.as_str()).unwrap_or(""),"bearerToken":selected.map(|p|p.bearer_token.as_str()).unwrap_or("")}}),
        )
    }
    fn subscription_route_accepted(&self, client: &str, source: &str) -> Result<bool> {
        use sha2::{Digest, Sha256};
        if !self
            .selected_for(client)
            .is_some_and(|p| !p.subscription_account_id.is_empty())
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
        let mut d = self.config()?;
        let accepted_subscription = self.subscription_route_accepted("codex", &d.to_string())?;
        let journal = self.root.join("codex-direct.json");
        let previous = read(&journal)?
            .map(|s| serde_json::from_str::<Value>(&s).map_err(err))
            .transpose()?;
        if let Some(ref ledger) = previous {
            let expected = doc(text(ledger, "managed"))?;
            let table = |d: &DocumentMut| {
                d.get("model_providers")
                    .and_then(|p| p.get("xwx_deck"))
                    .map(Item::to_string)
            };
            if !takeover
                && !accepted_subscription
                && (["model", "model_provider", "model_context_window"]
                    .iter()
                    .any(|key| {
                        d.get(*key).map(Item::to_string) != expected.get(*key).map(Item::to_string)
                    })
                    || table(&d) != table(&expected))
            {
                return Err("外部 Codex 配置变化已保留，请明确接管后重试".into());
            }
        }
        let before = d.to_string();
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
                    == Some(p.base_url.as_str())
        });
        if active != "openai"
            && active != "xwx_deck"
            && !retained
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
        {
            return self.remember_subscription_route("codex", &d.to_string());
        }
        if let Some(p) = self.selected() {
            d["model_provider"] = value("xwx_deck");
            d["model"] = value(&p.codex_model);
            d["model_providers"]["xwx_deck"]["name"] = value(&p.display_name);
            d["model_providers"]["xwx_deck"]["base_url"] = value(&p.base_url);
            d["model_providers"]["xwx_deck"]["wire_api"] = value("responses");
            d["model_providers"]["xwx_deck"]["experimental_bearer_token"] = value(&p.bearer_token);
            if p.codex_context_window > 0 {
                d["model_context_window"] = value(p.codex_context_window as i64);
            } else {
                d.remove("model_context_window");
            }
            if let Some(preserve) =
                self.settings.codex_enhancements["preserveOfficialLogin"].as_bool()
            {
                d["model_providers"]["xwx_deck"]["requires_openai_auth"] =
                    value(preserve && self.auth_mode() == "chatgpt");
            }
        } else {
            d["model_provider"] = value("openai");
            if let Some(ref ledger) = previous {
                let original = doc(text(ledger, "before"))?;
                for key in ["model", "model_context_window"] {
                    if let Some(v) = original.get(key) {
                        d[key] = v.clone();
                    } else {
                        d.remove(key);
                    }
                }
            }
            if let Some(model) = self.settings.codex_models["official"]
                .as_str()
                .filter(|s| !s.is_empty())
            {
                d["model"] = value(model);
            }
            if let Some(window) = self.settings.codex_models["officialContextWindow"]
                .as_u64()
                .filter(|n| *n > 0)
            {
                d["model_context_window"] = value(window as i64);
            }
            if let Some(table) = d.get_mut("model_providers").and_then(Item::as_table_mut) {
                table.remove("xwx_deck");
            }
            if self.settings.codex_enhancements["unifySessionHistory"] == true {
                let oauth = self.auth_mode() == "chatgpt";
                let base = d
                    .get("openai_base_url")
                    .and_then(Item::as_str)
                    .unwrap_or(if oauth {
                        "https://chatgpt.com/backend-api"
                    } else {
                        "https://api.openai.com/v1"
                    })
                    .trim_end_matches('/')
                    .to_string();
                d["model_provider"] = value("xwx_deck");
                d["model_providers"]["xwx_deck"]["name"] = value("XwX Deck");
                d["model_providers"]["xwx_deck"]["wire_api"] = value("responses");
                d["model_providers"]["xwx_deck"]["base_url"] =
                    value(if oauth { format!("{base}/codex") } else { base });
                d["model_providers"]["xwx_deck"]["requires_openai_auth"] = value(true);
            }
        }
        let managed = self.selected().is_some()
            || self.settings.codex_enhancements["unifySessionHistory"] == true;
        if managed {
            write(&journal,&json!({"before":previous.as_ref().map(|l|text(l,"before")).unwrap_or(&before),"managed":d.to_string()}).to_string())?;
        }
        write(&self.config_path(), &d.to_string())?;
        if !managed && previous.is_some() {
            fs::remove_file(journal).map_err(err)?;
        }
        Ok(())
    }
    async fn prepare_routes(
        &mut self,
        validate: bool,
    ) -> Result<(Option<Provider>, Option<Provider>)> {
        let provider = if self.settings.client_enabled["codex"]
            .as_bool()
            .unwrap_or(true)
        {
            if let Some(p) = self.selected() {
                Some(p.clone())
            } else {
                self.official_codex()?
            }
        } else {
            None
        };
        let claude = if self.settings.client_enabled["claude"]
            .as_bool()
            .unwrap_or(true)
        {
            if let Some(p) = self.selected_for("claude") {
                Some(p.clone())
            } else {
                self.official_claude()?
            }
        } else {
            None
        };
        let generic=self.generic_routes();
        for p in [provider.as_ref(), claude.as_ref()].into_iter().flatten().chain(generic.values()) {
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
    fn manage_routes(
        &self,
        port: u16,
        provider: &Option<Provider>,
    ) -> Result<(String, String, Option<(String, String)>, bool, bool)> {
        let codex_managed = provider.is_some();
        let codex_official = provider.as_ref().is_some_and(|p| p.official);
        let codex_oauth = provider.as_ref().is_some_and(|p| p.oauth);
        let before = read(&self.config_path())?.unwrap_or_default();
        let mut managed = doc(&before)?;
        if codex_managed {
            if codex_official {
                managed["openai_base_url"] = value(format!(
                    "http://127.0.0.1:{port}{}",
                    if codex_oauth { "" } else { "/v1" }
                ));
                if codex_oauth {
                    managed["chatgpt_base_url"] = value("https://chatgpt.com/backend-api");
                }
                if managed.get("model_provider").and_then(Item::as_str) == Some("xwx_deck") {
                    managed["model_providers"]["xwx_deck"]["base_url"] = value(format!(
                        "http://127.0.0.1:{port}{}",
                        if codex_oauth {
                            "/backend-api/codex"
                        } else {
                            "/v1"
                        }
                    ));
                }
            } else {
                if let Some(p) = provider
                    .as_ref()
                    .filter(|p| !p.subscription_account_id.is_empty())
                {
                    managed["model_provider"] = value("xwx_deck");
                    managed["model"] = value(&p.codex_model);
                    managed["model_providers"]["xwx_deck"] = toml_edit::Item::None;
                    managed["model_providers"]["xwx_deck"]["name"] = value(&p.display_name);
                    managed["model_providers"]["xwx_deck"]["wire_api"] = value("responses");
                    managed["model_providers"]["xwx_deck"]["experimental_bearer_token"] =
                        value("xwx-local-subscription");
                }
                managed["model_providers"]["xwx_deck"]["base_url"] =
                    value(format!("http://127.0.0.1:{port}/v1"));
            }
        }
        let managed = managed.to_string();
        let claude = self.claude_managed(port)?;
        let result=write(&self.root.join("gateway-recovery.json"),&json!({"before":before,"managed":managed,"port":port,"codexManaged":codex_managed,"codexOfficial":codex_official,"claude":claude}).to_string()).and_then(|_| {
            if codex_managed {write(&self.config_path(),&managed)?;}
            if let Some((_,ref managed))=claude {write(&self.claude_path(),managed)?;}
            Ok(())
        });
        if let Err(e) = result {
            if codex_managed {
                let _ = write(&self.config_path(), &before);
            }
            if let Some((ref before, _)) = claude {
                let _ = write(&self.claude_path(), before);
            }
            return Err(e);
        }
        Ok((before, managed, claude, codex_managed, codex_official))
    }
    fn restore_gateway_config(&self, g: &Gateway) -> Result<()> {
        self.desktop_preflight()?;
        let claude_restored = g
            .claude
            .as_ref()
            .map(|(before, managed)| self.check_claude_restore(before, managed))
            .transpose()?;
        if g.codex_managed {
            let mut current = self.config()?;
            let expected = doc(&g.managed)?;
            let previous = doc(&g.before)?;
            for key in if g.codex_official {
                vec!["openai_base_url", "chatgpt_base_url"]
            } else {
                vec!["model", "model_provider"]
            } {
                if current.get(key).map(Item::to_string) != expected.get(key).map(Item::to_string) {
                    return Err("外部配置变化已保留，Gateway 继续运行；请恢复受管字段后重试".into());
                }
            }
            if (!g.codex_official
                || expected.get("model_provider").and_then(Item::as_str) == Some("xwx_deck"))
                && current
                    .get("model_providers")
                    .and_then(|p| p.get("xwx_deck"))
                    .map(Item::to_string)
                    != expected
                        .get("model_providers")
                        .and_then(|p| p.get("xwx_deck"))
                        .map(Item::to_string)
            {
                return Err("外部服务配置变化已保留，Gateway 继续运行".into());
            }
            for key in if g.codex_official {
                vec!["openai_base_url", "chatgpt_base_url"]
            } else {
                vec!["model", "model_provider"]
            } {
                if let Some(v) = previous.get(key) {
                    current[key] = v.clone();
                } else {
                    current.remove(key);
                }
            }
            if let Some(v) = previous
                .get("model_providers")
                .and_then(|p| p.get("xwx_deck"))
            {
                current["model_providers"]["xwx_deck"] = v.clone();
            } else if let Some(table) = current
                .get_mut("model_providers")
                .and_then(Item::as_table_like_mut)
            {
                table.remove("xwx_deck");
                if table.is_empty() && previous.get("model_providers").is_none() {
                    current.remove("model_providers");
                }
            }

            self.desktop_restore()?;
            write(&self.config_path(), &current.to_string())?;
        }
        self.desktop_restore()?;
        if let Some(restored) = claude_restored {
            if let Err(e) = write(
                &self.claude_path(),
                &serde_json::to_string_pretty(&restored).map_err(err)?,
            ) {
                if g.codex_managed {
                    let _ = write(&self.config_path(), &g.managed);
                }
                return Err(e);
            }
        }
        Ok(())
    }
    async fn publish_routes(&mut self, g: &mut Gateway) -> Result<()> {
        let (provider, claude) = self.prepare_routes(false).await?;
        let config = self.manage_routes(g.port, &provider)?;
        {
            let mut routes = g.routes.write().map_err(err)?;
            routes.clients = self.generic_routes();
            routes.provider = provider;
            routes.claude = claude;
        }
        (
            g.before,
            g.managed,
            g.claude,
            g.codex_managed,
            g.codex_official,
        ) = config;
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
        let (provider, claude) = self.prepare_routes(true).await?;
        let mut listener = None;
        for port in 45233..=45242 {
            if let Ok(bound) = tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
                listener = Some(bound);
                break;
            }
        }
        let listener = listener.ok_or("XwX Deck Gateway 端口段已占满")?;
        let port = listener.local_addr().map_err(err)?.port();
        let (cancel, cancelled) = tokio::sync::watch::channel(false);
        let route = Route {
            subscriptions: self.subscriptions.clone(),
            provider: provider.clone(),
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
        let (before, managed, claude, codex_managed, codex_official) = match result {
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
            routes,
            port,
            shutdown,
            task,
            before,
            managed,
            claude,
            codex_managed,
            codex_official,
            cancel,
        });
        if let Err(error)=self.apply_client_wiring(port){
            return match self.stop().await{Ok(())=>Err(error),Err(restore)=>Err(format!("{error}；{restore}"))};
        }
        if let Err(e) = self.desktop_apply(Some(port)) {
            eprintln!("Claude Desktop 同步失败：{e}");
        }
        Ok(())
    }
    pub async fn stop(&mut self) -> Result<()> {
        let Some(g) = self.gateway.as_ref() else {
            return Ok(());
        };
        self.restore_client_wiring(None)?;
        self.restore_gateway_config(g)?;
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
        fs::remove_file(self.root.join("gateway-recovery.json")).map_err(err)?;
        self.desktop_apply(None)?;
        Ok(())
    }
    pub async fn dashboard_url(&mut self) -> Result<String> {
        if let Some(port) = self.dashboard_port {
            return Ok(format!("http://127.0.0.1:{port}/"));
        }
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(err)?;
        let port = listener.local_addr().map_err(err)?.port();
        let app = Router::new()
            .fallback(storage::dashboard)
            .with_state(self.store.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        self.dashboard_port = Some(port);
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
    pub fn release_lock(&self) {
        let _ = self.lock.unlock();
    }
    pub async fn call(&mut self, method: &str, args: &[Value]) -> Result<Value> {
        if self.active()
            && [
                "saveProvider",
                "switchClientProvider",
                "updateCodexConfig",
                "updateClaudeModels",
                "setTraceStoragePolicy",
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
                    if value.get("connections").is_some() {
                        Ok(self.providers())
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
                if let Some(g)=self.gateway.as_ref(){g.routes.write().map_err(err)?.clients=self.generic_routes();}
                self.client_route_snapshot(id)
            }
            "resumeTracing" => {
                let desired=self.settings.other.get("traceDesiredEnabled").and_then(Value::as_bool)
                    .unwrap_or(self.selected().is_some()||self.selected_for("claude").is_some()||!self.generic_routes().is_empty());
                if desired&&!self.active(){self.start().await?;}Ok(self.state())
            }
            "getSubscriptionNotices" => Ok(self.subscriptions.pool.notices()),
            "getSubscriptionAccounts" => Ok(self.subscriptions.snapshot().await),
            "setSubscriptionRouting" => {
                let service=text(&input,"platform");
                let policy:subscription_routing::Policy=serde_json::from_value(input["policy"].clone()).map_err(err)?;
                let snapshot=self.subscriptions.snapshot().await;
                for id in policy.excluded_account_ids.iter().chain(if policy.strategy=="fixed" {Some(&policy.fixed_account_id)}else{None}) {
                    if !snapshot["accounts"].as_array().is_some_and(|rows|rows.iter().any(|a|a["id"]==*id && a["platform"]==service)){return Err("策略中的账号不属于此订阅".into());}
                }
                self.subscriptions.pool.save(service,policy)?;
                Ok(self.subscriptions.snapshot().await)
            }
            "refreshSubscriptionUsage" => {self.subscriptions.refresh_usage(text(&input,"platform")).await?;Ok(self.subscriptions.snapshot().await)} ,
            "beginSubscriptionSignIn" => self.subscriptions.begin_for(text(&input,"platform"), text(&input,"accountId")).await,
            "cancelSubscriptionSignIn" => Ok(self.subscriptions.cancel().await),
            "subscriptionTestAuthorizationUrl" => Ok(json!(self.subscriptions.test_url().await?)),
            "connectSubscriptionAccount" => {
                let provider = self.subscriptions.provider(input.as_str().ok_or("无效订阅账号")?).await?;
                self.subscriptions.pool.recovered(&provider.subscription_account_id);
                if !self.settings.connections.iter().any(|p|p.id==provider.id) { self.settings.connections.push(provider); self.persist()?; }
                Ok(self.providers())
            }
            "renameSubscriptionAccount" => {
                let id=text(&input,"accountId"); let label=text(&input,"label").trim();
                if label.is_empty() || label.chars().count()>80 || label.chars().any(char::is_control) { return Err("账号名称须为 1–80 个字符".into()); }
                if self.settings.connections.iter().any(|p|p.display_name==label && p.subscription_account_id!=id) { return Err("连接名称已存在".into()); }
                self.subscriptions.rename(id,label).await?;
                if let Some(p)=self.settings.connections.iter_mut().find(|p|p.subscription_account_id==id) { p.display_name=label.into(); self.persist()?; }
                Ok(self.providers())
            }
            "signOutSubscriptionAccount" => {
                let id=input.as_str().ok_or("无效订阅账号")?;
                // Clearing one registration must not tear down other accounts' in-flight replies.
                // Already accepted requests own their credential snapshot; new requests observe sign-out.
                self.subscriptions.sign_out(id).await
            }
            "detectClientInstallations" => {
                let discovery = self.client_discovery();
                let catalog: Value = serde_json::from_str(include_str!("../../test-results/native-assets/clients.json")).map_err(err)?;
                Ok(json!({"available":true,"clients":catalog.as_array().into_iter().flatten().map(|client|json!({"id":client["id"],"installed":discovery.installed(text(client,"id"))})).collect::<Vec<_>>()}))
            }
            "getModelClients" => Ok(json!(self.model_clients())),
            "addModelClient" | "removeModelClient" => {
                let id = input.as_str().ok_or("无效客户端")?;
                let catalog: Value = serde_json::from_str(include_str!("../../test-results/native-assets/clients.json")).map_err(err)?;
                if !catalog.as_array().is_some_and(|rows|rows.iter().any(|row|row["id"]==id)) { return Err("未知客户端".into()); }
                let id = client_installations::canonical_id(id);
                let mut clients = self.model_clients();
                if method == "removeModelClient" {
                    if ingress::valid_client(id)&&self.settings.other.get("clientRoutes").and_then(|r|r.get(id)).is_some_and(|r|r["enabled"]!=false){Box::pin(self.call("toggleClient",&[json!(id)])).await?;}
                    clients.retain(|client|client!=id);
                }
                else if !clients.iter().any(|client|client==id) {
                    if !self.client_discovery().installed(id) { return Err("未检测到客户端安装，请先安装并重新检测".into()); }
                    clients.push(id.to_owned());
                }
                let value=json!(clients);
                let before = self.settings.other.insert("modelClients".into(), value.clone());
                let version_before = self.settings.other.insert("modelClientsVersion".into(),json!(2));
                if let Err(error)=self.persist() {
                    if let Some(old)=before { self.settings.other.insert("modelClients".into(),old); } else { self.settings.other.remove("modelClients"); }
                    if let Some(old)=version_before { self.settings.other.insert("modelClientsVersion".into(),old); } else { self.settings.other.remove("modelClientsVersion"); }
                    return Err(error);
                }
                Ok(value)
            }
            "getState" | "refresh" => Ok(self.state()),
            "getProviders" => Ok(self.providers()),
            "previewConfigurationImport" => self.preview_import(&input),
            "importConfigurations" => self.apply_import(&input),
            "repairUnreadableSettings" => {
                let source = read(&self.root.join("settings.json"))?.ok_or("设置文件不存在")?;
                let backup = self.root.join(format!("settings-backup-{}.json", millis()));
                write(&backup, &source)?;
                self.settings = Settings::default();
                self.settings_problem = None;
                self.persist()?;
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
                write(&self.config_path(), "")?;
                self.write_direct(false)?;
                Ok(
                    json!({"backupPath":backup,"mode":if self.selected().is_some(){"compatible"}else{"official"},"conflicts":[]}),
                )
            }
            "repairClientProviderSwitch" => {
                let mut request = input.clone();
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
            "restartAndInstall"=>Ok(json!({"path":self.updates.installer().await?,"installMode":if cfg!(target_os="macos"){"manual-dmg"}else{"automatic"}})),
            "repairApplication"=>{
                let mut count=0;let mut bytes=0;
                for file in fs::read_dir(&self.root).map_err(err)?{let file=file.map_err(err)?;let name=file.file_name().to_string_lossy().into_owned();if name.starts_with("provider-")&&name.ends_with("-models.json")&&file.file_type().map_err(err)?.is_file(){bytes+=file.metadata().map_err(err)?.len();fs::remove_file(file.path()).map_err(err)?;count+=1;}}
                Ok(json!({"removedCachePaths":count,"removedBytes":bytes,"chromiumCacheCleared":false,"traceRetention":{"legacyLimitsFound":false,"persistedSettingsChanged":false,"settings":{"maxSessions":0,"maxStorageMB":0},"helper":if self.active(){json!({"state":"verified","maxSessions":0,"maxStorageBytes":self.store.lock().map_err(err)?.limit})}else{json!({"state":"not-running"})}}}))
            }
            "resetApplication"=>{
                self.stop().await?;
                let backup=self.root.join(format!("reset-backup-{}",millis()));fs::create_dir_all(&backup).map_err(err)?;
                write(&backup.join("settings.json"),&read(&self.root.join("settings.json"))?.unwrap_or_default())?;
                if input["resetClientConfigs"]==true{
                    self.settings.selected=json!({"codex":null,"claude":null});self.write_direct(false)?;self.write_claude_direct(false)?;
                }
                let paths=(self.settings.trace_root.clone(),self.settings.log_root.clone(),self.settings.claude_config_dir.clone());self.desktop_restore()?;self.settings=Settings::default();self.settings.trace_root=paths.0;self.settings.log_root=paths.1;self.settings.claude_config_dir=paths.2;self.persist()?;
                // User-owned Trace records and client histories remain available for a separate explicit deletion.
                self.store.lock().map_err(err)?.limit=1024*1024*1024;self.store.lock().map_err(err)?.auto_cleanup=true;
                Ok(Value::Null)
            }
            "isChatGptRunning"=>{
                if self.isolated{return Ok(json!(false));}
                #[cfg(unix)]{let output=std::process::Command::new("/bin/ps").args(["-A","-o","comm="]).output().map_err(err)?;let running=String::from_utf8_lossy(&output.stdout).lines().any(|line|line.ends_with("/Codex")||line.ends_with("/ChatGPT"));Ok(json!(running))}
                #[cfg(not(unix))]{let output=std::process::Command::new("tasklist.exe").args(["/FO","CSV","/NH"]).output().map_err(err)?;Ok(json!(String::from_utf8_lossy(&output.stdout).lines().any(|line|line.to_lowercase().starts_with("\"codex.exe\"")||line.to_lowercase().starts_with("\"chatgpt.exe\""))))}
            },
            "setStartupEnabled"=>{let enabled=input.as_bool().ok_or("无效启动设置")?;if self.isolated{return Err("隔离验证不注册系统登录项".into());}self.settings.startup_enabled=enabled;self.persist()?;Ok(self.state())},
            "updateTraceDirectories" => {
                if self.active(){return Err("请先停止 Trace 再修改目录".into());}
                let mut paths=vec![];
                for (key,default) in [("traceRoot","traces"),("logRoot","logs"),("claudeConfigDir","claude")] {
                    if let Some(value)=input.get(key){let path=Self::directory(&self.root,value.as_str().ok_or("无效目录")?,default)?;paths.push((key,path));}
                }
                if paths.is_empty(){return Err("没有需要修改的目录".into());}
                if paths.iter().any(|(k,_)|*k=="claudeConfigDir")&&read(&self.root.join("claude-direct.json"))?.is_some(){return Err("请先恢复 Claude 官方配置再修改配置目录".into());}
                for (key,path) in paths {
                    match key {"traceRoot"=>{self.settings.trace_root=path.to_string_lossy().into();self.store=storage::TraceStore::open(path,(self.settings.trace_warning_gb*1024.0f64.powi(3))as u64,self.settings.trace_auto_cleanup)?;self.dashboard_port=None;},"logRoot"=>self.settings.log_root=path.to_string_lossy().into(),_=>{if read(&self.root.join("claude-direct.json"))?.is_some(){return Err("请先恢复 Claude 官方配置再修改配置目录".into());}self.settings.claude_config_dir=path.to_string_lossy().into();}}
                }
                self.persist()?;Ok(self.state())
            }
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
            "updateClaudeDesktopSync"=>{let enabled=input.as_bool().ok_or("无效开关")?;if !enabled{self.desktop_restore()?;}self.settings.claude_desktop["syncEnabled"]=json!(enabled);self.persist()?;self.desktop_apply(self.gateway.as_ref().map(|g|g.port))?;self.desktop_snapshot()},
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
                    if let Some(g)=self.gateway.as_ref(){g.routes.write().map_err(err)?.clients=self.generic_routes();}return Ok(self.state());
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
                self.settings.client_enabled[client] = json!(!self.settings.client_enabled[client]
                    .as_bool()
                    .unwrap_or(true));
                self.persist()?;
                if was_active {
                    self.start().await?;
                }
                Ok(self.state())
            }
            "disableBreaksCodex" => Ok(json!(self.settings.client_enabled["codex"]!=false && self.selected().is_some_and(|p|!p.subscription_account_id.is_empty() || resolve_wire(&self.root,p,Some(&p.codex_model),"responses")!="responses"))),
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
                    subscription_account_id: String::new(),
                    account_label: String::new(),
                    official: false,
                    oauth: false,
                    id: id.clone(),
                    codex_provider_id: "xwx_deck".into(),
                    display_name: name.into(),
                    provider_preset: input["providerPreset"].as_str().unwrap_or("custom").into(),
                    base_url: base.into(),
                    bearer_token: text(&input, "bearerToken").into(),
                    adapter: adapter.into(),
                    codex_api_format: if adapter == "auto" {
                        "responses"
                    } else {
                        adapter
                    }
                    .into(),
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
                Ok(self.providers())
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
                self.settings.selected[client] = selected;
                self.persist()?;
                let takeover = input["takeOverExternalConfig"].as_bool().unwrap_or(false);
                if client == "codex" {
                    self.write_direct(takeover)?;
                } else {
                    self.write_claude_direct(takeover)?;
                }
                Ok(self.providers())
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
                    if let Some(window) = input["modelContextWindow"].as_u64() {
                        p.codex_context_window = window;
                    }
                    self.persist()?;
                    self.write_direct(false)?;
                } else {
                    let mut d = self.config()?;
                    if let Some(model)=input["officialModel"].as_str(){self.settings.codex_models["official"]=json!(model);d["model"] = value(model);}
                    if let Some(window)=input["modelContextWindow"].as_u64(){self.settings.codex_models["officialContextWindow"]=json!(window);if window>0{d["model_context_window"]=value(window as i64);}else{d.remove("model_context_window");}}
                    self.persist()?;
                    write(&self.config_path(), &d.to_string())?;
                }
                self.codex_snapshot()
            }
            "deleteProvider" => {
                let id = input.as_str().ok_or("无效连接")?;
                if self.active()
                    || self.settings.selected["codex"].as_str() == Some(id)
                    || self.settings.selected["claude"].as_str() == Some(id)
                {
                    return Err("请先停止 Trace 并切回官方服务".into());
                }
                self.settings.connections.retain(|p| p.id != id);
                self.persist()?;
                Ok(self.providers())
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
                let Some(provider) = provider else {return self.official_catalog();};
                self.catalog(provider).await
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
                Ok(self.state())
            }
            "setTheme" => {
                let theme = input.as_str().ok_or("无效主题")?;
                if !["day", "night"].contains(&theme) {
                    return Err("无效主题".into());
                }
                self.settings.theme = theme.into();
                self.persist()?;
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
                if self.active() {
                    return Err("调整存储策略前请先停止 Trace".into());
                }
                if let Some(limit) = input["limitGB"].as_f64() {
                    if !limit.is_finite() || limit < 0.0 || limit > 1024.0 {
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
                    store.limit = (self.settings.trace_warning_gb * 1024.0f64.powi(3)) as u64;
                    store.auto_cleanup = self.settings.trace_auto_cleanup;
                }
                Ok(self.state())
            }
            "toggleTracing" => {
                let desired=input.as_bool().unwrap_or(!self.active());
                if desired {
                    self.start().await?;
                } else {
                    self.stop().await?;
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
        Ok(route) => route.clone(),
        Err(_) => return protocol_error(503, "responses", "路由暂不可用，请重试"),
    };
    if request.headers().contains_key("upgrade") {
        return forward_once(route, routes, request).await;
    }
    let is_claude = request.uri().path().ends_with("/messages");
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
    let session = ["x-codex-thread-id", "session_id", "x-session-id", "x-opencode-session", "x-gemini-session-id"]
        .iter()
        .find_map(|key| parts.headers.get(*key).and_then(|v| v.to_str().ok()))
        .or_else(|| payload["metadata"]["session_id"].as_str())
        .or_else(|| payload["metadata"]["user_id"].as_str())
        .map(str::to_string)
        .unwrap_or_else(|| {
            payload["previous_response_id"]
                .as_str()
                .map(|id| format!("response:{id}"))
                .unwrap_or_default()
        });
    let session=parts.extensions.get::<ingress::Origin>().map(|o|format!("{}:{session}",o.client)).unwrap_or(session);
    let model = if is_claude {
        let alias = text(&payload, "model").trim_end_matches("[1m]");
        ["fable", "opus", "sonnet", "haiku"]
            .into_iter()
            .find(|role| alias.starts_with(role) || alias.starts_with(&format!("claude-{role}")))
            .and_then(|role| provider.claude_models[role].as_str())
            .unwrap_or(alias)
    } else {
        payload["model"].as_str().unwrap_or(&provider.codex_model)
    };
    let service = subscription_routing::platform(&preferred);
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
    let is_claude = parts.uri.path().ends_with("/messages");
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
        hydrated.oauth = false;
    }
    let provider = &hydrated;
    let original_payload = serde_json::from_slice::<Value>(&body).ok();
    let started = millis();
    let mut payload = original_payload.clone();
    if is_claude {
        if let Some(ref mut v) = payload {
            let model = text(v, "model").trim_end_matches("[1m]");
            let aliases = read(&route.root.join("desktop-ledger.json"))
                .ok()
                .flatten()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok());
            if let Some(actual) = aliases.as_ref().and_then(|l| l["aliases"][model].as_str()) {
                v["model"] = json!(actual);
            }
            let model = text(v, "model").trim_end_matches("[1m]");
            for role in ["fable", "opus", "sonnet", "haiku"] {
                if model.starts_with(role) || model.starts_with(&format!("claude-{role}")) {
                    if let Some(actual) = provider.claude_models[role]
                        .as_str()
                        .filter(|s| !s.is_empty())
                    {
                        v["model"] = json!(actual);
                        break;
                    }
                }
            }
        }
    }
    let model = payload
        .as_ref()
        .and_then(|v| v["model"].as_str().map(String::from));
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
    let native_chat=parts.extensions.get::<ingress::Origin>().is_some_and(|o|o.protocol=="chat-completions")&&wire=="chat-completions";
    let convert = incoming != wire && !metadata && !account && !native_chat;
    let compact = (convert || subscription)
        && !is_claude
        && (path.ends_with("/compact")
            || payload.as_ref().is_some_and(|b| {
                b["input"]
                    .as_array()
                    .and_then(|a| a.last())
                    .is_some_and(|v| v["type"] == "compaction_trigger")
            }));
    let client_stream = payload.as_ref().is_some_and(|v| v["stream"] == true);
    let session = parts
        .headers
        .get("x-codex-thread-id")
        .or_else(|| parts.headers.get("session_id"))
        .or_else(|| parts.headers.get("x-session-id"))
        .or_else(|| parts.headers.get("x-opencode-session"))
        .or_else(|| parts.headers.get("x-gemini-session-id"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let scoped_session=parts.extensions.get::<ingress::Origin>().map(|o|format!("{}:{session}",o.client)).unwrap_or_else(||session.to_string());
    let session=scoped_session.as_str();
    if !is_claude && !metadata && !account {
        if let Some(ref body) = payload {
            match continuation::expand(&route.root, provider, session, body, convert) {
                Ok(expanded) => payload = Some(expanded),
                Err(e) => return protocol_error(400, incoming, &e),
            }
        }
    }
    let continuation_body = payload.clone();
    if native_chat{payload=parts.extensions.get::<ingress::Origin>().map(|o|o.body.clone());}
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
                    let (mut body, tools) = protocol::responses_messages(&responses)?;
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
    let suffix = parts
        .uri
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let normalized = Pilot::api_root(&provider.base_url);
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
    let credential = if provider.official {
        parts
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .or_else(|| {
                if provider.bearer_token.is_empty() {
                    None
                } else {
                    Some(format!("Bearer {}", provider.bearer_token))
                }
            })
    } else if !provider.bearer_token.is_empty() {
        Some(format!("Bearer {}", provider.bearer_token))
    } else {
        None
    };
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
            .headers(&provider.subscription_account_id)
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
        request.send().await.map_err(|_| "上游连接失败".to_string())
    } {
        Ok(r) => r,
        Err(error) => {
            if provider.subscription_account_id.starts_with("cursor-") {
                return protocol_error(502, incoming, &error);
            }
            return Response::builder()
                .status(502)
                .body(Body::from("Rust pilot upstream request failed"))
                .unwrap();
        }
    };
    let mut output = Response::builder().status(response.status());
    if native_chat{output=output.header("x-xwx-native-chat","1");}
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
    let index = route.count.fetch_add(1, Ordering::Relaxed) + 1;
    let origin = parts.extensions.get::<ingress::Origin>();
    let source = origin.map(|o|o.client.as_str()).unwrap_or(if is_claude { "claude-cli" } else { "codex-cli" });
    let native_key = parts
        .headers
        .get("x-codex-thread-id")
        .or_else(|| parts.headers.get("session_id"))
        .or_else(|| parts.headers.get("x-session-id"))
        .or_else(|| parts.headers.get("x-opencode-session"))
        .or_else(|| parts.headers.get("x-gemini-session-id"))
        .and_then(|v| v.to_str().ok())
        .or_else(|| {
            original_payload
                .as_ref()
                .and_then(|v| v["metadata"]["session_id"].as_str())
        });
    let key = native_key
        .map(|key| format!("{source}:{key}"))
        .unwrap_or_else(|| format!("{source}:request-{started}-{index}"));
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
    if let Some(adapter) = response.extensions().get::<cursor_accounts::CursorWire>() {
        record["upstream"]["baseUrl"] = json!(adapter.base);
        record["upstream"]["url"] = json!(adapter.url);
        record["upstream"]["transport"] = json!("cursor-connect-protobuf");
        record["upstream"]["transportRequest"] = adapter.request.clone();
    }
    if let Some(origin)=origin {
        record["sourceLabel"]=json!(ingress::label(&origin.client));
        record["clientFirstPrompt"]=json!(ingress::first_prompt(&origin.body));
        record["protocol"]=json!(origin.protocol);
        record["request"]["body"]=origin.body.clone();
        record["request"]["path"]=json!(origin.path);
        record["request"]["url"]=json!(origin.path);
        record["request"]["apiType"]=json!(origin.protocol);
        record["normalizedRequest"]=original_payload.clone().unwrap_or(Value::Null);
    }
    record["upstream"]["requestBody"]=payload.clone().unwrap_or(Value::Null);
    if compact || path.ends_with("/responses/compact") {
        record["compact"] = json!(true);
    }
    record["contextChanges"] = json!({"clientProtocol":incoming,"upstreamProtocol":wire,"historyRestored":original_payload.as_ref().is_some_and(|p|p.get("previous_response_id").is_some()) && payload.as_ref().is_some_and(|p|p.get("previous_response_id").is_none()),"transformed":payload!=original_payload});
    if record["compact"] == true {
        record["contextChanges"]["compactionMode"] = json!(if compact { "gateway-summary" } else { "upstream" });
    }
    if let Some(origin)=origin {if origin.protocol=="gemini"{let mut notes=vec![];if origin.body["generationConfig"].get("topK").is_some(){notes.push("topK 无跨协议等价项，使用上游采样规则");}if origin.body["generationConfig"]["thinkingConfig"].get("includeThoughts").is_some(){notes.push("展示上游提供的思考摘要，不生成或估算隐藏思考内容");}record["contextChanges"]["conversionNotes"]=json!(notes);}record["contextChanges"]["clientProtocol"]=json!(origin.protocol);record["contextChanges"]["transformed"]=json!(payload!=Some(origin.body.clone()));}
    let mut capture = storage::Capture {
        store: route.store.clone(),
        record,
        wire: wire.into(),
        key,
        raw: vec![],
        chunk_receipts: vec![],
        overflow: false,
        done: false,
    };
    if (convert || compact || grok_tools.is_some() || (subscription && !client_stream))
        && response.status().is_success()
    {
        if convert && !is_claude && client_stream && !compact && grok_tools.is_none() {
            return live::responses(
                response,
                capture,
                context,
                provider.clone(),
                route.root.clone(),
                session.into(),
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
                if let Err(e) = continuation::save(&route.root, provider, session, body, &response)
                {
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
                if let Err(e) = continuation::save(&route.root, provider, session, body, &value) {
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
                        if let Ok(ref bytes) = chunk {
                            if let Some(ref mut guard) = capture {
                                let previous = guard.raw.len();
                                guard.chunk(bytes);
                                if native_sse && !terminal_seen {
                                    let tail = &guard.raw[previous.saturating_sub(64)..];
                                    terminal_seen = tail
                                        .windows(b"response.completed".len())
                                        .any(|w| w == b"response.completed");
                                }
                                let json_end = !native_sse
                                    && bytes.iter().rev().find(|b| !b.is_ascii_whitespace())
                                        == Some(&b'}');
                                if !is_claude && !native_chat && !saved && (terminal_seen || json_end) {
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
                                                &root, &provider, &session, body, &value,
                                            ) {
                                                guard.record["contextChanges"]["cacheWarning"] =
                                                    json!(e);
                                            }
                                        }
                                        saved = true;
                                    }
                                }
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
        if protocols.is_some_and(|p| {
            p.as_array().is_some_and(|a| {
                a.iter().any(|v| {
                    v == if incoming == "anthropic-messages" {
                        "anthropic-messages"
                    } else {
                        "openai-responses"
                    }
                })
            })
        }) {
            incoming.into()
        } else if protocols.is_some_and(|p| {
            p.as_array()
                .is_some_and(|a| a.iter().any(|v| v == "chat-completions"))
        }) {
            "chat-completions".into()
        } else if protocols.is_some_and(|p| {
            p.as_array()
                .is_some_and(|a| a.iter().any(|v| v == "anthropic-messages"))
        }) {
            "anthropic-messages".into()
        } else {
            incoming.into()
        }
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
