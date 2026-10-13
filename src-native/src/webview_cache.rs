//! Quick repair clears network caches, preserving cookies and browser databases.
pub async fn clear(window: &tauri::WebviewWindow) -> Result<(), String> {
    clear_impl(window, false).await
}

/// Factory reset waits for the native data-store completion, including cookies,
/// localStorage and databases. Quick repair deliberately uses the smaller set.
pub async fn clear_all(window: &tauri::WebviewWindow) -> Result<(), String> {
    clear_impl(window, true).await
}
async fn clear_impl(window: &tauri::WebviewWindow, all: bool) -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<(), String>>();
    window
        .with_webview(move |webview| {
            #[cfg(target_os = "macos")]
            unsafe {
                use objc2_foundation::{MainThreadMarker, NSDate, NSSet};
                use objc2_web_kit::{
                    WKWebView, WKWebsiteDataStore, WKWebsiteDataTypeDiskCache,
                    WKWebsiteDataTypeMemoryCache,
                };
                // Tauri dispatches this closure to the main thread. The pointer is
                // borrowed for this call; the store retains the completion block.
                let view: &WKWebView = &*webview.inner().cast();
                let store = view.configuration().websiteDataStore();
                let types = if all {
                    let Some(thread) = MainThreadMarker::new() else {
                        let _ = sender
                            .send(Err("浏览器清理必须在主线程执行，应用数据与备份保留".into()));
                        return;
                    };
                    WKWebsiteDataStore::allWebsiteDataTypes(thread)
                } else {
                    NSSet::from_slice(&[WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache])
                };
                let sender = std::sync::Mutex::new(Some(sender));
                let completion = block2::RcBlock::new(move || {
                    if let Some(sender) = sender.lock().unwrap().take() {
                        let _ = sender.send(Ok(()));
                    }
                });
                store.removeDataOfTypes_modifiedSince_completionHandler(
                    &types,
                    &NSDate::dateWithTimeIntervalSince1970(0.0),
                    &completion,
                );
            }
            #[cfg(target_os = "windows")]
            unsafe {
                use webview2_com::{
                    ClearBrowsingDataCompletedHandler,
                    Microsoft::Web::WebView2::Win32::{
                        ICoreWebView2Profile2, ICoreWebView2_13,
                        COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_PROFILE,
                        COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE,
                    },
                };
                use windows_core::Interface;
                let sender = std::sync::Arc::new(std::sync::Mutex::new(Some(sender)));
                let completion_sender = sender.clone();
                let completion =
                    ClearBrowsingDataCompletedHandler::create(Box::new(move |result| {
                        if let Some(sender) = completion_sender.lock().unwrap().take() {
                            let _ = sender.send(result.map_err(|_| {
                                "浏览器清理未确认完成，应用数据与备份保留".to_string()
                            }));
                        }
                        Ok(())
                    }));
                let outcome = (|| {
                    webview
                        .controller()
                        .CoreWebView2()?
                        .cast::<ICoreWebView2_13>()?
                        .Profile()?
                        .cast::<ICoreWebView2Profile2>()?
                        .ClearBrowsingData(
                            if all {
                                COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_PROFILE
                            } else {
                                COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE
                            },
                            &completion,
                        )
                })();
                if outcome.is_err() {
                    if let Some(sender) = sender.lock().unwrap().take() {
                        let _ = sender.send(Err(
                            "当前 WebView2 无法确认浏览器清理，应用数据与备份保留".into(),
                        ));
                    }
                }
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                let _ = webview;
                let _ = sender.send(Err("此平台尚未提供浏览器缓存清理".into()));
            }
        })
        .map_err(|_| "无法启动浏览器缓存清理".to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(15), receiver)
        .await
        .map_err(|_| "浏览器清理仍未确认完成，应用数据与备份保留".to_string())?
        .map_err(|_| "浏览器缓存清理未返回结果".to_string())?
}
