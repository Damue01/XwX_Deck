//! Windows uses an application-rendered tray popup rather than a system menu.
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};

pub const LABEL: &str = "tray-menu";
const WIDTH: f64 = 212.0;
const HEIGHT: f64 = 100.0;
static READY: AtomicBool = AtomicBool::new(false);
static REQUESTED: AtomicBool = AtomicBool::new(false);

pub fn snapshot(state: &Value, pending: bool) -> Value {
    json!({
        "enabled": state["tracingEnabled"].as_bool().unwrap_or(false),
        "busy": pending || state["traceTransition"].as_str().is_some(),
        "theme": state["theme"].as_str().unwrap_or("day"),
        "language": state["language"].as_str().unwrap_or("zh-CN")
    })
}

pub fn sync(app: &tauri::AppHandle, state: &Value, pending: bool) {
    static LAST: std::sync::Mutex<Option<Value>> = std::sync::Mutex::new(None);
    let next = snapshot(state, pending);
    if let Ok(mut last) = LAST.lock() {
        if last.as_ref() != Some(&next) {
            let _ = app.emit_to(LABEL, "pilot-tray-state", &next);
            *last = Some(next);
        }
    }
}

pub fn hide(app: &tauri::AppHandle) {
    REQUESTED.store(false, Ordering::Release);
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
}

pub fn ready(app: &tauri::AppHandle) -> Result<(), String> {
    READY.store(true, Ordering::Release);
    if REQUESTED.load(Ordering::Acquire) {
        if let Some(window) = app.get_webview_window(LABEL) {
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn bounds(
    point: [f64; 2],
    area: [f64; 4],
    scale: f64,
) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let margin = 4.0 * scale;
    let width = (WIDTH * scale).min((area[2] - margin * 2.0).max(1.0));
    let height = (HEIGHT * scale).min((area[3] - margin * 2.0).max(1.0));
    let x = point[0].clamp(
        area[0] + margin,
        (area[0] + area[2] - width - margin).max(area[0] + margin),
    );
    let y = (point[1] - height - margin).clamp(
        area[1] + margin,
        (area[1] + area[3] - height - margin).max(area[1] + margin),
    );
    (
        PhysicalPosition::new(x.round() as i32, y.round() as i32),
        PhysicalSize::new(width.round() as u32, height.round() as u32),
    )
}

pub fn show(
    app: &tauri::AppHandle,
    point: PhysicalPosition<f64>,
    state: &Value,
) -> Result<(), String> {
    let monitor = app
        .monitor_from_point(point.x, point.y)
        .map_err(|e| e.to_string())?
        .or(app.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("无法确定托盘所在显示器")?;
    let area = monitor.work_area();
    let (position, size) = bounds(
        [point.x, point.y],
        [
            f64::from(area.position.x),
            f64::from(area.position.y),
            f64::from(area.size.width),
            f64::from(area.size.height),
        ],
        monitor.scale_factor(),
    );
    let window = if let Some(window) = app.get_webview_window(LABEL) {
        window
    } else {
        let builder = tauri::WebviewWindowBuilder::new(
            app,
            LABEL,
            tauri::WebviewUrl::App("tray.html".into()),
        )
        .title("XwX Deck 托盘菜单")
        .inner_size(WIDTH, HEIGHT)
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .theme(crate::window_theme(
            state["theme"].as_str().unwrap_or("day"),
        ));
        let builder = if let Some(root) = crate::argument("--pilot-root") {
            builder
                .incognito(true)
                .data_directory(crate::isolated_webview::directory(
                    std::path::Path::new(&root),
                    "tray-webview",
                )?)
        } else {
            builder
        };
        builder.build().map_err(|e| e.to_string())?
    };
    window.set_position(position).map_err(|e| e.to_string())?;
    window.set_size(size).map_err(|e| e.to_string())?;
    window
        .emit("pilot-tray-state", snapshot(state, false))
        .map_err(|e| e.to_string())?;
    REQUESTED.store(true, Ordering::Release);
    if READY.load(Ordering::Acquire) {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn open(app: &tauri::AppHandle, point: PhysicalPosition<f64>) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // Do not block the native UI thread on a Pilot lock held by an RPC.
        let state = handle.state::<crate::Shared>().lock().await.state();
        let target = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            if let Err(error) = show(&target, point, &state) {
                crate::show_main(&target);
                let _ = target.emit(
                    "pilot-notice",
                    json!({"message":"托盘菜单无法打开", "type":"error", "description":error}),
                );
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn popup_opens_to_the_right_when_space_is_available() {
        for scale in [1.0, 1.25, 1.5, 2.0, 3.5] {
            for (point, area) in [
                ([700.0, 1000.0], [0.0, 0.0, 1920.0, 1040.0]),
                ([-1200.0, 1000.0], [-1920.0, 0.0, 1920.0, 1040.0]),
            ] {
                let (position, _) = bounds(point, area, scale);
                assert_eq!(f64::from(position.x), point[0]);
            }
        }
    }
    #[test]
    fn popup_stays_inside_scaled_work_area() {
        for scale in [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 3.0, 3.5] {
            let (position, size) = bounds([3830.0, 2150.0], [0.0, 0.0, 3840.0, 2000.0], scale);
            assert_eq!(size.width, (WIDTH * scale) as u32);
            assert!(position.x >= 0 && position.y >= 0);
            assert!(position.x + size.width as i32 <= 3840);
            assert!(position.y + size.height as i32 <= 2000);
        }
    }
    #[test]
    fn popup_handles_negative_monitor_origin_and_top_taskbar() {
        let (position, size) = bounds([-1920.0, -40.0], [-1920.0, 0.0, 1920.0, 1080.0], 1.5);
        assert!(position.x >= -1920 && position.y >= 0);
        assert!(position.x + size.width as i32 <= 0);
    }
    #[test]
    fn tray_snapshot_contains_no_configuration_or_credentials() {
        let state = json!({"tracingEnabled":true,"traceTransition":"stopping","theme":"night","language":"en","connections":[{"bearerToken":"synthetic-private"}]});
        let public = snapshot(&state, false);
        assert_eq!(
            public,
            json!({"enabled":true,"busy":true,"theme":"night","language":"en"})
        );
        assert!(!public.to_string().contains("synthetic-private"));
    }
}
