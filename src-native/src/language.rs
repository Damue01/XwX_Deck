use std::sync::OnceLock;

fn normalize(locale: &str) -> String {
    if locale.trim().to_ascii_lowercase().starts_with("zh") {
        "zh-CN"
    } else {
        "en"
    }
    .into()
}

pub fn is_supported(locale: &str) -> bool {
    ["zh-CN", "en"].contains(&locale)
}

/// Read the user's OS language once, without persisting an implicit choice.
pub fn system_language() -> String {
    static LANGUAGE: OnceLock<String> = OnceLock::new();
    LANGUAGE
        .get_or_init(|| {
            // Deterministic isolated acceptance tests cannot alter production preferences.
            if std::env::args().any(|arg| arg == "--pilot-root") {
                if let Ok(locale) = std::env::var("XWX_SYSTEM_LANGUAGE_TEST") {
                    return normalize(&locale);
                }
            }
            #[cfg(target_os = "macos")]
            if let Ok(output) = std::process::Command::new("/usr/bin/defaults")
                .args(["read", "-g", "AppleLanguages"])
                .output()
            {
                if output.status.success() {
                    if let Some(locale) = String::from_utf8_lossy(&output.stdout)
                        .split('\n')
                        .skip(1)
                        .map(|line| line.trim().trim_matches(&['"', ',', ' '][..]))
                        .find(|line| !line.is_empty() && *line != ")")
                    {
                        return normalize(locale);
                    }
                }
            }
            #[cfg(target_os = "windows")]
            {
                #[link(name = "kernel32")]
                extern "system" {
                    fn GetUserDefaultUILanguage() -> u16;
                    fn LCIDToLocaleName(
                        locale: u32,
                        buffer: *mut u16,
                        length: i32,
                        flags: u32,
                    ) -> i32;
                }
                let mut buffer = [0u16; 85];
                // OS API writes at most `length` UTF-16 units, including a trailing NUL.
                let count = unsafe {
                    LCIDToLocaleName(
                        GetUserDefaultUILanguage() as u32,
                        buffer.as_mut_ptr(),
                        buffer.len() as i32,
                        0,
                    )
                };
                if count > 1 {
                    return normalize(&String::from_utf16_lossy(&buffer[..count as usize - 1]));
                }
            }
            normalize(&std::env::var("LANG").unwrap_or_else(|_| "en".into()))
        })
        .clone()
}
