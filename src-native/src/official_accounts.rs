//! Official Codex accounts. The existing client login is read-only until explicit sign-out; new logins
//! use a private app-server home and Deck-owned private credential files.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use std::process::Stdio;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

pub(super) fn is_official(id: &str) -> bool {
    id == "official-chatgpt" || id.starts_with("official-chatgpt-")
}
fn identity(auth: &Value) -> Value {
    auth["tokens"]["id_token"]
        .as_str()
        .and_then(|s| s.split('.').nth(1))
        .and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}
fn account_id(auth: &Value) -> &str {
    auth["tokens"]["account_id"]
        .as_str()
        .or_else(|| auth["account_id"].as_str())
        .unwrap_or("")
}
pub(super) fn account_key(auth: &Value) -> String {
    let claims = identity(auth);
    storage::digest(
        format!(
            "{}\0{}\0{}",
            account_id(auth),
            text(&claims, "sub"),
            text(&claims, "email")
        )
        .as_bytes(),
    )
}
pub(super) fn metadata(id: &str, auth: &Value) -> Value {
    let claims = identity(auth);
    let email = text(&claims, "email");
    let label = claims["name"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(if email.is_empty() { "ChatGPT" } else { email });
    json!({"id":id,"platform":"chatgpt","authKind":"official","accountKey":account_key(auth),"externalLogin":id=="official-chatgpt","label":label,"email":email,
        "status":if text(&auth["tokens"],"access_token").is_empty(){"signed-out"}else{"connected"}})
}
#[derive(Clone, Serialize, Deserialize)]
struct Entry {
    id: String,
    auth: Value,
}
#[derive(Default)]
struct State {
    entries: Vec<Entry>,
    expected_disk: Option<String>,
    flow: Value,
    url: String,
    cancel: Option<tokio::sync::watch::Sender<bool>>,
}
#[derive(Clone)]
pub(super) struct OfficialAccounts {
    root: PathBuf,
    home: PathBuf,
    path: PathBuf,
    state: Arc<Mutex<State>>,
    operations: Arc<Mutex<()>>,
    test: bool,
    isolated: bool,
    usage_url: String,
}
struct Server {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    home: credentials::CliHome,
    serial: u64,
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}
impl Server {
    async fn start(root: &Path, executable: &Path, auth: Option<&Value>) -> Result<Self> {
        let mut home = credentials::CliHome::create(root)?;
        if let Some(auth) = auth {
            home.put("auth.json", &auth.to_string())?;
        }
        let mut command = Command::new(executable);
        command
            .arg("app-server")
            .arg("-c")
            .arg("cli_auth_credentials_store=\"file\"")
            .env("CODEX_HOME", &home.path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = home.spawn(&mut command)?;
        let input = child.stdin.take().ok_or("官方登录通道不可用")?;
        let output = BufReader::new(child.stdout.take().ok_or("官方登录响应通道不可用")?);
        let mut server = Self {
            child,
            input,
            output,
            home,
            serial: 0,
        };
        server.call("initialize",json!({"clientInfo":{"name":"xwx_deck","title":"XwX Deck","version":"1.1.7"},"capabilities":{"experimentalApi":true}})).await?;
        server
            .send(json!({"method":"initialized","params":{}}))
            .await?;
        Ok(server)
    }
    async fn send(&mut self, value: Value) -> Result<()> {
        self.input
            .write_all(format!("{value}\n").as_bytes())
            .await
            .map_err(|_| "官方登录通道已关闭")?;
        self.input
            .flush()
            .await
            .map_err(|_| "官方登录通道已关闭".into())
    }
    async fn next(&mut self) -> Result<Value> {
        // Bound individual records; account APIs do not produce large streams.
        let mut bytes = Vec::new();
        let n = tokio::io::AsyncBufReadExt::read_until(
            &mut (&mut self.output).take(1024 * 1024 + 1),
            b'\n',
            &mut bytes,
        )
        .await
        .map_err(|_| "官方登录响应中断")?;
        if n == 0 || bytes.len() > 1024 * 1024 {
            return Err("官方登录响应无法读取".into());
        }
        serde_json::from_slice(&bytes).map_err(|_| "官方登录响应无法识别".into())
    }
    async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        self.serial += 1;
        let id = self.serial;
        self.send(json!({"id":id,"method":method,"params":params}))
            .await?;
        tokio::time::timeout(Duration::from_secs(25),async {
            loop {
                let value=self.next().await?;
                if value["id"]==id {
                    if !value["error"].is_null(){return Err(format!("官方账号操作未完成（{}），请重试；若持续失败，请更新官方客户端",value["error"]["code"].as_i64().unwrap_or(-1)));}
                    return Ok(value["result"].clone());
                }
                if value.get("id").is_some() && value.get("method").is_some() {
                    self.send(json!({"id":value["id"],"error":{"code":-32000,"message":"Refresh credentials in the official client, then retry"}})).await?;
                }
            }
        }).await.map_err(|_|"官方账号操作超时，请重试")?
    }
    async fn stop(&mut self) {
        let _ = self.child.kill().await;
        if self.child.wait().await.is_ok() {
            self.home.exited();
        }
    }
    fn auth(&self) -> Result<Value> {
        read(&self.home.path.join("auth.json"))?
            .map(|s| serde_json::from_str(&s).map_err(|_| "官方登录文件无法识别".to_string()))
            .transpose()?
            .ok_or("官方登录尚未保存，请重新登录".into())
    }
}
impl OfficialAccounts {
    pub fn open(root: &Path, isolated: bool, test: bool, usage_url: String) -> Result<Self> {
        let home = if isolated {
            root.join("codex")
        } else {
            std::env::var("CODEX_HOME")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| Pilot::home().join(".codex"))
        };
        let path = root.join("official-chatgpt-accounts.json");
        let expected_disk = read(&path)?;
        let entries = expected_disk
            .as_ref()
            .map(|s| serde_json::from_str(s).map_err(|_| "官方账号库无法读取，原文件已保留"))
            .transpose()?
            .unwrap_or_default();
        Ok(Self {
            root: root.into(),
            home,
            path,
            state: Arc::new(Mutex::new(State {
                entries,
                expected_disk,
                ..Default::default()
            })),
            operations: Arc::new(Mutex::new(())),
            test,
            isolated,
            usage_url,
        })
    }
    fn save_entries(&self, state: &mut State, entries: Vec<Entry>) -> Result<()> {
        if read(&self.path)? != state.expected_disk {
            return Err("官方账号库已在外部修改，原文件已保留，请重新打开应用后重试".into());
        }
        let serialized = serde_json::to_string(&entries).map_err(err)?;
        write(&self.path, &serialized)?;
        state.expected_disk = Some(serialized);
        state.entries = entries;
        Ok(())
    }
    fn executable(&self) -> Option<PathBuf> {
        if self.test {
            let args: Vec<_> = std::env::args().collect();
            if let Some(path) = args
                .iter()
                .position(|s| s == "--official-chatgpt-test-cli")
                .and_then(|i| args.get(i + 1))
            {
                return Some(PathBuf::from(path));
            }
        }
        let discovery = if self.isolated {
            client_installations::Discovery::for_home(&self.root.join("installations"))
        } else {
            client_installations::Discovery::system()
        };
        let settings = read(&self.root.join("settings.json"))
            .ok()
            .flatten()
            .and_then(|source| serde_json::from_str::<Value>(&source).ok())
            .unwrap_or(json!({}));
        let locations = settings
            .as_object()
            .map(|settings| {
                client_installations::manual_locations(
                    settings,
                    self.isolated.then_some(self.root.as_path()),
                )
            })
            .unwrap_or_default();
        discovery
            .with_manual_locations(locations)
            .codex_executable()
    }
    fn local(&self) -> Result<Value> {
        read(&self.home.join("auth.json"))?
            .map(|s| serde_json::from_str(&s).map_err(|_| "官方登录文件无法识别".to_string()))
            .transpose()
            .map(|v| v.unwrap_or(Value::Null))
    }
    // A detected client login is not consent to join Deck's account pool.
    // Preserve older explicit provider/routing selections of the shared login.
    fn local_selected(&self) -> bool {
        let document = |name: &str| -> Value {
            read(&self.root.join(name))
                .ok()
                .flatten()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(Value::Null)
        };
        let settings = document("settings.json");
        let routing = document("subscription-routing.json");
        settings["connections"].as_array().is_some_and(|rows| {
            rows.iter()
                .any(|row| row["subscriptionAccountId"] == "official-chatgpt")
        }) || routing.as_object().is_some_and(|groups| {
            groups.values().any(|policy| {
                policy["fixedAccountId"] == "official-chatgpt"
                    || ["accountOrder", "excludedAccountIds"].iter().any(|key| {
                        policy[key]
                            .as_array()
                            .is_some_and(|ids| ids.iter().any(|id| id == "official-chatgpt"))
                    })
            })
        })
    }
    pub async fn snapshot(&self) -> Value {
        let state = self.state.lock().await;
        let mut accounts = vec![];
        if let Ok(auth) = self.local() {
            if self.local_selected() && !text(&auth["tokens"], "access_token").is_empty() {
                accounts.push(metadata("official-chatgpt", &auth));
            }
        }
        accounts.extend(state.entries.iter().map(|a| metadata(&a.id, &a.auth)));
        for account in imported_subscriptions::registrations(&self.root)
            .unwrap_or_default()
            .into_iter()
            .filter(|a| a.kind == "official")
        {
            if !accounts
                .iter()
                .any(|old| old["accountKey"] == account.identity)
            {
                accounts.push(account.metadata(&self.root, self.isolated));
            }
        }
        for account in &mut accounts {
            official_usage_cache::apply(&self.root, account);
        }
        json!({"accounts":accounts,"flow":state.flow,"installed":self.executable().is_some()})
    }
    async fn auth_for(&self, id: &str) -> Result<Value> {
        if imported_subscriptions::is_imported(id) {
            return imported_subscriptions::find(&self.root, id)?.auth(&self.root, self.isolated);
        }
        if id == "official-chatgpt" {
            return self.local();
        }
        self.state
            .lock()
            .await
            .entries
            .iter()
            .find(|a| a.id == id)
            .map(|a| a.auth.clone())
            .ok_or("官方账号不存在".into())
    }
    async fn persist_auth(&self, id: &str, auth: Value) -> Result<()> {
        if id == "official-chatgpt" {
            return Ok(());
        }
        let mut state = self.state.lock().await;
        let mut entries = state.entries.clone();
        let entry = entries
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or("官方账号已退出，请重新登录")?;
        if account_id(&entry.auth) != account_id(&auth) {
            return Err("官方账号身份发生变化，请重新登录".into());
        }
        entry.auth = auth;
        self.save_entries(&mut state, entries)?;
        Ok(())
    }
    pub async fn credential(&self, id: &str) -> Result<String> {
        let _operation = self.operations.lock().await;
        let mut auth = self.auth_for(id).await?;
        if id != "official-chatgpt" && !imported_subscriptions::is_imported(id) {
            let expires = text(&auth["tokens"], "access_token")
                .split('.')
                .nth(1)
                .and_then(|part| URL_SAFE_NO_PAD.decode(part).ok())
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .and_then(|claims| claims["exp"].as_u64())
                .unwrap_or(0);
            if expires > (millis() / 1000) as u64 + 120 {
                return Ok(text(&auth["tokens"], "access_token").into());
            }
            let executable = self.executable().ok_or(
                "未找到官方客户端的账号接口，请更新 ChatGPT / Codex 桌面版或 Codex CLI 后重试",
            )?;
            let mut server = Server::start(&self.root, &executable, Some(&auth)).await?;
            let result = server
                .call("account/read", json!({"refreshToken":true}))
                .await;
            let updated = server.auth();
            server.stop().await;
            auth = updated?;
            self.persist_auth(id, auth.clone()).await?;
            result?;
        }
        let token = text(&auth["tokens"], "access_token");
        if token.is_empty() {
            Err("请重新登录此官方账号".into())
        } else {
            Ok(token.into())
        }
    }
    pub async fn headers(
        &self,
        id: &str,
        token: Option<&str>,
    ) -> Result<Vec<(&'static str, String)>> {
        let auth = self.auth_for(id).await?;
        if token.is_some_and(|token| token != text(&auth["tokens"], "access_token")) {
            return Err("官方登录已变化，请重试".into());
        }
        let id = account_id(&auth);
        Ok(if id.is_empty() {
            vec![]
        } else {
            vec![("ChatGPT-Account-Id", id.into())]
        })
    }
    pub async fn provider(&self, id: &str, base: String) -> Result<Provider> {
        let account = metadata(id, &self.auth_for(id).await?);
        Ok(Provider {
            id: format!("subscription-{id}"),
            display_name: text(&account, "label").into(),
            subscription_account_id: id.into(),
            account_label: text(&account, "email").into(),
            codex_provider_id: "xwx_deck".into(),
            base_url: base,
            adapter: "responses".into(),
            codex_api_format: "responses".into(),
            oauth: true,
            ..Default::default()
        })
    }
    pub async fn begin(&self, target: &str) -> Result<()> {
        if target == "official-chatgpt" {
            return Err("请在 ChatGPT 或 Codex 中管理现有登录；添加账号会保留此登录".into());
        }
        let executable = self.executable().ok_or(
            "未找到官方客户端的账号接口，请更新 ChatGPT / Codex 桌面版或 Codex CLI 后添加账号",
        )?;
        let mut server = Server::start(&self.root, &executable, None).await?;
        let result = server
            .call(
                "account/login/start",
                json!({"type":"chatgpt","useHostedLoginSuccessPage":true,"appBrand":"chatgpt"}),
            )
            .await?;
        let login_id = text(&result, "loginId").to_string();
        let url = text(&result, "authUrl").to_string();
        if login_id.is_empty() || !url.starts_with("https://auth.openai.com/") && !self.test {
            server.stop().await;
            return Err("官方登录地址无法识别，请更新 Codex CLI".into());
        }
        let (cancel, mut cancelled) = tokio::sync::watch::channel(false);
        {
            let mut state = self.state.lock().await;
            state.flow = json!({"id":login_id,"platform":"chatgpt","authKind":"official","status":"waiting"});
            state.url = url;
            state.cancel = Some(cancel);
        }
        let accounts = self.clone();
        let target = target.to_string();
        tokio::spawn(async move {
            let result = tokio::select! {
                _=cancelled.changed()=>Err("登录已取消".into()),
                result=tokio::time::timeout(Duration::from_secs(600),async {
                    loop { let event=server.next().await?;
                        if event["method"]=="account/login/completed" && event["params"]["loginId"]==login_id {
                            if event["params"]["success"]!=true{return Err("官方登录未完成，请重试".into());}
                            return server.auth();
                        }
                    }
                })=>result.unwrap_or_else(|_|Err("官方登录已超时，请重新添加账号".into()))
            };
            server.stop().await;
            let mut state = accounts.state.lock().await;
            if state.flow["id"] != login_id || state.flow["status"] != "waiting" {
                return;
            }
            match result {
                Ok(auth) => {
                    let identity = account_id(&auth);
                    if identity.is_empty() || text(&auth["tokens"], "access_token").is_empty() {
                        state.flow["status"] = json!("failed");
                        state.flow["error"] = json!("官方授权缺少账号信息，请重试");
                        return;
                    }
                    if target.is_empty()
                        && accounts.local_selected()
                        && accounts
                            .local()
                            .ok()
                            .is_some_and(|local| account_id(&local) == identity)
                    {
                        state.flow["status"] = json!("complete");
                        state.flow["accountId"] = json!("official-chatgpt");
                        state.cancel = None;
                        return;
                    }
                    let mut entries = state.entries.clone();
                    let existing = entries
                        .iter()
                        .find(|a| account_id(&a.auth) == identity)
                        .map(|a| a.id.clone());
                    let id = existing.unwrap_or_else(|| format!("official-chatgpt-{}", login_id));
                    if !target.is_empty() && target != id {
                        state.flow["status"] = json!("failed");
                        state.flow["error"] = json!("登录账号与待重新登录账号不同，请单独添加");
                        return;
                    }
                    if let Some(entry) = entries.iter_mut().find(|a| a.id == id) {
                        entry.auth = auth;
                    } else {
                        entries.push(Entry {
                            id: id.clone(),
                            auth,
                        });
                    }
                    match accounts.save_entries(&mut state, entries) {
                        Ok(()) => {
                            state.flow["status"] = json!("complete");
                            state.flow["accountId"] = json!(id);
                        }
                        Err(_) => {
                            state.flow["status"] = json!("failed");
                            state.flow["error"] = json!("官方账号未能保存，请重试");
                        }
                    }
                }
                Err(error) => {
                    state.flow["status"] = json!("failed");
                    state.flow["error"] = json!(error);
                }
            }
            state.cancel = None;
        });
        Ok(())
    }
    pub async fn url(&self) -> Result<String> {
        let state = self.state.lock().await;
        if state.flow["status"] == "waiting" {
            Ok(state.url.clone())
        } else {
            Err("官方授权尚未开始".into())
        }
    }
    pub async fn cancel(&self) {
        let mut state = self.state.lock().await;
        if let Some(cancel) = state.cancel.take() {
            state.flow["status"] = json!("cancelled");
            let _ = cancel.send(true);
        }
    }
    pub async fn sign_out(&self, id: &str, expected_account_key: Option<&str>) -> Result<Value> {
        let _operation = self.operations.lock().await;
        if id == "official-chatgpt" {
            let path = self.home.join("auth.json");
            let source = read(&path)?.ok_or("此官方账号已退出，请刷新账号列表")?;
            let mut auth: Value =
                serde_json::from_str(&source).map_err(|_| "官方登录文件无法读取，原文件已保留")?;
            let expected = account_key(&auth);
            if text(&auth["tokens"], "access_token").is_empty()
                || expected_account_key.filter(|key| !key.is_empty()) != Some(expected.as_str())
            {
                return Err("官方登录已变化，请刷新账号后重新确认退出".into());
            }
            // Clear only the displayed ChatGPT login. Keep unrelated fields and
            // any separately stored API key; never delete the whole auth file.
            let document = auth.as_object_mut().ok_or("官方登录文件无法读取")?;
            for key in ["tokens", "last_refresh", "account_id"] {
                document.remove(key);
            }
            if document.get("auth_mode").and_then(Value::as_str) == Some("chatgpt") {
                document.remove("auth_mode");
            }
            write_checked(&path, &source, &auth.to_string())?;
            official_usage_cache::forget(&self.root, id);
            return Ok(json!({"revoked":false,"localCredentialsCleared":true}));
        }
        let mut state = self.state.lock().await;
        let entries: Vec<_> = state
            .entries
            .iter()
            .filter(|a| a.id != id)
            .cloned()
            .collect();
        self.save_entries(&mut state, entries)?;
        official_usage_cache::forget(&self.root, id);
        Ok(json!({}))
    }
    pub async fn usage(&self, id: &str) -> Result<Value> {
        if id == "official-chatgpt" {
            return official_chatgpt::ReadAccount::new(
                self.home.clone(),
                self.usage_url.clone(),
                self.root.clone(),
            )
            .execute()
            .await;
        }
        let result = self
            .operation(id, "account/rateLimits/read", json!({}))
            .await?;
        let account = account_with_limits(id, &self.auth_for(id).await?, &result);
        official_usage_cache::store(&self.root, &account);
        Ok(account)
    }
    async fn operation(&self, id: &str, method: &str, mut params: Value) -> Result<Value> {
        let _operation = self.operations.lock().await;
        let auth = self.auth_for(id).await?;
        if method == "account/rateLimitResetCredit/consume" {
            if text(&params, "__deckAccountKey") != account_key(&auth) {
                return Err("账号登录已变化，请重新读取重置卡".into());
            }
            params.as_object_mut().unwrap().remove("__deckAccountKey");
        }
        let executable = self.executable().ok_or(
            "未找到官方客户端的账号接口，请更新 ChatGPT / Codex 桌面版或 Codex CLI 后重试",
        )?;
        // Only access credentials are materialized for the existing login. Its
        // refresh token stays exclusively with the official client.
        let mut scoped_auth = auth.clone();
        let follows_source = id == "official-chatgpt" || imported_subscriptions::is_imported(id);
        if follows_source {
            scoped_auth["tokens"]["refresh_token"] = json!("");
        }
        let mut server = Server::start(&self.root, &executable, Some(&scoped_auth)).await?;
        let result = server.call(method, params).await;
        let updated = if !follows_source {
            Some(server.auth())
        } else {
            None
        };
        server.stop().await;
        if let Some(updated) = updated {
            self.persist_auth(id, updated?).await?;
        }
        if follows_source && self.auth_for(id).await? != auth {
            return Err("官方登录已变化，请重试".into());
        }
        result
    }
    pub async fn credits(&self, id: &str) -> Result<Value> {
        let limits = self
            .operation(id, "account/rateLimits/read", json!({}))
            .await?;
        Ok(account_with_limits(id, &self.auth_for(id).await?, &limits))
    }
    pub async fn consume(
        &self,
        id: &str,
        credit: &str,
        key: &str,
        account_key: &str,
    ) -> Result<Value> {
        if credit.is_empty()
            || key.len() != 36
            || key.chars().any(|c| !c.is_ascii_hexdigit() && c != '-')
        {
            return Err("请选择重置卡后重试".into());
        }
        // Forward retries with the same key even if the credit was already
        // consumed: the official service owns redemption and idempotency.
        self.operation(
            id,
            "account/rateLimitResetCredit/consume",
            json!({"creditId":credit,"idempotencyKey":key,"__deckAccountKey":account_key}),
        )
        .await
    }
}
fn account_with_limits(id: &str, auth: &Value, data: &Value) -> Value {
    let mut account = metadata(id, auth);
    let mut windows = vec![];
    let limits: Vec<(&str, &Value)> = data["rateLimitsByLimitId"]
        .as_object()
        .map(|m| m.iter().map(|(id, limit)| (id.as_str(), limit)).collect())
        .unwrap_or_else(|| vec![("codex", &data["rateLimits"])]);
    let mut remaining: Option<f64> = None;
    let mut reset = 0;
    let mut incomplete = false;
    let mut plan_type = None;
    for (map_id, limit) in limits {
        let limit_id = limit["limitId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .unwrap_or(map_id);
        if limit_id == "codex" {
            plan_type = limit["planType"].as_str();
        }
        for name in ["primary", "secondary"] {
            let window = &limit[name];
            if !window.is_object() {
                continue;
            }
            let used = window["usedPercent"]
                .as_f64()
                .filter(|v| v.is_finite() && (0.0..=100.0).contains(v));
            let left = used.map(|v| 100. - v);
            let at = window["resetsAt"].as_u64();
            if limit_id == "codex" {
                if let (Some(left), Some(at)) = (left, at) {
                    if remaining.is_none_or(|v| left < v) {
                        remaining = Some(left);
                        reset = at;
                    }
                } else {
                    incomplete = true;
                }
            }
            windows.push(json!({"limitId":limit_id,"limitName":limit["limitName"].as_str(),"planType":limit["planType"].as_str(),"window":name,"usedPercent":used,"remainingPercent":left,"resetsAt":at,"windowSeconds":window["windowDurationMins"].as_u64().filter(|v|*v>0).and_then(|v|v.checked_mul(60))}));
        }
    }
    let credits:Vec<_>=data["rateLimitResetCredits"]["credits"].as_array().into_iter().flatten().filter(|c|!text(c,"id").is_empty()).map(|c|json!({"id":c["id"],"expiresAt":c["expiresAt"],"title":c["title"].as_str().unwrap_or("额度重置卡"),"status":c["status"]})).collect();
    let checked = (millis() / 1000) as u64;
    account["quotaDetails"] = json!({"source":"codex-app-server","checkedAt":checked,"httpStatus":200,"planType":plan_type,"windows":windows,"availableResetCredits":data["rateLimitResetCredits"]["availableCount"],"resetCredits":credits});
    if let Some(left) = remaining.filter(|_| !incomplete) {
        account["quota"] = json!({"remainingPercent":left,"resetsAt":reset,"checkedAt":checked});
    }
    account
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quota_windows_follow_the_response_instead_of_the_plan() {
        for plan in ["plus", "pro", "future-plan"] {
            for short in [
                Value::Null,
                json!({"usedPercent":20,"resetsAt":200,"windowDurationMins":300}),
            ] {
                let account = account_with_limits(
                    "official-chatgpt",
                    &json!({}),
                    &json!({
                        "rateLimitsByLimitId":{"codex":{"planType":plan,"primary":short,
                            "secondary":{"usedPercent":40,"resetsAt":900,"windowDurationMins":10080}}}
                    }),
                );
                let details = &account["quotaDetails"];
                let windows = details["windows"].as_array().unwrap();
                assert_eq!(details["planType"], plan);
                assert_eq!(windows.len(), if short.is_null() { 1 } else { 2 });
                assert_eq!(windows.last().unwrap()["windowSeconds"], 604800);
                assert_eq!(account["quota"]["remainingPercent"], 60.);
            }
        }
    }

    #[test]
    fn authoritative_empty_windows_do_not_revive_the_legacy_bucket() {
        let legacy = json!({"planType":"plus","primary":{"usedPercent":5,"resetsAt":200,"windowDurationMins":300}});
        let account = account_with_limits(
            "official-chatgpt",
            &json!({}),
            &json!({
                "rateLimits":legacy,"rateLimitsByLimitId":{}
            }),
        );
        assert_eq!(account["quotaDetails"]["windows"], json!([]));
        assert!(account["quotaDetails"]["planType"].is_null());
        assert!(account.get("quota").is_none());
        let legacy_only = account_with_limits(
            "official-chatgpt",
            &json!({}),
            &json!({"rateLimits":legacy}),
        );
        assert_eq!(
            legacy_only["quotaDetails"]["windows"][0]["windowSeconds"],
            18000
        );
    }

    #[test]
    fn extra_buckets_keep_their_identity_without_depleting_the_general_quota() {
        let account = account_with_limits(
            "official-chatgpt",
            &json!({}),
            &json!({
                "rateLimitsByLimitId":{
                    "codex":{"planType":"pro","primary":{"usedPercent":20,"resetsAt":200,"windowDurationMins":15}},
                    "special":{"limitName":"Special model","planType":"future-plan","primary":{"usedPercent":100,"resetsAt":300,"windowDurationMins":60}}
                }
            }),
        );
        assert_eq!(account["quota"]["remainingPercent"], 80.);
        assert_eq!(account["quotaDetails"]["planType"], "pro");
        let windows = account["quotaDetails"]["windows"].as_array().unwrap();
        let special = windows.iter().find(|w| w["limitId"] == "special").unwrap();
        assert_eq!(special["limitName"], "Special model");
        assert_eq!(special["planType"], "future-plan");
    }

    #[test]
    fn unknown_fields_stay_unknown_and_oversized_durations_do_not_overflow() {
        let account = account_with_limits(
            "official-chatgpt",
            &json!({}),
            &json!({
                "rateLimits":{"primary":{"usedPercent":101,"windowDurationMins":u64::MAX},
                    "secondary":{"usedPercent":20,"resetsAt":900,"windowDurationMins":0}}
            }),
        );
        assert!(account.get("quota").is_none());
        assert!(account["quotaDetails"]["planType"].is_null());
        for window in account["quotaDetails"]["windows"].as_array().unwrap() {
            assert!(window["windowSeconds"].is_null());
        }
    }
}
