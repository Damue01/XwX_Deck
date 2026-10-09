//! Read-only installation discovery. Never launch a client or read its credentials.
use std::{
    env, fs,
    path::{Path, PathBuf},
};

pub fn canonical_id(id: &str) -> &str {
    match id {
        "codex-cli" => "codex",
        "claude-code" => "claude",
        _ => id,
    }
}

pub struct Discovery {
    bins: Vec<PathBuf>,
    apps: Vec<PathBuf>,
    extensions: Vec<PathBuf>,
}

fn directories(path: &Path, limit: usize) -> Vec<PathBuf> {
    fs::read_dir(path)
        .into_iter()
        .flatten()
        .take(limit)
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.is_dir())
        .collect()
}

fn executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return fs::metadata(path).is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0);
    }
    #[cfg(not(unix))]
    {
        true
    }
}

impl Discovery {
    pub fn for_home(home: &Path) -> Self {
        Self::in_home(home)
    }
    pub fn system() -> Self {
        let home = env::var_os("HOME")
            .or_else(|| env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_default();
        let mut discovery = Self::in_home(&home);
        discovery.bins.extend(
            env::var_os("PATH")
                .into_iter()
                .flat_map(|path| env::split_paths(&path).collect::<Vec<_>>())
                .filter(|path| path.is_absolute()),
        );
        if cfg!(target_os = "macos") {
            discovery.apps.push(PathBuf::from("/Applications"));
        }
        if cfg!(unix) {
            discovery
                .bins
                .extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
            discovery.apps.push(PathBuf::from("/opt"));
        }
        for key in [
            "LOCALAPPDATA",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "APPDATA",
        ] {
            if let Some(root) = env::var_os(key).map(PathBuf::from) {
                discovery.apps.push(root.clone());
                discovery.apps.push(root.join("Programs"));
                discovery.bins.push(root.join("npm"));
            }
        }
        for key in [
            "NPM_CONFIG_PREFIX",
            "npm_config_prefix",
            "VOLTA_HOME",
            "MCODE_INSTALL_DIR",
        ] {
            if let Some(root) = env::var_os(key)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
            {
                discovery.bins.push(root.join("bin"));
                discovery.bins.push(root);
            }
        }
        if let Some(root) = env::var_os("NVM_DIR").map(PathBuf::from) {
            for version in directories(&root.join("versions/node"), 64) {
                discovery.bins.push(version.join("bin"));
            }
        }
        discovery
    }

    fn in_home(home: &Path) -> Self {
        let mut bins = [
            ".local/bin",
            ".npm-global/bin",
            ".cargo/bin",
            ".bun/bin",
            ".volta/bin",
            ".asdf/shims",
            ".grok/bin",
            ".kimi/bin",
            ".opencode/bin",
            ".minimax-code/bin",
            ".minimax-code",
        ]
        .map(|path| home.join(path))
        .to_vec();
        for root in [
            home.join(".nvm/versions/node"),
            home.join(".local/share/fnm/node-versions"),
            home.join(".fnm/node-versions"),
            home.join("Library/Application Support/fnm/node-versions"),
        ] {
            for version in directories(&root, 64) {
                bins.push(version.join("bin"));
                bins.push(version.join("installation/bin"));
            }
        }
        Self {
            bins,
            apps: vec![home.join("Applications"), home.join(".local/share")],
            extensions: [
                ".vscode/extensions",
                ".vscode-insiders/extensions",
                ".cursor/extensions",
                ".windsurf/extensions",
            ]
            .map(|path| home.join(path))
            .to_vec(),
        }
    }

    pub fn installed(&self, id: &str) -> bool {
        let (apps, commands): (&[&str], &[&str]) = match canonical_id(id) {
            "codex" => (&["ChatGPT", "Codex"], &["codex"]),
            "claude" => (&["Claude"], &["claude"]),
            "deepseek-harness" => (&["DeepSeek Harness", "DSH"], &["dsh"]),
            "zcode" => (&["ZCode"], &["zcode"]),
            "kimi-code" => (&["Kimi Code"], &["kimi"]),
            "minimax-code" => (&["MiniMax Code"], &["mcode"]),
            "gemini-cli" => (&[], &["gemini"]),
            "qwen-code" => (&[], &["qwen"]),
            "grok-build" => (&[], &["grok"]),
            "cursor" => (&["Cursor"], &["cursor"]),
            "windsurf" => (&["Windsurf", "Devin"], &["windsurf"]),
            "vscode" => (&["Visual Studio Code", "Microsoft VS Code"], &["code"]),
            "zed" => (&["Zed"], &["zed"]),
            "trae" => (&["Trae", "TRAE"], &["trae"]),
            "opencode" => (&["OpenCode"], &["opencode"]),
            "cline" => (&[], &["cline"]),
            "goose" => (&["Goose"], &["goose"]),
            "cherry-studio" => (&["Cherry Studio"], &["cherry-studio"]),
            "ollama-app" => (&["Ollama"], &["ollama"]),
            "lmstudio-app" => (&["LM Studio"], &["lms"]),
            _ => return false,
        };
        if self.bins.iter().any(|directory| {
            commands.iter().any(|command| {
                if cfg!(windows) {
                    [".exe", ".cmd", ".bat"]
                        .iter()
                        .any(|suffix| executable(&directory.join(format!("{command}{suffix}"))))
                } else {
                    executable(&directory.join(command))
                }
            })
        }) {
            return true;
        }
        if self.apps.iter().any(|root| {
            apps.iter().any(|name| {
                let bundle = root.join(format!("{name}.app/Contents/MacOS"));
                if fs::read_dir(bundle)
                    .into_iter()
                    .flatten()
                    .take(32)
                    .filter_map(|entry| entry.ok())
                    .any(|entry| executable(&entry.path()))
                {
                    return true;
                }
                let directory = root.join(name);
                if executable(&directory.join(format!("{name}.exe"))) {
                    return true;
                }
                // Electron installs on Windows often put the executable in app-<version>.
                if directories(&directory, 32)
                    .iter()
                    .any(|version| executable(&version.join(format!("{name}.exe"))))
                {
                    return true;
                }
                commands.iter().any(|command| {
                    if cfg!(windows) {
                        [".exe", ".cmd", ".bat"]
                            .iter()
                            .any(|suffix| executable(&directory.join(format!("{command}{suffix}"))))
                    } else {
                        executable(&directory.join(command))
                            || executable(&directory.join("bin").join(command))
                    }
                })
            })
        }) {
            return true;
        }
        id == "cline"
            && self.extensions.iter().any(|root| {
                directories(root, 512).iter().any(|directory| {
                    let name = directory.file_name().unwrap_or_default().to_string_lossy();
                    (name.starts_with("saoudrizwan.claude-dev-")
                        || name.starts_with("cline.cline-"))
                        && directory.join("package.json").is_file()
                        && ["dist/extension.js", "extension.js"]
                            .iter()
                            .any(|path| directory.join(path).is_file())
                })
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = env::temp_dir().join(format!(
                "xwx-client-discovery-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
        fn file(&self, path: &str, runnable: bool) {
            let path = self.0.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "fixture").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(
                    &path,
                    fs::Permissions::from_mode(if runnable { 0o755 } else { 0o644 }),
                )
                .unwrap();
            }
            #[cfg(not(unix))]
            let _ = runnable;
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn does_not_mistake_configuration_or_empty_bundle_for_installation() {
        let f = Fixture::new();
        f.file(".codex/config.toml", false);
        f.file("Applications/Cursor.app/Contents/Info.plist", false);
        let discovery = Discovery::in_home(&f.0);
        assert!(!discovery.installed("codex"));
        assert!(!discovery.installed("cursor"));
        f.file("Applications/Cursor.app/Contents/MacOS/Cursor", true);
        assert!(discovery.installed("cursor"));
    }
    #[test]
    fn finds_cli_without_gui_path_and_merges_cli_aliases() {
        let f = Fixture::new();
        f.file(
            if cfg!(windows) {
                ".local/bin/claude.cmd"
            } else {
                ".local/bin/claude"
            },
            true,
        );
        let discovery = Discovery::in_home(&f.0);
        assert!(discovery.installed("claude"));
        assert!(discovery.installed("claude-code"));
        assert!(!discovery.installed("codex"));
    }
    #[test]
    fn finds_node_version_manager_and_rechecks_after_installation() {
        let f = Fixture::new();
        let discovery = Discovery::in_home(&f.0);
        assert!(!discovery.installed("gemini-cli"));
        f.file(
            if cfg!(windows) {
                ".nvm/versions/node/v22/bin/gemini.cmd"
            } else {
                ".nvm/versions/node/v22/bin/gemini"
            },
            true,
        );
        assert!(Discovery::in_home(&f.0).installed("gemini-cli"));
    }
    #[test]
    fn requires_extension_package_and_compiled_entry() {
        let f = Fixture::new();
        f.file(
            ".vscode/extensions/saoudrizwan.claude-dev-3.0/package.json",
            false,
        );
        let discovery = Discovery::in_home(&f.0);
        assert!(!discovery.installed("cline"));
        f.file(
            ".vscode/extensions/saoudrizwan.claude-dev-3.0/dist/extension.js",
            false,
        );
        assert!(discovery.installed("cline"));
    }
    #[test]
    #[cfg(unix)]
    fn ignores_non_executable_files_and_broken_symlinks() {
        let f = Fixture::new();
        f.file(".local/bin/codex", false);
        std::os::unix::fs::symlink("/missing-client", f.0.join(".local/bin/grok")).unwrap();
        let discovery = Discovery::in_home(&f.0);
        assert!(!discovery.installed("codex"));
        assert!(!discovery.installed("grok-build"));
    }
}
