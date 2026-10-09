#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
mod core;
mod language;
mod portable_update;
use core::{Pilot, Shared};
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    path::PathBuf,
};
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
async fn pilot_rpc(
    app: tauri::AppHandle,
    caller: tauri::WebviewWindow,
    pilot: tauri::State<'_, Shared>,
    method: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    if caller.label() != "main" {
        return Err("操作只允许在主窗口发起".into());
    }
    let window = app.get_webview_window("main").ok_or("主窗口不存在")?;
    match method.as_str() {
        "beginSubscriptionSignIn" => {
            let p = &mut *pilot.lock().await;
            let result = p.call(&method, &args).await?;
            let url = p.subscription_authorization_url().await?;
            if app.opener().open_url(url, None::<String>).is_err() {
                p.call("cancelSubscriptionSignIn", &[]).await?;
                return Err("无法打开系统浏览器，请重试".into());
            }
            Ok(result)
        }
        "setStartupEnabled" => {
            let mut p = pilot.lock().await;
            let mut state = p.call(&method, &args).await?;
            let desired = args.first().and_then(Value::as_bool).ok_or("无效开关")?;
            let result = if desired {
                app.autolaunch().enable()
            } else {
                app.autolaunch().disable()
            };
            state["startup"]["enabled"] = json!(app.autolaunch().is_enabled().unwrap_or(false));
            if let Err(e) = result {
                state["startup"]["warning"] = json!(format!("登录项设置失败，选择已保存：{e}"));
            }
            let _ = app.emit("pilot-state", &state);
            Ok(state)
        }
        "getState" | "refresh" => {
            let mut state = pilot.lock().await.call(&method, &args).await?;
            if !std::env::args().any(|a| a == "--pilot-root") {
                match app.autolaunch().is_enabled() {
                    Ok(enabled) => {
                        state["startup"]["enabled"] = json!(enabled);
                        state["startup"]["executableWillLaunchAtLogin"] = json!(enabled);
                    }
                    Err(e) => {
                        state["startup"]["enabled"] = json!(false);
                        state["startup"]["warning"] = json!(e.to_string());
                    }
                }
            }
            Ok(state)
        }
        "getWindowState" => Ok(
            json!({"nativeFrame":cfg!(target_os="macos"),"maximized":window.is_maximized().unwrap_or(false),"fullscreen":window.is_fullscreen().unwrap_or(false)}),
        ),
        "checkForUpdates" | "downloadUpdate" | "cancelUpdate" => {
            let result = pilot.lock().await.call(&method, &args).await?;
            let _ = app.emit("pilot-update", &result);
            if method == "downloadUpdate" && result["status"] == "downloading" {
                let app = app.clone();
                let shared = pilot.inner().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                        let state = shared.lock().await.update_state();
                        let _ = app.emit("pilot-update", &state);
                        if state["status"] != "downloading" {
                            break;
                        }
                    }
                });
            }
            Ok(result)
        }
        "restartAndInstall" => {
            let result = pilot.lock().await.call(&method, &args).await?;
            let path = result["path"].as_str().ok_or("无效安装包")?;
            #[cfg(target_os = "macos")]
            {
                app.opener()
                    .open_path(path, None::<&str>)
                    .map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            #[cfg(target_os = "windows")]
            {
                pilot.lock().await.stop().await?;
                portable_update::spawn(std::path::Path::new(path))?;
                app.exit(0);
                Ok(Value::Null)
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                let _ = path;
                Err("当前平台不支持安装替换".into())
            }
        }
        "repairApplication" => {
            window
                .clear_all_browsing_data()
                .map_err(|e| e.to_string())?;
            let mut p = pilot.lock().await;
            let mut result = p.call(&method, &args).await?;
            result["chromiumCacheCleared"] = json!(true);
            Ok(result)
        }
        "smokeViewerReport" if std::env::args().any(|arg| arg == "--smoke") => {
            let path = pilot
                .lock()
                .await
                .trace_root()
                .join("native-viewer-smoke.json");
            if !path.exists() {
                return Ok(Value::Null);
            }
            let data = std::fs::read(path).map_err(|e| e.to_string())?;
            serde_json::from_slice(&data).map_err(|e| e.to_string())
        }
        "smokeCloseViewer" if std::env::args().any(|arg| arg == "--smoke") => {
            if let Some(viewer) = app.get_webview_window("dashboard") {
                viewer.destroy().map_err(|e| e.to_string())?;
            }
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "smokeCloseWindow" if std::env::args().any(|arg| arg == "--smoke") => {
            window.close().map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "smokeContext" if std::env::args().any(|arg| arg == "--smoke") => {
            let base = argument("--smoke-upstream");
            if let Some(ref base) = base {
                let url = reqwest::Url::parse(base).map_err(|e| e.to_string())?;
                if url.scheme() != "http"
                    || ![Some("127.0.0.1"), Some("localhost")].contains(&url.host_str())
                {
                    return Err("smoke 只允许本地测试服务".into());
                }
            }
            Ok(json!({"upstream":base}))
        }
        "smokeRequest" if std::env::args().any(|arg| arg == "--smoke") => {
            let base = pilot.lock().await.state()["localBaseUrl"]
                .as_str()
                .ok_or("Gateway 未运行")?
                .to_string();
            let hidden = args.first().and_then(Value::as_bool).unwrap_or(false);
            if hidden {
                window.hide().map_err(|e| e.to_string())?;
            }
            let generic = args.first().and_then(|v|v.get("client")).and_then(Value::as_str);
            let (path, payload) = if let Some(client) = generic {
                if client != "opencode" { return Err("无效隔离测试客户端".into()); }
                (format!("/clients/{client}/v1/chat/completions"), json!({"model":"gpt-4.1","messages":[{"role":"user","content":"isolated native WebKit smoke"}],"stream":true}))
            } else { ("/v1/responses".into(), json!({"model":"pilot-model","input":"isolated native WebKit smoke","stream":true})) };
            let response=reqwest::Client::new().post(format!("{base}{path}")).json(&payload).send().await.map_err(|e|e.to_string())?;
            let status = response.status().as_u16();
            let body = response.text().await.map_err(|e| e.to_string())?;
            let visible = window.is_visible().map_err(|e| e.to_string())?;
            if hidden {
                window.show().map_err(|e| e.to_string())?;
            }
            Ok(json!({"status":status,"body":body,"visibleDuringRequest":visible}))
        }
        "openDataFolder" | "openLogFolder" => {
            let p = pilot.lock().await;
            let path = if method == "openDataFolder" {
                p.trace_root()
            } else {
                p.log_root()
            };
            app.opener()
                .open_path(path.to_string_lossy(), None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "chooseConfigurationImportFile" => {
            let path = app
                .dialog()
                .file()
                .set_title("选择已有配置")
                .add_filter("配置文件", &["json", "toml", "db", "sqlite", "sqlite3"])
                .blocking_pick_file()
                .map(|p| p.into_path().map_err(|e| e.to_string()))
                .transpose()?;
            Ok(json!(path))
        }
        "chooseDirectory" => {
            let path = app
                .dialog()
                .file()
                .set_title("选择目录")
                .blocking_pick_folder()
                .map(|p| p.into_path().map_err(|e| e.to_string()))
                .transpose()?;
            Ok(json!(path))
        }
        "chooseTraceBackground" => {
            let file = app
                .dialog()
                .file()
                .set_title("选择 Trace 背景")
                .add_filter("图像", &["png", "jpg", "jpeg", "webp"])
                .blocking_pick_file()
                .map(|p| p.into_path().map_err(|e| e.to_string()))
                .transpose()?;
            let Some(file) = file else {
                return Ok(Value::Null);
            };
            let mut p = pilot.lock().await;
            p.choose_background(&file)
        }
        "copyText" => {
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            {
                use std::io::Write;
                use std::process::{Command, Stdio};
                let mut command = Command::new(if cfg!(target_os = "macos") {
                    "/usr/bin/pbcopy"
                } else {
                    "clip.exe"
                })
                .stdin(Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())?;
                let value = args.first().and_then(Value::as_str).unwrap_or("");
                #[cfg(target_os = "windows")]
                let bytes: Vec<u8> = [0xfeffu16]
                    .into_iter()
                    .chain(value.encode_utf16())
                    .flat_map(u16::to_le_bytes)
                    .collect();
                #[cfg(target_os = "macos")]
                let bytes = value.as_bytes();
                command
                    .stdin
                    .take()
                    .ok_or("无法写入剪贴板")?
                    .write_all(&bytes)
                    .map_err(|e| e.to_string())?;
                if !command.wait().map_err(|e| e.to_string())?.success() {
                    return Err("复制失败".into());
                }
                Ok(Value::Null)
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                Err("当前平台没有原生剪贴板支持".into())
            }
        }
        "openSetupWebsite" | "openSubscriptionUsage" => {
            let manifest: Value = serde_json::from_str(include_str!(
                "../../test-results/native-assets/setup-websites.json"
            ))
            .map_err(|e| e.to_string())?;
            let platform = if cfg!(target_os = "macos") {
                "darwin"
            } else if cfg!(target_os = "windows") {
                "win32"
            } else {
                "linux"
            };
            let arch = if cfg!(target_arch = "aarch64") {
                "arm64"
            } else {
                "x64"
            };
            let site = if method == "openSubscriptionUsage" {
                let subscription = args.first().and_then(Value::as_str).unwrap_or("chatgpt");
                if !["chatgpt", "grok", "copilot", "claude", "cursor"].contains(&subscription) {
                    return Err("无效的订阅用量入口".into());
                }
                format!("subscription-{subscription}-usage")
            } else {
                args.first()
                    .and_then(Value::as_str)
                    .ok_or("无效官方链接")?
                    .to_owned()
            };
            let url = manifest[platform][arch][site.as_str()]
                .as_str()
                .ok_or("无效官方链接")?;
            let parsed = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
            if parsed.scheme() != "https"
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                return Err("无效官方链接".into());
            }
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "openDashboard" => {
            let url = pilot.lock().await.dashboard_url().await?;
            if let Some(existing) = app.get_webview_window("dashboard") {
                existing.show().map_err(|e| e.to_string())?;
                existing.set_focus().map_err(|e| e.to_string())?;
            } else {
                tauri::WebviewWindowBuilder::new(
                    &app,
                    "dashboard",
                    tauri::WebviewUrl::External(
                        reqwest::Url::parse(&url).map_err(|e| e.to_string())?,
                    ),
                )
                .title("XwX Deck Trace")
                .inner_size(1100.0, 760.0)
                .build()
                .map_err(|e| e.to_string())?;
            }
            Ok(Value::Null)
        }
        "minimizeWindow" => {
            window.minimize().map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "toggleMaximize" => {
            if window.is_maximized().map_err(|e| e.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
            .map_err(|e| e.to_string())?;
            Ok(
                json!({"maximized":window.is_maximized().map_err(|e|e.to_string())?,"fullscreen":window.is_fullscreen().map_err(|e|e.to_string())?}),
            )
        }
        "toggleFullscreen" => {
            let fullscreen = !window.is_fullscreen().map_err(|e| e.to_string())?;
            window
                .set_fullscreen(fullscreen)
                .map_err(|e| e.to_string())?;
            Ok(json!({"fullscreen":fullscreen}))
        }
        "setManagerView" => Ok(json!(true)),
        "moveWindowStart" => {
            window.start_dragging().map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "resizeWindowStart" => {
            let edge = args
                .first()
                .map(|v| v["edge"].as_str().unwrap_or(""))
                .unwrap_or("");
            let direction = match edge {
                "n" => tauri_runtime::ResizeDirection::North,
                "s" => tauri_runtime::ResizeDirection::South,
                "e" => tauri_runtime::ResizeDirection::East,
                "w" => tauri_runtime::ResizeDirection::West,
                "ne" => tauri_runtime::ResizeDirection::NorthEast,
                "nw" => tauri_runtime::ResizeDirection::NorthWest,
                "se" => tauri_runtime::ResizeDirection::SouthEast,
                "sw" => tauri_runtime::ResizeDirection::SouthWest,
                _ => return Err("无效窗口边缘".into()),
            };
            window
                .as_ref()
                .window()
                .start_resize_dragging(direction)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "moveWindow" | "moveWindowEnd" | "resizeWindowMove" | "resizeWindowEnd" => Ok(Value::Null),
        "closeWindow" => {
            if pilot.lock().await.active() {
                window.hide().map_err(|e| e.to_string())?;
            } else {
                window.close().map_err(|e| e.to_string())?;
            }
            Ok(Value::Null)
        }
        _ => {
            let mut pilot = pilot.lock().await;
            let result = pilot.call(&method, &args).await?;
            if result.get("readiness").is_some() {
                let _ = app.emit("pilot-state", &result);
            }
            Ok(result)
        }
    }
}

#[tauri::command]
async fn pilot_smoke_report(
    app: tauri::AppHandle,
    pilot: tauri::State<'_, Shared>,
    report: Value,
) -> Result<(), String> {
    if !std::env::args().any(|arg| arg == "--smoke") {
        return Err("仅隔离 smoke 启动可保存验证证据".into());
    }
    let pilot = pilot.lock().await;
    std::fs::write(
        pilot.root.join("native-smoke.json"),
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if std::env::args().any(|arg| arg == "--smoke-exit") && !pilot.active() {
        if let Some(window) = app.get_webview_window("main") {
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                let _ = window.close();
            });
        }
    }
    Ok(())
}

fn argument(name: &str) -> Option<String> {
    let args: Vec<_> = std::env::args().collect();
    args.windows(2).find(|a| a[0] == name).map(|a| a[1].clone())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn show_licenses(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("licenses") {
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        let _ = tauri::WebviewWindowBuilder::new(
            app,
            "licenses",
            tauri::WebviewUrl::App("licenses.html".into()),
        )
        .title("XwX Deck 开源许可证")
        .inner_size(850.0, 650.0)
        .build();
    }
}

fn main() {
    if let Some(url) = argument("--subscription-url") {
        let Some(path) = std::env::var_os("XWX_AUTH_URL_FILE").map(PathBuf::from) else {
            std::process::exit(1);
        };
        let valid = path.file_name().is_some_and(|name| name == "opened-url")
            && path
                .components()
                .any(|part| part.as_os_str() == "claude-subscription-homes")
            && reqwest::Url::parse(&url).is_ok_and(|url| {
                url.scheme() == "https"
                    || url.scheme() == "http" && url.host_str() == Some("127.0.0.1")
            });
        if !valid {
            std::process::exit(1);
        }
        let result = (|| -> std::io::Result<()> {
            use std::io::Write;
            let mut options = std::fs::OpenOptions::new();
            options.create(true).truncate(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(path)?;
            file.write_all(url.as_bytes())?;
            file.sync_all()
        })();
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }
    #[cfg(target_os = "windows")]
    if let Some(code) = portable_update::worker() {
        std::process::exit(code);
    }
    if (option_env!("XWX_NATIVE_PILOT") == Some("1")
        || std::env::args().any(|a| a == "--smoke" || a == "--rpc"))
        && argument("--pilot-root").is_none()
    {
        eprintln!("Verification requires --pilot-root.");
        std::process::exit(2);
    }
    let root = argument("--pilot-root")
        .or_else(|| argument("--data-root"))
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
                    .join("Library/Application Support/xwx-deck")
            } else if cfg!(target_os = "windows") {
                PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("xwx-deck")
            } else {
                PathBuf::from(std::env::var_os("XDG_CONFIG_HOME").unwrap_or_else(|| {
                    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
                        .join(".config")
                        .into()
                }))
                .join("xwx-deck")
            }
        });
    let pilot = match Pilot::open(root) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    if std::env::args().any(|arg| arg == "--rpc") {
        for line in std::io::stdin().lock().lines() {
            let result = match line {
                Ok(line) => serde_json::from_str::<Value>(&line)
                    .map_err(|e| e.to_string())
                    .and_then(|request| {
                        tauri::async_runtime::block_on(async {
                            let mut pilot = pilot.lock().await;
                            pilot
                                .call(
                                    request["method"].as_str().unwrap_or(""),
                                    request["args"].as_array().map(Vec::as_slice).unwrap_or(&[]),
                                )
                                .await
                        })
                    }),
                Err(e) => Err(e.to_string()),
            };
            let response = match result {
                Ok(result) => json!({"ok":true,"result":result}),
                Err(error) => json!({"ok":false,"error":error}),
            };
            println!("{response}");
            let _ = std::io::stdout().flush();
        }
        let result = tauri::async_runtime::block_on(async {
            let mut p = pilot.lock().await;
            let result = p.stop().await;
            if result.is_ok() {
                p.release_lock();
            }
            result
        });
        if let Err(e) = result {
            eprintln!("{e}");
            std::process::exit(1);
        }
        return;
    }
    let smoke = std::env::args().any(|arg| arg == "--smoke");
    let shared = pilot.clone();
    let builder=tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::Builder::new().app_name("XwX Deck").args(["--launch-hidden"]).build())
        .setup(|app| {
            use tauri::menu::{Menu,MenuItem};
            use tauri::tray::{TrayIconBuilder,TrayIconEvent,MouseButton,MouseButtonState};
            // Captures must refresh native counters even when WebKit throttles polling.
            let capture_shared=app.state::<Shared>().inner().clone();
            let capture_handle=app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let Ok(mut events)=capture_shared.lock().await.trace_events() else {return;};
                loop {
                    match events.recv().await {
                        Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {},
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                    while events.try_recv().is_ok() {}
                    let state=capture_shared.lock().await.state();
                    let _=capture_handle.emit("pilot-state",state);
                }
            });
            #[cfg(target_os="macos")]{
                use tauri::menu::{Submenu,PredefinedMenuItem};
                let quit=MenuItem::with_id(app,"native-quit","退出 XwX Deck",true,Some("Cmd+Q"))?;
                let licenses=MenuItem::with_id(app,"licenses","开源许可证",true,None::<&str>)?;
                let application=Submenu::with_items(app,"XwX Deck",true,&[&PredefinedMenuItem::about(app,Some("关于 XwX Deck"),None)?,&licenses,&quit])?;
                let edit=Submenu::with_items(app,"编辑",true,&[&PredefinedMenuItem::undo(app,None)?,&PredefinedMenuItem::redo(app,None)?,&PredefinedMenuItem::cut(app,None)?,&PredefinedMenuItem::copy(app,None)?,&PredefinedMenuItem::paste(app,None)?,&PredefinedMenuItem::select_all(app,None)?])?;
                let window=Submenu::with_items(app,"窗口",true,&[&PredefinedMenuItem::minimize(app,None)?,&PredefinedMenuItem::maximize(app,None)?,&PredefinedMenuItem::fullscreen(app,None)?])?;
                app.set_menu(Menu::with_items(app,&[&application,&edit,&window])?)?;
            }
            let show=MenuItem::with_id(app,"show","打开 XwX Deck",true,None::<&str>)?;
            let quit=MenuItem::with_id(app,"quit","退出 XwX Deck",true,None::<&str>)?;
            let licenses=MenuItem::with_id(app,"licenses","开源许可证",true,None::<&str>)?;
            let menu=Menu::with_items(app,&[&show,&licenses,&quit])?;
            let mut rgba=vec![0u8;24*24*4];for y in 0..24{for x in 0..24{let d=(x as i32-12).pow(2)+(y as i32-12).pow(2);if (25..=100).contains(&d){let i=(y*24+x)*4;rgba[i..i+4].copy_from_slice(&[100,90,190,255]);}}}
            TrayIconBuilder::with_id("xwx-deck").icon(tauri::image::Image::new_owned(rgba,24,24)).tooltip("XwX Deck").menu(&menu).show_menu_on_left_click(false)
              .on_menu_event(|app,event|{match event.id.as_ref(){"show"=>show_main(app),"licenses"=>show_licenses(app),"quit"=>app.exit(0),_=>{}}})
              .on_tray_icon_event(|tray,event|{if matches!(event,TrayIconEvent::Click{button:MouseButton::Left,button_state:MouseButtonState::Up,..}){show_main(tray.app_handle());}}).build(app)?;
            if !std::env::args().any(|a|a=="--pilot-root"){
                let shared=app.state::<Shared>().inner().clone();let handle=app.handle().clone();
                tauri::async_runtime::spawn(async move{
                    let resumed={shared.lock().await.call("resumeTracing",&[]).await};
                    match resumed {
                        Ok(state)=>{let _=handle.emit("pilot-state",state);},
                        Err(error)=>{let mut state=shared.lock().await.state();state["lastError"]=json!(error);let _=handle.emit("pilot-state",state);}
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(6000)).await;
                    if let Ok(state)=shared.lock().await.call("checkForAutomaticUpdates",&[]).await{let _=handle.emit("pilot-update",state);}
                    let mut previous_update=Value::Null;
                    loop{
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        let state=shared.lock().await.update_state();if state!=previous_update{let _=handle.emit("pilot-update",&state);previous_update=state.clone();}
                        #[cfg(target_os="macos")]if state["status"]=="available"{let _=shared.lock().await.call("downloadAutomaticUpdate",&[]).await;}
                        #[cfg(target_os="windows")]if portable_update::idle_for_nightly(){
                            let mut p=shared.lock().await;if !p.active()&&p.nightly_eligible(){
                                if state["status"]=="available"{let _=p.call("downloadAutomaticUpdate",&[]).await;}
                                if state["status"]=="ready"{if let Ok(installer)=p.call("restartAndInstall",&[]).await{if let Some(path)=installer["path"].as_str(){if portable_update::spawn(std::path::Path::new(path)).is_ok(){handle.exit(0);}}}}
                            }
                        }
                    }
                });
            }
            Ok(())
        })
        .on_menu_event(|app,event|{if std::env::args().any(|a|a=="--smoke"){eprintln!("native-menu {}",event.id.as_ref());}if event.id.as_ref()=="native-quit"{app.exit(0);}else if event.id.as_ref()=="licenses"{show_licenses(app);}})
        .manage(pilot.clone())
        .invoke_handler(tauri::generate_handler![pilot_rpc,pilot_smoke_report])
        .on_page_load(move |window,payload| {
            if smoke && payload.event()==tauri::webview::PageLoadEvent::Finished {
                match window.label() {
                    "main" => { let _=window.show(); let _=window.set_focus(); let script=if std::env::args().any(|arg|arg=="--smoke-routing"){include_str!("../../tools/native/subscription-routing-smoke.js")}else if std::env::args().any(|arg|arg=="--smoke-universal"){include_str!("../../tools/native/universal-native-smoke.js")}else{include_str!("../../tools/native/native-smoke.js")};let _=window.eval(script); }
                    _ => {}
                }
            }
        })
        .on_window_event(move |window,event| {
            if let tauri::WindowEvent::CloseRequested{api,..}=event {
                if tauri::async_runtime::block_on(async{shared.lock().await.active()}) {api.prevent_close();let _=window.hide();}
            }
            if let tauri::WindowEvent::Resized(_)=event {
                let _=window.emit("pilot-window",json!({"maximized":window.is_maximized().unwrap_or(false),"fullscreen":window.is_fullscreen().unwrap_or(false),"nativeFrame":cfg!(target_os="macos")}));
            }
        });
    let mut context = tauri::generate_context!();
    if smoke {
        // Fixture roots must not inherit onboarding or other browser state from
        // an existing desktop session that shares the same test app identity.
        context.config_mut().app.windows[0].incognito = true;
        context.config_mut().app.windows[0].url =
            tauri::WebviewUrl::App("index.html?tour=1".into());
    }
    if std::env::args().any(|a| a == "--launch-hidden") {
        context.config_mut().app.windows[0].visible = false;
    }
    let app = builder
        .build(context)
        .expect("failed to build XwX Deck native host");
    app.run(move |handle, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            if std::env::args().any(|a| a == "--smoke") {
                eprintln!("native-exit-requested");
            }
            if tauri::async_runtime::block_on(async { pilot.lock().await.active() }) {
                api.prevent_exit();
                {
                    let shared = pilot.clone();
                    let handle = handle.clone();
                    show_main(&handle);
                    let dialog = handle
                        .dialog()
                        .message("退出前将停止 Trace 并恢复客户端直连；尚未完成的请求可能中断。")
                        .title("退出 XwX Deck")
                        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                            "恢复直连并退出".into(),
                            "继续运行".into(),
                        ));
                    let dialog = if let Some(window) = handle.get_webview_window("main") {
                        dialog.parent(&window)
                    } else {
                        dialog
                    };
                    dialog.show(move |accepted| {
                        if std::env::args().any(|a| a == "--smoke") {
                            eprintln!("native-exit-confirmed {accepted}");
                        }
                        if accepted {
                            tauri::async_runtime::spawn(async move {
                                let result = shared.lock().await.stop().await;
                                if let Err(error) = result {
                                    handle
                                        .dialog()
                                        .message(error)
                                        .title("配置恢复未完成，Gateway 继续运行")
                                        .show(|_| {});
                                } else {
                                    handle.exit(0);
                                }
                            });
                        }
                    });
                }
            }
        }
        tauri::RunEvent::Exit => {
            tauri::async_runtime::block_on(async {
                pilot.lock().await.release_lock();
            });
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    });
}
