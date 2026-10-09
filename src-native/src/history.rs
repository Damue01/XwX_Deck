use super::*;
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use std::io::{BufRead, BufReader, Read, Write};
fn paths(root: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root).map_err(err)? {
        let entry = entry.map_err(err)?;
        let kind = entry.file_type().map_err(err)?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            paths(&entry.path(), out)?;
        } else if entry.path().extension().is_some_and(|s| s == "jsonl") {
            out.push(entry.path());
        }
    }
    Ok(())
}
fn first(file: &Path) -> Result<(String, Value)> {
    let mut reader = BufReader::new(fs::File::open(file).map_err(err)?);
    let mut line = String::new();
    (&mut reader)
        .take(1024 * 1024)
        .read_line(&mut line)
        .map_err(err)?;
    if !line.ends_with('\n') {
        return Err("首条 session_meta 超出上限或未完整写入".into());
    }
    let value: Value =
        serde_json::from_str(&line).map_err(|_| "首条 session_meta 无效".to_string())?;
    if value["type"] != "session_meta" || !value["payload"].is_object() {
        return Err("不是 Codex session_meta".into());
    }
    Ok((line, value))
}
fn rewrite(file: &Path, expected: &str, new: &str) -> Result<()> {
    let meta = fs::symlink_metadata(file).map_err(err)?;
    if meta.file_type().is_symlink() {
        return Err("不修改符号链接历史".into());
    }
    let mut source = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(file)
        .map_err(err)?;
    source
        .try_lock()
        .map_err(|_| "历史文件正在使用".to_string())?;
    if first(file)?.0 != expected {
        return Err("历史元数据已被外部修改".into());
    }
    let temp = file.with_extension(format!("rewrite-{}.tmp", millis()));
    let result = (|| {
        let mut target = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(err)?;
        target.set_permissions(meta.permissions()).map_err(err)?;
        target.write_all(new.as_bytes()).map_err(err)?;
        let mut reader = BufReader::new(&mut source);
        let mut discarded = vec![];
        reader.read_until(b'\n', &mut discarded).map_err(err)?;
        std::io::copy(&mut reader, &mut target).map_err(err)?;
        target.sync_all().map_err(err)?;
        let current = fs::metadata(file).map_err(err)?;
        if current.len() != meta.len()
            || current.modified().map_err(err)? != meta.modified().map_err(err)?
        {
            return Err("历史文件正在写入，未覆盖".into());
        }
        fs::rename(&temp, file).map_err(err)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
impl Pilot {
    pub(super) fn history_update(&mut self, restore: bool) -> Result<Value> {
        let codex = self.config_path().parent().unwrap().to_path_buf();
        let ledger_path = self.root.join("history-ledger.json");
        let mut ledger = read(&ledger_path)?
            .map(|s| serde_json::from_str::<Value>(&s).map_err(err))
            .transpose()?
            .unwrap_or(json!({"files":{},"rows":{},"target":"xwx_deck"}));
        let mut outcome = json!({"migratedJsonlFiles":0,"migratedStateRows":0,"restoredJsonlFiles":0,"restoredStateRows":0,"skippedLockedJsonlFiles":0,"skippedLockedStateDbs":0});
        let mut files = vec![];
        for folder in ["sessions", "archived_sessions"] {
            paths(&codex.join(folder), &mut files)?;
        }
        for file in files {
            let Ok((line, mut value)) = first(&file) else {
                continue;
            };
            let key = file
                .strip_prefix(&codex)
                .map_err(err)?
                .to_string_lossy()
                .into_owned();
            let old = value["payload"]["model_provider"]
                .as_str()
                .unwrap_or("openai");
            let changed = if restore {
                let saved = &ledger["files"][&key];
                if !saved.is_object() {
                    continue;
                }
                if old != "xwx_deck" {
                    outcome["skippedLockedJsonlFiles"] =
                        json!(outcome["skippedLockedJsonlFiles"].as_u64().unwrap() + 1);
                    continue;
                }
                let original = saved["line"].as_str().ok_or("历史恢复账本损坏")?;
                let previous: Value = serde_json::from_str(original).map_err(err)?;
                // Restore only provider attribution; all other external metadata survives.
                if let Some(provider) = previous["payload"].get("model_provider") {
                    value["payload"]["model_provider"] = provider.clone();
                } else {
                    value["payload"]
                        .as_object_mut()
                        .unwrap()
                        .remove("model_provider");
                }
                value.to_string() + "\n"
            } else {
                if old == "xwx_deck" {
                    continue;
                }
                if ledger["files"].get(&key).is_none() {
                    let backup = self.root.join("history-jsonl-backup");
                    fs::create_dir_all(&backup).map_err(err)?;
                    fs::copy(
                        &file,
                        backup.join(format!("{}.jsonl", storage::digest(key.as_bytes()))),
                    )
                    .map_err(err)?;
                    ledger["files"][&key] = json!({"line":line});
                    write(&ledger_path, &ledger.to_string())?;
                }
                value["payload"]["model_provider"] = json!("xwx_deck");
                value.to_string() + "\n"
            };
            if rewrite(&file, &line, &changed).is_ok() {
                let field = if restore {
                    "restoredJsonlFiles"
                } else {
                    "migratedJsonlFiles"
                };
                outcome[field] = json!(outcome[field].as_u64().unwrap() + 1);
                if restore {
                    ledger["files"].as_object_mut().unwrap().remove(&key);
                    write(&ledger_path, &ledger.to_string())?;
                }
            } else {
                outcome["skippedLockedJsonlFiles"] =
                    json!(outcome["skippedLockedJsonlFiles"].as_u64().unwrap() + 1);
            }
        }
        for entry in fs::read_dir(&codex).map_err(err)? {
            let entry = entry.map_err(err)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("state_")
                || !name.ends_with(".sqlite")
                || !entry.file_type().map_err(err)?.is_file()
            {
                continue;
            }
            let result = (|| -> Result<u64> {
                let mut db = Connection::open_with_flags(
                    entry.path(),
                    OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
                )
                .map_err(err)?;
                db.busy_timeout(Duration::from_millis(750)).map_err(err)?;
                let rows: Vec<(String, String)> = {
                    let mut statement = db
                        .prepare("SELECT id,model_provider FROM threads")
                        .map_err(err)?;
                    let rows = statement
                        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                        .map_err(err)?
                        .collect::<std::result::Result<Vec<_>, _>>()
                        .map_err(err)?;
                    rows
                };
                let backup = self
                    .root
                    .join(format!("history-db-backup-{}-{name}", millis()));
                db.backup("main", &backup, None).map_err(err)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&backup, fs::Permissions::from_mode(0o600)).map_err(err)?;
                }
                let transaction = db
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(err)?;
                let mut count = 0;
                for (id, provider) in rows {
                    let key = format!("{name}:{id}");
                    let target = if restore {
                        if provider != "xwx_deck" {
                            continue;
                        }
                        let Some(old) = ledger["rows"][&key].as_str() else {
                            continue;
                        };
                        old.to_string()
                    } else {
                        if provider == "xwx_deck" {
                            continue;
                        }
                        if ledger["rows"].get(&key).is_none() {
                            ledger["rows"][&key] = json!(provider);
                            write(&ledger_path, &ledger.to_string())?;
                        }
                        "xwx_deck".into()
                    };
                    count+=transaction.execute("UPDATE threads SET model_provider=?1 WHERE id=?2 AND model_provider=?3",params![target,id,provider]).map_err(err)? as u64;
                }
                transaction.commit().map_err(err)?;
                Ok(count)
            })();
            match result {
                Ok(count) => {
                    let field = if restore {
                        "restoredStateRows"
                    } else {
                        "migratedStateRows"
                    };
                    outcome[field] = json!(outcome[field].as_u64().unwrap() + count);
                }
                Err(_) => {
                    outcome["skippedLockedStateDbs"] =
                        json!(outcome["skippedLockedStateDbs"].as_u64().unwrap() + 1)
                }
            }
        }
        self.settings.codex_enhancements["pendingHistoryRestore"] = json!(
            restore
                && (outcome["skippedLockedJsonlFiles"].as_u64().unwrap() > 0
                    || outcome["skippedLockedStateDbs"].as_u64().unwrap() > 0)
        );
        if restore
            && !self.settings.codex_enhancements["pendingHistoryRestore"]
                .as_bool()
                .unwrap()
        {
            fs::remove_file(&ledger_path).ok();
        }
        self.persist()?;
        Ok(outcome)
    }
}
