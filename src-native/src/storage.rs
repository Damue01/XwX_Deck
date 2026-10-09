use super::*;
use chrono::{DateTime, Local, Utc};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

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
    let u = &value["usage"];
    if !u.is_object() {
        return json!({"incompleteFields":["input","cacheRead","cacheWrite","output","total"]});
    }
    let input = u
        .get("input_tokens")
        .or_else(|| u.get("prompt_tokens"))
        .and_then(Value::as_u64);
    let output = u
        .get("output_tokens")
        .or_else(|| u.get("completion_tokens"))
        .and_then(Value::as_u64);
    let read = if wire == "anthropic-messages" {
        u["cache_read_input_tokens"].as_u64()
    } else {
        u["input_tokens_details"]["cached_tokens"]
            .as_u64()
            .or_else(|| u["prompt_tokens_details"]["cached_tokens"].as_u64())
    };
    let write = if wire == "anthropic-messages" {
        u["cache_creation_input_tokens"].as_u64()
    } else {
        u["input_tokens_details"]["cache_write_tokens"]
            .as_u64()
            .or_else(|| u["prompt_tokens_details"]["cache_write_tokens"].as_u64())
    };
    let read = read.unwrap_or(0);
    let write = write.unwrap_or(0);
    let input_total = input.map(|i| {
        if wire == "anthropic-messages" {
            i + read + write
        } else {
            i
        }
    });
    let uncached = input.map(|i| {
        if wire == "anthropic-messages" {
            i
        } else {
            i.saturating_sub(read + write)
        }
    });
    let mut incomplete = vec![];
    if input.is_none() {
        incomplete.push("input");
        incomplete.push("total");
    }
    if output.is_none() {
        incomplete.push("output");
        if !incomplete.contains(&"total") {
            incomplete.push("total");
        }
    }
    json!({"inputTokens":input,"inputUncachedTokens":uncached,"inputTotalTokens":input_total,"outputTokens":output,"cacheReadTokens":read,"cacheCreationTokens":write,"cacheCreation5mTokens":u["cache_creation"]["ephemeral_5m_input_tokens"],"cacheCreation1hTokens":u["cache_creation"]["ephemeral_1h_input_tokens"],"totalTokens":input_total.zip(output).map(|(i,o)|i+o),"inputIncludesCache":wire!="anthropic-messages","incompleteFields":incomplete})
}
fn model_cost(model: &str, usage: &Value, at: u128) -> Option<f64> {
    if usage["incompleteFields"]
        .as_array()
        .is_some_and(|a| !a.is_empty())
    {
        return None;
    }
    let prices: Vec<Value> =
        serde_json::from_str(include_str!("../../test-results/native-assets/prices.json")).ok()?;
    let lower = model.to_lowercase();
    let price = prices.iter().find(|p| {
        if p["match"] == "exact" {
            let exact = p["modelId"]
                .as_str()
                .or_else(|| p["tokens"][0].as_str())
                .unwrap_or("")
                .to_lowercase();
            lower == exact || lower.ends_with(&format!("/{exact}"))
        } else {
            p["tokens"].as_array().is_some_and(|ts| {
                ts.iter()
                    .all(|t| lower.contains(&t.as_str().unwrap_or("").to_lowercase()))
            })
        }
    })?;
    let total = usage["inputTotalTokens"].as_u64().unwrap_or(0);
    let tier = price["tiers"].as_array().and_then(|tiers| {
        tiers
            .iter()
            .rev()
            .find(|t| t["fromInputTokens"].as_u64().unwrap_or(0) <= total)
    });
    let output = usage["outputTokens"].as_u64().unwrap_or(0);
    let hour = ((at / 1000 / 3600) % 24) as u64;
    let windows = price["peak"]["peakWindowsUtc"].as_array();
    let off_peak = windows.is_some_and(|windows| {
        !windows.is_empty()
            && !windows
                .iter()
                .any(|w| hour >= w[0].as_u64().unwrap_or(0) && hour < w[1].as_u64().unwrap_or(24))
    });
    let scale = if off_peak {
        price["peak"]["offPeakMultiplier"].as_f64().unwrap_or(1.0)
    } else {
        1.0
    };
    let rate = |key: &str| {
        tier.and_then(|p| p[key].as_f64())
            .or_else(|| price[key].as_f64())
    };
    let output_rate = tier
        .and_then(|p| {
            if output <= p["shortOutput"]["atMostTokens"].as_u64().unwrap_or(0) {
                p["shortOutput"]["output"].as_f64()
            } else {
                None
            }
        })
        .or_else(|| rate("output"))?;
    let mut cost = usage["inputUncachedTokens"].as_u64().unwrap_or(0) as f64 * rate("input")?
        + output as f64 * output_rate;
    let cache_read = usage["cacheReadTokens"].as_u64().unwrap_or(0);
    if cache_read > 0 {
        cost += cache_read as f64 * rate("cacheRead")?;
    }
    let cache_write = usage["cacheCreationTokens"].as_u64().unwrap_or(0);
    if cache_write > 0 {
        let one_hour = usage["cacheCreation1hTokens"].as_u64().unwrap_or(0);
        let other = cache_write.saturating_sub(one_hour);
        let policy = price["cacheWritePolicy"].as_str().unwrap_or("");
        let rate_write = rate("cacheWrite").or_else(|| match policy {
            "free" => Some(0.0),
            "input" => rate("input"),
            _ => {
                if ["openai", "deepseek", "xai"]
                    .contains(&price["providerId"].as_str().unwrap_or(""))
                {
                    rate("input")
                } else {
                    None
                }
            }
        })?;
        cost += other as f64 * rate_write;
        if one_hour > 0 {
            cost += one_hour as f64
                * price["cacheWrite1h"].as_f64().or_else(|| {
                    if price["protocol"] == "anthropic" {
                        rate("input").map(|r| r * 2.0)
                    } else {
                        None
                    }
                })?;
        }
    }
    Some(cost * scale / 1_000_000.0)
}

pub(super) struct TraceStore {
    pub root: PathBuf,
    pub active: bool,
    pub events: tokio::sync::broadcast::Sender<String>,
    index: Value,
    pub limit: u64,
    pub auto_cleanup: bool,
    pub read_problem: Option<String>,
}
impl TraceStore {
    pub fn open(root: PathBuf, limit: u64, auto: bool) -> Result<Store> {
        let source = read(&root.join("index.json"))?;
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
        Ok(Arc::new(std::sync::Mutex::new(Self {
            root,
            active: false,
            events: tokio::sync::broadcast::channel(16).0,
            index,
            limit,
            auto_cleanup: auto,
            read_problem,
        })))
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
            .filter_map(|e| e.metadata().ok())
            .map(|m| m.len())
            .sum()
    }
    pub fn state(&self, active: bool) -> Value {
        json!({"active":active,"rootPath":self.root,"generatedAt":iso(millis()),"sessions":self.index["sessions"],"traces":[],"storage":{"rootPath":self.root,"totalBytes":self.size(),"maxBytes":self.limit}})
    }
    pub fn stats(&self) -> Value {
        let now = millis();
        let today = Local::now().date_naive();
        let mut total = json!({"tokens":0,"costUsd":0.0,"costComplete":true});
        let mut day = total.clone();
        let mut week = total.clone();
        let mut series = vec![];
        for session in self.index["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .chain(self.index.get("usageOnly"))
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
                let cost = point["costUsd"].as_f64();
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
                    if cost.is_none() {
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
    pub fn page(&self, id: &str, offset: Option<usize>, limit: usize) -> Result<Option<Value>> {
        let Some(session) = self.index["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
        else {
            return Ok(None);
        };
        let file = PathBuf::from(session["jsonlPath"].as_str().ok_or("索引路径无效")?);
        if file.parent() != Some(self.root.as_path()) {
            return Err("索引路径越界，已拒绝读取".into());
        }
        let records = records(&file)?;
        let total = records.len();
        let limit = limit.clamp(1, 200);
        let offset = offset.unwrap_or(total.saturating_sub(limit)).min(total);
        let end = (offset + limit).min(total);
        let mut bytes = 0usize;
        let traces: Vec<_> = records[offset..end]
            .iter()
            .take_while(|r| {
                bytes += r.to_string().len();
                bytes <= 24 * 1024 * 1024
            })
            .cloned()
            .collect();
        let end = offset + traces.len();
        Ok(Some(
            json!({"id":id,"traces":traces,"offset":offset,"limit":limit,"total":total,"hasMoreBefore":offset>0,"hasMoreAfter":end<total}),
        ))
    }
    pub fn delete(&mut self, id: &str) -> Result<bool> {
        let sessions = self.index["sessions"].as_array_mut().unwrap();
        let Some(at) = sessions.iter().position(|s| s["id"] == id) else {
            return Ok(false);
        };
        let file = PathBuf::from(sessions[at]["jsonlPath"].as_str().ok_or("索引路径无效")?);
        if file.parent() != Some(self.root.as_path()) {
            return Err("索引路径越界".into());
        }
        read(&file)?;
        if file.exists() {
            fs::remove_file(&file).map_err(err)?;
        }
        sessions.remove(at);
        self.persist()?;
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
        let needs_repair = index_status == "invalid"
            || !unindexed.is_empty()
            || !missing.is_empty()
            || !stale.is_empty();
        Ok(
            json!({"rootPath":self.root,"indexPath":index_path,"indexStatus":index_status,"indexSha256":index_sha,"indexedSessions":indexed.len(),"jsonlFiles":total,"missingIndexedFiles":missing,"unindexedFiles":unindexed,"staleIndexedFiles":stale,"needsRepair":needs_repair,"candidates":candidates}),
        )
    }

    pub fn apply_repair(&mut self, expected: Option<&str>) -> Result<Value> {
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
                .collect();
            if rows.is_empty() {
                continue;
            }
            let first = &rows[0];
            let last = rows.last().unwrap();
            let native_usage:Vec<_>=rows.iter().map(|r|json!({"atMs":r["startedAtMs"],"tokens":r["usage"]["totalTokens"],"costUsd":model_cost(text(&r["request"],"model"),&r["usage"],r["startedAtMs"].as_u64().unwrap_or(0)as u128)})).collect();
            let mut summary = prior["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["jsonlPath"] == candidate["jsonlPath"])
                .filter(|s| s.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
            let recovered = json!({"id":candidate["id"],"startedAt":first["startedAt"],"updatedAt":last["completedAt"],"source":first["source"],"clientConversationKey":first["clientConversationKey"],"firstPrompt":first["request"]["body"]["input"].as_str().unwrap_or(""),"firstModel":first["request"]["model"],"jsonlPath":path,"traceCount":rows.len(),"totalTokens":rows.iter().filter_map(|r|r["usage"]["totalTokens"].as_u64()).sum::<u64>(),"totalDurationMs":rows.iter().filter_map(|r|r["durationMs"].as_u64()).sum::<u64>(),"usageByModel":{},"nativeUsage":native_usage});
            for (key, value) in recovered.as_object().unwrap() {
                if ["firstPrompt", "usageByModel"].contains(&key.as_str())
                    && summary.get(key).is_some()
                {
                    continue;
                }
                summary[key] = value.clone();
            }
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
        write(
            &index,
            &serde_json::to_string_pretty(&repaired).map_err(err)?,
        )?;
        self.index = repaired;
        self.read_problem = None;
        let mut result = plan;
        result["applied"] = json!(true);
        result["backupIndexPath"] = json!(backup);
        result["recoveredSessions"] = json!(recovered);
        Ok(result)
    }
    pub fn clear(&mut self) -> Result<()> {
        let ids: Vec<_> = self.index["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s["id"].as_str().map(str::to_string))
            .collect();
        for id in ids {
            self.delete(&id)?;
        }
        Ok(())
    }
    fn persist(&self) -> Result<()> {
        write(
            &self.root.join("index.json"),
            &serde_json::to_string_pretty(&self.index).map_err(err)?,
        )?;
        let _ = self.events.send("event: reset\ndata: {}\n\n".into());
        Ok(())
    }
    pub fn append(&mut self, mut record: Value, key: &str) -> Result<()> {
        if let Some(ref problem) = self.read_problem {
            return Err(problem.clone());
        }
        let id = format!("session-{}", &digest(key.as_bytes())[..24]);
        let file = self.root.join(format!("{id}.jsonl"));
        let sessions = self.index["sessions"].as_array_mut().unwrap();
        let at=sessions.iter().position(|s|s["id"]==id).unwrap_or_else(||{sessions.push(json!({"id":id,"startedAt":record["startedAt"],"updatedAt":record["completedAt"],"source":record["source"],"clientConversationKey":key,"firstPrompt":record["request"]["body"]["input"].as_str().unwrap_or(""),"firstModel":record["request"]["model"],"jsonlPath":file,"traceCount":0,"totalTokens":0,"totalDurationMs":0,"usageByModel":{},"nativeUsage":[]}));sessions.len()-1});
        let summary = &mut sessions[at];
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
        let model = text(&record["request"], "model");
        let u = &record["usage"];
        let cost = model_cost(
            model,
            u,
            record["startedAtMs"].as_u64().unwrap_or(0) as u128,
        );
        let m = &mut summary["usageByModel"][model];
        if !m.is_object() {
            *m = json!({"version":2,"input":0,"output":0,"cacheRead":0,"cacheCreation":0,"total":0,"apiType":record["request"]["apiType"]});
        }
        for (key, value) in [
            ("input", "inputUncachedTokens"),
            ("output", "outputTokens"),
            ("cacheRead", "cacheReadTokens"),
            ("cacheCreation", "cacheCreationTokens"),
            ("total", "totalTokens"),
        ] {
            m[key] = json!(m[key].as_u64().unwrap_or(0) + u[value].as_u64().unwrap_or(0));
        }
        m["incompleteFields"] = u["incompleteFields"].clone();
        summary["nativeUsage"]
            .as_array_mut()
            .unwrap()
            .push(json!({"atMs":record["startedAtMs"],"tokens":tokens,"costUsd":cost}));
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
        self.persist()?;
        if self.auto_cleanup && self.limit > 0 {
            while self.size() > self.limit && !self.index["sessions"].as_array().unwrap().is_empty()
            {
                let oldest = self.index["sessions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .min_by_key(|s| s["updatedAt"].as_str().unwrap_or(""));
                let Some(oldest) = oldest.and_then(|s| s["id"].as_str()).map(str::to_string) else {
                    break;
                };
                self.delete(&oldest)?;
            }
        }
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
}

pub(super) struct Capture {
    pub store: Store,
    pub record: Value,
    pub wire: String,
    pub key: String,
    pub raw: Vec<u8>,
    pub overflow: bool,
    pub done: bool,
}
impl Capture {
    pub fn chunk(&mut self, bytes: &[u8]) {
        if self.raw.len() + bytes.len() <= 32 * 1024 * 1024 {
            self.raw.extend_from_slice(bytes);
        } else {
            self.overflow = true;
        }
    }
    pub fn finish(mut self, value: Option<Value>) {
        self.done = true;
        self.save(value);
    }
    fn save(&mut self, value: Option<Value>) {
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
        self.record["usage"] = parsed
            .as_ref()
            .map(|v| usage(v, &self.wire))
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
        self.record["sse"] = json!({"events":raw.replace("\r\n","\n").split("\n\n").filter_map(|block|{let data=block.lines().filter_map(|l|l.strip_prefix("data:").map(str::trim_start)).collect::<Vec<_>>().join("\n");if data.is_empty(){None}else{Some(json!({"event":block.lines().find_map(|l|l.strip_prefix("event:").map(str::trim)),"data":data,"json":serde_json::from_str::<Value>(&data).ok(),"timestampMs":end}))}}).collect::<Vec<_>>()});
        if self.overflow {
            self.record["error"] = json!("记录正文超过 32 MB，已截断；网络转发保持完整");
        }
        if !self.done {
            self.record["error"] = json!("客户端断开或上游流中断，记录为未完成");
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

pub(super) async fn dashboard(State(store): State<Store>, request: Request) -> Response {
    let path = request.uri().path();
    let method = request.method();
    let host = request
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !(host.starts_with("127.0.0.1:") || host.starts_with("localhost:")) {
        return protocol_error(403, "responses", "Invalid local Host");
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
        let stream = async_stream::stream! {
            yield Ok::<_,std::convert::Infallible>(": connected\n\n".to_string());
            loop{tokio::select!{
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
    let result = (|| -> Result<(String, &str)> {
        let mut store = store.lock().map_err(err)?;
        if ["/", "/dashboard", "/index.html"].contains(&path) {
            let mut html = include_str!("../../test-results/native-assets/viewer.html").to_string();
            if std::env::args().any(|a| a == "--smoke") {
                html = html.replace(
                    "</body>",
                    &format!(
                        "<script>{}</script></body>",
                        include_str!("../../tools/native/viewer-smoke.js")
                    ),
                );
            }
            return Ok((html, "text/html; charset=utf-8"));
        }
        if path == "/api/state" {
            return Ok((store.state(store.active).to_string(), "application/json"));
        }
        if let Some(id) = path.strip_prefix("/api/session/") {
            if method == axum::http::Method::DELETE {
                return Ok((
                    json!({"ok":store.delete(id)?}).to_string(),
                    "application/json",
                ));
            }
            let pairs =
                reqwest::Url::parse(&format!("http://localhost{}", request.uri())).map_err(err)?;
            let params: BTreeMap<_, _> = pairs.query_pairs().into_owned().collect();
            let offset = params.get("offset").and_then(|v| v.parse().ok());
            let limit = params
                .get("limit")
                .and_then(|v| v.parse().ok())
                .unwrap_or(80);
            return store
                .page(id, offset, limit)?
                .map(|v| (v.to_string(), "application/json"))
                .ok_or("session not found".into());
        }
        Err("not found".into())
    })();
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
