//! Imported accounts follow a user-selected local login. Refresh credentials
//! stay with their original owner; only metadata and a bound reference persist.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

pub(super) const KEY: &str = "importedSubscriptionAccounts";
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Registration {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub email: String,
    pub identity: String,
    pub path: String,
    pub agent: String,
    pub record_id: String,
    pub user: String,
    pub client_id: String,
}
pub(super) fn is_imported(id: &str) -> bool {
    id.starts_with("official-chatgpt-import-") || id.starts_with("chatgpt-api-import-")
}
fn claims(token: &str) -> Value {
    token
        .split('.')
        .nth(1)
        .and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}
pub(super) fn api_identity(subject: &str, email: &str, workspace: &str) -> String {
    storage::digest(format!("api\0{subject}\0{email}\0{workspace}").as_bytes())
}
impl Registration {
    pub fn new(path: &Path, row: &Value, agent: &str, auth: &Value) -> Result<Self> {
        let official = agent == "codex";
        let token = if official {
            text(&auth["tokens"], "id_token")
        } else {
            text(auth, "idToken")
        };
        let claims = claims(token);
        let email = field_or(&claims, "email", text(auth, "email"));
        let subject = field_or(&claims, "sub", text(auth, "sub"));
        let workspace = text(&claims["https://api.openai.com/auth"], "chatgpt_account_id");
        let identity = if official {
            official_accounts::account_key(auth)
        } else {
            api_identity(subject, email, workspace)
        };
        if official && (text(&auth["tokens"], "account_id").is_empty() || subject.is_empty())
            || !official && subject.is_empty() && email.is_empty()
        {
            return Err("账号身份信息不完整，请在来源应用重新登录".into());
        }
        let user = text(row, "user");
        let label = field_or(&claims, "name", if email.is_empty() { user } else { email });
        Ok(Self {
            id: format!(
                "{}-import-{}",
                if official {
                    "official-chatgpt"
                } else {
                    "chatgpt-api"
                },
                &identity[..24]
            ),
            kind: if official { "official" } else { "api" }.into(),
            label: if label.is_empty() { "ChatGPT" } else { label }.into(),
            email: email.into(),
            identity,
            path: path.to_string_lossy().into(),
            agent: agent.into(),
            record_id: text(row, "id").into(),
            user: user.into(),
            client_id: text(auth, "clientId").into(),
        })
    }
    pub fn auth(&self, root: &Path, isolated: bool) -> Result<Value> {
        let path = Path::new(&self.path);
        if isolated && !config_import::within_isolated_root(path, root) {
            return Err("隔离验收不能读取外部账号文件".into());
        }
        let document = config_import::json_file(path)
            .map_err(|_| "来源登录无法读取，请在原应用确认登录后重新检测")?;
        let auth = if self.agent == "auth-file" {
            document
        } else {
            let rows = document
                .as_array()
                .ok_or("来源账号文件格式已变化，请重新导入")?;
            let row = rows
                .iter()
                .find(|row| {
                    text(row, "agent") == self.agent
                        && if self.record_id.is_empty() {
                            text(row, "user") == self.user
                        } else {
                            text(row, "id") == self.record_id
                        }
                })
                .ok_or("来源账号已移除，请重新登录或移除导入账号")?;
            if !text(row, "lapsed").is_empty() {
                return Err("来源授权已失效，请在原应用重新登录后重新检测".into());
            }
            row["auth"].clone()
        };
        let kind = if self.kind == "official" {
            "codex"
        } else {
            "chatgpt-api"
        };
        let current = Self::new(path, &json!({}), kind, &auth)?;
        if current.identity != self.identity || current.client_id != self.client_id {
            return Err("来源登录已换成其他账号，请重新检测并导入；原关联未改变".into());
        }
        let token = if self.kind == "official" {
            text(&auth["tokens"], "access_token")
        } else {
            text(&auth, "access")
        };
        if token.is_empty() {
            return Err("来源账号未登录，请在原应用登录后重新检测".into());
        }
        let expires = claims(token)["exp"].as_u64().or_else(|| {
            auth["expires"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|t| t.timestamp().max(0) as u64)
        });
        if expires.is_some_and(|t| t <= (millis() / 1000) as u64) {
            return Err("来源授权已过期，请在原应用刷新登录后重新检测".into());
        }
        if self.kind == "api"
            && (!auth["scopes"].as_array().is_some_and(|scopes| {
                scopes
                    .iter()
                    .any(|scope| scope == "chatgpt.tokens.use.direct")
            }) || self.client_id.is_empty())
        {
            return Err("来源授权不支持 ChatGPT API，请重新登录授权".into());
        }
        Ok(auth)
    }
    pub fn metadata(&self, root: &Path, isolated: bool) -> Value {
        let auth = self.auth(root, isolated);
        json!({"id":self.id,"platform":"chatgpt","authKind":self.kind,"label":self.label,"email":self.email,
            "accountKey":self.identity,"importedLogin":true,"status":if auth.is_ok(){"connected"}else{"signed-out"},
            "sourceError":auth.err()})
    }
    pub fn provider(&self, base: String) -> Provider {
        Provider {
            id: format!("subscription-{}", self.id),
            display_name: self.label.clone(),
            account_label: self.email.clone(),
            subscription_account_id: self.id.clone(),
            base_url: base,
            codex_provider_id: "xwx_deck".into(),
            adapter: "responses".into(),
            codex_api_format: "responses".into(),
            provider_preset: "auto".into(),
            claude_models: json!({"fable":"","opus":"","sonnet":"","haiku":""}),
            ..Default::default()
        }
    }
}
fn field_or<'a>(value: &'a Value, key: &str, fallback: &'a str) -> &'a str {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback)
}
pub(super) fn registrations(root: &Path) -> Result<Vec<Registration>> {
    let settings: Value = read(&root.join("settings.json"))?
        .map(|s| serde_json::from_str(&s).map_err(err))
        .transpose()?
        .unwrap_or(Value::Null);
    serde_json::from_value(settings.get(KEY).cloned().unwrap_or(json!([])))
        .map_err(|_| "导入账号记录无法读取，请修复设置后重试".into())
}
pub(super) fn find(root: &Path, id: &str) -> Result<Registration> {
    registrations(root)?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or("导入账号已移除，请重新选择账号".into())
}
