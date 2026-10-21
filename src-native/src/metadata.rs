//! Public metadata refresh stays independent of model selection and UI RPC.
use super::*;
use futures_util::StreamExt;
use std::sync::atomic::AtomicBool;
#[derive(Clone)]
struct Endpoints {
    events: String,
    models: String,
    reconnect: Duration,
    fallback: Duration,
}
#[derive(Clone)]
pub(crate) struct Metadata {
    root: PathBuf,
    endpoints: Option<Endpoints>,
    gate: Arc<Mutex<()>>,
    stopped: Arc<AtomicBool>,
    stop: Arc<tokio::sync::Notify>,
}
fn test_argument(name: &str) -> Option<String> {
    std::env::args()
        .collect::<Vec<_>>()
        .windows(2)
        .find(|a| a[0] == name)
        .map(|a| a[1].clone())
}
impl Metadata {
    pub fn new(root: PathBuf, isolated: bool) -> Result<Self> {
        let test = test_argument("--metadata-test-endpoint");
        let live = std::env::args().any(|a| a == "--pilot-live-metadata");
        if live
            && (!isolated
                || [
                    "XWX_DECK_TEST_SECURE_STORE",
                    "XWX_DECK_TEST_PRIVATE_STORE",
                    "XWX_DECK_TEST_MIGRATE_PRIVATE_STORE",
                ]
                .iter()
                .any(|name| std::env::var(name).as_deref() == Ok("1"))
                || test.is_some())
        {
            return Err("真实元数据只允许独立真实凭据验收，不能混用模拟服务".into());
        }
        let endpoints = if let Some(base) = test {
            let url = reqwest::Url::parse(&base).map_err(|_| "元数据测试地址无效")?;
            if !isolated
                || !std::env::args().any(|a| a == "--rpc")
                || url.scheme() != "http"
                || url.host_str() != Some("127.0.0.1")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("元数据测试只允许隔离 RPC 的回环服务".into());
            }
            let base = base.trim_end_matches('/');
            Some(Endpoints {
                events: format!("{base}/events"),
                models: format!("{base}/models-dev"),
                reconnect: Duration::from_millis(150),
                fallback: Duration::from_millis(2000),
            })
        } else if isolated && !live {
            None
        } else {
            Some(Endpoints {
                events: crate::edition::config::metadata_events(),
                models: "https://models.dev/api.json".into(),
                reconnect: Duration::from_secs(60),
                fallback: Duration::from_secs(6 * 60 * 60),
            })
        };
        Ok(Self {
            root,
            endpoints,
            gate: Arc::new(Mutex::new(())),
            stopped: Arc::new(AtomicBool::new(false)),
            stop: Arc::new(tokio::sync::Notify::new()),
        })
    }
    pub fn shutdown(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.stop.notify_waiters();
    }
    pub async fn pause(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.gate.clone().lock_owned().await
    }
    pub fn state(&self) -> Value {
        read(&self.root.join("metadata-refresh-state.json"))
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or(json!({"status":"idle"}))
    }
    async fn fetch(
        &self,
        url: &str,
        etag: Option<&str>,
    ) -> Result<Option<(Value, Option<String>)>> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(12))
            .build()
            .map_err(|_| "元数据客户端不可用")?;
        let mut request = client.get(url).header("accept", "application/json");
        if let Some(etag) = etag.filter(|s| s.len() <= 512) {
            request = request.header("if-none-match", etag);
        }
        let response = request.send().await.map_err(|_| "元数据网络读取失败")?;
        if response.status() == 304 {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!("元数据 HTTP {}", response.status().as_u16()));
        }
        let etag = response
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .filter(|s| s.len() <= 512)
            .map(str::to_owned);
        let mut bytes = vec![];
        let mut stream = response.bytes_stream();
        while let Some(part) = stream.next().await {
            let part = part.map_err(|_| "元数据读取中断")?;
            if bytes.len() + part.len() > 32 * 1024 * 1024 {
                return Err("元数据超过 32 MB".into());
            }
            bytes.extend_from_slice(&part);
        }
        let value = serde_json::from_slice(&bytes).map_err(|_| "元数据 JSON 无效")?;
        Ok(Some((value, etag)))
    }
    pub async fn refresh(&self, shared: Shared, event: Value) -> Result<Value> {
        let _gate = self.gate.lock().await;
        self.refresh_locked(shared, event).await
    }
    pub async fn repair(&self, shared: Shared) -> Result<Value> {
        // Refresh takes this gate before Pilot. Drain an earlier writer and
        // keep the same order while clearing and rebuilding its snapshots.
        let _gate = self.gate.lock().await;
        let mut result = shared.lock().await.repair_local_caches()?;
        if self.endpoints.is_none() {
            result["metadataRefresh"] =
                json!({"status":"skipped","reason":"隔离验证未启用元数据网络服务"});
        } else {
            match self
                .refresh_locked(
                    shared,
                    json!({"topics":["models","capabilities","pricing"],"reason":"repair"}),
                )
                .await
            {
                Ok(state) => {
                    result["metadataRefresh"] = state;
                }
                Err(error) => {
                    result["metadataRefresh"] = json!({"status":"error","errors":[error]});
                }
            }
        }
        Ok(result)
    }
    async fn refresh_locked(&self, shared: Shared, event: Value) -> Result<Value> {
        let endpoints = self
            .endpoints
            .as_ref()
            .ok_or("当前隔离验证未启用元数据网络服务")?;
        let topics = topics(&event["topics"]);
        if topics.is_empty() {
            return Err("元数据刷新类别无效".into());
        }
        let capabilities = topics
            .iter()
            .any(|s| ["models", "capabilities"].contains(&s.as_str()));
        let prices = topics.iter().any(|s| s == "pricing");
        let path = self.root.join("model-capabilities-cache.json");
        let before = read(&path)?.unwrap_or_default();
        let mut cache = serde_json::from_str::<Value>(&before)
            .ok()
            .filter(|v| v["version"] == 1)
            .unwrap_or(json!({"version":1,"modelsDev":[]}));
        if let Some(cache) = cache.as_object_mut() {
            // Protocol guesses from the retired LiteLLM source must not survive
            // a refresh, even when the rest of the capability cache is reused.
            cache.remove("litellm");
        }
        let pricing_path = self.root.join("pricing-cache/models-dev-pricing.json");
        let pricing_before = read(&pricing_path)?.unwrap_or_default();
        let previous_price = serde_json::from_str::<Value>(&pricing_before)
            .ok()
            .filter(|v| v["version"] == 2 && v["referenceCatalogVersion"] == 1)
            .unwrap_or(Value::Null);
        // Capability refresh must retry the source even when a prior memory
        // snapshot exists. A failed refresh retains the last good rows.
        let models = self
            .fetch(
                &endpoints.models,
                if prices && !capabilities {
                    previous_price["etag"].as_str()
                } else {
                    None
                },
            )
            .await;
        let mut errors = vec![];
        let mut changed = false;
        match models {
            Ok(Some((value, etag))) => {
                if capabilities {
                    let rows = model_metadata::parse_models(&value);
                    if rows.is_empty() {
                        errors.push("models.dev 未提供有效能力".to_string());
                    } else {
                        cache["modelsDev"] = json!(rows);
                        changed = true;
                    }
                }
                if prices {
                    let fresh = model_metadata::pricing(&value);
                    if fresh.is_empty() {
                        errors.push("models.dev 未提供有效价格".to_string());
                    } else {
                        let rules = model_metadata::merge_prices(&[], fresh);
                        fs::create_dir_all(pricing_path.parent().unwrap()).map_err(err)?;
                        write_checked(&pricing_path,&pricing_before,&json!({"version":2,"referenceCatalogVersion":1,"sourceUrl":endpoints.models,"fetchedAt":chrono::Utc::now().to_rfc3339(),"etag":etag,"rules":rules}).to_string())?;
                    }
                }
            }
            Ok(None) => {}
            Err(error) => errors.push(error),
        }
        if changed {
            cache["savedAt"] = json!(chrono::Utc::now().to_rfc3339());
            let mut pilot = shared.lock().await;
            write_checked(&path, &before, &cache.to_string())?;
            pilot.catalog_generation = pilot.catalog_generation.wrapping_add(1);
        }
        let mut refreshed_models = 0;
        if capabilities {
            // Publish fresh facts on the last known directory before attempting
            // enumeration. A provider outage must not freeze unrelated sources.
            for network in [false, true] {
                let jobs = shared.lock().await.background_catalog_jobs(network)?;
                for job in jobs {
                    if self.stopped.load(Ordering::SeqCst) {
                        return Err("元数据刷新已停止".into());
                    }
                    match job.execute().await {
                        Ok(entries) => {
                            let count = entries.as_array().map_or(0, Vec::len);
                            if let Err(error) = shared.lock().await.finish_catalog(&job, entries) {
                                errors.push(error);
                            } else {
                                refreshed_models += count;
                            }
                        }
                        Err(error) => errors.push(error),
                    }
                }
            }
        }
        {
            let shared = shared.lock().await;
            let mut store = shared.store.lock().unwrap();
            store.prices = storage::load_prices(&self.root);
            store.refresh_legacy_costs();
        }
        let result = json!({"status":if errors.is_empty(){"ready"}else{"partial"},"atMs":millis(),"revision":event["revision"],"reason":event["reason"],"topics":topics,"errors":errors,"refreshedModels":refreshed_models,"modelsDevCount":cache["modelsDev"].as_array().map(Vec::len).unwrap_or(0)});
        write(
            &self.root.join("metadata-refresh-state.json"),
            &result.to_string(),
        )?;
        Ok(result)
    }
    async fn connection(
        &self,
        endpoints: &Endpoints,
        sender: &tokio::sync::mpsc::Sender<Value>,
        last_id: &mut String,
    ) -> Result<()> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| "元数据推送客户端不可用")?;
        let mut request = client
            .get(&endpoints.events)
            .header("accept", "text/event-stream");
        if !last_id.is_empty() {
            request = request.header("last-event-id", last_id.as_str());
        }
        let response = request.send().await.map_err(|_| "元数据推送未连接")?;
        if !response.status().is_success() {
            return Err("元数据推送 HTTP 失败".into());
        }
        if !response
            .headers()
            .get("content-type")
            .and_then(|s| s.to_str().ok())
            .is_some_and(|s| s.starts_with("text/event-stream"))
        {
            return Err("元数据推送类型无效".into());
        }
        let mut stream = response.bytes_stream();
        let mut buffer = vec![];
        while let Some(part) = stream.next().await {
            let part = part.map_err(|_| "元数据推送中断")?;
            if buffer.len() + part.len() > 512 * 1024 {
                return Err("元数据事件超过上限".into());
            }
            buffer.extend_from_slice(&part);
            while let Some(boundary) = [
                buffer.windows(2).position(|w| w == b"\n\n").map(|i| (i, 2)),
                buffer
                    .windows(4)
                    .position(|w| w == b"\r\n\r\n")
                    .map(|i| (i, 4)),
            ]
            .into_iter()
            .flatten()
            .min_by_key(|b| b.0)
            {
                let bytes: Vec<_> = buffer.drain(..boundary.0 + boundary.1).collect();
                let Ok(block) = std::str::from_utf8(&bytes) else {
                    continue;
                };
                let (event, id) = parse_event(block);
                if let Some(id) = id {
                    *last_id = id;
                    write(
                        &self.root.join("metadata-stream-state.json"),
                        &json!({"version":1,"lastEventId":last_id}).to_string(),
                    )?;
                }
                if let Some(event) = event {
                    sender.send(event).await.map_err(|_| "元数据订阅已停止")?;
                }
            }
        }
        Ok(())
    }
    pub fn start(&self, shared: Shared, publish: Arc<dyn Fn(Value) + Send + Sync>) {
        let Some(endpoints) = self.endpoints.clone() else {
            return;
        };
        let engine = self.clone();
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Value>(16);
        // Fresh installations and real isolated acceptance need owner protocol
        // metadata immediately, without waiting for a push or the six-hour timer.
        if test_argument("--metadata-test-endpoint").is_none() {
            let _ = tx
                .try_send(json!({"topics":["models","capabilities","pricing"],"reason":"startup"}));
        }
        let consumer = self.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                if consumer.stopped.load(Ordering::SeqCst) {
                    break;
                }
                let refresh = consumer.refresh(shared.clone(), event);
                tokio::select! {_=consumer.stop.notified()=>break,result=refresh=>{if result.is_ok(){publish(shared.lock().await.state());}}}
            }
        });
        tauri::async_runtime::spawn(async move {
            if endpoints.events.is_empty() {
                let mut polling = tokio::time::interval(endpoints.fallback);
                polling.tick().await;
                loop {
                    tokio::select! {
                        _ = engine.stop.notified() => return,
                        _ = polling.tick() => {
                            if engine.stopped.load(Ordering::SeqCst) { return; }
                            let _ = tx.send(json!({"topics":["models","capabilities","pricing"],"reason":"periodic"})).await;
                        }
                    }
                }
            }
            let mut last_id = read(&engine.root.join("metadata-stream-state.json"))
                .ok()
                .flatten()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .map(|v| text(&v, "lastEventId").to_owned())
                .filter(|s| s.len() <= 256)
                .unwrap_or_default();
            let mut fallback = tokio::time::interval(endpoints.fallback);
            fallback.tick().await;
            loop {
                if engine.stopped.load(Ordering::SeqCst) {
                    break;
                }
                let connection = engine.connection(&endpoints, &tx, &mut last_id);
                tokio::pin!(connection);
                loop {
                    tokio::select! {_=engine.stop.notified()=>return,_=fallback.tick()=>{let _=tx.send(json!({"topics":["models","capabilities","pricing"],"reason":"fallback"})).await;},_= &mut connection=>break}
                }
                let delay = tokio::time::sleep(endpoints.reconnect);
                tokio::pin!(delay);
                loop {
                    tokio::select! {_=engine.stop.notified()=>return,_=fallback.tick()=>{let _=tx.send(json!({"topics":["models","capabilities","pricing"],"reason":"fallback"})).await;},_=&mut delay=>break}
                }
            }
        });
    }
}
fn topics(v: &Value) -> Vec<String> {
    let mut out = vec![];
    for s in v
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|s| ["models", "capabilities", "pricing"].contains(s))
    {
        if !out.iter().any(|v| v == s) {
            out.push(s.to_owned());
        }
    }
    out
}
fn parse_event(block: &str) -> (Option<Value>, Option<String>) {
    let mut kind = "message";
    let mut id = None;
    let mut data = vec![];
    for line in block.lines() {
        let Some((field, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => kind = value,
            "id" if value.len() <= 256 && !value.contains('\0') => id = Some(value.to_owned()),
            "data" => data.push(value),
            _ => {}
        }
    }
    let event = if kind == "metadata" {
        serde_json::from_str::<Value>(&data.join("\n")).ok().filter(|v|!topics(&v["topics"]).is_empty()).map(|v|json!({"topics":topics(&v["topics"]),"revision":v["revision"].as_u64(),"reason":"push"}))
    } else {
        None
    };
    (event, id)
}
impl Pilot {
    pub fn metadata_context(&self) -> Metadata {
        self.metadata.clone()
    }
    pub fn background_catalog_jobs(&self, network: bool) -> Result<Vec<catalog::CatalogJob>> {
        let mut jobs = vec![];
        let mut seen = vec![];
        for client in crate::edition::config::PROVIDER_CLIENTS {
            if let Some(id) = self.settings.selected[client].as_str() {
                if !seen.contains(&id) {
                    seen.push(id);
                    if !network {
                        let provider = self.settings.connections.iter().find(|p| p.id == id);
                        let Some(provider) = provider else { continue };
                        if !provider.subscription_account_id.is_empty()
                            || !self.local_catalog(provider).is_ok_and(|value| {
                                value.as_array().is_some_and(|rows| !rows.is_empty())
                            })
                        {
                            continue;
                        }
                    }
                    if let Some(job) = self.catalog_job(
                        "fetchProviderModels",
                        &[json!({"providerId":id,"refresh":network})],
                    )? {
                        jobs.push(job);
                    }
                }
            }
        }
        Ok(jobs)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn production_metadata_uses_public_sources_without_push_subscription() {
        let metadata = Metadata::new(PathBuf::from("/metadata-boundary-fixture"), false).unwrap();
        let endpoints = metadata.endpoints.unwrap();
        assert_eq!(endpoints.events, crate::edition::config::metadata_events());
        assert_eq!(endpoints.models, "https://models.dev/api.json");
        assert_eq!(endpoints.fallback, Duration::from_secs(6 * 60 * 60));
    }
    #[test]
    fn sse_topics_ids_and_untrusted_payloads() {
        let (event,id)=parse_event("event: metadata\r\nid: revision-42\r\ndata: {\"revision\":42,\"topics\":[\"models\",\"models\",\"pricing\",\"unknown\"]}\r\n");
        assert_eq!(id.as_deref(), Some("revision-42"));
        assert_eq!(event.unwrap()["topics"], json!(["models", "pricing"]));
        assert!(parse_event("event: metadata\ndata: invalid").0.is_none());
        assert!(
            parse_event("event: message\ndata: {\"topics\":[\"models\"]}")
                .0
                .is_none()
        );
    }
}
