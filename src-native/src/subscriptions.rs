//! ChatGPT OSS plan authorization. Credentials never enter renderer snapshots or client files.
use super::*;
use axum::{response::Html, routing::get};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPE: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const DIRECT: &str = "chatgpt.tokens.use.direct";
fn random(size: usize) -> Result<String> {
    let mut bytes = vec![0; size];
    getrandom::fill(&mut bytes).map_err(|_| "无法生成安全随机数")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn now() -> u64 {
    (millis() / 1000) as u64
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Account {
    id: String,
    label: String,
    subject: String,
    email: String,
    client_id: String,
    access: String,
    refresh: String,
    id_token: String,
    scopes: Vec<String>,
    expires: u64,
    #[serde(default)]
    earliest_refresh_at: u64,
    #[serde(default)]
    needs_login: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vault {
    host_id: String,
    accounts: Vec<Account>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_login_failure: Option<LoginFailure>,
}
#[derive(Clone, Serialize, Deserialize)]
struct LoginFailure {
    id: String,
    error: String,
    at: u64,
}
#[derive(Clone)]
struct Flow {
    id: String,
    state: String,
    nonce: String,
    verifier: String,
    redirect: String,
    url: String,
    account: Option<Account>,
    status: String,
    error: String,
    account_id: String,
    cancel: tokio::sync::watch::Sender<bool>,
}
struct Inner {
    vault: Vault,
    flow: Option<Flow>,
}
#[derive(Clone)]
pub(super) struct Accounts {
    pub pool: subscription_routing::Pool,
    inner: Arc<Mutex<Inner>>,
    path: PathBuf,
    issuer: String,
    api: String,
    client: reqwest::Client,
    test: bool,
    grok: grok_accounts::GrokAccounts,
    copilot: copilot_accounts::CopilotAccounts,
    claude: claude_accounts::ClaudeAccounts,
    cursor: cursor_accounts::CursorAccounts,
    current_platform: Arc<Mutex<String>>,
}
impl Accounts {
    pub fn open(root: &Path, isolated: bool) -> Result<Self> {
        let path = root.join("subscription-accounts.json");
        let vault = match read(&path)? {
            Some(s) => serde_json::from_str(&s).map_err(|_| "订阅账号文件损坏，原文件已保留")?,
            None => {
                let mut bytes = [0u8; 16];
                getrandom::fill(&mut bytes).map_err(|_| "无法生成主机标识")?;
                bytes[6] = (bytes[6] & 15) | 64;
                bytes[8] = (bytes[8] & 63) | 128;
                let hex = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
                Vault {
                    host_id: format!(
                        "urn:uuid:{}-{}-{}-{}-{}",
                        &hex[..8],
                        &hex[8..12],
                        &hex[12..16],
                        &hex[16..20],
                        &hex[20..]
                    ),
                    accounts: vec![],
                    last_login_failure: None,
                }
            }
        };
        let args: Vec<_> = std::env::args().collect();
        let test_base = args
            .iter()
            .position(|s| s == "--subscription-test-endpoint")
            .and_then(|i| args.get(i + 1));
        let (issuer, api, test) = if let Some(base) = test_base {
            let url = reqwest::Url::parse(base).map_err(err)?;
            if !isolated
                || !args.iter().any(|s| s == "--rpc" || s == "--smoke")
                || url.scheme() != "http"
                || url.host_str() != Some("127.0.0.1")
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
                || !url.username().is_empty()
            {
                return Err("订阅测试端点仅允许隔离 RPC 的 IPv4 回环服务".into());
            }
            (
                base.trim_end_matches('/').to_string(),
                format!("{}/v1", base.trim_end_matches('/')),
                true,
            )
        } else {
            ("https://auth.openai.com".into(), RESOURCE.into(), false)
        };
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(25));
        let client = if test { client.no_proxy() } else { client };
        let grok = grok_accounts::GrokAccounts::open(root, test, &api)?;
        let copilot = copilot_accounts::CopilotAccounts::open(root, test, &issuer)?;
        let claude = claude_accounts::ClaudeAccounts::open(root, test, &issuer)?;
        let cursor = cursor_accounts::CursorAccounts::open(root, test, &issuer)?;
        Ok(Self {
            pool: subscription_routing::Pool::open(root)?,
            inner: Arc::new(Mutex::new(Inner { vault, flow: None })),
            path,
            issuer,
            api,
            test,
            client: client.build().map_err(err)?,
            grok,
            copilot,
            claude,
            cursor,
            current_platform: Arc::new(Mutex::new("chatgpt".into())),
        })
    }
    fn save(&self, vault: &Vault) -> Result<()> {
        write(&self.path, &serde_json::to_string(vault).map_err(err)?)
    }
    pub fn api(&self) -> &str {
        &self.api
    }
    pub fn api_for(&self, id: &str) -> &str {
        if id.starts_with("grok-") {
            self.grok.api()
        } else {
            self.api()
        }
    }
    pub async fn endpoint_for(&self, id: &str) -> Result<String> {
        if id.starts_with("cursor-") {
            Ok(self.cursor.api().into())
        } else if id.starts_with("claude-subscription-") {
            Ok(self.claude.api().into())
        } else if id.starts_with("copilot-") {
            self.copilot.api(id).await
        } else {
            Ok(self.api_for(id).into())
        }
    }
    pub async fn snapshot(&self) -> Value {
        let inner = self.inner.lock().await;
        let mut accounts:Vec<_>=inner.vault.accounts.iter().map(|a|json!({"id":a.id,"label":a.label,"email":a.email,"platform":"chatgpt","status":if a.needs_login||a.refresh.is_empty(){"signed-out"}else{"connected"}})).collect();
        let flow = inner
            .flow
            .as_ref()
            .map(|f| json!({"id":f.id,"platform":"chatgpt","status":f.status,"error":f.error,"accountId":f.account_id}))
            .or_else(|| {
                inner
                    .vault
                    .last_login_failure
                    .as_ref()
                    .map(|f| json!({"id":f.id,"platform":"chatgpt","status":"failed","error":f.error}))
            });
        drop(inner);
        let grok = self.grok.snapshot().await;
        accounts.extend(grok["accounts"].as_array().cloned().unwrap_or_default());
        let claude = self.claude.snapshot().await;
        accounts.extend(claude["accounts"].as_array().cloned().unwrap_or_default());
        let copilot = self.copilot.snapshot().await;
        accounts.extend(copilot["accounts"].as_array().cloned().unwrap_or_default());
        let cursor = self.cursor.snapshot().await;
        accounts.extend(cursor["accounts"].as_array().cloned().unwrap_or_default());
        let flow = match self.current_platform.lock().await.as_str() {
            "cursor" => cursor["flow"].clone(),
            "grok" => grok["flow"].clone(),
            "copilot" => copilot["flow"].clone(),
            "claude" => claude["flow"].clone(),
            _ => flow.unwrap_or(Value::Null),
        };
        let mut snapshot = json!({"accounts":accounts,"flow":flow,"grokInstalled":grok["installed"],"claudeInstalled":claude["installed"]});
        self.pool.decorate(&mut snapshot);
        snapshot
    }
    pub async fn validate_pool(&self, preferred: &str) -> Result<()> {
        let snapshot = self.snapshot().await;
        let lease = self.pool.choose(
            preferred,
            &snapshot,
            "",
            "",
            &std::collections::HashSet::new(),
        )?;
        self.credential(&lease.id).await?;
        Ok(())
    }
    pub async fn refresh_usage(&self, platform: &str) -> Result<()> {
        self.pool.usage_refresh_started(platform);
        let snapshot = self.snapshot().await;
        let ids: Vec<String> = snapshot["accounts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| a["platform"] == platform && a["status"] == "connected")
            .map(|a| text(a, "id").into())
            .collect();
        if !["copilot", "claude", "cursor", "grok"].contains(&platform) {
            return Err("此登录方式暂未提供可读取的套餐额度，请查看官方用量页面".into());
        }
        let results = futures_util::future::join_all(ids.iter().map(|id| async {
            let data = match platform {
                "copilot" => self.copilot.usage(id).await?,
                "claude" => self.claude.usage(id).await?,
                "cursor" => {
                    let token = self.cursor.credential(id).await?;
                    self.cursor
                        .unary(
                            "aiserver.v1.DashboardService/GetCurrentPeriodUsage",
                            &token,
                            &json!({}),
                        )
                        .await?
                }
                "grok" => {
                    let token = self.grok.credential(id).await?;
                    let mut request = self
                        .client
                        .get(format!("{}/billing?format=credits", self.grok.api()))
                        .bearer_auth(token)
                        .timeout(Duration::from_secs(8));
                    for (k, v) in self.grok.headers().await? {
                        request = request.header(k, v);
                    }
                    let response = request.send().await.map_err(|_| "读取 Grok 额度失败")?;
                    if !response.status().is_success() {
                        return Err(format!(
                            "读取 Grok 额度失败（HTTP {}）",
                            response.status().as_u16()
                        ));
                    }
                    response
                        .json::<Value>()
                        .await
                        .map_err(|_| "Grok 额度格式无法识别")?
                }
                _ => return Err("此登录方式暂未提供可读取的套餐额度".into()),
            };
            let parse_reset = |value: &Value| {
                value
                    .as_u64()
                    .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
                    .or_else(|| {
                        value
                            .as_str()
                            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                            .map(|t| t.timestamp().max(0) as u64)
                    })
                    .unwrap_or(0)
            };
            let windows: Vec<(f64, u64)> = match platform {
                "copilot" => {
                    let reset = parse_reset(&data["quota_reset_date_utc"])
                        .max(parse_reset(&data["quota_reset_date"]));
                    data["quota_snapshots"]
                        .as_object()
                        .into_iter()
                        .flat_map(|m| m.iter())
                        .filter(|(name, _)| name.as_str() == "premium_interactions")
                        .filter_map(|(_, q)| {
                            q["percent_remaining"].as_f64().map(|remaining| {
                                (remaining, parse_reset(&q["quota_reset_at"]).max(reset))
                            })
                        })
                        .collect()
                }
                "claude" => ["five_hour", "seven_day"]
                    .into_iter()
                    .filter_map(|key| {
                        data[key]["utilization"]
                            .as_f64()
                            .map(|used| (100. - used, parse_reset(&data[key]["resets_at"])))
                    })
                    .collect(),
                "cursor" => data["planUsage"]["totalPercentUsed"]
                    .as_f64()
                    .map(|used| vec![(100. - used, parse_reset(&data["billingCycleEnd"]) / 1000)])
                    .unwrap_or_default(),
                "grok" => data["config"]["creditUsagePercent"]
                    .as_f64()
                    .map(|used| {
                        vec![(
                            100. - used,
                            parse_reset(&data["config"]["currentPeriod"]["end"])
                                .max(parse_reset(&data["config"]["billingPeriodEnd"])),
                        )]
                    })
                    .unwrap_or_default(),
                _ => vec![],
            };
            let Some((remaining, reset)) = windows.into_iter().min_by(|a, b| a.0.total_cmp(&b.0))
            else {
                return Err("官方返回中没有可确认的套餐额度".into());
            };
            self.pool.quota(id, remaining, reset);
            Ok::<(), String>(())
        }))
        .await;
        results.into_iter().collect::<Result<Vec<_>>>()?;
        Ok(())
    }
    pub async fn begin_for(&self, platform: &str, id: &str) -> Result<Value> {
        if !["", "chatgpt", "grok", "copilot", "claude", "cursor"].contains(&platform) {
            return Err("暂不支持此订阅账号的授权".into());
        }
        self.cancel().await;
        let platform = if id.starts_with("cursor-") || platform == "cursor" {
            "cursor"
        } else if id.starts_with("claude-subscription-") || platform == "claude" {
            "claude"
        } else if id.starts_with("copilot-") || platform == "copilot" {
            "copilot"
        } else if id.starts_with("grok-") || platform == "grok" {
            "grok"
        } else {
            "chatgpt"
        };
        *self.current_platform.lock().await = platform.into();
        if platform == "cursor" {
            self.cursor.begin(id).await?;
            Ok(self.snapshot().await)
        } else if platform == "claude" {
            self.claude.begin(id).await?;
            Ok(self.snapshot().await)
        } else if platform == "copilot" {
            self.copilot.begin(id).await?;
            Ok(self.snapshot().await)
        } else if platform == "grok" {
            self.grok.begin(id).await?;
            Ok(self.snapshot().await)
        } else {
            self.begin(id).await
        }
    }
    pub async fn begin(&self, id: &str) -> Result<Value> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|_| "无法启动本地登录回调")?;
        let mut inner = self.inner.lock().await;
        let account = if id.is_empty() {
            None
        } else {
            Some(
                inner
                    .vault
                    .accounts
                    .iter()
                    .find(|a| a.id == id)
                    .cloned()
                    .ok_or("订阅账号不存在")?,
            )
        };
        if let Some(f) = &inner.flow {
            let _ = f.cancel.send(true);
        }
        inner.vault.last_login_failure = None;
        self.save(&inner.vault)?; // Persist this host's identity before registration.
        let state = random(24)?;
        let nonce = random(24)?;
        let verifier = random(48)?;
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let redirect = format!(
            "http://127.0.0.1:{}/auth/callback",
            listener.local_addr().map_err(err)?.port()
        );
        let mut url =
            reqwest::Url::parse(&format!("{}/api/accounts/authorize", self.issuer)).map_err(err)?;
        {
            let mut q = url.query_pairs_mut();
            q.extend_pairs([
                (
                    "client_id",
                    account
                        .as_ref()
                        .map(|a| a.client_id.as_str())
                        .unwrap_or("dynamic_agent_client"),
                ),
                ("ext_agent_host_id", inner.vault.host_id.as_str()),
                ("response_type", "code"),
                ("redirect_uri", redirect.as_str()),
                ("resource", RESOURCE),
                ("scope", SCOPE),
                ("state", state.as_str()),
                ("nonce", nonce.as_str()),
                ("code_challenge", challenge.as_str()),
                ("code_challenge_method", "S256"),
            ]);
            if let Some(a) = &account {
                if !a.id_token.is_empty() {
                    q.append_pair("id_token_hint", &a.id_token);
                }
                if !a.email.is_empty() {
                    q.append_pair("login_hint", &a.email);
                }
            } else {
                q.append_pair("agent_name_hint", "XwX Deck");
            }
        }
        let (cancel, mut cancelled) = tokio::sync::watch::channel(false);
        let id = random(18)?;
        inner.flow = Some(Flow {
            id: id.clone(),
            state,
            nonce,
            verifier,
            redirect,
            url: url.to_string(),
            account,
            status: "waiting".into(),
            error: String::new(),
            account_id: String::new(),
            cancel,
        });
        drop(inner);
        let engine = self.clone();
        let flow_id = id.clone();
        let app = Router::new()
            .route("/auth/callback", get(callback))
            .with_state((self.clone(), id));
        tokio::spawn(async move {
            let shutdown = async move {
                tokio::select! {_=cancelled.changed()=>{},_=tokio::time::sleep(Duration::from_secs(600))=>{
                    let mut inner=engine.inner.lock().await;
                    if let Some(f)=inner.flow.as_mut().filter(|f|f.id==flow_id&&f.status=="waiting") {
                        f.status="failed".into();f.error="登录已超时，请重试".into();
                        inner.vault.last_login_failure=Some(LoginFailure{id:flow_id,error:"登录已超时，请重试".into(),at:now()});
                        let _=engine.save(&inner.vault);
                    }
                }}
            };
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(shutdown)
                .await;
        });
        Ok(self.snapshot().await)
    }
    pub async fn authorization_url(&self) -> Result<String> {
        if *self.current_platform.lock().await == "cursor" {
            return self.cursor.authorization_url().await;
        }
        if *self.current_platform.lock().await == "claude" {
            return self.claude.authorization_url().await;
        }
        if *self.current_platform.lock().await == "copilot" {
            return self.copilot.authorization_url().await;
        }
        if *self.current_platform.lock().await == "grok" {
            return self.grok.authorization_url().await;
        }
        self.inner
            .lock()
            .await
            .flow
            .as_ref()
            .filter(|f| f.status == "waiting")
            .map(|f| f.url.clone())
            .ok_or("没有待完成的登录".into())
    }
    pub async fn test_url(&self) -> Result<String> {
        if !self.test {
            return Err("仅隔离订阅回归可读取授权 URL".into());
        }
        self.authorization_url().await
    }
    pub async fn cancel(&self) -> Value {
        self.claude.cancel().await;
        self.cursor.cancel().await;
        self.copilot.cancel().await;
        self.grok.cancel().await;
        if let Some(f) = self
            .inner
            .lock()
            .await
            .flow
            .as_mut()
            .filter(|f| f.status == "waiting" || f.status == "exchanging")
        {
            f.status = "cancelled".into();
            let _ = f.cancel.send(true);
        }
        self.snapshot().await
    }
    async fn json(&self, response: reqwest::Response) -> Result<Value> {
        use futures_util::StreamExt;
        let status = response.status();
        let ok = status.is_success();
        let mut stream = response.bytes_stream();
        let mut bytes = vec![];
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "授权服务响应中断")?;
            if bytes.len() + chunk.len() > 1024 * 1024 {
                return Err("授权服务响应过大".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| format!("授权服务返回无效数据（HTTP {status}）"))?;
        if !ok {
            let code = value["error"]
                .as_str()
                .or_else(|| value["error"]["code"].as_str())
                .unwrap_or("");
            return Err(match code {
                "invalid_grant"
                | "invalid_client"
                | "invalid_refresh_token"
                | "refresh_token_expired"
                | "token_expired" => format!("需要重新登录：{code}"),
                "access_denied" => "套餐授权被拒绝，请重新选择账号并授权".into(),
                "invalid_scope" => "授权服务不接受请求的套餐权限：invalid_scope".into(),
                _ => format!("授权服务请求失败（HTTP {status}），请稍后重试"),
            });
        }
        Ok(value)
    }
    async fn token(&self, form: &[(&str, &str)]) -> Result<Value> {
        let response = self
            .client
            .post(format!("{}/api/accounts/oauth/token", self.issuer))
            .form(form)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    "连接授权服务超时，请检查网络与系统代理"
                } else {
                    "无法连接授权服务，请检查网络与系统代理"
                }
            })?;
        self.json(response).await
    }
    async fn verify(&self, token: &str, client_id: &str, nonce: &str) -> Result<Value> {
        let header = decode_header(token).map_err(|_| "无效身份令牌")?;
        if ![Algorithm::RS256, Algorithm::ES256].contains(&header.alg) {
            return Err("不支持的身份签名算法".into());
        }
        let response = self
            .client
            .get(format!("{}/.well-known/jwks.json", self.issuer))
            .send()
            .await
            .map_err(|_| "无法验证账号身份")?;
        let keys: JwkSet =
            serde_json::from_value(self.json(response).await?).map_err(|_| "无效身份签名公钥")?;
        let jwk = keys
            .find(header.kid.as_deref().ok_or("身份令牌缺少签名标识")?)
            .ok_or("身份签名公钥不匹配")?;
        let key = DecodingKey::from_jwk(jwk).map_err(|_| "无效身份签名公钥")?;
        let mut validation = Validation::new(header.alg);
        validation.set_audience(&[client_id]);
        validation.set_issuer(&[&self.issuer]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        validation.validate_nbf = true;
        let claims = decode::<Value>(token, &key, &validation)
            .map_err(|_| "账号身份签名、有效期或所属应用验证失败")?
            .claims;
        if text(&claims, "nonce") != nonce || text(&claims, "sub").is_empty() {
            return Err("账号身份与本次登录不匹配".into());
        }
        Ok(claims)
    }
    fn apply_tokens(a: &mut Account, t: &Value) -> Result<()> {
        let scopes = text(t, "scope")
            .split_whitespace()
            .map(String::from)
            .collect::<Vec<_>>();
        if !scopes.iter().any(|s| s == DIRECT) || !scopes.iter().any(|s| s == "resource.invoke") {
            return Err("账号未授权使用 ChatGPT 套餐模型，请在授权页面允许套餐使用".into());
        }
        let expires = t["expires_in"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= 86400)
            .ok_or("授权令牌没有有效期")?;
        if text(t, "access_token").is_empty()
            || text(t, "refresh_token").is_empty()
            || !text(t, "token_type").eq_ignore_ascii_case("bearer")
        {
            return Err("授权服务未返回完整凭证".into());
        }
        a.access = text(t, "access_token").into();
        a.refresh = text(t, "refresh_token").into();
        a.scopes = scopes;
        a.expires = now() + expires;
        a.earliest_refresh_at = t["earliest_refresh_at"].as_u64().unwrap_or(0);
        a.needs_login = false;
        if !text(t, "id_token").is_empty() {
            a.id_token = text(t, "id_token").into();
        }
        Ok(())
    }
    async fn exchange(&self, f: &Flow, q: &HashMap<String, String>) -> Result<Account> {
        if q.contains_key("error") {
            return Err(if q.get("error").is_some_and(|e| e == "access_denied") {
                "未允许账号或套餐授权，请重新登录并确认授权"
            } else {
                "登录未获得授权，可重新尝试"
            }
            .into());
        }
        let issued = q
            .get("client_id")
            .filter(|s| !s.is_empty() && s.as_str() != "dynamic_agent_client")
            .map(String::as_str)
            .or_else(|| f.account.as_ref().map(|a| a.client_id.as_str()))
            .ok_or("账号注册未完成，请重试登录")?;
        if f.account.as_ref().is_some_and(|a| a.client_id != issued) {
            return Err("登录返回了其他账号的应用身份".into());
        }
        let code = q
            .get("code")
            .filter(|s| !s.is_empty())
            .ok_or("授权回调缺少登录码")?;
        let t = self
            .token(&[
                ("grant_type", "authorization_code"),
                ("client_id", issued),
                ("code", code),
                ("code_verifier", &f.verifier),
                ("redirect_uri", &f.redirect),
                ("resource", RESOURCE),
            ])
            .await
            .map_err(|e| format!("交换登录凭证失败：{e}"))?;
        let claims = self
            .verify(text(&t, "id_token"), issued, &f.nonce)
            .await
            .map_err(|e| format!("验证账号身份失败：{e}"))?;
        if f.account
            .as_ref()
            .is_some_and(|a| a.subject != text(&claims, "sub"))
        {
            return Err("登录账号与所选账号不一致，原账号已保留".into());
        }
        let mut account = Account {
            id: random(18)?,
            label: String::new(),
            subject: text(&claims, "sub").into(),
            email: text(&claims, "email").into(),
            client_id: issued.into(),
            access: String::new(),
            refresh: String::new(),
            id_token: String::new(),
            scopes: vec![],
            expires: 0,
            earliest_refresh_at: 0,
            needs_login: false,
        };
        Self::apply_tokens(&mut account, &t)?;
        Ok(account)
    }
    pub async fn credential(&self, id: &str) -> Result<String> {
        if id.starts_with("cursor-") {
            return self.cursor.credential(id).await;
        }
        if id.starts_with("claude-subscription-") {
            return self.claude.credential(id).await;
        }
        if id.starts_with("copilot-") {
            return self.copilot.credential(id).await;
        }
        if id.starts_with("grok-") {
            return self.grok.credential(id).await;
        }
        // Serialize rotation and atomic persistence under the same lock, including concurrent clients.
        let mut inner = self.inner.lock().await;
        let index = inner
            .vault
            .accounts
            .iter()
            .position(|a| a.id == id)
            .ok_or("订阅账号不存在")?;
        let mut a = inner.vault.accounts[index].clone();
        if a.needs_login || a.refresh.is_empty() {
            return Err("订阅账号需要重新登录".into());
        }
        if a.expires <= now() + 60 && a.earliest_refresh_at <= now() {
            let t = match self
                .token(&[
                    ("grant_type", "refresh_token"),
                    ("client_id", &a.client_id),
                    ("refresh_token", &a.refresh),
                    ("resource", RESOURCE),
                ])
                .await
            {
                Ok(t) => t,
                Err(e) => {
                    if e.starts_with("需要重新登录") {
                        inner.vault.accounts[index].needs_login = true;
                        self.save(&inner.vault)?;
                    }
                    return Err(e);
                }
            };
            let mut t = t;
            if let Some(object) = t.as_object_mut() {
                object.remove("id_token");
            }
            Self::apply_tokens(&mut a, &t)?;
            let mut vault = inner.vault.clone();
            vault.accounts[index] = a.clone();
            self.save(&vault)?;
            inner.vault = vault;
        }
        if a.expires <= now() {
            return Err("订阅账号授权已过期，请稍后刷新或重新登录".into());
        }
        Ok(a.access)
    }
    pub async fn cursor_response(&self, id: &str, body: &Value) -> Result<reqwest::Response> {
        self.cursor.response(id, body).await
    }
    pub async fn cursor_model_response(&self, id: &str) -> Result<reqwest::Response> {
        self.cursor.model_response(id).await
    }
    pub async fn catalog(&self, id: &str) -> Result<Value> {
        if id.starts_with("cursor-") {
            return self.cursor.catalog(id).await;
        }
        let token = self.credential(id).await?;
        let mut request = self
            .client
            .get(format!("{}/models", self.endpoint_for(id).await?))
            .bearer_auth(token);
        for (name, value) in self.headers(id).await? {
            request = request.header(name, value);
        }
        let response = request.send().await.map_err(|_| "订阅模型目录请求失败")?;
        self.json(response).await
    }
    pub async fn provider(&self, id: &str) -> Result<Provider> {
        if id.starts_with("cursor-") {
            return self.cursor.provider(id).await;
        }
        if id.starts_with("claude-subscription-") {
            return self.claude.provider(id).await;
        }
        if id.starts_with("copilot-") {
            return self.copilot.provider(id).await;
        }
        if id.starts_with("grok-") {
            return self.grok.provider(id).await;
        }
        let inner = self.inner.lock().await;
        let a = inner
            .vault
            .accounts
            .iter()
            .find(|a| a.id == id)
            .ok_or("订阅账号不存在")?;
        Ok(Provider {
            id: format!("subscription-{}", a.id),
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
    pub async fn sign_out(&self, id: &str) -> Result<Value> {
        if id.starts_with("cursor-") {
            return self.cursor.sign_out(id).await;
        }
        if id.starts_with("claude-subscription-") {
            return self.claude.sign_out(id).await;
        }
        if id.starts_with("copilot-") {
            return self.copilot.sign_out(id).await;
        }
        if id.starts_with("grok-") {
            return self.grok.sign_out(id).await;
        }
        let mut inner = self.inner.lock().await;
        let index = inner
            .vault
            .accounts
            .iter()
            .position(|a| a.id == id)
            .ok_or("订阅账号不存在")?;
        let a = inner.vault.accounts[index].clone();
        let revoked = async {
            let response = self
                .client
                .get(format!("{}/.well-known/openid-configuration", self.issuer))
                .send()
                .await
                .map_err(|_| "无法连接授权服务")?;
            let discovery = self.json(response).await?;
            let url = reqwest::Url::parse(text(&discovery, "revocation_endpoint")).map_err(err)?;
            let issuer = reqwest::Url::parse(&self.issuer).map_err(err)?;
            if url.origin() != issuer.origin()
                || !url.username().is_empty()
                || url.fragment().is_some()
            {
                return Err("无效退出登录端点".into());
            }
            let response = self
                .client
                .post(url)
                .form(&[
                    ("token", a.refresh.as_str()),
                    ("token_type_hint", "refresh_token"),
                    ("client_id", a.client_id.as_str()),
                ])
                .send()
                .await
                .map_err(|_| "无法连接授权服务")?;
            if response.status() != 200 {
                return Err("远端授权撤销未确认".into());
            }
            Ok::<_, String>(())
        }
        .await
        .is_ok();
        if let Some(f) = inner
            .flow
            .as_mut()
            .filter(|f| f.account.as_ref().is_some_and(|a| a.id == id))
        {
            f.status = "cancelled".into();
            let _ = f.cancel.send(true);
        }
        let a = &mut inner.vault.accounts[index];
        a.access.clear();
        a.refresh.clear();
        a.id_token.clear();
        a.needs_login = true;
        self.save(&inner.vault)?;
        Ok(
            json!({"revoked":revoked,"warning":if revoked{""}else{"已退出本机登录，远端撤销未确认；可在 ChatGPT 设置中断开授权"}}),
        )
    }
    pub async fn rename(&self, id: &str, label: &str) -> Result<()> {
        if id.starts_with("cursor-") {
            return self.cursor.rename(id, label).await;
        }
        if id.starts_with("claude-subscription-") {
            return self.claude.rename(id, label).await;
        }
        if id.starts_with("copilot-") {
            return self.copilot.rename(id, label).await;
        }
        if id.starts_with("grok-") {
            return self.grok.rename(id, label).await;
        }
        let mut inner = self.inner.lock().await;
        let mut next = inner.vault.clone();
        let a = next
            .accounts
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or("订阅账号不存在")?;
        a.label = label.into();
        self.save(&next)?;
        inner.vault = next;
        Ok(())
    }
    pub async fn headers(&self, id: &str) -> Result<Vec<(&'static str, String)>> {
        if id.starts_with("cursor-") {
            Ok(cursor_accounts::CursorAccounts::headers())
        } else if id.starts_with("claude-subscription-") {
            Ok(claude_accounts::ClaudeAccounts::headers())
        } else if id.starts_with("copilot-") {
            Ok(copilot_accounts::CopilotAccounts::headers())
        } else if id.starts_with("grok-") {
            self.grok.headers().await
        } else {
            Ok(vec![])
        }
    }
}
async fn callback(
    State((engine, id)): State<(Accounts, String)>,
    request: Request,
) -> (StatusCode, Html<String>) {
    let query = request.uri().query().unwrap_or("");
    if query.len() > 16384 {
        return (StatusCode::BAD_REQUEST, Html("登录回调过长。".into()));
    }
    let url = match reqwest::Url::parse(&format!("http://127.0.0.1/?{query}")) {
        Ok(url) => url,
        Err(_) => return (StatusCode::BAD_REQUEST, Html("无效登录回调。".into())),
    };
    let mut q = HashMap::new();
    for (key, value) in url.query_pairs() {
        if q.insert(key.into_owned(), value.into_owned()).is_some() {
            return (StatusCode::BAD_REQUEST, Html("重复登录参数。".into()));
        }
    }

    let flow = {
        let mut inner = engine.inner.lock().await;
        let Some(f) = inner
            .flow
            .as_mut()
            .filter(|f| f.id == id && f.status == "waiting")
        else {
            return (
                StatusCode::BAD_REQUEST,
                Html("登录已结束，请回到 XwX Deck 重试。".into()),
            );
        };
        if q.get("state") != Some(&f.state) {
            return (StatusCode::BAD_REQUEST, Html("登录回调不匹配。".into()));
        }
        f.status = "exchanging".into();
        f.clone()
    };
    let result = engine.exchange(&flow, &q).await;
    let mut inner = engine.inner.lock().await;
    if inner
        .flow
        .as_ref()
        .is_none_or(|f| f.id != id || f.status != "exchanging")
    {
        return (StatusCode::BAD_REQUEST, Html("登录已取消。".into()));
    }
    let result = result.and_then(|mut a| {
        let mut vault = inner.vault.clone();
        if let Some(index) = vault
            .accounts
            .iter()
            .position(|old| old.client_id == a.client_id && old.subject == a.subject)
        {
            a.id = vault.accounts[index].id.clone();
            a.label = vault.accounts[index].label.clone();
            vault.accounts[index] = a.clone();
        } else {
            a.label = format!("ChatGPT-{}", vault.accounts.len() + 1);
            vault.accounts.push(a.clone());
        }
        vault.last_login_failure = None;
        engine.save(&vault)?;
        inner.vault = vault;
        Ok(a.id)
    });
    let f = inner.flow.as_mut().unwrap();
    let ok = result.is_ok();
    match result {
        Ok(account) => {
            f.status = "complete".into();
            f.account_id = account;
        }
        Err(e) => {
            f.status = "failed".into();
            f.error = e;
        }
    }
    let _ = f.cancel.send(true);
    let error = f.error.clone();
    if !ok {
        inner.vault.last_login_failure = Some(LoginFailure {
            id: id.clone(),
            error: error.clone(),
            at: now(),
        });
        let _ = engine.save(&inner.vault);
    }
    let page = if ok {
        "<!doctype html><meta charset=utf-8><title>XwX Deck</title><p>账号已添加，请回到 XwX Deck。可以关闭此页面。</p>".to_string()
    } else {
        let escaped = error
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&#39;");
        format!("<!doctype html><meta charset=utf-8><title>XwX Deck</title><p>登录未完成：{escaped}</p><p>请回到 XwX Deck 重试。</p>")
    };
    (
        if ok {
            StatusCode::OK
        } else {
            StatusCode::BAD_REQUEST
        },
        Html(page),
    )
}
