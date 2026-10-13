//! Persistent WebKit CryptoKeys keep their original wrapping key in a private
//! file. A failed legacy import preserves every browser database and never
//! falls back to interactive Keychain access during normal use.
use serde_json::{json, Value};
use std::{path::Path, sync::Mutex};
use tauri::Manager;
use zeroize::Zeroizing;

pub struct Store {
    key: Mutex<Result<Zeroizing<Vec<u8>>, String>>,
}

extern "C" {
    fn deck_install_webcrypto_key(view: *mut std::ffi::c_void, key: *const u8, len: usize);
    fn deck_webcrypto_requests() -> usize;
}

impl Store {
    pub fn new(root: &Path, isolated: bool) -> Self {
        Self {
            key: Mutex::new(crate::core::webcrypto_private_key(root, isolated, false)),
        }
    }
    pub fn status(&self) -> Value {
        match &*self.key.lock().unwrap() {
            Ok(_) => json!({"status":"ready","keyRequests":unsafe { deck_webcrypto_requests() }}),
            Err(error) => {
                json!({"status":"migration-required","message":error,"keyRequests":unsafe { deck_webcrypto_requests() }})
            }
        }
    }
    pub fn migrate(
        &self,
        app: &tauri::AppHandle,
        root: &Path,
        isolated: bool,
    ) -> Result<(), String> {
        let key = crate::core::webcrypto_private_key(root, isolated, true)?;
        *self.key.lock().unwrap() = Ok(key);
        for window in app.webview_windows().into_values() {
            self.attach(window.as_ref())?;
        }
        Ok(())
    }
    pub fn attach(&self, webview: &tauri::Webview) -> Result<(), String> {
        let key = self
            .key
            .lock()
            .unwrap()
            .as_ref()
            .map(|key| key.to_vec())
            .unwrap_or_default();
        let key = Zeroizing::new(key);
        webview
            .with_webview(move |webview| unsafe {
                deck_install_webcrypto_key(webview.inner().cast(), key.as_ptr(), key.len());
            })
            .map_err(|_| "无法连接网页本地密钥，原登录数据已保留".to_string())
    }
}
