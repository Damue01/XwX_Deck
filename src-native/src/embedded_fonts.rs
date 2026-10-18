//! One immutable resource set shared by the Tauri renderer and HTTP Trace Viewer.
include!(concat!(env!("OUT_DIR"), "/embedded-fonts.rs"));

pub(crate) fn get(path: &str) -> Option<&'static [u8]> {
    let name = path.strip_prefix("/fonts/")?;
    FONTS
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, bytes)| *bytes)
}

pub(crate) fn builder() -> tauri::Builder<tauri::Wry> {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(
        tauri::plugin::Builder::<tauri::Wry>::new("application-context-menus")
            .on_webview_ready(|webview| {
                let _ = webview.with_webview(|webview| unsafe {
                    let result = webview
                        .controller()
                        .CoreWebView2()
                        .and_then(|view| view.Settings())
                        .and_then(|settings| settings.SetAreDefaultContextMenusEnabled(false));
                    if let Err(error) = result {
                        eprintln!("无法停用系统右键菜单：{error}");
                    }
                });
            })
            .build(),
    );
    builder.register_uri_scheme_protocol("xwx-font", |_context, request| {
        let bytes = if request.method() == tauri::http::Method::GET {
            get(request.uri().path())
        } else {
            None
        };
        tauri::http::Response::builder()
            .status(if bytes.is_some() { 200 } else { 404 })
            .header("Content-Type", "font/woff2")
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "public, max-age=31536000, immutable")
            .body(bytes.unwrap_or_default().to_vec())
            .unwrap()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fonts_are_exact_woff2_resources_and_unknown_paths_are_rejected() {
        assert!(!FONTS.is_empty());
        for (name, bytes) in FONTS {
            assert!(bytes.starts_with(b"wOF2"));
            assert_eq!(get(&format!("/fonts/{name}")), Some(*bytes));
        }
        for path in [
            "/fonts/../Info.plist",
            "/fonts/missing.woff2",
            "/fonts/",
            "/other",
        ] {
            assert!(get(path).is_none());
        }
    }
}
