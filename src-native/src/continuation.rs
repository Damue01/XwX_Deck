use super::*;
#[path = "codex_checkpoint.rs"]
mod codex_checkpoint;
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
fn official_input(input: Vec<Value>) -> Result<Vec<Value>> {
    let mut output = vec![];
    for mut item in input {
        if item["type"] != "reasoning" {
            output.push(item);
            continue;
        }
        // Only a seal accepted by this provider can carry opaque reasoning state.
        // An unsealed item ID is not reusable with store=false, including when
        // another Responses provider supplies summary text but no content.
        if !text(&item, "encrypted_content").is_empty() {
            item.as_object_mut().unwrap().remove("content");
            item.as_object_mut()
                .unwrap()
                .remove("internal_chat_message_metadata_passthrough");
            output.push(item);
            continue;
        }
        let mut parts = vec![];
        for part in item["summary"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(item["content"].as_array().into_iter().flatten())
        {
            let value = part["text"]
                .as_str()
                .ok_or("无法转换原服务的 reasoning 内容，请回到原服务继续")?;
            if !value.is_empty() {
                parts.push(json!({"type":"output_text","text":value}));
            }
        }
        if !parts.is_empty() {
            output.push(json!({"type":"message","role":"assistant","content":parts}));
        }
    }
    Ok(output)
}
// Responses endpoints follow the strict OpenAI input schema. Keep
// third-party visible reasoning as assistant text; never invent an opaque seal.
pub(super) fn strict_responses(body: &Value) -> Result<Value> {
    let before = items(&body["input"]);
    let input = official_input(before.clone())?;
    let mut body = body.clone();
    if input != before {
        body["input"] = json!(input);
    }
    Ok(body)
}
fn restored_prefix(current: Vec<Value>, mut recovered: Vec<Value>) -> Vec<Value> {
    let is_instruction = |item: &Value| ["system", "developer"].contains(&text(item, "role"));
    let mut instructions: Vec<_> = current.into_iter().filter(is_instruction).collect();
    if instructions.is_empty() {
        return recovered;
    }
    recovered.retain(|item| !is_instruction(item));
    instructions.extend(recovered);
    instructions
}
fn materialize(saved: &Value, home: &Path, session: &str) -> Result<Option<Vec<Value>>> {
    if saved["complete"] != false {
        return Ok(Some(items(&saved["input"])));
    }
    let hash = text(&saved["checkpoint"], "hash");
    let Some(at) = saved["checkpoint"]["at"]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
    else {
        return Ok(None);
    };
    let input = items(&saved["input"]);
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) || at > input.len() {
        return Ok(None);
    }
    let Some(recovered) =
        codex_checkpoint::read_hash(home, session, hash, true)?.and_then(|saved| saved.input)
    else {
        return Ok(None);
    };
    let mut restored = restored_prefix(input[..at].to_vec(), recovered);
    restored.extend_from_slice(&input[at..]);
    Ok(Some(restored))
}

// Persist a position and digest for unresolved compaction, not its ciphertext.
// This lets an exact previous_response_id recover after a restart as well.
fn checkpoint_reference(input: &Value) -> Result<Option<Value>> {
    let mut reference = None;
    let mut at = 0;
    for item in items(input) {
        let (portable, complete) = portable(&json!([item]))?;
        if !complete {
            reference = Some(
                json!({"hash":storage::digest(text(&item,"encrypted_content").as_bytes()),"at":at}),
            );
        }
        at += portable.len();
    }
    Ok(reference)
}
pub(super) fn expand(
    root: &Path,
    codex_home: &Path,
    provider: &Provider,
    session: &str,
    body: &Value,
    required: bool,
) -> Result<Value> {
    let mut body = body.clone();
    let dir = directory(root, provider, session);
    let origin = owner(provider);
    let (ledger, cached) = {
        let _lock = CACHE_LOCK.lock().map_err(err)?;
        let ledger = load(&dir.join("owners.json"))?.unwrap_or_else(|| json!({}));
        let cached = if let Some(previous) = body["previous_response_id"]
            .as_str()
            .filter(|s| !s.is_empty())
        {
            let name = format!("{}.json", storage::digest(previous.as_bytes()));
            load(&dir.join(&name))?.or(load(&legacy(root, provider, session).join(&name))?)
        } else {
            None
        };
        (ledger, cached)
    };
    if body["previous_response_id"]
        .as_str()
        .is_some_and(|s| !s.is_empty())
    {
        if let Some(stored) = cached {
            // Native state is valid in its original service/account/model. A
            // portable cache is needed only when crossing that state boundary.
            let native = !required && stored["owner"] == origin && stored["model"] == body["model"];
            if !native {
                let mut input = materialize(&stored, codex_home, session)?.ok_or(
                    "缺少可恢复的压缩上下文，请回到原服务生成明文摘要或重新发送完整上下文",
                )?;
                input.extend(items(&body["input"]));
                body["input"] = json!(input);
                if body["instructions"].is_null() && !stored["instructions"].is_null() {
                    body["instructions"] = stored["instructions"].clone();
                }
                body.as_object_mut()
                    .ok_or("无效请求")?
                    .remove("previous_response_id");
            }
        } else if required {
            return Err("previous_response_id 上下文不存在或已过期，请重新发送完整上下文".into());
        }
    }
    // History scans may be large. They must not block cache access by unrelated
    // sessions, nor run on the async transport's executor thread (prepare below).
    let mut native_provenance = None;
    let before_input = items(&body["input"]);
    let mut input = vec![];
    for mut item in items(&body["input"]) {
        if let Some(checkpoint) = checkpoint(&item)? {
            input.push(checkpoint);
            continue;
        }
        let item_owner = &ledger["items"][text(&item, "id")]["owner"];
        if item_owner.as_str().is_some_and(|o| o != origin) {
            if let Some(object) = item.as_object_mut() {
                object.remove("id");
            }
        }
        let seal = text(&item, "encrypted_content");
        if !seal.is_empty() {
            let hash = storage::digest(seal.as_bytes());
            let entry = &ledger["seals"][&hash];
            let native_foreign = if entry.is_null() {
                if native_provenance.is_none() {
                    native_provenance = Some(codex_checkpoint::read_thread(
                        codex_home, session, seal, false,
                    )?);
                }
                native_provenance
                    .as_ref()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|saved| {
                        if provider.official || provider.oauth {
                            !["openai", "xwx_deck"].contains(&saved.provider.as_str())
                        } else {
                            ![
                                provider.id.as_str(),
                                provider.codex_provider_id.as_str(),
                                "xwx_deck",
                            ]
                            .contains(&saved.provider.as_str())
                        }
                    })
            } else {
                false
            };
            let foreign = native_foreign
                || entry["owner"].as_str().is_some_and(|o| o != origin)
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
                    if let Some(saved) = cached
                        .as_ref()
                        .map(|saved| materialize(saved, codex_home, session))
                        .transpose()?
                        .flatten()
                    {
                        input = restored_prefix(input, saved);
                    } else {
                        let recovered = codex_checkpoint::read_thread(
                            codex_home, session, seal, true,
                        )?
                        .and_then(|saved| saved.input)
                        .ok_or(
                            "无法恢复原服务的加密压缩上下文，请回到原服务继续或发送完整上下文",
                        )?;
                        // The exact checkpoint includes the retained precompact
                        // messages already before this item. Replace that prefix
                        // rather than duplicating tool calls or old instructions.
                        input = restored_prefix(input, recovered);
                    }
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
    if provider.official || provider.oauth {
        input = official_input(input)?;
    }
    if input != before_input {
        body["input"] = json!(input);
    }
    Ok(body)
}

pub(super) async fn prepare(
    root: &Path,
    codex_home: &Path,
    provider: &Provider,
    session: &str,
    body: &Value,
    required: bool,
) -> Result<Value> {
    let (root, home, provider, session, body) = (
        root.to_path_buf(),
        codex_home.to_path_buf(),
        provider.clone(),
        session.to_string(),
        body.clone(),
    );
    tokio::task::spawn_blocking(move || expand(&root, &home, &provider, &session, &body, required))
        .await
        .map_err(err)?
}
// A long-lived client retains its launch model. Only follow Deck's explicitly
// chosen default when this native session previously used that default. An
// client model that differs from the recorded launch default is retained.
pub(super) fn selected_model(
    root: &Path,
    provider: &Provider,
    session: &str,
    model: &str,
) -> Result<String> {
    if session.is_empty() || provider.codex_model.is_empty() {
        return Ok(model.into());
    }
    let _lock = CACHE_LOCK.lock().map_err(err)?;
    let ledger =
        load(&directory(root, provider, session).join("owners.json"))?.unwrap_or(Value::Null);
    Ok(
        if ledger["usesDefaultModel"] == true && ledger["clientModel"] == model {
            provider.codex_model.clone()
        } else {
            model.into()
        },
    )
}

pub(super) fn save(
    root: &Path,
    provider: &Provider,
    session: &str,
    body: &Value,
    response: &Value,
    client_model: &str,
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
    let (mut input, mut complete) = portable(&body["input"])?;
    let mut checkpoint = checkpoint_reference(&body["input"])?;
    let mut instructions = body["instructions"].clone();
    if let Some(previous) = body["previous_response_id"]
        .as_str()
        .filter(|id| !id.is_empty())
    {
        let previous = storage::digest(previous.as_bytes());
        if let Some(saved) = load(&dir.join(format!("{previous}.json")))? {
            let mut prefix = items(&saved["input"]);
            if let Some(ref mut reference) = checkpoint {
                reference["at"] =
                    json!(reference["at"].as_u64().unwrap_or(0) + prefix.len() as u64);
            } else if saved["complete"] == false {
                checkpoint = saved.get("checkpoint").cloned();
            }
            prefix.extend(input);
            input = prefix;
            complete &= saved["complete"] != false;
            if instructions.is_null() {
                instructions = saved["instructions"].clone();
            }
        } else {
            // An unknown native response can still continue on its own upstream,
            // but its unseen prefix must not be advertised as portable history.
            complete = false;
        }
    }
    let (output, _) = portable(&response["output"])?;
    input.extend(output);
    let name = storage::digest(id.as_bytes());
    let origin = owner(provider);
    let source=json!({"at":millis() as u64,"owner":origin,"model":body["model"],"complete":complete,"checkpoint":checkpoint,"instructions":instructions,"input":input}).to_string();
    if source.len() > 16 * 1024 * 1024 {
        return Err("续接上下文超过 16 MB 上限".into());
    }
    write(&dir.join(format!("{name}.json")), &source)?;
    let mut ledger = load(&dir.join("owners.json"))?.unwrap_or_else(|| json!({"seals":{}}));
    let uses_default = if ledger["clientModel"] == client_model {
        ledger["usesDefaultModel"] == true
    } else {
        !client_model.is_empty() && client_model == provider.codex_model
    };
    ledger["clientModel"] = json!(client_model);
    ledger["usesDefaultModel"] = json!(uses_default);
    ledger["owner"] = json!(origin);
    ledger["at"] = json!(millis() as u64);
    ledger["latestResponse"] = json!(name);
    if items(&response["output"])
        .iter()
        .any(|item| ["compaction", "compaction_summary"].contains(&text(item, "type")))
    {
        ledger["compactSource"] = json!(name);
    }
    if !ledger["items"].is_object() {
        ledger["items"] = json!({});
    }
    for item in items(&response["output"]) {
        let id = text(&item, "id");
        if !id.is_empty() {
            ledger["items"][id] = json!({"owner":origin});
        }
        let seal = text(&item, "encrypted_content");
        if seal.is_empty() {
            continue;
        }
        ledger["seals"][storage::digest(seal.as_bytes())] = json!({"owner":origin,"source":name});
    }
    if ledger["seals"].as_object().is_some_and(|s| s.len() > 2048)
        || ledger["items"].as_object().is_some_and(|s| s.len() > 8192)
    {
        return Err("会话不透明状态记录超过上限，已保留历史".into());
    }
    write(&dir.join("owners.json"), &ledger.to_string())?;
    let mut entries = vec![];
    let mut retained = std::collections::HashSet::new();
    for folder in fs::read_dir(root.join("continuations")).map_err(err)? {
        let folder = folder.map_err(err)?;
        if !folder.file_type().map_err(err)?.is_dir() {
            continue;
        }
        // The latest exact response and compact source are recoverable session
        // state. Evict older snapshots, not the active checkpoint or provenance.
        let owners = folder.path().join("owners.json");
        if let Ok(Some(ledger)) = load(&owners) {
            retained.insert(owners);
            for key in ["latestResponse", "compactSource"] {
                let name = text(&ledger, key);
                if name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit()) {
                    retained.insert(folder.path().join(format!("{name}.json")));
                }
            }
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
        if retained.contains(&path) {
            continue;
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_responses_preserves_foreign_text_tool_order_and_original_request() {
        let original = json!({"model":"fixture", "input":[
            {"type":"reasoning","id":"foreign","summary":[],"content":[{"type":"reasoning_text","text":"provider supplied text"}]},
            {"type":"function_call","call_id":"kept","name":"read","arguments":"{}"},
            {"type":"function_call_output","call_id":"kept","output":"tool result"}
        ]});
        let converted = strict_responses(&original).unwrap();
        assert_eq!(original["input"][0]["type"], "reasoning");
        assert_eq!(
            converted["input"][0],
            json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"provider supplied text"}]})
        );
        assert_eq!(
            converted["input"].as_array().unwrap()[1..],
            original["input"].as_array().unwrap()[1..]
        );
        assert_eq!(converted["model"], original["model"]);
    }
    #[test]
    fn official_input_retains_provider_text_and_tool_order() {
        let source = vec![
            json!({"type":"reasoning","summary":[],"content":[{"type":"reasoning_text","text":"supplied thought"}],"internal_chat_message_metadata_passthrough":{}}),
            json!({"type":"function_call","call_id":"fixture","name":"read","arguments":"{}"}),
            json!({"type":"function_call_output","call_id":"fixture","output":"fixture result"}),
        ];
        let converted = official_input(source.clone()).unwrap();
        assert_eq!(
            converted[0],
            json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"supplied thought"}]})
        );
        assert_eq!(converted[1..], source[1..]);
        assert_eq!(source[0]["type"], "reasoning");
        assert!(official_input(vec![
            json!({"type":"reasoning","content":[{"type":"unknown"}]})
        ])
        .is_err());
    }
    #[test]
    fn official_input_converts_summary_only_and_drops_empty_unsealed_ids() {
        let converted = official_input(vec![
            json!({"id":"foreign-summary","type":"reasoning","summary":[{"type":"summary_text","text":"supplied summary"}],"content":[],"encrypted_content":null}),
            json!({"id":"foreign-empty","type":"reasoning","summary":[],"content":[]}),
            json!({"type":"function_call","call_id":"call_kept","name":"read","arguments":"{}"}),
        ]).unwrap();
        assert_eq!(converted.len(), 2);
        assert_eq!(
            converted[0],
            json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"supplied summary"}]})
        );
        assert_eq!(converted[1]["call_id"], "call_kept");
    }
    #[test]
    fn official_input_keeps_opaque_state_without_inventing_one() {
        let converted=official_input(vec![json!({"id":"rs_fixture","type":"reasoning","summary":[],"encrypted_content":"owned-seal","content":[{"type":"reasoning_text","text":"supplied thought"}]})]).unwrap();
        assert_eq!(converted[0]["encrypted_content"], "owned-seal");
        assert_eq!(converted[0]["id"], "rs_fixture");
        assert!(converted[0].get("content").is_none());
    }
}
