//! Read only the known Electron UI preferences. LevelDB recovery/compaction runs
//! in a memory-only Env in a disposable child, never against the original files.
use base64::Engine;
use rusty_leveldb::{env::Env, MemEnv, Options, DB};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    rc::Rc,
};
use tokio::io::AsyncReadExt;

type Result<T> = std::result::Result<T, String>;
const CACHE: &str = "renderer-preferences-legacy-v1.json";
const MAX_FILES: usize = 128;
const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_RESULT: usize = 256 * 1024;
const MARKER: &str = "xwxdeck.rendererMigration.v1";

pub fn keys(_ids: impl Iterator<Item = String>, config: &Path) -> Vec<String> {
    let mut keys = vec![
        "xwx-deck.theme",
        "xwx-deck.language",
        "xwx-deck.sidebar",
        "xwx-deck.onboardingSeen",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    for section in ["application", "trace", "models"] {
        keys.push(format!("xwx-deck:settings:{section}:expanded:v1"));
    }
    keys.push(format!(
        "xwx.missingHistoryProviders.{}",
        config.to_string_lossy()
    ));
    keys.sort();
    keys.dedup();
    keys
}

fn allowed_key(key: &str) -> bool {
    matches!(
        key,
        "xwx-deck.theme"
            | "xwx-deck.language"
            | "xwx-deck.sidebar"
            | "xwx-deck.onboardingSeen"
            | "xwx-deck:settings:application:expanded:v1"
            | "xwx-deck:settings:trace:expanded:v1"
            | "xwx-deck:settings:models:expanded:v1"
    ) || key
        .strip_prefix("xwx.missingHistoryProviders.")
        .is_some_and(|p| {
            p.len() <= 4096 && Path::new(p).is_absolute() && !p.chars().any(char::is_control)
        })
}

fn valid_value(key: &str, value: &str) -> bool {
    if value.len() > 8192 {
        return false;
    }
    match key {
        "xwx-deck.theme" => ["day", "night", "system"].contains(&value),
        "xwx-deck.language" => crate::language::is_supported(value),
        "xwx-deck.sidebar" => ["collapsed", "expanded"].contains(&value),
        "xwx-deck.onboardingSeen" => value == "true",
        _ if key.starts_with("xwx-deck:settings:") => ["true", "false"].contains(&value),
        _ if key.starts_with("xwx.missingHistoryProviders.") => {
            serde_json::from_str::<Value>(value).ok().and_then(|v| {
                v.as_array().map(|a| {
                    a.len() <= 128
                        && a.iter().all(|v| {
                            v.as_str()
                                .is_some_and(|s| s.len() <= 512 && !s.chars().any(char::is_control))
                        })
                })
            }) == Some(true)
        }
        _ => !value.chars().any(char::is_control),
    }
}

fn physical(path: &Path) -> Result<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("偏好目录必须为绝对路径".into());
    }
    let mut prefix = PathBuf::new();
    for component in path.components() {
        prefix.push(component);
        match fs::symlink_metadata(&prefix) {
            Ok(m) if m.file_type().is_symlink() => return Err("偏好目录不能经过符号链接".into()),
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(_) => return Err("无法检查偏好目录".into()),
        }
    }
    Ok(())
}

fn files(source: &Path) -> Result<Option<BTreeMap<String, Vec<u8>>>> {
    physical(source)?;
    let entries = match fs::read_dir(source) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取旧版界面偏好目录".into()),
    };
    let mut result = BTreeMap::new();
    let mut total = 0;
    for entry in entries {
        let entry = entry.map_err(|_| "无法读取旧版偏好文件列表")?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "旧版偏好文件名无效")?;
        let numeric = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
        let included = name == "CURRENT"
            || name.strip_prefix("MANIFEST-").is_some_and(numeric)
            || [".log", ".ldb", ".sst"]
                .iter()
                .any(|suffix| name.strip_suffix(suffix).is_some_and(numeric));
        if !included {
            continue;
        }
        let meta = fs::symlink_metadata(entry.path()).map_err(|_| "旧版偏好文件已变化")?;
        if !meta.is_file()
            || meta.file_type().is_symlink()
            || meta.len() > 16 * 1024 * 1024
            || result.len() >= MAX_FILES
        {
            return Err("旧版偏好文件类型或大小超出安全范围".into());
        }
        let mut data = Vec::new();
        fs::File::open(entry.path())
            .map_err(|_| "无法读取旧版偏好文件")?
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut data)
            .map_err(|_| "无法读取旧版偏好文件")?;
        total += data.len();
        if data.len() as u64 != meta.len() || total > MAX_BYTES {
            return Err("旧版偏好正在变化或超出大小限制".into());
        }
        result.insert(name, data);
    }
    let current = result
        .get("CURRENT")
        .and_then(|v| std::str::from_utf8(v).ok())
        .ok_or("旧版偏好缺少有效 CURRENT")?;
    let manifest = current
        .strip_suffix('\n')
        .ok_or("旧版偏好 CURRENT 格式无效")?;
    if !manifest
        .strip_prefix("MANIFEST-")
        .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        || !result.contains_key(manifest)
    {
        return Err("旧版偏好缺少有效清单".into());
    }
    Ok(Some(result))
}

fn fingerprint(files: &BTreeMap<String, Vec<u8>>) -> String {
    let mut hash = Sha256::new();
    for (name, data) in files {
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name.as_bytes());
        hash.update((data.len() as u64).to_le_bytes());
        hash.update(data);
    }
    format!("{:x}", hash.finalize())
}

fn decode(bytes: &[u8]) -> Result<String> {
    if bytes.len() > 16_385 {
        return Err("旧版偏好值过长".into());
    }
    match bytes.split_first() {
        Some((1, data)) => Ok(data.iter().map(|b| char::from(*b)).collect()),
        Some((0, data)) if data.len() % 2 == 0 => String::from_utf16(
            &data
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .collect::<Vec<_>>(),
        )
        .map_err(|_| "旧版偏好 UTF-16 无效".into()),
        _ => Err("旧版偏好编码无效".into()),
    }
}

pub fn worker(source: &Path, encoded: &str) -> Result<Value> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "偏好键列表无效")?;
    let keys: Vec<String> = serde_json::from_slice(&raw).map_err(|_| "偏好键列表无效")?;
    if keys.len() > 512 || keys.iter().any(|k| !allowed_key(k)) {
        return Err("偏好键不在迁移白名单中".into());
    }
    let Some(original) = files(source)? else {
        return Ok(json!({"version":1,"status":"absent","values":{}}));
    };
    let digest = fingerprint(&original);
    let memory = MemEnv::new();
    for (name, data) in &original {
        memory
            .open_writable_file(&Path::new("ui-preferences").join(name))
            .map_err(|_| "无法准备偏好内存副本")?
            .write_all(data)
            .map_err(|_| "无法准备偏好内存副本")?;
    }
    let options = Options {
        env: Rc::new(Box::new(memory)),
        create_if_missing: false,
        paranoid_checks: true,
        compressor: 1,
        max_open_files: 32,
        block_cache_capacity_bytes: 1024 * 1024,
        ..Options::default()
    };
    let mut db = DB::open("ui-preferences", options).map_err(|_| "旧版偏好数据库无法读取")?;
    let snapshot = db.get_snapshot();
    if db
        .get_at(&snapshot, b"VERSION")
        .map_err(|_| "旧版偏好版本无法读取")?
        .as_deref()
        != Some(b"1")
    {
        return Err("旧版偏好数据库版本不受支持".into());
    }
    let mut values = BTreeMap::new();
    for key in keys {
        // Electron's manager is loadFile(), so only the first-party file origin
        // is read. Remote third-party origins and their cookies are excluded.
        let mut latin = b"_file://\0".to_vec();
        latin.push(1);
        let latin_key = key.chars().all(|c| c as u32 <= 255);
        if latin_key {
            latin.extend(key.chars().map(|c| c as u8));
        }
        let mut wide = b"_file://\0".to_vec();
        wide.push(0);
        wide.extend(key.encode_utf16().flat_map(u16::to_le_bytes));
        let a = if latin_key {
            db.get_at(&snapshot, &latin)
                .map_err(|_| "旧版偏好读取失败")?
        } else {
            None
        };
        let b = db
            .get_at(&snapshot, &wide)
            .map_err(|_| "旧版偏好读取失败")?;
        if a.is_some() && b.is_some() && a != b {
            return Err("旧版偏好存在重复编码冲突".into());
        }
        if let Some(raw) = a.or(b) {
            let value = decode(&raw)?;
            if !valid_value(&key, &value) {
                return Err("旧版偏好值无效，已保留原文件".into());
            }
            values.insert(key, value);
        }
    }
    db.close().map_err(|_| "偏好内存副本无法关闭")?;
    if files(source)?.as_ref().map(fingerprint).as_deref() != Some(&digest) {
        return Err("旧版偏好读取期间发生变化，请退出旧版后重试".into());
    }
    let result = json!({"version":1,"status":"read","sourceSha256":digest,"values":values});
    if result.to_string().len() > MAX_RESULT {
        return Err("偏好迁移结果过大".into());
    }
    Ok(result)
}

fn validate(report: &Value, keys: &[String]) -> Result<()> {
    if report["version"] != 1
        || ![Some("read"), Some("absent")].contains(&report["status"].as_str())
    {
        return Err("界面偏好迁移备份版本无效".into());
    }
    if report["status"] == "read"
        && !report["sourceSha256"].as_str().is_some_and(|digest| {
            digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit())
        })
    {
        return Err("界面偏好迁移备份缺少有效来源指纹".into());
    }
    let values = report["values"].as_object().ok_or("界面偏好迁移备份无效")?;
    if values.iter().any(|(k, v)| {
        !keys.contains(k) || !allowed_key(k) || !v.as_str().is_some_and(|v| valid_value(k, v))
    }) {
        return Err("界面偏好迁移备份包含无效值".into());
    }
    Ok(())
}

pub async fn load(root: &Path, keys: &[String]) -> Result<Value> {
    let cache = root.join(CACHE);
    physical(&cache)?;
    if cache.exists() {
        let meta = fs::symlink_metadata(&cache).map_err(|_| "无法检查界面偏好迁移备份")?;
        if !meta.is_file() || meta.len() > MAX_RESULT as u64 {
            return Err("界面偏好迁移备份类型或大小无效".into());
        }
        let report: Value =
            serde_json::from_slice(&fs::read(&cache).map_err(|_| "无法读取界面偏好迁移备份")?)
                .map_err(|_| "界面偏好迁移备份损坏，原文件已保留")?;
        // A provider removed since the original migration must not invalidate
        // the backup. Filter only at application time, keeping that backup intact.
        let original_keys = report["values"]
            .as_object()
            .ok_or("界面偏好迁移备份无效")?
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        validate(&report, &original_keys)?;
        let mut report = report;
        report["values"]
            .as_object_mut()
            .unwrap()
            .retain(|k, _| keys.contains(k));
        return Ok(report);
    }
    let encoded = base64::engine::general_purpose::STANDARD
        .encode(serde_json::to_vec(keys).map_err(|_| "无法准备偏好迁移")?);
    let mut child =
        tokio::process::Command::new(std::env::current_exe().map_err(|_| "无法启动偏好迁移进程")?)
            .arg("--legacy-renderer-worker")
            .arg(root.join("Local Storage/leveldb"))
            .arg("--renderer-keys")
            .arg(encoded)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| "无法启动偏好迁移进程")?;
    let stdout = child.stdout.take().ok_or("无法读取偏好迁移结果")?;
    let reader = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stdout
            .take(MAX_RESULT as u64 + 1)
            .read_to_end(&mut bytes)
            .await
            .map(|_| bytes)
    });
    let status = match tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await {
        Ok(status) => status.map_err(|_| "偏好迁移进程异常")?,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = reader.await;
            return Err("旧版偏好读取超时，请退出旧版后重新打开；原文件未改动".into());
        }
    };
    let bytes = reader
        .await
        .map_err(|_| "偏好迁移读取异常")?
        .map_err(|_| "偏好迁移读取异常")?;
    if !status.success() || bytes.len() > MAX_RESULT {
        return Err("旧版界面偏好读取失败，请退出旧版后重新打开；原文件未改动".into());
    }
    let report: Value = serde_json::from_slice(&bytes).map_err(|_| "偏好迁移结果无效")?;
    validate(&report, keys)?;
    // No old database is itself a successful empty migration. Do not seal it:
    // an explicit later import can still supply a legacy browser profile.
    if report["status"] == "absent" {
        return Ok(report);
    }
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let temporary = root.join("renderer-preferences-legacy-v1.tmp");
    let mut file = options
        .open(&temporary)
        .map_err(|_| "无法保存界面偏好备份，已有文件已保留")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "界面偏好备份写入失败")?;
    // Link publishes without replacing a concurrent writer's backup.
    fs::hard_link(&temporary, &cache).map_err(|_| "界面偏好备份已变化，未覆盖")?;
    fs::remove_file(temporary).map_err(|_| "界面偏好备份临时文件无法清理")?;
    Ok(report)
}

pub fn initialization_script(report: &Value) -> String {
    let payload = json!({"values":report["values"],"seal":report["status"] == "read"})
        .to_string()
        .replace('<', "\\u003c")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    format!(
        r#"(()=>{{try{{const u=new URL(location.href);if(window.top!==window||!((u.protocol==='tauri:'&&u.hostname==='localhost')||(u.protocol==='http:'&&u.hostname==='tauri.localhost'))||!['','/','/index.html'].includes(u.pathname))return;const marker={marker:?};if(localStorage.getItem(marker)==='done')return;const p={payload};for(const [k,v]of Object.entries(p.values||{{}}))if(localStorage.getItem(k)===null)localStorage.setItem(k,v);if(p.seal)localStorage.setItem(marker,'done');}}catch{{/* Storage failures leave the original source available for retry. */}}}})();"#,
        marker = MARKER
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_keys_match_the_actual_renderer_storage_contract() {
        let configured = keys(std::iter::empty(), Path::new("/public-config/config.toml"));
        for (source, key, value) in [
            (
                include_str!("../../src/renderer/lib/theme.ts"),
                "xwx-deck.theme",
                "night",
            ),
            (
                include_str!("../../src/renderer/lib/i18n.ts"),
                "xwx-deck.language",
                "ja",
            ),
            (
                include_str!("../../src/renderer/features/shell/Rail.tsx"),
                "xwx-deck.sidebar",
                "collapsed",
            ),
            (
                include_str!("../../src/renderer/features/onboarding/OnboardingTour.tsx"),
                "xwx-deck.onboardingSeen",
                "true",
            ),
        ] {
            assert!(
                source.contains(&format!("'{key}'")),
                "renderer storage key: {key}"
            );
            assert!(
                configured.contains(&key.to_owned()),
                "migration whitelist: {key}"
            );
            assert!(allowed_key(key));
            assert!(valid_value(key, value));
        }
        let sidebar = include_str!("../../src/renderer/features/shell/Rail.tsx");
        assert!(sidebar.contains("next ? 'collapsed' : 'expanded'"));
        assert!(valid_value("xwx-deck.sidebar", "expanded"));
        assert!(!valid_value("xwx-deck.sidebar", "true"));
        assert!(!valid_value("xwx-deck.theme", "dark"));
        assert!(!valid_value("xwx-deck.language", "unknown"));
        assert!(!valid_value("xwx-deck.onboardingSeen", "false"));
        let expansion = include_str!("../../src/renderer/lib/useRememberedExpansion.ts");
        assert!(expansion.contains("xwx-deck:settings:${section}:expanded:v1"));
        for section in ["application", "trace", "models"] {
            let key = format!("xwx-deck:settings:{section}:expanded:v1");
            assert!(configured.contains(&key));
            assert!(valid_value(&key, "true"));
            assert!(valid_value(&key, "false"));
        }
        let app = include_str!("../../src/renderer/App.tsx");
        assert!(app.contains("xwx.missingHistoryProviders.${codexConfigPath}"));
        assert!(valid_value(
            "xwx.missingHistoryProviders./public-config/config.toml",
            "[\"manual-provider\"]"
        ));
        assert!(!allowed_key("xwxdeck.theme"));
        assert!(!allowed_key("xwxdeck.sidebar"));
    }

    #[test]
    fn legacy_public_leveldb_reader_uses_the_real_ui_keys_without_mutating_source() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "xwx-public-preferences-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let directory = fs::canonicalize(directory).unwrap();
        let values = [
            ("xwx-deck.theme", "night"),
            ("xwx-deck.language", "ja"),
            ("xwx-deck.sidebar", "collapsed"),
            ("xwx-deck.onboardingSeen", "true"),
            ("xwx-deck:settings:trace:expanded:v1", "false"),
        ];
        // The production dependency deliberately omits filesystem support.
        // Serialize an actual database in MemEnv, then copy those database bytes
        // into a physical legacy-profile fixture for the read-only worker.
        let memory: Rc<Box<dyn Env>> = Rc::new(Box::new(MemEnv::new()));
        let source_path = Path::new("legacy-public-source");
        let options = Options {
            env: memory.clone(),
            ..Options::default()
        };
        let mut db = DB::open(source_path, options).unwrap();
        db.put(b"VERSION", b"1").unwrap();
        for (key, value) in values {
            let mut encoded_key = b"_file://\0".to_vec();
            encoded_key.push(1);
            encoded_key.extend_from_slice(key.as_bytes());
            let mut encoded_value = vec![1];
            encoded_value.extend_from_slice(value.as_bytes());
            db.put(&encoded_key, &encoded_value).unwrap();
        }
        db.close().unwrap();
        for name in memory.children(source_path).unwrap() {
            let mut bytes = Vec::new();
            memory
                .open_sequential_file(&source_path.join(&name))
                .unwrap()
                .read_to_end(&mut bytes)
                .unwrap();
            fs::write(directory.join(name), bytes).unwrap();
        }
        let before = fingerprint(&files(&directory).unwrap().unwrap());
        let wanted = keys(std::iter::empty(), Path::new("/public-config/config.toml"));
        let encoded =
            base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&wanted).unwrap());
        let report = worker(&directory, &encoded).unwrap();
        for (key, value) in values {
            assert_eq!(report["values"][key], value, "{key}");
        }
        assert_eq!(report["values"].as_object().unwrap().len(), values.len());
        assert_eq!(fingerprint(&files(&directory).unwrap().unwrap()), before);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn chromium_strings_and_whitelist() {
        assert_eq!(decode(&[1, 0xe9]).unwrap(), "é");
        assert_eq!(decode(&[0, 0x2d, 0x4e]).unwrap(), "中");
        assert!(decode(&[0, 0]).is_err());
        assert!(decode(&[3, 1]).is_err());
        assert!(!allowed_key("apiKey"));
        assert!(!allowed_key("xwx-deck:settings:unknown:expanded:v1"));
        assert!(!valid_value("xwx-deck.sidebar", "sideways"));
    }
    #[test]
    fn backup_requires_source_and_known_keys() {
        let keys = vec!["xwx-deck.sidebar".to_owned()];
        let mut report =
            json!({"version":1,"status":"read","values":{"xwx-deck.sidebar":"collapsed"}});
        assert!(validate(&report, &keys).is_err());
        report["sourceSha256"] = json!("a".repeat(64));
        assert!(validate(&report, &keys).is_ok());
        report["values"]["apiKey"] = json!("synthetic-never-import");
        assert!(validate(&report, &keys).is_err());
    }
}
