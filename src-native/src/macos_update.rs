//! Native macOS updates retain the existing controlled DMG feed. Apple verifies
//! the app's Developer ID, team, bundle identity and notarization before an
//! atomic same-volume swap. No shell script, elevation, or quarantine bypass.
use serde::{Deserialize, Serialize};
use std::os::unix::{ffi::OsStrExt, fs::DirBuilderExt};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
type Result<T> = std::result::Result<T, String>;

fn run(command: &str, args: &[&std::ffi::OsStr]) -> Result<String> {
    let output = Command::new(command)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "{}：{}",
            Path::new(command)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().into())
}
fn plist(app: &Path, key: &str) -> Result<String> {
    let command = format!("Print :{key}");
    let path = app.join("Contents/Info.plist");
    run(
        "/usr/libexec/PlistBuddy",
        &["-c".as_ref(), command.as_ref(), path.as_os_str()],
    )
}
fn version(value: &str) -> Result<Vec<u64>> {
    let parts = value
        .split('.')
        .map(str::parse)
        .collect::<std::result::Result<Vec<u64>, _>>()
        .map_err(|_| "无效应用版本".to_string())?;
    if parts.len() != 3 {
        return Err("无效应用版本".into());
    }
    Ok(parts)
}
fn team() -> String {
    serde_json::from_str::<serde_json::Value>(include_str!(
        "../../assets/macos/native-release.json"
    ))
    .expect("Apple release config")["teamId"]
        .as_str()
        .expect("Apple team")
        .into()
}
fn requirement(id: &str) -> Result<String> {
    if !["app.xwxdeck.desktop", "app.xwxdeck.validation"].contains(&id) {
        return Err("应用身份不匹配".into());
    }
    Ok(format!("=anchor apple generic and identifier \"{id}\" and certificate leaf[subject.OU] = \"{}\" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists", team()))
}
fn verify(app: &Path, id: &str, notarized: bool) -> Result<()> {
    let req = requirement(id)?;
    run(
        "/usr/bin/codesign",
        &[
            "--verify".as_ref(),
            "--deep".as_ref(),
            "--strict".as_ref(),
            "-R".as_ref(),
            req.as_ref(),
            app.as_os_str(),
        ],
    )?;
    if plist(app, "CFBundleIdentifier")? != id {
        return Err("应用身份不匹配".into());
    }
    let executable = plist(app, "CFBundleExecutable")?;
    if Path::new(&executable).components().count() != 1 || executable != env!("CARGO_PKG_NAME") {
        return Err("无效应用可执行文件".into());
    }
    let binary = app.join("Contents/MacOS").join(executable);
    if !binary.starts_with(app.join("Contents/MacOS"))
        || fs::symlink_metadata(&binary)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
    {
        return Err("无效应用可执行文件".into());
    }
    let arch = run("/usr/bin/lipo", &["-archs".as_ref(), binary.as_os_str()])?;
    let expected = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x86_64"
    };
    if !arch.split_whitespace().any(|s| s == expected) {
        return Err("更新包架构不匹配".into());
    }
    let helper = app.join("Contents/Helpers/update-helper");
    if !fs::symlink_metadata(&helper)
        .map_err(|_| "更新助手缺失，请重新安装完整的签名应用".to_string())?
        .is_file()
    {
        return Err("更新助手不是普通文件".into());
    }
    let helper_requirement = format!("=anchor apple generic and identifier \"{id}.update-helper\" and certificate leaf[subject.OU] = \"{}\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists", team());
    run(
        "/usr/bin/codesign",
        &[
            "--verify".as_ref(),
            "--strict".as_ref(),
            "-R".as_ref(),
            helper_requirement.as_ref(),
            helper.as_os_str(),
        ],
    )?;
    if notarized {
        run(
            "/usr/sbin/spctl",
            &[
                "--assess".as_ref(),
                "--type".as_ref(),
                "execute".as_ref(),
                app.as_os_str(),
            ],
        )?;
    }
    Ok(())
}
fn current_app() -> Result<PathBuf> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let app = exe
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or("无法定位应用")?;
    regular_app(app)?;
    if exe != app.join("Contents/MacOS").join(env!("CARGO_PKG_NAME")) {
        return Err("需要从已安装应用运行更新".into());
    }
    Ok(app.into())
}
fn regular_app(app: &Path) -> Result<()> {
    if !app.is_absolute()
        || app.extension().is_none_or(|s| s != "app")
        || !fs::symlink_metadata(app)
            .map_err(|e| e.to_string())?
            .is_dir()
        || fs::canonicalize(app).map_err(|e| e.to_string())? != app
    {
        return Err("应用路径无效或含符号链接".into());
    }
    Ok(())
}
fn idle_policy(hour: u32, seconds: f64) -> bool {
    (2..5).contains(&hour) && seconds.is_finite() && seconds >= 900.0
}
pub fn idle_for_nightly() -> bool {
    use chrono::Timelike;
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    }
    // Combined session state includes hardware and remote-control input.
    let seconds = unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) };
    idle_policy(chrono::Local::now().hour(), seconds)
}

pub fn available() -> bool {
    current_app()
        .and_then(|app| verify(&app, &plist(&app, "CFBundleIdentifier")?, false))
        .is_ok()
}
pub fn current_version() -> Option<String> {
    current_app()
        .and_then(|app| plist(&app, "CFBundleShortVersionString"))
        .ok()
}

#[derive(Serialize, Deserialize)]
pub struct Job {
    target: PathBuf,
    staged: PathBuf,
    helper: PathBuf,
    root: PathBuf,
    bundle_id: String,
    version: String,
    old_version: String,
    parent_pid: u32,
    restart_args: Vec<String>,
}
pub fn discard(job: Job) {
    if let Some(directory) = job.helper.parent() {
        let _ = fs::remove_dir_all(directory);
    }
}
pub fn prepare(dmg: &Path, expected: &str, root: &Path) -> Result<Job> {
    version(expected)?;
    let target = current_app()?;
    let id = plist(&target, "CFBundleIdentifier")?;
    verify(&target, &id, false)?;
    let old_version = plist(&target, "CFBundleShortVersionString")?;
    if version(expected)? <= version(&old_version)? {
        return Err("更新版本必须高于当前版本".into());
    }
    let dmg_requirement=format!("=anchor apple generic and certificate leaf[subject.OU] = \"{}\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists",team());
    run(
        "/usr/bin/codesign",
        &[
            "--verify".as_ref(),
            "--strict".as_ref(),
            "-R".as_ref(),
            dmg_requirement.as_ref(),
            dmg.as_os_str(),
        ],
    )?;
    run(
        "/usr/sbin/spctl",
        &[
            "--assess".as_ref(),
            "--type".as_ref(),
            "open".as_ref(),
            "--context".as_ref(),
            "context:primary-signature".as_ref(),
            dmg.as_os_str(),
        ],
    )?;
    let directory = target.parent().ok_or("无效应用目录")?.join(format!(
        ".xwx-update-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    ));
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .map_err(|_| "应用目录不可写，请将应用安装到有写入权限的应用程序目录后重试".to_string())?;
    let result = (|| -> Result<Job> {
        let mount = directory.join("mount");
        fs::create_dir(&mount).map_err(|e| e.to_string())?;
        run(
            "/usr/bin/hdiutil",
            &[
                "attach".as_ref(),
                "-readonly".as_ref(),
                "-nobrowse".as_ref(),
                "-mountpoint".as_ref(),
                mount.as_os_str(),
                dmg.as_os_str(),
            ],
        )?;
        let copied = (|| -> Result<PathBuf> {
            let candidates = fs::read_dir(&mount)
                .map_err(|e| e.to_string())?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|e| e == "app"))
                .collect::<Vec<_>>();
            if candidates.len() != 1 {
                return Err("更新映像必须只含一个应用".into());
            }
            let source = &candidates[0];
            if fs::symlink_metadata(source)
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink()
            {
                return Err("更新应用不能是符号链接".into());
            }
            verify(source, &id, true)?;
            if plist(source, "CFBundleShortVersionString")? != expected {
                return Err("更新包版本与发布清单不匹配".into());
            }
            let staged = directory.join("replacement.app");
            run("/usr/bin/ditto", &[source.as_os_str(), staged.as_os_str()])?;
            verify(&staged, &id, true)?;
            Ok(staged)
        })();
        let detached = run("/usr/bin/hdiutil", &["detach".as_ref(), mount.as_os_str()]);
        detached?;
        let staged = copied?;
        let helper = directory.join("update-helper");
        fs::copy(target.join("Contents/Helpers/update-helper"), &helper)
            .map_err(|e| e.to_string())?;
        let args = std::env::args().collect::<Vec<_>>();
        let restart_args = if args.iter().any(|a| a == "--pilot-root") {
            let mut result = vec!["--pilot-root".into(), root.to_string_lossy().into_owned()];
            if args.iter().any(|a| a == "--smoke-macos-update") {
                result.push("--smoke-update-restarted".into());
            }
            result
        } else {
            vec![]
        };
        Ok(Job {
            target,
            staged,
            helper,
            root: root.into(),
            bundle_id: id,
            version: expected.into(),
            old_version,
            parent_pid: std::process::id(),
            restart_args,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&directory);
    }
    result
}
pub fn launch(job: Job) -> Result<()> {
    let path = job.helper.with_extension("json");
    fs::write(&path, serde_json::to_vec(&job).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let log = fs::File::create(job.helper.with_extension("log")).map_err(|e| e.to_string())?;
    Command::new(&job.helper)
        .arg("--apply-macos-update")
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn apply(job: &Job) -> Result<()> {
    regular_app(&job.target)?;
    let directory = job.helper.parent().ok_or("无效更新目录")?;
    if std::env::current_exe().map_err(|e| e.to_string())? != job.helper
        || directory.parent() != job.target.parent()
        || job.staged != directory.join("replacement.app")
        || job.parent_pid == 0
        || job.parent_pid == std::process::id()
    {
        return Err("更新路径不匹配".into());
    }
    if !job.restart_args.is_empty()
        && (job.restart_args.len() < 2
            || job.restart_args[0] != "--pilot-root"
            || Path::new(&job.restart_args[1]) != job.root
            || !job.root.join(".xwx-rust-pilot").is_file()
            || job.restart_args.len() > 3
            || job
                .restart_args
                .get(2)
                .is_some_and(|a| a != "--smoke-update-restarted"))
    {
        return Err("无效隔离重启参数".into());
    }
    unsafe extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    let mut gone = false;
    for _ in 0..120 {
        // Signal zero only observes liveness; never terminate a process.
        if unsafe { kill(job.parent_pid as i32, 0) } != 0 {
            gone = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    if !gone {
        return Err("旧程序仍运行，未替换；请正常退出后重试".into());
    }
    verify(&job.target, &job.bundle_id, false)?;
    if plist(&job.target, "CFBundleShortVersionString")? != job.old_version
        || version(&job.version)? <= version(&job.old_version)?
    {
        return Err("当前应用已变化，未替换".into());
    }
    regular_app(&job.staged)?;
    verify(&job.staged, &job.bundle_id, true)?;
    if plist(&job.staged, "CFBundleShortVersionString")? != job.version {
        return Err("待安装应用版本已变化".into());
    }
    unsafe extern "C" {
        fn renamex_np(
            from: *const std::ffi::c_char,
            to: *const std::ffi::c_char,
            flags: u32,
        ) -> i32;
    }
    let from =
        std::ffi::CString::new(job.staged.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let to =
        std::ffi::CString::new(job.target.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    // RENAME_SWAP: both bundles change names in one filesystem operation.
    if unsafe { renamex_np(from.as_ptr(), to.as_ptr(), 2) } != 0 {
        return Err(format!(
            "应用替换失败，原版本保留：{}",
            std::io::Error::last_os_error()
        ));
    }
    open_app(job)?;
    Ok(())
}
fn open_app(job: &Job) -> Result<()> {
    let mut command = Command::new("/usr/bin/open");
    command.arg("-n").arg(&job.target);
    if !job.restart_args.is_empty() {
        command.arg("--args").args(&job.restart_args);
    }
    let output = command
        .output()
        .map_err(|e| format!("新版已安装，请手动打开 {}：{e}", job.target.display()))?;
    if !output.status.success() {
        return Err(format!(
            "新版已安装但自动打开失败，请手动打开 {}：{}",
            job.target.display(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

pub fn worker() -> Option<i32> {
    let args = std::env::args().collect::<Vec<_>>();
    let index = args.iter().position(|a| a == "--apply-macos-update")?;
    let result = (|| -> Result<()> {
        let path = PathBuf::from(args.get(index + 1).ok_or("缺少更新任务")?);
        let helper = std::env::current_exe().map_err(|e| e.to_string())?;
        if path != helper.with_extension("json") {
            return Err("无效更新任务路径".into());
        }
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        if bytes.len() > 16384 {
            return Err("更新任务过长".into());
        }
        let job: Job = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let applied = apply(&job);
        let installed = plist(&job.target, "CFBundleShortVersionString")
            .ok()
            .as_deref()
            == Some(&job.version);
        let report = serde_json::json!({"status":if applied.is_ok(){"completed"}else{"error"},"version":job.version,"installed":installed,"restartRequested":applied.is_ok(),"error":applied.as_ref().err(),"application":job.target});
        let report_path = job.root.join("updates/macos-install-result.json");
        fs::create_dir_all(report_path.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(
            &report_path,
            serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        if applied.is_ok() {
            let _ = fs::remove_dir_all(helper.parent().unwrap());
        } else if !installed {
            unsafe extern "C" {
                fn kill(pid: i32, signal: i32) -> i32;
            }
            // A failure before the swap keeps the original bundle. Reopen that
            // verified unchanged app to show the saved error, unless it is still running.
            if unsafe { kill(job.parent_pid as i32, 0) } != 0
                && regular_app(&job.target).is_ok()
                && verify(&job.target, &job.bundle_id, false).is_ok()
                && plist(&job.target, "CFBundleShortVersionString")
                    .ok()
                    .as_deref()
                    == Some(&job.old_version)
            {
                let _ = open_app(&job);
            }
        }
        applied
    })();
    if let Err(error) = &result {
        eprintln!("{error}");
    }
    Some(if result.is_ok() { 0 } else { 1 })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unattended_update_requires_night_window_and_fifteen_idle_minutes() {
        assert!(idle_policy(2, 900.0));
        assert!(idle_policy(4, 1000.0));
        for (hour, seconds) in [
            (1, 1000.0),
            (5, 1000.0),
            (3, 899.0),
            (3, f64::NAN),
            (3, f64::INFINITY),
        ] {
            assert!(!idle_policy(hour, seconds));
        }
    }
    #[test]
    fn update_versions_reject_invalid_or_downgraded() {
        assert!(version("1.1.8").unwrap() > version("1.1.7").unwrap());
        for invalid in ["1.1", "1.1.8-beta", "1.1.8.0", "one.1.8"] {
            assert!(version(invalid).is_err());
        }
    }
    #[test]
    fn developer_id_requirement_pins_identity_and_team() {
        let req = requirement("app.xwxdeck.desktop").unwrap();
        assert!(
            req.contains("anchor apple generic")
                && req.contains(&team())
                && req.contains("100.6.1.13")
        );
        assert!(requirement("app.other.desktop").is_err());
        assert!(requirement("app.xwxdeck.desktop\" or true").is_err());
    }
}
