//! The ChatGPT subscription endpoint accepts a subset of public Responses.
//! Normalize only equivalent defaults; preserve the original request in Trace.
use super::*;

pub(super) fn normalize(body: &mut Value) -> Result<()> {
    match body.get("truncation").and_then(Value::as_str) {
        None => {}
        Some("disabled") => {
            body.as_object_mut()
                .ok_or("无效 Responses 请求")?
                .remove("truncation");
        }
        Some(_) => {
            return Err(
                "当前官方订阅不支持自动截断；请在客户端关闭自动截断，或使用支持该参数的 API 连接"
                    .into(),
            )
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn omit_only_equivalent_truncation_default() {
        let mut body = json!({"truncation":"disabled","input":[{"role":"user","content":"fixture"}],"tools":[{"type":"function","name":"fixture"}],"max_output_tokens":17});
        normalize(&mut body).unwrap();
        assert!(body.get("truncation").is_none());
        assert_eq!(body["max_output_tokens"], 17);
        assert_eq!(body["tools"][0]["name"], "fixture");
        let mut automatic = json!({"truncation":"auto","input":"fixture"});
        assert!(normalize(&mut automatic).is_err());
        assert_eq!(automatic["truncation"], "auto");
    }
}
