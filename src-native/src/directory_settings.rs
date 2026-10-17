//! Validate all directory choices, persist once, then publish the new store.
use super::*;
impl Pilot {
    pub(super) fn directory_path(root: &Path, path: &str, default: &str) -> Result<PathBuf> {
        let path = if path.trim().is_empty() {
            root.join(default)
        } else {
            PathBuf::from(path)
        };
        if !path.is_absolute()
            || (std::env::args().any(|a| a == "--pilot-root") && !path.starts_with(root))
            || path
                .components()
                .any(|p| matches!(p, std::path::Component::ParentDir))
        {
            return Err("目录必须为绝对路径；隔离测试只能选择试验根目录内的目录".into());
        }
        // Check existing ancestors before creating anything, including paths
        // whose leaf does not exist yet. A symlink rejection must not create
        // descendants in its destination.
        for part in path.ancestors() {
            match fs::symlink_metadata(part) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err("配置目录不允许符号链接".into())
                }
                Ok(meta) if !meta.is_dir() => return Err("配置目录或父目录不是文件夹".into()),
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(err(e)),
            }
        }
        Ok(path)
    }
    pub(super) fn directory(root: &Path, path: &str, default: &str) -> Result<PathBuf> {
        let path = Self::directory_path(root, path, default)?;
        fs::create_dir_all(&path).map_err(err)?;
        if !same_physical_path(&path)? {
            return Err("配置目录不允许符号链接".into());
        }
        Ok(path)
    }
    pub(super) fn update_directories(&mut self, input: &Value) -> Result<Value> {
        if let Some(ref error) = self.settings_problem {
            return Err(error.clone());
        }
        let expected = self.settings_source.lock().map_err(err)?.clone();
        if read(&self.root.join("settings.json"))? != expected {
            return Err("设置已被外部修改，目录未切换；请重启读取最新设置后继续".into());
        }
        let mut paths = vec![];
        for (key, default) in [
            ("traceRoot", "traces"),
            ("logRoot", "logs"),
            ("claudeConfigDir", "claude"),
        ] {
            if let Some(value) = input.get(key) {
                let value = value.as_str().ok_or("无效目录")?;
                let value = if key == "claudeConfigDir" && value.trim().is_empty() {
                    self.default_claude_dir().to_string_lossy().into_owned()
                } else {
                    value.to_owned()
                };
                let path = Self::directory_path(&self.root, &value, default)?;
                if key == "claudeConfigDir" {
                    let environment = std::env::var("CLAUDE_CONFIG_DIR").ok();
                    claude_directory::validate_update(
                        self.isolated,
                        environment.as_deref(),
                        &path,
                    )?;
                }
                paths.push((key, path));
            }
        }
        if paths.is_empty() {
            return Err("没有需要修改的目录".into());
        }
        let trace = paths
            .iter()
            .find(|(key, _)| *key == "traceRoot")
            .map(|(_, path)| path.clone())
            .filter(|path| *path != self.trace_root());
        let claude = paths
            .iter()
            .find(|(key, _)| *key == "claudeConfigDir")
            .map(|(_, path)| path.clone())
            .filter(|path| *path != self.claude_dir());
        if self.active() && (trace.is_some() || claude.is_some()) {
            return Err("请先停止 Trace 再修改数据或客户端配置目录".into());
        }
        if claude.is_some() && read(&self.root.join("claude-direct.json"))?.is_some() {
            return Err("请先恢复 Claude 官方配置再修改配置目录".into());
        }
        let mut created = vec![];
        let prepared = (|| -> Result<(Settings, Option<storage::Store>, String)> {
            for (_, path) in &paths {
                let mut missing = vec![];
                for part in path.ancestors() {
                    if part.exists() {
                        break;
                    }
                    missing.push(part.to_path_buf());
                }
                for part in missing.into_iter().rev() {
                    // Recheck each parent immediately before the exclusive create.
                    Self::directory_path(&self.root, &part.to_string_lossy(), "")?;
                    match fs::create_dir(&part) {
                        Ok(()) => created.push(part),
                        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                        Err(e) => return Err(err(e)),
                    }
                }
                if !same_physical_path(path)? {
                    return Err("配置目录不允许符号链接".into());
                }
            }
            let store = trace
                .as_ref()
                .map(|path| {
                    storage::TraceStore::open(
                        path.clone(),
                        (self.settings.trace_warning_gb * 1024.0f64.powi(3)) as u64,
                        self.settings.trace_auto_cleanup,
                        &self.root,
                    )
                })
                .transpose()?;
            let mut settings = self.settings.clone();
            for (key, path) in &paths {
                let path = path.to_string_lossy().into_owned();
                match *key {
                    "traceRoot" => settings.trace_root = path,
                    "logRoot" => settings.log_root = path,
                    _ => settings.claude_config_dir = path,
                }
            }
            let source = Self::settings_document(&settings)?;
            if read(&self.root.join("settings.json"))? != expected {
                return Err(
                    "设置在目录检查期间被外部修改，未覆盖；请重启读取最新设置后继续".into(),
                );
            }
            write_checked(
                &self.root.join("settings.json"),
                expected.as_deref().unwrap_or(""),
                &source,
            )?;
            Ok((settings, store, source))
        })();
        match prepared {
            Ok((settings, store, source)) => {
                self.settings = settings;
                *self.settings_source.lock().map_err(err)? = Some(source);
                if let Some(store) = store {
                    self.dashboard = None;
                    self.store = store;
                }
                Ok(self.state())
            }
            Err(error) => {
                for path in created.into_iter().rev() {
                    let _ = fs::remove_dir(path);
                }
                Err(error)
            }
        }
    }
}
