//! Shared, side-effect-free evidence for account and service quota routing.
use super::*;

pub(super) fn quota_error(status: u16, bytes: &[u8]) -> bool {
    if ![400, 402, 403, 429].contains(&status) {
        return false;
    }
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return false;
    };
    let error = if value["error"].is_object() {
        &value["error"]
    } else {
        &value["response"]["error"]
    };
    let codes = [
        "insufficient_quota",
        "quota_exceeded",
        "usage_limit_reached",
        "credits_exhausted",
        "billing_hard_limit_reached",
        "credit_balance_too_low",
    ];
    if codes.contains(&text(error, "code")) || codes.contains(&text(error, "type")) {
        return true;
    }
    let message = text(error, "message").to_lowercase();
    [
        "quota exhausted",
        "quota exceeded",
        "insufficient quota",
        "usage limit reached",
        "credit balance is too low",
        "额度已用完",
        "额度已用尽",
        "余额不足",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_definite_quota_rejections_qualify() {
        let quota = br#"{"error":{"code":"insufficient_quota"}}"#;
        for status in [400, 402, 403, 429] {
            assert!(quota_error(status, quota));
        }
        for status in [200, 401, 500, 503] {
            assert!(!quota_error(status, quota));
        }
        assert!(quota_error(
            429,
            br#"{"response":{"error":{"type":"credits_exhausted"}}}"#
        ));
        assert!(quota_error(
            429,
            "{\"error\":{\"message\":\"额度已用尽\"}}".as_bytes()
        ));
    }

    #[test]
    fn rate_limit_wording_and_unrelated_metadata_are_not_quota_exhaustion() {
        for body in [
            br#"{"error":{"code":"rate_limit_exceeded"}}"#.as_slice(),
            br#"{"error":{"code":"rate_limit_exceeded","message":"Temporary token quota reset; retry later"}}"#,
            br#"{"error":{"message":"Too many concurrent requests"},"quota":{"remaining":90}}"#,
            br#"{"output_text":"quota exceeded"}"#,
            b"quota",
        ] {
            assert!(!quota_error(429, body));
        }
    }
}
