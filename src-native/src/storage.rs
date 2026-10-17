use super::*;
use axum::response::IntoResponse;
use chrono::{DateTime, Local, Utc};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
#[path = "trace_classification.rs"]
mod trace_classification;
#[path = "trace_pricing.rs"]
mod trace_pricing;
#[cfg(target_os = "windows")]
#[path = "windows_reveal.rs"]
mod windows_reveal;
#[cfg(test)]
use trace_pricing::{model_cost, model_cost_parts};
use trace_pricing::{needs_ark_cost_repair, repaired_cost_point, usage_cost_point};

pub(super) fn provider_price(store: &Store, model: &str, snapshot: Value) -> Value {
    trace_pricing::provider_price(&store.lock().unwrap().prices, model, snapshot)
}
pub(super) fn reference_price(store: &Store, model: &str) -> Value {
    trace_pricing::reference_price(&store.lock().unwrap().prices, model)
}
pub(super) fn freeze_reference_price(store: &Store, record: &mut Value) {
    record["referencePriceVersion"] = json!(1);
    record["referencePrice"] = reference_price(store, text(&record["request"], "model"));
}
pub(super) type Store = Arc<std::sync::Mutex<TraceStore>>;
pub(super) fn iso(at: u128) -> String {
    DateTime::<Utc>::from_timestamp_millis(at as i64)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}
pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn empty_index() -> Value {
    json!({"version":1,"sessions":[]})
}
fn usage_summary(session: &Value) -> Value {
    let mut summary = json!({});
    for key in ["totalTokens", "dailyUsage", "recentRatePoints"] {
        if let Some(value) = session.get(key) {
            summary[key] = value.clone();
        }
    }
    summary
}
// Protect only the conversations with requests in flight, not every session
// merely because the Gateway is enabled. The last completion applies 0 GB.
pub(super) struct DetailLease {
    store: Store,
    id: String,
}
impl DetailLease {
    pub fn new(store: Store, key: &str) -> Self {
        let id = format!("session-{}", &digest(key.as_bytes())[..24]);
        *store
            .lock()
            .unwrap()
            .recording
            .entry(id.clone())
            .or_default() += 1;
        Self { store, id }
    }
}
impl Drop for DetailLease {
    fn drop(&mut self) {
        let mut store = self.store.lock().unwrap();
        if let Some(count) = store.recording.get_mut(&self.id) {
            *count -= 1;
            if *count == 0 {
                store.recording.remove(&self.id);
            }
        }
        store.apply_retention();
    }
}
fn trace_error(record: &Value) -> bool {
    if record["auxiliary"] == "count" && record["response"]["statusCode"] == 404 {
        return false;
    }
    !record["error"].is_null()
        || record["response"]["statusCode"]
            .as_u64()
            .is_some_and(|s| s >= 400)
}
fn records(path: &Path) -> Result<Vec<Value>> {
    let Some(source) = read(path)? else {
        return Ok(vec![]);
    };
    source
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).map_err(err))
        .collect()
}
fn usage(value: &Value, wire: &str) -> Value {
    trace_usage::normalize(value, wire)
}
fn record_usage(value: &Value, wire: &str, record: &Value) -> Value {
    let request = if record["upstream"]["requestBody"].is_object() {
        &record["upstream"]["requestBody"]
    } else {
        &record["request"]["body"]
    };
    trace_usage::normalize_for_request(value, wire, request)
}
pub(super) fn load_prices(root: &Path) -> Vec<Value> {
    let bundled: Vec<Value> =
        serde_json::from_str(include_str!("../../test-results/native-assets/prices.json"))
            .unwrap_or_default();
    let cache = read(&root.join("pricing-cache/models-dev-pricing.json"))
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(|v| v["version"] == 2)
        .unwrap_or(Value::Null);
    let rows: Vec<Value> = cache["rules"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| {
            r["match"] == "exact"
                && r["source"] == "models.dev"
                && r["referenceOnly"] == true
                && r["tokens"]
                    .as_array()
                    .is_some_and(|a| a.len() == 1 && a[0].is_string())
                && ["input", "output"]
                    .iter()
                    .all(|k| r[*k].as_f64().is_some_and(|n| n.is_finite() && n >= 0.0))
        })
        .cloned()
        .map(model_metadata::normalize_cached_price)
        .collect();
    if rows.is_empty() {
        bundled
    } else {
        rows
    }
}

fn accumulate_cache_hit_usage(stats: &mut Value, usage: &Value) {
    if !stats.is_object() {
        *stats =
            json!({"inputTokens":0,"cacheReadTokens":0,"knownRequests":0,"excludedRequests":0});
    }
    let missing = |field| {
        usage["incompleteFields"]
            .as_array()
            .is_some_and(|fields| fields.iter().any(|f| f == field))
    };
    let invalid = usage["invalidFields"]
        .as_array()
        .is_some_and(|fields| fields.iter().any(|f| f == "input" || f == "cacheRead"));
    let input = usage["inputTotalTokens"].as_u64().filter(|_| {
        usage["inputIncludesCache"] == true || (!missing("cacheRead") && !missing("cacheWrite"))
    });
    let pair = input
        .zip(usage["cacheReadTokens"].as_u64())
        .filter(|(i, r)| {
            !invalid && !missing("cacheRead") && i >= r && *i <= 9_007_199_254_740_991
        });
    if let Some((input, read)) = pair {
        stats["inputTokens"] = json!(stats["inputTokens"].as_u64().unwrap_or(0) + input);
        stats["cacheReadTokens"] = json!(stats["cacheReadTokens"].as_u64().unwrap_or(0) + read);
        stats["knownRequests"] = json!(stats["knownRequests"].as_u64().unwrap_or(0) + 1);
    } else {
        stats["excludedRequests"] = json!(stats["excludedRequests"].as_u64().unwrap_or(0) + 1);
    }
}

fn accumulate_model_usage(by_model: &mut Value, record: &Value) {
    let model = text(&record["request"], "model");
    let u = &record["usage"];
    let m = &mut by_model[model];
    let had_usage = m.is_object();
    if !m.is_object() {
        *m = json!({"version":2,"input":0,"inputTotal":0,"inputTotalComplete":true,"output":0,"cacheRead":0,"cacheCreation":0,"total":0,"apiType":record["request"]["apiType"]});
    }
    let point = &record["costSnapshot"];
    let previous = m["capturedCost"]["cost"].as_f64();
    let known = point["knownCostUsd"].as_f64();
    let first = m.get("capturedCost").is_none();
    m["capturedCost"] = json!({
        "cost": if previous.is_some() || known.is_some() { Some(previous.unwrap_or(0.0) + known.unwrap_or(0.0)) } else { None },
        "complete": (first || m["capturedCost"]["complete"] == true) && point["costComplete"] == true
    });
    if m["inputTotal"].is_null() {
        m["inputTotalComplete"] = json!(false);
    }
    if !m["knownFieldCounts"].is_object() {
        // If raw history is unavailable, retain a known legacy aggregate,
        // including explicit zero. Its coverage is a lower bound of one.
        let mut coverage = json!({});
        for (field, key) in [
            ("input", "input"),
            ("cacheRead", "cacheRead"),
            ("cacheWrite", "cacheCreation"),
            ("output", "output"),
            ("total", "total"),
        ] {
            let known = had_usage
                && m[key].as_u64().is_some_and(|n| {
                    n > 0
                        || !m["incompleteFields"]
                            .as_array()
                            .is_some_and(|a| a.iter().any(|f| f == field))
                            && !m["invalidFields"]
                                .as_array()
                                .is_some_and(|a| a.iter().any(|f| f == field))
                });
            coverage[field] = json!(u64::from(known));
        }
        m["knownFieldCounts"] = coverage;
    }
    for (field, key) in [
        ("input", "inputUncachedTokens"),
        ("cacheRead", "cacheReadTokens"),
        ("cacheWrite", "cacheCreationTokens"),
        ("output", "outputTokens"),
        ("total", "totalTokens"),
    ] {
        let valid = u[key].as_u64().is_some()
            && !u["invalidFields"]
                .as_array()
                .is_some_and(|a| a.iter().any(|f| f == field));
        m["knownFieldCounts"][field] =
            json!(m["knownFieldCounts"][field].as_u64().unwrap_or(0) + u64::from(valid));
    }
    for (key, value) in [
        ("input", "inputUncachedTokens"),
        ("inputTotal", "inputTotalTokens"),
        ("output", "outputTokens"),
        ("cacheRead", "cacheReadTokens"),
        ("cacheCreation", "cacheCreationTokens"),
        ("total", "totalTokens"),
    ] {
        m[key] = json!(m[key].as_u64().unwrap_or(0) + u[value].as_u64().unwrap_or(0));
    }
    m["reasoningComplete"] = json!(
        (m["reasoningComplete"].is_null() || m["reasoningComplete"] == true)
            && (u["reasoningTokens"].is_number() || u["outputTokens"] == 0)
    );
    let mut incomplete = m["incompleteFields"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for field in u["incompleteFields"].as_array().into_iter().flatten() {
        if !incomplete.contains(field) {
            incomplete.push(field.clone());
        }
    }
    for (field, key) in [
        ("input", "inputUncachedTokens"),
        ("cacheRead", "cacheReadTokens"),
        ("cacheWrite", "cacheCreationTokens"),
        ("output", "outputTokens"),
        ("total", "totalTokens"),
    ] {
        if u[key].as_u64().is_none() && !incomplete.iter().any(|v| v == field) {
            incomplete.push(json!(field));
        }
    }
    m["incompleteFields"] = json!(incomplete);
    let mut invalid = m["invalidFields"].as_array().cloned().unwrap_or_default();
    for field in u["invalidFields"].as_array().into_iter().flatten() {
        if !invalid.contains(field) {
            invalid.push(field.clone());
        }
    }
    m["invalidFields"] = json!(invalid);
    if u["inputTotalTokens"].as_u64().is_none()
        || u["inputIncludesCache"] != true
            && m["incompleteFields"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == "cacheRead" || v == "cacheWrite"))
    {
        m["inputTotalComplete"] = json!(false);
    } else if m["inputTotalComplete"].is_null() {
        m["inputTotalComplete"] = json!(true);
    }
    for (target, source) in [
        ("cacheCreation5m", "cacheCreation5mTokens"),
        ("cacheCreation1h", "cacheCreation1hTokens"),
        ("reasoning", "reasoningTokens"),
    ] {
        if u[source].as_u64().is_some() || m[target].as_u64().is_some() {
            m[target] = json!(m[target].as_u64().unwrap_or(0) + u[source].as_u64().unwrap_or(0));
        }
    }
}

fn display_record(prices: &[Value], mut row: Value) -> Value {
    // Enrich old records in memory; historical JSONL remains byte-identical.
    trace_compaction::annotate(&mut row);
    if row["startedAtMs"].as_u64().is_none() {
        if let Ok(at) = chrono::DateTime::parse_from_rfc3339(text(&row, "startedAt")) {
            row["startedAtMs"] = json!(at.timestamp_millis());
        }
    }
    if needs_ark_cost_repair(&row["costSnapshot"])
        || (row["costSnapshot"]["version"] == 1 && row["costSnapshot"]["costComplete"] == false)
    {
        let evidence = &row["usageEvidence"]["upstream"];
        if evidence["raw"].is_object() {
            let wire = text(evidence, "protocol").to_owned();
            row["usage"] = record_usage(&json!({"usage":evidence["raw"]}), &wire, &row);
        }
        row["costSnapshot"] = repaired_cost_point(prices, &row);
        row["costViewBasis"] = json!("frozen-rate-correction");
    } else if row["costSnapshot"]["version"] != 1 {
        let mut raw = row["usageEvidence"]["upstream"]["raw"].clone();
        if !raw.is_object() {
            raw = row["sse"]["events"]
                .as_array()
                .into_iter()
                .flatten()
                .rev()
                .find_map(|e| {
                    e["json"]["response"]
                        .get("usage")
                        .or_else(|| e["json"].get("usage"))
                        .filter(|v| v.is_object())
                        .cloned()
                })
                .unwrap_or(Value::Null);
        }
        if raw.is_object() {
            let wire = row["usageEvidence"]["upstream"]["protocol"]
                .as_str()
                .or_else(|| row["protocol"].as_str())
                .unwrap_or("openai-responses")
                .to_owned();
            row["usage"] = record_usage(&json!({"usage":raw}), &wire, &row);
        }
        row["costViewBasis"] = json!("legacy-current-reference");
        row["costSnapshot"] = usage_cost_point(prices, &row);
    }
    row
}

// Small, read-only per-file indexes. Bodies are never retained by the page cache.
#[derive(Clone)]
struct TraceFileRow {
    summary: Value,
    offset: u64,
    length: usize,
}
struct CachedTraceFile {
    price_key: String,
    length: u64,
    modified: Option<std::time::SystemTime>,
    rows: Arc<Vec<TraceFileRow>>,
}
struct TracePageReader {
    price_key: String,
    root: PathBuf,
    prices: Vec<Value>,
    sessions: Vec<Value>,
    files: BTreeMap<PathBuf, (u64, Option<std::time::SystemTime>)>,
    cache: Arc<std::sync::Mutex<BTreeMap<PathBuf, CachedTraceFile>>>,
}
fn trace_row_summary(record: &Value) -> Value {
    let mut summary = json!({"summaryOnly":true});
    for key in [
        "id",
        "sessionId",
        "physicalSessionId",
        "turn",
        "logicalTurn",
        "mainOrdinal",
        "startedAt",
        "startedAtMs",
        "completedAt",
        "durationMs",
        "source",
        "client",
        "clientConversationKey",
        "provider",
        "providerTransition",
        "auxiliary",
        "subagent",
        "subagentInfo",
        "compact",
        "routedBy",
        "usage",
        "costSnapshot",
        "error",
    ] {
        if let Some(value) = record.get(key) {
            summary[key] = value.clone();
        }
    }
    for key in ["model", "apiType", "method", "path", "headers"] {
        if let Some(value) = record["request"].get(key) {
            summary["request"][key] = value.clone();
        }
    }
    for key in ["statusCode", "statusMessage", "protocolEnded", "bodyEnded"] {
        if let Some(value) = record["response"].get(key) {
            summary["response"][key] = value.clone();
        }
    }
    for key in ["baseUrl", "url"] {
        if let Some(value) = record["upstream"].get(key) {
            summary["upstream"][key] = value.clone();
        }
    }
    summary
}
impl TracePageReader {
    fn file_rows(&self, path: &Path) -> Result<Arc<Vec<TraceFileRow>>> {
        use std::io::{BufRead, BufReader, Read};
        let file = fs::File::open(path).map_err(err)?;
        let metadata = file.metadata().map_err(err)?;
        let (length, modified) = self
            .files
            .get(path)
            .copied()
            .unwrap_or((metadata.len(), metadata.modified().ok()));
        if metadata.len() < length {
            return Err("会话日志已变化，请重新加载".into());
        }
        if let Some(cached) = self.cache.lock().map_err(err)?.get(path) {
            if cached.length == length
                && cached.modified == modified
                && cached.price_key == self.price_key
            {
                return Ok(cached.rows.clone());
            }
        }
        let mut reader = BufReader::new(file.take(length));
        let mut line = String::new();
        let mut offset = 0;
        let mut rows = Vec::new();
        loop {
            line.clear();
            let length = reader.read_line(&mut line).map_err(err)?;
            if length == 0 {
                break;
            }
            if !line.trim().is_empty() {
                let mut record: Value = serde_json::from_str(&line).map_err(err)?;
                let annotation = trace_classification::annotations(&record);
                if let Some(kind) = annotation.get("auxiliary") {
                    record["auxiliary"] = kind.clone();
                }
                let record = display_record(&self.prices, record);
                rows.push(TraceFileRow {
                    summary: trace_row_summary(&record),
                    offset,
                    length,
                });
            }
            offset += length as u64;
        }
        let rows = Arc::new(rows);
        let mut cache = self.cache.lock().map_err(err)?;
        // Bound metadata retained while browsing many conversations.
        if cache.len() >= 8 {
            cache.clear();
        }
        cache.insert(
            path.to_path_buf(),
            CachedTraceFile {
                price_key: self.price_key.clone(),
                length,
                modified,
                rows: rows.clone(),
            },
        );
        Ok(rows)
    }
    fn page(
        &self,
        id: &str,
        offset: Option<usize>,
        before: Option<usize>,
        limit: usize,
        summary_only: bool,
        request_id: Option<&str>,
    ) -> Result<Option<Value>> {
        use std::io::{Read, Seek, SeekFrom};
        let Some(session) = self.sessions.iter().find(|s| s["id"] == id) else {
            return Ok(None);
        };
        let mut records = Vec::new();
        for member in self.sessions.iter().filter(|s| {
            s["id"] == id
                || (!text(session, "clientConversationKey").is_empty()
                    && s["clientConversationKey"] == session["clientConversationKey"]
                    && s["source"] == session["source"])
        }) {
            let file = PathBuf::from(member["jsonlPath"].as_str().ok_or("索引路径无效")?);
            if file.parent() != Some(self.root.as_path())
                || file.canonicalize().map_err(err)?.parent()
                    != Some(self.root.canonicalize().map_err(err)?.as_path())
            {
                return Err("索引路径越界，已拒绝读取".into());
            }
            let rows = self.file_rows(&file)?;
            for row in rows.iter() {
                records.push((row.clone(), file.clone()));
            }
        }
        records.sort_by(|(a, _), (b, _)| {
            text(&a.summary, "startedAt")
                .cmp(text(&b.summary, "startedAt"))
                .then_with(|| text(&a.summary, "id").cmp(text(&b.summary, "id")))
        });
        let mut main_ordinal = 0;
        for (at, (row, _)) in records.iter_mut().enumerate() {
            let record = &mut row.summary;
            record["physicalSessionId"] = record["sessionId"].clone();
            record["sessionId"] = json!(id);
            record["turn"] = json!(at + 1);
            if record["auxiliary"].is_null() && record["subagent"].is_null() {
                main_ordinal += 1;
                record["mainOrdinal"] = json!(main_ordinal);
            }
        }
        let offset = if let Some(request_id) = request_id {
            let Some(index) = records
                .iter()
                .position(|(r, _)| r.summary["id"] == request_id)
            else {
                return Ok(None);
            };
            Some(index)
        } else {
            offset
        };
        let total = records.len();
        let limit = if request_id.is_some() {
            1
        } else {
            limit.clamp(1, 200)
        };
        let tail = request_id.is_none() && (before.is_some() || offset.is_none());
        let upper = before.unwrap_or(total).min(total);
        let offset = if tail {
            upper.saturating_sub(limit)
        } else {
            offset.unwrap_or(0).min(total)
        };
        let end = if tail {
            upper
        } else {
            (offset + limit).min(total)
        };
        let indexes: Vec<_> = if tail {
            (offset..end).rev().collect()
        } else {
            (offset..end).collect()
        };
        let mut traces = Vec::new();
        let mut bytes = 0;
        for index in indexes {
            let (row, path) = &records[index];
            let mut record = if summary_only {
                row.summary.clone()
            } else {
                let mut file = fs::File::open(path).map_err(err)?;
                file.seek(SeekFrom::Start(row.offset)).map_err(err)?;
                let mut data = vec![0; row.length];
                file.read_exact(&mut data).map_err(err)?;
                let mut record =
                    display_record(&self.prices, serde_json::from_slice(&data).map_err(err)?);
                // Reuse classification and logical ordinals from the index.
                for key in [
                    "auxiliary",
                    "sessionId",
                    "physicalSessionId",
                    "turn",
                    "mainOrdinal",
                ] {
                    if let Some(value) = row.summary.get(key) {
                        record[key] = value.clone();
                    }
                }
                record
            };
            let size = if summary_only {
                record.to_string().len()
            } else {
                row.length
            };
            if !traces.is_empty() && bytes + size > 24 * 1024 * 1024 {
                break;
            }
            bytes += size;
            if !summary_only {
                record.as_object_mut().unwrap().remove("summaryOnly");
            }
            traces.push(record);
        }
        if tail {
            traces.reverse();
        }
        let offset = if tail { end - traces.len() } else { offset };
        let end = offset + traces.len();
        Ok(Some(
            json!({"id":id,"traces":traces,"offset":offset,"limit":limit,"total":total,"hasMoreBefore":offset>0,"hasMoreAfter":end<total}),
        ))
    }
}

pub(super) struct TraceStore {
    data_root: PathBuf,
    pub root: PathBuf,
    pub prices: Vec<Value>,
    pub active: bool,
    pub theme: String,
    pub language: String,
    pub events: tokio::sync::broadcast::Sender<String>,
    index: Value,
    index_source: Option<String>,
    legacy_annotations: BTreeMap<String, Value>,
    legacy_costs: BTreeMap<String, Value>,
    page_cache: Arc<std::sync::Mutex<BTreeMap<PathBuf, CachedTraceFile>>>,
    writer: Option<super::trace_writer::Lease>,
    pub limit: u64,
    pub auto_cleanup: bool,
    recording: BTreeMap<String, usize>,
    pub retention_notice: Option<String>,
    pub read_problem: Option<String>,
}
impl TraceStore {
    pub fn open(root: PathBuf, limit: u64, auto: bool, data_root: &Path) -> Result<Store> {
        let source = read(&root.join("index.json"))?;
        let index_source = source.clone();
        let (index, read_problem) = match source {
            Some(source) => match serde_json::from_str::<Value>(&source) {
                Ok(value) if value["sessions"].is_array() => (value, None),
                _ => (
                    empty_index(),
                    Some("Trace 索引损坏，原文件已保留；可在设置中手动修复索引".into()),
                ),
            },
            None => (empty_index(), None),
        };
        // Read legacy annotation evidence once. This is a view projection:
        // never rewrite JSONL or repair a missing/damaged index automatically.
        let mut legacy_annotations = BTreeMap::new();
        for session in index["sessions"].as_array().into_iter().flatten() {
            if session["captureClassificationVersion"] == 1 {
                continue;
            }
            let path = PathBuf::from(text(session, "jsonlPath"));
            if path.parent() != Some(root.as_path()) {
                continue;
            }
            if let Ok(file) = fs::File::open(&path) {
                use std::io::{BufRead, BufReader};
                let mut line = String::new();
                if BufReader::new(file).read_line(&mut line).is_ok() {
                    if let Ok(record) = serde_json::from_str::<Value>(&line) {
                        legacy_annotations.insert(
                            text(session, "id").into(),
                            trace_classification::annotations(&record),
                        );
                    }
                }
            }
        }
        let store = Arc::new(std::sync::Mutex::new(Self {
            data_root: data_root.to_path_buf(),
            prices: load_prices(data_root),
            root,
            active: false,
            theme: "day".into(),
            language: crate::language::system_language(),
            events: tokio::sync::broadcast::channel(16).0,
            index,
            index_source,
            legacy_annotations,
            legacy_costs: BTreeMap::new(),
            page_cache: Arc::new(std::sync::Mutex::new(BTreeMap::new())),
            writer: None,
            limit,
            auto_cleanup: auto,
            recording: BTreeMap::new(),
            retention_notice: None,
            read_problem,
        }));
        store.lock().map_err(err)?.refresh_legacy_costs();
        if limit == 0 {
            store.lock().map_err(err)?.apply_retention();
        }
        Ok(store)
    }
    pub(super) fn begin_writer(&mut self) -> Result<()> {
        let writer = super::trace_writer::Lease::acquire(&self.root)?;
        // Another writer may have completed while this window was read-only.
        // Adopt its complete index only after taking exclusive ownership.
        let source = read(&self.root.join("index.json"))?;
        let index = source
            .as_ref()
            .map(|s| {
                serde_json::from_str::<Value>(s)
                    .map_err(|_| "Trace 索引损坏，请先手动检查并修复".to_string())
            })
            .transpose()?
            .unwrap_or_else(empty_index);
        if !index["sessions"].is_array() {
            return Err("Trace 索引无效，未开始写入".into());
        }
        self.index = index;
        self.index_source = source;
        self.refresh_legacy_costs();
        self.read_problem = None;
        self.writer = Some(writer);
        Ok(())
    }
    pub(super) fn end_writer(&mut self) {
        self.writer = None;
    }
    fn validate_index(&self) -> Result<()> {
        if read(&self.root.join("index.json"))? != self.index_source {
            return Err("Trace 索引已被外部修改，未覆盖历史；请停止 Trace 后重新检查索引".into());
        }
        Ok(())
    }
    fn with_writer<T>(
        &mut self,
        check_index: bool,
        operation: impl FnOnce(&mut Self) -> Result<T>,
    ) -> Result<T> {
        let temporary = self.writer.is_none();
        if temporary {
            self.writer = Some(super::trace_writer::Lease::acquire(&self.root)?);
        }
        let result = (|| {
            self.writer.as_ref().unwrap().validate()?;
            if check_index {
                self.validate_index()?;
            }
            operation(self)
        })();
        if self.active {
            if let Err(ref error) = result {
                self.read_problem = Some(error.clone());
            }
        }
        if temporary {
            self.writer = None;
        }
        result
    }
    pub fn totals(&self) -> (usize, u64, u64) {
        let sessions = self.index["sessions"].as_array().unwrap();
        (
            sessions.len(),
            sessions
                .iter()
                .filter_map(|s| s["traceCount"].as_u64())
                .sum(),
            self.size(),
        )
    }
    fn size(&self) -> u64 {
        fs::read_dir(&self.root)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .filter(|e| {
                !["trace-writer.lock", ".native-trace-writer.lock", "tap.lock"]
                    .contains(&e.file_name().to_string_lossy().as_ref())
            })
            .filter_map(|e| e.metadata().ok())
            .map(|m| m.len())
            .sum()
    }
    fn display_record(&self, row: Value) -> Value {
        display_record(&self.prices, row)
    }
    /// Rebuild only display aggregates; raw logs, index bytes and frozen prices
    /// are untouched. Legacy rows use today's explicitly labelled reference.
    pub(super) fn refresh_legacy_costs(&mut self) {
        self.legacy_costs.clear();
        for session in self.index["sessions"].as_array().into_iter().flatten() {
            let frozen_correction = session["nativeUsage"].as_array().is_some_and(|points| {
                points.iter().any(|point| {
                    needs_ark_cost_repair(point)
                        || (point["costComplete"] == false && point["priceRule"].is_object())
                })
            });
            if session["costSnapshotVersion"] == 1
                && !frozen_correction
                && session["cacheHitUsage"].is_object()
                && session["usageByModel"].as_object().is_some_and(|models| {
                    models.values().all(|m| m["knownFieldCounts"].is_object())
                })
            {
                continue;
            }
            let path = PathBuf::from(text(session, "jsonlPath"));
            if path.parent() != Some(self.root.as_path()) {
                continue;
            }
            let Ok(rows) = records(&path) else {
                continue;
            };
            if rows.is_empty() {
                continue;
            }
            let mut by_model = json!({});
            let mut points = vec![];
            let mut cache_hit_usage = Value::Null;
            for row in rows {
                let row = self.display_record(row);
                accumulate_model_usage(&mut by_model, &row);
                accumulate_cache_hit_usage(&mut cache_hit_usage, &row["usage"]);
                points.push(row["costSnapshot"].clone());
            }
            if session["traceCount"]
                .as_u64()
                .is_some_and(|n| n != points.len() as u64)
            {
                for model in by_model
                    .as_object_mut()
                    .into_iter()
                    .flat_map(|m| m.values_mut())
                {
                    model["capturedCost"]["complete"] = json!(false);
                }
                for point in &mut points {
                    point["costComplete"] = json!(false);
                }
            }
            let accounted = cache_hit_usage["knownRequests"].as_u64().unwrap_or(0)
                + cache_hit_usage["excludedRequests"].as_u64().unwrap_or(0);
            if let Some(extra) = session["traceCount"]
                .as_u64()
                .and_then(|n| n.checked_sub(accounted))
            {
                cache_hit_usage["excludedRequests"] =
                    json!(cache_hit_usage["excludedRequests"].as_u64().unwrap_or(0) + extra);
            }
            if session["costSnapshotVersion"] == 1 && !frozen_correction {
                let mut annotated = session["usageByModel"].clone();
                for (model, usage) in annotated.as_object_mut().into_iter().flatten() {
                    if by_model[model]["knownFieldCounts"].is_object() {
                        usage["knownFieldCounts"] = by_model[model]["knownFieldCounts"].clone();
                    }
                }
                self.legacy_costs.insert(
                    text(session, "id").into(),
                    json!({"cacheHitUsage":cache_hit_usage,"usageByModel":annotated}),
                );
                continue;
            }
            let tokens: u64 = points.iter().filter_map(|p| p["tokens"].as_u64()).sum();
            self.legacy_costs.insert(text(session,"id").into(),json!({"cacheHitUsage":cache_hit_usage,"usageByModel":by_model,"nativeUsage":points,"totalTokens":tokens,"costViewBasis":if frozen_correction {"frozen-rate-correction"} else {"legacy-current-reference"}}));
        }
    }
    fn view_sessions(&self) -> Vec<Value> {
        let mut sessions = self.index["sessions"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for session in &mut sessions {
            if let Some(costs) = self.legacy_costs.get(text(session, "id")) {
                for (key, value) in costs.as_object().into_iter().flatten() {
                    session[key] = value.clone();
                }
            }
            if let Some(annotation) = self.legacy_annotations.get(text(session, "id")) {
                for (key, value) in annotation.as_object().into_iter().flatten() {
                    session[key] = value.clone();
                }
            }
        }
        trace_classification::associate_titles(&mut sessions);
        sessions
    }
    pub fn state(&self, active: bool) -> Value {
        json!({"theme":self.theme,"language":self.language,"active":active,"rootPath":self.root,"generatedAt":iso(millis()),"sessions":self.view_sessions(),"usageSummaries":self.retained_usage_summaries(),"traces":[],"storage":{"rootPath":self.root,"totalBytes":self.size(),"maxBytes":self.limit}})
    }
    pub fn stats(&self) -> Value {
        let now = millis();
        let today = Local::now().date_naive();
        let mut total = json!({"tokens":0,"costUsd":0.0,"costComplete":true,"knownCostRequests":0});
        let mut day = total.clone();
        let mut week = total.clone();
        let mut series = vec![];
        let sessions = self.view_sessions();
        for session in sessions
            .iter()
            .chain(self.index.get("usageOnly"))
            .chain(
                self.index["usageOnly"]["legacy"]
                    .as_array()
                    .into_iter()
                    .flatten(),
            )
            .chain(
                self.index["usageOnly"]["summaries"]
                    .as_array()
                    .into_iter()
                    .flatten(),
            )
        {
            if !session["nativeUsage"].is_array() {
                let tokens = session["totalTokens"].as_u64().unwrap_or(0);
                total["tokens"] = json!(total["tokens"].as_u64().unwrap_or(0) + tokens);
                if tokens > 0 {
                    total["costComplete"] = json!(false);
                }
                for (date, usage) in session["dailyUsage"].as_object().into_iter().flatten() {
                    if let Ok(date) = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") {
                        let tokens = usage["tokens"].as_u64().unwrap_or(0);
                        for period in
                            [&mut day, &mut week]
                                .iter_mut()
                                .enumerate()
                                .filter_map(|(i, p)| {
                                    if (i == 0 && date == today)
                                        || (i == 1
                                            && date <= today
                                            && today.signed_duration_since(date).num_days() < 7)
                                    {
                                        Some(p)
                                    } else {
                                        None
                                    }
                                })
                        {
                            period["tokens"] =
                                json!(period["tokens"].as_u64().unwrap_or(0) + tokens);
                            if tokens > 0 {
                                period["costComplete"] = json!(false);
                            }
                        }
                    }
                }
                series.extend(
                    session["recentRatePoints"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .cloned(),
                );
                continue;
            }
            for point in session["nativeUsage"].as_array().into_iter().flatten() {
                let at = point["atMs"].as_u64().unwrap_or(0) as u128;
                let tokens = point["tokens"].as_u64().unwrap_or(0);
                let cost = point["knownCostUsd"]
                    .as_f64()
                    .or_else(|| point["costUsd"].as_f64());
                let complete = point["costComplete"]
                    .as_bool()
                    .unwrap_or(point["costUsd"].as_f64().is_some());
                for period in [&mut total, &mut day, &mut week]
                    .iter_mut()
                    .enumerate()
                    .filter_map(|(i, p)| {
                        if i == 0
                            || (i == 1
                                && DateTime::<Utc>::from_timestamp_millis(at as i64)
                                    .is_some_and(|t| t.with_timezone(&Local).date_naive() == today))
                            || (i == 2 && at + 7 * 86_400_000 >= now)
                        {
                            Some(p)
                        } else {
                            None
                        }
                    })
                {
                    period["tokens"] = json!(period["tokens"].as_u64().unwrap_or(0) + tokens);
                    period["costUsd"] =
                        json!(period["costUsd"].as_f64().unwrap_or(0.0) + cost.unwrap_or(0.0));
                    if cost.is_some() {
                        period["knownCostRequests"] =
                            json!(period["knownCostRequests"].as_u64().unwrap_or(0) + 1);
                    }
                    if !complete {
                        period["costComplete"] = json!(false);
                    }
                }
                series.push(json!({"at":iso(at),"tokens":tokens}));
            }
        }
        series.sort_by(|a, b| a["at"].as_str().cmp(&b["at"].as_str()));
        if series.len() > 1000 {
            series.drain(..series.len() - 1000);
        }
        json!({"total":total,"today":day,"week":week,"series":series})
    }
    #[cfg(test)]
    pub fn page(
        &self,
        id: &str,
        offset: Option<usize>,
        before: Option<usize>,
        limit: usize,
    ) -> Result<Option<Value>> {
        self.page_projection(id, offset, before, limit, false, None)
    }
    fn page_reader(&self) -> TracePageReader {
        // Capture committed file boundaries while the writer is excluded. Later
        // appends cannot expose half a JSON line to this read-only snapshot.
        let sessions = self.view_sessions();
        let files = sessions
            .iter()
            .filter_map(|session| {
                let path = PathBuf::from(session["jsonlPath"].as_str()?);
                let metadata = fs::metadata(&path).ok()?;
                Some((path, (metadata.len(), metadata.modified().ok())))
            })
            .collect();
        TracePageReader {
            price_key: digest(
                serde_json::to_string(&self.prices)
                    .unwrap_or_default()
                    .as_bytes(),
            ),
            root: self.root.clone(),
            prices: self.prices.clone(),
            sessions,
            files,
            cache: self.page_cache.clone(),
        }
    }
    #[cfg(test)]
    fn page_projection(
        &self,
        id: &str,
        offset: Option<usize>,
        before: Option<usize>,
        limit: usize,
        summary_only: bool,
        request_id: Option<&str>,
    ) -> Result<Option<Value>> {
        self.page_reader()
            .page(id, offset, before, limit, summary_only, request_id)
    }
    fn session_file(&self, id: &str) -> Result<PathBuf> {
        let sessions = self.view_sessions();
        let session = sessions
            .iter()
            .find(|s| s["id"] == id)
            .ok_or("session not found")?;
        let file = PathBuf::from(session["jsonlPath"].as_str().ok_or("索引路径无效")?);
        if !file.is_file() || file.parent() != Some(self.root.as_path()) {
            return Err("会话日志文件已不存在".into());
        }
        let canonical = file.canonicalize().map_err(err)?;
        if canonical.parent() != Some(self.root.canonicalize().map_err(err)?.as_path()) {
            return Err("索引路径越界".into());
        }
        Ok(canonical)
    }
    pub fn delete(&mut self, id: &str, clear_usage: bool) -> Result<bool> {
        self.with_writer(true, |store| store.delete_owned(id, clear_usage))
    }
    fn delete_owned(&mut self, id: &str, clear_usage: bool) -> Result<bool> {
        let view = self.view_sessions();
        let Some(target) = view.iter().find(|s| s["id"] == id) else {
            return Ok(false);
        };
        let targets: Vec<_> = view
            .iter()
            .filter(|s| {
                s["id"] == id
                    || (!text(target, "clientConversationKey").is_empty()
                        && s["clientConversationKey"] == target["clientConversationKey"]
                        && s["source"] == target["source"])
            })
            .collect();
        let mut paths = Vec::new();
        for target in &targets {
            let file = PathBuf::from(target["jsonlPath"].as_str().ok_or("索引路径无效")?);
            if file.parent() != Some(self.root.as_path()) {
                return Err("索引路径越界".into());
            }
            read(&file)?;
            paths.push(file);
        }
        for file in paths {
            if file.exists() {
                fs::remove_file(file).map_err(err)?;
            }
        }
        let before = self.index.clone();
        if !clear_usage {
            for target in &targets {
                self.retain_session_usage(target);
            }
        }
        let ids: Vec<_> = targets.iter().map(|s| s["id"].clone()).collect();
        self.index["sessions"]
            .as_array_mut()
            .unwrap()
            .retain(|s| !ids.contains(&s["id"]));
        if let Err(error) = self.persist() {
            self.index = before;
            return Err(error);
        }
        Ok(true)
    }
    pub fn inspect_repair(&self) -> Result<Value> {
        let index_path = self.root.join("index.json");
        let index_source = read(&index_path)?;
        let index_sha = index_source
            .as_ref()
            .map(|s| digest(s.as_bytes()))
            .unwrap_or_default();
        let disk_index = index_source
            .as_ref()
            .and_then(|source| serde_json::from_str::<Value>(source).ok())
            .filter(|value| value["sessions"].is_array());
        let index_status = if index_source.is_none() {
            "missing"
        } else if disk_index.is_none() {
            "invalid"
        } else {
            "valid"
        };
        let indexed: Vec<_> = disk_index
            .as_ref()
            .and_then(|v| v["sessions"].as_array())
            .into_iter()
            .flatten()
            .collect();
        let mut candidates = vec![];
        let mut total = 0;
        for entry in fs::read_dir(&self.root)
            .map_err(err)?
            .flatten()
            .filter(|e| {
                e.file_type().is_ok_and(|t| t.is_file())
                    && e.path().extension().is_some_and(|e| e == "jsonl")
            })
        {
            total += 1;
            let source = read(&entry.path())?.unwrap_or_default();
            let mut valid = 0;
            let mut malformed = 0;
            let mut id = String::new();
            for line in source.lines().filter(|l| !l.is_empty()) {
                match serde_json::from_str::<Value>(line) {
                    Ok(v)
                        if v["id"].is_string()
                            && v["request"].is_object()
                            && v["response"].is_object() =>
                    {
                        valid += 1;
                        if id.is_empty() {
                            id = text(&v, "sessionId").into();
                        }
                    }
                    _ => malformed += 1,
                }
            }
            if valid > 0 {
                if id.is_empty() {
                    id = format!(
                        "session-{}",
                        &digest(entry.file_name().to_string_lossy().as_bytes())[..24]
                    );
                }
                candidates.push(json!({"id":id,"jsonlPath":entry.path(),"validRecords":valid,"malformedRecords":malformed}));
            }
        }
        let missing: Vec<_> = indexed
            .iter()
            .filter_map(|s| s["jsonlPath"].as_str())
            .filter(|p| !Path::new(p).is_file())
            .collect();
        let unindexed: Vec<_> = candidates
            .iter()
            .filter(|candidate| {
                !indexed
                    .iter()
                    .any(|s| s["jsonlPath"] == candidate["jsonlPath"])
            })
            .map(|c| c["jsonlPath"].clone())
            .collect();
        let stale: Vec<_> = candidates
            .iter()
            .filter(|candidate| {
                indexed.iter().any(|s| {
                    s["jsonlPath"] == candidate["jsonlPath"]
                        && s["traceCount"] != candidate["validRecords"]
                })
            })
            .map(|c| c["jsonlPath"].clone())
            .collect();
        let usage_refresh: Vec<_> = indexed
            .iter()
            .filter(|s| {
                s["usageNormalizationVersion"] != 2
                    || s["costSnapshotVersion"] != 1
                    || s["nativeUsage"]
                        .as_array()
                        .is_some_and(|points| points.iter().any(needs_ark_cost_repair))
                    || s["nativeUsage"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|p| p.get("costComplete").is_none()))
            })
            .map(|s| s["jsonlPath"].clone())
            .collect();
        let needs_repair = !usage_refresh.is_empty()
            || index_status == "invalid"
            || !unindexed.is_empty()
            || !missing.is_empty()
            || !stale.is_empty();
        Ok(
            json!({"rootPath":self.root,"indexPath":index_path,"indexStatus":index_status,"indexSha256":index_sha,"indexedSessions":indexed.len(),"jsonlFiles":total,"missingIndexedFiles":missing,"unindexedFiles":unindexed,"staleIndexedFiles":stale,"usageRefreshFiles":usage_refresh,"needsRepair":needs_repair,"candidates":candidates}),
        )
    }

    pub fn apply_repair(&mut self, expected: Option<&str>) -> Result<Value> {
        self.with_writer(false, |store| store.apply_repair_owned(expected))
    }
    fn apply_repair_owned(&mut self, expected: Option<&str>) -> Result<Value> {
        let plan = self.inspect_repair()?;
        if expected.is_some_and(|e| plan["indexSha256"] != e) {
            return Err("索引已被外部修改，请重新检查".into());
        }
        let index = self.root.join("index.json");
        let prior_source = read(&index)?;
        let prior = prior_source
            .as_ref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .filter(|v| v["sessions"].is_array())
            .unwrap_or_else(empty_index);
        let mut sessions = vec![];
        for candidate in plan["candidates"].as_array().unwrap() {
            let path = PathBuf::from(candidate["jsonlPath"].as_str().ok_or("无效修复路径")?);
            if path.parent() != Some(self.root.as_path()) {
                return Err("修复路径越界".into());
            }
            let source = read(&path)?.unwrap_or_default();
            let rows: Vec<Value> = source
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter(|v| {
                    v["id"].is_string() && v["request"].is_object() && v["response"].is_object()
                })
                .map(|mut row| {
                    let evidence = &row["usageEvidence"]["upstream"];
                    let wire = text(evidence, "protocol");
                    if evidence["raw"].is_object()
                        && [
                            "responses",
                            "openai-responses",
                            "chat-completions",
                            "openai-chat-completions",
                            "messages",
                            "anthropic-messages",
                        ]
                        .contains(&wire)
                    {
                        row["usage"] = record_usage(&json!({"usage":evidence["raw"]}), wire, &row);
                    }
                    row["costSnapshot"] = repaired_cost_point(&self.prices, &row);
                    row
                })
                .collect();
            if rows.is_empty() {
                continue;
            }
            let mut usage_by_model = json!({});
            for row in &rows {
                accumulate_model_usage(&mut usage_by_model, row);
            }
            let mut cache_hit_usage = Value::Null;
            for row in &rows {
                accumulate_cache_hit_usage(&mut cache_hit_usage, &row["usage"]);
            }
            let first = &rows[0];
            let last = rows.last().unwrap();
            let native_usage: Vec<_> = rows.iter().map(|r| r["costSnapshot"].clone()).collect();
            let mut summary = prior["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["jsonlPath"] == candidate["jsonlPath"])
                .filter(|s| s.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
            let recovered = json!({"cacheHitUsage":cache_hit_usage,"id":candidate["id"],"startedAt":first["startedAt"],"updatedAt":last["completedAt"],"source":first["source"],"clientConversationKey":first["clientConversationKey"],"firstPrompt":first["request"]["body"]["input"].as_str().unwrap_or(""),"firstModel":first["request"]["model"],"jsonlPath":path,"traceCount":rows.len(),"totalTokens":rows.iter().filter_map(|r|r["usage"]["totalTokens"].as_u64()).sum::<u64>(),"totalDurationMs":rows.iter().filter_map(|r|r["durationMs"].as_u64()).sum::<u64>(),"usageByModel":usage_by_model,"usageNormalizationVersion":2,"nativeUsage":native_usage});
            for (key, value) in recovered.as_object().unwrap() {
                if key == "firstPrompt" && summary.get(key).is_some() {
                    continue;
                }
                summary[key] = value.clone();
            }
            summary["costSnapshotVersion"] = json!(1);
            sessions.push(summary);
        }
        let current = read(&index)?.unwrap_or_default();
        if digest(current.as_bytes()) != plan["indexSha256"].as_str().unwrap_or("")
            && !(current.is_empty() && plan["indexSha256"] == "")
        {
            return Err("索引已被外部修改，请重新检查".into());
        }
        let backup = if let Some(source) = read(&index)? {
            let path = self.root.join(format!("index-backup-{}.json", millis()));
            write(&path, &source)?;
            Some(path)
        } else {
            None
        };
        let recovered = sessions.len();
        let mut repaired = prior;
        repaired["version"] = json!(1);
        repaired["sessions"] = json!(sessions);
        self.writer
            .as_ref()
            .ok_or("缺少 Trace 修复租约")?
            .validate()?;
        if read(&index)? != prior_source {
            return Err("Trace 索引在修复前发生外部变化，原历史和备份已保留".into());
        }
        let next = serde_json::to_string_pretty(&repaired).map_err(err)?;
        write_checked(&index, prior_source.as_deref().unwrap_or_default(), &next)?;
        self.index_source = Some(next);
        self.index = repaired;
        self.refresh_legacy_costs();
        self.read_problem = None;
        let mut result = plan;
        result["applied"] = json!(true);
        result["backupIndexPath"] = json!(backup);
        result["recoveredSessions"] = json!(recovered);
        Ok(result)
    }
    pub fn clear(&mut self) -> Result<()> {
        self.with_writer(true, |store| store.clear_owned())
    }
    fn clear_owned(&mut self) -> Result<()> {
        let ids: Vec<_> = self.index["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s["id"].as_str().map(str::to_string))
            .collect();
        for id in ids {
            self.delete_owned(&id, true)?;
        }
        self.index.as_object_mut().unwrap().remove("usageOnly");
        self.persist()?;
        Ok(())
    }
    pub fn reset_usage(&mut self) -> Result<()> {
        self.with_writer(true, |store| {
            store.index.as_object_mut().unwrap().remove("usageOnly");
            store.index["usageResetAt"] = json!(millis());
            for session in store.index["sessions"].as_array_mut().unwrap() {
                session["nativeUsage"] = json!([]);
                session["usageByModel"] = json!({});
                session["dailyUsage"] = json!({});
                session["totalTokens"] = json!(0);
            }
            store.persist()
        })
    }
    fn usage_only(&mut self) -> &mut Value {
        let usage = &mut self.index["usageOnly"];
        if !usage["nativeUsage"].is_array() {
            let legacy = usage_summary(usage);
            *usage = json!({"nativeUsage":[],"legacy":[]});
            if legacy["totalTokens"].as_u64().unwrap_or(0) > 0 {
                usage["legacy"].as_array_mut().unwrap().push(legacy);
            }
        }
        usage
    }
    // Accounting survives detail deletion. Keep counters and frozen prices,
    // never conversation IDs, titles, paths, prompts or response bodies.
    fn retain_session_usage(&mut self, session: &Value) {
        let mut summary = json!({});
        for key in [
            "source",
            "totalTokens",
            "usageByModel",
            "cacheHitUsage",
            "nativeUsage",
            "dailyUsage",
            "recentRatePoints",
            "costViewBasis",
        ] {
            if let Some(value) = session.get(key) {
                summary[key] = value.clone();
            }
        }
        let usage = self.usage_only();
        if !usage["summaries"].is_array() {
            usage["summaries"] = json!([]);
        }
        usage["summaries"].as_array_mut().unwrap().push(summary);
    }
    fn retained_usage_summaries(&self) -> Vec<Value> {
        let usage = &self.index["usageOnly"];
        let mut summaries: Vec<_> = usage["summaries"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|summary| summary.is_object())
            .cloned()
            .collect();
        // Older usage-only ledgers have frozen totals but no source or input /
        // output breakdown. Preserve known totals without inventing details.
        let mut legacy = json!({"source":"unknown", "totalTokens":0, "usageByModel":{}});
        for point in usage["nativeUsage"].as_array().into_iter().flatten() {
            legacy["totalTokens"] = json!(
                legacy["totalTokens"].as_u64().unwrap_or(0) + point["tokens"].as_u64().unwrap_or(0)
            );
            let mut frozen = point.clone();
            if frozen["knownCostUsd"].is_null() {
                frozen["knownCostUsd"] = point["costUsd"].clone();
            }
            accumulate_model_usage(
                &mut legacy["usageByModel"],
                &json!({
                    "request":{"model":point["modelId"]}, "usage":{"totalTokens":point["tokens"]}, "costSnapshot":frozen
                }),
            );
        }
        if !usage["nativeUsage"].is_array() {
            legacy["totalTokens"] = usage["totalTokens"].clone();
        }
        for item in usage["legacy"].as_array().into_iter().flatten() {
            legacy["totalTokens"] = json!(
                legacy["totalTokens"].as_u64().unwrap_or(0)
                    + item["totalTokens"].as_u64().unwrap_or(0)
            );
        }
        if legacy["totalTokens"].as_u64().unwrap_or(0) > 0
            || usage["nativeUsage"]
                .as_array()
                .is_some_and(|p| !p.is_empty())
        {
            summaries.push(legacy);
        }
        for summary in &mut summaries {
            summary.as_object_mut().unwrap().remove("nativeUsage");
            summary.as_object_mut().unwrap().remove("dailyUsage");
            summary.as_object_mut().unwrap().remove("recentRatePoints");
        }
        summaries
    }
    pub fn set_retention(&mut self, limit: u64, auto_cleanup: bool) {
        self.limit = limit;
        self.auto_cleanup = auto_cleanup;
        self.apply_retention();
    }
    fn apply_retention(&mut self) {
        if self.limit != 0 {
            self.retention_notice = if self.auto_cleanup {
                self.with_writer(true, |store| store.cleanup_to_limit())
                    .err()
                    .map(|error| format!("详细记录清理未完成：{error}；请重新应用存储设置"))
            } else {
                None
            };
            return;
        }
        let result = self.with_writer(true, |store| store.purge_completed_details());
        self.retention_notice = match result {
            Err(error) => Some(format!(
                "设置已保存，详细记录清理未完成：{error}；请重新应用存储设置"
            )),
            Ok(()) if !self.recording.is_empty() => {
                Some("已清理结束的记录，正在生成的记录将在结束后清理".into())
            }
            Ok(()) => None,
        };
    }
    fn purge_completed_details(&mut self) -> Result<()> {
        if let Some(ref problem) = self.read_problem {
            return Err(problem.clone());
        }
        let completed: Vec<_> = self
            .view_sessions()
            .into_iter()
            .filter(|s| !self.recording.contains_key(text(s, "id")))
            .collect();
        for session in completed {
            let path = PathBuf::from(session["jsonlPath"].as_str().ok_or("索引路径无效")?);
            if path.parent() != Some(self.root.as_path()) {
                return Err("索引路径越界".into());
            }
            read(&path)?;
            let before = self.index.clone();
            self.retain_session_usage(&session);
            self.index["sessions"]
                .as_array_mut()
                .unwrap()
                .retain(|s| s["id"] != session["id"]);
            // Commit accounting before unlinking details. A retry removes the
            // leftover native file without counting that session a second time.
            if let Err(error) = self.persist() {
                self.index = before;
                return Err(error);
            }
            if path.exists() {
                fs::remove_file(path).map_err(err)?;
            }
        }
        for entry in fs::read_dir(&self.root).map_err(err)?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".jsonl") else {
                continue;
            };
            if id
                .strip_prefix("session-")
                .is_some_and(|hash| hash.len() == 24 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
                && !self.recording.contains_key(id)
            {
                read(&entry.path())?;
                fs::remove_file(entry.path()).map_err(err)?;
            }
        }
        Ok(())
    }
    fn persist(&mut self) -> Result<()> {
        self.writer
            .as_ref()
            .ok_or("缺少 Trace 写入租约")?
            .validate()?;
        self.validate_index()?;
        let source = serde_json::to_string_pretty(&self.index).map_err(err)?;
        write_checked(
            &self.root.join("index.json"),
            self.index_source.as_deref().unwrap_or_default(),
            &source,
        )?;
        self.index_source = Some(source);
        let _ = self.events.send("event: reset\ndata: {}\n\n".into());
        Ok(())
    }
    pub fn append(&mut self, record: Value, key: &str) -> Result<()> {
        self.with_writer(true, |store| store.append_owned(record, key))
    }
    fn append_owned(&mut self, mut record: Value, key: &str) -> Result<()> {
        if let Some(ref problem) = self.read_problem {
            return Err(problem.clone());
        }
        trace_compaction::annotate(&mut record);
        let annotation = trace_classification::annotations(&record);
        if let Some(kind) = annotation.get("auxiliary") {
            record["auxiliary"] = kind.clone();
        }
        let reset_at = self.index["usageResetAt"].as_u64().unwrap_or(0);
        let record_at = record["startedAtMs"]
            .as_u64()
            .or_else(|| {
                chrono::DateTime::parse_from_rfc3339(text(&record, "startedAt"))
                    .ok()
                    .map(|t| t.timestamp_millis() as u64)
            })
            .unwrap_or(0);
        if self.limit == 0 {
            if reset_at > 0 && record_at <= reset_at {
                return Ok(());
            }
            let point = usage_cost_point(&self.prices, &record);
            let mut summary = json!({"source":record["source"],"totalTokens":record["usage"]["totalTokens"],"nativeUsage":[point],"usageByModel":{}});
            record["costSnapshot"] = summary["nativeUsage"][0].clone();
            accumulate_model_usage(&mut summary["usageByModel"], &record);
            accumulate_cache_hit_usage(&mut summary["cacheHitUsage"], &record["usage"]);
            self.retain_session_usage(&summary);
            self.persist()?;
            return Ok(());
        }
        let id = format!("session-{}", &digest(key.as_bytes())[..24]);
        let file = self.root.join(format!("{id}.jsonl"));
        let sessions = self.index["sessions"].as_array_mut().unwrap();
        let at=sessions.iter().position(|s|s["id"]==id).unwrap_or_else(||{sessions.push(json!({"id":id,"startedAt":record["startedAt"],"updatedAt":record["completedAt"],"source":record["source"],"clientConversationKey":key,"firstPrompt":record["request"]["body"]["input"].as_str().or_else(||record["clientFirstPrompt"].as_str()).unwrap_or(""),"firstModel":record["request"]["model"],"jsonlPath":file,"traceCount":0,"totalTokens":0,"totalDurationMs":0,"usageByModel":{},"usageNormalizationVersion":2,"nativeUsage":[]}));sessions.len()-1});
        let summary = &mut sessions[at];
        if !summary["cacheHitUsage"].is_object() {
            let recovered = self
                .legacy_costs
                .get(&id)
                .map(|view| &view["cacheHitUsage"]);
            summary["cacheHitUsage"] = recovered
                .filter(|stats| stats.is_object())
                .cloned()
                .unwrap_or_else(|| {
                    json!({"inputTokens":0,"cacheReadTokens":0,"knownRequests":0,
                    "excludedRequests":summary["traceCount"].as_u64().unwrap_or(0)})
                });
        }
        if let Some(view) = self.legacy_costs.get(&id) {
            for (model, usage) in summary["usageByModel"]
                .as_object_mut()
                .into_iter()
                .flatten()
            {
                if !usage["knownFieldCounts"].is_object()
                    && view["usageByModel"][model]["knownFieldCounts"].is_object()
                {
                    usage["knownFieldCounts"] =
                        view["usageByModel"][model]["knownFieldCounts"].clone();
                }
            }
        }

        if let Some(legacy) = self.legacy_annotations.remove(&id) {
            for (key, value) in legacy.as_object().into_iter().flatten() {
                summary[key] = value.clone();
            }
        }
        let auxiliary = annotation["auxiliary"].is_string();
        summary["captureClassificationVersion"] = json!(1);
        if !auxiliary {
            summary["hidden"] = json!(false);
            if summary["hasMainTurn"] != true || text(summary, "firstPrompt").is_empty() {
                summary["firstPrompt"] = annotation["firstPrompt"].clone();
            }
            summary["hasMainTurn"] = json!(true);
        } else {
            if summary["hasMainTurn"] != true {
                summary["hidden"] = json!(true);
                summary["firstPrompt"] = json!("");
            }
            for field in ["title", "titlePromptHash"] {
                if let Some(value) = annotation.get(field) {
                    summary[field] = value.clone();
                }
            }
            let kind = annotation["auxiliary"].as_str().unwrap();
            if !summary["auxiliaryCounts"].is_object() {
                summary["auxiliaryCounts"] = json!({});
            }
            summary["auxiliaryCounts"][kind] =
                json!(summary["auxiliaryCounts"][kind].as_u64().unwrap_or(0) + 1);
        }
        if summary["errorCount"].as_u64().is_none() {
            summary["errorCount"] =
                json!(records(&file)?.iter().filter(|r| trace_error(r)).count());
        }
        let is_error = trace_error(&record);
        summary["errorCount"] =
            json!(summary["errorCount"].as_u64().unwrap_or(0) + u64::from(is_error));
        if record["auxiliary"].is_null() && record["subagent"].is_null() {
            summary["lastTurnError"] = json!(is_error);
        }
        let turn = summary["traceCount"].as_u64().unwrap_or(0) + 1;
        record["sessionId"] = json!(id);
        record["turn"] = json!(turn);
        summary["traceCount"] = json!(turn);
        summary["updatedAt"] = record["completedAt"].clone();
        let tokens = record["usage"]["totalTokens"].as_u64().unwrap_or(0);
        summary["totalTokens"] = json!(summary["totalTokens"].as_u64().unwrap_or(0) + tokens);
        summary["totalDurationMs"] = json!(
            summary["totalDurationMs"].as_u64().unwrap_or(0)
                + record["durationMs"].as_u64().unwrap_or(0)
        );
        record["costSnapshot"] = usage_cost_point(&self.prices, &record);
        // A legacy aggregate cannot claim complete monetary coverage until its
        // original requests have been rebuilt by the backed-up index repair.
        if summary["costSnapshotVersion"] != 1 && turn > 1 {
            for model in summary["usageByModel"]
                .as_object_mut()
                .into_iter()
                .flat_map(|m| m.values_mut())
            {
                if model.get("capturedCost").is_none() {
                    model["capturedCost"] = json!({"cost":null,"complete":false});
                }
            }
        } else {
            summary["costSnapshotVersion"] = json!(1);
        }
        accumulate_model_usage(&mut summary["usageByModel"], &record);
        accumulate_cache_hit_usage(&mut summary["cacheHitUsage"], &record["usage"]);
        summary["nativeUsage"]
            .as_array_mut()
            .unwrap()
            .push(record["costSnapshot"].clone());
        read(&file)?;
        let mut output = fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&file)
            .map_err(err)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            output
                .set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(err)?;
        }
        use std::io::Write;
        writeln!(&mut output, "{record}").map_err(err)?;
        output.sync_all().map_err(err)?;
        if self.legacy_costs.contains_key(&id) {
            self.refresh_legacy_costs();
        }
        self.persist()?;
        self.cleanup_to_limit()?;
        if self.index["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["id"] == id)
        {
            let _ = self
                .events
                .send(format!("event: trace\ndata: {record}\n\n"));
        }
        Ok(())
    }
    fn cleanup_to_limit(&mut self) -> Result<()> {
        if self.auto_cleanup && self.limit > 0 {
            while self.size() > self.limit && !self.index["sessions"].as_array().unwrap().is_empty()
            {
                let oldest = self.index["sessions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|candidate| {
                        !self.index["sessions"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|session| {
                                self.recording.contains_key(text(session, "id"))
                                    && (session["id"] == candidate["id"]
                                        || (!text(candidate, "clientConversationKey").is_empty()
                                            && session["clientConversationKey"]
                                                == candidate["clientConversationKey"]
                                            && session["source"] == candidate["source"]))
                            })
                    })
                    .min_by_key(|s| s["updatedAt"].as_str().unwrap_or(""));
                let Some(oldest) = oldest.and_then(|s| s["id"].as_str()).map(str::to_string) else {
                    break;
                };
                self.delete_owned(&oldest, false)?;
            }
        }
        Ok(())
    }
}

// Capture upstream accounting independently from the outermost HTTP body. The
// latter may still be converted by ingress after a Capture has finished/dropped.
// Either side can drop first (including an entirely unpolled client body).
#[derive(Clone, Default)]
pub(super) struct ClientEvidence(Arc<std::sync::Mutex<ClientEvidenceState>>);
#[derive(Default)]
struct ClientEvidenceState {
    raw: Vec<u8>,
    overflow: bool,
    status: u16,
    headers: Value,
    finished: bool,
    ended: bool,
    sse: bool,
    protocol_ended: bool,
    terminal_seen: bool,
    captures: usize,
    pending: Vec<(Store, String, Value)>,
    tools: Option<super::tool_wait::Observer>,
}
impl ClientEvidence {
    pub fn tools(&self, observer: super::tool_wait::Observer) {
        self.0.lock().unwrap().tools = Some(observer);
    }
    pub fn capture(&self) -> Self {
        self.0.lock().unwrap().captures += 1;
        self.clone()
    }
    pub fn response(&self, response: Response) -> Response {
        use futures_util::StreamExt;
        {
            let state = self.0.lock().unwrap();
            if state.captures == 0 && state.pending.is_empty() {
                return response;
            }
        }
        let (parts, body) = response.into_parts();
        {
            let mut state = self.0.lock().unwrap();
            state.status = parts.status.as_u16();
            let sse = parts
                .headers
                .get("content-type")
                .and_then(|h| h.to_str().ok())
                .is_some_and(|h| h.contains("text/event-stream"));
            state.sse = sse;
            if let Some(tools) = state.tools.as_mut() {
                tools.transport(sse);
            }
            state.headers = json!(parts
                .headers
                .iter()
                .filter(|(name, _)| ![
                    "authorization",
                    "proxy-authorization",
                    "x-api-key",
                    "x-goog-api-key",
                    "cookie",
                    "set-cookie"
                ]
                .contains(&name.as_str()))
                .map(|(name, value)| (name.to_string(), json!(value.to_str().unwrap_or(""))))
                .collect::<serde_json::Map<_, _>>());
        }
        let guard = ClientBodyGuard(self.clone());
        let expected = parts
            .headers
            .get("content-length")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.parse::<usize>().ok());
        let stream = async_stream::stream! {
            // Constructed outside the generator so Drop also runs before polling.
            let guard = guard;
            let mut body = body.into_data_stream();
            while let Some(chunk) = body.next().await {
                if let Ok(bytes) = &chunk {
                    let mut state = guard.0.0.lock().unwrap();
                    let remaining = (32 * 1024 * 1024usize).saturating_sub(state.raw.len());
                    state.raw.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
                    state.overflow |= bytes.len() > remaining;
                    let detected_sse = !state.sse && protocol::is_sse_body(&state.raw);
                    state.sse |= detected_sse;
                    if state.sse && !state.protocol_ended && !state.overflow {
                        let tail=&state.raw[state.raw.len().saturating_sub(bytes.len()+64)..];
                        state.terminal_seen |= tail.windows(b"response.completed".len()).any(|w|w==b"response.completed") || tail.windows(b"response.incomplete".len()).any(|w|w==b"response.incomplete");
                        if state.terminal_seen {
                            state.protocol_ended=protocol::collapse_sse(&String::from_utf8_lossy(&state.raw),"responses","").is_ok();
                        }
                    }
                    if !state.sse && !state.protocol_ended && !state.overflow
                        && bytes.iter().rev().find(|b| !b.is_ascii_whitespace()) == Some(&b'}') {
                        state.protocol_ended = serde_json::from_slice::<Value>(&state.raw).is_ok_and(|value|
                            (value["status"] == "completed" && protocol::validate_response(&value,"responses").is_ok())
                            || value["object"] == "response.compaction");
                    }
                    if let Some(mut tools) = state.tools.take() {
                        if (200..300).contains(&state.status) {
                            if detected_sse { tools.transport(true); }
                            tools.chunk(if detected_sse { &state.raw } else { bytes },&state.raw,state.overflow);
                            if expected == Some(state.raw.len()) || state.protocol_ended { tools.finish(&state.raw,state.overflow); }
                        }
                        state.tools = Some(tools);
                    }
                }
                let failed = chunk.is_err();
                yield chunk;
                if failed { return; }
            }
            let mut state = guard.0.0.lock().unwrap();
            if let Some(mut tools) = state.tools.take() {
                if (200..300).contains(&state.status) { tools.finish(&state.raw,state.overflow); }
                state.tools = Some(tools);
            }
            state.ended = true;
        };
        Response::from_parts(parts, Body::from_stream(stream))
    }
    fn publish(&self, store: Store, key: String, record: Value) {
        {
            let mut state = self.0.lock().unwrap();
            state.pending.push((store, key, record));
            state.captures -= 1;
        }
        self.flush();
    }
    fn flush(&self) {
        let records = {
            let mut state = self.0.lock().unwrap();
            if !state.finished || state.captures != 0 {
                return;
            }
            let last = state.pending.len().saturating_sub(1);
            let pending = std::mem::take(&mut state.pending);
            pending.into_iter().enumerate().map(|(index, (store, key, mut record))| {
                let delivered = index == last;
                // Definite account refusals consumed internally remain separate
                // upstream attempts, never copies of the final client's stream.
                if !delivered {
                    record["attemptResponse"] = record["response"].take();
                    record["response"] = json!({"forwardedToClient":false,"rawBody":"","statusCode":null,"headers":{}});
                } else {
                    record["response"]["statusCode"] = json!(state.status);
                    record["response"]["headers"] = state.headers.clone();
                    record["response"]["rawBody"] = json!(String::from_utf8_lossy(&state.raw));
                    record["response"]["forwardedToClient"] = json!(true);
                    record["response"]["bodyFormat"] = json!("wire");
                    record["response"]["captureBoundary"] = json!("gateway-http-body");
                    record["response"]["bodyEnded"] = json!(state.ended);
                    record["response"]["protocolEnded"] = json!(state.protocol_ended);
                    if let Ok(body) = serde_json::from_slice::<Value>(&state.raw) {
                        record["response"]["body"] = body;
                    } else if record.get("error").is_some() {
                        record["response"].as_object_mut().unwrap().remove("body");
                    }
                    if state.overflow {
                        record["response"]["bodyTruncated"] = json!(true);
                        record["error"] = json!("客户端响应记录超过 32 MB，已截断；网络转发保持完整");
                    } else if !state.ended && !state.protocol_ended && record.get("error").is_none() {
                        record["error"] = json!("客户端响应未读取到结束；已保留 Gateway 输出的前缀");
                    }
                }
                (store, key, record)
            }).collect::<Vec<_>>()
        };
        // Never hold the evidence mutex while taking the shared writer mutex.
        for (store, key, record) in records {
            let mut store = store.lock().unwrap();
            if let Err(error) = store.append(record, &key) {
                store.read_problem = Some(format!(
                    "Trace 最终响应未能保存：{error}；请检查历史目录并手动修复索引"
                ));
                eprintln!("Trace capture failed: {error}");
            }
        }
    }
}
struct ClientBodyGuard(ClientEvidence);
impl Drop for ClientBodyGuard {
    fn drop(&mut self) {
        self.0 .0.lock().unwrap().finished = true;
        self.0.flush();
    }
}

#[cfg(test)]
mod client_evidence_tests {
    use super::*;

    #[test]
    fn stats_distinguish_known_zero_from_missing_cost_without_repricing() {
        let root = std::env::temp_dir().join(format!(
            "xwx-known-cost-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir_all(&root).unwrap();
        let now = millis();
        let missing = json!({"atMs":now,"tokens":null,"knownCostUsd":null,"costComplete":false});
        let zero = json!({"atMs":now,"tokens":0,"knownCostUsd":0.0,"costComplete":true});
        let index =
            json!({"version":1,"sessions":[{"id":"known-cost","nativeUsage":[zero,missing]}]})
                .to_string();
        fs::write(root.join("index.json"), &index).unwrap();
        let store = TraceStore::open(root.clone(), u64::MAX, false, &root).unwrap();
        {
            let mut store = store.lock().unwrap();
            for (points, count, amount, complete) in [
                (json!([zero, missing]), 1, 0.0, false),
                (json!([missing]), 0, 0.0, false),
                (json!([zero]), 1, 0.0, true),
                (
                    json!([{"atMs":now,"tokens":7,"knownCostUsd":0.003,"costComplete":false},missing]),
                    1,
                    0.003,
                    false,
                ),
                (json!([]), 0, 0.0, true),
            ] {
                store.index["sessions"][0]["nativeUsage"] = points;
                let stats = store.stats();
                for period in ["total", "today", "week"] {
                    assert_eq!(stats[period]["knownCostRequests"], count);
                    assert_eq!(stats[period]["costUsd"], amount);
                    assert_eq!(stats[period]["costComplete"], complete);
                }
            }
        }
        assert_eq!(fs::read_to_string(root.join("index.json")).unwrap(), index);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn model_field_coverage_keeps_known_zero_after_unknown_and_invalid_requests() {
        let unknown = json!({
            "request":{"model":"known-zero-contract"},
            "usage":{"incompleteFields":["input","cacheRead","cacheWrite","output","total"]},
            "costSnapshot":{"version":1,"knownCostUsd":null,"costComplete":false}
        });
        let zero = json!({
            "request":{"model":"known-zero-contract"},
            "usage":{"version":2,"inputUncachedTokens":0,"inputTotalTokens":0,
                "inputIncludesCache":true,"cacheReadTokens":0,"cacheCreationTokens":0,
                "outputTokens":0,"totalTokens":0,"incompleteFields":[]},
            "costSnapshot":{"version":1,"knownCostUsd":0,"costComplete":true}
        });
        let mut by_model = json!({});
        accumulate_model_usage(&mut by_model, &unknown);
        assert_eq!(
            by_model["known-zero-contract"]["knownFieldCounts"],
            json!({"input":0,"cacheRead":0,"cacheWrite":0,"output":0,"total":0})
        );
        assert!(by_model["known-zero-contract"]["capturedCost"]["cost"].is_null());
        accumulate_model_usage(&mut by_model, &zero);
        assert_eq!(
            by_model["known-zero-contract"]["knownFieldCounts"],
            json!({"input":1,"cacheRead":1,"cacheWrite":1,"output":1,"total":1})
        );
        for key in [
            "input",
            "inputTotal",
            "cacheRead",
            "cacheCreation",
            "output",
            "total",
        ] {
            assert_eq!(by_model["known-zero-contract"][key].as_u64(), Some(0));
        }
        // One illegal counter must not discard independently valid zero fields.
        let mut invalid = zero.clone();
        invalid["usage"]["outputTokens"] = json!(-1);
        invalid["usage"]["invalidFields"] = json!(["output"]);
        invalid["costSnapshot"]["costComplete"] = json!(false);
        accumulate_model_usage(&mut by_model, &invalid);
        assert_eq!(
            by_model["known-zero-contract"]["knownFieldCounts"],
            json!({"input":2,"cacheRead":2,"cacheWrite":2,"output":1,"total":2})
        );
        assert_eq!(by_model["known-zero-contract"]["output"].as_u64(), Some(0));
        assert!(by_model["known-zero-contract"]["invalidFields"]
            .as_array()
            .unwrap()
            .iter()
            .any(|field| field == "output"));
        assert_eq!(
            by_model["known-zero-contract"]["capturedCost"]["cost"].as_f64(),
            Some(0.0)
        );
        assert_eq!(
            by_model["known-zero-contract"]["capturedCost"]["complete"],
            false
        );
        let coverage = by_model["known-zero-contract"]["knownFieldCounts"].clone();
        let bytes = serde_json::to_vec(&by_model).unwrap();
        let mut resumed: Value = serde_json::from_slice(&bytes).unwrap();
        accumulate_model_usage(&mut resumed, &unknown);
        assert_eq!(resumed["known-zero-contract"]["knownFieldCounts"], coverage);
        assert_eq!(resumed["known-zero-contract"]["total"].as_u64(), Some(0));
        assert_eq!(
            resumed["known-zero-contract"]["capturedCost"]["cost"].as_f64(),
            Some(0.0)
        );
        assert_eq!(
            zero["usage"]["outputTokens"], 0,
            "source usage stays read-only"
        );
    }

    #[test]
    fn legacy_known_zero_survives_an_unknown_append_without_raw_history() {
        let mut by_model = json!({"fixture":{"version":2,"input":40,"cacheRead":60,"cacheCreation":0,"output":0,"total":100}});
        let unknown = json!({"request":{"model":"fixture"},"usage":{"incompleteFields":["input","cacheRead","cacheWrite","output","total"]}});
        accumulate_model_usage(&mut by_model, &unknown);
        assert_eq!(by_model["fixture"]["cacheCreation"], 0);
        assert_eq!(
            by_model["fixture"]["knownFieldCounts"],
            json!({"input":1,"cacheRead":1,"cacheWrite":1,"output":1,"total":1})
        );
        let mut fresh = json!({});
        accumulate_model_usage(&mut fresh, &unknown);
        assert_eq!(
            fresh["fixture"]["knownFieldCounts"],
            json!({"input":0,"cacheRead":0,"cacheWrite":0,"output":0,"total":0})
        );
    }

    #[test]
    fn cache_hit_pairs_survive_missing_usage_and_preserve_frozen_history() {
        let known = json!({"inputTotalTokens":100,"inputIncludesCache":true,"cacheReadTokens":60,"cacheCreationTokens":0,"inputUncachedTokens":40});
        let mut stats = Value::Null;
        accumulate_cache_hit_usage(&mut stats, &known);
        accumulate_cache_hit_usage(
            &mut stats,
            &json!({"incompleteFields":["input","cacheRead","cacheWrite"]}),
        );
        assert_eq!(
            stats,
            json!({"inputTokens":100,"cacheReadTokens":60,"knownRequests":1,"excludedRequests":1})
        );
        let root = std::env::temp_dir().join(format!(
            "xwx-cache-history-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("history.jsonl");
        let frozen = json!({"version":1,"costComplete":true,"costUsd":0.123,"knownCostUsd":0.123,"tokens":100});
        let source = [json!({"request":{"model":"fixture"},"usage":known,"costSnapshot":frozen}),json!({"request":{"model":"fixture"},"usage":{"incompleteFields":["input","cacheRead"]},"costSnapshot":{"version":1,"costComplete":false}})].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        fs::write(&file, &source).unwrap();
        let original_model = json!({"version":2,"input":40,"cacheRead":60,"cacheCreation":0,"incompleteFields":["input","cacheRead"]});
        let index=json!({"version":1,"sessions":[{"id":"history","jsonlPath":file,"traceCount":2,"costSnapshotVersion":1,"nativeUsage":[frozen,{"version":1,"costComplete":false}],"usageByModel":{"fixture":original_model}}]}).to_string();
        fs::write(root.join("index.json"), &index).unwrap();
        let store = TraceStore::open(root.clone(), u64::MAX, false, &root).unwrap();
        {
            let store = store.lock().unwrap();
            let view = &store.view_sessions()[0];
            assert_eq!(view["cacheHitUsage"], stats);
            let mut annotated_model = original_model.clone();
            annotated_model["knownFieldCounts"] =
                json!({"input":1,"cacheRead":1,"cacheWrite":1,"output":0,"total":0});
            assert_eq!(view["usageByModel"]["fixture"], annotated_model);
            assert_eq!(view["nativeUsage"][0], frozen);
        }
        assert_eq!(fs::read_to_string(&file).unwrap(), source);
        assert_eq!(fs::read_to_string(root.join("index.json")).unwrap(), index);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn continued_legacy_summary_without_readable_rows_counts_history_as_excluded() {
        for empty_file in [false, true] {
            let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "xwx-cache-missing-history-{}-{}-{empty_file}",
                std::process::id(),
                millis()
            ));
            fs::create_dir_all(&root).unwrap();
            let key = "cache-legacy-resume";
            let id = format!("session-{}", &digest(key.as_bytes())[..24]);
            let file = root.join(format!("{id}.jsonl"));
            if empty_file {
                fs::write(&file, "").unwrap();
            }
            let frozen = json!({"version":1,"costComplete":true,"costUsd":0.123,"knownCostUsd":0.123,"tokens":100});
            let frozen_history = vec![frozen; 3];
            let index = json!({"version":1,"sessions":[{"id":id,"clientConversationKey":key,"jsonlPath":file,"traceCount":3,
                "costSnapshotVersion":1,"captureClassificationVersion":1,"errorCount":0,"nativeUsage":frozen_history,
                "totalTokens":300,"usageByModel":{"fixture":{"version":2,"input":0,"cacheRead":0,"cacheCreation":0,
                    "inputTotalComplete":false,"incompleteFields":["input","cacheRead"]}}}]}).to_string();
            fs::write(root.join("index.json"), &index).unwrap();
            let store = TraceStore::open(root.clone(), u64::MAX, false, &root).unwrap();
            let record = json!({"id":"continued","startedAt":"2026-10-14T00:00:00Z","completedAt":"2026-10-14T00:00:01Z",
                "source":"codex-cli","durationMs":1,"request":{"model":"fixture","apiType":"responses","body":{"input":"synthetic"}},
                "usage":{"inputTokens":100,"inputUncachedTokens":40,"inputTotalTokens":100,"inputIncludesCache":true,
                    "cacheReadTokens":60,"cacheCreationTokens":0,"outputTokens":5,"totalTokens":105}});
            {
                let mut store = store.lock().unwrap();
                assert!(store.legacy_costs.is_empty());
                store.append(record, key).unwrap();
                let view = store.view_sessions().remove(0);
                assert_eq!(view["traceCount"], 4);
                assert_eq!(
                    view["cacheHitUsage"],
                    json!({"inputTokens":100,"cacheReadTokens":60,"knownRequests":1,"excludedRequests":3})
                );
                assert_eq!(
                    &view["nativeUsage"].as_array().unwrap()[..3],
                    frozen_history.as_slice()
                );
            }
            drop(store);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn legacy_cost_view_rebuilds_raw_usage_without_writing_evidence() {
        let root = std::env::temp_dir().join(format!(
            "xwx-legacy-cost-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("legacy.jsonl");
        let frozen = json!({"version":1,"atMs":1,"tokens":2,"knownCostUsd":0.123,"costUsd":0.123,"costComplete":true});
        let row = |input| json!({"startedAt":"2026-10-13T00:00:00Z","protocol":"openai-responses","request":{"model":"legacy-fixture"},"usage":{"totalTokens":0},"usageEvidence":{"upstream":{"protocol":"responses","raw":{"input_tokens":input,"output_tokens":5,"input_tokens_details":{"cached_tokens":if input==100 {60} else {0},"cache_write_tokens":0}}}}});
        let source=[row(100),row(101),json!({"request":{"model":"legacy-fixture"},"usage":{"version":2,"inputUncachedTokens":1,"inputTotalTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheCreationTokens":0,"totalTokens":2},"costSnapshot":frozen})].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        fs::write(&file, &source).unwrap();
        let index=json!({"version":1,"sessions":[{"id":"legacy","jsonlPath":file,"traceCount":3,"captureClassificationVersion":1,"totalTokens":0,"usageByModel":{}}]}).to_string();
        fs::write(root.join("index.json"), &index).unwrap();
        let store = TraceStore::open(root.clone(), u64::MAX, false, &root).unwrap();
        {
            let mut store = store.lock().unwrap();
            store.prices = vec![
                json!({"modelId":"legacy-fixture","input":2,"output":10,"cacheRead":0.1,"cacheWrite":2,"tiers":[{"fromInputTokens":0,"input":2,"output":10,"cacheRead":0.1,"cacheWrite":2},{"fromInputTokens":101,"input":4,"output":15,"cacheRead":0.2,"cacheWrite":4}]}),
            ];
            store.refresh_legacy_costs();
            let view = &store.view_sessions()[0];
            assert_eq!(view["costViewBasis"], "legacy-current-reference");
            assert_eq!(view["totalTokens"], 213);
            assert_eq!(
                view["usageByModel"]["legacy-fixture"]["capturedCost"]["complete"],
                true
            );
            assert!(
                (view["usageByModel"]["legacy-fixture"]["capturedCost"]["cost"]
                    .as_f64()
                    .unwrap()
                    - 0.123615)
                    .abs()
                    < 1e-12
            );
            assert_eq!(view["nativeUsage"][2], frozen);
            assert!(view["nativeUsage"][0]["atMs"].as_u64().is_some());
            assert_eq!(store.index["sessions"][0]["totalTokens"], 0);
            let page = store.page("legacy", Some(0), None, 200).unwrap().unwrap();
            assert_eq!(page["traces"][1]["usage"]["inputTotalTokens"], 100);
            assert_eq!(
                page["traces"][1]["costViewBasis"],
                "legacy-current-reference"
            );
            store.index["sessions"][0]["traceCount"] = json!(4);
            store.refresh_legacy_costs();
            assert_eq!(
                store.view_sessions()[0]["usageByModel"]["legacy-fixture"]["capturedCost"]
                    ["complete"],
                false
            );
        }
        assert_eq!(fs::read_to_string(&file).unwrap(), source);
        assert_eq!(fs::read_to_string(root.join("index.json")).unwrap(), index);
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn page_reader_reuses_metadata_and_observes_committed_appends() {
        use std::io::Write;
        let root = std::env::temp_dir().join(format!(
            "xwx-page-cache-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("cache.jsonl");
        let row = |id: &str| {
            json!({"id":id,"sessionId":"cache","startedAt":"2026-10-16T00:00:00Z","request":{"body":{"input":"exact body"}},"costSnapshot":{"version":1,"costComplete":true}}).to_string()+"\n"
        };
        fs::write(&file, row("a")).unwrap();
        fs::write(root.join("index.json"),json!({"version":1,"sessions":[{"id":"cache","jsonlPath":file,"traceCount":1,"captureClassificationVersion":1}]}).to_string()).unwrap();
        let store = TraceStore::open(root.clone(), u64::MAX, false, &root).unwrap();
        let reader = store.lock().unwrap().page_reader();
        // The reader must work while another operation owns the Gateway lock.
        let guard = store.lock().unwrap();
        let first = reader.file_rows(&file).unwrap();
        assert!(Arc::ptr_eq(&first, &reader.file_rows(&file).unwrap()));
        assert!(first[0].summary["request"]["body"].is_null());
        assert_eq!(
            reader
                .page("cache", None, None, 200, false, Some("a"))
                .unwrap()
                .unwrap()["traces"][0]["request"]["body"]["input"],
            "exact body"
        );
        drop(guard);
        fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap()
            .write_all(row("b").as_bytes())
            .unwrap();
        // A pre-existing reader stays at its committed boundary.
        assert_eq!(
            reader
                .page("cache", None, None, 200, true, None)
                .unwrap()
                .unwrap()["total"],
            1
        );
        let next = store.lock().unwrap().page_reader();
        assert_eq!(
            next.page("cache", None, None, 200, true, None)
                .unwrap()
                .unwrap()["total"],
            2
        );
        assert!(!Arc::ptr_eq(&first, &next.file_rows(&file).unwrap()));
        let old_prices = next.file_rows(&file).unwrap();
        store.lock().unwrap().prices = vec![json!({"model":"changed-reference"})];
        let repriced = store.lock().unwrap().page_reader();
        assert!(!Arc::ptr_eq(
            &old_prices,
            &repriced.file_rows(&file).unwrap()
        ));
        fs::write(&file, row("c")).unwrap();
        let replaced = store.lock().unwrap().page_reader();
        assert_eq!(
            replaced
                .page("cache", None, None, 200, false, Some("c"))
                .unwrap()
                .unwrap()["traces"][0]["id"],
            "c"
        );
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn large_pages_are_contiguous_from_both_edges_and_keep_latest() {
        let root = std::env::temp_dir().join(format!(
            "xwx-page-boundary-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("large.jsonl");
        let payload = "x".repeat(9 * 1024 * 1024);
        let source = (0..5).map(|n| json!({"id":format!("large-{n}"),"sessionId":"large","startedAt":format!("2026-10-13T00:00:0{n}Z"),"request":{"body":{"input":payload}}}).to_string()).collect::<Vec<_>>().join("\n");
        fs::write(&file, &source).unwrap();
        fs::write(root.join("index.json"),json!({"version":1,"sessions":[{"id":"large","jsonlPath":file,"traceCount":5,"captureClassificationVersion":1,"source":"codex-cli"}]}).to_string()).unwrap();
        let store = TraceStore::open(root.clone(), u64::MAX, false, &root).unwrap();
        {
            let store = store.lock().unwrap();
            let tail = store.page("large", None, None, 200).unwrap().unwrap();
            assert_eq!(tail["offset"], 3);
            assert_eq!(tail["traces"][1]["id"], "large-4");
            let before = store.page("large", None, Some(3), 200).unwrap().unwrap();
            assert_eq!(before["offset"], 1);
            assert_eq!(before["traces"][0]["turn"], 2);
            assert_eq!(before["traces"][1]["id"], "large-2");
            let first = store.page("large", None, Some(1), 200).unwrap().unwrap();
            assert_eq!(first["offset"], 0);
            assert_eq!(first["traces"][0]["id"], "large-0");
            let forward = store.page("large", Some(1), None, 200).unwrap().unwrap();
            assert_eq!(forward["offset"], 1);
            assert_eq!(forward["traces"][1]["id"], "large-2");
            let summary = store
                .page_projection("large", Some(0), None, 200, true, None)
                .unwrap()
                .unwrap();
            assert_eq!(summary["offset"], 0);
            assert_eq!(summary["traces"].as_array().unwrap().len(), 5);
            assert_eq!(summary["traces"][0]["id"], "large-0");
            assert_eq!(summary["traces"][4]["turn"], 5);
            assert_eq!(summary["traces"][0]["summaryOnly"], true);
            assert!(summary["traces"][0]["request"]["body"].is_null());
            assert!(summary.to_string().len() < 10_000);
            let selected = store
                .page_projection("large", None, None, 200, false, Some("large-4"))
                .unwrap()
                .unwrap();
            assert_eq!(selected["traces"].as_array().unwrap().len(), 1);
            assert_eq!(selected["traces"][0]["id"], "large-4");
            assert_eq!(
                selected["traces"][0]["request"]["body"]["input"]
                    .as_str()
                    .unwrap()
                    .len(),
                payload.len()
            );
            assert_eq!(fs::read_to_string(&file).unwrap(), source);
            assert_eq!(
                store.session_file("large").unwrap(),
                file.canonicalize().unwrap()
            );
            assert!(store.session_file("../outside").is_err());
        }
        drop(store);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_embeds_repository_prices_for_offline_billing() {
        let rules: Vec<Value> =
            serde_json::from_str(include_str!("../../test-results/native-assets/prices.json"))
                .unwrap();
        assert!(
            !rules.is_empty()
                && rules
                    .iter()
                    .all(|r| r["referenceOnly"] == true && r["source"] == "models.dev"),
            "native build must embed only the standard reference catalog"
        );
        let price = rules
            .iter()
            .find(|r| r["modelId"] == "mimo-v2.6-pro")
            .expect("new provider included offline");
        let usage = json!({"inputUncachedTokens":40,"inputTotalTokens":100,"outputTokens":5,"cacheReadTokens":60,"cacheCreationTokens":0});
        let expected = (40.0 * price["input"].as_f64().unwrap()
            + 5.0 * price["output"].as_f64().unwrap()
            + 60.0 * price["cacheRead"].as_f64().unwrap())
            / 1_000_000.0;
        assert!((model_cost(&rules, "mimo-v2.6-pro", &usage, 0).unwrap() - expected).abs() < 1e-12);
    }
    #[test]
    fn billing_uses_relevant_counters_and_keeps_unknowns() {
        let price = json!({"match":"exact","modelId":"fixture","protocol":"openai","input":1,"output":2,"cacheRead":0.1,"cacheWritePolicy":"input"});
        let raw = json!({"usage":{"input_tokens":100,"output_tokens":5,"input_tokens_details":{"cached_tokens":60}}});
        let u = usage(&raw, "responses");
        assert_eq!(u["incompleteFields"], json!(["cacheWrite"]));
        assert!(
            (model_cost(std::slice::from_ref(&price), "fixture", &u, 0).unwrap() - 0.000056).abs()
                < 1e-12
        );
        let mut premium = price.clone();
        premium["cacheWrite"] = json!(1.25);
        assert!(model_cost(&[premium.clone()], "fixture", &u, 0).is_none());
        let unknown_read = usage(
            &json!({"usage":{"input_tokens":100,"output_tokens":5,"input_tokens_details":{"cache_write_tokens":0}}}),
            "responses",
        );
        assert!(model_cost(std::slice::from_ref(&price), "fixture", &unknown_read, 0).is_none());
        let mut uniform = price.clone();
        uniform["cacheRead"] = json!(1);
        assert!(
            (model_cost(&[uniform], "fixture", &unknown_read, 0).unwrap() - 0.00011).abs() < 1e-12
        );
        let ttl = usage(
            &json!({"usage":{"input_tokens":20,"output_tokens":5,"cache_read_input_tokens":60,"cache_creation_input_tokens":20,"cache_creation":{"ephemeral_5m_input_tokens":10,"ephemeral_1h_input_tokens":10}}}),
            "messages",
        );
        premium["protocol"] = json!("anthropic");
        assert!(
            (model_cost(&[premium.clone()], "fixture", &ttl, 0).unwrap() - 0.0000685).abs() < 1e-12
        );
        let mut unknown_ttl = ttl.clone();
        unknown_ttl["cacheCreation5mTokens"] = Value::Null;
        unknown_ttl["cacheCreation1hTokens"] = Value::Null;
        assert!(model_cost(&[premium.clone()], "fixture", &unknown_ttl, 0).is_none());
        let mut storage_price = premium;
        storage_price["cacheStoragePerHour"] = json!(1);
        assert!(model_cost(&[storage_price], "fixture", &ttl, 0).is_none());
        let mut absent_total = u.clone();
        absent_total["incompleteFields"] = json!(["total", "cacheWrite"]);
        assert!(model_cost(&[price], "fixture", &absent_total, 0).is_some());
        let family = json!({"tokens":["gpt-5"],"protocol":"openai","input":1,"output":2,"cacheRead":0.1,"cacheWritePolicy":"input"});
        assert!(model_cost(std::slice::from_ref(&family), "gpt-5-codex", &u, 0).is_none());
        assert!(
            model_cost(&[family], "gpt-5.7", &u, 0).is_none(),
            "new model versions must not inherit a generic legacy price"
        );
    }

    #[test]
    fn exact_prices_prefer_source_qualification_and_keep_first_tie() {
        let usage = json!({"inputUncachedTokens":10,"inputTotalTokens":10,"outputTokens":0,"cacheReadTokens":0,"cacheCreationTokens":0});
        let bare = json!({"match":"exact","modelId":"fixture","input":1,"output":2});
        let qualified = json!({"match":"exact","modelId":"relay/fixture","input":9,"output":2});
        let later = json!({"match":"exact","modelId":"relay/fixture","input":99,"output":2});
        let cost = model_cost(
            &[bare, qualified.clone(), later],
            "relay/fixture",
            &usage,
            0,
        )
        .unwrap();
        assert!((cost - 0.00009).abs() < 1e-12);
        assert!(model_cost(&[qualified], "fixture", &usage, 0).is_none());
    }

    #[test]
    fn shared_partial_cost_corpus() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../tools/shared-core/trace-cost-cases.json"
        ))
        .unwrap();
        for case in cases {
            let u = &case["usage"];
            let mut usage = json!({"inputIncludesCache":u["apiType"] != "messages"});
            for (from, to) in [
                ("input", "inputUncachedTokens"),
                ("inputTotal", "inputTotalTokens"),
                ("output", "outputTokens"),
                ("cacheRead", "cacheReadTokens"),
                ("cacheCreation", "cacheCreationTokens"),
                ("cacheCreation5m", "cacheCreation5mTokens"),
                ("cacheCreation1h", "cacheCreation1hTokens"),
                ("incompleteFields", "incompleteFields"),
                ("invalidFields", "invalidFields"),
                ("reasoning", "reasoningTokens"),
                ("reasoningComplete", "reasoningComplete"),
            ] {
                usage[to] = u[from].clone();
            }
            let mut price = case["price"].clone();
            price["tokens"] = json!(["fixture"]);
            price["match"] = json!("exact");
            let (cost, complete) = model_cost_parts(&[price], "fixture", &usage, 0);
            assert_eq!(
                complete,
                case["complete"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
            assert!(
                (cost.unwrap() - case["cost"].as_f64().unwrap()).abs() < 1e-12,
                "{}: {:?}",
                case["name"],
                cost
            );
        }
    }

    #[test]
    fn cache_usage_preserves_protocol_semantics_and_unknown_buckets() {
        let openai = usage(
            &json!({"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":60}}}),
            "openai-chat-completions",
        );
        assert_eq!(openai["inputUncachedTokens"], 40);
        assert_eq!(openai["inputTotalTokens"], 100);
        assert_eq!(openai["cacheReadTokens"], 60);
        assert_eq!(openai["cacheCreationTokens"], 0);
        assert_eq!(openai["incompleteFields"], json!([]));
        let messages = usage(
            &json!({"usage":{"input_tokens":20,"output_tokens":5,"cache_read_input_tokens":60,"cache_creation_input_tokens":20}}),
            "anthropic-messages",
        );
        assert_eq!(messages["inputUncachedTokens"], 20);
        assert_eq!(messages["inputTotalTokens"], 100);
        assert_eq!(messages["incompleteFields"], json!([]));
        let unknown = usage(
            &json!({"usage":{"input_tokens":20,"output_tokens":5}}),
            "anthropic-messages",
        );
        assert_eq!(unknown["incompleteFields"], json!([]));
        let explicit_zero = usage(
            &json!({"usage":{"input_tokens":20,"output_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}),
            "anthropic-messages",
        );
        assert_eq!(explicit_zero["incompleteFields"], json!([]));
    }

    #[test]
    fn unpolled_client_body_still_runs_finalizer() {
        let evidence = ClientEvidence::default();
        let _capture = evidence.capture();
        let response = evidence.response(Response::new(Body::from("unread")));
        assert!(!evidence.0.lock().unwrap().finished);
        drop(response);
        let state = evidence.0.lock().unwrap();
        assert!(state.finished);
        assert!(!state.ended);
        assert!(state.raw.is_empty());
    }

    #[test]
    fn transport_failure_keeps_only_the_forwarded_prefix() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let evidence = ClientEvidence::default();
                let _capture = evidence.capture();
                let chunks = futures_util::stream::iter([
                    Ok(axum::body::Bytes::from_static(b"visible prefix")),
                    Err(std::io::Error::other("fixture failure")),
                ]);
                let response = evidence.response(Response::new(Body::from_stream(chunks)));
                assert!(to_bytes(response.into_body(), 1024).await.is_err());
                let state = evidence.0.lock().unwrap();
                assert!(state.finished);
                assert!(!state.ended);
                assert_eq!(state.raw, b"visible prefix");
            });
    }

    #[test]
    fn eof_is_distinct_from_dropping_a_body() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let evidence = ClientEvidence::default();
                let _capture = evidence.capture();
                let response = evidence.response(Response::new(Body::from("complete")));
                assert_eq!(
                    &to_bytes(response.into_body(), 1024).await.unwrap()[..],
                    b"complete"
                );
                let state = evidence.0.lock().unwrap();
                assert!(state.finished && state.ended);
            });
    }
}

pub(super) struct Capture {
    pub _detail_lease: Option<DetailLease>,
    pub store: Store,
    pub record: Value,
    pub wire: String,
    pub key: String,
    pub raw: Vec<u8>,
    pub chunk_receipts: Vec<(usize, u128)>,
    pub overflow: bool,
    pub done: bool,
    pub client_evidence: Option<ClientEvidence>,
}
impl Capture {
    pub fn chunk(&mut self, bytes: &[u8]) {
        if self.raw.len() + bytes.len() <= 32 * 1024 * 1024 {
            self.raw.extend_from_slice(bytes);
            self.chunk_receipts.push((
                self.raw.len(),
                millis().saturating_sub(self.record["startedAtMs"].as_u64().unwrap_or(0) as u128),
            ));
        } else {
            self.overflow = true;
        }
    }
    pub fn finish(mut self, value: Option<Value>) {
        self.done = true;
        self.save(value);
    }
    fn save(&mut self, value: Option<Value>) {
        // Codex WS prewarm creates a response with generate=false. It still
        // participates in continuation caching, but is not a generated turn.
        if self.record["request"]["body"]["generate"] == false {
            return;
        }
        let end = millis();
        self.record["completedAt"] = json!(iso(end));
        self.record["durationMs"] =
            json!(end.saturating_sub(self.record["startedAtMs"].as_u64().unwrap_or(0) as u128));
        let raw = String::from_utf8_lossy(&self.raw);
        let parsed = value
            .or_else(|| serde_json::from_slice::<Value>(&self.raw).ok())
            .or_else(|| {
                super::protocol::collapse_sse(
                    &raw,
                    &self.wire,
                    text(&self.record["request"], "model"),
                )
                .ok()
            });
        if self.done && !self.overflow {
            let status = self.record["upstream"]["statusCode"].as_u64().unwrap_or(0) as u16;
            let value = parsed.as_ref().unwrap_or(&Value::Null);
            let success = ((200..300).contains(&status)
                || self.record["request"]["method"] == "WS")
                && parsed.is_some()
                && super::retired_models::successful(&self.wire, value);
            let root = self.store.lock().unwrap().data_root.clone();
            if let Err(error) = super::retired_models::observe(
                &root,
                text(&self.record["provider"], "id"),
                text(&self.record, "catalogIdentity"),
                text(&self.record["request"], "model"),
                status,
                value,
                success,
            ) {
                eprintln!("{error}");
            }
        }
        self.record["usage"] = parsed
            .as_ref()
            .map(|v| record_usage(v, &self.wire, &self.record))
            .unwrap_or_else(|| usage(&Value::Null, &self.wire));
        self.record["upstream"]["rawBody"] = json!(raw);
        self.record["response"]["rawBody"] = self
            .record
            .get("clientRawBody")
            .cloned()
            .unwrap_or(json!(raw));
        self.record.as_object_mut().unwrap().remove("clientRawBody");
        if let Some(ref v) = parsed {
            self.record["upstream"]["body"] = v.clone();
            if self.record["response"].get("body").is_none() {
                self.record["response"]["body"] = v.clone();
            }
            self.record["usageEvidence"] =
                json!({"upstream":{"protocol":self.wire,"raw":v["usage"]}});
        }
        let client_protocol = text(&self.record["contextChanges"], "clientProtocol").to_string();
        if ["chat-completions", "gemini"].contains(&client_protocol.as_str()) {
            let body = self.record["response"]["body"].clone();
            if body["object"] == "response" {
                self.record["intermediateResponse"] = json!({"protocol":"responses","body":body,"rawBody":self.record["response"]["rawBody"]});
                self.record["response"]["body"] =
                    super::ingress::response_json(&body, &client_protocol);
                self.record["response"]["rawBody"] = Value::Null;
                self.record["response"]["bodyFormat"] = json!("assembled");
            }
            self.record["response"]["protocol"] = json!(client_protocol);
        }
        let mut events = vec![];
        let mut block = String::new();
        let mut offset = 0;
        let mut receipt = 0;
        for line in raw.split_inclusive('\n') {
            offset += line.len();
            if line.trim_matches(['\r', '\n']).is_empty() {
                let data = block
                    .lines()
                    .filter_map(|l| l.strip_prefix("data:").map(str::trim_start))
                    .collect::<Vec<_>>()
                    .join("\n");
                if !data.is_empty() {
                    while receipt + 1 < self.chunk_receipts.len()
                        && self.chunk_receipts[receipt].0 < offset
                    {
                        receipt += 1;
                    }
                    let timestamp = self.chunk_receipts.get(receipt).map(|(_, at)| *at);
                    events.push(json!({"event":block.lines().find_map(|l|l.strip_prefix("event:").map(str::trim)),"data":data,"json":serde_json::from_str::<Value>(&data).ok(),"timestampMs":timestamp}));
                }
                block.clear();
            } else {
                block.push_str(line);
            }
        }
        self.record["sse"] =
            json!({"events":events,"timingBasis":"relative-upstream-chunk-receipt"});
        if self.overflow {
            self.record["error"] = json!("记录正文超过 32 MB，已截断；网络转发保持完整");
        }
        if !self.done {
            self.record["error"] = json!("客户端断开或上游流中断，记录为未完成");
        } else if parsed.is_none()
            && self.record["upstream"]["statusCode"]
                .as_u64()
                .is_some_and(|status| (200..300).contains(&status))
        {
            self.record["error"] =
                json!("上游正文或协议流未完整结束，未将 HTTP 成功视为模型请求成功");
        }
        if parsed
            .as_ref()
            .is_some_and(|v| [json!("failed"), json!("incomplete")].contains(&v["status"]))
        {
            self.record["error"] = json!("上游响应未完成");
        }
        if let Some(evidence) = &self.client_evidence {
            evidence.publish(self.store.clone(), self.key.clone(), self.record.clone());
            return;
        }
        if let Err(e) = self
            .store
            .lock()
            .unwrap()
            .append(self.record.clone(), &self.key)
        {
            eprintln!("Trace capture failed: {e}");
        }
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        if !self.done {
            self.save(None);
        }
    }
}

#[derive(Clone)]
pub(super) struct DashboardState {
    pub store: Store,
    pub stopped: tokio::sync::watch::Receiver<bool>,
}
pub(super) async fn dashboard(State(context): State<DashboardState>, request: Request) -> Response {
    if *context.stopped.borrow() {
        return protocol_error(
            410,
            "responses",
            "Trace directory changed; reopen the dashboard",
        );
    }
    let store = context.store;
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    let host = request
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !(host.starts_with("127.0.0.1:") || host.starts_with("localhost:")) {
        return protocol_error(403, "responses", "Invalid local Host");
    }
    if path.starts_with("/fonts/") && method == axum::http::Method::GET {
        return match crate::embedded_fonts::get(&path) {
            Some(bytes) => (
                [
                    ("content-type", "font/woff2"),
                    ("cache-control", "public, max-age=31536000, immutable"),
                ],
                bytes,
            )
                .into_response(),
            None => axum::http::StatusCode::NOT_FOUND.into_response(),
        };
    }
    if method != axum::http::Method::GET {
        let origin = request
            .headers()
            .get("origin")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if origin != format!("http://{host}") {
            return protocol_error(403, "responses", "Invalid dashboard Origin");
        }
    }
    if path == "/__native-viewer-smoke"
        && method == axum::http::Method::POST
        && std::env::args().any(|a| a == "--smoke")
    {
        let data = match to_bytes(request.into_body(), 128 * 1024).await {
            Ok(data) => data,
            Err(_) => return protocol_error(400, "responses", "Invalid smoke report"),
        };
        let report: Value = match serde_json::from_slice(&data) {
            Ok(report) => report,
            Err(_) => return protocol_error(400, "responses", "Invalid smoke JSON"),
        };
        if !report["passed"].is_boolean() {
            return protocol_error(400, "responses", "Invalid smoke report");
        }
        let file = match store.lock() {
            Ok(store) => store.root.join("native-viewer-smoke.json"),
            Err(_) => return protocol_error(500, "responses", "Trace store unavailable"),
        };
        if let Err(error) = write(&file, &report.to_string()) {
            return protocol_error(500, "responses", &error);
        }
        return Response::builder()
            .status(200)
            .body(Body::from("{}"))
            .unwrap();
    }
    if path == "/events" && method == axum::http::Method::GET {
        let mut receiver = match store.lock() {
            Ok(store) => store.events.subscribe(),
            Err(_) => return protocol_error(500, "responses", "Trace store unavailable"),
        };
        let mut stopped = context.stopped;
        let stream = async_stream::stream! {
            yield Ok::<_,std::convert::Infallible>(": connected\n\n".to_string());
            loop{if *stopped.borrow(){break;}tokio::select!{
                _=stopped.changed()=>break,
                event=receiver.recv()=>{match event{Ok(event)=>yield Ok(event),Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>yield Ok("event: reset\ndata: {}\n\n".into()),Err(_)=>break,}}
                _=tokio::time::sleep(Duration::from_secs(10))=>{yield Ok(": heartbeat\n\n".into());}
            }}
        };
        return Response::builder()
            .status(200)
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .body(Body::from_stream(stream))
            .unwrap();
    }
    let result = tokio::task::spawn_blocking(move || -> Result<(String, &str)> {
        let mut store = store.lock().map_err(err)?;
        if ["/", "/dashboard", "/index.html"].contains(&path.as_str()) {
            let mut html = include_str!("../../test-results/native-assets/viewer.html").to_string();
            let preference = serde_json::to_string(&store.theme)
                .map_err(err)?
                .replace('<', "\\u003c");
            html = html.replacen(
                "applyViewerTheme(state.theme);",
                &format!("state.theme={preference};applyViewerTheme(state.theme);"),
                1,
            );
            if std::env::args().any(|a| a == "--smoke") {
                html = html.replace(
                    "</body>",
                    &format!(
                        "<script>{}</script></body>",
                        if std::env::args().any(|a| a == "--smoke-window-lifecycle") {
                            include_str!("../../tools/native/window-lifecycle-viewer-smoke.js")
                        } else if std::env::args().any(|a| a == "--smoke-theme") {
                            include_str!("../../tools/native/theme-viewer-smoke.js")
                        } else {
                            include_str!("../../tools/native/viewer-smoke.js")
                        }
                    ),
                );
            }
            return Ok((html, "text/html; charset=utf-8"));
        }
        if path == "/api/theme" {
            return Ok((
                json!({"theme":store.theme,"language":store.language}).to_string(),
                "application/json",
            ));
        }
        if path == "/api/state" {
            return Ok((store.state(store.active).to_string(), "application/json"));
        }
        if let Some(id) = path.strip_prefix("/api/session/") {
            if let Some(id) = id.strip_suffix("/reveal") {
                if method != axum::http::Method::POST {
                    return Err("method not allowed".into());
                }
                let file = store.session_file(id)?;
                // OS Shell dispatch must not hold the Trace store lock.
                drop(store);
                #[cfg(target_os = "macos")]
                let status = std::process::Command::new("/usr/bin/open")
                    .arg("-R")
                    .arg(&file)
                    .status()
                    .map_err(err)?;
                #[cfg(target_os = "windows")]
                windows_reveal::reveal(&file)?;
                #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                let status = std::process::Command::new("xdg-open")
                    .arg(file.parent().ok_or("日志目录无效")?)
                    .status()
                    .map_err(err)?;
                #[cfg(not(target_os = "windows"))]
                if !status.success() {
                    return Err("无法打开日志所在文件夹".into());
                }
                return Ok((json!({"ok":true}).to_string(), "application/json"));
            }
            if method == axum::http::Method::DELETE {
                let url = reqwest::Url::parse(&format!("http://localhost{}", request.uri()))
                    .map_err(err)?;
                let options: Vec<_> = url
                    .query_pairs()
                    .filter(|(key, _)| key == "clearUsage")
                    .collect();
                let clear_usage = match options.as_slice() {
                    [] => false,
                    [(_, value)] if value == "1" => true,
                    [(_, value)] if value == "0" => false,
                    _ => return Err("无效的用量清理选项".into()),
                };
                return Ok((
                    json!({"ok":store.delete(id, clear_usage)?}).to_string(),
                    "application/json",
                ));
            }
            let pairs =
                reqwest::Url::parse(&format!("http://localhost{}", request.uri())).map_err(err)?;
            let params: BTreeMap<_, _> = pairs.query_pairs().into_owned().collect();
            let offset = params.get("offset").and_then(|v| v.parse().ok());
            let before = params.get("before").and_then(|v| v.parse().ok());
            let limit = params
                .get("limit")
                .and_then(|v| v.parse().ok())
                .unwrap_or(80);
            let summary_only = params.get("summary").is_some_and(|value| value == "1");
            let request_id = params.get("requestId").map(|value| value.as_ref());
            let reader = store.page_reader();
            let id = id.to_owned();
            let request_id = request_id.map(str::to_owned);
            drop(store);
            return reader
                .page(
                    &id,
                    offset,
                    before,
                    limit,
                    summary_only,
                    request_id.as_deref(),
                )?
                .map(|v| (v.to_string(), "application/json"))
                .ok_or("session not found".into());
        }
        Err("not found".into())
    })
    .await
    .unwrap_or_else(|error| Err(error.to_string()));
    match result {
        Ok((body, kind)) => Response::builder()
            .status(200)
            .header("content-type", kind)
            .header("cache-control", "no-store")
            .body(Body::from(body))
            .unwrap(),
        Err(e) => protocol_error(404, "responses", &e),
    }
}
