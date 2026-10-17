//! Match Claude Code's environment precedence without reading live files.
use std::path::{Component, Path, PathBuf};

fn absolute(value: &str) -> Option<PathBuf> {
    let path = Path::new(value.trim());
    if !path.is_absolute() {
        return None;
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    Some(normalized)
}

pub(super) fn resolve(
    isolated: bool,
    environment: Option<&str>,
    persisted: &str,
    fallback: &Path,
) -> PathBuf {
    (!isolated)
        .then(|| environment.and_then(absolute))
        .flatten()
        .or_else(|| absolute(persisted))
        .unwrap_or_else(|| fallback.to_path_buf())
}

pub(super) fn validate_update(
    isolated: bool,
    environment: Option<&str>,
    requested: &Path,
) -> Result<(), String> {
    if isolated {
        return Ok(());
    }
    if let Some(value) = environment.filter(|value| !value.trim().is_empty()) {
        let effective = absolute(value)
            .ok_or("环境变量 CLAUDE_CONFIG_DIR 必须是绝对路径；当前值无法安全匹配 Claude CLI")?;
        if absolute(&requested.to_string_lossy()).as_ref() != Some(&effective) {
            return Err(format!(
                "环境变量 CLAUDE_CONFIG_DIR 当前优先生效：{}。请先修改或清除该环境变量",
                effective.display()
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(r"C:\fixture")
        } else {
            PathBuf::from("/fixture")
        }
    }

    #[test]
    fn environment_wins_over_persisted_fallback() {
        let root = base();
        let env = root.join("environment");
        let persisted = root.join("persisted");
        assert_eq!(
            resolve(false, env.to_str(), &persisted.to_string_lossy(), &root),
            env
        );
    }

    #[test]
    fn empty_and_relative_values_fall_back_without_filesystem_access() {
        let root = base();
        let persisted = root.join("persisted");
        for env in [None, Some("  "), Some("relative/path")] {
            assert_eq!(
                resolve(false, env, &persisted.to_string_lossy(), &root),
                persisted
            );
        }
        assert_eq!(resolve(false, Some("relative"), "relative", &root), root);
    }

    #[test]
    fn isolated_mode_ignores_ambient_client_directory() {
        let root = base();
        let env = root.join("normal-client");
        let persisted = root.join("isolated-override");
        assert_eq!(resolve(true, env.to_str(), "", &root), root);
        assert_eq!(
            resolve(true, env.to_str(), &persisted.to_string_lossy(), &root),
            persisted
        );
        assert!(validate_update(true, env.to_str(), &root).is_ok());
    }

    #[test]
    fn trims_and_normalizes_like_legacy_resolver() {
        let root = base();
        let env = format!("  {}  ", root.join("old/../effective").display());
        assert_eq!(
            resolve(false, Some(&env), "", &root),
            root.join("effective")
        );
        assert!(validate_update(false, Some(&env), &root.join("effective")).is_ok());
    }

    #[test]
    fn refuses_ineffective_or_invalid_environment_directory_updates() {
        let root = base();
        let env = root.join("environment");
        assert!(validate_update(false, env.to_str(), &root.join("other"))
            .unwrap_err()
            .contains("优先生效"));
        assert!(validate_update(false, Some("relative"), &root)
            .unwrap_err()
            .contains("绝对路径"));
        assert!(validate_update(false, Some("  "), &root).is_ok());
    }
}
