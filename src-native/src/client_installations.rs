//! Read-only installation discovery. Never launch a client or read its credentials.
use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
};

pub fn canonical_id(id: &str) -> &str {
    match id {
        "codex-cli" => "codex",
        "claude-code" => "claude",
        "cursor-cli" => "cursor",
        _ => id,
    }
}

pub fn manual_locations(
    settings: &serde_json::Map<String, serde_json::Value>,
    isolated_root: Option<&Path>,
) -> BTreeMap<String, PathBuf> {
    settings
        .get("clientInstallationLocations")
        .and_then(serde_json::Value::as_object)
        .into_iter()
        .flatten()
        .map(|(id, value)| {
            let path = PathBuf::from(value.as_str().unwrap_or(""));
            let allowed = isolated_root.is_none_or(|root| {
                path.canonicalize()
                    .ok()
                    .zip(root.canonicalize().ok())
                    .is_some_and(|(path, root)| path.starts_with(root))
            });
            (id.clone(), if allowed { path } else { PathBuf::new() })
        })
        .collect()
}

pub struct Discovery {
    bins: Vec<PathBuf>,
    apps: Vec<PathBuf>,
    extensions: Vec<PathBuf>,
    packages: Vec<(String, PathBuf)>,
    manual_locations: BTreeMap<String, PathBuf>,
}

// Installers may use any drive. Only inspect registered installation locations;
// executable checks below still establish which product is actually present.
#[cfg(windows)]
fn windows_install_roots() -> Vec<PathBuf> {
    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::{Foundation::ERROR_NO_MORE_ITEMS, System::Registry::*},
    };
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }
    fn value(key: HKEY, name: &str) -> Option<String> {
        let name = wide(name);
        let mut data = vec![0u16; 32768];
        let mut size = (data.len() * 2) as u32;
        let result = unsafe {
            RegGetValueW(
                key,
                None,
                PCWSTR(name.as_ptr()),
                RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
                None,
                Some(data.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        result.ok().ok()?;
        Some(
            String::from_utf16_lossy(&data[..size as usize / 2])
                .trim_end_matches('\0')
                .to_owned(),
        )
    }
    let mut roots = vec![];
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        for branch in [
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
            r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
            r"Software\Microsoft\Windows\CurrentVersion\App Paths",
            r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths",
        ] {
            let name = wide(branch);
            let mut key = HKEY::default();
            if unsafe { RegOpenKeyExW(hive, PCWSTR(name.as_ptr()), None, KEY_READ, &mut key) }
                .is_err()
            {
                continue;
            }
            for index in 0..4096 {
                let mut name = vec![0u16; 1024];
                let mut length = name.len() as u32;
                let status = unsafe {
                    RegEnumKeyExW(
                        key,
                        index,
                        Some(PWSTR(name.as_mut_ptr())),
                        &mut length,
                        None,
                        None,
                        None,
                        None,
                    )
                };
                if status == ERROR_NO_MORE_ITEMS {
                    break;
                }
                if status.is_err() {
                    continue;
                }
                let mut entry = HKEY::default();
                if unsafe { RegOpenKeyExW(key, PCWSTR(name.as_ptr()), None, KEY_READ, &mut entry) }
                    .is_err()
                {
                    continue;
                }
                if let Some(location) = value(entry, "InstallLocation").filter(|s| !s.is_empty()) {
                    roots.push(PathBuf::from(location.trim_matches('"')));
                }
                if branch.ends_with("App Paths") {
                    if let Some(program) = value(entry, "") {
                        if let Some(parent) = Path::new(program.trim().trim_matches('"')).parent() {
                            roots.push(parent.to_path_buf());
                        }
                    }
                }
                if let Some(icon) = value(entry, "DisplayIcon") {
                    let icon = icon
                        .rsplit_once(',')
                        .filter(|(_, index)| index.trim().parse::<i32>().is_ok())
                        .map_or(icon.as_str(), |(path, _)| path);
                    if let Some(parent) = Path::new(icon.trim_matches('"')).parent() {
                        roots.push(parent.to_path_buf());
                    }
                }
                unsafe {
                    let _ = RegCloseKey(entry);
                }
            }
            unsafe {
                let _ = RegCloseKey(key);
            }
        }
    }
    roots.retain(|root| root.is_absolute());
    roots.sort();
    roots.dedup();
    roots
}

fn package_client(name: &str) -> Option<&'static str> {
    match name.to_ascii_lowercase().as_str() {
        "openai.codex" | "openai.chatgpt-desktop" | "openai.chatgpt" => Some("codex"),
        "claude" | "anthropic.claude" => Some("claude"),
        _ => None,
    }
}

/// Current-user registration is authoritative; cached package data is not an installation.
#[cfg(windows)]
fn windows_packages() -> windows_core::Result<Vec<(String, PathBuf)>> {
    use windows::{
        core::{w, PCWSTR, PWSTR},
        Win32::{
            Foundation::{ERROR_FILE_NOT_FOUND, ERROR_INSUFFICIENT_BUFFER, ERROR_NO_MORE_ITEMS},
            Storage::Packaging::Appx::{
                GetPackagePathByFullName, GetPackagesByPackageFamily, PackageFamilyNameFromFullName,
            },
            System::Registry::{
                RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
            },
        },
    };
    struct Key(HKEY);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                let _ = RegCloseKey(self.0);
            }
        }
    }
    let mut handle = HKEY::default();
    let opened = unsafe {
        RegOpenKeyExW(HKEY_CURRENT_USER, w!("Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages"), None, KEY_READ, &mut handle)
    };
    if opened == ERROR_FILE_NOT_FOUND {
        return Ok(vec![]);
    }
    opened.ok()?;
    let key = Key(handle);
    let mut rows = vec![];
    let mut families = std::collections::HashSet::new();
    for index in 0..4096 {
        let mut name = vec![0u16; 1024];
        let mut length = name.len() as u32;
        let status = unsafe {
            RegEnumKeyExW(
                key.0,
                index,
                Some(PWSTR(name.as_mut_ptr())),
                &mut length,
                None,
                None,
                None,
                None,
            )
        };
        if status == ERROR_NO_MORE_ITEMS {
            break;
        }
        status.ok()?;
        let full_name = String::from_utf16_lossy(&name[..length as usize]);
        let identity = full_name.split('_').next().unwrap_or("");
        if package_client(identity).is_none() {
            continue;
        }
        let mut family = vec![0u16; 1024];
        let mut family_length = family.len() as u32;
        if unsafe {
            PackageFamilyNameFromFullName(
                PCWSTR(name.as_ptr()),
                &mut family_length,
                Some(PWSTR(family.as_mut_ptr())),
            )
        }
        .is_err()
        {
            continue;
        }
        if !families.insert(family.clone()) {
            continue;
        }
        // This native query is restricted to the current user's registration.
        // https://learn.microsoft.com/windows/win32/api/appmodel/nf-appmodel-getpackagesbypackagefamily
        let mut count = 0;
        let mut buffer_length = 0;
        let query = unsafe {
            GetPackagesByPackageFamily(
                PCWSTR(family.as_ptr()),
                &mut count,
                None,
                &mut buffer_length,
                None,
            )
        };
        if query != ERROR_INSUFFICIENT_BUFFER
            || count == 0
            || count > 256
            || buffer_length > 1024 * 1024
        {
            continue;
        }
        let mut names = vec![PWSTR::null(); count as usize];
        let mut buffer = vec![0u16; buffer_length as usize];
        if unsafe {
            GetPackagesByPackageFamily(
                PCWSTR(family.as_ptr()),
                &mut count,
                Some(names.as_mut_ptr()),
                &mut buffer_length,
                Some(PWSTR(buffer.as_mut_ptr())),
            )
        }
        .is_err()
        {
            continue;
        }
        for name in names.iter().take(count as usize) {
            let mut path_length = 0;
            if unsafe { GetPackagePathByFullName(PCWSTR(name.0), &mut path_length, None) }
                != ERROR_INSUFFICIENT_BUFFER
                || path_length == 0
                || path_length > 32768
            {
                continue;
            }
            let mut path = vec![0u16; path_length as usize];
            if unsafe {
                GetPackagePathByFullName(
                    PCWSTR(name.0),
                    &mut path_length,
                    Some(PWSTR(path.as_mut_ptr())),
                )
            }
            .is_ok()
            {
                rows.push((
                    identity.to_owned(),
                    PathBuf::from(String::from_utf16_lossy(
                        &path[..path_length.saturating_sub(1) as usize],
                    )),
                ));
            }
        }
    }
    Ok(rows)
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
        fs::metadata(path).is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn codex_bundle_identity(path: &Path) -> bool {
    if !fs::metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.len() <= 256 * 1024)
    {
        return false;
    }
    // Validate both XML and binary plists with the same native consumer parser.
    // The guard applies only to macOS bundles; executable discovery is separate.
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/plutil")
            .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"])
            .arg(path)
            .output()
            .is_ok_and(|output| output.status.success() && output.stdout == b"com.openai.codex\n")
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

impl Discovery {
    pub fn with_manual_locations(mut self, locations: BTreeMap<String, PathBuf>) -> Self {
        self.manual_locations = locations;
        self
    }
    /// A user-selected installation folder is inspected without launching it.
    pub fn for_location(location: &Path) -> Self {
        let mut discovery = Self {
            bins: vec![],
            apps: vec![],
            extensions: vec![],
            packages: vec![],
            manual_locations: BTreeMap::new(),
        };
        if !location.is_absolute() || !location.is_dir() {
            return discovery;
        }
        discovery
            .bins
            .extend([location.to_path_buf(), location.join("bin")]);
        discovery.apps.push(location.to_path_buf());
        discovery.extensions.push(location.to_path_buf());
        // A selected .app or extension folder needs its containing catalog root.
        if location.extension().is_some_and(|ext| ext == "app") {
            if let Some(parent) = location.parent() {
                discovery.apps.push(parent.to_path_buf());
            }
        }
        discovery
    }
    pub fn management_supported(&self, id: &str) -> bool {
        if let Some(location) = self.manual_locations.get(canonical_id(id)) {
            return Self::for_location(location).management_supported(id);
        }
        if id == "cline" {
            if self.bins.iter().any(|dir| {
                ["cline", "cline.exe", "cline.cmd", "cline.bat"]
                    .iter()
                    .any(|name| executable(&dir.join(name)))
            }) {
                return true;
            }
            return self.extensions.iter().any(|dir| {
                directories(dir, 512)
                    .iter()
                    .chain(std::iter::once(dir))
                    .any(|extension| {
                        fs::read_to_string(extension.join("package.json"))
                            .ok()
                            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                            .is_some_and(|v| {
                                (v["name"] == "claude-dev" || v["name"] == "cline")
                                    && v["version"]
                                        .as_str()
                                        .and_then(|s| s.split('.').next())
                                        .and_then(|s| s.parse::<u32>().ok())
                                        .is_some_and(|major| major >= 4)
                            })
                    })
            });
        }
        if id != "vscode" {
            return true;
        }
        self.apps.iter().any(|root| {
            let mut bases = vec![root.clone(), root.join("Microsoft VS Code")];
            for base in bases.clone() {
                bases.extend(directories(&base, 64).into_iter().filter(|dir| {
                    dir.file_name().is_some_and(|name| {
                        let name = name.to_string_lossy();
                        name.len() >= 8 && name.chars().all(|c| c.is_ascii_hexdigit())
                    })
                }));
            }
            let mut packages: Vec<_> = bases
                .into_iter()
                .map(|base| base.join("resources/app/package.json"))
                .collect();
            packages.push(root.join("Visual Studio Code.app/Contents/Resources/app/package.json"));
            packages.iter().any(|path| {
                let identity = path
                    .parent()
                    .and_then(|dir| fs::read_to_string(dir.join("product.json")).ok())
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
                if !identity.is_some_and(|v| {
                    v["applicationName"] == "code"
                        && (v["nameShort"] == "Code" || v["nameShort"] == "Visual Studio Code")
                }) {
                    return false;
                }
                fs::read_to_string(path)
                    .ok()
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                    .and_then(|v| v["version"].as_str().map(str::to_owned))
                    .is_some_and(|version| {
                        let mut parts = version
                            .split('.')
                            .filter_map(|part| part.parse::<u32>().ok());
                        let major = parts.next().unwrap_or(0);
                        let minor = parts.next().unwrap_or(0);
                        major > 1 || major == 1 && minor >= 122
                    })
            })
        })
    }
    pub fn for_home(home: &Path) -> Self {
        Self::in_home(home)
    }
    pub fn system() -> Self {
        let home = if cfg!(windows) {
            env::var_os("USERPROFILE").or_else(|| env::var_os("HOME"))
        } else {
            env::var_os("HOME").or_else(|| env::var_os("USERPROFILE"))
        }
        .map(PathBuf::from)
        .unwrap_or_default();
        let mut discovery = Self::in_home(&home);
        #[cfg(windows)]
        {
            discovery.packages = windows_packages().unwrap_or_default();
            let roots = windows_install_roots();
            discovery.bins.extend(roots.iter().cloned());
            discovery.apps.extend(roots);
        }
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
            ".factory/bin",
            ".hermes/venv/bin",
            ".mimocode/bin",
            ".qoder/bin",
            ".omp/bin",
            ".dsh/bin",
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
        let mut apps = vec![home.join("Applications"), home.join(".local/share")];
        if cfg!(windows) {
            for root in [home.join("AppData/Local"), home.join("AppData/Roaming")] {
                apps.push(root.join("Programs"));
                apps.push(root.clone());
                bins.push(root.join("npm"));
            }
            let root = home.join("AppData/Local/OpenAI/Codex/bin");
            bins.push(root.clone());
            bins.extend(directories(&root, 64));
        }
        Self {
            bins,
            apps,
            packages: vec![],
            manual_locations: BTreeMap::new(),
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

    /// Locate the native account interface shipped with the desktop app or CLI.
    /// Never launch ChatGPT.exe/Codex.exe from the GUI root as an account helper.
    pub fn codex_executable(&self) -> Option<PathBuf> {
        if let Some(location) = self.manual_locations.get("codex") {
            return Self::for_location(location).codex_executable();
        }
        let mut candidates = vec![];
        for (name, root) in &self.packages {
            if package_client(name) == Some("codex") {
                for base in [root.clone(), root.join("app")] {
                    candidates.push(base.join("resources/codex.exe"));
                    candidates.push(base.join("resources/codex-cli/bin/codex.exe"));
                }
            }
        }
        for root in &self.apps {
            if ["ChatGPT.exe", "Codex.exe"]
                .iter()
                .any(|name| executable(&root.join(name)))
            {
                candidates.push(root.join("resources/codex.exe"));
                candidates.push(root.join("resources/codex-cli/bin/codex.exe"));
            }
            for app in ["Codex", "ChatGPT"] {
                let bundle = root.join(format!("{app}.app"));
                if codex_bundle_identity(&bundle.join("Contents/Info.plist")) {
                    candidates.push(bundle.join("Contents/Resources/codex-cli/bin/codex"));
                    candidates.push(bundle.join("Contents/Resources/codex"));
                }
                for folder in [root.join(app), root.join("OpenAI").join(app)] {
                    candidates.push(folder.join("resources/codex.exe"));
                    candidates.push(folder.join("resources/codex-cli/bin/codex.exe"));
                }
            }
        }
        let name = if cfg!(windows) { "codex.exe" } else { "codex" };
        candidates.extend(
            self.bins
                .iter()
                // A registered or manually selected Electron desktop folder
                // can also contain Codex.exe, which is not the CLI interface.
                .filter(|root| !(cfg!(windows) && root.join("resources").is_dir()))
                .map(|root| root.join(name)),
        );
        candidates.into_iter().find(|path| executable(path))
    }

    pub fn installed(&self, id: &str) -> bool {
        if let Some(location) = self.manual_locations.get(canonical_id(id)) {
            return Self::for_location(location).installed(id);
        }
        let (apps, commands): (&[&str], &[&str]) = match canonical_id(id) {
            "codex" => (&["ChatGPT", "Codex"], &["codex"]),
            "claude" => (&["Claude", "AnthropicClaude"], &["claude"]),
            "deepseek-harness" => (&["DeepSeek Harness", "DSH"], &["dsh"]),
            "zcode" => (&["ZCode"], &["zcode"]),
            "kimi-code" => (&["Kimi Code"], &["kimi"]),
            "minimax-code" => (&["MiniMax Code"], &["mcode"]),
            "gemini-cli" => (&[], &["gemini"]),
            "qwen-code" => (&["Qwen Code", "Qwen Code Desktop"], &["qwen"]),
            "grok-build" => (&[], &["grok"]),
            "cursor" => (&["Cursor"], &["cursor", "cursor-agent"]),
            "pi" => (&[], &["pi"]),
            "oh-my-pi" => (&[], &["omp"]),
            "crush" => (&[], &["crush"]),
            "qoder" => (&["Qoder"], &["qoder", "qodercli"]),
            "droid" => (&[], &["droid"]),
            "copilot-cli" => (&[], &["copilot"]),
            "mimo-code" => (&["MiMo Code", "Xiaomi MiMo"], &["mimo", "mimocode"]),
            "workbuddy" => (&["WorkBuddy"], &["workbuddy"]),
            "codebuddy-code" => (&[], &["codebuddy", "cbc"]),
            "hermes-agent" => (&[], &["hermes"]),
            "antigravity-cli" => (&[], &["agy"]),
            "openchamber" => (&["OpenChamber"], &["openchamber"]),
            "t3-code" => (&["T3 Code", "T3 Code (Alpha)"], &["t3code"]),
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
        if self.packages.iter().any(|(name, root)| {
            package_client(name) == Some(canonical_id(id))
                && apps.iter().any(|app| {
                    [root.clone(), root.join("app")]
                        .iter()
                        .any(|folder| executable(&folder.join(format!("{app}.exe"))))
                })
        }) {
            return true;
        }
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
            // Registry roots already name the installation directory itself.
            if apps
                .iter()
                .any(|name| executable(&root.join(format!("{name}.exe"))))
            {
                return true;
            }
            apps.iter().any(|name| {
                let bundle = root.join(format!("{name}.app/Contents/MacOS"));
                let supported_bundle = !(bundle.is_dir()
                    && canonical_id(id) == "codex"
                    && *name == "ChatGPT"
                    && !codex_bundle_identity(&root.join("ChatGPT.app/Contents/Info.plist")));
                // Only an actual macOS bundle has this identity contract.
                // Keep Windows executable discovery until its own acceptance.
                if supported_bundle
                    && fs::read_dir(bundle)
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
                if directories(&directory, 32).iter().any(|version| {
                    executable(&version.join(format!("{name}.exe")))
                        || commands
                            .iter()
                            .any(|command| executable(&version.join(format!("{command}.exe"))))
                }) {
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
                directories(root, 512)
                    .iter()
                    .chain(std::iter::once(root))
                    .any(|directory| {
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
            let mut nonce = [0u8; 16];
            getrandom::fill(&mut nonce).unwrap();
            let nonce: String = nonce.iter().map(|value| format!("{value:02x}")).collect();
            let root = env::temp_dir().join(format!(
                "xwx-client-discovery-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir(&root).unwrap();
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
    fn manual_location_is_product_scoped_and_missing_choice_does_not_fall_back() {
        let f = Fixture::new();
        let command = if cfg!(windows) { "dsh.cmd" } else { "dsh" };
        f.file(&format!("custom install/{command}"), true);
        f.file(&format!(".local/bin/{command}"), true);
        let chosen = f.0.join("custom install");
        let discovery = Discovery::for_home(&f.0).with_manual_locations(BTreeMap::from([(
            "deepseek-harness".into(),
            chosen.clone(),
        )]));
        assert!(discovery.installed("deepseek-harness"));
        assert!(!Discovery::for_location(&chosen).installed("claude"));
        fs::remove_file(chosen.join(command)).unwrap();
        assert!(!discovery.installed("deepseek-harness"));
        assert!(Discovery::for_home(&f.0).installed("deepseek-harness"));
    }
    #[test]
    fn isolated_manual_locations_cannot_escape_the_fixture_root() {
        let f = Fixture::new();
        let settings = serde_json::json!({"clientInstallationLocations":{"deepseek-harness":f.0.parent().unwrap(),"vscode":f.0}});
        let locations = manual_locations(settings.as_object().unwrap(), Some(&f.0));
        assert!(locations["deepseek-harness"].as_os_str().is_empty());
        assert_eq!(locations["vscode"], f.0);
    }
    #[test]
    #[cfg(windows)]
    fn manual_desktop_location_reuses_the_native_codex_account_interface() {
        let f = Fixture::new();
        f.file("custom/Codex.exe", true);
        f.file("custom/resources/codex.exe", true);
        let discovery = Discovery::for_home(&f.0)
            .with_manual_locations(BTreeMap::from([("codex".into(), f.0.join("custom"))]));
        assert!(discovery.installed("codex-cli"));
        assert_eq!(
            discovery.codex_executable(),
            Some(f.0.join("custom/resources/codex.exe"))
        );
        fs::remove_file(f.0.join("custom/resources/codex.exe")).unwrap();
        assert_eq!(discovery.codex_executable(), None);
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
    fn vscode_versioned_installation_checks_product_identity_and_supported_version() {
        let f = Fixture::new();
        let base = f.0.join("custom-code");
        let app = base.join("7e7950df89/resources/app");
        fs::create_dir_all(&app).unwrap();
        fs::write(app.join("package.json"), r#"{"version":"1.126.0"}"#).unwrap();
        fs::write(
            app.join("product.json"),
            r#"{"applicationName":"code","nameShort":"Code"}"#,
        )
        .unwrap();
        let mut discovery = Discovery::in_home(&f.0);
        discovery.apps.push(base);
        assert!(discovery.management_supported("vscode"));
        fs::write(
            app.join("product.json"),
            r#"{"applicationName":"cursor","nameShort":"Cursor"}"#,
        )
        .unwrap();
        assert!(!discovery.management_supported("vscode"));
        fs::write(
            app.join("product.json"),
            r#"{"applicationName":"code","nameShort":"Code"}"#,
        )
        .unwrap();
        fs::write(app.join("package.json"), r#"{"version":"1.100.0"}"#).unwrap();
        assert!(!discovery.management_supported("vscode"));
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
    #[cfg(target_os = "macos")]
    fn desktop_consumer_identity_distinguishes_legacy_chatgpt_and_renamed_codex() {
        let f = Fixture::new();
        f.file("Applications/ChatGPT.app/Contents/MacOS/ChatGPT", true);
        f.file("Applications/ChatGPT.app/Contents/Info.plist", false);
        let info = f.0.join("Applications/ChatGPT.app/Contents/Info.plist");
        fs::write(&info, "<plist><dict><key>CFBundleIdentifier</key><string>com.openai.chat</string></dict></plist>").unwrap();
        let discovery = Discovery::in_home(&f.0);
        assert!(!discovery.installed("codex"));
        assert!(!discovery.installed("codex-cli"));
        fs::write(&info, "<plist><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string><key>CFBundleExecutable</key><string>ChatGPT</string></dict></plist>").unwrap();
        assert!(
            discovery.installed("codex"),
            "the currently renamed official Codex consumer remains manageable"
        );
        assert!(discovery.installed("codex-cli"));
        fs::write(&info, "<plist><dict><key>CFBundleIdentifier</key><string>com.openai.chat</string></dict></plist>").unwrap();
        f.file(
            if cfg!(windows) {
                "Applications/Codex/Codex.exe"
            } else {
                "Applications/Codex.app/Contents/MacOS/Codex"
            },
            true,
        );
        assert!(discovery.installed("codex"));
        assert!(discovery.installed("codex-cli"));
    }

    #[test]
    fn non_macos_named_chatgpt_executable_does_not_require_a_mac_plist() {
        let f = Fixture::new();
        f.file("Applications/ChatGPT/ChatGPT.exe", true);
        assert!(Discovery::in_home(&f.0).installed("codex"));
    }

    #[test]
    fn registered_packages_require_a_matching_identity_and_executable() {
        let f = Fixture::new();
        let mut discovery = Discovery::in_home(&f.0);
        discovery
            .packages
            .push(("OpenAI.Codex".into(), f.0.join("msix/codex")));
        discovery
            .packages
            .push(("Claude".into(), f.0.join("msix/claude")));
        assert!(!discovery.installed("codex"));
        f.file("msix/codex/app/Codex.exe", true);
        f.file("msix/claude/app/Claude.exe", true);
        assert!(discovery.installed("codex-cli"));
        assert!(discovery.installed("claude-code"));
        discovery.packages[0].0 = "Unrelated.ChatGPT".into();
        assert!(!discovery.installed("codex"));
        discovery.packages.clear();
        assert!(
            !discovery.installed("claude"),
            "orphaned files without package registration must not count"
        );
    }

    #[test]
    fn account_helper_uses_registered_desktop_resources_and_never_the_gui() {
        let f = Fixture::new();
        let mut discovery = Discovery::in_home(&f.0);
        discovery
            .packages
            .push(("OpenAI.Codex".into(), f.0.join("msix/codex")));
        f.file("msix/codex/app/Codex.exe", true);
        assert!(discovery.installed("codex"));
        assert_eq!(discovery.codex_executable(), None);
        f.file("msix/codex/app/resources/codex.exe", true);
        assert_eq!(
            discovery.codex_executable(),
            Some(f.0.join("msix/codex/app/resources/codex.exe"))
        );
        discovery.packages[0].0 = "Unrelated.Codex".into();
        assert_eq!(discovery.codex_executable(), None);
    }

    #[test]
    #[cfg(windows)]
    fn finds_windows_user_installs_and_bundled_cli_without_path() {
        let f = Fixture::new();
        f.file("AppData/Local/AnthropicClaude/app-1.2.3/claude.exe", true);
        f.file(
            "AppData/Local/OpenAI/Codex/bin/fixture-version/codex.exe",
            true,
        );
        let discovery = Discovery::in_home(&f.0);
        assert!(discovery.installed("claude"));
        assert!(discovery.installed("codex"));
        assert_eq!(
            discovery.codex_executable(),
            Some(f.0.join("AppData/Local/OpenAI/Codex/bin/fixture-version/codex.exe"))
        );
    }

    #[test]
    #[cfg(windows)]
    fn opt_in_current_user_package_discovery_without_path_or_config() {
        let Ok(expected) = env::var("XWX_NATIVE_TEST_SYSTEM_CLIENT") else {
            return;
        };
        let discovery = Discovery {
            bins: vec![],
            apps: vec![],
            extensions: vec![],
            packages: windows_packages().expect("read current-user package registration"),
            manual_locations: BTreeMap::new(),
        };
        assert!(
            discovery.installed(&expected),
            "registered package executable must be detected without PATH or client settings"
        );
        if expected == "codex" {
            assert!(
                discovery.codex_executable().is_some(),
                "registered desktop must provide its native account helper without PATH"
            );
        }
    }

    #[test]
    fn invalid_consumer_plist_does_not_imply_managed_configuration() {
        let f = Fixture::new();
        f.file("Applications/ChatGPT.app/Contents/Info.plist", false);
        let info = f.0.join("Applications/ChatGPT.app/Contents/Info.plist");
        for content in ["broken plist", "<plist><dict><key>Other</key><string>com.openai.codex</string></dict></plist>", "<plist><dict><key>CFBundleIdentifier</key><string>com.openai.chat</string></dict></plist>"] {
            fs::write(&info, content).unwrap();
            assert!(!codex_bundle_identity(&info));
        }
    }

    #[test]
    fn finds_current_mimo_command_and_preserves_its_legacy_alias() {
        for command in ["mimo", "mimocode"] {
            let f = Fixture::new();
            f.file(
                &format!(
                    ".local/bin/{command}{}",
                    if cfg!(windows) { ".cmd" } else { "" }
                ),
                true,
            );
            assert!(Discovery::in_home(&f.0).installed("mimo-code"));
        }
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn binary_and_oversized_plists_follow_the_same_identity_contract() {
        let f = Fixture::new();
        f.file("Applications/ChatGPT.app/Contents/Info.plist", false);
        let path = f.0.join("Applications/ChatGPT.app/Contents/Info.plist");
        fs::write(&path, "<plist><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string></dict></plist>").unwrap();
        assert!(std::process::Command::new("/usr/bin/plutil")
            .args(["-convert", "binary1"])
            .arg(&path)
            .status()
            .unwrap()
            .success());
        assert!(codex_bundle_identity(&path));
        fs::write(&path, vec![b' '; 256 * 1024 + 1]).unwrap();
        assert!(!codex_bundle_identity(&path));
    }
    #[test]
    fn finds_qwen_desktop_without_a_separate_cli() {
        let f = Fixture::new();
        f.file(
            if cfg!(windows) {
                "Applications/Qwen Code Desktop/Qwen Code Desktop.exe"
            } else {
                "Applications/Qwen Code Desktop.app/Contents/MacOS/Qwen Code Desktop"
            },
            true,
        );
        let discovery = Discovery::in_home(&f.0);
        assert!(discovery.installed("qwen-code"));
        assert!(!discovery.installed("gemini-cli"));
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
