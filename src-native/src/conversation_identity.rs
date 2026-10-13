use super::*;

// Transport metadata identifies the native conversation. A cache namespace is
// only a fallback for Codex's UUID-shaped thread IDs, never a text fingerprint.
pub(super) fn session(
    headers: &axum::http::HeaderMap,
    body: &Value,
    codex: bool,
) -> Option<String> {
    let nonempty = |v: &Value| {
        v.as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    if codex {
        if let Some(metadata) = headers
            .get("x-codex-turn-metadata")
            .and_then(|v| serde_json::from_slice::<Value>(v.as_bytes()).ok())
        {
            for key in ["thread_id", "session_id"] {
                if let Some(id) = nonempty(&metadata[key]) {
                    return Some(id);
                }
            }
        }
    }
    if !codex {
        if let Some(id) = headers
            .get("x-claude-code-session-id")
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(id.into());
        }
    }
    for key in [
        "x-codex-thread-id",
        "session_id",
        "x-session-id",
        "thread-id",
        "session-id",
        "x-opencode-session",
        "x-gemini-session-id",
    ] {
        if let Some(id) = headers
            .get(key)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(id.into());
        }
    }
    if codex {
        for key in ["thread_id", "session_id"] {
            if let Some(id) = nonempty(&body["client_metadata"][key]) {
                return Some(id);
            }
        }
    }
    if let Some(id) = nonempty(&body["metadata"]["session_id"]) {
        return Some(id);
    }
    if !codex {
        if let Some(metadata) = body["metadata"]["user_id"]
            .as_str()
            .and_then(|value| serde_json::from_str::<Value>(value).ok())
        {
            if let Some(id) = nonempty(&metadata["session_id"]) {
                return Some(id);
            }
        }
    }
    if codex {
        if let Some(id) = nonempty(&body["prompt_cache_key"]) {
            if id.len() == 36
                && id.bytes().enumerate().all(|(i, b)| {
                    if [8, 13, 18, 23].contains(&i) {
                        b == b'-'
                    } else {
                        b.is_ascii_hexdigit()
                    }
                })
            {
                return Some(id);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_native_session_survives_tool_rounds_and_resume() {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("x-claude-code-session-id", "claude-thread".parse().unwrap());
        let metadata = json!({"metadata":{"user_id":json!({"device_id":"device","session_id":"body-thread"}).to_string()}});
        assert_eq!(
            session(&headers, &metadata, false).as_deref(),
            Some("claude-thread")
        );
        headers.clear();
        assert_eq!(
            session(&headers, &metadata, false).as_deref(),
            Some("body-thread")
        );
        assert_eq!(session(&headers, &metadata, true), None);
        assert_eq!(
            session(&headers, &json!({"metadata":{"user_id":"not json"}}), false),
            None
        );
        assert_eq!(
            session(
                &headers,
                &json!({"metadata":{"user_id":"{\"device_id\":\"shared-device\"}"}}),
                false
            ),
            None
        );
    }
}
