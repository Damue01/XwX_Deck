//! Staged writes recheck the captured source after fsync and before replacement.
//! This detects cooperative external edits; editors do not share an OS-wide CAS.
use super::*;
use std::io::Write;

pub(super) fn write(path: &Path, content: &str) -> Result<()> {
    staged(path, None, content, || {})
}
pub(super) fn write_checked(path: &Path, expected: &str, updated: &str) -> Result<()> {
    staged(path, Some(expected), updated, || {})
}
fn staged(
    path: &Path,
    expected: Option<&str>,
    content: &str,
    before_replace: impl FnOnce(),
) -> Result<()> {
    let source = read(path)?;
    if expected.is_some_and(|expected| source.as_deref().unwrap_or_default() != expected) {
        return Err("配置在写入前被其他软件修改，用户文件已保留".into());
    }
    let private = credentials::prepare_private_write(path)?;
    let content = credentials::encode(path, content)?;
    let temporary = path.with_extension("pilot-tmp");
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            "临时文件已存在，保留现场"
        } else {
            "无法创建写入临时文件，已保留原文件和现有现场"
        }
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(err)?;
    }
    if private {
        credentials::private_permissions(&temporary, false)?;
    }
    file.write_all(content.as_bytes()).map_err(err)?;
    file.sync_all().map_err(err)?;
    drop(file);
    before_replace();
    let result = (|| -> Result<()> {
        if read(path)? != source {
            Err("配置在准备替换时被其他软件修改，用户文件已保留".into())
        } else {
            fs::rename(&temporary, path).map_err(err)?;
            #[cfg(unix)]
            if let Some(parent) = path.parent() {
                fs::File::open(parent)
                    .and_then(|file| file.sync_all())
                    .map_err(err)?;
            }
            Ok(())
        }
    })();
    if result.is_err() && fs::read(&temporary).is_ok_and(|bytes| bytes == content.as_bytes()) {
        let _ = fs::remove_file(&temporary);
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changes_during_staging_are_preserved() {
        let root =
            std::env::temp_dir().join(format!("xwxdeck-write-{}-{}", std::process::id(), millis()));
        fs::create_dir(&root).unwrap();
        let path = root.join("client.toml");
        fs::write(&path, "before").unwrap();
        let result = staged(&path, Some("before"), "ours", || {
            fs::write(&path, "external-newer").unwrap();
        });
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "external-newer");
        assert!(!path.with_extension("pilot-tmp").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn foreign_staging_file_and_initial_drift_are_preserved() {
        let root = std::env::temp_dir().join(format!(
            "xwxdeck-write-conflict-{}-{}",
            std::process::id(),
            millis()
        ));
        fs::create_dir(&root).unwrap();
        let path = root.join("client.toml");
        fs::write(&path, "before").unwrap();
        let temporary = path.with_extension("pilot-tmp");
        fs::write(&temporary, "foreign").unwrap();
        assert!(write_checked(&path, "before", "ours").is_err());
        assert_eq!(fs::read_to_string(&temporary).unwrap(), "foreign");
        fs::remove_file(&temporary).unwrap();
        assert!(write_checked(&path, "older", "ours").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "before");
        write_checked(&path, "before", "ours").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "ours");
        fs::remove_dir_all(root).unwrap();
    }
}
