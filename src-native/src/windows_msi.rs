//! Per-user Windows Installer updates. MSI owns program files; user data stays
//! in the unchanged xwx-deck namespace, outside the installation directory.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    ffi::c_void,
    fs,
    os::windows::{ffi::OsStrExt, process::CommandExt},
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
};
use windows::{core::PCWSTR, Win32::System::Registry::*};
type Result<T> = std::result::Result<T, String>;
const INSTALL_KEY: &str = r"Software\XwX Deck\Installation";
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const APP_FILE: &str = "XwX Deck.exe";
#[link(name = "msi")]
extern "system" {
    fn MsiOpenDatabaseW(path: *const u16, persist: *const u16, handle: *mut u32) -> u32;
    fn MsiDatabaseOpenViewW(database: u32, query: *const u16, view: *mut u32) -> u32;
    fn MsiViewExecute(view: u32, record: u32) -> u32;
    fn MsiViewFetch(view: u32, record: *mut u32) -> u32;
    fn MsiRecordGetStringW(record: u32, field: u32, value: *mut u16, length: *mut u32) -> u32;
    fn MsiCloseHandle(handle: u32) -> u32;
    fn MsiQueryProductStateW(product: *const u16) -> i32;
    fn MsiGetProductInfoW(
        product: *const u16,
        property: *const u16,
        value: *mut u16,
        length: *mut u32,
    ) -> u32;
}
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
    fn GetSystemDirectoryW(path: *mut u16, length: u32) -> u32;
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn path_wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
pub fn upgrade_code() -> &'static str {
    static CONTRACT: OnceLock<Value> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        serde_json::from_str(include_str!("../../release-contract.json"))
            .expect("validated release contract")
    })["platforms"]["windows"]["upgradeCode"]
        .as_str()
        .expect("validated MSI upgrade identity")
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
        _ => false,
    }
}
fn product_info(product: &str, property: &str) -> Option<String> {
    let mut value = vec![0u16; 32768];
    let mut length = value.len() as u32;
    if unsafe {
        MsiGetProductInfoW(
            wide(product).as_ptr(),
            wide(property).as_ptr(),
            value.as_mut_ptr(),
            &mut length,
        )
    } != 0
    {
        return None;
    }
    Some(String::from_utf16_lossy(&value[..length as usize]))
}
#[derive(Clone)]
pub struct Installation {
    pub executable: PathBuf,
}
pub fn installation() -> Option<Installation> {
    let executable = std::env::current_exe().ok()?;
    let location = PathBuf::from(registry(INSTALL_KEY, "Path")?);
    if registry(INSTALL_KEY, "UpgradeCode")? != upgrade_code()
        || !same_path(&location.join(APP_FILE), &executable)
    {
        return None;
    }
    let product = registry(INSTALL_KEY, "ProductCode")?;
    if unsafe { MsiQueryProductStateW(wide(&product).as_ptr()) } != 5
        || product_info(&product, "ProductName")?.as_str() != "XwX Deck"
        || !same_path(
            &PathBuf::from(product_info(&product, "InstallLocation")?),
            &location,
        )
    {
        return None;
    }
    Some(Installation {
        executable: location.join(APP_FILE),
    })
}
struct MsiHandle(u32);
impl Drop for MsiHandle {
    fn drop(&mut self) {
        unsafe {
            MsiCloseHandle(self.0);
        }
    }
}
fn msi_result(code: u32) -> Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(format!("Windows Installer 返回 {code}"))
    }
}
fn property(database: &MsiHandle, name: &str) -> Result<String> {
    let query = wide(&format!(
        "SELECT `Value` FROM `Property` WHERE `Property`='{name}'"
    ));
    let mut view = 0;
    msi_result(unsafe { MsiDatabaseOpenViewW(database.0, query.as_ptr(), &mut view) })?;
    let view = MsiHandle(view);
    msi_result(unsafe { MsiViewExecute(view.0, 0) })?;
    let mut record = 0;
    let fetched = unsafe { MsiViewFetch(view.0, &mut record) };
    if fetched == 259 {
        return Ok(String::new());
    }
    msi_result(fetched)?;
    let record = MsiHandle(record);
    let mut value = vec![0u16; 32768];
    let mut length = value.len() as u32;
    msi_result(unsafe { MsiRecordGetStringW(record.0, 1, value.as_mut_ptr(), &mut length) })?;
    Ok(String::from_utf16_lossy(&value[..length as usize]))
}
pub fn validate(source: &Path, version: &str) -> Result<()> {
    let info = fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if !source.is_absolute()
        || !info.is_file()
        || info.file_type().is_symlink()
        || source.extension().and_then(|s| s.to_str()) != Some("msi")
    {
        return Err("无效 MSI 更新文件".into());
    }
    let mut database = 0;
    msi_result(unsafe {
        MsiOpenDatabaseW(path_wide(source).as_ptr(), std::ptr::null(), &mut database)
    })?;
    let database = MsiHandle(database);
    if property(&database, "UpgradeCode")?.trim_matches(['{', '}']) != upgrade_code()
        || property(&database, "ProductName")? != "XwX Deck"
        || property(&database, "ProductVersion")? != version
        || !property(&database, "ALLUSERS")?.is_empty()
    {
        return Err("MSI 的产品、版本或按用户安装范围不匹配".into());
    }
    Ok(())
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
    let installed = installation().ok_or("当前程序不是已登记的 MSI 安装，未自动安装")?;
    validate(source, version)?;
    if hash(source)? != expected {
        return Err("MSI SHA-256 不匹配".into());
    }
    let helper = source
        .parent()
        .ok_or("无效更新目录")?
        .join(format!("xwx-msi-update-{}.exe", std::process::id()));
    fs::copy(&installed.executable, &helper).map_err(|e| e.to_string())?;
    let mut command = Command::new(helper);
    command
        .arg("--install-msi-update")
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
    if std::env::args().any(|a| a == "--smoke-msi-restart") {
        command.arg("--smoke-msi-restart");
    }
    command
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn system_msiexec() -> Result<PathBuf> {
    let mut path = vec![0u16; 32768];
    let length = unsafe { GetSystemDirectoryW(path.as_mut_ptr(), path.len() as u32) };
    if length == 0 || length as usize >= path.len() {
        return Err("无法定位 Windows Installer".into());
    }
    Ok(PathBuf::from(String::from_utf16_lossy(&path[..length as usize])).join("msiexec.exe"))
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
        Err("旧程序仍运行，未执行 MSI 更新".into())
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
fn prepare_uninstall() -> Result<()> {
    // Installer may already report a transitional product state during removal.
    // Check the registered executable directly instead of treating that as portable.
    let location = PathBuf::from(registry(INSTALL_KEY, "Path").ok_or("安装登记不存在")?);
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    if registry(INSTALL_KEY, "UpgradeCode").as_deref() != Some(upgrade_code())
        || !same_path(&location.join(APP_FILE), &executable)
    {
        return Err("卸载程序与当前用户安装不匹配".into());
    }
    let installed = Installation { executable };
    if other_instance(&installed.executable) {
        return Err("请先从托盘退出 XwX Deck，再卸载；当前进程和数据均保留".into());
    }
    // Major upgrades retain the same launch path and the user's startup choice.
    if std::env::args().skip(2).any(|arg| arg.starts_with('{')) {
        return Ok(());
    }
    if let Some(command) = registry(RUN_KEY, "XwX Deck") {
        let executable = command
            .strip_prefix('"')
            .and_then(|s| s.split_once('"').map(|v| v.0));
        if executable.is_some_and(|exe| same_path(Path::new(exe), &installed.executable)) {
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
    Ok(())
}
pub fn worker() -> Option<i32> {
    if std::env::args().any(|a| a == "--prepare-msi-uninstall") {
        return Some(match prepare_uninstall() {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("{e}");
                1
            }
        });
    }
    let source = crate::argument("--install-msi-update")?;
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
            return Err("MSI 更新路径不匹配".into());
        }
        // Helpers run outside INSTALLDIR, so verify its registered target directly.
        let location = PathBuf::from(registry(INSTALL_KEY, "Path").ok_or("安装登记不存在")?);
        let product = registry(INSTALL_KEY, "ProductCode").ok_or("安装登记不存在")?;
        if registry(INSTALL_KEY, "UpgradeCode").as_deref() != Some(upgrade_code())
            || !same_path(&location.join(APP_FILE), &target)
            || unsafe { MsiQueryProductStateW(wide(&product).as_ptr()) } != 5
        {
            return Err("MSI 更新目标与当前用户安装不一致".into());
        }
        wait_parent(pid)?;
        if other_instance(&target) {
            return Err("旧程序仍运行，未执行 MSI 更新".into());
        }
        recover_target = Some(target.clone());
        validate(&source, &version)?;
        if hash(&source)? != expected {
            return Err("MSI 安装包已被修改".into());
        }
        let log = source.with_extension("install.log");
        let mut directory = std::ffi::OsString::from("INSTALLDIR=\"");
        directory.push(&location);
        directory.push("\"");
        // /qn is already noninteractive; capture diagnostics without a console.
        let output = Command::new(system_msiexec()?)
            .arg("/i")
            .arg(&source)
            .args([
                "/qn",
                "/norestart",
                "REBOOT=ReallySuppress",
                "MSIRESTARTMANAGERCONTROL=DisableShutdown",
            ])
            .raw_arg(directory)
            .arg("/L*v")
            .arg(&log)
            .output()
            .map_err(|e| e.to_string())?;
        let code = output.status.code().unwrap_or(-1);
        if ![0, 3010].contains(&code) {
            return Err(format!(
                "MSI 更新失败（{code}）；现有配置与数据保留，安装日志：{}",
                log.display()
            ));
        }
        if code == 3010 {
            return Err("MSI 更新需要重启 Windows 才能完成；配置与数据已保留".into());
        }
        let current = registry(INSTALL_KEY, "ProductCode").ok_or("更新后的安装登记不存在")?;
        if product_info(&current, "VersionString").as_deref() != Some(version.as_str())
            || !target.is_file()
        {
            return Err("MSI 更新后版本或程序文件不匹配".into());
        }
        save_result(&json!({"status":"installed","version":version}));
        let child = restart(&target)?;
        Ok(
            json!({"status":"installed","version":version,"restartPid":child.id(),"rebootRequired":code==3010}),
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
        if flag == "--pilot-root" && std::env::args().any(|a| a == "--smoke-msi-restart") {
            command.args(["--smoke", "--smoke-msi-restart", "--smoke-exit"]);
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
            if !name.to_str()?.starts_with("xwx-msi-update-")
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
            .unwrap_or("MSI 更新失败，配置与数据保留")
            .into()
    })
}
