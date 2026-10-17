//! One immutable resource set shared by the Tauri renderer and HTTP Trace Viewer.
include!(concat!(env!("OUT_DIR"), "/embedded-fonts.rs"));

pub(crate) fn get(path: &str) -> Option<&'static [u8]> {
    let name = path.strip_prefix("/fonts/")?;
    FONTS
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, bytes)| *bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fonts_are_exact_woff2_resources_and_unknown_paths_are_rejected() {
        assert!(!FONTS.is_empty());
        for (name, bytes) in FONTS {
            assert!(bytes.starts_with(b"wOF2"));
            assert_eq!(get(&format!("/fonts/{name}")), Some(*bytes));
        }
        for path in [
            "/fonts/../Info.plist",
            "/fonts/missing.woff2",
            "/fonts/",
            "/other",
        ] {
            assert!(get(path).is_none());
        }
    }
}
