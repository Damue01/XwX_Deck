//! Move only Deck's default bulk directories. Explicit user paths stay unchanged.
use super::*;
use std::io::{Read, Write};

pub(crate) fn installation_root() -> Option<PathBuf> {
    if std::env::args().any(|a| matches!(a.as_str(), "--pilot-root" | "--data-root")) {
        return None;
    }
    #[cfg(target_os = "windows")]
    if crate::windows_setup::is_registered() {
        return std::env::current_exe()
            .ok()?
            .parent()
            .map(|p| p.join("XwXTrace"));
    }
    None
}

pub(crate) fn prepare_directory(root: &Path, path: &Path) -> Result<PathBuf> {
    let base = validated_directory(root, path)?;
    credentials::private_permissions(&base, true)?;
    Ok(base)
}
pub(crate) fn validated_directory(root: &Path, path: &Path) -> Result<PathBuf> {
    Pilot::directory(root, &path.to_string_lossy(), "")
}

fn files(directory: &Path, output: &mut Vec<PathBuf>) -> Result<()> {
    if !directory.exists() {
        return Ok(());
    }
    Pilot::directory_path(directory, &directory.to_string_lossy(), "")?;
    for entry in fs::read_dir(directory).map_err(err)? {
        let entry = entry.map_err(err)?;
        let info = entry.file_type().map_err(err)?;
        if info.is_symlink() {
            return Err("数据目录包含重定向，原文件已保留".into());
        }
        if info.is_dir() {
            files(&entry.path(), output)?;
        } else if info.is_file() {
            output.push(entry.path());
        } else {
            return Err("数据目录包含非普通文件，原文件已保留".into());
        }
    }
    Ok(())
}

fn remove_empty_directories(path: &Path) {
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            if entry
                .file_type()
                .is_ok_and(|t| t.is_dir() && !t.is_symlink())
            {
                remove_empty_directories(&entry.path());
            }
        }
        let _ = fs::remove_dir(path);
    }
}

fn digest(path: &Path, progress: &mut impl FnMut(u64)) -> Result<String> {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    let mut input = fs::File::open(path).map_err(err)?;
    let mut buffer = [0; 64 * 1024];
    loop {
        let size = input.read(&mut buffer).map_err(err)?;
        if size == 0 {
            break;
        }
        hash.update(&buffer[..size]);
        progress(size as u64);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn rewrite_index(bytes: &[u8], source: &Path, destination: &Path) -> Result<Vec<u8>> {
    let mut index: Value = serde_json::from_slice(bytes).map_err(err)?;
    if !index["sessions"].is_array() {
        return Err("Trace 索引损坏，原文件已保留；请先修复索引再迁移".into());
    }
    if let Some(sessions) = index["sessions"].as_array_mut() {
        for session in sessions {
            if let Some(path) = session["jsonlPath"].as_str() {
                // Leave references to independently chosen external files unchanged.
                let relative = Path::new(path)
                    .strip_prefix(source)
                    .ok()
                    .map(Path::to_path_buf)
                    .or_else(|| {
                        let path = fs::canonicalize(path).ok()?;
                        let source = fs::canonicalize(source).ok()?;
                        path.strip_prefix(source).ok().map(Path::to_path_buf)
                    });
                if let Some(relative) = relative {
                    if relative
                        .components()
                        .any(|c| !matches!(c, std::path::Component::Normal(_)))
                    {
                        return Err("Trace 索引路径无效，原文件已保留".into());
                    }
                    session["jsonlPath"] = json!(destination.join(relative));
                }
            }
        }
    }
    serde_json::to_vec_pretty(&index).map_err(err)
}

impl Pilot {
    fn storage_moves(&self, base: &Path) -> Vec<(String, PathBuf, PathBuf)> {
        let previous = self
            .settings
            .other
            .get("bulkStorageInstallRoot")
            .and_then(Value::as_str)
            .map(PathBuf::from);
        let mut moves: Vec<_> = [
            ("traceRoot", self.trace_root(), "traces"),
            ("logRoot", self.log_root(), "logs"),
        ]
        .into_iter()
        .filter(|(_, path, name)| {
            path != &base.join(name)
                && (path == &self.root.join(name)
                    || (*name == "traces"
                        && extension::legacy_bulk_trace_root(&self.root).as_ref() == Some(path))
                    || previous
                        .as_ref()
                        .is_some_and(|root| path == &root.join(name)))
        })
        .map(|(key, source, name)| (key.to_owned(), source, base.join(name)))
        .collect();
        let backup = self.root.join("legacy-data-backup");
        if backup.exists() {
            moves.push((String::new(), backup, base.join("legacy-data-backup")));
        }
        if let Some(previous) = previous.filter(|path| path != base) {
            let backup = previous.join("legacy-data-backup");
            if backup.exists() {
                moves.push((String::new(), backup, base.join("legacy-data-backup")));
            }
        }
        moves
    }
    pub fn inspect_storage_migration(&self) -> Result<Value> {
        let Some(base) = installation_root() else {
            return Ok(Value::Null);
        };
        if extension::defer_storage_migration(&self.root)? {
            return Ok(json!({"destination":base,"deferred":true}));
        }
        self.check_settings_source()?;
        if self.storage_moves(&base).is_empty() {
            return Ok(Value::Null);
        }
        Ok(json!({"destination":base}))
    }
    pub fn migrate_storage(&mut self, progress: impl FnMut(Value)) -> Result<Value> {
        let base = installation_root().ok_or("当前程序没有有效的安装位置，未移动数据")?;
        self.migrate_storage_to(&base, progress)
    }
    pub(super) fn migrate_storage_to(
        &mut self,
        base: &Path,
        mut emit: impl FnMut(Value),
    ) -> Result<Value> {
        self.check_settings_source()?;
        if self.gateway.is_some() {
            return Err("请先停止 Trace，再迁移数据".into());
        }
        let expected = self.settings_source.lock().map_err(err)?.clone();
        let moves = self.storage_moves(base);
        if moves.is_empty() {
            return Ok(self.state());
        }
        if moves.iter().any(|(_, source, destination)| {
            source.starts_with(destination) || destination.starts_with(source)
        }) {
            return Err("源目录和目标目录不能互相包含，原文件已保留".into());
        }
        prepare_directory(&self.root, base)?;
        let mut entries = vec![];
        for (_, source, destination) in &moves {
            let mut found = vec![];
            files(source, &mut found)?;
            for path in found {
                let target = destination.join(path.strip_prefix(source).map_err(err)?);
                entries.push((path, target, source.clone(), destination.clone()));
            }
        }
        // Copy payloads before the index, so every published reference has a file.
        entries
            .sort_by_key(|(source, _, _, _)| source.file_name().is_some_and(|n| n == "index.json"));
        let total = entries
            .iter()
            .map(|(p, _, _, _)| fs::metadata(p).map(|m| m.len()).map_err(err))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .sum::<u64>()
            .saturating_mul(8);
        let mut done = 0u64;
        let mut retained = vec![];
        for (number, (source, target, old_root, new_root)) in entries.iter().enumerate() {
            let mut advance = |bytes: u64| {
                done = done.saturating_add(bytes);
                emit(
                    json!({"phase":"merging","percent":if total == 0 {0} else {(done.saturating_mul(100)/total).min(99)},"processedBytes":done,"totalBytes":total,"completedFiles":number,"totalFiles":entries.len()}),
                );
            };
            Self::directory(
                &self.root,
                &target.parent().ok_or("无效目标目录")?.to_string_lossy(),
                "",
            )?;
            let original = digest(source, &mut advance)?;
            let index = new_root.file_name().is_some_and(|name| name == "traces")
                && source == &old_root.join("index.json");
            let rewritten = if index {
                Some(rewrite_index(
                    &fs::read(source).map_err(err)?,
                    old_root,
                    new_root,
                )?)
            } else {
                None
            };
            if let Some(bytes) = &rewritten {
                let index: Value = serde_json::from_slice(bytes).map_err(err)?;
                for session in index["sessions"].as_array().unwrap() {
                    if let Some(path) = session["jsonlPath"].as_str() {
                        let path = Path::new(path);
                        if path.starts_with(new_root) && !path.is_file() {
                            return Err("Trace 历史文件缺失，原索引保留；请先修复历史再迁移".into());
                        }
                    }
                }
            }
            if target.exists() {
                if index {
                    if fs::read(target).map_err(err)? != *rewritten.as_ref().unwrap() {
                        return Err(
                            "目标 Trace 索引已有不同内容，两个目录均保留；请选择其他目录后重试"
                                .into(),
                        );
                    }
                } else if digest(target, &mut advance)? != original {
                    return Err("目标目录已有同名不同文件，两个版本均保留".into());
                }
            } else {
                let temporary =
                    target.with_extension(format!("storage-{}.tmp", std::process::id()));
                let mut output = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)
                    .map_err(err)?;
                let copied = (|| -> Result<()> {
                    if let Some(bytes) = &rewritten {
                        output.write_all(bytes).map_err(err)?;
                    } else {
                        let mut input = fs::File::open(source).map_err(err)?;
                        let mut buffer = [0; 64 * 1024];
                        loop {
                            let size = input.read(&mut buffer).map_err(err)?;
                            if size == 0 {
                                break;
                            }
                            output.write_all(&buffer[..size]).map_err(err)?;
                            advance(size as u64);
                        }
                    }
                    output.sync_all().map_err(err)?;
                    if let Some(bytes) = &rewritten {
                        if fs::read(&temporary).map_err(err)? != *bytes {
                            return Err("Trace 索引复制校验失败，原文件已保留".into());
                        }
                    }
                    if !index && digest(&temporary, &mut advance)? != original {
                        return Err("复制校验失败，原文件已保留".into());
                    }
                    if digest(source, &mut advance)? != original {
                        return Err("迁移期间源文件发生变化，原文件已保留，请重试".into());
                    }
                    fs::hard_link(&temporary, target).map_err(err)?;
                    Ok(())
                })();
                drop(output);
                let _ = fs::remove_file(&temporary);
                copied?;
            }
            let target_hash = rewritten
                .as_ref()
                .map(|bytes| storage::digest(bytes))
                .unwrap_or_else(|| original.clone());
            retained.push((source.clone(), original, target.clone(), target_hash));
        }
        let mut settings = self.settings.clone();
        settings
            .other
            .insert("bulkStorageInstallRoot".into(), json!(base));
        for (key, _, target) in &moves {
            if key == "traceRoot" {
                settings.trace_root = target.to_string_lossy().into_owned();
            } else if key == "logRoot" {
                settings.log_root = target.to_string_lossy().into_owned();
            }
        }
        for (_, _, target) in &moves {
            Self::directory(&self.root, &target.to_string_lossy(), "")?;
        }
        let store = self.relocated_trace_store(PathBuf::from(&settings.trace_root))?;
        let source = Self::settings_document(&settings)?;
        let mut advance = |bytes: u64| {
            done = done.saturating_add(bytes);
            emit(
                json!({"phase":"merging","percent":if total == 0 {0} else {(done.saturating_mul(100)/total).min(99)},"processedBytes":done,"totalBytes":total,"completedFiles":entries.len(),"totalFiles":entries.len()}),
            );
        };
        for (path, original, target, target_hash) in &retained {
            if digest(path, &mut advance)? != *original
                || digest(target, &mut advance)? != *target_hash
            {
                return Err("文件在迁移期间发生变化，未切换目录；请重试".into());
            }
        }
        write_checked(
            &self.root.join("settings.json"),
            expected.as_deref().unwrap_or(""),
            &source,
        )?;
        self.settings = settings;
        *self.settings_source.lock().map_err(err)? = Some(source);
        self.store = store;
        self.dashboard = None;
        // Settings now point at verified copies. Never remove changed/new files.
        let mut cleanup_pending = 0;
        for (path, original, target, target_hash) in retained {
            if digest(&path, &mut advance).is_ok_and(|hash| hash == original)
                && digest(&target, &mut advance).is_ok_and(|hash| hash == target_hash)
            {
                if fs::remove_file(path).is_err() {
                    cleanup_pending += 1;
                }
            } else {
                cleanup_pending += 1;
            }
        }
        for (_, source, _) in &moves {
            remove_empty_directories(source);
        }
        let report =
            json!({"destination":base,"files":entries.len(),"cleanupPending":cleanup_pending});
        write(
            &self.root.join("storage-migration-result.json"),
            &report.to_string(),
        )?;
        emit(
            json!({"phase":"complete","percent":100,"processedBytes":total,"totalBytes":total,"completedFiles":entries.len(),"totalFiles":entries.len(),"cleanupPending":cleanup_pending}),
        );
        let mut state = self.state();
        state["storageMigrationResult"] = report;
        Ok(state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn index_relocation_changes_only_owned_session_paths() {
        let root = std::env::temp_dir().join("storage-index-fixture");
        let old = root.join("old");
        let new = root.join("new");
        let external = root.join("explicit/session.jsonl");
        let value = json!({"sessions":[{"jsonlPath":old.join("one.jsonl"),"title":"old is user text"},{"jsonlPath":external}],"other":"keep"});
        let result: Value = serde_json::from_slice(
            &rewrite_index(&serde_json::to_vec(&value).unwrap(), &old, &new).unwrap(),
        )
        .unwrap();
        assert_eq!(
            result["sessions"][0]["jsonlPath"],
            json!(new.join("one.jsonl"))
        );
        assert_eq!(
            result["sessions"][0]["title"],
            value["sessions"][0]["title"]
        );
        assert_eq!(result["sessions"][1], value["sessions"][1]);
        assert_eq!(result["other"], value["other"]);
    }
    #[test]
    fn malformed_and_escaping_indexes_are_rejected() {
        let root = std::env::temp_dir().join("storage-index-fixture");
        assert!(rewrite_index(b"{broken", &root, &root.join("new")).is_err());
        let value = json!({"sessions":[{"jsonlPath":root.join("../outside.jsonl")}]});
        assert!(rewrite_index(
            &serde_json::to_vec(&value).unwrap(),
            &root,
            &root.join("new")
        )
        .is_err());
    }
}
