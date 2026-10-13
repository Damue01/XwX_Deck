//! Read the client's official account without importing, refreshing or rewriting its credentials.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

pub(super) fn backend_subscription(provider: &Provider) -> bool {
    provider.official
        && provider.oauth
        && reqwest::Url::parse(&provider.base_url)
            .is_ok_and(|url| url.host_str() == Some("chatgpt.com"))
}

// The backend interprets Codex's private `version` header as a model gate.
// An actual 0.147 request succeeds with identical auth/body/User-Agent when
// that metadata is omitted. Keep the real client identity; never forge a newer
// version or retry a generation. Custom OAuth/API endpoints retain their header.
pub(super) fn omit_client_version(provider: &Provider, name: &str) -> bool {
    name == "version" && backend_subscription(provider)
}

pub(super) fn authorization(
    provider: &Provider,
    incoming: Option<&str>,
    third_party_tokens: &[String],
) -> Option<String> {
    // A long-lived CLI can retain the previous service's Key after a switch.
    // Replace only an exact known Key; keep refreshed official client tokens.
    let stale = backend_subscription(provider)
        && incoming
            .and_then(|value| value.strip_prefix("Bearer "))
            .is_some_and(|token| third_party_tokens.iter().any(|known| known == token));
    if provider.official && !stale {
        if let Some(value) = incoming {
            return Some(value.into());
        }
    }
    (!provider.bearer_token.is_empty()).then(|| format!("Bearer {}", provider.bearer_token))
}

pub(crate) struct ReadAccount {
    auth_path: PathBuf,
    usage_url: String,
    cache_root: PathBuf,
}

impl ReadAccount {
    pub(super) fn new(home: PathBuf, usage_url: String, cache_root: PathBuf) -> Self {
        Self {
            auth_path: home.join("auth.json"),
            usage_url,
            cache_root,
        }
    }

    pub fn cached(self) -> Result<Value> {
        let auth: Value = read(&self.auth_path)?
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|_| "官方登录文件无法读取，请在 ChatGPT 中检查登录后重试")?
            .unwrap_or(Value::Null);
        let mut account = official_accounts::metadata("official-chatgpt", &auth);
        official_usage_cache::apply(&self.cache_root, &mut account);
        Ok(account)
    }

    pub async fn execute(self) -> Result<Value> {
        let source = read(&self.auth_path)?;
        let auth: Value = source
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|_| "官方登录文件无法读取，请在 ChatGPT 中检查登录后重试")?
            .unwrap_or(Value::Null);
        let token = auth["tokens"]["access_token"]
            .as_str()
            .filter(|s| !s.is_empty());
        // The ID token is display metadata only. Never derive routing headers from unverified claims.
        let identity = auth["tokens"]["id_token"]
            .as_str()
            .and_then(|s| s.split('.').nth(1))
            .and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .unwrap_or(Value::Null);
        let mut account = json!({"id":"official-chatgpt","accountKey":official_accounts::account_key(&auth),"label":identity["name"].as_str().filter(|s|!s.trim().is_empty()).or_else(||identity["email"].as_str()).unwrap_or("ChatGPT"),"platform":"chatgpt","authKind":"official","externalLogin":true,
            "email":identity["email"].as_str().unwrap_or(""),
            "status":if token.is_some(){"connected"}else{"signed-out"}});
        let Some(token) = token else {
            official_usage_cache::forget(&self.cache_root, "official-chatgpt");
            account["quotaError"] = json!("请先在 ChatGPT 或 Codex CLI 中登录，完成后刷新");
            return Ok(account);
        };
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|_| "无法初始化官方额度查询")?;
        let mut request = client
            .get(&self.usage_url)
            .bearer_auth(token)
            .header("user-agent", "XwX-Deck/1.1.7");
        if let Some(id) = auth["tokens"]["account_id"]
            .as_str()
            .or_else(|| auth["account_id"].as_str())
            .filter(|s| !s.is_empty())
        {
            request = request.header("ChatGPT-Account-Id", id);
        }
        let checked = (millis() / 1000) as u64;
        let result = async {
            let response = request.send().await.map_err(|_| "读取官方额度失败，请检查网络后重试".to_string())?;
            let status = response.status().as_u16();
            account["quotaDetails"] = json!({"source":"chatgpt-wham","checkedAt":checked,"httpStatus":status,"windows":[]});
            if !response.status().is_success() {
                return Err(if status == 401 {
                    "官方登录暂时未通过验证（HTTP 401），请在 ChatGPT 中确认登录后刷新".into()
                } else { format!("读取官方额度失败（HTTP {status}），请稍后重试") });
            }
            let data = response.json::<Value>().await.map_err(|_| "官方额度响应无法识别，请重试".to_string())?;
            let (mut details, quota) = chatgpt_usage::parse(&data);
            details["checkedAt"] = json!(checked);
            account["quotaDetails"] = details;
            if let Some((remaining, reset)) = quota {
                account["quota"] = json!({"remainingPercent":remaining,"resetsAt":reset,"checkedAt":checked});
            } else {
                return Err("官方暂未返回完整额度，请稍后刷新或查看官方用量页".into());
            }
            Ok::<(), String>(())
        }.await;
        // A user may log in to a different account while this request is in flight.
        if read(&self.auth_path)? != source {
            return Err("官方登录已变化，请刷新以读取当前账号额度".into());
        }
        if account["quotaDetails"]["httpStatus"] == 200 {
            official_usage_cache::store(&self.cache_root, &account);
        } else if [json!(401), json!(403)].contains(&account["quotaDetails"]["httpStatus"]) {
            official_usage_cache::forget(&self.cache_root, "official-chatgpt");
        } else {
            official_usage_cache::apply(&self.cache_root, &mut account);
        }
        if let Err(error) = result {
            account["quotaError"] = json!(error);
        }
        Ok(account)
    }
}

#[cfg(test)]
mod transport_tests {
    use super::*;

    #[test]
    fn official_switch_replaces_only_a_known_third_party_key() {
        let mut provider = Provider {
            official: true,
            oauth: true,
            base_url: "https://chatgpt.com/backend-api".into(),
            bearer_token: "saved-official-oauth".into(),
            ..Provider::default()
        };
        let known = vec!["old-api-key".into()];
        assert_eq!(
            authorization(&provider, Some("Bearer old-api-key"), &known).as_deref(),
            Some("Bearer saved-official-oauth")
        );
        assert_eq!(
            authorization(&provider, Some("Bearer refreshed-official-oauth"), &known).as_deref(),
            Some("Bearer refreshed-official-oauth")
        );
        provider.base_url = "https://custom.example/backend-api".into();
        assert_eq!(
            authorization(&provider, Some("Bearer old-api-key"), &known).as_deref(),
            Some("Bearer old-api-key")
        );
        provider.official = false;
        assert_eq!(
            authorization(&provider, Some("Bearer unrelated"), &known).as_deref(),
            Some("Bearer saved-official-oauth")
        );
    }

    #[test]
    fn private_client_version_is_omitted_only_for_the_official_backend() {
        let mut p = Provider {
            official: true,
            oauth: true,
            base_url: "https://chatgpt.com/backend-api".into(),
            ..Provider::default()
        };
        assert!(omit_client_version(&p, "version"));
        for header in [
            "user-agent",
            "authorization",
            "chatgpt-account-id",
            "originator",
        ] {
            assert!(!omit_client_version(&p, header));
        }
        for base in [
            "https://chatgpt.com.example.org/backend-api",
            "https://custom.example/backend-api",
            "https://api.openai.com/v1",
        ] {
            p.base_url = base.into();
            assert!(!omit_client_version(&p, "version"));
        }
        p.base_url = "https://chatgpt.com/backend-api".into();
        p.oauth = false;
        assert!(!omit_client_version(&p, "version"));
        p.oauth = true;
        p.official = false;
        assert!(!omit_client_version(&p, "version"));
    }
}
