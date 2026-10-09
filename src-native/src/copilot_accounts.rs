//! GitHub's device authorization and Copilot's short-lived inference credentials.
//! Only registrations and login progress are returned to the renderer.
use super::*;
const CLIENT_ID: &str = "Iv1.b507a08c87ecfe98";
fn now() -> u64 {
    (millis() / 1000) as u64
}
fn random_id() -> Result<String> {
    let mut b = [0u8; 18];
    getrandom::fill(&mut b).map_err(err)?;
    Ok(b.iter().map(|b| format!("{b:02x}")).collect())
}
#[derive(Clone, Serialize, Deserialize)]
struct Account {
    id: String,
    label: String,
    subject: String,
    login: String,
    github: String,
    access: String,
    expires: u64,
    api: String,
    needs_login: bool,
}
struct Flow {
    id: String,
    url: String,
    code: String,
    status: String,
    error: String,
    account_id: String,
    cancel: tokio::sync::watch::Sender<bool>,
}
#[derive(Clone)]
pub(super) struct CopilotAccounts {
    root: PathBuf,
    accounts: Arc<Mutex<Vec<Account>>>,
    flow: Arc<Mutex<Option<Flow>>>,
    client: reqwest::Client,
    github: String,
    device: String,
    api: String,
    test: bool,
}
impl CopilotAccounts {
    pub fn model_visible(model: &Value) -> bool {
        let kind = model["capabilities"]["type"].as_str().unwrap_or("chat");
        let category = model["model_picker_category"].as_str().unwrap_or("");
        kind == "chat"
            && model["vendor"] != "Experimental"
            && (model["model_picker_enabled"] != false || !category.is_empty())
            && model["policy"]["state"]
                .as_str()
                .is_none_or(|state| state == "enabled")
    }
    pub async fn usage(&self, id: &str) -> Result<Value> {
        let token = self
            .accounts
            .lock()
            .await
            .iter()
            .find(|a| a.id == id && !a.needs_login)
            .map(|a| a.github.clone())
            .ok_or("请先登录 Copilot")?;
        let mut request = self
            .client
            .get(format!("{}/copilot_internal/user", self.github))
            .header("authorization", format!("token {token}"))
            .header("accept", "application/json")
            .timeout(Duration::from_secs(8));
        for (k, v) in Self::headers() {
            request = request.header(k, v);
        }
        let response = request.send().await.map_err(|_| "读取 Copilot 额度失败")?;
        if !response.status().is_success() {
            return Err(format!(
                "读取 Copilot 额度失败（HTTP {}）",
                response.status().as_u16()
            ));
        }
        response
            .json()
            .await
            .map_err(|_| "Copilot 额度格式无法识别".into())
    }
    pub fn open(root: &Path, test: bool, base: &str) -> Result<Self> {
        let path = root.join("copilot-accounts.json");
        let accounts = read(&path)?
            .map(|s| {
                serde_json::from_str(&s)
                    .map_err(|_| "Copilot 账号文件损坏，原文件已保留".to_string())
            })
            .transpose()?
            .unwrap_or_default();
        let builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(25));
        Ok(Self {
            root: root.into(),
            accounts: Arc::new(Mutex::new(accounts)),
            flow: Arc::new(Mutex::new(None)),
            client: if test { builder.no_proxy() } else { builder }
                .build()
                .map_err(err)?,
            github: if test {
                base.into()
            } else {
                "https://api.github.com".into()
            },
            device: if test {
                base.into()
            } else {
                "https://github.com".into()
            },
            api: if test {
                format!("{base}/v1")
            } else {
                "https://api.githubcopilot.com".into()
            },
            test,
        })
    }
    fn save(&self, accounts: &[Account]) -> Result<()> {
        write(
            &self.root.join("copilot-accounts.json"),
            &serde_json::to_string(accounts).map_err(err)?,
        )?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                self.root.join("copilot-accounts.json"),
                fs::Permissions::from_mode(0o600),
            )
            .map_err(err)?;
        }
        Ok(())
    }
    async fn json(&self, response: reqwest::Response) -> Result<Value> {
        if !response.status().is_success() {
            return Err(format!(
                "Copilot 授权请求失败（HTTP {}）",
                response.status().as_u16()
            ));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| "Copilot 授权响应读取失败")?;
        if bytes.len() > 1024 * 1024 {
            return Err("Copilot 授权响应过大".into());
        }
        serde_json::from_slice(&bytes).map_err(|_| "Copilot 授权响应无效".into())
    }
    async fn form(&self, path: &str, fields: &[(&str, &str)]) -> Result<Value> {
        let response = self
            .client
            .post(format!("{}{path}", self.device))
            .header("accept", "application/json")
            .form(fields)
            .send()
            .await
            .map_err(|_| "GitHub 授权服务连接失败")?;
        self.json(response).await
    }
    fn headers_request(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request
            .header("editor-version", "vscode/1.140.0")
            .header("editor-plugin-version", "copilot-chat/0.68.0")
            .header("copilot-integration-id", "vscode-chat")
            .header("user-agent", "GitHubCopilotChat/0.68.0")
    }
    async fn session(&self, github: &str) -> Result<Value> {
        let response = self
            .headers_request(
                self.client
                    .get(format!("{}/copilot_internal/v2/token", self.github)),
            )
            .header("authorization", format!("token {github}"))
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|_| "Copilot 套餐授权服务连接失败")?;
        self.json(response).await
    }
    fn endpoint(&self, session: &Value) -> Result<String> {
        let raw = session["endpoints"]["api"].as_str().unwrap_or(&self.api);
        let url = reqwest::Url::parse(raw).map_err(|_| "Copilot 返回的服务地址无效")?;
        if self.test {
            if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
                return Err("无效的隔离服务地址".into());
            }
        } else if url.scheme() != "https"
            || !url
                .host_str()
                .is_some_and(|h| h == "api.githubcopilot.com" || h.ends_with(".githubcopilot.com"))
        {
            return Err("Copilot 返回了未授权的服务地址".into());
        }
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("Copilot 返回的服务地址无效".into());
        }
        Ok(raw.trim_end_matches('/').into())
    }
    pub async fn snapshot(&self) -> Value {
        let accounts = self.accounts.lock().await;
        let rows:Vec<_>=accounts.iter().map(|a|json!({"id":a.id,"label":a.label,"email":a.login,"platform":"copilot","status":if a.needs_login||a.github.is_empty(){"signed-out"}else{"connected"}})).collect();
        drop(accounts);
        let flow = self.flow.lock().await;
        json!({"accounts":rows,"flow":flow.as_ref().map(|f|json!({"id":f.id,"platform":"copilot","status":f.status,"error":f.error,"accountId":f.account_id,"userCode":f.code}))})
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
            .filter(|f| f.status == "waiting")
            .map(|f| f.url.clone())
            .ok_or("没有待完成的 Copilot 登录".into())
    }
    pub async fn begin(&self, id: &str) -> Result<()> {
        self.cancel().await;
        let old = self
            .accounts
            .lock()
            .await
            .iter()
            .find(|a| a.id == id)
            .cloned();
        if !id.is_empty() && old.is_none() {
            return Err("Copilot 账号不存在".into());
        }
        let device = self
            .form(
                "/login/device/code",
                &[("client_id", CLIENT_ID), ("scope", "read:user")],
            )
            .await?;
        let code = text(&device, "device_code").to_string();
        let user_code = text(&device, "user_code").to_string();
        let url = text(&device, "verification_uri").to_string();
        let parsed = reqwest::Url::parse(&url).map_err(|_| "GitHub 未返回有效的授权地址")?;
        if code.is_empty()
            || user_code.is_empty()
            || (!self.test
                && (parsed.scheme() != "https" || parsed.host_str() != Some("github.com")))
        {
            return Err("GitHub 返回的设备授权无效".into());
        }
        let id = random_id()?;
        let (cancel, mut cancelled) = tokio::sync::watch::channel(false);
        *self.flow.lock().await = Some(Flow {
            id: id.clone(),
            url,
            code: user_code,
            status: "waiting".into(),
            error: String::new(),
            account_id: String::new(),
            cancel,
        });
        let engine = self.clone();
        tokio::spawn(async move {
            let mut interval = device["interval"].as_u64().unwrap_or(5).clamp(1, 60);
            let deadline = tokio::time::sleep(Duration::from_secs(
                device["expires_in"].as_u64().unwrap_or(900).min(1800),
            ));
            tokio::pin!(deadline);
            let outcome:Result<Account>=async {loop {
    tokio::select!{_=cancelled.changed()=>return Err("登录已取消".into()),_=&mut deadline=>return Err("GitHub 授权码已过期，请重新登录".into()),_=tokio::time::sleep(Duration::from_secs(interval))=>{}}
    let result=engine.form("/login/oauth/access_token",&[("client_id",CLIENT_ID),("device_code",&code),("grant_type","urn:ietf:params:oauth:grant-type:device_code")]).await?;
    match text(&result,"error"){"authorization_pending"=>continue,"slow_down"=>{interval=(interval+5).min(60);continue;},""=>{},"access_denied"=>return Err("GitHub 授权已取消".into()),_=>return Err("GitHub 设备授权失败，请重试".into())}
    let github=text(&result,"access_token").to_string();if github.is_empty(){return Err("GitHub 没有返回账号凭证".into());}
    let user=engine.json(engine.client.get(format!("{}/user",engine.github)).bearer_auth(&github).header("user-agent","XwX Deck").send().await.map_err(|_|"GitHub 账号身份读取失败")?).await?;
    let subject=user["id"].to_string();let login=text(&user,"login");if subject=="null"||login.is_empty(){return Err("GitHub 没有返回账号身份".into());}if old.as_ref().is_some_and(|a|a.subject!=subject){return Err("登录的账号与原账号不一致，原登录已保留".into());}
    let session=engine.session(&github).await?;let access=text(&session,"token");if access.is_empty(){return Err("此 GitHub 账号没有可用的 Copilot 套餐授权".into());}
    return Ok(Account{id:old.as_ref().map(|a|a.id.clone()).unwrap_or(format!("copilot-{}",random_id()?)),label:old.as_ref().map(|a|a.label.clone()).unwrap_or(format!("Copilot-{login}")),subject,login:login.into(),github,access:access.into(),expires:session["expires_at"].as_u64().unwrap_or(now()+1200),api:engine.endpoint(&session)?,needs_login:false});
   }}.await;
            let mut accounts = engine.accounts.lock().await;
            let mut flow = engine.flow.lock().await;
            let Some(flow) = flow
                .as_mut()
                .filter(|f| f.id == id && f.status == "waiting")
            else {
                return;
            };
            match outcome {
                Ok(account) => {
                    let mut next = accounts.clone();
                    next.retain(|a| a.id != account.id);
                    next.push(account.clone());
                    match engine.save(&next) {
                        Ok(()) => {
                            *accounts = next;
                            flow.status = "complete".into();
                            flow.account_id = account.id;
                        }
                        Err(error) => {
                            flow.status = "failed".into();
                            flow.error = error;
                        }
                    }
                }
                Err(error) => {
                    flow.status = "failed".into();
                    flow.error = error;
                }
            }
        });
        Ok(())
    }
    pub async fn credential(&self, id: &str) -> Result<String> {
        let mut accounts = self.accounts.lock().await;
        let index = accounts
            .iter()
            .position(|a| a.id == id)
            .ok_or("Copilot 账号不存在")?;
        let mut account = accounts[index].clone();
        if account.needs_login || account.github.is_empty() {
            return Err("Copilot 账号需要重新登录".into());
        }
        if account.expires <= now() + 120 {
            let session = self.session(&account.github).await?;
            account.access = text(&session, "token").into();
            if account.access.is_empty() {
                return Err("Copilot 没有返回套餐授权".into());
            }
            account.expires = session["expires_at"].as_u64().unwrap_or(now() + 1200);
            account.api = self.endpoint(&session)?;
            let mut next = accounts.clone();
            next[index] = account.clone();
            self.save(&next)?;
            *accounts = next;
        }
        Ok(account.access)
    }
    pub async fn api(&self, id: &str) -> Result<String> {
        self.accounts
            .lock()
            .await
            .iter()
            .find(|a| a.id == id)
            .map(|a| a.api.clone())
            .ok_or("Copilot 账号不存在".into())
    }
    pub async fn provider(&self, id: &str) -> Result<Provider> {
        let accounts = self.accounts.lock().await;
        let account = accounts
            .iter()
            .find(|a| a.id == id)
            .ok_or("Copilot 账号不存在")?;
        Ok(Provider {
            id: format!("subscription-{id}"),
            display_name: account.label.clone(),
            subscription_account_id: id.into(),
            account_label: account.login.clone(),
            codex_provider_id: "xwx_deck".into(),
            base_url: account.api.clone(),
            adapter: "auto".into(),
            codex_api_format: "chat".into(),
            provider_preset: "auto".into(),
            claude_models: json!({"fable":"","opus":"","sonnet":"","haiku":""}),
            ..Default::default()
        })
    }
    pub async fn rename(&self, id: &str, label: &str) -> Result<()> {
        let mut accounts = self.accounts.lock().await;
        let mut next = accounts.clone();
        next.iter_mut()
            .find(|a| a.id == id)
            .ok_or("Copilot 账号不存在")?
            .label = label.into();
        self.save(&next)?;
        *accounts = next;
        Ok(())
    }
    pub async fn sign_out(&self, id: &str) -> Result<Value> {
        let mut accounts = self.accounts.lock().await;
        let mut next = accounts.clone();
        let account = next
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or("Copilot 账号不存在")?;
        account.github.clear();
        account.access.clear();
        account.expires = 0;
        account.needs_login = true;
        self.save(&next)?;
        *accounts = next;
        Ok(
            json!({"revoked":false,"warning":"已清除此账号的本地登录；可在 GitHub 授权设置中撤销授权。"}),
        )
    }
    pub fn headers() -> Vec<(&'static str, String)> {
        vec![
            ("editor-version", "vscode/1.140.0".into()),
            ("editor-plugin-version", "copilot-chat/0.68.0".into()),
            ("copilot-integration-id", "vscode-chat".into()),
            ("user-agent", "GitHubCopilotChat/0.68.0".into()),
            ("x-github-api-version", "2026-01-09".into()),
        ]
    }
}
