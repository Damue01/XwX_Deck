//! Startup failures use the application surface without opening blocked data.
use serde_json::Value;
use std::path::PathBuf;

#[tauri::command]
fn recovery_action(
    app: tauri::AppHandle,
    caller: tauri::WebviewWindow,
    action: String,
    report: Option<Value>,
) -> Result<(), String> {
    if caller.label() != "startup-recovery" {
        return Err("无效恢复窗口".into());
    }
    if action == "close" {
        app.exit(2);
        return Ok(());
    }
    if action == "report" && std::env::args().any(|arg| arg == "--smoke-recovery") {
        let root = crate::argument("--pilot-root").ok_or("缺少隔离目录")?;
        let bytes = serde_json::to_vec(&report.ok_or("缺少报告")?).map_err(|e| e.to_string())?;
        if bytes.len() > 16384 {
            return Err("报告过大".into());
        }
        std::fs::write(PathBuf::from(root).join("recovery-smoke.json"), bytes)
            .map_err(|e| e.to_string())?;
        if !std::env::args().any(|arg| arg == "--smoke-physical") {
            app.exit(2);
        }
        return Ok(());
    }
    Err("无效恢复操作".into())
}

pub fn show(message: &str) {
    let isolated = crate::argument("--pilot-root").map(PathBuf::from);
    let scratch = if isolated.is_none() {
        let mut random = [0u8; 16];
        if getrandom::fill(&mut random).is_err() {
            return;
        }
        let name = random
            .iter()
            .map(|x| format!("{x:02x}"))
            .collect::<String>();
        let Ok(base) = std::env::temp_dir().canonicalize() else {
            return;
        };
        let path = base.join(format!("xwx-deck-recovery-{name}"));
        if std::fs::create_dir(&path).is_err() {
            return;
        }
        Some(path)
    } else {
        None
    };
    let directory = if let Some(root) = isolated {
        crate::isolated_webview::directory(&root, "recovery-webview")
    } else {
        Ok(scratch.as_ref().unwrap().clone())
    };
    let Ok(directory) = directory else { return };
    let mut context = tauri::generate_context!();
    for window in &mut context.config_mut().app.windows {
        window.create = false;
    }
    let script = format!(
        "window.__xwxRecoveryMessage={};",
        serde_json::to_string(message).unwrap()
    );
    let result = crate::embedded_fonts::builder()
        .invoke_handler(tauri::generate_handler![recovery_action])
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "startup-recovery",
                tauri::WebviewUrl::App("recovery.html".into()),
            )
            .title("XwX Deck 无法启动")
            .inner_size(480.0, 300.0)
            .min_inner_size(360.0, 240.0)
            .decorations(false)
            .resizable(true)
            .incognito(true)
            .data_directory(directory.clone())
            .initialization_script(&script)
            .build()?;
            Ok(())
        })
        .on_page_load(|window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished
                && std::env::args().any(|arg| arg == "--smoke-recovery")
            {
                let _ = window.eval(include_str!("../../tools/native/startup-recovery-smoke.js"));
            }
        })
        .build(context);
    if let Ok(app) = result {
        app.run(|_, _| {});
    }
    if let Some(path) = scratch {
        // Only remove the fresh direct child created above, never blocked data.
        if path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("xwx-deck-recovery-"))
        {
            for _ in 0..8 {
                if std::fs::remove_dir_all(&path).is_ok() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    }
}
