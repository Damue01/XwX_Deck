//! Settings schema and optimistic writes share one source snapshot.
use super::*;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Provider {
    pub(super) id: String,
    pub(super) codex_provider_id: String,
    pub(super) display_name: String,
    pub(super) provider_preset: String,
    pub(super) base_url: String,
    pub(super) bearer_token: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(super) subscription_account_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(super) account_label: String,
    #[serde(flatten)]
    pub(super) other: serde_json::Map<String, Value>,
    pub(super) adapter: String,
    pub(super) codex_api_format: String,
    pub(super) codex_model: String,
    pub(super) codex_context_window: u64,
    pub(super) claude_models: Value,
    #[serde(skip)]
    pub(super) official: bool,
    #[serde(skip)]
    pub(super) oauth: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(super) struct Settings {
    pub(super) theme: String,
    pub(super) language: Option<String>,
    pub(super) connections: Vec<Provider>,
    pub(super) selected: Value,
    #[serde(rename = "traceWarningGB", alias = "traceWarningGb")]
    pub(super) trace_warning_gb: f64,
    pub(super) trace_auto_cleanup: bool,
    pub(super) trace_appearance: Value,
    pub(super) claude_models: Value,
    pub(super) client_enabled: Value,
    pub(super) trace_root: String,
    pub(super) log_root: String,
    pub(super) claude_config_dir: String,
    pub(super) codex_enhancements: Value,
    pub(super) codex_models: Value,
    pub(super) claude_desktop: Value,
    pub(super) startup_enabled: bool,
    pub(super) automatic_updates: bool,
    #[serde(flatten)]
    pub(super) other: serde_json::Map<String, Value>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            claude_models: json!({"fable":"","opus":"","sonnet":"","haiku":""}),
            client_enabled: json!({}),
            theme: "day".into(),
            language: None,
            connections: vec![],
            selected: json!({"codex":null,"claude":null}),
            trace_warning_gb: 1.0,
            trace_auto_cleanup: true,
            trace_appearance: json!({"skin":"classic","showThroughput":false,"customImageFile":"","customImageFit":"cover","customImageOverlay":42}),
            trace_root: String::new(),
            log_root: String::new(),
            claude_config_dir: String::new(),
            codex_enhancements: json!({"preserveOfficialLogin":true,"unifySessionHistory":false,"pendingHistoryRestore":false}),
            codex_models: json!({"official":"","officialContextWindow":0}),
            claude_desktop: json!({"syncEnabled":false}),
            startup_enabled: false,
            automatic_updates: true,
            other: serde_json::Map::new(),
        }
    }
}
impl Settings {
    pub(super) fn trace_detail_limit_gb(&self) -> f64 {
        if self.trace_warning_gb > 0.0 {
            return self.trace_warning_gb;
        }
        self.other
            .get("traceDetailLimitGB")
            .and_then(Value::as_f64)
            .filter(|limit| limit.is_finite() && *limit > 0.0)
            .unwrap_or(1.0)
    }

    pub(super) fn fresh() -> Self {
        extension::fresh_settings()
    }
}
impl Pilot {
    pub(super) fn settings_document(settings: &Settings) -> Result<String> {
        let mut value = serde_json::to_value(settings).map_err(err)?;
        if value.get("providers").is_some() {
            let mut retained = settings
                .other
                .get("rememberedProviderIds")
                .cloned()
                .unwrap_or(settings.selected.clone());
            for client in crate::edition::config::PROVIDER_CLIENTS {
                if !settings.selected[client].is_null() {
                    retained[client] = settings.selected[client].clone();
                }
            }
            // Old registries may contain fields from a newer/other client.
            // Preserve them while updating only the fields owned by Deck.
            if !value["providers"].is_object() {
                value["providers"] = json!({});
            }
            value["providers"]["version"] = json!(1);
            value["providers"]["identityVersion"] = json!(2);
            value["providers"]["connections"] = json!(settings.connections);
            value["providers"]["selected"] = retained;
        }
        serde_json::to_string_pretty(&value).map_err(err)
    }
    pub(super) fn check_settings_source(&self) -> Result<()> {
        if let Some(ref error) = self.settings_problem {
            return Err(error.clone());
        }
        if read(&self.root.join("settings.json"))? != *self.settings_source.lock().map_err(err)? {
            return Err(
                "设置已被外部修改，外部文件与本次输入已保留；请重新打开应用读取最新设置后重试"
                    .into(),
            );
        }
        Ok(())
    }
    pub(super) fn persist(&self) -> Result<()> {
        self.check_settings_source()?;
        let source = Self::settings_document(&self.settings)?;
        let mut expected = self.settings_source.lock().map_err(err)?;
        write_checked(
            &self.root.join("settings.json"),
            expected.as_deref().unwrap_or(""),
            &source,
        )?;
        *expected = Some(source);
        Ok(())
    }
    pub(super) fn preflight_settings_write(&self, method: &str) -> Result<()> {
        // Run before client side effects, not only before the final settings write.
        if matches!(
            method,
            "setClientRoute"
                | "resumeTracing"
                | "connectSubscriptionAccount"
                | "removeSubscriptionAccounts"
                | "renameSubscriptionAccount"
                | "addModelClient"
                | "removeModelClient"
                | "importConfigurations"
                | "repairClientProviderSwitch"
                | "clearTraceBackground"
                | "setStartupEnabled"
                | "updateTraceDirectories"
                | "setModelService"
                | "updateCompatibleServiceConfig"
                | "updateClaudeDesktopSync"
                | "updateCodexEnhancements"
                | "updateClaudeModels"
                | "toggleClient"
                | "saveProvider"
                | "switchClientProvider"
                | "updateCodexConfig"
                | "deleteProvider"
                | "setAutomaticUpdates"
                | "setLanguage"
                | "setTheme"
                | "setTraceAppearance"
                | "setTraceStoragePolicy"
        ) {
            self.check_settings_source()?;
        }
        Ok(())
    }
}
