//! Read only the indexed native thread when a known foreign compact must be
//! replaced. Bind recovery to the exact opaque item, not a title or last session.
use super::*;
use rusqlite::{Connection, OpenFlags};
use std::io::{BufRead, BufReader};

const MAX_FILE: u64 = 64 * 1024 * 1024;
const MAX_CONTEXT: usize = 8 * 1024 * 1024;

pub(super) struct Checkpoint {
    pub provider: String,
    pub input: Option<Vec<Value>>,
}

pub(super) fn read_thread(
    home: &Path,
    thread: &str,
    seal: &str,
    recover: bool,
) -> Result<Option<Checkpoint>> {
    if thread.is_empty() || thread.len() > 128 || seal.is_empty() {
        return Ok(None);
    }
    let mut indexed = None;
    for entry in fs::read_dir(home).map_err(err)? {
        let entry = entry.map_err(err)?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("state_") || !name.ends_with(".sqlite") {
            continue;
        }
        if !entry.file_type().map_err(err)?.is_file() {
            continue;
        }
        let Ok(db) = Connection::open_with_flags(entry.path(), OpenFlags::SQLITE_OPEN_READ_ONLY)
        else {
            continue;
        };
        let _ = db.busy_timeout(Duration::from_millis(50));
        let found = db.query_row(
            "SELECT rollout_path FROM threads WHERE id = ?1",
            [thread],
            |row| row.get::<_, String>(0),
        );
        let Ok(found) = found else { continue };
        if indexed.as_ref().is_some_and(|old| old != &found) {
            return Err("原对话有多个不同的历史索引，未自动恢复上下文".into());
        }
        indexed = Some(found);
    }
    let Some(indexed) = indexed else {
        return Ok(None);
    };
    let requested = PathBuf::from(indexed);
    let canonical_home = fs::canonicalize(home).map_err(err)?;
    let canonical = fs::canonicalize(&requested).map_err(err)?;
    if !same_physical_path(&requested)?
        || !["sessions", "archived_sessions"]
            .iter()
            .any(|folder| canonical.starts_with(canonical_home.join(folder)))
    {
        return Err("原对话历史路径不在客户端受管目录，未读取正文".into());
    }
    let file = fs::File::open(&canonical).map_err(err)?;
    let before = file.metadata().map_err(err)?;
    if before.len() > MAX_FILE {
        return Err("原对话历史超过恢复读取上限，请回到原服务压缩后继续".into());
    }
    let mut provider = String::new();
    let mut history = vec![];
    let mut complete = true;
    let mut bytes = 0usize;
    let mut restored = None;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut read_bytes = 0u64;
    while reader.read_line(&mut line).map_err(err)? > 0 {
        read_bytes += line.len() as u64;
        if read_bytes > MAX_FILE || line.len() > MAX_CONTEXT || !line.ends_with('\n') {
            return Err("原对话历史未完整写入或超过读取上限，未自动恢复".into());
        }
        let row: Value =
            serde_json::from_str(&line).map_err(|_| "原对话历史包含损坏记录，未自动恢复")?;
        match text(&row, "type") {
            "session_meta" => {
                if row["payload"]["id"] != thread {
                    return Ok(None);
                }
                provider = text(&row["payload"], "model_provider").into();
                if !recover {
                    break;
                }
            }
            "response_item" => {
                let item = &row["payload"];
                let (portable, item_complete) = super::portable(&json!([item]))?;
                complete &= item_complete;
                for mut item in portable {
                    if let Some(object) = item.as_object_mut() {
                        object.remove("id");
                    }
                    bytes += item.to_string().len();
                    if bytes > MAX_CONTEXT {
                        return Err("原对话可携带上下文超过 8 MB，未截断或重放".into());
                    }
                    history.push(item);
                }
            }
            "compacted" => {
                let payload = &row["payload"];
                let matched = payload["replacement_history"]
                    .as_array()
                    .is_some_and(|items| {
                        items.iter().any(|item| item["encrypted_content"] == seal)
                    });
                if matched && complete && !history.is_empty() {
                    restored = Some(history.clone());
                    break;
                }
                // A later checkpoint can use a complete visible replacement,
                // never one containing an opaque compact from another window.
                if let Some(items) = payload["replacement_history"].as_array() {
                    if items
                        .iter()
                        .all(|item| text(item, "encrypted_content").is_empty())
                    {
                        let (mut visible, valid) = super::portable(&json!(items))?;
                        for item in &mut visible {
                            if let Some(object) = item.as_object_mut() {
                                object.remove("id");
                            }
                        }
                        history = visible;
                        complete = valid;
                        bytes = history.iter().map(|item| item.to_string().len()).sum();
                        if bytes > MAX_CONTEXT {
                            return Err("原对话可携带上下文超过 8 MB，未截断或重放".into());
                        }
                    } else if history.is_empty() {
                        complete = false;
                    }
                    // Keep the complete visible prefix already observed before
                    // an earlier opaque compact. Clearing it would make a later
                    // checkpoint recover only its suffix and lose old context.
                }
            }
            _ => {}
        }
        line.clear();
    }
    let after = fs::metadata(&canonical).map_err(err)?;
    if before.len() != after.len()
        || before.modified().map_err(err)? != after.modified().map_err(err)?
    {
        return Err("原对话历史正在变化，请重试续接；原文件未修改".into());
    }
    if provider.is_empty() {
        return Ok(None);
    }
    Ok(Some(Checkpoint {
        provider,
        input: restored,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    static NEXT_FIXTURE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "xwx-checkpoint-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            fs::create_dir_all(root.join("sessions")).unwrap();
            Self(fs::canonicalize(root).unwrap())
        }
        fn write(&self, source: &str) -> PathBuf {
            let file = self.0.join("sessions/thread.jsonl");
            fs::write(&file, source).unwrap();
            let db = Connection::open(self.0.join("state_5.sqlite")).unwrap();
            db.execute_batch("CREATE TABLE threads(id TEXT, rollout_path TEXT)")
                .unwrap();
            db.execute(
                "INSERT INTO threads VALUES (?1, ?2)",
                ["thread", file.to_str().unwrap()],
            )
            .unwrap();
            file
        }
        fn index(&self, path: &str) {
            Connection::open(self.0.join("state_5.sqlite"))
                .unwrap()
                .execute("UPDATE threads SET rollout_path=?1", [path])
                .unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn source() -> String {
        [json!({"type":"session_meta","payload":{"id":"thread","model_provider":"openai"}}),
         json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"history marker"}]}}),
         json!({"type":"response_item","payload":{"type":"function_call","call_id":"call","name":"read","arguments":"{}"}}),
         json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"call","output":"already done"}}),
         json!({"type":"compacted","payload":{"replacement_history":[{"type":"compaction","encrypted_content":"exact-seal"}]}})].iter().map(|v| format!("{v}\n")).collect()
    }
    #[test]
    fn indexed_exact_checkpoint_preserves_tools_without_writing_history() {
        let fixture = Fixture::new();
        let file = fixture.write(&source());
        let before = fs::read(&file).unwrap();
        let saved = read_thread(&fixture.0, "thread", "exact-seal", true)
            .unwrap()
            .unwrap();
        assert_eq!(saved.provider, "openai");
        let input = saved.input.unwrap();
        assert_eq!(input.len(), 3);
        assert_eq!(input[1]["call_id"], input[2]["call_id"]);
        assert!(!input.iter().any(|v| v["type"] == "compaction"));
        assert_eq!(fs::read(file).unwrap(), before);
        assert!(read_thread(&fixture.0, "other-thread", "exact-seal", true)
            .unwrap()
            .is_none());
        assert!(read_thread(&fixture.0, "thread", "other-seal", true)
            .unwrap()
            .unwrap()
            .input
            .is_none());
    }
    #[test]
    fn reasoning_provenance_reads_only_session_metadata() {
        let fixture = Fixture::new();
        fixture.write(&(source().lines().next().unwrap().to_string() + "\nBROKEN_PRIVATE_BODY"));
        let saved = read_thread(&fixture.0, "thread", "reasoning-seal", false)
            .unwrap()
            .unwrap();
        assert_eq!(saved.provider, "openai");
        assert!(saved.input.is_none());
        assert!(read_thread(&fixture.0, "thread", "exact-seal", true).is_err());
    }
    #[test]
    fn repeated_compaction_keeps_complete_prefix_and_refuses_missing_prefix() {
        let fixture = Fixture::new();
        let later = [
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":"later marker"}}),
            json!({"type":"compacted","payload":{"replacement_history":[{"type":"compaction","encrypted_content":"later-seal"}]}}),
        ].iter().map(|v| format!("{v}\n")).collect::<String>();
        let file = fixture.write(&(source() + &later));
        let recovered = read_thread(&fixture.0, "thread", "later-seal", true)
            .unwrap()
            .unwrap()
            .input
            .unwrap();
        assert_eq!(recovered.len(), 4);
        assert!(recovered[0].to_string().contains("history marker"));
        assert_eq!(recovered[3]["content"], "later marker");
        let rows = source().lines().map(str::to_owned).collect::<Vec<_>>();
        fs::write(&file, format!("{}\n{}\n{later}", rows[0], rows[4])).unwrap();
        assert!(read_thread(&fixture.0, "thread", "later-seal", true)
            .unwrap()
            .unwrap()
            .input
            .is_none());
    }
    #[test]
    fn indexed_paths_outside_native_history_are_refused() {
        let fixture = Fixture::new();
        let file = fixture.write(&source());
        let other = fixture.0.join("private.jsonl");
        fs::copy(&file, &other).unwrap();
        let db = Connection::open(fixture.0.join("state_5.sqlite")).unwrap();
        db.execute(
            "UPDATE threads SET rollout_path=?1",
            [other.to_str().unwrap()],
        )
        .unwrap();
        assert!(read_thread(&fixture.0, "thread", "exact-seal", true)
            .err()
            .unwrap()
            .contains("受管目录"));
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn windows_indexed_drive_and_forward_slash_paths_match_same_history() {
        let fixture = Fixture::new();
        let file = fixture.write(&source());
        let before = fs::read(&file).unwrap();
        let canonical = file.to_str().unwrap();
        let ordinary = canonical.strip_prefix(r"\\?\").unwrap();
        for indexed in [
            ordinary.to_string(),
            ordinary.replace('\\', "/"),
            ordinary.to_ascii_lowercase(),
        ] {
            fixture.index(&indexed);
            let saved = read_thread(&fixture.0, "thread", "exact-seal", true)
                .unwrap()
                .unwrap();
            assert_eq!(saved.provider, "openai");
            assert_eq!(saved.input.unwrap().len(), 3);
            assert_eq!(fs::read(&file).unwrap(), before);
        }
    }
    #[test]
    fn indexed_parent_components_remain_refused_inside_history() {
        let fixture = Fixture::new();
        fixture.write(&source());
        let home = fixture.0.to_string_lossy();
        #[cfg(target_os = "windows")]
        let home = home.trim_start_matches(r"\\?\");
        fixture.index(&format!("{home}/sessions/../sessions/thread.jsonl"));
        assert!(read_thread(&fixture.0, "thread", "exact-seal", true)
            .err()
            .unwrap()
            .contains("受管目录"));
    }
    #[test]
    fn indexed_directory_alias_cannot_redirect_history_reads() {
        let fixture = Fixture::new();
        let file = fixture.write("BROKEN_PRIVATE_BODY");
        let alias = fixture.0.join("history-alias");
        #[cfg(unix)]
        std::os::unix::fs::symlink(fixture.0.join("sessions"), &alias).unwrap();
        #[cfg(target_os = "windows")]
        {
            let output = std::process::Command::new("cmd.exe")
                .args(["/c", "mklink", "/J"])
                .arg(&alias)
                .arg(fixture.0.join("sessions"))
                .output()
                .unwrap();
            assert!(output.status.success(), "{output:?}");
        }
        fixture.index(alias.join("thread.jsonl").to_str().unwrap());
        assert!(read_thread(&fixture.0, "thread", "exact-seal", true)
            .err()
            .unwrap()
            .contains("受管目录"));
        assert_eq!(fs::read_to_string(file).unwrap(), "BROKEN_PRIVATE_BODY");
    }
}
