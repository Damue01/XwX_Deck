#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
mod core;
mod edition;
mod embedded_assets;
mod embedded_fonts;
mod isolated_webview;
mod language;
#[cfg(target_os = "macos")]
mod macos_update;
mod portable_update;
mod renderer_preferences;
#[cfg(target_os = "macos")]
mod webcrypto_store;
mod webview_cache;
#[cfg(target_os = "windows")]
mod windows_menus;
#[cfg(target_os = "windows")]
mod windows_recovery;
#[cfg(target_os = "windows")]
mod windows_reveal;
#[cfg(target_os = "windows")]
mod windows_setup;
#[cfg(target_os = "windows")]
mod windows_tray;
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

#[cfg(target_os = "macos")]
async fn install_macos_update(
    app: &tauri::AppHandle,
    pilot: Shared,
    result: Value,
    unattended: bool,
) -> Result<(), String> {
    let updates = pilot.lock().await.updates_context();
    let _lease = updates.claim_install()?;
    let root = pilot.lock().await.root.clone();
    let path = PathBuf::from(result["path"].as_str().ok_or("无效安装包")?);
    let version = result["targetVersion"]
        .as_str()
        .ok_or("无效更新版本")?
        .to_owned();
    let job =
        tauri::async_runtime::spawn_blocking(move || macos_update::prepare(&path, &version, &root))
            .await
            .map_err(|e| e.to_string())??;
    let mut state = pilot.lock().await;
    // User input, opt-out or a newly started Trace during staging defers unattended installation.
    if unattended
        && (state.active() || !state.nightly_eligible() || !macos_update::idle_for_nightly())
    {
        macos_update::discard(job);
        return Err("自动更新已延后，当前应用继续可用".into());
    }
    if let Err(error) = state.stop().await {
        macos_update::discard(job);
        return Err(error);
    }
    // Recheck control after staging and safe shutdown, before handing off.
    if let Err(error) = state.call("restartAndInstall", &[]).await {
        macos_update::discard(job);
        return Err(error);
    }
    macos_update::launch(job)?;
    drop(state);
    app.exit(0);
    Ok(())
}

#[cfg(target_os = "windows")]
fn spawn_windows_update(path: &std::path::Path, state: &Value) -> Result<(), String> {
    if path
        .file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.ends_with("-setup.exe"))
    {
        windows_setup::spawn(
            path,
            state["sha256"].as_str().ok_or("缺少 Setup 校验值")?,
            state["targetVersion"].as_str().ok_or("缺少 Setup 版本")?,
        )
    } else if windows_setup::is_registered() {
        Err("安装版必须通过 Setup 更新，不能替换为便携版文件".into())
    } else {
        portable_update::spawn(path)
    }
}

// Menu IDs carry a direction: a stale Stop click must never start Trace.
fn request_trace_from_tray(app: &tauri::AppHandle, enabled: bool) {
    show_main(app);
    let _ = app.emit("pilot-trace-action", enabled);
}

fn sync_trace_tray(app: &tauri::AppHandle, state: &Value, pending: bool) {
    #[cfg(target_os = "windows")]
    windows_tray::sync(app, state, pending);
    #[cfg(not(target_os = "windows"))]
    {
        use tauri::menu::{Menu, MenuItem};
        static LAST_STATE: std::sync::Mutex<Option<(bool, bool)>> = std::sync::Mutex::new(None);
        let Some(tray) = app.tray_by_id("xwx-deck") else {
            return;
        };
        let enabled = state["tracingEnabled"].as_bool().unwrap_or(false);
        let busy = pending || state["traceTransition"].as_str().is_some();
        let Ok(mut last) = LAST_STATE.lock() else {
            return;
        };
        if *last == Some((enabled, busy)) {
            return;
        }
        let result = (|| -> tauri::Result<()> {
            let show = MenuItem::with_id(app, "show", "打开 XwX Deck", true, None::<&str>)?;
            let trace = MenuItem::with_id(
                app,
                if enabled { "trace-stop" } else { "trace-start" },
                if enabled {
                    "关闭 Trace"
                } else {
                    "开启 Trace"
                },
                !busy,
                None::<&str>,
            )?;
            let licenses = MenuItem::with_id(app, "licenses", "开源许可证", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 XwX Deck", !busy, None::<&str>)?;
            tray.set_menu(Some(Menu::with_items(
                app,
                &[&show, &trace, &licenses, &quit],
            )?))?;
            Ok(())
        })();
        if result.is_ok() {
            *last = Some((enabled, busy));
        }
    }
}

#[tauri::command]
async fn pilot_tray(
    app: tauri::AppHandle,
    caller: tauri::WebviewWindow,
    pilot: tauri::State<'_, Shared>,
    action: String,
    enabled: Option<bool>,
    report: Option<Value>,
) -> Result<Value, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, caller, pilot, action, enabled, report);
        Err("此平台不使用 Windows 托盘菜单".into())
    }
    #[cfg(target_os = "windows")]
    {
        if caller.label() != windows_tray::LABEL {
            return Err("托盘操作只允许在托盘菜单发起".into());
        }
        let _rpc = core::admit_rpc("trayAction")?;
        if action == "smoke-report"
            && argument("--pilot-root").is_some()
            && std::env::args().any(|arg| arg == "--smoke")
        {
            let bytes = serde_json::to_vec(&report.ok_or("缺少托盘验证报告")?)
                .map_err(|e| e.to_string())?;
            if bytes.len() > 16 * 1024 {
                return Err("托盘验证报告过大".into());
            }
            std::fs::write(pilot.lock().await.root.join("tray-smoke.json"), bytes)
                .map_err(|e| e.to_string())?;
            return Ok(Value::Null);
        }
        let state = pilot.lock().await.state();
        let snapshot = windows_tray::snapshot(&state, false);
        match action.as_str() {
            "state" => Ok(snapshot),
            "ready" => {
                windows_tray::ready(&app)?;
                Ok(Value::Null)
            }
            "hide" => {
                windows_tray::hide(&app);
                Ok(Value::Null)
            }
            "trace" | "exit" => {
                if snapshot["busy"] == true {
                    return Ok(snapshot);
                }
                let requested = if action == "trace" {
                    Some(enabled.ok_or("缺少 Trace 目标状态")?)
                } else {
                    None
                };
                windows_tray::hide(&app);
                if let Some(requested) = requested {
                    if snapshot["enabled"] != requested {
                        sync_trace_tray(&app, &state, true);
                        request_trace_from_tray(&app, requested);
                    }
                } else {
                    app.exit(0);
                }
                Ok(Value::Null)
            }
            _ => Err("无效托盘操作".into()),
        }
    }
}

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
    let _rpc = core::admit_rpc(&method)?;
    let window = app.get_webview_window("main").ok_or("主窗口不存在")?;
    if let Some(result) = edition::rpc(&app, pilot.inner(), &method, &args).await {
        return result;
    }
    match method.as_str() {
        "inspectStorageMigration" => pilot.lock().await.inspect_storage_migration(),
        "migrateStorage" => {
            let resume = {
                let mut state = pilot.lock().await;
                let active = state.active();
                let snapshot = state.state();
                if snapshot["activeRequests"].as_u64().unwrap_or(0) > 0 || snapshot["waitingTools"].as_u64().unwrap_or(0) > 0 {
                    return Err("当前对话仍在运行，请等待本轮完成后重试数据迁移".into());
                }
                state.stop().await?;
                active
            };
            let shared = pilot.inner().clone();
            let handle = app.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                let mut last = std::time::Instant::now();
                shared.blocking_lock().migrate_storage(|progress| {
                    if progress["phase"] == "complete" || last.elapsed().as_millis() >= 100 {
                        last = std::time::Instant::now();
                        let _ = handle.emit("xwxdeck-storage-migration-progress", progress);
                    }
                })
            }).await.map_err(|e| e.to_string())?;
            let resumed = if resume { pilot.lock().await.call("resumeTracing", &[]).await }
                else { Ok(pilot.lock().await.state()) };
            let migrated = result?;
            let mut state = resumed?;
            state["storageMigrationResult"] = migrated["storageMigrationResult"].clone();
            Ok(state)
        }
        "detectClientInstallations" => {
            let job = pilot.lock().await.client_installations_job();
            tauri::async_runtime::spawn_blocking(job).await.map_err(|e| e.to_string())?
        }
        #[cfg(target_os = "macos")]
        "migrateWebCryptoKey" => {
            let root = pilot.lock().await.root.clone();
            let isolated = argument("--pilot-root").is_some();
            app.state::<webcrypto_store::Store>()
                .migrate(&app, &root, isolated)?;
            let mut state = pilot.lock().await.state();
            state["webCryptoStorage"] = app.state::<webcrypto_store::Store>().status();
            Ok(state)
        }
        "validateProvider" => {
            let job = pilot
                .lock()
                .await
                .validation_job(args.first().unwrap_or(&Value::Null))?;
            Pilot::execute_validation(job).await
        }

        "refreshMetadata" => {
            let metadata = pilot.lock().await.metadata_context();
            metadata
                .refresh(
                    pilot.inner().clone(),
                    args.first().cloned().unwrap_or(
                        json!({"topics":["models","capabilities","pricing"],"reason":"manual"}),
                    ),
                )
                .await
        }

        "fetchProviderModels" | "fetchModels" => {
            let job = pilot.lock().await.catalog_job(&method, &args)?;
            if let Some(job) = job {
                let entries = job.execute().await?;
                pilot.lock().await.finish_catalog(&job, entries)
            } else {
                pilot.lock().await.call(&method, &args).await
            }
        }

        "smokeResizeWindow" if std::env::args().any(|arg| arg == "--smoke") => {
            let input = args.first().ok_or("缺少测试窗口尺寸")?;
            let width = input["width"].as_f64().ok_or("缺少宽度")?;
            let height = input["height"].as_f64().ok_or("缺少高度")?;
            app.get_webview_window("main")
                .ok_or("窗口不存在")?
                .set_size(tauri::LogicalSize::new(width, height))
                .map_err(|_| "无法调整测试窗口")?;
            Ok(Value::Null)
        }

        "smokeManagerWindow" if std::env::args().any(|arg| arg == "--smoke") => {
            let main = app.get_webview_window("main").ok_or("主窗口不存在")?;
            match args.first().and_then(Value::as_str) {
                Some("show") => show_main(&app),
                Some("close") => main.close().map_err(|e| e.to_string())?,
                _ => {}
            }
            Ok(json!({"visible":main.is_visible().unwrap_or(false)}))
        }
        "getOfficialChatgptResetCredits" => {
            let accounts = pilot.lock().await.subscription_context();
            accounts
                .official_credits(args.first().and_then(|v| v.as_str()).unwrap_or(""))
                .await
        }
        "consumeOfficialChatgptResetCredit" => {
            let accounts = pilot.lock().await.subscription_context();
            accounts
                .consume_official_credit(args.first().unwrap_or(&Value::Null))
                .await
        }
        "getOfficialChatgptAccount" => {
            let job = pilot.lock().await.official_chatgpt_job();
            if args.first().is_some_and(|input| input["refresh"] == false) {
                job.cached()
            } else {
                job.execute().await
            }
        }
        "getSubscriptionAccounts" => {
            let accounts = pilot.lock().await.subscription_context();
            Ok(accounts.snapshot().await)
        }
        "refreshSubscriptionUsage" => {
            let accounts = pilot.lock().await.subscription_context();
            accounts
                .refresh_usage(
                    args.first()
                        .and_then(|v| v["platform"].as_str())
                        .unwrap_or(""),
                )
                .await?;
            Ok(accounts.snapshot().await)
        }
        "signOutSubscriptionAccount" => {
            if core::is_imported_subscription(args.first().and_then(Value::as_str).unwrap_or("")) {
                return pilot.lock().await.call(&method, &args).await;
            }
            let accounts = pilot.lock().await.subscription_context();
            accounts
                .sign_out_input(args.first().unwrap_or(&Value::Null))
                .await
        }
        "cancelSubscriptionSignIn" => {
            let accounts = pilot.lock().await.subscription_context();
            Ok(accounts.cancel().await)
        }
        "beginSubscriptionSignIn" => {
            let accounts = pilot.lock().await.subscription_context();
            let input = args.first().cloned().unwrap_or(Value::Null);
            let result = accounts
                .begin_for(
                    input["platform"].as_str().unwrap_or(""),
                    input["accountId"].as_str().unwrap_or(""),
                )
                .await?;
            let url = accounts.authorization_url().await?;
            if app.opener().open_url(url, None::<String>).is_err() {
                accounts.cancel().await;
                return Err("无法打开系统浏览器，请重试".into());
            }
            Ok(result)
        }
        "smokeTrayAction" => {
            if !std::env::args().any(|arg| arg == "--smoke") {
                return Err("仅允许隔离验证".into());
            }
            let enabled = args.first().and_then(Value::as_bool).ok_or("无效开关")?;
            request_trace_from_tray(&app, enabled);
            Ok(Value::Null)
        }
        #[cfg(target_os = "windows")]
        "smokeTrayWindow"
            if argument("--pilot-root").is_some()
                && std::env::args().any(|arg| arg == "--smoke") =>
        {
            let action = args.first().and_then(Value::as_str).unwrap_or("");
            if action == "open" {
                let monitor = window
                    .current_monitor()
                    .map_err(|e| e.to_string())?
                    .ok_or("显示器不可用")?;
                let area = monitor.work_area();
                let point = tauri::PhysicalPosition::new(
                    f64::from(area.position.x)
                        + f64::from(area.size.width) / 2.0
                        + 106.0 * monitor.scale_factor(),
                    f64::from(area.position.y)
                        + f64::from(area.size.height) / 2.0
                        + 50.0 * monitor.scale_factor(),
                );
                let state = pilot.lock().await.state();
                windows_tray::show(&app, point, &state)?;
            }
            let Some(tray) = app.get_webview_window(windows_tray::LABEL) else {
                return Ok(Value::Null);
            };
            match action {
                "inspect" => {
                    let path = pilot.lock().await.root.join("tray-smoke.json");
                    let _ = std::fs::remove_file(path);
                    tray.eval(include_str!("../../tools/native/tray-popup-smoke.js")).map_err(|e|e.to_string())?;
                },
                "click-trace" => tray.eval("document.querySelectorAll('[role=menuitem]')[0].click()").map_err(|e|e.to_string())?,
                "click-exit" => tray.eval("document.querySelectorAll('[role=menuitem]')[1].click()").map_err(|e|e.to_string())?,
                "down" => tray.eval("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))").map_err(|e|e.to_string())?,
                "escape" => tray.eval("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))").map_err(|e|e.to_string())?,
                "stale-stop" => tray.eval("window.__TAURI__.core.invoke('pilot_tray',{action:'trace',enabled:false})").map_err(|e|e.to_string())?,
                "deny" => {
                    let path = pilot.lock().await.root.join("tray-smoke.json");let _=std::fs::remove_file(path);
                    tray.eval("window.__TAURI__.core.invoke('pilot_rpc',{method:'getProviders',args:[]}).then(()=>false,()=>true).then(denied=>window.__TAURI__.core.invoke('pilot_tray',{action:'smoke-report',report:{denied}}))").map_err(|e|e.to_string())?;
                },
                "blur" => show_main(&app),
                "hide" => windows_tray::hide(&app),
                _=>{}
            }
            let scale = tray.scale_factor().map_err(|e| e.to_string())?;
            let size = tray
                .inner_size()
                .map_err(|e| e.to_string())?
                .to_logical::<f64>(scale);
            Ok(
                json!({"visible":tray.is_visible().unwrap_or(false),"width":size.width,"height":size.height,"scale":scale}),
            )
        }
        #[cfg(target_os = "windows")]
        "smokeTrayReport"
            if argument("--pilot-root").is_some()
                && std::env::args().any(|arg| arg == "--smoke") =>
        {
            let path = pilot.lock().await.root.join("tray-smoke.json");
            if !path.exists() {
                return Ok(Value::Null);
            }
            serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())
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
            #[cfg(target_os = "macos")]
            {
                state["webCryptoStorage"] = app.state::<webcrypto_store::Store>().status();
            }
            sync_trace_tray(&app, &state, false);
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
            edition::manager_ready(&app);
            Ok(state)
        }
        "getWindowState" => Ok(
            json!({"nativeFrame":cfg!(target_os="macos"),"maximized":window.is_maximized().unwrap_or(false),"fullscreen":window.is_fullscreen().unwrap_or(false)}),
        ),
        "checkForUpdates" | "downloadUpdate" | "cancelUpdate" => {
            let updates = pilot.lock().await.updates_context();
            let result = match method.as_str() {
                "checkForUpdates" => updates.check().await?,
                "downloadUpdate" => updates.download()?,
                _ => updates.cancel()?,
            };
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
                if result["installMode"] == "automatic" {
                    install_macos_update(&app, pilot.inner().clone(), result.clone(), false)
                        .await?;
                } else {
                    core::finish_manual_update(
                        || {
                            app.opener()
                                .open_path(path, None::<&str>)
                                .map_err(|e| e.to_string())
                        },
                        || app.exit(0),
                    )?;
                }
                Ok(Value::Null)
            }
            #[cfg(target_os = "windows")]
            {
                spawn_windows_update(std::path::Path::new(path), &result)?;
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
            webview_cache::clear(&window).await?;
            let metadata = pilot.lock().await.metadata_context();
            let mut result = metadata.repair(pilot.inner().clone()).await?;
            result["chromiumCacheCleared"] = json!(true);
            let _ = app.emit("pilot-state", pilot.lock().await.state());
            Ok(result)
        }
        "resetApplication" => {
            let reset_clients = args
                .first()
                .and_then(|value| value["resetClientConfigs"].as_bool())
                .ok_or("无效重置选项")?;
            // Acquire metadata before Pilot: refresh uses the same order. This
            // drains a current writer without deadlocking its final state save.
            let metadata = pilot.lock().await.metadata_context();
            let _paused = metadata.pause().await;
            let root = pilot.lock().await.data_root();
            let mut job = pilot.lock().await.prepare_reset(reset_clients).await?;
            job.clear_browser_stores = true;
            if argument("--pilot-root").is_none() {
                app.autolaunch()
                    .disable()
                    .map_err(|_| "无法取消开机启动，重置尚未执行")?;
            }
            edition::clear_stores(&app, &root).await?;
            webview_cache::clear_all(&window).await?;
            let result = pilot.lock().await.launch_reset(job).await?;
            metadata.shutdown();
            app.exit(0);
            Ok(result)
        }
        "smokeWindowThemes" if std::env::args().any(|arg| arg == "--smoke") => {
            let mut themes = serde_json::Map::new();
            for (label, window) in app.webview_windows() {
                let theme = window.theme().map_err(|e| e.to_string())?;
                themes.insert(
                    label,
                    json!(if theme == tauri::Theme::Dark {
                        "night"
                    } else {
                        "day"
                    }),
                );
            }
            Ok(Value::Object(themes))
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
        "smokeDashboardWindow" if std::env::args().any(|arg| arg == "--smoke") => {
            let Some(viewer) = app.get_webview_window("dashboard") else {
                return Ok(Value::Null);
            };
            match args.first().and_then(Value::as_str) {
                Some("fullscreen") => viewer.set_fullscreen(true).map_err(|e| e.to_string())?,
                Some("close") => {
                    viewer.close().map_err(|e| e.to_string())?;
                    return Ok(Value::Null);
                }
                Some("minimize") => viewer.minimize().map_err(|e| e.to_string())?,
                _ => {}
            }
            let scale = viewer.scale_factor().map_err(|e| e.to_string())?;
            let size = viewer
                .inner_size()
                .map_err(|e| e.to_string())?
                .to_logical::<f64>(scale);
            Ok(
                json!({"width":size.width,"height":size.height,"scale":scale,
                "visible":viewer.is_visible().unwrap_or(false),
                "minimized":viewer.is_minimized().unwrap_or(false),
                "fullscreen":viewer.is_fullscreen().unwrap_or(false)}),
            )
        }
        "smokeCloseWindow" if std::env::args().any(|arg| arg == "--smoke") => {
            window.close().map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "smokeNotice" if std::env::args().any(|arg| arg == "--smoke") => {
            let notice = args.first().ok_or("缺少测试通知")?;
            app.emit("pilot-notice", notice)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "smokeSetupContext"
            if argument("--pilot-root").is_some()
                && std::env::args().any(|arg| arg == "--smoke") =>
        {
            Ok(json!({"update":std::env::args().any(|arg|arg=="--smoke-setup-update")}))
        }
        "smokeClientRequest"
            if argument("--pilot-root").is_some()
                && std::env::args().any(|arg| arg == "--smoke-provider-switch")
                && std::env::args().any(|arg| arg == "--smoke") =>
        {
            let client = args
                .first()
                .and_then(Value::as_str)
                .ok_or("缺少测试客户端")?;
            let expected = args.get(1).and_then(Value::as_str).ok_or("缺少测试服务")?;
            if !matches!(client, "codex" | "claude") || !matches!(expected, "a" | "b") {
                return Err("无效的本地客户端测试".into());
            }
            let base = argument("--smoke-upstream").ok_or("缺少本地测试服务")?;
            let url = reqwest::Url::parse(&base).map_err(|error| error.to_string())?;
            if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
                return Err("客户端验收只允许本地服务".into());
            }
            reqwest::Client::new()
                .post(format!("{base}/control/run/{client}/{expected}"))
                .timeout(std::time::Duration::from_secs(60))
                .send()
                .await
                .map_err(|error| error.to_string())?
                .error_for_status()
                .map_err(|error| error.to_string())?
                .json::<Value>()
                .await
                .map_err(|error| error.to_string())
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
            Ok(
                json!({"upstream":base,"physical":std::env::args().any(|arg|arg=="--smoke-physical"),"nativeOfficial":std::env::args().any(|arg|arg=="--smoke-native-official")}),
            )
        }
        "smokeExternalClientConflict" if std::env::args().any(|arg| arg == "--smoke") => {
            pilot.lock().await.smoke_external_client_conflict()
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
            let generic = args
                .first()
                .and_then(|v| v.get("client"))
                .and_then(Value::as_str);
            let (path, mut payload) = if let Some(client) = generic {
                if client != "opencode" {
                    return Err("无效隔离测试客户端".into());
                }
                (
                    format!("/clients/{client}/v1/chat/completions"),
                    json!({"model":"gpt-4.1","messages":[{"role":"user","content":"isolated native WebKit smoke"}],"stream":true}),
                )
            } else {
                (
                    "/v1/responses".into(),
                    json!({"model":"pilot-model","input":"isolated native WebKit smoke","stream":true}),
                )
            };
            if args.first().is_some_and(|v| v["hold"] == true) {
                payload["input"] = json!("isolated native held smoke");
            }
            if args
                .first()
                .is_some_and(|v| v["tool"] == true || v["toolResult"] == true)
            {
                let mut input = vec![json!({"role":"user","content":"isolated WebKit tool turn"})];
                if args.first().is_some_and(|v| v["toolResult"] == true) {
                    input.push(json!({"type":"function_call","call_id":"webview-tool-call","name":"lookup","arguments":"{}"}));
                    input.push(json!({"type":"function_call_output","call_id":"webview-tool-call","output":"isolated read-only result"}));
                }
                payload["input"] = json!(input);
            }
            let response = reqwest::Client::new()
                .post(format!("{base}{path}"))
                .json(&payload)
                .send()
                .await
                .map_err(|e| e.to_string())?;
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
            drop(p);
            #[cfg(target_os = "windows")]
            windows_reveal::open_folder(&path)?;
            #[cfg(not(target_os = "windows"))]
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
            let title = if args.first().is_some_and(|input| input["kind"] == "client") {
                "选择客户端安装位置"
            } else {
                "选择目录"
            };
            let path = app
                .dialog()
                .file()
                .set_title(title)
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
                });
                command.stdin(Stdio::piped());
                #[cfg(target_os = "windows")]
                {
                    use std::os::windows::process::CommandExt;
                    command.creation_flags(0x08000000);
                }
                let mut child = command.spawn().map_err(|e| e.to_string())?;
                let value = args.first().and_then(Value::as_str).unwrap_or("");
                #[cfg(target_os = "windows")]
                let encoded: Vec<u8> = [0xfeffu16]
                    .into_iter()
                    .chain(value.encode_utf16())
                    .flat_map(u16::to_le_bytes)
                    .collect();
                #[cfg(target_os = "windows")]
                let bytes = encoded.as_slice();
                #[cfg(target_os = "macos")]
                let bytes = value.as_bytes();
                child
                    .stdin
                    .take()
                    .ok_or("无法写入剪贴板")?
                    .write_all(bytes)
                    .map_err(|e| e.to_string())?;
                if !child.wait().map_err(|e| e.to_string())?.success() {
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
            let manifest: Value = serde_json::from_str(embedded_assets::setup_websites()?)
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
            let mut state = pilot.lock().await;
            let theme = window_theme(state.state()["theme"].as_str().unwrap_or("day"));
            let url = state.dashboard_url().await?;
            drop(state);
            if let Some(existing) = app.get_webview_window("dashboard") {
                existing.unminimize().map_err(|e| e.to_string())?;
                existing.show().map_err(|e| e.to_string())?;
                existing.set_focus().map_err(|e| e.to_string())?;
            } else {
                // Work-area coordinates are physical; window bounds are logical.
                // Keep a readable initial size on Retina and smaller displays.
                let monitor = window.current_monitor().map_err(|e| e.to_string())?;
                let (width, height, position) = if let Some(monitor) = monitor {
                    let scale = monitor.scale_factor();
                    let area = monitor.work_area();
                    let width =
                        1280.0_f64.min((f64::from(area.size.width) / scale - 48.0).max(1.0));
                    let height =
                        820.0_f64.min((f64::from(area.size.height) / scale - 72.0).max(1.0));
                    (
                        width,
                        height,
                        Some((
                            f64::from(area.position.x) / scale
                                + (f64::from(area.size.width) / scale - width) / 2.0,
                            f64::from(area.position.y) / scale
                                + (f64::from(area.size.height) / scale - height) / 2.0,
                        )),
                    )
                } else {
                    (1280.0, 820.0, None)
                };
                let builder = tauri::WebviewWindowBuilder::new(
                    &app,
                    "dashboard",
                    tauri::WebviewUrl::External(
                        reqwest::Url::parse(&url).map_err(|e| e.to_string())?,
                    ),
                )
                .theme(theme)
                .title("XwX Deck Trace")
                .inner_size(width, height)
                .min_inner_size(900.0_f64.min(width), 600.0_f64.min(height));
                let builder = if let Some((x, y)) = position {
                    builder.position(x, y)
                } else {
                    builder.center()
                };
                #[cfg(target_os = "windows")]
                let builder = if let Some(root) = argument("--pilot-root") {
                    builder
                        .incognito(true)
                        .data_directory(isolated_webview::directory(
                            &PathBuf::from(root),
                            "viewer-webview",
                        )?)
                } else {
                    builder
                };
                builder.build().map_err(|e| e.to_string())?;
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
            if window.label() == "main" {
                window.hide().map_err(|e| e.to_string())?;
                return Ok(Value::Null);
            }
            if pilot.lock().await.active() {
                window.hide().map_err(|e| e.to_string())?;
            } else {
                window.close().map_err(|e| e.to_string())?;
            }
            Ok(Value::Null)
        }
        "smokeRequestExit" if std::env::args().any(|arg| arg == "--smoke") => {
            app.exit(0);
            Ok(Value::Null)
        }
        "confirmApplicationExit" => {
            pilot.lock().await.stop().await?;
            app.exit(0);
            Ok(Value::Null)
        }
        "acknowledgeApplicationResetResult" => {
            let result = pilot
                .lock()
                .await
                .call("getApplicationResetResult", &[])
                .await?;
            if result.is_null() || result["atMs"] != args.first().cloned().unwrap_or(Value::Null) {
                return Err("重置记录已变化，请重新检查".into());
            }
            if args.get(1) == Some(&json!(true)) {
                let backup = result["backupPath"]
                    .as_str()
                    .map(PathBuf::from)
                    .filter(|p| p.is_absolute() && p.is_dir())
                    .ok_or("备份目录不可用")?;
                #[cfg(target_os = "windows")]
                windows_reveal::open_folder(&backup)?;
                #[cfg(not(target_os = "windows"))]
                app.opener()
                    .open_path(backup.to_string_lossy().into_owned(), None::<&str>)
                    .map_err(|e| e.to_string())?;
            }
            pilot
                .lock()
                .await
                .call(
                    "ackApplicationResetResult",
                    &[json!({"atMs":result["atMs"]})],
                )
                .await?;
            Ok(Value::Null)
        }
        _ => {
            let mut pilot = pilot.lock().await;
            if method == "toggleTracing" {
                sync_trace_tray(&app, &pilot.state(), true);
            }
            let result = pilot.call(&method, &args).await;
            sync_trace_tray(&app, &pilot.state(), false);
            let result = result?;
            if method == "setTheme" {
                sync_window_theme(&app, result["theme"].as_str().unwrap_or("day"))?;
            }
            if result.get("readiness").is_some() {
                let _ = app.emit("pilot-state", &result);
            }
            Ok(result)
        }
    }
}

#[tauri::command]
async fn pilot_smoke_progress(
    caller: tauri::WebviewWindow,
    pilot: tauri::State<'_, Shared>,
    checks: Vec<String>,
    pending: Option<String>,
) -> Result<(), String> {
    if caller.label() != "main"
        || !std::env::args().any(|arg| arg == "--smoke")
        || checks.len() > 300
        || checks.iter().any(|s| s.len() > 1024)
    {
        return Err("无效隔离验证进度".into());
    }
    let root = pilot.lock().await.data_root();
    std::fs::write(root.join("native-smoke-progress.json"),serde_json::to_vec(&json!({"checks":checks,"pending":pending.map(|s|s.chars().take(256).collect::<String>()),"passed":false})).map_err(|_|"验证进度序列化失败")?).map_err(|_|"验证进度保存失败".into())
}
#[tauri::command]
async fn pilot_smoke_report(
    app: tauri::AppHandle,
    caller: tauri::WebviewWindow,
    pilot: tauri::State<'_, Shared>,
    report: Value,
) -> Result<(), String> {
    if caller.label() != "main" || !std::env::args().any(|arg| arg == "--smoke") {
        return Err("仅隔离 smoke 启动可保存验证证据".into());
    }
    let pilot = pilot.lock().await;
    std::fs::write(
        pilot.root.join("native-smoke.json"),
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if std::env::args().any(|arg| arg == "--smoke-exit") && !pilot.active() {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            app.exit(0);
        });
    }
    Ok(())
}

async fn isolated_rpc(pilot: Shared, request: &Value) -> Result<Value, String> {
    let method = request["method"].as_str().unwrap_or("");
    let _rpc = core::admit_rpc(method)?;
    let args = request["args"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let input = args.first().cloned().unwrap_or(Value::Null);
    if let Some(result) = edition::isolated_rpc(&pilot, method, args).await {
        return result;
    }
    match method {
        "fetchProviderModels" | "fetchModels" => {
            let job = pilot.lock().await.catalog_job(method, args)?;
            if let Some(job) = job {
                let entries = job.execute().await?;
                pilot.lock().await.finish_catalog(&job, entries)
            } else {
                pilot.lock().await.call(method, args).await
            }
        }
        "repairApplication" => {
            let metadata = pilot.lock().await.metadata_context();
            metadata.repair(pilot.clone()).await
        }
        "getLegacyRendererPreferences" => {
            let (root, keys) = pilot.lock().await.renderer_preferences_context();
            let mut report = renderer_preferences::load(&root, &keys).await?;
            report["initializationScript"] =
                json!(renderer_preferences::initialization_script(&report));
            Ok(report)
        }
        "validateProvider" => {
            let job = pilot.lock().await.validation_job(&input)?;
            Pilot::execute_validation(job).await
        }
        "checkForUpdates" => {
            let updates = pilot.lock().await.updates_context();
            updates.check().await
        }
        "refreshSubscriptionUsage" => {
            let accounts = pilot.lock().await.subscription_context();
            accounts
                .refresh_usage(input["platform"].as_str().unwrap_or(""))
                .await?;
            Ok(accounts.snapshot().await)
        }
        "getOfficialChatgptResetCredits" => {
            let accounts = pilot.lock().await.subscription_context();
            accounts
                .official_credits(args.first().and_then(|v| v.as_str()).unwrap_or(""))
                .await
        }
        "consumeOfficialChatgptResetCredit" => {
            let accounts = pilot.lock().await.subscription_context();
            accounts
                .consume_official_credit(args.first().unwrap_or(&Value::Null))
                .await
        }
        "getOfficialChatgptAccount" => {
            let job = pilot.lock().await.official_chatgpt_job();
            if args.first().is_some_and(|input| input["refresh"] == false) {
                job.cached()
            } else {
                job.execute().await
            }
        }
        "getSubscriptionAccounts" => {
            let accounts = pilot.lock().await.subscription_context();
            Ok(accounts.snapshot().await)
        }
        "signOutSubscriptionAccount" => {
            let accounts = pilot.lock().await.subscription_context();
            if core::is_imported_subscription(input.as_str().unwrap_or("")) {
                pilot
                    .lock()
                    .await
                    .call("signOutSubscriptionAccount", &[input])
                    .await
            } else {
                accounts.sign_out_input(&input).await
            }
        }
        "cancelSubscriptionSignIn" => {
            let accounts = pilot.lock().await.subscription_context();
            Ok(accounts.cancel().await)
        }
        "beginSubscriptionSignIn" => {
            let accounts = pilot.lock().await.subscription_context();
            accounts
                .begin_for(
                    input["platform"].as_str().unwrap_or(""),
                    input["accountId"].as_str().unwrap_or(""),
                )
                .await
        }

        "refreshMetadata" => {
            let metadata = pilot.lock().await.metadata_context();
            metadata
                .refresh(
                    pilot.clone(),
                    args.first().cloned().unwrap_or(
                        json!({"topics":["models","capabilities","pricing"],"reason":"manual"}),
                    ),
                )
                .await
        }

        _ => pilot.lock().await.call(method, args).await,
    }
}

fn argument(name: &str) -> Option<String> {
    let args: Vec<_> = std::env::args().collect();
    args.windows(2).find(|a| a[0] == name).map(|a| a[1].clone())
}

fn window_theme(preference: &str) -> Option<tauri::Theme> {
    match preference {
        "night" => Some(tauri::Theme::Dark),
        "day" => Some(tauri::Theme::Light),
        _ => None,
    }
}

fn sync_window_theme(app: &tauri::AppHandle, preference: &str) -> Result<(), String> {
    for window in app.webview_windows().values() {
        window
            .set_theme(window_theme(preference))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
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
        let builder = tauri::WebviewWindowBuilder::new(
            app,
            "licenses",
            tauri::WebviewUrl::App("licenses.html".into()),
        )
        .title("XwX Deck 开源许可证")
        .inner_size(850.0, 650.0);
        #[cfg(target_os = "windows")]
        let builder = if let Some(root) = argument("--pilot-root") {
            match isolated_webview::directory(&PathBuf::from(root), "licenses-webview") {
                Ok(path) => builder.incognito(true).data_directory(path),
                Err(error) => {
                    eprintln!("{error}");
                    return;
                }
            }
        } else {
            builder
        };
        let _ = builder.build();
    }
}

fn show_startup_recovery(message: &str) {
    #[cfg(target_os = "windows")]
    windows_recovery::show(message);
    #[cfg(not(target_os = "windows"))]
    {
        // No Pilot is opened and no browser store is created while data recovery
        // is blocked. A Finder launch still gets an actionable native explanation.
        let mut context = tauri::generate_context!();
        for window in &mut context.config_mut().app.windows {
            window.create = false;
        }
        if let Ok(app) = tauri::Builder::default()
            .plugin(tauri_plugin_dialog::init())
            .build(context)
        {
            let message = message.to_owned();
            app.run(move |app, event| {
                if matches!(event, tauri::RunEvent::Ready) {
                    let handle = app.clone();
                    app.dialog()
                        .message(&message)
                        .title("XwX Deck 无法启动")
                        .show(move |_| handle.exit(2));
                }
            });
        }
    }
}

fn main() {
    if let Some(path) = argument("--application-reset-worker") {
        match core::reset_worker(std::path::Path::new(&path)) {
            Ok(()) => {}
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        }
        return;
    }
    if let Some(source) = argument("--legacy-renderer-worker") {
        match renderer_preferences::worker(
            std::path::Path::new(&source),
            &argument("--renderer-keys").unwrap_or_default(),
        ) {
            Ok(report) => println!("{report}"),
            Err(_) => {
                eprintln!("旧版界面偏好读取失败，原文件未改动");
                std::process::exit(2);
            }
        }
        return;
    }
    if let Some(mode) = argument("--credential-store-diagnostic") {
        let result = core::credential_store_diagnostic(
            &mode,
            &argument("--probe-id").unwrap_or_default(),
            &argument("--probe-challenge").unwrap_or_default(),
        );
        match result {
            Ok(report) => println!("{report}"),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        }
        return;
    }
    if std::env::args().any(|arg| arg == "--pilot-os-credentials")
        && argument("--pilot-root").is_none()
        && !(argument("--export-credential-backup").is_some()
            && std::env::args().any(|arg| arg == "--export-isolated-test"))
    {
        eprintln!("系统凭据验证需要显式 --pilot-root 隔离目录。");
        std::process::exit(2);
    }
    if let Some(root) = argument("--export-credential-backup") {
        let result = argument("--export-destination")
            .ok_or("缺少 --export-destination".to_string())
            .and_then(|destination| {
                core::export_credential_backup(
                    std::path::Path::new(&root),
                    std::path::Path::new(&destination),
                    std::env::args().any(|a| a == "--export-original"),
                    std::env::args().any(|a| a == "--export-isolated-test"),
                )
            });
        match result {
            Ok(report) => println!("{report}"),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        }
        return;
    }
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
    if let Some(code) = windows_setup::worker() {
        std::process::exit(code);
    }
    #[cfg(target_os = "windows")]
    if let Some(code) = portable_update::worker() {
        std::process::exit(code);
    }
    #[cfg(target_os = "macos")]
    if let Some(code) = macos_update::worker() {
        std::process::exit(code);
    }
    #[cfg(target_os = "macos")]
    if let Some(dmg) = argument("--verify-macos-update") {
        let result = (|| -> Result<(), String> {
            let root = PathBuf::from(argument("--pilot-root").ok_or("验证需要隔离目录")?);
            if !root.join(".xwx-rust-pilot").is_file() {
                return Err("验证需要已初始化的隔离目录".into());
            }
            let job = macos_update::prepare(
                std::path::Path::new(&dmg),
                &argument("--target-version").ok_or("缺少目标版本")?,
                &root,
            )?;
            macos_update::discard(job);
            Ok(())
        })();
        println!(
            "{}",
            json!({"verified":result.is_ok(),"error":result.as_ref().err()})
        );
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }
    let acceptance_rpc =
        cfg!(feature = "manual-acceptance") && std::env::args().any(|a| a == "--acceptance-rpc");
    let rpc_mode = acceptance_rpc || std::env::args().any(|a| a == "--rpc");
    if (option_env!("XWX_NATIVE_PILOT") == Some("1")
        || std::env::args().any(|a| {
            a == "--smoke"
                || a == "--rpc"
                || a == "--pilot-webview-persistent"
                || a == "--pilot-remove-webview-store"
        }))
        && argument("--pilot-root").is_none()
    {
        eprintln!("Verification requires --pilot-root.");
        std::process::exit(2);
    }
    let readiness: Value = serde_json::from_str(include_str!("../migration-status.json"))
        .expect("embedded migration readiness");
    if readiness["productionReady"] != true
        && !cfg!(feature = "manual-acceptance")
        && argument("--pilot-root").is_none()
    {
        let message = "此隔离验证包不能直接启动。请使用源码仓库的 npm run start:native:isolated，或安装可直接打开的 XwX Deck 人工验收包。原数据未修改。";
        eprintln!("{message}");
        show_startup_recovery(message);
        std::process::exit(2);
    }
    let edition_startup = edition::Startup::prepare(rpc_mode);
    let selected_root = argument("--pilot-root")
        .or_else(|| argument("--data-root"))
        .map(|path| Ok((PathBuf::from(path), None)))
        .unwrap_or_else(edition::default_data_root);
    let (root, legacy_conflict) = match selected_root {
        Ok(selected) => selected,
        Err(error) => {
            eprintln!("{error}");
            if !rpc_mode {
                show_startup_recovery(&error);
            }
            std::process::exit(2);
        }
    };
    if let Some(binding) = argument("--native-auth-token") {
        let result = tauri::async_runtime::block_on(core::native_auth::print_token(
            root,
            &binding,
            argument("--pilot-root").is_some(),
        ));
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(2);
        }
        return;
    }
    #[cfg(target_os = "windows")]
    if argument("--pilot-root").is_some() && std::env::args().any(|arg| arg == "--smoke-recovery") {
        windows_recovery::show("隔离启动失败验收：<script>window.recoveryInjected=true</script>\n原配置保留，请检查恢复记录。");
        std::process::exit(2);
    }
    match core::pending_reset(&root) {
        Ok(Some(job)) => match core::resume_reset(&job) {
            Ok(()) => {
                eprintln!("正在恢复上次重置，原数据与备份保留；完成后会重新打开应用。");
                std::process::exit(0);
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(2);
            }
        },
        Ok(None) => {}
        Err(error) => {
            eprintln!("{error}");
            if !rpc_mode {
                show_startup_recovery(&error);
            }
            std::process::exit(2);
        }
    }
    edition::migrate_root(&root);
    let pilot = match Pilot::open(root.clone()) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{e}");
            if !rpc_mode {
                show_startup_recovery(&e);
            }
            std::process::exit(2);
        }
    };
    let _native_auth = match tauri::async_runtime::block_on(core::native_auth::start(pilot.clone()))
    {
        Ok(service) => service,
        Err(error) => {
            eprintln!("原生认证入口启动失败：{error}");
            std::process::exit(2);
        }
    };
    if std::env::args().any(|a| a == "--pilot-remove-webview-store") {
        let result = isolated_webview::cleanup(&root);
        match &result {
            Ok(()) => println!("isolated WebView store removed"),
            Err(error) => eprintln!("{error}"),
        }
        std::process::exit(if result.is_ok() { 0 } else { 2 });
    }
    let renderer_preferences = tauri::async_runtime::block_on(async {
        let (root, keys) = pilot.lock().await.renderer_preferences_context();
        match renderer_preferences::load(&root, &keys).await {
            Ok(report) => report,
            Err(error) => {
                pilot.lock().await.renderer_preferences_problem(&error);
                eprintln!("{error}");
                json!({"version":1,"status":"failed","values":{}})
            }
        }
    });
    if rpc_mode {
        let metadata =
            tauri::async_runtime::block_on(async { pilot.lock().await.metadata_context() });
        metadata.start(pilot.clone(), std::sync::Arc::new(|_| {}));
        let mut pending = Vec::new();
        for line in std::io::stdin().lock().lines() {
            let request = line.map_err(|e| e.to_string()).and_then(|line| {
                serde_json::from_str::<Value>(&line).map_err(|_| "无效 RPC JSON".into())
            });
            if let Ok(request) = &request {
                if let Some(id) = request.get("requestId").cloned() {
                    let shared = pilot.clone();
                    let request = request.clone();
                    pending.push(tauri::async_runtime::spawn(async move {
                        let result = isolated_rpc(shared, &request).await;
                        let resetting = request["method"] == "resetApplication" && result.is_ok();
                        let response = match result {
                            Ok(result) => json!({"requestId":id,"ok":true,"result":result}),
                            Err(error) => json!({"requestId":id,"ok":false,"error":error}),
                        };
                        println!("{response}");
                        let _ = std::io::stdout().flush();
                        if resetting {
                            std::process::exit(0);
                        }
                    }));
                    continue;
                }
            }
            let resetting = request
                .as_ref()
                .is_ok_and(|request| request["method"] == "resetApplication");
            let result = request.and_then(|request| {
                tauri::async_runtime::block_on(isolated_rpc(pilot.clone(), &request))
            });
            let resetting = resetting && result.is_ok();
            let response = match result {
                Ok(result) => json!({"ok":true,"result":result}),
                Err(error) => json!({"ok":false,"error":error}),
            };
            println!("{response}");
            let _ = std::io::stdout().flush();
            if resetting {
                std::process::exit(0);
            }
        }
        tauri::async_runtime::block_on(async {
            for task in pending {
                let _ = task.await;
            }
        });
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
    let restart_stage = if smoke {
        argument("--smoke-renderer-restart")
            .and_then(|s| s.parse::<u8>().ok())
            .filter(|n| (1..=9).contains(n))
    } else {
        None
    };
    let reset_smoke = smoke && std::env::args().any(|arg| arg == "--smoke-application-reset");
    let preferences_smoke = smoke
        && (reset_smoke
            || restart_stage.is_some()
            || std::env::args().any(|arg| arg == "--smoke-renderer-preferences"));
    let mut preferences_script = renderer_preferences::initialization_script(&renderer_preferences);
    if preferences_smoke {
        let keys = renderer_preferences["values"]
            .as_object()
            .map(|values| values.keys().collect::<Vec<_>>())
            .unwrap_or_default();
        let keys = serde_json::to_string(&keys)
            .unwrap()
            .replace('<', "\\u003c");
        let expected = renderer_preferences["values"]
            .to_string()
            .replace('<', "\\u003c");
        preferences_script.push_str(&format!(";if(['tauri:','http:'].includes(location.protocol)){{window.__nativeRendererPreferencesExpected={expected};window.__nativeRendererPreferencesBoot=Object.fromEntries({keys}.map(k=>[k,localStorage.getItem(k)]));}}"));
    }
    if let Some(stage) = restart_stage {
        preferences_script.push_str(&format!(";window.__nativeRendererRestartStage={stage};"));
    }
    if preferences_smoke && std::env::args().any(|arg| arg == "--smoke-storage-sentinel") {
        preferences_script.push_str(";window.__nativeRendererPreferencesSentinel=true;");
    }
    let persistent_root = if std::env::args().any(|a| a == "--pilot-webview-persistent") {
        Some(root.clone())
    } else {
        None
    };
    #[cfg(target_os = "windows")]
    let isolated_root = argument("--pilot-root").map(|_| root.clone());
    let builder = embedded_fonts::builder();
    let builder = edition_startup.builder(builder);
    #[cfg(target_os = "macos")]
    let builder = builder
        .manage(webcrypto_store::Store::new(
            &root,
            argument("--pilot-root").is_some(),
        ))
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("private-webcrypto")
                .on_webview_ready(|webview| {
                    if let Err(error) = webview.state::<webcrypto_store::Store>().attach(&webview) {
                        eprintln!("{error}");
                    }
                })
                .build(),
        );
    let builder=builder
        .plugin(tauri::plugin::Builder::<tauri::Wry>::new("renderer-preferences")
            .js_init_script(preferences_script).build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::Builder::new().app_name("XwX Deck").args(["--launch-hidden"]).build())
        .setup(move |app| {
            #[cfg(target_os="windows")]
            windows_reveal::initialize(app.handle());
            let preference=tauri::async_runtime::block_on(async { app.state::<Shared>().inner().lock().await.state()["theme"].as_str().unwrap_or("day").to_owned() });
            sync_window_theme(app.handle(), &preference).map_err(std::io::Error::other)?;
            if let Some(root) = &persistent_root {
                isolated_webview::create(app, root).map_err(std::io::Error::other)?;
            } else {
                #[cfg(target_os="windows")]
                if let Some(root) = &isolated_root {
                    isolated_webview::create_ephemeral(app, root).map_err(std::io::Error::other)?;
                }
            }
            #[cfg(not(target_os="windows"))]
            use tauri::menu::{Menu,MenuItem};
            use tauri::tray::{TrayIconBuilder,TrayIconEvent,MouseButton,MouseButtonState};
            // Captures must refresh native counters even when WebKit throttles polling.
            let metadata_shared=app.state::<Shared>().inner().clone();
            let metadata_handle=app.handle().clone();
            let metadata=tauri::async_runtime::block_on(async{metadata_shared.lock().await.metadata_context()});
            metadata.start(metadata_shared,std::sync::Arc::new(move|state|{let _=metadata_handle.emit("pilot-state",state);let _=metadata_handle.emit("pilot-metadata",());}));
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
            #[cfg(not(target_os="windows"))]
            let tray = {
            let show=MenuItem::with_id(app,"show","打开 XwX Deck",true,None::<&str>)?;
            let quit=MenuItem::with_id(app,"quit","退出 XwX Deck",true,None::<&str>)?;
            let licenses=MenuItem::with_id(app,"licenses","开源许可证",true,None::<&str>)?;
            let menu=Menu::with_items(app,&[&show,&licenses,&quit])?;
            #[cfg(target_os="macos")]
            let tray_icon=tauri::include_image!("../assets/trayTemplate@2x.png");
            #[cfg(not(target_os="macos"))]
            let tray_icon=tauri::include_image!("../assets/tray.png");
            TrayIconBuilder::with_id("xwx-deck").icon(tray_icon).icon_as_template(cfg!(target_os="macos")).tooltip("XwX Deck").menu(&menu).show_menu_on_left_click(false)
              .on_menu_event(|app,event|{match event.id.as_ref(){"show"=>show_main(app),"trace-start"=>request_trace_from_tray(app,true),"trace-stop"=>request_trace_from_tray(app,false),"licenses"=>show_licenses(app),"quit"=>app.exit(0),_=>{}}})
            };
            #[cfg(target_os="windows")]
            let tray = TrayIconBuilder::with_id("xwx-deck").icon(tauri::include_image!("../assets/tray.png")).tooltip("XwX Deck").show_menu_on_left_click(false);
            tray.on_tray_icon_event(|tray,event|{match event {
                TrayIconEvent::Click{button:MouseButton::Left,button_state:MouseButtonState::Up,..} => {
                    #[cfg(target_os="windows")]windows_tray::hide(tray.app_handle());
                    show_main(tray.app_handle());
                },
                #[cfg(target_os="windows")]
                TrayIconEvent::Click{button:MouseButton::Right,button_state:MouseButtonState::Up,position,..} => windows_tray::open(tray.app_handle(),position),
                _=>{}
            }}).build(app)?;
            sync_trace_tray(app.handle(), &tauri::async_runtime::block_on(async { app.state::<Shared>().lock().await.state() }), false);
            if !std::env::args().any(|a|a=="--pilot-root"){
                let shared=app.state::<Shared>().inner().clone();let handle=app.handle().clone();
                tauri::async_runtime::spawn(async move{
                    let resumed={shared.lock().await.call("resumeTracing",&[]).await};
                    match resumed {
                        Ok(state)=>{let _=handle.emit("pilot-state",state);},
                        Err(error)=>{let mut state=shared.lock().await.state();state["lastError"]=json!(error);let _=handle.emit("pilot-state",state);}
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(6000)).await;
                    let updates=shared.lock().await.updates_context();if updates.state()["status"]=="idle"{if let Ok(state)=updates.check().await{let _=handle.emit("pilot-update",state);}}
                    let mut previous_update=Value::Null;
                    loop{
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        let state=shared.lock().await.update_state();if state!=previous_update{let _=handle.emit("pilot-update",&state);previous_update=state.clone();}
                        #[cfg(target_os="macos")]
                        {
                            if state["status"]=="available" {let _=shared.lock().await.call("downloadAutomaticUpdate",&[]).await;}
                            if crate::edition::config::AUTOMATIC_MACOS_UPDATES && state["status"]=="ready" && state["installMode"]=="automatic" && macos_update::idle_for_nightly() {
                                let installer={let mut p=shared.lock().await;if !p.active() && p.nightly_eligible(){p.call("restartAndInstall",&[]).await.ok()}else{None}};
                                if let Some(installer)=installer {
                                    if let Err(error)=install_macos_update(&handle,shared.clone(),installer,true).await {eprintln!("Mac 自动更新延后：{error}");}
                                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                                }
                            }
                        }
                        #[cfg(target_os="windows")]if portable_update::idle_for_nightly(){
                            let mut p=shared.lock().await;if !p.active()&&p.nightly_eligible(){
                                if state["status"]=="available"{let _=p.call("downloadAutomaticUpdate",&[]).await;}
                                if state["status"]=="ready"{if let Ok(installer)=p.call("restartAndInstall",&[]).await{if let Some(path)=installer["path"].as_str(){if spawn_windows_update(std::path::Path::new(path),&installer).is_ok(){handle.exit(0);}}}}
                            }
                        }
                    }
                });
            }
            Ok(())
        })
        .on_menu_event(|app,event|{if std::env::args().any(|a|a=="--smoke"){eprintln!("native-menu {}",event.id.as_ref());}
 if event.id.as_ref()=="native-quit"{app.exit(0);}else if event.id.as_ref()=="licenses"{show_licenses(app);}})
        .manage(pilot.clone())
        .invoke_handler(tauri::generate_handler![pilot_rpc,pilot_tray,pilot_smoke_report,pilot_smoke_progress])
        .on_page_load(move |window,payload| {
            if smoke && payload.event()==tauri::webview::PageLoadEvent::Finished
                && window.label() == "main" { let _=window.show(); let _=window.set_focus(); let script=if std::env::args().any(|arg|arg=="--smoke-setup-update" || arg=="--smoke-setup-restart"){include_str!("../../tools/native/setup-smoke.js")}else if std::env::args().any(|arg|arg=="--smoke-reminders"){include_str!("../../tools/native/reminders-smoke.js")}else if std::env::args().any(|arg|arg=="--smoke-tray"){include_str!("../../tools/native/tray-smoke.js")}else if std::env::args().any(|arg|arg=="--smoke-window-lifecycle"){include_str!("../../tools/native/window-lifecycle-smoke.js")}else if std::env::args().any(|arg|arg=="--smoke-theme"){include_str!("../../tools/native/theme-smoke.js")}else if let Some(script)=edition::smoke_script(){script}else if std::env::args().any(|arg|arg=="--smoke-application-reset"){include_str!("../../tools/native/application-reset-smoke.js")}else if argument("--smoke-renderer-restart").is_some(){include_str!("../../tools/native/renderer-restart-smoke.js")}else if std::env::args().any(|arg|arg=="--smoke-provider-switch"){include_str!("../../tools/native/provider-switch-native-smoke.js")}else if std::env::args().any(|arg|arg=="--smoke-routing"){include_str!("../../tools/native/subscription-routing-smoke.js")}else if std::env::args().any(|arg|arg=="--smoke-universal"){include_str!("../../tools/native/universal-native-smoke.js")}else{include_str!("../../tools/native/native-smoke.js")};let _=window.eval(script); }
        })
        .on_window_event(move |window,event| {
            #[cfg(target_os="windows")]
            if window.label()==windows_tray::LABEL {
                if matches!(event,tauri::WindowEvent::Focused(false)) && window.is_visible().unwrap_or(false) {windows_tray::hide(window.app_handle());}
                if let tauri::WindowEvent::CloseRequested{api,..}=event {api.prevent_close();windows_tray::hide(window.app_handle());}
            }
            if let tauri::WindowEvent::CloseRequested{api,..}=event {
                if window.label()=="dashboard" {
                    // WKWebView may retain a closed page. Release its SSE slot
                    // before closing the window, independently of WebKit GC.
                    if let Some(viewer)=window.app_handle().get_webview_window("dashboard") {
                        let _=viewer.eval("window.__xwxTraceDispose?.()");
                    }
                }
                // Main-window Close is separate from explicit tray Exit.
                // Hiding a fullscreen dashboard leaves a blank macOS Space.
                if window.label()=="main" {
                    {api.prevent_close();let _=window.hide();}
                }
            }
            if let tauri::WindowEvent::Resized(_)=event {
                let _=window.emit("pilot-window",json!({"maximized":window.is_maximized().unwrap_or(false),"fullscreen":window.is_fullscreen().unwrap_or(false),"nativeFrame":cfg!(target_os="macos")}));
            }
        });
    let mut context = tauri::generate_context!();
    if smoke {
        // Acceptance keeps running when the user focuses another app. This is
        // fixture-only; ordinary windows keep the system's power policy.
        context.config_mut().app.windows[0].background_throttling =
            Some(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
    }
    if argument("--pilot-root").is_some() {
        // Fixture roots must not inherit onboarding or other browser state from
        // an existing desktop session that shares the same test app identity.
        context.config_mut().app.windows[0].incognito = true;
        #[cfg(target_os = "windows")]
        {
            context.config_mut().app.windows[0].create = false;
        }
        if std::env::args().any(|a| a == "--pilot-webview-persistent") {
            if let Err(error) = isolated_webview::supported() {
                eprintln!("{error}");
                std::process::exit(2);
            }
            context.config_mut().app.windows[0].create = false;
        }
        if smoke && !preferences_smoke {
            context.config_mut().app.windows[0].url =
                tauri::WebviewUrl::App("index.html?tour=1".into());
        }
    }
    if std::env::args().any(|a| a == "--launch-hidden" || cfg!(windows) && a == "--hidden") {
        context.config_mut().app.windows[0].visible = false;
    }
    let app = builder
        .build(context)
        .expect("failed to build XwX Deck native host");
    let exit_retry_pending = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    app.run(move |handle, event| match event {
        tauri::RunEvent::Ready if !smoke => {
            let _ = &legacy_conflict;
            #[cfg(target_os="macos")]
            if std::env::args().any(|a|a=="--smoke-update-restarted") && argument("--pilot-root").is_some() {
                let root=PathBuf::from(argument("--pilot-root").unwrap());
                let _=std::fs::write(root.join("macos-update-restarted.json"),serde_json::to_vec(&json!({"pid":std::process::id(),"version":macos_update::current_version(),"binary":std::env::current_exe().ok()})).unwrap());
            }
        }
        tauri::RunEvent::ExitRequested { api, .. } => {
            if std::env::args().any(|a| a == "--smoke") {
                eprintln!("native-exit-requested");
            }
            // RPC tasks can hold Pilot while waiting for the main thread. Never
            // block that thread on the same mutex during an exit request.
            let active = match pilot.try_lock() {
                Ok(state) => state.active(),
                Err(_) => {
                    api.prevent_exit();
                    if !exit_retry_pending.swap(true, std::sync::atomic::Ordering::AcqRel) {
                        let shared = pilot.clone();
                        let handle = handle.clone();
                        let pending = exit_retry_pending.clone();
                        tauri::async_runtime::spawn(async move {
                            drop(shared.lock().await);
                            pending.store(false, std::sync::atomic::Ordering::Release);
                            handle.exit(0);
                        });
                    }
                    return;
                }
            };
            if std::env::args().any(|a| a == "--smoke") {
                eprintln!("native-exit-state-read {active}");
            }
            if active {
                api.prevent_exit();
                show_main(handle);
                let _ = handle.emit("pilot-exit-requested", ());
            }
        }
        tauri::RunEvent::Exit => {
            if std::env::args().any(|a| a == "--smoke") { eprintln!("native-exit-release-start"); }
            tauri::async_runtime::block_on(async {
                pilot.lock().await.release_lock();
            });
            if std::env::args().any(|a| a == "--smoke") { eprintln!("native-exit-release-complete"); }
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
