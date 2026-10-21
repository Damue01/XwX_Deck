//! Retire the old helper's control files only after every client is direct.
//! Startup preflight precedes sealing any old document. No process is signalled,
//! no control request is sent, and an occupied/uncertain helper is left running.
use super::*;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};

const CONTROL_FILES: &[&str] = &[
    "gateway/runtime.json",
    "gateway/bootstrap.json",
    "gateway/control.token",
    "gateway/client-fallbacks.json",
];
fn bounded(root: &Path, name: &str, registered: bool) -> Result<Option<String>> {
    let path = root.join(name);
    if let Some(parent) = path.parent().filter(|p| p.exists()) {
        if !same_physical_path(parent)? {
            return Err("旧 Gateway 路径经过符号链接，未迁移".into());
        }
    }
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(err(e)),
        Ok(m) if m.file_type().is_symlink() || !m.is_file() || m.len() > 16 * 1024 * 1024 => {
            return Err("旧 Gateway 文件不是普通文件或超过读取上限，已保留".into())
        }
        _ => {}
    }
    if registered {
        return read(&path);
    }
    let source = fs::read_to_string(&path).map_err(|_| "旧 Gateway 文件无法读取，已保留")?;
    // A previously sealed native document cannot be consumed by the old app.
    // Recheck its decrypted contents after attaching the existing vault.
    if serde_json::from_str::<Value>(&source).is_ok_and(|v| v["nativeEncryptedDocument"] == 1) {
        return Ok(None);
    }
    Ok(Some(source))
}
fn occupied(port: u16) -> bool {
    [
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(Ipv6Addr::LOCALHOST),
    ]
    .into_iter()
    .any(|ip| {
        TcpStream::connect_timeout(&SocketAddr::new(ip, port), Duration::from_millis(100)).is_ok()
    })
}
#[cfg(unix)]
pub(super) fn process_present(pid: u32) -> bool {
    // Signal 0 performs an existence/permission query; it sends no signal.
    unsafe extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    (unsafe { kill(pid as i32, 0) == 0 })
        || std::io::Error::last_os_error().kind() == std::io::ErrorKind::PermissionDenied
}
#[cfg(windows)]
pub(super) fn process_present(pid: u32) -> bool {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn GetExitCodeProcess(handle: *mut std::ffi::c_void, code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    }
    unsafe {
        let handle = OpenProcess(0x1000, 0, pid);
        if handle.is_null() {
            return std::io::Error::last_os_error().raw_os_error() != Some(87);
        }
        let mut code = 0;
        let present = GetExitCodeProcess(handle, &mut code) == 0 || code == 259;
        CloseHandle(handle);
        present
    }
}
#[cfg(not(any(unix, windows)))]
pub(super) fn process_present(_: u32) -> bool {
    true
}

fn owned_url(url: &str) -> bool {
    super::legacy_recovery::endpoint(url).is_some_and(|a| {
        (crate::edition::config::GATEWAY_PORT..=crate::edition::config::GATEWAY_PORT + 9)
            .contains(&a.port())
    })
}
fn toml_routes(source: &str) -> Result<Vec<String>> {
    let d = doc(source)?;
    let mut urls: Vec<_> = ["openai_base_url", "chatgpt_base_url"]
        .into_iter()
        .filter_map(|k| d.get(k).and_then(Item::as_str))
        .map(str::to_string)
        .collect();
    if let Some(providers) = d.get("model_providers").and_then(Item::as_table_like) {
        urls.extend(
            providers
                .iter()
                .filter_map(|(_, v)| v.get("base_url").and_then(Item::as_str))
                .map(str::to_string),
        );
    }
    Ok(urls)
}
pub(super) fn preflight(root: &Path, registered: bool) -> Result<()> {
    let mut urls = vec![];
    let mut control_ports = vec![];
    let mut old_control = false;
    for name in CONTROL_FILES {
        let Some(source) = bounded(root, name, registered)? else {
            continue;
        };
        old_control = true;
        if *name == "gateway/control.token" {
            continue;
        }
        let record: Value = serde_json::from_str(&source)
            .map_err(|_| "旧 Gateway 生命周期文件损坏，未改写原配置")?;
        if *name == "gateway/runtime.json" {
            let pid = record["pid"]
                .as_u64()
                .filter(|p| *p > 0 && *p <= i32::MAX as u64)
                .ok_or("旧 Gateway PID 无效，已保留")? as u32;
            if record["version"] != 1 {
                return Err("旧 Gateway runtime 版本无效，已保留".into());
            }
            for key in ["gatewayPort", "controlPort"] {
                let port = record[key]
                    .as_u64()
                    .filter(|p| *p > 0 && *p <= u16::MAX as u64)
                    .ok_or("旧 Gateway 端口无效，已保留")? as u16;
                control_ports.push(port);
            }
            if process_present(pid) {
                return Err("旧 Gateway 记录的进程仍存在或身份无法确认；请先停止旧版 Trace 并退出旧应用后重试。未中断进程或改写配置".into());
            }
        } else if *name == "gateway/client-fallbacks.json" {
            urls.push(text(&record, "localBaseUrl").to_string());
        }
    }
    for name in [
        "trace-client-backups/claude.json",
        "trace-client-backups/codex.json",
        "codex-local-proxy-suspension.json",
        "codex-direct-config-state.json",
        "codex-direct-restore.json",
        "claude-desktop-sync-state.json",
    ] {
        if let Some(source) = bounded(root, name, registered)? {
            let record: Value =
                serde_json::from_str(&source).map_err(|_| "旧客户端恢复记录损坏，未改写原配置")?;
            if let Some(url) = record["writtenLocalUrl"].as_str() {
                urls.push(url.into());
            }
            if let Some(url) = record["originalBaseUrl"].as_str().filter(|u| owned_url(u)) {
                urls.push(url.into());
            }
            if name == "codex-direct-restore.json" {
                for entry in record["fields"]
                    .as_object()
                    .into_iter()
                    .flat_map(|fields| fields.values())
                {
                    if let Some(url) = entry["written"].as_str().filter(|url| owned_url(url)) {
                        urls.push(url.into());
                    }
                }
            }
            if let Some(content) = record["writtenContent"]
                .as_str()
                .filter(|_| name == "codex-direct-config-state.json")
            {
                urls.extend(toml_routes(content)?.into_iter().filter(|u| owned_url(u)));
            }
            if let Some(profile) = record["writtenProfileContent"]
                .as_str()
                .filter(|s| !s.is_empty())
            {
                let profile: Value =
                    serde_json::from_str(profile).map_err(|_| "旧 Desktop profile 损坏，已保留")?;
                let base = text(&profile, "inferenceGatewayBaseUrl");
                if owned_url(base) {
                    urls.push(base.into());
                }
            }
        }
    }
    let recorded_endpoint = urls
        .iter()
        .any(|u| super::legacy_recovery::endpoint(u).is_some());
    if old_control && control_ports.is_empty() && !recorded_endpoint {
        // With neither a runtime nor recorded route, retain the conservative
        // old-format guard. Otherwise probe only the recorded endpoints; an
        // unrelated application in the product range is not this root's helper.
        control_ports.extend(
            crate::edition::config::GATEWAY_PORT..=crate::edition::config::GATEWAY_PORT + 9,
        );
    }
    control_ports.sort();
    control_ports.dedup();
    let live_recorded = urls
        .iter()
        .filter_map(|u| super::legacy_recovery::endpoint(u))
        .any(|a| TcpStream::connect_timeout(&a, Duration::from_millis(100)).is_ok());
    // Windows waits out connection refusal on each address. Probe the bounded
    // product endpoints together so startup does not serialize those waits.
    let live_control = std::thread::scope(|scope| {
        let probes: Vec<_> = control_ports
            .into_iter()
            .map(|port| scope.spawn(move || occupied(port)))
            .collect();
        let mut live = false;
        for probe in probes {
            live |= probe.join().unwrap_or(true);
        }
        live
    });
    if live_recorded || live_control {
        return Err("旧版 Trace 或 Gateway 端口仍在运行或被占用；请先在旧应用停止 Trace 并退出后重试。未中断请求或改写配置".into());
    }
    Ok(())
}
impl Pilot {
    pub(super) fn recover_legacy_helper(&self) -> Result<()> {
        let mut files = serde_json::Map::new();
        for name in CONTROL_FILES {
            if let Some(source) = bounded(&self.root, name, true)? {
                files.insert((*name).into(), json!(source));
            }
        }
        if files.is_empty() {
            return Ok(());
        }
        preflight(&self.root, true)?;
        if let Some(source) = files
            .get("gateway/client-fallbacks.json")
            .and_then(Value::as_str)
        {
            let fallback: Value =
                serde_json::from_str(source).map_err(|_| "旧 Gateway fallback 损坏，已保留")?;
            let clients = fallback["clients"]
                .as_array()
                .filter(|a| a.len() <= 2)
                .ok_or("旧 Gateway fallback 客户端无效")?;
            if fallback["version"] != 1
                || !owned_url(text(&fallback, "localBaseUrl"))
                || clients
                    .iter()
                    .any(|c| !["codex-cli", "claude-cli"].contains(&text(c, "client")))
            {
                return Err("旧 Gateway fallback 身份无效，已保留".into());
            }
        }
        let mut remaining = vec![];
        if let Some(source) = read(&self.config_path())? {
            remaining.extend(toml_routes(&source)?.into_iter().filter(|u| owned_url(u)));
        }
        if let Some(source) = read(&self.claude_path())? {
            let config: Value = serde_json::from_str(&source)
                .map_err(|_| "Claude 客户端 JSON 损坏，未清理 fallback")?;
            if owned_url(text(&config["env"], "ANTHROPIC_BASE_URL")) {
                remaining.push("Claude".into());
            }
        }
        let (_, meta, profile) = self.desktop_paths();
        for path in [
            profile,
            meta.parent().unwrap().join("xwx-deck.json"),
            meta.parent().unwrap().join(format!(
                "{}.json",
                crate::edition::config::DESKTOP_LEGACY_IDS[1]
            )),
        ] {
            if let Some(source) = read(&path)? {
                let profile: Value = serde_json::from_str(&source)
                    .map_err(|_| "Desktop profile 损坏，未清理 fallback")?;
                if owned_url(text(&profile, "inferenceGatewayBaseUrl")) {
                    remaining.push("Desktop".into());
                }
            }
        }
        if !remaining.is_empty() {
            return Err(
                "旧客户端仍引用本产品本地路由；恢复记录和 fallback 已保留，请恢复直连后重试".into(),
            );
        }
        let archive_content = json!({"version":1,"files":files}).to_string();
        let archive = self.root.join(format!(
            "legacy-recovery-helper-{}.json",
            storage::digest(archive_content.as_bytes())
        ));
        // Save all original bytes before clearing the first control file. A
        // partial cleanup remains recoverable from this encrypted archive.
        if read(&archive)?.is_none() {
            write(&archive, &archive_content)?;
        }
        for (name, source) in &files {
            if read(&self.root.join(name))?.as_deref() != source.as_str() {
                return Err("旧 Gateway 生命周期文件发生外部修改，全部剩余文件已保留".into());
            }
        }
        preflight(&self.root, true)?;
        for (name, source) in files {
            let path = self.root.join(name);
            if read(&path)?.as_deref() != source.as_str() {
                return Err("旧 Gateway 清理期间发生外部修改，备份及剩余文件已保留".into());
            }
            fs::remove_file(path).map_err(err)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_runtime_ports_do_not_claim_an_unrelated_product_listener() {
        let unrelated = (crate::edition::config::GATEWAY_PORT
            ..=crate::edition::config::GATEWAY_PORT + 9)
            .find_map(|port| std::net::TcpListener::bind(("127.0.0.1", port)).ok())
            .expect("unused product port for isolated listener");
        let gateway = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let control = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let gateway_port = gateway.local_addr().unwrap().port();
        let control_port = control.local_addr().unwrap().port();
        drop((gateway, control));
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "xwx-helper-port-scope-{}-{}",
                std::process::id(),
                millis()
            ));
        fs::create_dir_all(root.join("gateway")).unwrap();
        let path = root.join("gateway/runtime.json");
        let mut runtime = json!({"version":1,"pid":2147483647,"gatewayPort":gateway_port,"controlPort":control_port});
        fs::write(&path, runtime.to_string()).unwrap();
        let result = preflight(&root, false);
        assert!(result.is_ok(), "{result:?}");
        fs::remove_file(&path).unwrap();
        fs::write(root.join("gateway/bootstrap.json"), "{\"generation\":1}").unwrap();
        fs::write(root.join("gateway/control.token"), "isolated-unit-token").unwrap();
        fs::write(
            root.join("gateway/client-fallbacks.json"),
            json!({"version":1,"localBaseUrl":format!("http://127.0.0.1:{gateway_port}")})
                .to_string(),
        )
        .unwrap();
        assert!(
            preflight(&root, false).is_ok(),
            "recorded dead route must not claim an unrelated listener"
        );
        fs::remove_file(root.join("gateway/client-fallbacks.json")).unwrap();
        assert!(
            preflight(&root, false).is_err(),
            "unknown control ownership retains the conservative guard"
        );
        fs::remove_file(root.join("gateway/bootstrap.json")).unwrap();
        fs::remove_file(root.join("gateway/control.token")).unwrap();
        runtime["gatewayPort"] = json!(unrelated.local_addr().unwrap().port());
        let before = runtime.to_string();
        fs::write(&path, &before).unwrap();
        assert!(preflight(&root, false).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), before);
        fs::remove_dir_all(root).unwrap();
    }
}
