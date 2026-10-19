//! Session-local, lossless content storage. JSONL keeps metadata and JSON-pointer
//! references; SQLite owns independent Zstd objects, so deleting a session needs
//! no reference counting and reading a request never replays earlier requests.
use super::*;
use rusqlite::{params, Connection, OpenFlags};
use std::io::Read;

const MARKER: &str = "_traceContent";
const MIN_BYTES: usize = 1024;
const MAX_BYTES: usize = 256 * 1024 * 1024;

pub(super) fn path(log: &Path) -> PathBuf {
    log.with_extension("content.sqlite")
}

fn check_file(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.file_type().is_file() => {
            Err("Trace 正文库不是普通文件，原内容已保留".into())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(err(error)),
    }
}

fn open(log: &Path, writable: bool) -> Result<Connection> {
    let file = path(log);
    check_file(&file)?;
    for suffix in ["-journal", "-wal", "-shm"] {
        check_file(&PathBuf::from(format!("{}{suffix}", file.display())))?;
    }
    let new = writable && !file.exists();
    if new {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&file).map_err(err)?;
    }
    let flags = if writable {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    let db = Connection::open_with_flags(file, flags).map_err(err)?;
    if new {
        db.execute_batch(
            "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
             CREATE TABLE content (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL,
                                   zstd BLOB NOT NULL) WITHOUT ROWID;
             PRAGMA user_version=1;",
        )
        .map_err(err)?;
    }
    if db
        .pragma_query_value::<u32, _>(None, "user_version", |row| row.get(0))
        .map_err(err)?
        != 1
    {
        return Err("Trace 正文库版本无效，原内容已保留".into());
    }
    Ok(db)
}

fn escape(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

// Keep small structure inline. Each large array item (message, tool or event)
// is one independent object; large string fields are objects too. No object
// contains references, and payloads can never be confused with storage markers.
fn split(
    value: &mut Value,
    pointer: &str,
    item: bool,
    refs: &mut serde_json::Map<String, Value>,
    chunks: &mut BTreeMap<String, Vec<u8>>,
) -> Result<()> {
    if item || value.is_string() {
        let bytes = serde_json::to_vec(value).map_err(err)?;
        if bytes.len() >= MIN_BYTES {
            if bytes.len() > MAX_BYTES {
                return Err("Trace 单块正文超过保存上限".into());
            }
            let hash = digest(&bytes);
            refs.insert(pointer.into(), json!(hash));
            chunks.entry(hash).or_insert(bytes);
            *value = Value::Null;
            return Ok(());
        }
    }
    match value {
        Value::Array(items) => {
            for (i, value) in items.iter_mut().enumerate() {
                split(value, &format!("{pointer}/{i}"), true, refs, chunks)?;
            }
        }
        Value::Object(fields) => {
            for (key, value) in fields {
                split(
                    value,
                    &format!("{pointer}/{}", escape(key)),
                    false,
                    refs,
                    chunks,
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(super) fn encode(log: &Path, record: &Value) -> Result<Value> {
    if record.get(MARKER).is_some() {
        return Err("Trace 记录含保留的存储字段".into());
    }
    let mut stored = record.clone();
    let mut refs = serde_json::Map::new();
    let mut chunks = BTreeMap::new();
    for pointer in [
        "/request/body",
        "/upstream/requestBody",
        "/upstream/transportRequest",
        "/upstream/body",
        "/upstream/rawBody",
        "/response/body",
        "/response/rawBody",
        "/normalizedRequest",
        "/clientFirstPrompt",
        "/sse",
        "/intermediateResponse",
        "/attemptResponse",
    ] {
        if let Some(value) = stored.pointer_mut(pointer) {
            split(value, pointer, false, &mut refs, &mut chunks)?;
        }
    }
    if refs.is_empty() {
        return Ok(stored);
    }
    if !path(log).exists() {
        if let Some(source) = read(log)? {
            for line in source.lines().filter(|line| !line.trim().is_empty()) {
                let previous: Value = serde_json::from_str(line).map_err(err)?;
                if previous.get(MARKER).is_some() {
                    return Err("Trace 正文库缺失，未创建替代文件；请保留会话日志一起检查".into());
                }
            }
        }
    }
    let mut db = open(log, true)?;
    let transaction = db.transaction().map_err(err)?;
    for (hash, bytes) in chunks {
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM content WHERE hash=?1)",
                [&hash],
                |row| row.get(0),
            )
            .map_err(err)?;
        if !exists {
            let compressed = zstd::stream::encode_all(bytes.as_slice(), 3).map_err(err)?;
            transaction
                .execute(
                    "INSERT INTO content VALUES (?1,?2,?3)",
                    params![hash, bytes.len() as i64, compressed],
                )
                .map_err(err)?;
        }
    }
    // Commit content before publishing references. An interrupted append can
    // leave unused objects, but it cannot publish references to uncommitted data.
    transaction.commit().map_err(err)?;
    stored[MARKER] = json!({"version":1,"refs":refs});
    Ok(stored)
}

pub(super) fn decode(log: &Path, mut record: Value) -> Result<Value> {
    let Some(metadata) = record.get(MARKER) else {
        return Ok(record);
    };
    if metadata["version"] != 1 {
        return Err("Trace 正文引用版本无效".into());
    }
    let refs = metadata["refs"]
        .as_object()
        .ok_or("Trace 正文引用无效")?
        .clone();
    let db = open(log, false).map_err(|error| format!("Trace 正文库无法读取：{error}"))?;
    for (pointer, hash) in refs {
        let hash = hash
            .as_str()
            .filter(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or("Trace 正文哈希无效")?;
        let slot = record
            .pointer_mut(&pointer)
            .filter(|slot| slot.is_null())
            .ok_or("Trace 正文引用位置无效")?;
        let (length, compressed): (i64, Vec<u8>) = db
            .query_row(
                "SELECT bytes,zstd FROM content WHERE hash=?1",
                [hash],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| format!("Trace 正文块缺失或损坏：{error}"))?;
        if length < 0 || length > MAX_BYTES as i64 || compressed.len() > MAX_BYTES {
            return Err("Trace 正文块大小无效".into());
        }
        let mut bytes = Vec::new();
        zstd::stream::read::Decoder::new(compressed.as_slice())
            .map_err(err)?
            .take(length as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(err)?;
        if bytes.len() as i64 != length || digest(&bytes) != hash {
            return Err("Trace 正文块校验失败，原文件已保留".into());
        }
        *slot = serde_json::from_slice(&bytes).map_err(err)?;
    }
    record
        .as_object_mut()
        .ok_or("Trace 记录无效")?
        .remove(MARKER);
    Ok(record)
}

pub(super) fn remove(log: &Path) -> Result<()> {
    let file = path(log);
    // SQLite connections are short-lived; never leave an open handle across
    // retention, deletion or a directory change (including on Windows).
    for suffix in ["-journal", "-wal", "-shm", ""] {
        let target = PathBuf::from(format!("{}{suffix}", file.display()));
        check_file(&target)?;
        if target.exists() {
            fs::remove_file(target).map_err(err)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!("xwx-content-{}-{}", std::process::id(), uuid()));
            fs::create_dir_all(&root).unwrap();
            Self(root.join("session.jsonl"))
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(self.0.parent().unwrap()).unwrap();
        }
    }
    fn uuid() -> String {
        let mut bytes = [0; 16];
        getrandom::fill(&mut bytes).unwrap();
        digest(&bytes)[..24].to_owned()
    }
    fn count(log: &Path) -> i64 {
        open(log, false)
            .unwrap()
            .query_row("SELECT count(*) FROM content", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn lossless_dedup_survives_reopen_and_preserves_independent_requests() {
        let fixture = Fixture::new();
        let message = json!({"role":"user","content": "中文 🦀 \n\"\\".repeat(1000),
            "metadata":{"_traceContent":{"version":99},"~/":"payload"}});
        let record = json!({"id":"one","request":{"body":{"input":[message]}},
            "upstream":{"requestBody":{"input":[message]}},"response":{"rawBody":"line\r\n".repeat(2000)}});
        let stored = encode(&fixture.0, &record).unwrap();
        assert_eq!(
            count(&fixture.0),
            2,
            "both sides share an identical message"
        );
        assert_eq!(decode(&fixture.0, stored.clone()).unwrap(), record);
        fs::write(&fixture.0, format!("{stored}\n")).unwrap();
        let mut next = record.clone();
        next["id"] = json!("two");
        next["request"]["body"]["input"]
            .as_array_mut()
            .unwrap()
            .push(json!({"role":"user","content":"next"}));
        let encoded_next = encode(&fixture.0, &next).unwrap();
        assert_eq!(count(&fixture.0), 2, "restart needs no in-memory dedup map");
        assert_eq!(decode(&fixture.0, encoded_next).unwrap(), next);
        assert_eq!(decode(&fixture.0, stored).unwrap(), record);
    }

    #[test]
    fn small_and_plain_records_do_not_create_a_database() {
        let fixture = Fixture::new();
        let record =
            json!({"request":{"body":{"input":"small"}},"response":{"body":{"value":null}}});
        assert_eq!(encode(&fixture.0, &record).unwrap(), record);
        assert_eq!(decode(&fixture.0, record.clone()).unwrap(), record);
        assert!(!path(&fixture.0).exists());
    }

    #[test]
    fn plain_payload_marker_does_not_block_first_compressed_append() {
        let fixture = Fixture::new();
        let plain = json!({"request":{"body":{"_traceContent":{"version":1,"refs":{}}}}});
        let source = format!("{plain}\n");
        fs::write(&fixture.0, &source).unwrap();
        let next = json!({"request":{"body":{"input":"large history".repeat(1000)}}});
        let stored = encode(&fixture.0, &next).unwrap();
        assert_eq!(decode(&fixture.0, stored).unwrap(), next);
        assert_eq!(decode(&fixture.0, plain.clone()).unwrap(), plain);
        assert_eq!(fs::read_to_string(&fixture.0).unwrap(), source);
    }

    #[test]
    fn changed_bytes_and_sessions_are_never_merged() {
        let fixture = Fixture::new();
        let other = fixture.0.with_file_name("other.jsonl");
        let record = json!({"request":{"body":{"input":"same".repeat(1000)}}});
        let stored = encode(&fixture.0, &record).unwrap();
        let mut changed = record.clone();
        changed["request"]["body"]["input"] = json!(format!(
            "{} ",
            record["request"]["body"]["input"].as_str().unwrap()
        ));
        encode(&fixture.0, &changed).unwrap();
        assert_eq!(count(&fixture.0), 2);
        let second = encode(&other, &record).unwrap();
        remove(&fixture.0).unwrap();
        assert!(decode(&fixture.0, stored).is_err());
        assert_eq!(decode(&other, second).unwrap(), record);
    }

    #[test]
    fn missing_or_corrupt_content_is_reported_without_replacement() {
        let fixture = Fixture::new();
        let record = json!({"request":{"body":{"input":"private".repeat(1000)}}});
        let stored = encode(&fixture.0, &record).unwrap();
        fs::write(&fixture.0, format!("{stored}\n")).unwrap();
        let db = open(&fixture.0, true).unwrap();
        db.execute(
            "UPDATE content SET zstd=?1",
            [zstd::stream::encode_all(&b"null"[..], 3).unwrap()],
        )
        .unwrap();
        drop(db);
        let before = fs::read(path(&fixture.0)).unwrap();
        assert!(decode(&fixture.0, stored.clone()).is_err());
        assert_eq!(before, fs::read(path(&fixture.0)).unwrap());
        fs::remove_file(path(&fixture.0)).unwrap();
        assert!(decode(&fixture.0, stored).is_err());
        assert!(encode(&fixture.0, &record).unwrap_err().contains("缺失"));
        assert!(!path(&fixture.0).exists());
    }

    #[test]
    fn repeated_history_uses_less_than_a_tenth_of_expanded_json() {
        let fixture = Fixture::new();
        let context = (0..2000)
            .map(|i| digest(format!("fixture-{i}").as_bytes()))
            .collect::<String>();
        let mut disk = String::new();
        let mut expanded = 0;
        let mut history = vec![json!({"role":"system","content":context})];
        for turn in 0..30 {
            history.push(json!({"role":"user","content":format!("turn-{turn}")}));
            let record = json!({"id":turn,"request":{"body":{"input":history}},"upstream":{"requestBody":{"input":history}}});
            expanded += record.to_string().len();
            let stored = encode(&fixture.0, &record).unwrap();
            assert_eq!(decode(&fixture.0, stored.clone()).unwrap(), record);
            disk.push_str(&format!("{stored}\n"));
        }
        fs::write(&fixture.0, disk).unwrap();
        let physical =
            fs::metadata(&fixture.0).unwrap().len() + fs::metadata(path(&fixture.0)).unwrap().len();
        eprintln!("Trace content fixture: expanded={expanded}, physical={physical}");
        assert!(physical * 10 < expanded as u64);
        assert_eq!(count(&fixture.0), 1);
    }

    fn capture(id: &str, input: &str) -> Value {
        json!({"id":id,"source":"codex-cli","clientConversationKey":"thread",
            "startedAt":"2026-10-19T00:00:00Z","startedAtMs":1792368000000u64,
            "completedAt":"2026-10-19T00:00:01Z","durationMs":1000,
            "request":{"model":"fixture","apiType":"responses","body":{"input":[
                {"role":"user","content":"fixture question"}, {"role":"assistant","content":input}]}},
            "upstream":{"requestBody":{"input":input}},"response":{"statusCode":200,"rawBody":input},
            "usage":{"inputTokens":2,"outputTokens":3,"totalTokens":5}})
    }

    #[test]
    fn store_reopen_repair_delete_and_zero_limit_keep_accounting() {
        let fixture = Fixture::new();
        let root = fixture.0.parent().unwrap();
        let store = TraceStore::open(root.into(), u64::MAX, false, root).unwrap();
        let original = capture("first", &"history".repeat(10000));
        {
            let mut store = store.lock().unwrap();
            store.append(original.clone(), "thread").unwrap();
            let mut next = original.clone();
            next["id"] = json!("second");
            store.append(next, "thread").unwrap();
        }
        drop(store);
        let store = TraceStore::open(root.into(), u64::MAX, false, root).unwrap();
        let mut store = store.lock().unwrap();
        let session = store.index["sessions"][0].clone();
        let log = PathBuf::from(session["jsonlPath"].as_str().unwrap());
        let id = session["id"].as_str().unwrap();
        assert_eq!(count(&log), 2);
        let row = &store
            .page_projection(id, None, None, 200, false, Some("first"))
            .unwrap()
            .unwrap()["traces"][0];
        assert_eq!(row["request"], original["request"]);
        assert_eq!(row["upstream"], original["upstream"]);
        assert_eq!(row["response"], original["response"]);
        let log_before = fs::read(&log).unwrap();
        let db_before = fs::read(path(&log)).unwrap();
        store.apply_repair(None).unwrap();
        assert_eq!(fs::read(&log).unwrap(), log_before);
        assert_eq!(fs::read(path(&log)).unwrap(), db_before);
        assert_eq!(store.stats()["total"]["tokens"], 10);
        assert!(store.delete(id, false).unwrap());
        assert!(!log.exists() && !path(&log).exists());
        assert_eq!(store.stats()["total"]["tokens"], 10);
        store
            .append(capture("third", "private".repeat(10000).as_str()), "thread")
            .unwrap();
        store.limit = 0;
        store.apply_retention();
        assert!(store.retention_notice.is_none());
        assert!(!log.exists() && !path(&log).exists());
        assert_eq!(store.stats()["total"]["tokens"], 15);
    }

    #[test]
    fn damaged_content_blocks_index_repair_and_preserves_history() {
        let fixture = Fixture::new();
        let root = fixture.0.parent().unwrap();
        let store = TraceStore::open(root.into(), u64::MAX, false, root).unwrap();
        let mut store = store.lock().unwrap();
        store
            .append(capture("first", &"history".repeat(10000)), "thread")
            .unwrap();
        let log = PathBuf::from(store.index["sessions"][0]["jsonlPath"].as_str().unwrap());
        let index_before = fs::read(root.join("index.json")).unwrap();
        let log_before = fs::read(&log).unwrap();
        fs::remove_file(path(&log)).unwrap();
        assert_eq!(
            store.inspect_repair().unwrap()["contentErrors"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(store.apply_repair(None).unwrap_err().contains("正文库"));
        assert_eq!(fs::read(root.join("index.json")).unwrap(), index_before);
        assert_eq!(fs::read(&log).unwrap(), log_before);
        assert!(!path(&log).exists());
    }

    #[test]
    fn expanded_page_budget_remains_contiguous_for_compressed_records() {
        let fixture = Fixture::new();
        let root = fixture.0.parent().unwrap();
        let file = &fixture.0;
        let body = "x".repeat(9 * 1024 * 1024);
        let source = (0..5)
            .map(|i| {
                encode(
                    file,
                    &json!({"id":format!("request-{i}"),"sessionId":"fixture",
            "startedAt":format!("2026-10-19T00:00:0{i}Z"),"request":{"body":{"input":body}},
            "costSnapshot":{"version":1,"costComplete":true}}),
                )
                .unwrap()
                .to_string()
            })
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(file, source).unwrap();
        fs::write(
            root.join("index.json"),
            json!({"version":1,"sessions":[{
            "id":"fixture","jsonlPath":file,"traceCount":5,"captureClassificationVersion":1}]})
            .to_string(),
        )
        .unwrap();
        let store = TraceStore::open(root.into(), u64::MAX, false, root).unwrap();
        let store = store.lock().unwrap();
        let tail = store.page("fixture", None, None, 200).unwrap().unwrap();
        assert_eq!(tail["offset"], 3);
        assert_eq!(tail["traces"][1]["id"], "request-4");
        let previous = store.page("fixture", None, Some(3), 200).unwrap().unwrap();
        assert_eq!(previous["offset"], 1);
        assert_eq!(previous["traces"][0]["id"], "request-1");
        let summaries = store
            .page_projection("fixture", Some(0), None, 200, true, None)
            .unwrap()
            .unwrap();
        assert_eq!(summaries["traces"].as_array().unwrap().len(), 5);
        assert!(summaries.to_string().len() < 10000);
    }
}
