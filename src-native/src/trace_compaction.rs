//! Classify the current compaction request, never an old summary in its history.
//! This only adds Trace metadata; it must not change routing or request bodies.
use super::*;

fn content_text(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_owned());
    }
    let mut parts = Vec::new();
    for part in content.as_array()? {
        if !matches!(text(part, "type"), "text" | "input_text") {
            return None;
        }
        parts.push(part["text"].as_str()?);
    }
    Some(parts.join("\n"))
}

fn client_summary(body: &Value) -> bool {
    let message = if let Some(input) = body["input"].as_str() {
        return summary_prompt(input);
    } else if let Some(input) = body["input"].as_array() {
        input.last()
    } else {
        body["messages"].as_array().and_then(|items| items.last())
    };
    message
        .filter(|message| message["role"] == "user")
        .and_then(|message| content_text(&message["content"]))
        .is_some_and(|prompt| summary_prompt(&prompt))
}

fn summary_prompt(prompt: &str) -> bool {
    // Published client prompts, anchored at the current user message. Quoting
    // one in code, tool output, an assistant reply or prior history is not an
    // instruction to compact this request.
    let prompt = prompt.trim_start().to_ascii_lowercase();
    [
        "you are performing a context checkpoint compaction.",
        "your task is to create a detailed summary of the conversation so far",
    ]
    .iter()
    .any(|prefix| prompt.starts_with(prefix))
}

pub(super) fn annotate(record: &mut Value) {
    if record["compact"] == true {
        return;
    }
    let request = &record["request"];
    let path = text(request, "path").split('?').next().unwrap_or("");
    let body = &request["body"];
    let endpoint = path.trim_end_matches('/').ends_with("/responses/compact");
    let trigger = body["input"]
        .as_array()
        .and_then(|items| items.last())
        .is_some_and(|last| last["type"] == "compaction_trigger");
    let mode = if endpoint || trigger {
        "upstream"
    } else if client_summary(body) {
        "client-summary"
    } else {
        return;
    };
    record["compact"] = json!(true);
    if record["contextChanges"].is_null() {
        record["contextChanges"] = json!({});
    }
    if record["contextChanges"].is_object() {
        record["contextChanges"]["compactionMode"] = json!(mode);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const PROMPT: &str = "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.";

    #[test]
    fn current_client_summary_is_marked_without_modifying_evidence() {
        for body in [
            json!({"input":PROMPT}),
            json!({"input":[{"role":"user","content":[{"type":"input_text","text":PROMPT}]}]}),
            json!({"messages":[{"role":"user","content":PROMPT}]}),
        ] {
            let mut record = json!({"request":{"path":"/v1/responses","body":body},"upstream":{"requestBody":body},"contextChanges":{"transformed":false}});
            let before = record.clone();
            annotate(&mut record);
            assert_eq!(record["compact"], true);
            assert_eq!(record["contextChanges"]["compactionMode"], "client-summary");
            assert_eq!(record["contextChanges"]["transformed"], false);
            assert_eq!(record["request"], before["request"]);
            assert_eq!(record["upstream"], before["upstream"]);
            let once = record.clone();
            annotate(&mut record);
            assert_eq!(record, once);
        }
    }

    #[test]
    fn history_quotes_seals_and_tool_outputs_do_not_create_compactions() {
        for input in [
            json!([{"role":"user","content":PROMPT},{"role":"assistant","content":"summary"},{"role":"user","content":"continue"}]),
            json!([{"role":"assistant","content":PROMPT}]),
            json!([{"type":"compaction","encrypted_content":"new-opaque-seal"},{"role":"user","content":"continue"}]),
            json!([{"type":"function_call_output","output":PROMPT}]),
            json!([{"role":"user","content":[{"type":"tool_result","content":PROMPT}]}]),
            json!([{"role":"user","content":format!("```text\n{PROMPT}\n```")}]),
            json!([{"role":"user","content":"帮我总结一下 compact 的问题"}]),
        ] {
            let mut record = json!({"request":{"path":"/v1/responses","body":{"input":input}}});
            let before = record.clone();
            annotate(&mut record);
            assert_eq!(record, before);
        }
    }

    #[test]
    fn explicit_compactions_and_gateway_modes_remain_distinct() {
        let mut record = json!({"request":{"path":"/v1/responses/compact/?test=1"}});
        annotate(&mut record);
        assert_eq!(record["compact"], true);
        let mut gateway =
            json!({"compact":true,"contextChanges":{"compactionMode":"gateway-summary"}});
        let before = gateway.clone();
        annotate(&mut gateway);
        assert_eq!(gateway, before);
    }
}
