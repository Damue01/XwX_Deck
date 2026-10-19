//! A credential command, independent of Trace and inference transport.
//! The live host serializes refresh through its existing account owners. When
//! Deck is closed, a one-shot command takes the same root lease and only opens
//! account storage; it never recovers routes, starts Gateway, or reads history.
use super::*;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

const SESSION: &str = "native-auth-session.json";
pub(super) const LEASE: &str = "native-auth-lease";
pub(super) fn lease_pending(root: &Path) -> Result<bool> {
    match fs::symlink_metadata(root.join(LEASE)) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("认证目录锁标记不能经过符号链接".into())
        }
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err("认证目录锁标记不是普通文件".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(err(error)),
    }
}

pub(super) fn acquire_root_lock(root: &Path, lock: &fs::File) -> Result<()> {
    let deadline = std::time::Instant::now() + Duration::from_secs(40);
    let settling = std::time::Instant::now() + Duration::from_millis(100);
    let mut auth_seen = false;
    loop {
        if lock.try_lock().is_ok() {
            return Ok(());
        }
        // Several credential commands can hand the lease to one another.
        // Once observed, absence of the short-lived marker is not proof that
        // another application owns the lock. Keep the original bounded wait.
        auth_seen |= lease_pending(root)?;
        if std::time::Instant::now() >= deadline
            || (!auth_seen && std::time::Instant::now() >= settling)
        {
            return Err("试验目录已被另一个运行中的进程占用".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
const BINDING: &str = "nativeAuthBinding";
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Binding {
    connection_id: String,
    account_id: String,
    base_url: String,
    headers: std::collections::BTreeMap<String, String>,
}
impl Binding {
    fn from_provider(provider: &Provider) -> Result<Self> {
        serde_json::from_value(
            provider
                .other
                .get(BINDING)
                .cloned()
                .ok_or("请重新选择订阅连接以启用原生认证")?,
        )
        .map_err(|_| "原生认证绑定无效".into())
    }
}
fn eligible(id: &str) -> bool {
    !id.is_empty() && !id.starts_with("cursor-") && !id.starts_with("claude-subscription-")
}
async fn descriptor(accounts: &subscriptions::Accounts, provider: &Provider) -> Result<Binding> {
    let id = &provider.subscription_account_id;
    if !eligible(id) {
        return Err("此订阅连接没有可用的客户端原生认证接口".into());
    }
    let base = accounts.endpoint_for(id).await?;
    Ok(Binding {
        connection_id: provider.id.clone(),
        account_id: id.clone(),
        base_url: if official_accounts::is_official(id) {
            format!("{}/codex", base.trim_end_matches('/'))
        } else {
            base
        },
        headers: accounts
            .headers(id)
            .await?
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
    })
}
pub(super) fn available(provider: &Provider) -> bool {
    eligible(&provider.subscription_account_id)
        && Binding::from_provider(provider).is_ok_and(|b| {
            b.connection_id == provider.id && b.account_id == provider.subscription_account_id
        })
}
pub(super) fn clear(provider: &mut Provider) {
    provider.other.remove(BINDING);
}
pub(super) fn owns_auth(document: &DocumentMut, id: &str) -> bool {
    provider_field(document, id, "auth")
        .and_then(|a| a.get("args"))
        .and_then(Item::as_array)
        .is_some_and(|args| {
            args.get(0).and_then(toml_edit::Value::as_str) == Some("--native-auth-token")
        })
        || provider_field(document, id, "auth")
            .and_then(Item::as_inline_table)
            .and_then(|a| a.get("args"))
            .and_then(toml_edit::Value::as_array)
            .is_some_and(|args| {
                args.get(0).and_then(toml_edit::Value::as_str) == Some("--native-auth-token")
            })
}
pub(super) async fn prepare(
    accounts: &subscriptions::Accounts,
    provider: &mut Provider,
) -> Result<()> {
    if eligible(&provider.subscription_account_id) {
        provider
            .other
            .insert(BINDING.into(), json!(descriptor(accounts, provider).await?));
    }
    Ok(())
}
pub(super) fn configure(
    document: &mut DocumentMut,
    id: &str,
    root: &Path,
    isolated: bool,
    provider: &Provider,
) -> Result<()> {
    let binding = Binding::from_provider(provider)?;
    set_codex_provider_field(document, id, "base_url", value(&binding.base_url));
    let mut headers = toml_edit::InlineTable::new();
    for (key, val) in &binding.headers {
        headers.insert(key, val.as_str().into());
    }
    set_codex_provider_field(document, id, "http_headers", value(headers));
    let mut args = toml_edit::Array::new();
    for arg in [
        "--native-auth-token".to_owned(),
        serde_json::to_string(&binding).map_err(err)?,
        if isolated {
            "--pilot-root"
        } else {
            "--data-root"
        }
        .into(),
        root.to_string_lossy().into(),
    ] {
        args.push(arg);
    }
    if isolated {
        args.push("--rpc");
        // Test endpoints and fake official CLIs never escape the isolated root.
        let source: Vec<_> = std::env::args().collect();
        for flag in [
            "--subscription-test-endpoint",
            "--official-chatgpt-test-cli",
            "--subscription-test-grok-cli",
        ] {
            if let Some(next) = source
                .iter()
                .position(|a| a == flag)
                .and_then(|i| source.get(i + 1))
            {
                args.push(flag);
                args.push(next.as_str());
            }
        }
    }
    let mut auth = toml_edit::InlineTable::new();
    auth.insert(
        "command",
        std::env::current_exe()
            .map_err(err)?
            .to_string_lossy()
            .as_ref()
            .into(),
    );
    auth.insert("args", args.into());
    // A closed-host command may first wait for the root lease (40 s), then
    // finish the existing bounded account refresh (25 s).
    auth.insert("timeout_ms", 75000.into());
    auth.insert("refresh_interval_ms", 30000.into());
    let table = document
        .get_mut("model_providers")
        .and_then(|p| p.get_mut(id))
        .and_then(Item::as_table_like_mut)
        .ok_or("客户端模型服务表缺失")?;
    for key in [
        "env_key",
        "env_key_instructions",
        "experimental_bearer_token",
        "requires_openai_auth",
        "env_http_headers",
    ] {
        table.remove(key);
    }
    table.insert("auth", value(auth));
    Ok(())
}
fn validate(root: &Path, binding: &Binding) -> Result<Provider> {
    let source = read(&root.join("settings.json"))?.ok_or("订阅配置不存在")?;
    let settings: Settings =
        serde_json::from_str(&source).map_err(|_| "订阅配置损坏，原文件已保留")?;
    let provider = settings
        .connections
        .into_iter()
        .find(|p| p.id == binding.connection_id)
        .ok_or("订阅连接已移除，请重新选择服务")?;
    if Binding::from_provider(&provider)? != *binding
        || provider.subscription_account_id != binding.account_id
    {
        return Err("订阅连接已变化，请重新加载客户端；不会改用其他账号".into());
    }
    Ok(provider)
}
async fn token(
    root: &Path,
    accounts: &subscriptions::Accounts,
    binding: &Binding,
) -> Result<String> {
    let provider = validate(root, binding)?;
    if descriptor(accounts, &provider).await? != *binding {
        return Err("订阅地址或身份已变化，请重新选择服务；不会发送其他账号的凭据".into());
    }
    let token = accounts.credential(&binding.account_id).await?;
    let bound_headers: std::collections::BTreeMap<_, _> = accounts
        .bound_headers(&binding.account_id, &token)
        .await?
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value))
        .collect();
    // A refresh may rotate both the token and the service endpoint. Cached
    // native client routing must never receive a token for a different tuple.
    if bound_headers != binding.headers
        || descriptor(accounts, &validate(root, binding)?).await? != *binding
    {
        return Err("续期后订阅地址已变化，请重新选择服务".into());
    }
    if token.is_empty()
        || token.len() > 16384
        || token
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
    {
        return Err("订阅没有返回可用的访问令牌".into());
    }
    Ok(token)
}
trait Channel: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Channel for T {}
type Stream = Box<dyn Channel>;
#[derive(Serialize, Deserialize)]
struct Session {
    endpoint: String,
    secret: String,
}
fn random() -> Result<String> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(err)?;
    Ok(b.iter().map(|v| format!("{v:02x}")).collect())
}
pub struct Service {
    task: tokio::task::JoinHandle<()>,
    root: PathBuf,
    secret: String,
    #[cfg(unix)]
    socket: PathBuf,
}
impl Drop for Service {
    fn drop(&mut self) {
        self.task.abort();
        if read(&self.root.join(SESSION))
            .ok()
            .flatten()
            .and_then(|s| serde_json::from_str::<Session>(&s).ok())
            .is_some_and(|s| s.secret == self.secret)
        {
            let _ = fs::remove_file(self.root.join(SESSION));
        }
        #[cfg(unix)]
        {
            let _ = fs::remove_file(&self.socket);
            if let Some(parent) = self.socket.parent() {
                let _ = fs::remove_dir(parent);
            }
        }
    }
}
async fn exchange(
    mut stream: Stream,
    root: PathBuf,
    accounts: subscriptions::Accounts,
    secret: String,
) {
    let operation = async {
        let mut line = String::new();
        tokio::time::timeout(
            Duration::from_secs(5),
            BufReader::new((&mut stream).take(32769)).read_line(&mut line),
        )
        .await
        .map_err(|_| "认证请求超时")?
        .map_err(err)?;
        if line.len() > 32768 {
            return Err("认证请求过大".into());
        }
        let input: Value = serde_json::from_str(&line).map_err(|_| "认证请求无效")?;
        let proof = text(&input, "secret").as_bytes();
        let expected = secret.as_bytes();
        if proof.len() != expected.len()
            || proof
                .iter()
                .zip(expected)
                .fold(0u8, |diff, (a, b)| diff | (a ^ b))
                != 0
        {
            return Err("认证请求未授权".into());
        }
        let binding: Binding =
            serde_json::from_value(input["binding"].clone()).map_err(|_| "原生认证绑定无效")?;
        token(&root, &accounts, &binding).await
    };
    // The caller can time out or disconnect. Let the account owner finish and
    // persist a rotated refresh token before releasing its lock.
    let result = operation.await;
    let reply = match result {
        Ok(token) => json!({"token":token}),
        Err(error) => json!({"error":error}),
    };
    let _ = stream
        .write_all((reply.to_string() + "\n").as_bytes())
        .await;
    let _ = stream.shutdown().await;
}
pub async fn start(shared: Shared) -> Result<Service> {
    let (root, accounts) = {
        let p = shared.lock().await;
        (p.root.clone(), p.subscriptions.clone())
    };
    let secret = random()?;
    #[cfg(windows)]
    let endpoint = format!(r"\\.\pipe\xwx-deck-auth-{}", random()?);
    #[cfg(windows)]
    let listener = tokio::net::windows::named_pipe::ServerOptions::new()
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .create(&endpoint)
        .map_err(err)?;
    #[cfg(unix)]
    let socket = {
        // macOS's per-user temporary path can exceed the Unix socket limit.
        let directory = PathBuf::from("/tmp").join(format!("xwx-auth-{}", &random()?[..24]));
        fs::create_dir(&directory).map_err(err)?;
        credentials::private_permissions(&directory, true)?;
        directory.join("auth.sock")
    };
    #[cfg(unix)]
    let endpoint = socket.to_string_lossy().to_string();
    #[cfg(unix)]
    let listener = {
        use std::os::unix::fs::PermissionsExt;
        let l = tokio::net::UnixListener::bind(&socket).map_err(err)?;
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).map_err(err)?;
        l
    };
    write(
        &root.join(SESSION),
        &serde_json::to_string(&Session {
            endpoint: endpoint.clone(),
            secret: secret.clone(),
        })
        .map_err(err)?,
    )?;
    credentials::private_permissions(&root.join(SESSION), false)?;
    let task_root = root.clone();
    let task_secret = secret.clone();
    let task = tokio::spawn(async move {
        #[cfg(windows)]
        {
            let mut listener = listener;
            loop {
                if listener.connect().await.is_err() {
                    break;
                }
                let next = match tokio::net::windows::named_pipe::ServerOptions::new()
                    .reject_remote_clients(true)
                    .create(&endpoint)
                {
                    Ok(p) => p,
                    Err(_) => break,
                };
                let stream = std::mem::replace(&mut listener, next);
                tokio::spawn(exchange(
                    Box::new(stream),
                    task_root.clone(),
                    accounts.clone(),
                    task_secret.clone(),
                ));
            }
        }
        #[cfg(unix)]
        {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(exchange(
                    Box::new(stream),
                    task_root.clone(),
                    accounts.clone(),
                    task_secret.clone(),
                ));
            }
        }
    });
    Ok(Service {
        task,
        root,
        secret,
        #[cfg(unix)]
        socket,
    })
}
async fn connect(session: &Session) -> Result<Stream> {
    #[cfg(windows)]
    {
        if !session.endpoint.starts_with(r"\\.\pipe\xwx-deck-auth-") {
            return Err("原生认证入口无效".into());
        }
        for _ in 0..50 {
            match tokio::net::windows::named_pipe::ClientOptions::new().open(&session.endpoint) {
                Ok(p) => return Ok(Box::new(p)),
                Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        }
        Err("原生认证入口暂不可用".into())
    }
    #[cfg(unix)]
    {
        Ok(Box::new(
            tokio::net::UnixStream::connect(&session.endpoint)
                .await
                .map_err(err)?,
        ))
    }
}
async fn live_token(root: &Path, binding: &Binding) -> Result<Option<String>> {
    let session = read(&root.join(SESSION))?.and_then(|s| serde_json::from_str::<Session>(&s).ok());
    Ok(if let Some(session) = session {
        match connect(&session).await {
            Ok(mut stream) => {
                stream
                    .write_all(
                        (json!({"secret":session.secret,"binding":binding}).to_string() + "\n")
                            .as_bytes(),
                    )
                    .await
                    .map_err(err)?;
                let mut line = String::new();
                tokio::time::timeout(
                    Duration::from_secs(41),
                    BufReader::new(stream.take(32769)).read_line(&mut line),
                )
                .await
                .map_err(|_| "订阅续期超时，请重试")?
                .map_err(err)?;
                if line.len() > 32768 {
                    return Err("原生认证响应过大".into());
                }
                let reply: Value = serde_json::from_str(&line).map_err(|_| "原生认证响应无效")?;
                if let Some(error) = reply["error"].as_str() {
                    return Err(error.into());
                }
                Some(text(&reply, "token").to_owned())
            }
            Err(_) => None,
        }
    } else {
        None
    })
}
struct Lease {
    _file: fs::File,
    marker: PathBuf,
    proof: String,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if read(&self.marker).ok().flatten().as_deref() == Some(&self.proof) {
            let _ = fs::remove_file(&self.marker);
        }
    }
}
pub async fn print_token(root: PathBuf, raw: &str, isolated: bool) -> Result<()> {
    if !root.is_absolute()
        || !same_physical_path(&root)?
        || read(&root.join(".xwx-rust-pilot"))?.as_deref() != Some("isolated-rust-pilot-v1\n")
    {
        return Err("原生认证需要已有的 Deck 数据目录".into());
    }
    if pending_reset(&root)?.is_some() {
        return Err("数据重置尚未完成，请先打开 Deck".into());
    }
    let binding: Binding = serde_json::from_str(raw).map_err(|_| "原生认证绑定无效")?;
    let lease = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join("pilot.lock"))
        .map_err(err)?;
    let deadline = std::time::Instant::now() + Duration::from_secs(40);
    let token = loop {
        if let Some(token) = live_token(&root, &binding).await? {
            break token;
        }
        // A starting UI may win the lease. Retry its live entry rather than
        // opening another credential owner or failing a concurrent command.
        if lease.try_lock().is_err() {
            if std::time::Instant::now() >= deadline {
                return Err("Deck 的认证入口暂不可用，请重新打开 Deck 后重试".into());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
            continue;
        }
        let marker = root.join(LEASE);
        let proof = random()?;
        write(&marker, &proof)?;
        let _lease = Lease {
            _file: lease,
            marker,
            proof,
        };
        if pending_reset(&root)?.is_some() {
            return Err("数据重置尚未完成，请先打开 Deck".into());
        }
        credentials::register(&root, isolated)?;
        let accounts = subscriptions::Accounts::open(&root, isolated)?;
        break token(&root, &accounts, &binding).await?;
    };
    if token.is_empty()
        || token
            .bytes()
            .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
    {
        return Err("订阅没有返回可用访问令牌".into());
    }
    // This is the documented client command contract, never a log/RPC result.
    use std::io::Write;
    std::io::stdout()
        .write_all((token + "\n").as_bytes())
        .map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, fs::File, fs::File) {
        let root = std::env::temp_dir().join(format!(
            "xwx-auth-lock-{}-{}",
            std::process::id(),
            random().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let open = || {
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(root.join("pilot.lock"))
                .unwrap()
        };
        let owner = open();
        let waiting = open();
        owner.lock().unwrap();
        (root, owner, waiting)
    }

    #[test]
    fn startup_waits_through_credential_lease_handoff() {
        let (root, owner, waiting) = fixture();
        fs::write(root.join(LEASE), "first-helper").unwrap();
        let cleanup_root = root.clone();
        let handoff = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            fs::remove_file(cleanup_root.join(LEASE)).unwrap();
            // The old startup check rejects this observed handoff after 100 ms.
            std::thread::sleep(Duration::from_millis(150));
            drop(owner);
        });
        acquire_root_lock(&root, &waiting).unwrap();
        handoff.join().unwrap();
        drop(waiting);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_running_application_without_a_credential_lease_still_blocks_startup() {
        let (root, owner, waiting) = fixture();
        assert!(acquire_root_lock(&root, &waiting).is_err());
        assert!(waiting.try_lock().is_err());
        drop(owner);
        acquire_root_lock(&root, &waiting).unwrap();
        drop(waiting);
        fs::remove_dir_all(root).unwrap();
    }
}
