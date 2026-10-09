use super::*;
const MAX_BYTES: u64 = 64 * 1024 * 1024;
static CACHE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn items(v: &Value) -> Vec<Value> {
    match v {
        Value::Array(a) => a.clone(),
        Value::String(s) => vec![json!({"role":"user","content":s})],
        Value::Object(_) => vec![v.clone()],
        _ => vec![],
    }
}
fn owner(provider: &Provider) -> String {
    let identity = if provider.subscription_account_id.is_empty() {
        &provider.bearer_token
    } else {
        &provider.subscription_account_id
    };
    storage::digest(
        format!(
            "{}\n{}\n{}\n{}",
            provider.id, provider.base_url, provider.adapter, identity
        )
        .as_bytes(),
    )
}
fn directory(root: &Path, provider: &Provider, session: &str) -> PathBuf {
    let scope = if session.is_empty() {
        format!("unscoped:{}", provider.id)
    } else {
        format!("session:{session}")
    };
    root.join("continuations")
        .join(&storage::digest(scope.as_bytes())[..32])
}
fn legacy(root: &Path, provider: &Provider, session: &str) -> PathBuf {
    root.join("continuations").join(
        &storage::digest(
            format!(
                "{}\n{}\n{}\n{}\n{}",
                provider.id, provider.base_url, provider.adapter, provider.bearer_token, session
            )
            .as_bytes(),
        )[..32],
    )
}
fn load(path: &Path) -> Result<Option<Value>> {
    read(path)?
        .map(|s| serde_json::from_str(&s).map_err(|_| "续接上下文损坏".into()))
        .transpose()
}
fn checkpoint(item: &Value) -> Result<Option<Value>> {
    use base64::Engine;
    let Some(encoded) = text(item, "encrypted_content").strip_prefix("xwxc1:") else {
        return Ok(None);
    };
    let text = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()
        .and_then(|s| String::from_utf8(s).ok())
        .filter(|s| !s.trim().is_empty())
        .ok_or("本地压缩摘要损坏，原上下文已保留")?;
    Ok(Some(
        json!({"role":"user","content":format!("Continue from this context checkpoint without repeating completed work:\n{text}")}),
    ))
}
fn portable(input: &Value) -> Result<(Vec<Value>, bool)> {
    let mut out = vec![];
    let mut complete = true;
    for mut item in items(input) {
        if let Some(checkpoint) = checkpoint(&item)? {
            out.push(checkpoint);
            continue;
        }
        if ["compaction", "compaction_summary"].contains(&text(&item, "type"))
            && !text(&item, "encrypted_content").is_empty()
        {
            complete = false;
            continue;
        }
        if let Some(object) = item.as_object_mut() {
            object.remove("encrypted_content");
        }
        if item["type"] == "reasoning"
            && item["content"].as_array().is_none_or(|a| a.is_empty())
            && item["summary"].as_array().is_none_or(|a| a.is_empty())
        {
            continue;
        }
        out.push(item);
    }
    Ok((out, complete))
}
pub(super) fn expand(
    root: &Path,
    provider: &Provider,
    session: &str,
    body: &Value,
    required: bool,
) -> Result<Value> {
    let _lock = CACHE_LOCK.lock().map_err(err)?;
    let mut body = body.clone();
    let dir = directory(root, provider, session);
    let origin = owner(provider);
    if let Some(previous) = body["previous_response_id"]
        .as_str()
        .filter(|s| !s.is_empty())
    {
        let name = format!("{}.json", storage::digest(previous.as_bytes()));
        let cached =
            load(&dir.join(&name))?.or(load(&legacy(root, provider, session).join(&name))?);
        if let Some(stored) = cached {
            if millis().saturating_sub(stored["at"].as_u64().unwrap_or(0) as u128) > 86_400_000 {
                return Err("续接上下文已过期，请重新发送完整上下文".into());
            }
            if stored["complete"] == false {
                return Err("缺少可恢复的压缩上下文，请回到原服务继续或重新发送完整上下文".into());
            }
            let mut input = items(&stored["input"]);
            input.extend(items(&body["input"]));
            body["input"] = json!(input);
            if body["instructions"].is_null() && !stored["instructions"].is_null() {
                body["instructions"] = stored["instructions"].clone();
            }
            body.as_object_mut()
                .ok_or("无效请求")?
                .remove("previous_response_id");
        } else if required {
            return Err("previous_response_id 上下文不存在或已过期，请重新发送完整上下文".into());
        }
    }
    let ledger = load(&dir.join("owners.json"))?.unwrap_or_else(|| json!({}));
    let before_input = items(&body["input"]);
    let mut input = vec![];
    for mut item in items(&body["input"]) {
        if let Some(checkpoint) = checkpoint(&item)? {
            input.push(checkpoint);
            continue;
        }
        let seal = text(&item, "encrypted_content");
        if !seal.is_empty() {
            let hash = storage::digest(seal.as_bytes());
            let entry = &ledger["seals"][&hash];
            let foreign = entry["owner"].as_str().is_some_and(|o| o != origin)
                || (entry.is_null() && ledger["owner"].as_str().is_some_and(|o| o != origin));
            if foreign {
                if ["compaction", "compaction_summary"].contains(&text(&item, "type")) {
                    let source = text(entry, "source");
                    let cached =
                        if source.len() == 64 && source.bytes().all(|b| b.is_ascii_hexdigit()) {
                            load(&dir.join(format!("{source}.json")))?
                        } else {
                            None
                        };
                    let saved = cached.filter(|c| c["complete"] != false).ok_or(
                        "无法恢复原服务的加密压缩上下文，请回到原服务继续或发送完整上下文",
                    )?;
                    input.extend(items(&saved["input"]));
                    continue;
                }
                if let Some(object) = item.as_object_mut() {
                    object.remove("encrypted_content");
                    object.remove("id");
                }
                if item["type"] == "reasoning"
                    && item["content"].as_array().is_none_or(|a| a.is_empty())
                    && item["summary"].as_array().is_none_or(|a| a.is_empty())
                {
                    continue;
                }
            }
        }
        input.push(item);
    }
    if input != before_input {
        body["input"] = json!(input);
    }
    Ok(body)
}
pub(super) fn save(
    root: &Path,
    provider: &Provider,
    session: &str,
    body: &Value,
    response: &Value,
) -> Result<()> {
    let id = text(response, "id");
    if id.is_empty()
        || (response["status"] != "completed" && response["object"] != "response.compaction")
    {
        return Ok(());
    }
    let _lock = CACHE_LOCK.lock().map_err(err)?;
    let dir = directory(root, provider, session);
    fs::create_dir_all(&dir).map_err(err)?;
    let (mut input, complete) = portable(&body["input"])?;
    let (output, _) = portable(&response["output"])?;
    input.extend(output);
    let name = storage::digest(id.as_bytes());
    let origin = owner(provider);
    let source=json!({"at":millis() as u64,"owner":origin,"complete":complete,"instructions":body["instructions"],"input":input}).to_string();
    if source.len() > 16 * 1024 * 1024 {
        return Err("续接上下文超过 16 MB 上限".into());
    }
    write(&dir.join(format!("{name}.json")), &source)?;
    let mut ledger = load(&dir.join("owners.json"))?.unwrap_or_else(|| json!({"seals":{}}));
    ledger["owner"] = json!(origin);
    ledger["at"] = json!(millis() as u64);
    for item in items(&response["output"]) {
        let seal = text(&item, "encrypted_content");
        if seal.is_empty() {
            continue;
        }
        ledger["seals"][storage::digest(seal.as_bytes())] = json!({"owner":origin,"source":name});
    }
    if ledger["seals"].as_object().is_some_and(|s| s.len() > 2048) {
        return Err("会话不透明状态记录超过上限，已保留历史".into());
    }
    write(&dir.join("owners.json"), &ledger.to_string())?;
    let mut entries = vec![];
    for folder in fs::read_dir(root.join("continuations")).map_err(err)? {
        let folder = folder.map_err(err)?;
        if !folder.file_type().map_err(err)?.is_dir() {
            continue;
        }
        for file in fs::read_dir(folder.path()).map_err(err)? {
            let file = file.map_err(err)?;
            let meta = fs::symlink_metadata(file.path()).map_err(err)?;
            if meta.is_file() && !meta.file_type().is_symlink() {
                entries.push((meta.modified().map_err(err)?, meta.len(), file.path()));
            }
        }
    }
    entries.sort_by_key(|x| x.0);
    let mut size: u64 = entries.iter().map(|e| e.1).sum();
    let mut count = entries.len();
    for (at, len, path) in entries {
        if size > MAX_BYTES
            || count > 512
            || SystemTime::now().duration_since(at).unwrap_or_default() > Duration::from_secs(86400)
        {
            fs::remove_file(path).map_err(err)?;
            size = size.saturating_sub(len);
            count = count.saturating_sub(1);
        }
    }
    Ok(())
}
