pub(crate) const GATEWAY_PORT: u16 = 45233;
pub(crate) const DATA_DIRECTORY: &str = "xwx-deck";
pub(crate) const CATALOG_FILE: &str = "xwx-deck-model-catalog.json";
pub(crate) const IMAGE_JOURNAL: &str = "compatible-image-gen.json";
pub(crate) const DESKTOP_LEGACY_IDS: [&str; 2] = ["xwx-deck", "xwx-deck-deepseek"];
pub(crate) const PROVIDER_CLIENTS: &[&str] = &["codex", "claude"];
#[cfg(target_os = "macos")]
pub(crate) const AUTOMATIC_MACOS_UPDATES: bool = false;
pub(crate) const THEME_KEY: &str = "xwx-deck.theme";
pub(crate) const LANGUAGE_KEY: &str = "xwx-deck.language";
pub(crate) const SIDEBAR_KEY: &str = "xwx-deck.sidebar";
pub(crate) const ONBOARDING_KEY: &str = "xwx-deck.onboardingSeen";
pub(crate) fn metadata_events() -> String {
    String::new()
}
pub(crate) fn extra_preference_keys(_ids: impl Iterator<Item = String>) -> Vec<String> {
    vec![]
}
pub(crate) fn extra_preference_value(_key: &str, _value: Option<&str>) -> bool {
    false
}

pub(crate) fn allow_update_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        || (std::env::args().any(|a| a == "--rpc" || a == "--smoke")
            && url.scheme() == "http"
            && [Some("127.0.0.1"), Some("localhost")].contains(&url.host_str()))
}

pub(crate) fn foreign_model_alias(value: &str) -> bool {
    let _ = value;
    false
}

pub(crate) const LEGACY_PROVIDER_IDS: &[&str] = &["xwx_deck"];
