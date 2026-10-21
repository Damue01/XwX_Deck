use crate::*;
pub(crate) mod config;
pub(crate) struct Startup;
impl Startup {
    pub(crate) fn prepare(_rpc: bool) -> Self {
        Self
    }
    pub(crate) fn builder(self, builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
        builder
    }
}
pub(crate) async fn rpc(
    _app: &tauri::AppHandle,
    _pilot: &Shared,
    _method: &str,
    _args: &[Value],
) -> Option<Result<Value, String>> {
    None
}
pub(crate) fn manager_ready(_app: &tauri::AppHandle) {}
pub(crate) async fn clear_stores(
    _app: &tauri::AppHandle,
    _root: &std::path::Path,
) -> Result<(), String> {
    Ok(())
}
#[cfg(target_os = "macos")]
pub(crate) fn store_ids(_root: &std::path::Path) -> Vec<[u8; 16]> {
    vec![]
}
pub(crate) fn migrate_root(_root: &std::path::Path) {}
pub(crate) fn smoke_script() -> Option<&'static str> {
    None
}
pub(crate) fn default_data_root() -> Result<(PathBuf, Option<PathBuf>), String> {
    let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
    let parent = if cfg!(target_os = "windows") {
        PathBuf::from(std::env::var_os("APPDATA").ok_or("无法读取 Windows 应用数据目录")?)
    } else if cfg!(target_os = "macos") {
        home.join("Library/Application Support")
    } else {
        PathBuf::from(
            std::env::var_os("XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config").into()),
        )
    };
    Ok((parent.join(config::DATA_DIRECTORY), None))
}

pub(crate) async fn isolated_rpc(
    _pilot: &Shared,
    _method: &str,
    _args: &[Value],
) -> Option<Result<Value, String>> {
    None
}
