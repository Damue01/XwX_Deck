//! Claude Code owns browser sign-in in a private configuration directory.
//! The native host keeps each registration isolated and never exports its OAuth token.
use super::*;
use std::process::Stdio;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};
const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
fn random_id() -> Result<String> {
    let mut b = [0u8; 18];
    getrandom::fill(&mut b).map_err(err)?;
    Ok(b.iter().map(|b| format!("{b:02x}")).collect())
}
#[derive(Clone, Serialize, Deserialize)]
struct Account {
    id: String,
    label: String,
    email: String,
    directory: String,
    signed_out: bool,
}
struct Flow {
    id: String,
    url: String,
    status: String,
    error: String,
    account_id: String,
    cancel: tokio::sync::watch::Sender<bool>,
}
#[derive(Clone)]
pub(super) struct ClaudeAccounts {
    root: PathBuf,
    accounts: Arc<Mutex<Vec<Account>>>,
    flow: Arc<Mutex<Option<Flow>>>,
    client: reqwest::Client,
    api: String,
    token_url: String,
    test: bool,
    test_cli: Option<PathBuf>,
}
impl ClaudeAccounts {
    pub async fn usage(&self, id: &str) -> Result<Value> {
        let token = self.credential(id).await?;
        let base = self.api.trim_end_matches("/v1");
        let response = self
            .client
            .get(format!("{base}/api/oauth/usage"))
            .bearer_auth(token)
            .header("anthropic-beta", "oauth-2025-04-20")
            .timeout(Duration::from_secs(8))
            .send()
            .await
            .map_err(|_| "读取 Claude 额度失败")?;
        if !response.status().is_success() {
            return Err(format!(
                "读取 Claude 额度失败（HTTP {}）",
                response.status().as_u16()
            ));
        }
        response
            .json()
            .await
            .map_err(|_| "Claude 额度格式无法识别".into())
    }
    pub fn open(root: &Path, test: bool, base: &str) -> Result<Self> {
        let path = root.join("claude-subscription-accounts.json");
        let accounts: Vec<Account> = read(&path)?
            .map(|s| {
                serde_json::from_str(&s)
                    .map_err(|_| "Claude 账号文件损坏，原文件已保留".to_string())
            })
            .transpose()?
            .unwrap_or_default();
        if accounts.iter().any(|a| {
            !a.directory.starts_with("claude-")
                || a.directory
                    .chars()
                    .any(|c| !(c.is_ascii_alphanumeric() || c == '-'))
        }) {
            return Err("Claude 账号目录无效，原文件已保留".into());
        }
        let args: Vec<_> = std::env::args().collect();
        let test_cli = if test {
            args.iter()
                .position(|a| a == "--claude-subscription-test-cli")
                .and_then(|i| args.get(i + 1))
                .map(PathBuf::from)
        } else {
            None
        };
        let builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(25))
            .redirect(reqwest::redirect::Policy::none());
        Ok(Self {
            root: root.join("claude-subscription-homes"),
            accounts: Arc::new(Mutex::new(accounts)),
            flow: Arc::new(Mutex::new(None)),
            client: if test { builder.no_proxy() } else { builder }
                .build()
                .map_err(err)?,
            api: if test {
                format!("{base}/v1")
            } else {
                "https://api.anthropic.com/v1".into()
            },
            token_url: if test {
                format!("{base}/claude/oauth/token")
            } else {
                "https://platform.claude.com/v1/oauth/token".into()
            },
            test,
            test_cli,
        })
    }
    pub fn executable(&self) -> Option<PathBuf> {
        if self.test {
            return self.test_cli.clone().filter(|p| p.is_file());
        }
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from);
        let mut candidates: Vec<PathBuf> =
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                .map(|p| {
                    p.join(if cfg!(windows) {
                        "claude.exe"
                    } else {
                        "claude"
                    })
                })
                .collect();
        if let Some(home) = home {
            candidates.push(home.join(".local/bin/claude"));
            candidates.push(home.join(".local/bin/claude.exe"));
        }
        candidates.extend([
            PathBuf::from("/opt/homebrew/bin/claude"),
            PathBuf::from("/usr/local/bin/claude"),
        ]);
        candidates.into_iter().find(|p| p.is_file())
    }
    fn command(&self, binary: &Path, directory: &str) -> Command {
        let dir = self.root.join(directory);
        let mut command = Command::new(binary);
        command
            .current_dir(&dir)
            .env("CLAUDE_CONFIG_DIR", &dir)
            .env("CLAUDE_SECURESTORAGE_CONFIG_DIR", &dir)
            .env_remove("CLAUDECODE")
            .env_remove("CLAUDE_CODE_ENTRYPOINT")
            .kill_on_drop(true);
        for key in [
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "ANTHROPIC_MODEL",
            "CLAUDE_CODE_SUBAGENT_MODEL",
        ] {
            command.env_remove(key);
        }
        if self.test {
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
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        command
    }
    fn service(&self, directory: &str) -> String {
        format!(
            "Claude Code-credentials-{}",
            &storage::digest(self.root.join(directory).to_string_lossy().as_bytes())[..8]
        )
    }
    fn credentials(&self, directory: &str) -> Result<(Value, bool)> {
        #[cfg(target_os = "macos")]
        if !self.test {
            let user = std::env::var("USER").unwrap_or_default();
            if let Ok(bytes) =
                security_framework::passwords::get_generic_password(&self.service(directory), &user)
            {
                let value: Value =
                    serde_json::from_slice(&bytes).map_err(|_| "Claude Keychain 登录数据无效")?;
                return Ok((value, true));
            }
        }
        let source = read(&self.root.join(directory).join(".credentials.json"))?
            .ok_or("Claude 账号需要重新登录")?;
        if source.len() > 1024 * 1024 {
            return Err("Claude 登录数据过大".into());
        }
        let value: Value = serde_json::from_str(&source).map_err(|_| "Claude 登录数据无效")?;
        Ok((value, false))
    }
    fn save_credentials(&self, directory: &str, value: &Value, keychain: bool) -> Result<()> {
        let source = serde_json::to_vec(value).map_err(err)?;
        #[cfg(target_os = "macos")]
        if keychain && !self.test {
            return security_framework::passwords::set_generic_password(
                &self.service(directory),
                &std::env::var("USER").unwrap_or_default(),
                &source,
            )
            .map_err(|_| "Claude 登录轮换保存失败".into());
        }
        let _ = keychain;
        write(
            &self.root.join(directory).join(".credentials.json"),
            std::str::from_utf8(&source).map_err(err)?,
        )
    }
    fn save(&self, accounts: &[Account]) -> Result<()> {
        write(
            &self
                .root
                .parent()
                .unwrap()
                .join("claude-subscription-accounts.json"),
            &serde_json::to_string(accounts).map_err(err)?,
        )
    }
    pub async fn snapshot(&self) -> Value {
        let accounts = self.accounts.lock().await;
        let rows:Vec<_>=accounts.iter().map(|a|json!({"id":a.id,"label":a.label,"email":a.email,"platform":"claude","status":if a.signed_out{"signed-out"}else{"connected"}})).collect();
        drop(accounts);
        let flow = self.flow.lock().await;
        json!({"accounts":rows,"installed":self.executable().is_some(),"flow":flow.as_ref().map(|f|json!({"id":f.id,"platform":"claude","status":f.status,"error":f.error,"accountId":f.account_id}))})
    }
    pub async fn cancel(&self) {
        if let Some(flow) = self
            .flow
            .lock()
            .await
            .as_mut()
            .filter(|f| f.status == "waiting" || f.status == "exchanging")
        {
            flow.status = "cancelled".into();
            let _ = flow.cancel.send(true);
        }
    }
    pub async fn authorization_url(&self) -> Result<String> {
        self.flow
            .lock()
            .await
            .as_ref()
            .filter(|f| f.status == "waiting" && !f.url.is_empty())
            .map(|f| f.url.clone())
            .ok_or("没有待完成的 Claude 登录".into())
    }
    fn clear_home(&self, directory: &str) {
        #[cfg(target_os = "macos")]
        if !self.test {
            let _ = security_framework::passwords::delete_generic_password(
                &self.service(directory),
                &std::env::var("USER").unwrap_or_default(),
            );
        }
        let _ = fs::remove_dir_all(self.root.join(directory));
    }
    fn valid_url(&self, raw: &str) -> bool {
        reqwest::Url::parse(raw).is_ok_and(|u| {
            u.username().is_empty()
                && u.password().is_none()
                && if self.test {
                    u.scheme() == "http" && u.host_str() == Some("127.0.0.1")
                } else {
                    u.scheme() == "https"
                        && u.host_str().is_some_and(|h| {
                            ["claude.ai", "console.anthropic.com", "platform.claude.com"]
                                .contains(&h)
                        })
                }
        })
    }
    pub async fn begin(&self, id: &str) -> Result<()> {
        self.cancel().await;
        let binary = self
            .executable()
            .ok_or("请先安装官方 Claude Code，再添加 Claude 订阅账号")?;
        let old = self
            .accounts
            .lock()
            .await
            .iter()
            .find(|a| a.id == id)
            .cloned();
        if !id.is_empty() && old.is_none() {
            return Err("Claude 账号不存在".into());
        }
        let directory = format!("claude-{}", random_id()?);
        let dir = self.root.join(&directory);
        fs::create_dir_all(&dir).map_err(err)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.root, fs::Permissions::from_mode(0o700)).map_err(err)?;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(err)?;
        }
        let url_file = dir.join("opened-url");
        let browser = format!(
            "\"{}\" --subscription-url",
            std::env::current_exe().map_err(err)?.display()
        );
        let mut command = self.command(&binary, &directory);
        command
            .args(["auth", "login", "--claudeai"])
            .env("BROWSER", browser)
            .env("XWX_AUTH_URL_FILE", &url_file)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|_| "无法启动 Claude Code 官方登录")?;
        let (cancel, mut cancelled) = tokio::sync::watch::channel(false);
        let flow_id = random_id()?;
        *self.flow.lock().await = Some(Flow {
            id: flow_id.clone(),
            url: String::new(),
            status: "waiting".into(),
            error: String::new(),
            account_id: String::new(),
            cancel,
        });
        let (url_tx, url_rx) = tokio::sync::oneshot::channel();
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
                    let mut lines = BufReader::new(stream).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        if line.len() > 65536 {
                            break;
                        }
                        if tx.send(line).await.is_err() {
                            break;
                        }
                    }
                });
            }
            drop(lines_tx);
            let mut url_tx = Some(url_tx);
            let deadline = tokio::time::sleep(Duration::from_secs(600));
            tokio::pin!(deadline);
            let mut tick = tokio::time::interval(Duration::from_millis(100));
            let result: Result<()> = loop {
                tokio::select! {_=cancelled.changed()=>{let _=child.kill().await;break Err("登录已取消".into());},_=&mut deadline=>{let _=child.kill().await;break Err("Claude 登录已超时，请重试".into());},_=tick.tick()=>{if let Ok(Some(raw))=read(&url_file){if engine.valid_url(raw.trim()){let mut flow=engine.flow.lock().await;if let Some(flow)=flow.as_mut().filter(|f|f.id==flow_id&&f.status=="waiting"){flow.url=raw.trim().into();if let Some(tx)=url_tx.take(){let _=tx.send(());}}}}},line=lines_rx.recv(),if !lines_rx.is_closed()=>{if let Some(line)=line{for raw in line.split_whitespace().filter(|v|engine.valid_url(v)){let mut flow=engine.flow.lock().await;if let Some(flow)=flow.as_mut().filter(|f|f.id==flow_id&&f.status=="waiting"){flow.url=raw.into();if let Some(tx)=url_tx.take(){let _=tx.send(());}}}}},exit=child.wait()=>{break if exit.is_ok_and(|s|s.success()){Ok(())}else{Err("Claude Code 官方登录未完成，请重试".into())};}}
            };
            let outcome: Result<Account> = async {
                result?;
                let (credentials, _) = engine.credentials(&directory)?;
                let oauth = &credentials["claudeAiOauth"];
                if text(oauth, "accessToken").is_empty() || text(oauth, "refreshToken").is_empty() {
                    return Err("Claude Code 没有返回可用的订阅登录".into());
                }
                let output = tokio::time::timeout(
                    Duration::from_secs(15),
                    engine
                        .command(&binary, &directory)
                        .args(["auth", "status", "--json"])
                        .output(),
                )
                .await
                .map_err(|_| "Claude 账号身份读取超时")?
                .map_err(|_| "Claude 账号身份读取失败")?;
                let status: Value = serde_json::from_slice(&output.stdout)
                    .map_err(|_| "Claude Code 账号身份无效")?;
                if !output.status.success() || status["loggedIn"] != true {
                    return Err(
                        "Claude Code \u{672a}\u{5b8c}\u{6210}\u{8ba2}\u{9605}\u{767b}\u{5f55}"
                            .into(),
                    );
                }
                let email = text(&status, "email");
                if email.is_empty() {
                    return Err("Claude Code 没有返回账号身份".into());
                }
                if old
                    .as_ref()
                    .is_some_and(|a| !a.email.eq_ignore_ascii_case(email))
                {
                    return Err("登录的账号与原账号不一致，原登录已保留".into());
                }
                Ok(Account {
                    id: old
                        .as_ref()
                        .map(|a| a.id.clone())
                        .unwrap_or(format!("claude-subscription-{}", random_id()?)),
                    label: old
                        .as_ref()
                        .map(|a| a.label.clone())
                        .unwrap_or_else(|| "Claude".into()),
                    email: email.into(),
                    directory: directory.clone(),
                    signed_out: false,
                })
            }
            .await;
            let mut accounts = engine.accounts.lock().await;
            let mut flow = engine.flow.lock().await;
            let Some(flow) = flow
                .as_mut()
                .filter(|f| f.id == flow_id && f.status == "waiting")
            else {
                engine.clear_home(&directory);
                return;
            };
            match outcome {
                Ok(mut account) => {
                    if old.is_none() {
                        account.label = format!("Claude-{}", accounts.len() + 1);
                    }
                    let mut next = accounts.clone();
                    next.retain(|a| a.id != account.id);
                    next.push(account.clone());
                    match engine.save(&next) {
                        Ok(()) => {
                            *accounts = next;
                            flow.status = "complete".into();
                            flow.account_id = account.id;
                            if let Some(old) = old {
                                engine.clear_home(&old.directory);
                            }
                        }
                        Err(error) => {
                            flow.status = "failed".into();
                            flow.error = error;
                            engine.clear_home(&directory);
                        }
                    }
                }
                Err(error) => {
                    flow.status = "failed".into();
                    flow.error = error;
                    engine.clear_home(&directory);
                }
            }
        });
        match tokio::time::timeout(Duration::from_secs(20), url_rx).await {
            Ok(Ok(())) => Ok(()),
            _ => {
                self.cancel().await;
                Err("Claude Code 没有返回可打开的官方授权地址，请重试".into())
            }
        }
    }
    pub fn api(&self) -> &str {
        &self.api
    }
    pub async fn provider(&self, id: &str) -> Result<Provider> {
        let accounts = self.accounts.lock().await;
        let a = accounts
            .iter()
            .find(|a| a.id == id)
            .ok_or("Claude 账号不存在")?;
        Ok(Provider {
            id: format!("subscription-{id}"),
            display_name: a.label.clone(),
            subscription_account_id: id.into(),
            account_label: a.email.clone(),
            codex_provider_id: "xwx_deck".into(),
            base_url: self.api.clone(),
            adapter: "anthropic-messages".into(),
            codex_api_format: "responses".into(),
            provider_preset: "auto".into(),
            claude_models: json!({"fable":"","opus":"","sonnet":"","haiku":""}),
            ..Default::default()
        })
    }
    pub async fn credential(&self, id: &str) -> Result<String> {
        let mut accounts = self.accounts.lock().await;
        let index = accounts
            .iter()
            .position(|a| a.id == id)
            .ok_or("Claude 账号不存在")?;
        if accounts[index].signed_out {
            return Err("Claude 账号需要重新登录".into());
        }
        let (mut value, keychain) = self.credentials(&accounts[index].directory)?;
        let oauth = &value["claudeAiOauth"];
        if oauth["expiresAt"].as_u64().unwrap_or(0) < millis() as u64 + 60000 {
            let refresh = text(oauth, "refreshToken");
            if refresh.is_empty() {
                return Err("Claude 账号需要重新登录".into());
            }
            let response=self.client.post(&self.token_url).json(&json!({"grant_type":"refresh_token","refresh_token":refresh,"client_id":CLIENT_ID})).send().await.map_err(|_|"Claude 授权刷新连接失败")?;
            if !response.status().is_success() {
                if [400, 401].contains(&response.status().as_u16()) {
                    let mut next = accounts.clone();
                    next[index].signed_out = true;
                    self.save(&next)?;
                    *accounts = next;
                }
                return Err("Claude 授权刷新未完成，请重新登录".into());
            }
            let tokens: Value = response
                .json()
                .await
                .map_err(|_| "Claude 授权刷新响应无效")?;
            let access = text(&tokens, "access_token");
            if access.is_empty() {
                return Err("Claude 没有返回新的订阅授权".into());
            }
            value["claudeAiOauth"]["accessToken"] = json!(access);
            if !text(&tokens, "refresh_token").is_empty() {
                value["claudeAiOauth"]["refreshToken"] = tokens["refresh_token"].clone();
            }
            value["claudeAiOauth"]["expiresAt"] =
                json!(millis() as u64 + tokens["expires_in"].as_u64().unwrap_or(3600) * 1000);
            self.save_credentials(&accounts[index].directory, &value, keychain)?;
        }
        let token = text(&value["claudeAiOauth"], "accessToken");
        if token.is_empty() {
            return Err("Claude 账号需要重新登录".into());
        }
        Ok(token.into())
    }
    pub async fn rename(&self, id: &str, label: &str) -> Result<()> {
        let mut accounts = self.accounts.lock().await;
        let mut next = accounts.clone();
        next.iter_mut()
            .find(|a| a.id == id)
            .ok_or("Claude 账号不存在")?
            .label = label.into();
        self.save(&next)?;
        *accounts = next;
        Ok(())
    }
    pub async fn sign_out(&self, id: &str) -> Result<Value> {
        let mut accounts = self.accounts.lock().await;
        let mut next = accounts.clone();
        let a = next
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or("Claude 账号不存在")?;
        a.signed_out = true;
        let directory = a.directory.clone();
        self.save(&next)?;
        self.clear_home(&directory);
        *accounts = next;
        Ok(
            json!({"revoked":false,"warning":"已退出此隔离 Claude 账号；其他客户端的登录保持不变。"}),
        )
    }
    pub fn headers() -> Vec<(&'static str, String)> {
        vec![
            ("anthropic-version", "2023-06-01".into()),
            (
                "anthropic-beta",
                "claude-code-20250219,oauth-2025-04-20".into(),
            ),
        ]
    }
}
