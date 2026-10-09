//! Grok Build owns authorization and refresh. Each account has its own CLI home.
//! Protocol references: x.ai/cli and yetone/magpie (MIT, see THIRD_PARTY_NOTICES).
use super::*;
use std::collections::HashMap;
use std::process::Stdio;
use tokio::{io::AsyncReadExt, process::Command};

#[derive(Clone, Serialize, Deserialize)]
struct Registration {
    id: String,
    label: String,
    email: String,
}
struct Login {
    id: String,
    status: String,
    error: String,
    url: String,
    account_id: String,
    cancel: tokio::sync::watch::Sender<bool>,
}
#[derive(Clone)]
pub(super) struct GrokAccounts {
    root: PathBuf,
    registrations: Arc<Mutex<Vec<Registration>>>,
    flow: Arc<Mutex<Option<Login>>>,
    refresh: Arc<Mutex<()>>,
    version: Arc<Mutex<Option<String>>>,
    test_cli: Option<PathBuf>,
    api: String,
    proxy: Option<String>,
}
impl GrokAccounts {
    pub fn open(root: &Path, test: bool, test_api: &str) -> Result<Self> {
        let dir = root.join("grok-accounts");
        let registrations = match read(&dir.join("accounts.json"))? {
            Some(s) => serde_json::from_str(&s).map_err(|_| "Grok 账号文件损坏，原文件已保留")?,
            None => vec![],
        };
        let registrations: Vec<Registration> = registrations;
        if registrations.iter().any(|a| {
            a.id.len() != 41
                || !a.id.starts_with("grok-")
                || !a.id[5..].chars().all(|c| c.is_ascii_hexdigit())
        }) {
            return Err("Grok 账号标识无效，原文件已保留".into());
        }
        let args: Vec<_> = std::env::args().collect();
        let test_cli = args
            .iter()
            .position(|a| a == "--subscription-test-grok-cli")
            .and_then(|i| args.get(i + 1))
            .map(PathBuf::from);
        if test_cli.is_some() && (!test || test_cli.as_ref().is_some_and(|p| !p.is_absolute())) {
            return Err("Grok 测试命令仅允许隔离订阅 RPC 回归".into());
        }
        let proxy = if test { None } else { cli_proxy() };
        Ok(Self {
            root: dir,
            registrations: Arc::new(Mutex::new(registrations)),
            flow: Arc::new(Mutex::new(None)),
            refresh: Arc::new(Mutex::new(())),
            version: Arc::new(Mutex::new(None)),
            test_cli,
            proxy,
            api: if test {
                format!("{}/grok/v1", test_api.trim_end_matches("/v1"))
            } else {
                "https://cli-chat-proxy.grok.com/v1".into()
            },
        })
    }
    fn executable(&self) -> Option<PathBuf> {
        if let Some(p) = &self.test_cli {
            return p.is_file().then(|| p.clone());
        }
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)?;
        let name = if cfg!(windows) { "grok.exe" } else { "grok" };
        let installed = home.join(".grok/bin").join(name);
        if installed.is_file() {
            return Some(installed);
        }
        std::env::var_os("PATH")
            .into_iter()
            .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
            .map(|p| p.join(name))
            .find(|p| {
                p.is_file()
                    && fs::canonicalize(p)
                        .is_ok_and(|p| p.to_string_lossy().replace('\\', "/").contains("/.grok/"))
            })
    }
    fn command(&self, binary: &Path, id: &str) -> Command {
        let mut command = Command::new(binary);
        command
            .env_remove("GROK_AUTH_PROVIDER_COMMAND")
            .env_remove("GROK_AUTH_EXPIRED")
            .env("GROK_HOME", self.root.join(id))
            .current_dir(&self.root)
            .kill_on_drop(true)
            .stdin(Stdio::null());
        if self.test_cli.is_some() {
            for key in [
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "http_proxy",
                "https_proxy",
                "all_proxy",
            ] {
                command.env_remove(key);
            }
        } else if let Some(proxy) = &self.proxy {
            command.env("HTTPS_PROXY", proxy).env("HTTP_PROXY", proxy);
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        command
    }
    fn auth(&self, id: &str) -> Result<Value> {
        let path = self.root.join(id).join("auth.json");
        let source = read(&path)?.ok_or("Grok 账号需要重新登录")?;
        if source.len() > 1024 * 1024 {
            return Err("Grok 登录数据过大".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(err)?;
        }
        let all: Value = serde_json::from_str(&source).map_err(|_| "Grok 登录数据无效")?;
        all.as_object()
            .and_then(|m| m.values().find(|v| !text(v, "key").is_empty()))
            .cloned()
            .ok_or("Grok 账号需要重新登录".into())
    }
    pub fn api(&self) -> &str {
        &self.api
    }
    pub async fn snapshot(&self) -> Value {
        let registrations = self.registrations.lock().await;
        let accounts: Vec<_> = registrations.iter().map(|a| json!({"id":a.id,"label":a.label,"email":a.email,"platform":"grok","status":if self.auth(&a.id).is_ok(){"connected"}else{"signed-out"}})).collect();
        drop(registrations);
        let flow = self.flow.lock().await;
        json!({"accounts":accounts,"installed":self.executable().is_some(),"flow":flow.as_ref().map(|f|json!({"id":f.id,"platform":"grok","status":f.status,"error":f.error,"accountId":f.account_id}))})
    }
    pub async fn cancel(&self) {
        if let Some(f) = self
            .flow
            .lock()
            .await
            .as_mut()
            .filter(|f| f.status == "waiting" || f.status == "exchanging")
        {
            f.status = "cancelled".into();
            let _ = f.cancel.send(true);
        }
    }
    pub async fn authorization_url(&self) -> Result<String> {
        self.flow
            .lock()
            .await
            .as_ref()
            .filter(|f| f.status == "waiting" && !f.url.is_empty())
            .map(|f| f.url.clone())
            .ok_or("没有待完成的 Grok 登录".into())
    }
    fn save(&self, accounts: &[Registration]) -> Result<()> {
        write(
            &self.root.join("accounts.json"),
            &serde_json::to_string(accounts).map_err(err)?,
        )
    }
    pub async fn begin(&self, id: &str) -> Result<()> {
        let binary = self
            .executable()
            .ok_or("请先从官方下载页面安装 Grok Build，再添加订阅账号")?;
        self.cancel().await;
        let existing = self
            .registrations
            .lock()
            .await
            .iter()
            .find(|a| a.id == id)
            .cloned();
        if !id.is_empty() && existing.is_none() {
            return Err("Grok 账号不存在".into());
        }
        // Re-login uses a staging home so a cancelled or wrong-account login cannot replace credentials.
        let account_id = format!("grok-{}", random_id()?);
        let dir = self.root.join(&account_id);
        fs::create_dir_all(&dir).map_err(err)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.root, fs::Permissions::from_mode(0o700)).map_err(err)?;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(err)?;
        }
        let mut child = self
            .command(&binary, &account_id)
            .args(["login", "--device-auth"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| "无法启动 Grok Build 登录")?;
        let (cancel, mut cancelled) = tokio::sync::watch::channel(false);
        let flow_id = random_id()?;
        *self.flow.lock().await = Some(Login {
            id: flow_id.clone(),
            status: "waiting".into(),
            error: String::new(),
            url: String::new(),
            account_id: String::new(),
            cancel,
        });
        let (link_tx, link_rx) = tokio::sync::oneshot::channel();
        let engine = self.clone();
        tokio::spawn(async move {
            let (lines_tx, mut lines_rx) = tokio::sync::mpsc::channel::<String>(16);
            for stream in [
                child
                    .stdout
                    .take()
                    .map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
                child
                    .stderr
                    .take()
                    .map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
            ]
            .into_iter()
            .flatten()
            {
                let tx = lines_tx.clone();
                tokio::spawn(async move {
                    scan_lines(stream, tx).await;
                });
            }
            drop(lines_tx);
            let mut link_tx = Some(link_tx);
            let deadline = tokio::time::sleep(Duration::from_secs(600));
            tokio::pin!(deadline);
            let result = loop {
                tokio::select! {
                    _=cancelled.changed()=>{ let _=child.kill().await; break Err("登录已取消".to_string()); },
                    _=&mut deadline=>{ let _=child.kill().await; break Err("Grok 登录已超时，请重试".to_string()); },
                    line=lines_rx.recv(), if !lines_rx.is_closed()=>{ if let Some(line)=line { if let Some(url)=engine.login_link(&line) { let mut flow=engine.flow.lock().await; if let Some(f)=flow.as_mut().filter(|f|f.id==flow_id && f.status=="waiting") { f.url=url.clone(); if let Some(tx)=link_tx.take(){let _=tx.send(url);} } } } },
                    exit=child.wait()=>{ break if exit.is_ok_and(|s|s.success()) { Ok(()) } else { Err("Grok 官方登录未完成，请重试".to_string()) }; }
                }
            };
            let mut flow = engine.flow.lock().await;
            if flow
                .as_ref()
                .is_none_or(|f| f.id != flow_id || f.status != "waiting")
            {
                let _ = fs::remove_dir_all(&dir);
                return Ok::<(), String>(());
            }
            let result = result.and_then(|_| {
                let auth = engine.auth(&account_id)?;
                let email = text(&auth, "email");
                if email.is_empty() {
                    return Err("Grok 登录没有返回账号身份".into());
                }
                if existing
                    .as_ref()
                    .is_some_and(|a| !a.email.eq_ignore_ascii_case(email))
                {
                    return Err("登录的账号与原账号不一致，原登录已保留".into());
                }
                Ok(email.to_string())
            });
            let result = async {
                match result {
                    Ok(email) => {
                        let mut accounts = engine.registrations.lock().await;
                        let mut next = accounts.clone();
                        let saved = if let Some(a) = existing {
                            let target = engine.root.join(&a.id);
                            let auth =
                                read(&dir.join("auth.json"))?.ok_or("Grok 登录数据不存在")?;
                            write(&target.join("auth.json"), &auth)?;
                            let _ = fs::remove_dir_all(&dir);
                            next.iter().find(|old| old.id == a.id).cloned().unwrap_or(a)
                        } else {
                            Registration {
                                id: account_id.clone(),
                                label: format!("Grok-{}", next.len() + 1),
                                email,
                            }
                        };
                        next.retain(|a| a.id != saved.id);
                        next.push(saved.clone());
                        engine.save(&next)?;
                        *accounts = next;
                        Ok(saved.id)
                    }
                    Err(e) => Err(e),
                }
            }
            .await;
            let f = flow.as_mut().unwrap();
            match result {
                Ok(id) => {
                    f.status = "complete".into();
                    f.account_id = id;
                }
                Err(e) => {
                    f.status = "failed".into();
                    f.error = e;
                    let _ = fs::remove_dir_all(&dir);
                }
            }
            Ok::<(), String>(())
        });
        match tokio::time::timeout(Duration::from_secs(20), link_rx).await {
            Ok(Ok(_)) => Ok(()),
            _ => {
                self.cancel().await;
                Err("Grok Build 没有返回可打开的官方授权地址，请重试".into())
            }
        }
    }
    fn login_link(&self, line: &str) -> Option<String> {
        line.split_whitespace()
            .filter_map(|piece| {
                let start = piece.find("https://").or_else(|| {
                    if self.test_cli.is_some() {
                        piece.find("http://")
                    } else {
                        None
                    }
                })?;
                let raw = piece[start..]
                    .split('\u{1b}')
                    .next()?
                    .trim_end_matches([')', ']', '\'', '"', ',', ';']);
                let url = reqwest::Url::parse(raw).ok()?;
                let host = url.host_str()?;
                let official = url.scheme() == "https"
                    && (host == "accounts.x.ai"
                        || host == "auth.x.ai"
                        || host == "grok.com"
                        || host.ends_with(".grok.com"));
                let fixture =
                    self.test_cli.is_some() && url.scheme() == "http" && host == "127.0.0.1";
                (url.username().is_empty() && url.password().is_none() && (official || fixture))
                    .then(|| url.to_string())
            })
            .next()
    }
    pub async fn credential(&self, id: &str) -> Result<String> {
        let _refresh = self.refresh.lock().await;
        if !self.registrations.lock().await.iter().any(|a| a.id == id) {
            return Err("Grok 账号不存在".into());
        }
        let mut auth = self.auth(id)?;
        let expires = chrono::DateTime::parse_from_rfc3339(text(&auth, "expires_at"))
            .map_err(|_| "Grok 登录有效期无效")?
            .timestamp();
        if expires <= (millis() / 1000) as i64 + 300 {
            let binary = self
                .executable()
                .ok_or("请重新安装 Grok Build 来刷新订阅登录")?;
            let status = tokio::time::timeout(
                Duration::from_secs(30),
                self.command(&binary, id)
                    .arg("models")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status(),
            )
            .await
            .map_err(|_| "Grok 刷新登录超时")?
            .map_err(|_| "无法刷新 Grok 登录")?;
            if !status.success() {
                return Err("Grok 刷新登录失败，请重新登录".into());
            }
            auth = self.auth(id)?;
        }
        let expires = chrono::DateTime::parse_from_rfc3339(text(&auth, "expires_at"))
            .map_err(|_| "Grok 登录有效期无效")?
            .timestamp();
        if expires <= (millis() / 1000) as i64 {
            return Err("Grok 订阅登录已过期，请重新登录".into());
        }
        Ok(text(&auth, "key").into())
    }
    pub async fn provider(&self, id: &str) -> Result<Provider> {
        let accounts = self.registrations.lock().await;
        let a = accounts
            .iter()
            .find(|a| a.id == id)
            .ok_or("Grok 账号不存在")?;
        Ok(Provider {
            id: format!("subscription-{id}"),
            display_name: a.label.clone(),
            subscription_account_id: a.id.clone(),
            account_label: a.email.clone(),
            codex_provider_id: "xwx_deck".into(),
            base_url: self.api.clone(),
            adapter: "responses".into(),
            codex_api_format: "responses".into(),
            provider_preset: "auto".into(),
            claude_models: json!({"fable":"","opus":"","sonnet":"","haiku":""}),
            ..Default::default()
        })
    }
    pub async fn headers(&self) -> Result<Vec<(&'static str, String)>> {
        let mut version = self.version.lock().await;
        if version.is_none() {
            let binary = self.executable().ok_or("请安装 Grok Build")?;
            let output = tokio::time::timeout(
                Duration::from_secs(5),
                Command::new(binary)
                    .arg("version")
                    .kill_on_drop(true)
                    .output(),
            )
            .await
            .map_err(|_| "读取 Grok Build 版本超时")?
            .map_err(|_| "无法读取 Grok Build 版本")?;
            let output = String::from_utf8_lossy(&output.stdout);
            let found = output
                .split(|c: char| !c.is_ascii_digit() && c != '.')
                .find(|p| {
                    p.split('.').count() == 3
                        && p.len() < 30
                        && p.split('.')
                            .all(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
                })
                .ok_or("无法识别 Grok Build 版本，请更新官方客户端")?;
            *version = Some(found.to_string());
        }
        let version = version.as_ref().unwrap();
        Ok(vec![
            ("x-grok-client-version", version.clone()),
            ("x-xai-token-auth", "xai-grok-cli".into()),
            ("x-grok-client-identifier", "grok-shell".into()),
            ("x-grok-client-mode", "headless".into()),
            (
                "user-agent",
                format!(
                    "grok-shell/{version} ({}; {})",
                    if cfg!(target_os = "macos") {
                        "macos"
                    } else {
                        std::env::consts::OS
                    },
                    if cfg!(target_arch = "aarch64") {
                        "aarch64"
                    } else {
                        "x86_64"
                    }
                ),
            ),
        ])
    }
    pub async fn rename(&self, id: &str, label: &str) -> Result<()> {
        let mut accounts = self.registrations.lock().await;
        let mut next = accounts.clone();
        let a = next
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or("Grok 账号不存在")?;
        a.label = label.into();
        self.save(&next)?;
        *accounts = next;
        Ok(())
    }
    pub async fn sign_out(&self, id: &str) -> Result<Value> {
        if !self.registrations.lock().await.iter().any(|a| a.id == id) {
            return Err("Grok 账号不存在".into());
        }
        self.cancel().await;
        let path = self.root.join(id).join("auth.json");
        if path.exists() {
            fs::remove_file(path).map_err(err)?;
        }
        Ok(json!({"revoked":false,"warning":"已退出本机 Grok 登录"}))
    }
}
fn random_id() -> Result<String> {
    let mut bytes = [0; 18];
    getrandom::fill(&mut bytes).map_err(|_| "无法生成账号标识")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn cli_proxy() -> Option<String> {
    if [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ]
    .iter()
    .any(|k| std::env::var_os(k).is_some())
    {
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/sbin/scutil")
            .arg("--proxy")
            .output()
            .ok()?;
        let data = String::from_utf8(output.stdout).ok()?;
        let values: HashMap<_, _> = data
            .lines()
            .filter_map(|line| line.split_once(':').map(|(k, v)| (k.trim(), v.trim())))
            .collect();
        for prefix in ["HTTPS", "HTTP"] {
            if values.get(format!("{prefix}Enable").as_str()) != Some(&"1") {
                continue;
            }
            let host = *values.get(format!("{prefix}Proxy").as_str())?;
            let port = *values.get(format!("{prefix}Port").as_str())?;
            let url = reqwest::Url::parse(&format!("http://{host}:{port}")).ok()?;
            if url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.port().is_some()
            {
                return Some(url.to_string());
            }
        }
    }
    None
}
async fn scan_lines(
    mut reader: Box<dyn tokio::io::AsyncRead + Unpin + Send>,
    tx: tokio::sync::mpsc::Sender<String>,
) {
    let mut buffer = [0; 4096];
    let mut line = Vec::new();
    loop {
        let n = match reader.read(&mut buffer).await {
            Ok(n) if n > 0 => n,
            _ => break,
        };
        for b in &buffer[..n] {
            if *b == b'\n' {
                let s = String::from_utf8_lossy(&line).into_owned();
                line.clear();
                if tx.send(s).await.is_err() {
                    return;
                }
            } else if line.len() < 16384 {
                line.push(*b);
            }
        }
    }
    if !line.is_empty() {
        let _ = tx.send(String::from_utf8_lossy(&line).into_owned()).await;
    }
}
