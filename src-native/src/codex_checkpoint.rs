//! Read only the indexed native thread when a known foreign compact must be
//! replaced. Bind recovery to the exact opaque item, not a title or last session.
use super::*;
use rusqlite::{Connection, OpenFlags};
use std::io::{BufRead, BufReader, Seek, SeekFrom};

const MAX_CONTEXT: usize = 8 * 1024 * 1024;
const MAX_RECORD: usize = 16 * 1024 * 1024;

// Keep offsets only, never a second copy of private conversation bodies. A
// changed file is indexed again; an old request must never use a newer compact.
#[derive(Clone)]
struct Boundary {
    path: PathBuf,
    len: u64,
    modified: SystemTime,
    seal: String,
    window: Option<(u64, u64)>,
}
static BOUNDARIES: std::sync::Mutex<Vec<Boundary>> = std::sync::Mutex::new(Vec::new());

// Drain oversized old records without allocating their full payload. They only
// fail recovery if they are inside the selected effective context window.
fn record(reader: &mut BufReader<fs::File>, line: &mut Vec<u8>) -> Result<bool> {
    line.clear();
    let mut oversized = false;
    loop {
        let chunk = reader.fill_buf().map_err(err)?;
        if chunk.is_empty() {
            if line.is_empty() && !oversized {
                return Ok(false);
            }
            return Err("原对话历史未完整写入，请等待当前回合结束后重试".into());
        }
        let end = chunk.iter().position(|b| *b == b'\n').map(|n| n + 1);
        let count = end.unwrap_or(chunk.len());
        if !oversized && line.len() + count <= MAX_RECORD {
            line.extend_from_slice(&chunk[..count]);
        } else {
            oversized = true;
            line.clear();
        }
        reader.consume(count);
        if end.is_some() {
            return Ok(true);
        }
    }
}

fn visible(payload: &Value) -> Result<Option<Vec<Value>>> {
    if let Some(items) = payload["replacement_history"].as_array() {
        let (items, complete) = super::portable(&json!(items))?;
        return Ok((complete && !items.is_empty()).then_some(items));
    }
    // Older client-summary records did not store replacement_history.
    let summary = text(payload, "message");
    Ok((!summary.is_empty()).then(|| vec![json!({"role":"user","content":summary})]))
}

fn boundary(
    reader: &mut BufReader<fs::File>,
    path: &Path,
    before: &fs::Metadata,
    seal: &str,
) -> Result<Option<(u64, u64)>> {
    let digest = seal.to_string();
    let modified = before.modified().map_err(err)?;
    if let Some(hit) = BOUNDARIES.lock().map_err(err)?.iter().find(|entry| {
        entry.path == path
            && entry.len == before.len()
            && entry.modified == modified
            && entry.seal == digest
    }) {
        return Ok(hit.window);
    }
    let mut start = reader.stream_position().map_err(err)?;
    let mut line = vec![];
    let mut window = None;
    loop {
        let offset = reader.stream_position().map_err(err)?;
        if !record(reader, &mut line)? {
            break;
        }
        // Only compaction boundaries are needed in this pass. Damaged or large
        // superseded records are checked only if the selected window needs them.
        let Ok(row) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        if row["type"] != "compacted" {
            continue;
        }
        let payload = &row["payload"];
        if payload["replacement_history"]
            .as_array()
            .is_some_and(|items| {
                items.iter().any(|item| {
                    let opaque = text(item, "encrypted_content");
                    !opaque.is_empty() && storage::digest(opaque.as_bytes()) == seal
                })
            })
        {
            window = Some((start, offset));
            break;
        }
        if visible(payload)?.is_some() {
            start = offset;
        }
    }
    let mut cache = BOUNDARIES.lock().map_err(err)?;
    cache.retain(|entry| entry.path != path || entry.seal != digest);
    if cache.len() >= 32 {
        cache.remove(0);
    }
    cache.push(Boundary {
        path: path.into(),
        len: before.len(),
        modified,
        seal: digest,
        window,
    });
    Ok(window)
}

fn recover_window(
    reader: &mut BufReader<fs::File>,
    start: u64,
    end: u64,
) -> Result<Option<Vec<Value>>> {
    reader.seek(SeekFrom::Start(start)).map_err(err)?;
    let mut history = vec![];
    let mut complete = true;
    let mut bytes = 0usize;
    let mut line = vec![];
    while reader.stream_position().map_err(err)? < end && record(reader, &mut line)? {
        if line.is_empty() {
            return Err("本次有效恢复记录超过 16 MiB，请在原服务生成较小的明文摘要后继续".into());
        }
        let row: Value =
            serde_json::from_slice(&line).map_err(|_| "本次有效上下文包含损坏记录，未自动恢复")?;
        match text(&row, "type") {
            "compacted" => {
                if let Some(items) = visible(&row["payload"])? {
                    history = items;
                    complete = true;
                    bytes = history.iter().map(|item| item.to_string().len()).sum();
                } else if history.is_empty() {
                    complete = false;
                }
            }
            "response_item" => {
                let (items, valid) = super::portable(&json!([row["payload"]]))?;
                complete &= valid;
                bytes += items
                    .iter()
                    .map(|item| item.to_string().len())
                    .sum::<usize>();
                history.extend(items);
            }
            _ => {}
        }
        if bytes > MAX_CONTEXT {
            return Err(
                "本次有效恢复上下文超过 8 MiB，请在原服务生成较小的明文摘要后继续；未截断历史"
                    .into(),
            );
        }
    }
    for item in &mut history {
        if let Some(object) = item.as_object_mut() {
            object.remove("id");
        }
    }
    Ok((complete && !history.is_empty()).then_some(history))
}

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
    if seal.is_empty() {
        return Ok(None);
    }
    read_hash(home, thread, &storage::digest(seal.as_bytes()), recover)
}

pub(super) fn read_hash(
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
    let mut reader = BufReader::new(file);
    let mut line = vec![];
    if !record(&mut reader, &mut line)? {
        return Ok(None);
    }
    let metadata: Value =
        serde_json::from_slice(&line).map_err(|_| "原对话元信息损坏，未自动恢复")?;
    if metadata["type"] != "session_meta" || metadata["payload"]["id"] != thread {
        return Ok(None);
    }
    let provider = text(&metadata["payload"], "model_provider").to_string();
    if provider.is_empty() {
        return Ok(None);
    }
    if !recover {
        return Ok(Some(Checkpoint {
            provider,
            input: None,
        }));
    }
    let restored = match boundary(&mut reader, &canonical, &before, seal)? {
        Some((start, end)) => recover_window(&mut reader, start, end)?,
        None => None,
    };
    let after = fs::metadata(&canonical).map_err(err)?;
    if before.len() != after.len()
        || before.modified().map_err(err)? != after.modified().map_err(err)?
    {
        return Err("原对话历史正在变化，请重试续接；原文件未修改".into());
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
    fn large_history_metadata_does_not_read_or_limit_the_body() {
        let fixture = Fixture::new();
        let file = fixture.write(&(source().lines().next().unwrap().to_string() + "\n"));
        fs::OpenOptions::new()
            .write(true)
            .open(&file)
            .unwrap()
            .set_len(72 * 1024 * 1024)
            .unwrap();
        let saved = read_thread(&fixture.0, "thread", "unknown-reasoning", false)
            .unwrap()
            .unwrap();
        assert_eq!(saved.provider, "openai");
        assert!(saved.input.is_none());
    }
    #[test]
    fn large_history_uses_exact_window_not_superseded_or_future_context() {
        use std::io::Write;
        let fixture = Fixture::new();
        let file = fixture.write(&(source().lines().next().unwrap().to_string() + "\n"));
        let mut writer = fs::OpenOptions::new().append(true).open(&file).unwrap();
        let padding = json!({"type":"event_msg","payload":{"text":"x".repeat(1024 * 1024)}})
            .to_string()
            + "\n";
        for _ in 0..65 {
            writer.write_all(padding.as_bytes()).unwrap();
        }
        // Even a single old record over the allocation bound is superseded.
        writer.write_all(format!("{}\n", json!({"type":"response_item","payload":{"type":"message","role":"user","content":"obsolete".repeat(3 * 1024 * 1024)}})).as_bytes()).unwrap();
        for row in [
            json!({"type":"compacted","payload":{"replacement_history":[
                {"type":"message","role":"user","content":"retained user constraint"},
                {"type":"message","role":"user","content":"effective summary"}
            ]}}),
            json!({"type":"response_item","payload":{"type":"function_call","id":"foreign","call_id":"done","name":"read","arguments":"{}"}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"done","output":"finished"}}),
            json!({"type":"compacted","payload":{"replacement_history":[{"type":"compaction","encrypted_content":"target-seal"}]}}),
            json!({"type":"compacted","payload":{"replacement_history":[{"role":"user","content":"future summary must not leak"}]}}),
        ] {
            writeln!(writer, "{row}").unwrap();
        }
        drop(writer);
        let before = file.metadata().unwrap();
        for _ in 0..2 {
            let saved = read_thread(&fixture.0, "thread", "target-seal", true)
                .unwrap()
                .unwrap();
            let input = saved.input.unwrap();
            assert_eq!(input.len(), 4);
            assert_eq!(input[0]["content"], "retained user constraint");
            assert_eq!(input[1]["content"], "effective summary");
            assert_eq!(input[2]["call_id"], input[3]["call_id"]);
            assert!(input[2].get("id").is_none());
            assert!(!json!(input).to_string().contains("obsolete"));
            assert!(!json!(input).to_string().contains("future summary"));
        }
        assert_eq!(file.metadata().unwrap().len(), before.len());
        assert_eq!(
            file.metadata().unwrap().modified().unwrap(),
            before.modified().unwrap()
        );
    }
    #[test]
    fn effective_window_limit_is_not_bypassed_and_legacy_summary_is_supported() {
        let fixture = Fixture::new();
        let meta = source().lines().next().unwrap().to_string() + "\n";
        let compact = json!({"type":"compacted","payload":{"replacement_history":[{"type":"compaction","encrypted_content":"seal"}]}});
        let file = fixture.write(&format!("{meta}{}\n{compact}\n",
            json!({"type":"response_item","payload":{"role":"user","content":"x".repeat(MAX_CONTEXT)}})));
        assert!(read_thread(&fixture.0, "thread", "seal", true)
            .err()
            .unwrap()
            .contains("有效恢复上下文超过 8 MiB"));
        fs::write(
            &file,
            format!(
                "{meta}{}\n{compact}\n",
                json!({"type":"compacted","payload":{"message":"legacy handoff"}})
            ),
        )
        .unwrap();
        assert_eq!(
            read_thread(&fixture.0, "thread", "seal", true)
                .unwrap()
                .unwrap()
                .input
                .unwrap()[0]["content"],
            "legacy handoff"
        );
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
