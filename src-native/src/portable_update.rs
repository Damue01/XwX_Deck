//! Portable replacement runs in a copied native executable after safe shutdown.
#[cfg(target_os = "windows")]
mod windows {
    use sha2::{Digest, Sha256};
    use std::os::windows::process::CommandExt;
    use std::{
        fs,
        io::Read,
        path::{Path, PathBuf},
        process::Command,
        time::Duration,
    };
    fn hash(path: &Path) -> Result<String, String> {
        let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
        }
        Ok(format!("{:x}", hash.finalize()))
    }
    fn regular(path: &Path) -> Result<(), String> {
        let info = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if !path.is_absolute()
            || !info.is_file()
            || info.file_type().is_symlink()
            || path.extension().and_then(|s| s.to_str()) != Some("exe")
        {
            return Err("无效便携版路径".into());
        }
        Ok(())
    }
    pub fn spawn(source: &Path) -> Result<(), String> {
        regular(source)?;
        let target = std::env::current_exe().map_err(|e| e.to_string())?;
        regular(&target)?;
        if target.starts_with(source.parent().ok_or("无效下载目录")?) {
            return Err("临时验证程序不能替换自身".into());
        }
        let helper = source
            .parent()
            .unwrap()
            .join(format!("xwx-native-update-{}.exe", std::process::id()));
        fs::copy(&target, &helper).map_err(|e| e.to_string())?;
        Command::new(&helper)
            .args(["--install-update"])
            .arg(source)
            .arg("--replace-executable")
            .arg(&target)
            .arg("--expected-sha256")
            .arg(hash(source)?)
            .arg("--parent-pid")
            .arg(std::process::id().to_string())
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn idle_for_nightly() -> bool {
        use chrono::Timelike;
        #[repr(C)]
        struct LastInput {
            size: u32,
            time: u32,
        }
        #[link(name = "user32")]
        extern "system" {
            fn GetLastInputInfo(info: *mut LastInput) -> i32;
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GetTickCount() -> u32;
        }
        let mut input = LastInput {
            size: std::mem::size_of::<LastInput>() as u32,
            time: 0,
        };
        let hour = chrono::Local::now().hour();
        unsafe {
            (2..5).contains(&hour)
                && GetLastInputInfo(&mut input) != 0
                && GetTickCount().wrapping_sub(input.time) >= 900000
        }
    }
    pub fn worker() -> Option<i32> {
        let args: Vec<_> = std::env::args().collect();
        if !args.iter().any(|s| s == "--install-update") {
            return None;
        }
        let argument = |name: &str| {
            args.windows(2)
                .find(|a| a[0] == name)
                .map(|a| a[1].clone())
                .ok_or_else(|| format!("Missing {name}"))
        };
        let result = (|| -> Result<(), String> {
            let source = PathBuf::from(argument("--install-update")?);
            let target = PathBuf::from(argument("--replace-executable")?);
            let expected = argument("--expected-sha256")?;
            let pid = argument("--parent-pid")?
                .parse::<u32>()
                .map_err(|e| e.to_string())?;
            regular(&source)?;
            regular(&target)?;
            let executable = std::env::current_exe().map_err(|e| e.to_string())?;
            if pid == 0
                || source == target
                || source.parent() != executable.parent()
                || source
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|s| s.to_str())
                    != Some("updates")
                || hash(&source)? != expected
            {
                return Err("更新路径或 SHA-256 不匹配".into());
            }
            let mut gone = false;
            for _ in 0..120 {
                let output = Command::new("tasklist.exe")
                    .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
                    .creation_flags(0x08000000)
                    .output()
                    .map_err(|e| e.to_string())?;
                if !output.status.success() {
                    return Err("无法确认旧程序已退出".into());
                }
                let alive = String::from_utf8_lossy(&output.stdout).lines().any(|l| {
                    l.split(',')
                        .nth(1)
                        .is_some_and(|v| v.trim_matches('"') == pid.to_string())
                });
                if !alive {
                    gone = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            if !gone {
                return Err("旧程序仍运行，未替换".into());
            }
            if hash(&source)? != expected {
                return Err("安装包已被修改".into());
            }
            let backup = target.with_extension(format!("exe.previous-{}", &hash(&target)?[..16]));
            if backup.exists() {
                return Err("检测到已有更新恢复备份，请先检查".into());
            }
            fs::rename(&target, &backup).map_err(|e| e.to_string())?;
            let replaced = (|| -> Result<(), String> {
                fs::copy(&source, &target).map_err(|e| e.to_string())?;
                if hash(&target)? != expected {
                    return Err("替换后校验失败".into());
                }
                Ok(())
            })();
            if let Err(e) = replaced {
                let _ = fs::remove_file(&target);
                fs::rename(&backup, &target).map_err(|e| e.to_string())?;
                return Err(e);
            }
            Command::new(&target)
                .current_dir(target.parent().unwrap())
                .creation_flags(0x08000000)
                .spawn()
                .map_err(|_| {
                    format!(
                        "新版已替换但自动启动失败，请手动打开 {}；恢复备份已保留在 {}",
                        target.display(),
                        backup.display()
                    )
                })?;
            Ok(())
        })();
        if let Err(error) = result {
            if let Ok(path) = std::env::current_exe() {
                let _ = fs::write(path.with_extension("error.txt"), error);
            }
            Some(1)
        } else {
            Some(0)
        }
    }
}
#[cfg(target_os = "windows")]
pub use windows::{idle_for_nightly, spawn, worker};
