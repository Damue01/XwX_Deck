//! Open directories through the Windows folder launcher, without a command shell,
//! executable arguments or elevation. Shell selection can report E_ACCESSDENIED
//! even when the current user can read the directory.
use std::{
    fs,
    os::windows::ffi::OsStrExt,
    path::{Component, Path, Prefix},
    sync::{mpsc, OnceLock},
    time::Duration,
};
use windows::{
    System::Launcher,
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_SINGLETHREADED},
};
use windows_core::HSTRING;

static APPLICATION: OnceLock<tauri::AppHandle> = OnceLock::new();
type Result<T> = std::result::Result<T, String>;

pub fn initialize(app: &tauri::AppHandle) {
    let _ = APPLICATION.set(app.clone());
}

fn shell_path(path: &Path) -> HSTRING {
    let mut name: Vec<u16> = path.as_os_str().encode_wide().collect();
    // Canonical paths have verbatim prefixes; the Windows folder launcher uses
    // ordinary drive/UNC paths. Preserve the remaining UTF-16 code units.
    if let Some(Component::Prefix(prefix)) = path.components().next() {
        match prefix.kind() {
            Prefix::VerbatimDisk(_) => drop(name.drain(..4)),
            Prefix::VerbatimUNC(_, _) => {
                drop(name.splice(..8, [b'\\' as u16, b'\\' as u16]));
            }
            _ => {}
        }
    }
    HSTRING::from_wide(&name)
}

fn completed(result: windows_core::Result<bool>) -> Result<()> {
    match result {
        Ok(true) => Ok(()),
        Ok(false) => {
            Err("Windows 未打开文件夹；请检查目录是否仍存在，以及当前用户的访问权限".into())
        }
        Err(error) => Err(format!(
            "无法打开文件夹（0x{:08X}）：{error}",
            error.code().0
        )),
    }
}

pub fn reveal(file: &Path) -> Result<()> {
    let file = fs::canonicalize(file).map_err(|error| format!("无法访问日志文件：{error}"))?;
    open_folder(file.parent().ok_or("日志目录无效")?)
}

pub fn open_folder(folder: &Path) -> Result<()> {
    let folder = fs::canonicalize(folder).map_err(|error| format!("无法访问文件夹：{error}"))?;
    if !folder.is_dir() {
        return Err("目标不是文件夹".into());
    }
    let path = shell_path(&folder);
    let (sender, receiver) = mpsc::channel();
    if let Some(app) = APPLICATION.get() {
        // Launcher requires a UI apartment. Initiate on Tauri's UI thread and
        // report completion asynchronously; never block that thread on join().
        app.run_on_main_thread(move || match Launcher::LaunchFolderPathAsync(&path) {
            Ok(operation) => {
                let completion = sender.clone();
                if let Err(error) = operation.when(move |result| {
                    let _ = completion.send(completed(result));
                }) {
                    let _ = sender.send(Err(format!("无法等待文件夹打开：{error}")));
                }
            }
            Err(error) => {
                let _ = sender.send(completed(Err(error)));
            }
        })
        .map_err(|error| format!("无法提交文件夹打开请求：{error}"))?;
    } else {
        // Headless isolated RPC verification has no Tauri window or UI loop.
        // Give its shell request a dedicated STA, rather than a Tokio MTA worker.
        std::thread::spawn(move || {
            let result = unsafe { RoInitialize(RO_INIT_SINGLETHREADED) }.and_then(|_| {
                let result = Launcher::LaunchFolderPathAsync(&path).and_then(|op| op.join());
                unsafe { RoUninitialize() };
                result
            });
            let _ = sender.send(completed(result));
        });
    }
    receiver
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| "等待 Windows 打开文件夹超时，未报告打开成功".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_paths_preserve_unicode_spaces_and_unc() {
        for (input, expected) in [
            (r"\\?\E:\日志 文件夹 # &\trace", r"E:\日志 文件夹 # &\trace"),
            (r"\\?\UNC\server\share\日志 # &", r"\\server\share\日志 # &"),
            (r"E:\普通目录", r"E:\普通目录"),
        ] {
            assert_eq!(shell_path(Path::new(input)).to_string_lossy(), expected);
        }
    }

    #[test]
    fn launcher_false_and_failures_are_not_success() {
        assert!(completed(Ok(true)).is_ok());
        assert!(completed(Ok(false)).is_err());
        assert!(completed(Err(windows_core::Error::from_hresult(
            windows_core::HRESULT(0x80070005u32 as i32)
        )))
        .unwrap_err()
        .contains("0x80070005"));
    }
}
