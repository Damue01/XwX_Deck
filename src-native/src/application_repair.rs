//! Quick repair clears only rebuildable application caches, never history or login data.
use super::*;

fn cache_size(path: &Path, depth: usize, entries: &mut usize) -> Result<Option<u64>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(err(error)),
    };
    *entries += 1;
    if depth > 32 || *entries > 20_000 {
        return Err("修复缓存目录超过检查上限，原目录已保留".into());
    }
    if metadata.file_type().is_symlink() || !(metadata.is_file() || metadata.is_dir()) {
        return Err(format!(
            "修复缓存包含链接或特殊文件，原路径已保留：{}",
            path.display()
        ));
    }
    if metadata.is_file() {
        return Ok(Some(metadata.len()));
    }
    let mut bytes = 0u64;
    for child in fs::read_dir(path).map_err(err)? {
        bytes = bytes.saturating_add(
            cache_size(&child.map_err(err)?.path(), depth + 1, entries)?.unwrap_or(0),
        );
    }
    Ok(Some(bytes))
}

pub(super) fn remove_cache(path: &Path) -> Result<Option<u64>> {
    let Some(bytes) = cache_size(path, 0, &mut 0)? else {
        return Ok(None);
    };
    let metadata = fs::symlink_metadata(path).map_err(err)?;
    if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(err)?;
    } else if metadata.is_file() {
        fs::remove_file(path).map_err(err)?;
    } else {
        return Err("缓存路径已变化，未删除".into());
    }
    Ok(Some(bytes))
}

impl Pilot {
    pub(super) fn repair_local_caches(&mut self) -> Result<Value> {
        if let Some(ref error) = self.settings_problem {
            return Err(error.clone());
        }
        let expected = self.settings_source.lock().map_err(err)?.clone();
        let settings_path = self.root.join("settings.json");
        if read(&settings_path)? != expected {
            return Err("设置已被外部修改，未修复应用缓存；请重启读取最新设置后继续".into());
        }
        let mut paths = ["pricing-cache", "model-capabilities-cache.json"]
            .map(|name| self.root.join(name))
            .to_vec();
        let mut model_paths = vec![];
        for file in fs::read_dir(&self.root).map_err(err)? {
            let file = file.map_err(err)?;
            let name = file.file_name().to_string_lossy().into_owned();
            if name.starts_with("provider-") && name.ends_with("-models.json") {
                model_paths.push(file.path());
            }
        }
        // Gateway resolves protocol evidence from these files for each new
        // request. Keep them during an active Trace until fresh discovery can
        // replace them; a failed refresh must not change a working route.
        let preserved_catalogs = if self.active() {
            model_paths.iter().filter(|path| path.exists()).count()
        } else {
            paths.extend(model_paths);
            0
        };
        // Check all targets before changing settings or deleting any cache.
        for path in paths
            .iter()
            .chain(std::iter::once(&self.root.join("updates")))
        {
            cache_size(path, 0, &mut 0)?;
        }
        let legacy = ["maxSessions", "maxStorageMB"].iter().any(|key| {
            self.settings
                .other
                .get(*key)
                .and_then(Value::as_f64)
                .is_some_and(|n| n > 0.0)
        });
        let changed = ["maxSessions", "maxStorageMB"]
            .iter()
            .any(|key| self.settings.other.get(*key) != Some(&json!(0)));
        let mut settings = self.settings.clone();
        for key in ["maxSessions", "maxStorageMB"] {
            settings.other.insert(key.into(), json!(0));
        }
        let source = Self::settings_document(&settings)?;
        let backup = if changed && expected.is_some() {
            let mut nonce = [0u8; 16];
            getrandom::fill(&mut nonce).map_err(|_| "无法生成修复备份标识")?;
            let path = self.root.join(format!(
                "settings-backup-quick-repair-{}.json",
                storage::digest(&nonce)
            ));
            // The common writer seals the backup using its own authenticated
            // document path; copying ciphertext to a new name is not readable.
            write_checked(&path, "", expected.as_deref().unwrap_or(""))?;
            Some(path)
        } else {
            None
        };
        write_checked(&settings_path, expected.as_deref().unwrap_or(""), &source)?;
        self.settings = settings;
        *self.settings_source.lock().map_err(err)? = Some(source);
        let mut count = 0;
        let mut bytes = 0;
        let updates = self.updates.clear_idle_cache()?;
        if let Some(removed) = updates {
            count += 1;
            bytes += removed;
        }
        self.catalog_generation = self.catalog_generation.wrapping_add(1);
        for path in paths {
            if let Some(removed) = remove_cache(&path)? {
                count += 1;
                bytes += removed;
            }
        }
        let mut store = self.store.lock().map_err(err)?;
        store.prices = storage::load_prices(&self.root);
        // Apply the explicit current storage policy without deleting records.
        store.limit = (self.settings.trace_warning_gb * 1024.0f64.powi(3)) as u64;
        store.auto_cleanup = self.settings.trace_auto_cleanup;
        Ok(
            json!({"removedCachePaths":count,"removedBytes":bytes,"chromiumCacheCleared":false,"settingsBackupPath":backup,"preservedModelCatalogs":preserved_catalogs,
            "traceRetention":{"legacyLimitsFound":legacy,"persistedSettingsChanged":changed,
                "settings":{"maxSessions":0,"maxStorageMB":0},
                "helper":if self.active(){json!({"state":"verified","maxSessions":0,"maxStorageBytes":store.limit})}else{json!({"state":"not-running"})}}}),
        )
    }
}
