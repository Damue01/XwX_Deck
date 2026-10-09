//! Cursor browser authorization and private registrations. No global CLI credentials are read.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
fn random() -> Result<String> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(err)?;
    Ok(URL_SAFE_NO_PAD.encode(b))
}
#[derive(Clone, Serialize, Deserialize)]
struct Account {
    id: String,
    label: String,
    email: String,
    token: String,
    expires: u64,
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
pub(super) struct CursorWire {
    pub url: String,
    pub base: String,
    pub request: Value,
}
#[derive(Clone)]
pub(super) struct CursorAccounts {
    path: PathBuf,
    accounts: Arc<Mutex<Vec<Account>>>,
    flow: Arc<Mutex<Option<Flow>>>,
    client: reqwest::Client,
    api: String,
    test: bool,
}
impl CursorAccounts {
    pub fn open(root: &Path, test: bool, base: &str) -> Result<Self> {
        let path = root.join("cursor-accounts.json");
        let accounts = read(&path)?
            .map(|v| {
                serde_json::from_str(&v)
                    .map_err(|_| "Cursor 账号文件损坏，原文件已保留".to_string())
            })
            .transpose()?
            .unwrap_or_default();
        let builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none());
        Ok(Self {
            path,
            accounts: Arc::new(Mutex::new(accounts)),
            flow: Arc::new(Mutex::new(None)),
            client: if test { builder.no_proxy() } else { builder }
                .build()
                .map_err(err)?,
            api: if test {
                base.into()
            } else {
                "https://api2.cursor.sh".into()
            },
            test,
        })
    }
    fn save(&self, a: &[Account]) -> Result<()> {
        write(&self.path, &serde_json::to_string(a).map_err(err)?)
    }
    pub fn api(&self) -> &str {
        &self.api
    }
    pub fn headers() -> Vec<(&'static str, String)> {
        vec![
            ("connect-protocol-version", "1".into()),
            ("x-cursor-client-version", "cli-2026.09.23-86fc751".into()),
            ("x-cursor-client-type", "cli".into()),
            ("x-ghost-mode", "true".into()),
        ]
    }
    async fn json(response: reqwest::Response) -> Result<Value> {
        if !response.status().is_success() {
            return Err(format!(
                "Cursor 请求未完成（HTTP {}）",
                response.status().as_u16()
            ));
        }
        let bytes = response.bytes().await.map_err(|_| "Cursor 响应中断")?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("Cursor 响应过大".into());
        }
        serde_json::from_slice(&bytes).map_err(|_| "Cursor 返回无效响应".into())
    }
    pub async fn unary(&self, path: &str, token: &str, body: &Value) -> Result<Value> {
        let mut request = self
            .client
            .post(format!("{}/{path}", self.api))
            .bearer_auth(token)
            .json(body);
        for (k, v) in Self::headers() {
            request = request.header(k, v);
        }
        Self::json(request.send().await.map_err(|_| "Cursor 连接失败")?).await
    }
    pub async fn snapshot(&self) -> Value {
        let accounts = self.accounts.lock().await;
        let rows:Vec<_>=accounts.iter().map(|a|json!({"id":a.id,"label":a.label,"email":a.email,"platform":"cursor","status":if a.signed_out||a.expires<=millis() as u64{"signed-out"}else{"connected"}})).collect();
        drop(accounts);
        let flow = self.flow.lock().await;
        json!({"accounts":rows,"flow":flow.as_ref().map(|f|json!({"id":f.id,"platform":"cursor","status":f.status,"error":f.error,"accountId":f.account_id}))})
    }
    pub async fn cancel(&self) {
        if let Some(f) = self
            .flow
            .lock()
            .await
            .as_mut()
            .filter(|f| f.status == "waiting")
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
            .filter(|f| f.status == "waiting")
            .map(|f| f.url.clone())
            .ok_or("没有待完成的 Cursor 登录".into())
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
            return Err("Cursor 账号不存在".into());
        }
        let verifier = random()?;
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let uuid = cursor_protocol::uuid()?;
        let mut url = reqwest::Url::parse(&format!(
            "{}/loginDeepControl",
            if self.test {
                self.api.as_str()
            } else {
                "https://cursor.com"
            }
        ))
        .map_err(err)?;
        url.query_pairs_mut().extend_pairs([
            ("challenge", challenge.as_str()),
            ("uuid", uuid.as_str()),
            ("mode", "login"),
            ("redirectTarget", "cli"),
        ]);
        let (cancel, mut cancelled) = tokio::sync::watch::channel(false);
        let flow_id = random()?;
        *self.flow.lock().await = Some(Flow {
            id: flow_id.clone(),
            url: url.into(),
            status: "waiting".into(),
            error: String::new(),
            account_id: String::new(),
            cancel,
        });
        let engine = self.clone();
        tokio::spawn(async move {
            let work = async {
                let mut errors = 0;
                for n in 0..150 {
                    let mut poll =
                        reqwest::Url::parse(&format!("{}/auth/poll", engine.api)).map_err(err)?;
                    poll.query_pairs_mut()
                        .extend_pairs([("uuid", uuid.as_str()), ("verifier", verifier.as_str())]);
                    let mut request = engine.client.get(poll);
                    for (k, v) in Self::headers() {
                        request = request.header(k, v);
                    }
                    match request.send().await {
                        Ok(response) if response.status().as_u16() == 404 => {
                            errors = 0;
                        }
                        Ok(response) if response.status().is_success() => {
                            let data = Self::json(response).await?;
                            let token = text(&data, "accessToken");
                            if token.is_empty() || data.get("refreshToken").is_none() {
                                return Err("Cursor 没有返回订阅授权".into());
                            }
                            let identity = engine
                                .unary("aiserver.v1.DashboardService/GetMe", token, &json!({}))
                                .await?;
                            let email = text(&identity, "email");
                            if email.is_empty() {
                                return Err("Cursor 没有返回账号身份".into());
                            }
                            if old
                                .as_ref()
                                .is_some_and(|a| !a.email.eq_ignore_ascii_case(email))
                            {
                                return Err("登录的账号与原账号不一致，原登录已保留".into());
                            }
                            let expiry = token
                                .split('.')
                                .nth(1)
                                .and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
                                .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                                .and_then(|v| v["exp"].as_u64())
                                .map(|n| n * 1000)
                                .unwrap_or(millis() as u64 + 30 * 24 * 3600000);
                            return Ok(Account {
                                id: old
                                    .as_ref()
                                    .map(|a| a.id.clone())
                                    .unwrap_or(format!("cursor-{}", random()?)),
                                label: old
                                    .as_ref()
                                    .map(|a| a.label.clone())
                                    .unwrap_or_else(|| "Cursor".into()),
                                email: email.into(),
                                token: token.into(),
                                expires: expiry,
                                signed_out: false,
                            });
                        }
                        Ok(response) if response.status().as_u16() == 403 => {
                            return Err("Cursor 拒绝了本次登录，请重试".into())
                        }
                        _ => {
                            errors += 1;
                            if errors >= 3 {
                                return Err("Cursor 授权连接失败，请重试".into());
                            }
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(if engine.test {
                        50
                    } else {
                        (1000.0 * 1.2_f64.powi(n)).min(10000.0) as u64
                    }))
                    .await;
                }
                Err("Cursor 登录超时，请重试".into())
            };
            let outcome: Result<Account> =
                tokio::select! {_=cancelled.changed()=>return,result=work=>result};
            let mut accounts = engine.accounts.lock().await;
            let mut flow = engine.flow.lock().await;
            let Some(f) = flow
                .as_mut()
                .filter(|f| f.id == flow_id && f.status == "waiting")
            else {
                return;
            };
            match outcome {
                Ok(mut account) => {
                    if old.is_none() {
                        account.label = format!("Cursor-{}", accounts.len() + 1);
                    }
                    let mut next = accounts.clone();
                    next.retain(|a| a.id != account.id);
                    next.push(account.clone());
                    match engine.save(&next) {
                        Ok(()) => {
                            *accounts = next;
                            f.status = "complete".into();
                            f.account_id = account.id;
                        }
                        Err(e) => {
                            f.status = "failed".into();
                            f.error = e;
                        }
                    }
                }
                Err(e) => {
                    f.status = "failed".into();
                    f.error = e;
                }
            }
        });
        Ok(())
    }
    pub async fn credential(&self, id: &str) -> Result<String> {
        let a = self
            .accounts
            .lock()
            .await
            .iter()
            .find(|a| a.id == id)
            .cloned()
            .ok_or("Cursor 账号不存在")?;
        if a.signed_out || a.expires <= millis() as u64 {
            return Err("Cursor 授权已过期，请重新登录".into());
        }
        Ok(a.token)
    }
    pub async fn provider(&self, id: &str) -> Result<Provider> {
        let a = self
            .accounts
            .lock()
            .await
            .iter()
            .find(|a| a.id == id)
            .cloned()
            .ok_or("Cursor 账号不存在")?;
        Ok(Provider {
            id: format!("subscription-{id}"),
            display_name: a.label,
            subscription_account_id: id.into(),
            account_label: a.email,
            codex_provider_id: "xwx_deck".into(),
            base_url: self.api.clone(),
            adapter: "chat-completions".into(),
            codex_api_format: "chat-completions".into(),
            provider_preset: "auto".into(),
            claude_models: json!({"fable":"","opus":"","sonnet":"","haiku":""}),
            ..Default::default()
        })
    }
    pub async fn catalog(&self, id: &str) -> Result<Value> {
        let token = self.credential(id).await?;
        self.unary(
            "aiserver.v1.AiService/AvailableModels",
            &token,
            &json!({"useModelParameters":true,"doNotUseMarkdown":true}),
        )
        .await
    }
    pub async fn model_response(&self, id: &str) -> Result<reqwest::Response> {
        let catalog = self.catalog(id).await?;
        let rows = catalog["models"].as_array().ok_or("Cursor 模型目录无效")?;
        let models: Vec<_> = rows.iter()
            .filter(|m| m["isHidden"] != true && m["isChatOnly"] != true && m["onlySupportsCmdK"] != true && m["supportsAgent"] != false)
            .filter_map(|m| m["name"].as_str().map(|name| json!({"id":if name == "default" {"auto"} else {name},"object":"model","owned_by":"cursor","display_name":m["clientDisplayName"].as_str().unwrap_or(name)})))
            .collect();
        Ok(reqwest::Response::from(
            axum::http::Response::builder()
                .status(200)
                .header("content-type", "application/json")
                .body(json!({"object":"list","data":models}).to_string())
                .map_err(err)?,
        ))
    }
    pub async fn rename(&self, id: &str, label: &str) -> Result<()> {
        let mut a = self.accounts.lock().await;
        let mut next = a.clone();
        next.iter_mut()
            .find(|a| a.id == id)
            .ok_or("Cursor 账号不存在")?
            .label = label.into();
        self.save(&next)?;
        *a = next;
        Ok(())
    }
    pub async fn sign_out(&self, id: &str) -> Result<Value> {
        let mut a = self.accounts.lock().await;
        let mut next = a.clone();
        let account = next
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or("Cursor 账号不存在")?;
        account.token.clear();
        account.signed_out = true;
        self.save(&next)?;
        *a = next;
        Ok(json!({"revoked":false,"warning":"已清除本机的此账号登录；远端授权未撤销。"}))
    }
    pub async fn response(&self, id: &str, body: &Value) -> Result<reqwest::Response> {
        let token = self.credential(id).await?;
        let config = self
            .unary(
                "aiserver.v1.ServerConfigService/GetServerConfig",
                &token,
                &json!({}),
            )
            .await
            .ok();
        let fallback = if self.test {
            self.api.as_str()
        } else {
            "https://agentn.global.api5.cursor.sh"
        };
        let base = config
            .as_ref()
            .and_then(|v| {
                v["agentUrlConfig"]["agentUrl"]
                    .as_str()
                    .or_else(|| v["agentUrlConfig"]["agentnUrl"].as_str())
            })
            .unwrap_or(fallback);
        let url = reqwest::Url::parse(base).map_err(|_| "Cursor 请求地址无效")?;
        let trusted = if self.test {
            url.scheme() == "http" && url.host_str() == Some("127.0.0.1")
        } else {
            url.scheme() == "https"
                && url
                    .host_str()
                    .is_some_and(|h| h == "cursor.sh" || h.ends_with(".cursor.sh"))
        };
        if !trusted
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("Cursor 返回了不受信任的请求地址".into());
        }
        let catalog = self.catalog(id).await.ok();
        let (mut result, sent) =
            cursor_protocol::run(&token, base, body, catalog.as_ref(), self.test).await?;
        let status = result
            .get("_cursor_status")
            .and_then(Value::as_u64)
            .unwrap_or(200) as u16;
        if let Some(result) = result.as_object_mut() {
            result.remove("_cursor_status");
        }
        let mut response = reqwest::Response::from(
            axum::http::Response::builder()
                .status(status)
                .header("content-type", "application/json")
                .body(result.to_string())
                .map_err(err)?,
        );
        response.extensions_mut().insert(CursorWire {
            url: format!("{}/agent.v1.AgentService/Run", base.trim_end_matches('/')),
            base: base.into(),
            request: sent,
        });
        Ok(response)
    }
}
