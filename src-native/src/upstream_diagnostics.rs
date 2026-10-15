//! Failure-only, bounded diagnostics. Never persist request/response bodies or headers.
use super::*;
use std::{error::Error, io::Write};

const MAX_BYTES: u64 = 1024 * 1024;
#[derive(Clone)]
pub(super) struct Log(Arc<std::sync::Mutex<PathBuf>>);

// Error chains can contain URLs with credentials. Keep only the origin, and
// redact credentials used on this request before retaining the underlying cause.
fn origin(endpoint: &str) -> String {
    reqwest::Url::parse(endpoint)
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_else(|_| "[invalid-url]".into())
}
fn redact(message: &str, secrets: &[&str]) -> String {
    let mut safe = message.to_owned();
    for secret in secrets.iter().filter(|s| !s.is_empty()) {
        safe = safe.replace(secret, "[redacted]");
    }
    let urls = regex::Regex::new(r#"https?://[^\s<>\"')]+"#).unwrap();
    safe = urls
        .replace_all(&safe, |captures: &regex::Captures<'_>| origin(&captures[0]))
        .into_owned();
    let credentials =
        regex::Regex::new(r"(?i)(bearer\s+|(?:api[_-]?key|token|password|secret)=)[^\s,;&]+")
            .unwrap();
    safe = credentials.replace_all(&safe, "$1[redacted]").into_owned();
    safe.chars().take(1024).collect()
}
pub(super) fn user_message(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "Timed out waiting for the upstream service. Please try again."
    } else if error.is_builder() {
        "Could not prepare the upstream request. Please check the service configuration."
    } else {
        "Could not connect to the upstream service. Please try again."
    }
}
pub(super) fn response(incoming: &str, message: &str) -> Response {
    let error = if incoming == "anthropic-messages" {
        json!({"type":"error","error":{"type":"api_error","message":message}})
    } else {
        json!({"error":{"type":"upstream_connection_error","message":message}})
    };
    Response::builder()
        .status(502)
        .header("content-type", "application/json")
        .body(Body::from(error.to_string()))
        .unwrap()
}
impl Log {
    pub(super) fn new(root: PathBuf) -> Self {
        Self(Arc::new(std::sync::Mutex::new(root)))
    }
    fn metadata(
        endpoint: &str,
        provider: &Provider,
        wire: &str,
        started: u128,
        index: u64,
    ) -> Value {
        json!({"version":1,"at":storage::iso(millis()),"requestId":format!("trace-{started}-{index}"),
            "upstreamOrigin":origin(endpoint),"protocol":wire,
            "connectionHash":storage::digest(provider.id.as_bytes()),"official":provider.official,"oauth":provider.oauth,
            "elapsedMs":millis().saturating_sub(started),"connectTimeoutMs":3000,"readTimeoutMs":90000})
    }
    #[allow(clippy::too_many_arguments)]
    pub(super) fn transport(
        &self,
        error: &reqwest::Error,
        endpoint: &str,
        provider: &Provider,
        wire: &str,
        started: u128,
        index: u64,
        headers: &axum::http::HeaderMap,
    ) {
        let mut secrets = vec![provider.bearer_token.as_str()];
        for name in [
            "authorization",
            "x-api-key",
            "x-goog-api-key",
            "proxy-authorization",
            "cookie",
            "chatgpt-account-id",
        ] {
            if let Some(value) = headers.get(name).and_then(|v| v.to_str().ok()) {
                secrets.push(value);
                if let Some(token) = value.strip_prefix("Bearer ") {
                    secrets.push(token);
                }
            }
        }
        let mut record = Self::metadata(endpoint, provider, wire, started, index);
        record["event"] = json!("upstream_transport_error");
        record["httpResponseReceived"] = json!(false);
        record["timeout"] = json!(error.is_timeout());
        record["connect"] = json!(error.is_connect());
        record["requestBuild"] = json!(error.is_builder());
        let mut chain = vec![redact(&error.to_string(), &secrets)];
        let mut cause = error.source();
        for _ in 0..8 {
            let Some(current) = cause else {
                break;
            };
            chain.push(redact(&current.to_string(), &secrets));
            cause = current.source();
        }
        record["errorChain"] = json!(chain);
        self.enqueue(record);
    }
    pub(super) fn http_status(
        &self,
        response: &reqwest::Response,
        endpoint: &str,
        provider: &Provider,
        wire: &str,
        started: u128,
        index: u64,
    ) {
        let mut record = Self::metadata(endpoint, provider, wire, started, index);
        record["event"] = json!("upstream_http_error");
        record["httpResponseReceived"] = json!(true);
        record["status"] = json!(response.status().as_u16());
        for name in ["x-request-id", "x-oai-request-id", "cf-ray"] {
            if let Some(value) = response
                .headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .filter(|v| {
                    v.len() <= 128
                        && v.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b))
                })
            {
                record[name] = json!(value);
            }
        }
        self.enqueue(record);
    }
    fn enqueue(&self, record: Value) {
        let log = self.clone();
        // Disk work never holds the main state lock or delays the HTTP response.
        tokio::task::spawn_blocking(move || {
            if log.append(&record).is_err() {
                eprintln!("Upstream diagnostic could not be saved.");
            }
        });
    }
    fn append(&self, record: &Value) -> Result<()> {
        let root = self.0.lock().map_err(err)?;
        fs::create_dir_all(&*root).map_err(err)?;
        if !same_physical_path(&root)? {
            return Err("Diagnostic directory is not a physical path".into());
        }
        credentials::private_permissions(&root, true)?;
        let path = root.join("upstream-errors.jsonl");
        let previous = root.join("upstream-errors.previous.jsonl");
        for candidate in [&path, &previous] {
            match fs::symlink_metadata(candidate) {
                Ok(m) if !m.is_file() || m.file_type().is_symlink() => {
                    return Err("Diagnostic path is not a regular file".into())
                }
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(err(e)),
                _ => {}
            }
        }
        let mut line = serde_json::to_vec(record).map_err(err)?;
        line.push(b'\n');
        if fs::metadata(&path).is_ok_and(|m| m.len() + line.len() as u64 > MAX_BYTES) {
            if previous.exists() {
                fs::remove_file(&previous).map_err(err)?;
            }
            fs::rename(&path, &previous).map_err(err)?;
            credentials::private_permissions(&previous, false)?;
        }
        let mut options = fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).map_err(err)?;
        credentials::private_permissions(&path, false)?;
        file.write_all(&line).map_err(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn timeout_and_refused_connection_have_actionable_messages() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let endpoint = format!("http://{address}");
        let held = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(1)).await;
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(100))
            .build()
            .unwrap();
        let timeout = client.get(&endpoint).send().await.unwrap_err();
        assert!(timeout.is_timeout());
        assert!(user_message(&timeout).starts_with("Timed out"));
        held.abort();
        let _ = held.await;
        drop(tokio::net::TcpListener::bind(address).await.unwrap());
        // Windows can report refusal after the intentionally short response deadline.
        let refused_client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let refused = refused_client.get(&endpoint).send().await.unwrap_err();
        assert!(
            refused.is_connect(),
            "expected connection refusal: {refused:?}"
        );
        assert!(!refused.is_timeout());
        assert!(user_message(&refused).contains("Could not connect"));
        for api in ["responses", "anthropic-messages"] {
            let response = response(api, user_message(&refused));
            assert_eq!(response.status(), 502);
            let body = to_bytes(response.into_body(), 4096).await.unwrap();
            let value: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(value["error"]["message"], user_message(&refused));
            assert!(!String::from_utf8(body.to_vec()).unwrap().contains("Rust"));
        }
    }
    #[test]
    fn redacts_credentials_and_url_path_query_fragment_but_retains_cause() {
        let raw = "connection reset for https://user:password@api.example.test/private-key/responses?token=query-secret#secret Bearer bearer-secret token=another-secret";
        let safe = redact(raw, &["bearer-secret"]);
        assert!(safe.contains("connection reset"));
        assert!(safe.contains("https://api.example.test"));
        for secret in [
            "password",
            "private-key",
            "query-secret",
            "bearer-secret",
            "another-secret",
        ] {
            assert!(!safe.contains(secret));
        }
    }
    #[test]
    fn rotation_is_bounded_private_and_symlinks_are_not_followed() {
        let root =
            std::env::temp_dir().join(format!("upstream-log-{}-{}", std::process::id(), millis()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let log = Log::new(root.clone());
        let path = root.join("upstream-errors.jsonl");
        fs::write(&path, vec![b' '; MAX_BYTES as usize]).unwrap();
        log.append(&json!({"event":"new"})).unwrap();
        assert_eq!(
            fs::metadata(root.join("upstream-errors.previous.jsonl"))
                .unwrap()
                .len(),
            MAX_BYTES
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"event\":\"new\"}\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::{symlink, PermissionsExt};
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            let external = root.join("external");
            fs::write(&external, "preserve").unwrap();
            fs::remove_file(&path).unwrap();
            symlink(&external, &path).unwrap();
            assert!(log.append(&json!({"event":"next"})).is_err());
            assert_eq!(fs::read_to_string(external).unwrap(), "preserve");
        }
        fs::remove_dir_all(root).unwrap();
    }
}
