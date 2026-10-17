//! Reset data is archived after the manager exits. The journal stays beside the
//! data directory, so a crash never destroys the only copy of recovery state.
use super::*;
use std::io::Write;

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
struct Stamp {
    identity: String,
    directory: bool,
    sha256: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Move {
    source: PathBuf,
    destination: PathBuf,
    stamp: Stamp,
}
static RPC: std::sync::Mutex<(usize, bool)> = std::sync::Mutex::new((0, false));
static COMMITTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub(crate) struct RpcGuard(bool);
pub(super) fn admit_rpc(method: &str) -> Result<RpcGuard> {
    let mut state = RPC.lock().map_err(|_| "操作状态不可用")?;
    if state.1 {
        return Err("正在重置，请等待应用重新启动".into());
    }
    let reset = method == "resetApplication";
    if reset {
        if state.0 != 0 {
            return Err("后台操作仍在运行，请完成或取消后再次重置".into());
        }
        state.1 = true;
    } else {
        state.0 += 1;
    }
    Ok(RpcGuard(reset))
}
impl Drop for RpcGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = RPC.lock() {
            if self.0 {
                if !COMMITTED.load(Ordering::SeqCst) {
                    state.1 = false;
                }
            } else {
                state.0 = state.0.saturating_sub(1);
            }
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Job {
    version: u32,
    root: PathBuf,
    backup: PathBuf,
    manager_pid: u32,
    isolated: bool,
    root_identity: Stamp,
    moves: Vec<Move>,
    client_files: Vec<(PathBuf, Stamp)>,
    executable: PathBuf,
    relaunch_args: Vec<String>,
    relaunch: bool,
    stage: String,
    #[serde(default)]
    worker_pid: u32,
    #[serde(default)]
    test_pause: bool,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    pub(crate) clear_browser_stores: bool,
}
fn stamp(path: &Path) -> Result<Stamp> {
    let metadata = fs::symlink_metadata(path).map_err(err)?;
    if metadata.file_type().is_symlink() || !(metadata.is_dir() || metadata.is_file()) {
        return Err("重置路径类型已变化，保留原文件与恢复现场".into());
    }
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", metadata.dev(), metadata.ino())
    };
    #[cfg(windows)]
    let identity = {
        use std::os::windows::fs::MetadataExt;
        format!("{}", metadata.creation_time())
    };
    #[cfg(not(any(unix, windows)))]
    let identity = format!("{:?}", metadata.created().map_err(err)?);
    let sha256 = if metadata.is_file() {
        if metadata.len() > 128 * 1024 * 1024 {
            return Err("重置文件超过校验上限，保留原文件".into());
        }
        Some(storage::digest(&fs::read(path).map_err(err)?))
    } else {
        None
    };
    Ok(Stamp {
        identity,
        directory: metadata.is_dir(),
        sha256,
    })
}
fn private_directory(path: &Path) -> Result<()> {
    fs::create_dir(path).map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(err)?;
    }
    Ok(())
}
fn present(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(err(error)),
    }
}
fn exclusive_move(source: &Path, destination: &Path) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        unsafe extern "C" {
            fn renamex_np(
                source: *const std::ffi::c_char,
                destination: *const std::ffi::c_char,
                flags: u32,
            ) -> i32;
        }
        let source = std::ffi::CString::new(source.as_os_str().as_bytes()).map_err(err)?;
        let destination =
            std::ffi::CString::new(destination.as_os_str().as_bytes()).map_err(err)?;
        // RENAME_EXCL is defined by the platform's sys/stdio.h. No existing
        // destination (including a dangling link) may be replaced.
        if unsafe { renamex_np(source.as_ptr(), destination.as_ptr(), 4) } != 0 {
            return Err(err(std::io::Error::last_os_error()));
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn MoveFileExW(source: *const u16, destination: *const u16, flags: u32) -> i32;
        }
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 8) } == 0 {
            return Err(err(std::io::Error::last_os_error()));
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (source, destination);
        Err("此平台尚未验证独占归档，原数据保留".into())
    }
}
fn safe_directory(path: &Path) -> Result<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("重置目录必须是绝对路径".into());
    }
    if !same_physical_path(path)? || !fs::symlink_metadata(path).map_err(err)?.is_dir() {
        return Err("重置目录经过符号链接或类型已变化，原数据保留".into());
    }
    Ok(())
}
fn gate(root: &Path) -> Result<PathBuf> {
    let parent = root.parent().ok_or("不能重置文件系统根目录")?;
    Ok(parent.join(format!(
        ".xwxdeck-reset-{}.json",
        &storage::digest(root.to_string_lossy().as_bytes())[..24]
    )))
}
fn job_path(job: &Job) -> PathBuf {
    job.backup.join("job.json")
}
fn save_job(job: &Job) -> Result<()> {
    write(
        &job_path(job),
        &serde_json::to_string_pretty(job).map_err(err)?,
    )
}
fn gate_source(job: &Job) -> String {
    json!({"version":1,"root":job.root,"job":job_path(job)}).to_string()
}
fn validate(job: &Job) -> Result<()> {
    if job.version != 1
        || job.manager_pid == 0
        || !job.executable.is_absolute()
        || job.relaunch_args.len() > 100
    {
        return Err("无效重置任务，原数据保留".into());
    }
    safe_directory(&job.root)?;
    safe_directory(&job.backup)?;
    let name = job
        .backup
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if job.backup.parent() != job.root.parent()
        || !name
            .strip_prefix("xwxdeck-reset-backup-")
            .is_some_and(|id| id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("重置备份目录不匹配，原数据保留".into());
    }
    if read(&job.root.join(".xwx-rust-pilot"))?.as_deref() != Some("isolated-rust-pilot-v1\n")
        || stamp(&job.root)? != job.root_identity
    {
        return Err("重置数据目录身份已变化，原数据保留".into());
    }
    if !job.isolated
        && serde_json::from_str::<Value>(include_str!("../migration-status.json")).map_err(err)?
            ["productionReady"]
            != true
    {
        return Err("正式迁移门禁未通过，不能重置正常数据".into());
    }
    if job.moves.len() > 10_000 || job.client_files.len() > 4 {
        return Err("重置任务超过上限".into());
    }
    for item in &job.moves {
        let parent = item.source.parent().ok_or("无效重置来源")?;
        safe_directory(parent)?;
        safe_directory(item.destination.parent().ok_or("无效备份目标")?)?;
        if !item.destination.starts_with(&job.backup)
            && item.destination.parent().is_none_or(|p| {
                !p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with(".xwxdeck-reset-backup-"))
            })
        {
            return Err("重置目标不属于本次备份".into());
        }
        if item.source == job.root
            || job.root.starts_with(&item.source)
            || job.backup.starts_with(&item.source)
        {
            return Err("重置来源覆盖恢复现场".into());
        }
    }
    Ok(())
}
fn rollback(job: &Job) -> Result<()> {
    let mut conflicts = 0;
    for item in job.moves.iter().rev() {
        if !present(&item.destination)? {
            continue;
        }
        if present(&item.source)?
            || stamp(&item.destination).as_ref() != Ok(&item.stamp)
            || exclusive_move(&item.destination, &item.source).is_err()
        {
            conflicts += 1;
        }
    }
    if conflicts == 0 {
        Ok(())
    } else {
        Err("重置回退遇到较新外部文件，两个版本均已保留在原目录与备份中".into())
    }
}
/// Each rename is resumable by identity. A newer source is never replaced by
/// rollback, and an existing destination is never overwritten.
fn archive(job: &Job) -> Result<()> {
    validate(job)?;
    for item in &job.moves {
        match (present(&item.source)?, present(&item.destination)?) {
            (true, false) if stamp(&item.source)? == item.stamp => {}
            (false, true) if stamp(&item.destination)? == item.stamp => {}
            _ => return Err("重置前文件或备份已被外部修改，两个版本保留，请检查后重试".into()),
        }
    }
    for (index, item) in job.moves.iter().enumerate() {
        if present(&item.destination)? {
            continue;
        }
        if stamp(&item.source)? != item.stamp {
            return Err("重置过程中有外部修改，原文件保留".into());
        }
        exclusive_move(&item.source, &item.destination)?;
        if stamp(&item.destination)? != item.stamp {
            return Err("归档时文件发生变化，保留恢复现场".into());
        }
        if job.isolated && job.test_pause && index == 0 && !job.backup.join("pause-used").exists() {
            write(
                &job.backup.join("pause-used"),
                "isolated reset crash fixture\n",
            )?;
            let deadline = std::time::Instant::now() + Duration::from_secs(15);
            while !job.backup.join("continue").exists() {
                if std::time::Instant::now() >= deadline {
                    return Err("隔离重置暂停超时".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    Ok(())
}
impl Pilot {
    pub(crate) async fn prepare_reset(&mut self, reset_clients: bool) -> Result<Job> {
        if reset_clients && !self.isolated {
            return Err("正常客户端的重置进程确认尚未验收，核心配置未修改".into());
        }
        self.subscriptions.assert_reset_idle().await?;
        if matches!(
            self.updates.state()["status"].as_str(),
            Some("downloading" | "installing")
        ) {
            return Err("更新操作仍在运行，请先取消或完成后再次重置，数据保留".into());
        }
        if let Some(error) = self
            .settings_problem
            .as_ref()
            .or(self.recovery_problem.as_ref())
        {
            return Err(error.clone());
        }
        if gate(&self.root)?.exists() {
            return Err("已有重置恢复任务，请先完成恢复".into());
        }
        // Restore all original Desktop fields before archiving its ownership ledger.
        self.stop().await?;
        self.desktop_restore()?;
        let keep = [
            self.codex_home(),
            self.claude_dir(),
            self.root.join("clients"),
            self.root.join("desktop"),
        ];
        if keep.iter().any(|path| self.root.starts_with(path)) {
            return Err("客户端目录覆盖应用数据；请先调整目录后重置，历史未修改".into());
        }
        let mut custom = vec![];
        for path in [self.trace_root(), self.log_root()] {
            if keep
                .iter()
                .any(|owned| path.starts_with(owned) || owned.starts_with(&path))
            {
                return Err("Trace 或日志目录与客户端目录重叠，历史保留；请调整目录后重置".into());
            }
            if path == self.root || self.root.starts_with(&path) {
                return Err("Trace 或日志目录覆盖应用目录，数据保留".into());
            }
            if !path.starts_with(&self.root) && path.exists() {
                safe_directory(&path)?;
                let home = Self::home();
                if path.parent().is_none() || home.starts_with(&path) {
                    return Err("自定义数据目录范围过大，数据保留".into());
                }
                if !custom
                    .iter()
                    .any(|parent: &PathBuf| path.starts_with(parent))
                {
                    custom.retain(|child| !child.starts_with(&path));
                    custom.push(path);
                }
            }
        }
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).map_err(err)?;
        let nonce: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
        let backup = self
            .root
            .parent()
            .ok_or("无效数据目录")?
            .join(format!("xwxdeck-reset-backup-{nonce}"));
        private_directory(&backup)?;
        private_directory(&backup.join("data"))?;
        let mut job = Job {
            version: 1,
            root: self.root.clone(),
            backup,
            manager_pid: std::process::id(),
            isolated: self.isolated,
            root_identity: stamp(&self.root)?,
            moves: vec![],
            client_files: vec![],
            executable: std::env::current_exe().map_err(err)?,
            relaunch_args: std::env::args()
                .skip(1)
                .filter(|arg| {
                    ![
                        "--launch-hidden",
                        "--rpc",
                        "--reset-test-no-relaunch",
                        "--reset-test-pause-after-first-move",
                    ]
                    .contains(&arg.as_str())
                })
                .collect(),
            relaunch: !(self.isolated
                && std::env::args().any(|arg| arg == "--rpc")
                && std::env::args().any(|arg| arg == "--reset-test-no-relaunch")),
            stage: "prepared".into(),
            worker_pid: 0,
            test_pause: self.isolated
                && std::env::args().any(|arg| arg == "--rpc")
                && std::env::args().any(|arg| arg == "--reset-test-pause-after-first-move"),
            result: None,
            clear_browser_stores: false,
        };
        if reset_clients {
            for (label, path) in [
                ("codex-config", self.config_path()),
                ("codex-auth", self.codex_home().join("auth.json")),
                ("claude-settings", self.claude_dir().join("settings.json")),
                ("claude-legacy", self.claude_dir().join("claude.json")),
            ] {
                if !path.exists() {
                    continue;
                }
                safe_directory(path.parent().ok_or("无效客户端目录")?)?;
                let source = read(&path)?.ok_or("客户端文件已变化")?;
                self.backup_client_repair(label, &source)?;
                let captured = stamp(&path)?;
                if captured.sha256.as_deref() != Some(&storage::digest(source.as_bytes())) {
                    return Err("客户端配置在备份时变化，原文件保留".into());
                }
                job.client_files.push((path, captured));
            }
        }
        let retained: Vec<PathBuf> = keep
            .iter()
            .filter_map(|path| {
                path.strip_prefix(&self.root)
                    .ok()?
                    .components()
                    .next()
                    .map(|part| self.root.join(part.as_os_str()))
            })
            .collect();
        for entry in fs::read_dir(&self.root).map_err(err)? {
            let entry = entry.map_err(err)?;
            let path = entry.path();
            let name = entry.file_name();
            if retained.contains(&path)
                || [".xwx-rust-pilot", "pilot.lock"]
                    .iter()
                    .any(|value| name == *value)
            {
                continue;
            }
            job.moves.push(Move {
                source: path.clone(),
                destination: job.backup.join("data").join(name),
                stamp: stamp(&path)?,
            });
        }
        // Product-owned encrypted backups can coexist with client histories in
        // the isolated Codex home. Keep their document-relative vault paths.
        let codex = self.root.join("codex");
        if retained.contains(&codex) {
            for entry in fs::read_dir(&codex).map_err(err)? {
                let entry = entry.map_err(err)?;
                let relative = format!("codex/{}", entry.file_name().to_string_lossy());
                if credentials::protected(&relative) {
                    let directory = job.backup.join("data/codex");
                    if !directory.exists() {
                        private_directory(&directory)?;
                    }
                    job.moves.push(Move {
                        source: entry.path(),
                        destination: directory.join(entry.file_name()),
                        stamp: stamp(&entry.path())?,
                    });
                }
            }
        }
        for (index, path) in custom.iter().enumerate() {
            let destination = path
                .parent()
                .unwrap()
                .join(format!(".xwxdeck-reset-backup-{nonce}-{index}"));
            private_directory(&destination)?;
            for entry in fs::read_dir(path).map_err(err)? {
                let entry = entry.map_err(err)?;
                job.moves.push(Move {
                    source: entry.path(),
                    destination: destination.join(entry.file_name()),
                    stamp: stamp(&entry.path())?,
                });
            }
        }
        // Keep the original vault metadata and document-relative paths usable by
        // the existing explicit backup exporter. No master key is deleted.
        write(
            &job.backup.join("data/.xwx-rust-pilot"),
            "isolated-rust-pilot-v1\n",
        )?;
        write(&job.backup.join("data/pilot.lock"), "")?;
        validate(&job)?;
        save_job(&job)?;
        Ok(job)
    }
    pub(crate) async fn launch_reset(&mut self, mut job: Job) -> Result<Value> {
        use tokio::io::AsyncBufReadExt;
        validate(&job)?;
        job.stage = "waiting-for-exit".into();
        save_job(&job)?;
        let gate = gate(&job.root)?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&gate)
            .map_err(|_| "重置恢复记录已存在，现场保留")?;
        file.write_all(gate_source(&job).as_bytes()).map_err(err)?;
        file.sync_all().map_err(err)?;
        drop(file);
        let mut command = tokio::process::Command::new(&job.executable);
        command
            .args([
                "--application-reset-worker",
                job_path(&job).to_str().ok_or("重置路径编码无效")?,
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        if job.isolated {
            command.arg("--pilot-root").arg(&job.root);
        }
        if std::env::args().any(|arg| arg == "--pilot-os-credentials") {
            command.arg("--pilot-os-credentials");
        }
        let started = async {
            let mut child = command.spawn().map_err(|_| "无法启动重置进程")?;
            let mut line = String::new();
            let mut reader =
                tokio::io::BufReader::new(child.stdout.take().ok_or("重置进程未返回就绪状态")?);
            let ready =
                tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line)).await;
            if !matches!(ready, Ok(Ok(_))) || line.trim() != "xwxdeck-reset-ready" {
                let _ = child.kill().await;
                return Err("重置进程启动未完成，原数据保留".to_string());
            }
            Ok(())
        }
        .await;
        if let Err(error) = started {
            if read(&gate)?.as_deref() == Some(&gate_source(&job)) {
                fs::remove_file(gate).map_err(err)?;
            }
            return Err(error);
        }
        self.reset_pending = true;
        COMMITTED.store(true, Ordering::SeqCst);
        Ok(json!({"backupPath":job.backup,"restarting":true}))
    }
}

pub(super) fn pending_job(root: &Path) -> Result<Option<PathBuf>> {
    let Some(source) = read(&gate(root)?)? else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(&source).map_err(|_| "重置恢复记录损坏，原数据保留")?;
    if value["version"] != 1 || value["root"].as_str() != root.to_str() {
        return Err("重置恢复目录不匹配，原数据保留".into());
    }
    let path = PathBuf::from(value["job"].as_str().ok_or("缺少重置恢复路径")?);
    let job: Job = serde_json::from_str(&read(&path)?.ok_or("重置恢复任务不存在，原数据保留")?)
        .map_err(err)?;
    validate(&job)?;
    if path != job_path(&job) || job.root != root || source != gate_source(&job) {
        return Err("重置任务身份不匹配，原数据保留".into());
    }
    if job.stage == "recovery-required" {
        return Err(format!("重置回退遇到外部修改，原目录和备份都已保留。请先比较并恢复需要的文件，再重试；不要删除两个版本。\n原目录：{}\n备份：{}",job.root.display(),job.backup.display()));
    }
    Ok(Some(path))
}
fn remove_client_file(path: &Path, expected: &Stamp, nonce: &str) -> Result<()> {
    safe_directory(path.parent().ok_or("无效客户端路径")?)?;
    // A deterministic, private same-volume directory also survives a worker
    // crash between rename and removal. Never leave a credential in a public
    // temporary filename, and never replace a newly recreated source.
    let directory = path.with_file_name(format!(".xwxdeck-reset-{nonce}"));
    if !present(&directory)? {
        private_directory(&directory)?;
    }
    safe_directory(&directory)?;
    let temporary = directory.join(path.file_name().ok_or("无效客户端文件名")?);
    if present(path)? {
        if present(&temporary)? || stamp(path).as_ref() != Ok(expected) || expected.directory {
            return Err("客户端配置已被外部修改，原文件与暂存版本保留".into());
        }
        exclusive_move(path, &temporary)?;
    } else if !present(&temporary)? {
        let _ = fs::remove_dir(directory);
        return Ok(());
    }
    if stamp(&temporary)? != *expected {
        let _ = exclusive_move(&temporary, path);
        return Err("客户端配置在归档时变化，原文件与恢复现场保留".into());
    }
    fs::remove_file(&temporary)
        .map_err(|_| "客户端配置暂存清理未完成，备份与暂存文件保留".to_string())?;
    // Other captured files can use this directory; only remove an empty one.
    let _ = fs::remove_dir(directory);
    Ok(())
}
fn release_gate(job: &Job) -> Result<()> {
    let path = gate(&job.root)?;
    if read(&path)?.as_deref() != Some(&gate_source(job)) {
        return Err("重置恢复记录已变化，未删除较新记录".into());
    }
    fs::remove_file(path).map_err(err)
}
fn execute(job: &mut Job) -> Result<Value> {
    // The process existence query sends no signal. PID reuse can only delay
    // reset; it cannot terminate or overwrite another process.
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while legacy_helper::process_present(job.manager_pid) {
        if std::time::Instant::now() >= deadline {
            return Err("原应用未完全退出，重置未执行；原数据保留".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(job.root.join("pilot.lock"))
        .map_err(err)?;
    lock.try_lock()
        .map_err(|_| "数据仍被另一个进程使用，重置未执行")?;
    // A surviving authorization descendant may still own temporary credentials.
    credentials::assert_cli_homes_idle(&job.root)?;
    if job.result.is_none() {
        std::thread::sleep(Duration::from_millis(750));
        if job.clear_browser_stores {
            crate::isolated_webview::cleanup_reset(
                &job.root,
                job.isolated
                    && job
                        .relaunch_args
                        .iter()
                        .any(|arg| arg == "--pilot-webview-persistent"),
            )?;
        }
        job.stage = "archiving".into();
        save_job(job)?;
        if let Err(error) = archive(job) {
            let rollback = rollback(job);
            job.stage = if rollback.is_ok() {
                "rolled-back"
            } else {
                "recovery-required"
            }
            .into();
            save_job(job)?;
            if let Err(rollback) = rollback {
                return Err(format!("{error}；{rollback}"));
            }
            return Err(error);
        }
        let nonce = job.backup.file_name().unwrap().to_string_lossy();
        let mut skipped = vec![];
        for (path, expected) in &job.client_files {
            if let Err(error) = remove_client_file(path, expected, &nonce) {
                skipped.push(json!({"path":path,"reason":error}));
            }
        }
        job.result = Some(
            json!({"version":1,"status":"completed","backupPath":job.backup,"archivedPaths":job.moves.iter().map(|item|json!({"source":item.source,"backup":item.destination})).collect::<Vec<_>>(),"skippedClientFiles":skipped,"atMs":millis() as u64}),
        );
        job.stage = "finalizing".into();
        save_job(job)?;
    }
    let result = job.result.clone().ok_or("缺少重置结果")?;
    write(
        &job.root.join("application-reset-result.json"),
        &result.to_string(),
    )?;
    job.stage = "completed".into();
    save_job(job)?;
    release_gate(job)?;
    Ok(result)
}
pub(super) fn worker(path: &Path) -> Result<()> {
    let mut job: Job = serde_json::from_str(&read(path)?.ok_or("重置任务不存在")?).map_err(err)?;
    validate(&job)?;
    if path != job_path(&job) || pending_job(&job.root)?.as_deref() != Some(path) {
        return Err("重置恢复任务不匹配".into());
    }
    let worker_lock = job.backup.join("worker.lock");
    read(&worker_lock)?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(worker_lock)
        .map_err(err)?;
    lock.try_lock().map_err(|_| "重置进程仍在运行")?;
    job.worker_pid = std::process::id();
    save_job(&job)?;
    println!("xwxdeck-reset-ready");
    let _ = std::io::stdout().flush();
    let result = execute(&mut job);
    if let Err(error) = &result {
        write(&job.root.join("application-reset-result.json"),&json!({"version":1,"status":"failed","backupPath":job.backup,"reason":error,"atMs":millis() as u64}).to_string())?;
        // A finalization failure is resumable; its journal already contains the
        // exact result including any skipped external files.
        if job.stage != "recovery-required" && job.result.is_none() {
            release_gate(&job)?;
        }
    }
    if job.relaunch
        && job.stage != "recovery-required"
        && !(result.is_err() && job.result.is_some())
    {
        let mut command = std::process::Command::new(&job.executable);
        command
            .args(&job.relaunch_args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        command
            .spawn()
            .map_err(|_| "重置结束，但重新启动失败；备份与结果记录保留")?;
    }
    result.map(|_| ())
}
pub(super) fn resume(path: &Path) -> Result<()> {
    let job: Job = serde_json::from_str(&read(path)?.ok_or("重置任务不存在")?).map_err(err)?;
    validate(&job)?;
    let mut command = std::process::Command::new(std::env::current_exe().map_err(err)?);
    command
        .arg("--application-reset-worker")
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if job.isolated {
        command.arg("--pilot-root").arg(&job.root);
    }
    command
        .spawn()
        .map_err(|_| "无法恢复重置工作进程，备份与原目录保留")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, Job) {
        let mut nonce = [0; 8];
        getrandom::fill(&mut nonce).unwrap();
        let nonce: String = nonce.iter().map(|value| format!("{value:02x}")).collect();
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("xwxdeck-reset-unit-{}-{nonce}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let data = root.join("app");
        fs::create_dir(&data).unwrap();
        fs::write(data.join(".xwx-rust-pilot"), "isolated-rust-pilot-v1\n").unwrap();
        fs::write(data.join("settings.json"), "original").unwrap();
        let backup = root.join("xwxdeck-reset-backup-0123456789abcdef0123456789abcdef");
        private_directory(&backup).unwrap();
        private_directory(&backup.join("data")).unwrap();
        let source = data.join("settings.json");
        let job = Job {
            version: 1,
            root: data.clone(),
            backup: backup.clone(),
            manager_pid: std::process::id(),
            isolated: true,
            root_identity: stamp(&data).unwrap(),
            moves: vec![Move {
                source: source.clone(),
                destination: backup.join("data/settings.json"),
                stamp: stamp(&source).unwrap(),
            }],
            client_files: vec![],
            executable: std::env::current_exe().unwrap(),
            relaunch_args: vec![],
            relaunch: false,
            stage: "prepared".into(),
            worker_pid: 0,
            test_pause: false,
            result: None,
            clear_browser_stores: false,
        };
        (root, job)
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn archive_resumes_and_rolls_back_exact_bytes() {
        let (root, job) = fixture();
        archive(&job).unwrap();
        archive(&job).unwrap();
        assert!(!job.moves[0].source.exists());
        rollback(&job).unwrap();
        assert_eq!(
            fs::read_to_string(&job.moves[0].source).unwrap(),
            "original"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn drift_and_newer_rollback_sources_are_retained() {
        let (root, job) = fixture();
        fs::write(&job.moves[0].source, "external").unwrap();
        assert!(archive(&job).is_err());
        assert!(!job.moves[0].destination.exists());
        fs::write(&job.moves[0].source, "original").unwrap();
        archive(&job).unwrap();
        fs::write(&job.moves[0].source, "newer").unwrap();
        assert!(rollback(&job).is_err());
        assert_eq!(fs::read_to_string(&job.moves[0].source).unwrap(), "newer");
        assert_eq!(
            fs::read_to_string(&job.moves[0].destination).unwrap(),
            "original"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn client_removal_resumes_private_staging_and_preserves_new_sources() {
        let (root, job) = fixture();
        let path = &job.moves[0].source;
        let expected = &job.moves[0].stamp;
        let directory = path.with_file_name(".xwxdeck-reset-fixture");
        private_directory(&directory).unwrap();
        let temporary = directory.join(path.file_name().unwrap());
        exclusive_move(path, &temporary).unwrap();
        fs::write(path, "newer").unwrap();
        assert!(remove_client_file(path, expected, "fixture").is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "newer");
        assert_eq!(fs::read_to_string(&temporary).unwrap(), "original");
        fs::remove_file(path).unwrap();
        remove_client_file(path, expected, "fixture").unwrap();
        remove_client_file(path, expected, "fixture").unwrap();
        assert!(!temporary.exists());
        assert!(!directory.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    #[test]
    fn unsupported_archive_preserves_original_and_destination() {
        let (root, job) = fixture();
        assert!(archive(&job)
            .unwrap_err()
            .contains("此平台尚未验证独占归档"));
        assert_eq!(
            fs::read_to_string(&job.moves[0].source).unwrap(),
            "original"
        );
        assert!(!job.moves[0].destination.exists());
        fs::write(&job.moves[0].destination, "existing").unwrap();
        assert!(exclusive_move(&job.moves[0].source, &job.moves[0].destination).is_err());
        assert_eq!(
            fs::read_to_string(&job.moves[0].source).unwrap(),
            "original"
        );
        assert_eq!(
            fs::read_to_string(&job.moves[0].destination).unwrap(),
            "existing"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
