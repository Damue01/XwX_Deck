use super::*;

fn metadata(record: &Value) -> Value {
    record["request"]["headers"]["x-codex-turn-metadata"]
        .as_str()
        .or_else(|| record["request"]["body"]["client_metadata"]["x-codex-turn-metadata"].as_str())
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Null)
}

pub(super) fn annotations(record: &Value) -> Value {
    let body = &record["request"]["body"];
    let meta = metadata(record);
    let source = meta["thread_source"].as_str().unwrap_or("");
    let trigger = meta["turn_trigger"].as_str().unwrap_or("");
    let mut prompt = ingress::first_prompt(body);
    if prompt.trim().is_empty() {
        prompt = text(record, "clientFirstPrompt").to_owned();
    }
    let title_prompt = prompt.split_once("User prompt:\n").map(|(_, p)| p.trim());
    let title_schema = body["text"]["format"]["schema"]["properties"]["title"].is_object();
    let kind = if source == "thread_title"
        || trigger == "thread_title"
        || (title_schema && title_prompt.is_some() && prompt.contains("short title for a task"))
    {
        "title"
    } else if source == "composer_predictions" || trigger == "composer_predictions" {
        "utility"
    } else {
        ""
    };
    let mut result = json!({"firstPrompt":if kind.is_empty(){prompt.as_str()}else{""},"hasMainTurn":kind.is_empty(),"captureClassificationVersion":1});
    if record["source"] == "codex-vscode" {
        let headers = &record["request"]["headers"];
        let originator = text(headers, "originator").to_ascii_lowercase();
        let agent = text(headers, "user-agent").to_ascii_lowercase();
        let cli = matches!(
            originator.as_str(),
            "codex_exec" | "codex-tui" | "codex_cli_rs"
        ) || (originator.is_empty()
            && ["codex_exec/", "codex-tui/", "codex_cli_rs/"]
                .iter()
                .any(|prefix| agent.starts_with(prefix)));
        let thread = meta["thread_id"]
            .as_str()
            .or_else(|| headers["thread-id"].as_str())
            .unwrap_or("");
        let consistent = [
            meta["session_id"].as_str(),
            headers["thread-id"].as_str(),
            headers["session-id"].as_str(),
        ]
        .into_iter()
        .flatten()
        .all(|id| id == thread);
        if cli
            && consistent
            && !thread.is_empty()
            && record["clientConversationKey"] == format!("codex-vscode:{thread}")
        {
            result["source"] = json!("codex-cli");
            result["clientConversationKey"] = json!(format!("codex-cli:{thread}"));
        }
    }
    if !kind.is_empty() {
        result["auxiliary"] = json!(kind);
        result["hidden"] = json!(true);
    }
    if kind == "title" {
        if let Some(prompt) = title_prompt.filter(|p| !p.is_empty()) {
            result["titlePromptHash"] = json!(digest(prompt.as_bytes()));
        }
        let response = &record["response"]["body"];
        let output = response["output"].as_array();
        let mut generated = output
            .into_iter()
            .flatten()
            .filter(|item| item["role"] == "assistant")
            .flat_map(|item| item["content"].as_array().into_iter().flatten())
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("");
        if generated.is_empty() {
            generated = response["choices"][0]["message"]["content"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    response["content"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|part| part["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("")
                });
        }
        let completed = response["status"] == "completed"
            || response["stop_reason"] == "end_turn"
            || response["choices"][0]["finish_reason"] == "stop";
        if completed && record["error"].is_null() {
            if let Ok(value) = serde_json::from_str::<Value>(&generated) {
                if let Some(title) = value["title"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty() && s.chars().count() <= 240)
                {
                    result["title"] = json!(title);
                }
            }
        }
    }
    result
}

// A title helper explicitly quotes its target prompt. Link only a unique exact
// target in the same client and time window; main threads never merge by text.
pub(super) fn associate_titles(sessions: &mut [Value]) {
    for i in 0..sessions.len() {
        let Some(hash) = sessions[i]["titlePromptHash"].as_str() else {
            continue;
        };
        let matches: Vec<_> = sessions
            .iter()
            .enumerate()
            .filter(|(_, main)| {
                main["hidden"] != true
                    && main["source"] == sessions[i]["source"]
                    && !text(main, "firstPrompt").trim().is_empty()
                    && digest(text(main, "firstPrompt").trim().as_bytes()) == hash
                    && chrono::DateTime::parse_from_rfc3339(text(main, "startedAt"))
                        .ok()
                        .zip(
                            chrono::DateTime::parse_from_rfc3339(text(&sessions[i], "startedAt"))
                                .ok(),
                        )
                        .is_some_and(|(a, b)| {
                            (a.timestamp_millis() - b.timestamp_millis()).abs() < 30 * 60 * 1000
                        })
            })
            .map(|(at, _)| at)
            .collect();
        if let [main] = matches.as_slice() {
            sessions[i]["clientConversationKey"] = sessions[*main]["clientConversationKey"].clone();
            sessions[i]["titleHostSessionId"] = sessions[*main]["id"].clone();
            if sessions[i]["title"].is_string() {
                sessions[*main]["title"] = sessions[i]["title"].clone();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_cli_identity_requires_wire_evidence_and_matching_native_thread() {
        let record = json!({"source":"codex-vscode","clientConversationKey":"codex-vscode:thread-a","request":{"headers":{"originator":"codex_exec","thread-id":"thread-a","session-id":"thread-a"},"body":{"input":"same prompt"}}});
        let original = record.clone();
        let annotation = annotations(&record);
        assert_eq!(annotation["source"], "codex-cli");
        assert_eq!(annotation["clientConversationKey"], "codex-cli:thread-a");
        assert_eq!(record, original);
        let mut vscode = record.clone();
        vscode["request"]["headers"]["originator"] = json!("codex_vscode");
        assert!(annotations(&vscode)["source"].is_null());
        let mut mismatch = record;
        mismatch["request"]["headers"]["thread-id"] = json!("thread-b");
        assert!(annotations(&mismatch)["source"].is_null());
    }
    #[test]
    fn native_title_and_predictions_are_auxiliary_without_mutating_wire() {
        let record = json!({"request":{"headers":{"x-codex-turn-metadata":"{\"thread_source\":\"thread_title\"}"},"body":{"input":"You are a helpful assistant. short title for a task\nUser prompt:\nActual question"}},"response":{"body":{"status":"completed","output":[{"role":"assistant","content":[{"text":"{\"title\":\"Actual title\"}"}]}]}}});
        let before = record.clone();
        let a = annotations(&record);
        assert_eq!(a["auxiliary"], "title");
        assert_eq!(a["title"], "Actual title");
        assert_eq!(record, before);
        let prediction = json!({"request":{"headers":{"x-codex-turn-metadata":"{\"thread_source\":\"composer_predictions\"}"},"body":{"input":"Actual question"}}});
        assert_eq!(annotations(&prediction)["auxiliary"], "utility");
        let mut chat = record.clone();
        chat["response"]["body"] = json!({"choices":[{"finish_reason":"stop","message":{"content":"{\"title\":\"Chat title\"}"}}]});
        assert_eq!(annotations(&chat)["title"], "Chat title");
        let mut messages = record.clone();
        messages["response"]["body"] = json!({"stop_reason":"end_turn","content":[{"type":"text","text":"{\"title\":\"Messages title\"}"}]});
        assert_eq!(annotations(&messages)["title"], "Messages title");
        chat["response"]["body"]["choices"][0]["finish_reason"] = json!("length");
        assert!(annotations(&chat)["title"].is_null());
    }
    #[test]
    fn title_association_requires_unique_client_and_prompt_target() {
        let main = json!({"id":"main","source":"codex-cli","clientConversationKey":"codex-cli:main","firstPrompt":"Actual question","startedAt":"2026-10-13T00:00:00Z"});
        let helper = json!({"id":"helper","source":"codex-cli","hidden":true,"titlePromptHash":digest(b"Actual question"),"title":"Actual title","startedAt":"2026-10-13T00:00:01Z"});
        let mut rows = vec![main.clone(), helper.clone()];
        associate_titles(&mut rows);
        assert_eq!(rows[0]["title"], "Actual title");
        assert_eq!(rows[1]["clientConversationKey"], "codex-cli:main");
        let mut ambiguous = vec![main.clone(), main, helper];
        associate_titles(&mut ambiguous);
        assert!(ambiguous[2]["titleHostSessionId"].is_null());
    }
}
