//! Opt-in, persistent browser storage for restart acceptance in an isolated root.
//! Ordinary fixtures stay incognito. The test store never uses the default store.
#[cfg(target_os = "macos")]
use sha2::{Digest, Sha256};
use std::path::Path;

#[cfg(target_os = "macos")]
fn identifier(root: &Path) -> Result<[u8; 16], String> {
    let root = root.canonicalize().map_err(|_| "隔离配置目录不存在")?;
    let mut hash = Sha256::new();
    hash.update(b"app.xwxdeck.validation.persistent-test.v1\0");
    hash.update(root.to_string_lossy().as_bytes());
    let mut id = [0u8; 16];
    id.copy_from_slice(&hash.finalize()[..16]);
    id[6] = (id[6] & 15) | 0x40;
    id[8] = (id[8] & 63) | 0x80;
    Ok(id)
}

#[cfg(target_os = "macos")]
fn identified_stores_supported() -> Result<bool, String> {
    let output = std::process::Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .map_err(|_| "无法核对 macOS 版本")?;
    if !output.status.success() {
        return Err("无法核对 macOS 版本".into());
    }
    let major = String::from_utf8_lossy(&output.stdout)
        .trim()
        .split('.')
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .ok_or("无法核对 macOS 版本")?;
    Ok(major >= 14)
}
pub fn supported() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if !identified_stores_supported()? {
        return Err("隔离持久 WebView 验收需要 macOS 14 或以上；普通隔离测试仍可使用".into());
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("此平台尚未提供隔离持久 WebView 验收".into())
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        Ok(())
    }
}

pub fn create(app: &tauri::App, root: &Path) -> Result<(), String> {
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = root;
    supported()?;
    // This Tauri version omits store/directory fields when converting config
    // to WebviewAttributes. Set them on the builder explicitly.
    let builder = tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])
        .map_err(|_| "无法准备隔离持久窗口")?
        .incognito(false);
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(identifier(root)?);
    #[cfg(target_os = "windows")]
    let builder = builder.data_directory(directory(root, "restart-webview")?);
    builder.build().map_err(|_| "无法创建隔离持久窗口")?;
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn directory(root: &Path, name: &str) -> Result<std::path::PathBuf, String> {
    if ![
        "restart-webview",
        "ephemeral-webview",
        "viewer-webview",
        "licenses-webview",
        "tray-webview",
    ]
    .contains(&name)
    {
        return Err("无效隔离 WebView 目录".into());
    }
    let path = root
        .canonicalize()
        .map_err(|_| "隔离目录不存在")?
        .join(name);
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if !meta.is_dir() || meta.file_type().is_symlink() => {
            return Err("隔离 WebView 目录类型已变化，已保留".into())
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("无法检查隔离 WebView 目录".into()),
    }
    Ok(path)
}

#[cfg(target_os = "windows")]
pub fn create_ephemeral(app: &tauri::App, root: &Path) -> Result<(), String> {
    // InPrivate windows sharing the default user-data directory can share a
    // live browser environment. A distinct directory is needed for each root.
    tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])
        .map_err(|_| "无法准备隔离窗口")?
        .incognito(true)
        .data_directory(directory(root, "ephemeral-webview")?)
        .build()
        .map_err(|_| "无法创建隔离窗口")?;
    Ok(())
}

pub fn cleanup(root: &Path) -> Result<(), String> {
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = root;
    supported()?;
    #[cfg(target_os = "macos")]
    {
        remove_stores(vec![identifier(root)?])
    }
    #[cfg(target_os = "windows")]
    {
        let path = root.join("restart-webview");
        if path.exists() {
            let metadata =
                std::fs::symlink_metadata(&path).map_err(|_| "无法检查隔离 WebView 目录")?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err("隔离 WebView 目录类型已变化，已保留".into());
            }
            std::fs::remove_dir_all(path).map_err(|_| "隔离 WebView 目录仍在使用，已保留")?;
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("此平台尚未提供隔离 WebView 清理".into())
}

/// Called only after the validated manager has exited. Never select the default
/// WebKit store or enumerate stores as removal targets.
pub(crate) fn cleanup_reset(root: &Path, persistent_main: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if !identified_stores_supported()? {
            return Ok(());
        } // Older default store was cleared in the main window.
        let mut ids = vec![];
        if persistent_main {
            ids.push(identifier(root)?);
        }
        remove_stores(ids)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (root, persistent_main);
        Ok(())
    } // Windows profile is archived after exit.
}
#[cfg(target_os = "macos")]
fn remove_stores(ids: Vec<[u8; 16]>) -> Result<(), String> {
    let result = std::sync::Arc::new(std::sync::Mutex::new(None));
    let shared = result.clone();
    let mut context = tauri::generate_context!();
    let window = &mut context.config_mut().app.windows[0];
    window.visible = false;
    window.incognito = true;
    window.data_store_identifier = None;
    window.url = tauri::WebviewUrl::External("about:blank".parse().unwrap());
    let app = tauri::Builder::default()
        .build(context)
        .map_err(|_| "无法启动浏览器存储清理")?;
    app.run_return(move |app, event| {
        if matches!(event, tauri::RunEvent::Ready) {
            let handle = app.clone();
            let shared = shared.clone();
            let ids = ids.clone();
            tauri::async_runtime::spawn(async move {
                let outcome = tokio::time::timeout(std::time::Duration::from_secs(15), async {
                    loop {
                        let present = handle
                            .fetch_data_store_identifiers()
                            .await
                            .map_err(|_| "无法确认浏览器存储清理结果".to_owned())?;
                        let pending: Vec<_> = ids
                            .iter()
                            .filter(|id| present.contains(id))
                            .copied()
                            .collect();
                        if pending.is_empty() {
                            return Ok(());
                        }
                        // WebKit may still be releasing the exited manager's network process.
                        // Retry only the captured root identifiers, with one bounded deadline.
                        for id in pending {
                            let _ = handle.remove_data_store(id).await;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                })
                .await
                .unwrap_or_else(|_| Err("浏览器存储仍在使用，应用数据与备份保留".into()));
                let success = outcome.is_ok();
                if let Err(error) = &outcome {
                    eprintln!("{error}");
                }
                *shared.lock().unwrap() = Some(outcome);
                handle.exit(if success { 0 } else { 2 });
            });
        }
    });
    let outcome = result
        .lock()
        .unwrap()
        .take()
        .unwrap_or_else(|| Err("浏览器存储清理未完成".into()));
    outcome
}
