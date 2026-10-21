use super::*;
use futures_util::StreamExt;
#[path = "edition/update-source.rs"]
mod source;
use sha2::{Digest, Sha256};
#[derive(Clone)]
pub(crate) struct Updates {
    inner: Arc<std::sync::Mutex<Update>>,
    root: PathBuf,
}
struct Update {
    state: Value,
    artifact: Value,
    manifest: Value,
    generation: u64,
    installing: bool,
}
#[cfg(target_os = "macos")]
pub(crate) struct InstallLease(Updates);
#[cfg(target_os = "macos")]
impl Drop for InstallLease {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.0.inner.lock() {
            inner.installing = false;
        }
    }
}
fn version(s: &str) -> Option<Vec<u64>> {
    let s = s.strip_prefix('v').unwrap_or(s);
    let parts = s
        .split('.')
        .map(str::parse)
        .collect::<std::result::Result<Vec<u64>, _>>()
        .ok()?;
    if parts.len() != 3 {
        return None;
    }
    Some(parts)
}
fn validate_url(value: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(value).map_err(|_| "更新地址无效")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || !crate::edition::config::allow_update_url(&url)
    {
        return Err("更新地址不符合当前版本的来源规则".into());
    }
    Ok(url)
}
fn windows_installer(name: &str) -> bool {
    name == "XwX Deck Setup.exe" || name.ends_with("-setup.exe")
}
fn artifact_extension_matches(name: &str, platform: &str, portable: bool) -> bool {
    if platform == "windows" {
        if portable {
            name.ends_with(".exe") && !windows_installer(name)
        } else {
            windows_installer(name)
        }
    } else {
        name.ends_with(".dmg")
    }
}
impl Updates {
    pub fn new(root: PathBuf) -> Self {
        #[cfg(target_os = "windows")]
        let portable = !crate::windows_setup::is_registered();
        #[cfg(not(target_os = "windows"))]
        let portable = false;
        #[allow(unused_mut)]
        let mut state = json!({"status":"idle","currentVersion":env!("CARGO_PKG_VERSION"),"channel":"release","portable":portable,"installMode":if cfg!(target_os="macos"){"manual-dmg"}else{"automatic"},"supported":cfg!(any(target_os="macos",target_os="windows")),"updateAvailable":false});
        #[cfg(target_os = "windows")]
        let state = {
            let mut state = state;
            if let Some(error) = crate::windows_setup::previous_error(&root) {
                state["status"] = json!("error");
                state["error"] = json!(error);
            }
            state
        };
        #[cfg(target_os = "macos")]
        {
            if crate::edition::config::AUTOMATIC_MACOS_UPDATES && crate::macos_update::available() {
                state["installMode"] = json!("automatic");
                if let Some(version) = crate::macos_update::current_version() {
                    state["currentVersion"] = json!(version);
                }
            }
            if let Ok(bytes) = fs::read(root.join("updates/macos-install-result.json")) {
                if let Ok(result) = serde_json::from_slice::<Value>(&bytes) {
                    if result["status"] == "error" {
                        state["status"] = json!("error");
                        state["error"] = result["error"].clone();
                    }
                    state["lastInstall"] = result;
                }
            }
        }
        Self {
            root,
            inner: Arc::new(std::sync::Mutex::new(Update {
                state,
                artifact: Value::Null,
                manifest: Value::Null,
                generation: 0,
                installing: false,
            })),
        }
    }
    pub fn state(&self) -> Value {
        self.inner.lock().unwrap().state.clone()
    }
    #[cfg(target_os = "macos")]
    pub fn claim_install(&self) -> Result<InstallLease> {
        let mut inner = self.inner.lock().map_err(err)?;
        if inner.installing {
            return Err("更新正在安装，请等待完成".into());
        }
        inner.installing = true;
        Ok(InstallLease(self.clone()))
    }
    pub(super) fn clear_idle_cache(&self) -> Result<Option<u64>> {
        // Hold the updater lock through removal. A new download cannot move
        // from available to downloading while its directory is being cleared.
        let inner = self.inner.lock().map_err(err)?;
        if inner.installing
            || ["downloading", "installing", "ready"].contains(&text(&inner.state, "status"))
            || inner.state["downloadPath"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        {
            return Ok(None);
        }
        application_repair::remove_cache(&self.root.join("updates"))
    }
    async fn manifest(&self) -> Result<Value> {
        source::manifest(&self.root).await
    }
    pub async fn check(&self) -> Result<Value> {
        {
            let mut inner = self.inner.lock().unwrap();
            if inner.installing {
                return Ok(inner.state.clone());
            }
            if inner.state["status"] == "downloading" {
                return Ok(inner.state.clone());
            }
            inner.state["status"] = json!("checking");
        }
        let fetched = self.manifest().await;
        let mut inner = self.inner.lock().unwrap();
        if inner.installing {
            return Ok(inner.state.clone());
        }
        let manifest = match fetched {
            Ok(v) => v,
            Err(e) => {
                inner.state["status"] = json!("error");
                inner.state["error"] = json!(e);
                inner.state["updateAvailable"] = json!(false);
                inner.artifact = Value::Null;
                return Ok(inner.state.clone());
            }
        };
        let platform = if cfg!(target_os = "macos") {
            "darwin"
        } else if cfg!(target_os = "windows") {
            "windows"
        } else {
            "linux"
        };
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        };
        let newer = source::release_supported(&manifest)
            && version(text(&manifest, "version")) > version(text(&inner.state, "currentVersion"));
        let artifact = manifest["files"]
            .as_array()
            .and_then(|files| {
                files.iter().find(|f| {
                    f["platform"] == platform
                        && f["arch"] == arch
                        && artifact_extension_matches(
                            text(f, "name"),
                            platform,
                            inner.state["portable"] == true,
                        )
                })
            })
            .cloned()
            .unwrap_or(Value::Null);
        if newer
            && (artifact.is_null()
                || artifact["size"]
                    .as_u64()
                    .is_none_or(|n| n == 0 || n > 1024 * 1024 * 1024)
                || !text(&artifact, "sha256")
                    .bytes()
                    .all(|c| c.is_ascii_hexdigit())
                || text(&artifact, "sha256").len() != 64
                || validate_url(text(&artifact, "url")).is_err()
                || !artifact_extension_matches(
                    text(&artifact, "name"),
                    platform,
                    inner.state["portable"] == true,
                )
                || text(&artifact, "name").contains(['/', '\\']))
        {
            inner.state["status"] = json!("error");
            inner.state["error"] = json!("缺少当前平台可校验的制品");
            return Ok(inner.state.clone());
        }
        inner.state["status"] = json!(if newer { "available" } else { "up-to-date" });
        inner.state["updateAvailable"] = json!(newer);
        inner.state["targetVersion"] = manifest["version"].clone();
        inner.state["releaseNotes"] = manifest["changelog"].clone();
        inner.state["releaseDate"] = manifest["publishedAt"].clone();
        inner.state["size"] = artifact["size"].clone();
        inner.state["sha256"] = artifact["sha256"].clone();
        inner.state.as_object_mut().unwrap().remove("error");
        inner.artifact = artifact;
        inner.manifest = manifest;
        Ok(inner.state.clone())
    }
    pub fn cancel(&self) -> Result<Value> {
        let mut inner = self.inner.lock().unwrap();
        if inner.installing {
            return Err("更新正在安装，请等待完成".into());
        }
        inner.generation += 1;
        let declined = inner.state["targetVersion"].clone();
        write(
            &self.root.join("declined-update.json"),
            &json!({"version":declined}).to_string(),
        )?;
        inner.state["status"] = json!(if inner.state["updateAvailable"] == true {
            "available"
        } else {
            "idle"
        });
        inner.state.as_object_mut().unwrap().remove("percent");
        Ok(inner.state.clone())
    }
    pub fn download(&self) -> Result<Value> {
        let (artifact, generation, target, selected) = {
            let mut inner = self.inner.lock().unwrap();
            if inner.installing {
                return Err("更新正在安装，请等待完成".into());
            }
            if inner.state["status"] == "downloading" {
                return Ok(inner.state.clone());
            }
            if ![Some("available"), Some("ready")].contains(&inner.state["status"].as_str())
                || inner.state["updateAvailable"] != true
                || inner.artifact.is_null()
            {
                return Err("请先检查并选择有效更新".into());
            }
            inner.generation += 1;
            inner.state["status"] = json!("downloading");
            inner.state["percent"] = json!(0);
            (
                inner.artifact.clone(),
                inner.generation,
                text(&inner.state, "targetVersion").to_string(),
                inner.manifest.clone(),
            )
        };
        let this = self.clone();
        tokio::spawn(async move {
            let directory = this.root.join("updates");
            let temp = directory.join(format!("download-{generation}.part"));
            let result = async {
                if this.manifest().await? != selected {
                    return Err("更新源或版本已更改，请重新检查；未继续下载".into());
                }
                if this.inner.lock().unwrap().generation != generation {
                    return Err("下载已取消".into());
                }
                fs::create_dir_all(&directory).map_err(err)?;
                let url = validate_url(text(&artifact, "url"))?;
                let response = reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::limited(5))
                    .connect_timeout(Duration::from_secs(8))
                    .read_timeout(Duration::from_secs(30))
                    .build()
                    .map_err(err)?
                    .get(url)
                    .send()
                    .await
                    .map_err(|_| "更新下载失败".to_string())?
                    .error_for_status()
                    .map_err(|_| "更新下载 HTTP 错误".to_string())?;
                validate_url(response.url().as_str())?;
                let mut stream = response.bytes_stream();
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temp)
                    .map_err(err)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    file.set_permissions(fs::Permissions::from_mode(0o600))
                        .map_err(err)?;
                }
                let mut hash = Sha256::new();
                let mut size = 0u64;
                let expected = artifact["size"].as_u64().ok_or("无效更新大小")?;
                let start = millis();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|_| "更新下载中断".to_string())?;
                    if this.inner.lock().unwrap().generation != generation {
                        return Err("下载已取消".into());
                    }
                    size += chunk.len() as u64;
                    if size > expected {
                        return Err("下载大小不匹配".into());
                    }
                    use std::io::Write;
                    file.write_all(&chunk).map_err(err)?;
                    hash.update(&chunk);
                    let mut inner = this.inner.lock().unwrap();
                    inner.state["transferred"] = json!(size);
                    inner.state["total"] = json!(expected);
                    inner.state["percent"] = json!(100.0 * size as f64 / expected as f64);
                    inner.state["bytesPerSecond"] = json!(
                        size as f64 / (millis().saturating_sub(start).max(1) as f64 / 1000.0)
                    );
                }
                let digest = format!("{:x}", hash.finalize());
                if size != expected || digest != text(&artifact, "sha256").to_lowercase() {
                    return Err("下载 SHA-256 或大小校验失败".into());
                }
                file.sync_all().map_err(err)?;
                drop(file);
                let path = directory.join(format!(
                    "XwX-Deck-{target}{}",
                    if cfg!(target_os = "macos") {
                        ".dmg"
                    } else if windows_installer(text(&artifact, "name")) {
                        "-setup.exe"
                    } else {
                        ".exe"
                    }
                ));
                let mut inner = this.inner.lock().unwrap();
                if inner.generation != generation {
                    return Err("下载已取消".into());
                }
                fs::rename(&temp, &path).map_err(err)?;
                inner.state["status"] = json!("ready");
                inner.state["downloadPath"] = json!(path);
                Ok::<_, String>(())
            }
            .await;
            if let Err(e) = result {
                let _ = fs::remove_file(&temp);
                let mut inner = this.inner.lock().unwrap();
                if inner.generation == generation {
                    inner.state["status"] = json!("error");
                    inner.state["error"] = json!(e);
                }
            }
        });
        Ok(self.state())
    }
    pub async fn installer(&self) -> Result<PathBuf> {
        let (path, selected) = {
            let inner = self.inner.lock().unwrap();
            if inner.state["status"] != "ready" {
                return Err("请先下载并校验更新".into());
            }
            (
                PathBuf::from(text(&inner.state, "downloadPath")),
                inner.manifest.clone(),
            )
        };
        let latest = self.manifest().await?;
        if latest != selected {
            self.check().await?;
            return Err("更新版本已变化，请重新确认并下载".into());
        }
        if path.parent() != Some(self.root.join("updates").as_path()) {
            return Err("安装包路径不匹配".into());
        }
        let metadata = fs::symlink_metadata(&path).map_err(err)?;
        if metadata.file_type().is_symlink() {
            return Err("安装包不允许符号链接".into());
        }
        let artifact = self.inner.lock().unwrap().artifact.clone();
        let mut hash = Sha256::new();
        use std::io::Read;
        let mut file = fs::File::open(&path).map_err(err)?;
        let mut buffer = [0u8; 65536];
        loop {
            let n = file.read(&mut buffer).map_err(err)?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
        }
        if format!("{:x}", hash.finalize()) != text(&artifact, "sha256").to_lowercase()
            || metadata.len() != artifact["size"].as_u64().unwrap_or(0)
        {
            return Err("安装包已被修改，未打开".into());
        }
        #[cfg(target_os = "windows")]
        if self.state()["portable"] != true {
            crate::windows_setup::validate(&path, text(&selected, "version"))?;
        }
        Ok(path)
    }
}
