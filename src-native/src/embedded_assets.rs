//! Lossless static text; each resource is inflated only once and kept in memory.
use std::{io::Read, sync::OnceLock};

const MAX_TEXT_BYTES: usize = 16 * 1024 * 1024;

struct EmbeddedText {
    compressed: &'static [u8],
    original_len: usize,
    cached: OnceLock<Result<String, String>>,
}

impl EmbeddedText {
    const fn new(compressed: &'static [u8], original_len: usize) -> Self {
        Self {
            compressed,
            original_len,
            cached: OnceLock::new(),
        }
    }

    fn text(&self) -> Result<&str, String> {
        self.cached
            .get_or_init(|| decode(self.compressed, self.original_len))
            .as_ref()
            .map(String::as_str)
            .map_err(Clone::clone)
    }
}

fn decode(compressed: &[u8], original_len: usize) -> Result<String, String> {
    if original_len > MAX_TEXT_BYTES {
        return Err("内置资源超过 16 MiB 上限".into());
    }
    let mut reader =
        zstd::stream::read::Decoder::new(compressed).map_err(|_| "内置资源压缩格式无效")?;
    reader
        .window_log_max(24)
        .map_err(|_| "无法限制内置资源解压窗口")?;
    let mut bytes = Vec::with_capacity(original_len);
    reader
        .take(original_len as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "内置资源解压或校验失败")?;
    if bytes.len() != original_len {
        return Err("内置资源解压长度不一致".into());
    }
    String::from_utf8(bytes).map_err(|_| "内置资源不是有效 UTF-8".into())
}

include!(concat!(env!("OUT_DIR"), "/embedded-assets.rs"));

pub(crate) const VIEWER_THEME_MARKER: &str = "<!--xwx-native-viewer-theme-->";

pub(crate) fn themed_viewer(preference_json: &str) -> Result<String, String> {
    inject_viewer_theme(viewer()?, preference_json)
}

fn inject_viewer_theme(html: &str, preference_json: &str) -> Result<String, String> {
    if html.matches(VIEWER_THEME_MARKER).count() != 1 {
        return Err("内置仪表盘缺少唯一主题注入点".into());
    }
    let preference = preference_json
        .replace('<', "\\u003c")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    Ok(html.replacen(
        VIEWER_THEME_MARKER,
        &format!("<script>window.__XWX_NATIVE_VIEWER_THEME__={preference};</script>"),
        1,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, sync::Arc};

    fn compressed(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = zstd::stream::Encoder::new(Vec::new(), 3).unwrap();
        encoder.include_checksum(true).unwrap();
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn all_embedded_resources_preserve_every_original_byte() {
        for (decoded, original) in [
            (
                models_dev_capabilities(),
                include_str!("../../test-results/native-assets/models-dev-capabilities.json"),
            ),
            (
                viewer(),
                include_str!("../../test-results/native-assets/viewer.html"),
            ),
            (
                prices(),
                include_str!("../../test-results/native-assets/prices.json"),
            ),
            (
                setup_websites(),
                include_str!("../../test-results/native-assets/setup-websites.json"),
            ),
            (
                official_models(),
                include_str!("../../test-results/native-assets/official-models.json"),
            ),
            (
                clients(),
                include_str!("../../test-results/native-assets/clients.json"),
            ),
        ] {
            assert_eq!(decoded.unwrap().as_bytes(), original.as_bytes());
        }
    }

    #[test]
    fn concurrent_reads_share_the_same_cached_text() {
        let source = "内置目录、价格与界面保持原样。".repeat(100);
        let bytes = Box::leak(compressed(source.as_bytes()).into_boxed_slice());
        let asset = Arc::new(EmbeddedText::new(bytes, source.len()));
        let readers: Vec<_> = (0..8)
            .map(|_| {
                let asset = asset.clone();
                std::thread::spawn(move || {
                    let text = asset.text().unwrap();
                    (text.as_ptr() as usize, text.to_owned())
                })
            })
            .collect();
        let pointer = asset.text().unwrap().as_ptr() as usize;
        for reader in readers {
            let (cached, text) = reader.join().unwrap();
            assert_eq!(cached, pointer);
            assert_eq!(text, source);
        }
        assert!(asset.cached.get().is_some());
    }

    #[test]
    fn malformed_resources_are_bounded_and_never_accepted_as_text() {
        let valid = compressed(b"catalog");
        assert!(decode(b"not a zstd frame", 7).is_err());
        assert!(decode(&valid, 6).unwrap_err().contains("长度"));
        assert!(decode(&valid, 8).unwrap_err().contains("长度"));
        assert!(decode(&valid, MAX_TEXT_BYTES + 1)
            .unwrap_err()
            .contains("上限"));
        assert!(decode(&compressed(&[0xff, 0xfe]), 2)
            .unwrap_err()
            .contains("UTF-8"));
        let mut damaged = valid.clone();
        *damaged.last_mut().unwrap() ^= 1;
        assert!(decode(&damaged, 7).is_err());
        assert!(decode(&valid[..valid.len() - 1], 7).is_err());
        assert!(decode(&compressed(&vec![b'a'; 128 * 1024]), 1)
            .unwrap_err()
            .contains("长度"));
        let broken = EmbeddedText::new(b"invalid", 7);
        assert_eq!(broken.text().unwrap_err(), broken.text().unwrap_err());
        assert!(broken.cached.get().unwrap().is_err());
    }

    #[test]
    fn viewer_keeps_dynamic_theme_and_injection_markers() {
        let html = viewer().unwrap();
        assert_eq!(html.matches(VIEWER_THEME_MARKER).count(), 1);
        assert_eq!(
            html.matches("window.__XWX_NATIVE_VIEWER_THEME__").count(),
            1
        );
        assert!(html.contains("state.theme=window.__XWX_NATIVE_VIEWER_THEME__??state.theme"));
        assert!(html.find(VIEWER_THEME_MARKER).unwrap() < html.find("</head>").unwrap());
        assert!(
            html.find("</head>").unwrap()
                < html.find("window.__XWX_NATIVE_VIEWER_THEME__").unwrap()
        );
        assert!(html.contains("</body>"));
        let themed = themed_viewer("\"night\"").unwrap();
        let injection = "<script>window.__XWX_NATIVE_VIEWER_THEME__=\"night\";</script>";
        assert_eq!(themed.matches(injection).count(), 1);
        assert!(themed.find(injection).unwrap() < themed.find("</head>").unwrap());
        assert!(!themed.contains(VIEWER_THEME_MARKER));
        assert_eq!(
            themed_viewer("\"day\"")
                .unwrap()
                .matches("window.__XWX_NATIVE_VIEWER_THEME__=\"day\"")
                .count(),
            1
        );
        let escaped = themed_viewer("\"</script>\u{2028}\u{2029}\"").unwrap();
        assert!(escaped.contains("\"\\u003c/script>\\u2028\\u2029\""));
        assert!(inject_viewer_theme("<head></head><body></body>", "\"night\"").is_err());
        assert!(inject_viewer_theme(
            &format!("{VIEWER_THEME_MARKER}{VIEWER_THEME_MARKER}"),
            "\"night\""
        )
        .is_err());
        assert_eq!(
            viewer().unwrap(),
            html,
            "per-request edits cannot change the cached Viewer"
        );
    }
}
