//! Explicitly confirmed client repair. Back up exact current bytes before CAS;
//! an active request keeps its existing route and is never replayed by repair.
use super::*;

pub(super) fn claude_owned(source: &str, managed: &str) -> Result<String> {
    let mut current: Value = serde_json::from_str(if source.trim().is_empty() {
        "{}"
    } else {
        source
    })
    .map_err(err)?;
    let desired: Value = serde_json::from_str(if managed.trim().is_empty() {
        "{}"
    } else {
        managed
    })
    .map_err(err)?;
    if !current.is_object()
        || current.get("env").is_some_and(|value| !value.is_object())
        || !desired.is_object()
    {
        return Err("Claude 配置损坏，原文件已保留".into());
    }
    if current.get("env").is_none() {
        current["env"] = json!({});
    }
    let env = current["env"].as_object_mut().unwrap();
    for key in clients::CLAUDE_KEYS {
        if let Some(value) = desired["env"].get(*key) {
            env.insert((*key).into(), value.clone());
        } else {
            env.remove(*key);
        }
    }
    if env.is_empty() && desired.get("env").is_none() {
        current.as_object_mut().unwrap().remove("env");
    }
    serde_json::to_string_pretty(&current).map_err(err)
}
fn codex_owned(source: &str, managed: &str, official: bool) -> Result<String> {
    let mut current = doc(source)?;
    let expected = doc(managed)?;
    let keys: &[&str] = if official {
        &["openai_base_url", "chatgpt_base_url"]
    } else {
        &[
            "model",
            "model_provider",
            "model_context_window",
            "model_catalog_json",
            "web_search",
        ]
    };
    for key in keys {
        if let Some(value) = expected.get(key) {
            set_codex_field(&mut current, key, value.clone());
        } else {
            current.remove(key);
        }
    }
    if !official {
        for key in CODEX_PROVIDER_FIELDS {
            if let Some(value) = provider_field(&expected, "xwx_deck", key) {
                set_codex_provider_field(&mut current, "xwx_deck", key, value.clone());
            } else if let Some(table) = current
                .get_mut("model_providers")
                .and_then(|value| value.get_mut("xwx_deck"))
                .and_then(Item::as_table_like_mut)
            {
                table.remove(key);
            }
        }
    }
    Ok(current.to_string())
}
impl Pilot {
    pub fn smoke_external_client_conflict(&self) -> Result<Value> {
        if !self.isolated || !std::env::args().any(|arg| arg == "--smoke") {
            return Err("仅允许隔离 WebView 合成测试".into());
        }
        let gateway = self.gateway.as_ref().ok_or("隔离 Gateway 未运行")?;
        if !gateway.codex_managed || gateway.codex_official {
            return Err("合成测试需要配置过的 Codex Gateway".into());
        }
        let source = read(&self.config_path())?.unwrap_or_default();
        let mut current = doc(&source)?;
        set_codex_provider_field(
            &mut current,
            "xwx_deck",
            "base_url",
            value("https://isolated-external.invalid/v1"),
        );
        write_checked(&self.config_path(), &source, &current.to_string())?;
        Ok(json!({"codexConflict":true}))
    }
    pub(super) fn backup_client_repair(&self, client: &str, source: &str) -> Result<()> {
        let mut nonce = [0; 16];
        getrandom::fill(&mut nonce).map_err(|_| "无法准备修复备份，原配置未修改")?;
        let nonce: String = nonce.iter().map(|value| format!("{value:02x}")).collect();
        let path = self.root.join(format!("client-repair-{nonce}.json"));
        write_checked(&path, "", &json!({"version":1,"client":client,"before":source,"sha256":storage::digest(source.as_bytes()),"atMs":millis()}).to_string())
    }
    /// Reapply only this client's owned active overlay. The recovery journal's
    /// direct baseline and other clients remain unchanged. A crash can therefore
    /// use the existing journal; the external version remains in the sealed backup.
    pub(super) fn repair_active_client(&self, client: &str) -> Result<bool> {
        let Some(gateway) = self.gateway.as_ref() else {
            return Ok(false);
        };
        let (path, managed, official) = match client {
            "codex" if gateway.codex_managed => (
                self.config_path(),
                gateway.managed.as_str(),
                gateway.codex_official,
            ),
            "claude" if gateway.claude.is_some() => (
                self.claude_path(),
                gateway.claude.as_ref().unwrap().1.as_str(),
                false,
            ),
            _ => return Ok(false),
        };
        let source = read(&path)?.unwrap_or_default();
        let mut desired = if client == "codex" {
            codex_owned(&source, managed, official)?
        } else {
            claude_owned(&source, managed)?
        };
        if client == "codex" && official {
            // Official traffic also manages a resume alias for existing threads.
            // Repair only fields changed by this gateway, preserving unrelated
            // provider definitions and the exact source in the repair backup.
            let before = doc(&gateway.before)?;
            let expected = doc(managed)?;
            let mut config = doc(&desired)?;
            for key in CODEX_PROVIDER_FIELDS {
                if semantic(provider_field(&before, "xwx_deck", key))
                    != semantic(provider_field(&expected, "xwx_deck", key))
                {
                    if let Some(value) = provider_field(&expected, "xwx_deck", key) {
                        set_codex_provider_field(&mut config, "xwx_deck", key, value.clone());
                    } else if let Some(table) = config
                        .get_mut("model_providers")
                        .and_then(|t| t.get_mut("xwx_deck"))
                        .and_then(Item::as_table_like_mut)
                    {
                        table.remove(key);
                    }
                }
            }
            desired = config.to_string();
            if let Some(model) = self.settings.codex_models["official"]
                .as_str()
                .filter(|model| !model.is_empty())
            {
                let mut config = doc(&desired)?;
                set_codex_field(&mut config, "model", value(model));
                if let Some(window) = self.settings.codex_models["officialContextWindow"]
                    .as_u64()
                    .filter(|window| *window > 0)
                {
                    set_codex_field(&mut config, "model_context_window", value(window as i64));
                }
                desired = config.to_string();
            }
        }
        self.backup_client_repair(client, &source)?;
        write_checked(&path, &source, &desired)?;
        Ok(true)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserve_unowned_codex_fields_and_comments() {
        let source = "# preserve\nmodel = 'external' # inline\nuser_flag = true\n[model_providers.xwx_deck]\nbase_url = 'https://external.test' # endpoint\ncustom = 'keep'\n[model_providers.other]\nbase_url='https://other.test'\n";
        let managed = "model = 'saved'\nmodel_provider='xwx_deck'\n[model_providers.xwx_deck]\nbase_url='http://127.0.0.1:45233/v1'\nwire_api='responses'\n";
        let result = codex_owned(source, managed, false).unwrap();
        assert!(
            result.contains("# preserve")
                && result.contains("# inline")
                && result.contains("# endpoint")
        );
        let parsed = doc(&result).unwrap();
        assert_eq!(parsed["model"].as_str(), Some("saved"));
        assert_eq!(parsed["user_flag"].as_bool(), Some(true));
        assert_eq!(
            parsed["model_providers"]["xwx_deck"]["custom"].as_str(),
            Some("keep")
        );
        assert_eq!(
            parsed["model_providers"]["other"]["base_url"].as_str(),
            Some("https://other.test")
        );
        let official = codex_owned(source, "openai_base_url='http://127.0.0.1:45233/v1'\nchatgpt_base_url='https://chatgpt.com/backend-api'", true).unwrap();
        assert_eq!(doc(&official).unwrap()["model"].as_str(), Some("external"));
    }
    #[test]
    fn preserve_unowned_claude_fields_and_reject_malformed_documents() {
        let output = claude_owned(r#"{"permissions":{"allow":["Read"]},"env":{"ANTHROPIC_BASE_URL":"external","MY_VAR":"keep"}}"#, r#"{"env":{"ANTHROPIC_BASE_URL":"local","ANTHROPIC_MODEL":"saved"}}"#).unwrap();
        let value: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["env"]["MY_VAR"], "keep");
        assert_eq!(value["permissions"]["allow"][0], "Read");
        assert_eq!(value["env"]["ANTHROPIC_MODEL"], "saved");
        assert!(claude_owned("[]", "{}").is_err());
        assert!(claude_owned("{broken", "{}").is_err());
    }
}
