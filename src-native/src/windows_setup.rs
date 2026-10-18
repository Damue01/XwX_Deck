//! Per-user Windows Setup updates. NSIS owns program files; user data stays
//! in the unchanged xwx-deck namespace, outside the installation directory.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    ffi::c_void,
    fs,
    os::windows::{ffi::OsStrExt, process::CommandExt},
    path::{Path, PathBuf},
    process::Command,
};
use windows::{core::PCWSTR, Win32::System::Registry::*};
type Result<T> = std::result::Result<T, String>;
const INSTALL_KEY: &str = r"Software\XwX Deck\Installation";
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const APP_FILE: &str = "XwX Deck.exe";
#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
    fn CloseHandle(handle: *mut c_void) -> i32;
    fn WaitForSingleObject(handle: *mut c_void, timeout: u32) -> u32;
    fn GetLastError() -> u32;
    fn QueryFullProcessImageNameW(
        handle: *mut c_void,
        flags: u32,
        name: *mut u16,
        length: *mut u32,
    ) -> i32;
    fn K32EnumProcesses(processes: *mut u32, size: u32, needed: *mut u32) -> i32;
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn path_wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
fn registry(key: &str, name: &str) -> Option<String> {
    let mut data = vec![0u16; 32768];
    let mut size = (data.len() * 2) as u32;
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(wide(key).as_ptr()),
            PCWSTR(wide(name).as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(data.as_mut_ptr().cast()),
            Some(&mut size),
        )
    }
    .ok()
    .ok()?;
    Some(
        String::from_utf16_lossy(&data[..size as usize / 2])
            .trim_end_matches('\0')
            .into(),
    )
}
fn same_path(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy()),
        _ => match (
            a.parent().and_then(|p| fs::canonicalize(p).ok()),
            b.parent().and_then(|p| fs::canonicalize(p).ok()),
            a.file_name(),
            b.file_name(),
        ) {
            (Some(a), Some(b), Some(af), Some(bf)) => {
                a.as_os_str()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
                    && af
                        .to_string_lossy()
                        .eq_ignore_ascii_case(&bf.to_string_lossy())
            }
            _ => false,
        },
    }
}
#[derive(Clone)]
pub struct Installation {
    pub executable: PathBuf,
}
pub fn is_registered() -> bool {
    let Some(executable) = std::env::current_exe().ok() else {
        return false;
    };
    let Some(location) = registry(INSTALL_KEY, "Path").map(PathBuf::from) else {
        return false;
    };
    registry(INSTALL_KEY, "AppId").as_deref() == Some("app.xwxdeck.desktop")
        && registry(INSTALL_KEY, "InstallerType").as_deref() == Some("nsis-v1")
        && same_path(&location.join(APP_FILE), &executable)
}
pub fn installation() -> Option<Installation> {
    let executable = std::env::current_exe().ok()?;
    let location = PathBuf::from(registry(INSTALL_KEY, "Path")?);
    if registry(INSTALL_KEY, "AppId")? != "app.xwxdeck.desktop"
        || registry(INSTALL_KEY, "InstallerType")? != "nsis-v1"
        || !same_path(&location.join(APP_FILE), &executable)
        || !location.join("uninstall.exe").is_file()
        || hash(&executable).ok()? != registry(INSTALL_KEY, "BinarySha256")?
    {
        return None;
    }
    Some(Installation { executable })
}
#[link(name = "version")]
extern "system" {
    fn GetFileVersionInfoSizeW(path: *const u16, handle: *mut u32) -> u32;
    fn GetFileVersionInfoW(path: *const u16, handle: u32, length: u32, data: *mut c_void) -> i32;
    fn VerQueryValueW(
        data: *const c_void,
        query: *const u16,
        value: *mut *mut c_void,
        length: *mut u32,
    ) -> i32;
}
fn version_field(path: &Path, field: &str) -> Result<String> {
    let size = unsafe { GetFileVersionInfoSizeW(path_wide(path).as_ptr(), std::ptr::null_mut()) };
    if size == 0 || size > 1024 * 1024 {
        return Err("安装包缺少有效版本信息".into());
    }
    let mut data = vec![0u8; size as usize];
    if unsafe { GetFileVersionInfoW(path_wide(path).as_ptr(), 0, size, data.as_mut_ptr().cast()) }
        == 0
    {
        return Err("无法读取安装包身份".into());
    }
    let mut pointer = std::ptr::null_mut();
    let mut length = 0;
    if unsafe {
        VerQueryValueW(
            data.as_ptr().cast(),
            wide(r"\VarFileInfo\Translation").as_ptr(),
            &mut pointer,
            &mut length,
        )
    } == 0
        || length < 4
    {
        return Err("安装包缺少语言信息".into());
    }
    let pair = unsafe { std::slice::from_raw_parts(pointer.cast::<u16>(), 2) };
    let query = format!(r"\StringFileInfo\{:04x}{:04x}\{}", pair[0], pair[1], field);
    if unsafe {
        VerQueryValueW(
            data.as_ptr().cast(),
            wide(&query).as_ptr(),
            &mut pointer,
            &mut length,
        )
    } == 0
        || length == 0
        || length > 32768
    {
        return Err("安装包缺少产品信息".into());
    }
    Ok(String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(pointer.cast::<u16>(), length as usize)
    })
    .trim_end_matches('\0')
    .into())
}
pub fn validate(source: &Path, version: &str) -> Result<()> {
    let info = fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if !source.is_absolute()
        || !info.is_file()
        || info.file_type().is_symlink()
        || source.extension().and_then(|s| s.to_str()) != Some("exe")
        || version_field(source, "ProductName")? != "XwX Deck Setup"
        || version_field(source, "ProductVersion")? != version
        || version_field(source, "OriginalFilename")? != "XwX-Deck-windows-x64-setup.exe"
        || version_field(source, "InstallScope")? != "per-user"
    {
        return Err("Setup 的产品、版本或按用户安装范围不匹配".into());
    }
    Ok(())
}
fn registered_target(target: &Path) -> Result<()> {
    let location = PathBuf::from(registry(INSTALL_KEY, "Path").ok_or("安装登记不存在")?);
    if registry(INSTALL_KEY, "AppId").as_deref() != Some("app.xwxdeck.desktop")
        || registry(INSTALL_KEY, "InstallerType").as_deref() != Some("nsis-v1")
        || !same_path(&location.join(APP_FILE), target)
    {
        return Err("程序与当前用户安装不匹配".into());
    }
    Ok(())
}
fn check_target(target: &Path, uninstall: bool) -> Result<()> {
    if !target.is_absolute() || target.file_name().and_then(|s| s.to_str()) != Some(APP_FILE) {
        return Err("无效安装目标".into());
    }
    if registry(INSTALL_KEY, "Path").is_some() {
        registered_target(target)?;
    } else if uninstall
        || target.exists()
        || target
            .parent()
            .is_some_and(|p| p.join("uninstall.exe").exists())
    {
        return Err("目标程序不属于本次安装".into());
    }
    if other_instance(target) {
        return Err("请先从托盘退出 XwX Deck；当前程序和数据保留".into());
    }
    Ok(())
}
fn finish_uninstall(target: &Path) -> Result<()> {
    registered_target(target)?;
    if other_instance(target) {
        return Err("程序仍在运行".into());
    }
    if let Some(command) = registry(RUN_KEY, "XwX Deck") {
        let executable = command
            .strip_prefix('"')
            .and_then(|s| s.split_once('"').map(|v| v.0));
        if executable.is_some_and(|exe| same_path(Path::new(exe), target)) {
            let mut key = HKEY::default();
            unsafe {
                RegOpenKeyExW(
                    HKEY_CURRENT_USER,
                    PCWSTR(wide(RUN_KEY).as_ptr()),
                    Some(0),
                    KEY_SET_VALUE,
                    &mut key,
                )
            }
            .ok()
            .map_err(|e| e.to_string())?;
            let result = unsafe { RegDeleteValueW(key, PCWSTR(wide("XwX Deck").as_ptr())) };
            unsafe {
                let _ = RegCloseKey(key);
            }
            result.ok().map_err(|e| e.to_string())?;
        }
    }
    let _ = owned_shortcut(target, true)?;
    Ok(())
}
fn owned_shortcut(target: &Path, remove: bool) -> Result<bool> {
    use windows::Win32::{System::Com::*, UI::Shell::*};
    use windows_core::Interface;
    let programs = unsafe { SHGetKnownFolderPath(&FOLDERID_Programs, KF_FLAG_DEFAULT, None) }
        .map_err(|e| e.to_string())?;
    let programs_path = unsafe { programs.to_string() }.map_err(|e| e.to_string())?;
    unsafe {
        CoTaskMemFree(Some(programs.0.cast()));
    }
    let shortcut = PathBuf::from(programs_path).join("XwX Deck.lnk");
    if !shortcut.exists() {
        return Ok(true);
    }
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
        .ok()
        .map_err(|e| e.to_string())?;
    let result = (|| -> Result<bool> {
        let link: IShellLinkW = unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }
            .map_err(|e| e.to_string())?;
        let persist: IPersistFile = link.cast().map_err(|e| e.to_string())?;
        // A modified/unreadable link has no ownership proof; preserve it.
        if unsafe { persist.Load(PCWSTR(path_wide(&shortcut).as_ptr()), STGM_READ) }.is_err() {
            return Ok(false);
        }
        let mut path = vec![0u16; 32768];
        if unsafe { link.GetPath(&mut path, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32) }.is_err()
        {
            return Ok(false);
        }
        let end = path.iter().position(|c| *c == 0).unwrap_or(path.len());
        if same_path(Path::new(&String::from_utf16_lossy(&path[..end])), target) {
            if remove {
                fs::remove_file(&shortcut).map_err(|e| e.to_string())?;
            }
            return Ok(true);
        }
        Ok(false)
    })();
    unsafe {
        CoUninitialize();
    }
    result
}
fn hash(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut bytes = [0u8; 65536];
    loop {
        let n = file.read(&mut bytes).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&bytes[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub fn spawn(source: &Path, expected: &str, version: &str) -> Result<()> {
    let installed = installation().ok_or("当前程序不是已登记的 Setup 安装，未自动安装")?;
    validate(source, version)?;
    if hash(source)? != expected {
        return Err("Setup SHA-256 不匹配".into());
    }
    let helper = source
        .parent()
        .ok_or("无效更新目录")?
        .join(format!("xwx-setup-update-{}.exe", std::process::id()));
    fs::copy(&installed.executable, &helper).map_err(|e| e.to_string())?;
    let mut command = Command::new(helper);
    command
        .arg("--install-setup-update")
        .arg(source)
        .arg("--replace-executable")
        .arg(installed.executable)
        .arg("--expected-sha256")
        .arg(expected)
        .arg("--expected-version")
        .arg(version)
        .arg("--parent-pid")
        .arg(std::process::id().to_string());
    // Resolve before changing working directories; preserve the caller's root.
    if let Some((flag, root)) = launch_root()? {
        command.arg(flag).arg(root);
    }
    if std::env::args().any(|a| a == "--smoke-setup-restart") {
        command.arg("--smoke-setup-restart");
    }
    command
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn wait_parent(pid: u32) -> Result<()> {
    if pid == 0 || pid == std::process::id() {
        return Err("无效更新进程".into());
    }
    let handle = unsafe { OpenProcess(0x00100000, 0, pid) };
    if handle.is_null() {
        return if unsafe { GetLastError() } == 87 {
            Ok(())
        } else {
            Err("无法确认旧程序已退出".into())
        };
    }
    let result = unsafe { WaitForSingleObject(handle, 60000) };
    unsafe {
        CloseHandle(handle);
    }
    if result == 0 {
        Ok(())
    } else {
        Err("旧程序仍运行，未执行 Setup 更新".into())
    }
}
fn other_instance(target: &Path) -> bool {
    let mut pids = vec![0u32; 32768];
    let mut needed = 0;
    if unsafe { K32EnumProcesses(pids.as_mut_ptr(), (pids.len() * 4) as u32, &mut needed) } == 0 {
        return true;
    }
    for pid in pids
        .into_iter()
        .take(needed as usize / 4)
        .filter(|p| *p != std::process::id())
    {
        let handle = unsafe { OpenProcess(0x1000, 0, pid) };
        if handle.is_null() {
            continue;
        }
        let mut name = vec![0u16; 32768];
        let mut size = name.len() as u32;
        let result = unsafe { QueryFullProcessImageNameW(handle, 0, name.as_mut_ptr(), &mut size) };
        unsafe {
            CloseHandle(handle);
        }
        if result != 0
            && same_path(
                &PathBuf::from(String::from_utf16_lossy(&name[..size as usize])),
                target,
            )
        {
            return true;
        }
    }
    false
}
pub fn worker() -> Option<i32> {
    for flag in [
        "--check-setup-target",
        "--check-setup-uninstall",
        "--finish-setup-uninstall",
        "--check-setup-shortcut",
    ] {
        if let Some(target) = crate::argument(flag) {
            let target = PathBuf::from(target);
            let result = if flag == "--finish-setup-uninstall" {
                finish_uninstall(&target)
            } else if flag == "--check-setup-shortcut" {
                owned_shortcut(&target, false).and_then(|owned| {
                    if owned {
                        Ok(())
                    } else {
                        Err("保留已有的其他开始菜单入口".into())
                    }
                })
            } else {
                check_target(&target, flag == "--check-setup-uninstall")
            };
            return Some(match result {
                Ok(()) => 0,
                Err(e) => {
                    eprintln!("{e}");
                    1
                }
            });
        }
    }
    let source = crate::argument("--install-setup-update")?;
    let mut recover_target = None;
    let result = (|| -> Result<Value> {
        let source = PathBuf::from(source);
        let target = PathBuf::from(crate::argument("--replace-executable").ok_or("缺少更新目标")?);
        let expected = crate::argument("--expected-sha256").ok_or("缺少校验值")?;
        let version = crate::argument("--expected-version").ok_or("缺少版本")?;
        let pid = crate::argument("--parent-pid")
            .ok_or("缺少旧进程")?
            .parse::<u32>()
            .map_err(|e| e.to_string())?;
        let helper = std::env::current_exe().map_err(|e| e.to_string())?;
        if source.parent() != helper.parent()
            || source
                .parent()
                .and_then(Path::file_name)
                .and_then(|s| s.to_str())
                != Some("updates")
        {
            return Err("Setup 更新路径不匹配".into());
        }
        // Helpers run outside INSTALLDIR, so verify its registered target directly.
        registered_target(&target)?;
        wait_parent(pid)?;
        if other_instance(&target) {
            return Err("旧程序仍运行，未执行 Setup 更新".into());
        }
        recover_target = Some(target.clone());
        validate(&source, &version)?;
        if hash(&source)? != expected {
            return Err("Setup 安装包已被修改".into());
        }
        let log = source.with_extension("install.log");
        let output = Command::new(&source)
            .arg("/S")
            .arg(format!("/LOG={}", log.display()))
            .creation_flags(0x08000000)
            .output()
            .map_err(|e| e.to_string())?;
        let code = output.status.code().unwrap_or(-1);
        if code != 0 {
            return Err(format!(
                "Setup 更新失败（{code}）；现有配置与数据保留，安装日志：{}",
                log.display()
            ));
        }
        registered_target(&target)?;
        if registry(INSTALL_KEY, "Version").as_deref() != Some(version.as_str())
            || !target.is_file()
            || hash(&target)? != registry(INSTALL_KEY, "BinarySha256").ok_or("缺少安装文件摘要")?
        {
            return Err("Setup 更新后版本或程序文件不匹配".into());
        }
        save_result(&json!({"status":"installed","version":version}));
        let child = restart(&target)?;
        Ok(
            json!({"status":"installed","version":version,"restartPid":child.id(),"rebootRequired":false}),
        )
    })();
    let mut value = match &result {
        Ok(v) => v.clone(),
        Err(e) => json!({"status":"error","error":e}),
    };
    save_result(&value);
    if result.is_err() {
        if let Some(target) = recover_target.filter(|p| p.is_file() && !other_instance(p)) {
            match restart(&target) {
                Ok(child) => value["recoveryPid"] = json!(child.id()),
                Err(e) => value["recoveryError"] = json!(e),
            }
            save_result(&value);
        }
    }
    Some(if result.is_ok() { 0 } else { 1 })
}

fn restart(target: &Path) -> Result<std::process::Child> {
    let mut command = Command::new(target);
    command.current_dir(target.parent().ok_or("无效安装目录")?);
    if let Some((flag, root)) = launch_root()? {
        if flag == "--pilot-root"
            && fs::read_to_string(root.join(".xwx-rust-pilot"))
                .ok()
                .as_deref()
                != Some("isolated-rust-pilot-v1\n")
        {
            return Err("隔离重启目录无效".into());
        }
        command.arg(flag).arg(root);
        if flag == "--pilot-root" && std::env::args().any(|a| a == "--smoke-setup-restart") {
            command.args(["--smoke", "--smoke-setup-restart", "--smoke-exit"]);
        }
    }
    command
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|e| format!("自动重启失败：{e}"))
}
fn launch_root() -> Result<Option<(&'static str, PathBuf)>> {
    for flag in ["--pilot-root", "--data-root"] {
        if let Some(root) = crate::argument(flag) {
            return Ok(Some((
                flag,
                fs::canonicalize(root).map_err(|e| format!("无法保留数据目录：{e}"))?,
            )));
        }
    }
    Ok(None)
}
fn save_result(value: &Value) {
    if let Ok(helper) = std::env::current_exe() {
        let _ = fs::write(helper.with_extension("result.json"), value.to_string());
    }
}
pub fn previous_error(root: &Path) -> Option<String> {
    let mut files = fs::read_dir(root.join("updates"))
        .ok()?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name();
            if !name.to_str()?.starts_with("xwx-setup-update-")
                || !name.to_str()?.ends_with(".result.json")
            {
                return None;
            }
            Some((entry.metadata().ok()?.modified().ok()?, entry.path()))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|item| item.0);
    let value: Value = serde_json::from_slice(&fs::read(files.last()?.1.clone()).ok()?).ok()?;
    (value["status"] == "error").then(|| {
        value["error"]
            .as_str()
            .unwrap_or("Setup 更新失败，配置与数据保留")
            .into()
    })
}
