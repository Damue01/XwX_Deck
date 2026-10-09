//! Account routing metadata contains no credentials. Leases live through the response stream.
use super::*;
use std::collections::{HashMap, HashSet};
pub(super) fn platform(id: &str) -> &'static str {
    if id.starts_with("cursor-") {
        "cursor"
    } else if id.starts_with("claude-subscription-") {
        "claude"
    } else if id.starts_with("copilot-") {
        "copilot"
    } else if id.starts_with("grok-") {
        "grok"
    } else {
        "chatgpt"
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct Policy {
    pub strategy: String,
    pub fixed_account_id: String,
    pub excluded_account_ids: Vec<String>,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            strategy: "exhaust".into(),
            fixed_account_id: String::new(),
            excluded_account_ids: vec![],
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Quota {
    pub remaining_percent: f64,
    pub resets_at: u64,
    pub checked_at: u64,
}
#[derive(Default)]
struct Runtime {
    affinity: HashMap<String, (String, u64)>,
    active: HashMap<String, u64>,
    uses: HashMap<String, u64>,
    blocked: HashMap<String, (u64, String)>,
    quotas: HashMap<String, Quota>,
    notices: Vec<Value>,
    serial: u64,
    last_account: HashMap<String, String>,
    exhaust_account: HashMap<String, String>,
    models: HashMap<String, HashSet<String>>,
    rejected_models: HashSet<(String, String)>,
    quota_refresh: HashMap<String, u64>,
}
#[derive(Clone)]
pub(super) struct Pool {
    path: PathBuf,
    expected_disk: Arc<std::sync::Mutex<Option<String>>>,
    policies: Arc<std::sync::Mutex<HashMap<String, Policy>>>,
    runtime: Arc<std::sync::Mutex<Runtime>>,
}
pub(super) struct Lease {
    pool: Pool,
    pub id: String,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.pool.runtime.lock() {
            if let Some(count) = state.active.get_mut(&self.id) {
                *count = count.saturating_sub(1);
            }
        }
    }
}
impl Pool {
    pub fn open(root: &Path) -> Result<Self> {
        let path = root.join("subscription-routing.json");
        let disk = read(&path)?;
        let policies = disk
            .as_ref()
            .map(|s| {
                serde_json::from_str(s).map_err(|_| "账号策略文件损坏，原文件已保留".to_string())
            })
            .transpose()?
            .unwrap_or_default();
        Ok(Self {
            path,
            expected_disk: Arc::new(std::sync::Mutex::new(disk)),
            policies: Arc::new(std::sync::Mutex::new(policies)),
            runtime: Arc::new(std::sync::Mutex::new(Runtime::default())),
        })
    }
    pub fn save(&self, service: &str, policy: Policy) -> Result<()> {
        if !["chatgpt", "claude", "grok", "copilot", "cursor"].contains(&service)
            || ![
                "exhaust",
                "most-remaining",
                "reset-soon",
                "balanced",
                "fixed",
            ]
            .contains(&policy.strategy.as_str())
        {
            return Err("无效账号策略".into());
        }
        let mut policies = self.policies.lock().map_err(err)?;
        let mut expected = self.expected_disk.lock().map_err(err)?;
        let current = read(&self.path)?;
        if current != *expected {
            return Err("账号策略已在外部修改，原文件已保留。请重新打开应用后重试。".into());
        }
        let mut document: Value = current
            .as_ref()
            .map(|source| serde_json::from_str(source).map_err(err))
            .transpose()?
            .unwrap_or_else(|| json!({}));
        if !document[service].is_object() {
            document[service] = json!({});
        }
        let serialized = serde_json::to_value(&policy).map_err(err)?;
        for (key, value) in serialized.as_object().unwrap() {
            document[service][key] = value.clone();
        }
        let saved = serde_json::to_string(&document).map_err(err)?;
        write(&self.path, &saved)?;
        *expected = Some(saved);
        policies.insert(service.into(), policy);
        // Existing response leases remain valid; new requests observe the new policy.
        Ok(())
    }
    pub fn decorate(&self, snapshot: &mut Value) {
        let now = (millis() / 1000) as u64;
        let policies = self.policies.lock().unwrap();
        let state = self.runtime.lock().unwrap();
        snapshot["routing"] = json!(["chatgpt", "claude", "grok", "copilot", "cursor"]
            .into_iter()
            .map(|service| (service, policies.get(service).cloned().unwrap_or_default()))
            .collect::<HashMap<_, _>>());
        if let Some(accounts) = snapshot["accounts"].as_array_mut() {
            for account in accounts {
                let id = text(account, "id").to_string();
                account["activeRequests"] = json!(state.active.get(&id).copied().unwrap_or(0));
                if let Some((until, reason)) =
                    state.blocked.get(&id).filter(|(until, _)| *until > now)
                {
                    account["cooldownUntil"] = json!(until);
                    account["routingStatus"] = json!(reason);
                }
                if let Some(quota) = state.quotas.get(&id).filter(|q| {
                    now.saturating_sub(q.checked_at) < 300
                        && (q.resets_at == 0 || q.resets_at > now)
                }) {
                    account["quota"] = json!(quota);
                }
            }
        }
    }
    pub fn refresh_due(&self, service: &str) -> bool {
        let policy = self
            .policies
            .lock()
            .unwrap()
            .get(service)
            .cloned()
            .unwrap_or_default();
        if !["most-remaining", "reset-soon"].contains(&policy.strategy.as_str()) {
            return false;
        }
        let now = (millis() / 1000) as u64;
        let mut state = self.runtime.lock().unwrap();
        if state
            .quota_refresh
            .get(service)
            .is_some_and(|at| now.saturating_sub(*at) < 300)
        {
            return false;
        }
        state.quota_refresh.insert(service.into(), now);
        true
    }
    pub fn usage_refresh_started(&self, service: &str) {
        self.runtime
            .lock()
            .unwrap()
            .quota_refresh
            .insert(service.into(), (millis() / 1000) as u64);
    }
    pub fn quota(&self, id: &str, remaining: f64, resets: u64) {
        if !remaining.is_finite() {
            return;
        }
        let mut state = self.runtime.lock().unwrap();
        if remaining > 0.
            && state
                .blocked
                .get(id)
                .is_some_and(|(_, reason)| reason == "额度已用完")
        {
            state.blocked.remove(id);
        }
        state.quotas.insert(
            id.into(),
            Quota {
                remaining_percent: remaining.clamp(0., 100.),
                resets_at: resets,
                checked_at: (millis() / 1000) as u64,
            },
        );
    }
    pub fn notices(&self) -> Value {
        json!(self.runtime.lock().unwrap().notices)
    }
    pub fn choose(
        &self,
        preferred: &str,
        accounts: &Value,
        session: &str,
        model: &str,
        attempted: &HashSet<String>,
    ) -> Result<Lease> {
        let service = platform(preferred);
        let policy = self
            .policies
            .lock()
            .map_err(err)?
            .get(service)
            .cloned()
            .unwrap_or_default();
        let now = (millis() / 1000) as u64;
        let mut state = self.runtime.lock().map_err(err)?;
        state
            .affinity
            .retain(|_, (_, at)| now.saturating_sub(*at) < 24 * 3600);
        if state.affinity.len() > 4096 {
            state.affinity.clear();
        }
        let key = format!("{service}:{session}");
        let mut candidates: Vec<String> = accounts["accounts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| text(a, "platform") == service && text(a, "status") == "connected")
            .map(|a| text(a, "id").to_string())
            .filter(|id| {
                !attempted.contains(id)
                    && (policy.strategy == "fixed" || !policy.excluded_account_ids.contains(id))
                    && (policy.strategy != "fixed" || *id == policy.fixed_account_id)
                    && state.blocked.get(id).is_none_or(|(until, _)| *until <= now)
                    && !state.rejected_models.contains(&(id.clone(), model.into()))
                    && (id == preferred
                        || model.is_empty()
                        || policy.strategy == "fixed"
                        || state
                            .models
                            .get(id)
                            .is_none_or(|models| models.contains(model)))
            })
            .collect();
        if candidates.is_empty() {
            return Err(if policy.strategy == "fixed" {
                "固定账号不可用，请重新登录或调整账号策略"
            } else {
                "此订阅暂无可用账号，请检查登录和套餐用量"
            }
            .into());
        }
        let sticky = if session.is_empty() {
            None
        } else {
            state.affinity.get(&key).map(|(id, _)| id.clone())
        };
        let score = |id: &String| {
            let quota = state.quotas.get(id).filter(|q| {
                now.saturating_sub(q.checked_at) < 300 && (q.resets_at == 0 || q.resets_at > now)
            });
            let active = state.active.get(id).copied().unwrap_or(0);
            let uses = state.uses.get(id).copied().unwrap_or(0);
            let rank = match policy.strategy.as_str() {
                "balanced" => (active, uses),
                "most-remaining" => quota
                    .map(|q| (0, ((100. - q.remaining_percent) * 1000.) as u64))
                    .unwrap_or((1, uses)),
                "reset-soon" => quota
                    .filter(|q| q.resets_at > now && q.remaining_percent > 0.)
                    .map(|q| (0, q.resets_at))
                    .unwrap_or((1, uses)),
                _ => (
                    if id
                        == state
                            .exhaust_account
                            .get(preferred)
                            .map(String::as_str)
                            .unwrap_or(preferred)
                    {
                        0
                    } else {
                        1
                    },
                    0,
                ),
            };
            (
                if sticky.as_ref() == Some(id) { 0 } else { 1 },
                rank,
                id.clone(),
            )
        };
        candidates.sort_by_key(score);
        let id = candidates[0].clone();
        *state.active.entry(id.clone()).or_default() += 1;
        *state.uses.entry(id.clone()).or_default() += 1;
        if !session.is_empty() {
            state.affinity.insert(key, (id.clone(), now));
        }
        Ok(Lease {
            pool: self.clone(),
            id,
        })
    }
    pub fn reject(
        &self,
        id: &str,
        status: u16,
        headers: &axum::http::HeaderMap,
        body: &[u8],
    ) -> bool {
        let message = String::from_utf8_lossy(body).to_lowercase();
        let reason = match status {
            401 => "需重新登录",
            429 => {
                if ["quota", "usage_limit", "exhaust", "额度", "limit_reached"]
                    .iter()
                    .any(|word| message.contains(word))
                {
                    "额度已用完"
                } else {
                    "暂时限流"
                }
            }
            _ => return false,
        };
        let now = (millis() / 1000) as u64;
        let reset = self
            .runtime
            .lock()
            .unwrap()
            .quotas
            .get(id)
            .map(|q| q.resets_at)
            .filter(|at| *at > now);
        let delay = headers
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(if status == 401 {
                24 * 3600
            } else if reason == "额度已用完" {
                reset.map(|at| at - now).unwrap_or(15 * 60)
            } else {
                60
            })
            .clamp(1, 24 * 3600);
        self.runtime
            .lock()
            .unwrap()
            .blocked
            .insert(id.into(), (now + delay, reason.into()));
        true
    }
    pub fn reject_model(&self, id: &str, model: &str, body: &[u8]) -> bool {
        let code = serde_json::from_slice::<Value>(body)
            .ok()
            .map(|value| text(&value["error"], "code").to_string())
            .unwrap_or_default();
        if ![
            "model_not_found",
            "model_not_supported",
            "unsupported_model",
        ]
        .contains(&code.as_str())
        {
            return false;
        }
        self.runtime
            .lock()
            .unwrap()
            .rejected_models
            .insert((id.into(), model.into()));
        true
    }
    pub fn catalog(&self, id: &str, entries: &Value) {
        if let Some(entries) = entries.as_array() {
            self.runtime.lock().unwrap().models.insert(
                id.into(),
                entries
                    .iter()
                    .filter_map(|entry| entry["id"].as_str().map(str::to_string))
                    .collect(),
            );
        }
    }
    pub fn bind_response(&self, account: &str, id: &str) {
        if id.is_empty() || id.len() > 256 {
            return;
        }
        self.runtime.lock().unwrap().affinity.insert(
            format!("{}:response:{id}", platform(account)),
            (account.into(), (millis() / 1000) as u64),
        );
    }
    pub fn observe(&self, account: &str, bytes: &[u8]) {
        let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
            return;
        };
        if let Some(id) = value["response"]["id"].as_str().or_else(|| {
            if value["object"] == "response" {
                value["id"].as_str()
            } else {
                None
            }
        }) {
            self.bind_response(account, id);
        }
        let code = value["response"]["error"]["code"]
            .as_str()
            .or_else(|| value["error"]["code"].as_str())
            .unwrap_or("");
        if [
            "usage_limit_reached",
            "quota_exceeded",
            "insufficient_quota",
        ]
        .contains(&code)
        {
            self.reject(account, 429, &axum::http::HeaderMap::new(), b"quota");
        }
    }
    pub fn recovered(&self, id: &str) {
        let mut state = self.runtime.lock().unwrap();
        state.blocked.remove(id);
        state.rejected_models.retain(|(account, _)| account != id);
    }
    pub fn switched(&self, from: &str, to: &str, accounts: &Value) {
        let label = accounts["accounts"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|a| a["id"] == to)
            .map(|a| text(a, "label"))
            .unwrap_or("其他账号");
        let mut state = self.runtime.lock().unwrap();
        let service = platform(to).to_string();
        state.exhaust_account.insert(from.into(), to.into());
        let previous = state.last_account.insert(service, to.into());
        if previous.as_deref() == Some(to) || (previous.is_none() && from == to) {
            return;
        }
        state.serial += 1;
        let serial = state.serial;
        state
            .notices
            .push(json!({"id":serial,"message":format!("订阅账号已切换到 {label}")}));
        if state.notices.len() > 16 {
            state.notices.remove(0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pool() -> Pool {
        Pool {
            path: std::env::temp_dir().join(format!("xwx-routing-unit-{}.json", millis())),
            expected_disk: Arc::new(std::sync::Mutex::new(None)),
            policies: Arc::new(std::sync::Mutex::new(HashMap::new())),
            runtime: Arc::new(std::sync::Mutex::new(Runtime::default())),
        }
    }
    fn accounts() -> Value {
        json!({"accounts":[{"id":"a","platform":"chatgpt","status":"connected"},{"id":"b","platform":"chatgpt","status":"connected"},{"id":"cursor-other","platform":"cursor","status":"connected"}]})
    }
    #[test]
    fn quota_strategies_keep_conversation_affinity_and_ignore_stale_values() {
        let pool = pool();
        let now = (millis() / 1000) as u64;
        pool.quota("a", 20., now + 60);
        pool.quota("b", 80., now + 3600);
        pool.policies.lock().unwrap().insert(
            "chatgpt".into(),
            Policy {
                strategy: "most-remaining".into(),
                ..Policy::default()
            },
        );
        assert_eq!(
            pool.choose("a", &accounts(), "conversation", "model", &HashSet::new())
                .unwrap()
                .id,
            "b"
        );
        pool.policies
            .lock()
            .unwrap()
            .get_mut("chatgpt")
            .unwrap()
            .strategy = "reset-soon".into();
        assert_eq!(
            pool.choose("a", &accounts(), "new", "model", &HashSet::new())
                .unwrap()
                .id,
            "a"
        );
        assert_eq!(
            pool.choose("a", &accounts(), "conversation", "model", &HashSet::new())
                .unwrap()
                .id,
            "b"
        );
        pool.runtime
            .lock()
            .unwrap()
            .quotas
            .get_mut("b")
            .unwrap()
            .checked_at = now - 600;
        pool.policies
            .lock()
            .unwrap()
            .get_mut("chatgpt")
            .unwrap()
            .strategy = "most-remaining".into();
        assert_eq!(
            pool.choose("a", &accounts(), "third", "model", &HashSet::new())
                .unwrap()
                .id,
            "a"
        );
    }
    #[test]
    fn exhaust_retains_each_existing_starting_account_and_its_replacement() {
        let pool = pool();
        pool.switched("a", "a", &accounts());
        assert_eq!(
            pool.choose("b", &accounts(), "", "model", &HashSet::new())
                .unwrap()
                .id,
            "b"
        );
        pool.switched("a", "b", &accounts());
        pool.recovered("a");
        assert_eq!(
            pool.choose("a", &accounts(), "", "model", &HashSet::new())
                .unwrap()
                .id,
            "b"
        );
    }
    #[test]
    fn background_quota_refresh_is_bounded_and_only_for_quota_policies() {
        let pool = pool();
        assert!(!pool.refresh_due("chatgpt"));
        pool.policies.lock().unwrap().insert(
            "chatgpt".into(),
            Policy {
                strategy: "most-remaining".into(),
                ..Policy::default()
            },
        );
        assert!(pool.refresh_due("chatgpt"));
        assert!(!pool.refresh_due("chatgpt"));
        pool.usage_refresh_started("chatgpt");
        assert!(!pool.refresh_due("chatgpt"));
    }
    #[test]
    fn response_affinity_and_known_model_capabilities() {
        let pool = pool();
        pool.catalog("b", &json!([{"id":"other-model"}]));
        pool.reject("a", 429, &axum::http::HeaderMap::new(), b"quota");
        assert!(pool
            .choose("a", &accounts(), "", "model", &HashSet::new())
            .is_err());
        pool.recovered("a");
        pool.bind_response("b", "resp-original");
        assert_eq!(
            pool.choose(
                "a",
                &accounts(),
                "response:resp-original",
                "other-model",
                &HashSet::new()
            )
            .unwrap()
            .id,
            "b"
        );
        assert_eq!(
            pool.choose(
                "a",
                &accounts(),
                "",
                "unlisted-retained-model",
                &HashSet::new()
            )
            .unwrap()
            .id,
            "a"
        );
    }
}
