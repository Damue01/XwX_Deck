//! Protect the gap between delivered tool calls and an accepted tool-result turn.
//! Only digests live in the shared ledger; client bodies stay in the existing evidence path.
use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Default)]
pub(super) struct Pending {
    groups: BTreeMap<u64, Group>,
    overflow: bool,
}
#[derive(Clone)]
struct Group {
    scope: String,
    owner: String,
    scoped: bool,
    prefix: String,
    length: usize,
    calls: Vec<Call>,
    uncertain: bool,
}
#[derive(Clone)]
struct Call {
    id: String,
    digest: String,
}
struct Proof {
    prefixes: Vec<String>,
    calls: Vec<(usize, Call)>,
    results: Vec<(usize, String)>,
    complete: bool,
}
pub(super) struct Observer {
    activity: Arc<request_activity::Activity>,
    token: u64,
    group: Group,
    proof: Proof,
    wire: String,
    sse: bool,
    event: Vec<u8>,
    scan: usize,
    partial: bool,
    finished: bool,
    gemini_calls: Vec<Value>,
    opaque: bool,
}
fn canonical_call(item: &Value) -> Option<Value> {
    let kind = text(item, "type");
    if !["function_call", "custom_tool_call"].contains(&kind)
        || text(item, "call_id").is_empty()
        || text(item, "name").is_empty()
    {
        return None;
    }
    let args = if kind == "function_call" {
        let args = serde_json::from_str::<Value>(text(item, "arguments")).ok()?;
        if !args.is_object() {
            return None;
        }
        args
    } else {
        item.get("input")?.clone()
    };
    Some(
        json!({"type":kind,"call_id":item["call_id"],"name":item["name"],"namespace":item["namespace"],"arguments":args}),
    )
}
fn canonical_input(input: &Value) -> Vec<Value> {
    let list = match input {
        Value::Array(a) => a.clone(),
        Value::String(s) => vec![json!({"role":"user","content":s})],
        Value::Object(_) => vec![input.clone()],
        _ => vec![],
    };
    list.into_iter()
        .filter_map(|item| {
            if item["type"] == "reasoning" {
                return None;
            }
            if let Some(call) = canonical_call(&item) {
                return Some(call);
            }
            if item["role"].is_string() {
                let content = if let Some(s) = item["content"].as_str() {
                    json!([{"type":"text","text":s}])
                } else {
                    json!(item["content"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|p| {
                            if ["input_text", "output_text", "text"].contains(&text(p, "type")) {
                                json!({"type":"text","text":p["text"]})
                            } else {
                                p.clone()
                            }
                        })
                        .collect::<Vec<_>>())
                };
                Some(json!({"role":item["role"],"content":content}))
            } else {
                let mut item = item;
                if let Some(map) = item.as_object_mut() {
                    map.remove("id");
                    map.remove("status");
                }
                Some(item)
            }
        })
        .collect()
}
fn proof(input: &Value) -> Proof {
    let input = canonical_input(input);
    let mut hash = Sha256::new();
    let mut prefixes = vec![format!("{:x}", hash.clone().finalize())];
    let mut calls = vec![];
    let mut results = vec![];
    if input.len() > 8192 {
        return Proof {
            prefixes,
            calls,
            results,
            complete: false,
        };
    }
    for (position, item) in input.iter().enumerate() {
        let source = item.to_string();
        hash.update((source.len() as u64).to_be_bytes());
        hash.update(source.as_bytes());
        prefixes.push(format!("{:x}", hash.clone().finalize()));
        if ["function_call", "custom_tool_call"].contains(&text(item, "type")) {
            calls.push((
                position,
                Call {
                    id: text(item, "call_id").into(),
                    digest: storage::digest(source.as_bytes()),
                },
            ));
        } else if ["function_call_output", "custom_tool_call_output"].contains(&text(item, "type"))
            && item.get("output").is_some()
        {
            results.push((position, text(item, "call_id").into()));
        }
    }
    Proof {
        prefixes,
        calls,
        results,
        complete: true,
    }
}
impl Pending {
    pub fn count(&self) -> usize {
        self.groups
            .values()
            .map(|g| if g.uncertain { 1 } else { g.calls.len() })
            .sum::<usize>()
            + usize::from(self.overflow)
    }
    fn start(&mut self, token: u64, group: &Group) {
        if self.groups.len() >= 1024 && !self.groups.contains_key(&token) {
            self.overflow = true;
            return;
        }
        let mut group = group.clone();
        group.uncertain = true;
        self.groups.insert(token, group);
    }
    fn complete(
        &mut self,
        token: u64,
        current: &Group,
        input: &Proof,
        calls: Vec<Call>,
        partial: bool,
    ) {
        // A bare result ID, stale history, a foreign conversation or changed arguments
        // cannot discharge a tool wait. Cross-provider continuation needs full lineage.
        let mut input_calls = BTreeMap::<&str, Vec<(usize, &str)>>::new();
        for (position, call) in &input.calls {
            input_calls
                .entry(&call.id)
                .or_default()
                .push((*position, &call.digest));
        }
        let mut result_positions = BTreeMap::<&str, usize>::new();
        for (position, id) in &input.results {
            result_positions
                .entry(id)
                .and_modify(|at| *at = (*at).max(*position))
                .or_insert(*position);
        }
        let matches = |group: &Group, call: &Call| {
            if group.scope != current.scope
                || !(group.owner == current.owner || (group.scoped && current.scoped))
                || input.prefixes.get(group.length) != Some(&group.prefix)
            {
                return false;
            }
            let Some(positions) = input_calls.get(call.id.as_str()) else {
                return false;
            };
            let tail = &positions[positions.partition_point(|(at, _)| *at < group.length)..];
            tail.len() == 1
                && tail[0].1 == call.digest
                && result_positions
                    .get(call.id.as_str())
                    .is_some_and(|at| *at > tail[0].0)
        };
        let mut candidates = vec![];
        let mut occurrences = BTreeMap::<String, usize>::new();
        for (&key, group) in &self.groups {
            if key == token || group.uncertain {
                continue;
            }
            for call in &group.calls {
                if matches(group, call) {
                    *occurrences.entry(call.digest.clone()).or_default() += 1;
                    candidates.push((key, call.digest.clone()));
                }
            }
        }
        let accepted = candidates
            .into_iter()
            .filter(|(_, digest)| occurrences.get(digest) == Some(&1));
        for (key, digest) in accepted {
            if let Some(group) = self.groups.get_mut(&key) {
                group.calls.retain(|c| c.digest != digest);
            }
        }
        self.groups
            .retain(|_, g| g.uncertain || !g.calls.is_empty());
        // A purported terminal frame omitting previously emitted calls is not proof
        // that the client never saw a tool. Retain the explicit force-stop path.
        if partial && calls.is_empty() {
            self.start(token, current);
            return;
        }
        self.groups.remove(&token);
        if !calls.is_empty() {
            if self.groups.len() >= 1024 || calls.len() > 256 || self.count() + calls.len() > 4096 {
                self.overflow = true;
                return;
            }
            let mut group = current.clone();
            group.calls = calls;
            group.uncertain = false;
            self.groups.insert(token, group);
        }
    }
}
impl Observer {
    pub fn new(
        activity: Arc<request_activity::Activity>,
        token: u64,
        provider: &Provider,
        client: &str,
        session: &str,
        input: &Value,
        wire: &str,
    ) -> Self {
        let proof = proof(input);
        let identity = if provider.subscription_account_id.is_empty() {
            &provider.bearer_token
        } else {
            &provider.subscription_account_id
        };
        let group = Group {
            scope: storage::digest(format!("{client}\n{session}").as_bytes()),
            owner: storage::digest(
                format!(
                    "{}\n{}\n{}\n{}",
                    provider.id, provider.base_url, provider.adapter, identity
                )
                .as_bytes(),
            ),
            scoped: !session.is_empty(),
            prefix: proof.prefixes.last().unwrap().clone(),
            length: proof.prefixes.len() - 1,
            calls: vec![],
            uncertain: false,
        };
        let opaque = input.is_null() || !proof.complete;
        Self {
            activity,
            token,
            group,
            proof,
            wire: wire.into(),
            sse: false,
            event: vec![],
            scan: 0,
            partial: false,
            finished: false,
            gemini_calls: vec![],
            opaque,
        }
    }
    pub fn transport(&mut self, sse: bool) {
        self.sse = sse;
    }
    fn partial(&mut self) {
        if !self.partial {
            self.partial = true;
            self.activity.tools(|p| p.start(self.token, &self.group));
        }
    }
    fn complete(&mut self, value: &Value) {
        if self.finished {
            return;
        }
        let normalized = match self.wire.as_str() {
            "responses" if value["status"] == "completed" => value.clone(),
            "anthropic-messages"
                if protocol::validate_response(value, "anthropic-messages").is_ok()
                    && value["stop_reason"] != "max_tokens" =>
            {
                protocol::messages_response(value, &protocol::ToolContext::default())
            }
            "chat-completions"
                if protocol::validate_response(value, "chat-completions").is_ok()
                    && !["length", "content_filter"]
                        .contains(&text(&value["choices"][0], "finish_reason")) =>
            {
                protocol::chat_response(value, &protocol::ToolContext::default())
            }
            "gemini"
                if ["STOP", "stop"].contains(&text(&value["candidates"][0], "finishReason")) =>
            {
                let mut calls = self.gemini_calls.clone();
                for part in value["candidates"][0]["content"]["parts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    if part["functionCall"].is_object() {
                        calls.push(part["functionCall"].clone());
                    }
                }
                json!({"output":calls.iter().map(|c|json!({"type":"function_call","call_id":c["id"],"name":c["name"],"arguments":c["args"].to_string()})).collect::<Vec<_>>()})
            }
            _ => return,
        };
        let output = normalized["output"].as_array().cloned().unwrap_or_default();
        let mut calls = vec![];
        for item in &output {
            if ["function_call", "custom_tool_call"].contains(&text(item, "type")) {
                let Some(call) = canonical_call(item) else {
                    self.partial();
                    return;
                };
                calls.push(Call {
                    id: text(&call, "call_id").into(),
                    digest: storage::digest(call.to_string().as_bytes()),
                });
            }
        }
        if self.opaque && (!calls.is_empty() || self.partial) {
            self.partial();
            self.finished = true;
            return;
        }
        self.activity
            .tools(|p| p.complete(self.token, &self.group, &self.proof, calls, self.partial));
        self.finished = true;
    }
    /// Called before the final body frame releases the HTTP admission lease.
    pub fn chunk(&mut self, bytes: &[u8], raw: &[u8], overflow: bool) {
        if self.finished {
            return;
        }
        if overflow {
            self.partial();
            return;
        }
        if !self.sse {
            return;
        }
        self.event.extend_from_slice(bytes);
        while self.scan < self.event.len() {
            self.scan += 1;
            let end = self.scan;
            if !self.event[..end].ends_with(b"\n\n") && !self.event[..end].ends_with(b"\r\n\r\n") {
                continue;
            }
            let block = String::from_utf8_lossy(&self.event[..end]);
            let data = block
                .lines()
                .filter_map(|l| l.strip_prefix("data:").map(str::trim_start))
                .collect::<Vec<_>>()
                .join("\n");
            let value = serde_json::from_str::<Value>(&data).ok();
            self.event.drain(..end);
            self.scan = 0;
            if let Some(v) = value {
                self.event(&v, raw);
            }
            if self.finished {
                self.event.clear();
                break;
            }
        }
    }
    pub fn finish(&mut self, raw: &[u8], overflow: bool) {
        if self.finished || self.sse {
            return;
        }
        if overflow {
            self.partial();
            return;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(raw) {
            let tools = value["output"].as_array().is_some_and(|a| {
                a.iter()
                    .any(|v| ["function_call", "custom_tool_call"].contains(&text(v, "type")))
            }) || value["content"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v["type"] == "tool_use"))
                || value["choices"][0]["message"]["tool_calls"]
                    .as_array()
                    .is_some_and(|a| !a.is_empty())
                || value["candidates"][0]["content"]["parts"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v["functionCall"].is_object()));
            if tools {
                self.partial();
            }
            self.complete(&value);
        }
    }
    pub fn event(&mut self, value: &Value, raw: &[u8]) {
        if self.finished {
            return;
        }
        let kind = text(value, "type");
        let tool = (["response.output_item.added", "response.output_item.done"].contains(&kind)
            && ["function_call", "custom_tool_call"].contains(&text(&value["item"], "type")))
            || (kind == "content_block_start" && value["content_block"]["type"] == "tool_use")
            || value["choices"][0]["delta"]["tool_calls"]
                .as_array()
                .is_some_and(|a| !a.is_empty());
        if tool
            || [
                "response.function_call_arguments.delta",
                "response.custom_tool_call_input.delta",
            ]
            .contains(&kind)
            || (kind == "content_block_delta" && value["delta"]["type"] == "input_json_delta")
            || value["response"]["output"].as_array().is_some_and(|a| {
                a.iter()
                    .any(|v| ["function_call", "custom_tool_call"].contains(&text(v, "type")))
            })
        {
            self.partial();
        }
        if self.wire == "gemini" {
            for part in value["candidates"][0]["content"]["parts"]
                .as_array()
                .into_iter()
                .flatten()
            {
                if part["functionCall"].is_object() {
                    self.partial();
                    self.gemini_calls.push(part["functionCall"].clone());
                }
            }
            // Calls from this frame were already accumulated.
            let mut terminal = value.clone();
            let Some(candidate) = terminal
                .get_mut("candidates")
                .and_then(Value::as_array_mut)
                .and_then(|a| a.first_mut())
                .and_then(Value::as_object_mut)
            else {
                return;
            };
            candidate.remove("content");
            self.complete(&terminal);
        } else if self.wire == "responses" && kind == "response.completed" {
            if raw.is_empty() {
                self.complete(&value["response"]);
            } else if let Ok(response) =
                protocol::collapse_sse(&String::from_utf8_lossy(raw), "responses", "")
            {
                self.complete(&response);
            }
        } else if (self.wire == "anthropic-messages" && kind == "message_stop")
            || (self.wire == "chat-completions" && !value["choices"][0]["finish_reason"].is_null())
        {
            if let Ok(v) = protocol::collapse_sse(&String::from_utf8_lossy(raw), &self.wire, "") {
                self.complete(&v);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn call(args: &str) -> Value {
        json!({"type":"function_call","call_id":"same-id","name":"lookup","arguments":args})
    }
    fn group(input: &Value) -> Group {
        let p = proof(input);
        Group {
            scope: "session-a".into(),
            owner: "provider-a".into(),
            scoped: true,
            prefix: p.prefixes.last().unwrap().clone(),
            length: p.prefixes.len() - 1,
            calls: vec![],
            uncertain: false,
        }
    }
    fn calls(item: Value) -> Vec<Call> {
        let c = canonical_call(&item).unwrap();
        vec![Call {
            id: text(&c, "call_id").into(),
            digest: storage::digest(c.to_string().as_bytes()),
        }]
    }
    #[test]
    fn result_requires_context_arguments_and_conversation() {
        let input = json!([{"role":"user","content":"task"}]);
        let g = group(&input);
        let mut pending = Pending::default();
        pending.complete(1, &g, &proof(&input), calls(call("{\"q\":1}")), false);
        for body in [
            json!([{"type":"function_call_output","call_id":"same-id","output":"done"}]),
            json!([{"role":"user","content":"other"},call("{\"q\":1}"),{"type":"function_call_output","call_id":"same-id","output":"done"}]),
            json!([{"role":"user","content":"task"},call("{\"q\":2}"),{"type":"function_call_output","call_id":"same-id","output":"done"}]),
        ] {
            pending.complete(2, &group(&body), &proof(&body), vec![], false);
            assert_eq!(pending.count(), 1);
        }
        let body = json!([{"role":"user","content":"task"},call("{\"q\":1}"),{"type":"function_call_output","call_id":"same-id","output":"done"}]);
        let mut foreign = group(&body);
        foreign.scope = "other-session".into();
        pending.complete(2, &foreign, &proof(&body), vec![], false);
        assert_eq!(pending.count(), 1);
        let mut handoff = group(&body);
        handoff.owner = "provider-b".into();
        pending.complete(2, &handoff, &proof(&body), vec![], false);
        assert_eq!(pending.count(), 0);
    }
    #[test]
    fn repeated_history_and_concurrent_identical_calls_are_ambiguous() {
        let input = json!([{"role":"user","content":"task"}]);
        let g = group(&input);
        let mut pending = Pending::default();
        for token in [1, 2] {
            pending.complete(token, &g, &proof(&input), calls(call("{}")), false);
        }
        let body = json!([{"role":"user","content":"task"},call("{}"),{"type":"function_call_output","call_id":"same-id","output":"done"}]);
        pending.complete(3, &group(&body), &proof(&body), vec![], false);
        assert_eq!(pending.count(), 2);
        let mut pending = Pending::default();
        pending.complete(1, &g, &proof(&input), calls(call("{}")), false);
        let repeated = json!([{"role":"user","content":"task"},call("{}"),call("{}"),{"type":"function_call_output","call_id":"same-id","output":"done"}]);
        pending.complete(3, &group(&repeated), &proof(&repeated), vec![], false);
        assert_eq!(pending.count(), 1);
    }
    #[test]
    fn uncertain_tool_wait_requires_explicit_force_and_retains_admission() {
        let activity = Arc::new(request_activity::Activity::default());
        let g = group(&json!([]));
        activity.tools(|p| p.start(1, &g));
        assert!(activity.begin_stop(false).is_err());
        assert!(activity.enter().is_ok());
        activity.tools(|p| p.complete(1, &g, &proof(&json!([])), vec![], true));
        assert_eq!(activity.waiting_tools(), 1);
        activity.begin_stop(true).unwrap();
        assert!(activity.enter().is_err());
        activity.reopen();
        assert!(activity.enter().is_ok());
    }
    #[test]
    fn normalization_ignores_transport_ids_but_retains_call_identity() {
        let a = json!([{"type":"message","id":"a","role":"user","content":[{"type":"input_text","text":"task"}]}]);
        let b = json!([{"role":"user","content":"task"}]);
        assert_eq!(proof(&a).prefixes, proof(&b).prefixes);
        assert_eq!(
            canonical_call(&call("{\"a\":1,\"b\":2}")),
            canonical_call(&call("{\"b\":2,\"a\":1}"))
        );
    }
    #[test]
    fn malformed_gemini_error_frames_do_not_poison_shared_evidence() {
        let activity = Arc::new(request_activity::Activity::default());
        let mut observer = Observer::new(
            activity.clone(),
            1,
            &Provider::default(),
            "gemini-cli",
            "session",
            &json!([]),
            "gemini",
        );
        observer.event(&json!({"candidates":[{"content":{"parts":[{"functionCall":{"id":"call","name":"lookup","args":{}}}]}}]}),b"");
        for frame in [
            json!({"error":{"message":"failed"}}),
            json!({"candidates":[]}),
            json!({"candidates":[null]}),
        ] {
            observer.event(&frame, b"");
        }
        assert_eq!(activity.waiting_tools(), 1);
        assert!(activity.begin_stop(false).is_err());
        observer.event(&json!({"candidates":[{"finishReason":"STOP"}]}), b"");
        assert_eq!(activity.waiting_tools(), 1);
    }
}
