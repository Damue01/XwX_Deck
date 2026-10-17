//! Shares the legacy v1 writer lease and adds an OS lock between native writers.
//! A reused/live/unknown PID is never removed. Stale removal compares bytes.
use super::*;
pub(super) struct Lease {
    path: PathBuf,
    source: String,
    _lock: fs::File,
}
impl Lease {
    pub(super) fn acquire(root: &Path) -> Result<Self> {
        if !same_physical_path(root)? {
            return Err("Trace 写入目录经过符号链接，未写入".into());
        }
        let path = root.join("trace-writer.lock");
        let native = root.join(".native-trace-writer.lock");
        match fs::symlink_metadata(&native) {
            Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
                return Err("Trace 写入锁不是普通文件，原记录保留".into())
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(err(error)),
            _ => {}
        }
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&native)
            .map_err(err)?;
        lock.try_lock()
            .map_err(|_| "Trace 数据目录已有原生写入者，原记录保持不变")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            lock.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(err)?;
        }
        if let Some(source) = read(&path)? {
            if source.len() > 4096 {
                return Err("Trace 写入租约超过上限，未替换".into());
            }
            let record: Value = serde_json::from_str(&source)
                .map_err(|_| "Trace 写入租约正在初始化或损坏，原记录已保留")?;
            let pid = record["pid"]
                .as_u64()
                .filter(|p| *p > 0 && *p <= i32::MAX as u64)
                .ok_or("Trace 写入租约 PID 无效，已保留")? as u32;
            if record["version"] != 1
                || text(&record, "leaseId").is_empty()
                || text(&record, "startedAt").is_empty()
            {
                return Err("Trace 写入租约版本或身份无效，已保留".into());
            }
            if super::legacy_helper::process_present(pid) {
                return Err("Trace 数据目录已有写入进程或身份无法确认，请先停止原写入者；未替换租约或修改历史".into());
            }
            if read(&path)?.as_deref() != Some(&source) {
                return Err("Trace 写入租约发生外部变化，未替换".into());
            }
            fs::remove_file(&path).map_err(err)?;
        }
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|_| "Trace 租约随机数不可用")?;
        let id: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let source=json!({"version":1,"pid":std::process::id(),"leaseId":id,"startedAt":storage::iso(millis())}).to_string();
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| "Trace 写入租约已被另一进程创建，未覆盖")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(err)?;
        }
        use std::io::Write;
        file.write_all(source.as_bytes()).map_err(err)?;
        file.sync_all().map_err(err)?;
        Ok(Self {
            path,
            source,
            _lock: lock,
        })
    }
    pub(super) fn validate(&self) -> Result<()> {
        if read(&self.path)?.as_deref() != Some(&self.source) {
            return Err(
                "Trace 写入租约已被外部修改，停止写入并保留所有历史；请停止 Trace 后检查原写入者"
                    .into(),
            );
        }
        Ok(())
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if read(&self.path).is_ok_and(|s| s.as_deref() == Some(&self.source)) {
            let _ = fs::remove_file(&self.path);
        }
    }
}
